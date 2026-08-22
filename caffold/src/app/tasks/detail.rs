use std::{collections::VecDeque, convert::Infallible, pin::Pin, sync::Arc};

use futures_util::{Stream, stream};
use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc};

mod file_links;

use file_links::{TaskFileLink, TaskFileLinkResolver};

use super::{
    events::{
        TaskEventRecord, TaskEvents, merge_task_event_records, sort_task_events, thread_events,
    },
    lifecycle::ActiveTaskTopPlacement,
    projection::{
        TaskRecord, apply_canonical_turn_projection, conversation_with_turns,
        resolve_conversation_cwd, task_record_from_conversation,
    },
    runtime::{CodexConnection, TaskAgent, TaskRuntime, TaskRuntimeSignal},
    sync::{DeferredTaskRolloutSubscription, TaskSync, TaskSyncJob, TaskSyncOutcome},
    worktrees::inspect_ready_worktree,
};
use crate::agent::AgentError;
use crate::{
    agent::{
        Conversation, TurnPage,
        codex::{CodexThreadClient, CodexThreadError},
    },
    app::error::ApiError,
    app::tasks::sessions::{SessionSnapshot, TaskSessions},
    fs::RootedFs,
    task_store::{ManagedThread, ManagedWorktreeState, TaskProvider, TaskStore, TaskStoreError},
};

pub(super) const TASK_DETAIL_TURNS_PAGE_SIZE: usize = 8;

type RefreshTaskList = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub(in crate::app) struct DetailContext {
    fs: Arc<RootedFs>,
    store: TaskStore,
    runtime: TaskRuntime,
    runtime_signals: Arc<AsyncMutex<Option<broadcast::Receiver<TaskRuntimeSignal>>>>,
    sessions: TaskSessions,
    events: TaskEvents,
    file_links: TaskFileLinkResolver,
    sync: TaskSync<TaskDetailSync>,
    shutdown: broadcast::Sender<()>,
    refresh_task_list: RefreshTaskList,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskDetailResponse {
    pub(in crate::app) thread_id: String,
    pub(in crate::app) sync_state: TaskSyncState,
    pub(in crate::app) revision: u64,
    pub(in crate::app) task: Option<TaskRecord>,
    pub(in crate::app) events: Vec<TaskEventRecord>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(in crate::app) file_links: Vec<TaskFileLink>,
    pub(in crate::app) events_page: TaskEventsPage,
    pub(in crate::app) pending_approvals: Vec<TaskEventRecord>,
    pub(in crate::app) history_loading: bool,
    /// Which agent runs this Task, when this answer knows.
    ///
    /// The composer reads it to offer that agent's models and permission modes
    /// and not another's. An error broadcast does not read the store, so it says
    /// nothing here rather than naming an agent it did not look up. Such an
    /// answer carries no Task either, and a Task nobody can read is one nobody
    /// can prompt — so no surface reads this while it is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app) provider: Option<TaskProvider>,
    pub(in crate::app) permission_mode: Option<String>,
    pub(in crate::app) model: Option<String>,
    pub(in crate::app) reasoning_effort: Option<String>,
    pub(in crate::app) fast_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app) active_top_placement: Option<ActiveTaskTopPlacement>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) enum TaskSyncState {
    Loading,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskEventsPage {
    pub(in crate::app) next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskDetailSync {
    pub(in crate::app) thread_id: String,
    pub(in crate::app) revision: u64,
    pub(in crate::app) detail: TaskDetailResponse,
    pub(in crate::app) reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEventEnvelope {
    thread_id: String,
    revision: u64,
    event: TaskEventRecord,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    file_links: Vec<TaskFileLink>,
}

pub(in crate::app) type DetailFrameStream =
    Pin<Box<dyn Stream<Item = Result<String, Infallible>> + Send>>;

pub(in crate::app) fn task_stream_initial_frames(sync: &TaskDetailSync) -> VecDeque<String> {
    let payload = serde_json::to_string(sync).expect("task detail sync serializes");
    VecDeque::from([
        ": ready\n\n".to_string(),
        format!("event: task-sync\ndata: {payload}\n\n"),
    ])
}

impl DetailContext {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::app) fn new(
        fs: Arc<RootedFs>,
        store: TaskStore,
        runtime: TaskRuntime,
        runtime_signals: broadcast::Receiver<TaskRuntimeSignal>,
        sessions: TaskSessions,
        events: TaskEvents,
        sync: TaskSync<TaskDetailSync>,
        shutdown: broadcast::Sender<()>,
        refresh_task_list: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        Self {
            file_links: TaskFileLinkResolver::new(fs.clone()),
            fs,
            store,
            runtime,
            runtime_signals: Arc::new(AsyncMutex::new(Some(runtime_signals))),
            sessions,
            events,
            sync,
            shutdown,
            refresh_task_list: Arc::new(refresh_task_list),
        }
    }

    pub(in crate::app) async fn client(&self) -> Result<CodexThreadClient, ApiError> {
        self.ensure_runtime_signal_driver().await;
        self.runtime.client().await.map_err(ApiError::from)
    }

    pub(in crate::app) async fn connection(&self) -> Result<CodexConnection, CodexThreadError> {
        self.ensure_runtime_signal_driver().await;
        self.runtime.connection().await
    }

    /// The agent that owns this Task, ready to be asked about it.
    pub(in crate::app) async fn agent(&self, thread_id: &str) -> Result<TaskAgent, AgentError> {
        self.ensure_runtime_signal_driver().await;
        self.runtime.task_agent(thread_id).await
    }

    pub(in crate::app) async fn get(
        &self,
        thread_id: &str,
        cursor: Option<&str>,
    ) -> Result<TaskDetailResponse, ApiError> {
        let cursor = cursor.map(str::trim).filter(|cursor| !cursor.is_empty());
        self.restore_managed_fast_mode(thread_id).await?;
        if let Some(cursor) = cursor {
            let agent = self.agent(thread_id).await?;
            let _viewer = self
                .sessions
                .acquire_viewer(&agent.driver(), agent.generation(), thread_id)
                .await?;
            return self.read(&agent, thread_id, Some(cursor)).await;
        }

        let viewer = self.sessions.reserve_viewer(thread_id).await;
        let (detail, baseline_revision) = self.cached(thread_id).await?;
        let context = self.clone();
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            context.bootstrap(&thread_id, baseline_revision).await;
            drop(viewer);
        });
        Ok(detail)
    }

    pub(in crate::app) async fn stream(
        &self,
        thread_id: &str,
    ) -> Result<DetailFrameStream, ApiError> {
        self.restore_managed_fast_mode(thread_id).await?;
        let receiver = self.events.subscribe();
        let sync_receiver = self.sync.subscribe_updates();
        let viewer = self.sessions.reserve_viewer(thread_id).await;
        let snapshot = self.sessions.snapshot(thread_id).await;
        let rollout_path = snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.conversation.as_ref())
            .and_then(|conversation| conversation.transcript_path.clone());
        let (detail, baseline_revision) = self.cached(thread_id).await?;
        let file_link_task_root = detail.task.as_ref().map(file_links::task_root);
        let initial_frames = task_stream_initial_frames(&TaskDetailSync {
            thread_id: thread_id.to_string(),
            revision: detail.revision,
            detail,
            reason: "stream-bootstrap",
            error: None,
        });
        let subscription = self.sync.subscribe(thread_id);
        let rollout_subscription = DeferredTaskRolloutSubscription::default();
        rollout_subscription.install_with(|| {
            self.sync
                .subscribe_rollout(thread_id, rollout_path.as_deref())
        });
        self.ensure_sync_worker().await;

        let bootstrap_context = self.clone();
        let bootstrap_thread_id = thread_id.to_string();
        let bootstrap_rollout_subscription = rollout_subscription.clone();
        tokio::spawn(async move {
            bootstrap_context
                .bootstrap(&bootstrap_thread_id, baseline_revision)
                .await;
            let rollout_path = bootstrap_context
                .sessions
                .snapshot(&bootstrap_thread_id)
                .await
                .and_then(|snapshot| snapshot.conversation)
                .and_then(|conversation| conversation.transcript_path);
            bootstrap_rollout_subscription.install_with(|| {
                bootstrap_context
                    .sync
                    .subscribe_rollout(&bootstrap_thread_id, rollout_path.as_deref())
            });
        });

        let shutdown = self.shutdown.subscribe();
        let sessions = self.sessions.clone();
        let file_link_resolver = self.file_links.clone();
        let thread_id = thread_id.to_string();
        let stream = stream::unfold(
            (
                initial_frames,
                receiver,
                sync_receiver,
                shutdown,
                thread_id,
                subscription,
                rollout_subscription,
                viewer,
                sessions,
                file_link_resolver,
                file_link_task_root,
            ),
            |(
                mut initial_frames,
                mut receiver,
                mut sync_receiver,
                mut shutdown,
                thread_id,
                subscription,
                rollout_subscription,
                viewer,
                sessions,
                file_link_resolver,
                mut file_link_task_root,
            )| async move {
                if let Some(frame) = initial_frames.pop_front() {
                    return Some((
                        Ok(frame),
                        (
                            initial_frames,
                            receiver,
                            sync_receiver,
                            shutdown,
                            thread_id,
                            subscription,
                            rollout_subscription,
                            viewer,
                            sessions,
                            file_link_resolver,
                            file_link_task_root,
                        ),
                    ));
                }
                loop {
                    tokio::select! {
                        _ = shutdown.recv() => return None,
                        message = sync_receiver.recv() => {
                            match message {
                                Ok(sync) if sync.thread_id == thread_id => {
                                    file_link_task_root = sync
                                        .detail
                                        .task
                                        .as_ref()
                                        .map(file_links::task_root)
                                        .or(file_link_task_root);
                                    let payload = serde_json::to_string(&sync)
                                        .unwrap_or_else(|_| "{}".to_string());
                                    let frame =
                                        format!("event: task-sync\ndata: {payload}\n\n");
                                    return Some((
                                        Ok(frame),
                                        (
                                            initial_frames,
                                            receiver,
                                            sync_receiver,
                                            shutdown,
                                            thread_id,
                                            subscription,
                                            rollout_subscription,
                                            viewer,
                                            sessions,
                                            file_link_resolver,
                                            file_link_task_root,
                                        ),
                                    ));
                                }
                                Ok(_) => continue,
                                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(broadcast::error::RecvError::Closed) => return None,
                            }
                        }
                        message = receiver.recv() => {
                            match message {
                                Ok(event) if event.thread_id == thread_id => {
                                    let revision = sessions
                                        .snapshot(&thread_id)
                                        .await
                                        .map(|snapshot| snapshot.revision)
                                        .unwrap_or_default();
                                    let (event, resolved_file_links) = match file_link_task_root.as_deref() {
                                        Some(task_root) => file_link_resolver
                                            .project_event(task_root, &event)
                                            .await,
                                        None => (event, Vec::new()),
                                    };
                                    let payload = serde_json::to_string(
                                        &TaskEventEnvelope {
                                            thread_id: thread_id.clone(),
                                            revision,
                                            event,
                                            file_links: resolved_file_links,
                                        },
                                    )
                                    .unwrap_or_else(|_| "{}".to_string());
                                    let frame =
                                        format!("event: task-event\ndata: {payload}\n\n");
                                    return Some((
                                        Ok(frame),
                                        (
                                            initial_frames,
                                            receiver,
                                            sync_receiver,
                                            shutdown,
                                            thread_id,
                                            subscription,
                                            rollout_subscription,
                                            viewer,
                                            sessions,
                                            file_link_resolver,
                                            file_link_task_root,
                                        ),
                                    ));
                                }
                                Ok(_) => continue,
                                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                                Err(broadcast::error::RecvError::Closed) => return None,
                            }
                        }
                    }
                }
            },
        );
        Ok(Box::pin(stream))
    }

    pub(in crate::app) async fn read(
        &self,
        agent: &TaskAgent,
        thread_id: &str,
        cursor: Option<&str>,
    ) -> Result<TaskDetailResponse, ApiError> {
        self.restore_managed_fast_mode(thread_id).await?;
        let (snapshot, response_page) = if let Some(cursor) = cursor {
            let (snapshot, page) = self
                .sessions
                .load_older_turns(
                    &agent.driver(),
                    agent.generation(),
                    thread_id,
                    cursor,
                    TASK_DETAIL_TURNS_PAGE_SIZE,
                )
                .await?;
            (snapshot, Some(page))
        } else {
            (
                self.sessions
                    .load_metadata(&agent.driver(), agent.generation(), thread_id)
                    .await?,
                None,
            )
        };
        self.assemble_snapshot(snapshot, response_page).await
    }

    pub(in crate::app) async fn cached(
        &self,
        thread_id: &str,
    ) -> Result<(TaskDetailResponse, u64), ApiError> {
        let stored = self.store_get(thread_id).await?;
        let Some(snapshot) = self.sessions.snapshot(thread_id).await else {
            return Ok((loading_detail(thread_id, 0, stored.as_ref()), 0));
        };
        if let Some(error) = snapshot.last_error.as_ref() {
            return Err(ApiError::Agent(format!(
                "canonical Codex task state is unavailable: {error}"
            )));
        }
        let revision = snapshot.revision;
        if snapshot.conversation.is_none() {
            return Ok((
                loading_detail(thread_id, revision, stored.as_ref()),
                revision,
            ));
        }
        let detail = self.assemble_snapshot(snapshot, None).await?;
        Ok((detail, revision))
    }

    pub(in crate::app) async fn bootstrap(&self, thread_id: &str, baseline_revision: u64) {
        if let Err(error) = self.restore_managed_fast_mode(thread_id).await {
            self.broadcast_error(thread_id, error.to_string()).await;
            return;
        }
        let agent = match self.agent(thread_id).await {
            Ok(agent) => agent,
            Err(error) => {
                self.sessions.fail_external_sync(thread_id, &error).await;
                self.broadcast_error(thread_id, error.to_string()).await;
                if matches!(error, AgentError::ConversationGone(_)) {
                    (self.refresh_task_list)();
                }
                return;
            }
        };
        let snapshot = match self
            .sessions
            .ensure_subscribed(&agent.driver(), agent.generation(), thread_id)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.sessions.fail_external_sync(thread_id, &error).await;
                self.broadcast_error(thread_id, error.to_string()).await;
                if matches!(error, AgentError::ConversationGone(_)) {
                    (self.refresh_task_list)();
                }
                return;
            }
        };
        if snapshot.revision <= baseline_revision {
            return;
        }
        self.broadcast_snapshot(thread_id, snapshot, "session-bootstrap")
            .await;
    }

    pub(in crate::app) async fn assemble_snapshot(
        &self,
        snapshot: SessionSnapshot,
        response_page: Option<TurnPage>,
    ) -> Result<TaskDetailResponse, ApiError> {
        let revision = snapshot.revision;
        let permission_mode = snapshot.permission_mode;
        let session_model = snapshot.model.clone();
        let session_reasoning_effort = snapshot.reasoning_effort.clone();
        let session_fast_mode = snapshot.fast_mode;
        let thread_id = snapshot
            .conversation
            .as_ref()
            .map(|thread| thread.id.clone())
            .ok_or_else(|| ApiError::Agent("subscribed thread metadata is missing".to_string()))?;
        let page = response_page.or_else(|| snapshot.turns_page.clone());
        let history_loading = page.is_none();
        let mut turns = page
            .as_ref()
            .map(|page| page.turns.clone())
            .unwrap_or_default();
        // An agent reports its history newest first; a conversation reads
        // oldest first.
        turns.reverse();
        let next_cursor = page.and_then(|page| page.next_cursor);
        let conversation = snapshot
            .conversation
            .expect("conversation metadata was checked above");
        let conversation = self.project_managed_worktree_cwd(conversation)?;
        let conversation = conversation_with_turns(&conversation, turns);
        let mut events = thread_events(&conversation);
        self.events.observe(&events);
        events = merge_task_event_records(events, self.events.for_thread(&thread_id));
        let pending_approvals = self.runtime.approval_events(&thread_id).await;
        events = merge_task_event_records(events, pending_approvals.clone());
        sort_task_events(&mut events);
        let resolved_cwd = resolve_conversation_cwd(&self.fs, &conversation);
        let mut task = task_record_from_conversation(&conversation, &events, resolved_cwd.as_ref());
        apply_canonical_turn_projection(&mut task, &conversation);
        let managed = self.store_get(&thread_id).await?;
        if let Some(current) = managed {
            task.title = current.display_name.clone();
            task.last_completed_ms = task.last_completed_ms.max(current.last_completed_at_ms);
            task.unseen = task.last_completed_ms.is_some_and(|completed_ms| {
                current
                    .last_seen_activity_ms
                    .is_none_or(|seen_ms| seen_ms < completed_ms)
            });
            let (projected_events, file_links) = self.file_links.project_task(&task, &events).await;
            events = projected_events;
            let provider = Some(current.run_by.provider());
            let model = session_model.or(current.model);
            let reasoning_effort = session_reasoning_effort.or(current.reasoning_effort);
            return Ok(TaskDetailResponse {
                thread_id,
                sync_state: TaskSyncState::Ready,
                revision,
                task: Some(task),
                events,
                file_links,
                events_page: TaskEventsPage { next_cursor },
                pending_approvals,
                history_loading,
                provider,
                permission_mode,
                model,
                reasoning_effort,
                fast_mode: session_fast_mode,
                active_top_placement: None,
            });
        }
        Err(not_managed_error())
    }

    pub(in crate::app) fn record_from_conversation(
        &self,
        conversation: &Conversation,
    ) -> Result<TaskRecord, ApiError> {
        let conversation = self.project_managed_worktree_cwd(conversation.clone())?;
        let resolved = resolve_conversation_cwd(&self.fs, &conversation);
        Ok(task_record_from_conversation(
            &conversation,
            &[],
            resolved.as_ref(),
        ))
    }

    fn project_managed_worktree_cwd(
        &self,
        conversation: Conversation,
    ) -> Result<Conversation, ApiError> {
        project_managed_worktree_cwd(&self.store, conversation)
    }

    async fn ensure_runtime_signal_driver(&self) {
        let Some(mut receiver) = self.runtime_signals.lock().await.take() else {
            return;
        };
        let context = self.clone();
        let mut shutdown = self.shutdown.subscribe();
        tokio::spawn(async move {
            loop {
                let signal = tokio::select! {
                    _ = shutdown.recv() => return,
                    signal = receiver.recv() => signal,
                };
                match signal {
                    Ok(TaskRuntimeSignal::SessionChanged {
                        thread_id,
                        snapshot,
                    }) => {
                        context
                            .broadcast_snapshot(&thread_id, *snapshot, "app-server-notification")
                            .await;
                    }
                    Ok(TaskRuntimeSignal::SessionUnavailable { thread_id, message }) => {
                        context.broadcast_error(&thread_id, message).await;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        return;
                    }
                }
            }
        });
    }

    pub(in crate::app) async fn ensure_sync_worker(&self) {
        let Some(receiver) = self.sync.take_jobs().await else {
            return;
        };
        let context = self.clone();
        tokio::spawn(async move {
            context.run_sync_worker(receiver).await;
        });
    }

    async fn run_sync_worker(&self, mut receiver: mpsc::UnboundedReceiver<TaskSyncJob>) {
        let mut shutdown = self.shutdown.subscribe();
        loop {
            let job = tokio::select! {
                _ = shutdown.recv() => return,
                job = receiver.recv() => job,
            };
            let Some(job) = job else {
                return;
            };
            self.run_sync_job(job).await;
        }
    }

    async fn run_sync_job(&self, job: TaskSyncJob) {
        debug_assert!(job.invalidation_revision > 0);
        let thread_id = job.thread_id.clone();
        let syncing = self.sessions.begin_external_sync(&thread_id).await;
        let Ok(connection) = self.connection().await else {
            self.sessions
                .fail_external_sync(&thread_id, &Self::unreachable_codex())
                .await;
            self.broadcast_error(&thread_id, Self::unreachable_codex().to_string())
                .await;
            job.complete(TaskSyncOutcome::Retry);
            return;
        };
        let response = tokio::try_join!(
            connection.client.read_thread(&thread_id),
            connection
                .client
                .list_thread_turns(&thread_id, None, TASK_DETAIL_TURNS_PAGE_SIZE,),
        );
        let (thread, latest_turns) = match response {
            Ok(response) => response,
            Err(error) if error.is_thread_unavailable() => {
                self.sessions
                    .fail_external_sync(&thread_id, &error.clone().into())
                    .await;
                self.broadcast_error(&thread_id, error.to_string()).await;
                (self.refresh_task_list)();
                job.complete(TaskSyncOutcome::Synchronized);
                return;
            }
            Err(error) => {
                self.sessions
                    .fail_external_sync(&thread_id, &error.clone().into())
                    .await;
                self.broadcast_error(&thread_id, error.to_string()).await;
                job.complete(TaskSyncOutcome::Retry);
                return;
            }
        };
        let snapshot = self
            .sessions
            .apply_external_read_sync(
                &thread_id,
                syncing.revision,
                Conversation::from(&thread),
                TurnPage::from(&latest_turns),
            )
            .await;
        if let Ok(detail) = self.assemble_snapshot(snapshot, None).await {
            self.sync.publish(TaskDetailSync {
                revision: detail.revision,
                thread_id,
                detail,
                reason: "canonical-read-sync",
                error: None,
            });
        }
        job.complete(TaskSyncOutcome::Synchronized);
    }

    async fn broadcast_snapshot(
        &self,
        thread_id: &str,
        snapshot: SessionSnapshot,
        reason: &'static str,
    ) {
        let Ok(detail) = self.assemble_snapshot(snapshot, None).await else {
            return;
        };
        self.sync.publish(TaskDetailSync {
            revision: detail.revision,
            thread_id: thread_id.to_string(),
            detail,
            reason,
            error: None,
        });
    }

    /// Codex gone quiet, in the words every agent shares.
    fn unreachable_codex() -> crate::agent::AgentError {
        crate::agent::codex::CodexThreadError::ProcessUnavailable.into()
    }

    async fn broadcast_error(&self, thread_id: &str, error: String) {
        let revision = self
            .sessions
            .snapshot(thread_id)
            .await
            .map(|snapshot| snapshot.revision)
            .unwrap_or_default();
        let detail = loading_detail(thread_id, revision, None);
        self.sync.publish(TaskDetailSync {
            thread_id: thread_id.to_string(),
            revision,
            detail,
            reason: "canonical-source-error",
            error: Some(error),
        });
    }

    async fn store_get(&self, thread_id: &str) -> Result<Option<ManagedThread>, ApiError> {
        let store = self.store.clone();
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || store.get(&thread_id))
            .await
            .map_err(store_join_error)?
            .map_err(store_error)
    }

    async fn restore_managed_fast_mode(&self, thread_id: &str) -> Result<(), ApiError> {
        let managed = self
            .store_get(thread_id)
            .await?
            .ok_or_else(not_managed_error)?;
        self.sessions
            .restore_managed_fast_mode(thread_id, managed.fast_mode)
            .await;
        Ok(())
    }
}

/// Point a conversation at the worktree Caffold moved it into.
///
/// An agent reports the directory it was started in, which is no longer where
/// the work happens once a Task has been isolated. Everything downstream — Git,
/// review, file links — resolves from this one field.
pub(in crate::app) fn project_managed_worktree_cwd(
    store: &TaskStore,
    mut conversation: Conversation,
) -> Result<Conversation, ApiError> {
    let worktree = store
        .worktree_for_thread(&conversation.id)
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    if let Some(worktree) = worktree
        && worktree.state == ManagedWorktreeState::Ready
    {
        inspect_ready_worktree(&worktree).map_err(|error| ApiError::BadRequest {
            code: "managed_worktree_unavailable",
            message: format!(
                "the managed worktree is unavailable at {}: {error}",
                worktree.worktree_path
            ),
        })?;
        conversation.cwd = worktree.worktree_path;
    }
    Ok(conversation)
}

pub(in crate::app) fn loading_detail(
    thread_id: &str,
    revision: u64,
    managed: Option<&ManagedThread>,
) -> TaskDetailResponse {
    TaskDetailResponse {
        thread_id: thread_id.to_string(),
        sync_state: TaskSyncState::Loading,
        revision,
        task: None,
        events: Vec::new(),
        file_links: Vec::new(),
        events_page: TaskEventsPage { next_cursor: None },
        pending_approvals: Vec::new(),
        history_loading: true,
        provider: managed.map(|thread| thread.run_by.provider()),
        permission_mode: None,
        model: managed.and_then(|thread| thread.model.clone()),
        reasoning_effort: managed.and_then(|thread| thread.reasoning_effort.clone()),
        fast_mode: managed.is_some_and(|thread| thread.fast_mode),
        active_top_placement: None,
    }
}

pub(in crate::app) fn not_managed_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_not_managed",
        message: "task is not managed by Caffold".to_string(),
    }
}

fn store_error(error: TaskStoreError) -> ApiError {
    ApiError::Internal(error.to_string())
}

fn store_join_error(error: tokio::task::JoinError) -> ApiError {
    ApiError::Internal(format!("task store worker failed: {error}"))
}

#[cfg(test)]
mod inline_tests {
    use serde_json::json;

    use super::*;
    use crate::task_store::{CheckoutAnchor, ManagedWorktree};

    /// A conversation whose only interesting field is where it says it is
    /// running, which is what the managed-worktree projection replaces.
    fn codex_thread(cwd: &str) -> Conversation {
        let thread: crate::agent::codex::CodexThread = serde_json::from_value(json!({
            "id": "thread-1",
            "cwd": cwd,
            "status": { "type": "idle" },
        }))
        .expect("the fixture decodes as a Codex thread");
        Conversation::from(&thread)
    }

    #[test]
    fn ready_branch_switch_projects_live_git_context_without_persisting_the_observation() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        initialize_repository(&source);
        let managed = temp.path().join("managed");
        let checkout =
            crate::git::create_attached_worktree(&source, &managed, "caffold/review", None)
                .unwrap();
        let store = TaskStore::memory().unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: "worktree-1".to_string(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: checkout.common_dir.display().to_string(),
                worktree_path: managed.display().to_string(),
                state: ManagedWorktreeState::Ready,
                checkout_anchor: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .unwrap();
        let stored_before = store.worktree("worktree-1").unwrap().unwrap();
        git(&managed, &["switch", "-c", "review/next"]);
        std::fs::write(managed.join("next.txt"), "next branch\n").unwrap();
        git(&managed, &["add", "next.txt"]);
        git(&managed, &["commit", "-m", "Advance next branch"]);
        let live_head = git_output(&managed, &["rev-parse", "HEAD"]);

        let projected =
            project_managed_worktree_cwd(&store, codex_thread("/stale/source")).unwrap();

        assert_eq!(projected.cwd, managed.display().to_string());
        let fs = RootedFs::new(temp.path()).unwrap();
        let context = resolve_conversation_cwd(&fs, &projected)
            .unwrap()
            .worktree
            .unwrap();
        assert_eq!(context.branch.as_deref(), Some("review/next"));
        assert_eq!(context.head_sha, live_head);
        assert_eq!(
            store.worktree("worktree-1").unwrap().unwrap(),
            stored_before
        );
    }

    #[test]
    fn unavailable_ready_worktree_rejects_cwd_projection() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        initialize_repository(&source);
        let repository = crate::git::managed_repository(&source).unwrap();
        let missing = temp.path().join("missing-managed");
        let store = TaskStore::memory().unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: "worktree-1".to_string(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: missing.display().to_string(),
                state: ManagedWorktreeState::Ready,
                checkout_anchor: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .unwrap();

        let error =
            project_managed_worktree_cwd(&store, codex_thread("/stale/source")).unwrap_err();

        assert!(matches!(
            error,
            ApiError::BadRequest {
                code: "managed_worktree_unavailable",
                message,
            } if message.contains(&missing.display().to_string())
        ));
    }

    #[test]
    fn incomplete_managed_worktree_keeps_canonical_cwd_visible() {
        let temp = tempfile::tempdir().unwrap();
        let managed = temp.path().join("managed");
        std::fs::create_dir(&managed).unwrap();
        let store = TaskStore::memory().unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: "worktree-1".to_string(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: temp.path().join(".git").display().to_string(),
                worktree_path: managed.display().to_string(),
                state: ManagedWorktreeState::RecoveryRequired,
                checkout_anchor: Some(CheckoutAnchor {
                    branch_name: "caffold/review".to_string(),
                    head_sha: "deadbeef".to_string(),
                }),
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .unwrap();

        let projected =
            project_managed_worktree_cwd(&store, codex_thread("/original/source")).unwrap();

        assert_eq!(projected.cwd, "/original/source");
    }

    fn initialize_repository(path: &std::path::Path) {
        std::fs::create_dir(path).unwrap();
        for args in [
            &["init"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Caffold Test"],
        ] {
            git(path, args);
        }
        std::fs::write(path.join("README.md"), "initial\n").unwrap();
        git(path, &["add", "README.md"]);
        git(path, &["commit", "-m", "Initial"]);
    }

    fn git(path: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output(path: &std::path::Path, args: &[&str]) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }
}

#[cfg(test)]
mod request_tests {
    use std::time::Duration;

    use axum::http::StatusCode;
    use serde_json::json;
    use tokio::sync::broadcast;

    use super::super::{
        CodexConnection, TaskRuntime,
        events::*,
        projection::*,
        routes::{
            test_store_get, test_store_update_composer_settings, test_task_detail, test_task_stream,
        },
        test_support::*,
    };
    use super::*;
    use crate::{
        agent::{
            ThreadStatus, TurnStatus, codex,
            codex::{CodexNotification, CodexRuntimeEvent, CodexThreadClient},
        },
        app::error::ApiError,
        app::tasks::sessions::{SessionLifecycle, TaskSessions},
        fs::RootedFs,
        task_store::TaskStore,
    };

    #[tokio::test]
    async fn event_notification_does_not_broadcast_its_own_full_detail_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-event-only-detail";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let _viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .expect("viewer");
        let initial_revision = state
            .task_sessions
            .snapshot(thread_id)
            .await
            .expect("initial snapshot")
            .revision;
        let mut task_events = state.task_events.subscribe();
        let mut detail_syncs = state.task_sync.subscribe_updates();
        state.detail.ensure_runtime_signal_driver().await;
        state.task_runtime.spawn_test_bridge(client.clone(), 1);

        client.mock_publish_event(CodexRuntimeEvent::Notification(
            CodexNotification::ItemStarted {
                thread_id: thread_id.to_string(),
                turn_id: "turn-1".to_string(),
                item: json!({
                    "id": "reasoning-1",
                    "type": "reasoning",
                    "summary": ["Read the current behavior."],
                    "content": []
                }),
                started_at_ms: 10,
            },
        ));
        client.mock_publish_event(CodexRuntimeEvent::Notification(
            CodexNotification::ThreadStatusChanged {
                thread_id: thread_id.to_string(),
                status: codex::ThreadStatus::SystemError,
            },
        ));

        let event = tokio::time::timeout(Duration::from_secs(1), task_events.recv())
            .await
            .expect("item notification publishes a Task event")
            .expect("Task event channel remains open");
        assert_eq!(event.thread_id, thread_id);
        assert_eq!(event.event_type, "reasoning");

        let sync = tokio::time::timeout(Duration::from_secs(1), detail_syncs.recv())
            .await
            .expect("canonical status change publishes a detail sync")
            .expect("detail sync channel remains open");
        assert_eq!(sync.thread_id, thread_id);
        assert_eq!(sync.revision, initial_revision + 2);
        assert_eq!(sync.reason, "app-server-notification");
        assert_eq!(
            sync.detail.task.expect("canonical Task").thread_status,
            ThreadStatus::SystemError
        );
    }

    #[tokio::test]
    async fn cached_task_detail_restores_managed_thread_composer_settings() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-cached-model-settings";
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        test_store_update_composer_settings(
            &state,
            thread_id,
            Some("gpt-5.6-sol"),
            Some("xhigh"),
            true,
        )
        .await
        .unwrap();

        let (detail, revision) = state.detail.cached(thread_id).await.unwrap();

        assert_eq!(revision, 0);
        assert!(detail.history_loading);
        assert_eq!(detail.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(detail.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(detail.fast_mode);
    }

    #[tokio::test]
    async fn canonical_resume_refreshes_cached_model_settings() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-canonical-model-settings";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "cwd": root.path().display().to_string(),
                "thread": {
                    "id": thread_id,
                    "preview": "Canonical model settings",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                },
                "model": "gpt-5.6-luna",
                "reasoningEffort": "medium",
                "serviceTier": null,
                "initialTurnsPage": {
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        test_store_update_composer_settings(
            &state,
            thread_id,
            Some("gpt-5.6-sol"),
            Some("xhigh"),
            true,
        )
        .await
        .unwrap();

        let snapshot = state
            .task_sessions
            .ensure_subscribed(&client.driver(), 1, thread_id)
            .await
            .unwrap();
        let detail = state
            .detail
            .assemble_snapshot(snapshot, None)
            .await
            .unwrap();

        assert_eq!(detail.model.as_deref(), Some("gpt-5.6-luna"));
        assert_eq!(detail.reasoning_effort.as_deref(), Some("medium"));
        assert!(!detail.fast_mode);
        let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(stored.fast_mode);
    }

    #[tokio::test]
    async fn canonical_resume_without_model_settings_preserves_the_cached_selection() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-canonical-speed-only";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
            "thread/resume",
            json!({
                "cwd": root.path().display().to_string(),
                "thread": {
                    "id": thread_id,
                    "preview": "Canonical speed only",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                },
                "serviceTier": null,
                "initialTurnsPage": {
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        test_store_update_composer_settings(
            &state,
            thread_id,
            Some("gpt-5.6-sol"),
            Some("xhigh"),
            true,
        )
        .await
        .unwrap();

        let detail = state
            .detail
            .read(
                &TaskAgent::Codex(CodexConnection {
                    client: client.clone(),
                    generation: 1,
                }),
                thread_id,
                None,
            )
            .await
            .unwrap();

        let requests = client.mock_requests().await;
        assert_eq!(requests[0].1["serviceTier"], "priority");
        assert_eq!(detail.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(detail.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(!detail.fast_mode);
        let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(stored.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(stored.fast_mode);
    }

    #[tokio::test]
    async fn canonical_turn_history_projects_missed_completion_without_persisting_get_observations()
    {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-missed-completion";
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread: crate::agent::codex::CodexThread = serde_json::from_value(json!({
            "id": thread_id,
            "preview": "Recovered completion",
            "status": { "type": "idle" },
            "cwd": root.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "recencyAt": 2.5,
            "turns": []
        }))
        .unwrap();
        let turns_page: crate::agent::codex::TurnsPage = serde_json::from_value(json!({
            "data": [
                {
                    "id": "turn-newest",
                    "items": [],
                    "status": "completed",
                    "completedAt": 5.0
                },
                {
                    "id": "turn-older",
                    "items": [],
                    "status": "completed",
                    "completedAt": 4.0
                }
            ],
            "nextCursor": null,
            "backwardsCursor": null
        }))
        .unwrap();
        let mut snapshot = crate::app::tasks::sessions::SessionSnapshot {
            lifecycle: SessionLifecycle::Subscribed,
            conversation: Some(Conversation::from(&thread)),
            turns_page: Some(TurnPage::from(&turns_page)),
            active_turn_id: None,
            active_turn_cwd: None,
            viewer_leases: 0,
            runtime_lease: false,
            generation: 1,
            revision: 1,
            last_sync_ms: Some(5_000),
            last_error: None,
            external_syncing: false,
            external_sync_started_ms: None,
            permission_mode: None,
            model: None,
            reasoning_effort: None,
            fast_mode: false,
        };

        let background = state
            .detail
            .assemble_snapshot(snapshot.clone(), None)
            .await
            .unwrap();
        let task = background.task.unwrap();
        assert_eq!(task.last_completed_ms, Some(5_000));
        assert!(task.unseen);
        let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(stored.last_completed_at_ms, None);
        assert_eq!(stored.last_seen_activity_ms, None);

        snapshot.viewer_leases = 1;
        let viewed = state
            .detail
            .assemble_snapshot(snapshot, None)
            .await
            .unwrap();
        assert!(viewed.task.unwrap().unseen);
        let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(stored.last_completed_at_ms, None);
        assert_eq!(stored.last_seen_activity_ms, None);
    }

    #[tokio::test]
    async fn canonical_snapshot_without_membership_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        let thread: crate::agent::codex::CodexThread = serde_json::from_value(
            task_thread_list("thread-unmanaged", root.path())["data"][0].clone(),
        )
        .expect("canonical thread");
        state
            .task_sessions
            .observe_thread_metadata(Conversation::from(&thread))
            .await;
        let snapshot = state
            .task_sessions
            .snapshot("thread-unmanaged")
            .await
            .expect("canonical snapshot");

        let error = state
            .detail
            .assemble_snapshot(snapshot, None)
            .await
            .expect_err("unmanaged canonical detail must not be exposed");

        assert!(matches!(
            error,
            ApiError::BadRequest {
                code: "task_not_managed",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn task_detail_returns_cached_metadata_before_slow_resume_finishes() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-slow-detail-bootstrap";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        cache_and_manage_test_thread(&state, thread_id, root.path()).await;

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_detail(state, thread_id.to_string(), None),
        )
        .await
        .expect("task detail must not await a slow thread/resume")
        .expect("cached task detail remains available");

        assert_eq!(response.0.thread_id, thread_id);
        assert_eq!(response.0.sync_state, TaskSyncState::Ready);
        assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);
        assert!(response.0.history_loading);
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn blank_history_cursor_returns_cached_task_detail_without_app_server_wait() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-blank-history-cursor";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;

        cache_and_manage_test_thread(&state, thread_id, root.path()).await;

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_detail(state, thread_id.to_string(), Some(String::new())),
        )
        .await
        .expect("a blank cursor must not wait for app-server pagination")
        .expect("cached task detail remains available");

        assert_eq!(response.0.thread_id, thread_id);
        assert_eq!(response.0.sync_state, TaskSyncState::Ready);
        assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);
        assert!(response.0.history_loading);
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn history_timeout_does_not_replace_cached_task_detail() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-history-timeout-cache";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "cwd": root.path().display().to_string(),
                    "thread": {
                        "id": thread_id,
                        "preview": "Cached task detail regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": "older-1",
                        "backwardsCursor": "latest-anchor"
                    }
                }),
            ),
            crate::agent::codex::MockCodexResponse::error(
                "thread/turns/list",
                crate::agent::codex::CodexThreadError::RequestTimeout {
                    method: "thread/turns/list",
                    request_id: 31,
                    timeout_ms: 120_000,
                },
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        state
            .task_store
            .update_display_name(thread_id, "Cached task detail regression")
            .unwrap();
        let _viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .expect("initial task subscription succeeds");

        let error = test_task_detail(
            state.clone(),
            thread_id.to_string(),
            Some("older-1".to_string()),
        )
        .await
        .expect_err("older history request should expose its timeout");
        assert!(matches!(
            error,
            ApiError::Timeout {
                code: "agent_timeout",
                ..
            }
        ));

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_detail(state, thread_id.to_string(), None),
        )
        .await
        .expect("cached task detail must not wait after a history timeout")
        .expect("cached task detail remains available");

        assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);
        assert_eq!(
            response.0.task.as_ref().unwrap().title,
            "Cached task detail regression"
        );
        assert_eq!(
            response.0.events_page.next_cursor.as_deref(),
            Some("older-1")
        );
        assert!(!response.0.history_loading);
    }

    #[tokio::test]
    async fn task_detail_returns_cached_metadata_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-busy-connection-detail";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread: crate::agent::codex::CodexThread =
            serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
                .expect("cached thread metadata");
        state
            .task_sessions
            .observe_thread_metadata(Conversation::from(&thread))
            .await;

        let runtime = state.task_runtime.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            runtime
                .hold_process_lock_for_test(locked_tx, Duration::from_millis(250))
                .await;
        });
        locked_rx.await.expect("runtime lock acquired");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_detail(state, thread_id.to_string(), None),
        )
        .await
        .expect("cached detail must not wait for app-server connection access")
        .expect("cached task detail remains available");

        assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn task_stream_starts_before_slow_resume_finishes() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-slow-stream-bootstrap";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_stream(state, thread_id.to_string()),
        )
        .await
        .expect("task stream must not await a slow thread/resume")
        .expect("task stream starts from cached metadata");

        assert_eq!(response.status(), StatusCode::OK);
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn task_stream_starts_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-busy-connection-stream";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread: crate::agent::codex::CodexThread =
            serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
                .expect("cached thread metadata");
        state
            .task_sessions
            .observe_thread_metadata(Conversation::from(&thread))
            .await;

        let runtime = state.task_runtime.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            runtime
                .hold_process_lock_for_test(locked_tx, Duration::from_millis(250))
                .await;
        });
        locked_rx.await.expect("runtime lock acquired");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_stream(state, thread_id.to_string()),
        )
        .await
        .expect("task stream must not wait for app-server connection access")
        .expect("task stream starts from cached metadata");

        assert_eq!(response.status(), StatusCode::OK);
        drop(response);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn direct_task_detail_returns_loading_snapshot_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-uncached-busy-detail";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let runtime = state.task_runtime.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            runtime
                .hold_process_lock_for_test(locked_tx, Duration::from_millis(250))
                .await;
        });
        locked_rx.await.expect("runtime lock acquired");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_detail(state, thread_id.to_string(), None),
        )
        .await
        .expect("direct task detail must not wait for app-server connection access")
        .expect("direct task detail starts with a loading snapshot");

        assert_eq!(response.0.thread_id, thread_id);
        assert_eq!(response.0.sync_state, TaskSyncState::Loading);
        assert!(response.0.task.is_none());
        assert!(response.0.history_loading);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn direct_task_stream_starts_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-uncached-busy-stream";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let runtime = state.task_runtime.clone();
        let (locked_tx, locked_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::spawn(async move {
            runtime
                .hold_process_lock_for_test(locked_tx, Duration::from_millis(250))
                .await;
        });
        locked_rx.await.expect("runtime lock acquired");

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_stream(state, thread_id.to_string()),
        )
        .await
        .expect("direct task stream must not wait for app-server connection access")
        .expect("direct task stream starts from a loading snapshot");

        assert_eq!(response.status(), StatusCode::OK);
        drop(response);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn resume_failure_makes_cached_task_detail_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-failed-detail-bootstrap";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::error(
            "thread/resume",
            crate::agent::codex::CodexThreadError::Protocol("resume unavailable".to_string()),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        cache_and_manage_test_thread(&state, thread_id, root.path()).await;

        let response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_detail(state.clone(), thread_id.to_string(), None),
        )
        .await
        .expect("task detail must not await a failed thread/resume")
        .expect("cached task detail remains available");
        assert_eq!(response.0.task.as_ref().unwrap().thread_id, thread_id);

        wait_for_mock_method(&client, "thread/resume").await;
        tokio::time::sleep(Duration::from_millis(20)).await;
        let snapshot = state
            .task_sessions
            .snapshot(thread_id)
            .await
            .expect("cached session remains tracked");
        assert!(snapshot.conversation.is_some());
        assert!(snapshot.last_error.is_some());
        let error = test_task_detail(state, thread_id.to_string(), None)
            .await
            .expect_err("stale task detail must not survive a canonical resume failure");
        assert!(matches!(error, ApiError::Agent(_)));
    }

    #[tokio::test]
    async fn unavailable_thread_refreshes_recovery_projection_without_removing_membership() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-unavailable-recovery-refresh";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::error(
            "thread/resume",
            crate::agent::codex::CodexThreadError::ThreadUnavailable(
                "Thread is archived in Codex".to_string(),
            ),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let refresh = tokio::spawn(crate::app::tasks::routes::test_wait_for_task_list_refresh(
            state.task_list_events.clone(),
        ));
        tokio::task::yield_now().await;

        let detail = test_task_detail(state.clone(), thread_id.to_string(), None)
            .await
            .expect("loading detail remains available");
        assert_eq!(detail.0.thread_id, thread_id);
        wait_for_mock_method(&client, "thread/resume").await;

        tokio::time::timeout(Duration::from_millis(100), refresh)
            .await
            .expect("Task list refresh event")
            .expect("refresh listener completes");
        assert!(
            test_store_get(&state, thread_id)
                .await
                .expect("managed membership read")
                .is_some(),
            "detail unavailability must not delete Caffold ownership"
        );
    }

    #[tokio::test]
    async fn resume_timeout_makes_task_detail_unavailable_but_keeps_the_connection() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-timeout-detail-bootstrap";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::error(
            "thread/resume",
            crate::agent::codex::CodexThreadError::RequestTimeout {
                method: "thread/resume",
                request_id: 17,
                timeout_ms: 120_000,
            },
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        cache_and_manage_test_thread(&state, thread_id, root.path()).await;

        let first = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_detail(state.clone(), thread_id.to_string(), None),
        )
        .await
        .expect("task detail must not await a timed-out thread/resume")
        .expect("cached task detail remains available");
        assert_eq!(first.0.task.as_ref().unwrap().thread_id, thread_id);
        assert!(first.0.history_loading);

        wait_for_mock_method(&client, "thread/resume").await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        let second = test_task_detail(state.clone(), thread_id.to_string(), None)
            .await
            .expect_err("task re-entry exposes the canonical source timeout");
        assert!(matches!(second, ApiError::Agent(_)));

        let snapshot = state
            .task_sessions
            .snapshot(thread_id)
            .await
            .expect("cached session remains tracked");
        assert!(snapshot.conversation.is_some());
        assert!(snapshot.last_error.is_some());
        assert_eq!(state.task_runtime.diagnostics().await, (1, true));
    }

    #[tokio::test]
    async fn app_server_recovery_does_not_block_on_leased_thread_restoration() {
        let sessions = TaskSessions::default();
        let first_client =
            CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "cwd": "/tmp",
                    "thread": {
                        "id": "thread-slow-recovery",
                        "preview": "Slow recovery regression",
                        "status": { "type": "idle" },
                        "cwd": "/tmp",
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            )]);
        let _viewer = sessions
            .acquire_viewer(&first_client.driver(), 1, "thread-slow-recovery")
            .await
            .expect("viewer");
        let _ = sessions
            .codex_connection_lost(1, "process exited".to_string())
            .await;

        let recovered_client =
            CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::delayed_ok(
                "thread/resume",
                json!({
                    "cwd": "/tmp",
                    "thread": {
                        "id": "thread-slow-recovery",
                        "preview": "Slow recovery regression",
                        "status": { "type": "idle" },
                        "cwd": "/tmp",
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
                Duration::from_millis(120),
            )]);
        let connection = CodexConnection {
            client: recovered_client.clone(),
            generation: 2,
        };
        let (shutdown, _) = broadcast::channel(1);
        let (claude, _runner) = crate::agent::claude::ClaudeClient::mock();
        let runtime = TaskRuntime::new(
            claude,
            sessions.clone(),
            TaskEvents::default(),
            TaskStore::memory().unwrap(),
            shutdown,
        );

        let started = tokio::time::Instant::now();
        runtime.restore_test_sessions(connection);
        assert!(
            started.elapsed() < Duration::from_millis(20),
            "connection acquisition must not await session restoration"
        );

        wait_for_mock_method(&recovered_client, "thread/resume").await;
        tokio::time::sleep(Duration::from_millis(140)).await;
        let snapshot = sessions
            .snapshot("thread-slow-recovery")
            .await
            .expect("recovered snapshot");
        assert_eq!(snapshot.generation, 2);
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
    }

    #[tokio::test]
    async fn task_detail_handler_releases_its_subscription_after_the_response() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-detail-handler";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "cwd": root.path().display().to_string(),
                    "thread": {
                        "id": thread_id,
                        "preview": "Handler lifecycle regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let before = test_store_get(&state, thread_id).await.unwrap().unwrap();

        let response = test_task_detail(state.clone(), thread_id.to_string(), None)
            .await
            .expect("task detail succeeds");

        assert_eq!(response.0.thread_id, thread_id);
        assert_eq!(response.0.sync_state, TaskSyncState::Loading);
        assert!(
            response.0.task.is_none(),
            "detail must stay empty until the canonical resume snapshot arrives"
        );
        wait_for_mock_method(&client, "thread/unsubscribe").await;
        assert_eq!(
            test_store_get(&state, thread_id).await.unwrap().unwrap(),
            before,
            "detail GET bootstrap must not persist canonical observations"
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume", "thread/unsubscribe"]
        );
    }

    #[tokio::test]
    async fn task_detail_and_stream_share_one_subscription_until_the_stream_closes() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-detail-stream-handler";
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::delayed_ok(
                "thread/resume",
                json!({
                    "cwd": root.path().display().to_string(),
                    "thread": {
                        "id": thread_id,
                        "preview": "Shared handler lifecycle regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
                Duration::from_millis(50),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let detail_state = state.clone();
        let detail = tokio::spawn(async move {
            test_task_detail(detail_state, thread_id.to_string(), None).await
        });
        let stream_state = state.clone();
        let stream =
            tokio::spawn(
                async move { test_task_stream(stream_state, thread_id.to_string()).await },
            );

        let detail_response = detail.await.unwrap().expect("task detail succeeds");
        let stream_response = stream.await.unwrap().expect("task stream succeeds");
        assert_eq!(detail_response.0.thread_id, thread_id);
        assert_eq!(detail_response.0.sync_state, TaskSyncState::Loading);
        assert!(
            detail_response.0.task.is_none(),
            "detail must stay empty until the canonical resume snapshot arrives"
        );

        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume"]
        );

        drop(stream_response);
        wait_for_mock_method(&client, "thread/unsubscribe").await;
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume", "thread/unsubscribe"]
        );
    }

    #[tokio::test]
    async fn task_stream_reopens_while_detail_unsubscribe_is_in_flight() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-detail-stream-reopen";
        let resume = || {
            json!({
                "cwd": root.path().display().to_string(),
                "thread": {
                    "id": thread_id,
                    "preview": "Reopen lifecycle regression",
                    "status": { "type": "idle" },
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                },
                "initialTurnsPage": {
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            })
        };
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok("thread/resume", resume()),
            crate::agent::codex::MockCodexResponse::delayed_ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
                Duration::from_millis(250),
            ),
            crate::agent::codex::MockCodexResponse::ok("thread/resume", resume()),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let _detail_response = test_task_detail(state.clone(), thread_id.to_string(), None)
            .await
            .expect("task detail succeeds");
        wait_for_mock_method(&client, "thread/unsubscribe").await;

        let stream_response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_stream(state.clone(), thread_id.to_string()),
        )
        .await
        .expect("task stream must not wait for the detail cleanup RPC")
        .expect("task stream succeeds");

        wait_for_mock_method_count(&client, "thread/resume", 2).await;
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/resume", "thread/unsubscribe", "thread/resume"]
        );

        tokio::time::sleep(Duration::from_millis(275)).await;
        let snapshot = state
            .task_sessions
            .snapshot(thread_id)
            .await
            .expect("thread session snapshot");
        assert_eq!(
            snapshot.lifecycle,
            crate::app::tasks::sessions::SessionLifecycle::Subscribed
        );
        assert_eq!(snapshot.viewer_leases, 1);

        drop(stream_response);
        wait_for_mock_method_count(&client, "thread/unsubscribe", 2).await;
    }

    #[test]
    fn task_stream_bootstrap_replays_the_canonical_detail_snapshot() {
        let thread_id = "thread-bootstrap";
        let assistant = task_event_record(
            thread_id,
            "turn-1:assistant-1",
            "assistant_message",
            "canonical assistant response",
            Some(json!({ "text": "canonical assistant response" })),
            2,
        );
        let sync = TaskDetailSync {
            thread_id: thread_id.to_string(),
            revision: 7,
            detail: TaskDetailResponse {
                provider: Some(TaskProvider::Codex),
                thread_id: thread_id.to_string(),
                sync_state: TaskSyncState::Ready,
                revision: 7,
                task: Some(TaskRecord {
                    id: thread_id.to_string(),
                    thread_id: thread_id.to_string(),
                    conversation_available: true,
                    title: "Bootstrap regression".to_string(),
                    preview: "canonical assistant response".to_string(),
                    thread_status: ThreadStatus::Idle,
                    latest_turn_status: Some(TurnStatus::Completed),
                    active_turn: None,
                    cwd: "/tmp".to_string(),
                    cwd_path: None,
                    relative_cwd: ".".to_string(),
                    worktree: None,
                    created_ms: 1,
                    updated_ms: 2,
                    recency_ms: None,
                    last_completed_ms: None,
                    last_event_summary: Some("canonical assistant response".to_string()),
                    unseen: false,
                }),
                events: vec![assistant],
                file_links: Vec::new(),
                events_page: TaskEventsPage { next_cursor: None },
                pending_approvals: Vec::new(),
                history_loading: false,
                permission_mode: Some("askForApproval".to_string()),
                model: Some("gpt-test".to_string()),
                reasoning_effort: Some("xhigh".to_string()),
                fast_mode: true,
                active_top_placement: None,
            },
            reason: "stream-bootstrap",
            error: None,
        };

        let frames = task_stream_initial_frames(&sync)
            .into_iter()
            .collect::<Vec<_>>();

        assert_eq!(frames[0], ": ready\n\n");
        assert_eq!(
            frames.len(),
            2,
            "the initial stream must replay canonical state"
        );
        assert!(frames[1].starts_with("event: task-sync\ndata: "));
        assert!(frames[1].contains("\"threadId\":\"thread-bootstrap\""));
        assert!(frames[1].contains("\"revision\":7"));
        assert!(frames[1].contains("\"type\":\"assistant_message\""));
        assert!(frames[1].contains("canonical assistant response"));
    }
}

#[cfg(test)]
mod sync_tests {
    use std::time::Duration;

    use serde_json::json;

    use super::super::{
        routes::{test_task_detail, test_task_stream},
        test_support::*,
    };
    use super::*;
    use crate::{
        agent::{codex, codex::CodexThreadClient},
        app::error::ApiError,
        fs::RootedFs,
    };

    #[tokio::test(start_paused = true)]
    async fn rollout_invalidation_never_synthesizes_thread_activity() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-rollout-path-after-resume";
        let rollout_path = root.path().join("rollout.jsonl");
        std::fs::write(&rollout_path, "").unwrap();
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "External running regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "path": rollout_path.display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({
                    "thread": {
                        "id": thread_id,
                        "preview": "External running regression",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "path": rollout_path.display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    }
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/turns/list",
                json!({
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let response = test_task_stream(state.clone(), thread_id.to_string())
            .await
            .expect("task stream succeeds");
        wait_for_mock_method(&client, "thread/resume").await;
        state
            .task_sync
            .observe_rollout_invalidation(thread_id.to_string());

        wait_for_mock_method(&client, "thread/read").await;
        let snapshot = state
            .task_sessions
            .snapshot(thread_id)
            .await
            .expect("thread session");

        drop(response);
        assert_eq!(
            snapshot.conversation.expect("canonical thread").status,
            crate::agent::ThreadStatus::Idle,
            "rollout contents only invalidate the canonical app-server snapshot"
        );
        assert_eq!(snapshot.active_turn_id, None);
    }

    #[tokio::test(start_paused = true)]
    async fn background_sync_timeout_broadcasts_error_and_rejects_stale_detail() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-background-sync-timeout";
        let client = CodexThreadClient::mock(vec![crate::agent::codex::MockCodexResponse::error(
            "thread/read",
            crate::agent::codex::CodexThreadError::RequestTimeout {
                method: "thread/read",
                request_id: 29,
                timeout_ms: 120_000,
            },
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread: crate::agent::codex::CodexThread =
            serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
                .expect("cached thread metadata");
        state
            .task_sessions
            .observe_thread_metadata(Conversation::from(&thread))
            .await;

        let _subscription = state.task_sync.subscribe(thread_id);
        let mut sync_events = state.task_sync.subscribe_updates();
        state.detail.ensure_sync_worker().await;
        state
            .task_sync
            .observe_rollout_invalidation(thread_id.to_string());

        wait_for_mock_method(&client, "thread/read").await;
        tokio::time::sleep(Duration::from_millis(20)).await;

        let sync = tokio::time::timeout(Duration::from_millis(50), sync_events.recv())
            .await
            .expect("a background timeout broadcasts unavailable state")
            .expect("task sync channel remains open");
        assert_eq!(sync.thread_id, thread_id);
        assert_eq!(sync.detail.sync_state, TaskSyncState::Loading);
        assert!(sync.detail.task.is_none());
        assert!(sync.error.is_some());

        let error = test_task_detail(state.clone(), thread_id.to_string(), None)
            .await
            .expect_err("stale detail is rejected after a background sync timeout");
        assert!(matches!(error, ApiError::Agent(_)));

        let snapshot = state
            .task_sessions
            .snapshot(thread_id)
            .await
            .expect("cached session remains tracked");
        assert!(snapshot.conversation.is_some());
        assert!(snapshot.last_error.is_some());
        assert_eq!(state.task_runtime.diagnostics().await, (1, true));
    }

    #[tokio::test]
    async fn external_thread_sync_reads_without_resuming_or_unsubscribing() {
        let idle_thread = json!({
            "id": "thread-external",
            "preview": "External task",
            "status": { "type": "idle" },
            "cwd": "Workspace/rust/codger",
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "turns": []
        });
        let client = CodexThreadClient::mock(vec![
            crate::agent::codex::MockCodexResponse::ok(
                "thread/read",
                json!({
                    "thread": idle_thread
                }),
            ),
            crate::agent::codex::MockCodexResponse::ok(
                "thread/turns/list",
                json!({
                    "data": [{
                        "id": "turn-external",
                        "status": "inProgress",
                        "items": [],
                        "error": null
                    }]
                }),
            ),
        ]);
        let (thread, turns) = tokio::try_join!(
            client.read_thread("thread-external"),
            client.list_thread_turns("thread-external", None, TASK_DETAIL_TURNS_PAGE_SIZE),
        )
        .unwrap();

        assert_eq!(thread.status, codex::ThreadStatus::Idle);
        assert_eq!(turns.data[0].status, codex::TurnStatus::InProgress);

        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, _)| method)
                .collect::<Vec<_>>(),
            ["thread/read", "thread/turns/list"]
        );
    }
}

#[cfg(test)]
mod serialization_tests {
    use serde_json::Value as JsonValue;

    use super::*;

    #[test]
    fn loading_detail_serializes_without_a_synthetic_task() {
        let detail = loading_detail("thread-loading", 7, None);
        let value = serde_json::to_value(detail).unwrap();
        assert_eq!(value["threadId"], "thread-loading");
        assert_eq!(value["syncState"], "loading");
        assert_eq!(value["task"], JsonValue::Null);
    }
}
