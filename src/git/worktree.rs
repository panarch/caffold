use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

use thiserror::Error;

use super::{head_sha, repository_for, repository_metadata_paths};

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg(test)]
pub(crate) struct ManagedRepository {
    pub root: PathBuf,
    pub common_dir: PathBuf,
    pub head_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreeCheckout {
    pub path: PathBuf,
    pub common_dir: PathBuf,
    pub branch_name: String,
    pub head_sha: String,
    pub dirty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreeCreationPlan {
    pub repository_root: PathBuf,
    pub common_dir: PathBuf,
    pub target: PathBuf,
    pub branch_name: String,
    pub base_head: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreeTransferPlan {
    pub repository_root: PathBuf,
    pub common_dir: PathBuf,
    pub target: PathBuf,
    pub branch_name: String,
    pub head_sha: String,
    pub source_head_sha: String,
    pub reuse_current_branch: bool,
    pub source_branch: Option<String>,
    pub mode: WorktreeIsolationMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorktreeIsolationMode {
    CreateClean,
    HandoffClean,
    TransferChanges,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WorktreeTransferOutcome {
    pub checkout: WorktreeCheckout,
    pub source_warning: Option<String>,
}

#[derive(Debug, Error)]
pub(crate) enum WorktreeError {
    #[error("not a Git repository: {0}")]
    NotRepository(String),
    #[error("repository has no commit to check out: {0}")]
    MissingHead(String),
    #[error("repository metadata is unavailable: {0}")]
    MissingMetadata(String),
    #[error("invalid worktree branch name: {0}")]
    InvalidBranch(String),
    #[error("worktree branch already exists: {0}")]
    BranchAlreadyExists(String),
    #[error("managed worktree target already exists: {0}")]
    TargetExists(String),
    #[error("managed worktree target does not exist: {0}")]
    TargetMissing(String),
    #[error("managed worktree target must not be a symbolic link: {0}")]
    TargetSymlink(String),
    #[error("managed worktree is detached: {0}")]
    Detached(String),
    #[error("managed worktree has uncommitted changes: {0}")]
    Dirty(String),
    #[error("the source checkout is already a linked Git worktree: {0}")]
    LinkedSource(String),
    #[error("the source checkout has an unresolved Git operation: {0}")]
    UnresolvedOperation(String),
    #[error("the source checkout has dirty submodule state: {0}")]
    DirtySubmodule(String),
    #[error("the current branch must be preserved as `{current}`; requested `{requested}`")]
    CurrentBranchConflict { current: String, requested: String },
    #[error(
        "the source checkout has uncommitted changes on non-default branch `{branch}`; retry with `includeChanges: true` to hand off that branch and its changes"
    )]
    DirtyBranchRequiresTransfer { branch: String },
    #[error("`baseRef` cannot be combined with `includeChanges: true`")]
    BaseRefWithChanges,
    #[error("the protected worktree transfer snapshot is unavailable: {0}")]
    MissingTransferSnapshot(String),
    #[error("managed worktree repository mismatch: expected {expected}, found {actual}")]
    RepositoryMismatch { expected: String, actual: String },
    #[error("managed worktree branch mismatch: expected {expected}, found {actual}")]
    BranchMismatch { expected: String, actual: String },
    #[error("managed worktree branch head mismatch: expected {expected}, found {actual}")]
    BranchHeadMismatch { expected: String, actual: String },
    #[error("Git {operation} failed: {message}")]
    Command {
        operation: &'static str,
        message: String,
    },
    #[error("filesystem error while managing a Git worktree: {0}")]
    Io(#[from] std::io::Error),
}

#[cfg(test)]
pub(crate) fn managed_repository(path: &Path) -> Result<ManagedRepository, WorktreeError> {
    let repository = repository_for(path)
        .ok_or_else(|| WorktreeError::NotRepository(path.display().to_string()))?;
    let metadata = repository_metadata_paths(&repository)
        .ok_or_else(|| WorktreeError::MissingMetadata(path.display().to_string()))?;
    let head_sha = head_sha(&repository)
        .ok_or_else(|| WorktreeError::MissingHead(path.display().to_string()))?;
    Ok(ManagedRepository {
        root: repository.root,
        common_dir: metadata.common_dir,
        head_sha,
    })
}

#[cfg(test)]
pub(crate) fn resolve_commit(path: &Path, reference: &str) -> Result<String, WorktreeError> {
    let repository = managed_repository(path)?;
    verify_commit(&repository.root, reference)
}

#[cfg(test)]
pub(crate) fn create_attached_worktree(
    source: &Path,
    target: &Path,
    branch_name: &str,
    base_ref: Option<&str>,
) -> Result<WorktreeCheckout, WorktreeError> {
    let plan = prepare_attached_worktree(source, target, branch_name, base_ref)?;
    create_prepared_worktree(&plan)
}

#[cfg(test)]
pub(crate) fn prepare_attached_worktree(
    source: &Path,
    target: &Path,
    branch_name: &str,
    base_ref: Option<&str>,
) -> Result<WorktreeCreationPlan, WorktreeError> {
    reject_symlink_target(target)?;
    if target.exists() {
        return Err(WorktreeError::TargetExists(target.display().to_string()));
    }
    let repository = managed_repository(source)?;
    validate_branch_name(&repository.root, branch_name)?;
    if local_branch_exists(&repository.root, branch_name)? {
        return Err(WorktreeError::BranchAlreadyExists(branch_name.to_string()));
    }

    let base_head = resolve_commit(&repository.root, base_ref.unwrap_or("HEAD"))?;
    Ok(WorktreeCreationPlan {
        repository_root: repository.root,
        common_dir: repository.common_dir,
        target: target.to_path_buf(),
        branch_name: branch_name.to_string(),
        base_head,
    })
}

pub(crate) fn prepare_worktree_transfer(
    source: &Path,
    target: &Path,
    automatic_branch: &str,
    requested_branch: Option<&str>,
    base_ref: Option<&str>,
    include_changes: bool,
) -> Result<WorktreeTransferPlan, WorktreeError> {
    reject_symlink_target(target)?;
    if target.exists() {
        return Err(WorktreeError::TargetExists(target.display().to_string()));
    }
    let repository = repository_for(source)
        .ok_or_else(|| WorktreeError::NotRepository(source.display().to_string()))?;
    let metadata = repository_metadata_paths(&repository)
        .ok_or_else(|| WorktreeError::MissingMetadata(source.display().to_string()))?;
    if base_ref.is_none() && metadata.git_dir != metadata.common_dir {
        return Err(WorktreeError::LinkedSource(source.display().to_string()));
    }
    reject_unresolved_operation(&repository.root, &metadata.git_dir)?;
    reject_dirty_submodules_or_nested_repositories(&repository.root)?;
    if base_ref.is_some() && include_changes {
        return Err(WorktreeError::BaseRefWithChanges);
    }
    let source_head_sha = head_sha(&repository)
        .ok_or_else(|| WorktreeError::MissingHead(source.display().to_string()))?;
    let head_sha = if let Some(base_ref) = base_ref {
        verify_commit(&repository.root, base_ref)?
    } else {
        source_head_sha.clone()
    };
    if base_ref.is_some() {
        let source_branch = current_branch_name(&repository.root)?;
        let branch_name = requested_branch.unwrap_or(automatic_branch).to_string();
        validate_branch_name(&repository.root, &branch_name)?;
        if local_branch_exists(&repository.root, &branch_name)? {
            return Err(WorktreeError::BranchAlreadyExists(branch_name));
        }
        return Ok(WorktreeTransferPlan {
            repository_root: repository.root,
            common_dir: metadata.common_dir,
            target: target.to_path_buf(),
            branch_name,
            head_sha,
            source_head_sha,
            reuse_current_branch: false,
            source_branch,
            mode: WorktreeIsolationMode::CreateClean,
        });
    }
    let source_branch = current_branch_name(&repository.root)?;
    let default_branch = default_local_branch(&repository.root, source_branch.as_deref())?;
    let reuse_current_branch = source_branch
        .as_deref()
        .is_some_and(|branch| Some(branch) != default_branch.as_deref());
    let branch_name = if let Some(current) = source_branch.as_ref().filter(|_| reuse_current_branch)
    {
        if let Some(requested) = requested_branch
            && requested != current
        {
            return Err(WorktreeError::CurrentBranchConflict {
                current: current.clone(),
                requested: requested.to_string(),
            });
        }
        current.clone()
    } else {
        requested_branch.unwrap_or(automatic_branch).to_string()
    };
    if reuse_current_branch && !include_changes && source_is_dirty(&repository.root)? {
        return Err(WorktreeError::DirtyBranchRequiresTransfer {
            branch: branch_name,
        });
    }
    let mode = if include_changes {
        WorktreeIsolationMode::TransferChanges
    } else if reuse_current_branch {
        WorktreeIsolationMode::HandoffClean
    } else {
        WorktreeIsolationMode::CreateClean
    };
    validate_branch_name(&repository.root, &branch_name)?;
    if !reuse_current_branch && local_branch_exists(&repository.root, &branch_name)? {
        return Err(WorktreeError::BranchAlreadyExists(branch_name));
    }

    Ok(WorktreeTransferPlan {
        repository_root: repository.root,
        common_dir: metadata.common_dir,
        target: target.to_path_buf(),
        branch_name,
        head_sha,
        source_head_sha,
        reuse_current_branch,
        source_branch,
        mode,
    })
}

pub(crate) fn execute_worktree_transfer(
    plan: &WorktreeTransferPlan,
    transfer_id: &str,
) -> Result<WorktreeTransferOutcome, WorktreeError> {
    ensure_source_matches_plan(plan)?;
    let (checkout, source_warning) = match plan.mode {
        WorktreeIsolationMode::CreateClean => (
            create_prepared_worktree(&WorktreeCreationPlan {
                repository_root: plan.repository_root.clone(),
                common_dir: plan.common_dir.clone(),
                target: plan.target.clone(),
                branch_name: plan.branch_name.clone(),
                base_head: plan.head_sha.clone(),
            })?,
            None,
        ),
        WorktreeIsolationMode::HandoffClean => {
            if source_is_dirty(&plan.repository_root)? {
                return Err(WorktreeError::DirtyBranchRequiresTransfer {
                    branch: plan.branch_name.clone(),
                });
            }
            detach_source_branch(plan)?;
            let checkout =
                restore_attached_worktree(&plan.common_dir, &plan.target, &plan.branch_name)?;
            let warning = switch_source_to_default(&plan.repository_root, &plan.branch_name);
            (checkout, warning)
        }
        WorktreeIsolationMode::TransferChanges => {
            let _ = ensure_transfer_snapshot(&plan.repository_root, &plan.common_dir, transfer_id)?;
            let checkout = if plan.reuse_current_branch {
                detach_source_branch(plan)?;
                restore_attached_worktree(&plan.common_dir, &plan.target, &plan.branch_name)?
            } else {
                create_prepared_worktree(&WorktreeCreationPlan {
                    repository_root: plan.repository_root.clone(),
                    common_dir: plan.common_dir.clone(),
                    target: plan.target.clone(),
                    branch_name: plan.branch_name.clone(),
                    base_head: plan.head_sha.clone(),
                })?
            };
            apply_transfer_snapshot(&checkout.path, &plan.common_dir, transfer_id)?;
            let warning = switch_source_to_default(&plan.repository_root, &plan.branch_name);
            (checkout, warning)
        }
    };
    let checkout =
        inspect_attached_worktree(&checkout.path, &plan.common_dir, Some(&plan.branch_name))?;
    Ok(WorktreeTransferOutcome {
        checkout,
        source_warning,
    })
}

pub(crate) fn recover_worktree_transfer(
    common_dir: &Path,
    target: &Path,
    branch_name: &str,
    expected_head_sha: &str,
    transfer_id: &str,
    mode: WorktreeIsolationMode,
) -> Result<WorktreeTransferOutcome, WorktreeError> {
    let source = primary_checkout_for_common_dir(common_dir)?;
    reject_unresolved_operation(&source, common_dir)?;
    reject_dirty_submodules_or_nested_repositories(&source)?;
    if mode == WorktreeIsolationMode::TransferChanges {
        ensure_transfer_snapshot(&source, common_dir, transfer_id)?;
    }

    let checkout = if target.exists() {
        let checkout = inspect_attached_worktree(target, common_dir, Some(branch_name))?;
        if checkout.dirty {
            return Err(WorktreeError::Dirty(target.display().to_string()));
        }
        if checkout.head_sha != expected_head_sha {
            return Err(WorktreeError::BranchHeadMismatch {
                expected: expected_head_sha.to_string(),
                actual: checkout.head_sha,
            });
        }
        inspect_attached_worktree(target, common_dir, Some(branch_name))?
    } else if local_branch_exists_with_git_dir(common_dir, branch_name)? {
        if current_branch_name(&source)?.as_deref() == Some(branch_name) {
            let source_head =
                run_git_text(&source, "source HEAD inspection", ["rev-parse", "HEAD"])?;
            if source_head != expected_head_sha {
                return Err(WorktreeError::BranchHeadMismatch {
                    expected: expected_head_sha.to_string(),
                    actual: source_head,
                });
            }
            if mode != WorktreeIsolationMode::TransferChanges && source_is_dirty(&source)? {
                return Err(WorktreeError::Dirty(source.display().to_string()));
            }
            run_git(
                &source,
                "source branch handoff",
                ["switch", "--detach", expected_head_sha],
            )?;
        }
        restore_attached_worktree(common_dir, target, branch_name)?
    } else {
        create_prepared_worktree(&WorktreeCreationPlan {
            repository_root: source.clone(),
            common_dir: common_dir.to_path_buf(),
            target: target.to_path_buf(),
            branch_name: branch_name.to_string(),
            base_head: expected_head_sha.to_string(),
        })?
    };

    if mode == WorktreeIsolationMode::TransferChanges {
        apply_transfer_snapshot(&checkout.path, common_dir, transfer_id)?;
    }
    let checkout = inspect_attached_worktree(target, common_dir, Some(branch_name))?;
    let source_warning = if mode == WorktreeIsolationMode::CreateClean {
        None
    } else {
        switch_source_to_default(&source, branch_name)
    };
    Ok(WorktreeTransferOutcome {
        checkout,
        source_warning,
    })
}

pub(crate) fn delete_transfer_snapshot(
    common_dir: &Path,
    transfer_id: &str,
) -> Result<bool, WorktreeError> {
    let reference = transfer_reference(transfer_id);
    if !reference_exists(common_dir, &reference)? {
        return Ok(false);
    }
    run_git_dir(
        common_dir,
        "transfer snapshot cleanup",
        ["update-ref", "-d", &reference],
    )?;
    Ok(true)
}

pub(crate) fn create_prepared_worktree(
    plan: &WorktreeCreationPlan,
) -> Result<WorktreeCheckout, WorktreeError> {
    if let Some(parent) = plan.target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    run_git(
        &plan.repository_root,
        "worktree branch creation",
        ["branch", &plan.branch_name, &plan.base_head],
    )?;
    if let Err(error) = run_git(
        &plan.repository_root,
        "worktree creation",
        [
            "worktree",
            "add",
            path_text(&plan.target)?,
            &plan.branch_name,
        ],
    ) {
        let _ =
            delete_local_branch_if_matches(&plan.common_dir, &plan.branch_name, &plan.base_head);
        return Err(error);
    }

    match inspect_attached_worktree(&plan.target, &plan.common_dir, Some(&plan.branch_name)) {
        Ok(checkout) => Ok(checkout),
        Err(error) => {
            if run_git_dir(
                &plan.common_dir,
                "failed worktree cleanup",
                ["worktree", "remove", path_text(&plan.target)?],
            )
            .is_ok()
            {
                let _ = delete_local_branch_if_matches(
                    &plan.common_dir,
                    &plan.branch_name,
                    &plan.base_head,
                );
            }
            Err(error)
        }
    }
}

pub(crate) fn restore_attached_worktree(
    common_dir: &Path,
    target: &Path,
    branch_name: &str,
) -> Result<WorktreeCheckout, WorktreeError> {
    reject_symlink_target(target)?;
    if target.exists() {
        return Err(WorktreeError::TargetExists(target.display().to_string()));
    }
    validate_branch_name_with_git_dir(common_dir, branch_name)?;
    if !local_branch_exists_with_git_dir(common_dir, branch_name)? {
        return Err(WorktreeError::Command {
            operation: "worktree restoration",
            message: format!("local branch does not exist: {branch_name}"),
        });
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    run_git_dir(
        common_dir,
        "worktree restoration",
        ["worktree", "add", path_text(target)?, branch_name],
    )?;

    match inspect_attached_worktree(target, common_dir, Some(branch_name)) {
        Ok(checkout) => Ok(checkout),
        Err(error) => {
            run_git_dir(
                common_dir,
                "failed worktree restoration cleanup",
                ["worktree", "remove", path_text(target)?],
            )?;
            Err(error)
        }
    }
}

pub(crate) fn inspect_attached_worktree(
    target: &Path,
    expected_common_dir: &Path,
    expected_branch: Option<&str>,
) -> Result<WorktreeCheckout, WorktreeError> {
    reject_symlink_target(target)?;
    if !target.exists() {
        return Err(WorktreeError::TargetMissing(target.display().to_string()));
    }
    let repository = repository_for(target)
        .ok_or_else(|| WorktreeError::NotRepository(target.display().to_string()))?;
    let metadata = repository_metadata_paths(&repository)
        .ok_or_else(|| WorktreeError::MissingMetadata(target.display().to_string()))?;
    let expected_common_dir = expected_common_dir.canonicalize()?;
    if metadata.common_dir != expected_common_dir {
        return Err(WorktreeError::RepositoryMismatch {
            expected: expected_common_dir.display().to_string(),
            actual: metadata.common_dir.display().to_string(),
        });
    }
    let branch_name = run_git_text(target, "branch inspection", ["branch", "--show-current"])?;
    if branch_name.is_empty() {
        return Err(WorktreeError::Detached(target.display().to_string()));
    }
    if let Some(expected) = expected_branch
        && branch_name != expected
    {
        return Err(WorktreeError::BranchMismatch {
            expected: expected.to_string(),
            actual: branch_name,
        });
    }
    let head_sha = run_git_text(target, "HEAD inspection", ["rev-parse", "HEAD"])?;
    let dirty = !run_git_text(
        target,
        "status inspection",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
    )?
    .is_empty();

    Ok(WorktreeCheckout {
        path: target.canonicalize()?,
        common_dir: metadata.common_dir,
        branch_name,
        head_sha,
        dirty,
    })
}

pub(crate) fn remove_attached_worktree(
    target: &Path,
    expected_common_dir: &Path,
    expected_branch: &str,
) -> Result<WorktreeCheckout, WorktreeError> {
    let checkout = inspect_attached_worktree(target, expected_common_dir, Some(expected_branch))?;
    if checkout.dirty {
        return Err(WorktreeError::Dirty(target.display().to_string()));
    }
    run_git_dir(
        &checkout.common_dir,
        "worktree removal",
        ["worktree", "remove", path_text(&checkout.path)?],
    )?;
    if checkout.path.exists() {
        return Err(WorktreeError::Command {
            operation: "worktree removal",
            message: format!("target still exists: {}", checkout.path.display()),
        });
    }
    Ok(checkout)
}

fn ensure_source_matches_plan(plan: &WorktreeTransferPlan) -> Result<(), WorktreeError> {
    let actual_head = run_git_text(
        &plan.repository_root,
        "source HEAD inspection",
        ["rev-parse", "HEAD"],
    )?;
    if actual_head != plan.source_head_sha {
        return Err(WorktreeError::BranchHeadMismatch {
            expected: plan.source_head_sha.clone(),
            actual: actual_head,
        });
    }
    let current_branch = current_branch_name(&plan.repository_root)?;
    if current_branch != plan.source_branch {
        return Err(WorktreeError::BranchMismatch {
            expected: plan.source_branch.as_deref().unwrap_or("HEAD").to_string(),
            actual: current_branch.unwrap_or_else(|| "HEAD".to_string()),
        });
    }
    reject_unresolved_operation(&plan.repository_root, &plan.common_dir)?;
    reject_dirty_submodules_or_nested_repositories(&plan.repository_root)
}

fn detach_source_branch(plan: &WorktreeTransferPlan) -> Result<(), WorktreeError> {
    run_git(
        &plan.repository_root,
        "source branch handoff",
        ["switch", "--detach", &plan.head_sha],
    )?;
    Ok(())
}

fn ensure_transfer_snapshot(
    source: &Path,
    common_dir: &Path,
    transfer_id: &str,
) -> Result<bool, WorktreeError> {
    let reference = transfer_reference(transfer_id);
    if reference_exists(common_dir, &reference)? {
        return Ok(true);
    }
    let marker = transfer_marker(transfer_id);
    if let Some(oid) = find_transfer_stash(common_dir, &marker)? {
        anchor_transfer_snapshot(common_dir, &reference, &oid)?;
        return Ok(true);
    }
    if !source_is_dirty(source)? {
        return Ok(false);
    }

    run_git(
        source,
        "worktree transfer snapshot",
        ["stash", "push", "--include-untracked", "-m", &marker],
    )?;
    let oid = run_git_dir_text(
        common_dir,
        "worktree transfer snapshot lookup",
        ["rev-parse", "--verify", "refs/stash"],
    )?;
    let subject = run_git_dir_text(
        common_dir,
        "worktree transfer snapshot verification",
        ["log", "-g", "-1", "--format=%gs", "refs/stash"],
    )?;
    if !subject.ends_with(&marker) {
        return Err(WorktreeError::MissingTransferSnapshot(marker));
    }
    anchor_transfer_snapshot(common_dir, &reference, &oid)?;
    let _ = run_git_dir(
        common_dir,
        "worktree transfer stash cleanup",
        ["stash", "drop", "stash@{0}"],
    );
    Ok(true)
}

fn anchor_transfer_snapshot(
    common_dir: &Path,
    reference: &str,
    oid: &str,
) -> Result<(), WorktreeError> {
    run_git_dir(
        common_dir,
        "worktree transfer snapshot protection",
        ["update-ref", reference, oid],
    )?;
    Ok(())
}

fn find_transfer_stash(common_dir: &Path, marker: &str) -> Result<Option<String>, WorktreeError> {
    if !reference_exists(common_dir, "refs/stash")? {
        return Ok(None);
    }
    let output = run_git_dir_text(
        common_dir,
        "worktree transfer stash search",
        ["log", "-g", "--format=%H%x09%gs", "refs/stash"],
    )?;
    Ok(output.lines().find_map(|line| {
        let (oid, subject) = line.split_once('\t')?;
        subject.ends_with(marker).then(|| oid.to_string())
    }))
}

fn apply_transfer_snapshot(
    target: &Path,
    common_dir: &Path,
    transfer_id: &str,
) -> Result<(), WorktreeError> {
    let reference = transfer_reference(transfer_id);
    if !reference_exists(common_dir, &reference)? {
        return Ok(());
    }
    run_git(
        target,
        "worktree transfer snapshot application",
        ["stash", "apply", "--index", &reference],
    )?;
    Ok(())
}

fn switch_source_to_default(source: &Path, transferred_branch: &str) -> Option<String> {
    let current = current_branch_name(source).ok().flatten();
    let default = default_local_branch(source, current.as_deref())
        .ok()
        .flatten();
    let default = default.filter(|default| default != transferred_branch)?;
    match run_git(
        source,
        "source default branch checkout",
        ["switch", &default],
    ) {
        Ok(_) => None,
        Err(error) => Some(error.to_string()),
    }
}

fn primary_checkout_for_common_dir(common_dir: &Path) -> Result<PathBuf, WorktreeError> {
    if common_dir.file_name().is_some_and(|name| name == ".git") {
        let source = common_dir
            .parent()
            .ok_or_else(|| WorktreeError::MissingMetadata(common_dir.display().to_string()))?;
        return source.canonicalize().map_err(Into::into);
    }
    Err(WorktreeError::LinkedSource(
        common_dir.display().to_string(),
    ))
}

fn current_branch_name(repository: &Path) -> Result<Option<String>, WorktreeError> {
    let branch = run_git_text(
        repository,
        "current branch inspection",
        ["branch", "--show-current"],
    )?;
    Ok((!branch.is_empty()).then_some(branch))
}

fn default_local_branch(
    repository: &Path,
    current_branch: Option<&str>,
) -> Result<Option<String>, WorktreeError> {
    let remote_head = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args([
            "symbolic-ref",
            "--quiet",
            "--short",
            "refs/remotes/origin/HEAD",
        ])
        .output()?;
    if remote_head.status.success() {
        let remote = String::from_utf8_lossy(&remote_head.stdout)
            .trim_end()
            .to_string();
        if let Some(branch) = remote.strip_prefix("origin/")
            && local_branch_exists(repository, branch)?
        {
            return Ok(Some(branch.to_string()));
        }
    }
    for candidate in ["main", "master"] {
        if local_branch_exists(repository, candidate)? {
            return Ok(Some(candidate.to_string()));
        }
    }
    Ok(current_branch.map(str::to_string))
}

fn source_is_dirty(repository: &Path) -> Result<bool, WorktreeError> {
    Ok(!run_git_text(
        repository,
        "source status inspection",
        ["status", "--porcelain=v1", "--untracked-files=normal"],
    )?
    .is_empty())
}

fn has_unmerged_entries(repository: &Path) -> Result<bool, WorktreeError> {
    Ok(!run_git_text(
        repository,
        "unmerged path inspection",
        ["diff", "--name-only", "--diff-filter=U"],
    )?
    .is_empty())
}

fn reject_unresolved_operation(repository: &Path, git_dir: &Path) -> Result<(), WorktreeError> {
    let operation_paths = [
        "MERGE_HEAD",
        "CHERRY_PICK_HEAD",
        "REVERT_HEAD",
        "rebase-apply",
        "rebase-merge",
        "sequencer",
    ];
    if has_unmerged_entries(repository)?
        || operation_paths
            .iter()
            .any(|path| git_dir.join(path).exists())
    {
        return Err(WorktreeError::UnresolvedOperation(
            repository.display().to_string(),
        ));
    }
    Ok(())
}

fn reject_dirty_submodules_or_nested_repositories(repository: &Path) -> Result<(), WorktreeError> {
    let submodule_status = run_git(
        repository,
        "submodule status inspection",
        ["status", "--porcelain=v1", "-z", "--ignore-submodules=none"],
    )?;
    for path in porcelain_status_paths(&submodule_status.stdout) {
        if repository.join(&path).join(".git").exists() {
            return Err(WorktreeError::DirtySubmodule(
                path.to_string_lossy().into_owned(),
            ));
        }
    }
    let untracked = run_git(
        repository,
        "nested repository inspection",
        ["ls-files", "--others", "--exclude-standard", "-z"],
    )?;
    for path in nul_paths(&untracked.stdout) {
        let candidate = repository.join(&path);
        if candidate.is_dir() && candidate.join(".git").exists() {
            return Err(WorktreeError::DirtySubmodule(
                path.to_string_lossy().into_owned(),
            ));
        }
    }
    Ok(())
}

fn porcelain_status_paths(output: &[u8]) -> Vec<PathBuf> {
    let mut fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty());
    let mut paths = Vec::new();
    while let Some(entry) = fields.next() {
        if entry.len() < 4 {
            continue;
        }
        let renamed_or_copied = matches!(entry[0], b'R' | b'C') || matches!(entry[1], b'R' | b'C');
        paths.push(path_from_git_bytes(&entry[3..]));
        if renamed_or_copied {
            let _ = fields.next();
        }
    }
    paths
}

fn nul_paths(output: &[u8]) -> impl Iterator<Item = PathBuf> + '_ {
    output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .map(path_from_git_bytes)
}

#[cfg(unix)]
fn path_from_git_bytes(path: &[u8]) -> PathBuf {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};

    PathBuf::from(OsStr::from_bytes(path))
}

#[cfg(not(unix))]
fn path_from_git_bytes(path: &[u8]) -> PathBuf {
    PathBuf::from(String::from_utf8_lossy(path).into_owned())
}

fn reference_exists(common_dir: &Path, reference: &str) -> Result<bool, WorktreeError> {
    command_succeeds(
        Command::new("git")
            .arg("--git-dir")
            .arg(common_dir)
            .args(["show-ref", "--verify", "--quiet", reference]),
        "transfer snapshot lookup",
    )
}

fn transfer_marker(transfer_id: &str) -> String {
    format!("caffold-transfer:{transfer_id}")
}

fn transfer_reference(transfer_id: &str) -> String {
    format!("refs/caffold/transfers/{transfer_id}")
}

fn reject_symlink_target(target: &Path) -> Result<(), WorktreeError> {
    match std::fs::symlink_metadata(target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(WorktreeError::TargetSymlink(target.display().to_string()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn delete_local_branch_if_matches(
    common_dir: &Path,
    branch_name: &str,
    expected_head_sha: &str,
) -> Result<bool, WorktreeError> {
    validate_branch_name_with_git_dir(common_dir, branch_name)?;
    if !local_branch_exists_with_git_dir(common_dir, branch_name)? {
        return Ok(false);
    }
    let reference = format!("refs/heads/{branch_name}");
    let actual = run_git_dir_text(
        common_dir,
        "branch head inspection",
        ["rev-parse", "--verify", &reference],
    )?;
    if actual != expected_head_sha {
        return Err(WorktreeError::BranchHeadMismatch {
            expected: expected_head_sha.to_string(),
            actual,
        });
    }
    run_git_dir(
        common_dir,
        "branch deletion",
        ["update-ref", "-d", &reference, expected_head_sha],
    )?;
    Ok(true)
}

fn validate_branch_name(repository: &Path, branch_name: &str) -> Result<(), WorktreeError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["check-ref-format", "--branch", branch_name])
        .output()?;
    validate_branch_output(output, branch_name)
}

fn validate_branch_name_with_git_dir(
    common_dir: &Path,
    branch_name: &str,
) -> Result<(), WorktreeError> {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(common_dir)
        .args(["check-ref-format", "--branch", branch_name])
        .output()?;
    validate_branch_output(output, branch_name)
}

fn validate_branch_output(output: Output, branch_name: &str) -> Result<(), WorktreeError> {
    if output.status.success() && String::from_utf8_lossy(&output.stdout).trim_end() == branch_name
    {
        Ok(())
    } else {
        Err(WorktreeError::InvalidBranch(branch_name.to_string()))
    }
}

fn local_branch_exists(repository: &Path, branch_name: &str) -> Result<bool, WorktreeError> {
    let reference = format!("refs/heads/{branch_name}");
    command_succeeds(
        Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(["show-ref", "--verify", "--quiet", &reference]),
        "branch lookup",
    )
}

fn local_branch_exists_with_git_dir(
    common_dir: &Path,
    branch_name: &str,
) -> Result<bool, WorktreeError> {
    let reference = format!("refs/heads/{branch_name}");
    command_succeeds(
        Command::new("git")
            .arg("--git-dir")
            .arg(common_dir)
            .args(["show-ref", "--verify", "--quiet", &reference]),
        "branch lookup",
    )
}

fn command_succeeds(command: &mut Command, operation: &'static str) -> Result<bool, WorktreeError> {
    let output = command.output()?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(command_error(operation, output)),
    }
}

fn verify_commit(repository: &Path, reference: &str) -> Result<String, WorktreeError> {
    let commit = format!("{reference}^{{commit}}");
    run_git_text(
        repository,
        "base revision lookup",
        [
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &commit,
        ],
    )
}

fn run_git<'a>(
    repository: &Path,
    operation: &'static str,
    args: impl IntoIterator<Item = &'a str>,
) -> Result<Output, WorktreeError> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .output()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_error(operation, output))
    }
}

fn run_git_dir<'a>(
    common_dir: &Path,
    operation: &'static str,
    args: impl IntoIterator<Item = &'a str>,
) -> Result<Output, WorktreeError> {
    let output = Command::new("git")
        .arg("--git-dir")
        .arg(common_dir)
        .args(args)
        .output()?;
    if output.status.success() {
        Ok(output)
    } else {
        Err(command_error(operation, output))
    }
}

fn run_git_text<'a>(
    repository: &Path,
    operation: &'static str,
    args: impl IntoIterator<Item = &'a str>,
) -> Result<String, WorktreeError> {
    let output = run_git(repository, operation, args)?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn run_git_dir_text<'a>(
    common_dir: &Path,
    operation: &'static str,
    args: impl IntoIterator<Item = &'a str>,
) -> Result<String, WorktreeError> {
    let output = run_git_dir(common_dir, operation, args)?;
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

fn command_error(operation: &'static str, output: Output) -> WorktreeError {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    WorktreeError::Command {
        operation,
        message: if stderr.is_empty() { stdout } else { stderr },
    }
}

fn path_text(path: &Path) -> Result<&str, WorktreeError> {
    path.to_str().ok_or_else(|| WorktreeError::Command {
        operation: "path conversion",
        message: format!("path is not valid UTF-8: {}", path.display()),
    })
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use super::*;

    #[test]
    fn creates_removes_and_restores_a_branch_attached_worktree() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);

        let repository = managed_repository(&source).unwrap();
        let created = create_attached_worktree(&source, &target, "caffold/test", None).unwrap();
        assert_eq!(created.common_dir, repository.common_dir);
        assert_eq!(created.branch_name, "caffold/test");
        assert_eq!(created.head_sha, repository.head_sha);
        assert!(!created.dirty);

        let removed = remove_attached_worktree(
            &target,
            &repository.common_dir,
            created.branch_name.as_str(),
        )
        .unwrap();
        assert_eq!(removed, created);
        assert!(!target.exists());

        assert!(
            delete_local_branch_if_matches(
                &repository.common_dir,
                created.branch_name.as_str(),
                &created.head_sha,
            )
            .unwrap()
        );
        assert!(!local_branch_exists(&source, "caffold/test").unwrap());

        git(&source, &["branch", "caffold/test", &created.head_sha]);

        let restored = restore_attached_worktree(
            &repository.common_dir,
            &target,
            created.branch_name.as_str(),
        )
        .unwrap();
        assert_eq!(restored.branch_name, created.branch_name);
        assert_eq!(restored.head_sha, created.head_sha);
        assert!(target.exists());
    }

    #[test]
    fn cleans_up_the_branch_when_prepared_creation_fails() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        let plan = prepare_attached_worktree(&source, &target, "caffold/failed", None).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("occupied"), "do not replace\n").unwrap();

        assert!(matches!(
            create_prepared_worktree(&plan),
            Err(WorktreeError::Command {
                operation: "worktree creation",
                ..
            })
        ));
        assert!(!local_branch_exists(&source, &plan.branch_name).unwrap());
    }

    #[test]
    fn deletes_only_the_expected_unbound_branch_revision() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);

        let created = create_attached_worktree(&source, &target, "caffold/test", None).unwrap();
        remove_attached_worktree(&target, &created.common_dir, &created.branch_name).unwrap();

        assert!(matches!(
            delete_local_branch_if_matches(&created.common_dir, &created.branch_name, "deadbeef"),
            Err(WorktreeError::BranchHeadMismatch { .. })
        ));
        assert!(local_branch_exists(&source, "caffold/test").unwrap());
    }

    #[test]
    fn refuses_to_remove_dirty_or_mismatched_worktrees() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);

        let created = create_attached_worktree(&source, &target, "caffold/test", None).unwrap();
        fs::write(target.join("untracked.txt"), "dirty\n").unwrap();
        assert!(matches!(
            remove_attached_worktree(&target, &created.common_dir, "caffold/test"),
            Err(WorktreeError::Dirty(_))
        ));
        assert!(matches!(
            inspect_attached_worktree(&target, &created.common_dir, Some("other")),
            Err(WorktreeError::BranchMismatch { .. })
        ));
        assert!(target.exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_to_inspect_or_remove_a_symlinked_worktree_target() {
        use std::os::unix::fs::symlink;

        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let external = temp.path().join("external-worktree");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        let created =
            create_attached_worktree(&source, &external, "caffold/external", None).unwrap();
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        symlink(&external, &target).unwrap();

        assert!(matches!(
            inspect_attached_worktree(&target, &created.common_dir, Some(&created.branch_name)),
            Err(WorktreeError::TargetSymlink(path)) if path == target.display().to_string()
        ));
        assert!(matches!(
            prepare_attached_worktree(&source, &target, "caffold/rejected", None),
            Err(WorktreeError::TargetSymlink(path)) if path == target.display().to_string()
        ));
        assert!(matches!(
            restore_attached_worktree(&created.common_dir, &target, &created.branch_name),
            Err(WorktreeError::TargetSymlink(path)) if path == target.display().to_string()
        ));
        assert!(matches!(
            remove_attached_worktree(&target, &created.common_dir, &created.branch_name),
            Err(WorktreeError::TargetSymlink(path)) if path == target.display().to_string()
        ));
        assert!(external.is_dir());
        assert_eq!(
            run_git_text(&external, "test HEAD", ["rev-parse", "HEAD"]).unwrap(),
            created.head_sha
        );
    }

    #[test]
    fn rejects_invalid_or_existing_branches_and_existing_targets() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);

        let target = temp.path().join("managed/worktree-one");
        assert!(matches!(
            create_attached_worktree(&source, &target, "bad..branch", None),
            Err(WorktreeError::InvalidBranch(_))
        ));
        git(&source, &["branch", "caffold/existing"]);
        assert!(matches!(
            create_attached_worktree(&source, &target, "caffold/existing", None),
            Err(WorktreeError::BranchAlreadyExists(_))
        ));
        fs::create_dir_all(&target).unwrap();
        assert!(matches!(
            create_attached_worktree(&source, &target, "caffold/new", None),
            Err(WorktreeError::TargetExists(_))
        ));
        let repository = managed_repository(&source).unwrap();
        assert!(matches!(
            restore_attached_worktree(&repository.common_dir, &target, "caffold/existing"),
            Err(WorktreeError::TargetExists(_))
        ));

        let missing = temp.path().join("managed/missing");
        assert!(matches!(
            inspect_attached_worktree(&missing, &repository.common_dir, None),
            Err(WorktreeError::TargetMissing(_))
        ));
        assert!(
            !delete_local_branch_if_matches(
                &repository.common_dir,
                "caffold/missing",
                &repository.head_sha,
            )
            .unwrap()
        );
    }

    #[test]
    fn transfer_planning_preserves_feature_branches_and_requires_a_base_for_linked_sources() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let linked = temp.path().join("linked");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        git(&source, &["branch", "-M", "main"]);
        git(&source, &["switch", "-c", "review/pr-42"]);

        let plan = prepare_worktree_transfer(
            &source,
            &target,
            "caffold/unused",
            Some("review/pr-42"),
            None,
            false,
        )
        .unwrap();
        assert!(plan.reuse_current_branch);
        assert_eq!(plan.branch_name, "review/pr-42");
        assert_eq!(plan.mode, WorktreeIsolationMode::HandoffClean);
        assert!(matches!(
            prepare_worktree_transfer(
                &source,
                &target,
                "caffold/unused",
                Some("review/renamed"),
                None,
                false,
            ),
            Err(WorktreeError::CurrentBranchConflict { current, requested })
                if current == "review/pr-42" && requested == "review/renamed"
        ));

        git(&source, &["switch", "main"]);
        git(
            &source,
            &[
                "worktree",
                "add",
                "-b",
                "external/review",
                linked.to_str().unwrap(),
                "HEAD",
            ],
        );
        assert!(matches!(
            prepare_worktree_transfer(&linked, &target, "caffold/linked", None, None, false),
            Err(WorktreeError::LinkedSource(path)) if path == linked.display().to_string()
        ));

        let selected_base = prepare_worktree_transfer(
            &linked,
            &target,
            "caffold/linked",
            None,
            Some("main"),
            false,
        )
        .unwrap();
        assert!(!selected_base.reuse_current_branch);
        assert_eq!(selected_base.branch_name, "caffold/linked");
        assert_eq!(selected_base.mode, WorktreeIsolationMode::CreateClean);
        assert_eq!(
            selected_base.head_sha,
            run_git_text(&source, "test selected base", ["rev-parse", "main"]).unwrap()
        );
    }

    #[test]
    fn transfer_planning_rejects_an_untracked_nested_repository() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let nested = source.join("nested");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        fs::create_dir(&nested).unwrap();
        git(&nested, &["init"]);

        assert!(matches!(
            prepare_worktree_transfer(&source, &target, "caffold/nested", None, None, false),
            Err(WorktreeError::DirtySubmodule(path)) if path == "nested/"
        ));
    }

    #[test]
    fn transfer_planning_rejects_a_dirty_tracked_nested_repository_with_spaces() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let nested = source.join("nested repo");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        fs::create_dir(&nested).unwrap();
        git(&nested, &["init"]);
        git(&nested, &["config", "user.email", "test@example.com"]);
        git(&nested, &["config", "user.name", "Caffold Test"]);
        fs::write(nested.join("inner.txt"), "initial\n").unwrap();
        git(&nested, &["add", "inner.txt"]);
        git(&nested, &["commit", "-m", "Nested initial"]);
        git(&source, &["add", "nested repo"]);
        git(&source, &["commit", "-m", "Track nested repository"]);
        fs::write(nested.join("inner.txt"), "dirty\n").unwrap();

        assert!(matches!(
            prepare_worktree_transfer(&source, &target, "caffold/nested", None, None, true),
            Err(WorktreeError::DirtySubmodule(path)) if path == "nested repo"
        ));
    }

    #[test]
    fn transfer_planning_rejects_an_unresolved_merge() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "base\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        git(&source, &["branch", "-M", "main"]);
        git(&source, &["switch", "-c", "conflicting"]);
        fs::write(source.join("README.md"), "branch\n").unwrap();
        git(&source, &["commit", "-am", "Branch change"]);
        git(&source, &["switch", "main"]);
        fs::write(source.join("README.md"), "main\n").unwrap();
        git(&source, &["commit", "-am", "Main change"]);
        let merge = Command::new("git")
            .arg("-C")
            .arg(&source)
            .args(["merge", "conflicting"])
            .output()
            .unwrap();
        assert!(!merge.status.success());

        assert!(matches!(
            prepare_worktree_transfer(&source, &target, "caffold/conflict", None, None, false),
            Err(WorktreeError::UnresolvedOperation(_))
        ));
    }

    #[test]
    fn rejects_a_worktree_from_another_repository() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        let target = temp.path().join("managed/worktree-one");
        for source in [&first, &second] {
            fs::create_dir(source).unwrap();
            git(source, &["init"]);
            git(source, &["config", "user.email", "test@example.com"]);
            git(source, &["config", "user.name", "Caffold Test"]);
            fs::write(source.join("README.md"), "initial\n").unwrap();
            git(source, &["add", "README.md"]);
            git(source, &["commit", "-m", "Initial"]);
        }
        let created = create_attached_worktree(&first, &target, "caffold/first", None).unwrap();
        let other = managed_repository(&second).unwrap();

        assert!(matches!(
            inspect_attached_worktree(&target, &other.common_dir, Some(&created.branch_name)),
            Err(WorktreeError::RepositoryMismatch { .. })
        ));

        remove_attached_worktree(&target, &created.common_dir, &created.branch_name).unwrap();
        delete_local_branch_if_matches(
            &created.common_dir,
            &created.branch_name,
            &created.head_sha,
        )
        .unwrap();
    }

    #[test]
    fn rejects_a_detached_worktree() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        let repository = managed_repository(&source).unwrap();
        let target_text = target.to_str().unwrap();
        git(
            &source,
            &["worktree", "add", "--detach", target_text, "HEAD"],
        );

        assert!(matches!(
            inspect_attached_worktree(&target, &repository.common_dir, None),
            Err(WorktreeError::Detached(path)) if path == target.display().to_string()
        ));

        git(&source, &["worktree", "remove", target_text]);
    }

    #[test]
    fn resolves_an_explicit_base_before_passing_it_to_worktree_add() {
        if !git_is_available() {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("repository");
        let target = temp.path().join("managed/worktree-one");
        fs::create_dir(&source).unwrap();
        git(&source, &["init"]);
        git(&source, &["config", "user.email", "test@example.com"]);
        git(&source, &["config", "user.name", "Caffold Test"]);
        fs::write(source.join("README.md"), "initial\n").unwrap();
        git(&source, &["add", "README.md"]);
        git(&source, &["commit", "-m", "Initial"]);
        let initial = run_git_text(&source, "test HEAD", ["rev-parse", "HEAD"]).unwrap();
        fs::write(source.join("README.md"), "second\n").unwrap();
        git(&source, &["commit", "-am", "Second"]);

        let created =
            create_attached_worktree(&source, &target, "caffold/old-base", Some("HEAD~1")).unwrap();

        assert_eq!(created.head_sha, initial);
        assert_eq!(
            run_git_text(&target, "test HEAD", ["rev-parse", "HEAD"]).unwrap(),
            initial
        );
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

    fn git_is_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }
}
