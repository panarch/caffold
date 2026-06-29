use std::{
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repository {
    pub root: PathBuf,
    pub branch: Option<String>,
    pub dirty: bool,
}

pub fn repository_for(path: &Path) -> Option<Repository> {
    let root = PathBuf::from(run_git(path, &["rev-parse", "--show-toplevel"])?)
        .canonicalize()
        .ok()?;
    let branch = current_branch(path);
    let dirty = run_git(
        path,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )
    .map(|output| !output.is_empty())
    .unwrap_or(false);

    Some(Repository {
        root,
        branch,
        dirty,
    })
}

pub fn has_git_marker(path: &Path) -> bool {
    path.join(".git").exists()
}

fn current_branch(path: &Path) -> Option<String> {
    let branch = run_git(path, &["branch", "--show-current"])?;
    if !branch.is_empty() {
        return Some(branch);
    }

    run_git(path, &["rev-parse", "--short", "HEAD"])
        .filter(|head| !head.is_empty())
        .map(|head| format!("HEAD {head}"))
}

fn run_git(path: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    String::from_utf8(output.stdout)
        .ok()
        .map(|stdout| stdout.trim_end().to_string())
}

#[cfg(test)]
mod tests {
    use std::{fs, process::Command};

    use super::*;

    #[test]
    fn detects_repository_root_and_dirty_state() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        fs::write(temp.path().join("new.txt"), "hello").unwrap();

        let repository = repository_for(temp.path()).unwrap();

        assert_eq!(repository.root, temp.path().canonicalize().unwrap());
        assert!(repository.branch.is_some());
        assert!(repository.dirty);
    }

    fn git_is_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
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
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
