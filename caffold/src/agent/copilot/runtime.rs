//! Explicit replacement of this server's Copilot runner and its Task writers.

use super::{
    CopilotClient, CopilotRuntimeEvent, permission::pending_permissions, protocol::Operation,
    transport::runner_error,
};
use crate::agent::{AgentError, SessionEvent, SessionEventKind, ThreadStatus};
use tokio::sync::RwLockReadGuard;

impl CopilotClient {
    pub(crate) async fn restart_runtime(&self) -> Result<(), AgentError> {
        let _runtime = self.inner.runtime_gate.try_write().map_err(|_| {
            AgentError::Held("Wait for the current Copilot runtime operation to finish.".into())
        })?;

        // The runner also owns writers this backend has not attached to yet.
        let tasks = self
            .inner
            .runner
            .checked_live_sessions()
            .await
            .map_err(runner_error)?;
        for task in tasks {
            if let Err(error) = self.interrupt_writer_for_restart(&task).await {
                // A broken adapter must still be replaceable. On its next open the CLI
                // is authoritative about any request it kept in the native session.
                tracing::warn!(%task, %error, "Copilot could not acknowledge an interrupt before runner restart");
            }
            self.close_writer(&task).await?;
            self.report_closed_writer(&task).await;
        }

        *self.inner.catalog.lock().await = None;
        self.inner.runner.restart().await.map_err(runner_error)?;
        self.inner.runner.disconnect().await;
        Ok(())
    }

    pub(super) fn runtime_access(&self) -> Result<RwLockReadGuard<'_, ()>, AgentError> {
        self.inner
            .runtime_gate
            .try_read()
            .map_err(|_| AgentError::Held("Copilot runtime is restarting.".into()))
    }

    async fn interrupt_writer_for_restart(&self, task: &str) -> Result<(), AgentError> {
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;
        let connection = self
            .open_locked(&mut slot, &mut self.binding(task)?)
            .await?;
        let snapshot = connection.request(Operation::Inspect).await?;

        // The CLI can persist pending permissions across process shutdown. Its
        // normal Stop operation cancels work and queued input inside the session.
        if snapshot["processing"] == true
            || snapshot["activeTurn"].is_string()
            || snapshot["background"] == true
            || !pending_permissions(&snapshot)?.is_empty()
        {
            connection.request(Operation::Stop).await?;
        }
        Ok(())
    }

    async fn report_closed_writer(&self, task: &str) {
        let publish = |kind| {
            let _ = self
                .inner
                .events
                .send(CopilotRuntimeEvent::Session(Box::new(SessionEvent {
                    thread_id: task.into(),
                    kind,
                })));
        };

        // Process termination settles live activity and approvals. The native journal
        // determines whether the last answer completed before the writer stopped.
        publish(SessionEventKind::ActivityChanged {
            status: ThreadStatus::Idle,
        });
        publish(SessionEventKind::BackgroundWorkChanged {
            background_work: false,
        });
        let _ = self.inner.events.send(CopilotRuntimeEvent::Closed {
            conversation_id: task.into(),
        });

        match self
            .read_cold(task)
            .await
            .and_then(|record| record.page(None, 8))
        {
            Ok(turns_page) => publish(SessionEventKind::ConversationReplaced { turns_page }),
            Err(error) => {
                let _ = self.inner.events.send(CopilotRuntimeEvent::Unreachable {
                    conversation_id: task.into(),
                    message: error.to_string(),
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn restart_excludes_session_operations_before_they_touch_the_runner_or_binding() {
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let client = CopilotClient::new(dir.path(), true);
        let reading = client.runtime_access().unwrap();
        assert!(
            matches!(client.restart_runtime().await, Err(AgentError::Held(reason)) if reason.contains("operation"))
        );
        drop(reading);

        let restarting = client.inner.runtime_gate.write().await;
        assert!(
            matches!(client.start_conversation("/tmp", &Default::default()).await,
            Err(AgentError::Held(reason)) if reason == "Copilot runtime is restarting.")
        );
        assert!(matches!(client.close_conversation("existing").await,
            Err(AgentError::Held(reason)) if reason == "Copilot runtime is restarting."));
        assert!(matches!(
            client.restart_runtime().await,
            Err(AgentError::Held(_))
        ));
        assert!(!dir.path().join("runner.sock").exists());
        assert!(!dir.path().join("bindings").exists());
        drop(restarting);
        assert!(client.runtime_access().is_ok());
    }
}
