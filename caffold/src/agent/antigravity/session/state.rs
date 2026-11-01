//! Input ownership and observations in the opaque same-child recovery checkpoint.
use super::super::{
    AntigravityError, binding::Binding, protocol::ConfigOption, record::validate_session,
};
use super::{InputOperation, Verified};
use crate::agent::{ContextUsage, SessionEventKind, http_mcp::valid_binding};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Phase {
    Absent,
    Starting,
    Restoring,
    Ready,
    Closing,
    Unavailable,
}
#[derive(Debug, Clone, Copy)]
pub(super) enum ConnectionEvent {
    Start,
    Restore,
    Prepared,
    Lost,
    Close,
    Closed,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub(super) enum Input {
    Idle,
    Pending {
        rpc: u64,
        accepted: bool,
        native_started: bool,
    },
    Stopping {
        rpc: u64,
        accepted: bool,
        native_started: bool,
        cancel_accepted: bool,
    },
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "camelCase")]
pub(super) enum Purpose {
    Initialize,
    Authenticate,
    New { cwd: String, first: bool },
    Load { native_id: String, cwd: String },
    Configure { id: String, value: String },
    Prompt,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Checkpoint {
    pub(super) version: u32,
    pub(super) task_id: String,
    pub(super) binding: Option<Binding>,
    pub(super) mcp_binding: String,
    pub(super) initialized: bool,
    pub(super) authenticated: bool,
    #[serde(default)]
    pub(super) account: Option<Verified>,
    /// Last native context report, valid only for this runner child.
    #[serde(default)]
    pub(super) context: Option<Context>,
    pub(super) loaded: bool,
    pub(super) options: Vec<ConfigOption>,
    pub(super) next_rpc: u64,
    pub(super) pending: BTreeMap<u64, Purpose>,
    pub(super) input: Input,
    /// Exact incoming RPC IDs/choices, never aliases for native items.
    pub(super) approvals: BTreeMap<String, Value>,
    pub(super) responses: BTreeMap<String, Value>,
    pub(super) reviewed: bool,
}

/// Native counts, independent of disposable display turns and cumulative cost.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Context {
    used: u64,
    size: u64,
}

impl Context {
    pub(super) fn from_update(update: &Value) -> Option<Self> {
        if update["sessionUpdate"] != "usage_update" {
            return None;
        }
        let context: Self = serde_json::from_value(update.clone()).ok()?;
        (context.size > 0).then_some(context)
    }

    pub(super) fn report(self) -> SessionEventKind {
        SessionEventKind::ContextReported {
            context: ContextUsage {
                used_tokens: self.used,
                window_tokens: self.size,
            },
        }
    }
}

impl Phase {
    /// The only connection-node transition owner. Stale effects cannot revive it.
    pub(super) fn transition(&mut self, event: ConnectionEvent) -> Result<(), AntigravityError> {
        use ConnectionEvent::*;
        let next = match (*self, event) {
            (Self::Absent, Start) => Self::Starting,
            (Self::Absent | Self::Ready | Self::Unavailable, Restore) => Self::Restoring,
            (Self::Starting | Self::Restoring, Prepared) => Self::Ready,
            (Self::Starting | Self::Restoring | Self::Ready | Self::Closing, Lost) => {
                Self::Unavailable
            }
            (Self::Starting | Self::Restoring | Self::Ready | Self::Unavailable, Close) => {
                Self::Closing
            }
            (Self::Closing, Closed) => Self::Absent,
            _ => {
                return Err(AntigravityError::Protocol(
                    "invalid or stale connection transition".to_string(),
                ));
            }
        };
        *self = next;
        Ok(())
    }
}
impl Input {
    pub(super) fn begin(&mut self, rpc: u64) -> Result<(), AntigravityError> {
        if !matches!(self, Self::Idle) {
            return Err(AntigravityError::InputBusy);
        }
        *self = Self::Pending {
            rpc,
            accepted: false,
            native_started: false,
        };
        Ok(())
    }
    pub(super) fn accepted(&mut self, rpc: u64) -> bool {
        match self {
            Self::Pending {
                rpc: current,
                accepted,
                ..
            }
            | Self::Stopping {
                rpc: current,
                accepted,
                ..
            } if *current == rpc => {
                *accepted = true;
                true
            }
            _ => false,
        }
    }
    pub(super) fn stop(&mut self) -> bool {
        match *self {
            Self::Pending {
                rpc,
                accepted,
                native_started,
            } => {
                *self = Self::Stopping {
                    rpc,
                    accepted,
                    native_started,
                    cancel_accepted: false,
                };
                true
            }
            Self::Idle | Self::Stopping { .. } => false,
        }
    }
    /// Pinned ACP ignores cancel while the SDK agent is still starting.
    /// Only its live SDK tool/thought updates or permission callback prove
    /// readiness; message text, timestamps and native item matching do not.
    pub(super) fn native_started(&mut self) {
        match self {
            Self::Pending { native_started, .. } | Self::Stopping { native_started, .. } => {
                *native_started = true
            }
            Self::Idle => {}
        }
    }
    pub(super) fn cancel_due(&self) -> Option<u64> {
        match self {
            Self::Stopping {
                rpc,
                accepted: true,
                native_started: true,
                cancel_accepted: false,
            } => Some(*rpc),
            _ => None,
        }
    }
    pub(super) fn cancel_accepted(&mut self, rpc: u64) -> bool {
        match self {
            Self::Stopping {
                rpc: current,
                accepted: true,
                cancel_accepted,
                ..
            } if *current == rpc => {
                *cancel_accepted = true;
                true
            }
            _ => false,
        }
    }
    pub(super) fn cancel_refused(&mut self, rpc: u64) -> bool {
        match *self {
            Self::Stopping {
                rpc: current,
                accepted,
                native_started,
                cancel_accepted: false,
            } if current == rpc => {
                *self = Self::Pending {
                    rpc,
                    accepted,
                    native_started,
                };
                true
            }
            _ => false,
        }
    }
    pub(super) fn finish(&mut self, rpc: u64) -> bool {
        if self.rpc() != Some(rpc) {
            return false;
        }
        *self = Self::Idle;
        true
    }
    pub(super) fn rpc(&self) -> Option<u64> {
        match self {
            Self::Idle => None,
            Self::Pending { rpc, .. } | Self::Stopping { rpc, .. } => Some(*rpc),
        }
    }
    pub(super) fn operation(&self, phase: Phase) -> InputOperation {
        if phase != Phase::Ready {
            return InputOperation::Unavailable;
        }
        match self {
            Self::Idle => InputOperation::Idle,
            Self::Pending { .. } => InputOperation::Pending,
            Self::Stopping { .. } => InputOperation::Stopping,
        }
    }
    pub(super) fn was_accepted(&self) -> bool {
        matches!(
            self,
            Self::Pending { accepted: true, .. } | Self::Stopping { accepted: true, .. }
        )
    }
}
impl Checkpoint {
    pub(super) fn validate(
        &self,
        task: &str,
        disk: Option<&Binding>,
    ) -> Result<(), AntigravityError> {
        let invalid =
            || AntigravityError::Protocol("invalid or foreign recovery checkpoint".into());
        if self.version != 1
            || self.context.is_some_and(|context| context.size == 0)
            || self.task_id != task
            || self.next_rpc == 0
            || self
                .pending
                .keys()
                .any(|id| *id == 0 || *id >= self.next_rpc)
            || (self.authenticated && !self.initialized)
            || (self.loaded && (!self.authenticated || self.binding.is_none()))
            || self
                .pending
                .iter()
                .any(|(id, purpose)| *purpose == Purpose::Prompt && self.input.rpc() != Some(*id))
        {
            return Err(invalid());
        }
        if let Some(id) = self.input.rpc()
            && (id == 0
                || id >= self.next_rpc
                || (self.input.was_accepted() && self.pending.get(&id) != Some(&Purpose::Prompt)))
        {
            return Err(invalid());
        }
        if !valid_binding(&self.mcp_binding) {
            return Err(invalid());
        }
        if let Some(binding) = &self.binding {
            binding.validate(task)?;
            if binding.mcp_binding != self.mcp_binding
                || disk.is_some_and(|disk| {
                    disk.native_id != binding.native_id || disk.mcp_binding != binding.mcp_binding
                })
            {
                return Err(invalid());
            }
        }
        for purpose in self.pending.values() {
            match purpose {
                Purpose::New { cwd, .. } | Purpose::Load { cwd, .. }
                    if !Path::new(cwd).is_absolute() =>
                {
                    return Err(invalid());
                }
                Purpose::Load { native_id, .. } => validate_session(native_id)?,
                _ => {}
            }
        }
        Ok(())
    }
    pub(super) fn new(task_id: String, mcp_binding: String, binding: Option<Binding>) -> Self {
        Self {
            version: 1,
            task_id,
            binding,
            mcp_binding,
            initialized: false,
            authenticated: false,
            account: None,
            context: None,
            loaded: false,
            options: Vec::new(),
            next_rpc: 1,
            pending: BTreeMap::new(),
            input: Input::Idle,
            approvals: BTreeMap::new(),
            responses: BTreeMap::new(),
            reviewed: false,
        }
    }
    pub(super) fn next_id(&mut self) -> Result<u64, AntigravityError> {
        let id = self.next_rpc;
        self.next_rpc = id
            .checked_add(1)
            .ok_or_else(|| AntigravityError::Protocol("RPC identifier exhausted".to_string()))?;
        Ok(id)
    }
    pub(super) fn encode(&self) -> Result<String, AntigravityError> {
        serde_json::to_string(self).map_err(|e| AntigravityError::Protocol(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::http_mcp::new_binding_value;
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn context_reports_require_native_counts_but_allow_zero_and_decreases() {
        for used in [1200, 0, 50, 65000] {
            let context = Context::from_update(
                &json!({"sessionUpdate":"usage_update", "used":used, "size":64000, "cost":null}),
            )
            .unwrap();
            assert!(
                matches!(context.report(), SessionEventKind::ContextReported {context}
                if context.used_tokens == used && context.window_tokens == 64000)
            );
        }
        for update in [
            json!({"sessionUpdate":"usage_update", "used":1200, "size":0}),
            json!({"sessionUpdate":"usage_update", "used":1200}),
            json!({"sessionUpdate":"usage_update", "size":64000}),
            json!({"sessionUpdate":"usage_update", "used":-1, "size":64000}),
            json!({"sessionUpdate":"usage_update", "used":"1200", "size":64000}),
            json!({"sessionUpdate":"usage_update", "used":1.5, "size":64000}),
            json!({"sessionUpdate":"other", "used":1200, "size":64000}),
        ] {
            assert_eq!(Context::from_update(&update), None, "{update}");
        }
    }

    #[test]
    fn checkpoints_without_context_stay_unknown_and_zero_windows_are_invalid() {
        let task = Uuid::new_v4().to_string();
        let checkpoint = Checkpoint::new(task.clone(), new_binding_value(), None);
        let mut encoded = serde_json::to_value(checkpoint).unwrap();
        encoded.as_object_mut().unwrap().remove("context");
        let mut restored: Checkpoint = serde_json::from_value(encoded).unwrap();
        assert_eq!(restored.context, None);
        restored.validate(&task, None).unwrap();
        restored.context = Some(Context {
            used: 1200,
            size: 0,
        });
        assert!(restored.validate(&task, None).is_err());
    }
    #[test]
    fn checkpoint_rejects_foreign_bindings_and_inconsistent_accepted_inputs() {
        let task = Uuid::new_v4().to_string();
        let mut checkpoint = Checkpoint::new(task.clone(), new_binding_value(), None);
        checkpoint.validate(&task, None).unwrap();
        assert!(
            checkpoint
                .validate(&Uuid::new_v4().to_string(), None)
                .is_err()
        );
        let id = checkpoint.next_id().unwrap();
        checkpoint.input.begin(id).unwrap();
        checkpoint.input.accepted(id);
        assert!(checkpoint.validate(&task, None).is_err());
        checkpoint.pending.insert(id, Purpose::Prompt);
        checkpoint.validate(&task, None).unwrap();
        checkpoint.input.finish(id);
        assert!(checkpoint.validate(&task, None).is_err());
    }
    #[test]
    fn a_result_before_the_send_receipt_cannot_resurrect_an_input() {
        let mut input = Input::Idle;
        input.begin(17).unwrap();
        assert!(input.finish(17));
        assert!(!input.accepted(17));
        assert_eq!(input, Input::Idle);
    }
    #[test]
    fn stop_before_acceptance_waits_then_cancels_once_without_finishing_input() {
        let mut input = Input::Idle;
        input.begin(17).unwrap();
        assert!(input.stop());
        assert_eq!(input.cancel_due(), None);
        assert!(!input.stop());
        assert!(input.accepted(17));
        assert_eq!(input.cancel_due(), None);
        input.native_started();
        assert_eq!(input.cancel_due(), Some(17));
        assert!(input.cancel_accepted(17));
        assert_eq!(input.cancel_due(), None);
        assert_eq!(input.operation(Phase::Ready), InputOperation::Stopping);
        assert!(input.finish(17));
        assert_eq!(input, Input::Idle);
    }
    #[test]
    fn stale_results_and_duplicate_submissions_do_not_mutate_the_slot() {
        let mut input = Input::Idle;
        input.begin(17).unwrap();
        assert!(matches!(input.begin(18), Err(AntigravityError::InputBusy)));
        assert!(!input.finish(16));
        assert!(!input.accepted(16));
        assert_eq!(input.rpc(), Some(17));
        assert_eq!(
            input.operation(Phase::Restoring),
            InputOperation::Unavailable
        );
    }
    #[test]
    fn a_definitely_refused_cancel_returns_to_pending_and_allows_manual_stop() {
        let mut input = Input::Idle;
        input.begin(17).unwrap();
        input.accepted(17);
        input.native_started();
        input.stop();
        assert!(input.cancel_refused(17));
        assert_eq!(input.operation(Phase::Ready), InputOperation::Pending);
        assert!(input.stop());
        assert_eq!(input.cancel_due(), Some(17));
        input.cancel_accepted(17);
        assert!(!input.cancel_refused(17));
    }
    #[test]
    fn connection_nodes_have_one_transition_owner_and_late_prepared_cannot_reopen() {
        use ConnectionEvent::*;
        let mut phase = Phase::Absent;
        phase.transition(Start).unwrap();
        phase.transition(Prepared).unwrap();
        assert_eq!(phase, Phase::Ready);
        phase.transition(Restore).unwrap();
        phase.transition(Prepared).unwrap();
        phase.transition(Lost).unwrap();
        phase.transition(Restore).unwrap();
        phase.transition(Close).unwrap();
        assert!(phase.transition(Prepared).is_err());
        assert_eq!(phase, Phase::Closing);
        phase.transition(Lost).unwrap();
        phase.transition(Close).unwrap();
        phase.transition(Closed).unwrap();
        assert_eq!(phase, Phase::Absent);
        assert!(phase.transition(Prepared).is_err());
    }
}
