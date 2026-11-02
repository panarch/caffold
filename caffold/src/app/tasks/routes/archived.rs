use crate::agent::{Conversation, Driver};
use crate::app::error::ApiError;
use crate::app::tasks::projection::{
    TaskWorktreeContext, conversation_from_row, project_managed_worktree_cwd,
};
use crate::fs::RootedFs;
use crate::task_store::{ManagedThread, TaskStore};
use serde::Serialize;

/// What the Archived list needs to find, restore, or delete a Task.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ArchivedTaskRecord {
    pub(super) thread_id: String,
    pub(super) conversation_available: bool,
    pub(super) title: String,
    pub(super) cwd: String,
    pub(super) cwd_path: Option<String>,
    pub(super) relative_cwd: String,
    pub(super) worktree: Option<TaskWorktreeContext>,
    pub(super) created_ms: u64,
    pub(super) updated_ms: u64,
    pub(super) recency_ms: Option<u64>,
    pub(super) last_completed_ms: Option<u64>,
    pub(super) repository_path: Option<String>,
}

impl ArchivedTaskRecord {
    pub(super) async fn described(
        fs: &RootedFs,
        store: &TaskStore,
        driver: &Driver,
        managed: &ManagedThread,
        described: Option<Conversation>,
    ) -> Result<Self, ApiError> {
        match described {
            Some(conversation) => Self::from_conversation(fs, store, managed, conversation),
            None => {
                let conversation = conversation_from_row(managed)?;
                let mut task = Self::from_conversation(fs, store, managed, conversation)?;
                task.conversation_available =
                    driver.conversation_exists(&managed.thread_id).await?;
                Ok(task)
            }
        }
    }

    pub(super) fn from_conversation(
        fs: &RootedFs,
        store: &TaskStore,
        managed: &ManagedThread,
        conversation: Conversation,
    ) -> Result<Self, ApiError> {
        let (conversation, resolved) = project_managed_worktree_cwd(fs, store, conversation)?;
        let cwd_path = resolved.as_ref().and_then(|cwd| cwd.logical_cwd.clone());
        Ok(Self {
            thread_id: managed.thread_id.clone(),
            conversation_available: true,
            title: managed.display_name.clone(),
            relative_cwd: cwd_path.clone().unwrap_or_else(|| conversation.cwd.clone()),
            cwd: conversation.cwd,
            cwd_path,
            worktree: resolved.and_then(|cwd| cwd.worktree),
            created_ms: conversation.created_at_ms,
            updated_ms: conversation.updated_at_ms,
            recency_ms: conversation.recency_at_ms,
            last_completed_ms: managed.last_completed_at_ms,
            repository_path: None,
        })
    }

    /// An unaskable provider does not hide Caffold's retained row.
    pub(super) fn unavailable(managed: &ManagedThread) -> Self {
        let activity_ms = managed
            .last_observed_recency_ms
            .or(managed.archived_at_ms)
            .unwrap_or(managed.claimed_at_ms);
        Self {
            thread_id: managed.thread_id.clone(),
            conversation_available: false,
            title: managed.display_name.clone(),
            cwd: String::new(),
            cwd_path: None,
            relative_cwd: String::new(),
            worktree: None,
            created_ms: managed.claimed_at_ms,
            updated_ms: activity_ms,
            recency_ms: Some(activity_ms),
            last_completed_ms: managed.last_completed_at_ms,
            repository_path: None,
        }
    }

    pub(super) fn activity_ms(&self) -> u64 {
        self.recency_ms
            .unwrap_or_else(|| self.updated_ms.max(self.created_ms))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{agent::antigravity::AntigravityClient, task_store::RunBy};
    use uuid::Uuid;

    #[tokio::test]
    async fn missing_native_binding_keeps_an_unavailable_archived_row() {
        let root = tempfile::tempdir().unwrap();
        let fs = RootedFs::new(root.path()).unwrap();
        let store = TaskStore::memory().unwrap();
        let driver = AntigravityClient::in_data_dir(root.path()).driver();
        let managed = ManagedThread::new(
            Uuid::new_v4().to_string(),
            RunBy::Antigravity {
                cwd: root.path().display().to_string(),
            },
            Some(42),
            None,
            None,
        );

        let row = ArchivedTaskRecord::described(&fs, &store, &driver, &managed, None)
            .await
            .unwrap();

        assert!(!row.conversation_available);
        assert_eq!(row.thread_id, managed.thread_id);
        assert_eq!(row.recency_ms, Some(42));
    }

    #[tokio::test]
    async fn corrupt_native_binding_remains_a_request_error() {
        let root = tempfile::tempdir().unwrap();
        let task_id = Uuid::new_v4().to_string();
        let bindings = root.path().join("antigravity/bindings");
        std::fs::create_dir_all(&bindings).unwrap();
        std::fs::write(bindings.join(format!("{task_id}.json")), "invalid JSON").unwrap();
        let fs = RootedFs::new(root.path()).unwrap();
        let store = TaskStore::memory().unwrap();
        let driver = AntigravityClient::in_data_dir(root.path()).driver();
        let managed = ManagedThread::new(
            task_id,
            RunBy::Antigravity {
                cwd: root.path().display().to_string(),
            },
            Some(42),
            None,
            None,
        );

        let error = ArchivedTaskRecord::described(&fs, &store, &driver, &managed, None)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("binding"), "{error}");
    }
}
