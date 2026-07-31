use super::super::*;
use super::support::*;
use crate::codex_thread_sessions::ThreadSessionLifecycle;

#[tokio::test]
async fn task_detail_returns_cached_metadata_before_slow_resume_finishes() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-slow-detail-bootstrap";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            task_thread_list(thread_id, root.path()),
        ),
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

    let tasks = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
        .await
        .expect("task list succeeds");
    assert_eq!(tasks.0.tasks.len(), 1);

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        task_detail(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        ),
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            task_thread_list(thread_id, root.path()),
        ),
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

    let tasks = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
        .await
        .expect("task list succeeds");
    assert_eq!(tasks.0.tasks.len(), 1);

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        task_detail(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery {
                cursor: Some(String::new()),
            }),
        ),
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

    let error = task_detail(
        State(state.clone()),
        AxumPath(thread_id.to_string()),
        Query(TaskDetailQuery {
            cursor: Some("older-1".to_string()),
        }),
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
        task_detail(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        ),
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

    let runtime = state.codex_threads.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(async move {
        let _runtime = runtime.state.lock().await;
        let _ = locked_tx.send(());
        tokio::time::sleep(Duration::from_millis(250)).await;
    });
    locked_rx.await.expect("runtime lock acquired");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        task_detail(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        ),
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            task_thread_list(thread_id, root.path()),
        ),
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
    let _ = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
        .await
        .expect("task list succeeds");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        task_stream(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
        ),
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

    let runtime = state.codex_threads.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(async move {
        let _runtime = runtime.state.lock().await;
        let _ = locked_tx.send(());
        tokio::time::sleep(Duration::from_millis(250)).await;
    });
    locked_rx.await.expect("runtime lock acquired");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        task_stream(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
        ),
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

    let runtime = state.codex_threads.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(async move {
        let _runtime = runtime.state.lock().await;
        let _ = locked_tx.send(());
        tokio::time::sleep(Duration::from_millis(250)).await;
    });
    locked_rx.await.expect("runtime lock acquired");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        task_detail(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        ),
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

    let runtime = state.codex_threads.clone();
    let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
    let blocker = tokio::spawn(async move {
        let _runtime = runtime.state.lock().await;
        let _ = locked_tx.send(());
        tokio::time::sleep(Duration::from_millis(250)).await;
    });
    locked_rx.await.expect("runtime lock acquired");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        task_stream(
            State(state),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
        ),
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
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            task_thread_list(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::error(
            "thread/resume",
            crate::codex_app_server::CodexThreadError::Protocol("resume unavailable".to_string()),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    let _ = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
        .await
        .expect("task list succeeds");

    let response = tokio::time::timeout(
        Duration::from_millis(50),
        task_detail(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        ),
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
    let error = task_detail(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TaskDetailQuery { cursor: None }),
    )
    .await
    .expect_err("stale task detail must not survive a canonical resume failure");
    assert!(matches!(error, ApiError::CodexThread(_)));
}

#[tokio::test]
async fn resume_timeout_makes_task_detail_unavailable_but_keeps_the_connection() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-timeout-detail-bootstrap";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            task_thread_list(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::error(
            "thread/resume",
            crate::codex_app_server::CodexThreadError::RequestTimeout {
                method: "thread/resume",
                request_id: 17,
                timeout_ms: 120_000,
            },
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    let _ = list_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
        .await
        .expect("task list succeeds");

    let first = tokio::time::timeout(
        Duration::from_millis(50),
        task_detail(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        ),
    )
    .await
    .expect("task detail must not await a timed-out thread/resume")
    .expect("cached task detail remains available");
    assert_eq!(first.0.task.as_ref().unwrap().thread_id, thread_id);
    assert!(first.0.history_loading);

    wait_for_mock_method(&client, "thread/resume").await;
    tokio::time::sleep(Duration::from_millis(20)).await;

    let second = task_detail(
        State(state.clone()),
        AxumPath(thread_id.to_string()),
        Query(TaskDetailQuery { cursor: None }),
    )
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
    assert_eq!(state.codex_threads.diagnostics().await, (1, true));
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
    let connection = CodexThreadConnection {
        client: recovered_client.clone(),
        generation: 2,
    };

    let started = tokio::time::Instant::now();
    restore_leased_codex_sessions(sessions.clone(), connection);
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

    let response = task_detail(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TaskDetailQuery { cursor: None }),
    )
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
    let detail = tokio::spawn(async move {
        task_detail(
            State(detail_state),
            AxumPath(thread_id.to_string()),
            Query(TaskDetailQuery { cursor: None }),
        )
        .await
    });
    let stream_state = state.clone();
    let stream = tokio::spawn(async move {
        task_stream(
            State(stream_state),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
        )
        .await
    });

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

    let _detail_response = task_detail(
        State(state.clone()),
        AxumPath(thread_id.to_string()),
        Query(TaskDetailQuery { cursor: None }),
    )
    .await
    .expect("task detail succeeds");
    wait_for_mock_method(&client, "thread/unsubscribe").await;

    let stream_response = tokio::time::timeout(
        Duration::from_millis(50),
        task_stream(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
        ),
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
            managed: true,
            revision: 7,
            task: Some(TaskRecord {
                id: thread_id.to_string(),
                thread_id: thread_id.to_string(),
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
        },
        reason: "stream-bootstrap",
        error: None,
    };

    let frames = task_stream_initial_frames(&sync)
        .into_iter()
        .map(|frame| String::from_utf8(frame.to_vec()).unwrap())
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
