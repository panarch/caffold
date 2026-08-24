//! Turning what Claude said into what a Task shows.
//!
//! There is one translator because there is one format. A message on the live
//! stream and the same message in the session transcript carry identical
//! content blocks under identical identifiers — the `toolu_…` that starts a
//! tool call while it is watched is the `toolu_…` it is read back under — so a
//! conversation watched live and the same conversation read from disk have to
//! be the same thing said twice, and the only way to guarantee that is for both
//! to come through here.
//!
//! What differs between the two is the envelope around the message, not the
//! message, and that stays with each caller.
//!
//! Only a handful of tools get a surface of their own, and the rule for which
//! is not how common they are but whether Caffold has something to show that a
//! name does not already say: a command has output to read, a file change has
//! paths to open, a plan is prose. Everything else is a
//! [`ItemKind::ToolCall`] under the agent's own name for it, which keeps a tool
//! the agent adds tomorrow rendering as work rather than disappearing.

use std::collections::HashMap;

use serde_json::Value;

use super::protocol::{ContentBlock, ImageSource, Message, MessageContent, image_source};
use crate::agent::{
    ActivityStatus, CommandExecution, ConversationItem, ItemKind, MessageContent as CaffoldContent,
};

/// A tool call the agent has started, kept until its result arrives.
///
/// The result names only the call it answers, so what the call *was* has to be
/// remembered to draw the finished item as the same item that started.
#[derive(Debug, Clone)]
struct StartedToolCall {
    name: String,
    input: Value,
}

/// The tool calls one conversation has open.
///
/// Both readers keep one of these for as long as they are reading: a live
/// session for as long as it runs, a transcript read for the length of the
/// file.
#[derive(Debug, Default)]
pub(crate) struct ToolCalls(HashMap<String, StartedToolCall>);

/// Everything one message contributes to a conversation, in order.
///
/// `anchor` identifies the message itself, and is what the items that are not
/// tool calls are numbered from — the agent identifies a message but not the
/// blocks inside it, and an item needs an identity that survives being reported
/// twice.
pub(crate) fn message_items(
    message: &Message,
    anchor: &str,
    calls: &mut ToolCalls,
    failed_to_run: bool,
) -> Vec<ConversationItem> {
    let blocks = match &message.content {
        MessageContent::Blocks(blocks) => blocks.as_slice(),
        MessageContent::Text(text) => {
            return vec![user_message_item(
                anchor,
                vec![CaffoldContent::Text { text: text.clone() }],
            )];
        }
        MessageContent::Unreadable(_) => return Vec::new(),
    };

    let mut items = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let id = format!("{anchor}:{index}");
        match block {
            ContentBlock::Text { text } => items.push(ConversationItem {
                id,
                status: ActivityStatus::Completed,
                kind: if failed_to_run {
                    // The harness wrote this where an answer would have been.
                    // Drawn as the agent talking, "Failed to authenticate"
                    // reads as its answer to what was asked.
                    ItemKind::Failure { text: text.clone() }
                } else {
                    ItemKind::AssistantMessage {
                        text: text.clone(),
                        // Claude does not mark one message as the answer, and
                        // a guess here would put the wrong message in the
                        // place the interface reserves for one.
                        phase: None,
                    }
                },
            }),
            ContentBlock::Thinking { thinking } => items.push(ConversationItem {
                id,
                status: ActivityStatus::Completed,
                kind: ItemKind::Reasoning {
                    summary: Vec::new(),
                    content: vec![thinking.clone()],
                },
            }),
            ContentBlock::ToolUse { id, name, input } => {
                items.push(calls.start(id, name, input));
            }
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
            } => {
                if let Some(item) = calls.finish(tool_use_id, content, *is_error) {
                    items.push(item);
                }
            }
            // A picture belongs to the message a person wrote, which is read
            // by `prompt_content`, not to the work the agent reports.
            ContentBlock::Image { .. } | ContentBlock::Other => {}
        }
    }
    items
}

/// Everything a person put in a message, out of the message they put it in.
///
/// A picture is carried in the message rather than pointed at, so reading one
/// back is [`super::protocol::user_message`] undone: the media type and the
/// bytes become the data URL the browser was given in the first place.
pub(crate) fn prompt_content(message: &Message) -> Vec<CaffoldContent> {
    match &message.content {
        MessageContent::Text(text) => vec![CaffoldContent::Text { text: text.clone() }],
        MessageContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(CaffoldContent::Text { text: text.clone() }),
                ContentBlock::Image { source } => source
                    .as_ref()
                    .and_then(ImageSource::data_url)
                    .map(|url| CaffoldContent::Image { url }),
                _ => None,
            })
            .collect(),
        MessageContent::Unreadable(_) => Vec::new(),
    }
}

/// What a person said, as the conversation shows it.
///
/// Both readers build a prompt with this, so a prompt watched live and the same
/// prompt read from the transcript are the same item under the same identity —
/// and, since a picture travels in the message, the same pictures.
///
/// The text is what was written and nothing else, because it is what a Task is
/// previewed and searched by; the pictures live beside it in the content.
pub(crate) fn user_message_item(anchor: &str, content: Vec<CaffoldContent>) -> ConversationItem {
    let text = content
        .iter()
        .filter_map(|part| match part {
            CaffoldContent::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    ConversationItem {
        id: anchor.to_string(),
        status: ActivityStatus::Completed,
        kind: ItemKind::UserMessage { text, content },
    }
}

/// What a person said, out of what Caffold was given to send.
///
/// The live reader starts here rather than from a message, because a prompt is
/// drawn before the agent has said anything about it.
///
/// A picture is kept only if it is one the agent can be given, because
/// [`super::protocol::user_message`] decides the same way: drawing one that was
/// never sent would put it in the conversation now and take it out again the
/// moment the conversation is read back from what the agent wrote.
pub(crate) fn prompt_content_of(text: &str, images: &[String]) -> Vec<CaffoldContent> {
    let said = (!text.is_empty()).then(|| CaffoldContent::Text {
        text: text.to_string(),
    });
    said.into_iter()
        .chain(
            images
                .iter()
                .filter(|image| image_source(image).is_some())
                .map(|url| CaffoldContent::Image {
                    url: url.to_string(),
                }),
        )
        .collect()
}

impl ToolCalls {
    /// Draw a call that has just started, and remember what it was.
    fn start(&mut self, id: &str, name: &str, input: &Value) -> ConversationItem {
        self.0.insert(
            id.to_string(),
            StartedToolCall {
                name: name.to_string(),
                input: input.clone(),
            },
        );
        ConversationItem {
            id: id.to_string(),
            status: ActivityStatus::InProgress,
            kind: tool_kind(name, input, None),
        }
    }

    /// Draw the same call again, now that the agent has its result.
    ///
    /// A result for a call this reader never saw start is dropped: without the
    /// call there is no name, no command, and no paths, so an item made from it
    /// would be an outcome attached to nothing.
    fn finish(&mut self, id: &str, content: &Value, is_error: bool) -> Option<ConversationItem> {
        let call = self.0.remove(id)?;
        Some(ConversationItem {
            id: id.to_string(),
            status: if is_error {
                ActivityStatus::Failed
            } else {
                ActivityStatus::Completed
            },
            kind: tool_kind(&call.name, &call.input, Some(content)),
        })
    }

    /// Abandon a call the agent will never answer, so a turn that stopped part
    /// way does not leave an item spinning.
    pub(crate) fn abandon(&mut self, status: ActivityStatus) -> Vec<ConversationItem> {
        let outstanding = std::mem::take(&mut self.0);
        outstanding
            .into_iter()
            .map(|(id, call)| ConversationItem {
                id,
                status,
                kind: tool_kind(&call.name, &call.input, None),
            })
            .collect()
    }
}

/// Which surface draws a tool call, and what that surface needs.
fn tool_kind(name: &str, input: &Value, result: Option<&Value>) -> ItemKind {
    match name {
        "Bash" => ItemKind::CommandExecution(CommandExecution {
            command: string_field(input, "command"),
            cwd: None,
            output: result.and_then(text_of),
            // The agent's shell results carry no exit code, and inventing one
            // would report a success it never claimed.
            exit_code: None,
            duration_ms: None,
            background_task: None,
        }),
        "Write" | "Edit" | "NotebookEdit" => ItemKind::FileChange {
            paths: string_field(input, "file_path")
                .or_else(|| string_field(input, "notebook_path"))
                .into_iter()
                .collect(),
        },
        "TodoWrite" => ItemKind::Plan {
            text: todo_list(input).unwrap_or_default(),
        },
        "ExitPlanMode" => ItemKind::Plan {
            text: string_field(input, "plan").unwrap_or_default(),
        },
        other => ItemKind::ToolCall {
            name: other.to_string(),
        },
    }
}

/// A todo list as the lines a person reads.
fn todo_list(input: &Value) -> Option<String> {
    let todos = input.get("todos")?.as_array()?;
    let lines = todos
        .iter()
        .filter_map(|todo| {
            let content = todo.get("content")?.as_str()?;
            let mark = match todo.get("status").and_then(Value::as_str) {
                Some("completed") => "[x]",
                Some("in_progress") => "[~]",
                _ => "[ ]",
            };
            Some(format!("{mark} {content}"))
        })
        .collect::<Vec<_>>();
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_string)
}

/// The readable text of a tool result.
///
/// A result is a string, or the same block list a message uses. Anything else
/// is the tool's own structure, which Caffold shows as it was written rather
/// than summarizing into a shape it does not understand.
fn text_of(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Array(blocks) => {
            let text = blocks
                .iter()
                .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                    Some("text") => block.get("text")?.as_str().map(str::to_string),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!text.is_empty()).then_some(text)
        }
        other => Some(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn message(value: Value) -> Message {
        serde_json::from_value(value).expect("a message Caffold can read")
    }

    fn items(value: Value, calls: &mut ToolCalls) -> Vec<ConversationItem> {
        message_items(&message(value), "msg_1", calls, false)
    }

    #[test]
    fn a_command_and_its_output_are_one_item_reported_twice() {
        // The identity is the agent's tool-use id, which is what makes the
        // running command and the finished one the same row on screen rather
        // than two.
        let mut calls = ToolCalls::default();
        let started = items(
            json!({
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Bash",
                    "input": { "command": "cargo test" },
                }],
            }),
            &mut calls,
        );
        let finished = items(
            json!({
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": [{ "type": "text", "text": "63 passed" }],
                }],
            }),
            &mut calls,
        );

        assert_eq!(started[0].id, "toolu_1");
        assert_eq!(started[0].status, ActivityStatus::InProgress);
        assert_eq!(finished[0].id, started[0].id);
        assert_eq!(finished[0].status, ActivityStatus::Completed);
        let ItemKind::CommandExecution(execution) = &finished[0].kind else {
            panic!("a command keeps its surface once it finishes");
        };
        assert_eq!(execution.command.as_deref(), Some("cargo test"));
        assert_eq!(execution.output.as_deref(), Some("63 passed"));
        assert_eq!(
            execution.exit_code, None,
            "the agent reports no exit code, and a zero would claim a success it never said"
        );
    }

    #[test]
    fn a_failed_tool_result_reads_as_failed_rather_than_finished() {
        let mut calls = ToolCalls::default();
        items(
            json!({
                "content": [{
                    "type": "tool_use", "id": "toolu_1", "name": "Read",
                    "input": { "file_path": "/missing" },
                }],
            }),
            &mut calls,
        );
        let finished = items(
            json!({
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "no such file",
                    "is_error": true,
                }],
            }),
            &mut calls,
        );

        assert_eq!(finished[0].status, ActivityStatus::Failed);
    }

    #[test]
    fn a_result_for_a_call_this_reader_never_saw_is_dropped() {
        // A transcript read from part way, or a session attached to mid-turn,
        // sees results whose calls are behind it. An item made from one would
        // be an outcome with no work attached.
        let mut calls = ToolCalls::default();

        let orphan = items(
            json!({
                "content": [{
                    "type": "tool_result", "tool_use_id": "toolu_gone", "content": "done",
                }],
            }),
            &mut calls,
        );

        assert!(orphan.is_empty());
    }

    #[test]
    fn every_tool_without_a_surface_of_its_own_keeps_the_agents_name_for_it() {
        // The fallback is what keeps a tool the agent adds tomorrow rendering
        // as work rather than vanishing.
        let mut calls = ToolCalls::default();

        let items = items(
            json!({
                "content": [{
                    "type": "tool_use", "id": "toolu_1", "name": "WebSearch",
                    "input": { "query": "anything" },
                }],
            }),
            &mut calls,
        );

        assert!(matches!(
            &items[0].kind,
            ItemKind::ToolCall { name } if name == "WebSearch"
        ));
    }

    #[test]
    fn the_tools_with_a_surface_of_their_own_reach_it() {
        let cases = [
            (
                json!({ "type": "tool_use", "id": "t1", "name": "Edit", "input": { "file_path": "/src/main.rs" } }),
                "file change",
            ),
            (
                json!({ "type": "tool_use", "id": "t2", "name": "TodoWrite", "input": { "todos": [
                    { "content": "read the code", "status": "completed" },
                    { "content": "write the code", "status": "in_progress" },
                ] } }),
                "plan",
            ),
        ];

        let mut calls = ToolCalls::default();
        let mut kinds = Vec::new();
        for (block, _) in cases {
            kinds.push(
                items(json!({ "content": [block] }), &mut calls)
                    .remove(0)
                    .kind,
            );
        }

        assert!(matches!(
            &kinds[0],
            ItemKind::FileChange { paths } if paths == &["/src/main.rs"]
        ));
        let ItemKind::Plan { text } = &kinds[1] else {
            panic!("a todo list is a plan");
        };
        assert_eq!(text, "[x] read the code\n[~] write the code");
    }

    #[test]
    fn blocks_inside_one_message_are_told_apart_by_where_they_sit() {
        // A message says several things, and the agent identifies the message
        // rather than the things. Two items under one id would overwrite each
        // other on screen.
        let mut calls = ToolCalls::default();

        let items = items(
            json!({
                "content": [
                    { "type": "thinking", "thinking": "considering" },
                    { "type": "text", "text": "here is the answer" },
                ],
            }),
            &mut calls,
        );

        assert_eq!(items[0].id, "msg_1:0");
        assert_eq!(items[1].id, "msg_1:1");
        assert!(matches!(items[0].kind, ItemKind::Reasoning { .. }));
        assert!(matches!(items[1].kind, ItemKind::AssistantMessage { .. }));
    }

    #[test]
    fn a_message_a_person_typed_arrives_as_one_item_of_text() {
        let mut calls = ToolCalls::default();

        let items = items(json!({ "content": "fix the test" }), &mut calls);

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "msg_1");
        let ItemKind::UserMessage { text, content } = &items[0].kind else {
            panic!("a typed message");
        };
        assert_eq!(text, "fix the test");
        assert_eq!(content, &[CaffoldContent::Text { text: text.clone() }]);
    }

    #[test]
    fn a_turn_that_stopped_leaves_no_tool_call_still_running() {
        // An interrupted turn never answers its open calls. Left as they were,
        // they would spin for as long as the conversation is shown.
        let mut calls = ToolCalls::default();
        items(
            json!({
                "content": [{
                    "type": "tool_use", "id": "toolu_1", "name": "Bash",
                    "input": { "command": "sleep 600" },
                }],
            }),
            &mut calls,
        );
        let abandoned = calls.abandon(ActivityStatus::Failed);

        assert_eq!(abandoned.len(), 1);
        assert_eq!(abandoned[0].id, "toolu_1");
        assert_eq!(abandoned[0].status, ActivityStatus::Failed);
        assert!(
            calls.abandon(ActivityStatus::Failed).is_empty(),
            "a call abandoned once is not still open"
        );
    }

    #[test]
    fn a_message_that_failed_to_run_is_a_failure_item_not_a_message() {
        let calls = &mut ToolCalls::default();
        let value = json!({
            "id": "msg_1",
            "model": "<synthetic>",
            "content": [{ "type": "text", "text": "API Error: Connection refused" }],
        });

        let items = message_items(&message(value), "msg_1", calls, true);

        assert_eq!(items.len(), 1);
        assert!(matches!(
            &items[0].kind,
            ItemKind::Failure { text } if text == "API Error: Connection refused"
        ));
    }
}
