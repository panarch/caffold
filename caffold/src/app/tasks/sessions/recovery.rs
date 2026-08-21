use futures_util::{StreamExt, stream};

use crate::agent::codex::CodexThreadError;
use crate::agent::{Driver, ThreadStatus};

use super::{SessionLifecycle, SessionSnapshot, TaskSessions};

impl TaskSessions {
    /// Report the Codex connection every thread on it was being watched
    /// through as gone.
    ///
    /// Generations are Codex's count of its own connections, which is why they
    /// are only compared here against sessions reached through one. Claude
    /// sessions carry a generation too — one value, standing for the fact that
    /// each is its own process on its own connection and so has nothing to tell
    /// apart — and comparing a count against a stand-in for no count would take
    /// every Claude session down with Codex's first connection, reporting each
    /// as lost to a runtime it was never reached through.
    pub(in crate::app::tasks) async fn codex_connection_lost(
        &self,
        generation: u64,
        message: String,
    ) -> Vec<String> {
        let entries = self
            .entries
            .lock()
            .await
            .iter()
            .map(|(thread_id, entry)| (thread_id.clone(), entry.clone()))
            .collect::<Vec<_>>();
        let mut affected = Vec::new();
        for (thread_id, entry) in entries {
            let mut state = entry.state.lock().await;
            if state.is_codex() && state.generation == generation {
                state.lifecycle = SessionLifecycle::Error;
                state.driver = None;
                state.terminal_candidate_turn_id = None;
                state.last_error = Some(message.clone());
                state.revision = state.revision.saturating_add(1);
                affected.push(thread_id);
            }
        }
        affected
    }

    /// Stop treating one session as current, so the next open really opens it.
    ///
    /// The Claude answer to a connection going away, and deliberately not the
    /// Codex one. Codex loses every thread at once and to a process that has to
    /// come back before any of them can be reached, so those sessions carry an
    /// error saying so. A Claude session losing its runner is one conversation,
    /// and opening it again is the whole of the repair: the runner is started,
    /// the agent is resumed, and the conversation goes on. An error parked on it
    /// would say the opposite — that there is nothing to be done — and a Task
    /// that reads as broken is never opened again to find out otherwise.
    ///
    /// What was last heard is left in place. It is what a person was reading a
    /// moment ago, and it is replaced the moment the conversation is opened
    /// again rather than blanked in the meantime.
    pub(in crate::app::tasks) async fn session_needs_opening_again(&self, thread_id: &str) {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        state.lifecycle = SessionLifecycle::Unloaded;
        state.driver = None;
        state.terminal_candidate_turn_id = None;
        state.revision = state.revision.saturating_add(1);
    }

    /// Subscribe again to every thread on a Codex connection that somebody is
    /// still watching.
    ///
    /// Only Codex's, for the reason [`Self::codex_connection_lost`] gives:
    /// leases say a Task is being watched and say nothing about which agent
    /// runs it, so handing them all to a new Codex connection would resume a
    /// Claude Task through a process that has never heard of it.
    pub(in crate::app::tasks) async fn resubscribe_leased_codex_threads(
        &self,
        driver: &Driver,
        generation: u64,
    ) -> Vec<(String, CodexThreadError)> {
        let entries = self
            .entries
            .lock()
            .await
            .iter()
            .map(|(thread_id, entry)| (thread_id.clone(), entry.clone()))
            .collect::<Vec<_>>();
        let mut leased_threads = Vec::new();
        for (thread_id, entry) in entries {
            let leased = {
                let state = entry.state.lock().await;
                state.is_codex() && (state.viewer_leases > 0 || state.runtime_lease)
            };
            if leased {
                leased_threads.push(thread_id);
            }
        }

        stream::iter(leased_threads)
            .map(|thread_id| {
                let sessions = self.clone();
                let driver = driver.clone();
                async move {
                    sessions
                        .ensure_subscribed(&driver, generation, &thread_id)
                        .await
                        .err()
                        .map(|error| (thread_id, error))
                }
            })
            .buffer_unordered(8)
            .filter_map(async move |failure| failure)
            .collect()
            .await
    }

    /// Take up a Claude conversation the runner is still holding.
    ///
    /// Unlike Codex's, this holds no runtime lease afterwards and drops nothing
    /// when the conversation turns out to be idle. A Codex subscription costs
    /// the app-server something to keep; a Claude one is a socket the runner
    /// holds either way, and letting go of it does nothing but make the next
    /// person to open the Task wait for this same exchange again.
    pub(in crate::app::tasks) async fn recover_live_claude_session(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<SessionSnapshot>, CodexThreadError> {
        self.ensure_subscribed(driver, generation, thread_id)
            .await
            .map(Some)
    }

    pub(in crate::app::tasks) async fn recover_loaded_thread(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<SessionSnapshot>, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        entry.state.lock().await.runtime_lease = true;

        match self.ensure_subscribed(driver, generation, thread_id).await {
            Ok(snapshot)
                if snapshot
                    .conversation
                    .as_ref()
                    .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. })) =>
            {
                Ok(Some(snapshot))
            }
            Ok(_) => {
                self.cancel_runtime(thread_id).await;
                Ok(None)
            }
            Err(error) => {
                self.cancel_runtime(thread_id).await;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

    /// A Claude session opened on a stand-in that has already greeted it.
    async fn a_claude_session(sessions: &TaskSessions, generation: u64, thread_id: &str) -> Driver {
        let (client, runner) = crate::agent::claude::ClaudeClient::mock();
        runner
            .greet_next_session_with(vec![serde_json::json!({
                "type": "system",
                "subtype": "init",
                "session_id": thread_id,
                "cwd": "/Users/example/project",
                "model": "claude-opus-5",
                "permissionMode": "default",
                "claude_code_version": "9.9.9",
            })])
            .await;
        let driver = client.driver("/Users/example/project");
        std::mem::forget(
            sessions
                .acquire_viewer(&driver, generation, thread_id)
                .await
                .expect("the Claude session opens"),
        );
        driver
    }

    #[tokio::test]
    async fn a_codex_connection_going_away_leaves_claude_sessions_alone() {
        // Claude sessions all count as one generation, deliberately: each is
        // its own process on its own connection, so there is nothing for a
        // generation to tell apart. Codex counts its connections from zero,
        // which makes its first one that same number — and a restart of it
        // would then take every Claude session with it, reporting each as lost
        // to a runtime it was never reached through.
        let sessions = TaskSessions::default();
        let _claude = a_claude_session(&sessions, 1, "claude-thread").await;

        let _ = sessions
            .codex_connection_lost(1, "Codex runtime is restarting.".to_string())
            .await;

        let snapshot = sessions.snapshot("claude-thread").await.expect("snapshot");
        assert_eq!(
            snapshot.lifecycle,
            SessionLifecycle::Subscribed,
            "Codex restarting says nothing about a Claude session: {:?}",
            snapshot.last_error
        );
    }

    #[tokio::test]
    async fn a_codex_connection_coming_back_does_not_resubscribe_claude_sessions() {
        // Restoring a connection re-subscribes everything leased, and a Claude
        // Task is leased the same way. Handed Codex's driver, it would be
        // resumed through a process that has never heard of it.
        let codex = CodexThreadClient::mock(Vec::new());
        let sessions = TaskSessions::default();
        let _claude = a_claude_session(&sessions, 1, "claude-thread").await;

        let failures = sessions
            .resubscribe_leased_codex_threads(&codex.driver(), 2)
            .await;

        assert!(
            methods(&codex).await.is_empty(),
            "Codex was asked about a Claude Task: {:?}",
            methods(&codex).await
        );
        assert!(failures.is_empty(), "and nothing failed: {failures:?}");
        let snapshot = sessions.snapshot("claude-thread").await.expect("snapshot");
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert_eq!(snapshot.generation, 1, "still its own, not Codex's");
    }

    #[tokio::test]
    async fn connection_recovery_resubscribes_only_leased_sessions() {
        let first_client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let recovered_client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&first_client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let _ = sessions
            .codex_connection_lost(1, "process exited".to_string())
            .await;
        let failures = sessions
            .resubscribe_leased_codex_threads(&recovered_client.driver(), 2)
            .await;

        assert!(failures.is_empty());
        assert_eq!(methods(&recovered_client).await, vec!["thread/resume"]);
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.generation, 2);
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
    }

    #[tokio::test]
    async fn connection_recovery_does_not_serialize_unrelated_thread_resumes() {
        let first_client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _first_viewer = sessions
            .acquire_viewer(&first_client.driver(), 1, "thread-1")
            .await
            .expect("first viewer");
        let _second_viewer = sessions
            .acquire_viewer(&first_client.driver(), 1, "thread-2")
            .await
            .expect("second viewer");

        let _ = sessions
            .codex_connection_lost(1, "process exited".to_string())
            .await;
        let recovered_client = CodexThreadClient::mock(vec![
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
                Duration::from_millis(120),
            ),
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
                Duration::from_millis(120),
            ),
        ]);

        let started = tokio::time::Instant::now();
        let failures = sessions
            .resubscribe_leased_codex_threads(&recovered_client.driver(), 2)
            .await;

        assert!(failures.is_empty());
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "independent thread resumes should run concurrently, elapsed {:?}",
            started.elapsed()
        );
        assert_eq!(
            methods(&recovered_client).await,
            vec!["thread/resume", "thread/resume"]
        );
    }

    #[tokio::test]
    async fn loaded_active_thread_recovery_holds_a_runtime_lease() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                vec![wire_turn("turn-active", TurnStatus::InProgress)],
                Vec::new(),
            ),
        )]);
        let sessions = TaskSessions::default();

        let recovered = sessions
            .recover_loaded_thread(&client.driver(), 3, "thread-1")
            .await
            .expect("recover active thread")
            .expect("active thread remains subscribed");

        assert!(recovered.runtime_lease);
        assert_eq!(recovered.active_turn_id.as_deref(), Some("turn-active"));
        assert_eq!(methods(&client).await, ["thread/resume"]);
    }

    #[tokio::test]
    async fn loaded_idle_thread_recovery_releases_its_runtime_lease() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let sessions = TaskSessions::default();

        assert!(
            sessions
                .recover_loaded_thread(&client.driver(), 3, "thread-1")
                .await
                .expect("recover idle thread")
                .is_none()
        );
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert!(!snapshot.runtime_lease);
        wait_for_unsubscribe(&client).await;
    }
}
