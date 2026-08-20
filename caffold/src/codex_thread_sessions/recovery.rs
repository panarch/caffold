use futures_util::{StreamExt, stream};

use crate::agent::ThreadStatus;
use crate::agent::codex::{CodexThreadClient, CodexThreadError};

use super::{CodexThreadSessions, ThreadSessionLifecycle, ThreadSessionSnapshot};

impl CodexThreadSessions {
    pub async fn connection_lost(&self, generation: u64, message: String) -> Vec<String> {
        let entries = self
            .entries
            .lock()
            .await
            .iter()
            .map(|(thread_id, entry)| (thread_id.clone(), entry.clone()))
            .collect::<Vec<_>>();
        let mut affected = Vec::new();
        for (thread_id, entry) in entries {
            let mut state = entry.state.lock().await;
            if state.generation == generation {
                state.lifecycle = ThreadSessionLifecycle::Error;
                state.client = None;
                state.terminal_candidate_turn_id = None;
                state.last_error = Some(message.clone());
                state.revision = state.revision.saturating_add(1);
                affected.push(thread_id);
            }
        }
        affected
    }

    pub async fn resubscribe_leased(
        &self,
        client: &CodexThreadClient,
        generation: u64,
    ) -> Vec<(String, CodexThreadError)> {
        let entries = self
            .entries
            .lock()
            .await
            .iter()
            .map(|(thread_id, entry)| (thread_id.clone(), entry.clone()))
            .collect::<Vec<_>>();
        let mut leased_threads = Vec::new();
        for (thread_id, entry) in entries {
            let leased = {
                let state = entry.state.lock().await;
                state.viewer_leases > 0 || state.runtime_lease
            };
            if leased {
                leased_threads.push(thread_id);
            }
        }

        stream::iter(leased_threads)
            .map(|thread_id| {
                let sessions = self.clone();
                let client = client.clone();
                async move {
                    sessions
                        .ensure_subscribed(&client, generation, &thread_id)
                        .await
                        .err()
                        .map(|error| (thread_id, error))
                }
            })
            .buffer_unordered(8)
            .filter_map(async move |failure| failure)
            .collect()
            .await
    }

    pub async fn recover_loaded_thread(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        thread_id: &str,
    ) -> Result<Option<ThreadSessionSnapshot>, CodexThreadError> {
        let entry = self.entry(thread_id).await;
        entry.state.lock().await.runtime_lease = true;

        match self.ensure_subscribed(client, generation, thread_id).await {
            Ok(snapshot)
                if snapshot
                    .conversation
                    .as_ref()
                    .is_some_and(|thread| matches!(thread.status, ThreadStatus::Active { .. })) =>
            {
                Ok(Some(snapshot))
            }
            Ok(_) => {
                self.cancel_runtime(thread_id).await;
                Ok(None)
            }
            Err(error) => {
                self.cancel_runtime(thread_id).await;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_thread_sessions::test_support::*;

    #[tokio::test]
    async fn connection_recovery_resubscribes_only_leased_sessions() {
        let first_client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let recovered_client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
        )]);
        let sessions = CodexThreadSessions::default();
        let _viewer = sessions
            .acquire_viewer(&first_client, 1, "thread-1")
            .await
            .expect("viewer");

        let _ = sessions
            .connection_lost(1, "process exited".to_string())
            .await;
        let failures = sessions.resubscribe_leased(&recovered_client, 2).await;

        assert!(failures.is_empty());
        assert_eq!(methods(&recovered_client).await, vec!["thread/resume"]);
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert_eq!(snapshot.generation, 2);
        assert_eq!(snapshot.lifecycle, ThreadSessionLifecycle::Subscribed);
    }

    #[tokio::test]
    async fn connection_recovery_does_not_serialize_unrelated_thread_resumes() {
        let first_client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
        ]);
        let sessions = CodexThreadSessions::default();
        let _first_viewer = sessions
            .acquire_viewer(&first_client, 1, "thread-1")
            .await
            .expect("first viewer");
        let _second_viewer = sessions
            .acquire_viewer(&first_client, 1, "thread-2")
            .await
            .expect("second viewer");

        let _ = sessions
            .connection_lost(1, "process exited".to_string())
            .await;
        let recovered_client = CodexThreadClient::mock(vec![
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
                Duration::from_millis(120),
            ),
            MockCodexResponse::delayed_ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
                Duration::from_millis(120),
            ),
        ]);

        let started = tokio::time::Instant::now();
        let failures = sessions.resubscribe_leased(&recovered_client, 2).await;

        assert!(failures.is_empty());
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "independent thread resumes should run concurrently, elapsed {:?}",
            started.elapsed()
        );
        assert_eq!(
            methods(&recovered_client).await,
            vec!["thread/resume", "thread/resume"]
        );
    }

    #[tokio::test]
    async fn loaded_active_thread_recovery_holds_a_runtime_lease() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/resume",
            resume_response(
                ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
                vec![wire_turn("turn-active", TurnStatus::InProgress)],
                Vec::new(),
            ),
        )]);
        let sessions = CodexThreadSessions::default();

        let recovered = sessions
            .recover_loaded_thread(&client, 3, "thread-1")
            .await
            .expect("recover active thread")
            .expect("active thread remains subscribed");

        assert!(recovered.runtime_lease);
        assert_eq!(recovered.active_turn_id.as_deref(), Some("turn-active"));
        assert_eq!(methods(&client).await, ["thread/resume"]);
    }

    #[tokio::test]
    async fn loaded_idle_thread_recovery_releases_its_runtime_lease() {
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok(
                "thread/resume",
                resume_response(ThreadStatus::Idle, Vec::new(), Vec::new()),
            ),
            MockCodexResponse::ok("thread/unsubscribe", json!({ "status": "unsubscribed" })),
        ]);
        let sessions = CodexThreadSessions::default();

        assert!(
            sessions
                .recover_loaded_thread(&client, 3, "thread-1")
                .await
                .expect("recover idle thread")
                .is_none()
        );
        let snapshot = sessions.snapshot("thread-1").await.expect("snapshot");
        assert!(!snapshot.runtime_lease);
        wait_for_unsubscribe(&client).await;
    }
}
