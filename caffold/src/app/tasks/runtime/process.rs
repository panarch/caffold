use std::future::Future;

use tokio::sync::Mutex;

use super::{CodexConnection, TaskRuntime, TaskRuntimeSignal};
use crate::agent::codex::{
    CodexInstallation, CodexReadiness, CodexStatusResponse, CodexThreadClient, CodexThreadError,
    inspect_codex_installation,
};

#[derive(Default)]
pub(super) struct CodexProcess {
    state: Mutex<CodexProcessState>,
    readiness_check: Mutex<()>,
    lifecycle_change: Mutex<()>,
}

#[derive(Default)]
struct CodexProcessState {
    client: Option<CodexThreadClient>,
    generation: u64,
    readiness: Option<CodexReadiness>,
    #[cfg(test)]
    test_client: bool,
}

impl TaskRuntime {
    pub(in crate::app) fn startup(&self) {
        self.watch_claude();
        let runtime = self.clone();
        tokio::spawn(async move {
            let status = runtime.status().await;
            if status.readiness.blocks_task_operations {
                eprintln!(
                    "Codex is not ready for Task operations: {}",
                    status.readiness.diagnostic_message
                );
            }
        });
    }

    pub(in crate::app) async fn connection(&self) -> Result<CodexConnection, CodexThreadError> {
        let _readiness_check = self.process.readiness_check.lock().await;
        if let Some(connection) = self.classified_connection().await? {
            return Ok(connection);
        }

        let status = self.refresh_status().await;
        if status.readiness.blocks_task_operations {
            return Err(CodexThreadError::Readiness(Box::new(status.readiness)));
        }

        self.classified_connection().await?.ok_or_else(|| {
            CodexThreadError::Readiness(Box::new(CodexReadiness::blocking(
                crate::agent::codex::CodexReadinessState::Error,
                crate::agent::codex::CodexReadinessReason::ReadyRuntimeUnavailable,
                "Codex readiness passed without an available app-server connection.",
                None,
            )))
        })
    }

    async fn classified_connection(&self) -> Result<Option<CodexConnection>, CodexThreadError> {
        let process = self.process.state.lock().await;
        if let Some(readiness) = process
            .readiness
            .as_ref()
            .filter(|readiness| readiness.blocks_task_operations)
        {
            return Err(CodexThreadError::Readiness(Box::new(readiness.clone())));
        }
        if process.readiness.is_none() {
            return Ok(None);
        }
        #[cfg(test)]
        if process.test_client
            && let Some(client) = process.client.clone()
        {
            return Ok(Some(CodexConnection {
                client,
                generation: process.generation,
            }));
        }
        Ok(process.client.clone().map(|client| CodexConnection {
            client,
            generation: process.generation,
        }))
    }

    async fn connection_with_installation(
        &self,
        installation: &CodexInstallation,
    ) -> Result<CodexConnection, CodexThreadError> {
        let _lifecycle_change = self.process.lifecycle_change.lock().await;
        {
            let process = self.process.state.lock().await;
            #[cfg(test)]
            if process.test_client
                && let Some(client) = process.client.clone()
            {
                return Ok(CodexConnection {
                    client,
                    generation: process.generation,
                });
            }
            if let Some(client) = process.client.clone() {
                return Ok(CodexConnection {
                    client,
                    generation: process.generation,
                });
            }
        }

        let client = CodexThreadClient::start_with_installation(installation).await?;
        let connection = {
            let mut process = self.process.state.lock().await;
            process.generation = process.generation.saturating_add(1);
            let generation = process.generation;
            self.spawn_bridge(client.clone(), generation, self.shutdown.subscribe());
            process.client = Some(client.clone());
            CodexConnection { client, generation }
        };

        self.restore_connection_state(connection.clone());
        Ok(connection)
    }

    pub(in crate::app) async fn status(&self) -> CodexStatusResponse {
        self.status_with_diagnostics().await.0
    }

    pub(in crate::app) async fn status_with_diagnostics(&self) -> (CodexStatusResponse, u64, bool) {
        let _readiness_check = self.process.readiness_check.lock().await;
        let status = self.refresh_status().await;
        let process = self.process.state.lock().await;
        (status, process.generation, process.client.is_some())
    }

    async fn refresh_status(&self) -> CodexStatusResponse {
        let installation = match inspect_codex_installation().await {
            Ok(installation) => installation,
            Err(readiness) => {
                let status = CodexThreadClient::unavailable_status(&CodexThreadError::Readiness(
                    Box::new(readiness),
                ));
                self.set_readiness(status.readiness.clone()).await;
                return status;
            }
        };
        let status = match self.connection_with_installation(&installation).await {
            Ok(connection) => connection.client.status(&installation).await,
            Err(error) => {
                CodexThreadClient::unavailable_status_for_installation(&installation, &error)
            }
        };
        self.set_readiness(status.readiness.clone()).await;
        status
    }

    async fn set_readiness(&self, readiness: CodexReadiness) {
        self.process.state.lock().await.readiness = Some(readiness);
    }

    pub(in crate::app) async fn client(&self) -> Result<CodexThreadClient, CodexThreadError> {
        self.connection().await.map(|connection| connection.client)
    }

    /// Make Codex answer as blocked, so a test can watch what a held agent
    /// costs at the boundary that consults it.
    #[cfg(test)]
    pub(in crate::app) async fn hold_codex_readiness_for_tests(&self) {
        self.process.state.lock().await.readiness = Some(CodexReadiness::blocking(
            crate::agent::codex::CodexReadinessState::Error,
            crate::agent::codex::CodexReadinessReason::ReadyRuntimeUnavailable,
            "Codex is held for this test.",
            None,
        ));
    }

    #[cfg(test)]
    pub(in crate::app) async fn diagnostics(&self) -> (u64, bool) {
        let process = self.process.state.lock().await;
        (process.generation, process.client.is_some())
    }

    pub(in crate::app) async fn restart_daemon(
        &self,
    ) -> Result<crate::agent::codex::CodexDaemonInfo, CodexThreadError> {
        self.restart_daemon_with(CodexThreadClient::restart_daemon)
            .await
    }

    pub(super) async fn restart_daemon_with<Restart, RestartFuture>(
        &self,
        restart: Restart,
    ) -> Result<crate::agent::codex::CodexDaemonInfo, CodexThreadError>
    where
        Restart: FnOnce() -> RestartFuture,
        RestartFuture:
            Future<Output = Result<crate::agent::codex::CodexDaemonInfo, CodexThreadError>>,
    {
        let _readiness_check = self.process.readiness_check.lock().await;
        let _lifecycle_change = self.process.lifecycle_change.lock().await;
        let (generation, client) = {
            let mut process = self.process.state.lock().await;
            process.readiness = None;
            (process.generation, process.client.take())
        };
        let message = "Codex runtime is restarting.".to_string();
        let affected = self
            .sessions
            .codex_connection_lost(generation, message.clone())
            .await;
        for thread_id in affected {
            self.events.invalidate_continuity(&thread_id);
            let _ = self.signals.send(TaskRuntimeSignal::SessionUnavailable {
                thread_id,
                message: message.clone(),
            });
        }
        if let Some(client) = client {
            client.shutdown().await;
        }

        restart().await
    }

    pub(in crate::app) async fn shutdown(&self) {
        let _readiness_check = self.process.readiness_check.lock().await;
        let _lifecycle_change = self.process.lifecycle_change.lock().await;
        let client = self.process.state.lock().await.client.take();
        if let Some(client) = client {
            client.shutdown().await;
        }
    }

    /// Tell the runtime a connection failed, when the agent has one to lose.
    ///
    /// Codex serves every thread from one process, so losing it means losing
    /// every conversation at once and the runtime has to say so. A Claude
    /// session is its own process, and a failure reaching one says nothing
    /// about the rest.
    pub(in crate::app) async fn recover_connection_error_for(
        &self,
        agent: &super::TaskAgent,
        error: &crate::agent::AgentError,
    ) {
        if let Some(connection) = agent.codex()
            && let crate::agent::AgentError::Unreachable(message) = error
        {
            self.connection_unreachable(connection, message.clone())
                .await;
        }
    }

    /// The agent behind this connection cannot be reached: release every
    /// session standing on it and let the readiness check rebuild.
    async fn connection_unreachable(&self, connection: &CodexConnection, message: String) {
        let affected = self
            .sessions
            .codex_connection_lost(connection.generation, message.clone())
            .await;
        for thread_id in affected {
            self.events.invalidate_continuity(&thread_id);
            let _ = self.signals.send(TaskRuntimeSignal::SessionUnavailable {
                thread_id,
                message: message.clone(),
            });
        }
        self.process
            .invalidate_unreachable(connection.generation)
            .await;
    }

    #[cfg(test)]
    pub(in crate::app) async fn install_test_client(
        &self,
        generation: u64,
        client: CodexThreadClient,
    ) {
        let mut process = self.process.state.lock().await;
        process.generation = generation;
        process.client = Some(client);
        process.readiness = Some(CodexReadiness {
            state: crate::agent::codex::CodexReadinessState::Ready,
            blocks_task_operations: false,
            reason_code: crate::agent::codex::CodexReadinessReason::Ready,
            diagnostic_message: "Codex is ready for Task operations.".to_string(),
            minimum_supported_version: crate::agent::codex::MINIMUM_SUPPORTED_CODEX_CLI_VERSION
                .to_string(),
            detected_executable: None,
            managed_executable: None,
            running_app_server_version: Some(
                crate::agent::codex::MINIMUM_SUPPORTED_CODEX_CLI_VERSION.to_string(),
            ),
        });
        process.test_client = true;
    }

    #[cfg(test)]
    pub(in crate::app) async fn set_test_readiness(&self, readiness: CodexReadiness) {
        self.set_readiness(readiness).await;
    }

    #[cfg(test)]
    pub(in crate::app) async fn hold_process_lock_for_test(
        &self,
        entered: tokio::sync::oneshot::Sender<()>,
        duration: std::time::Duration,
    ) {
        let _process = self.process.state.lock().await;
        let _ = entered.send(());
        tokio::time::sleep(duration).await;
    }
}

impl CodexProcess {
    pub(super) async fn invalidate(&self, generation: u64) {
        let client = {
            let mut process = self.state.lock().await;
            if process.generation != generation {
                return;
            }
            process.readiness = None;
            process.client.take()
        };
        if let Some(client) = client {
            client.shutdown().await;
        }
    }

    async fn invalidate_unreachable(&self, generation: u64) -> bool {
        let client = {
            let mut process = self.state.lock().await;
            if process.generation != generation {
                return false;
            }
            process.readiness = None;
            process.client.take()
        };
        if let Some(client) = client {
            client.shutdown().await;
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::sync::broadcast;

    use super::*;
    use crate::{
        agent::codex::MockCodexResponse,
        app::tasks::{
            events::{TaskEvents, task_event_record},
            sessions::TaskSessions,
        },
        task_store::TaskStore,
    };

    fn test_runtime() -> TaskRuntime {
        let (shutdown, _) = broadcast::channel(1);
        TaskRuntime::new(
            crate::agent::claude::ClaudeClient::mock().0,
            TaskSessions::default(),
            TaskEvents::default(),
            TaskStore::memory().unwrap(),
            shutdown,
        )
    }

    #[tokio::test]
    async fn request_timeouts_keep_the_cached_codex_connection() {
        let runtime = test_runtime();
        let client = CodexThreadClient::mock(Vec::new());
        runtime.install_test_client(7, client.clone()).await;
        let agent = super::super::TaskAgent::Codex(CodexConnection {
            client,
            generation: 7,
        });
        runtime
            .recover_connection_error_for(
                &agent,
                &crate::agent::AgentError::TimedOut("thread/resume timed out".to_string()),
            )
            .await;
        assert_eq!(runtime.diagnostics().await, (7, true));
        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn transport_failures_discard_the_cached_codex_connection() {
        let runtime = test_runtime();
        let client = CodexThreadClient::mock(Vec::new());
        runtime.install_test_client(8, client.clone()).await;
        let agent = super::super::TaskAgent::Codex(CodexConnection {
            client,
            generation: 8,
        });
        runtime
            .recover_connection_error_for(
                &agent,
                &crate::agent::AgentError::Unreachable(
                    "Codex app-server is unavailable.".to_string(),
                ),
            )
            .await;
        assert_eq!(runtime.diagnostics().await, (8, false));
    }

    #[tokio::test]
    async fn transport_failures_withdraw_live_turn_completeness() {
        let runtime = test_runtime();
        let thread_id = "thread-live-gap";
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            json!({
                "thread": {
                    "id": thread_id,
                    "preview": "Live gap",
                    "status": { "type": "active", "activeFlags": [] },
                    "cwd": "/tmp",
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": [{
                        "id": "turn-live",
                        "items": [],
                        "status": "inProgress",
                        "startedAt": 2.0
                    }]
                },
                "cwd": "/tmp"
            }),
        )]);
        runtime.install_test_client(10, client.clone()).await;
        let _viewer = runtime
            .sessions
            .acquire_viewer(&client.driver(), 10, thread_id)
            .await
            .expect("the live thread is subscribed");
        runtime.events.publish(task_event_record(
            thread_id,
            "turn-live:started",
            "turn_started",
            "Turn started",
            Some(json!({
                "threadId": thread_id,
                "turnId": "turn-live",
            })),
            2_000,
        ));
        assert_eq!(runtime.events.fully_observed_turns(thread_id).len(), 1);

        let agent = super::super::TaskAgent::Codex(CodexConnection {
            client,
            generation: 10,
        });
        runtime
            .recover_connection_error_for(
                &agent,
                &crate::agent::AgentError::Unreachable(
                    "Codex app-server is unavailable.".to_string(),
                ),
            )
            .await;

        assert!(runtime.events.fully_observed_turns(thread_id).is_empty());
        assert_eq!(
            runtime.events.for_thread(thread_id).len(),
            1,
            "the report stays visible even though it no longer proves a continuous journal"
        );
    }

    #[tokio::test]
    async fn protocol_failures_keep_a_healthy_codex_connection() {
        let runtime = test_runtime();
        let client = CodexThreadClient::mock(Vec::new());
        runtime.install_test_client(9, client.clone()).await;
        let agent = super::super::TaskAgent::Codex(CodexConnection {
            client,
            generation: 9,
        });
        runtime
            .recover_connection_error_for(
                &agent,
                &crate::agent::AgentError::Failed("invalid fixture".to_string()),
            )
            .await;
        assert_eq!(runtime.diagnostics().await, (9, true));
        runtime.shutdown().await;
    }
}
