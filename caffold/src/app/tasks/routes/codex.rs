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
) -> Result<Json<PermissionModes>, ApiError> {
    let cwd = task_cwd(&state, query.cwd.as_deref())?;
    let client = require_codex_thread_client(&state).await?;
    client
        .driver()
        .permission_modes(&cwd)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

pub(super) fn normalize_approval_decision(decision: &str) -> Result<ApprovalDecision, ApiError> {
    match decision {
        "allow" => Ok(ApprovalDecision::Allow),
        "allowAlways" => Ok(ApprovalDecision::AllowAlways),
        "deny" => Ok(ApprovalDecision::Deny),
        "denyAndStop" => Ok(ApprovalDecision::DenyAndStop),
        _ => Err(ApiError::BadRequest {
            code: "invalid_approval_decision",
            message: "approval decision is not supported".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::{app::tasks::test_support::*, fs::RootedFs};

    #[test]
    fn the_browser_answers_with_one_of_caffolds_four_decisions() {
        let decisions = [
            ("allow", ApprovalDecision::Allow),
            ("allowAlways", ApprovalDecision::AllowAlways),
            ("deny", ApprovalDecision::Deny),
            ("denyAndStop", ApprovalDecision::DenyAndStop),
        ];

        for (sent, expected) in decisions {
            assert_eq!(normalize_approval_decision(sent).unwrap(), expected);
        }
    }

    #[test]
    fn a_decision_caffold_does_not_offer_is_refused() {
        // A card from an older page, or an agent's own vocabulary leaking
        // through, is a bad request rather than something to guess at.
        for sent in ["accept", "acceptForSession", "decline", "cancel", ""] {
            assert!(matches!(
                normalize_approval_decision(sent),
                Err(ApiError::BadRequest {
                    code: "invalid_approval_decision",
                    ..
                })
            ));
        }
    }

    #[tokio::test]
    async fn codex_models_preserves_app_server_reasoning_efforts() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
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
            crate::agent::codex::MockCodexResponse::ok(
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
            crate::agent::codex::MockCodexResponse::ok(
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

        assert_eq!(response.default_mode, "approveForMe");
        // Two choices share the workspace profile and differ by who reviews, so
        // the third is the only one a forbidden profile can withhold.
        assert_eq!(
            response
                .options
                .iter()
                .map(|option| (option.mode.as_str(), option.allowed, option.dangerous))
                .collect::<Vec<_>>(),
            vec![
                ("askForApproval", true, false),
                ("approveForMe", true, false),
                ("fullAccess", false, true),
            ]
        );
        assert!(
            response
                .options
                .iter()
                .all(|option| !option.label.is_empty() && !option.description.is_empty()),
            "a mode reaches the interface already named"
        );
    }
}
