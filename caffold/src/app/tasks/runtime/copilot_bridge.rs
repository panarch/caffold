//! Route the Copilot SDK's Task observations and recover surviving Copilot sessions.

use super::{COPILOT_GENERATION, TaskRuntime, TaskRuntimeSignal, server_requests::AskedBy};
use crate::{
    agent::copilot::CopilotRuntimeEvent, app::tasks::events::now_ms, task_store::TaskProvider,
};
use tokio::sync::broadcast;

impl TaskRuntime {
    pub(super) fn spawn_copilot_bridge(&self, mut shutdown: broadcast::Receiver<()>) {
        let runtime = self.clone();
        let mut events = self.copilot.subscribe();
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    _ = shutdown.recv() => return,
                    event = events.recv() => event,
                };
                match event {
                    Ok(CopilotRuntimeEvent::Session(event)) => {
                        runtime
                            .handle_session_event(COPILOT_GENERATION, *event)
                            .await;
                    }
                    Ok(CopilotRuntimeEvent::Approval {
                        conversation_id,
                        request,
                    }) => {
                        runtime
                            .record_pending_approval(
                                &conversation_id,
                                *request,
                                now_ms(),
                                AskedBy::Copilot,
                            )
                            .await;
                    }
                    Ok(CopilotRuntimeEvent::PendingApprovals {
                        conversation_id,
                        requests,
                    }) => {
                        runtime
                            .restore_copilot_approvals(&conversation_id, requests)
                            .await;
                    }
                    Ok(CopilotRuntimeEvent::ApprovalEnded {
                        conversation_id,
                        approval_id,
                        outcome,
                    }) => {
                        runtime
                            .end_copilot_approval(&conversation_id, &approval_id, outcome)
                            .await;
                    }
                    Ok(CopilotRuntimeEvent::Closed { conversation_id }) => {
                        runtime
                            .restore_copilot_approvals(&conversation_id, Vec::new())
                            .await;
                        runtime
                            .sessions
                            .session_needs_opening_again(&conversation_id)
                            .await;
                    }
                    Ok(CopilotRuntimeEvent::Unreachable {
                        conversation_id,
                        message,
                    }) => {
                        runtime
                            .copilot_observation_lost(conversation_id, message)
                            .await;
                    }
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        eprintln!(
                            "Copilot missed {missed} observations. Reopening its Task subscriptions is required."
                        );
                        for id in runtime.copilot.live_conversations().await {
                            runtime
                                .copilot_observation_lost(
                                    id,
                                    "Copilot observations were interrupted. Reopen this Task."
                                        .into(),
                                )
                                .await;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    async fn copilot_observation_lost(&self, thread_id: String, message: String) {
        // The SDK may still be waiting. Reopening will reconcile its pending requests.
        self.events.invalidate_continuity(&thread_id);
        self.sessions.session_needs_opening_again(&thread_id).await;
        let _ = self
            .signals
            .send(TaskRuntimeSignal::SessionUnavailable { thread_id, message });
    }

    pub(super) fn take_up_copilot(&self) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let live = runtime.copilot.live_conversations().await;
            runtime
                .resubscribe_surviving_tasks(TaskProvider::Copilot, live)
                .await;
        });
    }
}
