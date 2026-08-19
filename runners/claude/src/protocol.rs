//! The wire contract between a client and the runner.
//!
//! Newline-delimited JSON in both directions. The envelope is deliberately
//! small: almost everything on this socket is a `claude` frame the runner is
//! only carrying, and every byte of ceremony wrapped around it is paid twice —
//! once to add and once to remove.
//!
//! Frames cross as [`RawValue`], so what the child produced reaches the client
//! byte for byte. That decides the shape of everything here: serde buffers a
//! value whenever a type is internally tagged or flattened, and a buffered
//! `RawValue` does not survive. So the wire types are flat structs with a
//! separate field naming the operation, and the meaning is recovered
//! immediately afterwards by converting them into the enums the rest of the
//! crate matches on.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;

/// Bumped when a client and runner built from different commits could otherwise
/// misread each other. The runner reports it on request; a client that does not
/// recognize it should refuse rather than guess.
pub const PROTOCOL_VERSION: u32 = 1;

/// What a client is asking for, once its wire form has been checked.
#[derive(Debug)]
pub enum Request {
    DaemonStatus,
    DaemonStop,
    /// Ensure a session exists. Idempotent: an existing live session is
    /// returned as-is and `spawn` is ignored, so a client that cannot tell
    /// whether a session survived its own restart may simply ask again.
    SessionCreate {
        session: String,
        spawn: SpawnRequest,
        /// Attach this connection as part of creating, closing the gap between
        /// a child starting and a client being ready to hear from it. An agent
        /// that speaks before it is spoken to would otherwise be talking to
        /// nobody.
        attach: bool,
    },
    SessionList,
    SessionClose {
        session: String,
    },
    /// Begin receiving this session's output on this connection. One client at
    /// a time; a second attach is refused rather than silently splitting the
    /// stream.
    SessionAttach {
        session: String,
    },
    /// Write one frame to the child's stdin. Valid only on a connection that
    /// has attached to that session.
    SessionSend {
        session: String,
        frame: Box<RawValue>,
    },
}

/// How to start the child, supplied entirely by the caller.
///
/// The runner does not read these values. It does not know which argument
/// selects a model, which resumes a conversation, or which enables the
/// permission callback — that knowledge belongs to the driver that builds them.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    /// Executable and arguments, already complete.
    pub argv: Vec<String>,
    /// Working directory for the child.
    pub cwd: String,
    /// Environment entries to add to the runner's own environment.
    pub env: BTreeMap<String, String>,
}

#[derive(Debug)]
pub struct Response {
    pub id: u64,
    pub outcome: Outcome,
}

#[derive(Debug)]
pub enum Outcome {
    Ok(ReplyBody),
    Err(ErrorBody),
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum ReplyBody {
    Daemon(DaemonStatus),
    Session(SessionInfo),
    Sessions { sessions: Vec<SessionInfo> },
    Empty {},
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ErrorBody {
    /// Stable machine-readable reason. Clients branch on this, never on
    /// `message`.
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// No session with that identifier.
    UnknownSession,
    /// Another connection is already attached to that session.
    AlreadyAttached,
    /// The operation requires an attached connection.
    NotAttached,
    /// The child could not be started.
    SpawnFailed,
    /// The child is no longer running.
    SessionExited,
    /// The request was not understood.
    BadRequest,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DaemonStatus {
    pub protocol_version: u32,
    pub runner_version: String,
    pub pid: u32,
    pub socket: String,
    pub sessions: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SessionInfo {
    pub session: String,
    pub state: SessionState,
    pub pid: Option<u32>,
    pub attached: bool,
    /// Present once the child has exited and the process reported a code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    Running,
    /// The child is gone. The session stays listed in this state until the
    /// client closes it, so a client that reconnects after the exit can still
    /// see that it happened.
    Exited,
}

/// Unsolicited output from the runner to an attached client.
#[derive(Debug)]
pub enum Event {
    /// One line the child wrote to stdout, verbatim.
    Frame {
        session: String,
        frame: Box<RawValue>,
    },
    /// One line the child wrote to stderr. Diagnostic only; the runner does not
    /// act on it.
    Stderr { session: String, line: String },
    /// The child exited. The session remains listed until it is closed.
    Exit { session: String, code: Option<i32> },
}

// ---------------------------------------------------------------------------
// Wire forms
//
// Flat by necessity, as the module header explains. Nothing outside this module
// matches on them.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    DaemonStatus,
    DaemonStop,
    SessionCreate,
    SessionList,
    SessionClose,
    SessionAttach,
    SessionSend,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WireRequest {
    pub id: u64,
    pub m: Method,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub attach: bool,
    #[serde(default, rename = "f", skip_serializing_if = "Option::is_none")]
    pub frame: Option<Box<RawValue>>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WireResponse {
    pub id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ok: Option<ReplyBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub err: Option<ErrorBody>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Frame,
    Stderr,
    Exit,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct WireEvent {
    pub t: EventKind,
    pub s: String,
    #[serde(default, rename = "f", skip_serializing_if = "Option::is_none")]
    pub frame: Option<Box<RawValue>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Request {
    /// Read a request, rejecting one whose method and fields disagree.
    ///
    /// Validation belongs here rather than in the dispatcher: the wire form
    /// allows combinations the protocol does not, and this is the one place
    /// that difference is resolved.
    pub fn from_wire(wire: WireRequest) -> Result<Self, String> {
        let session = || wire.session.clone().ok_or("session is required");
        Ok(match wire.m {
            Method::DaemonStatus => Self::DaemonStatus,
            Method::DaemonStop => Self::DaemonStop,
            Method::SessionList => Self::SessionList,
            Method::SessionClose => Self::SessionClose {
                session: session()?,
            },
            Method::SessionAttach => Self::SessionAttach {
                session: session()?,
            },
            Method::SessionSend => Self::SessionSend {
                session: session()?,
                frame: wire.frame.ok_or("f is required")?,
            },
            Method::SessionCreate => Self::SessionCreate {
                session: session()?,
                spawn: SpawnRequest {
                    argv: wire.argv.ok_or("argv is required")?,
                    cwd: wire.cwd.ok_or("cwd is required")?,
                    env: wire.env,
                },
                attach: wire.attach,
            },
        })
    }

    pub fn into_wire(self, id: u64) -> WireRequest {
        let blank = |m: Method| WireRequest {
            id,
            m,
            session: None,
            argv: None,
            cwd: None,
            env: BTreeMap::new(),
            attach: false,
            frame: None,
        };
        match self {
            Self::DaemonStatus => blank(Method::DaemonStatus),
            Self::DaemonStop => blank(Method::DaemonStop),
            Self::SessionList => blank(Method::SessionList),
            Self::SessionClose { session } => WireRequest {
                session: Some(session),
                ..blank(Method::SessionClose)
            },
            Self::SessionAttach { session } => WireRequest {
                session: Some(session),
                ..blank(Method::SessionAttach)
            },
            Self::SessionSend { session, frame } => WireRequest {
                session: Some(session),
                frame: Some(frame),
                ..blank(Method::SessionSend)
            },
            Self::SessionCreate {
                session,
                spawn,
                attach,
            } => WireRequest {
                session: Some(session),
                argv: Some(spawn.argv),
                cwd: Some(spawn.cwd),
                env: spawn.env,
                attach,
                ..blank(Method::SessionCreate)
            },
        }
    }
}

impl Response {
    pub fn into_wire(self) -> WireResponse {
        match self.outcome {
            Outcome::Ok(body) => WireResponse {
                id: self.id,
                ok: Some(body),
                err: None,
            },
            Outcome::Err(error) => WireResponse {
                id: self.id,
                ok: None,
                err: Some(error),
            },
        }
    }
}

impl Event {
    pub fn into_wire(self) -> WireEvent {
        let blank = |t: EventKind, s: String| WireEvent {
            t,
            s,
            frame: None,
            line: None,
            code: None,
        };
        match self {
            Self::Frame { session, frame } => WireEvent {
                frame: Some(frame),
                ..blank(EventKind::Frame, session)
            },
            Self::Stderr { session, line } => WireEvent {
                line: Some(line),
                ..blank(EventKind::Stderr, session)
            },
            Self::Exit { session, code } => WireEvent {
                code,
                ..blank(EventKind::Exit, session)
            },
        }
    }
}

/// Whether a line is session output rather than a reply to a request.
///
/// Decided by a pass that skips every other field, so a client can tell the two
/// apart without reading a frame it has no use for. Deserializing into a value
/// that could be either would buffer the frame and defeat the point of carrying
/// it raw.
pub fn carries_event(line: &str) -> Result<bool, serde_json::Error> {
    #[derive(Deserialize)]
    struct Discriminant {
        #[serde(default)]
        t: Option<EventKind>,
    }

    let discriminant: Discriminant = serde_json::from_str(line)?;
    Ok(discriminant.t.is_some())
}

impl Response {
    pub fn from_wire(wire: WireResponse) -> Self {
        let outcome = match (wire.ok, wire.err) {
            (_, Some(error)) => Outcome::Err(error),
            (Some(body), None) => Outcome::Ok(body),
            (None, None) => Outcome::Ok(ReplyBody::Empty {}),
        };
        Self {
            id: wire.id,
            outcome,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frame the runner is asked to carry, written so that any rewriting
    /// shows up: unusual spacing, a trailing zero, and a key order no
    /// serializer would choose.
    const AWKWARD_FRAME: &str = r#"{"type":"assistant","n":1.50,"z":"","a":{"b":[1,2]}}"#;

    #[test]
    fn a_frame_survives_being_sent_and_read_back() {
        // Both directions matter, and they fail differently: serde rewrites a
        // frame on the way out if the type is tagged, and refuses to read one
        // on the way back in.
        let sent = Request::SessionSend {
            session: "s1".to_string(),
            frame: RawValue::from_string(AWKWARD_FRAME.to_string()).expect("frame"),
        };

        let encoded = serde_json::to_string(&sent.into_wire(1)).expect("encode");
        let decoded = Request::from_wire(serde_json::from_str(&encoded).expect("decode"))
            .expect("a valid request");

        let Request::SessionSend { frame, .. } = decoded else {
            panic!("wrong request");
        };
        assert_eq!(frame.get(), AWKWARD_FRAME);
    }

    #[test]
    fn an_event_carries_a_frame_out_and_back_unchanged() {
        let event = Event::Frame {
            session: "s1".to_string(),
            frame: RawValue::from_string(AWKWARD_FRAME.to_string()).expect("frame"),
        };

        let encoded = serde_json::to_string(&event.into_wire()).expect("encode");
        let decoded: WireEvent = serde_json::from_str(&encoded).expect("decode");

        assert!(carries_event(&encoded).expect("classify"));
        assert_eq!(decoded.frame.expect("a frame").get(), AWKWARD_FRAME);
    }

    #[test]
    fn a_reply_and_an_event_are_told_apart() {
        let reply = serde_json::to_string(
            &Response {
                id: 4,
                outcome: Outcome::Ok(ReplyBody::Empty {}),
            }
            .into_wire(),
        )
        .expect("encode reply");
        let event = serde_json::to_string(
            &Event::Exit {
                session: "s1".to_string(),
                code: Some(2),
            }
            .into_wire(),
        )
        .expect("encode event");

        assert!(!carries_event(&reply).expect("classify reply"));
        assert!(carries_event(&event).expect("classify event"));
    }

    #[test]
    fn an_error_reply_reads_back_as_a_failure() {
        let encoded = serde_json::to_string(
            &Response {
                id: 1,
                outcome: Outcome::Err(ErrorBody {
                    code: ErrorCode::UnknownSession,
                    message: "no such session".to_string(),
                }),
            }
            .into_wire(),
        )
        .expect("encode");

        let wire: WireResponse = serde_json::from_str(&encoded).expect("decode");
        let Response { outcome, .. } = Response::from_wire(wire);
        assert!(matches!(
            outcome,
            Outcome::Err(ErrorBody {
                code: ErrorCode::UnknownSession,
                ..
            })
        ));
    }

    #[test]
    fn spawn_arguments_survive_a_round_trip_unread() {
        let request = Request::SessionCreate {
            session: "s1".to_string(),
            spawn: SpawnRequest {
                argv: vec![
                    "claude".to_string(),
                    "--resume".to_string(),
                    "abc".to_string(),
                ],
                cwd: "/tmp".to_string(),
                env: BTreeMap::new(),
            },
            attach: true,
        };

        let encoded = serde_json::to_string(&request.into_wire(2)).expect("encode");
        let decoded = Request::from_wire(serde_json::from_str(&encoded).expect("decode"))
            .expect("a valid request");

        let Request::SessionCreate { spawn, attach, .. } = decoded else {
            panic!("wrong request");
        };
        assert_eq!(spawn.argv, ["claude", "--resume", "abc"]);
        assert!(attach);
    }

    #[test]
    fn a_request_missing_a_field_its_method_needs_is_rejected() {
        // The wire form can express combinations the protocol does not, so the
        // conversion has to be the place that refuses them.
        let wire: WireRequest =
            serde_json::from_str(r#"{"id":1,"m":"session_send","session":"s1"}"#).expect("decode");

        let rejected = Request::from_wire(wire).expect_err("a frame is required");

        assert!(rejected.contains('f'), "{rejected}");
    }
}
