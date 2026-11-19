//! Passive runner evidence and one explicit, provider-local runtime replacement.
use super::{AntigravityClient, AntigravityError, AntigravityRuntimeEvent};
use crate::agent::runner::RunnerStatus;
use crate::agent::{SessionEvent, SessionEventKind};
use tokio::sync::RwLockReadGuard;

impl AntigravityClient {
    pub(super) async fn runtime_status(&self) -> RunnerStatus {
        let restarting = self.inner.runtime_gate.try_read().is_err();
        self.inner.runner.settings_status(restarting).await
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
    use serde_json::Value;
    use std::fs;
    use tokio::{io::AsyncWriteExt, net::UnixListener};

    async fn status(owner: &AntigravityClient) -> Value {
        serde_json::to_value(owner.runtime_status().await).unwrap()
    }

    #[tokio::test]
    async fn runtime_observation_is_passive_and_does_not_hide_transport_failure() {
        let root = tempfile::tempdir_in("/tmp").unwrap();
        let owner = AntigravityClient::at_paths(root.path(), root.path().join("native"));
        let socket = owner.inner.data.join("runner.sock");
        let absent = status(&owner).await;
        assert_eq!(absent["running"], false);
        assert_eq!(absent["restarting"], false);
        assert_eq!(absent.get("error"), Some(&Value::Null));
        assert!(!socket.exists(), "a status read must not start a runner");
        fs::create_dir_all(&owner.inner.data).unwrap();
        let listener = UnixListener::bind(&socket).unwrap();
        let peer = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"not a runner reply\n").await.unwrap();
        });
        let failed = status(&owner).await;
        peer.await.unwrap();
        assert_eq!(failed.get("running"), Some(&Value::Null));
        assert!(failed["error"].is_string());
        assert_eq!(failed.get("pid"), Some(&Value::Null));
        assert_eq!(status(&owner).await["running"], false);
    }

    #[tokio::test]
    async fn replacement_excludes_new_work_without_queuing_it_for_after_restart() {
        let root = tempfile::tempdir_in("/tmp").unwrap();
        let owner = AntigravityClient::at_paths(root.path(), root.path().join("native"));
        // An accepted open/close/refresh must finish before replacement can start.
        let access = owner.runtime_access().unwrap();
        assert!(owner.restart_runtime().await.is_err());
        assert_eq!(status(&owner).await["restarting"], false);
        drop(access);
        let replace = owner.inner.runtime_gate.write().await;
        assert_eq!(status(&owner).await["restarting"], true);
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
        assert_eq!(status(&owner).await["restarting"], false);
        assert!(owner.inner.sessions.lock().await.is_empty());
        assert!(!owner.inner.data.join("runner.sock").exists());
    }
}
