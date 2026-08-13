mod active_sections;
mod detail;
mod events;
mod generated_images;
mod lifecycle;
mod projection;
mod push;
mod routes;
mod runtime;
mod sync;
mod worktrees;

use std::{path::PathBuf, sync::Arc};

use axum::Router;
use tokio::sync::broadcast;

use crate::{fs::RootedFs, task_store::TaskStore};

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
    active_sections: active_sections::ActiveTaskSections,
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
        let active_sections =
            active_sections::ActiveTaskSections::new(fs.clone(), task_store.clone());
        let managed_worktrees =
            ManagedWorktrees::new(fs.clone(), task_store.clone(), worktree_root)?;
        let lifecycle = TaskLifecycle::new(
            fs.clone(),
            codex_sessions.clone(),
            task_events.clone(),
            task_list_events.clone(),
            task_store.clone(),
            managed_worktrees,
            active_sections.clone(),
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
            active_sections,
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
