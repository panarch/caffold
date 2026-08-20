mod codex;
mod commands;
mod conversation;
mod list;
mod membership;
mod store;

use codex::*;
use commands::*;
use conversation::*;
use list::*;
use membership::*;
use store::*;

use std::{collections::VecDeque, convert::Infallible, path::Path};

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

use super::{
    ApprovalResolveError, CodexConnection, DetailFrameStream, TaskDetailResponse, TaskDetailSync,
    TaskRecord, TaskState, accepted_user_message_event, now_ms, task_activity_ms,
};
use super::{
    lifecycle::{ActiveTaskTopPlacement, StartTask},
    recovery::{ActiveTaskRecovery, ActiveTaskRecoveryReason, ManagedCodexThreadLocation},
    worktrees::inspect_ready_worktree,
};

use super::generated_images::GeneratedImageError;

use crate::{
    agent::{
        ApprovalDecision, Conversation,
        codex::{
            CodexDaemonInfo, CodexPermissionMode, CodexStatusResponse, CodexThreadClient,
            CodexThreadError, CodexTurnOptions, NORMAL_SERVICE_TIER_ID, ThreadStatus,
        },
    },
    app::error::ApiError,
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
    usage: super::runtime::CodexUsageDiagnostics,
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
    started_turn: Option<(crate::agent::codex::CodexTurn, CodexTurnOptions)>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TaskApprovalRequest {
    /// One of the decisions the approval request offered.
    ///
    /// How far a grant reaches is part of the decision rather than a separate
    /// field, because each agent decides for itself what allowing something
    /// always covers.
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskReorderRequest {
    before_thread_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskReorderResponse {
    thread_id: String,
    before_thread_id: Option<String>,
    changed: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SectionReorderRequest {
    before_section_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SectionReorderResponse {
    section_id: String,
    before_section_id: Option<String>,
    changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTaskPlacementUpdate {
    task: TaskRecord,
    placement: ActiveTaskTopPlacement,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActiveTaskSectionComposerSettingsUpdate {
    section_id: String,
    composer_settings: super::active_list::ActiveTaskComposerSettings,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskRestoreResponse {
    task: TaskRecord,
    active_top_placement: ActiveTaskTopPlacement,
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
    SectionComposerSettings(Box<ActiveTaskSectionComposerSettingsUpdate>),
    Refresh,
}

#[derive(Clone)]
pub(super) struct TaskListEvents {
    removals: broadcast::Sender<TaskListRemoval>,
    updates: broadcast::Sender<TaskListUpdate>,
    #[cfg(test)]
    refresh_count: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl TaskListEvents {
    pub(super) fn new() -> Self {
        let (removals, _) = broadcast::channel(64);
        let (updates, _) = broadcast::channel(64);
        Self {
            removals,
            updates,
            #[cfg(test)]
            refresh_count: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
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

    pub(super) fn section_composer_settings(&self, section: &crate::task_store::ManagedSection) {
        let Some(settings) = section.last_composer_settings.as_ref() else {
            return;
        };
        let _ = self
            .updates
            .send(TaskListUpdate::SectionComposerSettings(Box::new(
                ActiveTaskSectionComposerSettingsUpdate {
                    section_id: section.section_id.clone(),
                    composer_settings: settings.into(),
                },
            )));
    }

    pub(super) fn refresh(&self) {
        #[cfg(test)]
        self.refresh_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = self.updates.send(TaskListUpdate::Refresh);
    }

    #[cfg(test)]
    pub(super) fn refresh_count(&self) -> usize {
        self.refresh_count
            .load(std::sync::atomic::Ordering::Relaxed)
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
        .merge(super::push::router())
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
        .route("/api/tasks/{thread_id}/reorder", post(task_reorder))
        .route(
            "/api/tasks/sections/{section_id}/reorder",
            post(section_reorder),
        )
        .route(
            "/api/tasks/{thread_id}/recovery/recheck",
            post(task_recovery_recheck),
        )
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
pub(super) mod test_support {
    use serde_json::json;

    use super::*;
    use crate::task_store::ManagedSection;

    pub(super) fn recovery_location_responses(
        archived_threads: Vec<JsonValue>,
    ) -> Vec<crate::agent::codex::MockCodexResponse> {
        vec![
            crate::agent::codex::MockCodexResponse::ok_for(
                "thread/list",
                json!({
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                }),
                json!({
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null,
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok_for(
                "thread/list",
                json!({
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": true,
                    "useStateDbOnly": true,
                }),
                json!({
                    "data": archived_threads,
                    "nextCursor": null,
                    "backwardsCursor": null,
                }),
            ),
        ]
    }

    pub(super) fn active_recovery_location_responses(
        active_threads: Vec<JsonValue>,
    ) -> Vec<crate::agent::codex::MockCodexResponse> {
        vec![crate::agent::codex::MockCodexResponse::ok_for(
            "thread/list",
            json!({
                "limit": 100,
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "archived": false,
                "useStateDbOnly": true,
            }),
            json!({
                "data": active_threads,
                "nextCursor": null,
                "backwardsCursor": null,
            }),
        )]
    }

    pub(super) fn projected_active_tasks(
        projection: &super::super::active_list::ActiveTaskProjection,
    ) -> Vec<&TaskRecord> {
        projection
            .sections
            .iter()
            .flat_map(|section| section.tasks.iter())
            .chain(projection.unsectioned.iter().map(|recovery| &recovery.task))
            .collect()
    }

    pub(super) fn claim_cached_active(
        state: &TaskState,
        thread_id: &str,
        display_name: &str,
        recency_ms: u64,
        section_id: &str,
        logical_path: &str,
    ) {
        state
            .task_store
            .transaction(|tables| {
                let section = ManagedSection {
                    section_id: section_id.to_string(),
                    logical_path: logical_path.to_string(),
                    position: 0,
                    last_composer_settings: None,
                };
                tables.upsert_managed_section(&section)?;
                tables.claim_managed_thread_at_top(
                    ManagedThread::new(thread_id, Some(recency_ms), None, None),
                    display_name,
                    &section.section_id,
                    recency_ms,
                )
            })
            .unwrap();
    }

    pub(super) fn seed_section(state: &TaskState, section_id: &str, logical_path: &str) {
        state
            .task_store
            .transaction(|tables| {
                tables.upsert_managed_section(&ManagedSection {
                    section_id: section_id.to_string(),
                    logical_path: logical_path.to_string(),
                    position: 0,
                    last_composer_settings: None,
                })
            })
            .unwrap();
    }

    pub(super) fn cached_projection_rows(
        state: &TaskState,
    ) -> (Vec<ManagedSection>, Vec<ManagedThread>) {
        state
            .task_store
            .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
            .unwrap()
    }

    pub(super) fn current_model_list_response() -> JsonValue {
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
                    "serviceTiers": [{
                        "id": "priority",
                        "name": "Fast",
                        "description": "1.5x speed, increased usage"
                    }],
                    "defaultServiceTier": null,
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
                    "serviceTiers": [{
                        "id": "priority",
                        "name": "Fast",
                        "description": "1.5x speed, increased usage"
                    }],
                    "defaultServiceTier": null,
                    "inputModalities": ["text", "image"],
                    "supportsPersonality": true,
                    "isDefault": false
                },
                {
                    "id": "gpt-5.4-mini",
                    "model": "gpt-5.4-mini",
                    "displayName": "GPT-5.4 Mini",
                    "description": "Fast model without a service tier override.",
                    "hidden": false,
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Fast responses" }
                    ],
                    "defaultReasoningEffort": "low",
                    "serviceTiers": [],
                    "defaultServiceTier": null,
                    "inputModalities": ["text"],
                    "supportsPersonality": false,
                    "isDefault": false
                }
            ],
            "nextCursor": null
        })
    }

    pub(super) fn initialize_git_repository(path: &std::path::Path) {
        std::fs::create_dir_all(path).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Caffold Test"],
        ] {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(path)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        std::fs::write(path.join("README.md"), "initial\n").unwrap();
        for args in [vec!["add", "README.md"], vec!["commit", "-m", "Initial"]] {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(path)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
    }

    pub(super) fn git_branch_exists(path: &std::path::Path, branch_name: &str) -> bool {
        std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(["show-ref", "--verify", &format!("refs/heads/{branch_name}")])
            .output()
            .unwrap()
            .status
            .success()
    }
}
