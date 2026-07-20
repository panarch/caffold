use std::collections::BTreeMap;

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
#[cfg(test)]
use serde_json::json;

#[allow(dead_code)]
pub const SUPPORTED_CODEX_CLI_VERSION: &str = "0.144.4";

pub(crate) const INITIALIZE: &str = "initialize";
pub(crate) const INITIALIZED: &str = "initialized";
pub(crate) const ACCOUNT_READ: &str = "account/read";
pub(crate) const ACCOUNT_RATE_LIMITS_READ: &str = "account/rateLimits/read";
pub(crate) const ACCOUNT_USAGE_READ: &str = "account/usage/read";
pub(crate) const THREAD_LIST: &str = "thread/list";
pub(crate) const THREAD_READ: &str = "thread/read";
pub(crate) const THREAD_START: &str = "thread/start";
pub(crate) const THREAD_RESUME: &str = "thread/resume";
pub(crate) const THREAD_ARCHIVE: &str = "thread/archive";
#[allow(dead_code)]
pub(crate) const THREAD_UNSUBSCRIBE: &str = "thread/unsubscribe";
pub(crate) const THREAD_TURNS_LIST: &str = "thread/turns/list";
pub(crate) const TURN_START: &str = "turn/start";
pub(crate) const TURN_STEER: &str = "turn/steer";
pub(crate) const TURN_INTERRUPT: &str = "turn/interrupt";
pub(crate) const MODEL_LIST: &str = "model/list";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerInfo {
    pub user_agent: Option<String>,
    pub codex_home: Option<String>,
    pub platform_family: Option<String>,
    pub platform_os: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccount {
    #[serde(rename = "accountType", alias = "type")]
    pub account_type: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountReadResponse {
    pub account: Option<CodexAccount>,
    pub requires_openai_auth: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TurnItemsView {
    NotLoaded,
    Summary,
    Full,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum ThreadStatus {
    NotLoaded,
    Idle,
    SystemError,
    Active {
        #[serde(default)]
        active_flags: Vec<Value>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TurnStatus {
    Completed,
    Interrupted,
    Failed,
    InProgress,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurn {
    pub id: String,
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(default = "default_items_view")]
    pub items_view: TurnItemsView,
    pub status: TurnStatus,
    #[serde(default)]
    pub error: Option<Value>,
    #[serde(default)]
    pub started_at: Option<f64>,
    #[serde(default)]
    pub completed_at: Option<f64>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

fn default_items_view() -> TurnItemsView {
    TurnItemsView::Full
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexThread {
    pub id: String,
    #[serde(default)]
    pub preview: String,
    pub status: ThreadStatus,
    pub cwd: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub created_at: f64,
    #[serde(default)]
    pub updated_at: f64,
    #[serde(default)]
    pub recency_at: Option<f64>,
    #[serde(default)]
    pub turns: Vec<CodexTurn>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl CodexThread {
    pub fn into_value(self) -> Value {
        serde_json::to_value(self).expect("serializing a decoded Codex thread cannot fail")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListResponse {
    #[serde(default)]
    pub data: Vec<CodexThread>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadResponse {
    pub thread: CodexThread,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnsPage {
    #[serde(default)]
    pub data: Vec<CodexTurn>,
    #[serde(default)]
    pub next_cursor: Option<String>,
    #[serde(default)]
    pub backwards_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartResponse {
    pub thread: CodexThread,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeResponse {
    pub thread: CodexThread,
    #[serde(default)]
    pub initial_turns_page: Option<TurnsPage>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartResponse {
    pub turn: CodexTurn,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerResponse {
    pub turn_id: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum ThreadUnsubscribeStatus {
    NotLoaded,
    NotSubscribed,
    Unsubscribed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct ThreadUnsubscribeResponse {
    pub status: ThreadUnsubscribeStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub model: String,
    pub display_name: String,
    pub description: String,
    pub hidden: bool,
    #[serde(default)]
    pub supported_reasoning_efforts: Vec<Value>,
    pub default_reasoning_effort: Value,
    #[serde(default)]
    pub input_modalities: Vec<Value>,
    pub supports_personality: bool,
    pub is_default: bool,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResponse {
    #[serde(default)]
    pub data: Vec<Model>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct EmptyResponse {}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccountReadParams {
    pub refresh_token: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadListParams {
    pub limit: usize,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadReadParams<'a> {
    pub thread_id: &'a str,
    pub include_turns: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadIdParams<'a> {
    pub thread_id: &'a str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelListParams {
    pub limit: usize,
    pub include_hidden: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadStartParams<'a> {
    pub cwd: &'a str,
    pub runtime_workspace_roots: [&'a str; 1],
    pub approvals_reviewer: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum UserInput<'a> {
    #[serde(rename = "text")]
    Text {
        text: &'a str,
        text_elements: [Value; 0],
    },
    #[serde(rename = "image")]
    Image { url: &'a str },
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams<'a> {
    pub thread_id: &'a str,
    pub input: Vec<UserInput<'a>>,
    pub cwd: &'a str,
    pub runtime_workspace_roots: [&'a str; 1],
    pub approvals_reviewer: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerParams<'a> {
    pub thread_id: &'a str,
    pub input: Vec<UserInput<'a>>,
    pub expected_turn_id: &'a str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams<'a> {
    pub thread_id: &'a str,
    pub turn_id: &'a str,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTurnsListParams<'a> {
    pub thread_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<&'a str>,
    pub limit: usize,
    pub sort_direction: SortDirection,
    pub items_view: TurnItemsView,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InitialTurnsPageParams {
    pub limit: usize,
    pub sort_direction: SortDirection,
    pub items_view: TurnItemsView,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadResumeParams<'a> {
    pub thread_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_workspace_roots: Option<Vec<&'a str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approvals_reviewer: Option<&'static str>,
    pub exclude_turns: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_turns_page: Option<InitialTurnsPageParams>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexNotification {
    ThreadStarted {
        thread: CodexThread,
    },
    ThreadStatusChanged {
        thread_id: String,
        status: ThreadStatus,
    },
    TurnStarted {
        thread_id: String,
        turn: CodexTurn,
    },
    TurnCompleted {
        thread_id: String,
        turn: CodexTurn,
    },
    ItemStarted {
        thread_id: String,
        turn_id: String,
        item: Value,
        started_at_ms: u64,
    },
    ItemCompleted {
        thread_id: String,
        turn_id: String,
        item: Value,
        completed_at_ms: u64,
    },
    RawResponseItemCompleted {
        thread_id: String,
        turn_id: String,
        item: Value,
    },
    TurnDiffUpdated {
        thread_id: String,
        params: Value,
    },
    Unknown {
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexServerRequest {
    CommandExecutionApproval {
        id: Value,
        thread_id: String,
        params: Value,
    },
    FileChangeApproval {
        id: Value,
        thread_id: String,
        params: Value,
    },
    Unknown {
        id: Value,
        method: String,
        params: Value,
    },
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
    #[serde(default)]
    pub data: Option<Value>,
}

pub(crate) fn decode_response<T: DeserializeOwned>(
    method: &str,
    value: Value,
) -> Result<T, String> {
    serde_json::from_value(value).map_err(|error| format!("invalid {method} response: {error}"))
}

pub(crate) fn decode_notification(
    method: &str,
    params: Value,
) -> Result<CodexNotification, String> {
    match method {
        "thread/started" => {
            #[derive(Deserialize)]
            struct Params {
                thread: CodexThread,
            }
            let Params { thread } = decode_params(method, params)?;
            Ok(CodexNotification::ThreadStarted { thread })
        }
        "thread/status/changed" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                thread_id: String,
                status: ThreadStatus,
            }
            let Params { thread_id, status } = decode_params(method, params)?;
            Ok(CodexNotification::ThreadStatusChanged { thread_id, status })
        }
        "turn/started" | "turn/completed" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                thread_id: String,
                turn: CodexTurn,
            }
            let Params { thread_id, turn } = decode_params(method, params)?;
            if method == "turn/started" {
                Ok(CodexNotification::TurnStarted { thread_id, turn })
            } else {
                Ok(CodexNotification::TurnCompleted { thread_id, turn })
            }
        }
        "item/started" | "item/completed" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                thread_id: String,
                turn_id: String,
                item: Value,
                #[serde(default)]
                started_at_ms: Option<u64>,
                #[serde(default)]
                completed_at_ms: Option<u64>,
            }
            let Params {
                thread_id,
                turn_id,
                item,
                started_at_ms,
                completed_at_ms,
            } = decode_params(method, params)?;
            if method == "item/started" {
                Ok(CodexNotification::ItemStarted {
                    thread_id,
                    turn_id,
                    item,
                    started_at_ms: started_at_ms.unwrap_or_default(),
                })
            } else {
                Ok(CodexNotification::ItemCompleted {
                    thread_id,
                    turn_id,
                    item,
                    completed_at_ms: completed_at_ms.unwrap_or_default(),
                })
            }
        }
        "rawResponseItem/completed" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Params {
                thread_id: String,
                turn_id: String,
                item: Value,
            }
            let Params {
                thread_id,
                turn_id,
                item,
            } = decode_params(method, params)?;
            Ok(CodexNotification::RawResponseItemCompleted {
                thread_id,
                turn_id,
                item,
            })
        }
        "turn/diff/updated" => {
            let thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .ok_or_else(|| "turn/diff/updated params did not include threadId".to_string())?
                .to_string();
            Ok(CodexNotification::TurnDiffUpdated { thread_id, params })
        }
        _ => Ok(CodexNotification::Unknown {
            method: method.to_string(),
            params,
        }),
    }
}

pub(crate) fn decode_server_request(
    id: Value,
    method: &str,
    params: Value,
) -> Result<CodexServerRequest, String> {
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    match (method, thread_id) {
        ("item/commandExecution/requestApproval", Some(thread_id)) => {
            Ok(CodexServerRequest::CommandExecutionApproval {
                id,
                thread_id,
                params,
            })
        }
        ("item/fileChange/requestApproval", Some(thread_id)) => {
            Ok(CodexServerRequest::FileChangeApproval {
                id,
                thread_id,
                params,
            })
        }
        ("item/commandExecution/requestApproval" | "item/fileChange/requestApproval", None) => {
            Err(format!("{method} params did not include threadId"))
        }
        _ => Ok(CodexServerRequest::Unknown {
            id,
            method: method.to_string(),
            params,
        }),
    }
}

fn decode_params<T: DeserializeOwned>(method: &str, params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|error| format!("invalid {method} params: {error}"))
}

pub(crate) fn thread_resume_params<'a>(
    thread_id: &'a str,
    initial_turns_page: bool,
) -> ThreadResumeParams<'a> {
    ThreadResumeParams {
        thread_id,
        cwd: None,
        runtime_workspace_roots: None,
        approvals_reviewer: None,
        exclude_turns: true,
        initial_turns_page: initial_turns_page.then_some(InitialTurnsPageParams {
            limit: 8,
            sort_direction: SortDirection::Desc,
            items_view: TurnItemsView::Full,
        }),
    }
}

pub(crate) fn thread_list_params(limit: usize) -> ThreadListParams {
    ThreadListParams {
        limit,
        archived: false,
    }
}

pub(crate) fn thread_read_params<'a>(
    thread_id: &'a str,
    include_turns: bool,
) -> ThreadReadParams<'a> {
    ThreadReadParams {
        thread_id,
        include_turns,
    }
}

pub(crate) fn thread_archive_params(thread_id: &str) -> ThreadIdParams<'_> {
    ThreadIdParams { thread_id }
}

pub(crate) fn model_list_params(limit: usize) -> ModelListParams {
    ModelListParams {
        limit,
        include_hidden: false,
    }
}

pub(crate) fn account_read_params() -> AccountReadParams {
    AccountReadParams {
        refresh_token: false,
    }
}

pub(crate) fn thread_start_params(cwd: &str) -> ThreadStartParams<'_> {
    ThreadStartParams {
        cwd,
        runtime_workspace_roots: [cwd],
        approvals_reviewer: "user",
    }
}

pub(crate) fn turn_start_params<'a>(
    thread_id: &'a str,
    cwd: &'a str,
    prompt: &'a str,
    image_urls: &'a [String],
    model: Option<&'a str>,
    effort: Option<&'a str>,
) -> TurnStartParams<'a> {
    TurnStartParams {
        thread_id,
        input: turn_input(prompt, image_urls),
        cwd,
        runtime_workspace_roots: [cwd],
        approvals_reviewer: "user",
        model: model.filter(|value| !value.is_empty()),
        effort: effort.filter(|value| !value.is_empty()),
    }
}

pub(crate) fn turn_steer_params<'a>(
    thread_id: &'a str,
    expected_turn_id: &'a str,
    prompt: &'a str,
    image_urls: &'a [String],
) -> TurnSteerParams<'a> {
    TurnSteerParams {
        thread_id,
        input: turn_input(prompt, image_urls),
        expected_turn_id,
    }
}

fn turn_input<'a>(prompt: &'a str, image_urls: &'a [String]) -> Vec<UserInput<'a>> {
    let mut input = Vec::new();
    if !prompt.is_empty() {
        input.push(UserInput::Text {
            text: prompt,
            text_elements: [],
        });
    }
    input.extend(
        image_urls
            .iter()
            .map(|url| UserInput::Image { url: url.as_str() }),
    );
    input
}

pub(crate) fn turn_interrupt_params<'a>(
    thread_id: &'a str,
    turn_id: &'a str,
) -> TurnInterruptParams<'a> {
    TurnInterruptParams { thread_id, turn_id }
}

pub(crate) fn thread_turns_list_params<'a>(
    thread_id: &'a str,
    cursor: Option<&'a str>,
    limit: usize,
    sort_direction: SortDirection,
) -> ThreadTurnsListParams<'a> {
    ThreadTurnsListParams {
        thread_id,
        cursor: cursor.filter(|cursor| !cursor.is_empty()),
        limit,
        sort_direction,
        items_view: TurnItemsView::Full,
    }
}

#[allow(dead_code)]
pub(crate) fn thread_unsubscribe_params(thread_id: &str) -> ThreadIdParams<'_> {
    ThreadIdParams { thread_id }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(status: Value) -> Value {
        json!({
            "id": "thread_1",
            "preview": "Inspect",
            "status": status,
            "cwd": "/workspace/project",
            "path": "/tmp/rollout.jsonl",
            "createdAt": 1,
            "updatedAt": 2,
            "turns": []
        })
    }

    #[test]
    fn decodes_required_notification_shapes() {
        let started = decode_notification(
            "thread/started",
            json!({ "thread": thread(json!({ "type": "idle" })) }),
        )
        .expect("thread notification");
        assert!(matches!(
            started,
            CodexNotification::ThreadStarted { thread } if thread.id == "thread_1"
        ));

        let status = decode_notification(
            "thread/status/changed",
            json!({ "threadId": "thread_1", "status": { "type": "active", "activeFlags": [] } }),
        )
        .expect("status notification");
        assert!(matches!(
            status,
            CodexNotification::ThreadStatusChanged {
                status: ThreadStatus::Active { .. },
                ..
            }
        ));

        let unknown = decode_notification("future/event", json!({ "value": 1 }))
            .expect("unknown notifications are forward compatible");
        assert!(matches!(unknown, CodexNotification::Unknown { .. }));
    }

    #[test]
    fn rejects_malformed_required_notification() {
        let error = decode_notification("turn/started", json!({ "threadId": "thread_1" }))
            .expect_err("turn is required");
        assert!(error.contains("invalid turn/started params"));
    }

    #[test]
    fn serializes_resume_with_initial_turns_page() {
        assert_eq!(
            serde_json::to_value(thread_resume_params("thread_1", true)).expect("serialize resume"),
            json!({
                "threadId": "thread_1",
                "excludeTurns": true,
                "initialTurnsPage": {
                    "limit": 8,
                    "sortDirection": "desc",
                    "itemsView": "full"
                }
            })
        );
    }

    #[test]
    fn serializes_supported_request_shapes() {
        let images = vec!["data:image/png;base64,aGVsbG8=".to_string()];
        let fixtures = [
            (
                ACCOUNT_READ,
                serde_json::to_value(account_read_params()).expect("account read params"),
                json!({ "refreshToken": false }),
            ),
            (
                THREAD_LIST,
                serde_json::to_value(thread_list_params(100)).expect("thread list params"),
                json!({ "limit": 100, "archived": false }),
            ),
            (
                THREAD_READ,
                serde_json::to_value(thread_read_params("thread_1", true))
                    .expect("thread read params"),
                json!({ "threadId": "thread_1", "includeTurns": true }),
            ),
            (
                THREAD_START,
                serde_json::to_value(thread_start_params("/workspace/project"))
                    .expect("thread start params"),
                json!({
                    "cwd": "/workspace/project",
                    "runtimeWorkspaceRoots": ["/workspace/project"],
                    "approvalsReviewer": "user"
                }),
            ),
            (
                TURN_START,
                serde_json::to_value(turn_start_params(
                    "thread_1",
                    "/workspace/project",
                    "Inspect",
                    &images,
                    Some("gpt-5.5"),
                    Some("high"),
                ))
                .expect("turn start params"),
                json!({
                    "threadId": "thread_1",
                    "input": [
                        { "type": "text", "text": "Inspect", "text_elements": [] },
                        { "type": "image", "url": "data:image/png;base64,aGVsbG8=" }
                    ],
                    "cwd": "/workspace/project",
                    "runtimeWorkspaceRoots": ["/workspace/project"],
                    "approvalsReviewer": "user",
                    "model": "gpt-5.5",
                    "effort": "high"
                }),
            ),
            (
                TURN_STEER,
                serde_json::to_value(turn_steer_params("thread_1", "turn_1", "Continue", &images))
                    .expect("turn steer params"),
                json!({
                    "threadId": "thread_1",
                    "input": [
                        { "type": "text", "text": "Continue", "text_elements": [] },
                        { "type": "image", "url": "data:image/png;base64,aGVsbG8=" }
                    ],
                    "expectedTurnId": "turn_1"
                }),
            ),
            (
                TURN_INTERRUPT,
                serde_json::to_value(turn_interrupt_params("thread_1", "turn_1"))
                    .expect("turn interrupt params"),
                json!({ "threadId": "thread_1", "turnId": "turn_1" }),
            ),
            (
                THREAD_ARCHIVE,
                serde_json::to_value(thread_archive_params("thread_1"))
                    .expect("thread archive params"),
                json!({ "threadId": "thread_1" }),
            ),
            (
                THREAD_UNSUBSCRIBE,
                serde_json::to_value(thread_unsubscribe_params("thread_1"))
                    .expect("thread unsubscribe params"),
                json!({ "threadId": "thread_1" }),
            ),
            (
                THREAD_TURNS_LIST,
                serde_json::to_value(thread_turns_list_params(
                    "thread_1",
                    Some("cursor_1"),
                    8,
                    SortDirection::Asc,
                ))
                .expect("thread turns list params"),
                json!({
                    "threadId": "thread_1",
                    "cursor": "cursor_1",
                    "limit": 8,
                    "sortDirection": "asc",
                    "itemsView": "full"
                }),
            ),
            (
                MODEL_LIST,
                serde_json::to_value(model_list_params(100)).expect("model list params"),
                json!({ "limit": 100, "includeHidden": false }),
            ),
        ];

        for (method, actual, expected) in fixtures {
            assert_eq!(actual, expected, "{method}");
        }
    }

    #[test]
    fn decodes_supported_response_shapes() {
        let idle_thread = thread(json!({ "type": "idle" }));
        let turn = json!({
            "id": "turn_1",
            "items": [],
            "itemsView": "full",
            "status": "completed"
        });

        let list: ThreadListResponse = decode_response(
            THREAD_LIST,
            json!({ "data": [idle_thread.clone()], "nextCursor": null }),
        )
        .expect("thread list response");
        assert_eq!(list.data[0].id, "thread_1");

        let read: ThreadReadResponse =
            decode_response(THREAD_READ, json!({ "thread": idle_thread.clone() }))
                .expect("thread read response");
        assert_eq!(read.thread.status, ThreadStatus::Idle);

        let account: AccountReadResponse = decode_response(
            ACCOUNT_READ,
            json!({
                "account": {
                    "type": "chatgpt",
                    "email": "developer@example.com",
                    "planType": "pro"
                },
                "requiresOpenaiAuth": true
            }),
        )
        .expect("account read response");
        assert_eq!(account.account.unwrap().account_type, "chatgpt");

        let started: ThreadStartResponse =
            decode_response(THREAD_START, json!({ "thread": idle_thread.clone() }))
                .expect("thread start response");
        assert_eq!(started.thread.id, "thread_1");

        let resumed: ThreadResumeResponse = decode_response(
            THREAD_RESUME,
            json!({
                "thread": idle_thread,
                "initialTurnsPage": {
                    "data": [turn.clone()],
                    "nextCursor": "older",
                    "backwardsCursor": "newer"
                }
            }),
        )
        .expect("thread resume response");
        assert_eq!(resumed.initial_turns_page.unwrap().data[0].id, "turn_1");

        let turn_started: TurnStartResponse =
            decode_response(TURN_START, json!({ "turn": turn })).expect("turn start response");
        assert_eq!(turn_started.turn.status, TurnStatus::Completed);

        let steered: TurnSteerResponse = decode_response(TURN_STEER, json!({ "turnId": "turn_1" }))
            .expect("turn steer response");
        assert_eq!(steered.turn_id, "turn_1");
    }

    #[test]
    fn decodes_unsubscribe_status() {
        let response: ThreadUnsubscribeResponse =
            decode_response(THREAD_UNSUBSCRIBE, json!({ "status": "unsubscribed" }))
                .expect("unsubscribe response");
        assert_eq!(response.status, ThreadUnsubscribeStatus::Unsubscribed);
    }
}
