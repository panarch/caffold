use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, Options, Parser, Tag};
use serde::Serialize;

use super::super::{TaskEventRecord, TaskRecord};
use crate::fs::RootedFs;

const MAX_FILE_LINK_TARGET_BYTES: usize = 4096;
const MAX_FILE_LINKS_PER_RESPONSE: usize = 256;
const MAX_CACHED_FILE_LINKS: usize = 4096;

#[derive(Clone)]
pub(super) struct TaskFileLinkResolver {
    fs: Arc<RootedFs>,
    cache: Arc<Mutex<HashMap<CacheKey, ResolvedTarget>>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskFileLink {
    pub(in crate::app) event_id: String,
    pub(in crate::app) target: String,
    pub(in crate::app) path: String,
    pub(in crate::app) task_relative_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app) line: Option<u32>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct CacheKey {
    task_root: String,
    target: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedTarget {
    path: String,
    task_relative_path: String,
    line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EventLinkTarget {
    event_id: String,
    target: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolveFileLinkFailure {
    InvalidTarget,
    InvalidLine,
    NotFound,
    Directory,
    NotFile,
    OutsideRoot,
    Unreadable,
}

impl TaskFileLinkResolver {
    pub(super) fn new(fs: Arc<RootedFs>) -> Self {
        Self {
            fs,
            cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(super) async fn resolve_task(
        &self,
        task: &TaskRecord,
        events: &[TaskEventRecord],
    ) -> Vec<TaskFileLink> {
        self.resolve(task_root(task), collect_event_link_targets(events))
            .await
    }

    pub(super) async fn resolve_event(
        &self,
        task_root: &str,
        event: &TaskEventRecord,
    ) -> Vec<TaskFileLink> {
        self.resolve(
            task_root.to_string(),
            collect_event_link_targets(std::slice::from_ref(event)),
        )
        .await
    }

    async fn resolve(&self, task_root: String, targets: Vec<EventLinkTarget>) -> Vec<TaskFileLink> {
        if targets.is_empty() {
            return Vec::new();
        }
        let resolver = self.clone();
        tokio::task::spawn_blocking(move || resolver.resolve_blocking(&task_root, targets))
            .await
            .unwrap_or_default()
    }

    fn resolve_blocking(
        &self,
        task_root: &str,
        targets: Vec<EventLinkTarget>,
    ) -> Vec<TaskFileLink> {
        let Some(root) = PreparedTaskRoot::new(self.fs.as_ref(), task_root) else {
            return Vec::new();
        };
        targets
            .into_iter()
            .filter_map(|candidate| {
                let resolved = self.resolve_cached(&root, &candidate.target).ok()?;
                Some(TaskFileLink {
                    event_id: candidate.event_id,
                    target: candidate.target,
                    path: resolved.path,
                    task_relative_path: resolved.task_relative_path,
                    line: resolved.line,
                })
            })
            .collect()
    }

    fn resolve_cached(
        &self,
        root: &PreparedTaskRoot,
        target: &str,
    ) -> Result<ResolvedTarget, ResolveFileLinkFailure> {
        let key = CacheKey {
            task_root: root.logical.clone(),
            target: target.to_string(),
        };
        if let Some(resolved) = self
            .cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(&key).cloned())
        {
            return Ok(resolved);
        }

        let resolved = resolve_target(self.fs.as_ref(), root, target)?;
        if let Ok(mut cache) = self.cache.lock() {
            if cache.len() >= MAX_CACHED_FILE_LINKS {
                cache.clear();
            }
            cache.insert(key, resolved.clone());
        }
        Ok(resolved)
    }
}

struct PreparedTaskRoot {
    logical: String,
    absolute: PathBuf,
}

impl PreparedTaskRoot {
    fn new(fs: &RootedFs, task_root: &str) -> Option<Self> {
        let absolute = fs.absolute_directory_path(task_root).ok()?;
        let logical = fs.logical_path_for_absolute(&absolute).ok()?;
        Some(Self { logical, absolute })
    }
}

pub(super) fn task_root(task: &TaskRecord) -> String {
    task.worktree
        .as_ref()
        .map(|worktree| worktree.root_path.as_str())
        .or(task.cwd_path.as_deref())
        .filter(|path| !path.trim().is_empty())
        .unwrap_or(".")
        .to_string()
}

fn collect_event_link_targets(events: &[TaskEventRecord]) -> Vec<EventLinkTarget> {
    let mut seen = HashSet::new();
    let mut targets = Vec::new();
    for event in events {
        for markdown in event_markdown(event) {
            let parser = Parser::new_ext(&markdown, Options::ENABLE_GFM);
            for parsed in parser {
                let Event::Start(Tag::Link { dest_url, .. }) = parsed else {
                    continue;
                };
                let target = dest_url.into_string();
                if target.len() > MAX_FILE_LINK_TARGET_BYTES
                    || !is_local_file_candidate(&target)
                    || !seen.insert((event.id.clone(), target.clone()))
                {
                    continue;
                }
                targets.push(EventLinkTarget {
                    event_id: event.id.clone(),
                    target,
                });
                if targets.len() >= MAX_FILE_LINKS_PER_RESPONSE {
                    return targets;
                }
            }
        }
    }
    targets
}

fn event_markdown(event: &TaskEventRecord) -> Vec<String> {
    let Some(payload) = event.payload.as_ref() else {
        return Vec::new();
    };
    match event.event_type.as_str() {
        "assistant_message" => payload
            .get("text")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
            .into_iter()
            .collect(),
        "reasoning" => {
            let markdown = ["summary", "content"]
                .into_iter()
                .map(|key| string_values(payload.get(key)).join("\n\n"))
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            (!markdown.is_empty())
                .then_some(markdown)
                .into_iter()
                .collect()
        }
        "user_message" => {
            let payload_text = payload
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim();
            let prompt = payload
                .get("prompt")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .trim();
            let content = payload
                .get("content")
                .or_else(|| payload.get("item").and_then(|item| item.get("content")))
                .and_then(serde_json::Value::as_array);
            let item_text = content
                .into_iter()
                .flatten()
                .filter_map(
                    |item| match item.get("type").and_then(serde_json::Value::as_str) {
                        Some("text" | "input_text") => {
                            item.get("text").and_then(serde_json::Value::as_str)
                        }
                        _ => None,
                    },
                )
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let markdown = if !payload_text.is_empty() {
                payload_text.to_string()
            } else if !prompt.is_empty() {
                prompt.to_string()
            } else {
                item_text
            };
            (!markdown.is_empty())
                .then_some(markdown)
                .into_iter()
                .collect()
        }
        _ => Vec::new(),
    }
}

fn string_values(value: Option<&serde_json::Value>) -> Vec<String> {
    value
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_string)
        .collect()
}

fn is_local_file_candidate(value: &str) -> bool {
    let target = value.trim();
    if target.is_empty() || target.starts_with('#') || is_caffold_application_path(target) {
        return false;
    }
    !target.split_once(':').is_some_and(|(scheme, _)| {
        matches!(
            scheme.to_ascii_lowercase().as_str(),
            "http" | "https" | "mailto"
        )
    })
}

fn is_caffold_application_path(value: &str) -> bool {
    if !value.starts_with('/') {
        return false;
    }
    let path = value.split(['?', '#']).next().unwrap_or(value);
    path == "/"
        || path == "/tasks"
        || path.starts_with("/tasks/")
        || path == "/settings"
        || path.starts_with("/settings/")
        || path == "/api"
        || path.starts_with("/api/")
        || path == "/assets"
        || path.starts_with("/assets/")
        || path == "/service-worker.js"
}

fn resolve_target(
    rooted_fs: &RootedFs,
    task_root: &PreparedTaskRoot,
    target: &str,
) -> Result<ResolvedTarget, ResolveFileLinkFailure> {
    let trimmed = target.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(ResolveFileLinkFailure::InvalidTarget);
    }
    let decoded = percent_decode_str(trimmed)
        .decode_utf8()
        .map_err(|_| ResolveFileLinkFailure::InvalidTarget)?;
    if decoded.contains('\0') {
        return Err(ResolveFileLinkFailure::InvalidTarget);
    }

    match resolve_candidate(rooted_fs, &task_root.absolute, decoded.as_ref()) {
        Ok(path) => Ok(resolved_target(&task_root.logical, path, None)),
        Err(ResolveFileLinkFailure::NotFound) => {
            let Some((path_target, line)) = trailing_line_reference(decoded.as_ref())? else {
                return Err(ResolveFileLinkFailure::NotFound);
            };
            let path = resolve_candidate(rooted_fs, &task_root.absolute, path_target)?;
            Ok(resolved_target(&task_root.logical, path, Some(line)))
        }
        Err(failure) => Err(failure),
    }
}

fn resolve_candidate(
    rooted_fs: &RootedFs,
    task_root_absolute: &Path,
    target: &str,
) -> Result<String, ResolveFileLinkFailure> {
    let target_path = Path::new(target);
    let candidate = if target_path.is_absolute() {
        target_path.to_path_buf()
    } else {
        task_root_absolute.join(target_path)
    };
    let logical = rooted_fs
        .logical_path_for_absolute(&candidate)
        .map_err(resolve_fs_failure)?;
    let canonical = rooted_fs.root().join(&logical);
    let metadata = fs::metadata(&canonical).map_err(resolve_io_failure)?;
    if metadata.is_dir() {
        return Err(ResolveFileLinkFailure::Directory);
    }
    if !metadata.is_file() {
        return Err(ResolveFileLinkFailure::NotFile);
    }
    fs::File::open(canonical).map_err(resolve_io_failure)?;
    Ok(logical)
}

fn trailing_line_reference(target: &str) -> Result<Option<(&str, u32)>, ResolveFileLinkFailure> {
    let Some((path, suffix)) = target.rsplit_once(':') else {
        return Ok(None);
    };
    if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
        return Ok(None);
    }
    if path.is_empty() {
        return Err(ResolveFileLinkFailure::InvalidTarget);
    }
    let line = suffix
        .parse::<u32>()
        .ok()
        .filter(|line| *line > 0)
        .ok_or(ResolveFileLinkFailure::InvalidLine)?;
    Ok(Some((path, line)))
}

fn resolved_target(task_root: &str, path: String, line: Option<u32>) -> ResolvedTarget {
    ResolvedTarget {
        task_relative_path: relative_logical_path(task_root, &path),
        path,
        line,
    }
}

fn relative_logical_path(base: &str, target: &str) -> String {
    let base = logical_segments(base);
    let target = logical_segments(target);
    let common = base
        .iter()
        .zip(&target)
        .take_while(|(left, right)| left == right)
        .count();
    let mut relative = vec![".."; base.len().saturating_sub(common)];
    relative.extend(target[common..].iter().copied());
    relative.join("/")
}

fn logical_segments(path: &str) -> Vec<&str> {
    path.split('/')
        .filter(|segment| !segment.is_empty() && *segment != ".")
        .collect()
}

fn resolve_fs_failure(error: crate::fs::FsError) -> ResolveFileLinkFailure {
    use crate::fs::FsError;

    match error {
        FsError::PathEscapesRoot => ResolveFileLinkFailure::OutsideRoot,
        FsError::RootUnavailable { source, .. } => resolve_io_failure(source),
        FsError::NotFound { .. } => ResolveFileLinkFailure::NotFound,
        FsError::IsDirectory { .. } | FsError::NotDirectory { .. } => {
            ResolveFileLinkFailure::Directory
        }
        FsError::NotFile { .. } => ResolveFileLinkFailure::NotFile,
        FsError::Io { source, .. } => resolve_io_failure(source),
        _ => ResolveFileLinkFailure::Unreadable,
    }
}

fn resolve_io_failure(error: std::io::Error) -> ResolveFileLinkFailure {
    match error.kind() {
        std::io::ErrorKind::NotFound => ResolveFileLinkFailure::NotFound,
        std::io::ErrorKind::PermissionDenied => ResolveFileLinkFailure::Unreadable,
        _ => ResolveFileLinkFailure::Unreadable,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use tempfile::tempdir;

    use super::*;
    use crate::{
        app::tasks::{
            events::task_event_record,
            tests::support::{cache_and_manage_test_thread, task_state_with_codex_client},
        },
        codex_app_server::CodexThreadClient,
    };

    fn prepared(fs: &RootedFs, task_root: &str) -> PreparedTaskRoot {
        PreparedTaskRoot::new(fs, task_root).unwrap()
    }

    #[test]
    fn extracts_only_markdown_link_destinations_from_owned_event_text() {
        let event = task_event_record(
            "thread",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({
                "text": "[relative](src/lib.rs:7) [external](https://example.com) `not [code](hidden.rs)`\n\n[app](/settings)"
            })),
            1,
        );

        assert_eq!(
            collect_event_link_targets(&[event]),
            vec![EventLinkTarget {
                event_id: "thread:assistant".to_string(),
                target: "src/lib.rs:7".to_string(),
            }]
        );
    }

    #[tokio::test]
    async fn projects_resolved_sidecars_once_and_keeps_successes_stable() {
        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        fs::write(task.join("owned.rs"), "pub fn owned() {}").unwrap();
        let resolver = TaskFileLinkResolver::new(Arc::new(RootedFs::new(root.path()).unwrap()));
        let event = task_event_record(
            "thread",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({ "text": "[Owned](owned.rs:7) [Missing](missing.rs)" })),
            1,
        );
        let targets = collect_event_link_targets(&[event]);

        let first = resolver.resolve("task".to_string(), targets.clone()).await;
        fs::remove_file(task.join("owned.rs")).unwrap();
        let cached = resolver.resolve("task".to_string(), targets).await;

        assert_eq!(first, cached);
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            json!([{
                "eventId": "thread:assistant",
                "target": "owned.rs:7",
                "path": "task/owned.rs",
                "taskRelativePath": "owned.rs",
                "line": 7
            }])
        );
    }

    #[tokio::test]
    async fn task_detail_projects_owned_file_links_without_another_http_request() {
        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        fs::write(task.join("owned.rs"), "pub fn owned() {}").unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        cache_and_manage_test_thread(&state, "thread-owned-links", &task).await;
        state.task_events.publish(task_event_record(
            "thread-owned-links",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({ "text": "[Owned](owned.rs:7)" })),
            1,
        ));

        let (detail, _) = state.detail.cached("thread-owned-links").await.unwrap();

        assert_eq!(
            detail.file_links,
            vec![TaskFileLink {
                event_id: "thread-owned-links:assistant".to_string(),
                target: "owned.rs:7".to_string(),
                path: "task/owned.rs".to_string(),
                task_relative_path: "owned.rs".to_string(),
                line: Some(7),
            }]
        );
    }

    #[test]
    fn resolves_relative_slashless_absolute_and_outside_task_paths() {
        let root = tempdir().unwrap();
        let task = root.path().join("projects/task");
        let sibling = root.path().join("projects/shared");
        fs::create_dir_all(task.join("src")).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(task.join("README.md"), "readme").unwrap();
        fs::write(task.join("space name.rs"), "space").unwrap();
        fs::write(task.join("src/lib.rs"), "lib").unwrap();
        fs::write(sibling.join("shared.rs"), "shared").unwrap();
        let rooted_fs = RootedFs::new(root.path()).unwrap();
        let prepared = prepared(&rooted_fs, "projects/task");

        let resolve = |target: &str| resolve_target(&rooted_fs, &prepared, target).unwrap();
        assert_eq!(
            resolve("README.md"),
            resolved_target("projects/task", "projects/task/README.md".to_string(), None)
        );
        assert_eq!(
            resolve("space%20name.rs"),
            resolved_target(
                "projects/task",
                "projects/task/space name.rs".to_string(),
                None,
            )
        );
        assert_eq!(
            resolve("src/lib.rs"),
            resolved_target(
                "projects/task",
                "projects/task/src/lib.rs".to_string(),
                None
            )
        );
        assert_eq!(
            resolve(&sibling.join("shared.rs").display().to_string()),
            resolved_target(
                "projects/task",
                "projects/shared/shared.rs".to_string(),
                None,
            )
        );
        assert_eq!(
            resolve("../shared/shared.rs"),
            resolved_target(
                "projects/task",
                "projects/shared/shared.rs".to_string(),
                None,
            )
        );
    }

    #[test]
    fn prefers_an_exact_colon_filename_before_parsing_a_line() {
        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        fs::write(task.join("report"), "plain").unwrap();
        fs::write(task.join("report:17"), "colon").unwrap();
        fs::create_dir(task.join("blocked:17")).unwrap();
        let rooted_fs = RootedFs::new(root.path()).unwrap();
        let prepared = prepared(&rooted_fs, "task");

        assert_eq!(
            resolve_target(&rooted_fs, &prepared, "report:17"),
            Ok(resolved_target("task", "task/report:17".to_string(), None,))
        );
        assert_eq!(
            resolve_target(&rooted_fs, &prepared, "blocked:17"),
            Err(ResolveFileLinkFailure::Directory)
        );

        fs::remove_file(task.join("report:17")).unwrap();
        assert_eq!(
            resolve_target(&rooted_fs, &prepared, "report:17"),
            Ok(resolved_target("task", "task/report".to_string(), Some(17),))
        );
    }

    #[test]
    fn rejects_missing_directories_invalid_lines_and_root_escapes() {
        let outer = tempdir().unwrap();
        let root = outer.path().join("browse");
        let task = root.join("task");
        fs::create_dir_all(task.join("directory")).unwrap();
        fs::write(outer.path().join("secret.txt"), "secret").unwrap();
        let rooted_fs = RootedFs::new(&root).unwrap();
        let prepared = prepared(&rooted_fs, "task");

        let cases = [
            ("", ResolveFileLinkFailure::InvalidTarget),
            ("bad\0path", ResolveFileLinkFailure::InvalidTarget),
            ("bad%00path", ResolveFileLinkFailure::InvalidTarget),
            ("missing.rs", ResolveFileLinkFailure::NotFound),
            ("directory", ResolveFileLinkFailure::Directory),
            ("missing.rs:0", ResolveFileLinkFailure::InvalidLine),
            ("missing.rs:4294967296", ResolveFileLinkFailure::InvalidLine),
            ("../../secret.txt", ResolveFileLinkFailure::OutsideRoot),
        ];
        for (target, expected) in cases {
            assert_eq!(
                resolve_target(&rooted_fs, &prepared, target),
                Err(expected),
                "{target}",
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn canonicalizes_in_root_symlinks_and_rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;

        let outer = tempdir().unwrap();
        let root = outer.path().join("browse");
        let task = root.join("task");
        let shared = root.join("shared");
        fs::create_dir_all(&task).unwrap();
        fs::create_dir(&shared).unwrap();
        fs::write(shared.join("inside.txt"), "inside").unwrap();
        symlink(shared.join("inside.txt"), task.join("inside.txt")).unwrap();
        let secret = outer.path().join("secret.txt");
        fs::write(&secret, "secret").unwrap();
        symlink(&secret, task.join("escape.txt")).unwrap();
        let rooted_fs = RootedFs::new(&root).unwrap();
        let prepared = prepared(&rooted_fs, "task");

        assert_eq!(
            resolve_target(&rooted_fs, &prepared, "inside.txt"),
            Ok(resolved_target(
                "task",
                "shared/inside.txt".to_string(),
                None,
            ))
        );
        assert_eq!(
            resolve_target(&rooted_fs, &prepared, "escape.txt"),
            Err(ResolveFileLinkFailure::OutsideRoot)
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_unreadable_regular_files() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        let unreadable = task.join("unreadable.txt");
        fs::write(&unreadable, "private").unwrap();
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();
        let rooted_fs = RootedFs::new(root.path()).unwrap();
        let prepared = prepared(&rooted_fs, "task");

        let result = resolve_target(&rooted_fs, &prepared, "unreadable.txt");

        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(result, Err(ResolveFileLinkFailure::Unreadable));
    }

    #[test]
    fn computes_private_task_relative_coordinates() {
        assert_eq!(
            relative_logical_path("Users/name/project", "Users/name/shared/lib.rs"),
            "../shared/lib.rs"
        );
        assert_eq!(
            relative_logical_path(".", "Users/name/project/lib.rs"),
            "Users/name/project/lib.rs"
        );
    }
}
