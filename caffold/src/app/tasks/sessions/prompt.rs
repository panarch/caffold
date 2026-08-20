use crate::agent::codex::{CodexThreadError, CodexTurnOptions, is_fast_service_tier};
use crate::agent::{Driver, ThreadStatus, Turn, TurnStatus};

use super::{
    INITIAL_TURNS_PAGE_SIZE, PromptTarget, SessionLifecycle, SessionSnapshot, TaskSessions,
    now_unix_ms, snapshot,
};
use super::{
    reconciliation::apply_prompt_resume,
    turns::{merge_latest_turns_page, upsert_turn},
};

impl TaskSessions {
    pub(in crate::app::tasks) async fn prepare_prompt(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<PromptTarget, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        let current = {
            let mut state = entry.state.lock().await;
            state.runtime_lease = true;
            if state.generation == generation
                && state.lifecycle == SessionLifecycle::Subscribed
                && state.conversation.is_some()
            {
                Some(snapshot(&state))
            } else {
                None
            }
        };
        let current = match current {
            Some(snapshot) => snapshot,
            None => match self.resume_for_prompt(driver, generation, thread_id).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    self.cancel_runtime(thread_id).await;
                    return Err(error);
                }
            },
        };
        let current = if current
            .conversation
            .as_ref()
            .is_some_and(|thread| thread.status == ThreadStatus::NotLoaded)
        {
            match self
                .refresh_subscription(driver, generation, thread_id)
                .await
            {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    self.cancel_runtime(thread_id).await;
                    return Err(error);
                }
            }
        } else {
            current
        };

        if current.generation != generation {
            self.cancel_runtime(thread_id).await;
            return Err(CodexThreadError::SubscriptionLost(format!(
                "conversation {thread_id} changed connection before its prompt"
            )));
        }

        let thread = current.conversation.ok_or_else(|| {
            CodexThreadError::SubscriptionLost(format!(
                "conversation {thread_id} did not come back while preparing a prompt"
            ))
        })?;

        if matches!(thread.status, ThreadStatus::Active { .. }) {
            let turn_id = if let Some(turn_id) = current.active_turn_id {
                turn_id
            } else {
                let page = match driver
                    .read_turns(thread_id, None, INITIAL_TURNS_PAGE_SIZE)
                    .await
                {
                    Ok(page) => page,
                    Err(error) => {
                        entry.state.lock().await.last_error = Some(error.to_string());
                        self.cancel_runtime(thread_id).await;
                        return Err(error);
                    }
                };
                let Some(turn_id) = page
                    .turns
                    .iter()
                    .find(|turn| turn.status == TurnStatus::InProgress)
                    .map(|turn| turn.id.clone())
                else {
                    self.cancel_runtime(thread_id).await;
                    return Err(CodexThreadError::SubscriptionLost(format!(
                        "active thread {thread_id} did not expose its active turn"
                    )));
                };
                let mut state = entry.state.lock().await;
                state.active_turn_id = Some(turn_id.clone());
                state.active_turn_cwd = Some(thread.cwd.clone());
                state.terminal_candidate_turn_id = Some(turn_id.clone());
                merge_latest_turns_page(&mut state.turns_page, page);
                state.revision = state.revision.saturating_add(1);
                state.last_sync_ms = Some(now_unix_ms());
                state.last_error = None;
                turn_id
            };
            Ok(PromptTarget::Steer { turn_id })
        } else if matches!(
            thread.status,
            ThreadStatus::Idle | ThreadStatus::SystemError
        ) {
            Ok(PromptTarget::Start { cwd: thread.cwd })
        } else {
            self.cancel_runtime(thread_id).await;
            Err(CodexThreadError::SubscriptionLost(format!(
                "conversation {thread_id} cannot take a prompt"
            )))
        }
    }

    async fn resume_for_prompt(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<SessionSnapshot, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        let _operation = entry.operation.lock().await;
        {
            let state = entry.state.lock().await;
            if state.generation == generation
                && state.lifecycle == SessionLifecycle::Subscribed
                && state.conversation.is_some()
            {
                return Ok(snapshot(&state));
            }
        }
        let (base_revision, fast_mode) = {
            let state = entry.state.lock().await;
            (state.revision, state.fast_mode)
        };
        let opened = match driver.open_conversation(thread_id, false, fast_mode).await {
            Ok(opened) => opened,
            Err(error) => {
                let mut state = entry.state.lock().await;
                state.lifecycle = SessionLifecycle::Error;
                state.last_error = Some(error.to_string());
                return Err(error);
            }
        };
        let mut state = entry.state.lock().await;
        if state.generation > generation {
            return Err(CodexThreadError::SubscriptionLost(format!(
                "conversation {thread_id} changed connection while preparing a prompt"
            )));
        }
        apply_prompt_resume(&mut state, driver, generation, opened, base_revision);
        Ok(snapshot(&state))
    }

    pub(in crate::app::tasks) async fn record_turn_started(
        &self,
        generation: u64,
        thread_id: &str,
        cwd: Option<&str>,
        turn: Turn,
        options: CodexTurnOptions,
    ) {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.generation != generation {
            return;
        }
        let active_turn_cwd = cwd
            .map(str::to_string)
            .or_else(|| state.conversation.as_ref().map(|thread| thread.cwd.clone()));
        if let Some(cwd) = cwd
            && let Some(thread) = state.conversation.as_mut()
        {
            thread.cwd = cwd.to_string();
        }
        state.active_turn_id = Some(turn.id.clone());
        state.active_turn_cwd = active_turn_cwd;
        state.terminal_candidate_turn_id = Some(turn.id.clone());
        if options.permission_mode.is_some() {
            state.permission_mode = options.permission_mode;
        }
        if options.model.is_some() {
            state.model = options.model;
        }
        if options.effort.is_some() {
            state.reasoning_effort = options.effort;
        }
        state.fast_mode = is_fast_service_tier(options.service_tier.as_deref());
        state.runtime_lease = true;
        upsert_turn(&mut state.turns_page, turn);
        state.revision = state.revision.saturating_add(1);
        state.last_sync_ms = Some(now_unix_ms());
    }

    pub(in crate::app::tasks) async fn cancel_runtime(&self, thread_id: &str) {
        let Some(entry) = self.existing_entry(thread_id).await else {
            return;
        };
        entry.state.lock().await.runtime_lease = false;
        self.unsubscribe_if_unused(thread_id, &entry).await;
    }

    pub(in crate::app::tasks) async fn active_turn_id(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<String>, CodexThreadError> {
        let snapshot = self
            .ensure_subscribed(driver, generation, thread_id)
            .await?;
        if snapshot.active_turn_id.is_some() {
            return Ok(snapshot.active_turn_id);
        }
        if !snapshot
            .conversation
            .as_ref()
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
        {
            return Ok(None);
        }
        let page = driver.read_turns(thread_id, None, 8).await?;
        let turn_id = page
            .turns
            .iter()
            .find(|turn| turn.status == TurnStatus::InProgress)
            .map(|turn| turn.id.clone());
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        state.active_turn_id = turn_id.clone();
        state.active_turn_cwd = turn_id.as_ref().and_then(|_| {
            snapshot
                .conversation
                .as_ref()
                .map(|thread| thread.cwd.clone())
        });
        state.terminal_candidate_turn_id = turn_id.clone();
        merge_latest_turns_page(&mut state.turns_page, page);
        state.revision = state.revision.saturating_add(1);
        Ok(turn_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

    #[tokio::test]
    async fn completed_subscribed_prompt_starts_without_another_resume() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let target = sessions
            .prepare_prompt(&client.driver(), 1, "thread-1")
            .await
            .expect("prepare completed follow-up");

        assert!(matches!(target, PromptTarget::Start { cwd } if cwd == "Workspace/rust/codger"));
        assert_eq!(methods(&client).await, vec!["thread/resume"]);
    }

    #[tokio::test]
    async fn active_subscribed_prompt_steers_without_another_resume() {
        let canonical = wire_turn("turn-canonical", TurnStatus::InProgress);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![canonical],
            ),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let target = sessions
            .prepare_prompt(&client.driver(), 1, "thread-1")
            .await
            .expect("prepare active follow-up");

        assert!(matches!(target, PromptTarget::Steer { turn_id } if turn_id == "turn-canonical"));
        assert_eq!(methods(&client).await, vec!["thread/resume"]);
    }

    #[tokio::test]
    async fn prompt_does_not_wait_for_a_background_subscription_refresh() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
                Duration::from_millis(250),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let refresh_sessions = sessions.clone();
        let refresh_client = client.clone();
        let refresh = tokio::spawn(async move {
            refresh_sessions
                .refresh_subscription(&refresh_client.driver(), 1, "thread-1")
                .await
        });
        for _ in 0..20 {
            if methods(&client).await.len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let target = tokio::time::timeout(
            Duration::from_millis(50),
            sessions.prepare_prompt(&client.driver(), 1, "thread-1"),
        )
        .await
        .expect("prompt preparation must not wait for background sync")
        .expect("prepare completed follow-up");

        assert!(matches!(target, PromptTarget::Start { .. }));
        refresh
            .await
            .expect("refresh task")
            .expect("refresh result");
    }

    #[tokio::test]
    async fn system_error_prompt_starts_a_recovery_turn() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::SystemError, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let target = sessions
            .prepare_prompt(&client.driver(), 1, "thread-1")
            .await
            .expect("prepare recovery prompt");

        assert!(matches!(target, PromptTarget::Start { cwd } if cwd == "Workspace/rust/codger"));
        assert_eq!(methods(&client).await, vec!["thread/resume"]);
        assert!(
            sessions
                .snapshot("thread-1")
                .await
                .expect("snapshot")
                .runtime_lease
        );
    }

    #[tokio::test]
    async fn not_loaded_prompt_resumes_before_starting_a_turn() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::NotLoaded, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let target = sessions
            .prepare_prompt(&client.driver(), 1, "thread-1")
            .await
            .expect("prepare loaded prompt");

        assert!(matches!(target, PromptTarget::Start { cwd } if cwd == "Workspace/rust/codger"));
        assert_eq!(
            methods(&client).await,
            vec!["thread/resume", "thread/resume"]
        );
    }

    #[tokio::test]
    async fn not_loaded_prompt_refresh_failure_releases_runtime() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::NotLoaded, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::error(
                "thread/resume",
                CodexThreadError::RequestTimeout {
                    method: "thread/resume",
                    request_id: 2,
                    timeout_ms: 120_000,
                },
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        assert!(matches!(
            sessions
                .prepare_prompt(&client.driver(), 1, "thread-1")
                .await,
            Err(CodexThreadError::RequestTimeout { .. })
        ));
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert!(!snapshot.runtime_lease);
        assert!(snapshot.last_error.is_some());
        assert_eq!(
            methods(&client).await,
            vec!["thread/resume", "thread/resume"]
        );
    }

    #[tokio::test]
    async fn completed_prompt_shares_initial_history_bootstrap() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            Duration::from_millis(250),
        )]);
        let sessions = TaskSessions::default();

        let viewer_sessions = sessions.clone();
        let viewer_client = client.clone();
        let viewer = tokio::spawn(async move {
            viewer_sessions
                .acquire_viewer(&viewer_client.driver(), 1, "thread-1")
                .await
        });
        for _ in 0..20 {
            if methods(&client).await.len() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let target = tokio::time::timeout(
            Duration::from_millis(500),
            sessions.prepare_prompt(&client.driver(), 1, "thread-1"),
        )
        .await
        .expect("completed prompt should finish after the shared bootstrap")
        .expect("prepare completed prompt");

        assert!(matches!(target, PromptTarget::Start { .. }));
        sessions
            .record_turn_started(
                1,
                "thread-1",
                Some("/managed/worktree"),
                turn("turn-new", TurnStatus::InProgress),
                CodexTurnOptions::default(),
            )
            .await;
        viewer
            .await
            .expect("viewer task")
            .expect("viewer subscription");
        assert_eq!(methods(&client).await, vec!["thread/resume"]);
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-new"));
        assert_eq!(
            snapshot.active_turn_cwd.as_deref(),
            Some("/managed/worktree")
        );
        assert_eq!(
            snapshot
                .conversation
                .as_ref()
                .map(|thread| thread.cwd.as_str()),
            Some("/managed/worktree")
        );
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| thread.status == ThreadStatus::Idle),
            "starting a turn must not synthesize thread status"
        );
    }

    #[tokio::test]
    async fn prompt_uses_an_external_turn_discovered_during_refresh() {
        let external = wire_turn("turn-external", TurnStatus::InProgress);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Active {
                        active_flags: Vec::new(),
                    },
                    Vec::new(),
                    vec![external],
                ),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        sessions
            .refresh_subscription(&client.driver(), 1, "thread-1")
            .await
            .expect("external invalidation refresh");

        assert!(matches!(
            sessions.prepare_prompt(&client.driver(), 1, "thread-1").await,
            Ok(PromptTarget::Steer { turn_id }) if turn_id == "turn-external"
        ));
        assert_eq!(
            methods(&client).await,
            vec!["thread/resume", "thread/resume"]
        );
    }

    #[tokio::test]
    async fn completed_external_turn_switches_follow_up_back_to_start() {
        let active = wire_turn("turn-external", TurnStatus::InProgress);
        let completed = wire_turn("turn-external", TurnStatus::Completed);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Active {
                        active_flags: Vec::new(),
                    },
                    Vec::new(),
                    vec![active],
                ),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), vec![completed]),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        sessions
            .refresh_subscription(&client.driver(), 1, "thread-1")
            .await
            .expect("external completion refresh");

        assert!(matches!(
            sessions
                .prepare_prompt(&client.driver(), 1, "thread-1")
                .await,
            Ok(PromptTarget::Start { .. })
        ));
        assert_eq!(
            methods(&client).await,
            vec!["thread/resume", "thread/resume"]
        );
    }

    #[tokio::test]
    async fn active_status_without_turn_falls_back_to_latest_turn_page() {
        let canonical = wire_turn("turn-canonical", TurnStatus::InProgress);
        let active_status = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(active_status.clone(), Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok(
                "thread/turns/list",
                wire_page(vec![canonical], None, Some("active-anchor")),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        assert!(matches!(
            sessions.prepare_prompt(&client.driver(), 1, "thread-1").await,
            Ok(PromptTarget::Steer { turn_id }) if turn_id == "turn-canonical"
        ));
        assert_eq!(
            methods(&client).await,
            vec!["thread/resume", "thread/turns/list"]
        );
    }

    #[tokio::test]
    async fn unsubscribed_prompt_failure_releases_runtime() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "thread/resume",
            CodexThreadError::RequestTimeout {
                method: "thread/resume",
                request_id: 1,
                timeout_ms: 120_000,
            },
        )]);
        let sessions = TaskSessions::default();

        assert!(matches!(
            sessions
                .prepare_prompt(&client.driver(), 1, "thread-1")
                .await,
            Err(CodexThreadError::RequestTimeout { .. })
        ));
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert!(!snapshot.runtime_lease);
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Error);
        assert!(snapshot.conversation.is_none());
        assert!(snapshot.last_error.is_some());
    }
}
