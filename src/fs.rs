use std::{
    env, fs, io,
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use thiserror::Error;

use crate::{git, github};

pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct RootedFs {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListResponse {
    pub root: String,
    pub path: String,
    pub entries: Vec<DirectoryEntry>,
    pub git: Option<DirectoryGitInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub is_symlink: bool,
    pub supported: bool,
    pub git_ignored: bool,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
    pub git: Option<EntryGitInfo>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryGitInfo {
    pub root_path: String,
    pub branch: Option<String>,
    pub dirty: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EntryGitInfo {
    pub is_repo_root: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileResponse {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub language_hint: Option<String>,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageResponse {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub content_type: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusResponse {
    pub repository: DirectoryGitInfo,
    pub files: Vec<GitChangedFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLogResponse {
    pub repository: DirectoryGitInfo,
    pub commits: Vec<GitCommitSummary>,
    pub page: usize,
    pub per_page: usize,
    pub total_commits: usize,
    pub total_pages: usize,
    pub has_previous: bool,
    pub has_next: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResponse {
    pub repository: DirectoryGitInfo,
    pub commit: GitCommitSummary,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCompareResponse {
    pub repository: DirectoryGitInfo,
    pub base_ref: String,
    pub head_ref: String,
    pub files: Vec<GitCompareFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRefsResponse {
    pub repository: DirectoryGitInfo,
    pub refs: Vec<GitRef>,
    pub current_ref: Option<String>,
    pub default_base_ref: Option<String>,
    pub default_head_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubStatusResponse {
    pub repository: DirectoryGitInfo,
    pub github: Option<GithubRepositoryInfo>,
    pub gh_available: bool,
    pub authenticated: bool,
    pub issues_available: bool,
    pub pulls_available: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssuesResponse {
    pub repository: DirectoryGitInfo,
    pub github: GithubRepositoryInfo,
    pub state: String,
    pub issues: Vec<GithubIssueSummary>,
    pub page: usize,
    pub per_page: usize,
    pub total_issues: usize,
    pub total_pages: usize,
    pub has_previous: bool,
    pub has_next: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueResponse {
    pub repository: DirectoryGitInfo,
    pub github: GithubRepositoryInfo,
    pub issue: GithubIssueDetail,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullsResponse {
    pub repository: DirectoryGitInfo,
    pub github: GithubRepositoryInfo,
    pub state: String,
    pub pulls: Vec<GithubPullSummary>,
    pub page: usize,
    pub per_page: usize,
    pub total_pulls: usize,
    pub total_pages: usize,
    pub has_previous: bool,
    pub has_next: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullResponse {
    pub repository: DirectoryGitInfo,
    pub github: GithubRepositoryInfo,
    pub pull: GithubPullDetail,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullFilesResponse {
    pub repository: DirectoryGitInfo,
    pub github: GithubRepositoryInfo,
    pub number: u64,
    pub files: Vec<GithubPullFile>,
    pub total_files: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullFileResponse {
    pub repository: DirectoryGitInfo,
    pub github: GithubRepositoryInfo,
    pub number: u64,
    pub path: String,
    pub repo_relative_path: String,
    pub status: String,
    pub kind: String,
    pub diff: String,
    pub diff_unavailable: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepositoryInfo {
    pub owner: String,
    pub name: String,
    pub name_with_owner: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub comments: u64,
    pub updated_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubIssueDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    pub comments: u64,
    pub body: String,
    pub body_html: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullSummary {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub comments: u64,
    pub updated_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullDetail {
    pub number: u64,
    pub title: String,
    pub state: String,
    pub draft: bool,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub comments: u64,
    pub reviews: u64,
    pub commits: u64,
    pub additions: u64,
    pub deletions: u64,
    pub changed_files: u64,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub body: String,
    pub body_html: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: String,
    pub conversation_comments: Vec<GithubPullComment>,
    pub review_comments: Vec<GithubPullReview>,
    pub commit_summaries: Vec<GithubPullCommit>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullComment {
    pub author: Option<String>,
    pub body: String,
    pub body_html: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullReview {
    pub author: Option<String>,
    pub state: String,
    pub body: String,
    pub body_html: Option<String>,
    pub submitted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullCommit {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    pub authored_at: Option<String>,
    pub committed_at: Option<String>,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GithubPullFile {
    pub path: String,
    pub repo_relative_path: String,
    pub previous_path: Option<String>,
    pub previous_repo_relative_path: Option<String>,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub changes: u64,
    pub patch_available: bool,
    pub blob_url: Option<String>,
    pub raw_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitSummary {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub body: String,
    pub author_name: String,
    pub author_email: String,
    pub author_time_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub repo_relative_path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCompareFile {
    pub path: String,
    pub repo_relative_path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRef {
    pub name: String,
    pub kind: GitRefKind,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitRefKind {
    Head,
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChangedFile {
    pub path: String,
    pub repo_relative_path: String,
    pub status: String,
    pub category: GitChangeCategory,
    pub staged: bool,
    pub unstaged: bool,
    pub untracked: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GitChangeCategory {
    Staged,
    Unstaged,
    Untracked,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiffResponse {
    pub repository: DirectoryGitInfo,
    pub path: String,
    pub repo_relative_path: String,
    pub kind: String,
    pub diff: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoot {
    pub name: String,
    pub root_path: String,
    pub relative_path: String,
}

#[derive(Debug, Error)]
pub enum FsError {
    #[error("root path is not accessible: {path}")]
    RootUnavailable {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("root path is not a directory: {path}")]
    RootNotDirectory { path: PathBuf },
    #[error("path escapes browsing root")]
    PathEscapesRoot,
    #[error("path was not found: {path}")]
    NotFound { path: String },
    #[error("path is not a directory: {path}")]
    NotDirectory { path: String },
    #[error("path is a directory, not a file: {path}")]
    IsDirectory { path: String },
    #[error("path is not a regular file: {path}")]
    NotFile { path: String },
    #[error("file is too large: {path} ({size} bytes, limit {limit} bytes)")]
    FileTooLarge { path: String, size: u64, limit: u64 },
    #[error("binary-looking files are not supported: {path}")]
    BinaryFile { path: String },
    #[error("invalid UTF-8 files are not supported: {path}")]
    InvalidUtf8 { path: String },
    #[error("image preview is not supported for this file type: {path}")]
    UnsupportedImage { path: String },
    #[error("path is not inside a Git repository: {path}")]
    GitRepositoryNotFound { path: String },
    #[error("git command failed while trying to {action}: {path}")]
    GitCommandFailed { action: &'static str, path: String },
    #[error("path is not inside a GitHub repository: {path}")]
    GithubRepositoryNotFound { path: String },
    #[error("GitHub is unavailable for {action}: {path}")]
    GithubUnavailable { action: &'static str, path: String },
    #[error("GitHub CLI command failed while trying to {action}: {path}")]
    GithubCommandFailed { action: &'static str, path: String },
    #[error("filesystem error while trying to {action}: {path}")]
    Io {
        action: &'static str,
        path: String,
        #[source]
        source: io::Error,
    },
}

impl RootedFs {
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, FsError> {
        let path = root.into();
        let root = path
            .canonicalize()
            .map_err(|source| FsError::RootUnavailable { path, source })?;

        if !root.is_dir() {
            return Err(FsError::RootNotDirectory { path: root });
        }

        Ok(Self { root })
    }

    pub fn from_home() -> Result<Self, FsError> {
        Self::new(Self::home_dir()?)
    }

    pub fn from_filesystem_root() -> Result<Self, FsError> {
        Self::new(PathBuf::from("/"))
    }

    pub fn home_dir() -> Result<PathBuf, FsError> {
        let home =
            env::var_os("HOME")
                .map(PathBuf::from)
                .ok_or_else(|| FsError::RootUnavailable {
                    path: PathBuf::from("$HOME"),
                    source: io::Error::new(io::ErrorKind::NotFound, "HOME is not set"),
                })?;

        Ok(home)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn logical_path_for_absolute(&self, path: &Path) -> Result<String, FsError> {
        let path = path.to_path_buf();
        let canonical = path
            .canonicalize()
            .map_err(|source| FsError::RootUnavailable { path, source })?;

        if !canonical.starts_with(&self.root) {
            return Err(FsError::PathEscapesRoot);
        }

        let relative = canonical
            .strip_prefix(&self.root)
            .map_err(|_| FsError::PathEscapesRoot)?;

        Ok(relative_path_string(relative))
    }

    pub fn list(&self, requested_path: &str) -> Result<ListResponse, FsError> {
        let resolved = self.resolve_existing(requested_path)?;
        let metadata = fs::metadata(&resolved.absolute).map_err(|source| FsError::Io {
            action: "read metadata",
            path: requested_path.to_string(),
            source,
        })?;

        if !metadata.is_dir() {
            return Err(FsError::NotDirectory {
                path: requested_path.to_string(),
            });
        }

        let repository = git::repository_for(&resolved.absolute)
            .filter(|repository| repository.root.starts_with(&self.root));
        let git = repository
            .as_ref()
            .and_then(|repository| self.git_info_for_repository(repository).ok());
        let mut entries = Vec::new();

        for entry in fs::read_dir(&resolved.absolute).map_err(|source| FsError::Io {
            action: "list directory",
            path: requested_path.to_string(),
            source,
        })? {
            let entry = entry.map_err(|source| FsError::Io {
                action: "read directory entry",
                path: requested_path.to_string(),
                source,
            })?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let logical_path = resolved.logical.join(&name);
            entries.push(self.directory_entry(name, logical_path, entry.path())?);
        }

        if let Some(repository) = repository.as_ref() {
            self.mark_git_ignored_entries(&mut entries, repository)?;
        }

        entries.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });

        Ok(ListResponse {
            root: self.root.display().to_string(),
            path: relative_path_string(&resolved.logical),
            entries,
            git,
        })
    }

    pub fn read_file(&self, requested_path: &str) -> Result<FileResponse, FsError> {
        let resolved = self.resolve_existing(requested_path)?;
        let metadata = fs::metadata(&resolved.absolute).map_err(|source| FsError::Io {
            action: "read metadata",
            path: requested_path.to_string(),
            source,
        })?;

        if metadata.is_dir() {
            return Err(FsError::IsDirectory {
                path: requested_path.to_string(),
            });
        }

        if !metadata.is_file() {
            return Err(FsError::NotFile {
                path: requested_path.to_string(),
            });
        }

        if metadata.len() > MAX_FILE_BYTES {
            return Err(FsError::FileTooLarge {
                path: requested_path.to_string(),
                size: metadata.len(),
                limit: MAX_FILE_BYTES,
            });
        }

        let mut file = fs::File::open(&resolved.absolute).map_err(|source| FsError::Io {
            action: "open file",
            path: requested_path.to_string(),
            source,
        })?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.by_ref()
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|source| FsError::Io {
                action: "read file",
                path: requested_path.to_string(),
                source,
            })?;

        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(FsError::FileTooLarge {
                path: requested_path.to_string(),
                size: bytes.len() as u64,
                limit: MAX_FILE_BYTES,
            });
        }

        if bytes.contains(&0) {
            return Err(FsError::BinaryFile {
                path: requested_path.to_string(),
            });
        }

        let content = String::from_utf8(bytes).map_err(|_| FsError::InvalidUtf8 {
            path: requested_path.to_string(),
        })?;

        Ok(FileResponse {
            path: relative_path_string(&resolved.logical),
            name: resolved
                .logical
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| relative_path_string(&resolved.logical)),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
            language_hint: language_hint(&resolved.logical),
            content,
        })
    }

    pub fn read_image(&self, requested_path: &str) -> Result<ImageResponse, FsError> {
        let resolved = self.resolve_existing(requested_path)?;
        let content_type =
            image_content_type(&resolved.logical).ok_or_else(|| FsError::UnsupportedImage {
                path: requested_path.to_string(),
            })?;
        let metadata = fs::metadata(&resolved.absolute).map_err(|source| FsError::Io {
            action: "read metadata",
            path: requested_path.to_string(),
            source,
        })?;

        if metadata.is_dir() {
            return Err(FsError::IsDirectory {
                path: requested_path.to_string(),
            });
        }

        if !metadata.is_file() {
            return Err(FsError::NotFile {
                path: requested_path.to_string(),
            });
        }

        if metadata.len() > MAX_IMAGE_BYTES {
            return Err(FsError::FileTooLarge {
                path: requested_path.to_string(),
                size: metadata.len(),
                limit: MAX_IMAGE_BYTES,
            });
        }

        let bytes = fs::read(&resolved.absolute).map_err(|source| FsError::Io {
            action: "read image",
            path: requested_path.to_string(),
            source,
        })?;

        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(FsError::FileTooLarge {
                path: requested_path.to_string(),
                size: bytes.len() as u64,
                limit: MAX_IMAGE_BYTES,
            });
        }

        Ok(ImageResponse {
            path: relative_path_string(&resolved.logical),
            name: resolved
                .logical
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| relative_path_string(&resolved.logical)),
            size: metadata.len(),
            modified_ms: modified_ms(&metadata),
            content_type,
            bytes,
        })
    }

    pub fn git_status(&self, requested_path: &str) -> Result<GitStatusResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let files = git::status_entries(&repository)
            .ok_or_else(|| FsError::GitCommandFailed {
                action: "read status",
                path: requested_path.to_string(),
            })?
            .into_iter()
            .map(|entry| {
                let category = git_change_category(&entry);
                GitChangedFile {
                    path: join_relative_path(&repository_info.root_path, &entry.repo_relative_path),
                    repo_relative_path: entry.repo_relative_path,
                    status: entry.status,
                    category,
                    staged: entry.staged,
                    unstaged: entry.unstaged,
                    untracked: entry.untracked,
                }
            })
            .collect();

        Ok(GitStatusResponse {
            repository: repository_info,
            files,
        })
    }

    pub fn git_log(
        &self,
        requested_path: &str,
        page: usize,
        per_page: usize,
    ) -> Result<GitLogResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let per_page = per_page.clamp(1, 100);
        let requested_page = page.max(1);
        let total_commits =
            git::log_count(&repository).ok_or_else(|| FsError::GitCommandFailed {
                action: "count log",
                path: requested_path.to_string(),
            })?;
        let total_pages = if total_commits == 0 {
            0
        } else {
            total_commits.div_ceil(per_page)
        };
        let page = if total_pages == 0 {
            1
        } else {
            requested_page.min(total_pages)
        };
        let commits = git::log_entries(&repository, page, per_page)
            .ok_or_else(|| FsError::GitCommandFailed {
                action: "read log",
                path: requested_path.to_string(),
            })?
            .into_iter()
            .map(git_commit_summary)
            .collect();

        Ok(GitLogResponse {
            repository: repository_info,
            commits,
            page,
            per_page,
            total_commits,
            total_pages,
            has_previous: page > 1 && total_pages > 0,
            has_next: page < total_pages,
        })
    }

    pub fn git_commit(
        &self,
        requested_path: &str,
        commit_sha: &str,
    ) -> Result<GitCommitResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let commit = git::commit_summary(&repository, commit_sha)
            .map(git_commit_summary)
            .ok_or_else(|| FsError::GitCommandFailed {
                action: "read commit",
                path: commit_sha.to_string(),
            })?;
        let files = git::commit_files(&repository, commit_sha)
            .ok_or_else(|| FsError::GitCommandFailed {
                action: "read commit files",
                path: commit_sha.to_string(),
            })?
            .into_iter()
            .map(|file| GitCommitFile {
                path: join_relative_path(&repository_info.root_path, &file.repo_relative_path),
                repo_relative_path: file.repo_relative_path,
                status: file.status,
            })
            .collect();

        Ok(GitCommitResponse {
            repository: repository_info,
            commit,
            files,
        })
    }

    pub fn git_commit_diff(
        &self,
        requested_path: &str,
        commit_sha: &str,
        file_path: &str,
    ) -> Result<GitDiffResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let logical_file_path = normalize_relative_path(file_path)?;
        let logical_file_path = relative_path_string(&logical_file_path);
        let repo_relative_path = strip_repo_root(&repository_info.root_path, &logical_file_path)
            .ok_or(FsError::PathEscapesRoot)?
            .to_string();
        let diff =
            git::commit_diff(&repository, commit_sha, &repo_relative_path).ok_or_else(|| {
                FsError::GitCommandFailed {
                    action: "read commit diff",
                    path: file_path.to_string(),
                }
            })?;
        let kind = format!("commit {}", short_commit_label(commit_sha));

        Ok(GitDiffResponse {
            repository: repository_info,
            path: logical_file_path,
            repo_relative_path,
            kind,
            diff,
        })
    }

    pub fn git_compare(
        &self,
        requested_path: &str,
        base_ref: Option<&str>,
        head_ref: Option<&str>,
    ) -> Result<GitCompareResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let refs = git::compare_refs(&repository, base_ref, head_ref).ok_or_else(|| {
            FsError::GitCommandFailed {
                action: "resolve compare refs",
                path: requested_path.to_string(),
            }
        })?;
        let files = git::compare_files(&repository, &refs)
            .ok_or_else(|| FsError::GitCommandFailed {
                action: "read compare files",
                path: format!("{}...{}", refs.base, refs.head),
            })?
            .into_iter()
            .map(|file| GitCompareFile {
                path: join_relative_path(&repository_info.root_path, &file.repo_relative_path),
                repo_relative_path: file.repo_relative_path,
                status: file.status,
            })
            .collect();

        Ok(GitCompareResponse {
            repository: repository_info,
            base_ref: refs.base,
            head_ref: refs.head,
            files,
        })
    }

    pub fn git_compare_diff(
        &self,
        requested_path: &str,
        base_ref: Option<&str>,
        head_ref: Option<&str>,
        file_path: &str,
    ) -> Result<GitDiffResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let refs = git::compare_refs(&repository, base_ref, head_ref).ok_or_else(|| {
            FsError::GitCommandFailed {
                action: "resolve compare refs",
                path: requested_path.to_string(),
            }
        })?;
        let logical_file_path = normalize_relative_path(file_path)?;
        let logical_file_path = relative_path_string(&logical_file_path);
        let repo_relative_path = strip_repo_root(&repository_info.root_path, &logical_file_path)
            .ok_or(FsError::PathEscapesRoot)?
            .to_string();
        let diff = git::compare_diff(&repository, &refs, &repo_relative_path).ok_or_else(|| {
            FsError::GitCommandFailed {
                action: "read compare diff",
                path: file_path.to_string(),
            }
        })?;

        Ok(GitDiffResponse {
            repository: repository_info,
            path: logical_file_path,
            repo_relative_path,
            kind: format!("{}...{}", refs.base, refs.head),
            diff,
        })
    }

    pub fn git_refs(&self, requested_path: &str) -> Result<GitRefsResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let refs = git::branch_refs(&repository)
            .ok_or_else(|| FsError::GitCommandFailed {
                action: "read refs",
                path: requested_path.to_string(),
            })?
            .into_iter()
            .map(git_ref)
            .collect();

        Ok(GitRefsResponse {
            repository: repository_info,
            refs,
            current_ref: git::current_compare_ref(&repository),
            default_base_ref: git::default_compare_base_ref(&repository),
            default_head_ref: git::current_compare_ref(&repository),
        })
    }

    pub fn github_status(&self, requested_path: &str) -> Result<GithubStatusResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let capability = github::capability(&repository);
        let message = match capability.as_ref() {
            Some(capability) => capability.message.clone(),
            None => Some("GitHub remote was not found.".to_string()),
        };

        Ok(GithubStatusResponse {
            repository: repository_info,
            github: capability
                .as_ref()
                .map(|capability| github_repository_info(capability.repository.clone())),
            gh_available: capability
                .as_ref()
                .map(|capability| capability.gh_available)
                .unwrap_or(false),
            authenticated: capability
                .as_ref()
                .map(|capability| capability.authenticated)
                .unwrap_or(false),
            issues_available: capability
                .as_ref()
                .map(|capability| capability.issues_available)
                .unwrap_or(false),
            pulls_available: capability
                .as_ref()
                .map(|capability| capability.pulls_available)
                .unwrap_or(false),
            message,
        })
    }

    pub fn github_issues(
        &self,
        requested_path: &str,
        state: &str,
        page: usize,
        per_page: usize,
    ) -> Result<GithubIssuesResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let capability =
            github::capability(&repository).ok_or_else(|| FsError::GithubRepositoryNotFound {
                path: requested_path.to_string(),
            })?;
        if !capability.issues_available {
            return Err(FsError::GithubUnavailable {
                action: "read issues",
                path: capability.repository.name_with_owner,
            });
        }

        let github = github_repository_info(capability.repository.clone());
        let issue_page = github::issue_page(&capability.repository, state, page, per_page)
            .ok_or_else(|| FsError::GithubCommandFailed {
                action: "read issues",
                path: github.name_with_owner.clone(),
            })?;
        let issues = issue_page
            .issues
            .into_iter()
            .map(github_issue_summary)
            .collect();

        Ok(GithubIssuesResponse {
            repository: repository_info,
            github,
            state: normalize_github_issue_state(state).to_string(),
            issues,
            page: issue_page.page,
            per_page: issue_page.per_page,
            total_issues: issue_page.total_issues,
            total_pages: issue_page.total_pages,
            has_previous: issue_page.has_previous,
            has_next: issue_page.has_next,
        })
    }

    pub fn github_issue(
        &self,
        requested_path: &str,
        number: u64,
    ) -> Result<GithubIssueResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let capability =
            github::capability(&repository).ok_or_else(|| FsError::GithubRepositoryNotFound {
                path: requested_path.to_string(),
            })?;
        if !capability.issues_available {
            return Err(FsError::GithubUnavailable {
                action: "read issue",
                path: capability.repository.name_with_owner,
            });
        }

        let github = github_repository_info(capability.repository.clone());
        let issue = github::issue_detail(&capability.repository, number)
            .ok_or_else(|| FsError::GithubCommandFailed {
                action: "read issue",
                path: format!("{}#{number}", github.name_with_owner),
            })
            .map(github_issue_detail)?;

        Ok(GithubIssueResponse {
            repository: repository_info,
            github,
            issue,
        })
    }

    pub fn github_pulls(
        &self,
        requested_path: &str,
        state: &str,
        page: usize,
        per_page: usize,
    ) -> Result<GithubPullsResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let capability =
            github::capability(&repository).ok_or_else(|| FsError::GithubRepositoryNotFound {
                path: requested_path.to_string(),
            })?;
        if !capability.pulls_available {
            return Err(FsError::GithubUnavailable {
                action: "read pull requests",
                path: capability.repository.name_with_owner,
            });
        }

        let github = github_repository_info(capability.repository.clone());
        let pull_page = github::pull_page(&capability.repository, state, page, per_page)
            .ok_or_else(|| FsError::GithubCommandFailed {
                action: "read pull requests",
                path: github.name_with_owner.clone(),
            })?;
        let pulls = pull_page
            .pulls
            .into_iter()
            .map(github_pull_summary)
            .collect();

        Ok(GithubPullsResponse {
            repository: repository_info,
            github,
            state: normalize_github_issue_state(state).to_string(),
            pulls,
            page: pull_page.page,
            per_page: pull_page.per_page,
            total_pulls: pull_page.total_pulls,
            total_pages: pull_page.total_pages,
            has_previous: pull_page.has_previous,
            has_next: pull_page.has_next,
        })
    }

    pub fn github_pull(
        &self,
        requested_path: &str,
        number: u64,
    ) -> Result<GithubPullResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let capability =
            github::capability(&repository).ok_or_else(|| FsError::GithubRepositoryNotFound {
                path: requested_path.to_string(),
            })?;
        if !capability.pulls_available {
            return Err(FsError::GithubUnavailable {
                action: "read pull request",
                path: capability.repository.name_with_owner,
            });
        }

        let github = github_repository_info(capability.repository.clone());
        let pull = github::pull_detail(&capability.repository, number)
            .ok_or_else(|| FsError::GithubCommandFailed {
                action: "read pull request",
                path: format!("{}#{number}", github.name_with_owner),
            })
            .map(github_pull_detail)?;

        Ok(GithubPullResponse {
            repository: repository_info,
            github,
            pull,
        })
    }

    pub fn github_pull_files(
        &self,
        requested_path: &str,
        number: u64,
    ) -> Result<GithubPullFilesResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let capability =
            github::capability(&repository).ok_or_else(|| FsError::GithubRepositoryNotFound {
                path: requested_path.to_string(),
            })?;
        if !capability.pulls_available {
            return Err(FsError::GithubUnavailable {
                action: "read pull request files",
                path: capability.repository.name_with_owner,
            });
        }

        let github = github_repository_info(capability.repository.clone());
        let pull_files = github::pull_files(&capability.repository, number).ok_or_else(|| {
            FsError::GithubCommandFailed {
                action: "read pull request files",
                path: format!("{}#{number}", github.name_with_owner),
            }
        })?;
        let total_files = pull_files.files.len();
        let files = pull_files
            .files
            .into_iter()
            .map(|file| github_pull_file(&repository_info, file))
            .collect();

        Ok(GithubPullFilesResponse {
            repository: repository_info,
            github,
            number,
            files,
            total_files,
        })
    }

    pub fn github_pull_file(
        &self,
        requested_path: &str,
        number: u64,
        file_path: &str,
    ) -> Result<GithubPullFileResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let capability =
            github::capability(&repository).ok_or_else(|| FsError::GithubRepositoryNotFound {
                path: requested_path.to_string(),
            })?;
        if !capability.pulls_available {
            return Err(FsError::GithubUnavailable {
                action: "read pull request file",
                path: capability.repository.name_with_owner,
            });
        }

        let logical_file_path = normalize_relative_path(file_path)?;
        let logical_file_path = relative_path_string(&logical_file_path);
        let repo_relative_path = strip_repo_root(&repository_info.root_path, &logical_file_path)
            .ok_or(FsError::PathEscapesRoot)?
            .to_string();
        let github = github_repository_info(capability.repository.clone());
        let pull_files = github::pull_files(&capability.repository, number).ok_or_else(|| {
            FsError::GithubCommandFailed {
                action: "read pull request file",
                path: format!("{}#{number}", github.name_with_owner),
            }
        })?;
        let file = pull_files
            .files
            .into_iter()
            .find(|file| file.filename == repo_relative_path)
            .ok_or_else(|| FsError::GithubCommandFailed {
                action: "read pull request file",
                path: format!("{}#{number}:{repo_relative_path}", github.name_with_owner),
            })?;
        let message = if file.patch.is_some() {
            None
        } else {
            Some("GitHub did not provide a text diff for this file.".to_string())
        };

        Ok(GithubPullFileResponse {
            repository: repository_info,
            github,
            number,
            path: logical_file_path,
            repo_relative_path,
            status: file.status,
            kind: format!("PR #{number}"),
            diff: file.patch.unwrap_or_default(),
            diff_unavailable: message.is_some(),
            message,
        })
    }

    pub fn git_diff(
        &self,
        requested_path: &str,
        file_path: &str,
        kind: &str,
    ) -> Result<GitDiffResponse, FsError> {
        let repository = self.repository_for_request(requested_path)?;
        let repository_info = self.git_info_for_repository(&repository)?;
        let logical_file_path = normalize_relative_path(file_path)?;
        let logical_file_path = relative_path_string(&logical_file_path);
        let repo_relative_path = strip_repo_root(&repository_info.root_path, &logical_file_path)
            .ok_or(FsError::PathEscapesRoot)?
            .to_string();
        let kind = normalize_diff_kind(kind);

        if let Ok(canonical) = self.root.join(&logical_file_path).canonicalize()
            && !canonical.starts_with(&repository.root)
        {
            return Err(FsError::PathEscapesRoot);
        }

        let diff = git::diff(&repository, &repo_relative_path, kind).ok_or_else(|| {
            FsError::GitCommandFailed {
                action: "read diff",
                path: file_path.to_string(),
            }
        })?;

        Ok(GitDiffResponse {
            repository: repository_info,
            path: logical_file_path,
            repo_relative_path,
            kind: kind.to_string(),
            diff,
        })
    }

    pub fn project_candidate_for_path(
        &self,
        requested_path: &str,
    ) -> Result<Option<ProjectRoot>, FsError> {
        let search_path = self.git_search_path(requested_path)?;
        git::repository_for(&search_path)
            .filter(|repository| repository.root.starts_with(&self.root))
            .map(|repository| self.project_root_for_repository(&repository))
            .transpose()
    }

    pub fn project_root_for_path(&self, requested_path: &str) -> Result<ProjectRoot, FsError> {
        let search_path = self.git_search_path(requested_path)?;
        let repository =
            git::repository_for(&search_path).ok_or_else(|| FsError::GitRepositoryNotFound {
                path: requested_path.to_string(),
            })?;

        self.project_root_for_repository(&repository)
    }

    fn resolve_existing(&self, requested_path: &str) -> Result<ResolvedPath, FsError> {
        let logical = normalize_relative_path(requested_path)?;
        let candidate = self.root.join(&logical);
        let absolute = candidate.canonicalize().map_err(|source| {
            if source.kind() == io::ErrorKind::NotFound {
                FsError::NotFound {
                    path: requested_path.to_string(),
                }
            } else {
                FsError::Io {
                    action: "resolve path",
                    path: requested_path.to_string(),
                    source,
                }
            }
        })?;

        if !absolute.starts_with(&self.root) {
            return Err(FsError::PathEscapesRoot);
        }

        Ok(ResolvedPath { logical, absolute })
    }

    fn directory_entry(
        &self,
        name: String,
        logical_path: PathBuf,
        physical_path: PathBuf,
    ) -> Result<DirectoryEntry, FsError> {
        let symlink_metadata =
            fs::symlink_metadata(&physical_path).map_err(|source| FsError::Io {
                action: "read entry metadata",
                path: relative_path_string(&logical_path),
                source,
            })?;
        let is_symlink = symlink_metadata.file_type().is_symlink();

        let target_inside_root = if is_symlink {
            physical_path
                .canonicalize()
                .map(|target| target.starts_with(&self.root))
                .unwrap_or(false)
        } else {
            true
        };

        if !target_inside_root {
            return Ok(DirectoryEntry {
                name,
                path: relative_path_string(&logical_path),
                kind: EntryKind::Symlink,
                is_symlink,
                supported: false,
                git_ignored: false,
                size: None,
                modified_ms: modified_ms(&symlink_metadata),
                git: None,
            });
        }

        let metadata = if is_symlink {
            fs::metadata(&physical_path).unwrap_or(symlink_metadata)
        } else {
            symlink_metadata
        };
        let kind = entry_kind(&metadata);
        let supported = matches!(kind, EntryKind::Directory | EntryKind::File);
        let git = (kind == EntryKind::Directory && git::has_git_marker(&physical_path))
            .then_some(EntryGitInfo { is_repo_root: true });

        Ok(DirectoryEntry {
            name,
            path: relative_path_string(&logical_path),
            kind,
            is_symlink,
            supported,
            git_ignored: false,
            size: metadata.is_file().then_some(metadata.len()),
            modified_ms: modified_ms(&metadata),
            git,
        })
    }

    fn mark_git_ignored_entries(
        &self,
        entries: &mut [DirectoryEntry],
        repository: &git::Repository,
    ) -> Result<(), FsError> {
        let repo_root = repository
            .root
            .strip_prefix(&self.root)
            .map_err(|_| FsError::PathEscapesRoot)?;
        let repo_root = relative_path_string(repo_root);
        let entry_paths = entries
            .iter()
            .filter_map(|entry| strip_repo_root(&repo_root, &entry.path))
            .map(ToString::to_string);
        let ignored = git::ignored_paths(repository, entry_paths);

        if ignored.is_empty() {
            return Ok(());
        }

        for entry in entries {
            if let Some(repo_relative_path) = strip_repo_root(&repo_root, &entry.path) {
                entry.git_ignored = ignored.contains(repo_relative_path);
            }
        }

        Ok(())
    }

    fn git_info_for_repository(
        &self,
        repository: &git::Repository,
    ) -> Result<DirectoryGitInfo, FsError> {
        if !repository.root.starts_with(&self.root) {
            return Err(FsError::PathEscapesRoot);
        }

        let root_path = repository
            .root
            .strip_prefix(&self.root)
            .map_err(|_| FsError::PathEscapesRoot)?;

        Ok(DirectoryGitInfo {
            root_path: relative_path_string(root_path),
            branch: repository.branch.clone(),
            dirty: repository.dirty,
        })
    }

    fn project_root_for_repository(
        &self,
        repository: &git::Repository,
    ) -> Result<ProjectRoot, FsError> {
        if !repository.root.starts_with(&self.root) {
            return Err(FsError::PathEscapesRoot);
        }

        let relative_path = self.logical_path_for_absolute(&repository.root)?;
        let name = repository
            .root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| relative_path.clone());

        Ok(ProjectRoot {
            name,
            root_path: repository.root.display().to_string(),
            relative_path,
        })
    }

    fn repository_for_request(&self, requested_path: &str) -> Result<git::Repository, FsError> {
        let git_path = self.git_search_path(requested_path)?;

        let repository =
            git::repository_for(&git_path).ok_or_else(|| FsError::GitRepositoryNotFound {
                path: requested_path.to_string(),
            })?;

        if !repository.root.starts_with(&self.root) {
            return Err(FsError::PathEscapesRoot);
        }

        Ok(repository)
    }

    fn git_search_path(&self, requested_path: &str) -> Result<PathBuf, FsError> {
        let resolved = if Path::new(requested_path).is_absolute() {
            let candidate = PathBuf::from(requested_path);
            let absolute = candidate.canonicalize().map_err(|source| FsError::Io {
                action: "resolve path",
                path: requested_path.to_string(),
                source,
            })?;

            if !absolute.starts_with(&self.root) {
                return Err(FsError::PathEscapesRoot);
            }

            let logical = absolute
                .strip_prefix(&self.root)
                .map_err(|_| FsError::PathEscapesRoot)?
                .to_path_buf();
            ResolvedPath { logical, absolute }
        } else {
            self.resolve_existing(requested_path)?
        };
        let metadata = fs::metadata(&resolved.absolute).map_err(|source| FsError::Io {
            action: "read metadata",
            path: requested_path.to_string(),
            source,
        })?;

        if metadata.is_dir() {
            Ok(resolved.absolute)
        } else {
            resolved
                .absolute
                .parent()
                .map(Path::to_path_buf)
                .ok_or(FsError::PathEscapesRoot)
        }
    }
}

#[derive(Debug)]
struct ResolvedPath {
    logical: PathBuf,
    absolute: PathBuf,
}

fn normalize_relative_path(requested_path: &str) -> Result<PathBuf, FsError> {
    if requested_path.is_empty() || requested_path == "." {
        return Ok(PathBuf::new());
    }

    let path = Path::new(requested_path);
    if path.is_absolute() {
        return Err(FsError::PathEscapesRoot);
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(FsError::PathEscapesRoot);
            }
        }
    }

    Ok(normalized)
}

fn git_change_category(entry: &git::StatusEntry) -> GitChangeCategory {
    if entry.untracked {
        GitChangeCategory::Untracked
    } else if entry.unstaged {
        GitChangeCategory::Unstaged
    } else {
        GitChangeCategory::Staged
    }
}

fn normalize_diff_kind(kind: &str) -> &'static str {
    match kind {
        "staged" => "staged",
        "untracked" => "untracked",
        _ => "unstaged",
    }
}

fn git_commit_summary(entry: git::LogEntry) -> GitCommitSummary {
    GitCommitSummary {
        sha: entry.sha,
        short_sha: entry.short_sha,
        subject: entry.subject,
        body: entry.body,
        author_name: entry.author_name,
        author_email: entry.author_email,
        author_time_ms: entry.author_time_ms,
    }
}

fn git_ref(branch_ref: git::BranchRef) -> GitRef {
    GitRef {
        name: branch_ref.name,
        kind: match branch_ref.kind {
            git::BranchRefKind::Head => GitRefKind::Head,
            git::BranchRefKind::Local => GitRefKind::Local,
            git::BranchRefKind::Remote => GitRefKind::Remote,
        },
    }
}

fn github_repository_info(repository: github::GithubRepository) -> GithubRepositoryInfo {
    GithubRepositoryInfo {
        owner: repository.owner,
        name: repository.name,
        name_with_owner: repository.name_with_owner,
        url: repository.url,
    }
}

fn github_issue_summary(issue: github::GithubIssueSummary) -> GithubIssueSummary {
    GithubIssueSummary {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.author,
        labels: issue.labels,
        assignees: issue.assignees,
        comments: issue.comments,
        updated_at: issue.updated_at,
        url: issue.url,
    }
}

fn github_issue_detail(issue: github::GithubIssueDetail) -> GithubIssueDetail {
    GithubIssueDetail {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        author: issue.author,
        labels: issue.labels,
        assignees: issue.assignees,
        comments: issue.comments,
        body: issue.body,
        body_html: issue.body_html,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        url: issue.url,
    }
}

fn github_pull_summary(pull: github::GithubPullSummary) -> GithubPullSummary {
    GithubPullSummary {
        number: pull.number,
        title: pull.title,
        state: pull.state,
        draft: pull.draft,
        author: pull.author,
        labels: pull.labels,
        comments: pull.comments,
        updated_at: pull.updated_at,
        url: pull.url,
    }
}

fn github_pull_detail(pull: github::GithubPullDetail) -> GithubPullDetail {
    GithubPullDetail {
        number: pull.number,
        title: pull.title,
        state: pull.state,
        draft: pull.draft,
        author: pull.author,
        labels: pull.labels,
        comments: pull.comments,
        reviews: pull.reviews,
        commits: pull.commits,
        additions: pull.additions,
        deletions: pull.deletions,
        changed_files: pull.changed_files,
        base_ref_name: pull.base_ref_name,
        head_ref_name: pull.head_ref_name,
        body: pull.body,
        body_html: pull.body_html,
        created_at: pull.created_at,
        updated_at: pull.updated_at,
        url: pull.url,
        conversation_comments: pull
            .conversation_comments
            .into_iter()
            .map(github_pull_comment)
            .collect(),
        review_comments: pull
            .review_comments
            .into_iter()
            .map(github_pull_review)
            .collect(),
        commit_summaries: pull
            .commit_summaries
            .into_iter()
            .map(github_pull_commit)
            .collect(),
    }
}

fn github_pull_comment(comment: github::GithubPullComment) -> GithubPullComment {
    GithubPullComment {
        author: comment.author,
        body: comment.body,
        body_html: comment.body_html,
        created_at: comment.created_at,
        updated_at: comment.updated_at,
        url: comment.url,
    }
}

fn github_pull_review(review: github::GithubPullReview) -> GithubPullReview {
    GithubPullReview {
        author: review.author,
        state: review.state,
        body: review.body,
        body_html: review.body_html,
        submitted_at: review.submitted_at,
    }
}

fn github_pull_commit(commit: github::GithubPullCommit) -> GithubPullCommit {
    GithubPullCommit {
        sha: commit.sha,
        short_sha: commit.short_sha,
        subject: commit.subject,
        author_name: commit.author_name,
        author_email: commit.author_email,
        authored_at: commit.authored_at,
        committed_at: commit.committed_at,
        url: commit.url,
    }
}

fn github_pull_file(repository: &DirectoryGitInfo, file: github::GithubPullFile) -> GithubPullFile {
    GithubPullFile {
        path: join_relative_path(&repository.root_path, &file.filename),
        repo_relative_path: file.filename,
        previous_path: file
            .previous_filename
            .as_deref()
            .map(|path| join_relative_path(&repository.root_path, path)),
        previous_repo_relative_path: file.previous_filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch_available: file.patch.is_some(),
        blob_url: file.blob_url,
        raw_url: file.raw_url,
    }
}

fn normalize_github_issue_state(state: &str) -> &'static str {
    match state {
        "closed" => "closed",
        "all" => "all",
        _ => "open",
    }
}

fn short_commit_label(commit_sha: &str) -> String {
    commit_sha.chars().take(7).collect()
}

fn join_relative_path(base: &str, child: &str) -> String {
    if base.is_empty() {
        child.to_string()
    } else {
        format!("{base}/{child}")
    }
}

fn strip_repo_root<'a>(repo_root: &str, path: &'a str) -> Option<&'a str> {
    if repo_root.is_empty() {
        return (!path.is_empty()).then_some(path);
    }

    if path == repo_root {
        return None;
    }

    path.strip_prefix(&format!("{repo_root}/"))
        .filter(|relative| !relative.is_empty())
}

fn entry_kind(metadata: &fs::Metadata) -> EntryKind {
    if metadata.is_dir() {
        EntryKind::Directory
    } else if metadata.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn relative_path_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn language_hint(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    let language = match extension.as_str() {
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" => "cpp",
        "css" => "css",
        "go" => "go",
        "html" | "htm" => "xml",
        "java" => "java",
        "js" | "mjs" | "cjs" => "javascript",
        "json" => "json",
        "kt" | "kts" => "kotlin",
        "md" | "markdown" => "markdown",
        "py" => "python",
        "rb" => "ruby",
        "rs" => "rust",
        "sh" | "bash" | "zsh" => "bash",
        "sql" => "sql",
        "toml" => "toml",
        "ts" | "tsx" => "typescript",
        "xml" => "xml",
        "yaml" | "yml" => "yaml",
        _ => return None,
    };

    Some(language.to_string())
}

fn image_content_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_lowercase();
    match extension.as_str() {
        "avif" => Some("image/avif"),
        "gif" => Some("image/gif"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml; charset=utf-8"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_includes_hidden_files() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(".hidden"), "secret").unwrap();
        fs::write(temp.path().join("visible.txt"), "hello").unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();
        let list = rooted.list("").unwrap();
        let names = list
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();

        assert!(names.contains(&".hidden"));
        assert!(names.contains(&"visible.txt"));
    }

    #[test]
    fn list_marks_git_repository_entries_and_current_repo() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo_path = temp.path().join("repo");
        fs::create_dir(&repo_path).unwrap();
        git(&repo_path, &["init"]);
        fs::write(repo_path.join("new.txt"), "hello").unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();
        let parent_list = rooted.list("").unwrap();
        let repo_entry = parent_list
            .entries
            .iter()
            .find(|entry| entry.name == "repo")
            .unwrap();

        assert_eq!(repo_entry.git, Some(EntryGitInfo { is_repo_root: true }));

        let repo_list = rooted.list("repo").unwrap();
        let git = repo_list.git.unwrap();
        assert_eq!(git.root_path, "repo");
        assert!(git.branch.is_some());
        assert!(git.dirty);
    }

    #[test]
    fn list_marks_git_ignored_entries_in_current_repo() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo_path = temp.path().join("repo");
        fs::create_dir(&repo_path).unwrap();
        git(&repo_path, &["init"]);
        fs::write(repo_path.join(".gitignore"), "ignored.log\nbuild/\n").unwrap();
        fs::write(repo_path.join("ignored.log"), "ignore me").unwrap();
        fs::write(repo_path.join("visible.log"), "show me").unwrap();
        fs::create_dir(repo_path.join("build")).unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();
        let repo_list = rooted.list("repo").unwrap();
        let ignored_file = repo_list
            .entries
            .iter()
            .find(|entry| entry.name == "ignored.log")
            .unwrap();
        let ignored_dir = repo_list
            .entries
            .iter()
            .find(|entry| entry.name == "build")
            .unwrap();
        let visible_file = repo_list
            .entries
            .iter()
            .find(|entry| entry.name == "visible.log")
            .unwrap();

        assert!(ignored_file.git_ignored);
        assert!(ignored_dir.git_ignored);
        assert!(!visible_file.git_ignored);
    }

    #[test]
    fn finds_project_root_for_path_inside_repo() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo_path = temp.path().join("repo");
        let src_path = repo_path.join("src");
        fs::create_dir(&repo_path).unwrap();
        fs::create_dir(&src_path).unwrap();
        git(&repo_path, &["init"]);
        fs::write(src_path.join("main.rs"), "fn main() {}\n").unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();
        let project = rooted.project_root_for_path("repo/src/main.rs").unwrap();

        assert_eq!(project.name, "repo");
        assert_eq!(project.relative_path, "repo");
        assert_eq!(
            project.root_path,
            repo_path.canonicalize().unwrap().display().to_string()
        );
    }

    #[test]
    fn reads_git_log_commit_files_and_commit_diff() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo_path = temp.path().join("repo");
        fs::create_dir(&repo_path).unwrap();
        git(&repo_path, &["init"]);
        fs::write(repo_path.join("sample.txt"), "old\n").unwrap();
        git(&repo_path, &["add", "sample.txt"]);
        commit(&repo_path, "Add sample");
        fs::write(repo_path.join("sample.txt"), "new\n").unwrap();
        git(&repo_path, &["add", "sample.txt"]);
        commit_with_body(
            &repo_path,
            "Update sample",
            "Explain the sample update.\n\nKeep the body available.",
        );

        let rooted = RootedFs::new(temp.path()).unwrap();
        let log = rooted.git_log("repo", 1, 10).unwrap();
        assert_eq!(log.repository.root_path, "repo");
        assert_eq!(log.page, 1);
        assert_eq!(log.per_page, 10);
        assert_eq!(log.total_commits, 2);
        assert_eq!(log.total_pages, 1);
        assert!(!log.has_previous);
        assert!(!log.has_next);
        assert_eq!(log.commits[0].subject, "Update sample");
        assert_eq!(
            log.commits[0].body,
            "Explain the sample update.\n\nKeep the body available."
        );

        let older_log = rooted.git_log("repo", 2, 1).unwrap();
        assert_eq!(older_log.page, 2);
        assert_eq!(older_log.per_page, 1);
        assert_eq!(older_log.total_commits, 2);
        assert_eq!(older_log.total_pages, 2);
        assert!(older_log.has_previous);
        assert!(!older_log.has_next);
        assert_eq!(older_log.commits[0].subject, "Add sample");

        let commit = rooted.git_commit("repo", &log.commits[0].sha).unwrap();
        assert_eq!(
            commit.commit.body,
            "Explain the sample update.\n\nKeep the body available."
        );
        assert_eq!(commit.files[0].path, "repo/sample.txt");
        assert_eq!(commit.files[0].repo_relative_path, "sample.txt");
        assert_eq!(commit.files[0].status, "M");

        let diff = rooted
            .git_commit_diff("repo", &log.commits[0].sha, "repo/sample.txt")
            .unwrap();
        assert_eq!(diff.repo_relative_path, "sample.txt");
        assert!(diff.diff.contains("-old"));
        assert!(diff.diff.contains("+new"));
    }

    #[test]
    fn reads_git_compare_files_and_compare_diff() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo_path = temp.path().join("repo");
        fs::create_dir(&repo_path).unwrap();
        git(&repo_path, &["init"]);
        fs::write(repo_path.join("sample.txt"), "old\n").unwrap();
        git(&repo_path, &["add", "sample.txt"]);
        commit(&repo_path, "Add sample");
        git(
            &repo_path,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );
        git(&repo_path, &["checkout", "-b", "feature/review"]);
        fs::write(repo_path.join("sample.txt"), "new\n").unwrap();
        fs::write(repo_path.join("added.txt"), "added\n").unwrap();
        git(&repo_path, &["add", "sample.txt", "added.txt"]);
        commit(&repo_path, "Update sample");

        let rooted = RootedFs::new(temp.path()).unwrap();
        let refs = rooted.git_refs("repo").unwrap();
        assert_eq!(refs.default_base_ref.as_deref(), Some("origin/main"));
        assert_eq!(refs.default_head_ref.as_deref(), Some("feature/review"));
        assert!(refs.refs.iter().any(|branch_ref| {
            branch_ref.name == "feature/review" && branch_ref.kind == GitRefKind::Local
        }));
        assert!(refs.refs.iter().any(|branch_ref| {
            branch_ref.name == "origin/main" && branch_ref.kind == GitRefKind::Remote
        }));

        let compare = rooted.git_compare("repo", None, None).unwrap();
        assert_eq!(compare.repository.root_path, "repo");
        assert_eq!(compare.base_ref, "origin/main");
        assert_eq!(compare.head_ref, "feature/review");
        assert_eq!(compare.files.len(), 2);
        assert!(compare.files.iter().any(|file| {
            file.path == "repo/sample.txt"
                && file.repo_relative_path == "sample.txt"
                && file.status == "M"
        }));

        let diff = rooted
            .git_compare_diff(
                "repo",
                Some("origin/main"),
                Some("feature/review"),
                "repo/sample.txt",
            )
            .unwrap();
        assert_eq!(diff.repo_relative_path, "sample.txt");
        assert_eq!(diff.kind, "origin/main...feature/review");
        assert!(diff.diff.contains("-old"));
        assert!(diff.diff.contains("+new"));
    }

    #[test]
    fn exposes_detached_head_as_git_ref() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let repo_path = temp.path().join("repo");
        fs::create_dir(&repo_path).unwrap();
        git(&repo_path, &["init"]);
        fs::write(repo_path.join("sample.txt"), "old\n").unwrap();
        git(&repo_path, &["add", "sample.txt"]);
        commit(&repo_path, "Add sample");
        git(&repo_path, &["checkout", "--detach", "HEAD"]);

        let rooted = RootedFs::new(temp.path()).unwrap();
        let refs = rooted.git_refs("repo").unwrap();

        assert_eq!(refs.default_head_ref.as_deref(), Some("HEAD"));
        assert!(
            refs.refs
                .iter()
                .any(|branch_ref| branch_ref.name == "HEAD" && branch_ref.kind == GitRefKind::Head)
        );
    }

    #[test]
    fn rejects_parent_path_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(rooted.list("../"), Err(FsError::PathEscapesRoot)));
        assert!(matches!(
            rooted.read_file("../secret.txt"),
            Err(FsError::PathEscapesRoot)
        ));
    }

    #[test]
    fn rejects_absolute_path() {
        let temp = tempfile::tempdir().unwrap();
        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("/etc/passwd"),
            Err(FsError::PathEscapesRoot)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), "nope").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            root.path().join("escape.txt"),
        )
        .unwrap();

        let rooted = RootedFs::new(root.path()).unwrap();

        assert!(matches!(
            rooted.read_file("escape.txt"),
            Err(FsError::PathEscapesRoot)
        ));
        assert!(
            rooted
                .list("")
                .unwrap()
                .entries
                .iter()
                .any(|entry| entry.name == "escape.txt" && !entry.supported)
        );
    }

    #[test]
    fn rejects_directory_as_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join("src")).unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("src"),
            Err(FsError::IsDirectory { .. })
        ));
    }

    #[test]
    fn rejects_binary_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("binary.bin"), b"abc\0def").unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("binary.bin"),
            Err(FsError::BinaryFile { .. })
        ));
    }

    #[test]
    fn rejects_invalid_utf8_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("invalid.txt"), [0xff, 0xfe, 0xfd]).unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("invalid.txt"),
            Err(FsError::InvalidUtf8 { .. })
        ));
    }

    #[test]
    fn reads_supported_image_preview() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("preview.svg"),
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>"#,
        )
        .unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();
        let image = rooted.read_image("preview.svg").unwrap();

        assert_eq!(image.path, "preview.svg");
        assert_eq!(image.name, "preview.svg");
        assert_eq!(image.content_type, "image/svg+xml; charset=utf-8");
        assert!(image.bytes.starts_with(b"<svg"));
    }

    #[test]
    fn rejects_unsupported_image_preview_type() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("notes.txt"), "hello").unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_image("notes.txt"),
            Err(FsError::UnsupportedImage { .. })
        ));
    }

    #[test]
    fn rejects_large_file() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join("large.txt"),
            vec![b'a'; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();

        let rooted = RootedFs::new(temp.path()).unwrap();

        assert!(matches!(
            rooted.read_file("large.txt"),
            Err(FsError::FileTooLarge { .. })
        ));
    }

    fn git_is_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn git(path: &Path, args: &[&str]) {
        let output = std::process::Command::new("git")
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
