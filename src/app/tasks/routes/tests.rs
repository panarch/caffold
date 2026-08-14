use super::super::{projection::*, tests::support::*};
use super::*;
use crate::app::tasks::events::{task_event_from_thread_item, task_event_record};
use crate::app::tasks::recovery::ActiveTaskRecoveryAction;
use crate::codex_app_server::ThreadStatus;
use crate::{
    fs::RootedFs,
    task_store::{ManagedSection, ManagedThread, TaskStore},
};
use std::{path::PathBuf, sync::Arc};
use tower::ServiceExt;

fn recovery_location_responses(
    archived_threads: Vec<JsonValue>,
) -> Vec<crate::codex_app_server::MockCodexResponse> {
    vec![
        crate::codex_app_server::MockCodexResponse::ok_for(
            "thread/list",
            json!({
                "limit": 100,
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "archived": false,
                "useStateDbOnly": true,
            }),
            json!({
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null,
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok_for(
            "thread/list",
            json!({
                "limit": 100,
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "archived": true,
                "useStateDbOnly": true,
            }),
            json!({
                "data": archived_threads,
                "nextCursor": null,
                "backwardsCursor": null,
            }),
        ),
    ]
}

fn projected_active_tasks(
    projection: &super::super::active_list::ActiveTaskProjection,
) -> Vec<&TaskRecord> {
    projection
        .sections
        .iter()
        .flat_map(|section| section.tasks.iter())
        .chain(projection.unsectioned.iter().map(|recovery| &recovery.task))
        .collect()
}

fn claim_cached_active(
    state: &TaskState,
    thread_id: &str,
    display_name: &str,
    recency_ms: u64,
    section_id: &str,
    logical_path: &str,
) {
    state
        .task_store
        .transaction(|tables| {
            let section = ManagedSection {
                section_id: section_id.to_string(),
                logical_path: logical_path.to_string(),
            };
            tables.upsert_managed_section(&section)?;
            tables.claim_managed_thread_at_top(
                ManagedThread::new(thread_id, Some(recency_ms), None, None),
                display_name,
                &section.section_id,
                recency_ms,
            )
        })
        .unwrap();
}

fn seed_section(state: &TaskState, section_id: &str, logical_path: &str) {
    state
        .task_store
        .transaction(|tables| {
            tables.upsert_managed_section(&ManagedSection {
                section_id: section_id.to_string(),
                logical_path: logical_path.to_string(),
            })
        })
        .unwrap();
}

fn cached_projection_rows(state: &TaskState) -> (Vec<ManagedSection>, Vec<ManagedThread>) {
    state
        .task_store
        .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
        .unwrap()
}

fn current_model_list_response() -> JsonValue {
    json!({
        "data": [
            {
                "id": "gpt-5.6-sol",
                "model": "gpt-5.6-sol",
                "displayName": "GPT-5.6-Sol",
                "description": "Latest frontier agentic coding model.",
                "hidden": false,
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast responses" },
                    { "reasoningEffort": "medium", "description": "Balanced depth" },
                    { "reasoningEffort": "high", "description": "More depth" },
                    { "reasoningEffort": "xhigh", "description": "Extra depth" },
                    { "reasoningEffort": "max", "description": "Maximum depth" },
                    { "reasoningEffort": "ultra", "description": "Automatic delegation" }
                ],
                "defaultReasoningEffort": "low",
                "serviceTiers": [{
                    "id": "priority",
                    "name": "Fast",
                    "description": "1.5x speed, increased usage"
                }],
                "defaultServiceTier": null,
                "inputModalities": ["text", "image"],
                "supportsPersonality": false,
                "isDefault": true
            },
            {
                "id": "gpt-5.6-luna",
                "model": "gpt-5.6-luna",
                "displayName": "GPT-5.6-Luna",
                "description": "General purpose model.",
                "hidden": false,
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast responses" },
                    { "reasoningEffort": "medium", "description": "Balanced depth" },
                    { "reasoningEffort": "high", "description": "More depth" },
                    { "reasoningEffort": "xhigh", "description": "Extra depth" },
                    { "reasoningEffort": "max", "description": "Maximum depth" }
                ],
                "defaultReasoningEffort": "medium",
                "serviceTiers": [{
                    "id": "priority",
                    "name": "Fast",
                    "description": "1.5x speed, increased usage"
                }],
                "defaultServiceTier": null,
                "inputModalities": ["text", "image"],
                "supportsPersonality": true,
                "isDefault": false
            },
            {
                "id": "gpt-5.4-mini",
                "model": "gpt-5.4-mini",
                "displayName": "GPT-5.4 Mini",
                "description": "Fast model without a service tier override.",
                "hidden": false,
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast responses" }
                ],
                "defaultReasoningEffort": "low",
                "serviceTiers": [],
                "defaultServiceTier": null,
                "inputModalities": ["text"],
                "supportsPersonality": false,
                "isDefault": false
            }
        ],
        "nextCursor": null
    })
}

#[tokio::test]
async fn canonical_readiness_blocks_task_creation_at_the_http_boundary() {
    let root = tempfile::tempdir().unwrap();
    let client = CodexThreadClient::mock(Vec::new());
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    let readiness = crate::codex_app_server::CodexReadiness::blocking(
        crate::codex_app_server::CodexReadinessState::UpdateRequired,
        crate::codex_app_server::CodexReadinessReason::VersionBelowMinimum,
        "Codex CLI 0.146.0 is older than the minimum supported version 0.147.0.",
        None,
    );
    state.codex_runtime.set_test_readiness(readiness).await;

    let response = router(state)
        .oneshot(
            axum::http::Request::builder()
                .method("POST")
                .uri("/api/tasks")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"prompt":"must remain blocked"}"#))
                .unwrap(),
        )
        .await
        .expect("Task creation response");

    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .expect("Task creation error body");
    let body: JsonValue = serde_json::from_slice(&body).expect("Task creation error JSON");
    assert_eq!(body["error"]["code"], "codex_readiness_blocked");
    assert!(client.mock_requests().await.is_empty());
}

#[tokio::test]
async fn reorder_mutates_only_the_local_section_order_and_notifies_after_commit() {
    let root = tempfile::tempdir().unwrap();
    let client = CodexThreadClient::mock(Vec::new());
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    state
        .codex_runtime
        .set_test_readiness(crate::codex_app_server::CodexReadiness::blocking(
            crate::codex_app_server::CodexReadinessState::Error,
            crate::codex_app_server::CodexReadinessReason::AppServerUnavailable,
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
async fn task_detail_http_projects_the_canonical_file_link_contract() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-file-link-detail-http";
    let task = root
        .path()
        .join("Library/Application Support/Caffold/data/worktrees/example");
    let policy = task.join("docs/review/policy.md");
    std::fs::create_dir_all(policy.parent().unwrap()).unwrap();
    std::fs::write(&policy, "# Review Policy\n").unwrap();
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/resume",
            resumed_task(thread_id, &task),
            std::time::Duration::from_secs(1),
        ),
    ]);
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
    cache_and_manage_test_thread(&state, thread_id, &task).await;
    state.task_events.publish(task_event_record(
        thread_id,
        "assistant",
        "assistant_message",
        "File-link HTTP projection",
        Some(json!({
            "text": format!(
                "[Policy]({}:22) [Missing](missing.rs) [External](https://example.com)",
                policy.display()
            )
        })),
        1,
    ));

    let response = router(state)
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(format!("/api/tasks/{thread_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("Task detail response");

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(
        response.headers()[axum::http::header::CONTENT_TYPE],
        "application/json"
    );
    let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
        .await
        .expect("Task detail body");
    let body: JsonValue = serde_json::from_slice(&body).expect("Task detail JSON");

    assert_eq!(
        body["events"][0]["payload"]["text"],
        "[Policy](docs/review/policy.md#L22) Missing [External](https://example.com)"
    );
    assert_eq!(body["fileLinks"].as_array().unwrap().len(), 2);
    assert_eq!(
        body["fileLinks"][0]["eventId"],
        format!("{thread_id}:assistant")
    );
    assert_eq!(body["fileLinks"][0]["linkId"], 0);
    assert_eq!(body["fileLinks"][0]["target"], "docs/review/policy.md#L22");
    assert_eq!(body["fileLinks"][0]["status"], "resolved");
    assert_eq!(
        body["fileLinks"][0]["path"],
        "Library/Application Support/Caffold/data/worktrees/example/docs/review/policy.md"
    );
    assert_eq!(
        body["fileLinks"][0]["taskRelativePath"],
        "docs/review/policy.md"
    );
    assert_eq!(body["fileLinks"][0]["line"], 22);
    assert_eq!(body["fileLinks"][1]["linkId"], 1);
    assert_eq!(body["fileLinks"][1]["target"], "missing.rs");
    assert_eq!(body["fileLinks"][1]["status"], "rejected");
    assert_eq!(body["fileLinks"][1]["reason"], "not_found");
}

#[tokio::test]
async fn task_stream_http_projects_live_file_links_in_the_sse_envelope() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-file-link-stream-http";
    let task = root.path().join("task");
    std::fs::create_dir(&task).unwrap();
    std::fs::write(task.join("live.rs"), "pub fn live() {}\n").unwrap();
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/resume",
            resumed_task(thread_id, &task),
            std::time::Duration::from_secs(1),
        ),
    ]);
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
    cache_and_manage_test_thread(&state, thread_id, &task).await;

    let response = router(state.clone())
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri(format!("/api/tasks/{thread_id}/stream"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("Task stream response");

    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(
        response.headers()[axum::http::header::CONTENT_TYPE],
        "text/event-stream; charset=utf-8"
    );
    let mut body = response.into_body().into_data_stream();
    let ready = tokio::time::timeout(std::time::Duration::from_millis(100), body.next())
        .await
        .expect("Task stream ready frame")
        .expect("Task stream remains open")
        .unwrap();
    let bootstrap = tokio::time::timeout(std::time::Duration::from_millis(100), body.next())
        .await
        .expect("Task stream bootstrap frame")
        .expect("Task stream remains open")
        .unwrap();
    assert_eq!(ready.as_ref(), b": ready\n\n");
    assert!(
        std::str::from_utf8(&bootstrap)
            .unwrap()
            .starts_with("event: task-sync\ndata: ")
    );

    state.task_events.publish(task_event_record(
        thread_id,
        "live-assistant",
        "assistant_message",
        "Live file-link projection",
        Some(json!({ "text": "[Live](live.rs:9:3)" })),
        2,
    ));

    let live_frame = tokio::time::timeout(std::time::Duration::from_millis(500), async {
        loop {
            let bytes = body
                .next()
                .await
                .expect("Task stream remains open")
                .expect("Task stream frame");
            let frame = std::str::from_utf8(&bytes).expect("UTF-8 Task stream frame");
            if frame.starts_with("event: task-event\ndata: ") {
                break frame.to_string();
            }
        }
    })
    .await
    .expect("Live Task event frame");
    let payload = live_frame
        .strip_prefix("event: task-event\ndata: ")
        .and_then(|frame| frame.strip_suffix("\n\n"))
        .expect("Task event SSE payload");
    let payload: JsonValue = serde_json::from_str(payload).expect("Task event SSE JSON");

    assert_eq!(payload["threadId"], thread_id);
    assert_eq!(payload["event"]["payload"]["text"], "[Live](live.rs#L9)");
    assert_eq!(payload["fileLinks"].as_array().unwrap().len(), 1);
    assert_eq!(
        payload["fileLinks"][0]["eventId"],
        format!("{thread_id}:live-assistant")
    );
    assert_eq!(payload["fileLinks"][0]["linkId"], 0);
    assert_eq!(payload["fileLinks"][0]["target"], "live.rs#L9");
    assert_eq!(payload["fileLinks"][0]["status"], "resolved");
    assert_eq!(payload["fileLinks"][0]["path"], "task/live.rs");
    assert_eq!(payload["fileLinks"][0]["taskRelativePath"], "live.rs");
    assert_eq!(payload["fileLinks"][0]["line"], 9);
}

fn initialize_git_repository(path: &std::path::Path) {
    std::fs::create_dir_all(path).unwrap();
    for args in [
        vec!["init"],
        vec!["config", "user.email", "test@example.com"],
        vec!["config", "user.name", "Caffold Test"],
    ] {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
    }
    std::fs::write(path.join("README.md"), "initial\n").unwrap();
    for args in [vec!["add", "README.md"], vec!["commit", "-m", "Initial"]] {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
    }
}

fn git_branch_exists(path: &std::path::Path, branch_name: &str) -> bool {
    std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["show-ref", "--verify", &format!("refs/heads/{branch_name}")])
        .output()
        .unwrap()
        .status
        .success()
}

#[test]
fn task_state_preserves_the_configured_default_cwd() {
    let root = tempfile::tempdir().unwrap();
    let project = root.path().join("project");
    std::fs::create_dir(&project).unwrap();
    let (shutdown, _) = broadcast::channel(1);
    let state = TaskState::new(
        Arc::new(RootedFs::new(root.path()).unwrap()),
        "project".to_string(),
        shutdown,
        TaskStore::memory().unwrap(),
        root.path().join("managed-worktrees"),
    )
    .expect("task state");

    assert_eq!(
        PathBuf::from(task_cwd(&state, None).unwrap()),
        project.canonicalize().unwrap()
    );
}

#[tokio::test]
async fn codex_models_preserves_app_server_reasoning_efforts() {
    let root = tempfile::tempdir().unwrap();
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "model/list",
        json!({
            "data": [{
                "id": "gpt-5.6-sol",
                "model": "gpt-5.6-sol",
                "displayName": "GPT-5.6-Sol",
                "description": "Latest frontier agentic coding model.",
                "hidden": false,
                "supportedReasoningEfforts": [
                    { "reasoningEffort": "low", "description": "Fast responses" },
                    { "reasoningEffort": "xhigh", "description": "Extra depth" },
                    { "reasoningEffort": "max", "description": "Maximum depth" },
                    { "reasoningEffort": "ultra", "description": "Automatic delegation" }
                ],
                "defaultReasoningEffort": "low",
                "serviceTiers": [{
                    "id": "priority",
                    "name": "Fast",
                    "description": "1.5x speed, increased usage"
                }],
                "defaultServiceTier": null,
                "inputModalities": ["text", "image"],
                "supportsPersonality": false,
                "isDefault": true
            }],
            "nextCursor": null
        }),
    )]);
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;

    let Json(response) = codex_models(State(state)).await.unwrap();
    let efforts = response["data"][0]["supportedReasoningEfforts"]
        .as_array()
        .unwrap();

    assert_eq!(efforts[0]["reasoningEffort"], "low");
    assert_eq!(efforts[0]["description"], "Fast responses");
    assert_eq!(response["data"][0]["serviceTiers"][0]["id"], "priority");
    assert_eq!(response["data"][0]["serviceTiers"][0]["name"], "Fast");
    assert!(efforts[0].get("value").is_none());
    assert!(efforts[0].get("label").is_none());
    assert_eq!(efforts[1]["reasoningEffort"], "xhigh");
    assert_eq!(efforts[2]["reasoningEffort"], "max");
    assert_eq!(efforts[3]["reasoningEffort"], "ultra");
}

#[tokio::test]
async fn codex_permissions_use_app_server_profiles_and_effective_defaults() {
    let root = tempfile::tempdir().unwrap();
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "permissionProfile/list",
            json!({
                "data": [
                    {
                        "id": ":workspace",
                        "description": "Workspace access",
                        "allowed": true
                    },
                    {
                        "id": ":danger-full-access",
                        "description": "Full access",
                        "allowed": false
                    }
                ],
                "nextCursor": null
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "config/read",
            json!({
                "config": {
                    "approval_policy": "on-request",
                    "approvals_reviewer": "auto_review",
                    "sandbox_mode": "workspace-write"
                },
                "origins": {},
                "layers": null
            }),
        ),
    ]);
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;

    let Json(response) =
        codex_permissions(State(state), Query(CodexPermissionsQuery { cwd: None }))
            .await
            .unwrap();

    assert_eq!(response.default_mode, CodexPermissionMode::ApproveForMe);
    assert!(response.options[0].allowed);
    assert!(response.options[1].allowed);
    assert!(!response.options[2].allowed);
    assert!(response.options[2].dangerous);
}

#[tokio::test]
async fn create_task_keeps_explicit_permission_mode_for_the_first_turn() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-explicit-permission";
    let mut responses = vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/start",
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Explicit permission regression",
                "status": { "type": "idle" },
                "cwd": root.path().display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 1.0,
                "turns": []
            },
            "approvalPolicy": "on-request",
            "approvalsReviewer": "user",
            "activePermissionProfile": {
                "id": ":workspace"
            }
        }),
    )];
    responses.push(crate::codex_app_server::MockCodexResponse::ok_for(
        "thread/name/set",
        json!({
            "threadId": thread_id,
            "name": "Use the selected approval mode",
        }),
        json!({}),
    ));
    responses.push(crate::codex_app_server::MockCodexResponse::ok(
        "turn/start",
        json!({
            "turn": {
                "id": "turn-explicit-permission",
                "items": [],
                "status": "inProgress"
            }
        }),
    ));
    let client = CodexThreadClient::mock(responses);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

    let response = create_task(
        State(state),
        Json(CreateTaskRequest {
            prompt: "Use the selected approval mode".to_string(),
            images: Vec::new(),
            cwd: None,
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: Some(CodexPermissionMode::ApproveForMe),
        }),
    )
    .await
    .expect("task creation succeeds");

    assert_eq!(
        response.0.permission_mode,
        Some(CodexPermissionMode::ApproveForMe)
    );
    let requests = client.mock_requests().await;
    assert_eq!(requests[0].0, "thread/start");
    assert_eq!(requests[0].1["serviceTier"], "default");
    assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
    assert_eq!(
        requests[0].1["dynamicTools"][0]["name"],
        "rename_current_thread"
    );
    assert_eq!(
        requests[0].1["dynamicTools"][0]["inputSchema"]["required"],
        json!(["name"])
    );
    assert_eq!(
        requests[0].1["dynamicTools"][1]["name"],
        "isolate_current_task"
    );
    assert_eq!(
        requests[0].1["dynamicTools"][1]["inputSchema"]["properties"]
            .as_object()
            .unwrap()
            .keys()
            .collect::<Vec<_>>(),
        ["baseRef", "branchName", "includeChanges"]
    );
    assert_eq!(requests[2].0, "turn/start");
    assert_eq!(requests[2].1["approvalsReviewer"], "auto_review");
}

#[tokio::test]
async fn create_task_persists_the_applied_model_and_reasoning_effort() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-model-settings";
    let mut responses = vec![
        crate::codex_app_server::MockCodexResponse::ok("model/list", current_model_list_response()),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/start",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Model settings regression",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 1.0,
                    "turns": []
                },
                "model": "gpt-5.6-luna",
                "reasoningEffort": "medium"
            }),
        ),
    ];
    responses.push(crate::codex_app_server::MockCodexResponse::ok_for(
        "thread/name/set",
        json!({ "threadId": thread_id, "name": "Use xhigh" }),
        json!({}),
    ));
    responses.push(crate::codex_app_server::MockCodexResponse::ok(
        "turn/start",
        json!({
            "turn": {
                "id": "turn-model-settings",
                "items": [],
                "status": "inProgress"
            }
        }),
    ));
    let client = CodexThreadClient::mock(responses);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    seed_section(&state, "section-root", "");
    let (_, mut list_updates) = state.task_list_events.subscribe();

    let response = create_task(
        State(state.clone()),
        Json(CreateTaskRequest {
            prompt: "Use xhigh".to_string(),
            images: Vec::new(),
            cwd: None,
            model: Some("gpt-5.6-sol".to_string()),
            effort: Some("xhigh".to_string()),
            fast_mode: true,
            permission_mode: None,
        }),
    )
    .await
    .expect("task creation succeeds");

    assert_eq!(response.0.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(response.0.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(response.0.fast_mode);
    let placement = response
        .0
        .active_top_placement
        .as_ref()
        .expect("create response carries canonical top placement");
    assert_eq!(placement.section.id, "section-root");
    assert!(placement.before_thread_id.is_none());
    match list_updates.recv().await.expect("placement list update") {
        TaskListUpdate::Placement(update) => {
            assert_eq!(update.task.thread_id, thread_id);
            assert_eq!(update.placement, *placement);
        }
        update => panic!("expected placement list update, got {update:?}"),
    }
    let stored = task_store_get(&state, thread_id)
        .await
        .unwrap()
        .expect("managed thread settings");
    assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(stored.fast_mode);
    let requests = client.mock_requests().await;
    assert_eq!(requests[1].0, "thread/start");
    assert_eq!(requests[1].1["serviceTier"], "priority");
    assert_eq!(requests[3].0, "turn/start");
    assert_eq!(requests[3].1["model"], "gpt-5.6-sol");
    assert_eq!(requests[3].1["serviceTier"], "priority");
    assert_eq!(requests[3].1["effort"], "xhigh");
}

#[tokio::test]
async fn local_ledger_failure_rolls_back_a_new_thread_before_caffold_claims_it() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-section-setup-failure";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/start",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Section setup rollback",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 1.0,
                    "turns": []
                }
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok_for(
            "thread/name/set",
            json!({
                "threadId": thread_id,
                "name": "Must not become managed",
            }),
            json!({}),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/archive", json!({})),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    state
        .task_store
        .claim(ManagedThread::new(thread_id, Some(1), None, None), 1)
        .unwrap();
    state.task_store.archive(thread_id, 2).unwrap().unwrap();

    let result = create_task(
        State(state.clone()),
        Json(CreateTaskRequest {
            prompt: "Must not become managed".to_string(),
            images: Vec::new(),
            cwd: None,
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
        }),
    )
    .await;

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
        ["thread/start", "thread/name/set", "thread/archive"]
    );
}

#[tokio::test]
async fn local_ledger_failure_rolls_a_restore_back_to_archived_membership() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-section-restore-failure";
    let mut thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    thread["cwd"] = json!(root.path().join("missing").display().to_string());
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unarchive",
            json!({ "thread": thread }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/archive", json!({})),
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread() }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/archive", json!({})),
        crate::codex_app_server::MockCodexResponse::ok(
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread() }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/archive", json!({})),
        crate::codex_app_server::MockCodexResponse::ok("thread/delete", json!({})),
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

    let _ = task_archive(State(state.clone()), AxumPath(thread_id.to_string()))
        .await
        .expect("archive succeeds");
    assert!(git_branch_exists(&source, &worktree.branch_name));

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
    assert!(git_branch_exists(&source, &worktree.branch_name));
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
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread() }),
        ),
        crate::codex_app_server::MockCodexResponse::error(
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread() }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/archive", json!({})),
        crate::codex_app_server::MockCodexResponse::error(
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
async fn codex_turn_options_accepts_server_reported_reasoning_efforts() {
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok("model/list", current_model_list_response()),
        crate::codex_app_server::MockCodexResponse::ok("model/list", current_model_list_response()),
    ]);

    let xhigh = codex_turn_options(
        &client,
        Some("gpt-5.6-sol".to_string()),
        Some("xhigh".to_string()),
        false,
        Some(CodexPermissionMode::AskForApproval),
    )
    .await
    .unwrap();
    assert_eq!(xhigh.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(xhigh.effort.as_deref(), Some("xhigh"));

    let max = codex_turn_options(
        &client,
        Some("gpt-5.6-luna".to_string()),
        Some("max".to_string()),
        false,
        Some(CodexPermissionMode::ApproveForMe),
    )
    .await
    .unwrap();
    assert_eq!(max.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(max.effort.as_deref(), Some("max"));
}

#[tokio::test]
async fn codex_turn_options_maps_fast_mode_and_normalizes_unsupported_models() {
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok("model/list", current_model_list_response()),
        crate::codex_app_server::MockCodexResponse::ok("model/list", current_model_list_response()),
        crate::codex_app_server::MockCodexResponse::ok("model/list", current_model_list_response()),
    ]);

    let fast = codex_turn_options(
        &client,
        Some("gpt-5.6-sol".to_string()),
        Some("low".to_string()),
        true,
        None,
    )
    .await
    .unwrap();
    assert_eq!(fast.service_tier.as_deref(), Some("priority"));

    let normal = codex_turn_options(
        &client,
        Some("gpt-5.6-sol".to_string()),
        Some("low".to_string()),
        false,
        None,
    )
    .await
    .unwrap();
    assert_eq!(normal.service_tier.as_deref(), Some("default"));

    let normalized = codex_turn_options(
        &client,
        Some("gpt-5.4-mini".to_string()),
        Some("low".to_string()),
        true,
        None,
    )
    .await
    .unwrap();
    assert_eq!(normalized.service_tier.as_deref(), Some("default"));
}

#[tokio::test]
async fn codex_turn_options_rejects_effort_not_supported_by_selected_model() {
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "model/list",
        current_model_list_response(),
    )]);

    let error = codex_turn_options(
        &client,
        Some("gpt-5.6-luna".to_string()),
        Some("ultra".to_string()),
        true,
        Some(CodexPermissionMode::AskForApproval),
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        ApiError::BadRequest {
            code: "invalid_codex_effort",
            ..
        }
    ));
}

#[tokio::test]
async fn codex_turn_options_rejects_model_missing_from_server_list() {
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "model/list",
        current_model_list_response(),
    )]);

    let error = codex_turn_options(
        &client,
        Some("gpt-imaginary".to_string()),
        Some("high".to_string()),
        false,
        Some(CodexPermissionMode::AskForApproval),
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        ApiError::BadRequest {
            code: "invalid_codex_model",
            ..
        }
    ));
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
    assert_eq!(tasks[0].thread_status, ThreadStatus::NotLoaded);
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
    let resolved = resolve_thread_cwd(&state.fs, &thread);
    let task = task_record_from_thread(&thread, &[], resolved.as_ref()).unwrap();
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
async fn archive_and_restore_keep_caffold_membership_in_separate_lists() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-archive-round-trip";
    let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    let responses = vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread.clone() }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/archive", json!({})),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread.clone() }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
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
    responses.push(crate::codex_app_server::MockCodexResponse::ok(
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/unarchive",
            json!({ "thread": thread }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/archive", json!({})),
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
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok_for(
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
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
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
        crate::codex_app_server::MockCodexResponse::ok("thread/read", json!({ "thread": thread })),
        crate::codex_app_server::MockCodexResponse::error(
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
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::error(
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
        crate::codex_app_server::MockCodexResponse::error(
            "thread/read",
            CodexThreadError::ThreadUnavailable(
                "no rollout found for thread id thread-unavailable-delete".to_string(),
            ),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/delete", json!({})),
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

    let archived = list_archived_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
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
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::error(
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

#[tokio::test]
async fn archived_list_uses_the_cached_name_without_persisting_read_observations() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-archived-stale-read";
    let mut thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    thread["name"] = json!("Stale Codex name");
    thread["updatedAt"] = json!(99.0);
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
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

    let response = list_archived_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
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
async fn archived_list_fails_as_a_whole_without_updating_recency_on_read_error() {
    let root = tempfile::tempdir().unwrap();
    let good_id = "thread-archived-good";
    let failed_id = "thread-archived-failed";
    let mut good_thread = task_thread_list(good_id, root.path())["data"][0].clone();
    good_thread["updatedAt"] = json!(99.0);
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": good_thread }),
        ),
        crate::codex_app_server::MockCodexResponse::error(
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

    assert!(matches!(result, Err(ApiError::CodexThread(_))));
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
async fn task_prompt_persists_the_applied_model_and_reasoning_effort() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-follow-up-model-settings";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::ok("model/list", current_model_list_response()),
        crate::codex_app_server::MockCodexResponse::ok(
            "turn/start",
            json!({
                "turn": {
                    "id": "turn-follow-up-model-settings",
                    "items": [],
                    "status": "inProgress"
                }
            }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    task_store_update_composer_settings(
        &state,
        thread_id,
        Some("gpt-5.6-luna"),
        Some("medium"),
        false,
    )
    .await
    .unwrap();

    let response = task_prompt(
        State(state.clone()),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Continue with xhigh".to_string(),
            images: Vec::new(),
            model: Some("gpt-5.6-sol".to_string()),
            effort: Some("xhigh".to_string()),
            fast_mode: true,
            permission_mode: None,
            active_turn_id: None,
        }),
    )
    .await
    .expect("follow-up prompt succeeds");

    assert!(!response.0.steered);
    let stored = task_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(stored.fast_mode);
    let requests = client.mock_requests().await;
    assert_eq!(
        requests
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["thread/resume", "model/list", "turn/start"]
    );
    assert_eq!(requests[2].1["model"], "gpt-5.6-sol");
    assert_eq!(requests[2].1["effort"], "xhigh");
    assert_eq!(requests[2].1["serviceTier"], "priority");
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
        crate::codex_app_server::MockCodexResponse::ok_for(
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
        crate::codex_app_server::MockCodexResponse::ok_for(
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
    state.codex_runtime.spawn_test_bridge(client.clone(), 1);

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
    client.mock_publish_event(crate::codex_app_server::CodexRuntimeEvent::Notification(
        crate::codex_app_server::CodexNotification::ThreadStatusChanged {
            thread_id: first_id.to_string(),
            status: ThreadStatus::Idle,
        },
    ));
    let third = tokio::time::timeout(std::time::Duration::from_millis(100), body.next())
        .await
        .expect("tracked global Thread publishes later status changes")
        .expect("task list stream remains open")
        .unwrap();
    let third = std::str::from_utf8(&third).unwrap();
    assert!(third.starts_with("event: task-sync\ndata: "));
    assert!(third.contains("\"threadId\":\"thread-list-stream-first\""));
    assert!(third.contains("\"title\":\"Persisted first name\""));
    assert!(third.contains("\"type\":\"idle\""));
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            json!({
                "data": [thread],
                "nextCursor": "repeated",
                "backwardsCursor": null,
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
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
        Err(ApiError::CodexThread(message)) if message.contains("repeated")
    ));
    assert_eq!(cached_projection_rows(&state), before);
}

#[tokio::test]
async fn task_list_stream_queues_updates_observed_while_building_its_snapshot() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-list-snapshot-race";
    let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/list",
            json!({
                "data": [thread.clone()],
                "nextCursor": null,
                "backwardsCursor": null,
            }),
            std::time::Duration::from_millis(50),
        ),
    ]);
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
    let resolved = resolve_thread_cwd(&state.fs, &thread);
    let mut queued = task_record_from_thread(&thread, &[], resolved.as_ref()).unwrap();
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

#[tokio::test]
async fn task_prompt_starts_and_steers_the_same_thread_in_its_ready_managed_worktree() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-managed-follow-up";
    let managed_cwd = root.path().join("managed/worktree-1");
    initialize_git_repository(root.path());
    let checkout =
        crate::git::create_attached_worktree(root.path(), &managed_cwd, "caffold/review", None)
            .unwrap();
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::ok("model/list", current_model_list_response()),
        crate::codex_app_server::MockCodexResponse::ok(
            "turn/start",
            json!({
                "turn": {
                    "id": "turn-managed-follow-up",
                    "items": [],
                    "status": "inProgress"
                }
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "turn/steer",
            json!({ "turnId": "turn-managed-follow-up" }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    state
        .task_store
        .create_worktree(ManagedWorktree {
            worktree_id: "worktree-1".to_string(),
            thread_id: Some(thread_id.to_string()),
            repository_git_dir: checkout.common_dir.display().to_string(),
            worktree_path: managed_cwd.display().to_string(),
            branch_name: checkout.branch_name,
            head_sha: checkout.head_sha,
            state: ManagedWorktreeState::Ready,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();

    let response = task_prompt(
        State(state.clone()),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Review the issue now".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: None,
        }),
    )
    .await
    .expect("managed follow-up prompt succeeds");

    assert!(!response.0.steered);
    let requests = client.mock_requests().await;
    let turn_start = requests.last().unwrap();
    assert_eq!(turn_start.0, "turn/start");
    assert_eq!(turn_start.1["threadId"], thread_id);
    assert_eq!(turn_start.1["cwd"], managed_cwd.display().to_string());
    assert_eq!(
        state
            .codex_sessions
            .snapshot(thread_id)
            .await
            .unwrap()
            .thread
            .unwrap()
            .cwd,
        managed_cwd.display().to_string()
    );

    let syncing = state.codex_sessions.begin_external_sync(thread_id).await;
    state
        .codex_sessions
        .apply_external_read_sync(
            thread_id,
            syncing.revision,
            serde_json::from_value(json!({
                "id": thread_id,
                "preview": "Managed follow-up",
                "status": { "type": "active", "activeFlags": [] },
                "cwd": root.path().display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            }))
            .unwrap(),
            serde_json::from_value(json!({
                "data": [{
                    "id": "turn-managed-follow-up",
                    "items": [],
                    "status": "inProgress"
                }],
                "nextCursor": null,
                "backwardsCursor": null
            }))
            .unwrap(),
        )
        .await;
    let snapshot = state.codex_sessions.snapshot(thread_id).await.unwrap();
    assert_eq!(
        snapshot.thread.unwrap().cwd,
        root.path().display().to_string()
    );
    assert_eq!(
        snapshot.active_turn_cwd.as_deref(),
        Some(managed_cwd.to_str().unwrap())
    );

    let response = task_prompt(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Steer inside the managed worktree".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: Some("turn-managed-follow-up".to_string()),
        }),
    )
    .await
    .expect("managed active turn remains steerable after external sync");

    assert!(response.0.steered);
    assert_eq!(
        client
            .mock_requests()
            .await
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["thread/resume", "turn/start", "turn/steer"]
    );
}

#[tokio::test]
async fn task_prompt_rejects_an_unavailable_ready_worktree_before_calling_codex() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-missing-ready-worktree";
    initialize_git_repository(root.path());
    let repository = crate::git::managed_repository(root.path()).unwrap();
    let missing = root.path().join("managed/missing-worktree");
    let client = CodexThreadClient::mock(Vec::new());
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    state
        .task_store
        .create_worktree(ManagedWorktree {
            worktree_id: "worktree-missing".to_string(),
            thread_id: Some(thread_id.to_string()),
            repository_git_dir: repository.common_dir.display().to_string(),
            worktree_path: missing.display().to_string(),
            branch_name: "caffold/missing".to_string(),
            head_sha: repository.head_sha,
            state: ManagedWorktreeState::Ready,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();

    let error = task_prompt(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Do not start in a missing directory".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: None,
        }),
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        ApiError::BadRequest {
            code: "managed_worktree_unavailable",
            message,
        } if message.contains(&missing.display().to_string())
    ));
    assert!(client.mock_requests().await.is_empty());
}

#[tokio::test]
async fn task_prompt_blocks_a_transfer_that_requires_manual_recovery() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-recovery-required";
    let client = CodexThreadClient::mock(Vec::new());
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    state
        .task_store
        .create_worktree(ManagedWorktree {
            worktree_id: "worktree-recovery".to_string(),
            thread_id: Some(thread_id.to_string()),
            repository_git_dir: root.path().join(".git").display().to_string(),
            worktree_path: root.path().join("managed/recovery").display().to_string(),
            branch_name: "caffold/recovery".to_string(),
            head_sha: "deadbeef".to_string(),
            state: ManagedWorktreeState::RecoveryRequired,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();

    let error = task_prompt(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Do not lose my work".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: None,
        }),
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        ApiError::BadRequest {
            code: "worktree_transfer_recovery_required",
            ..
        }
    ));
    assert!(client.mock_requests().await.is_empty());
}

#[tokio::test]
async fn task_prompt_does_not_steer_the_isolation_turn_in_the_old_checkout() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-isolation-finishing";
    let managed_cwd = root.path().join("managed/worktree-1");
    initialize_git_repository(root.path());
    let checkout =
        crate::git::create_attached_worktree(root.path(), &managed_cwd, "caffold/review", None)
            .unwrap();
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/resume",
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Isolation finishing",
                "status": { "type": "active", "activeFlags": [] },
                "cwd": root.path().display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            },
            "initialTurnsPage": {
                "data": [{
                    "id": "turn-isolation",
                    "items": [],
                    "status": "inProgress"
                }],
                "nextCursor": null,
                "backwardsCursor": null
            }
        }),
    )]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    state
        .task_store
        .create_worktree(ManagedWorktree {
            worktree_id: "worktree-1".to_string(),
            thread_id: Some(thread_id.to_string()),
            repository_git_dir: checkout.common_dir.display().to_string(),
            worktree_path: managed_cwd.display().to_string(),
            branch_name: checkout.branch_name,
            head_sha: checkout.head_sha,
            state: ManagedWorktreeState::Ready,
            created_at_ms: 1,
            updated_at_ms: 1,
        })
        .unwrap();

    let error = task_prompt(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Do not steer the old turn".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: Some("turn-isolation".to_string()),
        }),
    )
    .await
    .unwrap_err();

    assert!(matches!(
        error,
        ApiError::BadRequest {
            code: "worktree_transfer_finishing",
            ..
        }
    ));
    assert_eq!(
        client
            .mock_requests()
            .await
            .iter()
            .map(|(method, _)| method.as_str())
            .collect::<Vec<_>>(),
        ["thread/resume"]
    );
}

#[tokio::test]
async fn task_prompt_recovers_a_system_error_thread_with_a_new_turn() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-system-error-recovery";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Failed turn recovery regression",
                    "status": { "type": "systemError" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": [{
                        "id": "turn-failed",
                        "items": [],
                        "status": "failed"
                    }]
                },
                "initialTurnsPage": {
                    "data": [{
                        "id": "turn-failed",
                        "items": [],
                        "status": "failed"
                    }],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "turn/start",
            json!({
                "turn": {
                    "id": "turn-recovery",
                    "items": [],
                    "status": "inProgress"
                }
            }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let response = task_prompt(
        State(state.clone()),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Retry after the failed turn".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: None,
        }),
    )
    .await
    .expect("system error follow-up starts a recovery turn");

    assert!(!response.0.steered);
    assert_eq!(response.0.turn_id, "turn-recovery");
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/resume", "turn/start"]
    );
    assert_eq!(
        state
            .codex_sessions
            .snapshot(thread_id)
            .await
            .expect("recovered session")
            .active_turn_id
            .as_deref(),
        Some("turn-recovery")
    );
}

#[tokio::test]
async fn task_prompt_resumes_a_not_loaded_thread_before_starting_a_new_turn() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-not-loaded-recovery";
    let resume = |status: &str| {
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Restored thread recovery regression",
                "status": { "type": status },
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
        crate::codex_app_server::MockCodexResponse::ok("thread/resume", resume("notLoaded")),
        crate::codex_app_server::MockCodexResponse::ok("thread/resume", resume("idle")),
        crate::codex_app_server::MockCodexResponse::ok(
            "turn/start",
            json!({
                "turn": {
                    "id": "turn-after-restore",
                    "items": [],
                    "status": "inProgress"
                }
            }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let response = task_prompt(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Continue after restore".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: None,
        }),
    )
    .await
    .expect("not-loaded follow-up resumes and starts a turn");

    assert!(!response.0.steered);
    assert_eq!(response.0.turn_id, "turn-after-restore");
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/resume", "thread/resume", "turn/start"]
    );
}

#[tokio::test]
async fn task_prompt_keeps_accepted_steer_visible_before_canonical_sync() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-running-prompt-reload";
    let turn_id = "turn-active";
    let prompt = "Keep this accepted steer visible after reload";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Running prompt reload regression",
                    "status": { "type": "active", "activeFlags": [] },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": [{
                        "id": turn_id,
                        "items": [],
                        "status": "inProgress"
                    }]
                }
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("turn/steer", json!({ "turnId": turn_id })),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let response = task_prompt(
        State(state.clone()),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: prompt.to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: Some(turn_id.to_string()),
        }),
    )
    .await
    .expect("steering prompt succeeds");

    assert!(response.0.steered);
    let (detail, _) = state
        .detail
        .cached(thread_id)
        .await
        .expect("cached detail remains available during the active turn");
    assert!(detail.events.iter().any(|event| {
        event.event_type == "user_message"
            && event
                .payload
                .as_ref()
                .and_then(|payload| payload["text"].as_str())
                == Some(prompt)
    }));
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/resume", "turn/steer"]
    );
}

#[tokio::test]
async fn stale_steer_refreshes_canonical_status_before_starting_a_follow_up() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-stale-steer-follow-up";
    let stale_turn_id = "turn-completed-before-steer";
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Stale steer regression",
                    "status": { "type": "active", "activeFlags": [] },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": [{
                        "id": stale_turn_id,
                        "items": [],
                        "status": "inProgress"
                    }]
                },
                "initialTurnsPage": {
                    "data": [{
                        "id": stale_turn_id,
                        "items": [],
                        "status": "inProgress"
                    }],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            }),
        ),
        crate::codex_app_server::MockCodexResponse::error(
            "turn/steer",
            crate::codex_app_server::CodexThreadError::TurnUnavailable(
                "no active turn to steer".to_string(),
            ),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Stale steer regression",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 3.0,
                    "turns": [{
                        "id": stale_turn_id,
                        "items": [],
                        "status": "completed"
                    }]
                },
                "initialTurnsPage": {
                    "data": [{
                        "id": stale_turn_id,
                        "items": [],
                        "status": "completed"
                    }],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            }),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "turn/start",
            json!({
                "turn": {
                    "id": "turn-follow-up",
                    "items": [],
                    "status": "inProgress"
                }
            }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let response = task_prompt(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TasksQuery { cursor: None }),
        Json(TaskPromptRequest {
            prompt: "Start after the completed turn".to_string(),
            images: Vec::new(),
            model: None,
            effort: None,
            fast_mode: false,
            permission_mode: None,
            active_turn_id: Some(stale_turn_id.to_string()),
        }),
    )
    .await
    .expect("canonical refresh converts the stale steer into a new turn");

    assert!(!response.0.steered);
    assert_eq!(response.0.turn_id, "turn-follow-up");
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/resume", "turn/steer", "thread/resume", "turn/start"]
    );
}

#[tokio::test]
async fn mark_seen_tracks_completion_separately_from_canonical_recency() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-seen";
    let mut thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    thread["updatedAt"] = json!(10.0);
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/read",
        json!({ "thread": thread }),
    )]);
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    state
        .task_store
        .update_completed_at(thread_id, 9_000)
        .unwrap();
    assert_eq!(
        task_store_get(&state, thread_id)
            .await
            .unwrap()
            .unwrap()
            .last_seen_activity_ms,
        None
    );

    let task = mark_task_seen(State(state.clone()), AxumPath(thread_id.to_string()))
        .await
        .unwrap();

    assert!(!task.0.unseen);
    let managed = task_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(managed.last_seen_activity_ms, Some(9_000));
    assert_eq!(managed.last_completed_at_ms, Some(9_000));
    assert_eq!(managed.last_observed_recency_ms, Some(10_000));
}

#[tokio::test]
async fn unmanaged_deep_link_is_rejected_without_reading_app_server_state() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-unmanaged-deep-link";
    let client = CodexThreadClient::mock(Vec::new());
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

    let error = task_detail(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TaskDetailQuery { cursor: None }),
    )
    .await
    .expect_err("unmanaged task route must be rejected");

    assert!(matches!(
        error,
        ApiError::BadRequest {
            code: "task_not_managed",
            ..
        }
    ));
    assert!(client.mock_requests().await.is_empty());
}

#[test]
fn task_input_accepts_text_and_raster_images() {
    let image = "data:image/png;base64,aGVsbG8=".to_string();
    assert_eq!(
        normalize_task_input("  inspect this  ", vec![image.clone()]).unwrap(),
        ("inspect this".to_string(), vec![image])
    );
}

#[test]
fn task_input_accepts_an_image_without_text() {
    let image = "data:image/webp;base64,aGVsbG8=".to_string();
    assert_eq!(
        normalize_task_input("", vec![image.clone()]).unwrap(),
        (String::new(), vec![image])
    );
}

#[test]
fn task_input_rejects_unsupported_or_malformed_images() {
    for image in [
        "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        "data:image/png;base64,not base64",
        "data:image/png;base64,a===",
    ] {
        assert!(matches!(
            normalize_task_input("inspect", vec![image.to_string()]),
            Err(ApiError::BadRequest {
                code: "invalid_task_image",
                ..
            })
        ));
    }
}

#[test]
fn task_input_limits_image_count() {
    let images = vec!["data:image/png;base64,aGVsbG8=".to_string(); MAX_TASK_IMAGES + 1];
    assert!(matches!(
        normalize_task_input("inspect", images),
        Err(ApiError::BadRequest {
            code: "too_many_task_images",
            ..
        })
    ));
}

#[tokio::test]
async fn generated_image_route_serves_only_the_registered_task_item() {
    const ONE_PIXEL_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    let root = tempfile::tempdir().unwrap();
    let client = CodexThreadClient::mock(Vec::new());
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
    state.task_events.publish(
        task_event_from_thread_item(
            "thread_1",
            1,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "imageGeneration",
                    "id": "image_1",
                    "status": "completed",
                    "result": ONE_PIXEL_PNG,
                    "savedPath": null
                }
            }),
        )
        .expect("generated image event"),
    );

    let response = router(state.clone())
        .oneshot(
            axum::http::Request::get("/api/tasks/thread_1/generated-images/image_1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("generated image response");
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/png"
    );
    assert_eq!(
        response
            .headers()
            .get(header::X_CONTENT_TYPE_OPTIONS)
            .unwrap(),
        "nosniff"
    );
    let bytes = axum::body::to_bytes(response.into_body(), MAX_IMAGE_BYTES as usize)
        .await
        .expect("generated image body");
    assert!(bytes.starts_with(b"\x89PNG\r\n\x1a\n"));

    let response = router(state)
        .oneshot(
            axum::http::Request::get("/api/tasks/thread_2/generated-images/image_1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("wrong task response");
    assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .expect("wrong task error body");
    let body: JsonValue = serde_json::from_slice(&body).expect("wrong task error json");
    assert_eq!(body["error"]["code"], "generated_image_unavailable");
}
