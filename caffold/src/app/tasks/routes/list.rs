use super::commands::require_codex_thread_connection;
use super::membership::{task_described_as, unavailable_archived_task};
use super::store::task_store_list_archived;
use super::{
    TASK_CANONICAL_READ_CONCURRENCY, TASK_LIST_PAGE_SIZE, TaskListRemoval, TaskListResponse,
    TaskListUpdate, TasksQuery,
};
use crate::agent::AgentError;
use crate::agent::Conversation;
use crate::app::error::ApiError;
use crate::app::tasks::active_list;
use crate::app::tasks::{TaskDetailSync, TaskRecord, TaskState, task_activity_ms};
use crate::task_store::ManagedThread;
use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderValue, header};
use axum::response::Response;
use futures_util::StreamExt;
use futures_util::stream;
use serde::Serialize;
use std::collections::VecDeque;
use std::convert::Infallible;
use tokio::sync::broadcast;

pub(super) async fn list_managed_tasks(
    State(state): State<TaskState>,
    Query(_query): Query<TasksQuery>,
) -> Result<Json<active_list::ActiveTaskProjection>, ApiError> {
    active_list::load_cached(state.fs, state.task_store)
        .await
        .map(Json)
}

pub(super) async fn list_archived_tasks(
    State(state): State<TaskState>,
    Query(query): Query<TasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let (archived, next_cursor) =
        task_store_list_archived(&state, query.cursor.as_deref(), TASK_LIST_PAGE_SIZE).await?;
    let reads = stream::iter(archived)
        .map(|managed| {
            let state = state.clone();
            async move {
                let task = archived_task(&state, &managed).await?;
                let activity_ms = task_activity_ms(&task);
                Ok::<_, ApiError>((task, activity_ms))
            }
        })
        .buffer_unordered(TASK_CANONICAL_READ_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;
    let mut tasks = reads.into_iter().collect::<Result<Vec<_>, ApiError>>()?;
    tasks.sort_by(|(left, _), (right, _)| {
        task_activity_ms(right)
            .cmp(&task_activity_ms(left))
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    let tasks = tasks.into_iter().map(|(task, _)| task).collect();
    Ok(Json(TaskListResponse { tasks, next_cursor }))
}

/// One row of the archived list, described by the agent that runs it.
///
/// Only one thing on the row needs the agent at all: whether there is still a
/// conversation to go back to, which is what decides whether restoring is
/// offered. The name, the worktree, and when it was last seen are Caffold's own
/// and come from the row.
///
/// Codex answers by reading the thread, which also describes it. Claude cannot
/// be asked without being started, and starting a session for every archived
/// Task in a list would start them all — so the answer is whether the agent
/// still has the conversation written down, which costs a look at the
/// filesystem.
async fn archived_task(state: &TaskState, managed: &ManagedThread) -> Result<TaskRecord, ApiError> {
    let driver = match state.task_runtime.agent_for(managed).await {
        Ok(agent) => agent.driver(),
        // An agent held by its own readiness cannot be asked about this row,
        // and the row is still Caffold's to list. Whether it can be gone back
        // to is unknown, so restoring is withheld until the agent can say —
        // one held agent must not take the whole list down with it. The row
        // says why it cannot be asked about, because held is not gone: a row
        // reading as lost invites deleting a Task that is fine.
        Err(AgentError::Held(diagnostic)) => {
            let mut task = unavailable_archived_task(managed);
            task.preview = diagnostic;
            return Ok(task);
        }
        Err(error) => return Err(error.into()),
    };
    let described = match driver.describe(&managed.thread_id).await {
        Ok(described) => described,
        // A conversation the agent no longer has is a Task that can be listed
        // but not gone back to, which the row says for itself. Anything else
        // going wrong is the list failing rather than one row being empty.
        Err(AgentError::ConversationGone(_)) => {
            return Ok(unavailable_archived_task(managed));
        }
        Err(error) => return Err(error.into()),
    };
    if let Some(conversation) = &described {
        state
            .task_sessions
            .observe_thread_metadata(conversation.clone())
            .await;
    }
    task_described_as(state, &driver, managed, described).await
}

pub(super) async fn task_list_stream(State(state): State<TaskState>) -> Result<Response, ApiError> {
    let receivers = TaskEventReceivers::subscribe(&state);
    let initial_frames = task_list_stream_initial_frames(&state).await?;
    Ok(task_list_event_stream(receivers, initial_frames))
}

struct TaskEventReceivers {
    sync: broadcast::Receiver<TaskDetailSync>,
    removals: broadcast::Receiver<TaskListRemoval>,
    updates: broadcast::Receiver<TaskListUpdate>,
    shutdown: broadcast::Receiver<()>,
}

impl TaskEventReceivers {
    fn subscribe(state: &TaskState) -> Self {
        let (removals, updates) = state.task_list_events.subscribe();
        Self {
            sync: state.task_sync.subscribe_updates(),
            removals,
            updates,
            shutdown: state.shutdown.subscribe(),
        }
    }
}

struct TaskEventStreamState {
    receivers: TaskEventReceivers,
    initial_frames: VecDeque<Bytes>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskListSync<'a> {
    thread_id: &'a str,
    revision: u64,
    task: Option<&'a TaskRecord>,
}

impl<'a> TaskListSync<'a> {
    fn from_detail(sync: &'a TaskDetailSync) -> Self {
        Self {
            thread_id: &sync.thread_id,
            revision: sync.revision,
            task: sync.detail.task.as_ref(),
        }
    }
}

pub(super) async fn task_list_stream_initial_frames(
    state: &TaskState,
) -> Result<VecDeque<Bytes>, ApiError> {
    let connection = require_codex_thread_connection(state).await?;
    let projection = active_list::load_runtime_snapshot(
        state.fs.clone(),
        state.task_store.clone(),
        &state.task_sessions,
        connection.generation,
        &connection.client,
        state.task_runtime.claude(),
    )
    .await?;
    for thread in projection.observed_threads {
        state
            .task_sessions
            .observe_listed_thread_metadata(connection.generation, Conversation::from(&thread))
            .await;
    }
    let payload = serde_json::to_string(&projection.snapshot).map_err(|error| {
        ApiError::Internal(format!("failed to serialize Task snapshot: {error}"))
    })?;
    let mut frames = VecDeque::with_capacity(2);
    frames.push_back(Bytes::from_static(b": ready\n\n"));
    frames.push_back(Bytes::from(format!(
        "event: task-list-snapshot\ndata: {payload}\n\n"
    )));
    Ok(frames)
}

fn task_list_event_stream(
    receivers: TaskEventReceivers,
    initial_frames: VecDeque<Bytes>,
) -> Response {
    let stream = stream::unfold(
        TaskEventStreamState {
            receivers,
            initial_frames,
        },
        |mut state| async move {
            if let Some(frame) = state.initial_frames.pop_front() {
                return Some((Ok::<_, Infallible>(frame), state));
            }
            loop {
                tokio::select! {
                    _ = state.receivers.shutdown.recv() => return None,
                    message = state.receivers.removals.recv() => {
                        match message {
                            Ok(removal) => {
                                let payload = serde_json::to_string(&removal)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-removed\ndata: {payload}\n\n");
                                return Some((Ok::<_, Infallible>(Bytes::from(frame)), state));
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                    message = state.receivers.updates.recv() => {
                        match message {
                            Ok(TaskListUpdate::Task(task)) => {
                                let payload = serde_json::to_string(&task)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-updated\ndata: {payload}\n\n");
                                return Some((Ok::<_, Infallible>(Bytes::from(frame)), state));
                            }
                            Ok(TaskListUpdate::Placement(update)) => {
                                let payload = serde_json::to_string(&update)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-placed-at-top\ndata: {payload}\n\n");
                                return Some((Ok::<_, Infallible>(Bytes::from(frame)), state));
                            }
                            Ok(TaskListUpdate::SectionComposerSettings(update)) => {
                                let payload = serde_json::to_string(&update)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: section-composer-settings\ndata: {payload}\n\n");
                                return Some((Ok::<_, Infallible>(Bytes::from(frame)), state));
                            }
                            Ok(TaskListUpdate::Refresh) => {
                                let frame = "event: task-list-refresh\ndata: {}\n\n";
                                return Some((Ok::<_, Infallible>(Bytes::from_static(frame.as_bytes())), state));
                            }
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                    message = state.receivers.sync.recv() => {
                        match message {
                            Ok(sync) => {
                                let payload = serde_json::to_string(&TaskListSync::from_detail(&sync))
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-sync\ndata: {payload}\n\n");
                                return Some((Ok::<_, Infallible>(Bytes::from(frame)), state));
                            }
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

#[cfg(test)]
mod tests {
    use super::super::commands::managed_thread_from_task_record;
    use super::super::store::{task_store_archive, task_store_claim, task_store_get_archived};
    use crate::agent::codex::CodexThreadClient;
    use crate::agent::codex::CodexThreadError;
    use serde_json::{Value as JsonValue, json};

    use super::super::test_support::*;
    use super::*;
    use crate::agent::codex::{
        CodexNotification,
        CodexRuntimeEvent,
        CodexThread,
        MockCodexResponse,
        // Codex's own thread status, against the shared one this file already names.
        ThreadStatus as CodexThreadStatus,
    };
    use crate::{
        agent,
        app::tasks::{projection::*, test_support::*},
        fs::RootedFs,
        task_store::{ComposerSettings, ManagedSection},
    };

    #[tokio::test]
    async fn task_list_stream_serializes_targeted_section_composer_settings_updates() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let response =
            task_list_event_stream(TaskEventReceivers::subscribe(&state), VecDeque::new());
        let mut body = response.into_body().into_data_stream();

        state
            .task_list_events
            .section_composer_settings(&ManagedSection {
                section_id: "section-settings".to_string(),
                logical_path: "Workspace/settings".to_string(),
                position: 0,
                last_composer_settings: Some(ComposerSettings {
                    model: Some("gpt-section".to_string()),
                    reasoning_effort: Some("xhigh".to_string()),
                    fast_mode: true,
                }),
            });

        let frame = tokio::time::timeout(std::time::Duration::from_secs(1), body.next())
            .await
            .expect("targeted Section settings frame")
            .expect("task list stream remains open")
            .unwrap();
        assert_eq!(
            frame.as_ref(),
            b"event: section-composer-settings\ndata: {\"sectionId\":\"section-settings\",\"composerSettings\":{\"model\":\"gpt-section\",\"effort\":\"xhigh\",\"fastMode\":true}}\n\n"
        );
        assert_eq!(state.task_list_events.refresh_count(), 0);
    }

    #[tokio::test]
    async fn managed_list_never_projects_pending_approval_onto_thread_status() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-stale-approval";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(
            &state,
            thread_id,
            "Stable cached name",
            2_000,
            "section-root",
            "",
        );
        let before = cached_projection_rows(&state);

        let response = list_managed_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
            .await
            .unwrap();

        let tasks = projected_active_tasks(&response.0);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "Stable cached name");
        assert_eq!(tasks[0].thread_status, agent::ThreadStatus::NotLoaded);
        assert!(client.mock_requests().await.is_empty());
        assert_eq!(cached_projection_rows(&state), before);
    }

    #[tokio::test]
    async fn managed_list_projects_persisted_completion_time_and_unseen_state() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-completed-in-background";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let thread: CodexThread =
            serde_json::from_value(thread).expect("the fixture decodes as a Codex thread");
        let conversation = Conversation::from(&thread);
        let resolved = resolve_conversation_cwd(&state.fs, &conversation);
        let task = task_record_from_conversation(&conversation, &[], resolved.as_ref());
        task_store_claim(
            &state,
            managed_thread_from_task_record(&task, None, None, false),
        )
        .await
        .unwrap();
        state
            .task_store
            .update_completed_at(thread_id, 5_000)
            .unwrap();

        let response = list_managed_tasks(State(state), Query(TasksQuery { cursor: None }))
            .await
            .unwrap();

        let tasks = projected_active_tasks(&response.0);
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].last_completed_ms, Some(5_000));
        assert!(tasks[0].unseen);
    }

    #[tokio::test]
    async fn archived_list_uses_the_cached_name_without_persisting_read_observations() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-archived-stale-read";
        let mut thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        thread["name"] = json!("Stale Codex name");
        thread["updatedAt"] = json!(99.0);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread }),
        )]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        state
            .task_store
            .update_display_name(thread_id, "Stable cached name")
            .unwrap();
        task_store_archive(&state, thread_id)
            .await
            .unwrap()
            .unwrap();
        let before = task_store_get_archived(&state, thread_id)
            .await
            .unwrap()
            .unwrap();

        let response =
            list_archived_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
                .await
                .expect("archived list succeeds");

        assert_eq!(response.0.tasks[0].title, "Stable cached name");
        assert_eq!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .unwrap(),
            before,
            "archived GET must not persist canonical observations"
        );
    }

    #[tokio::test]
    async fn an_agent_held_by_readiness_costs_its_rows_answer_and_not_the_list() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-archived-held";
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        task_store_archive(&state, thread_id)
            .await
            .unwrap()
            .unwrap();
        state.task_runtime.hold_codex_readiness_for_tests().await;

        let response = list_archived_tasks(State(state), Query(TasksQuery { cursor: None }))
            .await
            .expect("the list answers")
            .0;

        assert_eq!(response.tasks.len(), 1);
        assert_eq!(response.tasks[0].thread_id, thread_id);
        assert!(
            !response.tasks[0].conversation_available,
            "an unaskable agent cannot promise the conversation is there: {:?}",
            response.tasks[0]
        );
        assert_eq!(
            response.tasks[0].preview, "Codex is held for this test.",
            "held reads as held, not as a conversation that is gone"
        );
    }

    #[tokio::test]
    async fn archived_list_fails_as_a_whole_without_updating_recency_on_read_error() {
        let root = tempfile::tempdir().unwrap();
        let good_id = "thread-archived-good";
        let failed_id = "thread-archived-failed";
        let mut good_thread = task_thread_list(good_id, root.path())["data"][0].clone();
        good_thread["updatedAt"] = json!(99.0);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/read", json!({ "thread": good_thread })),
            MockCodexResponse::error("thread/read", CodexThreadError::ProcessUnavailable),
        ]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        for thread_id in [good_id, failed_id] {
            manage_test_thread(&state, thread_id, root.path()).await;
            task_store_archive(&state, thread_id)
                .await
                .unwrap()
                .unwrap();
        }
        let before = task_store_get_archived(&state, good_id)
            .await
            .unwrap()
            .unwrap()
            .last_observed_recency_ms;

        let result =
            list_archived_tasks(State(state.clone()), Query(TasksQuery { cursor: None })).await;

        assert!(matches!(result, Err(ApiError::Agent(_))));
        assert_eq!(
            task_store_get_archived(&state, good_id)
                .await
                .unwrap()
                .unwrap()
                .last_observed_recency_ms,
            before,
            "a failed archived page must not partially update its recency cache"
        );
    }

    #[tokio::test]
    async fn managed_list_keeps_cached_unplaced_threads_when_codex_is_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let good_id = "thread-good";
        let failed_id = "thread-failed";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, good_id, root.path()).await;
        manage_test_thread(&state, failed_id, root.path()).await;
        let before = cached_projection_rows(&state);

        let projection = list_managed_tasks(
            State(state.clone()),
            Query(TasksQuery {
                cursor: Some("ignored-active-cursor".to_string()),
            }),
        )
        .await
        .expect("recoverable Active projection")
        .0;

        assert!(projection.sections.is_empty());
        assert_eq!(projection.unsectioned.len(), 2);
        assert!(
            projection
                .unsectioned
                .iter()
                .all(|task| !task.conversation_available)
        );
        assert!(
            projection
                .unsectioned
                .iter()
                .any(|task| task.thread_id == good_id)
        );
        assert!(
            projection
                .unsectioned
                .iter()
                .any(|task| task.thread_id == failed_id)
        );
        assert!(client.mock_requests().await.is_empty());
        assert_eq!(cached_projection_rows(&state), before);
    }

    #[tokio::test]
    async fn managed_list_returns_all_active_tasks_inside_section_boundaries() {
        let root = tempfile::tempdir().unwrap();
        let mut thread_ids = Vec::new();
        for index in 0..TASK_LIST_PAGE_SIZE {
            let thread_id = format!("thread-{index:02}");
            thread_ids.push(thread_id);
        }
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        for (index, thread_id) in thread_ids.iter().enumerate() {
            claim_cached_active(
                &state,
                thread_id,
                &format!("Task {index:02}"),
                index as u64,
                "section-root",
                "",
            );
        }

        let projection = list_managed_tasks(State(state), Query(TasksQuery { cursor: None }))
            .await
            .unwrap()
            .0;
        assert_eq!(projection.sections.len(), 1);
        assert_eq!(projection.sections[0].tasks.len(), TASK_LIST_PAGE_SIZE);
        assert!(projection.unsectioned.is_empty());
        assert!(client.mock_requests().await.is_empty());
    }

    #[tokio::test]
    async fn task_list_stream_pages_global_threads_and_sends_one_managed_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let first_id = "thread-list-stream-first";
        let second_id = "thread-list-stream-second";
        let mut first = task_thread_list(first_id, root.path())["data"][0].clone();
        first["name"] = json!("Stale list name");
        first["status"] = json!({ "type": "active", "activeFlags": [] });
        let mut second = task_thread_list(second_id, root.path())["data"][0].clone();
        second["name"] = json!("Another stale list name");
        let unmanaged = task_thread_list("unmanaged-thread", root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "thread/list",
                json!({
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                }),
                json!({
                    "data": [unmanaged, first],
                    "nextCursor": "page-2",
                    "backwardsCursor": null,
                }),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                json!({
                    "cursor": "page-2",
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                }),
                json!({
                    "data": [second],
                    "nextCursor": null,
                    "backwardsCursor": null,
                }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(
            &state,
            first_id,
            "Persisted first name",
            7,
            "section-list-stream-bootstrap",
            "",
        );
        claim_cached_active(
            &state,
            second_id,
            "Persisted second name",
            8,
            "section-list-stream-bootstrap",
            "",
        );
        claim_cached_active(
            &state,
            "managed-but-missing",
            "Keep cached when absent",
            9,
            "section-list-stream-bootstrap",
            "",
        );
        let before = cached_projection_rows(&state);
        state.task_runtime.spawn_test_bridge(client.clone(), 1);

        let response = task_list_stream(State(state.clone())).await.unwrap();
        let mut body = response.into_body().into_data_stream();
        let first = tokio::time::timeout(std::time::Duration::from_millis(50), body.next())
            .await
            .expect("task list stream sends its ready frame")
            .expect("task list stream remains open")
            .unwrap();
        let second = tokio::time::timeout(std::time::Duration::from_millis(50), body.next())
            .await
            .expect("task list stream replays the current runtime snapshot")
            .expect("task list stream remains open")
            .unwrap();

        assert_eq!(first.as_ref(), b": ready\n\n");
        let second = std::str::from_utf8(&second).unwrap();
        let payload = second
            .strip_prefix("event: task-list-snapshot\ndata: ")
            .and_then(|frame| frame.strip_suffix("\n\n"))
            .expect("aggregate Task snapshot frame");
        let payload: JsonValue = serde_json::from_str(payload).unwrap();
        assert_eq!(payload["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(payload["tasks"][0]["threadId"], first_id);
        assert_eq!(payload["tasks"][0]["title"], "Persisted first name");
        assert_eq!(payload["tasks"][0]["threadStatus"]["type"], "active");
        assert_eq!(payload["tasks"][1]["threadId"], second_id);
        assert_eq!(payload["tasks"][1]["title"], "Persisted second name");
        assert!(!second.contains("unmanaged-thread"));
        assert!(!second.contains("managed-but-missing"));
        client.mock_publish_event(CodexRuntimeEvent::Notification(
            CodexNotification::ThreadStatusChanged {
                thread_id: first_id.to_string(),
                status: CodexThreadStatus::Idle,
            },
        ));
        let third = tokio::time::timeout(std::time::Duration::from_millis(100), body.next())
            .await
            .expect("tracked global Thread publishes later status changes")
            .expect("task list stream remains open")
            .unwrap();
        let third = std::str::from_utf8(&third).unwrap();
        let payload = third
            .strip_prefix("event: task-sync\ndata: ")
            .and_then(|frame| frame.strip_suffix("\n\n"))
            .expect("Task list runtime sync frame");
        let payload: JsonValue = serde_json::from_str(payload).unwrap();
        assert_eq!(payload["threadId"], first_id);
        assert!(payload["revision"].as_u64().is_some());
        assert_eq!(payload["task"]["title"], "Persisted first name");
        assert_eq!(payload["task"]["threadStatus"]["type"], "idle");
        assert_eq!(payload.as_object().unwrap().len(), 3);
        assert!(payload.get("detail").is_none());
        assert!(payload.get("reason").is_none());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), body.next())
                .await
                .is_err(),
            "one complete snapshot must replace per-Task bootstrap frames"
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, params)| (method, params.get("cursor").cloned()))
                .collect::<Vec<_>>(),
            [
                ("thread/list".to_string(), None),
                ("thread/list".to_string(), Some(json!("page-2"))),
            ]
        );
        assert_eq!(cached_projection_rows(&state), before);
    }

    #[tokio::test]
    async fn task_list_stream_rejects_incomplete_pagination_without_mutating_the_cache() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-list-repeated-cursor";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/list",
                json!({
                    "data": [thread],
                    "nextCursor": "repeated",
                    "backwardsCursor": null,
                }),
            ),
            MockCodexResponse::ok(
                "thread/list",
                json!({
                    "data": [],
                    "nextCursor": "repeated",
                    "backwardsCursor": null,
                }),
            ),
        ]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        claim_cached_active(
            &state,
            thread_id,
            "Persisted name",
            7,
            "section-repeated-cursor",
            "",
        );
        let before = cached_projection_rows(&state);

        let result = task_list_stream(State(state.clone())).await;

        assert!(matches!(
            result,
            Err(ApiError::Agent(message)) if message.contains("repeated")
        ));
        assert_eq!(cached_projection_rows(&state), before);
    }

    #[tokio::test]
    async fn task_list_stream_queues_updates_observed_while_building_its_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-list-snapshot-race";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/list",
            json!({
                "data": [thread.clone()],
                "nextCursor": null,
                "backwardsCursor": null,
            }),
            std::time::Duration::from_millis(50),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(
            &state,
            thread_id,
            "Persisted name",
            7,
            "section-snapshot-race",
            "",
        );

        let stream_state = state.clone();
        let stream_task = tokio::spawn(async move {
            task_list_stream(State(stream_state))
                .await
                .expect("Task list stream opens")
        });
        wait_for_mock_method(&client, "thread/list").await;
        let thread: CodexThread =
            serde_json::from_value(thread).expect("the fixture decodes as a Codex thread");
        let conversation = Conversation::from(&thread);
        let resolved = resolve_conversation_cwd(&state.fs, &conversation);
        let mut queued = task_record_from_conversation(&conversation, &[], resolved.as_ref());
        queued.title = "Queued after subscription".to_string();
        state.task_list_events.update(queued);

        let response = stream_task.await.unwrap();
        let mut body = response.into_body().into_data_stream();
        let mut frames = Vec::new();
        for _ in 0..3 {
            frames.push(
                tokio::time::timeout(std::time::Duration::from_millis(100), body.next())
                    .await
                    .expect("expected stream frame")
                    .expect("stream remains open")
                    .unwrap(),
            );
        }

        assert_eq!(frames[0].as_ref(), b": ready\n\n");
        assert!(
            std::str::from_utf8(&frames[1])
                .unwrap()
                .starts_with("event: task-list-snapshot\ndata: ")
        );
        let queued = std::str::from_utf8(&frames[2]).unwrap();
        assert!(queued.starts_with("event: task-updated\ndata: "));
        assert!(queued.contains("Queued after subscription"));
    }
}
