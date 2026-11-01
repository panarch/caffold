//! One supervised child and the pipe between it and an attached client.
//!
//! The runner reads whole lines and forwards them. It does not parse them, so
//! a frame it cannot make sense of is still delivered — the client decides what
//! is meaningful.

use std::process::Stdio;
use std::sync::Arc;

use serde_json::value::RawValue;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, Notify, mpsc, oneshot, watch};

use crate::protocol::{
    Checkpoint, Event, RecoveryLimits, RecoverySnapshot, SessionInfo, SessionState, SpawnRequest,
};

mod recovery;
use recovery::Recovery;

/// Largest single line the runner will assemble, in either direction.
///
/// A prompt carrying pasted screenshots is base64 inside one line, so the
/// ceiling has to clear several megabytes of image. It exists to bound the
/// damage from a peer that never sends a newline, not to police normal traffic:
/// a real prompt hits the model's context limit long before it reaches this.
pub const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// How many events may queue for an attached client before the reader stops
/// pulling from the child.
///
/// Stalling is the intended outcome. The alternative — an unbounded queue —
/// turns a client that stops reading into unbounded memory growth in the one
/// process that is supposed to outlive everything else.
pub const EVENT_QUEUE: usize = 256;

/// How long closing waits for a child to be gone before giving up and letting
/// shutdown continue.
const KILL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

#[derive(Debug, Clone, Copy)]
enum State {
    Running { pid: u32 },
    Exited { code: Option<i32> },
}

pub struct Session {
    id: String,
    child_pid: u32,
    state: Arc<Mutex<State>>,
    output: Output,
    stdin: mpsc::Sender<Vec<u8>>,
    finished: watch::Receiver<bool>,
    /// Raised to end the child. The supervising task owns the process itself,
    /// so ending it is a request rather than a direct call: a second owner
    /// would have to hold the process across `wait`, and anything else wanting
    /// to end it would then wait for the very thing it was trying to stop.
    kill: Arc<Notify>,
}

/// Already encoded journal entries are shared with the writer, not copied
/// into an additional event queue. Completion means the socket write finished.
pub(crate) enum Outbound {
    Relay(Event),
    Buffered {
        encoded: Arc<Vec<u8>>,
        written: oneshot::Sender<()>,
    },
}

#[derive(Clone)]
enum Output {
    Relay(Arc<Mutex<Option<mpsc::Sender<Outbound>>>>),
    Recoverable(Arc<Recovery>),
}

struct PipeTasks {
    stdin: tokio::task::JoinHandle<()>,
    stdout: tokio::task::JoinHandle<()>,
    stderr: tokio::task::JoinHandle<()>,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("failed to start the session process: {0}")]
    Spawn(String),
    #[error("the session process has exited")]
    Exited,
    #[error("another client is already attached")]
    AlreadyAttached,
    #[error("the child incarnation differs from this recovery stream")]
    WrongIncarnation,
    #[error("this subscriber no longer owns the recovery stream")]
    StaleSubscriber,
    #[error("invalid checkpoint: {0}")]
    InvalidCheckpoint(String),
    #[error("recovery operation refused: {0}")]
    RecoveryState(String),
    #[error("stdin queue is full; the frame and checkpoint were not accepted")]
    Backpressure,
    #[error("recovery limits must be within journal 1024..=64 MiB and checkpoint 1..=16 MiB")]
    InvalidLimits,
    #[error("the session did not finish closing before the deadline")]
    CloseFailed,
}

impl Session {
    /// Start a child from arguments the caller has already assembled.
    ///
    /// A subscriber given here is installed before the child exists, so an
    /// agent that speaks as soon as it starts is heard. Attaching afterwards
    /// would leave a gap, and the runner keeps no history to fill it.
    pub(crate) async fn spawn(
        id: &str,
        request: &SpawnRequest,
        subscriber: Option<mpsc::Sender<Outbound>>,
    ) -> Result<Self, SessionError> {
        Self::spawn_with_output(id, request, Output::Relay(Arc::new(Mutex::new(subscriber)))).await
    }

    pub(crate) async fn spawn_recoverable(
        id: &str,
        request: &SpawnRequest,
        limits: RecoveryLimits,
    ) -> Result<Self, SessionError> {
        let recovery = Recovery::new(id, limits)?;
        Self::spawn_with_output(id, request, Output::Recoverable(recovery)).await
    }

    async fn spawn_with_output(
        id: &str,
        request: &SpawnRequest,
        output: Output,
    ) -> Result<Self, SessionError> {
        let (program, arguments) = request
            .argv
            .split_first()
            .ok_or_else(|| SessionError::Spawn("no program given".to_string()))?;

        let mut command = Command::new(program);
        command
            .args(arguments)
            .current_dir(&request.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (key, value) in &request.env {
            command.env(key, value);
        }
        if matches!(output, Output::Recoverable(_)) {
            command.process_group(0);
        }

        let mut child = command
            .spawn()
            .map_err(|error| SessionError::Spawn(error.to_string()))?;
        let pid = child.id().unwrap_or_default();

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| SessionError::Spawn("no stdin pipe".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| SessionError::Spawn("no stdout pipe".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| SessionError::Spawn("no stderr pipe".to_string()))?;

        let state = Arc::new(Mutex::new(State::Running { pid }));
        let capacity = if matches!(output, Output::Recoverable(_)) {
            1
        } else {
            EVENT_QUEUE
        };
        let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(capacity);
        let kill = Arc::new(Notify::new());
        let (finished_tx, finished) = watch::channel(false);

        let stdin = tokio::spawn(write_stdin(stdin, stdin_rx, output.clone()));
        let stdout = tokio::spawn(read_stdout(id.to_string(), stdout, output.clone()));
        let stderr = tokio::spawn(read_stderr(id.to_string(), stderr, output.clone()));
        tokio::spawn(supervise(
            id.to_string(),
            child,
            Arc::clone(&kill),
            Arc::clone(&state),
            output.clone(),
            PipeTasks {
                stdin,
                stdout,
                stderr,
            },
            finished_tx,
        ));

        Ok(Self {
            id: id.to_string(),
            child_pid: pid,
            state,
            output,
            stdin: stdin_tx,
            finished,
            kill,
        })
    }

    pub async fn is_running(&self) -> bool {
        matches!(*self.state.lock().await, State::Running { .. })
    }

    pub(crate) fn child_pid(&self) -> u32 {
        self.child_pid
    }

    /// This session described as it stands. Describing starts nothing, so
    /// `spawned` is false here; the create path that actually started the
    /// child says so on the answer it returns.
    pub async fn info(&self) -> SessionInfo {
        let state = *self.state.lock().await;
        let attached = match &self.output {
            Output::Relay(subscriber) => subscriber.lock().await.is_some(),
            Output::Recoverable(recovery) => recovery.attached().await,
        };
        let incarnation = self.incarnation().map(str::to_string);
        match state {
            State::Running { pid } => SessionInfo {
                session: self.id.clone(),
                state: SessionState::Running,
                pid: Some(pid),
                attached,
                spawned: false,
                exit_code: None,
                incarnation,
            },
            State::Exited { code } => SessionInfo {
                session: self.id.clone(),
                state: SessionState::Exited,
                pid: None,
                attached,
                spawned: false,
                exit_code: code,
                incarnation,
            },
        }
    }

    /// Deliver this session's output into the subscriber's lane.
    ///
    /// The lane is shared: every attached session writes into it and each event
    /// names its session. One delivery per session — attaching one that is
    /// already delivering somewhere live is refused rather than splitting its
    /// stream, though a lane whose reader has gone counts as nowhere.
    pub(crate) async fn attach(&self, lane: mpsc::Sender<Outbound>) -> Result<(), SessionError> {
        let Output::Relay(subscriber) = &self.output else {
            return Err(SessionError::RecoveryState(
                "use a recovery attach for this session".to_string(),
            ));
        };
        let mut subscriber = subscriber.lock().await;
        if subscriber.as_ref().is_some_and(|tx| !tx.is_closed()) {
            return Err(SessionError::AlreadyAttached);
        }
        *subscriber = Some(lane);
        Ok(())
    }

    /// Release only the lane being closed. A later connection may have taken
    /// the global subscription while the old connection was cleaning up.
    pub(crate) async fn detach_lane(&self, lane: &mpsc::Sender<Outbound>) {
        match &self.output {
            Output::Relay(subscriber) => {
                let mut held = subscriber.lock().await;
                if held.as_ref().is_some_and(|held| held.same_channel(lane)) {
                    *held = None;
                }
            }
            Output::Recoverable(recovery) => recovery.detach_lane(lane).await,
        }
    }

    pub(crate) fn incarnation(&self) -> Option<&str> {
        match &self.output {
            Output::Recoverable(recovery) => Some(recovery.incarnation()),
            Output::Relay(_) => None,
        }
    }

    pub(crate) async fn attach_recovery(
        &self,
        connection: u64,
        lane: mpsc::Sender<Outbound>,
        incarnation: &str,
    ) -> Result<RecoverySnapshot, SessionError> {
        self.recovery()?
            .attach(connection, lane, incarnation, self.info().await)
            .await
    }

    pub(crate) async fn start_replay(&self, lease: &str) {
        if let Output::Recoverable(recovery) = &self.output {
            recovery.start(lease).await;
        }
    }

    pub(crate) async fn checkpoint(
        &self,
        connection: u64,
        checkpoint: Checkpoint,
        finish_replay: bool,
    ) -> Result<(), SessionError> {
        self.recovery()?
            .commit(connection, checkpoint, finish_replay, None)
            .await
    }

    pub(crate) async fn send_recovery(
        &self,
        connection: u64,
        checkpoint: Checkpoint,
        frame: &RawValue,
    ) -> Result<(), SessionError> {
        if !self.is_running().await {
            return Err(SessionError::Exited);
        }
        let line = input_line(frame)?;
        self.recovery()?
            .commit(connection, checkpoint, false, Some((line, &self.stdin)))
            .await
    }

    fn recovery(&self) -> Result<&Arc<Recovery>, SessionError> {
        match &self.output {
            Output::Recoverable(recovery) => Ok(recovery),
            Output::Relay(_) => Err(SessionError::RecoveryState(
                "this session uses relay transport".to_string(),
            )),
        }
    }

    /// Forward one frame to the child, adding the newline the child's reader
    /// expects.
    pub async fn send(&self, frame: &RawValue) -> Result<(), SessionError> {
        if matches!(self.output, Output::Recoverable(_)) {
            return Err(SessionError::RecoveryState(
                "use an atomic recovery send for this session".to_string(),
            ));
        }
        if !self.is_running().await {
            return Err(SessionError::Exited);
        }
        let line = input_line(frame)?;
        self.stdin
            .send(line)
            .await
            .map_err(|_| SessionError::Exited)
    }

    /// End the child and wait for it to be gone.
    ///
    /// Waiting matters on shutdown: the runner stops sessions and then exits,
    /// and a request that only asked would let the process leave children
    /// behind it.
    pub async fn close(&self) -> Result<(), SessionError> {
        if let Output::Recoverable(recovery) = &self.output {
            recovery.close().await;
        }
        self.kill.notify_one();
        if matches!(self.output, Output::Recoverable(_)) {
            let mut finished = self.finished.clone();
            return match tokio::time::timeout(KILL_TIMEOUT, finished.wait_for(|done| *done)).await {
                Ok(Ok(_)) => Ok(()),
                _ => Err(SessionError::CloseFailed),
            };
        }
        let deadline = tokio::time::Instant::now() + KILL_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if !self.is_running().await {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        Err(SessionError::CloseFailed)
    }
}

async fn write_stdin(mut stdin: ChildStdin, mut lines: mpsc::Receiver<Vec<u8>>, output: Output) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
            if let Output::Recoverable(recovery) = &output {
                recovery
                    .failure("stdin write failed after transport acceptance".to_string())
                    .await;
            }
            return;
        }
    }
}

async fn read_stdout<R>(id: String, stdout: R, output: Output)
where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stdout);
    loop {
        match read_capped_line(&mut reader).await {
            Ok(Some(line)) => {
                let Ok(frame) = RawValue::from_string(line) else {
                    if let Output::Recoverable(recovery) = &output {
                        recovery
                            .failure("child stdout was not a JSON value".to_string())
                            .await;
                        return;
                    }
                    // Not JSON. The runner does not validate frames, but it
                    // cannot embed a non-value either, so this is reported as
                    // diagnostic output rather than silently dropped.
                    continue;
                };
                let event = Event::Frame {
                    session: id.clone(),
                    frame,
                };
                if !output.publish(event).await {
                    if matches!(output, Output::Recoverable(_)) {
                        return;
                    }
                    // Nobody is attached. The frame is dropped on purpose: the
                    // runner keeps no history, and a client that missed output
                    // recovers it from the agent rather than from here.
                    continue;
                }
            }
            Ok(None) => return,
            Err(error) => {
                if let Output::Recoverable(recovery) = &output {
                    recovery.failure(error.to_string()).await;
                    return;
                }
                let event = Event::Stderr {
                    session: id.clone(),
                    line: format!("runner: {error}"),
                };
                output.diagnostic(event).await;
                return;
            }
        }
    }
}

async fn read_stderr<R>(id: String, stderr: R, output: Output)
where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stderr);
    while let Ok(Some(line)) = read_capped_line(&mut reader).await {
        if line.trim().is_empty() {
            continue;
        }
        let event = Event::Stderr {
            session: id.clone(),
            line,
        };
        output.diagnostic(event).await;
    }
}

/// Own the child until it ends, ending it early when asked.
///
/// The wait is re-entered after a kill request rather than shared with another
/// owner. `Child::wait` is cancel safe, so dropping it to send the signal and
/// waiting again observes the same exit.
async fn supervise(
    id: String,
    mut child: Child,
    kill: Arc<Notify>,
    state: Arc<Mutex<State>>,
    output: Output,
    pipes: PipeTasks,
    finished: watch::Sender<bool>,
) {
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            // Nothing here touches the child: the borrow the wait holds ends
            // with the select, and the signal is sent after it.
            () = kill.notified() => {}
        }
        if matches!(output, Output::Recoverable(_)) {
            // EOF gives the official harness a chance to stop its own writers.
            pipes.stdin.abort();
            if let Ok(status) =
                tokio::time::timeout(std::time::Duration::from_secs(2), child.wait()).await
            {
                break status;
            }
        }
        let _ = child.start_kill();
    };
    let code = status.ok().and_then(|status| status.code());
    *state.lock().await = State::Exited { code };
    if matches!(output, Output::Recoverable(_)) {
        pipes.stdin.abort();
        pipes.stderr.abort();
        let _ = pipes.stdin.await;
        let _ = pipes.stderr.await;
        // The child can exit before the reader drains its last pipe bytes.
        // Keep those bytes before Exit, including while backpressured.
        let _ = pipes.stdout.await;
    }
    output.publish(Event::Exit { session: id, code }).await;
    finished.send_replace(true);
}

/// Deliver to the attached client if there is one. Returns whether it was
/// delivered.
async fn publish(subscriber: &Arc<Mutex<Option<mpsc::Sender<Outbound>>>>, event: Event) -> bool {
    let sender = { subscriber.lock().await.clone() };
    match sender {
        Some(sender) => sender.send(Outbound::Relay(event)).await.is_ok(),
        None => false,
    }
}

impl Output {
    async fn publish(&self, event: Event) -> bool {
        match self {
            Self::Relay(subscriber) => publish(subscriber, event).await,
            Self::Recoverable(recovery) => match recovery.append(event).await {
                Ok(()) => true,
                Err(error) => {
                    recovery.failure(error.to_string()).await;
                    false
                }
            },
        }
    }

    async fn diagnostic(&self, event: Event) {
        match self {
            Self::Relay(subscriber) => {
                publish(subscriber, event).await;
            }
            Self::Recoverable(recovery) => recovery.diagnostic(event).await,
        }
    }
}

fn input_line(frame: &RawValue) -> Result<Vec<u8>, SessionError> {
    if frame.get().len() > MAX_LINE_BYTES {
        return Err(SessionError::RecoveryState(
            "stdin frame exceeds the line limit".to_string(),
        ));
    }
    let mut line = frame.get().as_bytes().to_vec();
    line.push(b'\n');
    Ok(line)
}

/// Read one newline-terminated line, refusing to grow past [`MAX_LINE_BYTES`].
///
/// `AsyncBufReadExt::read_line` would grow without limit, which turns a peer
/// that never sends a newline into unbounded allocation in the process that has
/// to stay alive.
async fn read_capped_line<R>(reader: &mut BufReader<R>) -> std::io::Result<Option<String>>
where
    R: AsyncRead + Unpin,
{
    let mut line = Vec::new();
    let mut byte = [0_u8; 1];
    loop {
        match reader.read_exact(&mut byte).await {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                if line.is_empty() {
                    return Ok(None);
                }
                break;
            }
            Err(error) => return Err(error),
        }
        if byte[0] == b'\n' {
            break;
        }
        if line.len() >= MAX_LINE_BYTES {
            return Err(std::io::Error::other(format!(
                "line exceeded {MAX_LINE_BYTES} bytes"
            )));
        }
        line.push(byte[0]);
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Ok(Some(String::from_utf8_lossy(&line).into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{EventKind, WireEvent};

    #[tokio::test]
    async fn a_line_longer_than_the_cap_fails_instead_of_growing() {
        let oversized = vec![b'x'; MAX_LINE_BYTES + 16];
        let mut reader = BufReader::new(std::io::Cursor::new(oversized));

        let error = read_capped_line(&mut reader)
            .await
            .expect_err("an unterminated oversized line must fail");

        assert!(error.to_string().contains("exceeded"), "{error}");
    }

    #[tokio::test]
    async fn a_final_line_without_a_newline_is_still_delivered() {
        let mut reader = BufReader::new(std::io::Cursor::new(b"{\"a\":1}".to_vec()));

        let line = read_capped_line(&mut reader).await.expect("read");

        assert_eq!(line.as_deref(), Some("{\"a\":1}"));
    }

    #[tokio::test]
    async fn carriage_returns_do_not_survive_into_a_frame() {
        // A child on a platform that writes CRLF would otherwise hand the
        // client a frame with a trailing byte that is not part of its JSON.
        let mut reader = BufReader::new(std::io::Cursor::new(b"{\"a\":1}\r\n".to_vec()));

        let line = read_capped_line(&mut reader).await.expect("read");

        assert_eq!(line.as_deref(), Some("{\"a\":1}"));
    }

    #[tokio::test]
    async fn an_empty_stream_ends_rather_than_yielding_an_empty_line() {
        let mut reader = BufReader::new(std::io::Cursor::new(Vec::new()));

        assert!(read_capped_line(&mut reader).await.expect("read").is_none());
    }

    #[tokio::test]
    async fn a_lost_supervisor_does_not_claim_a_successful_recovery_close() {
        let recovery = Recovery::new("s", RecoveryLimits::default()).unwrap();
        let (finished_tx, finished) = watch::channel(false);
        drop(finished_tx);
        let session = Session {
            id: "s".to_string(),
            child_pid: 123,
            state: Arc::new(Mutex::new(State::Exited { code: None })),
            output: Output::Recoverable(recovery),
            stdin: mpsc::channel(1).0,
            finished,
            kill: Arc::new(Notify::new()),
        };
        assert!(matches!(
            session.close().await,
            Err(SessionError::CloseFailed)
        ));
        assert_eq!(
            session.child_pid(),
            123,
            "keep the cleanup identity after a failed close"
        );
    }

    #[tokio::test]
    async fn invalid_native_stdout_is_a_recovery_failure_instead_of_a_silent_gap() {
        let recovery = Recovery::new("s", RecoveryLimits::default()).unwrap();
        let output = Output::Recoverable(Arc::clone(&recovery));
        read_stdout(
            "s".to_string(),
            std::io::Cursor::new(b"not-json\n".to_vec()),
            output,
        )
        .await;
        let (lane, mut events) = mpsc::channel(1);
        let snapshot = recovery
            .attach(
                1,
                lane,
                recovery.incarnation(),
                SessionInfo {
                    session: "s".to_string(),
                    state: SessionState::Exited,
                    pid: None,
                    attached: false,
                    spawned: false,
                    exit_code: Some(0),
                    incarnation: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(snapshot.fence, 1);
        recovery.start(&snapshot.lease).await;
        let Outbound::Buffered { encoded, written } = events.recv().await.unwrap() else {
            panic!("transport failure")
        };
        let event: WireEvent = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(event.t, EventKind::TransportError);
        assert!(event.line.unwrap().contains("not a JSON value"));
        let _ = written.send(());
        recovery.close().await;
    }
}
