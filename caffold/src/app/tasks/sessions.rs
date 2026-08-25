//! What Caffold knows about a Task while somebody is watching it.
//!
//! The agent owns the conversation. Caffold owns watching it, and watching
//! carries costs and races the agent knows nothing about. They live here.
//!
//! **Who is watching.** A subscription is not free, so it opens when the first
//! viewer arrives and closes when the last one leaves. Following a link drops
//! and retakes a lease within milliseconds, so closing at once would thrash:
//! the departing viewer advances an epoch, waits [`VIEWER_HANDOFF_GRACE`], and
//! gives the subscription up only if nobody arrived in between.
//!
//! **How much a reader has already seen.** Every change advances a revision, so
//! a reader holding an older one can be handed a whole snapshot instead of a
//! stream of changes it cannot place. Status and title carry revisions of their
//! own, because a reader watching only the badge should not redraw for every
//! item the agent writes.
//!
//! **Which connection said it.** A connection is replaced on restart, crash, or
//! upgrade. An answer from the previous one must not overwrite what its
//! replacement established, so a change carries the generation it came from and
//! is dropped once the session has moved past it.
//!
//! **A slow read against a live stream.** Re-reading a conversation takes long
//! enough that the agent reports more work while the read is in flight. The
//! revision at the moment the read began settles which of the two is stale.
//!
//! None of that belongs to one agent. A Claude Task is watched by the same
//! viewers, read by the same browser, and cut off by the same restarts. What
//! does belong to an agent is the three questions this asks one: open a
//! conversation, read an older page of its turns, stop watching.
//!
//! This is not where a Task is kept — that is `task_store` — and not what a
//! Task has said — that is `events`. It lives for as long as the process does.

mod metadata;
mod prompt;
mod reconciliation;
mod recovery;
mod session_events;
mod subscription;
mod turns;

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;

use crate::agent::{Conversation, Driver, ThreadStatus, TurnPage};

const INITIAL_TURNS_PAGE_SIZE: usize = 8;
const VIEWER_HANDOFF_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) enum SessionLifecycle {
    Unloaded,
    Subscribing,
    Subscribed,
    Unsubscribing,
    Error,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub(in crate::app::tasks) struct SessionSnapshot {
    pub(in crate::app::tasks) lifecycle: SessionLifecycle,
    pub(in crate::app::tasks) conversation: Option<Conversation>,
    pub(in crate::app::tasks) turns_page: Option<TurnPage>,
    pub(in crate::app::tasks) active_turn_id: Option<String>,
    pub(in crate::app::tasks) active_turn_cwd: Option<String>,
    pub(in crate::app::tasks) viewer_leases: usize,
    pub(in crate::app::tasks) runtime_lease: bool,
    pub(in crate::app::tasks) generation: u64,
    pub(in crate::app::tasks) revision: u64,
    pub(in crate::app::tasks) last_sync_ms: Option<u64>,
    pub(in crate::app::tasks) last_error: Option<String>,
    pub(in crate::app::tasks) external_syncing: bool,
    pub(in crate::app::tasks) external_sync_started_ms: Option<u64>,
    pub(in crate::app::tasks) permission_mode: Option<String>,
    pub(in crate::app::tasks) model: Option<String>,
    pub(in crate::app::tasks) reasoning_effort: Option<String>,
    pub(in crate::app::tasks) fast_mode: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(in crate::app::tasks) struct SessionEventOutcome {
    pub(in crate::app::tasks) canonical_state_changed: bool,
    pub(in crate::app::tasks) terminal: Option<TerminalTurnApplyOutcome>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::app::tasks) struct TerminalTurnApplyOutcome {
    /// True only when this event first terminates the current in-progress turn.
    pub(in crate::app::tasks) first_current_transition: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(in crate::app::tasks) struct StartedSettings {
    pub(in crate::app::tasks) permission_mode: Option<String>,
    pub(in crate::app::tasks) model: Option<String>,
    pub(in crate::app::tasks) reasoning_effort: Option<String>,
    pub(in crate::app::tasks) fast_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) struct SessionDiagnostics {
    pub(in crate::app::tasks) thread_id: String,
    pub(in crate::app::tasks) lifecycle: SessionLifecycle,
    pub(in crate::app::tasks) viewer_leases: usize,
    pub(in crate::app::tasks) runtime_lease: bool,
    pub(in crate::app::tasks) generation: u64,
    pub(in crate::app::tasks) revision: u64,
    pub(in crate::app::tasks) last_sync_ms: Option<u64>,
    pub(in crate::app::tasks) last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) struct SessionsDiagnostics {
    pub(in crate::app::tasks) tracked_sessions: usize,
    pub(in crate::app::tasks) subscribed_sessions: usize,
    pub(in crate::app::tasks) viewer_leases: usize,
    pub(in crate::app::tasks) runtime_leases: usize,
    pub(in crate::app::tasks) active_sessions: Vec<SessionDiagnostics>,
}

#[derive(Debug, Clone)]
pub(in crate::app::tasks) enum PromptTarget {
    Start { cwd: String },
    Steer { turn_id: String },
}

#[derive(Clone, Default)]
pub(in crate::app::tasks) struct TaskSessions {
    entries: Arc<AsyncMutex<HashMap<String, Arc<SessionEntry>>>>,
}

/// Which agent a session is run by, as against how it is reached.
///
/// Leases and generations say a Task is being watched and how recently; neither
/// says whose it is. Codex serves every thread it has from one connection and
/// counts them, so both are answers about Codex — and a Claude session, which
/// is its own process on its own connection, has to be told apart from them
/// rather than swept along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionAgent {
    Codex,
    Claude,
}

impl From<&Driver> for SessionAgent {
    fn from(driver: &Driver) -> Self {
        match driver {
            Driver::Codex(_) => Self::Codex,
            Driver::Claude(_) => Self::Claude,
        }
    }
}

impl SessionState {
    /// Record the connection this session is now being watched on.
    fn on_connection(&mut self, driver: &Driver, generation: u64) {
        self.generation = generation;
        self.agent = Some(SessionAgent::from(driver));
    }

    /// Whether a Codex connection speaks for this session.
    fn is_codex(&self) -> bool {
        self.agent == Some(SessionAgent::Codex)
    }
}

struct SessionEntry {
    state: AsyncMutex<SessionState>,
    operation: AsyncMutex<()>,
}

struct SessionState {
    lifecycle: SessionLifecycle,
    /// What the agent last said this conversation is, in Caffold's shape.
    ///
    /// Its turns are not the history: the agent reports the conversation and a
    /// page of its turns as two answers, and `turns_page` is the second.
    conversation: Option<Conversation>,
    turns_page: Option<TurnPage>,
    active_turn_id: Option<String>,
    active_turn_cwd: Option<String>,
    terminal_candidate_turn_id: Option<String>,
    viewer_leases: usize,
    viewer_epoch: u64,
    runtime_lease: bool,
    /// The agent this session is being watched through, kept so the last
    /// viewer to leave can say so without being handed one.
    driver: Option<Driver>,
    /// Which agent runs this session.
    ///
    /// Kept apart from `driver` because a driver is dropped the moment a
    /// connection goes away, and this outlives that. What may sweep a session —
    /// a Codex connection lost, a Codex connection coming back — turns on the
    /// answer, and asking it of a driver that has just been dropped would
    /// answer nothing about every session that most needs it.
    agent: Option<SessionAgent>,
    generation: u64,
    revision: u64,
    status_revision: u64,
    name_revision: u64,
    pending_thread_status: Option<ThreadStatus>,
    last_sync_ms: Option<u64>,
    last_error: Option<String>,
    external_syncing: bool,
    external_sync_started_ms: Option<u64>,
    permission_mode: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: bool,
}

impl Default for SessionState {
    fn default() -> Self {
        Self {
            lifecycle: SessionLifecycle::Unloaded,
            agent: None,
            conversation: None,
            turns_page: None,
            active_turn_id: None,
            active_turn_cwd: None,
            terminal_candidate_turn_id: None,
            viewer_leases: 0,
            viewer_epoch: 0,
            runtime_lease: false,
            driver: None,
            generation: 0,
            revision: 0,
            status_revision: 0,
            name_revision: 0,
            pending_thread_status: None,
            last_sync_ms: None,
            last_error: None,
            external_syncing: false,
            external_sync_started_ms: None,
            permission_mode: None,
            model: None,
            reasoning_effort: None,
            fast_mode: false,
        }
    }
}

pub(in crate::app::tasks) struct ViewerLease {
    sessions: TaskSessions,
    thread_id: String,
}

impl TaskSessions {
    pub(in crate::app::tasks) async fn diagnostics(&self) -> SessionsDiagnostics {
        let entries = self
            .entries
            .lock()
            .await
            .iter()
            .map(|(thread_id, entry)| (thread_id.clone(), entry.clone()))
            .collect::<Vec<_>>();
        let mut subscribed_sessions = 0;
        let mut viewer_leases = 0;
        let mut runtime_leases = 0;
        let mut active_sessions = Vec::new();

        for (thread_id, entry) in &entries {
            let state = entry.state.lock().await;
            if state.lifecycle == SessionLifecycle::Subscribed {
                subscribed_sessions += 1;
            }
            viewer_leases += state.viewer_leases;
            runtime_leases += usize::from(state.runtime_lease);
            if state.viewer_leases > 0
                || state.runtime_lease
                || matches!(
                    state.lifecycle,
                    SessionLifecycle::Subscribing | SessionLifecycle::Error
                )
            {
                active_sessions.push(SessionDiagnostics {
                    thread_id: thread_id.clone(),
                    lifecycle: state.lifecycle,
                    viewer_leases: state.viewer_leases,
                    runtime_lease: state.runtime_lease,
                    generation: state.generation,
                    revision: state.revision,
                    last_sync_ms: state.last_sync_ms,
                    last_error: state.last_error.clone(),
                });
            }
        }
        active_sessions.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

        SessionsDiagnostics {
            tracked_sessions: entries.len(),
            subscribed_sessions,
            viewer_leases,
            runtime_leases,
            active_sessions,
        }
    }

    #[allow(dead_code)]
    pub(in crate::app::tasks) async fn snapshot(&self, thread_id: &str) -> Option<SessionSnapshot> {
        let entry = self.existing_entry(thread_id).await?;
        let state = entry.state.lock().await;
        Some(snapshot(&state))
    }

    pub(in crate::app::tasks) async fn forget_thread(&self, thread_id: &str) {
        self.entries.lock().await.remove(thread_id);
    }

    async fn entry(&self, thread_id: &str) -> Arc<SessionEntry> {
        let mut entries = self.entries.lock().await;
        entries
            .entry(thread_id.to_string())
            .or_insert_with(|| {
                Arc::new(SessionEntry {
                    state: AsyncMutex::new(SessionState::default()),
                    operation: AsyncMutex::new(()),
                })
            })
            .clone()
    }

    async fn existing_entry(&self, thread_id: &str) -> Option<Arc<SessionEntry>> {
        self.entries.lock().await.get(thread_id).cloned()
    }
}

fn snapshot(state: &SessionState) -> SessionSnapshot {
    SessionSnapshot {
        lifecycle: state.lifecycle,
        conversation: state.conversation.clone(),
        turns_page: state.turns_page.clone(),
        active_turn_id: state.active_turn_id.clone(),
        active_turn_cwd: state.active_turn_cwd.clone(),
        viewer_leases: state.viewer_leases,
        runtime_lease: state.runtime_lease,
        generation: state.generation,
        revision: state.revision,
        last_sync_ms: state.last_sync_ms,
        last_error: state.last_error.clone(),
        external_syncing: state.external_syncing,
        external_sync_started_ms: state.external_sync_started_ms,
        permission_mode: state.permission_mode.clone(),
        model: state.model.clone(),
        reasoning_effort: state.reasoning_effort.clone(),
        fast_mode: state.fast_mode,
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

#[cfg(test)]
pub(super) mod test_support {
    pub(super) use std::{collections::BTreeMap, time::Duration};

    pub(super) use serde_json::json;

    pub(super) use super::{
        INITIAL_TURNS_PAGE_SIZE, PromptTarget, SessionSnapshot, TaskSessions,
        TerminalTurnApplyOutcome,
    };
    pub(super) use crate::agent::codex::{
        CodexThread, CodexThreadClient, CodexThreadError, CodexTurn, MockCodexResponse,
        ThreadResumeResponse,
    };
    pub(super) use crate::agent::{
        ActivityStatus, Conversation, ConversationItem, ItemKind, SessionEvent, SessionEventKind,
        ThreadStatus, Turn, TurnOptions, TurnPage, TurnStatus,
    };

    /// A fixture written in Caffold's vocabulary and read back as Codex's.
    ///
    /// The two serialize identically today, which the driver's contract test
    /// asserts directly. Going through the wire form is what keeps these tests
    /// exercising the adapter rather than asserting against a shape it would
    /// have rejected.
    pub(super) fn decoded<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> T {
        serde_json::from_value(value).expect("the fixture decodes the way the agent sends it")
    }

    /// One report from the live stream, the way every reader of it sees it.
    pub(super) fn session_event(thread_id: &str, kind: SessionEventKind) -> SessionEvent {
        SessionEvent {
            thread_id: thread_id.to_string(),
            kind,
        }
    }

    /// The bootstrap snapshot a subscription replays, as the session reads it.
    pub(super) fn conversation_started(thread: &CodexThread) -> SessionEventKind {
        SessionEventKind::ConversationStarted {
            conversation: Conversation::from(thread),
        }
    }

    /// An item arriving mid-turn. The session does not read what is in one, so
    /// these say only which turn it belongs to and when it arrived.
    pub(super) fn item_changed(turn_id: &str, item_id: &str, at_ms: u64) -> SessionEventKind {
        SessionEventKind::ItemChanged {
            turn_id: turn_id.to_string(),
            item: ConversationItem {
                id: item_id.to_string(),
                observed_at_ms: None,
                status: ActivityStatus::Completed,
                kind: ItemKind::Reasoning {
                    summary: vec!["Read the current behavior.".to_string()],
                    content: Vec::new(),
                },
            },
            at_ms,
        }
    }

    /// A turn the way the session keeps it, for what the live stream reports.
    pub(super) fn turn(id: &str, status: TurnStatus) -> Turn {
        Turn::from(&wire_turn(id, status))
    }

    /// A turn the way Codex sends it, for what a mocked call returns.
    pub(super) fn wire_turn(id: &str, status: TurnStatus) -> CodexTurn {
        wire_turn_at(id, status, 1.0)
    }

    pub(super) fn wire_turn_at(id: &str, status: TurnStatus, started_at: f64) -> CodexTurn {
        decoded(json!({
            "id": id,
            "items": [],
            "itemsView": "full",
            "status": status,
            "startedAt": started_at,
        }))
    }

    pub(super) fn thread(status: ThreadStatus, turns: Vec<CodexTurn>) -> CodexThread {
        decoded(json!({
            "id": "thread-1",
            "preview": "Task",
            "status": status,
            "cwd": "Workspace/rust/codger",
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "turns": turns,
        }))
    }

    /// A page the way the session keeps it, for what the app hands over.
    pub(super) fn turn_page(
        turns: Vec<CodexTurn>,
        next_cursor: Option<&str>,
        backwards_cursor: Option<&str>,
    ) -> TurnPage {
        TurnPage {
            turns: turns.iter().map(Turn::from).collect(),
            next_cursor: next_cursor.map(str::to_string),
            backwards_cursor: backwards_cursor.map(str::to_string),
        }
    }

    /// A page the way Codex answers with it, for what a mocked call returns.
    pub(super) fn wire_page(
        turns: Vec<CodexTurn>,
        next_cursor: Option<&str>,
        backwards_cursor: Option<&str>,
    ) -> serde_json::Value {
        json!({
            "data": turns,
            "nextCursor": next_cursor,
            "backwardsCursor": backwards_cursor,
        })
    }

    pub(super) fn resume_response(
        status: ThreadStatus,
        thread_turns: Vec<CodexTurn>,
        page_turns: Vec<CodexTurn>,
    ) -> ThreadResumeResponse {
        let thread = thread(status, thread_turns);
        ThreadResumeResponse {
            cwd: thread.cwd.clone(),
            thread,
            initial_turns_page: Some(decoded(wire_page(page_turns, None, Some("latest-anchor")))),
            extra: BTreeMap::new(),
        }
    }

    pub(super) async fn methods(client: &CodexThreadClient) -> Vec<String> {
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect()
    }

    pub(super) async fn wait_for_unsubscribe(client: &CodexThreadClient) {
        wait_for_method_count(client, "thread/unsubscribe", 1).await;
    }

    pub(super) async fn wait_for_method_count(
        client: &CodexThreadClient,
        method: &str,
        expected: usize,
    ) {
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
}

#[cfg(test)]
mod tests {
    use super::test_support::*;

    #[tokio::test]
    async fn diagnostics_include_only_leased_or_failed_sessions_as_active() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let sessions = TaskSessions::default();
        let viewer = sessions
            .acquire_viewer(&client.driver(), 1, "thread-1")
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

    #[tokio::test]
    async fn forgotten_thread_releases_its_ephemeral_session_entry() {
        let sessions = TaskSessions::default();
        sessions
            .observe_thread_metadata(Conversation::from(&thread(ThreadStatus::Idle, Vec::new())))
            .await;
        assert!(sessions.snapshot("thread-1").await.is_some());

        sessions.forget_thread("thread-1").await;

        assert!(sessions.snapshot("thread-1").await.is_none());
        assert_eq!(sessions.diagnostics().await.tracked_sessions, 0);
    }
}
