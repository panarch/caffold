use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::sync::broadcast;

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

pub(in crate::app) fn thread_events(thread: &JsonValue) -> Vec<TaskEventRecord> {
    let Some(thread_id) = thread_id(thread) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    let thread_created_ms = seconds_to_ms(thread.get("createdAt").and_then(JsonValue::as_f64));
    let thread_activity_ms = thread
        .get("recencyAt")
        .and_then(JsonValue::as_f64)
        .or_else(|| thread.get("updatedAt").and_then(JsonValue::as_f64))
        .map(seconds_to_ms_value)
        .unwrap_or(thread_created_ms)
        .max(thread_created_ms);
    let turns = thread
        .get("turns")
        .and_then(JsonValue::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut previous_turn_ms = thread_created_ms.saturating_sub(1);
    for (turn_index, turn) in turns.iter().enumerate() {
        let turn_id = turn.get("id").and_then(JsonValue::as_str).unwrap_or("turn");
        let canonical_started_ms = turn
            .get("startedAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value)
            .filter(|value| *value > 0);
        let canonical_completed_ms = turn
            .get("completedAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value)
            .filter(|value| *value > 0);
        let minimum_turn_ms = if turn_index == 0 {
            thread_created_ms
        } else {
            previous_turn_ms.saturating_add(1)
        };
        let fallback_ms = canonical_completed_ms.unwrap_or_else(|| {
            if turn_index + 1 == turns.len() {
                thread_activity_ms
            } else {
                minimum_turn_ms
            }
        });
        let timeline_ms = canonical_started_ms
            .unwrap_or(fallback_ms)
            .max(minimum_turn_ms);
        if canonical_started_ms.is_some() {
            let mut started = task_event_record(
                thread_id,
                &format!("{turn_id}:started"),
                "turn_started",
                "Turn started",
                Some(json!({ "threadId": thread_id, "turnId": turn_id })),
                timeline_ms,
            );
            started.sort_index = Some(0);
            events.push(started);
        }
        for (index, item) in turn
            .get("items")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
            .enumerate()
        {
            let params = json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": item
            });
            if let Some(mut event) = task_event_from_thread_item(thread_id, timeline_ms, &params) {
                event.sort_index = Some(u32::try_from(index).unwrap_or(u32::MAX).saturating_add(1));
                events.push(event);
            }
        }
        if let Some(completed_ms) = canonical_completed_ms {
            let status = turn
                .get("status")
                .and_then(JsonValue::as_str)
                .unwrap_or("completed");
            let summary = match status {
                "failed" => "Turn failed",
                "interrupted" => "Turn interrupted",
                "completed" => "Turn completed",
                _ => "Turn updated",
            };
            events.push(task_event_record(
                thread_id,
                &format!("{turn_id}:completed"),
                "turn_completed",
                summary,
                Some(json!({ "threadId": thread_id, "turnId": turn_id, "status": status })),
                completed_ms.max(timeline_ms),
            ));
            previous_turn_ms = completed_ms.max(timeline_ms);
        } else {
            previous_turn_ms = timeline_ms;
        }
    }
    events
}

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

pub(in crate::app) fn turn_item_event_id(
    turn_id: Option<&str>,
    item_id: Option<&str>,
    fallback: &str,
) -> String {
    match (turn_id, item_id) {
        (Some(turn_id), Some(item_id)) => format!("{turn_id}:{item_id}"),
        (Some(turn_id), None) => format!("{turn_id}:{fallback}"),
        (None, Some(item_id)) => item_id.to_string(),
        (None, None) => fallback.to_string(),
    }
}

pub(in crate::app) fn task_event_from_item_lifecycle(
    thread_id: &str,
    created_ms: u64,
    params: &JsonValue,
    lifecycle: &str,
) -> Option<TaskEventRecord> {
    let event = task_event_from_thread_item(thread_id, created_ms, params)
        .or_else(|| task_event_from_item_activity(thread_id, created_ms, params, lifecycle))?;
    Some(with_item_lifecycle(event, lifecycle))
}

pub(in crate::app) fn with_item_lifecycle(
    mut event: TaskEventRecord,
    lifecycle: &str,
) -> TaskEventRecord {
    if let Some(JsonValue::Object(payload)) = event.payload.as_mut() {
        payload.insert("lifecycle".to_string(), json!(lifecycle));
    }
    event
}

pub(in crate::app) fn task_event_from_item_activity(
    thread_id: &str,
    created_ms: u64,
    params: &JsonValue,
    lifecycle: &str,
) -> Option<TaskEventRecord> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let item_id = item.get("id").and_then(JsonValue::as_str)?;
    let turn_id = params.get("turnId").and_then(JsonValue::as_str);
    let started = lifecycle == "started";
    let summary = match item_type {
        "reasoning" => {
            if started {
                "Thinking"
            } else {
                "Thought"
            }
        }
        "agentMessage" => {
            if started {
                "Preparing response"
            } else {
                "Response ready"
            }
        }
        "plan" => {
            if started {
                "Updating plan"
            } else {
                "Plan updated"
            }
        }
        "mcpToolCall" | "dynamicToolCall" => {
            if started {
                "Calling tool"
            } else {
                "Tool completed"
            }
        }
        "collabAgentToolCall" => {
            if started {
                "Working with agent"
            } else {
                "Agent work completed"
            }
        }
        "webSearch" => {
            if started {
                "Searching the web"
            } else {
                "Web search completed"
            }
        }
        "imageView" => {
            if started {
                "Viewing image"
            } else {
                "Image viewed"
            }
        }
        "imageGeneration" => {
            if started {
                "Generating image"
            } else {
                "Image generated"
            }
        }
        "sleep" => {
            if started {
                "Waiting"
            } else {
                "Wait completed"
            }
        }
        _ => {
            if started {
                "Working"
            } else {
                "Work completed"
            }
        }
    };
    let event_id = turn_item_event_id(turn_id, Some(item_id), "work_status");
    Some(task_event_record(
        thread_id,
        &event_id,
        "work_status",
        summary,
        Some(json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "itemId": item_id,
            "itemType": item_type,
            "lifecycle": lifecycle,
        })),
        created_ms,
    ))
}

pub(in crate::app) fn task_event_from_thread_item(
    thread_id: &str,
    created_ms: u64,
    params: &JsonValue,
) -> Option<TaskEventRecord> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let turn_id = params.get("turnId").and_then(JsonValue::as_str);
    let item_id = item.get("id").and_then(JsonValue::as_str);

    let (event_type, summary, payload, generated_image) = match item_type {
        "userMessage" => {
            let text = user_message_text(item).unwrap_or_default();
            if text.is_empty() && !user_message_has_images(item) {
                return None;
            }
            (
                "user_message",
                "User prompt".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "text": text,
                    "content": item.get("content"),
                }),
                None,
            )
        }
        "agentMessage" => {
            let text = non_empty_string(item.get("text").and_then(JsonValue::as_str))?;
            (
                "assistant_message",
                "Assistant response".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "phase": item.get("phase").and_then(JsonValue::as_str),
                    "text": text,
                }),
                None,
            )
        }
        "reasoning" => {
            let summary = string_array(item.get("summary"));
            let content = string_array(item.get("content"));
            if summary.is_empty() && content.is_empty() {
                return None;
            }
            (
                "reasoning",
                reasoning_event_summary(&summary, &content),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "summary": summary,
                    "content": content,
                }),
                None,
            )
        }
        "plan" => {
            let text = non_empty_string(item.get("text").and_then(JsonValue::as_str))?;
            (
                "plan",
                "Plan updated".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "text": text,
                }),
                None,
            )
        }
        "commandExecution" => (
            "command_execution",
            command_execution_summary(item),
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "command": item.get("command").and_then(JsonValue::as_str),
                "cwd": item.get("cwd").and_then(JsonValue::as_str),
                "status": item.get("status").and_then(JsonValue::as_str),
                "aggregatedOutput": item.get("aggregatedOutput").and_then(JsonValue::as_str),
                "exitCode": item.get("exitCode"),
                "durationMs": item.get("durationMs"),
            }),
            None,
        ),
        "fileChange" => {
            let change_count = item
                .get("changes")
                .and_then(JsonValue::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            (
                "file_change",
                format!("File changes: {change_count}"),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "changeCount": change_count,
                    "status": item.get("status").and_then(JsonValue::as_str),
                    "changes": item.get("changes"),
                }),
                None,
            )
        }
        "imageGeneration" => {
            let generated_image = GeneratedImageObservation::from_item(item)?;
            (
                "generated_image",
                "Image generated".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "status": item.get("status").and_then(JsonValue::as_str),
                    "revisedPrompt": item.get("revisedPrompt").and_then(JsonValue::as_str),
                    "name": "Generated image.png",
                }),
                Some(generated_image),
            )
        }
        _ => return None,
    };
    let event_id = turn_item_event_id(turn_id, item_id, event_type);
    let mut event = task_event_record(
        thread_id,
        &event_id,
        event_type,
        &summary,
        Some(payload),
        created_ms,
    );
    event.generated_image = generated_image;
    Some(event)
}

pub(in crate::app) fn task_event_from_raw_response_item(
    thread_id: &str,
    created_ms: u64,
    params: &JsonValue,
) -> Option<TaskEventRecord> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let turn_id = params.get("turnId").and_then(JsonValue::as_str);
    let item_id = item.get("id").and_then(JsonValue::as_str);

    let (event_type, summary, payload, generated_image) = match item_type {
        "message" => {
            let role = item.get("role").and_then(JsonValue::as_str).unwrap_or("");
            if role != "assistant" {
                return None;
            }
            let text = response_content_text(item.get("content"))?;
            (
                "assistant_message",
                "Assistant response".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "phase": item.get("phase").and_then(JsonValue::as_str),
                    "text": text,
                }),
                None,
            )
        }
        "reasoning" => {
            let summary = reasoning_response_summary(item.get("summary"));
            let content = reasoning_response_content(item.get("content"));
            if summary.is_empty() && content.is_empty() {
                return None;
            }
            (
                "reasoning",
                reasoning_event_summary(&summary, &content),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "summary": summary,
                    "content": content,
                }),
                None,
            )
        }
        "image_generation_call" => {
            let generated_image = GeneratedImageObservation::from_item(item)?;
            (
                "generated_image",
                "Image generated".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "status": item.get("status").and_then(JsonValue::as_str),
                    "revisedPrompt": item.get("revised_prompt").and_then(JsonValue::as_str),
                    "name": "Generated image.png",
                }),
                Some(generated_image),
            )
        }
        _ => return None,
    };
    let event_id = turn_item_event_id(turn_id, item_id, event_type);
    let mut event = task_event_record(
        thread_id,
        &event_id,
        event_type,
        &summary,
        Some(payload),
        created_ms,
    );
    event.generated_image = generated_image;
    Some(event)
}

pub(in crate::app) fn user_message_text(item: &JsonValue) -> Option<String> {
    let content = item.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("text" | "input_text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .collect::<Vec<_>>()
        .join("\n\n");
    non_empty_string(Some(strip_ambient_browser_context(&text)))
}

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

pub(in crate::app) fn user_message_has_images(item: &JsonValue) -> bool {
    item.get("content")
        .and_then(JsonValue::as_array)
        .is_some_and(|content| {
            content.iter().any(|entry| {
                matches!(
                    entry.get("type").and_then(JsonValue::as_str),
                    Some("image" | "localImage")
                )
            })
        })
}

pub(in crate::app) fn response_content_text(content: Option<&JsonValue>) -> Option<String> {
    let content = content?.as_array()?;
    let text = content
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("output_text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .collect::<Vec<_>>()
        .join("\n\n");
    non_empty_string(Some(&text))
}

pub(in crate::app) fn reasoning_response_summary(summary: Option<&JsonValue>) -> Vec<String> {
    let Some(summary) = summary.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    summary
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("summary_text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

pub(in crate::app) fn reasoning_response_content(content: Option<&JsonValue>) -> Vec<String> {
    let Some(content) = content.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|entry| {
            entry.as_str().or_else(|| {
                entry
                    .get("text")
                    .and_then(JsonValue::as_str)
                    .or_else(|| entry.get("content").and_then(JsonValue::as_str))
            })
        })
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

pub(in crate::app) fn reasoning_event_summary(summary: &[String], content: &[String]) -> String {
    if summary.is_empty() && !content.is_empty() {
        "Reasoning".to_string()
    } else {
        "Reasoning summary".to_string()
    }
}

pub(in crate::app) fn string_array(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

pub(in crate::app) fn non_empty_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(in crate::app) fn command_execution_summary(item: &JsonValue) -> String {
    let status = item
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or("updated");
    format!("Command {status}")
}

pub(in crate::app) fn thread_id(thread: &JsonValue) -> Option<&str> {
    thread.get("id").and_then(JsonValue::as_str)
}

pub(in crate::app) fn thread_cwd(thread: &JsonValue) -> Option<&str> {
    thread.get("cwd").and_then(JsonValue::as_str)
}

pub(in crate::app) fn seconds_to_ms(value: Option<f64>) -> u64 {
    value.map(seconds_to_ms_value).unwrap_or(0)
}

pub(in crate::app) fn seconds_to_ms_value(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        (value * 1000.0) as u64
    } else {
        0
    }
}

pub(in crate::app) fn event_id_from_params(prefix: &str, params: &JsonValue) -> String {
    let turn_id = params
        .get("turnId")
        .or_else(|| params.pointer("/turn/id"))
        .and_then(JsonValue::as_str)
        .unwrap_or("turn");
    format!("{prefix}:{turn_id}")
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

    #[test]
    fn generated_images_normalize_without_exposing_raw_assets() {
        let event = task_event_from_thread_item(
            "thread_1",
            1,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "imageGeneration",
                    "id": "image_1",
                    "status": "completed",
                    "result": "iVBORw0KGgo=",
                    "revisedPrompt": "A clearer diagram",
                    "savedPath": "/tmp/generated_images/thread_1/image_1.png"
                }
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
        let raw = task_event_from_raw_response_item(
            "thread_1",
            1,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "image_generation_call",
                    "id": "image_1",
                    "status": "completed",
                    "result": "iVBORw0KGgo=",
                    "revised_prompt": "A clearer diagram"
                }
            }),
        )
        .expect("raw generated image event");
        let canonical = task_event_from_thread_item(
            "thread_1",
            2,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "imageGeneration",
                    "id": "image_1",
                    "status": "completed",
                    "result": "iVBORw0KGgo=",
                    "savedPath": "/tmp/generated_images/thread_1/image_1.png"
                }
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
}
