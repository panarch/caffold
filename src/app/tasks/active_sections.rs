use std::{
    collections::{BTreeMap, HashMap, HashSet},
    ops::Deref,
    sync::Arc,
};

use futures_util::{StreamExt, stream};
use serde::Serialize;
use tokio::sync::Mutex;

use crate::{
    app::error::ApiError,
    codex_app_server::{
        CodexThread, CodexThreadClient, CodexThreadError, ThreadSection, ThreadSectionFilter,
        ThreadStatus,
    },
    fs::RootedFs,
    task_store::{ManagedThread, TaskStore, TaskStoreError},
};

use super::{
    TaskRecord,
    detail::project_managed_worktree_cwd,
    projection::{resolve_thread_cwd, task_activity_ms, task_record_from_thread},
};

const ACTIVE_MEMBERSHIP_PAGE_SIZE: usize = 100;
const CODEX_SECTION_PAGE_SIZE: usize = 100;
const SECTION_LIST_CONCURRENCY: usize = 8;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskSection {
    pub(in crate::app) id: String,
    pub(in crate::app) name: String,
    pub(in crate::app) repository: bool,
    pub(in crate::app) tasks: Vec<TaskRecord>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskSectionIdentity {
    pub(in crate::app) id: String,
    pub(in crate::app) name: String,
    pub(in crate::app) repository: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskTopPlacement {
    pub(in crate::app) section: ActiveTaskSectionIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app) before_thread_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskProjection {
    pub(in crate::app) sections: Vec<ActiveTaskSection>,
    pub(in crate::app) unsectioned: Vec<ActiveTaskRecovery>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) enum ActiveTaskRecoveryReason {
    SectionPlacementPending,
    CodexArchived,
    ThreadMissing,
    TemporarilyUnavailable,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) enum ActiveTaskRecoveryAction {
    Recheck,
    RestoreToActive,
    MoveToArchived,
    RemoveFromCaffold,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskRecoveryContext {
    pub(in crate::app) reason: ActiveTaskRecoveryReason,
    pub(in crate::app) actions: Vec<ActiveTaskRecoveryAction>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskRecovery {
    #[serde(flatten)]
    pub(in crate::app) task: TaskRecord,
    pub(in crate::app) recovery: ActiveTaskRecoveryContext,
}

impl ActiveTaskRecovery {
    fn new(task: TaskRecord, reason: ActiveTaskRecoveryReason) -> Self {
        let actions = match reason {
            ActiveTaskRecoveryReason::SectionPlacementPending
            | ActiveTaskRecoveryReason::TemporarilyUnavailable => {
                vec![ActiveTaskRecoveryAction::Recheck]
            }
            ActiveTaskRecoveryReason::CodexArchived => vec![
                ActiveTaskRecoveryAction::RestoreToActive,
                ActiveTaskRecoveryAction::MoveToArchived,
                ActiveTaskRecoveryAction::Recheck,
            ],
            ActiveTaskRecoveryReason::ThreadMissing => vec![
                ActiveTaskRecoveryAction::Recheck,
                ActiveTaskRecoveryAction::RemoveFromCaffold,
            ],
        };
        Self {
            task,
            recovery: ActiveTaskRecoveryContext { reason, actions },
        }
    }
}

impl Deref for ActiveTaskRecovery {
    type Target = TaskRecord;

    fn deref(&self) -> &Self::Target {
        &self.task
    }
}

pub(in crate::app) enum ManagedCodexThreadLocation {
    Active(CodexThread),
    Archived(CodexThread),
    Missing,
}

impl ActiveTaskProjection {
    fn empty() -> Self {
        Self {
            sections: Vec::new(),
            unsectioned: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskSectionIdentity {
    name: String,
    repository: bool,
}

struct SectionThreads {
    section: ThreadSection,
    threads: Result<Vec<CodexThread>, CodexThreadError>,
}

struct ActiveSectionSnapshot {
    sections: Vec<SectionThreads>,
    unsectioned: Result<Vec<CodexThread>, CodexThreadError>,
}

#[derive(Clone)]
pub(in crate::app) struct ActiveTaskSections {
    fs: Arc<RootedFs>,
    store: TaskStore,
    path_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl ActiveTaskSections {
    pub(in crate::app) fn new(fs: Arc<RootedFs>, store: TaskStore) -> Self {
        Self {
            fs,
            store,
            path_locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub(in crate::app) async fn load(
        &self,
        client: &CodexThreadClient,
    ) -> Result<ActiveTaskProjection, ApiError> {
        let managed = self.active_managed_threads().await?;
        if managed.is_empty() {
            return Ok(ActiveTaskProjection::empty());
        }

        let mut snapshot = match self.load_snapshot(client).await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                eprintln!("failed to list Codex thread sections: {error}");
                return self.recovery_projection(client, managed).await;
            }
        };

        if self
            .reconcile_unsectioned(client, &managed, &snapshot)
            .await
        {
            snapshot = match self.load_snapshot(client).await {
                Ok(snapshot) => snapshot,
                Err(error) => {
                    eprintln!(
                        "failed to reload Codex thread sections after reconciliation: {error}"
                    );
                    return self.recovery_projection(client, managed).await;
                }
            };
        }

        self.project_snapshot(client, managed, snapshot).await
    }

    pub(in crate::app) async fn reconcile(&self, client: &CodexThreadClient) {
        if let Err(error) = self.load(client).await {
            eprintln!("failed to reconcile active Task sections: {error}");
        }
    }

    pub(in crate::app) async fn place_at_top(
        &self,
        client: &CodexThreadClient,
        task: &TaskRecord,
    ) -> Result<ActiveTaskTopPlacement, ApiError> {
        let identity = task_section_identity(task).ok_or_else(|| {
            ApiError::Internal(format!(
                "failed to resolve the active Section path for Task {}",
                task.thread_id
            ))
        })?;
        let path_lock = self.path_lock(&identity.name).await;
        let _guard = path_lock.lock().await;
        let section = self.ensure_section_locked(client, &identity.name).await?;
        let first = client
            .list_section_threads(ThreadSectionFilter::Section(&section.id), None, 1)
            .await?
            .data
            .into_iter()
            .next();
        let before_thread_id = first
            .as_ref()
            .filter(|first| first.id != task.thread_id)
            .map(|thread| thread.id.clone());
        if first
            .as_ref()
            .is_none_or(|first| first.id != task.thread_id)
        {
            client
                .move_thread_to_section(
                    &task.thread_id,
                    Some(&section.id),
                    before_thread_id.as_deref(),
                )
                .await?;
        }
        Ok(ActiveTaskTopPlacement {
            section: ActiveTaskSectionIdentity {
                id: section.id,
                name: section.name,
                repository: identity.repository,
            },
            before_thread_id,
        })
    }

    pub(in crate::app) async fn locate_thread(
        &self,
        client: &CodexThreadClient,
        thread_id: &str,
    ) -> Result<ManagedCodexThreadLocation, CodexThreadError> {
        match list_all_global_threads(client).await {
            Ok(threads) => {
                if let Some(thread) = threads.into_iter().find(|thread| thread.id == thread_id) {
                    return Ok(ManagedCodexThreadLocation::Active(thread));
                }
            }
            Err(active_error) => {
                let archived = list_all_archived_threads(client).await?;
                if let Some(thread) = archived.into_iter().find(|thread| thread.id == thread_id) {
                    return Ok(ManagedCodexThreadLocation::Archived(thread));
                }
                return Err(active_error);
            }
        }

        let archived = list_all_archived_threads(client).await?;
        Ok(archived
            .into_iter()
            .find(|thread| thread.id == thread_id)
            .map(ManagedCodexThreadLocation::Archived)
            .unwrap_or(ManagedCodexThreadLocation::Missing))
    }

    async fn active_managed_threads(&self) -> Result<Vec<ManagedThread>, ApiError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let mut cursor = None;
            let mut seen_cursors = HashSet::new();
            let mut managed = Vec::new();
            loop {
                let (page, next_cursor) =
                    store.list(cursor.as_deref(), ACTIVE_MEMBERSHIP_PAGE_SIZE)?;
                managed.extend(page);
                let Some(next_cursor) = next_cursor.filter(|cursor| !cursor.is_empty()) else {
                    return Ok::<_, TaskStoreError>(managed);
                };
                if !seen_cursors.insert(next_cursor.clone()) {
                    return Err(TaskStoreError::InvalidCursor);
                }
                cursor = Some(next_cursor);
            }
        })
        .await
        .map_err(|error| ApiError::Internal(format!("task store worker failed: {error}")))?
        .map_err(|error| ApiError::Internal(error.to_string()))
    }

    async fn load_snapshot(
        &self,
        client: &CodexThreadClient,
    ) -> Result<ActiveSectionSnapshot, CodexThreadError> {
        let sections = list_all_sections(client).await?;
        let section_pages = stream::iter(sections)
            .map(|section| async move {
                let threads =
                    list_all_threads(client, ThreadSectionFilter::Section(&section.id)).await;
                SectionThreads { section, threads }
            })
            .buffer_unordered(SECTION_LIST_CONCURRENCY)
            .collect::<Vec<_>>();
        let unsectioned = list_all_threads(client, ThreadSectionFilter::Unsectioned);
        let (mut sections, unsectioned) = tokio::join!(section_pages, unsectioned);
        sections.sort_by(|left, right| left.section.id.cmp(&right.section.id));
        Ok(ActiveSectionSnapshot {
            sections,
            unsectioned,
        })
    }

    async fn reconcile_unsectioned(
        &self,
        client: &CodexThreadClient,
        managed: &[ManagedThread],
        snapshot: &ActiveSectionSnapshot,
    ) -> bool {
        let Ok(unsectioned) = &snapshot.unsectioned else {
            if let Err(error) = &snapshot.unsectioned {
                eprintln!("failed to list unsectioned managed Tasks for reconciliation: {error}");
            }
            return false;
        };
        let managed_by_id = managed
            .iter()
            .map(|managed| (managed.thread_id.as_str(), managed))
            .collect::<HashMap<_, _>>();
        let mut groups = BTreeMap::<String, Vec<(&CodexThread, u64)>>::new();
        for thread in unsectioned {
            if !managed_by_id.contains_key(thread.id.as_str()) {
                continue;
            }
            let Ok(task) = self.project_thread(thread) else {
                continue;
            };
            let Some(identity) = task_section_identity(&task) else {
                continue;
            };
            groups
                .entry(identity.name)
                .or_default()
                .push((thread, task_activity_ms(&task)));
        }

        let mut changed = false;
        for (name, mut tasks) in groups {
            tasks.sort_by(|(left, left_activity), (right, right_activity)| {
                right_activity
                    .cmp(left_activity)
                    .then_with(|| left.id.cmp(&right.id))
            });
            changed |= self.place_unsectioned_group(client, &name, &tasks).await;
        }
        changed
    }

    async fn place_unsectioned_group(
        &self,
        client: &CodexThreadClient,
        name: &str,
        tasks: &[(&CodexThread, u64)],
    ) -> bool {
        let path_lock = self.path_lock(name).await;
        let _guard = path_lock.lock().await;
        let current_unsectioned =
            match list_all_threads(client, ThreadSectionFilter::Unsectioned).await {
                Ok(threads) => threads
                    .into_iter()
                    .map(|thread| thread.id)
                    .collect::<HashSet<_>>(),
                Err(error) => {
                    eprintln!(
                        "failed to confirm unsectioned managed Tasks for Section {name:?}: {error}"
                    );
                    return false;
                }
            };
        let tasks = tasks
            .iter()
            .filter(|(thread, _)| current_unsectioned.contains(&thread.id))
            .collect::<Vec<_>>();
        if tasks.is_empty() {
            // Another load may have reconciled this stale snapshot while this
            // caller waited on the path lock. Force this caller to reload the
            // canonical Section projection without issuing duplicate moves.
            return true;
        }
        let section = match self.ensure_section_locked(client, name).await {
            Ok(section) => section,
            Err(error) => {
                eprintln!("failed to ensure active Task Section {name:?}: {error}");
                return false;
            }
        };

        let mut changed = false;
        // Appending the recency-sorted migration block preserves both its
        // historic order and any already-sectioned Task order. In particular,
        // a concurrently created or restored Task must remain at the top.
        for (thread, _) in tasks {
            if let Err(error) = client
                .move_thread_to_section(&thread.id, Some(&section.id), None)
                .await
            {
                eprintln!(
                    "failed to reconcile managed Thread {} into active Task Section {name:?}: {error}",
                    thread.id
                );
                break;
            }
            changed = true;
        }
        changed
    }

    async fn ensure_section_locked(
        &self,
        client: &CodexThreadClient,
        name: &str,
    ) -> Result<ThreadSection, CodexThreadError> {
        let mut matches = list_all_sections(client)
            .await?
            .into_iter()
            .filter(|section| section.name == name)
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| left.id.cmp(&right.id));
        match matches.into_iter().next() {
            Some(section) => Ok(section),
            None => client.create_thread_section(name).await,
        }
    }

    async fn path_lock(&self, name: &str) -> Arc<Mutex<()>> {
        let mut locks = self.path_locks.lock().await;
        locks
            .entry(name.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn project_snapshot(
        &self,
        client: &CodexThreadClient,
        managed: Vec<ManagedThread>,
        snapshot: ActiveSectionSnapshot,
    ) -> Result<ActiveTaskProjection, ApiError> {
        let managed_by_id = managed
            .iter()
            .cloned()
            .map(|managed| (managed.thread_id.clone(), managed))
            .collect::<HashMap<_, _>>();
        let mut remaining = managed_by_id.keys().cloned().collect::<HashSet<_>>();
        let mut canonical_section_by_name = HashMap::<String, String>::new();
        for section in &snapshot.sections {
            canonical_section_by_name
                .entry(section.section.name.clone())
                .and_modify(|id| {
                    if section.section.id < *id {
                        *id = section.section.id.clone();
                    }
                })
                .or_insert_with(|| section.section.id.clone());
        }

        let mut projected_sections = Vec::<(ActiveTaskSection, u64)>::new();
        let mut recovery = Vec::new();
        for section in snapshot.sections {
            if canonical_section_by_name.get(&section.section.name) != Some(&section.section.id) {
                continue;
            }
            let threads = match section.threads {
                Ok(threads) => threads,
                Err(error) => {
                    eprintln!(
                        "failed to list Threads in active Task Section {:?}: {error}",
                        section.section.name
                    );
                    continue;
                }
            };
            let mut tasks = Vec::new();
            let mut updated_ms = 0;
            let mut repository = false;
            for thread in threads {
                let Some(managed) = managed_by_id.get(&thread.id) else {
                    continue;
                };
                if !remaining.remove(&thread.id) {
                    continue;
                }
                let mut task = match self.project_thread(&thread) {
                    Ok(task) => task,
                    Err(error) => {
                        eprintln!("failed to project managed Thread {}: {error}", thread.id);
                        recovery.push(ActiveTaskRecovery::new(
                            unavailable_active_task(managed),
                            ActiveTaskRecoveryReason::TemporarilyUnavailable,
                        ));
                        continue;
                    }
                };
                apply_managed_thread_metadata(&mut task, managed);
                let identity = task_section_identity(&task);
                if identity.as_ref().map(|identity| identity.name.as_str())
                    != Some(section.section.name.as_str())
                {
                    recovery.push(ActiveTaskRecovery::new(
                        task,
                        ActiveTaskRecoveryReason::SectionPlacementPending,
                    ));
                    continue;
                }
                repository |= identity.is_some_and(|identity| identity.repository);
                updated_ms = updated_ms.max(task_activity_ms(&task));
                tasks.push(task);
            }
            if !tasks.is_empty() {
                projected_sections.push((
                    ActiveTaskSection {
                        id: section.section.id,
                        name: section.section.name,
                        repository,
                        tasks,
                    },
                    updated_ms,
                ));
            }
        }

        match snapshot.unsectioned {
            Ok(threads) => {
                for thread in threads {
                    let Some(managed) = managed_by_id.get(&thread.id) else {
                        continue;
                    };
                    if !remaining.remove(&thread.id) {
                        continue;
                    }
                    let mut task = self
                        .project_thread(&thread)
                        .unwrap_or_else(|_| unavailable_active_task(managed));
                    apply_managed_thread_metadata(&mut task, managed);
                    let reason = if task.conversation_available {
                        ActiveTaskRecoveryReason::SectionPlacementPending
                    } else {
                        ActiveTaskRecoveryReason::TemporarilyUnavailable
                    };
                    recovery.push(ActiveTaskRecovery::new(task, reason));
                }
            }
            Err(error) => {
                eprintln!("failed to list unsectioned managed Threads: {error}");
            }
        }

        if !remaining.is_empty() {
            let (active, archived) = tokio::join!(
                list_all_global_threads(client),
                list_all_archived_threads(client),
            );
            if let Err(error) = &active {
                eprintln!("failed to load active managed Thread recovery details: {error}");
            }
            if let Err(error) = &archived {
                eprintln!("failed to load archived managed Thread recovery details: {error}");
            }
            let active = active.ok().map(|threads| {
                threads
                    .into_iter()
                    .map(|thread| (thread.id.clone(), thread))
                    .collect::<HashMap<_, _>>()
            });
            let archived = archived.ok().map(|threads| {
                threads
                    .into_iter()
                    .map(|thread| (thread.id.clone(), thread))
                    .collect::<HashMap<_, _>>()
            });
            let mut missing = remaining.into_iter().collect::<Vec<_>>();
            missing.sort();
            for thread_id in missing {
                let managed = &managed_by_id[&thread_id];
                let (mut task, reason) = if let Some(thread) =
                    active.as_ref().and_then(|threads| threads.get(&thread_id))
                {
                    match self.project_thread(thread) {
                        Ok(task) => (task, ActiveTaskRecoveryReason::SectionPlacementPending),
                        Err(_) => (
                            unavailable_active_task(managed),
                            ActiveTaskRecoveryReason::TemporarilyUnavailable,
                        ),
                    }
                } else if let Some(thread) = archived
                    .as_ref()
                    .and_then(|threads| threads.get(&thread_id))
                {
                    let mut task = self
                        .project_thread(thread)
                        .unwrap_or_else(|_| unavailable_active_task(managed));
                    task.conversation_available = false;
                    (task, ActiveTaskRecoveryReason::CodexArchived)
                } else {
                    let reason = if active.is_some() && archived.is_some() {
                        ActiveTaskRecoveryReason::ThreadMissing
                    } else {
                        ActiveTaskRecoveryReason::TemporarilyUnavailable
                    };
                    (unavailable_active_task(managed), reason)
                };
                apply_managed_thread_metadata(&mut task, managed);
                recovery.push(ActiveTaskRecovery::new(task, reason));
            }
        }

        self.update_observed_recency(
            projected_sections
                .iter()
                .flat_map(|(section, _)| section.tasks.iter())
                .chain(recovery.iter().map(|recovery| &recovery.task)),
        )
        .await?;

        projected_sections.sort_by(|(left, left_updated), (right, right_updated)| {
            right_updated
                .cmp(left_updated)
                .then_with(|| left.name.cmp(&right.name))
                .then_with(|| left.id.cmp(&right.id))
        });
        recovery.sort_by(|left, right| {
            task_activity_ms(&right.task)
                .cmp(&task_activity_ms(&left.task))
                .then_with(|| left.task.thread_id.cmp(&right.task.thread_id))
        });
        Ok(ActiveTaskProjection {
            sections: projected_sections
                .into_iter()
                .map(|(section, _)| section)
                .collect(),
            unsectioned: recovery,
        })
    }

    async fn recovery_projection(
        &self,
        client: &CodexThreadClient,
        managed: Vec<ManagedThread>,
    ) -> Result<ActiveTaskProjection, ApiError> {
        let (active, archived) = tokio::join!(
            list_all_global_threads(client),
            list_all_archived_threads(client),
        );
        if let Err(error) = &active {
            eprintln!("failed to load fallback active Task details: {error}");
        }
        if let Err(error) = &archived {
            eprintln!("failed to load fallback archived Task details: {error}");
        }
        let active = active.ok().map(|threads| {
            threads
                .into_iter()
                .map(|thread| (thread.id.clone(), thread))
                .collect::<HashMap<_, _>>()
        });
        let archived = archived.ok().map(|threads| {
            threads
                .into_iter()
                .map(|thread| (thread.id.clone(), thread))
                .collect::<HashMap<_, _>>()
        });
        let mut unsectioned = managed
            .iter()
            .map(|managed| {
                let (mut task, reason) = if let Some(thread) = active
                    .as_ref()
                    .and_then(|threads| threads.get(&managed.thread_id))
                {
                    match self.project_thread(thread) {
                        Ok(task) => (task, ActiveTaskRecoveryReason::SectionPlacementPending),
                        Err(_) => (
                            unavailable_active_task(managed),
                            ActiveTaskRecoveryReason::TemporarilyUnavailable,
                        ),
                    }
                } else if let Some(thread) = archived
                    .as_ref()
                    .and_then(|threads| threads.get(&managed.thread_id))
                {
                    let mut task = self
                        .project_thread(thread)
                        .unwrap_or_else(|_| unavailable_active_task(managed));
                    task.conversation_available = false;
                    (task, ActiveTaskRecoveryReason::CodexArchived)
                } else {
                    let reason = if active.is_some() && archived.is_some() {
                        ActiveTaskRecoveryReason::ThreadMissing
                    } else {
                        ActiveTaskRecoveryReason::TemporarilyUnavailable
                    };
                    (unavailable_active_task(managed), reason)
                };
                apply_managed_thread_metadata(&mut task, managed);
                ActiveTaskRecovery::new(task, reason)
            })
            .collect::<Vec<_>>();
        self.update_observed_recency(unsectioned.iter().map(|recovery| &recovery.task))
            .await?;
        unsectioned.sort_by(|left, right| {
            task_activity_ms(&right.task)
                .cmp(&task_activity_ms(&left.task))
                .then_with(|| left.task.thread_id.cmp(&right.task.thread_id))
        });
        Ok(ActiveTaskProjection {
            sections: Vec::new(),
            unsectioned,
        })
    }

    fn project_thread(&self, thread: &CodexThread) -> Result<TaskRecord, ApiError> {
        let thread = project_managed_worktree_cwd(&self.store, thread.clone().into_value())?;
        let resolved = resolve_thread_cwd(&self.fs, &thread);
        task_record_from_thread(&thread, &[], resolved.as_ref())
    }

    async fn update_observed_recency<'a>(
        &self,
        tasks: impl Iterator<Item = &'a TaskRecord>,
    ) -> Result<(), ApiError> {
        let observations = tasks
            .map(|task| (task.thread_id.clone(), task_activity_ms(task)))
            .collect::<Vec<_>>();
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            for (thread_id, activity_ms) in observations {
                store.update_observed_recency(&thread_id, activity_ms)?;
            }
            Ok::<_, TaskStoreError>(())
        })
        .await
        .map_err(|error| ApiError::Internal(format!("task store worker failed: {error}")))?
        .map_err(|error| ApiError::Internal(error.to_string()))
    }
}

fn task_section_identity(task: &TaskRecord) -> Option<TaskSectionIdentity> {
    if let Some(worktree) = &task.worktree {
        return Some(TaskSectionIdentity {
            name: worktree.repository_root_path.clone(),
            repository: true,
        });
    }
    task.cwd_path.as_ref().map(|cwd_path| TaskSectionIdentity {
        name: cwd_path.clone(),
        repository: false,
    })
}

fn apply_managed_thread_metadata(task: &mut TaskRecord, managed: &ManagedThread) {
    task.last_completed_ms = managed.last_completed_at_ms;
    task.unseen = managed.unseen();
}

fn unavailable_active_task(managed: &ManagedThread) -> TaskRecord {
    let activity_ms = managed
        .last_observed_recency_ms
        .unwrap_or(managed.claimed_at_ms);
    TaskRecord {
        id: managed.thread_id.clone(),
        thread_id: managed.thread_id.clone(),
        conversation_available: false,
        title: format!("Thread {}", short_thread_id(&managed.thread_id)),
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

fn short_thread_id(thread_id: &str) -> &str {
    thread_id.get(..8).unwrap_or(thread_id)
}

async fn list_all_sections(
    client: &CodexThreadClient,
) -> Result<Vec<ThreadSection>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_sections = HashSet::new();
    let mut sections = Vec::new();
    loop {
        let page = client
            .list_thread_sections(cursor.as_deref(), CODEX_SECTION_PAGE_SIZE)
            .await?;
        for section in page.data {
            if seen_sections.insert(section.id.clone()) {
                sections.push(section);
            }
        }
        let Some(next_cursor) = page.next_cursor.filter(|cursor| !cursor.is_empty()) else {
            return Ok(sections);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(CodexThreadError::Protocol(
                "Codex app-server repeated a threadSection/list cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
}

async fn list_all_threads(
    client: &CodexThreadClient,
    section: ThreadSectionFilter<'_>,
) -> Result<Vec<CodexThread>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_threads = HashSet::new();
    let mut threads = Vec::new();
    loop {
        let page = client
            .list_section_threads(section, cursor.as_deref(), CODEX_SECTION_PAGE_SIZE)
            .await?;
        for thread in page.data {
            if seen_threads.insert(thread.id.clone()) {
                threads.push(thread);
            }
        }
        let Some(next_cursor) = page.next_cursor.filter(|cursor| !cursor.is_empty()) else {
            return Ok(threads);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(CodexThreadError::Protocol(
                "Codex app-server repeated a section-position thread/list cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
}

async fn list_all_global_threads(
    client: &CodexThreadClient,
) -> Result<Vec<CodexThread>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_threads = HashSet::new();
    let mut threads = Vec::new();
    loop {
        let page = client
            .list_threads(cursor.as_deref(), CODEX_SECTION_PAGE_SIZE)
            .await?;
        for thread in page.data {
            if seen_threads.insert(thread.id.clone()) {
                threads.push(thread);
            }
        }
        let Some(next_cursor) = page.next_cursor.filter(|cursor| !cursor.is_empty()) else {
            return Ok(threads);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(CodexThreadError::Protocol(
                "Codex app-server repeated a fallback thread/list cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
}

async fn list_all_archived_threads(
    client: &CodexThreadClient,
) -> Result<Vec<CodexThread>, CodexThreadError> {
    let mut cursor = None;
    let mut seen_cursors = HashSet::new();
    let mut seen_threads = HashSet::new();
    let mut threads = Vec::new();
    loop {
        let page = client
            .list_archived_threads(cursor.as_deref(), CODEX_SECTION_PAGE_SIZE)
            .await?;
        for thread in page.data {
            if seen_threads.insert(thread.id.clone()) {
                threads.push(thread);
            }
        }
        let Some(next_cursor) = page.next_cursor.filter(|cursor| !cursor.is_empty()) else {
            return Ok(threads);
        };
        if !seen_cursors.insert(next_cursor.clone()) {
            return Err(CodexThreadError::Protocol(
                "Codex app-server repeated an archived recovery thread/list cursor".to_string(),
            ));
        }
        cursor = Some(next_cursor);
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value as JsonValue, json};

    use super::*;
    use crate::codex_app_server::MockCodexResponse;

    fn section_list_params(cursor: Option<&str>) -> JsonValue {
        let mut params = json!({ "limit": CODEX_SECTION_PAGE_SIZE });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        params
    }

    fn thread_list_params(
        section_id: Option<&str>,
        cursor: Option<&str>,
        limit: usize,
    ) -> JsonValue {
        let (sort_key, sort_direction) = if section_id.is_some() {
            ("section_position", "asc")
        } else {
            ("recency_at", "desc")
        };
        let mut params = json!({
            "limit": limit,
            "sortKey": sort_key,
            "sortDirection": sort_direction,
            "archived": false,
            "useStateDbOnly": true,
            "sectionId": section_id,
        });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        params
    }

    fn global_thread_list_params(cursor: Option<&str>) -> JsonValue {
        let mut params = json!({
            "limit": CODEX_SECTION_PAGE_SIZE,
            "sortKey": "recency_at",
            "sortDirection": "desc",
            "archived": false,
            "useStateDbOnly": true,
        });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        params
    }

    fn archived_thread_list_params(cursor: Option<&str>) -> JsonValue {
        let mut params = json!({
            "limit": CODEX_SECTION_PAGE_SIZE,
            "sortKey": "recency_at",
            "sortDirection": "desc",
            "archived": true,
            "useStateDbOnly": true,
        });
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        params
    }

    fn thread(thread_id: &str, cwd: &Path, updated_at: f64) -> JsonValue {
        json!({
            "id": thread_id,
            "preview": format!("Task {thread_id}"),
            "status": { "type": "idle" },
            "cwd": cwd.display().to_string(),
            "createdAt": 1.0,
            "updatedAt": updated_at,
            "turns": [],
        })
    }

    fn thread_page(threads: Vec<JsonValue>, next_cursor: Option<&str>) -> JsonValue {
        json!({
            "data": threads,
            "nextCursor": next_cursor,
            "backwardsCursor": null,
        })
    }

    fn section_page(sections: Vec<(&str, &str)>, next_cursor: Option<&str>) -> JsonValue {
        json!({
            "data": sections
                .into_iter()
                .map(|(id, name)| json!({ "id": id, "name": name }))
                .collect::<Vec<_>>(),
            "nextCursor": next_cursor,
        })
    }

    fn fixture() -> (tempfile::TempDir, ActiveTaskSections, TaskStore) {
        let root = tempfile::tempdir().expect("temporary Caffold root");
        let store = TaskStore::memory().expect("in-memory task store");
        let sections = ActiveTaskSections::new(
            Arc::new(RootedFs::new(root.path()).expect("rooted filesystem")),
            store.clone(),
        );
        (root, sections, store)
    }

    fn claim(store: &TaskStore, thread_id: &str, recency_ms: u64) {
        store
            .claim(
                ManagedThread::new(thread_id, Some(recency_ms), None, None),
                recency_ms,
            )
            .expect("managed Thread claim");
    }

    fn project_task(sections: &ActiveTaskSections, thread: JsonValue) -> TaskRecord {
        let thread = serde_json::from_value(thread).expect("Codex Thread fixture");
        sections.project_thread(&thread).expect("Task projection")
    }

    fn initialize_git_repository(path: &Path) {
        std::fs::create_dir_all(path).unwrap();
        for args in [
            vec!["init"],
            vec!["config", "user.email", "test@example.com"],
            vec!["config", "user.name", "Caffold Test"],
        ] {
            assert!(
                std::process::Command::new("git")
                    .arg("-C")
                    .arg(path)
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        std::fs::write(path.join("README.md"), "initial\n").unwrap();
        for args in [vec!["add", "README.md"], vec!["commit", "-m", "Initial"]] {
            assert!(
                std::process::Command::new("git")
                    .arg("-C")
                    .arg(path)
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
    }

    #[tokio::test]
    async fn loads_every_section_cursor_and_preserves_server_thread_order() {
        let (root, sections, store) = fixture();
        let alpha = root.path().join("parent-a/repository");
        let beta = root.path().join("parent-b/repository");
        std::fs::create_dir_all(&alpha).unwrap();
        std::fs::create_dir_all(&beta).unwrap();
        for (id, recency) in [
            ("alpha-new", 30_000),
            ("alpha-old", 20_000),
            ("beta", 10_000),
        ] {
            claim(&store, id, recency);
        }

        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(
                    vec![("section-alpha", "parent-a/repository")],
                    Some("sections-2"),
                ),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(Some("sections-2")),
                section_page(vec![("section-beta", "parent-b/repository")], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some("section-alpha"), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![
                        thread("alpha-new", &alpha, 30.0),
                        thread("unrelated", &alpha, 40.0),
                    ],
                    Some("alpha-2"),
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(
                    Some("section-alpha"),
                    Some("alpha-2"),
                    CODEX_SECTION_PAGE_SIZE,
                ),
                thread_page(vec![thread("alpha-old", &alpha, 20.0)], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some("section-beta"), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("beta", &beta, 10.0)], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![thread("unrelated-unsectioned", &alpha, 50.0)],
                    Some("unsectioned-2"),
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, Some("unsectioned-2"), CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("another-unrelated", &beta, 60.0)], None),
            ),
        ]);

        let projection = sections.load(&client).await.expect("active projection");

        assert_eq!(projection.sections.len(), 2);
        assert_eq!(projection.sections[0].name, "parent-a/repository");
        assert!(!projection.sections[0].repository);
        assert_eq!(
            projection.sections[0]
                .tasks
                .iter()
                .map(|task| task.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["alpha-new", "alpha-old"]
        );
        assert_eq!(projection.sections[1].name, "parent-b/repository");
        assert_eq!(projection.sections[1].tasks[0].thread_id, "beta");
        assert!(projection.unsectioned.is_empty());
        assert!(client.mock_requests().await.iter().any(|(method, params)| {
            method == "thread/list"
                && params
                    == &thread_list_params(None, Some("unsectioned-2"), CODEX_SECTION_PAGE_SIZE)
        }));
        assert!(
            client
                .mock_requests()
                .await
                .iter()
                .all(|(method, _)| method != "thread/read"),
            "the Active projection must not fan out through thread/read"
        );
    }

    #[tokio::test]
    async fn loads_every_active_membership_cursor() {
        let (root, sections, store) = fixture();
        let project = root.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let threads = (0..=ACTIVE_MEMBERSHIP_PAGE_SIZE)
            .map(|index| {
                let thread_id = format!("thread-{index:03}");
                claim(&store, &thread_id, index as u64 + 1);
                thread(&thread_id, &project, index as f64 + 1.0)
            })
            .collect::<Vec<_>>();

        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![("section-project", "project")], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some("section-project"), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    threads[..ACTIVE_MEMBERSHIP_PAGE_SIZE].to_vec(),
                    Some("threads-2"),
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(
                    Some("section-project"),
                    Some("threads-2"),
                    CODEX_SECTION_PAGE_SIZE,
                ),
                thread_page(threads[ACTIVE_MEMBERSHIP_PAGE_SIZE..].to_vec(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(Vec::new(), None),
            ),
        ]);

        let projection = sections.load(&client).await.expect("active projection");

        assert_eq!(projection.sections.len(), 1);
        assert_eq!(
            projection.sections[0].tasks.len(),
            ACTIVE_MEMBERSHIP_PAGE_SIZE + 1
        );
        assert!(projection.unsectioned.is_empty());
    }

    #[tokio::test]
    async fn reconciles_unsectioned_tasks_in_existing_recency_order_and_is_idempotent() {
        let (root, sections, store) = fixture();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        claim(&store, "newest", 5_000);
        claim(&store, "oldest", 50_000);

        let section = ("section-project", "project");
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![
                        thread("oldest", &project, 10.0),
                        thread("newest", &project, 30.0),
                    ],
                    None,
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![
                        thread("oldest", &project, 10.0),
                        thread("newest", &project, 30.0),
                    ],
                    None,
                ),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "threadSection/create",
                json!({ "name": "project" }),
                json!({ "section": { "id": section.0, "name": section.1 } }),
            ),
            MockCodexResponse::ok_for(
                "thread/section/move",
                json!({ "threadId": "newest", "sectionId": section.0 }),
                json!({}),
            ),
            MockCodexResponse::ok_for(
                "thread/section/move",
                json!({ "threadId": "oldest", "sectionId": section.0 }),
                json!({}),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some(section.0), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![
                        thread("newest", &project, 30.0),
                        thread("oldest", &project, 10.0),
                    ],
                    None,
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some(section.0), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![
                        thread("newest", &project, 30.0),
                        thread("oldest", &project, 10.0),
                    ],
                    None,
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(Vec::new(), None),
            ),
        ]);

        for _ in 0..2 {
            let projection = sections.load(&client).await.expect("active projection");
            assert_eq!(
                projection.sections[0]
                    .tasks
                    .iter()
                    .map(|task| task.thread_id.as_str())
                    .collect::<Vec<_>>(),
                ["newest", "oldest"]
            );
            assert!(projection.unsectioned.is_empty());
        }

        let requests = client.mock_requests().await;
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "threadSection/create")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(method, _)| method == "thread/section/move")
                .map(|(_, params)| params["threadId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["newest", "oldest"]
        );
    }

    #[tokio::test]
    async fn a_partial_reconciliation_keeps_the_remaining_task_recoverable_then_retries() {
        let (root, sections, store) = fixture();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        claim(&store, "newest", 30_000);
        claim(&store, "oldest", 10_000);
        let section = ("section-project", "project");

        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some(section.0), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![
                        thread("newest", &project, 30.0),
                        thread("oldest", &project, 10.0),
                    ],
                    None,
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![
                        thread("newest", &project, 30.0),
                        thread("oldest", &project, 10.0),
                    ],
                    None,
                ),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/section/move",
                json!({ "threadId": "newest", "sectionId": section.0 }),
                json!({}),
            ),
            MockCodexResponse::error_for(
                "thread/section/move",
                json!({ "threadId": "oldest", "sectionId": section.0 }),
                CodexThreadError::ProcessUnavailable,
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some(section.0), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("newest", &project, 30.0)], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("oldest", &project, 10.0)], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("oldest", &project, 10.0)], None),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some(section.0), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("newest", &project, 30.0)], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("oldest", &project, 10.0)], None),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/section/move",
                json!({ "threadId": "oldest", "sectionId": section.0 }),
                json!({}),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some(section.0), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(
                    vec![
                        thread("newest", &project, 30.0),
                        thread("oldest", &project, 10.0),
                    ],
                    None,
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(Vec::new(), None),
            ),
        ]);

        let first = sections.load(&client).await.expect("partial projection");
        assert_eq!(first.sections[0].tasks[0].thread_id, "newest");
        assert_eq!(first.unsectioned[0].thread_id, "oldest");
        assert!(store.get("oldest").unwrap().is_some());

        let second = sections.load(&client).await.expect("retried projection");
        assert_eq!(
            second.sections[0]
                .tasks
                .iter()
                .map(|task| task.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["newest", "oldest"]
        );
        assert!(second.unsectioned.is_empty());
    }

    #[tokio::test]
    async fn concurrent_top_placements_serialize_section_creation_for_the_same_path() {
        let (root, sections, _store) = fixture();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let first = project_task(&sections, thread("first", &project, 1.0));
        let second = project_task(&sections, thread("second", &project, 2.0));
        let section = ("section-project", "project");
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "threadSection/create",
                json!({ "name": "project" }),
                json!({ "section": { "id": section.0, "name": section.1 } }),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some(section.0), None, 1),
                thread_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/section/move",
                json!({ "threadId": "first", "sectionId": section.0 }),
                json!({}),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some(section.0), None, 1),
                thread_page(vec![thread("first", &project, 1.0)], None),
            ),
            MockCodexResponse::ok_for(
                "thread/section/move",
                json!({
                    "threadId": "second",
                    "sectionId": section.0,
                    "beforeThreadId": "first",
                }),
                json!({}),
            ),
        ]);

        let (first_result, second_result) = tokio::join!(
            sections.place_at_top(&client, &first),
            sections.place_at_top(&client, &second),
        );
        let first_placement = first_result.expect("first placement");
        let second_placement = second_result.expect("second placement");

        assert_eq!(first_placement.section.id, section.0);
        assert_eq!(first_placement.section.name, section.1);
        assert!(first_placement.before_thread_id.is_none());
        assert_eq!(second_placement.before_thread_id.as_deref(), Some("first"));

        assert_eq!(
            client
                .mock_requests()
                .await
                .iter()
                .filter(|(method, _)| method == "threadSection/create")
                .count(),
            1
        );
    }

    #[test]
    fn main_checkout_and_linked_worktree_resolve_to_the_same_section_name() {
        let (root, sections, _store) = fixture();
        let main = root.path().join("main");
        let linked = root.path().join("linked");
        initialize_git_repository(&main);
        crate::git::create_attached_worktree(&main, &linked, "feature/section-test", None)
            .expect("linked worktree");

        let main_task = project_task(&sections, thread("main-thread", &main, 1.0));
        let linked_task = project_task(&sections, thread("linked-thread", &linked, 2.0));
        let main_identity = task_section_identity(&main_task).expect("main Section identity");
        let linked_identity = task_section_identity(&linked_task).expect("linked Section identity");

        assert_eq!(main_identity.name, "main");
        assert_eq!(linked_identity, main_identity);
        assert!(linked_identity.repository);
    }

    #[tokio::test]
    async fn migration_appends_without_displacing_an_existing_section_top() {
        let (root, sections, _store) = fixture();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let candidate = serde_json::from_value::<CodexThread>(thread("legacy", &project, 2.0))
            .expect("candidate Thread");
        let section = ("section-project", "project");
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("legacy", &project, 2.0)], None),
            ),
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![section], None),
            ),
            MockCodexResponse::ok_for(
                "thread/section/move",
                json!({ "threadId": "legacy", "sectionId": section.0 }),
                json!({}),
            ),
        ]);

        assert!(
            sections
                .place_unsectioned_group(&client, "project", &[(&candidate, 2_000)])
                .await
        );
        let requests = client.mock_requests().await;
        let move_params = &requests
            .iter()
            .find(|(method, _)| method == "thread/section/move")
            .expect("migration move")
            .1;
        assert!(move_params.get("beforeThreadId").is_none());
    }

    #[tokio::test]
    async fn stale_reconciliation_snapshot_reloads_without_moving_the_thread_again() {
        let (root, sections, _store) = fixture();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let candidate = serde_json::from_value::<CodexThread>(thread("moved", &project, 2.0))
            .expect("candidate Thread");
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok_for(
            "thread/list",
            thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
            thread_page(Vec::new(), None),
        )]);

        assert!(
            sections
                .place_unsectioned_group(&client, "project", &[(&candidate, 2_000)])
                .await
        );
        assert_eq!(
            client
                .mock_requests()
                .await
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            ["thread/list"]
        );
    }

    #[tokio::test]
    async fn a_managed_task_in_the_wrong_section_is_recoverable_without_cross_section_move() {
        let (root, sections, store) = fixture();
        let project = root.path().join("correct");
        std::fs::create_dir(&project).unwrap();
        claim(&store, "wrong-section", 10_000);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(vec![("wrong", "somewhere-else")], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(Some("wrong"), None, CODEX_SECTION_PAGE_SIZE),
                thread_page(vec![thread("wrong-section", &project, 10.0)], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(Vec::new(), None),
            ),
        ]);

        let projection = sections.load(&client).await.expect("recovery projection");
        assert!(projection.sections.is_empty());
        assert_eq!(projection.unsectioned[0].thread_id, "wrong-section");
        assert!(
            client
                .mock_requests()
                .await
                .iter()
                .all(|(method, _)| method != "thread/section/move")
        );
    }

    #[tokio::test]
    async fn section_list_failure_keeps_every_managed_task_in_recovery() {
        let (root, sections, store) = fixture();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        claim(&store, "recoverable", 10_000);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::error("threadSection/list", CodexThreadError::ProcessUnavailable),
            MockCodexResponse::ok_for(
                "thread/list",
                global_thread_list_params(None),
                thread_page(vec![thread("recoverable", &project, 10.0)], None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                archived_thread_list_params(None),
                thread_page(Vec::new(), None),
            ),
        ]);

        let projection = sections.load(&client).await.expect("recovery projection");
        assert!(projection.sections.is_empty());
        assert_eq!(projection.unsectioned[0].thread_id, "recoverable");
        assert!(projection.unsectioned[0].conversation_available);
        assert!(store.get("recoverable").unwrap().is_some());
    }

    #[tokio::test]
    async fn archived_managed_task_is_typed_recovery_and_follows_archived_cursors() {
        let (root, sections, store) = fixture();
        let project = root.path().join("project");
        std::fs::create_dir(&project).unwrap();
        claim(&store, "archived-managed", 10_000);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                global_thread_list_params(None),
                thread_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                archived_thread_list_params(None),
                thread_page(
                    vec![thread("unrelated-archived", &project, 20.0)],
                    Some("archived-2"),
                ),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                archived_thread_list_params(Some("archived-2")),
                thread_page(vec![thread("archived-managed", &project, 10.0)], None),
            ),
        ]);

        let projection = sections.load(&client).await.expect("recovery projection");
        assert!(projection.sections.is_empty());
        assert_eq!(projection.unsectioned.len(), 1);
        let recovery = &projection.unsectioned[0];
        assert_eq!(recovery.thread_id, "archived-managed");
        assert_eq!(
            recovery.recovery.reason,
            ActiveTaskRecoveryReason::CodexArchived
        );
        assert_eq!(
            recovery.recovery.actions,
            [
                ActiveTaskRecoveryAction::RestoreToActive,
                ActiveTaskRecoveryAction::MoveToArchived,
                ActiveTaskRecoveryAction::Recheck,
            ]
        );
        assert!(!recovery.conversation_available);
        assert_eq!(recovery.preview, "Task archived-managed");
        assert!(store.get("archived-managed").unwrap().is_some());
        assert!(client.mock_requests().await.iter().any(|(method, params)| {
            method == "thread/list" && params == &archived_thread_list_params(Some("archived-2"))
        }));
    }

    #[tokio::test]
    async fn task_absent_from_active_and_archived_codex_lists_can_be_removed() {
        let (_root, sections, store) = fixture();
        claim(&store, "missing-managed", 10_000);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "threadSection/list",
                section_list_params(None),
                section_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                thread_list_params(None, None, CODEX_SECTION_PAGE_SIZE),
                thread_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                global_thread_list_params(None),
                thread_page(Vec::new(), None),
            ),
            MockCodexResponse::ok_for(
                "thread/list",
                archived_thread_list_params(None),
                thread_page(Vec::new(), None),
            ),
        ]);

        let projection = sections.load(&client).await.expect("recovery projection");
        assert!(projection.sections.is_empty());
        let recovery = &projection.unsectioned[0];
        assert_eq!(recovery.thread_id, "missing-managed");
        assert_eq!(
            recovery.recovery.reason,
            ActiveTaskRecoveryReason::ThreadMissing
        );
        assert_eq!(
            recovery.recovery.actions,
            [
                ActiveTaskRecoveryAction::Recheck,
                ActiveTaskRecoveryAction::RemoveFromCaffold,
            ]
        );
        assert!(store.get("missing-managed").unwrap().is_some());
    }
}
