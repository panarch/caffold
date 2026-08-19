use crate::codex_app_server::{
    CodexThread, CodexThreadClient, CodexThreadError, CodexTurn, ThreadStatus, TurnStatus,
    TurnsPage,
};

use super::{
    CodexThreadSessions, INITIAL_TURNS_PAGE_SIZE, ThreadSessionSnapshot, ThreadSessionState,
    snapshot,
};

impl CodexThreadSessions {
    pub async fn load_older_turns(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
        cursor: &str,
        limit: usize,
    ) -> Result<(ThreadSessionSnapshot, TurnsPage), CodexThreadError> {
        self.ensure_subscribed(client, generation, thread_id)
            .await?;
        let page = client
            .list_thread_turns(thread_id, Some(cursor), limit)
            .await?;
        let entry = self.entry(thread_id).await;
        let state = entry.state.lock().await;
        if state.generation != generation {
            return Err(CodexThreadError::SubscriptionLost(format!(
                "Codex thread {thread_id} changed app-server generation while loading history"
            )));
        }
        Ok((snapshot(&state), page))
    }
}

pub(super) fn active_turn_id(
    thread: &CodexThread,
    turns_page: Option<&TurnsPage>,
) -> Option<String> {
    if !matches!(thread.status, ThreadStatus::Active { .. }) {
        return None;
    }
    let turns = thread
        .turns
        .iter()
        .chain(turns_page.into_iter().flat_map(|page| page.data.iter()))
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
    state: &mut ThreadSessionState,
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
    state: &mut ThreadSessionState,
    active_turn_id: Option<String>,
    cwd: String,
) {
    state.active_turn_cwd = active_turn_id.as_ref().map(|_| cwd);
    state.active_turn_id = active_turn_id;
}

pub(super) fn turn_is_in_progress(state: &ThreadSessionState, turn_id: &str) -> bool {
    state
        .thread
        .iter()
        .flat_map(|thread| thread.turns.iter())
        .chain(state.turns_page.iter().flat_map(|page| page.data.iter()))
        .any(|turn| turn.id == turn_id && turn.status == TurnStatus::InProgress)
}

pub(super) fn turn_is_terminal(state: &ThreadSessionState, turn_id: &str) -> bool {
    state
        .thread
        .iter()
        .flat_map(|thread| thread.turns.iter())
        .chain(state.turns_page.iter().flat_map(|page| page.data.iter()))
        .any(|turn| turn.id == turn_id && turn.status != TurnStatus::InProgress)
}

pub(super) fn upsert_turn(page: &mut Option<TurnsPage>, turn: CodexTurn) {
    let page = page.get_or_insert_with(|| TurnsPage {
        data: Vec::new(),
        next_cursor: None,
        backwards_cursor: None,
    });
    if let Some(existing) = page.data.iter_mut().find(|item| item.id == turn.id) {
        if existing.status == TurnStatus::InProgress || turn.status != TurnStatus::InProgress {
            *existing = turn;
        }
    } else {
        page.data.push(turn);
    }
    bound_latest_turns_page(page);
}

pub(super) fn merge_latest_turns_page(target: &mut Option<TurnsPage>, incoming: TurnsPage) {
    let next_cursor = incoming.next_cursor.clone();
    let backwards_cursor = incoming.backwards_cursor.clone();
    for turn in incoming.data {
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

pub(super) fn merge_stale_turns_page(target: &mut Option<TurnsPage>, incoming: TurnsPage) {
    let page = target.get_or_insert_with(|| TurnsPage {
        data: Vec::new(),
        next_cursor: None,
        backwards_cursor: None,
    });
    merge_canonical_turns(&mut page.data, incoming.data);
    if page.next_cursor.is_none() && incoming.next_cursor.is_some() {
        page.next_cursor = incoming.next_cursor;
    }
    if incoming.backwards_cursor.is_some() {
        page.backwards_cursor = incoming.backwards_cursor;
    }
    bound_latest_turns_page(page);
}

pub(super) fn bound_latest_turns_page(page: &mut TurnsPage) {
    sort_turns_desc(&mut page.data);
    page.data.truncate(INITIAL_TURNS_PAGE_SIZE);
}

pub(super) fn merge_canonical_turns(
    target: &mut Vec<CodexTurn>,
    incoming: impl IntoIterator<Item = CodexTurn>,
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

pub(super) fn sort_turns_desc(turns: &mut [CodexTurn]) {
    turns.sort_by(|left, right| {
        right
            .started_at
            .partial_cmp(&left.started_at)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.id.cmp(&left.id))
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_thread_sessions::test_support::*;

    #[tokio::test]
    async fn terminal_turn_copy_wins_over_stale_running_history_copy() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Idle,
                vec![turn("turn-duplicate", TurnStatus::InProgress)],
                vec![turn("turn-duplicate", TurnStatus::Completed)],
            ),
        )]);
        let sessions = CodexThreadSessions::default();

        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert_eq!(snapshot.active_turn_id, None);
        assert!(
            snapshot
                .thread
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
                vec![turn("turn-stale", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = CodexThreadSessions::default();

        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert_eq!(snapshot.active_turn_id, None);
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
    async fn latest_refresh_updates_anchor_without_losing_older_history() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(page(
                        vec![
                            turn_at("turn-2", TurnStatus::InProgress, 2.0),
                            turn_at("turn-1", TurnStatus::Completed, 1.0),
                        ],
                        Some("older"),
                        Some("anchor-1"),
                    )),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(page(
                        vec![
                            turn_at("turn-3", TurnStatus::Completed, 3.0),
                            turn_at("turn-2", TurnStatus::Completed, 2.0),
                        ],
                        None,
                        Some("anchor-2"),
                    )),
                    extra: BTreeMap::new(),
                },
            ),
        ]);
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let snapshot = sessions
            .refresh_subscription(&client, 1, "thread-1")
            .await
            .expect("refresh latest page");
        let page = snapshot.turns_page.expect("merged history");

        assert_eq!(
            page.data
                .iter()
                .map(|turn| turn.id.as_str())
                .collect::<Vec<_>>(),
            vec!["turn-3", "turn-2", "turn-1"]
        );
        assert_eq!(page.data[1].status, TurnStatus::Completed);
        assert_eq!(page.next_cursor.as_deref(), Some("older"));
        assert_eq!(page.backwards_cursor.as_deref(), Some("anchor-2"));
    }

    #[tokio::test]
    async fn latest_refresh_keeps_the_canonical_page_bounded() {
        let initial_turns = (1..=INITIAL_TURNS_PAGE_SIZE)
            .rev()
            .map(|index| {
                turn_at(
                    &format!("turn-{index}"),
                    TurnStatus::Completed,
                    index as f64,
                )
            })
            .collect::<Vec<_>>();
        let refreshed_turns = (2..=INITIAL_TURNS_PAGE_SIZE + 1)
            .rev()
            .map(|index| {
                turn_at(
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
                    initial_turns_page: Some(page(initial_turns, Some("older"), Some("anchor-1"))),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(page(refreshed_turns, None, Some("anchor-2"))),
                    extra: BTreeMap::new(),
                },
            ),
        ]);
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let snapshot = sessions
            .refresh_subscription(&client, 1, "thread-1")
            .await
            .expect("refresh latest page");
        let page = snapshot.turns_page.expect("latest page");

        assert_eq!(page.data.len(), INITIAL_TURNS_PAGE_SIZE);
        assert_eq!(
            page.data.first().map(|turn| turn.id.as_str()),
            Some("turn-9")
        );
        assert_eq!(
            page.data.last().map(|turn| turn.id.as_str()),
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
                    initial_turns_page: Some(page(
                        vec![turn_at("turn-2", TurnStatus::Completed, 2.0)],
                        Some("older-1"),
                        Some("latest-anchor"),
                    )),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::ok(
                "thread/turns/list",
                page(
                    vec![turn_at("turn-1", TurnStatus::Completed, 1.0)],
                    Some("older-2"),
                    None,
                ),
            ),
        ]);
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let (snapshot, older_page) = sessions
            .load_older_turns(&client, 1, "thread-1", "older-1", 8)
            .await
            .expect("load older history");
        let page = snapshot.turns_page.expect("history");

        assert_eq!(older_page.next_cursor.as_deref(), Some("older-2"));
        assert_eq!(page.next_cursor.as_deref(), Some("older-1"));
        assert_eq!(page.backwards_cursor.as_deref(), Some("latest-anchor"));
        assert_eq!(page.data.len(), 1);
    }

    #[tokio::test]
    async fn loading_older_history_does_not_expand_the_canonical_latest_page() {
        let latest_turns = (3..=10)
            .rev()
            .map(|index| {
                turn_at(
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
                    initial_turns_page: Some(page(
                        latest_turns.clone(),
                        Some("older-1"),
                        Some("latest-anchor"),
                    )),
                    extra: BTreeMap::new(),
                },
            ),
            MockCodexResponse::ok(
                "thread/turns/list",
                page(
                    vec![
                        turn_at("turn-2", TurnStatus::Completed, 2.0),
                        turn_at("turn-1", TurnStatus::Completed, 1.0),
                    ],
                    None,
                    None,
                ),
            ),
        ]);
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");

        let (snapshot, older_page) = sessions
            .load_older_turns(&client, 1, "thread-1", "older-1", 8)
            .await
            .expect("load older history");
        let canonical_page = snapshot.turns_page.expect("latest history page");

        assert_eq!(older_page.data.len(), 2);
        assert_eq!(canonical_page.data, latest_turns);
        assert_eq!(canonical_page.next_cursor.as_deref(), Some("older-1"));
        assert_eq!(
            canonical_page.backwards_cursor.as_deref(),
            Some("latest-anchor")
        );
    }

    #[tokio::test]
    async fn older_history_timeout_preserves_the_canonical_session_snapshot() {
        let latest_turn = turn_at("turn-latest", TurnStatus::Completed, 2.0);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                ThreadResumeResponse {
                    cwd: "/tmp".to_string(),
                    thread: thread(ThreadStatus::Idle, Vec::new()),
                    initial_turns_page: Some(page(
                        vec![latest_turn.clone()],
                        Some("older-1"),
                        Some("latest-anchor"),
                    )),
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
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client, 1, "thread-1")
            .await
            .expect("viewer");
        let before = sessions.snapshot("thread-1").await.expect("snapshot");

        let error = sessions
            .load_older_turns(&client, 1, "thread-1", "older-1", 8)
            .await
            .expect_err("older history request should time out");
        assert!(matches!(
            error,
            CodexThreadError::RequestTimeout {
                method: "thread/turns/list",
                ..
            }
        ));

        let after = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(after.lifecycle, ThreadSessionLifecycle::Subscribed);
        assert_eq!(after.thread, before.thread);
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
                .and_then(|page| page.data.first())
                .map(|turn| turn.id.as_str()),
            Some(latest_turn.id.as_str())
        );
    }
}
