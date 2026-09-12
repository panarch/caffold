//! Reading a session's stored updates back as turns.
//!
//! The leader keeps every update it ever sent about a session and answers
//! windows of that log: the last `n` user turns, or an absolute range. The
//! log is one flat sequence, so turns are cut here — a turn opens at a user
//! message that is not an interjection and closes at its `turn_completed` —
//! and consecutive chunks of the same thing are one item, the way the leader
//! itself coalesces them when it writes the log.
//!
//! Paging is by absolute update index. A page is always whole turns, and the
//! cursor handed back is the absolute index of the oldest turn on the page;
//! the next page ends there.

use super::{
    protocol::{ContentBlock, StoredUpdate, ToolCall, ToolCallUpdate, Update, UpdatesResult},
    translate,
};
use crate::agent::{
    ActivityStatus, ConversationItem, ItemKind, Turn, TurnOrigin, TurnPage, TurnStatus,
};

/// Where one page of turns came from, and where the next older one starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Cursor {
    /// The absolute index of the oldest update on the page that handed this
    /// cursor out.
    pub(super) oldest_start: usize,
}

impl Cursor {
    pub(super) fn read(cursor: &str) -> Option<Self> {
        cursor
            .strip_prefix("offset:")?
            .parse()
            .ok()
            .map(|oldest_start| Self { oldest_start })
    }

    pub(super) fn write(self) -> String {
        format!("offset:{}", self.oldest_start)
    }
}

/// The absolute range of updates that holds the `limit` turns before
/// `before`, from the leader's own list of where user messages start.
///
/// Interjections start nothing but are listed among the prompt starts, so a
/// page may hold fewer turns than asked for; never more.
pub(super) fn older_window(
    prompt_starts: &[usize],
    before: usize,
    limit: usize,
) -> Option<(usize, usize)> {
    let earlier = prompt_starts
        .iter()
        .copied()
        .filter(|start| *start < before)
        .collect::<Vec<_>>();
    if earlier.is_empty() {
        return None;
    }
    let skip = earlier.len().saturating_sub(limit.max(1));
    let start = earlier[skip];
    Some((start, before - start))
}

/// The updates of one window, as the turns they hold, newest first.
///
/// `window_start` is the absolute index of the first update in the window,
/// which is what every turn boundary is measured from.
pub(super) fn turns_page(
    result: &UpdatesResult,
    window_start: usize,
    live_turn_id: Option<&str>,
) -> TurnPage {
    let turns = cut_turns(&result.updates, live_turn_id);
    let oldest_start = window_start;
    let next_cursor =
        (oldest_start > 0 && !turns.is_empty()).then(|| Cursor { oldest_start }.write());
    let mut turns = turns;
    turns.reverse();
    TurnPage {
        turns,
        next_cursor,
        backwards_cursor: None,
    }
}

/// Cut a flat window of updates into the turns it holds, oldest first.
fn cut_turns(updates: &[StoredUpdate], live_turn_id: Option<&str>) -> Vec<Turn> {
    let mut turns: Vec<Turn> = Vec::new();
    let mut builder: Option<TurnBuilder> = None;
    for stored in updates {
        let update = Update::read(&stored.params.update);
        let event_id = stored.params.meta.event_id.clone().unwrap_or_default();
        let observed_at_ms = stored
            .params
            .meta
            .agent_timestamp_ms
            .or_else(|| stored.timestamp.map(|seconds| seconds * 1000));
        match update {
            Update::UserMessage(block, meta) if !meta.interjection => {
                if let Some(open) = builder.take() {
                    turns.push(open.finish(None, None));
                }
                let mut opened = TurnBuilder::new(&event_id, observed_at_ms);
                opened.user_message(&event_id, block, observed_at_ms);
                builder = Some(opened);
            }
            other => {
                let Some(open) = builder.as_mut() else {
                    // A window that starts mid-turn is not one this reader
                    // asked for; what it holds belongs to a turn it cannot
                    // name, and is not drawn as a turn of its own.
                    continue;
                };
                match other {
                    Update::UserMessage(block, _) => {
                        open.user_message(&event_id, block, observed_at_ms)
                    }
                    Update::AgentMessage(block) => {
                        open.agent_message(&event_id, block, observed_at_ms)
                    }
                    Update::AgentThought(block) => open.thought(&event_id, block, observed_at_ms),
                    Update::ToolCall(call) => open.tool_call(&call, observed_at_ms),
                    Update::ToolCallUpdate(update) => open.tool_call_update(&update),
                    Update::Plan(entries) => {
                        open.push(translate::plan_item(&event_id, &entries, observed_at_ms))
                    }
                    Update::TurnCompleted(completed) => {
                        let finished = builder.take().expect("checked open").finish(
                            Some(&completed.prompt_id),
                            Some((
                                translate::turn_status(completed.stop_reason.as_deref()),
                                observed_at_ms,
                                completed.stop_reason.clone(),
                            )),
                        );
                        turns.push(finished);
                    }
                    Update::PendingInteraction { .. }
                    | Update::InteractionResolved { .. }
                    | Update::Other(_) => {}
                }
            }
        }
    }
    if let Some(open) = builder.take() {
        // The newest turn has not ended in the log. If the live session
        // knows it, it is that turn; otherwise it is a turn the log names
        // only by its first update.
        let mut turn = open.finish(live_turn_id, None);
        turn.status = if live_turn_id.is_some() {
            TurnStatus::InProgress
        } else {
            TurnStatus::Failed
        };
        turns.push(turn);
    }
    // Turns that closed with nothing open after them keep their status;
    // an older turn missing its end is one the leader never finished.
    turns
}

struct TurnBuilder {
    first_event_id: String,
    started_at_ms: Option<u64>,
    items: Vec<ConversationItem>,
    /// The item text is being appended to: (index into items, kind).
    open_run: Option<(usize, Run)>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Run {
    Message,
    Thought,
}

impl TurnBuilder {
    fn new(first_event_id: &str, started_at_ms: Option<u64>) -> Self {
        Self {
            first_event_id: first_event_id.to_string(),
            started_at_ms,
            items: Vec::new(),
            open_run: None,
        }
    }

    fn push(&mut self, item: ConversationItem) {
        self.open_run = None;
        self.items.push(item);
    }

    fn user_message(&mut self, event_id: &str, block: ContentBlock, observed_at_ms: Option<u64>) {
        self.push(translate::user_message_item(
            event_id,
            &[block],
            observed_at_ms,
        ));
    }

    fn agent_message(&mut self, event_id: &str, block: ContentBlock, observed_at_ms: Option<u64>) {
        self.append_text(event_id, block, observed_at_ms, Run::Message);
    }

    fn thought(&mut self, event_id: &str, block: ContentBlock, observed_at_ms: Option<u64>) {
        self.append_text(event_id, block, observed_at_ms, Run::Thought);
    }

    fn append_text(
        &mut self,
        event_id: &str,
        block: ContentBlock,
        observed_at_ms: Option<u64>,
        run: Run,
    ) {
        let ContentBlock::Text { text, .. } = block else {
            return;
        };
        if let Some((index, open)) = self.open_run
            && open == run
        {
            match &mut self.items[index].kind {
                ItemKind::AssistantMessage { text: existing, .. } => existing.push_str(&text),
                ItemKind::Reasoning { content, .. } => {
                    if let Some(existing) = content.first_mut() {
                        existing.push_str(&text);
                    }
                }
                _ => {}
            }
            return;
        }
        let item = match run {
            Run::Message => translate::assistant_message_item(
                event_id,
                &text,
                observed_at_ms,
                ActivityStatus::Completed,
            ),
            Run::Thought => translate::reasoning_item(
                event_id,
                &text,
                observed_at_ms,
                ActivityStatus::Completed,
            ),
        };
        self.items.push(item);
        self.open_run = Some((self.items.len() - 1, run));
    }

    fn tool_call(&mut self, call: &ToolCall, observed_at_ms: Option<u64>) {
        let mut item = translate::tool_call_item(call);
        item.observed_at_ms = observed_at_ms;
        self.push(item);
    }

    fn tool_call_update(&mut self, update: &ToolCallUpdate) {
        self.open_run = None;
        let before = self
            .items
            .iter()
            .position(|item| item.id == update.tool_call_id);
        let item =
            translate::tool_call_update_item(before.map(|index| &self.items[index]), update, false);
        match before {
            Some(index) => self.items[index] = item,
            None => self.items.push(item),
        }
    }

    fn finish(
        self,
        turn_id: Option<&str>,
        ended: Option<(TurnStatus, Option<u64>, Option<String>)>,
    ) -> Turn {
        let mut items = self.items;
        let (status, completed_at_ms) = match ended {
            Some((status, at_ms, stop_reason)) => {
                if let Some(text) = stop_reason.as_deref().and_then(translate::failure_text) {
                    items.push(translate::failure_item(
                        &format!("{}:failure", self.first_event_id),
                        &text,
                        at_ms,
                    ));
                }
                (status, at_ms)
            }
            None => (TurnStatus::Failed, None),
        };
        if status != TurnStatus::Completed {
            for item in &mut items {
                if item.status == ActivityStatus::InProgress {
                    item.status = ActivityStatus::Failed;
                }
            }
        }
        Turn {
            id: turn_id.map(str::to_string).unwrap_or(self.first_event_id),
            origin: TurnOrigin::User,
            status,
            started_at_ms: self.started_at_ms,
            completed_at_ms,
            items,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ItemKind;

    fn fixture(name: &str) -> UpdatesResult {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent/grok/fixtures")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_stored_session_is_cut_into_its_turns_newest_first() {
        let result = fixture("updates-result.json");
        let page = turns_page(&result, 0, None);
        // Five prompts; the sixth prompt start is an interjection inside the
        // fifth turn.
        assert_eq!(page.turns.len(), 5);
        assert!(
            page.next_cursor.is_none(),
            "the whole log has nothing older"
        );
        let newest = &page.turns[0];
        assert_eq!(newest.status, TurnStatus::Completed);
        assert!(newest.completed_at_ms.is_some());
        let kinds = newest
            .items
            .iter()
            .map(|item| std::mem::discriminant(&item.kind))
            .collect::<Vec<_>>();
        assert_eq!(
            kinds.len(),
            6,
            "prompt, thought, command, interjection, thought, answer"
        );
        assert!(matches!(newest.items[0].kind, ItemKind::UserMessage { .. }));
        assert!(matches!(
            newest.items[2].kind,
            ItemKind::CommandExecution(_)
        ));
        let ItemKind::UserMessage { text, .. } = &newest.items[3].kind else {
            panic!("the interjection stays inside the turn");
        };
        assert!(text.starts_with("INTERJECT_"), "{text}");
        assert!(newest.id.len() > 20, "turns are named by their prompt id");
        let cancelled = &page.turns[1];
        assert_eq!(cancelled.status, TurnStatus::Interrupted);
        let command = cancelled
            .items
            .iter()
            .find(|item| matches!(item.kind, ItemKind::CommandExecution(_)))
            .unwrap();
        assert_eq!(
            command.status,
            ActivityStatus::Failed,
            "a command left running when the turn was cancelled"
        );
        let oldest = &page.turns[4];
        assert_eq!(
            oldest.items.len(),
            6,
            "prompt, thought, answer, command, thought, answer"
        );
    }

    #[test]
    fn the_older_window_is_cut_on_whole_turns() {
        let starts = [0, 9, 17, 25, 30, 35];
        assert_eq!(older_window(&starts, 17, 8), Some((0, 17)));
        assert_eq!(older_window(&starts, 17, 1), Some((9, 8)));
        assert_eq!(older_window(&starts, 0, 8), None);
        assert_eq!(Cursor::read("offset:17"), Some(Cursor { oldest_start: 17 }));
        assert_eq!(Cursor::read("17"), None);
        assert_eq!(Cursor { oldest_start: 9 }.write(), "offset:9");
    }

    #[test]
    fn a_window_that_begins_mid_turn_draws_nothing_it_cannot_name() {
        let mut result = fixture("updates-result.json");
        result.updates.drain(..2);
        let page = turns_page(&result, 2, None);
        assert_eq!(page.turns.len(), 4);
    }

    #[test]
    fn an_unfinished_newest_turn_is_the_live_turn_when_one_is_known() {
        let mut result = fixture("updates-result.json");
        result.updates.pop();
        let page = turns_page(&result, 0, Some("prompt-live"));
        assert_eq!(page.turns[0].id, "prompt-live");
        assert_eq!(page.turns[0].status, TurnStatus::InProgress);
        let page = turns_page(&result, 0, None);
        assert_ne!(page.turns[0].id, "prompt-live");
        assert_eq!(page.turns[0].status, TurnStatus::Failed);
    }
}
