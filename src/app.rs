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
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc};
use tracing::info;

use crate::{
    codex_app_server::{
        self, CodexNotification, CodexPermissionMode, CodexRuntimeEvent, CodexServerRequest,
        CodexStatusResponse, CodexThreadClient, CodexThreadError, CodexTurnOptions, ThreadStatus,
        TurnStatus,
    },
    codex_thread_sessions::{
        CodexThreadSessions, PromptTarget, ThreadSessionSnapshot, ThreadSessionsDiagnostics,
    },
    fs::{
        FileResponse, FsError, GitCommitResponse, GitCompareResponse, GitDiffResponse,
        GitLogResponse, GitRefsResponse, GitStatusResponse, GithubIssueResponse,
        GithubIssuesResponse, GithubPullFileResponse, GithubPullFilesResponse, GithubPullResponse,
        GithubPullsResponse, GithubStatusResponse, ListResponse, MAX_FILE_BYTES, MAX_IMAGE_BYTES,
        RootedFs,
    },
    git,
    server_settings::{ServerSettings, ServerSettingsError, ServerSettingsStore},
    static_assets,
    task_rollout::{TaskRolloutMonitor, TaskRolloutSignal, TaskRolloutSubscription},
    thread_store::{StoredThread, ThreadStore, ThreadStoreError},
    watch::{WatchChange, WatchError, WatchHub, WatchMessage},
};

const TASK_DETAIL_TURNS_PAGE_SIZE: usize = 8;
const LIST_DIRECTORY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TASK_IMAGES: usize = 4;
const MAX_TASK_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const TASK_LIST_PAGE_SIZE: usize = 30;
const TASK_SYNC_DEBOUNCE: Duration = Duration::from_millis(600);
const TASK_SYNC_MAX_LATENCY: Duration = Duration::from_secs(2);
const TASK_SYNC_RETRY_BASE: Duration = Duration::from_secs(2);
const TASK_SYNC_MAX_RETRIES: u8 = 3;
const TASK_CWD_RESOLVE_CONCURRENCY: usize = 8;

#[derive(Debug, Clone)]
pub struct ServeConfig {
    pub host: IpAddr,
    pub port: u16,
    pub root: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    fs: Arc<RootedFs>,
    server_settings: Arc<ServerSettingsStore>,
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
    watch_hub: WatchHub,
    shutdown: broadcast::Sender<()>,
    initial_path: String,
    home_path: Option<String>,
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
struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Debug, Deserialize)]
struct GitDiffQuery {
    #[serde(default)]
    path: String,
    file: String,
    #[serde(default = "default_diff_kind")]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct GitLogQuery {
    #[serde(default)]
    path: String,
    #[serde(default = "default_git_log_page")]
    page: usize,
    #[serde(rename = "perPage")]
    per_page: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GitCommitQuery {
    #[serde(default)]
    path: String,
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GitCommitDiffQuery {
    #[serde(default)]
    path: String,
    sha: String,
    file: String,
}

#[derive(Debug, Deserialize)]
struct GitCompareQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    head: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitCompareDiffQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    head: Option<String>,
    file: String,
}

#[derive(Debug, Deserialize)]
struct GithubIssuesQuery {
    #[serde(default)]
    path: String,
    #[serde(default = "default_github_issue_state")]
    state: String,
    #[serde(default = "default_github_issues_page")]
    page: usize,
    #[serde(rename = "perPage")]
    per_page: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GithubIssueQuery {
    #[serde(default)]
    path: String,
    number: u64,
}

#[derive(Debug, Deserialize)]
struct GithubPullsQuery {
    #[serde(default)]
    path: String,
    #[serde(default = "default_github_issue_state")]
    state: String,
    #[serde(default = "default_github_issues_page")]
    page: usize,
    #[serde(rename = "perPage")]
    per_page: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GithubPullQuery {
    #[serde(default)]
    path: String,
    number: u64,
}

#[derive(Debug, Deserialize)]
struct GithubPullFileQuery {
    #[serde(default)]
    path: String,
    number: u64,
    file: String,
}

#[derive(Debug, Deserialize)]
struct UpdateServerSettingsRequest {
    name: String,
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
struct TaskImageQuery {
    path: String,
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
struct HealthResponse {
    status: &'static str,
    build_id: &'static str,
    build_label: &'static str,
    build_number: &'static str,
    server_name: String,
    root: String,
    initial_path: String,
    home_path: Option<String>,
    max_file_bytes: u64,
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
    status: String,
    cwd: String,
    cwd_path: Option<String>,
    relative_cwd: String,
    worktree: Option<TaskWorktreeContext>,
    created_ms: u64,
    updated_ms: u64,
    recency_ms: Option<u64>,
    active_turn_id: Option<String>,
    active_turn_started_ms: Option<u64>,
    last_event_summary: Option<String>,
    unseen: bool,
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
    managed: bool,
    revision: u64,
    task: TaskRecord,
    events: Vec<TaskEventRecord>,
    events_page: TaskEventsPage,
    pending_approvals: Vec<TaskEventRecord>,
    history_loading: bool,
    permission_mode: Option<CodexPermissionMode>,
    model: Option<String>,
    reasoning_effort: Option<String>,
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

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
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
    let (task_events, _) = broadcast::channel(256);
    let task_sync = TaskSyncCoordinator::new();
    let (task_sync_events, _) = broadcast::channel(64);
    let (task_list_removals, _) = broadcast::channel(64);
    let (task_list_updates, _) = broadcast::channel(64);
    let task_rollouts = task_rollout_monitor(task_sync.clone());
    let (shutdown, _) = broadcast::channel(16);
    let pending_approvals = Arc::new(AsyncMutex::new(HashMap::new()));
    let codex_threads = Arc::new(CodexThreadRuntime::default());
    let codex_sessions = CodexThreadSessions::default();
    let fs = Arc::new(fs);
    let root = fs.root().to_path_buf();
    let watch_hub = WatchHub::new(fs.clone(), shutdown.clone());
    let app = router_with_state(AppState {
        fs,
        server_settings,
        codex_threads: codex_threads.clone(),
        codex_sessions,
        pending_approvals,
        task_events,
        task_sync,
        task_sync_events,
        task_list_removals,
        task_list_updates,
        thread_store,
        live_task_events: LiveTaskEventCache::default(),
        task_rollouts,
        watch_hub,
        shutdown: shutdown.clone(),
        initial_path: initial_path.clone(),
        home_path,
    });
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
    let (task_events, _) = broadcast::channel(256);
    let task_sync = TaskSyncCoordinator::new();
    let (task_sync_events, _) = broadcast::channel(64);
    let (task_list_removals, _) = broadcast::channel(64);
    let (task_list_updates, _) = broadcast::channel(64);
    let task_rollouts = task_rollout_monitor(task_sync.clone());
    let (shutdown, _) = broadcast::channel(16);
    let fs = Arc::new(fs);
    let watch_hub = WatchHub::new(fs.clone(), shutdown.clone());
    Ok(router_with_state(AppState {
        fs,
        server_settings: Arc::new(ServerSettingsStore::memory()),
        codex_threads: Arc::new(CodexThreadRuntime::default()),
        codex_sessions: CodexThreadSessions::default(),
        pending_approvals: Arc::new(AsyncMutex::new(HashMap::new())),
        task_events,
        task_sync,
        task_sync_events,
        task_list_removals,
        task_list_updates,
        thread_store: ThreadStore::memory()?,
        live_task_events: LiveTaskEventCache::default(),
        task_rollouts,
        watch_hub,
        shutdown,
        initial_path: String::new(),
        home_path: None,
    }))
}

fn router_with_state(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/health", get(health))
        .route(
            "/api/server/settings",
            get(get_server_settings).patch(update_server_settings),
        )
        .route("/api/list", get(list))
        .route("/api/file", get(file))
        .route("/api/image", get(image))
        .route("/api/task-image", get(task_image))
        .route("/api/watch", get(watch_stream))
        .route("/api/git/status", get(git_status))
        .route("/api/git/diff", get(git_diff))
        .route("/api/git/log", get(git_log))
        .route("/api/git/commit", get(git_commit))
        .route("/api/git/commit-diff", get(git_commit_diff))
        .route("/api/git/compare", get(git_compare))
        .route("/api/git/compare-diff", get(git_compare_diff))
        .route("/api/git/refs", get(git_refs))
        .route("/api/github/status", get(github_status))
        .route("/api/github/issues", get(github_issues))
        .route("/api/github/issue", get(github_issue))
        .route("/api/github/pulls", get(github_pulls))
        .route("/api/github/pull", get(github_pull))
        .route("/api/github/pull-files", get(github_pull_files))
        .route("/api/github/pull-file", get(github_pull_file))
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
        .route("/service-worker.js", get(service_worker))
        .route("/assets/manifest.webmanifest", get(manifest))
        .route("/assets/{*path}", get(asset))
        .route("/settings", get(index))
        .route("/tasks", get(index))
        .route("/tasks/{*path}", get(index))
        .route("/files", get(index))
        .route("/git", get(index))
        .route("/git/{*path}", get(index))
        .route("/github", get(index))
        .route("/github/{*path}", get(index))
        .with_state(state)
}

fn default_data_dir() -> anyhow::Result<PathBuf> {
    Ok(RootedFs::home_dir()?.join(".caffold"))
}

fn default_diff_kind() -> String {
    "unstaged".to_string()
}

fn default_git_log_page() -> usize {
    1
}

fn default_git_log_per_page() -> usize {
    50
}

fn default_github_issue_state() -> String {
    "open".to_string()
}

fn default_github_issues_page() -> usize {
    1
}

fn default_github_issues_per_page() -> usize {
    50
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

async fn index(State(state): State<AppState>) -> Response {
    let name = state.server_settings.get().name;
    let body = render_index(&name);
    let mut response = Html(body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn manifest(State(state): State<AppState>) -> Result<Response, ApiError> {
    let name = state.server_settings.get().name;
    let body = render_manifest(&name)?;
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/manifest+json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(response)
}

fn render_index(name: &str) -> String {
    static_assets::INDEX.replace("{{CAFFOLD_SERVER_NAME}}", &escape_html(name))
}

fn render_manifest(name: &str) -> Result<Vec<u8>, ApiError> {
    let asset = static_assets::get("manifest.webmanifest")
        .ok_or_else(|| ApiError::Internal("PWA manifest asset is unavailable".to_string()))?;
    let mut manifest: JsonValue = serde_json::from_slice(asset.body)
        .map_err(|error| ApiError::Internal(format!("PWA manifest is invalid: {error}")))?;
    manifest["name"] = JsonValue::String(name.to_string());
    manifest["short_name"] = JsonValue::String(name.to_string());
    serde_json::to_vec_pretty(&manifest)
        .map_err(|error| ApiError::Internal(format!("PWA manifest failed to encode: {error}")))
}

async fn service_worker() -> Response {
    match static_assets::get("service-worker.js") {
        Some(asset) => {
            let mut response = Response::new(Body::from(asset.body));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            response.headers_mut().insert(
                HeaderName::from_static("service-worker-allowed"),
                HeaderValue::from_static("/"),
            );
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn asset(AxumPath(path): AxumPath<String>) -> Response {
    match static_assets::get(&path) {
        Some(asset) => {
            let mut response = Response::new(Body::from(asset.body));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            );
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        build_id: env!("CAFFOLD_BUILD_ID"),
        build_label: env!("CAFFOLD_BUILD_LABEL"),
        build_number: env!("CAFFOLD_BUILD_NUMBER"),
        server_name: state.server_settings.get().name,
        root: state.fs.root().display().to_string(),
        initial_path: state.initial_path,
        home_path: state.home_path,
        max_file_bytes: MAX_FILE_BYTES,
    })
}

async fn get_server_settings(State(state): State<AppState>) -> Json<ServerSettings> {
    Json(state.server_settings.get())
}

async fn update_server_settings(
    State(state): State<AppState>,
    Json(request): Json<UpdateServerSettingsRequest>,
) -> Result<Json<ServerSettings>, ApiError> {
    state
        .server_settings
        .update_name(&request.name)
        .map(Json)
        .map_err(server_settings_error)
}

fn server_settings_error(error: ServerSettingsError) -> ApiError {
    match error {
        ServerSettingsError::EmptyName | ServerSettingsError::NameTooLong => ApiError::BadRequest {
            code: "invalid_server_name",
            message: error.to_string(),
        },
        ServerSettingsError::Read(_)
        | ServerSettingsError::Parse(_)
        | ServerSettingsError::Write(_)
        | ServerSettingsError::Encode(_) => ApiError::Internal(error.to_string()),
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

async fn list(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<ListResponse>, ApiError> {
    let fs = state.fs.clone();
    let requested_path = query.path;
    let timeout_path = requested_path.clone();
    let list = tokio::task::spawn_blocking(move || fs.list(&requested_path));

    match tokio::time::timeout(LIST_DIRECTORY_TIMEOUT, list).await {
        Ok(Ok(Ok(response))) => Ok(Json(response)),
        Ok(Ok(Err(error))) => Err(ApiError::from(error)),
        Ok(Err(error)) => Err(ApiError::Internal(format!(
            "directory listing task failed: {error}"
        ))),
        Err(_) => Err(ApiError::Timeout {
            code: "directory_list_timeout",
            message: format!("directory listing timed out: {timeout_path}"),
        }),
    }
}

async fn file(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<FileResponse>, ApiError> {
    state
        .fs
        .read_file(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn image(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let image = state.fs.read_image(&query.path)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(image.content_type),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    Ok((headers, image.bytes).into_response())
}

async fn task_image(
    State(state): State<AppState>,
    Query(query): Query<TaskImageQuery>,
) -> Result<Response, ApiError> {
    let logical_path = task_image_logical_path(&state.fs, Path::new(&query.path))?;
    let image = state.fs.read_image(&logical_path)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(image.content_type),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    Ok((headers, image.bytes).into_response())
}

fn task_image_logical_path(fs: &RootedFs, path: &Path) -> Result<String, FsError> {
    fs.logical_path_for_absolute(path)
}

async fn watch_stream(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let subscription = state.watch_hub.subscribe(&query.path)?;
    let shutdown = state.shutdown.subscribe();
    let heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(15),
        Duration::from_secs(15),
    );
    let stream = stream::unfold(
        (false, false, subscription, shutdown, heartbeat, 1_u64),
        |(ready_sent, terminate, mut subscription, mut shutdown, mut heartbeat, mut revision)| async move {
            if terminate {
                return None;
            }
            if !ready_sent {
                revision = subscription.ready.revision;
                let payload =
                    serde_json::to_string(&subscription.ready).unwrap_or_else(|_| "{}".to_string());
                let frame = format!("event: ready\ndata: {payload}\n\n");
                return Some((
                    Ok::<_, Infallible>(Bytes::from(frame)),
                    (true, false, subscription, shutdown, heartbeat, revision),
                ));
            }

            tokio::select! {
                    _ = shutdown.recv() => None,
                    _ = heartbeat.tick() => {
                        Some((
                            Ok::<_, Infallible>(Bytes::from_static(b": heartbeat\n\n")),
                            (true, false, subscription, shutdown, heartbeat, revision),
                        ))
                    }
                    message = subscription.recv() => match message {
                        Ok(WatchMessage::Change(change)) => {
                            revision = change.revision;
                            let payload = serde_json::to_string(&change)
                                .unwrap_or_else(|_| "{}".to_string());
                            let frame = format!("event: change\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, false, subscription, shutdown, heartbeat, revision),
                            ))
                        }
                        Ok(WatchMessage::Error(message)) => {
                            let payload = json!({ "message": message }).to_string();
                            let frame = format!("event: watch-error\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, true, subscription, shutdown, heartbeat, revision),
                            ))
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            revision = revision.saturating_add(1);
                            let repository = subscription.ready.repository_root_path.is_some();
                            let change = WatchChange {
                                revision,
                                paths: Vec::new(),
                                git_status_changed: repository,
                                git_refs_changed: repository,
                                overflow: true,
                            };
                            let payload = serde_json::to_string(&change)
                                .unwrap_or_else(|_| "{}".to_string());
                            let frame = format!("event: change\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, false, subscription, shutdown, heartbeat, revision),
                            ))
                        }
                        Err(broadcast::error::RecvError::Closed) => None,
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

async fn git_status(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    state
        .fs
        .git_status(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_diff(
    State(state): State<AppState>,
    Query(query): Query<GitDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    state
        .fs
        .git_diff(&query.path, &query.file, &query.kind)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_log(
    State(state): State<AppState>,
    Query(query): Query<GitLogQuery>,
) -> Result<Json<GitLogResponse>, ApiError> {
    let per_page = query
        .per_page
        .or(query.limit)
        .unwrap_or_else(default_git_log_per_page);
    state
        .fs
        .git_log(&query.path, query.page, per_page)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_commit(
    State(state): State<AppState>,
    Query(query): Query<GitCommitQuery>,
) -> Result<Json<GitCommitResponse>, ApiError> {
    state
        .fs
        .git_commit(&query.path, &query.sha)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_commit_diff(
    State(state): State<AppState>,
    Query(query): Query<GitCommitDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    state
        .fs
        .git_commit_diff(&query.path, &query.sha, &query.file)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_compare(
    State(state): State<AppState>,
    Query(query): Query<GitCompareQuery>,
) -> Result<Json<GitCompareResponse>, ApiError> {
    state
        .fs
        .git_compare(&query.path, query.base.as_deref(), query.head.as_deref())
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_compare_diff(
    State(state): State<AppState>,
    Query(query): Query<GitCompareDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    state
        .fs
        .git_compare_diff(
            &query.path,
            query.base.as_deref(),
            query.head.as_deref(),
            &query.file,
        )
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_refs(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GitRefsResponse>, ApiError> {
    state
        .fs
        .git_refs(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_status(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GithubStatusResponse>, ApiError> {
    state
        .fs
        .github_status(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_issues(
    State(state): State<AppState>,
    Query(query): Query<GithubIssuesQuery>,
) -> Result<Json<GithubIssuesResponse>, ApiError> {
    let per_page = query
        .per_page
        .or(query.limit)
        .unwrap_or_else(default_github_issues_per_page);
    state
        .fs
        .github_issues(&query.path, &query.state, query.page, per_page)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_issue(
    State(state): State<AppState>,
    Query(query): Query<GithubIssueQuery>,
) -> Result<Json<GithubIssueResponse>, ApiError> {
    state
        .fs
        .github_issue(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pulls(
    State(state): State<AppState>,
    Query(query): Query<GithubPullsQuery>,
) -> Result<Json<GithubPullsResponse>, ApiError> {
    let per_page = query
        .per_page
        .or(query.limit)
        .unwrap_or_else(default_github_issues_per_page);
    state
        .fs
        .github_pulls(&query.path, &query.state, query.page, per_page)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pull(
    State(state): State<AppState>,
    Query(query): Query<GithubPullQuery>,
) -> Result<Json<GithubPullResponse>, ApiError> {
    state
        .fs
        .github_pull(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pull_files(
    State(state): State<AppState>,
    Query(query): Query<GithubPullQuery>,
) -> Result<Json<GithubPullFilesResponse>, ApiError> {
    state
        .fs
        .github_pull_files(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pull_file(
    State(state): State<AppState>,
    Query(query): Query<GithubPullFileQuery>,
) -> Result<Json<GithubPullFileResponse>, ApiError> {
    state
        .fs
        .github_pull_file(&query.path, query.number, &query.file)
        .map(Json)
        .map_err(ApiError::from)
}

async fn codex_status(State(state): State<AppState>) -> Json<CodexStatusPayload> {
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

async fn codex_models(State(state): State<AppState>) -> Result<Json<JsonValue>, ApiError> {
    let client = require_codex_thread_client(&state).await?;
    let response = client.list_models(100).await.map_err(ApiError::from)?;
    codex_models_payload(response).map(Json)
}

async fn codex_permissions(
    State(state): State<AppState>,
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
    State(state): State<AppState>,
    Query(query): Query<TasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let (stored, next_cursor) =
        thread_store_list(&state, query.cursor.as_deref(), TASK_LIST_PAGE_SIZE).await?;
    let pending_thread_ids = state
        .pending_approvals
        .lock()
        .await
        .values()
        .map(|pending| pending.thread_id.clone())
        .collect::<HashSet<_>>();
    let mut cwds = stored
        .iter()
        .map(|thread| thread.cwd.clone())
        .collect::<Vec<_>>();
    cwds.sort();
    cwds.dedup();
    let fs = state.fs.clone();
    let resolved_cwds = resolve_task_cwds_with(cwds, move |cwd| {
        let fs = fs.clone();
        async move {
            let resolved = resolve_task_cwd(&fs, &cwd);
            (cwd, resolved)
        }
    })
    .await;
    let tasks = stored
        .into_iter()
        .map(|thread| {
            let resolved_cwd = resolved_cwds.get(&thread.cwd).and_then(Option::as_ref);
            let mut task = task_record_from_stored(thread, resolved_cwd);
            let has_pending_approval = pending_thread_ids.contains(&task.thread_id);
            apply_current_approval_status(&mut task, has_pending_approval);
            task
        })
        .collect();
    Ok(Json(TaskListResponse { tasks, next_cursor }))
}

async fn list_task_history(
    State(state): State<AppState>,
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
    state: State<AppState>,
    query: Query<TasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let app_state = state.0.clone();
    let response = list_task_history(state, query).await?;
    for task in &response.0.tasks {
        thread_store_claim(&app_state, stored_thread_from_task_record(task)).await?;
    }
    Ok(response)
}

async fn thread_store_list(
    state: &AppState,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(Vec<StoredThread>, Option<String>), ApiError> {
    let store = state.thread_store.clone();
    let cursor = cursor.map(ToOwned::to_owned);
    tokio::task::spawn_blocking(move || store.list(cursor.as_deref(), limit))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn thread_store_get(
    state: &AppState,
    thread_id: &str,
) -> Result<Option<StoredThread>, ApiError> {
    let store = state.thread_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.get(&thread_id))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn thread_store_claim(
    state: &AppState,
    thread: StoredThread,
) -> Result<StoredThread, ApiError> {
    let store = state.thread_store.clone();
    tokio::task::spawn_blocking(move || store.claim(thread, now_ms()))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn thread_store_mark_seen(
    state: &AppState,
    thread_id: &str,
) -> Result<Option<StoredThread>, ApiError> {
    let store = state.thread_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.mark_seen(&thread_id, now_ms()))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn thread_store_update_composer_settings(
    state: &AppState,
    thread_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<Option<StoredThread>, ApiError> {
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

async fn thread_store_update_projection(
    state: &AppState,
    task: &TaskRecord,
) -> Result<Option<StoredThread>, ApiError> {
    let store = state.thread_store.clone();
    let projection = stored_thread_from_task_record(task);
    tokio::task::spawn_blocking(move || store.update_projection(&projection))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn thread_store_delete(state: &AppState, thread_id: &str) -> Result<bool, ApiError> {
    let store = state.thread_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.delete(&thread_id))
        .await
        .map_err(thread_store_join_error)?
        .map_err(thread_store_api_error)
}

async fn filter_and_refresh_managed_history(
    state: &AppState,
    tasks: Vec<TaskRecord>,
) -> Result<Vec<TaskRecord>, ApiError> {
    let store = state.thread_store.clone();
    let projections = tasks
        .iter()
        .map(stored_thread_from_task_record)
        .collect::<Vec<_>>();
    let managed = tokio::task::spawn_blocking(move || {
        let mut managed = HashSet::new();
        for projection in projections {
            let thread_id = projection.thread_id.clone();
            if store.update_projection(&projection)?.is_some() {
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
    State(state): State<AppState>,
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
    let stored = thread_store_claim(&state, stored_thread_from_task_record(&task)).await?;
    notify_task_updated(
        &state,
        task_record_from_stored(stored, resolve_task_cwd(&state.fs, &cwd).as_ref()),
    );
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
    State(state): State<AppState>,
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

    if let Some(stored) = thread_store_mark_seen(&state, &thread_id).await? {
        let resolved = resolve_task_cwd(&state.fs, &stored.cwd);
        notify_task_updated(&state, task_record_from_stored(stored, resolved.as_ref()));
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
    State(state): State<AppState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    let client = require_codex_thread_client(&state).await?;
    let thread = client.read_thread(&thread_id).await?;
    let task = task_record_from_codex_thread(&state, &thread)?;
    let stored = thread_store_claim(&state, stored_thread_from_task_record(&task)).await?;
    let resolved = resolve_task_cwd(&state.fs, &stored.cwd);
    let task = task_record_from_stored(stored, resolved.as_ref());
    notify_task_updated(&state, task.clone());
    Ok(Json(task))
}

async fn mark_task_seen(
    State(state): State<AppState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    let Some(stored) = thread_store_mark_seen(&state, &thread_id).await? else {
        return Err(task_not_managed_error());
    };
    let resolved = resolve_task_cwd(&state.fs, &stored.cwd);
    let task = task_record_from_stored(stored, resolved.as_ref());
    notify_task_updated(&state, task.clone());
    Ok(Json(task))
}

async fn unmanaged_task_detail(
    state: &AppState,
    thread_id: &str,
) -> Result<TaskDetailResponse, ApiError> {
    let client = require_codex_thread_client(state).await?;
    let thread = client.read_thread(thread_id).await?;
    let task = task_record_from_codex_thread(state, &thread)?;
    Ok(TaskDetailResponse {
        managed: false,
        revision: 0,
        task,
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
    state: &AppState,
    thread: &crate::codex_app_server::CodexThread,
) -> Result<TaskRecord, ApiError> {
    let thread = thread.clone().into_value();
    let resolved = resolve_thread_cwd(&state.fs, &thread);
    task_record_from_thread(&thread, &[], resolved.as_ref(), false)
}

fn task_not_managed_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_not_managed",
        message: "thread must be continued in Caffold first".to_string(),
    }
}

fn notify_task_updated(state: &AppState, task: TaskRecord) {
    let _ = state.task_list_updates.send(task);
}

async fn ensure_task_sync_worker(state: &AppState) {
    let Some(receiver) = state.task_sync.take_receiver().await else {
        return;
    };
    let state = state.clone();
    tokio::spawn(run_task_sync_worker(state, receiver));
}

async fn run_task_sync_worker(
    state: AppState,
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
            });
        }
    }
}

async fn handle_task_sync_request(
    state: &AppState,
    pending: &mut HashMap<String, PendingTaskSync>,
    request: TaskSyncRequest,
) {
    match request {
        TaskSyncRequest::Rollout(thread_id, signal) => {
            let snapshot = match &signal {
                TaskRolloutSignal::ExternalStarted {
                    turn_id,
                    started_at_ms,
                } => Some(
                    state
                        .codex_sessions
                        .record_external_activity_started(&thread_id, turn_id, *started_at_ms)
                        .await,
                ),
                TaskRolloutSignal::ExternalFinished { turn_id, .. } => Some(
                    state
                        .codex_sessions
                        .record_external_activity_finished(&thread_id, turn_id)
                        .await,
                ),
                TaskRolloutSignal::Invalidated => None,
            };
            if let Some(snapshot) = snapshot {
                broadcast_task_snapshot(state, &thread_id, snapshot, "rollout-activity").await;
            }
            schedule_task_sync(pending, thread_id, tokio::time::Instant::now());
        }
        TaskSyncRequest::Unsubscribe(thread_id) => {
            pending.remove(&thread_id);
        }
    }
}

async fn broadcast_task_snapshot(
    state: &AppState,
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
    State(state): State<AppState>,
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

async fn task_list_stream(State(state): State<AppState>) -> Result<Response, ApiError> {
    Ok(task_event_stream(state, None))
}

fn task_event_stream(state: AppState, thread_id: Option<String>) -> Response {
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
    State(state): State<AppState>,
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
    let target = match state
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
                requested_model,
                requested_effort,
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
    let outcome = match result {
        Ok(result) => result,
        Err(error) => {
            state.codex_sessions.cancel_runtime(&thread_id).await;
            recover_codex_connection_error(&state, &connection, &error).await;
            return Err(error.into());
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
    State(state): State<AppState>,
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
    state: &AppState,
    connection: &CodexThreadConnection,
    error: &CodexThreadError,
) {
    if !error.is_connection_failure() {
        return;
    }
    state
        .codex_sessions
        .connection_lost(connection.generation, error.to_string())
        .await;
    state
        .codex_threads
        .invalidate_after_error(connection.generation, error)
        .await;
}

async fn task_archive(
    State(state): State<AppState>,
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

fn notify_task_removed(state: &AppState, thread_id: &str, reason: &'static str) {
    let _ = state.task_list_removals.send(TaskListRemoval {
        thread_id: thread_id.to_string(),
        reason,
    });
}

async fn task_approval(
    State(state): State<AppState>,
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

async fn require_codex_thread_client(state: &AppState) -> Result<CodexThreadClient, ApiError> {
    require_codex_thread_connection(state)
        .await
        .map(|connection| connection.client)
        .map_err(ApiError::from)
}

async fn require_codex_thread_connection(
    state: &AppState,
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
                        runtime: state.codex_threads.clone(),
                        sessions: state.codex_sessions.clone(),
                        task_events: state.task_events.clone(),
                        live_task_events: state.live_task_events.clone(),
                        pending_approvals: state.pending_approvals.clone(),
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
    state: &AppState,
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
    state: &AppState,
    thread_id: &str,
) -> Result<(TaskDetailResponse, u64), ApiError> {
    let stored = thread_store_get(state, thread_id).await?;
    let Some(snapshot) = state.codex_sessions.snapshot(thread_id).await else {
        return Ok((loading_task_detail(thread_id, 0, stored.as_ref()), 0));
    };
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
    stored: Option<&StoredThread>,
) -> TaskDetailResponse {
    TaskDetailResponse {
        managed: true,
        revision,
        task: TaskRecord {
            id: thread_id.to_string(),
            thread_id: thread_id.to_string(),
            title: "Loading task...".to_string(),
            preview: String::new(),
            status: "loading".to_string(),
            cwd: String::new(),
            cwd_path: None,
            relative_cwd: String::new(),
            worktree: None,
            created_ms: 0,
            updated_ms: 0,
            recency_ms: None,
            active_turn_id: None,
            active_turn_started_ms: None,
            last_event_summary: None,
            unseen: false,
        },
        events: Vec::new(),
        events_page: TaskEventsPage { next_cursor: None },
        pending_approvals: Vec::new(),
        history_loading: true,
        permission_mode: None,
        model: stored.and_then(|thread| thread.model.clone()),
        reasoning_effort: stored.and_then(|thread| thread.reasoning_effort.clone()),
    }
}

async fn bootstrap_task_session(state: &AppState, thread_id: &str, baseline_revision: u64) {
    let Ok(connection) = require_codex_thread_connection(state).await else {
        return;
    };
    let Ok(snapshot) = state
        .codex_sessions
        .ensure_subscribed(&connection.client, connection.generation, thread_id)
        .await
    else {
        return;
    };
    if snapshot.revision <= baseline_revision {
        return;
    }
    broadcast_task_snapshot(state, thread_id, snapshot, "session-bootstrap").await;
}

async fn task_detail_from_snapshot(
    state: &AppState,
    snapshot: ThreadSessionSnapshot,
    response_page: Option<crate::codex_app_server::TurnsPage>,
) -> Result<TaskDetailResponse, ApiError> {
    let session_running = snapshot.is_running();
    let actively_viewed = snapshot.viewer_leases > 0;
    let revision = snapshot.revision;
    let permission_mode = snapshot.permission_mode;
    let session_model = snapshot.model.clone();
    let session_reasoning_effort = snapshot.reasoning_effort.clone();
    let session_active_turn_id = snapshot
        .active_turn_id
        .clone()
        .or_else(|| snapshot.external_activity_turn_id.clone());
    let external_activity_started_ms = snapshot.external_activity_started_ms;
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
    let mut task = task_record_from_thread(
        &thread,
        &events,
        resolved_cwd.as_ref(),
        !pending_approvals.is_empty(),
    )?;
    apply_session_activity(
        &mut task,
        session_running,
        session_active_turn_id,
        external_activity_started_ms,
    );
    let mut stored = thread_store_update_projection(state, &task).await?;
    if session_model.is_some() || session_reasoning_effort.is_some() {
        stored = thread_store_update_composer_settings(
            state,
            &thread_id,
            session_model.as_deref(),
            session_reasoning_effort.as_deref(),
        )
        .await?
        .or(stored);
    }
    if let Some(mut current) = stored {
        if actively_viewed
            && let Some(seen) = thread_store_mark_seen(state, &current.thread_id).await?
        {
            current = seen;
        }
        task.unseen = current.unseen();
        let model = session_model.or(current.model);
        let reasoning_effort = session_reasoning_effort.or(current.reasoning_effort);
        return Ok(TaskDetailResponse {
            managed: true,
            revision,
            task,
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
        managed: true,
        revision,
        task,
        events,
        events_page: TaskEventsPage { next_cursor },
        pending_approvals,
        history_loading,
        permission_mode,
        model: session_model,
        reasoning_effort: session_reasoning_effort,
    })
}

fn apply_session_activity(
    task: &mut TaskRecord,
    session_running: bool,
    session_active_turn_id: Option<String>,
    external_activity_started_ms: Option<u64>,
) {
    if session_running && task.status != "waiting_for_approval" {
        task.status = "running".to_string();
        task.active_turn_id = task.active_turn_id.take().or(session_active_turn_id);
        task.active_turn_started_ms = task.active_turn_started_ms.or(external_activity_started_ms);
    }
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
            task_record_from_thread(thread, &[], resolved_cwd, false).ok()
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
    has_pending_approval: bool,
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
    let active_turn_id = active_turn_id(thread);
    let active_turn_started_ms = active_turn_id
        .as_deref()
        .and_then(|turn_id| turn_started_ms(thread, turn_id));
    let status = if active_turn_id.is_some() {
        "running".to_string()
    } else {
        thread_status(thread)
    };
    let last_event_summary = events
        .last()
        .map(|event| event.summary.clone())
        .or_else(|| non_empty_string(Some(&preview)));
    let mut task = TaskRecord {
        id: thread_id.to_string(),
        thread_id: thread_id.to_string(),
        title,
        preview,
        status,
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
        active_turn_id,
        active_turn_started_ms,
        last_event_summary,
        unseen: false,
    };
    apply_current_approval_status(&mut task, has_pending_approval);
    Ok(task)
}

fn apply_current_approval_status(task: &mut TaskRecord, has_pending_approval: bool) {
    if has_pending_approval {
        task.status = "waiting_for_approval".to_string();
    } else if task.status == "waiting_for_approval" {
        task.status = if task.active_turn_id.is_some() {
            "running".to_string()
        } else {
            "idle".to_string()
        };
    }
}

fn stored_thread_from_task_record(task: &TaskRecord) -> StoredThread {
    StoredThread {
        thread_id: task.thread_id.clone(),
        title: task.title.clone(),
        preview: task.preview.clone(),
        cwd: task.cwd.clone(),
        created_ms: task.created_ms,
        updated_ms: task.updated_ms,
        recency_ms: task.recency_ms,
        status: task.status.clone(),
        active_turn_id: task.active_turn_id.clone(),
        active_turn_started_ms: task.active_turn_started_ms,
        last_event_summary: task.last_event_summary.clone(),
        claimed_at_ms: 0,
        last_opened_at_ms: None,
        last_seen_activity_ms: None,
        model: None,
        reasoning_effort: None,
    }
}

fn task_record_from_stored(
    thread: StoredThread,
    resolved_cwd: Option<&ResolvedTaskCwd>,
) -> TaskRecord {
    let cwd = thread.cwd.clone();
    let unseen = thread.unseen();
    TaskRecord {
        id: thread.thread_id.clone(),
        thread_id: thread.thread_id,
        title: thread.title,
        preview: thread.preview,
        status: thread.status,
        cwd_path: resolved_cwd.and_then(|resolved| resolved.logical_cwd.clone()),
        relative_cwd: resolved_cwd
            .and_then(|resolved| resolved.logical_cwd.clone())
            .unwrap_or_else(|| cwd.clone()),
        worktree: resolved_cwd.and_then(|resolved| resolved.worktree.clone()),
        cwd,
        created_ms: thread.created_ms,
        updated_ms: thread.updated_ms,
        recency_ms: thread.recency_ms,
        active_turn_id: thread.active_turn_id,
        active_turn_started_ms: thread.active_turn_started_ms,
        last_event_summary: thread.last_event_summary,
        unseen,
    }
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
    let created_ms = seconds_to_ms(thread.get("createdAt").and_then(JsonValue::as_f64));
    for turn in thread
        .get("turns")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
    {
        let turn_id = turn.get("id").and_then(JsonValue::as_str).unwrap_or("turn");
        let started_ms = turn
            .get("startedAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value)
            .unwrap_or(created_ms);
        let mut started = task_event_record(
            thread_id,
            &format!("{turn_id}:started"),
            "turn_started",
            "Turn started",
            Some(json!({ "threadId": thread_id, "turnId": turn_id })),
            started_ms,
        );
        started.sort_index = Some(0);
        events.push(started);
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
            if let Some(mut event) = task_event_from_thread_item(thread_id, started_ms, &params) {
                event.sort_index = Some(u32::try_from(index).unwrap_or(u32::MAX).saturating_add(1));
                events.push(event);
            }
        }
        if let Some(completed_ms) = turn
            .get("completedAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value)
        {
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
                completed_ms,
            ));
        }
    }
    events
}

async fn pending_approval_events(state: &AppState, thread_id: &str) -> Vec<TaskEventRecord> {
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
    runtime: Arc<CodexThreadRuntime>,
    sessions: CodexThreadSessions,
    task_events: broadcast::Sender<TaskEventRecord>,
    live_task_events: LiveTaskEventCache,
    pending_approvals: Arc<AsyncMutex<HashMap<String, PendingApproval>>>,
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
                            context
                                .sessions
                                .apply_notification(generation, &notification)
                                .await;
                            expire_stale_approvals_for_notification(
                                &context.task_events,
                                &context.live_task_events,
                                &context.pending_approvals,
                                &notification,
                            )
                            .await;
                            handle_codex_notification(
                                &context.task_events,
                                &context.live_task_events,
                                notification,
                            );
                        }
                        CodexRuntimeEvent::ServerRequest(request) => {
                            handle_codex_server_request(
                                &context.task_events,
                                &context.live_task_events,
                                &context.pending_approvals,
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
        context
            .sessions
            .connection_lost(generation, connection_error)
            .await;
        context.runtime.invalidate(generation).await;
    });
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

fn thread_status(thread: &JsonValue) -> String {
    normalized_thread_status(thread.get("status"))
}

fn normalized_thread_status(status: Option<&JsonValue>) -> String {
    match status
        .and_then(|status| status.get("type"))
        .and_then(JsonValue::as_str)
    {
        Some("active") => "running",
        Some("systemError") => "failed",
        Some("idle") => "idle",
        Some(status) => status,
        None => "unknown",
    }
    .to_string()
}

fn active_turn_id(thread: &JsonValue) -> Option<String> {
    thread
        .get("turns")
        .and_then(JsonValue::as_array)?
        .last()
        .filter(|turn| {
            turn.get("status")
                .and_then(JsonValue::as_str)
                .is_some_and(|status| status == "inProgress")
        })
        .and_then(|turn| turn.get("id").and_then(JsonValue::as_str))
        .map(ToOwned::to_owned)
}

fn turn_started_ms(thread: &JsonValue, turn_id: &str) -> Option<u64> {
    thread
        .get("turns")
        .and_then(JsonValue::as_array)?
        .iter()
        .find(|turn| turn.get("id").and_then(JsonValue::as_str) == Some(turn_id))?
        .get("startedAt")
        .and_then(JsonValue::as_f64)
        .map(seconds_to_ms_value)
        .filter(|value| *value > 0)
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

fn task_cwd(state: &AppState, relative: Option<&str>) -> Result<String, ApiError> {
    let logical_path = normalize_logical_path(relative.unwrap_or(&state.initial_path))?;
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

#[derive(Debug)]
enum ApiError {
    Fs(FsError),
    CodexThread(String),
    Watch(String),
    Internal(String),
    Timeout { code: &'static str, message: String },
    BadRequest { code: &'static str, message: String },
}

impl From<FsError> for ApiError {
    fn from(error: FsError) -> Self {
        Self::Fs(error)
    }
}

impl From<codex_app_server::CodexThreadError> for ApiError {
    fn from(error: codex_app_server::CodexThreadError) -> Self {
        match error {
            codex_app_server::CodexThreadError::RequestTimeout { .. } => Self::Timeout {
                code: "codex_app_server_timeout",
                message: error.to_string(),
            },
            error => Self::CodexThread(error.to_string()),
        }
    }
}

impl From<WatchError> for ApiError {
    fn from(error: WatchError) -> Self {
        match error {
            WatchError::Fs(error) => Self::Fs(error),
            WatchError::Unavailable(message) => Self::Watch(message),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            ApiError::Fs(FsError::RootUnavailable { path, .. }) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "root_unavailable",
                format!("root path is not accessible: {}", path.display()),
            ),
            ApiError::Fs(FsError::RootNotDirectory { path }) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "root_not_directory",
                format!("root path is not a directory: {}", path.display()),
            ),
            ApiError::Fs(FsError::PathEscapesRoot) => (
                StatusCode::BAD_REQUEST,
                "path_escapes_root",
                "path escapes the browsing root".to_string(),
            ),
            ApiError::Fs(FsError::NotFound { path }) => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("path was not found: {path}"),
            ),
            ApiError::Fs(FsError::NotDirectory { path }) => (
                StatusCode::BAD_REQUEST,
                "not_directory",
                format!("path is not a directory: {path}"),
            ),
            ApiError::Fs(FsError::IsDirectory { path }) => (
                StatusCode::BAD_REQUEST,
                "is_directory",
                format!("path is a directory, not a file: {path}"),
            ),
            ApiError::Fs(FsError::NotFile { path }) => (
                StatusCode::BAD_REQUEST,
                "not_file",
                format!("path is not a regular file: {path}"),
            ),
            ApiError::Fs(FsError::FileTooLarge { path, size, limit }) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "file_too_large",
                format!("file is too large: {path} ({size} bytes, limit {limit} bytes)"),
            ),
            ApiError::Fs(FsError::BinaryFile { path }) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "binary_file",
                format!("binary-looking files are not supported: {path}"),
            ),
            ApiError::Fs(FsError::InvalidUtf8 { path }) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_utf8",
                format!("invalid UTF-8 files are not supported: {path}"),
            ),
            ApiError::Fs(FsError::UnsupportedImage { path }) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_image",
                format!("image preview is not supported for this file type: {path}"),
            ),
            ApiError::Fs(FsError::GitRepositoryNotFound { path }) => (
                StatusCode::BAD_REQUEST,
                "git_repository_not_found",
                format!("path is not inside a Git repository: {path}"),
            ),
            ApiError::Fs(FsError::GitCommandFailed { action, path }) => (
                StatusCode::BAD_REQUEST,
                "git_command_failed",
                format!("git command failed while trying to {action}: {path}"),
            ),
            ApiError::Fs(FsError::GithubRepositoryNotFound { path }) => (
                StatusCode::BAD_REQUEST,
                "github_repository_not_found",
                format!("path is not inside a GitHub repository: {path}"),
            ),
            ApiError::Fs(FsError::GithubUnavailable { action, path }) => (
                StatusCode::BAD_REQUEST,
                "github_unavailable",
                format!("GitHub is unavailable while trying to {action}: {path}"),
            ),
            ApiError::Fs(FsError::GithubCommandFailed { action, path }) => (
                StatusCode::BAD_REQUEST,
                "github_command_failed",
                format!("GitHub CLI command failed while trying to {action}: {path}"),
            ),
            ApiError::Fs(FsError::Io { action, path, .. }) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "filesystem_error",
                format!("filesystem error while trying to {action}: {path}"),
            ),
            ApiError::CodexThread(message) => {
                (StatusCode::BAD_GATEWAY, "codex_app_server_error", message)
            }
            ApiError::Watch(message) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "watch_unavailable",
                message,
            ),
            ApiError::Internal(message) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
            }
            ApiError::Timeout { code, message } => (StatusCode::GATEWAY_TIMEOUT, code, message),
            ApiError::BadRequest { code, message } => (StatusCode::BAD_REQUEST, code, message),
        };

        (
            status,
            Json(ErrorResponse {
                error: ErrorBody { code, message },
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_thread_sessions::ThreadSessionLifecycle;

    #[test]
    fn app_server_timeout_preserves_rpc_context_in_api_error() {
        let error = ApiError::from(codex_app_server::CodexThreadError::RequestTimeout {
            method: "thread/resume",
            request_id: 42,
            timeout_ms: 120_000,
        });

        match error {
            ApiError::Timeout { code, message } => {
                assert_eq!(code, "codex_app_server_timeout");
                assert!(message.contains("thread/resume"));
                assert!(message.contains("request 42"));
                assert!(message.contains("120000ms"));
            }
            error => panic!("expected timeout API error, got {error:?}"),
        }
    }

    #[tokio::test]
    async fn codex_models_adds_backend_owned_reasoning_labels() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
            "model/list",
            json!({
                "data": [{
                    "id": "gpt-5.6-sol",
                    "model": "gpt-5.6-sol",
                    "displayName": "GPT-5.6-Sol",
                    "description": "Latest frontier agentic coding model.",
                    "hidden": false,
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Fast responses" },
                        { "reasoningEffort": "xhigh", "description": "Extra depth" },
                        { "reasoningEffort": "max", "description": "Maximum depth" },
                        { "reasoningEffort": "ultra", "description": "Automatic delegation" }
                    ],
                    "defaultReasoningEffort": "low",
                    "inputModalities": ["text", "image"],
                    "supportsPersonality": false,
                    "isDefault": true
                }],
                "nextCursor": null
            }),
        )]);
        let state = app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;

        let Json(response) = codex_models(State(state)).await.unwrap();
        let efforts = response["data"][0]["supportedReasoningEfforts"]
            .as_array()
            .unwrap();

        assert_eq!(efforts[0]["value"], "low");
        assert_eq!(efforts[0]["label"], "Light");
        assert_eq!(efforts[1]["value"], "xhigh");
        assert_eq!(efforts[1]["label"], "Extra High");
        assert_eq!(efforts[2]["label"], "Max");
        assert_eq!(efforts[3]["label"], "Ultra");
    }

    #[tokio::test]
    async fn codex_permissions_use_app_server_profiles_and_effective_defaults() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "permissionProfile/list",
                json!({
                    "data": [
                        {
                            "id": ":workspace",
                            "description": "Workspace access",
                            "allowed": true
                        },
                        {
                            "id": ":danger-full-access",
                            "description": "Full access",
                            "allowed": false
                        }
                    ],
                    "nextCursor": null
                }),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "config/read",
                json!({
                    "config": {
                        "approval_policy": "on-request",
                        "approvals_reviewer": "auto_review",
                        "sandbox_mode": "workspace-write"
                    },
                    "origins": {},
                    "layers": null
                }),
            ),
        ]);
        let state = app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;

        let Json(response) =
            codex_permissions(State(state), Query(CodexPermissionsQuery { cwd: None }))
                .await
                .unwrap();

        assert_eq!(response.default_mode, CodexPermissionMode::ApproveForMe);
        assert!(response.options[0].allowed);
        assert!(response.options[1].allowed);
        assert!(!response.options[2].allowed);
        assert!(response.options[2].dangerous);
    }

    #[tokio::test]
    async fn create_task_keeps_explicit_permission_mode_for_the_first_turn() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-explicit-permission";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/start",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "Explicit permission regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 1.0,
                        "turns": []
                    },
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "user",
                    "activePermissionProfile": {
                        "id": ":workspace"
                    }
                }),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "turn/start",
                json!({
                    "turn": {
                        "id": "turn-explicit-permission",
                        "items": [],
                        "status": "inProgress"
                    }
                }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = create_task(
            State(state),
            Json(CreateTaskRequest {
                prompt: "Use the selected approval mode".to_string(),
                images: Vec::new(),
                cwd: None,
                model: None,
                effort: None,
                permission_mode: Some(CodexPermissionMode::ApproveForMe),
            }),
        )
        .await
        .expect("task creation succeeds");

        assert_eq!(
            response.0.permission_mode,
            Some(CodexPermissionMode::ApproveForMe)
        );
        let requests = client.mock_requests().await;
        assert_eq!(requests[0].0, "thread/start");
        assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
        assert_eq!(requests[1].0, "turn/start");
        assert_eq!(requests[1].1["approvalsReviewer"], "auto_review");
    }

    #[tokio::test]
    async fn create_task_persists_the_applied_model_and_reasoning_effort() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-model-settings";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/start",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "Model settings regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 1.0,
                        "turns": []
                    },
                    "model": "gpt-5.6-luna",
                    "reasoningEffort": "medium"
                }),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "turn/start",
                json!({
                    "turn": {
                        "id": "turn-model-settings",
                        "items": [],
                        "status": "inProgress"
                    }
                }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = create_task(
            State(state.clone()),
            Json(CreateTaskRequest {
                prompt: "Use xhigh".to_string(),
                images: Vec::new(),
                cwd: None,
                model: Some("gpt-5.6-sol".to_string()),
                effort: Some("xhigh".to_string()),
                permission_mode: None,
            }),
        )
        .await
        .expect("task creation succeeds");

        assert_eq!(response.0.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(response.0.reasoning_effort.as_deref(), Some("xhigh"));
        let stored = thread_store_get(&state, thread_id)
            .await
            .unwrap()
            .expect("managed thread settings");
        assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
        let requests = client.mock_requests().await;
        assert_eq!(requests[2].0, "turn/start");
        assert_eq!(requests[2].1["model"], "gpt-5.6-sol");
        assert_eq!(requests[2].1["effort"], "xhigh");
    }

    #[tokio::test]
    async fn cached_task_detail_restores_managed_thread_model_settings() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-cached-model-settings";
        let client = CodexThreadClient::mock(Vec::new());
        let state = app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        thread_store_update_composer_settings(
            &state,
            thread_id,
            Some("gpt-5.6-sol"),
            Some("xhigh"),
        )
        .await
        .unwrap();

        let (detail, revision) = cached_task_detail(&state, thread_id).await.unwrap();

        assert_eq!(revision, 0);
        assert!(detail.history_loading);
        assert_eq!(detail.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(detail.reasoning_effort.as_deref(), Some("xhigh"));
    }

    #[tokio::test]
    async fn canonical_resume_refreshes_cached_model_settings() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-canonical-model-settings";
        let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Canonical model settings",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                },
                "model": "gpt-5.6-luna",
                "reasoningEffort": "medium",
                "initialTurnsPage": {
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            }),
        )]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        thread_store_update_composer_settings(
            &state,
            thread_id,
            Some("gpt-5.6-sol"),
            Some("xhigh"),
        )
        .await
        .unwrap();

        let snapshot = state
            .codex_sessions
            .ensure_subscribed(&client, 1, thread_id)
            .await
            .unwrap();
        let detail = task_detail_from_snapshot(&state, snapshot, None)
            .await
            .unwrap();

        assert_eq!(detail.model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(detail.reasoning_effort.as_deref(), Some("medium"));
        let stored = thread_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(stored.model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("medium"));
    }

    #[tokio::test]
    async fn codex_turn_options_accepts_server_reported_reasoning_efforts() {
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
        ]);

        let xhigh = codex_turn_options(
            &client,
            Some("gpt-5.6-sol".to_string()),
            Some("xhigh".to_string()),
            Some(CodexPermissionMode::AskForApproval),
        )
        .await
        .unwrap();
        assert_eq!(xhigh.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(xhigh.effort.as_deref(), Some("xhigh"));

        let max = codex_turn_options(
            &client,
            Some("gpt-5.6-luna".to_string()),
            Some("max".to_string()),
            Some(CodexPermissionMode::ApproveForMe),
        )
        .await
        .unwrap();
        assert_eq!(max.model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(max.effort.as_deref(), Some("max"));
    }

    #[tokio::test]
    async fn codex_turn_options_rejects_effort_not_supported_by_selected_model() {
        let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
            "model/list",
            current_model_list_response(),
        )]);

        let error = codex_turn_options(
            &client,
            Some("gpt-5.6-luna".to_string()),
            Some("ultra".to_string()),
            Some(CodexPermissionMode::AskForApproval),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            ApiError::BadRequest {
                code: "invalid_codex_effort",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn codex_turn_options_rejects_model_missing_from_server_list() {
        let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
            "model/list",
            current_model_list_response(),
        )]);

        let error = codex_turn_options(
            &client,
            Some("gpt-imaginary".to_string()),
            Some("high".to_string()),
            Some(CodexPermissionMode::AskForApproval),
        )
        .await
        .unwrap_err();

        assert!(matches!(
            error,
            ApiError::BadRequest {
                code: "invalid_codex_model",
                ..
            }
        ));
    }

    fn current_model_list_response() -> JsonValue {
        json!({
            "data": [
                {
                    "id": "gpt-5.6-sol",
                    "model": "gpt-5.6-sol",
                    "displayName": "GPT-5.6-Sol",
                    "description": "Latest frontier agentic coding model.",
                    "hidden": false,
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Fast responses" },
                        { "reasoningEffort": "medium", "description": "Balanced depth" },
                        { "reasoningEffort": "high", "description": "More depth" },
                        { "reasoningEffort": "xhigh", "description": "Extra depth" },
                        { "reasoningEffort": "max", "description": "Maximum depth" },
                        { "reasoningEffort": "ultra", "description": "Automatic delegation" }
                    ],
                    "defaultReasoningEffort": "low",
                    "inputModalities": ["text", "image"],
                    "supportsPersonality": false,
                    "isDefault": true
                },
                {
                    "id": "gpt-5.6-luna",
                    "model": "gpt-5.6-luna",
                    "displayName": "GPT-5.6-Luna",
                    "description": "General purpose model.",
                    "hidden": false,
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Fast responses" },
                        { "reasoningEffort": "medium", "description": "Balanced depth" },
                        { "reasoningEffort": "high", "description": "More depth" },
                        { "reasoningEffort": "xhigh", "description": "Extra depth" },
                        { "reasoningEffort": "max", "description": "Maximum depth" }
                    ],
                    "defaultReasoningEffort": "medium",
                    "inputModalities": ["text", "image"],
                    "supportsPersonality": true,
                    "isDefault": false
                }
            ],
            "nextCursor": null
        })
    }

    async fn app_state_with_codex_client(fs: RootedFs, client: CodexThreadClient) -> AppState {
        let (task_events, _) = broadcast::channel(256);
        let task_sync = TaskSyncCoordinator::new();
        let (task_sync_events, _) = broadcast::channel(64);
        let (task_list_removals, _) = broadcast::channel(64);
        let (task_list_updates, _) = broadcast::channel(64);
        let task_rollouts = task_rollout_monitor(task_sync.clone());
        let (shutdown, _) = broadcast::channel(16);
        let fs = Arc::new(fs);
        let watch_hub = WatchHub::new(fs.clone(), shutdown.clone());
        let codex_threads = Arc::new(CodexThreadRuntime::default());
        {
            let mut runtime = codex_threads.state.lock().await;
            runtime.generation = 1;
            runtime.client = Some(client);
        }

        AppState {
            fs,
            server_settings: Arc::new(ServerSettingsStore::memory()),
            codex_threads,
            codex_sessions: CodexThreadSessions::default(),
            pending_approvals: Arc::new(AsyncMutex::new(HashMap::new())),
            task_events,
            task_sync,
            task_sync_events,
            task_list_removals,
            task_list_updates,
            thread_store: ThreadStore::memory().unwrap(),
            live_task_events: LiveTaskEventCache::default(),
            task_rollouts,
            watch_hub,
            shutdown,
            initial_path: String::new(),
            home_path: None,
        }
    }

    async fn wait_for_mock_method(client: &CodexThreadClient, method: &str) {
        wait_for_mock_method_count(client, method, 1).await;
    }

    async fn wait_for_mock_method_count(client: &CodexThreadClient, method: &str, expected: usize) {
        for _ in 0..100 {
            if client
                .mock_requests()
                .await
                .iter()
                .filter(|(requested, _)| requested == method)
                .count()
                >= expected
            {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("mock Codex client did not receive {expected} {method} request(s)");
    }

    fn task_thread_list(thread_id: &str, cwd: &Path) -> JsonValue {
        json!({
            "data": [{
                "id": thread_id,
                "preview": "Cached task detail regression",
                "status": { "type": "idle" },
                "cwd": cwd.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            }],
            "nextCursor": null,
            "backwardsCursor": null
        })
    }

    async fn manage_test_thread(state: &AppState, thread_id: &str, cwd: &Path) {
        let thread = task_thread_list(thread_id, cwd)["data"][0].clone();
        let resolved = resolve_thread_cwd(&state.fs, &thread);
        let task = task_record_from_thread(&thread, &[], resolved.as_ref(), false)
            .expect("test thread projection");
        thread_store_claim(state, stored_thread_from_task_record(&task))
            .await
            .expect("test thread is managed");
    }

    fn resumed_task(thread_id: &str, cwd: &Path) -> JsonValue {
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Cached task detail regression",
                "status": { "type": "idle" },
                "cwd": cwd.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            },
            "initialTurnsPage": {
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null
            }
        })
    }

    #[tokio::test]
    async fn task_list_forwards_and_returns_pagination_cursors() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            json!({
                "data": [],
                "nextCursor": "page-3",
                "backwardsCursor": "page-1"
            }),
        )]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = list_tasks(
            State(state),
            Query(TasksQuery {
                cursor: Some("page-2".to_string()),
            }),
        )
        .await
        .expect("task page succeeds");

        assert!(response.0.tasks.is_empty());
        assert_eq!(response.0.next_cursor.as_deref(), Some("page-3"));
        assert_eq!(
            client.mock_requests().await,
            vec![(
                "thread/list".to_string(),
                json!({
                    "cursor": "page-2",
                    "limit": TASK_LIST_PAGE_SIZE,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true
                })
            )]
        );
    }

    #[tokio::test]
    async fn managed_list_downgrades_stored_waiting_without_live_approval() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state = app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let thread = task_thread_list("thread-stale-approval", root.path())["data"][0].clone();
        let resolved = resolve_thread_cwd(&state.fs, &thread);
        let stale = task_record_from_thread(&thread, &[], resolved.as_ref(), true).unwrap();
        assert_eq!(stale.status, "waiting_for_approval");
        thread_store_claim(&state, stored_thread_from_task_record(&stale))
            .await
            .unwrap();

        let response = list_managed_tasks(State(state), Query(TasksQuery { cursor: None }))
            .await
            .unwrap();

        assert_eq!(response.0.tasks.len(), 1);
        assert_eq!(response.0.tasks[0].status, "idle");
    }

    #[tokio::test]
    async fn task_prompt_persists_the_applied_model_and_reasoning_effort() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-follow-up-model-settings";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "turn/start",
                json!({
                    "turn": {
                        "id": "turn-follow-up-model-settings",
                        "items": [],
                        "status": "inProgress"
                    }
                }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        thread_store_update_composer_settings(
            &state,
            thread_id,
            Some("gpt-5.6-luna"),
            Some("medium"),
        )
        .await
        .unwrap();

        let response = task_prompt(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
            Json(TaskPromptRequest {
                prompt: "Continue with xhigh".to_string(),
                images: Vec::new(),
                model: Some("gpt-5.6-sol".to_string()),
                effort: Some("xhigh".to_string()),
                permission_mode: None,
                active_turn_id: None,
            }),
        )
        .await
        .expect("follow-up prompt succeeds");

        assert!(!response.0.steered);
        let stored = thread_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
        let requests = client.mock_requests().await;
        assert_eq!(
            requests
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            ["thread/resume", "model/list", "turn/start"]
        );
        assert_eq!(requests[2].1["model"], "gpt-5.6-sol");
        assert_eq!(requests[2].1["effort"], "xhigh");
    }

    #[tokio::test]
    async fn task_prompt_keeps_accepted_steer_visible_before_canonical_sync() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-running-prompt-reload";
        let turn_id = "turn-active";
        let prompt = "Keep this accepted steer visible after reload";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "Running prompt reload regression",
                        "status": { "type": "active", "activeFlags": [] },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": [{
                            "id": turn_id,
                            "items": [],
                            "status": "inProgress"
                        }]
                    }
                }),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "turn/steer",
                json!({ "turnId": turn_id }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let response = task_prompt(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
            Json(TaskPromptRequest {
                prompt: prompt.to_string(),
                images: Vec::new(),
                model: None,
                effort: None,
                permission_mode: None,
                active_turn_id: Some(turn_id.to_string()),
            }),
        )
        .await
        .expect("steering prompt succeeds");

        assert!(response.0.steered);
        let (detail, _) = cached_task_detail(&state, thread_id)
            .await
            .expect("cached detail remains available during the active turn");
        assert!(detail.events.iter().any(|event| {
            event.event_type == "user_message"
                && event
                    .payload
                    .as_ref()
                    .and_then(|payload| payload["text"].as_str())
                    == Some(prompt)
        }));
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume", "turn/steer"]
        );
    }

    #[tokio::test]
    async fn continue_moves_a_history_thread_into_the_managed_store() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-continue";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/list",
                task_thread_list(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": thread }),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/list",
                task_thread_list(thread_id, root.path()),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let managed = list_managed_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .unwrap();
        assert!(managed.0.tasks.is_empty());
        assert!(client.mock_requests().await.is_empty());

        let history = list_task_history(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .unwrap();
        assert_eq!(history.0.tasks.len(), 1);

        let continued = continue_task(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .unwrap();
        assert_eq!(continued.0.thread_id, thread_id);
        assert!(!continued.0.unseen);

        let managed = list_managed_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .unwrap();
        assert_eq!(managed.0.tasks.len(), 1);

        let history = list_task_history(State(state), Query(TasksQuery { cursor: None }))
            .await
            .unwrap();
        assert!(history.0.tasks.is_empty());
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/list", "thread/read", "thread/list"]
        );
    }

    #[tokio::test]
    async fn unmanaged_deep_link_reads_metadata_without_resuming() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-unmanaged-deep-link";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread }),
        )]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let detail = task_detail(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        )
        .await
        .unwrap();

        assert!(!detail.0.managed);
        assert!(detail.0.events.is_empty());
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/read"]
        );
    }

    #[tokio::test]
    async fn task_detail_returns_cached_metadata_before_slow_resume_finishes() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-slow-detail-bootstrap";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/list",
                task_thread_list(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let tasks = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .expect("task list succeeds");
        assert_eq!(tasks.0.tasks.len(), 1);

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_detail(
                State(state),
                AxumPath(thread_id.to_string()),
                Query(TaskDetailQuery { cursor: None }),
            ),
        )
        .await
        .expect("task detail must not await a slow thread/resume")
        .expect("cached task detail remains available");

        assert_eq!(response.0.task.thread_id, thread_id);
        assert!(response.0.history_loading);
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn blank_history_cursor_returns_cached_task_detail_without_app_server_wait() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-blank-history-cursor";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/list",
                task_thread_list(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let tasks = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .expect("task list succeeds");
        assert_eq!(tasks.0.tasks.len(), 1);

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_detail(
                State(state),
                AxumPath(thread_id.to_string()),
                Query(TaskDetailQuery {
                    cursor: Some(String::new()),
                }),
            ),
        )
        .await
        .expect("a blank cursor must not wait for app-server pagination")
        .expect("cached task detail remains available");

        assert_eq!(response.0.task.thread_id, thread_id);
        assert!(response.0.history_loading);
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn history_timeout_does_not_replace_cached_task_detail() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-history-timeout-cache";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "Cached task detail regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": "older-1",
                        "backwardsCursor": "latest-anchor"
                    }
                }),
            ),
            crate::codex_app_server::MockCodexResponse::error(
                "thread/turns/list",
                crate::codex_app_server::CodexThreadError::RequestTimeout {
                    method: "thread/turns/list",
                    request_id: 31,
                    timeout_ms: 120_000,
                },
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let _viewer = state
            .codex_sessions
            .acquire_viewer(&client, 1, thread_id)
            .await
            .expect("initial task subscription succeeds");

        let error = task_detail(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery {
                cursor: Some("older-1".to_string()),
            }),
        )
        .await
        .expect_err("older history request should expose its timeout");
        assert!(matches!(
            error,
            ApiError::Timeout {
                code: "codex_app_server_timeout",
                ..
            }
        ));

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_detail(
                State(state),
                AxumPath(thread_id.to_string()),
                Query(TaskDetailQuery { cursor: None }),
            ),
        )
        .await
        .expect("cached task detail must not wait after a history timeout")
        .expect("cached task detail remains available");

        assert_eq!(response.0.task.thread_id, thread_id);
        assert_eq!(response.0.task.title, "Cached task detail regression");
        assert_eq!(
            response.0.events_page.next_cursor.as_deref(),
            Some("older-1")
        );
        assert!(!response.0.history_loading);
    }

    #[tokio::test]
    async fn task_detail_returns_cached_metadata_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-busy-connection-detail";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread =
            serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
                .expect("cached thread metadata");
        state.codex_sessions.observe_thread_metadata(thread).await;

        let runtime = state.codex_threads.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            let _runtime = runtime.state.lock().await;
            let _ = locked_tx.send(());
            tokio::time::sleep(Duration::from_millis(250)).await;
        });
        locked_rx.await.expect("runtime lock acquired");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_detail(
                State(state),
                AxumPath(thread_id.to_string()),
                Query(TaskDetailQuery { cursor: None }),
            ),
        )
        .await
        .expect("cached detail must not wait for app-server connection access")
        .expect("cached task detail remains available");

        assert_eq!(response.0.task.thread_id, thread_id);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn task_stream_starts_before_slow_resume_finishes() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-slow-stream-bootstrap";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/list",
                task_thread_list(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let _ = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .expect("task list succeeds");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_stream(
                State(state),
                AxumPath(thread_id.to_string()),
                Query(TasksQuery { cursor: None }),
            ),
        )
        .await
        .expect("task stream must not await a slow thread/resume")
        .expect("task stream starts from cached metadata");

        assert_eq!(response.status(), StatusCode::OK);
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn task_stream_watches_rollout_path_discovered_during_resume() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-rollout-path-after-resume";
        let rollout_path = root.path().join("rollout.jsonl");
        std::fs::write(&rollout_path, "").unwrap();
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/list",
                task_thread_list(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "External running regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "path": rollout_path.display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let _ = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .expect("task list succeeds");

        let response = task_stream(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
        )
        .await
        .expect("task stream succeeds");
        wait_for_mock_method(&client, "thread/resume").await;

        std::fs::write(
            &rollout_path,
            concat!(
                r#"{"timestamp":"2026-07-22T00:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-external","started_at":1784713963}}"#,
                "\n"
            ),
        )
        .unwrap();

        let running = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if state
                    .codex_sessions
                    .snapshot(thread_id)
                    .await
                    .is_some_and(|snapshot| {
                        snapshot.is_running()
                            && snapshot.external_activity_turn_id.as_deref()
                                == Some("turn-external")
                    })
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await;

        drop(response);
        assert!(
            running.is_ok(),
            "rollout activity must be observed after resume supplies the path"
        );
    }

    #[tokio::test]
    async fn task_stream_starts_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-busy-connection-stream";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread =
            serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
                .expect("cached thread metadata");
        state.codex_sessions.observe_thread_metadata(thread).await;

        let runtime = state.codex_threads.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            let _runtime = runtime.state.lock().await;
            let _ = locked_tx.send(());
            tokio::time::sleep(Duration::from_millis(250)).await;
        });
        locked_rx.await.expect("runtime lock acquired");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_stream(
                State(state),
                AxumPath(thread_id.to_string()),
                Query(TasksQuery { cursor: None }),
            ),
        )
        .await
        .expect("task stream must not wait for app-server connection access")
        .expect("task stream starts from cached metadata");

        assert_eq!(response.status(), StatusCode::OK);
        drop(response);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn direct_task_detail_returns_loading_snapshot_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-uncached-busy-detail";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let runtime = state.codex_threads.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            let _runtime = runtime.state.lock().await;
            let _ = locked_tx.send(());
            tokio::time::sleep(Duration::from_millis(250)).await;
        });
        locked_rx.await.expect("runtime lock acquired");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_detail(
                State(state),
                AxumPath(thread_id.to_string()),
                Query(TaskDetailQuery { cursor: None }),
            ),
        )
        .await
        .expect("direct task detail must not wait for app-server connection access")
        .expect("direct task detail starts with a loading snapshot");

        assert_eq!(response.0.task.thread_id, thread_id);
        assert_eq!(response.0.task.status, "loading");
        assert!(response.0.history_loading);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn direct_task_stream_starts_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-uncached-busy-stream";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let runtime = state.codex_threads.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            let _runtime = runtime.state.lock().await;
            let _ = locked_tx.send(());
            tokio::time::sleep(Duration::from_millis(250)).await;
        });
        locked_rx.await.expect("runtime lock acquired");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_stream(
                State(state),
                AxumPath(thread_id.to_string()),
                Query(TasksQuery { cursor: None }),
            ),
        )
        .await
        .expect("direct task stream must not wait for app-server connection access")
        .expect("direct task stream starts from a loading snapshot");

        assert_eq!(response.status(), StatusCode::OK);
        drop(response);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn resume_failure_keeps_cached_task_detail_available() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-failed-detail-bootstrap";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/list",
                task_thread_list(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::error(
                "thread/resume",
                crate::codex_app_server::CodexThreadError::Protocol(
                    "resume unavailable".to_string(),
                ),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let _ = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .expect("task list succeeds");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            task_detail(
                State(state.clone()),
                AxumPath(thread_id.to_string()),
                Query(TaskDetailQuery { cursor: None }),
            ),
        )
        .await
        .expect("task detail must not await a failed thread/resume")
        .expect("cached task detail remains available");
        assert_eq!(response.0.task.thread_id, thread_id);

        wait_for_mock_method(&client, "thread/resume").await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        let snapshot = state
            .codex_sessions
            .snapshot(thread_id)
            .await
            .expect("cached session remains tracked");
        assert!(snapshot.thread.is_some());
        assert!(snapshot.last_error.is_some());
    }

    #[tokio::test]
    async fn resume_timeout_keeps_task_detail_and_connection_available() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-timeout-detail-bootstrap";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/list",
                task_thread_list(thread_id, root.path()),
            ),
            crate::codex_app_server::MockCodexResponse::error(
                "thread/resume",
                crate::codex_app_server::CodexThreadError::RequestTimeout {
                    method: "thread/resume",
                    request_id: 17,
                    timeout_ms: 120_000,
                },
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let _ = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .expect("task list succeeds");

        let first = tokio::time::timeout(
            Duration::from_millis(50),
            task_detail(
                State(state.clone()),
                AxumPath(thread_id.to_string()),
                Query(TaskDetailQuery { cursor: None }),
            ),
        )
        .await
        .expect("task detail must not await a timed-out thread/resume")
        .expect("cached task detail remains available");
        assert_eq!(first.0.task.thread_id, thread_id);
        assert!(first.0.history_loading);

        wait_for_mock_method(&client, "thread/resume").await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        let second = task_detail(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        )
        .await
        .expect("task re-entry remains available after a resume timeout");
        assert_eq!(second.0.task.thread_id, thread_id);

        let snapshot = state
            .codex_sessions
            .snapshot(thread_id)
            .await
            .expect("cached session remains tracked");
        assert!(snapshot.thread.is_some());
        assert!(snapshot.last_error.is_some());
        assert_eq!(state.codex_threads.diagnostics().await, (1, true));
    }

    #[tokio::test]
    async fn background_sync_timeout_keeps_cached_task_detail_available() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-background-sync-timeout";
        let client =
            CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::error(
                "thread/read",
                crate::codex_app_server::CodexThreadError::RequestTimeout {
                    method: "thread/read",
                    request_id: 29,
                    timeout_ms: 120_000,
                },
            )]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread =
            serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
                .expect("cached thread metadata");
        state.codex_sessions.observe_thread_metadata(thread).await;

        let _subscription = state.task_sync.subscribe(thread_id);
        let mut sync_events = state.task_sync_events.subscribe();
        ensure_task_sync_worker(&state).await;
        state
            .task_sync
            .observe_rollout_invalidation(thread_id.to_string());

        wait_for_mock_method(&client, "thread/read").await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        assert!(
            tokio::time::timeout(Duration::from_millis(20), sync_events.recv())
                .await
                .is_err(),
            "a background timeout must not replace cached detail through task-sync"
        );
        let detail = task_detail(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        )
        .await
        .expect("cached detail remains available after a background sync timeout");
        assert_eq!(detail.0.task.thread_id, thread_id);
        assert_ne!(detail.0.task.status, "loading");

        let snapshot = state
            .codex_sessions
            .snapshot(thread_id)
            .await
            .expect("cached session remains tracked");
        assert!(snapshot.thread.is_some());
        assert!(snapshot.last_error.is_some());
        assert_eq!(state.codex_threads.diagnostics().await, (1, true));
    }

    #[tokio::test]
    async fn app_server_recovery_does_not_block_on_leased_thread_restoration() {
        let sessions = CodexThreadSessions::default();
        let first_client =
            CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": "thread-slow-recovery",
                        "preview": "Slow recovery regression",
                        "status": { "type": "idle" },
                        "cwd": "/tmp",
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            )]);
        let _viewer = sessions
            .acquire_viewer(&first_client, 1, "thread-slow-recovery")
            .await
            .expect("viewer");
        sessions
            .connection_lost(1, "process exited".to_string())
            .await;

        let recovered_client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::delayed_ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": "thread-slow-recovery",
                        "preview": "Slow recovery regression",
                        "status": { "type": "idle" },
                        "cwd": "/tmp",
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
                Duration::from_millis(120),
            ),
        ]);
        let connection = CodexThreadConnection {
            client: recovered_client.clone(),
            generation: 2,
        };

        let started = tokio::time::Instant::now();
        restore_leased_codex_sessions(sessions.clone(), connection);
        assert!(
            started.elapsed() < Duration::from_millis(20),
            "connection acquisition must not await session restoration"
        );

        wait_for_mock_method(&recovered_client, "thread/resume").await;
        tokio::time::sleep(Duration::from_millis(140)).await;
        let snapshot = sessions
            .snapshot("thread-slow-recovery")
            .await
            .expect("recovered snapshot");
        assert_eq!(snapshot.generation, 2);
        assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
    }

    #[tokio::test]
    async fn task_detail_handler_releases_its_subscription_after_the_response() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-detail-handler";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "Handler lifecycle regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let response = task_detail(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        )
        .await
        .expect("task detail succeeds");

        assert_eq!(response.0.task.thread_id, thread_id);
        wait_for_mock_method(&client, "thread/unsubscribe").await;
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume", "thread/unsubscribe"]
        );
    }

    #[tokio::test]
    async fn task_detail_and_stream_share_one_subscription_until_the_stream_closes() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-detail-stream-handler";
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::delayed_ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "Shared handler lifecycle regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
                Duration::from_millis(50),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let detail_state = state.clone();
        let detail = tokio::spawn(async move {
            task_detail(
                State(detail_state),
                AxumPath(thread_id.to_string()),
                Query(TaskDetailQuery { cursor: None }),
            )
            .await
        });
        let stream_state = state.clone();
        let stream = tokio::spawn(async move {
            task_stream(
                State(stream_state),
                AxumPath(thread_id.to_string()),
                Query(TasksQuery { cursor: None }),
            )
            .await
        });

        let detail_response = detail.await.unwrap().expect("task detail succeeds");
        let stream_response = stream.await.unwrap().expect("task stream succeeds");
        assert_eq!(detail_response.0.task.thread_id, thread_id);

        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume"]
        );

        drop(stream_response);
        wait_for_mock_method(&client, "thread/unsubscribe").await;
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume", "thread/unsubscribe"]
        );
    }

    #[tokio::test]
    async fn task_stream_reopens_while_detail_unsubscribe_is_in_flight() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-detail-stream-reopen";
        let resume = || {
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Reopen lifecycle regression",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                },
                "initialTurnsPage": {
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            })
        };
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok("thread/resume", resume()),
            crate::codex_app_server::MockCodexResponse::delayed_ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
                Duration::from_millis(250),
            ),
            crate::codex_app_server::MockCodexResponse::ok("thread/resume", resume()),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            app_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let _detail_response = task_detail(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        )
        .await
        .expect("task detail succeeds");
        wait_for_mock_method(&client, "thread/unsubscribe").await;

        let stream_response = tokio::time::timeout(
            Duration::from_millis(50),
            task_stream(
                State(state.clone()),
                AxumPath(thread_id.to_string()),
                Query(TasksQuery { cursor: None }),
            ),
        )
        .await
        .expect("task stream must not wait for the detail cleanup RPC")
        .expect("task stream succeeds");

        wait_for_mock_method_count(&client, "thread/resume", 2).await;
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume", "thread/unsubscribe", "thread/resume"]
        );

        tokio::time::sleep(Duration::from_millis(275)).await;
        let snapshot = state
            .codex_sessions
            .snapshot(thread_id)
            .await
            .expect("thread session snapshot");
        assert_eq!(
            snapshot.lifecycle,
            crate::codex_thread_sessions::ThreadSessionLifecycle::Subscribed
        );
        assert_eq!(snapshot.viewer_leases, 1);

        drop(stream_response);
        wait_for_mock_method_count(&client, "thread/unsubscribe", 2).await;
    }

    #[test]
    fn task_stream_bootstrap_replays_the_canonical_detail_snapshot() {
        let thread_id = "thread-bootstrap";
        let assistant = task_event_record(
            thread_id,
            "turn-1:assistant-1",
            "assistant_message",
            "canonical assistant response",
            Some(json!({ "text": "canonical assistant response" })),
            2,
        );
        let sync = TaskDetailSync {
            thread_id: thread_id.to_string(),
            revision: 7,
            detail: TaskDetailResponse {
                managed: true,
                revision: 7,
                task: TaskRecord {
                    id: thread_id.to_string(),
                    thread_id: thread_id.to_string(),
                    title: "Bootstrap regression".to_string(),
                    preview: "canonical assistant response".to_string(),
                    status: "idle".to_string(),
                    cwd: "/tmp".to_string(),
                    cwd_path: None,
                    relative_cwd: ".".to_string(),
                    worktree: None,
                    created_ms: 1,
                    updated_ms: 2,
                    recency_ms: None,
                    active_turn_id: None,
                    active_turn_started_ms: None,
                    last_event_summary: Some("canonical assistant response".to_string()),
                    unseen: false,
                },
                events: vec![assistant],
                events_page: TaskEventsPage { next_cursor: None },
                pending_approvals: Vec::new(),
                history_loading: false,
                permission_mode: Some(CodexPermissionMode::AskForApproval),
                model: Some("gpt-test".to_string()),
                reasoning_effort: Some("xhigh".to_string()),
            },
            reason: "stream-bootstrap",
        };

        let frames = task_stream_initial_frames(&sync)
            .into_iter()
            .map(|frame| String::from_utf8(frame.to_vec()).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(frames[0], ": ready\n\n");
        assert_eq!(
            frames.len(),
            2,
            "the initial stream must replay canonical state"
        );
        assert!(frames[1].starts_with("event: task-sync\ndata: "));
        assert!(frames[1].contains("\"threadId\":\"thread-bootstrap\""));
        assert!(frames[1].contains("\"revision\":7"));
        assert!(frames[1].contains("\"type\":\"assistant_message\""));
        assert!(frames[1].contains("canonical assistant response"));
    }

    #[test]
    fn extracts_codex_version_from_app_server_user_agent() {
        assert_eq!(
            codex_version_from_user_agent("Codex Desktop/0.144.4"),
            Some("0.144.4".to_string())
        );
        assert_eq!(codex_version_from_user_agent("Codex Desktop"), None);
    }

    #[tokio::test]
    async fn task_sync_coordinator_only_invalidates_subscribed_threads() {
        let coordinator = TaskSyncCoordinator::new();
        let mut receiver = coordinator.take_receiver().await.unwrap();

        coordinator.observe_rollout_invalidation("thread-1".to_string());
        assert!(receiver.try_recv().is_err());

        let first = coordinator.subscribe("thread-1");
        let second = coordinator.subscribe("thread-1");
        coordinator.observe_rollout_invalidation("thread-1".to_string());
        assert_eq!(
            receiver.try_recv().unwrap(),
            TaskSyncRequest::Rollout("thread-1".to_string(), TaskRolloutSignal::Invalidated)
        );

        drop(first);
        coordinator.observe_rollout_invalidation("thread-1".to_string());
        assert_eq!(
            receiver.try_recv().unwrap(),
            TaskSyncRequest::Rollout("thread-1".to_string(), TaskRolloutSignal::Invalidated)
        );

        drop(second);
        assert_eq!(
            receiver.try_recv().unwrap(),
            TaskSyncRequest::Unsubscribe("thread-1".to_string())
        );
        coordinator.observe_rollout_invalidation("thread-1".to_string());
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn task_sync_coordinator_tracks_invalidations_until_canonical_sync() {
        let coordinator = TaskSyncCoordinator::new();
        let mut receiver = coordinator.take_receiver().await.unwrap();
        let _subscription = coordinator.subscribe("thread-1");

        coordinator.observe_rollout_invalidation("thread-1".to_string());

        assert_eq!(
            receiver.try_recv().unwrap(),
            TaskSyncRequest::Rollout("thread-1".to_string(), TaskRolloutSignal::Invalidated)
        );
        let revision = coordinator.pending_invalidation("thread-1").unwrap();
        assert!(coordinator.pending_invalidation("thread-1").is_some());

        coordinator.mark_synchronized("thread-1", revision);

        assert!(coordinator.pending_invalidation("thread-1").is_none());
    }

    #[tokio::test]
    async fn task_sync_coordinator_keeps_changes_observed_during_a_sync() {
        let coordinator = TaskSyncCoordinator::new();
        let mut receiver = coordinator.take_receiver().await.unwrap();
        let _subscription = coordinator.subscribe("thread-1");

        coordinator.observe_rollout_invalidation("thread-1".to_string());
        assert_eq!(
            receiver.try_recv().unwrap(),
            TaskSyncRequest::Rollout("thread-1".to_string(), TaskRolloutSignal::Invalidated)
        );
        let synchronizing_revision = coordinator.pending_invalidation("thread-1").unwrap();

        coordinator.observe_rollout_invalidation("thread-1".to_string());
        assert_eq!(
            receiver.try_recv().unwrap(),
            TaskSyncRequest::Rollout("thread-1".to_string(), TaskRolloutSignal::Invalidated)
        );
        let newer_revision = coordinator.pending_invalidation("thread-1").unwrap();
        assert!(newer_revision > synchronizing_revision);

        coordinator.mark_synchronized("thread-1", synchronizing_revision);

        assert_eq!(
            coordinator.pending_invalidation("thread-1"),
            Some(newer_revision)
        );
    }

    #[test]
    fn continuous_task_invalidations_have_a_maximum_latency() {
        let started_at = tokio::time::Instant::now();
        let mut pending = HashMap::new();

        schedule_task_sync(&mut pending, "thread-1".to_string(), started_at);
        for offset_ms in [500, 1_000, 1_500, 1_900] {
            schedule_task_sync(
                &mut pending,
                "thread-1".to_string(),
                started_at + Duration::from_millis(offset_ms),
            );
        }

        assert_eq!(
            pending["thread-1"].deadline(),
            started_at + TASK_SYNC_MAX_LATENCY
        );
    }

    #[test]
    fn canonical_sync_retries_are_bounded() {
        let started_at = tokio::time::Instant::now();
        let mut pending = HashMap::new();

        schedule_task_sync_retry(&mut pending, "thread-1".to_string(), 0, started_at);
        assert_eq!(pending["thread-1"].retry_attempt, 1);
        assert_eq!(
            pending["thread-1"].deadline(),
            started_at + TASK_SYNC_RETRY_BASE
        );

        pending.clear();
        schedule_task_sync_retry(&mut pending, "thread-1".to_string(), 1, started_at);
        assert_eq!(pending["thread-1"].retry_attempt, 2);
        assert_eq!(
            pending["thread-1"].deadline(),
            started_at + TASK_SYNC_RETRY_BASE.saturating_mul(2)
        );

        pending.clear();
        schedule_task_sync_retry(&mut pending, "thread-1".to_string(), 3, started_at);
        assert!(pending.is_empty());
    }

    #[tokio::test]
    async fn external_thread_sync_reads_without_resuming_or_unsubscribing() {
        let idle_thread = json!({
            "id": "thread-external",
            "preview": "External task",
            "status": { "type": "idle" },
            "cwd": "Workspace/rust/codger",
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "turns": []
        });
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/read",
                json!({
                    "thread": idle_thread
                }),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "thread/turns/list",
                json!({
                    "data": [{
                        "id": "turn-external",
                        "status": "inProgress",
                        "items": [],
                        "error": null
                    }]
                }),
            ),
        ]);
        let (thread, turns) = tokio::try_join!(
            client.read_thread("thread-external"),
            client.list_thread_turns("thread-external", None, TASK_DETAIL_TURNS_PAGE_SIZE),
        )
        .unwrap();

        assert_eq!(thread.status, ThreadStatus::Idle);
        assert_eq!(turns.data[0].status, TurnStatus::InProgress);

        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/read", "thread/turns/list"]
        );
    }

    #[test]
    fn task_images_must_stay_inside_the_browsing_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let image_path = root.path().join("attachment.png");
        let outside_path = outside.path().join("attachment.png");
        std::fs::write(&image_path, b"png").unwrap();
        std::fs::write(&outside_path, b"png").unwrap();
        let fs = RootedFs::new(root.path()).unwrap();

        assert_eq!(
            task_image_logical_path(&fs, &image_path).unwrap(),
            "attachment.png"
        );
        assert!(matches!(
            task_image_logical_path(&fs, &outside_path),
            Err(FsError::PathEscapesRoot)
        ));
    }

    #[test]
    fn task_input_accepts_text_and_raster_images() {
        let image = "data:image/png;base64,aGVsbG8=".to_string();
        assert_eq!(
            normalize_task_input("  inspect this  ", vec![image.clone()]).unwrap(),
            ("inspect this".to_string(), vec![image])
        );
    }

    #[test]
    fn task_input_accepts_an_image_without_text() {
        let image = "data:image/webp;base64,aGVsbG8=".to_string();
        assert_eq!(
            normalize_task_input("", vec![image.clone()]).unwrap(),
            (String::new(), vec![image])
        );
    }

    #[test]
    fn task_user_messages_hide_legacy_ambient_browser_context() {
        let item = json!({
            "content": [{
                "type": "text",
                "text": concat!(
                    "This block is automatically supplied ambient UI state, not part of the user's request. ",
                    "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.\n",
                    "# In app browser:\n",
                    "- The user has the in-app browser open with 1 tab.\n",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n\n",
                    "My request for Codex:\n",
                    "실제 요청만 보여줘"
                )
            }]
        });

        assert_eq!(
            user_message_text(&item).as_deref(),
            Some("실제 요청만 보여줘")
        );
    }

    #[test]
    fn task_user_messages_hide_structured_ambient_browser_context() {
        let item = json!({
            "content": [{
                "type": "text",
                "text": concat!(
                    "<in-app-browser-context source=\"ambient-ui-state\">\n",
                    "This block is automatically supplied ambient UI state, not part of the user's request.\n",
                    "# In app browser:\n",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n",
                    "</in-app-browser-context>\n\n",
                    "## My request for Codex:\n",
                    "Show only this request."
                )
            }]
        });

        assert_eq!(
            user_message_text(&item).as_deref(),
            Some("Show only this request.")
        );
    }

    #[test]
    fn task_user_messages_accept_app_server_input_text_items() {
        let item = json!({
            "content": [{
                "type": "input_text",
                "text": concat!(
                    "\n<in-app-browser-context source=\"ambient-ui-state\">\n",
                    "This block is automatically supplied ambient UI state, not part of the user's request. ",
                    "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.\n",
                    "# In app browser:\n",
                    "- The user has the in-app browser open with 1 tab.\n",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n",
                    "</in-app-browser-context>\n\n",
                    "## My request for Codex:\n",
                    "실제 요청만 보여줘\n"
                )
            }]
        });

        assert_eq!(
            user_message_text(&item).as_deref(),
            Some("실제 요청만 보여줘")
        );
    }

    #[test]
    fn task_user_messages_hide_ambient_context_with_leading_space_and_single_newlines() {
        let item = json!({
            "content": [{
                "type": "text",
                "text": concat!(
                    "\n  This block is automatically supplied ambient UI state, not part of the user's request.\n",
                    "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.\n",
                    "# In app browser:\n",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n",
                    "My request for Codex:\n",
                    "실제 요청만 보여줘"
                )
            }]
        });

        assert_eq!(
            user_message_text(&item).as_deref(),
            Some("실제 요청만 보여줘")
        );
    }

    #[test]
    fn task_user_messages_hide_ambient_context_when_the_gui_flattens_newlines() {
        let item = json!({
            "content": [{
                "type": "text",
                "text": concat!(
                    "This block is automatically supplied ambient UI state, not part of the user's request. ",
                    "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser. ",
                    "# In app browser: - The user has the in-app browser open with 1 tab. ",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1 ",
                    "My request for Codex: 실제 요청만 보여줘"
                )
            }]
        });

        assert_eq!(
            user_message_text(&item).as_deref(),
            Some("실제 요청만 보여줘")
        );
    }

    #[test]
    fn task_user_messages_hide_ambient_context_after_attachment_metadata() {
        let item = json!({
            "content": [
                {
                    "type": "input_text",
                    "text": concat!(
                        "# Files mentioned by the user:\n\n",
                        "codex-clipboard-example.png: /tmp/codex-clipboard-example.png\n\n"
                    )
                },
                {
                    "type": "input_text",
                    "text": concat!(
                        "<in-app-browser-context source=\"ambient-ui-state\">\n",
                        "This block is automatically supplied ambient UI state, not part of the user's request.\n",
                        "# In app browser:\n",
                        "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n",
                        "</in-app-browser-context>\n\n",
                        "## My request for Codex:\n",
                        "실제 요청만 보여줘"
                    )
                }
            ]
        });

        assert_eq!(
            user_message_text(&item).as_deref(),
            Some("실제 요청만 보여줘")
        );
    }

    #[test]
    fn only_the_latest_turn_can_be_active() {
        let completed_thread = json!({
            "turns": [
                { "id": "stale", "status": "inProgress" },
                { "id": "latest", "status": "completed" }
            ]
        });
        let running_thread = json!({
            "turns": [
                { "id": "completed", "status": "completed" },
                { "id": "latest", "status": "inProgress" }
            ]
        });

        assert_eq!(active_turn_id(&completed_thread), None);
        assert_eq!(active_turn_id(&running_thread).as_deref(), Some("latest"));
    }

    #[test]
    fn recognizes_structured_thread_unavailable_errors() {
        assert!(
            codex_app_server::CodexThreadError::ThreadUnavailable("019f-test".to_string())
                .is_thread_unavailable()
        );
        assert!(
            !codex_app_server::CodexThreadError::RequestTimeout {
                method: "thread/resume",
                request_id: 1,
                timeout_ms: 120_000,
            }
            .is_thread_unavailable()
        );
    }

    #[tokio::test]
    async fn request_timeouts_keep_the_cached_codex_connection() {
        let runtime = CodexThreadRuntime::default();
        {
            let mut state = runtime.state.lock().await;
            state.generation = 7;
            state.client = Some(CodexThreadClient::mock(Vec::new()));
        }

        assert!(
            !runtime
                .invalidate_after_error(
                    7,
                    &codex_app_server::CodexThreadError::RequestTimeout {
                        method: "thread/resume",
                        request_id: 1,
                        timeout_ms: 120_000,
                    },
                )
                .await
        );
        assert_eq!(runtime.diagnostics().await, (7, true));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn transport_failures_discard_the_cached_codex_connection() {
        let runtime = CodexThreadRuntime::default();
        {
            let mut state = runtime.state.lock().await;
            state.generation = 8;
            state.client = Some(CodexThreadClient::mock(Vec::new()));
        }

        assert!(
            runtime
                .invalidate_after_error(8, &codex_app_server::CodexThreadError::ProcessUnavailable,)
                .await
        );
        assert_eq!(runtime.diagnostics().await, (8, false));
    }

    #[tokio::test]
    async fn protocol_failures_keep_a_healthy_codex_connection() {
        let runtime = CodexThreadRuntime::default();
        {
            let mut state = runtime.state.lock().await;
            state.generation = 9;
            state.client = Some(CodexThreadClient::mock(Vec::new()));
        }

        assert!(
            !runtime
                .invalidate_after_error(
                    9,
                    &codex_app_server::CodexThreadError::InvalidParams(
                        "invalid fixture".to_string(),
                    ),
                )
                .await
        );
        assert_eq!(runtime.diagnostics().await, (9, true));
        runtime.shutdown().await;
    }

    #[test]
    fn task_input_rejects_unsupported_or_malformed_images() {
        for image in [
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
            "data:image/png;base64,not base64",
            "data:image/png;base64,a===",
        ] {
            assert!(matches!(
                normalize_task_input("inspect", vec![image.to_string()]),
                Err(ApiError::BadRequest {
                    code: "invalid_task_image",
                    ..
                })
            ));
        }
    }

    #[test]
    fn task_input_limits_image_count() {
        let images = vec!["data:image/png;base64,aGVsbG8=".to_string(); MAX_TASK_IMAGES + 1];
        assert!(matches!(
            normalize_task_input("inspect", images),
            Err(ApiError::BadRequest {
                code: "too_many_task_images",
                ..
            })
        ));
    }

    #[test]
    fn server_name_is_applied_to_install_metadata() {
        let index = render_index("Caffold & Mac Studio");
        assert!(index.contains("<title>Caffold &amp; Mac Studio</title>"));
        assert!(index.contains("content=\"Caffold &amp; Mac Studio\""));
        assert!(!index.contains("{{CAFFOLD_SERVER_NAME}}"));

        let manifest: JsonValue =
            serde_json::from_slice(&render_manifest("Caffold Studio").unwrap()).unwrap();
        assert_eq!(manifest["name"], "Caffold Studio");
        assert_eq!(manifest["short_name"], "Caffold Studio");
        assert_eq!(manifest["id"], "/");
    }

    #[test]
    fn thread_list_response_keeps_all_cwds_and_sorts_by_recency() {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        std::fs::create_dir_all(project_root.join("src")).unwrap();
        let fs = RootedFs::new(temp.path()).unwrap();
        let response = json!({
            "data": [
                {
                    "id": "thread_old",
                    "preview": "Old thread",
                    "cwd": project_root.display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "recencyAt": 3.0,
                    "status": { "type": "idle" }
                },
                {
                    "id": "thread_new",
                    "preview": "New thread",
                    "cwd": project_root.join("src").display().to_string(),
                    "createdAt": 4.0,
                    "updatedAt": 5.0,
                    "recencyAt": 6.0,
                    "status": { "type": "active" },
                    "turns": [{ "id": "turn_1", "status": "inProgress" }]
                },
                {
                    "id": "thread_outside",
                    "preview": "Outside thread",
                    "cwd": temp.path().join("other").display().to_string(),
                    "createdAt": 7.0,
                    "updatedAt": 8.0,
                    "recencyAt": 9.0,
                    "status": { "type": "idle" }
                }
            ]
        });

        let tasks = thread_list_response(&fs, &response);
        assert_eq!(
            tasks
                .iter()
                .map(|task| task.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["thread_outside", "thread_new", "thread_old"]
        );
    }

    #[test]
    fn thread_list_response_all_threads_keeps_unregistered_directories() {
        let temp = tempfile::tempdir().unwrap();
        let fs = RootedFs::new(temp.path()).unwrap();
        let project_root = temp.path().join("project");
        std::fs::create_dir_all(project_root.join("src")).unwrap();
        std::fs::create_dir(temp.path().join("outside")).unwrap();
        let response = json!({
            "data": [
                {
                    "id": "thread_project",
                    "preview": "Repository thread",
                    "cwd": temp.path().join("project/src").display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "status": { "type": "idle" }
                },
                {
                    "id": "thread_global",
                    "preview": "Global thread",
                    "cwd": temp.path().join("outside").display().to_string(),
                    "createdAt": 3.0,
                    "updatedAt": 4.0,
                    "status": { "type": "idle" }
                }
            ]
        });

        let tasks = thread_list_response(&fs, &response);

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].thread_id, "thread_global");
        assert_eq!(tasks[1].thread_id, "thread_project");
        assert_eq!(tasks[1].relative_cwd, "project/src");
    }

    #[tokio::test]
    async fn task_cwd_resolution_is_bounded_and_concurrent() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let started = std::time::Instant::now();
        let values =
            resolve_task_cwds_with((0..16).map(|index| format!("cwd-{index}")).collect(), {
                let active = active.clone();
                let peak = peak.clone();
                move |cwd| {
                    let active = active.clone();
                    let peak = peak.clone();
                    async move {
                        let current = active.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(current, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(40)).await;
                        active.fetch_sub(1, Ordering::SeqCst);
                        (cwd, Some(current))
                    }
                }
            })
            .await;

        assert_eq!(values.len(), 16);
        assert!(peak.load(Ordering::SeqCst) > 1);
        assert!(peak.load(Ordering::SeqCst) <= TASK_CWD_RESOLVE_CONCURRENCY);
        assert!(started.elapsed() < Duration::from_millis(200));
    }

    #[test]
    fn task_record_uses_canonical_active_turn_state() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_active",
            "preview": "Running in app-server",
            "cwd": temp.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "active" },
            "turns": [{
                "id": "turn_active",
                "status": "inProgress",
                "startedAt": 1_750_000_000.0,
                "items": []
            }]
        });
        let task = task_record_from_thread(&thread, &[], None, false).unwrap();

        assert_eq!(task.status, "running");
        assert_eq!(task.active_turn_id.as_deref(), Some("turn_active"));
        assert_eq!(task.active_turn_started_ms, Some(1_750_000_000_000));
    }

    #[test]
    fn external_session_activity_sets_the_task_active_turn() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_external",
            "preview": "Running in another Codex process",
            "cwd": temp.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "idle" },
            "turns": []
        });
        let mut task = task_record_from_thread(&thread, &[], None, false).unwrap();

        apply_session_activity(
            &mut task,
            true,
            Some("turn-external".to_string()),
            Some(1_784_569_546_000),
        );

        assert_eq!(task.status, "running");
        assert_eq!(task.active_turn_id.as_deref(), Some("turn-external"));
        assert_eq!(task.active_turn_started_ms, Some(1_784_569_546_000));
    }

    #[test]
    fn rollout_invalidation_does_not_mark_an_idle_snapshot_as_running() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_external",
            "preview": "Running in another Codex process",
            "cwd": temp.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "idle" },
            "turns": []
        });

        let task = task_record_from_thread(&thread, &[], None, false).unwrap();

        assert_eq!(task.status, "idle");
        assert_eq!(task.active_turn_id, None);
        assert_eq!(task.active_turn_started_ms, None);
    }

    #[test]
    fn thread_list_response_includes_nested_directories() {
        let temp = tempfile::tempdir().unwrap();
        let fs = RootedFs::new(temp.path()).unwrap();
        let project_root = temp.path().join("project");
        let src_root = project_root.join("src");
        std::fs::create_dir_all(&src_root).unwrap();
        let response = json!({
            "data": [
                {
                    "id": "thread_project_root",
                    "preview": "Root thread",
                    "cwd": project_root.display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "status": { "type": "idle" }
                },
                {
                    "id": "thread_src",
                    "preview": "Src thread",
                    "cwd": src_root.display().to_string(),
                    "createdAt": 3.0,
                    "updatedAt": 4.0,
                    "status": { "type": "idle" }
                }
            ]
        });

        let tasks = thread_list_response(&fs, &response);

        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].thread_id, "thread_src");
        assert_eq!(tasks[1].thread_id, "thread_project_root");
    }

    #[test]
    fn thread_read_turns_normalize_transcript_items_into_timeline_events() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "name": "Readable thread",
            "preview": "Inspect the diff",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 5.0,
            "status": { "type": "idle" },
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "startedAt": 2.0,
                    "completedAt": 4.0,
                    "items": [
                        {
                            "type": "userMessage",
                            "id": "item_prompt",
                            "content": [{ "type": "text", "text": "Inspect the diff" }]
                        },
                        {
                            "type": "reasoning",
                            "id": "item_reasoning",
                            "summary": ["Checked the relevant files"],
                            "content": ["Compared the diff"]
                        },
                        {
                            "type": "agentMessage",
                            "id": "item_answer",
                            "text": "The change is ready to review.",
                            "phase": "final"
                        },
                        {
                            "type": "plan",
                            "id": "item_plan",
                            "text": "Open the diff."
                        },
                        {
                            "type": "commandExecution",
                            "id": "item_command",
                            "command": "cargo test",
                            "cwd": "src",
                            "status": "completed",
                            "aggregatedOutput": "test result: ok"
                        },
                        {
                            "type": "fileChange",
                            "id": "item_file_change",
                            "status": "completed",
                            "changes": [{ "path": "src/lib.rs" }]
                        }
                    ]
                }
            ]
        });

        let events = thread_events(&thread);
        let event_types = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>();
        assert!(event_types.contains(&"turn_started"));
        assert!(event_types.contains(&"user_message"));
        assert!(event_types.contains(&"reasoning"));
        assert!(event_types.contains(&"assistant_message"));
        assert!(event_types.contains(&"plan"));
        assert!(event_types.contains(&"command_execution"));
        assert!(event_types.contains(&"file_change"));
        assert!(event_types.contains(&"turn_completed"));

        let reasoning = events
            .iter()
            .find(|event| event.event_type == "reasoning")
            .unwrap();
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["summary"][0],
            "Checked the relevant files"
        );
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["content"][0],
            "Compared the diff"
        );
        let command = events
            .iter()
            .find(|event| event.event_type == "command_execution")
            .unwrap();
        assert_eq!(
            command.payload.as_ref().unwrap()["aggregatedOutput"],
            "test result: ok"
        );
        let assistant = events
            .iter()
            .find(|event| event.event_type == "assistant_message")
            .unwrap();
        assert_eq!(
            assistant.payload.as_ref().unwrap()["text"],
            "The change is ready to review."
        );
    }

    #[test]
    fn normalized_task_events_do_not_duplicate_raw_items() {
        let user = task_event_from_thread_item(
            "thread_1",
            1,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "userMessage",
                    "id": "item_prompt",
                    "content": [
                        { "type": "text", "text": "Inspect the diff" },
                        { "type": "image", "url": "data:image/png;base64,aGVsbG8=" }
                    ]
                }
            }),
        )
        .expect("user message event");
        let user_payload = user.payload.as_ref().expect("user payload");
        assert!(user_payload.get("item").is_none());
        assert_eq!(user_payload["content"][0]["text"], "Inspect the diff");

        let file_change = task_event_from_thread_item(
            "thread_1",
            2,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "fileChange",
                    "id": "item_file_change",
                    "status": "completed",
                    "changes": [{
                        "path": "src/lib.rs",
                        "diff": "UNIQUE_LARGE_DIFF_PAYLOAD"
                    }]
                }
            }),
        )
        .expect("file change event");
        let file_payload = file_change.payload.as_ref().expect("file payload");
        assert!(file_payload.get("item").is_none());
        assert_eq!(file_payload["changes"][0]["path"], "src/lib.rs");
        assert_eq!(
            serde_json::to_string(&file_change)
                .expect("serialize event")
                .matches("UNIQUE_LARGE_DIFF_PAYLOAD")
                .count(),
            1
        );
    }

    #[test]
    fn image_only_user_messages_are_kept_in_the_transcript() {
        let thread = json!({
            "id": "thread_1",
            "createdAt": 1.0,
            "turns": [{
                "id": "turn_1",
                "status": "completed",
                "startedAt": 2.0,
                "completedAt": 3.0,
                "items": [{
                    "type": "userMessage",
                    "id": "item_prompt",
                    "content": [{
                        "type": "image",
                        "url": "data:image/png;base64,aGVsbG8="
                    }]
                }]
            }]
        });

        let user_message = thread_events(&thread)
            .into_iter()
            .find(|event| event.event_type == "user_message")
            .expect("image-only user message");
        let payload = user_message.payload.expect("user message payload");
        assert_eq!(payload["text"], "");
        assert_eq!(payload["content"][0]["type"], "image");
    }

    #[test]
    fn transcript_item_ids_are_scoped_to_their_turn() {
        let thread = json!({
            "id": "thread_1",
            "createdAt": 1.0,
            "turns": [
                {
                    "id": "turn_1",
                    "startedAt": 1.0,
                    "items": [{
                        "type": "agentMessage",
                        "id": "item-1",
                        "text": "First answer",
                        "phase": "final_answer"
                    }]
                },
                {
                    "id": "turn_2",
                    "startedAt": 2.0,
                    "items": [{
                        "type": "agentMessage",
                        "id": "item-1",
                        "text": "Second answer",
                        "phase": "final_answer"
                    }]
                }
            ]
        });

        let answer_ids = thread_events(&thread)
            .into_iter()
            .filter(|event| event.event_type == "assistant_message")
            .map(|event| event.id)
            .collect::<Vec<_>>();

        assert_eq!(
            answer_ids,
            vec!["thread_1:turn_1:item-1", "thread_1:turn_2:item-1"]
        );
    }

    #[test]
    fn canonical_thread_events_keep_codex_item_order_when_timestamps_match() {
        let thread = json!({
            "id": "thread_1",
            "createdAt": 1.0,
            "turns": [{
                "id": "turn_1",
                "status": "inProgress",
                "startedAt": 2.0,
                "items": [
                    {
                        "id": "item-z",
                        "type": "userMessage",
                        "content": [{ "type": "text", "text": "First" }]
                    },
                    {
                        "id": "item-a",
                        "type": "reasoning",
                        "summary": ["Second"],
                        "content": []
                    },
                    {
                        "id": "item-m",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": "Third"
                    }
                ]
            }]
        });

        let mut events = thread_events(&thread);
        sort_task_events(&mut events);
        let item_events = events
            .into_iter()
            .filter(|event| {
                event
                    .payload
                    .as_ref()
                    .is_some_and(|payload| payload["itemId"].is_string())
            })
            .map(|event| {
                (
                    event.payload.unwrap()["itemId"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    event.sort_index,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            item_events,
            vec![
                ("item-z".to_string(), Some(1)),
                ("item-a".to_string(), Some(2)),
                ("item-m".to_string(), Some(3)),
            ]
        );
    }

    #[test]
    fn live_task_event_cache_preserves_latest_transient_item_state() {
        let cache = LiveTaskEventCache::default();
        let started = task_event_record(
            "thread_1",
            "turn_1:command_1",
            "command_execution",
            "Command started",
            Some(json!({
                "status": "inProgress",
                "aggregatedOutput": "test result: ok"
            })),
            10,
        );
        let completed = task_event_record(
            "thread_1",
            "turn_1:command_1",
            "command_execution",
            "Command completed",
            Some(json!({ "status": "completed" })),
            20,
        );

        cache.record(started.clone());
        cache.record(completed.clone());
        cache.record(task_event_record(
            "thread_2",
            "turn_2:command_1",
            "command_execution",
            "Other command",
            None,
            30,
        ));

        let merged = merge_task_event_records(Vec::new(), cache.for_thread("thread_1"));
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].summary, completed.summary);
        assert_eq!(merged[0].payload.as_ref().unwrap()["status"], "completed");
        assert_eq!(
            merged[0].created_ms, started.created_ms,
            "completing an item must not move it from its original timeline position"
        );
        assert_eq!(
            merged[0].payload.as_ref().unwrap()["aggregatedOutput"],
            "test result: ok"
        );

        cache.record(started);
        let merged = cache.for_thread("thread_1");
        assert_eq!(merged[0].summary, completed.summary);
        assert_eq!(merged[0].payload.as_ref().unwrap()["status"], "completed");
    }

    #[test]
    fn live_task_event_cache_preserves_items_omitted_from_later_thread_reads() {
        let cache = LiveTaskEventCache::default();
        let command = task_event_record(
            "thread_1",
            "turn_1:command_1",
            "command_execution",
            "Command completed",
            Some(json!({
                "command": "printf caffold-command",
                "status": "completed"
            })),
            20,
        );

        cache.observe(std::slice::from_ref(&command));
        let later_thread_read = Vec::new();
        let merged = merge_task_event_records(later_thread_read, cache.for_thread("thread_1"));
        let mut positioned_command = command;
        positioned_command.sort_index = Some(0);

        assert_eq!(merged, vec![positioned_command]);
    }

    #[test]
    fn canonical_user_message_replaces_the_locally_accepted_prompt() {
        let cache = LiveTaskEventCache::default();
        let image = "data:image/png;base64,aGVsbG8=".to_string();
        cache.record(accepted_user_message_event(
            "thread_1",
            "turn_1",
            "Inspect this image",
            std::slice::from_ref(&image),
        ));
        let canonical = task_event_from_thread_item(
            "thread_1",
            20,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "userMessage",
                    "id": "item_prompt",
                    "content": [
                        { "type": "text", "text": "Inspect this image" },
                        { "type": "image", "url": image }
                    ]
                }
            }),
        )
        .expect("canonical user message");

        let canonical = cache.record(canonical);

        assert_eq!(cache.for_thread("thread_1"), vec![canonical]);
    }

    #[test]
    fn late_local_acceptance_does_not_duplicate_an_existing_canonical_prompt() {
        let cache = LiveTaskEventCache::default();
        let canonical = task_event_from_thread_item(
            "thread_1",
            20,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "userMessage",
                    "id": "item_prompt",
                    "content": [{ "type": "text", "text": "Already canonical" }]
                }
            }),
        )
        .expect("canonical user message");
        let canonical = cache.record(canonical);

        cache.record(accepted_user_message_event(
            "thread_1",
            "turn_1",
            "Already canonical",
            &[],
        ));

        assert_eq!(cache.for_thread("thread_1"), vec![canonical]);
    }

    #[test]
    fn live_task_event_cache_evicts_the_oldest_thread() {
        let cache = LiveTaskEventCache::default();
        for index in 0..=LIVE_TASK_THREAD_LIMIT {
            cache.record(task_event_record(
                &format!("thread_{index}"),
                "event_1",
                "assistant_message",
                "Answer",
                None,
                index as u64,
            ));
        }

        assert!(cache.for_thread("thread_0").is_empty());
        assert_eq!(
            cache
                .for_thread(&format!("thread_{LIVE_TASK_THREAD_LIMIT}"))
                .len(),
            1
        );
        assert_eq!(cache.events.lock().unwrap().len(), LIVE_TASK_THREAD_LIMIT);
    }

    #[test]
    fn reasoning_content_without_summary_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "preview": "Inspect the diff",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "idle" },
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "startedAt": 1.0,
                    "items": [
                        {
                            "type": "reasoning",
                            "id": "item_reasoning",
                            "content": ["Reasoned without a summary"]
                        }
                    ]
                }
            ]
        });

        let events = thread_events(&thread);
        let reasoning = events
            .iter()
            .find(|event| event.event_type == "reasoning")
            .unwrap();

        assert_eq!(reasoning.summary, "Reasoning");
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["content"][0],
            "Reasoned without a summary"
        );
    }

    #[test]
    fn raw_response_items_normalize_assistant_messages() {
        let event = task_event_from_raw_response_item(
            "thread_1",
            1,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "message",
                    "id": "raw_answer",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Raw response fallback." }],
                    "phase": "final"
                }
            }),
        )
        .unwrap();

        assert_eq!(event.event_type, "assistant_message");
        assert_eq!(
            event.payload.as_ref().unwrap()["text"],
            "Raw response fallback."
        );
    }

    #[test]
    fn raw_response_reasoning_content_without_summary_is_preserved() {
        let event = task_event_from_raw_response_item(
            "thread_1",
            1,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "reasoning",
                    "id": "raw_reasoning",
                    "content": [
                        { "type": "reasoning_text", "text": "Raw reasoning content" }
                    ]
                }
            }),
        )
        .unwrap();

        assert_eq!(event.event_type, "reasoning");
        assert_eq!(event.summary, "Reasoning");
        assert_eq!(
            event.payload.as_ref().unwrap()["content"][0],
            "Raw reasoning content"
        );
    }

    #[test]
    fn current_pending_approval_marks_task_as_waiting_for_approval() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "preview": "Needs approval",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "status": { "type": "active" }
        });
        let events = vec![task_event_record(
            "thread_1",
            "approval_requested:1",
            "approval_requested",
            "Command approval requested",
            Some(json!({ "approvalId": "1" })),
            1,
        )];

        let task = task_record_from_thread(&thread, &events, None, true).unwrap();
        assert_eq!(task.status, "waiting_for_approval");
    }

    #[test]
    fn resolved_approval_event_does_not_leave_idle_task_waiting() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "preview": "Approval was accepted",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 4.0,
            "status": { "type": "idle" }
        });
        let events = vec![
            task_event_record(
                "thread_1",
                "approval_requested:1",
                "approval_requested",
                "Command approval requested",
                Some(json!({ "approvalId": "1" })),
                1,
            ),
            task_event_record(
                "thread_1",
                "approval_resolved:1",
                "approval_resolved",
                "Approval resolved: accept",
                Some(json!({ "approvalId": "1", "decision": "accept" })),
                2,
            ),
            task_event_record(
                "thread_1",
                "turn_1:completed",
                "turn_completed",
                "Turn completed",
                Some(json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "status": "completed"
                })),
                3,
            ),
            task_event_record(
                "thread_1",
                "thread_status_changed",
                "thread_status_changed",
                "Thread idle",
                Some(json!({ "threadId": "thread_1", "status": "idle" })),
                4,
            ),
        ];

        let task = task_record_from_thread(&thread, &events, None, false).unwrap();
        assert_eq!(task.status, "idle");
    }

    #[test]
    fn completed_turn_does_not_leave_abandoned_approval_waiting() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "preview": "A later prompt completed",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 3.0,
            "status": { "type": "idle" }
        });
        let events = vec![
            task_event_record(
                "thread_1",
                "approval_requested:1",
                "approval_requested",
                "Command approval requested",
                Some(json!({
                    "approvalId": "1",
                    "params": { "turnId": "turn_1" }
                })),
                1,
            ),
            task_event_record(
                "thread_1",
                "turn_1:completed",
                "turn_completed",
                "Turn completed",
                Some(json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "status": "completed"
                })),
                2,
            ),
            task_event_record(
                "thread_1",
                "thread_status_changed",
                "thread_status_changed",
                "Thread idle",
                Some(json!({ "threadId": "thread_1", "status": "idle" })),
                3,
            ),
        ];

        let task = task_record_from_thread(&thread, &events, None, false).unwrap();
        assert_eq!(task.status, "idle");
    }

    #[test]
    fn task_repository_context_includes_linked_worktrees() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let main_root = temp.path().join("main");
        let linked_root = temp.path().join("linked");
        std::fs::create_dir(&main_root).unwrap();
        git(&main_root, &["init", "-b", "main"]);
        std::fs::create_dir(main_root.join("src")).unwrap();
        std::fs::write(main_root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n").unwrap();
        git(&main_root, &["add", "."]);
        git_commit(&main_root, "Initial commit");
        git(
            &main_root,
            &[
                "worktree",
                "add",
                "-b",
                "feature/review",
                linked_root.to_str().unwrap(),
            ],
        );
        std::fs::create_dir(linked_root.join("nested")).unwrap();

        let fs = RootedFs::new(temp.path()).unwrap();
        let main = resolve_task_cwd(&fs, main_root.to_str().unwrap()).unwrap();
        let main_src = resolve_task_cwd(&fs, main_root.join("src").to_str().unwrap()).unwrap();
        let linked = resolve_task_cwd(&fs, linked_root.join("nested").to_str().unwrap()).unwrap();

        assert_eq!(main.worktree_root, main_src.worktree_root);
        assert_ne!(main.worktree_root, linked.worktree_root);
        assert_eq!(main.repository_common_dir, main_src.repository_common_dir);
        assert_eq!(main.repository_common_dir, linked.repository_common_dir);
        let main_context = main_src.worktree.as_ref().unwrap();
        assert_eq!(main_context.root_path, "main");
        assert_eq!(main_context.repository_root_path, "main");
        assert_eq!(main_context.branch.as_deref(), Some("main"));
        assert_eq!(main_context.relative_cwd, "src");
        assert!(!main_context.linked);
        assert!(!main_context.head_sha.is_empty());
        let linked_context = linked.worktree.as_ref().unwrap();
        assert_eq!(linked_context.root_path, "linked");
        assert_eq!(linked_context.repository_root_path, "main");
        assert_eq!(linked_context.branch.as_deref(), Some("feature/review"));
        assert_eq!(linked_context.relative_cwd, "nested");
        assert!(linked_context.linked);

        let response = json!({
            "data": [
                {
                    "id": "thread_main_root",
                    "cwd": main_root.display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 1.0,
                    "status": { "type": "idle" }
                },
                {
                    "id": "thread_main_src",
                    "cwd": main_root.join("src").display().to_string(),
                    "createdAt": 2.0,
                    "updatedAt": 2.0,
                    "status": { "type": "idle" }
                },
                {
                    "id": "thread_linked",
                    "cwd": linked_root.join("nested").display().to_string(),
                    "createdAt": 3.0,
                    "updatedAt": 3.0,
                    "status": { "type": "idle" }
                }
            ]
        });
        let tasks = thread_list_response(&fs, &response);
        assert_eq!(
            tasks
                .iter()
                .map(|task| task.thread_id.as_str())
                .collect::<Vec<_>>(),
            vec!["thread_linked", "thread_main_src", "thread_main_root"]
        );

        git(&linked_root, &["checkout", "--detach", "HEAD"]);
        let detached = resolve_task_cwd(&fs, linked_root.to_str().unwrap()).unwrap();
        let detached_context = detached.worktree.unwrap();
        assert_eq!(detached_context.branch, None);
        assert!(!detached_context.head_sha.is_empty());
    }

    #[test]
    fn task_worktree_context_is_optional_outside_git_or_rooted_fs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let plain = root.join("plain");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let fs = RootedFs::new(&root).unwrap();

        assert!(!has_git_ancestor(&plain));
        let resolved_plain = resolve_task_cwd(&fs, plain.to_str().unwrap()).unwrap();
        assert_eq!(resolved_plain.logical_cwd.as_deref(), Some("plain"));
        assert_eq!(resolved_plain.worktree, None);
        assert!(resolve_task_cwd(&fs, outside.to_str().unwrap()).is_some());

        if git_is_available() {
            git(&outside, &["init", "-b", "main"]);
            assert!(resolve_task_cwd(&fs, outside.to_str().unwrap()).is_none());
        }
    }

    #[test]
    fn codex_notifications_publish_live_task_status() {
        let (sender, mut receiver) = broadcast::channel(8);
        let live_task_events = LiveTaskEventCache::default();

        handle_codex_notification(
            &sender,
            &live_task_events,
            codex_app_server::decode_notification(
                "turn/started",
                json!({
                    "threadId": "thread_1",
                    "turn": {
                        "id": "turn_1",
                        "status": "inProgress",
                        "startedAt": 1_750_000_000.25
                    }
                }),
            )
            .unwrap(),
        );
        let started = receiver.try_recv().unwrap();
        assert_eq!(started.thread_id, "thread_1");
        assert_eq!(started.event_type, "turn_started");
        assert_eq!(started.created_ms, 1_750_000_000_250);
        assert_eq!(started.payload.unwrap()["turn"]["id"], "turn_1");

        handle_codex_notification(
            &sender,
            &live_task_events,
            codex_app_server::decode_notification(
                "item/started",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "startedAtMs": 1_750_000_001_000_u64,
                    "item": {
                        "id": "command_1",
                        "type": "commandExecution",
                        "command": "cargo test",
                        "cwd": "/tmp/project",
                        "status": "inProgress"
                    }
                }),
            )
            .unwrap(),
        );
        let command_started = receiver.try_recv().unwrap();
        assert_eq!(command_started.event_type, "command_execution");
        assert_eq!(command_started.created_ms, 1_750_000_001_000);
        assert_eq!(
            command_started.payload.as_ref().unwrap()["lifecycle"],
            "started"
        );
        let cached_command = live_task_events
            .for_thread("thread_1")
            .into_iter()
            .find(|event| event.id == command_started.id)
            .expect("notification bridge should cache commands without an SSE consumer");
        assert_eq!(cached_command.event_type, "command_execution");

        handle_codex_notification(
            &sender,
            &live_task_events,
            codex_app_server::decode_notification(
                "item/started",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "startedAtMs": 1_750_000_002_000_u64,
                    "item": {
                        "id": "reasoning_1",
                        "type": "reasoning",
                        "summary": [],
                        "content": []
                    }
                }),
            )
            .unwrap(),
        );
        let reasoning_started = receiver.try_recv().unwrap();
        assert_eq!(reasoning_started.event_type, "work_status");
        assert_eq!(reasoning_started.summary, "Thinking");
        assert_eq!(
            reasoning_started.payload.as_ref().unwrap()["lifecycle"],
            "started"
        );

        handle_codex_notification(
            &sender,
            &live_task_events,
            codex_app_server::decode_notification(
                "item/completed",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "completedAtMs": 1_750_000_003_000_u64,
                    "item": {
                        "id": "reasoning_1",
                        "type": "reasoning",
                        "summary": ["Checked the current behavior."],
                        "content": []
                    }
                }),
            )
            .unwrap(),
        );
        let reasoning_completed = receiver.try_recv().unwrap();
        assert_eq!(reasoning_started.id, reasoning_completed.id);
        assert_eq!(reasoning_completed.event_type, "reasoning");
        assert_eq!(reasoning_completed.created_ms, 1_750_000_002_000);
        assert_eq!(reasoning_completed.updated_ms, Some(1_750_000_003_000));
        assert_eq!(
            reasoning_completed.payload.as_ref().unwrap()["lifecycle"],
            "completed"
        );

        handle_codex_notification(
            &sender,
            &live_task_events,
            codex_app_server::decode_notification(
                "thread/status/changed",
                json!({
                    "threadId": "thread_1",
                    "status": { "type": "active", "activeFlags": [] }
                }),
            )
            .unwrap(),
        );
        let status = receiver.try_recv().unwrap();
        assert_eq!(status.thread_id, "thread_1");
        assert_eq!(status.event_type, "thread_status_changed");
        assert_eq!(status.payload.unwrap()["status"], "running");

        handle_codex_notification(
            &sender,
            &live_task_events,
            codex_app_server::decode_notification(
                "turn/completed",
                json!({
                    "threadId": "thread_1",
                    "turn": {
                        "id": "turn_1",
                        "status": "completed",
                        "completedAt": 1_750_000_004.5
                    }
                }),
            )
            .unwrap(),
        );
        let completed = receiver.try_recv().unwrap();
        assert_eq!(completed.event_type, "turn_completed");
        assert_eq!(completed.created_ms, 1_750_000_004_500);
    }

    #[tokio::test]
    async fn server_requests_store_live_pending_approvals_without_local_task_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        let (sender, mut receiver) = broadcast::channel(4);
        let live_task_events = LiveTaskEventCache::default();
        let pending = Arc::new(AsyncMutex::new(HashMap::new()));

        handle_codex_server_request(
            &sender,
            &live_task_events,
            &pending,
            codex_app_server::decode_server_request(
                json!(11),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "command": "cargo test",
                    "cwd": project_root.join("src").display().to_string(),
                    "reason": "Run tests",
                    "availableDecisions": ["accept", "decline"]
                }),
            )
            .unwrap(),
        )
        .await;

        let approvals = pending.lock().await;
        let approval = approvals.get("11").unwrap();
        assert_eq!(approval.thread_id, "thread_1");
        assert_eq!(approval.params["command"], "cargo test");
        let approval_created_ms = approval.created_ms;
        let approval_sort_index = approval.sort_index;
        drop(approvals);

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.thread_id, "thread_1");
        assert_eq!(event.event_type, "approval_requested");
        assert_eq!(
            event.payload.as_ref().unwrap()["turnId"],
            "turn_1",
            "approval events must remain attached to their causal turn"
        );
        assert_eq!(event.created_ms, approval_created_ms);
        assert_eq!(event.sort_index, approval_sort_index);
        assert_eq!(live_task_events.for_thread("thread_1"), vec![event]);
    }

    #[tokio::test]
    async fn completed_turn_expires_live_pending_approval() {
        let (sender, mut receiver) = broadcast::channel(4);
        let live_task_events = LiveTaskEventCache::default();
        let pending = Arc::new(AsyncMutex::new(HashMap::new()));

        handle_codex_server_request(
            &sender,
            &live_task_events,
            &pending,
            codex_app_server::decode_server_request(
                json!(11),
                "item/commandExecution/requestApproval",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "command": "cargo test",
                    "availableDecisions": ["accept", "decline"]
                }),
            )
            .unwrap(),
        )
        .await;
        let requested = receiver.recv().await.unwrap();
        assert_eq!(requested.event_type, "approval_requested");

        let completed = codex_app_server::decode_notification(
            "turn/completed",
            json!({
                "threadId": "thread_1",
                "turn": {
                    "id": "turn_1",
                    "status": "completed",
                    "completedAt": 1_750_000_004.5
                }
            }),
        )
        .unwrap();
        expire_stale_approvals_for_notification(&sender, &live_task_events, &pending, &completed)
            .await;

        assert!(pending.lock().await.is_empty());
        let resolved = receiver.recv().await.unwrap();
        assert_eq!(resolved.event_type, "approval_resolved");
        assert_eq!(resolved.payload.as_ref().unwrap()["approvalId"], "11");
        assert_eq!(resolved.payload.as_ref().unwrap()["decision"], "expired");
        assert_eq!(
            live_task_events
                .for_thread("thread_1")
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            ["approval_requested", "approval_resolved"]
        );
    }

    fn git_is_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn git(path: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_commit(path: &Path, message: &str) {
        git(
            path,
            &[
                "-c",
                "user.name=Caffold Test",
                "-c",
                "user.email=caffold@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                message,
            ],
        );
    }
}
