use super::super::super::*;
use super::super::projection::*;
use super::support::*;
use crate::codex_app_server::{ThreadStatus, TurnStatus};

#[tokio::test]
async fn rollout_invalidation_never_synthesizes_thread_activity() {
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
            "thread/read",
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
                }
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/turns/list",
            json!({
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
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
    state
        .task_sync
        .observe_rollout_invalidation(thread_id.to_string());

    wait_for_mock_method(&client, "thread/read").await;
    let snapshot = state
        .codex_sessions
        .snapshot(thread_id)
        .await
        .expect("thread session");

    drop(response);
    assert_eq!(
        snapshot.thread.expect("canonical thread").status,
        ThreadStatus::Idle,
        "rollout contents only invalidate the canonical app-server snapshot"
    );
    assert_eq!(snapshot.active_turn_id, None);
}

#[tokio::test]
async fn background_sync_timeout_broadcasts_error_and_rejects_stale_detail() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-background-sync-timeout";
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::error(
        "thread/read",
        crate::codex_app_server::CodexThreadError::RequestTimeout {
            method: "thread/read",
            request_id: 29,
            timeout_ms: 120_000,
        },
    )]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
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

    let sync = tokio::time::timeout(Duration::from_millis(50), sync_events.recv())
        .await
        .expect("a background timeout broadcasts unavailable state")
        .expect("task sync channel remains open");
    assert_eq!(sync.thread_id, thread_id);
    assert_eq!(sync.detail.sync_state, TaskSyncState::Loading);
    assert!(sync.detail.task.is_none());
    assert!(sync.error.is_some());

    let error = task_detail(
        State(state.clone()),
        AxumPath(thread_id.to_string()),
        Query(TaskDetailQuery { cursor: None }),
    )
    .await
    .expect_err("stale detail is rejected after a background sync timeout");
    assert!(matches!(error, ApiError::CodexThread(_)));

    let snapshot = state
        .codex_sessions
        .snapshot(thread_id)
        .await
        .expect("cached session remains tracked");
    assert!(snapshot.thread.is_some());
    assert!(snapshot.last_error.is_some());
    assert_eq!(state.codex_runtime.diagnostics().await, (1, true));
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

    let mut task = task_record_from_thread(&thread, &[], None).unwrap();
    apply_canonical_turn_projection(&mut task, &thread).unwrap();

    assert_eq!(task.thread_status, ThreadStatus::Idle);
    assert_eq!(task.active_turn, None);
}
