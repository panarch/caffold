use std::future::Future;

use tokio::sync::Mutex;

use super::{CodexConnection, CodexRuntime, CodexRuntimeSignal};
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

impl CodexRuntime {
    pub(in crate::app) fn startup(&self) {
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
            .connection_lost(generation, message.clone())
            .await;
        for thread_id in affected {
            let _ = self.signals.send(CodexRuntimeSignal::SessionUnavailable {
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

    pub(in crate::app) async fn recover_connection_error(
        &self,
        connection: &CodexConnection,
        error: &CodexThreadError,
    ) {
        if !error.is_connection_failure() {
            return;
        }
        let message = error.to_string();
        let affected = self
            .sessions
            .connection_lost(connection.generation, message.clone())
            .await;
        for thread_id in affected {
            let _ = self.signals.send(CodexRuntimeSignal::SessionUnavailable {
                thread_id,
                message: message.clone(),
            });
        }
        self.process
            .invalidate_after_error(connection.generation, error)
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

    async fn invalidate_after_error(&self, generation: u64, error: &CodexThreadError) -> bool {
        if !error.is_connection_failure() {
            return false;
        }
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
    use tokio::sync::broadcast;

    use super::*;
    use crate::{
        app::tasks::events::TaskEvents, app::tasks::sessions::TaskSessions, task_store::TaskStore,
    };

    fn test_runtime() -> CodexRuntime {
        let (shutdown, _) = broadcast::channel(1);
        CodexRuntime::new(
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
        runtime
            .recover_connection_error(
                &CodexConnection {
                    client,
                    generation: 7,
                },
                &CodexThreadError::RequestTimeout {
                    method: "thread/resume",
                    request_id: 1,
                    timeout_ms: 120_000,
                },
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
        runtime
            .recover_connection_error(
                &CodexConnection {
                    client,
                    generation: 8,
                },
                &CodexThreadError::ProcessUnavailable,
            )
            .await;
        assert_eq!(runtime.diagnostics().await, (8, false));
    }

    #[tokio::test]
    async fn protocol_failures_keep_a_healthy_codex_connection() {
        let runtime = test_runtime();
        let client = CodexThreadClient::mock(Vec::new());
        runtime.install_test_client(9, client.clone()).await;
        runtime
            .recover_connection_error(
                &CodexConnection {
                    client,
                    generation: 9,
                },
                &CodexThreadError::InvalidParams("invalid fixture".to_string()),
            )
            .await;
        assert_eq!(runtime.diagnostics().await, (9, true));
        runtime.shutdown().await;
    }
}
