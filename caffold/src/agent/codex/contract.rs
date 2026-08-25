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
    CodexNotification, CodexPermissionMode, CodexThread, CodexTurn, ThreadActiveFlag, ThreadStatus,
    ThreadTokenUsage, TokenUsageBreakdown, TurnStatus, TurnsPage, seconds_to_ms,
    seconds_to_ms_value,
};
use super::{CodexThreadClient, CodexThreadError, CodexTurnOptions, NORMAL_SERVICE_TIER_ID};
use crate::agent::driver::{ModelOption, PermissionModeOption, TurnOptions, TurnRejected, bounded};
use crate::agent::{
    ActivityStatus, ApprovalDecision, ApprovalDetail, ApprovalRequest, CommandExecution,
    Conversation, ConversationItem, GeneratedImage, ItemKind, MessageContent, MessagePhase,
    PermissionRow, SessionEvent, SessionEventKind, TokenCount, TokenUsage, Turn, TurnOrigin,
    TurnPage,
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
            // Codex's turn record does not say what opened it. Most are user
            // prompts, but that expectation is not evidence carried here.
            origin: TurnOrigin::Unknown,
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

/// What one app-server notification means.
///
/// Codex pushes twelve kinds of notification while a thread is subscribed;
/// this says what each one is in Caffold's vocabulary, so that the parts of
/// Caffold reacting to it — the conversation, the Task list, Web Push, pending
/// approvals — read one report rather than each interpreting Codex's own.
///
/// `None` is a notification Caffold does nothing with, including one from a
/// version of app-server that knows more than this does.
///
/// Approvals are the one kind that needs the connection: which approval a
/// self-resolved request belonged to is a routing question, and routing is the
/// driver's.
pub(crate) async fn session_event(
    notification: &CodexNotification,
    client: &super::CodexThreadClient,
) -> Option<SessionEvent> {
    let (thread_id, kind) = match notification {
        CodexNotification::ThreadStarted { thread } => (
            thread.id.clone(),
            SessionEventKind::ConversationStarted {
                conversation: Conversation::from(thread),
            },
        ),
        CodexNotification::ThreadStatusChanged { thread_id, status } => (
            thread_id.clone(),
            SessionEventKind::StatusChanged {
                status: status.clone().into(),
            },
        ),
        CodexNotification::ThreadNameUpdated {
            thread_id,
            thread_name,
        } => (
            thread_id.clone(),
            SessionEventKind::TitleChanged {
                title: thread_name.clone(),
            },
        ),
        CodexNotification::ThreadSettingsUpdated {
            thread_id,
            thread_settings,
        } => (
            thread_id.clone(),
            SessionEventKind::SettingsChanged {
                settings: thread_settings.clone(),
            },
        ),
        CodexNotification::ThreadTokenUsageUpdated {
            thread_id,
            turn_id,
            token_usage,
        } => (
            thread_id.clone(),
            SessionEventKind::UsageReported {
                turn_id: turn_id.clone(),
                usage: token_usage.into(),
            },
        ),
        CodexNotification::TurnStarted { thread_id, turn } => (
            thread_id.clone(),
            SessionEventKind::TurnStarted {
                turn: Turn::from(turn),
            },
        ),
        CodexNotification::TurnCompleted { thread_id, turn } => (
            thread_id.clone(),
            SessionEventKind::TurnEnded {
                turn: Turn::from(turn),
            },
        ),
        // An item is announced when it starts and again when it finishes. Codex
        // reports work status only for the kinds that have work to report, so
        // which announcement this is stands in for the rest.
        CodexNotification::ItemStarted {
            thread_id,
            turn_id,
            item,
            started_at_ms,
        } => (
            thread_id.clone(),
            item_changed(
                turn_id,
                conversation_item(item, ActivityStatus::InProgress)?,
                *started_at_ms,
            ),
        ),
        CodexNotification::ItemCompleted {
            thread_id,
            turn_id,
            item,
            completed_at_ms,
        } => (
            thread_id.clone(),
            item_changed(
                turn_id,
                conversation_item(item, ActivityStatus::Completed)?,
                *completed_at_ms,
            ),
        ),
        // Codex mirrors some finished items a second time in the shape the
        // model returned them. Both announcements are the same item, so both
        // arrive as the same report — this one without a time of its own.
        CodexNotification::RawResponseItemCompleted {
            thread_id,
            turn_id,
            item,
        } => (
            thread_id.clone(),
            item_changed(turn_id, response_item(item)?, 0),
        ),
        CodexNotification::TurnDiffUpdated { thread_id, .. } => {
            (thread_id.clone(), SessionEventKind::DiffChanged)
        }
        CodexNotification::ServerRequestResolved {
            thread_id,
            request_id,
        } => (
            thread_id.clone(),
            SessionEventKind::ApprovalAnsweredElsewhere {
                approval_id: client.approval_answered_elsewhere(request_id).await?,
            },
        ),
        CodexNotification::Unknown { .. } => return None,
    };
    Some(SessionEvent { thread_id, kind })
}

fn item_changed(turn_id: &str, item: ConversationItem, at_ms: u64) -> SessionEventKind {
    SessionEventKind::ItemChanged {
        turn_id: turn_id.to_string(),
        item,
        at_ms,
    }
}

impl From<&ThreadTokenUsage> for TokenUsage {
    fn from(usage: &ThreadTokenUsage) -> Self {
        Self {
            total: (&usage.total).into(),
            last: (&usage.last).into(),
            model_context_window: usage.model_context_window,
        }
    }
}

impl From<&TokenUsageBreakdown> for TokenCount {
    fn from(count: &TokenUsageBreakdown) -> Self {
        Self {
            total_tokens: count.total_tokens,
            input_tokens: count.input_tokens,
            cached_input_tokens: count.cached_input_tokens,
            cache_write_input_tokens: count.cache_write_input_tokens,
            output_tokens: count.output_tokens,
            reasoning_output_tokens: count.reasoning_output_tokens,
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
    let provider_id = text_field(item, "id")?;
    // app-server may project one user message under a live UUID and a
    // history-local `item-N` id. The client id is the identity it preserves
    // across both views; older messages without one retain their provider id.
    let id = if item_type == "userMessage" {
        text_field(item, "clientId").unwrap_or(provider_id)
    } else {
        provider_id
    };
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
            background_task: None,
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

/// The ways Codex can be allowed to work here, ready to show.
///
/// Two of the three share the workspace profile and differ by who reviews the
/// requests, so this is a composition of two settings rather than the profile
/// list passed on — and the wording is written here, because knowing what a
/// mode does to Codex is knowing Codex.
pub(crate) async fn codex_permission_modes(
    client: &CodexThreadClient,
    cwd: &str,
) -> Result<(String, Vec<PermissionModeOption>), CodexThreadError> {
    let (profiles, default_mode) = tokio::try_join!(
        client.list_permission_profiles(cwd, 100),
        client.default_permission_mode(cwd),
    )?;
    let allowed = |profile_id: &str| {
        profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .is_some_and(|profile| profile.allowed)
    };
    let workspace = allowed(CodexPermissionMode::AskForApproval.profile_id());
    let full_access = allowed(CodexPermissionMode::FullAccess.profile_id());
    Ok((
        codex_mode_id(default_mode),
        vec![
            codex_option(
                CodexPermissionMode::AskForApproval,
                "Ask for approval",
                "Work in the workspace and ask before crossing its boundary.",
                workspace,
                false,
            ),
            codex_option(
                CodexPermissionMode::ApproveForMe,
                "Approve for me",
                "Keep the workspace boundary and review eligible requests automatically.",
                workspace,
                false,
            ),
            codex_option(
                CodexPermissionMode::FullAccess,
                "Full access",
                "Run without sandbox restrictions or approval prompts.",
                full_access,
                true,
            ),
        ],
    ))
}

/// The models Codex offers, in Caffold's words.
///
/// A model reaches the interface as something to send back, something to show,
/// and what it can do. Codex says all of that and more — modalities,
/// personality, service tiers by name — and the parts that are Codex's own stay
/// with Codex rather than becoming a shape a second agent has to imitate.
pub(crate) async fn codex_models(
    client: &CodexThreadClient,
) -> Result<Vec<ModelOption>, CodexThreadError> {
    Ok(client
        .list_models(100)
        .await?
        .data
        .into_iter()
        .filter(|model| !model.hidden)
        .map(|model| ModelOption {
            model: model.model.clone(),
            display_name: model.display_name.clone(),
            description: (!model.description.is_empty()).then(|| model.description.clone()),
            is_default: model.is_default,
            default_effort: codex_reasoning_effort(&model.default_reasoning_effort)
                .map(str::to_string),
            efforts: model
                .supported_reasoning_efforts
                .iter()
                .filter_map(codex_reasoning_effort)
                .map(str::to_string)
                .collect(),
            supports_fast_mode: model.fast_service_tier_id().is_some(),
            // Codex resolves permissions from profiles and a reviewer setting,
            // which no model takes part in.
            supports_auto_mode: false,
        })
        .collect())
}

/// What Codex will accept for a turn.
///
/// Caffold names a model, a depth, and a speed; what each of those means to
/// Codex is worked out here — which model answers to that name, whether it
/// works at that depth, whether it has a faster tier — so that choosing an
/// agent stays a question of which agent rather than of what its settings mean.
pub(crate) async fn codex_turn_options(
    client: &CodexThreadClient,
    options: &TurnOptions,
) -> Result<CodexTurnOptions, TurnRejected> {
    let model = bounded(options.model.as_deref(), 128).ok_or(TurnRejected::Model)?;
    let effort = bounded(options.effort.as_deref(), 32).ok_or(TurnRejected::Effort)?;
    let permission_mode = codex_permission_mode(options.permission_mode.as_deref());
    if model.is_none() && effort.is_none() && !options.fast_mode {
        return Ok(CodexTurnOptions {
            model,
            effort,
            service_tier: Some(NORMAL_SERVICE_TIER_ID.to_string()),
            permission_mode,
        });
    }

    let models = client.list_models(100).await?.data;
    let selected = match model.as_deref() {
        Some(requested) => models
            .iter()
            .find(|candidate| candidate.model == requested || candidate.id == requested),
        None => models
            .iter()
            .find(|candidate| candidate.is_default)
            .or_else(|| models.first()),
    };
    let Some(selected) = selected else {
        return Err(if model.is_some() {
            TurnRejected::Model
        } else {
            TurnRejected::Effort
        });
    };
    if effort.as_deref().is_some_and(|requested| {
        !selected
            .supported_reasoning_efforts
            .iter()
            .filter_map(codex_reasoning_effort)
            .any(|supported| supported == requested)
    }) {
        return Err(TurnRejected::Effort);
    }

    let normal = selected
        .default_service_tier
        .clone()
        .unwrap_or_else(|| NORMAL_SERVICE_TIER_ID.to_string());
    let service_tier = Some(
        options
            .fast_mode
            .then(|| selected.fast_service_tier_id().map(str::to_string))
            .flatten()
            .unwrap_or(normal),
    );
    Ok(CodexTurnOptions {
        model,
        effort,
        service_tier,
        permission_mode,
    })
}

/// A permission mode Codex offered, read back.
///
/// An unreadable one falls to Codex's own default rather than being refused:
/// the mode came from a list Codex gave out, and a stale choice should not stop
/// a person from working.
fn codex_permission_mode(mode: Option<&str>) -> Option<CodexPermissionMode> {
    let mode = mode?;
    serde_json::from_value(Value::String(mode.to_string())).ok()
}

fn codex_reasoning_effort(effort: &Value) -> Option<&str> {
    effort
        .as_str()
        .or_else(|| effort.get("value").and_then(Value::as_str))
        .or_else(|| effort.get("reasoningEffort").and_then(Value::as_str))
}

fn codex_option(
    mode: CodexPermissionMode,
    label: &str,
    description: &str,
    allowed: bool,
    dangerous: bool,
) -> PermissionModeOption {
    PermissionModeOption {
        mode: codex_mode_id(mode),
        label: label.to_string(),
        description: description.to_string(),
        allowed,
        unavailable_reason: (!allowed)
            .then(|| "The permission profile this needs is not allowed here.".to_string()),
        dangerous,
    }
}

/// The name a Codex mode travels under, which is the name it already had on the
/// wire before Caffold stopped naming modes for every agent at once.
pub(crate) fn codex_mode_id(mode: CodexPermissionMode) -> String {
    serde_json::to_value(mode)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::codex::{CodexThreadClient, MockCodexResponse};

    fn codex_client(responses: Vec<MockCodexResponse>) -> CodexThreadClient {
        CodexThreadClient::mock(responses)
    }

    /// Two models Codex could report, differing in the depths they work at.
    fn model_list() -> Value {
        json!({
            "data": [
                {
                    "id": "gpt-5.6-sol",
                    "model": "gpt-5.6-sol",
                    "displayName": "GPT-5.6-Sol",
                    "description": "Latest frontier agentic coding model.",
                    "hidden": false,
                    "supportedReasoningEfforts": [
                        { "reasoningEffort": "low", "description": "Fast" },
                        { "reasoningEffort": "xhigh", "description": "Deep" }
                    ],
                    "defaultReasoningEffort": "low",
                    "serviceTiers": [{ "id": "priority", "name": "Fast", "description": "Faster" }],
                    "defaultServiceTier": null,
                    "inputModalities": ["text"],
                    "supportsPersonality": false,
                    "isDefault": true
                },
                {
                    "id": "gpt-5.6-luna",
                    "model": "gpt-5.6-luna",
                    "displayName": "GPT-5.6-Luna",
                    "description": "General purpose model.",
                    "hidden": false,
                    "supportedReasoningEfforts": [{ "reasoningEffort": "max", "description": "Deepest" }],
                    "defaultReasoningEffort": "max",
                    "serviceTiers": [],
                    "defaultServiceTier": null,
                    "inputModalities": ["text"],
                    "supportsPersonality": true,
                    "isDefault": false
                }
            ],
            "nextCursor": null
        })
    }

    async fn read_options(
        responses: usize,
        options: TurnOptions,
    ) -> Result<CodexTurnOptions, TurnRejected> {
        let client = codex_client(
            (0..responses)
                .map(|_| MockCodexResponse::ok("model/list", model_list()))
                .collect(),
        );
        codex_turn_options(&client, &options).await
    }

    #[tokio::test]
    async fn a_depth_the_chosen_model_works_at_is_accepted() {
        let read = read_options(
            1,
            TurnOptions {
                model: Some("gpt-5.6-sol".to_string()),
                effort: Some("xhigh".to_string()),
                fast_mode: false,
                permission_mode: Some("askForApproval".to_string()),
            },
        )
        .await
        .expect("the agent works at that depth");

        assert_eq!(read.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(read.effort.as_deref(), Some("xhigh"));
        assert_eq!(
            read.permission_mode,
            Some(CodexPermissionMode::AskForApproval)
        );
    }

    #[tokio::test]
    async fn a_depth_the_chosen_model_does_not_work_at_is_refused() {
        // The depths belong to the model, not to the agent, so this cannot be
        // decided without asking which model was chosen.
        let refused = read_options(
            1,
            TurnOptions {
                model: Some("gpt-5.6-luna".to_string()),
                effort: Some("xhigh".to_string()),
                fast_mode: false,
                permission_mode: None,
            },
        )
        .await
        .expect_err("that model does not work at that depth");

        assert!(matches!(refused, TurnRejected::Effort));
    }

    #[tokio::test]
    async fn a_model_the_agent_does_not_offer_is_refused() {
        let refused = read_options(
            1,
            TurnOptions {
                model: Some("gpt-imaginary".to_string()),
                effort: None,
                fast_mode: false,
                permission_mode: None,
            },
        )
        .await
        .expect_err("no such model");

        assert!(matches!(refused, TurnRejected::Model));
    }

    #[tokio::test]
    async fn working_faster_falls_back_to_the_normal_tier_when_a_model_has_none() {
        // Asking for speed from a model with no faster tier is answered with
        // its ordinary one rather than refused, and the caller is told which it
        // got so the interface can stop offering what did not happen.
        let fast = read_options(
            1,
            TurnOptions {
                model: Some("gpt-5.6-sol".to_string()),
                effort: None,
                fast_mode: true,
                permission_mode: None,
            },
        )
        .await
        .expect("the model has a faster tier");
        assert_eq!(fast.service_tier.as_deref(), Some("priority"));

        let normal = read_options(
            1,
            TurnOptions {
                model: Some("gpt-5.6-luna".to_string()),
                effort: None,
                fast_mode: true,
                permission_mode: None,
            },
        )
        .await
        .expect("a model without one still runs");
        assert_eq!(normal.service_tier.as_deref(), Some("default"));
    }

    #[tokio::test]
    async fn nothing_chosen_asks_the_agent_nothing() {
        // Reading the model list costs a round trip in front of the person
        // waiting, and there is nothing to check when they chose nothing.
        let client = codex_client(Vec::new());

        let read = codex_turn_options(&client, &TurnOptions::default())
            .await
            .expect("no choice is a valid choice");

        assert!(client.mock_requests().await.is_empty());
        assert_eq!(read.service_tier.as_deref(), Some("default"));
    }

    #[tokio::test]
    async fn a_choice_that_never_came_from_the_agent_is_refused() {
        // Nothing the agent offered is this long or carries control characters,
        // so it did not come from a list the agent gave out.
        let long = read_options(
            0,
            TurnOptions {
                model: Some("m".repeat(129)),
                effort: None,
                fast_mode: false,
                permission_mode: None,
            },
        )
        .await
        .expect_err("no model is named that");
        assert!(matches!(long, TurnRejected::Model));

        let control = read_options(
            0,
            TurnOptions {
                model: None,
                effort: Some("hi\u{7}gh".to_string()),
                fast_mode: false,
                permission_mode: None,
            },
        )
        .await
        .expect_err("no depth is named that");
        assert!(matches!(control, TurnRejected::Effort));
    }

    #[tokio::test]
    async fn a_permission_mode_the_agent_no_longer_offers_falls_to_its_default() {
        // The mode came from a list the agent gave out. A stale one should not
        // stop a person from working, so Codex's own default stands in.
        let read = read_options(
            0,
            TurnOptions {
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: Some("acceptEdits".to_string()),
            },
        )
        .await
        .expect("a stale mode still starts a turn");

        assert_eq!(read.permission_mode, None);
    }

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
    fn a_prompt_keeps_its_client_identity_across_item_projections() {
        let live = conversation_item(
            &json!({
                "type": "userMessage",
                "id": "01a03716-fcdb-7170-858b-f22699bc5a4f",
                "clientId": "message_1",
                "content": [{ "type": "text", "text": "Inspect this" }],
            }),
            ActivityStatus::Completed,
        )
        .expect("the live prompt is an item");
        let history = conversation_item(
            &json!({
                "type": "userMessage",
                "id": "item-256",
                "clientId": "message_1",
                "content": [{ "type": "text", "text": "Inspect this" }],
            }),
            ActivityStatus::Completed,
        )
        .expect("the historical prompt is an item");

        assert_eq!(live.id, "message_1");
        assert_eq!(history.id, live.id);
    }

    #[test]
    fn a_prompt_without_a_client_identity_keeps_its_provider_identity() {
        let live = conversation_item(
            &json!({
                "type": "userMessage",
                "id": "01a03716-fcdb-7170-858b-f22699bc5a4f",
                "clientId": null,
            }),
            ActivityStatus::Completed,
        )
        .expect("a legacy live prompt");
        let history = conversation_item(
            &json!({ "type": "userMessage", "id": "item-256" }),
            ActivityStatus::Completed,
        )
        .expect("a legacy historical prompt");

        assert_eq!(live.id, "01a03716-fcdb-7170-858b-f22699bc5a4f");
        assert_eq!(history.id, "item-256");
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

    /// Every notification app-server pushes while a thread is subscribed.
    ///
    /// Adding a surface for one is then a deliberate change here rather than a
    /// notification quietly going unread.
    fn every_notification() -> [(&'static str, serde_json::Value); 12] {
        let turn = json!({ "id": "turn_1", "status": "completed", "completedAt": 2.0 });
        let item = json!({ "id": "item_1", "type": "agentMessage", "text": "Done." });
        [
            (
                "thread/started",
                json!({ "thread": {
                    "id": "thread_1",
                    "preview": "Task",
                    "status": { "type": "idle" },
                    "cwd": "/Users/example/project",
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "turns": []
                } }),
            ),
            (
                "thread/status/changed",
                json!({ "threadId": "thread_1", "status": { "type": "idle" } }),
            ),
            (
                "thread/name/updated",
                json!({ "threadId": "thread_1", "threadName": "Named" }),
            ),
            (
                "thread/settings/updated",
                json!({ "threadId": "thread_1", "threadSettings": { "model": "gpt-5.3-spark" } }),
            ),
            (
                "thread/tokenUsage/updated",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "tokenUsage": {
                        "total": token_count(1234),
                        "last": token_count(345),
                        "modelContextWindow": 128_000
                    }
                }),
            ),
            (
                "turn/started",
                json!({ "threadId": "thread_1", "turn": turn }),
            ),
            (
                "turn/completed",
                json!({ "threadId": "thread_1", "turn": turn }),
            ),
            (
                "item/started",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "startedAtMs": 10,
                    "item": item
                }),
            ),
            (
                "item/completed",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "completedAtMs": 20,
                    "item": item
                }),
            ),
            (
                "rawResponseItem/completed",
                json!({
                    "threadId": "thread_1",
                    "turnId": "turn_1",
                    "item": {
                        "id": "item_1",
                        "type": "message",
                        "role": "assistant",
                        "content": [{ "type": "output_text", "text": "Done." }]
                    }
                }),
            ),
            (
                "turn/diff/updated",
                json!({ "threadId": "thread_1", "turnId": "turn_1" }),
            ),
            (
                "serverRequest/resolved",
                json!({ "threadId": "thread_1", "requestId": 45 }),
            ),
        ]
    }

    fn token_count(total: u64) -> serde_json::Value {
        json!({
            "totalTokens": total,
            "inputTokens": total,
            "cachedInputTokens": 0,
            "cacheWriteInputTokens": 0,
            "outputTokens": 0,
            "reasoningOutputTokens": 0
        })
    }

    /// One notification, translated the way a subscribed thread translates it.
    async fn reported(method: &str, params: serde_json::Value) -> Option<SessionEvent> {
        let client = super::super::CodexThreadClient::mock(Vec::new());
        client.track_approval("approval-45", json!(45)).await;
        let notification =
            super::super::protocol::decode_notification(method, params).expect("Codex sends this");
        session_event(&notification, &client).await
    }

    #[tokio::test]
    async fn every_notification_codex_sends_arrives_in_caffolds_words() {
        for (method, params) in every_notification() {
            let event = reported(method, params)
                .await
                .unwrap_or_else(|| panic!("{method} said nothing Caffold could act on"));

            assert_eq!(event.thread_id, "thread_1", "{method} lost its thread");
        }
    }

    #[tokio::test]
    async fn a_notification_a_newer_app_server_adds_says_nothing() {
        // An app-server that knows more than this Caffold does is not an error;
        // it is a notification with nothing in it for us.
        let notification = super::super::protocol::decode_notification(
            "thread/somethingNew",
            json!({ "threadId": "thread_1" }),
        )
        .expect("an unknown method still decodes");

        assert!(
            session_event(
                &notification,
                &super::super::CodexThreadClient::mock(Vec::new())
            )
            .await
            .is_none()
        );
    }

    #[tokio::test]
    async fn an_item_is_as_far_along_as_the_notification_that_carried_it() {
        let message = json!({ "id": "item_1", "type": "agentMessage", "text": "Working." });

        let SessionEventKind::ItemChanged { item, at_ms, .. } = reported(
            "item/started",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "startedAtMs": 10,
                "item": message
            }),
        )
        .await
        .expect("a started item")
        .kind
        else {
            panic!("a started item is an item change");
        };
        assert_eq!(item.status, ActivityStatus::InProgress);
        assert_eq!(at_ms, 10);

        let SessionEventKind::ItemChanged { item, at_ms, .. } = reported(
            "item/completed",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "completedAtMs": 20,
                "item": message
            }),
        )
        .await
        .expect("a completed item")
        .kind
        else {
            panic!("a completed item is an item change");
        };
        assert_eq!(item.status, ActivityStatus::Completed);
        assert_eq!(at_ms, 20);
    }

    #[tokio::test]
    async fn only_the_first_resolution_names_the_approval_it_answered() {
        let client = super::super::CodexThreadClient::mock(Vec::new());
        client.track_approval("approval-45", json!(45)).await;
        let resolved = super::super::protocol::decode_notification(
            "serverRequest/resolved",
            json!({ "threadId": "thread_1", "requestId": 45 }),
        )
        .expect("Codex sends this");

        let Some(SessionEventKind::ApprovalAnsweredElsewhere { approval_id }) =
            session_event(&resolved, &client)
                .await
                .map(|event| event.kind)
        else {
            panic!("the resolution names the approval it answered");
        };
        assert_eq!(approval_id, "approval-45");

        // Nothing is left on that request, so a repeat says nothing and the
        // approval is not withdrawn twice.
        assert!(session_event(&resolved, &client).await.is_none());
    }

    #[tokio::test]
    async fn a_resolution_for_something_else_leaves_the_approval_alone() {
        let client = super::super::CodexThreadClient::mock(Vec::new());
        client.track_approval("approval-45", json!(45)).await;
        let other = super::super::protocol::decode_notification(
            "serverRequest/resolved",
            json!({ "threadId": "thread_1", "requestId": 46 }),
        )
        .expect("Codex sends this");

        assert!(session_event(&other, &client).await.is_none());
    }
}
