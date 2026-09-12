use std::{collections::HashSet, pin::Pin, sync::Arc};

use futures_util::{Stream, stream};
use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, broadcast};

mod file_links;

use file_links::{TaskFileLink, TaskFileLinkResolver};

use super::{
    events::{
        TaskEventPosition, TaskEventPublication, TaskEventRecord, TaskEvents, TaskHistoryCursor,
        TaskHistoryPage, compose_pending_approval_events, sort_task_events, task_event_turn_id,
    },
    lifecycle::ActiveTaskTopPlacement,
    projection::{
        TaskRecord, apply_turn_states_projection, resolve_conversation_cwd,
        task_record_from_conversation,
    },
    runtime::{CodexConnection, TaskAgent, TaskRuntime, TaskRuntimeSignal},
    sync::TaskSync,
    worktrees::inspect_ready_worktree,
};
use crate::agent::AgentError;
use crate::{
    agent::{
        Conversation,
        codex::{CodexThreadClient, CodexThreadError},
    },
    app::error::ApiError,
    app::tasks::sessions::{SessionSnapshot, TaskSessions, ViewerLease},
    fs::RootedFs,
    task_store::{ManagedThread, ManagedWorktreeState, TaskProvider, TaskStore, TaskStoreError},
};

pub(super) const TASK_DETAIL_TURNS_PAGE_SIZE: usize = 8;
/// The most events one Task Detail answer carries, whatever a turn holds.
pub(super) const TASK_DETAIL_EVENT_LIMIT: usize = 100;

type RefreshTaskList = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone)]
pub(in crate::app::tasks) struct DetailContext {
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
pub(in crate::app::tasks) struct TaskDetailResponse {
    pub(in crate::app::tasks) thread_id: String,
    pub(in crate::app::tasks) sync_state: TaskSyncState,
    pub(in crate::app::tasks) revision: u64,
    /// Publication watermark for the canonical conversation projection.
    pub(in crate::app::tasks) event_revision: u64,
    pub(in crate::app::tasks) task: Option<TaskRecord>,
    pub(in crate::app::tasks) events: Vec<TaskEventRecord>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(in crate::app::tasks) file_links: Vec<TaskFileLink>,
    pub(in crate::app::tasks) events_page: TaskEventsPage,
    /// The projection extent this answer owns; `None` owns only its events.
    pub(in crate::app::tasks) events_range: Option<TaskEventsRange>,
    pub(in crate::app::tasks) pending_approvals: Vec<TaskEventRecord>,
    pub(in crate::app::tasks) history_loading: bool,
    /// Which agent runs this Task, when this answer knows.
    ///
    /// The composer reads it to offer that agent's models and permission modes
    /// and not another's. An error broadcast does not read the store, so it says
    /// nothing here rather than naming an agent it did not look up. Such an
    /// answer carries no Task either, and a Task nobody can read is one nobody
    /// can prompt — so no surface reads this while it is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app::tasks) provider: Option<TaskProvider>,
    pub(in crate::app::tasks) permission_mode: Option<String>,
    pub(in crate::app::tasks) model: Option<String>,
    pub(in crate::app::tasks) reasoning_effort: Option<String>,
    pub(in crate::app::tasks) fast_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app::tasks) active_top_placement: Option<ActiveTaskTopPlacement>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) enum TaskSyncState {
    Loading,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) struct TaskEventsPage {
    pub(in crate::app::tasks) next_cursor: Option<String>,
}

/// Inclusive backend positions; an open end is `None`.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) struct TaskEventsRange {
    pub(in crate::app::tasks) from: Option<TaskEventPosition>,
    pub(in crate::app::tasks) to: Option<TaskEventPosition>,
}

/// Where an older-history request continues, in Caffold's own terms.
///
/// `turns` names the app-server page the events belong to and is absent for
/// the page the session already holds; `before` is the position the events
/// must precede and is absent for the page's newest events. The browser only
/// hands the encoded value back.
pub(in crate::app::tasks) type TaskDetailCursor = TaskHistoryCursor;

impl TaskDetailCursor {
    /// A cursor this version did not write is an app-server turn cursor a
    /// browser kept across a replacement.
    fn decode(cursor: &str) -> Self {
        serde_json::from_str(cursor).unwrap_or_else(|_| Self {
            turns: Some(cursor.to_string()),
            ..Self::default()
        })
    }

    fn encode(&self) -> String {
        serde_json::to_string(self).expect("a detail cursor holds only serializable fields")
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskDetailSync {
    pub(in crate::app::tasks) thread_id: String,
    pub(in crate::app::tasks) revision: u64,
    pub(in crate::app::tasks) detail: TaskDetailResponse,
    pub(in crate::app::tasks) reason: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app::tasks) error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskEventEnvelope {
    thread_id: String,
    /// Exact revision captured when this delta entered the Task projection.
    event_revision: u64,
    /// Transitional session revision retained until the frontend consumes the
    /// independent conversation-projection sequence.
    revision: u64,
    event: TaskEventRecord,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    file_links: Vec<TaskFileLink>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", content = "payload")]
pub(in crate::app) enum DetailLiveEvent {
    #[serde(rename = "task-sync")]
    Sync(Box<TaskDetailSync>),
    #[serde(rename = "task-event")]
    Event(Box<TaskEventEnvelope>),
}

pub(in crate::app) type DetailLiveStream = Pin<Box<dyn Stream<Item = DetailLiveEvent> + Send>>;

impl DetailContext {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::app::tasks) fn new(
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

    pub(in crate::app::tasks) async fn client(&self) -> Result<CodexThreadClient, ApiError> {
        self.ensure_runtime_signal_driver().await;
        self.runtime.client().await.map_err(ApiError::from)
    }

    pub(in crate::app::tasks) async fn connection(
        &self,
    ) -> Result<CodexConnection, CodexThreadError> {
        self.ensure_runtime_signal_driver().await;
        self.runtime.connection().await
    }

    /// The agent that owns this Task, ready to be asked about it.
    pub(in crate::app::tasks) async fn agent(
        &self,
        thread_id: &str,
    ) -> Result<TaskAgent, AgentError> {
        self.ensure_runtime_signal_driver().await;
        self.runtime.task_agent(thread_id).await
    }

    pub(in crate::app::tasks) async fn get(
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

    pub(in crate::app::tasks) async fn stream(
        &self,
        thread_id: &str,
    ) -> Result<DetailLiveStream, ApiError> {
        self.restore_managed_fast_mode(thread_id).await?;
        let receiver = self.events.subscribe();
        let sync_receiver = self.sync.subscribe_updates();
        let viewer = self.sessions.reserve_viewer(thread_id).await;
        let (detail, baseline_revision) = self.cached(thread_id).await?;
        let file_link_task_root = detail.task.as_ref().map(file_links::task_root);
        let initial = DetailLiveEvent::Sync(Box::new(TaskDetailSync {
            thread_id: thread_id.to_string(),
            revision: detail.revision,
            detail,
            reason: "stream-bootstrap",
            error: None,
        }));
        let context = self.clone();
        let bootstrap_thread_id = thread_id.to_string();
        tokio::spawn(async move {
            context
                .bootstrap(&bootstrap_thread_id, baseline_revision)
                .await;
        });
        let state = DetailStream {
            initial: Some(initial),
            events: receiver,
            sync: sync_receiver,
            shutdown: self.shutdown.subscribe(),
            thread_id: thread_id.to_string(),
            _viewer: viewer,
            context: self.clone(),
            file_link_task_root,
        };
        Ok(Box::pin(stream::unfold(state, |mut state| async move {
            state.next().await.map(|event| (event, state))
        })))
    }

    pub(in crate::app::tasks) async fn read(
        &self,
        agent: &TaskAgent,
        thread_id: &str,
        cursor: Option<&str>,
    ) -> Result<TaskDetailResponse, ApiError> {
        self.restore_managed_fast_mode(thread_id).await?;
        let cursor = cursor.map(TaskDetailCursor::decode).unwrap_or_default();
        let mut snapshot = self
            .sessions
            .load_metadata(&agent.driver(), agent.generation(), thread_id)
            .await?;
        let older = cursor != TaskDetailCursor::default();
        let request = older.then(|| self.events.begin_history_request(thread_id));
        let response_page = match self.events.cached_history_page(thread_id, &cursor) {
            Some(page) => Some(page),
            None if older => {
                let (current, page) = self
                    .sessions
                    .load_history_page(
                        &agent.driver(),
                        agent.generation(),
                        thread_id,
                        &cursor,
                        TASK_DETAIL_TURNS_PAGE_SIZE,
                    )
                    .await?;
                snapshot = current;
                Some(page)
            }
            // A latest-page cache miss does not authorize a new baseline read.
            // Subscription owns that read; retained live evidence stays usable.
            None => None,
        };
        if let Some(page) = &response_page {
            if let Some(id) = &cursor.item_id
                && !page
                    .events
                    .iter()
                    .any(|event| &event.id == id && Some(event.position) == cursor.before)
            {
                self.events.trim(thread_id);
                return Err(ApiError::Agent(
                    "conversation history continuation is no longer available".to_string(),
                ));
            }
            if let Some(request) = request {
                let (window, _, next) =
                    window_detail_events(page.events.clone(), None, &cursor, page.next.clone());
                let pin = next
                    .as_deref()
                    .map(TaskDetailCursor::decode)
                    .and_then(|next| next.turn_id)
                    .filter(|id| {
                        page.events
                            .iter()
                            .any(|event| task_event_turn_id(event) == Some(id))
                    })
                    .or_else(|| {
                        window
                            .iter()
                            .find_map(task_event_turn_id)
                            .map(str::to_string)
                    });
                self.events
                    .finish_history_request(thread_id, request, pin.as_deref());
            }
        }
        self.events.trim(thread_id);
        self.assemble_snapshot(snapshot, response_page, cursor)
            .await
    }

    pub(in crate::app::tasks) async fn cached(
        &self,
        thread_id: &str,
    ) -> Result<(TaskDetailResponse, u64), ApiError> {
        let stored = self.store_get(thread_id).await?;
        let Some(snapshot) = self.sessions.snapshot(thread_id).await else {
            return Ok((loading_detail(thread_id, 0, stored.as_ref()), 0));
        };
        if let Some(error) = snapshot.last_error.as_ref() {
            return Err(ApiError::Agent(format!(
                "canonical task state is unavailable: {error}"
            )));
        }
        let revision = snapshot.revision;
        if snapshot.conversation.is_none() {
            return Ok((
                loading_detail(thread_id, revision, stored.as_ref()),
                revision,
            ));
        }
        let detail = self
            .assemble_snapshot(snapshot, None, TaskDetailCursor::default())
            .await?;
        Ok((detail, revision))
    }

    pub(in crate::app::tasks) async fn bootstrap(&self, thread_id: &str, baseline_revision: u64) {
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

    pub(in crate::app::tasks) async fn assemble_snapshot(
        &self,
        snapshot: SessionSnapshot,
        response_page: Option<TaskHistoryPage>,
        cursor: TaskDetailCursor,
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
        let older_page =
            cursor.turns.is_some() || cursor.before.is_some() || cursor.turn_id.is_some();
        let page = response_page.or_else(|| self.events.cached_history_page(&thread_id, &cursor));
        let history_loading = snapshot.turns_page.is_none();
        let event_revision = page.as_ref().map(|page| page.revision).unwrap_or_default();
        let older_turns = page.as_ref().and_then(|page| page.next.clone());
        let owns_extent = page.as_ref().is_some_and(|page| page.owns_extent);
        let mut events = page.map(|page| page.events).unwrap_or_default();
        let owned_extent = (owns_extent && !history_loading && (!older_page || !events.is_empty()))
            .then(|| history_extent(&events, older_page));
        let conversation = snapshot
            .conversation
            .expect("conversation metadata was checked above");
        let conversation = self.project_managed_worktree_cwd(conversation)?;
        let pending_approvals = self.runtime.approval_events(&thread_id).await;
        events = compose_pending_approval_events(events, pending_approvals.clone());
        sort_task_events(&mut events);
        let resolved_cwd = resolve_conversation_cwd(&self.fs, &conversation);
        let mut task = task_record_from_conversation(&conversation, &events, resolved_cwd.as_ref());
        let turn_states = snapshot
            .turns_page
            .as_ref()
            .map(|page| page.turns.iter().rev().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        apply_turn_states_projection(&mut task, &turn_states);
        let (mut events, events_range, next_cursor) =
            window_detail_events(events, owned_extent, &cursor, older_turns);
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
                event_revision,
                task: Some(task),
                events,
                file_links,
                events_page: TaskEventsPage { next_cursor },
                events_range,
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

    pub(in crate::app::tasks) fn record_from_conversation(
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

    async fn broadcast_snapshot(
        &self,
        thread_id: &str,
        snapshot: SessionSnapshot,
        reason: &'static str,
    ) {
        let Ok(detail) = self
            .assemble_snapshot(snapshot, None, TaskDetailCursor::default())
            .await
        else {
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
pub(in crate::app::tasks) fn project_managed_worktree_cwd(
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

pub(in crate::app::tasks) fn loading_detail(
    thread_id: &str,
    revision: u64,
    managed: Option<&ManagedThread>,
) -> TaskDetailResponse {
    TaskDetailResponse {
        thread_id: thread_id.to_string(),
        sync_state: TaskSyncState::Loading,
        revision,
        // A loading/error answer carries no conversation events, so it cannot
        // claim to cover retained deltas that a later readable snapshot will
        // include.
        event_revision: 0,
        task: None,
        events: Vec::new(),
        file_links: Vec::new(),
        events_page: TaskEventsPage { next_cursor: None },
        events_range: None,
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

/// A viewer keeps its provider lease while repairing lost delivery. Both
/// receivers are attached before capturing the replacement cache snapshot.
struct DetailStream {
    initial: Option<DetailLiveEvent>,
    events: broadcast::Receiver<TaskEventPublication>,
    sync: broadcast::Receiver<TaskDetailSync>,
    shutdown: broadcast::Receiver<()>,
    thread_id: String,
    _viewer: ViewerLease,
    context: DetailContext,
    file_link_task_root: Option<String>,
}

enum DetailDelivery {
    Sync(Box<TaskDetailSync>),
    Event(Box<TaskEventPublication>),
}

impl DetailStream {
    async fn next(&mut self) -> Option<DetailLiveEvent> {
        if let Some(initial) = self.initial.take() {
            return Some(initial);
        }
        loop {
            let message = tokio::select! {
                _ = self.shutdown.recv() => return None,
                message = self.sync.recv() => message.map(|sync| DetailDelivery::Sync(Box::new(sync))),
                message = self.events.recv() => message.map(|event| DetailDelivery::Event(Box::new(event))),
            };
            match message {
                Ok(DetailDelivery::Sync(sync)) if sync.thread_id == self.thread_id => {
                    self.file_link_task_root = sync
                        .detail
                        .task
                        .as_ref()
                        .map(file_links::task_root)
                        .or(self.file_link_task_root.take());
                    return Some(DetailLiveEvent::Sync(sync));
                }
                Ok(DetailDelivery::Event(publication))
                    if publication.event.thread_id == self.thread_id =>
                {
                    let revision = self
                        .context
                        .sessions
                        .snapshot(&self.thread_id)
                        .await
                        .map(|snapshot| snapshot.revision)
                        .unwrap_or_default();
                    let (event, file_links) = match self.file_link_task_root.as_deref() {
                        Some(root) => {
                            self.context
                                .file_links
                                .project_event(root, &publication.event)
                                .await
                        }
                        None => (publication.event, Vec::new()),
                    };
                    return Some(DetailLiveEvent::Event(Box::new(TaskEventEnvelope {
                        thread_id: self.thread_id.clone(),
                        event_revision: publication.revision,
                        revision,
                        event,
                        file_links,
                    })));
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    self.events = self.context.events.subscribe();
                    self.sync = self.context.sync.subscribe_updates();
                    let (detail, _) = self.context.cached(&self.thread_id).await.ok()?;
                    self.file_link_task_root = detail.task.as_ref().map(file_links::task_root);
                    return Some(DetailLiveEvent::Sync(Box::new(TaskDetailSync {
                        thread_id: self.thread_id.clone(),
                        revision: detail.revision,
                        detail,
                        reason: "stream-recovery",
                        error: None,
                    })));
                }
            }
        }
    }
}

/// The extent a provider-history page would own: its own events, and
/// everything after them when it is the current page.
fn history_extent(history: &[TaskEventRecord], older_page: bool) -> TaskEventsRange {
    let mut positions = history.iter().map(|event| event.position);
    let Some(first) = positions.next() else {
        return TaskEventsRange {
            from: None,
            to: None,
        };
    };
    let (from, to) = positions.fold((first, first), |(from, to), position| {
        (min_position(from, position), max_position(to, position))
    });
    TaskEventsRange {
        from: Some(from),
        to: older_page.then_some(to),
    }
}

/// The slice of a page one answer carries, and where the next one continues.
///
/// A cursor with `before` keeps only the events ahead of that position, so
/// the answer owns exactly the span it contains. When the newest events still
/// leave earlier ones behind, the next cursor continues within this page;
/// otherwise it moves on to the older app-server turns, if any.
fn window_detail_events(
    events: Vec<TaskEventRecord>,
    extent: Option<TaskEventsRange>,
    cursor: &TaskDetailCursor,
    older_turns: Option<TaskDetailCursor>,
) -> (
    Vec<TaskEventRecord>,
    Option<TaskEventsRange>,
    Option<String>,
) {
    let (events, extent) = match cursor.before {
        Some(before) => {
            let events = events
                .into_iter()
                .filter(|event| {
                    (event.position.anchor_ms, event.position.index)
                        < (before.anchor_ms, before.index)
                })
                .collect::<Vec<_>>();
            let to = events.last().map(|event| event.position);
            let extent = to.and_then(|to| {
                extent.map(|extent| TaskEventsRange {
                    from: extent.from,
                    to: Some(to),
                })
            });
            (events, extent)
        }
        None => (events, extent),
    };
    let (events, range, cut_at) = bound_detail_events(events, extent);
    let next_cursor = match cut_at {
        Some(before) => Some(TaskDetailCursor {
            turns: cursor.turns.clone(),
            before: Some(before),
            turn_id: events
                .iter()
                .find(|event| event.position == before)
                .and_then(task_event_turn_id)
                .map(str::to_string),
            item_id: events
                .iter()
                .find(|event| event.position == before)
                .map(|event| event.id.clone()),
        }),
        None => older_turns,
    }
    .map(|cursor| cursor.encode());
    (events, range, next_cursor)
}

/// Keep the newest `TASK_DETAIL_EVENT_LIMIT` events plus the turn boundaries
/// they belong to. The owned extent starts at the first kept event, so the
/// boundary events ahead of it are identity updates rather than membership.
/// The position of the first kept event comes back when something was cut.
fn bound_detail_events(
    mut events: Vec<TaskEventRecord>,
    extent: Option<TaskEventsRange>,
) -> (
    Vec<TaskEventRecord>,
    Option<TaskEventsRange>,
    Option<TaskEventPosition>,
) {
    if events.len() <= TASK_DETAIL_EVENT_LIMIT {
        return (events, extent, None);
    }
    let tail = events.split_off(events.len() - TASK_DETAIL_EVENT_LIMIT);
    let kept_turns = tail
        .iter()
        .filter_map(task_event_turn_id)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let from = tail.first().map(|event| event.position);
    let mut bounded = events
        .into_iter()
        .filter(|event| {
            matches!(event.event_type.as_str(), "turn_started" | "user_message")
                && task_event_turn_id(event).is_some_and(|turn_id| kept_turns.contains(turn_id))
        })
        .collect::<Vec<_>>();
    bounded.extend(tail);
    let range = extent.map(|extent| TaskEventsRange {
        from,
        to: extent.to,
    });
    (bounded, range, from)
}

fn min_position(left: TaskEventPosition, right: TaskEventPosition) -> TaskEventPosition {
    if (right.anchor_ms, right.index) < (left.anchor_ms, left.index) {
        right
    } else {
        left
    }
}

fn max_position(left: TaskEventPosition, right: TaskEventPosition) -> TaskEventPosition {
    if (right.anchor_ms, right.index) > (left.anchor_ms, left.index) {
        right
    } else {
        left
    }
}

pub(in crate::app::tasks) fn not_managed_error() -> ApiError {
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
    use crate::agent::codex::CodexThread;
    use crate::app::tasks::events::task_event_record;
    use crate::git;
    use serde_json::json;

    use super::*;
    use crate::task_store::{CheckoutAnchor, ManagedWorktree};

    /// A conversation whose only interesting field is where it says it is
    /// running, which is what the managed-worktree projection replaces.
    fn codex_thread(cwd: &str) -> Conversation {
        let thread: CodexThread = serde_json::from_value(json!({
            "id": "thread-1",
            "cwd": cwd,
            "status": { "type": "idle" },
        }))
        .expect("the fixture decodes as a Codex thread");
        Conversation::from(&thread)
    }

    fn positioned_event(turn_id: &str, event_type: &str, anchor_ms: u64) -> TaskEventRecord {
        task_event_record(
            "thread-1",
            &format!("{turn_id}:{event_type}:{anchor_ms}"),
            event_type,
            event_type,
            Some(json!({ "turnId": turn_id })),
            anchor_ms,
        )
    }

    #[test]
    fn a_current_page_owns_its_first_event_onward_and_an_older_page_owns_its_span() {
        let history = vec![
            positioned_event("turn-1", "turn_started", 10),
            positioned_event("turn-1", "command_execution", 20),
            positioned_event("turn-2", "turn_started", 30),
        ];

        let current = history_extent(&history, false);
        let older = history_extent(&history, true);

        assert_eq!(current.from, Some(TaskEventPosition::at(10)));
        assert_eq!(current.to, None);
        assert_eq!(older.from, Some(TaskEventPosition::at(10)));
        assert_eq!(older.to, Some(TaskEventPosition::at(30)));
        assert_eq!(
            history_extent(&[], false),
            TaskEventsRange {
                from: None,
                to: None
            }
        );
    }

    #[test]
    fn events_within_the_limit_pass_through_with_their_extent() {
        let events = vec![
            positioned_event("turn-1", "turn_started", 10),
            positioned_event("turn-1", "command_execution", 20),
        ];
        let extent = Some(history_extent(&events, false));

        let (bounded, range, cut_at) = bound_detail_events(events.clone(), extent);

        assert_eq!(bounded, events);
        assert_eq!(range, extent);
        assert_eq!(cut_at, None);
    }

    #[test]
    fn events_over_the_limit_keep_the_newest_and_the_boundaries_of_their_turns() {
        let mut events = vec![
            positioned_event("turn-1", "turn_started", 1),
            positioned_event("turn-1", "user_message", 2),
            positioned_event("turn-1", "command_execution", 3),
            positioned_event("turn-2", "turn_started", 10),
            positioned_event("turn-2", "user_message", 11),
        ];
        for offset in 0..TASK_DETAIL_EVENT_LIMIT as u64 + 5 {
            events.push(positioned_event(
                "turn-2",
                "command_execution",
                100 + offset,
            ));
        }
        let extent = Some(history_extent(&events, false));

        let (bounded, range, cut_at) = bound_detail_events(events.clone(), extent);

        let first_kept = &events[events.len() - TASK_DETAIL_EVENT_LIMIT];
        assert_eq!(cut_at, Some(first_kept.position));
        assert_eq!(bounded.len(), TASK_DETAIL_EVENT_LIMIT + 2);
        assert_eq!(bounded[0].event_type, "turn_started");
        assert_eq!(bounded[1].event_type, "user_message");
        assert!(
            bounded[..2]
                .iter()
                .all(|event| task_event_turn_id(event) == Some("turn-2"))
        );
        assert_eq!(bounded[2], *first_kept);
        assert_eq!(bounded.last(), events.last());
        assert!(
            bounded
                .iter()
                .all(|event| task_event_turn_id(event) != Some("turn-1")),
            "a turn with no kept events contributes no boundary"
        );
        assert_eq!(
            range,
            Some(TaskEventsRange {
                from: Some(first_kept.position),
                to: None
            })
        );
    }

    #[test]
    fn a_bounded_answer_without_history_declares_no_extent() {
        let events = (0..TASK_DETAIL_EVENT_LIMIT as u64 + 1)
            .map(|offset| positioned_event("turn-1", "command_execution", offset))
            .collect::<Vec<_>>();

        let (bounded, range, cut_at) = bound_detail_events(events, None);

        assert_eq!(bounded.len(), TASK_DETAIL_EVENT_LIMIT);
        assert_eq!(range, None);
        assert!(cut_at.is_some());
    }

    #[test]
    fn a_detail_cursor_round_trips_and_wraps_an_app_server_cursor() {
        let within = TaskDetailCursor {
            turns: None,
            before: Some(TaskEventPosition::at(7)),
            ..TaskDetailCursor::default()
        };
        let older = TaskDetailCursor {
            turns: Some("older-1".to_string()),
            before: None,
            ..TaskDetailCursor::default()
        };
        let app_server = r#"{"turnId":"turn-1","includeAnchor":false}"#;

        assert_eq!(TaskDetailCursor::decode(&within.encode()), within);
        assert_eq!(TaskDetailCursor::decode(&older.encode()), older);
        assert_eq!(
            TaskDetailCursor::decode(app_server),
            TaskDetailCursor {
                turns: Some(app_server.to_string()),
                before: None,
                ..TaskDetailCursor::default()
            }
        );
    }

    #[test]
    fn a_page_is_walked_back_within_the_session_before_moving_to_older_turns() {
        let mut events = vec![
            positioned_event("turn-1", "turn_started", 1),
            positioned_event("turn-1", "user_message", 2),
        ];
        for anchor_ms in 3..=450 {
            events.push(positioned_event("turn-1", "command_execution", anchor_ms));
        }
        let extent = Some(history_extent(&events, false));
        let older = Some(TaskDetailCursor {
            turns: Some("older-1".to_string()),
            ..TaskDetailCursor::default()
        });
        let at = TaskEventPosition::at;
        let limit = TASK_DETAIL_EVENT_LIMIT as u64;

        let mut cursor = TaskDetailCursor::default();
        let mut pages = Vec::new();
        let final_cursor = loop {
            let (page, range, next) =
                window_detail_events(events.clone(), extent, &cursor, older.clone());
            pages.push((page, range));
            let next = TaskDetailCursor::decode(&next.expect("a cursor always follows"));
            if next.before.is_none() {
                break next;
            }
            cursor = next;
        };

        let expected_pages = (events.len() - 1) / TASK_DETAIL_EVENT_LIMIT + 1;
        assert_eq!(pages.len(), expected_pages);
        for (index, (page, range)) in pages[..pages.len() - 1].iter().enumerate() {
            let newest = 450 - index as u64 * limit;
            let oldest = newest + 1 - limit;
            assert_eq!(page.len(), TASK_DETAIL_EVENT_LIMIT + 2);
            assert_eq!(
                *range,
                Some(TaskEventsRange {
                    from: Some(at(oldest)),
                    to: (index > 0).then_some(at(newest)),
                })
            );
        }
        let remainder = 450 - (expected_pages as u64 - 1) * limit;
        let (last_page, last_range) = pages.last().expect("pages");
        assert_eq!(last_page.len(), remainder as usize);
        assert_eq!(
            *last_range,
            Some(TaskEventsRange {
                from: Some(at(1)),
                to: Some(at(remainder))
            })
        );
        assert_eq!(
            final_cursor,
            TaskDetailCursor {
                turns: Some("older-1".to_string()),
                before: None,
                ..TaskDetailCursor::default()
            }
        );
        let covered = pages
            .into_iter()
            .flat_map(|(page, _)| page.into_iter().map(|event| event.id))
            .collect::<HashSet<_>>();
        assert_eq!(covered.len(), events.len());
    }

    #[test]
    fn ready_branch_switch_projects_live_git_context_without_persisting_the_observation() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        initialize_repository(&source);
        let managed = temp.path().join("managed");
        let checkout =
            git::create_attached_worktree(&source, &managed, "caffold/review", None).unwrap();
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
        let repository = git::managed_repository(&source).unwrap();
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
    use crate::agent::TurnPage;
    use crate::agent::codex::{CodexThread, MockCodexResponse, TurnsPage};
    use std::time::Duration;

    use futures_util::StreamExt;
    use serde_json::json;
    use tokio::sync::broadcast;

    use super::super::{
        CodexConnection, TaskRuntime, TaskState,
        events::*,
        projection::*,
        routes::{
            test_store_get, test_store_update_composer_settings, test_task_detail,
            test_task_stream, test_wait_for_task_list_refresh,
        },
        test_support::*,
    };
    use super::*;
    use crate::{
        agent::{
            self, ThreadStatus, TurnStatus, codex,
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
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
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
            .expect("Task event channel remains open")
            .event;
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
        state.task_events.publish_local(task_event_record(
            thread_id,
            "retained-before-session",
            "assistant_message",
            "Retained before the session is readable",
            None,
            1,
        ));
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
        assert_eq!(
            detail.event_revision, 0,
            "a loading response cannot cover retained events it does not include"
        );
        assert!(detail.history_loading);
        assert!(detail.events_range.is_none());
        assert_eq!(detail.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(detail.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(detail.fast_mode);
    }

    #[tokio::test]
    async fn canonical_resume_refreshes_cached_model_settings() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-canonical-model-settings";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
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
            .assemble_snapshot(snapshot, None, TaskDetailCursor::default())
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
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
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
        let thread: CodexThread = serde_json::from_value(json!({
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
        let turns_page: TurnsPage = serde_json::from_value(json!({
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
        let mut snapshot = SessionSnapshot {
            lifecycle: SessionLifecycle::Subscribed,
            conversation: Some(Conversation::from(&thread)),
            turns_page: Some(crate::app::tasks::sessions::SessionTurnPage::from(
                &TurnPage::from(&turns_page),
            )),
            active_turn_id: None,
            active_turn_cwd: None,
            viewer_leases: 0,
            runtime_lease: false,
            generation: 1,
            revision: 1,
            history_base_revision: Some(0),
            last_sync_ms: Some(5_000),
            last_error: None,
            permission_mode: None,
            model: None,
            reasoning_effort: None,
            fast_mode: false,
        };

        state.task_events.accept_history_page(
            snapshot.conversation.as_ref().unwrap(),
            &TurnPage::from(&turns_page),
            0,
            None,
        );
        let background = state
            .detail
            .assemble_snapshot(snapshot.clone(), None, TaskDetailCursor::default())
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
            .assemble_snapshot(snapshot, None, TaskDetailCursor::default())
            .await
            .unwrap();
        assert!(viewed.task.unwrap().unseen);
        let stored = test_store_get(&state, thread_id).await.unwrap().unwrap();
        assert_eq!(stored.last_completed_at_ms, None);
        assert_eq!(stored.last_seen_activity_ms, None);
    }

    #[tokio::test]
    async fn detail_history_repositions_a_late_live_projection_without_losing_its_payload() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-history-position";
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread: CodexThread = serde_json::from_value(json!({
            "id": thread_id,
            "preview": "History position",
            "status": { "type": "idle" },
            "cwd": root.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 3.0,
            "turns": []
        }))
        .unwrap();
        let turns_page: TurnsPage = serde_json::from_value(json!({
            "data": [{
                "id": "turn-1",
                "status": "completed",
                "startedAt": 1.0,
                "completedAt": 3.0,
                "items": [
                    {
                        "type": "userMessage",
                        "id": "provider-user-1",
                        "clientId": "message-1",
                        "content": [{ "type": "input_text", "text": "Test the ordering" }]
                    },
                    {
                        "type": "agentMessage",
                        "id": "answer-1",
                        "phase": "final",
                        "text": "The answer"
                    }
                ]
            }],
            "nextCursor": null,
            "backwardsCursor": null
        }))
        .unwrap();
        let snapshot = SessionSnapshot {
            lifecycle: SessionLifecycle::Subscribed,
            conversation: Some(Conversation::from(&thread)),
            turns_page: Some(crate::app::tasks::sessions::SessionTurnPage::from(
                &TurnPage::from(&turns_page),
            )),
            active_turn_id: None,
            active_turn_cwd: None,
            viewer_leases: 1,
            runtime_lease: false,
            generation: 1,
            revision: 1,
            history_base_revision: Some(0),
            last_sync_ms: Some(3_000),
            last_error: None,
            permission_mode: None,
            model: None,
            reasoning_effort: None,
            fast_mode: false,
        };
        let mut late_live_prompt = task_event_record(
            thread_id,
            "turn-1:message-1",
            "user_message",
            "User prompt accepted",
            Some(json!({
                "threadId": thread_id,
                "turnId": "turn-1",
                "itemId": "message-1",
                "text": "Test the ordering",
                "liveDelivery": "accepted"
            })),
            2_500,
        );
        late_live_prompt.position.index = 0;
        let live_publication = state
            .task_events
            .publish_accepted_submission(late_live_prompt, None);

        state.task_events.accept_history_page(
            snapshot.conversation.as_ref().unwrap(),
            &TurnPage::from(&turns_page),
            0,
            None,
        );
        let detail = state
            .detail
            .assemble_snapshot(snapshot, None, TaskDetailCursor::default())
            .await
            .unwrap();
        assert!(
            detail.event_revision > live_publication.revision,
            "the Detail watermark must cover every live event it includes"
        );
        let messages = detail
            .events
            .iter()
            .filter(|event| {
                matches!(
                    event.event_type.as_str(),
                    "user_message" | "assistant_message"
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            messages
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            vec!["user_message", "assistant_message"]
        );
        assert_eq!(messages[0].position.anchor_ms, 1_000);
        assert_eq!(messages[0].position.index, 1);
        assert!(
            serde_json::to_value(messages[0])
                .expect("serialize reconciled prompt")
                .get("updatedMs")
                .is_none()
        );
        assert_eq!(
            messages[0].payload.as_ref().unwrap()["liveDelivery"],
            "accepted"
        );
    }

    #[tokio::test]
    async fn canonical_snapshot_without_membership_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        let thread: CodexThread = serde_json::from_value(
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
            .assemble_snapshot(snapshot, None, TaskDetailCursor::default())
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
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
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
        assert!(response.0.events_range.is_none());
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn blank_history_cursor_returns_cached_task_detail_without_app_server_wait() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-blank-history-cursor";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
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
        assert!(response.0.events_range.is_none());
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn history_timeout_does_not_replace_cached_task_detail() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-history-timeout-cache";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
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
            MockCodexResponse::error(
                "thread/turns/list",
                CodexThreadError::RequestTimeout {
                    method: "thread/turns/list",
                    request_id: 31,
                    timeout_ms: 120_000,
                },
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
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
            TaskDetailCursor::decode(response.0.events_page.next_cursor.as_deref().unwrap()),
            TaskDetailCursor {
                turns: Some("older-1".to_string()),
                before: None,
                ..TaskDetailCursor::default()
            }
        );
        assert!(!response.0.history_loading);
        assert_eq!(
            response.0.events_range,
            Some(TaskEventsRange {
                from: None,
                to: None
            }),
            "a current page with no history yet owns the whole projection"
        );
    }

    fn long_turn(turn_id: &str, items: usize) -> serde_json::Value {
        let mut turn_items = vec![json!({
            "id": format!("{turn_id}-prompt"),
            "type": "userMessage",
            "content": [{ "type": "text", "text": "Run the long turn" }]
        })];
        turn_items.extend((1..items).map(|index| {
            json!({
                "id": format!("{turn_id}-step-{index}"),
                "type": "agentMessage",
                "text": format!("Step {index}"),
                "phase": "final"
            })
        }));
        json!({
            "id": turn_id,
            "items": turn_items,
            "itemsView": "full",
            "status": "completed",
            "startedAt": 1.0,
            "completedAt": 2.0
        })
    }

    async fn walk_history(state: &TaskState, thread_id: &str) -> Vec<TaskDetailResponse> {
        let mut pages = Vec::new();
        let mut cursor = None;
        loop {
            let response = test_task_detail(state.clone(), thread_id.to_string(), cursor)
                .await
                .expect("history page loads")
                .0;
            cursor = response.events_page.next_cursor.clone();
            pages.push(response);
            if cursor.is_none() || pages.len() > 10 {
                return pages;
            }
        }
    }

    #[tokio::test]
    async fn a_long_current_turn_is_paged_from_the_session_without_the_app_server() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-long-current-turn";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "cwd": root.path().display().to_string(),
                    "thread": {
                        "id": thread_id,
                        "preview": "Long current turn",
                        "status": { "type": "idle" },
                        "cwd": root.path().display().to_string(),
                        "createdAt": 1.0,
                        "updatedAt": 2.0,
                        "turns": []
                    },
                    "initialTurnsPage": {
                        "data": [long_turn("turn-long", 450)],
                        "nextCursor": null,
                        "backwardsCursor": null
                    }
                }),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let _viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .expect("initial task subscription succeeds");

        let pages = walk_history(&state, thread_id).await;

        // turn_started, the prompt, 449 steps, and turn_completed: 452 events,
        // every answer but the last carrying the limit plus the two boundaries.
        let total: usize = 452;
        let expected_pages = total.div_ceil(TASK_DETAIL_EVENT_LIMIT);
        assert_eq!(pages.len(), expected_pages);
        assert!(
            pages[..expected_pages - 1]
                .iter()
                .all(|page| page.events.len() == TASK_DETAIL_EVENT_LIMIT + 2)
        );
        let last = pages.last().unwrap();
        assert_eq!(
            last.events.len(),
            total - (expected_pages - 1) * TASK_DETAIL_EVENT_LIMIT
        );
        let covered = pages
            .iter()
            .flat_map(|page| page.events.iter().map(|event| event.id.clone()))
            .collect::<HashSet<_>>();
        assert_eq!(covered.len(), total);
        assert!(
            pages[0]
                .events_range
                .is_some_and(|range| range.to.is_none())
        );
        assert!(
            pages[1]
                .events_range
                .is_some_and(|range| range.from.is_some() && range.to.is_some())
        );
        assert_eq!(last.events[0].event_type, "turn_started");
        assert!(last.events_page.next_cursor.is_none());
        assert_eq!(
            client
                .mock_requests()
                .await
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            ["thread/resume"],
            "walking the held page never asks the app-server"
        );
    }

    #[tokio::test]
    async fn evicted_turns_resume_from_the_same_provider_page_without_skipping_a_gap() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-evicted-page";
        let turns = (0..8)
            .map(|index| {
                let mut turn = long_turn(&format!("turn-{index}"), 70);
                turn["startedAt"] = json!((8 - index) * 10);
                turn["completedAt"] = json!((8 - index) * 10 + 1);
                turn
            })
            .collect::<Vec<_>>();
        let provider_page = json!({"data": turns, "nextCursor": null, "backwardsCursor": null});
        let mut responses = vec![MockCodexResponse::ok(
            "thread/resume",
            json!({
                "cwd": root.path().display().to_string(),
                "thread": {
                    "id": thread_id, "preview": "Evicted turns", "status": {"type": "idle"},
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0, "updatedAt": 81.0, "turns": []
                },
                "initialTurnsPage": provider_page.clone()
            }),
        )];
        responses.extend(
            (0..8).map(|_| MockCodexResponse::ok("thread/turns/list", provider_page.clone())),
        );
        let client = CodexThreadClient::mock(responses);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let _viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .unwrap();

        let mut cursor = None;
        let mut covered = HashSet::new();
        let mut pages = 0;
        loop {
            let before_calls = client.mock_requests().await.len();
            let page = test_task_detail(state.clone(), thread_id.into(), cursor)
                .await
                .unwrap()
                .0;
            let after_calls = client.mock_requests().await.len();
            assert!(
                after_calls - before_calls <= 1,
                "one explicit page request never fills by scanning"
            );
            if pages == 0 {
                assert_eq!(
                    page.events.len(),
                    72,
                    "the first missing retained turn ends the window"
                );
                assert_eq!(
                    after_calls, 1,
                    "the short latest response does not fill from history"
                );
                let next =
                    TaskDetailCursor::decode(page.events_page.next_cursor.as_deref().unwrap());
                assert_eq!(next.turn_id.as_deref(), Some("turn-1"));
                assert_eq!(
                    next.turns, None,
                    "the missing turn belongs to this same native page"
                );
            }
            covered.extend(page.events.into_iter().map(|event| event.id));
            cursor = page.events_page.next_cursor;
            pages += 1;
            assert!(pages <= 10, "continuations must advance");
            if cursor.is_none() {
                break;
            }
        }
        assert_eq!(
            covered.len(),
            8 * 72,
            "all eight turns, items and boundaries are still readable"
        );
        let requests = client.mock_requests().await;
        assert!(requests.len() > 1, "eviction was exercised");
        for (method, params) in &requests[1..] {
            assert_eq!(method, "thread/turns/list");
            assert_eq!(params["limit"], 8);
            assert!(params["cursor"].is_null());
        }
    }

    #[tokio::test]
    async fn an_unmatched_history_boundary_ends_only_that_request_without_rereading() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-unmatched-boundary";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            json!({
                "cwd": root.path().display().to_string(),
                "thread": {
                    "id": thread_id, "preview": "History identity", "status": {"type": "idle"},
                    "cwd": root.path().display().to_string(),
                    "createdAt": 1.0, "updatedAt": 2.0, "turns": []
                },
                "initialTurnsPage": {
                    "data": [long_turn("turn-long", 150)],
                    "nextCursor": null, "backwardsCursor": null
                }
            }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let _viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .unwrap();
        let before = test_task_detail(state.clone(), thread_id.into(), None)
            .await
            .unwrap()
            .0;
        let mut cursor =
            TaskDetailCursor::decode(before.events_page.next_cursor.as_deref().unwrap());
        // Legacy history may name a different item at the same apparent position.
        // Position is not evidence that the native live ID means that history item.
        cursor.item_id = Some("unmatched-native-live-id".into());
        let error = test_task_detail(state.clone(), thread_id.into(), Some(cursor.encode()))
            .await
            .unwrap_err();
        assert!(matches!(error, ApiError::Agent(ref message)
            if message == "conversation history continuation is no longer available"));
        let after = test_task_detail(state, thread_id.into(), None)
            .await
            .unwrap()
            .0;
        assert_eq!(after.events, before.events);
        assert_eq!(
            after.events_page.next_cursor,
            before.events_page.next_cursor
        );
        assert_eq!(
            client.mock_requests().await.len(),
            1,
            "only the initial resume reads history"
        );
    }

    #[tokio::test]
    async fn a_long_older_turn_reuses_its_cached_items_for_every_slice() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-long-older-turn";
        let older_page = json!({
            "data": [long_turn("turn-older", 250)],
            "nextCursor": null,
            "backwardsCursor": null
        });
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "cwd": root.path().display().to_string(),
                    "thread": {
                        "id": thread_id,
                        "preview": "Long older turn",
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
            MockCodexResponse::ok("thread/turns/list", older_page),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let _viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .expect("initial task subscription succeeds");

        let pages = walk_history(&state, thread_id).await;

        // The current page is empty and hands over to the older turn, whose
        // 252 events take one answer per limit-sized slice.
        let total: usize = 252;
        let slices = total.div_ceil(TASK_DETAIL_EVENT_LIMIT);
        assert_eq!(pages.len(), 1 + slices);
        assert_eq!(pages[0].events.len(), 0);
        assert!(
            pages[1..slices]
                .iter()
                .all(|page| page.events.len() == TASK_DETAIL_EVENT_LIMIT + 2)
        );
        assert_eq!(
            pages[slices].events.len(),
            total - (slices - 1) * TASK_DETAIL_EVENT_LIMIT
        );
        assert_eq!(
            TaskDetailCursor::decode(pages[1].events_page.next_cursor.as_deref().unwrap()).turns,
            Some("older-1".to_string()),
            "the earlier part of an older turn names the page it belongs to"
        );
        assert!(pages[slices].events_page.next_cursor.is_none());
        let turns_list_calls = client
            .mock_requests()
            .await
            .iter()
            .filter(|(method, _)| method == "thread/turns/list")
            .count();
        assert_eq!(
            turns_list_calls, 1,
            "all slices of the retained turn share one provider read"
        );
    }

    #[tokio::test]
    async fn an_older_history_page_owns_only_the_span_of_its_turns() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-older-page-extent";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                json!({
                    "cwd": root.path().display().to_string(),
                    "thread": {
                        "id": thread_id,
                        "preview": "Older page extent",
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
            MockCodexResponse::ok(
                "thread/turns/list",
                json!({
                    "data": [{
                        "id": "turn-older",
                        "items": [
                            {
                                "id": "message-older",
                                "type": "userMessage",
                                "content": [{ "type": "text", "text": "The older prompt" }]
                            },
                            {
                                "id": "answer-older",
                                "type": "agentMessage",
                                "text": "The older answer",
                                "phase": "final"
                            }
                        ],
                        "itemsView": "full",
                        "status": "completed",
                        "startedAt": 1.0,
                        "completedAt": 1.5
                    }],
                    "nextCursor": null,
                    "backwardsCursor": null
                }),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let _viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .expect("initial task subscription succeeds");

        let response = test_task_detail(state, thread_id.to_string(), Some("older-1".to_string()))
            .await
            .expect("older history page loads");

        let range = response
            .0
            .events_range
            .expect("an older page declares its span");
        let first = response.0.events.first().expect("older page events");
        let last = response.0.events.last().expect("older page events");
        assert_eq!(range.from, Some(first.position));
        assert_eq!(range.to, Some(last.position));
        assert!(!response.0.history_loading);
    }

    #[tokio::test]
    async fn task_detail_returns_cached_metadata_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-busy-connection-detail";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/resume", resumed_task(thread_id, root.path())),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread: CodexThread =
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
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resumed_task(thread_id, root.path()),
                Duration::from_millis(250),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;

        let mut response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_stream(state, thread_id.to_string()),
        )
        .await
        .expect("task stream must not await a slow thread/resume")
        .expect("task stream starts from cached metadata");

        assert!(matches!(
            response.next().await,
            Some(DetailLiveEvent::Sync(sync)) if sync.reason == "stream-bootstrap"
        ));
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn task_stream_starts_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-busy-connection-stream";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/resume", resumed_task(thread_id, root.path())),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let thread: CodexThread =
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

        let mut response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_stream(state, thread_id.to_string()),
        )
        .await
        .expect("task stream must not wait for app-server connection access")
        .expect("task stream starts from cached metadata");

        assert!(matches!(
            response.next().await,
            Some(DetailLiveEvent::Sync(sync)) if sync.reason == "stream-bootstrap"
        ));
        drop(response);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn direct_task_detail_returns_loading_snapshot_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-uncached-busy-detail";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/resume", resumed_task(thread_id, root.path())),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
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
        assert!(response.0.events_range.is_none());
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn direct_task_stream_starts_while_connection_is_busy() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-uncached-busy-stream";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/resume", resumed_task(thread_id, root.path())),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
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

        let mut response = tokio::time::timeout(
            Duration::from_millis(50),
            test_task_stream(state, thread_id.to_string()),
        )
        .await
        .expect("direct task stream must not wait for app-server connection access")
        .expect("direct task stream starts from a loading snapshot");

        assert!(matches!(
            response.next().await,
            Some(DetailLiveEvent::Sync(sync)) if sync.reason == "stream-bootstrap"
        ));
        drop(response);
        blocker.await.expect("runtime blocker completes");
        wait_for_mock_method(&client, "thread/resume").await;
    }

    #[tokio::test]
    async fn resume_failure_makes_cached_task_detail_unavailable() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-failed-detail-bootstrap";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "thread/resume",
            CodexThreadError::Protocol("resume unavailable".to_string()),
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
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "thread/resume",
            CodexThreadError::ThreadUnavailable("Thread is archived in Codex".to_string()),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let refresh = tokio::spawn(test_wait_for_task_list_refresh(
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
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "thread/resume",
            CodexThreadError::RequestTimeout {
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
        assert!(first.0.events_range.is_none());

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
        let first_client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
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

        let recovered_client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
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
        let (claude, _runner) = agent::claude::ClaudeClient::mock();
        let runtime = TaskRuntime::new(
            claude,
            agent::grok::GrokClient::unreachable(),
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
            MockCodexResponse::ok(
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
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
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
            MockCodexResponse::delayed_ok(
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
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
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
            MockCodexResponse::ok("thread/resume", resume()),
            MockCodexResponse::delayed_ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
                Duration::from_millis(250),
            ),
            MockCodexResponse::ok("thread/resume", resume()),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
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
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
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
                event_revision: 11,
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
                events_range: Some(TaskEventsRange {
                    from: None,
                    to: None,
                }),
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

        let event = serde_json::to_value(DetailLiveEvent::Sync(Box::new(sync))).unwrap();

        assert_eq!(event["type"], "task-sync");
        assert_eq!(event["payload"]["threadId"], "thread-bootstrap");
        assert_eq!(event["payload"]["revision"], 7);
        assert_eq!(
            event["payload"]["detail"]["events"][0]["type"],
            "assistant_message"
        );
        assert_eq!(
            event["payload"]["detail"]["events"][0]["summary"],
            "canonical assistant response"
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
        assert_eq!(value["eventRevision"], 0);
        assert_eq!(value["task"], JsonValue::Null);
        assert_eq!(value["eventsRange"], JsonValue::Null);
    }
}

#[cfg(test)]
mod continuity_tests {
    use std::time::Duration;

    use axum::{body::Body, http::Request};
    use futures_util::StreamExt;
    use serde_json::json;
    use tower::ServiceExt;

    use super::{DetailLiveEvent, TaskDetailSync, loading_detail};
    use crate::{
        agent::{
            TurnPage,
            codex::{CodexThreadClient, MockCodexResponse, TurnsPage},
        },
        app::tasks::{
            TaskLiveSource, TaskState,
            events::task_event_record,
            test_support::{manage_test_thread, resumed_task, task_state_with_codex_client},
        },
        fs::RootedFs,
        watch::WatchHub,
    };

    #[derive(Clone, Copy)]
    enum Overflow {
        Events,
        Snapshots,
    }

    // No socket timing or provider process is involved. Stop polling one actual
    // Detail stream, overrun exactly one broadcast receiver with other Tasks'
    // traffic, and then resume it. The shared cache still knows the missing turn.
    async fn assert_lag_recovers_in_place(overflow: Overflow) {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-slow-viewer";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resumed_task(thread_id, root.path()),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        let viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .unwrap();
        let mut slow = state.detail.stream(thread_id).await.unwrap();
        assert!(matches!(
            slow.next().await,
            Some(DetailLiveEvent::Sync(sync)) if sync.reason == "stream-bootstrap"
        ));

        let snapshot = state.task_sessions.snapshot(thread_id).await.unwrap();
        let conversation = snapshot.conversation.as_ref().unwrap();
        let missing = task_event_record(
            thread_id,
            "turn-2:answer",
            "assistant_message",
            "Answer for turn 2",
            Some(json!({
                "turnId": "turn-2", "itemId": "answer-2",
                "text": "Answer for turn 2", "phase": "final"
            })),
            2_000,
        );
        match overflow {
            Overflow::Events => {
                state.task_events.publish_provider_lifecycle(missing, 2);
                // TaskEvents' shared queue holds 256 publications. An unrelated
                // busy Task can overrun a slow receiver even for a short turn.
                for index in 0..512 {
                    state.task_events.publish_provider_lifecycle(
                        task_event_record(
                            "other-task",
                            &format!("noise-{index}"),
                            "reasoning",
                            "Other task activity",
                            None,
                            2_001 + index,
                        ),
                        3 + index,
                    );
                }
            }
            Overflow::Snapshots => {
                // Canonical history can discover an unseen turn without replaying
                // its live deltas. Only its full Detail publication is queued.
                let page: TurnsPage = serde_json::from_value(json!({
                    "data": [{
                        "id": "turn-2", "status": "completed",
                        "startedAt": 2.0, "completedAt": 3.0,
                        "items": [{
                            "type": "agentMessage", "id": "answer-2",
                            "text": "Answer for turn 2", "phase": "final_answer"
                        }]
                    }],
                    "nextCursor": null, "backwardsCursor": null
                }))
                .unwrap();
                state.task_events.accept_history_page(
                    conversation,
                    &TurnPage::from(&page),
                    snapshot.revision,
                    None,
                );
                let (detail, _) = state.detail.cached(thread_id).await.unwrap();
                assert!(detail.events.iter().any(|event| {
                    event
                        .payload
                        .as_ref()
                        .is_some_and(|payload| payload["turnId"] == "turn-2")
                }));
                state.task_sync.publish(TaskDetailSync {
                    thread_id: thread_id.into(),
                    revision: detail.revision,
                    detail,
                    reason: "app-server-notification",
                    error: None,
                });
                // TaskSync's shared queue holds 64 snapshots.
                for revision in 1..=128 {
                    state.task_sync.publish(TaskDetailSync {
                        thread_id: "other-task".into(),
                        revision,
                        detail: loading_detail("other-task", revision, None),
                        reason: "app-server-notification",
                        error: None,
                    });
                }
            }
        }

        // Release the setup demand: the stalled stream is the only viewer.
        drop(viewer);
        tokio::time::timeout(Duration::from_secs(1), async {
            while state
                .task_sessions
                .snapshot(thread_id)
                .await
                .unwrap()
                .viewer_leases
                != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        let recovery = tokio::time::timeout(Duration::from_secs(1), slow.next())
            .await
            .expect("lag recovery must not hang");
        let Some(DetailLiveEvent::Sync(sync)) = recovery else {
            panic!("lag recovery must retain the viewer and deliver a cached snapshot");
        };
        assert_eq!(sync.reason, "stream-recovery");
        assert_missing_turn(&sync);
        assert_eq!(
            state
                .task_sessions
                .snapshot(thread_id)
                .await
                .unwrap()
                .viewer_leases,
            1
        );

        // The replacement receivers remain subscribed after snapshot capture.
        state.task_events.publish_provider_lifecycle(
            task_event_record(
                "other-task",
                "ignored",
                "reasoning",
                "Other task",
                None,
                3_900,
            ),
            599,
        );
        state.task_events.publish_provider_lifecycle(
            task_event_record(
                thread_id,
                "turn-3:answer",
                "assistant_message",
                "Answer for turn 3",
                Some(json!({
                    "turnId": "turn-3", "itemId": "answer-3",
                    "text": "Answer for turn 3", "phase": "final"
                })),
                4_000,
            ),
            600,
        );
        let follow_up = tokio::time::timeout(Duration::from_secs(1), slow.next())
            .await
            .expect("the same stream must keep delivering events");
        assert!(matches!(follow_up, Some(DetailLiveEvent::Event(event))
            if event.event.id == format!("{thread_id}:turn-3:answer")));
        let (detail, _) = state.detail.cached(thread_id).await.unwrap();
        state.task_sync.publish(TaskDetailSync {
            thread_id: thread_id.into(),
            revision: detail.revision,
            detail,
            reason: "app-server-notification",
            error: None,
        });
        let normal_sync = tokio::time::timeout(Duration::from_secs(1), slow.next())
            .await
            .unwrap();
        assert!(matches!(normal_sync, Some(DetailLiveEvent::Sync(sync))
            if sync.reason == "app-server-notification"));
        assert_no_history_reread(&client).await;
    }

    fn assert_missing_turn(sync: &TaskDetailSync) {
        assert!(
            sync.detail.events.iter().any(|event| {
                event
                    .payload
                    .as_ref()
                    .is_some_and(|payload| payload["turnId"] == "turn-2")
            }),
            "lag recovery must include the missing turn"
        );
    }

    async fn assert_no_history_reread(client: &CodexThreadClient) {
        let requests = client.mock_requests().await;
        assert_eq!(
            requests
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            ["thread/resume"],
            "a viewer gap with retained server history must not repeat thread/resume or call thread/turns/list"
        );
    }

    async fn assert_cached_reconnect(state: &TaskState, thread_id: &str) {
        let mut stream = state.detail.stream(thread_id).await.unwrap();
        let Some(DetailLiveEvent::Sync(bootstrap)) = stream.next().await else {
            panic!("a replacement viewer must receive a bootstrap");
        };
        assert_eq!(bootstrap.reason, "stream-bootstrap");
        assert_missing_turn(&bootstrap);
        // Await the canonical bootstrap path too: checking just the first cached
        // frame would miss an unnecessary provider read in its background work.
        state.detail.bootstrap(thread_id, bootstrap.revision).await;
    }

    #[tokio::test]
    async fn event_queue_overflow_recovers_the_only_viewer_in_place() {
        assert_lag_recovers_in_place(Overflow::Events).await;
    }

    #[tokio::test]
    async fn snapshot_queue_overflow_recovers_the_only_viewer_in_place() {
        assert_lag_recovers_in_place(Overflow::Snapshots).await;
    }

    #[tokio::test]
    async fn reconnecting_viewers_reuse_retained_history_without_provider_reads() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-cached-reconnect";
        let mut resume = resumed_task(thread_id, root.path());
        resume["initialTurnsPage"]["data"] = json!([{
            "id": "turn-2", "status": "completed",
            "startedAt": 2.0, "completedAt": 3.0,
            "items": [{
                "type": "agentMessage", "id": "answer-2",
                "text": "Answer for turn 2", "phase": "final_answer"
            }]
        }]);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok("thread/resume", resume)]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, thread_id, root.path()).await;
        // Another device keeps the provider subscription alive while this viewer
        // repeatedly reconnects. Only the browser's delivery lifetime changes.
        let _other_viewer = state
            .task_sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .unwrap();
        for _ in 0..3 {
            assert_cached_reconnect(&state, thread_id).await;
            assert_no_history_reread(&client).await;
        }
    }

    #[tokio::test]
    async fn detail_eof_notifies_the_live_gateway_without_closing_it() {
        assert_gateway_delivery(false).await;
    }

    #[tokio::test]
    async fn lag_recovery_and_follow_up_cross_the_same_http_gateway() {
        assert_gateway_delivery(true).await;
    }

    async fn assert_gateway_delivery(recover: bool) {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-detail-eof";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
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
            .unwrap();
        // Give the real gateway its own lifetime so ending the Task source cannot
        // accidentally pass by shutting down the entire physical connection.
        let (gateway_shutdown, _) = tokio::sync::broadcast::channel(1);
        let app = crate::app::live_updates::router(
            TaskLiveSource::new(&state),
            WatchHub::new(state.fs.clone(), gateway_shutdown.clone()),
            gateway_shutdown.clone(),
        );
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let mut frames = Box::pin(response.into_body().into_data_stream().filter_map(
            |frame| async move {
                let frame = frame.unwrap();
                let text = std::str::from_utf8(&frame).unwrap();
                text.lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .map(|data| serde_json::from_str::<serde_json::Value>(data).unwrap())
            },
        ));
        let ready = frames.next().await.unwrap();
        let connection_id = ready["connectionId"].as_str().unwrap();
        let accepted = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/live/{connection_id}/subscriptions"))
                    .header("host", "localhost:5178")
                    .header("origin", "http://localhost:5178")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "controlRevision": 1, "taskList": null,
                            "taskDetail": {"generation": 7, "threadId": thread_id},
                            "watches": []
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), axum::http::StatusCode::NO_CONTENT);
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let frame = frames.next().await.expect("gateway remains open");
                if frame["type"] == "task-sync" && frame["payload"]["reason"] == "stream-bootstrap"
                {
                    break;
                }
            }
        })
        .await
        .expect("the real gateway must forward the initial bootstrap");

        if recover {
            // No await in this burst: on the current-thread test runtime the
            // actual gateway producer cannot drain its receiver before overflow.
            state.task_events.publish_provider_lifecycle(task_event_record(
                thread_id, "turn-2:answer", "assistant_message", "Answer for turn 2",
                Some(json!({"turnId": "turn-2", "itemId": "answer-2", "text": "Answer for turn 2"})), 2_000,
            ), 2);
            for index in 0..512 {
                state.task_events.publish_provider_lifecycle(
                    task_event_record(
                        "other-task",
                        &format!("noise-{index}"),
                        "reasoning",
                        "noise",
                        None,
                        3_000 + index,
                    ),
                    3 + index,
                );
            }
            tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    let frame = frames.next().await.expect("gateway remains open");
                    if frame["type"] == "task-sync"
                        && frame["payload"]["reason"] == "stream-recovery"
                    {
                        assert_eq!(frame["generation"], 7);
                        assert!(
                            frame["payload"]["detail"]["events"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .any(|event| event["payload"]["turnId"] == "turn-2")
                        );
                        break;
                    }
                }
            })
            .await
            .expect("cached recovery must cross the actual HTTP body");
            state.task_events.publish_provider_lifecycle(task_event_record(
                thread_id, "turn-3:answer", "assistant_message", "Answer for turn 3",
                Some(json!({"turnId": "turn-3", "itemId": "answer-3", "text": "Answer for turn 3"})), 4_000,
            ), 600);
            tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    let frame = frames.next().await.expect("same gateway remains open");
                    if frame["type"] == "task-event" {
                        assert_eq!(frame["generation"], 7);
                        assert_eq!(frame["payload"]["event"]["payload"]["turnId"], "turn-3");
                        break;
                    }
                }
            })
            .await
            .expect("follow-up must use the recovered channel");
            assert_no_history_reread(&client).await;
            return;
        }

        state.shutdown.send(()).unwrap();
        let error = tokio::time::timeout(Duration::from_secs(1), frames.next())
            .await
            .expect(
                "Detail EOF was hidden by the live gateway; the browser received no retry signal",
            )
            .expect("Detail EOF must leave the shared physical gateway available");
        assert_eq!(error["channel"], "task-detail");
        assert_eq!(error["generation"], 7);
        assert_eq!(error["type"], "channel-error");
        assert_no_history_reread(&client).await;
    }
}
