use std::{pin::Pin, sync::Arc};

use futures_util::{Stream, stream};
use serde::Serialize;
use tokio::sync::broadcast;

use super::{
    TaskRecord, TaskState,
    active_list::{ActiveTaskComposerSettings, ActiveTaskRuntimeSnapshot},
    detail::{DetailContext, DetailLiveStream},
    lifecycle::ActiveTaskTopPlacement,
    sync::TaskSync,
};
use crate::{
    agent::{Conversation, claude::ClaudeClient},
    app::error::ApiError,
    fs::RootedFs,
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
                fs: state.fs.clone(),
                detail: state.detail.clone(),
                sessions: state.task_sessions.clone(),
                sync: state.task_sync.clone(),
                events: state.task_list_events.clone(),
                store: state.task_store.clone(),
                claude: state.task_runtime.claude().clone(),
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
    Updated(Box<TaskRecord>),
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
    pub(super) task: TaskRecord,
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
    Task(Box<TaskRecord>),
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

    pub(super) fn update(&self, task: TaskRecord) {
        let _ = self.updates.send(TaskListUpdate::Task(Box::new(task)));
    }

    pub(super) fn place(&self, task: TaskRecord, placement: ActiveTaskTopPlacement) {
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
    fs: Arc<RootedFs>,
    detail: DetailContext,
    sessions: super::sessions::TaskSessions,
    sync: TaskSync<super::TaskDetailSync>,
    events: TaskListEvents,
    store: TaskStore,
    claude: ClaudeClient,
    shutdown: broadcast::Sender<()>,
}

impl TaskListLiveSource {
    async fn stream(&self) -> Result<TaskListLiveStream, ApiError> {
        let receivers = TaskListEventReceivers::subscribe(self);
        let connection = self.detail.connection().await?;
        let projection = super::active_list::load_runtime_snapshot(
            self.fs.clone(),
            self.store.clone(),
            &self.sessions,
            connection.generation,
            &connection.client,
            &self.claude,
        )
        .await?;
        for thread in projection.observed_threads {
            self.sessions
                .observe_listed_thread_metadata(connection.generation, Conversation::from(&thread))
                .await;
        }
        Ok(task_list_event_stream(receivers, projection.snapshot))
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
    task: Option<TaskRecord>,
}

impl From<super::TaskDetailSync> for TaskListSync {
    fn from(sync: super::TaskDetailSync) -> Self {
        Self {
            thread_id: sync.thread_id,
            revision: sync.revision,
            task: sync.detail.task,
        }
    }
}

fn task_list_event_stream(
    receivers: TaskListEventReceivers,
    snapshot: ActiveTaskRuntimeSnapshot,
) -> TaskListLiveStream {
    let stream = stream::unfold(
        (Some(snapshot), receivers),
        |(mut snapshot, mut receivers)| async move {
            if let Some(initial_snapshot) = snapshot.take() {
                return Some((
                    TaskListLiveEvent::Snapshot(initial_snapshot),
                    (snapshot, receivers),
                ));
            }
            loop {
                tokio::select! {
                    _ = receivers.shutdown.recv() => return None,
                    message = receivers.removals.recv() => match message {
                        Ok(removal) => {
                            return Some((TaskListLiveEvent::Removed(removal), (snapshot, receivers)));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return None,
                    },
                    message = receivers.updates.recv() => match message {
                        Ok(TaskListUpdate::Task(task)) => {
                            return Some((TaskListLiveEvent::Updated(task), (snapshot, receivers)));
                        }
                        Ok(TaskListUpdate::Placement(update)) => {
                            return Some((TaskListLiveEvent::Placed(update), (snapshot, receivers)));
                        }
                        Ok(TaskListUpdate::SectionComposerSettings(update)) => {
                            return Some((TaskListLiveEvent::SectionComposerSettings(update), (snapshot, receivers)));
                        }
                        Ok(TaskListUpdate::Refresh) => {
                            return Some((TaskListLiveEvent::Refresh, (snapshot, receivers)));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return None,
                    },
                    message = receivers.sync.recv() => match message {
                        Ok(sync) => {
                            return Some((TaskListLiveEvent::Sync(Box::new(sync.into())), (snapshot, receivers)));
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(broadcast::error::RecvError::Closed) => return None,
                    },
                }
            }
        },
    );
    Box::pin(stream)
}

#[cfg(test)]
mod tests {
    use crate::agent;
    use futures_util::StreamExt;
    use serde_json::json;

    use super::*;
    use crate::{
        agent::{Conversation, codex::CodexThreadClient},
        app::tasks::{
            projection::{resolve_conversation_cwd, task_record_from_conversation},
            test_support::{task_state_with_codex_client, task_thread_list, wait_for_mock_method},
        },
        fs::RootedFs,
        task_store::{ComposerSettings, ManagedSection, ManagedThread, RunBy},
    };

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
        state.task_list_events.update(queued);

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
