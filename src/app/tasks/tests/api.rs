use super::super::super::*;
use super::super::projection::*;
use super::support::*;
use crate::codex_app_server::ThreadStatus;

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
async fn codex_models_adds_backend_owned_reasoning_labels() {
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

    assert_eq!(efforts[0]["value"], "low");
    assert_eq!(efforts[0]["label"], "Light");
    assert_eq!(efforts[1]["value"], "xhigh");
    assert_eq!(efforts[1]["label"], "Extra High");
    assert_eq!(efforts[2]["label"], "Max");
    assert_eq!(efforts[3]["label"], "Ultra");
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
async fn cached_task_detail_restores_managed_thread_model_settings() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-cached-model-settings";
    let client = CodexThreadClient::mock(Vec::new());
    let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
    manage_test_thread(&state, thread_id, root.path()).await;
    thread_store_update_composer_settings(&state, thread_id, Some("gpt-5.6-sol"), Some("xhigh"))
        .await
        .unwrap();

    let (detail, revision) = cached_task_detail(&state, thread_id).await.unwrap();

    assert_eq!(revision, 0);
    assert!(detail.history_loading);
    assert_eq!(detail.model.as_deref(), Some("gpt-5.6-sol"));
    assert_eq!(detail.reasoning_effort.as_deref(), Some("xhigh"));
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
    thread_store_update_composer_settings(&state, thread_id, Some("gpt-5.6-sol"), Some("xhigh"))
        .await
        .unwrap();

    let snapshot = state
        .codex_sessions
        .ensure_subscribed(&client, 1, thread_id)
        .await
        .unwrap();
    let detail = task_detail_from_snapshot(&state, snapshot, None)
        .await
        .unwrap();

    assert_eq!(detail.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(detail.reasoning_effort.as_deref(), Some("medium"));
    let stored = thread_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(stored.model.as_deref(), Some("gpt-5.6-luna"));
    assert_eq!(stored.reasoning_effort.as_deref(), Some("medium"));
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
async fn task_list_forwards_and_returns_pagination_cursors() {
    let root = tempfile::tempdir().unwrap();
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/list",
        json!({
            "data": [],
            "nextCursor": "page-3",
            "backwardsCursor": "page-1"
        }),
    )]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

    let response = list_tasks(
        State(state),
        Query(TasksQuery {
            cursor: Some("page-2".to_string()),
        }),
    )
    .await
    .expect("task page succeeds");

    assert!(response.0.tasks.is_empty());
    assert_eq!(response.0.next_cursor.as_deref(), Some("page-3"));
    assert_eq!(
        client.mock_requests().await,
        vec![(
            "thread/list".to_string(),
            json!({
                "cursor": "page-2",
                "limit": TASK_LIST_PAGE_SIZE,
                "sortKey": "recency_at",
                "sortDirection": "desc",
                "archived": false,
                "useStateDbOnly": true
            })
        )]
    );
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
async fn canonical_snapshot_without_membership_is_not_managed() {
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

    let detail = task_detail_from_snapshot(&state, snapshot, None)
        .await
        .expect("canonical detail");

    assert!(!detail.managed);
    assert_eq!(
        detail.task.as_ref().map(|task| task.thread_id.as_str()),
        Some("thread-unmanaged")
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
    let (detail, _) = cached_task_detail(&state, thread_id)
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
async fn continue_moves_a_history_thread_into_the_managed_store() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-continue";
    let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    let client = CodexThreadClient::mock(vec![
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            task_thread_list(thread_id, root.path()),
        ),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/read",
            json!({ "thread": thread.clone() }),
        ),
        crate::codex_app_server::MockCodexResponse::ok("thread/read", json!({ "thread": thread })),
        crate::codex_app_server::MockCodexResponse::ok(
            "thread/list",
            task_thread_list(thread_id, root.path()),
        ),
    ]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

    let managed = list_managed_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
        .await
        .unwrap();
    assert!(managed.0.tasks.is_empty());
    assert!(client.mock_requests().await.is_empty());

    let history = list_task_history(State(state.clone()), Query(TasksQuery { cursor: None }))
        .await
        .unwrap();
    assert_eq!(history.0.tasks.len(), 1);

    let continued = continue_task(State(state.clone()), AxumPath(thread_id.to_string()))
        .await
        .unwrap();
    assert_eq!(continued.0.thread_id, thread_id);
    assert!(!continued.0.unseen);

    let managed = list_managed_tasks(State(state.clone()), Query(TasksQuery { cursor: None }))
        .await
        .unwrap();
    assert_eq!(managed.0.tasks.len(), 1);

    let history = list_task_history(State(state), Query(TasksQuery { cursor: None }))
        .await
        .unwrap();
    assert!(history.0.tasks.is_empty());
    assert_eq!(
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect::<Vec<_>>(),
        ["thread/list", "thread/read", "thread/read", "thread/list"]
    );
}

#[tokio::test]
async fn mark_seen_uses_canonical_activity_instead_of_cached_recency() {
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
    assert_eq!(
        thread_store_get(&state, thread_id)
            .await
            .unwrap()
            .unwrap()
            .last_seen_activity_ms,
        Some(2_000)
    );

    let task = mark_task_seen(State(state.clone()), AxumPath(thread_id.to_string()))
        .await
        .unwrap();

    assert!(!task.0.unseen);
    let managed = thread_store_get(&state, thread_id).await.unwrap().unwrap();
    assert_eq!(managed.last_seen_activity_ms, Some(10_000));
    assert_eq!(managed.last_observed_recency_ms, Some(10_000));
}

#[tokio::test]
async fn unmanaged_deep_link_reads_metadata_without_resuming() {
    let root = tempfile::tempdir().unwrap();
    let thread_id = "thread-unmanaged-deep-link";
    let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
    let client = CodexThreadClient::mock(vec![crate::codex_app_server::MockCodexResponse::ok(
        "thread/read",
        json!({ "thread": thread }),
    )]);
    let state =
        task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

    let detail = task_detail(
        State(state),
        AxumPath(thread_id.to_string()),
        Query(TaskDetailQuery { cursor: None }),
    )
    .await
    .unwrap();

    assert!(!detail.0.managed);
    assert!(detail.0.events.is_empty());
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
