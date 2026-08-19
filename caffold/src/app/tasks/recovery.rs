use std::{collections::HashSet, ops::Deref};

use serde::Serialize;

use crate::{
    codex_app_server::{CodexThread, CodexThreadClient, CodexThreadError},
    task_store::ManagedThread,
};

use super::{TaskRecord, active_list::unavailable_active_task};

const CODEX_THREAD_PAGE_SIZE: usize = 100;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) enum ActiveTaskRecoveryReason {
    SectionPlacementPending,
    CodexArchived,
    ThreadMissing,
    TemporarilyUnavailable,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) enum ActiveTaskRecoveryAction {
    Recheck,
    RestoreToActive,
    MoveToArchived,
    RemoveFromCaffold,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskRecoveryContext {
    pub(in crate::app) reason: ActiveTaskRecoveryReason,
    pub(in crate::app) actions: Vec<ActiveTaskRecoveryAction>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskRecovery {
    #[serde(flatten)]
    pub(in crate::app) task: TaskRecord,
    pub(in crate::app) recovery: ActiveTaskRecoveryContext,
}

impl ActiveTaskRecovery {
    pub(in crate::app) fn new(task: TaskRecord, reason: ActiveTaskRecoveryReason) -> Self {
        let actions = match reason {
            ActiveTaskRecoveryReason::SectionPlacementPending => vec![
                ActiveTaskRecoveryAction::RestoreToActive,
                ActiveTaskRecoveryAction::Recheck,
            ],
            ActiveTaskRecoveryReason::TemporarilyUnavailable => {
                vec![ActiveTaskRecoveryAction::Recheck]
            }
            ActiveTaskRecoveryReason::CodexArchived => vec![
                ActiveTaskRecoveryAction::RestoreToActive,
                ActiveTaskRecoveryAction::MoveToArchived,
                ActiveTaskRecoveryAction::Recheck,
            ],
            ActiveTaskRecoveryReason::ThreadMissing => vec![
                ActiveTaskRecoveryAction::Recheck,
                ActiveTaskRecoveryAction::RemoveFromCaffold,
            ],
        };
        Self {
            task,
            recovery: ActiveTaskRecoveryContext { reason, actions },
        }
    }
}

impl Deref for ActiveTaskRecovery {
    type Target = TaskRecord;

    fn deref(&self) -> &Self::Target {
        &self.task
    }
}

pub(in crate::app) enum ManagedCodexThreadLocation {
    Active(CodexThread),
    Archived(CodexThread),
    Missing,
}

pub(in crate::app) fn cached_recovery(
    managed: &ManagedThread,
    reason: ActiveTaskRecoveryReason,
) -> ActiveTaskRecovery {
    ActiveTaskRecovery::new(unavailable_active_task(managed), reason)
}

pub(in crate::app) async fn locate_thread(
    client: &CodexThreadClient,
    thread_id: &str,
) -> Result<ManagedCodexThreadLocation, CodexThreadError> {
    match list_all_global_threads(client).await {
        Ok(threads) => {
            if let Some(thread) = threads.into_iter().find(|thread| thread.id == thread_id) {
                return Ok(ManagedCodexThreadLocation::Active(thread));
            }
        }
        Err(active_error) => {
            let archived = list_all_archived_threads(client).await?;
            if let Some(thread) = archived.into_iter().find(|thread| thread.id == thread_id) {
                return Ok(ManagedCodexThreadLocation::Archived(thread));
            }
            return Err(active_error);
        }
    }

    let archived = list_all_archived_threads(client).await?;
    Ok(archived
        .into_iter()
        .find(|thread| thread.id == thread_id)
        .map(ManagedCodexThreadLocation::Archived)
        .unwrap_or(ManagedCodexThreadLocation::Missing))
}

pub(in crate::app) async fn list_all_global_threads(
    client: &CodexThreadClient,
) -> Result<Vec<CodexThread>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_threads = HashSet::new();
    let mut threads = Vec::new();
    loop {
        let page = client
            .list_threads(cursor.as_deref(), CODEX_THREAD_PAGE_SIZE)
            .await?;
        for thread in page.data {
            if seen_threads.insert(thread.id.clone()) {
                threads.push(thread);
            }
        }
        let Some(next_cursor) = page.next_cursor.filter(|cursor| !cursor.is_empty()) else {
            return Ok(threads);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(CodexThreadError::Protocol(
                "Codex app-server repeated a fallback thread/list cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
}

async fn list_all_archived_threads(
    client: &CodexThreadClient,
) -> Result<Vec<CodexThread>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_threads = HashSet::new();
    let mut threads = Vec::new();
    loop {
        let page = client
            .list_archived_threads(cursor.as_deref(), CODEX_THREAD_PAGE_SIZE)
            .await?;
        for thread in page.data {
            if seen_threads.insert(thread.id.clone()) {
                threads.push(thread);
            }
        }
        let Some(next_cursor) = page.next_cursor.filter(|cursor| !cursor.is_empty()) else {
            return Ok(threads);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(CodexThreadError::Protocol(
                "Codex app-server repeated an archived recovery thread/list cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
}
