//! A Task in another Task's managed checkout reads history without opening work.

use super::{
    DetailContext, TaskDetailCursor, TaskDetailPublication, TaskDetailResponse, TaskDetailSync,
    TaskEventsPage, TaskEventsRange, TaskSyncState, loading_detail, window_detail_events,
};
use crate::app::error::ApiError;
use crate::app::tasks::{
    presence::active_record,
    projection::{conversation_from_row, resolve_conversation_cwd, task_record_from_conversation},
    workspace_access::WorkspaceAccess,
};
use crate::task_store::ManagedThread;

impl DetailContext {
    pub(in crate::app::tasks) async fn publish_workspace_access(&self, task: &str) {
        match self.recorded_detail(task, None).await {
            Ok(Some(detail)) => {
                self.sync
                    .publish(TaskDetailPublication::Sync(Box::new(TaskDetailSync {
                        thread_id: task.to_string(),
                        revision: detail.revision,
                        detail,
                        reason: "workspace-ownership-changed",
                        error: None,
                    })))
            }
            Ok(None) => {}
            Err(error) => self.broadcast_error(task, error.into_error_body()).await,
        }
    }

    pub(super) async fn inspect_workspace(&self, task: &str, cwd: &str) -> WorkspaceAccess {
        let fs = self.fs.clone();
        let store = self.store.clone();
        let task = task.to_string();
        let cwd = cwd.to_string();
        let root = self.worktrees.root().to_path_buf();
        tokio::task::spawn_blocking(move || {
            WorkspaceAccess::inspect(&fs, &store, &root, &task, &cwd)
        })
        .await
        .unwrap_or_else(|error| WorkspaceAccess::Unavailable {
            reason: error.to_string(),
        })
    }

    pub(super) async fn recorded_access(
        &self,
        task: &str,
    ) -> Result<Option<(ManagedThread, WorkspaceAccess)>, ApiError> {
        if !self.runtime.has_other_managed_workspace(task).await? {
            return Ok(None);
        }
        let store = self.store.clone();
        let id = task.to_string();
        if tokio::task::spawn_blocking(move || store.worktree_for_thread(&id))
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?
            .map_err(|error| ApiError::Internal(error.to_string()))?
            .is_some()
        {
            return Ok(None);
        }
        let managed = active_record(&self.store, task).await?;
        let access = self.runtime.workspace_access(&managed).await?;
        match access {
            WorkspaceAccess::ReadOnly { .. } | WorkspaceAccess::Unavailable { .. } => {
                Ok(Some((managed, access)))
            }
            WorkspaceAccess::ReadWrite { .. } => Ok(None),
        }
    }

    pub(in crate::app::tasks) async fn recorded_detail(
        &self,
        task: &str,
        cursor: Option<&str>,
    ) -> Result<Option<TaskDetailResponse>, ApiError> {
        let Some((managed, access)) = self.recorded_access(task).await? else {
            return Ok(None);
        };
        let cursor = cursor.map(TaskDetailCursor::decode).unwrap_or_default();
        let driver = self.runtime.agent_for(&managed).await?.driver();
        let described = driver.describe(task).await?;
        let conversation = match described {
            Some(conversation) => conversation,
            None => conversation_from_row(&managed)?,
        };
        let native = driver
            .read_recorded_page(task, cursor.turns.as_deref())
            .await?;
        let baseline = self
            .sessions
            .snapshot(task)
            .await
            .map(|snapshot| snapshot.revision)
            .unwrap_or_default();
        let page = self.events.accept_history_page(
            &conversation,
            &native.page,
            baseline,
            cursor.turns.as_deref(),
        );
        if let Some(id) = &cursor.item_id
            && !page
                .events
                .iter()
                .any(|event| &event.id == id && Some(event.position) == cursor.before)
        {
            return Err(ApiError::Agent(
                "Conversation history continuation is no longer available.".into(),
            ));
        }
        let extent = page
            .events
            .first()
            .zip(page.events.last())
            .map(|(first, last)| TaskEventsRange {
                from: Some(first.position),
                to: (cursor != TaskDetailCursor::default()).then_some(last.position),
            });
        let (events, events_range, next_cursor) =
            window_detail_events(page.events, extent, &cursor, page.next);
        let resolved = resolve_conversation_cwd(&self.fs, &conversation);
        let mut record = task_record_from_conversation(&conversation, &events, resolved.as_ref());
        record.title = managed.display_name.clone();
        record.unseen = managed.unseen();
        let mut detail = loading_detail(task, baseline, Some(&managed));
        detail.workspace_access = Some(access);
        detail.task = Some(record);
        detail.sync_state = TaskSyncState::Ready;
        detail.supports_steering = false;
        detail.history_loading = false;
        let (events, links) = self
            .file_links
            .project_task(
                detail
                    .task
                    .as_ref()
                    .expect("the recorded Task was projected"),
                &events,
            )
            .await;
        detail.events = events;
        detail.file_links = links;
        detail.events_range = events_range;
        detail.event_revision = page.revision;
        detail.event_reset_revision = page.reset_revision;
        detail.event_epoch = Some(page.epoch);
        detail.events_page = TaskEventsPage { next_cursor };
        self.events.trim(task);
        Ok(Some(detail))
    }
}
