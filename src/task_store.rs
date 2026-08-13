use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use gluesql::{
    core::query_builder::{Execute, begin, commit, rollback},
    prelude::{Error as GlueError, Glue, MemoryStorage, RedbStorage},
};
use thiserror::Error;

mod managed_section;
mod managed_thread;
mod managed_worktree;
mod migration;
mod push_installation;
mod push_vapid_key;
mod schema_migration;

pub(crate) use managed_section::ManagedSection;
pub(crate) use managed_thread::ManagedThread;
pub(crate) use managed_worktree::{ManagedWorktree, ManagedWorktreeState};
pub(crate) use migration::{
    ManagedThreadMigrationInventory, NavigatorMigrationSection, NavigatorMigrationSnapshot,
    NavigatorMigrationThread, NavigatorMigrationThreadClassification, PendingTaskStoreMigration,
    PreparedTaskStoreMigration, prepare_to_latest as prepare_task_store_migration,
};
#[cfg(test)]
pub(crate) use migration::{write_empty_v4_test_store, write_v4_test_store};
pub(crate) use push_installation::{
    PushInstallation, PushInstallationSummary, PushSubscriptionInput,
};

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
    #[error("invalid Caffold navigator migration snapshot: {0}")]
    InvalidMigrationSnapshot(&'static str),
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

pub(crate) enum TaskStoreTables<'a> {
    Memory(&'a mut Glue<MemoryStorage>),
    Redb(&'a mut Glue<RedbStorage>),
}

impl TaskStoreTables<'_> {
    pub(crate) fn managed_sections(&mut self) -> Result<Vec<ManagedSection>> {
        match self {
            Self::Memory(glue) => managed_section::list(glue),
            Self::Redb(glue) => managed_section::list(glue),
        }
    }

    pub(crate) fn active_managed_threads(&mut self) -> Result<Vec<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::list_all_active(glue),
            Self::Redb(glue) => managed_thread::list_all_active(glue),
        }
    }

    pub(crate) fn upsert_managed_section(&mut self, section: &ManagedSection) -> Result<()> {
        match self {
            Self::Memory(glue) => managed_section::upsert(glue, section),
            Self::Redb(glue) => managed_section::upsert(glue, section),
        }
    }

    pub(crate) fn claim_managed_thread_at_top(
        &mut self,
        thread: ManagedThread,
        display_name: &str,
        section_id: &str,
        now_ms: u64,
    ) -> Result<ManagedThread> {
        match self {
            Self::Memory(glue) => {
                managed_thread::claim_at_top(glue, thread, display_name, section_id, now_ms)
            }
            Self::Redb(glue) => {
                managed_thread::claim_at_top(glue, thread, display_name, section_id, now_ms)
            }
        }
    }

    pub(crate) fn place_managed_thread_at_top(
        &mut self,
        thread_id: &str,
        section_id: &str,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::place_at_top(glue, thread_id, section_id),
            Self::Redb(glue) => managed_thread::place_at_top(glue, thread_id, section_id),
        }
    }

    pub(crate) fn restore_managed_thread_at_top(
        &mut self,
        thread_id: &str,
        section_id: &str,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::restore_at_top(glue, thread_id, section_id),
            Self::Redb(glue) => managed_thread::restore_at_top(glue, thread_id, section_id),
        }
    }

    pub(crate) fn archive_managed_thread(
        &mut self,
        thread_id: &str,
        archived_at_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => {
                managed_thread::archive_and_compact(glue, thread_id, archived_at_ms)
            }
            Self::Redb(glue) => {
                managed_thread::archive_and_compact(glue, thread_id, archived_at_ms)
            }
        }
    }

    pub(crate) fn delete_active_managed_thread(&mut self, thread_id: &str) -> Result<bool> {
        match self {
            Self::Memory(glue) => managed_thread::delete_active_and_compact(glue, thread_id),
            Self::Redb(glue) => managed_thread::delete_active_and_compact(glue, thread_id),
        }
    }

    pub(crate) fn delete_archived_managed_thread(&mut self, thread_id: &str) -> Result<bool> {
        match self {
            Self::Memory(glue) => managed_thread::delete_archived(glue, thread_id),
            Self::Redb(glue) => managed_thread::delete_archived(glue, thread_id),
        }
    }

    pub(crate) fn delete_managed_worktree(&mut self, worktree_id: &str) -> Result<bool> {
        match self {
            Self::Memory(glue) => managed_worktree::delete(glue, worktree_id),
            Self::Redb(glue) => managed_worktree::delete(glue, worktree_id),
        }
    }
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
        let storage = RedbStorage::new(path)?;
        let mut glue = Glue::new(storage);
        migration::initialize_redb(&mut glue)?;
        Ok(Self::Redb(Arc::new(Mutex::new(glue))))
    }

    #[cfg(test)]
    pub(crate) fn claim(&self, thread: ManagedThread, now_ms: u64) -> Result<ManagedThread> {
        match self {
            Self::Memory(glue) => managed_thread::claim(&mut *lock_glue(glue)?, thread, now_ms),
            Self::Redb(glue) => managed_thread::claim(&mut *lock_glue(glue)?, thread, now_ms),
        }
    }

    pub(crate) fn update_display_name(
        &self,
        thread_id: &str,
        display_name: &str,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => {
                managed_thread::update_display_name(&mut *lock_glue(glue)?, thread_id, display_name)
            }
            Self::Redb(glue) => {
                managed_thread::update_display_name(&mut *lock_glue(glue)?, thread_id, display_name)
            }
        }
    }

    pub(crate) fn read<T>(
        &self,
        operation: impl FnOnce(&mut TaskStoreTables<'_>) -> Result<T>,
    ) -> Result<T> {
        match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                operation(&mut TaskStoreTables::Memory(&mut glue))
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                operation(&mut TaskStoreTables::Redb(&mut glue))
            }
        }
    }

    pub(crate) fn transaction<T>(
        &self,
        operation: impl FnOnce(&mut TaskStoreTables<'_>) -> Result<T>,
    ) -> Result<T> {
        match self {
            Self::Memory(glue) => {
                let mut glue = lock_glue(glue)?;
                let previous = glue.storage.clone();
                match operation(&mut TaskStoreTables::Memory(&mut glue)) {
                    Ok(value) => Ok(value),
                    Err(error) => {
                        glue.storage = previous;
                        Err(error)
                    }
                }
            }
            Self::Redb(glue) => {
                let mut glue = lock_glue(glue)?;
                begin().execute(&mut *glue)?;
                let result = operation(&mut TaskStoreTables::Redb(&mut glue));
                match result {
                    Ok(value) => match commit().execute(&mut *glue) {
                        Ok(_) => Ok(value),
                        Err(error) => {
                            let _ = rollback().execute(&mut *glue);
                            Err(error.into())
                        }
                    },
                    Err(error) => {
                        let _ = rollback().execute(&mut *glue);
                        Err(error)
                    }
                }
            }
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

    #[cfg(test)]
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
        self.transaction(|tables| tables.archive_managed_thread(thread_id, archived_at_ms))
    }

    #[cfg(test)]
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

    #[cfg(test)]
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

    #[cfg(test)]
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

    pub(crate) fn record_completed_turn(
        &self,
        thread_id: &str,
        completed_at_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::record_completed_turn(
                &mut *lock_glue(glue)?,
                thread_id,
                completed_at_ms,
            ),
            Self::Redb(glue) => managed_thread::record_completed_turn(
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
        fast_mode: bool,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => managed_thread::update_composer_settings(
                &mut *lock_glue(glue)?,
                thread_id,
                model,
                reasoning_effort,
                fast_mode,
            ),
            Self::Redb(glue) => managed_thread::update_composer_settings(
                &mut *lock_glue(glue)?,
                thread_id,
                model,
                reasoning_effort,
                fast_mode,
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn delete(&self, thread_id: &str) -> Result<bool> {
        match self {
            Self::Memory(glue) => managed_thread::delete(&mut *lock_glue(glue)?, thread_id),
            Self::Redb(glue) => managed_thread::delete(&mut *lock_glue(glue)?, thread_id),
        }
    }

    #[cfg(test)]
    pub(crate) fn delete_archived(&self, thread_id: &str) -> Result<bool> {
        match self {
            Self::Memory(glue) => {
                managed_thread::delete_archived(&mut *lock_glue(glue)?, thread_id)
            }
            Self::Redb(glue) => managed_thread::delete_archived(&mut *lock_glue(glue)?, thread_id),
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

    pub(crate) fn push_installation(&self, client_id: &str) -> Result<Option<PushInstallation>> {
        match self {
            Self::Memory(glue) => push_installation::get(&mut *lock_glue(glue)?, client_id),
            Self::Redb(glue) => push_installation::get(&mut *lock_glue(glue)?, client_id),
        }
    }

    pub(crate) fn active_push_installations(&self) -> Result<Vec<PushInstallation>> {
        match self {
            Self::Memory(glue) => push_installation::list_active(&mut *lock_glue(glue)?),
            Self::Redb(glue) => push_installation::list_active(&mut *lock_glue(glue)?),
        }
    }

    pub(crate) fn push_installation_summaries(&self) -> Result<Vec<PushInstallationSummary>> {
        match self {
            Self::Memory(glue) => push_installation::list_summaries(&mut *lock_glue(glue)?),
            Self::Redb(glue) => push_installation::list_summaries(&mut *lock_glue(glue)?),
        }
    }

    pub(crate) fn upsert_push_installation(
        &self,
        input: PushSubscriptionInput,
        now_ms: u64,
    ) -> Result<PushInstallation> {
        match self {
            Self::Memory(glue) => push_installation::upsert(&mut *lock_glue(glue)?, input, now_ms),
            Self::Redb(glue) => {
                push_installation::upsert_transactional(&mut *lock_glue(glue)?, input, now_ms)
            }
        }
    }

    pub(crate) fn revoke_push_installation(&self, client_id: &str, now_ms: u64) -> Result<()> {
        match self {
            Self::Memory(glue) => {
                push_installation::revoke(&mut *lock_glue(glue)?, client_id, now_ms)
            }
            Self::Redb(glue) => {
                push_installation::revoke_transactional(&mut *lock_glue(glue)?, client_id, now_ms)
            }
        }
    }

    pub(crate) fn delete_invalid_push_installation(
        &self,
        client_id: &str,
        endpoint: &str,
    ) -> Result<bool> {
        match self {
            Self::Memory(glue) => push_installation::delete_if_endpoint_matches(
                &mut *lock_glue(glue)?,
                client_id,
                endpoint,
            ),
            Self::Redb(glue) => push_installation::delete_if_endpoint_matches(
                &mut *lock_glue(glue)?,
                client_id,
                endpoint,
            ),
        }
    }

    pub(crate) fn load_or_create_vapid_private_key(
        &self,
        generated_private_key: &str,
        now_ms: u64,
    ) -> Result<String> {
        match self {
            Self::Memory(glue) => push_vapid_key::load_or_create(
                &mut *lock_glue(glue)?,
                generated_private_key,
                now_ms,
            ),
            Self::Redb(glue) => push_vapid_key::load_or_create(
                &mut *lock_glue(glue)?,
                generated_private_key,
                now_ms,
            ),
        }
    }
}

fn lock_glue<T>(glue: &Arc<Mutex<T>>) -> Result<MutexGuard<'_, T>> {
    glue.lock().map_err(|_| TaskStoreError::Poisoned)
}

#[cfg(test)]
mod tests {
    use gluesql::core::query_builder::table;

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
                .update_composer_settings(&thread_id, Some("gpt-test"), Some("xhigh"), true)
                .unwrap()
                .unwrap();
            assert_eq!(configured.model.as_deref(), Some("gpt-test"));
            assert!(configured.fast_mode);

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

            let deleted_thread_id = format!("archived-delete-{index}");
            store.claim(thread(&deleted_thread_id), 100).unwrap();
            store.archive(&deleted_thread_id, 60).unwrap().unwrap();
            assert!(store.delete_archived(&deleted_thread_id).unwrap());
            assert!(store.get_archived(&deleted_thread_id).unwrap().is_none());

            assert!(store.restore(&thread_id).unwrap().is_some());
            assert!(store.delete(&thread_id).unwrap());

            let client_id = format!("00000000-0000-4000-8000-00000000000{index}");
            let subscription = PushSubscriptionInput {
                client_id: client_id.clone(),
                installation_label: format!("Chrome on macOS · 000{index}"),
                endpoint: format!("https://push.example/{index}"),
                p256dh: format!("public-key-{index}"),
                auth: format!("auth-{index}"),
                expiration_time_ms: None,
            };
            assert!(
                store
                    .upsert_push_installation(subscription.clone(), 1_000)
                    .unwrap()
                    .is_active()
            );
            assert_eq!(store.active_push_installations().unwrap().len(), 1);
            assert_eq!(store.push_installation_summaries().unwrap().len(), 1);
            store.revoke_push_installation(&client_id, 2_000).unwrap();
            assert_eq!(
                store
                    .push_installation(&client_id)
                    .unwrap()
                    .unwrap()
                    .revoked_at_ms,
                Some(2_000)
            );
            store.upsert_push_installation(subscription, 3_000).unwrap();
            assert_eq!(
                store
                    .load_or_create_vapid_private_key(&format!("private-key-{index}"), 1_000)
                    .unwrap(),
                format!("private-key-{index}")
            );
        }

        redb.claim(thread("persisted"), 200).unwrap();
        drop(redb);
        let reopened = TaskStore::redb(&path).unwrap();
        assert!(reopened.get("persisted").unwrap().is_some());
        assert!(reopened.worktree("worktree-1").unwrap().is_some());
        assert_eq!(reopened.active_push_installations().unwrap().len(), 1);
        assert_eq!(
            reopened
                .load_or_create_vapid_private_key("replacement", 5_000)
                .unwrap(),
            "private-key-1"
        );
    }

    #[test]
    fn redb_open_rejects_legacy_schema_without_running_migration_or_losing_its_version() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy-v0.redb");
        {
            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            table("managed_threads")
                .create_table()
                .add_column("thread_id TEXT PRIMARY KEY")
                .add_column("last_observed_recency_ms INTEGER NULL")
                .add_column("claimed_at_ms INTEGER")
                .add_column("last_opened_at_ms INTEGER NULL")
                .add_column("last_seen_activity_ms INTEGER NULL")
                .add_column("model TEXT NULL")
                .add_column("reasoning_effort TEXT NULL")
                .execute(&mut glue)
                .unwrap();
        }

        assert!(matches!(
            TaskStore::redb(&path),
            Err(TaskStoreError::MigrationRequired(0))
        ));
        assert_eq!(
            std::fs::read_dir(temp.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>(),
            [path.file_name().unwrap().to_os_string()]
        );
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

    #[test]
    fn scoped_redb_transaction_rolls_back_all_touched_tables() {
        let temp = tempfile::tempdir().unwrap();
        let store = TaskStore::redb(temp.path().join("caffold.redb")).unwrap();
        let section = ManagedSection {
            section_id: "section-rollback".to_string(),
            logical_path: "Workspace/rollback".to_string(),
        };

        let result = store.transaction(|tables| {
            tables.upsert_managed_section(&section)?;
            tables.claim_managed_thread_at_top(
                thread("thread-rollback"),
                "Rollback task",
                &section.section_id,
                100,
            )?;
            Err::<(), _>(TaskStoreError::InvalidRow("injected_transaction_failure"))
        });

        assert!(matches!(
            result,
            Err(TaskStoreError::InvalidRow("injected_transaction_failure"))
        ));
        assert_eq!(
            store
                .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
                .unwrap(),
            (Vec::new(), Vec::new())
        );
    }
}
