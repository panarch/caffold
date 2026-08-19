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
        let mut receiver = client.subscribe();
        tokio::spawn(async move {
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
                                let apply_outcome = runtime
                                    .sessions
                                    .apply_notification_with_outcome(generation, &notification)
                                    .await;
                                let canonical_state_changed =
                                    apply_outcome.canonical_state_changed;
                                let terminal_turn_is_first_current = apply_outcome
                                    .terminal
                                    .is_some_and(|terminal| terminal.first_current_transition);
                                let terminal_notification = matches!(
                                    &notification,
                                    CodexNotification::TurnCompleted { .. }
                                );
                                let snapshot = if (canonical_state_changed
                                    || terminal_notification)
                                    && let Some(thread_id) = thread_id.as_deref()
                                {
                                    runtime.sessions.snapshot(thread_id).await
                                } else {
                                    None
                                };
                                let task_name = snapshot
                                    .as_ref()
                                    .and_then(|snapshot| snapshot.thread.as_ref())
                                    .and_then(|thread| thread.name.as_deref());
                                runtime.handle_terminal_push(
                                    &notification,
                                    task_name,
                                    terminal_turn_is_first_current,
                                );
                                runtime
                                    .reconcile_pending_approvals_for_notification(&notification)
                                    .await;
                                runtime.handle_notification(notification);
                                if canonical_state_changed
                                    && let Some(thread_id) = thread_id
                                    && let Some(snapshot) = snapshot
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
                match self
                    .task_store
                    .update_observed_recency(&thread_id, started_ms)
                {
                    Ok(Some(_)) => self.refresh_persisted_task_list(),
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!(
                            "failed to persist started turn recency for {thread_id}: {error}"
                        );
                    }
                }
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
            CodexNotification::ThreadTokenUsageUpdated {
                thread_id,
                turn_id,
                token_usage,
            } => self.record_token_usage(thread_id, turn_id, token_usage),
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
                match self
                    .task_store
                    .record_completed_turn(&thread_id, completed_ms)
                {
                    Ok(Some(_)) => self.refresh_persisted_task_list(),
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("failed to persist completed turn for {thread_id}: {error}");
                    }
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
            CodexNotification::ThreadStarted { .. }
            | CodexNotification::ServerRequestResolved { .. }
            | CodexNotification::Unknown { .. } => {}
        }
    }

    fn handle_terminal_push(
        &self,
        notification: &CodexNotification,
        task_name: Option<&str>,
        terminal_turn_is_first_current: bool,
    ) {
        if !terminal_turn_is_first_current {
            if matches!(notification, CodexNotification::TurnCompleted { .. }) {
                eprintln!(
                    "Web Push terminal delivery skipped because the turn was not current or was already terminal"
                );
            }
            return;
        }
        let Some(push) = self.push.as_ref() else {
            return;
        };
        let CodexNotification::TurnCompleted { thread_id, turn } = notification else {
            return;
        };
        let status = match turn.status {
            TurnStatus::Completed => super::super::push::TerminalPushStatus::Completed,
            TurnStatus::Failed => super::super::push::TerminalPushStatus::Failed,
            TurnStatus::Interrupted => super::super::push::TerminalPushStatus::Interrupted,
            TurnStatus::InProgress => return,
        };
        match self.task_store.get(thread_id) {
            Ok(Some(_)) => {
                let queued = push.notify_terminal(thread_id, &turn.id, status, task_name);
                eprintln!("Web Push terminal delivery queued for {queued} active installation(s)");
            }
            Ok(None) => eprintln!(
                "Web Push terminal delivery skipped because the turn is not managed by Caffold"
            ),
            Err(_) => eprintln!(
                "managed task state could not be checked; terminal Web Push delivery skipped"
            ),
        }
    }

    fn refresh_persisted_task_list(&self) {
        if let Some(lifecycle) = &self.lifecycle {
            lifecycle.refresh_task_list();
        }
    }

    #[cfg(test)]
    pub(in crate::app) fn restore_test_sessions(&self, connection: CodexConnection) {
        self.restore_connection_state(connection);
    }

    #[cfg(test)]
    pub(in crate::app) fn spawn_test_bridge(&self, client: CodexThreadClient, generation: u64) {
        self.spawn_bridge(client, generation, self.shutdown.subscribe());
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
        | CodexNotification::TurnDiffUpdated { thread_id, .. }
        | CodexNotification::ThreadTokenUsageUpdated { thread_id, .. }
        | CodexNotification::ServerRequestResolved { thread_id, .. } => Some(thread_id),
        CodexNotification::Unknown { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{Value as JsonValue, json};

    use super::*;
    use crate::{
        app::tasks::{
            events::TaskEvents, lifecycle::TaskLifecycle, routes::TaskListEvents,
            worktrees::ManagedWorktrees,
        },
        codex_app_server::{self, CodexThreadClient, MockCodexResponse},
        codex_thread_sessions::CodexThreadSessions,
        fs::RootedFs,
        task_store::{ManagedThread, PushSubscriptionInput, TaskStore},
    };

    fn runtime_with_events_and_store(events: TaskEvents, store: TaskStore) -> CodexRuntime {
        let (shutdown, _) = broadcast::channel(1);
        CodexRuntime::new(CodexThreadSessions::default(), events, store, shutdown)
    }

    fn runtime_with_list_events(
        events: TaskEvents,
        store: TaskStore,
    ) -> (CodexRuntime, TaskListEvents) {
        let root = tempfile::tempdir().unwrap();
        let fs = std::sync::Arc::new(RootedFs::new(root.path()).unwrap());
        let sessions = CodexThreadSessions::default();
        let list_events = TaskListEvents::new();
        let worktrees =
            ManagedWorktrees::new(fs.clone(), store.clone(), root.path().join("worktrees"))
                .unwrap();
        let lifecycle = TaskLifecycle::new(
            fs,
            sessions.clone(),
            events.clone(),
            list_events.clone(),
            store.clone(),
            worktrees,
        );
        let (shutdown, _) = broadcast::channel(1);
        (
            CodexRuntime::new(sessions, events, store, shutdown).with_lifecycle(lifecycle),
            list_events,
        )
    }

    fn active_resume(thread_id: &str) -> JsonValue {
        json!({
            "cwd": "/Users/example/project",
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

    #[tokio::test]
    async fn event_notification_has_no_session_changed_signal_of_its_own() {
        let events = TaskEvents::default();
        let runtime = runtime_with_events_and_store(
            events.clone(),
            TaskStore::memory().expect("in-memory task store"),
        );
        let thread_id = "thread-event-only";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            active_resume(thread_id),
        )]);
        let _viewer = runtime
            .sessions
            .acquire_viewer(&client, 1, thread_id)
            .await
            .expect("viewer");
        let initial_revision = runtime
            .sessions
            .snapshot(thread_id)
            .await
            .expect("initial snapshot")
            .revision;
        let mut task_events = events.subscribe();
        let mut signals = runtime.subscribe();
        runtime.spawn_test_bridge(client.clone(), 1);

        client.mock_publish_event(CodexRuntimeEvent::Notification(
            CodexNotification::ItemStarted {
                thread_id: thread_id.to_string(),
                turn_id: "turn-active".to_string(),
                item: json!({
                    "id": "reasoning-1",
                    "type": "reasoning",
                    "summary": [],
                    "content": []
                }),
                started_at_ms: 10,
            },
        ));
        client.mock_publish_event(CodexRuntimeEvent::Notification(
            CodexNotification::ThreadStatusChanged {
                thread_id: thread_id.to_string(),
                status: ThreadStatus::Idle,
            },
        ));

        let event = tokio::time::timeout(Duration::from_secs(1), task_events.recv())
            .await
            .expect("item notification publishes a Task event")
            .expect("Task event channel remains open");
        assert_eq!(event.thread_id, thread_id);
        assert_eq!(event.event_type, "work_status");

        let signal = tokio::time::timeout(Duration::from_secs(1), signals.recv())
            .await
            .expect("canonical status change publishes a runtime signal")
            .expect("runtime signal channel remains open");
        let CodexRuntimeSignal::SessionChanged {
            thread_id: signal_thread_id,
            snapshot,
        } = signal
        else {
            panic!("expected a changed-session signal");
        };
        assert_eq!(signal_thread_id, thread_id);
        assert_eq!(snapshot.revision, initial_revision + 2);
        assert_eq!(
            snapshot.thread.expect("canonical thread").status,
            ThreadStatus::Idle
        );
    }

    #[test]
    fn completed_turn_notification_persists_projection_and_refreshes_the_list() {
        let store = TaskStore::memory().unwrap();
        let (runtime, list_events) = runtime_with_list_events(TaskEvents::default(), store.clone());
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
        assert_eq!(stored.last_observed_recency_ms, Some(1_750_000_004_500));
        assert!(stored.unseen());
        assert_eq!(list_events.refresh_count(), 1);
    }

    #[test]
    fn started_turn_notification_persists_recency_and_refreshes_the_list() {
        let store = TaskStore::memory().unwrap();
        let (runtime, list_events) = runtime_with_list_events(TaskEvents::default(), store.clone());
        store
            .claim(
                ManagedThread::new("thread_1", Some(1_000), None, None),
                1_000,
            )
            .unwrap();

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

        let stored = store.get("thread_1").unwrap().unwrap();
        assert_eq!(stored.last_observed_recency_ms, Some(1_750_000_000_250));
        assert_eq!(list_events.refresh_count(), 1);
    }

    #[test]
    fn terminal_push_selects_only_managed_canonical_terminal_turns() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(ManagedThread::new("managed", None, None, None), 1_000)
            .unwrap();
        store
            .upsert_push_installation(
                PushSubscriptionInput {
                    client_id: "00000000-0000-4000-8000-000000000001".to_owned(),
                    installation_label: "Chrome on macOS · 00000000".to_owned(),
                    endpoint: "https://push.example.test/subscription".to_owned(),
                    p256dh: "test-public-key".to_owned(),
                    auth: "test-auth".to_owned(),
                    expiration_time_ms: None,
                },
                1_000,
            )
            .unwrap();
        let (push, mut deliveries) =
            crate::app::tasks::push::PushService::test_channel(store.clone());
        let runtime =
            runtime_with_events_and_store(TaskEvents::default(), store).with_push_service(push);

        for (status, expected) in [
            ("completed", "completed"),
            ("failed", "failed"),
            ("interrupted", "interrupted"),
        ] {
            let notification = codex_app_server::decode_notification(
                "turn/completed",
                json!({
                    "threadId": "managed",
                    "turn": { "id": format!("turn-{status}"), "status": status }
                }),
            )
            .unwrap();
            runtime.handle_terminal_push(&notification, Some("Current task name"), true);
            let delivery = deliveries.try_recv().unwrap();
            let payload: JsonValue = serde_json::from_slice(&delivery.payload).unwrap();
            assert_eq!(payload["threadId"], "managed");
            assert_eq!(payload["status"], expected);
            assert_eq!(payload["taskName"], "Current task name");
            assert_eq!(payload["tag"], delivery.topic);
        }

        let outside = codex_app_server::decode_notification(
            "turn/completed",
            json!({
                "threadId": "outside-caffold",
                "turn": { "id": "turn-outside", "status": "completed" }
            }),
        )
        .unwrap();
        runtime.handle_terminal_push(&outside, Some("Outside task"), true);

        let nonterminal = codex_app_server::decode_notification(
            "turn/completed",
            json!({
                "threadId": "managed",
                "turn": { "id": "turn-running", "status": "inProgress" }
            }),
        )
        .unwrap();
        runtime.handle_terminal_push(&nonterminal, Some("Current task name"), true);

        let unsafe_turn = codex_app_server::decode_notification(
            "turn/completed",
            json!({
                "threadId": "managed",
                "turn": { "id": "../unsafe", "status": "completed" }
            }),
        )
        .unwrap();
        runtime.handle_terminal_push(&unsafe_turn, Some("Current task name"), true);

        let stale_completion = codex_app_server::decode_notification(
            "turn/completed",
            json!({
                "threadId": "managed",
                "turn": { "id": "turn-stale", "status": "completed" }
            }),
        )
        .unwrap();
        runtime.handle_terminal_push(&stale_completion, Some("Current task name"), false);
        assert!(deliveries.try_recv().is_err());
    }

    #[test]
    fn token_usage_notifications_are_retained_for_live_diagnostics() {
        let runtime = runtime_with_events_and_store(
            TaskEvents::default(),
            TaskStore::memory().expect("in-memory task store"),
        );

        runtime.handle_notification(
            codex_app_server::decode_notification(
                "thread/tokenUsage/updated",
                json!({
                    "threadId": "thread_usage",
                    "turnId": "turn_2",
                    "tokenUsage": {
                        "total": {
                            "totalTokens": 1234,
                            "inputTokens": 1000,
                            "cachedInputTokens": 800,
                            "cacheWriteInputTokens": 0,
                            "outputTokens": 234,
                            "reasoningOutputTokens": 34
                        },
                        "last": {
                            "totalTokens": 345,
                            "inputTokens": 300,
                            "cachedInputTokens": 250,
                            "cacheWriteInputTokens": 0,
                            "outputTokens": 45,
                            "reasoningOutputTokens": 5
                        },
                        "modelContextWindow": 128000
                    }
                }),
            )
            .unwrap(),
        );

        let diagnostics = runtime.usage_diagnostics();
        let usage = diagnostics
            .threads
            .get("thread_usage")
            .expect("thread usage diagnostics");
        assert_eq!(usage.turn_id, "turn_2");
        assert_eq!(usage.token_usage.total.total_tokens, 1234);
        assert_eq!(usage.token_usage.last.cached_input_tokens, 250);
        assert_eq!(usage.token_usage.model_context_window, Some(128000));
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
