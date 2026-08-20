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
//! agent stops to ask, and what a person answers.

pub(crate) mod approval;
pub(crate) mod codex;
pub(crate) mod conversation;

pub(crate) use approval::{
    ApprovalDecision, ApprovalDetail, ApprovalOutcome, ApprovalRequest, PermissionRow,
};
pub(crate) use conversation::{
    ActivityStatus, CommandExecution, Conversation, ConversationItem, GeneratedImage, ItemKind,
    MessageContent, MessagePhase, ThreadActiveFlag, ThreadStatus, Turn, TurnStatus,
};
