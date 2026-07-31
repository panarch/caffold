use super::super::*;

#[test]
fn recognizes_structured_thread_unavailable_errors() {
    assert!(
        codex_app_server::CodexThreadError::ThreadUnavailable("019f-test".to_string())
            .is_thread_unavailable()
    );
    assert!(
        !codex_app_server::CodexThreadError::RequestTimeout {
            method: "thread/resume",
            request_id: 1,
            timeout_ms: 120_000,
        }
        .is_thread_unavailable()
    );
}

#[tokio::test]
async fn request_timeouts_keep_the_cached_codex_connection() {
    let runtime = CodexThreadRuntime::default();
    {
        let mut state = runtime.state.lock().await;
        state.generation = 7;
        state.client = Some(CodexThreadClient::mock(Vec::new()));
    }

    assert!(
        !runtime
            .invalidate_after_error(
                7,
                &codex_app_server::CodexThreadError::RequestTimeout {
                    method: "thread/resume",
                    request_id: 1,
                    timeout_ms: 120_000,
                },
            )
            .await
    );
    assert_eq!(runtime.diagnostics().await, (7, true));
    runtime.shutdown().await;
}

#[tokio::test]
async fn transport_failures_discard_the_cached_codex_connection() {
    let runtime = CodexThreadRuntime::default();
    {
        let mut state = runtime.state.lock().await;
        state.generation = 8;
        state.client = Some(CodexThreadClient::mock(Vec::new()));
    }

    assert!(
        runtime
            .invalidate_after_error(8, &codex_app_server::CodexThreadError::ProcessUnavailable,)
            .await
    );
    assert_eq!(runtime.diagnostics().await, (8, false));
}

#[tokio::test]
async fn protocol_failures_keep_a_healthy_codex_connection() {
    let runtime = CodexThreadRuntime::default();
    {
        let mut state = runtime.state.lock().await;
        state.generation = 9;
        state.client = Some(CodexThreadClient::mock(Vec::new()));
    }

    assert!(
        !runtime
            .invalidate_after_error(
                9,
                &codex_app_server::CodexThreadError::InvalidParams("invalid fixture".to_string(),),
            )
            .await
    );
    assert_eq!(runtime.diagnostics().await, (9, true));
    runtime.shutdown().await;
}

#[test]
fn current_pending_approval_does_not_change_canonical_thread_status() {
    let temp = tempfile::tempdir().unwrap();
    let thread = json!({
        "id": "thread_1",
        "preview": "Needs approval",
        "cwd": temp.path().join("project").display().to_string(),
        "createdAt": 1.0,
        "updatedAt": 1.0,
        "status": { "type": "active" }
    });
    let events = vec![task_event_record(
        "thread_1",
        "approval_requested:1",
        "approval_requested",
        "Command approval requested",
        Some(json!({ "approvalId": "1" })),
        1,
    )];

    let task = task_record_from_thread(&thread, &events, None).unwrap();
    assert!(matches!(task.thread_status, ThreadStatus::Active { .. }));
}

#[test]
fn resolved_approval_event_does_not_leave_idle_task_waiting() {
    let temp = tempfile::tempdir().unwrap();
    let thread = json!({
        "id": "thread_1",
        "preview": "Approval was accepted",
        "cwd": temp.path().join("project").display().to_string(),
        "createdAt": 1.0,
        "updatedAt": 4.0,
        "status": { "type": "idle" }
    });
    let events = vec![
        task_event_record(
            "thread_1",
            "approval_requested:1",
            "approval_requested",
            "Command approval requested",
            Some(json!({ "approvalId": "1" })),
            1,
        ),
        task_event_record(
            "thread_1",
            "approval_resolved:1",
            "approval_resolved",
            "Approval resolved: accept",
            Some(json!({ "approvalId": "1", "decision": "accept" })),
            2,
        ),
        task_event_record(
            "thread_1",
            "turn_1:completed",
            "turn_completed",
            "Turn completed",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "status": "completed"
            })),
            3,
        ),
        task_event_record(
            "thread_1",
            "thread_status_changed",
            "thread_status_changed",
            "Thread idle",
            Some(json!({ "threadId": "thread_1", "status": "idle" })),
            4,
        ),
    ];

    let task = task_record_from_thread(&thread, &events, None).unwrap();
    assert_eq!(task.thread_status, ThreadStatus::Idle);
}

#[test]
fn completed_turn_does_not_leave_abandoned_approval_waiting() {
    let temp = tempfile::tempdir().unwrap();
    let thread = json!({
        "id": "thread_1",
        "preview": "A later prompt completed",
        "cwd": temp.path().join("project").display().to_string(),
        "createdAt": 1.0,
        "updatedAt": 3.0,
        "status": { "type": "idle" }
    });
    let events = vec![
        task_event_record(
            "thread_1",
            "approval_requested:1",
            "approval_requested",
            "Command approval requested",
            Some(json!({
                "approvalId": "1",
                "params": { "turnId": "turn_1" }
            })),
            1,
        ),
        task_event_record(
            "thread_1",
            "turn_1:completed",
            "turn_completed",
            "Turn completed",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "status": "completed"
            })),
            2,
        ),
        task_event_record(
            "thread_1",
            "thread_status_changed",
            "thread_status_changed",
            "Thread idle",
            Some(json!({ "threadId": "thread_1", "status": "idle" })),
            3,
        ),
    ];

    let task = task_record_from_thread(&thread, &events, None).unwrap();
    assert_eq!(task.thread_status, ThreadStatus::Idle);
}

#[test]
fn codex_notifications_publish_live_task_status() {
    let (sender, mut receiver) = broadcast::channel(8);
    let live_task_events = LiveTaskEventCache::default();

    handle_codex_notification(
        &sender,
        &live_task_events,
        codex_app_server::decode_notification(
            "turn/started",
            json!({
                "threadId": "thread_1",
                "turn": {
                    "id": "turn_1",
                    "status": "inProgress",
                    "startedAt": 1_750_000_000.25
                }
            }),
        )
        .unwrap(),
    );
    let started = receiver.try_recv().unwrap();
    assert_eq!(started.thread_id, "thread_1");
    assert_eq!(started.event_type, "turn_started");
    assert_eq!(started.created_ms, 1_750_000_000_250);
    assert_eq!(started.payload.unwrap()["turn"]["id"], "turn_1");

    handle_codex_notification(
        &sender,
        &live_task_events,
        codex_app_server::decode_notification(
            "item/started",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "startedAtMs": 1_750_000_001_000_u64,
                "item": {
                    "id": "command_1",
                    "type": "commandExecution",
                    "command": "cargo test",
                    "cwd": "/tmp/project",
                    "status": "inProgress"
                }
            }),
        )
        .unwrap(),
    );
    let command_started = receiver.try_recv().unwrap();
    assert_eq!(command_started.event_type, "command_execution");
    assert_eq!(command_started.created_ms, 1_750_000_001_000);
    assert_eq!(
        command_started.payload.as_ref().unwrap()["lifecycle"],
        "started"
    );
    let cached_command = live_task_events
        .for_thread("thread_1")
        .into_iter()
        .find(|event| event.id == command_started.id)
        .expect("notification bridge should cache commands without an SSE consumer");
    assert_eq!(cached_command.event_type, "command_execution");

    handle_codex_notification(
        &sender,
        &live_task_events,
        codex_app_server::decode_notification(
            "item/started",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "startedAtMs": 1_750_000_002_000_u64,
                "item": {
                    "id": "reasoning_1",
                    "type": "reasoning",
                    "summary": [],
                    "content": []
                }
            }),
        )
        .unwrap(),
    );
    let reasoning_started = receiver.try_recv().unwrap();
    assert_eq!(reasoning_started.event_type, "work_status");
    assert_eq!(reasoning_started.summary, "Thinking");
    assert_eq!(
        reasoning_started.payload.as_ref().unwrap()["lifecycle"],
        "started"
    );

    handle_codex_notification(
        &sender,
        &live_task_events,
        codex_app_server::decode_notification(
            "item/completed",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "completedAtMs": 1_750_000_003_000_u64,
                "item": {
                    "id": "reasoning_1",
                    "type": "reasoning",
                    "summary": ["Checked the current behavior."],
                    "content": []
                }
            }),
        )
        .unwrap(),
    );
    let reasoning_completed = receiver.try_recv().unwrap();
    assert_eq!(reasoning_started.id, reasoning_completed.id);
    assert_eq!(reasoning_completed.event_type, "reasoning");
    assert_eq!(reasoning_completed.created_ms, 1_750_000_002_000);
    assert_eq!(reasoning_completed.updated_ms, Some(1_750_000_003_000));
    assert_eq!(
        reasoning_completed.payload.as_ref().unwrap()["lifecycle"],
        "completed"
    );

    handle_codex_notification(
        &sender,
        &live_task_events,
        codex_app_server::decode_notification(
            "thread/status/changed",
            json!({
                "threadId": "thread_1",
                "status": { "type": "active", "activeFlags": [] }
            }),
        )
        .unwrap(),
    );
    let status = receiver.try_recv().unwrap();
    assert_eq!(status.thread_id, "thread_1");
    assert_eq!(status.event_type, "thread_status_changed");
    assert_eq!(status.payload.unwrap()["status"], "running");

    handle_codex_notification(
        &sender,
        &live_task_events,
        codex_app_server::decode_notification(
            "turn/completed",
            json!({
                "threadId": "thread_1",
                "turn": {
                    "id": "turn_1",
                    "status": "completed",
                    "completedAt": 1_750_000_004.5
                }
            }),
        )
        .unwrap(),
    );
    let completed = receiver.try_recv().unwrap();
    assert_eq!(completed.event_type, "turn_completed");
    assert_eq!(completed.created_ms, 1_750_000_004_500);
}

#[tokio::test]
async fn server_requests_store_live_pending_approvals_without_local_task_ledger() {
    let temp = tempfile::tempdir().unwrap();
    let project_root = temp.path().join("project");
    std::fs::create_dir(&project_root).unwrap();
    let (sender, mut receiver) = broadcast::channel(4);
    let live_task_events = LiveTaskEventCache::default();
    let pending = Arc::new(AsyncMutex::new(HashMap::new()));

    handle_codex_server_request(
        &sender,
        &live_task_events,
        &pending,
        codex_app_server::decode_server_request(
            json!(11),
            "item/commandExecution/requestApproval",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "command": "cargo test",
                "cwd": project_root.join("src").display().to_string(),
                "reason": "Run tests",
                "availableDecisions": ["accept", "decline"]
            }),
        )
        .unwrap(),
    )
    .await;

    let approvals = pending.lock().await;
    let approval = approvals.get("11").unwrap();
    assert_eq!(approval.thread_id, "thread_1");
    assert_eq!(approval.params["command"], "cargo test");
    let approval_created_ms = approval.created_ms;
    let approval_sort_index = approval.sort_index;
    drop(approvals);

    let event = receiver.recv().await.unwrap();
    assert_eq!(event.thread_id, "thread_1");
    assert_eq!(event.event_type, "approval_requested");
    assert_eq!(
        event.payload.as_ref().unwrap()["turnId"],
        "turn_1",
        "approval events must remain attached to their causal turn"
    );
    assert_eq!(event.created_ms, approval_created_ms);
    assert_eq!(event.sort_index, approval_sort_index);
    assert_eq!(live_task_events.for_thread("thread_1"), vec![event]);
}

#[tokio::test]
async fn completed_turn_expires_live_pending_approval() {
    let (sender, mut receiver) = broadcast::channel(4);
    let live_task_events = LiveTaskEventCache::default();
    let pending = Arc::new(AsyncMutex::new(HashMap::new()));

    handle_codex_server_request(
        &sender,
        &live_task_events,
        &pending,
        codex_app_server::decode_server_request(
            json!(11),
            "item/commandExecution/requestApproval",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "command": "cargo test",
                "availableDecisions": ["accept", "decline"]
            }),
        )
        .unwrap(),
    )
    .await;
    let requested = receiver.recv().await.unwrap();
    assert_eq!(requested.event_type, "approval_requested");

    let completed = codex_app_server::decode_notification(
        "turn/completed",
        json!({
            "threadId": "thread_1",
            "turn": {
                "id": "turn_1",
                "status": "completed",
                "completedAt": 1_750_000_004.5
            }
        }),
    )
    .unwrap();
    expire_stale_approvals_for_notification(&sender, &live_task_events, &pending, &completed).await;

    assert!(pending.lock().await.is_empty());
    let resolved = receiver.recv().await.unwrap();
    assert_eq!(resolved.event_type, "approval_resolved");
    assert_eq!(resolved.payload.as_ref().unwrap()["approvalId"], "11");
    assert_eq!(resolved.payload.as_ref().unwrap()["decision"], "expired");
    assert_eq!(
        live_task_events
            .for_thread("thread_1")
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        ["approval_requested", "approval_resolved"]
    );
}
