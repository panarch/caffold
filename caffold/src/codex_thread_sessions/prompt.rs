use crate::agent::codex::{
    CodexThreadClient, CodexThreadError, CodexTurnOptions, is_fast_service_tier,
    service_tier_for_fast_mode,
};
use crate::agent::{ThreadStatus, Turn, TurnPage, TurnStatus};

use super::{
    CodexThreadSessions, INITIAL_TURNS_PAGE_SIZE, PromptTarget, ThreadSessionLifecycle,
    ThreadSessionSnapshot, now_unix_ms, snapshot,
};
use super::{
    reconciliation::apply_prompt_resume_response,
    turns::{merge_latest_turns_page, upsert_turn},
};

impl CodexThreadSessions {
    pub async fn prepare_prompt(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<PromptTarget, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        let current = {
            let mut state = entry.state.lock().await;
            state.runtime_lease = true;
            if state.generation == generation
                && state.lifecycle == ThreadSessionLifecycle::Subscribed
                && state.conversation.is_some()
            {
                Some(snapshot(&state))
            } else {
                None
            }
        };
        let current = match current {
            Some(snapshot) => snapshot,
            None => match self.resume_for_prompt(client, generation, thread_id).await {
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
                .refresh_subscription(client, generation, thread_id)
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
                "Codex thread {thread_id} changed app-server generation before prompt"
            )));
        }

        let thread = current.conversation.ok_or_else(|| {
            CodexThreadError::SubscriptionLost(format!(
                "Codex thread {thread_id} did not return canonical metadata while preparing a prompt"
            ))
        })?;

        if matches!(thread.status, ThreadStatus::Active { .. }) {
            let turn_id = if let Some(turn_id) = current.active_turn_id {
                turn_id
            } else {
                let page = match client
                    .list_thread_turns(thread_id, None, INITIAL_TURNS_PAGE_SIZE)
                    .await
                {
                    Ok(page) => page,
                    Err(error) => {
                        entry.state.lock().await.last_error = Some(error.to_string());
                        self.cancel_runtime(thread_id).await;
                        return Err(error);
                    }
                };
                let page = TurnPage::from(&page);
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
                "Codex thread {thread_id} is unavailable for a prompt"
            )))
        }
    }

    async fn resume_for_prompt(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<ThreadSessionSnapshot, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        let _operation = entry.operation.lock().await;
        {
            let state = entry.state.lock().await;
            if state.generation == generation
                && state.lifecycle == ThreadSessionLifecycle::Subscribed
                && state.conversation.is_some()
            {
                return Ok(snapshot(&state));
            }
        }
        let (base_revision, service_tier) = {
            let state = entry.state.lock().await;
            (state.revision, service_tier_for_fast_mode(state.fast_mode))
        };
        let response = match client
            .resume_thread_with_page(thread_id, false, service_tier)
            .await
        {
            Ok(response) => response,
            Err(error) => {
                let mut state = entry.state.lock().await;
                state.lifecycle = ThreadSessionLifecycle::Error;
                state.last_error = Some(error.to_string());
                return Err(error);
            }
        };
        let mut state = entry.state.lock().await;
        if state.generation > generation {
            return Err(CodexThreadError::SubscriptionLost(format!(
                "Codex thread {thread_id} changed app-server generation while preparing a prompt"
            )));
        }
        apply_prompt_resume_response(&mut state, client, generation, response, base_revision);
        Ok(snapshot(&state))
    }

    pub async fn record_turn_started(
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

    pub async fn cancel_runtime(&self, thread_id: &str) {
        let Some(entry) = self.existing_entry(thread_id).await else {
            return;
        };
        entry.state.lock().await.runtime_lease = false;
        self.unsubscribe_if_unused(thread_id, &entry).await;
    }

    pub async fn active_turn_id(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<String>, CodexThreadError> {
        let snapshot = self
            .ensure_subscribed(client, generation, thread_id)
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
        let page = TurnPage::from(&client.list_thread_turns(thread_id, None, 8).await?);
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
    use crate::codex_thread_sessions::test_support::*;

    #[tokio::test]
    async fn completed_subscribed_prompt_starts_without_another_resume() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let target = sessions
            .prepare_prompt(&client, 1, "thread-1")
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let target = sessions
            .prepare_prompt(&client, 1, "thread-1")
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let refresh_sessions = sessions.clone();
        let refresh_client = client.clone();
        let refresh = tokio::spawn(async move {
            refresh_sessions
                .refresh_subscription(&refresh_client, 1, "thread-1")
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
            sessions.prepare_prompt(&client, 1, "thread-1"),
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let target = sessions
            .prepare_prompt(&client, 1, "thread-1")
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let target = sessions
            .prepare_prompt(&client, 1, "thread-1")
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        assert!(matches!(
            sessions.prepare_prompt(&client, 1, "thread-1").await,
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
        let sessions = CodexThreadSessions::default();

        let viewer_sessions = sessions.clone();
        let viewer_client = client.clone();
        let viewer = tokio::spawn(async move {
            viewer_sessions
                .acquire_viewer(&viewer_client, 1, "thread-1")
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
            sessions.prepare_prompt(&client, 1, "thread-1"),
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        sessions
            .refresh_subscription(&client, 1, "thread-1")
            .await
            .expect("external invalidation refresh");

        assert!(matches!(
            sessions.prepare_prompt(&client, 1, "thread-1").await,
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        sessions
            .refresh_subscription(&client, 1, "thread-1")
            .await
            .expect("external completion refresh");

        assert!(matches!(
            sessions.prepare_prompt(&client, 1, "thread-1").await,
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        assert!(matches!(
            sessions.prepare_prompt(&client, 1, "thread-1").await,
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
        let sessions = CodexThreadSessions::default();

        assert!(matches!(
            sessions.prepare_prompt(&client, 1, "thread-1").await,
            Err(CodexThreadError::RequestTimeout { .. })
        ));
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert!(!snapshot.runtime_lease);
        assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Error);
        assert!(snapshot.conversation.is_none());
        assert!(snapshot.last_error.is_some());
    }
}
