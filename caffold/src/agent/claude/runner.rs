//! Reaching the process that holds `claude` sessions.
//!
//! Codex ships a daemon, so Caffold connects to one. Claude does not, so
//! Caffold runs one: `caffold-claude-runner`, a workspace member that holds the
//! child processes and relays their frames without reading them. A session
//! outlives the backend that started it, which is what lets a turn survive a
//! restart, and it is reached over a unix socket beside the database.
//!
//! Everything above this module speaks in frames. What differs between a real
//! runner and the stand-in a test uses is the pipe the frames travel through,
//! so that difference stops here: [`RunnerClient`] is the seam, and the driver,
//! the translation, the control protocol and the session bookkeeping are the
//! same code either way.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use caffold_claude_runner::client::{Client, FrameWriter, Streaming};
use caffold_claude_runner::protocol::{Request, SessionInfo, SpawnRequest, WireEvent};
use caffold_claude_runner::{SOCKET_NAME, protocol};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::unix::OwnedReadHalf;

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use tokio::sync::{Mutex as AsyncMutex, mpsc};

use super::ClaudeError;

/// How long to wait for a runner Caffold just started to open its socket.
const START_TIMEOUT: Duration = Duration::from_secs(10);
const START_POLL: Duration = Duration::from_millis(50);

/// The runner, and the socket it answers on.
#[derive(Clone)]
pub(crate) struct RunnerClient {
    socket: Option<Arc<PathBuf>>,
    #[cfg(test)]
    mock: Option<Arc<MockRunner>>,
}

/// One session, attached: what the agent says, and what may be said to it.
pub(crate) struct RunnerSession {
    pub(crate) info: SessionInfo,
    pub(crate) frames: SessionFrames,
    pub(crate) events: SessionEvents,
}

/// The writing half of an attached session.
pub(crate) enum SessionFrames {
    Socket(Box<FrameWriter>),
    #[cfg(test)]
    Mock {
        session: String,
        runner: Arc<MockRunner>,
    },
}

/// The reading half of an attached session.
pub(crate) enum SessionEvents {
    Socket(Box<BufReader<OwnedReadHalf>>),
    #[cfg(test)]
    Mock(mpsc::UnboundedReceiver<RunnerEvent>),
}

/// Something that happened to a session, as the runner reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunnerEvent {
    /// One line the agent wrote, verbatim.
    Frame(String),
    /// One line the agent wrote to stderr. Diagnostic only.
    Stderr(String),
    /// The agent exited, and this session will say nothing more.
    Exit(Option<i32>),
}

impl RunnerClient {
    /// The runner that belongs to this data directory.
    ///
    /// The socket lives with the data rather than at a fixed per-user path, so
    /// an installed application and a development server each drive their own
    /// runner instead of fighting over one.
    pub(crate) fn in_data_dir(data_dir: &Path) -> Self {
        Self {
            socket: Some(Arc::new(data_dir.join(SOCKET_NAME))),
            #[cfg(test)]
            mock: None,
        }
    }

    /// A stand-in runner, and the handle a test speaks through it with.
    #[cfg(test)]
    pub(crate) fn mock() -> (Self, MockRunnerHandle) {
        let runner = Arc::new(MockRunner::default());
        (
            Self {
                socket: None,
                mock: Some(runner.clone()),
            },
            MockRunnerHandle(runner),
        )
    }

    fn socket(&self) -> &Path {
        self.socket
            .as_deref()
            .expect("a socket-backed runner is required")
    }

    /// Start a runner if one is not already listening.
    ///
    /// Idempotent, because every operation begins with it: the runner outlives
    /// the backend, so the usual answer is that one is already there.
    pub(crate) async fn ensure_running(&self) -> Result<(), ClaudeError> {
        #[cfg(test)]
        if self.mock.is_some() {
            return Ok(());
        }
        let socket = self.socket().to_path_buf();
        if Client::connect(&socket).await.is_ok() {
            return Ok(());
        }
        if let Some(parent) = socket.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                ClaudeError::Runner(format!(
                    "could not create the runner's directory {}: {error}",
                    parent.display()
                ))
            })?;
        }
        self.spawn_runner(&socket).await?;

        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if Client::connect(&socket).await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(START_POLL).await;
        }
        Err(ClaudeError::Runner(format!(
            "the Claude runner did not start listening on {}",
            socket.display()
        )))
    }

    /// Start the runner as a process of its own.
    ///
    /// It is given its own process group deliberately. The runner is meant to
    /// outlive the backend — that is what keeps a turn running across a restart
    /// — so a signal sent to Caffold's group must not take it along.
    async fn spawn_runner(&self, socket: &Path) -> Result<(), ClaudeError> {
        let executable = runner_executable()?;
        let data_dir = socket
            .parent()
            .ok_or_else(|| ClaudeError::Runner("the runner socket has no directory".to_string()))?;
        let mut command = std::process::Command::new(&executable);
        command
            .arg("daemon")
            .arg("run")
            .arg("--data-dir")
            .arg(data_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        command.spawn().map_err(|error| {
            ClaudeError::Runner(format!(
                "could not start the Claude runner at {}: {error}",
                executable.display()
            ))
        })?;
        Ok(())
    }

    /// Attach to a session, creating it from `spawn` when it does not exist.
    ///
    /// Creating and attaching are one request on purpose. An agent starts
    /// talking the moment it starts, and a gap between the two would lose
    /// whatever it said first — the runner keeps no history to replay.
    pub(crate) async fn open(
        &self,
        session: &str,
        spawn: SpawnRequest,
    ) -> Result<RunnerSession, ClaudeError> {
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            return MockRunner::open(mock, session, spawn).await;
        }
        self.ensure_running().await?;
        let client = self.connect().await?;
        let (info, streaming) = client
            .create_attached(session, spawn)
            .await
            .map_err(|error| ClaudeError::Runner(error.to_string()))?;
        let Streaming { reader, frames } = streaming;
        Ok(RunnerSession {
            info,
            frames: SessionFrames::Socket(Box::new(frames)),
            events: SessionEvents::Socket(Box::new(reader)),
        })
    }

    /// End a session and the process behind it.
    ///
    /// A runner that is not listening is not started to be told this: it holds
    /// no sessions, so a session it does not have is a session not running,
    /// which is what was asked for. Starting one in order to close nothing
    /// would be the only way to fail — and archiving a Task nobody has opened
    /// since the backend started is exactly when there is nothing to close.
    pub(crate) async fn close(&self, session: &str) -> Result<(), ClaudeError> {
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            mock.close(session).await;
            return Ok(());
        }
        let Ok(mut client) = self.connect().await else {
            return Ok(());
        };
        client
            .request(Request::SessionClose {
                session: session.to_string(),
            })
            .await
            .map_err(|error| ClaudeError::Runner(error.to_string()))?;
        Ok(())
    }

    async fn connect(&self) -> Result<Client, ClaudeError> {
        Client::connect(self.socket())
            .await
            .map_err(|error| ClaudeError::Runner(error.to_string()))
    }
}

impl SessionFrames {
    /// Write one frame to the agent's stdin.
    pub(crate) async fn send(&mut self, frame: Value) -> Result<(), ClaudeError> {
        let encoded = serde_json::to_string(&frame)
            .map_err(|error| ClaudeError::Protocol(error.to_string()))?;
        match self {
            Self::Socket(writer) => {
                let raw = RawValue::from_string(encoded)
                    .map_err(|error| ClaudeError::Protocol(error.to_string()))?;
                writer
                    .send(raw)
                    .await
                    .map_err(|error| ClaudeError::Runner(error.to_string()))
            }
            #[cfg(test)]
            Self::Mock { session, runner } => {
                runner.heard(session, frame).await;
                Ok(())
            }
        }
    }
}

impl SessionEvents {
    /// The next thing the session did, or `None` once it can do nothing more.
    pub(crate) async fn next(&mut self) -> Option<RunnerEvent> {
        match self {
            Self::Socket(reader) => loop {
                let mut line = String::new();
                if reader.read_line(&mut line).await.ok()? == 0 {
                    return None;
                }
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                // Replies to what Caffold wrote share this channel with the
                // session's own output. Only the output is an event.
                match protocol::carries_event(trimmed) {
                    Ok(true) => {}
                    Ok(false) => continue,
                    Err(_) => continue,
                }
                let Ok(event) = serde_json::from_str::<WireEvent>(trimmed) else {
                    continue;
                };
                return Some(match event.t {
                    protocol::EventKind::Frame => {
                        RunnerEvent::Frame(event.frame?.get().to_string())
                    }
                    protocol::EventKind::Stderr => {
                        RunnerEvent::Stderr(event.line.unwrap_or_default())
                    }
                    protocol::EventKind::Exit => RunnerEvent::Exit(event.code),
                });
            },
            #[cfg(test)]
            Self::Mock(receiver) => receiver.recv().await,
        }
    }
}

/// Where the runner executable is.
///
/// Beside the backend's own binary, because that is where the installer puts
/// it and where `cargo build` leaves it. `CAFFOLD_CLAUDE_RUNNER` overrides,
/// which is what a developer running the two from different places needs.
fn runner_executable() -> Result<PathBuf, ClaudeError> {
    if let Some(explicit) = std::env::var_os("CAFFOLD_CLAUDE_RUNNER") {
        return Ok(PathBuf::from(explicit));
    }
    let current = std::env::current_exe().map_err(|error| {
        ClaudeError::Runner(format!("could not locate the Caffold executable: {error}"))
    })?;
    let beside = current
        .parent()
        .map(|directory| directory.join("caffold-claude-runner"))
        .ok_or_else(|| {
            ClaudeError::Runner("the Caffold executable has no directory".to_string())
        })?;
    if beside.exists() {
        return Ok(beside);
    }
    Err(ClaudeError::Runner(format!(
        "no Claude runner beside {}. Build it with `cargo build -p caffold-claude-runner`, \
         or set CAFFOLD_CLAUDE_RUNNER.",
        current.display()
    )))
}

// ---------------------------------------------------------------------------
// The stand-in
// ---------------------------------------------------------------------------

/// A runner that starts nothing.
///
/// It is the runner and the agent at once, because from Caffold's side those
/// are one thing reached through one pipe. A test writes what the agent says
/// and reads what the driver wrote back, and everything between the two is the
/// same code the real runner drives.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct MockRunner {
    state: AsyncMutex<MockRunnerState>,
}

#[cfg(test)]
#[derive(Default)]
struct MockRunnerState {
    sessions: HashMap<String, MockSession>,
    /// What the next session created will say the moment it is attached.
    greeting: Vec<Value>,
}

#[cfg(test)]
struct MockSession {
    spawn: SpawnRequest,
    agent: mpsc::UnboundedSender<RunnerEvent>,
    heard: Vec<Value>,
    /// How many prompts have been handed back, which is what names the next
    /// one. The real agent uses identifiers of its own; what matters to a
    /// caller is that each is different and that the same one reaches the
    /// transcript.
    replays: usize,
    /// Keep prompts rather than handing them back, standing in for an agent
    /// that took a prompt and never said what it filed it as.
    swallow_prompts: bool,
}

/// What a test speaks to a stand-in runner through.
#[cfg(test)]
pub(crate) struct MockRunnerHandle(Arc<MockRunner>);

#[cfg(test)]
impl MockRunner {
    async fn open(
        runner: &Arc<Self>,
        session: &str,
        spawn: SpawnRequest,
    ) -> Result<RunnerSession, ClaudeError> {
        let mut state = runner.state.lock().await;
        let (sender, receiver) = mpsc::unbounded_channel();
        for frame in state.greeting.drain(..).collect::<Vec<_>>() {
            let _ = sender.send(RunnerEvent::Frame(frame.to_string()));
        }
        state.sessions.insert(
            session.to_string(),
            MockSession {
                spawn,
                agent: sender,
                heard: Vec::new(),
                replays: 0,
                swallow_prompts: false,
            },
        );
        Ok(RunnerSession {
            info: SessionInfo {
                session: session.to_string(),
                state: protocol::SessionState::Running,
                pid: Some(4242),
                attached: true,
                exit_code: None,
            },
            frames: SessionFrames::Mock {
                session: session.to_string(),
                runner: runner.clone(),
            },
            events: SessionEvents::Mock(receiver),
        })
    }

    async fn heard(&self, session: &str, frame: Value) {
        let mut state = self.state.lock().await;
        let Some(existing) = state.sessions.get_mut(session) else {
            return;
        };
        // The agent answers what it is asked. A stand-in that stayed silent
        // would not stand in for it: every caller waiting on a control request
        // would wait out its whole timeout.
        if frame["type"] == "control_request"
            && let Some(request_id) = frame["request_id"].as_str()
        {
            let _ = existing.agent.send(RunnerEvent::Frame(
                serde_json::json!({
                    "type": "control_response",
                    "response": { "subtype": "success", "request_id": request_id, "response": {} },
                })
                .to_string(),
            ));
        }
        // Every session runs with `--replay-user-messages`, so a prompt
        // written to the agent comes back under the identity the agent filed it
        // as, and that identity is what names the turn. A stand-in that kept
        // the prompt to itself would leave every turn waiting to be named.
        if frame["type"] == "user" && !existing.swallow_prompts {
            existing.replays += 1;
            let mut replay = frame.clone();
            replay["uuid"] = serde_json::json!(format!("{session}-prompt-{}", existing.replays));
            replay["isReplay"] = serde_json::json!(true);
            let _ = existing.agent.send(RunnerEvent::Frame(replay.to_string()));
        }
        existing.heard.push(frame);
    }

    async fn close(&self, session: &str) {
        let mut state = self.state.lock().await;
        state.sessions.remove(session);
    }
}

#[cfg(test)]
impl MockRunnerHandle {
    /// What the next session created will say as soon as it is attached.
    ///
    /// A driver that opens a conversation waits for the agent to introduce
    /// itself before it answers, so the greeting has to be there before the
    /// session is.
    pub(crate) async fn greet_next_session_with(&self, frames: Vec<Value>) {
        self.0.state.lock().await.greeting = frames;
    }

    /// Say one more thing as the agent, now.
    pub(crate) async fn say(&self, session: &str, frame: Value) {
        let state = self.0.state.lock().await;
        if let Some(held) = state.sessions.get(session) {
            let _ = held.agent.send(RunnerEvent::Frame(frame.to_string()));
        }
    }

    /// Take prompts without handing any of them back.
    pub(crate) async fn swallow_prompts(&self, session: &str) {
        let mut state = self.0.state.lock().await;
        if let Some(held) = state.sessions.get_mut(session) {
            held.swallow_prompts = true;
        }
    }

    /// End the session as the agent exiting.
    pub(crate) async fn exit(&self, session: &str, code: Option<i32>) {
        let state = self.0.state.lock().await;
        if let Some(held) = state.sessions.get(session) {
            let _ = held.agent.send(RunnerEvent::Exit(code));
        }
    }

    /// Everything the driver wrote to that session.
    pub(crate) async fn heard(&self, session: &str) -> Vec<Value> {
        let state = self.0.state.lock().await;
        state
            .sessions
            .get(session)
            .map(|held| held.heard.clone())
            .unwrap_or_default()
    }

    /// How the session was started.
    pub(crate) async fn spawned(&self, session: &str) -> Option<SpawnRequest> {
        let state = self.0.state.lock().await;
        state.sessions.get(session).map(|held| held.spawn.clone())
    }
}
