use std::{collections::HashMap, sync::Arc};

use tokio::sync::Mutex as AsyncMutex;

use crate::codex_app_server::{
    CodexNotification, CodexThread, CodexThreadClient, CodexThreadError, CodexTurn, ThreadStatus,
    TurnStatus, TurnsPage,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    pub viewer_leases: usize,
    pub runtime_lease: bool,
    pub generation: u64,
    pub last_error: Option<String>,
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
    viewer_leases: usize,
    runtime_lease: bool,
    client: Option<CodexThreadClient>,
    generation: u64,
    last_error: Option<String>,
}

impl Default for ThreadSessionState {
    fn default() -> Self {
        Self {
            lifecycle: ThreadSessionLifecycle::Unloaded,
            thread: None,
            turns_page: None,
            active_turn_id: None,
            viewer_leases: 0,
            runtime_lease: false,
            client: None,
            generation: 0,
            last_error: None,
        }
    }
}

pub struct ThreadViewerLease {
    sessions: CodexThreadSessions,
    thread_id: String,
}

impl Drop for ThreadViewerLease {
    fn drop(&mut self) {
        let sessions = self.sessions.clone();
        let thread_id = self.thread_id.clone();
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                sessions.release_viewer(&thread_id).await;
            });
        }
    }
}

impl CodexThreadSessions {
    pub async fn acquire_viewer(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<ThreadViewerLease, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        entry.state.lock().await.viewer_leases += 1;
        if let Err(error) = self.ensure_subscribed(client, generation, thread_id).await {
            let mut state = entry.state.lock().await;
            state.viewer_leases = state.viewer_leases.saturating_sub(1);
            return Err(error);
        }
        Ok(ThreadViewerLease {
            sessions: self.clone(),
            thread_id: thread_id.to_string(),
        })
    }

    pub async fn ensure_subscribed(
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
            {
                return Ok(snapshot(&state));
            }
        }

        {
            let mut state = entry.state.lock().await;
            state.lifecycle = ThreadSessionLifecycle::Subscribing;
            state.generation = generation;
            state.last_error = None;
        }
        match client.resume_thread_with_page(thread_id, true).await {
            Ok(response) => {
                let mut state = entry.state.lock().await;
                state.lifecycle = ThreadSessionLifecycle::Subscribed;
                state.client = Some(client.clone());
                state.active_turn_id =
                    active_turn_id(&response.thread, response.initial_turns_page.as_ref());
                state.thread = Some(response.thread);
                state.turns_page = response.initial_turns_page;
                Ok(snapshot(&state))
            }
            Err(error) => {
                let mut state = entry.state.lock().await;
                state.lifecycle = ThreadSessionLifecycle::Error;
                state.last_error = Some(error.to_string());
                Err(error)
            }
        }
    }

    pub async fn register_started_thread(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread: CodexThread,
    ) {
        let entry = self.entry(&thread.id).await;
        let mut state = entry.state.lock().await;
        state.lifecycle = ThreadSessionLifecycle::Subscribed;
        state.client = Some(client.clone());
        state.generation = generation;
        state.active_turn_id = active_turn_id(&thread, None);
        state.thread = Some(thread);
        state.turns_page = None;
        state.runtime_lease = true;
        state.last_error = None;
    }

    pub async fn prepare_prompt(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<PromptTarget, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        entry.state.lock().await.runtime_lease = true;
        let snapshot = match self.ensure_subscribed(client, generation, thread_id).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                self.cancel_runtime(thread_id).await;
                return Err(error);
            }
        };
        let Some(thread) = snapshot.thread else {
            self.cancel_runtime(thread_id).await;
            return Err(CodexThreadError::Protocol(format!(
                "subscribed thread {thread_id} did not include metadata"
            )));
        };
        if matches!(thread.status, ThreadStatus::Active { .. }) {
            let turn_id = if let Some(turn_id) = snapshot.active_turn_id {
                turn_id
            } else {
                let page = match client.list_thread_turns(thread_id, None, 8).await {
                    Ok(page) => page,
                    Err(error) => {
                        self.cancel_runtime(thread_id).await;
                        return Err(error);
                    }
                };
                let Some(turn_id) = page
                    .data
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
                merge_turns_page(&mut state.turns_page, page);
                turn_id
            };
            Ok(PromptTarget::Steer { turn_id })
        } else {
            Ok(PromptTarget::Start { cwd: thread.cwd })
        }
    }

    pub async fn record_turn_started(&self, generation: u64, thread_id: &str, turn: CodexTurn) {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.generation != generation {
            return;
        }
        state.active_turn_id = Some(turn.id.clone());
        state.runtime_lease = true;
        upsert_turn(&mut state.turns_page, turn);
        if let Some(thread) = state.thread.as_mut() {
            thread.status = ThreadStatus::Active {
                active_flags: Vec::new(),
            };
        }
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
            .thread
            .as_ref()
            .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
        {
            return Ok(None);
        }
        let page = client.list_thread_turns(thread_id, None, 8).await?;
        let turn_id = page
            .data
            .iter()
            .find(|turn| turn.status == TurnStatus::InProgress)
            .map(|turn| turn.id.clone());
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        state.active_turn_id = turn_id.clone();
        merge_turns_page(&mut state.turns_page, page);
        Ok(turn_id)
    }

    pub async fn apply_notification(&self, generation: u64, notification: &CodexNotification) {
        let Some(thread_id) = notification_thread_id(notification) else {
            return;
        };
        let Some(entry) = self.existing_entry(thread_id).await else {
            return;
        };
        let should_unsubscribe = {
            let mut state = entry.state.lock().await;
            if state.generation != generation {
                return;
            }
            apply_notification_state(&mut state, notification)
        };
        if should_unsubscribe {
            self.unsubscribe_if_unused(thread_id, &entry).await;
        }
    }

    pub async fn connection_lost(&self, generation: u64, message: String) {
        let entries = self
            .entries
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for entry in entries {
            let mut state = entry.state.lock().await;
            if state.generation == generation {
                state.lifecycle = ThreadSessionLifecycle::Error;
                state.client = None;
                state.last_error = Some(message.clone());
            }
        }
    }

    pub async fn resubscribe_leased(
        &self,
        client: &CodexThreadClient,
        generation: u64,
    ) -> Vec<(String, CodexThreadError)> {
        let entries = self
            .entries
            .lock()
            .await
            .iter()
            .map(|(thread_id, entry)| (thread_id.clone(), entry.clone()))
            .collect::<Vec<_>>();
        let mut failures = Vec::new();
        for (thread_id, entry) in entries {
            let leased = {
                let state = entry.state.lock().await;
                state.viewer_leases > 0 || state.runtime_lease
            };
            if leased
                && let Err(error) = self.ensure_subscribed(client, generation, &thread_id).await
            {
                failures.push((thread_id, error));
            }
        }
        failures
    }

    #[allow(dead_code)]
    pub async fn snapshot(&self, thread_id: &str) -> Option<ThreadSessionSnapshot> {
        let entry = self.existing_entry(thread_id).await?;
        let state = entry.state.lock().await;
        Some(snapshot(&state))
    }

    async fn release_viewer(&self, thread_id: &str) {
        let Some(entry) = self.existing_entry(thread_id).await else {
            return;
        };
        {
            let mut state = entry.state.lock().await;
            state.viewer_leases = state.viewer_leases.saturating_sub(1);
        }
        self.unsubscribe_if_unused(thread_id, &entry).await;
    }

    async fn unsubscribe_if_unused(&self, thread_id: &str, entry: &Arc<ThreadSessionEntry>) {
        let _operation = entry.operation.lock().await;
        let (client, generation) = {
            let mut state = entry.state.lock().await;
            if state.lifecycle != ThreadSessionLifecycle::Subscribed
                || state.viewer_leases > 0
                || state.runtime_lease
            {
                return;
            }
            let Some(client) = state.client.clone() else {
                return;
            };
            let generation = state.generation;
            state.lifecycle = ThreadSessionLifecycle::Unsubscribing;
            (client, generation)
        };
        let result = client.unsubscribe_thread(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.generation != generation {
            return;
        }
        match result {
            Ok(_) => {
                state.lifecycle = ThreadSessionLifecycle::Unloaded;
                state.client = None;
                state.last_error = None;
            }
            Err(error) => {
                state.lifecycle = ThreadSessionLifecycle::Error;
                state.last_error = Some(error.to_string());
            }
        }
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
        viewer_leases: state.viewer_leases,
        runtime_lease: state.runtime_lease,
        generation: state.generation,
        last_error: state.last_error.clone(),
    }
}

fn active_turn_id(thread: &CodexThread, turns_page: Option<&TurnsPage>) -> Option<String> {
    thread
        .turns
        .iter()
        .chain(turns_page.into_iter().flat_map(|page| page.data.iter()))
        .find(|turn| turn.status == TurnStatus::InProgress)
        .map(|turn| turn.id.clone())
}

fn upsert_turn(page: &mut Option<TurnsPage>, turn: CodexTurn) {
    let page = page.get_or_insert_with(|| TurnsPage {
        data: Vec::new(),
        next_cursor: None,
        backwards_cursor: None,
    });
    if let Some(existing) = page.data.iter_mut().find(|item| item.id == turn.id) {
        *existing = turn;
    } else {
        page.data.push(turn);
    }
}

fn merge_turns_page(target: &mut Option<TurnsPage>, incoming: TurnsPage) {
    let next_cursor = incoming.next_cursor.clone();
    let backwards_cursor = incoming.backwards_cursor.clone();
    for turn in incoming.data {
        upsert_turn(target, turn);
    }
    if let Some(target) = target {
        target.next_cursor = next_cursor;
        target.backwards_cursor = backwards_cursor;
    }
}

fn notification_thread_id(notification: &CodexNotification) -> Option<&str> {
    match notification {
        CodexNotification::ThreadStarted { thread } => Some(&thread.id),
        CodexNotification::ThreadStatusChanged { thread_id, .. }
        | CodexNotification::TurnStarted { thread_id, .. }
        | CodexNotification::TurnCompleted { thread_id, .. }
        | CodexNotification::ItemStarted { thread_id, .. }
        | CodexNotification::ItemCompleted { thread_id, .. }
        | CodexNotification::RawResponseItemCompleted { thread_id, .. }
        | CodexNotification::TurnDiffUpdated { thread_id, .. } => Some(thread_id),
        CodexNotification::Unknown { .. } => None,
    }
}

fn apply_notification_state(
    state: &mut ThreadSessionState,
    notification: &CodexNotification,
) -> bool {
    let terminal_notification = match notification {
        CodexNotification::ThreadStarted { thread } => {
            state.thread = Some(thread.clone());
            state.active_turn_id = active_turn_id(thread, state.turns_page.as_ref());
            false
        }
        CodexNotification::ThreadStatusChanged { status, .. } => {
            if let Some(thread) = state.thread.as_mut() {
                thread.status = status.clone();
            }
            let terminal = !matches!(status, ThreadStatus::Active { .. });
            if terminal {
                state.active_turn_id = None;
                state.runtime_lease = false;
            }
            terminal
        }
        CodexNotification::TurnStarted { turn, .. } => {
            state.active_turn_id = Some(turn.id.clone());
            upsert_turn(&mut state.turns_page, turn.clone());
            false
        }
        CodexNotification::TurnCompleted { turn, .. } => {
            state.active_turn_id = None;
            state.runtime_lease = false;
            upsert_turn(&mut state.turns_page, turn.clone());
            true
        }
        _ => false,
    };
    terminal_notification && state.viewer_leases == 0 && !state.runtime_lease
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    fn turn(id: &str, status: TurnStatus) -> CodexTurn {
        CodexTurn {
            id: id.to_string(),
            items: Vec::new(),
            items_view: crate::codex_app_server::TurnItemsView::Full,
            status,
            error: None,
            started_at: Some(1.0),
            completed_at: None,
            duration_ms: None,
            extra: BTreeMap::new(),
        }
    }

    fn thread(status: ThreadStatus, turns: Vec<CodexTurn>) -> CodexThread {
        CodexThread {
            id: "thread-1".to_string(),
            preview: String::new(),
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

    #[test]
    fn finds_active_turn_in_initial_page() {
        let thread = thread(
            ThreadStatus::Active {
                active_flags: Vec::new(),
            },
            Vec::new(),
        );
        let page = TurnsPage {
            data: vec![turn("turn-1", TurnStatus::InProgress)],
            next_cursor: Some("older".to_string()),
            backwards_cursor: None,
        };

        assert_eq!(
            active_turn_id(&thread, Some(&page)).as_deref(),
            Some("turn-1")
        );
    }

    #[test]
    fn completion_releases_runtime_but_keeps_viewer_subscription() {
        let active_turn = turn("turn-1", TurnStatus::InProgress);
        let mut state = ThreadSessionState {
            lifecycle: ThreadSessionLifecycle::Subscribed,
            thread: Some(thread(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
            )),
            turns_page: None,
            active_turn_id: Some(active_turn.id.clone()),
            viewer_leases: 1,
            runtime_lease: true,
            client: None,
            generation: 1,
            last_error: None,
        };
        let mut completed_turn = active_turn;
        completed_turn.status = TurnStatus::Completed;
        completed_turn.completed_at = Some(2.0);

        let should_unsubscribe = apply_notification_state(
            &mut state,
            &CodexNotification::TurnCompleted {
                thread_id: "thread-1".to_string(),
                turn: completed_turn,
            },
        );

        assert!(!should_unsubscribe);
        assert!(!state.runtime_lease);
        assert_eq!(state.active_turn_id, None);
    }

    #[test]
    fn completion_unsubscribes_when_no_viewer_remains() {
        let mut state = ThreadSessionState {
            lifecycle: ThreadSessionLifecycle::Subscribed,
            thread: Some(thread(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                Vec::new(),
            )),
            turns_page: None,
            active_turn_id: Some("turn-1".to_string()),
            viewer_leases: 0,
            runtime_lease: true,
            client: None,
            generation: 1,
            last_error: None,
        };

        let should_unsubscribe = apply_notification_state(
            &mut state,
            &CodexNotification::ThreadStatusChanged {
                thread_id: "thread-1".to_string(),
                status: ThreadStatus::Idle,
            },
        );

        assert!(should_unsubscribe);
        assert!(!state.runtime_lease);
        assert_eq!(state.active_turn_id, None);
    }
}
