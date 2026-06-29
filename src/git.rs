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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub repo_relative_path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
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

pub fn status_entries(repository: &Repository) -> Option<Vec<StatusEntry>> {
    let output = run_git_bytes(
        &repository.root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;

    Some(parse_status_entries(&output))
}

pub fn diff(repository: &Repository, repo_relative_path: &str, kind: &str) -> Option<String> {
    let null_path = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let args = match kind {
        "staged" => vec!["diff", "--cached", "--", repo_relative_path],
        "untracked" => vec!["diff", "--no-index", "--", null_path, repo_relative_path],
        _ => vec!["diff", "--", repo_relative_path],
    };

    let output = if kind == "untracked" {
        run_git_allowing_status(&repository.root, &args, &[0, 1])?
    } else {
        run_git_bytes(&repository.root, &args)?
    };

    String::from_utf8(output)
        .ok()
        .map(|stdout| stdout.trim_end().to_string())
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
    String::from_utf8(run_git_bytes(path, args)?)
        .ok()
        .map(|stdout| stdout.trim_end().to_string())
}

fn run_git_bytes(path: &Path, args: &[&str]) -> Option<Vec<u8>> {
    run_git_allowing_status(path, args, &[0])
}

fn run_git_allowing_status(path: &Path, args: &[&str], allowed_codes: &[i32]) -> Option<Vec<u8>> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;

    let status_code = output.status.code()?;
    if !allowed_codes.contains(&status_code) {
        return None;
    }

    Some(output.stdout)
}

fn parse_status_entries(output: &[u8]) -> Vec<StatusEntry> {
    let mut records = output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty());
    let mut entries = Vec::new();

    while let Some(record) = records.next() {
        if record.len() < 4 {
            continue;
        }

        let staged = record[0] as char;
        let unstaged = record[1] as char;
        let repo_relative_path = String::from_utf8_lossy(&record[3..]).into_owned();

        if matches!(staged, 'R' | 'C') {
            let _old_path = records.next();
        }

        entries.push(StatusEntry {
            repo_relative_path,
            status: format!("{staged}{unstaged}"),
            staged: staged != ' ' && staged != '?',
            unstaged: unstaged != ' ' && unstaged != '?',
            untracked: staged == '?' && unstaged == '?',
        });
    }

    entries
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

    #[test]
    fn parses_porcelain_z_status_entries() {
        let entries = parse_status_entries(b" M src/main.rs\0?? notes/todo.md\0");

        assert_eq!(
            entries,
            vec![
                StatusEntry {
                    repo_relative_path: "src/main.rs".to_string(),
                    status: " M".to_string(),
                    staged: false,
                    unstaged: true,
                    untracked: false,
                },
                StatusEntry {
                    repo_relative_path: "notes/todo.md".to_string(),
                    status: "??".to_string(),
                    staged: false,
                    unstaged: false,
                    untracked: true,
                },
            ]
        );
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
