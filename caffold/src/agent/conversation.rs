//! What a Task's conversation is made of, in Caffold's words.
//!
//! A driver reads its agent's transcript and produces these types. Nothing
//! above the driver sees what the agent actually sent, so the conversation the
//! browser renders keeps its shape when an agent changes its own.
//!
//! The vocabulary is deliberately the size of what Caffold renders and no
//! larger. An item gets its own kind because a surface draws it differently —
//! a command has output to inspect, a file change has paths to open. Anything
//! else the agent did is a [`ItemKind::ToolCall`], carrying the name the agent
//! used, because that is all Caffold can honestly say about work whose meaning
//! belongs to the harness that did it.
//!
//! That fallback is what makes the vocabulary safe to hold still. Agents grow
//! new kinds of work constantly; each one arrives here as a tool call rather
//! than as a parse failure or a silently dropped item.
//!
//! A conversation is also read live. An agent Caffold is watching reports what
//! it is doing as it does it, and [`SessionEvent`] is that report in the same
//! vocabulary — so what appears on screen while a turn runs and what is read
//! back afterwards are the same thing said twice.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Something an agent reported while Caffold was watching.
///
/// Several parts of Caffold act on one of these: the conversation appears on
/// screen, the Task list learns when work last happened, a finished turn
/// notifies a phone, and an approval nobody can answer any more goes away. They
/// read one report rather than each interpreting the agent's own.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SessionEvent {
    pub(crate) thread_id: String,
    pub(crate) kind: SessionEventKind,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum SessionEventKind {
    /// The agent opened a conversation Caffold had not seen loaded.
    ConversationStarted {
        conversation: Conversation,
    },
    StatusChanged {
        status: ThreadStatus,
    },
    /// The agent renamed the conversation, or cleared its name.
    TitleChanged {
        title: Option<String>,
    },
    /// What the agent says its own settings now are.
    ///
    /// These stay in the agent's words. A permission mode is the one piece of
    /// this vocabulary Caffold has not decided across agents — Codex resolves
    /// three modes from five configuration values and names a sandbox profile,
    /// Claude offers six modes and no profile at all — and inventing a shared
    /// meaning before a second agent is running would be guessing.
    SettingsChanged {
        settings: BTreeMap<String, Value>,
    },
    TurnStarted {
        turn: Turn,
    },
    TurnEnded {
        turn: Turn,
    },
    /// One item appeared or moved on. The same item arrives more than once as
    /// it progresses, under one identity.
    ItemChanged {
        turn_id: String,
        item: ConversationItem,
        /// When the agent says this happened, or zero when it does not say.
        at_ms: u64,
    },
    /// The agent changed the working tree. What changed is read from git, so
    /// this only says that there is something new to review.
    DiffChanged,
    UsageReported {
        turn_id: String,
        usage: TokenUsage,
    },
    /// An approval was answered somewhere other than Caffold, so the request is
    /// no longer waiting on anyone here.
    ApprovalAnsweredElsewhere {
        approval_id: String,
    },
}

/// What a conversation has spent, as its agent counts it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenUsage {
    /// Everything the conversation has spent so far.
    pub(crate) total: TokenCount,
    /// What the most recent turn spent.
    pub(crate) last: TokenCount,
    /// How much the model can hold at once, when the agent says.
    pub(crate) model_context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TokenCount {
    pub(crate) total_tokens: u64,
    pub(crate) input_tokens: u64,
    pub(crate) cached_input_tokens: u64,
    pub(crate) cache_write_input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) reasoning_output_tokens: u64,
}

/// A conversation as its agent currently reports it.
///
/// This is a read of the agent's own state, not a Caffold record of it. The
/// agent owns the conversation; Caffold asks and renders the answer.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Conversation {
    pub(crate) id: String,
    /// The agent's own name for this conversation, when it has assigned one.
    pub(crate) title: Option<String>,
    pub(crate) preview: String,
    pub(crate) status: ThreadStatus,
    pub(crate) cwd: String,
    /// Where the agent persists this conversation, when it exposes that.
    pub(crate) transcript_path: Option<String>,
    pub(crate) created_at_ms: u64,
    pub(crate) updated_at_ms: u64,
    /// When the agent last considered this conversation active, which it may
    /// track separately from when it was last written to.
    pub(crate) recency_at_ms: Option<u64>,
    pub(crate) turns: Vec<Turn>,
}

/// The turns Caffold has read, and where the rest would be.
///
/// An agent that pages its history hands back a window and a cursor into what
/// lies beyond it. One that does not page hands back what it has and no cursor,
/// which reads as "there is nothing further to ask for" rather than as a
/// missing capability.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct TurnPage {
    /// Newest first, which is the order history is read in.
    pub(crate) turns: Vec<Turn>,
    /// Where to continue reading older turns.
    pub(crate) next_cursor: Option<String>,
    /// Where to continue reading turns newer than this window.
    pub(crate) backwards_cursor: Option<String>,
}

/// One exchange: a prompt and everything the agent did in response.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Turn {
    pub(crate) id: String,
    pub(crate) status: TurnStatus,
    pub(crate) started_at_ms: Option<u64>,
    pub(crate) completed_at_ms: Option<u64>,
    pub(crate) items: Vec<ConversationItem>,
}

/// One thing the agent said or did, as the conversation draws it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ConversationItem {
    /// The agent's identifier for this item. It is what makes a live update and
    /// a later read of the same work one entry rather than two.
    pub(crate) id: String,
    /// How far along this item is.
    ///
    /// Every item carries one, whether its agent reports work status for that
    /// kind or only says when the item started and finished. One field with one
    /// meaning is what lets the interface show that something is happening
    /// without first knowing which kind of item it is looking at.
    pub(crate) status: ActivityStatus,
    pub(crate) kind: ItemKind,
}

/// Which surface draws an item, and what that surface needs.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ItemKind {
    UserMessage {
        /// The prompt as text, with anything the agent wrapped around it
        /// removed.
        text: String,
        content: Vec<MessageContent>,
    },
    AssistantMessage {
        text: String,
        /// Absent when the agent does not say, which is common enough that the
        /// conversation has to read as complete without it.
        phase: Option<MessagePhase>,
    },
    Reasoning {
        summary: Vec<String>,
        content: Vec<String>,
    },
    Plan {
        text: String,
    },
    CommandExecution(CommandExecution),
    FileChange {
        /// The paths the change touched. The diffs stay with the agent; git is
        /// what Caffold reviews changes from.
        paths: Vec<String>,
    },
    GeneratedImage(GeneratedImage),
    /// Work Caffold has no surface of its own for.
    ///
    /// The name is the agent's — a Codex item type, a Claude tool name — shown
    /// as-is because inventing a Caffold word for work Caffold does not model
    /// would claim an understanding it does not have.
    ToolCall {
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CommandExecution {
    pub(crate) command: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) output: Option<String>,
    /// Absent when the agent does not report one. Claude's shell results carry
    /// no exit code at all, so a missing code has to mean "not reported" rather
    /// than success.
    pub(crate) exit_code: Option<i64>,
    pub(crate) duration_ms: Option<u64>,
}

/// An image the agent produced, and where it put it.
///
/// Caffold serves the image itself rather than passing it through the
/// conversation, so what matters here is enough to find the bytes once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GeneratedImage {
    pub(crate) revised_prompt: Option<String>,
    /// A file on the machine the agent runs on.
    pub(crate) saved_path: Option<String>,
    /// The image itself, base64-encoded, when the agent returns bytes instead
    /// of writing a file.
    pub(crate) encoded: Option<String>,
}

impl GeneratedImage {
    /// Whether there is an image to show yet.
    ///
    /// An image the agent is still drawing has neither, and the conversation
    /// shows that it is working rather than a picture that will not load.
    pub(crate) fn is_available(&self) -> bool {
        self.saved_path.is_some() || self.encoded.is_some()
    }
}

/// What a prompt carried besides its text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MessageContent {
    Text {
        text: String,
    },
    /// An image the browser can render directly.
    Image {
        url: String,
    },
    /// An image on the machine the agent runs on.
    LocalImage {
        path: String,
    },
}

/// Whether an assistant message is the answer or something said along the way.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum MessagePhase {
    /// Said while working, before the answer.
    Progress,
    /// The turn's answer.
    Final,
}

/// How a piece of work is going.
///
/// `Declined` is its own outcome rather than a kind of failure: the work did
/// not fail, a person refused it, and a conversation that renders the two the
/// same way misreports what happened.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ActivityStatus {
    InProgress,
    Completed,
    Failed,
    Declined,
}

/// What an agent is doing for a Task.
///
/// This is the state the Task list and header render from. It is deliberately
/// coarse: a turn's own outcome belongs to that turn, and a pending approval is
/// a request waiting to be answered rather than a state of the conversation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "type")]
pub(crate) enum ThreadStatus {
    /// The agent has not been asked about this conversation yet.
    NotLoaded,
    Idle,
    /// The agent reported a failure that ended the conversation rather than a
    /// turn.
    SystemError,
    Active {
        /// What the agent is waiting for, if anything. Empty means it is
        /// working.
        #[serde(default, rename = "activeFlags")]
        active_flags: Vec<ThreadActiveFlag>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ThreadActiveFlag {
    WaitingOnApproval,
    WaitingOnUserInput,
}

/// How one turn ended, or that it has not.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TurnStatus {
    Completed,
    Interrupted,
    Failed,
    InProgress,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_active_status_carries_what_it_is_waiting_for() {
        // The browser distinguishes working from waiting, and which kind of
        // waiting, from this one value.
        let encoded = serde_json::to_value(ThreadStatus::Active {
            active_flags: vec![ThreadActiveFlag::WaitingOnApproval],
        })
        .expect("encode");

        assert_eq!(encoded["type"], "active");
        assert_eq!(encoded["activeFlags"][0], "waitingOnApproval");
    }

    #[test]
    fn a_status_without_flags_still_reads_as_active() {
        // An agent that is working reports no flags at all, so the absent field
        // has to mean "working" rather than fail to parse.
        let decoded: ThreadStatus = serde_json::from_str(r#"{"type":"active"}"#).expect("decode");

        assert_eq!(
            decoded,
            ThreadStatus::Active {
                active_flags: vec![]
            }
        );
    }
}
