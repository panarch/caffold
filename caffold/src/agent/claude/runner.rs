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

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use caffold_claude_runner::client::{Client, encode};
use caffold_claude_runner::protocol::{
    EventKind, Outcome, ReplyBody, Request, Response, SessionInfo, SpawnRequest, WireEvent,
    WireResponse,
};
use caffold_claude_runner::{SOCKET_NAME, protocol};
use serde_json::Value;
use serde_json::value::RawValue;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

use super::ClaudeError;

/// How long to wait for the runner to answer one request on the shared
/// connection. Requests are small and local; what this bounds is a runner that
/// died mid-request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// How long to wait for a runner Caffold just started to open its socket.
const START_TIMEOUT: Duration = Duration::from_secs(10);
const START_POLL: Duration = Duration::from_millis(50);

/// How long a stopping runner may take to go quiet.
///
/// A stop ends every held session gracefully — up to the runner's own
/// per-child escalation timeout, paid once since children are ended together
/// — before the socket is removed, and a loaded machine stretches all of it.
const STOP_TIMEOUT: Duration = Duration::from_secs(20);

/// The longest path a unix socket can be opened at, imposed by the OS: the
/// address lives in `sockaddr_un`'s fixed array with its terminator — 104
/// bytes on macOS and 108 on Linux, the two targets Caffold builds for. A
/// target whose array is smaller would merely fall back to the timed-out
/// start, since the daemon's own bind enforces the real limit either way.
#[cfg(target_os = "macos")]
const MAX_SOCKET_PATH_BYTES: usize = 103;
#[cfg(not(target_os = "macos"))]
const MAX_SOCKET_PATH_BYTES: usize = 107;

/// The runner, and the socket it answers on.
#[derive(Clone)]
pub(crate) struct RunnerClient {
    socket: Option<Arc<PathBuf>>,
    /// The one subscribed connection every session shares, once one is up.
    wire: Arc<AsyncMutex<Option<Arc<Wire>>>>,
    #[cfg(test)]
    mock: Option<Arc<MockRunner>>,
}

/// The backend's one connection to the runner.
///
/// The backend is one client, so it holds one subscription: every session's
/// frames go out on this connection, and every session's events come back on
/// it, each named by its session. One reader routes what arrives — replies to
/// whoever asked, events to the session they name — so nothing is dropped for
/// having arrived while something else was being awaited.
pub(crate) struct Wire {
    writer: AsyncMutex<OwnedWriteHalf>,
    next_id: AtomicU64,
    alive: AtomicBool,
    pending: std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<ReplyBody, String>>>>,
    sessions: std::sync::Mutex<HashMap<String, mpsc::UnboundedSender<RunnerEvent>>>,
}

impl Wire {
    /// Send one request and wait for its reply.
    async fn request(self: &Arc<Self>, request: Request) -> Result<ReplyBody, ClaudeError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let encoded =
            encode(request, id).map_err(|error| ClaudeError::Runner(error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending lock")
            .insert(id, sender);
        {
            let mut writer = self.writer.lock().await;
            if let Err(error) = writer.write_all(&encoded).await {
                self.pending.lock().expect("pending lock").remove(&id);
                return Err(ClaudeError::Runner(error.to_string()));
            }
            if let Err(error) = writer.flush().await {
                self.pending.lock().expect("pending lock").remove(&id);
                return Err(ClaudeError::Runner(error.to_string()));
            }
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(Ok(body))) => Ok(body),
            Ok(Ok(Err(message))) => Err(ClaudeError::Runner(message)),
            Ok(Err(_)) => Err(ClaudeError::Runner(
                "the runner connection ended before answering".to_string(),
            )),
            Err(_) => {
                self.pending.lock().expect("pending lock").remove(&id);
                Err(ClaudeError::Runner(format!(
                    "the runner did not answer within {} seconds",
                    REQUEST_TIMEOUT.as_secs()
                )))
            }
        }
    }

    /// Write one frame to a session and wait until the runner accepts it.
    ///
    /// A successful write only says the request reached the socket. The runner
    /// may still refuse it — for example, because this connection is no longer
    /// attached or the child already exited — and only its reply distinguishes
    /// those cases from a frame the agent can actually receive.
    async fn send_frame(
        self: &Arc<Self>,
        session: &str,
        frame: Box<RawValue>,
    ) -> Result<(), ClaudeError> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err(ClaudeError::Runner(
                "the runner connection is gone".to_string(),
            ));
        }
        match self
            .request(Request::SessionSend {
                session: session.to_string(),
                frame,
            })
            .await?
        {
            ReplyBody::Empty {} => Ok(()),
            _ => Err(ClaudeError::Runner(
                "the runner answered a session send with something else".to_string(),
            )),
        }
    }

    /// Read the connection for as long as it lives, routing what arrives.
    async fn route(self: Arc<Self>, reader: tokio::net::unix::OwnedReadHalf) {
        let mut reader = BufReader::new(reader);
        let mut line = String::new();
        loop {
            line.clear();
            let read = match reader.read_line(&mut line).await {
                Ok(read) => read,
                Err(_) => break,
            };
            if read == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match protocol::carries_event(trimmed) {
                Ok(true) => self.route_event(trimmed),
                Ok(false) => self.route_reply(trimmed),
                Err(_) => continue,
            }
        }
        // The connection is over. Sessions hear it as their stream ending, and
        // callers still waiting hear it as the answer never coming.
        self.alive.store(false, Ordering::Relaxed);
        self.sessions.lock().expect("sessions lock").clear();
        self.pending.lock().expect("pending lock").clear();
    }

    fn route_event(&self, line: &str) {
        let Ok(event) = serde_json::from_str::<WireEvent>(line) else {
            return;
        };
        let runner_event = match event.t {
            EventKind::Frame => match event.frame {
                Some(frame) => RunnerEvent::Frame(frame.get().to_string()),
                None => return,
            },
            EventKind::Stderr => match event.line {
                Some(line) => RunnerEvent::Stderr(line),
                None => return,
            },
            EventKind::Exit => RunnerEvent::Exit(event.code),
        };
        let ended = matches!(runner_event, RunnerEvent::Exit(_));
        let mut sessions = self.sessions.lock().expect("sessions lock");
        if let Some(sender) = sessions.get(&event.s) {
            let delivered = sender.send(runner_event).is_ok();
            if ended || !delivered {
                sessions.remove(&event.s);
            }
        }
    }

    fn route_reply(&self, line: &str) {
        let Ok(wire) = serde_json::from_str::<WireResponse>(line) else {
            return;
        };
        let Response { id, outcome } = Response::from_wire(wire);
        // A reply nobody registered for belongs to a fire-and-forget send.
        let Some(waiting) = self.pending.lock().expect("pending lock").remove(&id) else {
            return;
        };
        let _ = waiting.send(match outcome {
            Outcome::Ok(body) => Ok(body),
            Outcome::Err(error) => Err(format!("{:?}: {}", error.code, error.message)),
        });
    }
}

/// One session, attached: what the agent says, and what may be said to it.
pub(crate) struct RunnerSession {
    pub(crate) info: SessionInfo,
    pub(crate) frames: SessionFrames,
    pub(crate) events: SessionEvents,
}

/// The writing half of an attached session.
pub(crate) enum SessionFrames {
    /// The shared connection, and which session this writer speaks for on it.
    Shared { wire: Arc<Wire>, session: String },
    #[cfg(test)]
    Mock {
        session: String,
        runner: Arc<MockRunner>,
    },
}

/// The reading half of an attached session: its slice of the shared
/// connection, routed to it by the session each event names.
pub(crate) struct SessionEvents(mpsc::UnboundedReceiver<RunnerEvent>);

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
            wire: Arc::new(AsyncMutex::new(None)),
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
                wire: Arc::new(AsyncMutex::new(None)),
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
        if let Some(complaint) = self.socket_problem() {
            // Said before anything is started: a daemon asked anyway would
            // die without listening, and the wait for it would time out
            // without ever naming the problem.
            return Err(ClaudeError::Runner(complaint));
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
        let wire = self.shared_wire().await?;
        // Registered before the session is asked for, because an agent speaks
        // the moment it starts and its first events must find their channel.
        let (sender, receiver) = mpsc::unbounded_channel();
        wire.sessions
            .lock()
            .expect("sessions lock")
            .insert(session.to_string(), sender);
        let reply = wire
            .request(Request::SessionCreate {
                session: session.to_string(),
                spawn,
                attach: true,
            })
            .await;
        let info = match reply {
            Ok(ReplyBody::Session(info)) => info,
            Ok(_) => {
                wire.sessions.lock().expect("sessions lock").remove(session);
                return Err(ClaudeError::Runner(
                    "the runner answered an attach with something else".to_string(),
                ));
            }
            Err(error) => {
                wire.sessions.lock().expect("sessions lock").remove(session);
                return Err(error);
            }
        };
        Ok(RunnerSession {
            info,
            frames: SessionFrames::Shared {
                wire,
                session: session.to_string(),
            },
            events: SessionEvents(receiver),
        })
    }

    /// The shared connection, connecting and subscribing if there is none.
    async fn shared_wire(&self) -> Result<Arc<Wire>, ClaudeError> {
        let mut slot = self.wire.lock().await;
        if let Some(wire) = slot.as_ref()
            && wire.alive.load(Ordering::Relaxed)
        {
            return Ok(Arc::clone(wire));
        }
        self.ensure_running().await?;
        let stream = UnixStream::connect(self.socket())
            .await
            .map_err(|error| ClaudeError::Runner(error.to_string()))?;
        let (reader, writer) = stream.into_split();
        let wire = Arc::new(Wire {
            writer: AsyncMutex::new(writer),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            pending: std::sync::Mutex::new(HashMap::new()),
            sessions: std::sync::Mutex::new(HashMap::new()),
        });
        tokio::spawn(Arc::clone(&wire).route(reader));
        *slot = Some(Arc::clone(&wire));
        Ok(wire)
    }

    /// What the runner is right now, from the one that is listening.
    ///
    /// A runner that is not listening is not started to answer: not running
    /// is itself the answer, and starting one would change the very thing
    /// being asked about.
    pub(crate) async fn status(&self) -> Option<protocol::DaemonStatus> {
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            return Some(mock.status().await);
        }
        let Ok(mut client) = self.connect().await else {
            return None;
        };
        match client.request(Request::DaemonStatus).await {
            Ok(ReplyBody::Daemon(status)) => Some(status),
            _ => None,
        }
    }

    /// Whether this client stands on a mock rather than a socket.
    #[cfg(test)]
    pub(super) fn is_mock(&self) -> bool {
        self.mock.is_some()
    }

    /// Why no runner can ever listen where this client looks, or nothing
    /// when the address is usable.
    ///
    /// The socket lives in the data directory, and the data directory goes
    /// where the person put their checkout — which is how a deeply nested one
    /// walks into the OS limit. A daemon asked to bind past it dies without
    /// listening, and without this check what a person would see is a start
    /// that timed out, which says nothing about the actual problem: where
    /// the directory sits.
    pub(super) fn socket_problem(&self) -> Option<String> {
        #[cfg(test)]
        if self.mock.is_some() {
            return None;
        }
        let socket = self.socket();
        let bytes = socket.as_os_str().as_encoded_bytes().len();
        (bytes > MAX_SOCKET_PATH_BYTES).then(|| {
            format!(
                "no runner can listen at {}: the path is {bytes} bytes and the OS \
                 caps a unix socket address at {MAX_SOCKET_PATH_BYTES}; move the \
                 checkout or the data directory somewhere shorter",
                socket.display()
            )
        })
    }

    /// The conversations the runner is still holding a process for.
    ///
    /// A runner that is not listening is not started to answer this. It would
    /// answer nothing either way, and starting one to hear that would spend a
    /// process on the case where there is least to say.
    pub(crate) async fn live_sessions(&self) -> Vec<String> {
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            return mock.state.lock().await.sessions.keys().cloned().collect();
        }
        let Ok(mut client) = self.connect().await else {
            return Vec::new();
        };
        match client.request(Request::SessionList).await {
            Ok(ReplyBody::Sessions { sessions }) => sessions
                .into_iter()
                .filter(|session| matches!(session.state, protocol::SessionState::Running))
                .map(|session| session.session)
                .collect(),
            _ => Vec::new(),
        }
    }

    /// Stop the runner and start a fresh one, reporting the replacement.
    ///
    /// Deliberate, and only deliberate: every session the old runner held ends
    /// with it, the way an application update ends them, and each conversation
    /// resumes from its file the next time its Task is opened. The stop is the
    /// graceful one — children closed, the book emptied — and the runner that
    /// answers afterwards is running whatever binary is installed now, which
    /// is the other thing restarting is for.
    pub(crate) async fn restart(&self) -> Result<protocol::DaemonStatus, ClaudeError> {
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            return Ok(mock.restart().await);
        }
        if let Ok(mut client) = self.connect().await {
            // A runner answers before it acts on the stop, so a request that
            // goes unanswered means it had already gone — which is what was
            // being asked for.
            let _ = client.request(Request::DaemonStop).await;
        }
        let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
        while Client::connect(self.socket()).await.is_ok() {
            if tokio::time::Instant::now() >= deadline {
                return Err(ClaudeError::Runner(
                    "the runner went on answering after it was asked to stop".to_string(),
                ));
            }
            tokio::time::sleep(START_POLL).await;
        }
        self.ensure_running().await?;
        let mut client = self.connect().await?;
        match client
            .request(Request::DaemonStatus)
            .await
            .map_err(|error| ClaudeError::Runner(error.to_string()))?
        {
            ReplyBody::Daemon(status) => Ok(status),
            _ => Err(ClaudeError::Runner(
                "the runner answered a status request with something else".to_string(),
            )),
        }
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
            Self::Shared { wire, session } => {
                let raw = RawValue::from_string(encoded)
                    .map_err(|error| ClaudeError::Protocol(error.to_string()))?;
                wire.send_frame(session, raw).await
            }
            #[cfg(test)]
            Self::Mock { session, runner } => runner.heard(session, frame).await,
        }
    }
}

impl SessionEvents {
    /// A stand-in stream a test feeds by hand.
    #[cfg(test)]
    pub(crate) fn from_channel(receiver: mpsc::UnboundedReceiver<RunnerEvent>) -> Self {
        Self(receiver)
    }

    /// The next thing the session did, or `None` once it can do nothing more.
    pub(crate) async fn next(&mut self) -> Option<RunnerEvent> {
        self.0.recv().await
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
    /// What the next session created will answer when it is greeted: the state
    /// it was already in, and the questions it is already held up by.
    hello: Value,
}

/// A session that has just started and is holding nothing up.
#[cfg(test)]
fn default_hello() -> Value {
    serde_json::json!({ "response": { "session_state": "idle" } })
}

#[cfg(test)]
struct MockSession {
    spawn: SpawnRequest,
    /// What this session answers when it is greeted.
    hello: Value,
    agent: mpsc::UnboundedSender<RunnerEvent>,
    heard: Vec<Value>,
    /// Whether the agent behind it has exited. The daemon keeps an exited
    /// session listed, and asking for it again spawns a replacement.
    exited: bool,
    /// How many prompts have been handed back, which is what names the next
    /// one. The real agent uses identifiers of its own; what matters to a
    /// caller is that each is different and that the same one reaches the
    /// transcript.
    replays: usize,
    /// Keep prompts rather than handing them back, standing in for an agent
    /// that took a prompt and never said what it filed it as.
    swallow_prompts: bool,
    /// Refuse the next frame before it reaches the agent, the way the daemon
    /// refuses a `SessionSend` it cannot accept.
    reject_next_send: Option<String>,
    distrusts_moves: bool,
    refuses_moves: u32,
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
        let hello = std::mem::replace(&mut state.hello, default_hello());
        // The way the daemon answers it: only the open that brought the
        // session into being says it started something, and an exited one is
        // replaced, which is a beginning again.
        let spawned = match state.sessions.get(session) {
            Some(held) => held.exited,
            None => true,
        };
        state.sessions.insert(
            session.to_string(),
            MockSession {
                spawn,
                hello,
                agent: sender,
                heard: Vec::new(),
                exited: false,
                replays: 0,
                swallow_prompts: false,
                reject_next_send: None,
                distrusts_moves: false,
                refuses_moves: 0,
            },
        );
        Ok(RunnerSession {
            info: SessionInfo {
                session: session.to_string(),
                state: protocol::SessionState::Running,
                pid: Some(4242),
                attached: true,
                spawned,
                exit_code: None,
            },
            frames: SessionFrames::Mock {
                session: session.to_string(),
                runner: runner.clone(),
            },
            events: SessionEvents::from_channel(receiver),
        })
    }

    async fn heard(&self, session: &str, frame: Value) -> Result<(), ClaudeError> {
        let mut state = self.state.lock().await;
        let Some(existing) = state.sessions.get_mut(session) else {
            return Err(ClaudeError::Runner(format!(
                "UnknownSession: no session named {session}"
            )));
        };
        if let Some(message) = existing.reject_next_send.take() {
            return Err(ClaudeError::Runner(message));
        }
        // The agent answers what it is asked. A stand-in that stayed silent
        // would not stand in for it: every caller waiting on a control request
        // would wait out its whole timeout.
        if frame["type"] == "control_request"
            && let Some(request_id) = frame["request_id"].as_str()
        {
            let mut body = if frame["request"]["subtype"] == "initialize" {
                existing.hello.clone()
            } else if frame["request"]["subtype"] == "set_cwd" {
                // The real agent moves only between turns and demands trust
                // for a directory it has not seen; a stand-in that always
                // moved would leave both halves of the dance untested.
                if existing.refuses_moves > 0 {
                    existing.refuses_moves -= 1;
                    serde_json::json!({ "response": {
                        "status": "rejected",
                        "reason": "busy",
                        "message": "A turn is in progress.",
                    } })
                } else if existing.distrusts_moves && frame["request"]["trust_accepted"] != true {
                    serde_json::json!({ "response": {
                        "status": "needs_trust",
                        "directory": frame["request"]["path"],
                    } })
                } else {
                    serde_json::json!({ "response": {
                        "status": "ok",
                        "cwd": frame["request"]["path"],
                        "changed": true,
                        "transcript_relocated": true,
                    } })
                }
            } else {
                serde_json::json!({ "response": {} })
            };
            body["subtype"] = serde_json::json!("success");
            body["request_id"] = serde_json::json!(request_id);
            let _ = existing.agent.send(RunnerEvent::Frame(
                serde_json::json!({ "type": "control_response", "response": body }).to_string(),
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
        Ok(())
    }

    async fn close(&self, session: &str) {
        let mut state = self.state.lock().await;
        state.sessions.remove(session);
    }

    /// Restart as the real runner restarts: every session ends, and the
    /// replacement holds nothing.
    async fn restart(&self) -> protocol::DaemonStatus {
        let mut state = self.state.lock().await;
        for (_, session) in state.sessions.drain() {
            let _ = session.agent.send(RunnerEvent::Exit(Some(0)));
        }
        drop(state);
        self.status().await
    }

    /// Answer as the real runner answers, holding whatever the test opened.
    async fn status(&self) -> protocol::DaemonStatus {
        protocol::DaemonStatus {
            protocol_version: protocol::PROTOCOL_VERSION,
            runner_version: "stand-in".to_string(),
            pid: 4242,
            socket: "stand-in".to_string(),
            sessions: self.state.lock().await.sessions.len(),
            idle_timeout_secs: Some(600),
            unsubscribed_for_secs: None,
        }
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

    /// What the next session created will answer when it is greeted.
    ///
    /// A session the runner held across a restart of the client answers with
    /// the state it was already in and the questions it is already held up by,
    /// and that answer is the only way the client learns either.
    pub(crate) async fn greet_next_session_as(&self, hello: Value) {
        self.0.state.lock().await.hello = hello;
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

    /// Refuse the next frame before the agent hears it.
    pub(crate) async fn reject_next_send(&self, session: &str, message: &str) {
        let mut state = self.0.state.lock().await;
        if let Some(held) = state.sessions.get_mut(session) {
            held.reject_next_send = Some(message.to_string());
        }
    }

    /// Demand trust before the next move, the way the real agent does for a
    /// directory it has not seen.
    pub(crate) async fn demand_trust_for_moves(&self, session: &str) {
        let mut state = self.0.state.lock().await;
        if let Some(held) = state.sessions.get_mut(session) {
            held.distrusts_moves = true;
        }
    }

    /// Refuse the next `times` moves as mid-turn, the way the real agent does
    /// while a turn is running.
    pub(crate) async fn refuse_moves_while_busy(&self, session: &str, times: u32) {
        let mut state = self.0.state.lock().await;
        if let Some(held) = state.sessions.get_mut(session) {
            held.refuses_moves = times;
        }
    }

    /// Go away without a word, the way a runner killed outright does.
    ///
    /// Distinct from the agent exiting, which is something the runner is there
    /// to report. Here the reporting itself stops.
    pub(crate) async fn vanish(&self, session: &str) {
        self.0.state.lock().await.sessions.remove(session);
    }

    /// End the session as the agent exiting.
    pub(crate) async fn exit(&self, session: &str, code: Option<i32>) {
        let mut state = self.0.state.lock().await;
        if let Some(held) = state.sessions.get_mut(session) {
            held.exited = true;
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

    /// What the session was asked to do, without the housekeeping around it.
    ///
    /// Every session is greeted the moment it opens, so a test about prompts
    /// has to say that prompts are what it means.
    pub(crate) async fn prompts(&self, session: &str) -> Vec<Value> {
        self.heard(session)
            .await
            .into_iter()
            .filter(|frame| frame["type"] == "user")
            .collect()
    }

    /// How the session was started.
    pub(crate) async fn spawned(&self, session: &str) -> Option<SpawnRequest> {
        let state = self.0.state.lock().await;
        state.sessions.get(session).map(|held| held.spawn.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use caffold_claude_runner::protocol::{ErrorBody, ErrorCode, Event, WireRequest};

    fn connected_wire() -> (Arc<Wire>, UnixStream) {
        let (ours, theirs) = UnixStream::pair().expect("a local wire pair");
        let (reader, writer) = ours.into_split();
        let wire = Arc::new(Wire {
            writer: AsyncMutex::new(writer),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            pending: std::sync::Mutex::new(HashMap::new()),
            sessions: std::sync::Mutex::new(HashMap::new()),
        });
        tokio::spawn(Arc::clone(&wire).route(reader));
        (wire, theirs)
    }

    /// A data directory whose socket path comes to exactly `bytes`.
    fn data_dir_with_socket_of(bytes: usize) -> PathBuf {
        let name_length = bytes - "/".len() - "/".len() - SOCKET_NAME.len();
        PathBuf::from(format!("/{}", "a".repeat(name_length)))
    }

    #[test]
    fn a_socket_path_at_the_limit_is_usable_and_one_past_it_is_named() {
        let at_limit = RunnerClient::in_data_dir(&data_dir_with_socket_of(MAX_SOCKET_PATH_BYTES));
        assert_eq!(at_limit.socket_problem(), None);

        let past_limit =
            RunnerClient::in_data_dir(&data_dir_with_socket_of(MAX_SOCKET_PATH_BYTES + 1));
        let complaint = past_limit
            .socket_problem()
            .expect("one byte past the limit");
        assert!(
            complaint.contains(&format!("{} bytes", MAX_SOCKET_PATH_BYTES + 1))
                && complaint.contains(&MAX_SOCKET_PATH_BYTES.to_string())
                && complaint.contains("somewhere shorter"),
            "the complaint names the length, the limit, and the way out: {complaint}"
        );

        let (mock, _handle) = RunnerClient::mock();
        assert_eq!(mock.socket_problem(), None, "a mock has no socket to cap");
    }

    #[tokio::test]
    async fn a_data_directory_too_deep_for_a_socket_is_refused_before_anything_starts() {
        // The daemon would die without listening, and the wait for it would
        // time out saying nothing. The refusal has to be immediate and name
        // the actual problem: where the directory sits.
        let runner = RunnerClient::in_data_dir(&data_dir_with_socket_of(MAX_SOCKET_PATH_BYTES + 1));

        let refused = runner.ensure_running().await.expect_err("no socket fits");

        assert!(
            refused.to_string().contains("caps a unix socket address"),
            "{refused}"
        );
    }

    #[tokio::test]
    async fn a_session_send_reports_the_runners_rejection() {
        let (wire, theirs) = connected_wire();

        let runner = tokio::spawn(async move {
            let (reader, mut writer) = theirs.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("the request is readable");
            let request: WireRequest = serde_json::from_str(line.trim()).expect("a wire request");
            let id = request.id;
            assert!(
                matches!(
                    Request::from_wire(request).expect("a valid request"),
                    Request::SessionSend { .. }
                ),
                "the frame is carried as a session send"
            );
            let reply = Response {
                id,
                outcome: Outcome::Err(ErrorBody {
                    code: ErrorCode::NotAttached,
                    message: "subscribe before sending".to_string(),
                }),
            }
            .into_wire();
            let mut encoded = serde_json::to_vec(&reply).expect("the reply encodes");
            encoded.push(b'\n');
            writer
                .write_all(&encoded)
                .await
                .expect("the reply is written");
        });

        let frame = RawValue::from_string(r#"{"type":"user"}"#.to_string()).expect("a raw frame");
        let refused = wire.send_frame("conversation-1", frame).await;
        runner.await.expect("the runner task finishes");

        assert!(
            matches!(
                refused,
                Err(ClaudeError::Runner(ref message))
                    if message == "NotAttached: subscribe before sending"
            ),
            "a semantic rejection is not a successful write: {refused:?}"
        );
    }

    #[tokio::test]
    async fn an_event_before_a_session_send_ack_is_still_routed() {
        let (wire, theirs) = connected_wire();
        let (sender, mut events) = mpsc::unbounded_channel();
        wire.sessions
            .lock()
            .expect("sessions lock")
            .insert("conversation-1".to_string(), sender);

        let runner = tokio::spawn(async move {
            let (reader, mut writer) = theirs.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("the request is readable");
            let request: WireRequest = serde_json::from_str(line.trim()).expect("a wire request");

            let frame = RawValue::from_string(r#"{"type":"assistant"}"#.to_string())
                .expect("an event frame");
            let event = Event::Frame {
                session: "conversation-1".to_string(),
                frame,
            }
            .into_wire();
            let reply = Response {
                id: request.id,
                outcome: Outcome::Ok(ReplyBody::Empty {}),
            }
            .into_wire();
            for message in [
                serde_json::to_vec(&event).expect("the event encodes"),
                serde_json::to_vec(&reply).expect("the reply encodes"),
            ] {
                writer
                    .write_all(&message)
                    .await
                    .expect("the message is written");
                writer.write_all(b"\n").await.expect("the line ends");
            }
        });

        let frame = RawValue::from_string(r#"{"type":"user"}"#.to_string()).expect("a raw frame");
        wire.send_frame("conversation-1", frame)
            .await
            .expect("the runner accepts the send");
        runner.await.expect("the runner task finishes");

        assert_eq!(
            events.recv().await,
            Some(RunnerEvent::Frame(r#"{"type":"assistant"}"#.to_string())),
            "session output that races its acknowledgement is not discarded"
        );
    }
}
