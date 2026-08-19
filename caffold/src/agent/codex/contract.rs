//! What this driver presents to the rest of Caffold.
//!
//! Codex's own types describe what app-server says; these conversions say what
//! Caffold promises above the driver. Keeping them here rather than beside each
//! wire type means one file answers what the adapter carries upward, and the
//! protocol module stays a description of Codex alone.

use super::protocol::{ThreadActiveFlag, ThreadStatus, TurnStatus};
use crate::agent;

// Codex's status values and Caffold's agree today, because Caffold's vocabulary
// was drawn from the first agent it drove. Converting anyway is the point: what
// the browser is promised stops moving when Codex changes, and a second driver
// maps to Caffold's values rather than to Codex's.

impl From<ThreadStatus> for agent::ThreadStatus {
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

impl From<ThreadActiveFlag> for agent::ThreadActiveFlag {
    fn from(flag: ThreadActiveFlag) -> Self {
        match flag {
            ThreadActiveFlag::WaitingOnApproval => Self::WaitingOnApproval,
            ThreadActiveFlag::WaitingOnUserInput => Self::WaitingOnUserInput,
        }
    }
}

impl From<TurnStatus> for agent::TurnStatus {
    fn from(status: TurnStatus) -> Self {
        match status {
            TurnStatus::Completed => Self::Completed,
            TurnStatus::Interrupted => Self::Interrupted,
            TurnStatus::Failed => Self::Failed,
            TurnStatus::InProgress => Self::InProgress,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
            let converted =
                serde_json::to_value(agent::ThreadStatus::from(status.clone())).expect("encode");

            assert_eq!(converted, expected, "{status:?} changed on the wire");
        }
    }

    #[test]
    fn a_converted_turn_status_reaches_the_browser_unchanged() {
        for status in EVERY_TURN_STATUS {
            let expected = serde_json::to_value(status).expect("encode Codex status");
            let converted = serde_json::to_value(agent::TurnStatus::from(status)).expect("encode");

            assert_eq!(converted, expected, "{status:?} changed on the wire");
        }
    }
}
