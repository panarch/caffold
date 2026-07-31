use super::super::{detail::*, projection::*, sync::*};
use super::support::*;
use super::*;
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
    let _ = test_load_tasks(state.clone(), None)
        .await
        .expect("task list succeeds");

    let response = test_task_stream(state.clone(), thread_id.to_string())
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
    let mut sync_events = state.task_sync.subscribe_updates();
    state.detail.ensure_sync_worker().await;
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

    let error = test_task_detail(state.clone(), thread_id.to_string(), None)
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
    let (shutdown, _) = broadcast::channel(1);
    let sync = TaskSync::<()>::new(shutdown);
    let mut jobs = sync.take_jobs().await.unwrap();

    sync.observe_rollout_invalidation("thread-1".to_string());
    assert!(
        tokio::time::timeout(Duration::from_millis(20), jobs.recv())
            .await
            .is_err()
    );

    let first = sync.subscribe("thread-1");
    let second = sync.subscribe("thread-1");
    sync.observe_rollout_invalidation("thread-1".to_string());
    let job = tokio::time::timeout(Duration::from_secs(1), jobs.recv())
        .await
        .expect("subscribed invalidation becomes due")
        .expect("sync job");
    assert_eq!(job.thread_id, "thread-1");
    job.complete(TaskSyncOutcome::Synchronized);

    drop(first);
    sync.observe_rollout_invalidation("thread-1".to_string());
    let job = tokio::time::timeout(Duration::from_secs(1), jobs.recv())
        .await
        .expect("remaining subscriber keeps sync active")
        .expect("sync job");
    job.complete(TaskSyncOutcome::Synchronized);

    drop(second);
    sync.observe_rollout_invalidation("thread-1".to_string());
    assert!(
        tokio::time::timeout(Duration::from_millis(50), jobs.recv())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn task_sync_coordinator_tracks_invalidations_until_canonical_sync() {
    let (shutdown, _) = broadcast::channel(1);
    let sync = TaskSync::<()>::new(shutdown);
    let mut jobs = sync.take_jobs().await.unwrap();
    let _subscription = sync.subscribe("thread-1");

    sync.observe_rollout_invalidation("thread-1".to_string());

    let job = tokio::time::timeout(Duration::from_secs(1), jobs.recv())
        .await
        .expect("invalidation becomes due")
        .expect("sync job");
    assert_eq!(job.invalidation_revision, 1);
    job.complete(TaskSyncOutcome::Synchronized);
    assert!(
        tokio::time::timeout(Duration::from_millis(50), jobs.recv())
            .await
            .is_err(),
        "a synchronized revision must not schedule itself again"
    );
}

#[tokio::test]
async fn task_sync_coordinator_keeps_changes_observed_during_a_sync() {
    let (shutdown, _) = broadcast::channel(1);
    let sync = TaskSync::<()>::new(shutdown);
    let mut jobs = sync.take_jobs().await.unwrap();
    let _subscription = sync.subscribe("thread-1");

    sync.observe_rollout_invalidation("thread-1".to_string());
    let synchronizing = tokio::time::timeout(Duration::from_secs(1), jobs.recv())
        .await
        .expect("first invalidation becomes due")
        .expect("sync job");
    let synchronizing_revision = synchronizing.invalidation_revision;

    sync.observe_rollout_invalidation("thread-1".to_string());
    synchronizing.complete(TaskSyncOutcome::Synchronized);
    let newer = tokio::time::timeout(Duration::from_secs(1), jobs.recv())
        .await
        .expect("change observed during sync is scheduled")
        .expect("newer sync job");
    assert!(newer.invalidation_revision > synchronizing_revision);
    newer.complete(TaskSyncOutcome::Synchronized);
}

#[test]
fn continuous_task_invalidations_have_a_maximum_latency() {
    let started_at = tokio::time::Instant::now();

    assert_eq!(
        scheduled_deadline_for_test(
            started_at,
            &[500, 1_000, 1_500, 1_900].map(Duration::from_millis),
        ),
        started_at + SYNC_MAX_LATENCY_FOR_TEST
    );
}

#[test]
fn canonical_sync_retries_are_bounded() {
    let started_at = tokio::time::Instant::now();

    assert_eq!(
        retry_schedule_for_test(0, started_at),
        Some((1, started_at + SYNC_RETRY_BASE_FOR_TEST))
    );
    assert_eq!(
        retry_schedule_for_test(1, started_at),
        Some((2, started_at + SYNC_RETRY_BASE_FOR_TEST.saturating_mul(2)))
    );
    assert_eq!(retry_schedule_for_test(3, started_at), None);
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
