//! What the Grok leader says over its stdio bridge, and what Caffold says back.
//!
//! The wire is JSON-RPC in the Agent Client Protocol shape plus Grok's own
//! `_x.ai/*` methods and `_x.ai/*` notifications. Every type here reads the
//! fields Caffold acts on and lets the rest through: an update kind this
//! release does not know becomes [`Update::Other`] rather than a parse
//! failure, and a load-bearing field that is missing fails where it is read.
//!
//! The values were taken from live answers of `grok 1.0.30`; the fixtures
//! beside this module are those answers verbatim.

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{Value, json};

/// The JSON-RPC protocol version the leader speaks.
pub(super) const PROTOCOL_VERSION: u64 = 1;

/// One line from the bridge, sorted by what it asks of the reader.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Frame {
    /// An answer to something Caffold asked.
    Response {
        id: u64,
        result: Result<Value, RpcError>,
    },
    /// Something the leader tells without asking.
    Notification { method: String, params: Value },
    /// Something the leader asks and waits on.
    ServerRequest {
        id: Value,
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(super) struct RpcError {
    pub(super) code: i64,
    pub(super) message: String,
    #[serde(default)]
    pub(super) data: Value,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.data {
            Value::Null => write!(f, "{} (code {})", self.message, self.code),
            Value::String(detail) => write!(f, "{}: {detail} (code {})", self.message, self.code),
            other => write!(f, "{}: {other} (code {})", self.message, self.code),
        }
    }
}

impl RpcError {
    /// Whether the leader could not find the session's files where it was
    /// told to look, which is how a conversation that is gone answers.
    pub(super) fn is_path_not_found(&self) -> bool {
        self.data.get("code").and_then(Value::as_str) == Some("FS_NOT_FOUND")
            || self.message.contains("Path not found")
    }
}

/// Sort one decoded line. Lines that are not JSON objects are not frames.
pub(super) fn read_frame(line: &str) -> Option<Frame> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;
    let method = object.get("method").and_then(Value::as_str);
    let id = object.get("id");
    match (method, id) {
        (Some(method), Some(id)) => Some(Frame::ServerRequest {
            id: id.clone(),
            method: method.to_string(),
            params: object.get("params").cloned().unwrap_or(Value::Null),
        }),
        (Some(method), None) => Some(Frame::Notification {
            method: method.to_string(),
            params: object.get("params").cloned().unwrap_or(Value::Null),
        }),
        (None, Some(id)) => {
            let id = id.as_u64()?;
            let result = match object.get("error") {
                Some(error) => Err(serde_json::from_value(error.clone()).unwrap_or(RpcError {
                    code: -1,
                    message: error.to_string(),
                    data: Value::Null,
                })),
                None => Ok(object.get("result").cloned().unwrap_or(Value::Null)),
            };
            Some(Frame::Response { id, result })
        }
        (None, None) => None,
    }
}

pub(super) fn request(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

pub(super) fn notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub(super) fn response(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub(super) fn error_response(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

// ---------------------------------------------------------------------------
// initialize and the model catalog
// ---------------------------------------------------------------------------

pub(super) fn initialize_params() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "clientCapabilities": {
            "fs": { "readTextFile": false, "writeTextFile": false },
            "terminal": false
        },
        "clientInfo": { "name": "caffold", "version": env!("CARGO_PKG_VERSION") }
    })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InitializeResult {
    #[serde(rename = "_meta", default)]
    pub(super) meta: InitializeMeta,
    #[serde(rename = "authMethods", default)]
    pub(super) auth_methods: Vec<AuthMethod>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InitializeMeta {
    #[serde(default)]
    pub(super) model_state: Option<ModelState>,
    #[serde(default)]
    pub(super) agent_version: Option<String>,
    #[serde(default)]
    pub(super) default_auth_method_id: Option<String>,
}

/// One way the agent can be signed in, as `initialize` lists them.
#[derive(Debug, Clone, Deserialize)]
pub(super) struct AuthMethod {
    pub(super) id: String,
    #[serde(default)]
    pub(super) name: Option<String>,
}

/// The model catalog, as `initialize`, `_x.ai/models/list`, `session/new`
/// and `session/load` all report it.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelState {
    #[serde(default)]
    pub(super) current_model_id: Option<String>,
    #[serde(default)]
    pub(super) available_models: Vec<ModelInfo>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelInfo {
    pub(super) model_id: String,
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) description: Option<String>,
    #[serde(rename = "_meta", default)]
    pub(super) meta: ModelMeta,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ModelMeta {
    #[serde(default)]
    pub(super) total_context_tokens: Option<u64>,
    #[serde(default)]
    pub(super) supports_reasoning_effort: bool,
    /// The effort this installation starts a session at: the configured
    /// default, which is not always the model's own.
    #[serde(default)]
    pub(super) reasoning_effort: Option<String>,
    #[serde(default)]
    pub(super) reasoning_efforts: Vec<EffortInfo>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EffortInfo {
    pub(super) value: String,
    #[serde(default)]
    pub(super) label: Option<String>,
}

/// `_x.ai/models/list` wraps the state once more.
#[derive(Debug, Clone, Deserialize)]
pub(super) struct ModelsListResult {
    pub(super) result: ModelState,
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

/// What `session/new` needs, given what Caffold decided.
pub(super) struct NewSession<'a> {
    pub(super) session_id: &'a str,
    pub(super) cwd: &'a str,
    pub(super) mcp_servers: Vec<Value>,
    pub(super) rules: Option<&'a str>,
    pub(super) mode: PermissionMode,
}

/// The ways Grok can be let to work, chosen when a session starts.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) enum PermissionMode {
    /// Grok asks before anything its own policy does not allow.
    #[default]
    Ask,
    /// Grok decides for itself, asking nobody.
    Auto,
    /// Everything is allowed.
    Bypass,
}

impl PermissionMode {
    pub(super) const ASK: &'static str = "default";
    pub(super) const AUTO: &'static str = "auto";
    pub(super) const BYPASS: &'static str = "bypass";

    pub(super) fn name(self) -> &'static str {
        match self {
            Self::Ask => Self::ASK,
            Self::Auto => Self::AUTO,
            Self::Bypass => Self::BYPASS,
        }
    }

    pub(super) fn from_name(name: &str) -> Option<Self> {
        match name {
            Self::ASK => Some(Self::Ask),
            Self::AUTO => Some(Self::Auto),
            Self::BYPASS => Some(Self::Bypass),
            _ => None,
        }
    }
}

pub(super) fn session_new_params(session: NewSession<'_>) -> Value {
    let mut meta = serde_json::Map::new();
    meta.insert("sessionId".to_string(), json!(session.session_id));
    if let Some(rules) = session.rules {
        meta.insert("rules".to_string(), json!(rules));
    }
    match session.mode {
        PermissionMode::Ask => {}
        PermissionMode::Auto => {
            meta.insert("autoMode".to_string(), json!(true));
        }
        PermissionMode::Bypass => {
            meta.insert("yoloMode".to_string(), json!(true));
        }
    }
    json!({
        "cwd": session.cwd,
        "mcpServers": session.mcp_servers,
        "_meta": Value::Object(meta),
    })
}

/// One HTTP MCP server entry the way `session/new` and `session/load` take it.
pub(super) fn http_mcp_server(name: &str, url: &str, headers: &[(&str, &str)]) -> Value {
    json!({
        "name": name,
        "type": "http",
        "url": url,
        "headers": headers
            .iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect::<Vec<_>>(),
    })
}

pub(super) fn session_load_params(session_id: &str, cwd: &str, mcp_servers: Vec<Value>) -> Value {
    json!({ "sessionId": session_id, "cwd": cwd, "mcpServers": mcp_servers })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionNewResult {
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) models: Option<ModelState>,
    #[serde(default)]
    pub(super) config_options: Vec<ConfigOption>,
}

/// `session/load` answers the same shape without the id.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionLoadResult {
    #[serde(default)]
    pub(super) models: Option<ModelState>,
    #[serde(default)]
    pub(super) config_options: Vec<ConfigOption>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ConfigOption {
    pub(super) id: String,
    #[serde(default)]
    pub(super) current_value: Option<String>,
}

pub(super) const CONFIG_MODEL: &str = "model";
pub(super) const CONFIG_REASONING_EFFORT: &str = "reasoning_effort";

pub(super) fn set_config_option_params(session_id: &str, config_id: &str, value: &str) -> Value {
    json!({ "sessionId": session_id, "configId": config_id, "value": value })
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SetConfigOptionResult {
    #[serde(default)]
    pub(super) config_options: Vec<ConfigOption>,
}

/// `_x.ai/session/info` wraps its answer in `result`, and answers an empty
/// object for a session it does not have.
#[derive(Debug, Clone, Deserialize)]
pub(super) struct SessionInfoResult {
    #[serde(default)]
    pub(super) result: SessionInfo,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionInfo {
    #[serde(default)]
    pub(super) cwd: Option<String>,
    #[serde(default)]
    pub(super) model: Option<String>,
    #[serde(default)]
    pub(super) context: Option<SessionContext>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionContext {
    #[serde(default)]
    pub(super) used: Option<u64>,
    #[serde(default)]
    pub(super) total: Option<u64>,
}

/// `session/close` says how it closed under `_meta`.
#[derive(Debug, Clone, Default, Deserialize)]
pub(super) struct CloseResult {
    #[serde(rename = "_meta", default)]
    pub(super) meta: BTreeMap<String, Value>,
}

impl CloseResult {
    pub(super) fn closed(&self) -> bool {
        self.meta.get("x.ai/closeOutcome").and_then(Value::as_str) == Some("closed")
    }
}

// ---------------------------------------------------------------------------
// prompts, steering, cancelling
// ---------------------------------------------------------------------------

/// A prompt, under the turn identity Caffold chose for it.
pub(super) fn prompt_params(session_id: &str, prompt_id: &str, blocks: Vec<Value>) -> Value {
    json!({ "sessionId": session_id, "prompt": blocks, "_meta": { "promptId": prompt_id } })
}

pub(super) fn text_block(text: &str) -> Value {
    json!({ "type": "text", "text": text })
}

/// An image the browser sent as a data URL, in the block the leader takes.
pub(super) fn image_block(data_url: &str) -> Option<Value> {
    let rest = data_url.strip_prefix("data:")?;
    let (mime_type, data) = rest.split_once(";base64,")?;
    Some(json!({ "type": "image", "mimeType": mime_type, "data": data }))
}

pub(super) fn interject_params(
    session_id: &str,
    interjection_id: &str,
    text: &str,
    blocks: Vec<Value>,
) -> Value {
    json!({ "sessionId": session_id, "text": text, "interjectionId": interjection_id, "content": blocks })
}

pub(super) fn cancel_params(session_id: &str) -> Value {
    json!({ "sessionId": session_id })
}

pub(super) fn session_params(session_id: &str) -> Value {
    json!({ "sessionId": session_id })
}

pub(super) fn fork_params(
    source_session_id: &str,
    source_cwd: &str,
    new_cwd: &str,
    new_session_id: &str,
) -> Value {
    json!({
        "sourceSessionId": source_session_id,
        "sourceCwd": source_cwd,
        "newCwd": new_cwd,
        "newSessionId": new_session_id,
    })
}

pub(super) fn rename_params(session_id: &str, title: &str) -> Value {
    json!({ "sessionId": session_id, "title": title })
}

/// The one-time setup a newly created Task's session carries in its rules:
/// name the Task on the first turn. A loaded session carries only the plan
/// convention, because it is not new.
///
/// The Grok wording of what Codex and Claude receive, naming the tools as
/// Grok's model reaches them: through `use_tool`, under the server's prefix.
pub(super) const CAFFOLD_FIRST_TURN_NAMING_INSTRUCTIONS: &str = concat!(
    "This session is a newly created Caffold task. ",
    "On its first user turn, after you understand the user's underlying goal and immediately ",
    "before your final response, you must call the Caffold MCP tool `rename_current_task` ",
    "(reached as `caffold__rename_current_task`) exactly once with a concise, meaningful ",
    "user-facing task name in the user's language. ",
    "Do not copy response-format instructions, verification markers, or the eventual answer ",
    "into the name. ",
    "If the user specifies an exact task name or format, honor it in that same call. ",
    "If `isolate_current_task` is needed on the first turn, call `rename_current_task` ",
    "immediately before isolation, and end the turn once the worktree is ready. ",
    "On later turns, call `rename_current_task` only when the user explicitly asks ",
    "to rename the task."
);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PromptResult {
    #[serde(default)]
    pub(super) stop_reason: Option<String>,
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

pub(super) fn updates_params(session_id: &str, cwd: &str, window: UpdatesWindow) -> Value {
    let mut params = json!({ "sessionId": session_id, "cwd": cwd });
    match window {
        UpdatesWindow::LastTurns(n) => params["turnIndex"] = json!(n),
        UpdatesWindow::Range { offset, limit } => {
            params["offset"] = json!(offset);
            params["limit"] = json!(limit);
        }
    }
    params
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum UpdatesWindow {
    /// The last `n` user turns.
    LastTurns(usize),
    /// `limit` updates starting at absolute index `offset`.
    Range { offset: usize, limit: usize },
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdatesResult {
    #[serde(default)]
    pub(super) updates: Vec<StoredUpdate>,
    #[serde(default)]
    pub(super) total_count: usize,
    /// Absolute indexes, over the whole session, of every user message —
    /// interjections included.
    #[serde(default)]
    pub(super) prompt_starts: Vec<usize>,
}

#[derive(Debug, Clone, Deserialize)]
pub(super) struct StoredUpdate {
    /// Seconds since the epoch, as the leader wrote it down.
    #[serde(default)]
    pub(super) timestamp: Option<u64>,
    #[serde(default)]
    pub(super) params: UpdateParams,
}

/// `session/update` and `_x.ai/session_notification` share this envelope.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateParams {
    #[serde(default)]
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) update: Value,
    #[serde(rename = "_meta", default)]
    pub(super) meta: EventMeta,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct EventMeta {
    #[serde(default)]
    pub(super) event_id: Option<String>,
    #[serde(default)]
    pub(super) agent_timestamp_ms: Option<u64>,
    #[serde(default)]
    pub(super) is_replay: bool,
    #[serde(default)]
    pub(super) prompt_id: Option<String>,
}

/// One thing the leader reports about a session, sorted by kind.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum Update {
    UserMessage(ContentBlock, UserMessageMeta),
    AgentMessage(ContentBlock),
    AgentThought(ContentBlock),
    ToolCall(ToolCall),
    ToolCallUpdate(ToolCallUpdate),
    Plan(Vec<PlanEntry>),
    TurnCompleted(TurnCompleted),
    PendingInteraction { tool_call_id: String },
    InteractionResolved { tool_call_id: String },
    Other(String),
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UserMessageMeta {
    #[serde(default)]
    pub(super) interjection: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) enum ContentBlock {
    Text {
        text: String,
        /// The words a person actually typed, when the leader wrapped them.
        display_text: Option<String>,
    },
    Image {
        mime_type: String,
        data: String,
    },
    Other,
}

impl ContentBlock {
    fn read(value: &Value) -> Self {
        match value.get("type").and_then(Value::as_str) {
            Some("text") => Self::Text {
                text: value
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                display_text: value
                    .get("_meta")
                    .and_then(|meta| meta.get("displayText"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
            Some("image") => Self::Image {
                mime_type: value
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png")
                    .to_string(),
                data: value
                    .get("data")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            },
            _ => Self::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ToolCall {
    pub(super) tool_call_id: String,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) raw_input: Value,
    #[serde(rename = "_meta", default)]
    pub(super) meta: ToolMeta,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ToolCallUpdate {
    pub(super) tool_call_id: String,
    #[serde(default)]
    pub(super) status: Option<String>,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) content: Vec<Value>,
    #[serde(default)]
    pub(super) locations: Vec<Location>,
    #[serde(default)]
    pub(super) raw_input: Value,
    #[serde(default)]
    pub(super) raw_output: Value,
    #[serde(rename = "_meta", default)]
    pub(super) meta: ToolMeta,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub(super) struct ToolMeta {
    #[serde(rename = "x.ai/tool", default)]
    pub(super) tool: Option<ToolIdentity>,
}

/// Which of Grok's tools a call is, under Grok's own names.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ToolIdentity {
    #[serde(default)]
    pub(super) name: String,
    #[serde(default)]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Location {
    pub(super) path: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PlanEntry {
    #[serde(default)]
    pub(super) content: String,
    #[serde(default)]
    pub(super) status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(super) struct TurnCompleted {
    pub(super) prompt_id: String,
    #[serde(default)]
    pub(super) stop_reason: Option<String>,
    #[serde(default)]
    pub(super) usage: Option<TurnUsage>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TurnUsage {
    #[serde(default)]
    pub(super) input_tokens: u64,
    #[serde(default)]
    pub(super) output_tokens: u64,
    #[serde(default)]
    pub(super) total_tokens: u64,
    #[serde(default)]
    pub(super) cached_read_tokens: u64,
    #[serde(default)]
    pub(super) cache_creation_tokens: u64,
    #[serde(default)]
    pub(super) reasoning_tokens: u64,
}

impl Update {
    /// Sort one `update` object. A kind this release does not know is kept by
    /// name so that it can be logged, and nothing else is done with it.
    pub(super) fn read(value: &Value) -> Update {
        let kind = value
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");
        match kind {
            "user_message_chunk" => Update::UserMessage(
                ContentBlock::read(value.get("content").unwrap_or(&Value::Null)),
                value
                    .get("_meta")
                    .and_then(|meta| serde_json::from_value(meta.clone()).ok())
                    .unwrap_or_default(),
            ),
            "agent_message_chunk" => Update::AgentMessage(ContentBlock::read(
                value.get("content").unwrap_or(&Value::Null),
            )),
            "agent_thought_chunk" => Update::AgentThought(ContentBlock::read(
                value.get("content").unwrap_or(&Value::Null),
            )),
            "tool_call" => match serde_json::from_value::<ToolCall>(value.clone()) {
                Ok(call) => Update::ToolCall(call),
                Err(_) => Update::Other(kind.to_string()),
            },
            "tool_call_update" => match serde_json::from_value::<ToolCallUpdate>(value.clone()) {
                Ok(call) => Update::ToolCallUpdate(call),
                Err(_) => Update::Other(kind.to_string()),
            },
            "plan" => Update::Plan(
                value
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
                            .collect()
                    })
                    .unwrap_or_default(),
            ),
            "turn_completed" => match serde_json::from_value::<TurnCompleted>(value.clone()) {
                Ok(completed) => Update::TurnCompleted(completed),
                Err(_) => Update::Other(kind.to_string()),
            },
            "pending_interaction" => match value.get("tool_call_id").and_then(Value::as_str) {
                Some(id) => Update::PendingInteraction {
                    tool_call_id: id.to_string(),
                },
                None => Update::Other(kind.to_string()),
            },
            "interaction_resolved" => match value.get("tool_call_id").and_then(Value::as_str) {
                Some(id) => Update::InteractionResolved {
                    tool_call_id: id.to_string(),
                },
                None => Update::Other(kind.to_string()),
            },
            other => Update::Other(other.to_string()),
        }
    }
}

// ---------------------------------------------------------------------------
// Grok's own notifications
// ---------------------------------------------------------------------------

pub(super) const SESSIONS_CHANGED: &str = "_x.ai/sessions/changed";
pub(super) const QUEUE_CHANGED: &str = "_x.ai/queue/changed";
pub(super) const SESSION_NOTIFICATION: &str = "_x.ai/session_notification";
pub(super) const SESSION_UPDATE: &str = "session/update";
pub(super) const SESSION_UPDATE_REPLAY: &str = "_x.ai/session/update";
pub(super) const INTERJECTION: &str = "_x.ai/session/interjection";
pub(super) const LEADER_RECONNECTED: &str = "_x.ai/leader_reconnected";
pub(super) const MODELS_UPDATE: &str = "_x.ai/models/update";
pub(super) const REQUEST_PERMISSION: &str = "session/request_permission";

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionsChangedParams {
    #[serde(default)]
    pub(super) upserted: Vec<SessionSummary>,
}

/// What the leader says about a session whenever it changes. Only what the
/// Task shows is read; where the session runs is the binding's to say.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SessionSummary {
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) model_id: Option<String>,
    #[serde(default)]
    pub(super) reasoning_effort: Option<String>,
    #[serde(default)]
    pub(super) activity: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct QueueChangedParams {
    #[serde(default)]
    pub(super) session_id: String,
    #[serde(default)]
    pub(super) running_prompt_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct LeaderReconnectedParams {
    #[serde(default)]
    pub(super) session_id: Option<String>,
}

// ---------------------------------------------------------------------------
// permission requests
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionRequestParams {
    pub(super) session_id: String,
    pub(super) tool_call: PermissionToolCall,
    #[serde(default)]
    pub(super) options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionToolCall {
    pub(super) tool_call_id: String,
    #[serde(default)]
    pub(super) title: Option<String>,
    #[serde(default)]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) raw_input: Value,
    #[serde(rename = "_meta", default)]
    pub(super) meta: ToolMeta,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PermissionOption {
    pub(super) option_id: String,
    #[serde(default)]
    pub(super) name: String,
    #[serde(default)]
    pub(super) kind: String,
}

pub(super) const OPTION_ALLOW_ONCE: &str = "allow_once";
pub(super) const OPTION_ALLOW_ALWAYS: &str = "allow_always";
pub(super) const OPTION_REJECT_ONCE: &str = "reject_once";

pub(super) fn permission_selected(option_id: &str) -> Value {
    json!({ "outcome": { "outcome": "selected", "optionId": option_id } })
}

pub(super) fn permission_cancelled() -> Value {
    json!({ "outcome": { "outcome": "cancelled" } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent/grok/fixtures")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture exists"))
            .expect("fixture is JSON")
    }

    #[test]
    fn a_line_is_sorted_by_what_it_asks_of_the_reader() {
        assert!(matches!(
            read_frame(r#"{"jsonrpc":"2.0","id":3,"result":{"ok":true}}"#),
            Some(Frame::Response {
                id: 3,
                result: Ok(_)
            })
        ));
        let error = read_frame(
            r#"{"jsonrpc":"2.0","id":9,"error":{"code":-32603,"message":"Path not found.","data":{"code":"FS_NOT_FOUND"}}}"#,
        );
        let Some(Frame::Response {
            result: Err(error), ..
        }) = error
        else {
            panic!("an error answer reads as one");
        };
        assert!(error.is_path_not_found());
        assert!(matches!(
            read_frame(r#"{"jsonrpc":"2.0","method":"_x.ai/queue/changed","params":{}}"#),
            Some(Frame::Notification { method, .. }) if method == "_x.ai/queue/changed"
        ));
        assert!(matches!(
            read_frame(r#"{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{}}"#),
            Some(Frame::ServerRequest { method, .. }) if method == "session/request_permission"
        ));
        assert_eq!(read_frame("not json"), None);
        assert_eq!(read_frame("[]"), None);
    }

    #[test]
    fn the_catalog_comes_through_initialize_with_the_configured_default_effort() {
        let result: InitializeResult =
            serde_json::from_value(fixture("initialize-result.json")).expect("decodes");
        let state = result
            .meta
            .model_state
            .expect("initialize carries the catalog");
        assert_eq!(state.current_model_id.as_deref(), Some("grok-4.6"));
        let first = &state.available_models[0];
        assert_eq!(first.model_id, "grok-4.6");
        assert_eq!(first.name.as_deref(), Some("Grok 4.6"));
        // The installation's default is xhigh while the model's own default
        // marking is high; the driver offers the former.
        assert_eq!(first.meta.reasoning_effort.as_deref(), Some("xhigh"));
        assert_eq!(
            first
                .meta
                .reasoning_efforts
                .iter()
                .map(|e| e.value.as_str())
                .collect::<Vec<_>>(),
            ["xhigh", "high", "medium", "low"]
        );
        assert_eq!(first.meta.total_context_tokens, Some(500_000));
    }

    #[test]
    fn a_new_session_answers_with_its_id_catalog_and_config_options() {
        let result: SessionNewResult =
            serde_json::from_value(fixture("session-new-result.json")).expect("decodes");
        assert_eq!(result.session_id, "01a09482-370e-7001-a329-9a7d78be2cb8");
        assert!(result.models.is_some());
        let effort = result
            .config_options
            .iter()
            .find(|option| option.id == CONFIG_REASONING_EFFORT)
            .expect("effort option");
        assert_eq!(effort.current_value.as_deref(), Some("xhigh"));
    }

    #[test]
    fn session_new_params_carry_the_chosen_id_rules_and_mode() {
        let params = session_new_params(NewSession {
            session_id: "sid",
            cwd: "/work",
            mcp_servers: vec![http_mcp_server(
                "caffold",
                "http://127.0.0.1:1/api/grok/mcp",
                &[("x-caffold-mcp-binding", "b")],
            )],
            rules: Some("plan rules"),
            mode: PermissionMode::Bypass,
        });
        assert_eq!(params["_meta"]["sessionId"], "sid");
        assert_eq!(params["_meta"]["rules"], "plan rules");
        assert_eq!(params["_meta"]["yoloMode"], true);
        assert!(params["_meta"].get("autoMode").is_none());
        assert_eq!(
            params["mcpServers"][0]["headers"][0]["name"],
            "x-caffold-mcp-binding"
        );
        let ask = session_new_params(NewSession {
            session_id: "sid",
            cwd: "/work",
            mcp_servers: Vec::new(),
            rules: None,
            mode: PermissionMode::Ask,
        });
        assert!(ask["_meta"].get("yoloMode").is_none());
        assert!(ask["_meta"].get("rules").is_none());
    }

    #[test]
    fn a_session_info_answer_decodes() {
        let info: SessionInfoResult =
            serde_json::from_value(fixture("session-info-result.json")).expect("decodes");
        assert_eq!(info.result.model.as_deref(), Some("grok-4.6"));
        assert!(info.result.cwd.is_some());
        let empty: SessionInfoResult =
            serde_json::from_value(json!({ "result": {} })).expect("decodes");
        assert!(empty.result.cwd.is_none());
    }

    #[test]
    fn stored_history_keeps_its_boundaries_and_identities() {
        let updates: UpdatesResult =
            serde_json::from_value(fixture("updates-result.json")).expect("decodes");
        assert_eq!(updates.total_count, 39);
        assert_eq!(updates.prompt_starts, [0, 9, 17, 25, 30, 35]);
        let first = &updates.updates[0];
        assert!(matches!(
            Update::read(&first.params.update),
            Update::UserMessage(..)
        ));
        assert!(
            first
                .params
                .meta
                .event_id
                .as_deref()
                .unwrap()
                .ends_with("-2")
        );
        let completed = updates
            .updates
            .iter()
            .find_map(|stored| match Update::read(&stored.params.update) {
                Update::TurnCompleted(completed) => Some(completed),
                _ => None,
            })
            .expect("a completed turn");
        assert_eq!(completed.stop_reason.as_deref(), Some("end_turn"));
        assert!(completed.usage.unwrap().input_tokens > 0);
        let tool = updates
            .updates
            .iter()
            .find_map(|stored| match Update::read(&stored.params.update) {
                Update::ToolCall(call) => Some(call),
                _ => None,
            })
            .expect("a tool call");
        assert_eq!(tool.meta.tool.unwrap().name, "run_terminal_command");
        assert_eq!(tool.raw_input["command"], "cat probe-marker.txt");
    }

    #[test]
    fn a_stored_interjection_keeps_the_words_a_person_typed() {
        let stored: StoredUpdate =
            serde_json::from_value(fixture("stored-interjection.json")).expect("decodes");
        let Update::UserMessage(ContentBlock::Text { text, display_text }, meta) =
            Update::read(&stored.params.update)
        else {
            panic!("an interjection is a user message");
        };
        assert!(meta.interjection);
        assert!(text.contains("<user_query>"));
        assert_eq!(display_text.as_deref(), Some("INTERJECT_3275d766"));
    }

    #[test]
    fn a_replayed_prompt_carries_its_picture_as_a_block() {
        let frames: Vec<Value> =
            serde_json::from_value(fixture("replay-user-message-with-image.json"))
                .expect("decodes");
        let params: UpdateParams =
            serde_json::from_value(frames[1]["params"].clone()).expect("decodes");
        assert!(params.meta.is_replay);
        let Update::UserMessage(ContentBlock::Image { mime_type, data }, _) =
            Update::read(&params.update)
        else {
            panic!("the second chunk is the picture");
        };
        assert_eq!(mime_type, "image/png");
        assert!(data.starts_with("iVBOR"));
    }

    #[test]
    fn a_live_turn_reads_as_tool_activity_and_an_answer() {
        let frames: Vec<Value> =
            serde_json::from_value(fixture("live-turn-with-command.json")).expect("decodes");
        let mut kinds = Vec::new();
        for frame in &frames {
            let Some(Frame::Notification { method, params }) = read_frame(&frame.to_string())
            else {
                continue;
            };
            if method == SESSION_UPDATE || method == SESSION_NOTIFICATION {
                let params: UpdateParams = serde_json::from_value(params).expect("envelope");
                kinds.push(std::mem::discriminant(&Update::read(&params.update)));
                if let Update::ToolCallUpdate(update) = Update::read(&params.update)
                    && update.status.as_deref() == Some("completed")
                {
                    assert_eq!(update.raw_output["exit_code"], 0);
                    assert_eq!(
                        update.raw_output["output_for_prompt"],
                        "exit: 0\nSOURCE_CHECKOUT\n"
                    );
                    assert!(
                        update.raw_output["current_dir"]
                            .as_str()
                            .unwrap()
                            .ends_with("/source")
                    );
                }
            }
        }
        assert!(
            kinds.contains(&std::mem::discriminant(&Update::ToolCall(ToolCall {
                tool_call_id: String::new(),
                title: None,
                kind: None,
                raw_input: Value::Null,
                meta: ToolMeta::default()
            })))
        );
        assert!(
            kinds.contains(&std::mem::discriminant(&Update::TurnCompleted(
                TurnCompleted {
                    prompt_id: String::new(),
                    stop_reason: None,
                    usage: None
                }
            )))
        );
    }

    #[test]
    fn a_permission_request_offers_its_options_by_kind() {
        let frame = fixture("request-permission.json");
        let Some(Frame::ServerRequest { method, params, .. }) = read_frame(&frame.to_string())
        else {
            panic!("a request");
        };
        assert_eq!(method, REQUEST_PERMISSION);
        let request: PermissionRequestParams = serde_json::from_value(params).expect("decodes");
        assert_eq!(
            request.tool_call.meta.tool.unwrap().name,
            "run_terminal_command"
        );
        assert_eq!(
            request.tool_call.raw_input["command"],
            "for i in 1 2 3; do echo tick $i; sleep 1; done"
        );
        let kinds = request
            .options
            .iter()
            .map(|o| o.kind.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            ["allow_always", "allow_once", "reject_once", "reject_always"]
        );
        assert_eq!(
            permission_selected("allow-once")["outcome"]["optionId"],
            "allow-once"
        );
        assert_eq!(permission_cancelled()["outcome"]["outcome"], "cancelled");
    }

    #[test]
    fn grok_notifications_decode() {
        let sessions: Vec<Value> =
            serde_json::from_value(fixture("sessions-changed.json")).unwrap();
        let params: SessionsChangedParams =
            serde_json::from_value(sessions[0]["params"].clone()).unwrap();
        assert_eq!(params.upserted[0].activity.as_deref(), Some("working"));
        let queue: Vec<Value> = serde_json::from_value(fixture("queue-changed.json")).unwrap();
        let params: QueueChangedParams =
            serde_json::from_value(queue[0]["params"].clone()).unwrap();
        assert!(params.running_prompt_id.is_none() || params.running_prompt_id.is_some());
        let reconnected: Value = fixture("leader-reconnected.json");
        let params: LeaderReconnectedParams =
            serde_json::from_value(reconnected["params"].clone()).unwrap();
        assert!(params.session_id.is_some());
        let completed: Vec<Value> = serde_json::from_value(fixture("turn-completed.json")).unwrap();
        let params: UpdateParams = serde_json::from_value(completed[0]["params"].clone()).unwrap();
        assert!(matches!(
            Update::read(&params.update),
            Update::TurnCompleted(_)
        ));
    }

    #[test]
    fn a_picture_from_the_browser_becomes_an_image_block() {
        let block = image_block("data:image/png;base64,AAAA").expect("a data URL");
        assert_eq!(block["mimeType"], "image/png");
        assert_eq!(block["data"], "AAAA");
        assert!(image_block("https://example.invalid/x.png").is_none());
    }

    #[test]
    fn history_windows_are_asked_for_in_the_leaders_terms() {
        assert_eq!(
            updates_params("s", "/w", UpdatesWindow::LastTurns(8))["turnIndex"],
            8
        );
        let range = updates_params(
            "s",
            "/w",
            UpdatesWindow::Range {
                offset: 4,
                limit: 6,
            },
        );
        assert_eq!(range["offset"], 4);
        assert_eq!(range["limit"], 6);
    }
}
