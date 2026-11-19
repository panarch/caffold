//! Project the native journal and the live SDK stream with the same identities.
use super::sdk_error;
use crate::agent::{
    ActivityStatus, AgentError, ContextUsage, Conversation, ConversationItem, ItemKind,
    MessagePhase, SessionEventKind, ThreadStatus, ToolCall, ToolResultPart, Turn, TurnOrigin,
    TurnPage, TurnState, TurnStatus, driver::submitted_user_message,
};
use copilot_sdk::{
    Client, SessionEvent,
    rpc::{EventsCursorStatus, EventsReadDirection, SessionsReadPersistedEventsRequest},
};
use serde_json::Value;
use std::collections::HashSet;

pub(super) struct Record {
    pub conversation: Conversation,
    pub last_event: Option<String>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub context: Option<ContextUsage>,
    pub recorded_usage: Option<(String, super::usage::Usage)>,
    seen: HashSet<String>,
    interaction: Option<String>,
    final_message: bool,
}

impl Record {
    pub fn new(task: &str, cwd: &str) -> Self {
        Self {
            conversation: Conversation {
                id: task.into(),
                cwd: cwd.into(),
                title: None,
                preview: String::new(),
                status: ThreadStatus::Idle,
                background_work: false,
                transcript_path: None,
                created_at_ms: 0,
                updated_at_ms: 0,
                recency_at_ms: None,
                turns: Vec::new(),
            },
            last_event: None,
            model: None,
            effort: None,
            context: None,
            recorded_usage: None,
            seen: HashSet::new(),
            interaction: None,
            final_message: false,
        }
    }

    pub async fn read(
        client: &Client,
        task: &str,
        native: &str,
        cwd: &str,
    ) -> Result<Self, AgentError> {
        let mut record = Self::new(task, cwd);
        let mut cursor = None;

        loop {
            let page = client
                .rpc()
                .sessions()
                .read_persisted_events(SessionsReadPersistedEventsRequest {
                    session_id: native.to_owned().into(),
                    direction: Some(EventsReadDirection::Forward),
                    max: Some(512),
                    cursor,
                })
                .await
                .map_err(sdk_error)?;
            if matches!(page.cursor_status, EventsCursorStatus::Expired) {
                return Err(AgentError::Failed(
                    "Copilot history changed while it was being read. Reopen the Task.".into(),
                ));
            }

            for event in page.events {
                record.apply(&event);
            }
            if !page.has_more {
                break;
            }
            cursor = Some(page.cursor);
        }
        Ok(record)
    }

    pub fn active_turn(&self) -> Option<&Turn> {
        self.conversation
            .turns
            .last()
            .filter(|turn| turn.status == TurnStatus::InProgress)
    }

    pub fn page(&self, before: Option<&str>, limit: usize) -> Result<TurnPage, AgentError> {
        let turns = &self.conversation.turns;
        let end = match before {
            None => turns.len(),
            Some(id) => turns.iter().position(|turn| turn.id == id).ok_or_else(|| {
                AgentError::Failed("This Copilot history cursor is no longer available.".into())
            })?,
        };
        let start = end.saturating_sub(limit.max(1));
        Ok(TurnPage {
            turns: turns[start..end].iter().rev().cloned().collect(),
            next_cursor: (start > 0).then(|| turns[start].id.clone()),
            backwards_cursor: None,
        })
    }

    pub fn finish(&mut self, status: TurnStatus, time: Option<u64>) -> Option<SessionEventKind> {
        let turn = self.conversation.turns.last_mut()?;
        if turn.status != TurnStatus::InProgress {
            return None;
        }

        turn.status = status;
        turn.completed_at_ms = time;
        self.conversation.status = ThreadStatus::Idle;
        Some(SessionEventKind::TurnEnded {
            turn: TurnState::from(&*turn),
        })
    }

    pub fn apply(&mut self, event: &SessionEvent) -> Vec<SessionEventKind> {
        // Only durable IDs can also arrive in a subsequent native history read.
        if event.ephemeral != Some(true) {
            if !self.seen.insert(event.id.clone()) {
                return Vec::new();
            }
            self.last_event = Some(event.id.clone());
        }
        if event.agent_id.is_some() {
            return Vec::new();
        }

        let data = &event.data;
        let time = chrono::DateTime::parse_from_rfc3339(&event.timestamp)
            .ok()
            .and_then(|time| u64::try_from(time.timestamp_millis()).ok());
        if let Some(time) = time {
            self.conversation.updated_at_ms = self.conversation.updated_at_ms.max(time);
        }

        let mut events = Vec::new();
        match event.event_type.as_str() {
            "session.start" => {
                self.conversation.created_at_ms = time.unwrap_or(0);
                if self.conversation.cwd.is_empty() {
                    self.conversation.cwd = data
                        .pointer("/context/cwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .into();
                }
                self.model = string(data, "selectedModel");
                self.effort = string(data, "reasoningEffort");
            }
            "session.title_changed" => {
                self.conversation.title = string(data, "title");
                events.push(SessionEventKind::TitleChanged {
                    title: self.conversation.title.clone(),
                });
            }

            "user.message" => self.apply_user_message(event, time, &mut events),
            "assistant.message"
            | "assistant.message_delta"
            | "assistant.reasoning"
            | "assistant.reasoning_delta"
            | "tool.execution_start"
            | "tool.execution_complete"
            | "session.error" => {
                if let Some(item) = self.native_item(event, time) {
                    events.extend(self.item(item, time));
                }
                if event.event_type == "session.error" {
                    events.extend(self.finish(TurnStatus::Failed, time));
                }
                if event.event_type == "assistant.message" {
                    self.final_message = data["phase"] != "commentary"
                        && data["toolRequests"].as_array().is_none_or(Vec::is_empty);
                }
                if event.event_type == "tool.execution_complete"
                    && data["fileEdits"]
                        .as_array()
                        .is_some_and(|edits| !edits.is_empty())
                {
                    events.push(SessionEventKind::DiffChanged);
                }
            }

            "assistant.turn_start" => self.final_message = false,
            "abort" => events.extend(self.finish(TurnStatus::Interrupted, time)),
            "session.idle" => events.extend(self.finish(
                if data["aborted"] == true {
                    TurnStatus::Interrupted
                } else {
                    TurnStatus::Completed
                },
                time,
            )),
            "session.shutdown" => events.extend(self.finish(
                if self.final_message {
                    TurnStatus::Completed
                } else {
                    TurnStatus::Interrupted
                },
                time,
            )),

            "session.usage_record" => {
                if let Some(call) = super::usage::Counters::from_call(&data["usage"])
                    && let Some(turn) = self.conversation.turns.last()
                {
                    let (last_turn, usage) = self
                        .recorded_usage
                        .get_or_insert_with(|| (turn.id.clone(), Default::default()));
                    if *last_turn != turn.id {
                        last_turn.clone_from(&turn.id);
                        usage.last = Default::default();
                    }
                    usage.last.add(call);
                    usage.total.add(call);
                }
            }
            "session.usage_info" => {
                if let Some(context) = context(data) {
                    self.context = Some(context);
                    events.push(SessionEventKind::ContextReported { context });
                }
            }
            "session.model_change" => {
                self.model = string(data, "newModel");
                self.effort = string(data, "reasoningEffort");
                self.context = None;
            }
            "session.compaction_complete" => self.context = None,
            _ => {}
        }
        events
    }

    fn apply_user_message(
        &mut self,
        event: &SessionEvent,
        time: Option<u64>,
        events: &mut Vec<SessionEventKind>,
    ) {
        let data = &event.data;
        let id = data["messageId"].as_str().unwrap_or(&event.id);
        let interaction = string(data, "interactionId");
        let same_interaction = interaction.is_some() && interaction == self.interaction;

        if self.active_turn().is_none() || (!same_interaction && data["delivery"] != "steering") {
            events.extend(self.finish(TurnStatus::Completed, time));
            let turn = Turn {
                id: id.into(),
                origin: TurnOrigin::User,
                status: TurnStatus::InProgress,
                started_at_ms: time,
                completed_at_ms: None,
                items: vec![],
            };
            events.push(SessionEventKind::TurnStarted {
                turn: TurnState::from(&turn),
            });
            self.conversation.turns.push(turn);
            self.conversation.status = ThreadStatus::Active {
                active_flags: vec![],
            };
            self.final_message = false;
        }
        if interaction.is_some() {
            self.interaction = interaction;
        }

        let text = data["content"].as_str().unwrap_or_default();
        if self.conversation.preview.is_empty() {
            self.conversation.preview = text.into();
        }
        let images = data["attachments"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|attachment| string(attachment, "path"))
            .collect::<Vec<_>>();
        let mut item = submitted_user_message(id, text, &images);
        item.observed_at_ms = time;
        events.extend(self.item(item, time));

        if data["delivery"] == "queued"
            && let Ok(turns_page) = self.page(None, 8)
        {
            events.push(SessionEventKind::ConversationReplaced { turns_page });
            if let Some(context) = self.context {
                events.push(SessionEventKind::ContextReported { context });
            }
        }
        self.conversation.recency_at_ms = time;
    }

    pub fn has_final_message(&self) -> bool {
        self.final_message
    }

    pub fn settle_cold(&mut self) {
        let status = if self.final_message {
            TurnStatus::Completed
        } else {
            TurnStatus::Interrupted
        };
        self.finish(status, Some(self.conversation.updated_at_ms));
    }

    fn item(&mut self, item: ConversationItem, time: Option<u64>) -> Option<SessionEventKind> {
        let turn = self.conversation.turns.last_mut()?;
        if let Some(old) = turn.items.iter_mut().find(|old| old.id == item.id) {
            *old = item.clone();
        } else {
            turn.items.push(item.clone());
        }
        Some(SessionEventKind::ItemChanged {
            turn_id: turn.id.clone(),
            item,
            at_ms: time.unwrap_or(0),
        })
    }

    fn native_item(&self, event: &SessionEvent, time: Option<u64>) -> Option<ConversationItem> {
        let data = &event.data;
        let event_type = event.event_type.as_str();
        let id = match event_type {
            "assistant.message" | "assistant.message_delta" => data["messageId"].as_str(),
            "assistant.reasoning" | "assistant.reasoning_delta" => data["reasoningId"].as_str(),
            "tool.execution_start" | "tool.execution_complete" => data["toolCallId"].as_str(),
            _ => None,
        }
        .unwrap_or(&event.id);

        let old = self
            .conversation
            .turns
            .last()?
            .items
            .iter()
            .find(|item| item.id == id);
        if event_type.ends_with("_delta")
            && old.is_some_and(|item| item.status == ActivityStatus::Completed)
        {
            return None;
        }

        let mut status = ActivityStatus::Completed;
        let kind = match event_type {
            "assistant.message" | "assistant.message_delta" => {
                let text = if event_type.ends_with("_delta") {
                    status = ActivityStatus::InProgress;
                    let prefix = match old.map(|item| &item.kind) {
                        Some(ItemKind::AssistantMessage { text, .. }) => text.as_str(),
                        _ => "",
                    };
                    format!("{prefix}{}", data["deltaContent"].as_str()?)
                } else {
                    data["content"].as_str()?.into()
                };
                if text.is_empty() {
                    return None;
                }
                ItemKind::AssistantMessage {
                    text,
                    phase: match data["phase"].as_str() {
                        Some("final_answer") => Some(MessagePhase::Final),
                        Some("commentary") => Some(MessagePhase::Progress),
                        _ => None,
                    },
                    suggested_prompts: vec![],
                }
            }
            "assistant.reasoning" | "assistant.reasoning_delta" => {
                let text = if event_type.ends_with("_delta") {
                    status = ActivityStatus::InProgress;
                    let prefix = match old.map(|item| &item.kind) {
                        Some(ItemKind::Reasoning { content, .. }) => content.concat(),
                        _ => String::new(),
                    };
                    format!("{prefix}{}", data["deltaContent"].as_str()?)
                } else {
                    data["content"].as_str()?.into()
                };
                ItemKind::Reasoning {
                    summary: vec![],
                    content: vec![text],
                }
            }
            "tool.execution_start" => {
                status = ActivityStatus::InProgress;
                ItemKind::ToolCall(ToolCall {
                    name: string(data, "toolName")?,
                    server: string(data, "mcpServerName"),
                    input: data.get("arguments").cloned(),
                    result: vec![],
                    duration_ms: None,
                })
            }
            "tool.execution_complete" => {
                let Some(ItemKind::ToolCall(tool)) = old.map(|item| &item.kind) else {
                    return None;
                };
                let mut tool = tool.clone();
                if data["success"] == false {
                    status = ActivityStatus::Failed;
                }
                if let Some(result) = data.get("result").or_else(|| data.get("error")) {
                    tool.result = vec![match result
                        .get("content")
                        .and_then(Value::as_str)
                        .or_else(|| result.as_str())
                    {
                        Some(text) => ToolResultPart::Text(text.into()),
                        None => ToolResultPart::Json(result.clone()),
                    }];
                }
                ItemKind::ToolCall(tool)
            }
            "session.error" => {
                status = ActivityStatus::Failed;
                ItemKind::Failure {
                    text: string(data, "message")?,
                }
            }
            _ => return None,
        };

        Some(ConversationItem {
            id: id.into(),
            observed_at_ms: old.and_then(|item| item.observed_at_ms).or(time),
            status,
            kind,
        })
    }
}

pub(super) fn string(data: &Value, key: &str) -> Option<String> {
    data[key].as_str().map(str::to_owned)
}

pub(super) fn context(data: &Value) -> Option<ContextUsage> {
    let used_tokens = data["currentTokens"].as_u64()?;
    let window_tokens = data["tokenLimit"].as_u64().filter(|n| *n > 0)?;
    Some(ContextUsage {
        used_tokens,
        window_tokens,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(id: &str, kind: &str, data: Value) -> SessionEvent {
        serde_json::from_value(json!({
            "id": id,
            "timestamp": "2026-11-19T06:01:00Z",
            "parentId": null,
            "type": kind,
            "data": data,
        }))
        .unwrap()
    }

    #[test]
    fn recorded_usage_recovers_call_totals_without_reconstructing_context_occupancy() {
        let mut record = Record::new("task", "/work");
        for (id, tokens) in [("one", 20), ("two", 30)] {
            record.apply(&event(
                id,
                "user.message",
                json!({ "messageId": id, "delivery": "idle", "content": id }),
            ));
            let account = event(
                &format!("usage-{id}"),
                "session.usage_record",
                json!({ "usage": { "inputTokens": tokens, "outputTokens": 2 } }),
            );
            record.apply(&account);
            record.apply(&account);
        }

        assert!(record.context.is_none());
        let (turn, usage) = record.recorded_usage.unwrap();
        assert_eq!(turn, "two");
        let tokens = usage.normalized(None);
        assert_eq!(tokens.last.total_tokens, 32);
        assert_eq!(tokens.total.total_tokens, 54);
    }

    #[test]
    fn queued_and_steering_messages_use_their_delivered_interaction_and_native_id() {
        let mut record = Record::new("task", "/work");
        let first = event(
            "a",
            "user.message",
            json!({
                "messageId": "one",
                "interactionId": "first",
                "delivery": "idle",
                "content": "original",
            }),
        );
        record.apply(&first);
        record.apply(&first);
        record.apply(&event(
            "b",
            "user.message",
            json!({
                "messageId": "immediate",
                "interactionId": "first",
                "delivery": "steering",
                "content": "follow",
            }),
        ));

        let relocated = record.apply(&event(
            "c",
            "user.message",
            json!({
                "messageId": "queued",
                "interactionId": "second",
                "delivery": "queued",
                "content": "follow",
            }),
        ));
        assert!(matches!(
            relocated.last(),
            Some(SessionEventKind::ConversationReplaced { .. })
        ));

        record.apply(&event(
            "d",
            "assistant.message_delta",
            json!({ "messageId": "response", "deltaContent": "hel" }),
        ));
        record.apply(&event(
            "e",
            "assistant.message",
            json!({
                "messageId": "response",
                "content": "hello",
                "phase": "final_answer",
            }),
        ));
        record.settle_cold();

        let newest = record.page(None, 1).unwrap();
        assert_eq!(newest.turns[0].id, "queued");
        assert_eq!(
            newest.turns[0]
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["queued", "response"]
        );
        assert_eq!(newest.turns[0].status, TurnStatus::Completed);

        let older = record.page(newest.next_cursor.as_deref(), 1).unwrap();
        assert_eq!(
            older.turns[0]
                .items
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["one", "immediate"]
        );
        assert!(older.next_cursor.is_none());
        assert!(record.page(Some("missing-boundary"), 1).is_err());
    }

    #[test]
    fn context_occupancy_requires_both_native_measurements() {
        assert_eq!(
            context(&json!({ "currentTokens": 0, "tokenLimit": 128000 })),
            Some(ContextUsage {
                used_tokens: 0,
                window_tokens: 128000
            })
        );
        assert!(context(&json!({ "currentTokens": 40 })).is_none());
        assert!(context(&json!({ "currentTokens": 40, "tokenLimit": 0 })).is_none());
    }
}
