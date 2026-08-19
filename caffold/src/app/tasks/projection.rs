use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::path::{Path, PathBuf};

use super::events::{
    TaskEventRecord, non_empty_string, seconds_to_ms, seconds_to_ms_value, thread_cwd, thread_id,
};
use crate::{
    agent::codex::{ThreadStatus, TurnStatus},
    app::error::ApiError,
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value as JsonValue, json};

    use super::*;
    use crate::{
        agent::codex::{ThreadStatus, TurnStatus},
        app::tasks::events::*,
        fs::RootedFs,
    };

    fn git_is_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn run_test_git(path: &Path, args: &[&str]) {
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

    fn commit_test_git_repo(path: &Path, message: &str) {
        run_test_git(
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

    #[test]
    fn only_the_latest_turn_can_be_active() {
        let completed_thread = json!({
            "id": "thread-completed",
            "status": { "type": "active", "activeFlags": [] },
            "cwd": "/tmp",
            "turns": [
                { "id": "stale", "status": "completed", "completedAt": 3.0 },
                { "id": "latest", "status": "completed", "completedAt": 4.0 }
            ]
        });
        let running_thread = json!({
            "id": "thread-running",
            "status": { "type": "active", "activeFlags": [] },
            "cwd": "/tmp",
            "turns": [
                { "id": "completed", "status": "completed", "completedAt": 3.0 },
                { "id": "latest", "status": "inProgress" }
            ]
        });

        let mut completed = task_record_from_thread(&completed_thread, &[], None).unwrap();
        apply_canonical_turn_projection(&mut completed, &completed_thread).unwrap();
        assert_eq!(completed.latest_turn_status, Some(TurnStatus::Completed));
        assert_eq!(completed.active_turn, None);
        assert_eq!(completed.last_completed_ms, Some(4_000));

        let mut running = task_record_from_thread(&running_thread, &[], None).unwrap();
        apply_canonical_turn_projection(&mut running, &running_thread).unwrap();
        assert_eq!(running.latest_turn_status, Some(TurnStatus::InProgress));
        assert_eq!(running.active_turn.unwrap().id, "latest");
        assert_eq!(running.last_completed_ms, Some(3_000));
    }

    #[test]
    fn task_record_uses_canonical_active_turn_state() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_active",
            "preview": "Running in app-server",
            "cwd": temp.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "active" },
            "turns": [{
                "id": "turn_active",
                "status": "inProgress",
                "startedAt": 1_750_000_000.0,
                "items": []
            }]
        });
        let mut task = task_record_from_thread(&thread, &[], None).unwrap();
        assert_eq!(task.latest_turn_status, None);
        assert_eq!(task.active_turn, None);
        apply_canonical_turn_projection(&mut task, &thread).unwrap();

        assert!(matches!(task.thread_status, ThreadStatus::Active { .. }));
        assert_eq!(task.latest_turn_status, Some(TurnStatus::InProgress));
        assert_eq!(
            task.active_turn,
            Some(TaskActiveTurn {
                id: "turn_active".to_string(),
                started_at_ms: Some(1_750_000_000_000)
            })
        );
    }

    #[test]
    fn browser_task_status_serializes_the_canonical_wire_shape() {
        let thread = json!({
            "id": "thread_wire",
            "preview": "Canonical wire status",
            "cwd": "/tmp",
            "status": {
                "type": "active",
                "activeFlags": ["waitingOnUserInput", "waitingOnApproval"]
            },
            "turns": [{
                "id": "turn_wire",
                "status": "inProgress",
                "startedAt": null
            }]
        });
        let mut task = task_record_from_thread(&thread, &[], None).unwrap();
        let list_value = serde_json::to_value(&task).unwrap();
        assert_eq!(
            list_value["threadStatus"],
            json!({
                "type": "active",
                "activeFlags": ["waitingOnUserInput", "waitingOnApproval"]
            })
        );
        assert_eq!(list_value["latestTurnStatus"], JsonValue::Null);
        assert_eq!(list_value["activeTurn"], JsonValue::Null);
        assert!(list_value.get("status").is_none());
        assert!(list_value.get("activeTurnId").is_none());

        apply_canonical_turn_projection(&mut task, &thread).unwrap();
        let detail_value = serde_json::to_value(&task).unwrap();
        assert_eq!(detail_value["latestTurnStatus"], "inProgress");
        assert_eq!(
            detail_value["activeTurn"],
            json!({ "id": "turn_wire", "startedAtMs": null })
        );
    }

    #[test]
    fn task_record_does_not_revive_stale_active_turn_for_idle_thread() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_idle_with_stale_turn",
            "preview": "Canonical thread is already idle",
            "cwd": temp.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "idle" },
            "turns": [{
                "id": "turn_stale",
                "status": "inProgress",
                "startedAt": 1_750_000_000.0,
                "items": []
            }]
        });

        let mut task = task_record_from_thread(&thread, &[], None).unwrap();
        apply_canonical_turn_projection(&mut task, &thread).unwrap();

        assert_eq!(task.thread_status, ThreadStatus::Idle);
        assert_eq!(task.latest_turn_status, Some(TurnStatus::InProgress));
        assert_eq!(task.active_turn, None);
    }

    #[test]
    fn active_thread_without_a_confirmed_turn_keeps_raw_status_without_controls() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_external",
            "preview": "Running in another Codex process",
            "cwd": temp.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "active", "activeFlags": [] },
            "turns": []
        });
        let mut task = task_record_from_thread(&thread, &[], None).unwrap();
        apply_canonical_turn_projection(&mut task, &thread).unwrap();

        assert!(matches!(task.thread_status, ThreadStatus::Active { .. }));
        assert_eq!(task.latest_turn_status, None);
        assert_eq!(task.active_turn, None);
    }

    #[test]
    fn task_repository_context_includes_linked_worktrees() {
        if !git_is_available() {
            return;
        }

        let temp = tempfile::tempdir().unwrap();
        let main_root = temp.path().join("main");
        let linked_root = temp.path().join("linked");
        std::fs::create_dir(&main_root).unwrap();
        run_test_git(&main_root, &["init", "-b", "main"]);
        std::fs::create_dir(main_root.join("src")).unwrap();
        std::fs::write(main_root.join("src/lib.rs"), "pub fn value() -> u8 { 1 }\n").unwrap();
        run_test_git(&main_root, &["add", "."]);
        commit_test_git_repo(&main_root, "Initial commit");
        run_test_git(
            &main_root,
            &[
                "worktree",
                "add",
                "-b",
                "feature/review",
                linked_root.to_str().unwrap(),
            ],
        );
        std::fs::create_dir(linked_root.join("nested")).unwrap();

        let fs = RootedFs::new(temp.path()).unwrap();
        let main = resolve_task_cwd(&fs, main_root.to_str().unwrap()).unwrap();
        let main_src = resolve_task_cwd(&fs, main_root.join("src").to_str().unwrap()).unwrap();
        let linked = resolve_task_cwd(&fs, linked_root.join("nested").to_str().unwrap()).unwrap();

        assert_eq!(main.worktree_root, main_src.worktree_root);
        assert_ne!(main.worktree_root, linked.worktree_root);
        assert_eq!(main.repository_common_dir, main_src.repository_common_dir);
        assert_eq!(main.repository_common_dir, linked.repository_common_dir);
        let main_context = main_src.worktree.as_ref().unwrap();
        assert_eq!(main_context.root_path, "main");
        assert_eq!(main_context.repository_root_path, "main");
        assert_eq!(main_context.branch.as_deref(), Some("main"));
        assert_eq!(main_context.relative_cwd, "src");
        assert!(!main_context.linked);
        assert!(!main_context.head_sha.is_empty());
        let linked_context = linked.worktree.as_ref().unwrap();
        assert_eq!(linked_context.root_path, "linked");
        assert_eq!(linked_context.repository_root_path, "main");
        assert_eq!(linked_context.branch.as_deref(), Some("feature/review"));
        assert_eq!(linked_context.relative_cwd, "nested");
        assert!(linked_context.linked);

        run_test_git(&linked_root, &["checkout", "--detach", "HEAD"]);
        let detached = resolve_task_cwd(&fs, linked_root.to_str().unwrap()).unwrap();
        let detached_context = detached.worktree.unwrap();
        assert_eq!(detached_context.branch, None);
        assert!(!detached_context.head_sha.is_empty());
    }

    #[test]
    fn task_worktree_context_is_optional_outside_git_or_rooted_fs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let plain = root.join("plain");
        let outside = temp.path().join("outside");
        std::fs::create_dir_all(&plain).unwrap();
        std::fs::create_dir(&outside).unwrap();
        let fs = RootedFs::new(&root).unwrap();

        assert!(!has_git_ancestor(&plain));
        let resolved_plain = resolve_task_cwd(&fs, plain.to_str().unwrap()).unwrap();
        assert_eq!(resolved_plain.logical_cwd.as_deref(), Some("plain"));
        assert_eq!(resolved_plain.worktree, None);
        assert!(resolve_task_cwd(&fs, outside.to_str().unwrap()).is_some());

        if git_is_available() {
            run_test_git(&outside, &["init", "-b", "main"]);
            assert!(resolve_task_cwd(&fs, outside.to_str().unwrap()).is_none());
        }
    }

    #[test]
    fn current_pending_approval_does_not_change_canonical_thread_status() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "preview": "Needs approval",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "status": { "type": "active" }
        });
        let events = vec![task_event_record(
            "thread_1",
            "approval_requested:1",
            "approval_requested",
            "Command approval requested",
            Some(json!({ "approvalId": "1" })),
            1,
        )];

        let task = task_record_from_thread(&thread, &events, None).unwrap();
        assert!(matches!(task.thread_status, ThreadStatus::Active { .. }));
    }

    #[test]
    fn resolved_approval_event_does_not_leave_idle_task_waiting() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "preview": "Approval was accepted",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 4.0,
            "status": { "type": "idle" }
        });
        let events = vec![
            task_event_record(
                "thread_1",
                "approval_requested:1",
                "approval_requested",
                "Command approval requested",
                Some(json!({ "approvalId": "1" })),
                1,
            ),
            task_event_record(
                "thread_1",
                "approval_resolved:1",
                "approval_resolved",
                "Approval resolved: accept",
                Some(json!({ "approvalId": "1", "decision": "accept" })),
                2,
            ),
            task_event_record(
                "thread_1",
                "turn_1:completed",
                "turn_completed",
                "Turn completed",
                Some(json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "status": "completed"
                })),
                3,
            ),
            task_event_record(
                "thread_1",
                "thread_status_changed",
                "thread_status_changed",
                "Thread idle",
                Some(json!({ "threadId": "thread_1", "status": "idle" })),
                4,
            ),
        ];

        let task = task_record_from_thread(&thread, &events, None).unwrap();
        assert_eq!(task.thread_status, ThreadStatus::Idle);
    }

    #[test]
    fn completed_turn_does_not_leave_abandoned_approval_waiting() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "preview": "A later prompt completed",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 3.0,
            "status": { "type": "idle" }
        });
        let events = vec![
            task_event_record(
                "thread_1",
                "approval_requested:1",
                "approval_requested",
                "Command approval requested",
                Some(json!({
                    "approvalId": "1",
                    "params": { "turnId": "turn_1" }
                })),
                1,
            ),
            task_event_record(
                "thread_1",
                "turn_1:completed",
                "turn_completed",
                "Turn completed",
                Some(json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "status": "completed"
                })),
                2,
            ),
            task_event_record(
                "thread_1",
                "thread_status_changed",
                "thread_status_changed",
                "Thread idle",
                Some(json!({ "threadId": "thread_1", "status": "idle" })),
                3,
            ),
        ];

        let task = task_record_from_thread(&thread, &events, None).unwrap();
        assert_eq!(task.thread_status, ThreadStatus::Idle);
    }

    #[test]
    fn rollout_invalidation_does_not_mark_an_idle_snapshot_as_running() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_external",
            "preview": "Running in another Codex process",
            "cwd": temp.path().display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "idle" },
            "turns": []
        });

        let mut task = task_record_from_thread(&thread, &[], None).unwrap();
        apply_canonical_turn_projection(&mut task, &thread).unwrap();

        assert_eq!(task.thread_status, ThreadStatus::Idle);
        assert_eq!(task.active_turn, None);
    }
}
