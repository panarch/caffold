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

pub(crate) mod codex;

use serde::{Deserialize, Serialize};

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
