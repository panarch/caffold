use std::{sync::Arc, time::Duration};

use axum::http::StatusCode;
use serde_json::{Value as JsonValue, json};
use tokio::sync::broadcast;

use super::{routes::*, *};
use crate::{
    app::error::ApiError,
    codex_app_server::{CodexPermissionMode, CodexThreadClient},
    codex_thread_sessions::CodexThreadSessions,
    fs::RootedFs,
    task_store::TaskStore,
};

mod detail;
mod projection;
pub(super) mod support;
mod sync;

fn startup_test_state(state: TaskStoreReadinessState) -> StartupTaskState {
    StartupTaskState {
        status: Arc::new(tokio::sync::RwLock::new(StartupTaskStatus {
            codex: pending_codex_status(),
            task_store: TaskStoreReadiness {
                state,
                blocks_task_operations: true,
                diagnostic_message: "startup test state".to_string(),
            },
            error_code: "startup_test",
        })),
        retry: Arc::new(tokio::sync::Notify::new()),
    }
}

#[tokio::test]
async fn startup_status_get_is_observational_and_does_not_retry_migration() {
    let state = startup_test_state(TaskStoreReadinessState::WaitingForCodex);

    let response = startup_codex_status(axum::extract::State(state.clone())).await;

    assert!(matches!(
        response.0.task_store_readiness.state,
        TaskStoreReadinessState::WaitingForCodex
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(10), state.retry.notified())
            .await
            .is_err(),
        "status GET must not schedule a migration retry"
    );
}

#[tokio::test]
async fn explicit_startup_retry_immediately_reports_migrating_and_notifies_the_owner() {
    let state = startup_test_state(TaskStoreReadinessState::Failed);

    let (status, _) = retry_startup_migration(axum::extract::State(state.clone())).await;

    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(matches!(
        state.status.read().await.task_store.state,
        TaskStoreReadinessState::Migrating
    ));
    tokio::time::timeout(Duration::from_millis(10), state.retry.notified())
        .await
        .expect("explicit retry notifies the startup coordinator");
}

#[tokio::test]
async fn task_router_gateway_can_activate_the_current_task_router_without_restart() {
    use axum::{body::Body, http::Request, routing::get};
    use tower::ServiceExt;

    let state = startup_test_state(TaskStoreReadinessState::WaitingForCodex);
    let startup = Router::new()
        .fallback(any(startup_task_blocked))
        .with_state(state);
    let gateway = TaskRouterGateway {
        router: Arc::new(tokio::sync::RwLock::new(startup)),
    };
    let shell = gateway.router();

    let blocked = shell
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(blocked.status(), StatusCode::SERVICE_UNAVAILABLE);

    gateway
        .replace(Router::new().route("/api/tasks", get(|| async { StatusCode::OK })))
        .await;
    let ready = shell
        .oneshot(
            Request::builder()
                .uri("/api/tasks")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ready.status(), StatusCode::OK);
}
