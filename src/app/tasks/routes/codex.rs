use super::*;

pub(super) async fn codex_status(State(state): State<TaskState>) -> Json<CodexStatusPayload> {
    let (status, process_generation, process_connected) =
        state.codex_runtime.status_with_diagnostics().await;
    let diagnostics = CodexRuntimeDiagnostics {
        process_generation,
        process_connected,
        thread_sessions: state.codex_sessions.diagnostics().await,
        usage: state.codex_runtime.usage_diagnostics(),
    };
    Json(CodexStatusPayload {
        status,
        diagnostics,
    })
}

pub(super) async fn codex_restart(
    State(state): State<TaskState>,
) -> Result<Json<CodexDaemonInfo>, ApiError> {
    state
        .codex_runtime
        .restart_daemon()
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) async fn codex_models(
    State(state): State<TaskState>,
) -> Result<Json<JsonValue>, ApiError> {
    let client = require_codex_thread_client(&state).await?;
    let response = client.list_models(100).await.map_err(ApiError::from)?;
    serde_json::to_value(response)
        .map(Json)
        .map_err(|error| ApiError::CodexThread(error.to_string()))
}

pub(super) async fn codex_permissions(
    State(state): State<TaskState>,
    Query(query): Query<CodexPermissionsQuery>,
) -> Result<Json<CodexPermissionsResponse>, ApiError> {
    let cwd = task_cwd(&state, query.cwd.as_deref())?;
    let client = require_codex_thread_client(&state).await?;
    let (profiles, default_mode) = tokio::try_join!(
        client.list_permission_profiles(&cwd, 100),
        client.default_permission_mode(&cwd),
    )?;
    let profile_allowed = |profile_id: &str| {
        profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .is_some_and(|profile| profile.allowed)
    };
    let workspace_allowed = profile_allowed(":workspace");
    let full_access_allowed = profile_allowed(":danger-full-access");

    Ok(Json(CodexPermissionsResponse {
        default_mode,
        options: vec![
            CodexPermissionOption {
                mode: CodexPermissionMode::AskForApproval,
                label: "Ask for approval",
                description: "Work in the workspace and ask before crossing its boundary.",
                allowed: workspace_allowed,
                dangerous: false,
            },
            CodexPermissionOption {
                mode: CodexPermissionMode::ApproveForMe,
                label: "Approve for me",
                description: "Keep the workspace boundary and review eligible requests automatically.",
                allowed: workspace_allowed,
                dangerous: false,
            },
            CodexPermissionOption {
                mode: CodexPermissionMode::FullAccess,
                label: "Full access",
                description: "Run without sandbox restrictions or approval prompts.",
                allowed: full_access_allowed,
                dangerous: true,
            },
        ],
    }))
}

pub(super) fn codex_reasoning_effort_value(effort: &JsonValue) -> Option<&str> {
    effort
        .get("value")
        .and_then(JsonValue::as_str)
        .or_else(|| effort.get("reasoningEffort").and_then(JsonValue::as_str))
        .or_else(|| effort.as_str())
}

pub(super) async fn codex_turn_options(
    client: &CodexThreadClient,
    model: Option<String>,
    effort: Option<String>,
    fast_mode: bool,
    permission_mode: Option<CodexPermissionMode>,
) -> Result<CodexTurnOptions, ApiError> {
    let model = normalize_codex_model(model)?;
    let effort = normalize_codex_effort(effort)?;
    if model.is_none() && effort.is_none() && !fast_mode {
        return Ok(CodexTurnOptions {
            model,
            effort,
            service_tier: Some(NORMAL_SERVICE_TIER_ID.to_string()),
            permission_mode,
        });
    }

    let models = client.list_models(100).await.map_err(ApiError::from)?.data;
    let selected_model = match model.as_deref() {
        Some(requested) => models
            .iter()
            .find(|candidate| candidate.model == requested || candidate.id == requested),
        None => models
            .iter()
            .find(|candidate| candidate.is_default)
            .or_else(|| models.first()),
    };

    let Some(selected_model) = selected_model else {
        let (code, message) = if model.is_some() {
            ("invalid_codex_model", "Codex model value is not supported")
        } else {
            (
                "invalid_codex_effort",
                "Codex reasoning effort is not supported",
            )
        };
        return Err(ApiError::BadRequest {
            code,
            message: message.to_string(),
        });
    };

    if effort.as_deref().is_some_and(|requested| {
        !selected_model
            .supported_reasoning_efforts
            .iter()
            .filter_map(codex_reasoning_effort_value)
            .any(|supported| supported == requested)
    }) {
        return Err(ApiError::BadRequest {
            code: "invalid_codex_effort",
            message: "Codex reasoning effort is not supported".to_string(),
        });
    }

    let normal_service_tier = selected_model
        .default_service_tier
        .clone()
        .unwrap_or_else(|| NORMAL_SERVICE_TIER_ID.to_string());
    let service_tier = Some(
        fast_mode
            .then(|| selected_model.fast_service_tier_id().map(str::to_string))
            .flatten()
            .unwrap_or(normal_service_tier),
    );

    Ok(CodexTurnOptions {
        model,
        effort,
        service_tier,
        permission_mode,
    })
}

pub(super) fn normalize_codex_model(model: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(model) = model else {
        return Ok(None);
    };
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    if model.len() > 128 || model.chars().any(char::is_control) {
        return Err(ApiError::BadRequest {
            code: "invalid_codex_model",
            message: "Codex model value is not supported".to_string(),
        });
    }
    Ok(Some(model.to_string()))
}

pub(super) fn normalize_codex_effort(effort: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(effort) = effort else {
        return Ok(None);
    };
    let effort = effort.trim();
    if effort.is_empty() {
        return Ok(None);
    }
    if effort.len() > 32 || effort.chars().any(char::is_control) {
        return Err(ApiError::BadRequest {
            code: "invalid_codex_effort",
            message: "Codex reasoning effort is not supported".to_string(),
        });
    }
    Ok(Some(effort.to_string()))
}

pub(super) fn normalize_approval_resolution(
    decision: String,
    scope: Option<String>,
) -> Result<ApprovalResolution, ApiError> {
    match decision.as_str() {
        "accept" | "acceptForSession" | "decline" | "cancel" if scope.is_none() => {
            Ok(ApprovalResolution::Standard(decision))
        }
        "allow" => {
            let scope = match scope.as_deref() {
                Some("turn") => PermissionGrantScope::Turn,
                Some("session") => PermissionGrantScope::Session,
                _ => return Err(invalid_approval_scope_error()),
            };
            Ok(ApprovalResolution::Permissions {
                granted: true,
                scope,
            })
        }
        "deny" if scope.is_none() => Ok(ApprovalResolution::Permissions {
            granted: false,
            scope: PermissionGrantScope::Turn,
        }),
        "accept" | "acceptForSession" | "decline" | "cancel" | "deny" => {
            Err(invalid_approval_scope_error())
        }
        _ => Err(ApiError::BadRequest {
            code: "invalid_approval_decision",
            message: "approval decision is not supported".to_string(),
        }),
    }
}

fn invalid_approval_scope_error() -> ApiError {
    ApiError::BadRequest {
        code: "invalid_approval_scope",
        message: "approval scope is not supported for this decision".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::test_support::*;
    use super::*;
    use crate::{app::tasks::test_support::*, fs::RootedFs};

    #[test]
    fn approval_resolution_requires_the_scope_owned_by_each_decision_kind() {
        assert_eq!(
            normalize_approval_resolution("accept".to_string(), None).unwrap(),
            ApprovalResolution::Standard("accept".to_string())
        );
        assert_eq!(
            normalize_approval_resolution("allow".to_string(), Some("session".to_string()))
                .unwrap(),
            ApprovalResolution::Permissions {
                granted: true,
                scope: PermissionGrantScope::Session,
            }
        );
        assert_eq!(
            normalize_approval_resolution("deny".to_string(), None).unwrap(),
            ApprovalResolution::Permissions {
                granted: false,
                scope: PermissionGrantScope::Turn,
            }
        );
        assert!(matches!(
            normalize_approval_resolution("allow".to_string(), None),
            Err(ApiError::BadRequest {
                code: "invalid_approval_scope",
                ..
            })
        ));
        assert!(matches!(
            normalize_approval_resolution("deny".to_string(), Some("turn".to_string())),
            Err(ApiError::BadRequest {
                code: "invalid_approval_scope",
                ..
            })
        ));
        assert!(matches!(
            normalize_approval_resolution("future-decision".to_string(), None),
            Err(ApiError::BadRequest {
                code: "invalid_approval_decision",
                ..
            })
        ));
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
    async fn codex_turn_options_accepts_server_reported_reasoning_efforts() {
        let client = CodexThreadClient::mock(vec![
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
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
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
            crate::codex_app_server::MockCodexResponse::ok(
                "model/list",
                current_model_list_response(),
            ),
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
}
