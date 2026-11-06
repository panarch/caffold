//! The shared runner transport and process bootstrap.
//!
//! The driver supplies a socket and complete child spawn request. Frames remain
//! opaque, and provider protocols and test doubles stay with their drivers.

use std::collections::HashMap;
use std::env;
use std::io::{Error as IoError, ErrorKind};
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use caffold_runner::client::{Client, encode};
use caffold_runner::protocol;
use caffold_runner::protocol::{
    Checkpoint, ErrorBody, EventKind, Outcome, RECOVERY_VERSION, RecoveryLimits, RecoverySnapshot,
    ReplyBody, Request, Response, SessionInfo, SpawnRequest, WireEvent, WireResponse,
};
use serde_json::value::RawValue;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio::time::Instant;

use thiserror::Error;

#[derive(Debug, Error)]
pub(crate) enum RunnerError {
    #[error("{0}")]
    Unavailable(String),
    #[error("{code:?}: {message}")]
    Rejected {
        code: protocol::ErrorCode,
        message: String,
    },
    #[error("{0}")]
    OutcomeUnknown(String),
}

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
    socket: Arc<PathBuf>,
    /// The one subscribed connection every session shares, once one is up.
    wire: Arc<AsyncMutex<Option<Arc<Wire>>>>,
}

/// The backend's one connection to the runner.
///
/// The backend is one client, so it holds one subscription: every session's
/// frames go out on this connection, and every session's events come back on
/// it, each named by its session. One reader routes what arrives — replies to
/// whoever asked, events to the session they name — so nothing is dropped for
/// having arrived while something else was being awaited.
struct Wire {
    writer: AsyncMutex<OwnedWriteHalf>,
    next_id: AtomicU64,
    alive: AtomicBool,
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<ReplyBody, ErrorBody>>>>,
    sessions: StdMutex<HashMap<String, SessionSink>>,
}

enum SessionSink {
    Relay(mpsc::UnboundedSender<RunnerEvent>),
    Recovery(mpsc::UnboundedSender<RecoveryEvent>),
}

/// One session, attached: what the agent says, and what may be said to it.
pub(crate) struct RunnerSession {
    pub(crate) info: SessionInfo,
    pub(crate) frames: SessionFrames,
    pub(crate) events: SessionEvents,
}

/// The writing half of an attached session.
pub(crate) struct SessionFrames {
    wire: Arc<Wire>,
    session: String,
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

pub(crate) struct RecoverySession {
    pub(crate) snapshot: RecoverySnapshot,
    pub(crate) frames: RecoveryFrames,
    pub(crate) events: RecoveryEvents,
}

#[derive(Clone)]
pub(crate) struct RecoveryFrames {
    wire: Arc<Wire>,
    session: String,
    incarnation: String,
    lease: String,
}

pub(crate) struct RecoveryEvents(mpsc::UnboundedReceiver<RecoveryEvent>);

#[derive(Debug)]
pub(crate) enum RecoveryEvent {
    Output {
        incarnation: String,
        seq: u64,
        body: RecoveryOutput,
    },
    ProtocolFailure(String),
}

#[derive(Debug)]
pub(crate) enum RecoveryOutput {
    Frame(String),
    Fence,
    Exit(Option<i32>),
    TransportError(String),
}

impl RunnerClient {
    /// Reach one runner instance through its explicit socket.
    ///
    /// The socket lives with the data rather than at a fixed per-user path, so
    /// an installed application and a development server each drive their own
    /// runner instead of fighting over one.
    pub(crate) fn at_socket(socket: PathBuf) -> Self {
        Self {
            socket: Arc::new(socket),
            wire: Arc::new(AsyncMutex::new(None)),
        }
    }

    fn socket(&self) -> &Path {
        &self.socket
    }

    /// Start a runner if one is not already listening.
    ///
    /// Idempotent, because every operation begins with it: the runner outlives
    /// the backend, so the usual answer is that one is already there.
    pub(crate) async fn ensure_running(&self) -> Result<(), RunnerError> {
        if let Some(complaint) = self.socket_problem() {
            // Said before anything is started: a daemon asked anyway would
            // die without listening, and the wait for it would time out
            // without ever naming the problem.
            return Err(RunnerError::Unavailable(complaint));
        }
        let socket = self.socket().to_path_buf();
        if Client::connect(&socket).await.is_ok() {
            return Ok(());
        }
        if let Some(parent) = socket.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                RunnerError::Unavailable(format!(
                    "could not create the runner's directory {}: {error}",
                    parent.display()
                ))
            })?;
        }
        self.spawn_runner(&socket).await?;

        let deadline = Instant::now() + START_TIMEOUT;
        while Instant::now() < deadline {
            if Client::connect(&socket).await.is_ok() {
                return Ok(());
            }
            tokio::time::sleep(START_POLL).await;
        }
        Err(RunnerError::Unavailable(format!(
            "the Caffold runner did not start listening on {}",
            socket.display()
        )))
    }

    /// Start the runner as a process of its own.
    ///
    /// It is given its own process group deliberately. The runner is meant to
    /// outlive the backend — that is what keeps a turn running across a restart
    /// — so a signal sent to Caffold's group must not take it along.
    async fn spawn_runner(&self, socket: &Path) -> Result<(), RunnerError> {
        let executable = runner_executable()?;
        let mut command = Command::new(&executable);
        command
            .arg("daemon")
            .arg("run")
            .arg("--socket")
            .arg(socket)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        command.process_group(0);
        command.spawn().map_err(|error| {
            RunnerError::Unavailable(format!(
                "could not start the Caffold runner at {}: {error}",
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
    ) -> Result<RunnerSession, RunnerError> {
        let wire = self.shared_wire().await?;
        // Registered before the session is asked for, because an agent speaks
        // the moment it starts and its first events must find their channel.
        let (sender, receiver) = mpsc::unbounded_channel();
        wire.sessions
            .lock()
            .expect("sessions lock")
            .insert(session.to_string(), SessionSink::Relay(sender));
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
                return Err(RunnerError::Unavailable(
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
            frames: SessionFrames {
                wire,
                session: session.to_string(),
            },
            events: SessionEvents(receiver),
        })
    }

    /// Open one recoverable child without changing relay clients or replacing
    /// an older running daemon that lacks this optional protocol.
    pub(crate) async fn open_recoverable(
        &self,
        session: &str,
        spawn: SpawnRequest,
    ) -> Result<RecoverySession, RunnerError> {
        self.ensure_running().await?;
        let mut control = self.connect().await?;
        let status = control
            .request(Request::DaemonStatus)
            .await
            .map_err(|error| RunnerError::Unavailable(error.to_string()))?;
        if !matches!(status,ReplyBody::Daemon(status) if status.protocol_version==protocol::PROTOCOL_VERSION && status.recovery_version==Some(RECOVERY_VERSION))
        {
            return Err(RunnerError::Unavailable(
                "this runner does not advertise recovery protocol v1".to_string(),
            ));
        }
        let wire = self.shared_wire().await?;
        let (sender, receiver) = mpsc::unbounded_channel();
        {
            use std::collections::hash_map::Entry;
            match wire
                .sessions
                .lock()
                .expect("sessions lock")
                .entry(session.to_string())
            {
                Entry::Vacant(slot) => {
                    slot.insert(SessionSink::Recovery(sender));
                }
                Entry::Occupied(_) => {
                    return Err(RunnerError::Unavailable(
                        "the session stream is already registered".to_string(),
                    ));
                }
            }
        }
        let reply = wire
            .request(Request::SessionCreateRecoverable {
                session: session.to_string(),
                spawn,
                limits: RecoveryLimits::default(),
            })
            .await;
        let result = match reply {
            Ok(ReplyBody::Recovery { recovery }) => {
                if recovery.session.session != session
                    || recovery.session.incarnation.as_deref()
                        != Some(recovery.incarnation.as_str())
                    || recovery.lease.is_empty()
                    || recovery.incarnation.is_empty()
                    || recovery.acknowledged > recovery.fence
                    || !(1024..=protocol::MAX_JOURNAL_BYTES)
                        .contains(&recovery.limits.journal_bytes)
                    || !(1..=protocol::MAX_CHECKPOINT_BYTES)
                        .contains(&recovery.limits.checkpoint_bytes)
                    || recovery.checkpoint.len() > recovery.limits.checkpoint_bytes
                {
                    Err(RunnerError::Unavailable(
                        "the runner returned an inconsistent recovery snapshot".to_string(),
                    ))
                } else {
                    Ok(RecoverySession {
                        frames: RecoveryFrames {
                            wire: Arc::clone(&wire),
                            session: session.to_string(),
                            incarnation: recovery.incarnation.clone(),
                            lease: recovery.lease.clone(),
                        },
                        snapshot: recovery,
                        events: RecoveryEvents(receiver),
                    })
                }
            }
            Ok(_) => Err(RunnerError::Unavailable(
                "the runner answered a recovery attach with something else".to_string(),
            )),
            Err(error) => Err(error),
        };
        if result.is_err() {
            wire.sessions.lock().expect("sessions lock").remove(session);
        }
        result
    }

    /// Retire a broken observation connection, keeping every child and its
    /// journal alive for a fresh attach. Driver intent decides when to retry.
    pub(crate) async fn disconnect(&self) {
        if let Some(wire) = self.wire.lock().await.take() {
            wire.alive.store(false, Ordering::Relaxed);
            let _ = wire.writer.lock().await.shutdown().await;
        }
    }

    /// Retire only this backend observer before a serialized provider reattach.
    /// The next attach fences the old lease at the runner; the child stays up.
    pub(crate) async fn release_observer(&self, session: &str) {
        if let Some(wire) = self.wire.lock().await.as_ref() {
            wire.sessions.lock().expect("sessions lock").remove(session);
        }
    }

    /// The shared connection, connecting and subscribing if there is none.
    async fn shared_wire(&self) -> Result<Arc<Wire>, RunnerError> {
        let mut slot = self.wire.lock().await;
        if let Some(wire) = slot.as_ref()
            && wire.alive.load(Ordering::Relaxed)
        {
            return Ok(Arc::clone(wire));
        }
        self.ensure_running().await?;
        let stream = UnixStream::connect(self.socket())
            .await
            .map_err(|error| RunnerError::Unavailable(error.to_string()))?;
        let (reader, writer) = stream.into_split();
        let wire = Arc::new(Wire {
            writer: AsyncMutex::new(writer),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            pending: StdMutex::new(HashMap::new()),
            sessions: StdMutex::new(HashMap::new()),
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
        let Ok(mut client) = self.connect().await else {
            return None;
        };
        match client.request(Request::DaemonStatus).await {
            Ok(ReplyBody::Daemon(status)) => Some(status),
            _ => None,
        }
    }

    /// Passive inspection preserves unavailable versus not-listening evidence.
    pub(crate) async fn inspect(&self) -> Result<Option<protocol::DaemonStatus>, RunnerError> {
        if let Some(problem) = self.socket_problem() {
            return Err(RunnerError::Unavailable(problem));
        }
        let inspect = async {
            let mut client = match Client::connect(self.socket()).await {
                Ok(client) => client,
                Err(error)
                    if error.downcast_ref::<IoError>().is_some_and(|error| {
                        matches!(
                            error.kind(),
                            ErrorKind::NotFound | ErrorKind::ConnectionRefused
                        )
                    }) =>
                {
                    return Ok(None);
                }
                Err(error) => return Err(RunnerError::Unavailable(format!("{error:#}"))),
            };
            match client.request(Request::DaemonStatus).await {
                Ok(ReplyBody::Daemon(status)) => Ok(Some(status)),
                Ok(_) => Err(RunnerError::Unavailable(
                    "the runner returned an unexpected status reply".into(),
                )),
                Err(error) => Err(RunnerError::Unavailable(error.to_string())),
            }
        };
        tokio::time::timeout(REQUEST_TIMEOUT, inspect)
            .await
            .map_err(|_| {
                RunnerError::Unavailable("the runner did not answer within 30 seconds".into())
            })?
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
    pub(crate) fn socket_problem(&self) -> Option<String> {
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

    /// Confirm stopped writers without treating a runner error as absence.
    pub(crate) async fn checked_live_sessions(&self) -> Result<Vec<String>, RunnerError> {
        if self.inspect().await?.is_none() {
            return Ok(Vec::new());
        }
        let mut client = self
            .connect()
            .await
            .map_err(|error| RunnerError::Unavailable(error.to_string()))?;
        match client
            .request(Request::SessionList)
            .await
            .map_err(|error| RunnerError::Unavailable(error.to_string()))?
        {
            ReplyBody::Sessions { sessions } => Ok(sessions
                .into_iter()
                .filter(|session| matches!(session.state, protocol::SessionState::Running))
                .map(|session| session.session)
                .collect()),
            _ => Err(RunnerError::Unavailable(
                "The runner returned an unexpected session list.".into(),
            )),
        }
    }

    /// Stop the runner and start a fresh one, reporting the replacement.
    ///
    /// Deliberate, and only deliberate: every session the old runner held ends
    /// with it, and each conversation resumes from its file the next time its
    /// Task is opened. The stop is the
    /// graceful one — children closed, the book emptied — and the runner that
    /// answers afterwards is running whatever binary is installed now, which
    /// is the other thing restarting is for.
    pub(crate) async fn restart(&self) -> Result<protocol::DaemonStatus, RunnerError> {
        if let Ok(mut client) = self.connect().await {
            // A runner answers before it acts on the stop, so a request that
            // goes unanswered means it had already gone — which is what was
            // being asked for.
            let _ = client.request(Request::DaemonStop).await;
        }
        let deadline = Instant::now() + STOP_TIMEOUT;
        while Client::connect(self.socket()).await.is_ok() {
            if Instant::now() >= deadline {
                return Err(RunnerError::Unavailable(
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
            .map_err(|error| RunnerError::Unavailable(error.to_string()))?
        {
            ReplyBody::Daemon(status) => Ok(status),
            _ => Err(RunnerError::Unavailable(
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
    pub(crate) async fn close(&self, session: &str) -> Result<(), RunnerError> {
        let Ok(mut client) = self.connect().await else {
            return Ok(());
        };
        client
            .request(Request::SessionClose {
                session: session.to_string(),
            })
            .await
            .map_err(|error| RunnerError::Unavailable(error.to_string()))?;
        Ok(())
    }

    /// Recovery-backed deletion needs positive writer-termination evidence.
    /// Starting only the daemon also runs its recorded-child cleanup after a
    /// runner crash; a failed connection is never treated as an absent child.
    pub(crate) async fn close_recoverable(&self, session: &str) -> Result<(), RunnerError> {
        self.ensure_running().await?;
        let mut client = self.connect().await?;
        match client
            .request(Request::SessionClose {
                session: session.into(),
            })
            .await
            .map_err(|error| RunnerError::OutcomeUnknown(error.to_string()))?
        {
            ReplyBody::Empty {} => {
                self.release_observer(session).await;
                Ok(())
            }
            _ => Err(RunnerError::OutcomeUnknown(
                "the runner did not confirm recoverable writer termination".into(),
            )),
        }
    }

    async fn connect(&self) -> Result<Client, RunnerError> {
        Client::connect(self.socket())
            .await
            .map_err(|error| RunnerError::Unavailable(error.to_string()))
    }
}

impl SessionFrames {
    /// Write an already encoded provider frame without interpreting it.
    pub(crate) async fn send(&mut self, frame: Box<RawValue>) -> Result<(), RunnerError> {
        self.wire.send_frame(&self.session, frame).await
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

impl RecoveryFrames {
    pub(crate) async fn checkpoint(&self, through: u64, state: String) -> Result<(), RunnerError> {
        self.commit(Request::SessionCheckpoint {
            session: self.session.clone(),
            checkpoint: self.state(through, state),
        })
        .await
    }

    pub(crate) async fn finish_replay(
        &self,
        through: u64,
        state: String,
    ) -> Result<(), RunnerError> {
        self.commit(Request::SessionReplayLive {
            session: self.session.clone(),
            checkpoint: self.state(through, state),
        })
        .await
    }

    pub(crate) async fn send(
        &self,
        through: u64,
        state: String,
        frame: Box<RawValue>,
    ) -> Result<(), RunnerError> {
        self.commit(Request::SessionSendRecovery {
            session: self.session.clone(),
            checkpoint: self.state(through, state),
            frame,
        })
        .await
    }

    fn state(&self, through: u64, state: String) -> Checkpoint {
        Checkpoint {
            incarnation: self.incarnation.clone(),
            lease: self.lease.clone(),
            through,
            state,
        }
    }

    async fn commit(&self, request: Request) -> Result<(), RunnerError> {
        if !self.wire.alive.load(Ordering::Relaxed) {
            return Err(RunnerError::Unavailable(
                "the runner connection is gone before dispatch".to_string(),
            ));
        }
        match self.wire.request(request).await? {
            ReplyBody::Empty {} => Ok(()),
            _ => Err(RunnerError::OutcomeUnknown(
                "the runner answered a recovery commit with something else".to_string(),
            )),
        }
    }
}

impl RecoveryEvents {
    pub(crate) async fn next(&mut self) -> Option<RecoveryEvent> {
        self.0.recv().await
    }
}

impl Wire {
    /// Send one request and wait for its reply.
    async fn request(self: &Arc<Self>, request: Request) -> Result<ReplyBody, RunnerError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let encoded =
            encode(request, id).map_err(|error| RunnerError::Unavailable(error.to_string()))?;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending lock")
            .insert(id, sender);
        {
            let mut writer = self.writer.lock().await;
            if let Err(error) = writer.write_all(&encoded).await {
                self.pending.lock().expect("pending lock").remove(&id);
                return Err(RunnerError::OutcomeUnknown(error.to_string()));
            }
            if let Err(error) = writer.flush().await {
                self.pending.lock().expect("pending lock").remove(&id);
                return Err(RunnerError::OutcomeUnknown(error.to_string()));
            }
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(Ok(body))) => Ok(body),
            Ok(Ok(Err(error))) => Err(RunnerError::Rejected {
                code: error.code,
                message: error.message,
            }),
            Ok(Err(_)) => Err(RunnerError::OutcomeUnknown(
                "the runner connection ended before answering".to_string(),
            )),
            Err(_) => {
                self.pending.lock().expect("pending lock").remove(&id);
                Err(RunnerError::OutcomeUnknown(format!(
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
    ) -> Result<(), RunnerError> {
        if !self.alive.load(Ordering::Relaxed) {
            return Err(RunnerError::Unavailable(
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
            _ => Err(RunnerError::Unavailable(
                "the runner answered a session send with something else".to_string(),
            )),
        }
    }

    /// Read the connection for as long as it lives, routing what arrives.
    async fn route(self: Arc<Self>, reader: OwnedReadHalf) {
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
                Err(_) => self.invalidate_recovery("malformed runner envelope"),
            }
            if !self.alive.load(Ordering::Relaxed) {
                break;
            }
        }
        // The connection is over. Sessions hear it as their stream ending, and
        // callers still waiting hear it as the answer never coming.
        self.alive.store(false, Ordering::Relaxed);
        self.sessions.lock().expect("sessions lock").clear();
        self.pending.lock().expect("pending lock").clear();
        let _ = self.writer.lock().await.shutdown().await;
    }

    fn route_event(&self, line: &str) {
        let Ok(event) = serde_json::from_str::<WireEvent>(line) else {
            self.invalidate_recovery("malformed runner event");
            return;
        };
        let mut sessions = self.sessions.lock().expect("sessions lock");
        if let Some(SessionSink::Recovery(sender)) = sessions.get(&event.s) {
            let recovery_event = match recovery_event(event) {
                Ok(Some(event)) => event,
                Ok(None) => return,
                Err(message) => RecoveryEvent::ProtocolFailure(message),
            };
            let _ = sender.send(recovery_event);
            return;
        }
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
            // Recovery output has its own consumer; relay sessions never
            // receive these control envelopes.
            EventKind::ReplayFence | EventKind::TransportError => return,
        };
        let ended = matches!(runner_event, RunnerEvent::Exit(_));
        if let Some(SessionSink::Relay(sender)) = sessions.get(&event.s) {
            let delivered = sender.send(runner_event).is_ok();
            if ended || !delivered {
                sessions.remove(&event.s);
            }
        }
    }

    fn route_reply(&self, line: &str) {
        let Ok(wire) = serde_json::from_str::<WireResponse>(line) else {
            self.invalidate_recovery("malformed runner reply");
            return;
        };
        if wire.ok.is_some() == wire.err.is_some() {
            self.invalidate_recovery("runner reply has no single outcome");
            if !self.alive.load(Ordering::Relaxed) {
                return;
            }
        }
        let Response { id, outcome } = Response::from_wire(wire);
        // A reply nobody registered for belongs to a fire-and-forget send.
        let Some(waiting) = self.pending.lock().expect("pending lock").remove(&id) else {
            return;
        };
        let _ = waiting.send(match outcome {
            Outcome::Ok(body) => Ok(body),
            Outcome::Err(error) => Err(error),
        });
    }

    fn invalidate_recovery(&self, message: &str) {
        let sessions = self.sessions.lock().expect("sessions lock");
        let mut invalidated = false;
        for sink in sessions.values() {
            if let SessionSink::Recovery(sender) = sink {
                let _ = sender.send(RecoveryEvent::ProtocolFailure(message.into()));
                invalidated = true;
            }
        }
        if invalidated {
            self.alive.store(false, Ordering::Relaxed);
            self.pending.lock().expect("pending lock").clear();
        }
    }
}

fn recovery_event(event: WireEvent) -> Result<Option<RecoveryEvent>, String> {
    if event.t == EventKind::Stderr {
        // Recovery clients consume protocol state, not native diagnostic text.
        return event
            .line
            .map(|_| None)
            .ok_or_else(|| "recovery diagnostic has no line".to_string());
    }
    let incarnation = event
        .incarnation
        .filter(|value| !value.is_empty())
        .ok_or("recovery output has no incarnation")?;
    let seq = event.seq.ok_or("recovery output has no sequence")?;
    let body = match event.t {
        EventKind::Frame => RecoveryOutput::Frame(
            event
                .frame
                .ok_or("recovery frame has no value")?
                .get()
                .to_string(),
        ),
        EventKind::ReplayFence => RecoveryOutput::Fence,
        EventKind::Exit => RecoveryOutput::Exit(event.code),
        EventKind::TransportError => RecoveryOutput::TransportError(
            event
                .line
                .ok_or("recovery transport error has no message")?,
        ),
        EventKind::Stderr => unreachable!("handled above"),
    };
    Ok(Some(RecoveryEvent::Output {
        incarnation,
        seq,
        body,
    }))
}

/// Where the runner executable is.
///
/// Beside the backend's own binary, because that is where the installer puts
/// it and where `cargo build` leaves it. `CAFFOLD_RUNNER` overrides,
/// which is what a developer running the two from different places needs.
fn runner_executable() -> Result<PathBuf, RunnerError> {
    if let Some(explicit) = env::var_os("CAFFOLD_RUNNER") {
        return Ok(PathBuf::from(explicit));
    }
    let current = env::current_exe().map_err(|error| {
        RunnerError::Unavailable(format!("could not locate the Caffold executable: {error}"))
    })?;
    let beside = current
        .parent()
        .map(|directory| directory.join("caffold-runner"))
        .ok_or_else(|| {
            RunnerError::Unavailable("the Caffold executable has no directory".to_string())
        })?;
    if beside.exists() {
        return Ok(beside);
    }
    Err(RunnerError::Unavailable(format!(
        "no Caffold runner beside {}. Build it with `cargo build -p caffold-runner`, \
         or set CAFFOLD_RUNNER.",
        current.display()
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use caffold_runner::protocol::{ErrorBody, ErrorCode, Event, WireRequest};
    use tokio::task::LocalSet;

    #[tokio::test]
    async fn passive_status_distinguishes_a_reply_from_inaccessible_or_wrong_sockets() {
        use std::{fs, os::unix::fs::PermissionsExt};
        use tokio::net::UnixListener;
        let root = tempfile::tempdir_in("/tmp").unwrap();
        let socket = root.path().join("runner.sock");
        let owner = RunnerClient::at_socket(socket.clone());
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o0)).unwrap();
        let inaccessible = owner.inspect().await;
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            inaccessible.is_err(),
            "permission errors are not evidence of absence"
        );
        let reply = tokio::spawn(async move {
            for body in [
                ReplyBody::Daemon(protocol::DaemonStatus {
                    protocol_version: 1,
                    recovery_version: Some(RECOVERY_VERSION),
                    runner_version: "fixture-build".into(),
                    unsubscribed_for_secs: None,
                    pid: 321,
                    socket: socket.display().to_string(),
                    sessions: 3,
                    idle_timeout_secs: Some(600),
                }),
                ReplyBody::Sessions { sessions: vec![] },
            ] {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut line = String::new();
                BufReader::new(read).read_line(&mut line).await.unwrap();
                let request: WireRequest = serde_json::from_str(&line).unwrap();
                let response = Response {
                    id: request.id,
                    outcome: Outcome::Ok(body),
                }
                .into_wire();
                let mut bytes = serde_json::to_vec(&response).unwrap();
                bytes.push(b'\n');
                write.write_all(&bytes).await.unwrap();
            }
        });
        let status = owner.inspect().await.unwrap().unwrap();
        assert_eq!((status.pid, status.sessions), (321, 3));
        assert_eq!(status.runner_version, "fixture-build");
        assert!(
            owner.inspect().await.is_err(),
            "a different reply is not a daemon report"
        );
        reply.await.unwrap();
    }

    #[tokio::test]
    async fn socket_transport_reattaches_to_the_same_child_after_its_connection_ends() {
        LocalSet::new()
            .run_until(async {
                use std::collections::BTreeMap;

                use caffold_runner::daemon;

                let directory = tempfile::tempdir().expect("runner directory");
                let socket = directory.path().join("transport.sock");
                let listener = daemon::bind(&socket).await.expect("bind runner");
                let daemon = tokio::task::spawn_local(
                    daemon::Runner::new(socket.clone(), None).serve(listener),
                );
                let client = RunnerClient::at_socket(socket.clone());
                let spawn = SpawnRequest {
                    argv: vec!["/bin/cat".to_string()],
                    cwd: directory.path().display().to_string(),
                    env: BTreeMap::new(),
                };
                let mut first = client.open("held", spawn.clone()).await.expect("open");
                let pid = first.info.pid;
                assert!(first.info.spawned);
                let raw = r#"{"native":1e0,"nested":{"keep":true}}"#;
                first
                    .frames
                    .send(RawValue::from_string(raw.to_string()).unwrap())
                    .await
                    .expect("send");
                assert_eq!(
                    first.events.next().await,
                    Some(RunnerEvent::Frame(raw.to_string()))
                );
                assert_eq!(client.live_sessions().await, ["held"]);
                assert_eq!(client.status().await.expect("status").sessions, 1);

                // Closing the transport is a backend connection ending, not a request
                // to close its native child. Wait for that exact connection's EOF.
                let wire = client.wire.lock().await.take().expect("shared wire");
                wire.writer
                    .lock()
                    .await
                    .shutdown()
                    .await
                    .expect("disconnect");
                assert_eq!(
                    tokio::time::timeout(Duration::from_secs(5), first.events.next())
                        .await
                        .expect("connection ends"),
                    None
                );
                let mut observer = Client::connect(&socket).await.expect("session observer");
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    let ReplyBody::Sessions { sessions } = observer
                        .request(Request::SessionList)
                        .await
                        .expect("sessions")
                    else {
                        panic!("a session list");
                    };
                    if sessions.iter().all(|session| !session.attached) {
                        break;
                    }
                    assert!(Instant::now() < deadline, "the old subscriber detaches");
                    tokio::task::yield_now().await;
                }
                let mut second = client.open("held", spawn).await.expect("reattach");
                assert_eq!(second.info.pid, pid);
                assert!(!second.info.spawned);
                second
                    .frames
                    .send(RawValue::from_string(raw.to_string()).unwrap())
                    .await
                    .expect("send again");
                assert_eq!(
                    second.events.next().await,
                    Some(RunnerEvent::Frame(raw.to_string()))
                );

                client.close("held").await.expect("close child");
                assert!(matches!(
                    tokio::time::timeout(Duration::from_secs(5), second.events.next())
                        .await
                        .expect("child exit"),
                    Some(RunnerEvent::Exit(_))
                ));
                assert!(client.live_sessions().await.is_empty());
                let mut control = Client::connect(&socket).await.expect("control");
                control
                    .request(Request::DaemonStop)
                    .await
                    .expect("stop runner");
                daemon.await.expect("runner task").expect("runner exit");
            })
            .await;
    }

    fn connected_wire() -> (Arc<Wire>, UnixStream) {
        let (ours, theirs) = UnixStream::pair().expect("a local wire pair");
        let (reader, writer) = ours.into_split();
        let wire = Arc::new(Wire {
            writer: AsyncMutex::new(writer),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            pending: StdMutex::new(HashMap::new()),
            sessions: StdMutex::new(HashMap::new()),
        });
        tokio::spawn(Arc::clone(&wire).route(reader));
        (wire, theirs)
    }

    /// An absolute socket path of exactly `bytes`.
    fn socket_of(bytes: usize) -> PathBuf {
        PathBuf::from(format!("/{}", "a".repeat(bytes - 1)))
    }

    #[test]
    fn a_socket_path_at_the_limit_is_usable_and_one_past_it_is_named() {
        let at_limit = RunnerClient::at_socket(socket_of(MAX_SOCKET_PATH_BYTES));
        assert_eq!(at_limit.socket_problem(), None);

        let past_limit = RunnerClient::at_socket(socket_of(MAX_SOCKET_PATH_BYTES + 1));
        let complaint = past_limit
            .socket_problem()
            .expect("one byte past the limit");
        assert!(
            complaint.contains(&format!("{} bytes", MAX_SOCKET_PATH_BYTES + 1))
                && complaint.contains(&MAX_SOCKET_PATH_BYTES.to_string())
                && complaint.contains("somewhere shorter"),
            "the complaint names the length, the limit, and the way out: {complaint}"
        );
    }

    #[tokio::test]
    async fn a_data_directory_too_deep_for_a_socket_is_refused_before_anything_starts() {
        // The daemon would die without listening, and the wait for it would
        // time out saying nothing. The refusal has to be immediate and name
        // the actual problem: where the directory sits.
        let runner = RunnerClient::at_socket(socket_of(MAX_SOCKET_PATH_BYTES + 1));

        let refused = runner.ensure_running().await.expect_err("no socket fits");

        assert!(
            refused.to_string().contains("caps a unix socket address"),
            "{refused}"
        );
    }

    #[tokio::test]
    async fn missing_reply_outcome_is_unknown_and_invalidates_recovery_instead_of_accepting_input()
    {
        let (wire, theirs) = connected_wire();
        let (sender, mut events) = mpsc::unbounded_channel();
        wire.sessions
            .lock()
            .unwrap()
            .insert("native".into(), SessionSink::Recovery(sender));
        let peer = tokio::spawn(async move {
            let (reader, mut writer) = theirs.into_split();
            let mut reader = BufReader::new(reader);
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let request: WireRequest = serde_json::from_str(&line).unwrap();
            writer
                .write_all(format!("{{\"id\":{}}}\n", request.id).as_bytes())
                .await
                .unwrap();
        });
        let result = wire.request(Request::DaemonStatus).await;
        assert!(matches!(result, Err(RunnerError::OutcomeUnknown(_))));
        assert!(matches!(
            events.recv().await,
            Some(RecoveryEvent::ProtocolFailure(_))
        ));
        assert!(!wire.alive.load(Ordering::Relaxed));
        peer.await.unwrap();
    }
    #[tokio::test]
    async fn recovery_output_without_incarnation_or_sequence_is_not_a_relay_frame() {
        let (wire, mut peer) = connected_wire();
        let (sender, mut events) = mpsc::unbounded_channel();
        wire.sessions
            .lock()
            .unwrap()
            .insert("native".into(), SessionSink::Recovery(sender));
        peer.write_all(b"{\"t\":\"frame\",\"s\":\"native\",\"f\":{}}\n")
            .await
            .unwrap();
        assert!(matches!(
            events.recv().await,
            Some(RecoveryEvent::ProtocolFailure(_))
        ));
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
                Err(RunnerError::Rejected { code: ErrorCode::NotAttached, ref message })
                    if message == "subscribe before sending"
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
            .insert("conversation-1".to_string(), SessionSink::Relay(sender));

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
