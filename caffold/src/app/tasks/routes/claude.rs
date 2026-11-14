use crate::agent;
use crate::agent::claude::{ConfigDirRefusal, ConfigDirSaveError};
use crate::app::error::ApiError;
use crate::app::tasks::TaskState;
use axum::Json;
use axum::extract::State;
use serde::{Deserialize, Serialize};

/// The config directory new Claude Tasks run under, and where an empty one
/// leads.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaudeSettingsResponse {
    config_dir: Option<String>,
    default_config_dir: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UpdateClaudeSettingsRequest {
    config_dir: Option<String>,
}

pub(super) async fn claude_settings(
    State(state): State<TaskState>,
) -> Result<Json<ClaudeSettingsResponse>, ApiError> {
    let claude = state.task_runtime.claude();
    let config_dir = claude.config_dir().map_err(|error| ApiError::Unavailable {
        code: "claude_settings_unreadable",
        message: error.to_string(),
    })?;
    Ok(Json(ClaudeSettingsResponse {
        config_dir,
        default_config_dir: claude.default_config_dir(),
    }))
}

/// Make the typed directory the one new Claude Tasks run under, once Claude
/// shows it is signed in there. Empty, or the default however it is spelled,
/// is the default. A refused directory leaves the setting as it was.
pub(super) async fn update_claude_settings(
    State(state): State<TaskState>,
    Json(request): Json<UpdateClaudeSettingsRequest>,
) -> Result<Json<ClaudeSettingsResponse>, ApiError> {
    let claude = state.task_runtime.claude();
    let config_dir = claude
        .save_config_dir(request.config_dir.as_deref().unwrap_or_default())
        .await
        .map_err(config_dir_error)?;
    Ok(Json(ClaudeSettingsResponse {
        config_dir,
        default_config_dir: claude.default_config_dir(),
    }))
}

fn config_dir_error(error: ConfigDirSaveError) -> ApiError {
    match error {
        ConfigDirSaveError::Refused(
            refusal @ (ConfigDirRefusal::NotAbsolute | ConfigDirRefusal::Missing),
        ) => ApiError::BadRequest {
            code: "invalid_claude_config_dir",
            message: refusal.to_string(),
        },
        ConfigDirSaveError::Refused(
            refusal @ (ConfigDirRefusal::SignedOut(_) | ConfigDirRefusal::Unchecked(_)),
        ) => ApiError::BadRequest {
            code: "claude_config_dir_signed_out",
            message: refusal.to_string(),
        },
        ConfigDirSaveError::Unsaved(_) => ApiError::Internal(error.to_string()),
    }
}

/// What the Claude installation is right now, for showing in Settings.
///
/// Four blocks — the binary, the account, the plan's usage windows, the
/// runner — each from its own source and each allowed to be missing, with
/// why under `problems`. Always 200: the report is the answer, and a source
/// that could not answer is part of it. Nothing reads this to decide whether
/// anything is allowed; a broken installation still says what is wrong at
/// the moment a turn tries it.
pub(super) async fn claude_status(
    State(state): State<TaskState>,
) -> Json<agent::claude::status::ClaudeStatus> {
    Json(state.task_runtime.claude().introspect().await)
}

/// Restart the Claude runtime, on a person's explicit say-so.
///
/// The runner is stopped, ending every session it holds, and a fresh one
/// is started running whatever
/// binary is installed now. Conversations resume from their files as their
/// Tasks are opened. Nothing calls this on the backend's own behalf: quitting
/// is covered by the runner's idle timeout, and this route exists for the one
/// case only a person can mean — put the Claude runtime down and up again.
pub(super) async fn claude_restart(
    State(state): State<TaskState>,
) -> Result<Json<caffold_runner::protocol::DaemonStatus>, ApiError> {
    state
        .task_runtime
        .claude()
        .restart_runtime()
        .await
        .map(Json)
        // In the runtime's own name: nothing about this failure is Codex's.
        .map_err(|error| ApiError::Unavailable {
            code: "claude_runtime_unavailable",
            message: error.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use crate::agent::codex::CodexThreadClient;
    use crate::app::tasks::routes::router;
    use tower::ServiceExt;

    use crate::{app::tasks::test_support::*, fs::RootedFs};

    #[tokio::test]
    async fn the_status_answers_every_block_in_one_report() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let router = router(state);

        let response = router
            .oneshot(
                axum::http::Request::get("/api/claude/status")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(status["executable"]["version"], "0.0.0 (stand-in)");
        assert_eq!(status["auth"]["loggedIn"], true);
        assert_eq!(status["usage"]["windows"][0]["kind"], "session");
        assert_eq!(status["runner"]["running"], true, "{status}");
    }

    #[tokio::test]
    async fn restarting_answers_with_the_replacement_runner() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let router = router(state);

        let response = router
            .oneshot(
                axum::http::Request::post("/api/claude/restart")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            status["sessions"], 0,
            "the runner that answers holds nothing: {status}"
        );
    }

    #[test]
    fn a_folder_claude_cannot_vouch_for_is_refused_and_a_failed_save_is_the_servers() {
        use super::{ConfigDirRefusal, ConfigDirSaveError, config_dir_error};
        use crate::app::error::ApiError;

        for refusal in [
            ConfigDirRefusal::SignedOut("/Volumes/work/.claude".to_string()),
            ConfigDirRefusal::Unchecked("could not run claude".to_string()),
        ] {
            let message = refusal.to_string();
            assert!(matches!(
                config_dir_error(ConfigDirSaveError::Refused(refusal)),
                ApiError::BadRequest {
                    code: "claude_config_dir_signed_out",
                    message: answered,
                } if answered == message
            ));
        }
        assert!(matches!(
            config_dir_error(ConfigDirSaveError::Unsaved(std::io::Error::other("disk full"))),
            ApiError::Internal(message) if message == "Couldn't save the setting: disk full"
        ));
    }

    async fn settings_call(
        router: &axum::Router,
        request: axum::http::Request<axum::body::Body>,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024)
            .await
            .unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    fn save(config_dir: serde_json::Value) -> axum::http::Request<axum::body::Body> {
        axum::http::Request::patch("/api/claude/settings")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(
                serde_json::json!({ "configDir": config_dir }).to_string(),
            ))
            .unwrap()
    }

    #[tokio::test]
    async fn the_default_config_dir_needs_no_sign_in_check_and_a_refused_one_changes_nothing() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let router = router(state);
        let default = format!("{}/.claude", std::env::var("HOME").unwrap());

        let (status, read) = settings_call(
            &router,
            axum::http::Request::get("/api/claude/settings")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(
            read,
            serde_json::json!({ "configDir": null, "defaultConfigDir": default })
        );

        for typed in [
            serde_json::json!(null),
            serde_json::json!("  "),
            serde_json::json!("~/.claude/"),
        ] {
            let (status, saved) = settings_call(&router, save(typed.clone())).await;
            assert_eq!(status, axum::http::StatusCode::OK, "{typed}");
            assert_eq!(saved["configDir"], serde_json::Value::Null, "{typed}");
        }

        let (status, refused) =
            settings_call(&router, save(serde_json::json!(".claude-work"))).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(refused["error"]["code"], "invalid_claude_config_dir");
        assert_eq!(refused["error"]["message"], "Enter an absolute path.");

        let missing = root.path().join("missing").display().to_string();
        let (status, refused) = settings_call(&router, save(serde_json::json!(missing))).await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(refused["error"]["code"], "invalid_claude_config_dir");
        assert_eq!(refused["error"]["message"], "This folder does not exist.");

        let (_, read) = settings_call(
            &router,
            axum::http::Request::get("/api/claude/settings")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(read["configDir"], serde_json::Value::Null);
    }
}
