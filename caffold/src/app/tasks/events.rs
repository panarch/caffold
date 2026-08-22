use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::sync::broadcast;

use crate::agent::{
    ActivityStatus, ApprovalOutcome, ApprovalRequest, Conversation, ConversationItem, ItemKind,
    MessageContent, Turn, TurnStatus,
};

use super::generated_images::{GeneratedImageObservation, GeneratedImageStore};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskEventRecord {
    pub(in crate::app) id: String,
    pub(in crate::app) thread_id: String,
    #[serde(rename = "type")]
    pub(in crate::app) event_type: String,
    pub(in crate::app) summary: String,
    pub(in crate::app) payload: Option<JsonValue>,
    pub(in crate::app) created_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::app) updated_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::app) sort_index: Option<u32>,
    #[serde(skip)]
    pub(in crate::app) generated_image: Option<GeneratedImageObservation>,
}

#[derive(Clone, Default)]
pub(in crate::app) struct LiveTaskEventCache {
    pub(in crate::app) events: Arc<Mutex<HashMap<String, Vec<TaskEventRecord>>>>,
}

pub(in crate::app) const LIVE_TASK_EVENT_LIMIT_PER_THREAD: usize = 256;
pub(in crate::app) const LIVE_TASK_THREAD_LIMIT: usize = 128;

impl LiveTaskEventCache {
    #[cfg(test)]
    pub(in crate::app) fn observe(&self, events: &[TaskEventRecord]) {
        for event in events {
            self.record(event.clone());
        }
    }

    pub(in crate::app) fn record(&self, mut event: TaskEventRecord) -> TaskEventRecord {
        let Ok(mut events) = self.events.lock() else {
            return event;
        };
        let thread_id = event.thread_id.clone();
        if !events.contains_key(&thread_id) && events.len() >= LIVE_TASK_THREAD_LIMIT {
            let oldest_thread = events
                .iter()
                .min_by_key(|(_, items)| {
                    items
                        .iter()
                        .map(|item| item.updated_ms.unwrap_or(item.created_ms))
                        .max()
                        .unwrap_or_default()
                })
                .map(|(thread_id, _)| thread_id.clone());
            if let Some(oldest_thread) = oldest_thread {
                events.remove(&oldest_thread);
            }
        }
        let thread_events = events.entry(thread_id).or_default();
        if let Some(existing) = thread_events.iter_mut().find(|item| item.id == event.id) {
            *existing = merge_task_event_record(existing.clone(), event);
            return existing.clone();
        }
        if is_pending_canonical_user_message(&event)
            && thread_events.iter().any(|canonical| {
                !is_pending_canonical_user_message(canonical)
                    && pending_user_message_matches(&event, canonical)
            })
        {
            return event;
        }
        if event.event_type == "user_message"
            && !is_pending_canonical_user_message(&event)
            && let Some(index) = thread_events
                .iter()
                .position(|pending| pending_user_message_matches(pending, &event))
        {
            thread_events.remove(index);
        }
        if event.sort_index.is_none() {
            event.sort_index = Some(
                thread_events
                    .iter()
                    .filter(|existing| existing.created_ms == event.created_ms)
                    .filter_map(|existing| existing.sort_index)
                    .max()
                    .map_or(0, |index| index.saturating_add(1)),
            );
        }
        thread_events.push(event.clone());
        if thread_events.len() > LIVE_TASK_EVENT_LIMIT_PER_THREAD {
            thread_events.remove(0);
        }
        event
    }

    pub(in crate::app) fn for_thread(&self, thread_id: &str) -> Vec<TaskEventRecord> {
        self.events
            .lock()
            .ok()
            .and_then(|events| events.get(thread_id).cloned())
            .unwrap_or_default()
    }

    pub(in crate::app) fn remove_thread(&self, thread_id: &str) {
        if let Ok(mut events) = self.events.lock() {
            events.remove(thread_id);
        }
    }
}

#[derive(Clone)]
pub(in crate::app) struct TaskEvents {
    sender: broadcast::Sender<TaskEventRecord>,
    cache: LiveTaskEventCache,
    generated_images: GeneratedImageStore,
}

impl Default for TaskEvents {
    fn default() -> Self {
        let (sender, _) = broadcast::channel(256);
        Self {
            sender,
            cache: LiveTaskEventCache::default(),
            generated_images: GeneratedImageStore::default(),
        }
    }
}

impl TaskEvents {
    pub(in crate::app) fn subscribe(&self) -> broadcast::Receiver<TaskEventRecord> {
        self.sender.subscribe()
    }

    pub(in crate::app) fn publish(&self, event: TaskEventRecord) -> TaskEventRecord {
        let event = self.record(event);
        self.broadcast(event.clone());
        event
    }

    pub(in crate::app) fn record(&self, mut event: TaskEventRecord) -> TaskEventRecord {
        self.generated_images.observe(&event);
        event.generated_image = None;
        self.cache.record(event)
    }

    pub(in crate::app) fn broadcast(&self, event: TaskEventRecord) {
        let _ = self.sender.send(event);
    }

    pub(in crate::app) fn observe(&self, events: &[TaskEventRecord]) {
        for event in events {
            self.generated_images.observe(event);
            let mut cached = event.clone();
            cached.generated_image = None;
            self.cache.record(cached);
        }
    }

    pub(in crate::app) fn for_thread(&self, thread_id: &str) -> Vec<TaskEventRecord> {
        self.cache.for_thread(thread_id)
    }

    pub(in crate::app) fn generated_images(&self) -> &GeneratedImageStore {
        &self.generated_images
    }

    pub(in crate::app) fn remove_thread(&self, thread_id: &str) {
        self.cache.remove_thread(thread_id);
        self.generated_images.remove_thread(thread_id);
    }
}

pub(in crate::app) fn merge_task_event_records(
    left: Vec<TaskEventRecord>,
    right: Vec<TaskEventRecord>,
) -> Vec<TaskEventRecord> {
    let mut events = HashMap::<String, TaskEventRecord>::new();
    for event in left {
        events
            .entry(event.id.clone())
            .and_modify(|existing| {
                *existing = merge_task_event_record(existing.clone(), event.clone());
            })
            .or_insert(event);
    }
    for event in right {
        events
            .entry(event.id.clone())
            .and_modify(|existing| {
                *existing =
                    merge_task_event_record_at_incoming_position(existing.clone(), event.clone());
            })
            .or_insert(event);
    }
    events.into_values().collect()
}

pub(in crate::app) fn merge_task_event_record(
    existing: TaskEventRecord,
    incoming: TaskEventRecord,
) -> TaskEventRecord {
    let created_ms = existing.created_ms;
    let sort_index = existing.sort_index;
    let existing_updated_ms = existing.updated_ms.unwrap_or(existing.created_ms);
    let incoming_updated_ms = incoming.updated_ms.unwrap_or(incoming.created_ms);
    let (mut latest, earlier) = if incoming_updated_ms >= existing_updated_ms {
        (incoming, existing)
    } else {
        (existing, incoming)
    };
    latest.payload = match (earlier.payload, latest.payload.take()) {
        (Some(JsonValue::Object(mut earlier)), Some(JsonValue::Object(latest))) => {
            earlier.extend(latest);
            Some(JsonValue::Object(earlier))
        }
        (Some(earlier), None) => Some(earlier),
        (_, latest) => latest,
    };
    latest.created_ms = created_ms;
    latest.sort_index = sort_index;
    latest.generated_image = latest.generated_image.or(earlier.generated_image);
    let updated_ms = existing_updated_ms.max(incoming_updated_ms);
    latest.updated_ms = (updated_ms > created_ms).then_some(updated_ms);
    latest
}

pub(in crate::app) fn merge_task_event_record_at_incoming_position(
    existing: TaskEventRecord,
    incoming: TaskEventRecord,
) -> TaskEventRecord {
    let created_ms = incoming.created_ms;
    let sort_index = incoming.sort_index;
    let mut merged = merge_task_event_record(existing, incoming);
    merged.created_ms = created_ms;
    merged.sort_index = sort_index;
    merged
}

pub(in crate::app) fn sort_task_events(events: &mut [TaskEventRecord]) {
    events.sort_by(|left, right| {
        left.created_ms
            .cmp(&right.created_ms)
            .then_with(|| {
                left.sort_index
                    .unwrap_or(u32::MAX)
                    .cmp(&right.sort_index.unwrap_or(u32::MAX))
            })
            .then_with(|| left.id.cmp(&right.id))
    });
}

/// Every event a conversation's own history implies.
///
/// This is the canonical read: what the agent says happened, rendered as the
/// records the interface shows. Live events carry the same identities, so a
/// turn watched as it ran and the same turn read back later are one timeline
/// rather than two.
pub(in crate::app) fn thread_events(conversation: &Conversation) -> Vec<TaskEventRecord> {
    let thread_id = conversation.id.as_str();
    let mut events = Vec::new();
    let conversation_activity_ms = conversation
        .recency_at_ms
        .unwrap_or(conversation.updated_at_ms)
        .max(conversation.created_at_ms);
    let turns = conversation.turns.as_slice();
    let mut previous_turn_ms = conversation.created_at_ms.saturating_sub(1);
    for (turn_index, turn) in turns.iter().enumerate() {
        let turn_id = turn.id.as_str();
        // A turn with no time of its own still has to land after the turn
        // before it, or the conversation reorders itself on reload.
        let minimum_turn_ms = if turn_index == 0 {
            conversation.created_at_ms
        } else {
            previous_turn_ms.saturating_add(1)
        };
        let fallback_ms = turn.completed_at_ms.unwrap_or_else(|| {
            if turn_index + 1 == turns.len() {
                conversation_activity_ms
            } else {
                minimum_turn_ms
            }
        });
        let timeline_ms = turn
            .started_at_ms
            .unwrap_or(fallback_ms)
            .max(minimum_turn_ms);
        if turn.started_at_ms.is_some() {
            events.push(turn_started_event(thread_id, turn_id, timeline_ms));
        }
        for (index, item) in turn.items.iter().enumerate() {
            if let Some(mut event) = task_event_from_item(thread_id, turn_id, timeline_ms, item) {
                event.sort_index = Some(u32::try_from(index).unwrap_or(u32::MAX).saturating_add(1));
                events.push(event);
            }
        }
        if let Some(completed_ms) = turn.completed_at_ms {
            let completed_ms = completed_ms.max(timeline_ms);
            events.push(turn_completed_event(thread_id, turn, completed_ms));
            previous_turn_ms = completed_ms;
        } else {
            previous_turn_ms = timeline_ms;
        }
    }
    events
}

/// A turn beginning, from history or from the agent saying so live.
///
/// Both paths build the same identity and the same payload, so the two records
/// are one record however the turn was observed.
pub(in crate::app) fn turn_started_event(
    thread_id: &str,
    turn_id: &str,
    started_ms: u64,
) -> TaskEventRecord {
    let mut event = task_event_record(
        thread_id,
        &format!("{turn_id}:started"),
        "turn_started",
        "Turn started",
        Some(json!({ "threadId": thread_id, "turnId": turn_id })),
        started_ms,
    );
    // A turn's own start opens the group the turn's items sort into.
    event.sort_index = Some(0);
    event
}

pub(in crate::app) fn turn_completed_event(
    thread_id: &str,
    turn: &Turn,
    completed_ms: u64,
) -> TaskEventRecord {
    let summary = match turn.status {
        TurnStatus::Failed => "Turn failed",
        TurnStatus::Interrupted => "Turn interrupted",
        TurnStatus::Completed => "Turn completed",
        TurnStatus::InProgress => "Turn updated",
    };
    task_event_record(
        thread_id,
        &format!("{}:completed", turn.id),
        "turn_completed",
        summary,
        Some(json!({
            "threadId": thread_id,
            "turnId": turn.id,
            "status": turn.status,
        })),
        completed_ms,
    )
}

/// One conversation item, as the interface receives it.
///
/// Every item event carries the same identity and the same status, so a surface
/// can say that something is happening without first knowing which kind of item
/// it is looking at. What each kind adds is what its own surface draws.
///
/// `None` means there is nothing to show: an agent announces a message or a
/// piece of reasoning before writing any of it, and an empty bubble is worse
/// than waiting for the words.
pub(in crate::app) fn task_event_from_item(
    thread_id: &str,
    turn_id: &str,
    created_ms: u64,
    item: &ConversationItem,
) -> Option<TaskEventRecord> {
    let identity = json!({
        "threadId": thread_id,
        "turnId": turn_id,
        "itemId": item.id,
        "status": item.status,
    });
    let (event_type, summary, extra, generated_image) = match &item.kind {
        ItemKind::UserMessage { text, content } => {
            // A prompt Caffold sent carries the ambient browser state Caffold
            // wrapped around it. Unwrapping here keeps the conversation showing
            // what the person actually typed.
            let text = strip_ambient_browser_context(text).to_string();
            let images = content.iter().any(|entry| {
                matches!(
                    entry,
                    MessageContent::Image { .. } | MessageContent::LocalImage { .. }
                )
            });
            if text.trim().is_empty() && !images {
                return None;
            }
            (
                "user_message",
                "User prompt".to_string(),
                json!({ "text": text, "content": message_content_payload(content) }),
                None,
            )
        }
        ItemKind::AssistantMessage { text, phase } => {
            if text.trim().is_empty() {
                return None;
            }
            (
                "assistant_message",
                "Assistant response".to_string(),
                json!({ "text": text, "phase": phase }),
                None,
            )
        }
        ItemKind::Reasoning { summary, content } => {
            if summary.is_empty() && content.is_empty() {
                return None;
            }
            let label = if summary.is_empty() && !content.is_empty() {
                "Reasoning"
            } else {
                "Reasoning summary"
            };
            (
                "reasoning",
                label.to_string(),
                json!({ "summary": summary, "content": content }),
                None,
            )
        }
        ItemKind::Plan { text } => {
            if text.trim().is_empty() {
                return None;
            }
            (
                "plan",
                "Plan updated".to_string(),
                json!({ "text": text }),
                None,
            )
        }
        ItemKind::CommandExecution(command) => (
            "command_execution",
            format!("Command {}", activity_word(item.status)),
            json!({
                "command": command.command,
                "cwd": command.cwd,
                "output": command.output,
                "exitCode": command.exit_code,
                "durationMs": command.duration_ms,
            }),
            None,
        ),
        ItemKind::Failure { text } => {
            if text.trim().is_empty() {
                return None;
            }
            (
                "agent_failure",
                "Agent failure".to_string(),
                json!({ "text": text }),
                None,
            )
        }
        ItemKind::FileChange { paths } => (
            "file_change",
            format!("File changes: {}", paths.len()),
            json!({ "paths": paths }),
            None,
        ),
        ItemKind::GeneratedImage(image) => (
            "generated_image",
            if image.is_available() {
                "Image generated".to_string()
            } else {
                "Generating image".to_string()
            },
            json!({
                "revisedPrompt": image.revised_prompt,
                "available": image.is_available(),
                "name": GENERATED_IMAGE_NAME,
            }),
            GeneratedImageObservation::for_item(&item.id, image),
        ),
        ItemKind::ToolCall { name } => (
            "tool_call",
            format!("{name}: {}", activity_word(item.status)),
            json!({ "name": name }),
            None,
        ),
    };
    let mut event = task_event_record(
        thread_id,
        &format!("{turn_id}:{}", item.id),
        event_type,
        &summary,
        Some(merged_payload(identity, extra)),
        created_ms,
    );
    event.generated_image = generated_image;
    Some(event)
}

/// An approval the agent is waiting on, as the interface asks it.
///
/// The driver has already written this for a person to read, so the payload is
/// the request itself: what is being asked, the specifics worth checking, and
/// the answers this request accepts.
pub(in crate::app) fn approval_requested_event(
    thread_id: &str,
    request: &ApprovalRequest,
    created_ms: u64,
) -> TaskEventRecord {
    let detail = &request.detail;
    task_event_record(
        thread_id,
        &format!("approval_requested:{}", request.id),
        "approval_requested",
        &request.title,
        Some(json!({
            "threadId": thread_id,
            "turnId": request.turn_id,
            "itemId": request.item_id,
            "approvalId": request.id,
            "title": request.title,
            "reason": request.reason,
            "command": detail.command,
            "cwd": detail.cwd,
            "networkEndpoint": detail.network_endpoint,
            "permissions": detail.permissions,
            "grantRoot": detail.grant_root,
            "environment": detail.environment,
            "decisions": request.decisions,
        })),
        created_ms,
    )
}

/// An approval that is no longer pending, however it ended.
pub(in crate::app) fn approval_resolved_event(
    thread_id: &str,
    request: &ApprovalRequest,
    outcome: ApprovalOutcome,
) -> TaskEventRecord {
    let summary = match outcome {
        ApprovalOutcome::Decided(_) => "Approval answered",
        ApprovalOutcome::AnsweredElsewhere => "Approval answered elsewhere",
        ApprovalOutcome::Expired => "Approval expired",
    };
    task_event_record(
        thread_id,
        &format!("approval_resolved:{}", request.id),
        "approval_resolved",
        summary,
        Some(json!({
            "threadId": thread_id,
            "turnId": request.turn_id,
            "approvalId": request.id,
            "outcome": outcome.as_str(),
        })),
        now_ms(),
    )
}

/// A prompt Caffold has accepted but the agent has not reported back yet.
///
/// It stands in for the canonical message so the conversation shows the prompt
/// immediately, and steps aside once the real one arrives — which is what the
/// matching below is for.
pub(in crate::app) fn accepted_user_message_event(
    thread_id: &str,
    turn_id: &str,
    prompt: &str,
    images: &[String],
) -> TaskEventRecord {
    let content = prompt
        .is_empty()
        .then(Vec::new)
        .unwrap_or_else(|| vec![json!({ "type": "text", "text": prompt })])
        .into_iter()
        .chain(
            images
                .iter()
                .map(|url| json!({ "type": "image", "url": url })),
        )
        .collect::<Vec<_>>();
    task_event_record(
        thread_id,
        &format!("{turn_id}:accepted_user_message:{}", uuid::Uuid::new_v4()),
        "user_message",
        "User prompt",
        Some(json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "text": prompt,
            "content": content,
            "pendingCanonical": true,
        })),
        now_ms(),
    )
}

pub(in crate::app) fn is_pending_canonical_user_message(event: &TaskEventRecord) -> bool {
    event.event_type == "user_message"
        && event
            .payload
            .as_ref()
            .and_then(|payload| payload.get("pendingCanonical"))
            .and_then(JsonValue::as_bool)
            .unwrap_or(false)
}

pub(in crate::app) fn pending_user_message_matches(
    pending: &TaskEventRecord,
    canonical: &TaskEventRecord,
) -> bool {
    if !is_pending_canonical_user_message(pending) || canonical.event_type != "user_message" {
        return false;
    }
    let Some(pending_payload) = pending.payload.as_ref() else {
        return false;
    };
    let Some(canonical_payload) = canonical.payload.as_ref() else {
        return false;
    };
    pending_payload.get("turnId").and_then(JsonValue::as_str)
        == canonical_payload.get("turnId").and_then(JsonValue::as_str)
        && user_message_event_text(pending_payload) == user_message_event_text(canonical_payload)
        && user_message_event_images(pending_payload)
            == user_message_event_images(canonical_payload)
}

pub(in crate::app) fn user_message_event_text(payload: &JsonValue) -> String {
    payload
        .get("text")
        .and_then(JsonValue::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub(in crate::app) fn user_message_event_images(payload: &JsonValue) -> Vec<String> {
    payload
        .get("content")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|item| {
            matches!(
                item.get("type").and_then(JsonValue::as_str),
                Some("image" | "localImage")
            )
        })
        .map(|item| {
            item.get("url")
                .or_else(|| item.get("path"))
                .and_then(JsonValue::as_str)
                .unwrap_or_default()
                .to_string()
        })
        .collect()
}

/// One record, in the shape the interface reads every event in.
///
/// The identifier is scoped to its thread so that events from two Tasks cannot
/// collide in a cache or a merge.
pub(in crate::app) fn task_event_record(
    thread_id: &str,
    event_id: &str,
    event_type: &str,
    summary: &str,
    payload: Option<JsonValue>,
    created_ms: u64,
) -> TaskEventRecord {
    TaskEventRecord {
        id: format!("{thread_id}:{event_id}"),
        thread_id: thread_id.to_string(),
        event_type: event_type.to_string(),
        summary: summary.to_string(),
        payload,
        created_ms,
        updated_ms: None,
        sort_index: None,
        generated_image: None,
    }
}

/// The filename the browser saves a generated image under.
const GENERATED_IMAGE_NAME: &str = "Generated image.png";

fn activity_word(status: ActivityStatus) -> &'static str {
    match status {
        ActivityStatus::InProgress => "running",
        ActivityStatus::Completed => "completed",
        ActivityStatus::Failed => "failed",
        ActivityStatus::Declined => "declined",
    }
}

fn message_content_payload(content: &[MessageContent]) -> Vec<JsonValue> {
    content
        .iter()
        .map(|entry| match entry {
            MessageContent::Text { text } => json!({ "type": "text", "text": text }),
            MessageContent::Image { url } => json!({ "type": "image", "url": url }),
            MessageContent::LocalImage { path } => json!({ "type": "localImage", "path": path }),
        })
        .collect()
}

/// The identity every item event carries, plus what its own kind adds.
fn merged_payload(mut identity: JsonValue, extra: JsonValue) -> JsonValue {
    if let (Some(identity), JsonValue::Object(extra)) = (identity.as_object_mut(), extra) {
        identity.extend(extra);
    }
    identity
}

/// The prompt a person typed, with the ambient state Caffold wrapped around it.
///
/// Caffold sends in-app browser context along with a prompt so the agent can
/// see what the person was looking at. That block is Caffold's own addition, so
/// Caffold takes it back off before showing the prompt.
pub(in crate::app) fn strip_ambient_browser_context(text: &str) -> &str {
    const LEGACY_PREFIX: &str =
        "This block is automatically supplied ambient UI state, not part of the user's request.";
    const STRUCTURED_PREFIX: &str = "<in-app-browser-context source=\"ambient-ui-state\">";
    let trimmed = text.trim_start();
    let ambient_start = trimmed
        .find(STRUCTURED_PREFIX)
        .or_else(|| trimmed.find(LEGACY_PREFIX));
    let Some(ambient_start) = ambient_start else {
        return text;
    };
    let ambient = &trimmed[ambient_start..];

    for marker in ["## My request for Codex:", "My request for Codex:"] {
        if let Some(start) = ambient.rfind(marker) {
            let request = ambient[start + marker.len()..].trim();
            if !request.is_empty() {
                return request;
            }
        }
    }
    text
}

pub(in crate::app) fn non_empty_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(in crate::app) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A conversation decoded the way the adapter decodes a real response, so a
    /// test cannot assert against a shape the adapter would have rejected.
    fn conversation(thread: JsonValue) -> Conversation {
        let thread: crate::agent::codex::CodexThread =
            serde_json::from_value(thread).expect("the fixture decodes as a Codex thread");
        Conversation::from(&thread)
    }

    /// The prompt text a user message reaches the conversation with.
    ///
    /// Caffold wraps ambient browser state around a prompt before sending it,
    /// so what a person sees back is what survives unwrapping.
    fn prompt_text(item: JsonValue) -> String {
        let item = json!({
            "type": "userMessage",
            "id": "item_prompt",
            "content": item["content"],
        });
        let event = codex_item_event("turn_1", 1, ActivityStatus::Completed, item)
            .expect("a prompt reaches the conversation");
        event.payload.expect("a user message payload")["text"]
            .as_str()
            .expect("prompt text")
            .to_string()
    }

    /// One Codex item, rendered the way a live notification renders it.
    fn codex_item_event(
        turn_id: &str,
        created_ms: u64,
        reported: ActivityStatus,
        item: JsonValue,
    ) -> Option<TaskEventRecord> {
        let item = crate::agent::codex::conversation_item(&item, reported)?;
        task_event_from_item("thread_1", turn_id, created_ms, &item)
    }

    /// One item from Codex's raw model-output stream, which reports work that
    /// has already happened.
    fn codex_response_event(
        turn_id: &str,
        created_ms: u64,
        item: JsonValue,
    ) -> Option<TaskEventRecord> {
        let item = crate::agent::codex::response_item(&item)?;
        task_event_from_item("thread_1", turn_id, created_ms, &item)
    }

    #[test]
    fn generated_images_normalize_without_exposing_raw_assets() {
        let event = codex_item_event(
            "turn_1",
            1,
            ActivityStatus::Completed,
            json!({
                "type": "imageGeneration",
                "id": "image_1",
                "status": "completed",
                "result": "iVBORw0KGgo=",
                "revisedPrompt": "A clearer diagram",
                "savedPath": "/tmp/generated_images/thread_1/image_1.png"
            }),
        )
        .expect("generated image event");

        assert_eq!(event.id, "thread_1:turn_1:image_1");
        assert_eq!(event.event_type, "generated_image");
        assert_eq!(event.payload.as_ref().unwrap()["itemId"], "image_1");
        assert_eq!(
            event.payload.as_ref().unwrap()["revisedPrompt"],
            "A clearer diagram"
        );
        assert!(event.generated_image.is_some());
        let serialized = serde_json::to_string(&event).expect("serialize generated image event");
        assert!(!serialized.contains("savedPath"));
        assert!(!serialized.contains("iVBORw0KGgo="));
    }

    #[test]
    fn raw_and_canonical_generated_images_share_the_same_event_identity() {
        let raw = codex_response_event(
            "turn_1",
            1,
            json!({
                "type": "image_generation_call",
                "id": "image_1",
                "status": "completed",
                "result": "iVBORw0KGgo=",
                "revised_prompt": "A clearer diagram"
            }),
        )
        .expect("raw generated image event");
        let canonical = codex_item_event(
            "turn_1",
            2,
            ActivityStatus::Completed,
            json!({
                "type": "imageGeneration",
                "id": "image_1",
                "status": "completed",
                "result": "iVBORw0KGgo=",
                "savedPath": "/tmp/generated_images/thread_1/image_1.png"
            }),
        )
        .expect("canonical generated image event");

        assert_eq!(raw.id, canonical.id);
        assert_eq!(raw.event_type, canonical.event_type);
        assert_eq!(
            merge_task_event_records(vec![raw], vec![canonical]).len(),
            1
        );
    }

    #[test]
    fn work_caffold_has_no_surface_for_still_reaches_the_conversation() {
        // Compacting context is not a tool call, and Codex's name for it would
        // mean nothing to a reader. It still has to appear, and it still has to
        // be one entry that finishes rather than two.
        let compaction = json!({
            "type": "contextCompaction",
            "id": "context_compaction_1"
        });
        let started =
            codex_item_event("turn_1", 10, ActivityStatus::InProgress, compaction.clone())
                .expect("context compaction started event");
        let completed = codex_item_event("turn_1", 20, ActivityStatus::Completed, compaction)
            .expect("context compaction completed event");

        assert_eq!(started.id, completed.id);
        assert_eq!(started.event_type, "tool_call");
        assert_eq!(
            started.payload.as_ref().unwrap()["name"],
            "Compacting context"
        );
        assert_eq!(started.payload.as_ref().unwrap()["status"], "inProgress");

        let merged = merge_task_event_record(started, completed);
        assert_eq!(merged.created_ms, 10);
        assert_eq!(merged.updated_ms, Some(20));
        assert_eq!(merged.payload.as_ref().unwrap()["status"], "completed");
    }

    #[test]
    fn task_user_messages_hide_legacy_ambient_browser_context() {
        let item = json!({
            "content": [{
                "type": "text",
                "text": concat!(
                    "This block is automatically supplied ambient UI state, not part of the user's request. ",
                    "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.\n",
                    "# In app browser:\n",
                    "- The user has the in-app browser open with 1 tab.\n",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n\n",
                    "My request for Codex:\n",
                    "실제 요청만 보여줘"
                )
            }]
        });

        assert_eq!(prompt_text(item), "실제 요청만 보여줘");
    }

    #[test]
    fn task_user_messages_hide_structured_ambient_browser_context() {
        let item = json!({
            "content": [{
                "type": "text",
                "text": concat!(
                    "<in-app-browser-context source=\"ambient-ui-state\">\n",
                    "This block is automatically supplied ambient UI state, not part of the user's request.\n",
                    "# In app browser:\n",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n",
                    "</in-app-browser-context>\n\n",
                    "## My request for Codex:\n",
                    "Show only this request."
                )
            }]
        });

        assert_eq!(prompt_text(item), "Show only this request.");
    }

    #[test]
    fn task_user_messages_accept_app_server_input_text_items() {
        let item = json!({
            "content": [{
                "type": "input_text",
                "text": concat!(
                    "\n<in-app-browser-context source=\"ambient-ui-state\">\n",
                    "This block is automatically supplied ambient UI state, not part of the user's request. ",
                    "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.\n",
                    "# In app browser:\n",
                    "- The user has the in-app browser open with 1 tab.\n",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n",
                    "</in-app-browser-context>\n\n",
                    "## My request for Codex:\n",
                    "실제 요청만 보여줘\n"
                )
            }]
        });

        assert_eq!(prompt_text(item), "실제 요청만 보여줘");
    }

    #[test]
    fn task_user_messages_hide_ambient_context_with_leading_space_and_single_newlines() {
        let item = json!({
            "content": [{
                "type": "text",
                "text": concat!(
                    "\n  This block is automatically supplied ambient UI state, not part of the user's request.\n",
                    "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.\n",
                    "# In app browser:\n",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n",
                    "My request for Codex:\n",
                    "실제 요청만 보여줘"
                )
            }]
        });

        assert_eq!(prompt_text(item), "실제 요청만 보여줘");
    }

    #[test]
    fn task_user_messages_hide_ambient_context_when_the_gui_flattens_newlines() {
        let item = json!({
            "content": [{
                "type": "text",
                "text": concat!(
                    "This block is automatically supplied ambient UI state, not part of the user's request. ",
                    "Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser. ",
                    "# In app browser: - The user has the in-app browser open with 1 tab. ",
                    "- Current URL: http://127.0.0.1:5178/tasks/thread-1 ",
                    "My request for Codex: 실제 요청만 보여줘"
                )
            }]
        });

        assert_eq!(prompt_text(item), "실제 요청만 보여줘");
    }

    #[test]
    fn task_user_messages_hide_ambient_context_after_attachment_metadata() {
        let item = json!({
            "content": [
                {
                    "type": "input_text",
                    "text": concat!(
                        "# Files mentioned by the user:\n\n",
                        "codex-clipboard-example.png: /tmp/codex-clipboard-example.png\n\n"
                    )
                },
                {
                    "type": "input_text",
                    "text": concat!(
                        "<in-app-browser-context source=\"ambient-ui-state\">\n",
                        "This block is automatically supplied ambient UI state, not part of the user's request.\n",
                        "# In app browser:\n",
                        "- Current URL: http://127.0.0.1:5178/tasks/thread-1\n",
                        "</in-app-browser-context>\n\n",
                        "## My request for Codex:\n",
                        "실제 요청만 보여줘"
                    )
                }
            ]
        });

        assert_eq!(prompt_text(item), "실제 요청만 보여줘");
    }

    #[test]
    fn thread_read_turns_normalize_transcript_items_into_timeline_events() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "name": "Readable thread",
            "preview": "Inspect the diff",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 5.0,
            "status": { "type": "idle" },
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "startedAt": 2.0,
                    "completedAt": 4.0,
                    "items": [
                        {
                            "type": "userMessage",
                            "id": "item_prompt",
                            "content": [{ "type": "text", "text": "Inspect the diff" }]
                        },
                        {
                            "type": "reasoning",
                            "id": "item_reasoning",
                            "summary": ["Checked the relevant files"],
                            "content": ["Compared the diff"]
                        },
                        {
                            "type": "agentMessage",
                            "id": "item_answer",
                            "text": "The change is ready to review.",
                            "phase": "final"
                        },
                        {
                            "type": "plan",
                            "id": "item_plan",
                            "text": "Open the diff."
                        },
                        {
                            "type": "commandExecution",
                            "id": "item_command",
                            "command": "cargo test",
                            "cwd": "src",
                            "status": "completed",
                            "aggregatedOutput": "test result: ok"
                        },
                        {
                            "type": "fileChange",
                            "id": "item_file_change",
                            "status": "completed",
                            "changes": [{ "path": "src/lib.rs" }]
                        }
                    ]
                }
            ]
        });

        let events = thread_events(&conversation(thread));
        let event_types = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>();
        assert!(event_types.contains(&"turn_started"));
        assert!(event_types.contains(&"user_message"));
        assert!(event_types.contains(&"reasoning"));
        assert!(event_types.contains(&"assistant_message"));
        assert!(event_types.contains(&"plan"));
        assert!(event_types.contains(&"command_execution"));
        assert!(event_types.contains(&"file_change"));
        assert!(event_types.contains(&"turn_completed"));

        let reasoning = events
            .iter()
            .find(|event| event.event_type == "reasoning")
            .unwrap();
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["summary"][0],
            "Checked the relevant files"
        );
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["content"][0],
            "Compared the diff"
        );
        let command = events
            .iter()
            .find(|event| event.event_type == "command_execution")
            .unwrap();
        assert_eq!(
            command.payload.as_ref().unwrap()["output"],
            "test result: ok"
        );
        let assistant = events
            .iter()
            .find(|event| event.event_type == "assistant_message")
            .unwrap();
        assert_eq!(
            assistant.payload.as_ref().unwrap()["text"],
            "The change is ready to review."
        );
    }

    #[test]
    fn missing_turn_start_does_not_move_a_newer_turn_to_thread_creation() {
        let thread = json!({
            "status": { "type": "idle" },
            "id": "thread_1",
            "cwd": "/tmp",
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "recencyAt": 20.0,
            "turns": [
                {
                    "id": "turn_old",
                    "status": "completed",
                    "startedAt": 2.0,
                    "completedAt": 4.0,
                    "items": [
                        {
                            "type": "userMessage",
                            "id": "old_user",
                            "content": [{ "type": "text", "text": "Old prompt" }]
                        },
                        {
                            "type": "agentMessage",
                            "id": "old_answer",
                            "text": "Old answer",
                            "phase": "final"
                        }
                    ]
                },
                {
                    "id": "turn_new",
                    "status": "completed",
                    "startedAt": null,
                    "completedAt": 20.0,
                    "items": [
                        {
                            "type": "userMessage",
                            "id": "new_user",
                            "content": [{ "type": "text", "text": "New prompt" }]
                        },
                        {
                            "type": "agentMessage",
                            "id": "new_answer",
                            "text": "New answer",
                            "phase": "final"
                        }
                    ]
                }
            ]
        });

        let mut events = thread_events(&conversation(thread.clone()));
        sort_task_events(&mut events);

        assert!(
            events
                .iter()
                .all(|event| event.id != "thread_1:turn_new:started"),
            "a missing startedAt must not create a turn_started event at thread creation"
        );
        let visible_messages = events
            .iter()
            .filter(|event| {
                matches!(
                    event.event_type.as_str(),
                    "user_message" | "assistant_message"
                )
            })
            .map(|event| {
                (
                    event
                        .payload
                        .as_ref()
                        .and_then(|payload| payload.get("text"))
                        .and_then(JsonValue::as_str)
                        .unwrap()
                        .to_string(),
                    event.created_ms,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            visible_messages,
            vec![
                ("Old prompt".to_string(), 2_000),
                ("Old answer".to_string(), 2_000),
                ("New prompt".to_string(), 20_000),
                ("New answer".to_string(), 20_000),
            ]
        );
    }

    #[test]
    fn an_event_carries_what_it_shows_and_not_the_item_it_came_from() {
        let user = codex_item_event(
            "turn_1",
            1,
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "item_prompt",
                "content": [
                    { "type": "text", "text": "Inspect the diff" },
                    { "type": "image", "url": "data:image/png;base64,aGVsbG8=" }
                ]
            }),
        )
        .expect("user message event");
        let user_payload = user.payload.as_ref().expect("user payload");
        assert!(user_payload.get("item").is_none());
        assert_eq!(user_payload["content"][0]["text"], "Inspect the diff");

        let file_change = codex_item_event(
            "turn_1",
            2,
            ActivityStatus::Completed,
            json!({
                "type": "fileChange",
                "id": "item_file_change",
                "status": "completed",
                "changes": [{
                    "path": "src/lib.rs",
                    "diff": "UNIQUE_LARGE_DIFF_PAYLOAD"
                }]
            }),
        )
        .expect("file change event");
        let file_payload = file_change.payload.as_ref().expect("file payload");
        assert!(file_payload.get("item").is_none());
        assert_eq!(file_payload["paths"][0], "src/lib.rs");
        // The agent's diff does not travel at all. Caffold reviews changes from
        // git, which owns the working tree the agent actually wrote to, so
        // carrying the agent's copy would ship a second and staler source of
        // the same thing.
        assert!(
            !serde_json::to_string(&file_change)
                .expect("serialize event")
                .contains("UNIQUE_LARGE_DIFF_PAYLOAD")
        );
    }

    #[test]
    fn image_only_user_messages_are_kept_in_the_transcript() {
        let thread = json!({
            "status": { "type": "idle" },
            "id": "thread_1",
            "cwd": "/tmp",
            "createdAt": 1.0,
            "turns": [{
                "id": "turn_1",
                "status": "completed",
                "startedAt": 2.0,
                "completedAt": 3.0,
                "items": [{
                    "type": "userMessage",
                    "id": "item_prompt",
                    "content": [{
                        "type": "image",
                        "url": "data:image/png;base64,aGVsbG8="
                    }]
                }]
            }]
        });

        let user_message = thread_events(&conversation(thread.clone()))
            .into_iter()
            .find(|event| event.event_type == "user_message")
            .expect("image-only user message");
        let payload = user_message.payload.expect("user message payload");
        assert_eq!(payload["text"], "");
        assert_eq!(payload["content"][0]["type"], "image");
    }

    #[test]
    fn transcript_item_ids_are_scoped_to_their_turn() {
        let thread = json!({
            "status": { "type": "idle" },
            "id": "thread_1",
            "cwd": "/tmp",
            "createdAt": 1.0,
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "startedAt": 1.0,
                    "items": [{
                        "type": "agentMessage",
                        "id": "item-1",
                        "text": "First answer",
                        "phase": "final_answer"
                    }]
                },
                {
                    "id": "turn_2",
                    "status": "completed",
                    "startedAt": 2.0,
                    "items": [{
                        "type": "agentMessage",
                        "id": "item-1",
                        "text": "Second answer",
                        "phase": "final_answer"
                    }]
                }
            ]
        });

        let answer_ids = thread_events(&conversation(thread.clone()))
            .into_iter()
            .filter(|event| event.event_type == "assistant_message")
            .map(|event| event.id)
            .collect::<Vec<_>>();

        assert_eq!(
            answer_ids,
            vec!["thread_1:turn_1:item-1", "thread_1:turn_2:item-1"]
        );
    }

    #[test]
    fn canonical_thread_events_keep_codex_item_order_when_timestamps_match() {
        let thread = json!({
            "status": { "type": "idle" },
            "id": "thread_1",
            "cwd": "/tmp",
            "createdAt": 1.0,
            "turns": [{
                "id": "turn_1",
                "status": "inProgress",
                "startedAt": 2.0,
                "items": [
                    {
                        "id": "item-z",
                        "type": "userMessage",
                        "content": [{ "type": "text", "text": "First" }]
                    },
                    {
                        "id": "item-a",
                        "type": "reasoning",
                        "summary": ["Second"],
                        "content": []
                    },
                    {
                        "id": "item-m",
                        "type": "agentMessage",
                        "phase": "commentary",
                        "text": "Third"
                    }
                ]
            }]
        });

        let mut events = thread_events(&conversation(thread.clone()));
        sort_task_events(&mut events);
        let item_events = events
            .into_iter()
            .filter(|event| {
                event
                    .payload
                    .as_ref()
                    .is_some_and(|payload| payload["itemId"].is_string())
            })
            .map(|event| {
                (
                    event.payload.unwrap()["itemId"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    event.sort_index,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            item_events,
            vec![
                ("item-z".to_string(), Some(1)),
                ("item-a".to_string(), Some(2)),
                ("item-m".to_string(), Some(3)),
            ]
        );
    }

    #[test]
    fn live_task_event_cache_preserves_latest_transient_item_state() {
        let cache = LiveTaskEventCache::default();
        let started = task_event_record(
            "thread_1",
            "turn_1:command_1",
            "command_execution",
            "Command started",
            Some(json!({
                "status": "inProgress",
                "output": "test result: ok"
            })),
            10,
        );
        let completed = task_event_record(
            "thread_1",
            "turn_1:command_1",
            "command_execution",
            "Command completed",
            Some(json!({ "status": "completed" })),
            20,
        );

        cache.record(started.clone());
        cache.record(completed.clone());
        cache.record(task_event_record(
            "thread_2",
            "turn_2:command_1",
            "command_execution",
            "Other command",
            None,
            30,
        ));

        let merged = merge_task_event_records(Vec::new(), cache.for_thread("thread_1"));
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].summary, completed.summary);
        assert_eq!(merged[0].payload.as_ref().unwrap()["status"], "completed");
        assert_eq!(
            merged[0].created_ms, started.created_ms,
            "completing an item must not move it from its original timeline position"
        );
        assert_eq!(
            merged[0].payload.as_ref().unwrap()["output"],
            "test result: ok"
        );

        cache.record(started);
        let merged = cache.for_thread("thread_1");
        assert_eq!(merged[0].summary, completed.summary);
        assert_eq!(merged[0].payload.as_ref().unwrap()["status"], "completed");
    }

    #[test]
    fn live_task_event_cache_preserves_items_omitted_from_later_thread_reads() {
        let cache = LiveTaskEventCache::default();
        let command = task_event_record(
            "thread_1",
            "turn_1:command_1",
            "command_execution",
            "Command completed",
            Some(json!({
                "command": "printf caffold-command",
                "status": "completed"
            })),
            20,
        );

        cache.observe(std::slice::from_ref(&command));
        let later_thread_read = Vec::new();
        let merged = merge_task_event_records(later_thread_read, cache.for_thread("thread_1"));
        let mut positioned_command = command;
        positioned_command.sort_index = Some(0);

        assert_eq!(merged, vec![positioned_command]);
    }

    #[test]
    fn canonical_user_message_replaces_the_locally_accepted_prompt() {
        let cache = LiveTaskEventCache::default();
        let image = "data:image/png;base64,aGVsbG8=".to_string();
        cache.record(accepted_user_message_event(
            "thread_1",
            "turn_1",
            "Inspect this image",
            std::slice::from_ref(&image),
        ));
        let canonical = codex_item_event(
            "turn_1",
            20,
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "item_prompt",
                "content": [
                    { "type": "text", "text": "Inspect this image" },
                    { "type": "image", "url": image }
                ]
            }),
        )
        .expect("canonical user message");

        let canonical = cache.record(canonical);

        assert_eq!(cache.for_thread("thread_1"), vec![canonical]);
    }

    #[test]
    fn late_local_acceptance_does_not_duplicate_an_existing_canonical_prompt() {
        let cache = LiveTaskEventCache::default();
        let canonical = codex_item_event(
            "turn_1",
            20,
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "item_prompt",
                "content": [{ "type": "text", "text": "Already canonical" }]
            }),
        )
        .expect("canonical user message");
        let canonical = cache.record(canonical);

        cache.record(accepted_user_message_event(
            "thread_1",
            "turn_1",
            "Already canonical",
            &[],
        ));

        assert_eq!(cache.for_thread("thread_1"), vec![canonical]);
    }

    #[test]
    fn live_task_event_cache_evicts_the_oldest_thread() {
        let cache = LiveTaskEventCache::default();
        for index in 0..=LIVE_TASK_THREAD_LIMIT {
            cache.record(task_event_record(
                &format!("thread_{index}"),
                "event_1",
                "assistant_message",
                "Answer",
                None,
                index as u64,
            ));
        }

        assert!(cache.for_thread("thread_0").is_empty());
        assert_eq!(
            cache
                .for_thread(&format!("thread_{LIVE_TASK_THREAD_LIMIT}"))
                .len(),
            1
        );
        assert_eq!(cache.events.lock().unwrap().len(), LIVE_TASK_THREAD_LIMIT);
    }

    #[test]
    fn reasoning_content_without_summary_is_preserved() {
        let temp = tempfile::tempdir().unwrap();
        let thread = json!({
            "id": "thread_1",
            "preview": "Inspect the diff",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "idle" },
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "startedAt": 1.0,
                    "items": [
                        {
                            "type": "reasoning",
                            "id": "item_reasoning",
                            "content": ["Reasoned without a summary"]
                        }
                    ]
                }
            ]
        });

        let events = thread_events(&conversation(thread));
        let reasoning = events
            .iter()
            .find(|event| event.event_type == "reasoning")
            .unwrap();

        assert_eq!(reasoning.summary, "Reasoning");
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["content"][0],
            "Reasoned without a summary"
        );
    }

    #[test]
    fn an_agent_failure_crosses_as_its_own_event_rather_than_a_message() {
        let event = task_event_from_item(
            "thread-1",
            "turn-1",
            1,
            &ConversationItem {
                id: "item-1".to_string(),
                status: crate::agent::ActivityStatus::Completed,
                kind: ItemKind::Failure {
                    text: "API Error: Connection refused".to_string(),
                },
            },
        )
        .unwrap();

        assert_eq!(event.event_type, "agent_failure");
        assert_eq!(event.summary, "Agent failure");
        assert_eq!(
            event.payload.as_ref().unwrap()["text"],
            "API Error: Connection refused"
        );
    }

    #[test]
    fn raw_response_items_normalize_assistant_messages() {
        let event = codex_response_event(
            "turn_1",
            1,
            json!({
                "type": "message",
                "id": "raw_answer",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "Raw response fallback." }],
                "phase": "final"
            }),
        )
        .unwrap();

        assert_eq!(event.event_type, "assistant_message");
        assert_eq!(
            event.payload.as_ref().unwrap()["text"],
            "Raw response fallback."
        );
    }

    #[test]
    fn raw_response_reasoning_content_without_summary_is_preserved() {
        let event = codex_response_event(
            "turn_1",
            1,
            json!({
                "type": "reasoning",
                "id": "raw_reasoning",
                "content": [
                    { "type": "reasoning_text", "text": "Raw reasoning content" }
                ]
            }),
        )
        .unwrap();

        assert_eq!(event.event_type, "reasoning");
        assert_eq!(event.summary, "Reasoning");
        assert_eq!(
            event.payload.as_ref().unwrap()["content"][0],
            "Raw reasoning content"
        );
    }
}
