use std::future::Future;
use std::sync::Arc;
#[cfg(test)]
use std::time::Duration;

use tokio::sync::Mutex;
#[cfg(test)]
use tokio::sync::{MutexGuard, oneshot};

#[cfg(test)]
use super::MINIMUM_SUPPORTED_CODEX_CLI_VERSION;
use super::{
    CodexDaemonInfo, CodexInstallation, CodexMcpBindings, CodexReadiness, CodexReadinessReason,
    CodexReadinessState, CodexStatusResponse, CodexThreadClient, CodexThreadError,
    CodexUpdateOutcome, CodexUpdateReport, inspect_codex_installation,
};
use crate::agent::{AgentError, Driver};

/// Codex as Caffold reaches it: the one app-server proxy every Codex thread is
/// served through, what the latest readiness check found, and the restarts and
/// updates that replace the proxy.
///
/// Claude and Grok keep their processes inside their own clients; this is
/// Codex's. Codex serves every thread from one process, so a connection made
/// or lost is news for every session on it. What that news means for those
/// sessions belongs to whoever runs them, told through a
/// [`CodexConnectionObserver`] at the moment it happens.
#[derive(Clone, Default)]
pub(crate) struct CodexClient {
    process: Arc<CodexProcess>,
    mcp: Option<CodexMcpBindings>,
}

/// What the application does as Codex's shared connection comes and goes.
///
/// Each is called at the same point and under the same locks as the change
/// it reports, so a new connection's events are carried before anything can
/// ask it, and every session hears of a replacement before it starts.
pub(crate) trait CodexConnectionObserver {
    /// Carry a new connection's events, before anything else can use it.
    fn attach(&self, client: CodexThreadClient, generation: u64);
    /// Take a new connection up where the previous one left off.
    fn connected(&self, connection: CodexConnection);
    /// Every session on this generation lost its connection, for this reason.
    fn lost(&self, generation: u64, message: String) -> impl Future<Output = ()> + Send;
}

#[derive(Clone)]
pub(crate) struct CodexConnection {
    pub(crate) client: CodexThreadClient,
    pub(crate) generation: u64,
}

impl CodexConnection {
    /// This connection as the agent it reaches.
    pub(crate) fn driver(&self) -> Driver {
        self.client.driver()
    }
}

#[derive(Default)]
struct CodexProcess {
    state: Mutex<CodexProcessState>,
    readiness_check: Mutex<()>,
    lifecycle_change: Mutex<()>,
    #[cfg(test)]
    test_checks: std::sync::Mutex<Option<TestChecks>>,
}

#[derive(Default)]
struct CodexProcessState {
    client: Option<CodexThreadClient>,
    generation: u64,
    readiness: Option<CodexReadiness>,
    /// How many readiness answers have been recorded. A request that waited
    /// for a check compares it with what it saw before waiting, so requests
    /// that arrive together share one check instead of each running their own.
    readiness_answers: u64,
    #[cfg(test)]
    test_client: bool,
}

/// What a test makes every readiness check answer, and how many ran.
#[cfg(test)]
struct TestChecks {
    answer: CodexReadiness,
    run: usize,
}

impl CodexClient {
    /// Serve Caffold's MCP tools to every connection this client makes.
    pub(crate) fn with_mcp(self, bindings: CodexMcpBindings) -> Self {
        Self {
            mcp: Some(bindings),
            ..self
        }
    }

    /// Codex's shared connection, checked again whenever the last answer was
    /// not a usable one.
    ///
    /// A usable connection does not wait for a status check holding the
    /// readiness lock. Anything else is asked afresh, the way an agent without
    /// a remembered answer is: a remembered block may have been fixed since.
    /// Requests that arrive while a check runs take that check's answer.
    pub(crate) async fn connection(
        &self,
        observer: &impl CodexConnectionObserver,
    ) -> Result<CodexConnection, CodexThreadError> {
        if let Ok(Some(connection)) = self.classified_connection().await {
            return Ok(connection);
        }
        let answers_before = self.readiness_answers().await;
        let _readiness_check = self.process.readiness_check.lock().await;
        if self.readiness_answers().await != answers_before
            && let Some(connection) = self.classified_connection().await?
        {
            return Ok(connection);
        }

        let status = self.refresh_status(observer).await;
        if status.readiness.blocks_task_operations {
            return Err(CodexThreadError::Readiness(Box::new(status.readiness)));
        }

        self.classified_connection().await?.ok_or_else(|| {
            CodexThreadError::Readiness(Box::new(CodexReadiness::blocking(
                CodexReadinessState::Error,
                CodexReadinessReason::ReadyRuntimeUnavailable,
                "Codex readiness passed without an available app-server connection.",
                None,
            )))
        })
    }

    /// What the latest readiness check found, without checking again or
    /// waiting for a check in flight. Nothing when none has finished yet.
    pub(crate) async fn remembered_readiness(&self) -> Option<CodexReadiness> {
        self.process.state.lock().await.readiness.clone()
    }

    /// The connection, only when it is already usable: no check is started and
    /// none in flight is waited for.
    pub(crate) async fn usable_connection(&self) -> Option<CodexConnection> {
        self.classified_connection().await.ok().flatten()
    }

    async fn readiness_answers(&self) -> u64 {
        self.process.state.lock().await.readiness_answers
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
        observer: &impl CodexConnectionObserver,
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

        let client = match &self.mcp {
            Some(bindings) => {
                CodexThreadClient::start_with_installation_and_mcp(installation, bindings.clone())
                    .await?
            }
            None => CodexThreadClient::start_with_installation(installation).await?,
        };
        let connection = {
            let mut process = self.process.state.lock().await;
            process.generation = process.generation.saturating_add(1);
            let generation = process.generation;
            observer.attach(client.clone(), generation);
            process.client = Some(client.clone());
            CodexConnection { client, generation }
        };

        observer.connected(connection.clone());
        Ok(connection)
    }

    pub(crate) async fn status_with_diagnostics(
        &self,
        observer: &impl CodexConnectionObserver,
    ) -> (CodexStatusResponse, u64, bool) {
        let _readiness_check = self.process.readiness_check.lock().await;
        let status = self.refresh_status(observer).await;
        let process = self.process.state.lock().await;
        (status, process.generation, process.client.is_some())
    }

    /// Observe the existing proxy without making a diagnostic request start one.
    pub(crate) async fn diagnostic_connection(&self) -> Option<CodexConnection> {
        let process = self.process.state.lock().await;
        process.client.clone().map(|client| CodexConnection {
            client,
            generation: process.generation,
        })
    }

    async fn refresh_status(&self, observer: &impl CodexConnectionObserver) -> CodexStatusResponse {
        #[cfg(test)]
        if let Some(readiness) = self.test_check_answer() {
            let status = CodexThreadClient::unavailable_status(&CodexThreadError::Readiness(
                Box::new(readiness),
            ));
            self.set_readiness(status.readiness.clone()).await;
            return status;
        }
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
        let status = match self
            .connection_with_installation(&installation, observer)
            .await
        {
            Ok(connection) => connection.client.status(&installation).await,
            Err(error) => {
                CodexThreadClient::unavailable_status_for_installation(&installation, &error)
            }
        };
        self.set_readiness(status.readiness.clone()).await;
        status
    }

    async fn set_readiness(&self, readiness: CodexReadiness) {
        let mut process = self.process.state.lock().await;
        process.readiness = Some(readiness);
        process.readiness_answers = process.readiness_answers.wrapping_add(1);
    }

    pub(crate) async fn restart_daemon_with<Restart, RestartFuture>(
        &self,
        observer: &impl CodexConnectionObserver,
        restart: Restart,
    ) -> Result<CodexDaemonInfo, CodexThreadError>
    where
        Restart: FnOnce() -> RestartFuture,
        RestartFuture: Future<Output = Result<CodexDaemonInfo, CodexThreadError>>,
    {
        self.replace_runtime_with(observer, "Codex runtime is restarting.", restart)
            .await
    }

    pub(crate) async fn update_daemon_with<Update, UpdateFuture>(
        &self,
        observer: &impl CodexConnectionObserver,
        update: Update,
    ) -> Result<CodexUpdateOutcome, CodexThreadError>
    where
        Update: FnOnce() -> UpdateFuture,
        UpdateFuture: Future<Output = Result<CodexUpdateOutcome, CodexThreadError>>,
    {
        self.replace_runtime_with(observer, "Codex runtime is updating.", update)
            .await
    }

    /// Lets go of the Codex connection and tells every session on it why,
    /// then runs a command that may replace the shared runtime. The next
    /// status request connects again. Holding both locks keeps a restart and
    /// an update from overlapping, and makes other Codex requests wait.
    async fn replace_runtime_with<Outcome, Command, CommandFuture>(
        &self,
        observer: &impl CodexConnectionObserver,
        message: &str,
        command: Command,
    ) -> Result<Outcome, CodexThreadError>
    where
        Command: FnOnce() -> CommandFuture,
        CommandFuture: Future<Output = Result<Outcome, CodexThreadError>>,
    {
        let _readiness_check = self.process.readiness_check.lock().await;
        let _lifecycle_change = self.process.lifecycle_change.lock().await;
        let (generation, client) = {
            let mut process = self.process.state.lock().await;
            process.readiness = None;
            (process.generation, process.client.take())
        };
        observer.lost(generation, message.to_string()).await;
        if let Some(client) = client {
            client.shutdown().await;
        }

        command().await
    }

    /// What Settings shows about keeping Codex current. Asking starts no
    /// Codex connection.
    pub(crate) async fn update_report(&self) -> CodexUpdateReport {
        CodexThreadClient::update_report(self.running_version().await).await
    }

    /// The app-server version the latest readiness check saw. Asking the
    /// daemon itself fails whenever it is not running.
    pub(crate) async fn running_version(&self) -> Option<String> {
        self.process
            .state
            .lock()
            .await
            .readiness
            .as_ref()
            .and_then(|readiness| readiness.running_app_server_version.clone())
    }

    pub(crate) async fn shutdown(&self) {
        let _readiness_check = self.process.readiness_check.lock().await;
        let _lifecycle_change = self.process.lifecycle_change.lock().await;
        let client = self.process.state.lock().await.client.take();
        if let Some(client) = client {
            client.shutdown().await;
        }
    }

    /// Tell Codex a request on this connection failed.
    ///
    /// Codex serves every thread from one process, so losing it means losing
    /// every conversation at once and the sessions have to hear so. A request
    /// that timed out or was refused leaves a healthy connection in place.
    pub(crate) async fn connection_failed(
        &self,
        connection: &CodexConnection,
        error: &AgentError,
        observer: &impl CodexConnectionObserver,
    ) {
        if let AgentError::Unreachable(message) = error {
            self.connection_unreachable(connection, message.clone(), observer)
                .await;
        }
    }

    /// The agent behind this connection cannot be reached: release every
    /// session standing on it and let the readiness check rebuild.
    async fn connection_unreachable(
        &self,
        connection: &CodexConnection,
        message: String,
        observer: &impl CodexConnectionObserver,
    ) {
        observer.lost(connection.generation, message).await;
        self.invalidate_unreachable(connection.generation).await;
    }

    pub(crate) async fn invalidate(&self, generation: u64) {
        let client = {
            let mut process = self.process.state.lock().await;
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
            let mut process = self.process.state.lock().await;
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

    #[cfg(test)]
    pub(crate) async fn install_test_client(&self, generation: u64, client: CodexThreadClient) {
        let mut process = self.process.state.lock().await;
        process.generation = generation;
        process.client = Some(client);
        process.readiness_answers = process.readiness_answers.wrapping_add(1);
        process.readiness = Some(CodexReadiness {
            state: CodexReadinessState::Ready,
            blocks_task_operations: false,
            reason_code: CodexReadinessReason::Ready,
            diagnostic_message: "Codex is ready for Task operations.".to_string(),
            minimum_supported_version: MINIMUM_SUPPORTED_CODEX_CLI_VERSION.to_string(),
            detected_executable: None,
            managed_executable: None,
            running_app_server_version: Some(MINIMUM_SUPPORTED_CODEX_CLI_VERSION.to_string()),
        });
        process.test_client = true;
    }

    /// Make Codex's readiness this, now and whenever it is checked again.
    #[cfg(test)]
    pub(crate) async fn set_test_readiness(&self, readiness: CodexReadiness) {
        self.answer_checks_with(readiness.clone());
        self.set_readiness(readiness).await;
    }

    /// Make Codex answer as blocked, so a test can watch what a held agent
    /// costs at the boundary that consults it.
    #[cfg(test)]
    pub(crate) async fn hold_readiness_for_tests(&self) {
        self.set_test_readiness(held_readiness()).await;
    }

    /// Make every readiness check answer this, without inspecting the machine.
    #[cfg(test)]
    fn answer_checks_with(&self, answer: CodexReadiness) {
        *self.process.test_checks.lock().unwrap() = Some(TestChecks { answer, run: 0 });
    }

    #[cfg(test)]
    fn test_check_answer(&self) -> Option<CodexReadiness> {
        let mut checks = self.process.test_checks.lock().unwrap();
        let checks = checks.as_mut()?;
        checks.run += 1;
        Some(checks.answer.clone())
    }

    #[cfg(test)]
    fn checks_run(&self) -> usize {
        self.process
            .test_checks
            .lock()
            .unwrap()
            .as_ref()
            .map_or(0, |checks| checks.run)
    }

    #[cfg(test)]
    pub(crate) async fn diagnostics(&self) -> (u64, bool) {
        let process = self.process.state.lock().await;
        (process.generation, process.client.is_some())
    }

    /// Hold the readiness lock the way a status check in flight does.
    #[cfg(test)]
    pub(crate) async fn hold_status_check_for_test(&self) -> MutexGuard<'_, ()> {
        self.process.readiness_check.lock().await
    }

    #[cfg(test)]
    pub(crate) async fn hold_process_lock_for_test(
        &self,
        entered: oneshot::Sender<()>,
        duration: Duration,
    ) {
        let _process = self.process.state.lock().await;
        let _ = entered.send(());
        tokio::time::sleep(duration).await;
    }
}

#[cfg(test)]
fn held_readiness() -> CodexReadiness {
    CodexReadiness::blocking(
        CodexReadinessState::Error,
        CodexReadinessReason::ReadyRuntimeUnavailable,
        "Codex is held for this test.",
        None,
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use tokio::time::timeout;

    use super::*;

    /// Records what the client tells the application, and does nothing else.
    #[derive(Default)]
    struct RecordingObserver {
        lost: StdMutex<Vec<(u64, String)>>,
    }

    impl CodexConnectionObserver for RecordingObserver {
        fn attach(&self, _client: CodexThreadClient, _generation: u64) {}

        fn connected(&self, _connection: CodexConnection) {}

        async fn lost(&self, generation: u64, message: String) {
            self.lost.lock().unwrap().push((generation, message));
        }
    }

    fn connection(client: &CodexThreadClient, generation: u64) -> CodexConnection {
        CodexConnection {
            client: client.clone(),
            generation,
        }
    }

    #[tokio::test]
    async fn codex_diagnostic_connection_does_not_start_a_codex_proxy() {
        let codex = CodexClient::default();

        assert!(codex.diagnostic_connection().await.is_none());
        assert_eq!(codex.diagnostics().await, (0, false));
    }

    #[tokio::test]
    async fn request_timeouts_keep_the_cached_codex_connection() {
        let codex = CodexClient::default();
        let observer = RecordingObserver::default();
        let client = CodexThreadClient::mock(Vec::new());
        codex.install_test_client(7, client.clone()).await;
        codex
            .connection_failed(
                &connection(&client, 7),
                &AgentError::TimedOut("thread/resume timed out".to_string()),
                &observer,
            )
            .await;
        assert_eq!(codex.diagnostics().await, (7, true));
        assert!(observer.lost.lock().unwrap().is_empty());
        codex.shutdown().await;
    }

    #[tokio::test]
    async fn transport_failures_discard_the_cached_codex_connection() {
        let codex = CodexClient::default();
        let observer = RecordingObserver::default();
        let client = CodexThreadClient::mock(Vec::new());
        codex.install_test_client(8, client.clone()).await;
        codex
            .connection_failed(
                &connection(&client, 8),
                &AgentError::Unreachable("Codex app-server is unavailable.".to_string()),
                &observer,
            )
            .await;
        assert_eq!(codex.diagnostics().await, (8, false));
        assert_eq!(
            *observer.lost.lock().unwrap(),
            vec![(8, "Codex app-server is unavailable.".to_string())],
        );
    }

    #[tokio::test]
    async fn protocol_failures_keep_a_healthy_codex_connection() {
        let codex = CodexClient::default();
        let observer = RecordingObserver::default();
        let client = CodexThreadClient::mock(Vec::new());
        codex.install_test_client(9, client.clone()).await;
        codex
            .connection_failed(
                &connection(&client, 9),
                &AgentError::Failed("invalid fixture".to_string()),
                &observer,
            )
            .await;
        assert_eq!(codex.diagnostics().await, (9, true));
        assert!(observer.lost.lock().unwrap().is_empty());
        codex.shutdown().await;
    }

    #[tokio::test]
    async fn a_usable_connection_does_not_wait_for_a_status_check_in_flight() {
        let codex = CodexClient::default();
        let observer = RecordingObserver::default();
        codex
            .install_test_client(11, CodexThreadClient::mock(Vec::new()))
            .await;
        let _status_check = codex.process.readiness_check.lock().await;

        let connection = timeout(Duration::from_secs(1), codex.connection(&observer))
            .await
            .expect("a usable connection answers while a status check holds the lock")
            .expect("the installed client is usable");

        assert_eq!(connection.generation, 11);
    }

    #[tokio::test]
    async fn a_blocked_answer_takes_what_the_status_check_in_flight_leaves() {
        let codex = CodexClient::default();
        let observer = RecordingObserver::default();
        codex
            .install_test_client(12, CodexThreadClient::mock(Vec::new()))
            .await;
        codex.hold_readiness_for_tests().await;
        let status_check = codex.process.readiness_check.lock().await;
        let mut connection = Box::pin(codex.connection(&observer));

        assert!(
            timeout(Duration::from_millis(50), &mut connection)
                .await
                .is_err(),
            "a blocked answer waits for the check that may clear it"
        );

        codex
            .install_test_client(13, CodexThreadClient::mock(Vec::new()))
            .await;
        drop(status_check);
        let connection = connection
            .await
            .expect("the check left a usable connection");
        assert_eq!(connection.generation, 13);
    }

    #[tokio::test]
    async fn a_remembered_block_is_checked_again() {
        let codex = CodexClient::default();
        let observer = RecordingObserver::default();
        codex
            .install_test_client(14, CodexThreadClient::mock(Vec::new()))
            .await;
        codex.hold_readiness_for_tests().await;
        codex.answer_checks_with(ready_readiness());

        let connection = codex
            .connection(&observer)
            .await
            .expect("the check finds Codex usable again");

        assert_eq!(connection.generation, 14);
        assert_eq!(codex.checks_run(), 1);
    }

    #[tokio::test]
    async fn requests_that_arrive_together_share_one_check() {
        let codex = CodexClient::default();
        let observer = RecordingObserver::default();
        codex.hold_readiness_for_tests().await;
        let status_check = codex.process.readiness_check.lock().await;
        let mut requests = [
            Box::pin(codex.connection(&observer)),
            Box::pin(codex.connection(&observer)),
            Box::pin(codex.connection(&observer)),
        ];
        for request in &mut requests {
            assert!(
                timeout(Duration::from_millis(50), request).await.is_err(),
                "each request waits for the check in flight"
            );
        }

        drop(status_check);
        for request in requests {
            assert!(matches!(
                request.await,
                Err(CodexThreadError::Readiness(readiness)) if readiness.blocks_task_operations
            ));
        }
        assert_eq!(
            codex.checks_run(),
            1,
            "the first request checks and the others take its answer"
        );
    }

    fn ready_readiness() -> CodexReadiness {
        CodexReadiness {
            state: CodexReadinessState::Ready,
            blocks_task_operations: false,
            reason_code: CodexReadinessReason::Ready,
            diagnostic_message: "Codex is ready for Task operations.".to_string(),
            minimum_supported_version: MINIMUM_SUPPORTED_CODEX_CLI_VERSION.to_string(),
            detected_executable: None,
            managed_executable: None,
            running_app_server_version: None,
        }
    }
}
