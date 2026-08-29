use super::*;
use crate::app::tasks::composer_settings;
use crate::task_store;

pub(super) async fn task_store_list_archived(
    state: &TaskState,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(Vec<ManagedThread>, Option<String>), ApiError> {
    let store = state.task_store.clone();
    let cursor = cursor.map(ToOwned::to_owned);
    tokio::task::spawn_blocking(move || store.list_archived(cursor.as_deref(), limit))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

pub(super) async fn task_store_get(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.get(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

pub(super) async fn task_store_get_archived(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.get_archived(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

pub(super) async fn task_store_worktree_for_thread(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedWorktree>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.worktree_for_thread(&thread_id))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

#[cfg(test)]
pub(super) async fn task_store_claim(
    state: &TaskState,
    thread: ManagedThread,
) -> Result<ManagedThread, ApiError> {
    let store = state.task_store.clone();
    tokio::task::spawn_blocking(move || store.claim(thread, now_ms()))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

pub(super) async fn task_store_mark_seen(
    state: &TaskState,
    thread_id: &str,
    canonical_activity_ms: u64,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || {
        store.mark_seen(&thread_id, canonical_activity_ms, now_ms())
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)
}

pub(super) async fn task_store_update_composer_settings(
    state: &TaskState,
    thread_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    fast_mode: bool,
) -> Result<Option<ManagedThread>, ApiError> {
    let persisted = composer_settings::persist_started_turn_composer_settings(
        state.task_store.clone(),
        thread_id,
        task_store::ComposerSettings {
            model: model.map(str::to_string),
            reasoning_effort: reasoning_effort.map(str::to_string),
            fast_mode,
        },
    )
    .await?;
    if let Some(section) = persisted
        .as_ref()
        .and_then(|persisted| persisted.section.as_ref())
    {
        state.task_list_events.section_composer_settings(section);
    }
    Ok(persisted.map(|persisted| persisted.thread))
}

pub(super) async fn task_store_archive(
    state: &TaskState,
    thread_id: &str,
) -> Result<Option<ManagedThread>, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.archive(&thread_id, now_ms()))
        .await
        .map_err(task_store_join_error)?
        .map_err(task_store_api_error)
}

#[derive(Clone, Copy)]
pub(super) enum ManagedTaskMembership {
    Active,
    Archived,
}

pub(super) async fn task_store_delete_task_rows(
    state: &TaskState,
    thread_id: &str,
    membership: ManagedTaskMembership,
    worktree_id: Option<&str>,
) -> Result<bool, ApiError> {
    let store = state.task_store.clone();
    let thread_id = thread_id.to_string();
    let worktree_id = worktree_id.map(str::to_string);
    tokio::task::spawn_blocking(move || {
        store.transaction(|tables| {
            let deleted = match membership {
                ManagedTaskMembership::Active => tables.delete_active_managed_thread(&thread_id)?,
                ManagedTaskMembership::Archived => {
                    tables.delete_archived_managed_thread(&thread_id)?
                }
            };
            if !deleted {
                return Ok(false);
            }
            if let Some(worktree_id) = worktree_id.as_deref()
                && !tables.delete_managed_worktree(worktree_id)?
            {
                return Err(TaskStoreError::UnexpectedPayload);
            }
            Ok(true)
        })
    })
    .await
    .map_err(task_store_join_error)?
    .map_err(task_store_api_error)
}

pub(super) fn task_store_api_error(error: TaskStoreError) -> ApiError {
    match error {
        TaskStoreError::InvalidCursor => ApiError::BadRequest {
            code: "task_cursor_invalid",
            message: error.to_string(),
        },
        error @ TaskStoreError::TaskReorderUnavailable(_) => ApiError::Conflict {
            code: "task_reorder_unavailable",
            message: error.to_string(),
        },
        error @ TaskStoreError::TaskReorderConflict(_) => ApiError::Conflict {
            code: "task_reorder_conflict",
            message: error.to_string(),
        },
        error @ TaskStoreError::SectionReorderUnavailable(_) => ApiError::Conflict {
            code: "section_reorder_unavailable",
            message: error.to_string(),
        },
        error @ TaskStoreError::SectionReorderConflict(_) => ApiError::Conflict {
            code: "section_reorder_conflict",
            message: error.to_string(),
        },
        error => ApiError::Internal(error.to_string()),
    }
}
