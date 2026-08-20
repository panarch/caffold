use std::collections::BTreeMap;

use serde_json::Value;

use crate::agent::codex::{CodexPermissionMode, is_fast_service_tier};
use crate::agent::{
    Conversation, Driver, OpenedConversation, ThreadStatus, Turn, TurnPage, TurnStatus,
};

use super::turns::{
    active_turn_id, bound_latest_turns_page, merge_canonical_turns, merge_latest_turns_page,
    merge_stale_turns_page, replace_active_turn, sort_turns_desc, turn_is_in_progress,
    update_active_turn,
};
use super::{SessionLifecycle, SessionState, now_unix_ms};

/// What the agent says this conversation's settings are.
///
/// Still read in Codex's own keys. A permission mode is the one part of this
/// vocabulary Caffold has not decided across agents, and inventing a shared
/// meaning with one agent in hand would be guessing — so this moves when
/// readiness and settings do.
pub(super) fn apply_thread_settings(state: &mut SessionState, settings: &BTreeMap<String, Value>) {
    state.permission_mode = Some(CodexPermissionMode::from_settings(settings));
    if let Some(model) = settings.get("model").and_then(serde_json::Value::as_str) {
        state.model = Some(model.to_string());
    }
    if let Some(reasoning_effort) = settings.get("reasoningEffort") {
        state.reasoning_effort = reasoning_effort.as_str().map(str::to_string);
    }
    state.fast_mode = is_fast_service_tier(
        settings
            .get("serviceTier")
            .and_then(serde_json::Value::as_str),
    );
}

fn merge_external_resume_response(
    state: &mut SessionState,
    response: OpenedConversation,
    base_revision: u64,
) -> MetadataMergeOutcome {
    apply_thread_settings(state, &response.settings);
    let OpenedConversation {
        conversation,
        turns_page,
        cwd,
        ..
    } = response;
    merge_external_snapshot_with_active_cwd(
        state,
        conversation,
        turns_page,
        base_revision,
        Some(cwd),
    )
}

pub(super) fn merge_external_snapshot(
    state: &mut SessionState,
    incoming_thread: Conversation,
    latest_turns: Option<TurnPage>,
    base_revision: u64,
) -> MetadataMergeOutcome {
    merge_external_snapshot_with_active_cwd(
        state,
        incoming_thread,
        latest_turns,
        base_revision,
        None,
    )
}

fn merge_external_snapshot_with_active_cwd(
    state: &mut SessionState,
    mut incoming_thread: Conversation,
    latest_turns: Option<TurnPage>,
    base_revision: u64,
    resumed_active_turn_cwd: Option<String>,
) -> MetadataMergeOutcome {
    let resumed_active_turn_id = active_turn_id(&incoming_thread, latest_turns.as_ref());
    let active_turn_cwd = incoming_thread.cwd.clone();
    let newer_status = newer_thread_status(state, base_revision);
    let preserve_newer_status = newer_status.is_some();
    let newer_name = newer_thread_name(state, base_revision);
    let preserve_newer_name = newer_name.is_some();
    let preserve_newer_turns = state.revision > base_revision;
    let newer_active_turn_id = preserve_newer_turns
        .then(|| state.active_turn_id.clone())
        .flatten();
    if let Some(current) = state.conversation.take() {
        let mut turns = current.turns;
        merge_external_turns(&mut turns, incoming_thread.turns, preserve_newer_turns);
        incoming_thread.turns = turns;
    }
    if let Some(status) = newer_status {
        incoming_thread.status = status;
    }
    if let Some(name) = newer_name {
        incoming_thread.title = name;
    }
    if let Some(page) = latest_turns {
        merge_external_turns_page(&mut state.turns_page, page, preserve_newer_turns);
    }
    let next_active_turn_id = newer_active_turn_id
        .filter(|turn_id| turn_is_in_progress(state, turn_id))
        .or_else(|| active_turn_id(&incoming_thread, state.turns_page.as_ref()));
    if let Some(active_turn_cwd) =
        resumed_active_turn_cwd.filter(|_| next_active_turn_id == resumed_active_turn_id)
    {
        replace_active_turn(state, next_active_turn_id, active_turn_cwd);
    } else {
        update_active_turn(state, next_active_turn_id, Some(active_turn_cwd));
    }
    if !matches!(incoming_thread.status, ThreadStatus::Active { .. }) {
        state.runtime_lease = false;
    }
    state.conversation = Some(incoming_thread);
    state.pending_thread_status = None;
    MetadataMergeOutcome {
        status: !preserve_newer_status,
        name: !preserve_newer_name,
    }
}

#[derive(Clone, Copy)]
pub(super) struct MetadataMergeOutcome {
    pub(super) status: bool,
    pub(super) name: bool,
}

fn merge_external_turns(
    target: &mut Vec<Turn>,
    incoming: impl IntoIterator<Item = Turn>,
    preserve_existing_status: bool,
) {
    for turn in incoming {
        if let Some(existing) = target.iter_mut().find(|existing| existing.id == turn.id) {
            if !preserve_existing_status
                || existing.status == TurnStatus::InProgress
                || turn.status != TurnStatus::InProgress
            {
                *existing = turn;
            }
        } else {
            target.push(turn);
        }
    }
    sort_turns_desc(target);
}

fn merge_external_turns_page(
    target: &mut Option<TurnPage>,
    incoming: TurnPage,
    preserve_existing_status: bool,
) {
    let page = target.get_or_insert_with(|| TurnPage {
        turns: Vec::new(),
        next_cursor: None,
        backwards_cursor: None,
    });
    merge_external_turns(&mut page.turns, incoming.turns, preserve_existing_status);
    if page.next_cursor.is_none() {
        page.next_cursor = incoming.next_cursor;
    }
    if page.backwards_cursor.is_none() {
        page.backwards_cursor = incoming.backwards_cursor;
    }
    bound_latest_turns_page(page);
}

pub(super) fn apply_opened_conversation(
    state: &mut SessionState,
    driver: &Driver,
    generation: u64,
    opened: OpenedConversation,
    merge_history: bool,
) {
    let preserved_terminal_candidate = merge_history
        .then(|| state.terminal_candidate_turn_id.clone())
        .flatten();
    apply_thread_settings(state, &opened.settings);
    let OpenedConversation {
        conversation: thread,
        turns_page: incoming_page,
        cwd: active_turn_cwd,
        ..
    } = opened;
    let active_turn_id = active_turn_id(&thread, incoming_page.as_ref());
    let thread_is_active = matches!(thread.status, ThreadStatus::Active { .. });

    state.lifecycle = SessionLifecycle::Subscribed;
    state.driver = Some(driver.clone());
    state.generation = generation;
    replace_active_turn(state, active_turn_id.clone(), active_turn_cwd);
    state.conversation = Some(thread);
    state.pending_thread_status = None;
    if merge_history {
        if let Some(page) = incoming_page {
            merge_latest_turns_page(&mut state.turns_page, page);
        }
    } else {
        state.turns_page = incoming_page;
        if let Some(page) = state.turns_page.as_mut() {
            bound_latest_turns_page(page);
        }
    }
    state.terminal_candidate_turn_id = active_turn_id
        .filter(|turn_id| turn_is_in_progress(state, turn_id))
        .or_else(|| {
            preserved_terminal_candidate.filter(|turn_id| turn_is_in_progress(state, turn_id))
        });
    if !thread_is_active && state.terminal_candidate_turn_id.is_none() {
        state.runtime_lease = false;
    }
    state.revision = state.revision.saturating_add(1);
    state.status_revision = state.revision;
    state.name_revision = state.revision;
    state.last_sync_ms = Some(now_unix_ms());
    state.last_error = None;
}

pub(super) fn apply_stale_refresh(
    state: &mut SessionState,
    driver: &Driver,
    generation: u64,
    opened: OpenedConversation,
    base_revision: u64,
) {
    let preserved_terminal_candidate = state.terminal_candidate_turn_id.clone();
    apply_thread_settings(state, &opened.settings);
    let OpenedConversation {
        conversation: incoming_thread,
        turns_page: incoming_page,
        cwd: active_turn_cwd,
        ..
    } = opened;
    let baseline_active_turn_id = active_turn_id(&incoming_thread, incoming_page.as_ref());
    let newer_status = newer_thread_status(state, base_revision);
    let status_applied = newer_status.is_none();
    let newer_name = newer_thread_name(state, base_revision);
    let name_applied = newer_name.is_none();
    let preserve_newer_turns = state.revision > base_revision;
    let newer_active_turn_id = preserve_newer_turns
        .then(|| state.active_turn_id.clone())
        .flatten();
    let mut thread = incoming_thread;
    if let Some(current) = state.conversation.take() {
        let mut turns = current.turns;
        merge_canonical_turns(&mut turns, thread.turns);
        thread.turns = turns;
    }
    if let Some(status) = newer_status {
        thread.status = status;
    }
    if let Some(name) = newer_name {
        thread.title = name;
    }
    if let Some(incoming) = incoming_page {
        merge_stale_turns_page(&mut state.turns_page, incoming);
    }

    let next_active_turn_id = newer_active_turn_id
        .clone()
        .filter(|turn_id| turn_is_in_progress(state, turn_id))
        .or_else(|| active_turn_id(&thread, state.turns_page.as_ref()));
    if next_active_turn_id == baseline_active_turn_id {
        replace_active_turn(state, next_active_turn_id.clone(), active_turn_cwd);
    } else {
        update_active_turn(state, next_active_turn_id.clone(), Some(active_turn_cwd));
    }
    let thread_is_active = matches!(thread.status, ThreadStatus::Active { .. });

    state.lifecycle = SessionLifecycle::Subscribed;
    state.driver = Some(driver.clone());
    state.generation = generation;
    state.conversation = Some(thread);
    state.terminal_candidate_turn_id = newer_active_turn_id
        .filter(|turn_id| turn_is_in_progress(state, turn_id))
        .or_else(|| {
            preserved_terminal_candidate.filter(|turn_id| turn_is_in_progress(state, turn_id))
        })
        .or_else(|| baseline_active_turn_id.filter(|turn_id| turn_is_in_progress(state, turn_id)));
    if !thread_is_active && state.terminal_candidate_turn_id.is_none() {
        state.runtime_lease = false;
    }
    state.pending_thread_status = None;
    state.revision = state.revision.saturating_add(1);
    if status_applied {
        state.status_revision = state.revision;
    }
    if name_applied {
        state.name_revision = state.revision;
    }
    state.last_sync_ms = Some(now_unix_ms());
    state.last_error = None;
}

pub(super) fn apply_prompt_resume(
    state: &mut SessionState,
    driver: &Driver,
    generation: u64,
    opened: OpenedConversation,
    base_revision: u64,
) {
    let applied = merge_external_resume_response(state, opened, base_revision);
    state.lifecycle = SessionLifecycle::Subscribed;
    state.driver = Some(driver.clone());
    state.generation = generation;
    state.runtime_lease = true;
    state.terminal_candidate_turn_id = state.active_turn_id.clone();
    state.revision = state.revision.saturating_add(1);
    if applied.status {
        state.status_revision = state.revision;
    }
    if applied.name {
        state.name_revision = state.revision;
    }
    state.last_sync_ms = Some(now_unix_ms());
    state.last_error = None;
}

fn newer_thread_status(state: &SessionState, base_revision: u64) -> Option<ThreadStatus> {
    (state.status_revision > base_revision)
        .then(|| {
            state
                .conversation
                .as_ref()
                .map(|thread| thread.status.clone())
                .or_else(|| state.pending_thread_status.clone())
        })
        .flatten()
}

fn newer_thread_name(state: &SessionState, base_revision: u64) -> Option<Option<String>> {
    (state.name_revision > base_revision)
        .then(|| {
            state
                .conversation
                .as_ref()
                .map(|conversation| conversation.title.clone())
        })
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::tasks::sessions::test_support::*;

    async fn apply_external_snapshot(
        sessions: &TaskSessions,
        base_revision: u64,
        response: ThreadResumeResponse,
    ) -> SessionSnapshot {
        sessions
            .apply_external_read_sync(
                "thread-1",
                base_revision,
                Conversation::from(&response.thread),
                TurnPage::from(&response.initial_turns_page.expect("latest turns page")),
            )
            .await
    }

    #[tokio::test]
    async fn subscription_recovers_the_active_turn_runtime_cwd() {
        let active = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let current_turn = wire_turn("turn-managed", TurnStatus::InProgress);
        let mut response = resume_response(active, vec![current_turn.clone()], vec![current_turn]);
        response.thread.cwd = "/workspace/source".to_string();
        response.cwd = "/workspace/managed".to_string();
        let listed_thread = response.thread.clone();
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/resume",
            response,
            Duration::from_millis(100),
        )]);
        let sessions = TaskSessions::default();
        sessions
            .observe_thread_metadata(Conversation::from(&listed_thread))
            .await;

        let subscribing_sessions = sessions.clone();
        let subscribing_client = client.clone();
        let subscription = tokio::spawn(async move {
            subscribing_sessions
                .ensure_subscribed(&subscribing_client.driver(), 1, "thread-1")
                .await
        });
        wait_for_method_count(&client, "thread/resume", 1).await;
        sessions
            .apply_session_event(
                1,
                &session_event("thread-1", item_changed("turn-managed", "item-replayed", 2)),
            )
            .await;

        let snapshot = subscription
            .await
            .expect("subscription task joins")
            .expect("resume active managed turn");

        assert_eq!(
            snapshot.conversation.expect("canonical thread").cwd,
            "/workspace/source"
        );
        assert_eq!(
            snapshot.active_turn_cwd.as_deref(),
            Some("/workspace/managed")
        );
    }

    #[tokio::test]
    async fn subscription_baseline_preserves_the_current_turn_over_concurrent_replays() {
        let active = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let old_completed = wire_turn("turn-old", TurnStatus::Completed);
        let current_in_progress = wire_turn_at("turn-current", TurnStatus::InProgress, 2.0);
        let mut response = resume_response(
            active.clone(),
            Vec::new(),
            vec![current_in_progress.clone(), old_completed.clone()],
        );
        response.thread.name = Some("Current task name".to_string());
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/resume",
            response,
            Duration::from_millis(100),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions.reserve_viewer("thread-1").await;
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
        sessions
            .apply_session_event_with_outcome(
                1,
                &session_event("thread-1", conversation_started(&replayed_thread)),
            )
            .await;
        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnStarted {
                        turn: turn("turn-old", TurnStatus::InProgress),
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
        sessions
            .apply_session_event_with_outcome(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnEnded {
                        turn: Turn::from(&old_completed),
                    },
                ),
            )
            .await;

        let snapshot = subscription
            .await
            .expect("subscription task joins")
            .expect("subscription baseline succeeds");
        assert_eq!(
            snapshot
                .conversation
                .as_ref()
                .and_then(|conversation| conversation.title.as_deref()),
            Some("Current task name")
        );
        let entry = sessions
            .existing_entry("thread-1")
            .await
            .expect("session entry");
        assert_eq!(
            entry
                .state
                .lock()
                .await
                .terminal_candidate_turn_id
                .as_deref(),
            Some("turn-current"),
            "the canonical active turn becomes eligible only after the baseline is established"
        );
    }

    #[tokio::test]
    async fn stale_canonical_refresh_does_not_overwrite_a_newer_thread_name() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");
        let syncing = sessions.begin_external_sync("thread-1").await;

        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TitleChanged {
                        title: Some("Newer name".to_string()),
                    },
                ),
            )
            .await;
        let snapshot = sessions
            .apply_external_read_sync(
                "thread-1",
                syncing.revision,
                Conversation::from(&thread(ThreadStatus::Idle, Vec::new())),
                turn_page(Vec::new(), None, None),
            )
            .await;

        assert_eq!(
            snapshot
                .conversation
                .expect("canonical thread")
                .title
                .as_deref(),
            Some("Newer name")
        );
    }

    #[tokio::test]
    async fn subscription_keeps_the_app_server_thread_settings() {
        let mut response = resume_response(ThreadStatus::Idle, Vec::new(), Vec::new());
        response
            .extra
            .insert("approvalPolicy".to_string(), json!("on-request"));
        response
            .extra
            .insert("approvalsReviewer".to_string(), json!("auto_review"));
        response.extra.insert(
            "activePermissionProfile".to_string(),
            json!({ "id": ":workspace", "extends": null }),
        );
        response
            .extra
            .insert("model".to_string(), json!("gpt-test"));
        response
            .extra
            .insert("reasoningEffort".to_string(), json!("xhigh"));
        response
            .extra
            .insert("serviceTier".to_string(), json!("priority"));
        let client =
            CodexThreadClient::mock(vec![MockCodexResponse::ok("thread/resume", response)]);
        let sessions = TaskSessions::default();

        let snapshot = sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");

        assert_eq!(
            snapshot.permission_mode,
            Some(CodexPermissionMode::ApproveForMe)
        );
        assert_eq!(snapshot.model.as_deref(), Some("gpt-test"));
        assert_eq!(snapshot.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(snapshot.fast_mode);
    }

    #[tokio::test]
    async fn subscription_normalizes_default_service_tier_to_normal() {
        let mut response = resume_response(ThreadStatus::Idle, Vec::new(), Vec::new());
        response
            .extra
            .insert("serviceTier".to_string(), json!("default"));
        let client =
            CodexThreadClient::mock(vec![MockCodexResponse::ok("thread/resume", response)]);
        let sessions = TaskSessions::default();

        let snapshot = sessions
            .ensure_subscribed(&client.driver(), 1, "thread-1")
            .await
            .expect("subscribe");

        assert!(!snapshot.fast_mode);
    }

    #[tokio::test]
    async fn stale_metadata_load_does_not_overwrite_a_newer_status_report() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            Duration::from_millis(100),
        )]);
        let sessions = TaskSessions::default();
        let loading_sessions = sessions.clone();
        let loading_client = client.clone();
        let metadata = tokio::spawn(async move {
            loading_sessions
                .load_metadata(&loading_client.driver(), 1, "thread-1")
                .await
        });

        for _ in 0..100 {
            if methods(&client).await == vec!["thread/resume"] {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

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
        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::StatusChanged {
                        status: ThreadStatus::Active {
                            active_flags: Vec::new(),
                        },
                    },
                ),
            )
            .await;

        metadata
            .await
            .expect("metadata task joins")
            .expect("metadata load succeeds");
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-live"));
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
        );
    }

    #[tokio::test]
    async fn external_invalidation_rejoins_thread_and_restores_running_state() {
        let external_turn = wire_turn("turn-external", TurnStatus::InProgress);
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
                    vec![external_turn],
                ),
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
            .expect("refresh external task");

        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-external"));
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
        );
        assert_eq!(
            methods(&client).await,
            vec!["thread/resume", "thread/resume"]
        );
    }

    #[tokio::test]
    async fn external_invalidation_reopens_the_same_completed_turn() {
        let completed_turn = wire_turn("turn-external", TurnStatus::Completed);
        let running_turn = wire_turn("turn-external", TurnStatus::InProgress);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), vec![completed_turn]),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let syncing = sessions.begin_external_sync("thread-1").await;
        let snapshot = apply_external_snapshot(
            &sessions,
            syncing.revision,
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![running_turn],
            ),
        )
        .await;

        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-external"));
        let thread = snapshot.conversation.as_ref().expect("canonical thread");
        assert!(matches!(thread.status, ThreadStatus::Active { .. }));
        assert_eq!(
            snapshot.turns_page.expect("history").turns[0].status,
            TurnStatus::InProgress
        );
    }

    #[tokio::test]
    async fn external_running_refresh_survives_a_concurrent_item_report() {
        let external_turn = wire_turn("turn-external", TurnStatus::InProgress);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let syncing = sessions.begin_external_sync("thread-1").await;
        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    item_changed("turn-external", "item-external", 2),
                ),
            )
            .await;

        let snapshot = apply_external_snapshot(
            &sessions,
            syncing.revision,
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![external_turn],
            ),
        )
        .await;

        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-external"));
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
        );
    }

    #[tokio::test]
    async fn stale_turn_page_does_not_overwrite_a_concurrent_completion() {
        let external_turn = wire_turn("turn-external", TurnStatus::InProgress);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let syncing = sessions.begin_external_sync("thread-1").await;
        sessions
            .apply_session_event(
                1,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnEnded {
                        turn: turn("turn-external", TurnStatus::Completed),
                    },
                ),
            )
            .await;

        let snapshot = apply_external_snapshot(
            &sessions,
            syncing.revision,
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![external_turn],
            ),
        )
        .await;

        assert_eq!(snapshot.active_turn_id, None);
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. })),
            "what the agent last said remains the canonical status"
        );
        assert_eq!(
            snapshot.turns_page.expect("history").turns[0].status,
            TurnStatus::Completed
        );
    }

    #[tokio::test]
    async fn external_completion_clears_running_state_without_losing_history() {
        let active_turn = wire_turn("turn-external", TurnStatus::InProgress);
        let completed_turn = wire_turn("turn-external", TurnStatus::Completed);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    ThreadStatus::Active {
                        active_flags: Vec::new(),
                    },
                    Vec::new(),
                    vec![active_turn],
                ),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), vec![completed_turn]),
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
            .expect("refresh completion");

        assert_eq!(snapshot.active_turn_id, None);
        assert!(!snapshot.runtime_lease);
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| thread.status == ThreadStatus::Idle)
        );
        assert_eq!(
            snapshot.turns_page.expect("history").turns[0].status,
            TurnStatus::Completed
        );
    }

    #[tokio::test]
    async fn idle_external_read_does_not_revive_stale_in_progress_turn() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = TaskSessions::default();
        let _viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
            .await
            .expect("viewer");

        let syncing = sessions.begin_external_sync("thread-1").await;
        let snapshot = apply_external_snapshot(
            &sessions,
            syncing.revision,
            resume_response(
                ThreadStatus::Idle,
                Vec::new(),
                vec![wire_turn("turn-stale", TurnStatus::InProgress)],
            ),
        )
        .await;

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
    async fn canonical_completion_wins_for_the_same_turn_started_during_sync() {
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
        sessions
            .apply_session_event(
                7,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnStarted {
                        turn: turn("turn-live", TurnStatus::InProgress),
                    },
                ),
            )
            .await;

        let snapshot = apply_external_snapshot(
            &sessions,
            syncing.revision,
            resume_response(
                ThreadStatus::Idle,
                Vec::new(),
                vec![
                    wire_turn("turn-live", TurnStatus::Completed),
                    wire_turn("turn-older", TurnStatus::Completed),
                ],
            ),
        )
        .await;

        assert_eq!(snapshot.active_turn_id, None);
        assert!(
            snapshot
                .conversation
                .as_ref()
                .is_some_and(|thread| thread.status == ThreadStatus::Idle)
        );
        assert!(snapshot.turns_page.is_some_and(|page| {
            page.turns
                .iter()
                .any(|turn| turn.id == "turn-live" && turn.status == TurnStatus::Completed)
                && page.turns.iter().any(|turn| turn.id == "turn-older")
        }));
    }

    #[tokio::test]
    async fn stale_external_sync_does_not_overwrite_a_different_newer_turn() {
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
        sessions
            .apply_session_event(
                7,
                &session_event(
                    "thread-1",
                    SessionEventKind::TurnStarted {
                        turn: turn("turn-new", TurnStatus::InProgress),
                    },
                ),
            )
            .await;

        let snapshot = apply_external_snapshot(
            &sessions,
            syncing.revision,
            resume_response(
                ThreadStatus::Idle,
                Vec::new(),
                vec![wire_turn("turn-old", TurnStatus::Completed)],
            ),
        )
        .await;

        assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-new"));
        assert!(
            snapshot
                .conversation
                .as_ref()
                .is_some_and(|thread| thread.status == ThreadStatus::Idle),
            "a newer turn pointer must not synthesize thread status"
        );
        assert!(snapshot.turns_page.is_some_and(|page| {
            page.turns
                .iter()
                .any(|turn| turn.id == "turn-new" && turn.status == TurnStatus::InProgress)
                && page.turns.iter().any(|turn| turn.id == "turn-old")
        }));
    }

    #[tokio::test]
    async fn stale_background_refresh_preserves_a_new_active_turn_and_its_cwd() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
                Duration::from_millis(150),
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
        .expect("prompt preparation must use the subscribed snapshot")
        .expect("prepare completed follow-up");
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
        refresh
            .await
            .expect("refresh task")
            .expect("refresh result");

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
            Some("Workspace/rust/codger"),
            "canonical thread metadata may retain the original checkout cwd"
        );
        assert!(
            snapshot
                .conversation
                .is_some_and(|thread| thread.status == ThreadStatus::Idle),
            "turn state must not be projected onto canonical thread status"
        );
    }

    #[tokio::test]
    async fn stale_background_refresh_does_not_overwrite_a_new_idle_status() {
        let active_status = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(
                    active_status.clone(),
                    Vec::new(),
                    vec![wire_turn("turn-stale", TurnStatus::InProgress)],
                ),
            ),
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resume_response(
                    active_status,
                    Vec::new(),
                    vec![wire_turn("turn-stale", TurnStatus::InProgress)],
                ),
                Duration::from_millis(150),
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
        refresh
            .await
            .expect("refresh task")
            .expect("refresh result");
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
    async fn unsubscribed_active_prompt_establishes_the_terminal_candidate() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![wire_turn("turn-live", TurnStatus::InProgress)],
            ),
        )]);
        let sessions = TaskSessions::default();

        assert!(matches!(
            sessions.prepare_prompt(&client.driver(), 1, "thread-1").await,
            Ok(PromptTarget::Steer { turn_id }) if turn_id == "turn-live"
        ));
        assert_eq!(
            sessions
                .apply_session_event_with_outcome(
                    1,
                    &session_event(
                        "thread-1",
                        SessionEventKind::TurnEnded {
                            turn: turn("turn-live", TurnStatus::Completed)
                        }
                    ),
                )
                .await
                .terminal,
            Some(TerminalTurnApplyOutcome {
                first_current_transition: true,
            })
        );
    }
}
