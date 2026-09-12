//! Reading what the leader says, as it says it.
//!
//! One router pumps everything the bridge delivers: session updates open and
//! close turns and place items, permission requests surface as approvals,
//! the leader's own notices move activity and titles, and a bridge going
//! away is the difference between a session that ended and one that has to
//! be opened again. Replayed history — what `session/load` echoes back — is
//! not live and is left to the history reader.

use std::sync::Arc;

use serde_json::Value;
use tokio::sync::broadcast;

use super::{
    GrokClient, GrokRuntimeEvent,
    protocol::{
        self, ContentBlock, INTERJECTION, LEADER_RECONNECTED, LeaderReconnectedParams,
        MODELS_UPDATE, PermissionRequestParams, QUEUE_CHANGED, QueueChangedParams,
        REQUEST_PERMISSION, SESSION_NOTIFICATION, SESSION_UPDATE, SESSION_UPDATE_REPLAY,
        SESSIONS_CHANGED, SessionSummary, SessionsChangedParams, Update, UpdateParams,
    },
    session::{PendingApproval, Run, Session},
    translate,
    transport::Incoming,
};
use crate::agent::{ActivityStatus, ConversationItem, ItemKind, SessionEventKind, TurnState};

impl GrokClient {
    pub(super) fn spawn_router(&self) {
        let client = self.clone();
        let mut incoming = self.transport().subscribe();
        tokio::spawn(async move {
            loop {
                match incoming.recv().await {
                    Ok(Incoming::Notification {
                        generation,
                        method,
                        params,
                    }) => {
                        client
                            .handle_notification(generation, &method, params)
                            .await;
                    }
                    Ok(Incoming::ServerRequest {
                        generation,
                        id,
                        method,
                        params,
                    }) => {
                        client
                            .handle_server_request(generation, id, &method, params)
                            .await;
                    }
                    Ok(Incoming::BridgeLost { generation }) => {
                        client.bridge_lost(generation).await;
                    }
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        client.publish(GrokRuntimeEvent::Diagnostic {
                            message: format!(
                                "Grok bridge dropped {missed} reports behind a slow reader"
                            ),
                        });
                        client
                            .every_session_needs_opening_again("reports were missed")
                            .await;
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    async fn handle_notification(&self, generation: u64, method: &str, params: Value) {
        match method {
            SESSION_UPDATE | SESSION_NOTIFICATION | SESSION_UPDATE_REPLAY => {
                let Ok(params) = serde_json::from_value::<UpdateParams>(params) else {
                    return;
                };
                if params.meta.is_replay || method == SESSION_UPDATE_REPLAY {
                    return;
                }
                let Some(session) = self.session_by_native(&params.session_id).await else {
                    return;
                };
                if session.state.lock().await.loaded_on != generation {
                    return;
                }
                self.handle_update(&session, params).await;
            }
            SESSIONS_CHANGED => {
                let Ok(params) = serde_json::from_value::<SessionsChangedParams>(params) else {
                    return;
                };
                for summary in params.upserted {
                    let Some(session) = self.session_by_native(&summary.session_id).await else {
                        continue;
                    };
                    self.handle_summary(&session, summary).await;
                }
            }
            QUEUE_CHANGED => {
                let Ok(params) = serde_json::from_value::<QueueChangedParams>(params) else {
                    return;
                };
                let Some(session) = self.session_by_native(&params.session_id).await else {
                    return;
                };
                self.handle_queue(&session, params).await;
            }
            // The steer was accepted; the item was placed when it was sent.
            INTERJECTION => {}
            // The leader's catalog changed; what was read is read again.
            MODELS_UPDATE => self.forget_catalog().await,
            LEADER_RECONNECTED => {
                let Ok(params) = serde_json::from_value::<LeaderReconnectedParams>(params) else {
                    return;
                };
                match params.session_id {
                    Some(session_id) => {
                        if let Some(session) = self.session_by_native(&session_id).await {
                            self.session_needs_opening_again(
                                &session,
                                "the Grok leader was replaced",
                            )
                            .await;
                        }
                    }
                    None => {
                        self.every_session_needs_opening_again("the Grok leader was replaced")
                            .await
                    }
                }
            }
            _ => {}
        }
    }

    async fn handle_update(&self, session: &Arc<Session>, params: UpdateParams) {
        let observed_at_ms = params.meta.agent_timestamp_ms;
        let thread_id = session.thread_id.as_str();
        match Update::read(&params.update) {
            Update::AgentMessage(ContentBlock::Text { text, .. }) => {
                let placed =
                    session
                        .state
                        .lock()
                        .await
                        .append_text(Run::Message, &text, observed_at_ms);
                if let Some((turn_id, item)) = placed {
                    self.report_item(thread_id, turn_id, item, observed_at_ms);
                }
            }
            Update::AgentThought(ContentBlock::Text { text, .. }) => {
                let placed =
                    session
                        .state
                        .lock()
                        .await
                        .append_text(Run::Thought, &text, observed_at_ms);
                if let Some((turn_id, item)) = placed {
                    self.report_item(thread_id, turn_id, item, observed_at_ms);
                }
            }
            Update::AgentMessage(_) | Update::AgentThought(_) => {}
            Update::ToolCall(call) => {
                let mut item = translate::tool_call_item(&call);
                item.observed_at_ms = observed_at_ms;
                let placed = session.state.lock().await.place(item.clone());
                if let Some(turn_id) = placed {
                    self.report_item(thread_id, turn_id, item, observed_at_ms);
                }
            }
            Update::ToolCallUpdate(update) => {
                let (placed, item, changed_files) = {
                    let mut state = session.state.lock().await;
                    let Some(turn_id) = state.active_turn.clone() else {
                        return;
                    };
                    let before = state.item(&turn_id, &update.tool_call_id).cloned();
                    let declined = state.declined.contains(&update.tool_call_id);
                    let mut item =
                        translate::tool_call_update_item(before.as_ref(), &update, declined);
                    if item.observed_at_ms.is_none() {
                        item.observed_at_ms = observed_at_ms;
                    }
                    let changed_files = item.status == ActivityStatus::Completed
                        && matches!(
                            item.kind,
                            ItemKind::FileChange { .. } | ItemKind::CommandExecution(_)
                        );
                    let placed = state.place(item.clone());
                    (placed, item, changed_files)
                };
                if let Some(turn_id) = placed {
                    self.report_item(thread_id, turn_id, item, observed_at_ms);
                    if changed_files {
                        self.report(thread_id, SessionEventKind::DiffChanged);
                    }
                }
            }
            Update::Plan(entries) => {
                let id = params
                    .meta
                    .event_id
                    .clone()
                    .unwrap_or_else(|| format!("{thread_id}:plan"));
                let item = translate::plan_item(&id, &entries, observed_at_ms);
                let placed = session.state.lock().await.place(item.clone());
                if let Some(turn_id) = placed {
                    self.report_item(thread_id, turn_id, item, observed_at_ms);
                }
            }
            Update::TurnCompleted(completed) => {
                let status = translate::turn_status(completed.stop_reason.as_deref());
                let failure = completed
                    .stop_reason
                    .as_deref()
                    .and_then(translate::failure_text);
                let (ended, usage) = {
                    let mut state = session.state.lock().await;
                    let usage = completed.usage.as_ref().map(|usage| {
                        translate::token_usage(usage, state.context_window, state.session_tokens)
                    });
                    // Whether the session is still working is the leader's
                    // to say, and it says so right after this.
                    let ended = state.end_turn(&completed.prompt_id, status, failure);
                    (ended, usage)
                };
                let Some((turn, changed)) = ended else {
                    return;
                };
                if let Some(usage) = usage {
                    self.report(
                        thread_id,
                        SessionEventKind::UsageReported {
                            turn_id: turn.id.clone(),
                            usage,
                        },
                    );
                }
                self.report_turn_ended(thread_id, turn, changed);
            }
            Update::PendingInteraction { .. } | Update::InteractionResolved { .. } => {
                // The question itself arrives as a request; these only say
                // that the agent is, or is no longer, held up by one.
            }
            Update::UserMessage(..) | Update::Other(_) => {}
        }
    }

    async fn handle_summary(&self, session: &Arc<Session>, summary: SessionSummary) {
        let thread_id = session.thread_id.as_str();
        let (activity_changed, title_changed, settings_changed) = {
            let mut state = session.state.lock().await;
            let working = match summary.activity.as_deref() {
                Some("working") => Some(true),
                Some("idle") => Some(false),
                _ => None,
            };
            let activity_changed = match working {
                Some(working) if working != state.working => {
                    state.working = working;
                    true
                }
                _ => false,
            };
            let title = summary
                .title
                .clone()
                .filter(|title| !title.trim().is_empty());
            let title_changed = title.is_some() && title != state.title;
            if title_changed {
                state.title = title;
            }
            let mut settings_changed = false;
            if let Some(model) = summary.model_id.clone()
                && state.model.as_ref() != Some(&model)
            {
                state.model = Some(model);
                settings_changed = true;
            }
            if let Some(effort) = summary.reasoning_effort.clone()
                && state.effort.as_ref() != Some(&effort)
            {
                state.effort = Some(effort);
                settings_changed = true;
            }
            (activity_changed, title_changed, settings_changed)
        };
        if activity_changed {
            self.report_activity(thread_id, session).await;
            if !session.state.lock().await.working {
                self.trigger_switch(thread_id);
            }
        }
        if title_changed {
            let title = session.state.lock().await.title.clone();
            self.report(thread_id, SessionEventKind::TitleChanged { title });
        }
        if settings_changed {
            let settings = self.settings_of(thread_id).await;
            self.report(thread_id, SessionEventKind::SettingsChanged { settings });
        }
    }

    /// The queue names the running prompt. A turn Caffold did not start —
    /// another client's — is taken up so that what follows has a home.
    async fn handle_queue(&self, session: &Arc<Session>, params: QueueChangedParams) {
        let Some(running) = params.running_prompt_id else {
            return;
        };
        let adopted = {
            let mut state = session.state.lock().await;
            if state.active_turn.is_some() || state.turns.iter().any(|turn| turn.id == running) {
                None
            } else {
                state.working = true;
                Some(state.adopt_turn(&running))
            }
        };
        if let Some(turn) = adopted {
            self.report(
                &session.thread_id,
                SessionEventKind::TurnStarted {
                    turn: TurnState::from(&turn),
                },
            );
            self.report_activity(&session.thread_id, session).await;
        }
    }

    async fn handle_server_request(&self, generation: u64, id: Value, method: &str, params: Value) {
        if method != REQUEST_PERMISSION {
            let _ = self
                .transport()
                .refuse(
                    generation,
                    &id,
                    &format!("Caffold does not implement {method}"),
                )
                .await;
            return;
        }
        let request: PermissionRequestParams = match serde_json::from_value(params) {
            Ok(request) => request,
            Err(error) => {
                self.publish(GrokRuntimeEvent::Diagnostic {
                    message: format!("Grok asked a permission this release cannot read: {error}"),
                });
                let _ = self
                    .transport()
                    .respond(generation, &id, protocol::permission_cancelled())
                    .await;
                return;
            }
        };
        let Some(session) = self.session_by_native(&request.session_id).await else {
            // A question for a session nobody here watches is not one to
            // leave the agent blocked on.
            let _ = self
                .transport()
                .respond(generation, &id, protocol::permission_cancelled())
                .await;
            return;
        };
        let (turn_id, cwd) = {
            let mut state = session.state.lock().await;
            state.pending_approvals.insert(
                request.tool_call.tool_call_id.clone(),
                PendingApproval {
                    request_id: id,
                    generation,
                    options: request.options.clone(),
                },
            );
            (
                state.active_turn.clone(),
                session.native.lock().await.cwd.clone(),
            )
        };
        let approval = translate::approval_request(&request, turn_id.as_deref(), Some(&cwd));
        self.publish(GrokRuntimeEvent::Approval {
            conversation_id: session.thread_id.clone(),
            request: Box::new(approval),
        });
        self.report_activity(&session.thread_id, &session).await;
    }

    async fn bridge_lost(&self, generation: u64) {
        let sessions = self
            .inner
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            let lost = session.state.lock().await.loaded_on == generation;
            if lost {
                self.session_needs_opening_again(&session, "the Grok bridge went away")
                    .await;
            }
        }
    }

    async fn every_session_needs_opening_again(&self, why: &str) {
        let sessions = self
            .inner
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            self.session_needs_opening_again(&session, why).await;
        }
    }

    /// What was watched on this bridge is no longer current: the next opening
    /// loads the session again and the leader says what it is doing.
    async fn session_needs_opening_again(&self, session: &Arc<Session>, why: &str) {
        {
            let mut state = session.state.lock().await;
            state.loaded_on = 0;
            state.pending_approvals.clear();
        }
        self.publish(GrokRuntimeEvent::Unreachable {
            conversation_id: session.thread_id.clone(),
            message: format!(
                "Grok conversation {} has to be opened again: {why}",
                session.thread_id
            ),
        });
    }

    fn report_item(
        &self,
        thread_id: &str,
        turn_id: String,
        item: ConversationItem,
        observed_at_ms: Option<u64>,
    ) {
        self.report(
            thread_id,
            SessionEventKind::ItemChanged {
                turn_id,
                at_ms: observed_at_ms
                    .or(item.observed_at_ms)
                    .unwrap_or_else(super::session::now_ms),
                item,
            },
        );
    }
}
