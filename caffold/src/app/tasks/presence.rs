//! Where a Task's record is, for requests that need it on one list.
//!
//! Every request about one Task refuses the same way when the Task is not where
//! the request needs it: the Task is archived, it is still active, or Caffold
//! has no record of it. A deleted Task leaves no record, so it reads as one
//! that was never there.

use crate::{
    app::error::ApiError,
    task_store::{ManagedThread, TaskStore},
};

/// The record of an active Task, or the refusal saying where it is instead.
pub(in crate::app::tasks) async fn active_record(
    store: &TaskStore,
    thread_id: &str,
) -> Result<ManagedThread, ApiError> {
    match find(store, thread_id).await? {
        Some(managed) if managed.archived_at_ms.is_none() => Ok(managed),
        found => Err(refusal(found.as_ref())),
    }
}

/// The record of an archived Task, or the refusal saying where it is instead.
pub(in crate::app::tasks) async fn archived_record(
    store: &TaskStore,
    thread_id: &str,
) -> Result<ManagedThread, ApiError> {
    match find(store, thread_id).await? {
        Some(managed) if managed.archived_at_ms.is_some() => Ok(managed),
        found => Err(refusal(found.as_ref())),
    }
}

/// The refusal for a request whose Task left the list it needed while the
/// request ran, saying where the Task is now.
pub(in crate::app::tasks) async fn moved_refusal(store: &TaskStore, thread_id: &str) -> ApiError {
    match find(store, thread_id).await {
        Ok(found) => refusal(found.as_ref()),
        Err(error) => error,
    }
}

/// The refusal for a request about a Task, from the record found for it on
/// either list.
pub(in crate::app::tasks) fn refusal(found: Option<&ManagedThread>) -> ApiError {
    match found {
        None => ApiError::NotFound {
            code: "task_not_found",
            message: "Caffold has no record of this task".to_string(),
        },
        Some(managed) if managed.archived_at_ms.is_some() => ApiError::Conflict {
            code: "task_archived",
            message: "task is archived".to_string(),
        },
        Some(_) => ApiError::BadRequest {
            code: "task_not_archived",
            message: "thread is not archived in Caffold".to_string(),
        },
    }
}

async fn find(store: &TaskStore, thread_id: &str) -> Result<Option<ManagedThread>, ApiError> {
    let store = store.clone();
    let thread_id = thread_id.to_string();
    tokio::task::spawn_blocking(move || store.find(&thread_id))
        .await
        .map_err(|error| ApiError::Internal(format!("task store worker failed: {error}")))?
        .map_err(|error| ApiError::Internal(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::RunBy;

    fn store_with(active: &[&str], archived: &[&str]) -> TaskStore {
        let store = TaskStore::memory().unwrap();
        for id in active.iter().chain(archived) {
            store
                .claim(
                    ManagedThread::new(*id, RunBy::Codex, Some(1), None, None),
                    1,
                )
                .unwrap();
        }
        for id in archived {
            store.archive(id, 2).unwrap().unwrap();
        }
        store
    }

    fn is_archived(error: &ApiError) -> bool {
        matches!(
            error,
            ApiError::Conflict {
                code: "task_archived",
                ..
            }
        )
    }

    fn is_not_archived(error: &ApiError) -> bool {
        matches!(
            error,
            ApiError::BadRequest {
                code: "task_not_archived",
                ..
            }
        )
    }

    fn is_not_found(error: &ApiError) -> bool {
        matches!(
            error,
            ApiError::NotFound {
                code: "task_not_found",
                ..
            }
        )
    }

    #[tokio::test]
    async fn a_request_for_an_active_task_is_told_where_the_task_is_instead() {
        let store = store_with(&["active"], &["archived"]);

        assert_eq!(
            active_record(&store, "active").await.unwrap().thread_id,
            "active"
        );
        assert!(is_archived(
            &active_record(&store, "archived").await.unwrap_err()
        ));
        assert!(is_not_found(
            &active_record(&store, "missing").await.unwrap_err()
        ));
    }

    #[tokio::test]
    async fn a_request_for_an_archived_task_is_told_where_the_task_is_instead() {
        let store = store_with(&["active"], &["archived"]);

        assert_eq!(
            archived_record(&store, "archived").await.unwrap().thread_id,
            "archived"
        );
        assert!(is_not_archived(
            &archived_record(&store, "active").await.unwrap_err()
        ));
        assert!(is_not_found(
            &archived_record(&store, "missing").await.unwrap_err()
        ));
    }

    #[tokio::test]
    async fn a_task_that_moved_is_refused_by_where_it_is_now() {
        let store = store_with(&["active"], &["archived"]);

        assert!(is_archived(&moved_refusal(&store, "archived").await));
        assert!(is_not_archived(&moved_refusal(&store, "active").await));
        assert!(is_not_found(&moved_refusal(&store, "missing").await));
    }
}
