//! Reading a conversation back from what the agent wrote down.
//!
//! Claude keeps its own record of every session, and keeps it as the session
//! happens rather than when the session ends — a turn's work is on disk while
//! the turn is still running. That is what makes the file the history rather
//! than a backup of it: a conversation nobody watched, a conversation watched
//! by a Caffold that has since restarted, and a conversation being watched now
//! all read back the same way.
//!
//! Caffold reads it because Caffold forgets. A backend restart loses every
//! session it was watching, and a Task whose turns lived only in memory would
//! come back empty. Nothing is copied into Caffold's own store to prevent that,
//! because the agent is already keeping the record and two records would
//! disagree.
//!
//! ## Where it is
//!
//! Under `~/.claude/projects`, in a directory named after the working directory
//! the session runs in, as a file named after the session. That is the whole
//! reason a Claude Task carries the directory it started in: the agent will
//! answer for a session it is running, and this has to be found without one.
//!
//! ## What a turn is
//!
//! The agent does not write turns down, only messages, so a turn is read off
//! their boundaries: a prompt opens one, and everything until the next prompt
//! belongs to it.
//!
//! Not every `user` row is somebody talking. A tool's answer is written as one,
//! and so is the agent's own scaffolding — the caveat it writes before running
//! a command, the command it expands. Two fields separate them, and both are
//! the agent's own: `promptSource` marks a prompt, `toolUseResult` marks an
//! answer, and a `user` row with neither is the agent talking to itself and
//! belongs to nobody. That matters more than it sounds, because Caffold changes
//! a session's depth by asking it to run `/effort`, and reading that back as
//! something a person said would put it in their conversation.
//!
//! Not every prompt is somebody talking either. A background command that
//! finishes reports back into the conversation as a prompt, because that is how
//! the agent is made to answer it, and `origin` is what says so: a report is
//! marked `task-notification`, where a prompt somebody sent is marked `human`
//! or marked nothing at all. So what is asked of a prompt is whether it is a
//! report, not whether it is a person's — asking the other way round would take
//! every prompt Caffold sends, which carries no `origin`, and lose it. A report
//! opens a turn like any prompt, because the work the agent does about it has
//! to belong somewhere, but the report itself is drawn as nothing: nobody said
//! it.
//!
//! A message sent into a turn already running is not a `user` row at all: it is
//! an attachment the agent files as a queued command, which is why it is read
//! from there. A report that arrives while the agent is working is queued the
//! same way, and there it is `commandMode` that tells the two apart.
//!
//! The turns here are finished ones. A turn still running is described by the
//! session running it, which knows what the file cannot say — that the agent is
//! still working, that a tool is waiting on an answer — and which names the
//! turn the same thing this does, so the two are one turn.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::protocol::{ContentBlock, Message, MessageContent};
use super::translate::{
    ToolCalls, answers_tool_calls, message_items, prompt_content, prompt_item, steer_item,
};
use crate::agent::{
    BackgroundTask, ItemKind, MessageContent as CaffoldContent, Turn, TurnOrigin, TurnPage,
    TurnStatus,
};

mod bytes;

/// One line of the transcript.
///
/// Two dozen kinds are written and this reads three. The rest — the titles the
/// agent gives a session, the queue it keeps, its hooks — describe the session
/// rather than the conversation.
#[derive(Debug, Deserialize)]
struct Row {
    #[serde(default, rename = "type")]
    kind: String,
    /// What this message is known by, in the file and on the live stream alike.
    #[serde(default)]
    uuid: Option<String>,
    /// The row this one names as its parent in Claude's transcript graph.
    #[serde(default, rename = "parentUuid")]
    parent_uuid: Option<TranscriptString>,
    /// The provider's identity for the prompt this row belongs to. Unlike a
    /// row UUID, it is repeated on attachments delivered into that prompt.
    #[serde(default, rename = "promptId")]
    prompt_id: Option<TranscriptString>,
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    message: Option<Message>,
    /// Where a prompt came from — a person typing, an SDK, the agent's own
    /// queue. Present only on a message that is somebody's prompt.
    #[serde(default, rename = "promptSource")]
    prompt_source: Option<String>,
    /// What put a prompt in the conversation, when the agent has anything to
    /// say about it. It says nothing about the prompts Caffold sends and
    /// everything about the ones nobody sent.
    #[serde(default)]
    origin: Option<Marking>,
    /// What a tool answered. Present only on a message carrying one.
    #[serde(default, rename = "toolUseResult")]
    tool_use_result: Option<ToolUseResult>,
    /// A subagent's own conversation, which belongs to the tool call that
    /// started it rather than to the one a person is reading.
    #[serde(default, rename = "isSidechain")]
    is_sidechain: bool,
    /// The harness speaking, not the model: a turn that could not run at all,
    /// written where an answer would have been.
    #[serde(default, rename = "isApiErrorMessage")]
    is_api_error_message: bool,
    /// What the agent files alongside the conversation rather than in it.
    #[serde(default)]
    attachment: Option<Attachment>,
}

/// Something filed beside the conversation.
///
/// Most of these are the agent's housekeeping. One is not: a message a person
/// sent while a turn was running is queued, and this is where it is written.
#[derive(Debug, Deserialize)]
struct Attachment {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    prompt: MessageContent,
    /// What was queued: a message, or a background command reporting back while
    /// the agent was too busy to be told.
    #[serde(default, rename = "commandMode")]
    mode: Option<Marking>,
    /// When this was put into the queue. An attachment carries its own time;
    /// the row around it commonly does not.
    #[serde(default)]
    timestamp: Option<TranscriptString>,
    /// The name the host sent the message under. The row's own uuid is
    /// Claude's; this one is what the live reader holds the same message by.
    #[serde(default)]
    source_uuid: Option<TranscriptString>,
}

impl Attachment {
    fn sent_as(&self) -> Option<&str> {
        self.source_uuid.as_ref().and_then(TranscriptString::text)
    }
}

/// An ancillary string whose shape must never decide whether its row survives.
///
/// Claude's row UUID is essential to drawing a message, but prompt links and
/// attachment timestamps only add evidence. A future shape for one costs that
/// link or time and nothing else on the row.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum TranscriptString {
    Text(String),
    Unreadable(serde::de::IgnoredAny),
}

impl TranscriptString {
    fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            Self::Unreadable(_) => None,
        }
    }
}

/// The small part of a tool's transcript metadata this reader understands.
///
/// Kept open with an unreadable fallback because most tool results carry other
/// shapes, and a new one must not make the message containing it disappear.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ToolUseResult {
    Fields {
        #[serde(default, rename = "backgroundTaskId")]
        background_task_id: Option<String>,
    },
    Unreadable(serde::de::IgnoredAny),
}

impl ToolUseResult {
    fn background_task_id(&self) -> Option<&str> {
        match self {
            Self::Fields { background_task_id } => background_task_id.as_deref(),
            Self::Unreadable(_) => None,
        }
    }
}

/// What the agent says something of its own is.
///
/// A prompt is marked in an object and a queued command in a word, and either
/// may one day be marked in a shape this release has never seen. That has to
/// cost the marking and nothing else: a marking refused fails the row it is
/// written on, and that row is a message — the prompt somebody sent, gone from
/// their conversation because the agent labelled it in a way Caffold did not
/// know.
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Marking {
    /// A word, which is how a queued command is marked.
    Word(String),
    /// A word inside an object, which is how a prompt is marked.
    Kind { kind: String },
    /// A shape this release does not read, which marks nothing.
    Unreadable(serde::de::IgnoredAny),
}

impl Marking {
    /// Whether this is the agent's own name for the thing named.
    fn says(&self, name: &str) -> bool {
        match self {
            Self::Word(marking) | Self::Kind { kind: marking } => marking == name,
            Self::Unreadable(_) => false,
        }
    }
}

/// What the agent calls a background command reporting back.
///
/// One name for both ways it arrives: as a prompt when the agent is idle, as a
/// queued command when it is working.
const TASK_NOTIFICATION: &str = "task-notification";
const HUMAN_ORIGIN: &str = "human";

/// One explicitly marked background report found while reading the file.
///
/// A prompt delivery opens its own turn. A queued delivery belongs beside a
/// turn already running and must not manufacture another one. Keeping both in
/// the transcript reading preserves that distinction even before a product
/// surface decides what to do with it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackgroundTaskObservation {
    pub(crate) task: BackgroundTask,
    pub(crate) delivery: BackgroundTaskDelivery,
    pub(crate) at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum BackgroundTaskDelivery {
    Turn { turn_id: String },
    Queued { turn_id: Option<String> },
}

/// Where the agent keeps every project's conversations.
///
/// Read once, when a client is built, rather than at each use: a backend whose
/// environment has no home has nowhere to read or remove conversations, and
/// finding that out at the moment of a delete would mean reporting one that
/// removed nothing as done.
pub(crate) fn projects_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").filter(|home| !home.is_empty())?;
    Some(Path::new(&home).join(".claude").join("projects"))
}

/// Where the agent keeps this session's conversation.
///
/// `cwd` is the directory the session runs in, which is the one it was created
/// in: resuming a session somewhere else leaves its record where it was.
///
/// Nothing is located for a session whose name is not a name. The identifier
/// reaches here from a row in Caffold's store and is joined into a path that
/// [`erase`] removes, so a name that is not one is not a path this can work out
/// — `..` would climb out of the directory, an absolute one would leave it
/// altogether, and both would be removed as readily as the right file.
pub(crate) fn locate(projects: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    names_one_conversation(session_id).then(|| {
        projects
            .join(project_directory(cwd))
            .join(format!("{session_id}.jsonl"))
    })
}

/// Whether an identifier names one conversation and nothing else.
///
/// The agent names a session with a UUID and so does Caffold, so this asks for
/// no more than that shape allows: something written, made only of the
/// characters a UUID is made of. Anything else is refused rather than
/// interpreted, because what is on the other side of this is a recursive
/// removal and the cost of guessing wrong is not recoverable.
fn names_one_conversation(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
}

/// The name a working directory is filed under.
///
/// Everything that is not a letter, a digit, or a dash becomes a dash, so the
/// directory is one path component and separators survive as punctuation. The
/// mapping loses information — two directories can be filed under one name —
/// and that is the agent's to own; Caffold reproduces it rather than improving
/// on it, because the agent is the one that decides where the file goes.
fn project_directory(cwd: &str) -> String {
    cwd.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' {
                character
            } else {
                '-'
            }
        })
        .collect()
}

/// A conversation as this release could read it.
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Reading {
    pub(crate) page: TurnPage,
    /// Agent-owned background reports in this page, including ones queued
    /// inside a turn and therefore absent from its visible messages.
    pub(crate) background_tasks: Vec<BackgroundTaskObservation>,
    /// Lines this release could not read at all.
    ///
    /// Each is a message missing from a conversation shown as though it were
    /// whole, which is the one thing tolerant parsing must not do quietly.
    pub(crate) unreadable: usize,
}

/// Why the agent-owned history could not be read as the page requested.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ReadError {
    #[error("could not read Claude's transcript: {0}")]
    Io(#[from] std::io::Error),
    #[error("Claude transcript cursor is invalid: {0}")]
    InvalidCursor(String),
    #[error("the selected Claude transcript page is not valid UTF-8: {0}")]
    InvalidUtf8(#[source] std::string::FromUtf8Error),
}

/// Where a turn begins, without reading what it is about.
///
/// Nothing but the file says which rows start turns. This is the small shape
/// the bounded byte reader tries while walking backwards through the needed
/// tail: the identity, and deliberately not the message. A `message` field here
/// would make it decode every picture it crosses just to find eight turns.
#[derive(Debug, Deserialize)]
struct Boundary {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    uuid: Option<String>,
    #[serde(default, rename = "promptSource")]
    prompt_source: Option<String>,
    #[serde(default, rename = "isSidechain")]
    is_sidechain: bool,
}

/// Remove a written-down conversation and everything filed with it.
///
/// A local session is the file and the directory beside it — the subagent
/// conversations, the tool output that spilled out of the file — and nothing
/// else anywhere. Removing both is the whole of forgetting one.
///
/// Gone already is the outcome asked for, so only a removal that failed for
/// some other reason is a failure.
pub(crate) fn erase(written: &Path) -> std::io::Result<()> {
    let beside = written.with_extension("");
    match std::fs::remove_file(written) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    match std::fs::remove_dir_all(&beside) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

/// The most recent turns, newest first, and where to continue reading older
/// ones.
///
/// `before` continues from an opaque, verifiable cursor an earlier read gave
/// out. A file that is not there is a session the agent has not written
/// anything for yet, which is empty history. Every other source failure is an
/// error: unreadable history must not masquerade as a conversation with no
/// history, and a cursor that cannot be verified must not masquerade as the end
/// of it.
///
/// The file length is captured once, then physical lines are read backwards in
/// fixed-size blocks until enough prompt boundaries are found. Only that byte
/// window is decoded and built into turns. An append during the read is left
/// wholly for the next one.
pub(crate) fn read(path: &Path, before: Option<&str>, limit: usize) -> Result<Reading, ReadError> {
    let mut file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Reading::default());
        }
        Err(error) => return Err(error.into()),
    };
    let snapshot_len = file.metadata()?.len();
    let window = bytes::window(&mut file, snapshot_len, before, limit)?;
    let lines = window.contents.lines().collect::<Vec<_>>();
    let parsed = turns(&lines);
    Ok(Reading {
        page: TurnPage {
            // Newest first, which is the order history is read in.
            turns: parsed.turns.into_iter().rev().collect(),
            next_cursor: window.older,
            backwards_cursor: None,
        },
        background_tasks: parsed.background_tasks,
        unreadable: parsed.unreadable,
    })
}

/// The lines a page is made of, and where the turns older than it begin.
#[cfg(test)]
struct Window {
    lines: std::ops::Range<usize>,
    older: Option<String>,
}

/// Which lines the asked-for turns are written on.
///
/// A turn runs from the line that opens it to the line before the next one, and
/// the last runs to the end of the file — so work the agent did before anyone
/// asked it anything falls outside every window, which is where it belongs.
#[cfg(test)]
fn window(lines: &[&str], before: Option<&str>, limit: usize) -> Option<Window> {
    let opens: Vec<(usize, String)> = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            let row = serde_json::from_str::<Boundary>(line).ok()?;
            let opens_a_turn =
                !row.is_sidechain && row.kind == "user" && row.prompt_source.is_some();
            opens_a_turn.then_some(())?;
            Some((index, row.uuid?))
        })
        .collect();

    // A cursor names the oldest turn already read, so this page ends where that
    // one began. One naming a turn that is not here — a file that was replaced,
    // or a cursor that was never ours — reads as nothing further.
    let end = match before {
        Some(cursor) => opens.iter().position(|(_, id)| id == cursor)?,
        None => opens.len(),
    };
    let start = end.saturating_sub(limit);
    let line_of = |at: usize| opens.get(at).map_or(lines.len(), |(line, _)| *line);
    Some(Window {
        older: (start > 0).then(|| opens[start].1.clone()),
        lines: line_of(start)..line_of(end),
    })
}

/// What one transcript window says, before its turns are put newest first.
#[derive(Default)]
struct ParsedTurns {
    turns: Vec<Turn>,
    background_tasks: Vec<BackgroundTaskObservation>,
    unreadable: usize,
}

/// Every turn and marked background report on these lines, oldest first.
fn turns(lines: &[&str]) -> ParsedTurns {
    let mut turns: Vec<Turn> = Vec::new();
    let mut background_tasks = Vec::new();
    let mut unreadable = 0;
    // An attachment names the provider prompt it was delivered into, while a
    // Caffold turn is named by the prompt row's UUID. Keep the explicit bridge
    // between those two identities; never replace a missing bridge with the
    // nearest turn in the file.
    let mut prompt_turns: Vec<(String, String)> = Vec::new();
    // Rows inside a prompt repeat its prompt id or name a parent that already
    // did. This follows only that explicit graph, so an attachment whose link
    // is absent or ambiguous remains unassigned.
    let mut row_prompts: Vec<(String, String)> = Vec::new();
    // Held across the window, because a tool call is drawn from where it
    // started and answered somewhere later. A call never outlives the turn it
    // was made in, so a window of whole turns holds both ends of every one.
    let mut calls = ToolCalls::default();

    for line in lines.iter().copied() {
        let Ok(row) = serde_json::from_str::<Row>(line) else {
            // A line this release cannot read is one message missing from a
            // conversation, which is worth less than the conversation — but it
            // is counted, because a conversation missing a message must not be
            // handed over as a whole one.
            unreadable += 1;
            continue;
        };
        if row.is_sidechain {
            continue;
        }
        let Some(anchor) = row.uuid.as_deref() else {
            continue;
        };
        let at_ms = row.timestamp.as_deref().and_then(super::parse_timestamp_ms);
        let opens_prompt = row.kind == "user" && row.prompt_source.is_some();
        let own_prompt_id = row
            .prompt_id
            .as_ref()
            .and_then(TranscriptString::text)
            .map(str::to_string);
        let parent_prompt_id = if opens_prompt {
            None
        } else {
            exact_row_prompt(
                &row_prompts,
                row.parent_uuid.as_ref().and_then(TranscriptString::text),
            )
            .map(str::to_string)
        };
        let linked_prompt_id = match (own_prompt_id, parent_prompt_id) {
            (Some(own), Some(parent)) if own != parent => None,
            (Some(own), _) => Some(own),
            (None, parent) => parent,
        };
        if let Some(prompt_id) = linked_prompt_id.as_deref() {
            row_prompts.push((anchor.to_string(), prompt_id.to_string()));
        }

        if let Some(attachment) = queued_background_task(&row) {
            let task = background_task(&attachment.prompt);
            apply_background_task(&mut turns, &task);
            background_tasks.push(BackgroundTaskObservation {
                task,
                delivery: BackgroundTaskDelivery::Queued {
                    turn_id: exact_prompt_turn(&prompt_turns, linked_prompt_id.as_deref()),
                },
                at_ms: attachment
                    .timestamp
                    .as_ref()
                    .and_then(TranscriptString::text)
                    .and_then(super::parse_timestamp_ms)
                    .or(at_ms),
            });
            continue;
        }

        // A message sent into a turn already running, which the agent files
        // beside the conversation rather than in it.
        if let Some((name, steer)) = steered_message(&row, anchor) {
            if let Some(turn) = turns.last_mut() {
                turn.items.push(steer_item(name, steer, at_ms));
            }
            continue;
        }
        let Some(message) = row.message.as_ref() else {
            continue;
        };
        // The line read and the message inside it did not. Counted here as well
        // as above, because a message this release cannot make anything of is
        // missing from the conversation whether the loss was the whole line or
        // the body of it.
        if matches!(message.content, MessageContent::Unreadable(_)) {
            unreadable += 1;
            continue;
        }

        if opens_prompt {
            // A background command reporting back opens a turn like any other
            // prompt, because what the agent does about it is work that belongs
            // somewhere, and it opens on that work: the report is the agent
            // writing to itself, and drawing it as words would put a line
            // nobody wrote where what somebody said belongs.
            let origin = prompt_origin(&row, message);
            let said = (!matches!(origin, TurnOrigin::BackgroundTask(_)))
                .then(|| prompt_item(anchor, prompt_content(message), at_ms));
            if let TurnOrigin::BackgroundTask(task) = &origin {
                apply_background_task(&mut turns, task);
                background_tasks.push(BackgroundTaskObservation {
                    task: task.clone(),
                    delivery: BackgroundTaskDelivery::Turn {
                        turn_id: anchor.to_string(),
                    },
                    at_ms,
                });
            }
            turns.push(Turn {
                id: anchor.to_string(),
                origin,
                status: TurnStatus::Completed,
                started_at_ms: at_ms,
                completed_at_ms: at_ms,
                items: said.into_iter().collect(),
            });
            if let Some(prompt_id) = row.prompt_id.as_ref().and_then(TranscriptString::text) {
                prompt_turns.push((prompt_id.to_string(), anchor.to_string()));
            }
            continue;
        }
        if row.kind == "user" && !answers_tool_calls(message) {
            // The agent talking to itself: the caveat it writes before running
            // a command, and the command it expands. Reading one as something a
            // person said would put Caffold's own `/effort` in a conversation.
            // The live reader leaves the same message out by the same rule.
            continue;
        }
        if row.kind != "user" && row.kind != "assistant" {
            continue;
        }
        // Work before anyone asked for anything belongs to no turn. The agent
        // writes some at the start of a session, and there is nowhere to show
        // it.
        let Some(turn) = turns.last_mut() else {
            continue;
        };
        // Placed rather than appended, because a tool call is written down
        // twice — once where it started and once where it was answered — under
        // one identity, and the second is the first finishing rather than a
        // second thing the agent did. The live reader places items for the same
        // reason.
        let background_task_id = row
            .tool_use_result
            .as_ref()
            .and_then(ToolUseResult::background_task_id);
        for mut item in message_items(message, anchor, &mut calls, row.is_api_error_message) {
            item.observed_at_ms = at_ms;
            if let Some(task_id) = background_task_id
                && let ItemKind::CommandExecution(command) = &mut item.kind
            {
                command.background_task = Some(BackgroundTask {
                    task_id: Some(task_id.to_string()),
                    tool_use_id: Some(item.id.clone()),
                    ..BackgroundTask::default()
                });
            }
            super::replace_item(&mut turn.items, item);
        }
        if at_ms.is_some() {
            turn.completed_at_ms = at_ms;
        }
    }
    ParsedTurns {
        turns,
        background_tasks,
        unreadable,
    }
}

/// The Caffold turn named by exactly one occurrence of a provider prompt id.
fn exact_prompt_turn(prompt_turns: &[(String, String)], prompt_id: Option<&str>) -> Option<String> {
    let prompt_id = prompt_id?;
    let mut matches = prompt_turns
        .iter()
        .filter(|(known, _)| known == prompt_id)
        .map(|(_, turn_id)| turn_id);
    let turn_id = matches.next()?;
    matches.next().is_none().then(|| turn_id.clone())
}

fn exact_row_prompt<'a>(
    row_prompts: &'a [(String, String)],
    row_id: Option<&str>,
) -> Option<&'a str> {
    let row_id = row_id?;
    let mut matches = row_prompts
        .iter()
        .filter(|(known, _)| known == row_id)
        .map(|(_, prompt_id)| prompt_id.as_str());
    let prompt_id = matches.next()?;
    matches.next().is_none().then_some(prompt_id)
}

/// What opened a prompt row, to the extent the row says.
///
/// A prompt sent through Caffold carries no origin and one typed by a person is
/// explicitly `human`; both are user work. Everything else stays unknown
/// unless the agent marks the one autonomous source this release understands.
fn prompt_origin(row: &Row, message: &Message) -> TurnOrigin {
    match row.origin.as_ref() {
        None => TurnOrigin::User,
        Some(Marking::Kind { kind }) if kind == HUMAN_ORIGIN => TurnOrigin::User,
        Some(Marking::Kind { kind }) if kind == TASK_NOTIFICATION => {
            TurnOrigin::BackgroundTask(background_task(&message.content))
        }
        Some(_) => TurnOrigin::Unknown,
    }
}

/// A marked report queued beside a turn already running, if this row is one.
fn queued_background_task(row: &Row) -> Option<&Attachment> {
    let attachment = row.attachment.as_ref()?;
    (attachment.kind == "queued_command"
        && attachment
            .mode
            .as_ref()
            .is_some_and(|mode| mode.says(TASK_NOTIFICATION)))
    .then_some(attachment)
}

/// The facts inside a marked background report.
///
/// This is only called after the outer structured marking identified the
/// payload. The same words pasted by a person never reach this parser. Fields
/// are accepted only when each named tag occurs exactly once; ambiguity costs
/// that field rather than being resolved by position or preference.
fn background_task(content: &MessageContent) -> BackgroundTask {
    let raw = notification_text(content).map(str::to_string);
    let field = |name| raw.as_deref().and_then(|raw| one_tag(raw, name));
    BackgroundTask {
        task_id: field("task-id"),
        tool_use_id: field("tool-use-id"),
        status: field("status"),
        output_file: field("output-file"),
        summary: field("summary"),
        raw,
    }
}

/// Text in the two message shapes Claude has used for a task notification.
fn notification_text(content: &MessageContent) -> Option<&str> {
    match content {
        MessageContent::Text(text) => Some(text),
        MessageContent::Blocks(blocks) => match blocks.as_slice() {
            [ContentBlock::Text { text }] => Some(text),
            _ => None,
        },
        MessageContent::Unreadable(_) => None,
    }
}

fn one_tag(text: &str, name: &str) -> Option<String> {
    let opening = format!("<{name}>");
    let closing = format!("</{name}>");
    let mut openings = text.match_indices(&opening);
    let (opening_at, _) = openings.next()?;
    if openings.next().is_some() {
        return None;
    }
    let mut closings = text.match_indices(&closing);
    let (closing_at, _) = closings.next()?;
    if closings.next().is_some() {
        return None;
    }
    let value_at = opening_at + opening.len();
    if closing_at < value_at {
        return None;
    }
    let value = text[value_at..closing_at].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// Enrich the one command a marked report names, if that command is in this
/// transcript window.
///
/// A tool id absent from the page, repeated, or disagreeing with the task id
/// already reported is not repaired with chronology. The notification remains
/// preserved on its own turn or observation; only the unsafe link is omitted.
fn apply_background_task(turns: &mut [Turn], task: &BackgroundTask) {
    let Some(tool_use_id) = task.tool_use_id.as_deref() else {
        return;
    };
    let mut found = None;
    for (turn_index, turn) in turns.iter().enumerate() {
        for (item_index, item) in turn.items.iter().enumerate() {
            if item.id == tool_use_id && matches!(item.kind, ItemKind::CommandExecution(_)) {
                if found.is_some() {
                    return;
                }
                found = Some((turn_index, item_index));
            }
        }
    }
    let Some((turn_index, item_index)) = found else {
        return;
    };
    let ItemKind::CommandExecution(command) = &mut turns[turn_index].items[item_index].kind else {
        return;
    };
    if let (Some(known), Some(reported)) = (
        command
            .background_task
            .as_ref()
            .and_then(|background| background.task_id.as_deref()),
        task.task_id.as_deref(),
    ) && known != reported
    {
        return;
    }
    let background = command
        .background_task
        .get_or_insert_with(BackgroundTask::default);
    overlay(&mut background.task_id, &task.task_id);
    overlay(&mut background.tool_use_id, &task.tool_use_id);
    overlay(&mut background.status, &task.status);
    overlay(&mut background.output_file, &task.output_file);
    overlay(&mut background.summary, &task.summary);
    overlay(&mut background.raw, &task.raw);
}

fn overlay(current: &mut Option<String>, reported: &Option<String>) {
    if let Some(reported) = reported {
        *current = Some(reported.clone());
    }
}

/// What a person said into a turn that was already running, if that is what
/// this row is.
///
/// A queued command with nothing in it to show is passed over rather than
/// shown as an empty thing somebody said. Having parts is not the same as
/// having anything to say: a blank line is one part.
/// A message steered into a running turn: what it is called, and what it
/// said. Named by the host that sent it when the row says so, and by the row
/// itself otherwise.
fn steered_message<'a>(row: &'a Row, anchor: &'a str) -> Option<(&'a str, Vec<CaffoldContent>)> {
    let attachment = row.attachment.as_ref()?;
    if attachment.kind != "queued_command" {
        return None;
    }
    // The queue is where a report waits when the agent is working, and it
    // waits there beside what a person said. Neither the turn it lands in nor
    // the shape it lands in makes it somebody talking.
    if attachment
        .mode
        .as_ref()
        .is_some_and(|mode| mode.says(TASK_NOTIFICATION))
    {
        return None;
    }
    let said = prompt_content(&Message {
        id: None,
        content: attachment.prompt.clone(),
    });
    said.iter()
        .any(is_worth_showing)
        .then(|| (attachment.sent_as().unwrap_or(anchor), said))
}

/// Whether one part of a message puts anything on the screen.
fn is_worth_showing(part: &CaffoldContent) -> bool {
    match part {
        CaffoldContent::Text { text } => !text.trim().is_empty(),
        CaffoldContent::Image { .. } | CaffoldContent::LocalImage { .. } => true,
    }
}

/// Write a conversation where the agent would have written it.
///
/// Here rather than in the caller because where a conversation lives is this
/// module's to know, and a test that worked it out for itself would be
/// asserting against its own copy of the rule.
#[cfg(test)]
pub(super) fn plant(projects: &Path, cwd: &str, session_id: &str, contents: &str) {
    let project = projects.join(project_directory(cwd));
    std::fs::create_dir_all(&project).expect("the project directory");
    std::fs::write(project.join(format!("{session_id}.jsonl")), contents)
        .expect("the conversation");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{CommandExecution, ItemKind, TurnOrigin, TurnStatus};

    /// Measured against CLI 2.1.236: `/Users/x/a_b.c d` is filed as
    /// `-Users-x-a-b-c-d`.
    #[test]
    fn a_working_directory_is_filed_under_a_name_with_no_punctuation_left() {
        assert_eq!(
            project_directory("/Users/taehoon/Workspace/rust/codger/.claude/worktrees/gentle-fox"),
            "-Users-taehoon-Workspace-rust-codger--claude-worktrees-gentle-fox"
        );
        assert_eq!(
            project_directory("/tmp/a_b.c d-e+f@g~h(i)"),
            "-tmp-a-b-c-d-e-f-g-h-i-"
        );
    }

    fn line(row: serde_json::Value) -> String {
        row.to_string()
    }

    /// Every turn a written-down conversation holds, for a test that wants all
    /// of them rather than a page.
    fn all_turns(contents: &str) -> (Vec<Turn>, usize) {
        let parsed = turns(&contents.lines().collect::<Vec<_>>());
        (parsed.turns, parsed.unreadable)
    }

    fn background_tasks(contents: &str) -> Vec<BackgroundTaskObservation> {
        turns(&contents.lines().collect::<Vec<_>>()).background_tasks
    }

    /// The turns of a conversation, for a test with nothing to say about what
    /// could not be read.
    fn read_turns(contents: &str) -> Vec<Turn> {
        let (turns, unreadable) = all_turns(contents);
        assert_eq!(unreadable, 0, "every line was expected to be readable");
        turns
    }

    fn conversation() -> String {
        [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "timestamp": "2026-08-20T10:00:00.000Z",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "first"},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "answer-1",
                "timestamp": "2026-08-20T10:00:01.000Z",
                "message": {
                    "role": "assistant",
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "one"}],
                },
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-2",
                "timestamp": "2026-08-20T10:01:00.000Z",
                "promptSource": "typed",
                "message": {"role": "user", "content": [{"type": "text", "text": "second"}]},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "answer-2",
                "timestamp": "2026-08-20T10:01:01.000Z",
                "message": {
                    "role": "assistant",
                    "id": "msg_2",
                    "content": [{"type": "text", "text": "two"}],
                },
            })),
        ]
        .join("\n")
    }

    #[test]
    fn a_turn_is_a_prompt_and_everything_that_followed_it() {
        let turns = read_turns(&conversation());

        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].id, "prompt-1");
        assert_eq!(turns[0].items.len(), 2);
        assert!(matches!(
            &turns[0].items[0].kind,
            ItemKind::UserMessage { text, .. } if text == "first"
        ));
        assert!(matches!(
            &turns[0].items[1].kind,
            ItemKind::AssistantMessage { text, .. } if text == "one"
        ));
        assert_eq!(turns[0].started_at_ms, Some(1_787_220_000_000));
        assert_eq!(turns[0].completed_at_ms, Some(1_787_220_001_000));
        assert_eq!(turns[0].items[0].observed_at_ms, Some(1_787_220_000_000));
        assert_eq!(turns[0].items[1].observed_at_ms, Some(1_787_220_001_000));
        assert_eq!(turns[1].id, "prompt-2");
    }

    #[test]
    fn a_prompt_is_the_one_user_message_that_says_where_it_came_from() {
        // A tool's answer arrives as a user message too, and reading one as a
        // prompt would split a turn in half at every tool call.
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "call-1",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {}}],
                },
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "result-1",
                "toolUseResult": {"stdout": ""},
                "message": {
                    "role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok"}],
                },
            })),
        ]
        .join("\n");

        let turns = read_turns(&contents);

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].id, "prompt-1");
    }

    #[test]
    fn a_subagents_own_conversation_is_not_this_one() {
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "sidechain-prompt",
                "promptSource": "sdk",
                "isSidechain": true,
                "message": {"role": "user", "content": "look at this"},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "sidechain-answer",
                "isSidechain": true,
                "message": {"role": "assistant", "content": [{"type": "text", "text": "hidden"}]},
            })),
        ]
        .join("\n");

        let turns = read_turns(&contents);

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].items.len(), 1);
    }

    #[test]
    fn a_queued_command_with_nothing_in_it_is_not_shown_as_something_said() {
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-1",
                "attachment": {
                    "type": "queued_command",
                    "prompt": [{"type": "text", "text": "   "}],
                },
            })),
        ]
        .join("\n");

        let turns = read_turns(&contents);

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].items.len(), 1, "{:?}", items_of(&turns[0]));
    }

    #[test]
    fn a_steered_message_is_known_by_the_name_the_host_sent_it_under() {
        // The queued command's row is named by Claude; `source_uuid` is the
        // name the host sent the message under, which is what the live reader
        // holds the same message by. A row without one keeps its own name.
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-1",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": "prompt",
                    "prompt": [{"type": "text", "text": "stop reading"}],
                    "source_uuid": "sent-as-1",
                },
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-2",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": "prompt",
                    "prompt": [{"type": "text", "text": "and then"}],
                },
            })),
        ]
        .join("\n");

        let turns = read_turns(&contents);

        let ids: Vec<&str> = turns[0].items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(
            ids,
            ["prompt-1:prompt", "sent-as-1:steer", "queued-2:steer"]
        );
    }

    /// What the agent writes into a conversation when a background command it
    /// started has finished.
    fn a_report(task: &str) -> String {
        format!(
            "<task-notification>\n<task-id>{task}</task-id>\n\
             <tool-use-id>toolu_1</tool-use-id>\n\
             <output-file>/tmp/claude/{task}.output</output-file>\n\
             <status>completed</status>\n\
             <summary>Background command \"Build the app\" completed (exit code 0)</summary>\n\
             </task-notification>"
        )
    }

    /// Everything somebody said in a turn, in the order they said it.
    fn said_in(turn: &Turn) -> Vec<&str> {
        turn.items
            .iter()
            .filter_map(|item| match &item.kind {
                ItemKind::UserMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    fn a_conversation_a_background_command_reported_into() -> String {
        [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "timestamp": "2026-08-23T06:20:00.000Z",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "build the app in the background"},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "answer-1",
                "timestamp": "2026-08-23T06:20:01.000Z",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "started"}]},
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "report-1",
                "timestamp": "2026-08-23T06:25:55.000Z",
                "promptSource": "sdk",
                "origin": {"kind": "task-notification"},
                "message": {"role": "user", "content": a_report("bgxe14776")},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "answer-2",
                "timestamp": "2026-08-23T06:25:57.000Z",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "the build is done"}]},
            })),
        ]
        .join("\n")
    }

    #[test]
    fn a_background_command_reporting_back_is_not_shown_as_something_somebody_said() {
        let turns = read_turns(&a_conversation_a_background_command_reported_into());

        assert_eq!(
            turns.len(),
            2,
            "the report opens a turn, because the agent's answer to it is work \
             that has to belong somewhere: {:?}",
            turns.iter().map(|turn| &turn.id).collect::<Vec<_>>()
        );
        let reported = &turns[1];
        let TurnOrigin::BackgroundTask(background) = &reported.origin else {
            panic!(
                "the marked report is a background turn: {:?}",
                reported.origin
            );
        };
        assert_eq!(background.task_id.as_deref(), Some("bgxe14776"));
        assert_eq!(background.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(background.status.as_deref(), Some("completed"));
        assert_eq!(
            background.output_file.as_deref(),
            Some("/tmp/claude/bgxe14776.output")
        );
        assert_eq!(
            background.summary.as_deref(),
            Some("Background command \"Build the app\" completed (exit code 0)")
        );
        let raw = a_report("bgxe14776");
        assert_eq!(background.raw.as_deref(), Some(raw.as_str()));
        assert_eq!(said_in(reported), Vec::<&str>::new(), "nobody said it");
        assert!(
            reported.items.iter().any(|item| matches!(
                &item.kind,
                ItemKind::AssistantMessage { text, .. } if text == "the build is done"
            )),
            "the work the agent did about it is the turn: {:?}",
            items_of(reported)
        );
    }

    #[test]
    fn a_prompt_that_says_nothing_about_where_it_came_from_is_somebody_talking() {
        // Every prompt Caffold sends is one of these. The agent marks a report
        // and marks what a person typed, and marks nothing on what arrives over
        // the SDK — so a reader that asked for the mark instead of asking for
        // the report would hand back a conversation with nobody in it.
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "what Caffold sent"},
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-2",
                "promptSource": "typed",
                "origin": {"kind": "human"},
                "message": {"role": "user", "content": "what somebody typed"},
            })),
        ]
        .join("\n");

        let turns = read_turns(&contents);

        assert_eq!(turns.len(), 2, "both opened a turn");
        assert_eq!(turns[0].origin, TurnOrigin::User);
        assert_eq!(turns[1].origin, TurnOrigin::User);
        assert_eq!(said_in(&turns[0]), ["what Caffold sent"]);
        assert_eq!(said_in(&turns[1]), ["what somebody typed"]);
    }

    #[test]
    fn a_prompt_that_only_reads_like_a_report_is_still_somebody_talking() {
        // What makes a report a report is the agent marking it as one, not the
        // words in it. Somebody who pastes one in to ask about it has said
        // something, and a reader that went looking for the words instead
        // would take their message out of their own conversation.
        let contents = line(serde_json::json!({
            "type": "user",
            "uuid": "prompt-1",
            "promptSource": "sdk",
            "message": {"role": "user", "content": a_report("bgxe14776")},
        }));

        let turns = read_turns(&contents);

        assert_eq!(turns[0].origin, TurnOrigin::User);
        assert_eq!(said_in(&turns[0]).len(), 1, "{:?}", items_of(&turns[0]));
    }

    #[test]
    fn a_report_queued_while_the_agent_worked_is_not_shown_beside_what_was_said() {
        // Both wait in the same queue and both are filed as queued commands.
        // What tells them apart is the mode they were queued under.
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptId": "provider-prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-1",
                "promptId": "provider-prompt-1",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": "task-notification",
                    "prompt": a_report("b579lzr25"),
                    "timestamp": "2026-08-23T06:25:55.000Z",
                },
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-2",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": "prompt",
                    "prompt": [{"type": "text", "text": "stop reading"}],
                },
            })),
        ]
        .join("\n");

        let turns = read_turns(&contents);
        let observations = background_tasks(&contents);

        assert_eq!(turns.len(), 1);
        assert_eq!(said_in(&turns[0]), ["go", "stop reading"]);
        assert_eq!(observations.len(), 1);
        assert_eq!(observations[0].task.task_id.as_deref(), Some("b579lzr25"));
        assert_eq!(observations[0].task.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(observations[0].at_ms, Some(1_787_466_355_000));
        assert_eq!(
            observations[0].delivery,
            BackgroundTaskDelivery::Queued {
                turn_id: Some("prompt-1".to_string())
            }
        );
    }

    #[test]
    fn a_queued_report_without_an_exact_prompt_link_is_not_assigned_by_position() {
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-1",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": "task-notification",
                    "prompt": a_report("b579lzr25"),
                },
            })),
        ]
        .join("\n");

        let observations = background_tasks(&contents);

        assert_eq!(observations.len(), 1);
        assert_eq!(
            observations[0].delivery,
            BackgroundTaskDelivery::Queued { turn_id: None },
            "chronological proximity is not a causal link"
        );
    }

    #[test]
    fn a_new_prompt_does_not_inherit_the_previous_prompts_identity() {
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptId": "provider-prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "first"},
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-2",
                "parentUuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "second"},
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-1",
                "parentUuid": "prompt-2",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": "task-notification",
                    "prompt": a_report("b579lzr25"),
                },
            })),
        ]
        .join("\n");

        let observations = background_tasks(&contents);

        assert_eq!(observations.len(), 1);
        assert_eq!(
            observations[0].delivery,
            BackgroundTaskDelivery::Queued { turn_id: None },
            "a parent row cannot carry an old prompt identity across a new prompt"
        );
    }

    #[test]
    fn conflicting_prompt_links_are_not_resolved_by_preference() {
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptId": "provider-prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "first"},
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-2",
                "promptId": "provider-prompt-2",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "second"},
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-1",
                "parentUuid": "prompt-1",
                "promptId": "provider-prompt-2",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": "task-notification",
                    "prompt": a_report("b579lzr25"),
                },
            })),
        ]
        .join("\n");

        let observations = background_tasks(&contents);

        assert_eq!(observations.len(), 1);
        assert_eq!(
            observations[0].delivery,
            BackgroundTaskDelivery::Queued { turn_id: None },
            "neither explicit link wins when they disagree"
        );
    }

    #[test]
    fn unreadable_link_metadata_costs_only_the_link() {
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptId": 42,
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-1",
                "parentUuid": {"future": "shape"},
                "timestamp": "2026-08-23T06:25:55.000Z",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": "task-notification",
                    "prompt": a_report("b579lzr25"),
                    "timestamp": 42,
                },
            })),
        ]
        .join("\n");

        let parsed = turns(&contents.lines().collect::<Vec<_>>());

        assert_eq!(parsed.unreadable, 0, "both rows survive");
        assert_eq!(said_in(&parsed.turns[0]), ["go"]);
        assert_eq!(
            parsed.background_tasks.len(),
            1,
            "the marked report survives"
        );
        assert_eq!(
            parsed.background_tasks[0].delivery,
            BackgroundTaskDelivery::Queued { turn_id: None }
        );
        assert_eq!(
            parsed.background_tasks[0].at_ms,
            Some(1_787_466_355_000),
            "the valid row timestamp remains usable"
        );
    }

    #[test]
    fn an_explicit_report_with_an_unreadable_body_stays_agent_owned_and_raw_unknown() {
        let contents = line(serde_json::json!({
            "type": "user",
            "uuid": "report-1",
            "promptSource": "sdk",
            "origin": {"kind": "task-notification"},
            "message": {"role": "user", "content": [
                {"type": "text", "text": "first"},
                {"type": "text", "text": "second"},
            ]},
        }));

        let turns = read_turns(&contents);

        let TurnOrigin::BackgroundTask(task) = &turns[0].origin else {
            panic!(
                "the structured outer mark is still evidence: {:?}",
                turns[0].origin
            );
        };
        assert_eq!(task, &BackgroundTask::default());
        assert_eq!(said_in(&turns[0]), Vec::<&str>::new());
    }

    #[test]
    fn duplicate_report_tags_make_only_that_field_unknown() {
        let raw = concat!(
            "<task-notification>\n",
            "<task-id>task-1</task-id>\n",
            "<tool-use-id>toolu_1</tool-use-id>\n",
            "<tool-use-id>toolu_2</tool-use-id>\n",
            "<status>completed</status>\n",
            "</task-notification>"
        );
        let contents = line(serde_json::json!({
            "type": "user",
            "uuid": "report-1",
            "promptSource": "sdk",
            "origin": {"kind": "task-notification"},
            "message": {"role": "user", "content": raw},
        }));

        let turns = read_turns(&contents);

        let TurnOrigin::BackgroundTask(task) = &turns[0].origin else {
            panic!("the report remains typed: {:?}", turns[0].origin);
        };
        assert_eq!(task.task_id.as_deref(), Some("task-1"));
        assert_eq!(task.tool_use_id, None, "an ambiguous id is not selected");
        assert_eq!(task.status.as_deref(), Some("completed"));
        assert_eq!(task.raw.as_deref(), Some(raw));
    }

    fn a_background_command_followed_by(report: String, started_task_id: &str) -> String {
        [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "call-1",
                "message": {"role": "assistant", "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Bash",
                    "input": {"command": "sleep 1", "run_in_background": true},
                }]},
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "result-1",
                "toolUseResult": {"backgroundTaskId": started_task_id},
                "message": {"role": "user", "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "running",
                }]},
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "report-1",
                "promptSource": "sdk",
                "origin": {"kind": "task-notification"},
                "message": {"role": "user", "content": report},
            })),
        ]
        .join("\n")
    }

    fn command_in(turn: &Turn) -> &CommandExecution {
        turn.items
            .iter()
            .find_map(|item| match &item.kind {
                ItemKind::CommandExecution(command) => Some(command),
                _ => None,
            })
            .expect("the turn has a command")
    }

    #[test]
    fn a_report_enriches_the_command_named_by_both_exact_ids() {
        let raw = a_report("task-1");
        let turns = read_turns(&a_background_command_followed_by(raw.clone(), "task-1"));

        let task = command_in(&turns[0])
            .background_task
            .as_ref()
            .expect("the command carries its background evidence");
        assert_eq!(task.task_id.as_deref(), Some("task-1"));
        assert_eq!(task.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(task.status.as_deref(), Some("completed"));
        assert_eq!(task.raw.as_deref(), Some(raw.as_str()));
    }

    #[test]
    fn a_report_with_a_conflicting_task_id_is_preserved_but_not_linked() {
        let raw = a_report("reported-task");
        let turns = read_turns(&a_background_command_followed_by(
            raw.clone(),
            "started-task",
        ));

        let command_task = command_in(&turns[0])
            .background_task
            .as_ref()
            .expect("the tool result identified the background task");
        assert_eq!(command_task.task_id.as_deref(), Some("started-task"));
        assert_eq!(command_task.tool_use_id.as_deref(), Some("toolu_1"));
        assert_eq!(
            command_task.status, None,
            "the conflicting report was not overlaid"
        );
        assert_eq!(command_task.raw, None);

        let TurnOrigin::BackgroundTask(reported) = &turns[1].origin else {
            panic!(
                "the unlinked report is still preserved: {:?}",
                turns[1].origin
            );
        };
        assert_eq!(reported.task_id.as_deref(), Some("reported-task"));
        assert_eq!(reported.raw.as_deref(), Some(raw.as_str()));
    }

    #[test]
    fn a_marking_in_a_shape_this_release_cannot_read_costs_the_marking_and_not_the_message() {
        // What the agent marks its own prompts with is the agent's to change.
        // A release that writes a marking differently should cost Caffold the
        // ability to tell a report apart — not the prompts around it, which is
        // what refusing the row would take.
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "origin": "human",
                "message": {"role": "user", "content": "still what somebody said"},
            })),
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-2",
                "promptSource": "sdk",
                "origin": {"kind": 42},
                "message": {"role": "user", "content": "and so is this"},
            })),
            line(serde_json::json!({
                "type": "attachment",
                "uuid": "queued-1",
                "attachment": {
                    "type": "queued_command",
                    "commandMode": {"written": "as an object"},
                    "prompt": [{"type": "text", "text": "and this"}],
                },
            })),
        ]
        .join("\n");

        let (turns, unreadable) = all_turns(&contents);

        assert_eq!(unreadable, 0, "no line was lost to a marking");
        assert_eq!(turns[0].origin, TurnOrigin::Unknown);
        assert_eq!(turns[1].origin, TurnOrigin::Unknown);
        assert_eq!(said_in(&turns[0]), ["still what somebody said"]);
        assert_eq!(said_in(&turns[1]), ["and so is this", "and this"]);
    }

    #[test]
    fn a_message_whose_body_cannot_be_read_is_counted_as_missing() {
        // The line reads and the body does not, which is a message gone from a
        // conversation that would otherwise be handed over as whole.
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "answer-1",
                "message": {"role": "assistant", "content": 42},
            })),
        ]
        .join("\n");

        let (turns, unreadable) = all_turns(&contents);

        assert_eq!(turns.len(), 1);
        assert_eq!(unreadable, 1);
    }

    #[test]
    fn a_picture_the_agent_only_points_at_costs_the_picture_and_not_the_words() {
        // The agent may say where a picture is in ways this release has never
        // seen. Losing the words around it would be losing the conversation.
        let contents = line(serde_json::json!({
            "type": "user",
            "uuid": "prompt-1",
            "promptSource": "sdk",
            "message": {"role": "user", "content": [
                {"type": "text", "text": "look at this"},
                {"type": "image", "source": {"type": "url", "url": "https://x/y.png"}},
            ]},
        }));

        let (turns, unreadable) = all_turns(&contents);

        assert_eq!(unreadable, 0, "the message was read");
        assert_eq!(turns.len(), 1);
        let ItemKind::UserMessage { text, content } = &turns[0].items[0].kind else {
            panic!("the prompt survived: {:?}", items_of(&turns[0]));
        };
        assert_eq!(text, "look at this");
        assert_eq!(content.len(), 1, "the words, and no picture: {content:?}");
    }

    #[test]
    fn a_line_that_cannot_be_read_costs_one_message_and_not_the_conversation() {
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "go"},
            })),
            "{ this is not json".to_string(),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "answer-1",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]},
            })),
        ]
        .join("\n");

        let (turns, unreadable) = all_turns(&contents);

        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].items.len(), 2);
        // Counted, so that a conversation with a message missing from it is
        // never handed over as a whole one.
        assert_eq!(unreadable, 1);
    }

    /// One page according to the previous full-file reader.
    ///
    /// Kept only as a differential oracle for the bounded file reader. Its raw
    /// turn-id continuation is deliberately not the production cursor.
    fn page_of(contents: &str, before: Option<&str>, limit: usize) -> TurnPage {
        let lines: Vec<&str> = contents.lines().collect();
        let window = window(&lines, before, limit).expect("the window is found");
        let parsed = turns(&lines[window.lines]);
        assert_eq!(
            parsed.unreadable, 0,
            "every line was expected to be readable"
        );
        TurnPage {
            turns: parsed.turns.into_iter().rev().collect(),
            next_cursor: window.older,
            backwards_cursor: None,
        }
    }

    fn reference_reading(contents: &str, before: Option<&str>, limit: usize) -> Reading {
        let lines = contents.lines().collect::<Vec<_>>();
        let Some(window) = window(&lines, before, limit) else {
            return Reading::default();
        };
        let parsed = turns(&lines[window.lines]);
        Reading {
            page: TurnPage {
                turns: parsed.turns.into_iter().rev().collect(),
                next_cursor: window.older,
                backwards_cursor: None,
            },
            background_tasks: parsed.background_tasks,
            unreadable: parsed.unreadable,
        }
    }

    fn assert_file_pages_match_reference(contents: &str, limit: usize) {
        let (_root, path) = written(contents);
        let mut reference_cursor = None;
        let mut file_cursor = None;
        let mut page_number = 0;
        loop {
            page_number += 1;
            let expected = reference_reading(contents, reference_cursor.as_deref(), limit);
            let actual = read_page(&path, file_cursor.as_deref(), limit);
            assert_eq!(
                actual.page.turns, expected.page.turns,
                "turns differ on page {page_number} at limit {limit}"
            );
            assert_eq!(
                actual.background_tasks, expected.background_tasks,
                "background observations differ on page {page_number} at limit {limit}"
            );
            assert_eq!(
                actual.unreadable, expected.unreadable,
                "unreadable rows differ on page {page_number} at limit {limit}"
            );
            assert_eq!(
                actual.page.next_cursor.is_some(),
                expected.page.next_cursor.is_some(),
                "continuation differs on page {page_number} at limit {limit}"
            );
            assert_eq!(actual.page.backwards_cursor, None);
            let Some(next_reference) = expected.page.next_cursor else {
                break;
            };
            reference_cursor = Some(next_reference);
            file_cursor = actual.page.next_cursor;
            assert!(page_number < 100, "pagination must make progress");
        }
    }

    fn ids(page: &TurnPage) -> Vec<&str> {
        page.turns.iter().map(|turn| turn.id.as_str()).collect()
    }

    #[test]
    fn a_page_is_the_newest_turns_and_a_cursor_to_the_rest() {
        let newest = page_of(&conversation(), None, 1);

        assert_eq!(ids(&newest), ["prompt-2"]);
        assert_eq!(newest.next_cursor.as_deref(), Some("prompt-2"));

        let older = page_of(&conversation(), newest.next_cursor.as_deref(), 8);

        assert_eq!(ids(&older), ["prompt-1"]);
        assert_eq!(older.next_cursor, None);
    }

    #[test]
    fn only_the_turns_of_a_page_are_read_at_all() {
        // The whole point of finding the window first: a page of one turn must
        // not cost the work of building the turn before it.
        let contents = conversation();
        let lines: Vec<&str> = contents.lines().collect();
        let window = window(&lines, None, 1).expect("the window is found");

        let parsed = turns(&lines[window.lines.clone()]);
        assert_eq!(parsed.turns.len(), 1);
        assert!(
            !lines[window.lines]
                .iter()
                .any(|line| line.contains("first")),
            "the older turn's lines are outside the window"
        );
    }

    #[test]
    fn asking_for_more_than_there_is_asks_for_nothing_further() {
        let page = page_of(&conversation(), None, 8);

        assert_eq!(page.turns.len(), 2);
        assert_eq!(page.next_cursor, None);
        // Newest first, which is the order history is read in.
        assert_eq!(page.turns[0].id, "prompt-2");
    }

    #[test]
    fn a_turn_a_background_command_opened_is_a_turn_a_page_begins_at() {
        // Both readers have to agree on what opens a turn: one finds the lines
        // a page is made of, the other builds the turns from those lines, and a
        // line that opens a turn for only one of them leaves a page starting on
        // work with no turn to belong to and a cursor naming a turn nobody can
        // find.
        let contents = a_conversation_a_background_command_reported_into();

        let newest = page_of(&contents, None, 1);

        assert_eq!(ids(&newest), ["report-1"]);
        assert_eq!(said_in(&newest.turns[0]), Vec::<&str>::new());
        assert_eq!(newest.next_cursor.as_deref(), Some("report-1"));

        let older = page_of(&contents, newest.next_cursor.as_deref(), 8);

        assert_eq!(ids(&older), ["prompt-1"]);
        assert_eq!(
            said_in(&older.turns[0]),
            ["build the app in the background"]
        );
    }

    #[test]
    fn bounded_file_pages_match_the_previous_reader_on_every_recorded_transcript() {
        for contents in [
            RECORDED,
            RECORDED_WITH_A_COMMAND,
            RECORDED_WITH_A_BACKGROUND_COMMAND,
            RECORDED_WITH_A_PICTURE,
        ] {
            for limit in [1, 2, 8] {
                assert_file_pages_match_reference(contents, limit);
            }
        }
    }

    #[test]
    fn a_malformed_row_is_counted_only_when_its_turn_is_selected() {
        let contents = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-1",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "first"},
            })),
            "{ this completed row is not json".to_string(),
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-2",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "second"},
            })),
        ]
        .join("\n");
        let (_root, path) = written(&contents);

        let newest = read_page(&path, None, 1);

        assert_eq!(ids(&newest.page), ["prompt-2"]);
        assert_eq!(newest.unreadable, 0);

        let older = read_page(&path, newest.page.next_cursor.as_deref(), 1);

        assert_eq!(ids(&older.page), ["prompt-1"]);
        assert_eq!(older.unreadable, 1);
    }

    #[test]
    fn history_read_from_the_file_is_history_that_finished() {
        let page = page_of(&conversation(), None, 8);

        assert!(
            page.turns
                .iter()
                .all(|turn| turn.status == TurnStatus::Completed)
        );
    }

    #[test]
    fn a_name_that_is_not_a_name_locates_nothing() {
        // What is on the other side of `locate` removes a directory and
        // everything under it, so every one of these once resolved somewhere
        // it had no business removing: `.` and `..` to the directory holding
        // every project, `../..` to the agent's whole home, an absolute one to
        // wherever it pointed.
        let projects = Path::new("/home/somebody/.claude/projects");
        for named in [".", "..", "../..", "/etc/passwd", "", "a/b", "a\\b", "id.1"] {
            assert_eq!(
                locate(projects, "/tmp/project", named),
                None,
                "{named:?} does not name one conversation"
            );
        }
        assert!(
            locate(
                projects,
                "/tmp/project",
                "069e211f-802d-4c1e-bf64-799ae77084a8"
            )
            .is_some()
        );
    }

    #[test]
    fn erasing_a_conversation_takes_the_file_and_what_was_filed_with_it() {
        let root = tempfile::tempdir().unwrap();
        let written = root.path().join("a-session.jsonl");
        let beside = root.path().join("a-session");
        std::fs::write(&written, "{}\n").unwrap();
        std::fs::create_dir_all(beside.join("subagents")).unwrap();
        std::fs::write(beside.join("subagents/agent-1.jsonl"), "{}\n").unwrap();
        let kept = root.path().join("another-session.jsonl");
        std::fs::write(&kept, "{}\n").unwrap();

        erase(&written).expect("the conversation is erased");

        assert!(!written.exists());
        assert!(!beside.exists());
        assert!(kept.exists(), "only the conversation named was erased");
    }

    #[test]
    fn erasing_a_conversation_that_is_already_gone_is_what_was_asked_for() {
        let root = tempfile::tempdir().unwrap();

        erase(&root.path().join("never-written.jsonl")).expect("gone is the outcome asked for");
    }

    #[test]
    fn a_session_with_nothing_written_for_it_reads_as_no_history() {
        let reading = read(Path::new("/nonexistent/never-written.jsonl"), None, 8)
            .expect("a transcript the agent has not started is empty");

        assert_eq!(reading, Reading::default());
    }

    fn written(contents: &str) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().expect("a transcript directory");
        let path = root.path().join("session.jsonl");
        std::fs::write(&path, contents).expect("the transcript fixture");
        (root, path)
    }

    fn read_page(path: &Path, before: Option<&str>, limit: usize) -> Reading {
        read(path, before, limit).expect("the transcript page is readable")
    }

    #[test]
    fn a_file_page_continues_from_an_opaque_cursor() {
        let (_root, path) = written(&conversation());

        let newest = read_page(&path, None, 1);

        assert_eq!(ids(&newest.page), ["prompt-2"]);
        let cursor = newest.page.next_cursor.expect("there is an older turn");
        assert_ne!(cursor, "prompt-2", "the cursor is not a turn-id guess");

        let older = read_page(&path, Some(&cursor), 8);

        assert_eq!(ids(&older.page), ["prompt-1"]);
        assert_eq!(older.page.next_cursor, None);
    }

    #[test]
    fn a_cursor_keeps_its_boundary_when_new_rows_are_appended() {
        let (_root, path) = written(&conversation());
        let cursor = read_page(&path, None, 1)
            .page
            .next_cursor
            .expect("there is an older turn");
        let third = [
            line(serde_json::json!({
                "type": "user",
                "uuid": "prompt-3",
                "promptSource": "sdk",
                "message": {"role": "user", "content": "third"},
            })),
            line(serde_json::json!({
                "type": "assistant",
                "uuid": "answer-3",
                "message": {"role": "assistant", "content": [{"type": "text", "text": "three"}]},
            })),
        ]
        .join("\n");
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("the transcript reopens");
        write!(file, "\n{third}").expect("the agent appends another turn");

        let older = read_page(&path, Some(&cursor), 8);

        assert_eq!(ids(&older.page), ["prompt-1"]);
        assert_eq!(older.page.next_cursor, None);
    }

    #[test]
    fn an_incomplete_last_row_waits_until_it_is_complete() {
        let incomplete = format!(
            "{}\n{{\"type\":\"user\",\"uuid\":\"prompt-3\"",
            conversation()
        );
        let (_root, path) = written(&incomplete);

        let before = read_page(&path, None, 1);

        assert_eq!(ids(&before.page), ["prompt-2"]);
        assert_eq!(before.unreadable, 0, "a partial write is not a bad row");

        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("the transcript reopens");
        writeln!(
            file,
            ",\"promptSource\":\"sdk\",\"message\":{{\"role\":\"user\",\"content\":\"third\"}}}}"
        )
        .expect("the agent completes the row");

        let after = read_page(&path, None, 1);

        assert_eq!(ids(&after.page), ["prompt-3"]);
        assert_eq!(after.unreadable, 0);
    }

    #[test]
    fn a_last_row_split_inside_utf8_waits_for_the_rest_of_the_codepoint() {
        let root = tempfile::tempdir().expect("a transcript directory");
        let path = root.path().join("session.jsonl");
        let mut incomplete = format!(
            "{}\n{{\"type\":\"assistant\",\"uuid\":\"answer-3\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"",
            conversation()
        )
        .into_bytes();
        let thread = "🧵".as_bytes();
        incomplete.extend_from_slice(&thread[..2]);
        std::fs::write(&path, incomplete).expect("the partial UTF-8 row");

        let before = read_page(&path, None, 1);

        assert_eq!(ids(&before.page), ["prompt-2"]);
        assert!(before.page.turns[0].items.iter().all(|item| {
            !matches!(&item.kind, ItemKind::AssistantMessage { text, .. } if text == "🧵")
        }));

        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("the transcript reopens");
        file.write_all(&thread[2..])
            .expect("the rest of the codepoint");
        file.write_all(b"\"}]}}\n")
            .expect("the rest of the JSON row");

        let after = read_page(&path, None, 1);

        assert!(after.page.turns[0].items.iter().any(|item| {
            matches!(&item.kind, ItemKind::AssistantMessage { text, .. } if text == "🧵")
        }));
    }

    #[test]
    fn invalid_utf8_in_a_completed_selected_row_is_a_source_error() {
        let root = tempfile::tempdir().expect("a transcript directory");
        let path = root.path().join("session.jsonl");
        let mut contents = conversation().into_bytes();
        contents.extend_from_slice(b"\n{\"type\":\"assistant\",\"uuid\":\"bad\",\"message\":\"");
        contents.push(0xff);
        contents.extend_from_slice(b"\"}\n");
        std::fs::write(&path, contents).expect("the invalid UTF-8 fixture");

        let error = read(&path, None, 1).expect_err("the selected bytes cannot be decoded");

        assert!(matches!(error, ReadError::InvalidUtf8(_)));
    }

    #[test]
    fn a_cursor_that_is_not_one_this_reader_issued_is_an_error() {
        let (_root, path) = written(&conversation());

        let error = read(&path, Some("prompt-never-written"), 8)
            .expect_err("an unverified boundary must not mean exhausted history");

        assert!(matches!(error, ReadError::InvalidCursor(_)));
    }

    #[test]
    fn an_unreadable_transcript_is_not_reported_as_empty_history() {
        let root = tempfile::tempdir().expect("a transcript directory");

        let error = read(root.path(), None, 8)
            .expect_err("a source that cannot be read is unavailable, not empty");

        assert!(matches!(error, ReadError::Io(_)));
    }

    /// A session Claude actually ran, kept as it was written.
    ///
    /// Two turns — one that read a file with a tool, one that only answered —
    /// and the second was asked after the session had been resumed, which is
    /// what a Task looks like after Caffold has restarted under it. Only the
    /// rows the reader never looks at were removed, and one of those was kept
    /// so that ignoring them stays tested.
    ///
    /// Hand-written lines prove the reader does what it was written to do. This
    /// proves it does it to what the agent writes, which is a different claim
    /// and the one that breaks when a release changes the file.
    const RECORDED: &str = include_str!("transcript/a-session-claude-wrote.jsonl");

    /// A session with the things Caffold does around a conversation.
    ///
    /// A depth was chosen, which Caffold asks for by having the agent run
    /// `/effort` — a turn of its own that nobody asked for and nobody should
    /// see. Then one turn that read files with a tool and was steered part way
    /// through, which the agent takes at its next tool-call boundary and files
    /// as a queued command rather than as a message.
    const RECORDED_WITH_A_COMMAND: &str =
        include_str!("transcript/a-session-with-a-command-and-a-steer.jsonl");

    /// A session a background command reported into, twice over.
    ///
    /// The first report arrived while the agent was working and waited in the
    /// queue until it stopped; the second arrived while it was idle and went
    /// straight in as a prompt. Both are the agent writing to itself. The two
    /// prompts around them are the ones Caffold sent, which carry no `origin`
    /// at all — so one file holds both what must not be shown and what must not
    /// be hidden along with it.
    const RECORDED_WITH_A_BACKGROUND_COMMAND: &str =
        include_str!("transcript/a-session-a-background-command-reported-into.jsonl");

    /// A session somebody put a picture in.
    ///
    /// A picture travels inside the message rather than beside it, so reading
    /// one back is a matter of undoing what was written to send it. The picture
    /// is a small solid square, because what is being checked is the shape the
    /// agent files it in and not the picture.
    const RECORDED_WITH_A_PICTURE: &str = include_str!("transcript/a-session-with-a-picture.jsonl");

    #[test]
    fn a_session_the_agent_really_wrote_reads_back_as_the_conversation_it_was() {
        let turns = read_turns(RECORDED);

        assert_eq!(turns.len(), 2, "two prompts, two turns");

        let read_a_file = &turns[0];
        assert!(matches!(
            &read_a_file.items[0].kind,
            ItemKind::UserMessage { text, .. } if text.contains("Read notes.txt")
        ));
        // The tool call and its answer are one item, drawn where the call was
        // made rather than where it came back.
        let file_reads = read_a_file
            .items
            .iter()
            .filter(|item| matches!(&item.kind, ItemKind::ToolCall { name, .. } if name == "Read"))
            .count();
        assert_eq!(file_reads, 1, "{:?}", items_of(read_a_file));
        // What the agent wrote in its thinking block on the way to the tool
        // is the agent talking, and it stands before the call it led to.
        let spoke = read_a_file
            .items
            .iter()
            .position(|item| matches!(&item.kind, ItemKind::AssistantMessage { .. }))
            .expect("the agent said something before it acted");
        let read = read_a_file
            .items
            .iter()
            .position(|item| matches!(&item.kind, ItemKind::ToolCall { .. }))
            .expect("the file was read");
        assert!(spoke < read, "{:?}", items_of(read_a_file));
        assert!(
            !read_a_file
                .items
                .iter()
                .any(|item| matches!(&item.kind, ItemKind::Reasoning { .. })),
            "a thinking block with words in it is the agent talking: {:?}",
            items_of(read_a_file)
        );
        assert!(
            read_a_file.items.iter().any(|item| matches!(
                &item.kind,
                ItemKind::AssistantMessage { text, .. } if text.contains("pomegranate")
            )),
            "{:?}",
            items_of(read_a_file)
        );

        // Asked after the session was resumed, and in the same file.
        let answered = &turns[1];
        assert!(matches!(
            &answered.items[0].kind,
            ItemKind::UserMessage { text, .. } if text.contains("backwards")
        ));
        assert!(
            answered
                .items
                .iter()
                .all(|item| !matches!(item.kind, ItemKind::ToolCall { .. })),
            "nothing was asked of a tool"
        );

        assert!(read_a_file.started_at_ms < answered.started_at_ms);
        assert!(read_a_file.completed_at_ms <= answered.started_at_ms);
    }

    #[test]
    fn a_thinking_block_with_nothing_in_it_reads_back_as_reasoning_with_nothing_to_show() {
        // The agent keeps its reasoning to itself and files an empty thinking
        // block where it thought, before the tool it reached for.
        let turns = read_turns(RECORDED_WITH_A_COMMAND);

        let thought = turns[0]
            .items
            .iter()
            .position(|item| matches!(&item.kind, ItemKind::Reasoning { .. }))
            .expect("the agent thought before it acted");
        let read = turns[0]
            .items
            .iter()
            .position(|item| matches!(&item.kind, ItemKind::ToolCall { .. }))
            .expect("a file was read");
        assert!(thought < read, "{:?}", items_of(&turns[0]));
        assert!(matches!(
            &turns[0].items[thought].kind,
            ItemKind::Reasoning { summary, content }
                if summary.is_empty() && content == &[String::new()]
        ));
    }

    #[test]
    fn a_turn_the_harness_failed_reads_back_as_a_failure_rather_than_the_agent_talking() {
        // The rows are a session that really failed this way: the API could
        // not be reached, and the harness wrote its report where an answer
        // would have been — `model: "<synthetic>"`, marked `isApiErrorMessage`.
        let contents = concat!(
            r#"{"type":"user","uuid":"ee4ec2cf-b275-4e9b-9e77-55e061d4c434","timestamp":"2026-08-22T05:35:37.244Z","promptSource":"sdk","message":{"role":"user","content":[{"type":"text","text":"Reply with the single word: ok."}]}}"#,
            "\n",
            r#"{"type":"assistant","uuid":"053eeb53-4162-4d3e-9bda-c0cae21036b3","timestamp":"2026-08-22T05:38:41.431Z","error":"server_error","isApiErrorMessage":true,"message":{"id":"7a308aee-16a8-4321-b39a-a70bb8d6891f","model":"<synthetic>","role":"assistant","content":[{"type":"text","text":"API Error: Connection refused"}]}}"#,
            "\n",
        );

        let turns = read_turns(contents);

        assert_eq!(turns.len(), 1);
        assert!(
            turns[0].items.iter().any(|item| matches!(
                &item.kind,
                ItemKind::Failure { text } if text.starts_with("API Error")
            )),
            "{:?}",
            items_of(&turns[0])
        );
        assert!(
            !turns[0]
                .items
                .iter()
                .any(|item| matches!(item.kind, ItemKind::AssistantMessage { .. })),
            "the harness's report must not read as the agent answering"
        );
    }

    #[test]
    fn what_caffold_asked_for_on_its_own_account_is_nobodys_conversation() {
        let turns = read_turns(RECORDED_WITH_A_COMMAND);

        // The depth change is a turn as far as the agent is concerned, and the
        // caveat and the command it expands are both written down as messages
        // from the user. None of it is anybody's conversation.
        assert_eq!(
            turns.len(),
            1,
            "{:?}",
            turns.iter().map(|t| &t.id).collect::<Vec<_>>()
        );
        let said = turns[0]
            .items
            .iter()
            .filter_map(|item| match &item.kind {
                ItemKind::UserMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(
            said.iter().all(|text| !text.contains("/effort")),
            "{said:?}"
        );
        assert!(
            said.iter()
                .all(|text| !text.contains("local-command-caveat")),
            "{said:?}"
        );
    }

    #[test]
    fn a_message_sent_into_a_running_turn_is_part_of_that_turn() {
        let turns = read_turns(RECORDED_WITH_A_COMMAND);

        let said = turns[0]
            .items
            .iter()
            .filter_map(|item| match &item.kind {
                ItemKind::UserMessage { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(
            said.len(),
            2,
            "the prompt and what was said into it: {said:?}"
        );
        assert!(said[0].contains("Read file0.txt"), "{said:?}");
        assert!(said[1].contains("stop reading"), "{said:?}");
        // It belongs where it was said, after the work that had already run.
        let steer = turns[0]
            .items
            .iter()
            .position(|item| matches!(&item.kind, ItemKind::UserMessage { text, .. } if text.contains("stop reading")))
            .expect("the steer is in the turn");
        assert!(
            turns[0].items[..steer].iter().any(|item| matches!(
                item.kind,
                ItemKind::FileChange { .. } | ItemKind::ToolCall { .. }
            )),
            "{:?}",
            items_of(&turns[0])
        );
    }

    #[test]
    fn a_session_a_background_command_reported_into_shows_the_work_and_not_the_report() {
        let turns = read_turns(RECORDED_WITH_A_BACKGROUND_COMMAND);
        let observations = background_tasks(RECORDED_WITH_A_BACKGROUND_COMMAND);

        assert_eq!(
            turns.len(),
            3,
            "two prompts and the report the agent answered: {:?}",
            turns.iter().map(|turn| &turn.id).collect::<Vec<_>>()
        );
        // What Caffold sent is still what somebody said, and the report that
        // waited in the queue through the first turn is not beside it.
        for asked in &turns[..2] {
            let said = said_in(asked);
            assert_eq!(said.len(), 1, "{said:?}");
            assert!(said[0].contains("run_in_background"), "{said:?}");
        }
        // The report that arrived while the agent was idle opened the last
        // turn, and what is in that turn is what the agent did about it.
        let reported = &turns[2];
        let TurnOrigin::BackgroundTask(report) = &reported.origin else {
            panic!(
                "the recorded mark identifies the source: {:?}",
                reported.origin
            );
        };
        assert_eq!(report.task_id.as_deref(), Some("bogb4v2iq"));
        assert_eq!(
            report.tool_use_id.as_deref(),
            Some("toolu_018MFR3zvEj25sB6Bb92UnRz")
        );
        assert_eq!(report.status.as_deref(), Some("completed"));
        assert_eq!(said_in(reported), Vec::<&str>::new());
        assert!(
            reported.items.iter().any(|item| matches!(
                &item.kind,
                ItemKind::AssistantMessage { text, .. } if text.contains("Background task finished")
            )),
            "{:?}",
            items_of(reported)
        );
        assert!(
            turns
                .iter()
                .flat_map(said_in)
                .all(|said| !said.contains("task-notification")),
            "nothing the agent wrote to itself is in the conversation"
        );

        assert_eq!(observations.len(), 2, "both recorded deliveries survive");
        assert_eq!(
            observations[0].delivery,
            BackgroundTaskDelivery::Queued {
                turn_id: Some(turns[0].id.clone())
            }
        );
        assert_eq!(
            observations[1].delivery,
            BackgroundTaskDelivery::Turn {
                turn_id: turns[2].id.clone()
            }
        );

        let first = command_in(&turns[0])
            .background_task
            .as_ref()
            .expect("the first background command is identified");
        assert_eq!(first.task_id.as_deref(), Some("bag0xyrrb"));
        assert_eq!(first.status.as_deref(), Some("completed"));
        let second = command_in(&turns[1])
            .background_task
            .as_ref()
            .expect("the second background command is identified");
        assert_eq!(second.task_id.as_deref(), Some("bogb4v2iq"));
        assert_eq!(second.status.as_deref(), Some("completed"));
    }

    #[test]
    fn a_picture_somebody_sent_comes_back_as_the_picture_they_sent() {
        let turns = read_turns(RECORDED_WITH_A_PICTURE);

        assert_eq!(turns.len(), 1);
        let ItemKind::UserMessage { text, content } = &turns[0].items[0].kind else {
            panic!(
                "the prompt is what a person said: {:?}",
                items_of(&turns[0])
            );
        };
        // The words are the words, with nothing of the picture folded in.
        assert_eq!(text, "What colour is this square? One word.");
        assert_eq!(content.len(), 2, "{content:?}");
        assert!(matches!(&content[0], CaffoldContent::Text { .. }));
        let CaffoldContent::Image { url } = &content[1] else {
            panic!("the picture is beside the words: {content:?}");
        };
        // A data URL, which is what the browser was handed to begin with.
        assert!(
            url.starts_with("data:image/png;base64,"),
            "{}",
            &url[..40.min(url.len())]
        );
        assert!(
            url.len() > "data:image/png;base64,".len(),
            "the picture has bytes in it"
        );
    }

    fn items_of(turn: &Turn) -> Vec<&ItemKind> {
        turn.items.iter().map(|item| &item.kind).collect()
    }
}
