//! Talking to a running runner.
//!
//! Used by this crate's own command line, and shaped so the Caffold backend can
//! reuse the same request and response types rather than re-deriving them.

use std::path::Path;

use serde_json::value::RawValue;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};

use crate::protocol::{
    ErrorBody, Outcome, ReplyBody, Request, Response, SessionInfo, WireResponse, carries_event,
};

pub struct Client {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
    next_id: u64,
}

/// An attached connection, split so that reading a session's output and writing
/// to it can proceed at the same time.
pub struct Streaming {
    pub reader: BufReader<OwnedReadHalf>,
    pub frames: FrameWriter,
}

/// The writing half of an attached connection. It remembers the session,
/// because a connection attaches to exactly one.
pub struct FrameWriter {
    writer: OwnedWriteHalf,
    session: String,
    next_id: u64,
}

impl Client {
    pub async fn connect(socket: &Path) -> anyhow::Result<Self> {
        let stream = UnixStream::connect(socket).await.map_err(|error| {
            anyhow::anyhow!(
                "no runner at {}: {error}. Start one with `daemon start`.",
                socket.display()
            )
        })?;
        let (reader, writer) = stream.into_split();
        Ok(Self {
            reader: BufReader::new(reader),
            writer,
            next_id: 1,
        })
    }

    /// Send one request and wait for its reply.
    pub async fn request(&mut self, request: Request) -> anyhow::Result<ReplyBody> {
        let id = self.next_id;
        self.next_id += 1;
        self.writer.write_all(&encode(request, id)?).await?;
        self.writer.flush().await?;
        self.await_reply(id).await
    }

    async fn await_reply(&mut self, id: u64) -> anyhow::Result<ReplyBody> {
        let mut line = String::new();
        loop {
            line.clear();
            if self.reader.read_line(&mut line).await? == 0 {
                anyhow::bail!("the runner closed the connection");
            }
            let trimmed = line.trim();
            // Session output belongs to whatever attached; a caller waiting on
            // a reply is not the one that can act on it.
            if carries_event(trimmed)? {
                continue;
            }
            let wire: WireResponse = serde_json::from_str(trimmed)?;
            let Response {
                id: replied,
                outcome,
            } = Response::from_wire(wire);
            if replied != id {
                continue;
            }
            return match outcome {
                Outcome::Ok(body) => Ok(body),
                Outcome::Err(error) => Err(describe(&error)),
            };
        }
    }

    /// Create a session and attach to it in one request, then hand back the
    /// split connection.
    ///
    /// Creating and attaching separately would leave a gap in which the child
    /// is running and nothing is listening. The runner holds no history, so
    /// anything it said in that gap would be gone.
    pub async fn create_attached(
        mut self,
        session: &str,
        spawn: crate::protocol::SpawnRequest,
    ) -> anyhow::Result<(SessionInfo, Streaming)> {
        let reply = self
            .request(Request::SessionCreate {
                session: session.to_string(),
                spawn,
                attach: true,
            })
            .await?;
        self.into_streaming(session, reply)
    }

    /// Take over an existing session's output.
    ///
    /// The handshake is awaited here rather than left to the stream so a
    /// refusal — an unknown session, or one another client already holds —
    /// surfaces as an error instead of a connection that silently carries
    /// nothing.
    pub async fn attach(mut self, session: &str) -> anyhow::Result<(SessionInfo, Streaming)> {
        let reply = self
            .request(Request::SessionAttach {
                session: session.to_string(),
            })
            .await?;
        self.into_streaming(session, reply)
    }

    fn into_streaming(
        self,
        session: &str,
        reply: ReplyBody,
    ) -> anyhow::Result<(SessionInfo, Streaming)> {
        let ReplyBody::Session(info) = reply else {
            anyhow::bail!("the runner answered an attach with something else");
        };
        Ok((
            info,
            Streaming {
                reader: self.reader,
                frames: FrameWriter {
                    writer: self.writer,
                    session: session.to_string(),
                    next_id: self.next_id,
                },
            },
        ))
    }
}

impl FrameWriter {
    /// Write one frame to the attached session. Its reply arrives on the read
    /// half alongside the session's own output.
    pub async fn send(&mut self, frame: Box<RawValue>) -> anyhow::Result<()> {
        let id = self.next_id;
        self.next_id += 1;
        let request = Request::SessionSend {
            session: self.session.clone(),
            frame,
        };
        self.writer.write_all(&encode(request, id)?).await?;
        self.writer.flush().await?;
        Ok(())
    }
}

fn encode(request: Request, id: u64) -> anyhow::Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(&request.into_wire(id))?;
    encoded.push(b'\n');
    Ok(encoded)
}

/// Render an error reply with its machine-readable code intact, so a script
/// reading stderr can branch on the same value a program would.
fn describe(error: &ErrorBody) -> anyhow::Error {
    let code = serde_json::to_string(&error.code).unwrap_or_default();
    anyhow::anyhow!("{}: {}", code.trim_matches('"'), error.message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::ErrorCode;

    #[test]
    fn a_request_carries_its_identifier_beside_the_method() {
        let encoded = encode(Request::DaemonStatus, 7).expect("encode");
        let line = String::from_utf8(encoded).expect("utf-8");

        assert!(line.contains(r#""id":7"#), "{line}");
        assert!(line.contains(r#""m":"daemon_status""#), "{line}");
        assert!(line.ends_with('\n'), "requests must be newline terminated");
    }

    #[test]
    fn an_error_keeps_the_code_a_caller_can_branch_on() {
        // The message is for a person; the code is the part a script matches,
        // so it has to survive into the rendered error.
        let rendered = describe(&ErrorBody {
            code: ErrorCode::AlreadyAttached,
            message: "another client is already attached".to_string(),
        })
        .to_string();

        assert!(rendered.starts_with("already_attached:"), "{rendered}");
    }
}
