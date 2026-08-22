use crate::agent::AgentError;
use crate::agent::{Conversation, TurnPage};

use super::{SessionLifecycle, SessionSnapshot, TaskSessions, now_unix_ms, snapshot};
use super::{
    reconciliation::merge_external_snapshot,
    turns::{active_turn_id, update_active_turn},
};

impl TaskSessions {
    /// Note that this thread was listed on the current Codex connection.
    ///
    /// Codex's bookkeeping only: the generation is Codex's count of its own
    /// connections, and stamping it onto a thread another agent runs would
    /// sweep that thread's session on the first listing after a Codex restart —
    /// and then drop its every report as belonging to an old connection. The
    /// caller filters by who runs the thread, which is the store's to say.
    pub(in crate::app::tasks) async fn track_listed_codex_thread(
        &self,
        generation: u64,
        thread_id: &str,
    ) {
        let entry = self.entry(thread_id).await;
        let _operation = entry.operation.lock().await;
        let mut state = entry.state.lock().await;
        if state.generation != generation {
            if state.viewer_leases > 0 || state.runtime_lease {
                return;
            }
            state.lifecycle = SessionLifecycle::Unloaded;
            state.conversation = None;
            state.turns_page = None;
            state.active_turn_id = None;
            state.active_turn_cwd = None;
            state.terminal_candidate_turn_id = None;
            state.driver = None;
            state.pending_thread_status = None;
            state.last_sync_ms = None;
            state.external_syncing = false;
            state.external_sync_started_ms = None;
            state.revision = state.revision.saturating_add(1);
            state.status_revision = state.revision;
            state.name_revision = state.revision;
        }
        state.generation = generation;
        state.last_error = None;
    }

    pub(in crate::app::tasks) async fn restore_managed_fast_mode(
        &self,
        thread_id: &str,
        fast_mode: bool,
    ) {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.lifecycle != SessionLifecycle::Subscribed {
            state.fast_mode = fast_mode;
        }
    }

    pub(in crate::app::tasks) async fn observe_thread_metadata(&self, mut thread: Conversation) {
        self.observe_thread_metadata_inner(&mut thread, None).await;
    }

    pub(in crate::app::tasks) async fn observe_listed_thread_metadata(
        &self,
        generation: u64,
        mut thread: Conversation,
    ) {
        self.observe_thread_metadata_inner(&mut thread, Some(generation))
            .await;
    }

    async fn observe_thread_metadata_inner(
        &self,
        thread: &mut Conversation,
        generation: Option<u64>,
    ) {
        let entry = self.entry(&thread.id).await;
        let mut state = entry.state.lock().await;
        if let Some(generation) = generation {
            if state.generation != generation {
                return;
            }
            state.last_error = None;
        }
        let status_changed = state.conversation.is_none() && state.pending_thread_status.is_none();
        if let Some(current) = state.conversation.as_ref() {
            *thread = Conversation {
                status: current.status.clone(),
                turns: current.turns.clone(),
                ..thread.clone()
            };
        } else if let Some(status) = state.pending_thread_status.clone() {
            *thread = Conversation {
                status,
                ..thread.clone()
            };
        }
        if state.conversation.as_ref() == Some(thread) {
            return;
        }
        let next_active_turn_id = active_turn_id(thread, state.turns_page.as_ref());
        update_active_turn(&mut state, next_active_turn_id, Some(thread.cwd.clone()));
        state.conversation = Some(thread.clone());
        state.pending_thread_status = None;
        state.revision = state.revision.saturating_add(1);
        state.name_revision = state.revision;
        if status_changed {
            state.status_revision = state.revision;
        }
    }

    pub(in crate::app::tasks) async fn begin_external_sync(
        &self,
        thread_id: &str,
    ) -> SessionSnapshot {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        state.external_syncing = true;
        state
            .external_sync_started_ms
            .get_or_insert_with(now_unix_ms);
        state.revision = state.revision.saturating_add(1);
        snapshot(&state)
    }

    pub(in crate::app::tasks) async fn apply_external_read_sync(
        &self,
        thread_id: &str,
        base_revision: u64,
        thread: Conversation,
        latest_turns: TurnPage,
    ) -> SessionSnapshot {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        let applied =
            merge_external_snapshot(&mut state, thread, Some(latest_turns), base_revision);
        state.external_syncing = false;
        state.external_sync_started_ms = None;
        state.revision = state.revision.saturating_add(1);
        if applied.status {
            state.status_revision = state.revision;
        }
        if applied.name {
            state.name_revision = state.revision;
        }
        state.last_sync_ms = Some(now_unix_ms());
        state.last_error = None;
        snapshot(&state)
    }

    pub(in crate::app::tasks) async fn fail_external_sync(
        &self,
        thread_id: &str,
        error: &AgentError,
    ) {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        state.external_syncing = false;
        state.external_sync_started_ms = None;
        state.last_error = Some(error.to_string());
        state.revision = state.revision.saturating_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

    #[tokio::test]
    async fn restored_fast_task_resumes_with_an_explicit_priority_tier() {
        let mut response = resume_response(ThreadStatus::Idle, Vec::new(), Vec::new());
        response
            .extra
            .insert("serviceTier".to_string(), json!("priority"));
        let client =
            CodexThreadClient::mock(vec![MockCodexResponse::ok("thread/resume", response)]);
        let sessions = TaskSessions::default();
        sessions.restore_managed_fast_mode("thread-1", true).await;

        let snapshot = sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");
        let requests = client.mock_requests().await;

        assert_eq!(requests[0].1["serviceTier"], "priority");
        assert!(snapshot.fast_mode);
    }

    #[tokio::test]
    async fn stale_active_metadata_does_not_revive_a_turn_after_an_idle_report() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![wire_turn("turn-stale", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

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
        let mut updated_metadata = thread(
            ThreadStatus::Active {
                active_flags: Vec::new(),
            },
            Vec::new(),
        );
        updated_metadata.updated_at = 2.0;
        sessions
            .observe_thread_metadata(Conversation::from(&updated_metadata))
            .await;
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert_eq!(snapshot.active_turn_id, None);
        assert!(!snapshot.runtime_lease);
        assert!(
            snapshot
                .conversation
                .as_ref()
                .is_some_and(|thread| thread.status == ThreadStatus::Idle)
        );
        assert_eq!(
            snapshot.turns_page.as_ref().expect("history").turns[0].status,
            TurnStatus::InProgress
        );
    }

    #[tokio::test]
    async fn external_sync_preserves_the_interactive_subscription_and_does_not_block_prompt() {
        let primary = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&primary.driver(), 7, "thread-1")
            .await
            .unwrap();

        let syncing = sessions.begin_external_sync("thread-1").await;
        assert!(syncing.external_syncing);
        assert!(syncing.external_sync_started_ms.is_some());

        let target = tokio::time::timeout(
            Duration::from_millis(50),
            sessions.prepare_prompt(&primary.driver(), 7, "thread-1"),
        )
        .await
        .expect("prompt must not wait for external sync")
        .expect("prepare prompt");
        assert!(matches!(target, PromptTarget::Start { .. }));

        let response = resume_response(
            ThreadStatus::Idle,
            Vec::new(),
            vec![wire_turn("external", TurnStatus::Completed)],
        );
        let snapshot = sessions
            .apply_external_read_sync(
                "thread-1",
                syncing.revision,
                Conversation::from(&response.thread),
                TurnPage::from(&response.initial_turns_page.expect("latest turns page")),
            )
            .await;
        assert_eq!(snapshot.generation, 7);
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert!(!snapshot.external_syncing);
        assert_eq!(methods(&primary).await, vec!["thread/resume"]);
    }

    fn listed_thread(id: &str, status: ThreadStatus) -> Conversation {
        Conversation {
            id: id.to_string(),
            title: None,
            preview: id.to_string(),
            status,
            cwd: "/tmp".to_string(),
            transcript_path: None,
            created_at_ms: 1_000,
            updated_at_ms: 2_000,
            recency_at_ms: None,
            turns: Vec::new(),
        }
    }

    fn active_status() -> ThreadStatus {
        serde_json::from_value(serde_json::json!({
            "type": "active",
            "activeFlags": [],
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn new_generation_listing_drops_unleased_status_from_the_old_connection() {
        let sessions = TaskSessions::default();
        sessions.track_listed_codex_thread(1, "thread-1").await;
        sessions
            .observe_listed_thread_metadata(1, listed_thread("thread-1", active_status()))
            .await;

        sessions.track_listed_codex_thread(2, "thread-1").await;
        sessions
            .observe_listed_thread_metadata(2, listed_thread("thread-1", ThreadStatus::Idle))
            .await;

        let snapshot = sessions.snapshot("thread-1").await.unwrap();
        assert_eq!(snapshot.generation, 2);
        assert_eq!(snapshot.conversation.unwrap().status, ThreadStatus::Idle);
    }

    #[tokio::test]
    async fn a_current_generation_report_wins_over_an_older_list_page() {
        let sessions = TaskSessions::default();
        sessions.track_listed_codex_thread(3, "thread-1").await;
        sessions
            .apply_session_event(
                3,
                &session_event(
                    "thread-1",
                    SessionEventKind::StatusChanged {
                        status: active_status(),
                    },
                ),
            )
            .await;
        sessions
            .observe_listed_thread_metadata(3, listed_thread("thread-1", ThreadStatus::Idle))
            .await;

        assert!(matches!(
            sessions
                .snapshot("thread-1")
                .await
                .unwrap()
                .conversation
                .unwrap()
                .status,
            ThreadStatus::Active { .. }
        ));
    }
}
