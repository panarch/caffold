use tokio::sync::broadcast;

use super::{TaskRuntime, server_requests::PendingApproval};
use crate::agent::claude::ClaudeRuntimeEvent;
use crate::app::tasks::events::{approval_requested_event, now_ms};

impl TaskRuntime {
    /// Carry what Claude sessions say into the Task application.
    ///
    /// The Codex bridge translates notifications first and reports second,
    /// because app-server speaks in Codex's own vocabulary. Claude's driver has
    /// already done its translating by the time anything reaches here, so this
    /// bridge only routes: a conversation report goes where every agent's
    /// conversation reports go, and an approval joins the same waiting list a
    /// Codex approval joins.
    pub(super) fn spawn_claude_bridge(&self, mut shutdown: broadcast::Receiver<()>) {
        let runtime = self.clone();
        let mut events = self.claude.subscribe();
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    _ = shutdown.recv() => return,
                    event = events.recv() => event,
                };
                match event {
                    Ok(ClaudeRuntimeEvent::Session(reported)) => {
                        runtime
                            .handle_session_event(super::CLAUDE_GENERATION, reported)
                            .await;
                    }
                    Ok(ClaudeRuntimeEvent::Approval {
                        conversation_id,
                        request,
                    }) => {
                        runtime
                            .record_claude_approval(&conversation_id, *request)
                            .await;
                    }
                    Ok(ClaudeRuntimeEvent::Diagnostic { message }) => eprintln!("{message}"),
                    // A backlog long enough to drop from would mean a report is
                    // already lost; saying so beats carrying on as though the
                    // conversation were whole.
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        eprintln!("Claude runtime dropped {missed} reports behind a slow reader");
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    async fn record_claude_approval(
        &self,
        thread_id: &str,
        request: crate::agent::ApprovalRequest,
    ) {
        let event = self
            .events
            .record(approval_requested_event(thread_id, &request, now_ms()));
        self.approvals.lock().await.insert(
            request.id.clone(),
            PendingApproval::claude(thread_id.to_string(), request, &event),
        );
        self.events.broadcast(event);
    }
}
