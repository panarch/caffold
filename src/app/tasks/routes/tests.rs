use super::super::{projection::*, tests::support::*};
use super::*;
use crate::codex_app_server::ThreadStatus;
use crate::{fs::RootedFs, thread_store::ThreadStore};
use std::{path::PathBuf, sync::Arc};

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
                "inputModalities": ["text", "image"],
                "supportsPersonality": true,
                "isDefault": false
            }
        ],
        "nextCursor": null
    })
}

#[test]
fn extracts_codex_version_from_app_server_user_agent() {
    assert_eq!(
        codex_version_from_user_agent("Codex Desktop/0.144.4"),
        Some("0.144.4".to_string())
    );
    assert_eq!(codex_version_from_user_agent("Codex Desktop"), None);
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
        ThreadStore::memory().unwrap(),
    );

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
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
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
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "turn/start",
            json!({
                "turn": {
                    "id": "turn-explicit-permission",
                    "items": [],
                    "status": "inProgress"
                }
            }),
        ),
    ]);
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
    assert_eq!(requests[0].1["approvalsReviewer"], "auto_review");
    assert_eq!(
        requests[0].1["dynamicTools"][0]["name"],
        "rename_current_thread"
    );
    assert_eq!(
        requests[0].1["dynamicTools"][0]["inputSchema"]["required"],
        json!(["name"])
    );
    assert_eq!(requests[1].0, "turn/start");
    assert_eq!(requests[1].1["approvalsReviewer"], "auto_review");
}

#[tokio::test]
async fn create_task_persists_the_applied_model_and_reasoning_effort() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-model-settings";
    let client = CodexThreadClient::mock(vec![
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
        crate::codex_app_server::MockCodexResponse::ok(
            "turn/start",
            json!({
                "turn": {
                    "id": "turn-model-settings",
                    "items": [],
                    "status": "inProgress"
                }
            }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

    let response = create_task(
        State(state.clone()),
        Json(CreateTaskRequest {
            prompt: "Use xhigh".to_string(),
            images: Vec::new(),
            cwd: None,
            model: Some("gpt-5.6-sol".to_string()),
            effort: Some("xhigh".to_string()),
            permission_mode: None,
        }),
    )
    .await
    .expect("task creation succeeds");

    assert_eq!(response.0.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(response.0.reasoning_effort.as_deref(), Some("xhigh"));
    let stored = thread_store_get(&state, thread_id)
        .await
        .unwrap()
        .expect("managed thread settings");
    assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
    let requests = client.mock_requests().await;
    assert_eq!(requests[2].0, "turn/start");
    assert_eq!(requests[2].1["model"], "gpt-5.6-sol");
    assert_eq!(requests[2].1["effort"], "xhigh");
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
        Some(CodexPermissionMode::ApproveForMe),
    )
    .await
    .unwrap();
    assert_eq!(max.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(max.effort.as_deref(), Some("max"));
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
    let thread = task_thread_list("thread-stale-approval", root.path())["data"][0].clone();
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/read",
        json!({ "thread": thread.clone() }),
    )]);
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
    let resolved = resolve_thread_cwd(&state.fs, &thread);
    let task = task_record_from_thread(&thread, &[], resolved.as_ref()).unwrap();
    assert_eq!(task.thread_status, ThreadStatus::Idle);
    thread_store_claim(&state, managed_thread_from_task_record(&task, None, None))
        .await
        .unwrap();

    let response = list_managed_tasks(State(state), Query(TasksQuery { cursor: None }))
        .await
        .unwrap();

    assert_eq!(response.0.tasks.len(), 1);
    assert_eq!(response.0.tasks[0].thread_status, ThreadStatus::Idle);
}

#[tokio::test]
async fn managed_list_projects_persisted_completion_time_and_unseen_state() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-completed-in-background";
    let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/read",
        json!({ "thread": thread.clone() }),
    )]);
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
    let resolved = resolve_thread_cwd(&state.fs, &thread);
    let task = task_record_from_thread(&thread, &[], resolved.as_ref()).unwrap();
    thread_store_claim(&state, managed_thread_from_task_record(&task, None, None))
        .await
        .unwrap();
    state
        .thread_store
        .update_completed_at(thread_id, 5_000)
        .unwrap();

    let response = list_managed_tasks(State(state), Query(TasksQuery { cursor: None }))
        .await
        .unwrap();

    assert_eq!(response.0.tasks.len(), 1);
    assert_eq!(response.0.tasks[0].last_completed_ms, Some(5_000));
    assert!(response.0.tasks[0].unseen);
}

#[tokio::test]
async fn archive_and_restore_keep_caffold_membership_in_separate_lists() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-archive-round-trip";
    let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    let client = CodexThreadClient::mock(vec![
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
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread.clone() }),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    manage_test_thread(&state, thread_id, root.path()).await;

    let archived = task_archive(State(state.clone()), AxumPath(thread_id.to_string()))
        .await
        .expect("archive succeeds")
        .0;
    assert_eq!(archived.thread_id, thread_id);
    assert!(thread_store_get(&state, thread_id).await.unwrap().is_none());
    assert!(
        thread_store_get_archived(&state, thread_id)
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
    assert_eq!(restored.thread_id, thread_id);
    assert!(thread_store_get(&state, thread_id).await.unwrap().is_some());
    assert!(
        thread_store_get_archived(&state, thread_id)
            .await
            .unwrap()
            .is_none()
    );

    let active_page = list_managed_tasks(State(state), Query(TasksQuery { cursor: None }))
        .await
        .expect("active list succeeds");
    assert_eq!(active_page.0.tasks[0].thread_id, thread_id);
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
            "thread/read",
        ]
    );
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
    assert!(thread_store_get(&state, thread_id).await.unwrap().is_some());
    assert!(
        thread_store_get_archived(&state, thread_id)
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
    assert!(thread_store_get(&state, thread_id).await.unwrap().is_some());
    assert!(
        thread_store_get_archived(&state, thread_id)
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
    thread_store_archive(&state, thread_id)
        .await
        .unwrap()
        .unwrap();

    let result = task_restore(State(state.clone()), AxumPath(thread_id.to_string())).await;

    assert!(matches!(result, Err(ApiError::CodexThread(_))));
    assert!(thread_store_get(&state, thread_id).await.unwrap().is_none());
    assert!(
        thread_store_get_archived(&state, thread_id)
            .await
            .unwrap()
            .is_some()
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
        thread_store_archive(&state, thread_id)
            .await
            .unwrap()
            .unwrap();
    }
    let before = thread_store_get_archived(&state, good_id)
        .await
        .unwrap()
        .unwrap()
        .last_observed_recency_ms;

    let result =
        list_archived_tasks(State(state.clone()), Query(TasksQuery { cursor: None })).await;

    assert!(matches!(result, Err(ApiError::CodexThread(_))));
    assert_eq!(
        thread_store_get_archived(&state, good_id)
            .await
            .unwrap()
            .unwrap()
            .last_observed_recency_ms,
        before,
        "a failed archived page must not partially update its recency cache"
    );
}

#[tokio::test]
async fn managed_list_fails_as_a_whole_without_updating_recency_on_read_error() {
    let root = tempfile::tempdir().unwrap();
    let good_id = "thread-good";
    let failed_id = "thread-failed";
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
    manage_test_thread(&state, good_id, root.path()).await;
    manage_test_thread(&state, failed_id, root.path()).await;
    let before = thread_store_get(&state, good_id)
        .await
        .unwrap()
        .unwrap()
        .last_observed_recency_ms;

    let result = list_managed_tasks(State(state.clone()), Query(TasksQuery { cursor: None })).await;

    assert!(matches!(result, Err(ApiError::CodexThread(_))));
    assert_eq!(
        thread_store_get(&state, good_id)
            .await
            .unwrap()
            .unwrap()
            .last_observed_recency_ms,
        before,
        "a failed page must not partially update its recency cache"
    );
}

#[tokio::test]
async fn managed_list_limits_parallel_canonical_reads_to_eight() {
    let root = tempfile::tempdir().unwrap();
    let mut responses = Vec::new();
    let mut thread_ids = Vec::new();
    for index in 0..TASK_LIST_PAGE_SIZE {
        let thread_id = format!("thread-{index:02}");
        let thread = task_thread_list(&thread_id, root.path())["data"][0].clone();
        responses.push(crate::codex_app_server::MockCodexResponse::delayed_ok(
            "thread/read",
            json!({ "thread": thread }),
            Duration::from_millis(250),
        ));
        thread_ids.push(thread_id);
    }
    let client = CodexThreadClient::mock(responses);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
    for thread_id in &thread_ids {
        manage_test_thread(&state, thread_id, root.path()).await;
    }

    let listing_state = state.clone();
    let listing = tokio::spawn(async move {
        list_managed_tasks(State(listing_state), Query(TasksQuery { cursor: None })).await
    });
    wait_for_mock_method_count(&client, "thread/read", 8).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        client
            .mock_requests()
            .await
            .iter()
            .filter(|(method, _)| method == "thread/read")
            .count(),
        TASK_CANONICAL_READ_CONCURRENCY,
        "no more than eight canonical reads may be in flight"
    );

    let response = listing.await.unwrap().unwrap();
    assert_eq!(response.0.tasks.len(), TASK_LIST_PAGE_SIZE);
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
    thread_store_update_composer_settings(&state, thread_id, Some("gpt-5.6-luna"), Some("medium"))
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
            permission_mode: None,
            active_turn_id: None,
        }),
    )
    .await
    .expect("follow-up prompt succeeds");

    assert!(!response.0.steered);
    let stored = thread_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
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
        .thread_store
        .update_completed_at(thread_id, 9_000)
        .unwrap();
    assert_eq!(
        thread_store_get(&state, thread_id)
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
    let managed = thread_store_get(&state, thread_id).await.unwrap().unwrap();
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
