//! ACP DTOs and the native instruction carriers Caffold actually uses.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::AntigravityError;
use crate::agent::{CAFFOLD_CLARIFICATION_FEEDBACK, CAFFOLD_SESSION_INSTRUCTIONS};

pub(super) const MODEL: &str = "model";
pub(super) const THINKING: &str = "thought_level";
pub(super) const MODE: &str = "mode";

const FIRST_TURN: &str = "On the first ordinary user request, use the Caffold MCP server's rename_current_task tool to give this Task a concise name for that work. Do this once, then continue the user's request.";

pub(super) fn initialize() -> Value {
    json!({"protocolVersion":1,"clientInfo":{"name":"caffold","title":"Caffold","version":env!("CARGO_PKG_VERSION")},"clientCapabilities":{}})
}

pub(super) fn session_meta(first: bool) -> Value {
    let mut instructions =
        format!("{CAFFOLD_SESSION_INSTRUCTIONS}\n\n{CAFFOLD_CLARIFICATION_FEEDBACK}");
    if first {
        instructions.push_str("\n\n");
        instructions.push_str(FIRST_TURN);
    }
    json!({"antigravity":{"disabledTools":["ask_question"],"systemPrompt":{"append":instructions}}})
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConfigOption {
    pub(super) id: String,
    pub(super) current_value: String,
    pub(super) options: Vec<ConfigChoice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct ConfigChoice {
    pub(super) value: String,
    pub(super) name: String,
    #[serde(default)]
    pub(super) description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionState {
    pub(super) session_id: String,
    pub(super) config_options: Vec<ConfigOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConfigResult {
    pub(super) config_options: Vec<ConfigOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(untagged)]
pub(super) enum RpcId {
    Number(i64),
    String(String),
}

impl RpcId {
    pub(super) fn key(&self) -> String {
        match self {
            Self::Number(value) => format!("n:{value}"),
            Self::String(value) => format!(
                "s:{}",
                value
                    .as_bytes()
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            ),
        }
    }
}

pub(super) fn required_string<'a>(
    value: &'a Value,
    field: &str,
) -> Result<&'a str, AntigravityError> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AntigravityError::Protocol(format!("missing {field}")))
}

pub(super) fn config<'a>(
    options: &'a [ConfigOption],
    id: &str,
) -> Result<&'a ConfigOption, AntigravityError> {
    options
        .iter()
        .find(|option| option.id == id)
        .ok_or_else(|| AntigravityError::Protocol(format!("missing native config option {id}")))
}
