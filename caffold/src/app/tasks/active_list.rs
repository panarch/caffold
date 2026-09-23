use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

use serde::Serialize;

use crate::{
    agent::{
        ThreadStatus,
        claude::ClaudeClient,
        codex::{CodexThread, CodexThreadClient},
        grok::GrokClient,
    },
    app::error::ApiError,
    app::tasks::sessions::TaskSessions,
    fs::RootedFs,
    task_store::{
        ComposerSettings, ManagedSection, ManagedThread, ManagedWorktree, ManagedWorktreeState,
        RunBy, TaskStore,
    },
};

use super::{
    TaskRecord,
    recovery::{ActiveTaskRecovery, ActiveTaskRecoveryReason},
};
use crate::agent::Conversation;
use crate::git;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) struct ActiveTaskSection {
    pub(in crate::app::tasks) id: String,
    pub(in crate::app::tasks) name: String,
    pub(in crate::app::tasks) repository: bool,
    pub(in crate::app::tasks) composer_settings: Option<ActiveTaskComposerSettings>,
    pub(in crate::app::tasks) tasks: Vec<ActiveTask>,
}

/// A Task as the Active list shows it.
///
/// The list reads nothing else from a Task, so nothing else is sent to it.
/// Task Detail reads its own [`TaskRecord`] when a Task opens.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTask {
    pub(in crate::app::tasks) thread_id: String,
    pub(in crate::app::tasks) title: String,
    pub(in crate::app::tasks) thread_status: ThreadStatus,
    pub(in crate::app::tasks) unseen: bool,
    pub(in crate::app::tasks) last_completed_ms: Option<u64>,
    pub(in crate::app::tasks) recency_ms: Option<u64>,
    pub(in crate::app::tasks) updated_ms: u64,
    /// Whether the Task runs in a worktree Caffold made for it.
    pub(in crate::app::tasks) worktree: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) struct ActiveTaskComposerSettings {
    pub(in crate::app::tasks) model: Option<String>,
    pub(in crate::app::tasks) effort: Option<String>,
    pub(in crate::app::tasks) fast_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app::tasks) permission_mode: Option<String>,
}

impl From<&ComposerSettings> for ActiveTaskComposerSettings {
    fn from(settings: &ComposerSettings) -> Self {
        Self {
            model: settings.model.clone(),
            effort: settings.reasoning_effort.clone(),
            fast_mode: settings.fast_mode,
            permission_mode: settings.permission_mode.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app::tasks) struct ActiveTaskProjection {
    pub(in crate::app::tasks) sections: Vec<ActiveTaskSection>,
    pub(in crate::app::tasks) unsectioned: Vec<ActiveTaskRecovery>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ActiveTaskRuntimeSnapshot {
    pub(in crate::app::tasks) tasks: Vec<ActiveTask>,
}

pub(in crate::app::tasks) struct ActiveTaskRuntimeProjection {
    pub(in crate::app::tasks) snapshot: ActiveTaskRuntimeSnapshot,
    pub(in crate::app::tasks) observed_threads: Vec<CodexThread>,
}

impl ActiveTaskProjection {
    fn empty() -> Self {
        Self {
            sections: Vec::new(),
            unsectioned: Vec::new(),
        }
    }
}

pub(in crate::app::tasks) async fn load_cached(
    fs: Arc<RootedFs>,
    store: TaskStore,
) -> Result<ActiveTaskProjection, ApiError> {
    let (stored_sections, active_threads, worktrees) = tokio::task::spawn_blocking(move || {
        store.read(|tables| {
            Ok((
                tables.managed_sections()?,
                tables.active_managed_threads()?,
                tables.managed_worktrees()?,
            ))
        })
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
    let isolated = tasks_in_managed_worktrees(&worktrees);
    let stored_task = |managed: &ManagedThread| {
        ActiveTask::stored(managed, isolated.contains(managed.thread_id.as_str()))
    };
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
                stored_task(&managed),
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
                composer_settings: section
                    .last_composer_settings
                    .as_ref()
                    .map(ActiveTaskComposerSettings::from),
                tasks: threads.iter().map(&stored_task).collect(),
            })
        })
        .collect::<Vec<_>>();
    recovery.sort_by(|left, right| {
        right
            .activity_ms()
            .cmp(&left.activity_ms())
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    Ok(ActiveTaskProjection {
        sections: projected_sections,
        unsectioned: recovery,
    })
}

pub(in crate::app::tasks) async fn load_runtime_snapshot(
    store: TaskStore,
    sessions: &TaskSessions,
    generation: u64,
    client: &CodexThreadClient,
    claude: &ClaudeClient,
    grok: &GrokClient,
) -> Result<ActiveTaskRuntimeProjection, ApiError> {
    let (managed, worktrees) = tokio::task::spawn_blocking(move || {
        store.read(|tables| {
            Ok((
                tables.active_managed_threads()?,
                tables.managed_worktrees()?,
            ))
        })
    })
    .await
    .map_err(|error| ApiError::Internal(format!("task store worker failed: {error}")))?
    .map_err(|error| ApiError::Internal(error.to_string()))?;
    let managed = managed
        .into_iter()
        .map(|thread| (thread.thread_id.clone(), thread))
        .collect::<BTreeMap<_, _>>();
    if managed.is_empty() {
        return Ok(ActiveTaskRuntimeProjection {
            snapshot: ActiveTaskRuntimeSnapshot { tasks: Vec::new() },
            observed_threads: Vec::new(),
        });
    }
    for managed in managed.values() {
        // Codex's bookkeeping, for Codex's threads. A Claude session counts
        // its connections as one fixed generation of its own, and Codex's
        // count must not be stamped over it.
        if matches!(managed.run_by, RunBy::Codex) {
            sessions
                .track_listed_codex_thread(generation, &managed.thread_id)
                .await;
        }
    }

    let isolated = tasks_in_managed_worktrees(&worktrees);
    let observed_task = |managed: &ManagedThread, conversation: &Conversation| {
        ActiveTask::observed(
            managed,
            conversation,
            isolated.contains(managed.thread_id.as_str()),
        )
    };
    let mut tasks = Vec::new();
    let mut observed_threads = Vec::new();
    for thread in super::recovery::list_all_global_threads(client).await? {
        let Some(managed) = managed.get(&thread.id) else {
            continue;
        };
        tasks.push(observed_task(managed, &Conversation::from(&thread)));
        observed_threads.push(thread);
    }
    // Codex answers for every thread it has in one list. Claude has no list to
    // ask for, and is not asked for one: what it has is the conversations being
    // watched — the runner's live sessions are taken up when this process
    // starts, and viewers hold the rest. A conversation nobody is watching is
    // not doing anything, so the stored row a person sees instead of these is
    // not hiding anything live.
    for managed in managed.values() {
        let conversation = match &managed.run_by {
            RunBy::Codex => continue,
            RunBy::Claude { .. } => claude.watched_conversation(&managed.thread_id).await,
            // Grok's leader holds every session, but only the ones this
            // process has loaded are being watched; the rest are described
            // from their rows, like Claude's.
            RunBy::Grok { .. } => grok.watched_conversation(&managed.thread_id).await,
        };
        let Some(conversation) = conversation else {
            continue;
        };
        tasks.push(observed_task(managed, &conversation));
    }
    tasks.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    observed_threads.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(ActiveTaskRuntimeProjection {
        snapshot: ActiveTaskRuntimeSnapshot { tasks },
        observed_threads,
    })
}

impl ActiveTask {
    /// A Task as its row describes it, before any agent has answered for it.
    pub(in crate::app::tasks) fn stored(managed: &ManagedThread, worktree: bool) -> Self {
        let activity_ms = managed
            .last_observed_recency_ms
            .unwrap_or(managed.claimed_at_ms);
        Self {
            thread_id: managed.thread_id.clone(),
            title: managed.display_name.clone(),
            thread_status: ThreadStatus::NotLoaded,
            unseen: managed.unseen(),
            last_completed_ms: managed.last_completed_at_ms,
            recency_ms: Some(activity_ms),
            updated_ms: activity_ms,
            worktree,
        }
    }

    /// A Task as its agent reports it now, named and marked by its row.
    fn observed(managed: &ManagedThread, conversation: &Conversation, worktree: bool) -> Self {
        Self {
            thread_id: managed.thread_id.clone(),
            title: managed.display_name.clone(),
            thread_status: conversation.status.clone(),
            unseen: managed.unseen(),
            last_completed_ms: managed.last_completed_at_ms,
            recency_ms: conversation.recency_at_ms,
            updated_ms: conversation.updated_at_ms,
            worktree,
        }
    }

    /// The Active-list view of a Task record built for Task Detail or for a
    /// Task mutation.
    pub(in crate::app::tasks) fn of(task: &TaskRecord, worktree: bool) -> Self {
        Self {
            thread_id: task.thread_id.clone(),
            title: task.title.clone(),
            thread_status: task.thread_status.clone(),
            unseen: task.unseen,
            last_completed_ms: task.last_completed_ms,
            recency_ms: task.recency_ms,
            updated_ms: task.updated_ms,
            worktree,
        }
    }

    fn activity_ms(&self) -> u64 {
        self.recency_ms.unwrap_or(self.updated_ms)
    }
}

/// Whether a managed worktree record puts its Task in a worktree Caffold made.
///
/// Only a ready record does. A worktree made outside Caffold has no record, so
/// it never counts.
pub(in crate::app::tasks) fn isolates_task(worktree: &ManagedWorktree) -> bool {
    worktree.state == ManagedWorktreeState::Ready
}

/// Whether one Task runs in a worktree Caffold made, read from its record.
pub(in crate::app::tasks) async fn runs_in_managed_worktree(
    store: &TaskStore,
    thread_id: &str,
) -> Result<bool, ApiError> {
    let store = store.clone();
    let thread_id = thread_id.to_string();
    let worktree = tokio::task::spawn_blocking(move || store.worktree_for_thread(&thread_id))
        .await
        .map_err(|error| ApiError::Internal(format!("task store worker failed: {error}")))?
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    Ok(worktree.as_ref().is_some_and(isolates_task))
}

fn tasks_in_managed_worktrees(worktrees: &[ManagedWorktree]) -> HashSet<&str> {
    worktrees
        .iter()
        .filter(|worktree| isolates_task(worktree))
        .filter_map(|worktree| worktree.thread_id.as_deref())
        .collect()
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
                    .and_then(|path| git::repository_for(&path))
                    .map(|_| section_id)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent;
    use crate::agent::codex::MockCodexResponse;
    use crate::app::tasks::{recovery, sessions, test_support::record_managed_worktree};
    use crate::task_store::RunBy;

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
                    last_composer_settings: None,
                };
                tables.upsert_managed_section(&section)?;
                tables.claim_managed_thread_at_top(
                    ManagedThread::new(thread_id, RunBy::Codex, Some(recency_ms), None, None),
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

    /// A Claude client watching one conversation the stand-in already greeted.
    async fn watching_a_claude_conversation(thread_id: &str, cwd: &str) -> ClaudeClient {
        let (claude, runner) = agent::claude::ClaudeClient::mock();
        runner
            .greet_next_session_with(vec![serde_json::json!({
                "type": "system",
                "subtype": "init",
                "session_id": thread_id,
                "cwd": cwd,
                "model": "claude-opus-5",
                "permissionMode": "default",
                "claude_code_version": "9.9.9",
            })])
            .await;
        claude
            .open_conversation(thread_id, cwd, &Default::default())
            .await
            .expect("the conversation opens");
        claude
    }

    fn an_empty_codex() -> CodexThreadClient {
        CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/list",
            serde_json::json!({ "data": [], "nextCursor": null, "backwardsCursor": null }),
        )])
    }

    #[tokio::test]
    async fn runtime_snapshot_shows_a_claude_conversation_somebody_is_watching() {
        // The list is drawn from this snapshot, and Codex's thread list is only
        // Codex's answer. A working Claude Task left out of it reads as nothing
        // for exactly as long as it is working — the one stretch a person is
        // deciding whether it needs them.
        let store = TaskStore::memory().unwrap();
        let cwd = "/Users/example/project";
        store
            .claim(
                ManagedThread::new(
                    "claude-1",
                    RunBy::Claude {
                        cwd: cwd.to_string(),
                    },
                    Some(500),
                    None,
                    None,
                ),
                500,
            )
            .unwrap();
        let claude = watching_a_claude_conversation("claude-1", cwd).await;
        claude
            .start_turn("claude-1", "keep going", &[], &Default::default())
            .await
            .expect("the turn starts");

        let projection = load_runtime_snapshot(
            store,
            &sessions::TaskSessions::default(),
            1,
            &an_empty_codex(),
            &claude,
            &agent::grok::GrokClient::unreachable(),
        )
        .await
        .unwrap();

        let row = projection
            .snapshot
            .tasks
            .iter()
            .find(|task| task.thread_id == "claude-1")
            .expect("the watched conversation is a row");
        assert_eq!(
            row.thread_status,
            ThreadStatus::Active {
                active_flags: Vec::new(),
            }
        );
    }

    #[tokio::test]
    async fn a_list_load_on_a_newer_codex_connection_leaves_claude_sessions_alone() {
        // Generations are Codex's count of its own connections; the listing
        // bookkeeping stamps them onto the threads it lists. A Claude session
        // carries the one fixed generation its kind stands for, and a startup
        // take-up holds no lease — so stamping it with Codex's count would wipe
        // it on the first list load after a Codex restart, and every report it
        // makes afterwards would be dropped as belonging to an old connection.
        let store = TaskStore::memory().unwrap();
        let cwd = "/Users/example/project";
        store
            .claim(
                ManagedThread::new(
                    "claude-1",
                    RunBy::Claude {
                        cwd: cwd.to_string(),
                    },
                    Some(500),
                    None,
                    None,
                ),
                500,
            )
            .unwrap();
        let claude = watching_a_claude_conversation("claude-1", cwd).await;
        let sessions = sessions::TaskSessions::default();
        sessions
            .ensure_subscribed(&claude.driver(cwd), 1, "claude-1")
            .await
            .expect("the Claude session subscribes on its own generation");

        // Codex has restarted: its connection count moved past Claude's fixed
        // generation, and the list is loaded again.
        let projection = load_runtime_snapshot(
            store,
            &sessions,
            2,
            &an_empty_codex(),
            &claude,
            &agent::grok::GrokClient::unreachable(),
        )
        .await
        .unwrap();

        assert!(
            projection
                .snapshot
                .tasks
                .iter()
                .any(|task| task.thread_id == "claude-1"),
            "the watched conversation is still a row"
        );
        let snapshot = sessions
            .snapshot("claude-1")
            .await
            .expect("the session is still known");
        assert_eq!(
            snapshot.lifecycle,
            sessions::SessionLifecycle::Subscribed,
            "and was not swept by Codex's count"
        );
        assert_eq!(snapshot.generation, 1, "its own generation, not Codex's");
    }

    #[tokio::test]
    async fn runtime_snapshot_leaves_an_unwatched_claude_task_to_its_stored_row() {
        // A conversation nobody is watching is not doing anything — the agent
        // only works while a turn runs, and a turn only runs on a session — so
        // the stored row stands, and nothing is started to improve on it.
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new(
                    "claude-quiet",
                    RunBy::Claude {
                        cwd: "/Users/example/project".to_string(),
                    },
                    Some(500),
                    None,
                    None,
                ),
                500,
            )
            .unwrap();
        let (claude, _runner) = agent::claude::ClaudeClient::mock();

        let projection = load_runtime_snapshot(
            store,
            &sessions::TaskSessions::default(),
            1,
            &an_empty_codex(),
            &claude,
            &agent::grok::GrokClient::unreachable(),
        )
        .await
        .unwrap();

        assert!(
            projection.snapshot.tasks.is_empty(),
            "nothing live to say: {:?}",
            projection.snapshot.tasks
        );
    }

    #[tokio::test]
    async fn runtime_snapshot_marks_a_task_from_its_managed_worktree_record_alone() {
        // The record is Caffold's own account of the worktree it made, so the
        // mark needs no look at the directory, which here does not exist.
        let store = TaskStore::memory().unwrap();
        let cwd = "/Users/example/project";
        store
            .claim(
                ManagedThread::new(
                    "claude-isolated",
                    RunBy::Claude {
                        cwd: cwd.to_string(),
                    },
                    Some(500),
                    None,
                    None,
                ),
                500,
            )
            .unwrap();
        record_managed_worktree(&store, "claude-isolated", ManagedWorktreeState::Ready);
        let claude = watching_a_claude_conversation("claude-isolated", cwd).await;

        let projection = load_runtime_snapshot(
            store,
            &sessions::TaskSessions::default(),
            1,
            &an_empty_codex(),
            &claude,
            &agent::grok::GrokClient::unreachable(),
        )
        .await
        .unwrap();

        let row = projection
            .snapshot
            .tasks
            .iter()
            .find(|task| task.thread_id == "claude-isolated")
            .expect("the watched conversation is a row");
        assert!(row.worktree);
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
        store
            .transaction(|tables| {
                tables.update_managed_section_composer_settings(
                    "section-b",
                    &ComposerSettings {
                        model: Some("gpt-section".to_string()),
                        reasoning_effort: Some("xhigh".to_string()),
                        fast_mode: true,
                        permission_mode: None,
                    },
                )?;
                Ok(())
            })
            .unwrap();

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
        assert_eq!(
            projection.sections[0].composer_settings,
            Some(ActiveTaskComposerSettings {
                model: Some("gpt-section".to_string()),
                effort: Some("xhigh".to_string()),
                fast_mode: true,
                permission_mode: None,
            })
        );
        assert_eq!(projection.sections[1].composer_settings, None);
        assert!(
            projection
                .sections
                .iter()
                .flat_map(|section| &section.tasks)
                .all(|task| task.thread_status == ThreadStatus::NotLoaded)
        );
    }

    #[tokio::test]
    async fn cached_projection_keeps_unplaced_rows_visible_for_explicit_recovery() {
        let (_root, fs, store) = fixture();
        store
            .claim(
                ManagedThread::new("unplaced", RunBy::Codex, Some(500), None, None),
                500,
            )
            .unwrap();

        let projection = load_cached(fs, store).await.unwrap();

        assert!(projection.sections.is_empty());
        assert_eq!(projection.unsectioned.len(), 1);
        assert_eq!(projection.unsectioned[0].title, "Thread unplaced");
        assert_eq!(
            projection.unsectioned[0].recovery.actions,
            [
                recovery::ActiveTaskRecoveryAction::RestoreToActive,
                recovery::ActiveTaskRecoveryAction::Recheck,
            ]
        );
    }

    #[tokio::test]
    async fn cached_projection_marks_only_tasks_whose_managed_worktree_is_ready() {
        let (_root, fs, store) = fixture();
        claim_at_top(&store, "isolated", "Isolated", 300, "section-a", "a", 0);
        claim_at_top(&store, "isolating", "Isolating", 200, "section-a", "a", 0);
        claim_at_top(&store, "plain", "Plain", 100, "section-a", "a", 0);
        store
            .claim(
                ManagedThread::new("unplaced", RunBy::Codex, Some(50), None, None),
                50,
            )
            .unwrap();
        record_managed_worktree(&store, "isolated", ManagedWorktreeState::Ready);
        record_managed_worktree(&store, "isolating", ManagedWorktreeState::Creating);
        record_managed_worktree(&store, "unplaced", ManagedWorktreeState::Ready);

        let projection = load_cached(fs, store).await.unwrap();

        let marked = |thread_id: &str| {
            projection
                .sections
                .iter()
                .flat_map(|section| &section.tasks)
                .chain(projection.unsectioned.iter().map(|recovery| &recovery.task))
                .find(|task| task.thread_id == thread_id)
                .unwrap_or_else(|| panic!("{thread_id} is listed"))
                .worktree
        };
        assert!(marked("isolated"));
        assert!(
            !marked("isolating"),
            "a worktree still being made does not hold the Task yet"
        );
        assert!(!marked("plain"));
        assert!(
            marked("unplaced"),
            "a row waiting for recovery carries the same mark"
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
