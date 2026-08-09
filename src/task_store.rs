use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use gluesql::prelude::{Error as GlueError, Glue, MemoryStorage, RedbStorage};
use thiserror::Error;

mod managed_thread;
mod managed_worktree;
mod migration;
mod schema_migration;

pub(crate) use managed_thread::ManagedThread;
pub(crate) use managed_worktree::{ManagedWorktree, ManagedWorktreeState};

#[derive(Debug, Error)]
pub(crate) enum TaskStoreError {
    #[error("invalid thread pagination cursor")]
    InvalidCursor,
    #[error("unexpected task store payload")]
    UnexpectedPayload,
    #[error("invalid thread row column: {0}")]
    InvalidRow(&'static str),
    #[error("archived thread cannot be claimed as active: {0}")]
    ArchivedThreadCannotBeClaimed(String),
    #[error("managed worktree already exists for thread: {0}")]
    DuplicateManagedWorktreeThread(String),
    #[cfg(test)]
    #[error("managed worktree {worktree_id} is already bound to thread: {thread_id}")]
    ManagedWorktreeAlreadyBound {
        worktree_id: String,
        thread_id: String,
    },
    #[error("managed worktree path is already owned: {0}")]
    DuplicateManagedWorktreePath(String),
    #[error("invalid managed worktree state: {0}")]
    InvalidManagedWorktreeState(String),
    #[error("managed worktree {worktree_id} cannot transition from {actual} to {expected}")]
    ManagedWorktreeStateConflict {
        worktree_id: String,
        actual: String,
        expected: String,
    },
    #[error("managed worktree cannot transition from {from} to {to}")]
    InvalidManagedWorktreeTransition { from: String, to: String },
    #[error("thread exists in both legacy active and archived tables: {0}")]
    DuplicateLegacyThread(String),
    #[error("Caffold schema v{0} requires migration before opening")]
    MigrationRequired(i64),
    #[error("Caffold migration path does not exist: {0}")]
    MigrationPathMissing(String),
    #[error("Caffold migration path is not a file: {0}")]
    MigrationPathNotFile(String),
    #[error("Caffold schema v{found} is newer than supported schema v{supported}")]
    UnsupportedNewerSchemaVersion { found: i64, supported: i64 },
    #[error("unexpected table in Caffold schema: {0}")]
    UnexpectedSchemaTable(String),
    #[error("invalid Caffold schema table: {0}")]
    InvalidSchemaTable(String),
    #[error("invalid Caffold schema migration history")]
    InvalidSchemaMigrationHistory,
    #[error("incomplete Caffold thread schema")]
    IncompleteSchema,
    #[error("task store mutex was poisoned")]
    Poisoned,
    #[error("task store error: {0}")]
    Glue(#[from] GlueError),
    #[error("filesystem error while preparing task store: {0}")]
    Io(#[from] std::io::Error),
}

type Result<T> = std::result::Result<T, TaskStoreError>;

#[derive(Clone)]
pub(crate) enum TaskStore {
    Memory(Arc<Mutex<Glue<MemoryStorage>>>),
    Redb(Arc<Mutex<Glue<RedbStorage>>>),
}

impl TaskStore {
    pub(crate) fn memory() -> Result<Self> {
        let mut glue = Glue::new(MemoryStorage::default());
        migration::initialize_memory(&mut glue)?;
        Ok(Self::Memory(Arc::new(Mutex::new(glue))))
    }

    pub(crate) fn redb(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if path.exists() {
            let _report = migration::migrate_to_latest(path)?;
        }
        let storage = RedbStorage::new(path)?;
        let mut glue = Glue::new(storage);
        migration::initialize_redb(&mut glue)?;
        Ok(Self::Redb(Arc::new(Mutex::new(glue))))
    }

    pub(crate) fn claim(&self, thread: ManagedThread, now_ms: u64) -> Result<ManagedThread> {
        match self {
            Self::Memory(glue) => managed_thread::claim(&mut *lock_glue(glue)?, thread, now_ms),
            Self::Redb(glue) => managed_thread::claim(&mut *lock_glue(glue)?, thread, now_ms),
        }
    }

    pub(crate) fn get(&self, thread_id: &str) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::get(&mut *lock_glue(glue)?, thread_id),
            Self::Redb(glue) => managed_thread::get(&mut *lock_glue(glue)?, thread_id),
        }
    }

    pub(crate) fn get_archived(&self, thread_id: &str) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::get_archived(&mut *lock_glue(glue)?, thread_id),
            Self::Redb(glue) => managed_thread::get_archived(&mut *lock_glue(glue)?, thread_id),
        }
    }

    pub(crate) fn list(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<ManagedThread>, Option<String>)> {
        match self {
            Self::Memory(glue) => managed_thread::list(&mut *lock_glue(glue)?, cursor, limit),
            Self::Redb(glue) => managed_thread::list(&mut *lock_glue(glue)?, cursor, limit),
        }
    }

    pub(crate) fn list_archived(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<ManagedThread>, Option<String>)> {
        match self {
            Self::Memory(glue) => {
                managed_thread::list_archived(&mut *lock_glue(glue)?, cursor, limit)
            }
            Self::Redb(glue) => {
                managed_thread::list_archived(&mut *lock_glue(glue)?, cursor, limit)
            }
        }
    }

    pub(crate) fn archive(
        &self,
        thread_id: &str,
        archived_at_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => {
                managed_thread::archive(&mut *lock_glue(glue)?, thread_id, archived_at_ms)
            }
            Self::Redb(glue) => {
                managed_thread::archive(&mut *lock_glue(glue)?, thread_id, archived_at_ms)
            }
        }
    }

    pub(crate) fn restore(&self, thread_id: &str) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::restore(&mut *lock_glue(glue)?, thread_id),
            Self::Redb(glue) => managed_thread::restore(&mut *lock_glue(glue)?, thread_id),
        }
    }

    pub(crate) fn update_observed_recency(
        &self,
        thread_id: &str,
        activity_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::update_observed_recency(
                &mut *lock_glue(glue)?,
                thread_id,
                activity_ms,
            ),
            Self::Redb(glue) => managed_thread::update_observed_recency(
                &mut *lock_glue(glue)?,
                thread_id,
                activity_ms,
            ),
        }
    }

    pub(crate) fn update_archived_observed_recency(
        &self,
        thread_id: &str,
        activity_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::update_archived_observed_recency(
                &mut *lock_glue(glue)?,
                thread_id,
                activity_ms,
            ),
            Self::Redb(glue) => managed_thread::update_archived_observed_recency(
                &mut *lock_glue(glue)?,
                thread_id,
                activity_ms,
            ),
        }
    }

    pub(crate) fn update_completed_at(
        &self,
        thread_id: &str,
        completed_at_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::update_completed_at(
                &mut *lock_glue(glue)?,
                thread_id,
                completed_at_ms,
            ),
            Self::Redb(glue) => managed_thread::update_completed_at(
                &mut *lock_glue(glue)?,
                thread_id,
                completed_at_ms,
            ),
        }
    }

    pub(crate) fn mark_seen(
        &self,
        thread_id: &str,
        canonical_activity_ms: u64,
        opened_at_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::mark_seen(
                &mut *lock_glue(glue)?,
                thread_id,
                canonical_activity_ms,
                opened_at_ms,
            ),
            Self::Redb(glue) => managed_thread::mark_seen(
                &mut *lock_glue(glue)?,
                thread_id,
                canonical_activity_ms,
                opened_at_ms,
            ),
        }
    }

    pub(crate) fn update_composer_settings(
        &self,
        thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::update_composer_settings(
                &mut *lock_glue(glue)?,
                thread_id,
                model,
                reasoning_effort,
            ),
            Self::Redb(glue) => managed_thread::update_composer_settings(
                &mut *lock_glue(glue)?,
                thread_id,
                model,
                reasoning_effort,
            ),
        }
    }

    pub(crate) fn delete(&self, thread_id: &str) -> Result<bool> {
        match self {
            Self::Memory(glue) => managed_thread::delete(&mut *lock_glue(glue)?, thread_id),
            Self::Redb(glue) => managed_thread::delete(&mut *lock_glue(glue)?, thread_id),
        }
    }

    pub(crate) fn create_worktree(&self, worktree: ManagedWorktree) -> Result<ManagedWorktree> {
        match self {
            Self::Memory(glue) => managed_worktree::create(&mut *lock_glue(glue)?, worktree),
            Self::Redb(glue) => managed_worktree::create(&mut *lock_glue(glue)?, worktree),
        }
    }

    pub(crate) fn worktree(&self, worktree_id: &str) -> Result<Option<ManagedWorktree>> {
        match self {
            Self::Memory(glue) => managed_worktree::get(&mut *lock_glue(glue)?, worktree_id),
            Self::Redb(glue) => managed_worktree::get(&mut *lock_glue(glue)?, worktree_id),
        }
    }

    pub(crate) fn worktree_for_thread(&self, thread_id: &str) -> Result<Option<ManagedWorktree>> {
        match self {
            Self::Memory(glue) => {
                managed_worktree::get_for_thread(&mut *lock_glue(glue)?, thread_id)
            }
            Self::Redb(glue) => managed_worktree::get_for_thread(&mut *lock_glue(glue)?, thread_id),
        }
    }

    pub(crate) fn managed_worktrees(&self) -> Result<Vec<ManagedWorktree>> {
        match self {
            Self::Memory(glue) => managed_worktree::list(&mut *lock_glue(glue)?),
            Self::Redb(glue) => managed_worktree::list(&mut *lock_glue(glue)?),
        }
    }

    #[cfg(test)]
    pub(crate) fn bind_worktree_thread(
        &self,
        worktree_id: &str,
        thread_id: &str,
        updated_at_ms: u64,
    ) -> Result<ManagedWorktree> {
        match self {
            Self::Memory(glue) => managed_worktree::bind_thread(
                &mut *lock_glue(glue)?,
                worktree_id,
                thread_id,
                updated_at_ms,
            ),
            Self::Redb(glue) => managed_worktree::bind_thread(
                &mut *lock_glue(glue)?,
                worktree_id,
                thread_id,
                updated_at_ms,
            ),
        }
    }

    pub(crate) fn update_worktree_checkout(
        &self,
        worktree_id: &str,
        branch_name: &str,
        head_sha: &str,
        updated_at_ms: u64,
    ) -> Result<ManagedWorktree> {
        match self {
            Self::Memory(glue) => managed_worktree::update_checkout(
                &mut *lock_glue(glue)?,
                worktree_id,
                branch_name,
                head_sha,
                updated_at_ms,
            ),
            Self::Redb(glue) => managed_worktree::update_checkout(
                &mut *lock_glue(glue)?,
                worktree_id,
                branch_name,
                head_sha,
                updated_at_ms,
            ),
        }
    }

    pub(crate) fn transition_worktree(
        &self,
        worktree_id: &str,
        expected: ManagedWorktreeState,
        next: ManagedWorktreeState,
        updated_at_ms: u64,
    ) -> Result<ManagedWorktree> {
        match self {
            Self::Memory(glue) => managed_worktree::transition(
                &mut *lock_glue(glue)?,
                worktree_id,
                expected,
                next,
                updated_at_ms,
            ),
            Self::Redb(glue) => managed_worktree::transition(
                &mut *lock_glue(glue)?,
                worktree_id,
                expected,
                next,
                updated_at_ms,
            ),
        }
    }

    pub(crate) fn delete_worktree(&self, worktree_id: &str) -> Result<bool> {
        match self {
            Self::Memory(glue) => managed_worktree::delete(&mut *lock_glue(glue)?, worktree_id),
            Self::Redb(glue) => managed_worktree::delete(&mut *lock_glue(glue)?, worktree_id),
        }
    }
}

fn lock_glue<T>(glue: &Arc<Mutex<T>>) -> Result<MutexGuard<'_, T>> {
    glue.lock().map_err(|_| TaskStoreError::Poisoned)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str) -> ManagedThread {
        ManagedThread::new(id, Some(20), None, None)
    }

    fn worktree(id: &str) -> ManagedWorktree {
        ManagedWorktree {
            worktree_id: id.to_string(),
            thread_id: None,
            repository_git_dir: format!("/repositories/{id}/.git"),
            worktree_path: format!("/managed/{id}"),
            branch_name: format!("caffold/{id}"),
            head_sha: "abc123".to_string(),
            state: ManagedWorktreeState::Creating,
            created_at_ms: 100,
            updated_at_ms: 100,
        }
    }

    #[test]
    fn memory_and_redb_backends_share_the_same_store_contract() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("nested/caffold.redb");
        let memory = TaskStore::memory().unwrap();
        let redb = TaskStore::redb(&path).unwrap();

        for (index, store) in [&memory, &redb].into_iter().enumerate() {
            let thread_id = format!("task-{index}");
            let claimed = store.claim(thread(&thread_id), 100).unwrap();
            assert_eq!(store.get(&thread_id).unwrap(), Some(claimed));
            assert_eq!(store.list(None, 10).unwrap().0.len(), 1);

            let observed = store
                .update_observed_recency(&thread_id, 30)
                .unwrap()
                .unwrap();
            assert_eq!(observed.last_observed_recency_ms, Some(30));
            let completed = store.update_completed_at(&thread_id, 40).unwrap().unwrap();
            assert!(completed.unseen());
            let seen = store.mark_seen(&thread_id, 30, 50).unwrap().unwrap();
            assert!(!seen.unseen());
            let configured = store
                .update_composer_settings(&thread_id, Some("gpt-test"), Some("xhigh"))
                .unwrap()
                .unwrap();
            assert_eq!(configured.model.as_deref(), Some("gpt-test"));

            let worktree_id = format!("worktree-{index}");
            store.create_worktree(worktree(&worktree_id)).unwrap();
            store
                .transition_worktree(
                    &worktree_id,
                    ManagedWorktreeState::Creating,
                    ManagedWorktreeState::Ready,
                    110,
                )
                .unwrap();
            let bound = store
                .bind_worktree_thread(&worktree_id, &thread_id, 120)
                .unwrap();
            assert_eq!(store.worktree(&worktree_id).unwrap(), Some(bound.clone()));
            assert_eq!(store.worktree_for_thread(&thread_id).unwrap(), Some(bound));

            let archived = store.archive(&thread_id, 60).unwrap().unwrap();
            assert_eq!(store.get_archived(&thread_id).unwrap(), Some(archived));
            assert_eq!(store.list_archived(None, 10).unwrap().0.len(), 1);
            let archived = store
                .update_archived_observed_recency(&thread_id, 70)
                .unwrap()
                .unwrap();
            assert_eq!(archived.last_observed_recency_ms, Some(70));

            assert!(store.restore(&thread_id).unwrap().is_some());
            assert!(store.delete(&thread_id).unwrap());
        }

        redb.claim(thread("persisted"), 200).unwrap();
        drop(redb);
        let reopened = TaskStore::redb(&path).unwrap();
        assert!(reopened.get("persisted").unwrap().is_some());
        assert!(reopened.worktree("worktree-1").unwrap().is_some());
    }

    #[test]
    fn poisoned_backend_lock_is_reported_as_a_store_error() {
        let glue = Arc::new(Mutex::new(Glue::new(MemoryStorage::default())));
        let poison = Arc::clone(&glue);
        let _ = std::thread::spawn(move || {
            let _guard = poison.lock().unwrap();
            panic!("poison test mutex");
        })
        .join();
        let store = TaskStore::Memory(glue);

        assert!(matches!(store.get("task"), Err(TaskStoreError::Poisoned)));
    }
}
