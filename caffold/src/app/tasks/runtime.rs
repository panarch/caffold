use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex as StdMutex},
};

use serde::Serialize;
use tokio::sync::{Mutex, broadcast};

use super::{events::TaskEvents, lifecycle::TaskLifecycle, push::PushService};
use crate::{
    agent::codex::{CodexThreadClient, CodexThreadError},
    agent::{Driver, TokenUsage},
    app::tasks::sessions::{SessionSnapshot, TaskSessions},
    task_store::TaskStore,
};

mod bridge;
mod process;
mod server_requests;

use process::CodexProcess;
use server_requests::PendingApproval;

#[derive(Clone)]
pub(in crate::app) struct CodexRuntime {
    process: Arc<CodexProcess>,
    sessions: TaskSessions,
    events: TaskEvents,
    task_store: TaskStore,
    lifecycle: Option<TaskLifecycle>,
    push: Option<PushService>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    usage: Arc<StdMutex<BTreeMap<String, ThreadUsageDiagnostics>>>,
    signals: broadcast::Sender<CodexRuntimeSignal>,
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

#[derive(Clone)]
pub(in crate::app) enum CodexRuntimeSignal {
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

impl CodexRuntime {
    pub(in crate::app) fn new(
        sessions: TaskSessions,
        events: TaskEvents,
        task_store: TaskStore,
        shutdown: broadcast::Sender<()>,
    ) -> Self {
        let (signals, _) = broadcast::channel(64);
        Self {
            process: Arc::new(CodexProcess::default()),
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

    pub(in crate::app) fn with_lifecycle(mut self, lifecycle: TaskLifecycle) -> Self {
        self.lifecycle = Some(lifecycle);
        self
    }

    pub(in crate::app) fn with_push_service(mut self, push: PushService) -> Self {
        self.push = Some(push);
        self
    }

    pub(in crate::app) fn subscribe(&self) -> broadcast::Receiver<CodexRuntimeSignal> {
        self.signals.subscribe()
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

    fn test_runtime(store: TaskStore) -> CodexRuntime {
        let (shutdown, _) = broadcast::channel(1);
        CodexRuntime::new(
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
        let runtime = CodexRuntime::new(sessions.clone(), events, store, shutdown);
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
            Ok(CodexRuntimeSignal::SessionUnavailable { thread_id, message })
                if thread_id == "thread_restart" && message == "Codex runtime is restarting."
        ));
    }
}
