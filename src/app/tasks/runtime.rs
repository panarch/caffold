use std::{collections::HashMap, sync::Arc};

use tokio::sync::{Mutex, broadcast};

use super::{events::TaskEvents, lifecycle::TaskLifecycle, push::PushService};
use crate::{
    codex_app_server::{CodexThreadClient, CodexThreadError},
    codex_thread_sessions::{CodexThreadSessions, ThreadSessionSnapshot},
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
    sessions: CodexThreadSessions,
    events: TaskEvents,
    task_store: TaskStore,
    lifecycle: Option<TaskLifecycle>,
    push: Option<PushService>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    signals: broadcast::Sender<CodexRuntimeSignal>,
    shutdown: broadcast::Sender<()>,
}

#[derive(Clone)]
pub(in crate::app) struct CodexConnection {
    pub(in crate::app) client: CodexThreadClient,
    pub(in crate::app) generation: u64,
}

#[derive(Clone)]
pub(in crate::app) enum CodexRuntimeSignal {
    SessionChanged {
        thread_id: String,
        snapshot: Box<ThreadSessionSnapshot>,
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
    Codex(CodexThreadError),
}

impl From<CodexThreadError> for ApprovalResolveError {
    fn from(error: CodexThreadError) -> Self {
        Self::Codex(error)
    }
}

impl CodexRuntime {
    pub(in crate::app) fn new(
        sessions: CodexThreadSessions,
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
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::codex_app_server::{CodexDaemonInfo, CodexReadiness, MockCodexResponse};

    fn test_runtime(store: TaskStore) -> CodexRuntime {
        let (shutdown, _) = broadcast::channel(1);
        CodexRuntime::new(
            CodexThreadSessions::default(),
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
            crate::codex_app_server::CodexReadinessState::UpdateRequired,
            crate::codex_app_server::CodexReadinessReason::VersionBelowMinimum,
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
        let sessions = CodexThreadSessions::default();
        let events = TaskEvents::default();
        let store = TaskStore::memory().expect("in-memory task store");
        let (shutdown, _) = broadcast::channel(1);
        let runtime = CodexRuntime::new(sessions.clone(), events, store, shutdown);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            json!({
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
            .ensure_subscribed(&client, 13, "thread_restart")
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
            crate::codex_thread_sessions::ThreadSessionLifecycle::Error
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
