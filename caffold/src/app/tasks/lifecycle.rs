use std::{path::PathBuf, sync::Arc};

use serde::Serialize;
use uuid::Uuid;

use crate::{
    agent::TurnOptions,
    agent::codex::CodexThreadClient,
    app::error::ApiError,
    app::tasks::sessions::{StartedSettings, TaskSessions},
    fs::RootedFs,
    task_store::{ComposerSettings, ManagedThread, TaskStore, TaskStoreError},
};

use super::{
    CodexConnection, TaskRecord,
    composer_settings::persist_started_turn_composer_settings,
    events::{TaskEvents, accepted_user_message_event, now_ms},
    projection::{resolve_conversation_cwd, task_activity_ms, task_record_from_conversation},
    routes::TaskListEvents,
    worktrees::{
        ArchiveOutcome, IsolateOutcome, ManagedWorktreeError, ManagedWorktrees, RestoreOutcome,
    },
};

mod initial_request_name;

pub(in crate::app) struct StartTask {
    pub(in crate::app) cwd: String,
    pub(in crate::app) prompt: String,
    pub(in crate::app) images: Vec<String>,
    pub(in crate::app) turn_options: TurnOptions,
    pub(in crate::app) initial_name: Option<String>,
}

pub(in crate::app) struct StartedTask {
    pub(in crate::app) task: TaskRecord,
    pub(in crate::app) placement: ActiveTaskTopPlacement,
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
    pub(in crate::app) before_section_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(in crate::app) before_thread_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TaskSectionIdentity {
    logical_path: String,
    repository: bool,
}

enum LocalPlacementMutation {
    Claim {
        thread: Box<ManagedThread>,
        display_name: String,
    },
    Place,
    Restore,
}

#[derive(Clone)]
pub(in crate::app) struct TaskLifecycle {
    fs: Arc<RootedFs>,
    sessions: TaskSessions,
    events: TaskEvents,
    list_events: TaskListEvents,
    store: TaskStore,
    worktrees: ManagedWorktrees,
}

impl TaskLifecycle {
    pub(in crate::app) fn new(
        fs: Arc<RootedFs>,
        sessions: TaskSessions,
        events: TaskEvents,
        list_events: TaskListEvents,
        store: TaskStore,
        worktrees: ManagedWorktrees,
    ) -> Self {
        Self {
            fs,
            sessions,
            events,
            list_events,
            store,
            worktrees,
        }
    }

    pub(in crate::app) async fn start_task(
        &self,
        connection: &CodexConnection,
        request: StartTask,
    ) -> Result<StartedTask, ApiError> {
        let StartTask {
            cwd,
            prompt,
            images,
            turn_options,
            initial_name,
        } = request;
        let requested_fast_mode = turn_options.fast_mode;
        let client = &connection.client;
        let driver = connection.driver();
        // The agent agrees to the options first: a model it never had would
        // otherwise leave a conversation behind before anyone found out.
        let accepted = driver.accept_turn_options(&turn_options).await?;
        let mut started = driver.start_conversation(&cwd, &accepted).await?;
        let conversation_id = started.conversation.id.clone();
        let initial_name = initial_name
            .or_else(|| initial_request_name::from_prompt(&prompt))
            .unwrap_or_else(|| format!("Thread {}", short_thread_id(&conversation_id)));
        // Keep the app-server's canonical Thread name aligned with the name
        // Caffold persists in its navigator ledger.
        if let Err(error) = client
            .set_thread_name(&conversation_id, &initial_name)
            .await
        {
            self.rollback_unclaimed_thread(client, &conversation_id)
                .await;
            return Err(error.into());
        }
        started.conversation.title = Some(initial_name);
        // What the person asked for stands where they asked for something, and
        // what the agent settled on fills the rest.
        let settled = TurnOptions {
            model: turn_options.model.clone().or(started.settings.model),
            effort: turn_options.effort.clone().or(started.settings.effort),
            fast_mode: requested_fast_mode,
            permission_mode: turn_options
                .permission_mode
                .clone()
                .or(started.settings.permission_mode),
        };
        let effective_model = settled.model.clone();
        let effective_reasoning_effort = settled.effort.clone();
        let task = match self.record_from_conversation(&started.conversation) {
            Ok(task) => task,
            Err(error) => {
                self.rollback_unclaimed_thread(client, &conversation_id)
                    .await;
                return Err(error);
            }
        };
        let placement = match self
            .claim_at_top(
                managed_thread_from_task_record(
                    &task,
                    effective_model.clone(),
                    effective_reasoning_effort.clone(),
                    requested_fast_mode,
                ),
                &task.title,
                &task,
            )
            .await
        {
            Ok(placement) => placement,
            Err(error) => {
                self.rollback_unclaimed_thread(client, &conversation_id)
                    .await;
                return Err(error);
            }
        };

        self.list_events.place(task.clone(), placement.clone());
        self.sessions
            .register_started_thread(
                &connection.driver(),
                connection.generation,
                started.conversation.clone(),
                StartedSettings {
                    permission_mode: settled.permission_mode.clone(),
                    model: settled.model.clone(),
                    reasoning_effort: settled.effort.clone(),
                    fast_mode: settled.fast_mode,
                },
            )
            .await;
        let turn = match driver
            .start_turn(&conversation_id, &cwd, &prompt, &images, &accepted)
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                self.sessions.cancel_runtime(&conversation_id).await;
                return Err(error.into());
            }
        };
        self.sessions
            .record_turn_started(
                connection.generation,
                &conversation_id,
                Some(&cwd),
                turn.turn.clone(),
                turn.applied.clone(),
            )
            .await;
        if let Err(error) = self
            .update_composer_settings(
                &conversation_id,
                effective_model.as_deref(),
                effective_reasoning_effort.as_deref(),
                requested_fast_mode,
            )
            .await
        {
            eprintln!(
                "failed to persist composer settings for started thread {}: {error:?}",
                conversation_id
            );
        }
        self.events.publish(accepted_user_message_event(
            &conversation_id,
            &turn.turn.id,
            &prompt,
            &images,
        ));
        Ok(StartedTask { task, placement })
    }

    pub(in crate::app) async fn place_active_task(
        &self,
        task: &TaskRecord,
    ) -> Result<Option<ActiveTaskTopPlacement>, ApiError> {
        self.mutate_local_placement(task, LocalPlacementMutation::Place)
            .await
    }

    pub(in crate::app) async fn restore_active_task(
        &self,
        task: &TaskRecord,
    ) -> Result<Option<ActiveTaskTopPlacement>, ApiError> {
        self.mutate_local_placement(task, LocalPlacementMutation::Restore)
            .await
    }

    pub(in crate::app) async fn isolate_current_task(
        &self,
        source: PathBuf,
        thread_id: String,
        task_name: String,
        branch_name: Option<String>,
        base_ref: Option<String>,
        include_changes: bool,
    ) -> Result<IsolateOutcome, ApiError> {
        let source = source.canonicalize().map_err(|error| {
            ApiError::Internal(format!(
                "failed to resolve source task directory {}: {error}",
                source.display()
            ))
        })?;
        self.fs.logical_path_for_absolute(&source)?;
        self.worktrees
            .isolate_current(
                source,
                thread_id,
                task_name,
                branch_name,
                base_ref,
                include_changes,
            )
            .await
            .map_err(worktree_api_error)
    }

    pub(in crate::app) async fn archive_worktree(
        &self,
        thread_id: String,
    ) -> Result<ArchiveOutcome, ApiError> {
        self.worktrees
            .archive_for_thread(thread_id)
            .await
            .map_err(worktree_api_error)
    }

    pub(in crate::app) async fn preflight_archive_worktree(
        &self,
        thread_id: String,
    ) -> Result<(), ApiError> {
        self.worktrees
            .preflight_archive_for_thread(thread_id)
            .await
            .map_err(worktree_api_error)
    }

    pub(in crate::app) async fn restore_worktree(
        &self,
        thread_id: String,
    ) -> Result<RestoreOutcome, ApiError> {
        self.worktrees
            .restore_for_thread(thread_id)
            .await
            .map_err(worktree_api_error)
    }

    pub(in crate::app) async fn rollback_archived_worktree(
        &self,
        thread_id: &str,
        outcome: &ArchiveOutcome,
    ) {
        if matches!(outcome, ArchiveOutcome::Archived(_))
            && let Err(error) = self.restore_worktree(thread_id.to_string()).await
        {
            eprintln!("failed to restore managed worktree while rolling back archive: {error}");
        }
    }

    pub(in crate::app) async fn rollback_restored_worktree(
        &self,
        thread_id: &str,
        outcome: &RestoreOutcome,
    ) {
        if matches!(outcome, RestoreOutcome::Restored(_))
            && let Err(error) = self.archive_worktree(thread_id.to_string()).await
        {
            eprintln!("failed to remove managed worktree while rolling back restore: {error}");
        }
    }

    pub(in crate::app) async fn delete_task_resources(&self, thread_id: &str) {
        self.sessions.forget_thread(thread_id).await;
        self.events.remove_thread(thread_id);
    }

    fn record_from_conversation(
        &self,
        conversation: &crate::agent::Conversation,
    ) -> Result<TaskRecord, ApiError> {
        let resolved = resolve_conversation_cwd(&self.fs, conversation);
        Ok(task_record_from_conversation(
            conversation,
            &[],
            resolved.as_ref(),
        ))
    }

    async fn claim_at_top(
        &self,
        thread: ManagedThread,
        display_name: &str,
        task: &TaskRecord,
    ) -> Result<ActiveTaskTopPlacement, ApiError> {
        self.mutate_local_placement(
            task,
            LocalPlacementMutation::Claim {
                thread: Box::new(thread),
                display_name: display_name.to_string(),
            },
        )
        .await?
        .ok_or_else(|| ApiError::Internal("claimed Task was not persisted".to_string()))
    }

    async fn mutate_local_placement(
        &self,
        task: &TaskRecord,
        mutation: LocalPlacementMutation,
    ) -> Result<Option<ActiveTaskTopPlacement>, ApiError> {
        let identity = task_section_identity(task).ok_or_else(|| {
            ApiError::Internal(format!(
                "failed to resolve the active Section path for Task {}",
                task.thread_id
            ))
        })?;
        let store = self.store.clone();
        let thread_id = task.thread_id.clone();
        let result = tokio::task::spawn_blocking(move || {
            store.transaction(|tables| {
                let section = match tables
                    .managed_sections()?
                    .into_iter()
                    .find(|section| section.logical_path == identity.logical_path)
                {
                    Some(section) => section,
                    None => tables.insert_managed_section_at_top(
                        &Uuid::new_v4().to_string(),
                        &identity.logical_path,
                    )?,
                };
                let before_thread_id = tables
                    .active_managed_threads()?
                    .into_iter()
                    .filter(|thread| {
                        thread.thread_id != thread_id
                            && thread.section_id.as_deref() == Some(&section.section_id)
                    })
                    .min_by(|left, right| {
                        left.position_in_section
                            .cmp(&right.position_in_section)
                            .then_with(|| left.thread_id.cmp(&right.thread_id))
                    })
                    .map(|thread| thread.thread_id);
                let managed = match mutation {
                    LocalPlacementMutation::Claim {
                        thread,
                        display_name,
                    } => Some(tables.claim_managed_thread_at_top(
                        *thread,
                        &display_name,
                        &section.section_id,
                        now_ms(),
                    )?),
                    LocalPlacementMutation::Place => {
                        tables.place_managed_thread_at_top(&thread_id, &section.section_id)?
                    }
                    LocalPlacementMutation::Restore => {
                        tables.restore_managed_thread_at_top(&thread_id, &section.section_id)?
                    }
                };
                let Some(_) = managed else {
                    return Ok(None);
                };
                let active_section_ids = tables
                    .active_managed_threads()?
                    .into_iter()
                    .filter_map(|thread| thread.section_id)
                    .collect::<std::collections::HashSet<_>>();
                let ordered_sections = tables.managed_sections()?;
                let section_index = ordered_sections
                    .iter()
                    .position(|candidate| candidate.section_id == section.section_id)
                    .ok_or(TaskStoreError::UnexpectedPayload)?;
                let before_section_id = ordered_sections
                    .into_iter()
                    .skip(section_index + 1)
                    .find(|candidate| active_section_ids.contains(&candidate.section_id))
                    .map(|candidate| candidate.section_id);
                Ok(Some(ActiveTaskTopPlacement {
                    section: ActiveTaskSectionIdentity {
                        id: section.section_id,
                        name: section.logical_path,
                        repository: identity.repository,
                    },
                    before_section_id,
                    before_thread_id,
                }))
            })
        })
        .await
        .map_err(task_store_worker_error)?;
        result.map_err(|error| ApiError::Internal(error.to_string()))
    }

    pub(in crate::app) fn refresh_task_list(&self) {
        self.list_events.refresh();
    }

    async fn update_composer_settings(
        &self,
        thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
        fast_mode: bool,
    ) -> Result<(), ApiError> {
        let persisted = persist_started_turn_composer_settings(
            self.store.clone(),
            thread_id,
            ComposerSettings {
                model: model.map(str::to_string),
                reasoning_effort: reasoning_effort.map(str::to_string),
                fast_mode,
            },
        )
        .await?;
        if let Some(section) = persisted.and_then(|persisted| persisted.section) {
            self.list_events.section_composer_settings(&section);
        }
        Ok(())
    }

    async fn rollback_unclaimed_thread(&self, client: &CodexThreadClient, thread_id: &str) {
        match client.archive_thread(thread_id).await {
            Ok(_) => {}
            Err(error) => {
                eprintln!("failed to archive an unclaimed Codex thread: {error}");
            }
        }
    }
}

fn task_section_identity(task: &TaskRecord) -> Option<TaskSectionIdentity> {
    if let Some(worktree) = &task.worktree {
        return Some(TaskSectionIdentity {
            logical_path: worktree.repository_root_path.clone(),
            repository: true,
        });
    }
    task.cwd_path.as_ref().map(|cwd_path| TaskSectionIdentity {
        logical_path: cwd_path.clone(),
        repository: false,
    })
}

fn short_thread_id(thread_id: &str) -> &str {
    thread_id.get(..8).unwrap_or(thread_id)
}

fn managed_thread_from_task_record(
    task: &TaskRecord,
    model: Option<String>,
    reasoning_effort: Option<String>,
    fast_mode: bool,
) -> ManagedThread {
    let mut managed = ManagedThread::new(
        task.thread_id.clone(),
        Some(task_activity_ms(task)),
        model,
        reasoning_effort,
    );
    managed.fast_mode = fast_mode;
    managed.last_completed_at_ms = task.last_completed_ms;
    managed
}

pub(in crate::app) fn worktree_api_error(error: ManagedWorktreeError) -> ApiError {
    match error {
        ManagedWorktreeError::Git(crate::git::WorktreeError::Dirty(_)) => ApiError::BadRequest {
            code: "managed_worktree_dirty",
            message: error.to_string(),
        },
        ManagedWorktreeError::Git(crate::git::WorktreeError::InvalidBranch(_))
        | ManagedWorktreeError::Git(crate::git::WorktreeError::BranchAlreadyExists(_))
        | ManagedWorktreeError::Git(crate::git::WorktreeError::TargetExists(_))
        | ManagedWorktreeError::Git(crate::git::WorktreeError::LinkedSource(_))
        | ManagedWorktreeError::Git(crate::git::WorktreeError::UnresolvedOperation(_))
        | ManagedWorktreeError::Git(crate::git::WorktreeError::DirtySubmodule(_))
        | ManagedWorktreeError::Git(crate::git::WorktreeError::BaseRefWithChanges)
        | ManagedWorktreeError::Git(crate::git::WorktreeError::DirtyBranchRequiresTransfer {
            ..
        })
        | ManagedWorktreeError::Git(crate::git::WorktreeError::CurrentBranchConflict { .. }) => {
            ApiError::BadRequest {
                code: "managed_worktree_invalid",
                message: error.to_string(),
            }
        }
        error => ApiError::Internal(error.to_string()),
    }
}

fn task_store_worker_error(error: tokio::task::JoinError) -> ApiError {
    ApiError::Internal(format!("task store worker failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        app::tasks::sessions::TaskSessions,
        task_store::{ManagedWorktreeState, TaskStore},
    };

    fn fixture() -> (tempfile::TempDir, TaskLifecycle) {
        let root = tempfile::tempdir().unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        let worktrees = ManagedWorktrees::new(
            fs.clone(),
            store.clone(),
            root.path().join("managed-worktrees"),
        )
        .unwrap();
        (
            root,
            TaskLifecycle::new(
                fs,
                TaskSessions::default(),
                TaskEvents::default(),
                TaskListEvents::new(),
                store,
                worktrees,
            ),
        )
    }

    fn task(lifecycle: &TaskLifecycle, thread_id: &str, cwd: &std::path::Path) -> TaskRecord {
        let thread = serde_json::json!({
            "id": thread_id,
            "name": thread_id,
            "preview": thread_id,
            "status": { "type": "idle" },
            "cwd": cwd.display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "turns": [],
        });
        let thread: crate::agent::codex::CodexThread =
            serde_json::from_value(thread).expect("the fixture decodes as a Codex thread");
        let conversation = crate::agent::Conversation::from(&thread);
        let resolved = resolve_conversation_cwd(&lifecycle.fs, &conversation);
        task_record_from_conversation(&conversation, &[], resolved.as_ref())
    }

    #[tokio::test]
    async fn local_placement_reuses_logical_paths_and_keeps_sparse_top_order() {
        let (root, lifecycle) = fixture();
        let first = task(&lifecycle, "thread-first", root.path());
        let second = task(&lifecycle, "thread-second", root.path());

        let first_placement = lifecycle
            .claim_at_top(
                managed_thread_from_task_record(&first, None, None, false),
                &first.title,
                &first,
            )
            .await
            .unwrap();
        let second_placement = lifecycle
            .claim_at_top(
                managed_thread_from_task_record(&second, None, None, false),
                &second.title,
                &second,
            )
            .await
            .unwrap();

        assert_eq!(first_placement.section.id, second_placement.section.id);
        assert_eq!(first_placement.before_section_id, None);
        assert_eq!(second_placement.before_section_id, None);
        assert_eq!(
            second_placement.before_thread_id.as_deref(),
            Some("thread-first")
        );
        let (sections, mut threads) = lifecycle
            .store
            .read(|tables| Ok((tables.managed_sections()?, tables.active_managed_threads()?)))
            .unwrap();
        assert_eq!(sections.len(), 1);
        threads.sort_by_key(|thread| thread.position_in_section);
        assert_eq!(
            threads
                .iter()
                .map(|thread| (thread.thread_id.as_str(), thread.position_in_section))
                .collect::<Vec<_>>(),
            [("thread-second", Some(-1024)), ("thread-first", Some(0))]
        );
    }

    #[tokio::test]
    async fn new_sections_are_placed_at_top_and_existing_sections_keep_their_rank() {
        let (root, lifecycle) = fixture();
        let first_directory = root.path().join("first");
        let second_directory = root.path().join("second");
        std::fs::create_dir_all(&first_directory).unwrap();
        std::fs::create_dir_all(&second_directory).unwrap();
        let first = task(&lifecycle, "thread-first", &first_directory);
        let second = task(&lifecycle, "thread-second", &second_directory);
        let first_placement = lifecycle
            .claim_at_top(
                managed_thread_from_task_record(&first, None, None, false),
                &first.title,
                &first,
            )
            .await
            .unwrap();
        let second_placement = lifecycle
            .claim_at_top(
                managed_thread_from_task_record(&second, None, None, false),
                &second.title,
                &second,
            )
            .await
            .unwrap();

        assert_eq!(
            second_placement.before_section_id.as_deref(),
            Some(first_placement.section.id.as_str())
        );
        let sections = lifecycle
            .store
            .read(|tables| tables.managed_sections())
            .unwrap();
        assert_eq!(
            sections
                .iter()
                .map(|section| section.section_id.as_str())
                .collect::<Vec<_>>(),
            [
                second_placement.section.id.as_str(),
                first_placement.section.id.as_str(),
            ]
        );

        let first_replacement = task(&lifecycle, "thread-first-next", &first_directory);
        let replacement_placement = lifecycle
            .claim_at_top(
                managed_thread_from_task_record(&first_replacement, None, None, false),
                &first_replacement.title,
                &first_replacement,
            )
            .await
            .unwrap();
        assert_eq!(replacement_placement.section.id, first_placement.section.id);
        assert_eq!(replacement_placement.before_section_id, None);
        assert_eq!(
            lifecycle
                .store
                .read(|tables| tables.managed_sections())
                .unwrap()
                .iter()
                .map(|section| section.section_id.as_str())
                .collect::<Vec<_>>(),
            [
                second_placement.section.id.as_str(),
                first_placement.section.id.as_str(),
            ]
        );
    }

    #[test]
    fn worktree_errors_keep_their_public_archive_contract() {
        let dirty = worktree_api_error(ManagedWorktreeError::Git(
            crate::git::WorktreeError::Dirty("owned/path".to_string()),
        ));
        assert!(matches!(
            dirty,
            ApiError::BadRequest {
                code: "managed_worktree_dirty",
                ..
            }
        ));

        let transfer_required = worktree_api_error(ManagedWorktreeError::Git(
            crate::git::WorktreeError::DirtyBranchRequiresTransfer {
                branch: "review/pr-42".to_string(),
            },
        ));
        assert!(matches!(
            transfer_required,
            ApiError::BadRequest {
                code: "managed_worktree_invalid",
                message,
            } if message.contains("includeChanges: true")
        ));

        let conflict = ManagedWorktreeState::Archived;
        let error = worktree_api_error(ManagedWorktreeError::Store(
            crate::task_store::TaskStoreError::ManagedWorktreeStateConflict {
                worktree_id: "worktree-1".to_string(),
                actual: conflict.as_str().to_string(),
                expected: ManagedWorktreeState::Ready.as_str().to_string(),
            },
        ));
        assert!(matches!(error, ApiError::Internal(_)));
    }
}
