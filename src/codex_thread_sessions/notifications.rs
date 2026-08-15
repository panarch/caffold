use crate::codex_app_server::{CodexNotification, CodexTurn, ThreadStatus, TurnStatus};

use super::{
    CodexThreadSessions, NotificationApplyOutcome, TerminalTurnApplyOutcome,
    ThreadSessionLifecycle, ThreadSessionState,
};
use super::{
    reconciliation::apply_thread_settings,
    turns::{active_turn_id, turn_is_terminal, update_active_turn, upsert_turn},
};

impl CodexThreadSessions {
    #[cfg(test)]
    pub(super) async fn apply_notification(
        &self,
        generation: u64,
        notification: &CodexNotification,
    ) -> Option<u64> {
        self.apply_notification_with_outcome(generation, notification)
            .await
            .revision
    }

    pub(crate) async fn apply_notification_with_outcome(
        &self,
        generation: u64,
        notification: &CodexNotification,
    ) -> NotificationApplyOutcome {
        let Some(thread_id) = notification_thread_id(notification) else {
            return NotificationApplyOutcome::default();
        };
        let Some(entry) = self.existing_entry(thread_id).await else {
            return NotificationApplyOutcome::default();
        };
        let (changed, should_unsubscribe, revision, terminal) = {
            let mut state = entry.state.lock().await;
            if state.generation != generation {
                return NotificationApplyOutcome::default();
            }
            let terminal = match notification {
                CodexNotification::TurnCompleted { turn, .. } => Some(TerminalTurnApplyOutcome {
                    first_current_transition: is_first_current_terminal_transition(&state, turn),
                }),
                _ => None,
            };
            let changed = apply_notification_state(&mut state, notification);
            if changed {
                state.revision = state.revision.saturating_add(1);
                if notification_changes_status(notification) {
                    state.status_revision = state.revision;
                }
                if notification_changes_name(notification) {
                    state.name_revision = state.revision;
                }
            }
            (
                changed,
                state.viewer_leases == 0 && !state.runtime_lease,
                state.revision,
                terminal,
            )
        };
        if changed && should_unsubscribe {
            self.unsubscribe_if_unused(thread_id, &entry).await;
        }
        NotificationApplyOutcome {
            revision: changed.then_some(revision),
            terminal,
        }
    }
}

fn notification_thread_id(notification: &CodexNotification) -> Option<&str> {
    match notification {
        CodexNotification::ThreadStarted { thread } => Some(&thread.id),
        CodexNotification::ThreadStatusChanged { thread_id, .. }
        | CodexNotification::ThreadNameUpdated { thread_id, .. }
        | CodexNotification::ThreadSettingsUpdated { thread_id, .. }
        | CodexNotification::ThreadTokenUsageUpdated { thread_id, .. }
        | CodexNotification::TurnStarted { thread_id, .. }
        | CodexNotification::TurnCompleted { thread_id, .. }
        | CodexNotification::ItemStarted { thread_id, .. }
        | CodexNotification::ItemCompleted { thread_id, .. }
        | CodexNotification::RawResponseItemCompleted { thread_id, .. }
        | CodexNotification::TurnDiffUpdated { thread_id, .. }
        | CodexNotification::ServerRequestResolved { thread_id, .. } => Some(thread_id),
        CodexNotification::Unknown { .. } => None,
    }
}

fn notification_changes_status(notification: &CodexNotification) -> bool {
    matches!(
        notification,
        CodexNotification::ThreadStarted { .. } | CodexNotification::ThreadStatusChanged { .. }
    )
}

fn notification_changes_name(notification: &CodexNotification) -> bool {
    matches!(
        notification,
        CodexNotification::ThreadStarted { .. } | CodexNotification::ThreadNameUpdated { .. }
    )
}

fn is_first_current_terminal_transition(state: &ThreadSessionState, turn: &CodexTurn) -> bool {
    if turn.status == TurnStatus::InProgress
        || state.terminal_candidate_turn_id.as_deref() != Some(turn.id.as_str())
    {
        return false;
    }
    !turn_is_terminal(state, &turn.id)
}

fn apply_notification_state(
    state: &mut ThreadSessionState,
    notification: &CodexNotification,
) -> bool {
    match notification {
        CodexNotification::ThreadStarted { thread } => {
            if state.lifecycle == ThreadSessionLifecycle::Subscribing || state.thread.is_some() {
                return false;
            }
            let next_active_turn_id = active_turn_id(thread, state.turns_page.as_ref())
                .filter(|turn_id| !turn_is_terminal(state, turn_id));
            update_active_turn(state, next_active_turn_id.clone(), Some(thread.cwd.clone()));
            state.terminal_candidate_turn_id = next_active_turn_id;
            state.thread = Some(thread.clone());
            state.pending_thread_status = None;
            true
        }
        CodexNotification::ThreadStatusChanged { status, .. } => {
            if let Some(thread) = state.thread.as_mut() {
                thread.status = status.clone();
            } else {
                state.pending_thread_status = Some(status.clone());
            }
            let terminal = !matches!(status, ThreadStatus::Active { .. });
            if terminal {
                state.active_turn_id = None;
                state.active_turn_cwd = None;
                if state.terminal_candidate_turn_id.is_none() {
                    state.runtime_lease = false;
                }
            }
            true
        }
        CodexNotification::ThreadNameUpdated { thread_name, .. } => {
            let Some(thread) = state.thread.as_mut() else {
                return false;
            };
            if thread.name == *thread_name {
                return false;
            }
            thread.name = thread_name.clone();
            true
        }
        CodexNotification::ThreadSettingsUpdated {
            thread_settings, ..
        } => {
            apply_thread_settings(state, thread_settings);
            true
        }
        CodexNotification::TurnStarted { turn, .. } => {
            if turn_is_terminal(state, &turn.id) {
                return false;
            }
            let inferred_cwd = state.thread.as_ref().map(|thread| thread.cwd.clone());
            update_active_turn(state, Some(turn.id.clone()), inferred_cwd);
            if state.lifecycle == ThreadSessionLifecycle::Subscribed {
                state.terminal_candidate_turn_id = Some(turn.id.clone());
            }
            state.runtime_lease = true;
            upsert_turn(&mut state.turns_page, turn.clone());
            true
        }
        CodexNotification::TurnCompleted { turn, .. } => {
            if turn.status == TurnStatus::InProgress {
                return false;
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
            true
        }
        CodexNotification::ItemStarted { .. }
        | CodexNotification::ItemCompleted { .. }
        | CodexNotification::RawResponseItemCompleted { .. }
        | CodexNotification::TurnDiffUpdated { .. } => true,
        CodexNotification::ThreadTokenUsageUpdated { .. }
        | CodexNotification::ServerRequestResolved { .. } => false,
        CodexNotification::Unknown { .. } => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_thread_sessions::test_support::*;

    #[tokio::test]
    async fn turn_started_notification_does_not_change_canonical_thread_status() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = CodexThreadSessions::default();
        sessions
            .ensure_subscribed(&client, 1, "thread-1")
            .await
            .expect("subscribe");

        sessions
            .apply_notification(
                1,
                &CodexNotification::TurnStarted {
                    thread_id: "thread-1".to_string(),
                    turn: turn("turn-1", TurnStatus::InProgress),
                },
            )
            .await;

        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(
            snapshot.thread.expect("canonical thread").status,
            ThreadStatus::Idle,
            "turn notifications must not synthesize thread status"
        );
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-1"));
    }

    #[tokio::test]
    async fn turn_completed_notification_does_not_change_canonical_thread_status() {
        let active = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                active.clone(),
                Vec::new(),
                vec![turn("turn-1", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = CodexThreadSessions::default();
        sessions
            .ensure_subscribed(&client, 1, "thread-1")
            .await
            .expect("subscribe");

        let outcome = sessions
            .apply_notification_with_outcome(
                1,
                &CodexNotification::TurnCompleted {
                    thread_id: "thread-1".to_string(),
                    turn: turn("turn-1", TurnStatus::Completed),
                },
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
            snapshot.thread.expect("canonical thread").status,
            active,
            "turn notifications must not synthesize thread status"
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
                vec![turn("turn-1", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = CodexThreadSessions::default();
        sessions
            .ensure_subscribed(&client, 1, "thread-1")
            .await
            .expect("subscribe");
        sessions
            .apply_notification(
                1,
                &CodexNotification::ThreadStatusChanged {
                    thread_id: "thread-1".to_string(),
                    status: ThreadStatus::Idle,
                },
            )
            .await;
        let completion = CodexNotification::TurnCompleted {
            thread_id: "thread-1".to_string(),
            turn: turn("turn-1", TurnStatus::Completed),
        };

        let first = sessions
            .apply_notification_with_outcome(1, &completion)
            .await;
        assert!(first.revision.is_some());
        assert_eq!(
            first.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: true,
            })
        );

        let replay = sessions
            .apply_notification_with_outcome(1, &completion)
            .await;
        assert_eq!(
            replay.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            })
        );

        sessions
            .apply_notification(
                1,
                &CodexNotification::TurnStarted {
                    thread_id: "thread-1".to_string(),
                    turn: turn("turn-newer", TurnStatus::InProgress),
                },
            )
            .await;
        let stale = sessions
            .apply_notification_with_outcome(1, &completion)
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
                vec![turn("turn-1", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = CodexThreadSessions::default();
        sessions
            .ensure_subscribed(&client, 1, "thread-1")
            .await
            .expect("subscribe");
        let in_progress_completion = CodexNotification::TurnCompleted {
            thread_id: "thread-1".to_string(),
            turn: turn("turn-1", TurnStatus::InProgress),
        };

        assert_eq!(
            sessions
                .apply_notification_with_outcome(2, &in_progress_completion)
                .await,
            NotificationApplyOutcome::default()
        );
        let nonterminal = sessions
            .apply_notification_with_outcome(1, &in_progress_completion)
            .await;
        assert_eq!(nonterminal.revision, None);
        assert_eq!(
            nonterminal.terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            })
        );
        assert_eq!(
            sessions
                .apply_notification_with_outcome(
                    1,
                    &CodexNotification::TurnCompleted {
                        thread_id: "thread-1".to_string(),
                        turn: turn("turn-1", TurnStatus::Completed),
                    },
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
    async fn subscription_notifications_reject_bootstrap_and_terminal_replays() {
        let active = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let old_completed = turn("turn-old", TurnStatus::Completed);
        let current_in_progress = turn_at("turn-current", TurnStatus::InProgress, 2.0);
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
        let sessions = CodexThreadSessions::default();
        let subscribing_sessions = sessions.clone();
        let subscribing_client = client.clone();
        let subscription = tokio::spawn(async move {
            subscribing_sessions
                .ensure_subscribed(&subscribing_client, 1, "thread-1")
                .await
        });
        wait_for_method_count(&client, "thread/resume", 1).await;

        let mut replayed_thread = thread(active, vec![turn("turn-old", TurnStatus::InProgress)]);
        replayed_thread.name = Some("Old task name".to_string());
        assert_eq!(
            sessions
                .apply_notification_with_outcome(
                    1,
                    &CodexNotification::ThreadStarted {
                        thread: replayed_thread,
                    },
                )
                .await,
            NotificationApplyOutcome::default(),
            "a bootstrap thread snapshot must not compete with the resume baseline"
        );

        subscription
            .await
            .expect("subscription task joins")
            .expect("subscription baseline succeeds");

        assert_eq!(
            sessions
                .apply_notification_with_outcome(
                    1,
                    &CodexNotification::TurnStarted {
                        thread_id: "thread-1".to_string(),
                        turn: turn("turn-old", TurnStatus::InProgress),
                    },
                )
                .await
                .revision,
            None,
            "a terminal turn in the baseline cannot regress to in-progress"
        );
        let bootstrap_completion = CodexNotification::TurnCompleted {
            thread_id: "thread-1".to_string(),
            turn: old_completed,
        };
        assert_eq!(
            sessions
                .apply_notification_with_outcome(1, &bootstrap_completion)
                .await
                .terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            }),
            "a terminal turn in the baseline remains a replay"
        );
        let current_completion = CodexNotification::TurnCompleted {
            thread_id: "thread-1".to_string(),
            turn: turn_at("turn-current", TurnStatus::Completed, 2.0),
        };
        assert_eq!(
            sessions
                .apply_notification_with_outcome(1, &current_completion)
                .await
                .terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: true,
            })
        );
        assert_eq!(
            sessions
                .apply_notification_with_outcome(1, &current_completion)
                .await
                .terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: false,
            })
        );
    }

    #[tokio::test]
    async fn thread_name_notification_updates_the_canonical_session_metadata() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = CodexThreadSessions::default();
        let initial = sessions
            .ensure_subscribed(&client, 1, "thread-1")
            .await
            .expect("subscribe");

        let revision = sessions
            .apply_notification(
                1,
                &CodexNotification::ThreadNameUpdated {
                    thread_id: "thread-1".to_string(),
                    thread_name: Some("Whisper voice input".to_string()),
                },
            )
            .await;

        assert_eq!(revision, Some(initial.revision + 1));
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(
            snapshot.thread.expect("canonical thread").name.as_deref(),
            Some("Whisper voice input")
        );
    }

    #[tokio::test]
    async fn thread_settings_notification_updates_fast_mode() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = CodexThreadSessions::default();
        sessions
            .ensure_subscribed(&client, 1, "thread-1")
            .await
            .expect("subscribe");

        sessions
            .apply_notification(
                1,
                &CodexNotification::ThreadSettingsUpdated {
                    thread_id: "thread-1".to_string(),
                    thread_settings: std::collections::BTreeMap::from([
                        ("model".to_string(), json!("gpt-5.6-sol")),
                        ("reasoningEffort".to_string(), json!("low")),
                        ("serviceTier".to_string(), json!("priority")),
                    ]),
                },
            )
            .await;

        let snapshot = sessions.snapshot("thread-1").await.unwrap();
        assert!(snapshot.fast_mode);
        assert_eq!(snapshot.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(snapshot.reasoning_effort.as_deref(), Some("low"));
    }

    #[tokio::test]
    async fn idle_notification_overrides_stale_in_progress_turn_page() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![turn("turn-stale", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        sessions
            .apply_notification(
                1,
                &CodexNotification::ThreadStatusChanged {
                    thread_id: "thread-1".to_string(),
                    status: ThreadStatus::Idle,
                },
            )
            .await;
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert_eq!(snapshot.active_turn_id, None);
        assert!(!snapshot.runtime_lease);
        assert!(
            snapshot
                .thread
                .as_ref()
                .is_some_and(|thread| thread.status == ThreadStatus::Idle)
        );
        assert_eq!(
            snapshot.turns_page.as_ref().expect("history").data[0].status,
            TurnStatus::InProgress
        );
    }

    #[tokio::test]
    async fn turn_started_notification_updates_only_the_turn_session_state() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let revision = sessions
            .apply_notification(
                1,
                &CodexNotification::TurnStarted {
                    thread_id: "thread-1".to_string(),
                    turn: turn("turn-live", TurnStatus::InProgress),
                },
            )
            .await;
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert!(revision.is_some());
        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-live"));
        assert!(snapshot.runtime_lease);
        assert!(
            snapshot
                .thread
                .is_some_and(|thread| thread.status == ThreadStatus::Idle),
            "turn notifications must not synthesize thread status"
        );
    }

    #[tokio::test]
    async fn terminal_notifications_clear_running_state_and_keep_viewer_subscription() {
        let active = turn("turn-live", TurnStatus::InProgress);
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        sessions
            .apply_notification(
                1,
                &CodexNotification::TurnCompleted {
                    thread_id: "thread-1".to_string(),
                    turn: turn("turn-live", TurnStatus::Completed),
                },
            )
            .await;
        sessions
            .apply_notification(
                1,
                &CodexNotification::ThreadStatusChanged {
                    thread_id: "thread-1".to_string(),
                    status: ThreadStatus::Idle,
                },
            )
            .await;

        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
        assert_eq!(snapshot.viewer_leases, 1);
        assert!(!snapshot.runtime_lease);
        assert_eq!(snapshot.active_turn_id, None);
        assert!(
            snapshot
                .thread
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
                    vec![turn("turn-live", TurnStatus::InProgress)],
                ),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Idle,
                    Vec::new(),
                    vec![turn("turn-live", TurnStatus::InProgress)],
                ),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let sessions = CodexThreadSessions::default();
        sessions
            .recover_loaded_thread(&client, 1, "thread-1")
            .await
            .expect("recover active thread")
            .expect("active thread remains subscribed");

        sessions
            .apply_notification(
                1,
                &CodexNotification::ThreadStatusChanged {
                    thread_id: "thread-1".to_string(),
                    status: ThreadStatus::Idle,
                },
            )
            .await;
        let idle = sessions.snapshot("thread-1").await.expect("idle snapshot");
        assert!(idle.runtime_lease);
        assert_eq!(idle.active_turn_id, None);

        let refreshed = sessions
            .refresh_subscription(&client, 1, "thread-1")
            .await
            .expect("refresh after early idle");
        assert!(
            refreshed.runtime_lease,
            "a refresh must not release the runtime while the current turn still awaits completion"
        );
        assert_eq!(refreshed.active_turn_id, None);

        let completion = sessions
            .apply_notification_with_outcome(
                1,
                &CodexNotification::TurnCompleted {
                    thread_id: "thread-1".to_string(),
                    turn: turn("turn-live", TurnStatus::Completed),
                },
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
