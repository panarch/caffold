mod active_list;
mod composer_settings;
mod detail;
mod events;
mod generated_images;
mod lifecycle;
mod projection;
mod push;
mod recovery;
mod routes;
mod runtime;
mod startup;
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
pub(super) use startup::PersistentTasksGateway;
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
pub(in crate::app::tasks) mod test_support {
    use std::{path::Path, sync::Arc, time::Duration};

    use serde_json::{Value as JsonValue, json};
    use tokio::sync::broadcast;

    use super::{TaskState, projection::*, routes::test_claim_task};
    use crate::{
        agent::{Conversation, codex::CodexThreadClient},
        fs::RootedFs,
        task_store::TaskStore,
    };

    const MOCK_METHOD_WAIT_TIMEOUT: Duration = Duration::from_secs(2);
    const MOCK_METHOD_POLL_INTERVAL: Duration = Duration::from_millis(5);

    pub(in crate::app::tasks) async fn task_state_with_codex_client(
        fs: RootedFs,
        client: CodexThreadClient,
    ) -> TaskState {
        let (shutdown, _) = broadcast::channel(16);
        let worktree_root = fs.root().join(".caffold-test/worktrees");
        let state = TaskState::new(
            Arc::new(fs),
            String::new(),
            shutdown,
            TaskStore::memory().expect("in-memory task store"),
            worktree_root,
        )
        .expect("task state");
        state.codex_runtime.install_test_client(1, client).await;
        state
    }

    pub(in crate::app::tasks) async fn wait_for_mock_method(
        client: &CodexThreadClient,
        method: &str,
    ) {
        wait_for_mock_method_count(client, method, 1).await;
    }

    pub(in crate::app::tasks) async fn wait_for_mock_method_count(
        client: &CodexThreadClient,
        method: &str,
        expected: usize,
    ) {
        let deadline = tokio::time::Instant::now() + MOCK_METHOD_WAIT_TIMEOUT;
        loop {
            if client
                .mock_requests()
                .await
                .iter()
                .filter(|(requested, _)| requested == method)
                .count()
                >= expected
            {
                return;
            }
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            tokio::time::sleep(remaining.min(MOCK_METHOD_POLL_INTERVAL)).await;
        }
        panic!("mock Codex client did not receive {expected} {method} request(s)");
    }

    pub(in crate::app::tasks) fn task_thread_list(thread_id: &str, cwd: &Path) -> JsonValue {
        json!({
            "data": [{
                "id": thread_id,
                "preview": "Cached task detail regression",
                "status": { "type": "idle" },
                "cwd": cwd.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            }],
            "nextCursor": null,
            "backwardsCursor": null
        })
    }

    pub(in crate::app::tasks) async fn manage_test_thread(
        state: &TaskState,
        thread_id: &str,
        cwd: &Path,
    ) {
        let thread: crate::agent::codex::CodexThread =
            serde_json::from_value(task_thread_list(thread_id, cwd)["data"][0].clone())
                .expect("the fixture decodes as a Codex thread");
        let conversation = Conversation::from(&thread);
        let resolved = resolve_conversation_cwd(&state.fs, &conversation);
        let task = task_record_from_conversation(&conversation, &[], resolved.as_ref());
        test_claim_task(state, &task)
            .await
            .expect("test thread is managed");
    }

    pub(in crate::app::tasks) async fn cache_and_manage_test_thread(
        state: &TaskState,
        thread_id: &str,
        cwd: &Path,
    ) {
        let thread = serde_json::from_value(task_thread_list(thread_id, cwd)["data"][0].clone())
            .expect("canonical test thread");
        state.codex_sessions.observe_thread_metadata(thread).await;
        manage_test_thread(state, thread_id, cwd).await;
    }

    pub(in crate::app::tasks) fn resumed_task(thread_id: &str, cwd: &Path) -> JsonValue {
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Cached task detail regression",
                "status": { "type": "idle" },
                "cwd": cwd.display().to_string(),
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            },
            "cwd": cwd.display().to_string(),
            "initialTurnsPage": {
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null
            }
        })
    }
}
