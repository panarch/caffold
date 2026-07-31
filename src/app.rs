use std::{
    collections::{HashMap, HashSet, VecDeque},
    convert::Infallible,
    net::IpAddr,
    path::PathBuf,
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
mod tasks;
mod workspace;

use error::ApiError;
use tasks::{
    ApprovalResolveError, CodexConnection, CodexRuntime, CodexRuntimeSignal, TaskEventRecord,
    TaskEvents, TaskRecord, accepted_user_message_event, apply_canonical_turn_projection,
    merge_task_event_records, now_ms, resolve_task_cwds, resolve_thread_cwd, sort_task_events,
    task_activity_ms, task_record_from_thread, thread_events, thread_list_response_with_resolved,
    thread_with_turns,
};

use crate::{
    codex_app_server::{
        self, CodexPermissionMode, CodexStatusResponse, CodexThreadClient, CodexThreadError,
        CodexTurnOptions,
    },
    codex_thread_sessions::{
        CodexThreadSessions, PromptTarget, ThreadSessionSnapshot, ThreadSessionsDiagnostics,
    },
    fs::{MAX_IMAGE_BYTES, RootedFs},
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
    codex_runtime: CodexRuntime,
    codex_runtime_signals: Arc<AsyncMutex<Option<broadcast::Receiver<CodexRuntimeSignal>>>>,
    codex_sessions: CodexThreadSessions,
    task_events: TaskEvents,
    task_sync: TaskSyncCoordinator,
    task_sync_events: broadcast::Sender<TaskDetailSync>,
    task_list_removals: broadcast::Sender<TaskListRemoval>,
    task_list_updates: broadcast::Sender<TaskRecord>,
    thread_store: ThreadStore,
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
        let task_events = TaskEvents::default();
        let codex_sessions = CodexThreadSessions::default();
        let codex_runtime = CodexRuntime::new(
            codex_sessions.clone(),
            task_events.clone(),
            shutdown.clone(),
        );
        let codex_runtime_signals = codex_runtime.subscribe();
        let task_sync = TaskSyncCoordinator::new();
        let (task_sync_events, _) = broadcast::channel(64);
        let (task_list_removals, _) = broadcast::channel(64);
        let (task_list_updates, _) = broadcast::channel(64);
        let task_rollouts = task_rollout_monitor(task_sync.clone());
        Self {
            fs,
            default_cwd_path,
            codex_runtime,
            codex_runtime_signals: Arc::new(AsyncMutex::new(Some(codex_runtime_signals))),
            codex_sessions,
            task_events,
            task_sync,
            task_sync_events,
            task_list_removals,
            task_list_updates,
            thread_store,
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
    let codex_runtime = task_state.codex_runtime.clone();
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
    codex_runtime.shutdown().await;
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
                let (generation, connected) = state.codex_runtime.diagnostics().await;
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
    state.task_events.publish(accepted_user_message_event(
        &thread.thread_id,
        &turn.turn_id,
        &prompt,
        &images,
    ));
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
    let live_task_events = state.task_events.cache().clone();
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
            state
                .codex_runtime
                .recover_connection_error(&connection, &error)
                .await;
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
                    state
                        .codex_runtime
                        .recover_connection_error(&connection, &refresh_error)
                        .await;
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
                        state
                            .codex_runtime
                            .recover_connection_error(&connection, &refresh_error)
                            .await;
                        return Err(refresh_error.into());
                    }
                };
            }
            Err(error) => {
                state.codex_sessions.cancel_runtime(&thread_id).await;
                state
                    .codex_runtime
                    .recover_connection_error(&connection, &error)
                    .await;
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
    state.task_events.publish(accepted_user_message_event(
        &thread_id,
        &outcome.turn_id,
        &prompt,
        &images,
    ));
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
        state
            .codex_runtime
            .recover_connection_error(&connection, &error)
            .await;
        return Err(error.into());
    }
    Ok(Json(
        read_task_detail(&state, &connection, &thread_id, None).await?,
    ))
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
    let connection = require_codex_thread_connection(&state).await?;
    let decision = normalize_approval_decision(&request.decision)?;
    match state
        .codex_runtime
        .resolve_approval(&connection, &thread_id, &approval_id, decision)
        .await
    {
        Ok(()) => {}
        Err(ApprovalResolveError::NotFound) => {
            return Err(ApiError::BadRequest {
                code: "approval_not_found",
                message: "approval request is no longer pending".to_string(),
            });
        }
        Err(ApprovalResolveError::ThreadMismatch) => {
            return Err(ApiError::BadRequest {
                code: "approval_task_mismatch",
                message: "approval request belongs to another thread".to_string(),
            });
        }
        Err(ApprovalResolveError::Codex(error)) => return Err(error.into()),
    }

    Ok(Json(
        read_task_detail(&state, &connection, &thread_id, None).await?,
    ))
}

async fn require_codex_thread_client(state: &TaskState) -> Result<CodexThreadClient, ApiError> {
    ensure_codex_runtime_signal_driver(state).await;
    state.codex_runtime.client().await.map_err(ApiError::from)
}

async fn require_codex_thread_connection(
    state: &TaskState,
) -> Result<CodexConnection, CodexThreadError> {
    ensure_codex_runtime_signal_driver(state).await;
    state.codex_runtime.connection().await
}

async fn ensure_codex_runtime_signal_driver(state: &TaskState) {
    let Some(mut receiver) = state.codex_runtime_signals.lock().await.take() else {
        return;
    };
    let state = state.clone();
    let mut shutdown = state.shutdown.subscribe();
    tokio::spawn(async move {
        loop {
            let signal = tokio::select! {
                _ = shutdown.recv() => return,
                signal = receiver.recv() => signal,
            };
            match signal {
                Ok(CodexRuntimeSignal::SessionChanged {
                    thread_id,
                    snapshot,
                }) => {
                    broadcast_task_snapshot(
                        &state,
                        &thread_id,
                        *snapshot,
                        "app-server-notification",
                    )
                    .await;
                }
                Ok(CodexRuntimeSignal::SessionUnavailable { thread_id, message }) => {
                    broadcast_task_sync_error(&state, &thread_id, message).await;
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

async fn read_task_detail(
    state: &TaskState,
    connection: &CodexConnection,
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
    state.task_events.observe(&events);
    events = merge_task_event_records(events, state.task_events.for_thread(&thread_id));
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

fn task_rollout_monitor(task_sync: TaskSyncCoordinator) -> TaskRolloutMonitor {
    TaskRolloutMonitor::new(move |thread_id, signal| {
        task_sync.observe_rollout_signal(thread_id, signal)
    })
}

async fn pending_approval_events(state: &TaskState, thread_id: &str) -> Vec<TaskEventRecord> {
    state.codex_runtime.approval_events(thread_id).await
}

fn task_cwd(state: &TaskState, relative: Option<&str>) -> Result<String, ApiError> {
    let logical_path = normalize_logical_path(relative.unwrap_or(&state.default_cwd_path))?;
    let cwd = state.fs.absolute_directory_path(&logical_path)?;
    Ok(cwd.display().to_string())
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
