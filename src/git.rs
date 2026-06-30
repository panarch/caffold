use std::{
    collections::HashSet,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitFile {
    pub repo_relative_path: String,
    pub status: String,
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

pub fn ignored_paths(
    repository: &Repository,
    repo_relative_paths: impl IntoIterator<Item = String>,
) -> HashSet<String> {
    let input = repo_relative_paths
        .into_iter()
        .filter(|path| !path.is_empty())
        .collect::<Vec<_>>()
        .join("\0");

    if input.is_empty() {
        return HashSet::new();
    }

    let input = format!("{input}\0");
    let Some(output) = run_git_with_stdin_allowing_status(
        &repository.root,
        &["check-ignore", "-z", "--stdin"],
        input.as_bytes(),
        &[0, 1],
    ) else {
        return HashSet::new();
    };

    output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| String::from_utf8_lossy(record).into_owned())
        .collect()
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

pub fn log_count(repository: &Repository) -> Option<usize> {
    let output = run_git_owned_allowing_status(
        &repository.root,
        &[
            "rev-list".to_string(),
            "--count".to_string(),
            "HEAD".to_string(),
        ],
        &[0, 128],
    )?;
    let count = String::from_utf8_lossy(&output);
    let count = count.trim();
    if count.is_empty() {
        return Some(0);
    }

    count.parse().ok()
}

pub fn log_entries(repository: &Repository, page: usize, per_page: usize) -> Option<Vec<LogEntry>> {
    let per_page = per_page.clamp(1, 100);
    let offset = page.saturating_sub(1).saturating_mul(per_page);
    let args = vec![
        "log".to_string(),
        "--date=unix".to_string(),
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e".to_string(),
        "--skip".to_string(),
        offset.to_string(),
        "-n".to_string(),
        per_page.to_string(),
    ];
    let output = run_git_owned_allowing_status(&repository.root, &args, &[0, 128])?;
    Some(parse_log_entries(&output))
}

pub fn commit_summary(repository: &Repository, commit_sha: &str) -> Option<LogEntry> {
    let commit_sha = normalize_commit_sha(commit_sha)?;
    let args = vec![
        "log".to_string(),
        "--date=unix".to_string(),
        "--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%b%x1e".to_string(),
        "-n".to_string(),
        "1".to_string(),
        commit_sha.to_string(),
    ];
    parse_log_entries(&run_git_owned(&repository.root, &args)?)
        .into_iter()
        .next()
}

pub fn commit_files(repository: &Repository, commit_sha: &str) -> Option<Vec<CommitFile>> {
    let commit_sha = normalize_commit_sha(commit_sha)?;
    let args = vec![
        "show".to_string(),
        "--format=".to_string(),
        "--name-status".to_string(),
        "--find-renames".to_string(),
        "--first-parent".to_string(),
        commit_sha.to_string(),
    ];

    let output = run_git_owned(&repository.root, &args)?;
    Some(parse_commit_files(&output))
}

pub fn commit_diff(
    repository: &Repository,
    commit_sha: &str,
    repo_relative_path: &str,
) -> Option<String> {
    if repo_relative_path.is_empty() {
        return None;
    }

    let commit_sha = normalize_commit_sha(commit_sha)?;
    let args = vec![
        "show".to_string(),
        "--format=".to_string(),
        "--first-parent".to_string(),
        "--find-renames".to_string(),
        commit_sha.to_string(),
        "--".to_string(),
        repo_relative_path.to_string(),
    ];

    String::from_utf8(run_git_owned(&repository.root, &args)?)
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

fn run_git_owned(path: &Path, args: &[String]) -> Option<Vec<u8>> {
    run_git_owned_allowing_status(path, args, &[0])
}

fn run_git_owned_allowing_status(
    path: &Path,
    args: &[String],
    allowed_codes: &[i32],
) -> Option<Vec<u8>> {
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

fn run_git_with_stdin_allowing_status(
    path: &Path,
    args: &[&str],
    input: &[u8],
    allowed_codes: &[i32],
) -> Option<Vec<u8>> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .ok()?;

    child.stdin.as_mut()?.write_all(input).ok()?;

    let output = child.wait_with_output().ok()?;
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

fn parse_log_entries(output: &[u8]) -> Vec<LogEntry> {
    String::from_utf8_lossy(output)
        .split('\x1e')
        .filter_map(parse_log_entry)
        .collect()
}

fn parse_log_entry(record: &str) -> Option<LogEntry> {
    let record = record.trim_start_matches('\n').trim_end_matches('\n');
    if record.is_empty() {
        return None;
    }

    let mut parts = record.splitn(7, '\x1f');
    let sha = parts.next()?.to_string();
    let short_sha = parts.next()?.to_string();
    let author_name = parts.next()?.to_string();
    let author_email = parts.next()?.to_string();
    let author_time_ms = parts.next()?.parse::<u64>().ok()? * 1000;
    let subject = parts.next()?.to_string();
    let body = parts
        .next()
        .unwrap_or("")
        .trim_end_matches('\n')
        .to_string();

    Some(LogEntry {
        sha,
        short_sha,
        subject,
        body,
        author_name,
        author_email,
        author_time_ms,
    })
}

fn parse_commit_files(output: &[u8]) -> Vec<CommitFile> {
    String::from_utf8_lossy(output)
        .lines()
        .filter_map(parse_commit_file)
        .collect()
}

fn parse_commit_file(line: &str) -> Option<CommitFile> {
    let mut parts = line.split('\t');
    let raw_status = parts.next()?;
    let first_path = parts.next()?;
    let status = raw_status.chars().next()?.to_string();
    let repo_relative_path = if matches!(status.as_str(), "R" | "C") {
        parts.next().unwrap_or(first_path)
    } else {
        first_path
    };

    Some(CommitFile {
        repo_relative_path: repo_relative_path.to_string(),
        status,
    })
}

fn normalize_commit_sha(commit_sha: &str) -> Option<&str> {
    let commit_sha = commit_sha.trim();
    let valid_length = (4..=64).contains(&commit_sha.len());
    let valid_chars = commit_sha.bytes().all(|byte| byte.is_ascii_hexdigit());

    (valid_length && valid_chars).then_some(commit_sha)
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

    #[test]
    fn detects_ignored_paths() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        fs::write(temp.path().join(".gitignore"), "ignored.log\nbuild/\n").unwrap();
        fs::write(temp.path().join("ignored.log"), "ignore me").unwrap();
        fs::write(temp.path().join("visible.log"), "show me").unwrap();
        fs::create_dir(temp.path().join("build")).unwrap();

        let repository = repository_for(temp.path()).unwrap();
        let ignored = ignored_paths(
            &repository,
            [
                "ignored.log".to_string(),
                "visible.log".to_string(),
                "build".to_string(),
            ],
        );

        assert!(ignored.contains("ignored.log"));
        assert!(ignored.contains("build"));
        assert!(!ignored.contains("visible.log"));
    }

    #[test]
    fn reads_log_files_and_diff_for_commits() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        fs::write(temp.path().join("sample.txt"), "old\n").unwrap();
        git(temp.path(), &["add", "sample.txt"]);
        commit(temp.path(), "Add sample");
        fs::write(temp.path().join("sample.txt"), "new\n").unwrap();
        git(temp.path(), &["add", "sample.txt"]);
        commit_with_body(
            temp.path(),
            "Update sample",
            "Explain the sample update.\n\nKeep the body available.",
        );

        let repository = repository_for(temp.path()).unwrap();
        assert_eq!(log_count(&repository), Some(2));

        let log = log_entries(&repository, 1, 10).unwrap();
        assert_eq!(log[0].subject, "Update sample");
        assert_eq!(
            log[0].body,
            "Explain the sample update.\n\nKeep the body available."
        );

        let older_log = log_entries(&repository, 2, 1).unwrap();
        assert_eq!(older_log[0].subject, "Add sample");

        let files = commit_files(&repository, &log[0].sha).unwrap();
        assert_eq!(
            files,
            vec![CommitFile {
                repo_relative_path: "sample.txt".to_string(),
                status: "M".to_string(),
            }]
        );

        let diff = commit_diff(&repository, &log[0].sha, "sample.txt").unwrap();
        assert!(diff.contains("-old"));
        assert!(diff.contains("+new"));
    }

    #[test]
    fn parses_renamed_commit_file_paths() {
        let files = parse_commit_files(b"R100\told.txt\tnew.txt\n");

        assert_eq!(
            files,
            vec![CommitFile {
                repo_relative_path: "new.txt".to_string(),
                status: "R".to_string(),
            }]
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

    fn commit(path: &Path, message: &str) {
        git(
            path,
            &[
                "-c",
                "user.name=Codger Test",
                "-c",
                "user.email=codger@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                message,
            ],
        );
    }

    fn commit_with_body(path: &Path, subject: &str, body: &str) {
        git(
            path,
            &[
                "-c",
                "user.name=Codger Test",
                "-c",
                "user.email=codger@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                subject,
                "-m",
                body,
            ],
        );
    }
}
