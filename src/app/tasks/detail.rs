use std::{collections::VecDeque, convert::Infallible, pin::Pin, sync::Arc};

use futures_util::{Stream, stream};
use serde::Serialize;
use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc};

use super::{
    events::{
        TaskEventRecord, TaskEvents, merge_task_event_records, sort_task_events, thread_events,
    },
    projection::{
        TaskRecord, apply_canonical_turn_projection, resolve_thread_cwd, task_activity_ms,
        task_record_from_thread, thread_with_turns,
    },
    runtime::{CodexConnection, CodexRuntime, CodexRuntimeSignal},
    sync::{DeferredTaskRolloutSubscription, TaskSync, TaskSyncJob, TaskSyncOutcome},
};
use crate::{
    app::error::ApiError,
    codex_app_server::{CodexPermissionMode, CodexThreadClient, CodexThreadError, TurnsPage},
    codex_thread_sessions::{CodexThreadSessions, ThreadSessionSnapshot},
    fs::RootedFs,
    thread_store::{ManagedThread, ThreadStore, ThreadStoreError},
};

pub(super) const TASK_DETAIL_TURNS_PAGE_SIZE: usize = 8;

type RemoveManagedTask = Arc<dyn Fn(&str, &'static str) + Send + Sync>;

#[derive(Clone)]
pub(in crate::app) struct DetailContext {
    fs: Arc<RootedFs>,
    store: ThreadStore,
    runtime: CodexRuntime,
    runtime_signals: Arc<AsyncMutex<Option<broadcast::Receiver<CodexRuntimeSignal>>>>,
    sessions: CodexThreadSessions,
    events: TaskEvents,
    sync: TaskSync<TaskDetailSync>,
    shutdown: broadcast::Sender<()>,
    remove_managed_task: RemoveManagedTask,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskDetailResponse {
    pub(in crate::app) thread_id: String,
    pub(in crate::app) sync_state: TaskSyncState,
    pub(in crate::app) revision: u64,
    pub(in crate::app) task: Option<TaskRecord>,
    pub(in crate::app) events: Vec<TaskEventRecord>,
    pub(in crate::app) events_page: TaskEventsPage,
    pub(in crate::app) pending_approvals: Vec<TaskEventRecord>,
    pub(in crate::app) history_loading: bool,
    pub(in crate::app) permission_mode: Option<CodexPermissionMode>,
    pub(in crate::app) model: Option<String>,
    pub(in crate::app) reasoning_effort: Option<String>,
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
        store: ThreadStore,
        runtime: CodexRuntime,
        runtime_signals: broadcast::Receiver<CodexRuntimeSignal>,
        sessions: CodexThreadSessions,
        events: TaskEvents,
        sync: TaskSync<TaskDetailSync>,
        shutdown: broadcast::Sender<()>,
        remove_managed_task: impl Fn(&str, &'static str) + Send + Sync + 'static,
    ) -> Self {
        Self {
            fs,
            store,
            runtime,
            runtime_signals: Arc::new(AsyncMutex::new(Some(runtime_signals))),
            sessions,
            events,
            sync,
            shutdown,
            remove_managed_task: Arc::new(remove_managed_task),
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

    pub(in crate::app) async fn get(
        &self,
        thread_id: &str,
        cursor: Option<&str>,
    ) -> Result<TaskDetailResponse, ApiError> {
        let cursor = cursor.map(str::trim).filter(|cursor| !cursor.is_empty());
        if self.store_get(thread_id).await?.is_none() {
            return Err(not_managed_error());
        }
        if let Some(cursor) = cursor {
            let connection = self.connection().await?;
            let _viewer = self
                .sessions
                .acquire_viewer(&connection.client, connection.generation, thread_id)
                .await?;
            return self.read(&connection, thread_id, Some(cursor)).await;
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
        if self.store_get(thread_id).await?.is_none() {
            return Err(not_managed_error());
        }
        let receiver = self.events.subscribe();
        let sync_receiver = self.sync.subscribe_updates();
        let viewer = self.sessions.reserve_viewer(thread_id).await;
        let snapshot = self.sessions.snapshot(thread_id).await;
        let rollout_path = snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.thread.as_ref())
            .and_then(|thread| thread.path.clone());
        let (detail, baseline_revision) = self.cached(thread_id).await?;
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
                .and_then(|snapshot| snapshot.thread)
                .and_then(|thread| thread.path);
            bootstrap_rollout_subscription.install_with(|| {
                bootstrap_context
                    .sync
                    .subscribe_rollout(&bootstrap_thread_id, rollout_path.as_deref())
            });
        });

        let shutdown = self.shutdown.subscribe();
        let sessions = self.sessions.clone();
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
                        ),
                    ));
                }
                loop {
                    tokio::select! {
                        _ = shutdown.recv() => return None,
                        message = sync_receiver.recv() => {
                            match message {
                                Ok(sync) if sync.thread_id == thread_id => {
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
                                    let payload = serde_json::to_string(
                                        &TaskEventEnvelope {
                                            thread_id: thread_id.clone(),
                                            revision,
                                            event,
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
        connection: &CodexConnection,
        thread_id: &str,
        cursor: Option<&str>,
    ) -> Result<TaskDetailResponse, ApiError> {
        let (snapshot, response_page) = if let Some(cursor) = cursor {
            let (snapshot, page) = self
                .sessions
                .load_older_turns(
                    &connection.client,
                    connection.generation,
                    thread_id,
                    cursor,
                    TASK_DETAIL_TURNS_PAGE_SIZE,
                )
                .await?;
            (snapshot, Some(page))
        } else {
            (
                self.sessions
                    .load_metadata(&connection.client, connection.generation, thread_id)
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
            return Err(ApiError::CodexThread(format!(
                "canonical Codex task state is unavailable: {error}"
            )));
        }
        let revision = snapshot.revision;
        if snapshot.thread.is_none() {
            return Ok((
                loading_detail(thread_id, revision, stored.as_ref()),
                revision,
            ));
        }
        let detail = self.assemble_snapshot(snapshot, None).await?;
        Ok((detail, revision))
    }

    pub(in crate::app) async fn bootstrap(&self, thread_id: &str, baseline_revision: u64) {
        let connection = match self.connection().await {
            Ok(connection) => connection,
            Err(error) => {
                self.sessions.fail_external_sync(thread_id, &error).await;
                self.broadcast_error(thread_id, error.to_string()).await;
                return;
            }
        };
        let snapshot = match self
            .sessions
            .ensure_subscribed(&connection.client, connection.generation, thread_id)
            .await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.sessions.fail_external_sync(thread_id, &error).await;
                self.broadcast_error(thread_id, error.to_string()).await;
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
        snapshot: ThreadSessionSnapshot,
        response_page: Option<TurnsPage>,
    ) -> Result<TaskDetailResponse, ApiError> {
        let actively_viewed = snapshot.viewer_leases > 0;
        let revision = snapshot.revision;
        let permission_mode = snapshot.permission_mode;
        let session_model = snapshot.model.clone();
        let session_reasoning_effort = snapshot.reasoning_effort.clone();
        let thread_id = snapshot
            .thread
            .as_ref()
            .map(|thread| thread.id.clone())
            .ok_or_else(|| {
                ApiError::CodexThread("subscribed thread metadata is missing".to_string())
            })?;
        let page = response_page.or_else(|| snapshot.turns_page.clone());
        let history_loading = page.is_none();
        let mut turns = page
            .as_ref()
            .map(|page| page.data.clone())
            .unwrap_or_default()
            .into_iter()
            .map(|turn| serde_json::to_value(turn).expect("decoded turn serializes"))
            .collect::<Vec<_>>();
        turns.reverse();
        let next_cursor = page.and_then(|page| page.next_cursor);
        let thread = snapshot
            .thread
            .expect("thread metadata was checked above")
            .into_value();
        let thread = thread_with_turns(&thread, turns)?;
        let mut events = thread_events(&thread);
        self.events.observe(&events);
        events = merge_task_event_records(events, self.events.for_thread(&thread_id));
        let pending_approvals = self.runtime.approval_events(&thread_id).await;
        events = merge_task_event_records(events, pending_approvals.clone());
        sort_task_events(&mut events);
        let resolved_cwd = resolve_thread_cwd(&self.fs, &thread);
        let mut task = task_record_from_thread(&thread, &events, resolved_cwd.as_ref())?;
        apply_canonical_turn_projection(&mut task, &thread)?;
        let activity_ms = task_activity_ms(&task);
        let mut managed = self
            .store_update_observed_recency(&thread_id, activity_ms)
            .await?;
        if session_model.is_some() || session_reasoning_effort.is_some() {
            managed = self
                .store_update_composer_settings(
                    &thread_id,
                    session_model.as_deref(),
                    session_reasoning_effort.as_deref(),
                )
                .await?
                .or(managed);
        }
        if let Some(mut current) = managed {
            if actively_viewed
                && let Some(seen) = self
                    .store_mark_seen(&current.thread_id, activity_ms)
                    .await?
            {
                current = seen;
            }
            task.unseen = current.unseen(activity_ms);
            let model = session_model.or(current.model);
            let reasoning_effort = session_reasoning_effort.or(current.reasoning_effort);
            return Ok(TaskDetailResponse {
                thread_id,
                sync_state: TaskSyncState::Ready,
                revision,
                task: Some(task),
                events,
                events_page: TaskEventsPage { next_cursor },
                pending_approvals,
                history_loading,
                permission_mode,
                model,
                reasoning_effort,
            });
        }
        Err(not_managed_error())
    }

    pub(in crate::app) fn record_from_codex_thread(
        &self,
        thread: &crate::codex_app_server::CodexThread,
    ) -> Result<TaskRecord, ApiError> {
        let thread = thread.clone().into_value();
        let resolved = resolve_thread_cwd(&self.fs, &thread);
        task_record_from_thread(&thread, &[], resolved.as_ref())
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
                    Ok(CodexRuntimeSignal::SessionChanged {
                        thread_id,
                        snapshot,
                    }) => {
                        context
                            .broadcast_snapshot(&thread_id, *snapshot, "app-server-notification")
                            .await;
                    }
                    Ok(CodexRuntimeSignal::SessionUnavailable { thread_id, message }) => {
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
                .fail_external_sync(&thread_id, &CodexThreadError::ProcessUnavailable)
                .await;
            self.broadcast_error(&thread_id, CodexThreadError::ProcessUnavailable.to_string())
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
                self.sessions.fail_external_sync(&thread_id, &error).await;
                self.broadcast_error(&thread_id, error.to_string()).await;
                let _ = self.store_delete(&thread_id).await;
                (self.remove_managed_task)(&thread_id, "unavailable");
                job.complete(TaskSyncOutcome::Synchronized);
                return;
            }
            Err(error) => {
                self.sessions.fail_external_sync(&thread_id, &error).await;
                self.broadcast_error(&thread_id, error.to_string()).await;
                job.complete(TaskSyncOutcome::Retry);
                return;
            }
        };
        let snapshot = self
            .sessions
            .apply_external_read_sync(&thread_id, syncing.revision, thread, latest_turns)
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
        snapshot: ThreadSessionSnapshot,
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

    async fn store_mark_seen(
        &self,
        thread_id: &str,
        canonical_activity_ms: u64,
    ) -> Result<Option<ManagedThread>, ApiError> {
        let store = self.store.clone();
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || {
            store.mark_seen(&thread_id, canonical_activity_ms, super::events::now_ms())
        })
        .await
        .map_err(store_join_error)?
        .map_err(store_error)
    }

    async fn store_update_observed_recency(
        &self,
        thread_id: &str,
        canonical_activity_ms: u64,
    ) -> Result<Option<ManagedThread>, ApiError> {
        let store = self.store.clone();
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || {
            store.update_observed_recency(&thread_id, canonical_activity_ms)
        })
        .await
        .map_err(store_join_error)?
        .map_err(store_error)
    }

    async fn store_update_composer_settings(
        &self,
        thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<Option<ManagedThread>, ApiError> {
        let store = self.store.clone();
        let thread_id = thread_id.to_string();
        let model = model.map(str::to_string);
        let reasoning_effort = reasoning_effort.map(str::to_string);
        tokio::task::spawn_blocking(move || {
            store.update_composer_settings(
                &thread_id,
                model.as_deref(),
                reasoning_effort.as_deref(),
            )
        })
        .await
        .map_err(store_join_error)?
        .map_err(store_error)
    }

    async fn store_delete(&self, thread_id: &str) -> Result<bool, ApiError> {
        let store = self.store.clone();
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || store.delete(&thread_id))
            .await
            .map_err(store_join_error)?
            .map_err(store_error)
    }
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
        events_page: TaskEventsPage { next_cursor: None },
        pending_approvals: Vec::new(),
        history_loading: true,
        permission_mode: None,
        model: managed.and_then(|thread| thread.model.clone()),
        reasoning_effort: managed.and_then(|thread| thread.reasoning_effort.clone()),
    }
}

pub(in crate::app) fn not_managed_error() -> ApiError {
    ApiError::BadRequest {
        code: "task_not_managed",
        message: "task is not managed by Caffold".to_string(),
    }
}

fn store_error(error: ThreadStoreError) -> ApiError {
    ApiError::Internal(error.to_string())
}

fn store_join_error(error: tokio::task::JoinError) -> ApiError {
    ApiError::Internal(format!("thread store task failed: {error}"))
}
