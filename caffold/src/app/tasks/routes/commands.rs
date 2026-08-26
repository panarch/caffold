use super::*;
use crate::agent::AgentError;

pub(super) async fn create_task(
    State(state): State<TaskState>,
    Json(request): Json<CreateTaskRequest>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let cwd = task_cwd(&state, request.cwd.as_deref())?;
    let agent = new_task_agent(&state, request.provider.as_deref(), &cwd).await?;
    let turn_options = TurnOptions {
        model: request.model,
        effort: request.effort,
        fast_mode: request.fast_mode,
        permission_mode: request.permission_mode,
    };

    let created = state
        .lifecycle
        .create_task(
            &agent,
            CreateTask {
                cwd,
                title_source: request.title_source,
                turn_options,
            },
        )
        .await?;
    // Keep the just-created subscription alive while the response is handed
    // to a Detail stream. A create-only caller drops this viewer and the normal
    // handoff grace releases the otherwise idle provider subscription.
    let _viewer = state
        .task_sessions
        .reserve_viewer(&created.task.thread_id)
        .await;
    let mut detail = state
        .detail
        .read(&agent, &created.task.thread_id, None)
        .await?;
    detail.active_top_placement = Some(created.placement);
    Ok(Json(detail))
}

pub(super) async fn task_prompt(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(_query): Query<TasksQuery>,
    Json(request): Json<TaskPromptRequest>,
) -> Result<Json<TaskPromptResponse>, ApiError> {
    let prompt_observed_ms = now_ms();
    let managed = task_store_get(&state, &thread_id)
        .await?
        .ok_or_else(task_not_managed_error)?;
    let managed_worktree = task_store_worktree_for_thread(&state, &thread_id).await?;
    let managed_cwd = managed_prompt_cwd(managed_worktree.as_ref())?;
    let (prompt, images) = normalize_task_input(&request.prompt, request.images)?;
    let _requested_active_turn_id = request.active_turn_id;
    let agent = state.task_runtime.task_agent(&thread_id).await?;
    let requested_model = request.model;
    let requested_effort = request.effort;
    let requested_fast_mode = request.fast_mode;
    let requested_permission_mode = request.permission_mode;
    state
        .task_sessions
        .restore_managed_fast_mode(&thread_id, managed.fast_mode)
        .await;
    let mut target = match state
        .task_sessions
        .prepare_prompt(&agent.driver(), agent.generation(), &thread_id)
        .await
    {
        Ok(target) => target,
        Err(error) => {
            state
                .task_runtime
                .recover_connection_error_for(&agent, &error)
                .await;
            return Err(error.into());
        }
    };
    if let Some(managed_cwd) = managed_cwd.as_deref() {
        target = managed_prompt_target(
            target,
            managed_cwd,
            state.task_sessions.snapshot(&thread_id).await.as_ref(),
        )?;
    }
    let mut refreshed_stale_turn = false;
    let outcome = loop {
        let attempted_steer = matches!(&target, PromptTarget::Steer { .. });
        let result: Result<TaskPromptOutcome, _> = match target {
            PromptTarget::Steer { turn_id } => agent
                .driver()
                .steer_turn(&thread_id, &turn_id, &prompt, &images)
                .await
                .map(|user_message| TaskPromptOutcome {
                    turn_id,
                    user_message,
                    steered: true,
                    started_turn: None,
                }),
            PromptTarget::Start { cwd } => {
                let chosen = TurnOptions {
                    model: requested_model.clone(),
                    effort: requested_effort.clone(),
                    fast_mode: requested_fast_mode,
                    permission_mode: requested_permission_mode.clone(),
                };
                let driver = agent.driver();
                let accepted = match driver.accept_turn_options(&chosen).await {
                    Ok(accepted) => accepted,
                    Err(TurnRejected::Unavailable(error)) => {
                        return Err(error.into());
                    }
                    Err(rejected) => return Err(rejected.into()),
                };
                driver
                    .start_turn(&thread_id, &cwd, &prompt, &images, &accepted)
                    .await
                    .map(|started| TaskPromptOutcome {
                        turn_id: started.turn.id.clone(),
                        user_message: started.user_message,
                        steered: false,
                        started_turn: Some((started.turn, started.applied)),
                    })
            }
        };
        match result {
            Ok(result) => break result,
            Err(error)
                if attempted_steer
                    && !refreshed_stale_turn
                    && matches!(error, AgentError::TurnGone(_)) =>
            {
                refreshed_stale_turn = true;
                if let Err(refresh_error) = state
                    .task_sessions
                    .refresh_subscription(&agent.driver(), agent.generation(), &thread_id)
                    .await
                {
                    state.task_sessions.cancel_runtime(&thread_id).await;
                    recover_agent_connection(&state, &agent, &refresh_error).await;
                    return Err(refresh_error.into());
                }
                target = match state
                    .task_sessions
                    .prepare_prompt(&agent.driver(), agent.generation(), &thread_id)
                    .await
                {
                    Ok(target) => target,
                    Err(refresh_error) => {
                        state.task_sessions.cancel_runtime(&thread_id).await;
                        state
                            .task_runtime
                            .recover_connection_error_for(&agent, &refresh_error)
                            .await;
                        return Err(refresh_error.into());
                    }
                };
                if let Some(managed_cwd) = managed_cwd.as_deref() {
                    target = managed_prompt_target(
                        target,
                        managed_cwd,
                        state.task_sessions.snapshot(&thread_id).await.as_ref(),
                    )?;
                }
            }
            Err(error) => {
                state.task_sessions.cancel_runtime(&thread_id).await;
                state
                    .task_runtime
                    .recover_connection_error_for(&agent, &error)
                    .await;
                return Err(error.into());
            }
        }
    };
    let TaskPromptOutcome {
        turn_id,
        user_message,
        steered,
        started_turn,
    } = outcome;
    let session_revision = if let Some((turn, applied_options)) = started_turn {
        let revision = state
            .task_sessions
            .record_turn_started(
                agent.generation(),
                &thread_id,
                managed_cwd.as_deref(),
                turn.clone(),
                applied_options.clone(),
            )
            .await;
        if let Some(snapshot) = state.task_sessions.snapshot(&thread_id).await {
            let persistence_result = task_store_update_composer_settings(
                &state,
                &thread_id,
                snapshot.model.as_deref(),
                snapshot.reasoning_effort.as_deref(),
                snapshot.fast_mode,
            )
            .await;
            if let Err(error) = persistence_result {
                eprintln!(
                    "failed to persist composer settings for started turn on thread {thread_id}: {error:?}"
                );
            }
        }
        revision
    } else {
        state
            .task_sessions
            .record_prompt_accepted(agent.generation(), &thread_id)
            .await
    };
    let accepted_event =
        accepted_user_message_event(&thread_id, &turn_id, &user_message, prompt_observed_ms);
    state
        .task_events
        .publish_accepted_submission(accepted_event, session_revision);
    Ok(Json(TaskPromptResponse {
        thread_id,
        turn_id,
        user_message_id: user_message.id,
        steered,
    }))
}

pub(super) fn managed_prompt_cwd(
    worktree: Option<&ManagedWorktree>,
) -> Result<Option<String>, ApiError> {
    let Some(worktree) = worktree else {
        return Ok(None);
    };
    match worktree.state {
        ManagedWorktreeState::Ready => {
            inspect_ready_worktree(worktree).map_err(|error| ApiError::BadRequest {
                code: "managed_worktree_unavailable",
                message: format!(
                    "the managed worktree is unavailable at {}: {error}",
                    worktree.worktree_path
                ),
            })?;
            Ok(Some(worktree.worktree_path.clone()))
        }
        ManagedWorktreeState::Creating
        | ManagedWorktreeState::IsolatingClean
        | ManagedWorktreeState::HandingOff
        | ManagedWorktreeState::Transferring => Err(ApiError::BadRequest {
            code: "worktree_transfer_in_progress",
            message: "the task worktree transfer is still in progress; retry after it finishes"
                .to_string(),
        }),
        ManagedWorktreeState::CleanRecoveryRequired
        | ManagedWorktreeState::HandoffRecoveryRequired
        | ManagedWorktreeState::RecoveryRequired => Err(ApiError::BadRequest {
            code: "worktree_transfer_recovery_required",
            message: format!(
                "the task worktree transfer requires recovery; keep the source and target checkouts intact and preserve refs/caffold/transfers/{} if it exists",
                worktree.worktree_id
            ),
        }),
        state => Err(ApiError::BadRequest {
            code: "managed_worktree_unavailable",
            message: format!(
                "the managed worktree is unavailable while it is {}",
                state.as_str()
            ),
        }),
    }
}

pub(super) fn managed_prompt_target(
    target: PromptTarget,
    managed_cwd: &str,
    snapshot: Option<&SessionSnapshot>,
) -> Result<PromptTarget, ApiError> {
    match target {
        PromptTarget::Start { .. } => Ok(PromptTarget::Start {
            cwd: managed_cwd.to_string(),
        }),
        PromptTarget::Steer { turn_id }
            if snapshot
                .and_then(|snapshot| snapshot.active_turn_cwd.as_deref())
                .is_some_and(|cwd| same_directory(cwd, managed_cwd)) =>
        {
            Ok(PromptTarget::Steer { turn_id })
        }
        PromptTarget::Steer { .. } => Err(ApiError::BadRequest {
            code: "worktree_transfer_finishing",
            message: "the isolation turn is still finishing in the original checkout; retry after it completes"
                .to_string(),
        }),
    }
}

pub(super) fn same_directory(left: &str, right: &str) -> bool {
    match (
        Path::new(left).canonicalize().ok(),
        Path::new(right).canonicalize().ok(),
    ) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

pub(super) async fn task_interrupt(
    State(state): State<TaskState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(_query): Query<TasksQuery>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let managed = task_store_get(&state, &thread_id)
        .await?
        .ok_or_else(task_not_managed_error)?;
    state
        .task_sessions
        .restore_managed_fast_mode(&thread_id, managed.fast_mode)
        .await;
    let agent = state.task_runtime.task_agent(&thread_id).await?;
    let Some(turn_id) = state
        .task_sessions
        .active_turn_id(&agent.driver(), agent.generation(), &thread_id)
        .await?
    else {
        return Err(ApiError::BadRequest {
            code: "task_turn_missing",
            message: "thread does not have an active turn to interrupt".to_string(),
        });
    };
    if let Err(error) = agent.driver().interrupt_turn(&thread_id, &turn_id).await {
        recover_agent_connection(&state, &agent, &error).await;
        return Err(error.into());
    }
    Ok(Json(state.detail.read(&agent, &thread_id, None).await?))
}

pub(super) async fn task_approval(
    State(state): State<TaskState>,
    AxumPath((thread_id, approval_id)): AxumPath<(String, String)>,
    Query(_query): Query<TasksQuery>,
    Json(request): Json<TaskApprovalRequest>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    if task_store_get(&state, &thread_id).await?.is_none() {
        return Err(task_not_managed_error());
    }
    let agent = state.task_runtime.task_agent(&thread_id).await?;
    let decision = normalize_approval_decision(&request.decision)?;
    match state
        .task_runtime
        .resolve_approval(&agent, &thread_id, &approval_id, decision)
        .await
    {
        Ok(()) => {}
        Err(ApprovalResolveError::NotFound) => {
            return Err(ApiError::BadRequest {
                code: "approval_not_found",
                message: "approval request is no longer pending".to_string(),
            });
        }
        Err(ApprovalResolveError::ThreadMismatch) => {
            return Err(ApiError::BadRequest {
                code: "approval_task_mismatch",
                message: "approval request belongs to another thread".to_string(),
            });
        }
        Err(ApprovalResolveError::ResolutionMismatch) => {
            return Err(ApiError::BadRequest {
                code: "approval_resolution_mismatch",
                message: "approval decision does not match the pending request".to_string(),
            });
        }
        Err(ApprovalResolveError::Agent(error)) => return Err(error.into()),
    }

    Ok(Json(state.detail.read(&agent, &thread_id, None).await?))
}

pub(super) async fn require_codex_thread_client(
    state: &TaskState,
) -> Result<CodexThreadClient, ApiError> {
    state.detail.client().await
}

pub(super) async fn require_codex_thread_connection(
    state: &TaskState,
) -> Result<CodexConnection, CodexThreadError> {
    state.detail.connection().await
}

/// The agent a Task about to be created will belong to.
///
/// Every other route reads the agent off the Task. This one has no Task yet, so
/// the choice comes from the model that was picked: the list a person chose
/// from said which agent each model belongs to, and that choice is carried back
/// here rather than guessed at from the model's name.
async fn new_task_agent(
    state: &TaskState,
    provider: Option<&str>,
    cwd: &str,
) -> Result<TaskAgent, ApiError> {
    match provider.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("codex") => Ok(TaskAgent::Codex(
            require_codex_thread_connection(state).await?,
        )),
        Some("claude") => Ok(TaskAgent::Claude {
            driver: state.task_runtime.claude().driver(cwd),
        }),
        Some(_) => Err(ApiError::BadRequest {
            code: "unsupported_provider",
            message: "Caffold does not drive that agent.".to_string(),
        }),
    }
}

/// Tell the runtime a connection failed, when the agent has one to lose.
async fn recover_agent_connection(state: &TaskState, agent: &TaskAgent, error: &AgentError) {
    state
        .task_runtime
        .recover_connection_error_for(agent, error)
        .await;
}

#[cfg(test)]
pub(super) fn managed_thread_from_task_record(
    task: &TaskRecord,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: bool,
) -> ManagedThread {
    let mut managed = ManagedThread::new(
        task.thread_id.clone(),
        RunBy::Codex,
        Some(task_activity_ms(task)),
        model,
        reasoning_effort,
    );
    managed.fast_mode = fast_mode;
    managed.last_completed_at_ms = task.last_completed_ms;
    managed
}

pub(super) fn apply_managed_thread_metadata(task: &mut TaskRecord, managed: &ManagedThread) {
    task.title = managed.display_name.clone();
    task.last_completed_ms = managed.last_completed_at_ms;
    task.unseen = managed.unseen();
}

pub(super) fn task_cwd(state: &TaskState, relative: Option<&str>) -> Result<String, ApiError> {
    let logical_path = normalize_logical_path(relative.unwrap_or(&state.default_cwd_path))?;
    let cwd = state.fs.absolute_directory_path(&logical_path)?;
    Ok(cwd.display().to_string())
}

pub(super) fn normalize_logical_path(path: &str) -> Result<String, ApiError> {
    let mut parts = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(ApiError::BadRequest {
                code: "invalid_task_cwd",
                message: "task cwd must stay inside the server root".to_string(),
            });
        }
        parts.push(segment);
    }
    Ok(parts.join("/"))
}

pub(super) fn normalize_task_input(
    prompt: &str,
    images: Vec<String>,
) -> Result<(String, Vec<String>), ApiError> {
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() && images.is_empty() {
        return Err(ApiError::BadRequest {
            code: "empty_task_prompt",
            message: "task prompt or image cannot be empty".to_string(),
        });
    }
    if images.len() > MAX_TASK_IMAGES {
        return Err(ApiError::BadRequest {
            code: "too_many_task_images",
            message: format!("a task turn can include at most {MAX_TASK_IMAGES} images"),
        });
    }
    for image in &images {
        validate_task_image_data_url(image)?;
    }
    Ok((prompt, images))
}

pub(super) fn validate_task_image_data_url(image: &str) -> Result<(), ApiError> {
    const PREFIXES: [&str; 6] = [
        "data:image/avif;base64,",
        "data:image/gif;base64,",
        "data:image/jpeg;base64,",
        "data:image/jpg;base64,",
        "data:image/png;base64,",
        "data:image/webp;base64,",
    ];
    let Some(encoded) = PREFIXES
        .iter()
        .find_map(|prefix| image.strip_prefix(prefix))
    else {
        return Err(ApiError::BadRequest {
            code: "invalid_task_image",
            message: "task images must be base64-encoded raster image data URLs".to_string(),
        });
    };
    if encoded.is_empty()
        || encoded.len() % 4 != 0
        || encoded
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'+' | b'/' | b'='))
    {
        return Err(ApiError::BadRequest {
            code: "invalid_task_image",
            message: "task image data is not valid base64".to_string(),
        });
    }
    let padding = encoded
        .bytes()
        .rev()
        .take_while(|byte| *byte == b'=')
        .count();
    if padding > 2 || encoded[..encoded.len().saturating_sub(padding)].contains('=') {
        return Err(ApiError::BadRequest {
            code: "invalid_task_image",
            message: "task image data is not valid base64".to_string(),
        });
    }
    let decoded_bytes = encoded.len() / 4 * 3 - padding;
    if decoded_bytes as u64 > MAX_IMAGE_BYTES {
        return Err(ApiError::BadRequest {
            code: "task_image_too_large",
            message: format!("task images must be at most {MAX_IMAGE_BYTES} bytes each"),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as JsonValue, json};
    use tower::ServiceExt;

    /// Decode a fixture the way the adapter decodes a real answer.
    fn decoded_thread(thread: JsonValue) -> crate::agent::codex::CodexThread {
        serde_json::from_value(thread).expect("the fixture decodes as a Codex thread")
    }

    fn decoded_page(page: JsonValue) -> crate::agent::codex::TurnsPage {
        serde_json::from_value(page).expect("the fixture decodes as a Codex turns page")
    }

    use super::super::test_support::*;
    use super::*;
    use crate::{
        app::tasks::test_support::*,
        fs::RootedFs,
        task_store::{CheckoutAnchor, ManagedThread, RunBy},
    };

    async fn publish_permission_approval(
        state: &TaskState,
        client: &CodexThreadClient,
        thread_id: &str,
        request_id: i64,
    ) {
        let mut task_events = state.task_events.subscribe();
        state.task_runtime.spawn_test_bridge(client.clone(), 1);
        let request = crate::agent::codex::decode_server_request(
            json!(request_id),
            "item/permissions/requestApproval",
            json!({
                "threadId": thread_id,
                "turnId": "turn-permission",
                "itemId": "item-permission",
                "cwd": "/workspace/project",
                "permissions": { "network": { "enabled": true } },
                "reason": "Fetch the remote release metadata",
                "startedAtMs": 1_750_000_000_000_i64
            }),
        )
        .unwrap();
        client.mock_publish_event(crate::agent::codex::CodexRuntimeEvent::ServerRequest(
            request,
        ));

        let event = tokio::time::timeout(std::time::Duration::from_secs(1), task_events.recv())
            .await
            .expect("permission approval did not reach the Task runtime")
            .expect("Task event stream closed before permission approval")
            .event;
        assert_eq!(event.thread_id, thread_id);
        assert_eq!(event.event_type, "approval_requested");
        assert_eq!(
            event.payload.as_ref().unwrap()["approvalId"],
            request_id.to_string()
        );
    }

    #[tokio::test]
    async fn permission_approval_http_route_grants_only_the_server_requested_profile() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-permission-approval";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        publish_permission_approval(&state, &client, thread_id, 71).await;

        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(format!("/api/tasks/{thread_id}/approvals/71"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"decision":"allowAlways"}"#))
                    .unwrap(),
            )
            .await
            .expect("permission approval response");

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        assert_eq!(
            client.mock_server_responses().await,
            [(
                json!(71),
                json!({
                    "permissions": { "network": { "enabled": true } },
                    "scope": "session"
                })
            )]
        );
        let body = axum::body::to_bytes(response.into_body(), 1024 * 1024)
            .await
            .expect("permission approval body");
        let body: JsonValue = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["pendingApprovals"], json!([]));
    }

    #[tokio::test]
    async fn an_approval_refuses_a_decision_it_did_not_offer() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-permission-mismatch";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        publish_permission_approval(&state, &client, thread_id, 72).await;

        let response = router(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri(format!("/api/tasks/{thread_id}/approvals/72"))
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"decision":"denyAndStop"}"#))
                    .unwrap(),
            )
            .await
            .expect("mismatched approval response");

        assert_eq!(response.status(), axum::http::StatusCode::BAD_REQUEST);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: JsonValue = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "approval_resolution_mismatch");
        assert!(client.mock_server_responses().await.is_empty());
        assert_eq!(state.task_runtime.approval_events(thread_id).await.len(), 1);
    }

    #[tokio::test]
    async fn canonical_readiness_blocks_task_creation_at_the_http_boundary() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let readiness = crate::agent::codex::CodexReadiness::blocking(
            crate::agent::codex::CodexReadinessState::UpdateRequired,
            crate::agent::codex::CodexReadinessReason::VersionBelowMinimum,
            "Codex CLI 0.146.0 is older than the minimum supported version 0.147.0.",
            None,
        );
        state.task_runtime.set_test_readiness(readiness).await;

        let response = router(state)
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/api/tasks")
                    .header(axum::http::header::CONTENT_TYPE, "application/json")
                    .body(Body::from(r#"{"titleSource":"must remain blocked"}"#))
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
    async fn create_only_accepts_an_empty_title_source_and_returns_zero_turns() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-empty-create-only";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "config/read",
                json!({ "config": { "developer_instructions": null } }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/start",
                created_thread(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/name/set", json!({})),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = create_task(
            State(state.clone()),
            Json(CreateTaskRequest {
                provider: None,
                title_source: String::new(),
                cwd: None,
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: None,
            }),
        )
        .await
        .expect("create-only request succeeds");

        let task = response.0.task.expect("created Task");
        assert_eq!(task.thread_id, thread_id);
        assert_eq!(task.title, "Thread thread-e");
        assert!(task.active_turn.is_none());
        assert!(response.0.events.is_empty());
        assert!(state.task_events.for_thread(thread_id).is_empty());
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["config/read", "thread/start", "thread/name/set"]
        );
    }

    #[tokio::test]
    async fn created_task_uses_the_ordinary_prompt_contract_for_its_first_message() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-explicit-permission";
        let mut responses = vec![
            crate::agent::codex::MockCodexResponse::ok(
                "config/read",
                json!({ "config": { "developer_instructions": "Keep custom guidance." } }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
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
        ];
        responses.push(crate::agent::codex::MockCodexResponse::ok_for(
            "thread/name/set",
            json!({
                "threadId": thread_id,
                "name": "[REQ] Use the selected approval mode",
            }),
            json!({}),
        ));
        responses.push(crate::agent::codex::MockCodexResponse::ok(
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
        let creation = create_task(
            State(state.clone()),
            Json(CreateTaskRequest {
                provider: None,
                title_source: "Use the selected approval mode".to_string(),
                cwd: None,
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: Some("approveForMe".to_string()),
            }),
        )
        .await
        .expect("task creation succeeds");

        assert_eq!(creation.0.permission_mode, Some("approveForMe".to_string()));
        assert_eq!(
            creation.0.task.as_ref().map(|task| task.title.as_str()),
            Some("[REQ] Use the selected approval mode")
        );
        assert!(creation.0.task.as_ref().unwrap().active_turn.is_none());
        assert!(creation.0.events.is_empty());
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["config/read", "thread/start", "thread/name/set"]
        );
        assert!(
            !state
                .task_sessions
                .snapshot(thread_id)
                .await
                .expect("created session")
                .runtime_lease
        );

        let observed_after_creation_ms = crate::app::tasks::events::now_ms();
        let response = task_prompt(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
            Json(TaskPromptRequest {
                prompt: "Use the selected approval mode".to_string(),
                images: Vec::new(),
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: Some("approveForMe".to_string()),
                active_turn_id: None,
            }),
        )
        .await
        .expect("ordinary prompt accepts the first message");

        assert_eq!(response.0.thread_id, thread_id);
        assert_eq!(response.0.turn_id, "turn-explicit-permission");
        let requests = client.mock_requests().await;
        let requested_user_message_id = requests
            .iter()
            .find(|(method, _)| method == "turn/start")
            .and_then(|(_, request)| request["clientUserMessageId"].as_str())
            .expect("the adapter identifies the submitted user message");
        assert_eq!(
            response.0.user_message_id,
            requested_user_message_id.to_string()
        );
        let accepted = state
            .task_events
            .for_thread(thread_id)
            .into_iter()
            .find(|event| {
                event
                    .payload
                    .as_ref()
                    .and_then(|payload| payload["itemId"].as_str())
                    == Some(requested_user_message_id)
            })
            .expect("ordinary prompt publishes the accepted user message");
        assert!(accepted.position.anchor_ms >= observed_after_creation_ms);
        assert_eq!(requests[0].0, "config/read");
        assert_eq!(requests[1].0, "thread/start");
        assert_eq!(requests[1].1["serviceTier"], "default");
        assert_eq!(requests[1].1["approvalsReviewer"], "auto_review");
        let developer_instructions = requests[1].1["developerInstructions"]
            .as_str()
            .expect("composed developer instructions");
        assert!(developer_instructions.starts_with("Keep custom guidance.\n\n"));
        assert!(developer_instructions.contains("newly created Caffold task"));
        assert_eq!(requests[1].1.get("dynamicTools"), None);
        assert_eq!(requests[3].0, "turn/start");
        assert_eq!(requests[3].1["approvalsReviewer"], "auto_review");
    }

    #[tokio::test]
    async fn ordinary_first_prompt_persists_applied_composer_settings_for_task_and_section() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-model-settings";
        let mut responses = vec![
            crate::agent::codex::MockCodexResponse::ok("model/list", current_model_list_response()),
            crate::agent::codex::MockCodexResponse::ok(
                "config/read",
                json!({ "config": { "developer_instructions": null } }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
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
        responses.push(crate::agent::codex::MockCodexResponse::ok_for(
            "thread/name/set",
            json!({ "threadId": thread_id, "name": "[REQ] Use xhigh" }),
            json!({}),
        ));
        responses.push(crate::agent::codex::MockCodexResponse::ok(
            "model/list",
            current_model_list_response(),
        ));
        responses.push(crate::agent::codex::MockCodexResponse::ok(
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
                provider: None,
                title_source: "Use xhigh".to_string(),
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
        match tokio::time::timeout(std::time::Duration::from_secs(1), list_updates.recv())
            .await
            .expect("placement list update was not published")
            .expect("placement list update channel remains open")
        {
            TaskListUpdate::Placement(update) => {
                assert_eq!(update.task.thread_id, thread_id);
                assert_eq!(update.placement, *placement);
            }
            update => panic!("expected placement list update, got {update:?}"),
        }
        assert!(
            matches!(
                list_updates.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ),
            "Task creation must not publish turn-applied Section settings"
        );
        let stored_after_creation = task_store_get(&state, thread_id)
            .await
            .unwrap()
            .expect("created Task settings");
        assert_eq!(stored_after_creation.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(
            stored_after_creation.reasoning_effort.as_deref(),
            Some("xhigh")
        );
        assert!(stored_after_creation.fast_mode);

        let prompt = task_prompt(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
            Json(TaskPromptRequest {
                prompt: "Use xhigh".to_string(),
                images: Vec::new(),
                model: Some("gpt-5.6-sol".to_string()),
                effort: Some("xhigh".to_string()),
                fast_mode: true,
                permission_mode: None,
                active_turn_id: None,
            }),
        )
        .await
        .expect("ordinary first prompt succeeds");
        assert!(!prompt.0.steered);

        match tokio::time::timeout(std::time::Duration::from_secs(1), list_updates.recv())
            .await
            .expect("Section composer settings update was not published")
            .expect("Section composer settings update channel remains open")
        {
            TaskListUpdate::SectionComposerSettings(update) => {
                assert_eq!(update.section_id, "section-root");
                assert_eq!(
                    update.composer_settings,
                    crate::app::tasks::active_list::ActiveTaskComposerSettings {
                        model: Some("gpt-5.6-sol".to_string()),
                        effort: Some("xhigh".to_string()),
                        fast_mode: true,
                    }
                );
            }
            update => panic!("expected Section settings update, got {update:?}"),
        }
        let stored = task_store_get(&state, thread_id)
            .await
            .unwrap()
            .expect("managed thread settings");
        assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(stored.fast_mode);
        let section = state
            .task_store
            .read(|tables| tables.managed_sections())
            .unwrap()
            .into_iter()
            .find(|section| section.section_id == "section-root")
            .unwrap();
        assert_eq!(
            section.last_composer_settings,
            Some(crate::task_store::ComposerSettings {
                model: Some("gpt-5.6-sol".to_string()),
                reasoning_effort: Some("xhigh".to_string()),
                fast_mode: true,
            })
        );
        assert_eq!(state.task_list_events.refresh_count(), 0);
        let requests = client.mock_requests().await;
        assert_eq!(requests[2].0, "thread/start");
        assert_eq!(requests[2].1["serviceTier"], "priority");
        assert_eq!(requests[5].0, "turn/start");
        assert_eq!(requests[5].1["model"], "gpt-5.6-sol");
        assert_eq!(requests[5].1["serviceTier"], "priority");
        assert_eq!(requests[5].1["effort"], "xhigh");
    }

    /// The empty thread a creation answers with.
    fn created_thread(thread_id: &str, cwd: &std::path::Path) -> JsonValue {
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Read the planner",
                "status": { "type": "idle" },
                "cwd": cwd.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 1.0,
                "turns": []
            }
        })
    }

    #[tokio::test]
    async fn empty_task_survives_runtime_replacement_before_its_first_prompt() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-first-turn-pending";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "config/read",
                json!({ "config": { "developer_instructions": null } }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/start",
                created_thread(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok_for(
                "thread/name/set",
                json!({ "threadId": thread_id, "name": "[REQ] Read the planner" }),
                json!({}),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let response = create_task(
            State(state.clone()),
            Json(CreateTaskRequest {
                provider: None,
                title_source: "Read the planner".to_string(),
                cwd: None,
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: None,
            }),
        )
        .await
        .expect("task creation succeeds");

        // The Task is already the durable unit: named, claimed at the top of
        // its Section, and carrying no submitted message or turn.
        assert_eq!(response.0.thread_id, thread_id);
        let task = response.0.task.as_ref().expect("created Task record");
        assert_eq!(task.title, "[REQ] Read the planner");
        assert!(task.active_turn.is_none());
        assert!(response.0.active_top_placement.is_some());
        assert!(
            response
                .0
                .events
                .iter()
                .all(|event| event.event_type != "user_message")
        );
        assert!(
            task_store_get(&state, thread_id).await.unwrap().is_some(),
            "the claimed Task is stored before its first turn begins"
        );

        let affected = state
            .task_sessions
            .codex_connection_lost(1, "backend replaced".to_string())
            .await;
        assert_eq!(affected, [thread_id]);
        assert!(state.task_events.for_thread(thread_id).is_empty());
        assert_eq!(
            state
                .task_store
                .read(|tables| tables.active_managed_threads())
                .unwrap()
                .into_iter()
                .filter(|thread| thread.thread_id == thread_id)
                .count(),
            1
        );

        let replacement = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "turn/start",
                json!({
                    "turn": { "id": "turn-after-replacement", "items": [], "status": "inProgress" }
                }),
            ),
        ]);
        state
            .task_runtime
            .install_test_client(2, replacement.clone())
            .await;
        let prompt = task_prompt(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
            Json(TaskPromptRequest {
                prompt: "Read the planner".to_string(),
                images: Vec::new(),
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: None,
                active_turn_id: None,
            }),
        )
        .await
        .expect("the replacement runtime accepts the ordinary first prompt");
        assert_eq!(prompt.0.turn_id, "turn-after-replacement");
        assert_eq!(
            replacement
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume", "turn/start"]
        );
    }

    #[tokio::test]
    async fn rejected_ordinary_first_prompt_leaves_the_created_task_empty() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-first-prompt-refused";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "config/read",
                json!({ "config": { "developer_instructions": null } }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/start",
                created_thread(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/name/set", json!({})),
            crate::agent::codex::MockCodexResponse::error(
                "turn/start",
                crate::agent::codex::CodexThreadError::Protocol(
                    "the agent could not be reached".to_string(),
                ),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        let detail = create_task(
            State(state.clone()),
            Json(CreateTaskRequest {
                provider: None,
                title_source: "Read the planner".to_string(),
                cwd: None,
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: None,
            }),
        )
        .await
        .expect("empty Task creation succeeds");
        assert_eq!(detail.0.thread_id, thread_id);

        let error = task_prompt(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
            Json(TaskPromptRequest {
                prompt: "Read the planner".to_string(),
                images: Vec::new(),
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: None,
                active_turn_id: None,
            }),
        )
        .await
        .expect_err("ordinary prompt failure is returned to its caller");
        assert!(error.to_string().contains("the agent could not be reached"));
        assert!(
            task_store_get(&state, thread_id).await.unwrap().is_some(),
            "the valid empty Task remains managed after prompt rejection"
        );
        let snapshot = state
            .task_sessions
            .snapshot(thread_id)
            .await
            .expect("empty Task session remains inspectable");
        assert!(snapshot.active_turn_id.is_none());
        assert!(
            state
                .task_events
                .for_thread(thread_id)
                .iter()
                .all(
                    |event| event.event_type != "task_failed" && event.event_type != "user_message"
                )
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            [
                "config/read",
                "thread/start",
                "thread/name/set",
                "turn/start",
                "thread/unsubscribe"
            ]
        );
    }

    #[tokio::test]
    async fn local_ledger_failure_rolls_back_a_new_thread_before_caffold_claims_it() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-section-setup-failure";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "config/read",
                json!({ "config": { "developer_instructions": null } }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
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
            crate::agent::codex::MockCodexResponse::ok_for(
                "thread/name/set",
                json!({
                    "threadId": thread_id,
                    "name": "[REQ] Must not become managed",
                }),
                json!({}),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/archive", json!({})),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        state
            .task_store
            .claim(
                ManagedThread::new(thread_id, RunBy::Codex, Some(1), None, None),
                1,
            )
            .unwrap();
        state.task_store.archive(thread_id, 2).unwrap().unwrap();

        let result = create_task(
            State(state.clone()),
            Json(CreateTaskRequest {
                provider: None,
                title_source: "Must not become managed".to_string(),
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
            [
                "config/read",
                "thread/start",
                "thread/name/set",
                "thread/archive"
            ]
        );
    }

    #[tokio::test]
    async fn task_prompt_persists_the_applied_composer_settings_for_the_task_and_section() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-follow-up-model-settings";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok("model/list", current_model_list_response()),
            crate::agent::codex::MockCodexResponse::ok(
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
        claim_cached_active(
            &state,
            thread_id,
            "Follow-up settings",
            1,
            "section-follow-up-settings",
            "",
        );
        task_store_update_composer_settings(
            &state,
            thread_id,
            Some("gpt-5.6-luna"),
            Some("medium"),
            false,
        )
        .await
        .unwrap();
        let (_, mut list_updates) = state.task_list_events.subscribe();

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
        match tokio::time::timeout(std::time::Duration::from_secs(1), list_updates.recv())
            .await
            .expect("Section composer settings update was not published")
            .expect("Section composer settings update channel remains open")
        {
            TaskListUpdate::SectionComposerSettings(update) => {
                assert_eq!(update.section_id, stored.section_id.clone().unwrap());
                assert_eq!(
                    update.composer_settings.model.as_deref(),
                    Some("gpt-5.6-sol")
                );
                assert_eq!(update.composer_settings.effort.as_deref(), Some("xhigh"));
                assert!(update.composer_settings.fast_mode);
            }
            update => panic!("expected Section settings update, got {update:?}"),
        }
        let section_id = stored.section_id.as_deref().unwrap();
        let section = state
            .task_store
            .read(|tables| tables.managed_sections())
            .unwrap()
            .into_iter()
            .find(|section| section.section_id == section_id)
            .unwrap();
        assert_eq!(
            section.last_composer_settings,
            Some(crate::task_store::ComposerSettings {
                model: Some("gpt-5.6-sol".to_string()),
                reasoning_effort: Some("xhigh".to_string()),
                fast_mode: true,
            })
        );
        assert_eq!(state.task_list_events.refresh_count(), 0);
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
    async fn task_prompt_continues_the_same_thread_after_a_ready_branch_switch_without_writes() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-managed-follow-up";
        let managed_cwd = root.path().join("managed/worktree-1");
        initialize_git_repository(root.path());
        let checkout =
            crate::git::create_attached_worktree(root.path(), &managed_cwd, "caffold/review", None)
                .unwrap();
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok("model/list", current_model_list_response()),
            crate::agent::codex::MockCodexResponse::ok(
                "turn/start",
                json!({
                    "turn": {
                        "id": "turn-managed-follow-up",
                        "items": [],
                        "status": "inProgress"
                    }
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
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
                state: ManagedWorktreeState::Ready,
                checkout_anchor: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .unwrap();
        let stored_before = state.task_store.worktree("worktree-1").unwrap().unwrap();
        let switched = std::process::Command::new("git")
            .arg("-C")
            .arg(&managed_cwd)
            .args(["switch", "-c", "review/next"])
            .output()
            .unwrap();
        assert!(
            switched.status.success(),
            "{}",
            String::from_utf8_lossy(&switched.stderr)
        );

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
                .task_sessions
                .snapshot(thread_id)
                .await
                .unwrap()
                .conversation
                .unwrap()
                .cwd,
            managed_cwd.display().to_string()
        );

        let syncing = state.task_sessions.begin_external_sync(thread_id).await;
        state
            .task_sessions
            .apply_external_read_sync(
                thread_id,
                syncing.revision,
                crate::agent::Conversation::from(&decoded_thread(json!({
                    "id": thread_id,
                    "preview": "Managed follow-up",
                    "status": { "type": "active", "activeFlags": [] },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                }))),
                crate::agent::TurnPage::from(&decoded_page(json!({
                    "data": [{
                        "id": "turn-managed-follow-up",
                        "items": [],
                        "status": "inProgress"
                    }],
                    "nextCursor": null,
                    "backwardsCursor": null
                }))),
            )
            .await;
        let snapshot = state.task_sessions.snapshot(thread_id).await.unwrap();
        assert_eq!(
            snapshot.conversation.unwrap().cwd,
            root.path().display().to_string()
        );
        assert_eq!(
            snapshot.active_turn_cwd.as_deref(),
            Some(managed_cwd.to_str().unwrap())
        );

        let response = task_prompt(
            State(state.clone()),
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
        assert_eq!(
            state.task_store.worktree("worktree-1").unwrap().unwrap(),
            stored_before
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
                state: ManagedWorktreeState::Ready,
                checkout_anchor: None,
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
                state: ManagedWorktreeState::RecoveryRequired,
                checkout_anchor: Some(CheckoutAnchor {
                    branch_name: "caffold/recovery".to_string(),
                    head_sha: "deadbeef".to_string(),
                }),
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
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
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
                "cwd": root.path().display().to_string(),
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
                state: ManagedWorktreeState::Ready,
                checkout_anchor: None,
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
    async fn task_prompt_steers_a_managed_turn_after_server_restart_with_stale_thread_cwd() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-restarted-managed-turn";
        let turn_id = "turn-after-isolation";
        let managed_cwd = root.path().join("managed/worktree-1");
        initialize_git_repository(root.path());
        let checkout =
            crate::git::create_attached_worktree(root.path(), &managed_cwd, "caffold/review", None)
                .unwrap();
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "Managed turn survived a server restart",
                        "status": { "type": "active", "activeFlags": [] },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 3.0,
                        "turns": []
                    },
                    "cwd": managed_cwd.display().to_string(),
                    "initialTurnsPage": {
                        "data": [{
                            "id": turn_id,
                            "items": [],
                            "status": "inProgress",
                            "startedAt": 3.0
                        }],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok("turn/steer", json!({ "turnId": turn_id })),
        ]);
        // A fresh TaskState models the empty in-memory session state after the
        // Caffold server restarts. The canonical thread cwd remains the source
        // checkout even though this active turn started in the managed worktree.
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
                state: ManagedWorktreeState::Ready,
                checkout_anchor: None,
                created_at_ms: 2_000,
                updated_at_ms: 2_000,
            })
            .unwrap();

        let response = task_prompt(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
            Json(TaskPromptRequest {
                prompt: "Steer the managed turn after restart".to_string(),
                images: Vec::new(),
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: None,
                active_turn_id: Some(turn_id.to_string()),
            }),
        )
        .await
        .expect("post-restart managed turn remains steerable");

        assert!(response.0.steered);
        let snapshot = state.task_sessions.snapshot(thread_id).await.unwrap();
        assert_eq!(snapshot.active_turn_id.as_deref(), Some(turn_id));
        assert_eq!(
            snapshot.active_turn_cwd.as_deref(),
            Some(managed_cwd.to_str().unwrap()),
            "restart recovery uses the app-server runtime cwd instead of stale thread metadata"
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            ["thread/resume", "turn/steer"]
        );
    }

    #[tokio::test]
    async fn task_prompt_recovers_a_system_error_thread_with_a_new_turn() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-system-error-recovery";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
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
                    "cwd": root.path().display().to_string(),
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
            crate::agent::codex::MockCodexResponse::ok(
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
                .task_sessions
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
                "cwd": root.path().display().to_string(),
                "initialTurnsPage": {
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            })
        };
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok("thread/resume", resume("notLoaded")),
            crate::agent::codex::MockCodexResponse::ok("thread/resume", resume("idle")),
            crate::agent::codex::MockCodexResponse::ok(
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
    async fn task_prompt_dates_the_accepted_message_before_waiting_for_the_agent() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-prompt-observed-position";
        let turn_id = "turn-active";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "Prompt observation position",
                        "status": { "type": "active", "activeFlags": [] },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": [{
                            "id": turn_id,
                            "items": [],
                            "status": "inProgress"
                        }]
                    },
                    "cwd": root.path().display().to_string()
                }),
            ),
            crate::agent::codex::MockCodexResponse::delayed_ok(
                "turn/steer",
                json!({ "turnId": turn_id }),
                std::time::Duration::from_millis(50),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(
            &state,
            thread_id,
            "Prompt observation position",
            1,
            "section-prompt-observed",
            "",
        );

        let prompt = tokio::spawn(task_prompt(
            State(state.clone()),
            AxumPath(thread_id.to_string()),
            Query(TasksQuery { cursor: None }),
            Json(TaskPromptRequest {
                prompt: "Keep the user before the answer".to_string(),
                images: Vec::new(),
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: None,
                active_turn_id: Some(turn_id.to_string()),
            }),
        ));
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if client
                    .mock_requests()
                    .await
                    .iter()
                    .any(|(method, _)| method == "turn/steer")
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the agent begins accepting the prompt");
        let while_agent_is_accepting_ms = crate::app::tasks::events::now_ms();

        let response = prompt
            .await
            .expect("prompt request task finishes")
            .expect("prompt request succeeds");
        let accepted = state
            .task_events
            .for_thread(thread_id)
            .into_iter()
            .find(|event| {
                event
                    .payload
                    .as_ref()
                    .and_then(|payload| payload["itemId"].as_str())
                    == Some(response.0.user_message_id.as_str())
            })
            .expect("accepted user message is published");

        assert!(
            accepted.position.anchor_ms <= while_agent_is_accepting_ms,
            "the accepted projection must keep when Caffold observed the submission, not when the agent eventually answered"
        );
    }

    #[tokio::test]
    async fn task_prompt_keeps_accepted_steer_visible_before_canonical_sync() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-running-prompt-reload";
        let turn_id = "turn-active";
        let prompt = "Keep this accepted steer visible after reload";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
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
                    },
                    "cwd": root.path().display().to_string()
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok("turn/steer", json!({ "turnId": turn_id })),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(
            &state,
            thread_id,
            "Running prompt settings",
            1,
            "section-running-prompt",
            "",
        );
        task_store_update_composer_settings(
            &state,
            thread_id,
            Some("gpt-before-steer"),
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
                prompt: prompt.to_string(),
                images: Vec::new(),
                model: Some("gpt-not-applied-by-steer".to_string()),
                effort: Some("xhigh".to_string()),
                fast_mode: true,
                permission_mode: None,
                active_turn_id: Some(turn_id.to_string()),
            }),
        )
        .await
        .expect("steering prompt succeeds");

        assert!(response.0.steered);
        let requested_user_message_id = client.mock_requests().await[1].1["clientUserMessageId"]
            .as_str()
            .expect("the adapter identifies the submitted user message")
            .to_string();
        assert_eq!(response.0.user_message_id, requested_user_message_id);
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
                && event
                    .payload
                    .as_ref()
                    .and_then(|payload| payload["itemId"].as_str())
                    == Some(requested_user_message_id.as_str())
        }));
        let stored = task_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(stored.model.as_deref(), Some("gpt-before-steer"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("medium"));
        assert!(!stored.fast_mode);
        let section_id = stored.section_id.as_deref().unwrap();
        let section = state
            .task_store
            .read(|tables| tables.managed_sections())
            .unwrap()
            .into_iter()
            .find(|section| section.section_id == section_id)
            .unwrap();
        assert_eq!(
            section.last_composer_settings,
            Some(crate::task_store::ComposerSettings {
                model: Some("gpt-before-steer".to_string()),
                reasoning_effort: Some("medium".to_string()),
                fast_mode: false,
            })
        );
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
            crate::agent::codex::MockCodexResponse::ok(
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
                    "cwd": root.path().display().to_string(),
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
            crate::agent::codex::MockCodexResponse::error(
                "turn/steer",
                crate::agent::codex::CodexThreadError::TurnUnavailable(
                    "no active turn to steer".to_string(),
                ),
            ),
            crate::agent::codex::MockCodexResponse::ok(
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
                    "cwd": root.path().display().to_string(),
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
            crate::agent::codex::MockCodexResponse::ok(
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
}

#[cfg(test)]
mod state_tests {
    use std::{path::PathBuf, sync::Arc};

    use tokio::sync::broadcast;

    use super::*;
    use crate::{app::tasks::TaskState, fs::RootedFs, task_store::TaskStore};

    #[test]
    fn task_state_preserves_the_configured_default_cwd() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let (shutdown, _) = broadcast::channel(1);
        let (claude, _runner) = crate::agent::claude::ClaudeClient::mock();
        let state = TaskState::new(
            Arc::new(RootedFs::new(root.path()).unwrap()),
            "project".to_string(),
            shutdown,
            TaskStore::memory().unwrap(),
            root.path().join("managed-worktrees"),
            claude,
        )
        .expect("task state");

        assert_eq!(
            PathBuf::from(task_cwd(&state, None).unwrap()),
            project.canonicalize().unwrap()
        );
    }
}
