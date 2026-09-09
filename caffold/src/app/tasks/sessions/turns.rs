use crate::agent::AgentError;
use crate::agent::{Conversation, Driver, ThreadStatus, TurnState, TurnStatus};

use super::super::events::{TaskHistoryCursor, TaskHistoryPage};

use super::{
    INITIAL_TURNS_PAGE_SIZE, SessionLifecycle, SessionSnapshot, SessionState, SessionTurnPage,
    TaskSessions, now_unix_ms, snapshot,
};

impl TaskSessions {
    pub(in crate::app::tasks) async fn load_history_page(
        &self,
        driver: &Driver,
        generation: u64,
        thread_id: &str,
        cursor: &TaskHistoryCursor,
        limit: usize,
    ) -> Result<(SessionSnapshot, TaskHistoryPage), AgentError> {
        self.ensure_subscribed(driver, generation, thread_id)
            .await?;
        let entry = self.entry(thread_id).await;
        let (base_revision, observation_epoch) = {
            let state = entry.state.lock().await;
            if state.generation != generation || state.lifecycle != SessionLifecycle::Subscribed {
                return Err(AgentError::Failed(format!(
                    "conversation {thread_id} changed connection before reading its history"
                )));
            }
            (state.revision, state.observation_epoch)
        };
        let page = driver
            .read_turns(thread_id, cursor.turns.as_deref(), limit)
            .await?;
        let state = entry.state.lock().await;
        if !state.same_observation(generation, observation_epoch)
            || state.lifecycle != SessionLifecycle::Subscribed
        {
            return Err(AgentError::Failed(format!(
                "conversation {thread_id} changed connection while reading its history"
            )));
        }
        if let Some(turn_id) = cursor.turn_id.as_deref()
            && !page.turns.iter().any(|turn| turn.id == turn_id)
        {
            return Err(AgentError::Failed(
                "conversation history continuation is no longer available".to_string(),
            ));
        }
        let conversation = state
            .conversation
            .as_ref()
            .ok_or_else(|| AgentError::Failed("conversation metadata is missing".to_string()))?;
        state.events.accept_history_page(
            conversation,
            &page,
            base_revision,
            cursor.turns.as_deref(),
        );
        let history = state
            .events
            .cached_history_page(thread_id, cursor)
            .ok_or_else(|| {
                AgentError::Failed("conversation history page is unavailable".to_string())
            })?;
        Ok((snapshot(&state), history))
    }

    /// Re-read the latest canonical turns for a session already being shown.
    ///
    /// Some agents can add work to their transcript without opening a turn on
    /// Caffold's live stream. This reads the agent-owned history and merges
    /// only what that source actually names. An unsubscribed session needs no
    /// eager read: its next subscription reads the same history as bootstrap.
    pub(in crate::app::tasks) async fn refresh_latest_turns(
        &self,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<SessionSnapshot>, AgentError> {
        let Some(entry) = self.existing_entry(thread_id).await else {
            return Ok(None);
        };
        let _operation = entry.operation.lock().await;
        let Some((driver, base_revision, observation_epoch)) = ({
            let state = entry.state.lock().await;
            if state.generation == generation && state.lifecycle == SessionLifecycle::Subscribed {
                state
                    .driver
                    .clone()
                    .map(|driver| (driver, state.revision, state.observation_epoch))
            } else {
                None
            }
        }) else {
            return Ok(None);
        };

        let latest = match driver
            .read_turns(thread_id, None, INITIAL_TURNS_PAGE_SIZE)
            .await
        {
            Ok(latest) => latest,
            Err(error) => {
                let mut state = entry.state.lock().await;
                if state.same_observation(generation, observation_epoch)
                    && state.lifecycle == SessionLifecycle::Subscribed
                {
                    let message = error.to_string();
                    if state.last_error.as_deref() != Some(message.as_str()) {
                        state.last_error = Some(message);
                        state.revision = state.revision.saturating_add(1);
                    }
                    return Err(error);
                }
                return Ok(None);
            }
        };
        let mut state = entry.state.lock().await;
        if !state.same_observation(generation, observation_epoch)
            || state.lifecycle != SessionLifecycle::Subscribed
        {
            return Ok(None);
        }
        let before = state.turns_page.clone();
        let previous_history_base_revision = state.history_base_revision;
        let recovered = state.last_error.take().is_some();
        if let Some(conversation) = state.conversation.as_ref() {
            state
                .events
                .accept_history_page(conversation, &latest, base_revision, None);
            state.events.trim(&conversation.id);
        }
        merge_latest_turns_page(&mut state.turns_page, SessionTurnPage::from(&latest));
        state.history_base_revision = Some(base_revision);
        if state.turns_page == before
            && previous_history_base_revision == state.history_base_revision
            && !recovered
        {
            return Ok(None);
        }
        state.revision = state.revision.saturating_add(1);
        state.last_sync_ms = Some(now_unix_ms());
        Ok(Some(snapshot(&state)))
    }
}

pub(super) fn active_turn_id(
    thread: &Conversation,
    turns_page: Option<&SessionTurnPage>,
) -> Option<String> {
    if !matches!(thread.status, ThreadStatus::Active { .. }) {
        return None;
    }
    let turns = thread
        .turns
        .iter()
        .map(TurnState::from)
        .chain(
            turns_page
                .into_iter()
                .flat_map(|page| page.turns.iter().cloned()),
        )
        .collect::<Vec<_>>();
    turns
        .iter()
        .find(|turn| {
            turn.status == TurnStatus::InProgress
                && !turns.iter().any(|candidate| {
                    candidate.id == turn.id && candidate.status != TurnStatus::InProgress
                })
        })
        .map(|turn| turn.id.clone())
}

pub(super) fn update_active_turn(
    state: &mut SessionState,
    active_turn_id: Option<String>,
    inferred_cwd: Option<String>,
) {
    let preserve_cwd = state.active_turn_id == active_turn_id;
    let active_turn_cwd = active_turn_id.as_ref().and_then(|_| {
        preserve_cwd
            .then(|| state.active_turn_cwd.clone())
            .flatten()
            .or(inferred_cwd)
    });
    state.active_turn_id = active_turn_id;
    state.active_turn_cwd = active_turn_cwd;
}

pub(super) fn replace_active_turn(
    state: &mut SessionState,
    active_turn_id: Option<String>,
    cwd: String,
) {
    state.active_turn_cwd = active_turn_id.as_ref().map(|_| cwd);
    state.active_turn_id = active_turn_id;
}

pub(super) fn turn_is_in_progress(state: &SessionState, turn_id: &str) -> bool {
    state
        .conversation
        .iter()
        .flat_map(|conversation| conversation.turns.iter())
        .map(TurnState::from)
        .chain(
            state
                .turns_page
                .iter()
                .flat_map(|page| page.turns.iter().cloned()),
        )
        .any(|turn| turn.id == turn_id && turn.status == TurnStatus::InProgress)
}

pub(super) fn turn_is_terminal(state: &SessionState, turn_id: &str) -> bool {
    state
        .conversation
        .iter()
        .flat_map(|conversation| conversation.turns.iter())
        .map(TurnState::from)
        .chain(
            state
                .turns_page
                .iter()
                .flat_map(|page| page.turns.iter().cloned()),
        )
        .any(|turn| turn.id == turn_id && turn.status != TurnStatus::InProgress)
}

pub(super) fn upsert_turn(page: &mut Option<SessionTurnPage>, turn: TurnState) {
    let page = page.get_or_insert_with(|| SessionTurnPage {
        turns: Vec::new(),
        next_cursor: None,
        backwards_cursor: None,
    });
    if let Some(existing) = page.turns.iter_mut().find(|item| item.id == turn.id) {
        if existing.status == TurnStatus::InProgress || turn.status != TurnStatus::InProgress {
            *existing = turn;
        }
    } else {
        page.turns.push(turn);
    }
    bound_latest_turns_page(page);
}

pub(super) fn merge_latest_turns_page(
    target: &mut Option<SessionTurnPage>,
    incoming: SessionTurnPage,
) {
    let next_cursor = incoming.next_cursor.clone();
    let backwards_cursor = incoming.backwards_cursor.clone();
    for turn in incoming.turns {
        upsert_turn(target, turn);
    }
    if let Some(target) = target {
        if target.next_cursor.is_none() {
            target.next_cursor = next_cursor;
        }
        target.backwards_cursor = backwards_cursor.or_else(|| target.backwards_cursor.clone());
        bound_latest_turns_page(target);
    }
}

pub(super) fn merge_stale_turns_page(
    target: &mut Option<SessionTurnPage>,
    incoming: SessionTurnPage,
) {
    let page = target.get_or_insert_with(|| SessionTurnPage {
        turns: Vec::new(),
        next_cursor: None,
        backwards_cursor: None,
    });
    merge_canonical_turns(&mut page.turns, incoming.turns);
    if page.next_cursor.is_none() && incoming.next_cursor.is_some() {
        page.next_cursor = incoming.next_cursor;
    }
    if incoming.backwards_cursor.is_some() {
        page.backwards_cursor = incoming.backwards_cursor;
    }
    bound_latest_turns_page(page);
}

pub(super) fn bound_latest_turns_page(page: &mut SessionTurnPage) {
    sort_turns_desc(&mut page.turns);
    page.turns.truncate(INITIAL_TURNS_PAGE_SIZE);
}

pub(super) fn merge_canonical_turns(
    target: &mut Vec<TurnState>,
    incoming: impl IntoIterator<Item = TurnState>,
) {
    for turn in incoming {
        if let Some(existing) = target.iter_mut().find(|existing| existing.id == turn.id) {
            if existing.status == TurnStatus::InProgress || turn.status != TurnStatus::InProgress {
                *existing = turn;
            }
        } else {
            target.push(turn);
        }
    }
}

pub(super) fn sort_turns_desc(turns: &mut [TurnState]) {
    turns.sort_by(|left, right| {
        right
            .started_at_ms
            .cmp(&left.started_at_ms)
            .then_with(|| right.id.cmp(&left.id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

    #[tokio::test]
    async fn a_report_gap_rejects_a_pending_latest_read_without_starting_another() {
        use crate::app::tasks::test_support::wait_for_mock_method;
        let (pending, release) = MockCodexResponse::gated_ok(
            "thread/turns/list",
            wire_page(
                vec![wire_turn("unobserved", TurnStatus::Completed)],
                None,
                None,
            ),
        );
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Idle,
                    vec![],
                    vec![wire_turn("latest", TurnStatus::Completed)],
                ),
            ),
            pending,
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        let before = sessions.events.for_thread("thread-1");
        let refreshing = {
            let sessions = sessions.clone();
            tokio::spawn(async move { sessions.refresh_latest_turns(1, "thread-1").await })
        };
        wait_for_mock_method(&client, "thread/turns/list").await;
        // The transport can still be subscribed after its report buffer loses
        // events. Only its observation evidence and pending read are withdrawn.
        sessions
            .entry("thread-1")
            .await
            .state
            .lock()
            .await
            .withdraw_history("thread-1");
        release.send(()).unwrap();
        assert!(refreshing.await.unwrap().unwrap().is_none());
        assert_eq!(sessions.events.for_thread("thread-1"), before);
        assert_eq!(
            sessions.snapshot("thread-1").await.unwrap().lifecycle,
            SessionLifecycle::Subscribed
        );
        assert_eq!(client.mock_requests().await.len(), 2);
    }

    #[tokio::test]
    async fn forgetting_a_task_releases_its_cache_and_rejects_pending_history() {
        use crate::app::tasks::test_support::wait_for_mock_method;
        let (pending, release) = MockCodexResponse::gated_ok(
            "thread/turns/list",
            wire_page(
                vec![wire_turn("stale-history", TurnStatus::Completed)],
                None,
                None,
            ),
        );
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Idle,
                    vec![],
                    vec![wire_turn("latest", TurnStatus::Completed)],
                ),
            ),
            pending,
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        let read = {
            let sessions = sessions.clone();
            let driver = client.driver();
            tokio::spawn(async move {
                sessions
                    .load_history_page(
                        &driver,
                        1,
                        "thread-1",
                        &TaskHistoryCursor {
                            turns: Some("older".into()),
                            ..TaskHistoryCursor::default()
                        },
                        8,
                    )
                    .await
            })
        };
        wait_for_mock_method(&client, "thread/turns/list").await;
        sessions.forget_thread("thread-1").await;
        release.send(()).unwrap();
        assert!(read.await.unwrap().is_err());
        assert!(sessions.snapshot("thread-1").await.is_none());
        assert!(sessions.events.for_thread("thread-1").is_empty());
    }

    #[tokio::test]
    async fn history_read_cannot_cross_reattachment_with_the_same_provider_generation() {
        use crate::app::tasks::test_support::wait_for_mock_method;
        let opened = resume_response(ThreadStatus::Idle, vec![], vec![]);
        let (pending, release) = MockCodexResponse::gated_ok(
            "thread/turns/list",
            wire_page(
                vec![wire_turn("stale-history", TurnStatus::Completed)],
                None,
                None,
            ),
        );
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/resume", opened.clone()),
            pending,
            MockCodexResponse::ok("thread/resume", opened),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        let read = {
            let sessions = sessions.clone();
            let driver = client.driver();
            tokio::spawn(async move {
                sessions
                    .load_history_page(
                        &driver,
                        1,
                        "thread-1",
                        &TaskHistoryCursor {
                            turns: Some("older".into()),
                            ..TaskHistoryCursor::default()
                        },
                        8,
                    )
                    .await
            })
        };
        wait_for_mock_method(&client, "thread/turns/list").await;
        sessions.session_needs_opening_again("thread-1").await;
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .unwrap();
        release.send(()).unwrap();
        let error = read.await.unwrap().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("changed connection while reading")
        );
        assert!(sessions.events.for_thread("thread-1").is_empty());
        assert_eq!(
            client
                .mock_requests()
                .await
                .iter()
                .filter(|(method, _)| method == "thread/turns/list")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn terminal_turn_copy_wins_over_stale_running_history_copy() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Idle,
                vec![wire_turn("turn-duplicate", TurnStatus::InProgress)],
                vec![wire_turn("turn-duplicate", TurnStatus::Completed)],
            ),
        )]);
        let sessions = TaskSessions::default();

        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert_eq!(snapshot.active_turn_id, None);
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| thread.status == ThreadStatus::Idle)
        );
    }

    #[tokio::test]
    async fn idle_resume_does_not_revive_stale_in_progress_turn() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Idle,
                Vec::new(),
                vec![wire_turn("turn-stale", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = TaskSessions::default();

        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert_eq!(snapshot.active_turn_id, None);
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
    async fn latest_refresh_updates_anchor_without_losing_older_history() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(decoded(wire_page(
                        vec![
                            wire_turn_at("turn-2", TurnStatus::InProgress, 2.0),
                            wire_turn_at("turn-1", TurnStatus::Completed, 1.0),
                        ],
                        Some("older"),
                        Some("anchor-1"),
                    ))),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(decoded(wire_page(
                        vec![
                            wire_turn_at("turn-3", TurnStatus::Completed, 3.0),
                            wire_turn_at("turn-2", TurnStatus::Completed, 2.0),
                        ],
                        None,
                        Some("anchor-2"),
                    ))),
                    extra: BTreeMap::new(),
                },
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let snapshot = sessions
            .refresh_subscription(&client.driver(), 1, "thread-1")
            .await
            .expect("refresh latest page");
        let page = snapshot.turns_page.expect("merged history");

        assert_eq!(
            page.turns
                .iter()
                .map(|turn| turn.id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn-3", "turn-2", "turn-1"]
        );
        assert_eq!(page.turns[1].status, TurnStatus::Completed);
        assert_eq!(page.next_cursor.as_deref(), Some("older"));
        assert_eq!(page.backwards_cursor.as_deref(), Some("anchor-2"));
    }

    #[tokio::test]
    async fn latest_refresh_keeps_the_canonical_page_bounded() {
        let initial_turns = (1..=INITIAL_TURNS_PAGE_SIZE)
            .rev()
            .map(|index| {
                wire_turn_at(
                    &format!("turn-{index}"),
                    TurnStatus::Completed,
                    index as f64,
                )
            })
            .collect::<Vec<_>>();
        let refreshed_turns = (2..=INITIAL_TURNS_PAGE_SIZE + 1)
            .rev()
            .map(|index| {
                wire_turn_at(
                    &format!("turn-{index}"),
                    TurnStatus::Completed,
                    index as f64,
                )
            })
            .collect::<Vec<_>>();
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(decoded(wire_page(
                        initial_turns,
                        Some("older"),
                        Some("anchor-1"),
                    ))),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(decoded(wire_page(
                        refreshed_turns,
                        None,
                        Some("anchor-2"),
                    ))),
                    extra: BTreeMap::new(),
                },
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let snapshot = sessions
            .refresh_subscription(&client.driver(), 1, "thread-1")
            .await
            .expect("refresh latest page");
        let page = snapshot.turns_page.expect("latest page");

        assert_eq!(page.turns.len(), INITIAL_TURNS_PAGE_SIZE);
        assert_eq!(
            page.turns.first().map(|turn| turn.id.as_str()),
            Some("turn-9")
        );
        assert_eq!(
            page.turns.last().map(|turn| turn.id.as_str()),
            Some("turn-2")
        );
        assert_eq!(page.next_cursor.as_deref(), Some("older"));
        assert_eq!(page.backwards_cursor.as_deref(), Some("anchor-2"));
    }

    #[tokio::test]
    async fn loading_older_history_advances_only_the_older_cursor() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(decoded(wire_page(
                        vec![wire_turn_at("turn-2", TurnStatus::Completed, 2.0)],
                        Some("older-1"),
                        Some("latest-anchor"),
                    ))),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::ok(
                "thread/turns/list",
                wire_page(
                    vec![wire_turn_at("turn-1", TurnStatus::Completed, 1.0)],
                    Some("older-2"),
                    None,
                ),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let (snapshot, older_page) = sessions
            .load_history_page(
                &client.driver(),
                1,
                "thread-1",
                &crate::app::tasks::events::TaskHistoryCursor {
                    turns: Some("older-1".to_string()),
                    ..Default::default()
                },
                8,
            )
            .await
            .expect("load older history");
        let page = snapshot.turns_page.expect("history");

        assert_eq!(
            older_page
                .next
                .as_ref()
                .and_then(|cursor| cursor.turns.as_deref()),
            Some("older-2")
        );
        assert_eq!(page.next_cursor.as_deref(), Some("older-1"));
        assert_eq!(page.backwards_cursor.as_deref(), Some("latest-anchor"));
        assert_eq!(page.turns.len(), 1);
    }

    #[tokio::test]
    async fn loading_older_history_does_not_expand_the_canonical_latest_page() {
        let latest_turns = (3..=10)
            .rev()
            .map(|index| {
                wire_turn_at(
                    &format!("turn-{index}"),
                    TurnStatus::Completed,
                    index as f64,
                )
            })
            .collect::<Vec<_>>();
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(decoded(wire_page(
                        latest_turns.clone(),
                        Some("older-1"),
                        Some("latest-anchor"),
                    ))),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::ok(
                "thread/turns/list",
                wire_page(
                    vec![
                        wire_turn_at("turn-2", TurnStatus::Completed, 2.0),
                        wire_turn_at("turn-1", TurnStatus::Completed, 1.0),
                    ],
                    None,
                    None,
                ),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let (snapshot, older_page) = sessions
            .load_history_page(
                &client.driver(),
                1,
                "thread-1",
                &crate::app::tasks::events::TaskHistoryCursor {
                    turns: Some("older-1".to_string()),
                    ..Default::default()
                },
                8,
            )
            .await
            .expect("load older history");
        let canonical_page = snapshot.turns_page.expect("latest history page");

        assert_eq!(
            older_page
                .events
                .iter()
                .filter_map(crate::app::tasks::events::task_event_turn_id)
                .collect::<std::collections::HashSet<_>>()
                .len(),
            2
        );
        assert_eq!(
            canonical_page.turns,
            latest_turns.iter().map(TurnState::from).collect::<Vec<_>>()
        );
        assert_eq!(canonical_page.next_cursor.as_deref(), Some("older-1"));
        assert_eq!(
            canonical_page.backwards_cursor.as_deref(),
            Some("latest-anchor")
        );
    }

    #[tokio::test]
    async fn older_history_timeout_preserves_the_canonical_session_snapshot() {
        let latest_turn = wire_turn_at("turn-latest", TurnStatus::Completed, 2.0);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(decoded(wire_page(
                        vec![latest_turn.clone()],
                        Some("older-1"),
                        Some("latest-anchor"),
                    ))),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::error(
                "thread/turns/list",
                CodexThreadError::RequestTimeout {
                    method: "thread/turns/list",
                    request_id: 17,
                    timeout_ms: 120_000,
                },
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");
        let before = sessions.snapshot("thread-1").await.expect("snapshot");

        let error = sessions
            .load_history_page(
                &client.driver(),
                1,
                "thread-1",
                &crate::app::tasks::events::TaskHistoryCursor {
                    turns: Some("older-1".to_string()),
                    ..Default::default()
                },
                8,
            )
            .await
            .expect_err("older history request should time out");
        assert!(matches!(
            error,
            AgentError::TimedOut(ref message) if message.contains("thread/turns/list")
        ));

        let after = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(after.lifecycle, SessionLifecycle::Subscribed);
        assert_eq!(after.conversation, before.conversation);
        assert_eq!(after.turns_page, before.turns_page);
        assert_eq!(after.revision, before.revision);
        assert_eq!(
            after
                .turns_page
                .as_ref()
                .and_then(|page| page.next_cursor.as_deref()),
            Some("older-1")
        );
        assert_eq!(
            after
                .turns_page
                .as_ref()
                .and_then(|page| page.turns.first())
                .map(|turn| turn.id.as_str()),
            Some(latest_turn.id.as_str())
        );
    }

    #[tokio::test]
    async fn latest_history_records_the_revision_from_before_its_slow_read() {
        use crate::app::tasks::test_support::wait_for_mock_method;

        let latest = wire_turn_at("turn-latest", TurnStatus::InProgress, 2.0);
        let latest_page = wire_page(vec![latest.clone()], None, None);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(
                        ThreadStatus::Active {
                            active_flags: Vec::new(),
                        },
                        Vec::new(),
                    ),
                    initial_turns_page: Some(decoded(latest_page.clone())),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::delayed_ok(
                "thread/turns/list",
                latest_page,
                Duration::from_millis(250),
            ),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");
        let before_read = sessions.snapshot("thread-1").await.expect("snapshot");
        let refreshing = {
            let sessions = sessions.clone();
            tokio::spawn(async move { sessions.refresh_latest_turns(1, "thread-1").await })
        };
        wait_for_mock_method(&client, "thread/turns/list").await;

        let live = sessions
            .apply_session_event_with_outcome(
                1,
                &session_event("thread-1", item_changed("turn-latest", "item-live", 20)),
            )
            .await;
        let live_revision = live.revision.expect("the live report is accepted");
        let refreshed = refreshing
            .await
            .expect("refresh task")
            .expect("history read")
            .expect("the newer history cutoff changes the snapshot");

        assert_eq!(
            refreshed.history_base_revision,
            Some(before_read.revision),
            "history carries the session revision captured before the read began"
        );
        assert!(live_revision > refreshed.history_base_revision.unwrap());
        assert!(refreshed.revision > live_revision);
    }

    #[tokio::test]
    async fn failed_canonical_history_refresh_is_visible_until_a_read_succeeds() {
        let latest = wire_turn_at("turn-latest", TurnStatus::Completed, 2.0);
        let latest_page = wire_page(vec![latest.clone()], None, None);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(decoded(latest_page.clone())),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::error(
                "thread/turns/list",
                CodexThreadError::Protocol("the canonical history cannot be read".to_string()),
            ),
            MockCodexResponse::ok("thread/turns/list", latest_page),
        ]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");
        let before = sessions.snapshot("thread-1").await.expect("snapshot");

        sessions
            .refresh_latest_turns(1, "thread-1")
            .await
            .expect_err("a failed canonical read remains a failure");

        let failed = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(failed.lifecycle, SessionLifecycle::Subscribed);
        assert_eq!(failed.turns_page, before.turns_page, "known turns remain");
        assert!(
            failed
                .last_error
                .as_deref()
                .is_some_and(|error| error.contains("canonical history cannot be read"))
        );
        assert!(failed.revision > before.revision);

        let recovered = sessions
            .refresh_latest_turns(1, "thread-1")
            .await
            .expect("the next canonical read succeeds")
            .expect("clearing an unavailable state changes the snapshot");

        assert_eq!(recovered.turns_page, before.turns_page);
        assert_eq!(recovered.last_error, None);
        assert!(recovered.revision > failed.revision);
    }
}
