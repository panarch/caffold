mod detail;
mod events;
mod projection;
mod routes;
mod runtime;
mod sync;

use std::{path::PathBuf, sync::Arc};

use axum::Router;
use tokio::sync::broadcast;

use crate::{fs::RootedFs, thread_store::ThreadStore};

use detail::{DetailContext, TaskDetailSync};
use events::TaskEvents;
pub(super) use projection::TaskRecord;
use routes::TaskListEvents;
use runtime::CodexRuntime;
use sync::TaskSync;

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
    thread_store: ThreadStore,
    shutdown: broadcast::Sender<()>,
}

impl TaskState {
    fn new(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        thread_store: ThreadStore,
    ) -> Self {
        let task_events = TaskEvents::default();
        let codex_sessions = crate::codex_thread_sessions::CodexThreadSessions::default();
        let codex_runtime = CodexRuntime::new(
            codex_sessions.clone(),
            task_events.clone(),
            thread_store.clone(),
            shutdown.clone(),
        );
        let codex_runtime_signals = codex_runtime.subscribe();
        let task_sync = TaskSync::new(shutdown.clone());
        let task_list_events = TaskListEvents::new();
        let removal_events = task_list_events.clone();
        let detail = DetailContext::new(
            fs.clone(),
            thread_store.clone(),
            codex_runtime.clone(),
            codex_runtime_signals,
            codex_sessions.clone(),
            task_events.clone(),
            task_sync.clone(),
            shutdown.clone(),
            move |thread_id, reason| {
                removal_events.remove(thread_id, reason);
            },
        );
        Self {
            fs,
            default_cwd_path,
            codex_runtime,
            codex_sessions,
            detail,
            task_events,
            task_sync,
            task_list_events,
            thread_store,
            shutdown,
        }
    }
}

pub(super) struct TasksApp {
    router: Router,
    runtime: CodexRuntime,
}

impl TasksApp {
    fn new(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        thread_store: ThreadStore,
    ) -> Self {
        let state = TaskState::new(fs, default_cwd_path, shutdown, thread_store);
        let runtime = state.codex_runtime.clone();
        Self {
            router: routes::router(state),
            runtime,
        }
    }

    pub(super) fn persistent(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
        database_path: PathBuf,
    ) -> anyhow::Result<Self> {
        Ok(Self::new(
            fs,
            default_cwd_path,
            shutdown,
            ThreadStore::redb(database_path)?,
        ))
    }

    pub(super) fn memory(
        fs: Arc<RootedFs>,
        default_cwd_path: String,
        shutdown: broadcast::Sender<()>,
    ) -> anyhow::Result<Self> {
        Ok(Self::new(
            fs,
            default_cwd_path,
            shutdown,
            ThreadStore::memory()?,
        ))
    }

    pub(super) fn router(&self) -> Router {
        self.router.clone()
    }

    pub(super) async fn shutdown(self) {
        self.runtime.shutdown().await;
    }
}

pub(super) use detail::{DetailFrameStream, TaskDetailResponse};
pub(super) use events::{TaskEventRecord, accepted_user_message_event, now_ms};
pub(super) use projection::task_activity_ms;
pub(super) use runtime::{ApprovalResolveError, CodexConnection};

#[cfg(test)]
mod tests;
