//! Durable Task ownership, read-only native history, independent forks, and writer retirement.

use super::{
    CopilotClient, binding::validate_session, protocol::Operation, record::Record, sdk_error,
    transport::runner_error,
};
use crate::agent::{
    AgentError, Conversation, TurnOptions, TurnPage,
    fork::{ForkRevision, ForkSource, ForkSourceId, ForkedConversation},
    history::RecordedPage,
};
use copilot_sdk::rpc::{SessionsForkRequest, SessionsHasEventsRequest};

impl CopilotClient {
    pub(crate) async fn describe(&self, task: &str) -> Result<Option<Conversation>, AgentError> {
        let slot = self.slot(task).await?;
        let slot = slot.lock().await;
        let Some(connection) = slot.as_ref().filter(|connection| !connection.lost()) else {
            return Ok(None);
        };

        let record = connection.record.lock().await;
        let mut conversation = record.conversation.clone();
        conversation.turns = record.page(None, 8)?.turns;
        Ok(Some(conversation))
    }

    pub(crate) async fn read_turns(
        &self,
        task: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<TurnPage, AgentError> {
        let slot = self.slot(task).await?;
        if let Some(connection) = slot
            .lock()
            .await
            .as_ref()
            .filter(|connection| !connection.lost())
        {
            return connection.record.lock().await.page(before, limit);
        }

        self.read_cold(task).await?.page(before, limit)
    }

    async fn read_cold(&self, task: &str) -> Result<Record, AgentError> {
        let binding = self.binding(task)?;
        let mut record = Record::read(
            &self.reader().await?,
            task,
            &binding.native_id,
            &binding.cwd,
        )
        .await?;
        if !self.has_unobserved_writer(task).await? {
            record.settle_cold();
        }
        Ok(record)
    }

    pub(crate) async fn read_recorded_history(
        &self,
        task: &str,
        before: Option<&str>,
    ) -> Result<RecordedPage, AgentError> {
        let binding = self.binding(task)?;
        let record = self.read_cold(task).await?;
        if self.binding(task)?.native_id != binding.native_id {
            return Err(AgentError::Failed(
                "Copilot history changed while reading.".into(),
            ));
        }

        Ok(RecordedPage {
            identity: format!("copilot:{}", binding.native_id),
            page: record.page(before, 1)?,
            warnings: vec![],
        })
    }

    pub(crate) async fn conversation_exists(&self, task: &str) -> Result<bool, AgentError> {
        let Some(binding) = self.inner.bindings.read(task)? else {
            return Ok(false);
        };
        Ok(self
            .reader()
            .await?
            .rpc()
            .sessions()
            .has_events(SessionsHasEventsRequest {
                session_id: binding.native_id.into(),
            })
            .await
            .map_err(sdk_error)?
            .exists)
    }

    pub(crate) async fn close_conversation(&self, task: &str) -> Result<(), AgentError> {
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;
        if let Some(connection) = slot.as_ref() {
            connection.retire();
        }
        self.inner
            .runner
            .close_recoverable(task)
            .await
            .map_err(runner_error)?;
        self.inner.runner.release_observer(task).await;
        slot.take();

        if let Some(binding) = self.inner.bindings.read(task)?
            && let Some((mcp, _)) = self.inner.mcp.get()
        {
            mcp.release(&binding.mcp_binding);
        }
        Ok(())
    }

    pub(crate) async fn erase_contents(&self, task: &str) -> Result<(), AgentError> {
        self.close_conversation(task).await?;
        let Some(binding) = self.inner.bindings.read(task)? else {
            return Ok(());
        };

        let client = self.reader().await?;
        let id: copilot_sdk::SessionId = binding.native_id.into();
        if client
            .rpc()
            .sessions()
            .has_events(SessionsHasEventsRequest {
                session_id: id.clone(),
            })
            .await
            .map_err(sdk_error)?
            .exists
        {
            client.delete_session(&id).await.map_err(sdk_error)?;
        }
        Ok(())
    }

    pub(crate) async fn forget_erased_binding(&self, task: &str) -> Result<(), AgentError> {
        let slot = self.slot(task).await?;
        let _guard = slot.lock().await;
        if self.has_unobserved_writer(task).await? || self.conversation_exists(task).await? {
            return Err(AgentError::Held("Copilot still owns this session.".into()));
        }
        self.inner.bindings.remove(task)
    }

    pub(crate) async fn erase(&self, task: &str) -> Result<(), AgentError> {
        self.erase_contents(task).await?;
        self.forget_erased_binding(task).await
    }

    pub(crate) async fn retain_closed_directory(
        &self,
        task: &str,
        cwd: &str,
    ) -> Result<(), AgentError> {
        let slot = self.slot(task).await?;
        let slot = slot.lock().await;
        if slot.is_some() || self.has_unobserved_writer(task).await? {
            return Err(AgentError::Held("Copilot still owns the workspace.".into()));
        }

        let mut binding = self.binding(task)?;
        binding.cwd = cwd.into();
        binding.destination = None;
        self.inner.bindings.write(&binding)
    }

    pub(crate) async fn move_directory(
        &self,
        task: &str,
        cwd: &str,
    ) -> Result<Conversation, AgentError> {
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;
        let mut binding = self.binding(task)?;
        let connection = self.open_locked(&mut slot, &mut binding).await?;
        connection
            .request(Operation::Move { cwd: cwd.into() })
            .await?;

        binding.cwd = cwd.into();
        binding.destination = None;
        self.inner.bindings.write(&binding)?;

        let mut record = connection.record.lock().await;
        record.conversation.cwd = cwd.into();
        Ok(record.conversation.clone())
    }

    pub(crate) async fn prepare_isolation(&self, task: &str) -> Result<(), AgentError> {
        self.current(task)
            .await?
            .request(Operation::PrepareIsolation)
            .await?;
        Ok(())
    }

    pub(crate) async fn finish_isolation(
        &self,
        task: &str,
        destination: Option<String>,
    ) -> Result<(), AgentError> {
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;

        let mut binding = self.binding(task)?;
        binding.destination = destination.clone();
        self.inner.bindings.write(&binding)?;

        let connection = self.open_locked(&mut slot, &mut binding).await?;
        connection
            .request(Operation::FinishIsolation { destination })
            .await?;
        Ok(())
    }

    pub(crate) async fn owns_fork_source(
        &self,
        task: &str,
        native: &str,
    ) -> Result<bool, AgentError> {
        Ok(self
            .inner
            .bindings
            .read(task)?
            .is_some_and(|binding| binding.native_id == native))
    }

    pub(crate) async fn read_fork_source(
        &self,
        source: ForkSourceId<'_>,
        with_turns: bool,
    ) -> Result<ForkSource, AgentError> {
        let id = source.id();
        validate_session(id)?;
        let owner = match source {
            ForkSourceId::Task(task) => Some(task),
            ForkSourceId::Native { owner, .. } => owner,
        };
        let binding = owner.map(|task| self.binding(task)).transpose()?;
        if let (ForkSourceId::Native { .. }, Some(binding)) = (source, &binding)
            && id != binding.native_id
            && id != binding.task_id
        {
            return Err(AgentError::Held(
                "The Copilot Task no longer owns this source session.".into(),
            ));
        }

        let native = binding
            .as_ref()
            .map_or(id, |binding| binding.native_id.as_str());
        let cwd = binding.as_ref().map_or("", |binding| binding.cwd.as_str());
        let reader = self.reader().await?;
        if !reader
            .rpc()
            .sessions()
            .has_events(SessionsHasEventsRequest {
                session_id: native.to_owned().into(),
            })
            .await
            .map_err(sdk_error)?
            .exists
        {
            return Err(AgentError::ConversationGone(
                "Copilot source session is missing.".into(),
            ));
        }

        let mut record = Record::read(&reader, id, native, cwd).await?;
        if let Some(task) = owner
            && self.has_unobserved_writer(task).await?
        {
            let slot = self.slot(task).await?;
            let slot = slot.lock().await;
            let connection = slot
                .as_ref()
                .filter(|connection| !connection.lost())
                .ok_or_else(|| {
                    AgentError::Held("Copilot is reconnecting to the source Task.".into())
                })?;
            let snapshot = connection.request(Operation::Inspect).await?;
            if let Some(cwd) = snapshot
                .pointer("/metadata/workingDirectory")
                .and_then(serde_json::Value::as_str)
            {
                record.conversation.cwd = cwd.to_owned();
            }
            record.restore_activity(&snapshot);
            record.conversation.background_work = snapshot["background"] == true;
        } else if binding.is_some() || record.has_final_message() {
            record.settle_cold();
        }

        let turns_page = with_turns.then(|| record.page(None, 4)).transpose()?;
        let revision = ForkRevision::Copilot {
            native_id: native.into(),
            last_event: record.last_event,
        };
        let settings = binding
            .map(|binding| binding.settings)
            .unwrap_or(TurnOptions {
                model: record.model,
                effort: record.effort,
                ..Default::default()
            });
        record.conversation.turns.clear();
        Ok(ForkSource {
            conversation: record.conversation,
            turns_page,
            settings,
            revision,
        })
    }

    pub(crate) async fn create_fork(
        &self,
        source: &ForkSource,
        cwd: &str,
        title: &str,
        settings: &TurnOptions,
    ) -> Result<ForkedConversation, AgentError> {
        let ForkRevision::Copilot { native_id, .. } = &source.revision else {
            return Err(AgentError::Failed("Unexpected Copilot fork source.".into()));
        };
        let reader = self.reader().await?;
        let existing = reader.list_sessions(None).await.map_err(sdk_error)?;
        let child = reader
            .rpc()
            .sessions()
            .fork(SessionsForkRequest {
                session_id: native_id.clone().into(),
                name: Some(title.into()),
                // The SDK's cutoff is exclusive. Copy the complete session, then
                // the fork lifecycle rechecks the parent's last durable event.
                to_event_id: None,
            })
            .await
            .map_err(sdk_error)?
            .session_id
            .to_string();

        validate_session(&child)?;
        if child == *native_id
            || existing
                .iter()
                .any(|session| session.session_id.as_str() == child)
        {
            return Err(AgentError::Failed(
                "Copilot returned an existing session as the fork.".into(),
            ));
        }

        let binding = self.reserve(cwd, settings, Some(child))?;
        let result = async {
            let mut opened = self.open_conversation(&binding.task_id, true).await?;
            self.move_directory(&binding.task_id, cwd).await?;
            self.rename(&binding.task_id, title).await?;

            opened.conversation.cwd = cwd.into();
            opened.conversation.title = Some(title.into());
            Ok(ForkedConversation {
                conversation: opened.conversation,
                turns_page: opened.turns_page.unwrap_or_default(),
                settings: settings.clone(),
            })
        }
        .await;

        if result.is_err() {
            self.erase(&binding.task_id).await?;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_external_fork_cannot_follow_an_owner_onto_another_native_session() {
        let root = tempfile::tempdir().unwrap();
        let client = CopilotClient::in_data_dir(root.path());
        let binding = client
            .reserve("/checkout", &TurnOptions::default(), None)
            .unwrap();
        let requested = uuid::Uuid::new_v4().to_string();
        let source = ForkSourceId::Native {
            id: &requested,
            owner: Some(&binding.task_id),
        };

        for with_turns in [true, false] {
            assert!(matches!(
                client.read_fork_source(source, with_turns).await,
                Err(AgentError::Held(message)) if message == "The Copilot Task no longer owns this source session."
            ));
        }
    }
}
