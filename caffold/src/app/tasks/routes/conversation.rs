use super::commands::apply_managed_thread_metadata;
use super::store::{task_store_get, task_store_mark_seen};
use super::{TaskDetailQuery, TasksQuery};
use crate::agent::Conversation;
use crate::app::error::ApiError;
use crate::app::tasks::active_list::unavailable_active_task;
use crate::app::tasks::generated_images::GeneratedImageError;
use crate::app::tasks::{
    DetailFrameStream, TaskDetailResponse, TaskRecord, TaskState, task_activity_ms,
};
use axum::Json;
use axum::body::Body;
use axum::extract::Path as AxumPath;
use axum::extract::{Query, State};
use axum::http::{HeaderValue, header};
use axum::response::Response;

pub(super) async fn task_detail(
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

pub(super) async fn task_generated_image(
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

pub(super) fn generated_image_api_error(
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

/// Record that a person has looked at a Task.
///
/// What is written is Caffold's own — when this Task was last seen — so the
/// answer describes the Task as well as it can be described without waking
/// anything. Codex is asked, because asking it is cheap and refreshes what the
/// session store knows; Claude is not, because reaching a Claude Task that
/// nobody is watching means starting a process, and a person clicking a row did
/// not ask for that.
pub(super) async fn mark_task_seen(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    let Some(managed) = task_store_get(&state, &thread_id).await? else {
        return Err(task_not_managed_error());
    };
    let agent = state.task_runtime.task_agent(&thread_id).await?;
    let mut task = match agent.codex() {
        Some(connection) => {
            let conversation =
                Conversation::from(&connection.client.read_thread(&thread_id).await?);
            state
                .task_sessions
                .observe_thread_metadata(conversation.clone())
                .await;
            state.detail.record_from_conversation(&conversation)?
        }
        None => match state
            .task_sessions
            .snapshot(&thread_id)
            .await
            .and_then(|snapshot| snapshot.conversation)
        {
            Some(conversation) => state.detail.record_from_conversation(&conversation)?,
            None => unavailable_active_task(&managed),
        },
    };
    let activity_ms = task_activity_ms(&task);
    let Some(managed) = task_store_mark_seen(&state, &thread_id, activity_ms).await? else {
        return Err(task_not_managed_error());
    };
    apply_managed_thread_metadata(&mut task, &managed);
    notify_task_updated(&state, task.clone());
    Ok(Json(task))
}

pub(super) fn task_not_managed_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_not_managed",
        message: "task is not managed by Caffold".to_string(),
    }
}

pub(super) fn notify_task_updated(state: &TaskState, task: TaskRecord) {
    state.task_list_events.update(task);
}

pub(super) async fn task_stream(
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

#[cfg(test)]
mod tests {
    use super::super::router;
    use crate::agent;
    use crate::agent::codex::CodexThreadClient;
    use crate::agent::codex::{MockCodexResponse, conversation_item};
    use crate::fs::MAX_IMAGE_BYTES;
    use futures_util::StreamExt;
    use serde_json::{Value as JsonValue, json};
    use tower::ServiceExt;

    use super::*;
    use crate::{
        app::tasks::{
            events::{task_event_from_item, task_event_record},
            test_support::*,
        },
        fs::RootedFs,
        task_store::{ManagedThread, RunBy},
    };

    #[tokio::test]
    async fn a_claude_task_is_marked_seen_without_asking_codex_about_it() {
        // Codex has never heard of a Claude conversation. Asking it made the
        // request fail, so nothing was written and the Task came back unseen on
        // the next read.
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let thread_id = "claude-thread";
        state
            .task_store
            .claim(
                ManagedThread {
                    run_by: RunBy::Claude {
                        cwd: root.path().display().to_string(),
                    },
                    ..ManagedThread::new(thread_id, RunBy::Codex, Some(1_000), None, None)
                },
                1,
            )
            .unwrap();
        // A turn that finished while nobody was looking is what makes it unseen.
        state
            .task_store
            .record_completed_turn(thread_id, 4_000)
            .unwrap();
        assert!(
            state.task_store.get(thread_id).unwrap().unwrap().unseen(),
            "a Task whose turn finished unwatched starts unseen"
        );

        let Json(task) = mark_task_seen(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("a Claude Task can be marked seen");

        assert!(!task.unseen);
        assert!(
            !state.task_store.get(thread_id).unwrap().unwrap().unseen(),
            "and it stays seen when the Task is read again"
        );
        assert!(
            state.task_runtime.usage_diagnostics().threads.is_empty(),
            "nothing woke an agent to answer a click"
        );
    }

    #[tokio::test]
    async fn task_detail_http_projects_the_canonical_file_link_contract() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-file-link-detail-http";
        let task = root
            .path()
            .join("Library/Application Support/Caffold/data/worktrees/example");
        let policy = task.join("docs/review/policy.md");
        std::fs::create_dir_all(policy.parent().unwrap()).unwrap();
        std::fs::write(&policy, "# Review Policy\n").unwrap();
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/resume",
            resumed_task(thread_id, &task),
            std::time::Duration::from_secs(1),
        )]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        cache_and_manage_test_thread(&state, thread_id, &task).await;
        state.task_events.publish_local(task_event_record(
            thread_id,
            "assistant",
            "assistant_message",
            "File-link HTTP projection",
            Some(json!({
                "text": format!(
                    "[Policy]({}:22) [Missing](missing.rs) [External](https://example.com)",
                    policy.display()
                )
            })),
            1,
        ));

        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri(format!("/api/tasks/{thread_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("Task detail response");

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "application/json"
        );
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("Task detail body");
        let body: JsonValue = serde_json::from_slice(&body).expect("Task detail JSON");

        assert_eq!(
            body["events"][0]["payload"]["text"],
            "[Policy](docs/review/policy.md#L22) Missing [External](https://example.com)"
        );
        assert_eq!(body["fileLinks"].as_array().unwrap().len(), 2);
        assert_eq!(
            body["fileLinks"][0]["eventId"],
            format!("{thread_id}:assistant")
        );
        assert_eq!(body["fileLinks"][0]["linkId"], 0);
        assert_eq!(body["fileLinks"][0]["target"], "docs/review/policy.md#L22");
        assert_eq!(body["fileLinks"][0]["status"], "resolved");
        assert_eq!(
            body["fileLinks"][0]["path"],
            "Library/Application Support/Caffold/data/worktrees/example/docs/review/policy.md"
        );
        assert_eq!(
            body["fileLinks"][0]["taskRelativePath"],
            "docs/review/policy.md"
        );
        assert_eq!(body["fileLinks"][0]["line"], 22);
        assert_eq!(body["fileLinks"][1]["linkId"], 1);
        assert_eq!(body["fileLinks"][1]["target"], "missing.rs");
        assert_eq!(body["fileLinks"][1]["status"], "rejected");
        assert_eq!(body["fileLinks"][1]["reason"], "not_found");
    }

    #[tokio::test]
    async fn task_stream_http_projects_live_file_links_in_the_sse_envelope() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-file-link-stream-http";
        let task = root.path().join("task");
        std::fs::create_dir(&task).unwrap();
        std::fs::write(task.join("live.rs"), "pub fn live() {}\n").unwrap();
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/resume",
            resumed_task(thread_id, &task),
            std::time::Duration::from_secs(1),
        )]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        cache_and_manage_test_thread(&state, thread_id, &task).await;

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri(format!("/api/tasks/{thread_id}/stream"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("Task stream response");

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers()[axum::http::header::CONTENT_TYPE],
            "text/event-stream; charset=utf-8"
        );
        let mut body = response.into_body().into_data_stream();
        let ready = tokio::time::timeout(std::time::Duration::from_millis(100), body.next())
            .await
            .expect("Task stream ready frame")
            .expect("Task stream remains open")
            .unwrap();
        let bootstrap = tokio::time::timeout(std::time::Duration::from_millis(100), body.next())
            .await
            .expect("Task stream bootstrap frame")
            .expect("Task stream remains open")
            .unwrap();
        assert_eq!(ready.as_ref(), b": ready\n\n");
        assert!(
            std::str::from_utf8(&bootstrap)
                .unwrap()
                .starts_with("event: task-sync\ndata: ")
        );

        let published = state.task_events.publish_local(task_event_record(
            thread_id,
            "live-assistant",
            "assistant_message",
            "Live file-link projection",
            Some(json!({ "text": "[Live](live.rs:9:3)" })),
            2,
        ));

        let live_frame = tokio::time::timeout(std::time::Duration::from_millis(500), async {
            loop {
                let bytes = body
                    .next()
                    .await
                    .expect("Task stream remains open")
                    .expect("Task stream frame");
                let frame = std::str::from_utf8(&bytes).expect("UTF-8 Task stream frame");
                if frame.starts_with("event: task-event\ndata: ") {
                    break frame.to_string();
                }
            }
        })
        .await
        .expect("Live Task event frame");
        let payload = live_frame
            .strip_prefix("event: task-event\ndata: ")
            .and_then(|frame| frame.strip_suffix("\n\n"))
            .expect("Task event SSE payload");
        let payload: JsonValue = serde_json::from_str(payload).expect("Task event SSE JSON");

        assert_eq!(payload["threadId"], thread_id);
        assert_eq!(payload["eventRevision"], published.revision);
        assert_eq!(payload["event"]["payload"]["text"], "[Live](live.rs#L9)");
        assert_eq!(payload["fileLinks"].as_array().unwrap().len(), 1);
        assert_eq!(
            payload["fileLinks"][0]["eventId"],
            format!("{thread_id}:live-assistant")
        );
        assert_eq!(payload["fileLinks"][0]["linkId"], 0);
        assert_eq!(payload["fileLinks"][0]["target"], "live.rs#L9");
        assert_eq!(payload["fileLinks"][0]["status"], "resolved");
        assert_eq!(payload["fileLinks"][0]["path"], "task/live.rs");
        assert_eq!(payload["fileLinks"][0]["taskRelativePath"], "live.rs");
        assert_eq!(payload["fileLinks"][0]["line"], 9);
    }

    #[tokio::test]
    async fn mark_seen_tracks_completion_separately_from_canonical_recency() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-seen";
        let mut thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        thread["updatedAt"] = json!(10.0);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread }),
        )]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        state
            .task_store
            .update_completed_at(thread_id, 9_000)
            .unwrap();
        assert_eq!(
            task_store_get(&state, thread_id)
                .await
                .unwrap()
                .unwrap()
                .last_seen_activity_ms,
            None
        );

        let task = mark_task_seen(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .unwrap();

        assert!(!task.0.unseen);
        let managed = task_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(managed.last_seen_activity_ms, Some(9_000));
        assert_eq!(managed.last_completed_at_ms, Some(9_000));
        assert_eq!(managed.last_observed_recency_ms, Some(10_000));
    }

    #[tokio::test]
    async fn unmanaged_deep_link_is_rejected_without_reading_app_server_state() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-unmanaged-deep-link";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let error = task_detail(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        )
        .await
        .expect_err("unmanaged task route must be rejected");

        assert!(matches!(
            error,
            ApiError::BadRequest {
                code: "task_not_managed",
                ..
            }
        ));
        assert!(client.mock_requests().await.is_empty());
    }

    #[tokio::test]
    async fn generated_image_route_serves_only_the_registered_task_item() {
        const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let item = conversation_item(
            &json!({
                "type": "imageGeneration",
                "id": "image_1",
                "status": "completed",
                "result": ONE_PIXEL_PNG,
                "savedPath": null
            }),
            agent::ActivityStatus::Completed,
        )
        .expect("a generated image item");
        state.task_events.publish_provider_lifecycle(
            task_event_from_item("thread_1", "turn_1", 1, &item).expect("generated image event"),
            1,
        );

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::get("/api/tasks/thread_1/generated-images/image_1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("generated image response");
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
        assert_eq!(
            response
                .headers()
                .get(header::X_CONTENT_TYPE_OPTIONS)
                .unwrap(),
            "nosniff"
        );
        let bytes = axum::body::to_bytes(response.into_body(), MAX_IMAGE_BYTES as usize)
            .await
            .expect("generated image body");
        assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));

        let response = router(state)
            .oneshot(
                axum::http::Request::get("/api/tasks/thread_2/generated-images/image_1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("wrong task response");
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("wrong task error body");
        let body: JsonValue = serde_json::from_slice(&body).expect("wrong task error json");
        assert_eq!(body["error"]["code"], "generated_image_unavailable");
    }
}
