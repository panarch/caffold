use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Write},
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
pub struct RepositoryMetadataPaths {
    pub git_dir: PathBuf,
    pub common_dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub repo_relative_path: String,
    pub status: String,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DiffStats {
    pub additions: u64,
    pub deletions: u64,
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompareRefs {
    pub base: String,
    pub head: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BranchRef {
    pub name: String,
    pub kind: BranchRefKind,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BranchRefKind {
    Head,
    Local,
    Remote,
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

pub fn repository_metadata_paths(repository: &Repository) -> Option<RepositoryMetadataPaths> {
    let git_dir = PathBuf::from(run_git(
        &repository.root,
        &["rev-parse", "--absolute-git-dir"],
    )?)
    .canonicalize()
    .ok()?;
    let common_dir = PathBuf::from(run_git(
        &repository.root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?)
    .canonicalize()
    .ok()?;

    Some(RepositoryMetadataPaths {
        git_dir,
        common_dir,
    })
}

pub fn status_entries(repository: &Repository) -> Option<Vec<StatusEntry>> {
    let output = run_git_bytes(
        &repository.root,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;

    Some(parse_status_entries(&output))
}

pub fn working_tree_stats(repository: &Repository, entries: &[StatusEntry]) -> Option<DiffStats> {
    let has_head = run_git_bytes(&repository.root, &["rev-parse", "--verify", "HEAD"]).is_some();
    let output = if has_head {
        run_git_bytes(
            &repository.root,
            &["diff", "--numstat", "--find-renames", "HEAD", "--"],
        )?
    } else {
        run_git_bytes(
            &repository.root,
            &["diff", "--cached", "--numstat", "--find-renames", "--"],
        )?
    };
    let mut stats = parse_diff_stats(&output);

    if !has_head {
        let unstaged = run_git_bytes(
            &repository.root,
            &["diff", "--numstat", "--find-renames", "--"],
        )?;
        let unstaged = parse_diff_stats(&unstaged);
        stats.additions = stats.additions.saturating_add(unstaged.additions);
        stats.deletions = stats.deletions.saturating_add(unstaged.deletions);
    }

    for entry in entries.iter().filter(|entry| entry.untracked) {
        let path = repository.root.join(&entry.repo_relative_path);
        stats.additions = stats
            .additions
            .saturating_add(text_file_line_count(&path).unwrap_or(0));
    }

    Some(stats)
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

pub fn commit_stats(repository: &Repository, commit_sha: &str) -> Option<DiffStats> {
    let commit_sha = normalize_commit_sha(commit_sha)?;
    let args = vec![
        "show".to_string(),
        "--format=".to_string(),
        "--numstat".to_string(),
        "--find-renames".to_string(),
        "--first-parent".to_string(),
        commit_sha.to_string(),
    ];

    Some(parse_diff_stats(&run_git_owned(&repository.root, &args)?))
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

pub fn compare_refs(
    repository: &Repository,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
) -> Option<CompareRefs> {
    let head = match head_ref {
        Some(head_ref) => resolve_compare_ref(repository, head_ref)?,
        None => current_compare_ref(repository)?,
    };
    let base = match base_ref {
        Some(base_ref) => resolve_compare_ref(repository, base_ref)?,
        None => default_compare_base_ref(repository)?,
    };

    Some(CompareRefs { base, head })
}

pub fn branch_refs(repository: &Repository) -> Option<Vec<BranchRef>> {
    let output = run_git_bytes(
        &repository.root,
        &[
            "for-each-ref",
            "--format=%(refname)%09%(refname:short)",
            "refs/heads",
            "refs/remotes",
        ],
    )?;

    let mut refs = parse_branch_refs(&output);
    if current_compare_ref(repository).as_deref() == Some("HEAD")
        && !refs.iter().any(|branch_ref| branch_ref.name == "HEAD")
    {
        refs.insert(
            0,
            BranchRef {
                name: "HEAD".to_string(),
                kind: BranchRefKind::Head,
            },
        );
    }

    Some(refs)
}

pub fn compare_files(repository: &Repository, refs: &CompareRefs) -> Option<Vec<CommitFile>> {
    let range = compare_range(refs);
    let args = vec![
        "diff".to_string(),
        "--name-status".to_string(),
        "--find-renames".to_string(),
        range,
    ];

    let output = run_git_owned(&repository.root, &args)?;
    Some(parse_commit_files(&output))
}

pub fn compare_stats(repository: &Repository, refs: &CompareRefs) -> Option<DiffStats> {
    let range = compare_range(refs);
    let args = vec![
        "diff".to_string(),
        "--numstat".to_string(),
        "--find-renames".to_string(),
        range,
    ];

    Some(parse_diff_stats(&run_git_owned(&repository.root, &args)?))
}

pub fn compare_diff(
    repository: &Repository,
    refs: &CompareRefs,
    repo_relative_path: &str,
) -> Option<String> {
    if repo_relative_path.is_empty() {
        return None;
    }

    let range = compare_range(refs);
    let args = vec![
        "diff".to_string(),
        "--find-renames".to_string(),
        range,
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

pub fn current_compare_ref(repository: &Repository) -> Option<String> {
    if let Some(branch) = repository.branch.as_deref()
        && !branch.starts_with("HEAD ")
        && let Some(branch) = resolve_compare_ref(repository, branch)
    {
        return Some(branch);
    }

    resolve_compare_ref(repository, "HEAD")
}

pub fn default_compare_base_ref(repository: &Repository) -> Option<String> {
    ["origin/main", "origin/master", "main", "master"]
        .into_iter()
        .find_map(|candidate| resolve_compare_ref(repository, candidate))
}

fn resolve_compare_ref(repository: &Repository, ref_name: &str) -> Option<String> {
    let ref_name = normalize_compare_ref(repository, ref_name)?;
    let commit_ref = format!("{ref_name}^{{commit}}");
    let args = vec![
        "rev-parse".to_string(),
        "--verify".to_string(),
        "--quiet".to_string(),
        commit_ref,
    ];
    run_git_owned(&repository.root, &args)?;

    Some(ref_name)
}

fn normalize_compare_ref(repository: &Repository, ref_name: &str) -> Option<String> {
    let ref_name = ref_name.trim();
    if ref_name == "HEAD" {
        return Some(ref_name.to_string());
    }

    if ref_name.is_empty()
        || ref_name.starts_with('-')
        || ref_name.contains("..")
        || ref_name.contains("@{")
    {
        return None;
    }

    let checked = run_git(
        &repository.root,
        &["check-ref-format", "--branch", ref_name],
    )?;
    (checked == ref_name).then_some(ref_name.to_string())
}

fn compare_range(refs: &CompareRefs) -> String {
    format!("{}...{}", refs.base, refs.head)
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

fn parse_diff_stats(output: &[u8]) -> DiffStats {
    String::from_utf8_lossy(output)
        .lines()
        .fold(DiffStats::default(), |mut stats, line| {
            let mut fields = line.splitn(3, '\t');
            let additions = fields.next().and_then(|value| value.parse::<u64>().ok());
            let deletions = fields.next().and_then(|value| value.parse::<u64>().ok());
            if let (Some(additions), Some(deletions)) = (additions, deletions) {
                stats.additions = stats.additions.saturating_add(additions);
                stats.deletions = stats.deletions.saturating_add(deletions);
            }
            stats
        })
}

fn text_file_line_count(path: &Path) -> Option<u64> {
    let metadata = path.symlink_metadata().ok()?;
    if !metadata.file_type().is_file() {
        return Some(0);
    }

    let mut file = File::open(path).ok()?;
    let mut buffer = [0; 8192];
    let mut lines = 0_u64;
    let mut has_bytes = false;
    let mut ends_with_newline = false;

    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }

        let chunk = &buffer[..read];
        if chunk.contains(&0) {
            return Some(0);
        }
        has_bytes = true;
        ends_with_newline = chunk.last() == Some(&b'\n');
        lines = lines.saturating_add(chunk.iter().filter(|byte| **byte == b'\n').count() as u64);
    }

    Some(lines.saturating_add(u64::from(has_bytes && !ends_with_newline)))
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

fn parse_branch_refs(output: &[u8]) -> Vec<BranchRef> {
    let mut refs = String::from_utf8_lossy(output)
        .lines()
        .filter_map(parse_branch_ref)
        .collect::<Vec<_>>();
    refs.sort_by(|left, right| {
        branch_ref_sort_key(&left.kind)
            .cmp(&branch_ref_sort_key(&right.kind))
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });

    refs
}

fn parse_branch_ref(line: &str) -> Option<BranchRef> {
    let (full_ref, short_ref) = line.split_once('\t')?;
    let kind = if full_ref.starts_with("refs/heads/") {
        BranchRefKind::Local
    } else if full_ref.starts_with("refs/remotes/") {
        BranchRefKind::Remote
    } else {
        return None;
    };

    let name = short_ref.trim();
    if name.is_empty() || name.ends_with("/HEAD") {
        return None;
    }

    Some(BranchRef {
        name: name.to_string(),
        kind,
    })
}

fn branch_ref_sort_key(kind: &BranchRefKind) -> u8 {
    match kind {
        BranchRefKind::Head => 0,
        BranchRefKind::Local => 1,
        BranchRefKind::Remote => 2,
    }
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
    fn resolves_linked_worktree_git_and_common_directories() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repository_root = temp.path().join("repository");
        let linked_root = temp.path().join("linked");
        fs::create_dir(&repository_root).unwrap();
        git(&repository_root, &["init"]);
        fs::write(repository_root.join("tracked.txt"), "tracked\n").unwrap();
        git(&repository_root, &["add", "tracked.txt"]);
        commit(&repository_root, "Initial commit");
        let linked = linked_root.to_string_lossy().into_owned();
        git(
            &repository_root,
            &["worktree", "add", "-b", "linked", &linked],
        );

        let repository = repository_for(&linked_root).unwrap();
        let metadata = repository_metadata_paths(&repository).unwrap();
        let common_dir = repository_root.join(".git").canonicalize().unwrap();

        assert_eq!(metadata.common_dir, common_dir);
        assert_ne!(metadata.git_dir, metadata.common_dir);
        assert!(
            metadata
                .git_dir
                .starts_with(metadata.common_dir.join("worktrees"))
        );
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
    fn parses_text_numstat_and_skips_binary_entries() {
        let stats =
            parse_diff_stats(b"12\t3\tsrc/main.rs\n-\t-\tassets/image.png\n4\t0\tREADME.md\n");

        assert_eq!(
            stats,
            DiffStats {
                additions: 16,
                deletions: 3,
            }
        );
    }

    #[test]
    fn counts_working_tree_changes_and_untracked_text_lines() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        fs::write(temp.path().join("tracked.txt"), "old\nkeep\n").unwrap();
        git(temp.path(), &["add", "tracked.txt"]);
        commit(temp.path(), "Add tracked file");

        fs::write(
            temp.path().join("tracked.txt"),
            "new\nkeep\nadded tracked line\n",
        )
        .unwrap();
        fs::write(temp.path().join("untracked.txt"), "first\nsecond").unwrap();
        fs::write(temp.path().join("binary.dat"), b"before\0after\n").unwrap();

        let repository = repository_for(temp.path()).unwrap();
        let entries = status_entries(&repository).unwrap();
        let stats = working_tree_stats(&repository, &entries).unwrap();

        assert_eq!(
            stats,
            DiffStats {
                additions: 4,
                deletions: 1,
            }
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
        assert_eq!(
            commit_stats(&repository, &log[0].sha),
            Some(DiffStats {
                additions: 1,
                deletions: 1,
            })
        );

        let diff = commit_diff(&repository, &log[0].sha, "sample.txt").unwrap();
        assert!(diff.contains("-old"));
        assert!(diff.contains("+new"));
    }

    #[test]
    fn reads_compare_files_and_diff_between_refs() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        fs::write(temp.path().join("sample.txt"), "old\n").unwrap();
        git(temp.path(), &["add", "sample.txt"]);
        commit(temp.path(), "Add sample");
        git(
            temp.path(),
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        git(temp.path(), &["checkout", "-b", "feature/review"]);
        fs::write(temp.path().join("sample.txt"), "new\n").unwrap();
        fs::write(temp.path().join("added.txt"), "added\n").unwrap();
        git(temp.path(), &["add", "sample.txt", "added.txt"]);
        commit(temp.path(), "Update sample");

        let repository = repository_for(temp.path()).unwrap();
        let refs = compare_refs(&repository, None, None).unwrap();
        assert_eq!(refs.base, "origin/main");
        assert_eq!(refs.head, "feature/review");

        let files = compare_files(&repository, &refs).unwrap();
        assert_eq!(
            files,
            vec![
                CommitFile {
                    repo_relative_path: "added.txt".to_string(),
                    status: "A".to_string(),
                },
                CommitFile {
                    repo_relative_path: "sample.txt".to_string(),
                    status: "M".to_string(),
                },
            ]
        );
        assert_eq!(
            compare_stats(&repository, &refs),
            Some(DiffStats {
                additions: 2,
                deletions: 1,
            })
        );

        let diff = compare_diff(&repository, &refs, "sample.txt").unwrap();
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

    #[test]
    fn normalizes_compare_refs_with_hashes() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        let repository = repository_for(temp.path()).unwrap();

        assert_eq!(
            normalize_compare_ref(
                &repository,
                "origin/codex/complete-pr-#1599-work-on-main-branch"
            ),
            Some("origin/codex/complete-pr-#1599-work-on-main-branch".to_string())
        );
    }

    #[test]
    fn normalizes_compare_refs_with_git_branch_rules() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        let repository = repository_for(temp.path()).unwrap();

        for ref_name in [
            "feature/foo+bar",
            "feature/foo=bar",
            "feature/foo,bar",
            "feature/foo#bar",
        ] {
            assert_eq!(
                normalize_compare_ref(&repository, ref_name),
                Some(ref_name.to_string())
            );
        }

        for ref_name in ["-bad", "feature/foo..bar", "feature/foo@{bar"] {
            assert_eq!(normalize_compare_ref(&repository, ref_name), None);
        }
    }

    #[test]
    fn lists_head_ref_for_detached_compare_state() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        git(temp.path(), &["init"]);
        fs::write(temp.path().join("sample.txt"), "hello\n").unwrap();
        git(temp.path(), &["add", "sample.txt"]);
        commit(temp.path(), "Add sample");
        git(temp.path(), &["checkout", "--detach", "HEAD"]);

        let repository = repository_for(temp.path()).unwrap();
        assert_eq!(current_compare_ref(&repository).as_deref(), Some("HEAD"));

        let refs = branch_refs(&repository).unwrap();
        assert!(
            refs.iter()
                .any(|branch_ref| branch_ref.name == "HEAD"
                    && branch_ref.kind == BranchRefKind::Head)
        );
    }

    #[test]
    fn parses_branch_refs_without_remote_head_aliases() {
        let refs = parse_branch_refs(
            b"refs/remotes/origin/HEAD\torigin/HEAD\nrefs/heads/feature/review\tfeature/review\nrefs/remotes/origin/main\torigin/main\n",
        );

        assert_eq!(
            refs,
            vec![
                BranchRef {
                    name: "feature/review".to_string(),
                    kind: BranchRefKind::Local,
                },
                BranchRef {
                    name: "origin/main".to_string(),
                    kind: BranchRefKind::Remote,
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

    fn commit(path: &Path, message: &str) {
        git(
            path,
            &[
                "-c",
                "user.name=Caffold Test",
                "-c",
                "user.email=caffold@example.test",
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
                "user.name=Caffold Test",
                "-c",
                "user.email=caffold@example.test",
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
