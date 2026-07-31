use super::super::super::*;
use super::super::{events::*, runtime::*};
use crate::codex_app_server::CodexThreadError;

fn runtime_with_events(events: TaskEvents) -> CodexRuntime {
    let (shutdown, _) = broadcast::channel(1);
    CodexRuntime::new(CodexThreadSessions::default(), events, shutdown)
}

fn test_runtime() -> CodexRuntime {
    runtime_with_events(TaskEvents::default())
}

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
    let runtime = test_runtime();
    let client = CodexThreadClient::mock(Vec::new());
    runtime.install_test_client(7, client.clone()).await;
    runtime
        .recover_connection_error(
            &CodexConnection {
                client,
                generation: 7,
            },
            &CodexThreadError::RequestTimeout {
                method: "thread/resume",
                request_id: 1,
                timeout_ms: 120_000,
            },
        )
        .await;
    assert_eq!(runtime.diagnostics().await, (7, true));
    runtime.shutdown().await;
}

#[tokio::test]
async fn transport_failures_discard_the_cached_codex_connection() {
    let runtime = test_runtime();
    let client = CodexThreadClient::mock(Vec::new());
    runtime.install_test_client(8, client.clone()).await;
    runtime
        .recover_connection_error(
            &CodexConnection {
                client,
                generation: 8,
            },
            &CodexThreadError::ProcessUnavailable,
        )
        .await;
    assert_eq!(runtime.diagnostics().await, (8, false));
}

#[tokio::test]
async fn protocol_failures_keep_a_healthy_codex_connection() {
    let runtime = test_runtime();
    let client = CodexThreadClient::mock(Vec::new());
    runtime.install_test_client(9, client.clone()).await;
    runtime
        .recover_connection_error(
            &CodexConnection {
                client,
                generation: 9,
            },
            &CodexThreadError::InvalidParams("invalid fixture".to_string()),
        )
        .await;
    assert_eq!(runtime.diagnostics().await, (9, true));
    runtime.shutdown().await;
}

#[test]
fn codex_notifications_publish_live_task_status() {
    let events = TaskEvents::default();
    let mut receiver = events.subscribe();
    let runtime = runtime_with_events(events.clone());

    runtime.handle_test_notification(
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

    runtime.handle_test_notification(
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
    let cached_command = events
        .for_thread("thread_1")
        .into_iter()
        .find(|event| event.id == command_started.id)
        .expect("notification bridge should cache commands without an SSE consumer");
    assert_eq!(cached_command.event_type, "command_execution");

    runtime.handle_test_notification(
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

    runtime.handle_test_notification(
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

    runtime.handle_test_notification(
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

    runtime.handle_test_notification(
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
    let events = TaskEvents::default();
    let mut receiver = events.subscribe();
    let runtime = runtime_with_events(events.clone());

    runtime
        .handle_test_server_request(
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

    let event = receiver.recv().await.unwrap();
    assert_eq!(event.thread_id, "thread_1");
    assert_eq!(event.event_type, "approval_requested");
    assert_eq!(
        event.payload.as_ref().unwrap()["turnId"],
        "turn_1",
        "approval events must remain attached to their causal turn"
    );
    assert_eq!(
        event.payload.as_ref().unwrap()["params"]["command"],
        "cargo test"
    );
    let approvals = runtime.approval_events("thread_1").await;
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0].id, event.id);
    assert_eq!(approvals[0].created_ms, event.created_ms);
    assert_eq!(approvals[0].sort_index, event.sort_index);
    assert_eq!(
        approvals[0].payload.as_ref().unwrap()["params"]["command"],
        "cargo test"
    );
    assert_eq!(events.for_thread("thread_1"), vec![event]);
}

#[tokio::test]
async fn completed_turn_expires_live_pending_approval() {
    let events = TaskEvents::default();
    let mut receiver = events.subscribe();
    let runtime = runtime_with_events(events.clone());

    runtime
        .handle_test_server_request(
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
    runtime.expire_test_approvals(&completed).await;

    assert!(runtime.approval_events("thread_1").await.is_empty());
    let resolved = receiver.recv().await.unwrap();
    assert_eq!(resolved.event_type, "approval_resolved");
    assert_eq!(resolved.payload.as_ref().unwrap()["approvalId"], "11");
    assert_eq!(resolved.payload.as_ref().unwrap()["decision"], "expired");
    assert_eq!(
        events
            .for_thread("thread_1")
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>(),
        ["approval_requested", "approval_resolved"]
    );
}
