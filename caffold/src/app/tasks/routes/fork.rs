//! HTTP ownership for previewing and forking provider conversations.
//!
//! Both the managed-Task and external-ID routes resolve their source and target
//! here, then hand the provider mutation to the Task lifecycle. Preview remains
//! read-only; a Task is claimed only after the provider returns a child.

use super::*;
use crate::app::tasks::projection;

const TASK_FORK_PREVIEW_TURNS: usize = 4;
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
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let (source, section) = fork_source_context(&state, &thread_id).await?;
    if !matches!(source.run_by, RunBy::Codex) {
        return Err(ApiError::BadRequest {
            code: "task_fork_unsupported_provider",
            message: "forking is currently available only for Codex Tasks".to_string(),
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
    let connection = require_codex_thread_connection(&state).await?;
    let created = state
        .lifecycle
        .fork_codex_task(
            &connection,
            ForkCodexTask {
                source: ForkCodexSource::Managed(Box::new(source)),
                section,
                cwd,
            },
        )
        .await?;
    let _viewer = state
        .task_sessions
        .reserve_viewer(&created.task.thread_id)
        .await;
    let agent = TaskAgent::Codex(connection);
    let mut detail = state
        .detail
        .read(&agent, &created.task.thread_id, None)
        .await?;
    detail.active_top_placement = Some(created.placement);
    Ok(Json(detail))
}

async fn preview_task_fork_source(
    State(state): State<TaskState>,
    Json(request): Json<TaskForkSourceRequest>,
) -> Result<Json<TaskForkSourcePreview>, ApiError> {
    let source_id = task_fork_source_id(&request.provider, &request.source_id)?;
    ensure_task_fork_source_provider(&state, &source_id).await?;
    let client = require_codex_thread_client(&state).await?;
    let source = client
        .read_thread(&source_id)
        .await
        .map_err(task_fork_source_read_error)?;
    if source.id != source_id {
        return Err(task_fork_source_mismatch());
    }
    let conversation = Conversation::from(&source);
    let history = client
        .list_thread_turns(&source_id, None, TASK_FORK_PREVIEW_TURNS)
        .await
        .map_err(task_fork_source_read_error)?;
    let history = TurnPage::from(&history);

    Ok(Json(TaskForkSourcePreview {
        provider: "codex",
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
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let source_id = task_fork_source_id(&request.provider, &request.source_id)?;
    let (section, cwd) = task_fork_target_context(&state, &request.section_id).await?;
    let source = match task_store_get(&state, &source_id).await? {
        Some(source) if source.run_by.provider() != TaskProvider::Codex => {
            return Err(task_fork_source_provider_mismatch());
        }
        Some(source) if source.archived_at_ms.is_none() => {
            ForkCodexSource::Managed(Box::new(source))
        }
        Some(_) | None => ForkCodexSource::External {
            thread_id: source_id,
        },
    };
    let connection = require_codex_thread_connection(&state).await?;
    let created = state
        .lifecycle
        .fork_codex_task(
            &connection,
            ForkCodexTask {
                source,
                section,
                cwd,
            },
        )
        .await?;
    let _viewer = state
        .task_sessions
        .reserve_viewer(&created.task.thread_id)
        .await;
    let agent = TaskAgent::Codex(connection);
    let mut detail = state
        .detail
        .read(&agent, &created.task.thread_id, None)
        .await?;
    detail.active_top_placement = Some(created.placement);
    Ok(Json(detail))
}

fn task_fork_source_id(provider: &str, source_id: &str) -> Result<String, ApiError> {
    match provider.trim() {
        "codex" => {}
        "claude" => {
            return Err(ApiError::BadRequest {
                code: "task_fork_unsupported_provider",
                message: "forking from a Claude session is not supported yet".to_string(),
            });
        }
        _ => {
            return Err(ApiError::BadRequest {
                code: "task_fork_provider_invalid",
                message: "provider must be codex".to_string(),
            });
        }
    }

    let source_id = source_id.trim();
    let source_id = source_id
        .strip_prefix(CODEX_THREAD_URI_PREFIX)
        .unwrap_or(source_id)
        .trim();
    if source_id.is_empty() || source_id.len() > 256 {
        return Err(ApiError::BadRequest {
            code: "task_fork_source_id_invalid",
            message: "sourceId must be a non-empty Codex Thread ID".to_string(),
        });
    }
    Ok(source_id.to_string())
}

async fn ensure_task_fork_source_provider(
    state: &TaskState,
    source_id: &str,
) -> Result<(), ApiError> {
    if task_store_get(state, source_id)
        .await?
        .is_some_and(|source| source.run_by.provider() != TaskProvider::Codex)
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

fn task_fork_source_read_error(error: CodexThreadError) -> ApiError {
    match error {
        CodexThreadError::ThreadUnavailable(_) => ApiError::NotFound {
            code: "task_fork_source_unresolved",
            message: "Codex could not resolve that Thread ID".to_string(),
        },
        CodexThreadError::InvalidParams(_) => ApiError::BadRequest {
            code: "task_fork_source_id_invalid",
            message: "sourceId is not a valid Codex Thread ID".to_string(),
        },
        error => error.into(),
    }
}

fn task_fork_source_mismatch() -> ApiError {
    ApiError::BadRequest {
        code: "task_fork_source_mismatch",
        message: "Codex returned a different source thread".to_string(),
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
    let thread_id = thread_id.to_string();
    let (source, section) = tokio::task::spawn_blocking(move || {
        store.read(|tables| {
            let source = tables
                .active_managed_threads()?
                .into_iter()
                .find(|thread| thread.thread_id == thread_id);
            let section_id = source
                .as_ref()
                .and_then(|source| source.section_id.as_deref())
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
    let source = source.ok_or_else(task_not_managed_error)?;
    let section = section.ok_or_else(|| ApiError::Conflict {
        code: "task_fork_source_unplaced",
        message: "the source Task is not placed in an active Section".to_string(),
    })?;
    Ok((source, section))
}

#[cfg(test)]
mod tests {
    use crate::agent::codex::MockCodexResponse;
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
            task_fork_source_id("claude", "session-source"),
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
        let detail: JsonValue = serde_json::from_slice(&body).expect("fork detail JSON");
        assert_eq!(status, axum::http::StatusCode::OK, "{detail}");
        assert_eq!(detail["threadId"], child_thread_id);
        assert_eq!(detail["provider"], "codex");
        assert_eq!(detail["task"]["title"], "Fork of Source task");
        assert_eq!(detail["task"]["cwdPath"], "");
        assert_eq!(detail["task"]["worktree"], JsonValue::Null);
        assert_eq!(detail["historyLoading"], false);
        assert_eq!(detail["eventsPage"]["nextCursor"], "older-inherited-turns");
        assert!(detail["events"].as_array().unwrap().iter().any(|event| {
            event["summary"] == "Inherited prompt" || event["payload"]["text"] == "Inherited prompt"
        }));
        assert_eq!(
            detail["activeTopPlacement"]["section"]["id"],
            "section-root"
        );
        assert_eq!(
            detail["activeTopPlacement"]["beforeThreadId"],
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
        let detail: JsonValue = serde_json::from_slice(&body).expect("fork from ID JSON");
        assert_eq!(status, axum::http::StatusCode::OK, "{detail}");
        assert_eq!(detail["threadId"], child_thread_id);
        assert_eq!(detail["task"]["title"], "Fork of Provider source name");
        assert_eq!(detail["task"]["cwdPath"], "");
        assert_eq!(detail["task"]["worktree"], JsonValue::Null);
        assert_eq!(
            detail["activeTopPlacement"]["section"]["id"],
            "section-target"
        );
        assert_eq!(
            detail["activeTopPlacement"]["beforeThreadId"],
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
    async fn fork_rejects_a_claude_task_without_contacting_codex() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "claude-fork-source";
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
                        RunBy::Claude {
                            cwd: root.path().display().to_string(),
                        },
                        Some(2_000),
                        None,
                        None,
                    ),
                    "Claude source",
                    "section-root",
                    2_000,
                )
            })
            .unwrap();

        let error = fork_task(State(state), AxumPath(source_thread_id.to_string()))
            .await
            .expect_err("Claude fork is not part of phase one");

        assert!(matches!(
            error,
            ApiError::BadRequest {
                code: "task_fork_unsupported_provider",
                ..
            }
        ));
        assert!(client.mock_requests().await.is_empty());
    }
}
