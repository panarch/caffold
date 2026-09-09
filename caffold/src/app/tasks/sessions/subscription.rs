use super::SubscriptionTransition;

use std::sync::Arc;
use std::time::Duration;

use tokio::time::{Instant, sleep_until};

use crate::agent::AgentError;
use crate::agent::{Conversation, Driver, TurnPage};

use super::{
    ConversationSettings, RequestLease, SessionEntry, SessionLifecycle, SessionSnapshot,
    SessionState, SessionTurnPage, TaskSessions, ViewerLease, now_unix_ms, snapshot,
};
use super::{
    reconciliation::{apply_opened_conversation, apply_prompt_resume, apply_stale_refresh},
    turns::{active_turn_id, update_active_turn},
};

const VIEWER_HANDOFF_GRACE: Duration = Duration::from_millis(250);

impl Drop for ViewerLease {
    fn drop(&mut self) {
        let sessions = self.sessions.clone();
        let thread_id = self.thread_id.clone();
        let entry = self.entry.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                sessions.release_viewer(&thread_id, &entry).await;
            });
        }
    }
}

impl Drop for RequestLease {
    fn drop(&mut self) {
        let sessions = self.sessions.clone();
        let thread_id = self.thread_id.clone();
        let entry = self.entry.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let deadline = {
                    let mut state = entry.state.lock().await;
                    state.request_leases -= 1;
                    state.defer_unsubscribe()
                };
                sleep_until(deadline).await;
                sessions.unsubscribe_if_unused(&thread_id, &entry).await;
            });
        }
    }
}

impl TaskSessions {
    pub(in crate::app::tasks) async fn reserve_request(&self, thread_id: &str) -> RequestLease {
        let entry = self.entry(thread_id).await;
        entry.state.lock().await.request_leases += 1;
        RequestLease {
            sessions: self.clone(),
            thread_id: thread_id.to_string(),
            entry,
        }
    }

    pub(in crate::app::tasks) async fn acquire_viewer(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<ViewerLease, AgentError> {
        let viewer = self.reserve_viewer(thread_id).await;
        if let Err(error) = self.ensure_subscribed(driver, generation, thread_id).await {
            drop(viewer);
            return Err(error);
        }
        Ok(viewer)
    }

    pub(in crate::app::tasks) async fn reserve_viewer(&self, thread_id: &str) -> ViewerLease {
        let entry = self.entry(thread_id).await;
        {
            let mut state = entry.state.lock().await;
            state.viewer_leases += 1;
        }
        ViewerLease {
            sessions: self.clone(),
            thread_id: thread_id.to_string(),
            entry,
        }
    }

    pub(in crate::app::tasks) async fn ensure_subscribed(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<SessionSnapshot, AgentError> {
        self.open_subscription(driver, generation, thread_id, OpenKind::History)
            .await
    }

    pub(in crate::app::tasks) async fn load_metadata(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<SessionSnapshot, AgentError> {
        self.ensure_subscribed(driver, generation, thread_id).await
    }

    pub(in crate::app::tasks) async fn refresh_subscription(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<SessionSnapshot, AgentError> {
        self.open_subscription(driver, generation, thread_id, OpenKind::Refresh)
            .await
    }

    pub(super) async fn resume_for_prompt(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<SessionSnapshot, AgentError> {
        self.open_subscription(driver, generation, thread_id, OpenKind::Prompt)
            .await
    }

    async fn open_subscription(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
        kind: OpenKind,
    ) -> Result<SessionSnapshot, AgentError> {
        let entry = self.entry(thread_id).await;
        let driver = driver.clone();
        let thread_id = thread_id.to_string();
        // Dropping an HTTP request cannot cancel a provider mutation already
        // sent. Keep its operation lock and completion alive until the RPC ends.
        tokio::spawn(async move {
            let _operation = entry.operation.lock().await;
            let (preserve_subscription, base_revision, fast_mode, observation_epoch) = {
                let mut state = entry.state.lock().await;
                let subscribed = state.generation == generation
                    && state.lifecycle == SessionLifecycle::Subscribed;
                if subscribed && kind != OpenKind::Refresh {
                    return Ok(snapshot(&state));
                }
                if !subscribed {
                    if state.generation != generation {
                        state.events.invalidate_continuity(&thread_id);
                    }
                    state.transition(SubscriptionTransition::BeginOpen);
                    state.on_connection(&driver, generation);
                    state.terminal_candidate_turn_id = None;
                    state.last_error = None;
                }
                (
                    subscribed,
                    state.revision,
                    state.fast_mode,
                    state.observation_epoch,
                )
            };
            let opened = driver
                .open_conversation(&thread_id, kind != OpenKind::Prompt, fast_mode)
                .await;
            let mut state = entry.state.lock().await;
            if !state.same_observation(generation, observation_epoch) {
                return Err(AgentError::Failed(format!(
                    "conversation {thread_id} changed connection while being opened"
                )));
            }
            match opened {
                Ok(opened) => {
                    if kind == OpenKind::Prompt {
                        apply_prompt_resume(&mut state, &driver, generation, opened, base_revision);
                    } else if state.revision == base_revision {
                        apply_opened_conversation(
                            &mut state,
                            &driver,
                            generation,
                            opened,
                            kind == OpenKind::Refresh,
                            base_revision,
                        );
                    } else {
                        apply_stale_refresh(&mut state, &driver, generation, opened, base_revision);
                    }
                    Ok(snapshot(&state))
                }
                Err(error) => {
                    if !preserve_subscription {
                        state.transition(SubscriptionTransition::Failed);
                    }
                    state.last_error = Some(error.to_string());
                    Err(error)
                }
            }
        })
        .await
        .map_err(|error| AgentError::Failed(format!("subscription operation failed: {error}")))?
    }

    pub(in crate::app::tasks) async fn register_created_thread(
        &self,
        driver: &Driver,
        generation: u64,
        thread: Conversation,
        turns_page: Option<TurnPage>,
        settings: ConversationSettings,
    ) {
        let entry = self.entry(&thread.id).await;
        let _operation = entry.operation.lock().await;
        let mut state = entry.state.lock().await;
        let history_base_revision = turns_page.as_ref().map(|_| state.revision);
        if let Some(page) = turns_page.as_ref() {
            state
                .events
                .accept_history_page(&thread, page, state.revision, None);
            state.events.trim(&thread.id);
        }
        let turns_page = turns_page.as_ref().map(SessionTurnPage::from);
        state.transition(SubscriptionTransition::Registered);
        state.driver = Some(driver.clone());
        state.on_connection(driver, generation);
        let next_active_turn_id = active_turn_id(&thread, turns_page.as_ref());
        update_active_turn(
            &mut state,
            next_active_turn_id.clone(),
            Some(thread.cwd.clone()),
        );
        state.terminal_candidate_turn_id = next_active_turn_id;
        state.conversation = Some(thread);
        state.pending_thread_status = None;
        state.permission_mode = settings.permission_mode;
        state.model = settings.model;
        state.reasoning_effort = settings.reasoning_effort;
        state.fast_mode = settings.fast_mode;
        state.turns_page = turns_page;
        state.history_base_revision = history_base_revision;
        state.runtime_lease = false;
        state.revision = state.revision.saturating_add(1);
        state.status_revision = state.revision;
        state.name_revision = state.revision;
        state.last_sync_ms = Some(now_unix_ms());
        state.last_error = None;
    }

    async fn release_viewer(&self, thread_id: &str, entry: &Arc<SessionEntry>) {
        let deadline = {
            let mut state = entry.state.lock().await;
            state.viewer_leases -= 1;
            state.defer_unsubscribe()
        };
        sleep_until(deadline).await;
        self.unsubscribe_if_unused(thread_id, entry).await;
    }

    pub(super) async fn unsubscribe_if_unused(&self, thread_id: &str, entry: &Arc<SessionEntry>) {
        let entry = entry.clone();
        let thread_id = thread_id.to_string();
        if let Err(error) = tokio::spawn(async move {
            // The provider must finish detaching before a new consumer resumes.
            // New demand may be recorded meanwhile; it cannot cancel an RPC that
            // the provider has already accepted.
            let _operation = entry.operation.lock().await;
            let (driver, generation, observation_epoch) = {
                let mut state = entry.state.lock().await;
                if state.lifecycle != SessionLifecycle::Subscribed
                    || state.has_demand()
                    || state
                        .handoff_until
                        .is_some_and(|until| until > Instant::now())
                {
                    return;
                }
                let Some(driver) = state.driver.clone() else {
                    return;
                };
                let generation = state.generation;
                state.transition(SubscriptionTransition::BeginClose);
                (driver, generation, state.observation_epoch)
            };

            let result = driver.stop_watching(&thread_id).await;
            let mut state = entry.state.lock().await;
            if !state.same_observation(generation, observation_epoch)
                || state.lifecycle != SessionLifecycle::Unsubscribing
            {
                return;
            }
            match result {
                Ok(()) => {
                    state.transition(SubscriptionTransition::Closed);
                    state.driver = None;
                    state.terminal_candidate_turn_id = None;
                    state.last_error = None;
                }
                Err(error) => {
                    state.transition(SubscriptionTransition::Failed);
                    state.last_error = Some(error.to_string());
                }
            }
        })
        .await
        {
            eprintln!("subscription cleanup failed: {error}");
        }
    }
}

impl SessionState {
    fn defer_unsubscribe(&mut self) -> Instant {
        let deadline = Instant::now() + VIEWER_HANDOFF_GRACE;
        self.handoff_until = Some(deadline);
        deadline
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum OpenKind {
    History,
    Refresh,
    Prompt,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

    #[tokio::test]
    async fn a_failed_open_returns_the_viewers_lease() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "thread/resume",
            CodexThreadError::ProcessUnavailable,
        )]);
        let sessions = TaskSessions::default();
        assert!(
            sessions
                .acquire_viewer(&client.driver(), 1, "thread-1")
                .await
                .is_err()
        );
        tokio::time::timeout(Duration::from_secs(1), async {
            while sessions.diagnostics().await.viewer_leases != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("failed opens release viewer demand");
        assert_eq!(
            sessions.snapshot("thread-1").await.unwrap().lifecycle,
            SessionLifecycle::Error
        );
        assert_eq!(methods(&client).await, ["thread/resume"]);
    }

    #[tokio::test]
    async fn a_late_unsubscribe_cannot_erase_connection_loss() {
        let (closing, release) =
            MockCodexResponse::gated_ok("thread/unsubscribe", json!({"status":"unsubscribed"}));
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, vec![], vec![]),
            ),
            closing,
        ]);
        let sessions = TaskSessions::default();
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        let closing = {
            let sessions = sessions.clone();
            let entry = sessions.entry("thread-1").await;
            tokio::spawn(async move {
                sessions.unsubscribe_if_unused("thread-1", &entry).await;
            })
        };
        wait_for_unsubscribe(&client).await;
        sessions
            .codex_connection_lost(1, "connection lost".to_string())
            .await;
        release.send(()).unwrap();
        closing.await.unwrap();
        let snapshot = sessions.snapshot("thread-1").await.unwrap();
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Error);
        assert_eq!(snapshot.last_error.as_deref(), Some("connection lost"));
    }

    #[tokio::test]
    async fn opening_history_cannot_restore_evidence_after_its_observation_ends() {
        use crate::app::tasks::test_support::wait_for_mock_method_count;
        // The same admission rule owns initial open, explicit reopen, and a
        // refresh of an already subscribed conversation.
        for mode in 0..3 {
            let (pending, release) = MockCodexResponse::gated_ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Idle,
                    vec![],
                    vec![wire_turn("stale", TurnStatus::Completed)],
                ),
            );
            let mut responses = Vec::new();
            if mode == 2 {
                responses.push(MockCodexResponse::ok(
                    "thread/resume",
                    resume_response(
                        ThreadStatus::Idle,
                        vec![],
                        vec![wire_turn("kept", TurnStatus::Completed)],
                    ),
                ));
            }
            responses.push(pending);
            let client = CodexThreadClient::mock(responses);
            let sessions = TaskSessions::default();
            if mode == 2 {
                sessions
                    .ensure_subscribed(&client.driver(), 1, "thread-1")
                    .await
                    .unwrap();
            }
            let before = sessions.events.for_thread("thread-1");
            let opening = {
                let sessions = sessions.clone();
                let driver = client.driver();
                tokio::spawn(async move {
                    if mode == 0 {
                        sessions.ensure_subscribed(&driver, 1, "thread-1").await
                    } else {
                        sessions.refresh_subscription(&driver, 1, "thread-1").await
                    }
                })
            };
            wait_for_mock_method_count(&client, "thread/resume", if mode == 2 { 2 } else { 1 })
                .await;
            sessions
                .codex_connection_lost(1, "observation ended".into())
                .await;
            release.send(()).unwrap();
            assert!(opening.await.unwrap().is_err());
            assert_eq!(sessions.events.for_thread("thread-1"), before);
            let state = sessions.snapshot("thread-1").await.unwrap();
            assert_eq!(state.lifecycle, SessionLifecycle::Error);
            assert_eq!(state.last_error.as_deref(), Some("observation ended"));
        }
    }

    #[tokio::test]
    async fn initial_subscription_bootstraps_only_from_resume() {
        let initial_turns = (0..INITIAL_TURNS_PAGE_SIZE)
            .map(|index| {
                wire_turn_at(
                    &format!("turn-{index}"),
                    TurnStatus::Completed,
                    index as f64,
                )
            })
            .collect::<Vec<_>>();
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), initial_turns.clone()),
        )]);
        let sessions = TaskSessions::default();

        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe viewer");
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        let requests = client.mock_requests().await;

        assert_eq!(methods(&client).await, vec!["thread/resume"]);
        assert_eq!(requests[0].1["serviceTier"], "default");
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert_eq!(snapshot.history_base_revision, Some(0));
        assert_eq!(snapshot.turns_page.expect("initial page").turns.len(), 8);
    }

    #[tokio::test]
    async fn metadata_load_shares_the_in_flight_subscription_bootstrap() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            Duration::from_millis(250),
        )]);
        let sessions = TaskSessions::default();
        let subscribing_sessions = sessions.clone();
        let subscribing_client = client.clone();
        let subscription = tokio::spawn(async move {
            subscribing_sessions
                .ensure_subscribed(&subscribing_client.driver(), 1, "thread-1")
                .await
        });

        for _ in 0..100 {
            if methods(&client).await == vec!["thread/resume"] {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        let snapshot = tokio::time::timeout(
            Duration::from_millis(500),
            sessions.load_metadata(&client.driver(), 1, "thread-1"),
        )
        .await
        .expect("metadata request shares the subscription bootstrap")
        .expect("metadata request succeeds");

        assert_eq!(
            snapshot.conversation.expect("thread metadata").id,
            "thread-1"
        );
        assert_eq!(methods(&client).await, vec!["thread/resume"]);
        subscription
            .await
            .expect("subscription task joins")
            .expect("subscription eventually succeeds");
    }

    #[tokio::test]
    async fn metadata_load_bootstraps_from_resume_without_thread_read() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Idle,
                Vec::new(),
                vec![wire_turn("turn-latest", TurnStatus::Completed)],
            ),
        )]);
        let sessions = TaskSessions::default();

        let snapshot = sessions
            .load_metadata(&client.driver(), 1, "thread-1")
            .await
            .expect("metadata bootstrap succeeds");

        assert_eq!(methods(&client).await, vec!["thread/resume"]);
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert_eq!(
            snapshot
                .turns_page
                .expect("initial turns page")
                .turns
                .first()
                .map(|turn| turn.id.as_str()),
            Some("turn-latest")
        );
    }

    #[tokio::test]
    async fn viewers_share_one_subscription_and_last_viewer_unsubscribes() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let sessions = TaskSessions::default();

        let first = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("first viewer");
        let second = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("second viewer");
        assert_eq!(methods(&client).await, vec!["thread/resume"]);

        drop(first);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(methods(&client).await, vec!["thread/resume"]);

        drop(second);
        wait_for_unsubscribe(&client).await;
        assert_eq!(
            methods(&client).await,
            vec!["thread/resume", "thread/unsubscribe"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_detail_to_stream_handoff_reuses_the_subscription() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, vec![], vec![]),
        )]);
        let sessions = TaskSessions::default();
        let viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        drop(viewer);
        while sessions.snapshot("thread-1").await.unwrap().viewer_leases != 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(249)).await;
        let _stream = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        tokio::time::advance(Duration::from_millis(1)).await;
        assert_eq!(methods(&client).await, ["thread/resume"]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_created_tasks_request_hands_its_subscription_to_the_first_viewer() {
        let client = CodexThreadClient::mock(vec![]);
        let sessions = TaskSessions::default();
        let request = sessions.reserve_request("thread-1").await;
        sessions
            .register_created_thread(
                &client.driver(),
                1,
                Conversation::from(&thread(ThreadStatus::Idle, vec![])),
                None,
                ConversationSettings::default(),
            )
            .await;
        drop(request);
        while sessions.diagnostics().await.request_leases != 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(249)).await;
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        tokio::time::advance(Duration::from_millis(1)).await;
        let target = sessions
            .prepare_prompt(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        assert!(matches!(target, PromptTarget::Start { .. }));
        assert!(methods(&client).await.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn an_older_handoff_timer_cannot_shorten_a_later_handoff() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, vec![], vec![]),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({"status":"unsubscribed"})),
        ]);
        let sessions = TaskSessions::default();
        let first = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        drop(first);
        while sessions.snapshot("thread-1").await.unwrap().viewer_leases != 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(200)).await;
        let second = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        drop(second);
        while sessions.snapshot("thread-1").await.unwrap().viewer_leases != 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(249)).await;
        tokio::task::yield_now().await;
        assert_eq!(methods(&client).await, ["thread/resume"]);
        tokio::time::advance(Duration::from_millis(1)).await;
        wait_for_unsubscribe(&client).await;
        assert_eq!(
            methods(&client).await,
            ["thread/resume", "thread/unsubscribe"]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_observation_cannot_bypass_the_handoff_grace() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, vec![], vec![]),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({"status":"unsubscribed"})),
        ]);
        let sessions = TaskSessions::default();
        let viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        drop(viewer);
        while sessions.snapshot("thread-1").await.unwrap().viewer_leases != 0 {
            tokio::task::yield_now().await;
        }
        let before = tokio::time::Instant::now();
        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::StatusChanged {
                        status: ThreadStatus::Idle,
                    },
                ),
            )
            .await;
        assert_eq!(before.elapsed(), Duration::ZERO);
        tokio::time::advance(Duration::from_millis(249)).await;
        assert_eq!(methods(&client).await, ["thread/resume"]);
        tokio::time::advance(Duration::from_millis(1)).await;
        wait_for_unsubscribe(&client).await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_detail_to_stream_gap_resumes_safely_after_the_handoff_grace() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, vec![], vec![]),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({"status":"unsubscribed"})),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, vec![], vec![]),
            ),
        ]);
        let sessions = TaskSessions::default();
        let viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        drop(viewer);
        while sessions.snapshot("thread-1").await.unwrap().viewer_leases != 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(Duration::from_millis(250)).await;
        while sessions.snapshot("thread-1").await.unwrap().lifecycle != SessionLifecycle::Unloaded {
            tokio::task::yield_now().await;
        }
        let _stream = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        assert_eq!(
            methods(&client).await,
            ["thread/resume", "thread/unsubscribe", "thread/resume"]
        );
        assert_eq!(
            sessions.snapshot("thread-1").await.unwrap().lifecycle,
            SessionLifecycle::Subscribed
        );
    }

    #[tokio::test]
    async fn a_new_viewer_resumes_after_the_in_flight_unsubscribe_finishes() {
        let (closing, release) =
            MockCodexResponse::gated_ok("thread/unsubscribe", json!({"status":"unsubscribed"}));
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, vec![], vec![]),
            ),
            closing,
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, vec![], vec![]),
            ),
        ]);
        let sessions = TaskSessions::default();
        let viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        drop(viewer);
        wait_for_unsubscribe(&client).await;
        let opening = {
            let sessions = sessions.clone();
            let driver = client.driver();
            tokio::spawn(async move { sessions.acquire_viewer(&driver, 1, "thread-1").await })
        };
        while sessions.snapshot("thread-1").await.unwrap().viewer_leases == 0 {
            tokio::task::yield_now().await;
        }
        assert!(!opening.is_finished());
        assert_eq!(
            methods(&client).await,
            ["thread/resume", "thread/unsubscribe"]
        );
        release.send(()).unwrap();
        let _viewer = opening.await.unwrap().unwrap();
        let snapshot = sessions.snapshot("thread-1").await.unwrap();
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert_eq!(snapshot.viewer_leases, 1);
        assert_eq!(
            methods(&client).await,
            ["thread/resume", "thread/unsubscribe", "thread/resume"]
        );
    }

    #[tokio::test]
    async fn idle_and_title_observations_cannot_release_an_unfinished_prompt_request() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, vec![], vec![]),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({"status":"unsubscribed"})),
        ]);
        let sessions = TaskSessions::default();
        let request = sessions.reserve_request("thread-1").await;
        let target = sessions
            .prepare_prompt(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        assert!(matches!(target, PromptTarget::Start { .. }));
        for kind in [
            SessionEventKind::TitleChanged {
                title: Some("accepted title".into()),
            },
            SessionEventKind::StatusChanged {
                status: ThreadStatus::Idle,
            },
        ] {
            sessions
                .apply_session_event(1, &session_event("thread-1", kind))
                .await;
            let snapshot = sessions.snapshot("thread-1").await.unwrap();
            assert_eq!(sessions.diagnostics().await.request_leases, 1);
            assert!(!snapshot.runtime_lease);
            assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
            assert_eq!(methods(&client).await, ["thread/resume"]);
        }
        drop(request);
        wait_for_unsubscribe(&client).await;
    }

    #[tokio::test]
    async fn cancelling_a_request_keeps_its_resume_ordered_until_cleanup() {
        let (opening, release) = MockCodexResponse::gated_ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, vec![], vec![]),
        );
        let client = CodexThreadClient::mock(vec![
            opening,
            MockCodexResponse::ok("thread/unsubscribe", json!({"status":"unsubscribed"})),
        ]);
        let sessions = TaskSessions::default();
        let request = {
            let sessions = sessions.clone();
            let driver = client.driver();
            tokio::spawn(async move {
                let _request = sessions.reserve_request("thread-1").await;
                sessions.prepare_prompt(&driver, 1, "thread-1").await
            })
        };
        wait_for_method_count(&client, "thread/resume", 1).await;
        request.abort();
        assert!(request.await.unwrap_err().is_cancelled());
        assert_eq!(methods(&client).await, ["thread/resume"]);
        release.send(()).unwrap();
        wait_for_unsubscribe(&client).await;
        let snapshot = sessions.snapshot("thread-1").await.unwrap();
        assert_eq!(sessions.diagnostics().await.request_leases, 0);
        assert!(!snapshot.runtime_lease);
    }

    #[tokio::test]
    async fn an_old_viewer_cannot_release_a_replacement_sessions_lease() {
        let sessions = TaskSessions::default();
        let old = sessions.reserve_viewer("thread-1").await;
        let old_entry = old.entry.clone();
        sessions.forget_thread("thread-1").await;
        let _new = sessions.reserve_viewer("thread-1").await;
        drop(old);
        while old_entry.state.lock().await.viewer_leases != 0 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            sessions.snapshot("thread-1").await.unwrap().viewer_leases,
            1
        );
    }

    #[tokio::test]
    async fn refresh_failure_keeps_canonical_state_and_can_recover() {
        let recovered = wire_turn("turn-recovered", TurnStatus::InProgress);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::error("thread/resume", CodexThreadError::ProcessUnavailable),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Active {
                        active_flags: Vec::new(),
                    },
                    Vec::new(),
                    vec![recovered],
                ),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        assert!(
            sessions
                .refresh_subscription(&client.driver(), 1, "thread-1")
                .await
                .is_err()
        );
        let failed = sessions
            .snapshot("thread-1")
            .await
            .expect("failed snapshot");
        assert!(
            failed
                .conversation
                .is_some_and(|thread| thread.status == ThreadStatus::Idle)
        );

        let recovered = sessions
            .refresh_subscription(&client.driver(), 1, "thread-1")
            .await
            .expect("recover refresh");
        assert_eq!(recovered.active_turn_id.as_deref(), Some("turn-recovered"));
        assert!(recovered.last_error.is_none());
    }

    #[tokio::test]
    async fn registered_created_thread_is_subscribed_without_a_runtime_lease() {
        let client = CodexThreadClient::mock(Vec::new());
        let sessions = TaskSessions::default();
        sessions
            .register_created_thread(
                &client.driver(),
                1,
                Conversation::from(&thread(ThreadStatus::Idle, Vec::new())),
                None,
                ConversationSettings {
                    permission_mode: Some("askForApproval".to_string()),
                    model: Some("gpt-test".to_string()),
                    reasoning_effort: Some("xhigh".to_string()),
                    fast_mode: true,
                },
            )
            .await;

        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert!(!snapshot.runtime_lease);
        assert!(snapshot.active_turn_id.is_none());
        assert_eq!(snapshot.model.as_deref(), Some("gpt-test"));
        assert_eq!(snapshot.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(snapshot.fast_mode);
        assert!(methods(&client).await.is_empty());
    }
}
