mod active_list;
mod detail;
mod events;
mod generated_images;
mod lifecycle;
mod projection;
mod push;
mod recovery;
mod routes;
mod runtime;
mod sync;
mod worktrees;

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

use crate::{
    codex_app_server::{
        CodexReadiness, CodexReadinessReason, CodexReadinessState, CodexStatusResponse,
        CodexThreadClient,
    },
    fs::RootedFs,
    task_store::TaskStore,
};

use detail::{DetailContext, TaskDetailSync};
use events::TaskEvents;
use lifecycle::TaskLifecycle;
pub(super) use projection::TaskRecord;
use push::{PushRuntime, PushService};
use routes::TaskListEvents;
use runtime::CodexRuntime;
use sync::TaskSync;
use worktrees::ManagedWorktrees;

#[derive(Clone)]
struct TaskState {
    fs: Arc<RootedFs>,
    default_cwd_path: String,
    codex_runtime: CodexRuntime,
    codex_sessions: crate::codex_thread_sessions::CodexThreadSessions,
    detail: DetailContext,
    task_events: TaskEvents,
    task_sync: TaskSync<TaskDetailSync>,
    task_list_events: TaskListEvents,
    task_store: TaskStore,
    lifecycle: TaskLifecycle,
    push: PushService,
    shutdown: broadcast::Sender<()>,
}

impl TaskState {
    #[cfg(test)]
    fn new(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        task_store: TaskStore,
        worktree_root: PathBuf,
    ) -> anyhow::Result<Self> {
        let (push, _receiver) = PushService::test_channel(task_store.clone());
        Self::new_with_push(
            fs,
            default_cwd_path,
            shutdown,
            task_store,
            worktree_root,
            push,
        )
    }

    fn new_with_push(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        task_store: TaskStore,
        worktree_root: PathBuf,
        push: PushService,
    ) -> anyhow::Result<Self> {
        let task_events = TaskEvents::default();
        let codex_sessions = crate::codex_thread_sessions::CodexThreadSessions::default();
        let task_list_events = TaskListEvents::new();
        let managed_worktrees =
            ManagedWorktrees::new(fs.clone(), task_store.clone(), worktree_root)?;
        let lifecycle = TaskLifecycle::new(
            fs.clone(),
            codex_sessions.clone(),
            task_events.clone(),
            task_list_events.clone(),
            task_store.clone(),
            managed_worktrees,
        );
        let codex_runtime = CodexRuntime::new(
            codex_sessions.clone(),
            task_events.clone(),
            task_store.clone(),
            shutdown.clone(),
        )
        .with_push_service(push.clone())
        .with_lifecycle(lifecycle.clone());
        let codex_runtime_signals = codex_runtime.subscribe();
        let task_sync = TaskSync::new(shutdown.clone());
        let refresh_events = task_list_events.clone();
        let detail = DetailContext::new(
            fs.clone(),
            task_store.clone(),
            codex_runtime.clone(),
            codex_runtime_signals,
            codex_sessions.clone(),
            task_events.clone(),
            task_sync.clone(),
            shutdown.clone(),
            move || refresh_events.refresh(),
        );
        Ok(Self {
            fs,
            default_cwd_path,
            codex_runtime,
            codex_sessions,
            detail,
            task_events,
            task_sync,
            task_list_events,
            task_store,
            lifecycle,
            push,
            shutdown,
        })
    }
}

pub(super) struct TasksApp {
    router: Router,
    runtime: CodexRuntime,
    push: PushRuntime,
}

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

pub(super) struct PersistentTasksGateway {
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
    pub(super) fn new(
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

    pub(super) fn router(&self) -> Router {
        self.router.clone()
    }

    pub(super) async fn run_startup(&self) {
        let mut shutdown_receiver = self.shutdown.subscribe();
        loop {
            let result =
                super::startup_migration::migrate_task_store(self.database_path.clone()).await;
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
                Err(super::startup_migration::StartupMigrationError::CodexReadiness(codex)) => {
                    set_codex_wait(self.status.clone(), *codex).await;
                }
                Err(super::startup_migration::StartupMigrationError::Codex(error)) => {
                    set_codex_wait(
                        self.status.clone(),
                        CodexThreadClient::unavailable_status(&error),
                    )
                    .await;
                }
                Err(super::startup_migration::StartupMigrationError::Store(error)) => {
                    set_storage_failure(self.status.clone(), error.to_string()).await;
                }
                Err(super::startup_migration::StartupMigrationError::Worker(error)) => {
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

    pub(super) async fn shutdown(self) {
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

impl TasksApp {
    fn new(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        task_store: TaskStore,
        worktree_root: PathBuf,
    ) -> anyhow::Result<Self> {
        let push = PushRuntime::new(task_store.clone())?;
        let state = TaskState::new_with_push(
            fs,
            default_cwd_path,
            shutdown,
            task_store,
            worktree_root,
            push.service(),
        )?;
        let runtime = state.codex_runtime.clone();
        Ok(Self {
            router: routes::router(state),
            runtime,
            push,
        })
    }

    pub(super) fn persistent(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        database_path: PathBuf,
        worktree_root: PathBuf,
    ) -> anyhow::Result<Self> {
        let app = Self::new(
            fs,
            default_cwd_path,
            shutdown,
            TaskStore::redb(database_path)?,
            worktree_root,
        )?;
        app.runtime.startup();
        Ok(app)
    }

    pub(super) fn memory(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        worktree_root: PathBuf,
    ) -> anyhow::Result<Self> {
        Self::new(
            fs,
            default_cwd_path,
            shutdown,
            TaskStore::memory()?,
            worktree_root,
        )
    }

    pub(super) fn router(&self) -> Router {
        self.router.clone()
    }

    pub(super) async fn shutdown(self) {
        tokio::join!(self.runtime.shutdown(), self.push.shutdown());
    }
}

pub(super) use detail::{DetailFrameStream, TaskDetailResponse};
pub(super) use events::{TaskEventRecord, accepted_user_message_event, now_ms};
pub(super) use projection::task_activity_ms;
pub(super) use runtime::{ApprovalResolveError, CodexConnection};

#[cfg(test)]
mod tests;
