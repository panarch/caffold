//! Turning what Grok reports into what a Task shows.
//!
//! One translator for both readers: a tool call watched live and the same
//! tool call read back from the session's stored updates carry the same
//! `toolCallId` and the same shape, so both come through here. Only a few
//! tools get a surface of their own — a command has output to read, an edit
//! has paths to open — and everything else is a [`ItemKind::ToolCall`] under
//! Grok's own name for it.

use serde_json::Value;

use super::protocol::{
    ContentBlock, OPTION_ALLOW_ALWAYS, OPTION_ALLOW_ONCE, OPTION_REJECT_ONCE,
    PermissionRequestParams, PlanEntry, ToolCall, ToolCallUpdate, ToolIdentity, TurnUsage,
};
use crate::agent::{
    ActivityStatus, ApprovalArgument, ApprovalDecision, ApprovalDetail, ApprovalRequest,
    ApprovalToolDetail, CommandExecution, ConversationItem, ItemKind, MessageContent,
    ThreadActiveFlag, ThreadStatus, TokenCount, TokenUsage, TurnStatus,
};

pub(super) const RUN_TERMINAL_COMMAND: &str = "run_terminal_command";
pub(super) const USE_TOOL: &str = "use_tool";

/// A tool call the agent has just begun.
pub(super) fn tool_call_item(call: &ToolCall) -> ConversationItem {
    let identity = call.meta.tool.clone().unwrap_or_default();
    ConversationItem {
        id: call.tool_call_id.clone(),
        observed_at_ms: None,
        status: ActivityStatus::InProgress,
        kind: tool_kind(
            &identity,
            call.kind.as_deref(),
            &call.raw_input,
            &Value::Null,
            &[],
        ),
    }
}

/// The same tool call, further along. The update repeats what it wants to
/// and omits the rest, so what was known before is kept where it is silent.
pub(super) fn tool_call_update_item(
    before: Option<&ConversationItem>,
    update: &ToolCallUpdate,
    declined: bool,
) -> ConversationItem {
    let identity = update
        .meta
        .tool
        .clone()
        .or_else(|| before.and_then(identity_of))
        .unwrap_or_default();
    let raw_input = if update.raw_input.is_null() {
        before
            .and_then(|item| match &item.kind {
                ItemKind::CommandExecution(command) => command
                    .command
                    .clone()
                    .map(|command| serde_json::json!({ "command": command, "variant": "Bash" })),
                _ => None,
            })
            .unwrap_or(Value::Null)
    } else {
        update.raw_input.clone()
    };
    let paths = update
        .locations
        .iter()
        .map(|location| location.path.clone())
        .collect::<Vec<_>>();
    let mut kind = tool_kind(
        &identity,
        update.kind.as_deref(),
        &raw_input,
        &update.raw_output,
        &paths,
    );
    if let (ItemKind::CommandExecution(command), Some(ItemKind::CommandExecution(earlier))) =
        (&mut kind, before.map(|item| &item.kind))
    {
        if command.command.is_none() {
            command.command = earlier.command.clone();
        }
        if command.cwd.is_none() {
            command.cwd = earlier.cwd.clone();
        }
        if command.output.is_none() {
            command.output = earlier.output.clone();
        }
    }
    if let ItemKind::CommandExecution(command) = &mut kind
        && command.output.is_none()
    {
        command.output = content_text(&update.content);
    }
    let status = match update.status.as_deref() {
        _ if declined => ActivityStatus::Declined,
        Some("completed") => ActivityStatus::Completed,
        Some("failed") => ActivityStatus::Failed,
        Some("in_progress") | Some("pending") => ActivityStatus::InProgress,
        _ => before
            .map(|item| item.status)
            .unwrap_or(ActivityStatus::InProgress),
    };
    ConversationItem {
        id: update.tool_call_id.clone(),
        observed_at_ms: before.and_then(|item| item.observed_at_ms),
        status,
        kind,
    }
}

fn identity_of(item: &ConversationItem) -> Option<ToolIdentity> {
    match &item.kind {
        ItemKind::CommandExecution(_) => Some(ToolIdentity {
            name: RUN_TERMINAL_COMMAND.to_string(),
            kind: Some("execute".to_string()),
            label: None,
        }),
        ItemKind::FileChange { .. } => Some(ToolIdentity {
            name: String::new(),
            kind: Some("edit".to_string()),
            label: None,
        }),
        ItemKind::ToolCall { name } => Some(ToolIdentity {
            name: name.clone(),
            kind: None,
            label: None,
        }),
        _ => None,
    }
}

/// Which surface draws a tool call, from Grok's own name for the tool.
fn tool_kind(
    identity: &ToolIdentity,
    acp_kind: Option<&str>,
    raw_input: &Value,
    raw_output: &Value,
    paths: &[String],
) -> ItemKind {
    let name = identity.name.as_str();
    let kind = identity.kind.as_deref().or(acp_kind).unwrap_or("");
    if name == RUN_TERMINAL_COMMAND
        || raw_input.get("variant").and_then(Value::as_str) == Some("Bash")
    {
        return ItemKind::CommandExecution(CommandExecution {
            command: string_field(raw_input, "command"),
            cwd: string_field(raw_output, "current_dir"),
            output: string_field(raw_output, "output_for_prompt"),
            exit_code: raw_output.get("exit_code").and_then(Value::as_i64),
            duration_ms: None,
            background_task: None,
        });
    }
    if kind == "edit"
        || matches!(
            name,
            "edit_file" | "write_file" | "create_file" | "apply_patch" | "multi_edit"
        )
    {
        let mut changed = paths.to_vec();
        if changed.is_empty() {
            for key in ["file_path", "path", "target_file"] {
                if let Some(path) = string_field(raw_input, key) {
                    changed.push(path);
                }
            }
        }
        return ItemKind::FileChange { paths: changed };
    }
    if name == USE_TOOL {
        return ItemKind::ToolCall {
            name: string_field(raw_input, "tool_name").unwrap_or_else(|| USE_TOOL.to_string()),
        };
    }
    ItemKind::ToolCall {
        name: if name.is_empty() {
            identity.label.clone().unwrap_or_else(|| "tool".to_string())
        } else {
            name.to_string()
        },
    }
}

fn content_text(content: &[Value]) -> Option<String> {
    let text = content
        .iter()
        .filter_map(|entry| {
            entry
                .get("content")
                .and_then(|inner| inner.get("text"))
                .and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// What a person said, out of the blocks the leader kept it in.
pub(super) fn user_message_item(
    id: &str,
    blocks: &[ContentBlock],
    observed_at_ms: Option<u64>,
) -> ConversationItem {
    let mut text = String::new();
    let mut content = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text {
                text: raw,
                display_text,
            } => {
                let shown = display_text.clone().unwrap_or_else(|| raw.clone());
                if !shown.is_empty() {
                    text.push_str(&shown);
                    content.push(MessageContent::Text { text: shown });
                }
            }
            ContentBlock::Image { mime_type, data } => content.push(MessageContent::Image {
                url: format!("data:{mime_type};base64,{data}"),
            }),
            ContentBlock::Other => {}
        }
    }
    ConversationItem {
        id: id.to_string(),
        observed_at_ms,
        status: ActivityStatus::Completed,
        kind: ItemKind::UserMessage { text, content },
    }
}

/// What a person typed into the composer, as the item the turn opens with.
pub(super) fn prompt_content_of(text: &str, images: &[String]) -> Vec<MessageContent> {
    let mut content = Vec::new();
    if !text.is_empty() {
        content.push(MessageContent::Text {
            text: text.to_string(),
        });
    }
    content.extend(
        images
            .iter()
            .map(|url| MessageContent::Image { url: url.clone() }),
    );
    content
}

pub(super) fn assistant_message_item(
    id: &str,
    text: &str,
    observed_at_ms: Option<u64>,
    status: ActivityStatus,
) -> ConversationItem {
    ConversationItem {
        id: id.to_string(),
        observed_at_ms,
        status,
        kind: ItemKind::AssistantMessage {
            text: text.to_string(),
            phase: None,
        },
    }
}

pub(super) fn reasoning_item(
    id: &str,
    text: &str,
    observed_at_ms: Option<u64>,
    status: ActivityStatus,
) -> ConversationItem {
    ConversationItem {
        id: id.to_string(),
        observed_at_ms,
        status,
        kind: ItemKind::Reasoning {
            summary: Vec::new(),
            content: vec![text.to_string()],
        },
    }
}

pub(super) fn plan_item(
    id: &str,
    entries: &[PlanEntry],
    observed_at_ms: Option<u64>,
) -> ConversationItem {
    let text = entries
        .iter()
        .map(|entry| match entry.status.as_deref() {
            Some("completed") => format!("- [x] {}", entry.content),
            _ => format!("- [ ] {}", entry.content),
        })
        .collect::<Vec<_>>()
        .join("\n");
    ConversationItem {
        id: id.to_string(),
        observed_at_ms,
        status: ActivityStatus::Completed,
        kind: ItemKind::Plan { text },
    }
}

pub(super) fn failure_item(id: &str, text: &str, observed_at_ms: Option<u64>) -> ConversationItem {
    ConversationItem {
        id: id.to_string(),
        observed_at_ms,
        status: ActivityStatus::Failed,
        kind: ItemKind::Failure {
            text: text.to_string(),
        },
    }
}

/// How a turn ended, from the leader's stop reason.
pub(super) fn turn_status(stop_reason: Option<&str>) -> TurnStatus {
    match stop_reason {
        Some("end_turn") | None => TurnStatus::Completed,
        Some("cancelled") => TurnStatus::Interrupted,
        Some(_) => TurnStatus::Failed,
    }
}

/// What to write where the answer would have been, when the turn did not end
/// with one.
pub(super) fn failure_text(stop_reason: &str) -> Option<String> {
    match stop_reason {
        "end_turn" | "cancelled" => None,
        "refusal" => Some("Grok refused to continue this turn.".to_string()),
        "max_tokens" => Some("Grok stopped: the model's output limit was reached.".to_string()),
        "max_turn_requests" => {
            Some("Grok stopped: the turn's request limit was reached.".to_string())
        }
        other => Some(format!("Grok stopped this turn: {other}.")),
    }
}

pub(super) fn token_usage(
    usage: &TurnUsage,
    context_window: Option<u64>,
    session_total: Option<u64>,
) -> TokenUsage {
    let last = TokenCount {
        total_tokens: usage.total_tokens,
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cached_read_tokens,
        cache_write_input_tokens: usage.cache_creation_tokens,
        output_tokens: usage.output_tokens,
        reasoning_output_tokens: usage.reasoning_tokens,
    };
    TokenUsage {
        total: TokenCount {
            total_tokens: session_total.unwrap_or(usage.total_tokens),
            ..last.clone()
        },
        last,
        model_context_window: context_window,
    }
}

/// What the conversation is doing, from what the leader last said.
pub(super) fn thread_status(working: bool, waiting_on_approval: bool) -> ThreadStatus {
    if waiting_on_approval {
        return ThreadStatus::Active {
            active_flags: vec![ThreadActiveFlag::WaitingOnApproval],
        };
    }
    if working {
        return ThreadStatus::Active {
            active_flags: Vec::new(),
        };
    }
    ThreadStatus::Idle
}

/// A permission request, written for a person to read.
///
/// Only the answers Grok can carry out are offered. Denying ends the turn as
/// far as Grok is concerned, so there is no separate "deny and stop"; and
/// Grok's "reject always" is remembered for the project for good, which is
/// not a decision Caffold offers.
pub(super) fn approval_request(
    request: &PermissionRequestParams,
    turn_id: Option<&str>,
    cwd: Option<&str>,
) -> ApprovalRequest {
    let call = &request.tool_call;
    let identity = call.meta.tool.clone().unwrap_or_default();
    let mut decisions = Vec::new();
    let offers = |kind: &str| request.options.iter().any(|option| option.kind == kind);
    if offers(OPTION_ALLOW_ONCE) {
        decisions.push(ApprovalDecision::Allow);
    }
    if offers(OPTION_ALLOW_ALWAYS) {
        decisions.push(ApprovalDecision::AllowAlways);
    }
    if offers(OPTION_REJECT_ONCE) {
        decisions.push(ApprovalDecision::Deny);
    }
    let mut detail = ApprovalDetail::default();
    let title;
    if identity.name == RUN_TERMINAL_COMMAND
        || call.raw_input.get("variant").and_then(Value::as_str) == Some("Bash")
    {
        let command = string_field(&call.raw_input, "command").unwrap_or_default();
        title = format!("Run `{command}`");
        detail.command = Some(command);
        detail.cwd = cwd.map(str::to_string);
    } else if identity.name == USE_TOOL {
        let tool_name =
            string_field(&call.raw_input, "tool_name").unwrap_or_else(|| USE_TOOL.to_string());
        let (server, tool) = tool_name
            .split_once("__")
            .unwrap_or(("", tool_name.as_str()));
        title = format!("Use tool `{tool}`");
        let arguments = call
            .raw_input
            .get("tool_input")
            .and_then(Value::as_object)
            .map(|input| {
                input
                    .iter()
                    .map(|(name, value)| ApprovalArgument {
                        name: name.clone(),
                        label: name.clone(),
                        value: value.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        detail.tool = Some(ApprovalToolDetail {
            server_name: server.to_string(),
            app_name: None,
            description: None,
            arguments,
        });
    } else {
        let name = if identity.name.is_empty() {
            call.title.clone().unwrap_or_else(|| "a tool".to_string())
        } else {
            identity.name.clone()
        };
        title = format!("Use `{name}`");
        let arguments = call
            .raw_input
            .as_object()
            .map(|input| {
                input
                    .iter()
                    .filter(|(key, _)| key.as_str() != "variant")
                    .map(|(name, value)| ApprovalArgument {
                        name: name.clone(),
                        label: name.clone(),
                        value: value.clone(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        detail.tool = Some(ApprovalToolDetail {
            server_name: "grok".to_string(),
            app_name: None,
            description: call.title.clone(),
            arguments,
        });
    }
    ApprovalRequest {
        id: call.tool_call_id.clone(),
        turn_id: turn_id.map(str::to_string),
        item_id: Some(call.tool_call_id.clone()),
        title,
        reason: identity.label.clone(),
        detail,
        decisions,
    }
}

/// Which of the offered options a decision picks, by the kind Grok named.
pub(super) fn option_kind_for(decision: ApprovalDecision) -> Option<&'static str> {
    match decision {
        ApprovalDecision::Allow => Some(OPTION_ALLOW_ONCE),
        ApprovalDecision::AllowAlways => Some(OPTION_ALLOW_ALWAYS),
        ApprovalDecision::Deny => Some(OPTION_REJECT_ONCE),
        ApprovalDecision::AllowForSession
        | ApprovalDecision::Cancel
        | ApprovalDecision::DenyAndStop => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::grok::protocol::{Frame, Update, UpdateParams, read_frame};
    use serde_json::json;

    fn fixture(name: &str) -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent/grok/fixtures")
            .join(name);
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn a_shell_command_reads_as_a_command_with_its_output_and_exit_code() {
        let frames: Vec<Value> =
            serde_json::from_value(fixture("live-turn-with-command.json")).unwrap();
        let mut item: Option<ConversationItem> = None;
        for frame in &frames {
            let Some(Frame::Notification { method, params }) = read_frame(&frame.to_string())
            else {
                continue;
            };
            if method != "session/update" {
                continue;
            }
            let params: UpdateParams = serde_json::from_value(params).unwrap();
            match Update::read(&params.update) {
                Update::ToolCall(call) => item = Some(tool_call_item(&call)),
                Update::ToolCallUpdate(update) => {
                    item = Some(tool_call_update_item(item.as_ref(), &update, false))
                }
                _ => {}
            }
        }
        let item = item.expect("a tool call");
        assert!(item.id.starts_with("call-"));
        assert_eq!(item.status, ActivityStatus::Completed);
        let ItemKind::CommandExecution(command) = item.kind else {
            panic!("a command");
        };
        assert_eq!(command.command.as_deref(), Some("cat probe-marker.txt"));
        assert_eq!(command.exit_code, Some(0));
        assert_eq!(
            command.output.as_deref(),
            Some("exit: 0\nSOURCE_CHECKOUT\n")
        );
        assert!(command.cwd.unwrap().ends_with("/source"));
    }

    #[test]
    fn a_refused_call_reads_as_declined_and_other_tools_keep_their_names() {
        let update: ToolCallUpdate = serde_json::from_value(json!({
            "toolCallId": "call-1", "status": "failed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "User rejected the execution for tool `run_terminal_command`" } }],
            "_meta": { "x.ai/tool": { "name": "run_terminal_command", "kind": "execute" } }
        }))
        .unwrap();
        let before = tool_call_item(&serde_json::from_value(json!({
            "toolCallId": "call-1", "title": "run_terminal_command", "rawInput": { "command": "for i in 1; do echo $i; done" },
            "_meta": { "x.ai/tool": { "name": "run_terminal_command", "kind": "execute" } }
        })).unwrap());
        let declined = tool_call_update_item(Some(&before), &update, true);
        assert_eq!(declined.status, ActivityStatus::Declined);
        let ItemKind::CommandExecution(command) = &declined.kind else {
            panic!()
        };
        assert_eq!(
            command.command.as_deref(),
            Some("for i in 1; do echo $i; done")
        );
        let failed = tool_call_update_item(Some(&before), &update, false);
        assert_eq!(failed.status, ActivityStatus::Failed);

        let mcp = tool_call_item(&serde_json::from_value(json!({
            "toolCallId": "call-2", "title": "caffold__rename_current_task",
            "rawInput": { "variant": "UseTool", "tool_name": "caffold__rename_current_task", "tool_input": { "name": "x" } },
            "_meta": { "x.ai/tool": { "name": "use_tool", "kind": "use_tool" } }
        })).unwrap());
        assert_eq!(
            mcp.kind,
            ItemKind::ToolCall {
                name: "caffold__rename_current_task".to_string()
            }
        );

        let edit = tool_call_update_item(None, &serde_json::from_value(json!({
            "toolCallId": "call-3", "kind": "edit", "status": "completed", "locations": [{ "path": "/w/a.rs" }],
            "_meta": { "x.ai/tool": { "name": "edit_file", "kind": "edit" } }
        })).unwrap(), false);
        assert_eq!(
            edit.kind,
            ItemKind::FileChange {
                paths: vec!["/w/a.rs".to_string()]
            }
        );

        let unknown = tool_call_item(
            &serde_json::from_value(json!({
                "toolCallId": "call-4", "title": "Search tools", "rawInput": { "query": "x" },
                "_meta": { "x.ai/tool": { "name": "search_tool", "kind": "search_tool" } }
            }))
            .unwrap(),
        );
        assert_eq!(
            unknown.kind,
            ItemKind::ToolCall {
                name: "search_tool".to_string()
            }
        );
    }

    #[test]
    fn a_stored_prompt_keeps_the_words_typed_and_the_picture_sent() {
        let text = ContentBlock::Text {
            text:
                "The user sent a message while you were working:\n<user_query>\nhi\n</user_query>"
                    .to_string(),
            display_text: Some("hi".to_string()),
        };
        let image = ContentBlock::Image {
            mime_type: "image/png".to_string(),
            data: "AAAA".to_string(),
        };
        let item = user_message_item("e-2", &[text, image], Some(5));
        let ItemKind::UserMessage { text, content } = item.kind else {
            panic!()
        };
        assert_eq!(text, "hi");
        assert_eq!(content.len(), 2);
        assert_eq!(
            content[1],
            MessageContent::Image {
                url: "data:image/png;base64,AAAA".to_string()
            }
        );
        assert_eq!(item.observed_at_ms, Some(5));
    }

    #[test]
    fn a_permission_request_is_written_for_a_person_with_only_the_answers_grok_carries_out() {
        let frame = fixture("request-permission.json");
        let request: PermissionRequestParams =
            serde_json::from_value(frame["params"].clone()).unwrap();
        let approval = approval_request(&request, Some("prompt-1"), Some("/work"));
        assert_eq!(approval.id, request.tool_call.tool_call_id);
        assert_eq!(
            approval.item_id.as_deref(),
            Some(request.tool_call.tool_call_id.as_str())
        );
        assert_eq!(approval.turn_id.as_deref(), Some("prompt-1"));
        assert_eq!(
            approval.title,
            "Run `for i in 1 2 3; do echo tick $i; sleep 1; done`"
        );
        assert_eq!(
            approval.detail.command.as_deref(),
            Some("for i in 1 2 3; do echo tick $i; sleep 1; done")
        );
        assert_eq!(approval.detail.cwd.as_deref(), Some("/work"));
        assert_eq!(
            approval.decisions,
            [
                ApprovalDecision::Allow,
                ApprovalDecision::AllowAlways,
                ApprovalDecision::Deny
            ]
        );
        assert_eq!(option_kind_for(ApprovalDecision::DenyAndStop), None);
        assert_eq!(
            option_kind_for(ApprovalDecision::Deny),
            Some(OPTION_REJECT_ONCE)
        );

        let mcp: PermissionRequestParams = serde_json::from_value(json!({
            "sessionId": "s",
            "toolCall": { "toolCallId": "call-9", "kind": "other", "title": "caffold-probe__probe_echo",
                "rawInput": { "variant": "UseTool", "tool_name": "caffold-probe__probe_echo", "tool_input": { "text": "ping" } },
                "_meta": { "x.ai/tool": { "name": "use_tool", "kind": "use_tool", "label": "Use Tool" } } },
            "options": [{ "optionId": "allow-once", "name": "allow once", "kind": "allow_once" },
                        { "optionId": "reject-once", "name": "reject once", "kind": "reject_once" }]
        }))
        .unwrap();
        let approval = approval_request(&mcp, None, None);
        assert_eq!(approval.title, "Use tool `probe_echo`");
        let tool = approval.detail.tool.unwrap();
        assert_eq!(tool.server_name, "caffold-probe");
        assert_eq!(tool.arguments[0].name, "text");
        assert_eq!(
            approval.decisions,
            [ApprovalDecision::Allow, ApprovalDecision::Deny]
        );
    }

    #[test]
    fn stop_reasons_become_turn_outcomes() {
        assert_eq!(turn_status(Some("end_turn")), TurnStatus::Completed);
        assert_eq!(turn_status(Some("cancelled")), TurnStatus::Interrupted);
        assert_eq!(turn_status(Some("refusal")), TurnStatus::Failed);
        assert!(failure_text("end_turn").is_none());
        assert!(failure_text("max_tokens").unwrap().contains("output limit"));
        assert_eq!(
            thread_status(true, false),
            ThreadStatus::Active {
                active_flags: vec![]
            }
        );
        assert_eq!(
            thread_status(false, true),
            ThreadStatus::Active {
                active_flags: vec![ThreadActiveFlag::WaitingOnApproval]
            }
        );
        assert_eq!(thread_status(false, false), ThreadStatus::Idle);
    }

    #[test]
    fn usage_is_counted_in_caffolds_words() {
        let usage = TurnUsage {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            cached_read_tokens: 40,
            cache_creation_tokens: 0,
            reasoning_tokens: 3,
        };
        let counted = token_usage(&usage, Some(500_000), Some(2_000));
        assert_eq!(counted.last.input_tokens, 100);
        assert_eq!(counted.last.reasoning_output_tokens, 3);
        assert_eq!(counted.total.total_tokens, 2_000);
        assert_eq!(counted.model_context_window, Some(500_000));
    }
}
