use crate::agent;
use crate::app::error::ApiError;
use crate::app::tasks::TaskState;
use axum::Json;
use axum::extract::State;

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
/// The runner is stopped — ending every session it holds, the way an
/// application update ends them — and a fresh one is started running whatever
/// binary is installed now. Conversations resume from their files as their
/// Tasks are opened. Nothing calls this on the backend's own behalf: quitting
/// is covered by the runner's idle timeout, and this route exists for the one
/// case only a person can mean — put the Claude runtime down and up again.
pub(super) async fn claude_restart(
    State(state): State<TaskState>,
) -> Result<Json<caffold_claude_runner::protocol::DaemonStatus>, ApiError> {
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
}
