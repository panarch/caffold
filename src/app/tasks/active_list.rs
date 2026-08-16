use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

use serde::Serialize;

use crate::{
    app::error::ApiError,
    codex_app_server::{CodexThread, CodexThreadClient, ThreadStatus},
    codex_thread_sessions::CodexThreadSessions,
    fs::RootedFs,
    task_store::{ManagedSection, ManagedThread, TaskStore},
};

use super::{
    TaskRecord,
    detail::project_managed_worktree_cwd,
    projection::{
        apply_canonical_turn_projection, resolve_thread_cwd, task_activity_ms,
        task_record_from_thread,
    },
    recovery::{ActiveTaskRecovery, ActiveTaskRecoveryReason},
};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskSection {
    pub(in crate::app) id: String,
    pub(in crate::app) name: String,
    pub(in crate::app) repository: bool,
    pub(in crate::app) tasks: Vec<TaskRecord>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskProjection {
    pub(in crate::app) sections: Vec<ActiveTaskSection>,
    pub(in crate::app) unsectioned: Vec<ActiveTaskRecovery>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskRuntimeSnapshot {
    pub(in crate::app) tasks: Vec<TaskRecord>,
}

pub(in crate::app) struct ActiveTaskRuntimeProjection {
    pub(in crate::app) snapshot: ActiveTaskRuntimeSnapshot,
    pub(in crate::app) observed_threads: Vec<CodexThread>,
}

impl ActiveTaskProjection {
    fn empty() -> Self {
        Self {
            sections: Vec::new(),
            unsectioned: Vec::new(),
        }
    }
}

pub(in crate::app) async fn load_cached(
    fs: Arc<RootedFs>,
    store: TaskStore,
) -> Result<ActiveTaskProjection, ApiError> {
    let (stored_sections, active_threads) = tokio::task::spawn_blocking(move || {
        store.read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
    })
    .await
    .map_err(|error| ApiError::Internal(format!("task store worker failed: {error}")))?
    .map_err(|error| ApiError::Internal(error.to_string()))?;
    if active_threads.is_empty() {
        return Ok(ActiveTaskProjection::empty());
    }

    let sections = stored_sections
        .iter()
        .cloned()
        .map(|section| (section.section_id.clone(), section))
        .collect::<BTreeMap<_, _>>();
    let repository_sections = repository_sections(fs, &sections).await;
    let mut grouped = BTreeMap::<String, Vec<ManagedThread>>::new();
    let mut recovery = Vec::new();
    for managed in active_threads {
        match managed.section_id.as_deref() {
            Some(section_id) if sections.contains_key(section_id) => {
                grouped
                    .entry(section_id.to_string())
                    .or_default()
                    .push(managed);
            }
            _ => recovery.push(ActiveTaskRecovery::new(
                unavailable_active_task(&managed),
                ActiveTaskRecoveryReason::SectionPlacementPending,
            )),
        }
    }

    let projected_sections = stored_sections
        .into_iter()
        .filter_map(|section| {
            let mut threads = grouped.remove(&section.section_id)?;
            threads.sort_by(|left, right| {
                left.position_in_section
                    .cmp(&right.position_in_section)
                    .then_with(|| left.thread_id.cmp(&right.thread_id))
            });
            Some(ActiveTaskSection {
                id: section.section_id.clone(),
                name: section.logical_path,
                repository: repository_sections.contains(&section.section_id),
                tasks: threads.iter().map(unavailable_active_task).collect(),
            })
        })
        .collect::<Vec<_>>();
    recovery.sort_by(|left, right| {
        task_activity_ms(&right.task)
            .cmp(&task_activity_ms(&left.task))
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    Ok(ActiveTaskProjection {
        sections: projected_sections,
        unsectioned: recovery,
    })
}

pub(in crate::app) async fn load_runtime_snapshot(
    fs: Arc<RootedFs>,
    store: TaskStore,
    sessions: &CodexThreadSessions,
    generation: u64,
    client: &CodexThreadClient,
) -> Result<ActiveTaskRuntimeProjection, ApiError> {
    let managed = {
        let store = store.clone();
        tokio::task::spawn_blocking(move || store.read(|tables| tables.active_managed_threads()))
            .await
            .map_err(|error| ApiError::Internal(format!("task store worker failed: {error}")))?
            .map_err(|error| ApiError::Internal(error.to_string()))?
            .into_iter()
            .map(|thread| (thread.thread_id.clone(), thread))
            .collect::<BTreeMap<_, _>>()
    };
    if managed.is_empty() {
        return Ok(ActiveTaskRuntimeProjection {
            snapshot: ActiveTaskRuntimeSnapshot { tasks: Vec::new() },
            observed_threads: Vec::new(),
        });
    }
    for thread_id in managed.keys() {
        sessions.track_listed_thread(generation, thread_id).await;
    }

    let mut tasks = Vec::new();
    let mut observed_threads = Vec::new();
    for thread in super::recovery::list_all_global_threads(client).await? {
        let Some(managed) = managed.get(&thread.id) else {
            continue;
        };
        let projected = project_managed_worktree_cwd(&store, thread.clone().into_value())?;
        let resolved = resolve_thread_cwd(&fs, &projected);
        let mut task = task_record_from_thread(&projected, &[], resolved.as_ref())?;
        apply_canonical_turn_projection(&mut task, &projected)?;
        apply_managed_runtime_metadata(&mut task, managed);
        observed_threads.push(thread);
        tasks.push(task);
    }
    tasks.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    observed_threads.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(ActiveTaskRuntimeProjection {
        snapshot: ActiveTaskRuntimeSnapshot { tasks },
        observed_threads,
    })
}

fn apply_managed_runtime_metadata(task: &mut TaskRecord, managed: &ManagedThread) {
    task.title = managed.display_name.clone();
    task.last_completed_ms = managed.last_completed_at_ms;
    task.unseen = managed.unseen();
}

async fn repository_sections(
    fs: Arc<RootedFs>,
    sections: &BTreeMap<String, ManagedSection>,
) -> HashSet<String> {
    let sections = sections
        .values()
        .map(|section| (section.section_id.clone(), section.logical_path.clone()))
        .collect::<Vec<_>>();
    tokio::task::spawn_blocking(move || {
        sections
            .into_iter()
            .filter_map(|(section_id, logical_path)| {
                fs.absolute_directory_path(&logical_path)
                    .ok()
                    .and_then(|path| crate::git::repository_for(&path))
                    .map(|_| section_id)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

pub(super) fn unavailable_active_task(managed: &ManagedThread) -> TaskRecord {
    let activity_ms = managed
        .last_observed_recency_ms
        .unwrap_or(managed.claimed_at_ms);
    TaskRecord {
        id: managed.thread_id.clone(),
        thread_id: managed.thread_id.clone(),
        conversation_available: false,
        title: managed.display_name.clone(),
        preview: "Conversation unavailable".to_string(),
        thread_status: ThreadStatus::NotLoaded,
        latest_turn_status: None,
        active_turn: None,
        cwd: String::new(),
        cwd_path: None,
        relative_cwd: String::new(),
        worktree: None,
        created_ms: activity_ms,
        updated_ms: activity_ms,
        recency_ms: Some(activity_ms),
        last_completed_ms: managed.last_completed_at_ms,
        last_event_summary: None,
        unseen: managed.unseen(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Arc<RootedFs>, TaskStore) {
        let root = tempfile::tempdir().unwrap();
        let store = TaskStore::memory().unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        (root, fs, store)
    }

    fn claim_at_top(
        store: &TaskStore,
        thread_id: &str,
        display_name: &str,
        recency_ms: u64,
        section_id: &str,
        logical_path: &str,
        section_position: i64,
    ) {
        store
            .transaction(|tables| {
                let section = ManagedSection {
                    section_id: section_id.to_string(),
                    logical_path: logical_path.to_string(),
                    position: section_position,
                };
                tables.upsert_managed_section(&section)?;
                tables.claim_managed_thread_at_top(
                    ManagedThread::new(thread_id, Some(recency_ms), None, None),
                    display_name,
                    &section.section_id,
                    recency_ms,
                )
            })
            .unwrap();
    }

    fn cached_rows(store: &TaskStore) -> (Vec<ManagedSection>, Vec<ManagedThread>) {
        store
            .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
            .unwrap()
    }

    #[tokio::test]
    async fn cached_projection_uses_persisted_section_and_task_positions() {
        let (_root, fs, store) = fixture();
        claim_at_top(
            &store,
            "older-1",
            "Older one",
            100,
            "section-b",
            "Workspace/b",
            0,
        );
        claim_at_top(
            &store,
            "older-0",
            "Older zero",
            200,
            "section-b",
            "Workspace/b",
            0,
        );
        claim_at_top(
            &store,
            "newer",
            "Newer",
            300,
            "section-a",
            "Workspace/a",
            1024,
        );

        let before = cached_rows(&store);
        let projection = load_cached(fs, store.clone()).await.unwrap();
        let after = cached_rows(&store);

        assert_eq!(before, after);
        assert_eq!(
            projection
                .sections
                .iter()
                .map(|section| section.id.as_str())
                .collect::<Vec<_>>(),
            ["section-b", "section-a"]
        );
        assert_eq!(
            projection.sections[0]
                .tasks
                .iter()
                .map(|task| task.title.as_str())
                .collect::<Vec<_>>(),
            ["Older zero", "Older one"]
        );
        assert!(
            projection
                .sections
                .iter()
                .flat_map(|section| &section.tasks)
                .all(|task| !task.conversation_available)
        );
    }

    #[tokio::test]
    async fn cached_projection_keeps_unplaced_rows_visible_for_explicit_recovery() {
        let (_root, fs, store) = fixture();
        store
            .claim(ManagedThread::new("unplaced", Some(500), None, None), 500)
            .unwrap();

        let projection = load_cached(fs, store).await.unwrap();

        assert!(projection.sections.is_empty());
        assert_eq!(projection.unsectioned.len(), 1);
        assert_eq!(projection.unsectioned[0].title, "Thread unplaced");
        assert_eq!(
            projection.unsectioned[0].recovery.actions,
            [
                super::super::recovery::ActiveTaskRecoveryAction::RestoreToActive,
                super::super::recovery::ActiveTaskRecoveryAction::Recheck,
            ]
        );
    }

    #[tokio::test]
    async fn repository_presentation_is_derived_without_persisting_it() {
        let (root, fs, store) = fixture();
        let repository = root.path().join("repository");
        std::fs::create_dir(&repository).unwrap();
        let output = std::process::Command::new("git")
            .arg("init")
            .arg(&repository)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        claim_at_top(
            &store,
            "repository-task",
            "Repository task",
            100,
            "section-repository",
            "repository",
            0,
        );
        let before = cached_rows(&store);

        let projection = load_cached(fs, store.clone()).await.unwrap();

        assert!(projection.sections[0].repository);
        assert_eq!(cached_rows(&store), before);
    }
}
