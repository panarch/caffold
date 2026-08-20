//! What this driver presents to the rest of Caffold, and what it accepts back.
//!
//! Codex's own types describe what app-server says; this module says what
//! Caffold promises above the driver. Keeping both directions here rather than
//! beside each wire type means one file answers what the adapter carries, and
//! the protocol module stays a description of Codex alone.
//!
//! Reading a conversation is the larger half. Codex reports work as one typed
//! item per capability — a command execution, a file change, a web search —
//! and eighteen of those exist today. Caffold renders seven of them with a
//! surface of their own; the rest become [`ItemKind::ToolCall`], named after
//! whatever Codex called them. Nothing is dropped for being unrecognized, so a
//! kind added to app-server arrives as work Caffold can show rather than as a
//! gap in the conversation.
//!
//! Answering an approval is the smaller half and runs the other way. Caffold's
//! four decisions become Codex's response for the request that asked, and
//! "allow always" hands back the permission profile Codex itself proposed
//! rather than one Caffold composed.

use serde_json::{Value, json};

use super::protocol::{
    CodexThread, CodexTurn, ThreadActiveFlag, ThreadStatus, TurnStatus, TurnsPage, seconds_to_ms,
    seconds_to_ms_value,
};
use crate::agent::{
    ActivityStatus, ApprovalDecision, ApprovalDetail, ApprovalRequest, CommandExecution,
    Conversation, ConversationItem, GeneratedImage, ItemKind, MessageContent, MessagePhase,
    PermissionRow, Turn, TurnPage,
};

impl From<&CodexThread> for Conversation {
    fn from(thread: &CodexThread) -> Self {
        Self {
            id: thread.id.clone(),
            title: thread.name.clone(),
            preview: thread.preview.clone(),
            status: thread.status.clone().into(),
            cwd: thread.cwd.clone(),
            transcript_path: thread.path.clone(),
            // Codex counts in seconds and Caffold in milliseconds. Converting
            // here is what keeps the rest of Caffold from having to know which
            // agent it is talking to in order to read a timestamp.
            created_at_ms: seconds_to_ms(Some(thread.created_at)),
            updated_at_ms: seconds_to_ms(Some(thread.updated_at)),
            recency_at_ms: thread.recency_at.map(seconds_to_ms_value),
            turns: thread.turns.iter().map(Turn::from).collect(),
        }
    }
}

impl From<&TurnsPage> for TurnPage {
    fn from(page: &TurnsPage) -> Self {
        Self {
            turns: page.data.iter().map(Turn::from).collect(),
            next_cursor: page.next_cursor.clone(),
            backwards_cursor: page.backwards_cursor.clone(),
        }
    }
}

impl From<&CodexTurn> for Turn {
    fn from(turn: &CodexTurn) -> Self {
        Self {
            id: turn.id.clone(),
            status: turn.status.into(),
            started_at_ms: turn.started_at.map(seconds_to_ms_value).filter(is_a_time),
            completed_at_ms: turn.completed_at.map(seconds_to_ms_value).filter(is_a_time),
            items: turn
                .items
                .iter()
                // A turn read back is a turn that already happened. Items still
                // running say so themselves through their own status.
                .filter_map(|item| conversation_item(item, ActivityStatus::Completed))
                .collect(),
        }
    }
}

/// One Codex thread item, as the conversation shows it.
///
/// Codex sends items as open JSON rather than a closed union, so this reads
/// what it recognizes and treats the rest as a tool call. `None` means the
/// value was not an item at all: without an identity a live update and a later
/// read of the same work cannot be recognized as one entry, and two different
/// items cannot be told apart.
///
/// `reported` is how far along the notification carrying this item says it is.
/// Codex reports work status on the items that have work to do and says nothing
/// for the rest, so a message or a piece of reasoning takes its status from
/// whether Codex announced it as starting or as finished.
pub(crate) fn conversation_item(
    item: &Value,
    reported: ActivityStatus,
) -> Option<ConversationItem> {
    let item_type = item.get("type").and_then(Value::as_str)?;
    let id = text_field(item, "id")?;
    let status = activity_status(item).unwrap_or(reported);
    let kind = match item_type {
        "userMessage" => ItemKind::UserMessage {
            text: user_message_text(item),
            content: message_content(item),
        },
        "agentMessage" => ItemKind::AssistantMessage {
            text: text_field(item, "text").unwrap_or_default(),
            phase: message_phase(item),
        },
        "reasoning" => ItemKind::Reasoning {
            summary: string_array(item.get("summary")),
            content: string_array(item.get("content")),
        },
        "plan" => ItemKind::Plan {
            text: text_field(item, "text").unwrap_or_default(),
        },
        "commandExecution" => ItemKind::CommandExecution(CommandExecution {
            command: text_field(item, "command"),
            cwd: text_field(item, "cwd"),
            output: text_field(item, "aggregatedOutput"),
            exit_code: item.get("exitCode").and_then(Value::as_i64),
            duration_ms: item.get("durationMs").and_then(Value::as_u64),
        }),
        "fileChange" => ItemKind::FileChange {
            paths: changed_paths(item),
        },
        "imageGeneration" => ItemKind::GeneratedImage(GeneratedImage {
            revised_prompt: text_field(item, "revisedPrompt"),
            saved_path: text_field(item, "savedPath"),
            encoded: text_field(item, "result"),
        }),
        _ => ItemKind::ToolCall {
            name: tool_call_name(item, item_type),
        },
    };
    Some(ConversationItem { id, status, kind })
}

/// One item from Codex's raw model-output stream.
///
/// Codex mirrors some items a second time in the shape the model returned them,
/// under the same item id. Recognizing only what maps onto an item Caffold
/// already shows is deliberate: an unrecognized entry here is a second view of
/// work the thread stream already reported, so treating it as a tool call the
/// way an unknown thread item is treated would draw that work twice.
pub(crate) fn response_item(item: &Value) -> Option<ConversationItem> {
    let id = text_field(item, "id")?;
    let kind = match item.get("type").and_then(Value::as_str)? {
        "message" if item.get("role").and_then(Value::as_str) == Some("assistant") => {
            ItemKind::AssistantMessage {
                text: response_text(item.get("content")),
                phase: message_phase(item),
            }
        }
        "reasoning" => ItemKind::Reasoning {
            summary: response_summary(item.get("summary")),
            content: response_reasoning(item.get("content")),
        },
        "image_generation_call" => ItemKind::GeneratedImage(GeneratedImage {
            revised_prompt: text_field(item, "revised_prompt"),
            saved_path: text_field(item, "savedPath"),
            encoded: text_field(item, "result"),
        }),
        _ => return None,
    };
    Some(ConversationItem {
        id,
        status: ActivityStatus::Completed,
        kind,
    })
}

/// A pending Codex approval, as the interface asks it.
///
/// The three request methods differ in what they carry, and this reads all of
/// them into one shape: whichever specifics the request actually has, plus the
/// answers Codex accepts for that method.
pub(crate) fn approval_request(
    approval_id: String,
    kind: ApprovalKind,
    params: &Value,
) -> ApprovalRequest {
    let command = text_field(params, "command");
    let network_endpoint = network_endpoint(params.get("networkApprovalContext"));
    let mut permissions = permission_rows(params.get("permissions"));
    permissions.extend(permission_rows(params.get("additionalPermissions")));
    ApprovalRequest {
        id: approval_id,
        turn_id: text_field(params, "turnId"),
        item_id: text_field(params, "itemId"),
        title: approval_title(kind, command.is_some(), network_endpoint.is_some()).to_string(),
        reason: text_field(params, "reason"),
        detail: ApprovalDetail {
            command,
            cwd: text_field(params, "cwd"),
            network_endpoint,
            permissions,
            grant_root: text_field(params, "grantRoot"),
            environment: text_field(params, "environmentId"),
        },
        decisions: kind.decisions(params),
    }
}

/// The response Codex expects for one decision.
///
/// Allowing a permission request returns the profile the request itself
/// carried: Codex asked for exactly that access, and the scope is the whole of
/// what "always" means to it.
pub(crate) fn approval_response(
    kind: ApprovalKind,
    params: &Value,
    decision: ApprovalDecision,
) -> Option<Value> {
    match kind {
        ApprovalKind::Permission => {
            let scope = match decision {
                ApprovalDecision::Allow => "turn",
                ApprovalDecision::AllowAlways => "session",
                ApprovalDecision::Deny => return Some(json!({ "permissions": {} })),
                // Codex's permission response has no way to end the turn.
                ApprovalDecision::DenyAndStop => return None,
            };
            let permissions = params
                .get("permissions")
                .filter(|value| value.is_object())?;
            Some(json!({ "permissions": permissions, "scope": scope }))
        }
        ApprovalKind::Command | ApprovalKind::FileChange => {
            let decision = match decision {
                ApprovalDecision::Allow => "accept",
                ApprovalDecision::AllowAlways => "acceptForSession",
                ApprovalDecision::Deny => "decline",
                ApprovalDecision::DenyAndStop => "cancel",
            };
            Some(json!({ "decision": decision }))
        }
    }
}

/// Which of Codex's three approval requests is being answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApprovalKind {
    Command,
    FileChange,
    Permission,
}

impl ApprovalKind {
    /// The answers this request accepts.
    ///
    /// A command or file change advertises its own list, and Codex is trusted
    /// on that: a request that omits an answer will not accept it. A permission
    /// request carries no list, and Codex's response type has no way to stop a
    /// turn, so refusing it always lets the turn continue.
    fn decisions(self, params: &Value) -> Vec<ApprovalDecision> {
        if self == Self::Permission {
            return vec![
                ApprovalDecision::Allow,
                ApprovalDecision::AllowAlways,
                ApprovalDecision::Deny,
            ];
        }
        let Some(available) = params.get("availableDecisions").and_then(Value::as_array) else {
            return vec![
                ApprovalDecision::Allow,
                ApprovalDecision::AllowAlways,
                ApprovalDecision::Deny,
                ApprovalDecision::DenyAndStop,
            ];
        };
        available
            .iter()
            .filter_map(Value::as_str)
            .filter_map(|decision| match decision {
                "accept" => Some(ApprovalDecision::Allow),
                "acceptForSession" => Some(ApprovalDecision::AllowAlways),
                "decline" => Some(ApprovalDecision::Deny),
                "cancel" => Some(ApprovalDecision::DenyAndStop),
                // Codex also offers policy amendments, which propose a rule
                // rather than answer the question. Caffold has no surface for
                // composing one, so it does not offer half of it.
                _ => None,
            })
            .collect()
    }
}

fn approval_title(kind: ApprovalKind, has_command: bool, has_network: bool) -> &'static str {
    match kind {
        ApprovalKind::Permission => "Permission requested",
        ApprovalKind::FileChange => "File change requested",
        ApprovalKind::Command if has_network && !has_command => "Network access requested",
        ApprovalKind::Command => "Command approval requested",
    }
}

// Codex's status values and Caffold's agree today, because Caffold's vocabulary
// was drawn from the first agent it drove. Converting anyway is the point: what
// the browser is promised stops moving when Codex changes, and a second driver
// maps to Caffold's values rather than to Codex's.

impl From<ThreadStatus> for crate::agent::ThreadStatus {
    fn from(status: ThreadStatus) -> Self {
        match status {
            ThreadStatus::NotLoaded => Self::NotLoaded,
            ThreadStatus::Idle => Self::Idle,
            ThreadStatus::SystemError => Self::SystemError,
            ThreadStatus::Active { active_flags } => Self::Active {
                active_flags: active_flags.into_iter().map(Into::into).collect(),
            },
        }
    }
}

impl From<ThreadActiveFlag> for crate::agent::ThreadActiveFlag {
    fn from(flag: ThreadActiveFlag) -> Self {
        match flag {
            ThreadActiveFlag::WaitingOnApproval => Self::WaitingOnApproval,
            ThreadActiveFlag::WaitingOnUserInput => Self::WaitingOnUserInput,
        }
    }
}

impl From<TurnStatus> for crate::agent::TurnStatus {
    fn from(status: TurnStatus) -> Self {
        match status {
            TurnStatus::Completed => Self::Completed,
            TurnStatus::Interrupted => Self::Interrupted,
            TurnStatus::Failed => Self::Failed,
            TurnStatus::InProgress => Self::InProgress,
        }
    }
}

/// What to call work Caffold does not draw a surface for.
///
/// A tool call names its tool, which is the useful thing to show. The rest are
/// activities rather than tools, and their Codex type name would mean nothing
/// to a reader, so each says what it is.
fn tool_call_name(item: &Value, item_type: &str) -> String {
    if let Some(tool) = text_field(item, "tool") {
        return tool;
    }
    match item_type {
        "webSearch" => "Web search",
        "imageView" => "Viewing an image",
        "sleep" => "Waiting",
        "contextCompaction" => "Compacting context",
        "subAgentActivity" => "Working with a subagent",
        "hookPrompt" => "Running a hook",
        "enteredReviewMode" => "Entering review",
        "exitedReviewMode" => "Leaving review",
        other => other,
    }
    .to_string()
}

/// How Codex says a piece of work is going, when the item is a kind that has
/// work to report on.
///
/// `None` is not "unknown": it is Codex saying nothing, which is what it does
/// for messages, reasoning, and plans. The caller supplies what the notification
/// carrying the item implied instead.
fn activity_status(item: &Value) -> Option<ActivityStatus> {
    match item.get("status").and_then(Value::as_str)? {
        "inProgress" => Some(ActivityStatus::InProgress),
        "failed" => Some(ActivityStatus::Failed),
        "declined" => Some(ActivityStatus::Declined),
        "completed" => Some(ActivityStatus::Completed),
        // A status Codex added since. Reporting the work as finished would
        // claim an outcome; leaving it to the notification says only what
        // Caffold actually observed.
        _ => None,
    }
}

fn message_phase(item: &Value) -> Option<MessagePhase> {
    match item.get("phase").and_then(Value::as_str)? {
        "commentary" => Some(MessagePhase::Progress),
        // `final` predates `final_answer` and still arrives from older models.
        "final_answer" | "final" => Some(MessagePhase::Final),
        _ => None,
    }
}

/// A prompt's text, which Codex may have split across several entries.
fn user_message_text(item: &Value) -> String {
    content_entries(item)
        .filter_map(|entry| match entry.get("type").and_then(Value::as_str) {
            Some("text" | "input_text") => entry.get("text").and_then(Value::as_str),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// What a prompt carried, keeping only what the conversation can show.
///
/// Codex also accepts audio, skills, and file mentions in a prompt. Caffold
/// renders none of them, and listing them here without a surface would claim a
/// display it does not have.
fn message_content(item: &Value) -> Vec<MessageContent> {
    content_entries(item)
        .filter_map(|entry| {
            let text = |key| entry.get(key).and_then(Value::as_str).map(str::to_string);
            match entry.get("type").and_then(Value::as_str)? {
                "text" | "input_text" => Some(MessageContent::Text {
                    text: text("text")?,
                }),
                "image" => Some(MessageContent::Image { url: text("url")? }),
                "localImage" => Some(MessageContent::LocalImage {
                    path: text("path")?,
                }),
                _ => None,
            }
        })
        .collect()
}

/// Assistant text from the model's own output shape, which labels its parts
/// differently from a thread item's.
fn response_text(content: Option<&Value>) -> String {
    array(content)
        .filter_map(|entry| match entry.get("type").and_then(Value::as_str) {
            Some("output_text") => entry.get("text").and_then(Value::as_str),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn response_summary(summary: Option<&Value>) -> Vec<String> {
    array(summary)
        .filter_map(|entry| match entry.get("type").and_then(Value::as_str) {
            Some("summary_text") => entry.get("text").and_then(Value::as_str),
            _ => None,
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

/// Reasoning bodies, which arrive as bare strings on some models and as
/// objects on others.
fn response_reasoning(content: Option<&Value>) -> Vec<String> {
    array(content)
        .filter_map(|entry| {
            entry.as_str().or_else(|| {
                entry
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| entry.get("content").and_then(Value::as_str))
            })
        })
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn content_entries(item: &Value) -> impl Iterator<Item = &Value> {
    item.get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// The paths a file change touched.
///
/// Codex sends the diff alongside each path. Caffold reviews changes from git,
/// which owns the working tree the agent actually wrote to, so the diff would
/// be a second and staler source of the same thing.
fn changed_paths(item: &Value) -> Vec<String> {
    item.get("changes")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|change| {
            change
                .get("path")
                .and_then(Value::as_str)
                .or_else(|| change.as_str())
        })
        .map(str::to_string)
        .collect()
}

fn network_endpoint(context: Option<&Value>) -> Option<String> {
    let context = context?;
    let protocol = text_field(context, "protocol");
    let host = text_field(context, "host");
    match (protocol, host) {
        (Some(protocol), Some(host)) => Some(format!("{protocol}://{host}")),
        (Some(only), None) | (None, Some(only)) => Some(only),
        (None, None) => None,
    }
}

/// A Codex permission profile, written out for someone deciding on it.
fn permission_rows(profile: Option<&Value>) -> Vec<PermissionRow> {
    let Some(profile) = profile.filter(|profile| profile.is_object()) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    if let Some(network) = profile.get("network").filter(|value| value.is_object()) {
        let enabled = network.get("enabled").and_then(Value::as_bool) != Some(false);
        rows.push(PermissionRow {
            label: "Network".to_string(),
            value: if enabled {
                "Outbound access"
            } else {
                "Disabled"
            }
            .to_string(),
            verbatim: false,
        });
    }
    let Some(file_system) = profile.get("fileSystem").filter(|value| value.is_object()) else {
        return rows;
    };
    for entry in array(file_system.get("entries")) {
        rows.push(PermissionRow {
            label: format!("File system · {}", permission_access(entry.get("access"))),
            value: permission_path(entry.get("path")),
            verbatim: true,
        });
    }
    // Codex still sends flat read and write lists alongside `entries`, and its
    // own schema says they are on the way out. Reading both means a profile
    // stays fully described whichever form it arrives in.
    for (access, key) in [("Read", "read"), ("Write", "write")] {
        for path in array(file_system.get(key)) {
            rows.push(PermissionRow {
                label: format!("File system · {access}"),
                value: path.as_str().unwrap_or_default().to_string(),
                verbatim: true,
            });
        }
    }
    if let Some(depth) = file_system.get("globScanMaxDepth").and_then(Value::as_u64) {
        rows.push(PermissionRow {
            label: "Glob scan depth".to_string(),
            value: depth.to_string(),
            verbatim: false,
        });
    }
    rows
}

fn permission_access(access: Option<&Value>) -> &'static str {
    match access.and_then(Value::as_str) {
        Some("read") => "Read",
        Some("write") => "Write",
        Some("deny") => "Deny",
        _ => "Access",
    }
}

/// One path from a permission profile, however Codex expressed it.
fn permission_path(path: Option<&Value>) -> String {
    let Some(path) = path else {
        return "(path unavailable)".to_string();
    };
    match path.get("type").and_then(Value::as_str) {
        Some("path") => text_field(path, "path").unwrap_or_default(),
        Some("glob_pattern") => text_field(path, "pattern").unwrap_or_default(),
        Some("special") => {
            let value = path.get("value").unwrap_or(&Value::Null);
            let kind = text_field(value, "kind").unwrap_or_else(|| "special".to_string());
            match text_field(value, "subpath").or_else(|| text_field(value, "path")) {
                Some(detail) => format!("{kind}: {detail}"),
                None => kind,
            }
        }
        // A shape Codex added and this has not learned yet. Showing it raw is
        // worse than showing nothing only if it is hidden; a person approving
        // access should see that something is there.
        _ => path.to_string(),
    }
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    array(value)
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn array(value: Option<&Value>) -> impl Iterator<Item = &Value> {
    value.and_then(Value::as_array).into_iter().flatten()
}

fn is_a_time(value: &u64) -> bool {
    *value > 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every item type in the Codex v2 schema, so that adding a surface for one
    /// is a deliberate change here rather than a silent reclassification.
    const EVERY_ITEM_TYPE: [&str; 18] = [
        "userMessage",
        "hookPrompt",
        "agentMessage",
        "plan",
        "reasoning",
        "commandExecution",
        "fileChange",
        "mcpToolCall",
        "dynamicToolCall",
        "collabAgentToolCall",
        "subAgentActivity",
        "webSearch",
        "imageView",
        "sleep",
        "imageGeneration",
        "enteredReviewMode",
        "exitedReviewMode",
        "contextCompaction",
    ];

    #[test]
    fn every_codex_item_becomes_something_the_conversation_can_show() {
        // The conversation loses nothing to an item type it has no surface for.
        // That is what lets app-server grow its item union without Caffold
        // silently dropping the work an agent did.
        for item_type in EVERY_ITEM_TYPE {
            let item = json!({ "type": item_type, "id": "item_1" });

            let decoded = conversation_item(&item, ActivityStatus::Completed)
                .unwrap_or_else(|| panic!("{item_type} produced no conversation item"));

            assert_eq!(decoded.id, "item_1");
        }
    }

    #[test]
    fn an_item_type_codex_adds_later_arrives_as_a_tool_call() {
        let item = json!({ "type": "somethingNew", "id": "item_1", "tool": "inspector" });

        let decoded = conversation_item(&item, ActivityStatus::InProgress)
            .expect("an unknown item is still an item");

        assert_eq!(
            decoded.kind,
            ItemKind::ToolCall {
                name: "inspector".to_string()
            }
        );
        // Codex says nothing about this item's own progress, so the item is as
        // far along as the notification that carried it.
        assert_eq!(decoded.status, ActivityStatus::InProgress);
    }

    #[test]
    fn an_item_without_an_identity_is_not_an_item() {
        // Every item Caffold shows has to be addressable, because a live update
        // and a later read of the same work merge by that identity.
        let complete = ActivityStatus::Completed;
        assert!(conversation_item(&json!({ "type": "agentMessage" }), complete).is_none());
        assert!(conversation_item(&json!({ "id": "item_1" }), complete).is_none());
        assert!(
            conversation_item(&json!({ "type": "agentMessage", "id": " " }), complete).is_none()
        );
    }

    #[test]
    fn a_declined_command_is_finished_rather_than_running() {
        let item = json!({
            "type": "commandExecution",
            "id": "item_1",
            "command": "rm -rf /",
            "status": "declined",
        });

        let decoded = conversation_item(&item, ActivityStatus::Completed).expect("a command item");

        assert!(matches!(decoded.kind, ItemKind::CommandExecution(_)));
        assert_eq!(decoded.status, ActivityStatus::Declined);
    }

    #[test]
    fn a_prompt_keeps_its_text_and_its_images_separately() {
        let item = json!({
            "type": "userMessage",
            "id": "item_1",
            "content": [
                { "type": "text", "text": "look at this" },
                { "type": "image", "url": "data:image/png;base64,AAA" },
                { "type": "localImage", "path": "/tmp/shot.png" },
                { "type": "mention", "name": "notes", "path": "/notes.md" },
            ],
        });

        let ItemKind::UserMessage { text, content } =
            conversation_item(&item, ActivityStatus::Completed)
                .expect("a user message")
                .kind
        else {
            panic!("a user message item is a user message");
        };
        assert_eq!(text, "look at this");
        assert_eq!(
            content,
            vec![
                MessageContent::Text {
                    text: "look at this".to_string()
                },
                MessageContent::Image {
                    url: "data:image/png;base64,AAA".to_string()
                },
                MessageContent::LocalImage {
                    path: "/tmp/shot.png".to_string()
                },
            ]
        );
    }

    #[test]
    fn a_file_change_carries_paths_without_their_diffs() {
        let item = json!({
            "type": "fileChange",
            "id": "item_1",
            "status": "completed",
            "changes": [
                { "path": "src/main.rs", "kind": { "type": "update" }, "diff": "@@ -1 +1 @@" },
                { "path": "README.md", "kind": { "type": "add" }, "diff": "@@ -0,0 +1 @@" },
            ],
        });

        let ItemKind::FileChange { paths } = conversation_item(&item, ActivityStatus::Completed)
            .expect("a file change")
            .kind
        else {
            panic!("a file change item is a file change");
        };
        assert_eq!(paths, vec!["src/main.rs", "README.md"]);
    }

    #[test]
    fn a_permission_profile_becomes_rows_a_person_can_check() {
        let params = json!({
            "turnId": "turn_1",
            "itemId": "item_1",
            "permissions": {
                "network": { "enabled": false },
                "fileSystem": {
                    "entries": [
                        { "access": "write", "path": { "type": "path", "path": "/work" } },
                        { "access": "read", "path": { "type": "glob_pattern", "pattern": "**/*.rs" } },
                        { "access": "deny", "path": { "type": "special", "value": { "kind": "home", "subpath": ".ssh" } } },
                    ],
                    "read": ["/etc/hosts"],
                    "globScanMaxDepth": 4,
                },
            },
        });

        let request = approval_request("approval_1".to_string(), ApprovalKind::Permission, &params);

        let rows = request
            .detail
            .permissions
            .iter()
            .map(|row| (row.label.as_str(), row.value.as_str()))
            .collect::<Vec<_>>();
        assert_eq!(
            rows,
            vec![
                ("Network", "Disabled"),
                ("File system · Write", "/work"),
                ("File system · Read", "**/*.rs"),
                ("File system · Deny", "home: .ssh"),
                ("File system · Read", "/etc/hosts"),
                ("Glob scan depth", "4"),
            ]
        );
    }

    #[test]
    fn a_command_request_offers_only_what_codex_accepts() {
        let params = json!({
            "turnId": "turn_1",
            "command": "cargo test",
            "availableDecisions": ["accept", "decline"],
        });

        let request = approval_request("approval_1".to_string(), ApprovalKind::Command, &params);

        assert_eq!(
            request.decisions,
            vec![ApprovalDecision::Allow, ApprovalDecision::Deny]
        );
        assert_eq!(request.title, "Command approval requested");
    }

    #[test]
    fn a_network_request_without_a_command_says_so() {
        let params = json!({
            "turnId": "turn_1",
            "networkApprovalContext": { "protocol": "https", "host": "example.com" },
        });

        let request = approval_request("approval_1".to_string(), ApprovalKind::Command, &params);

        assert_eq!(request.title, "Network access requested");
        assert_eq!(
            request.detail.network_endpoint.as_deref(),
            Some("https://example.com")
        );
    }

    #[test]
    fn allowing_a_permission_returns_the_profile_codex_asked_for() {
        // Caffold never composes a grant. Saying yes always means yes to what
        // was requested, so the agent's own permission model stays intact.
        let permissions = json!({ "fileSystem": { "read": ["/work"] } });
        let params = json!({ "permissions": permissions });

        let once = approval_response(ApprovalKind::Permission, &params, ApprovalDecision::Allow);
        let always = approval_response(
            ApprovalKind::Permission,
            &params,
            ApprovalDecision::AllowAlways,
        );

        assert_eq!(
            once,
            Some(json!({ "permissions": permissions, "scope": "turn" }))
        );
        assert_eq!(
            always,
            Some(json!({ "permissions": permissions, "scope": "session" }))
        );
    }

    #[test]
    fn every_decision_reaches_codex_as_one_of_its_own() {
        let params = json!({});
        let expected = [
            (ApprovalDecision::Allow, "accept"),
            (ApprovalDecision::AllowAlways, "acceptForSession"),
            (ApprovalDecision::Deny, "decline"),
            (ApprovalDecision::DenyAndStop, "cancel"),
        ];

        for (decision, codex_decision) in expected {
            let response = approval_response(ApprovalKind::Command, &params, decision);

            assert_eq!(response, Some(json!({ "decision": codex_decision })));
        }
    }

    /// Every Codex status, so a variant added to one side without the other
    /// fails here rather than reaching a browser that cannot read it.
    fn every_thread_status() -> [ThreadStatus; 6] {
        [
            ThreadStatus::NotLoaded,
            ThreadStatus::Idle,
            ThreadStatus::SystemError,
            ThreadStatus::Active {
                active_flags: Vec::new(),
            },
            ThreadStatus::Active {
                active_flags: vec![ThreadActiveFlag::WaitingOnApproval],
            },
            ThreadStatus::Active {
                active_flags: vec![ThreadActiveFlag::WaitingOnUserInput],
            },
        ]
    }

    const EVERY_TURN_STATUS: [TurnStatus; 4] = [
        TurnStatus::Completed,
        TurnStatus::Interrupted,
        TurnStatus::Failed,
        TurnStatus::InProgress,
    ];

    #[test]
    fn a_converted_thread_status_reaches_the_browser_unchanged() {
        // The browser reads this value, so moving ownership of the type must not
        // move the value. Comparing the serialized forms is the check, since
        // that is what actually crosses.
        for status in every_thread_status() {
            let expected = serde_json::to_value(&status).expect("encode Codex status");
            let converted = serde_json::to_value(crate::agent::ThreadStatus::from(status.clone()))
                .expect("encode");

            assert_eq!(converted, expected, "{status:?} changed on the wire");
        }
    }

    #[test]
    fn a_converted_turn_status_reaches_the_browser_unchanged() {
        for status in EVERY_TURN_STATUS {
            let expected = serde_json::to_value(status).expect("encode Codex status");
            let converted =
                serde_json::to_value(crate::agent::TurnStatus::from(status)).expect("encode");

            assert_eq!(converted, expected, "{status:?} changed on the wire");
        }
    }
}
