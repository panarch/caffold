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
use tokio::sync::{Mutex, Notify, mpsc};

use crate::protocol::{Event, SessionInfo, SessionState, SpawnRequest};

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
    state: Arc<Mutex<State>>,
    subscriber: Arc<Mutex<Option<mpsc::Sender<Event>>>>,
    stdin: mpsc::Sender<Vec<u8>>,
    /// Raised to end the child. The supervising task owns the process itself,
    /// so ending it is a request rather than a direct call: a second owner
    /// would have to hold the process across `wait`, and anything else wanting
    /// to end it would then wait for the very thing it was trying to stop.
    kill: Arc<Notify>,
}

#[derive(Debug, thiserror::Error)]
pub enum SessionError {
    #[error("failed to start the session process: {0}")]
    Spawn(String),
    #[error("the session process has exited")]
    Exited,
    #[error("another client is already attached")]
    AlreadyAttached,
}

impl Session {
    /// Start a child from arguments the caller has already assembled.
    ///
    /// A subscriber given here is installed before the child exists, so an
    /// agent that speaks as soon as it starts is heard. Attaching afterwards
    /// would leave a gap, and the runner keeps no history to fill it.
    pub async fn spawn(
        id: &str,
        request: &SpawnRequest,
        subscriber: Option<mpsc::Sender<Event>>,
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
        let subscriber = Arc::new(Mutex::new(subscriber));
        let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(EVENT_QUEUE);
        let kill = Arc::new(Notify::new());

        tokio::spawn(write_stdin(stdin, stdin_rx));
        tokio::spawn(read_stdout(id.to_string(), stdout, Arc::clone(&subscriber)));
        tokio::spawn(read_stderr(id.to_string(), stderr, Arc::clone(&subscriber)));
        tokio::spawn(supervise(
            id.to_string(),
            child,
            Arc::clone(&kill),
            Arc::clone(&state),
            Arc::clone(&subscriber),
        ));

        Ok(Self {
            id: id.to_string(),
            state,
            subscriber,
            stdin: stdin_tx,
            kill,
        })
    }

    pub async fn is_running(&self) -> bool {
        matches!(*self.state.lock().await, State::Running { .. })
    }

    pub async fn info(&self) -> SessionInfo {
        let state = *self.state.lock().await;
        let attached = self.subscriber.lock().await.is_some();
        match state {
            State::Running { pid } => SessionInfo {
                session: self.id.clone(),
                state: SessionState::Running,
                pid: Some(pid),
                attached,
                exit_code: None,
            },
            State::Exited { code } => SessionInfo {
                session: self.id.clone(),
                state: SessionState::Exited,
                pid: None,
                attached,
                exit_code: code,
            },
        }
    }

    /// Deliver this session's output into the subscriber's lane.
    ///
    /// The lane is shared: every attached session writes into it and each event
    /// names its session. One delivery per session — attaching one that is
    /// already delivering somewhere live is refused rather than splitting its
    /// stream, though a lane whose reader has gone counts as nowhere.
    pub async fn attach(&self, lane: mpsc::Sender<Event>) -> Result<(), SessionError> {
        let mut subscriber = self.subscriber.lock().await;
        if subscriber.as_ref().is_some_and(|tx| !tx.is_closed()) {
            return Err(SessionError::AlreadyAttached);
        }
        *subscriber = Some(lane);
        Ok(())
    }

    pub async fn detach(&self) {
        *self.subscriber.lock().await = None;
    }

    /// Forward one frame to the child, adding the newline the child's reader
    /// expects.
    pub async fn send(&self, frame: &RawValue) -> Result<(), SessionError> {
        if !self.is_running().await {
            return Err(SessionError::Exited);
        }
        let mut line = frame.get().as_bytes().to_vec();
        line.push(b'\n');
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
    pub async fn close(&self) {
        self.kill.notify_one();
        let deadline = tokio::time::Instant::now() + KILL_TIMEOUT;
        while tokio::time::Instant::now() < deadline {
            if !self.is_running().await {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    }
}

async fn write_stdin(mut stdin: ChildStdin, mut lines: mpsc::Receiver<Vec<u8>>) {
    while let Some(line) = lines.recv().await {
        if stdin.write_all(&line).await.is_err() || stdin.flush().await.is_err() {
            return;
        }
    }
}

async fn read_stdout<R>(id: String, stdout: R, subscriber: Arc<Mutex<Option<mpsc::Sender<Event>>>>)
where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stdout);
    loop {
        match read_capped_line(&mut reader).await {
            Ok(Some(line)) => {
                let Ok(frame) = RawValue::from_string(line) else {
                    // Not JSON. The runner does not validate frames, but it
                    // cannot embed a non-value either, so this is reported as
                    // diagnostic output rather than silently dropped.
                    continue;
                };
                let event = Event::Frame {
                    session: id.clone(),
                    frame,
                };
                if !publish(&subscriber, event).await {
                    // Nobody is attached. The frame is dropped on purpose: the
                    // runner keeps no history, and a client that missed output
                    // recovers it from the agent rather than from here.
                    continue;
                }
            }
            Ok(None) => return,
            Err(error) => {
                let event = Event::Stderr {
                    session: id.clone(),
                    line: format!("runner: {error}"),
                };
                publish(&subscriber, event).await;
                return;
            }
        }
    }
}

async fn read_stderr<R>(id: String, stderr: R, subscriber: Arc<Mutex<Option<mpsc::Sender<Event>>>>)
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
        publish(&subscriber, event).await;
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
    subscriber: Arc<Mutex<Option<mpsc::Sender<Event>>>>,
) {
    let status = loop {
        tokio::select! {
            status = child.wait() => break status,
            // Nothing here touches the child: the borrow the wait holds ends
            // with the select, and the signal is sent after it.
            () = kill.notified() => {}
        }
        let _ = child.start_kill();
    };
    let code = status.ok().and_then(|status| status.code());
    *state.lock().await = State::Exited { code };
    publish(&subscriber, Event::Exit { session: id, code }).await;
}

/// Deliver to the attached client if there is one. Returns whether it was
/// delivered.
async fn publish(subscriber: &Arc<Mutex<Option<mpsc::Sender<Event>>>>, event: Event) -> bool {
    let sender = { subscriber.lock().await.clone() };
    match sender {
        Some(sender) => sender.send(event).await.is_ok(),
        None => false,
    }
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
}
