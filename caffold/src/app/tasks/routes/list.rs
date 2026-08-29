use super::*;
use crate::agent::AgentError;

pub(super) async fn list_managed_tasks(
    State(state): State<TaskState>,
    Query(_query): Query<TasksQuery>,
) -> Result<Json<super::super::active_list::ActiveTaskProjection>, ApiError> {
    super::super::active_list::load_cached(state.fs, state.task_store)
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_support::*;
    use super::*;
    use crate::{
        agent,
        app::tasks::{projection::*, test_support::*},
        fs::RootedFs,
    };

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
        let thread: crate::agent::codex::CodexThread =
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
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
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
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": good_thread }),
            ),
            crate::agent::codex::MockCodexResponse::error(
                "thread/read",
                CodexThreadError::ProcessUnavailable,
            ),
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
}
