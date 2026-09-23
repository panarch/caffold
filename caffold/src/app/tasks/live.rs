use std::pin::Pin;
#[cfg(test)]
use std::sync::Arc;

use futures_util::{Stream, stream};
use serde::Serialize;
use tokio::sync::broadcast;

use super::{
    TaskState,
    active_list::{
        ActiveTask, ActiveTaskComposerSettings, ActiveTaskRuntimeSnapshot, runs_in_managed_worktree,
    },
    detail::{DetailContext, DetailLiveStream},
    lifecycle::ActiveTaskTopPlacement,
    sync::TaskSync,
};
use crate::{
    agent::{Conversation, claude::ClaudeClient, grok::GrokClient},
    app::error::ApiError,
    task_store::{ManagedSection, TaskStore},
};

pub(in crate::app::tasks) type TaskListLiveStream =
    Pin<Box<dyn Stream<Item = TaskListLiveEvent> + Send>>;

/// The Task-owned live capabilities consumed by the application live gateway.
///
/// It exposes typed Task events without leaking route state or HTTP framing.
#[derive(Clone)]
pub(in crate::app) struct TaskLiveSource {
    list: TaskListLiveSource,
    detail: DetailContext,
}

impl TaskLiveSource {
    pub(super) fn new(state: &TaskState) -> Self {
        Self {
            list: TaskListLiveSource {
                detail: state.detail.clone(),
                sessions: state.task_sessions.clone(),
                sync: state.task_sync.clone(),
                events: state.task_list_events.clone(),
                store: state.task_store.clone(),
                claude: state.task_runtime.claude().clone(),
                grok: state.task_runtime.grok().clone(),
                shutdown: state.shutdown.clone(),
            },
            detail: state.detail.clone(),
        }
    }

    pub(in crate::app) async fn task_list(&self) -> Result<TaskListLiveStream, ApiError> {
        self.list.stream().await
    }

    pub(in crate::app) async fn task_detail(
        &self,
        thread_id: &str,
    ) -> Result<DetailLiveStream, ApiError> {
        self.detail.stream(thread_id).await
    }
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", content = "payload")]
pub(in crate::app) enum TaskListLiveEvent {
    #[serde(rename = "task-list-snapshot")]
    Snapshot(ActiveTaskRuntimeSnapshot),
    #[serde(rename = "task-removed")]
    Removed(TaskListRemoval),
    #[serde(rename = "task-updated")]
    Updated(Box<ActiveTask>),
    #[serde(rename = "task-placed-at-top")]
    Placed(Box<ActiveTaskPlacementUpdate>),
    #[serde(rename = "section-composer-settings")]
    SectionComposerSettings(Box<ActiveTaskSectionComposerSettingsUpdate>),
    #[serde(rename = "task-list-refresh")]
    Refresh,
    #[serde(rename = "task-sync")]
    Sync(Box<TaskListSync>),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskPlacementUpdate {
    pub(super) task: ActiveTask,
    pub(super) placement: ActiveTaskTopPlacement,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskSectionComposerSettingsUpdate {
    pub(super) section_id: String,
    pub(super) composer_settings: ActiveTaskComposerSettings,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskListRemoval {
    pub(super) thread_id: String,
    pub(super) reason: &'static str,
}

#[derive(Debug, Clone)]
pub(super) enum TaskListUpdate {
    Task(Box<ActiveTask>),
    Placement(Box<ActiveTaskPlacementUpdate>),
    SectionComposerSettings(Box<ActiveTaskSectionComposerSettingsUpdate>),
    Refresh,
}

#[derive(Clone)]
pub(super) struct TaskListEvents {
    removals: broadcast::Sender<TaskListRemoval>,
    updates: broadcast::Sender<TaskListUpdate>,
    #[cfg(test)]
    refresh_count: Arc<std::sync::atomic::AtomicUsize>,
}

impl TaskListEvents {
    pub(super) fn new() -> Self {
        let (removals, _) = broadcast::channel(64);
        let (updates, _) = broadcast::channel(64);
        Self {
            removals,
            updates,
            #[cfg(test)]
            refresh_count: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    pub(super) fn remove(&self, thread_id: &str, reason: &'static str) {
        let _ = self.removals.send(TaskListRemoval {
            thread_id: thread_id.to_string(),
            reason,
        });
    }

    pub(super) fn update(&self, task: ActiveTask) {
        let _ = self.updates.send(TaskListUpdate::Task(Box::new(task)));
    }

    pub(super) fn place(&self, task: ActiveTask, placement: ActiveTaskTopPlacement) {
        let _ = self.updates.send(TaskListUpdate::Placement(Box::new(
            ActiveTaskPlacementUpdate { task, placement },
        )));
    }

    pub(super) fn section_composer_settings(&self, section: &ManagedSection) {
        let Some(settings) = section.last_composer_settings.as_ref() else {
            return;
        };
        let _ = self
            .updates
            .send(TaskListUpdate::SectionComposerSettings(Box::new(
                ActiveTaskSectionComposerSettingsUpdate {
                    section_id: section.section_id.clone(),
                    composer_settings: settings.into(),
                },
            )));
    }

    pub(super) fn refresh(&self) {
        #[cfg(test)]
        self.refresh_count
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = self.updates.send(TaskListUpdate::Refresh);
    }

    #[cfg(test)]
    pub(super) fn refresh_count(&self) -> usize {
        self.refresh_count
            .load(std::sync::atomic::Ordering::Relaxed)
    }

    pub(super) fn subscribe(
        &self,
    ) -> (
        broadcast::Receiver<TaskListRemoval>,
        broadcast::Receiver<TaskListUpdate>,
    ) {
        (self.removals.subscribe(), self.updates.subscribe())
    }
}

#[derive(Clone)]
struct TaskListLiveSource {
    detail: DetailContext,
    sessions: super::sessions::TaskSessions,
    sync: TaskSync<super::TaskDetailSync>,
    events: TaskListEvents,
    store: TaskStore,
    claude: ClaudeClient,
    grok: GrokClient,
    shutdown: broadcast::Sender<()>,
}

impl TaskListLiveSource {
    async fn stream(&self) -> Result<TaskListLiveStream, ApiError> {
        let receivers = TaskListEventReceivers::subscribe(self);
        let connection = self.detail.connection().await?;
        let projection = super::active_list::load_runtime_snapshot(
            self.store.clone(),
            &self.sessions,
            connection.generation,
            &connection.client,
            &self.claude,
            &self.grok,
        )
        .await?;
        for thread in projection.observed_threads {
            self.sessions
                .observe_listed_thread_metadata(connection.generation, Conversation::from(&thread))
                .await;
        }
        Ok(task_list_event_stream(
            receivers,
            projection.snapshot,
            self.store.clone(),
        ))
    }
}

struct TaskListEventReceivers {
    sync: broadcast::Receiver<super::TaskDetailSync>,
    removals: broadcast::Receiver<TaskListRemoval>,
    updates: broadcast::Receiver<TaskListUpdate>,
    shutdown: broadcast::Receiver<()>,
}

impl TaskListEventReceivers {
    fn subscribe(source: &TaskListLiveSource) -> Self {
        let (removals, updates) = source.events.subscribe();
        Self {
            sync: source.sync.subscribe_updates(),
            removals,
            updates,
            shutdown: source.shutdown.subscribe(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskListSync {
    thread_id: String,
    revision: u64,
    task: Option<ActiveTask>,
}

impl TaskListSync {
    /// A Task Detail publication as the Active list reads it.
    async fn of(store: &TaskStore, sync: super::TaskDetailSync) -> Result<Self, ApiError> {
        let task = match sync.detail.task {
            Some(task) => Some(ActiveTask::of(
                &task,
                runs_in_managed_worktree(store, &task.thread_id).await?,
            )),
            None => None,
        };
        Ok(Self {
            thread_id: sync.thread_id,
            revision: sync.revision,
            task,
        })
    }
}

/// The Task list's events, its complete snapshot first.
///
/// A receiver that falls behind has dropped publications it cannot name, and a
/// row that cannot be built leaves the list short in the same way. Either way
/// the stream ends rather than go on with a list that is no longer whole.
fn task_list_event_stream(
    receivers: TaskListEventReceivers,
    snapshot: ActiveTaskRuntimeSnapshot,
    store: TaskStore,
) -> TaskListLiveStream {
    let stream = stream::unfold(
        (Some(snapshot), receivers, store),
        |(mut snapshot, mut receivers, store)| async move {
            if let Some(initial_snapshot) = snapshot.take() {
                return Some((
                    TaskListLiveEvent::Snapshot(initial_snapshot),
                    (snapshot, receivers, store),
                ));
            }
            let event = tokio::select! {
                _ = receivers.shutdown.recv() => return None,
                message = receivers.removals.recv() => TaskListLiveEvent::Removed(message.ok()?),
                message = receivers.updates.recv() => match message.ok()? {
                    TaskListUpdate::Task(task) => TaskListLiveEvent::Updated(task),
                    TaskListUpdate::Placement(update) => TaskListLiveEvent::Placed(update),
                    TaskListUpdate::SectionComposerSettings(update) => {
                        TaskListLiveEvent::SectionComposerSettings(update)
                    }
                    TaskListUpdate::Refresh => TaskListLiveEvent::Refresh,
                },
                message = receivers.sync.recv() => {
                    let sync = TaskListSync::of(&store, message.ok()?).await.ok()?;
                    TaskListLiveEvent::Sync(Box::new(sync))
                }
            };
            Some((event, (snapshot, receivers, store)))
        },
    );
    Box::pin(stream)
}

#[cfg(test)]
mod tests {
    use crate::agent;
    use futures_util::StreamExt;
    use serde_json::{Value as JsonValue, json};

    use std::collections::BTreeSet;

    use super::*;
    use crate::{
        agent::{Conversation, codex::CodexThreadClient},
        app::tasks::{
            TaskDetailSync,
            detail::loading_detail,
            lifecycle::ActiveTaskSectionIdentity,
            projection::{resolve_conversation_cwd, task_record_from_conversation},
            test_support::{
                record_managed_worktree, task_state_with_codex_client, task_thread_list,
                wait_for_mock_method,
            },
        },
        fs::RootedFs,
        task_store::{
            ComposerSettings, ManagedSection, ManagedThread, ManagedWorktreeState, RunBy,
        },
    };

    /// Everything an Active list row says, and nothing Task Detail reads.
    const ACTIVE_LIST_ROW_KEYS: [&str; 8] = [
        "lastCompletedMs",
        "recencyMs",
        "threadId",
        "threadStatus",
        "title",
        "unseen",
        "updatedMs",
        "worktree",
    ];

    fn row_keys(row: &JsonValue) -> BTreeSet<&str> {
        row.as_object()
            .expect("a list row is an object")
            .keys()
            .map(String::as_str)
            .collect()
    }

    /// The list's next event, which is already queued when this is asked.
    async fn queued_event(stream: &mut TaskListLiveStream) -> Option<TaskListLiveEvent> {
        tokio::time::timeout(std::time::Duration::from_millis(100), stream.next())
            .await
            .expect("the Task list answers from what is already queued")
    }

    #[tokio::test]
    async fn task_list_snapshot_rows_carry_list_values_and_the_managed_worktree_mark() {
        let root = tempfile::tempdir().unwrap();
        let isolated_id = "thread-list-isolated";
        let plain_id = "thread-list-plain";
        let isolated = task_thread_list(isolated_id, root.path())["data"][0].clone();
        let plain = task_thread_list(plain_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![agent::codex::MockCodexResponse::ok(
            "thread/list",
            json!({
                "data": [isolated, plain],
                "nextCursor": null,
                "backwardsCursor": null,
            }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(&state, isolated_id, "Isolated", 7, "section-marks", "");
        claim_cached_active(&state, plain_id, "Plain", 8, "section-marks", "");
        record_managed_worktree(&state.task_store, isolated_id, ManagedWorktreeState::Ready);
        state.task_runtime.spawn_test_bridge(client.clone(), 1);

        let mut events = TaskLiveSource::new(&state).task_list().await.unwrap();
        let snapshot = tokio::time::timeout(std::time::Duration::from_millis(50), events.next())
            .await
            .expect("the Task list sends its snapshot")
            .expect("the Task list remains open");

        let snapshot = serde_json::to_value(snapshot).unwrap();
        assert_eq!(snapshot["type"], "task-list-snapshot");
        let rows = snapshot["payload"]["tasks"].as_array().unwrap();
        let row = |thread_id: &str| {
            rows.iter()
                .find(|row| row["threadId"] == thread_id)
                .unwrap_or_else(|| panic!("{thread_id} is a row"))
        };
        assert_eq!(row(isolated_id)["worktree"], true);
        assert_eq!(row(plain_id)["worktree"], false);
        assert_eq!(
            row_keys(row(isolated_id)),
            BTreeSet::from(ACTIVE_LIST_ROW_KEYS)
        );
    }

    #[tokio::test]
    async fn a_detail_publication_reaches_the_list_as_a_row_marked_by_its_record() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-list-sync-isolated";
        let store = TaskStore::memory().unwrap();
        record_managed_worktree(&store, thread_id, ManagedWorktreeState::Ready);
        let thread: agent::codex::CodexThread =
            serde_json::from_value(task_thread_list(thread_id, root.path())["data"][0].clone())
                .expect("the fixture decodes as a Codex thread");
        let mut detail = loading_detail(thread_id, 3, None);
        detail.task = Some(task_record_from_conversation(
            &Conversation::from(&thread),
            &[],
            None,
        ));

        let sync = TaskListSync::of(
            &store,
            TaskDetailSync {
                thread_id: thread_id.to_string(),
                revision: 3,
                detail,
                reason: "app-server-notification",
                error: None,
            },
        )
        .await
        .unwrap();

        let sync = serde_json::to_value(sync).unwrap();
        assert_eq!(sync["threadId"], thread_id);
        assert_eq!(sync["revision"], 3);
        assert_eq!(sync["task"]["worktree"], true);
        assert_eq!(
            row_keys(&sync["task"]),
            BTreeSet::from(ACTIVE_LIST_ROW_KEYS)
        );
    }

    #[tokio::test]
    async fn a_task_list_that_falls_behind_ends_instead_of_skipping_what_it_missed() {
        let events = TaskListEvents::new();
        let (removals, updates) = events.subscribe();
        let sync = TaskSync::new();
        let (_shutdown, shutdown) = broadcast::channel(1);
        let mut stream = task_list_event_stream(
            TaskListEventReceivers {
                sync: sync.subscribe_updates(),
                removals,
                updates,
                shutdown,
            },
            ActiveTaskRuntimeSnapshot { tasks: Vec::new() },
            TaskStore::memory().unwrap(),
        );
        // One more update than the list's queue holds.
        for _ in 0..=64 {
            events.refresh();
        }

        let snapshot = serde_json::to_value(queued_event(&mut stream).await.unwrap()).unwrap();
        assert_eq!(snapshot["type"], "task-list-snapshot");
        assert!(
            queued_event(&mut stream).await.is_none(),
            "a list that dropped updates it cannot name must not carry on"
        );
    }

    #[tokio::test]
    async fn the_task_list_carries_its_updates_in_order_after_its_snapshot() {
        let events = TaskListEvents::new();
        let (removals, updates) = events.subscribe();
        let sync = TaskSync::new();
        let (_shutdown, shutdown) = broadcast::channel(1);
        let mut stream = task_list_event_stream(
            TaskListEventReceivers {
                sync: sync.subscribe_updates(),
                removals,
                updates,
                shutdown,
            },
            ActiveTaskRuntimeSnapshot { tasks: Vec::new() },
            TaskStore::memory().unwrap(),
        );
        let placed = ManagedThread::new("thread-placed", RunBy::Codex, Some(1), None, None);
        events.place(
            ActiveTask::stored(&placed, false),
            ActiveTaskTopPlacement {
                section: ActiveTaskSectionIdentity {
                    id: "section-placed".to_string(),
                    name: "Workspace/placed".to_string(),
                    repository: false,
                },
                before_section_id: None,
                before_thread_id: None,
            },
        );
        events.section_composer_settings(&ManagedSection {
            section_id: "section-placed".to_string(),
            logical_path: "Workspace/placed".to_string(),
            position: 0,
            last_composer_settings: Some(ComposerSettings {
                model: Some("gpt-section".to_string()),
                reasoning_effort: None,
                fast_mode: false,
                permission_mode: None,
            }),
        });
        events.refresh();

        let mut types = Vec::new();
        for _ in 0..4 {
            let event = serde_json::to_value(queued_event(&mut stream).await.unwrap()).unwrap();
            types.push(event["type"].as_str().unwrap().to_string());
        }
        assert_eq!(
            types,
            [
                "task-list-snapshot",
                "task-placed-at-top",
                "section-composer-settings",
                "task-list-refresh",
            ]
        );
    }

    #[tokio::test]
    async fn a_detail_publication_without_a_task_reaches_the_list_without_a_row() {
        let thread_id = "thread-list-sync-loading";

        let sync = TaskListSync::of(
            &TaskStore::memory().unwrap(),
            TaskDetailSync {
                thread_id: thread_id.to_string(),
                revision: 2,
                detail: loading_detail(thread_id, 2, None),
                reason: "app-server-notification",
                error: None,
            },
        )
        .await
        .unwrap();

        let sync = serde_json::to_value(sync).unwrap();
        assert_eq!(sync["threadId"], thread_id);
        assert_eq!(sync["task"], JsonValue::Null);
    }

    #[tokio::test]
    async fn task_list_events_serialize_targeted_section_composer_settings() {
        let root = tempfile::tempdir().unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        let (_, mut updates) = state.task_list_events.subscribe();

        state
            .task_list_events
            .section_composer_settings(&ManagedSection {
                section_id: "section-settings".to_string(),
                logical_path: "Workspace/settings".to_string(),
                position: 0,
                last_composer_settings: Some(ComposerSettings {
                    model: Some("gpt-section".to_string()),
                    reasoning_effort: Some("xhigh".to_string()),
                    fast_mode: true,
                    permission_mode: None,
                }),
            });

        let TaskListUpdate::SectionComposerSettings(update) = updates.recv().await.unwrap() else {
            panic!("expected targeted Section composer settings update");
        };
        let event = serde_json::to_value(TaskListLiveEvent::SectionComposerSettings(update))
            .expect("Task List event JSON");
        assert_eq!(
            event,
            json!({
                "type": "section-composer-settings",
                "payload": {
                    "sectionId": "section-settings",
                    "composerSettings": {
                        "model": "gpt-section",
                        "effort": "xhigh",
                        "fastMode": true,
                    },
                },
            })
        );
        assert_eq!(state.task_list_events.refresh_count(), 0);
    }

    #[tokio::test]
    async fn task_list_live_source_pages_global_threads_and_sends_one_managed_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let first_id = "thread-list-stream-first";
        let second_id = "thread-list-stream-second";
        let mut first = task_thread_list(first_id, root.path())["data"][0].clone();
        first["name"] = json!("Stale list name");
        first["status"] = json!({ "type": "active", "activeFlags": [] });
        let mut second = task_thread_list(second_id, root.path())["data"][0].clone();
        second["name"] = json!("Another stale list name");
        let unmanaged = task_thread_list("unmanaged-thread", root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![
            agent::codex::MockCodexResponse::ok_for(
                "thread/list",
                json!({
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                }),
                json!({
                    "data": [unmanaged, first],
                    "nextCursor": "page-2",
                    "backwardsCursor": null,
                }),
            ),
            agent::codex::MockCodexResponse::ok_for(
                "thread/list",
                json!({
                    "cursor": "page-2",
                    "limit": 100,
                    "sortKey": "recency_at",
                    "sortDirection": "desc",
                    "archived": false,
                    "useStateDbOnly": true,
                }),
                json!({
                    "data": [second],
                    "nextCursor": null,
                    "backwardsCursor": null,
                }),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(
            &state,
            first_id,
            "Persisted first name",
            7,
            "section-list-stream-bootstrap",
            "",
        );
        claim_cached_active(
            &state,
            second_id,
            "Persisted second name",
            8,
            "section-list-stream-bootstrap",
            "",
        );
        claim_cached_active(
            &state,
            "managed-but-missing",
            "Keep cached when absent",
            9,
            "section-list-stream-bootstrap",
            "",
        );
        let before = cached_projection_rows(&state);
        state.task_runtime.spawn_test_bridge(client.clone(), 1);

        let mut events = TaskLiveSource::new(&state).task_list().await.unwrap();
        let snapshot = tokio::time::timeout(std::time::Duration::from_millis(50), events.next())
            .await
            .expect("Task List live source replays the current runtime snapshot")
            .expect("Task List live source remains open");

        let snapshot = serde_json::to_value(snapshot).unwrap();
        assert_eq!(snapshot["type"], "task-list-snapshot");
        let payload = &snapshot["payload"];
        assert_eq!(payload["tasks"].as_array().unwrap().len(), 2);
        assert_eq!(payload["tasks"][0]["threadId"], first_id);
        assert_eq!(payload["tasks"][0]["title"], "Persisted first name");
        assert_eq!(payload["tasks"][0]["threadStatus"]["type"], "active");
        assert_eq!(payload["tasks"][1]["threadId"], second_id);
        assert_eq!(payload["tasks"][1]["title"], "Persisted second name");
        assert!(!snapshot.to_string().contains("unmanaged-thread"));
        assert!(!snapshot.to_string().contains("managed-but-missing"));
        client.mock_publish_event(agent::codex::CodexRuntimeEvent::Notification(
            agent::codex::CodexNotification::ThreadStatusChanged {
                thread_id: first_id.to_string(),
                status: agent::codex::ThreadStatus::Idle,
            },
        ));
        let sync = tokio::time::timeout(std::time::Duration::from_millis(100), events.next())
            .await
            .expect("tracked global Thread publishes later status changes")
            .expect("Task List live source remains open");
        let sync = serde_json::to_value(sync).unwrap();
        assert_eq!(sync["type"], "task-sync");
        let payload = &sync["payload"];
        assert_eq!(payload["threadId"], first_id);
        assert!(payload["revision"].as_u64().is_some());
        assert_eq!(payload["task"]["title"], "Persisted first name");
        assert_eq!(payload["task"]["threadStatus"]["type"], "idle");
        assert_eq!(payload.as_object().unwrap().len(), 3);
        assert!(payload.get("detail").is_none());
        assert!(payload.get("reason").is_none());
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), events.next())
                .await
                .is_err(),
            "one complete snapshot must replace per-Task bootstrap frames"
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .into_iter()
                .map(|(method, params)| (method, params.get("cursor").cloned()))
                .collect::<Vec<_>>(),
            [
                ("thread/list".to_string(), None),
                ("thread/list".to_string(), Some(json!("page-2"))),
            ]
        );
        assert_eq!(cached_projection_rows(&state), before);
    }

    #[tokio::test]
    async fn task_list_live_source_rejects_incomplete_pagination_without_cache_mutation() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-list-repeated-cursor";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![
            agent::codex::MockCodexResponse::ok(
                "thread/list",
                json!({
                    "data": [thread],
                    "nextCursor": "repeated",
                    "backwardsCursor": null,
                }),
            ),
            agent::codex::MockCodexResponse::ok(
                "thread/list",
                json!({
                    "data": [],
                    "nextCursor": "repeated",
                    "backwardsCursor": null,
                }),
            ),
        ]);
        let state = task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client).await;
        claim_cached_active(
            &state,
            thread_id,
            "Persisted name",
            7,
            "section-repeated-cursor",
            "",
        );
        let before = cached_projection_rows(&state);

        let result = TaskLiveSource::new(&state).task_list().await;

        assert!(matches!(
            result,
            Err(ApiError::Agent(message)) if message.contains("repeated")
        ));
        assert_eq!(cached_projection_rows(&state), before);
    }

    #[tokio::test]
    async fn task_list_live_source_queues_updates_while_building_its_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let thread_id = "thread-list-snapshot-race";
        let thread = task_thread_list(thread_id, root.path())["data"][0].clone();
        let client = CodexThreadClient::mock(vec![agent::codex::MockCodexResponse::delayed_ok(
            "thread/list",
            json!({
                "data": [thread.clone()],
                "nextCursor": null,
                "backwardsCursor": null,
            }),
            std::time::Duration::from_millis(50),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        claim_cached_active(
            &state,
            thread_id,
            "Persisted name",
            7,
            "section-snapshot-race",
            "",
        );

        let stream_state = state.clone();
        let stream_task = tokio::spawn(async move {
            TaskLiveSource::new(&stream_state)
                .task_list()
                .await
                .expect("Task List live source opens")
        });
        wait_for_mock_method(&client, "thread/list").await;
        let thread: agent::codex::CodexThread =
            serde_json::from_value(thread).expect("the fixture decodes as a Codex thread");
        let conversation = Conversation::from(&thread);
        let resolved = resolve_conversation_cwd(&state.fs, &conversation);
        let mut queued = task_record_from_conversation(&conversation, &[], resolved.as_ref());
        queued.title = "Queued after subscription".to_string();
        state
            .task_list_events
            .update(ActiveTask::of(&queued, false));

        let mut events = stream_task.await.unwrap();
        let mut received = Vec::new();
        for _ in 0..2 {
            received.push(
                tokio::time::timeout(std::time::Duration::from_millis(100), events.next())
                    .await
                    .expect("expected live event")
                    .expect("Task List live source remains open"),
            );
        }

        let snapshot = serde_json::to_value(&received[0]).unwrap();
        assert_eq!(snapshot["type"], "task-list-snapshot");
        let queued = serde_json::to_value(&received[1]).unwrap();
        assert_eq!(queued["type"], "task-updated");
        assert_eq!(queued["payload"]["title"], "Queued after subscription");
    }

    fn claim_cached_active(
        state: &TaskState,
        thread_id: &str,
        display_name: &str,
        recency_ms: u64,
        section_id: &str,
        logical_path: &str,
    ) {
        state
            .task_store
            .transaction(|tables| {
                let section = ManagedSection {
                    section_id: section_id.to_string(),
                    logical_path: logical_path.to_string(),
                    position: 0,
                    last_composer_settings: None,
                };
                tables.upsert_managed_section(&section)?;
                tables.claim_managed_thread_at_top(
                    ManagedThread::new(thread_id, RunBy::Codex, Some(recency_ms), None, None),
                    display_name,
                    &section.section_id,
                    recency_ms,
                )
            })
            .unwrap();
    }

    fn cached_projection_rows(state: &TaskState) -> (Vec<ManagedSection>, Vec<ManagedThread>) {
        state
            .task_store
            .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
            .unwrap()
    }
}
