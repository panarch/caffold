use futures_util::{StreamExt, stream};
use serde_json::json;
use tokio::sync::broadcast;

use super::{CodexConnection, CodexRuntime, CodexRuntimeSignal};
use crate::app::tasks::events::{
    event_id_from_params, now_ms, seconds_to_ms_value, task_event_from_item_lifecycle,
    task_event_from_raw_response_item, task_event_record,
};
use crate::codex_app_server::{
    CodexNotification, CodexRuntimeEvent, CodexThreadClient, ThreadStatus, TurnStatus,
};

impl CodexRuntime {
    pub(super) fn spawn_bridge(
        &self,
        client: CodexThreadClient,
        generation: u64,
        mut shutdown: broadcast::Receiver<()>,
    ) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut receiver = client.subscribe();
            let connection_error = loop {
                tokio::select! {
                    _ = shutdown.recv() => return,
                    event = receiver.recv() => {
                        let event = match event {
                            Ok(event) => event,
                            Err(error) => {
                                break format!("Codex app-server event stream closed: {error}");
                            }
                        };
                        match event {
                            CodexRuntimeEvent::Notification(notification) => {
                                let thread_id =
                                    notification_thread_id(&notification).map(str::to_string);
                                let revision = runtime
                                    .sessions
                                    .apply_notification(generation, &notification)
                                    .await;
                                runtime
                                    .expire_stale_approvals_for_notification(&notification)
                                    .await;
                                runtime.handle_notification(notification);
                                if revision.is_some()
                                    && let Some(thread_id) = thread_id
                                    && let Some(snapshot) =
                                        runtime.sessions.snapshot(&thread_id).await
                                {
                                    let _ = runtime.signals.send(
                                        CodexRuntimeSignal::SessionChanged {
                                            thread_id,
                                            snapshot: Box::new(snapshot),
                                        },
                                    );
                                }
                            }
                            CodexRuntimeEvent::ServerRequest(request) => {
                                runtime.handle_server_request(&client, generation, request).await;
                            }
                            CodexRuntimeEvent::Diagnostic { message } => {
                                eprintln!("{message}");
                            }
                            CodexRuntimeEvent::Error { message } => {
                                break message;
                            }
                        }
                    }
                }
            };
            let affected = runtime
                .sessions
                .connection_lost(generation, connection_error.clone())
                .await;
            for thread_id in affected {
                let _ = runtime
                    .signals
                    .send(CodexRuntimeSignal::SessionUnavailable {
                        thread_id,
                        message: connection_error.clone(),
                    });
            }
            runtime.process.invalidate(generation).await;
        });
    }

    pub(super) fn restore_connection_state(&self, connection: CodexConnection) {
        let runtime = self.clone();
        tokio::spawn(async move {
            for (thread_id, error) in runtime
                .sessions
                .resubscribe_leased(&connection.client, connection.generation)
                .await
            {
                eprintln!("failed to restore Codex thread subscription {thread_id}: {error}");
            }
            runtime.recover_loaded_sessions(connection).await;
        });
    }

    async fn recover_loaded_sessions(&self, connection: CodexConnection) {
        let loaded_thread_ids = match connection.client.list_all_loaded_threads().await {
            Ok(thread_ids) => thread_ids,
            Err(error) => {
                eprintln!("failed to list loaded Codex threads during startup recovery: {error}");
                return;
            }
        };
        let task_store = self.task_store.clone();
        let managed_threads = match tokio::task::spawn_blocking(move || {
            loaded_thread_ids
                .into_iter()
                .map(|thread_id| task_store.get(&thread_id))
                .filter_map(|result| match result {
                    Ok(managed) => managed.map(Ok),
                    Err(error) => Some(Err(error)),
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        {
            Ok(Ok(thread_ids)) => thread_ids,
            Ok(Err(error)) => {
                eprintln!("failed to read managed threads during startup recovery: {error}");
                return;
            }
            Err(error) => {
                eprintln!("managed thread recovery worker failed: {error}");
                return;
            }
        };

        stream::iter(managed_threads)
            .for_each_concurrent(8, |managed| {
                let runtime = self.clone();
                let connection = connection.clone();
                async move {
                    let thread_id = managed.thread_id;
                    runtime
                        .sessions
                        .restore_managed_fast_mode(&thread_id, managed.fast_mode)
                        .await;
                    match runtime
                        .sessions
                        .recover_loaded_thread(
                            &connection.client,
                            connection.generation,
                            &thread_id,
                        )
                        .await
                    {
                        Ok(Some(snapshot)) => {
                            let _ = runtime.signals.send(CodexRuntimeSignal::SessionChanged {
                                thread_id,
                                snapshot: Box::new(snapshot),
                            });
                        }
                        Ok(None) => {}
                        Err(error) => {
                            eprintln!("failed to recover loaded Codex thread {thread_id}: {error}");
                        }
                    }
                }
            })
            .await;
    }

    fn handle_notification(&self, notification: CodexNotification) {
        match notification {
            CodexNotification::TurnStarted { thread_id, turn } => {
                let started_ms = turn
                    .started_at
                    .map(seconds_to_ms_value)
                    .filter(|value| *value > 0)
                    .unwrap_or_else(now_ms);
                let params = json!({ "threadId": thread_id, "turn": turn });
                self.events.publish(task_event_record(
                    &thread_id,
                    &event_id_from_params("turn_started", &params),
                    "turn_started",
                    "Turn started",
                    Some(params),
                    started_ms,
                ));
            }
            CodexNotification::ThreadStatusChanged { thread_id, status } => {
                let task_status = match status {
                    ThreadStatus::Active { .. } => "running",
                    ThreadStatus::Idle | ThreadStatus::NotLoaded => "idle",
                    ThreadStatus::SystemError => "failed",
                };
                let summary = match task_status {
                    "running" => "Thread running",
                    "failed" => "Thread failed",
                    _ => "Thread idle",
                };
                self.events.publish(task_event_record(
                    &thread_id,
                    "thread_status_changed",
                    "thread_status_changed",
                    summary,
                    Some(json!({
                        "threadId": thread_id,
                        "status": task_status,
                    })),
                    now_ms(),
                ));
            }
            CodexNotification::ThreadNameUpdated { .. }
            | CodexNotification::ThreadSettingsUpdated { .. } => {}
            CodexNotification::ItemStarted {
                thread_id,
                turn_id,
                item,
                started_at_ms,
            } => {
                let created_ms = if started_at_ms > 0 {
                    started_at_ms
                } else {
                    now_ms()
                };
                let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
                if let Some(event) =
                    task_event_from_item_lifecycle(&thread_id, created_ms, &params, "started")
                {
                    self.events.publish(event);
                }
            }
            CodexNotification::ItemCompleted {
                thread_id,
                turn_id,
                item,
                completed_at_ms,
            } => {
                let created_ms = if completed_at_ms > 0 {
                    completed_at_ms
                } else {
                    now_ms()
                };
                let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
                if let Some(event) =
                    task_event_from_item_lifecycle(&thread_id, created_ms, &params, "completed")
                {
                    self.events.publish(event);
                }
            }
            CodexNotification::RawResponseItemCompleted {
                thread_id,
                turn_id,
                item,
            } => {
                let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
                if let Some(event) =
                    task_event_from_raw_response_item(&thread_id, now_ms(), &params)
                {
                    self.events.publish(event);
                }
            }
            CodexNotification::TurnCompleted { thread_id, turn } => {
                let task_status = match turn.status {
                    TurnStatus::Failed => "failed",
                    TurnStatus::Interrupted => "interrupted",
                    TurnStatus::Completed => "completed",
                    TurnStatus::InProgress => "running",
                };
                let summary = match task_status {
                    "failed" => "Turn failed",
                    "interrupted" => "Turn interrupted",
                    "completed" => "Turn completed",
                    _ => "Turn updated",
                };
                let completed_ms = turn
                    .completed_at
                    .map(seconds_to_ms_value)
                    .filter(|value| *value > 0)
                    .unwrap_or_else(now_ms);
                if let Err(error) = self
                    .task_store
                    .update_completed_at(&thread_id, completed_ms)
                {
                    eprintln!("failed to persist completed turn for {thread_id}: {error}");
                }
                let params = json!({ "threadId": thread_id, "turn": turn });
                self.events.publish(task_event_record(
                    &thread_id,
                    &event_id_from_params("turn_completed", &params),
                    "turn_completed",
                    summary,
                    Some(params),
                    completed_ms,
                ));
            }
            CodexNotification::TurnDiffUpdated { thread_id, params } => {
                self.events.publish(task_event_record(
                    &thread_id,
                    "diff_updated",
                    "diff_updated",
                    "Diff updated",
                    Some(params),
                    now_ms(),
                ));
            }
            CodexNotification::ThreadStarted { .. } | CodexNotification::Unknown { .. } => {}
        }
    }

    #[cfg(test)]
    pub(in crate::app) fn restore_test_sessions(&self, connection: CodexConnection) {
        self.restore_connection_state(connection);
    }
}

fn notification_thread_id(notification: &CodexNotification) -> Option<&str> {
    match notification {
        CodexNotification::ThreadStarted { thread } => Some(&thread.id),
        CodexNotification::ThreadStatusChanged { thread_id, .. }
        | CodexNotification::ThreadNameUpdated { thread_id, .. }
        | CodexNotification::ThreadSettingsUpdated { thread_id, .. }
        | CodexNotification::TurnStarted { thread_id, .. }
        | CodexNotification::TurnCompleted { thread_id, .. }
        | CodexNotification::ItemStarted { thread_id, .. }
        | CodexNotification::ItemCompleted { thread_id, .. }
        | CodexNotification::RawResponseItemCompleted { thread_id, .. }
        | CodexNotification::TurnDiffUpdated { thread_id, .. } => Some(thread_id),
        CodexNotification::Unknown { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as JsonValue, json};

    use super::*;
    use crate::{
        app::tasks::events::TaskEvents,
        codex_app_server::{self, CodexThreadClient, MockCodexResponse},
        codex_thread_sessions::CodexThreadSessions,
        task_store::{ManagedThread, TaskStore},
    };

    fn runtime_with_events_and_store(events: TaskEvents, store: TaskStore) -> CodexRuntime {
        let (shutdown, _) = broadcast::channel(1);
        CodexRuntime::new(CodexThreadSessions::default(), events, store, shutdown)
    }

    fn active_resume(thread_id: &str) -> JsonValue {
        json!({
            "thread": {
                "id": thread_id,
                "preview": "Recovered task",
                "status": { "type": "active", "activeFlags": [] },
                "cwd": "/Users/example/project",
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": [{
                    "id": "turn-active",
                    "items": [],
                    "status": "inProgress",
                    "startedAt": 2.0
                }]
            },
            "initialTurnsPage": {
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null
            }
        })
    }

    #[test]
    fn completed_turn_notification_persists_the_latest_completion_time() {
        let store = TaskStore::memory().unwrap();
        let runtime = runtime_with_events_and_store(TaskEvents::default(), store.clone());
        store
            .claim(
                ManagedThread::new("thread_1", Some(1_000), None, None),
                1_000,
            )
            .unwrap();

        runtime.handle_notification(
            codex_app_server::decode_notification(
                "turn/completed",
                json!({
                    "threadId": "thread_1",
                    "turn": {
                        "id": "turn_1",
                        "status": "completed",
                        "completedAt": 1_750_000_004.5
                    }
                }),
            )
            .unwrap(),
        );

        let stored = store.get("thread_1").unwrap().unwrap();
        assert_eq!(stored.last_completed_at_ms, Some(1_750_000_004_500));
        assert!(stored.unseen());
    }

    #[tokio::test]
    async fn startup_recovery_resumes_only_loaded_threads_managed_by_caffold() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(ManagedThread::new("managed", None, None, None), 10)
            .unwrap();
        let runtime = runtime_with_events_and_store(TaskEvents::default(), store);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/loaded/list",
                json!({
                    "data": ["managed", "outside-caffold"],
                    "nextCursor": "next"
                }),
            ),
            MockCodexResponse::ok(
                "thread/loaded/list",
                json!({ "data": ["managed"], "nextCursor": null }),
            ),
            MockCodexResponse::ok("thread/resume", active_resume("managed")),
        ]);

        runtime
            .recover_loaded_sessions(CodexConnection {
                client: client.clone(),
                generation: 4,
            })
            .await;

        assert_eq!(
            client.mock_requests().await,
            [
                ("thread/loaded/list".to_string(), json!({ "limit": 100 })),
                (
                    "thread/loaded/list".to_string(),
                    json!({ "cursor": "next", "limit": 100 })
                ),
                (
                    "thread/resume".to_string(),
                    json!({
                        "threadId": "managed",
                        "serviceTier": "default",
                        "excludeTurns": true,
                        "initialTurnsPage": {
                            "limit": 8,
                            "sortDirection": "desc",
                            "itemsView": "full"
                        }
                    })
                )
            ]
        );
    }

    #[test]
    fn codex_notifications_publish_live_task_status() {
        let events = TaskEvents::default();
        let mut receiver = events.subscribe();
        let runtime = runtime_with_events_and_store(
            events.clone(),
            TaskStore::memory().expect("in-memory task store"),
        );

        runtime.handle_notification(
            codex_app_server::decode_notification(
                "turn/started",
                json!({
                    "threadId": "thread_1",
                    "turn": {
                        "id": "turn_1",
                        "status": "inProgress",
                        "startedAt": 1_750_000_000.25
                    }
                }),
            )
            .unwrap(),
        );
        let started = receiver.try_recv().unwrap();
        assert_eq!(started.thread_id, "thread_1");
        assert_eq!(started.event_type, "turn_started");
        assert_eq!(started.created_ms, 1_750_000_000_250);
        assert_eq!(started.payload.unwrap()["turn"]["id"], "turn_1");

        runtime.handle_notification(
            codex_app_server::decode_notification(
                "item/started",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "startedAtMs": 1_750_000_001_000_u64,
                    "item": {
                        "id": "command_1",
                        "type": "commandExecution",
                        "command": "cargo test",
                        "cwd": "/tmp/project",
                        "status": "inProgress"
                    }
                }),
            )
            .unwrap(),
        );
        let command_started = receiver.try_recv().unwrap();
        assert_eq!(command_started.event_type, "command_execution");
        assert_eq!(command_started.created_ms, 1_750_000_001_000);
        assert_eq!(
            command_started.payload.as_ref().unwrap()["lifecycle"],
            "started"
        );
        let cached_command = events
            .for_thread("thread_1")
            .into_iter()
            .find(|event| event.id == command_started.id)
            .expect("notification bridge should cache commands without an SSE consumer");
        assert_eq!(cached_command.event_type, "command_execution");

        runtime.handle_notification(
            codex_app_server::decode_notification(
                "item/started",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "startedAtMs": 1_750_000_002_000_u64,
                    "item": {
                        "id": "reasoning_1",
                        "type": "reasoning",
                        "summary": [],
                        "content": []
                    }
                }),
            )
            .unwrap(),
        );
        let reasoning_started = receiver.try_recv().unwrap();
        assert_eq!(reasoning_started.event_type, "work_status");
        assert_eq!(reasoning_started.summary, "Thinking");
        assert_eq!(
            reasoning_started.payload.as_ref().unwrap()["lifecycle"],
            "started"
        );

        runtime.handle_notification(
            codex_app_server::decode_notification(
                "item/completed",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "completedAtMs": 1_750_000_003_000_u64,
                    "item": {
                        "id": "reasoning_1",
                        "type": "reasoning",
                        "summary": ["Checked the current behavior."],
                        "content": []
                    }
                }),
            )
            .unwrap(),
        );
        let reasoning_completed = receiver.try_recv().unwrap();
        assert_eq!(reasoning_started.id, reasoning_completed.id);
        assert_eq!(reasoning_completed.event_type, "reasoning");
        assert_eq!(reasoning_completed.created_ms, 1_750_000_002_000);
        assert_eq!(reasoning_completed.updated_ms, Some(1_750_000_003_000));
        assert_eq!(
            reasoning_completed.payload.as_ref().unwrap()["lifecycle"],
            "completed"
        );

        runtime.handle_notification(
            codex_app_server::decode_notification(
                "thread/status/changed",
                json!({
                    "threadId": "thread_1",
                    "status": { "type": "active", "activeFlags": [] }
                }),
            )
            .unwrap(),
        );
        let status = receiver.try_recv().unwrap();
        assert_eq!(status.thread_id, "thread_1");
        assert_eq!(status.event_type, "thread_status_changed");
        assert_eq!(status.payload.unwrap()["status"], "running");

        runtime.handle_notification(
            codex_app_server::decode_notification(
                "turn/completed",
                json!({
                    "threadId": "thread_1",
                    "turn": {
                        "id": "turn_1",
                        "status": "completed",
                        "completedAt": 1_750_000_004.5
                    }
                }),
            )
            .unwrap(),
        );
        let completed = receiver.try_recv().unwrap();
        assert_eq!(completed.event_type, "turn_completed");
        assert_eq!(completed.created_ms, 1_750_000_004_500);
    }
}
