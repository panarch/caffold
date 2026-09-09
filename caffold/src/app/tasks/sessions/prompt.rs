use crate::agent::AgentError;
use crate::agent::{
    Driver, SessionEvent, SessionEventKind, ThreadStatus, TurnOptions, TurnState, TurnStatus,
};

use super::turns::{merge_latest_turns_page, turn_is_terminal, upsert_turn};
use super::{
    INITIAL_TURNS_PAGE_SIZE, PromptTarget, SessionLifecycle, SessionTurnPage, TaskSessions,
    now_unix_ms, snapshot,
};

impl TaskSessions {
    pub(in crate::app::tasks) async fn prepare_prompt(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<PromptTarget, AgentError> {
        let entry = self.entry(thread_id).await;
        let current = {
            let state = entry.state.lock().await;
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
            None => {
                self.resume_for_prompt(driver, generation, thread_id)
                    .await?
            }
        };
        let current = if current
            .conversation
            .as_ref()
            .is_some_and(|thread| thread.status == ThreadStatus::NotLoaded)
        {
            self.refresh_subscription(driver, generation, thread_id)
                .await?
        } else {
            current
        };

        if current.generation != generation {
            return Err(AgentError::Failed(format!(
                "conversation {thread_id} changed connection before its prompt"
            )));
        }

        let thread = current.conversation.ok_or_else(|| {
            AgentError::Failed(format!(
                "conversation {thread_id} did not come back while preparing a prompt"
            ))
        })?;

        if matches!(thread.status, ThreadStatus::Active { .. }) {
            let turn_id = if let Some(turn_id) = current.active_turn_id {
                turn_id
            } else {
                let observation_epoch = {
                    let state = entry.state.lock().await;
                    if state.generation != generation
                        || state.lifecycle != SessionLifecycle::Subscribed
                    {
                        return Err(AgentError::Failed(format!(
                            "conversation {thread_id} changed connection before locating its active turn"
                        )));
                    }
                    state.observation_epoch
                };
                let page = match driver
                    .read_turns(thread_id, None, INITIAL_TURNS_PAGE_SIZE)
                    .await
                {
                    Ok(page) => page,
                    Err(error) => {
                        let mut state = entry.state.lock().await;
                        if state.same_observation(generation, observation_epoch) {
                            state.last_error = Some(error.to_string());
                        }
                        return Err(error);
                    }
                };
                let Some(turn_id) = page
                    .turns
                    .iter()
                    .find(|turn| turn.status == TurnStatus::InProgress)
                    .map(|turn| turn.id.clone())
                else {
                    return Err(AgentError::Failed(format!(
                        "active thread {thread_id} did not expose its active turn"
                    )));
                };
                let mut state = entry.state.lock().await;
                if !state.same_observation(generation, observation_epoch) {
                    return Err(AgentError::Failed(format!(
                        "conversation {thread_id} changed connection while locating its active turn"
                    )));
                }
                state.active_turn_id = Some(turn_id.clone());
                state.active_turn_cwd = Some(thread.cwd.clone());
                state.terminal_candidate_turn_id = Some(turn_id.clone());
                state
                    .events
                    .accept_history_page(&thread, &page, current.revision, None);
                state.events.trim(thread_id);
                merge_latest_turns_page(&mut state.turns_page, SessionTurnPage::from(&page));
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
            Err(AgentError::Failed(format!(
                "conversation {thread_id} cannot take a prompt"
            )))
        }
    }

    pub(in crate::app::tasks) async fn record_turn_started(
        &self,
        generation: u64,
        thread_id: &str,
        cwd: Option<&str>,
        turn: TurnState,
        options: TurnOptions,
    ) -> Option<u64> {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.generation != generation {
            return None;
        }
        let active_turn_cwd = cwd
            .map(str::to_string)
            .or_else(|| state.conversation.as_ref().map(|thread| thread.cwd.clone()));
        if let Some(cwd) = cwd
            && let Some(thread) = state.conversation.as_mut()
        {
            thread.cwd = cwd.to_string();
        }
        let already_ended = turn_is_terminal(&state, &turn.id);
        if !already_ended {
            state.active_turn_id = Some(turn.id.clone());
            state.active_turn_cwd = active_turn_cwd;
            state.terminal_candidate_turn_id = Some(turn.id.clone());
            state.runtime_lease = true;
        }
        if options.permission_mode.is_some() {
            state.permission_mode = options.permission_mode;
        }
        if options.model.is_some() {
            state.model = options.model;
        }
        if options.effort.is_some() {
            state.reasoning_effort = options.effort;
        }
        state.fast_mode = options.fast_mode;
        if !already_ended {
            upsert_turn(&mut state.turns_page, turn.clone());
        }
        state.revision = state.revision.saturating_add(1);
        if !already_ended {
            state.events.publish_session_event(
                &SessionEvent {
                    thread_id: thread_id.to_string(),
                    kind: SessionEventKind::TurnStarted { turn },
                },
                state.revision,
            );
        }
        state.last_sync_ms = Some(now_unix_ms());
        Some(state.revision)
    }

    /// Record a provider-accepted message steered into the current turn.
    ///
    /// The session does not retain item payloads, but a history reader still
    /// needs the causal fact that the provider accepted new conversation work.
    pub(in crate::app::tasks) async fn record_prompt_accepted(
        &self,
        generation: u64,
        thread_id: &str,
        turn_id: &str,
    ) -> Option<u64> {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.generation != generation {
            return None;
        }
        if !turn_is_terminal(&state, turn_id)
            && (state.active_turn_id.as_deref() == Some(turn_id)
                || state.terminal_candidate_turn_id.as_deref() == Some(turn_id))
        {
            state.runtime_lease = true;
        }
        state.revision = state.revision.saturating_add(1);
        state.last_sync_ms = Some(now_unix_ms());
        Some(state.revision)
    }

    pub(in crate::app::tasks) async fn active_turn_id(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<String>, AgentError> {
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
        if state.generation != generation || state.revision != snapshot.revision {
            return Ok(state.active_turn_id.clone());
        }
        if let Some(conversation) = state.conversation.as_ref() {
            state
                .events
                .accept_history_page(conversation, &page, snapshot.revision, None);
        }
        merge_latest_turns_page(&mut state.turns_page, SessionTurnPage::from(&page));
        state.revision = state.revision.saturating_add(1);
        Ok(turn_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

    #[tokio::test]
    async fn accepted_steering_retains_the_runtime_after_its_request_ends() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: vec![],
                },
                vec![],
                vec![wire_turn("running", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = TaskSessions::default();
        let request = sessions.reserve_request("thread-1").await;
        let target = sessions
            .prepare_prompt(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        assert!(matches!(target, PromptTarget::Steer { turn_id } if turn_id == "running"));
        sessions
            .record_prompt_accepted(1, "thread-1", "running")
            .await
            .unwrap();
        drop(request);
        while sessions.diagnostics().await.request_leases != 0 {
            tokio::task::yield_now().await;
        }
        assert!(sessions.snapshot("thread-1").await.unwrap().runtime_lease);
        assert_eq!(methods(&client).await, ["thread/resume"]);
    }

    #[tokio::test]
    async fn late_start_and_steer_acceptance_cannot_revive_a_completed_turn() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, vec![], vec![]),
        )]);
        let sessions = TaskSessions::default();
        let _request = sessions.reserve_request("thread-1").await;
        sessions
            .prepare_prompt(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnEnded {
                        turn: turn("finished", TurnStatus::Completed),
                    },
                ),
            )
            .await;
        sessions
            .record_turn_started(
                1,
                "thread-1",
                None,
                turn("finished", TurnStatus::InProgress),
                TurnOptions::default(),
            )
            .await
            .unwrap();
        sessions
            .record_prompt_accepted(1, "thread-1", "finished")
            .await
            .unwrap();
        let snapshot = sessions.snapshot("thread-1").await.unwrap();
        assert_eq!(snapshot.active_turn_id, None);
        assert!(!snapshot.runtime_lease);
        assert_eq!(
            snapshot.turns_page.unwrap().turns[0].status,
            TurnStatus::Completed
        );
    }

    #[tokio::test]
    async fn a_prompt_resume_cannot_retain_history_after_the_task_is_forgotten() {
        use crate::app::tasks::test_support::wait_for_mock_method;
        let (pending, release) = MockCodexResponse::gated_ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Idle,
                vec![wire_turn("stale", TurnStatus::Completed)],
                vec![],
            ),
        );
        let client = CodexThreadClient::mock(vec![pending]);
        let sessions = TaskSessions::default();
        let preparing = {
            let sessions = sessions.clone();
            let driver = client.driver();
            tokio::spawn(async move { sessions.resume_for_prompt(&driver, 1, "thread-1").await })
        };
        wait_for_mock_method(&client, "thread/resume").await;
        sessions.forget_thread("thread-1").await;
        release.send(()).unwrap();
        assert!(preparing.await.unwrap().is_err());
        assert!(sessions.snapshot("thread-1").await.is_none());
        assert!(sessions.events.for_thread("thread-1").is_empty());
        assert_eq!(client.mock_requests().await.len(), 1);
    }

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
            !sessions
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
            Err(AgentError::TimedOut(_))
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
                TurnOptions::default(),
            )
            .await;
        viewer
            .await
            .expect("viewer task")
            .expect("viewer subscription");
        assert_eq!(methods(&client).await, vec!["thread/resume"]);
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.history_base_revision, Some(0));
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
            Err(AgentError::TimedOut(_))
        ));
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert!(!snapshot.runtime_lease);
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Error);
        assert!(snapshot.conversation.is_none());
        assert!(snapshot.last_error.is_some());
    }
}
