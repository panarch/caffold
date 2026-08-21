use tokio::sync::broadcast;

use futures_util::{StreamExt, stream};

use super::{TaskRuntime, TaskRuntimeSignal, server_requests::PendingApproval};
use crate::agent::claude::ClaudeRuntimeEvent;
use crate::app::tasks::events::{approval_requested_event, now_ms};
use crate::task_store::RunBy;

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
                    Ok(ClaudeRuntimeEvent::Unreachable {
                        conversation_id,
                        message,
                    }) => {
                        runtime
                            .lost_claude_session(&conversation_id, &message)
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

    /// Take up the conversations that outlived this process.
    ///
    /// The Claude half of what Codex does with its loaded threads, and the same
    /// two steps. The runner answers which conversations still have a process
    /// behind them — one request, and it starts nothing, because everything it
    /// names is already running. Each of those is then opened, which attaches
    /// rather than spawns, and greeted, which is where the agent says whether a
    /// prompt is still outstanding and hands back anything it is held up by.
    ///
    /// A runner that has just started answers with nothing, and rightly: it
    /// ended whatever the last one left, so there is nothing to take up. Every
    /// other Task waits to be opened by somebody.
    pub(super) fn take_up_live_conversations(&self) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let live = runtime.claude.live_conversations().await;
            if live.is_empty() {
                return;
            }
            let store = runtime.task_store.clone();
            let managed = match tokio::task::spawn_blocking(move || {
                live.into_iter()
                    .filter_map(|thread_id| match store.get(thread_id.as_str()) {
                        Ok(Some(managed)) => Some(Ok(managed)),
                        Ok(None) => None,
                        Err(error) => Some(Err(error)),
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .await
            {
                Ok(Ok(managed)) => managed,
                Ok(Err(error)) => {
                    eprintln!(
                        "failed to read managed Tasks while taking up Claude sessions: {error}"
                    );
                    return;
                }
                Err(error) => {
                    eprintln!("the worker reading managed Tasks failed: {error}");
                    return;
                }
            };

            stream::iter(managed)
                .for_each_concurrent(8, |managed| {
                    let runtime = runtime.clone();
                    async move {
                        let RunBy::Claude { cwd } = managed.run_by else {
                            // The runner holds a session under this name and the
                            // store says the Task is somebody else's. Neither is
                            // safe to act on.
                            return;
                        };
                        let thread_id = managed.thread_id;
                        match runtime
                            .sessions
                            .recover_live_claude_session(
                                &runtime.claude.driver(cwd),
                                super::CLAUDE_GENERATION,
                                &thread_id,
                            )
                            .await
                        {
                            Ok(Some(snapshot)) => {
                                let _ = runtime.signals.send(TaskRuntimeSignal::SessionChanged {
                                    thread_id,
                                    snapshot: Box::new(snapshot),
                                });
                            }
                            Ok(None) => {}
                            Err(error) => eprintln!(
                                "failed to take up Claude conversation {thread_id}: {error}"
                            ),
                        }
                    }
                })
                .await;
        });
    }

    /// Stop answering for a Claude session that can no longer be reached.
    ///
    /// The Codex half of this is a connection going and taking every thread on
    /// it; here it is one conversation, because that is all a Claude connection
    /// ever carries. Both end the same way: the session says it is no longer
    /// current, and whoever is watching is told, so opening it again asks the
    /// agent rather than repeating what was last heard.
    async fn lost_claude_session(&self, thread_id: &str, message: &str) {
        self.sessions.session_needs_opening_again(thread_id).await;
        let _ = self
            .signals
            .send(super::TaskRuntimeSignal::SessionUnavailable {
                thread_id: thread_id.to_string(),
                message: message.to_string(),
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
