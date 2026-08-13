use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

use serde::Serialize;

use crate::{
    app::error::ApiError,
    codex_app_server::ThreadStatus,
    fs::RootedFs,
    task_store::{ManagedSection, ManagedThread, TaskStore},
};

use super::{
    TaskRecord,
    projection::task_activity_ms,
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
        .into_iter()
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

    let mut projected_sections = grouped
        .into_iter()
        .map(|(section_id, mut threads)| {
            threads.sort_by(|left, right| {
                left.position_in_section
                    .cmp(&right.position_in_section)
                    .then_with(|| left.thread_id.cmp(&right.thread_id))
            });
            let updated_ms = threads
                .iter()
                .map(|thread| {
                    thread
                        .last_observed_recency_ms
                        .unwrap_or(thread.claimed_at_ms)
                })
                .max()
                .unwrap_or_default();
            let section = &sections[&section_id];
            (
                ActiveTaskSection {
                    id: section_id,
                    name: section.logical_path.clone(),
                    repository: repository_sections.contains(&section.section_id),
                    tasks: threads.iter().map(unavailable_active_task).collect(),
                },
                updated_ms,
            )
        })
        .collect::<Vec<_>>();
    projected_sections.sort_by(|(left, left_updated), (right, right_updated)| {
        right_updated
            .cmp(left_updated)
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.id.cmp(&right.id))
    });
    recovery.sort_by(|left, right| {
        task_activity_ms(&right.task)
            .cmp(&task_activity_ms(&left.task))
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    Ok(ActiveTaskProjection {
        sections: projected_sections
            .into_iter()
            .map(|(section, _)| section)
            .collect(),
        unsectioned: recovery,
    })
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
    ) {
        store
            .transaction(|tables| {
                let section = ManagedSection {
                    section_id: section_id.to_string(),
                    logical_path: logical_path.to_string(),
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
    async fn cached_projection_uses_dense_positions_and_derived_section_recency() {
        let (_root, fs, store) = fixture();
        claim_at_top(
            &store,
            "older-1",
            "Older one",
            100,
            "section-b",
            "Workspace/b",
        );
        claim_at_top(
            &store,
            "older-0",
            "Older zero",
            200,
            "section-b",
            "Workspace/b",
        );
        claim_at_top(&store, "newer", "Newer", 300, "section-a", "Workspace/a");

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
            ["section-a", "section-b"]
        );
        assert_eq!(
            projection.sections[1]
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
        );
        let before = cached_rows(&store);

        let projection = load_cached(fs, store.clone()).await.unwrap();

        assert!(projection.sections[0].repository);
        assert_eq!(cached_rows(&store), before);
    }
}
