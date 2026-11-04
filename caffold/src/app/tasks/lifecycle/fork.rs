//! Native conversation fork lifecycle.
//!
//! The provider remains the source of conversation history. This owner holds
//! the source mutation boundary, validates the source and target around the
//! native fork, and claims only a child that survives every validation step.

use crate::{
    agent::{Conversation, ThreadStatus, driver::REVIEWED_PERMISSION_MODE},
    app::error::ApiError,
    task_store::{ManagedSection, ManagedThread},
};

use super::super::{
    TaskAgent, TaskRecord, active_list::ActiveTask, projection::conversation_display_name,
    sessions::ConversationSettings,
};
use super::{
    ActiveTaskTopPlacement, CreatedTask, LocalPlacementMutation, TaskLifecycle,
    managed_thread_from_task_record, task_store_worker_error,
};

pub(in crate::app::tasks) struct ForkTask {
    pub(in crate::app::tasks) source: ForkTaskSource,
    pub(in crate::app::tasks) section: ManagedSection,
    pub(in crate::app::tasks) cwd: String,
}

pub(in crate::app::tasks) enum ForkTaskSource {
    Managed(Box<ManagedThread>),
    External {
        thread_id: String,
        owner: Option<Box<ManagedThread>>,
    },
}

impl ForkTaskSource {
    fn owner(&self) -> Option<&ManagedThread> {
        match self {
            Self::Managed(source) => Some(source),
            Self::External { owner, .. } => owner.as_deref(),
        }
    }

    fn is_external(&self) -> bool {
        matches!(self, Self::External { .. })
    }

    fn thread_id(&self) -> &str {
        match self {
            Self::Managed(source) => &source.thread_id,
            Self::External { thread_id, .. } => thread_id,
        }
    }

    fn display_name(&self, conversation: &Conversation) -> String {
        match self {
            Self::Managed(source) => source.display_name.clone(),
            Self::External { .. } => conversation_display_name(conversation),
        }
    }

    fn can_fork(&self, status: &ThreadStatus) -> bool {
        match self {
            Self::Managed(_) => matches!(status, ThreadStatus::Idle),
            Self::External {
                owner: Some(owner), ..
            } if owner.archived_at_ms.is_none() => matches!(status, ThreadStatus::Idle),
            Self::External { .. } => matches!(status, ThreadStatus::Idle | ThreadStatus::NotLoaded),
        }
    }
}

impl TaskLifecycle {
    /// Fork one eligible conversation and claim only the returned child.
    ///
    /// The source read is deliberately native and read-only. A managed source
    /// retains its per-Task mutation lease and must be idle so Caffold prompts
    /// cannot cross the check. An external source may remain not loaded because
    /// read-only lookup deliberately does not resume it and Codex forks stored
    /// history natively. The second provider read rejects any source change
    /// Caffold can observe while the provider is forking. Until the local claim
    /// commits, every failure deletes the otherwise unreachable child.
    pub(in crate::app::tasks) async fn fork_task(
        &self,
        agent: &TaskAgent,
        request: ForkTask,
    ) -> Result<CreatedTask, ApiError> {
        let ForkTask {
            source,
            section,
            cwd,
        } = request;
        let source_thread_id = source.thread_id().to_string();
        let _mutation = match &source {
            ForkTaskSource::Managed(source) => {
                Some(self.sessions.reserve_mutation(&source.thread_id).await)
            }
            ForkTaskSource::External {
                owner: Some(owner), ..
            } => Some(self.sessions.reserve_mutation(&owner.thread_id).await),
            ForkTaskSource::External { owner: None, .. } => None,
        };
        self.ensure_fork_target_is_current(&section).await?;
        if let Some(owner) = source.owner() {
            self.ensure_managed_fork_source_is_current(owner).await?;
        }
        let driver = agent.driver();
        let external = source.is_external();
        let mut source_before = driver
            .read_fork_source(&source_thread_id, external, false)
            .await?;
        if !matches!(agent, TaskAgent::Grok { .. })
            && source_before.conversation.id != source_thread_id
        {
            return Err(ApiError::BadRequest {
                code: "task_fork_source_mismatch",
                message: "The agent returned a different source conversation".into(),
            });
        }
        if !source.can_fork(&source_before.conversation.status)
            || source_before.conversation.background_work
        {
            return Err(task_fork_source_not_idle());
        }
        if let ForkTaskSource::Managed(managed) = &source {
            source_before.settings.model = source_before.settings.model.or(managed.model.clone());
            source_before.settings.effort = source_before
                .settings
                .effort
                .or(managed.reasoning_effort.clone());
            source_before.settings.permission_mode = source_before
                .settings
                .permission_mode
                .or(managed.permission_mode.clone());
            // This is a Caffold-owned preference; native ask/default is the
            // provider posture used by the reviewer, not a replacement for it.
            if managed.permission_mode.as_deref() == Some(REVIEWED_PERMISSION_MODE) {
                source_before.settings.permission_mode = managed.permission_mode.clone();
            }
            source_before.settings.fast_mode = managed.fast_mode;
        }
        let title = format!(
            "Fork of {}",
            source.display_name(&source_before.conversation)
        );
        let mut forked = driver
            .create_fork(&source_before, &cwd, &title, &source_before.settings)
            .await?;
        if source_before.settings.permission_mode.as_deref() == Some(REVIEWED_PERMISSION_MODE) {
            forked.settings.permission_mode = Some(REVIEWED_PERMISSION_MODE.to_string());
        }
        let child_thread_id = forked.conversation.id.clone();
        let request = self.sessions.reserve_request(&child_thread_id).await;
        let validated = async {
            let source_after = driver
                .read_fork_source(&source_thread_id, external, false)
                .await?;
            if !source_before.same_revision(&source_after)
                || !source.can_fork(&source_after.conversation.status)
                || source_after.conversation.background_work
            {
                return Err(task_fork_source_changed());
            }
            driver.finish_fork(&mut forked, &title).await?;
            self.ensure_fork_target_is_current(&section).await?;
            if let Some(owner) = source.owner() {
                self.ensure_managed_fork_source_is_current(owner).await?;
            }
            let task = self.record_from_conversation(&forked.conversation)?;
            let managed = managed_thread_from_task_record(
                &task,
                agent.run_by(&cwd),
                forked.settings.model.clone(),
                forked.settings.effort.clone(),
                forked.settings.fast_mode,
                forked.settings.permission_mode.clone(),
            );
            let placement = self
                .claim_in_section_at_top(managed, &title, &task, &section)
                .await?;
            Ok::<_, ApiError>((task, placement))
        }
        .await;
        let (task, placement) = match validated {
            Ok(claimed) => claimed,
            Err(error) => {
                if let Err(cleanup) = driver.delete_conversation(&child_thread_id).await {
                    eprintln!("failed to delete unclaimed fork {child_thread_id}: {cleanup}");
                }
                return Err(error);
            }
        };
        self.sessions
            .register_created_thread(
                &driver,
                agent.generation(),
                forked.conversation,
                Some(forked.turns_page),
                ConversationSettings {
                    permission_mode: forked.settings.permission_mode,
                    model: forked.settings.model,
                    reasoning_effort: forked.settings.effort,
                    fast_mode: forked.settings.fast_mode,
                },
            )
            .await;
        let active_task = ActiveTask::of(&task, false);
        self.list_events
            .place(active_task.clone(), placement.clone());
        Ok(CreatedTask {
            task,
            active_task,
            placement,
            _request: request,
        })
    }

    async fn claim_in_section_at_top(
        &self,
        thread: ManagedThread,
        display_name: &str,
        task: &TaskRecord,
        section: &ManagedSection,
    ) -> Result<ActiveTaskTopPlacement, ApiError> {
        self.mutate_local_placement(
            task,
            LocalPlacementMutation::ClaimInSection {
                thread: Box::new(thread),
                display_name: display_name.to_string(),
                section_id: section.section_id.clone(),
                handoff: None,
            },
        )
        .await?
        .ok_or_else(|| ApiError::Internal("forked Task was not persisted".to_string()))
    }

    async fn ensure_managed_fork_source_is_current(
        &self,
        source: &ManagedThread,
    ) -> Result<(), ApiError> {
        let store = self.store.clone();
        let source_thread_id = source.thread_id.clone();
        let section_id = source.section_id().map(str::to_string);
        let provider = source.run_by.provider();
        let archived_at_ms = source.archived_at_ms;
        let current = tokio::task::spawn_blocking(move || store.get(&source_thread_id))
            .await
            .map_err(task_store_worker_error)?
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        if current.is_none_or(|current| {
            current.archived_at_ms != archived_at_ms
                || current.section_id() != section_id.as_deref()
                || current.run_by.provider() != provider
        }) {
            return Err(task_fork_source_changed());
        }
        Ok(())
    }

    async fn ensure_fork_target_is_current(
        &self,
        section: &ManagedSection,
    ) -> Result<(), ApiError> {
        let store = self.store.clone();
        let section_id = section.section_id.clone();
        let logical_path = section.logical_path.clone();
        let current = tokio::task::spawn_blocking(move || {
            store.read(|tables| {
                Ok(tables.managed_sections()?.into_iter().find(|section| {
                    section.section_id == section_id && section.logical_path == logical_path
                }))
            })
        })
        .await
        .map_err(task_store_worker_error)?
        .map_err(|error| ApiError::Internal(error.to_string()))?;
        if current.is_none() {
            return Err(task_fork_target_changed());
        }
        Ok(())
    }
}

fn task_fork_source_not_idle() -> ApiError {
    ApiError::Conflict {
        code: "task_fork_source_not_idle",
        message: "the conversation cannot be forked in its current state".to_string(),
    }
}

fn task_fork_source_changed() -> ApiError {
    ApiError::Conflict {
        code: "task_fork_source_changed",
        message: "the source conversation changed while it was being forked".to_string(),
    }
}

fn task_fork_target_changed() -> ApiError {
    ApiError::Conflict {
        code: "task_fork_target_changed",
        message: "the target Section changed before the fork could be created".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::{Value as JsonValue, json};

    use super::*;
    use crate::{
        agent::codex::{CodexThreadClient, CodexThreadError, MockCodexResponse},
        app::tasks::{TaskState, test_support::task_state_with_codex_client},
        fs::RootedFs,
        task_store::{ManagedSection, ManagedThread, RunBy},
    };

    fn source_thread(thread_id: &str, cwd: &Path, updated_at: f64) -> JsonValue {
        json!({
            "id": thread_id,
            "name": "Provider source name",
            "preview": "Inherited conversation",
            "status": { "type": "idle" },
            "cwd": cwd.display().to_string(),
            "createdAt": 1.0,
            "updatedAt": updated_at,
            "turns": []
        })
    }

    fn child_fork(source_thread_id: &str, child_thread_id: &str, cwd: &str) -> JsonValue {
        json!({
            "thread": {
                "id": child_thread_id,
                "preview": "Inherited conversation",
                "status": { "type": "idle" },
                "cwd": cwd,
                "forkedFromId": source_thread_id,
                "createdAt": 3.0,
                "updatedAt": 3.0,
                "turns": []
            },
            "cwd": cwd
        })
    }

    fn managed_source_context(
        state: &TaskState,
        thread_id: &str,
        display_name: &str,
    ) -> (ManagedThread, ManagedSection) {
        let section = ManagedSection {
            section_id: "section-root".to_string(),
            logical_path: String::new(),
            position: 0,
            last_composer_settings: None,
        };
        state
            .task_store
            .transaction(|tables| {
                tables.upsert_managed_section(&section)?;
                tables.claim_managed_thread_at_top(
                    ManagedThread::new(thread_id, RunBy::Codex, Some(2_000), None, None),
                    display_name,
                    &section.section_id,
                    2_000,
                )?;
                Ok(())
            })
            .expect("managed source context");
        let source = state
            .task_store
            .get(thread_id)
            .expect("managed source lookup")
            .expect("managed source");
        (source, section)
    }

    async fn fork_managed_source(
        state: &TaskState,
        source: ManagedThread,
        section: ManagedSection,
        cwd: &Path,
    ) -> Result<CreatedTask, ApiError> {
        let connection = state.detail.connection().await.expect("Codex connection");
        state
            .lifecycle
            .fork_task(
                &TaskAgent::Codex(connection),
                ForkTask {
                    source: ForkTaskSource::Managed(Box::new(source)),
                    section,
                    cwd: cwd.display().to_string(),
                },
            )
            .await
    }

    async fn requested_methods(client: &CodexThreadClient) -> Vec<String> {
        client
            .mock_requests()
            .await
            .into_iter()
            .map(|(method, _)| method)
            .collect()
    }

    fn expect_fork_error(result: Result<CreatedTask, ApiError>, message: &str) -> ApiError {
        match result {
            Err(error) => error,
            Ok(_) => panic!("{message}"),
        }
    }

    #[tokio::test]
    async fn managed_fork_rejects_an_active_source_before_creating_a_child() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-fork-active";
        let mut source_wire = source_thread(source_thread_id, root.path(), 2.0);
        source_wire["status"] = json!({ "type": "active", "activeFlags": [] });
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok_for(
            "thread/read",
            json!({ "threadId": source_thread_id, "includeTurns": false }),
            json!({ "thread": source_wire }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let (source, section) = managed_source_context(&state, source_thread_id, "Active source");

        let error = expect_fork_error(
            fork_managed_source(&state, source, section, root.path()).await,
            "active source is rejected",
        );

        assert!(matches!(
            error,
            ApiError::Conflict {
                code: "task_fork_source_not_idle",
                ..
            }
        ));
        assert_eq!(
            state
                .task_store
                .read(|tables| tables.active_managed_threads())
                .unwrap()
                .len(),
            1
        );
        assert_eq!(requested_methods(&client).await, ["thread/read"]);
    }

    #[tokio::test]
    async fn managed_fork_rejects_a_not_loaded_source_before_creating_a_child() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-fork-not-loaded-managed";
        let mut source_wire = source_thread(source_thread_id, root.path(), 2.0);
        source_wire["status"] = json!({ "type": "notLoaded" });
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok_for(
            "thread/read",
            json!({ "threadId": source_thread_id, "includeTurns": false }),
            json!({ "thread": source_wire }),
        )]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let (source, section) =
            managed_source_context(&state, source_thread_id, "Not-loaded managed source");

        let error = expect_fork_error(
            fork_managed_source(&state, source, section, root.path()).await,
            "not-loaded managed source is rejected",
        );

        assert!(matches!(
            error,
            ApiError::Conflict {
                code: "task_fork_source_not_idle",
                ..
            }
        ));
        assert!(state.task_store.get(source_thread_id).unwrap().is_some());
        assert_eq!(requested_methods(&client).await, ["thread/read"]);
    }

    #[tokio::test]
    async fn fork_rejects_a_source_archived_after_context_was_captured() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-fork-stale-source";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let (source, section) = managed_source_context(&state, source_thread_id, "Stale source");
        state
            .task_store
            .archive(source_thread_id, 3_000)
            .unwrap()
            .expect("archive source after context read");

        let error = expect_fork_error(
            fork_managed_source(&state, source, section, root.path()).await,
            "stale source context must not create a child",
        );

        assert!(matches!(
            error,
            ApiError::Conflict {
                code: "task_fork_source_changed",
                ..
            }
        ));
        assert!(requested_methods(&client).await.is_empty());
    }

    #[tokio::test]
    async fn fork_rejects_a_target_changed_after_context_was_captured() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-fork-stale-target";
        let client = CodexThreadClient::mock(Vec::new());
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let (source, section) = managed_source_context(&state, source_thread_id, "Stale target");
        let mut changed_section = section.clone();
        changed_section.logical_path = "moved-project".to_string();
        state
            .task_store
            .transaction(|tables| tables.upsert_managed_section(&changed_section))
            .unwrap();

        let error = expect_fork_error(
            fork_managed_source(&state, source, section, root.path()).await,
            "stale target context must not create a child",
        );

        assert!(matches!(
            error,
            ApiError::Conflict {
                code: "task_fork_target_changed",
                ..
            }
        ));
        assert!(requested_methods(&client).await.is_empty());
    }

    #[tokio::test]
    async fn fork_deletes_the_child_when_the_source_changes_during_provider_fork() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-fork-changing-source";
        let child_thread_id = "thread-fork-changing-child";
        let cwd = root.path().canonicalize().unwrap();
        let cwd_wire = cwd.display().to_string();
        let source_before = source_thread(source_thread_id, &cwd, 2.0);
        let source_after = source_thread(source_thread_id, &cwd, 3.0);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/read", json!({ "thread": source_before })),
            MockCodexResponse::ok(
                "thread/fork",
                child_fork(source_thread_id, child_thread_id, &cwd_wire),
            ),
            MockCodexResponse::ok("thread/read", json!({ "thread": source_after })),
            MockCodexResponse::ok_for(
                "thread/delete",
                json!({ "threadId": child_thread_id }),
                json!({}),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let (source, section) = managed_source_context(&state, source_thread_id, "Changing source");

        let error = expect_fork_error(
            fork_managed_source(&state, source, section, &cwd).await,
            "a changed source invalidates its child",
        );

        assert!(matches!(
            error,
            ApiError::Conflict {
                code: "task_fork_source_changed",
                ..
            }
        ));
        assert!(state.task_store.get(child_thread_id).unwrap().is_none());
        assert!(state.task_store.get(source_thread_id).unwrap().is_some());
        assert_eq!(
            requested_methods(&client).await,
            ["thread/read", "thread/fork", "thread/read", "thread/delete"]
        );
    }

    #[tokio::test]
    async fn fork_source_refresh_failure_deletes_the_unclaimed_child() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-fork-refresh-source";
        let child_thread_id = "thread-fork-refresh-child";
        let cwd = root.path().canonicalize().unwrap();
        let cwd_wire = cwd.display().to_string();
        let source_wire = source_thread(source_thread_id, &cwd, 2.0);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/read", json!({ "thread": source_wire })),
            MockCodexResponse::ok(
                "thread/fork",
                child_fork(source_thread_id, child_thread_id, &cwd_wire),
            ),
            MockCodexResponse::error(
                "thread/read",
                CodexThreadError::Protocol("source refresh unavailable".to_string()),
            ),
            MockCodexResponse::ok_for(
                "thread/delete",
                json!({ "threadId": child_thread_id }),
                json!({}),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let (source, section) = managed_source_context(&state, source_thread_id, "Refresh source");

        let error = expect_fork_error(
            fork_managed_source(&state, source, section, &cwd).await,
            "source refresh failure rejects the fork",
        );

        assert!(error.to_string().contains("source refresh unavailable"));
        assert!(state.task_store.get(child_thread_id).unwrap().is_none());
        assert!(state.task_store.get(source_thread_id).unwrap().is_some());
        assert_eq!(
            requested_methods(&client).await,
            ["thread/read", "thread/fork", "thread/read", "thread/delete"]
        );
    }

    #[tokio::test]
    async fn fork_history_failure_deletes_the_unclaimed_child() {
        let root = tempfile::tempdir().unwrap();
        let source_thread_id = "thread-fork-history-source";
        let child_thread_id = "thread-fork-history-child";
        let cwd = root.path().canonicalize().unwrap();
        let cwd_wire = cwd.display().to_string();
        let source_wire = source_thread(source_thread_id, &cwd, 2.0);
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/read", json!({ "thread": source_wire.clone() })),
            MockCodexResponse::ok(
                "thread/fork",
                child_fork(source_thread_id, child_thread_id, &cwd_wire),
            ),
            MockCodexResponse::ok("thread/read", json!({ "thread": source_wire })),
            MockCodexResponse::error(
                "thread/turns/list",
                CodexThreadError::Protocol("history unavailable".to_string()),
            ),
            MockCodexResponse::ok_for(
                "thread/delete",
                json!({ "threadId": child_thread_id }),
                json!({}),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        let (source, section) = managed_source_context(&state, source_thread_id, "Source task");

        let error = expect_fork_error(
            fork_managed_source(&state, source, section, &cwd).await,
            "history failure rejects the fork",
        );

        assert!(error.to_string().contains("history unavailable"));
        assert!(state.task_store.get(child_thread_id).unwrap().is_none());
        assert!(state.task_store.get(source_thread_id).unwrap().is_some());
        assert_eq!(
            requested_methods(&client).await,
            [
                "thread/read",
                "thread/fork",
                "thread/read",
                "thread/turns/list",
                "thread/delete"
            ]
        );
    }
}
