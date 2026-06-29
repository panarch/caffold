use std::{
    env, fs, io,
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

use serde::Serialize;
use thiserror::Error;

use crate::git;

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

        entries.sort_by(|left, right| {
            left.kind
                .cmp(&right.kind)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });

        Ok(ListResponse {
            root: self.root.display().to_string(),
            path: relative_path_string(&resolved.logical),
            entries,
            git: self.git_info_for(&resolved.absolute),
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
            size: metadata.is_file().then_some(metadata.len()),
            modified_ms: modified_ms(&metadata),
            git,
        })
    }

    fn git_info_for(&self, absolute_path: &Path) -> Option<DirectoryGitInfo> {
        let repository = git::repository_for(absolute_path)?;
        self.git_info_for_repository(&repository).ok()
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

    fn repository_for_request(&self, requested_path: &str) -> Result<git::Repository, FsError> {
        let resolved = self.resolve_existing(requested_path)?;
        let metadata = fs::metadata(&resolved.absolute).map_err(|source| FsError::Io {
            action: "read metadata",
            path: requested_path.to_string(),
            source,
        })?;
        let git_path = if metadata.is_dir() {
            resolved.absolute
        } else {
            resolved
                .absolute
                .parent()
                .map(Path::to_path_buf)
                .ok_or(FsError::PathEscapesRoot)?
        };

        let repository =
            git::repository_for(&git_path).ok_or_else(|| FsError::GitRepositoryNotFound {
                path: requested_path.to_string(),
            })?;

        if !repository.root.starts_with(&self.root) {
            return Err(FsError::PathEscapesRoot);
        }

        Ok(repository)
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
}
