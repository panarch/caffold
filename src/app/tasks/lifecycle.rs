use std::{path::PathBuf, sync::Arc};

use crate::{
    app::error::ApiError,
    codex_app_server::{CodexThreadClient, CodexTurnOptions},
    codex_thread_sessions::CodexThreadSessions,
    fs::RootedFs,
    task_store::{ManagedThread, TaskStore},
};

use super::{
    CodexConnection, TaskRecord,
    events::{TaskEvents, accepted_user_message_event, now_ms},
    projection::{resolve_thread_cwd, task_activity_ms, task_record_from_thread},
    routes::TaskListEvents,
    worktrees::{
        ArchiveOutcome, IsolateOutcome, ManagedWorktreeError, ManagedWorktrees, RestoreOutcome,
    },
};

pub(in crate::app) struct StartTask {
    pub(in crate::app) cwd: String,
    pub(in crate::app) prompt: String,
    pub(in crate::app) images: Vec<String>,
    pub(in crate::app) turn_options: CodexTurnOptions,
    pub(in crate::app) initial_name: Option<String>,
}

#[derive(Clone)]
pub(in crate::app) struct TaskLifecycle {
    fs: Arc<RootedFs>,
    sessions: CodexThreadSessions,
    events: TaskEvents,
    list_events: TaskListEvents,
    store: TaskStore,
    worktrees: ManagedWorktrees,
}

impl TaskLifecycle {
    pub(in crate::app) fn new(
        fs: Arc<RootedFs>,
        sessions: CodexThreadSessions,
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
    ) -> Result<TaskRecord, ApiError> {
        let StartTask {
            cwd,
            prompt,
            images,
            turn_options,
            initial_name,
        } = request;
        let requested_permission_mode = turn_options.permission_mode;
        let requested_model = turn_options.model.clone();
        let requested_reasoning_effort = turn_options.effort.clone();
        let client = &connection.client;
        let mut thread = client
            .start_thread(&cwd, turn_options.permission_mode)
            .await?;
        if let Some(initial_name) = initial_name {
            if let Err(error) = client
                .set_thread_name(&thread.thread_id, &initial_name)
                .await
            {
                self.rollback_unclaimed_thread(client, &thread.thread_id)
                    .await;
                return Err(error.into());
            }
            thread.thread.name = Some(initial_name);
        }
        let thread_permission_mode = requested_permission_mode.or(thread.permission_mode);
        let effective_model = requested_model.or_else(|| thread.model.clone());
        let effective_reasoning_effort =
            requested_reasoning_effort.or_else(|| thread.reasoning_effort.clone());
        let task = match self.record_from_codex_thread(&thread.thread) {
            Ok(task) => task,
            Err(error) => {
                self.rollback_unclaimed_thread(client, &thread.thread_id)
                    .await;
                return Err(error);
            }
        };
        if let Err(error) = self
            .claim(managed_thread_from_task_record(
                &task,
                effective_model.clone(),
                effective_reasoning_effort.clone(),
            ))
            .await
        {
            self.rollback_unclaimed_thread(client, &thread.thread_id)
                .await;
            return Err(error);
        }

        self.list_events.update(task.clone());
        self.sessions
            .register_started_thread(
                client,
                connection.generation,
                thread.thread.clone(),
                thread_permission_mode,
                thread.model.clone(),
                thread.reasoning_effort.clone(),
            )
            .await;
        let turn = match client
            .start_turn(&thread.thread_id, &cwd, &prompt, &images, turn_options)
            .await
        {
            Ok(turn) => turn,
            Err(error) => {
                self.sessions.cancel_runtime(&thread.thread_id).await;
                return Err(error.into());
            }
        };
        self.sessions
            .record_turn_started(
                connection.generation,
                &thread.thread_id,
                Some(&cwd),
                turn.turn,
                CodexTurnOptions {
                    permission_mode: thread_permission_mode,
                    model: effective_model.clone(),
                    effort: effective_reasoning_effort.clone(),
                },
            )
            .await;
        if let Err(error) = self
            .update_composer_settings(
                &thread.thread_id,
                effective_model.as_deref(),
                effective_reasoning_effort.as_deref(),
            )
            .await
        {
            eprintln!(
                "failed to persist composer settings for started thread {}: {error:?}",
                thread.thread_id
            );
        }
        self.events.publish(accepted_user_message_event(
            &thread.thread_id,
            &turn.turn_id,
            &prompt,
            &images,
        ));
        Ok(task)
    }

    pub(in crate::app) async fn isolate_current_task(
        &self,
        source: PathBuf,
        thread_id: String,
        task_name: String,
        branch_name: Option<String>,
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
            .isolate_current(source, thread_id, task_name, branch_name, include_changes)
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

    fn record_from_codex_thread(
        &self,
        thread: &crate::codex_app_server::CodexThread,
    ) -> Result<TaskRecord, ApiError> {
        let thread = thread.clone().into_value();
        let resolved = resolve_thread_cwd(&self.fs, &thread);
        task_record_from_thread(&thread, &[], resolved.as_ref())
    }

    async fn claim(&self, thread: ManagedThread) -> Result<(), ApiError> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || store.claim(thread, now_ms()))
            .await
            .map_err(task_store_worker_error)?
            .map(|_| ())
            .map_err(|error| ApiError::Internal(error.to_string()))
    }

    async fn update_composer_settings(
        &self,
        thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<(), ApiError> {
        let store = self.store.clone();
        let thread_id = thread_id.to_string();
        let model = model.map(str::to_string);
        let reasoning_effort = reasoning_effort.map(str::to_string);
        tokio::task::spawn_blocking(move || {
            store.update_composer_settings(
                &thread_id,
                model.as_deref(),
                reasoning_effort.as_deref(),
            )
        })
        .await
        .map_err(task_store_worker_error)?
        .map(|_| ())
        .map_err(|error| ApiError::Internal(error.to_string()))
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

fn managed_thread_from_task_record(
    task: &TaskRecord,
    model: Option<String>,
    reasoning_effort: Option<String>,
) -> ManagedThread {
    let mut managed = ManagedThread::new(
        task.thread_id.clone(),
        Some(task_activity_ms(task)),
        model,
        reasoning_effort,
    );
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
    use crate::task_store::ManagedWorktreeState;

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
