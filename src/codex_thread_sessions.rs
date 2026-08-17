mod metadata;
mod notifications;
mod prompt;
mod reconciliation;
mod recovery;
mod subscription;
mod turns;

use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;

use crate::codex_app_server::{
    CodexPermissionMode, CodexThread, CodexThreadClient, ThreadStatus, TurnsPage,
};

const INITIAL_TURNS_PAGE_SIZE: usize = 8;
const VIEWER_HANDOFF_GRACE: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadSessionLifecycle {
    Unloaded,
    Subscribing,
    Subscribed,
    Unsubscribing,
    Error,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct ThreadSessionSnapshot {
    pub lifecycle: ThreadSessionLifecycle,
    pub thread: Option<CodexThread>,
    pub turns_page: Option<TurnsPage>,
    pub active_turn_id: Option<String>,
    pub active_turn_cwd: Option<String>,
    pub viewer_leases: usize,
    pub runtime_lease: bool,
    pub generation: u64,
    pub revision: u64,
    pub last_sync_ms: Option<u64>,
    pub last_error: Option<String>,
    pub external_syncing: bool,
    pub external_sync_started_ms: Option<u64>,
    pub permission_mode: Option<CodexPermissionMode>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct NotificationApplyOutcome {
    pub(crate) canonical_state_changed: bool,
    pub(crate) terminal: Option<TerminalTurnApplyOutcome>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TerminalTurnApplyOutcome {
    /// True only when this notification first terminates the current in-progress turn.
    pub(crate) first_current_transition: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct StartedThreadSettings {
    pub(crate) permission_mode: Option<CodexPermissionMode>,
    pub(crate) model: Option<String>,
    pub(crate) reasoning_effort: Option<String>,
    pub(crate) fast_mode: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSessionDiagnostics {
    pub thread_id: String,
    pub lifecycle: ThreadSessionLifecycle,
    pub viewer_leases: usize,
    pub runtime_lease: bool,
    pub generation: u64,
    pub revision: u64,
    pub last_sync_ms: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSessionsDiagnostics {
    pub tracked_sessions: usize,
    pub subscribed_sessions: usize,
    pub viewer_leases: usize,
    pub runtime_leases: usize,
    pub active_sessions: Vec<ThreadSessionDiagnostics>,
}

#[derive(Debug, Clone)]
pub enum PromptTarget {
    Start { cwd: String },
    Steer { turn_id: String },
}

#[derive(Clone, Default)]
pub struct CodexThreadSessions {
    entries: Arc<AsyncMutex<HashMap<String, Arc<ThreadSessionEntry>>>>,
}

struct ThreadSessionEntry {
    state: AsyncMutex<ThreadSessionState>,
    operation: AsyncMutex<()>,
}

struct ThreadSessionState {
    lifecycle: ThreadSessionLifecycle,
    thread: Option<CodexThread>,
    turns_page: Option<TurnsPage>,
    active_turn_id: Option<String>,
    active_turn_cwd: Option<String>,
    terminal_candidate_turn_id: Option<String>,
    viewer_leases: usize,
    viewer_epoch: u64,
    runtime_lease: bool,
    client: Option<CodexThreadClient>,
    generation: u64,
    revision: u64,
    status_revision: u64,
    name_revision: u64,
    pending_thread_status: Option<ThreadStatus>,
    last_sync_ms: Option<u64>,
    last_error: Option<String>,
    external_syncing: bool,
    external_sync_started_ms: Option<u64>,
    permission_mode: Option<CodexPermissionMode>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: bool,
}

impl Default for ThreadSessionState {
    fn default() -> Self {
        Self {
            lifecycle: ThreadSessionLifecycle::Unloaded,
            thread: None,
            turns_page: None,
            active_turn_id: None,
            active_turn_cwd: None,
            terminal_candidate_turn_id: None,
            viewer_leases: 0,
            viewer_epoch: 0,
            runtime_lease: false,
            client: None,
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

pub struct ThreadViewerLease {
    sessions: CodexThreadSessions,
    thread_id: String,
}

impl CodexThreadSessions {
    pub async fn diagnostics(&self) -> ThreadSessionsDiagnostics {
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
            if state.lifecycle == ThreadSessionLifecycle::Subscribed {
                subscribed_sessions += 1;
            }
            viewer_leases += state.viewer_leases;
            runtime_leases += usize::from(state.runtime_lease);
            if state.viewer_leases > 0
                || state.runtime_lease
                || matches!(
                    state.lifecycle,
                    ThreadSessionLifecycle::Subscribing | ThreadSessionLifecycle::Error
                )
            {
                active_sessions.push(ThreadSessionDiagnostics {
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

        ThreadSessionsDiagnostics {
            tracked_sessions: entries.len(),
            subscribed_sessions,
            viewer_leases,
            runtime_leases,
            active_sessions,
        }
    }

    #[allow(dead_code)]
    pub async fn snapshot(&self, thread_id: &str) -> Option<ThreadSessionSnapshot> {
        let entry = self.existing_entry(thread_id).await?;
        let state = entry.state.lock().await;
        Some(snapshot(&state))
    }

    pub async fn forget_thread(&self, thread_id: &str) {
        self.entries.lock().await.remove(thread_id);
    }

    async fn entry(&self, thread_id: &str) -> Arc<ThreadSessionEntry> {
        let mut entries = self.entries.lock().await;
        entries
            .entry(thread_id.to_string())
            .or_insert_with(|| {
                Arc::new(ThreadSessionEntry {
                    state: AsyncMutex::new(ThreadSessionState::default()),
                    operation: AsyncMutex::new(()),
                })
            })
            .clone()
    }

    async fn existing_entry(&self, thread_id: &str) -> Option<Arc<ThreadSessionEntry>> {
        self.entries.lock().await.get(thread_id).cloned()
    }
}

fn snapshot(state: &ThreadSessionState) -> ThreadSessionSnapshot {
    ThreadSessionSnapshot {
        lifecycle: state.lifecycle,
        thread: state.thread.clone(),
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
        permission_mode: state.permission_mode,
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
        CodexThreadSessions, INITIAL_TURNS_PAGE_SIZE, PromptTarget, TerminalTurnApplyOutcome,
        ThreadSessionLifecycle, ThreadSessionSnapshot,
    };
    pub(super) use crate::codex_app_server::{
        CodexNotification, CodexPermissionMode, CodexThread, CodexThreadClient, CodexTurn,
        CodexTurnOptions, MockCodexResponse, ThreadResumeResponse, ThreadStatus, TurnItemsView,
        TurnStatus, TurnsPage,
    };

    pub(super) fn turn(id: &str, status: TurnStatus) -> CodexTurn {
        turn_at(id, status, 1.0)
    }

    pub(super) fn turn_at(id: &str, status: TurnStatus, started_at: f64) -> CodexTurn {
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

    pub(super) fn thread(status: ThreadStatus, turns: Vec<CodexTurn>) -> CodexThread {
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

    pub(super) fn page(
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

    pub(super) fn resume_response(
        status: ThreadStatus,
        thread_turns: Vec<CodexTurn>,
        page_turns: Vec<CodexTurn>,
    ) -> ThreadResumeResponse {
        let thread = thread(status, thread_turns);
        ThreadResumeResponse {
            cwd: thread.cwd.clone(),
            thread,
            initial_turns_page: Some(page(page_turns, None, Some("latest-anchor"))),
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

    #[tokio::test]
    async fn forgotten_thread_releases_its_ephemeral_session_entry() {
        let sessions = CodexThreadSessions::default();
        sessions
            .observe_thread_metadata(thread(ThreadStatus::Idle, Vec::new()))
            .await;
        assert!(sessions.snapshot("thread-1").await.is_some());

        sessions.forget_thread("thread-1").await;

        assert!(sessions.snapshot("thread-1").await.is_none());
        assert_eq!(sessions.diagnostics().await.tracked_sessions, 0);
    }
}
