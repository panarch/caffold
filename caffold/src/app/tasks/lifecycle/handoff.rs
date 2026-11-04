//! A new native conversation takes over the current checkout; history stays native.

use super::{CreateTask, CreatedTask, LocalPlacementMutation, TaskLifecycle};
use crate::agent::{AgentError, Driver, ThreadStatus};
use crate::app::error::ApiError;
use crate::app::tasks::{TaskAgent, TaskRecord};
use crate::task_store::{ManagedThread, ManagedWorktree, ManagedWorktreeState};

pub(super) struct HandoffSource {
    pub(super) managed: ManagedThread,
    pub(super) worktree: Option<ManagedWorktree>,
    driver: Driver,
}

impl TaskLifecycle {
    pub(in crate::app::tasks) async fn handoff_task(
        &self,
        source: ManagedThread,
        source_driver: &Driver,
        target: &TaskAgent,
        request: CreateTask,
    ) -> Result<CreatedTask, ApiError> {
        let _mutation = self.sessions.reserve_mutation(&source.thread_id).await;
        self.workspace_access(&source.thread_id, &request.cwd)
            .await
            .require_write()
            .map_err(|message| ApiError::Conflict {
                code: "task_workspace_read_only",
                message,
            })?;
        let store = self.store.clone();
        let id = source.thread_id.clone();
        let worktree = tokio::task::spawn_blocking(move || store.worktree_for_thread(&id))
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        if let Some(worktree) = &worktree {
            if worktree.state != ManagedWorktreeState::Ready
                || worktree.worktree_path != request.cwd
            {
                return Err(ApiError::Conflict {
                    code: "task_handoff_workspace_changed",
                    message: "The source worktree is not ready at the expected directory.".into(),
                });
            }
            if let Some(conversation) = source_driver.handoff_source(&source.thread_id).await? {
                if matches!(conversation.status, ThreadStatus::Active { .. })
                    || conversation.background_work
                {
                    return Err(ApiError::Conflict {
                        code: "task_handoff_source_active",
                        message: "Finish the source Task's work before handing off its worktree."
                            .into(),
                    });
                }
                if conversation.cwd != request.cwd {
                    source_driver
                        .move_working_directory(&source.thread_id, &request.cwd, source.fast_mode)
                        .await?;
                }
            }
        }
        let created = self
            .create_task_inner(
                target,
                request,
                Some(HandoffSource {
                    managed: source,
                    worktree,
                    driver: source_driver.clone(),
                }),
            )
            .await?;
        self.list_events.refresh();
        Ok(created)
    }

    pub(super) async fn release_handoff_source(
        &self,
        source: &HandoffSource,
    ) -> Result<(), ApiError> {
        if source.worktree.is_none() {
            return Ok(());
        }
        let id = &source.managed.thread_id;
        self.workspace_access(
            id,
            &source
                .worktree
                .as_ref()
                .expect("managed handoff")
                .worktree_path,
        )
        .await
        .require_write()
        .map_err(|message| ApiError::Conflict {
            code: "task_workspace_read_only",
            message,
        })?;
        source.driver.handoff_source(id).await?;
        self.terminals.close(id);
        match &source.driver {
            Driver::Codex(_) => source.driver.stop_watching(id).await?,
            Driver::Grok(client) => client
                .close_for_handoff(id)
                .await
                .map_err(AgentError::from)?,
            Driver::Antigravity(client) => {
                source.driver.archive_conversation(id).await?;
                client
                    .retain_closed_directory(
                        id,
                        &source
                            .worktree
                            .as_ref()
                            .expect("managed handoff")
                            .worktree_path,
                    )
                    .await
                    .map_err(AgentError::from)?;
            }
            Driver::Claude(_) => source.driver.archive_conversation(id).await?,
        }
        self.sessions.end_observation(id).await;
        Ok(())
    }

    pub(super) async fn claim_handoff(
        &self,
        managed: ManagedThread,
        task: &TaskRecord,
        source: HandoffSource,
    ) -> Result<super::ActiveTaskTopPlacement, ApiError> {
        let section_id = source
            .managed
            .section_id()
            .ok_or_else(|| ApiError::Conflict {
                code: "task_handoff_section_unavailable",
                message: "Reconnect the source Task to a Section before continuing it.".into(),
            })?
            .to_string();
        self.mutate_local_placement(
            task,
            LocalPlacementMutation::ClaimInSection {
                thread: Box::new(managed),
                display_name: task.title.clone(),
                section_id,
                handoff: Some(Box::new(source)),
            },
        )
        .await?
        .ok_or_else(|| ApiError::Internal("The continued Task was not persisted.".into()))
    }
}
