//! Passive runner evidence and one explicit, provider-local runtime replacement.
use super::{AntigravityClient, AntigravityError, AntigravityRuntimeEvent};
use crate::agent::{SessionEvent, SessionEventKind};
use caffold_runner::protocol::DaemonStatus;
use serde::Serialize;
use tokio::sync::RwLockReadGuard;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RuntimeStatus {
    restarting: bool,
    running: Option<bool>,
    pid: Option<u32>,
    version: Option<String>,
    sessions: Option<usize>,
    idle_timeout_secs: Option<u64>,
    error: Option<String>,
}

impl AntigravityClient {
    pub(super) async fn runtime_status(&self) -> RuntimeStatus {
        let restarting = self.inner.runtime_gate.try_read().is_err();
        let result = self.inner.runner.inspect().await;
        let mut report = RuntimeStatus {
            restarting,
            running: None,
            pid: None,
            version: None,
            sessions: None,
            idle_timeout_secs: None,
            error: None,
        };
        match result {
            Ok(Some(DaemonStatus {
                pid,
                runner_version,
                sessions,
                idle_timeout_secs,
                ..
            })) => {
                report.running = Some(true);
                report.pid = Some(pid);
                report.version = Some(runner_version);
                report.sessions = Some(sessions);
                report.idle_timeout_secs = idle_timeout_secs;
            }
            Ok(None) => report.running = Some(false),
            Err(error) => report.error = Some(error.to_string()),
        }
        report
    }

    pub(super) fn runtime_access(&self) -> Result<RwLockReadGuard<'_, ()>, AntigravityError> {
        self.inner
            .runtime_gate
            .try_read()
            .map_err(|_| AntigravityError::Unreachable("Antigravity runtime is restarting".into()))
    }

    pub(crate) async fn restart_runtime(&self) -> Result<(), AntigravityError> {
        // One request owns replacement; open/close cannot create a writer across it.
        let _runtime = self.inner.runtime_gate.try_write().map_err(|_| {
            AntigravityError::Unreachable(
                "wait for the Antigravity runtime operation to finish".into(),
            )
        })?;
        let slots: Vec<_> = self
            .inner
            .sessions
            .lock()
            .await
            .iter()
            .map(|(task, slot)| (task.clone(), slot.clone()))
            .collect();
        for (task, slot) in slots {
            let mut slot = slot.lock().await;
            let Some(session) = &slot.session else {
                continue;
            };
            // Reuse the driver's close boundary to settle replies and approvals.
            session.close().await?;
            session.retire().await;
            slot.watcher.take();
            slot.session.take();
            slot.native_turns.clear();
            slot.native_usage.clear();
            let _ = self.inner.events.send(AntigravityRuntimeEvent::Closed {
                conversation_id: task.clone(),
            });
            match self.read_snapshot(&task, None, 100).await {
                Ok(snapshot) => {
                    let _ = self
                        .inner
                        .events
                        .send(AntigravityRuntimeEvent::Session(Box::new(SessionEvent {
                            thread_id: task,
                            kind: SessionEventKind::ConversationReplaced {
                                turns_page: snapshot.page,
                            },
                        })));
                }
                Err(error) => {
                    let _ = self
                        .inner
                        .events
                        .send(AntigravityRuntimeEvent::Unreachable {
                            conversation_id: task,
                            message: error.to_string(),
                        });
                }
            }
        }
        self.inner
            .runner
            .restart()
            .await
            .map_err(|error| AntigravityError::Unreachable(error.to_string()))?;
        self.inner.runner.disconnect().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tokio::{io::AsyncWriteExt, net::UnixListener};

    #[tokio::test]
    async fn runtime_observation_is_passive_and_does_not_hide_transport_failure() {
        let root = tempfile::tempdir_in("/tmp").unwrap();
        let owner = AntigravityClient::at_paths(root.path(), root.path().join("native"));
        let socket = owner.inner.data.join("runner.sock");
        let absent = owner.runtime_status().await;
        assert_eq!(absent.running, Some(false));
        assert!(!absent.restarting);
        assert!(absent.error.is_none());
        assert!(!socket.exists(), "a status read must not start a runner");
        fs::create_dir_all(&owner.inner.data).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"not a runner reply\n").await.unwrap();
        });
        let failed = owner.runtime_status().await;
        peer.await.unwrap();
        assert_eq!(failed.running, None);
        assert!(failed.error.is_some());
        assert!(failed.pid.is_none());
        assert_eq!(owner.runtime_status().await.running, Some(false));
    }

    #[tokio::test]
    async fn replacement_excludes_new_work_without_queuing_it_for_after_restart() {
        let root = tempfile::tempdir_in("/tmp").unwrap();
        let owner = AntigravityClient::at_paths(root.path(), root.path().join("native"));
        // An accepted open/close/refresh must finish before replacement can start.
        let access = owner.runtime_access().unwrap();
        assert!(owner.restart_runtime().await.is_err());
        assert!(!owner.runtime_status().await.restarting);
        drop(access);
        let replace = owner.inner.runtime_gate.write().await;
        assert!(owner.runtime_status().await.restarting);
        assert!(owner.restart_runtime().await.is_err());
        assert!(owner.refresh_settings("/tmp").await.is_err());
        assert!(
            owner
                .open_for("task", Some("/tmp"), false, false, false)
                .await
                .is_err()
        );
        assert!(owner.close_conversation("task").await.is_err());
        drop(replace);
        assert!(owner.runtime_access().is_ok());
        assert!(!owner.runtime_status().await.restarting);
        assert!(owner.inner.sessions.lock().await.is_empty());
        assert!(!owner.inner.data.join("runner.sock").exists());
    }
}
