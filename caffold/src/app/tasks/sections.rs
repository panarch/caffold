//! Observe a Section folder and reconnect its Tasks to a user-selected location.
//! Completed Task repairs persist independently; the Section commits last.
use super::{lifecycle::worktree_api_error, worktrees::ManagedWorktrees};
use crate::{
    app::{error::ApiError, terminal::TaskTerminals},
    fs::{FsError, RootedFs},
    git::{self, WorktreeReconnection},
    task_store::{
        ManagedSection, ManagedThread, ManagedWorktree, ManagedWorktreeState, TaskStore,
        TaskStoreError,
    },
};
use serde::Serialize;
use std::{
    fs,
    io::{self, ErrorKind},
    path::{Component, Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{Mutex, OwnedMutexGuard};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum DirectoryStatus {
    Available,
    Missing,
    Unavailable,
    NotDirectory,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DirectoryObservation {
    pub status: DirectoryStatus,
    pub message: Option<String>,
}

impl DirectoryObservation {
    pub fn read(fs: &RootedFs, path: &str) -> Self {
        match fs.absolute_directory_path(path) {
            Ok(_) => Self {
                status: DirectoryStatus::Available,
                message: None,
            },
            Err(error) => Self {
                status: match &error {
                    FsError::NotFound { .. } => DirectoryStatus::Missing,
                    FsError::NotDirectory { .. } => DirectoryStatus::NotDirectory,
                    _ => DirectoryStatus::Unavailable,
                },
                message: Some(error.to_string()),
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SectionDirectory {
    pub section_id: String,
    pub path: String,
    pub directory: DirectoryObservation,
    pub browse_path: String,
    pub reconnect_unavailable_reason: Option<String>,
}

#[derive(Clone)]
pub(super) struct SectionDirectories {
    fs: Arc<RootedFs>,
    store: TaskStore,
    worktrees: ManagedWorktrees,
    terminals: TaskTerminals,
    reconnecting: Arc<Mutex<()>>,
}

pub(super) struct Reconnection {
    section: ManagedSection,
    destination: String,
    common_dir: Option<PathBuf>,
    records: Vec<ManagedWorktree>,
    section_tasks: Vec<ManagedThread>,
    links: Vec<(ManagedWorktree, WorktreeReconnection)>,
    pub active_threads: Vec<String>,
    pub direct_tasks: Vec<ManagedThread>,
    pub original: PathBuf,
    pub target: PathBuf,
}

impl Reconnection {
    pub fn destination_for(&self, cwd: &str) -> Option<PathBuf> {
        let cwd = Path::new(cwd);
        let relative = cwd
            .strip_prefix(&self.original)
            .or_else(|_| cwd.strip_prefix(&self.target))
            .ok()?;
        relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
            .then(|| {
                if relative.as_os_str().is_empty() {
                    self.target.clone()
                } else {
                    self.target.join(relative)
                }
            })
    }

    pub fn threads(&self) -> Vec<String> {
        let mut threads = self
            .records
            .iter()
            .filter_map(|record| record.thread_id.clone())
            .collect::<Vec<_>>();
        threads.extend(self.direct_tasks.iter().map(|task| task.thread_id.clone()));
        threads.sort();
        threads.dedup();
        threads
    }
}

impl SectionDirectories {
    pub fn new(
        fs: Arc<RootedFs>,
        store: TaskStore,
        worktrees: ManagedWorktrees,
        terminals: TaskTerminals,
    ) -> Self {
        Self {
            fs,
            store,
            worktrees,
            terminals,
            reconnecting: Arc::new(Mutex::new(())),
        }
    }

    pub async fn reserve(&self) -> OwnedMutexGuard<()> {
        self.reconnecting.clone().lock_owned().await
    }

    pub fn read(&self, id: &str) -> Result<SectionDirectory, ApiError> {
        let section = self.section(id)?;
        let directory = DirectoryObservation::read(&self.fs, &section.logical_path);
        let old_common = self.fs.root().join(&section.logical_path).join(".git");
        let records = self.records(&old_common)?;
        let reason = if records.iter().any(|record| {
            !matches!(
                record.state,
                ManagedWorktreeState::Ready | ManagedWorktreeState::Archived
            )
        }) {
            Some(
                "A worktree operation needs to finish before reconnecting this Section."
                    .to_string(),
            )
        } else {
            None
        };
        let mut browse_path = Path::new(&section.logical_path)
            .parent()
            .unwrap_or(Path::new(""))
            .to_path_buf();
        loop {
            if self
                .fs
                .absolute_directory_path(&browse_path.to_string_lossy())
                .is_ok()
            {
                break;
            }
            if !browse_path.pop() {
                break;
            }
        }
        Ok(SectionDirectory {
            section_id: section.section_id,
            path: section.logical_path,
            directory,
            browse_path: browse_path.to_string_lossy().into_owned(),
            reconnect_unavailable_reason: reason,
        })
    }

    pub fn prepare(
        &self,
        id: &str,
        expected: &str,
        path: &str,
    ) -> Result<Option<Reconnection>, ApiError> {
        let section = self.section(id)?;
        let target = self.fs.absolute_directory_path(path)?;
        let destination = self.fs.logical_path_for_absolute(&target)?;
        // The same completed request may arrive again after a lost response.
        if section.logical_path == destination && expected != destination {
            return Ok(None);
        }
        if section.logical_path != expected
            || DirectoryObservation::read(&self.fs, expected).status != DirectoryStatus::Missing
        {
            return Err(conflict(
                "The Section directory changed. Check its current location and try again.",
            ));
        }
        let logical = Path::new(expected);
        if logical.is_absolute()
            || logical
                .components()
                .any(|part| !matches!(part, Component::Normal(_)))
        {
            return Err(invalid(
                "The original directory is outside the supported repository layout.",
            ));
        }
        if self
            .store
            .read(|tables| tables.managed_sections())
            .map_err(store_error)?
            .iter()
            .any(|other| other.section_id != id && other.logical_path == destination)
        {
            return Err(conflict(
                "Another Section already uses the selected folder.",
            ));
        }
        let original = self.fs.root().join(expected);
        let old_common = original.join(".git");
        let (active, worktrees) = self
            .store
            .read(|tables| {
                Ok((
                    tables.active_managed_threads()?,
                    tables.managed_worktrees()?,
                ))
            })
            .map_err(store_error)?;
        let section_tasks = active
            .into_iter()
            .filter(|task| task.section_id.as_deref() == Some(id))
            .collect::<Vec<_>>();
        let new_common = target.join(".git");
        let mut records = worktrees
            .iter()
            .filter(|record| {
                record.state != ManagedWorktreeState::Archived
                    && (Path::new(&record.repository_git_dir) == old_common
                        || (Path::new(&record.repository_git_dir) == new_common
                            && section_tasks.iter().any(|task| {
                                record.thread_id.as_deref() == Some(task.thread_id.as_str())
                            })))
            })
            .cloned()
            .collect::<Vec<_>>();
        records.sort_by(|a, b| a.worktree_id.cmp(&b.worktree_id));
        let direct_tasks = section_tasks
            .iter()
            .filter(|task| {
                !worktrees
                    .iter()
                    .any(|record| record.thread_id.as_deref() == Some(task.thread_id.as_str()))
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut links = Vec::new();
        let mut active_threads = direct_tasks
            .iter()
            .map(|task| task.thread_id.clone())
            .collect::<Vec<_>>();
        let mut common_dir = None;
        if !records.is_empty() {
            let new_common = self.repository_common_dir(&target)?;
            for record in &records {
                let owned = self
                    .worktrees
                    .owned_path(record)
                    .map_err(worktree_api_error)?;
                match record.state {
                    ManagedWorktreeState::Ready => {
                        match fs::symlink_metadata(&owned) {
                            Err(error) if error.kind() == ErrorKind::NotFound => continue,
                            Err(error) => return Err(io_error(error)),
                            Ok(_) => {}
                        }
                        links.push((
                            record.clone(),
                            git::prepare_reconnection(&owned, &old_common, &new_common).map_err(
                                |error| {
                                    invalid(&format!(
                                        "Cannot verify this repository's worktree links: {error}"
                                    ))
                                },
                            )?,
                        ));
                        if let Some(thread) = &record.thread_id {
                            active_threads.push(thread.clone());
                        }
                    }
                    _ => {
                        return Err(conflict(
                            "A worktree operation needs to finish before reconnecting this Section.",
                        ));
                    }
                }
            }
            common_dir = Some(new_common);
        }
        active_threads.sort();
        Ok(Some(Reconnection {
            section,
            destination,
            common_dir,
            direct_tasks,
            original,
            target,
            records,
            section_tasks,
            links,
            active_threads,
        }))
    }

    pub fn reconnect_thread(&self, expected: &ManagedThread, cwd: &str) -> Result<(), ApiError> {
        self.store
            .transaction(|tables| tables.reconnect_managed_thread(expected, cwd))
            .map_err(store_error)?;
        self.terminals.close(&expected.thread_id);
        Ok(())
    }

    pub fn reconnect_active_worktree(
        &self,
        plan: &Reconnection,
        thread_id: &str,
    ) -> Result<(), ApiError> {
        for (record, link) in &plan.links {
            if record.thread_id.as_deref() == Some(thread_id) {
                self.reconnect_worktree(
                    record,
                    link,
                    plan.common_dir.as_ref().expect("worktree common directory"),
                )?;
            }
        }
        Ok(())
    }

    pub fn archived_worktrees(
        &self,
        plan: &Reconnection,
    ) -> Result<Vec<ManagedWorktree>, ApiError> {
        Ok(self
            .records(&plan.original.join(".git"))?
            .into_iter()
            .filter(|record| record.state == ManagedWorktreeState::Archived)
            .collect())
    }

    pub fn reconnect_archived_worktree(
        &self,
        plan: &Reconnection,
        record: &ManagedWorktree,
    ) -> Result<(), ApiError> {
        self.worktrees
            .owned_path(record)
            .map_err(worktree_api_error)?;
        let common = self.repository_common_dir(&plan.target)?;
        self.store
            .transaction(|tables| {
                tables.reconnect_managed_worktree(record, &common.to_string_lossy())
            })
            .map_err(store_error)
    }

    fn reconnect_worktree(
        &self,
        record: &ManagedWorktree,
        link: &WorktreeReconnection,
        common: &Path,
    ) -> Result<(), ApiError> {
        link.apply()
            .map_err(|error| invalid(&format!("Worktree reconnection failed: {error}")))?;
        self.store
            .transaction(|tables| {
                tables.reconnect_managed_worktree(record, &common.to_string_lossy())
            })
            .map_err(store_error)
    }

    pub fn apply(&self, plan: Reconnection) -> Result<SectionDirectory, ApiError> {
        self.store
            .transaction(|tables| {
                let sections = tables.managed_sections()?;
                let worktrees = tables.managed_worktrees()?;
                let section_tasks = tables
                    .active_managed_threads()?
                    .into_iter()
                    .filter(|task| task.section_id.as_deref() == Some(&plan.section.section_id))
                    .collect::<Vec<_>>();
                let old_common = plan.original.join(".git");
                let new_common = plan.target.join(".git");
                let mut records = worktrees
                    .iter()
                    .filter(|record| {
                        record.state != ManagedWorktreeState::Archived
                            && (Path::new(&record.repository_git_dir) == old_common
                                || (Path::new(&record.repository_git_dir) == new_common
                                    && section_tasks.iter().any(|task| {
                                        record.thread_id.as_deref() == Some(task.thread_id.as_str())
                                    })))
                    })
                    .cloned()
                    .collect::<Vec<_>>();
                records.sort_by(|a, b| a.worktree_id.cmp(&b.worktree_id));
                if !sections.iter().any(|section| section == &plan.section)
                    || sections.iter().any(|section| {
                        section.section_id != plan.section.section_id
                            && section.logical_path == plan.destination
                    })
                    || records != plan.records
                    || section_tasks != plan.section_tasks
                {
                    return Err(TaskStoreError::InvalidRow(
                        "Section changed during reconnection",
                    ));
                }
                if let Some(common) = &plan.common_dir {
                    for record in &plan.records {
                        tables.reconnect_managed_worktree(record, &common.to_string_lossy())?;
                    }
                }
                let mut section = plan.section.clone();
                section.logical_path = plan.destination.clone();
                tables.upsert_managed_section(&section)
            })
            .map_err(store_error)?;
        self.terminals.close_section(&plan.section.section_id);
        self.read(&plan.section.section_id)
    }

    fn repository_common_dir(&self, target: &Path) -> Result<PathBuf, ApiError> {
        let common = target.join(".git");
        let metadata = match fs::symlink_metadata(&common) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Err(invalid(
                    "Select the moved original repository, with its existing .git directory.",
                ));
            }
            Err(error) => return Err(io_error(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(invalid(
                "Select the moved original repository, with its existing .git directory.",
            ));
        }
        let common = common.canonicalize().map_err(io_error)?;
        self.fs.logical_path_for_absolute(&common)?;
        let repository = git::repository_for(target)
            .ok_or_else(|| invalid("The selected folder is not a Git repository."))?;
        let metadata = git::repository_metadata_paths(&repository)
            .ok_or_else(|| invalid("The repository metadata is unavailable."))?;
        if repository.root != target || metadata.git_dir != common || metadata.common_dir != common
        {
            return Err(invalid(
                "Select the original repository root, rather than a linked worktree or subfolder.",
            ));
        }
        Ok(common)
    }

    fn section(&self, id: &str) -> Result<ManagedSection, ApiError> {
        self.store
            .read(|tables| tables.managed_sections())
            .map_err(store_error)?
            .into_iter()
            .find(|section| section.section_id == id)
            .ok_or_else(|| ApiError::NotFound {
                code: "section_not_found",
                message: "The Section no longer exists.".to_string(),
            })
    }

    fn records(&self, common: &Path) -> Result<Vec<ManagedWorktree>, ApiError> {
        let mut records = self
            .store
            .managed_worktrees()
            .map_err(store_error)?
            .into_iter()
            .filter(|record| Path::new(&record.repository_git_dir) == common)
            .collect::<Vec<_>>();
        records.sort_by(|a, b| a.worktree_id.cmp(&b.worktree_id));
        Ok(records)
    }
}

fn invalid(message: &str) -> ApiError {
    ApiError::BadRequest {
        code: "section_reconnect_invalid",
        message: message.to_string(),
    }
}

fn conflict(message: &str) -> ApiError {
    ApiError::Conflict {
        code: "section_reconnect_conflict",
        message: message.to_string(),
    }
}

fn store_error(error: TaskStoreError) -> ApiError {
    match error {
        TaskStoreError::InvalidRow(
            "Section changed during reconnection" | "worktree changed during reconnection",
        ) => conflict("The Section or its worktrees changed. Check again and retry."),
        _ => ApiError::Internal(error.to_string()),
    }
}

fn io_error(error: io::Error) -> ApiError {
    ApiError::Unavailable {
        code: "section_directory_unavailable",
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::RunBy;

    #[test]
    fn final_reconnection_refuses_new_tasks_or_a_competing_section() {
        let temp = tempfile::tempdir().unwrap();
        let fs = Arc::new(RootedFs::new(temp.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees =
            ManagedWorktrees::new(fs.clone(), store.clone(), temp.path().join("managed")).unwrap();
        let directories =
            SectionDirectories::new(fs, store.clone(), worktrees, TaskTerminals::for_tests());
        let section = ManagedSection {
            section_id: "section".into(),
            logical_path: "old".into(),
            position: 1,
            last_composer_settings: None,
        };
        store
            .transaction(|tables| tables.upsert_managed_section(&section))
            .unwrap();
        fs::create_dir(temp.path().join("moved")).unwrap();
        let plan = directories
            .prepare("section", "old", "moved")
            .unwrap()
            .unwrap();
        store
            .transaction(|tables| {
                tables.claim_managed_thread_at_top(
                    ManagedThread::new("new", RunBy::Codex, Some(1), None, None),
                    "New Task",
                    "section",
                    1,
                )
            })
            .unwrap();
        assert!(matches!(
            directories.apply(plan),
            Err(ApiError::Conflict { .. })
        ));
        assert_eq!(directories.read("section").unwrap().path, "old");
        let plan = directories
            .prepare("section", "old", "moved")
            .unwrap()
            .unwrap();
        store
            .transaction(|tables| {
                tables.upsert_managed_section(&ManagedSection {
                    section_id: "other".into(),
                    logical_path: "moved".into(),
                    ..section.clone()
                })
            })
            .unwrap();
        assert!(matches!(
            directories.apply(plan),
            Err(ApiError::Conflict { .. })
        ));
        assert_eq!(directories.read("section").unwrap().path, "old");
    }

    #[test]
    fn directory_observations_distinguish_missing_from_unavailable_and_files() {
        let temp = tempfile::tempdir().unwrap();
        let fs = RootedFs::new(temp.path()).unwrap();
        fs::write(temp.path().join("file"), "content").unwrap();
        assert_eq!(
            DirectoryObservation::read(&fs, "").status,
            DirectoryStatus::Available
        );
        assert_eq!(
            DirectoryObservation::read(&fs, "missing").status,
            DirectoryStatus::Missing
        );
        assert_eq!(
            DirectoryObservation::read(&fs, "file").status,
            DirectoryStatus::NotDirectory
        );
        let unavailable = DirectoryObservation::read(&fs, "../outside");
        assert_eq!(unavailable.status, DirectoryStatus::Unavailable);
        assert!(unavailable.message.is_some());
    }
}
