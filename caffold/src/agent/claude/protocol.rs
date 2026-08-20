//! What `claude` says on its stream, and what may be said back to it.
//!
//! Two channels share one pair of pipes. The *message stream* is the
//! conversation as it happens — `system`, `assistant`, `user`, `result` — and
//! the *control protocol* is everything asked rather than narrated: interrupt
//! this turn, change the model, may I run this tool.
//!
//! The union is open, and grows on minor releases. So every type here reads
//! what Caffold acts on and lets the rest through: an unrecognized `type`
//! becomes [`StreamFrame::Other`] rather than a parse failure, and a
//! recognized frame keeps the fields Caffold does not read. Margin in shape,
//! never in meaning.
//!
//! The same content blocks appear in the transcript file `claude` writes, so
//! [`ContentBlock`] and [`Message`] are what both readers share; see
//! [`super::translate`].

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::Value;

/// The oldest CLI Caffold drives.
///
/// `--permission-prompt-tool stdio`, the interrupt receipt, and the model list
/// are all needed, and this is the version measured to carry all three.
pub(crate) const MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION: &str = "2.1.236";

/// Arguments every session is started with, whatever else the driver adds.
///
/// `--verbose` is what makes `stream-json` stream rather than emit one blob at
/// the end. `--permission-prompt-tool stdio` is what makes the agent ask before
/// it acts: without it `can_use_tool` is never sent, and a Caffold with no
/// approval cards would look like an agent that never needed permission.
pub(crate) const BASE_ARGUMENTS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
];

// ---------------------------------------------------------------------------
// Agent to host
// ---------------------------------------------------------------------------

/// One line `claude` wrote to its stdout.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum StreamFrame {
    System(SystemFrame),
    Assistant(MessageFrame),
    User(MessageFrame),
    Result(ResultFrame),
    ControlRequest(ControlRequestFrame),
    ControlResponse(ControlResponseFrame),
    /// Everything else the agent says.
    ///
    /// Roughly twenty auxiliary kinds exist and more arrive on minor releases.
    /// Reading one as nothing keeps the session going; the line itself is still
    /// at hand where this is decoded, for a diagnostic that wants it.
    #[serde(other)]
    Other,
}

/// The agent talking about itself rather than about the work.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct SystemFrame {
    #[serde(default)]
    pub(crate) subtype: Option<String>,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
    #[serde(default)]
    pub(crate) cwd: Option<String>,
    #[serde(default, rename = "permissionMode")]
    pub(crate) permission_mode: Option<String>,
    #[serde(default)]
    pub(crate) claude_code_version: Option<String>,
    /// What this installation can do, to be feature-detected rather than
    /// inferred from the version string.
    #[serde(default)]
    pub(crate) capabilities: Vec<String>,
    #[serde(default)]
    pub(crate) fast_mode_state: Option<String>,
    /// Why speed is unavailable, when the agent says. An account without extra
    /// usage is one reason; an installation that never opted in is another.
    #[serde(default)]
    pub(crate) fast_mode_disabled_reason: Option<String>,
}

/// One API message, as the agent produced it.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct MessageFrame {
    pub(crate) message: Message,
    #[serde(default)]
    pub(crate) uuid: Option<String>,
    #[serde(default)]
    pub(crate) timestamp: Option<String>,
    /// Present when this message belongs to a subagent rather than to the
    /// conversation a person is watching.
    #[serde(default)]
    pub(crate) parent_tool_use_id: Option<String>,
}

/// The message body, shared by the stream and the transcript.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct Message {
    /// Absent on user messages, which the agent does not identify.
    #[serde(default)]
    pub(crate) id: Option<String>,
    /// A list of blocks, or the bare string the agent uses for a plain user
    /// message.
    #[serde(default)]
    pub(crate) content: MessageContent,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub(crate) enum MessageContent {
    Blocks(Vec<ContentBlock>),
    Text(String),
    /// A shape this release does not read, including a message with none.
    ///
    /// It accepts anything, which is what keeps a message whose body changes
    /// shape from failing the frame around it.
    Unreadable(serde::de::IgnoredAny),
}

impl Default for MessageContent {
    fn default() -> Self {
        Self::Unreadable(serde::de::IgnoredAny)
    }
}

/// One piece of a message.
///
/// The identifiers are the agent's and they are the same in the stream and in
/// the transcript, which is what lets a turn read back as the same items it
/// was watched as.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ContentBlock {
    Text {
        #[serde(default)]
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: bool,
    },
    /// An image, which the conversation does not draw yet.
    Image,
    /// A block kind this release does not draw.
    #[serde(other)]
    Other,
}

/// What one turn cost and how it ended.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ResultFrame {
    #[serde(default)]
    pub(crate) is_error: bool,
    #[serde(default)]
    pub(crate) stop_reason: Option<String>,
    #[serde(default)]
    pub(crate) usage: Option<Usage>,
    /// Per-model accounting, which the agent's own documentation prefers over
    /// `usage` because it names the context window.
    #[serde(default, rename = "modelUsage")]
    pub(crate) model_usage: BTreeMap<String, ModelUsage>,
}

impl ResultFrame {
    /// Whether this turn ended by being stopped rather than by finishing.
    pub(crate) fn was_interrupted(&self) -> bool {
        matches!(
            self.stop_reason.as_deref(),
            Some("interrupt" | "interrupted" | "abort" | "aborted")
        )
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct Usage {
    #[serde(default)]
    pub(crate) input_tokens: u64,
    #[serde(default)]
    pub(crate) output_tokens: u64,
    #[serde(default)]
    pub(crate) cache_read_input_tokens: u64,
    #[serde(default)]
    pub(crate) cache_creation_input_tokens: u64,
}

/// Per-model accounting.
///
/// The agent's own totals in `usage` are what Caffold counts; this is read only
/// for the context window, which the totals do not carry.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelUsage {
    #[serde(default)]
    pub(crate) context_window: Option<u64>,
}

// ---------------------------------------------------------------------------
// Control protocol
// ---------------------------------------------------------------------------

/// Something the agent is asking the host, and is blocked on.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ControlRequestFrame {
    pub(crate) request_id: String,
    pub(crate) request: ControlRequestBody,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ControlRequestBody {
    #[serde(default)]
    pub(crate) subtype: Option<String>,
    /// The tool the agent wants to run, on a `can_use_tool` request.
    #[serde(default)]
    pub(crate) tool_name: Option<String>,
    #[serde(default)]
    pub(crate) input: Value,
    /// The agent's own proposal for what allowing this always would mean.
    /// Caffold hands it straight back rather than composing a grant of its
    /// own.
    #[serde(default)]
    pub(crate) permission_suggestions: Value,
    #[serde(default)]
    pub(crate) decision_reason: Value,
    #[serde(default, rename = "toolUseID")]
    pub(crate) tool_use_id: Option<String>,
}

/// The agent's answer to something the host asked.
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ControlResponseFrame {
    pub(crate) response: ControlResponseBody,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ControlResponseBody {
    #[serde(default)]
    pub(crate) subtype: Option<String>,
    pub(crate) request_id: String,
    #[serde(default)]
    pub(crate) response: Value,
    #[serde(default)]
    pub(crate) error: Option<String>,
}

impl ControlResponseBody {
    /// The payload, or the agent's reason for refusing.
    pub(crate) fn into_result(self) -> Result<Value, String> {
        if self.subtype.as_deref() == Some("error") {
            return Err(self
                .error
                .unwrap_or_else(|| "the agent refused without saying why".to_string()));
        }
        Ok(self.response)
    }
}

// ---------------------------------------------------------------------------
// Host to agent
// ---------------------------------------------------------------------------

/// A prompt, in the shape the agent reads from stdin.
///
/// An image reaches Caffold as a data URL — the browser has bytes, not a path
/// the agent could open — and it crosses as the bytes it is. One the agent
/// cannot read is dropped rather than described, because a line of prose about
/// a picture is not the picture.
pub(crate) fn user_message(text: &str, images: &[String]) -> Value {
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(serde_json::json!({ "type": "text", "text": text }));
    }
    content.extend(images.iter().filter_map(|image| image_block(image)));
    serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": content },
    })
}

/// One image, from the data URL the browser sent.
fn image_block(image: &str) -> Option<Value> {
    let (media_type, data) = image.strip_prefix("data:")?.split_once(";base64,")?;
    Some(serde_json::json!({
        "type": "image",
        "source": { "type": "base64", "media_type": media_type, "data": data },
    }))
}

/// One request from the host, addressed by an identifier the answer carries
/// back.
pub(crate) fn control_request(request_id: &str, body: Value) -> Value {
    serde_json::json!({
        "type": "control_request",
        "request_id": request_id,
        "request": body,
    })
}

/// The host's answer to a request the agent is blocked on.
pub(crate) fn control_response(request_id: &str, payload: Value) -> Value {
    serde_json::json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": payload,
        },
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn frame(value: Value) -> StreamFrame {
        serde_json::from_value(value).expect("a frame Caffold can read")
    }

    #[test]
    fn a_frame_kind_this_release_does_not_know_is_kept_rather_than_refused() {
        // The union grows on minor releases. A frame Caffold has no use for is
        // still a frame the session survives.
        let parsed = frame(json!({ "type": "memory_recall", "detail": { "n": 1 } }));

        assert!(
            matches!(parsed, StreamFrame::Other),
            "an unknown kind must not be forced into a known one"
        );
    }

    #[test]
    fn a_block_kind_this_release_does_not_draw_survives_beside_ones_it_does() {
        // One unreadable block must not cost the message the blocks around it.
        let parsed = frame(json!({
            "type": "assistant",
            "message": {
                "id": "msg_1",
                "content": [
                    { "type": "text", "text": "before" },
                    { "type": "server_tool_use", "id": "srvtoolu_1" },
                    { "type": "text", "text": "after" },
                ],
            },
        }));

        let StreamFrame::Assistant(assistant) = parsed else {
            panic!("wrong frame");
        };
        let MessageContent::Blocks(blocks) = assistant.message.content else {
            panic!("a list of blocks");
        };
        assert_eq!(blocks.len(), 3);
        assert!(matches!(blocks[1], ContentBlock::Other));
    }

    #[test]
    fn a_plain_user_message_is_read_whether_it_is_a_string_or_blocks() {
        // The transcript writes a bare string for a message a person typed and
        // a block list for one carrying a tool result, and both are the same
        // message kind.
        let text = frame(json!({
            "type": "user",
            "message": { "role": "user", "content": "just text" },
        }));
        let StreamFrame::User(user) = text else {
            panic!("wrong frame");
        };
        assert!(
            matches!(user.message.content, MessageContent::Text(ref value) if value == "just text")
        );

        let blocks = frame(json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{ "type": "tool_result", "tool_use_id": "toolu_1", "content": "done" }],
            },
        }));
        let StreamFrame::User(user) = blocks else {
            panic!("wrong frame");
        };
        let MessageContent::Blocks(blocks) = user.message.content else {
            panic!("a list of blocks");
        };
        assert!(matches!(
            blocks[0],
            ContentBlock::ToolResult { ref tool_use_id, .. } if tool_use_id == "toolu_1"
        ));
    }

    #[test]
    fn an_error_control_response_reads_as_a_refusal_rather_than_a_payload() {
        let refused = ControlResponseBody {
            subtype: Some("error".to_string()),
            request_id: "1".to_string(),
            response: Value::Null,
            error: Some("no such model".to_string()),
        };

        assert_eq!(refused.into_result(), Err("no such model".to_string()));
    }

    #[test]
    fn an_image_crosses_as_the_bytes_the_browser_sent() {
        // The browser has bytes, not a path the agent could open. A sentence
        // naming a file the agent cannot see is not an image.
        let frame = user_message(
            "what is this",
            &["data:image/png;base64,aGVsbG8=".to_string()],
        );

        let content = frame["message"]["content"].as_array().expect("content");
        assert_eq!(content[0]["text"], "what is this");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "aGVsbG8=");
    }

    #[test]
    fn an_image_the_agent_could_not_read_is_dropped_rather_than_described() {
        let frame = user_message(
            "what is this",
            &["https://example.test/cat.png".to_string()],
        );

        let content = frame["message"]["content"].as_array().expect("content");
        assert_eq!(content.len(), 1, "{content:?}");
        assert_eq!(content[0]["type"], "text");
    }

    #[test]
    fn a_prompt_that_is_only_an_image_carries_no_empty_text() {
        let frame = user_message("", &["data:image/png;base64,aGVsbG8=".to_string()]);

        let content = frame["message"]["content"].as_array().expect("content");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image");
    }

    #[test]
    fn every_session_asks_the_agent_to_stream_and_to_ask_before_acting() {
        // Both are load-bearing and neither is obvious from the flag name, so
        // their absence should fail here rather than as silence at run time.
        assert!(BASE_ARGUMENTS.contains(&"--verbose"));
        let permission = BASE_ARGUMENTS
            .windows(2)
            .find(|pair| pair[0] == "--permission-prompt-tool");
        assert_eq!(permission.map(|pair| pair[1]), Some("stdio"));
    }
}
