use super::*;

pub(super) async fn task_reorder(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Json(request): Json<TaskReorderRequest>,
) -> Result<Json<TaskReorderResponse>, ApiError> {
    let before_thread_id = request
        .before_thread_id
        .map(|thread_id| thread_id.trim().to_string());
    if before_thread_id.as_deref() == Some("") {
        return Err(ApiError::BadRequest {
            code: "task_reorder_anchor_invalid",
            message: "beforeThreadId must be a non-empty Thread ID or null".to_string(),
        });
    }

    let store = state.task_store.clone();
    let moved_thread_id = thread_id.clone();
    let requested_anchor = before_thread_id.clone();
    let changed = tokio::task::spawn_blocking(move || {
        store.transaction(|tables| {
            tables.move_managed_thread_before(&moved_thread_id, requested_anchor.as_deref())
        })
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)?;
    if changed {
        state.task_list_events.refresh();
    }
    Ok(Json(TaskReorderResponse {
        thread_id,
        before_thread_id,
        changed,
    }))
}

pub(super) async fn section_reorder(
    State(state): State<TaskState>,
    AxumPath(section_id): AxumPath<String>,
    Json(request): Json<SectionReorderRequest>,
) -> Result<Json<SectionReorderResponse>, ApiError> {
    let before_section_id = request
        .before_section_id
        .map(|section_id| section_id.trim().to_string());
    if before_section_id.as_deref() == Some("") {
        return Err(ApiError::BadRequest {
            code: "section_reorder_anchor_invalid",
            message: "beforeSectionId must be a non-empty Section ID or null".to_string(),
        });
    }

    let store = state.task_store.clone();
    let moved_section_id = section_id.clone();
    let requested_anchor = before_section_id.clone();
    let changed = tokio::task::spawn_blocking(move || {
        store.transaction(|tables| {
            tables.move_managed_section_before(&moved_section_id, requested_anchor.as_deref())
        })
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)?;
    if changed {
        state.task_list_events.refresh();
    }
    Ok(Json(SectionReorderResponse {
        section_id,
        before_section_id,
        changed,
    }))
}

pub(super) fn task_store_join_error(error: tokio::task::JoinError) -> ApiError {
    ApiError::Internal(format!("task store worker failed: {error}"))
}

pub(super) async fn task_archive(
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
    let task = state
        .detail
        .record_from_conversation(&Conversation::from(&thread))?;
    state
        .lifecycle
        .preflight_archive_worktree(thread_id.clone())
        .await?;
    connection.client.archive_thread(&thread_id).await?;
    let worktree = match state.lifecycle.archive_worktree(thread_id.clone()).await {
        Ok(worktree) => worktree,
        Err(error) => {
            if let Err(rollback_error) = connection.client.unarchive_thread(&thread_id).await {
                eprintln!(
                    "failed to unarchive Codex thread after worktree archive failure: {rollback_error}"
                );
            }
            return Err(error);
        }
    };
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

pub(super) async fn task_recovery_restore(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRestoreResponse>, ApiError> {
    let Some(managed) = task_store_get(&state, &thread_id).await? else {
        return Err(task_not_managed_error());
    };
    let connection = require_codex_thread_connection(&state).await?;
    let (thread, unarchived) =
        match super::super::recovery::locate_thread(&connection.client, &thread_id).await? {
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
    let mut task = state
        .detail
        .record_from_conversation(&Conversation::from(&thread))?;
    apply_managed_thread_metadata(&mut task, &managed);
    let placement = match state.lifecycle.place_active_task(&task).await {
        Ok(Some(placement)) => placement,
        Ok(None) => {
            if unarchived {
                let _ = connection.client.archive_thread(&thread_id).await;
                state.codex_sessions.forget_thread(&thread_id).await;
            }
            return Err(task_not_managed_error());
        }
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

pub(super) async fn task_recovery_recheck(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<ActiveTaskRecovery>, ApiError> {
    let Some(managed) = task_store_get(&state, &thread_id).await? else {
        return Err(task_not_managed_error());
    };
    let connection = require_codex_thread_connection(&state).await?;
    let recovery = match super::super::recovery::locate_thread(&connection.client, &thread_id)
        .await?
    {
        ManagedCodexThreadLocation::Active(thread) => {
            match state
                .detail
                .record_from_conversation(&Conversation::from(&thread))
            {
                Ok(mut task) => {
                    apply_managed_thread_metadata(&mut task, &managed);
                    task.conversation_available = false;
                    ActiveTaskRecovery::new(task, ActiveTaskRecoveryReason::SectionPlacementPending)
                }
                Err(_) => super::super::recovery::cached_recovery(
                    &managed,
                    ActiveTaskRecoveryReason::TemporarilyUnavailable,
                ),
            }
        }
        ManagedCodexThreadLocation::Archived(thread) => {
            match state
                .detail
                .record_from_conversation(&Conversation::from(&thread))
            {
                Ok(mut task) => {
                    apply_managed_thread_metadata(&mut task, &managed);
                    task.conversation_available = false;
                    ActiveTaskRecovery::new(task, ActiveTaskRecoveryReason::CodexArchived)
                }
                Err(_) => super::super::recovery::cached_recovery(
                    &managed,
                    ActiveTaskRecoveryReason::TemporarilyUnavailable,
                ),
            }
        }
        ManagedCodexThreadLocation::Missing => super::super::recovery::cached_recovery(
            &managed,
            ActiveTaskRecoveryReason::ThreadMissing,
        ),
    };
    Ok(Json(recovery))
}

pub(super) async fn task_recovery_archive(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRecord>, ApiError> {
    let Some(managed) = task_store_get(&state, &thread_id).await? else {
        return Err(task_not_managed_error());
    };
    let connection = require_codex_thread_connection(&state).await?;
    let thread = match super::super::recovery::locate_thread(&connection.client, &thread_id).await?
    {
        ManagedCodexThreadLocation::Archived(thread) => thread,
        ManagedCodexThreadLocation::Active(_) | ManagedCodexThreadLocation::Missing => {
            return Err(task_recovery_changed_error());
        }
    };
    let mut task = state
        .detail
        .record_from_conversation(&Conversation::from(&thread))?;
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

pub(super) async fn task_recovery_remove(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskDeleteResponse>, ApiError> {
    if task_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let connection = require_codex_thread_connection(&state).await?;
    if !matches!(
        super::super::recovery::locate_thread(&connection.client, &thread_id).await?,
        ManagedCodexThreadLocation::Missing
    ) {
        return Err(task_recovery_changed_error());
    }

    let worktree = task_store_worktree_for_thread(&state, &thread_id).await?;
    let archived_worktree = state.lifecycle.archive_worktree(thread_id.clone()).await?;
    match task_store_delete_task_rows(
        &state,
        &thread_id,
        ManagedTaskMembership::Active,
        worktree
            .as_ref()
            .map(|worktree| worktree.worktree_id.as_str()),
    )
    .await
    {
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
    notify_task_removed(&state, &thread_id, "deleted");
    Ok(Json(TaskDeleteResponse { thread_id }))
}

pub(super) async fn task_restore(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
) -> Result<Json<TaskRestoreResponse>, ApiError> {
    let Some(archived) = task_store_get_archived(&state, &thread_id).await? else {
        return Err(task_not_archived_error());
    };
    let connection = require_codex_thread_connection(&state).await?;
    let thread = match connection.client.unarchive_thread(&thread_id).await {
        Ok(thread) => thread,
        Err(error) => return Err(error.into()),
    };
    let worktree = match state.lifecycle.restore_worktree(thread_id.clone()).await {
        Ok(worktree) => worktree,
        Err(error) => {
            if let Err(rollback_error) = connection.client.archive_thread(&thread_id).await {
                eprintln!(
                    "failed to re-archive Codex thread after worktree restore failure: {rollback_error}"
                );
            }
            return Err(error);
        }
    };
    state
        .codex_sessions
        .observe_thread_metadata(thread.clone())
        .await;
    let mut task = state
        .detail
        .record_from_conversation(&Conversation::from(&thread))?;
    apply_managed_thread_metadata(&mut task, &archived);
    let placement = match state.lifecycle.restore_active_task(&task).await {
        Ok(Some(placement)) => placement,
        Ok(None) => {
            rollback_task_restore(&state, &connection.client, &thread_id, &worktree).await;
            return Err(task_not_archived_error());
        }
        Err(error) => {
            rollback_task_restore(&state, &connection.client, &thread_id, &worktree).await;
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

pub(super) async fn task_delete(
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
    let deleted = task_store_delete_task_rows(
        &state,
        &thread_id,
        ManagedTaskMembership::Archived,
        worktree
            .as_ref()
            .map(|worktree| worktree.worktree_id.as_str()),
    )
    .await?;
    if !deleted {
        return Err(task_not_archived_error());
    }
    state.lifecycle.delete_task_resources(&thread_id).await;
    notify_task_removed(&state, &thread_id, "deleted");

    Ok(Json(TaskDeleteResponse { thread_id }))
}

pub(super) async fn rollback_task_archive(
    state: &TaskState,
    client: &CodexThreadClient,
    thread_id: &str,
    worktree: &super::super::worktrees::ArchiveOutcome,
) {
    if let Err(error) = client.unarchive_thread(thread_id).await {
        eprintln!("failed to unarchive Codex thread while rolling back archive: {error}");
    }
    state
        .lifecycle
        .rollback_archived_worktree(thread_id, worktree)
        .await;
}

pub(super) async fn rollback_task_restore(
    state: &TaskState,
    client: &CodexThreadClient,
    thread_id: &str,
    worktree: &super::super::worktrees::RestoreOutcome,
) {
    if let Err(error) = client.archive_thread(thread_id).await {
        eprintln!("failed to archive Codex thread while rolling back restore: {error}");
    }
    state
        .lifecycle
        .rollback_restored_worktree(thread_id, worktree)
        .await;
}

pub(super) fn notify_task_removed(state: &TaskState, thread_id: &str, reason: &'static str) {
    state.task_list_events.remove(thread_id, reason);
}

pub(super) fn unavailable_archived_task(managed: &ManagedThread) -> TaskRecord {
    let activity_ms = managed
        .last_observed_recency_ms
        .or(managed.archived_at_ms)
        .unwrap_or(managed.claimed_at_ms);
    TaskRecord {
        id: managed.thread_id.clone(),
        thread_id: managed.thread_id.clone(),
        conversation_available: false,
        title: managed.display_name.clone(),
        preview: "Conversation unavailable".to_string(),
        thread_status: crate::agent::ThreadStatus::NotLoaded,
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

pub(super) fn task_not_archived_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_not_archived",
        message: "thread is not archived in Caffold".to_string(),
    }
}

pub(super) fn task_recovery_changed_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_recovery_changed",
        message: "Task recovery state changed; recheck the Task before trying again".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as JsonValue, json};
    use tower::ServiceExt;

    use super::super::test_support::*;
    use super::*;
    use crate::{
        app::tasks::{
            events::TaskEventRecord, recovery::ActiveTaskRecoveryAction, test_support::*,
        },
        fs::RootedFs,
    };

    #[tokio::test]
    async fn reorder_mutates_only_the_local_section_order_and_notifies_after_commit() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        state
            .codex_runtime
            .set_test_readiness(crate::agent::codex::CodexReadiness::blocking(
                crate::agent::codex::CodexReadinessState::Error,
                crate::agent::codex::CodexReadinessReason::AppServerUnavailable,
                "Codex is unavailable for this test.",
                None,
            ))
            .await;
        for id in ["thread-c", "thread-b", "thread-a"] {
            claim_cached_active(&state, id, id, 1, "section-one", "/workspace/one");
        }

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/tasks/thread-c/reorder")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"beforeThreadId":"thread-a"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: JsonValue = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["threadId"], "thread-c");
        assert_eq!(body["beforeThreadId"], "thread-a");
        assert_eq!(body["changed"], true);
        assert_eq!(state.task_list_events.refresh_count(), 1);
        let (_, mut threads) = cached_projection_rows(&state);
        threads.sort_by_key(|thread| thread.position_in_section);
        assert_eq!(
            threads
                .iter()
                .map(|thread| thread.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["thread-c", "thread-a", "thread-b"]
        );
        assert!(client.mock_requests().await.is_empty());

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/tasks/thread-c/reorder")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"beforeThreadId":"thread-a"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(state.task_list_events.refresh_count(), 1);
    }

    #[tokio::test]
    async fn reorder_rejects_stale_cross_section_and_empty_anchors_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        claim_cached_active(
            &state,
            "thread-one",
            "Thread one",
            1,
            "section-one",
            "/workspace/one",
        );
        claim_cached_active(
            &state,
            "thread-two",
            "Thread two",
            1,
            "section-two",
            "/workspace/two",
        );

        for (body, expected_status, expected_code) in [
            (
                r#"{"beforeThreadId":"missing"}"#,
                axum::http::StatusCode::CONFLICT,
                "task_reorder_conflict",
            ),
            (
                r#"{"beforeThreadId":"thread-two"}"#,
                axum::http::StatusCode::CONFLICT,
                "task_reorder_conflict",
            ),
            (
                r#"{"beforeThreadId":""}"#,
                axum::http::StatusCode::BAD_REQUEST,
                "task_reorder_anchor_invalid",
            ),
        ] {
            let response = router(state.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri("/api/tasks/thread-one/reorder")
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected_status);
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let body: JsonValue = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["error"]["code"], expected_code);
        }
        assert_eq!(state.task_list_events.refresh_count(), 0);
        let (_, threads) = cached_projection_rows(&state);
        assert_eq!(
            threads
                .iter()
                .find(|thread| thread.thread_id == "thread-one")
                .unwrap()
                .position_in_section,
            Some(0)
        );
    }

    #[tokio::test]
    async fn section_reorder_persists_canonical_order_and_refreshes_after_commit() {
        let root = tempfile::tempdir().unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        for id in ["section-a", "section-b", "section-c"] {
            seed_section(&state, id, &format!("/workspace/{id}"));
        }

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/tasks/sections/section-c/reorder")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"beforeSectionId":"section-a"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: JsonValue = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["sectionId"], "section-c");
        assert_eq!(body["beforeSectionId"], "section-a");
        assert_eq!(body["changed"], true);
        assert_eq!(state.task_list_events.refresh_count(), 1);
        let (sections, _) = cached_projection_rows(&state);
        assert_eq!(
            sections
                .iter()
                .map(|section| section.section_id.as_str())
                .collect::<Vec<_>>(),
            ["section-c", "section-a", "section-b"]
        );

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/tasks/sections/section-c/reorder")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"beforeSectionId":"section-a"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(state.task_list_events.refresh_count(), 1);
    }

    #[tokio::test]
    async fn section_reorder_rejects_missing_self_and_empty_anchors_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        seed_section(&state, "section-one", "/workspace/one");

        for (path, body, expected_status, expected_code) in [
            (
                "/api/tasks/sections/missing/reorder",
                r#"{"beforeSectionId":null}"#,
                axum::http::StatusCode::CONFLICT,
                "section_reorder_unavailable",
            ),
            (
                "/api/tasks/sections/section-one/reorder",
                r#"{"beforeSectionId":"section-one"}"#,
                axum::http::StatusCode::CONFLICT,
                "section_reorder_conflict",
            ),
            (
                "/api/tasks/sections/section-one/reorder",
                r#"{"beforeSectionId":""}"#,
                axum::http::StatusCode::BAD_REQUEST,
                "section_reorder_anchor_invalid",
            ),
        ] {
            let response = router(state.clone())
                .oneshot(
                    axum::http::Request::builder()
                        .method("POST")
                        .uri(path)
                        .header(axum::http::header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), expected_status);
            let body = axum::body::to_bytes(response.into_body(), 4096)
                .await
                .unwrap();
            let body: JsonValue = serde_json::from_slice(&body).unwrap();
            assert_eq!(body["error"]["code"], expected_code);
        }
        assert_eq!(state.task_list_events.refresh_count(), 0);
    }

    #[tokio::test]
    async fn local_ledger_failure_rolls_a_restore_back_to_archived_membership() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-section-restore-failure";
        let mut thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        thread["cwd"] = json!(root.path().join("missing").display().to_string());
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unarchive",
                json!({ "thread": thread }),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/archive", json!({})),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        task_store_archive(&state, thread_id)
            .await
            .unwrap()
            .expect("archived managed Thread");

        let result = task_restore(State(state.clone()), AxumPath(thread_id.to_string())).await;

        assert!(matches!(result, Err(ApiError::Internal(_))));
        assert!(task_store_get(&state, thread_id).await.unwrap().is_none());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/unarchive", "thread/archive"]
        );
    }

    #[tokio::test]
    async fn managed_worktree_archive_and_restore_follow_the_task_route_lifecycle() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        initialize_git_repository(&source);
        let thread_id = "thread-managed-worktree";
        let thread = || {
            json!({
                "id": thread_id,
                "preview": "Managed worktree task",
                "status": { "type": "idle" },
                "cwd": source.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 1.0,
                "turns": []
            })
        };
        let responses = vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": thread() }),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/archive", json!({})),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unarchive",
                json!({ "thread": thread() }),
            ),
        ];
        let client = CodexThreadClient::mock(responses);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, &source).await;
        state
            .lifecycle
            .isolate_current_task(
                source,
                thread_id.to_string(),
                "Managed worktree task".to_string(),
                None,
                None,
                false,
            )
            .await
            .unwrap();
        let worktree = state
            .task_store
            .worktree_for_thread(thread_id)
            .unwrap()
            .unwrap();
        assert!(std::path::Path::new(&worktree.worktree_path).is_dir());

        let _ = task_archive(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .unwrap();
        assert!(!std::path::Path::new(&worktree.worktree_path).exists());
        assert_eq!(
            state
                .task_store
                .worktree_for_thread(thread_id)
                .unwrap()
                .unwrap()
                .state,
            crate::task_store::ManagedWorktreeState::Archived
        );

        let _ = task_restore(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .unwrap();
        assert!(std::path::Path::new(&worktree.worktree_path).is_dir());
        assert_eq!(
            state
                .task_store
                .worktree_for_thread(thread_id)
                .unwrap()
                .unwrap()
                .state,
            crate::task_store::ManagedWorktreeState::Ready
        );
        assert!(state.task_store.get(thread_id).unwrap().is_some());
        assert!(state.task_store.get_archived(thread_id).unwrap().is_none());
    }

    #[tokio::test]
    async fn managed_worktree_permanent_delete_preserves_the_local_branch() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        initialize_git_repository(&source);
        let thread_id = "thread-delete-managed-worktree";
        let thread = || {
            json!({
                "id": thread_id,
                "preview": "Delete managed worktree task",
                "status": { "type": "idle" },
                "cwd": source.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 1.0,
                "turns": []
            })
        };
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": thread() }),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/archive", json!({})),
            crate::agent::codex::MockCodexResponse::ok("thread/delete", json!({})),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, &source).await;
        state
            .lifecycle
            .isolate_current_task(
                source.clone(),
                thread_id.to_string(),
                "Delete managed worktree task".to_string(),
                None,
                None,
                false,
            )
            .await
            .unwrap();
        let worktree = state
            .task_store
            .worktree_for_thread(thread_id)
            .unwrap()
            .unwrap();
        let branch_name = inspect_ready_worktree(&worktree).unwrap().branch_name;

        let _ = task_archive(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("archive succeeds");
        assert!(git_branch_exists(&source, &branch_name));

        let response = task_delete(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("delete succeeds");

        assert_eq!(response.0.thread_id, thread_id);
        assert!(state.task_store.get_archived(thread_id).unwrap().is_none());
        assert!(
            state
                .task_store
                .worktree_for_thread(thread_id)
                .unwrap()
                .is_none()
        );
        assert!(git_branch_exists(&source, &branch_name));
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/read", "thread/archive", "thread/delete"]
        );
    }

    #[tokio::test]
    async fn dirty_managed_worktree_blocks_the_task_archive_before_codex_changes_state() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        initialize_git_repository(&source);
        let thread_id = "thread-dirty-managed-worktree";
        let thread = || {
            json!({
                "id": thread_id,
                "preview": "Dirty managed worktree task",
                "status": { "type": "idle" },
                "cwd": source.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 1.0,
                "turns": []
            })
        };
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread() }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, &source).await;
        state
            .lifecycle
            .isolate_current_task(
                source,
                thread_id.to_string(),
                "Dirty managed worktree task".to_string(),
                None,
                None,
                false,
            )
            .await
            .unwrap();
        let worktree = state
            .task_store
            .worktree_for_thread(thread_id)
            .unwrap()
            .unwrap();
        std::fs::write(
            std::path::Path::new(&worktree.worktree_path).join("uncommitted.txt"),
            "keep me\n",
        )
        .unwrap();

        let result = task_archive(State(state.clone()), AxumPath(thread_id.to_string())).await;

        assert!(matches!(
            result,
            Err(ApiError::BadRequest {
                code: "managed_worktree_dirty",
                ..
            })
        ));
        assert_eq!(
            state
                .task_store
                .worktree_for_thread(thread_id)
                .unwrap()
                .unwrap()
                .state,
            crate::task_store::ManagedWorktreeState::Ready
        );
        assert!(state.task_store.get(thread_id).unwrap().is_some());
        assert!(std::path::Path::new(&worktree.worktree_path).is_dir());
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
    async fn failed_codex_archive_restores_the_managed_worktree_and_keeps_the_task_active() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        initialize_git_repository(&source);
        let thread_id = "thread-failed-archive";
        let thread = || {
            json!({
                "id": thread_id,
                "preview": "Archive rollback",
                "status": { "type": "idle" },
                "cwd": source.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 1.0,
                "turns": []
            })
        };
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": thread() }),
            ),
            crate::agent::codex::MockCodexResponse::error(
                "thread/archive",
                CodexThreadError::ProcessUnavailable,
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, &source).await;
        state
            .lifecycle
            .isolate_current_task(
                source,
                thread_id.to_string(),
                "Archive rollback".to_string(),
                None,
                None,
                false,
            )
            .await
            .unwrap();
        let worktree = state
            .task_store
            .worktree_for_thread(thread_id)
            .unwrap()
            .unwrap();

        assert!(matches!(
            task_archive(State(state.clone()), AxumPath(thread_id.to_string())).await,
            Err(ApiError::CodexThread(_))
        ));
        assert!(state.task_store.get(thread_id).unwrap().is_some());
        assert!(state.task_store.get_archived(thread_id).unwrap().is_none());
        assert_eq!(
            state
                .task_store
                .worktree_for_thread(thread_id)
                .unwrap()
                .unwrap()
                .state,
            crate::task_store::ManagedWorktreeState::Ready
        );
        assert!(std::path::Path::new(&worktree.worktree_path).is_dir());
    }

    #[tokio::test]
    async fn failed_codex_restore_removes_the_recreated_worktree_and_keeps_the_task_archived() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        initialize_git_repository(&source);
        let thread_id = "thread-failed-restore";
        let thread = || {
            json!({
                "id": thread_id,
                "preview": "Restore rollback",
                "status": { "type": "idle" },
                "cwd": source.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 1.0,
                "turns": []
            })
        };
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": thread() }),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/archive", json!({})),
            crate::agent::codex::MockCodexResponse::error(
                "thread/unarchive",
                CodexThreadError::ProcessUnavailable,
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, &source).await;
        state
            .lifecycle
            .isolate_current_task(
                source,
                thread_id.to_string(),
                "Restore rollback".to_string(),
                None,
                None,
                false,
            )
            .await
            .unwrap();
        let worktree = state
            .task_store
            .worktree_for_thread(thread_id)
            .unwrap()
            .unwrap();
        let _ = task_archive(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .unwrap();

        assert!(matches!(
            task_restore(State(state.clone()), AxumPath(thread_id.to_string())).await,
            Err(ApiError::CodexThread(_))
        ));
        assert!(state.task_store.get(thread_id).unwrap().is_none());
        assert!(state.task_store.get_archived(thread_id).unwrap().is_some());
        assert_eq!(
            state
                .task_store
                .worktree_for_thread(thread_id)
                .unwrap()
                .unwrap()
                .state,
            crate::task_store::ManagedWorktreeState::Archived
        );
        assert!(!std::path::Path::new(&worktree.worktree_path).exists());
    }

    #[tokio::test]
    async fn archive_and_restore_keep_caffold_membership_in_separate_lists() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-archive-round-trip";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let responses = vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": thread.clone() }),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/archive", json!({})),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({ "thread": thread.clone() }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unarchive",
                json!({ "thread": thread.clone() }),
            ),
        ];
        let client = CodexThreadClient::mock(responses);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        claim_cached_active(&state, "other-thread", "Other Task", 2, "section-root", "");

        let archived = task_archive(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("archive succeeds")
            .0;
        assert_eq!(archived.thread_id, thread_id);
        assert!(task_store_get(&state, thread_id).await.unwrap().is_none());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_some()
        );

        let archived_page =
            list_archived_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
                .await
                .expect("archived list succeeds");
        assert_eq!(archived_page.0.tasks[0].thread_id, thread_id);

        let restored = task_restore(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("restore succeeds")
            .0;
        assert_eq!(restored.task.thread_id, thread_id);
        assert_eq!(restored.active_top_placement.section.id, "section-root");
        assert_eq!(
            restored.active_top_placement.before_thread_id.as_deref(),
            Some("other-thread")
        );
        assert!(task_store_get(&state, thread_id).await.unwrap().is_some());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_none()
        );

        let active_page = list_managed_tasks(State(state), Query(TasksQuery { cursor: None }))
            .await
            .expect("active list succeeds");
        assert_eq!(
            projected_active_tasks(&active_page.0)[0].thread_id,
            thread_id
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
                "thread/archive",
                "thread/read",
                "thread/unarchive",
            ]
        );
    }

    #[tokio::test]
    async fn recovery_restore_unarchives_places_at_top_and_keeps_active_membership() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recovery-restore";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let mut responses = recovery_location_responses(vec![thread.clone()]);
        responses.push(crate::agent::codex::MockCodexResponse::ok(
            "thread/unarchive",
            json!({ "thread": thread }),
        ));
        let client = CodexThreadClient::mock(responses);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        claim_cached_active(&state, "other-thread", "Other Task", 2, "section-root", "");

        let restored = task_recovery_restore(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("recovery restore succeeds")
            .0;

        assert_eq!(restored.task.thread_id, thread_id);
        assert_eq!(restored.active_top_placement.section.id, "section-root");
        assert!(task_store_get(&state, thread_id).await.unwrap().is_some());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/list", "thread/list", "thread/unarchive",]
        );
    }

    #[tokio::test]
    async fn recovery_restore_places_an_active_unsectioned_task_in_the_existing_section() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recovery-active-existing-section";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(active_recovery_location_responses(vec![thread]));
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        state
            .task_store
            .claim(ManagedThread::new(thread_id, Some(1), None, None), 1)
            .unwrap();
        seed_section(&state, "section-root", "");

        let restored = task_recovery_restore(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("active unsectioned recovery restore succeeds")
            .0;

        assert_eq!(restored.active_top_placement.section.id, "section-root");
        let (sections, threads) = cached_projection_rows(&state);
        assert_eq!(sections.len(), 1);
        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].section_id.as_deref(), Some("section-root"));
        assert_eq!(threads[0].position_in_section, Some(0));
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/list"]
        );
    }

    #[tokio::test]
    async fn recovery_restore_creates_a_section_for_an_active_unsectioned_task() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recovery-active-new-section";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(active_recovery_location_responses(vec![thread]));
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        state
            .task_store
            .claim(ManagedThread::new(thread_id, Some(1), None, None), 1)
            .unwrap();

        let restored = task_recovery_restore(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("active unsectioned recovery restore succeeds")
            .0;

        let (sections, threads) = cached_projection_rows(&state);
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].logical_path, "");
        assert_eq!(
            sections[0].section_id,
            restored.active_top_placement.section.id
        );
        assert_eq!(threads.len(), 1);
        assert_eq!(
            threads[0].section_id.as_deref(),
            Some(restored.active_top_placement.section.id.as_str())
        );
        assert_eq!(threads[0].position_in_section, Some(0));
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/list"]
        );
    }

    #[tokio::test]
    async fn explicit_recovery_recheck_classifies_codex_archived_without_mutating_the_projection() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recheck-archived";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(recovery_location_responses(vec![thread]));
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        state
            .task_store
            .update_display_name(thread_id, "Stable archived name")
            .unwrap();
        let before = cached_projection_rows(&state);

        let recovery = task_recovery_recheck(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .unwrap()
            .0;

        assert_eq!(recovery.title, "Stable archived name");
        assert_eq!(
            recovery.recovery.reason,
            ActiveTaskRecoveryReason::CodexArchived
        );
        assert_eq!(
            recovery.recovery.actions,
            [
                ActiveTaskRecoveryAction::RestoreToActive,
                ActiveTaskRecoveryAction::MoveToArchived,
                ActiveTaskRecoveryAction::Recheck,
            ]
        );
        assert_eq!(cached_projection_rows(&state), before);
        assert_eq!(client.mock_requests().await.len(), 2);
    }

    #[tokio::test]
    async fn explicit_recovery_recheck_classifies_missing_without_mutating_the_projection() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recheck-missing";
        let client = CodexThreadClient::mock(recovery_location_responses(Vec::new()));
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let before = cached_projection_rows(&state);

        let recovery = task_recovery_recheck(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .unwrap()
            .0;

        assert_eq!(
            recovery.recovery.reason,
            ActiveTaskRecoveryReason::ThreadMissing
        );
        assert_eq!(
            recovery.recovery.actions,
            [
                ActiveTaskRecoveryAction::Recheck,
                ActiveTaskRecoveryAction::RemoveFromCaffold,
            ]
        );
        assert_eq!(cached_projection_rows(&state), before);
    }

    #[tokio::test]
    async fn recovery_restore_rearchives_codex_when_local_placement_fails() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recovery-restore-rollback";
        let mut thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        thread["cwd"] = json!(root.path().join("missing").display().to_string());
        let mut responses = recovery_location_responses(vec![thread.clone()]);
        responses.extend([
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unarchive",
                json!({ "thread": thread }),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/archive", json!({})),
        ]);
        let client = CodexThreadClient::mock(responses);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        assert!(matches!(
            task_recovery_restore(State(state.clone()), AxumPath(thread_id.to_string())).await,
            Err(ApiError::Internal(_))
        ));
        assert!(task_store_get(&state, thread_id).await.unwrap().is_some());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            [
                "thread/list",
                "thread/list",
                "thread/unarchive",
                "thread/archive",
            ]
        );
    }

    #[tokio::test]
    async fn recovery_archive_reconciles_membership_without_archiving_codex_again() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recovery-archive";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(recovery_location_responses(vec![thread]));
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let archived = task_recovery_archive(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("recovery archive succeeds")
            .0;

        assert_eq!(archived.thread_id, thread_id);
        assert!(!archived.conversation_available);
        assert!(task_store_get(&state, thread_id).await.unwrap().is_none());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_some()
        );
        assert!(
            client
                .mock_requests()
                .await
                .iter()
                .all(|(method, _)| method != "thread/archive")
        );
    }

    #[tokio::test]
    async fn recovery_remove_requires_codex_absence_and_deletes_active_membership() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recovery-remove";
        let client = CodexThreadClient::mock(recovery_location_responses(Vec::new()));
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let removed = task_recovery_remove(State(state.clone()), AxumPath(thread_id.to_string()))
            .await
            .expect("missing recovery removal succeeds")
            .0;

        assert_eq!(removed.thread_id, thread_id);
        assert!(task_store_get(&state, thread_id).await.unwrap().is_none());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_none()
        );
        assert!(
            client
                .mock_requests()
                .await
                .iter()
                .all(|(method, _)| method != "thread/delete")
        );
    }

    #[tokio::test]
    async fn recovery_remove_rejects_a_thread_that_reappeared_without_changing_membership() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-recovery-reappeared";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok_for(
            "thread/list",
            json!({
                "limit": 100,
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "archived": false,
                "useStateDbOnly": true,
            }),
            task_thread_list(thread_id, root.path()),
        )]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        assert!(matches!(
            task_recovery_remove(State(state.clone()), AxumPath(thread_id.to_string())).await,
            Err(ApiError::BadRequest {
                code: "task_recovery_changed",
                ..
            })
        ));
        assert!(task_store_get(&state, thread_id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn active_tasks_cannot_be_archived() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-active-archive";
        let mut thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        thread["status"] = json!({ "type": "active", "activeFlags": [] });
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let result = task_archive(State(state.clone()), AxumPath(thread_id.to_string())).await;

        assert!(matches!(
            result,
            Err(ApiError::BadRequest {
                code: "task_active",
                ..
            })
        ));
        assert!(task_store_get(&state, thread_id).await.unwrap().is_some());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_none()
        );
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
    async fn archive_failure_keeps_the_task_in_the_active_membership() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-archive-failure";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok("thread/read", json!({ "thread": thread })),
            crate::agent::codex::MockCodexResponse::error(
                "thread/archive",
                CodexThreadError::ProcessUnavailable,
            ),
        ]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let result = task_archive(State(state.clone()), AxumPath(thread_id.to_string())).await;

        assert!(matches!(result, Err(ApiError::CodexThread(_))));
        assert!(task_store_get(&state, thread_id).await.unwrap().is_some());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn restore_failure_keeps_the_task_in_the_archived_membership() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-restore-failure";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::error(
            "thread/unarchive",
            CodexThreadError::ProcessUnavailable,
        )]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        task_store_archive(&state, thread_id)
            .await
            .unwrap()
            .unwrap();

        let result = task_restore(State(state.clone()), AxumPath(thread_id.to_string())).await;

        assert!(matches!(result, Err(ApiError::CodexThread(_))));
        assert!(task_store_get(&state, thread_id).await.unwrap().is_none());
        assert!(
            task_store_get_archived(&state, thread_id)
                .await
                .unwrap()
                .is_some()
        );
    }

    #[tokio::test]
    async fn permanent_delete_rejects_tasks_outside_the_archived_membership() {
        let root = tempfile::tempdir().unwrap();
        let active_id = "thread-active-delete";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, active_id, root.path()).await;

        for thread_id in ["thread-unmanaged-delete", active_id] {
            assert!(matches!(
                task_delete(State(state.clone()), AxumPath(thread_id.to_string())).await,
                Err(ApiError::BadRequest {
                    code: "task_not_archived",
                    ..
                })
            ));
        }
        assert!(state.task_store.get(active_id).unwrap().is_some());
        assert!(client.mock_requests().await.is_empty());
    }

    #[tokio::test]
    async fn unavailable_archived_conversation_stays_listed_and_can_be_deleted() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-unavailable-delete";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::error(
                "thread/read",
                CodexThreadError::ThreadUnavailable(
                    "no rollout found for thread id thread-unavailable-delete".to_string(),
                ),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/delete", json!({})),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        task_store_archive(&state, thread_id)
            .await
            .unwrap()
            .unwrap();
        state.codex_sessions.begin_external_sync(thread_id).await;
        assert_eq!(state.codex_sessions.diagnostics().await.tracked_sessions, 1);

        let archived =
            list_archived_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
                .await
                .expect("unavailable conversation remains listable");
        assert_eq!(archived.0.tasks.len(), 1);
        assert_eq!(archived.0.tasks[0].thread_id, thread_id);
        assert!(!archived.0.tasks[0].conversation_available);
        assert_eq!(archived.0.tasks[0].preview, "Conversation unavailable");

        state.task_events.publish(TaskEventRecord {
            id: "cached-event".to_string(),
            thread_id: thread_id.to_string(),
            event_type: "agent_message".to_string(),
            summary: "cached".to_string(),
            payload: None,
            created_ms: 1,
            updated_ms: None,
            sort_index: None,
            generated_image: None,
        });
        assert_eq!(state.task_events.for_thread(thread_id).len(), 1);

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/tasks/{thread_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .expect("delete response");

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .expect("delete body");
        let body: JsonValue = serde_json::from_slice(&body).expect("delete response json");
        assert_eq!(body["threadId"], thread_id);
        assert!(state.task_store.get_archived(thread_id).unwrap().is_none());
        assert!(state.task_events.for_thread(thread_id).is_empty());
        assert_eq!(state.codex_sessions.diagnostics().await.tracked_sessions, 0);
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/read", "thread/delete"]
        );
    }

    #[tokio::test]
    async fn failed_codex_delete_keeps_the_archived_membership_for_retry() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-delete-failure";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::error(
            "thread/delete",
            CodexThreadError::ProcessUnavailable,
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        task_store_archive(&state, thread_id)
            .await
            .unwrap()
            .unwrap();

        assert!(matches!(
            task_delete(State(state.clone()), AxumPath(thread_id.to_string())).await,
            Err(ApiError::CodexThread(_))
        ));
        assert!(state.task_store.get_archived(thread_id).unwrap().is_some());
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/delete"]
        );
    }
}
