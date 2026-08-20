//! What an agent asks permission for, and how a person answers.
//!
//! Both agents Caffold drives block a turn on the same question — may I do
//! this — and both accept the same four answers. What differs is everything
//! around the question: Codex sends typed requests carrying a permission
//! profile, Claude sends one tool-permission callback carrying rule
//! suggestions. A driver turns its own into these types.
//!
//! Caffold owns the answer, not the permission. Asked to allow something
//! always, both agents want back the grant they themselves proposed, so
//! Caffold says yes to what was asked rather than composing a grant of its
//! own. That keeps the harness in charge of its own permission model, and
//! keeps Caffold out of the business of deciding what a grant means.
//!
//! What reaches the browser is therefore a request already written for a
//! person to read: a title, a reason, the specifics worth showing, and the
//! answers this particular request accepts.

use serde::{Deserialize, Serialize};

/// A question the agent is blocked on until someone answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ApprovalRequest {
    pub(crate) id: String,
    pub(crate) turn_id: Option<String>,
    /// The item this interrupts, when the agent scopes the request to one.
    pub(crate) item_id: Option<String>,
    /// What is being asked, in one line, written by the driver.
    pub(crate) title: String,
    /// Why the agent is asking, when it says.
    pub(crate) reason: Option<String>,
    pub(crate) detail: ApprovalDetail,
    /// The answers this request accepts, in the order to offer them.
    ///
    /// An agent that cannot stop a turn on refusal simply does not offer
    /// [`ApprovalDecision::DenyAndStop`]; the interface reads this list rather
    /// than assuming a fixed set.
    pub(crate) decisions: Vec<ApprovalDecision>,
}

/// The specifics worth showing for one request.
///
/// Every field is optional because requests differ, and the interface renders
/// what is present rather than switching on a request type. That is what lets
/// one card serve a Codex command approval and a Claude tool permission
/// without either being the shape the other has to imitate.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ApprovalDetail {
    pub(crate) command: Option<String>,
    pub(crate) cwd: Option<String>,
    /// The endpoint the agent wants to reach, already written for display.
    pub(crate) network_endpoint: Option<String>,
    /// The access being requested, one row per thing a person should check.
    pub(crate) permissions: Vec<PermissionRow>,
    /// A directory the agent is asking to write under.
    pub(crate) grant_root: Option<String>,
    /// Where the work would run, when the agent runs work somewhere nameable.
    pub(crate) environment: Option<String>,
}

/// One line of requested access.
///
/// The driver formats both halves. A permission profile is the agent's own
/// model — Codex describes sandbox entries, Claude describes rules — and
/// rendering it means understanding it, so whichever driver understands it
/// writes the row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionRow {
    pub(crate) label: String,
    pub(crate) value: String,
    /// Whether the value is something the agent will use exactly as written,
    /// such as a path or a host, rather than a description of the access. A
    /// person checking a grant reads those literally, so the interface sets
    /// them apart.
    pub(crate) verbatim: bool,
}

/// The answers Caffold offers for any approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ApprovalDecision {
    /// Yes, this once.
    Allow,
    /// Yes, and stop asking. What "always" covers is the agent's to decide:
    /// each one is told to apply the grant it proposed.
    AllowAlways,
    /// No. The turn continues.
    Deny,
    /// No, and stop the turn.
    DenyAndStop,
}

/// How an approval stopped being pending.
///
/// A decision and a withdrawal are different things to the backend but one
/// value to a reader of the conversation, which only needs to know what became
/// of the request. [`ApprovalOutcome::as_str`] is that single value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ApprovalOutcome {
    Decided(ApprovalDecision),
    /// Answered outside Caffold, by another client of the same agent.
    AnsweredElsewhere,
    /// No longer answerable, because the turn it belonged to ended first.
    Expired,
}

impl ApprovalOutcome {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Decided(ApprovalDecision::Allow) => "allow",
            Self::Decided(ApprovalDecision::AllowAlways) => "allowAlways",
            Self::Decided(ApprovalDecision::Deny) => "deny",
            Self::Decided(ApprovalDecision::DenyAndStop) => "denyAndStop",
            Self::AnsweredElsewhere => "answeredElsewhere",
            Self::Expired => "expired",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_outcome_is_one_wire_value() {
        // The conversation shows one string for how a request ended, so a
        // decision and a withdrawal have to flatten without colliding.
        let outcomes = [
            ApprovalOutcome::Decided(ApprovalDecision::Allow),
            ApprovalOutcome::Decided(ApprovalDecision::AllowAlways),
            ApprovalOutcome::Decided(ApprovalDecision::Deny),
            ApprovalOutcome::Decided(ApprovalDecision::DenyAndStop),
            ApprovalOutcome::AnsweredElsewhere,
            ApprovalOutcome::Expired,
        ];

        let mut seen = std::collections::BTreeSet::new();
        for outcome in outcomes {
            assert!(seen.insert(outcome.as_str()), "{outcome:?} shares a value");
        }
    }
}
