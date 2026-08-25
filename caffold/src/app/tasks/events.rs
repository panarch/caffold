use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::sync::broadcast;

use crate::agent::{
    ActivityStatus, ApprovalOutcome, ApprovalRequest, BackgroundTask, Conversation,
    ConversationItem, ItemKind, MessageContent, Turn, TurnOrigin, TurnStatus,
};

use super::generated_images::{GeneratedImageObservation, GeneratedImageStore};

/// Where one event sits in the backend-owned conversation projection.
///
/// The anchor groups events along the cross-turn timeline. The index orders
/// events that share that anchor. Neither value is an individual event time;
/// direct time evidence belongs to `observed_ms`.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskEventPosition {
    pub(in crate::app) anchor_ms: u64,
    pub(in crate::app) index: u32,
}

impl TaskEventPosition {
    pub(in crate::app) fn at(anchor_ms: u64) -> Self {
        Self {
            anchor_ms,
            index: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(in crate::app) struct TaskEventRecord {
    pub(in crate::app) id: String,
    pub(in crate::app) thread_id: String,
    #[serde(rename = "type")]
    pub(in crate::app) event_type: String,
    pub(in crate::app) summary: String,
    pub(in crate::app) payload: Option<JsonValue>,
    pub(in crate::app) position: TaskEventPosition,
    /// Direct time evidence for the first observation of this event.
    ///
    /// `None` means the provider supplied order but no per-item time. It is
    /// deliberately serialized as `null` so a current frontend can distinguish
    /// unknown time from a backend that only supplied conversation position.
    #[serde(default)]
    pub(in crate::app) observed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(in crate::app) updated_ms: Option<u64>,
    #[serde(skip)]
    pub(in crate::app) generated_image: Option<GeneratedImageObservation>,
}

/// One live observation retained behind the backend projection boundary.
///
/// Publication order and provider-session causality answer different
/// questions. The former sequences snapshots and deltas for a browser; the
/// latter lets history reconciliation say whether this observation existed
/// before a provider read began. Neither is item identity or conversation
/// position.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::app) struct TaskEventObservation {
    pub(in crate::app) event: TaskEventRecord,
    pub(in crate::app) publication_revision: u64,
    pub(in crate::app) session_revision: Option<u64>,
}

/// A Task-event delta and the revision captured when it entered the projection.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::app) struct TaskEventPublication {
    pub(in crate::app) revision: u64,
    pub(in crate::app) event: TaskEventRecord,
}

/// An atomic view of retained live evidence and its publication watermark.
#[derive(Debug, Clone, PartialEq)]
pub(in crate::app) struct TaskEventSnapshot {
    pub(in crate::app) revision: u64,
    pub(in crate::app) observations: Vec<TaskEventObservation>,
    pub(in crate::app) fully_observed_turns: HashSet<String>,
}

#[derive(Default)]
struct LiveTaskEventCacheState {
    events: HashMap<String, Vec<TaskEventObservation>>,
    /// Per-Task publication sequence. Entries survive cache eviction so a
    /// later empty snapshot or new event cannot move a connected browser
    /// backwards. Explicit Task removal clears the entry.
    revisions: HashMap<String, u64>,
    /// Turns whose live journal lost continuity after its boundary was seen.
    ///
    /// Their records remain useful observations, but no longer prove that the
    /// live journal is a complete replacement for provider history.
    invalidated_turns: HashMap<String, HashSet<String>>,
}

#[derive(Clone, Default)]
pub(in crate::app) struct LiveTaskEventCache {
    state: Arc<Mutex<LiveTaskEventCacheState>>,
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

    #[cfg(test)]
    pub(in crate::app) fn record(&self, event: TaskEventRecord) -> TaskEventRecord {
        self.record_observation(event, None).event
    }

    fn record_observation(
        &self,
        mut event: TaskEventRecord,
        session_revision: Option<u64>,
    ) -> TaskEventPublication {
        let Ok(mut state) = self.state.lock() else {
            return TaskEventPublication { revision: 0, event };
        };
        let thread_id = event.thread_id.clone();
        if !state.events.contains_key(&thread_id) && state.events.len() >= LIVE_TASK_THREAD_LIMIT {
            let oldest_thread = state
                .events
                .iter()
                .min_by_key(|(_, items)| {
                    items
                        .iter()
                        .map(|item| {
                            item.event
                                .updated_ms
                                .unwrap_or(item.event.position.anchor_ms)
                        })
                        .max()
                        .unwrap_or_default()
                })
                .map(|(thread_id, _)| thread_id.clone());
            if let Some(oldest_thread) = oldest_thread {
                state.events.remove(&oldest_thread);
                state.invalidated_turns.remove(&oldest_thread);
                advance_revision(&mut state.revisions, &oldest_thread);
            }
        }
        let publication_revision = advance_revision(&mut state.revisions, &thread_id);
        let thread_events = state.events.entry(thread_id).or_default();
        if let Some(existing) = thread_events
            .iter_mut()
            .find(|item| item.event.id == event.id)
        {
            existing.event = merge_task_event_record(existing.event.clone(), event);
            existing.publication_revision = publication_revision;
            existing.session_revision =
                max_optional_revision(existing.session_revision, session_revision);
            return TaskEventPublication {
                revision: publication_revision,
                event: existing.event.clone(),
            };
        }
        event.position.index = thread_events
            .iter()
            .filter(|existing| existing.event.position.anchor_ms == event.position.anchor_ms)
            .map(|existing| existing.event.position.index)
            .max()
            .map_or(0, |index| index.saturating_add(1));
        thread_events.push(TaskEventObservation {
            event: event.clone(),
            publication_revision,
            session_revision,
        });
        if thread_events.len() > LIVE_TASK_EVENT_LIMIT_PER_THREAD {
            thread_events.remove(0);
        }
        TaskEventPublication {
            revision: publication_revision,
            event,
        }
    }

    #[cfg(test)]
    pub(in crate::app) fn for_thread(&self, thread_id: &str) -> Vec<TaskEventRecord> {
        self.state
            .lock()
            .ok()
            .and_then(|state| state.events.get(thread_id).cloned())
            .unwrap_or_default()
            .into_iter()
            .map(|observation| observation.event)
            .collect()
    }

    fn snapshot_for_thread(&self, thread_id: &str) -> TaskEventSnapshot {
        let Ok(mut state) = self.state.lock() else {
            return TaskEventSnapshot {
                revision: 0,
                observations: Vec::new(),
                fully_observed_turns: HashSet::new(),
            };
        };
        let revision = advance_revision(&mut state.revisions, thread_id);
        let observations = state.events.get(thread_id).cloned().unwrap_or_default();
        let fully_observed_turns = fully_observed_turns(&state, thread_id);
        TaskEventSnapshot {
            revision,
            observations,
            fully_observed_turns,
        }
    }

    /// Turns whose live item journal is known to start at the real turn
    /// boundary and has remained continuous since.
    #[cfg(test)]
    pub(in crate::app) fn fully_observed_turns(&self, thread_id: &str) -> HashSet<String> {
        let Ok(state) = self.state.lock() else {
            return HashSet::new();
        };
        fully_observed_turns(&state, thread_id)
    }

    /// Keep the observations, but withdraw the claim that this thread's live
    /// journal is complete. A reconnect can recover provider history; it cannot
    /// recover reports that may have fallen between two live connections.
    pub(in crate::app) fn invalidate_continuity(&self, thread_id: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let turn_ids = state
            .events
            .get(thread_id)
            .into_iter()
            .flatten()
            .filter(|event| event.event.event_type == "turn_started")
            .filter_map(|event| task_event_turn_id(&event.event))
            .map(str::to_string)
            .collect::<Vec<_>>();
        state
            .invalidated_turns
            .entry(thread_id.to_string())
            .or_default()
            .extend(turn_ids);
        advance_revision(&mut state.revisions, thread_id);
    }

    /// The receiver cannot identify which conversation its missed reports
    /// belonged to, so every live-ledger claim is withdrawn conservatively.
    pub(in crate::app) fn invalidate_all_continuity(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let turn_ids = state
            .events
            .iter()
            .flat_map(|(thread_id, events)| {
                events
                    .iter()
                    .filter(|event| event.event.event_type == "turn_started")
                    .filter_map(|event| task_event_turn_id(&event.event))
                    .map(|turn_id| (thread_id.clone(), turn_id.to_string()))
            })
            .collect::<Vec<_>>();
        for (thread_id, turn_id) in turn_ids {
            let inserted = state
                .invalidated_turns
                .entry(thread_id.clone())
                .or_default()
                .insert(turn_id);
            if inserted {
                advance_revision(&mut state.revisions, &thread_id);
            }
        }
    }

    pub(in crate::app) fn remove_thread(&self, thread_id: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.events.remove(thread_id);
            state.invalidated_turns.remove(thread_id);
            state.revisions.remove(thread_id);
        }
    }
}

fn advance_revision(revisions: &mut HashMap<String, u64>, thread_id: &str) -> u64 {
    let revision = revisions.entry(thread_id.to_string()).or_default();
    *revision = revision.saturating_add(1);
    *revision
}

fn max_optional_revision(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (Some(revision), None) | (None, Some(revision)) => Some(revision),
        (None, None) => None,
    }
}

fn fully_observed_turns(state: &LiveTaskEventCacheState, thread_id: &str) -> HashSet<String> {
    let invalidated = state.invalidated_turns.get(thread_id);
    state
        .events
        .get(thread_id)
        .into_iter()
        .flatten()
        .filter(|event| event.event.event_type == "turn_started")
        .filter_map(|event| task_event_turn_id(&event.event))
        .filter(|turn_id| invalidated.is_none_or(|turns| !turns.contains(*turn_id)))
        .map(str::to_string)
        .collect()
}

#[derive(Clone)]
pub(in crate::app) struct TaskEvents {
    sender: broadcast::Sender<TaskEventPublication>,
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
    pub(in crate::app) fn subscribe(&self) -> broadcast::Receiver<TaskEventPublication> {
        self.sender.subscribe()
    }

    pub(in crate::app) fn publish(&self, event: TaskEventRecord) -> TaskEventPublication {
        let event = self.record(event);
        self.broadcast(event.clone());
        event
    }

    pub(in crate::app) fn publish_from_session(
        &self,
        event: TaskEventRecord,
        session_revision: u64,
    ) -> TaskEventPublication {
        let event = self.record_from_session(event, session_revision);
        self.broadcast(event.clone());
        event
    }

    pub(in crate::app) fn record(&self, event: TaskEventRecord) -> TaskEventPublication {
        self.record_inner(event, None)
    }

    fn record_from_session(
        &self,
        event: TaskEventRecord,
        session_revision: u64,
    ) -> TaskEventPublication {
        self.record_inner(event, Some(session_revision))
    }

    fn record_inner(
        &self,
        mut event: TaskEventRecord,
        session_revision: Option<u64>,
    ) -> TaskEventPublication {
        self.generated_images.observe(&event);
        event.generated_image = None;
        self.cache.record_observation(event, session_revision)
    }

    pub(in crate::app) fn broadcast(&self, event: TaskEventPublication) {
        let _ = self.sender.send(event);
    }

    /// Preserve history-backed assets without turning provider history into a
    /// second copy of the live journal.
    pub(in crate::app) fn observe_history_assets(&self, events: &[TaskEventRecord]) {
        for event in events {
            self.generated_images.observe(event);
        }
    }

    #[cfg(test)]
    pub(in crate::app) fn for_thread(&self, thread_id: &str) -> Vec<TaskEventRecord> {
        self.cache.for_thread(thread_id)
    }

    pub(in crate::app) fn snapshot_for_thread(&self, thread_id: &str) -> TaskEventSnapshot {
        self.cache.snapshot_for_thread(thread_id)
    }

    #[cfg(test)]
    pub(in crate::app) fn fully_observed_turns(&self, thread_id: &str) -> HashSet<String> {
        self.cache.fully_observed_turns(thread_id)
    }

    pub(in crate::app) fn invalidate_continuity(&self, thread_id: &str) {
        self.cache.invalidate_continuity(thread_id);
    }

    pub(in crate::app) fn invalidate_all_continuity(&self) {
        self.cache.invalidate_all_continuity();
    }

    pub(in crate::app) fn generated_images(&self) -> &GeneratedImageStore {
        &self.generated_images
    }

    pub(in crate::app) fn remove_thread(&self, thread_id: &str) {
        self.cache.remove_thread(thread_id);
        self.generated_images.remove_thread(thread_id);
    }
}

/// Merge a position-owning event projection with supplemental observations.
///
/// An exact identity in both collections keeps the first collection's
/// conversation position. The supplemental record may still contribute its
/// newer payload and update time. An identity found only in the supplemental
/// collection remains visible at its observed position.
pub(in crate::app) fn merge_task_event_records(
    positioned: Vec<TaskEventRecord>,
    supplemental: Vec<TaskEventRecord>,
) -> Vec<TaskEventRecord> {
    let mut events = Vec::<TaskEventRecord>::new();
    let mut index_by_id = HashMap::<String, usize>::new();
    for event in positioned.into_iter().chain(supplemental) {
        if let Some(index) = index_by_id.get(&event.id).copied() {
            events[index] = merge_task_event_record(events[index].clone(), event);
        } else {
            index_by_id.insert(event.id.clone(), events.len());
            events.push(event);
        }
    }
    events
}

/// Join a provider-history snapshot with the live reports Caffold observed.
///
/// A live `turn_started` plus uninterrupted observation proves Caffold watched
/// that turn from its boundary. That live stream therefore owns the whole item
/// set for the turn: mixing in a second provider projection whose item ids are
/// local to a history read would draw the same work twice and would replace
/// direct event times with a turn-level fallback. A turn Caffold joined after
/// it began, or whose live connection lost continuity, has no such proof, so
/// history remains the baseline and only exact identities reconcile. No
/// content, proximity, or arrival-order matching is involved.
pub(in crate::app) fn merge_provider_history_with_live_events(
    history: Vec<TaskEventRecord>,
    live: Vec<TaskEventRecord>,
    fully_observed_turns: &HashSet<String>,
) -> Vec<TaskEventRecord> {
    let history = history
        .into_iter()
        .filter(|event| {
            task_event_turn_id(event).is_none_or(|turn_id| !fully_observed_turns.contains(turn_id))
        })
        .collect();
    merge_task_event_records(history, live)
}

pub(in crate::app) fn merge_task_event_record(
    existing: TaskEventRecord,
    incoming: TaskEventRecord,
) -> TaskEventRecord {
    let position = existing.position;
    let observed_ms = match (existing.observed_ms, incoming.observed_ms) {
        (Some(existing), Some(incoming)) => Some(existing.min(incoming)),
        (Some(observed), None) | (None, Some(observed)) => Some(observed),
        (None, None) => None,
    };
    let existing_updated_ms = existing.updated_ms.unwrap_or(existing.position.anchor_ms);
    let incoming_updated_ms = incoming.updated_ms.unwrap_or(incoming.position.anchor_ms);
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
    latest.position = position;
    latest.observed_ms = observed_ms;
    latest.generated_image = latest.generated_image.or(earlier.generated_image);
    let updated_ms = existing_updated_ms.max(incoming_updated_ms);
    latest.updated_ms = (updated_ms > position.anchor_ms).then_some(updated_ms);
    latest
}

pub(in crate::app) fn sort_task_events(events: &mut [TaskEventRecord]) {
    events.sort_by(|left, right| {
        left.position
            .anchor_ms
            .cmp(&right.position.anchor_ms)
            .then_with(|| left.position.index.cmp(&right.position.index))
    });
}

/// Every event a conversation's own history implies.
///
/// This is the provider-history read: what the agent says happened, rendered
/// as the records the interface shows. Live events carry the same identities,
/// so a turn watched as it ran and the same turn read back later are one
/// timeline rather than two.
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
        let inferred_ms = if turn_index + 1 == turns.len() {
            conversation_activity_ms.max(minimum_turn_ms)
        } else {
            minimum_turn_ms
        };
        // A turn timestamp is direct agent evidence and may legitimately be
        // older than the moment an adapter attached to the conversation. The
        // conversation-level clock is only a fallback when the turn has no
        // timestamp of its own.
        let timeline_ms = turn
            .started_at_ms
            .or(turn.completed_at_ms)
            .unwrap_or(inferred_ms);
        if turn.started_at_ms.is_some() {
            events.push(turn_started_event(thread_id, turn, timeline_ms));
        }
        for item in &turn.items {
            if let Some(mut event) = task_event_from_item(thread_id, turn_id, timeline_ms, item) {
                // Provider order owns placement. An item-level provider clock,
                // when present, is separate display evidence; without one the
                // turn anchor must not be presented as every item's time.
                event.observed_ms = item.observed_at_ms;
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
    assign_anchor_indexes_in_current_order(&mut events);
    events
}

fn assign_anchor_indexes_in_current_order(events: &mut [TaskEventRecord]) {
    let mut next_index_by_anchor = HashMap::<u64, u32>::new();
    for event in events {
        let next_index = next_index_by_anchor
            .entry(event.position.anchor_ms)
            .or_default();
        event.position.index = *next_index;
        *next_index = next_index.saturating_add(1);
    }
}

/// A turn beginning, from history or from the agent saying so live.
///
/// Both paths build the same identity and the same payload, so the two records
/// are one record however the turn was observed.
pub(in crate::app) fn turn_started_event(
    thread_id: &str,
    turn: &Turn,
    started_ms: u64,
) -> TaskEventRecord {
    let turn_id = turn.id.as_str();
    let mut event = task_event_record(
        thread_id,
        &format!("{turn_id}:started"),
        "turn_started",
        "Turn started",
        Some(json!({
            "threadId": thread_id,
            "turnId": turn_id,
            "origin": turn_origin_payload(&turn.origin),
        })),
        started_ms,
    );
    // A turn's own start opens the group the turn's items sort into.
    event.position.index = 0;
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
            "origin": turn_origin_payload(&turn.origin),
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
    anchor_ms: u64,
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
        ItemKind::CommandExecution(command) => {
            let mut payload = json!({
                "command": command.command,
                "cwd": command.cwd,
                "output": command.output,
                "exitCode": command.exit_code,
                "durationMs": command.duration_ms,
            });
            if let Some(background_task) = command.background_task.as_ref()
                && let Some(payload) = payload.as_object_mut()
            {
                payload.insert(
                    "backgroundTask".to_string(),
                    background_task_payload(background_task),
                );
            }
            (
                "command_execution",
                format!("Command {}", activity_word(item.status)),
                payload,
                None,
            )
        }
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
        anchor_ms,
    );
    event.generated_image = generated_image;
    Some(event)
}

/// Turn provenance as internal event metadata.
///
/// The raw agent prompt deliberately stops at the agent model boundary. It is
/// retained there so an unsupported field does not destroy evidence, but an
/// event consumed by the interface carries only what is already understood.
fn turn_origin_payload(origin: &TurnOrigin) -> JsonValue {
    match origin {
        TurnOrigin::User => json!({ "type": "user" }),
        TurnOrigin::BackgroundTask(task) => merged_payload(
            json!({ "type": "backgroundTask" }),
            background_task_payload(task),
        ),
        TurnOrigin::Unknown => json!({ "type": "unknown" }),
    }
}

fn background_task_payload(task: &BackgroundTask) -> JsonValue {
    let mut payload = serde_json::Map::new();
    for (name, value) in [
        ("taskId", &task.task_id),
        ("toolUseId", &task.tool_use_id),
        ("status", &task.status),
        ("outputFile", &task.output_file),
        ("summary", &task.summary),
    ] {
        if let Some(value) = value {
            payload.insert(name.to_string(), JsonValue::String(value.clone()));
        }
    }
    JsonValue::Object(payload)
}

/// An approval the agent is waiting on, as the interface asks it.
///
/// The driver has already written this for a person to read, so the payload is
/// the request itself: what is being asked, the specifics worth checking, and
/// the answers this request accepts.
pub(in crate::app) fn approval_requested_event(
    thread_id: &str,
    request: &ApprovalRequest,
    anchor_ms: u64,
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
        anchor_ms,
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

/// A prompt an agent adapter has accepted, under the identity it reports.
///
/// Live updates and history use this same item identity, so either may arrive
/// before this event and exact identity merging still produces one message.
/// Its provisional position is when Caffold observed the submission; waiting
/// for the adapter to return its identity must not move it behind the answer.
pub(in crate::app) fn accepted_user_message_event(
    thread_id: &str,
    turn_id: &str,
    item: &ConversationItem,
    observed_ms: u64,
) -> TaskEventRecord {
    task_event_from_item(thread_id, turn_id, observed_ms, item)
        .expect("an accepted prompt is a displayable user message")
}

/// A first turn that could not begin, said in the Task it was meant for.
///
/// Creating a Task answers as soon as the Task exists, so a first turn that
/// the agent never took has nobody left to fail to. The conversation is where
/// the prompt already is, and this is what stands beside it in place of the
/// answer that never came.
pub(in crate::app) fn first_turn_failed_event(thread_id: &str, reason: &str) -> TaskEventRecord {
    task_event_record(
        thread_id,
        &format!("first-turn-failed:{}", uuid::Uuid::new_v4()),
        "task_failed",
        &format!("The first turn could not be started: {reason}"),
        Some(json!({ "threadId": thread_id })),
        now_ms(),
    )
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
    anchor_ms: u64,
) -> TaskEventRecord {
    TaskEventRecord {
        id: format!("{thread_id}:{event_id}"),
        thread_id: thread_id.to_string(),
        event_type: event_type.to_string(),
        summary: summary.to_string(),
        payload,
        position: TaskEventPosition::at(anchor_ms),
        observed_ms: Some(anchor_ms),
        updated_ms: None,
        generated_image: None,
    }
}

fn task_event_turn_id(event: &TaskEventRecord) -> Option<&str> {
    event
        .payload
        .as_ref()
        .and_then(|payload| payload.get("turnId"))
        .and_then(JsonValue::as_str)
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
    use crate::agent::{CommandExecution, ThreadStatus};

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
        anchor_ms: u64,
        reported: ActivityStatus,
        item: JsonValue,
    ) -> Option<TaskEventRecord> {
        let item = codex_item(reported, item)?;
        task_event_from_item("thread_1", turn_id, anchor_ms, &item)
    }

    fn codex_item(reported: ActivityStatus, item: JsonValue) -> Option<ConversationItem> {
        crate::agent::codex::conversation_item(&item, reported)
    }

    #[test]
    fn task_event_wire_contract_separates_position_from_observed_time() {
        let mut event = task_event_record(
            "thread_1",
            "item_1",
            "assistant_message",
            "Assistant message",
            None,
            100,
        );
        event.position.index = 3;
        event.observed_ms = None;

        let value = serde_json::to_value(event).expect("serialize task event");

        assert_eq!(value["position"]["anchorMs"], 100);
        assert_eq!(value["position"]["index"], 3);
        assert!(value["observedMs"].is_null());
        assert!(value.get("createdMs").is_none());
        assert!(value.get("sortIndex").is_none());
    }

    /// One item from Codex's raw model-output stream, which reports work that
    /// has already happened.
    fn codex_response_event(
        turn_id: &str,
        anchor_ms: u64,
        item: JsonValue,
    ) -> Option<TaskEventRecord> {
        let item = crate::agent::codex::response_item(&item)?;
        task_event_from_item("thread_1", turn_id, anchor_ms, &item)
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
            merge_task_event_records(vec![canonical], vec![raw]).len(),
            1
        );
    }

    #[test]
    fn codex_client_identity_survives_task_event_projection_and_merge() {
        let prompt = |provider_id: &str, client_id: &str, created_ms| {
            codex_item_event(
                "turn_1",
                created_ms,
                ActivityStatus::Completed,
                json!({
                    "type": "userMessage",
                    "id": provider_id,
                    "clientId": client_id,
                    "content": [{ "type": "text", "text": "Same words" }],
                }),
            )
            .expect("a Codex user message event")
        };
        let live = prompt("01a03716-fcdb-7170-858b-f22699bc5a4f", "message_1", 10);
        let history = prompt("item-256", "message_1", 11);
        let separate = prompt("item-257", "message_2", 12);

        assert_eq!(live.id, history.id);
        assert_ne!(live.id, separate.id);
        let cache = LiveTaskEventCache::default();
        cache.record(live.clone());
        cache.record(history.clone());
        cache.record(separate.clone());
        assert_eq!(cache.for_thread("thread_1").len(), 2);

        let merged = merge_task_event_records(vec![history], vec![live, separate]);
        assert_eq!(merged.len(), 2);
        assert_eq!(
            merged
                .iter()
                .find(|event| event.id.ends_with(":message_1"))
                .expect("merged client item")
                .position
                .anchor_ms,
            11,
            "provider history owns the position even when the live projection used another ID"
        );
    }

    #[test]
    fn agent_history_position_survives_a_late_live_projection_of_the_same_item() {
        let mut history_prompt = task_event_record(
            "thread_1",
            "turn_1:message_1",
            "user_message",
            "User prompt",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "message_1",
                "text": "Test the ordering",
                "content": [{ "type": "text", "text": "Test the ordering" }]
            })),
            100,
        );
        history_prompt.position.index = 1;
        let mut history_answer = task_event_record(
            "thread_1",
            "turn_1:answer_1",
            "assistant_message",
            "Assistant message",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "answer_1",
                "text": "The answer"
            })),
            100,
        );
        history_answer.position.index = 2;
        let mut late_live_prompt = task_event_record(
            "thread_1",
            "turn_1:message_1",
            "user_message",
            "User prompt accepted",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "message_1",
                "text": "Test the ordering",
                "liveDelivery": "accepted"
            })),
            200,
        );
        late_live_prompt.position.index = 0;

        let mut merged =
            merge_task_event_records(vec![history_prompt, history_answer], vec![late_live_prompt]);
        sort_task_events(&mut merged);

        assert_eq!(
            merged
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            vec!["user_message", "assistant_message"],
            "a late observation cannot move a prompt behind its answer"
        );
        let prompt = &merged[0];
        assert_eq!(prompt.position.anchor_ms, 100);
        assert_eq!(prompt.position.index, 1);
        assert_eq!(prompt.updated_ms, Some(200));
        assert_eq!(prompt.payload.as_ref().unwrap()["liveDelivery"], "accepted");
        assert!(
            prompt.payload.as_ref().unwrap()["content"].is_array(),
            "the live projection enriches history without replacing its position or structure"
        );
    }

    #[test]
    fn a_fully_observed_turn_uses_one_live_item_ledger() {
        let turn_id = "turn_1";
        let history = [
            ("turn_1:started", "turn_started", 100, None),
            ("turn_1:item-2", "assistant_message", 100, Some("Working")),
            ("turn_1:exec-1", "tool_call", 100, None),
            ("turn_1:item-3", "tool_call", 100, None),
        ]
        .into_iter()
        .map(|(id, event_type, created_ms, text)| {
            let mut event = task_event_record(
                "thread_1",
                id,
                event_type,
                event_type,
                Some(json!({
                    "threadId": "thread_1",
                    "turnId": turn_id,
                    "itemId": id.rsplit(':').next().unwrap(),
                    "text": text,
                })),
                created_ms,
            );
            event.observed_ms = None;
            event
        })
        .collect::<Vec<_>>();
        let live = [
            ("turn_1:started", "turn_started", 100, None),
            (
                "turn_1:msg_response_1",
                "assistant_message",
                110,
                Some("Working"),
            ),
            ("turn_1:exec-1", "tool_call", 120, None),
            ("turn_1:context-live-1", "tool_call", 130, None),
        ]
        .into_iter()
        .map(|(id, event_type, created_ms, text)| {
            task_event_record(
                "thread_1",
                id,
                event_type,
                event_type,
                Some(json!({
                    "threadId": "thread_1",
                    "turnId": turn_id,
                    "itemId": id.rsplit(':').next().unwrap(),
                    "text": text,
                })),
                created_ms,
            )
        })
        .collect::<Vec<_>>();

        let mut merged = merge_provider_history_with_live_events(
            history,
            live,
            &HashSet::from([turn_id.to_string()]),
        );
        sort_task_events(&mut merged);

        assert_eq!(
            merged
                .iter()
                .map(|event| event.id.as_str())
                .collect::<Vec<_>>(),
            vec![
                "thread_1:turn_1:started",
                "thread_1:turn_1:msg_response_1",
                "thread_1:turn_1:exec-1",
                "thread_1:turn_1:context-live-1",
            ],
            "history-local item ids cannot create a second copy of a turn Caffold watched from its start"
        );
        assert_eq!(
            merged
                .iter()
                .map(|event| (event.position.anchor_ms, event.observed_ms))
                .collect::<Vec<_>>(),
            vec![
                (100, Some(100)),
                (110, Some(110)),
                (120, Some(120)),
                (130, Some(130)),
            ],
            "direct live times must not collapse onto the history turn anchor"
        );
    }

    #[test]
    fn a_partially_observed_turn_does_not_guess_across_distinct_item_ids() {
        let history = task_event_record(
            "thread_1",
            "turn_1:item-2",
            "assistant_message",
            "Assistant response",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item-2",
                "text": "Same presentation",
            })),
            100,
        );
        let live = task_event_record(
            "thread_1",
            "turn_1:msg_response_1",
            "assistant_message",
            "Assistant response",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "msg_response_1",
                "text": "Same presentation",
            })),
            110,
        );

        let merged =
            merge_provider_history_with_live_events(vec![history], vec![live], &HashSet::new());

        assert_eq!(
            merged.len(),
            2,
            "without a live turn boundary or exact identity, Caffold cannot claim two provider records are one"
        );
    }

    #[test]
    fn a_connection_gap_withdraws_live_ledger_ownership_without_erasing_evidence() {
        let cache = LiveTaskEventCache::default();
        let turn_started = task_event_record(
            "thread_1",
            "turn_1:started",
            "turn_started",
            "Turn started",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
            })),
            100,
        );
        let live_item = task_event_record(
            "thread_1",
            "turn_1:live-item",
            "assistant_message",
            "Assistant response",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "live-item",
                "text": "Visible live evidence",
            })),
            110,
        );
        cache.observe(&[turn_started, live_item]);
        assert_eq!(
            cache.fully_observed_turns("thread_1"),
            HashSet::from(["turn_1".to_string()])
        );

        cache.invalidate_continuity("thread_1");

        assert!(cache.fully_observed_turns("thread_1").is_empty());
        assert_eq!(
            cache.for_thread("thread_1").len(),
            2,
            "a transport gap invalidates completeness, not the reports already observed"
        );
        let history_item = task_event_record(
            "thread_1",
            "turn_1:history-item",
            "assistant_message",
            "Assistant response",
            Some(json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "history-item",
                "text": "Provider history evidence",
            })),
            100,
        );
        let merged = merge_provider_history_with_live_events(
            vec![history_item],
            cache.for_thread("thread_1"),
            &cache.fully_observed_turns("thread_1"),
        );
        assert_eq!(
            merged.len(),
            3,
            "after an observation gap, history returns and distinct provider identities remain distinct"
        );
    }

    #[test]
    fn provider_history_order_does_not_claim_per_item_time() {
        let history = conversation(json!({
            "id": "thread_1",
            "preview": "History",
            "status": { "type": "idle" },
            "cwd": "/tmp",
            "createdAt": 1.0,
            "updatedAt": 3.0,
            "turns": [{
                "id": "turn_1",
                "status": "completed",
                "startedAt": 1.0,
                "completedAt": 3.0,
                "items": [{
                    "type": "agentMessage",
                    "id": "item-1",
                    "text": "Only its order is known"
                }]
            }]
        }));

        let item = thread_events(&history)
            .into_iter()
            .find(|event| event.event_type == "assistant_message")
            .expect("history projects the message");

        assert_eq!(
            item.position.anchor_ms, 1_000,
            "the turn anchor still places it"
        );
        assert_eq!(
            item.observed_ms, None,
            "a turn anchor is not an individual message timestamp"
        );
        assert!(
            serde_json::to_value(item).unwrap()["observedMs"].is_null(),
            "the API must distinguish unknown item time from an older response that omitted the field"
        );
    }

    #[test]
    fn provider_item_time_is_display_evidence_without_replacing_turn_order() {
        let mut history = conversation(json!({
            "id": "thread_1",
            "preview": "History",
            "status": { "type": "idle" },
            "cwd": "/tmp",
            "createdAt": 1.0,
            "updatedAt": 3.0,
            "turns": [{
                "id": "turn_1",
                "status": "completed",
                "startedAt": 1.0,
                "completedAt": 3.0,
                "items": [{
                    "type": "agentMessage",
                    "id": "item-1",
                    "text": "Its provider recorded a direct time"
                }]
            }]
        }));
        history.turns[0].items[0].observed_at_ms = Some(2_000);

        let item = thread_events(&history)
            .into_iter()
            .find(|event| event.event_type == "assistant_message")
            .expect("history projects the message");

        assert_eq!(
            item.position.anchor_ms, 1_000,
            "turn order still owns placement"
        );
        assert_eq!(item.position.index, 1);
        assert_eq!(item.observed_ms, Some(2_000));
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
        assert_eq!(merged.position.anchor_ms, 10);
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
        assert!(
            command
                .payload
                .as_ref()
                .unwrap()
                .get("backgroundTask")
                .is_none(),
            "absence is not projected as a background fact"
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
    fn background_task_evidence_reaches_internal_events_without_its_raw_prompt() {
        let evidence = BackgroundTask {
            task_id: Some("task-1".to_string()),
            tool_use_id: Some("toolu_1".to_string()),
            status: Some("completed".to_string()),
            output_file: Some("/tmp/task-1.output".to_string()),
            summary: Some("Background command completed".to_string()),
            raw: Some("UNIQUE_RAW_TASK_NOTIFICATION".to_string()),
        };
        let conversation = Conversation {
            id: "thread_1".to_string(),
            title: None,
            preview: String::new(),
            status: ThreadStatus::Idle,
            cwd: "/tmp".to_string(),
            transcript_path: None,
            created_at_ms: 1,
            updated_at_ms: 3,
            recency_at_ms: Some(3),
            turns: vec![Turn {
                id: "turn_1".to_string(),
                origin: TurnOrigin::BackgroundTask(evidence.clone()),
                status: TurnStatus::Completed,
                started_at_ms: Some(2),
                completed_at_ms: Some(3),
                items: vec![ConversationItem {
                    id: "toolu_1".to_string(),
                    observed_at_ms: None,
                    status: ActivityStatus::Completed,
                    kind: ItemKind::CommandExecution(CommandExecution {
                        command: Some("sleep 1".to_string()),
                        cwd: None,
                        output: Some("done".to_string()),
                        exit_code: None,
                        duration_ms: None,
                        background_task: Some(evidence),
                    }),
                }],
            }],
        };

        let events = thread_events(&conversation);
        let started = events
            .iter()
            .find(|event| event.event_type == "turn_started")
            .expect("turn start");
        let completed = events
            .iter()
            .find(|event| event.event_type == "turn_completed")
            .expect("turn completion");
        let command = events
            .iter()
            .find(|event| event.event_type == "command_execution")
            .expect("command");

        for event in [started, completed] {
            let origin = &event.payload.as_ref().expect("turn payload")["origin"];
            assert_eq!(origin["type"], "backgroundTask");
            assert_eq!(origin["taskId"], "task-1");
            assert_eq!(origin["toolUseId"], "toolu_1");
        }
        let background = &command.payload.as_ref().expect("command payload")["backgroundTask"];
        assert_eq!(background["taskId"], "task-1");
        assert_eq!(background["status"], "completed");
        assert_eq!(background["outputFile"], "/tmp/task-1.output");

        let serialized = serde_json::to_string(&events).expect("serialize events");
        assert!(
            !serialized.contains("UNIQUE_RAW_TASK_NOTIFICATION"),
            "the machine prompt stays in the agent model, not the UI event stream"
        );
    }

    #[test]
    fn an_unknown_turn_origin_is_not_rewritten_as_a_user_turn() {
        assert_eq!(turn_origin_payload(&TurnOrigin::Unknown)["type"], "unknown");
        assert_eq!(turn_origin_payload(&TurnOrigin::User)["type"], "user");

        let partial = turn_origin_payload(&TurnOrigin::BackgroundTask(BackgroundTask {
            task_id: Some("task-1".to_string()),
            ..BackgroundTask::default()
        }));
        assert_eq!(partial["taskId"], "task-1");
        assert!(
            partial.get("status").is_none(),
            "missing evidence stays absent"
        );
    }

    #[test]
    fn missing_turn_start_does_not_move_a_newer_turn_to_thread_creation() {
        let thread = json!({
            "status": { "type": "idle" },
            "id": "thread_1",
            "cwd": "/tmp",
            "createdAt": 100.0,
            "updatedAt": 100.0,
            "recencyAt": 100.0,
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
                    event.position.anchor_ms,
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
    fn separately_projected_pages_keep_explicit_turn_times_before_attachment() {
        let page = |turn: JsonValue| {
            conversation(json!({
                "status": { "type": "idle" },
                "id": "thread_1",
                "cwd": "/tmp",
                // A resumed adapter may know only when it attached. That
                // weaker conversation-level time must not replace timestamps
                // read directly from the agent's transcript.
                "createdAt": 100.0,
                "updatedAt": 100.0,
                "turns": [turn]
            }))
        };
        let older = page(json!({
            "id": "turn_old",
            "status": "completed",
            "startedAt": 10.0,
            "completedAt": 11.0,
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
        }));
        let newer = page(json!({
            "id": "turn_new",
            "status": "completed",
            "startedAt": 20.0,
            "completedAt": 21.0,
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
        }));

        // Detail pages are projected independently and merged by the client.
        // This reproduces a resumed Claude history spanning two cursors.
        let mut events = merge_task_event_records(thread_events(&older), thread_events(&newer));
        sort_task_events(&mut events);
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
                    event.payload.as_ref().unwrap()["text"]
                        .as_str()
                        .unwrap()
                        .to_string(),
                    event.position.anchor_ms,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            visible_messages,
            vec![
                ("Old prompt".to_string(), 10_000),
                ("Old answer".to_string(), 10_000),
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
                    event.position.index,
                )
            })
            .collect::<Vec<_>>();

        assert_eq!(
            item_events,
            vec![
                ("item-z".to_string(), 1),
                ("item-a".to_string(), 2),
                ("item-m".to_string(), 3),
            ]
        );
    }

    #[test]
    fn provider_turn_boundaries_are_explicit_when_all_timestamps_match() {
        let mut events = thread_events(&conversation(json!({
            "status": { "type": "idle" },
            "id": "thread_1",
            "cwd": "/tmp",
            "createdAt": 1.0,
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "startedAt": 2.0,
                    "completedAt": 2.0,
                    "items": [{
                        "id": "item-1",
                        "type": "userMessage",
                        "content": [{ "type": "text", "text": "First prompt" }]
                    }]
                },
                {
                    "id": "turn_2",
                    "status": "completed",
                    "startedAt": 2.0,
                    "completedAt": 2.0,
                    "items": [{
                        "id": "item-2",
                        "type": "userMessage",
                        "content": [{ "type": "text", "text": "Second prompt" }]
                    }]
                }
            ]
        })));
        sort_task_events(&mut events);

        assert_eq!(
            events
                .into_iter()
                .map(|event| {
                    (
                        event.payload.unwrap()["turnId"]
                            .as_str()
                            .unwrap()
                            .to_string(),
                        event.event_type,
                        event.position.index,
                    )
                })
                .collect::<Vec<_>>(),
            vec![
                ("turn_1".to_string(), "turn_started".to_string(), 0),
                ("turn_1".to_string(), "user_message".to_string(), 1),
                ("turn_1".to_string(), "turn_completed".to_string(), 2),
                ("turn_2".to_string(), "turn_started".to_string(), 3),
                ("turn_2".to_string(), "user_message".to_string(), 4),
                ("turn_2".to_string(), "turn_completed".to_string(), 5),
            ]
        );
    }

    #[test]
    fn equal_positions_preserve_projection_order_instead_of_inferring_from_event_ids() {
        let first = task_event_record(
            "thread_1",
            "z-event",
            "assistant_message",
            "Observed first",
            None,
            100,
        );
        let second = task_event_record(
            "thread_1",
            "a-event",
            "assistant_message",
            "Observed second",
            None,
            100,
        );
        let mut events = merge_task_event_records(vec![first], vec![second]);

        sort_task_events(&mut events);

        assert_eq!(
            events
                .into_iter()
                .map(|event| (event.id, event.position.index))
                .collect::<Vec<_>>(),
            vec![
                ("thread_1:z-event".to_string(), 0),
                ("thread_1:a-event".to_string(), 0),
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
            merged[0].position.anchor_ms, started.position.anchor_ms,
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
        positioned_command.position.index = 0;

        assert_eq!(merged, vec![positioned_command]);
    }

    #[test]
    fn canonical_user_message_replaces_the_locally_accepted_prompt() {
        let cache = LiveTaskEventCache::default();
        let image = "data:image/png;base64,aGVsbG8=".to_string();
        let accepted = codex_item(
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "accepted_projection",
                "clientId": "message_1",
                "content": [
                    { "type": "text", "text": "Inspect this image" },
                    { "type": "image", "url": image }
                ]
            }),
        )
        .expect("accepted user message");
        cache.record(accepted_user_message_event(
            "thread_1", "turn_1", &accepted, 10,
        ));
        let canonical = codex_item_event(
            "turn_1",
            20,
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "item_prompt",
                "clientId": "message_1",
                "content": [
                    { "type": "text", "text": "Inspect this image" },
                    { "type": "image", "url": image }
                ]
            }),
        )
        .expect("canonical user message");

        let canonical = cache.record(canonical);

        let merged = cache.for_thread("thread_1");
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, canonical.id);
        assert_eq!(merged[0].position.anchor_ms, canonical.position.anchor_ms);
        assert_eq!(merged[0].payload.as_ref().unwrap()["itemId"], "message_1");
    }

    #[test]
    fn a_first_turn_failure_stands_in_the_conversation_beside_its_prompt() {
        let cache = LiveTaskEventCache::default();
        let accepted = codex_item(
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "accepted_projection",
                "clientId": "message_1",
                "content": [{ "type": "text", "text": "Read the planner" }]
            }),
        )
        .expect("accepted user message");
        let prompt = cache.record(accepted_user_message_event(
            "thread_1", "turn_1", &accepted, 10,
        ));
        let failure = cache.record(first_turn_failed_event(
            "thread_1",
            "the agent could not be reached",
        ));

        assert_eq!(failure.event_type, "task_failed");
        assert_eq!(
            failure.summary,
            "The first turn could not be started: the agent could not be reached"
        );
        assert!(failure.id.starts_with("thread_1:"));
        // No turn names it, so it reads with the prompt it was for rather than
        // opening a turn of its own.
        assert!(
            failure
                .payload
                .as_ref()
                .and_then(|payload| payload.get("turnId"))
                .is_none()
        );
        assert_eq!(cache.for_thread("thread_1"), vec![prompt, failure]);
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
                "clientId": "message_1",
                "content": [{ "type": "text", "text": "Already canonical" }]
            }),
        )
        .expect("canonical user message");
        let canonical = cache.record(canonical);

        let accepted = codex_item(
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "accepted_projection",
                "clientId": "message_1",
                "content": [{ "type": "text", "text": "Already canonical" }]
            }),
        )
        .expect("accepted user message");
        cache.record(accepted_user_message_event(
            "thread_1", "turn_1", &accepted, 30,
        ));

        let merged = cache.for_thread("thread_1");
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].id, canonical.id);
        assert_eq!(merged[0].position.anchor_ms, canonical.position.anchor_ms);
        assert_eq!(merged[0].payload.as_ref().unwrap()["itemId"], "message_1");
    }

    #[test]
    fn matching_words_do_not_erase_a_second_accepted_prompt() {
        let cache = LiveTaskEventCache::default();
        let first = codex_item_event(
            "turn_1",
            20,
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "item_prompt_1",
                "clientId": "message_1",
                "content": [{ "type": "text", "text": "Repeat this" }]
            }),
        )
        .expect("first canonical user message");
        cache.record(first);

        let second = codex_item(
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "accepted_projection_2",
                "clientId": "message_2",
                "content": [{ "type": "text", "text": "Repeat this" }]
            }),
        )
        .expect("second accepted user message");
        cache.record(accepted_user_message_event(
            "thread_1", "turn_1", &second, 30,
        ));

        assert_eq!(
            cache.for_thread("thread_1").len(),
            2,
            "equal presentation is not evidence that two accepted messages are one"
        );
    }

    #[tokio::test]
    async fn a_recorded_delta_keeps_its_publication_revision_after_a_newer_snapshot() {
        let events = TaskEvents::default();
        let mut subscriber = events.subscribe();
        let recorded = events.record(task_event_record(
            "thread_1",
            "approval_requested:approval_1",
            "approval_requested",
            "Approval required",
            None,
            10,
        ));

        let snapshot = events.snapshot_for_thread("thread_1");
        events.broadcast(recorded.clone());
        let delivered = subscriber.recv().await.expect("recorded event broadcast");

        assert_eq!(delivered.revision, recorded.revision);
        assert!(
            delivered.revision < snapshot.revision,
            "delivery after snapshot capture must not borrow the snapshot's later revision"
        );
        assert_eq!(snapshot.observations.len(), 1);
        assert_eq!(
            snapshot.observations[0].publication_revision, recorded.revision,
            "the snapshot watermark covers the exact cached publication"
        );
    }

    #[test]
    fn provider_observations_retain_session_causality_beside_publication_order() {
        let events = TaskEvents::default();
        let published = events.publish_from_session(
            task_event_record(
                "thread_1",
                "turn_1:item_1",
                "assistant_message",
                "Assistant response",
                None,
                10,
            ),
            41,
        );

        let snapshot = events.snapshot_for_thread("thread_1");
        let observation = &snapshot.observations[0];

        assert_eq!(observation.event.id, published.event.id);
        assert_eq!(observation.session_revision, Some(41));
        assert_eq!(observation.publication_revision, published.revision);
        assert!(snapshot.revision > published.revision);
    }

    #[test]
    fn repeated_provider_reports_keep_arrival_order_and_latest_session_causality_separate() {
        let events = TaskEvents::default();
        let first = events.publish_from_session(
            task_event_record(
                "thread_1",
                "turn_1:item_1",
                "command_execution",
                "Command running",
                Some(json!({ "status": "inProgress" })),
                10,
            ),
            41,
        );
        let second = events.publish_from_session(
            task_event_record(
                "thread_1",
                "turn_1:item_1",
                "command_execution",
                "Command completed",
                Some(json!({ "status": "completed" })),
                20,
            ),
            42,
        );
        let replay = events.publish_from_session(
            task_event_record(
                "thread_1",
                "turn_1:item_1",
                "command_execution",
                "Older replay",
                Some(json!({ "status": "inProgress" })),
                5,
            ),
            40,
        );

        assert!(first.revision < second.revision && second.revision < replay.revision);
        let snapshot = events.snapshot_for_thread("thread_1");
        assert_eq!(snapshot.observations.len(), 1);
        assert_eq!(snapshot.observations[0].session_revision, Some(42));
        assert_eq!(
            snapshot.observations[0].publication_revision, replay.revision,
            "publication order records arrival even when provider causality says it is a replay"
        );
    }

    #[tokio::test]
    async fn accepted_prompt_broadcasts_the_adapter_item_identity() {
        let events = TaskEvents::default();
        let mut subscriber = events.subscribe();
        let accepted = codex_item(
            ActivityStatus::Completed,
            json!({
                "type": "userMessage",
                "id": "provider_projection",
                "clientId": "message_1",
                "content": [{ "type": "text", "text": "Keep the identity" }]
            }),
        )
        .expect("accepted user message");

        let published = events.publish(accepted_user_message_event(
            "thread_1", "turn_1", &accepted, 10,
        ));
        let broadcast = subscriber.recv().await.expect("accepted prompt broadcast");

        assert_eq!(broadcast, published);
        assert_eq!(published.event.id, "thread_1:turn_1:message_1");
        assert_eq!(published.event.position.anchor_ms, 10);
        assert_eq!(
            published.event.payload.as_ref().unwrap()["itemId"],
            "message_1"
        );
        assert!(
            published
                .event
                .payload
                .as_ref()
                .unwrap()
                .get("pendingCanonical")
                .is_none(),
            "an adapter-owned item is canonical already"
        );
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
        assert_eq!(
            cache.state.lock().unwrap().events.len(),
            LIVE_TASK_THREAD_LIMIT
        );
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
                observed_at_ms: None,
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
