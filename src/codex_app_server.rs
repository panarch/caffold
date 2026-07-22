#[cfg(test)]
use std::collections::VecDeque;
use std::{
    collections::HashMap,
    env,
    ffi::OsStr,
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

mod protocol;

use protocol::{
    ACCOUNT_RATE_LIMITS_READ, ACCOUNT_READ, ACCOUNT_USAGE_READ, AccountReadResponse, EmptyResponse,
    INITIALIZE, INITIALIZED, JsonRpcError, MODEL_LIST, THREAD_ARCHIVE, THREAD_LIST, THREAD_READ,
    THREAD_RESUME, THREAD_START, THREAD_TURNS_LIST, THREAD_UNSUBSCRIBE, TURN_INTERRUPT, TURN_START,
    TURN_STEER, ThreadListResponse, ThreadReadResponse, ThreadStartResponse, TurnStartResponse,
    TurnSteerResponse, account_read_params, decode_response, model_list_params,
    thread_archive_params, thread_list_params, thread_read_params, thread_resume_params,
    thread_start_params, thread_turns_list_params, thread_unsubscribe_params,
    turn_interrupt_params, turn_start_params, turn_steer_params,
};
pub use protocol::{
    CodexAccount, CodexAppServerInfo, CodexNotification, CodexServerRequest, CodexThread,
    CodexTurn, ModelListResponse, SortDirection, ThreadResumeResponse, ThreadStatus,
    ThreadUnsubscribeResponse, TurnStatus, TurnsPage,
};
#[cfg(test)]
use protocol::{THREAD_LOADED_LIST, ThreadLoadedListResponse, thread_loaded_list_params};
#[cfg(test)]
pub(crate) use protocol::{TurnItemsView, decode_notification, decode_server_request};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    io::{AsyncRead, Lines},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Mutex as AsyncMutex, broadcast, oneshot},
    time::timeout,
};

const INTERACTIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const HISTORY_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn find_executable_in_path(command: &OsStr, search_path: Option<&OsStr>) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return is_executable_file(command_path).then(|| command_path.to_path_buf());
    }

    search_path.and_then(|search_path| {
        env::split_paths(search_path)
            .map(|directory| directory.join(command_path))
            .find(|candidate| is_executable_file(candidate))
    })
}

fn resolve_codex_executable_from(
    explicit: Option<&OsStr>,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
    platform_paths: &[PathBuf],
) -> Result<PathBuf, CodexThreadError> {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return find_executable_in_path(explicit, search_path).ok_or_else(|| {
            CodexThreadError::StartFailed(format!(
                "CAFFOLD_CODEX_BIN does not point to an executable: {}",
                Path::new(explicit).display()
            ))
        });
    }

    if let Some(path) = find_executable_in_path(OsStr::new("codex"), search_path) {
        return Ok(path);
    }

    let fallback_paths = home
        .into_iter()
        .map(|home| home.join(".local/bin/codex"))
        .chain(platform_paths.iter().cloned());
    fallback_paths
        .into_iter()
        .find(|candidate| is_executable_file(candidate))
        .ok_or(CodexThreadError::MissingCli)
}

fn resolve_codex_executable() -> Result<PathBuf, CodexThreadError> {
    let explicit = env::var_os("CAFFOLD_CODEX_BIN");
    let search_path = env::var_os("PATH");
    let home = env::var_os("HOME").map(PathBuf::from);
    resolve_codex_executable_from(
        explicit.as_deref(),
        search_path.as_deref(),
        home.as_deref(),
        &[
            PathBuf::from("/opt/homebrew/bin/codex"),
            PathBuf::from("/usr/local/bin/codex"),
        ],
    )
}

fn request_timeout(method: &str) -> Duration {
    match method {
        THREAD_LIST | THREAD_READ | THREAD_RESUME | THREAD_TURNS_LIST => HISTORY_REQUEST_TIMEOUT,
        _ => INTERACTIVE_REQUEST_TIMEOUT,
    }
}

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

#[derive(Clone)]
pub struct CodexThreadClient {
    inner: Option<Arc<CodexThreadClientInner>>,
    #[cfg(test)]
    mock: Option<Arc<MockCodexThreadClient>>,
}

#[cfg(test)]
struct MockCodexThreadClient {
    responses: AsyncMutex<VecDeque<MockCodexResponse>>,
    requests: AsyncMutex<Vec<(String, Value)>>,
    events: broadcast::Sender<CodexRuntimeEvent>,
}

#[cfg(test)]
pub(crate) struct MockCodexResponse {
    method: &'static str,
    result: Result<Value, CodexThreadError>,
    delay: Duration,
}

#[cfg(test)]
impl MockCodexResponse {
    pub(crate) fn ok<T: Serialize>(method: &'static str, value: T) -> Self {
        Self {
            method,
            result: serde_json::to_value(value)
                .map_err(|error| CodexThreadError::Protocol(error.to_string())),
            delay: Duration::ZERO,
        }
    }

    pub(crate) fn error(method: &'static str, error: CodexThreadError) -> Self {
        Self {
            method,
            result: Err(error),
            delay: Duration::ZERO,
        }
    }

    pub(crate) fn delayed_ok<T: Serialize>(
        method: &'static str,
        value: T,
        delay: Duration,
    ) -> Self {
        Self {
            method,
            result: serde_json::to_value(value)
                .map_err(|error| CodexThreadError::Protocol(error.to_string())),
            delay,
        }
    }
}

struct CodexThreadClientInner {
    stdin: AsyncMutex<ChildStdin>,
    _child: AsyncMutex<Child>,
    pending: AsyncMutex<HashMap<u64, PendingRequest>>,
    next_id: AtomicU64,
    events: broadcast::Sender<CodexRuntimeEvent>,
    app_server: AsyncMutex<Option<CodexAppServerInfo>>,
}

struct PendingRequest {
    method: &'static str,
    sender: oneshot::Sender<Result<Value, CodexThreadError>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CodexRuntimeEvent {
    Notification(CodexNotification),
    ServerRequest(CodexServerRequest),
    Diagnostic { message: String },
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
    #[error("Codex app-server {method} request {request_id} timed out after {timeout_ms}ms.")]
    RequestTimeout {
        method: &'static str,
        request_id: u64,
        timeout_ms: u64,
    },
    #[error("Codex app-server is unavailable.")]
    ProcessUnavailable,
}

impl CodexThreadError {
    #[allow(dead_code)]
    pub fn is_thread_unavailable(&self) -> bool {
        matches!(self, Self::ThreadUnavailable(_))
    }

    pub fn is_connection_failure(&self) -> bool {
        matches!(self, Self::ProcessUnavailable)
    }
}

impl CodexThreadClient {
    pub async fn start() -> Result<Self, CodexThreadError> {
        let codex_executable = resolve_codex_executable()?;
        let mut child = Command::new(codex_executable)
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
            inner: Some(Arc::new(CodexThreadClientInner {
                stdin: AsyncMutex::new(stdin),
                _child: AsyncMutex::new(child),
                pending: AsyncMutex::new(HashMap::new()),
                next_id: AtomicU64::new(100),
                events,
                app_server: AsyncMutex::new(None),
            })),
            #[cfg(test)]
            mock: None,
        };

        let inner = client.inner();

        tokio::spawn(read_thread_server_loop(
            BufReader::new(stdout).lines(),
            inner.clone(),
        ));
        tokio::spawn(read_thread_server_stderr(
            BufReader::new(stderr).lines(),
            inner.events.clone(),
        ));

        let app_server = client
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
            .await
            .and_then(|value| {
                decode_response(INITIALIZE, value).map_err(CodexThreadError::Protocol)
            })?;
        *inner.app_server.lock().await = Some(app_server);
        client.notify(INITIALIZED, json!({})).await?;
        Ok(client)
    }

    fn inner(&self) -> &Arc<CodexThreadClientInner> {
        self.inner
            .as_ref()
            .expect("process-backed Codex client is required")
    }

    #[cfg(test)]
    pub(crate) fn mock(responses: Vec<MockCodexResponse>) -> Self {
        let (events, _) = broadcast::channel(32);
        Self {
            inner: None,
            mock: Some(Arc::new(MockCodexThreadClient {
                responses: AsyncMutex::new(responses.into()),
                requests: AsyncMutex::new(Vec::new()),
                events,
            })),
        }
    }

    #[cfg(test)]
    pub(crate) async fn mock_requests(&self) -> Vec<(String, Value)> {
        self.mock
            .as_ref()
            .expect("mock Codex client is required")
            .requests
            .lock()
            .await
            .clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CodexRuntimeEvent> {
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            return mock.events.subscribe();
        }
        self.inner().events.subscribe()
    }

    pub async fn shutdown(&self) {
        #[cfg(test)]
        if self.mock.is_some() {
            return;
        }
        let inner = self.inner();
        fail_pending(inner, CodexThreadError::ProcessUnavailable).await;
        let _ = inner.stdin.lock().await.shutdown().await;
        let mut child = inner._child.lock().await;
        let _ = child.start_kill();
        let _ = timeout(SHUTDOWN_TIMEOUT, child.wait()).await;
    }

    pub async fn list_threads(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ThreadListResponse, CodexThreadError> {
        self.request_typed(THREAD_LIST, thread_list_params(cursor, limit))
            .await
    }

    pub async fn read_thread(&self, thread_id: &str) -> Result<CodexThread, CodexThreadError> {
        let response: ThreadReadResponse = self
            .request_typed(THREAD_READ, thread_read_params(thread_id))
            .await?;
        Ok(response.thread)
    }

    #[cfg(test)]
    pub async fn list_loaded_threads(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ThreadLoadedListResponse, CodexThreadError> {
        self.request_typed(THREAD_LOADED_LIST, thread_loaded_list_params(cursor, limit))
            .await
    }

    pub async fn list_thread_turns(
        &self,
        thread_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<TurnsPage, CodexThreadError> {
        self.list_thread_turns_in_direction(thread_id, cursor, limit, SortDirection::Desc)
            .await
    }

    pub async fn list_thread_turns_in_direction(
        &self,
        thread_id: &str,
        cursor: Option<&str>,
        limit: usize,
        sort_direction: SortDirection,
    ) -> Result<TurnsPage, CodexThreadError> {
        self.request_typed(
            THREAD_TURNS_LIST,
            thread_turns_list_params(thread_id, cursor, limit, sort_direction),
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

    pub async fn status(&self) -> CodexStatusResponse {
        let app_server = self.inner().app_server.lock().await.clone();
        let (account, rate_limits, usage) = tokio::join!(
            self.request_typed::<AccountReadResponse, _>(ACCOUNT_READ, account_read_params()),
            self.request_typed::<Value, _>(ACCOUNT_RATE_LIMITS_READ, EmptyResponse::default()),
            self.request_typed::<Value, _>(ACCOUNT_USAGE_READ, EmptyResponse::default()),
        );
        status_from_results(app_server, account, rate_limits.ok(), usage.ok())
    }

    pub fn unavailable_status(error: &CodexThreadError) -> CodexStatusResponse {
        unavailable(
            !matches!(error, CodexThreadError::MissingCli),
            false,
            error.to_string(),
        )
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
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            mock.requests
                .lock()
                .await
                .push((method.to_string(), params));
            let response = {
                let mut responses = mock.responses.lock().await;
                let index = responses
                    .iter()
                    .position(|response| response.method == method)
                    .ok_or_else(|| {
                        CodexThreadError::Protocol(format!(
                            "mock Codex client has no response for {method}"
                        ))
                    })?;
                responses
                    .remove(index)
                    .expect("matching mock response index remains valid")
            };
            if !response.delay.is_zero() {
                tokio::time::sleep(response.delay).await;
            }
            if let Err(error) = &response.result {
                self.publish_request_error(method, error);
            }
            return response.result;
        }

        let inner = self.inner();
        let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        inner
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
            inner.pending.lock().await.remove(&id);
            self.publish_request_error(method, &error);
            return Err(error);
        }

        let request_timeout = request_timeout(method);
        match timeout(request_timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                let error = CodexThreadError::ProcessUnavailable;
                self.publish_request_error(method, &error);
                Err(error)
            }
            Err(_) => {
                inner.pending.lock().await.remove(&id);
                let error = CodexThreadError::RequestTimeout {
                    method,
                    request_id: id,
                    timeout_ms: request_timeout.as_millis() as u64,
                };
                self.publish_request_error(method, &error);
                Err(error)
            }
        }
    }

    fn publish_request_error(&self, method: &'static str, error: &CodexThreadError) {
        if !error.is_connection_failure() {
            return;
        }
        let Some(inner) = &self.inner else {
            #[cfg(test)]
            if let Some(mock) = &self.mock {
                let _ = mock.events.send(CodexRuntimeEvent::Error {
                    message: format!("Codex app-server {method} request {error}"),
                });
            }
            return;
        };
        let _ = inner.events.send(CodexRuntimeEvent::Error {
            message: format!("Codex app-server {method} request {error}"),
        });
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
        let mut stdin = self.inner().stdin.lock().await;
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
    } else if error.code == -32600 && matches!(method, Some(THREAD_RESUME | THREAD_TURNS_LIST)) {
        CodexThreadError::ThreadUnavailable(error.message)
    } else {
        CodexThreadError::Protocol(format!("{} (code {})", error.message, error.code))
    }
}

async fn read_thread_server_stderr<R>(
    mut lines: Lines<BufReader<R>>,
    events: broadcast::Sender<CodexRuntimeEvent>,
) where
    R: AsyncRead + Unpin,
{
    loop {
        match lines.next_line().await {
            Ok(Some(line)) if !line.trim().is_empty() => {
                let _ = events.send(CodexRuntimeEvent::Diagnostic {
                    message: format!("Codex app-server stderr: {line}"),
                });
            }
            Ok(Some(_)) => {}
            Ok(None) => return,
            Err(error) => {
                let _ = events.send(CodexRuntimeEvent::Diagnostic {
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

fn status_from_results(
    app_server: Option<CodexAppServerInfo>,
    account_result: Result<AccountReadResponse, CodexThreadError>,
    rate_limits: Option<Value>,
    usage: Option<Value>,
) -> CodexStatusResponse {
    let account_result = match account_result {
        Ok(account_result) => account_result,
        Err(error) => {
            return CodexStatusResponse {
                available: false,
                codex_cli_available: true,
                app_server_available: true,
                message: Some(error.to_string()),
                account: None,
                requires_openai_auth: None,
                rate_limits: rate_limits.as_ref().map(compact_rate_limits),
                usage: usage.as_ref().map(compact_usage),
                app_server,
            };
        }
    };
    let AccountReadResponse {
        account,
        requires_openai_auth,
    } = account_result;

    let Some(account) = account else {
        let message = if requires_openai_auth {
            "Codex authentication is required.".to_string()
        } else {
            "Codex app-server account response was incomplete.".to_string()
        };

        return CodexStatusResponse {
            available: false,
            codex_cli_available: true,
            app_server_available: true,
            message: Some(message),
            account: None,
            requires_openai_auth: Some(requires_openai_auth),
            rate_limits: rate_limits.as_ref().map(compact_rate_limits),
            usage: usage.as_ref().map(compact_usage),
            app_server,
        };
    };

    CodexStatusResponse {
        available: true,
        codex_cli_available: true,
        app_server_available: true,
        message: None,
        account: Some(account),
        requires_openai_auth: Some(requires_openai_auth),
        rate_limits: rate_limits.as_ref().map(compact_rate_limits),
        usage: usage.as_ref().map(compact_usage),
        app_server,
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write_executable(path: &Path) {
        std::fs::write(path, "#!/bin/sh\n").expect("write executable fixture");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
                .expect("mark fixture executable");
        }
    }

    #[test]
    fn resolves_explicit_codex_binary_before_all_fallbacks() {
        let temp = tempfile::tempdir().expect("create temp directory");
        let explicit = temp.path().join("explicit-codex");
        let path_directory = temp.path().join("path");
        std::fs::create_dir(&path_directory).expect("create PATH directory");
        let path_codex = path_directory.join("codex");
        write_executable(&explicit);
        write_executable(&path_codex);
        let search_path = env::join_paths([&path_directory]).expect("join PATH");

        assert_eq!(
            resolve_codex_executable_from(
                Some(explicit.as_os_str()),
                Some(search_path.as_os_str()),
                Some(temp.path()),
                &[],
            )
            .expect("resolve explicit executable"),
            explicit
        );
    }

    #[test]
    fn resolves_codex_from_path_before_standard_install_locations() {
        let temp = tempfile::tempdir().expect("create temp directory");
        let path_directory = temp.path().join("path");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir(&path_directory).expect("create PATH directory");
        std::fs::create_dir_all(&home_bin).expect("create home bin directory");
        let path_codex = path_directory.join("codex");
        let home_codex = home_bin.join("codex");
        write_executable(&path_codex);
        write_executable(&home_codex);
        let search_path = env::join_paths([&path_directory]).expect("join PATH");

        assert_eq!(
            resolve_codex_executable_from(
                None,
                Some(search_path.as_os_str()),
                Some(temp.path()),
                &[],
            )
            .expect("resolve PATH executable"),
            path_codex
        );
    }

    #[test]
    fn resolves_install_script_codex_from_the_user_home() {
        let temp = tempfile::tempdir().expect("create temp directory");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create home bin directory");
        let home_codex = home_bin.join("codex");
        write_executable(&home_codex);

        assert_eq!(
            resolve_codex_executable_from(None, None, Some(temp.path()), &[])
                .expect("resolve home executable"),
            home_codex
        );
    }

    #[test]
    fn rejects_an_invalid_explicit_codex_binary_without_silent_fallback() {
        let temp = tempfile::tempdir().expect("create temp directory");
        let fallback = temp.path().join("fallback-codex");
        write_executable(&fallback);
        let missing = temp.path().join("missing-codex");

        assert!(matches!(
            resolve_codex_executable_from(
                Some(missing.as_os_str()),
                None,
                Some(temp.path()),
                &[fallback],
            ),
            Err(CodexThreadError::StartFailed(message))
                if message.contains("CAFFOLD_CODEX_BIN")
                    && message.contains("missing-codex")
        ));
    }

    #[test]
    fn reports_missing_cli_after_all_locations_are_exhausted() {
        let temp = tempfile::tempdir().expect("create temp directory");

        assert!(matches!(
            resolve_codex_executable_from(None, None, Some(temp.path()), &[]),
            Err(CodexThreadError::MissingCli)
        ));
    }

    #[tokio::test]
    #[ignore = "requires a real Codex task ID and authenticated Codex CLI"]
    async fn probes_live_thread_state_through_the_official_protocol() {
        use std::time::Instant;

        let thread_id = std::env::var("CAFFOLD_CODEX_PROBE_THREAD_ID")
            .expect("set CAFFOLD_CODEX_PROBE_THREAD_ID to a real Codex task ID");
        let client = CodexThreadClient::start()
            .await
            .expect("start Codex app-server");

        let list_started = Instant::now();
        let listed = client
            .list_threads(None, 100)
            .await
            .expect("list live Codex tasks")
            .data
            .into_iter()
            .find(|thread| thread.id == thread_id);
        let list_elapsed = list_started.elapsed();
        let loaded_started = Instant::now();
        let loaded = client
            .list_loaded_threads(None, 100)
            .await
            .expect("list loaded Codex tasks");
        let loaded_elapsed = loaded_started.elapsed();
        let resume_started = Instant::now();
        let resumed = client
            .resume_thread_with_page(&thread_id, true)
            .await
            .expect("resume live Codex task state");
        let resume_elapsed = resume_started.elapsed();

        eprintln!(
            "LIVE_CODEX_PROBE list_ms={} listed_status={:?} loaded_ms={} loaded={} resume_ms={} resume_status={:?} resume_turns={}",
            list_elapsed.as_millis(),
            listed.as_ref().map(|thread| &thread.status),
            loaded_elapsed.as_millis(),
            loaded.data.iter().any(|loaded_id| loaded_id == &thread_id),
            resume_elapsed.as_millis(),
            resumed.thread.status,
            resumed
                .initial_turns_page
                .as_ref()
                .map_or(0, |page| page.data.len()),
        );
        client.shutdown().await;
    }

    #[test]
    fn gives_history_requests_enough_time_for_large_rollouts() {
        for method in [THREAD_LIST, THREAD_READ, THREAD_RESUME, THREAD_TURNS_LIST] {
            assert_eq!(
                request_timeout(method),
                Duration::from_secs(120),
                "{method} should allow large Codex histories to load"
            );
        }
    }

    #[test]
    fn keeps_interactive_requests_on_the_short_timeout() {
        for method in [TURN_START, TURN_STEER, TURN_INTERRUPT, THREAD_ARCHIVE] {
            assert_eq!(
                request_timeout(method),
                Duration::from_secs(30),
                "{method} should fail promptly when the app-server is unavailable"
            );
        }
    }

    #[test]
    fn request_timeout_errors_identify_the_rpc_request() {
        let error = CodexThreadError::RequestTimeout {
            method: THREAD_RESUME,
            request_id: 42,
            timeout_ms: HISTORY_REQUEST_TIMEOUT.as_millis() as u64,
        };

        assert_eq!(
            error.to_string(),
            "Codex app-server thread/resume request 42 timed out after 120000ms."
        );
        assert!(!error.is_connection_failure());
    }

    #[tokio::test]
    async fn lists_threads_from_the_app_server_state_db() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            THREAD_LIST,
            ThreadListResponse {
                data: Vec::new(),
                next_cursor: None,
                backwards_cursor: None,
            },
        )]);

        client.list_threads(None, 100).await.expect("list threads");

        assert_eq!(
            client.mock_requests().await,
            vec![(
                THREAD_LIST.to_string(),
                json!({
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true
                })
            )]
        );
    }

    #[tokio::test]
    async fn request_timeouts_do_not_publish_a_connection_error() {
        let request_error = CodexThreadError::RequestTimeout {
            method: THREAD_LIST,
            request_id: 7,
            timeout_ms: HISTORY_REQUEST_TIMEOUT.as_millis() as u64,
        };
        let client =
            CodexThreadClient::mock(vec![MockCodexResponse::error(THREAD_LIST, request_error)]);
        let mut events = client.subscribe();

        assert!(matches!(
            client.list_threads(None, 100).await,
            Err(CodexThreadError::RequestTimeout {
                method: THREAD_LIST,
                request_id: 7,
                timeout_ms: 120_000,
            })
        ));
        assert!(
            timeout(Duration::from_millis(100), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn treats_app_server_stderr_as_diagnostic_output() {
        let (mut writer, reader) = tokio::io::duplex(256);
        let (events, mut receiver) = broadcast::channel(4);
        let reader = tokio::spawn(read_thread_server_stderr(
            BufReader::new(reader).lines(),
            events,
        ));

        writer
            .write_all(b"warning: diagnostic only\n")
            .await
            .expect("write stderr fixture");
        writer.shutdown().await.expect("close stderr fixture");

        assert_eq!(
            timeout(Duration::from_secs(1), receiver.recv())
                .await
                .expect("receive diagnostic")
                .expect("diagnostic channel remains readable"),
            CodexRuntimeEvent::Diagnostic {
                message: "Codex app-server stderr: warning: diagnostic only".to_string(),
            }
        );
        reader.await.expect("stderr reader exits cleanly");
    }

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
        let status = status_from_results(
            Some(CodexAppServerInfo {
                user_agent: Some("Codex Desktop/0.142.3".to_string()),
                codex_home: Some("/Users/example/.codex".to_string()),
                platform_family: Some("unix".to_string()),
                platform_os: Some("macos".to_string()),
            }),
            Ok(AccountReadResponse {
                account: Some(CodexAccount {
                    account_type: "chatgpt".to_string(),
                    email: Some("user@example.com".to_string()),
                    plan_type: Some("pro".to_string()),
                }),
                requires_openai_auth: true,
            }),
            Some(json!({
                "rateLimits": {
                    "primary": {
                        "usedPercent": 42
                    }
                }
            })),
            Some(json!({
                "dailyUsageBuckets": [
                    {
                        "startDate": "2026-07-02",
                        "tokens": 777
                    }
                ],
                "summary": {
                    "lifetimeTokens": 123456
                }
            })),
        );

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
        let status = status_from_results(
            None,
            Ok(AccountReadResponse {
                account: Some(CodexAccount {
                    account_type: "apiKey".to_string(),
                    email: None,
                    plan_type: None,
                }),
                requires_openai_auth: false,
            }),
            None,
            None,
        );

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
        let status = status_from_results(
            None,
            Err(CodexThreadError::Protocol(
                "not authenticated (code -32000)".to_string(),
            )),
            None,
            None,
        );

        assert!(!status.available);
        assert!(status.codex_cli_available);
        assert!(status.app_server_available);
        assert_eq!(
            status.message,
            Some("Codex app-server protocol error: not authenticated (code -32000)".to_string())
        );
        assert_eq!(status.account, None);
    }

    #[test]
    fn maps_missing_account_to_authentication_required() {
        let status = status_from_results(
            None,
            Ok(AccountReadResponse {
                account: None,
                requires_openai_auth: true,
            }),
            None,
            None,
        );

        assert!(!status.available);
        assert_eq!(
            status.message,
            Some("Codex authentication is required.".to_string())
        );
        assert_eq!(status.requires_openai_auth, Some(true));
    }
}
