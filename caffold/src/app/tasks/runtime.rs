use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex as StdMutex},
};

use serde::Serialize;
use tokio::sync::{Mutex, broadcast};

use super::{events::TaskEvents, lifecycle::TaskLifecycle, push::PushService};
use crate::{
    agent::claude::ClaudeClient,
    agent::codex::{CodexThreadClient, CodexThreadError},
    agent::{Driver, TokenUsage},
    app::tasks::sessions::{SessionSnapshot, TaskSessions},
    task_store::{RunBy, TaskStore},
};

mod bridge;
mod claude_bridge;
mod process;
mod server_requests;

use process::CodexProcess;
use server_requests::PendingApproval;

/// Everything a Task is run through, whichever agent runs it.
///
/// It is not one agent's: it holds the Codex process and the Claude client
/// side by side and hands out whichever a Task belongs to. The things inside it
/// that are named after Codex really are Codex's — `CodexProcess` is the
/// app-server proxy and nothing else has one, because Claude has no daemon to
/// proxy.
#[derive(Clone)]
pub(in crate::app) struct TaskRuntime {
    process: Arc<CodexProcess>,
    claude: ClaudeClient,
    sessions: TaskSessions,
    events: TaskEvents,
    task_store: TaskStore,
    lifecycle: Option<TaskLifecycle>,
    push: Option<PushService>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    usage: Arc<StdMutex<BTreeMap<String, ThreadUsageDiagnostics>>>,
    signals: broadcast::Sender<TaskRuntimeSignal>,
    shutdown: broadcast::Sender<()>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct CodexUsageDiagnostics {
    pub(in crate::app) threads: BTreeMap<String, ThreadUsageDiagnostics>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct ThreadUsageDiagnostics {
    pub(in crate::app) turn_id: String,
    pub(in crate::app) token_usage: TokenUsage,
}

#[derive(Clone)]
pub(in crate::app) struct CodexConnection {
    pub(in crate::app) client: CodexThreadClient,
    pub(in crate::app) generation: u64,
}

impl CodexConnection {
    /// This connection as the agent it reaches.
    pub(in crate::app) fn driver(&self) -> Driver {
        self.client.driver()
    }
}

/// The agent that owns one Task, ready to be asked about it.
///
/// Which agent that is comes from the Task itself, so nothing above this has to
/// carry it: a Codex Task is reached through the app-server connection, and a
/// Claude Task through the runner, and neither one needs the other to be
/// working.
#[derive(Clone)]
pub(in crate::app) enum TaskAgent {
    Codex(CodexConnection),
    Claude { driver: Driver },
}

/// Which connection a Claude answer came from.
///
/// Codex counts connections because one process serves every thread and is
/// replaced whole. A Claude session is its own process, reached on its own
/// connection, so there is nothing for a generation to tell apart.
const CLAUDE_GENERATION: u64 = 1;

impl TaskAgent {
    pub(in crate::app) fn driver(&self) -> Driver {
        match self {
            Self::Codex(connection) => connection.driver(),
            Self::Claude { driver } => driver.clone(),
        }
    }

    pub(in crate::app) fn generation(&self) -> u64 {
        match self {
            Self::Codex(connection) => connection.generation,
            Self::Claude { .. } => CLAUDE_GENERATION,
        }
    }

    /// How a Task started under this agent will be run.
    ///
    /// Codex holds a thread's working directory and answers for it, so a second
    /// copy in the store would only go stale. Claude has nobody else to ask.
    pub(in crate::app) fn run_by(&self, cwd: &str) -> RunBy {
        match self {
            Self::Codex(_) => RunBy::Codex,
            Self::Claude { .. } => RunBy::Claude {
                cwd: cwd.to_string(),
            },
        }
    }

    /// The app-server connection, when this Task is Codex's.
    ///
    /// Reading a rollout file, renaming a thread, and recovering a lost
    /// connection are all Codex's own, and a Claude Task simply has none of
    /// them.
    pub(in crate::app) fn codex(&self) -> Option<&CodexConnection> {
        match self {
            Self::Codex(connection) => Some(connection),
            Self::Claude { .. } => None,
        }
    }
}

/// Something that happened to a session, told to whoever is watching it.
///
/// Neither of these asks which agent the session belongs to, and neither
/// should: a session that changed and a session that can no longer be reached
/// are the same news either way.
#[derive(Clone)]
pub(in crate::app) enum TaskRuntimeSignal {
    SessionChanged {
        thread_id: String,
        snapshot: Box<SessionSnapshot>,
    },
    SessionUnavailable {
        thread_id: String,
        message: String,
    },
}

#[derive(Debug)]
pub(in crate::app) enum ApprovalResolveError {
    NotFound,
    ThreadMismatch,
    ResolutionMismatch,
    Codex(CodexThreadError),
}

impl From<CodexThreadError> for ApprovalResolveError {
    fn from(error: CodexThreadError) -> Self {
        Self::Codex(error)
    }
}

impl TaskRuntime {
    pub(in crate::app) fn new(
        claude: ClaudeClient,
        sessions: TaskSessions,
        events: TaskEvents,
        task_store: TaskStore,
        shutdown: broadcast::Sender<()>,
    ) -> Self {
        let (signals, _) = broadcast::channel(64);
        Self {
            process: Arc::new(CodexProcess::default()),
            claude,
            sessions,
            events,
            task_store,
            lifecycle: None,
            push: None,
            approvals: Arc::new(Mutex::new(HashMap::new())),
            usage: Arc::new(StdMutex::new(BTreeMap::new())),
            signals,
            shutdown,
        }
    }

    /// Begin carrying what Claude sessions say into the Task application.
    ///
    /// Claude has no connection to wait for — sessions are started one at a
    /// time and report from the moment the client exists — so this is armed at
    /// startup rather than when a connection appears. It is separate from
    /// construction because constructing a runtime is not by itself proof of a
    /// running executor.
    pub(in crate::app) fn watch_claude(&self) {
        self.spawn_claude_bridge(self.shutdown.subscribe());
        self.take_up_live_conversations();
    }

    pub(in crate::app) fn with_lifecycle(mut self, lifecycle: TaskLifecycle) -> Self {
        self.lifecycle = Some(lifecycle);
        self
    }

    pub(in crate::app) fn with_push_service(mut self, push: PushService) -> Self {
        self.push = Some(push);
        self
    }

    pub(in crate::app) fn subscribe(&self) -> broadcast::Receiver<TaskRuntimeSignal> {
        self.signals.subscribe()
    }

    /// Claude, however it is being reached.
    pub(in crate::app) fn claude(&self) -> &ClaudeClient {
        &self.claude
    }

    /// The agent that owns this Task.
    ///
    /// The Task says which one, so a Claude Task is never held up by Codex
    /// being unready and a Codex Task never waits on a runner.
    pub(in crate::app) async fn task_agent(
        &self,
        thread_id: &str,
    ) -> Result<TaskAgent, CodexThreadError> {
        let store = self.task_store.clone();
        let wanted = thread_id.to_string();
        let managed = tokio::task::spawn_blocking(move || store.get(&wanted))
            .await
            .map_err(|error| CodexThreadError::Agent(format!("task store worker failed: {error}")))?
            .map_err(|error| CodexThreadError::Agent(error.to_string()))?;
        match managed {
            Some(managed) => self.agent_for(&managed.run_by).await,
            // A Task Caffold does not have a row for is not one it can route,
            // and every Task it does have a row for predating a second agent is
            // Codex's.
            None => Ok(TaskAgent::Codex(self.connection().await?)),
        }
    }

    /// The agent that runs a Task, from the row that says so.
    ///
    /// Looking a Task up by name finds it only while it is active, so anything
    /// working on a Task that has been put away — restoring it, deleting it,
    /// listing what has been archived — already holds the row and asks with it.
    /// Asking by name there would find nothing and fall back to Codex, which
    /// for a Claude Task is the wrong agent rather than no answer.
    pub(in crate::app) async fn agent_for(
        &self,
        run_by: &RunBy,
    ) -> Result<TaskAgent, CodexThreadError> {
        match run_by {
            RunBy::Claude { cwd } => Ok(TaskAgent::Claude {
                driver: self.claude.driver(cwd.clone()),
            }),
            RunBy::Codex => Ok(TaskAgent::Codex(self.connection().await?)),
        }
    }

    pub(in crate::app) fn usage_diagnostics(&self) -> CodexUsageDiagnostics {
        let threads = self
            .usage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        CodexUsageDiagnostics { threads }
    }

    fn record_token_usage(&self, thread_id: &str, turn_id: &str, token_usage: &TokenUsage) {
        self.usage
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(
                thread_id.to_string(),
                ThreadUsageDiagnostics {
                    turn_id: turn_id.to_string(),
                    token_usage: token_usage.clone(),
                },
            );
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent::codex::{CodexDaemonInfo, CodexReadiness, MockCodexResponse};

    fn test_runtime(store: TaskStore) -> TaskRuntime {
        let (shutdown, _) = broadcast::channel(1);
        TaskRuntime::new(
            crate::agent::claude::ClaudeClient::mock().0,
            TaskSessions::default(),
            TaskEvents::default(),
            store,
            shutdown,
        )
    }

    #[tokio::test]
    async fn canonical_blocking_readiness_gates_task_connections() {
        let runtime = test_runtime(TaskStore::memory().expect("in-memory task store"));
        runtime
            .install_test_client(3, CodexThreadClient::mock(Vec::new()))
            .await;
        let readiness = CodexReadiness::blocking(
            crate::agent::codex::CodexReadinessState::UpdateRequired,
            crate::agent::codex::CodexReadinessReason::VersionBelowMinimum,
            "Codex must be updated before Task operations can run.",
            None,
        );
        runtime.set_test_readiness(readiness.clone()).await;

        let error = match runtime.connection().await {
            Ok(_) => panic!("blocking readiness must gate the installed test client"),
            Err(error) => error,
        };

        assert!(matches!(
            error,
            CodexThreadError::Readiness(actual) if *actual == readiness
        ));
    }

    #[tokio::test]
    async fn daemon_restart_releases_the_existing_proxy_before_running_command() {
        let runtime = test_runtime(TaskStore::memory().expect("in-memory task store"));
        runtime
            .install_test_client(7, CodexThreadClient::mock(Vec::new()))
            .await;
        assert_eq!(runtime.diagnostics().await, (7, true));

        let daemon = runtime
            .restart_daemon_with(|| async {
                Ok(CodexDaemonInfo {
                    status: "restarted".to_string(),
                    backend: Some("pid".to_string()),
                    pid: Some(4271),
                    managed_codex_path: None,
                    managed_codex_version: Some("0.147.0".to_string()),
                    socket_path: None,
                    cli_version: Some("0.147.0".to_string()),
                    app_server_version: Some("0.147.0".to_string()),
                })
            })
            .await
            .expect("restart result");

        assert_eq!(daemon.status, "restarted");
        assert_eq!(runtime.diagnostics().await, (7, false));
    }

    #[tokio::test]
    async fn failed_daemon_restart_leaves_the_stale_proxy_released_for_recovery() {
        let runtime = test_runtime(TaskStore::memory().expect("in-memory task store"));
        runtime
            .install_test_client(11, CodexThreadClient::mock(Vec::new()))
            .await;

        let error = runtime
            .restart_daemon_with(|| async {
                Err(CodexThreadError::StartFailed(
                    "daemon restart failed".to_string(),
                ))
            })
            .await
            .expect_err("restart failure");

        assert!(error.to_string().contains("daemon restart failed"));
        assert_eq!(runtime.diagnostics().await, (11, false));
    }

    #[tokio::test]
    async fn daemon_restart_marks_subscribed_sessions_unavailable() {
        let sessions = TaskSessions::default();
        let events = TaskEvents::default();
        let store = TaskStore::memory().expect("in-memory task store");
        let (shutdown, _) = broadcast::channel(1);
        let runtime = TaskRuntime::new(
            crate::agent::claude::ClaudeClient::mock().0,
            sessions.clone(),
            events,
            store,
            shutdown,
        );
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            json!({
                "cwd": "Workspace/rust/codger",
                "thread": {
                    "id": "thread_restart",
                    "preview": "Restart recovery",
                    "status": { "type": "idle" },
                    "cwd": "Workspace/rust/codger",
                    "createdAt": 1.0,
                    "updatedAt": 1.0,
                    "turns": []
                },
                "initialTurnsPage": {
                    "data": [],
                    "nextCursor": null,
                    "backwardsCursor": null
                }
            }),
        )]);
        runtime.install_test_client(13, client.clone()).await;
        sessions
            .ensure_subscribed(&client.driver(), 13, "thread_restart")
            .await
            .expect("subscribed session");
        let mut signals = runtime.subscribe();

        runtime
            .restart_daemon_with(|| async {
                Ok(CodexDaemonInfo {
                    status: "restarted".to_string(),
                    backend: None,
                    pid: None,
                    managed_codex_path: None,
                    managed_codex_version: None,
                    socket_path: None,
                    cli_version: None,
                    app_server_version: None,
                })
            })
            .await
            .expect("restart result");

        let snapshot = sessions
            .snapshot("thread_restart")
            .await
            .expect("session snapshot");
        assert_eq!(
            snapshot.lifecycle,
            crate::app::tasks::sessions::SessionLifecycle::Error
        );
        assert_eq!(
            snapshot.last_error.as_deref(),
            Some("Codex runtime is restarting.")
        );
        assert!(matches!(
            signals.try_recv(),
            Ok(TaskRuntimeSignal::SessionUnavailable { thread_id, message })
                if thread_id == "thread_restart" && message == "Codex runtime is restarting."
        ));
    }
}
