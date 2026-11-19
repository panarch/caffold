//! Route normalized ACP control and native-record observations into Task owners.
use super::{ANTIGRAVITY_GENERATION, TaskRuntime, TaskRuntimeSignal, server_requests::AskedBy};
use crate::{
    agent::antigravity::AntigravityRuntimeEvent, app::tasks::events::now_ms,
    task_store::TaskProvider,
};
use tokio::sync::broadcast;

impl TaskRuntime {
    pub(super) fn spawn_antigravity_bridge(&self, mut shutdown: broadcast::Receiver<()>) {
        let runtime = self.clone();
        let mut events = self.antigravity.subscribe();
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {_=shutdown.recv()=>return,event=events.recv()=>event};
                match event {
                    Ok(AntigravityRuntimeEvent::Session(event)) => {
                        runtime
                            .handle_session_event(ANTIGRAVITY_GENERATION, *event)
                            .await
                    }
                    Ok(AntigravityRuntimeEvent::Closed { conversation_id }) => {
                        runtime
                            .withdraw_antigravity_approvals(&conversation_id)
                            .await;
                        runtime
                            .sessions
                            .session_needs_opening_again(&conversation_id)
                            .await;
                    }
                    Ok(AntigravityRuntimeEvent::RecordChanged { conversation_id }) => {
                        let runtime = runtime.clone();
                        tokio::spawn(async move {
                            match runtime
                                .sessions
                                .refresh_latest_turns(ANTIGRAVITY_GENERATION, &conversation_id)
                                .await
                            {
                                Ok(Some(snapshot)) => {
                                    let _ =
                                        runtime.signals.send(TaskRuntimeSignal::SessionChanged {
                                            thread_id: conversation_id,
                                            snapshot: Box::new(snapshot),
                                        });
                                }
                                Ok(None) => {}
                                Err(error) => {
                                    let _ = runtime.signals.send(
                                        TaskRuntimeSignal::SessionUnavailable {
                                            thread_id: conversation_id,
                                            message: error.to_string(),
                                        },
                                    );
                                }
                            }
                        });
                    }
                    Ok(AntigravityRuntimeEvent::Approval {
                        conversation_id,
                        request,
                    }) => {
                        runtime
                            .record_pending_approval(
                                &conversation_id,
                                *request,
                                now_ms(),
                                AskedBy::Antigravity,
                            )
                            .await
                    }
                    Ok(AntigravityRuntimeEvent::ApprovalEnded {
                        conversation_id,
                        approval_id,
                        outcome,
                    }) => {
                        runtime
                            .end_antigravity_approval(&conversation_id, &approval_id, outcome)
                            .await
                    }
                    Ok(AntigravityRuntimeEvent::Unreachable {
                        conversation_id,
                        message,
                    }) => {
                        runtime
                            .withdraw_antigravity_approvals(&conversation_id)
                            .await;
                        runtime.events.invalidate_continuity(&conversation_id);
                        runtime
                            .sessions
                            .session_needs_opening_again(&conversation_id)
                            .await;
                        let _ = runtime.signals.send(TaskRuntimeSignal::SessionUnavailable {
                            thread_id: conversation_id,
                            message,
                        });
                    }
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        eprintln!(
                            "Antigravity runtime missed {missed} observations; invalidating its Task subscriptions"
                        );
                        runtime.invalidate_antigravity_observations().await;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    pub(super) fn take_up_antigravity(&self) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let live = runtime.antigravity.live_conversations().await;
            runtime
                .resubscribe_surviving_tasks(TaskProvider::Antigravity, live)
                .await;
        });
    }

    async fn invalidate_antigravity_observations(&self) {
        let live = self.antigravity.live_conversations().await;
        for id in live {
            self.withdraw_antigravity_approvals(&id).await;
            self.sessions.session_needs_opening_again(&id).await;
            let _ = self.signals.send(TaskRuntimeSignal::SessionUnavailable {
                thread_id: id,
                message: "Antigravity observations were interrupted; reopen this Task".into(),
            });
        }
    }
}
