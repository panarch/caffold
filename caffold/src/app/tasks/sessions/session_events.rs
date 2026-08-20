use crate::agent::{SessionEvent, SessionEventKind, ThreadStatus, TurnStatus};

use super::{
    SessionEventOutcome, SessionLifecycle, SessionState, TaskSessions, TerminalTurnApplyOutcome,
};
use super::{
    reconciliation::apply_thread_settings,
    turns::{active_turn_id, turn_is_terminal, update_active_turn, upsert_turn},
};

impl TaskSessions {
    #[cfg(test)]
    pub(super) async fn apply_session_event(&self, generation: u64, event: &SessionEvent) {
        self.apply_session_event_with_outcome(generation, event)
            .await;
    }

    /// Take one report from the live stream into the canonical session.
    ///
    /// A report that arrives for a generation this session has moved past is
    /// dropped: the connection it came from is no longer the one being read.
    pub(in crate::app::tasks) async fn apply_session_event_with_outcome(
        &self,
        generation: u64,
        event: &SessionEvent,
    ) -> SessionEventOutcome {
        let Some(entry) = self.existing_entry(&event.thread_id).await else {
            return SessionEventOutcome::default();
        };
        let (effect, should_unsubscribe, terminal) = {
            let mut state = entry.state.lock().await;
            if state.generation != generation {
                return SessionEventOutcome::default();
            }
            let terminal = match &event.kind {
                SessionEventKind::TurnEnded { turn } => Some(TerminalTurnApplyOutcome {
                    first_current_transition: is_first_current_terminal_transition(
                        &state,
                        &turn.id,
                        turn.status,
                    ),
                }),
                _ => None,
            };
            let effect = apply_session_event_state(&mut state, &event.kind);
            if effect != SessionEventEffect::Ignored {
                state.revision = state.revision.saturating_add(1);
                mark_what_changed(&mut state, &event.kind);
            }
            (
                effect,
                state.viewer_leases == 0 && !state.runtime_lease,
                terminal,
            )
        };
        let advances_revision = effect != SessionEventEffect::Ignored;
        if advances_revision && should_unsubscribe {
            self.unsubscribe_if_unused(&event.thread_id, &entry).await;
        }
        SessionEventOutcome {
            canonical_state_changed: effect == SessionEventEffect::CanonicalStateChanged,
            terminal,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionEventEffect {
    Ignored,
    RevisionOnly,
    CanonicalStateChanged,
}

/// Record which of the two separately watched fields this event moved.
///
/// A reader that only wants the status, or only the name, compares its own
/// revision against these rather than against every change to the session.
fn mark_what_changed(state: &mut SessionState, kind: &SessionEventKind) {
    match kind {
        SessionEventKind::ConversationStarted { .. } => {
            state.status_revision = state.revision;
            state.name_revision = state.revision;
        }
        SessionEventKind::StatusChanged { .. } => state.status_revision = state.revision,
        SessionEventKind::TitleChanged { .. } => state.name_revision = state.revision,
        _ => {}
    }
}

fn is_first_current_terminal_transition(
    state: &SessionState,
    turn_id: &str,
    status: TurnStatus,
) -> bool {
    if status == TurnStatus::InProgress
        || state.terminal_candidate_turn_id.as_deref() != Some(turn_id)
    {
        return false;
    }
    !turn_is_terminal(state, turn_id)
}

fn apply_session_event_state(
    state: &mut SessionState,
    kind: &SessionEventKind,
) -> SessionEventEffect {
    match kind {
        SessionEventKind::ConversationStarted { conversation } => {
            if state.lifecycle == SessionLifecycle::Subscribing || state.conversation.is_some() {
                return SessionEventEffect::Ignored;
            }
            let next_active_turn_id = active_turn_id(conversation, state.turns_page.as_ref())
                .filter(|turn_id| !turn_is_terminal(state, turn_id));
            update_active_turn(
                state,
                next_active_turn_id.clone(),
                Some(conversation.cwd.clone()),
            );
            state.terminal_candidate_turn_id = next_active_turn_id;
            state.conversation = Some(conversation.clone());
            state.pending_thread_status = None;
            SessionEventEffect::CanonicalStateChanged
        }
        SessionEventKind::StatusChanged { status } => {
            let terminal = !matches!(status, ThreadStatus::Active { .. });
            if let Some(conversation) = state.conversation.as_mut() {
                conversation.status = status.clone();
            } else {
                state.pending_thread_status = Some(status.clone());
            }
            if terminal {
                state.active_turn_id = None;
                state.active_turn_cwd = None;
                if state.terminal_candidate_turn_id.is_none() {
                    state.runtime_lease = false;
                }
            }
            SessionEventEffect::CanonicalStateChanged
        }
        SessionEventKind::TitleChanged { title } => {
            let Some(conversation) = state.conversation.as_mut() else {
                return SessionEventEffect::Ignored;
            };
            if conversation.title == *title {
                return SessionEventEffect::Ignored;
            }
            conversation.title = title.clone();
            SessionEventEffect::CanonicalStateChanged
        }
        SessionEventKind::SettingsChanged { settings } => {
            apply_thread_settings(state, settings);
            SessionEventEffect::CanonicalStateChanged
        }
        SessionEventKind::TurnStarted { turn } => {
            if turn_is_terminal(state, &turn.id) {
                return SessionEventEffect::Ignored;
            }
            let inferred_cwd = state
                .conversation
                .as_ref()
                .map(|conversation| conversation.cwd.clone());
            update_active_turn(state, Some(turn.id.clone()), inferred_cwd);
            if state.lifecycle == SessionLifecycle::Subscribed {
                state.terminal_candidate_turn_id = Some(turn.id.clone());
            }
            state.runtime_lease = true;
            upsert_turn(&mut state.turns_page, turn.clone());
            SessionEventEffect::CanonicalStateChanged
        }
        SessionEventKind::TurnEnded { turn } => {
            if turn.status == TurnStatus::InProgress {
                return SessionEventEffect::Ignored;
            }
            if state.active_turn_id.as_deref() == Some(turn.id.as_str()) {
                state.active_turn_id = None;
                state.active_turn_cwd = None;
                state.runtime_lease = false;
            }
            if state.terminal_candidate_turn_id.as_deref() == Some(turn.id.as_str()) {
                state.terminal_candidate_turn_id = None;
                state.runtime_lease = false;
            }
            upsert_turn(&mut state.turns_page, turn.clone());
            SessionEventEffect::CanonicalStateChanged
        }
        // The session does not hold the conversation's items or its diff; a
        // reader waiting on either has something new to fetch, and that is all
        // this says.
        SessionEventKind::ItemChanged { .. } | SessionEventKind::DiffChanged => {
            SessionEventEffect::RevisionOnly
        }
        // Neither belongs to the session: usage is a diagnostic, and an approval
        // answered elsewhere is the runtime's to withdraw.
        SessionEventKind::UsageReported { .. }
        | SessionEventKind::ApprovalAnsweredElsewhere { .. } => SessionEventEffect::Ignored,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

    #[tokio::test]
    async fn item_and_diff_reports_advance_revision_without_changing_canonical_state() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");
        let initial_revision = sessions
            .snapshot("thread-1")
            .await
            .expect("initial snapshot")
            .revision;
        let events = [
            session_event("thread-1", item_changed("turn-1", "item-1", 10)),
            session_event("thread-1", item_changed("turn-1", "item-2", 20)),
            session_event("thread-1", item_changed("turn-1", "item-3", 30)),
            session_event("thread-1", SessionEventKind::DiffChanged),
        ];

        for (index, event) in events.iter().enumerate() {
            let outcome = sessions.apply_session_event_with_outcome(1, event).await;
            assert!(!outcome.canonical_state_changed);
            assert_eq!(
                sessions
                    .snapshot("thread-1")
                    .await
                    .expect("event snapshot")
                    .revision,
                initial_revision + index as u64 + 1
            );
        }

        let canonical = sessions
            .apply_session_event_with_outcome(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::StatusChanged {
                        status: ThreadStatus::SystemError,
                    },
                ),
            )
            .await;
        assert!(canonical.canonical_state_changed);
        assert_eq!(
            sessions
                .snapshot("thread-1")
                .await
                .expect("canonical snapshot")
                .revision,
            initial_revision + 5
        );
    }

    #[tokio::test]
    async fn a_session_with_no_baseline_adopts_the_conversation_codex_announces() {
        // A subscription that could not read the thread leaves the session
        // holding a lease and nothing to show. Codex announcing the thread is
        // then the first baseline this session has, rather than a replay
        // competing with one.
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "thread/resume",
            CodexThreadError::ThreadUnavailable("thread-1".to_string()),
        )]);
        let sessions = TaskSessions::default();
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect_err("the thread could not be read");

        let started = thread(
            ThreadStatus::Active {
                active_flags: Vec::new(),
            },
            vec![wire_turn("turn-1", TurnStatus::InProgress)],
        );
        let outcome = sessions
            .apply_session_event_with_outcome(
                1,
                &session_event("thread-1", conversation_started(&started)),
            )
            .await;

        assert!(outcome.canonical_state_changed);
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(
            snapshot.conversation.expect("adopted conversation").id,
            "thread-1"
        );
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-1"));
    }

    #[tokio::test]
    async fn a_started_turn_does_not_change_canonical_thread_status() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");

        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnStarted {
                        turn: turn("turn-1", TurnStatus::InProgress),
                    },
                ),
            )
            .await;

        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(
            snapshot.conversation.expect("canonical thread").status,
            ThreadStatus::Idle,
            "a turn report must not synthesize thread status"
        );
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-1"));
    }

    #[tokio::test]
    async fn an_ended_turn_does_not_change_canonical_thread_status() {
        let active = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                active.clone(),
                Vec::new(),
                vec![wire_turn("turn-1", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = TaskSessions::default();
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");

        let outcome = sessions
            .apply_session_event_with_outcome(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnEnded {
                        turn: turn("turn-1", TurnStatus::Completed),
                    },
                ),
            )
            .await;
        assert_eq!(
            outcome.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: true,
            })
        );

        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(
            snapshot.conversation.expect("canonical thread").status,
            active,
            "a turn report must not synthesize thread status"
        );
        assert_eq!(snapshot.active_turn_id, None);
    }

    #[tokio::test]
    async fn terminal_apply_outcome_is_atomic_across_idle_replay_and_newer_turns() {
        let active = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                active,
                Vec::new(),
                vec![wire_turn("turn-1", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = TaskSessions::default();
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");
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
        let completion = session_event(
            "thread-1",
            SessionEventKind::TurnEnded {
                turn: turn("turn-1", TurnStatus::Completed),
            },
        );

        let first = sessions
            .apply_session_event_with_outcome(1, &completion)
            .await;
        assert!(first.canonical_state_changed);
        assert_eq!(
            first.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: true,
            })
        );

        let replay = sessions
            .apply_session_event_with_outcome(1, &completion)
            .await;
        assert_eq!(
            replay.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            })
        );

        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnStarted {
                        turn: turn("turn-newer", TurnStatus::InProgress),
                    },
                ),
            )
            .await;
        let stale = sessions
            .apply_session_event_with_outcome(1, &completion)
            .await;
        assert_eq!(
            stale.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            })
        );
    }

    #[tokio::test]
    async fn terminal_apply_outcome_rejects_wrong_generation_and_nonterminal_status() {
        let active = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                active,
                Vec::new(),
                vec![wire_turn("turn-1", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = TaskSessions::default();
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");
        let in_progress_completion = session_event(
            "thread-1",
            SessionEventKind::TurnEnded {
                turn: turn("turn-1", TurnStatus::InProgress),
            },
        );

        assert_eq!(
            sessions
                .apply_session_event_with_outcome(2, &in_progress_completion)
                .await,
            SessionEventOutcome::default()
        );
        let nonterminal = sessions
            .apply_session_event_with_outcome(1, &in_progress_completion)
            .await;
        assert!(!nonterminal.canonical_state_changed);
        assert_eq!(
            nonterminal.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            })
        );
        assert_eq!(
            sessions
                .apply_session_event_with_outcome(
                    1,
                    &session_event(
                        "thread-1",
                        SessionEventKind::TurnEnded {
                            turn: turn("turn-1", TurnStatus::Completed)
                        }
                    ),
                )
                .await
                .terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: true,
            }),
            "a malformed non-terminal completion must not consume the live candidate"
        );
    }

    #[tokio::test]
    async fn a_subscribing_session_rejects_bootstrap_and_terminal_replays() {
        let active = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let old_completed = wire_turn("turn-old", TurnStatus::Completed);
        let current_in_progress = wire_turn_at("turn-current", TurnStatus::InProgress, 2.0);
        let mut response = resume_response(
            active.clone(),
            Vec::new(),
            vec![current_in_progress, old_completed.clone()],
        );
        response.thread.name = Some("Current task name".to_string());
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/resume",
            response,
            Duration::from_millis(100),
        )]);
        let sessions = TaskSessions::default();
        let subscribing_sessions = sessions.clone();
        let subscribing_client = client.clone();
        let subscription = tokio::spawn(async move {
            subscribing_sessions
                .ensure_subscribed(&subscribing_client.driver(), 1, "thread-1")
                .await
        });
        wait_for_method_count(&client, "thread/resume", 1).await;

        let mut replayed_thread =
            thread(active, vec![wire_turn("turn-old", TurnStatus::InProgress)]);
        replayed_thread.name = Some("Old task name".to_string());
        assert_eq!(
            sessions
                .apply_session_event_with_outcome(
                    1,
                    &session_event("thread-1", conversation_started(&replayed_thread)),
                )
                .await,
            SessionEventOutcome::default(),
            "a bootstrap thread snapshot must not compete with the resume baseline"
        );

        subscription
            .await
            .expect("subscription task joins")
            .expect("subscription baseline succeeds");

        assert!(
            !sessions
                .apply_session_event_with_outcome(
                    1,
                    &session_event(
                        "thread-1",
                        SessionEventKind::TurnStarted {
                            turn: turn("turn-old", TurnStatus::InProgress)
                        }
                    ),
                )
                .await
                .canonical_state_changed,
            "a terminal turn in the baseline cannot regress to in-progress"
        );
        let bootstrap_completion = session_event(
            "thread-1",
            SessionEventKind::TurnEnded {
                turn: Turn::from(&old_completed),
            },
        );
        assert_eq!(
            sessions
                .apply_session_event_with_outcome(1, &bootstrap_completion)
                .await
                .terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            }),
            "a terminal turn in the baseline remains a replay"
        );
        let current_completion = session_event(
            "thread-1",
            SessionEventKind::TurnEnded {
                turn: Turn::from(&wire_turn_at("turn-current", TurnStatus::Completed, 2.0)),
            },
        );
        assert_eq!(
            sessions
                .apply_session_event_with_outcome(1, &current_completion)
                .await
                .terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: true,
            })
        );
        assert_eq!(
            sessions
                .apply_session_event_with_outcome(1, &current_completion)
                .await
                .terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            })
        );
    }

    #[tokio::test]
    async fn a_title_change_updates_the_canonical_session_metadata() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let initial = sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");

        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TitleChanged {
                        title: Some("Whisper voice input".to_string()),
                    },
                ),
            )
            .await;

        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.revision, initial.revision + 1);
        assert_eq!(
            snapshot
                .conversation
                .expect("canonical thread")
                .title
                .as_deref(),
            Some("Whisper voice input")
        );
    }

    #[tokio::test]
    async fn a_settings_change_updates_fast_mode() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");

        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::SettingsChanged {
                        settings: std::collections::BTreeMap::from([
                            ("model".to_string(), json!("gpt-5.6-sol")),
                            ("reasoningEffort".to_string(), json!("low")),
                            ("serviceTier".to_string(), json!("priority")),
                        ]),
                    },
                ),
            )
            .await;

        let snapshot = sessions.snapshot("thread-1").await.unwrap();
        assert!(snapshot.fast_mode);
        assert_eq!(snapshot.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(snapshot.reasoning_effort.as_deref(), Some("low"));
    }

    #[tokio::test]
    async fn an_idle_status_overrides_a_stale_in_progress_turn_page() {
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
    async fn a_started_turn_updates_only_the_turn_session_state() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");
        let initial_revision = sessions
            .snapshot("thread-1")
            .await
            .expect("initial snapshot")
            .revision;

        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnStarted {
                        turn: turn("turn-live", TurnStatus::InProgress),
                    },
                ),
            )
            .await;
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert_eq!(snapshot.revision, initial_revision + 1);
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-live"));
        assert!(snapshot.runtime_lease);
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| thread.status == ThreadStatus::Idle),
            "a turn report must not synthesize thread status"
        );
    }

    #[tokio::test]
    async fn an_ended_turn_clears_running_state_and_keeps_the_viewer_subscription() {
        let active = wire_turn("turn-live", TurnStatus::InProgress);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![active],
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
                    SessionEventKind::TurnEnded {
                        turn: turn("turn-live", TurnStatus::Completed),
                    },
                ),
            )
            .await;
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

        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.lifecycle, SessionLifecycle::Subscribed);
        assert_eq!(snapshot.viewer_leases, 1);
        assert!(!snapshot.runtime_lease);
        assert_eq!(snapshot.active_turn_id, None);
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| thread.status == ThreadStatus::Idle)
        );
    }

    #[tokio::test]
    async fn idle_before_completion_keeps_runtime_until_the_terminal_transition_arrives() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Active {
                        active_flags: Vec::new(),
                    },
                    Vec::new(),
                    vec![wire_turn("turn-live", TurnStatus::InProgress)],
                ),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Idle,
                    Vec::new(),
                    vec![wire_turn("turn-live", TurnStatus::InProgress)],
                ),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let sessions = TaskSessions::default();
        sessions
            .recover_loaded_thread(&client.driver(), 1, "thread-1")
            .await
            .expect("recover active thread")
            .expect("active thread remains subscribed");

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
        let idle = sessions.snapshot("thread-1").await.expect("idle snapshot");
        assert!(idle.runtime_lease);
        assert_eq!(idle.active_turn_id, None);

        let refreshed = sessions
            .refresh_subscription(&client.driver(), 1, "thread-1")
            .await
            .expect("refresh after early idle");
        assert!(
            refreshed.runtime_lease,
            "a refresh must not release the runtime while the current turn still awaits completion"
        );
        assert_eq!(refreshed.active_turn_id, None);

        let completion = sessions
            .apply_session_event_with_outcome(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnEnded {
                        turn: turn("turn-live", TurnStatus::Completed),
                    },
                ),
            )
            .await;
        assert_eq!(
            completion.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: true,
            })
        );
        wait_for_unsubscribe(&client).await;
        let completed = sessions
            .snapshot("thread-1")
            .await
            .expect("completed snapshot");
        assert!(!completed.runtime_lease);
    }
}
