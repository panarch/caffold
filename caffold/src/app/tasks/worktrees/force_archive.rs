//! Explicitly discard the files in an owned checkout while retaining its Task.
//! Git metadata cleanup is best-effort when the original repository is gone.
use super::{
    ArchiveOutcome, CheckoutAnchor, ManagedWorktree, ManagedWorktreeError, ManagedWorktreeState,
    ManagedWorktrees, WorktreeError, inspect_ready_worktree, now_ms, remove_worktree_admin_entries,
    worktree_admin_entries,
};
use std::{fs, io::ErrorKind, path::Path};

impl ManagedWorktrees {
    pub(in crate::app::tasks) async fn preflight_force_archive(
        &self,
        thread_id: String,
        expected_id: String,
    ) -> Result<ManagedWorktree, ManagedWorktreeError> {
        let worktrees = self.clone();
        tokio::task::spawn_blocking(move || {
            worktrees.force_archive_record(&thread_id, &expected_id)
        })
        .await
        .map_err(|error| ManagedWorktreeError::Worker(error.to_string()))?
    }

    pub(in crate::app::tasks) async fn force_archive_for_thread(
        &self,
        thread_id: String,
        expected_id: String,
    ) -> Result<ArchiveOutcome, ManagedWorktreeError> {
        let worktrees = self.clone();
        tokio::task::spawn_blocking(move || {
            worktrees.force_archive_blocking(&thread_id, &expected_id)
        })
        .await
        .map_err(|error| ManagedWorktreeError::Worker(error.to_string()))?
    }

    fn force_archive_blocking(
        &self,
        thread_id: &str,
        expected_id: &str,
    ) -> Result<ArchiveOutcome, ManagedWorktreeError> {
        let record = self.force_archive_record(thread_id, expected_id)?;
        if record.state == ManagedWorktreeState::Archived {
            return Ok(ArchiveOutcome::Archived(record));
        }
        let path = self.owned_path(&record)?;
        let common = Path::new(&record.repository_git_dir);
        // Capture only a checkout Git can actually identify. A missing anchor
        // means Restore will refuse; a historical branch is not a substitute.
        let anchor = inspect_ready_worktree(&record)
            .ok()
            .map(|checkout| CheckoutAnchor {
                branch_name: checkout.branch_name,
                head_sha: checkout.head_sha,
            })
            .or_else(|| record.checkout_anchor.clone());
        let cleanup_verified = worktree_admin_entries(&path, common).is_ok();
        if record.state == ManagedWorktreeState::Ready {
            self.store.transition_worktree(
                &record.worktree_id,
                ManagedWorktreeState::Ready,
                ManagedWorktreeState::Removing,
                anchor.clone(),
                now_ms()?,
            )?;
        }
        // The slot is rechecked after recording the removal intent. Deletion
        // unlinks child symlinks instead of following them outside this slot.
        let current = self.force_archive_record(thread_id, expected_id)?;
        let path = self.owned_path(&current)?;
        match fs::remove_dir_all(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(WorktreeError::Io(error).into()),
        }
        if cleanup_verified && let Err(error) = remove_worktree_admin_entries(&path, common) {
            eprintln!("could not clean force-archived worktree metadata {expected_id}: {error}");
        }
        let archived = self.store.transition_worktree(
            expected_id,
            ManagedWorktreeState::Removing,
            ManagedWorktreeState::Archived,
            anchor,
            now_ms()?,
        )?;
        Ok(ArchiveOutcome::Archived(archived))
    }

    fn force_archive_record(
        &self,
        thread_id: &str,
        expected_id: &str,
    ) -> Result<ManagedWorktree, ManagedWorktreeError> {
        let record = self.store.worktree_for_thread(thread_id)?.ok_or_else(|| {
            ManagedWorktreeError::UnownedPath("Task no longer has a managed worktree".to_string())
        })?;
        if record.worktree_id != expected_id
            || !matches!(
                record.state,
                ManagedWorktreeState::Ready
                    | ManagedWorktreeState::Removing
                    | ManagedWorktreeState::Archived
            )
        {
            return Err(ManagedWorktreeError::UnownedPath(
                "the confirmed worktree has changed".to_string(),
            ));
        }
        let path = self.owned_path(&record)?;
        if record.state == ManagedWorktreeState::Archived
            && path.try_exists().map_err(WorktreeError::Io)?
        {
            return Err(ManagedWorktreeError::UnownedPath(
                "the archived worktree path is occupied".to_string(),
            ));
        }
        Ok(record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{fs::RootedFs, task_store::TaskStore};
    use std::{process::Command, sync::Arc};

    fn git(path: &Path, arguments: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn fixture() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        ManagedWorktrees,
        ManagedWorktree,
    ) {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        git(&source, &["init", "-b", "main"]);
        git(&source, &["config", "user.name", "Test"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        fs::write(source.join("file.txt"), "committed\n").unwrap();
        git(&source, &["add", "."]);
        git(&source, &["commit", "-m", "initial"]);
        let store = TaskStore::memory().unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let worktrees = ManagedWorktrees::new(fs, store, root.path().join("worktrees")).unwrap();
        let super::super::IsolateOutcome::Isolated { worktree, .. } = worktrees
            .isolate_current_blocking(&source, "task", "Task", None, None, false)
            .unwrap()
        else {
            panic!("expected a managed worktree")
        };
        (root, source, worktrees, worktree)
    }

    #[tokio::test]
    async fn force_archive_accepts_a_missing_slot_but_never_removes_a_reoccupied_archive() {
        let (_temp, _source, worktrees, record) = fixture();
        let id = record.thread_id.clone().unwrap();
        let path = Path::new(&record.worktree_path);
        fs::remove_dir_all(path).unwrap();
        worktrees
            .force_archive_for_thread(id.clone(), record.worktree_id.clone())
            .await
            .unwrap();
        let archived = worktrees
            .store
            .worktree(&record.worktree_id)
            .unwrap()
            .unwrap();
        assert_eq!(archived.state, ManagedWorktreeState::Archived);
        assert!(archived.checkout_anchor.is_none());
        fs::create_dir(path).unwrap();
        fs::write(path.join("keep"), "new occupant").unwrap();
        assert!(
            worktrees
                .force_archive_for_thread(id, record.worktree_id)
                .await
                .is_err()
        );
        assert_eq!(
            fs::read_to_string(path.join("keep")).unwrap(),
            "new occupant"
        );
    }

    #[tokio::test]
    async fn force_archive_discards_changes_and_restores_the_committed_checkout() {
        let (root, source, worktrees, record) = fixture();
        let path = Path::new(&record.worktree_path);
        fs::write(path.join("file.txt"), "staged\n").unwrap();
        git(path, &["add", "file.txt"]);
        fs::write(path.join("file.txt"), "unstaged\n").unwrap();
        fs::write(path.join("untracked.txt"), "discard\n").unwrap();
        let external = root.path().join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("keep.txt"), "keep").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&external, path.join("external-link")).unwrap();
        assert!(worktrees.archive_for_thread("task".into()).await.is_err());
        let ArchiveOutcome::Archived(archived) = worktrees
            .force_archive_for_thread("task".into(), record.worktree_id.clone())
            .await
            .unwrap()
        else {
            panic!()
        };
        assert!(!path.exists());
        assert_eq!(
            fs::read_to_string(external.join("keep.txt")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_to_string(source.join("file.txt")).unwrap(),
            "committed\n"
        );
        assert!(archived.checkout_anchor.is_some());
        worktrees.restore_for_thread("task".into()).await.unwrap();
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "committed\n"
        );
        assert!(!path.join("untracked.txt").exists());
    }

    #[tokio::test]
    async fn force_archive_with_a_missing_repository_is_retryable_and_restore_refuses() {
        let (root, source, worktrees, record) = fixture();
        fs::write(
            Path::new(&record.worktree_path).join("untracked.txt"),
            "discard",
        )
        .unwrap();
        fs::rename(source, root.path().join("moved")).unwrap();
        let ArchiveOutcome::Archived(archived) = worktrees
            .force_archive_for_thread("task".into(), record.worktree_id.clone())
            .await
            .unwrap()
        else {
            panic!()
        };
        assert!(archived.checkout_anchor.is_none());
        assert!(!Path::new(&record.worktree_path).exists());
        worktrees
            .force_archive_for_thread("task".into(), record.worktree_id.clone())
            .await
            .unwrap();
        assert!(
            matches!(worktrees.restore_for_thread("task".into()).await, Err(ManagedWorktreeError::Unavailable(body)) if body.code == "managed_worktree_restore_unavailable")
        );
        assert_eq!(
            worktrees
                .store
                .worktree(&record.worktree_id)
                .unwrap()
                .unwrap()
                .state,
            ManagedWorktreeState::Archived
        );
        let restarted = ManagedWorktrees::new(
            Arc::new(RootedFs::new(root.path()).unwrap()),
            worktrees.store.clone(),
            root.path().join("worktrees"),
        )
        .unwrap();
        assert!(restarted.restore_for_thread("task".into()).await.is_err());
    }

    #[tokio::test]
    async fn force_archive_rejects_a_changed_identity_and_a_symlink_slot() {
        let (root, source, worktrees, record) = fixture();
        assert!(
            worktrees
                .force_archive_for_thread("task".into(), "different".into())
                .await
                .is_err()
        );
        assert!(Path::new(&record.worktree_path).is_dir());
        #[cfg(unix)]
        {
            fs::rename(&record.worktree_path, root.path().join("saved-worktree")).unwrap();
            std::os::unix::fs::symlink(&source, &record.worktree_path).unwrap();
            assert!(
                worktrees
                    .force_archive_for_thread("task".into(), record.worktree_id)
                    .await
                    .is_err()
            );
            assert_eq!(
                fs::read_to_string(source.join("file.txt")).unwrap(),
                "committed\n"
            );
        }
    }
}
