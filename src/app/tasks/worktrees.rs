use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use thiserror::Error;
use uuid::Uuid;

use crate::{
    fs::{FsError, RootedFs},
    git::{
        WorktreeCheckout, WorktreeError, WorktreeIsolationMode, delete_local_branch_if_matches,
        delete_transfer_snapshot, execute_worktree_transfer, inspect_attached_worktree,
        prepare_worktree_transfer, recover_worktree_transfer, remove_attached_worktree,
        restore_attached_worktree,
    },
    task_store::{ManagedWorktree, ManagedWorktreeState, TaskStore, TaskStoreError},
};

#[cfg(test)]
use crate::git::{create_prepared_worktree, prepare_attached_worktree};

#[derive(Debug, Error)]
pub(in crate::app) enum ManagedWorktreeError {
    #[error(transparent)]
    Store(#[from] TaskStoreError),
    #[error(transparent)]
    Git(#[from] WorktreeError),
    #[error(transparent)]
    Fs(#[from] FsError),
    #[error("managed worktree root is unavailable: {0}")]
    RootUnavailable(String),
    #[error("managed worktree record has an invalid identifier: {0}")]
    InvalidId(String),
    #[error("managed worktree record does not own its configured path: {0}")]
    UnownedPath(String),
    #[error("managed worktree worker failed: {0}")]
    Worker(String),
    #[error("system clock is before the Unix epoch")]
    Clock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::app) enum ArchiveOutcome {
    NotManaged,
    Archived(ManagedWorktree),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::app) enum RestoreOutcome {
    NotManaged,
    Restored(ManagedWorktree),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::app) enum IsolateOutcome {
    AlreadyReady(ManagedWorktree),
    Isolated {
        worktree: ManagedWorktree,
        source_warning: Option<String>,
    },
}

#[derive(Clone)]
pub(in crate::app) struct ManagedWorktrees {
    root: Arc<PathBuf>,
    store: TaskStore,
}

impl ManagedWorktrees {
    pub(in crate::app) fn new(
        fs: Arc<RootedFs>,
        store: TaskStore,
        root: PathBuf,
    ) -> Result<Self, ManagedWorktreeError> {
        let prospective_root = resolve_prospective_path(&root)?;
        if !prospective_root.starts_with(fs.root()) {
            return Err(ManagedWorktreeError::Fs(FsError::PathEscapesRoot));
        }
        std::fs::create_dir_all(&root).map_err(|error| {
            ManagedWorktreeError::RootUnavailable(format!("{}: {error}", root.display()))
        })?;
        let root = root.canonicalize().map_err(|error| {
            ManagedWorktreeError::RootUnavailable(format!("{}: {error}", root.display()))
        })?;
        fs.logical_path_for_absolute(&root)?;
        let worktrees = Self {
            root: Arc::new(root),
            store,
        };
        worktrees.recover_interrupted()?;
        Ok(worktrees)
    }

    #[cfg(test)]
    pub(in crate::app) async fn create(
        &self,
        source: PathBuf,
        task_name: String,
        requested_branch: Option<String>,
        base_ref: Option<String>,
    ) -> Result<ManagedWorktree, ManagedWorktreeError> {
        let worktrees = self.clone();
        tokio::task::spawn_blocking(move || {
            worktrees.create_blocking(
                &source,
                &task_name,
                requested_branch.as_deref(),
                base_ref.as_deref(),
            )
        })
        .await
        .map_err(|error| ManagedWorktreeError::Worker(error.to_string()))?
    }

    pub(in crate::app) async fn isolate_current(
        &self,
        source: PathBuf,
        thread_id: String,
        task_name: String,
        requested_branch: Option<String>,
        include_changes: bool,
    ) -> Result<IsolateOutcome, ManagedWorktreeError> {
        let worktrees = self.clone();
        tokio::task::spawn_blocking(move || {
            worktrees.isolate_current_blocking(
                &source,
                &thread_id,
                &task_name,
                requested_branch.as_deref(),
                include_changes,
            )
        })
        .await
        .map_err(|error| ManagedWorktreeError::Worker(error.to_string()))?
    }

    #[cfg(test)]
    pub(in crate::app) async fn bind_thread(
        &self,
        worktree_id: String,
        thread_id: String,
    ) -> Result<ManagedWorktree, ManagedWorktreeError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            store
                .bind_worktree_thread(&worktree_id, &thread_id, now_ms()?)
                .map_err(Into::into)
        })
        .await
        .map_err(|error| ManagedWorktreeError::Worker(error.to_string()))?
    }

    pub(in crate::app) async fn archive_for_thread(
        &self,
        thread_id: String,
    ) -> Result<ArchiveOutcome, ManagedWorktreeError> {
        let worktrees = self.clone();
        tokio::task::spawn_blocking(move || worktrees.archive_blocking(&thread_id))
            .await
            .map_err(|error| ManagedWorktreeError::Worker(error.to_string()))?
    }

    pub(in crate::app) async fn restore_for_thread(
        &self,
        thread_id: String,
    ) -> Result<RestoreOutcome, ManagedWorktreeError> {
        let worktrees = self.clone();
        tokio::task::spawn_blocking(move || worktrees.restore_blocking(&thread_id))
            .await
            .map_err(|error| ManagedWorktreeError::Worker(error.to_string()))?
    }

    #[cfg(test)]
    pub(in crate::app) async fn discard_unbound(
        &self,
        worktree_id: String,
    ) -> Result<(), ManagedWorktreeError> {
        let worktrees = self.clone();
        tokio::task::spawn_blocking(move || worktrees.discard_unbound_blocking(&worktree_id))
            .await
            .map_err(|error| ManagedWorktreeError::Worker(error.to_string()))?
    }

    #[cfg(test)]
    fn create_blocking(
        &self,
        source: &Path,
        task_name: &str,
        requested_branch: Option<&str>,
        base_ref: Option<&str>,
    ) -> Result<ManagedWorktree, ManagedWorktreeError> {
        let worktree_id = Uuid::new_v4().to_string();
        let path = self.root.join(&worktree_id);
        let branch_name = requested_branch
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| automatic_branch_name(task_name, &worktree_id));
        let plan = prepare_attached_worktree(source, &path, &branch_name, base_ref)?;
        let created_at_ms = now_ms()?;
        let record = ManagedWorktree {
            worktree_id: worktree_id.clone(),
            thread_id: None,
            repository_git_dir: path_text(&plan.common_dir)?.to_string(),
            worktree_path: path_text(&path)?.to_string(),
            branch_name: branch_name.clone(),
            head_sha: plan.base_head.clone(),
            state: ManagedWorktreeState::Creating,
            created_at_ms,
            updated_at_ms: created_at_ms,
        };
        self.store.create_worktree(record)?;

        let checkout = match create_prepared_worktree(&plan) {
            Ok(checkout) => checkout,
            Err(error) => {
                self.try_discard_after_create_failure(&worktree_id);
                return Err(error.into());
            }
        };
        let now = now_ms()?;
        if let Err(error) = self.store.update_worktree_checkout(
            &worktree_id,
            &checkout.branch_name,
            &checkout.head_sha,
            now,
        ) {
            self.try_discard_after_create_failure(&worktree_id);
            return Err(error.into());
        }
        match self.store.transition_worktree(
            &worktree_id,
            ManagedWorktreeState::Creating,
            ManagedWorktreeState::Ready,
            now,
        ) {
            Ok(record) => Ok(record),
            Err(error) => {
                self.try_discard_after_create_failure(&worktree_id);
                Err(error.into())
            }
        }
    }

    fn isolate_current_blocking(
        &self,
        source: &Path,
        thread_id: &str,
        task_name: &str,
        requested_branch: Option<&str>,
        include_changes: bool,
    ) -> Result<IsolateOutcome, ManagedWorktreeError> {
        if let Some(existing) = self.store.worktree_for_thread(thread_id)? {
            return if existing.state == ManagedWorktreeState::Ready {
                Ok(IsolateOutcome::AlreadyReady(existing))
            } else {
                Err(TaskStoreError::ManagedWorktreeStateConflict {
                    worktree_id: existing.worktree_id,
                    actual: existing.state.as_str().to_string(),
                    expected: ManagedWorktreeState::Ready.as_str().to_string(),
                }
                .into())
            };
        }

        let source = source.canonicalize().map_err(WorktreeError::Io)?;
        let worktree_id = Uuid::new_v4().to_string();
        let path = self.root.join(&worktree_id);
        let automatic_branch = automatic_branch_name(task_name, &worktree_id);
        let plan = prepare_worktree_transfer(
            &source,
            &path,
            &automatic_branch,
            requested_branch,
            include_changes,
        )?;
        let active_state = isolation_active_state(plan.mode);
        let created_at_ms = now_ms()?;
        self.store.create_worktree(ManagedWorktree {
            worktree_id: worktree_id.clone(),
            thread_id: Some(thread_id.to_string()),
            repository_git_dir: path_text(&plan.common_dir)?.to_string(),
            worktree_path: path_text(&path)?.to_string(),
            branch_name: plan.branch_name.clone(),
            head_sha: plan.head_sha.clone(),
            state: active_state,
            created_at_ms,
            updated_at_ms: created_at_ms,
        })?;
        let transferred = match execute_worktree_transfer(&plan, &worktree_id) {
            Ok(transferred) => transferred,
            Err(error) => {
                self.mark_recovery_required(&worktree_id);
                return Err(error.into());
            }
        };
        let ready = match self.finish_isolation(&worktree_id, active_state, &transferred.checkout) {
            Ok(ready) => ready,
            Err(error) => {
                self.mark_recovery_required(&worktree_id);
                return Err(error);
            }
        };
        self.try_delete_transfer_snapshot(&ready);
        Ok(IsolateOutcome::Isolated {
            worktree: ready,
            source_warning: transferred.source_warning,
        })
    }

    fn finish_isolation(
        &self,
        worktree_id: &str,
        expected_state: ManagedWorktreeState,
        checkout: &WorktreeCheckout,
    ) -> Result<ManagedWorktree, ManagedWorktreeError> {
        self.store.update_worktree_checkout(
            worktree_id,
            &checkout.branch_name,
            &checkout.head_sha,
            now_ms()?,
        )?;
        self.store
            .transition_worktree(
                worktree_id,
                expected_state,
                ManagedWorktreeState::Ready,
                now_ms()?,
            )
            .map_err(Into::into)
    }

    fn mark_recovery_required(&self, worktree_id: &str) {
        let expected = match self.store.worktree(worktree_id) {
            Ok(Some(record)) => record.state,
            Ok(None) => return,
            Err(error) => {
                eprintln!("failed to read interrupted worktree transfer {worktree_id}: {error}");
                return;
            }
        };
        if isolation_recovery_mode(expected).is_some() {
            return;
        }
        let Some(recovery_state) = isolation_mode_for_state(expected).map(isolation_recovery_state)
        else {
            return;
        };
        if let Err(error) = self.store.transition_worktree(
            worktree_id,
            expected,
            recovery_state,
            now_ms().unwrap_or(u64::MAX),
        ) {
            eprintln!(
                "failed to mark interrupted worktree transfer {worktree_id} for recovery: {error}"
            );
        }
    }

    fn try_delete_transfer_snapshot(&self, record: &ManagedWorktree) {
        if let Err(error) =
            delete_transfer_snapshot(Path::new(&record.repository_git_dir), &record.worktree_id)
        {
            eprintln!(
                "failed to remove completed worktree transfer snapshot {}: {error}",
                record.worktree_id
            );
        }
    }

    fn archive_blocking(&self, thread_id: &str) -> Result<ArchiveOutcome, ManagedWorktreeError> {
        let Some(record) = self.store.worktree_for_thread(thread_id)? else {
            return Ok(ArchiveOutcome::NotManaged);
        };
        require_state(&record, ManagedWorktreeState::Ready)?;
        let path = self.owned_path(&record)?;
        let common_dir = PathBuf::from(&record.repository_git_dir);
        let checkout =
            inspect_attached_worktree(&path, &common_dir, Some(record.branch_name.as_str()))?;
        if checkout.dirty {
            return Err(WorktreeError::Dirty(path.display().to_string()).into());
        }
        self.store.update_worktree_checkout(
            &record.worktree_id,
            &checkout.branch_name,
            &checkout.head_sha,
            now_ms()?,
        )?;
        self.store.transition_worktree(
            &record.worktree_id,
            ManagedWorktreeState::Ready,
            ManagedWorktreeState::Removing,
            now_ms()?,
        )?;
        if let Err(error) =
            remove_attached_worktree(&path, &checkout.common_dir, &checkout.branch_name)
        {
            let _ = self.store.transition_worktree(
                &record.worktree_id,
                ManagedWorktreeState::Removing,
                ManagedWorktreeState::Ready,
                now_ms()?,
            );
            return Err(error.into());
        }
        let archived = self.store.transition_worktree(
            &record.worktree_id,
            ManagedWorktreeState::Removing,
            ManagedWorktreeState::Archived,
            now_ms()?,
        )?;
        Ok(ArchiveOutcome::Archived(archived))
    }

    fn restore_blocking(&self, thread_id: &str) -> Result<RestoreOutcome, ManagedWorktreeError> {
        let Some(record) = self.store.worktree_for_thread(thread_id)? else {
            return Ok(RestoreOutcome::NotManaged);
        };
        require_state(&record, ManagedWorktreeState::Archived)?;
        let path = self.owned_path(&record)?;
        let common_dir = PathBuf::from(&record.repository_git_dir);
        self.store.transition_worktree(
            &record.worktree_id,
            ManagedWorktreeState::Archived,
            ManagedWorktreeState::Restoring,
            now_ms()?,
        )?;
        let checkout = match restore_attached_worktree(&common_dir, &path, &record.branch_name) {
            Ok(checkout) => checkout,
            Err(error) => {
                if !path.exists() {
                    let _ = self.store.transition_worktree(
                        &record.worktree_id,
                        ManagedWorktreeState::Restoring,
                        ManagedWorktreeState::Archived,
                        now_ms()?,
                    );
                }
                return Err(error.into());
            }
        };
        self.store.update_worktree_checkout(
            &record.worktree_id,
            &checkout.branch_name,
            &checkout.head_sha,
            now_ms()?,
        )?;
        let restored = self.store.transition_worktree(
            &record.worktree_id,
            ManagedWorktreeState::Restoring,
            ManagedWorktreeState::Ready,
            now_ms()?,
        )?;
        Ok(RestoreOutcome::Restored(restored))
    }

    #[cfg(test)]
    fn discard_unbound_blocking(&self, worktree_id: &str) -> Result<(), ManagedWorktreeError> {
        let Some(record) = self.store.worktree(worktree_id)? else {
            return Ok(());
        };
        if record.thread_id.is_some() {
            return Err(ManagedWorktreeError::UnownedPath(record.worktree_path));
        }
        let path = self.owned_path(&record)?;
        if path.exists() {
            remove_attached_worktree(
                &path,
                Path::new(&record.repository_git_dir),
                &record.branch_name,
            )?;
        }
        delete_created_branch_if_unchanged(&record)?;
        self.store.delete_worktree(worktree_id)?;
        Ok(())
    }

    #[cfg(test)]
    fn try_discard_after_create_failure(&self, worktree_id: &str) {
        if let Err(error) = self.discard_unbound_blocking(worktree_id) {
            eprintln!(
                "failed to clean up an incomplete managed worktree; preserving its ownership record for recovery: {error}"
            );
        }
    }

    fn recover_interrupted(&self) -> Result<(), ManagedWorktreeError> {
        for record in self.store.managed_worktrees()? {
            let path = self.owned_path(&record)?;
            match record.state {
                ManagedWorktreeState::Creating if record.thread_id.is_none() => {
                    if path.exists() {
                        remove_attached_worktree(
                            &path,
                            Path::new(&record.repository_git_dir),
                            &record.branch_name,
                        )?;
                    }
                    delete_created_branch_if_unchanged(&record)?;
                    self.store.delete_worktree(&record.worktree_id)?;
                }
                ManagedWorktreeState::Creating
                | ManagedWorktreeState::IsolatingClean
                | ManagedWorktreeState::HandingOff
                | ManagedWorktreeState::Transferring
                | ManagedWorktreeState::CleanRecoveryRequired
                | ManagedWorktreeState::HandoffRecoveryRequired
                | ManagedWorktreeState::RecoveryRequired
                    if record.thread_id.is_some() =>
                {
                    if let Err(error) = self.recover_owned_isolation(&record, &path) {
                        self.mark_recovery_required(&record.worktree_id);
                        eprintln!(
                            "managed worktree transfer {} requires recovery: {error}",
                            record.worktree_id
                        );
                    }
                }
                ManagedWorktreeState::Ready => match inspect_ready_worktree(&record) {
                    Ok(_) => self.try_delete_transfer_snapshot(&record),
                    Err(error) => eprintln!(
                        "managed worktree {} is unavailable: {error}",
                        record.worktree_id
                    ),
                },
                ManagedWorktreeState::Removing => {
                    let next = if !path.exists() {
                        ManagedWorktreeState::Archived
                    } else {
                        match inspect_ready_worktree(&record) {
                            Ok(checkout) => {
                                self.store.update_worktree_checkout(
                                    &record.worktree_id,
                                    &checkout.branch_name,
                                    &checkout.head_sha,
                                    now_ms()?,
                                )?;
                                ManagedWorktreeState::Ready
                            }
                            Err(error) => {
                                eprintln!(
                                    "managed worktree removal {} requires recovery: {error}",
                                    record.worktree_id
                                );
                                continue;
                            }
                        }
                    };
                    self.store.transition_worktree(
                        &record.worktree_id,
                        ManagedWorktreeState::Removing,
                        next,
                        now_ms()?,
                    )?;
                }
                ManagedWorktreeState::Restoring => {
                    let next = if path.exists() {
                        let checkout = match inspect_ready_worktree(&record) {
                            Ok(checkout) => checkout,
                            Err(error) => {
                                eprintln!(
                                    "managed worktree restoration {} requires recovery: {error}",
                                    record.worktree_id
                                );
                                continue;
                            }
                        };
                        self.store.update_worktree_checkout(
                            &record.worktree_id,
                            &checkout.branch_name,
                            &checkout.head_sha,
                            now_ms()?,
                        )?;
                        ManagedWorktreeState::Ready
                    } else {
                        ManagedWorktreeState::Archived
                    };
                    self.store.transition_worktree(
                        &record.worktree_id,
                        ManagedWorktreeState::Restoring,
                        next,
                        now_ms()?,
                    )?;
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn recover_owned_isolation(
        &self,
        record: &ManagedWorktree,
        path: &Path,
    ) -> Result<(), ManagedWorktreeError> {
        let mode = isolation_mode_for_state(record.state).ok_or_else(|| {
            TaskStoreError::InvalidManagedWorktreeState(record.state.as_str().to_string())
        })?;
        let active_state = isolation_active_state(mode);
        if record.state != active_state {
            self.store.transition_worktree(
                &record.worktree_id,
                record.state,
                active_state,
                now_ms()?,
            )?;
        }
        let transferred = recover_worktree_transfer(
            Path::new(&record.repository_git_dir),
            path,
            &record.branch_name,
            &record.head_sha,
            &record.worktree_id,
            mode,
        )?;
        let ready =
            self.finish_isolation(&record.worktree_id, active_state, &transferred.checkout)?;
        if let Some(warning) = transferred.source_warning {
            eprintln!(
                "managed worktree transfer {} recovered with a source checkout warning: {warning}",
                record.worktree_id
            );
        }
        self.try_delete_transfer_snapshot(&ready);
        Ok(())
    }

    fn owned_path(&self, record: &ManagedWorktree) -> Result<PathBuf, ManagedWorktreeError> {
        Uuid::parse_str(&record.worktree_id)
            .map_err(|_| ManagedWorktreeError::InvalidId(record.worktree_id.clone()))?;
        let expected = self.root.join(&record.worktree_id);
        if Path::new(&record.worktree_path) != expected {
            return Err(ManagedWorktreeError::UnownedPath(
                record.worktree_path.clone(),
            ));
        }
        match std::fs::symlink_metadata(&expected) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(ManagedWorktreeError::UnownedPath(
                    record.worktree_path.clone(),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(WorktreeError::Io(error).into()),
        }
        if resolve_prospective_path(&expected)? != expected {
            return Err(ManagedWorktreeError::UnownedPath(
                record.worktree_path.clone(),
            ));
        }
        Ok(expected)
    }
}

fn isolation_active_state(mode: WorktreeIsolationMode) -> ManagedWorktreeState {
    match mode {
        WorktreeIsolationMode::CreateClean => ManagedWorktreeState::IsolatingClean,
        WorktreeIsolationMode::HandoffClean => ManagedWorktreeState::HandingOff,
        WorktreeIsolationMode::TransferChanges => ManagedWorktreeState::Transferring,
    }
}

pub(super) fn inspect_ready_worktree(
    record: &ManagedWorktree,
) -> Result<WorktreeCheckout, WorktreeError> {
    inspect_attached_worktree(
        Path::new(&record.worktree_path),
        Path::new(&record.repository_git_dir),
        Some(&record.branch_name),
    )
}

fn isolation_recovery_state(mode: WorktreeIsolationMode) -> ManagedWorktreeState {
    match mode {
        WorktreeIsolationMode::CreateClean => ManagedWorktreeState::CleanRecoveryRequired,
        WorktreeIsolationMode::HandoffClean => ManagedWorktreeState::HandoffRecoveryRequired,
        WorktreeIsolationMode::TransferChanges => ManagedWorktreeState::RecoveryRequired,
    }
}

fn isolation_mode_for_state(state: ManagedWorktreeState) -> Option<WorktreeIsolationMode> {
    match state {
        ManagedWorktreeState::Creating
        | ManagedWorktreeState::Transferring
        | ManagedWorktreeState::RecoveryRequired => Some(WorktreeIsolationMode::TransferChanges),
        ManagedWorktreeState::IsolatingClean | ManagedWorktreeState::CleanRecoveryRequired => {
            Some(WorktreeIsolationMode::CreateClean)
        }
        ManagedWorktreeState::HandingOff | ManagedWorktreeState::HandoffRecoveryRequired => {
            Some(WorktreeIsolationMode::HandoffClean)
        }
        _ => None,
    }
}

fn isolation_recovery_mode(state: ManagedWorktreeState) -> Option<WorktreeIsolationMode> {
    match state {
        ManagedWorktreeState::RecoveryRequired => Some(WorktreeIsolationMode::TransferChanges),
        ManagedWorktreeState::CleanRecoveryRequired => Some(WorktreeIsolationMode::CreateClean),
        ManagedWorktreeState::HandoffRecoveryRequired => Some(WorktreeIsolationMode::HandoffClean),
        _ => None,
    }
}

fn delete_created_branch_if_unchanged(
    record: &ManagedWorktree,
) -> Result<(), ManagedWorktreeError> {
    match delete_local_branch_if_matches(
        Path::new(&record.repository_git_dir),
        &record.branch_name,
        &record.head_sha,
    ) {
        Ok(_) | Err(WorktreeError::BranchHeadMismatch { .. }) => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn require_state(
    record: &ManagedWorktree,
    expected: ManagedWorktreeState,
) -> Result<(), ManagedWorktreeError> {
    if record.state == expected {
        Ok(())
    } else {
        Err(TaskStoreError::ManagedWorktreeStateConflict {
            worktree_id: record.worktree_id.clone(),
            actual: record.state.as_str().to_string(),
            expected: expected.as_str().to_string(),
        }
        .into())
    }
}

fn automatic_branch_name(task_name: &str, worktree_id: &str) -> String {
    let mut slug = task_name
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|segment| !segment.is_empty())
        .take(6)
        .collect::<Vec<_>>()
        .join("-");
    slug.truncate(48);
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "task" } else { slug };
    format!("caffold/{slug}-{}", &worktree_id[..8])
}

fn now_ms() -> Result<u64, ManagedWorktreeError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ManagedWorktreeError::Clock)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

fn path_text(path: &Path) -> Result<&str, ManagedWorktreeError> {
    path.to_str()
        .ok_or_else(|| ManagedWorktreeError::UnownedPath(path.display().to_string()))
}

fn resolve_prospective_path(path: &Path) -> Result<PathBuf, ManagedWorktreeError> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| ManagedWorktreeError::RootUnavailable(error.to_string()))?
            .join(path)
    };
    let mut existing = absolute.as_path();
    let mut suffix = Vec::new();
    while !existing.exists() {
        let component = existing
            .file_name()
            .ok_or_else(|| ManagedWorktreeError::RootUnavailable(absolute.display().to_string()))?;
        suffix.push(component.to_os_string());
        existing = existing
            .parent()
            .ok_or_else(|| ManagedWorktreeError::RootUnavailable(absolute.display().to_string()))?;
    }
    let mut resolved = existing.canonicalize().map_err(|error| {
        ManagedWorktreeError::RootUnavailable(format!("{}: {error}", existing.display()))
    })?;
    for component in suffix.iter().rev() {
        resolved.push(component);
    }
    Ok(normalize_absolute_path(&resolved))
}

fn normalize_absolute_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use super::*;

    #[tokio::test]
    async fn owns_create_archive_and_restore_lifecycle() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees =
            ManagedWorktrees::new(fs, store.clone(), temp.path().join("managed")).unwrap();

        let created = worktrees
            .create(source, "Review branch".to_string(), None, None)
            .await
            .unwrap();
        assert_eq!(created.state, ManagedWorktreeState::Ready);
        assert!(created.branch_name.starts_with("caffold/review-branch-"));
        assert!(Path::new(&created.worktree_path).is_dir());
        worktrees
            .bind_thread(created.worktree_id.clone(), "thread-1".to_string())
            .await
            .unwrap();

        assert!(matches!(
            worktrees
                .archive_for_thread("thread-1".to_string())
                .await
                .unwrap(),
            ArchiveOutcome::Archived(ManagedWorktree {
                state: ManagedWorktreeState::Archived,
                ..
            })
        ));
        assert!(!Path::new(&created.worktree_path).exists());

        assert!(matches!(
            worktrees
                .restore_for_thread("thread-1".to_string())
                .await
                .unwrap(),
            RestoreOutcome::Restored(ManagedWorktree {
                state: ManagedWorktreeState::Ready,
                ..
            })
        ));
        assert!(Path::new(&created.worktree_path).is_dir());
    }

    #[tokio::test]
    async fn clean_isolation_leaves_default_branch_dirty_state_in_the_source() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        fs::write(source.join("README.md"), "unstaged\n").unwrap();
        fs::write(source.join("staged.txt"), "staged\n").unwrap();
        git(&source, &["add", "staged.txt"]);
        fs::write(source.join("untracked.txt"), "untracked\n").unwrap();
        let source_status = git_output(&source, &["status", "--porcelain=v1"]);

        let store = TaskStore::memory().unwrap();
        let worktrees = ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store,
            temp.path().join("managed"),
        )
        .unwrap();
        let IsolateOutcome::Isolated { worktree, .. } = worktrees
            .isolate_current(
                source.clone(),
                "thread-clean".to_string(),
                "Clean review".to_string(),
                None,
                false,
            )
            .await
            .unwrap()
        else {
            panic!("clean isolation should create a managed worktree");
        };

        let target = Path::new(&worktree.worktree_path);
        assert_eq!(git_output(&source, &["branch", "--show-current"]), "main");
        assert_eq!(
            git_output(&source, &["status", "--porcelain=v1"]),
            source_status
        );
        assert_eq!(git_output(target, &["status", "--porcelain=v1"]), "");
        assert!(!target.join("staged.txt").exists());
        assert!(!target.join("untracked.txt").exists());
        assert!(
            !git_output(&source, &["show-ref"])
                .contains(&format!("refs/caffold/transfers/{}", worktree.worktree_id))
        );
    }

    #[tokio::test]
    async fn dirty_non_default_branch_requires_explicit_change_transfer() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        git(&source, &["switch", "-c", "review/pr-42"]);
        fs::write(source.join("review.txt"), "keep here\n").unwrap();
        let store = TaskStore::memory().unwrap();
        let worktrees = ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            temp.path().join("managed"),
        )
        .unwrap();

        let error = worktrees
            .isolate_current(
                source.clone(),
                "thread-dirty-feature".to_string(),
                "PR review".to_string(),
                None,
                false,
            )
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            ManagedWorktreeError::Git(WorktreeError::DirtyBranchRequiresTransfer { branch })
                if branch == "review/pr-42"
        ));
        assert!(store.managed_worktrees().unwrap().is_empty());
        assert_eq!(
            git_output(&source, &["branch", "--show-current"]),
            "review/pr-42"
        );
        assert_eq!(
            git_output(&source, &["status", "--porcelain=v1"]),
            "?? review.txt"
        );
    }

    #[tokio::test]
    async fn clean_non_default_branch_is_handed_off_without_change_transfer() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        git(&source, &["switch", "-c", "review/pr-42"]);
        let worktrees = ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            TaskStore::memory().unwrap(),
            temp.path().join("managed"),
        )
        .unwrap();

        let IsolateOutcome::Isolated { worktree, .. } = worktrees
            .isolate_current(
                source.clone(),
                "thread-clean-feature".to_string(),
                "PR review".to_string(),
                None,
                false,
            )
            .await
            .unwrap()
        else {
            panic!("clean feature branch should be handed off");
        };
        assert_eq!(worktree.branch_name, "review/pr-42");
        assert_eq!(git_output(&source, &["branch", "--show-current"]), "main");
        assert_eq!(
            git_output(
                Path::new(&worktree.worktree_path),
                &["branch", "--show-current"]
            ),
            "review/pr-42"
        );
        assert_eq!(
            git_output(
                Path::new(&worktree.worktree_path),
                &["status", "--porcelain=v1"]
            ),
            ""
        );
    }

    #[tokio::test]
    async fn explicit_change_transfer_preserves_default_branch_dirty_state() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        fs::write(source.join(".gitignore"), "ignored.txt\n").unwrap();
        git(&source, &["add", ".gitignore"]);
        git(&source, &["commit", "-m", "Ignore build output"]);
        fs::write(source.join("README.md"), "unstaged\n").unwrap();
        fs::write(source.join("staged.txt"), "staged\n").unwrap();
        git(&source, &["add", "staged.txt"]);
        fs::write(source.join("untracked.txt"), "untracked\n").unwrap();
        fs::write(source.join("ignored.txt"), "keep in source\n").unwrap();

        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees =
            ManagedWorktrees::new(fs, store.clone(), temp.path().join("managed")).unwrap();

        let isolated = worktrees
            .isolate_current(
                source.clone(),
                "thread-1".to_string(),
                "Review issue 42".to_string(),
                None,
                true,
            )
            .await
            .unwrap();
        let IsolateOutcome::Isolated { worktree, .. } = isolated else {
            panic!("first isolation should create a managed worktree");
        };
        let target = Path::new(&worktree.worktree_path);
        assert_eq!(worktree.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(worktree.state, ManagedWorktreeState::Ready);
        assert!(worktree.branch_name.starts_with("caffold/review-issue-42-"));
        assert_eq!(git_output(&source, &["branch", "--show-current"]), "main");
        assert_eq!(git_output(&source, &["status", "--porcelain=v1"]), "");
        assert!(source.join("ignored.txt").exists());
        assert_eq!(
            git_output(target, &["status", "--porcelain=v1"]),
            "M README.md\nA  staged.txt\n?? untracked.txt"
        );
        assert_eq!(
            git_output(target, &["diff", "--cached", "--name-only"]),
            "staged.txt"
        );
        assert_eq!(git_output(target, &["diff", "--name-only"]), "README.md");
        assert!(!target.join("ignored.txt").exists());
        assert!(
            !git_output(&source, &["show-ref"])
                .contains(&format!("refs/caffold/transfers/{}", worktree.worktree_id))
        );

        assert!(matches!(
            worktrees
                .isolate_current(
                    source,
                    "thread-1".to_string(),
                    "Review issue 42".to_string(),
                    None,
                    true,
                )
                .await
                .unwrap(),
            IsolateOutcome::AlreadyReady(ManagedWorktree {
                state: ManagedWorktreeState::Ready,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn hands_off_a_non_default_branch_without_renaming_it() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        git(&source, &["switch", "-c", "review/pr-42"]);
        fs::write(source.join("review.txt"), "dirty review\n").unwrap();
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees = ManagedWorktrees::new(fs, store, temp.path().join("managed")).unwrap();

        let IsolateOutcome::Isolated { worktree, .. } = worktrees
            .isolate_current(
                source.clone(),
                "thread-1".to_string(),
                "PR review".to_string(),
                None,
                true,
            )
            .await
            .unwrap()
        else {
            panic!("first isolation should create a managed worktree");
        };

        assert_eq!(worktree.branch_name, "review/pr-42");
        assert_eq!(git_output(&source, &["branch", "--show-current"]), "main");
        assert_eq!(
            git_output(
                Path::new(&worktree.worktree_path),
                &["branch", "--show-current"]
            ),
            "review/pr-42"
        );
        assert_eq!(
            git_output(
                Path::new(&worktree.worktree_path),
                &["status", "--porcelain=v1"]
            ),
            "?? review.txt"
        );
    }

    #[tokio::test]
    async fn creates_a_requested_branch_from_detached_head() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        git(&source, &["switch", "--detach", "HEAD"]);
        fs::write(source.join("detached.txt"), "detached dirty state\n").unwrap();
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees = ManagedWorktrees::new(fs, store, temp.path().join("managed")).unwrap();

        let IsolateOutcome::Isolated { worktree, .. } = worktrees
            .isolate_current(
                source.clone(),
                "thread-1".to_string(),
                "Detached review".to_string(),
                Some("review/detached".to_string()),
                true,
            )
            .await
            .unwrap()
        else {
            panic!("first isolation should create a managed worktree");
        };

        assert_eq!(worktree.branch_name, "review/detached");
        assert_eq!(
            git_output(
                Path::new(&worktree.worktree_path),
                &["branch", "--show-current"]
            ),
            "review/detached"
        );
        assert_eq!(
            git_output(
                Path::new(&worktree.worktree_path),
                &["status", "--porcelain=v1"]
            ),
            "?? detached.txt"
        );
    }

    #[test]
    fn startup_recovers_clean_isolation_without_moving_new_source_changes() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        fs::write(source.join("README.md"), "new source edit\n").unwrap();
        fs::write(source.join("untracked.txt"), "stay in source\n").unwrap();
        let source_status = git_output(&source, &["status", "--porcelain=v1"]);
        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-clean-recovery".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: "caffold/recovered-clean".to_string(),
                head_sha: repository.head_sha,
                state: ManagedWorktreeState::IsolatingClean,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        assert_eq!(
            store.worktree(&worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::Ready
        );
        assert_eq!(
            git_output(&source, &["status", "--porcelain=v1"]),
            source_status
        );
        assert_eq!(git_output(&source, &["branch", "--show-current"]), "main");
        assert_eq!(
            git_output(&worktree_path, &["status", "--porcelain=v1"]),
            ""
        );
        assert!(!worktree_path.join("untracked.txt").exists());
        assert!(
            !git_output(&source, &["show-ref"])
                .contains(&format!("refs/caffold/transfers/{worktree_id}"))
        );
    }

    #[test]
    fn startup_preserves_a_dirty_clean_isolation_target_for_recovery() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        let checkout = crate::git::create_attached_worktree(
            &source,
            &worktree_path,
            "caffold/recovered-clean",
            None,
        )
        .unwrap();
        fs::write(worktree_path.join("keep.txt"), "do not reset\n").unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-clean-recovery".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: checkout.branch_name,
                head_sha: checkout.head_sha,
                state: ManagedWorktreeState::IsolatingClean,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        assert_eq!(
            store.worktree(&worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::CleanRecoveryRequired
        );
        assert_eq!(
            fs::read_to_string(worktree_path.join("keep.txt")).unwrap(),
            "do not reset\n"
        );
    }

    #[test]
    fn startup_recovers_a_clean_feature_branch_handoff() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        git(&source, &["switch", "-c", "review/recover-clean"]);
        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-clean-handoff".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: "review/recover-clean".to_string(),
                head_sha: repository.head_sha,
                state: ManagedWorktreeState::HandingOff,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        assert_eq!(
            store.worktree(&worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::Ready
        );
        assert_eq!(git_output(&source, &["branch", "--show-current"]), "main");
        assert_eq!(
            git_output(&worktree_path, &["branch", "--show-current"]),
            "review/recover-clean"
        );
        assert_eq!(
            git_output(&worktree_path, &["status", "--porcelain=v1"]),
            ""
        );
    }

    #[test]
    fn startup_recovers_a_snapshot_created_before_the_target_worktree() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        fs::write(source.join("README.md"), "recover me\n").unwrap();
        fs::write(source.join("untracked.txt"), "also recover me\n").unwrap();
        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: "caffold/recovered".to_string(),
                head_sha: repository.head_sha,
                state: ManagedWorktreeState::Transferring,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();
        git(
            &source,
            &[
                "stash",
                "push",
                "--include-untracked",
                "-m",
                &format!("caffold-transfer:{worktree_id}"),
            ],
        );

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        let recovered = store.worktree(&worktree_id).unwrap().unwrap();
        assert_eq!(recovered.state, ManagedWorktreeState::Ready);
        assert_eq!(
            git_output(&worktree_path, &["status", "--porcelain=v1"]),
            "M README.md\n?? untracked.txt"
        );
        assert_eq!(
            git_output(&worktree_path, &["diff", "--name-only"]),
            "README.md"
        );
        assert_eq!(
            fs::read_to_string(worktree_path.join("README.md")).unwrap(),
            "recover me\n"
        );
    }

    #[test]
    fn startup_preserves_a_dirty_transfer_target_and_its_protected_snapshot() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        fs::write(source.join("README.md"), "recover existing target\n").unwrap();
        fs::write(source.join("staged.txt"), "keep staged\n").unwrap();
        git(&source, &["add", "staged.txt"]);

        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        protect_transfer_snapshot(&source, &worktree_id);
        let checkout = crate::git::create_attached_worktree(
            &source,
            &worktree_path,
            "caffold/recovered-existing",
            None,
        )
        .unwrap();
        fs::write(
            worktree_path.join("partial.txt"),
            "discard partial mutation\n",
        )
        .unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: checkout.branch_name,
                head_sha: checkout.head_sha,
                state: ManagedWorktreeState::Transferring,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root.clone(),
        )
        .unwrap();

        assert_eq!(
            store.worktree(&worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::RecoveryRequired
        );
        assert!(worktree_path.join("partial.txt").exists());
        assert_eq!(
            git_output(&worktree_path, &["status", "--porcelain=v1"]),
            "?? partial.txt"
        );
        assert!(
            git_output(&source, &["show-ref"])
                .contains(&format!("refs/caffold/transfers/{worktree_id}"))
        );

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        assert_eq!(
            store.worktree(&worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::RecoveryRequired
        );
        assert_eq!(
            fs::read_to_string(worktree_path.join("partial.txt")).unwrap(),
            "discard partial mutation\n"
        );
        assert!(
            git_output(&source, &["show-ref"])
                .contains(&format!("refs/caffold/transfers/{worktree_id}"))
        );
    }

    #[test]
    fn startup_hands_off_a_snapshotted_feature_branch_before_creating_the_target() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "-M", "main"]);
        git(&source, &["switch", "-c", "review/pr-77"]);
        fs::write(source.join("review.txt"), "recover feature review\n").unwrap();

        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        protect_transfer_snapshot(&source, &worktree_id);
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: "review/pr-77".to_string(),
                head_sha: repository.head_sha,
                state: ManagedWorktreeState::Transferring,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        assert_eq!(
            store.worktree(&worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::Ready
        );
        assert_eq!(git_output(&source, &["branch", "--show-current"]), "main");
        assert_eq!(
            git_output(&worktree_path, &["branch", "--show-current"]),
            "review/pr-77"
        );
        assert_eq!(
            git_output(&worktree_path, &["status", "--porcelain=v1"]),
            "?? review.txt"
        );
    }

    #[test]
    fn startup_preserves_an_uncertain_target_and_marks_recovery_required() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        let checkout = crate::git::create_attached_worktree(
            &source,
            &worktree_path,
            "caffold/uncertain",
            None,
        )
        .unwrap();
        fs::write(worktree_path.join("uncertain.txt"), "do not delete\n").unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: checkout.branch_name,
                head_sha: checkout.head_sha,
                state: ManagedWorktreeState::Transferring,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        let preserved = store.worktree(&worktree_id).unwrap().unwrap();
        assert_eq!(preserved.state, ManagedWorktreeState::RecoveryRequired);
        assert_eq!(
            fs::read_to_string(worktree_path.join("uncertain.txt")).unwrap(),
            "do not delete\n"
        );
    }

    #[tokio::test]
    async fn reports_unmanaged_worktrees_without_mutating_the_store() {
        let temp = tempfile::tempdir().unwrap();
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees =
            ManagedWorktrees::new(fs, store.clone(), temp.path().join("managed")).unwrap();

        assert_eq!(
            worktrees
                .archive_for_thread("missing".to_string())
                .await
                .unwrap(),
            ArchiveOutcome::NotManaged
        );
        assert_eq!(
            worktrees
                .restore_for_thread("missing".to_string())
                .await
                .unwrap(),
            RestoreOutcome::NotManaged
        );
        worktrees
            .discard_unbound("missing".to_string())
            .await
            .unwrap();
        assert!(store.managed_worktrees().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refuses_to_discard_a_bound_worktree() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees =
            ManagedWorktrees::new(fs, store.clone(), temp.path().join("managed")).unwrap();
        let created = worktrees
            .create(source, "Bound task".to_string(), None, None)
            .await
            .unwrap();
        worktrees
            .bind_thread(created.worktree_id.clone(), "thread-1".to_string())
            .await
            .unwrap();

        assert!(matches!(
            worktrees
                .discard_unbound(created.worktree_id.clone())
                .await,
            Err(ManagedWorktreeError::UnownedPath(path)) if path == created.worktree_path
        ));
        assert!(Path::new(&created.worktree_path).exists());
        assert_eq!(
            store
                .worktree(&created.worktree_id)
                .unwrap()
                .unwrap()
                .thread_id
                .as_deref(),
            Some("thread-1")
        );
    }

    #[tokio::test]
    async fn rejected_existing_branch_is_never_treated_as_caffold_owned() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        git(&source, &["branch", "shared/review"]);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        let worktrees = ManagedWorktrees::new(fs, store.clone(), managed_root.clone()).unwrap();

        assert!(matches!(
            worktrees
                .create(
                    source.clone(),
                    "Existing branch".to_string(),
                    Some("shared/review".to_string()),
                    None,
                )
                .await,
            Err(ManagedWorktreeError::Git(
                WorktreeError::BranchAlreadyExists(branch)
            )) if branch == "shared/review"
        ));
        assert_eq!(
            git_output(&source, &["branch", "--list", "shared/review"]),
            "shared/review"
        );
        assert!(store.managed_worktrees().unwrap().is_empty());
        assert_eq!(fs::read_dir(managed_root).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn discarding_an_unbound_worktree_preserves_an_advanced_branch() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees =
            ManagedWorktrees::new(fs, store.clone(), temp.path().join("managed")).unwrap();
        let created = worktrees
            .create(source.clone(), "Advanced branch".to_string(), None, None)
            .await
            .unwrap();
        let worktree_path = Path::new(&created.worktree_path);
        fs::write(worktree_path.join("README.md"), "advanced\n").unwrap();
        git(worktree_path, &["commit", "-am", "Advance managed branch"]);
        let advanced_head = git_output(worktree_path, &["rev-parse", "HEAD"]);
        assert_ne!(advanced_head, created.head_sha);

        worktrees
            .discard_unbound(created.worktree_id.clone())
            .await
            .unwrap();

        assert!(store.worktree(&created.worktree_id).unwrap().is_none());
        assert!(!worktree_path.exists());
        assert_eq!(
            git_output(&source, &["rev-parse", &created.branch_name]),
            advanced_head
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn archive_rejects_a_symlinked_owned_slot_without_removing_its_target() {
        use std::os::unix::fs::symlink;

        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        let worktrees = ManagedWorktrees::new(fs, store.clone(), managed_root.clone()).unwrap();
        let external_path = temp.path().join("external-worktree");
        let branch_name = "caffold/external";
        let checkout =
            crate::git::create_attached_worktree(&source, &external_path, branch_name, None)
                .unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let owned_slot = managed_root.canonicalize().unwrap().join(&worktree_id);
        symlink(&external_path, &owned_slot).unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: checkout.common_dir.display().to_string(),
                worktree_path: owned_slot.display().to_string(),
                branch_name: branch_name.to_string(),
                head_sha: checkout.head_sha.clone(),
                state: ManagedWorktreeState::Ready,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        assert!(matches!(
            worktrees.archive_for_thread("thread-1".to_string()).await,
            Err(ManagedWorktreeError::UnownedPath(path))
                if path == owned_slot.display().to_string()
        ));
        assert!(external_path.is_dir());
        assert_eq!(
            git_output(&external_path, &["rev-parse", "HEAD"]),
            checkout.head_sha
        );
        assert_eq!(
            store.worktree(&worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::Ready
        );
    }

    #[tokio::test]
    async fn dirty_worktree_blocks_archive_without_changing_ownership() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees =
            ManagedWorktrees::new(fs, store.clone(), temp.path().join("managed")).unwrap();
        let created = worktrees
            .create(source, "Dirty task".to_string(), None, None)
            .await
            .unwrap();
        worktrees
            .bind_thread(created.worktree_id.clone(), "thread-1".to_string())
            .await
            .unwrap();
        fs::write(
            Path::new(&created.worktree_path).join("dirty.txt"),
            "dirty\n",
        )
        .unwrap();

        assert!(matches!(
            worktrees.archive_for_thread("thread-1".to_string()).await,
            Err(ManagedWorktreeError::Git(WorktreeError::Dirty(_)))
        ));
        assert_eq!(
            store.worktree(&created.worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::Ready
        );
        assert!(Path::new(&created.worktree_path).exists());
    }

    #[tokio::test]
    async fn failed_restore_returns_the_record_to_archived_when_no_path_was_created() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees =
            ManagedWorktrees::new(fs, store.clone(), temp.path().join("managed")).unwrap();
        let created = worktrees
            .create(source.clone(), "Missing branch".to_string(), None, None)
            .await
            .unwrap();
        worktrees
            .bind_thread(created.worktree_id.clone(), "thread-1".to_string())
            .await
            .unwrap();
        worktrees
            .archive_for_thread("thread-1".to_string())
            .await
            .unwrap();
        git(&source, &["branch", "-D", &created.branch_name]);

        assert!(matches!(
            worktrees.restore_for_thread("thread-1".to_string()).await,
            Err(ManagedWorktreeError::Git(WorktreeError::Command {
                operation: "worktree restoration",
                ..
            }))
        ));
        assert_eq!(
            store.worktree(&created.worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::Archived
        );
        assert!(!Path::new(&created.worktree_path).exists());
    }

    #[tokio::test]
    async fn startup_recovers_interrupted_states_from_owned_paths() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        let worktrees =
            ManagedWorktrees::new(fs.clone(), store.clone(), managed_root.clone()).unwrap();
        let canonical_managed_root = managed_root.canonicalize().unwrap();

        let repository = crate::git::managed_repository(&source).unwrap();
        let creating_id = Uuid::new_v4().to_string();
        let creating_path = canonical_managed_root.join(&creating_id);
        let creating_branch = "caffold/interrupted-create";
        let creating_checkout =
            crate::git::create_attached_worktree(&source, &creating_path, creating_branch, None)
                .unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: creating_id.clone(),
                thread_id: None,
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: creating_path.display().to_string(),
                branch_name: creating_branch.to_string(),
                head_sha: creating_checkout.head_sha,
                state: ManagedWorktreeState::Creating,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        let removing = worktrees
            .create(source.clone(), "Interrupted remove".to_string(), None, None)
            .await
            .unwrap();
        store
            .transition_worktree(
                &removing.worktree_id,
                ManagedWorktreeState::Ready,
                ManagedWorktreeState::Removing,
                200,
            )
            .unwrap();
        crate::git::remove_attached_worktree(
            Path::new(&removing.worktree_path),
            Path::new(&removing.repository_git_dir),
            &removing.branch_name,
        )
        .unwrap();

        let restoring = worktrees
            .create(
                source.clone(),
                "Interrupted restore".to_string(),
                None,
                None,
            )
            .await
            .unwrap();
        store
            .transition_worktree(
                &restoring.worktree_id,
                ManagedWorktreeState::Ready,
                ManagedWorktreeState::Removing,
                300,
            )
            .unwrap();
        crate::git::remove_attached_worktree(
            Path::new(&restoring.worktree_path),
            Path::new(&restoring.repository_git_dir),
            &restoring.branch_name,
        )
        .unwrap();
        store
            .transition_worktree(
                &restoring.worktree_id,
                ManagedWorktreeState::Removing,
                ManagedWorktreeState::Archived,
                310,
            )
            .unwrap();
        store
            .transition_worktree(
                &restoring.worktree_id,
                ManagedWorktreeState::Archived,
                ManagedWorktreeState::Restoring,
                320,
            )
            .unwrap();
        crate::git::restore_attached_worktree(
            Path::new(&restoring.repository_git_dir),
            Path::new(&restoring.worktree_path),
            &restoring.branch_name,
        )
        .unwrap();

        drop(worktrees);
        ManagedWorktrees::new(fs, store.clone(), managed_root).unwrap();

        assert!(store.worktree(&creating_id).unwrap().is_none());
        assert!(!creating_path.exists());
        assert_eq!(
            git_output(&source, &["branch", "--list", creating_branch]),
            ""
        );
        assert_eq!(
            store
                .worktree(&removing.worktree_id)
                .unwrap()
                .unwrap()
                .state,
            ManagedWorktreeState::Archived
        );
        assert!(!Path::new(&removing.worktree_path).exists());
        assert_eq!(
            store
                .worktree(&restoring.worktree_id)
                .unwrap()
                .unwrap()
                .state,
            ManagedWorktreeState::Ready
        );
        assert!(Path::new(&restoring.worktree_path).exists());
    }

    #[tokio::test]
    async fn startup_recovers_when_the_filesystem_mutation_did_not_happen() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        let worktrees =
            ManagedWorktrees::new(fs.clone(), store.clone(), managed_root.clone()).unwrap();

        let removing = worktrees
            .create(
                source.clone(),
                "Removal did not happen".to_string(),
                None,
                None,
            )
            .await
            .unwrap();
        store
            .transition_worktree(
                &removing.worktree_id,
                ManagedWorktreeState::Ready,
                ManagedWorktreeState::Removing,
                200,
            )
            .unwrap();

        let restoring = worktrees
            .create(source, "Restore did not happen".to_string(), None, None)
            .await
            .unwrap();
        store
            .transition_worktree(
                &restoring.worktree_id,
                ManagedWorktreeState::Ready,
                ManagedWorktreeState::Removing,
                300,
            )
            .unwrap();
        crate::git::remove_attached_worktree(
            Path::new(&restoring.worktree_path),
            Path::new(&restoring.repository_git_dir),
            &restoring.branch_name,
        )
        .unwrap();
        store
            .transition_worktree(
                &restoring.worktree_id,
                ManagedWorktreeState::Removing,
                ManagedWorktreeState::Archived,
                310,
            )
            .unwrap();
        store
            .transition_worktree(
                &restoring.worktree_id,
                ManagedWorktreeState::Archived,
                ManagedWorktreeState::Restoring,
                320,
            )
            .unwrap();
        drop(worktrees);

        ManagedWorktrees::new(fs, store.clone(), managed_root).unwrap();

        assert!(Path::new(&removing.worktree_path).exists());
        assert_eq!(
            store
                .worktree(&removing.worktree_id)
                .unwrap()
                .unwrap()
                .state,
            ManagedWorktreeState::Ready
        );
        assert!(!Path::new(&restoring.worktree_path).exists());
        assert_eq!(
            store
                .worktree(&restoring.worktree_id)
                .unwrap()
                .unwrap()
                .state,
            ManagedWorktreeState::Archived
        );
    }

    #[test]
    fn startup_keeps_an_unavailable_ready_record_without_failing() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-missing-ready".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: "caffold/missing-ready".to_string(),
                head_sha: repository.head_sha,
                state: ManagedWorktreeState::Ready,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        let record = store.worktree(&worktree_id).unwrap().unwrap();
        assert_eq!(record.state, ManagedWorktreeState::Ready);
        assert!(matches!(
            inspect_ready_worktree(&record),
            Err(WorktreeError::TargetMissing(path)) if path == worktree_path.display().to_string()
        ));
    }

    #[test]
    fn startup_preserves_a_mismatched_restoring_record_without_failing() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let repository = crate::git::managed_repository(&source).unwrap();
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let managed_root = managed_root.canonicalize().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = managed_root.join(&worktree_id);
        fs::create_dir(&worktree_path).unwrap();
        fs::write(worktree_path.join("keep.txt"), "external state\n").unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-restoring".to_string()),
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: "caffold/restoring".to_string(),
                head_sha: repository.head_sha,
                state: ManagedWorktreeState::Restoring,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store.clone(),
            managed_root,
        )
        .unwrap();

        assert_eq!(
            store.worktree(&worktree_id).unwrap().unwrap().state,
            ManagedWorktreeState::Restoring
        );
        assert_eq!(
            fs::read_to_string(worktree_path.join("keep.txt")).unwrap(),
            "external state\n"
        );
    }

    #[test]
    fn startup_recovery_preserves_a_branch_advanced_after_its_creation_record() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        fs::create_dir(&source).unwrap();
        initialize_repository(&source);
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let canonical_managed_root = managed_root.canonicalize().unwrap();
        let repository = crate::git::managed_repository(&source).unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        let worktree_path = canonical_managed_root.join(&worktree_id);
        let branch_name = "caffold/interrupted-advanced";
        let created =
            crate::git::create_attached_worktree(&source, &worktree_path, branch_name, None)
                .unwrap();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: None,
                repository_git_dir: repository.common_dir.display().to_string(),
                worktree_path: worktree_path.display().to_string(),
                branch_name: branch_name.to_string(),
                head_sha: created.head_sha,
                state: ManagedWorktreeState::Creating,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();
        fs::write(worktree_path.join("README.md"), "advanced\n").unwrap();
        git(
            &worktree_path,
            &["commit", "-am", "Advance before recovery"],
        );
        let advanced_head = git_output(&worktree_path, &["rev-parse", "HEAD"]);

        ManagedWorktrees::new(fs, store.clone(), managed_root).unwrap();

        assert!(store.worktree(&worktree_id).unwrap().is_none());
        assert!(!worktree_path.exists());
        assert_eq!(
            git_output(&source, &["rev-parse", branch_name]),
            advanced_head
        );
    }

    #[test]
    fn root_must_be_inside_the_browsing_boundary() {
        let browse = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let fs = Arc::new(RootedFs::new(browse.path()).unwrap());
        let managed = outside.path().join("managed");
        assert!(matches!(
            ManagedWorktrees::new(fs, TaskStore::memory().unwrap(), managed.clone()),
            Err(ManagedWorktreeError::Fs(FsError::PathEscapesRoot))
        ));
        assert!(!managed.exists());
    }

    #[test]
    fn startup_rejects_a_record_that_claims_a_path_outside_its_owned_slot() {
        let temp = tempfile::tempdir().unwrap();
        let managed_root = temp.path().join("managed");
        fs::create_dir(&managed_root).unwrap();
        let store = TaskStore::memory().unwrap();
        let worktree_id = Uuid::new_v4().to_string();
        store
            .create_worktree(ManagedWorktree {
                worktree_id: worktree_id.clone(),
                thread_id: Some("thread-1".to_string()),
                repository_git_dir: temp.path().join("repository/.git").display().to_string(),
                worktree_path: temp.path().join("not-owned").display().to_string(),
                branch_name: "caffold/not-owned".to_string(),
                head_sha: "deadbeef".to_string(),
                state: ManagedWorktreeState::Ready,
                created_at_ms: 100,
                updated_at_ms: 100,
            })
            .unwrap();

        let result = ManagedWorktrees::new(
            Arc::new(RootedFs::new(temp.path()).unwrap()),
            store,
            managed_root,
        );

        assert!(matches!(
            result,
            Err(ManagedWorktreeError::UnownedPath(path))
                if path == temp.path().join("not-owned").display().to_string()
        ));
    }

    #[test]
    fn automatic_names_are_readable_and_scoped() {
        assert_eq!(
            automatic_branch_name("Review PR #42", "12345678-aaaa-bbbb-cccc-123456789000"),
            "caffold/review-pr-42-12345678"
        );
        assert_eq!(
            automatic_branch_name("한글 작업", "12345678-aaaa-bbbb-cccc-123456789000"),
            "caffold/task-12345678"
        );
        let long = automatic_branch_name(
            "This name has a deliberately extraordinarily long first segment",
            "12345678-aaaa-bbbb-cccc-123456789000",
        );
        assert!(long.len() <= "caffold/".len() + 48 + 1 + 8);
        assert!(long.ends_with("-12345678"));
    }

    #[test]
    fn normalizes_dot_segments_in_owned_paths() {
        assert_eq!(
            normalize_absolute_path(Path::new("/managed/./one/../two")),
            PathBuf::from("/managed/two")
        );
    }

    fn initialize_repository(path: &Path) {
        git(path, &["init"]);
        git(path, &["config", "user.email", "test@example.com"]);
        git(path, &["config", "user.name", "Caffold Test"]);
        fs::write(path.join("README.md"), "initial\n").unwrap();
        git(path, &["add", "README.md"]);
        git(path, &["commit", "-m", "Initial"]);
    }

    fn protect_transfer_snapshot(source: &Path, worktree_id: &str) {
        git(
            source,
            &[
                "stash",
                "push",
                "--include-untracked",
                "-m",
                &format!("caffold-transfer:{worktree_id}"),
            ],
        );
        let snapshot = git_output(source, &["rev-parse", "--verify", "refs/stash"]);
        git(
            source,
            &[
                "update-ref",
                &format!("refs/caffold/transfers/{worktree_id}"),
                &snapshot,
            ],
        );
        git(source, &["stash", "drop", "stash@{0}"]);
    }

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output(path: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn git_is_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}
