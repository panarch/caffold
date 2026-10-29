//! Reconnect one existing linked worktree after its main checkout moved.
//! The caller proves Caffold ownership; this boundary proves both Git links.
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

use super::{
    WorktreeError, inspect_attached_worktree, reject_symlink_target, resolve_metadata_path,
    run_git_dir_text,
};

pub(crate) struct WorktreeReconnection {
    target: PathBuf,
    old_common: PathBuf,
    new_common: PathBuf,
    marker: PathBuf,
    original: String,
    destination: PathBuf,
}

pub(crate) fn prepare_reconnection(
    target: &Path,
    old_common: &Path,
    new_common: &Path,
) -> Result<WorktreeReconnection, WorktreeError> {
    reject_symlink_target(target)?;
    let target = target.canonicalize()?;
    let new_common = new_common.canonicalize()?;
    let marker = target.join(".git");
    let original = regular_text(&marker)?;
    let pointer = original
        .trim_end()
        .strip_prefix("gitdir: ")
        .ok_or_else(|| WorktreeError::NotRepository(target.display().to_string()))?;
    let pointer = resolve_metadata_path(&target.join(pointer))?;
    let old_common = resolve_metadata_path(old_common)?;
    let parent = pointer
        .parent()
        .ok_or_else(|| mismatch(&old_common, &pointer))?;
    if parent != old_common.join("worktrees") && parent != new_common.join("worktrees") {
        return Err(mismatch(&old_common, &pointer));
    }
    let entry_name = pointer
        .file_name()
        .ok_or_else(|| mismatch(&old_common, &pointer))?;
    let administration = new_common.join("worktrees");
    reject_symlink_target(&administration)?;
    let destination = administration.join(entry_name);
    reject_symlink_target(&destination)?;
    if destination.canonicalize()? != destination {
        return Err(mismatch(&new_common, &destination));
    }
    let backlink = regular_text(&destination.join("gitdir"))?;
    if destination.join(backlink.trim_end()).canonicalize()? != marker {
        return Err(mismatch(&marker, Path::new(backlink.trim_end())));
    }
    let common = regular_text(&destination.join("commondir"))?;
    if destination.join(common.trim_end()).canonicalize()? != new_common {
        return Err(mismatch(&new_common, Path::new(common.trim_end())));
    }
    let head = regular_text(&destination.join("HEAD"))?;
    let branch = head
        .trim_end()
        .strip_prefix("ref: refs/heads/")
        .filter(|branch| !branch.is_empty())
        .ok_or_else(|| WorktreeError::Detached(target.display().to_string()))?;
    run_git_dir_text(
        &new_common,
        "reconnection HEAD inspection",
        [
            "rev-parse",
            "--verify",
            &format!("refs/heads/{branch}^{{commit}}"),
        ],
    )?;
    Ok(WorktreeReconnection {
        target,
        old_common,
        new_common,
        marker,
        original,
        destination,
    })
}

impl WorktreeReconnection {
    pub(crate) fn apply(&self) -> Result<(), WorktreeError> {
        // A prior attempt may already have repaired this pointer. Revalidate
        // both directions immediately before replacing only this owned marker.
        let current = prepare_reconnection(&self.target, &self.old_common, &self.new_common)?;
        if current.original != self.original {
            return Err(mismatch(&self.destination, &current.destination));
        }
        let desired = format!("gitdir: {}\n", self.destination.display());
        if desired != self.original {
            let temporary = self.target.join(format!(".caffold-git-{}", Uuid::new_v4()));
            let result = (|| {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                file.write_all(desired.as_bytes())?;
                file.sync_all()?;
                fs::rename(&temporary, &self.marker)
            })();
            if result.is_err() {
                let _ = fs::remove_file(&temporary);
            }
            result?;
        }
        inspect_attached_worktree(&self.target, &self.new_common, None)?;
        Ok(())
    }
}

fn regular_text(path: &Path) -> Result<String, WorktreeError> {
    reject_symlink_target(path)?;
    if !fs::metadata(path)?.is_file() {
        return Err(WorktreeError::MissingMetadata(path.display().to_string()));
    }
    Ok(fs::read_to_string(path)?)
}

fn mismatch(expected: &Path, actual: &Path) -> WorktreeError {
    WorktreeError::RepositoryMismatch {
        expected: expected.display().to_string(),
        actual: actual.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::{create_attached_worktree, inspect_attached_worktree};
    use std::{fs, process::Command};

    fn git(root: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn repository(root: &Path) {
        fs::create_dir_all(root).unwrap();
        git(root, &["init"]);
        git(root, &["config", "user.name", "Fixture"]);
        git(root, &["config", "user.email", "fixture@example.invalid"]);
        git(
            root,
            &[
                "-c",
                "core.hooksPath=/dev/null",
                "commit",
                "--allow-empty",
                "-m",
                "Initial",
            ],
        );
    }

    #[test]
    fn reconnect_preserves_work_and_external_links_and_can_repeat() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        repository(&source);
        let owned = temp.path().join("owned");
        let external = temp.path().join("external");
        let original = create_attached_worktree(&source, &owned, "owned", None).unwrap();
        create_attached_worktree(&source, &external, "external", None).unwrap();
        fs::write(owned.join("staged"), "staged\n").unwrap();
        git(&owned, &["add", "staged"]);
        fs::write(owned.join("staged"), "unstaged\n").unwrap();
        fs::write(owned.join("untracked"), "keep\n").unwrap();
        let index = fs::read(original.git_dir.join("index")).unwrap();
        let external_pointer = fs::read(external.join(".git")).unwrap();
        let moved = temp.path().join("moved");
        fs::rename(&source, &moved).unwrap();
        assert!(inspect_attached_worktree(&owned, &original.common_dir, None).is_err());
        let new_common = moved.join(".git").canonicalize().unwrap();
        prepare_reconnection(&owned, &original.common_dir, &new_common)
            .unwrap()
            .apply()
            .unwrap();
        let actual = inspect_attached_worktree(&owned, &new_common, None).unwrap();
        assert_eq!(actual.branch_name, original.branch_name);
        assert_eq!(actual.head_sha, original.head_sha);
        assert_eq!(fs::read(actual.git_dir.join("index")).unwrap(), index);
        assert_eq!(
            fs::read_to_string(owned.join("staged")).unwrap(),
            "unstaged\n"
        );
        assert_eq!(
            fs::read_to_string(owned.join("untracked")).unwrap(),
            "keep\n"
        );
        assert_eq!(fs::read(external.join(".git")).unwrap(), external_pointer);
        prepare_reconnection(&owned, &original.common_dir, &new_common)
            .unwrap()
            .apply()
            .unwrap();
    }

    #[test]
    fn reconnect_rejects_wrong_backlink_before_changing_the_pointer() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        repository(&source);
        let target = temp.path().join("owned");
        let checkout = create_attached_worktree(&source, &target, "owned", None).unwrap();
        let marker = fs::read(target.join(".git")).unwrap();
        let moved = temp.path().join("moved");
        fs::rename(&source, &moved).unwrap();
        let entry = moved
            .join(".git/worktrees")
            .join(checkout.git_dir.file_name().unwrap());
        fs::write(
            entry.join("gitdir"),
            moved.join(".git").to_string_lossy().as_bytes(),
        )
        .unwrap();
        assert!(prepare_reconnection(&target, &checkout.common_dir, &moved.join(".git")).is_err());
        assert_eq!(fs::read(target.join(".git")).unwrap(), marker);
    }

    #[test]
    fn reconnect_rejects_a_different_common_directory_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        repository(&source);
        let other = temp.path().join("other");
        repository(&other);
        let target = temp.path().join("owned");
        let checkout = create_attached_worktree(&source, &target, "owned", None).unwrap();
        let marker = fs::read(target.join(".git")).unwrap();
        let moved = temp.path().join("moved");
        fs::rename(&source, &moved).unwrap();
        let entry = moved
            .join(".git/worktrees")
            .join(checkout.git_dir.file_name().unwrap());
        fs::write(
            entry.join("commondir"),
            other.join(".git").display().to_string(),
        )
        .unwrap();
        assert!(matches!(
            prepare_reconnection(&target, &checkout.common_dir, &moved.join(".git")),
            Err(WorktreeError::RepositoryMismatch { .. })
        ));
        assert_eq!(fs::read(target.join(".git")).unwrap(), marker);
    }

    #[test]
    fn reconnect_revalidates_the_marker_after_preparation() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        repository(&source);
        let target = temp.path().join("owned");
        let checkout = create_attached_worktree(&source, &target, "owned", None).unwrap();
        let moved = temp.path().join("moved");
        fs::rename(&source, &moved).unwrap();
        let plan =
            prepare_reconnection(&target, &checkout.common_dir, &moved.join(".git")).unwrap();
        // An external repair is a newer filesystem observation. The old plan
        // must refuse to overwrite it, even when both links are otherwise valid.
        let repaired = format!(
            "gitdir: {}\n",
            moved
                .join(".git/worktrees")
                .join(checkout.git_dir.file_name().unwrap())
                .display()
        );
        fs::write(target.join(".git"), &repaired).unwrap();
        assert!(matches!(
            plan.apply(),
            Err(WorktreeError::RepositoryMismatch { .. })
        ));
        assert_eq!(fs::read_to_string(target.join(".git")).unwrap(), repaired);
        prepare_reconnection(&target, &checkout.common_dir, &moved.join(".git"))
            .unwrap()
            .apply()
            .unwrap();
    }

    #[test]
    fn reconnect_rejects_detached_and_symlinked_metadata_before_writing() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("source");
        repository(&source);
        let target = temp.path().join("owned");
        let checkout = create_attached_worktree(&source, &target, "owned", None).unwrap();
        git(&target, &["checkout", "--detach"]);
        let marker = fs::read(target.join(".git")).unwrap();
        let moved = temp.path().join("moved");
        fs::rename(&source, &moved).unwrap();
        assert!(matches!(
            prepare_reconnection(&target, &checkout.common_dir, &moved.join(".git")),
            Err(WorktreeError::Detached(_))
        ));
        assert_eq!(fs::read(target.join(".git")).unwrap(), marker);
        #[cfg(unix)]
        {
            let entry = moved
                .join(".git/worktrees")
                .join(checkout.git_dir.file_name().unwrap());
            let head = entry.join("HEAD");
            fs::remove_file(&head).unwrap();
            std::os::unix::fs::symlink(moved.join(".git/HEAD"), &head).unwrap();
            assert!(matches!(
                prepare_reconnection(&target, &checkout.common_dir, &moved.join(".git")),
                Err(WorktreeError::TargetSymlink(_))
            ));
        }
    }
}
