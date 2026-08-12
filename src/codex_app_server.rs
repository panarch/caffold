#[cfg(test)]
use std::collections::VecDeque;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use futures_util::{SinkExt, StreamExt, stream::SplitSink, stream::SplitStream};
mod protocol;
mod readiness;
#[cfg(test)]
mod reconnect_spike;
mod status;
mod transport;

use protocol::{
    ACCOUNT_RATE_LIMITS_READ, ACCOUNT_READ, ACCOUNT_USAGE_READ, AccountReadResponse, CONFIG_READ,
    ConfigReadResponse, EmptyResponse, INITIALIZE, INITIALIZED, JsonRpcError, MODEL_LIST,
    PERMISSION_PROFILE_LIST, PermissionProfileListResponse, THREAD_ARCHIVE, THREAD_DELETE,
    THREAD_LIST, THREAD_NAME_SET, THREAD_READ, THREAD_RESUME, THREAD_START, THREAD_TURNS_LIST,
    THREAD_UNARCHIVE, THREAD_UNSUBSCRIBE, TURN_INTERRUPT, TURN_START, TURN_STEER,
    ThreadReadResponse, ThreadStartResponse, TurnStartResponse, TurnSteerResponse,
    account_read_params, config_read_params, decode_response, model_list_params,
    permission_profile_list_params, thread_archive_params, thread_delete_params,
    thread_read_params, thread_resume_params, thread_set_name_params, thread_start_params,
    thread_turns_list_params, thread_unarchive_params, thread_unsubscribe_params,
    turn_interrupt_params, turn_start_params, turn_steer_params,
};
pub use protocol::{
    CodexAppServerInfo, CodexNotification, CodexPermissionMode, CodexServerRequest, CodexThread,
    CodexTurn, ModelListResponse, PermissionProfileSummary, SortDirection, ThreadResumeResponse,
    ThreadStatus, ThreadUnsubscribeResponse, TurnStatus, TurnsPage,
};
pub(crate) use protocol::{ISOLATE_CURRENT_TASK_TOOL_NAME, RENAME_CURRENT_THREAD_TOOL_NAME};
use protocol::{THREAD_LOADED_LIST, ThreadLoadedListResponse, thread_loaded_list_params};
#[cfg(test)]
use protocol::{ThreadListResponse, thread_list_params};
#[cfg(test)]
pub(crate) use protocol::{TurnItemsView, decode_notification, decode_server_request};
#[cfg(test)]
pub(crate) use readiness::MINIMUM_SUPPORTED_CODEX_CLI_VERSION;
pub(crate) use readiness::{CodexInstallation, inspect_codex_installation};
pub use readiness::{CodexReadiness, CodexReadinessReason, CodexReadinessState};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
pub use status::{CodexDaemonInfo, CodexStatusResponse};
use status::{status_from_results, unavailable_status};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    io::{AsyncRead, Lines},
    process::Child,
    sync::{Mutex as AsyncMutex, broadcast, oneshot},
    time::timeout,
};
use tokio_tungstenite::{WebSocketStream, tungstenite::Message};
use transport::ProxyStream;

const INTERACTIVE_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const HISTORY_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);

fn request_timeout(method: &str) -> Duration {
    match method {
        THREAD_LIST | THREAD_LOADED_LIST | THREAD_READ | THREAD_RESUME | THREAD_TURNS_LIST => {
            HISTORY_REQUEST_TIMEOUT
        }
        _ => INTERACTIVE_REQUEST_TIMEOUT,
    }
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
    server_responses: AsyncMutex<Vec<(Value, Value)>>,
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
    writer: AsyncMutex<SplitSink<WebSocketStream<ProxyStream>, Message>>,
    _child: AsyncMutex<Child>,
    pending: AsyncMutex<HashMap<u64, PendingRequest>>,
    next_id: AtomicU64,
    events: broadcast::Sender<CodexRuntimeEvent>,
    app_server: AsyncMutex<Option<CodexAppServerInfo>>,
    daemon: CodexDaemonInfo,
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
    pub permission_mode: Option<CodexPermissionMode>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexTurnOptions {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub service_tier: Option<String>,
    pub permission_mode: Option<CodexPermissionMode>,
}

pub(crate) const NORMAL_SERVICE_TIER_ID: &str = "default";
pub(crate) const FAST_SERVICE_TIER_ID: &str = "priority";

pub(crate) fn service_tier_for_fast_mode(fast_mode: bool) -> &'static str {
    if fast_mode {
        FAST_SERVICE_TIER_ID
    } else {
        NORMAL_SERVICE_TIER_ID
    }
}

pub(crate) fn is_fast_service_tier(service_tier: Option<&str>) -> bool {
    service_tier.is_some_and(|tier| tier.trim().eq_ignore_ascii_case(FAST_SERVICE_TIER_ID))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexTurnStart {
    pub turn_id: String,
    pub turn: CodexTurn,
}

#[derive(Debug, thiserror::Error, Clone)]
pub enum CodexThreadError {
    #[error("{}", .0.diagnostic_message)]
    Readiness(Box<CodexReadiness>),
    #[error("Failed to start Codex app-server: {0}")]
    StartFailed(String),
    #[error("Codex app-server {phase} timed out after {timeout_ms}ms.")]
    StartupTimeout {
        phase: &'static str,
        timeout_ms: u64,
    },
    #[error("Codex app-server protocol initialization failed: {message}")]
    InitializationFailed {
        message: String,
        daemon: Box<CodexDaemonInfo>,
    },
    #[error("Codex app-server thread is unavailable: {0}")]
    ThreadUnavailable(String),
    #[error("Codex app-server active turn is unavailable: {0}")]
    TurnUnavailable(String),
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

    pub fn is_turn_unavailable(&self) -> bool {
        matches!(self, Self::TurnUnavailable(_))
    }
}

impl CodexThreadClient {
    pub(crate) async fn start_with_installation(
        installation: &CodexInstallation,
    ) -> Result<Self, CodexThreadError> {
        let daemon = transport::ensure_daemon(&installation.path).await?;
        let proxy = transport::connect_proxy(&installation.path, None)
            .await
            .map_err(|error| CodexThreadError::InitializationFailed {
                message: error.to_string(),
                daemon: Box::new(daemon.clone()),
            })?;
        let transport::ProxyConnection {
            socket,
            child,
            stderr,
        } = proxy;
        let (writer, reader) = socket.split();
        let (events, _) = broadcast::channel(256);
        let client = Self {
            inner: Some(Arc::new(CodexThreadClientInner {
                writer: AsyncMutex::new(writer),
                _child: AsyncMutex::new(child),
                pending: AsyncMutex::new(HashMap::new()),
                next_id: AtomicU64::new(100),
                events,
                app_server: AsyncMutex::new(None),
                daemon,
            })),
            #[cfg(test)]
            mock: None,
        };

        let inner = client.inner();

        tokio::spawn(read_thread_server_loop(reader, inner.clone()));
        tokio::spawn(read_thread_server_stderr(
            BufReader::new(stderr).lines(),
            inner.events.clone(),
        ));

        let app_server = match client
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
            }) {
            Ok(app_server) => app_server,
            Err(error) => {
                client.shutdown().await;
                return Err(CodexThreadError::InitializationFailed {
                    message: error.to_string(),
                    daemon: Box::new(inner.daemon.clone()),
                });
            }
        };
        *inner.app_server.lock().await = Some(app_server);
        if let Err(error) = client.notify(INITIALIZED, json!({})).await {
            client.shutdown().await;
            return Err(CodexThreadError::InitializationFailed {
                message: error.to_string(),
                daemon: Box::new(inner.daemon.clone()),
            });
        }
        Ok(client)
    }

    pub(crate) async fn restart_daemon() -> Result<CodexDaemonInfo, CodexThreadError> {
        let installation = inspect_codex_installation()
            .await
            .map_err(|readiness| CodexThreadError::Readiness(Box::new(readiness)))?;
        transport::restart_daemon(&installation.path).await
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
                server_responses: AsyncMutex::new(Vec::new()),
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

    #[cfg(test)]
    pub(crate) async fn mock_server_responses(&self) -> Vec<(Value, Value)> {
        self.mock
            .as_ref()
            .expect("mock Codex client is required")
            .server_responses
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
        let _ = timeout(SHUTDOWN_TIMEOUT, inner.writer.lock().await.close()).await;
        let mut child = inner._child.lock().await;
        let _ = child.start_kill();
        let _ = timeout(SHUTDOWN_TIMEOUT, child.wait()).await;
    }

    #[cfg(test)]
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

    pub async fn set_thread_name(
        &self,
        thread_id: &str,
        name: &str,
    ) -> Result<(), CodexThreadError> {
        let _: EmptyResponse = self
            .request_typed(THREAD_NAME_SET, thread_set_name_params(thread_id, name))
            .await?;
        Ok(())
    }

    pub async fn list_loaded_threads(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<ThreadLoadedListResponse, CodexThreadError> {
        self.request_typed(THREAD_LOADED_LIST, thread_loaded_list_params(cursor, limit))
            .await
    }

    pub async fn list_all_loaded_threads(&self) -> Result<Vec<String>, CodexThreadError> {
        let mut cursor = None;
        let mut seen_cursors = HashSet::new();
        let mut seen_threads = HashSet::new();
        let mut thread_ids = Vec::new();

        loop {
            let page = self.list_loaded_threads(cursor.as_deref(), 100).await?;
            for thread_id in page.data {
                if seen_threads.insert(thread_id.clone()) {
                    thread_ids.push(thread_id);
                }
            }
            let Some(next_cursor) = page.next_cursor.filter(|cursor| !cursor.is_empty()) else {
                return Ok(thread_ids);
            };
            if !seen_cursors.insert(next_cursor.clone()) {
                return Err(CodexThreadError::Protocol(
                    "Codex app-server repeated a thread/loaded/list cursor".to_string(),
                ));
            }
            cursor = Some(next_cursor);
        }
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

    pub async fn start_thread(
        &self,
        cwd: &str,
        permission_mode: Option<CodexPermissionMode>,
        service_tier: &str,
    ) -> Result<CodexThreadStart, CodexThreadError> {
        let typed: ThreadStartResponse = self
            .request_typed(
                THREAD_START,
                thread_start_params(cwd, permission_mode, Some(service_tier)),
            )
            .await?;
        let thread_id = typed.thread.id.clone();
        let permission_mode = if typed.extra.contains_key("approvalPolicy")
            || typed.extra.contains_key("approvalsReviewer")
            || typed.extra.contains_key("activePermissionProfile")
            || typed.extra.contains_key("sandbox")
        {
            Some(CodexPermissionMode::from_settings(&typed.extra))
        } else {
            permission_mode
        };
        let model = typed
            .extra
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
        let reasoning_effort = typed
            .extra
            .get("reasoningEffort")
            .and_then(Value::as_str)
            .map(str::to_string);
        let fast_mode =
            is_fast_service_tier(typed.extra.get("serviceTier").and_then(Value::as_str));
        Ok(CodexThreadStart {
            thread_id,
            thread: typed.thread,
            permission_mode,
            model,
            reasoning_effort,
            fast_mode,
        })
    }

    pub async fn resume_thread_with_page(
        &self,
        thread_id: &str,
        initial_turns_page: bool,
        service_tier: &str,
    ) -> Result<ThreadResumeResponse, CodexThreadError> {
        self.request_typed(
            THREAD_RESUME,
            thread_resume_params(thread_id, initial_turns_page, Some(service_tier)),
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

    pub async fn delete_thread(&self, thread_id: &str) -> Result<(), CodexThreadError> {
        let _: EmptyResponse = self
            .request_typed(THREAD_DELETE, thread_delete_params(thread_id))
            .await?;
        Ok(())
    }

    pub async fn unarchive_thread(&self, thread_id: &str) -> Result<CodexThread, CodexThreadError> {
        let response: protocol::ThreadUnarchiveResponse = self
            .request_typed(THREAD_UNARCHIVE, thread_unarchive_params(thread_id))
            .await?;
        Ok(response.thread)
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
                turn_start_params(thread_id, cwd, prompt, image_urls, &options),
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
        #[cfg(test)]
        if let Some(mock) = &self.mock {
            mock.server_responses
                .lock()
                .await
                .push((request_id, result));
            return Ok(());
        }
        self.write_message(server_response_message(request_id, result))
            .await
    }

    pub async fn list_models(&self, limit: usize) -> Result<ModelListResponse, CodexThreadError> {
        self.request_typed(MODEL_LIST, model_list_params(limit))
            .await
    }

    pub async fn list_permission_profiles(
        &self,
        cwd: &str,
        limit: usize,
    ) -> Result<Vec<PermissionProfileSummary>, CodexThreadError> {
        let response: PermissionProfileListResponse = self
            .request_typed(
                PERMISSION_PROFILE_LIST,
                permission_profile_list_params(cwd, limit),
            )
            .await?;
        Ok(response.data)
    }

    pub async fn default_permission_mode(
        &self,
        cwd: &str,
    ) -> Result<CodexPermissionMode, CodexThreadError> {
        let response: ConfigReadResponse = self
            .request_typed(CONFIG_READ, config_read_params(cwd))
            .await?;
        Ok(CodexPermissionMode::from_config(&response.config))
    }

    pub(crate) async fn status(&self, installation: &CodexInstallation) -> CodexStatusResponse {
        let app_server = self.inner().app_server.lock().await.clone();
        let daemon = Some(self.inner().daemon.clone());
        let (account, rate_limits, usage) = tokio::join!(
            self.request_typed::<AccountReadResponse, _>(ACCOUNT_READ, account_read_params()),
            self.request_typed::<Value, _>(ACCOUNT_RATE_LIMITS_READ, EmptyResponse::default()),
            self.request_typed::<Value, _>(ACCOUNT_USAGE_READ, EmptyResponse::default()),
        );
        status_from_results(
            installation,
            app_server,
            daemon,
            account,
            rate_limits.ok(),
            usage.ok(),
        )
    }

    pub fn unavailable_status(error: &CodexThreadError) -> CodexStatusResponse {
        unavailable_status(None, error)
    }

    pub(crate) fn unavailable_status_for_installation(
        installation: &CodexInstallation,
        error: &CodexThreadError,
    ) -> CodexStatusResponse {
        unavailable_status(Some(installation), error)
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
        self.inner()
            .writer
            .lock()
            .await
            .send(Message::Text(value.to_string().into()))
            .await
            .map_err(|error| CodexThreadError::Protocol(error.to_string()))
    }
}

async fn read_thread_server_loop(
    mut reader: SplitStream<WebSocketStream<ProxyStream>>,
    inner: Arc<CodexThreadClientInner>,
) {
    loop {
        let value = match reader.next().await {
            Some(Ok(Message::Text(text))) => serde_json::from_str::<Value>(&text).ok(),
            Some(Ok(Message::Binary(bytes))) => serde_json::from_slice::<Value>(&bytes).ok(),
            Some(Ok(Message::Ping(payload))) => {
                if let Err(error) = inner.writer.lock().await.send(Message::Pong(payload)).await {
                    let message = format!("Failed to reply to Codex app-server ping: {error}");
                    let _ = inner.events.send(CodexRuntimeEvent::Error {
                        message: message.clone(),
                    });
                    fail_pending(&inner, CodexThreadError::Protocol(message)).await;
                    return;
                }
                continue;
            }
            Some(Ok(Message::Pong(_))) => continue,
            Some(Ok(Message::Frame(_))) => continue,
            Some(Ok(Message::Close(_))) | None => {
                let _ = inner.events.send(CodexRuntimeEvent::Error {
                    message: "Codex app-server proxy closed its WebSocket connection.".to_string(),
                });
                fail_pending(&inner, CodexThreadError::ProcessUnavailable).await;
                return;
            }
            Some(Err(error)) => {
                let message = format!("Failed to read Codex app-server proxy output: {error}");
                let _ = inner.events.send(CodexRuntimeEvent::Error {
                    message: message.clone(),
                });
                fail_pending(&inner, CodexThreadError::Protocol(message)).await;
                return;
            }
        };

        let Some(value) = value else {
            continue;
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
    } else if error.code == -32600 && matches!(method, Some(TURN_STEER)) {
        CodexThreadError::TurnUnavailable(error.message)
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

fn server_response_message(request_id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": request_id,
        "result": result
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn normalizes_current_service_tiers_to_normal_or_fast() {
        assert!(!is_fast_service_tier(None));
        assert!(!is_fast_service_tier(Some("")));
        assert!(!is_fast_service_tier(Some("default")));
        assert!(!is_fast_service_tier(Some("DEFAULT")));
        assert!(!is_fast_service_tier(Some("flex")));
        assert!(!is_fast_service_tier(Some("unknown")));
        assert!(is_fast_service_tier(Some("priority")));
        assert!(is_fast_service_tier(Some(" PRIORITY ")));
    }

    #[tokio::test]
    #[ignore = "requires a real Codex task ID and authenticated Codex CLI"]
    async fn probes_live_thread_state_through_the_official_protocol() {
        use std::time::Instant;

        let thread_id = std::env::var("CAFFOLD_CODEX_PROBE_THREAD_ID")
            .expect("set CAFFOLD_CODEX_PROBE_THREAD_ID to a real Codex task ID");
        let installation = inspect_codex_installation()
            .await
            .expect("inspect Codex installation");
        let client = CodexThreadClient::start_with_installation(&installation)
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
            .resume_thread_with_page(&thread_id, true, NORMAL_SERVICE_TIER_ID)
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
        for method in [
            TURN_START,
            TURN_STEER,
            TURN_INTERRUPT,
            THREAD_ARCHIVE,
            THREAD_UNARCHIVE,
        ] {
            assert_eq!(
                request_timeout(method),
                Duration::from_secs(30),
                "{method} should fail promptly when the app-server is unavailable"
            );
        }
    }

    #[tokio::test]
    async fn loaded_thread_listing_follows_cursors_and_deduplicates_threads() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                THREAD_LOADED_LIST,
                json!({
                    "data": ["thread-1", "thread-2"],
                    "nextCursor": "page-2"
                }),
            ),
            MockCodexResponse::ok(
                THREAD_LOADED_LIST,
                json!({
                    "data": ["thread-2", "thread-3"],
                    "nextCursor": null
                }),
            ),
        ]);

        assert_eq!(
            client
                .list_all_loaded_threads()
                .await
                .expect("loaded threads"),
            ["thread-1", "thread-2", "thread-3"]
        );
        assert_eq!(
            client.mock_requests().await,
            [
                (THREAD_LOADED_LIST.to_string(), json!({ "limit": 100 })),
                (
                    THREAD_LOADED_LIST.to_string(),
                    json!({ "cursor": "page-2", "limit": 100 })
                )
            ]
        );
    }

    #[tokio::test]
    async fn loaded_thread_listing_rejects_a_repeated_cursor() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                THREAD_LOADED_LIST,
                json!({ "data": [], "nextCursor": "same" }),
            ),
            MockCodexResponse::ok(
                THREAD_LOADED_LIST,
                json!({ "data": [], "nextCursor": "same" }),
            ),
        ]);

        assert!(matches!(
            client.list_all_loaded_threads().await,
            Err(CodexThreadError::Protocol(message)) if message.contains("repeated")
        ));
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

    #[test]
    fn structured_thread_unavailable_errors_identify_the_thread_state() {
        assert!(
            CodexThreadError::ThreadUnavailable("019f-test".to_string()).is_thread_unavailable()
        );
        assert!(
            !CodexThreadError::RequestTimeout {
                method: THREAD_RESUME,
                request_id: 1,
                timeout_ms: HISTORY_REQUEST_TIMEOUT.as_millis() as u64,
            }
            .is_thread_unavailable()
        );
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
    async fn unarchives_threads_with_the_canonical_app_server_method() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            THREAD_UNARCHIVE,
            json!({
                "thread": {
                    "id": "thread_1",
                    "preview": "Restored task",
                    "status": { "type": "idle" },
                    "cwd": "/tmp/project",
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                }
            }),
        )]);

        let thread = client
            .unarchive_thread("thread_1")
            .await
            .expect("unarchive thread");

        assert_eq!(thread.id, "thread_1");
        assert_eq!(
            client.mock_requests().await,
            vec![(
                THREAD_UNARCHIVE.to_string(),
                json!({ "threadId": "thread_1" })
            )]
        );
    }

    #[tokio::test]
    async fn deletes_threads_with_the_canonical_app_server_method() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(THREAD_DELETE, json!({}))]);

        client
            .delete_thread("thread_1")
            .await
            .expect("delete thread");

        assert_eq!(
            client.mock_requests().await,
            vec![(THREAD_DELETE.to_string(), json!({ "threadId": "thread_1" }))]
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
        for method in [THREAD_READ, THREAD_RESUME, THREAD_TURNS_LIST] {
            let error = classify_json_rpc_error(
                Some(method),
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
    }

    #[test]
    fn classifies_stale_active_turn_by_request_method() {
        let error = classify_json_rpc_error(
            Some(TURN_STEER),
            &json!({
                "code": -32600,
                "message": "no active turn to steer"
            }),
        );

        assert!(matches!(
            error,
            CodexThreadError::TurnUnavailable(message)
                if message == "no active turn to steer"
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
}
