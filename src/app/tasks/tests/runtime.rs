use super::super::{events::*, runtime::*};
use super::*;
use crate::codex_app_server::CodexThreadError;
use crate::thread_store::ManagedThread;

fn runtime_with_events(events: TaskEvents) -> CodexRuntime {
    let (shutdown, _) = broadcast::channel(1);
    CodexRuntime::new(
        CodexThreadSessions::default(),
        events,
        ThreadStore::memory().unwrap(),
        shutdown,
    )
}

fn test_runtime() -> CodexRuntime {
    runtime_with_events(TaskEvents::default())
}

fn active_resume(thread_id: &str) -> JsonValue {
    json!({
        "thread": {
            "id": thread_id,
            "preview": "Recovered task",
            "status": { "type": "active", "activeFlags": [] },
            "cwd": "/Users/example/project",
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "turns": [{
                "id": "turn-active",
                "items": [],
                "status": "inProgress",
                "startedAt": 2.0
            }]
        },
        "initialTurnsPage": {
            "data": [],
            "nextCursor": null,
            "backwardsCursor": null
        }
    })
}

fn dynamic_tool_request(
    thread_id: &str,
    tool: &str,
    arguments: JsonValue,
) -> codex_app_server::CodexServerRequest {
    codex_app_server::decode_server_request(
        json!(31),
        "item/tool/call",
        json!({
            "threadId": thread_id,
            "turnId": "turn_1",
            "callId": "call_1",
            "tool": tool,
            "arguments": arguments
        }),
    )
    .unwrap()
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

#[tokio::test]
async fn startup_recovery_resumes_only_loaded_threads_managed_by_caffold() {
    let store = ThreadStore::memory().unwrap();
    store
        .claim(ManagedThread::new("managed", None, None, None), 10)
        .unwrap();
    let (shutdown, _) = broadcast::channel(1);
    let runtime = CodexRuntime::new(
        CodexThreadSessions::default(),
        TaskEvents::default(),
        store,
        shutdown,
    );
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/loaded/list",
            json!({
                "data": ["managed", "outside-caffold"],
                "nextCursor": "next"
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/loaded/list",
            json!({ "data": ["managed"], "nextCursor": null }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/resume", active_resume("managed")),
    ]);

    runtime
        .recover_test_loaded_sessions(CodexConnection {
            client: client.clone(),
            generation: 4,
        })
        .await;

    assert_eq!(
        client.mock_requests().await,
        [
            ("thread/loaded/list".to_string(), json!({ "limit": 100 })),
            (
                "thread/loaded/list".to_string(),
                json!({ "cursor": "next", "limit": 100 })
            ),
            (
                "thread/resume".to_string(),
                json!({
                    "threadId": "managed",
                    "excludeTurns": true,
                    "initialTurnsPage": {
                        "limit": 8,
                        "sortDirection": "desc",
                        "itemsView": "summary"
                    }
                })
            )
        ]
    );
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
            &CodexThreadClient::mock(Vec::new()),
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
async fn rename_dynamic_tool_updates_only_the_current_managed_thread() {
    let store = ThreadStore::memory().unwrap();
    store
        .claim(
            ManagedThread::new("thread_1", None, None, None),
            1_750_000_000_000,
        )
        .unwrap();
    let (shutdown, _) = broadcast::channel(1);
    let runtime = CodexRuntime::new(
        CodexThreadSessions::default(),
        TaskEvents::default(),
        store,
        shutdown,
    );
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/name/set",
        json!({}),
    )]);

    runtime
        .handle_test_server_request(
            &client,
            dynamic_tool_request(
                "thread_1",
                codex_app_server::RENAME_CURRENT_THREAD_TOOL_NAME,
                json!({ "name": "  Whisper voice input  " }),
            ),
        )
        .await;

    assert_eq!(
        client.mock_requests().await,
        [(
            "thread/name/set".to_string(),
            json!({
                "threadId": "thread_1",
                "name": "Whisper voice input"
            })
        )]
    );
    assert_eq!(
        client.mock_server_responses().await,
        [(
            json!(31),
            json!({
                "contentItems": [{
                    "type": "inputText",
                    "text": "Renamed the current Caffold task to `Whisper voice input`."
                }],
                "success": true
            })
        )]
    );
}

#[tokio::test]
async fn rename_dynamic_tool_rejects_threads_outside_caffold_management() {
    let client = CodexThreadClient::mock(Vec::new());
    let runtime = test_runtime();

    runtime
        .handle_test_server_request(
            &client,
            dynamic_tool_request(
                "external_thread",
                codex_app_server::RENAME_CURRENT_THREAD_TOOL_NAME,
                json!({ "name": "Must not change" }),
            ),
        )
        .await;

    assert!(client.mock_requests().await.is_empty());
    assert_eq!(
        client.mock_server_responses().await[0].1,
        json!({
            "contentItems": [{
                "type": "inputText",
                "text": "Caffold can only rename tasks that it manages."
            }],
            "success": false
        })
    );
}

#[tokio::test]
async fn rename_dynamic_tool_rejects_invalid_names_and_unknown_tools() {
    let store = ThreadStore::memory().unwrap();
    store
        .claim(ManagedThread::new("thread_1", None, None, None), 1)
        .unwrap();
    let (shutdown, _) = broadcast::channel(1);
    let runtime = CodexRuntime::new(
        CodexThreadSessions::default(),
        TaskEvents::default(),
        store,
        shutdown,
    );
    let client = CodexThreadClient::mock(Vec::new());

    runtime
        .handle_test_server_request(
            &client,
            dynamic_tool_request(
                "thread_1",
                codex_app_server::RENAME_CURRENT_THREAD_TOOL_NAME,
                json!({ "name": "   " }),
            ),
        )
        .await;
    runtime
        .handle_test_server_request(
            &client,
            dynamic_tool_request("thread_1", "future_tool", json!({})),
        )
        .await;

    assert!(client.mock_requests().await.is_empty());
    let responses = client.mock_server_responses().await;
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0].1["success"], false);
    assert_eq!(
        responses[0].1["contentItems"][0]["text"],
        "The new task name must be a non-empty string."
    );
    assert_eq!(responses[1].1["success"], false);
    assert_eq!(
        responses[1].1["contentItems"][0]["text"],
        "Caffold does not support the dynamic tool `future_tool`."
    );
}

#[tokio::test]
async fn rename_dynamic_tool_returns_a_failed_result_when_app_server_rejects_the_name() {
    let store = ThreadStore::memory().unwrap();
    store
        .claim(ManagedThread::new("thread_1", None, None, None), 1)
        .unwrap();
    let (shutdown, _) = broadcast::channel(1);
    let runtime = CodexRuntime::new(
        CodexThreadSessions::default(),
        TaskEvents::default(),
        store,
        shutdown,
    );
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::error(
        "thread/name/set",
        CodexThreadError::InvalidParams("name rejected".to_string()),
    )]);

    runtime
        .handle_test_server_request(
            &client,
            dynamic_tool_request(
                "thread_1",
                codex_app_server::RENAME_CURRENT_THREAD_TOOL_NAME,
                json!({ "name": "Rejected name" }),
            ),
        )
        .await;

    assert_eq!(client.mock_requests().await.len(), 1);
    let response = &client.mock_server_responses().await[0].1;
    assert_eq!(response["success"], false);
    assert_eq!(
        response["contentItems"][0]["text"],
        "Caffold could not rename the current task: Codex app-server rejected invalid parameters: name rejected"
    );
}

#[tokio::test]
async fn completed_turn_expires_live_pending_approval() {
    let events = TaskEvents::default();
    let mut receiver = events.subscribe();
    let runtime = runtime_with_events(events.clone());

    runtime
        .handle_test_server_request(
            &CodexThreadClient::mock(Vec::new()),
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
