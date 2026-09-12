//! One watched Grok session, and everything Caffold knows about it.
//!
//! The leader owns the session; this is Caffold's view of it while a bridge
//! is up: which native session the Task runs on, the turn being watched, the
//! questions the agent is blocked on, and what the leader last said the
//! session is doing.

use std::collections::{HashMap, HashSet};

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use super::{
    binding::NativeSession,
    protocol::{PermissionMode, PermissionOption},
    translate,
};
use crate::agent::{ActivityStatus, ConversationItem, ItemKind, Turn, TurnOrigin, TurnStatus};

pub(super) struct Session {
    pub(super) thread_id: String,
    /// Where the Task runs now. Changes only when a worktree switch commits.
    pub(super) native: AsyncMutex<NativeSession>,
    pub(super) state: AsyncMutex<SessionState>,
}

#[derive(Default)]
pub(super) struct SessionState {
    /// The bridge generation this session was loaded on; zero when it has to
    /// be loaded before it can be asked anything.
    pub(super) loaded_on: u64,
    /// The turns watched while loaded, oldest first.
    pub(super) turns: Vec<Turn>,
    pub(super) active_turn: Option<String>,
    /// A `session/prompt` this process sent has not been answered yet.
    pub(super) prompt_in_flight: bool,
    /// The text item live chunks are appended to.
    open_run: Option<OpenRun>,
    next_item: u64,
    /// Questions the agent is blocked on, by tool call id.
    pub(super) pending_approvals: HashMap<String, PendingApproval>,
    /// Tool calls a person refused; drawn as declined rather than failed.
    pub(super) declined: HashSet<String>,
    pub(super) working: bool,
    pub(super) mode: PermissionMode,
    pub(super) model: Option<String>,
    pub(super) effort: Option<String>,
    pub(super) title: Option<String>,
    pub(super) context_window: Option<u64>,
    pub(super) session_tokens: Option<u64>,
    /// Caffold asked for this session to end.
    pub(super) closed: bool,
    pub(super) opened_at_ms: u64,
    pub(super) moved_at_ms: u64,
}

struct OpenRun {
    item_id: String,
    run: Run,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Run {
    Message,
    Thought,
}

#[derive(Debug, Clone)]
pub(super) struct PendingApproval {
    /// The JSON-RPC id the leader asked on, valid for `generation` only.
    pub(super) request_id: Value,
    pub(super) generation: u64,
    pub(super) options: Vec<PermissionOption>,
}

impl SessionState {
    pub(super) fn new(mode: PermissionMode, model: Option<String>, effort: Option<String>) -> Self {
        let now = now_ms();
        Self {
            mode,
            model,
            effort,
            opened_at_ms: now,
            moved_at_ms: now,
            ..Self::default()
        }
    }

    pub(super) fn waiting_on_approval(&self) -> bool {
        !self.pending_approvals.is_empty()
    }

    /// Open a turn under the identity Caffold chose, holding the prompt.
    pub(super) fn open_turn(&mut self, prompt_id: &str, prompt: ConversationItem) -> Turn {
        let now = now_ms();
        let turn = Turn {
            id: prompt_id.to_string(),
            origin: TurnOrigin::User,
            status: TurnStatus::InProgress,
            started_at_ms: Some(now),
            completed_at_ms: None,
            items: vec![prompt],
        };
        self.active_turn = Some(prompt_id.to_string());
        self.open_run = None;
        self.moved_at_ms = now;
        self.turns.push(turn.clone());
        turn
    }

    /// Open a turn the leader reports running that Caffold did not start.
    pub(super) fn adopt_turn(&mut self, prompt_id: &str) -> Turn {
        let now = now_ms();
        let turn = Turn {
            id: prompt_id.to_string(),
            origin: TurnOrigin::Unknown,
            status: TurnStatus::InProgress,
            started_at_ms: Some(now),
            completed_at_ms: None,
            items: Vec::new(),
        };
        self.active_turn = Some(prompt_id.to_string());
        self.open_run = None;
        self.moved_at_ms = now;
        self.turns.push(turn.clone());
        turn
    }

    /// Put an item into the active turn, replacing an earlier report of the
    /// same one.
    pub(super) fn place(&mut self, item: ConversationItem) -> Option<String> {
        let turn_id = self.active_turn.clone()?;
        self.open_run = None;
        self.moved_at_ms = now_ms();
        let turn = self.turns.iter_mut().find(|turn| turn.id == turn_id)?;
        replace_item(&mut turn.items, item);
        Some(turn_id)
    }

    /// Append streamed text to the item it continues, or start one.
    pub(super) fn append_text(
        &mut self,
        run: Run,
        text: &str,
        observed_at_ms: Option<u64>,
    ) -> Option<(String, ConversationItem)> {
        let turn_id = self.active_turn.clone()?;
        self.moved_at_ms = now_ms();
        if let Some(open) = &self.open_run
            && open.run == run
        {
            let item_id = open.item_id.clone();
            let turn = self.turns.iter_mut().find(|turn| turn.id == turn_id)?;
            let item = turn.items.iter_mut().find(|item| item.id == item_id)?;
            match &mut item.kind {
                ItemKind::AssistantMessage { text: existing, .. } => existing.push_str(text),
                ItemKind::Reasoning { content, .. } => match content.first_mut() {
                    Some(existing) => existing.push_str(text),
                    None => content.push(text.to_string()),
                },
                _ => {}
            }
            return Some((turn_id, item.clone()));
        }
        self.next_item += 1;
        let item_id = format!("{turn_id}:{}", self.next_item);
        let item = match run {
            Run::Message => translate::assistant_message_item(
                &item_id,
                text,
                observed_at_ms,
                ActivityStatus::Completed,
            ),
            Run::Thought => {
                translate::reasoning_item(&item_id, text, observed_at_ms, ActivityStatus::Completed)
            }
        };
        self.open_run = Some(OpenRun {
            item_id: item_id.clone(),
            run,
        });
        let turn = self.turns.iter_mut().find(|turn| turn.id == turn_id)?;
        turn.items.push(item.clone());
        Some((turn_id, item))
    }

    pub(super) fn item(&self, turn_id: &str, item_id: &str) -> Option<&ConversationItem> {
        self.turns
            .iter()
            .find(|turn| turn.id == turn_id)?
            .items
            .iter()
            .find(|item| item.id == item_id)
    }

    /// Close the active turn. Work still running when it ended is reported
    /// as failed, unless the turn completed, in which case whatever the agent
    /// left open finished with it.
    pub(super) fn end_turn(
        &mut self,
        prompt_id: &str,
        status: TurnStatus,
        failure: Option<String>,
    ) -> Option<(Turn, Vec<ConversationItem>)> {
        if self.active_turn.as_deref() != Some(prompt_id) {
            return None;
        }
        self.active_turn = None;
        self.open_run = None;
        self.pending_approvals.clear();
        self.declined.clear();
        let now = now_ms();
        self.moved_at_ms = now;
        let turn = self.turns.iter_mut().find(|turn| turn.id == prompt_id)?;
        let mut changed = Vec::new();
        for item in &mut turn.items {
            if item.status == ActivityStatus::InProgress {
                item.status = match status {
                    TurnStatus::Completed => ActivityStatus::Completed,
                    _ => ActivityStatus::Failed,
                };
                changed.push(item.clone());
            }
        }
        if let Some(text) = failure {
            let item = translate::failure_item(&format!("{prompt_id}:failure"), &text, Some(now));
            turn.items.push(item.clone());
            changed.push(item);
        }
        turn.status = status;
        turn.completed_at_ms = Some(now);
        Some((turn.clone(), changed))
    }
}

/// Put an item in its place, replacing the earlier report of the same one.
pub(super) fn replace_item(items: &mut Vec<ConversationItem>, mut item: ConversationItem) {
    match items.iter_mut().find(|existing| existing.id == item.id) {
        Some(existing) => {
            item.observed_at_ms = match (existing.observed_at_ms, item.observed_at_ms) {
                (Some(existing), Some(incoming)) => Some(existing.min(incoming)),
                (Some(observed), None) | (None, Some(observed)) => Some(observed),
                (None, None) => None,
            };
            *existing = item;
        }
        None => items.push(item),
    }
}

pub(super) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::MessageContent;

    fn prompt(id: &str) -> ConversationItem {
        ConversationItem {
            id: format!("{id}:prompt"),
            observed_at_ms: None,
            status: ActivityStatus::Completed,
            kind: ItemKind::UserMessage {
                text: "hi".to_string(),
                content: vec![MessageContent::Text {
                    text: "hi".to_string(),
                }],
            },
        }
    }

    #[test]
    fn streamed_text_is_one_item_until_something_else_arrives() {
        let mut state = SessionState::new(PermissionMode::Ask, None, None);
        state.open_turn("p1", prompt("p1"));
        let (_, first) = state.append_text(Run::Thought, "think", None).unwrap();
        let (_, again) = state.append_text(Run::Thought, "ing", None).unwrap();
        assert_eq!(first.id, again.id);
        assert_eq!(
            again.kind,
            ItemKind::Reasoning {
                summary: vec![],
                content: vec!["thinking".to_string()]
            }
        );
        let (_, answer) = state.append_text(Run::Message, "yes", None).unwrap();
        assert_ne!(answer.id, first.id);
        state.place(ConversationItem {
            id: "call-1".to_string(),
            observed_at_ms: None,
            status: ActivityStatus::InProgress,
            kind: ItemKind::ToolCall {
                name: "x".to_string(),
            },
        });
        let (_, later) = state.append_text(Run::Message, "more", None).unwrap();
        assert_ne!(later.id, answer.id, "a tool call closes the run");
        assert_eq!(state.turns[0].items.len(), 5);
    }

    #[test]
    fn ending_a_turn_settles_what_was_still_running() {
        let mut state = SessionState::new(PermissionMode::Ask, None, None);
        state.open_turn("p1", prompt("p1"));
        state.place(ConversationItem {
            id: "call-1".to_string(),
            observed_at_ms: None,
            status: ActivityStatus::InProgress,
            kind: ItemKind::ToolCall {
                name: "x".to_string(),
            },
        });
        state.pending_approvals.insert(
            "call-1".to_string(),
            PendingApproval {
                request_id: Value::from(1),
                generation: 1,
                options: Vec::new(),
            },
        );
        assert!(
            state
                .end_turn("other", TurnStatus::Completed, None)
                .is_none()
        );
        let (turn, changed) = state
            .end_turn("p1", TurnStatus::Interrupted, Some("stopped".to_string()))
            .unwrap();
        assert_eq!(turn.status, TurnStatus::Interrupted);
        assert_eq!(changed.len(), 2, "the running call and the failure note");
        assert_eq!(turn.items[1].status, ActivityStatus::Failed);
        assert!(matches!(turn.items[2].kind, ItemKind::Failure { .. }));
        assert!(state.active_turn.is_none());
        assert!(state.pending_approvals.is_empty());
        let mut state = SessionState::new(PermissionMode::Ask, None, None);
        state.open_turn("p2", prompt("p2"));
        state.place(ConversationItem {
            id: "call-2".to_string(),
            observed_at_ms: None,
            status: ActivityStatus::InProgress,
            kind: ItemKind::ToolCall {
                name: "x".to_string(),
            },
        });
        let (turn, _) = state.end_turn("p2", TurnStatus::Completed, None).unwrap();
        assert_eq!(turn.items[1].status, ActivityStatus::Completed);
    }
}
