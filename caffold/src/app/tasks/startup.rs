use std::{
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

use axum::{
    Json, Router,
    body::Body,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use serde::Serialize;
use tokio::sync::{Notify, RwLock, broadcast};
use tower::ServiceExt;

use super::TasksApp;
use crate::{
    agent::codex::{
        CodexReadiness, CodexReadinessReason, CodexReadinessState, CodexStatusResponse,
        CodexThreadClient,
    },
    fs::RootedFs,
};

#[derive(Clone)]
struct TaskRouterGateway {
    router: Arc<RwLock<Router>>,
}

impl TaskRouterGateway {
    async fn replace(&self, router: Router) {
        *self.router.write().await = router;
    }

    async fn dispatch(&self, request: Request<Body>) -> Response {
        let router = self.router.read().await.clone();
        match router.oneshot(request).await {
            Ok(response) => response,
            Err(error) => match error {},
        }
    }

    fn router(&self) -> Router {
        let gateway = self.clone();
        Router::new().fallback(any(move |request| {
            let gateway = gateway.clone();
            async move { gateway.dispatch(request).await }
        }))
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum TaskStoreReadinessState {
    Migrating,
    WaitingForCodex,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskStoreReadiness {
    state: TaskStoreReadinessState,
    blocks_task_operations: bool,
    diagnostic_message: String,
}

#[derive(Clone)]
struct StartupTaskState {
    status: Arc<RwLock<StartupTaskStatus>>,
    retry: Arc<Notify>,
}

#[derive(Clone)]
struct StartupTaskStatus {
    codex: CodexStatusResponse,
    task_store: TaskStoreReadiness,
    error_code: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupStatusResponse {
    #[serde(flatten)]
    codex: CodexStatusResponse,
    task_store_readiness: TaskStoreReadiness,
}

pub(in crate::app) struct PersistentTasksGateway {
    router: Router,
    app: Arc<StdMutex<Option<TasksApp>>>,
    gateway: TaskRouterGateway,
    status: Arc<RwLock<StartupTaskStatus>>,
    retry: Arc<Notify>,
    fs: Arc<RootedFs>,
    default_cwd_path: String,
    shutdown: broadcast::Sender<()>,
    database_path: PathBuf,
    worktree_root: PathBuf,
}

impl PersistentTasksGateway {
    pub(in crate::app) fn new(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        database_path: PathBuf,
        worktree_root: PathBuf,
    ) -> Self {
        let status = Arc::new(RwLock::new(StartupTaskStatus {
            codex: pending_codex_status(),
            task_store: TaskStoreReadiness {
                state: TaskStoreReadinessState::Migrating,
                blocks_task_operations: true,
                diagnostic_message: "Caffold is preparing the Task store.".to_string(),
            },
            error_code: "task_store_migration_pending",
        }));
        let retry = Arc::new(Notify::new());
        let startup_state = StartupTaskState {
            status: status.clone(),
            retry: retry.clone(),
        };
        let startup_router = Router::new()
            .route("/api/codex/status", get(startup_codex_status))
            .route(
                "/api/task-store/migration/retry",
                post(retry_startup_migration),
            )
            .fallback(any(startup_task_blocked))
            .with_state(startup_state);
        let gateway = TaskRouterGateway {
            router: Arc::new(RwLock::new(startup_router)),
        };
        let router = gateway.router();
        let app = Arc::new(StdMutex::new(None));
        Self {
            router,
            app,
            gateway,
            status,
            retry,
            fs,
            default_cwd_path,
            shutdown,
            database_path,
            worktree_root,
        }
    }

    pub(in crate::app) fn router(&self) -> Router {
        self.router.clone()
    }

    pub(in crate::app) async fn run_startup(&self) {
        let mut shutdown_receiver = self.shutdown.subscribe();
        loop {
            let result =
                super::super::startup_migration::migrate_task_store(self.database_path.clone())
                    .await;
            match result {
                Ok(()) => match TasksApp::persistent(
                    self.fs.clone(),
                    self.default_cwd_path.clone(),
                    self.shutdown.clone(),
                    self.database_path.clone(),
                    self.worktree_root.clone(),
                ) {
                    Ok(tasks) => {
                        self.gateway.replace(tasks.router()).await;
                        *self
                            .app
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(tasks);
                        return;
                    }
                    Err(error) => {
                        set_storage_failure(self.status.clone(), error.to_string()).await;
                    }
                },
                Err(super::super::startup_migration::StartupMigrationError::CodexReadiness(
                    codex,
                )) => {
                    set_codex_wait(self.status.clone(), *codex).await;
                }
                Err(super::super::startup_migration::StartupMigrationError::Codex(error)) => {
                    set_codex_wait(
                        self.status.clone(),
                        CodexThreadClient::unavailable_status(&error),
                    )
                    .await;
                }
                Err(super::super::startup_migration::StartupMigrationError::Store(error)) => {
                    set_storage_failure(self.status.clone(), error.to_string()).await;
                }
                Err(super::super::startup_migration::StartupMigrationError::Worker(error)) => {
                    set_storage_failure(self.status.clone(), error.to_string()).await;
                }
            }
            tokio::select! {
                _ = self.retry.notified() => {
                    let mut status = self.status.write().await;
                    status.task_store = TaskStoreReadiness {
                        state: TaskStoreReadinessState::Migrating,
                        blocks_task_operations: true,
                        diagnostic_message: "Caffold is retrying the Task-store migration.".to_string(),
                    };
                    status.error_code = "task_store_migration_pending";
                }
                _ = shutdown_receiver.recv() => return,
            }
        }
    }

    pub(in crate::app) async fn shutdown(self) {
        let app = self
            .app
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(app) = app {
            app.shutdown().await;
        }
    }
}

async fn startup_codex_status(
    axum::extract::State(state): axum::extract::State<StartupTaskState>,
) -> Json<StartupStatusResponse> {
    let status = state.status.read().await.clone();
    Json(StartupStatusResponse {
        codex: status.codex,
        task_store_readiness: status.task_store,
    })
}

async fn retry_startup_migration(
    axum::extract::State(state): axum::extract::State<StartupTaskState>,
) -> (StatusCode, Json<serde_json::Value>) {
    {
        let mut status = state.status.write().await;
        status.task_store = TaskStoreReadiness {
            state: TaskStoreReadinessState::Migrating,
            blocks_task_operations: true,
            diagnostic_message: "Caffold is retrying the Task-store migration.".to_string(),
        };
        status.error_code = "task_store_migration_pending";
    }
    state.retry.notify_one();
    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({ "accepted": true })),
    )
}

async fn startup_task_blocked(
    axum::extract::State(state): axum::extract::State<StartupTaskState>,
) -> Response {
    let status = state.status.read().await;
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(serde_json::json!({
            "error": {
                "code": status.error_code,
                "message": status.task_store.diagnostic_message,
            }
        })),
    )
        .into_response()
}

async fn set_codex_wait(status: Arc<RwLock<StartupTaskStatus>>, codex: CodexStatusResponse) {
    let message = codex.readiness.diagnostic_message.clone();
    *status.write().await = StartupTaskStatus {
        codex,
        task_store: TaskStoreReadiness {
            state: TaskStoreReadinessState::WaitingForCodex,
            blocks_task_operations: true,
            diagnostic_message: format!(
                "Task-store migration is waiting for Codex readiness. {message}"
            ),
        },
        error_code: "codex_readiness_blocked",
    };
}

async fn set_storage_failure(status: Arc<RwLock<StartupTaskStatus>>, message: String) {
    let mut status = status.write().await;
    status.task_store = TaskStoreReadiness {
        state: TaskStoreReadinessState::Failed,
        blocks_task_operations: true,
        diagnostic_message: format!("Task-store migration failed: {message}"),
    };
    status.error_code = "task_store_migration_failed";
}

fn pending_codex_status() -> CodexStatusResponse {
    CodexStatusResponse {
        readiness: CodexReadiness::blocking(
            CodexReadinessState::Error,
            CodexReadinessReason::ReadyRuntimeUnavailable,
            "Codex readiness will be checked if Task-store migration requires it.",
            None,
        ),
        account: None,
        rate_limits: None,
        usage: None,
        app_server: None,
        daemon: None,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

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
}
