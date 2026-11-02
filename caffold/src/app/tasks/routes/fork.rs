//! HTTP ownership for previewing and forking provider conversations.
//!
//! Both the managed-Task and external-ID routes resolve their source and target
//! here, then hand the provider mutation to the Task lifecycle. Preview remains
//! read-only; a Task is claimed only after the provider returns a child.

use axum::extract::Path as AxumPath;

use crate::agent::{ItemKind, ThreadStatus, TurnPage};
use crate::app::error::ApiError;
use crate::app::tasks::TaskState;
use crate::app::tasks::lifecycle::{ForkTask, ForkTaskSource};
use crate::task_store::{ManagedSection, ManagedThread, RunBy, TaskProvider};
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::CreatedTaskResponse;
use super::commands::new_task_agent;
use super::membership::task_store_join_error;
use super::store::{task_store_api_error, task_store_get};
use crate::app::tasks::presence::moved_refusal;
use crate::app::tasks::projection;

const TASK_FORK_PREVIEW_MESSAGES: usize = 12;
const CODEX_THREAD_URI_PREFIX: &str = "codex://threads/";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskForkSourceRequest {
    provider: String,
    source_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskForkRequest {
    provider: String,
    source_id: String,
    section_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskForkSourcePreview {
    provider: &'static str,
    source_id: String,
    display_name: String,
    summary: Option<String>,
    status: ThreadStatus,
    cwd: Option<String>,
    last_activity_ms: Option<u64>,
    recent_history: Vec<TaskForkPreviewMessage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskForkPreviewMessage {
    role: &'static str,
    text: String,
}

pub(super) fn routes() -> Router<TaskState> {
    Router::new()
        .route("/api/task-forks/preview", post(preview_task_fork_source))
        .route("/api/task-forks", post(create_task_fork))
        .route("/api/tasks/{thread_id}/fork", post(fork_task))
}

async fn fork_task(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<CreatedTaskResponse>, ApiError> {
    tokio::spawn(fork_task_owned(state, thread_id))
        .await
        .map_err(|error| ApiError::Internal(format!("Task fork failed: {error}")))?
}

async fn fork_task_owned(
    state: TaskState,
    thread_id: String,
) -> Result<Json<CreatedTaskResponse>, ApiError> {
    let (source, section) = fork_source_context(&state, &thread_id).await?;
    if matches!(source.run_by, RunBy::Antigravity { .. }) {
        return Err(ApiError::BadRequest {
            code: "task_fork_unsupported_provider",
            message: "Antigravity conversation fork is not supported".to_string(),
        });
    }
    let cwd = state
        .fs
        .absolute_directory_path(&section.logical_path)
        .map_err(|error| ApiError::Conflict {
            code: "task_fork_project_unavailable",
            message: format!("the source Task project root is unavailable: {error}"),
        })?
        .display()
        .to_string();
    let agent = new_task_agent(&state, Some(provider_name(source.run_by.provider())), &cwd).await?;
    let created = state
        .lifecycle
        .fork_task(
            &agent,
            ForkTask {
                source: ForkTaskSource::Managed(Box::new(source)),
                section,
                cwd,
            },
        )
        .await?;
    let detail = state
        .detail
        .read(&agent, &created.task.thread_id, None)
        .await
        .map_err(|error| fork_created_but_unreadable(&created.task.thread_id, error))?;
    Ok(Json(CreatedTaskResponse {
        detail,
        active_task: created.active_task,
        active_top_placement: created.placement,
    }))
}

async fn preview_task_fork_source(
    State(state): State<TaskState>,
    Json(request): Json<TaskForkSourceRequest>,
) -> Result<Json<TaskForkSourcePreview>, ApiError> {
    let source_id = task_fork_source_id(&request.provider, &request.source_id)?;
    ensure_task_fork_source_provider(&state, &source_id, &request.provider).await?;
    let agent = new_task_agent(&state, Some(request.provider.trim()), "").await?;
    let source = agent
        .driver()
        .read_fork_source(&source_id, true, true)
        .await
        .map_err(task_fork_source_read_error)?;
    if source.conversation.id != source_id {
        return Err(ApiError::BadRequest {
            code: "task_fork_source_mismatch",
            message: "The agent returned a different source conversation".into(),
        });
    }
    let conversation = source.conversation;
    let history = source.turns_page.unwrap_or_default();

    Ok(Json(TaskForkSourcePreview {
        provider: provider_name(agent.run_by("").provider()),
        source_id,
        display_name: projection::conversation_display_name(&conversation),
        summary: non_empty_fork_metadata(&conversation.preview),
        status: conversation.status,
        cwd: non_empty_fork_metadata(&conversation.cwd),
        last_activity_ms: conversation
            .recency_at_ms
            .filter(|value| *value > 0)
            .or((conversation.updated_at_ms > 0).then_some(conversation.updated_at_ms)),
        recent_history: task_fork_preview_history(&history),
    }))
}

async fn create_task_fork(
    State(state): State<TaskState>,
    Json(request): Json<CreateTaskForkRequest>,
) -> Result<Json<CreatedTaskResponse>, ApiError> {
    tokio::spawn(create_task_fork_owned(state, request))
        .await
        .map_err(|error| ApiError::Internal(format!("Task fork failed: {error}")))?
}

async fn create_task_fork_owned(
    state: TaskState,
    request: CreateTaskForkRequest,
) -> Result<Json<CreatedTaskResponse>, ApiError> {
    let source_id = task_fork_source_id(&request.provider, &request.source_id)?;
    let (section, cwd) = task_fork_target_context(&state, &request.section_id).await?;
    ensure_task_fork_source_provider(&state, &source_id, &request.provider).await?;
    let mut owner = task_store_get(&state, &source_id).await?;
    if request.provider.trim() == "grok" {
        // A Task may have moved onto a different native ID. Lock its deletion
        // owner even when this request names an older session it owns.
        let store = state.task_store.clone();
        let managed = tokio::task::spawn_blocking(move || {
            store.read(|tables| tables.active_managed_threads())
        })
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)?;
        for task in managed
            .into_iter()
            .filter(|task| task.run_by.provider() == TaskProvider::Grok)
        {
            if state
                .task_runtime
                .grok()
                .owns_fork_source(&task.thread_id, &source_id)
                .await
                .map_err(crate::agent::AgentError::from)?
            {
                owner = Some(task);
                break;
            }
        }
    }
    let source = ForkTaskSource::External {
        thread_id: source_id,
        owner: owner.map(Box::new),
    };
    let agent = new_task_agent(&state, Some(request.provider.trim()), &cwd).await?;
    let created = state
        .lifecycle
        .fork_task(
            &agent,
            ForkTask {
                source,
                section,
                cwd,
            },
        )
        .await?;
    let detail = state
        .detail
        .read(&agent, &created.task.thread_id, None)
        .await
        .map_err(|error| fork_created_but_unreadable(&created.task.thread_id, error))?;
    Ok(Json(CreatedTaskResponse {
        detail,
        active_task: created.active_task,
        active_top_placement: created.placement,
    }))
}

fn fork_created_but_unreadable(thread_id: &str, error: ApiError) -> ApiError {
    let mut body = crate::app::error::ErrorBody::new(
        "task_fork_created",
        format!("The fork was created, but its details could not be opened: {error}"),
    );
    body.created_task_id = Some(thread_id.to_string());
    ApiError::Diagnostic(Box::new(body))
}

fn task_fork_source_id(provider: &str, source_id: &str) -> Result<String, ApiError> {
    match provider.trim() {
        "codex" | "claude" | "grok" => {}
        "antigravity" | "agy" => {
            return Err(ApiError::BadRequest {
                code: "task_fork_unsupported_provider",
                message: "Antigravity conversation fork is not supported".into(),
            });
        }
        _ => {
            return Err(ApiError::BadRequest {
                code: "task_fork_provider_invalid",
                message: "provider must be codex, claude or grok".into(),
            });
        }
    }

    let source_id = source_id.trim();
    let source_id = if provider.trim() == "codex" {
        source_id
            .strip_prefix(CODEX_THREAD_URI_PREFIX)
            .unwrap_or(source_id)
            .trim()
    } else {
        source_id
    };
    if source_id.is_empty()
        || source_id.len() > 256
        || !source_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        || (provider.trim() != "codex" && uuid::Uuid::parse_str(source_id).is_err())
    {
        return Err(ApiError::BadRequest {
            code: "task_fork_source_id_invalid",
            message: "sourceId must be a valid native conversation ID".to_string(),
        });
    }
    Ok(source_id.to_string())
}

async fn ensure_task_fork_source_provider(
    state: &TaskState,
    source_id: &str,
    provider: &str,
) -> Result<(), ApiError> {
    if task_store_get(state, source_id)
        .await?
        .is_some_and(|source| provider_name(source.run_by.provider()) != provider.trim())
    {
        return Err(task_fork_source_provider_mismatch());
    }
    Ok(())
}

async fn task_fork_target_context(
    state: &TaskState,
    section_id: &str,
) -> Result<(ManagedSection, String), ApiError> {
    let section_id = section_id.trim();
    if section_id.is_empty() {
        return Err(ApiError::BadRequest {
            code: "task_fork_target_invalid",
            message: "sectionId must identify the target Section".to_string(),
        });
    }
    let store = state.task_store.clone();
    let section_id = section_id.to_string();
    let section = tokio::task::spawn_blocking(move || {
        store.read(|tables| {
            Ok(tables
                .managed_sections()?
                .into_iter()
                .find(|section| section.section_id == section_id))
        })
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)?
    .ok_or_else(|| ApiError::NotFound {
        code: "task_fork_target_unresolved",
        message: "the target Section is no longer available".to_string(),
    })?;
    let cwd = state
        .fs
        .absolute_directory_path(&section.logical_path)
        .map_err(|error| ApiError::Conflict {
            code: "task_fork_target_unavailable",
            message: format!("the target Section project root is unavailable: {error}"),
        })?
        .display()
        .to_string();
    Ok((section, cwd))
}

fn task_fork_preview_history(page: &TurnPage) -> Vec<TaskForkPreviewMessage> {
    let mut messages = page
        .turns
        .iter()
        .rev()
        .flat_map(|turn| turn.items.iter())
        .filter_map(|item| match &item.kind {
            ItemKind::UserMessage { text, .. } if !text.trim().is_empty() => {
                Some(TaskForkPreviewMessage {
                    role: "user",
                    text: text.clone(),
                })
            }
            ItemKind::AssistantMessage { text, .. } if !text.trim().is_empty() => {
                Some(TaskForkPreviewMessage {
                    role: "assistant",
                    text: text.clone(),
                })
            }
            ItemKind::Failure { text } if !text.trim().is_empty() => Some(TaskForkPreviewMessage {
                role: "failure",
                text: text.clone(),
            }),
            _ => None,
        })
        .collect::<Vec<_>>();
    if messages.len() > TASK_FORK_PREVIEW_MESSAGES {
        messages.drain(..messages.len() - TASK_FORK_PREVIEW_MESSAGES);
    }
    messages
}

fn non_empty_fork_metadata(value: &str) -> Option<String> {
    (!value.trim().is_empty()).then(|| value.to_string())
}

fn task_fork_source_read_error(error: crate::agent::AgentError) -> ApiError {
    match error {
        crate::agent::AgentError::ConversationGone(message) => ApiError::NotFound {
            code: "task_fork_source_unresolved",
            message,
        },
        error => error.into(),
    }
}

fn provider_name(provider: TaskProvider) -> &'static str {
    match provider {
        TaskProvider::Codex => "codex",
        TaskProvider::Claude => "claude",
        TaskProvider::Grok => "grok",
        TaskProvider::Antigravity => "antigravity",
    }
}

fn task_fork_source_provider_mismatch() -> ApiError {
    ApiError::BadRequest {
        code: "task_fork_source_provider_mismatch",
        message: "that conversation is managed as a different provider".to_string(),
    }
}

async fn fork_source_context(
    state: &TaskState,
    thread_id: &str,
) -> Result<(ManagedThread, ManagedSection), ApiError> {
    let store = state.task_store.clone();
    let wanted = thread_id.to_string();
    let (source, section) = tokio::task::spawn_blocking(move || {
        store.read(|tables| {
            let source = tables
                .active_managed_threads()?
                .into_iter()
                .find(|thread| thread.thread_id == wanted);
            let section_id = source
                .as_ref()
                .and_then(ManagedThread::section_id)
                .map(str::to_string);
            let section = match section_id {
                Some(section_id) => tables
                    .managed_sections()?
                    .into_iter()
                    .find(|section| section.section_id == section_id),
                None => None,
            };
            Ok((source, section))
        })
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)?;
    let Some(source) = source else {
        return Err(moved_refusal(&state.task_store, thread_id).await);
    };
    let section = section.ok_or_else(|| ApiError::Conflict {
        code: "task_fork_source_unplaced",
        message: "the source Task is not placed in an active Section".to_string(),
    })?;
    Ok((source, section))
}

#[cfg(test)]
mod tests {
    use super::super::router;
    use crate::agent::codex::MockCodexResponse;
    use crate::agent::codex::{CodexThreadClient, CodexThreadError};
    use axum::body::Body;
    use serde_json::{Value as JsonValue, json};
    use tower::ServiceExt;

    use super::super::test_support::*;
    use super::*;
    use crate::{
        app::tasks::test_support::*,
        fs::RootedFs,
        task_store::{ManagedThread, RunBy},
    };

    fn fork_thread(thread_id: &str, cwd: &std::path::Path, updated_at: f64) -> JsonValue {
        json!({
            "id": thread_id,
            "name": "Provider source name",
            "preview": "Inherited conversation",
            "status": { "type": "idle" },
            "cwd": cwd.display().to_string(),
            "createdAt": 1.0,
            "updatedAt": updated_at,
            "turns": []
        })
    }

    fn inherited_turns_page() -> JsonValue {
        json!({
            "data": [{
                "id": "turn-inherited",
                "status": "completed",
                "startedAt": 1.0,
                "completedAt": 2.0,
                "items": [
                    {
                        "type": "userMessage",
                        "id": "user-inherited",
                        "content": [{ "type": "text", "text": "Inherited prompt" }]
                    },
                    {
                        "type": "agentMessage",
                        "id": "assistant-inherited",
                        "phase": "final",
                        "text": "Inherited answer"
                    }
                ]
            }],
            "nextCursor": "older-inherited-turns",
            "backwardsCursor": null
        })
    }

    #[test]
    fn fork_source_id_validation_keeps_the_provider_and_id_explicit() {
        assert_eq!(
            task_fork_source_id(" codex ", " thread-source ").unwrap(),
            "thread-source"
        );
        assert_eq!(
            task_fork_source_id("codex", " codex://threads/thread-source ").unwrap(),
            "thread-source"
        );
        assert!(matches!(
            task_fork_source_id("antigravity", "session-source"),
            Err(ApiError::BadRequest {
                code: "task_fork_unsupported_provider",
                ..
            })
        ));
        assert!(matches!(
            task_fork_source_id("other", "thread-source"),
            Err(ApiError::BadRequest {
                code: "task_fork_provider_invalid",
                ..
            })
        ));
        assert!(matches!(
            task_fork_source_id("codex", "   "),
            Err(ApiError::BadRequest {
                code: "task_fork_source_id_invalid",
                ..
            })
        ));
        assert!(matches!(
            task_fork_source_id("codex", "codex://threads/"),
            Err(ApiError::BadRequest {
                code: "task_fork_source_id_invalid",
                ..
            })
        ));
        assert!(matches!(
            task_fork_source_id("codex", &"x".repeat(257)),
            Err(ApiError::BadRequest {
                code: "task_fork_source_id_invalid",
                ..
            })
        ));
    }

    #[tokio::test]
    async fn fork_route_claims_only_the_idle_codex_child_at_the_project_root() {
        let root = tempfile::tempdir().unwrap();
        let project_root = root.path().canonicalize().unwrap();
        let source_thread_id = "thread-fork-source";
        let child_thread_id = "thread-fork-child";
        let cwd = project_root.display().to_string();
        let source = fork_thread(source_thread_id, &project_root.join("source-project"), 2.0);
        let child = json!({
            "id": child_thread_id,
            "preview": "Inherited conversation",
            "status": { "type": "idle" },
            "cwd": cwd,
            "forkedFromId": source_thread_id,
            "createdAt": 3.0,
            "updatedAt": 3.0,
            "turns": []
        });
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "thread/read",
                json!({ "threadId": source_thread_id, "includeTurns": false }),
                json!({ "thread": source.clone() }),
            ),
            MockCodexResponse::ok_for(
                "thread/fork",
                json!({
                    "threadId": source_thread_id,
                    "cwd": cwd,
                    "runtimeWorkspaceRoots": [cwd],
                    "excludeTurns": true,
                    "deferGoalContinuation": true
                }),
                json!({
                    "thread": child,
                    "cwd": cwd,
                    "model": "gpt-5.6-sol",
                    "reasoningEffort": "high",
                    "serviceTier": "priority",
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "auto_review",
                    "sandbox": { "type": "workspaceWrite" }
                }),
            ),
            MockCodexResponse::ok_for(
                "thread/read",
                json!({ "threadId": source_thread_id, "includeTurns": false }),
                json!({ "thread": source }),
            ),
            MockCodexResponse::ok_for(
                "thread/turns/list",
                json!({
                    "threadId": child_thread_id,
                    "limit": 8,
                    "sortDirection": "desc",
                    "itemsView": "full"
                }),
                inherited_turns_page(),
            ),
            MockCodexResponse::ok_for(
                "thread/name/set",
                json!({
                    "threadId": child_thread_id,
                    "name": "Fork of Source task"
                }),
                json!({}),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(
            &state,
            source_thread_id,
            "Source task",
            2_000,
            "section-root",
            "",
        );

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(format!("/api/tasks/{source_thread_id}/fork"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("fork response");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("fork response body");
        let created: JsonValue = serde_json::from_slice(&body).expect("fork response JSON");
        assert_eq!(status, axum::http::StatusCode::OK, "{created}");
        let detail = &created["detail"];
        assert_eq!(detail["threadId"], child_thread_id);
        assert_eq!(detail["provider"], "codex");
        assert_eq!(detail["task"]["title"], "Fork of Source task");
        assert_eq!(detail["task"]["cwdPath"], "");
        assert_eq!(detail["task"]["worktree"], JsonValue::Null);
        assert_eq!(detail["historyLoading"], false);
        let next_cursor: JsonValue =
            serde_json::from_str(detail["eventsPage"]["nextCursor"].as_str().unwrap())
                .expect("a Caffold detail cursor");
        assert_eq!(next_cursor["turns"], "older-inherited-turns");
        assert!(detail["events"].as_array().unwrap().iter().any(|event| {
            event["summary"] == "Inherited prompt" || event["payload"]["text"] == "Inherited prompt"
        }));
        assert_eq!(created["activeTask"]["threadId"], child_thread_id);
        assert_eq!(created["activeTask"]["title"], "Fork of Source task");
        assert_eq!(created["activeTask"]["worktree"], false);
        assert_eq!(
            created["activeTopPlacement"]["section"]["id"],
            "section-root"
        );
        assert_eq!(
            created["activeTopPlacement"]["beforeThreadId"],
            source_thread_id
        );

        let source_stored = state
            .task_store
            .get(source_thread_id)
            .unwrap()
            .expect("source remains managed");
        assert_eq!(source_stored.display_name, "Source task");
        assert!(state.task_store.get(child_thread_id).unwrap().is_some());
        assert!(
            state
                .task_store
                .worktree_for_thread(child_thread_id)
                .unwrap()
                .is_none()
        );
        let active = state
            .task_store
            .read(|tables| tables.active_managed_threads())
            .unwrap();
        assert_eq!(
            active
                .iter()
                .map(|thread| thread.thread_id.as_str())
                .collect::<Vec<_>>(),
            [child_thread_id, source_thread_id]
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            [
                "thread/read",
                "thread/fork",
                "thread/read",
                "thread/turns/list",
                "thread/name/set"
            ]
        );
    }

    #[tokio::test]
    async fn fork_preview_reads_a_not_loaded_external_thread_without_claiming_or_resuming_it() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-external-preview";
        let mut source = fork_thread(source_thread_id, root.path(), 2.0);
        source["status"] = json!({ "type": "notLoaded" });
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "thread/read",
                json!({ "threadId": source_thread_id, "includeTurns": false }),
                json!({ "thread": source }),
            ),
            MockCodexResponse::ok_for(
                "thread/turns/list",
                json!({
                    "threadId": source_thread_id,
                    "limit": 4,
                    "sortDirection": "desc",
                    "itemsView": "full"
                }),
                inherited_turns_page(),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/task-forks/preview")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "provider": "codex",
                            "sourceId": source_thread_id
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .expect("fork preview response");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("fork preview body");
        let preview: JsonValue = serde_json::from_slice(&body).expect("fork preview JSON");
        assert_eq!(status, axum::http::StatusCode::OK, "{preview}");
        assert_eq!(preview["provider"], "codex");
        assert_eq!(preview["sourceId"], source_thread_id);
        assert_eq!(preview["displayName"], "Provider source name");
        assert_eq!(preview["summary"], "Inherited conversation");
        assert_eq!(preview["status"]["type"], "notLoaded");
        assert_eq!(preview["cwd"], root.path().display().to_string());
        assert_eq!(preview["lastActivityMs"], 2_000);
        assert_eq!(
            preview["recentHistory"],
            json!([
                { "role": "user", "text": "Inherited prompt" },
                { "role": "assistant", "text": "Inherited answer" }
            ])
        );
        assert!(state.task_store.get(source_thread_id).unwrap().is_none());
        assert_eq!(state.task_sessions.diagnostics().await.tracked_sessions, 0);
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

    #[tokio::test]
    async fn fork_preview_rejects_a_different_returned_thread_without_claiming_it() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-requested-preview";
        let different_thread_id = "thread-different-preview";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok_for(
            "thread/read",
            json!({ "threadId": source_thread_id, "includeTurns": false }),
            json!({
                "thread": fork_thread(different_thread_id, root.path(), 2.0)
            }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/task-forks/preview")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "provider": "codex",
                            "sourceId": source_thread_id
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .expect("mismatched fork preview response");

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("mismatched fork preview body");
        let body: JsonValue = serde_json::from_slice(&body).expect("mismatched preview JSON");
        assert_eq!(body["error"]["code"], "task_fork_source_mismatch");
        assert!(state.task_store.get(source_thread_id).unwrap().is_none());
        assert!(state.task_store.get(different_thread_id).unwrap().is_none());
        assert_eq!(state.task_sessions.diagnostics().await.tracked_sessions, 0);
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
    async fn fork_from_id_accepts_not_loaded_source_and_claims_child_in_selected_section() {
        let root = tempfile::tempdir().unwrap();
        let project_root = root.path().canonicalize().unwrap();
        let source_thread_id = "thread-external-source";
        let child_thread_id = "thread-external-child";
        let cwd = project_root.display().to_string();
        let mut source_before =
            fork_thread(source_thread_id, &project_root.join("source-project"), 2.0);
        source_before["status"] = json!({ "type": "notLoaded" });
        let source_after = fork_thread(source_thread_id, &project_root.join("source-project"), 2.0);
        let child = json!({
            "id": child_thread_id,
            "preview": "Inherited conversation",
            "status": { "type": "idle" },
            "cwd": cwd,
            "forkedFromId": source_thread_id,
            "createdAt": 3.0,
            "updatedAt": 3.0,
            "turns": []
        });
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "thread/read",
                json!({ "threadId": source_thread_id, "includeTurns": false }),
                json!({ "thread": source_before }),
            ),
            MockCodexResponse::ok_for(
                "thread/fork",
                json!({
                    "threadId": source_thread_id,
                    "cwd": cwd,
                    "runtimeWorkspaceRoots": [cwd],
                    "excludeTurns": true,
                    "deferGoalContinuation": true
                }),
                json!({
                    "thread": child,
                    "cwd": cwd,
                    "model": "gpt-5.6-sol",
                    "reasoningEffort": "high",
                    "serviceTier": "priority",
                    "approvalPolicy": "on-request",
                    "approvalsReviewer": "auto_review",
                    "sandbox": { "type": "workspaceWrite" }
                }),
            ),
            MockCodexResponse::ok_for(
                "thread/read",
                json!({ "threadId": source_thread_id, "includeTurns": false }),
                json!({ "thread": source_after }),
            ),
            MockCodexResponse::ok_for(
                "thread/turns/list",
                json!({
                    "threadId": child_thread_id,
                    "limit": 8,
                    "sortDirection": "desc",
                    "itemsView": "full"
                }),
                inherited_turns_page(),
            ),
            MockCodexResponse::ok_for(
                "thread/name/set",
                json!({
                    "threadId": child_thread_id,
                    "name": "Fork of Provider source name"
                }),
                json!({}),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        seed_section(&state, "section-target", "");

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/task-forks")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "provider": "codex",
                            "sourceId": source_thread_id,
                            "sectionId": "section-target"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .expect("fork from ID response");

        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("fork from ID body");
        let created: JsonValue = serde_json::from_slice(&body).expect("fork from ID JSON");
        assert_eq!(status, axum::http::StatusCode::OK, "{created}");
        let detail = &created["detail"];
        assert_eq!(detail["threadId"], child_thread_id);
        assert_eq!(detail["task"]["title"], "Fork of Provider source name");
        assert_eq!(detail["task"]["cwdPath"], "");
        assert_eq!(detail["task"]["worktree"], JsonValue::Null);
        assert_eq!(created["activeTask"]["threadId"], child_thread_id);
        assert_eq!(created["activeTask"]["worktree"], false);
        assert_eq!(
            created["activeTopPlacement"]["section"]["id"],
            "section-target"
        );
        assert_eq!(
            created["activeTopPlacement"]["beforeThreadId"],
            JsonValue::Null
        );
        assert!(state.task_store.get(source_thread_id).unwrap().is_none());
        assert!(state.task_store.get(child_thread_id).unwrap().is_some());
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            [
                "thread/read",
                "thread/fork",
                "thread/read",
                "thread/turns/list",
                "thread/name/set"
            ]
        );
    }

    #[tokio::test]
    async fn fork_from_id_rejects_an_active_external_source_without_tracking_it() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-external-active";
        let mut source = fork_thread(source_thread_id, root.path(), 2.0);
        source["status"] = json!({ "type": "active", "activeFlags": [] });
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok_for(
            "thread/read",
            json!({ "threadId": source_thread_id, "includeTurns": false }),
            json!({ "thread": source }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        seed_section(&state, "section-target", "");

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/task-forks")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "provider": "codex",
                            "sourceId": source_thread_id,
                            "sectionId": "section-target"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .expect("active external fork response");

        assert_eq!(response.status(), axum::http::StatusCode::CONFLICT);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("active external fork error body");
        let body: JsonValue = serde_json::from_slice(&body).expect("active fork error JSON");
        assert_eq!(body["error"]["code"], "task_fork_source_not_idle");
        assert_eq!(state.task_sessions.diagnostics().await.tracked_sessions, 0);
        assert!(state.task_store.get(source_thread_id).unwrap().is_none());
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
    async fn fork_from_id_rejects_a_different_returned_source_before_creating_a_child() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-requested-source";
        let different_thread_id = "thread-different-source";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok_for(
            "thread/read",
            json!({ "threadId": source_thread_id, "includeTurns": false }),
            json!({
                "thread": fork_thread(different_thread_id, root.path(), 2.0)
            }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        seed_section(&state, "section-target", "");

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/task-forks")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "provider": "codex",
                            "sourceId": source_thread_id,
                            "sectionId": "section-target"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .expect("mismatched fork response");

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("mismatched fork body");
        let body: JsonValue = serde_json::from_slice(&body).expect("mismatched fork JSON");
        assert_eq!(body["error"]["code"], "task_fork_source_mismatch");
        assert!(state.task_store.get(source_thread_id).unwrap().is_none());
        assert!(state.task_store.get(different_thread_id).unwrap().is_none());
        assert_eq!(state.task_sessions.diagnostics().await.tracked_sessions, 0);
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
    async fn fork_preview_rejects_a_known_provider_mismatch_without_calling_codex() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "known-claude-session";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        seed_section(&state, "section-target", "");
        state
            .task_store
            .transaction(|tables| {
                tables.claim_managed_thread_at_top(
                    ManagedThread::new(
                        source_thread_id,
                        RunBy::Claude {
                            cwd: root.path().display().to_string(),
                        },
                        Some(1_000),
                        None,
                        None,
                    ),
                    "Claude source",
                    "section-target",
                    1_000,
                )
            })
            .unwrap();

        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/task-forks/preview")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "provider": "codex",
                            "sourceId": source_thread_id
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .expect("provider mismatch response");

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("provider mismatch body");
        let body: JsonValue = serde_json::from_slice(&body).expect("provider mismatch JSON");
        assert_eq!(body["error"]["code"], "task_fork_source_provider_mismatch");
        assert!(client.mock_requests().await.is_empty());
    }

    #[tokio::test]
    async fn fork_preview_reports_an_unresolved_external_id_without_claiming_it() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "missing-external-thread";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "thread/read",
            CodexThreadError::ThreadUnavailable(source_thread_id.to_string()),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/task-forks/preview")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "provider": "codex",
                            "sourceId": source_thread_id
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .expect("unresolved preview response");

        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("unresolved preview body");
        let body: JsonValue = serde_json::from_slice(&body).expect("unresolved preview JSON");
        assert_eq!(body["error"]["code"], "task_fork_source_unresolved");
        assert!(state.task_store.get(source_thread_id).unwrap().is_none());
        assert_eq!(state.task_sessions.diagnostics().await.tracked_sessions, 0);
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
    async fn fork_from_id_rejects_a_missing_target_before_contacting_codex() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/task-forks")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "provider": "codex",
                            "sourceId": "external-source",
                            "sectionId": "missing-section"
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .expect("missing target response");

        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("missing target body");
        let body: JsonValue = serde_json::from_slice(&body).expect("missing target JSON");
        assert_eq!(body["error"]["code"], "task_fork_target_unresolved");
        assert!(client.mock_requests().await.is_empty());
        assert!(
            state
                .task_store
                .read(|tables| tables.active_managed_threads())
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn fork_rejects_an_antigravity_task_without_contacting_codex() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "agy-fork-source";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        seed_section(&state, "section-root", "");
        state
            .task_store
            .transaction(|tables| {
                tables.claim_managed_thread_at_top(
                    ManagedThread::new(
                        source_thread_id,
                        RunBy::Antigravity {
                            cwd: root.path().display().to_string(),
                        },
                        Some(2_000),
                        None,
                        None,
                    ),
                    "Antigravity source",
                    "section-root",
                    2_000,
                )
            })
            .unwrap();

        let error = fork_task(State(state), AxumPath(source_thread_id.to_string()))
            .await
            .expect_err("Antigravity is excluded");

        assert!(matches!(
            error,
            ApiError::BadRequest {
                code: "task_fork_unsupported_provider",
                ..
            }
        ));
        assert!(client.mock_requests().await.is_empty());
    }
    #[test]
    fn an_antigravity_source_is_refused_as_unsupported_rather_than_invalid() {
        let error = task_fork_source_id("antigravity", "session-source").unwrap_err();
        assert!(
            matches!(
                error,
                ApiError::BadRequest {
                    code: "task_fork_unsupported_provider",
                    ..
                }
            ),
            "{error:?}"
        );
    }
    #[tokio::test]
    async fn grok_forks_through_both_http_entry_points_with_child_mcp_and_separate_ownership() {
        for managed_source in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let codex = CodexThreadClient::mock(Vec::new());
            let (state, leader, memory, _host) =
                task_state_with_grok(RootedFs::new(root.path()).unwrap(), codex.clone()).await;
            seed_section(&state, "section-root", "");
            let cwd = root.path().canonicalize().unwrap().display().to_string();
            let source = state
                .task_runtime
                .grok()
                .start_conversation(&cwd, &crate::agent::grok::GrokTurnOptions::default())
                .await
                .unwrap();
            if managed_source {
                state
                    .task_store
                    .transaction(|tables| {
                        let mut managed = ManagedThread::new(
                            &source.id,
                            RunBy::Grok { cwd: cwd.clone() },
                            Some(2_000),
                            None,
                            None,
                        );
                        managed.permission_mode =
                            Some(crate::agent::driver::REVIEWED_PERMISSION_MODE.into());
                        tables.claim_managed_thread_at_top(
                            managed,
                            "Grok source",
                            "section-root",
                            2_000,
                        )
                    })
                    .unwrap();
            }
            let app = router(state.clone());
            let preview = app
                .clone()
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/api/task-forks/preview")
                        .header("content-type", "application/json")
                        .body(Body::from(
                            json!({"provider":"grok","sourceId":source.id}).to_string(),
                        ))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(preview.status(), axum::http::StatusCode::OK);
            assert!(leader.requests("session/load").is_empty());
            assert_eq!(
                state.task_store.get(&source.id).unwrap().is_some(),
                managed_source
            );
            let (uri, body) = if managed_source {
                (format!("/api/tasks/{}/fork", source.id), json!({}))
            } else {
                (
                    "/api/task-forks".into(),
                    json!({"provider":"grok","sourceId":source.id,"sectionId":"section-root"}),
                )
            };
            let response = app
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri(uri)
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body: JsonValue = serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), 1_000_000)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
            let child = body["detail"]["threadId"].as_str().unwrap();
            assert_ne!(child, source.id);
            assert_eq!(body["detail"]["provider"], "grok");
            assert_eq!(body["activeTopPlacement"]["section"]["id"], "section-root");
            let saved = state.task_store.get(child).unwrap().unwrap();
            if managed_source {
                assert_eq!(
                    saved.permission_mode.as_deref(),
                    Some(crate::agent::driver::REVIEWED_PERMISSION_MODE)
                );
            }
            assert!(leader.requests("session/close").is_empty());
            let loaded = leader.requests("session/load");
            assert!(loaded.iter().all(|request| request["sessionId"] == child));
            assert_ne!(
                loaded[0]["mcpServers"][0]["headers"],
                leader.requests("session/new")[0]["mcpServers"][0]["headers"]
            );
            state.task_runtime.grok().erase(child).await.unwrap();
            assert!(memory.lock().unwrap().cwds.contains_key(&source.id));
            assert!(codex.mock_requests().await.is_empty());
        }
    }

    #[test]
    fn a_claimed_child_survives_a_detail_failure_as_an_openable_identity() {
        let error = fork_created_but_unreadable(
            "known-child",
            ApiError::Internal("detail read failed".into()),
        );
        let body = error.into_error_body();
        assert_eq!(body.code, "task_fork_created");
        assert_eq!(body.created_task_id.as_deref(), Some("known-child"));
    }
}
