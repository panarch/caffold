use std::{collections::BTreeMap, time::Duration};

use serde_json::json;

use super::*;
use crate::codex_app_server::{MockCodexResponse, ThreadResumeResponse, TurnItemsView};

fn turn(id: &str, status: TurnStatus) -> CodexTurn {
    turn_at(id, status, 1.0)
}

fn turn_at(id: &str, status: TurnStatus, started_at: f64) -> CodexTurn {
    CodexTurn {
        id: id.to_string(),
        items: Vec::new(),
        items_view: TurnItemsView::Full,
        status,
        error: None,
        started_at: Some(started_at),
        completed_at: None,
        duration_ms: None,
        extra: BTreeMap::new(),
    }
}

fn thread(status: ThreadStatus, turns: Vec<CodexTurn>) -> CodexThread {
    CodexThread {
        id: "thread-1".to_string(),
        preview: "Task".to_string(),
        status,
        cwd: "Workspace/rust/codger".to_string(),
        path: None,
        name: None,
        created_at: 1.0,
        updated_at: 1.0,
        recency_at: None,
        turns,
        extra: BTreeMap::new(),
    }
}

fn page(
    turns: Vec<CodexTurn>,
    next_cursor: Option<&str>,
    backwards_cursor: Option<&str>,
) -> TurnsPage {
    TurnsPage {
        data: turns,
        next_cursor: next_cursor.map(str::to_string),
        backwards_cursor: backwards_cursor.map(str::to_string),
    }
}

fn resume_response(
    status: ThreadStatus,
    thread_turns: Vec<CodexTurn>,
    page_turns: Vec<CodexTurn>,
) -> ThreadResumeResponse {
    ThreadResumeResponse {
        thread: thread(status, thread_turns),
        initial_turns_page: Some(page(page_turns, None, Some("latest-anchor"))),
        extra: BTreeMap::new(),
    }
}

async fn apply_external_snapshot(
    sessions: &CodexThreadSessions,
    base_revision: u64,
    response: ThreadResumeResponse,
) -> ThreadSessionSnapshot {
    sessions
        .apply_external_read_sync(
            "thread-1",
            base_revision,
            response.thread,
            response.initial_turns_page.expect("latest turns page"),
        )
        .await
}

async fn methods(client: &CodexThreadClient) -> Vec<String> {
    client
        .mock_requests()
        .await
        .into_iter()
        .map(|(method, _)| method)
        .collect()
}

async fn wait_for_unsubscribe(client: &CodexThreadClient) {
    wait_for_method_count(client, "thread/unsubscribe", 1).await;
}

async fn wait_for_method_count(client: &CodexThreadClient, method: &str, expected: usize) {
    for _ in 0..100 {
        if methods(client)
            .await
            .iter()
            .filter(|candidate| candidate.as_str() == method)
            .count()
            >= expected
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("expected {expected} {method} request(s)");
}

#[tokio::test]
async fn initial_subscription_bootstraps_only_from_resume() {
    let initial_turns = (0..INITIAL_TURNS_PAGE_SIZE)
        .map(|index| {
            turn_at(
                &format!("turn-{index}"),
                TurnStatus::Completed,
                index as f64,
            )
        })
        .collect::<Vec<_>>();
    let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), initial_turns.clone()),
    )]);
    let sessions = CodexThreadSessions::default();

    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("subscribe viewer");
    let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");

    assert_eq!(methods(&client).await, vec!["thread/resume"]);
    assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
    assert_eq!(snapshot.turns_page.expect("initial page").data.len(), 8);
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
    let client = CodexThreadClient::mock(vec![MockCodexResponse::ok("thread/resume", response)]);
    let sessions = CodexThreadSessions::default();

    let snapshot = sessions
        .ensure_subscribed(&client, 1, "thread-1")
        .await
        .expect("subscribe");

    assert_eq!(
        snapshot.permission_mode,
        Some(CodexPermissionMode::ApproveForMe)
    );
    assert_eq!(snapshot.model.as_deref(), Some("gpt-test"));
    assert_eq!(snapshot.reasoning_effort.as_deref(), Some("xhigh"));
}

#[tokio::test]
async fn metadata_load_shares_the_in_flight_subscription_bootstrap() {
    let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        Duration::from_millis(250),
    )]);
    let sessions = CodexThreadSessions::default();
    let subscribing_sessions = sessions.clone();
    let subscribing_client = client.clone();
    let subscription = tokio::spawn(async move {
        subscribing_sessions
            .ensure_subscribed(&subscribing_client, 1, "thread-1")
            .await
    });

    for _ in 0..100 {
        if methods(&client).await == vec!["thread/resume"] {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }

    let snapshot = tokio::time::timeout(
        Duration::from_millis(500),
        sessions.load_metadata(&client, 1, "thread-1"),
    )
    .await
    .expect("metadata request shares the subscription bootstrap")
    .expect("metadata request succeeds");

    assert_eq!(snapshot.thread.expect("thread metadata").id, "thread-1");
    assert_eq!(methods(&client).await, vec!["thread/resume"]);
    subscription
        .await
        .expect("subscription task joins")
        .expect("subscription eventually succeeds");
}

#[tokio::test]
async fn metadata_load_bootstraps_from_resume_without_thread_read() {
    let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(
            ThreadStatus::Idle,
            Vec::new(),
            vec![turn("turn-latest", TurnStatus::Completed)],
        ),
    )]);
    let sessions = CodexThreadSessions::default();

    let snapshot = sessions
        .load_metadata(&client, 1, "thread-1")
        .await
        .expect("metadata bootstrap succeeds");

    assert_eq!(methods(&client).await, vec!["thread/resume"]);
    assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
    assert_eq!(
        snapshot
            .turns_page
            .expect("initial turns page")
            .data
            .first()
            .map(|turn| turn.id.as_str()),
        Some("turn-latest")
    );
}

#[tokio::test]
async fn stale_metadata_load_does_not_overwrite_a_newer_running_notification() {
    let client = CodexThreadClient::mock(vec![MockCodexResponse::delayed_ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        Duration::from_millis(100),
    )]);
    let sessions = CodexThreadSessions::default();
    let loading_sessions = sessions.clone();
    let loading_client = client.clone();
    let metadata = tokio::spawn(async move {
        loading_sessions
            .load_metadata(&loading_client, 1, "thread-1")
            .await
    });

    for _ in 0..100 {
        if methods(&client).await == vec!["thread/resume"] {
            break;
        }
        tokio::time::sleep(Duration::from_millis(2)).await;
    }

    sessions
        .apply_notification(
            1,
            &CodexNotification::TurnStarted {
                thread_id: "thread-1".to_string(),
                turn: turn("turn-live", TurnStatus::InProgress),
            },
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
            .thread
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
    );
}

#[tokio::test]
async fn viewers_share_one_subscription_and_last_viewer_unsubscribes() {
    let client = CodexThreadClient::mock(vec![
        MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        ),
        MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
    ]);
    let sessions = CodexThreadSessions::default();

    let first = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("first viewer");
    let second = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("second viewer");
    assert_eq!(methods(&client).await, vec!["thread/resume"]);

    drop(first);
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert_eq!(methods(&client).await, vec!["thread/resume"]);

    drop(second);
    wait_for_unsubscribe(&client).await;
    assert_eq!(
        methods(&client).await,
        vec!["thread/resume", "thread/unsubscribe"]
    );
}

#[tokio::test]
async fn viewer_handoff_does_not_unsubscribe_between_detail_and_stream() {
    let client = CodexThreadClient::mock(vec![
        MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        ),
        MockCodexResponse::delayed_ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
            Duration::from_millis(250),
        ),
        MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        ),
    ]);
    let sessions = CodexThreadSessions::default();

    let detail_viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("detail viewer");
    std::mem::forget(detail_viewer);

    let releasing_sessions = sessions.clone();
    let release = tokio::spawn(async move {
        releasing_sessions.release_viewer("thread-1").await;
    });
    for _ in 0..20 {
        if sessions
            .snapshot("thread-1")
            .await
            .is_some_and(|snapshot| snapshot.viewer_leases == 0)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }

    let stream_viewer = tokio::time::timeout(
        Duration::from_millis(50),
        sessions.acquire_viewer(&client, 1, "thread-1"),
    )
    .await
    .expect("stream viewer must not wait for an unsubscribe request")
    .expect("stream viewer");

    release.await.expect("release detail viewer");
    assert_eq!(methods(&client).await, vec!["thread/resume"]);

    drop(stream_viewer);
    wait_for_unsubscribe(&client).await;
}

#[tokio::test]
async fn viewer_reacquisition_does_not_wait_for_an_in_flight_unsubscribe() {
    let client = CodexThreadClient::mock(vec![
        MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        ),
        MockCodexResponse::delayed_ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
            Duration::from_millis(250),
        ),
        MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        ),
        MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
    ]);
    let sessions = CodexThreadSessions::default();

    let first_viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("first viewer");
    drop(first_viewer);
    wait_for_unsubscribe(&client).await;

    let second_viewer = tokio::time::timeout(
        Duration::from_millis(50),
        sessions.acquire_viewer(&client, 1, "thread-1"),
    )
    .await
    .expect("a new viewer must not wait for the cleanup RPC")
    .expect("second viewer");

    assert_eq!(
        methods(&client).await,
        vec!["thread/resume", "thread/unsubscribe", "thread/resume"]
    );

    tokio::time::sleep(Duration::from_millis(275)).await;
    let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
    assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
    assert_eq!(snapshot.viewer_leases, 1);

    drop(second_viewer);
    wait_for_method_count(&client, "thread/unsubscribe", 2).await;
}

#[tokio::test]
async fn external_invalidation_rejoins_thread_and_restores_running_state() {
    let external_turn = turn("turn-external", TurnStatus::InProgress);
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
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("viewer");

    let snapshot = sessions
        .refresh_subscription(&client, 1, "thread-1")
        .await
        .expect("refresh external task");

    assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-external"));
    assert!(
        snapshot
            .thread
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
    );
    assert_eq!(
        methods(&client).await,
        vec!["thread/resume", "thread/resume"]
    );
}

#[tokio::test]
async fn rollout_activity_remains_running_when_other_app_server_reports_idle() {
    let sessions = CodexThreadSessions::default();
    let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
    )]);
    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("viewer");

    sessions
        .record_external_activity_started("thread-1", "turn-gui", 1_784_569_546_000)
        .await;
    let syncing = sessions.begin_external_sync("thread-1").await;
    let snapshot = apply_external_snapshot(
        &sessions,
        syncing.revision,
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
    )
    .await;

    assert_eq!(
        snapshot.external_activity_turn_id.as_deref(),
        Some("turn-gui")
    );
    assert_eq!(
        snapshot.external_activity_started_ms,
        Some(1_784_569_546_000)
    );
    assert!(snapshot.is_running());
    assert!(matches!(
        sessions
            .prepare_prompt(&client, 1, "thread-1")
            .await
            .expect("prompt target"),
        PromptTarget::Start { .. }
    ));
}

#[tokio::test]
async fn canonical_completion_clears_matching_rollout_activity() {
    let sessions = CodexThreadSessions::default();
    let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
    )]);
    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("viewer");

    sessions
        .record_external_activity_started("thread-1", "turn-gui", 1_784_569_546_000)
        .await;
    sessions
        .apply_notification(
            1,
            &CodexNotification::TurnCompleted {
                thread_id: "thread-1".to_string(),
                turn: turn("turn-gui", TurnStatus::Completed),
            },
        )
        .await;

    let completed = sessions.snapshot("thread-1").await.expect("snapshot");
    assert_eq!(completed.external_activity_turn_id, None);
    assert!(!completed.is_running());
}

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
    assert!(!snapshot.is_running());
    assert!(
        snapshot
            .thread
            .is_some_and(|thread| thread.status == ThreadStatus::Idle)
    );
}

#[tokio::test]
async fn rollout_completion_clears_external_running_state() {
    let sessions = CodexThreadSessions::default();
    sessions
        .record_external_activity_started("thread-1", "turn-gui", 1_784_569_546_000)
        .await;
    sessions
        .record_external_activity_finished("thread-1", "turn-gui")
        .await;

    let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
    assert_eq!(snapshot.external_activity_turn_id, None);
    assert_eq!(snapshot.external_activity_started_ms, None);
    assert!(!snapshot.is_running());
}

#[tokio::test]
async fn external_invalidation_reopens_the_same_completed_turn() {
    let completed_turn = turn("turn-external", TurnStatus::Completed);
    let running_turn = turn("turn-external", TurnStatus::InProgress);
    let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), vec![completed_turn]),
    )]);
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
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
    let thread = snapshot.thread.as_ref().expect("canonical thread");
    assert!(matches!(thread.status, ThreadStatus::Active { .. }));
    assert_eq!(
        snapshot.turns_page.expect("history").data[0].status,
        TurnStatus::InProgress
    );
}

#[tokio::test]
async fn external_running_refresh_survives_concurrent_item_notification() {
    let external_turn = turn("turn-external", TurnStatus::InProgress);
    let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
    )]);
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("viewer");

    let syncing = sessions.begin_external_sync("thread-1").await;
    sessions
        .apply_notification(
            1,
            &CodexNotification::ItemStarted {
                thread_id: "thread-1".to_string(),
                turn_id: "turn-external".to_string(),
                item: json!({ "id": "item-external", "type": "agentMessage" }),
                started_at_ms: 2,
            },
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
            .thread
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
    );
}

#[tokio::test]
async fn stale_running_refresh_does_not_overwrite_a_concurrent_completion() {
    let external_turn = turn("turn-external", TurnStatus::InProgress);
    let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
    )]);
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("viewer");

    let syncing = sessions.begin_external_sync("thread-1").await;
    sessions
        .apply_notification(
            1,
            &CodexNotification::TurnCompleted {
                thread_id: "thread-1".to_string(),
                turn: turn("turn-external", TurnStatus::Completed),
            },
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
            .thread
            .is_some_and(|thread| thread.status == ThreadStatus::Idle)
    );
    assert_eq!(
        snapshot.turns_page.expect("history").data[0].status,
        TurnStatus::Completed
    );
}

#[tokio::test]
async fn external_completion_clears_running_state_without_losing_history() {
    let active_turn = turn("turn-external", TurnStatus::InProgress);
    let completed_turn = turn("turn-external", TurnStatus::Completed);
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
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("viewer");

    let snapshot = sessions
        .refresh_subscription(&client, 1, "thread-1")
        .await
        .expect("refresh completion");

    assert_eq!(snapshot.active_turn_id, None);
    assert!(!snapshot.runtime_lease);
    assert!(
        snapshot
            .thread
            .is_some_and(|thread| thread.status == ThreadStatus::Idle)
    );
    assert_eq!(
        snapshot.turns_page.expect("history").data[0].status,
        TurnStatus::Completed
    );
}

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
async fn external_sync_preserves_the_interactive_subscription_and_does_not_block_prompt() {
    let primary = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
    )]);
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&primary, 7, "thread-1")
        .await
        .unwrap();

    let syncing = sessions.begin_external_sync("thread-1").await;
    assert!(syncing.external_syncing);
    assert!(syncing.external_sync_started_ms.is_some());

    let target = tokio::time::timeout(
        Duration::from_millis(50),
        sessions.prepare_prompt(&primary, 7, "thread-1"),
    )
    .await
    .expect("prompt must not wait for external sync")
    .expect("prepare prompt");
    assert!(matches!(target, PromptTarget::Start { .. }));

    let snapshot = apply_external_snapshot(
        &sessions,
        syncing.revision,
        resume_response(
            ThreadStatus::Idle,
            Vec::new(),
            vec![turn("external", TurnStatus::Completed)],
        ),
    )
    .await;
    assert_eq!(snapshot.generation, 7);
    assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
    assert!(!snapshot.external_syncing);
    assert_eq!(methods(&primary).await, vec!["thread/resume"]);
}

#[tokio::test]
async fn canonical_completion_wins_for_the_same_turn_started_during_sync() {
    let primary = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
    )]);
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&primary, 7, "thread-1")
        .await
        .unwrap();

    let syncing = sessions.begin_external_sync("thread-1").await;
    sessions
        .apply_notification(
            7,
            &CodexNotification::TurnStarted {
                thread_id: "thread-1".to_string(),
                turn: turn("turn-live", TurnStatus::InProgress),
            },
        )
        .await;

    let snapshot = apply_external_snapshot(
        &sessions,
        syncing.revision,
        resume_response(
            ThreadStatus::Idle,
            Vec::new(),
            vec![
                turn("turn-live", TurnStatus::Completed),
                turn("turn-older", TurnStatus::Completed),
            ],
        ),
    )
    .await;

    assert_eq!(snapshot.active_turn_id, None);
    assert!(
        snapshot
            .thread
            .as_ref()
            .is_some_and(|thread| thread.status == ThreadStatus::Idle)
    );
    assert!(snapshot.turns_page.is_some_and(|page| {
        page.data
            .iter()
            .any(|turn| turn.id == "turn-live" && turn.status == TurnStatus::Completed)
            && page.data.iter().any(|turn| turn.id == "turn-older")
    }));
}

#[tokio::test]
async fn stale_external_sync_does_not_overwrite_a_different_newer_turn() {
    let primary = CodexThreadClient::mock(vec![MockCodexResponse::ok(
        "thread/resume",
        resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
    )]);
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&primary, 7, "thread-1")
        .await
        .unwrap();

    let syncing = sessions.begin_external_sync("thread-1").await;
    sessions
        .apply_notification(
            7,
            &CodexNotification::TurnStarted {
                thread_id: "thread-1".to_string(),
                turn: turn("turn-new", TurnStatus::InProgress),
            },
        )
        .await;

    let snapshot = apply_external_snapshot(
        &sessions,
        syncing.revision,
        resume_response(
            ThreadStatus::Idle,
            Vec::new(),
            vec![turn("turn-old", TurnStatus::Completed)],
        ),
    )
    .await;

    assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-new"));
    assert!(
        snapshot
            .thread
            .as_ref()
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
    );
    assert!(snapshot.turns_page.is_some_and(|page| {
        page.data
            .iter()
            .any(|turn| turn.id == "turn-new" && turn.status == TurnStatus::InProgress)
            && page.data.iter().any(|turn| turn.id == "turn-old")
    }));
}

#[tokio::test]
async fn active_subscribed_prompt_steers_without_another_resume() {
    let canonical = turn("turn-canonical", TurnStatus::InProgress);
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
            turn("turn-new", TurnStatus::InProgress),
            None,
            None,
            None,
        )
        .await;
    viewer
        .await
        .expect("viewer task")
        .expect("viewer subscription");
    assert_eq!(methods(&client).await, vec!["thread/resume"]);
    let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
    assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-new"));
    assert!(snapshot.is_running());
}

#[tokio::test]
async fn stale_background_refresh_does_not_overwrite_a_new_running_turn() {
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
    .expect("prompt preparation must use the subscribed snapshot")
    .expect("prepare completed follow-up");
    assert!(matches!(target, PromptTarget::Start { .. }));

    sessions
        .record_turn_started(
            1,
            "thread-1",
            turn("turn-new", TurnStatus::InProgress),
            None,
            None,
            None,
        )
        .await;
    refresh
        .await
        .expect("refresh task")
        .expect("refresh result");

    let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
    assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-new"));
    assert!(
        snapshot
            .thread
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
    );
}

#[tokio::test]
async fn prompt_uses_an_external_turn_discovered_during_refresh() {
    let external = turn("turn-external", TurnStatus::InProgress);
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
    let active = turn("turn-external", TurnStatus::InProgress);
    let completed = turn("turn-external", TurnStatus::Completed);
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
    let canonical = turn("turn-canonical", TurnStatus::InProgress);
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
            page(vec![canonical], None, Some("active-anchor")),
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
    assert!(snapshot.thread.is_none());
    assert!(snapshot.last_error.is_some());
}

#[tokio::test]
async fn refresh_failure_keeps_canonical_state_and_can_recover() {
    let recovered = turn("turn-recovered", TurnStatus::InProgress);
    let client = CodexThreadClient::mock(vec![
        MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        ),
        MockCodexResponse::error("thread/resume", CodexThreadError::ProcessUnavailable),
        MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
                vec![recovered],
            ),
        ),
    ]);
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("viewer");

    assert!(
        sessions
            .refresh_subscription(&client, 1, "thread-1")
            .await
            .is_err()
    );
    let failed = sessions
        .snapshot("thread-1")
        .await
        .expect("failed snapshot");
    assert!(
        failed
            .thread
            .is_some_and(|thread| thread.status == ThreadStatus::Idle)
    );

    let recovered = sessions
        .refresh_subscription(&client, 1, "thread-1")
        .await
        .expect("recover refresh");
    assert_eq!(recovered.active_turn_id.as_deref(), Some("turn-recovered"));
    assert!(recovered.last_error.is_none());
}

#[tokio::test]
async fn turn_started_notification_marks_the_session_running_immediately() {
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
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
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
async fn latest_refresh_updates_anchor_without_losing_older_history() {
    let client = CodexThreadClient::mock(vec![
        MockCodexResponse::ok(
            "thread/resume",
            ThreadResumeResponse {
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
                thread: thread(ThreadStatus::Idle, Vec::new()),
                initial_turns_page: Some(page(initial_turns, Some("older"), Some("anchor-1"))),
                extra: BTreeMap::new(),
            },
        ),
        MockCodexResponse::ok(
            "thread/resume",
            ThreadResumeResponse {
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
    let sessions = CodexThreadSessions::default();
    let _viewer = sessions
        .acquire_viewer(&first_client, 1, "thread-1")
        .await
        .expect("viewer");

    sessions
        .connection_lost(1, "process exited".to_string())
        .await;
    let failures = sessions.resubscribe_leased(&recovered_client, 2).await;

    assert!(failures.is_empty());
    assert_eq!(methods(&recovered_client).await, vec!["thread/resume"]);
    let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
    assert_eq!(snapshot.generation, 2);
    assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
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
    let sessions = CodexThreadSessions::default();
    let _first_viewer = sessions
        .acquire_viewer(&first_client, 1, "thread-1")
        .await
        .expect("first viewer");
    let _second_viewer = sessions
        .acquire_viewer(&first_client, 1, "thread-2")
        .await
        .expect("second viewer");

    sessions
        .connection_lost(1, "process exited".to_string())
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
    let failures = sessions.resubscribe_leased(&recovered_client, 2).await;

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
async fn registered_started_thread_is_subscribed_and_holds_runtime() {
    let client = CodexThreadClient::mock(Vec::new());
    let sessions = CodexThreadSessions::default();
    sessions
        .register_started_thread(
            &client,
            1,
            thread(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                vec![turn("turn-new", TurnStatus::InProgress)],
            ),
            Some(CodexPermissionMode::AskForApproval),
            Some("gpt-test".to_string()),
            Some("xhigh".to_string()),
        )
        .await;

    let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
    assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
    assert!(snapshot.runtime_lease);
    assert_eq!(snapshot.active_turn_id.as_deref(), Some("turn-new"));
    assert_eq!(snapshot.model.as_deref(), Some("gpt-test"));
    assert_eq!(snapshot.reasoning_effort.as_deref(), Some("xhigh"));
    assert!(methods(&client).await.is_empty());
}

#[tokio::test]
async fn diagnostics_include_only_leased_or_failed_sessions_as_active() {
    let client = CodexThreadClient::mock(vec![
        MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        ),
        MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
    ]);
    let sessions = CodexThreadSessions::default();
    let viewer = sessions
        .acquire_viewer(&client, 1, "thread-1")
        .await
        .expect("viewer");

    let active = sessions.diagnostics().await;
    assert_eq!(active.active_sessions.len(), 1);
    assert_eq!(active.viewer_leases, 1);

    drop(viewer);
    tokio::time::sleep(Duration::from_millis(20)).await;
    let inactive = sessions.diagnostics().await;
    assert!(inactive.active_sessions.is_empty());
}
