use std::sync::Arc;

use crate::agent::AgentError;
use crate::agent::{Conversation, Driver};

use super::{
    SessionEntry, SessionLifecycle, SessionSnapshot, StartedSettings, TaskSessions,
    VIEWER_HANDOFF_GRACE, ViewerLease, now_unix_ms, snapshot,
};
use super::{
    reconciliation::{apply_opened_conversation, apply_stale_refresh},
    turns::{active_turn_id, update_active_turn},
};

impl Drop for ViewerLease {
    fn drop(&mut self) {
        let sessions = self.sessions.clone();
        let thread_id = self.thread_id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                sessions.release_viewer(&thread_id).await;
            });
        }
    }
}

impl TaskSessions {
    pub(in crate::app::tasks) async fn acquire_viewer(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<ViewerLease, AgentError> {
        let viewer = self.reserve_viewer(thread_id).await;
        if let Err(error) = self.ensure_subscribed(driver, generation, thread_id).await {
            let entry = self.entry(thread_id).await;
            let mut state = entry.state.lock().await;
            state.viewer_leases = state.viewer_leases.saturating_sub(1);
            state.viewer_epoch = state.viewer_epoch.saturating_add(1);
            std::mem::forget(viewer);
            return Err(error);
        }
        Ok(viewer)
    }

    pub(in crate::app::tasks) async fn reserve_viewer(&self, thread_id: &str) -> ViewerLease {
        let entry = self.entry(thread_id).await;
        {
            let mut state = entry.state.lock().await;
            state.viewer_leases += 1;
            state.viewer_epoch = state.viewer_epoch.saturating_add(1);
        }
        ViewerLease {
            sessions: self.clone(),
            thread_id: thread_id.to_string(),
        }
    }

    pub(in crate::app::tasks) async fn ensure_subscribed(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<SessionSnapshot, AgentError> {
        let entry = self.entry(thread_id).await;
        let _operation = entry.operation.lock().await;
        {
            let state = entry.state.lock().await;
            if state.generation == generation && state.lifecycle == SessionLifecycle::Subscribed {
                return Ok(snapshot(&state));
            }
        }

        let (base_revision, fast_mode) = {
            let mut state = entry.state.lock().await;
            state.lifecycle = SessionLifecycle::Subscribing;
            state.on_connection(driver, generation);
            state.terminal_candidate_turn_id = None;
            state.last_error = None;
            (state.revision, state.fast_mode)
        };
        match driver.open_conversation(thread_id, true, fast_mode).await {
            Ok(opened) => {
                let mut state = entry.state.lock().await;
                if state.generation != generation {
                    return Err(AgentError::Failed(format!(
                        "conversation {thread_id} changed connection while being opened"
                    )));
                }
                if state.revision == base_revision {
                    apply_opened_conversation(&mut state, driver, generation, opened, false);
                } else {
                    apply_stale_refresh(&mut state, driver, generation, opened, base_revision);
                }
                Ok(snapshot(&state))
            }
            Err(error) => {
                let mut state = entry.state.lock().await;
                state.lifecycle = SessionLifecycle::Error;
                state.last_error = Some(error.to_string());
                Err(error)
            }
        }
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
        let entry = self.entry(thread_id).await;
        let _operation = entry.operation.lock().await;
        let (preserve_subscription, base_revision, fast_mode) = {
            let state = entry.state.lock().await;
            (
                state.generation == generation && state.lifecycle == SessionLifecycle::Subscribed,
                state.revision,
                state.fast_mode,
            )
        };

        if !preserve_subscription {
            let mut state = entry.state.lock().await;
            state.lifecycle = SessionLifecycle::Subscribing;
            state.on_connection(driver, generation);
            state.terminal_candidate_turn_id = None;
            state.last_error = None;
        }

        match driver.open_conversation(thread_id, true, fast_mode).await {
            Ok(opened) => {
                let mut state = entry.state.lock().await;
                if preserve_subscription && state.generation != generation {
                    return Err(AgentError::Failed(format!(
                        "conversation {thread_id} changed connection while being reopened"
                    )));
                }
                if state.revision == base_revision {
                    apply_opened_conversation(&mut state, driver, generation, opened, true);
                } else {
                    apply_stale_refresh(&mut state, driver, generation, opened, base_revision);
                }
                Ok(snapshot(&state))
            }
            Err(error) => {
                let mut state = entry.state.lock().await;
                if !preserve_subscription {
                    state.lifecycle = SessionLifecycle::Error;
                }
                state.last_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    pub(in crate::app::tasks) async fn register_started_thread(
        &self,
        driver: &Driver,
        generation: u64,
        thread: Conversation,
        settings: StartedSettings,
    ) {
        let entry = self.entry(&thread.id).await;
        let mut state = entry.state.lock().await;
        state.lifecycle = SessionLifecycle::Subscribed;
        state.driver = Some(driver.clone());
        state.on_connection(driver, generation);
        let next_active_turn_id = active_turn_id(&thread, None);
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
        state.turns_page = None;
        state.runtime_lease = true;
        state.revision = state.revision.saturating_add(1);
        state.status_revision = state.revision;
        state.name_revision = state.revision;
        state.last_sync_ms = Some(now_unix_ms());
        state.last_error = None;
    }

    async fn release_viewer(&self, thread_id: &str) {
        let Some(entry) = self.existing_entry(thread_id).await else {
            return;
        };
        let viewer_epoch = {
            let mut state = entry.state.lock().await;
            state.viewer_leases = state.viewer_leases.saturating_sub(1);
            state.viewer_epoch = state.viewer_epoch.saturating_add(1);
            state.viewer_epoch
        };
        tokio::time::sleep(VIEWER_HANDOFF_GRACE).await;
        self.unsubscribe_if_unused_for_epoch(thread_id, &entry, Some(viewer_epoch))
            .await;
    }

    pub(super) async fn unsubscribe_if_unused(&self, thread_id: &str, entry: &Arc<SessionEntry>) {
        self.unsubscribe_if_unused_for_epoch(thread_id, entry, None)
            .await;
    }

    async fn unsubscribe_if_unused_for_epoch(
        &self,
        thread_id: &str,
        entry: &Arc<SessionEntry>,
        expected_viewer_epoch: Option<u64>,
    ) {
        let (driver, generation, unsubscribe_epoch) = {
            let _operation = entry.operation.lock().await;
            let mut state = entry.state.lock().await;
            if expected_viewer_epoch.is_some_and(|epoch| state.viewer_epoch != epoch)
                || state.lifecycle != SessionLifecycle::Subscribed
                || state.viewer_leases > 0
                || state.runtime_lease
            {
                return;
            }
            let Some(driver) = state.driver.clone() else {
                return;
            };
            let generation = state.generation;
            let unsubscribe_epoch = state.viewer_epoch;
            state.lifecycle = SessionLifecycle::Unsubscribing;
            (driver, generation, unsubscribe_epoch)
        };

        let result = driver.stop_watching(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.generation != generation
            || state.viewer_epoch != unsubscribe_epoch
            || state.lifecycle != SessionLifecycle::Unsubscribing
            || state.viewer_leases > 0
            || state.runtime_lease
        {
            return;
        }
        match result {
            Ok(()) => {
                state.lifecycle = SessionLifecycle::Unloaded;
                state.driver = None;
                state.terminal_candidate_turn_id = None;
                state.last_error = None;
            }
            Err(error) => {
                state.lifecycle = SessionLifecycle::Error;
                state.last_error = Some(error.to_string());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

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

    #[tokio::test]
    async fn viewer_handoff_does_not_unsubscribe_between_detail_and_stream() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::delayed_ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
                Duration::from_millis(250),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
        ]);
        let sessions = TaskSessions::default();

        let detail_viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("detail viewer");
        std::mem::forget(detail_viewer);

        let releasing_sessions = sessions.clone();
        let release = tokio::spawn(async move {
            releasing_sessions.release_viewer("thread-1").await;
        });
        for _ in 0..20 {
            if sessions
                .snapshot("thread-1")
                .await
                .is_some_and(|snapshot| snapshot.viewer_leases == 0)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let stream_viewer = tokio::time::timeout(
            Duration::from_millis(50),
            sessions.acquire_viewer(&client.driver(), 1, "thread-1"),
        )
        .await
        .expect("stream viewer must not wait for an unsubscribe request")
        .expect("stream viewer");

        release.await.expect("release detail viewer");
        assert_eq!(methods(&client).await, vec!["thread/resume"]);

        drop(stream_viewer);
        wait_for_unsubscribe(&client).await;
    }

    #[tokio::test]
    async fn viewer_reacquisition_does_not_wait_for_an_in_flight_unsubscribe() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::delayed_ok(
                "thread/unsubscribe",
                json!({ "status": "unsubscribed" }),
                Duration::from_millis(250),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let sessions = TaskSessions::default();

        let first_viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("first viewer");
        drop(first_viewer);
        wait_for_unsubscribe(&client).await;

        let second_viewer = tokio::time::timeout(
            Duration::from_millis(50),
            sessions.acquire_viewer(&client.driver(), 1, "thread-1"),
        )
        .await
        .expect("a new viewer must not wait for the cleanup RPC")
        .expect("second viewer");

        assert_eq!(
            methods(&client).await,
            vec!["thread/resume", "thread/unsubscribe", "thread/resume"]
        );

        tokio::time::sleep(Duration::from_millis(275)).await;
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert_eq!(snapshot.viewer_leases, 1);

        drop(second_viewer);
        wait_for_method_count(&client, "thread/unsubscribe", 2).await;
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
    async fn registered_started_thread_is_subscribed_and_holds_runtime() {
        let client = CodexThreadClient::mock(Vec::new());
        let sessions = TaskSessions::default();
        sessions
            .register_started_thread(
                &client.driver(),
                1,
                Conversation::from(&thread(
                    ThreadStatus::Active {
                        active_flags: Vec::new(),
                    },
                    vec![wire_turn("turn-new", TurnStatus::InProgress)],
                )),
                StartedSettings {
                    permission_mode: Some("askForApproval".to_string()),
                    model: Some("gpt-test".to_string()),
                    reasoning_effort: Some("xhigh".to_string()),
                    fast_mode: true,
                },
            )
            .await;

        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert!(snapshot.runtime_lease);
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-new"));
        assert_eq!(snapshot.model.as_deref(), Some("gpt-test"));
        assert_eq!(snapshot.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(snapshot.fast_mode);
        assert!(methods(&client).await.is_empty());
    }
}
