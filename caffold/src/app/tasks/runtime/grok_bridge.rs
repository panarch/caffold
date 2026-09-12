use tokio::sync::broadcast;

use super::{TaskRuntime, TaskRuntimeSignal, server_requests::AskedBy};
use crate::agent::grok::GrokRuntimeEvent;
use crate::app::tasks::events::now_ms;

impl TaskRuntime {
    /// Carry what Grok sessions say into the Task application.
    ///
    /// The driver has done its translating by the time anything reaches
    /// here, so this bridge only routes: a conversation report goes where
    /// every agent's reports go, and an approval joins the same waiting list
    /// a Codex or Claude approval joins.
    pub(super) fn spawn_grok_bridge(&self, mut shutdown: broadcast::Receiver<()>) {
        let runtime = self.clone();
        let mut events = self.grok.subscribe();
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    _ = shutdown.recv() => return,
                    event = events.recv() => event,
                };
                match event {
                    Ok(GrokRuntimeEvent::Session(reported)) => {
                        runtime
                            .handle_session_event(super::GROK_GENERATION, *reported)
                            .await;
                    }
                    Ok(GrokRuntimeEvent::Approval {
                        conversation_id,
                        request,
                    }) => {
                        runtime
                            .record_pending_approval(
                                &conversation_id,
                                *request,
                                now_ms(),
                                AskedBy::Grok,
                            )
                            .await;
                    }
                    Ok(GrokRuntimeEvent::Unreachable {
                        conversation_id,
                        message,
                    }) => {
                        runtime.lost_grok_session(&conversation_id, &message).await;
                    }
                    Ok(GrokRuntimeEvent::Diagnostic { message }) => eprintln!("{message}"),
                    // The driver marks every session it watches as one to
                    // open again when it falls behind; this side only notes
                    // that it did.
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        eprintln!("Grok runtime dropped {missed} reports behind a slow reader");
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    /// Stop answering for a Grok session that has to be opened again.
    ///
    /// The Claude shape, not the Codex one: the leader still has the
    /// session, and opening the Task again is the whole of the repair.
    async fn lost_grok_session(&self, thread_id: &str, message: &str) {
        // The leader keeps the question and asks it again on the next load;
        // until then nobody can answer it from here.
        self.withdraw_grok_approvals(thread_id).await;
        self.events.invalidate_continuity(thread_id);
        self.sessions.session_needs_opening_again(thread_id).await;
        let _ = self.signals.send(TaskRuntimeSignal::SessionUnavailable {
            thread_id: thread_id.to_string(),
            message: message.to_string(),
        });
    }
}
