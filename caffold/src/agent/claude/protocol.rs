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

use crate::agent::CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS;

/// The oldest CLI Caffold drives.
///
/// `--permission-prompt-tool stdio`, the interrupt receipt, the model list,
/// and a prompt filed under the `uuid` the host puts on its stdin frame are
/// all needed, and this is the version measured to carry all four.
pub(crate) const MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION: &str = "2.1.259";

/// Arguments every session is started with, whatever else the driver adds.
///
/// `--verbose` is what makes `stream-json` stream rather than emit one blob at
/// the end. `--permission-prompt-tool stdio` is what makes the agent ask before
/// it acts: without it `can_use_tool` is never sent, and a Caffold with no
/// approval cards would look like an agent that never needed permission.
///
/// `--allowedTools` grants the tools Caffold itself serves: the agent calling
/// one is already the user asking, so they take no approval — exactly as
/// Codex's Caffold-served tools answer without one.
pub(crate) const BASE_ARGUMENTS: &[&str] = &[
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
    "--allowedTools",
    RENAME_CURRENT_TASK_QUALIFIED_NAME,
    "--allowedTools",
    ISOLATE_CURRENT_TASK_QUALIFIED_NAME,
];

/// What every session is started with beyond its arguments.
///
/// Claude reports session activity only when this is enabled. The resulting
/// state frames describe whether the session is working, independently of the
/// prompt and transcript evidence that identifies its turn.
pub(crate) const SESSION_ENVIRONMENT: &[(&str, &str)] =
    &[("CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS", "1")];

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
    /// Present on `session_state_changed`, separate from the introduction
    /// fields above.
    #[serde(default)]
    pub(crate) state: Option<String>,
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
    /// The harness speaking, not the model: a turn that could not run at all,
    /// written where an answer would have been.
    #[serde(default)]
    pub(crate) is_api_error_message: bool,
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
    Image {
        /// Where the picture is. Absent when the agent points at one somewhere
        /// else rather than carrying it, which nothing here can draw.
        #[serde(default)]
        source: Option<ImageSource>,
    },
    /// A block kind this release does not draw.
    #[serde(other)]
    Other,
}

/// Where a picture is.
///
/// Every field is optional because the agent may say where a picture is in
/// ways this release has never seen — pointing at a URL, naming a file it
/// uploaded — and a shape that does not fit must cost the picture and nothing
/// else. Requiring a field here would fail the block, and a failed block fails
/// the message around it: the words, the thinking, and the tool calls in it
/// would all go with the picture.
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct ImageSource {
    #[serde(default, rename = "type")]
    pub(crate) kind: String,
    #[serde(default)]
    pub(crate) media_type: String,
    #[serde(default)]
    pub(crate) data: String,
}

impl ImageSource {
    /// The picture as the browser can draw it, when it is carried here.
    ///
    /// This is [`image_block`] undone, and it lives beside it so the two halves
    /// of one grammar stay together. A source that only says where a picture is
    /// has nothing to hand over, and saying `;base64,` about bytes that are not
    /// would draw a broken picture rather than none.
    pub(crate) fn data_url(&self) -> Option<String> {
        (self.kind == "base64" && !self.media_type.is_empty() && !self.data.is_empty())
            .then(|| format!("data:{};base64,{}", self.media_type, self.data))
    }
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
    /// The agent's own proposal for what allowing this always means.
    /// Answering hands it back whole rather than composing a grant of
    /// Caffold's own — a subset was probed and does not stop the re-ask.
    #[serde(default)]
    pub(crate) permission_suggestions: Value,
    #[serde(default)]
    pub(crate) decision_reason: Value,
    /// The tool call a `can_use_tool` request interrupts. Named
    /// `tool_use_id` on the wire — measured; the SDK's `toolUseID` spelling
    /// is its own callback surface, not this protocol's.
    #[serde(default)]
    pub(crate) tool_use_id: Option<String>,
    /// Which SDK-hosted MCP server an `mcp_message` request is for.
    #[serde(default)]
    pub(crate) server_name: Option<String>,
    /// The MCP JSON-RPC message an `mcp_message` request carries.
    #[serde(default)]
    pub(crate) message: Value,
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
    /// Questions about using a tool that nothing has answered.
    #[serde(default)]
    pub(crate) pending_permission_requests: Vec<Value>,
    /// Questions put to the person that nothing has answered.
    #[serde(default)]
    pub(crate) pending_user_dialog_requests: Vec<Value>,
}

/// What the agent answered, and what it is still waiting on.
///
/// The two travel together because the agent sends them together: the
/// unanswered questions sit beside the payload rather than inside it. Only
/// saying hello asks for them, and every other request leaves them empty.
#[derive(Debug, Clone)]
pub(crate) struct ControlAnswer {
    pub(crate) payload: Value,
    /// The questions as the agent asked them, so they can be asked again
    /// exactly as they were rather than described a second time.
    pub(crate) unanswered: Vec<Value>,
}

impl ControlResponseBody {
    /// The answer, or the agent's reason for refusing.
    pub(crate) fn into_result(self) -> Result<ControlAnswer, String> {
        if self.subtype.as_deref() == Some("error") {
            return Err(self
                .error
                .unwrap_or_else(|| "the agent refused without saying why".to_string()));
        }
        let mut unanswered = self.pending_permission_requests;
        unanswered.extend(self.pending_user_dialog_requests);
        Ok(ControlAnswer {
            payload: self.response,
            unanswered,
        })
    }
}

// ---------------------------------------------------------------------------
// Host to agent
// ---------------------------------------------------------------------------

/// A prompt, named and in the shape the agent reads from stdin.
///
/// The name is minted here, so that every message Caffold sends has a fresh
/// one. The agent files the message under it — it is the `uuid` of the
/// transcript row, and so the name of the turn a prompt opens — which is what
/// makes a turn watched live and the same turn read back from disk one turn
/// rather than two. Measured against CLI 2.1.259, with and without
/// `--replay-user-messages`.
///
/// An image reaches Caffold as a data URL — the browser has bytes, not a path
/// the agent could open — and it crosses as the bytes it is. One the agent
/// cannot read is dropped rather than described, because a line of prose about
/// a picture is not the picture.
pub(crate) fn user_message(text: &str, images: &[String]) -> (String, Value) {
    let name = uuid::Uuid::new_v4().to_string();
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(serde_json::json!({ "type": "text", "text": text }));
    }
    content.extend(images.iter().filter_map(|image| image_block(image)));
    let frame = serde_json::json!({
        "type": "user",
        "uuid": name,
        "message": { "role": "user", "content": content },
    });
    (name, frame)
}

/// One image, from the data URL the browser sent.
fn image_block(image: &str) -> Option<Value> {
    let source = image_source(image)?;
    Some(serde_json::json!({
        "type": "image",
        "source": { "type": "base64", "media_type": source.media_type, "data": source.data },
    }))
}

/// A data URL taken apart, or nothing when it is not one.
///
/// Both what is sent to the agent and what is drawn for a person come through
/// here, so a picture Caffold cannot send is not a picture Caffold shows.
pub(crate) fn image_source(image: &str) -> Option<ImageSource> {
    let (media_type, data) = image.strip_prefix("data:")?.split_once(";base64,")?;
    (!media_type.is_empty() && !data.is_empty()).then(|| ImageSource {
        kind: "base64".to_string(),
        media_type: media_type.to_string(),
        data: data.to_string(),
    })
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

/// The hello, which is also where Caffold says what it serves and how an
/// optional current plan is represented.
///
/// `sdkMcpServers` is processed on every initialize, first or repeated, so a
/// fresh session and a re-attached one declare the same way. The answer
/// carries the session's past; a caller that has no use for one may send this
/// without listening.
pub(crate) fn initialize_request() -> Value {
    serde_json::json!({
        "subtype": "initialize",
        "sdkMcpServers": [MCP_SERVER_NAME],
        "appendSystemPrompt": CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS,
    })
}

/// The hello for a session that is a newly created Task, which also carries
/// the one-time session setup: name the Task on the first turn.
///
/// Only for a fresh session. The naming instructions call the session newly
/// created and scope themselves to its first turn, so a resumed conversation
/// carries only the provider-neutral plan convention from [`initialize_request`].
pub(crate) fn initialize_request_for_a_new_task() -> Value {
    serde_json::json!({
        "subtype": "initialize",
        "sdkMcpServers": [MCP_SERVER_NAME],
        "appendSystemPrompt": format!(
            "{CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS}\n\n{CAFFOLD_FIRST_TURN_NAMING_INSTRUCTIONS}"
        ),
    })
}

/// What replaces the `[REQ]` placeholder a Task is created wearing.
///
/// The Claude wording of the instructions Codex receives as
/// `developer_instructions` at thread start, naming the tool as the model
/// sees it. The isolate caveat Codex carries has no counterpart yet, because
/// Caffold serves Claude no isolate tool yet.
pub(crate) const CAFFOLD_FIRST_TURN_NAMING_INSTRUCTIONS: &str = concat!(
    "This session is a newly created Caffold task. ",
    "On its first user turn, after you understand the user's underlying goal and immediately ",
    "before your final response, you must call mcp__caffold__rename_current_task exactly once ",
    "with a concise, meaningful user-facing task name in the user's language. ",
    "Do not copy response-format instructions, verification markers, or the eventual answer ",
    "into the name. ",
    "If the user specifies an exact task name or format, honor it in that same call. ",
    "If mcp__caffold__isolate_current_task is needed on the first turn, call ",
    "mcp__caffold__rename_current_task immediately before isolation, and end the turn once the ",
    "worktree is ready. ",
    "On later turns, call mcp__caffold__rename_current_task only when the user explicitly asks ",
    "to rename the task."
);

/// Retitle the agent's own session, so the name Caffold keeps is also the
/// name the agent's own surfaces show.
pub(crate) fn rename_session_request(title: &str) -> Value {
    serde_json::json!({ "subtype": "rename_session", "title": title })
}

/// Move the session's working directory — where its tools run, and where the
/// agent keeps its transcript from then on.
pub(crate) fn set_cwd_request(path: &str) -> Value {
    serde_json::json!({ "subtype": "set_cwd", "path": path })
}

/// The second half of moving somewhere the agent does not yet trust: echo the
/// directory its `needs_trust` answer named, accepted on the user's behalf —
/// Caffold made the worktree it is asking the session into.
pub(crate) fn set_cwd_trusted_request(path: &str, trusted_directory: &str) -> Value {
    serde_json::json!({
        "subtype": "set_cwd",
        "path": path,
        "trust_accepted": true,
        "trusted_directory": trusted_directory,
    })
}

// ---------------------------------------------------------------------------
// The MCP server Caffold hosts
// ---------------------------------------------------------------------------

/// The in-process MCP server every session is told about.
///
/// The name is half of every tool's identity: a tool `t` served here reaches
/// the model as `mcp__caffold__t`.
pub(crate) const MCP_SERVER_NAME: &str = "caffold";

/// Set the user-facing name of the current Task.
pub(crate) const RENAME_CURRENT_TASK_TOOL_NAME: &str = "rename_current_task";

/// The rename tool under the name the model calls it by, for granting it up
/// front in [`BASE_ARGUMENTS`].
pub(crate) const RENAME_CURRENT_TASK_QUALIFIED_NAME: &str = "mcp__caffold__rename_current_task";

/// Move the current Task into a Caffold-managed worktree.
pub(crate) const ISOLATE_CURRENT_TASK_TOOL_NAME: &str = "isolate_current_task";

/// The isolate tool under the name the model calls it by.
pub(crate) const ISOLATE_CURRENT_TASK_QUALIFIED_NAME: &str = "mcp__caffold__isolate_current_task";

/// Answer one MCP request with its result.
pub(crate) fn mcp_result(request_id: &str, mcp_id: &Value, result: Value) -> Value {
    control_response(
        request_id,
        serde_json::json!({
            "mcp_response": { "jsonrpc": "2.0", "id": mcp_id, "result": result },
        }),
    )
}

/// Acknowledge an MCP notification, which asks for nothing back.
///
/// The placeholder identity is the reference client's own: a notification has
/// no id to echo, and the acknowledgement is discarded.
pub(crate) fn mcp_notification_ack(request_id: &str) -> Value {
    control_response(
        request_id,
        serde_json::json!({
            "mcp_response": { "jsonrpc": "2.0", "id": 0, "result": {} },
        }),
    )
}

/// Refuse an MCP method Caffold does not serve, in MCP's own words for it.
pub(crate) fn mcp_method_refused(request_id: &str, mcp_id: &Value, method: &str) -> Value {
    control_response(
        request_id,
        serde_json::json!({
            "mcp_response": {
                "jsonrpc": "2.0",
                "id": mcp_id,
                "error": {
                    "code": -32601,
                    "message": format!("Caffold does not serve `{method}`."),
                },
            },
        }),
    )
}

/// What the handshake says: tools, and nothing else.
pub(crate) fn mcp_initialize_result(message: &Value) -> Value {
    let requested = message
        .get("params")
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str)
        .unwrap_or("2025-06-18");
    serde_json::json!({
        "protocolVersion": requested,
        "capabilities": { "tools": {} },
        "serverInfo": { "name": MCP_SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
    })
}

/// The tools Caffold serves, described to the agent.
///
/// `anthropic/alwaysLoad` keeps a tool's schema in the model's context. The
/// CLI otherwise defers MCP tools to its search pool, where a tool is only a
/// name until the model chooses to load it — and a model instructed to call
/// this one sometimes would not bother, measured as the first-turn rename
/// landing on some runs and not others.
pub(crate) fn mcp_tool_listing() -> Value {
    serde_json::json!({
        "tools": [
            {
                "name": RENAME_CURRENT_TASK_TOOL_NAME,
                "description": "Set the user-facing name of the current Caffold task.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "name": {
                            "type": "string",
                            "minLength": 1,
                            "description": "The new user-facing name for the current Caffold task.",
                        },
                    },
                    "required": ["name"],
                },
                "_meta": { "anthropic/alwaysLoad": true },
            },
            {
                "name": ISOLATE_CURRENT_TASK_TOOL_NAME,
                "description": "Prepare the current Caffold task in a Caffold-managed Git worktree only when the user explicitly asks to isolate the current task or prepare a worktree. By default, leave staged, unstaged, and untracked source checkout changes in place. An optional baseRef creates a new branch from that ref without handing off the current branch and cannot be combined with includeChanges. Set includeChanges to true only when the user explicitly asks to move current or uncommitted changes too. Call this as the final file-affecting action of the current turn. After it succeeds, do not call command or file tools; end the turn so the user's next request can continue in the managed worktree.",
                "inputSchema": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "branchName": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Optional local branch name. Without baseRef, a current non-default branch is always handed off unchanged. With baseRef, this names the new branch created from that ref.",
                        },
                        "baseRef": {
                            "type": "string",
                            "minLength": 1,
                            "description": "Optional existing branch, tag, or commit ref to use as the new branch starting point. When provided, the current checkout remains unchanged and includeChanges must be false.",
                        },
                        "includeChanges": {
                            "type": "boolean",
                            "description": "Whether to move staged, unstaged, and untracked changes into the worktree. Defaults to false and must be true only when the user explicitly requests that transfer.",
                        },
                    },
                },
                "_meta": { "anthropic/alwaysLoad": true },
            },
        ],
    })
}

/// A tool call's outcome, spoken as MCP speaks it: text, flagged when it is a
/// failure rather than an answer.
pub(crate) fn mcp_tool_outcome(
    request_id: &str,
    mcp_id: &Value,
    outcome: &Result<String, String>,
) -> Value {
    let text = match outcome {
        Ok(text) | Err(text) => text,
    };
    let mut result = serde_json::json!({
        "content": [ { "type": "text", "text": text } ],
    });
    if outcome.is_err() {
        result["isError"] = Value::Bool(true);
    }
    mcp_result(request_id, mcp_id, result)
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
            pending_permission_requests: Vec::new(),
            pending_user_dialog_requests: Vec::new(),
        };

        assert_eq!(
            refused.into_result().err(),
            Some("no such model".to_string())
        );
    }

    #[test]
    fn saying_hello_answers_with_every_question_the_agent_is_held_up_by() {
        // Both kinds travel beside the payload rather than inside it, and both
        // hold a turn up until they are answered, so both come back together.
        let hello: ControlResponseBody = serde_json::from_value(json!({
            "subtype": "success",
            "request_id": "1",
            "response": { "session_state": "running" },
            "pending_permission_requests": [
                { "type": "control_request", "request_id": "may-i", "request": {} },
            ],
            "pending_user_dialog_requests": [
                { "type": "control_request", "request_id": "which-one", "request": {} },
            ],
        }))
        .expect("the answer decodes");

        let answer = hello.into_result().expect("a success is not a refusal");

        assert_eq!(answer.payload["session_state"], "running");
        assert_eq!(
            answer
                .unanswered
                .iter()
                .map(|question| question["request_id"].as_str().unwrap_or_default())
                .collect::<Vec<_>>(),
            vec!["may-i", "which-one"],
        );
    }

    #[test]
    fn an_image_crosses_as_the_bytes_the_browser_sent() {
        // The browser has bytes, not a path the agent could open. A sentence
        // naming a file the agent cannot see is not an image.
        let (_, frame) = user_message(
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
        let (_, frame) = user_message(
            "what is this",
            &["https://example.test/cat.png".to_string()],
        );

        let content = frame["message"]["content"].as_array().expect("content");
        assert_eq!(content.len(), 1, "{content:?}");
        assert_eq!(content[0]["type"], "text");
    }

    #[test]
    fn a_prompt_is_sent_under_a_fresh_name_of_caffolds_own() {
        let (name, frame) = user_message("hello", &[]);
        let (another, _) = user_message("hello", &[]);

        assert_eq!(frame["type"], "user");
        assert_eq!(frame["uuid"], name.as_str(), "{frame}");
        assert!(uuid::Uuid::parse_str(&name).is_ok(), "{name}");
        assert_ne!(name, another, "two prompts are two names");
    }

    #[test]
    fn a_prompt_that_is_only_an_image_carries_no_empty_text() {
        let (_, frame) = user_message("", &["data:image/png;base64,aGVsbG8=".to_string()]);

        let content = frame["message"]["content"].as_array().expect("content");
        assert_eq!(content.len(), 1);
        assert_eq!(content[0]["type"], "image");
    }

    #[test]
    fn a_picture_shaped_in_a_way_this_release_cannot_read_costs_the_picture_and_no_more() {
        // The margin is in shape, never in meaning: an image the agent points
        // at rather than carries must not take the words around it with it.
        let frame: MessageFrame = serde_json::from_value(serde_json::json!({
            "uuid": "u1",
            "message": { "content": [
                { "type": "text", "text": "before" },
                { "type": "image", "source": { "type": "url", "url": "https://x/y.png" } },
                { "type": "text", "text": "after" },
            ]},
        }))
        .expect("the frame reads");

        let MessageContent::Blocks(blocks) = &frame.message.content else {
            panic!("the message is blocks: {:?}", frame.message.content);
        };
        assert_eq!(blocks.len(), 3, "the words survive the picture: {blocks:?}");
        assert!(matches!(blocks[0], ContentBlock::Text { .. }));
        assert!(matches!(blocks[2], ContentBlock::Text { .. }));
        let ContentBlock::Image { source } = &blocks[1] else {
            panic!("the picture is still a picture: {:?}", blocks[1]);
        };
        // Read, and with nothing to draw: it says where a picture is rather
        // than carrying one.
        assert_eq!(source.as_ref().and_then(ImageSource::data_url), None);
    }

    #[test]
    fn a_picture_survives_being_sent_and_read_back_as_the_same_picture() {
        let sent = "data:image/png;base64,aGVsbG8=";
        let block = image_block(sent).expect("the picture is sendable");
        let source: ImageSource =
            serde_json::from_value(block["source"].clone()).expect("the source reads");

        assert_eq!(source.data_url().as_deref(), Some(sent));
    }

    #[test]
    fn what_cannot_be_sent_is_not_shown_as_though_it_had_been() {
        for pointed_at in [
            "https://example.test/cat.png",
            "/Users/somebody/shot.png",
            "data:image/png,notbase64",
            "data:;base64,aGVsbG8=",
            "data:image/png;base64,",
        ] {
            assert!(
                image_source(pointed_at).is_none(),
                "{pointed_at} is not a picture this can carry"
            );
        }
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

    #[test]
    fn every_session_grants_the_tools_caffold_serves_under_the_names_the_model_calls_them_by() {
        let granted: Vec<&str> = BASE_ARGUMENTS
            .windows(2)
            .filter(|pair| pair[0] == "--allowedTools")
            .map(|pair| pair[1])
            .collect();
        assert_eq!(
            granted,
            [
                RENAME_CURRENT_TASK_QUALIFIED_NAME,
                ISOLATE_CURRENT_TASK_QUALIFIED_NAME
            ]
        );
        // The qualified names are derived by the CLI, not chosen by Caffold,
        // so a grant only holds while the three names actually compose.
        assert_eq!(
            RENAME_CURRENT_TASK_QUALIFIED_NAME,
            format!("mcp__{MCP_SERVER_NAME}__{RENAME_CURRENT_TASK_TOOL_NAME}")
        );
        assert_eq!(
            ISOLATE_CURRENT_TASK_QUALIFIED_NAME,
            format!("mcp__{MCP_SERVER_NAME}__{ISOLATE_CURRENT_TASK_TOOL_NAME}")
        );
    }

    #[test]
    fn saying_hello_is_also_declaring_the_server_caffold_hosts() {
        let hello = initialize_request();
        assert_eq!(hello["subtype"], "initialize");
        assert_eq!(hello["sdkMcpServers"], json!(["caffold"]));
        let setup = hello["appendSystemPrompt"]
            .as_str()
            .expect("a resumed session receives the plan convention");
        assert_eq!(setup, CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS);
        assert!(setup.contains(".caffold/plans/current/PLAN.md"));
        assert!(setup.contains(".caffold/plans/current/CHECKLIST.md"));
        assert!(!setup.contains("newly created Caffold task"));
    }

    #[test]
    fn a_new_tasks_hello_combines_the_plan_convention_with_once_only_naming() {
        let hello = initialize_request_for_a_new_task();
        assert_eq!(hello["sdkMcpServers"], json!(["caffold"]));
        let setup = hello["appendSystemPrompt"]
            .as_str()
            .expect("the once-only session setup rides the first hello");
        // The instructions name the tools the way the model calls them, or
        // the model is told to call something it cannot find.
        assert!(setup.contains(RENAME_CURRENT_TASK_QUALIFIED_NAME));
        assert!(setup.contains(ISOLATE_CURRENT_TASK_QUALIFIED_NAME));
        assert!(setup.contains("first user turn"));
        assert!(setup.starts_with(CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS));
        // A resumed conversation keeps the durable plan convention but must
        // not repeat the new-Task naming claim.
        assert!(
            !initialize_request()["appendSystemPrompt"]
                .as_str()
                .unwrap()
                .contains("newly created Caffold task")
        );
    }

    #[test]
    fn a_message_for_the_hosted_server_is_read_with_its_address() {
        let frame = frame(json!({
            "type": "control_request",
            "request_id": "req-7",
            "request": {
                "subtype": "mcp_message",
                "server_name": "caffold",
                "message": { "jsonrpc": "2.0", "id": 3, "method": "tools/list" },
            },
        }));
        let StreamFrame::ControlRequest(request) = frame else {
            panic!("an mcp_message is a control request");
        };
        assert_eq!(request.request.subtype.as_deref(), Some("mcp_message"));
        assert_eq!(request.request.server_name.as_deref(), Some("caffold"));
        assert_eq!(request.request.message["method"], "tools/list");
    }

    #[test]
    fn the_handshake_answers_in_the_version_the_agent_asked_in() {
        let result = mcp_initialize_result(&json!({
            "method": "initialize",
            "params": { "protocolVersion": "2031-01-01" },
        }));
        assert_eq!(result["protocolVersion"], "2031-01-01");
        assert_eq!(result["serverInfo"]["name"], "caffold");
        assert!(result["capabilities"]["tools"].is_object());
    }

    #[test]
    fn the_listing_serves_the_rename_tool_and_requires_its_name() {
        let listing = mcp_tool_listing();
        let tool = &listing["tools"][0];
        assert_eq!(tool["name"], RENAME_CURRENT_TASK_TOOL_NAME);
        assert_eq!(tool["inputSchema"]["required"], json!(["name"]));
        // Without this marker the CLI defers the tool to its search pool and
        // the instructed first-turn rename becomes a coin toss.
        assert_eq!(tool["_meta"]["anthropic/alwaysLoad"], true);
    }

    #[test]
    fn the_listing_serves_the_isolate_tool_with_every_argument_optional() {
        let listing = mcp_tool_listing();
        let tool = &listing["tools"][1];
        assert_eq!(tool["name"], ISOLATE_CURRENT_TASK_TOOL_NAME);
        let schema = &tool["inputSchema"];
        assert!(schema["properties"]["branchName"].is_object());
        assert!(schema["properties"]["baseRef"].is_object());
        assert!(schema["properties"]["includeChanges"].is_object());
        assert!(
            schema.get("required").is_none(),
            "a bare call isolates with the defaults"
        );
        assert_eq!(tool["_meta"]["anthropic/alwaysLoad"], true);
    }

    #[test]
    fn moving_a_session_asks_in_two_halves_when_trust_is_demanded() {
        assert_eq!(
            set_cwd_request("/work/tree"),
            json!({ "subtype": "set_cwd", "path": "/work/tree" })
        );
        assert_eq!(
            set_cwd_trusted_request("/work/tree", "/work/tree"),
            json!({
                "subtype": "set_cwd",
                "path": "/work/tree",
                "trust_accepted": true,
                "trusted_directory": "/work/tree",
            })
        );
    }

    #[test]
    fn a_tool_outcome_is_text_and_only_a_failure_is_flagged() {
        let done = mcp_tool_outcome("req-1", &json!(4), &Ok("Renamed.".to_string()));
        let result = &done["response"]["response"]["mcp_response"]["result"];
        assert_eq!(result["content"][0]["text"], "Renamed.");
        assert!(result.get("isError").is_none());
        assert_eq!(done["response"]["response"]["mcp_response"]["id"], 4);

        let refused = mcp_tool_outcome("req-2", &json!(5), &Err("No.".to_string()));
        let result = &refused["response"]["response"]["mcp_response"]["result"];
        assert_eq!(result["isError"], true);
    }

    #[test]
    fn a_notification_is_acknowledged_and_an_unknown_method_is_refused_in_mcp_words() {
        let ack = mcp_notification_ack("req-3");
        assert_eq!(
            ack["response"]["response"]["mcp_response"]["result"],
            json!({})
        );

        let refused = mcp_method_refused("req-4", &json!(9), "resources/list");
        let error = &refused["response"]["response"]["mcp_response"]["error"];
        assert_eq!(error["code"], -32601);
        assert_eq!(error["message"], "Caffold does not serve `resources/list`.");
    }
}
