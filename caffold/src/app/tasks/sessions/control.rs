//! Subscription transport control, independent of the provider's thread status.
//!
//! A per-session operation lock orders open/close effects. Connection loss and
//! forgetting a Task can interrupt either effect; observation epochs reject
//! its stale completion. Viewers, requests, and runtime demand are orthogonal
//! and only decide whether a close may begin.

use super::{SessionLifecycle, SessionState};

#[derive(Debug, Clone, Copy)]
pub(super) enum SubscriptionTransition {
    BeginOpen,
    Opened,
    Registered,
    BeginClose,
    Closed,
    Failed,
    Reset,
}

impl SessionState {
    pub(super) fn transition(&mut self, event: SubscriptionTransition) {
        self.lifecycle = self.lifecycle.after(event).unwrap_or_else(|| {
            panic!(
                "invalid subscription transition: {:?} / {event:?}",
                self.lifecycle
            )
        });
    }
}

impl SessionLifecycle {
    /// Complete allowed-edge declaration. Refresh success is a Subscribed
    /// self-edge; failures and explicit resets can interrupt every node.
    fn after(self, event: SubscriptionTransition) -> Option<Self> {
        use SessionLifecycle::{Error, Subscribed, Subscribing, Unloaded, Unsubscribing};
        use SubscriptionTransition::{
            BeginClose, BeginOpen, Closed, Failed, Opened, Registered, Reset,
        };

        match (self, event) {
            (Unloaded | Error | Subscribed, BeginOpen) => Some(Subscribing),
            (Subscribing | Subscribed, Opened) => Some(Subscribed),
            (Unloaded | Error, Registered) => Some(Subscribed),
            (Subscribed, BeginClose) => Some(Unsubscribing),
            (Unsubscribing, Closed) => Some(Unloaded),
            (Unloaded | Subscribing | Subscribed | Unsubscribing | Error, Failed) => Some(Error),
            (Unloaded | Subscribing | Subscribed | Unsubscribing | Error, Reset) => Some(Unloaded),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_completed_subscription_effects_can_be_reversed() {
        use SessionLifecycle::{Error, Subscribed, Subscribing, Unloaded, Unsubscribing};
        use SubscriptionTransition::{
            BeginClose, BeginOpen, Closed, Failed, Opened, Registered, Reset,
        };

        for start in [Unloaded, Error, Subscribed] {
            assert_eq!(start.after(BeginOpen), Some(Subscribing));
        }
        assert_eq!(Subscribing.after(Opened), Some(Subscribed));
        assert_eq!(Subscribed.after(Opened), Some(Subscribed));
        for start in [Unloaded, Error] {
            assert_eq!(start.after(Registered), Some(Subscribed));
        }
        assert_eq!(Subscribed.after(BeginClose), Some(Unsubscribing));
        assert_eq!(Unsubscribing.after(Closed), Some(Unloaded));

        for start in [Unloaded, Subscribing, Subscribed, Unsubscribing, Error] {
            assert_eq!(start.after(Failed), Some(Error));
            assert_eq!(start.after(Reset), Some(Unloaded));
        }
        assert_eq!(Unsubscribing.after(BeginOpen), None);
        assert_eq!(Unsubscribing.after(Opened), None);
        assert_eq!(Subscribing.after(BeginClose), None);
        assert_eq!(Error.after(Opened), None);
        assert_eq!(Unloaded.after(Closed), None);
        assert_eq!(Subscribed.after(Registered), None);
    }
}
