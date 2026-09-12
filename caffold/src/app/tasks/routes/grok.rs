use axum::Json;
use axum::extract::State;

use crate::agent::grok::GrokStatus;
use crate::app::tasks::TaskState;

/// What the Grok installation is right now, for showing in Settings.
///
/// Four blocks — the executable, the leader, Caffold's bridge, the account —
/// each from its own source and each allowed to be missing, with why under
/// `problems`. Always 200: the report is the answer, and a source that could
/// not answer is part of it. Nothing reads this to decide whether anything is
/// allowed, and asking starts no leader, session, or turn.
pub(super) async fn grok_status(State(state): State<TaskState>) -> Json<GrokStatus> {
    Json(state.task_runtime.grok().introspect().await)
}

#[cfg(test)]
mod tests {
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use crate::agent::codex::CodexThreadClient;
    use crate::app::tasks::routes::router;
    use crate::app::tasks::test_support::task_state_with_grok;
    use crate::fs::RootedFs;

    #[tokio::test]
    async fn the_status_answers_every_block_in_one_report() {
        let root = tempfile::tempdir().unwrap();
        let (state, _leader, _memory, _host) = task_state_with_grok(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        let response = router(state)
            .oneshot(
                Request::get("/api/grok/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let status: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            status["executable"]["version"],
            "grok 0.0.0 (stand-in) [stable]"
        );
        assert_eq!(status["leader"]["running"], true);
        assert_eq!(status["connection"]["state"], "ready");
        assert_eq!(status["connection"]["authMethods"][1], "Grok");
        assert_eq!(status["auth"]["verified"]["authenticated"], true);
        assert_eq!(status["auth"]["cachedSignIn"], true);
        assert!(status.get("problems").is_none(), "{status}");
    }
}
