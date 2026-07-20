use std::{
    collections::{BTreeMap, HashMap},
    io::ErrorKind,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

mod protocol;

pub use protocol::{
    CodexNotification, CodexServerRequest, CodexThread, CodexTurn, ModelListResponse,
    ThreadResumeResponse, ThreadStatus, ThreadUnsubscribeResponse, TurnStatus, TurnsPage,
};
use protocol::{
    EmptyResponse, INITIALIZE, INITIALIZED, JsonRpcError, MODEL_LIST, SortDirection,
    THREAD_ARCHIVE, THREAD_LIST, THREAD_READ, THREAD_RESUME, THREAD_START, THREAD_TURNS_LIST,
    THREAD_UNSUBSCRIBE, TURN_INTERRUPT, TURN_START, TURN_STEER, ThreadListResponse,
    ThreadReadResponse, ThreadStartResponse, TurnStartResponse, TurnSteerResponse, decode_response,
    model_list_params, thread_archive_params, thread_list_params, thread_read_params,
    thread_resume_params, thread_start_params, thread_turns_list_params, thread_unsubscribe_params,
    turn_interrupt_params, turn_start_params, turn_steer_params,
};
#[cfg(test)]
pub(crate) use protocol::{TurnItemsView, decode_notification, decode_server_request};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{
    io::Lines,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    sync::{Mutex as AsyncMutex, broadcast, oneshot},
    time::{Instant, timeout},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const THREAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);
const INITIALIZE_ID: u64 = 1;
const ACCOUNT_ID: u64 = 2;
const RATE_LIMITS_ID: u64 = 3;
const USAGE_ID: u64 = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusResponse {
    pub available: bool,
    pub codex_cli_available: bool,
    pub app_server_available: bool,
    pub message: Option<String>,
    pub account: Option<CodexAccount>,
    pub requires_openai_auth: Option<bool>,
    pub rate_limits: Option<Value>,
    pub usage: Option<Value>,
    pub app_server: Option<CodexAppServerInfo>,
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
pub struct CodexAppServerInfo {
    pub user_agent: Option<String>,
    pub codex_home: Option<String>,
    pub platform_family: Option<String>,
    pub platform_os: Option<String>,
}

pub async fn status() -> CodexStatusResponse {
    match read_app_server_status().await {
        Ok(responses) => status_from_responses(responses),
        Err(AppServerReadError::MissingCli) => unavailable(
            false,
            false,
            "Codex CLI is not available on this machine.".to_string(),
        ),
        Err(AppServerReadError::StartFailed(message)) => unavailable(true, false, message),
        Err(AppServerReadError::Protocol(message)) => unavailable(true, false, message),
    }
}

#[derive(Clone)]
pub struct CodexThreadClient {
    inner: Arc<CodexThreadClientInner>,
}

struct CodexThreadClientInner {
    stdin: AsyncMutex<ChildStdin>,
    _child: AsyncMutex<Child>,
    pending: AsyncMutex<HashMap<u64, PendingRequest>>,
    next_id: AtomicU64,
    events: broadcast::Sender<CodexRuntimeEvent>,
}

struct PendingRequest {
    method: &'static str,
    sender: oneshot::Sender<Result<Value, CodexThreadError>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexRuntimeEvent {
    Notification(CodexNotification),
    ServerRequest(CodexServerRequest),
    Error { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexThreadStart {
    pub thread_id: String,
    pub thread: CodexThread,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexTurnOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnStart {
    pub turn_id: String,
    pub turn: CodexTurn,
}

#[derive(Debug, thiserror::Error, Clone)]
pub enum CodexThreadError {
    #[error("Codex CLI is not available on this machine.")]
    MissingCli,
    #[error("Failed to start Codex app-server: {0}")]
    StartFailed(String),
    #[error("Codex app-server thread is unavailable: {0}")]
    ThreadUnavailable(String),
    #[allow(dead_code)]
    #[error("Codex app-server subscription was lost: {0}")]
    SubscriptionLost(String),
    #[error("Codex app-server rejected invalid parameters: {0}")]
    InvalidParams(String),
    #[error("Codex app-server protocol error: {0}")]
    Protocol(String),
    #[error("Codex app-server request timed out.")]
    Timeout,
    #[error("Codex app-server is unavailable.")]
    ProcessUnavailable,
}

impl CodexThreadError {
    #[allow(dead_code)]
    pub fn is_thread_unavailable(&self) -> bool {
        matches!(self, Self::ThreadUnavailable(_))
    }
}

impl CodexThreadClient {
    pub async fn start() -> Result<Self, CodexThreadError> {
        let mut child = Command::new("codex")
            .arg("app-server")
            .arg("--stdio")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                if error.kind() == ErrorKind::NotFound {
                    CodexThreadError::MissingCli
                } else {
                    CodexThreadError::StartFailed(error.to_string())
                }
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| CodexThreadError::Protocol("failed to open stdin".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| CodexThreadError::Protocol("failed to open stdout".to_string()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| CodexThreadError::Protocol("failed to open stderr".to_string()))?;
        let (events, _) = broadcast::channel(256);
        let client = Self {
            inner: Arc::new(CodexThreadClientInner {
                stdin: AsyncMutex::new(stdin),
                _child: AsyncMutex::new(child),
                pending: AsyncMutex::new(HashMap::new()),
                next_id: AtomicU64::new(100),
                events,
            }),
        };

        tokio::spawn(read_thread_server_loop(
            BufReader::new(stdout).lines(),
            client.inner.clone(),
        ));
        tokio::spawn(read_thread_server_stderr(
            BufReader::new(stderr).lines(),
            client.inner.events.clone(),
        ));

        client
            .request_value(
                INITIALIZE,
                json!({
                    "clientInfo": {
                        "name": "caffold",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true
                    },
                    "title": "Caffold"
                }),
            )
            .await?;
        client.notify(INITIALIZED, json!({})).await?;
        Ok(client)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CodexRuntimeEvent> {
        self.inner.events.subscribe()
    }

    pub async fn shutdown(&self) {
        fail_pending(&self.inner, CodexThreadError::ProcessUnavailable).await;
        let _ = self.inner.stdin.lock().await.shutdown().await;
        let mut child = self.inner._child.lock().await;
        let _ = child.start_kill();
        let _ = timeout(SHUTDOWN_TIMEOUT, child.wait()).await;
    }

    pub async fn list_threads(&self, limit: usize) -> Result<ThreadListResponse, CodexThreadError> {
        self.request_typed(THREAD_LIST, thread_list_params(limit))
            .await
    }

    pub async fn read_thread(
        &self,
        thread_id: &str,
        include_turns: bool,
    ) -> Result<CodexThread, CodexThreadError> {
        let response: ThreadReadResponse = self
            .request_typed(THREAD_READ, thread_read_params(thread_id, include_turns))
            .await?;
        Ok(response.thread)
    }

    pub async fn list_thread_turns(
        &self,
        thread_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<TurnsPage, CodexThreadError> {
        self.request_typed(
            THREAD_TURNS_LIST,
            thread_turns_list_params(thread_id, cursor, limit, SortDirection::Desc),
        )
        .await
    }

    pub async fn start_thread(&self, cwd: &str) -> Result<CodexThreadStart, CodexThreadError> {
        let typed: ThreadStartResponse = self
            .request_typed(THREAD_START, thread_start_params(cwd))
            .await?;
        let thread_id = typed.thread.id.clone();
        Ok(CodexThreadStart {
            thread_id,
            thread: typed.thread,
        })
    }

    pub async fn resume_thread_with_page(
        &self,
        thread_id: &str,
        initial_turns_page: bool,
    ) -> Result<ThreadResumeResponse, CodexThreadError> {
        self.request_typed(
            THREAD_RESUME,
            thread_resume_params(thread_id, initial_turns_page),
        )
        .await
    }

    pub async fn unsubscribe_thread(
        &self,
        thread_id: &str,
    ) -> Result<ThreadUnsubscribeResponse, CodexThreadError> {
        self.request_typed(THREAD_UNSUBSCRIBE, thread_unsubscribe_params(thread_id))
            .await
    }

    pub async fn archive_thread(&self, thread_id: &str) -> Result<(), CodexThreadError> {
        let _: EmptyResponse = self
            .request_typed(THREAD_ARCHIVE, thread_archive_params(thread_id))
            .await?;
        Ok(())
    }

    pub async fn start_turn(
        &self,
        thread_id: &str,
        cwd: &str,
        prompt: &str,
        image_urls: &[String],
        options: CodexTurnOptions,
    ) -> Result<CodexTurnStart, CodexThreadError> {
        let typed: TurnStartResponse = self
            .request_typed(
                TURN_START,
                turn_start_params(
                    thread_id,
                    cwd,
                    prompt,
                    image_urls,
                    options.model.as_deref(),
                    options.effort.as_deref(),
                ),
            )
            .await?;
        let turn_id = typed.turn.id.clone();
        Ok(CodexTurnStart {
            turn_id,
            turn: typed.turn,
        })
    }

    pub async fn steer_turn(
        &self,
        thread_id: &str,
        expected_turn_id: &str,
        prompt: &str,
        image_urls: &[String],
    ) -> Result<TurnSteerResponse, CodexThreadError> {
        self.request_typed(
            TURN_STEER,
            turn_steer_params(thread_id, expected_turn_id, prompt, image_urls),
        )
        .await
    }

    pub async fn interrupt_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<(), CodexThreadError> {
        let _: EmptyResponse = self
            .request_typed(TURN_INTERRUPT, turn_interrupt_params(thread_id, turn_id))
            .await?;
        Ok(())
    }

    pub async fn respond_to_server_request(
        &self,
        request_id: Value,
        result: Value,
    ) -> Result<(), CodexThreadError> {
        self.write_message(server_response_message(request_id, result))
            .await
    }

    pub async fn list_models(&self, limit: usize) -> Result<ModelListResponse, CodexThreadError> {
        self.request_typed(MODEL_LIST, model_list_params(limit))
            .await
    }

    async fn request_typed<T: DeserializeOwned, P: Serialize>(
        &self,
        method: &'static str,
        params: P,
    ) -> Result<T, CodexThreadError> {
        let value = serde_json::to_value(params)
            .map_err(|error| CodexThreadError::Protocol(error.to_string()))?;
        let response = self.request_value(method, value).await?;
        decode_response(method, response).map_err(CodexThreadError::Protocol)
    }

    async fn request_value(
        &self,
        method: &'static str,
        params: Value,
    ) -> Result<Value, CodexThreadError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.inner
            .pending
            .lock()
            .await
            .insert(id, PendingRequest { method, sender });

        let write_result = self
            .write_message(json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params
            }))
            .await;
        if let Err(error) = write_result {
            self.inner.pending.lock().await.remove(&id);
            return Err(error);
        }

        match timeout(THREAD_REQUEST_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CodexThreadError::ProcessUnavailable),
            Err(_) => {
                self.inner.pending.lock().await.remove(&id);
                Err(CodexThreadError::Timeout)
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), CodexThreadError> {
        self.write_message(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn write_message(&self, value: Value) -> Result<(), CodexThreadError> {
        let mut stdin = self.inner.stdin.lock().await;
        stdin
            .write_all(value.to_string().as_bytes())
            .await
            .map_err(|error| CodexThreadError::Protocol(error.to_string()))?;
        stdin
            .write_all(b"\n")
            .await
            .map_err(|error| CodexThreadError::Protocol(error.to_string()))?;
        stdin
            .flush()
            .await
            .map_err(|error| CodexThreadError::Protocol(error.to_string()))
    }
}

async fn read_thread_server_loop(
    mut lines: Lines<BufReader<ChildStdout>>,
    inner: Arc<CodexThreadClientInner>,
) {
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => {
                let _ = inner.events.send(CodexRuntimeEvent::Error {
                    message: "Codex app-server closed stdout.".to_string(),
                });
                fail_pending(&inner, CodexThreadError::ProcessUnavailable).await;
                return;
            }
            Err(error) => {
                let message = format!("Failed to read Codex app-server output: {error}");
                let _ = inner.events.send(CodexRuntimeEvent::Error {
                    message: message.clone(),
                });
                fail_pending(&inner, CodexThreadError::Protocol(message)).await;
                return;
            }
        };

        let value = match serde_json::from_str::<Value>(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };

        if let Some(method) = value.get("method").and_then(Value::as_str) {
            let params = value.get("params").cloned().unwrap_or(Value::Null);
            if let Some(id) = value.get("id") {
                match protocol::decode_server_request(id.clone(), method, params) {
                    Ok(request) => {
                        let _ = inner.events.send(CodexRuntimeEvent::ServerRequest(request));
                    }
                    Err(message) => {
                        let _ = inner.events.send(CodexRuntimeEvent::Error { message });
                    }
                }
            } else {
                match protocol::decode_notification(method, params) {
                    Ok(notification) => {
                        let _ = inner
                            .events
                            .send(CodexRuntimeEvent::Notification(notification));
                    }
                    Err(message) => {
                        let _ = inner.events.send(CodexRuntimeEvent::Error { message });
                    }
                }
            }
            continue;
        }

        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            continue;
        };
        let pending = inner.pending.lock().await.remove(&id);
        let result = if let Some(error) = value.get("error") {
            Err(classify_json_rpc_error(
                pending.as_ref().map(|request| request.method),
                error,
            ))
        } else {
            Ok(value.get("result").cloned().unwrap_or(Value::Null))
        };

        if let Some(pending) = pending {
            let _ = pending.sender.send(result);
        }
    }
}

fn classify_json_rpc_error(method: Option<&str>, value: &Value) -> CodexThreadError {
    let error = serde_json::from_value::<JsonRpcError>(value.clone()).unwrap_or(JsonRpcError {
        code: 0,
        message: "Codex app-server returned an invalid error response.".to_string(),
        data: Some(value.clone()),
    });
    if error.code == -32602 {
        CodexThreadError::InvalidParams(error.message)
    } else if error.code == -32600
        && matches!(
            method,
            Some(THREAD_READ | THREAD_RESUME | THREAD_TURNS_LIST)
        )
    {
        CodexThreadError::ThreadUnavailable(error.message)
    } else {
        CodexThreadError::Protocol(format!("{} (code {})", error.message, error.code))
    }
}

async fn read_thread_server_stderr(
    mut lines: Lines<BufReader<ChildStderr>>,
    events: broadcast::Sender<CodexRuntimeEvent>,
) {
    loop {
        match lines.next_line().await {
            Ok(Some(line)) if !line.trim().is_empty() => {
                let _ = events.send(CodexRuntimeEvent::Error {
                    message: format!("Codex app-server stderr: {line}"),
                });
            }
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(error) => {
                let _ = events.send(CodexRuntimeEvent::Error {
                    message: format!("Failed to read Codex app-server stderr: {error}"),
                });
                return;
            }
        }
    }
}

async fn fail_pending(inner: &CodexThreadClientInner, error: CodexThreadError) {
    let pending = std::mem::take(&mut *inner.pending.lock().await);
    for pending in pending.into_values() {
        let _ = pending.sender.send(Err(error.clone()));
    }
}

async fn read_app_server_status() -> Result<BTreeMap<u64, Value>, AppServerReadError> {
    let mut child = Command::new("codex")
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                AppServerReadError::MissingCli
            } else {
                AppServerReadError::StartFailed(format!(
                    "Failed to start Codex app-server: {error}"
                ))
            }
        })?;

    let mut stdin = child.stdin.take().ok_or_else(|| {
        AppServerReadError::Protocol("Failed to open Codex app-server stdin.".to_string())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppServerReadError::Protocol("Failed to open Codex app-server stdout.".to_string())
    })?;

    let messages = json_rpc_messages();
    stdin
        .write_all(messages.as_bytes())
        .await
        .map_err(|error| {
            AppServerReadError::Protocol(format!(
                "Failed to write Codex app-server request: {error}"
            ))
        })?;
    stdin.flush().await.map_err(|error| {
        AppServerReadError::Protocol(format!("Failed to flush Codex app-server request: {error}"))
    })?;

    let mut responses = BTreeMap::new();
    let mut lines = BufReader::new(stdout).lines();
    let deadline = Instant::now() + REQUEST_TIMEOUT;

    while !has_required_responses(&responses) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        let line = match timeout(remaining, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => {
                return Err(AppServerReadError::Protocol(format!(
                    "Failed to read Codex app-server response: {error}"
                )));
            }
            Err(_) => break,
        };

        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            continue;
        };
        responses.insert(id, value);
    }

    drop(stdin);
    let _ = child.start_kill();
    let _ = timeout(SHUTDOWN_TIMEOUT, child.wait()).await;

    Ok(responses)
}

fn json_rpc_messages() -> String {
    [
        json!({
            "jsonrpc": "2.0",
            "id": INITIALIZE_ID,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "caffold",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                },
                "title": "Caffold"
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        }),
        json!({
            "jsonrpc": "2.0",
            "id": ACCOUNT_ID,
            "method": "account/read",
            "params": {
                "proactivelyRefreshToken": false
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "id": RATE_LIMITS_ID,
            "method": "account/rateLimits/read",
            "params": {}
        }),
        json!({
            "jsonrpc": "2.0",
            "id": USAGE_ID,
            "method": "account/usage/read",
            "params": {}
        }),
    ]
    .into_iter()
    .map(|value| value.to_string())
    .collect::<Vec<_>>()
    .join("\n")
        + "\n"
}

fn has_required_responses(responses: &BTreeMap<u64, Value>) -> bool {
    responses.contains_key(&INITIALIZE_ID)
        && responses.contains_key(&ACCOUNT_ID)
        && responses.contains_key(&RATE_LIMITS_ID)
        && responses.contains_key(&USAGE_ID)
}

fn status_from_responses(responses: BTreeMap<u64, Value>) -> CodexStatusResponse {
    let app_server = response_result(&responses, INITIALIZE_ID)
        .and_then(|value| serde_json::from_value::<CodexAppServerInfo>(value.clone()).ok());
    let account_result = response_result(&responses, ACCOUNT_ID);
    let account_error = response_error_message(&responses, ACCOUNT_ID);
    let app_server_available = app_server.is_some()
        || account_result.is_some()
        || account_error.is_some()
        || responses.contains_key(&ACCOUNT_ID);

    let Some(account_result) = account_result else {
        return CodexStatusResponse {
            available: false,
            codex_cli_available: true,
            app_server_available,
            message: Some(
                account_error.unwrap_or_else(|| {
                    "Codex app-server did not return account status.".to_string()
                }),
            ),
            account: None,
            requires_openai_auth: None,
            rate_limits: response_result(&responses, RATE_LIMITS_ID).map(compact_rate_limits),
            usage: response_result(&responses, USAGE_ID).map(compact_usage),
            app_server,
        };
    };

    let account = account_result
        .get("account")
        .and_then(|value| serde_json::from_value::<CodexAccount>(value.clone()).ok());
    let requires_openai_auth = account_result
        .get("requiresOpenaiAuth")
        .and_then(Value::as_bool);

    let Some(account) = account else {
        let message = if requires_openai_auth == Some(true) {
            "Codex authentication is required.".to_string()
        } else {
            "Codex app-server account response was incomplete.".to_string()
        };

        return CodexStatusResponse {
            available: false,
            codex_cli_available: true,
            app_server_available,
            message: Some(message),
            account: None,
            requires_openai_auth,
            rate_limits: response_result(&responses, RATE_LIMITS_ID).map(compact_rate_limits),
            usage: response_result(&responses, USAGE_ID).map(compact_usage),
            app_server,
        };
    };

    CodexStatusResponse {
        available: true,
        codex_cli_available: true,
        app_server_available,
        message: None,
        account: Some(account),
        requires_openai_auth,
        rate_limits: response_result(&responses, RATE_LIMITS_ID).map(compact_rate_limits),
        usage: response_result(&responses, USAGE_ID).map(compact_usage),
        app_server,
    }
}

fn response_result(responses: &BTreeMap<u64, Value>, id: u64) -> Option<&Value> {
    responses.get(&id)?.get("result")
}

fn response_error_message(responses: &BTreeMap<u64, Value>, id: u64) -> Option<String> {
    responses
        .get(&id)?
        .get("error")?
        .get("message")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn compact_rate_limits(value: &Value) -> Value {
    let mut object = serde_json::Map::new();
    if let Some(rate_limit_reset_credits) = value.get("rateLimitResetCredits") {
        object.insert(
            "rateLimitResetCredits".to_string(),
            rate_limit_reset_credits.clone(),
        );
    }
    if let Some(rate_limits) = value.get("rateLimits") {
        object.insert("rateLimits".to_string(), rate_limits.clone());
    }

    if object.is_empty() {
        value.clone()
    } else {
        Value::Object(object)
    }
}

fn compact_usage(value: &Value) -> Value {
    match value.get("summary") {
        Some(summary) => json!({ "summary": summary }),
        None => value.clone(),
    }
}

fn server_response_message(request_id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result
    })
}

fn unavailable(
    codex_cli_available: bool,
    app_server_available: bool,
    message: String,
) -> CodexStatusResponse {
    CodexStatusResponse {
        available: false,
        codex_cli_available,
        app_server_available,
        message: Some(message),
        account: None,
        requires_openai_auth: None,
        rate_limits: None,
        usage: None,
        app_server: None,
    }
}

#[derive(Debug)]
enum AppServerReadError {
    MissingCli,
    StartFailed(String),
    Protocol(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_invalid_params_by_standard_code() {
        let error = classify_json_rpc_error(
            Some(TURN_START),
            &json!({
                "code": -32602,
                "message": "missing field `threadId`"
            }),
        );

        assert!(matches!(
            error,
            CodexThreadError::InvalidParams(message)
                if message == "missing field `threadId`"
        ));
    }

    #[test]
    fn classifies_unavailable_thread_by_request_method() {
        let error = classify_json_rpc_error(
            Some(THREAD_RESUME),
            &json!({
                "code": -32600,
                "message": "no rollout found for thread id example"
            }),
        );

        assert!(matches!(
            error,
            CodexThreadError::ThreadUnavailable(message)
                if message == "no rollout found for thread id example"
        ));
    }

    #[test]
    fn keeps_non_thread_request_failures_as_protocol_errors() {
        let error = classify_json_rpc_error(
            Some(TURN_START),
            &json!({
                "code": -32600,
                "message": "request rejected"
            }),
        );

        assert!(matches!(
            error,
            CodexThreadError::Protocol(message)
                if message == "request rejected (code -32600)"
        ));
    }

    #[test]
    fn builds_server_request_response_message() {
        assert_eq!(
            server_response_message(json!(11), json!({ "decision": "accept" })),
            json!({
                "jsonrpc": "2.0",
                "id": 11,
                "result": {
                    "decision": "accept"
                }
            })
        );
    }

    #[test]
    fn builds_available_status_from_account_response() {
        let status = status_from_responses(responses([
            (
                INITIALIZE_ID,
                json!({
                    "id": INITIALIZE_ID,
                    "result": {
                        "userAgent": "Codex Desktop/0.142.3",
                        "codexHome": "/Users/example/.codex",
                        "platformFamily": "unix",
                        "platformOs": "macos"
                    }
                }),
            ),
            (
                ACCOUNT_ID,
                json!({
                    "id": ACCOUNT_ID,
                    "result": {
                        "account": {
                            "type": "chatgpt",
                            "email": "user@example.com",
                            "planType": "pro"
                        },
                        "requiresOpenaiAuth": true
                    }
                }),
            ),
            (
                RATE_LIMITS_ID,
                json!({
                    "id": RATE_LIMITS_ID,
                    "result": {
                        "rateLimits": {
                            "primary": {
                                "usedPercent": 42
                            }
                        }
                    }
                }),
            ),
            (
                USAGE_ID,
                json!({
                    "id": USAGE_ID,
                    "result": {
                        "dailyUsageBuckets": [
                            {
                                "startDate": "2026-07-02",
                                "tokens": 777
                            }
                        ],
                        "summary": {
                            "lifetimeTokens": 123456
                        }
                    }
                }),
            ),
        ]));

        assert!(status.available);
        assert!(status.codex_cli_available);
        assert!(status.app_server_available);
        assert_eq!(status.message, None);
        assert_eq!(
            status.account,
            Some(CodexAccount {
                account_type: "chatgpt".to_string(),
                email: Some("user@example.com".to_string()),
                plan_type: Some("pro".to_string()),
            })
        );
        assert_eq!(status.requires_openai_auth, Some(true));
        assert_eq!(
            status
                .rate_limits
                .as_ref()
                .and_then(|value| value.pointer("/rateLimits/primary/usedPercent"))
                .and_then(Value::as_u64),
            Some(42)
        );
        assert_eq!(
            status
                .usage
                .as_ref()
                .and_then(|value| value.pointer("/summary/lifetimeTokens"))
                .and_then(Value::as_u64),
            Some(123456)
        );
        assert!(
            status
                .usage
                .as_ref()
                .and_then(|value| value.get("dailyUsageBuckets"))
                .is_none()
        );
    }

    #[test]
    fn keeps_account_available_when_usage_details_are_missing() {
        let status = status_from_responses(responses([(
            ACCOUNT_ID,
            json!({
                "id": ACCOUNT_ID,
                "result": {
                    "account": {
                        "type": "apiKey"
                    },
                    "requiresOpenaiAuth": false
                }
            }),
        )]));

        assert!(status.available);
        assert!(status.app_server_available);
        assert_eq!(
            status.account,
            Some(CodexAccount {
                account_type: "apiKey".to_string(),
                email: None,
                plan_type: None,
            })
        );
        assert_eq!(status.rate_limits, None);
        assert_eq!(status.usage, None);
    }

    #[test]
    fn maps_account_error_to_unavailable_status() {
        let status = status_from_responses(responses([(
            ACCOUNT_ID,
            json!({
                "id": ACCOUNT_ID,
                "error": {
                    "code": -32000,
                    "message": "not authenticated"
                }
            }),
        )]));

        assert!(!status.available);
        assert!(status.codex_cli_available);
        assert!(status.app_server_available);
        assert_eq!(status.message, Some("not authenticated".to_string()));
        assert_eq!(status.account, None);
    }

    fn responses<const N: usize>(entries: [(u64, Value); N]) -> BTreeMap<u64, Value> {
        entries.into_iter().collect()
    }
}
