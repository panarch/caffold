use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures_util::{StreamExt, stream};
use serde::Serialize;
use tokio::sync::Mutex as AsyncMutex;

use crate::codex_app_server::{
    CodexNotification, CodexPermissionMode, CodexThread, CodexThreadClient, CodexThreadError,
    CodexTurn, ThreadStatus, TurnStatus, TurnsPage,
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
    pub viewer_leases: usize,
    pub runtime_lease: bool,
    pub generation: u64,
    pub revision: u64,
    pub last_sync_ms: Option<u64>,
    pub last_error: Option<String>,
    pub external_syncing: bool,
    pub external_sync_started_ms: Option<u64>,
    pub external_activity_turn_id: Option<String>,
    pub external_activity_started_ms: Option<u64>,
    pub permission_mode: Option<CodexPermissionMode>,
}

impl ThreadSessionSnapshot {
    pub fn is_running(&self) -> bool {
        self.external_activity_turn_id.is_some()
            || self.active_turn_id.is_some()
            || self
                .thread
                .as_ref()
                .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. }))
            || self.turns_page.as_ref().is_some_and(|page| {
                page.data
                    .iter()
                    .any(|turn| turn.status == TurnStatus::InProgress)
            })
    }
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
    viewer_leases: usize,
    viewer_epoch: u64,
    runtime_lease: bool,
    client: Option<CodexThreadClient>,
    generation: u64,
    revision: u64,
    status_revision: u64,
    last_sync_ms: Option<u64>,
    last_error: Option<String>,
    external_syncing: bool,
    external_sync_started_ms: Option<u64>,
    external_activity_turn_id: Option<String>,
    external_activity_started_ms: Option<u64>,
    permission_mode: Option<CodexPermissionMode>,
}

impl Default for ThreadSessionState {
    fn default() -> Self {
        Self {
            lifecycle: ThreadSessionLifecycle::Unloaded,
            thread: None,
            turns_page: None,
            active_turn_id: None,
            viewer_leases: 0,
            viewer_epoch: 0,
            runtime_lease: false,
            client: None,
            generation: 0,
            revision: 0,
            status_revision: 0,
            last_sync_ms: None,
            last_error: None,
            external_syncing: false,
            external_sync_started_ms: None,
            external_activity_turn_id: None,
            external_activity_started_ms: None,
            permission_mode: None,
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
    pub async fn observe_thread_metadata(&self, mut thread: CodexThread) {
        let entry = self.entry(&thread.id).await;
        let mut state = entry.state.lock().await;
        if let Some(current) = state.thread.as_ref() {
            thread.turns = current.turns.clone();
            if state.active_turn_id.is_some() {
                thread.status = current.status.clone();
            }
        }
        if state.thread.as_ref() == Some(&thread) {
            return;
        }
        state.active_turn_id = active_turn_id(&thread, state.turns_page.as_ref());
        state.thread = Some(thread);
        state.revision = state.revision.saturating_add(1);
        state.status_revision = state.revision;
    }

    pub async fn record_external_activity_started(
        &self,
        thread_id: &str,
        turn_id: &str,
        started_at_ms: u64,
    ) -> ThreadSessionSnapshot {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        state.external_activity_turn_id = Some(turn_id.to_string());
        state.external_activity_started_ms = Some(started_at_ms);
        state.revision = state.revision.saturating_add(1);
        snapshot(&state)
    }

    pub async fn record_external_activity_finished(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> ThreadSessionSnapshot {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.external_activity_turn_id.as_deref() == Some(turn_id) {
            state.external_activity_turn_id = None;
            state.external_activity_started_ms = None;
            state.revision = state.revision.saturating_add(1);
        }
        snapshot(&state)
    }

    pub async fn begin_external_sync(&self, thread_id: &str) -> ThreadSessionSnapshot {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        state.external_syncing = true;
        state
            .external_sync_started_ms
            .get_or_insert_with(now_unix_ms);
        state.revision = state.revision.saturating_add(1);
        snapshot(&state)
    }

    pub async fn apply_external_read_sync(
        &self,
        thread_id: &str,
        base_revision: u64,
        thread: CodexThread,
        latest_turns: TurnsPage,
    ) -> ThreadSessionSnapshot {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        let status_applied =
            merge_external_snapshot(&mut state, thread, Some(latest_turns), base_revision);
        state.external_syncing = false;
        state.external_sync_started_ms = None;
        state.revision = state.revision.saturating_add(1);
        if status_applied {
            state.status_revision = state.revision;
        }
        state.last_sync_ms = Some(now_unix_ms());
        state.last_error = None;
        snapshot(&state)
    }

    pub async fn fail_external_sync(&self, thread_id: &str, error: &CodexThreadError) {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        state.external_syncing = false;
        state.external_sync_started_ms = None;
        state.last_error = Some(error.to_string());
        state.revision = state.revision.saturating_add(1);
    }

    pub async fn acquire_viewer(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<ThreadViewerLease, CodexThreadError> {
        let viewer = self.reserve_viewer(thread_id).await;
        if let Err(error) = self.ensure_subscribed(client, generation, thread_id).await {
            let entry = self.entry(thread_id).await;
            let mut state = entry.state.lock().await;
            state.viewer_leases = state.viewer_leases.saturating_sub(1);
            state.viewer_epoch = state.viewer_epoch.saturating_add(1);
            std::mem::forget(viewer);
            return Err(error);
        }
        Ok(viewer)
    }

    pub async fn reserve_viewer(&self, thread_id: &str) -> ThreadViewerLease {
        let entry = self.entry(thread_id).await;
        {
            let mut state = entry.state.lock().await;
            state.viewer_leases += 1;
            state.viewer_epoch = state.viewer_epoch.saturating_add(1);
        }
        ThreadViewerLease {
            sessions: self.clone(),
            thread_id: thread_id.to_string(),
        }
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

        let base_revision = {
            let mut state = entry.state.lock().await;
            state.lifecycle = ThreadSessionLifecycle::Subscribing;
            state.generation = generation;
            state.last_error = None;
            state.revision
        };
        match client.resume_thread_with_page(thread_id, true).await {
            Ok(response) => {
                let mut state = entry.state.lock().await;
                if state.generation != generation {
                    return Err(CodexThreadError::SubscriptionLost(format!(
                        "Codex thread {thread_id} changed app-server generation while subscribing"
                    )));
                }
                if state.revision == base_revision {
                    apply_resume_response(&mut state, client, generation, response, false);
                } else {
                    apply_stale_refresh_response(&mut state, client, generation, response);
                }
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

    pub async fn load_metadata(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<ThreadSessionSnapshot, CodexThreadError> {
        self.ensure_subscribed(client, generation, thread_id).await
    }

    #[cfg(test)]
    pub async fn refresh_subscription(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<ThreadSessionSnapshot, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        let _operation = entry.operation.lock().await;
        let (preserve_subscription, base_revision) = {
            let state = entry.state.lock().await;
            (
                state.generation == generation
                    && state.lifecycle == ThreadSessionLifecycle::Subscribed,
                state.revision,
            )
        };

        if !preserve_subscription {
            let mut state = entry.state.lock().await;
            state.lifecycle = ThreadSessionLifecycle::Subscribing;
            state.generation = generation;
            state.last_error = None;
        }

        match client.resume_thread_with_page(thread_id, true).await {
            Ok(response) => {
                let mut state = entry.state.lock().await;
                if preserve_subscription && state.generation != generation {
                    return Err(CodexThreadError::SubscriptionLost(format!(
                        "Codex thread {thread_id} changed app-server generation while refreshing its subscription"
                    )));
                }
                if state.revision == base_revision {
                    apply_resume_response(&mut state, client, generation, response, true);
                } else {
                    apply_stale_refresh_response(&mut state, client, generation, response);
                }
                Ok(snapshot(&state))
            }
            Err(error) => {
                let mut state = entry.state.lock().await;
                if !preserve_subscription {
                    state.lifecycle = ThreadSessionLifecycle::Error;
                }
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
        permission_mode: Option<CodexPermissionMode>,
    ) {
        let entry = self.entry(&thread.id).await;
        let mut state = entry.state.lock().await;
        state.lifecycle = ThreadSessionLifecycle::Subscribed;
        state.client = Some(client.clone());
        state.generation = generation;
        state.active_turn_id = active_turn_id(&thread, None);
        state.thread = Some(thread);
        state.permission_mode = permission_mode;
        state.turns_page = None;
        state.runtime_lease = true;
        state.revision = state.revision.saturating_add(1);
        state.status_revision = state.revision;
        state.last_sync_ms = Some(now_unix_ms());
        state.last_error = None;
    }

    pub async fn prepare_prompt(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<PromptTarget, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        let current = {
            let mut state = entry.state.lock().await;
            state.runtime_lease = true;
            if state.generation == generation
                && state.lifecycle == ThreadSessionLifecycle::Subscribed
                && state.thread.is_some()
            {
                Some(snapshot(&state))
            } else {
                None
            }
        };
        let current = match current {
            Some(snapshot) => snapshot,
            None => match self.resume_for_prompt(client, generation, thread_id).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    self.cancel_runtime(thread_id).await;
                    return Err(error);
                }
            },
        };

        if current.generation != generation {
            self.cancel_runtime(thread_id).await;
            return Err(CodexThreadError::SubscriptionLost(format!(
                "Codex thread {thread_id} changed app-server generation before prompt"
            )));
        }

        let thread = current.thread.ok_or_else(|| {
            CodexThreadError::SubscriptionLost(format!(
                "Codex thread {thread_id} did not return canonical metadata while preparing a prompt"
            ))
        })?;

        if matches!(thread.status, ThreadStatus::Active { .. }) {
            let turn_id = if let Some(turn_id) = current.active_turn_id {
                turn_id
            } else {
                let page = match client
                    .list_thread_turns(thread_id, None, INITIAL_TURNS_PAGE_SIZE)
                    .await
                {
                    Ok(page) => page,
                    Err(error) => {
                        entry.state.lock().await.last_error = Some(error.to_string());
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
                merge_latest_turns_page(&mut state.turns_page, page);
                state.revision = state.revision.saturating_add(1);
                state.last_sync_ms = Some(now_unix_ms());
                state.last_error = None;
                turn_id
            };
            Ok(PromptTarget::Steer { turn_id })
        } else if matches!(thread.status, ThreadStatus::Idle) {
            Ok(PromptTarget::Start { cwd: thread.cwd })
        } else {
            self.cancel_runtime(thread_id).await;
            Err(CodexThreadError::SubscriptionLost(format!(
                "Codex thread {thread_id} is unavailable for a prompt"
            )))
        }
    }

    async fn resume_for_prompt(
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
                && state.thread.is_some()
            {
                return Ok(snapshot(&state));
            }
        }
        let base_revision = entry.state.lock().await.revision;
        let response = match client.resume_thread_with_page(thread_id, false).await {
            Ok(response) => response,
            Err(error) => {
                let mut state = entry.state.lock().await;
                state.lifecycle = ThreadSessionLifecycle::Error;
                state.last_error = Some(error.to_string());
                return Err(error);
            }
        };
        let mut state = entry.state.lock().await;
        if state.generation > generation {
            return Err(CodexThreadError::SubscriptionLost(format!(
                "Codex thread {thread_id} changed app-server generation while preparing a prompt"
            )));
        }
        apply_prompt_resume_response(&mut state, client, generation, response, base_revision);
        Ok(snapshot(&state))
    }

    pub async fn record_turn_started(
        &self,
        generation: u64,
        thread_id: &str,
        turn: CodexTurn,
        permission_mode: Option<CodexPermissionMode>,
    ) {
        let entry = self.entry(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.generation != generation {
            return;
        }
        state.active_turn_id = Some(turn.id.clone());
        if permission_mode.is_some() {
            state.permission_mode = permission_mode;
        }
        state.runtime_lease = true;
        upsert_turn(&mut state.turns_page, turn);
        if let Some(thread) = state.thread.as_mut() {
            thread.status = ThreadStatus::Active {
                active_flags: Vec::new(),
            };
        }
        state.revision = state.revision.saturating_add(1);
        state.status_revision = state.revision;
        state.last_sync_ms = Some(now_unix_ms());
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
        merge_latest_turns_page(&mut state.turns_page, page);
        state.revision = state.revision.saturating_add(1);
        Ok(turn_id)
    }

    pub async fn apply_notification(
        &self,
        generation: u64,
        notification: &CodexNotification,
    ) -> Option<u64> {
        let thread_id = notification_thread_id(notification)?;
        let entry = self.existing_entry(thread_id).await?;
        let (changed, should_unsubscribe, revision) = {
            let mut state = entry.state.lock().await;
            if state.generation != generation {
                return None;
            }
            let changed = apply_notification_state(&mut state, notification);
            if changed {
                state.revision = state.revision.saturating_add(1);
                if notification_changes_status(notification) {
                    state.status_revision = state.revision;
                }
            }
            (
                changed,
                state.viewer_leases == 0 && !state.runtime_lease,
                state.revision,
            )
        };
        if changed && should_unsubscribe {
            self.unsubscribe_if_unused(thread_id, &entry).await;
        }
        changed.then_some(revision)
    }

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
        let mut leased_threads = Vec::new();
        for (thread_id, entry) in entries {
            let leased = {
                let state = entry.state.lock().await;
                state.viewer_leases > 0 || state.runtime_lease
            };
            if leased {
                leased_threads.push(thread_id);
            }
        }

        stream::iter(leased_threads)
            .map(|thread_id| {
                let sessions = self.clone();
                let client = client.clone();
                async move {
                    sessions
                        .ensure_subscribed(&client, generation, &thread_id)
                        .await
                        .err()
                        .map(|error| (thread_id, error))
                }
            })
            .buffer_unordered(8)
            .filter_map(async move |failure| failure)
            .collect()
            .await
    }

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

    async fn release_viewer(&self, thread_id: &str) {
        let Some(entry) = self.existing_entry(thread_id).await else {
            return;
        };
        let viewer_epoch = {
            let mut state = entry.state.lock().await;
            state.viewer_leases = state.viewer_leases.saturating_sub(1);
            state.viewer_epoch = state.viewer_epoch.saturating_add(1);
            state.viewer_epoch
        };
        tokio::time::sleep(VIEWER_HANDOFF_GRACE).await;
        self.unsubscribe_if_unused_for_epoch(thread_id, &entry, Some(viewer_epoch))
            .await;
    }

    async fn unsubscribe_if_unused(&self, thread_id: &str, entry: &Arc<ThreadSessionEntry>) {
        self.unsubscribe_if_unused_for_epoch(thread_id, entry, None)
            .await;
    }

    async fn unsubscribe_if_unused_for_epoch(
        &self,
        thread_id: &str,
        entry: &Arc<ThreadSessionEntry>,
        expected_viewer_epoch: Option<u64>,
    ) {
        let (client, generation, unsubscribe_epoch) = {
            let _operation = entry.operation.lock().await;
            let mut state = entry.state.lock().await;
            if expected_viewer_epoch.is_some_and(|epoch| state.viewer_epoch != epoch)
                || state.lifecycle != ThreadSessionLifecycle::Subscribed
                || state.viewer_leases > 0
                || state.runtime_lease
            {
                return;
            }
            let Some(client) = state.client.clone() else {
                return;
            };
            let generation = state.generation;
            let unsubscribe_epoch = state.viewer_epoch;
            state.lifecycle = ThreadSessionLifecycle::Unsubscribing;
            (client, generation, unsubscribe_epoch)
        };

        let result = client.unsubscribe_thread(thread_id).await;
        let mut state = entry.state.lock().await;
        if state.generation != generation
            || state.viewer_epoch != unsubscribe_epoch
            || state.lifecycle != ThreadSessionLifecycle::Unsubscribing
            || state.viewer_leases > 0
            || state.runtime_lease
        {
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
        revision: state.revision,
        last_sync_ms: state.last_sync_ms,
        last_error: state.last_error.clone(),
        external_syncing: state.external_syncing,
        external_sync_started_ms: state.external_sync_started_ms,
        external_activity_turn_id: state.external_activity_turn_id.clone(),
        external_activity_started_ms: state.external_activity_started_ms,
        permission_mode: state.permission_mode,
    }
}

fn merge_external_resume_response(
    state: &mut ThreadSessionState,
    response: crate::codex_app_server::ThreadResumeResponse,
    base_revision: u64,
) -> bool {
    state.permission_mode = Some(CodexPermissionMode::from_settings(&response.extra));
    merge_external_snapshot(
        state,
        response.thread,
        response.initial_turns_page,
        base_revision,
    )
}

fn merge_external_snapshot(
    state: &mut ThreadSessionState,
    mut incoming_thread: CodexThread,
    latest_turns: Option<TurnsPage>,
    base_revision: u64,
) -> bool {
    let preserve_newer_status = state.status_revision > base_revision;
    if let Some(current) = state.thread.take() {
        let mut turns = current.turns;
        merge_external_turns(&mut turns, incoming_thread.turns, preserve_newer_status);
        incoming_thread.turns = turns;
    }
    if let Some(page) = latest_turns {
        merge_external_turns_page(&mut state.turns_page, page, preserve_newer_status);
    }
    state.active_turn_id = active_turn_id(&incoming_thread, state.turns_page.as_ref());
    if state.active_turn_id.is_some() {
        incoming_thread.status = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
    } else {
        if matches!(incoming_thread.status, ThreadStatus::Active { .. }) {
            incoming_thread.status = ThreadStatus::Idle;
        }
        state.runtime_lease = false;
    }
    state.thread = Some(incoming_thread);
    !preserve_newer_status
}

fn merge_external_turns(
    target: &mut Vec<CodexTurn>,
    incoming: impl IntoIterator<Item = CodexTurn>,
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
    target: &mut Option<TurnsPage>,
    incoming: TurnsPage,
    preserve_existing_status: bool,
) {
    let page = target.get_or_insert_with(|| TurnsPage {
        data: Vec::new(),
        next_cursor: None,
        backwards_cursor: None,
    });
    merge_external_turns(&mut page.data, incoming.data, preserve_existing_status);
    if page.next_cursor.is_none() {
        page.next_cursor = incoming.next_cursor;
    }
    if page.backwards_cursor.is_none() {
        page.backwards_cursor = incoming.backwards_cursor;
    }
    bound_latest_turns_page(page);
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn apply_resume_response(
    state: &mut ThreadSessionState,
    client: &CodexThreadClient,
    generation: u64,
    response: crate::codex_app_server::ThreadResumeResponse,
    merge_history: bool,
) {
    state.permission_mode = Some(CodexPermissionMode::from_settings(&response.extra));
    let mut thread = response.thread;
    let active_turn_id = active_turn_id(&thread, response.initial_turns_page.as_ref());
    if active_turn_id.is_some() {
        thread.status = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
    } else if !matches!(thread.status, ThreadStatus::Active { .. }) {
        state.runtime_lease = false;
    }

    state.lifecycle = ThreadSessionLifecycle::Subscribed;
    state.client = Some(client.clone());
    state.generation = generation;
    state.active_turn_id = active_turn_id;
    state.thread = Some(thread);
    if merge_history {
        if let Some(page) = response.initial_turns_page {
            merge_latest_turns_page(&mut state.turns_page, page);
        }
    } else {
        state.turns_page = response.initial_turns_page;
        if let Some(page) = state.turns_page.as_mut() {
            bound_latest_turns_page(page);
        }
    }
    state.revision = state.revision.saturating_add(1);
    state.status_revision = state.revision;
    state.last_sync_ms = Some(now_unix_ms());
    state.last_error = None;
}

fn apply_stale_refresh_response(
    state: &mut ThreadSessionState,
    client: &CodexThreadClient,
    generation: u64,
    response: crate::codex_app_server::ThreadResumeResponse,
) {
    state.permission_mode = Some(CodexPermissionMode::from_settings(&response.extra));
    let previous_status = state.thread.as_ref().map(|thread| thread.status.clone());
    let mut thread = response.thread;
    if let Some(current) = state.thread.take() {
        let mut turns = current.turns;
        merge_canonical_turns(&mut turns, thread.turns);
        thread.turns = turns;
    }
    if let Some(incoming) = response.initial_turns_page {
        merge_stale_turns_page(&mut state.turns_page, incoming);
    }

    state.active_turn_id = active_turn_id(&thread, state.turns_page.as_ref());
    if state.active_turn_id.is_some() {
        thread.status = ThreadStatus::Active {
            active_flags: Vec::new(),
        };
    } else if matches!(thread.status, ThreadStatus::Active { .. }) {
        thread.status = previous_status
            .filter(|status| !matches!(status, ThreadStatus::Active { .. }))
            .unwrap_or(ThreadStatus::Idle);
        state.runtime_lease = false;
    } else {
        state.runtime_lease = false;
    }

    state.lifecycle = ThreadSessionLifecycle::Subscribed;
    state.client = Some(client.clone());
    state.generation = generation;
    state.thread = Some(thread);
    state.revision = state.revision.saturating_add(1);
    state.status_revision = state.revision;
    state.last_sync_ms = Some(now_unix_ms());
    state.last_error = None;
}

fn apply_prompt_resume_response(
    state: &mut ThreadSessionState,
    client: &CodexThreadClient,
    generation: u64,
    response: crate::codex_app_server::ThreadResumeResponse,
    base_revision: u64,
) {
    let status_applied = merge_external_resume_response(state, response, base_revision);
    state.lifecycle = ThreadSessionLifecycle::Subscribed;
    state.client = Some(client.clone());
    state.generation = generation;
    state.runtime_lease = true;
    state.revision = state.revision.saturating_add(1);
    if status_applied {
        state.status_revision = state.revision;
    }
    state.last_sync_ms = Some(now_unix_ms());
    state.last_error = None;
}

fn active_turn_id(thread: &CodexThread, turns_page: Option<&TurnsPage>) -> Option<String> {
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
    bound_latest_turns_page(page);
}

fn merge_latest_turns_page(target: &mut Option<TurnsPage>, incoming: TurnsPage) {
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

fn merge_stale_turns_page(target: &mut Option<TurnsPage>, incoming: TurnsPage) {
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

fn bound_latest_turns_page(page: &mut TurnsPage) {
    sort_turns_desc(&mut page.data);
    page.data.truncate(INITIAL_TURNS_PAGE_SIZE);
}

fn merge_canonical_turns(
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

fn sort_turns_desc(turns: &mut [CodexTurn]) {
    turns.sort_by(|left, right| {
        right
            .started_at
            .partial_cmp(&left.started_at)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| right.id.cmp(&left.id))
    });
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

fn notification_changes_status(notification: &CodexNotification) -> bool {
    matches!(
        notification,
        CodexNotification::ThreadStarted { .. }
            | CodexNotification::ThreadStatusChanged { .. }
            | CodexNotification::TurnStarted { .. }
            | CodexNotification::TurnCompleted { .. }
    )
}

fn apply_notification_state(
    state: &mut ThreadSessionState,
    notification: &CodexNotification,
) -> bool {
    match notification {
        CodexNotification::ThreadStarted { thread } => {
            state.thread = Some(thread.clone());
            state.active_turn_id = active_turn_id(thread, state.turns_page.as_ref());
            true
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
            true
        }
        CodexNotification::TurnStarted { turn, .. } => {
            state.active_turn_id = Some(turn.id.clone());
            state.runtime_lease = true;
            if let Some(thread) = state.thread.as_mut() {
                thread.status = ThreadStatus::Active {
                    active_flags: Vec::new(),
                };
            }
            upsert_turn(&mut state.turns_page, turn.clone());
            true
        }
        CodexNotification::TurnCompleted { turn, .. } => {
            state.active_turn_id = None;
            state.runtime_lease = false;
            if state.external_activity_turn_id.as_deref() == Some(turn.id.as_str()) {
                state.external_activity_turn_id = None;
                state.external_activity_started_ms = None;
            }
            if let Some(thread) = state.thread.as_mut() {
                thread.status = ThreadStatus::Idle;
            }
            upsert_turn(&mut state.turns_page, turn.clone());
            true
        }
        CodexNotification::ItemStarted { .. }
        | CodexNotification::ItemCompleted { .. }
        | CodexNotification::RawResponseItemCompleted { .. }
        | CodexNotification::TurnDiffUpdated { .. } => true,
        CodexNotification::Unknown { .. } => false,
    }
}

#[cfg(test)]
#[path = "codex_thread_sessions/tests.rs"]
mod tests;
