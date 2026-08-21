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
//! A message sent into a turn already running is not a `user` row at all: it is
//! an attachment the agent files as a queued command, which is why it is read
//! from there.
//!
//! The turns here are finished ones. A turn still running is described by the
//! session running it, which knows what the file cannot say — that the agent is
//! still working, that a tool is waiting on an answer — and which names the
//! turn the same thing this does, so the two are one turn.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::protocol::{Message, MessageContent};
use super::translate::{ToolCalls, message_items, prompt_content, user_message_item};
use crate::agent::{MessageContent as CaffoldContent, Turn, TurnPage, TurnStatus};

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
    #[serde(default)]
    timestamp: Option<String>,
    #[serde(default)]
    message: Option<Message>,
    /// Where a prompt came from — a person typing, an SDK, the agent's own
    /// queue. Present only on a message that is somebody's prompt.
    #[serde(default, rename = "promptSource")]
    prompt_source: Option<String>,
    /// What a tool answered. Present only on a message carrying one.
    #[serde(default, rename = "toolUseResult")]
    tool_use_result: Option<serde::de::IgnoredAny>,
    /// A subagent's own conversation, which belongs to the tool call that
    /// started it rather than to the one a person is reading.
    #[serde(default, rename = "isSidechain")]
    is_sidechain: bool,
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
    /// Lines this release could not read at all.
    ///
    /// Each is a message missing from a conversation shown as though it were
    /// whole, which is the one thing tolerant parsing must not do quietly.
    pub(crate) unreadable: usize,
}

/// Where a turn begins, without reading what it is about.
///
/// Nothing but the file says which lines start turns, so finding the window a
/// page wants means walking every line. This is what is read while doing that:
/// the identity, and deliberately not the message. A `message` field here would
/// have the reader decode every picture in a session to hand back eight turns.
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
/// `before` continues from a cursor an earlier read gave out. A file that is
/// not there is a session the agent has not written anything for yet, which is
/// an empty history rather than a failure — and so is one that cannot be read,
/// because a conversation that will not load is better shown as the turns that
/// did than as an error where the conversation should be.
///
/// Read in two passes. The first finds where the turns begin and reads nothing
/// else; the second reads only the lines of the turns being handed back. One
/// pass would mean building a whole conversation to return the end of it —
/// for a session with pictures in it, most of the file decoded and dropped, and
/// dropped again on every page after the first.
pub(crate) fn read(path: &Path, before: Option<&str>, limit: usize) -> Reading {
    let Ok(contents) = std::fs::read_to_string(path) else {
        return Reading::default();
    };
    let lines: Vec<&str> = contents.lines().collect();
    let Some(window) = window(&lines, before, limit) else {
        return Reading::default();
    };
    let (turns, unreadable) = turns(&lines[window.lines]);
    Reading {
        page: TurnPage {
            // Newest first, which is the order history is read in.
            turns: turns.into_iter().rev().collect(),
            next_cursor: window.older,
            backwards_cursor: None,
        },
        unreadable,
    }
}

/// The lines a page is made of, and where the turns older than it begin.
struct Window {
    lines: std::ops::Range<usize>,
    older: Option<String>,
}

/// Which lines the asked-for turns are written on.
///
/// A turn runs from the line that opens it to the line before the next one, and
/// the last runs to the end of the file — so work the agent did before anyone
/// asked it anything falls outside every window, which is where it belongs.
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

/// Every turn on these lines, oldest first, and how much of them went unread.
fn turns(lines: &[&str]) -> (Vec<Turn>, usize) {
    let mut turns: Vec<Turn> = Vec::new();
    let mut unreadable = 0;
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

        // A message sent into a turn already running, which the agent files
        // beside the conversation rather than in it.
        if let Some(steer) = steered_message(&row) {
            if let Some(turn) = turns.last_mut() {
                turn.items
                    .push(user_message_item(&format!("{anchor}:steer"), steer));
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

        if row.kind == "user" && row.prompt_source.is_some() {
            turns.push(Turn {
                id: anchor.to_string(),
                status: TurnStatus::Completed,
                started_at_ms: at_ms,
                completed_at_ms: at_ms,
                items: vec![user_message_item(
                    &format!("{anchor}:prompt"),
                    prompt_content(message),
                )],
            });
            continue;
        }
        if row.kind == "user" && row.tool_use_result.is_none() {
            // The agent talking to itself: the caveat it writes before running
            // a command, and the command it expands. Reading one as something a
            // person said would put Caffold's own `/effort` in a conversation.
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
        for item in message_items(message, anchor, &mut calls) {
            super::replace_item(&mut turn.items, item);
        }
        if at_ms.is_some() {
            turn.completed_at_ms = at_ms;
        }
    }
    (turns, unreadable)
}

/// What a person said into a turn that was already running, if that is what
/// this row is.
///
/// A queued command with nothing in it to show is passed over rather than
/// shown as an empty thing somebody said. Having parts is not the same as
/// having anything to say: a blank line is one part.
fn steered_message(row: &Row) -> Option<Vec<CaffoldContent>> {
    let attachment = row.attachment.as_ref()?;
    if attachment.kind != "queued_command" {
        return None;
    }
    let said = prompt_content(&Message {
        id: None,
        content: attachment.prompt.clone(),
    });
    said.iter().any(is_worth_showing).then_some(said)
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
    use crate::agent::{ItemKind, TurnStatus};

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
        turns(&contents.lines().collect::<Vec<_>>())
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

    /// One page of a written-down conversation, the way `read` asks for one.
    fn page_of(contents: &str, before: Option<&str>, limit: usize) -> TurnPage {
        let lines: Vec<&str> = contents.lines().collect();
        let window = window(&lines, before, limit).expect("the window is found");
        let (turns, unreadable) = turns(&lines[window.lines]);
        assert_eq!(unreadable, 0, "every line was expected to be readable");
        TurnPage {
            turns: turns.into_iter().rev().collect(),
            next_cursor: window.older,
            backwards_cursor: None,
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

        let (turns, _) = turns(&lines[window.lines.clone()]);
        assert_eq!(turns.len(), 1);
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
    fn a_cursor_that_names_no_turn_here_reads_as_nothing_further() {
        let contents = conversation();
        let lines: Vec<&str> = contents.lines().collect();

        assert!(window(&lines, Some("prompt-never-written"), 8).is_none());
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
        let reading = read(Path::new("/nonexistent/never-written.jsonl"), None, 8);

        assert_eq!(reading, Reading::default());
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
        assert!(
            read_a_file
                .items
                .iter()
                .any(|item| matches!(&item.kind, ItemKind::Reasoning { .. })),
            "the agent thought before it acted"
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
