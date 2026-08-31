//! The agents Caffold drives, and how each one is reached.
//!
//! Caffold does not reimplement what an agent does. Each vendor ships a model
//! and a harness built to go with it, and a driver here exists to run that
//! combination the way its authors intended and hand the result to the Tasks
//! application to present.
//!
//! One driver per agent, each owning the way it reaches its own: Codex through
//! its app-server daemon, and — as this grows — Claude through the runner that
//! supervises its sessions.
//!
//! This module also owns the vocabulary the rest of Caffold speaks about an
//! agent. A driver translates its provider into these types; nothing above this
//! boundary sees a provider's own. The vocabulary stays as small as what the
//! product actually presents, so that a second driver has to supply that much
//! and no more.
//!
//! It divides the way the product does. [`conversation`] is what a Task shows —
//! its turns, and what the agent said and did in them. [`approval`] is what the
//! agent stops to ask, and what a person answers. [`driver`] is which agent is
//! being asked, and the questions Caffold has found are the same whichever one
//! it is.

pub(crate) mod approval;
pub(crate) mod claude;
pub(crate) mod codex;
pub(crate) mod conversation;
pub(crate) mod driver;

/// The provider-neutral convention Caffold gives every managed agent session.
///
/// The files remain optional filesystem state: the instruction explains how
/// to participate when a written plan is useful without turning every Task
/// into a planning workflow or giving Caffold another plan ledger.
pub(crate) const CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS: &str = concat!(
    "Caffold supports an optional current plan through two ordinary Markdown files relative ",
    "to the current working directory: .caffold/plans/current/PLAN.md and ",
    ".caffold/plans/current/CHECKLIST.md. When the work benefits from a durable written plan, ",
    "create and maintain both files. PLAN.md is free-form. CHECKLIST.md is free-form, and ",
    "Caffold counts every GitHub-Flavored Markdown task-list marker in it as progress. ",
    "If both files already exist, treat them as the current written plan and keep them aligned ",
    "with the work. While executing a current plan, update CHECKLIST.md whenever an item's status ",
    "or scope changes rather than waiting until the end, and reconcile it with the work actually ",
    "done before reporting progress or completion. Do not create these files merely because ",
    "Caffold is present. Discuss planning ",
    "questions and decisions through the normal conversation. Checked items do not by themselves ",
    "resolve or archive the plan. Do not change Git tracking or .gitignore for these files unless ",
    "the user asks. When the plan is no longer current, move or delete both files together; any ",
    "history layout is the user's choice."
);

pub(crate) use approval::{
    ApprovalDecision, ApprovalDetail, ApprovalOutcome, ApprovalRequest, PermissionRow,
};
pub(crate) use conversation::{
    ActivityStatus, BackgroundTask, CommandExecution, Conversation, ConversationItem,
    GeneratedImage, ItemKind, MessageContent, MessagePhase, SessionEvent, SessionEventKind,
    ThreadActiveFlag, ThreadStatus, TokenCount, TokenUsage, Turn, TurnOrigin, TurnPage, TurnStatus,
};
pub(crate) use driver::{
    AgentError, Driver, OpenedConversation, PermissionModes, TurnOptions, TurnRejected,
};
