use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::{Path, PathBuf};

use super::events::{
    TaskEventRecord, non_empty_string, seconds_to_ms, seconds_to_ms_value, thread_cwd, thread_id,
};
use crate::{
    app::error::ApiError,
    codex_app_server::{ThreadStatus, TurnStatus},
    fs::RootedFs,
    git,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskRecord {
    pub(in crate::app) id: String,
    pub(in crate::app) thread_id: String,
    pub(in crate::app) conversation_available: bool,
    pub(in crate::app) title: String,
    pub(in crate::app) preview: String,
    pub(in crate::app) thread_status: ThreadStatus,
    pub(in crate::app) latest_turn_status: Option<TurnStatus>,
    pub(in crate::app) active_turn: Option<TaskActiveTurn>,
    pub(in crate::app) cwd: String,
    pub(in crate::app) cwd_path: Option<String>,
    pub(in crate::app) relative_cwd: String,
    pub(in crate::app) worktree: Option<TaskWorktreeContext>,
    pub(in crate::app) created_ms: u64,
    pub(in crate::app) updated_ms: u64,
    pub(in crate::app) recency_ms: Option<u64>,
    pub(in crate::app) last_completed_ms: Option<u64>,
    pub(in crate::app) last_event_summary: Option<String>,
    pub(in crate::app) unseen: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskActiveTurn {
    pub(in crate::app) id: String,
    pub(in crate::app) started_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskWorktreeContext {
    pub(in crate::app) root_path: String,
    pub(in crate::app) repository_root_path: String,
    pub(in crate::app) branch: Option<String>,
    pub(in crate::app) head_sha: String,
    pub(in crate::app) relative_cwd: String,
    pub(in crate::app) linked: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::app) struct ResolvedTaskCwd {
    pub(in crate::app) canonical_cwd: PathBuf,
    pub(in crate::app) logical_cwd: Option<String>,
    pub(in crate::app) worktree: Option<TaskWorktreeContext>,
    pub(in crate::app) worktree_root: Option<PathBuf>,
    pub(in crate::app) repository_common_dir: Option<PathBuf>,
}

pub(in crate::app) fn thread_with_turns(
    thread: &JsonValue,
    turns: Vec<JsonValue>,
) -> Result<JsonValue, ApiError> {
    let mut thread = thread.clone();
    let Some(object) = thread.as_object_mut() else {
        return Err(ApiError::CodexThread(
            "thread/read response did not include a thread object".to_string(),
        ));
    };
    object.insert("turns".to_string(), JsonValue::Array(turns));
    Ok(thread)
}

pub(in crate::app) fn task_record_from_thread(
    thread: &JsonValue,
    events: &[TaskEventRecord],
    resolved_cwd: Option<&ResolvedTaskCwd>,
) -> Result<TaskRecord, ApiError> {
    let thread_id = thread_id(thread).ok_or_else(|| ApiError::BadRequest {
        code: "thread_id_missing",
        message: "Codex thread did not include an id".to_string(),
    })?;
    let cwd = thread_cwd(thread).unwrap_or("").to_string();
    let title = non_empty_string(thread.get("name").and_then(JsonValue::as_str))
        .or_else(|| non_empty_string(thread.get("preview").and_then(JsonValue::as_str)))
        .unwrap_or_else(|| format!("Thread {}", short_thread_id(thread_id)));
    let preview = thread
        .get("preview")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let thread_status = decode_thread_status(thread.get("status"))?;
    let last_event_summary = events
        .last()
        .map(|event| event.summary.clone())
        .or_else(|| non_empty_string(Some(&preview)));
    Ok(TaskRecord {
        id: thread_id.to_string(),
        thread_id: thread_id.to_string(),
        conversation_available: true,
        title,
        preview,
        thread_status,
        latest_turn_status: None,
        active_turn: None,
        cwd_path: resolved_cwd.and_then(|resolved| resolved.logical_cwd.clone()),
        relative_cwd: resolved_cwd
            .and_then(|resolved| resolved.logical_cwd.clone())
            .unwrap_or_else(|| cwd.clone()),
        worktree: resolved_cwd.and_then(|resolved| resolved.worktree.clone()),
        cwd,
        created_ms: seconds_to_ms(thread.get("createdAt").and_then(JsonValue::as_f64)),
        updated_ms: seconds_to_ms(thread.get("updatedAt").and_then(JsonValue::as_f64)),
        recency_ms: thread
            .get("recencyAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value),
        last_completed_ms: None,
        last_event_summary,
        unseen: false,
    })
}

pub(in crate::app) fn apply_canonical_turn_projection(
    task: &mut TaskRecord,
    thread: &JsonValue,
) -> Result<(), ApiError> {
    let turns = thread
        .get("turns")
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    task.latest_turn_status = turns
        .last()
        .map(|turn| decode_turn_status(turn.get("status")))
        .transpose()?;
    task.last_completed_ms = turns
        .iter()
        .filter_map(|turn| turn.get("completedAt").and_then(JsonValue::as_f64))
        .map(seconds_to_ms_value)
        .filter(|value| *value > 0)
        .max();
    task.active_turn = if matches!(task.thread_status, ThreadStatus::Active { .. }) {
        turns
            .last()
            .filter(|turn| {
                turn.get("status").and_then(JsonValue::as_str) == Some("inProgress")
                    && turn.get("id").and_then(JsonValue::as_str).is_some()
            })
            .map(|turn| TaskActiveTurn {
                id: turn
                    .get("id")
                    .and_then(JsonValue::as_str)
                    .expect("active turn was checked above")
                    .to_string(),
                started_at_ms: turn
                    .get("startedAt")
                    .and_then(JsonValue::as_f64)
                    .map(seconds_to_ms_value)
                    .filter(|value| *value > 0),
            })
    } else {
        None
    };
    Ok(())
}

pub(in crate::app) fn task_activity_ms(task: &TaskRecord) -> u64 {
    task.recency_ms
        .unwrap_or_else(|| task.updated_ms.max(task.created_ms))
}

pub(in crate::app) fn resolve_thread_cwd(
    fs: &RootedFs,
    thread: &JsonValue,
) -> Option<ResolvedTaskCwd> {
    thread_cwd(thread).and_then(|cwd| resolve_task_cwd(fs, cwd))
}

pub(in crate::app) fn resolve_task_cwd(fs: &RootedFs, cwd: &str) -> Option<ResolvedTaskCwd> {
    let canonical_cwd = Path::new(cwd).canonicalize().ok()?;
    if !canonical_cwd.is_dir() {
        return None;
    }
    let logical_cwd = fs.logical_path_for_absolute(&canonical_cwd).ok();
    if !has_git_ancestor(&canonical_cwd) {
        return Some(ResolvedTaskCwd {
            canonical_cwd,
            logical_cwd,
            worktree: None,
            worktree_root: None,
            repository_common_dir: None,
        });
    }
    let Some(repository) = git::repository_for(&canonical_cwd) else {
        return Some(ResolvedTaskCwd {
            canonical_cwd,
            logical_cwd,
            worktree: None,
            worktree_root: None,
            repository_common_dir: None,
        });
    };
    let root_path = fs.logical_path_for_absolute(&repository.root).ok()?;
    let metadata = git::repository_metadata_paths(&repository);
    let repository_root_path = metadata
        .as_ref()
        .and_then(|paths| {
            if paths
                .common_dir
                .file_name()
                .is_some_and(|name| name == ".git")
            {
                paths.common_dir.parent()
            } else {
                None
            }
        })
        .and_then(|root| fs.logical_path_for_absolute(root).ok())
        .unwrap_or_else(|| root_path.clone());
    let linked = metadata
        .as_ref()
        .is_some_and(|paths| paths.git_dir != paths.common_dir);
    let head_sha = git::head_sha(&repository).unwrap_or_default();
    let branch = repository
        .branch
        .filter(|branch| !branch.starts_with("HEAD "));
    let relative_cwd = canonical_cwd
        .strip_prefix(&repository.root)
        .ok()
        .map(relative_path_string)
        .unwrap_or_default();

    Some(ResolvedTaskCwd {
        canonical_cwd,
        logical_cwd,
        worktree: Some(TaskWorktreeContext {
            root_path,
            repository_root_path,
            branch,
            head_sha,
            relative_cwd,
            linked,
        }),
        worktree_root: Some(repository.root),
        repository_common_dir: metadata.map(|paths| paths.common_dir),
    })
}

pub(in crate::app) fn has_git_ancestor(path: &Path) -> bool {
    path.ancestors().any(git::has_git_marker)
}

pub(in crate::app) fn decode_thread_status(
    status: Option<&JsonValue>,
) -> Result<ThreadStatus, ApiError> {
    serde_json::from_value(status.cloned().ok_or_else(|| {
        ApiError::CodexThread("Codex thread did not include a status".to_string())
    })?)
    .map_err(|error| ApiError::CodexThread(format!("invalid Codex thread status: {error}")))
}

pub(in crate::app) fn decode_turn_status(
    status: Option<&JsonValue>,
) -> Result<TurnStatus, ApiError> {
    serde_json::from_value(
        status.cloned().ok_or_else(|| {
            ApiError::CodexThread("Codex turn did not include a status".to_string())
        })?,
    )
    .map_err(|error| ApiError::CodexThread(format!("invalid Codex turn status: {error}")))
}

pub(in crate::app) fn short_thread_id(thread_id: &str) -> &str {
    thread_id.get(..8).unwrap_or(thread_id)
}

pub(in crate::app) fn relative_path_string(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            std::path::Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}
