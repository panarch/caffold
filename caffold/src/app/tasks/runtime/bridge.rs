use futures_util::{StreamExt, stream};
use serde_json::json;
use tokio::sync::broadcast;

use super::{CodexConnection, TaskRuntime, TaskRuntimeSignal};
use crate::agent::codex::{CodexRuntimeEvent, CodexThreadClient, session_event};
use crate::agent::{SessionEvent, SessionEventKind, ThreadStatus, TurnStatus};
use crate::app::tasks::events::{
    now_ms, task_event_from_item, task_event_record, turn_completed_event, turn_started_event,
};
use crate::app::tasks::push;

impl TaskRuntime {
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
                                if let Some(reported) =
                                    session_event(&notification, &client).await
                                {
                                    runtime.handle_session_event(generation, reported).await;
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
                .codex_connection_lost(generation, connection_error.clone())
                .await;
            for thread_id in affected {
                runtime.events.invalidate_continuity(&thread_id);
                let _ = runtime.signals.send(TaskRuntimeSignal::SessionUnavailable {
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
                .resubscribe_leased_codex_threads(&connection.driver(), connection.generation)
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
                            &connection.driver(),
                            connection.generation,
                            &thread_id,
                        )
                        .await
                    {
                        Ok(Some(snapshot)) => {
                            let _ = runtime.signals.send(TaskRuntimeSignal::SessionChanged {
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

    /// Everything Caffold does about one report from the live stream.
    ///
    /// The canonical session takes it first, because the rest depends on what it
    /// did: whether the session actually moved decides whether readers are told,
    /// and whether this is the first time a turn ended decides whether a phone
    /// is notified.
    pub(super) async fn handle_session_event(&self, generation: u64, event: SessionEvent) {
        let outcome = self
            .sessions
            .apply_session_event_with_outcome(generation, &event)
            .await;
        if !outcome.accepted {
            return;
        }
        let snapshot = if outcome.canonical_state_changed {
            self.sessions.snapshot(&event.thread_id).await
        } else {
            None
        };
        self.handle_terminal_push(
            &event,
            outcome
                .terminal
                .is_some_and(|terminal| terminal.first_current_transition),
        );
        self.withdraw_unanswerable_approvals(&event).await;
        self.record_reported_usage(&event);
        if let Some(session_revision) = outcome.revision {
            self.publish_session_event(&event, session_revision);
        }
        if let Some(snapshot) = snapshot {
            let _ = self.signals.send(TaskRuntimeSignal::SessionChanged {
                thread_id: event.thread_id,
                snapshot: Box::new(snapshot),
            });
        }
    }

    /// Say what the agent did, in the Task's own stream of events.
    fn publish_session_event(&self, event: &SessionEvent, session_revision: u64) {
        let thread_id = event.thread_id.as_str();
        match &event.kind {
            SessionEventKind::TurnStarted { turn } => {
                let started_ms = turn.started_at_ms.unwrap_or_else(now_ms);
                match self
                    .task_store
                    .update_observed_recency(thread_id, started_ms)
                {
                    Ok(Some(_)) => self.refresh_persisted_task_list(),
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!(
                            "failed to persist started turn recency for {thread_id}: {error}"
                        );
                    }
                }
                self.events.publish_provider_lifecycle(
                    turn_started_event(thread_id, turn, started_ms),
                    session_revision,
                );
            }
            SessionEventKind::StatusChanged { status }
            | SessionEventKind::ActivityChanged { status } => {
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
                self.events.publish_provider_lifecycle(
                    task_event_record(
                        thread_id,
                        "thread_status_changed",
                        "thread_status_changed",
                        summary,
                        Some(json!({
                            "threadId": thread_id,
                            "status": task_status,
                        })),
                        now_ms(),
                    ),
                    session_revision,
                );
            }
            SessionEventKind::ItemChanged {
                turn_id,
                item,
                at_ms,
            } => {
                if let Some(record) =
                    task_event_from_item(thread_id, turn_id, at_or_now(*at_ms), item)
                {
                    self.events
                        .publish_provider_lifecycle(record, session_revision);
                }
            }
            SessionEventKind::TurnEnded { turn } => {
                let completed_ms = turn.completed_at_ms.unwrap_or_else(now_ms);
                match self
                    .task_store
                    .record_completed_turn(thread_id, completed_ms)
                {
                    Ok(Some(_)) => self.refresh_persisted_task_list(),
                    Ok(None) => {}
                    Err(error) => {
                        eprintln!("failed to persist completed turn for {thread_id}: {error}");
                    }
                }
                self.events.publish_provider_lifecycle(
                    turn_completed_event(thread_id, turn, completed_ms),
                    session_revision,
                );
            }
            // The diff itself is not carried: Caffold reviews changes from git,
            // which owns the working tree the agent wrote to. What this says is
            // that there is something new to review.
            SessionEventKind::DiffChanged => {
                self.events.publish_provider_lifecycle(
                    task_event_record(
                        thread_id,
                        "diff_updated",
                        "diff_updated",
                        "Diff updated",
                        Some(json!({ "threadId": thread_id })),
                        now_ms(),
                    ),
                    session_revision,
                );
            }
            SessionEventKind::ConversationStarted { .. }
            | SessionEventKind::TitleChanged { .. }
            | SessionEventKind::SettingsChanged { .. }
            | SessionEventKind::UsageReported { .. }
            | SessionEventKind::ApprovalAnsweredElsewhere { .. } => {}
        }
    }

    /// Keep what the agent says the conversation has cost, for diagnostics.
    fn record_reported_usage(&self, event: &SessionEvent) {
        let SessionEventKind::UsageReported { turn_id, usage } = &event.kind else {
            return;
        };
        self.record_token_usage(&event.thread_id, turn_id, usage);
    }

    /// Tell a phone that a turn ended, the once.
    ///
    /// The name it carries is the one Caffold keeps for the Task. A session
    /// title is the agent's own, and not every agent reports one back, so a
    /// name read from the session would be whatever the agent running this
    /// Task happens to say — or nothing at all.
    fn handle_terminal_push(&self, event: &SessionEvent, terminal_turn_is_first_current: bool) {
        let SessionEventKind::TurnEnded { turn } = &event.kind else {
            return;
        };
        if !terminal_turn_is_first_current {
            eprintln!(
                "Web Push terminal delivery skipped because the turn was not current or was already terminal"
            );
            return;
        }
        let Some(push) = self.push.as_ref() else {
            return;
        };
        let status = match turn.status {
            TurnStatus::Completed => push::TerminalPushStatus::Completed,
            TurnStatus::Failed => push::TerminalPushStatus::Failed,
            TurnStatus::Interrupted => push::TerminalPushStatus::Interrupted,
            TurnStatus::InProgress => return,
        };
        let thread_id = event.thread_id.as_str();
        match self.task_store.get(thread_id) {
            Ok(Some(managed)) => {
                let queued =
                    push.notify_terminal(thread_id, &turn.id, status, &managed.display_name);
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

/// The time the agent reported, or now when it reported none.
fn at_or_now(reported_ms: u64) -> u64 {
    if reported_ms > 0 {
        reported_ms
    } else {
        now_ms()
    }
}

#[cfg(test)]
mod tests {
    use crate::agent;
    use std::time::Duration;

    use serde_json::{Value as JsonValue, json};

    use super::*;
    use crate::{
        agent::codex::{self, CodexNotification, CodexThreadClient, MockCodexResponse},
        app::tasks::push::PushService,
        app::tasks::sessions::TaskSessions,
        app::tasks::{
            events::TaskEvents, lifecycle::TaskLifecycle, routes::TaskListEvents,
            worktrees::ManagedWorktrees,
        },
        fs::RootedFs,
        task_store::{ManagedThread, PushSubscriptionInput, RunBy, TaskStore},
    };

    fn runtime_with_events_and_store(events: TaskEvents, store: TaskStore) -> TaskRuntime {
        let (shutdown, _) = broadcast::channel(1);
        let (claude, _runner) = agent::claude::ClaudeClient::mock();
        TaskRuntime::new(claude, TaskSessions::default(), events, store, shutdown)
    }

    fn runtime_with_list_events(
        events: TaskEvents,
        store: TaskStore,
    ) -> (TaskRuntime, TaskListEvents) {
        let root = tempfile::tempdir().unwrap();
        let fs = std::sync::Arc::new(RootedFs::new(root.path()).unwrap());
        let sessions = TaskSessions::default();
        let list_events = TaskListEvents::new();
        let worktrees =
            ManagedWorktrees::new(fs.clone(), store.clone(), root.path().join("worktrees"))
                .unwrap();
        let (claude, _runner) = agent::claude::ClaudeClient::mock();
        let lifecycle = TaskLifecycle::new(
            fs,
            sessions.clone(),
            events.clone(),
            list_events.clone(),
            store.clone(),
            worktrees,
            claude.clone(),
        );
        let (shutdown, _) = broadcast::channel(1);
        (
            TaskRuntime::new(claude, sessions, events, store, shutdown).with_lifecycle(lifecycle),
            list_events,
        )
    }

    /// One notification, translated the way the bridge translates it.
    ///
    /// A client with no connection is enough: only an approval Codex answered
    /// itself needs one, and no test here sends that.
    async fn reported(method: &str, params: JsonValue) -> SessionEvent {
        let notification = codex::decode_notification(method, params).expect("Codex sends this");
        session_event(&notification, &CodexThreadClient::mock(Vec::new()))
            .await
            .expect("the notification says something Caffold acts on")
    }

    /// One installation subscribed to this Caffold, so that a terminal turn
    /// has somewhere to be delivered.
    fn subscribed_installation() -> PushSubscriptionInput {
        PushSubscriptionInput {
            client_id: "00000000-0000-4000-8000-000000000001".to_owned(),
            installation_label: "Chrome on macOS · 00000000".to_owned(),
            endpoint: "https://push.example.test/subscription".to_owned(),
            p256dh: "test-public-key".to_owned(),
            auth: "test-auth".to_owned(),
            expiration_time_ms: None,
        }
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
    async fn a_rejected_old_generation_report_never_enters_the_task_projection() {
        let events = TaskEvents::default();
        let mut receiver = events.subscribe();
        let runtime = runtime_with_events_and_store(
            events.clone(),
            TaskStore::memory().expect("in-memory task store"),
        );
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            active_resume("thread-old-generation"),
        )]);
        let _viewer = runtime
            .sessions
            .acquire_viewer(&client.driver(), 2, "thread-old-generation")
            .await
            .expect("current generation viewer");
        let event = SessionEvent {
            thread_id: "thread-old-generation".to_string(),
            kind: SessionEventKind::ItemChanged {
                turn_id: "turn-active".to_string(),
                item: agent::ConversationItem {
                    id: "stale-item".to_string(),
                    observed_at_ms: None,
                    status: agent::ActivityStatus::Completed,
                    kind: agent::ItemKind::Reasoning {
                        summary: vec!["stale report".to_string()],
                        content: Vec::new(),
                    },
                },
                at_ms: 10,
            },
        };

        runtime.handle_session_event(1, event).await;

        assert!(receiver.try_recv().is_err());
        assert!(events.for_thread("thread-old-generation").is_empty());
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
            .acquire_viewer(&client.driver(), 1, thread_id)
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
                    "summary": ["Read the current behavior."],
                    "content": []
                }),
                started_at_ms: 10,
            },
        ));
        client.mock_publish_event(CodexRuntimeEvent::Notification(
            CodexNotification::ThreadStatusChanged {
                thread_id: thread_id.to_string(),
                status: codex::ThreadStatus::Idle,
            },
        ));

        let event = tokio::time::timeout(Duration::from_secs(1), task_events.recv())
            .await
            .expect("item notification publishes a Task event")
            .expect("Task event channel remains open")
            .event;
        assert_eq!(event.thread_id, thread_id);
        assert_eq!(event.event_type, "reasoning");

        let signal = tokio::time::timeout(Duration::from_secs(1), signals.recv())
            .await
            .expect("canonical status change publishes a runtime signal")
            .expect("runtime signal channel remains open");
        let TaskRuntimeSignal::SessionChanged {
            thread_id: signal_thread_id,
            snapshot,
        } = signal
        else {
            panic!("expected a changed-session signal");
        };
        assert_eq!(signal_thread_id, thread_id);
        assert_eq!(snapshot.revision, initial_revision + 2);
        assert_eq!(
            snapshot.conversation.expect("canonical thread").status,
            agent::ThreadStatus::Idle
        );
    }

    #[tokio::test]
    async fn completed_turn_notification_persists_projection_and_refreshes_the_list() {
        let store = TaskStore::memory().unwrap();
        let (runtime, list_events) = runtime_with_list_events(TaskEvents::default(), store.clone());
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, Some(1_000), None, None),
                1_000,
            )
            .unwrap();

        runtime.publish_session_event(
            &reported(
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
            .await,
            1,
        );

        let stored = store.get("thread_1").unwrap().unwrap();
        assert_eq!(stored.last_completed_at_ms, Some(1_750_000_004_500));
        assert_eq!(stored.last_observed_recency_ms, Some(1_750_000_004_500));
        assert!(stored.unseen());
        assert_eq!(list_events.refresh_count(), 1);
    }

    #[tokio::test]
    async fn started_turn_notification_persists_recency_and_refreshes_the_list() {
        let store = TaskStore::memory().unwrap();
        let (runtime, list_events) = runtime_with_list_events(TaskEvents::default(), store.clone());
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, Some(1_000), None, None),
                1_000,
            )
            .unwrap();

        runtime.publish_session_event(
            &reported(
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
            .await,
            1,
        );

        let stored = store.get("thread_1").unwrap().unwrap();
        assert_eq!(stored.last_observed_recency_ms, Some(1_750_000_000_250));
        assert_eq!(list_events.refresh_count(), 1);
    }

    #[tokio::test]
    async fn terminal_push_selects_only_managed_canonical_terminal_turns() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("managed", RunBy::Codex, None, None, None),
                1_000,
            )
            .unwrap();
        store
            .update_display_name("managed", "Current task name")
            .unwrap();
        store
            .upsert_push_installation(subscribed_installation(), 1_000)
            .unwrap();
        let (push, mut deliveries) = PushService::test_channel(store.clone());
        let runtime =
            runtime_with_events_and_store(TaskEvents::default(), store).with_push_service(push);

        for (status, expected) in [
            ("completed", "completed"),
            ("failed", "failed"),
            ("interrupted", "interrupted"),
        ] {
            let ended = reported(
                "turn/completed",
                json!({
                    "threadId": "managed",
                    "turn": { "id": format!("turn-{status}"), "status": status }
                }),
            )
            .await;
            runtime.handle_terminal_push(&ended, true);
            let delivery = deliveries.try_recv().unwrap();
            let payload: JsonValue = serde_json::from_slice(&delivery.payload).unwrap();
            assert_eq!(payload["threadId"], "managed");
            assert_eq!(payload["status"], expected);
            assert_eq!(payload["taskName"], "Current task name");
            assert_eq!(payload["tag"], delivery.topic);
        }

        let outside = reported(
            "turn/completed",
            json!({
                "threadId": "outside-caffold",
                "turn": { "id": "turn-outside", "status": "completed" }
            }),
        )
        .await;
        runtime.handle_terminal_push(&outside, true);

        let nonterminal = reported(
            "turn/completed",
            json!({
                "threadId": "managed",
                "turn": { "id": "turn-running", "status": "inProgress" }
            }),
        )
        .await;
        runtime.handle_terminal_push(&nonterminal, true);

        let unsafe_turn = reported(
            "turn/completed",
            json!({
                "threadId": "managed",
                "turn": { "id": "../unsafe", "status": "completed" }
            }),
        )
        .await;
        runtime.handle_terminal_push(&unsafe_turn, true);

        let stale_completion = reported(
            "turn/completed",
            json!({
                "threadId": "managed",
                "turn": { "id": "turn-stale", "status": "completed" }
            }),
        )
        .await;
        runtime.handle_terminal_push(&stale_completion, false);
        assert!(deliveries.try_recv().is_err());
    }

    /// A session that reports no title of its own still names its Task.
    ///
    /// This is every Claude Task — a Claude session's title describes the
    /// agent's own surfaces and is never reported back — and it is any thread
    /// an agent has not named. The Task is named either way, because the name
    /// is read from the managed row rather than from the session.
    #[tokio::test]
    async fn terminal_push_names_a_task_whose_session_reports_no_title() {
        let store = TaskStore::memory().unwrap();
        let thread_id = "thread-untitled";
        store
            .claim(
                ManagedThread::new(thread_id, RunBy::Codex, None, None, None),
                1_000,
            )
            .unwrap();
        store
            .update_display_name(thread_id, "The name Caffold keeps")
            .unwrap();
        store
            .upsert_push_installation(subscribed_installation(), 1_000)
            .unwrap();
        let (push, mut deliveries) = PushService::test_channel(store.clone());
        let runtime =
            runtime_with_events_and_store(TaskEvents::default(), store).with_push_service(push);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            active_resume(thread_id),
        )]);
        let _viewer = runtime
            .sessions
            .acquire_viewer(&client.driver(), 1, thread_id)
            .await
            .expect("viewer");
        assert!(
            runtime
                .sessions
                .snapshot(thread_id)
                .await
                .expect("subscribed session")
                .conversation
                .expect("canonical thread")
                .title
                .is_none(),
            "the session under test reports no title"
        );

        runtime
            .handle_session_event(
                1,
                reported(
                    "turn/completed",
                    json!({
                        "threadId": thread_id,
                        "turn": { "id": "turn-active", "status": "completed" }
                    }),
                )
                .await,
            )
            .await;

        let delivery = deliveries
            .try_recv()
            .expect("the terminal turn reaches the subscribed installation");
        let payload: JsonValue = serde_json::from_slice(&delivery.payload).unwrap();
        assert_eq!(payload["taskName"], "The name Caffold keeps");
    }

    #[tokio::test]
    async fn token_usage_notifications_are_retained_for_live_diagnostics() {
        let runtime = runtime_with_events_and_store(
            TaskEvents::default(),
            TaskStore::memory().expect("in-memory task store"),
        );

        runtime.record_reported_usage(
            &reported(
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
            .await,
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
            .claim(
                ManagedThread::new("managed", RunBy::Codex, None, None, None),
                10,
            )
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

    #[tokio::test]
    async fn codex_notifications_publish_live_task_status() {
        let events = TaskEvents::default();
        let mut receiver = events.subscribe();
        let runtime = runtime_with_events_and_store(
            events.clone(),
            TaskStore::memory().expect("in-memory task store"),
        );

        runtime.publish_session_event(
            &reported(
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
            .await,
            2,
        );
        let started = receiver.try_recv().unwrap().event;
        assert_eq!(started.thread_id, "thread_1");
        assert_eq!(started.event_type, "turn_started");
        assert_eq!(started.position.anchor_ms, 1_750_000_000_250);
        assert_eq!(started.payload.as_ref().unwrap()["turnId"], "turn_1");

        runtime.publish_session_event(
            &reported(
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
            .await,
            3,
        );
        let command_started = receiver.try_recv().unwrap().event;
        assert_eq!(command_started.event_type, "command_execution");
        assert_eq!(command_started.position.anchor_ms, 1_750_000_001_000);
        assert_eq!(
            command_started.payload.as_ref().unwrap()["status"],
            "inProgress"
        );
        let cached_command = events
            .for_thread("thread_1")
            .into_iter()
            .find(|event| event.id == command_started.id)
            .expect("notification bridge should cache commands without an SSE consumer");
        assert_eq!(cached_command.event_type, "command_execution");

        runtime.publish_session_event(
            &reported(
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
            .await,
            4,
        );
        // Codex announces reasoning before writing any of it, and an empty
        // bubble is worse than waiting for the words.
        assert!(receiver.try_recv().is_err());

        runtime.publish_session_event(
            &reported(
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
            .await,
            5,
        );
        let reasoning_completed = receiver.try_recv().unwrap().event;
        assert_eq!(reasoning_completed.event_type, "reasoning");
        // The entry still belongs where the item started, not where it ended.
        assert_eq!(reasoning_completed.position.anchor_ms, 1_750_000_003_000);
        assert_eq!(
            reasoning_completed.payload.as_ref().unwrap()["status"],
            "completed"
        );

        runtime.publish_session_event(
            &reported(
                "thread/status/changed",
                json!({
                    "threadId": "thread_1",
                    "status": { "type": "active", "activeFlags": [] }
                }),
            )
            .await,
            6,
        );
        let status = receiver.try_recv().unwrap().event;
        assert_eq!(status.thread_id, "thread_1");
        assert_eq!(status.event_type, "thread_status_changed");
        assert_eq!(status.payload.as_ref().unwrap()["status"], "running");

        runtime.publish_session_event(
            &reported(
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
            .await,
            7,
        );
        let completed = receiver.try_recv().unwrap().event;
        assert_eq!(completed.event_type, "turn_completed");
        assert_eq!(completed.position.anchor_ms, 1_750_000_004_500);
    }

    #[test]
    fn independent_activity_publishes_the_existing_task_status_event() {
        let events = TaskEvents::default();
        let mut receiver = events.subscribe();
        let runtime = runtime_with_events_and_store(
            events,
            TaskStore::memory().expect("in-memory task store"),
        );

        runtime.publish_session_event(
            &SessionEvent {
                thread_id: "claude-thread".to_string(),
                kind: SessionEventKind::ActivityChanged {
                    status: ThreadStatus::Active {
                        active_flags: Vec::new(),
                    },
                },
            },
            1,
        );

        let status = receiver.try_recv().expect("published status").event;
        assert_eq!(status.thread_id, "claude-thread");
        assert_eq!(status.event_type, "thread_status_changed");
        assert_eq!(status.payload.expect("status payload")["status"], "running");
    }
}
