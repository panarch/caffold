use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Serialize;

use super::super::{TaskEventRecord, TaskRecord};
use crate::fs::RootedFs;

mod location;
mod occurrences;

use crate::fs;
use location::{FileLocation, FileLocationFailure, LocationFallback, parse_file_location};
use occurrences::{LinkOccurrence, collect_link_occurrences};

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
    pub(in crate::app) link_id: usize,
    pub(in crate::app) target: String,
    #[serde(flatten)]
    pub(in crate::app) outcome: TaskFileLinkOutcome,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub(in crate::app) enum TaskFileLinkOutcome {
    Resolved {
        path: String,
        #[serde(rename = "taskRelativePath")]
        task_relative_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        line: Option<u32>,
    },
    Rejected {
        reason: TaskFileLinkRejection,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(in crate::app) enum TaskFileLinkRejection {
    UnsupportedOrMalformedLocation,
    NotFound,
    NotRegularReadableFile,
    OutsideRoot,
    Truncated,
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
    link_id: usize,
    target: String,
    field: Option<MarkdownField>,
    source_range: std::ops::Range<usize>,
    label: String,
    recovered: bool,
    truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProjectedCandidate {
    candidate: EventLinkTarget,
    outcome: TaskFileLinkOutcome,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkdownSource {
    field: MarkdownField,
    markdown: String,
    source_offset: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum MarkdownField {
    Text,
    ReasoningSummary(usize),
    ReasoningContent(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ResolveFileLinkFailure {
    InvalidTarget,
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

    pub(super) async fn project_task(
        &self,
        task: &TaskRecord,
        events: &[TaskEventRecord],
    ) -> (Vec<TaskEventRecord>, Vec<TaskFileLink>) {
        self.project(task_root(task), events).await
    }

    pub(super) async fn project_event(
        &self,
        task_root: &str,
        event: &TaskEventRecord,
    ) -> (TaskEventRecord, Vec<TaskFileLink>) {
        let (mut events, links) = self
            .project(task_root.to_string(), std::slice::from_ref(event))
            .await;
        (events.pop().unwrap_or_else(|| event.clone()), links)
    }

    async fn project(
        &self,
        task_root: String,
        events: &[TaskEventRecord],
    ) -> (Vec<TaskEventRecord>, Vec<TaskFileLink>) {
        let targets = collect_event_link_targets(events);
        if targets.is_empty() {
            return (events.to_vec(), Vec::new());
        }
        let fallback_targets = targets.clone();
        let resolver = self.clone();
        let projected =
            tokio::task::spawn_blocking(move || resolver.resolve_blocking(&task_root, targets))
                .await
                .unwrap_or_else(|_| {
                    fallback_targets
                        .into_iter()
                        .map(|candidate| ProjectedCandidate {
                            candidate,
                            outcome: TaskFileLinkOutcome::Rejected {
                                reason: TaskFileLinkRejection::NotRegularReadableFile,
                            },
                        })
                        .collect()
                });
        let projected_events = project_events(events, &projected);
        let links = projected.iter().map(TaskFileLink::from).collect();
        (projected_events, links)
    }

    fn resolve_blocking(
        &self,
        task_root: &str,
        targets: Vec<EventLinkTarget>,
    ) -> Vec<ProjectedCandidate> {
        let root = PreparedTaskRoot::new(self.fs.as_ref(), task_root);
        targets
            .into_iter()
            .map(|candidate| {
                let outcome = if candidate.truncated {
                    TaskFileLinkOutcome::Rejected {
                        reason: TaskFileLinkRejection::Truncated,
                    }
                } else {
                    root.as_ref()
                        .map_err(|failure| *failure)
                        .and_then(|root| {
                            self.resolve_cached(root, &candidate.target, candidate.recovered)
                        })
                        .map(TaskFileLinkOutcome::from)
                        .unwrap_or_else(TaskFileLinkOutcome::from)
                };
                ProjectedCandidate { candidate, outcome }
            })
            .collect()
    }

    fn resolve_cached(
        &self,
        root: &PreparedTaskRoot,
        target: &str,
        recovered: bool,
    ) -> Result<ResolvedTarget, ResolveFileLinkFailure> {
        let key = CacheKey {
            task_root: root.logical.clone(),
            target: format!("{}:{target}", u8::from(recovered)),
        };
        if let Some(resolved) = self
            .cache
            .lock()
            .ok()
            .and_then(|cache| cache.get(&key).cloned())
        {
            return Ok(resolved);
        }

        let resolved = resolve_target_with_recovery(self.fs.as_ref(), root, target, recovered)?;
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
    fn new(fs: &RootedFs, task_root: &str) -> Result<Self, ResolveFileLinkFailure> {
        let absolute = fs
            .absolute_directory_path(task_root)
            .map_err(resolve_fs_failure)?;
        let logical = fs
            .logical_path_for_absolute(&absolute)
            .map_err(resolve_fs_failure)?;
        Ok(Self { logical, absolute })
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
    let mut targets = Vec::new();
    for event in events {
        let mut link_id = 0;
        for source in event_markdown_sources(event) {
            for occurrence in collect_link_occurrences(&source.markdown) {
                if targets.len() >= MAX_FILE_LINKS_PER_RESPONSE {
                    targets.push(truncated_target(event, link_id));
                    return targets;
                }
                targets.push(event_link_target(event, &source, link_id, occurrence));
                link_id += 1;
            }
        }
    }
    targets
}

fn event_link_target(
    event: &TaskEventRecord,
    source: &MarkdownSource,
    link_id: usize,
    mut occurrence: LinkOccurrence,
) -> EventLinkTarget {
    occurrence.source_range.start += source.source_offset;
    occurrence.source_range.end += source.source_offset;
    EventLinkTarget {
        event_id: event.id.clone(),
        link_id,
        target: occurrence.target,
        field: Some(source.field),
        source_range: occurrence.source_range,
        label: occurrence.label,
        recovered: occurrence.recovered,
        truncated: false,
    }
}

fn truncated_target(event: &TaskEventRecord, link_id: usize) -> EventLinkTarget {
    EventLinkTarget {
        event_id: event.id.clone(),
        link_id,
        target: String::new(),
        field: None,
        source_range: 0..0,
        label: String::new(),
        recovered: false,
        truncated: true,
    }
}

fn event_markdown_sources(event: &TaskEventRecord) -> Vec<MarkdownSource> {
    let Some(payload) = event.payload.as_ref() else {
        return Vec::new();
    };
    match event.event_type.as_str() {
        "assistant_message" => markdown_string_source(payload, "text", MarkdownField::Text)
            .into_iter()
            .collect(),
        "reasoning" => {
            let mut sources = reasoning_sources(payload, "summary", true);
            sources.extend(reasoning_sources(payload, "content", false));
            sources
        }
        _ => Vec::new(),
    }
}

fn markdown_string_source(
    payload: &serde_json::Value,
    key: &str,
    field: MarkdownField,
) -> Option<MarkdownSource> {
    let markdown = payload.get(key)?.as_str()?;
    (!markdown.trim().is_empty()).then(|| MarkdownSource {
        field,
        markdown: markdown.to_string(),
        source_offset: 0,
    })
}

fn reasoning_sources(payload: &serde_json::Value, key: &str, summary: bool) -> Vec<MarkdownSource> {
    payload
        .get(key)
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, value)| {
            let value = value.as_str()?;
            let markdown = value.trim();
            let source_offset = value.find(markdown)?;
            (!markdown.is_empty()).then(|| MarkdownSource {
                field: if summary {
                    MarkdownField::ReasoningSummary(index)
                } else {
                    MarkdownField::ReasoningContent(index)
                },
                markdown: markdown.to_string(),
                source_offset,
            })
        })
        .collect()
}

fn project_events(
    events: &[TaskEventRecord],
    projected: &[ProjectedCandidate],
) -> Vec<TaskEventRecord> {
    events
        .iter()
        .cloned()
        .map(|mut event| {
            let mut patches = projected
                .iter()
                .filter(|projection| projection.candidate.event_id == event.id)
                .filter_map(|projection| {
                    Some((
                        projection.candidate.field?,
                        projection.candidate.source_range.clone(),
                        projection.replacement_markdown(),
                    ))
                })
                .collect::<Vec<_>>();
            patches.sort_by(|left, right| {
                left.0
                    .cmp(&right.0)
                    .then_with(|| right.1.start.cmp(&left.1.start))
            });
            for (field, range, replacement) in patches {
                let Some(markdown) = markdown_field_mut(&mut event, field) else {
                    continue;
                };
                if range.end <= markdown.len()
                    && markdown.is_char_boundary(range.start)
                    && markdown.is_char_boundary(range.end)
                {
                    markdown.replace_range(range, &replacement);
                }
            }
            event
        })
        .collect()
}

fn markdown_field_mut(event: &mut TaskEventRecord, field: MarkdownField) -> Option<&mut String> {
    let payload = event.payload.as_mut()?;
    match field {
        MarkdownField::Text => json_string_mut(payload.get_mut("text")?),
        MarkdownField::ReasoningSummary(index) => {
            json_string_mut(payload.get_mut("summary")?.as_array_mut()?.get_mut(index)?)
        }
        MarkdownField::ReasoningContent(index) => {
            json_string_mut(payload.get_mut("content")?.as_array_mut()?.get_mut(index)?)
        }
    }
}

fn json_string_mut(value: &mut serde_json::Value) -> Option<&mut String> {
    match value {
        serde_json::Value::String(value) => Some(value),
        _ => None,
    }
}

impl ProjectedCandidate {
    fn projected_target(&self) -> String {
        match &self.outcome {
            TaskFileLinkOutcome::Resolved {
                task_relative_path,
                line,
                ..
            } => canonical_link_target(task_relative_path, *line),
            TaskFileLinkOutcome::Rejected { .. } => self.candidate.target.clone(),
        }
    }

    fn replacement_markdown(&self) -> String {
        match self.outcome {
            TaskFileLinkOutcome::Resolved { .. } => {
                format!("[{}]({})", self.candidate.label, self.projected_target())
            }
            TaskFileLinkOutcome::Rejected { .. } => self.candidate.label.clone(),
        }
    }
}

impl From<&ProjectedCandidate> for TaskFileLink {
    fn from(projected: &ProjectedCandidate) -> Self {
        Self {
            event_id: projected.candidate.event_id.clone(),
            link_id: projected.candidate.link_id,
            target: projected.projected_target(),
            outcome: projected.outcome.clone(),
        }
    }
}

fn canonical_link_target(path: &str, line: Option<u32>) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut target = String::with_capacity(path.len() + 16);
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~' | b'/') {
            target.push(char::from(byte));
        } else {
            target.push('%');
            target.push(char::from(HEX[usize::from(byte >> 4)]));
            target.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    if let Some(line) = line {
        target.push_str("#L");
        target.push_str(&line.to_string());
    }
    target
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

#[cfg(test)]
fn resolve_target(
    rooted_fs: &RootedFs,
    task_root: &PreparedTaskRoot,
    target: &str,
) -> Result<ResolvedTarget, ResolveFileLinkFailure> {
    resolve_target_with_recovery(rooted_fs, task_root, target, false)
}

fn resolve_target_with_recovery(
    rooted_fs: &RootedFs,
    task_root: &PreparedTaskRoot,
    target: &str,
    recovered: bool,
) -> Result<ResolvedTarget, ResolveFileLinkFailure> {
    let plan = parse_file_location(target, recovered).map_err(|failure| match failure {
        FileLocationFailure::InvalidTarget | FileLocationFailure::UnknownScheme => {
            ResolveFileLinkFailure::InvalidTarget
        }
    })?;
    match resolve_location(rooted_fs, task_root, &plan.exact) {
        Ok(resolved) => Ok(resolved),
        Err(ResolveFileLinkFailure::NotFound) => match plan.fallback {
            LocationFallback::None => Err(ResolveFileLinkFailure::NotFound),
            LocationFallback::Malformed => Err(ResolveFileLinkFailure::InvalidTarget),
            LocationFallback::Located(location) => {
                resolve_location(rooted_fs, task_root, &location)
            }
        },
        Err(failure) => Err(failure),
    }
}

fn resolve_location(
    rooted_fs: &RootedFs,
    task_root: &PreparedTaskRoot,
    location: &FileLocation,
) -> Result<ResolvedTarget, ResolveFileLinkFailure> {
    let path = resolve_candidate(rooted_fs, &task_root.absolute, &location.path)?;
    Ok(resolved_target(
        &task_root.logical,
        path,
        location
            .coordinates
            .map(|coordinates| coordinates.start_line),
    ))
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
    let metadata = std::fs::metadata(&canonical).map_err(resolve_io_failure)?;
    if metadata.is_dir() {
        return Err(ResolveFileLinkFailure::Directory);
    }
    if !metadata.is_file() {
        return Err(ResolveFileLinkFailure::NotFile);
    }
    std::fs::File::open(canonical).map_err(resolve_io_failure)?;
    Ok(logical)
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

fn resolve_fs_failure(error: fs::FsError) -> ResolveFileLinkFailure {
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

impl From<ResolvedTarget> for TaskFileLinkOutcome {
    fn from(resolved: ResolvedTarget) -> Self {
        Self::Resolved {
            path: resolved.path,
            task_relative_path: resolved.task_relative_path,
            line: resolved.line,
        }
    }
}

impl From<ResolveFileLinkFailure> for TaskFileLinkOutcome {
    fn from(failure: ResolveFileLinkFailure) -> Self {
        let reason = match failure {
            ResolveFileLinkFailure::InvalidTarget => {
                TaskFileLinkRejection::UnsupportedOrMalformedLocation
            }
            ResolveFileLinkFailure::NotFound => TaskFileLinkRejection::NotFound,
            ResolveFileLinkFailure::Directory
            | ResolveFileLinkFailure::NotFile
            | ResolveFileLinkFailure::Unreadable => TaskFileLinkRejection::NotRegularReadableFile,
            ResolveFileLinkFailure::OutsideRoot => TaskFileLinkRejection::OutsideRoot,
        };
        Self::Rejected { reason }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use serde_json::json;
    use tempfile::tempdir;
    use url::Url;

    use super::*;
    use crate::{
        agent::codex::CodexThreadClient,
        app::tasks::{
            events::task_event_record,
            test_support::{cache_and_manage_test_thread, task_state_with_codex_client},
        },
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

        let markdown = event.payload.as_ref().unwrap()["text"].as_str().unwrap();
        let targets = collect_event_link_targets(std::slice::from_ref(&event));
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].event_id, "thread:assistant");
        assert_eq!(targets[0].link_id, 0);
        assert_eq!(targets[0].target, "src/lib.rs:7");
        assert_eq!(
            &markdown[targets[0].source_range.clone()],
            "[relative](src/lib.rs:7)"
        );
    }

    #[tokio::test]
    async fn leaves_a_prompt_exactly_as_the_person_typed_it() {
        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        fs::write(task.join("owned.rs"), "source").unwrap();
        let resolver = TaskFileLinkResolver::new(Arc::new(RootedFs::new(root.path()).unwrap()));
        let events = vec![
            task_event_record(
                "thread",
                "text",
                "user_message",
                "User prompt",
                Some(json!({ "text": "[owned](owned.rs:2) and owned.rs:3" })),
                1,
            ),
            task_event_record(
                "thread",
                "prompt",
                "user_message",
                "User prompt",
                Some(json!({ "text": "", "prompt": "[owned](owned.rs:4)" })),
                2,
            ),
            task_event_record(
                "thread",
                "content",
                "user_message",
                "User prompt",
                Some(json!({
                    "content": [{ "type": "input_text", "text": "[owned](owned.rs:5)" }]
                })),
                3,
            ),
        ];

        let (projected, links) = resolver.project("task".to_string(), &events).await;

        assert_eq!(projected, events);
        assert_eq!(links, Vec::new());
    }

    #[tokio::test]
    async fn normalizes_raw_space_links_in_the_server_projected_event() {
        let root = tempdir().unwrap();
        let task = root.path().join("Application Support/project");
        let policy = task.join("docs/review/policy.md");
        fs::create_dir_all(policy.parent().unwrap()).unwrap();
        fs::write(&policy, "review policy").unwrap();
        let resolver = TaskFileLinkResolver::new(Arc::new(RootedFs::new(root.path()).unwrap()));
        let authored = format!("[docs/review/policy.md]({}:22)", policy.display());
        let event = task_event_record(
            "thread",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({ "text": authored })),
            1,
        );

        let (events, links) = resolver
            .project(
                "Application Support/project".to_string(),
                std::slice::from_ref(&event),
            )
            .await;

        assert_eq!(
            events[0].payload.as_ref().unwrap()["text"],
            "[docs/review/policy.md](docs/review/policy.md#L22)"
        );
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].target, "docs/review/policy.md#L22");
        assert_eq!(
            links[0].outcome,
            TaskFileLinkOutcome::Resolved {
                path: "Application Support/project/docs/review/policy.md".to_string(),
                task_relative_path: "docs/review/policy.md".to_string(),
                line: Some(22),
            }
        );
    }

    #[tokio::test]
    async fn task_and_live_projection_normalize_each_rendered_payload_shape() {
        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        fs::write(task.join("owned.rs"), "source").unwrap();
        let resolver = TaskFileLinkResolver::new(Arc::new(RootedFs::new(root.path()).unwrap()));
        let events = vec![task_event_record(
            "thread",
            "reasoning",
            "reasoning",
            "Thinking",
            Some(json!({
                "summary": [" [summary](owned.rs:2) "],
                "content": ["[content](owned.rs#L3)"]
            })),
            1,
        )];

        let (projected, links) = resolver.project("task".to_string(), &events).await;

        assert_eq!(links.len(), 2);
        assert_eq!(
            projected[0].payload.as_ref().unwrap()["summary"][0],
            " [summary](owned.rs#L2) "
        );
        assert_eq!(
            projected[0].payload.as_ref().unwrap()["content"][0],
            "[content](owned.rs#L3)"
        );

        let live = task_event_record(
            "thread",
            "live",
            "assistant_message",
            "Live",
            Some(json!({ "text": "[live](owned.rs:7)" })),
            5,
        );
        let (live, live_links) = resolver.project_event("task", &live).await;
        assert_eq!(
            live.payload.as_ref().unwrap()["text"],
            "[live](owned.rs#L7)"
        );
        assert_eq!(live_links[0].target, "owned.rs#L7");

        let untouched = task_event_record(
            "thread",
            "status",
            "thread_status_changed",
            "Status",
            None,
            6,
        );
        assert_eq!(
            resolver.project_event("task", &untouched).await,
            (untouched, Vec::new())
        );
    }

    #[tokio::test]
    async fn canonical_targets_distinguish_locations_from_location_like_filenames() {
        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        fs::write(task.join("space name (한글).rs"), "source").unwrap();
        fs::write(task.join("notes#L12"), "literal hash").unwrap();
        let resolver = TaskFileLinkResolver::new(Arc::new(RootedFs::new(root.path()).unwrap()));
        let event = task_event_record(
            "thread",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({
                "text": concat!(
                    "[column](space%20name%20%28%ED%95%9C%EA%B8%80%29.rs:12:5) ",
                    "[range](space%20name%20%28%ED%95%9C%EA%B8%80%29.rs#L12-L20) ",
                    "[literal](notes%23L12)"
                )
            })),
            1,
        );

        let (events, links) = resolver.project("task".to_string(), &[event]).await;

        let canonical = "space%20name%20%28%ED%95%9C%EA%B8%80%29.rs#L12";
        assert_eq!(links[0].target, canonical);
        assert_eq!(links[1].target, canonical);
        assert_eq!(links[2].target, "notes%23L12");
        assert_eq!(
            events[0].payload.as_ref().unwrap()["text"],
            format!("[column]({canonical}) [range]({canonical}) [literal](notes%23L12)")
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
        let (first_events, first) = resolver
            .project("task".to_string(), std::slice::from_ref(&event))
            .await;
        fs::remove_file(task.join("owned.rs")).unwrap();
        let (cached_events, cached) = resolver
            .project("task".to_string(), std::slice::from_ref(&event))
            .await;

        assert_eq!(first, cached);
        assert_eq!(first_events, cached_events);
        assert_eq!(
            first_events[0].payload.as_ref().unwrap()["text"],
            "[Owned](owned.rs#L7) Missing"
        );
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            json!([
                {
                    "eventId": "thread:assistant",
                    "linkId": 0,
                    "target": "owned.rs#L7",
                    "status": "resolved",
                    "path": "task/owned.rs",
                    "taskRelativePath": "owned.rs",
                    "line": 7
                },
                {
                    "eventId": "thread:assistant",
                    "linkId": 1,
                    "target": "missing.rs",
                    "status": "rejected",
                    "reason": "not_found"
                }
            ])
        );
    }

    #[test]
    fn reports_response_truncation_explicitly() {
        let markdown = (0..=MAX_FILE_LINKS_PER_RESPONSE)
            .map(|index| format!("[link {index}](file-{index}.rs)"))
            .collect::<Vec<_>>()
            .join(" ");
        let event = task_event_record(
            "thread",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({ "text": markdown })),
            1,
        );

        let targets = collect_event_link_targets(&[event]);

        assert_eq!(targets.len(), MAX_FILE_LINKS_PER_RESPONSE + 1);
        assert!(targets.last().is_some_and(|target| target.truncated));
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
        state.task_events.publish_local(task_event_record(
            "thread-owned-links",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({ "text": "[Owned](owned.rs:7)" })),
            1,
        ));

        let (detail, _) = state.detail.cached("thread-owned-links").await.unwrap();

        assert_eq!(detail.file_links.len(), 1);
        assert_eq!(
            detail.file_links[0].event_id,
            "thread-owned-links:assistant"
        );
        assert_eq!(detail.file_links[0].link_id, 0);
        assert_eq!(detail.file_links[0].target, "owned.rs#L7");
        assert_eq!(
            detail.events[0].payload.as_ref().unwrap()["text"],
            "[Owned](owned.rs#L7)"
        );
        assert_eq!(
            detail.file_links[0].outcome,
            TaskFileLinkOutcome::Resolved {
                path: "task/owned.rs".to_string(),
                task_relative_path: "owned.rs".to_string(),
                line: Some(7),
            }
        );
    }

    #[tokio::test]
    async fn projects_each_rejection_reason_instead_of_dropping_candidates() {
        let outer = tempdir().unwrap();
        let root = outer.path().join("browse");
        let task = root.join("task");
        fs::create_dir_all(task.join("directory")).unwrap();
        fs::write(outer.path().join("secret.txt"), "secret").unwrap();
        let resolver = TaskFileLinkResolver::new(Arc::new(RootedFs::new(&root).unwrap()));
        let event = task_event_record(
            "thread",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({
                "text": concat!(
                    "[Malformed](missing.rs:0) ",
                    "[Missing](missing.rs) ",
                    "[Directory](directory) ",
                    "[Outside](../../secret.txt) ",
                    "[Scheme](vscode://file/tmp/a.rs:12)"
                )
            })),
            1,
        );

        let (events, projected) = resolver.project("task".to_string(), &[event]).await;

        assert_eq!(
            events[0].payload.as_ref().unwrap()["text"],
            "Malformed Missing Directory Outside Scheme"
        );

        assert_eq!(
            projected
                .into_iter()
                .map(|link| match link.outcome {
                    TaskFileLinkOutcome::Rejected { reason } => reason,
                    TaskFileLinkOutcome::Resolved { .. } => panic!("unexpected resolution"),
                })
                .collect::<Vec<_>>(),
            vec![
                TaskFileLinkRejection::UnsupportedOrMalformedLocation,
                TaskFileLinkRejection::NotFound,
                TaskFileLinkRejection::NotRegularReadableFile,
                TaskFileLinkRejection::OutsideRoot,
                TaskFileLinkRejection::UnsupportedOrMalformedLocation,
            ]
        );
    }

    #[tokio::test]
    async fn unavailable_task_root_rejects_each_discovered_occurrence() {
        let root = tempdir().unwrap();
        let resolver = TaskFileLinkResolver::new(Arc::new(RootedFs::new(root.path()).unwrap()));
        let event = task_event_record(
            "thread",
            "assistant",
            "assistant_message",
            "Assistant response",
            Some(json!({ "text": "[One](one.rs) [Two](two.rs)" })),
            1,
        );

        let (events, projected) = resolver.project("missing-task".to_string(), &[event]).await;

        assert_eq!(projected.len(), 2);
        assert_eq!(events[0].payload.as_ref().unwrap()["text"], "One Two");
        assert!(projected.iter().all(|link| {
            link.outcome
                == TaskFileLinkOutcome::Rejected {
                    reason: TaskFileLinkRejection::NotFound,
                }
        }));
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
    fn prefers_exact_location_like_filenames_before_parsing_coordinates() {
        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        fs::write(task.join("report"), "plain").unwrap();
        fs::write(task.join("report:17"), "colon").unwrap();
        fs::write(task.join("notes"), "plain").unwrap();
        fs::write(task.join("notes#L12"), "hash").unwrap();
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
        assert_eq!(
            resolve_target(&rooted_fs, &prepared, "notes#L12"),
            Ok(resolved_target("task", "task/notes#L12".to_string(), None,))
        );

        fs::remove_file(task.join("report:17")).unwrap();
        assert_eq!(
            resolve_target(&rooted_fs, &prepared, "report:17"),
            Ok(resolved_target("task", "task/report".to_string(), Some(17),))
        );
        fs::remove_file(task.join("notes#L12")).unwrap();
        assert_eq!(
            resolve_target(&rooted_fs, &prepared, "notes#L12"),
            Ok(resolved_target("task", "task/notes".to_string(), Some(12),))
        );
    }

    #[test]
    fn resolves_supported_coordinates_to_the_starting_line() {
        let root = tempdir().unwrap();
        let task = root.path().join("task");
        fs::create_dir(&task).unwrap();
        let file = task.join("located.rs");
        fs::write(&file, "fn located() {}").unwrap();
        let rooted_fs = RootedFs::new(root.path()).unwrap();
        let prepared = prepared(&rooted_fs, "task");
        let mut file_url = Url::from_file_path(&file).unwrap();
        file_url.set_fragment(Some("L12-L20"));
        let cases = [
            "located.rs:12".to_string(),
            "located.rs:12:5".to_string(),
            "located.rs:12-20".to_string(),
            "located.rs#L12".to_string(),
            "located.rs#L12-L20".to_string(),
            file_url.to_string(),
        ];

        for target in cases {
            assert_eq!(
                resolve_target(&rooted_fs, &prepared, &target),
                Ok(resolved_target(
                    "task",
                    "task/located.rs".to_string(),
                    Some(12),
                )),
                "{target}",
            );
        }
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
            ("missing.rs:0", ResolveFileLinkFailure::InvalidTarget),
            (
                "missing.rs:4294967296",
                ResolveFileLinkFailure::InvalidTarget,
            ),
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
