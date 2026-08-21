//! The long-lived half: a unix socket, a registry of sessions, and the accept
//! loop that connects the two.
//!
//! The runner outlives its clients by design, so nothing here is tied to a
//! connection. A client attaches, disappears, and attaches again; the children
//! it started keep running throughout.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Mutex, Notify, mpsc};

use crate::protocol::{
    DaemonStatus, ErrorBody, ErrorCode, Event, Outcome, PROTOCOL_VERSION, ReplyBody, Request,
    Response, SessionInfo, SpawnRequest, WireRequest,
};
use crate::session::{EVENT_QUEUE, Session, SessionError};

mod leftovers;

use leftovers::Leftovers;

/// Requests are small; a client that sends a much larger one is malfunctioning.
/// A frame bound for a child may be large, so this has to clear the session
/// line limit rather than sit under it.
const MAX_REQUEST_BYTES: usize = crate::session::MAX_LINE_BYTES + 4096;

pub struct Runner {
    socket: PathBuf,
    sessions: Mutex<BTreeMap<String, Arc<Session>>>,
    /// The children this runner is answerable for, written where the next
    /// runner can find them if this one does not get to end them itself.
    leftovers: Leftovers,
    shutdown: Notify,
}

/// What one connection is currently doing. A connection may attach to at most
/// one session, and only an attached connection may write to it.
struct Connection {
    writer: Arc<Mutex<OwnedWriteHalf>>,
    attached: Option<String>,
    pump: Option<tokio::task::JoinHandle<()>>,
}

impl Runner {
    pub fn new(socket: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            leftovers: Leftovers::beside(&socket),
            socket,
            sessions: Mutex::new(BTreeMap::new()),
            shutdown: Notify::new(),
        })
    }

    /// Serve until asked to stop.
    pub async fn serve(self: Arc<Self>, listener: UnixListener) -> anyhow::Result<()> {
        // Before a single client is answered. A runner that starts owns nothing
        // from before: anything the last one left is unreachable, and telling a
        // client there is no session for a conversation an unreachable process
        // is still writing to would put a second agent on it.
        self.leftovers.clear().await;

        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (stream, _) = accepted?;
                    let runner = Arc::clone(&self);
                    tokio::spawn(async move {
                        if let Err(error) = runner.serve_connection(stream).await {
                            eprintln!("connection ended: {error}");
                        }
                    });
                }
                () = self.shutdown.notified() => break,
            }
        }

        // Children do not outlive the runner that supervises them: nothing
        // would be able to reach them afterwards, and they would hold a
        // conversation open that no client could join.
        for session in self.sessions.lock().await.values() {
            self.close_and_forget(session).await;
        }
        let _ = tokio::fs::remove_file(&self.socket).await;
        Ok(())
    }

    async fn serve_connection(self: Arc<Self>, stream: UnixStream) -> anyhow::Result<()> {
        let (reader, writer) = stream.into_split();
        let mut connection = Connection {
            writer: Arc::new(Mutex::new(writer)),
            attached: None,
            pump: None,
        };
        let mut reader = BufReader::new(reader);

        let mut line = String::new();
        loop {
            line.clear();
            if read_request_line(&mut reader, &mut line).await? == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let response = self.answer(trimmed, &mut connection).await;
            write_response(&connection.writer, response).await?;
        }

        if let Some(pump) = connection.pump.take() {
            pump.abort();
        }
        if let Some(session) = connection.attached
            && let Some(session) = self.sessions.lock().await.get(&session)
        {
            session.detach().await;
        }
        Ok(())
    }

    /// Answer one line. A line that does not parse still gets a reply, because
    /// a client waiting on one it will never receive is worse than an error.
    async fn answer(self: &Arc<Self>, line: &str, connection: &mut Connection) -> Response {
        let wire: WireRequest = match serde_json::from_str(line) {
            Ok(wire) => wire,
            Err(error) => return bad_request(request_id(line), error.to_string()),
        };
        let id = wire.id;
        let request = match Request::from_wire(wire) {
            Ok(request) => request,
            Err(reason) => return bad_request(id, reason),
        };
        Response {
            id,
            outcome: self.dispatch(request, connection).await,
        }
    }

    async fn dispatch(self: &Arc<Self>, request: Request, connection: &mut Connection) -> Outcome {
        match request {
            Request::DaemonStatus => Outcome::Ok(ReplyBody::Daemon(self.status().await)),
            Request::DaemonStop => {
                self.shutdown.notify_waiters();
                Outcome::Ok(ReplyBody::Empty {})
            }
            Request::SessionList => {
                let mut sessions = Vec::new();
                for session in self.sessions.lock().await.values() {
                    sessions.push(session.info().await);
                }
                Outcome::Ok(ReplyBody::Sessions { sessions })
            }
            Request::SessionCreate {
                session,
                spawn,
                attach,
            } => match self.ensure(&session, spawn, attach, connection).await {
                Ok(info) => Outcome::Ok(ReplyBody::Session(info)),
                Err(error) => Outcome::Err(error),
            },
            Request::SessionClose { session } => {
                // Idempotent: what was asked for is that this session not be
                // running, and one the runner does not have is not running.
                // A client cannot know whether a session it never opened was
                // started by an earlier one of itself.
                if let Some(removed) = self.sessions.lock().await.remove(&session) {
                    self.close_and_forget(&removed).await;
                }
                Outcome::Ok(ReplyBody::Empty {})
            }
            Request::SessionAttach { session } => match self.attach(&session, connection).await {
                Ok(info) => Outcome::Ok(ReplyBody::Session(info)),
                Err(error) => Outcome::Err(error),
            },
            Request::SessionSend { session, frame } => {
                if connection.attached.as_deref() != Some(session.as_str()) {
                    return Outcome::Err(ErrorBody {
                        code: ErrorCode::NotAttached,
                        message: "attach to the session before sending".to_string(),
                    });
                }
                let held = self.sessions.lock().await.get(&session).cloned();
                match held {
                    None => Outcome::Err(unknown_session(&session)),
                    Some(held) => match held.send(&frame).await {
                        Ok(()) => Outcome::Ok(ReplyBody::Empty {}),
                        Err(error) => Outcome::Err(session_error(error)),
                    },
                }
            }
        }
    }

    async fn status(&self) -> DaemonStatus {
        DaemonStatus {
            protocol_version: PROTOCOL_VERSION,
            runner_version: env!("CARGO_PKG_VERSION").to_string(),
            pid: std::process::id(),
            socket: self.socket.display().to_string(),
            sessions: self.sessions.lock().await.len(),
        }
    }

    /// Idempotent: a live session is returned untouched. A client that cannot
    /// tell whether its session survived its own restart simply asks again,
    /// which is the same shape as asking the runner to start.
    ///
    /// Attaching happens before the child is started, not after it exists, so
    /// an agent that speaks immediately is still heard.
    async fn ensure(
        self: &Arc<Self>,
        id: &str,
        spawn: SpawnRequest,
        attach: bool,
        connection: &mut Connection,
    ) -> Result<SessionInfo, ErrorBody> {
        let mut sessions = self.sessions.lock().await;
        if let Some(existing) = sessions.get(id)
            && existing.is_running().await
        {
            let existing = Arc::clone(existing);
            drop(sessions);
            if attach {
                self.begin_pump(id, &existing, connection).await?;
            }
            return Ok(existing.info().await);
        }

        let subscriber = attach.then(|| mpsc::channel(EVENT_QUEUE));
        let (sender, receiver) = match subscriber {
            Some((sender, receiver)) => (Some(sender), Some(receiver)),
            None => (None, None),
        };
        // An exited session is replaced rather than reported: the caller asked
        // for a session, and the arguments it supplied say how to get one back.
        let session = Arc::new(
            Session::spawn(id, &spawn, sender)
                .await
                .map_err(session_error)?,
        );
        let info = session.info().await;
        // Written down before the session is handed out, so a runner that dies
        // in the next instant still leaves a child its successor knows to end.
        if let Some(pid) = info.pid {
            self.leftovers.remember(pid).await;
        }
        sessions.insert(id.to_string(), Arc::clone(&session));
        drop(sessions);

        if let Some(receiver) = receiver {
            connection.attached = Some(id.to_string());
            connection.pump = Some(tokio::spawn(pump_events(
                receiver,
                Arc::clone(&connection.writer),
            )));
        }
        Ok(info)
    }

    /// End a child and stop being answerable for it.
    ///
    /// The number is read before the ending, because a session that has ended
    /// no longer answers with one — and a record looked up afterwards would
    /// never be found, leaving the book to grow until the next runner starts.
    async fn close_and_forget(&self, session: &Arc<Session>) {
        let pid = session.info().await.pid;
        session.close().await;
        if let Some(pid) = pid {
            self.leftovers.forget(pid).await;
        }
    }

    async fn attach(
        self: &Arc<Self>,
        id: &str,
        connection: &mut Connection,
    ) -> Result<SessionInfo, ErrorBody> {
        let session = self
            .sessions
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| unknown_session(id))?;
        self.begin_pump(id, &session, connection).await?;
        Ok(session.info().await)
    }

    async fn begin_pump(
        self: &Arc<Self>,
        id: &str,
        session: &Arc<Session>,
        connection: &mut Connection,
    ) -> Result<(), ErrorBody> {
        let events = session.attach().await.map_err(session_error)?;
        if let Some(previous) = connection.pump.take() {
            previous.abort();
        }
        connection.attached = Some(id.to_string());
        connection.pump = Some(tokio::spawn(pump_events(
            events,
            Arc::clone(&connection.writer),
        )));
        Ok(())
    }
}

async fn pump_events(mut events: mpsc::Receiver<Event>, writer: Arc<Mutex<OwnedWriteHalf>>) {
    while let Some(event) = events.recv().await {
        if write_line(&writer, &event.into_wire()).await.is_err() {
            return;
        }
    }
}

async fn write_response(
    writer: &Arc<Mutex<OwnedWriteHalf>>,
    response: Response,
) -> std::io::Result<()> {
    write_line(writer, &response.into_wire()).await
}

async fn write_line<T: serde::Serialize>(
    writer: &Arc<Mutex<OwnedWriteHalf>>,
    value: &T,
) -> std::io::Result<()> {
    let mut encoded = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    encoded.push(b'\n');
    let mut writer = writer.lock().await;
    writer.write_all(&encoded).await?;
    writer.flush().await
}

async fn read_request_line<R>(
    reader: &mut BufReader<R>,
    line: &mut String,
) -> std::io::Result<usize>
where
    R: tokio::io::AsyncRead + Unpin,
{
    let read = reader
        .take(MAX_REQUEST_BYTES as u64)
        .read_line(line)
        .await?;
    if read >= MAX_REQUEST_BYTES {
        return Err(std::io::Error::other("request line exceeded the limit"));
    }
    Ok(read)
}

/// Recover the `id` from a line that did not parse, so a malformed request is
/// still answered with something the client can correlate.
fn request_id(line: &str) -> u64 {
    #[derive(serde::Deserialize)]
    struct Identified {
        #[serde(default)]
        id: u64,
    }
    serde_json::from_str::<Identified>(line)
        .map(|identified| identified.id)
        .unwrap_or_default()
}

fn bad_request(id: u64, message: String) -> Response {
    Response {
        id,
        outcome: Outcome::Err(ErrorBody {
            code: ErrorCode::BadRequest,
            message,
        }),
    }
}

fn unknown_session(id: &str) -> ErrorBody {
    ErrorBody {
        code: ErrorCode::UnknownSession,
        message: format!("no session {id}"),
    }
}

fn session_error(error: SessionError) -> ErrorBody {
    let code = match error {
        SessionError::Spawn(_) => ErrorCode::SpawnFailed,
        SessionError::Exited => ErrorCode::SessionExited,
        SessionError::AlreadyAttached => ErrorCode::AlreadyAttached,
    };
    ErrorBody {
        code,
        message: error.to_string(),
    }
}

/// Claim the socket, clearing a path left behind by a runner that did not shut
/// down cleanly.
///
/// A leftover socket file is not evidence of a live runner, and treating it as
/// one would leave the user unable to start a runner again after a crash. A
/// successful connection is evidence, so that is what is tested.
pub async fn bind(socket: &Path) -> anyhow::Result<UnixListener> {
    if socket.exists() {
        if UnixStream::connect(socket).await.is_ok() {
            anyhow::bail!("a runner is already listening on {}", socket.display());
        }
        tokio::fs::remove_file(socket).await?;
    }
    if let Some(parent) = socket.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    Ok(UnixListener::bind(socket)?)
}

/// Whether a runner is answering on this socket.
pub async fn is_running(socket: &Path) -> bool {
    UnixStream::connect(socket).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_malformed_line_still_yields_the_identifier_it_carried() {
        // The reply has to be correlatable even when the rest of the request
        // was not understood.
        assert_eq!(request_id(r#"{"id":9,"m":"nonsense"}"#), 9);
    }

    #[test]
    fn a_line_without_an_identifier_falls_back_rather_than_failing() {
        assert_eq!(request_id("not json at all"), 0);
        assert_eq!(request_id(r#"{"m":"daemon_status"}"#), 0);
    }

    #[tokio::test]
    async fn binding_refuses_a_socket_a_live_runner_holds() {
        let directory = std::env::temp_dir().join(format!("runner-bind-{}", std::process::id()));
        tokio::fs::create_dir_all(&directory).await.expect("create");
        let socket = directory.join("claude-runner.sock");

        let _held = bind(&socket).await.expect("first bind");
        let refused = bind(&socket).await.expect_err("second bind");

        assert!(refused.to_string().contains("already listening"));
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }

    #[tokio::test]
    async fn binding_reclaims_a_socket_no_runner_is_holding() {
        let directory = std::env::temp_dir().join(format!("runner-stale-{}", std::process::id()));
        tokio::fs::create_dir_all(&directory).await.expect("create");
        let socket = directory.join("claude-runner.sock");
        tokio::fs::write(&socket, b"").await.expect("leave a file");

        let listener = bind(&socket).await.expect("reclaim");

        assert!(listener.local_addr().is_ok());
        let _ = tokio::fs::remove_dir_all(&directory).await;
    }
}
