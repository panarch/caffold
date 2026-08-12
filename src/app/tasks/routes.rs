use std::{convert::Infallible, path::Path};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path as AxumPath, Query, State},
    http::{HeaderValue, header},
    response::Response,
    routing::{get, post},
};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::sync::broadcast;

#[cfg(test)]
use serde_json::json;

use super::projection::short_thread_id;
use super::{
    ApprovalResolveError, CodexConnection, DetailFrameStream, TaskDetailResponse, TaskEventRecord,
    TaskRecord, TaskState, accepted_user_message_event, now_ms, task_activity_ms,
};
use super::{
    active_sections::{ActiveTaskTopPlacement, ManagedCodexThreadLocation},
    lifecycle::StartTask,
    worktrees::inspect_ready_worktree,
};

use super::generated_images::GeneratedImageError;

use crate::{
    app::error::ApiError,
    codex_app_server::{
        CodexDaemonInfo, CodexPermissionMode, CodexStatusResponse, CodexThreadClient,
        CodexThreadError, CodexTurnOptions, NORMAL_SERVICE_TIER_ID, ThreadStatus,
    },
    codex_thread_sessions::{PromptTarget, ThreadSessionSnapshot, ThreadSessionsDiagnostics},
    fs::MAX_IMAGE_BYTES,
    task_store::{ManagedThread, ManagedWorktree, ManagedWorktreeState, TaskStoreError},
};

const MAX_TASK_IMAGES: usize = 4;
const MAX_TASK_REQUEST_BYTES: usize = 64 * 1024 * 1024;
const TASK_LIST_PAGE_SIZE: usize = 30;
const TASK_CANONICAL_READ_CONCURRENCY: usize = 8;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexRuntimeDiagnostics {
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
    #[serde(default)]
    fast_mode: bool,
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
    #[serde(default)]
    fast_mode: bool,
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDeleteResponse {
    thread_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTaskPlacementUpdate {
    task: TaskRecord,
    placement: ActiveTaskTopPlacement,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskRestoreResponse {
    task: TaskRecord,
    active_top_placement: ActiveTaskTopPlacement,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEventEnvelope {
    thread_id: String,
    revision: u64,
    event: TaskEventRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskListRemoval {
    thread_id: String,
    reason: &'static str,
}

#[derive(Debug, Clone)]
enum TaskListUpdate {
    Task(Box<TaskRecord>),
    Placement(Box<ActiveTaskPlacementUpdate>),
    Refresh,
}

#[derive(Clone)]
pub(super) struct TaskListEvents {
    removals: broadcast::Sender<TaskListRemoval>,
    updates: broadcast::Sender<TaskListUpdate>,
}

impl TaskListEvents {
    pub(super) fn new() -> Self {
        let (removals, _) = broadcast::channel(64);
        let (updates, _) = broadcast::channel(64);
        Self { removals, updates }
    }

    pub(super) fn remove(&self, thread_id: &str, reason: &'static str) {
        let _ = self.removals.send(TaskListRemoval {
            thread_id: thread_id.to_string(),
            reason,
        });
    }

    pub(super) fn update(&self, task: TaskRecord) {
        let _ = self.updates.send(TaskListUpdate::Task(Box::new(task)));
    }

    pub(super) fn place(&self, task: TaskRecord, placement: ActiveTaskTopPlacement) {
        let _ = self.updates.send(TaskListUpdate::Placement(Box::new(
            ActiveTaskPlacementUpdate { task, placement },
        )));
    }

    pub(super) fn refresh(&self) {
        let _ = self.updates.send(TaskListUpdate::Refresh);
    }

    fn subscribe(
        &self,
    ) -> (
        broadcast::Receiver<TaskListRemoval>,
        broadcast::Receiver<TaskListUpdate>,
    ) {
        (self.removals.subscribe(), self.updates.subscribe())
    }
}

#[cfg(test)]
pub(super) async fn test_wait_for_task_list_refresh(events: TaskListEvents) {
    let (_, mut updates) = events.subscribe();
    loop {
        match updates.recv().await {
            Ok(TaskListUpdate::Refresh) => return,
            Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
            Err(broadcast::error::RecvError::Closed) => {
                panic!("Task list update channel closed before a refresh")
            }
        }
    }
}

pub(super) fn router(state: TaskState) -> Router {
    Router::new()
        .route("/api/codex/status", get(codex_status))
        .route("/api/codex/restart", post(codex_restart))
        .route("/api/codex/models", get(codex_models))
        .route("/api/codex/permissions", get(codex_permissions))
        .route(
            "/api/tasks",
            get(list_managed_tasks)
                .post(create_task)
                .layer(DefaultBodyLimit::max(MAX_TASK_REQUEST_BYTES)),
        )
        .route("/api/tasks/archived", get(list_archived_tasks))
        .route("/api/tasks/stream", get(task_list_stream))
        .route(
            "/api/tasks/{thread_id}",
            get(task_detail).delete(task_delete),
        )
        .route(
            "/api/tasks/{thread_id}/seen",
            axum::routing::put(mark_task_seen),
        )
        .route("/api/tasks/{thread_id}/stream", get(task_stream))
        .route(
            "/api/tasks/{thread_id}/generated-images/{item_id}",
            get(task_generated_image),
        )
        .route("/api/tasks/{thread_id}/archive", post(task_archive))
        .route("/api/tasks/{thread_id}/restore", post(task_restore))
        .route(
            "/api/tasks/{thread_id}/recovery/restore",
            post(task_recovery_restore),
        )
        .route(
            "/api/tasks/{thread_id}/recovery/archive",
            post(task_recovery_archive),
        )
        .route(
            "/api/tasks/{thread_id}/recovery/remove",
            post(task_recovery_remove),
        )
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

async fn codex_status(State(state): State<TaskState>) -> Json<CodexStatusPayload> {
    let (status, process_generation, process_connected) =
        state.codex_runtime.status_with_diagnostics().await;
    let diagnostics = CodexRuntimeDiagnostics {
        process_generation,
        process_connected,
        thread_sessions: state.codex_sessions.diagnostics().await,
    };
    Json(CodexStatusPayload {
        status,
        diagnostics,
    })
}

async fn codex_restart(State(state): State<TaskState>) -> Result<Json<CodexDaemonInfo>, ApiError> {
    state
        .codex_runtime
        .restart_daemon()
        .await
        .map(Json)
        .map_err(ApiError::from)
}

async fn codex_models(State(state): State<TaskState>) -> Result<Json<JsonValue>, ApiError> {
    let client = require_codex_thread_client(&state).await?;
    let response = client.list_models(100).await.map_err(ApiError::from)?;
    serde_json::to_value(response)
        .map(Json)
        .map_err(|error| ApiError::CodexThread(error.to_string()))
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

fn codex_reasoning_effort_value(effort: &JsonValue) -> Option<&str> {
    effort
        .get("value")
        .and_then(JsonValue::as_str)
        .or_else(|| effort.get("reasoningEffort").and_then(JsonValue::as_str))
        .or_else(|| effort.as_str())
}

async fn list_managed_tasks(
    State(state): State<TaskState>,
    Query(_query): Query<TasksQuery>,
) -> Result<Json<super::active_sections::ActiveTaskProjection>, ApiError> {
    let connection = require_codex_thread_connection(&state).await?;
    state
        .active_sections
        .load(&connection.client)
        .await
        .map(Json)
}

async fn list_archived_tasks(
    State(state): State<TaskState>,
    Query(query): Query<TasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let (archived, next_cursor) =
        task_store_list_archived(&state, query.cursor.as_deref(), TASK_LIST_PAGE_SIZE).await?;
    let connection = require_codex_thread_connection(&state).await?;
    let reads = stream::iter(archived)
        .map(|managed| {
            let state = state.clone();
            let client = connection.client.clone();
            async move {
                match client.read_thread(&managed.thread_id).await {
                    Ok(thread) => {
                        state
                            .codex_sessions
                            .observe_thread_metadata(thread.clone())
                            .await;
                        let mut task = state.detail.record_from_codex_thread(&thread)?;
                        let activity_ms = task_activity_ms(&task);
                        apply_managed_thread_metadata(&mut task, &managed);
                        Ok::<_, ApiError>((task, activity_ms))
                    }
                    Err(error) if error.is_thread_unavailable() => {
                        let task = unavailable_archived_task(&managed);
                        let activity_ms = task_activity_ms(&task);
                        Ok((task, activity_ms))
                    }
                    Err(error) => Err(error.into()),
                }
            }
        })
        .buffer_unordered(TASK_CANONICAL_READ_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut tasks = reads.into_iter().collect::<Result<Vec<_>, ApiError>>()?;
    for (task, activity_ms) in &tasks {
        task_store_update_archived_observed_recency(&state, &task.thread_id, *activity_ms).await?;
    }
    tasks.sort_by(|(left, _), (right, _)| {
        task_activity_ms(right)
            .cmp(&task_activity_ms(left))
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    let tasks = tasks.into_iter().map(|(task, _)| task).collect();
    Ok(Json(TaskListResponse { tasks, next_cursor }))
}

async fn task_store_list_archived(
    state: &TaskState,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(Vec<ManagedThread>, Option<String>), ApiError> {
    let store = state.task_store.clone();
    let cursor = cursor.map(ToOwned::to_owned);
    tokio::task::spawn_blocking(move || store.list_archived(cursor.as_deref(), limit))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

async fn task_store_get(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.get(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

async fn task_store_get_archived(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.get_archived(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

async fn task_store_worktree_for_thread(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedWorktree>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.worktree_for_thread(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

#[cfg(test)]
async fn task_store_claim(
    state: &TaskState,
    thread: ManagedThread,
) -> Result<ManagedThread, ApiError> {
    let store = state.task_store.clone();
    tokio::task::spawn_blocking(move || store.claim(thread, now_ms()))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

async fn task_store_mark_seen(
    state: &TaskState,
    thread_id: &str,
    canonical_activity_ms: u64,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        store.mark_seen(&thread_id, canonical_activity_ms, now_ms())
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)
}

async fn task_store_update_archived_observed_recency(
    state: &TaskState,
    thread_id: &str,
    canonical_activity_ms: u64,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        store.update_archived_observed_recency(&thread_id, canonical_activity_ms)
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)
}

async fn task_store_update_composer_settings(
    state: &TaskState,
    thread_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    fast_mode: bool,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    let model = model.map(str::to_string);
    let reasoning_effort = reasoning_effort.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        store.update_composer_settings(
            &thread_id,
            model.as_deref(),
            reasoning_effort.as_deref(),
            fast_mode,
        )
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)
}

async fn task_store_archive(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.archive(&thread_id, now_ms()))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

async fn task_store_restore(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.restore(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

async fn task_store_delete_archived(state: &TaskState, thread_id: &str) -> Result<bool, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.delete_archived(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

async fn task_store_delete(state: &TaskState, thread_id: &str) -> Result<bool, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.delete(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

async fn task_store_delete_worktree(
    state: &TaskState,
    worktree_id: &str,
) -> Result<bool, ApiError> {
    let store = state.task_store.clone();
    let worktree_id = worktree_id.to_string();
    tokio::task::spawn_blocking(move || store.delete_worktree(&worktree_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

fn task_store_api_error(error: TaskStoreError) -> ApiError {
    match error {
        TaskStoreError::InvalidCursor => ApiError::BadRequest {
            code: "task_cursor_invalid",
            message: error.to_string(),
        },
        error => ApiError::Internal(error.to_string()),
    }
}

fn task_store_join_error(error: tokio::task::JoinError) -> ApiError {
    ApiError::Internal(format!("task store worker failed: {error}"))
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
        request.fast_mode,
        request.permission_mode,
    )
    .await?;

    let started = state
        .lifecycle
        .start_task(
            &connection,
            StartTask {
                cwd,
                prompt,
                images,
                turn_options,
                initial_name: None,
            },
        )
        .await?;
    let mut detail = state
        .detail
        .read(&connection, &started.task.thread_id, None)
        .await?;
    detail.active_top_placement = Some(started.placement);
    Ok(Json(detail))
}

async fn task_detail(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<TaskDetailQuery>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    state
        .detail
        .get(&thread_id, query.cursor.as_deref())
        .await
        .map(Json)
}

async fn task_generated_image(
    State(state): State<TaskState>,
    AxumPath((thread_id, item_id)): AxumPath<(String, String)>,
) -> Result<Response, ApiError> {
    let bytes = state
        .task_events
        .generated_images()
        .load(&thread_id, &item_id)
        .await
        .map_err(|error| generated_image_api_error(error, &thread_id, &item_id))?;
    let mut response = Response::new(Body::from(bytes));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

fn generated_image_api_error(
    error: GeneratedImageError,
    thread_id: &str,
    item_id: &str,
) -> ApiError {
    let message = match error {
        GeneratedImageError::NotFound => {
            format!("generated image was not found for task {thread_id}: {item_id}")
        }
        GeneratedImageError::Unavailable => {
            format!("generated image is no longer available for task {thread_id}: {item_id}")
        }
    };
    ApiError::NotFound {
        code: "generated_image_unavailable",
        message,
    }
}

async fn mark_task_seen(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    if task_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let client = require_codex_thread_client(&state).await?;
    let thread = client.read_thread(&thread_id).await?;
    state
        .codex_sessions
        .observe_thread_metadata(thread.clone())
        .await;
    let mut task = state.detail.record_from_codex_thread(&thread)?;
    let activity_ms = task_activity_ms(&task);
    let Some(managed) = task_store_mark_seen(&state, &thread_id, activity_ms).await? else {
        return Err(task_not_managed_error());
    };
    apply_managed_thread_metadata(&mut task, &managed);
    notify_task_updated(&state, task.clone());
    Ok(Json(task))
}

fn task_not_managed_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_not_managed",
        message: "task is not managed by Caffold".to_string(),
    }
}

fn notify_task_updated(state: &TaskState, task: TaskRecord) {
    state.task_list_events.update(task);
}

async fn task_stream(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(_query): Query<TasksQuery>,
) -> Result<Response, ApiError> {
    let stream: DetailFrameStream = state.detail.stream(&thread_id).await?;
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
    let sync_receiver = state.task_sync.subscribe_updates();
    let (removal_receiver, update_receiver) = state.task_list_events.subscribe();
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
                            Ok(TaskListUpdate::Task(task)) if thread_id.as_ref().is_none_or(|id| id == &task.thread_id) => {
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
                            Ok(TaskListUpdate::Placement(update)) if thread_id.is_none() => {
                                let payload = serde_json::to_string(&update)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-placed-at-top\ndata: {payload}\n\n");
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
                            Ok(TaskListUpdate::Refresh) if thread_id.is_none() => {
                                let frame = "event: task-list-refresh\ndata: {}\n\n";
                                return Some((
                                    Ok::<_, Infallible>(Bytes::from_static(frame.as_bytes())),
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
    let managed = task_store_get(&state, &thread_id)
        .await?
        .ok_or_else(task_not_managed_error)?;
    let managed_worktree = task_store_worktree_for_thread(&state, &thread_id).await?;
    let managed_cwd = managed_prompt_cwd(managed_worktree.as_ref())?;
    let (prompt, images) = normalize_task_input(&request.prompt, request.images)?;
    let _requested_active_turn_id = request.active_turn_id;
    let connection = require_codex_thread_connection(&state).await?;
    let requested_model = request.model;
    let requested_effort = request.effort;
    let requested_fast_mode = request.fast_mode;
    let requested_permission_mode = request.permission_mode;
    state
        .codex_sessions
        .restore_managed_fast_mode(&thread_id, managed.fast_mode)
        .await;
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
    if let Some(managed_cwd) = managed_cwd.as_deref() {
        target = managed_prompt_target(
            target,
            managed_cwd,
            state.codex_sessions.snapshot(&thread_id).await.as_ref(),
        )?;
    }
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
                    requested_fast_mode,
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
                if let Some(managed_cwd) = managed_cwd.as_deref() {
                    target = managed_prompt_target(
                        target,
                        managed_cwd,
                        state.codex_sessions.snapshot(&thread_id).await.as_ref(),
                    )?;
                }
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
                managed_cwd.as_deref(),
                turn,
                applied_options.clone(),
            )
            .await;
        if let Some(snapshot) = state.codex_sessions.snapshot(&thread_id).await {
            let persistence_result = task_store_update_composer_settings(
                &state,
                &thread_id,
                snapshot.model.as_deref(),
                snapshot.reasoning_effort.as_deref(),
                snapshot.fast_mode,
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

fn managed_prompt_cwd(worktree: Option<&ManagedWorktree>) -> Result<Option<String>, ApiError> {
    let Some(worktree) = worktree else {
        return Ok(None);
    };
    match worktree.state {
        ManagedWorktreeState::Ready => {
            inspect_ready_worktree(worktree).map_err(|error| ApiError::BadRequest {
                code: "managed_worktree_unavailable",
                message: format!(
                    "the managed worktree is unavailable at {}: {error}",
                    worktree.worktree_path
                ),
            })?;
            Ok(Some(worktree.worktree_path.clone()))
        }
        ManagedWorktreeState::Creating
        | ManagedWorktreeState::IsolatingClean
        | ManagedWorktreeState::HandingOff
        | ManagedWorktreeState::Transferring => Err(ApiError::BadRequest {
            code: "worktree_transfer_in_progress",
            message: "the task worktree transfer is still in progress; retry after it finishes"
                .to_string(),
        }),
        ManagedWorktreeState::CleanRecoveryRequired
        | ManagedWorktreeState::HandoffRecoveryRequired
        | ManagedWorktreeState::RecoveryRequired => Err(ApiError::BadRequest {
            code: "worktree_transfer_recovery_required",
            message: format!(
                "the task worktree transfer requires recovery; keep the source and target checkouts intact and preserve refs/caffold/transfers/{} if it exists",
                worktree.worktree_id
            ),
        }),
        state => Err(ApiError::BadRequest {
            code: "managed_worktree_unavailable",
            message: format!(
                "the managed worktree is unavailable while it is {}",
                state.as_str()
            ),
        }),
    }
}

fn managed_prompt_target(
    target: PromptTarget,
    managed_cwd: &str,
    snapshot: Option<&ThreadSessionSnapshot>,
) -> Result<PromptTarget, ApiError> {
    match target {
        PromptTarget::Start { .. } => Ok(PromptTarget::Start {
            cwd: managed_cwd.to_string(),
        }),
        PromptTarget::Steer { turn_id }
            if snapshot
                .and_then(|snapshot| snapshot.active_turn_cwd.as_deref())
                .is_some_and(|cwd| same_directory(cwd, managed_cwd)) =>
        {
            Ok(PromptTarget::Steer { turn_id })
        }
        PromptTarget::Steer { .. } => Err(ApiError::BadRequest {
            code: "worktree_transfer_finishing",
            message: "the isolation turn is still finishing in the original checkout; retry after it completes"
                .to_string(),
        }),
    }
}

fn same_directory(left: &str, right: &str) -> bool {
    match (
        Path::new(left).canonicalize().ok(),
        Path::new(right).canonicalize().ok(),
    ) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

async fn task_interrupt(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(_query): Query<TasksQuery>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let managed = task_store_get(&state, &thread_id)
        .await?
        .ok_or_else(task_not_managed_error)?;
    state
        .codex_sessions
        .restore_managed_fast_mode(&thread_id, managed.fast_mode)
        .await;
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
        state.detail.read(&connection, &thread_id, None).await?,
    ))
}

async fn task_archive(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    if task_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let connection = require_codex_thread_connection(&state).await?;
    let thread = connection.client.read_thread(&thread_id).await?;
    if matches!(thread.status, ThreadStatus::Active { .. }) {
        return Err(ApiError::BadRequest {
            code: "task_active",
            message: "active tasks cannot be archived".to_string(),
        });
    }
    let task = state.detail.record_from_codex_thread(&thread)?;
    let worktree = state.lifecycle.archive_worktree(thread_id.clone()).await?;
    if let Err(error) = connection.client.archive_thread(&thread_id).await {
        state
            .lifecycle
            .rollback_archived_worktree(&thread_id, &worktree)
            .await;
        return Err(error.into());
    }
    match task_store_archive(&state, &thread_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            rollback_task_archive(&state, &connection.client, &thread_id, &worktree).await;
            return Err(task_not_managed_error());
        }
        Err(error) => {
            rollback_task_archive(&state, &connection.client, &thread_id, &worktree).await;
            return Err(error);
        }
    }
    notify_task_removed(&state, &thread_id, "archived");
    Ok(Json(task))
}

async fn task_recovery_restore(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRestoreResponse>, ApiError> {
    let Some(managed) = task_store_get(&state, &thread_id).await? else {
        return Err(task_not_managed_error());
    };
    let connection = require_codex_thread_connection(&state).await?;
    let (thread, unarchived) = match state
        .active_sections
        .locate_thread(&connection.client, &thread_id)
        .await?
    {
        ManagedCodexThreadLocation::Active(thread) => (thread, false),
        ManagedCodexThreadLocation::Archived(_) => {
            (connection.client.unarchive_thread(&thread_id).await?, true)
        }
        ManagedCodexThreadLocation::Missing => return Err(task_recovery_changed_error()),
    };
    state.codex_sessions.forget_thread(&thread_id).await;
    state
        .codex_sessions
        .observe_thread_metadata(thread.clone())
        .await;
    let mut task = state.detail.record_from_codex_thread(&thread)?;
    apply_managed_thread_metadata(&mut task, &managed);
    let placement = match state
        .active_sections
        .place_at_top(&connection.client, &task)
        .await
    {
        Ok(placement) => placement,
        Err(error) => {
            if unarchived
                && let Err(rollback_error) = connection.client.archive_thread(&thread_id).await
            {
                eprintln!(
                    "failed to re-archive Codex thread while rolling back recovery restore: {rollback_error}"
                );
            }
            if unarchived {
                state.codex_sessions.forget_thread(&thread_id).await;
            }
            return Err(error);
        }
    };
    state
        .task_list_events
        .place(task.clone(), placement.clone());
    Ok(Json(TaskRestoreResponse {
        task,
        active_top_placement: placement,
    }))
}

async fn task_recovery_archive(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    let Some(managed) = task_store_get(&state, &thread_id).await? else {
        return Err(task_not_managed_error());
    };
    let connection = require_codex_thread_connection(&state).await?;
    let thread = match state
        .active_sections
        .locate_thread(&connection.client, &thread_id)
        .await?
    {
        ManagedCodexThreadLocation::Archived(thread) => thread,
        ManagedCodexThreadLocation::Active(_) | ManagedCodexThreadLocation::Missing => {
            return Err(task_recovery_changed_error());
        }
    };
    let mut task = state.detail.record_from_codex_thread(&thread)?;
    apply_managed_thread_metadata(&mut task, &managed);
    task.conversation_available = false;
    let worktree = state.lifecycle.archive_worktree(thread_id.clone()).await?;
    match task_store_archive(&state, &thread_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            state
                .lifecycle
                .rollback_archived_worktree(&thread_id, &worktree)
                .await;
            return Err(task_not_managed_error());
        }
        Err(error) => {
            state
                .lifecycle
                .rollback_archived_worktree(&thread_id, &worktree)
                .await;
            return Err(error);
        }
    }
    state.codex_sessions.forget_thread(&thread_id).await;
    notify_task_removed(&state, &thread_id, "archived");
    Ok(Json(task))
}

async fn task_recovery_remove(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskDeleteResponse>, ApiError> {
    if task_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let connection = require_codex_thread_connection(&state).await?;
    if !matches!(
        state
            .active_sections
            .locate_thread(&connection.client, &thread_id)
            .await?,
        ManagedCodexThreadLocation::Missing
    ) {
        return Err(task_recovery_changed_error());
    }

    let worktree = task_store_worktree_for_thread(&state, &thread_id).await?;
    let archived_worktree = state.lifecycle.archive_worktree(thread_id.clone()).await?;
    match task_store_delete(&state, &thread_id).await {
        Ok(true) => {}
        Ok(false) => {
            state
                .lifecycle
                .rollback_archived_worktree(&thread_id, &archived_worktree)
                .await;
            return Err(task_not_managed_error());
        }
        Err(error) => {
            state
                .lifecycle
                .rollback_archived_worktree(&thread_id, &archived_worktree)
                .await;
            return Err(error);
        }
    }
    state.lifecycle.delete_task_resources(&thread_id).await;
    if let Some(worktree) = worktree {
        task_store_delete_worktree(&state, &worktree.worktree_id).await?;
    }
    notify_task_removed(&state, &thread_id, "deleted");
    Ok(Json(TaskDeleteResponse { thread_id }))
}

async fn task_restore(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRestoreResponse>, ApiError> {
    let Some(archived) = task_store_get_archived(&state, &thread_id).await? else {
        return Err(task_not_archived_error());
    };
    let connection = require_codex_thread_connection(&state).await?;
    let worktree = state.lifecycle.restore_worktree(thread_id.clone()).await?;
    let thread = match connection.client.unarchive_thread(&thread_id).await {
        Ok(thread) => thread,
        Err(error) => {
            state
                .lifecycle
                .rollback_restored_worktree(&thread_id, &worktree)
                .await;
            return Err(error.into());
        }
    };
    state
        .codex_sessions
        .observe_thread_metadata(thread.clone())
        .await;
    let mut task = state.detail.record_from_codex_thread(&thread)?;
    apply_managed_thread_metadata(&mut task, &archived);
    let placement = match state
        .lifecycle
        .place_active_task(&connection.client, &task)
        .await
    {
        Ok(placement) => placement,
        Err(error) => {
            rollback_task_restore(&state, &connection.client, &thread_id, &worktree).await;
            return Err(error);
        }
    };
    match task_store_restore(&state, &thread_id).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            rollback_task_restore(&state, &connection.client, &thread_id, &worktree).await;
            return Err(task_not_archived_error());
        }
        Err(error) => {
            rollback_task_restore(&state, &connection.client, &thread_id, &worktree).await;
            return Err(error);
        }
    }
    state
        .task_list_events
        .place(task.clone(), placement.clone());
    Ok(Json(TaskRestoreResponse {
        task,
        active_top_placement: placement,
    }))
}

async fn task_delete(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskDeleteResponse>, ApiError> {
    if task_store_get_archived(&state, &thread_id).await?.is_none() {
        return Err(task_not_archived_error());
    }
    let worktree = task_store_worktree_for_thread(&state, &thread_id).await?;
    if let Some(worktree) = &worktree
        && worktree.state != ManagedWorktreeState::Archived
    {
        return Err(ApiError::BadRequest {
            code: "task_not_archived",
            message: "managed worktree is not archived".to_string(),
        });
    }

    let connection = require_codex_thread_connection(&state).await?;
    connection.client.delete_thread(&thread_id).await?;
    state.lifecycle.delete_task_resources(&thread_id).await;
    if let Some(worktree) = worktree {
        task_store_delete_worktree(&state, &worktree.worktree_id).await?;
    }
    task_store_delete_archived(&state, &thread_id).await?;
    notify_task_removed(&state, &thread_id, "deleted");

    Ok(Json(TaskDeleteResponse { thread_id }))
}

async fn rollback_task_archive(
    state: &TaskState,
    client: &CodexThreadClient,
    thread_id: &str,
    worktree: &super::worktrees::ArchiveOutcome,
) {
    if let Err(error) = client.unarchive_thread(thread_id).await {
        eprintln!("failed to unarchive Codex thread while rolling back archive: {error}");
    }
    state
        .lifecycle
        .rollback_archived_worktree(thread_id, worktree)
        .await;
}

async fn rollback_task_restore(
    state: &TaskState,
    client: &CodexThreadClient,
    thread_id: &str,
    worktree: &super::worktrees::RestoreOutcome,
) {
    if let Err(error) = client.archive_thread(thread_id).await {
        eprintln!("failed to archive Codex thread while rolling back restore: {error}");
    }
    state
        .lifecycle
        .rollback_restored_worktree(thread_id, worktree)
        .await;
}

fn notify_task_removed(state: &TaskState, thread_id: &str, reason: &'static str) {
    state.task_list_events.remove(thread_id, reason);
}

fn unavailable_archived_task(managed: &ManagedThread) -> TaskRecord {
    let activity_ms = managed
        .last_observed_recency_ms
        .or(managed.archived_at_ms)
        .unwrap_or(managed.claimed_at_ms);
    TaskRecord {
        id: managed.thread_id.clone(),
        thread_id: managed.thread_id.clone(),
        conversation_available: false,
        title: format!("Thread {}", short_thread_id(&managed.thread_id)),
        preview: "Conversation unavailable".to_string(),
        thread_status: ThreadStatus::NotLoaded,
        latest_turn_status: None,
        active_turn: None,
        cwd: String::new(),
        cwd_path: None,
        relative_cwd: String::new(),
        worktree: None,
        created_ms: managed.claimed_at_ms,
        updated_ms: activity_ms,
        recency_ms: Some(activity_ms),
        last_completed_ms: managed.last_completed_at_ms,
        last_event_summary: Some("Conversation unavailable".to_string()),
        unseen: false,
    }
}

fn task_not_archived_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_not_archived",
        message: "thread is not archived in Caffold".to_string(),
    }
}

fn task_recovery_changed_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_recovery_changed",
        message: "Task recovery state changed; recheck the Task before trying again".to_string(),
    }
}

async fn task_approval(
    State(state): State<TaskState>,
    AxumPath((thread_id, approval_id)): AxumPath<(String, String)>,
    Query(_query): Query<TasksQuery>,
    Json(request): Json<TaskApprovalRequest>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    if task_store_get(&state, &thread_id).await?.is_none() {
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
        state.detail.read(&connection, &thread_id, None).await?,
    ))
}

async fn require_codex_thread_client(state: &TaskState) -> Result<CodexThreadClient, ApiError> {
    state.detail.client().await
}

async fn require_codex_thread_connection(
    state: &TaskState,
) -> Result<CodexConnection, CodexThreadError> {
    state.detail.connection().await
}

#[cfg(test)]
fn managed_thread_from_task_record(
    task: &TaskRecord,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: bool,
) -> ManagedThread {
    let mut managed = ManagedThread::new(
        task.thread_id.clone(),
        Some(task_activity_ms(task)),
        model,
        reasoning_effort,
    );
    managed.fast_mode = fast_mode;
    managed.last_completed_at_ms = task.last_completed_ms;
    managed
}

fn apply_managed_thread_metadata(task: &mut TaskRecord, managed: &ManagedThread) {
    task.last_completed_ms = managed.last_completed_at_ms;
    task.unseen = managed.unseen();
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
    fast_mode: bool,
    permission_mode: Option<CodexPermissionMode>,
) -> Result<CodexTurnOptions, ApiError> {
    let model = normalize_codex_model(model)?;
    let effort = normalize_codex_effort(effort)?;
    if model.is_none() && effort.is_none() && !fast_mode {
        return Ok(CodexTurnOptions {
            model,
            effort,
            service_tier: Some(NORMAL_SERVICE_TIER_ID.to_string()),
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

    let normal_service_tier = selected_model
        .default_service_tier
        .clone()
        .unwrap_or_else(|| NORMAL_SERVICE_TIER_ID.to_string());
    let service_tier = Some(
        fast_mode
            .then(|| selected_model.fast_service_tier_id().map(str::to_string))
            .flatten()
            .unwrap_or(normal_service_tier),
    );

    Ok(CodexTurnOptions {
        model,
        effort,
        service_tier,
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
pub(super) async fn test_task_detail(
    state: TaskState,
    thread_id: String,
    cursor: Option<String>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    task_detail(
        State(state),
        AxumPath(thread_id),
        Query(TaskDetailQuery { cursor }),
    )
    .await
}

#[cfg(test)]
pub(super) async fn test_task_stream(
    state: TaskState,
    thread_id: String,
) -> Result<Response, ApiError> {
    task_stream(
        State(state),
        AxumPath(thread_id),
        Query(TasksQuery { cursor: None }),
    )
    .await
}

#[cfg(test)]
pub(super) async fn test_claim_task(state: &TaskState, task: &TaskRecord) -> Result<(), ApiError> {
    task_store_claim(
        state,
        managed_thread_from_task_record(task, None, None, false),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
pub(super) async fn test_store_get(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    task_store_get(state, thread_id).await
}

#[cfg(test)]
pub(super) async fn test_store_update_composer_settings(
    state: &TaskState,
    thread_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    fast_mode: bool,
) -> Result<Option<ManagedThread>, ApiError> {
    task_store_update_composer_settings(state, thread_id, model, reasoning_effort, fast_mode).await
}

#[cfg(test)]
mod tests;
