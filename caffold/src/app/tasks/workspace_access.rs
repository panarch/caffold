//! Current workspace access follows managed checkout ownership, not Task history.

use std::path::Path;

use serde::Serialize;

use crate::fs::RootedFs;
use crate::git;
use crate::task_store::{ManagedWorktreeState, TaskStore};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub(in crate::app) enum WorkspaceAccess {
    ReadWrite {
        #[serde(rename = "ownerTaskId", skip_serializing_if = "Option::is_none")]
        owner_task_id: Option<String>,
    },
    ReadOnly {
        reason: &'static str,
        #[serde(rename = "ownerTaskId")]
        owner_task_id: String,
    },
    Unavailable {
        reason: String,
    },
}

impl WorkspaceAccess {
    pub(in crate::app) fn inspect(
        fs: &RootedFs,
        store: &TaskStore,
        managed_root: &Path,
        task: &str,
        cwd: &str,
    ) -> Self {
        match Self::read(fs, store, managed_root, task, cwd) {
            Ok(access) => access,
            Err(reason) => Self::Unavailable { reason },
        }
    }

    pub(in crate::app) fn require_write(&self) -> Result<(), String> {
        match self {
            Self::ReadWrite { .. } => Ok(()),
            Self::ReadOnly { owner_task_id, .. } => Err(format!(
                "This managed worktree belongs to Task {owner_task_id}. This Task can only read its conversation history."
            )),
            Self::Unavailable { reason } => {
                Err(format!("The Task workspace is unavailable: {reason}"))
            }
        }
    }

    fn read(
        fs: &RootedFs,
        store: &TaskStore,
        managed_root: &Path,
        task: &str,
        cwd: &str,
    ) -> Result<Self, String> {
        let path = Path::new(cwd)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !path.is_dir() {
            return Err("The working directory is not a directory.".into());
        }
        fs.logical_path_for_absolute(&path)
            .map_err(|error| error.to_string())?;
        let records = store
            .read(|tables| tables.managed_worktrees())
            .map_err(|error| error.to_string())?;
        let matching = records
            .into_iter()
            .filter(|record| {
                let recorded = Path::new(&record.worktree_path);
                path.starts_with(recorded.canonicalize().as_deref().unwrap_or(recorded))
            })
            .collect::<Vec<_>>();
        if matching.is_empty() {
            if path.starts_with(managed_root) {
                return Err("The directory has no managed-worktree ownership record.".into());
            }
            return Ok(Self::ReadWrite {
                owner_task_id: None,
            });
        }
        if matching.len() != 1 {
            return Err("The working directory has ambiguous managed-worktree ownership.".into());
        }
        let record = &matching[0];
        if record.state != ManagedWorktreeState::Ready {
            return Err(format!(
                "The managed worktree is {}.",
                record.state.as_str()
            ));
        }
        let repository = git::repository_for(&path)
            .ok_or_else(|| "The managed worktree is not a Git checkout.".to_string())?;
        let metadata = git::repository_metadata_paths(&repository)
            .ok_or_else(|| "Cannot read the managed worktree's Git identity.".to_string())?;
        let root = Path::new(&record.worktree_path)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if root != managed_root.join(&record.worktree_id) {
            return Err(
                "The managed-worktree record does not match its configured owned path.".into(),
            );
        }
        let common = Path::new(&record.repository_git_dir)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if repository.root != root || metadata.common_dir != common {
            return Err("The checkout no longer matches its managed-worktree identity.".into());
        }
        match record.thread_id.as_deref() {
            Some(owner)
                if store
                    .find(owner)
                    .map_err(|error| error.to_string())?
                    .is_none() =>
            {
                Err("The managed worktree's Task owner no longer exists.".into())
            }
            Some(owner) if owner == task => Ok(Self::ReadWrite {
                owner_task_id: Some(owner.into()),
            }),
            Some(owner) => Ok(Self::ReadOnly {
                reason: "managedByAnotherTask",
                owner_task_id: owner.into(),
            }),
            None => Err("The managed worktree has no Task owner.".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::ManagedWorktree;
    use crate::task_store::{ManagedThread, RunBy};
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let result = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn access_follows_managed_ownership_and_actual_checkout_identity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let ordinary = root.join("ordinary");
        let repo = root.join("repo");
        let external = root.join("external");
        std::fs::create_dir(&ordinary).unwrap();
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--allow-empty",
                "-m",
                "initial",
            ],
        );
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "external",
                external.to_str().unwrap(),
            ],
        );
        let fs = RootedFs::new(&root).unwrap();
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("target", RunBy::Codex, Some(1), None, None),
                1,
            )
            .unwrap();
        for path in [&ordinary, &repo, &external] {
            assert_eq!(
                WorkspaceAccess::inspect(
                    &fs,
                    &store,
                    &root.join("managed"),
                    "source",
                    path.to_str().unwrap()
                ),
                WorkspaceAccess::ReadWrite {
                    owner_task_id: None
                }
            );
        }
        let external = root.join("managed/same-worktree");
        std::fs::create_dir(root.join("managed")).unwrap();
        git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "managed",
                external.to_str().unwrap(),
            ],
        );
        assert!(matches!(
            WorkspaceAccess::inspect(
                &fs,
                &store,
                &root.join("managed"),
                "source",
                external.to_str().unwrap()
            ),
            WorkspaceAccess::Unavailable { .. }
        ));
        let record = ManagedWorktree {
            worktree_id: "same-worktree".into(),
            thread_id: Some("target".into()),
            repository_git_dir: repo.join(".git").to_string_lossy().into_owned(),
            worktree_path: external.to_string_lossy().into_owned(),
            state: ManagedWorktreeState::Ready,
            checkout_anchor: None,
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        store.create_worktree(record).unwrap();
        let nested = external.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert_eq!(
            WorkspaceAccess::inspect(
                &fs,
                &store,
                &root.join("managed"),
                "source",
                nested.to_str().unwrap()
            ),
            WorkspaceAccess::ReadOnly {
                reason: "managedByAnotherTask",
                owner_task_id: "target".into()
            }
        );
        assert_eq!(
            WorkspaceAccess::inspect(
                &fs,
                &store,
                &root.join("managed"),
                "target",
                external.to_str().unwrap()
            ),
            WorkspaceAccess::ReadWrite {
                owner_task_id: Some("target".into())
            }
        );
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&external, &alias).unwrap();
        assert!(matches!(
            WorkspaceAccess::inspect(
                &fs,
                &store,
                &root.join("managed"),
                "source",
                alias.to_str().unwrap()
            ),
            WorkspaceAccess::ReadOnly { .. }
        ));
        std::fs::rename(external.join(".git"), external.join("lost-git")).unwrap();
        assert!(matches!(
            WorkspaceAccess::inspect(
                &fs,
                &store,
                &root.join("managed"),
                "source",
                external.to_str().unwrap()
            ),
            WorkspaceAccess::Unavailable { .. }
        ));
        assert!(matches!(
            WorkspaceAccess::inspect(
                &fs,
                &store,
                &root.join("managed"),
                "source",
                root.join("missing").to_str().unwrap()
            ),
            WorkspaceAccess::Unavailable { .. }
        ));
    }
}
