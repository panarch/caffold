//! Private protocol between Caffold and the Task process it leaves with the runner.

use crate::agent::approval::{ApprovalDecision, ApprovalSource};
use crate::agent::driver::TurnOptions;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(super) const VERSION: u8 = 1;

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Request {
    pub version: u8,
    pub id: String,
    pub operation: Operation,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct OpenSession {
    pub session: String,
    pub cwd: String,
    pub create: bool,
    #[serde(default)]
    pub persist: bool,
    pub first: bool,
    pub binding: String,
    pub endpoint: String,
    pub settings: TurnOptions,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum Operation {
    Open(OpenSession),
    Inspect,
    Send {
        prompt: String,
        images: Vec<String>,
        target: Option<String>,
        settings: Option<TurnOptions>,
    },
    Stop,
    Decide {
        request: String,
        decision: ApprovalDecision,
        source: ApprovalSource,
    },
    PrepareIsolation,
    FinishIsolation {
        destination: Option<String>,
    },
    Move {
        cwd: String,
    },
    Rename {
        name: String,
    },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(super) enum Output {
    Event {
        event: copilot_sdk::SessionEvent,
    },
    Reply {
        id: String,
        result: Result<Value, Failure>,
    },
    Background {
        active: bool,
    },
    Usage {
        turn: String,
        usage: super::usage::Usage,
    },
    ObservationLost {
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum Failure {
    Missing(String),
    TurnGone,
    TurnRunning,
    Held(String),
    Failed(String),
}

impl From<copilot_sdk::Error> for Failure {
    fn from(error: copilot_sdk::Error) -> Self {
        if let copilot_sdk::ErrorKind::Session(copilot_sdk::SessionErrorKind::NotFound(id)) =
            error.kind()
        {
            return Self::Missing(id.to_string());
        }
        Self::Failed(error.to_string())
    }
}

impl From<serde_json::Error> for Failure {
    fn from(error: serde_json::Error) -> Self {
        Self::Failed(error.to_string())
    }
}

impl From<Failure> for crate::agent::AgentError {
    fn from(error: Failure) -> Self {
        match error {
            Failure::Missing(id) => {
                Self::ConversationGone(format!("Copilot could not resume session {id}."))
            }
            Failure::TurnGone => {
                Self::TurnGone("The Copilot turn ended before the message was submitted.".into())
            }
            Failure::TurnRunning => Self::TurnRunning("Copilot already has a running turn.".into()),
            Failure::Held(message) => Self::Held(message),
            Failure::Failed(message) => Self::Failed(message),
        }
    }
}
