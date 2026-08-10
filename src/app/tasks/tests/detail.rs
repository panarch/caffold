use super::super::{detail::*, events::*, projection::*};
use super::support::*;
use super::*;
use crate::codex_app_server::{ThreadStatus, TurnStatus};
use crate::codex_thread_sessions::ThreadSessionLifecycle;

#[tokio::test]
async fn cached_task_detail_restores_managed_thread_composer_settings() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-cached-model-settings";
    let client = CodexThreadClient::mock(Vec::new());
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    test_store_update_composer_settings(
        &state,
        thread_id,
        Some("gpt-5.6-sol"),
        Some("xhigh"),
        true,
    )
    .await
    .unwrap();

    let (detail, revision) = state.detail.cached(thread_id).await.unwrap();

    assert_eq!(revision, 0);
    assert!(detail.history_loading);
    assert_eq!(detail.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(detail.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(detail.fast_mode);
}

#[tokio::test]
async fn canonical_resume_refreshes_cached_model_settings() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-canonical-model-settings";
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/resume",
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Canonical model settings",
                "status": { "type": "idle" },
                "cwd": root.path().display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            },
            "model": "gpt-5.6-luna",
            "reasoningEffort": "medium",
            "serviceTier": null,
            "initialTurnsPage": {
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null
            }
        }),
    )]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    test_store_update_composer_settings(
        &state,
        thread_id,
        Some("gpt-5.6-sol"),
        Some("xhigh"),
        true,
    )
    .await
    .unwrap();

    let snapshot = state
        .codex_sessions
        .ensure_subscribed(&client, 1, thread_id)
        .await
        .unwrap();
    let detail = state
        .detail
        .assemble_snapshot(snapshot, None)
        .await
        .unwrap();

    assert_eq!(detail.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(detail.reasoning_effort.as_deref(), Some("medium"));
    assert!(!detail.fast_mode);
    let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(stored.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(stored.reasoning_effort.as_deref(), Some("medium"));
    assert!(!stored.fast_mode);
}

#[tokio::test]
async fn canonical_resume_without_model_settings_preserves_the_cached_selection() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-canonical-speed-only";
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/resume",
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Canonical speed only",
                "status": { "type": "idle" },
                "cwd": root.path().display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            },
            "serviceTier": null,
            "initialTurnsPage": {
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null
            }
        }),
    )]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    test_store_update_composer_settings(
        &state,
        thread_id,
        Some("gpt-5.6-sol"),
        Some("xhigh"),
        true,
    )
    .await
    .unwrap();

    let snapshot = state
        .codex_sessions
        .ensure_subscribed(&client, 1, thread_id)
        .await
        .unwrap();
    let detail = state
        .detail
        .assemble_snapshot(snapshot, None)
        .await
        .unwrap();

    assert_eq!(detail.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(detail.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(!detail.fast_mode);
    let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(!stored.fast_mode);
}

#[tokio::test]
async fn canonical_turn_history_recovers_missed_completion_and_marks_it_seen_when_viewed() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-missed-completion";
    let state = task_state_with_codex_client(
        RootedFs::new(root.path()).unwrap(),
        CodexThreadClient::mock(Vec::new()),
    )
    .await;
    manage_test_thread(&state, thread_id, root.path()).await;
    let thread = serde_json::from_value(json!({
        "id": thread_id,
        "preview": "Recovered completion",
        "status": { "type": "idle" },
        "cwd": root.path().display().to_string(),
        "createdAt": 1.0,
        "updatedAt": 2.0,
        "recencyAt": 2.5,
        "turns": []
    }))
    .unwrap();
    let turns_page = serde_json::from_value(json!({
        "data": [
            {
                "id": "turn-newest",
                "items": [],
                "status": "completed",
                "completedAt": 5.0
            },
            {
                "id": "turn-older",
                "items": [],
                "status": "completed",
                "completedAt": 4.0
            }
        ],
        "nextCursor": null,
        "backwardsCursor": null
    }))
    .unwrap();
    let mut snapshot = crate::codex_thread_sessions::ThreadSessionSnapshot {
        lifecycle: ThreadSessionLifecycle::Subscribed,
        thread: Some(thread),
        turns_page: Some(turns_page),
        active_turn_id: None,
        active_turn_cwd: None,
        viewer_leases: 0,
        runtime_lease: false,
        generation: 1,
        revision: 1,
        last_sync_ms: Some(5_000),
        last_error: None,
        external_syncing: false,
        external_sync_started_ms: None,
        permission_mode: None,
        model: None,
        reasoning_effort: None,
        fast_mode: false,
    };

    let background = state
        .detail
        .assemble_snapshot(snapshot.clone(), None)
        .await
        .unwrap();
    let task = background.task.unwrap();
    assert_eq!(task.last_completed_ms, Some(5_000));
    assert!(task.unseen);
    let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(stored.last_completed_at_ms, Some(5_000));
    assert_eq!(stored.last_seen_activity_ms, None);

    snapshot.viewer_leases = 1;
    let viewed = state
        .detail
        .assemble_snapshot(snapshot, None)
        .await
        .unwrap();
    assert!(!viewed.task.unwrap().unseen);
    let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(stored.last_seen_activity_ms, Some(5_000));
}

#[tokio::test]
async fn canonical_snapshot_without_membership_is_rejected() {
    let root = tempfile::tempdir().unwrap();
    let state = task_state_with_codex_client(
        RootedFs::new(root.path()).unwrap(),
        CodexThreadClient::mock(Vec::new()),
    )
    .await;
    let thread = serde_json::from_value(
        task_thread_list("thread-unmanaged", root.path())["data"][0].clone(),
    )
    .expect("canonical thread");
    state.codex_sessions.observe_thread_metadata(thread).await;
    let snapshot = state
        .codex_sessions
        .snapshot("thread-unmanaged")
        .await
        .expect("canonical snapshot");

    let error = state
        .detail
        .assemble_snapshot(snapshot, None)
        .await
        .expect_err("unmanaged canonical detail must not be exposed");

    assert!(matches!(
        error,
        ApiError::BadRequest {
            code: "task_not_managed",
            ..
        }
    ));
}

#[tokio::test]
async fn task_detail_returns_cached_metadata_before_slow_resume_finishes() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-slow-detail-bootstrap";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
            Duration::from_millis(250),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

    cache_and_manage_test_thread(&state, thread_id, root.path()).await;

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_detail(state, thread_id.to_string(), None),
    )
    .await
    .expect("task detail must not await a slow thread/resume")
    .expect("cached task detail remains available");

    assert_eq!(response.0.thread_id, thread_id);
    assert_eq!(response.0.sync_state, TaskSyncState::Ready);
    assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);
    assert!(response.0.history_loading);
    wait_for_mock_method(&client, "thread/resume").await;
}

#[tokio::test]
async fn blank_history_cursor_returns_cached_task_detail_without_app_server_wait() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-blank-history-cursor";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
            Duration::from_millis(250),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

    cache_and_manage_test_thread(&state, thread_id, root.path()).await;

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_detail(state, thread_id.to_string(), Some(String::new())),
    )
    .await
    .expect("a blank cursor must not wait for app-server pagination")
    .expect("cached task detail remains available");

    assert_eq!(response.0.thread_id, thread_id);
    assert_eq!(response.0.sync_state, TaskSyncState::Ready);
    assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);
    assert!(response.0.history_loading);
    wait_for_mock_method(&client, "thread/resume").await;
}

#[tokio::test]
async fn history_timeout_does_not_replace_cached_task_detail() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-history-timeout-cache";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Cached task detail regression",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                },
                "initialTurnsPage": {
                    "data": [],
                    "nextCursor": "older-1",
                    "backwardsCursor": "latest-anchor"
                }
            }),
        ),
        crate::codex_app_server::MockCodexResponse::error(
            "thread/turns/list",
            crate::codex_app_server::CodexThreadError::RequestTimeout {
                method: "thread/turns/list",
                request_id: 31,
                timeout_ms: 120_000,
            },
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    let _viewer = state
        .codex_sessions
        .acquire_viewer(&client, 1, thread_id)
        .await
        .expect("initial task subscription succeeds");

    let error = test_task_detail(
        state.clone(),
        thread_id.to_string(),
        Some("older-1".to_string()),
    )
    .await
    .expect_err("older history request should expose its timeout");
    assert!(matches!(
        error,
        ApiError::Timeout {
            code: "codex_app_server_timeout",
            ..
        }
    ));

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_detail(state, thread_id.to_string(), None),
    )
    .await
    .expect("cached task detail must not wait after a history timeout")
    .expect("cached task detail remains available");

    assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);
    assert_eq!(
        response.0.task.as_ref().unwrap().title,
        "Cached task detail regression"
    );
    assert_eq!(
        response.0.events_page.next_cursor.as_deref(),
        Some("older-1")
    );
    assert!(!response.0.history_loading);
}

#[tokio::test]
async fn task_detail_returns_cached_metadata_while_connection_is_busy() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-busy-connection-detail";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    let thread =
        serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
            .expect("cached thread metadata");
    state.codex_sessions.observe_thread_metadata(thread).await;

    let runtime = state.codex_runtime.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(async move {
        runtime
            .hold_process_lock_for_test(locked_tx, Duration::from_millis(250))
            .await;
    });
    locked_rx.await.expect("runtime lock acquired");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_detail(state, thread_id.to_string(), None),
    )
    .await
    .expect("cached detail must not wait for app-server connection access")
    .expect("cached task detail remains available");

    assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);
    blocker.await.expect("runtime blocker completes");
    wait_for_mock_method(&client, "thread/resume").await;
}

#[tokio::test]
async fn task_stream_starts_before_slow_resume_finishes() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-slow-stream-bootstrap";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
            Duration::from_millis(250),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_stream(state, thread_id.to_string()),
    )
    .await
    .expect("task stream must not await a slow thread/resume")
    .expect("task stream starts from cached metadata");

    assert_eq!(response.status(), StatusCode::OK);
    wait_for_mock_method(&client, "thread/resume").await;
}

#[tokio::test]
async fn task_stream_starts_while_connection_is_busy() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-busy-connection-stream";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    let thread =
        serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
            .expect("cached thread metadata");
    state.codex_sessions.observe_thread_metadata(thread).await;

    let runtime = state.codex_runtime.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(async move {
        runtime
            .hold_process_lock_for_test(locked_tx, Duration::from_millis(250))
            .await;
    });
    locked_rx.await.expect("runtime lock acquired");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_stream(state, thread_id.to_string()),
    )
    .await
    .expect("task stream must not wait for app-server connection access")
    .expect("task stream starts from cached metadata");

    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    blocker.await.expect("runtime blocker completes");
    wait_for_mock_method(&client, "thread/resume").await;
}

#[tokio::test]
async fn direct_task_detail_returns_loading_snapshot_while_connection_is_busy() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-uncached-busy-detail";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let runtime = state.codex_runtime.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(async move {
        runtime
            .hold_process_lock_for_test(locked_tx, Duration::from_millis(250))
            .await;
    });
    locked_rx.await.expect("runtime lock acquired");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_detail(state, thread_id.to_string(), None),
    )
    .await
    .expect("direct task detail must not wait for app-server connection access")
    .expect("direct task detail starts with a loading snapshot");

    assert_eq!(response.0.thread_id, thread_id);
    assert_eq!(response.0.sync_state, TaskSyncState::Loading);
    assert!(response.0.task.is_none());
    assert!(response.0.history_loading);
    blocker.await.expect("runtime blocker completes");
    wait_for_mock_method(&client, "thread/resume").await;
}

#[tokio::test]
async fn direct_task_stream_starts_while_connection_is_busy() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-uncached-busy-stream";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let runtime = state.codex_runtime.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(async move {
        runtime
            .hold_process_lock_for_test(locked_tx, Duration::from_millis(250))
            .await;
    });
    locked_rx.await.expect("runtime lock acquired");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_stream(state, thread_id.to_string()),
    )
    .await
    .expect("direct task stream must not wait for app-server connection access")
    .expect("direct task stream starts from a loading snapshot");

    assert_eq!(response.status(), StatusCode::OK);
    drop(response);
    blocker.await.expect("runtime blocker completes");
    wait_for_mock_method(&client, "thread/resume").await;
}

#[tokio::test]
async fn resume_failure_makes_cached_task_detail_unavailable() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-failed-detail-bootstrap";
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::error(
        "thread/resume",
        crate::codex_app_server::CodexThreadError::Protocol("resume unavailable".to_string()),
    )]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    cache_and_manage_test_thread(&state, thread_id, root.path()).await;

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_detail(state.clone(), thread_id.to_string(), None),
    )
    .await
    .expect("task detail must not await a failed thread/resume")
    .expect("cached task detail remains available");
    assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);

    wait_for_mock_method(&client, "thread/resume").await;
    tokio::time::sleep(Duration::from_millis(20)).await;
    let snapshot = state
        .codex_sessions
        .snapshot(thread_id)
        .await
        .expect("cached session remains tracked");
    assert!(snapshot.thread.is_some());
    assert!(snapshot.last_error.is_some());
    let error = test_task_detail(state, thread_id.to_string(), None)
        .await
        .expect_err("stale task detail must not survive a canonical resume failure");
    assert!(matches!(error, ApiError::CodexThread(_)));
}

#[tokio::test]
async fn resume_timeout_makes_task_detail_unavailable_but_keeps_the_connection() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-timeout-detail-bootstrap";
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::error(
        "thread/resume",
        crate::codex_app_server::CodexThreadError::RequestTimeout {
            method: "thread/resume",
            request_id: 17,
            timeout_ms: 120_000,
        },
    )]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    cache_and_manage_test_thread(&state, thread_id, root.path()).await;

    let first = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_detail(state.clone(), thread_id.to_string(), None),
    )
    .await
    .expect("task detail must not await a timed-out thread/resume")
    .expect("cached task detail remains available");
    assert_eq!(first.0.task.as_ref().unwrap().thread_id, thread_id);
    assert!(first.0.history_loading);

    wait_for_mock_method(&client, "thread/resume").await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    let second = test_task_detail(state.clone(), thread_id.to_string(), None)
        .await
        .expect_err("task re-entry exposes the canonical source timeout");
    assert!(matches!(second, ApiError::CodexThread(_)));

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
async fn app_server_recovery_does_not_block_on_leased_thread_restoration() {
    let sessions = CodexThreadSessions::default();
    let first_client =
        CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": "thread-slow-recovery",
                    "preview": "Slow recovery regression",
                    "status": { "type": "idle" },
                    "cwd": "/tmp",
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
        )]);
    let _viewer = sessions
        .acquire_viewer(&first_client, 1, "thread-slow-recovery")
        .await
        .expect("viewer");
    let _ = sessions
        .connection_lost(1, "process exited".to_string())
        .await;

    let recovered_client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": "thread-slow-recovery",
                    "preview": "Slow recovery regression",
                    "status": { "type": "idle" },
                    "cwd": "/tmp",
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
            Duration::from_millis(120),
        ),
    ]);
    let connection = CodexConnection {
        client: recovered_client.clone(),
        generation: 2,
    };
    let (shutdown, _) = broadcast::channel(1);
    let runtime = CodexRuntime::new(
        sessions.clone(),
        TaskEvents::default(),
        TaskStore::memory().unwrap(),
        shutdown,
    );

    let started = tokio::time::Instant::now();
    runtime.restore_test_sessions(connection);
    assert!(
        started.elapsed() < Duration::from_millis(20),
        "connection acquisition must not await session restoration"
    );

    wait_for_mock_method(&recovered_client, "thread/resume").await;
    tokio::time::sleep(Duration::from_millis(140)).await;
    let snapshot = sessions
        .snapshot("thread-slow-recovery")
        .await
        .expect("recovered snapshot");
    assert_eq!(snapshot.generation, 2);
    assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
}

#[tokio::test]
async fn task_detail_handler_releases_its_subscription_after_the_response() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-detail-handler";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Handler lifecycle regression",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
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
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let response = test_task_detail(state, thread_id.to_string(), None)
        .await
        .expect("task detail succeeds");

    assert_eq!(response.0.thread_id, thread_id);
    assert_eq!(response.0.sync_state, TaskSyncState::Loading);
    assert!(
        response.0.task.is_none(),
        "detail must stay empty until the canonical resume snapshot arrives"
    );
    wait_for_mock_method(&client, "thread/unsubscribe").await;
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/resume", "thread/unsubscribe"]
    );
}

#[tokio::test]
async fn task_detail_and_stream_share_one_subscription_until_the_stream_closes() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-detail-stream-handler";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Shared handler lifecycle regression",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
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
            Duration::from_millis(50),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let detail_state = state.clone();
    let detail =
        tokio::spawn(
            async move { test_task_detail(detail_state, thread_id.to_string(), None).await },
        );
    let stream_state = state.clone();
    let stream =
        tokio::spawn(async move { test_task_stream(stream_state, thread_id.to_string()).await });

    let detail_response = detail.await.unwrap().expect("task detail succeeds");
    let stream_response = stream.await.unwrap().expect("task stream succeeds");
    assert_eq!(detail_response.0.thread_id, thread_id);
    assert_eq!(detail_response.0.sync_state, TaskSyncState::Loading);
    assert!(
        detail_response.0.task.is_none(),
        "detail must stay empty until the canonical resume snapshot arrives"
    );

    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/resume"]
    );

    drop(stream_response);
    wait_for_mock_method(&client, "thread/unsubscribe").await;
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/resume", "thread/unsubscribe"]
    );
}

#[tokio::test]
async fn task_stream_reopens_while_detail_unsubscribe_is_in_flight() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-detail-stream-reopen";
    let resume = || {
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Reopen lifecycle regression",
                "status": { "type": "idle" },
                "cwd": root.path().display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            },
            "initialTurnsPage": {
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null
            }
        })
    };
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok("thread/resume", resume()),
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
            Duration::from_millis(250),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/resume", resume()),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let _detail_response = test_task_detail(state.clone(), thread_id.to_string(), None)
        .await
        .expect("task detail succeeds");
    wait_for_mock_method(&client, "thread/unsubscribe").await;

    let stream_response = tokio::time::timeout(
        Duration::from_millis(50),
        test_task_stream(state.clone(), thread_id.to_string()),
    )
    .await
    .expect("task stream must not wait for the detail cleanup RPC")
    .expect("task stream succeeds");

    wait_for_mock_method_count(&client, "thread/resume", 2).await;
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/resume", "thread/unsubscribe", "thread/resume"]
    );

    tokio::time::sleep(Duration::from_millis(275)).await;
    let snapshot = state
        .codex_sessions
        .snapshot(thread_id)
        .await
        .expect("thread session snapshot");
    assert_eq!(
        snapshot.lifecycle,
        crate::codex_thread_sessions::ThreadSessionLifecycle::Subscribed
    );
    assert_eq!(snapshot.viewer_leases, 1);

    drop(stream_response);
    wait_for_mock_method_count(&client, "thread/unsubscribe", 2).await;
}

#[test]
fn task_stream_bootstrap_replays_the_canonical_detail_snapshot() {
    let thread_id = "thread-bootstrap";
    let assistant = task_event_record(
        thread_id,
        "turn-1:assistant-1",
        "assistant_message",
        "canonical assistant response",
        Some(json!({ "text": "canonical assistant response" })),
        2,
    );
    let sync = TaskDetailSync {
        thread_id: thread_id.to_string(),
        revision: 7,
        detail: TaskDetailResponse {
            thread_id: thread_id.to_string(),
            sync_state: TaskSyncState::Ready,
            revision: 7,
            task: Some(TaskRecord {
                id: thread_id.to_string(),
                thread_id: thread_id.to_string(),
                conversation_available: true,
                title: "Bootstrap regression".to_string(),
                preview: "canonical assistant response".to_string(),
                thread_status: ThreadStatus::Idle,
                latest_turn_status: Some(TurnStatus::Completed),
                active_turn: None,
                cwd: "/tmp".to_string(),
                cwd_path: None,
                relative_cwd: ".".to_string(),
                worktree: None,
                created_ms: 1,
                updated_ms: 2,
                recency_ms: None,
                last_completed_ms: None,
                last_event_summary: Some("canonical assistant response".to_string()),
                unseen: false,
            }),
            events: vec![assistant],
            events_page: TaskEventsPage { next_cursor: None },
            pending_approvals: Vec::new(),
            history_loading: false,
            permission_mode: Some(CodexPermissionMode::AskForApproval),
            model: Some("gpt-test".to_string()),
            reasoning_effort: Some("xhigh".to_string()),
            fast_mode: true,
        },
        reason: "stream-bootstrap",
        error: None,
    };

    let frames = task_stream_initial_frames(&sync)
        .into_iter()
        .collect::<Vec<_>>();

    assert_eq!(frames[0], ": ready\n\n");
    assert_eq!(
        frames.len(),
        2,
        "the initial stream must replay canonical state"
    );
    assert!(frames[1].starts_with("event: task-sync\ndata: "));
    assert!(frames[1].contains("\"threadId\":\"thread-bootstrap\""));
    assert!(frames[1].contains("\"revision\":7"));
    assert!(frames[1].contains("\"type\":\"assistant_message\""));
    assert!(frames[1].contains("canonical assistant response"));
}
