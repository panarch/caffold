use std::{
    collections::{HashMap, HashSet, VecDeque},
    convert::Infallible,
    future::Future,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{HeaderValue, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc};
use tracing::info;

mod error;
mod shell;
mod workspace;

use error::ApiError;

use crate::{
    codex_app_server::{
        self, CodexNotification, CodexPermissionMode, CodexRuntimeEvent, CodexServerRequest,
        CodexStatusResponse, CodexThreadClient, CodexThreadError, CodexTurnOptions, ThreadStatus,
        TurnStatus,
    },
    codex_thread_sessions::{
        CodexThreadSessions, PromptTarget, ThreadSessionSnapshot, ThreadSessionsDiagnostics,
    },
    fs::{MAX_IMAGE_BYTES, RootedFs},
    git,
    server_settings::ServerSettingsStore,
    task_rollout::{TaskRolloutMonitor, TaskRolloutSignal, TaskRolloutSubscription},
    thread_store::{ManagedThread, ThreadStore, ThreadStoreError},
};

const TASK_DETAIL_TURNS_PAGE_SIZE: usize = 8;
const MAX_TASK_IMAGES: usize = 4;
const MAX_TASK_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const TASK_LIST_PAGE_SIZE: usize = 30;
const TASK_SYNC_DEBOUNCE: Duration = Duration::from_millis(600);
const TASK_SYNC_MAX_LATENCY: Duration = Duration::from_secs(2);
const TASK_SYNC_RETRY_BASE: Duration = Duration::from_secs(2);
const TASK_SYNC_MAX_RETRIES: u8 = 3;
const TASK_CWD_RESOLVE_CONCURRENCY: usize = 8;
const TASK_CANONICAL_READ_CONCURRENCY: usize = 8;

#[derive(Debug, Clone)]
pub struct ServeConfig {
    pub host: IpAddr,
    pub port: u16,
    pub root: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
}

#[derive(Clone)]
struct TaskState {
    fs: Arc<RootedFs>,
    default_cwd_path: String,
    codex_threads: Arc<CodexThreadRuntime>,
    codex_sessions: CodexThreadSessions,
    pending_approvals: Arc<AsyncMutex<HashMap<String, PendingApproval>>>,
    task_events: broadcast::Sender<TaskEventRecord>,
    task_sync: TaskSyncCoordinator,
    task_sync_events: broadcast::Sender<TaskDetailSync>,
    task_list_removals: broadcast::Sender<TaskListRemoval>,
    task_list_updates: broadcast::Sender<TaskRecord>,
    thread_store: ThreadStore,
    live_task_events: LiveTaskEventCache,
    task_rollouts: TaskRolloutMonitor,
    shutdown: broadcast::Sender<()>,
}

impl TaskState {
    fn new(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        thread_store: ThreadStore,
    ) -> Self {
        let (task_events, _) = broadcast::channel(256);
        let task_sync = TaskSyncCoordinator::new();
        let (task_sync_events, _) = broadcast::channel(64);
        let (task_list_removals, _) = broadcast::channel(64);
        let (task_list_updates, _) = broadcast::channel(64);
        let task_rollouts = task_rollout_monitor(task_sync.clone());
        Self {
            fs,
            default_cwd_path,
            codex_threads: Arc::new(CodexThreadRuntime::default()),
            codex_sessions: CodexThreadSessions::default(),
            pending_approvals: Arc::new(AsyncMutex::new(HashMap::new())),
            task_events,
            task_sync,
            task_sync_events,
            task_list_removals,
            task_list_updates,
            thread_store,
            live_task_events: LiveTaskEventCache::default(),
            task_rollouts,
            shutdown,
        }
    }
}

#[derive(Clone)]
struct TaskSyncCoordinator {
    subscribers: Arc<Mutex<HashMap<String, usize>>>,
    pending_invalidations: Arc<Mutex<HashMap<String, u64>>>,
    requests: mpsc::UnboundedSender<TaskSyncRequest>,
    receiver: Arc<AsyncMutex<Option<mpsc::UnboundedReceiver<TaskSyncRequest>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TaskSyncRequest {
    Rollout(String, TaskRolloutSignal),
    Unsubscribe(String),
}

#[derive(Clone, Default)]
struct DeferredTaskRolloutSubscription {
    inner: Arc<Mutex<Option<TaskRolloutSubscription>>>,
}

impl DeferredTaskRolloutSubscription {
    fn install_with(&self, create: impl FnOnce() -> Option<TaskRolloutSubscription>) {
        let Ok(mut subscription) = self.inner.lock() else {
            return;
        };
        if subscription.is_none() {
            *subscription = create();
        }
    }
}

#[derive(Clone, Copy)]
struct PendingTaskSync {
    first_invalidated_at: tokio::time::Instant,
    deadline: tokio::time::Instant,
    retry_attempt: u8,
}

impl PendingTaskSync {
    fn new(now: tokio::time::Instant) -> Self {
        Self {
            first_invalidated_at: now,
            deadline: now + TASK_SYNC_DEBOUNCE,
            retry_attempt: 0,
        }
    }

    fn retry(now: tokio::time::Instant, retry_attempt: u8) -> Self {
        let multiplier = 1_u32 << retry_attempt.saturating_sub(1);
        let delay = TASK_SYNC_RETRY_BASE.saturating_mul(multiplier);
        Self {
            first_invalidated_at: now,
            deadline: now + delay,
            retry_attempt,
        }
    }

    fn invalidate(&mut self, now: tokio::time::Instant) {
        self.retry_attempt = 0;
        self.deadline =
            (now + TASK_SYNC_DEBOUNCE).min(self.first_invalidated_at + TASK_SYNC_MAX_LATENCY);
    }

    fn deadline(self) -> tokio::time::Instant {
        self.deadline
    }
}

impl TaskSyncCoordinator {
    fn new() -> Self {
        let (requests, receiver) = mpsc::unbounded_channel();
        Self {
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            pending_invalidations: Arc::new(Mutex::new(HashMap::new())),
            requests,
            receiver: Arc::new(AsyncMutex::new(Some(receiver))),
        }
    }

    fn subscribe(&self, thread_id: &str) -> TaskSyncSubscription {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            *subscribers.entry(thread_id.to_string()).or_default() += 1;
        }
        TaskSyncSubscription {
            coordinator: self.clone(),
            thread_id: thread_id.to_string(),
        }
    }

    #[cfg(test)]
    fn observe_rollout_invalidation(&self, thread_id: String) {
        self.observe_rollout_signal(thread_id, TaskRolloutSignal::Invalidated);
    }

    fn observe_rollout_signal(&self, thread_id: String, signal: TaskRolloutSignal) {
        if !self.is_subscribed(&thread_id) {
            return;
        }
        if let Ok(mut pending) = self.pending_invalidations.lock() {
            let revision = pending.entry(thread_id.clone()).or_default();
            *revision = revision.saturating_add(1);
        }
        let _ = self
            .requests
            .send(TaskSyncRequest::Rollout(thread_id, signal));
    }

    fn pending_invalidation(&self, thread_id: &str) -> Option<u64> {
        self.pending_invalidations
            .lock()
            .ok()
            .and_then(|pending| pending.get(thread_id).copied())
    }

    fn mark_synchronized(&self, thread_id: &str, revision: u64) {
        let Ok(mut pending) = self.pending_invalidations.lock() else {
            return;
        };
        if pending.get(thread_id).copied() == Some(revision) {
            pending.remove(thread_id);
        }
    }

    fn is_subscribed(&self, thread_id: &str) -> bool {
        self.subscribers
            .lock()
            .ok()
            .and_then(|subscribers| subscribers.get(thread_id).copied())
            .is_some_and(|count| count > 0)
    }

    async fn take_receiver(&self) -> Option<mpsc::UnboundedReceiver<TaskSyncRequest>> {
        self.receiver.lock().await.take()
    }

    fn unsubscribe(&self, thread_id: &str) {
        let remove = {
            let Ok(mut subscribers) = self.subscribers.lock() else {
                return;
            };
            let Some(count) = subscribers.get_mut(thread_id) else {
                return;
            };
            *count -= 1;
            let remove = *count == 0;
            if remove {
                subscribers.remove(thread_id);
            }
            remove
        };
        if remove {
            if let Ok(mut pending) = self.pending_invalidations.lock() {
                pending.remove(thread_id);
            }
            let _ = self
                .requests
                .send(TaskSyncRequest::Unsubscribe(thread_id.to_string()));
        }
    }
}

struct TaskSyncSubscription {
    coordinator: TaskSyncCoordinator,
    thread_id: String,
}

impl Drop for TaskSyncSubscription {
    fn drop(&mut self) {
        self.coordinator.unsubscribe(&self.thread_id);
    }
}

#[derive(Default)]
struct CodexThreadRuntime {
    state: AsyncMutex<CodexThreadRuntimeState>,
}

#[derive(Default)]
struct CodexThreadRuntimeState {
    client: Option<CodexThreadClient>,
    generation: u64,
}

#[derive(Clone)]
struct CodexThreadConnection {
    client: CodexThreadClient,
    generation: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexRuntimeDiagnostics {
    codex_cli_version: Option<String>,
    process_generation: u64,
    process_connected: bool,
    thread_sessions: ThreadSessionsDiagnostics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexStatusPayload {
    #[serde(flatten)]
    status: CodexStatusResponse,
    diagnostics: CodexRuntimeDiagnostics,
}

impl CodexThreadRuntime {
    async fn diagnostics(&self) -> (u64, bool) {
        let state = self.state.lock().await;
        (state.generation, state.client.is_some())
    }

    async fn shutdown(&self) {
        let client = self.state.lock().await.client.take();
        if let Some(client) = client {
            client.shutdown().await;
        }
    }

    async fn invalidate(&self, generation: u64) {
        let client = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return;
            }
            state.client.take()
        };
        if let Some(client) = client {
            client.shutdown().await;
        }
    }

    async fn invalidate_after_error(&self, generation: u64, error: &CodexThreadError) -> bool {
        if !error.is_connection_failure() {
            return false;
        }
        let client = {
            let mut state = self.state.lock().await;
            if state.generation != generation {
                return false;
            }
            state.client.take()
        };
        if let Some(client) = client {
            client.shutdown().await;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone)]
struct PendingApproval {
    thread_id: String,
    request_id: JsonValue,
    kind: ApprovalKind,
    params: JsonValue,
    created_ms: u64,
    sort_index: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApprovalKind {
    Command,
    FileChange,
}

impl ApprovalKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::FileChange => "file_change",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TasksQuery {
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDetailQuery {
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexPermissionsQuery {
    cwd: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskRequest {
    prompt: String,
    #[serde(default)]
    images: Vec<String>,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<CodexPermissionMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskPromptRequest {
    prompt: String,
    #[serde(default)]
    images: Vec<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<CodexPermissionMode>,
    active_turn_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexPermissionsResponse {
    default_mode: CodexPermissionMode,
    options: Vec<CodexPermissionOption>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexPermissionOption {
    mode: CodexPermissionMode,
    label: &'static str,
    description: &'static str,
    allowed: bool,
    dangerous: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskPromptResponse {
    thread_id: String,
    turn_id: String,
    steered: bool,
}

struct TaskPromptOutcome {
    turn_id: String,
    steered: bool,
    started_turn: Option<(crate::codex_app_server::CodexTurn, CodexTurnOptions)>,
}

#[derive(Debug, Deserialize)]
struct TaskApprovalRequest {
    decision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskListResponse {
    tasks: Vec<TaskRecord>,
    next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TaskRecord {
    id: String,
    thread_id: String,
    title: String,
    preview: String,
    thread_status: ThreadStatus,
    latest_turn_status: Option<TurnStatus>,
    active_turn: Option<TaskActiveTurn>,
    cwd: String,
    cwd_path: Option<String>,
    relative_cwd: String,
    worktree: Option<TaskWorktreeContext>,
    created_ms: u64,
    updated_ms: u64,
    recency_ms: Option<u64>,
    last_event_summary: Option<String>,
    unseen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskActiveTurn {
    id: String,
    started_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskWorktreeContext {
    root_path: String,
    repository_root_path: String,
    branch: Option<String>,
    head_sha: String,
    relative_cwd: String,
    linked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedTaskCwd {
    canonical_cwd: PathBuf,
    logical_cwd: Option<String>,
    worktree: Option<TaskWorktreeContext>,
    worktree_root: Option<PathBuf>,
    repository_common_dir: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TaskEventRecord {
    id: String,
    thread_id: String,
    #[serde(rename = "type")]
    event_type: String,
    summary: String,
    payload: Option<JsonValue>,
    created_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sort_index: Option<u32>,
}

#[derive(Clone, Default)]
struct LiveTaskEventCache {
    events: Arc<Mutex<HashMap<String, Vec<TaskEventRecord>>>>,
}

const LIVE_TASK_EVENT_LIMIT_PER_THREAD: usize = 256;
const LIVE_TASK_THREAD_LIMIT: usize = 128;

impl LiveTaskEventCache {
    fn observe(&self, events: &[TaskEventRecord]) {
        for event in events {
            self.record(event.clone());
        }
    }

    fn record(&self, mut event: TaskEventRecord) -> TaskEventRecord {
        let Ok(mut events) = self.events.lock() else {
            return event;
        };
        let thread_id = event.thread_id.clone();
        if !events.contains_key(&thread_id) && events.len() >= LIVE_TASK_THREAD_LIMIT {
            let oldest_thread = events
                .iter()
                .min_by_key(|(_, items)| {
                    items
                        .iter()
                        .map(|item| item.updated_ms.unwrap_or(item.created_ms))
                        .max()
                        .unwrap_or_default()
                })
                .map(|(thread_id, _)| thread_id.clone());
            if let Some(oldest_thread) = oldest_thread {
                events.remove(&oldest_thread);
            }
        }
        let thread_events = events.entry(thread_id).or_default();
        if let Some(existing) = thread_events.iter_mut().find(|item| item.id == event.id) {
            *existing = merge_task_event_record(existing.clone(), event);
            return existing.clone();
        }
        if is_pending_canonical_user_message(&event)
            && thread_events.iter().any(|canonical| {
                !is_pending_canonical_user_message(canonical)
                    && pending_user_message_matches(&event, canonical)
            })
        {
            return event;
        }
        if event.event_type == "user_message"
            && !is_pending_canonical_user_message(&event)
            && let Some(index) = thread_events
                .iter()
                .position(|pending| pending_user_message_matches(pending, &event))
        {
            thread_events.remove(index);
        }
        if event.sort_index.is_none() {
            event.sort_index = Some(
                thread_events
                    .iter()
                    .filter(|existing| existing.created_ms == event.created_ms)
                    .filter_map(|existing| existing.sort_index)
                    .max()
                    .map_or(0, |index| index.saturating_add(1)),
            );
        }
        thread_events.push(event.clone());
        if thread_events.len() > LIVE_TASK_EVENT_LIMIT_PER_THREAD {
            thread_events.remove(0);
        }
        event
    }

    fn for_thread(&self, thread_id: &str) -> Vec<TaskEventRecord> {
        self.events
            .lock()
            .ok()
            .and_then(|events| events.get(thread_id).cloned())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDetailResponse {
    thread_id: String,
    sync_state: TaskSyncState,
    managed: bool,
    revision: u64,
    task: Option<TaskRecord>,
    events: Vec<TaskEventRecord>,
    events_page: TaskEventsPage,
    pending_approvals: Vec<TaskEventRecord>,
    history_loading: bool,
    permission_mode: Option<CodexPermissionMode>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum TaskSyncState {
    Loading,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEventsPage {
    next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDetailSync {
    thread_id: String,
    revision: u64,
    detail: TaskDetailResponse,
    reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEventEnvelope {
    thread_id: String,
    revision: u64,
    event: TaskEventRecord,
}

fn task_stream_initial_frames(sync: &TaskDetailSync) -> VecDeque<Bytes> {
    let payload = serde_json::to_string(sync).expect("task detail sync serializes");
    VecDeque::from([
        Bytes::from_static(b": ready\n\n"),
        Bytes::from(format!("event: task-sync\ndata: {payload}\n\n")),
    ])
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskListRemoval {
    thread_id: String,
    reason: &'static str,
}

pub async fn serve(config: ServeConfig) -> anyhow::Result<()> {
    let (fs, initial_path, home_path) = match config.root {
        Some(root) => (RootedFs::new(root)?, String::new(), None),
        None => {
            let fs = RootedFs::from_filesystem_root()?;
            let home = RootedFs::home_dir()?;
            let home_path = fs.logical_path_for_absolute(&home)?;
            (fs, home_path.clone(), Some(home_path))
        }
    };
    let data_dir = config.data_dir.unwrap_or(default_data_dir()?);
    let server_settings = Arc::new(ServerSettingsStore::persistent(
        data_dir.join("server.json"),
    )?);
    let thread_store = ThreadStore::redb(data_dir.join("caffold.redb"))?;
    let (shutdown, _) = broadcast::channel(16);
    let fs = Arc::new(fs);
    let root = fs.root().to_path_buf();
    let shell_router = shell::router(fs.clone(), server_settings, initial_path.clone(), home_path);
    let workspace_router = workspace::router(fs.clone(), shutdown.clone());
    let task_state = TaskState::new(fs, initial_path.clone(), shutdown.clone(), thread_store);
    let codex_threads = task_state.codex_threads.clone();
    let app = router_with_states(shell_router, workspace_router, task_state);
    let listener = TcpListener::bind((config.host, config.port)).await?;
    let addr = listener.local_addr()?;

    info!("serving Caffold at http://{addr}");
    info!("browsing root {}", root.display());
    info!("initial path {initial_path}");
    println!("Caffold is serving http://{addr}");
    println!("Browsing root {}", root.display());
    println!("Data directory {}", data_dir.display());
    println!(
        "Initial path {}",
        if initial_path.is_empty() {
            "/"
        } else {
            &initial_path
        }
    );

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown))
        .await;
    codex_threads.shutdown().await;
    result?;

    Ok(())
}

pub fn router(fs: RootedFs) -> anyhow::Result<Router> {
    let (shutdown, _) = broadcast::channel(16);
    let fs = Arc::new(fs);
    let shell_router = shell::router(
        fs.clone(),
        Arc::new(ServerSettingsStore::memory()),
        String::new(),
        None,
    );
    let workspace_router = workspace::router(fs.clone(), shutdown.clone());
    let task_state = TaskState::new(fs, String::new(), shutdown, ThreadStore::memory()?);
    Ok(router_with_states(
        shell_router,
        workspace_router,
        task_state,
    ))
}

fn router_with_states(
    shell_router: Router,
    workspace_router: Router,
    task_state: TaskState,
) -> Router {
    shell_router
        .merge(workspace_router)
        .merge(task_router(task_state))
}

fn task_router(state: TaskState) -> Router {
    Router::new()
        .route("/api/codex/status", get(codex_status))
        .route("/api/codex/models", get(codex_models))
        .route("/api/codex/permissions", get(codex_permissions))
        .route(
            "/api/tasks",
            get(list_managed_tasks)
                .post(create_task)
                .layer(DefaultBodyLimit::max(MAX_TASK_REQUEST_BYTES)),
        )
        .route("/api/task-history", get(list_task_history))
        .route("/api/tasks/stream", get(task_list_stream))
        .route("/api/tasks/{thread_id}", get(task_detail))
        .route("/api/tasks/{thread_id}/continue", post(continue_task))
        .route(
            "/api/tasks/{thread_id}/seen",
            axum::routing::put(mark_task_seen),
        )
        .route("/api/tasks/{thread_id}/stream", get(task_stream))
        .route("/api/tasks/{thread_id}/archive", post(task_archive))
        .route(
            "/api/tasks/{thread_id}/prompts",
            post(task_prompt).layer(DefaultBodyLimit::max(MAX_TASK_REQUEST_BYTES)),
        )
        .route("/api/tasks/{thread_id}/interrupt", post(task_interrupt))
        .route(
            "/api/tasks/{thread_id}/approvals/{approval_id}",
            post(task_approval),
        )
        .with_state(state)
}

fn default_data_dir() -> anyhow::Result<PathBuf> {
    Ok(RootedFs::home_dir()?.join(".caffold"))
}

async fn shutdown_signal(shutdown: broadcast::Sender<()>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};

        if let Ok(mut signal) = signal(SignalKind::terminate()) {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
    let _ = shutdown.send(());
}

async fn codex_status(State(state): State<TaskState>) -> Json<CodexStatusPayload> {
    let (status, process_generation, process_connected) =
        match require_codex_thread_connection(&state).await {
            Ok(connection) => (
                connection.client.status().await,
                connection.generation,
                true,
            ),
            Err(error) => {
                let (generation, connected) = state.codex_threads.diagnostics().await;
                (
                    CodexThreadClient::unavailable_status(&error),
                    generation,
                    connected,
                )
            }
        };
    let codex_cli_version = status
        .app_server
        .as_ref()
        .and_then(|info| info.user_agent.as_deref())
        .and_then(codex_version_from_user_agent);
    let diagnostics = CodexRuntimeDiagnostics {
        codex_cli_version,
        process_generation,
        process_connected,
        thread_sessions: state.codex_sessions.diagnostics().await,
    };
    Json(CodexStatusPayload {
        status,
        diagnostics,
    })
}

fn codex_version_from_user_agent(user_agent: &str) -> Option<String> {
    let version = user_agent.rsplit_once('/')?.1.split_whitespace().next()?;
    (!version.is_empty()).then(|| version.to_string())
}

async fn codex_models(State(state): State<TaskState>) -> Result<Json<JsonValue>, ApiError> {
    let client = require_codex_thread_client(&state).await?;
    let response = client.list_models(100).await.map_err(ApiError::from)?;
    codex_models_payload(response).map(Json)
}

async fn codex_permissions(
    State(state): State<TaskState>,
    Query(query): Query<CodexPermissionsQuery>,
) -> Result<Json<CodexPermissionsResponse>, ApiError> {
    let cwd = task_cwd(&state, query.cwd.as_deref())?;
    let client = require_codex_thread_client(&state).await?;
    let (profiles, default_mode) = tokio::try_join!(
        client.list_permission_profiles(&cwd, 100),
        client.default_permission_mode(&cwd),
    )?;
    let profile_allowed = |profile_id: &str| {
        profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .is_some_and(|profile| profile.allowed)
    };
    let workspace_allowed = profile_allowed(":workspace");
    let full_access_allowed = profile_allowed(":danger-full-access");

    Ok(Json(CodexPermissionsResponse {
        default_mode,
        options: vec![
            CodexPermissionOption {
                mode: CodexPermissionMode::AskForApproval,
                label: "Ask for approval",
                description: "Work in the workspace and ask before crossing its boundary.",
                allowed: workspace_allowed,
                dangerous: false,
            },
            CodexPermissionOption {
                mode: CodexPermissionMode::ApproveForMe,
                label: "Approve for me",
                description: "Keep the workspace boundary and review eligible requests automatically.",
                allowed: workspace_allowed,
                dangerous: false,
            },
            CodexPermissionOption {
                mode: CodexPermissionMode::FullAccess,
                label: "Full access",
                description: "Run without sandbox restrictions or approval prompts.",
                allowed: full_access_allowed,
                dangerous: true,
            },
        ],
    }))
}

fn codex_models_payload(
    response: codex_app_server::ModelListResponse,
) -> Result<JsonValue, ApiError> {
    let mut payload =
        serde_json::to_value(response).map_err(|error| ApiError::CodexThread(error.to_string()))?;
    let Some(models) = payload.get_mut("data").and_then(JsonValue::as_array_mut) else {
        return Ok(payload);
    };

    for model in models {
        let Some(efforts) = model
            .get_mut("supportedReasoningEfforts")
            .and_then(JsonValue::as_array_mut)
        else {
            continue;
        };
        for effort in efforts {
            add_codex_reasoning_label(effort);
        }
    }

    Ok(payload)
}

fn add_codex_reasoning_label(effort: &mut JsonValue) {
    let value = codex_reasoning_effort_value(effort).map(str::to_string);
    let Some(value) = value else {
        return;
    };
    let label = codex_reasoning_label(&value);

    if let Some(object) = effort.as_object_mut() {
        object
            .entry("value".to_string())
            .or_insert_with(|| JsonValue::String(value));
        object
            .entry("label".to_string())
            .or_insert_with(|| JsonValue::String(label));
        return;
    }

    *effort = json!({
        "value": value,
        "label": label,
    });
}

fn codex_reasoning_effort_value(effort: &JsonValue) -> Option<&str> {
    effort
        .get("value")
        .and_then(JsonValue::as_str)
        .or_else(|| effort.get("reasoningEffort").and_then(JsonValue::as_str))
        .or_else(|| effort.as_str())
}

fn codex_reasoning_label(effort: &str) -> String {
    match effort {
        "minimal" => "Minimal".to_string(),
        "low" => "Light".to_string(),
        "medium" => "Medium".to_string(),
        "high" => "High".to_string(),
        "xhigh" => "Extra High".to_string(),
        "max" => "Max".to_string(),
        "ultra" => "Ultra".to_string(),
        effort => effort
            .split(['-', '_'])
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                chars
                    .next()
                    .map(|first| first.to_uppercase().chain(chars).collect::<String>())
                    .unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join(" "),
    }
}

async fn list_managed_tasks(
    State(state): State<TaskState>,
    Query(query): Query<TasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let (managed, next_cursor) =
        thread_store_list(&state, query.cursor.as_deref(), TASK_LIST_PAGE_SIZE).await?;
    let connection = require_codex_thread_connection(&state).await?;
    let reads = stream::iter(managed)
        .map(|managed| {
            let state = state.clone();
            let client = connection.client.clone();
            async move {
                let thread = client.read_thread(&managed.thread_id).await?;
                state
                    .codex_sessions
                    .observe_thread_metadata(thread.clone())
                    .await;
                let mut task = task_record_from_codex_thread(&state, &thread)?;
                let activity_ms = task_activity_ms(&task);
                task.unseen = managed.unseen(activity_ms);
                Ok::<_, ApiError>((task, activity_ms))
            }
        })
        .buffer_unordered(TASK_CANONICAL_READ_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut tasks = reads.into_iter().collect::<Result<Vec<_>, ApiError>>()?;
    for (task, activity_ms) in &tasks {
        thread_store_update_observed_recency(&state, &task.thread_id, *activity_ms).await?;
    }
    tasks.sort_by(|(left, _), (right, _)| {
        task_activity_ms(right)
            .cmp(&task_activity_ms(left))
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    let tasks = tasks.into_iter().map(|(task, _)| task).collect();
    Ok(Json(TaskListResponse { tasks, next_cursor }))
}

async fn list_task_history(
    State(state): State<TaskState>,
    Query(query): Query<TasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let client = require_codex_thread_client(&state).await?;
    let cursor = query
        .cursor
        .as_deref()
        .map(str::trim)
        .filter(|cursor| !cursor.is_empty());
    let response = client.list_threads(cursor, TASK_LIST_PAGE_SIZE).await?;
    let next_cursor = response.next_cursor.clone();
    for thread in response.data.iter().cloned() {
        state.codex_sessions.observe_thread_metadata(thread).await;
    }
    let response =
        serde_json::to_value(response).map_err(|error| ApiError::CodexThread(error.to_string()))?;
    let resolved_cwds = resolve_task_cwds(state.fs.clone(), &response).await;
    let tasks = thread_list_response_with_resolved(&response, &resolved_cwds);
    let tasks = filter_and_refresh_managed_history(&state, tasks).await?;
    Ok(Json(TaskListResponse { tasks, next_cursor }))
}

#[cfg(test)]
async fn list_tasks(
    state: State<TaskState>,
    query: Query<TasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let task_state = state.0.clone();
    let response = list_task_history(state, query).await?;
    for task in &response.0.tasks {
        thread_store_claim(
            &task_state,
            managed_thread_from_task_record(task, None, None),
        )
        .await?;
    }
    Ok(response)
}

async fn thread_store_list(
    state: &TaskState,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(Vec<ManagedThread>, Option<String>), ApiError> {
    let store = state.thread_store.clone();
    let cursor = cursor.map(ToOwned::to_owned);
    tokio::task::spawn_blocking(move || store.list(cursor.as_deref(), limit))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn thread_store_get(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.thread_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.get(&thread_id))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn thread_store_claim(
    state: &TaskState,
    thread: ManagedThread,
) -> Result<ManagedThread, ApiError> {
    let store = state.thread_store.clone();
    tokio::task::spawn_blocking(move || store.claim(thread, now_ms()))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn thread_store_mark_seen(
    state: &TaskState,
    thread_id: &str,
    canonical_activity_ms: u64,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.thread_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        store.mark_seen(&thread_id, canonical_activity_ms, now_ms())
    })
    .await
    .map_err(thread_store_join_error)?
    .map_err(thread_store_api_error)
}

async fn thread_store_update_observed_recency(
    state: &TaskState,
    thread_id: &str,
    canonical_activity_ms: u64,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.thread_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        store.update_observed_recency(&thread_id, canonical_activity_ms)
    })
    .await
    .map_err(thread_store_join_error)?
    .map_err(thread_store_api_error)
}

async fn thread_store_update_composer_settings(
    state: &TaskState,
    thread_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.thread_store.clone();
    let thread_id = thread_id.to_string();
    let model = model.map(str::to_string);
    let reasoning_effort = reasoning_effort.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        store.update_composer_settings(&thread_id, model.as_deref(), reasoning_effort.as_deref())
    })
    .await
    .map_err(thread_store_join_error)?
    .map_err(thread_store_api_error)
}

async fn thread_store_delete(state: &TaskState, thread_id: &str) -> Result<bool, ApiError> {
    let store = state.thread_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.delete(&thread_id))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn filter_and_refresh_managed_history(
    state: &TaskState,
    tasks: Vec<TaskRecord>,
) -> Result<Vec<TaskRecord>, ApiError> {
    let store = state.thread_store.clone();
    let thread_ids = tasks
        .iter()
        .map(|task| task.thread_id.clone())
        .collect::<Vec<_>>();
    let managed = tokio::task::spawn_blocking(move || {
        let mut managed = HashSet::new();
        for thread_id in thread_ids {
            if store.get(&thread_id)?.is_some() {
                managed.insert(thread_id);
            }
        }
        Ok::<_, ThreadStoreError>(managed)
    })
    .await
    .map_err(thread_store_join_error)?
    .map_err(thread_store_api_error)?;
    Ok(tasks
        .into_iter()
        .filter(|task| !managed.contains(&task.thread_id))
        .collect())
}

fn thread_store_api_error(error: ThreadStoreError) -> ApiError {
    match error {
        ThreadStoreError::InvalidCursor => ApiError::BadRequest {
            code: "task_cursor_invalid",
            message: error.to_string(),
        },
        error => ApiError::Internal(error.to_string()),
    }
}

fn thread_store_join_error(error: tokio::task::JoinError) -> ApiError {
    ApiError::Internal(format!("thread store task failed: {error}"))
}

async fn create_task(
    State(state): State<TaskState>,
    Json(request): Json<CreateTaskRequest>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let (prompt, images) = normalize_task_input(&request.prompt, request.images)?;
    let cwd = task_cwd(&state, request.cwd.as_deref())?;
    let connection = require_codex_thread_connection(&state).await?;
    let client = &connection.client;
    let turn_options = codex_turn_options(
        client,
        request.model,
        request.effort,
        request.permission_mode,
    )
    .await?;

    let requested_permission_mode = turn_options.permission_mode;
    let requested_model = turn_options.model.clone();
    let requested_reasoning_effort = turn_options.effort.clone();
    let thread = client
        .start_thread(&cwd, turn_options.permission_mode)
        .await?;
    let thread_permission_mode = requested_permission_mode.or(thread.permission_mode);
    let effective_model = requested_model.or_else(|| thread.model.clone());
    let effective_reasoning_effort =
        requested_reasoning_effort.or_else(|| thread.reasoning_effort.clone());
    let task = task_record_from_codex_thread(&state, &thread.thread)?;
    thread_store_claim(
        &state,
        managed_thread_from_task_record(
            &task,
            effective_model.clone(),
            effective_reasoning_effort.clone(),
        ),
    )
    .await?;
    notify_task_updated(&state, task);
    state
        .codex_sessions
        .register_started_thread(
            &connection.client,
            connection.generation,
            thread.thread.clone(),
            thread_permission_mode,
            thread.model.clone(),
            thread.reasoning_effort.clone(),
        )
        .await;
    let permission_mode = thread_permission_mode;
    let turn = match client
        .start_turn(&thread.thread_id, &cwd, &prompt, &images, turn_options)
        .await
    {
        Ok(turn) => turn,
        Err(error) => {
            state.codex_sessions.cancel_runtime(&thread.thread_id).await;
            return Err(error.into());
        }
    };
    state
        .codex_sessions
        .record_turn_started(
            connection.generation,
            &thread.thread_id,
            turn.turn,
            permission_mode,
            effective_model.clone(),
            effective_reasoning_effort.clone(),
        )
        .await;
    if let Err(error) = thread_store_update_composer_settings(
        &state,
        &thread.thread_id,
        effective_model.as_deref(),
        effective_reasoning_effort.as_deref(),
    )
    .await
    {
        eprintln!(
            "failed to persist composer settings for started thread {}: {error:?}",
            thread.thread_id
        );
    }
    publish_task_event(
        &state.task_events,
        &state.live_task_events,
        accepted_user_message_event(&thread.thread_id, &turn.turn_id, &prompt, &images),
    );
    Ok(Json(
        read_task_detail(&state, &connection, &thread.thread_id, None).await?,
    ))
}

async fn task_detail(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<TaskDetailQuery>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    if thread_store_get(&state, &thread_id).await?.is_none() {
        if query
            .cursor
            .as_deref()
            .is_some_and(|cursor| !cursor.trim().is_empty())
        {
            return Err(task_not_managed_error());
        }
        return unmanaged_task_detail(&state, &thread_id).await.map(Json);
    }
    let cursor = query
        .cursor
        .as_deref()
        .map(str::trim)
        .filter(|cursor| !cursor.is_empty());
    if let Some(cursor) = cursor {
        let connection = require_codex_thread_connection(&state).await?;
        let _viewer = state
            .codex_sessions
            .acquire_viewer(&connection.client, connection.generation, &thread_id)
            .await?;
        return Ok(Json(
            read_task_detail(&state, &connection, &thread_id, Some(cursor)).await?,
        ));
    }

    let viewer = state.codex_sessions.reserve_viewer(&thread_id).await;
    let (detail, baseline_revision) = cached_task_detail(&state, &thread_id).await?;
    let bootstrap_state = state.clone();
    let bootstrap_thread_id = thread_id.clone();
    tokio::spawn(async move {
        bootstrap_task_session(&bootstrap_state, &bootstrap_thread_id, baseline_revision).await;
        drop(viewer);
    });
    Ok(Json(detail))
}

async fn continue_task(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    let client = require_codex_thread_client(&state).await?;
    let thread = client.read_thread(&thread_id).await?;
    state
        .codex_sessions
        .observe_thread_metadata(thread.clone())
        .await;
    let mut task = task_record_from_codex_thread(&state, &thread)?;
    let managed = managed_thread_from_task_record(&task, None, None);
    thread_store_claim(&state, managed).await?;
    task.unseen = false;
    notify_task_updated(&state, task.clone());
    Ok(Json(task))
}

async fn mark_task_seen(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    if thread_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let client = require_codex_thread_client(&state).await?;
    let thread = client.read_thread(&thread_id).await?;
    state
        .codex_sessions
        .observe_thread_metadata(thread.clone())
        .await;
    let mut task = task_record_from_codex_thread(&state, &thread)?;
    let activity_ms = task_activity_ms(&task);
    let Some(managed) = thread_store_mark_seen(&state, &thread_id, activity_ms).await? else {
        return Err(task_not_managed_error());
    };
    task.unseen = managed.unseen(activity_ms);
    notify_task_updated(&state, task.clone());
    Ok(Json(task))
}

async fn unmanaged_task_detail(
    state: &TaskState,
    thread_id: &str,
) -> Result<TaskDetailResponse, ApiError> {
    let client = require_codex_thread_client(state).await?;
    let thread = client.read_thread(thread_id).await?;
    let task = task_record_from_codex_thread(state, &thread)?;
    Ok(TaskDetailResponse {
        thread_id: thread_id.to_string(),
        sync_state: TaskSyncState::Ready,
        managed: false,
        revision: 0,
        task: Some(task),
        events: Vec::new(),
        events_page: TaskEventsPage { next_cursor: None },
        pending_approvals: Vec::new(),
        history_loading: false,
        permission_mode: None,
        model: None,
        reasoning_effort: None,
    })
}

fn task_record_from_codex_thread(
    state: &TaskState,
    thread: &crate::codex_app_server::CodexThread,
) -> Result<TaskRecord, ApiError> {
    let thread = thread.clone().into_value();
    let resolved = resolve_thread_cwd(&state.fs, &thread);
    task_record_from_thread(&thread, &[], resolved.as_ref())
}

fn task_not_managed_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_not_managed",
        message: "thread must be continued in Caffold first".to_string(),
    }
}

fn notify_task_updated(state: &TaskState, task: TaskRecord) {
    let _ = state.task_list_updates.send(task);
}

async fn ensure_task_sync_worker(state: &TaskState) {
    let Some(receiver) = state.task_sync.take_receiver().await else {
        return;
    };
    let state = state.clone();
    tokio::spawn(run_task_sync_worker(state, receiver));
}

async fn run_task_sync_worker(
    state: TaskState,
    mut receiver: mpsc::UnboundedReceiver<TaskSyncRequest>,
) {
    let mut pending = HashMap::<String, PendingTaskSync>::new();
    let mut shutdown = state.shutdown.subscribe();

    loop {
        if pending.is_empty() {
            tokio::select! {
                _ = shutdown.recv() => return,
                request = receiver.recv() => {
                    let Some(request) = request else { return; };
                    handle_task_sync_request(&state, &mut pending, request).await;
                }
            }
        } else {
            let deadline = pending
                .values()
                .map(|pending| pending.deadline())
                .min()
                .unwrap();
            tokio::select! {
                _ = shutdown.recv() => return,
                request = receiver.recv() => {
                    let Some(request) = request else { return; };
                    handle_task_sync_request(&state, &mut pending, request).await;
                }
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }

        let now = tokio::time::Instant::now();
        let due = pending
            .iter()
            .filter(|(_, pending)| pending.deadline() <= now)
            .map(|(thread_id, _)| thread_id.clone())
            .collect::<Vec<_>>();
        for thread_id in due {
            let Some(request) = pending.remove(&thread_id) else {
                continue;
            };
            if !state.task_sync.is_subscribed(&thread_id) {
                continue;
            }
            let Some(invalidation_revision) = state.task_sync.pending_invalidation(&thread_id)
            else {
                continue;
            };
            let syncing = state.codex_sessions.begin_external_sync(&thread_id).await;
            let Ok(connection) = require_codex_thread_connection(&state).await else {
                schedule_task_sync_retry(
                    &mut pending,
                    thread_id.clone(),
                    request.retry_attempt,
                    tokio::time::Instant::now(),
                );
                state
                    .codex_sessions
                    .fail_external_sync(&thread_id, &CodexThreadError::ProcessUnavailable)
                    .await;
                broadcast_task_sync_error(
                    &state,
                    &thread_id,
                    CodexThreadError::ProcessUnavailable.to_string(),
                )
                .await;
                continue;
            };
            let response = tokio::try_join!(
                connection.client.read_thread(&thread_id),
                connection
                    .client
                    .list_thread_turns(&thread_id, None, TASK_DETAIL_TURNS_PAGE_SIZE),
            );
            let (thread, latest_turns) = match response {
                Ok(response) => response,
                Err(error) if error.is_thread_unavailable() => {
                    state
                        .codex_sessions
                        .fail_external_sync(&thread_id, &error)
                        .await;
                    broadcast_task_sync_error(&state, &thread_id, error.to_string()).await;
                    state
                        .task_sync
                        .mark_synchronized(&thread_id, invalidation_revision);
                    let _ = thread_store_delete(&state, &thread_id).await;
                    notify_task_removed(&state, &thread_id, "unavailable");
                    continue;
                }
                Err(error) => {
                    state
                        .codex_sessions
                        .fail_external_sync(&thread_id, &error)
                        .await;
                    broadcast_task_sync_error(&state, &thread_id, error.to_string()).await;
                    schedule_task_sync_retry(
                        &mut pending,
                        thread_id,
                        request.retry_attempt,
                        tokio::time::Instant::now(),
                    );
                    continue;
                }
            };
            let snapshot = state
                .codex_sessions
                .apply_external_read_sync(&thread_id, syncing.revision, thread, latest_turns)
                .await;
            state
                .task_sync
                .mark_synchronized(&thread_id, invalidation_revision);
            let Ok(detail) = task_detail_from_snapshot(&state, snapshot, None).await else {
                continue;
            };
            let _ = state.task_sync_events.send(TaskDetailSync {
                revision: detail.revision,
                thread_id: thread_id.clone(),
                detail,
                reason: "canonical-read-sync",
                error: None,
            });
        }
    }
}

async fn handle_task_sync_request(
    _state: &TaskState,
    pending: &mut HashMap<String, PendingTaskSync>,
    request: TaskSyncRequest,
) {
    match request {
        TaskSyncRequest::Rollout(thread_id, TaskRolloutSignal::Invalidated) => {
            schedule_task_sync(pending, thread_id, tokio::time::Instant::now());
        }
        TaskSyncRequest::Unsubscribe(thread_id) => {
            pending.remove(&thread_id);
        }
    }
}

async fn broadcast_task_snapshot(
    state: &TaskState,
    thread_id: &str,
    snapshot: ThreadSessionSnapshot,
    reason: &'static str,
) {
    let Ok(detail) = task_detail_from_snapshot(state, snapshot, None).await else {
        return;
    };
    let _ = state.task_sync_events.send(TaskDetailSync {
        revision: detail.revision,
        thread_id: thread_id.to_string(),
        detail,
        reason,
        error: None,
    });
}

async fn broadcast_task_sync_error(state: &TaskState, thread_id: &str, error: String) {
    let revision = state
        .codex_sessions
        .snapshot(thread_id)
        .await
        .map(|snapshot| snapshot.revision)
        .unwrap_or_default();
    let detail = loading_task_detail(thread_id, revision, None);
    let _ = state.task_sync_events.send(TaskDetailSync {
        thread_id: thread_id.to_string(),
        revision,
        detail,
        reason: "canonical-source-error",
        error: Some(error),
    });
}

fn schedule_task_sync(
    pending: &mut HashMap<String, PendingTaskSync>,
    thread_id: String,
    now: tokio::time::Instant,
) {
    pending
        .entry(thread_id)
        .and_modify(|pending| pending.invalidate(now))
        .or_insert_with(|| PendingTaskSync::new(now));
}

fn schedule_task_sync_retry(
    pending: &mut HashMap<String, PendingTaskSync>,
    thread_id: String,
    previous_attempt: u8,
    now: tokio::time::Instant,
) {
    let retry_attempt = previous_attempt.saturating_add(1);
    if retry_attempt > TASK_SYNC_MAX_RETRIES {
        return;
    }
    pending.insert(thread_id, PendingTaskSync::retry(now, retry_attempt));
}

async fn task_stream(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(_query): Query<TasksQuery>,
) -> Result<Response, ApiError> {
    if thread_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    // Subscribe before bootstrapping the canonical snapshot so notifications emitted
    // during resume cannot fall into the gap before the SSE receivers exist.
    let receiver = state.task_events.subscribe();
    let sync_receiver = state.task_sync_events.subscribe();
    let viewer = state.codex_sessions.reserve_viewer(&thread_id).await;
    let snapshot = state.codex_sessions.snapshot(&thread_id).await;
    let rollout_path = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot.thread.as_ref())
        .and_then(|thread| thread.path.clone());
    let (detail, baseline_revision) = cached_task_detail(&state, &thread_id).await?;
    let initial_frames = task_stream_initial_frames(&TaskDetailSync {
        thread_id: thread_id.clone(),
        revision: detail.revision,
        detail,
        reason: "stream-bootstrap",
        error: None,
    });
    // The rollout monitor may emit the current external activity synchronously
    // while subscribing. Register the coordinator first so that signal cannot
    // be dropped as an update for an unobserved thread.
    let subscription = state.task_sync.subscribe(&thread_id);
    let rollout_subscription = DeferredTaskRolloutSubscription::default();
    rollout_subscription.install_with(|| {
        state
            .task_rollouts
            .subscribe(&thread_id, rollout_path.as_deref())
    });
    ensure_task_sync_worker(&state).await;
    let bootstrap_state = state.clone();
    let bootstrap_thread_id = thread_id.clone();
    let bootstrap_rollout_subscription = rollout_subscription.clone();
    tokio::spawn(async move {
        bootstrap_task_session(&bootstrap_state, &bootstrap_thread_id, baseline_revision).await;
        let rollout_path = bootstrap_state
            .codex_sessions
            .snapshot(&bootstrap_thread_id)
            .await
            .and_then(|snapshot| snapshot.thread)
            .and_then(|thread| thread.path);
        bootstrap_rollout_subscription.install_with(|| {
            bootstrap_state
                .task_rollouts
                .subscribe(&bootstrap_thread_id, rollout_path.as_deref())
        });
    });
    let shutdown = state.shutdown.subscribe();
    let sessions = state.codex_sessions.clone();
    let stream = stream::unfold(
        (
            initial_frames,
            receiver,
            sync_receiver,
            shutdown,
            thread_id,
            subscription,
            rollout_subscription,
            viewer,
            sessions,
        ),
        |(
            mut initial_frames,
            mut receiver,
            mut sync_receiver,
            mut shutdown,
            thread_id,
            subscription,
            rollout_subscription,
            viewer,
            sessions,
        )| async move {
            if let Some(frame) = initial_frames.pop_front() {
                return Some((
                    Ok::<_, Infallible>(frame),
                    (
                        initial_frames,
                        receiver,
                        sync_receiver,
                        shutdown,
                        thread_id,
                        subscription,
                        rollout_subscription,
                        viewer,
                        sessions,
                    ),
                ));
            }
            loop {
                tokio::select! {
                    _ = shutdown.recv() => return None,
                    message = sync_receiver.recv() => {
                        match message {
                            Ok(sync) if sync.thread_id == thread_id => {
                                let payload = serde_json::to_string(&sync)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-sync\ndata: {payload}\n\n");
                                return Some((
                                    Ok::<_, Infallible>(Bytes::from(frame)),
                                    (
                                        initial_frames,
                                        receiver,
                                        sync_receiver,
                                        shutdown,
                                        thread_id,
                                        subscription,
                                        rollout_subscription,
                                        viewer,
                                        sessions,
                                    ),
                                ));
                            }
                            Ok(_) => continue,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                    message = receiver.recv() => {
                        match message {
                            Ok(event) if event.thread_id == thread_id => {
                                let revision = sessions
                                    .snapshot(&thread_id)
                                    .await
                                    .map(|snapshot| snapshot.revision)
                                    .unwrap_or_default();
                                let payload = serde_json::to_string(&TaskEventEnvelope {
                                    thread_id: thread_id.clone(),
                                    revision,
                                    event,
                                })
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-event\ndata: {payload}\n\n");
                                return Some((
                                    Ok::<_, Infallible>(Bytes::from(frame)),
                                    (
                                        initial_frames,
                                        receiver,
                                        sync_receiver,
                                        shutdown,
                                        thread_id,
                                        subscription,
                                        rollout_subscription,
                                        viewer,
                                        sessions,
                                    ),
                                ));
                            }
                            Ok(_) => continue,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                }
            }
        },
    );

    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(response)
}

async fn task_list_stream(State(state): State<TaskState>) -> Result<Response, ApiError> {
    Ok(task_event_stream(state, None))
}

fn task_event_stream(state: TaskState, thread_id: Option<String>) -> Response {
    let receiver = state.task_events.subscribe();
    let sync_receiver = state.task_sync_events.subscribe();
    let removal_receiver = state.task_list_removals.subscribe();
    let update_receiver = state.task_list_updates.subscribe();
    let shutdown = state.shutdown.subscribe();
    let live_task_events = state.live_task_events.clone();
    let sessions = state.codex_sessions.clone();
    let stream = stream::unfold(
        (
            receiver,
            sync_receiver,
            removal_receiver,
            update_receiver,
            shutdown,
            thread_id,
            live_task_events,
            sessions,
        ),
        |(
            mut receiver,
            mut sync_receiver,
            mut removal_receiver,
            mut update_receiver,
            mut shutdown,
            thread_id,
            live_task_events,
            sessions,
        )| async move {
            loop {
                tokio::select! {
                    _ = shutdown.recv() => return None,
                    message = removal_receiver.recv() => {
                        match message {
                            Ok(removal) if thread_id.as_ref().is_none_or(|id| id == &removal.thread_id) => {
                                let payload = serde_json::to_string(&removal)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-removed\ndata: {payload}\n\n");
                                return Some((
                                    Ok::<_, Infallible>(Bytes::from(frame)),
                                    (
                                        receiver,
                                        sync_receiver,
                                        removal_receiver,
                                        update_receiver,
                                        shutdown,
                                        thread_id,
                                        live_task_events,
                                        sessions,
                                    ),
                                ));
                            }
                            Ok(_) => continue,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                    message = update_receiver.recv() => {
                        match message {
                            Ok(task) if thread_id.as_ref().is_none_or(|id| id == &task.thread_id) => {
                                let payload = serde_json::to_string(&task)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-updated\ndata: {payload}\n\n");
                                return Some((
                                    Ok::<_, Infallible>(Bytes::from(frame)),
                                    (
                                        receiver,
                                        sync_receiver,
                                        removal_receiver,
                                        update_receiver,
                                        shutdown,
                                        thread_id,
                                        live_task_events,
                                        sessions,
                                    ),
                                ));
                            }
                            Ok(_) => continue,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                    message = sync_receiver.recv() => {
                        match message {
                            Ok(sync) if thread_id.as_ref().is_none_or(|id| id == &sync.thread_id) => {
                                let payload = serde_json::to_string(&sync)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-sync\ndata: {payload}\n\n");
                                return Some((
                                    Ok::<_, Infallible>(Bytes::from(frame)),
                                    (
                                        receiver,
                                        sync_receiver,
                                        removal_receiver,
                                        update_receiver,
                                        shutdown,
                                        thread_id,
                                        live_task_events,
                                        sessions,
                                    ),
                                ));
                            }
                            Ok(_) => continue,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                    message = receiver.recv() => {
                        match message {
                            Ok(event) if thread_id.as_ref().is_none_or(|id| id == &event.thread_id) => {
                                let event = live_task_events.record(event);
                                let revision = sessions
                                    .snapshot(&event.thread_id)
                                    .await
                                    .map(|snapshot| snapshot.revision)
                                    .unwrap_or_default();
                                let payload = serde_json::to_string(&TaskEventEnvelope {
                                    thread_id: event.thread_id.clone(),
                                    revision,
                                    event,
                                })
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-event\ndata: {payload}\n\n");
                                return Some((
                                    Ok::<_, Infallible>(Bytes::from(frame)),
                                    (
                                        receiver,
                                        sync_receiver,
                                        removal_receiver,
                                        update_receiver,
                                        shutdown,
                                        thread_id,
                                        live_task_events,
                                        sessions,
                                    ),
                                ));
                            }
                            Ok(_) => continue,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                }
            }
        },
    );

    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn task_prompt(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(_query): Query<TasksQuery>,
    Json(request): Json<TaskPromptRequest>,
) -> Result<Json<TaskPromptResponse>, ApiError> {
    if thread_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let (prompt, images) = normalize_task_input(&request.prompt, request.images)?;
    let _requested_active_turn_id = request.active_turn_id;
    let connection = require_codex_thread_connection(&state).await?;
    let requested_model = request.model;
    let requested_effort = request.effort;
    let requested_permission_mode = request.permission_mode;
    let mut target = match state
        .codex_sessions
        .prepare_prompt(&connection.client, connection.generation, &thread_id)
        .await
    {
        Ok(target) => target,
        Err(error) => {
            recover_codex_connection_error(&state, &connection, &error).await;
            return Err(error.into());
        }
    };
    let mut refreshed_stale_turn = false;
    let outcome = loop {
        let attempted_steer = matches!(&target, PromptTarget::Steer { .. });
        let result: Result<TaskPromptOutcome, _> = match target {
            PromptTarget::Steer { turn_id } => connection
                .client
                .steer_turn(&thread_id, &turn_id, &prompt, &images)
                .await
                .map(|_| TaskPromptOutcome {
                    turn_id,
                    steered: true,
                    started_turn: None,
                }),
            PromptTarget::Start { cwd } => {
                let turn_options = codex_turn_options(
                    &connection.client,
                    requested_model.clone(),
                    requested_effort.clone(),
                    requested_permission_mode,
                )
                .await?;
                let applied_options = turn_options.clone();
                connection
                    .client
                    .start_turn(&thread_id, &cwd, &prompt, &images, turn_options)
                    .await
                    .map(|started| TaskPromptOutcome {
                        turn_id: started.turn_id.clone(),
                        steered: false,
                        started_turn: Some((started.turn, applied_options)),
                    })
            }
        };
        match result {
            Ok(result) => break result,
            Err(error)
                if attempted_steer && !refreshed_stale_turn && error.is_turn_unavailable() =>
            {
                refreshed_stale_turn = true;
                if let Err(refresh_error) = state
                    .codex_sessions
                    .refresh_subscription(&connection.client, connection.generation, &thread_id)
                    .await
                {
                    state.codex_sessions.cancel_runtime(&thread_id).await;
                    recover_codex_connection_error(&state, &connection, &refresh_error).await;
                    return Err(refresh_error.into());
                }
                target = match state
                    .codex_sessions
                    .prepare_prompt(&connection.client, connection.generation, &thread_id)
                    .await
                {
                    Ok(target) => target,
                    Err(refresh_error) => {
                        state.codex_sessions.cancel_runtime(&thread_id).await;
                        recover_codex_connection_error(&state, &connection, &refresh_error).await;
                        return Err(refresh_error.into());
                    }
                };
            }
            Err(error) => {
                state.codex_sessions.cancel_runtime(&thread_id).await;
                recover_codex_connection_error(&state, &connection, &error).await;
                return Err(error.into());
            }
        }
    };
    if let Some((turn, applied_options)) = outcome.started_turn {
        state
            .codex_sessions
            .record_turn_started(
                connection.generation,
                &thread_id,
                turn,
                applied_options.permission_mode,
                applied_options.model.clone(),
                applied_options.effort.clone(),
            )
            .await;
        if let Some(snapshot) = state.codex_sessions.snapshot(&thread_id).await {
            let persistence_result = thread_store_update_composer_settings(
                &state,
                &thread_id,
                snapshot.model.as_deref(),
                snapshot.reasoning_effort.as_deref(),
            )
            .await;
            if let Err(error) = persistence_result {
                eprintln!(
                    "failed to persist composer settings for started turn on thread {thread_id}: {error:?}"
                );
            }
        }
    }
    publish_task_event(
        &state.task_events,
        &state.live_task_events,
        accepted_user_message_event(&thread_id, &outcome.turn_id, &prompt, &images),
    );
    Ok(Json(TaskPromptResponse {
        thread_id,
        turn_id: outcome.turn_id,
        steered: outcome.steered,
    }))
}

async fn task_interrupt(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(_query): Query<TasksQuery>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    if thread_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let connection = require_codex_thread_connection(&state).await?;
    let Some(turn_id) = state
        .codex_sessions
        .active_turn_id(&connection.client, connection.generation, &thread_id)
        .await?
    else {
        return Err(ApiError::BadRequest {
            code: "task_turn_missing",
            message: "thread does not have an active turn to interrupt".to_string(),
        });
    };
    if let Err(error) = connection.client.interrupt_turn(&thread_id, &turn_id).await {
        recover_codex_connection_error(&state, &connection, &error).await;
        return Err(error.into());
    }
    Ok(Json(
        read_task_detail(&state, &connection, &thread_id, None).await?,
    ))
}

async fn recover_codex_connection_error(
    state: &TaskState,
    connection: &CodexThreadConnection,
    error: &CodexThreadError,
) {
    if !error.is_connection_failure() {
        return;
    }
    let affected = state
        .codex_sessions
        .connection_lost(connection.generation, error.to_string())
        .await;
    for thread_id in affected {
        broadcast_task_sync_error(state, &thread_id, error.to_string()).await;
    }
    state
        .codex_threads
        .invalidate_after_error(connection.generation, error)
        .await;
}

async fn task_archive(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    if thread_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let connection = require_codex_thread_connection(&state).await?;
    connection.client.archive_thread(&thread_id).await?;
    thread_store_delete(&state, &thread_id).await?;
    notify_task_removed(&state, &thread_id, "archived");
    Ok(StatusCode::NO_CONTENT)
}

fn notify_task_removed(state: &TaskState, thread_id: &str, reason: &'static str) {
    let _ = state.task_list_removals.send(TaskListRemoval {
        thread_id: thread_id.to_string(),
        reason,
    });
}

async fn task_approval(
    State(state): State<TaskState>,
    AxumPath((thread_id, approval_id)): AxumPath<(String, String)>,
    Query(_query): Query<TasksQuery>,
    Json(request): Json<TaskApprovalRequest>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    if thread_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let pending = {
        let approvals = state.pending_approvals.lock().await;
        let Some(pending) = approvals.get(&approval_id).cloned() else {
            return Err(ApiError::BadRequest {
                code: "approval_not_found",
                message: "approval request is no longer pending".to_string(),
            });
        };
        pending
    };
    if pending.thread_id != thread_id {
        return Err(ApiError::BadRequest {
            code: "approval_task_mismatch",
            message: "approval request belongs to another thread".to_string(),
        });
    }
    let connection = require_codex_thread_connection(&state).await?;
    let decision = normalize_approval_decision(&request.decision)?;
    connection
        .client
        .respond_to_server_request(pending.request_id.clone(), json!({ "decision": decision }))
        .await?;
    {
        let mut approvals = state.pending_approvals.lock().await;
        approvals.remove(&approval_id);
    }

    let event = task_event_record(
        &pending.thread_id,
        &format!("approval_resolved:{approval_id}"),
        "approval_resolved",
        &format!("Approval resolved: {decision}"),
        Some(json!({
            "approvalId": approval_id,
            "kind": pending.kind.as_str(),
            "turnId": pending.params.get("turnId"),
            "decision": decision
        })),
        now_ms(),
    );
    publish_task_event(&state.task_events, &state.live_task_events, event);

    Ok(Json(
        read_task_detail(&state, &connection, &thread_id, None).await?,
    ))
}

async fn require_codex_thread_client(state: &TaskState) -> Result<CodexThreadClient, ApiError> {
    require_codex_thread_connection(state)
        .await
        .map(|connection| connection.client)
        .map_err(ApiError::from)
}

async fn require_codex_thread_connection(
    state: &TaskState,
) -> Result<CodexThreadConnection, CodexThreadError> {
    {
        let runtime = state.codex_threads.state.lock().await;
        if let Some(client) = runtime.client.clone() {
            return Ok(CodexThreadConnection {
                client,
                generation: runtime.generation,
            });
        }
    }

    let connection = {
        let mut runtime = state.codex_threads.state.lock().await;
        if let Some(client) = runtime.client.clone() {
            return Ok(CodexThreadConnection {
                client,
                generation: runtime.generation,
            });
        }

        match CodexThreadClient::start().await {
            Ok(client) => {
                runtime.generation += 1;
                let generation = runtime.generation;
                spawn_codex_thread_bridge(
                    client.clone(),
                    generation,
                    CodexThreadBridgeContext {
                        state: state.clone(),
                    },
                    state.shutdown.subscribe(),
                );
                runtime.client = Some(client.clone());
                Ok(CodexThreadConnection { client, generation })
            }
            Err(error) => Err(error),
        }
    }?;

    restore_leased_codex_sessions(state.codex_sessions.clone(), connection.clone());

    Ok(connection)
}

fn restore_leased_codex_sessions(sessions: CodexThreadSessions, connection: CodexThreadConnection) {
    tokio::spawn(async move {
        for (thread_id, error) in sessions
            .resubscribe_leased(&connection.client, connection.generation)
            .await
        {
            eprintln!("failed to restore Codex thread subscription {thread_id}: {error}");
        }
    });
}

async fn read_task_detail(
    state: &TaskState,
    connection: &CodexThreadConnection,
    thread_id: &str,
    cursor: Option<&str>,
) -> Result<TaskDetailResponse, ApiError> {
    let (snapshot, response_page) = if let Some(cursor) = cursor {
        let (snapshot, page) = state
            .codex_sessions
            .load_older_turns(
                &connection.client,
                connection.generation,
                thread_id,
                cursor,
                TASK_DETAIL_TURNS_PAGE_SIZE,
            )
            .await?;
        (snapshot, Some(page))
    } else {
        (
            state
                .codex_sessions
                .load_metadata(&connection.client, connection.generation, thread_id)
                .await?,
            None,
        )
    };
    task_detail_from_snapshot(state, snapshot, response_page).await
}

async fn cached_task_detail(
    state: &TaskState,
    thread_id: &str,
) -> Result<(TaskDetailResponse, u64), ApiError> {
    let stored = thread_store_get(state, thread_id).await?;
    let Some(snapshot) = state.codex_sessions.snapshot(thread_id).await else {
        return Ok((loading_task_detail(thread_id, 0, stored.as_ref()), 0));
    };
    if let Some(error) = snapshot.last_error.as_ref() {
        return Err(ApiError::CodexThread(format!(
            "canonical Codex task state is unavailable: {error}"
        )));
    }
    let revision = snapshot.revision;
    if snapshot.thread.is_none() {
        return Ok((
            loading_task_detail(thread_id, revision, stored.as_ref()),
            revision,
        ));
    }
    let detail = task_detail_from_snapshot(state, snapshot, None).await?;
    Ok((detail, revision))
}

fn loading_task_detail(
    thread_id: &str,
    revision: u64,
    managed: Option<&ManagedThread>,
) -> TaskDetailResponse {
    TaskDetailResponse {
        thread_id: thread_id.to_string(),
        sync_state: TaskSyncState::Loading,
        managed: true,
        revision,
        task: None,
        events: Vec::new(),
        events_page: TaskEventsPage { next_cursor: None },
        pending_approvals: Vec::new(),
        history_loading: true,
        permission_mode: None,
        model: managed.and_then(|thread| thread.model.clone()),
        reasoning_effort: managed.and_then(|thread| thread.reasoning_effort.clone()),
    }
}

async fn bootstrap_task_session(state: &TaskState, thread_id: &str, baseline_revision: u64) {
    let connection = match require_codex_thread_connection(state).await {
        Ok(connection) => connection,
        Err(error) => {
            state
                .codex_sessions
                .fail_external_sync(thread_id, &error)
                .await;
            broadcast_task_sync_error(state, thread_id, error.to_string()).await;
            return;
        }
    };
    let snapshot = match state
        .codex_sessions
        .ensure_subscribed(&connection.client, connection.generation, thread_id)
        .await
    {
        Ok(snapshot) => snapshot,
        Err(error) => {
            state
                .codex_sessions
                .fail_external_sync(thread_id, &error)
                .await;
            broadcast_task_sync_error(state, thread_id, error.to_string()).await;
            return;
        }
    };
    if snapshot.revision <= baseline_revision {
        return;
    }
    broadcast_task_snapshot(state, thread_id, snapshot, "session-bootstrap").await;
}

async fn task_detail_from_snapshot(
    state: &TaskState,
    snapshot: ThreadSessionSnapshot,
    response_page: Option<crate::codex_app_server::TurnsPage>,
) -> Result<TaskDetailResponse, ApiError> {
    let actively_viewed = snapshot.viewer_leases > 0;
    let revision = snapshot.revision;
    let permission_mode = snapshot.permission_mode;
    let session_model = snapshot.model.clone();
    let session_reasoning_effort = snapshot.reasoning_effort.clone();
    let thread_id = snapshot
        .thread
        .as_ref()
        .map(|thread| thread.id.clone())
        .ok_or_else(|| {
            ApiError::CodexThread("subscribed thread metadata is missing".to_string())
        })?;
    let page = response_page.or_else(|| snapshot.turns_page.clone());
    let history_loading = page.is_none();
    let mut turns = page
        .as_ref()
        .map(|page| page.data.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|turn| serde_json::to_value(turn).expect("decoded turn serializes"))
        .collect::<Vec<_>>();
    turns.reverse();
    let next_cursor = page.and_then(|page| page.next_cursor);
    let thread = snapshot
        .thread
        .expect("thread metadata was checked above")
        .into_value();
    let thread = thread_with_turns(&thread, turns)?;
    let mut events = thread_events(&thread);
    state.live_task_events.observe(&events);
    events = merge_task_event_records(events, state.live_task_events.for_thread(&thread_id));
    let pending_approvals = pending_approval_events(state, &thread_id).await;
    events = merge_task_event_records(events, pending_approvals.clone());
    sort_task_events(&mut events);
    let resolved_cwd = resolve_thread_cwd(&state.fs, &thread);
    let mut task = task_record_from_thread(&thread, &events, resolved_cwd.as_ref())?;
    apply_canonical_turn_projection(&mut task, &thread)?;
    let activity_ms = task_activity_ms(&task);
    let mut managed = thread_store_update_observed_recency(state, &thread_id, activity_ms).await?;
    if session_model.is_some() || session_reasoning_effort.is_some() {
        managed = thread_store_update_composer_settings(
            state,
            &thread_id,
            session_model.as_deref(),
            session_reasoning_effort.as_deref(),
        )
        .await?
        .or(managed);
    }
    if let Some(mut current) = managed {
        if actively_viewed
            && let Some(seen) =
                thread_store_mark_seen(state, &current.thread_id, activity_ms).await?
        {
            current = seen;
        }
        task.unseen = current.unseen(activity_ms);
        let model = session_model.or(current.model);
        let reasoning_effort = session_reasoning_effort.or(current.reasoning_effort);
        return Ok(TaskDetailResponse {
            thread_id,
            sync_state: TaskSyncState::Ready,
            managed: true,
            revision,
            task: Some(task),
            events,
            events_page: TaskEventsPage { next_cursor },
            pending_approvals,
            history_loading,
            permission_mode,
            model,
            reasoning_effort,
        });
    }
    Ok(TaskDetailResponse {
        thread_id,
        sync_state: TaskSyncState::Ready,
        managed: false,
        revision,
        task: Some(task),
        events,
        events_page: TaskEventsPage { next_cursor },
        pending_approvals,
        history_loading,
        permission_mode,
        model: session_model,
        reasoning_effort: session_reasoning_effort,
    })
}

fn merge_task_event_records(
    left: Vec<TaskEventRecord>,
    right: Vec<TaskEventRecord>,
) -> Vec<TaskEventRecord> {
    let mut events = HashMap::<String, TaskEventRecord>::new();
    for event in left {
        events
            .entry(event.id.clone())
            .and_modify(|existing| {
                *existing = merge_task_event_record(existing.clone(), event.clone());
            })
            .or_insert(event);
    }
    for event in right {
        events
            .entry(event.id.clone())
            .and_modify(|existing| {
                *existing =
                    merge_task_event_record_at_incoming_position(existing.clone(), event.clone());
            })
            .or_insert(event);
    }
    events.into_values().collect()
}

fn merge_task_event_record(
    existing: TaskEventRecord,
    incoming: TaskEventRecord,
) -> TaskEventRecord {
    let created_ms = existing.created_ms;
    let sort_index = existing.sort_index;
    let existing_updated_ms = existing.updated_ms.unwrap_or(existing.created_ms);
    let incoming_updated_ms = incoming.updated_ms.unwrap_or(incoming.created_ms);
    let (mut latest, earlier) = if incoming_updated_ms >= existing_updated_ms {
        (incoming, existing)
    } else {
        (existing, incoming)
    };
    latest.payload = match (earlier.payload, latest.payload.take()) {
        (Some(JsonValue::Object(mut earlier)), Some(JsonValue::Object(latest))) => {
            earlier.extend(latest);
            Some(JsonValue::Object(earlier))
        }
        (Some(earlier), None) => Some(earlier),
        (_, latest) => latest,
    };
    latest.created_ms = created_ms;
    latest.sort_index = sort_index;
    let updated_ms = existing_updated_ms.max(incoming_updated_ms);
    latest.updated_ms = (updated_ms > created_ms).then_some(updated_ms);
    latest
}

fn merge_task_event_record_at_incoming_position(
    existing: TaskEventRecord,
    incoming: TaskEventRecord,
) -> TaskEventRecord {
    let created_ms = incoming.created_ms;
    let sort_index = incoming.sort_index;
    let mut merged = merge_task_event_record(existing, incoming);
    merged.created_ms = created_ms;
    merged.sort_index = sort_index;
    merged
}

fn sort_task_events(events: &mut [TaskEventRecord]) {
    events.sort_by(|left, right| {
        left.created_ms
            .cmp(&right.created_ms)
            .then_with(|| {
                left.sort_index
                    .unwrap_or(u32::MAX)
                    .cmp(&right.sort_index.unwrap_or(u32::MAX))
            })
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn thread_with_turns(thread: &JsonValue, turns: Vec<JsonValue>) -> Result<JsonValue, ApiError> {
    let mut thread = thread.clone();
    let Some(object) = thread.as_object_mut() else {
        return Err(ApiError::CodexThread(
            "thread/read response did not include a thread object".to_string(),
        ));
    };
    object.insert("turns".to_string(), JsonValue::Array(turns));
    Ok(thread)
}

#[cfg(test)]
fn thread_list_response(fs: &RootedFs, response: &JsonValue) -> Vec<TaskRecord> {
    let mut resolved_cwds = HashMap::<String, Option<ResolvedTaskCwd>>::new();
    for cwd in response
        .get("data")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(thread_cwd)
    {
        resolved_cwds
            .entry(cwd.to_string())
            .or_insert_with(|| resolve_task_cwd(fs, cwd));
    }
    thread_list_response_with_resolved(response, &resolved_cwds)
}

async fn resolve_task_cwds(
    fs: Arc<RootedFs>,
    response: &JsonValue,
) -> HashMap<String, Option<ResolvedTaskCwd>> {
    let mut cwds = response
        .get("data")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(thread_cwd)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    cwds.sort();
    cwds.dedup();

    resolve_task_cwds_with(cwds, move |cwd| {
        let fs = fs.clone();
        async move {
            let resolve_cwd = cwd.clone();
            let resolved =
                tokio::task::spawn_blocking(move || resolve_task_cwd(fs.as_ref(), &resolve_cwd))
                    .await
                    .ok()
                    .flatten();
            (cwd, resolved)
        }
    })
    .await
}

async fn resolve_task_cwds_with<T, F, Fut>(
    cwds: Vec<String>,
    resolver: F,
) -> HashMap<String, Option<T>>
where
    T: Send,
    F: Fn(String) -> Fut,
    Fut: Future<Output = (String, Option<T>)>,
{
    stream::iter(cwds)
        .map(resolver)
        .buffer_unordered(TASK_CWD_RESOLVE_CONCURRENCY)
        .collect()
        .await
}

fn thread_list_response_with_resolved(
    response: &JsonValue,
    resolved_cwds: &HashMap<String, Option<ResolvedTaskCwd>>,
) -> Vec<TaskRecord> {
    let mut tasks = response
        .get("data")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(|thread| {
            let resolved_cwd = thread_cwd(thread)
                .and_then(|cwd| resolved_cwds.get(cwd))
                .and_then(Option::as_ref);
            task_record_from_thread(thread, &[], resolved_cwd).ok()
        })
        .collect::<Vec<_>>();
    tasks.sort_by(|left, right| {
        right
            .recency_ms
            .unwrap_or(right.updated_ms)
            .cmp(&left.recency_ms.unwrap_or(left.updated_ms))
            .then_with(|| right.updated_ms.cmp(&left.updated_ms))
    });
    tasks
}

fn task_record_from_thread(
    thread: &JsonValue,
    events: &[TaskEventRecord],
    resolved_cwd: Option<&ResolvedTaskCwd>,
) -> Result<TaskRecord, ApiError> {
    let thread_id = thread_id(thread).ok_or_else(|| ApiError::BadRequest {
        code: "thread_id_missing",
        message: "Codex thread did not include an id".to_string(),
    })?;
    let cwd = thread_cwd(thread).unwrap_or("").to_string();
    let title = non_empty_string(thread.get("name").and_then(JsonValue::as_str))
        .or_else(|| non_empty_string(thread.get("preview").and_then(JsonValue::as_str)))
        .unwrap_or_else(|| format!("Thread {}", short_thread_id(thread_id)));
    let preview = thread
        .get("preview")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let thread_status = decode_thread_status(thread.get("status"))?;
    let last_event_summary = events
        .last()
        .map(|event| event.summary.clone())
        .or_else(|| non_empty_string(Some(&preview)));
    Ok(TaskRecord {
        id: thread_id.to_string(),
        thread_id: thread_id.to_string(),
        title,
        preview,
        thread_status,
        latest_turn_status: None,
        active_turn: None,
        cwd_path: resolved_cwd.and_then(|resolved| resolved.logical_cwd.clone()),
        relative_cwd: resolved_cwd
            .and_then(|resolved| resolved.logical_cwd.clone())
            .unwrap_or_else(|| cwd.clone()),
        worktree: resolved_cwd.and_then(|resolved| resolved.worktree.clone()),
        cwd,
        created_ms: seconds_to_ms(thread.get("createdAt").and_then(JsonValue::as_f64)),
        updated_ms: seconds_to_ms(thread.get("updatedAt").and_then(JsonValue::as_f64)),
        recency_ms: thread
            .get("recencyAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value),
        last_event_summary,
        unseen: false,
    })
}

fn apply_canonical_turn_projection(
    task: &mut TaskRecord,
    thread: &JsonValue,
) -> Result<(), ApiError> {
    let turns = thread
        .get("turns")
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    task.latest_turn_status = turns
        .last()
        .map(|turn| decode_turn_status(turn.get("status")))
        .transpose()?;
    task.active_turn = if matches!(task.thread_status, ThreadStatus::Active { .. }) {
        turns
            .last()
            .filter(|turn| {
                turn.get("status").and_then(JsonValue::as_str) == Some("inProgress")
                    && turn.get("id").and_then(JsonValue::as_str).is_some()
            })
            .map(|turn| TaskActiveTurn {
                id: turn
                    .get("id")
                    .and_then(JsonValue::as_str)
                    .expect("active turn was checked above")
                    .to_string(),
                started_at_ms: turn
                    .get("startedAt")
                    .and_then(JsonValue::as_f64)
                    .map(seconds_to_ms_value)
                    .filter(|value| *value > 0),
            })
    } else {
        None
    };
    Ok(())
}

fn managed_thread_from_task_record(
    task: &TaskRecord,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> ManagedThread {
    ManagedThread::new(
        task.thread_id.clone(),
        Some(task_activity_ms(task)),
        model,
        reasoning_effort,
    )
}

fn task_activity_ms(task: &TaskRecord) -> u64 {
    task.recency_ms
        .unwrap_or_else(|| task.updated_ms.max(task.created_ms))
}

fn task_rollout_monitor(task_sync: TaskSyncCoordinator) -> TaskRolloutMonitor {
    TaskRolloutMonitor::new(move |thread_id, signal| {
        task_sync.observe_rollout_signal(thread_id, signal)
    })
}

fn thread_events(thread: &JsonValue) -> Vec<TaskEventRecord> {
    let Some(thread_id) = thread_id(thread) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    let thread_created_ms = seconds_to_ms(thread.get("createdAt").and_then(JsonValue::as_f64));
    let thread_activity_ms = thread
        .get("recencyAt")
        .and_then(JsonValue::as_f64)
        .or_else(|| thread.get("updatedAt").and_then(JsonValue::as_f64))
        .map(seconds_to_ms_value)
        .unwrap_or(thread_created_ms)
        .max(thread_created_ms);
    let turns = thread
        .get("turns")
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut previous_turn_ms = thread_created_ms.saturating_sub(1);
    for (turn_index, turn) in turns.iter().enumerate() {
        let turn_id = turn.get("id").and_then(JsonValue::as_str).unwrap_or("turn");
        let canonical_started_ms = turn
            .get("startedAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value)
            .filter(|value| *value > 0);
        let canonical_completed_ms = turn
            .get("completedAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value)
            .filter(|value| *value > 0);
        let minimum_turn_ms = if turn_index == 0 {
            thread_created_ms
        } else {
            previous_turn_ms.saturating_add(1)
        };
        let fallback_ms = canonical_completed_ms.unwrap_or_else(|| {
            if turn_index + 1 == turns.len() {
                thread_activity_ms
            } else {
                minimum_turn_ms
            }
        });
        let timeline_ms = canonical_started_ms
            .unwrap_or(fallback_ms)
            .max(minimum_turn_ms);
        if canonical_started_ms.is_some() {
            let mut started = task_event_record(
                thread_id,
                &format!("{turn_id}:started"),
                "turn_started",
                "Turn started",
                Some(json!({ "threadId": thread_id, "turnId": turn_id })),
                timeline_ms,
            );
            started.sort_index = Some(0);
            events.push(started);
        }
        for (index, item) in turn
            .get("items")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let params = json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": item
            });
            if let Some(mut event) = task_event_from_thread_item(thread_id, timeline_ms, &params) {
                event.sort_index = Some(u32::try_from(index).unwrap_or(u32::MAX).saturating_add(1));
                events.push(event);
            }
        }
        if let Some(completed_ms) = canonical_completed_ms {
            let status = turn
                .get("status")
                .and_then(JsonValue::as_str)
                .unwrap_or("completed");
            let summary = match status {
                "failed" => "Turn failed",
                "interrupted" => "Turn interrupted",
                "completed" => "Turn completed",
                _ => "Turn updated",
            };
            events.push(task_event_record(
                thread_id,
                &format!("{turn_id}:completed"),
                "turn_completed",
                summary,
                Some(json!({ "threadId": thread_id, "turnId": turn_id, "status": status })),
                completed_ms.max(timeline_ms),
            ));
            previous_turn_ms = completed_ms.max(timeline_ms);
        } else {
            previous_turn_ms = timeline_ms;
        }
    }
    events
}

async fn pending_approval_events(state: &TaskState, thread_id: &str) -> Vec<TaskEventRecord> {
    state
        .pending_approvals
        .lock()
        .await
        .iter()
        .filter(|(_, pending)| pending.thread_id == thread_id)
        .map(|(approval_id, pending)| {
            let kind = pending.kind.as_str();
            let mut event = task_event_record(
                &pending.thread_id,
                &format!("approval_requested:{approval_id}"),
                "approval_requested",
                if kind == "command" {
                    "Command approval requested"
                } else {
                    "File change approval requested"
                },
                Some(json!({
                    "approvalId": approval_id,
                    "kind": kind,
                    "turnId": pending.params.get("turnId"),
                    "params": pending.params
                })),
                pending.created_ms,
            );
            event.sort_index = pending.sort_index;
            event
        })
        .collect()
}

fn task_event_record(
    thread_id: &str,
    event_id: &str,
    event_type: &str,
    summary: &str,
    payload: Option<JsonValue>,
    created_ms: u64,
) -> TaskEventRecord {
    TaskEventRecord {
        id: format!("{thread_id}:{event_id}"),
        thread_id: thread_id.to_string(),
        event_type: event_type.to_string(),
        summary: summary.to_string(),
        payload,
        created_ms,
        updated_ms: None,
        sort_index: None,
    }
}

fn accepted_user_message_event(
    thread_id: &str,
    turn_id: &str,
    prompt: &str,
    images: &[String],
) -> TaskEventRecord {
    let content = prompt
        .is_empty()
        .then(Vec::new)
        .unwrap_or_else(|| vec![json!({ "type": "text", "text": prompt })])
        .into_iter()
        .chain(
            images
                .iter()
                .map(|url| json!({ "type": "image", "url": url })),
        )
        .collect::<Vec<_>>();
    task_event_record(
        thread_id,
        &format!("{turn_id}:accepted_user_message:{}", uuid::Uuid::new_v4()),
        "user_message",
        "User prompt",
        Some(json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "text": prompt,
            "content": content,
            "pendingCanonical": true,
        })),
        now_ms(),
    )
}

fn is_pending_canonical_user_message(event: &TaskEventRecord) -> bool {
    event.event_type == "user_message"
        && event
            .payload
            .as_ref()
            .and_then(|payload| payload.get("pendingCanonical"))
            .and_then(JsonValue::as_bool)
            .unwrap_or(false)
}

fn pending_user_message_matches(pending: &TaskEventRecord, canonical: &TaskEventRecord) -> bool {
    if !is_pending_canonical_user_message(pending) || canonical.event_type != "user_message" {
        return false;
    }
    let Some(pending_payload) = pending.payload.as_ref() else {
        return false;
    };
    let Some(canonical_payload) = canonical.payload.as_ref() else {
        return false;
    };
    pending_payload.get("turnId").and_then(JsonValue::as_str)
        == canonical_payload.get("turnId").and_then(JsonValue::as_str)
        && user_message_event_text(pending_payload) == user_message_event_text(canonical_payload)
        && user_message_event_images(pending_payload)
            == user_message_event_images(canonical_payload)
}

fn user_message_event_text(payload: &JsonValue) -> String {
    payload
        .get("text")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn user_message_event_images(payload: &JsonValue) -> Vec<String> {
    payload
        .get("content")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            matches!(
                item.get("type").and_then(JsonValue::as_str),
                Some("image" | "localImage")
            )
        })
        .map(|item| {
            item.get("url")
                .or_else(|| item.get("path"))
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_string()
        })
        .collect()
}

fn turn_item_event_id(turn_id: Option<&str>, item_id: Option<&str>, fallback: &str) -> String {
    match (turn_id, item_id) {
        (Some(turn_id), Some(item_id)) => format!("{turn_id}:{item_id}"),
        (Some(turn_id), None) => format!("{turn_id}:{fallback}"),
        (None, Some(item_id)) => item_id.to_string(),
        (None, None) => fallback.to_string(),
    }
}

struct CodexThreadBridgeContext {
    state: TaskState,
}

fn spawn_codex_thread_bridge(
    client: CodexThreadClient,
    generation: u64,
    context: CodexThreadBridgeContext,
    mut shutdown: broadcast::Receiver<()>,
) {
    tokio::spawn(async move {
        let mut receiver = client.subscribe();
        let connection_error = loop {
            tokio::select! {
                _ = shutdown.recv() => return,
                event = receiver.recv() => {
                    let event = match event {
                        Ok(event) => event,
                        Err(error) => {
                            break format!("Codex app-server event stream closed: {error}");
                        }
                    };
                    match event {
                        CodexRuntimeEvent::Notification(notification) => {
                            let thread_id =
                                codex_notification_thread_id(&notification).map(str::to_string);
                            let revision = context
                                .state
                                .codex_sessions
                                .apply_notification(generation, &notification)
                                .await;
                            expire_stale_approvals_for_notification(
                                &context.state.task_events,
                                &context.state.live_task_events,
                                &context.state.pending_approvals,
                                &notification,
                            )
                            .await;
                            handle_codex_notification(
                                &context.state.task_events,
                                &context.state.live_task_events,
                                notification,
                            );
                            if revision.is_some()
                                && let Some(thread_id) = thread_id
                                && let Some(snapshot) = context
                                    .state
                                    .codex_sessions
                                    .snapshot(&thread_id)
                                    .await
                            {
                                broadcast_task_snapshot(
                                    &context.state,
                                    &thread_id,
                                    snapshot,
                                    "app-server-notification",
                                )
                                .await;
                            }
                        }
                        CodexRuntimeEvent::ServerRequest(request) => {
                            handle_codex_server_request(
                                &context.state.task_events,
                                &context.state.live_task_events,
                                &context.state.pending_approvals,
                                request,
                            )
                            .await;
                        }
                        CodexRuntimeEvent::Diagnostic { message } => {
                            eprintln!("{message}");
                        }
                        CodexRuntimeEvent::Error { message } => {
                            break message;
                        }
                    }
                }
            }
        };
        let affected = context
            .state
            .codex_sessions
            .connection_lost(generation, connection_error.clone())
            .await;
        for thread_id in affected {
            broadcast_task_sync_error(&context.state, &thread_id, connection_error.clone()).await;
        }
        context.state.codex_threads.invalidate(generation).await;
    });
}

fn codex_notification_thread_id(notification: &CodexNotification) -> Option<&str> {
    match notification {
        CodexNotification::ThreadStarted { thread } => Some(&thread.id),
        CodexNotification::ThreadStatusChanged { thread_id, .. }
        | CodexNotification::TurnStarted { thread_id, .. }
        | CodexNotification::TurnCompleted { thread_id, .. }
        | CodexNotification::ItemStarted { thread_id, .. }
        | CodexNotification::ItemCompleted { thread_id, .. }
        | CodexNotification::RawResponseItemCompleted { thread_id, .. }
        | CodexNotification::TurnDiffUpdated { thread_id, .. } => Some(thread_id),
        CodexNotification::Unknown { .. } => None,
    }
}

fn handle_codex_notification(
    task_events: &broadcast::Sender<TaskEventRecord>,
    live_task_events: &LiveTaskEventCache,
    notification: CodexNotification,
) {
    match notification {
        CodexNotification::TurnStarted { thread_id, turn } => {
            let started_ms = turn
                .started_at
                .map(seconds_to_ms_value)
                .filter(|value| *value > 0)
                .unwrap_or_else(now_ms);
            let params = json!({ "threadId": thread_id, "turn": turn });
            let event = task_event_record(
                &thread_id,
                &event_id_from_params("turn_started", &params),
                "turn_started",
                "Turn started",
                Some(params),
                started_ms,
            );
            publish_task_event(task_events, live_task_events, event);
        }
        CodexNotification::ThreadStatusChanged { thread_id, status } => {
            let task_status = match status {
                ThreadStatus::Active { .. } => "running",
                ThreadStatus::Idle | ThreadStatus::NotLoaded => "idle",
                ThreadStatus::SystemError => "failed",
            };
            let summary = match task_status {
                "running" => "Thread running",
                "failed" => "Thread failed",
                _ => "Thread idle",
            };
            let event = task_event_record(
                &thread_id,
                "thread_status_changed",
                "thread_status_changed",
                summary,
                Some(json!({
                    "threadId": thread_id,
                    "status": task_status,
                })),
                now_ms(),
            );
            publish_task_event(task_events, live_task_events, event);
        }
        CodexNotification::ItemStarted {
            thread_id,
            turn_id,
            item,
            started_at_ms,
        } => {
            let created_ms = if started_at_ms > 0 {
                started_at_ms
            } else {
                now_ms()
            };
            let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
            if let Some(event) =
                task_event_from_item_lifecycle(&thread_id, created_ms, &params, "started")
            {
                publish_task_event(task_events, live_task_events, event);
            }
        }
        CodexNotification::ItemCompleted {
            thread_id,
            turn_id,
            item,
            completed_at_ms,
        } => {
            let created_ms = if completed_at_ms > 0 {
                completed_at_ms
            } else {
                now_ms()
            };
            let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
            if let Some(event) =
                task_event_from_item_lifecycle(&thread_id, created_ms, &params, "completed")
            {
                publish_task_event(task_events, live_task_events, event);
            }
        }
        CodexNotification::RawResponseItemCompleted {
            thread_id,
            turn_id,
            item,
        } => {
            let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
            if let Some(event) = task_event_from_raw_response_item(&thread_id, now_ms(), &params) {
                publish_task_event(task_events, live_task_events, event);
            }
        }
        CodexNotification::TurnCompleted { thread_id, turn } => {
            let task_status = match turn.status {
                TurnStatus::Failed => "failed",
                TurnStatus::Interrupted => "interrupted",
                TurnStatus::Completed => "completed",
                TurnStatus::InProgress => "running",
            };
            let summary = match task_status {
                "failed" => "Turn failed",
                "interrupted" => "Turn interrupted",
                "completed" => "Turn completed",
                _ => "Turn updated",
            };
            let completed_ms = turn
                .completed_at
                .map(seconds_to_ms_value)
                .filter(|value| *value > 0)
                .unwrap_or_else(now_ms);
            let params = json!({ "threadId": thread_id, "turn": turn });
            let event = task_event_record(
                &thread_id,
                &event_id_from_params("turn_completed", &params),
                "turn_completed",
                summary,
                Some(params),
                completed_ms,
            );
            publish_task_event(task_events, live_task_events, event);
        }
        CodexNotification::TurnDiffUpdated { thread_id, params } => {
            let event = task_event_record(
                &thread_id,
                "diff_updated",
                "diff_updated",
                "Diff updated",
                Some(params),
                now_ms(),
            );
            publish_task_event(task_events, live_task_events, event);
        }
        CodexNotification::ThreadStarted { .. } | CodexNotification::Unknown { .. } => {}
    }
}

fn publish_task_event(
    task_events: &broadcast::Sender<TaskEventRecord>,
    live_task_events: &LiveTaskEventCache,
    event: TaskEventRecord,
) {
    let event = live_task_events.record(event);
    let _ = task_events.send(event);
}

fn task_event_from_item_lifecycle(
    thread_id: &str,
    created_ms: u64,
    params: &JsonValue,
    lifecycle: &str,
) -> Option<TaskEventRecord> {
    let event = task_event_from_thread_item(thread_id, created_ms, params)
        .or_else(|| task_event_from_item_activity(thread_id, created_ms, params, lifecycle))?;
    Some(with_item_lifecycle(event, lifecycle))
}

fn with_item_lifecycle(mut event: TaskEventRecord, lifecycle: &str) -> TaskEventRecord {
    if let Some(JsonValue::Object(payload)) = event.payload.as_mut() {
        payload.insert("lifecycle".to_string(), json!(lifecycle));
    }
    event
}

fn task_event_from_item_activity(
    thread_id: &str,
    created_ms: u64,
    params: &JsonValue,
    lifecycle: &str,
) -> Option<TaskEventRecord> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let item_id = item.get("id").and_then(JsonValue::as_str)?;
    let turn_id = params.get("turnId").and_then(JsonValue::as_str);
    let started = lifecycle == "started";
    let summary = match item_type {
        "reasoning" => {
            if started {
                "Thinking"
            } else {
                "Thought"
            }
        }
        "agentMessage" => {
            if started {
                "Preparing response"
            } else {
                "Response ready"
            }
        }
        "plan" => {
            if started {
                "Updating plan"
            } else {
                "Plan updated"
            }
        }
        "mcpToolCall" | "dynamicToolCall" => {
            if started {
                "Calling tool"
            } else {
                "Tool completed"
            }
        }
        "collabAgentToolCall" => {
            if started {
                "Working with agent"
            } else {
                "Agent work completed"
            }
        }
        "webSearch" => {
            if started {
                "Searching the web"
            } else {
                "Web search completed"
            }
        }
        "imageView" => {
            if started {
                "Viewing image"
            } else {
                "Image viewed"
            }
        }
        "sleep" => {
            if started {
                "Waiting"
            } else {
                "Wait completed"
            }
        }
        _ => {
            if started {
                "Working"
            } else {
                "Work completed"
            }
        }
    };
    let event_id = turn_item_event_id(turn_id, Some(item_id), "work_status");
    Some(task_event_record(
        thread_id,
        &event_id,
        "work_status",
        summary,
        Some(json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "itemId": item_id,
            "itemType": item_type,
            "lifecycle": lifecycle,
        })),
        created_ms,
    ))
}

fn task_event_from_thread_item(
    thread_id: &str,
    created_ms: u64,
    params: &JsonValue,
) -> Option<TaskEventRecord> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let turn_id = params.get("turnId").and_then(JsonValue::as_str);
    let item_id = item.get("id").and_then(JsonValue::as_str);

    let (event_type, summary, payload) = match item_type {
        "userMessage" => {
            let text = user_message_text(item).unwrap_or_default();
            if text.is_empty() && !user_message_has_images(item) {
                return None;
            }
            (
                "user_message",
                "User prompt".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "text": text,
                    "content": item.get("content"),
                }),
            )
        }
        "agentMessage" => {
            let text = non_empty_string(item.get("text").and_then(JsonValue::as_str))?;
            (
                "assistant_message",
                "Assistant response".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "phase": item.get("phase").and_then(JsonValue::as_str),
                    "text": text,
                }),
            )
        }
        "reasoning" => {
            let summary = string_array(item.get("summary"));
            let content = string_array(item.get("content"));
            if summary.is_empty() && content.is_empty() {
                return None;
            }
            (
                "reasoning",
                reasoning_event_summary(&summary, &content),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "summary": summary,
                    "content": content,
                }),
            )
        }
        "plan" => {
            let text = non_empty_string(item.get("text").and_then(JsonValue::as_str))?;
            (
                "plan",
                "Plan updated".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "text": text,
                }),
            )
        }
        "commandExecution" => (
            "command_execution",
            command_execution_summary(item),
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "command": item.get("command").and_then(JsonValue::as_str),
                "cwd": item.get("cwd").and_then(JsonValue::as_str),
                "status": item.get("status").and_then(JsonValue::as_str),
                "aggregatedOutput": item.get("aggregatedOutput").and_then(JsonValue::as_str),
                "exitCode": item.get("exitCode"),
                "durationMs": item.get("durationMs"),
            }),
        ),
        "fileChange" => {
            let change_count = item
                .get("changes")
                .and_then(JsonValue::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            (
                "file_change",
                format!("File changes: {change_count}"),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "changeCount": change_count,
                    "status": item.get("status").and_then(JsonValue::as_str),
                    "changes": item.get("changes"),
                }),
            )
        }
        _ => return None,
    };
    let event_id = turn_item_event_id(turn_id, item_id, event_type);
    Some(task_event_record(
        thread_id,
        &event_id,
        event_type,
        &summary,
        Some(payload),
        created_ms,
    ))
}

fn task_event_from_raw_response_item(
    thread_id: &str,
    created_ms: u64,
    params: &JsonValue,
) -> Option<TaskEventRecord> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let turn_id = params.get("turnId").and_then(JsonValue::as_str);
    let item_id = item.get("id").and_then(JsonValue::as_str);

    let (event_type, summary, payload) = match item_type {
        "message" => {
            let role = item.get("role").and_then(JsonValue::as_str).unwrap_or("");
            if role != "assistant" {
                return None;
            }
            let text = response_content_text(item.get("content"))?;
            (
                "assistant_message",
                "Assistant response".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "phase": item.get("phase").and_then(JsonValue::as_str),
                    "text": text,
                }),
            )
        }
        "reasoning" => {
            let summary = reasoning_response_summary(item.get("summary"));
            let content = reasoning_response_content(item.get("content"));
            if summary.is_empty() && content.is_empty() {
                return None;
            }
            (
                "reasoning",
                reasoning_event_summary(&summary, &content),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "summary": summary,
                    "content": content,
                }),
            )
        }
        _ => return None,
    };
    let event_id = turn_item_event_id(turn_id, item_id, event_type);
    Some(task_event_record(
        thread_id,
        &event_id,
        event_type,
        &summary,
        Some(payload),
        created_ms,
    ))
}

fn user_message_text(item: &JsonValue) -> Option<String> {
    let content = item.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("text" | "input_text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .collect::<Vec<_>>()
        .join("\n\n");
    non_empty_string(Some(strip_ambient_browser_context(&text)))
}

fn strip_ambient_browser_context(text: &str) -> &str {
    const LEGACY_PREFIX: &str =
        "This block is automatically supplied ambient UI state, not part of the user's request.";
    const STRUCTURED_PREFIX: &str = "<in-app-browser-context source=\"ambient-ui-state\">";
    let trimmed = text.trim_start();
    let ambient_start = trimmed
        .find(STRUCTURED_PREFIX)
        .or_else(|| trimmed.find(LEGACY_PREFIX));
    let Some(ambient_start) = ambient_start else {
        return text;
    };
    let ambient = &trimmed[ambient_start..];

    for marker in ["## My request for Codex:", "My request for Codex:"] {
        if let Some(start) = ambient.rfind(marker) {
            let request = ambient[start + marker.len()..].trim();
            if !request.is_empty() {
                return request;
            }
        }
    }
    text
}

fn user_message_has_images(item: &JsonValue) -> bool {
    item.get("content")
        .and_then(JsonValue::as_array)
        .is_some_and(|content| {
            content.iter().any(|entry| {
                matches!(
                    entry.get("type").and_then(JsonValue::as_str),
                    Some("image" | "localImage")
                )
            })
        })
}

fn response_content_text(content: Option<&JsonValue>) -> Option<String> {
    let content = content?.as_array()?;
    let text = content
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("output_text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .collect::<Vec<_>>()
        .join("\n\n");
    non_empty_string(Some(&text))
}

fn reasoning_response_summary(summary: Option<&JsonValue>) -> Vec<String> {
    let Some(summary) = summary.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    summary
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("summary_text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

fn reasoning_response_content(content: Option<&JsonValue>) -> Vec<String> {
    let Some(content) = content.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|entry| {
            entry.as_str().or_else(|| {
                entry
                    .get("text")
                    .and_then(JsonValue::as_str)
                    .or_else(|| entry.get("content").and_then(JsonValue::as_str))
            })
        })
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

fn reasoning_event_summary(summary: &[String], content: &[String]) -> String {
    if summary.is_empty() && !content.is_empty() {
        "Reasoning".to_string()
    } else {
        "Reasoning summary".to_string()
    }
}

fn string_array(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

fn non_empty_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn command_execution_summary(item: &JsonValue) -> String {
    let status = item
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or("updated");
    format!("Command {status}")
}

async fn handle_codex_server_request(
    task_events: &broadcast::Sender<TaskEventRecord>,
    live_task_events: &LiveTaskEventCache,
    pending_approvals: &Arc<AsyncMutex<HashMap<String, PendingApproval>>>,
    request: CodexServerRequest,
) {
    let (request_id, thread_id, params, kind) = match request {
        CodexServerRequest::CommandExecutionApproval {
            id,
            thread_id,
            params,
        } => (id, thread_id, params, ApprovalKind::Command),
        CodexServerRequest::FileChangeApproval {
            id,
            thread_id,
            params,
        } => (id, thread_id, params, ApprovalKind::FileChange),
        CodexServerRequest::Unknown { .. } => return,
    };
    let approval_id = approval_id_from_request(&request_id, &params);
    let created_ms = now_ms();
    let summary = if kind == ApprovalKind::Command {
        "Command approval requested"
    } else {
        "File change approval requested"
    };
    let event = task_event_record(
        &thread_id,
        &format!("approval_requested:{approval_id}"),
        "approval_requested",
        summary,
        Some(json!({
            "approvalId": approval_id,
            "kind": kind.as_str(),
            "turnId": params.get("turnId"),
            "requestId": request_id,
            "params": params
        })),
        created_ms,
    );
    let mut approvals = pending_approvals.lock().await;
    let event = live_task_events.record(event);
    approvals.insert(
        approval_id.clone(),
        PendingApproval {
            thread_id: thread_id.clone(),
            request_id: request_id.clone(),
            kind,
            params: params.clone(),
            created_ms: event.created_ms,
            sort_index: event.sort_index,
        },
    );
    drop(approvals);

    let _ = task_events.send(event);
}

async fn expire_stale_approvals_for_notification(
    task_events: &broadcast::Sender<TaskEventRecord>,
    live_task_events: &LiveTaskEventCache,
    pending_approvals: &Arc<AsyncMutex<HashMap<String, PendingApproval>>>,
    notification: &CodexNotification,
) {
    let expired = {
        let mut approvals = pending_approvals.lock().await;
        let expired_ids = approvals
            .iter()
            .filter_map(|(approval_id, pending)| {
                stale_approval_reason(pending, notification)
                    .map(|reason| (approval_id.clone(), reason))
            })
            .collect::<Vec<_>>();
        expired_ids
            .into_iter()
            .filter_map(|(approval_id, reason)| {
                approvals
                    .remove(&approval_id)
                    .map(|pending| (approval_id, pending, reason))
            })
            .collect::<Vec<_>>()
    };

    for (approval_id, pending, reason) in expired {
        let event = task_event_record(
            &pending.thread_id,
            &format!("approval_resolved:{approval_id}"),
            "approval_resolved",
            "Approval expired",
            Some(json!({
                "approvalId": approval_id,
                "kind": pending.kind.as_str(),
                "turnId": pending.params.get("turnId"),
                "decision": "expired",
                "reason": reason
            })),
            now_ms(),
        );
        publish_task_event(task_events, live_task_events, event);
    }
}

fn stale_approval_reason(
    pending: &PendingApproval,
    notification: &CodexNotification,
) -> Option<&'static str> {
    match notification {
        CodexNotification::TurnStarted { thread_id, turn }
            if pending.thread_id == *thread_id
                && pending
                    .params
                    .get("turnId")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|turn_id| turn_id != turn.id) =>
        {
            Some("another turn started")
        }
        CodexNotification::TurnCompleted { thread_id, turn }
            if pending.thread_id == *thread_id
                && turn.status != TurnStatus::InProgress
                && pending
                    .params
                    .get("turnId")
                    .and_then(JsonValue::as_str)
                    .is_none_or(|turn_id| turn_id == turn.id) =>
        {
            Some("turn completed")
        }
        CodexNotification::ThreadStatusChanged { thread_id, status }
            if pending.thread_id == *thread_id
                && matches!(status, ThreadStatus::Idle | ThreadStatus::SystemError) =>
        {
            Some("thread became inactive")
        }
        _ => None,
    }
}

fn approval_id_from_request(request_id: &JsonValue, params: &JsonValue) -> String {
    params
        .get("approvalId")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| match request_id {
            JsonValue::String(value) => value.clone(),
            JsonValue::Number(value) => value.to_string(),
            _ => request_id.to_string(),
        })
}

fn resolve_thread_cwd(fs: &RootedFs, thread: &JsonValue) -> Option<ResolvedTaskCwd> {
    thread_cwd(thread).and_then(|cwd| resolve_task_cwd(fs, cwd))
}

fn resolve_task_cwd(fs: &RootedFs, cwd: &str) -> Option<ResolvedTaskCwd> {
    let canonical_cwd = Path::new(cwd).canonicalize().ok()?;
    if !canonical_cwd.is_dir() {
        return None;
    }
    let logical_cwd = fs.logical_path_for_absolute(&canonical_cwd).ok();
    if !has_git_ancestor(&canonical_cwd) {
        return Some(ResolvedTaskCwd {
            canonical_cwd,
            logical_cwd,
            worktree: None,
            worktree_root: None,
            repository_common_dir: None,
        });
    }
    let Some(repository) = git::repository_for(&canonical_cwd) else {
        return Some(ResolvedTaskCwd {
            canonical_cwd,
            logical_cwd,
            worktree: None,
            worktree_root: None,
            repository_common_dir: None,
        });
    };
    let root_path = fs.logical_path_for_absolute(&repository.root).ok()?;
    let metadata = git::repository_metadata_paths(&repository);
    let repository_root_path = metadata
        .as_ref()
        .and_then(|paths| {
            if paths
                .common_dir
                .file_name()
                .is_some_and(|name| name == ".git")
            {
                paths.common_dir.parent()
            } else {
                None
            }
        })
        .and_then(|root| fs.logical_path_for_absolute(root).ok())
        .unwrap_or_else(|| root_path.clone());
    let linked = metadata
        .as_ref()
        .is_some_and(|paths| paths.git_dir != paths.common_dir);
    let head_sha = git::head_sha(&repository).unwrap_or_default();
    let branch = repository
        .branch
        .filter(|branch| !branch.starts_with("HEAD "));
    let relative_cwd = canonical_cwd
        .strip_prefix(&repository.root)
        .ok()
        .map(relative_path_string)
        .unwrap_or_default();

    Some(ResolvedTaskCwd {
        canonical_cwd,
        logical_cwd,
        worktree: Some(TaskWorktreeContext {
            root_path,
            repository_root_path,
            branch,
            head_sha,
            relative_cwd,
            linked,
        }),
        worktree_root: Some(repository.root),
        repository_common_dir: metadata.map(|paths| paths.common_dir),
    })
}

fn has_git_ancestor(path: &Path) -> bool {
    path.ancestors().any(git::has_git_marker)
}

fn thread_id(thread: &JsonValue) -> Option<&str> {
    thread.get("id").and_then(JsonValue::as_str)
}

fn thread_cwd(thread: &JsonValue) -> Option<&str> {
    thread.get("cwd").and_then(JsonValue::as_str)
}

fn decode_thread_status(status: Option<&JsonValue>) -> Result<ThreadStatus, ApiError> {
    serde_json::from_value(status.cloned().ok_or_else(|| {
        ApiError::CodexThread("Codex thread did not include a status".to_string())
    })?)
    .map_err(|error| ApiError::CodexThread(format!("invalid Codex thread status: {error}")))
}

fn decode_turn_status(status: Option<&JsonValue>) -> Result<TurnStatus, ApiError> {
    serde_json::from_value(
        status.cloned().ok_or_else(|| {
            ApiError::CodexThread("Codex turn did not include a status".to_string())
        })?,
    )
    .map_err(|error| ApiError::CodexThread(format!("invalid Codex turn status: {error}")))
}

fn seconds_to_ms(value: Option<f64>) -> u64 {
    value.map(seconds_to_ms_value).unwrap_or(0)
}

fn seconds_to_ms_value(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        (value * 1000.0) as u64
    } else {
        0
    }
}

fn event_id_from_params(prefix: &str, params: &JsonValue) -> String {
    let turn_id = params
        .get("turnId")
        .or_else(|| params.pointer("/turn/id"))
        .and_then(JsonValue::as_str)
        .unwrap_or("turn");
    format!("{prefix}:{turn_id}")
}

fn short_thread_id(thread_id: &str) -> &str {
    thread_id.get(..8).unwrap_or(thread_id)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn task_cwd(state: &TaskState, relative: Option<&str>) -> Result<String, ApiError> {
    let logical_path = normalize_logical_path(relative.unwrap_or(&state.default_cwd_path))?;
    let cwd = state.fs.absolute_directory_path(&logical_path)?;
    Ok(cwd.display().to_string())
}

fn relative_path_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn normalize_logical_path(path: &str) -> Result<String, ApiError> {
    let mut parts = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(ApiError::BadRequest {
                code: "invalid_task_cwd",
                message: "task cwd must stay inside the server root".to_string(),
            });
        }
        parts.push(segment);
    }
    Ok(parts.join("/"))
}

fn normalize_task_input(
    prompt: &str,
    images: Vec<String>,
) -> Result<(String, Vec<String>), ApiError> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() && images.is_empty() {
        return Err(ApiError::BadRequest {
            code: "empty_task_prompt",
            message: "task prompt or image cannot be empty".to_string(),
        });
    }
    if images.len() > MAX_TASK_IMAGES {
        return Err(ApiError::BadRequest {
            code: "too_many_task_images",
            message: format!("a task turn can include at most {MAX_TASK_IMAGES} images"),
        });
    }
    for image in &images {
        validate_task_image_data_url(image)?;
    }
    Ok((prompt, images))
}

fn validate_task_image_data_url(image: &str) -> Result<(), ApiError> {
    const PREFIXES: [&str; 6] = [
        "data:image/avif;base64,",
        "data:image/gif;base64,",
        "data:image/jpeg;base64,",
        "data:image/jpg;base64,",
        "data:image/png;base64,",
        "data:image/webp;base64,",
    ];
    let Some(encoded) = PREFIXES
        .iter()
        .find_map(|prefix| image.strip_prefix(prefix))
    else {
        return Err(ApiError::BadRequest {
            code: "invalid_task_image",
            message: "task images must be base64-encoded raster image data URLs".to_string(),
        });
    };
    if encoded.is_empty()
        || encoded.len() % 4 != 0
        || encoded
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'+' | b'/' | b'='))
    {
        return Err(ApiError::BadRequest {
            code: "invalid_task_image",
            message: "task image data is not valid base64".to_string(),
        });
    }
    let padding = encoded
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'=')
        .count();
    if padding > 2 || encoded[..encoded.len().saturating_sub(padding)].contains('=') {
        return Err(ApiError::BadRequest {
            code: "invalid_task_image",
            message: "task image data is not valid base64".to_string(),
        });
    }
    let decoded_bytes = encoded.len() / 4 * 3 - padding;
    if decoded_bytes as u64 > MAX_IMAGE_BYTES {
        return Err(ApiError::BadRequest {
            code: "task_image_too_large",
            message: format!("task images must be at most {MAX_IMAGE_BYTES} bytes each"),
        });
    }
    Ok(())
}

async fn codex_turn_options(
    client: &CodexThreadClient,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<CodexPermissionMode>,
) -> Result<CodexTurnOptions, ApiError> {
    let model = normalize_codex_model(model)?;
    let effort = normalize_codex_effort(effort)?;
    if model.is_none() && effort.is_none() {
        return Ok(CodexTurnOptions {
            model,
            effort,
            permission_mode,
        });
    }

    let models = client.list_models(100).await.map_err(ApiError::from)?.data;
    let selected_model = match model.as_deref() {
        Some(requested) => models
            .iter()
            .find(|candidate| candidate.model == requested || candidate.id == requested),
        None => models
            .iter()
            .find(|candidate| candidate.is_default)
            .or_else(|| models.first()),
    };

    let Some(selected_model) = selected_model else {
        let (code, message) = if model.is_some() {
            ("invalid_codex_model", "Codex model value is not supported")
        } else {
            (
                "invalid_codex_effort",
                "Codex reasoning effort is not supported",
            )
        };
        return Err(ApiError::BadRequest {
            code,
            message: message.to_string(),
        });
    };

    if effort.as_deref().is_some_and(|requested| {
        !selected_model
            .supported_reasoning_efforts
            .iter()
            .filter_map(codex_reasoning_effort_value)
            .any(|supported| supported == requested)
    }) {
        return Err(ApiError::BadRequest {
            code: "invalid_codex_effort",
            message: "Codex reasoning effort is not supported".to_string(),
        });
    }

    Ok(CodexTurnOptions {
        model,
        effort,
        permission_mode,
    })
}

fn normalize_codex_model(model: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(model) = model else {
        return Ok(None);
    };
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    if model.len() > 128 || model.chars().any(char::is_control) {
        return Err(ApiError::BadRequest {
            code: "invalid_codex_model",
            message: "Codex model value is not supported".to_string(),
        });
    }
    Ok(Some(model.to_string()))
}

fn normalize_codex_effort(effort: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(effort) = effort else {
        return Ok(None);
    };
    let effort = effort.trim();
    if effort.is_empty() {
        return Ok(None);
    }
    if effort.len() > 32 || effort.chars().any(char::is_control) {
        return Err(ApiError::BadRequest {
            code: "invalid_codex_effort",
            message: "Codex reasoning effort is not supported".to_string(),
        });
    }
    Ok(Some(effort.to_string()))
}

fn normalize_approval_decision(decision: &str) -> Result<&str, ApiError> {
    match decision {
        "accept" | "acceptForSession" | "decline" | "cancel" => Ok(decision),
        _ => Err(ApiError::BadRequest {
            code: "invalid_approval_decision",
            message: "approval decision is not supported".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests;
