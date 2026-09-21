use super::commands::{require_codex_thread_client, task_cwd};
use crate::agent::PermissionModes;
use crate::agent::driver::reviewed_permission_option;
use crate::app::error::ApiError;
use crate::app::tasks::TaskState;
use axum::Json;
use axum::extract::{Query, State};
use serde::{Deserialize, Serialize};

use crate::agent::driver::ModelOption;
use crate::task_store::TaskProvider;

/// One model, and which agent offers it.
///
/// Choosing a model is how a person chooses an agent, so the answer says which
/// agent each one belongs to and the choice is carried back on creation rather
/// than guessed at from the model's name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentModel {
    provider: &'static str,
    #[serde(flatten)]
    model: ModelOption,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentModelsPayload {
    models: Vec<AgentModel>,
    /// An agent that could not be asked, and why. The models that were
    /// answered are still offered: one agent being unready is not a reason to
    /// hide the other.
    unavailable: Vec<UnavailableAgent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UnavailableAgent {
    provider: &'static str,
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AgentPermissionsQuery {
    cwd: Option<String>,
    provider: Option<String>,
    /// The model chosen, when one has been. One agent's modes depend on it.
    model: Option<String>,
}

pub(super) async fn agent_models(
    State(state): State<TaskState>,
) -> Result<Json<AgentModelsPayload>, ApiError> {
    let mut models = Vec::new();
    let mut unavailable = Vec::new();

    match state.detail.connection().await {
        Ok(connection) => match connection.driver().models().await {
            Ok(offered) => extend(&mut models, TaskProvider::Codex, offered),
            Err(error) => unavailable.push(UnavailableAgent {
                provider: TaskProvider::Codex.as_str(),
                message: error.to_string(),
            }),
        },
        Err(error) => unavailable.push(UnavailableAgent {
            provider: TaskProvider::Codex.as_str(),
            message: error.to_string(),
        }),
    }

    match state.task_runtime.claude().models().await {
        Ok(offered) => extend(&mut models, TaskProvider::Claude, offered),
        Err(error) => unavailable.push(UnavailableAgent {
            provider: TaskProvider::Claude.as_str(),
            message: error.to_string(),
        }),
    }

    match state.task_runtime.grok().models().await {
        Ok(offered) => extend(&mut models, TaskProvider::Grok, offered),
        Err(error) => unavailable.push(UnavailableAgent {
            provider: TaskProvider::Grok.as_str(),
            message: error.to_string(),
        }),
    }

    if models.is_empty() {
        let message = unavailable
            .iter()
            .map(|agent| format!("{}: {}", agent.provider, agent.message))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(ApiError::Unavailable {
            code: "no_agent_available",
            message: if message.is_empty() {
                "No agent offered a model.".to_string()
            } else {
                message
            },
        });
    }
    Ok(Json(AgentModelsPayload {
        models,
        unavailable,
    }))
}

pub(super) async fn agent_permissions(
    State(state): State<TaskState>,
    Query(query): Query<AgentPermissionsQuery>,
) -> Result<Json<PermissionModes>, ApiError> {
    let cwd = task_cwd(&state, query.cwd.as_deref())?;
    let driver = match query.provider.as_deref().map(str::trim) {
        Some("claude") => state.task_runtime.claude().driver(&cwd),
        Some("grok") => state.task_runtime.grok().driver(),
        None | Some("") | Some("codex") => require_codex_thread_client(&state).await?.driver(),
        Some(_) => {
            return Err(ApiError::BadRequest {
                code: "unsupported_provider",
                message: "Caffold does not drive that agent.".to_string(),
            });
        }
    };
    let model = query
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty());
    let mut modes = driver
        .permission_modes(&cwd, model)
        .await
        .map_err(ApiError::from)?;
    offer_reviewed_mode(&mut modes, state.task_runtime.reviewer_available());
    Ok(Json(modes))
}

/// Add the one mode Caffold answers under to the list the agent answered.
///
/// It goes before the first mode that gives up a protection, because the modes
/// that keep one read together and the dangerous ones belong at the end of any
/// list. Where exactly it sits among the safe ones is not something the agent
/// can be asked, since it is not the agent's mode.
fn offer_reviewed_mode(modes: &mut PermissionModes, available: bool) {
    let at = modes
        .options
        .iter()
        .position(|option| option.dangerous)
        .unwrap_or(modes.options.len());
    modes
        .options
        .insert(at, reviewed_permission_option(available));
}

fn extend(models: &mut Vec<AgentModel>, provider: TaskProvider, offered: Vec<ModelOption>) {
    models.extend(offered.into_iter().map(|model| AgentModel {
        provider: provider.as_str(),
        model,
    }));
}

#[cfg(test)]
mod tests {
    use crate::agent::driver::{PermissionModeOption, REVIEWED_PERMISSION_MODE};

    fn mode(name: &str, dangerous: bool) -> PermissionModeOption {
        PermissionModeOption {
            mode: name.to_string(),
            label: name.to_string(),
            description: String::new(),
            allowed: true,
            unavailable_reason: None,
            dangerous,
        }
    }

    fn offered(options: Vec<PermissionModeOption>, available: bool) -> Vec<(String, bool)> {
        let mut modes = PermissionModes {
            default_mode: "default".to_string(),
            options,
            fixed_when_conversation_starts: false,
        };
        offer_reviewed_mode(&mut modes, available);
        modes
            .options
            .into_iter()
            .map(|option| (option.mode, option.allowed))
            .collect()
    }

    #[test]
    fn the_reviewed_mode_sits_with_the_modes_that_keep_a_protection() {
        assert_eq!(
            offered(
                vec![
                    mode("default", false),
                    mode("acceptEdits", false),
                    mode("bypassPermissions", true)
                ],
                true,
            ),
            vec![
                ("default".to_string(), true),
                ("acceptEdits".to_string(), true),
                (REVIEWED_PERMISSION_MODE.to_string(), true),
                ("bypassPermissions".to_string(), true),
            ]
        );
    }

    #[test]
    fn a_list_without_a_dangerous_mode_still_offers_it() {
        assert_eq!(
            offered(vec![mode("ask", false)], true),
            vec![
                ("ask".to_string(), true),
                (REVIEWED_PERMISSION_MODE.to_string(), true),
            ]
        );
    }

    #[test]
    fn nothing_configured_leaves_it_visible_but_withheld_with_a_reason() {
        let mut modes = PermissionModes {
            default_mode: "ask".to_string(),
            options: vec![mode("ask", false)],
            fixed_when_conversation_starts: false,
        };

        offer_reviewed_mode(&mut modes, false);

        let reviewed = modes
            .options
            .iter()
            .find(|option| option.mode == REVIEWED_PERMISSION_MODE)
            .expect("the mode is offered even with nothing configured");
        assert!(!reviewed.allowed);
        assert!(
            reviewed
                .unavailable_reason
                .as_deref()
                .is_some_and(|reason| reason.contains("Jev Permissions")),
            "{:?}",
            reviewed.unavailable_reason
        );
        assert!(!reviewed.dangerous);
    }

    use crate::agent::codex::CodexThreadClient;
    use crate::agent::codex::CodexThreadError;
    use crate::agent::codex::MockCodexResponse;
    use serde_json::json;

    use super::*;
    use crate::{
        app::tasks::routes::test_support::current_model_list_response, app::tasks::test_support::*,
        fs::RootedFs,
    };

    #[tokio::test]
    async fn a_model_arrives_saying_which_agent_offers_it() {
        // Choosing a model is how a person chooses an agent, so the answer has
        // to carry that and not leave the interface guessing from the name.
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "model/list",
            current_model_list_response(),
        )]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;

        let Json(payload) = agent_models(State(state)).await.unwrap();

        let codex = payload
            .models
            .iter()
            .filter(|offered| offered.provider == "codex")
            .collect::<Vec<_>>();
        assert_eq!(codex[0].model.model, "gpt-5.6-sol");
        assert_eq!(codex[0].model.display_name, "GPT-5.6-Sol");
        assert!(codex[0].model.is_default);
        assert!(codex[0].model.efforts.contains(&"xhigh".to_string()));
        assert_eq!(codex[0].model.default_effort.as_deref(), Some("low"));
        assert!(
            codex[0].model.supports_fast_mode,
            "a model with a fast tier says so once, in Caffold's words"
        );
    }

    #[tokio::test]
    async fn codex_answers_the_shared_permissions_route_with_its_own_profiles() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
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
            MockCodexResponse::ok(
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

        let Json(response) = agent_permissions(
            State(state),
            Query(AgentPermissionsQuery {
                cwd: None,
                provider: None,
                model: None,
            }),
        )
        .await
        .unwrap();

        assert_eq!(response.default_mode, "approveForMe");
        assert!(
            !response.fixed_when_conversation_starts,
            "this agent can still change the mode between turns"
        );
        // Three choices share the workspace profile and differ by who reviews —
        // a person, Codex, then Caffold — so full access is the only one a
        // forbidden profile can withhold. Nothing is configured for Caffold's
        // reviewer in this test, so its mode is offered and withheld.
        assert_eq!(
            response
                .options
                .iter()
                .map(|option| (option.mode.as_str(), option.allowed, option.dangerous))
                .collect::<Vec<_>>(),
            vec![
                ("askForApproval", true, false),
                ("approveForMe", true, false),
                (REVIEWED_PERMISSION_MODE, false, false),
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

    #[tokio::test]
    async fn one_agent_being_unready_does_not_hide_the_other() {
        // The interface should offer what can be offered. An agent that could
        // not be asked is named, so the reason is visible rather than absent.
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "model/list",
            CodexThreadError::ProcessUnavailable,
        )]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;

        let answer = agent_models(State(state)).await;

        // Claude is not installed in the test environment, so both are
        // unavailable and the request fails rather than answering an empty
        // list that would read as "no models exist".
        match answer {
            Err(ApiError::Unavailable { code, message }) => {
                assert_eq!(code, "no_agent_available");
                assert!(message.contains("codex"), "{message}");
            }
            Err(other) => panic!("unexpected failure: {other:?}"),
            Ok(Json(payload)) => {
                assert!(
                    payload.models.iter().all(|model| model.provider != "codex"),
                    "a Codex that could not be asked offers nothing"
                );
                assert!(
                    payload
                        .unavailable
                        .iter()
                        .any(|agent| agent.provider == "codex"),
                    "and says so"
                );
            }
        }
    }
}
