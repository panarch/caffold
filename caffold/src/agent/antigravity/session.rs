//! One Task's ACP connection. Its same-child checkpoint retains control and native
//! observations; fresh prompts own a disposable view, and a prompt the child is
//! still running when this connection attaches continues in a fresh one.

mod live;
mod permission;
mod reading;
mod state;

use caffold_runner::protocol::{ErrorCode as RunnerErrorCode, SpawnRequest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json, value::RawValue};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, Notify, broadcast, watch};

use super::{
    AntigravityError, AntigravityRuntimeEvent,
    authentication::{Authentication, Verified},
    binding::{Binding, Bindings},
    protocol::{self, RpcId},
    record::{Records, Snapshot},
};
use crate::agent::{
    ApprovalDecision, ApprovalOutcome, ApprovalRequest, ConversationItem, MessageContent,
    SessionEvent, SessionEventKind, ThreadActiveFlag, ThreadStatus, Turn, TurnPage,
    http_mcp::CAFFOLD_MCP_BINDING_HEADER,
    runner::{
        RecoveryEvent, RecoveryEvents, RecoveryFrames, RecoveryOutput, RunnerClient, RunnerError,
    },
};
use live::Live;
use state::{Checkpoint, ConnectionEvent, Context, Phase, Purpose};

/// Request control, independent of the native turn ledger and background work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum InputOperation {
    Idle,
    Pending,
    Stopping,
    Unavailable,
}

/// Current request control and normalized activity, owned only by this connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct InputObservation {
    pub(super) operation: InputOperation,
    pub(super) activity: Option<ThreadStatus>,
}

type RpcResult = Result<Value, AntigravityError>;
type Reply = watch::Receiver<Option<RpcResult>>;

pub(super) struct Environment {
    pub(super) runner: RunnerClient,
    pub(super) authentication: Authentication,
    pub(super) bindings: Bindings,
    pub(super) records: Records,
    pub(super) events: broadcast::Sender<AntigravityRuntimeEvent>,
    pub(super) mcp_endpoint: String,
}

pub(super) struct Session {
    pub(super) task_id: String,
    environment: Arc<Environment>,
    state: Mutex<State>,
    /// Serializes checkpoint replacement with stdin enqueue. Native response
    /// application deliberately does not wait on this gate.
    outbound: Mutex<()>,
    changed: Notify,
}

struct State {
    phase: Phase,
    checkpoint: Checkpoint,
    incarnation: String,
    frames: RecoveryFrames,
    through: u64,
    fence: u64,
    replay_complete: bool,
    replies: BTreeMap<u64, watch::Sender<Option<RpcResult>>>,
    observation: InputObservation,
    failure: Option<AntigravityError>,
    retired: bool,
    live: Option<Live>,
}

impl Session {
    pub(super) async fn attach(
        task_id: String,
        binding: Option<Binding>,
        mcp_binding: String,
        spawn: SpawnRequest,
        environment: Arc<Environment>,
        bypass: bool,
    ) -> Result<Arc<Self>, AntigravityError> {
        let attached = environment
            .runner
            .open_recoverable(&task_id, spawn)
            .await
            .map_err(transport_error)?;
        let snapshot = attached.snapshot;
        let starting = snapshot.session.spawned && snapshot.checkpoint.is_empty();
        let mut checkpoint = if snapshot.checkpoint.is_empty() {
            Checkpoint::new(task_id.clone(), mcp_binding, binding, bypass)
        } else {
            let checkpoint: Checkpoint =
                serde_json::from_str(&snapshot.checkpoint).map_err(|e| {
                    AntigravityError::Protocol(format!("invalid recovery checkpoint: {e}"))
                })?;
            checkpoint.validate(&task_id, binding.as_ref())?;
            checkpoint
        };
        // A reservation persisted by an earlier configuration request is not a
        // prompt enqueue. Only the runner's atomic accepted checkpoint is one.
        for id in checkpoint.input.unaccepted() {
            checkpoint.input.finish(id);
            checkpoint.pending.remove(&id);
        }
        let replies = checkpoint
            .pending
            .keys()
            .map(|id| (*id, watch::channel(None).0))
            .collect();
        let session = Arc::new(Self {
            task_id,
            environment,
            state: Mutex::new(State {
                phase: Phase::Absent,
                checkpoint,
                incarnation: snapshot.incarnation,
                frames: attached.frames,
                through: snapshot.acknowledged,
                fence: snapshot.fence,
                replay_complete: false,
                replies,
                observation: InputObservation {
                    operation: InputOperation::Unavailable,
                    activity: None,
                },
                failure: None,
                retired: false,
                live: None,
            }),
            outbound: Mutex::new(()),
            changed: Notify::new(),
        });
        session.state.lock().await.phase.transition(if starting {
            ConnectionEvent::Start
        } else {
            ConnectionEvent::Restore
        })?;
        tokio::spawn(Arc::clone(&session).read(attached.events));
        session.wait_replay().await?;
        Ok(session)
    }

    async fn wait_replay(&self) -> Result<(), AntigravityError> {
        loop {
            let changed = self.changed.notified();
            let state = self.state.lock().await;
            if let Some(error) = &state.failure {
                return Err(error.clone());
            }
            if state.replay_complete {
                return Ok(());
            }
            drop(state);
            changed.await;
        }
    }

    pub(super) async fn prepare(&self, cwd: &str, first: bool) -> Result<(), AntigravityError> {
        if !self.state.lock().await.checkpoint.initialized {
            self.rpc(Purpose::Initialize, "initialize", protocol::initialize())
                .await?;
        }
        let binding = self.state.lock().await.checkpoint.binding.clone();
        if !self.state.lock().await.checkpoint.loaded {
            let mcp_binding = self.state.lock().await.checkpoint.mcp_binding.clone();
            let mcp_servers = if self.environment.mcp_endpoint.is_empty() {
                json!([])
            } else {
                json!([{
                    "type":"http", "name":"caffold", "url":self.environment.mcp_endpoint,
                    "headers":[{"name":CAFFOLD_MCP_BINDING_HEADER,"value":mcp_binding}]
                }])
            };
            let mut params =
                json!({"cwd":cwd,"mcpServers":mcp_servers,"_meta":protocol::session_meta(first)});
            if let Some(binding) = binding {
                params["sessionId"] = json!(binding.native_id);
                self.rpc(
                    Purpose::Load {
                        native_id: binding.native_id,
                        cwd: cwd.into(),
                    },
                    "session/load",
                    params,
                )
                .await?;
            } else {
                self.rpc(
                    Purpose::New {
                        cwd: cwd.into(),
                        first,
                    },
                    "session/new",
                    params,
                )
                .await?;
            }
        }
        loop {
            let unfinished = {
                let state = self.state.lock().await;
                state
                    .checkpoint
                    .pending
                    .iter()
                    .find(|(_, purpose)| **purpose != Purpose::Prompt)
                    .and_then(|(id, _)| state.replies.get(id))
                    .map(watch::Sender::subscribe)
            };
            let Some(reply) = unfinished else {
                break;
            };
            tokio::time::timeout(Duration::from_secs(120), Self::answer(reply))
                .await
                .map_err(|_| {
                    AntigravityError::Unreachable(
                        "restored native configuration did not finish".into(),
                    )
                })??;
        }
        let mut state = self.state.lock().await;
        state.phase.transition(ConnectionEvent::Prepared)?;
        if let Some(account) = state.checkpoint.account.clone() {
            self.environment.authentication.observe(account).await;
        }
        self.publish_input(&mut state);
        Ok(())
    }

    /// When the child is still running a prompt as this connection attaches,
    /// show the rest of it in a continued turn; then republish the questions
    /// still waiting on the child. Frames wait on the state lock meanwhile, so
    /// nothing the child reports falls between the record read and the view
    /// that shows what follows it.
    pub(super) async fn continue_prompt(&self) -> Result<(), AntigravityError> {
        let mut state = self.state.lock().await;
        if state.live.is_none() && state.checkpoint.input.was_accepted() {
            let baseline = self.read_record(&state).await?;
            let mut live = Live::continuing(baseline.page, baseline.total_usage);
            self.publish(live.start_events());
            state.live = Some(live);
        }
        self.publish_approvals(&mut state)
    }

    async fn read_record(&self, state: &State) -> Result<Snapshot, AntigravityError> {
        let native = state
            .checkpoint
            .binding
            .as_ref()
            .ok_or_else(|| AntigravityError::Protocol("missing native session".into()))?
            .native_id
            .clone();
        let records = self.environment.records.clone();
        tokio::task::spawn_blocking(move || records.read(&native, None, 8))
            .await
            .map_err(|e| AntigravityError::Record(e.to_string()))?
    }

    async fn rpc(&self, purpose: Purpose, method: &str, params: Value) -> RpcResult {
        let existing = {
            let state = self.state.lock().await;
            state
                .checkpoint
                .pending
                .iter()
                .find(|(_, pending)| **pending == purpose)
                .and_then(|(id, _)| state.replies.get(id))
                .map(watch::Sender::subscribe)
        };
        let reply = match existing {
            Some(reply) => reply,
            None => self.request(purpose, method, params, None).await?,
        };
        // Model generation has no arbitrary RPC timeout. Bootstrap/config calls
        // have a bounded wait; a timeout never retries the accepted request.
        match tokio::time::timeout(Duration::from_secs(120), Self::answer(reply)).await {
            Ok(result) => result,
            Err(_) => {
                let error = AntigravityError::Unreachable(
                    "native request did not finish within 120 seconds; open the Task to reconnect"
                        .into(),
                );
                self.lost(error.clone()).await;
                Err(error)
            }
        }
    }

    /// Publish the current observation after opening or replacing the display.
    /// The lock orders replacement before its context and any newer native report.
    /// When a running prompt continues in a view, that view replaces the
    /// conversation instead of the native page: its newest native turns are
    /// the frozen prefix, below the one continued turn.
    pub(super) async fn publish_opened(&self, replacement: Option<TurnPage>) {
        let state = self.state.lock().await;
        if let Some(native) = replacement {
            let turns_page = state
                .live
                .as_ref()
                .and_then(|live| live.read_page(None, native.turns.len() + 1).ok().flatten())
                .unwrap_or(native);
            self.publish(vec![SessionEventKind::ConversationReplaced { turns_page }]);
        }
        self.publish_context(&state);
    }

    async fn answer(mut reply: Reply) -> RpcResult {
        loop {
            if let Some(result) = reply.borrow().clone() {
                return result;
            }
            reply.changed().await.map_err(|_| {
                AntigravityError::Unreachable("native response owner closed".into())
            })?;
        }
    }

    async fn request(
        &self,
        purpose: Purpose,
        method: &str,
        params: Value,
        reserved: Option<u64>,
    ) -> Result<Reply, AntigravityError> {
        let _outbound = self.outbound.lock().await;
        let (id, frames, through, encoded, reply) = {
            let mut state = self.state.lock().await;
            if state.retired
                || matches!(
                    state.phase,
                    Phase::Closing | Phase::Absent | Phase::Unavailable
                )
            {
                return Err(AntigravityError::Unreachable(
                    state
                        .failure
                        .as_ref()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| "connection is not ready".into()),
                ));
            }
            let id = match reserved {
                Some(id) => id,
                None => state.checkpoint.next_id()?,
            };
            if let Some(id) = reserved
                && !state.checkpoint.input.contains(id)
            {
                return Err(AntigravityError::Protocol(
                    "input reservation no longer belongs to this request".into(),
                ));
            }
            state.checkpoint.pending.insert(id, purpose.clone());
            let (sender, reply) = watch::channel(None);
            state.replies.insert(id, sender);
            let mut accepted = state.checkpoint.clone();
            if purpose == Purpose::Prompt {
                accepted.input.accepted(id);
            }
            (
                id,
                state.frames.clone(),
                state.through,
                accepted.encode()?,
                reply,
            )
        };
        let frame = RawValue::from_string(
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
        )
        .map_err(|e| AntigravityError::Protocol(e.to_string()))?;
        match frames.send(through, encoded, frame).await {
            Ok(()) => {
                let mut state = self.state.lock().await;
                if purpose == Purpose::Prompt {
                    state.checkpoint.input.accepted(id);
                }
                self.changed.notify_waiters();
                Ok(reply)
            }
            Err(error) => {
                let unknown = matches!(error, RunnerError::OutcomeUnknown(_));
                let backpressure = matches!(
                    &error,
                    RunnerError::Rejected {
                        code: RunnerErrorCode::Backpressure,
                        ..
                    }
                );
                let error = transport_error(error);
                if !unknown {
                    let mut state = self.state.lock().await;
                    state.checkpoint.pending.remove(&id);
                    state.replies.remove(&id);
                    if purpose == Purpose::Prompt {
                        state.checkpoint.input.finish(id);
                        self.publish_input(&mut state);
                    }
                }
                if unknown || !backpressure {
                    self.lost(error.clone()).await;
                }
                Err(error)
            }
        }
    }

    pub(super) async fn configure(&self, id: &str, value: &str) -> Result<(), AntigravityError> {
        let native_id = self.binding().await?.native_id;
        {
            let state = self.state.lock().await;
            let option = protocol::config(&state.checkpoint.options, id)?;
            if !option.options.iter().any(|choice| choice.value == value) {
                return Err(AntigravityError::Protocol(format!(
                    "unsupported native {id} choice"
                )));
            }
            if option.current_value == value {
                return Ok(());
            }
        }
        self.rpc(
            Purpose::Configure {
                id: id.into(),
                value: value.into(),
            },
            "session/set_config_option",
            json!({"sessionId":native_id,"configId":id,"value":value}),
        )
        .await?;
        let state = self.state.lock().await;
        if protocol::config(&state.checkpoint.options, id)?.current_value != value {
            return Err(AntigravityError::Protocol(format!(
                "native {id} did not accept the requested choice"
            )));
        }
        Ok(())
    }

    pub(super) async fn reserve(&self) -> Result<u64, AntigravityError> {
        let mut state = self.state.lock().await;
        if state.phase != Phase::Ready {
            return Err(AntigravityError::Unreachable(
                "connection is not ready".into(),
            ));
        }
        let id = state.checkpoint.next_id()?;
        state.checkpoint.input.begin(id)?;
        self.publish_input(&mut state);
        Ok(id)
    }

    pub(super) async fn release_reservation(&self, id: u64) {
        let mut state = self.state.lock().await;
        if state.phase == Phase::Ready
            && state.checkpoint.input.contains(id)
            && !state.checkpoint.input.accepted_rpc(id)
        {
            state.checkpoint.input.finish(id);
            self.publish_input(&mut state);
        }
    }

    pub(super) async fn prompt(
        &self,
        id: u64,
        content: Value,
        text: &str,
        display_content: Vec<MessageContent>,
        baseline: Snapshot,
    ) -> Result<Turn, AntigravityError> {
        let (native_id, turn) = {
            let mut state = self.state.lock().await;
            let binding = state
                .checkpoint
                .binding
                .as_ref()
                .ok_or_else(|| AntigravityError::Protocol("missing native session".into()))?;
            let native_id = binding.native_id.clone();
            if state.live.as_ref().is_some_and(Live::needs_rebuild) {
                self.publish(vec![SessionEventKind::ConversationReplaced {
                    turns_page: baseline.page.clone(),
                }]);
                self.publish_context(&state);
                state.live = None;
            }
            let turn = state
                .live
                .get_or_insert_with(|| {
                    let mut live = Live::new(baseline.page);
                    live.set_baseline_usage(baseline.total_usage);
                    live
                })
                .begin(text, display_content);
            state
                .live
                .as_mut()
                .expect("prompt display owner")
                .track_prompt(id, &turn.items[0].id);
            (native_id, turn)
        };
        let sent = self
            .request(
                Purpose::Prompt,
                "session/prompt",
                json!({"sessionId":native_id,"prompt":content}),
                Some(id),
            )
            .await;
        let mut state = self.state.lock().await;
        let live = state.live.as_mut().expect("prompt display owner");
        match sent {
            Ok(_) => self.publish(live.start_events()),
            Err(error) => {
                live.reject(&turn.id);
                return Err(error);
            }
        }
        drop(state);
        // This prompt is already enqueued. A remembered Stop has its own
        // result and cannot turn that known acceptance into a prompt rejection.
        let _ = self.cancel_if_due().await;
        Ok(turn)
    }

    pub(super) async fn steer(
        &self,
        expected: &str,
        content: Value,
        text: &str,
        display: Vec<MessageContent>,
    ) -> Result<ConversationItem, AntigravityError> {
        let (id, native, item) = {
            let mut state = self.state.lock().await;
            if state.phase != Phase::Ready {
                return Err(AntigravityError::Unreachable(
                    "connection is not ready".into(),
                ));
            }
            if state.live.as_ref().and_then(Live::active_turn) != Some(expected) {
                return Err(AntigravityError::InputGone);
            }
            if !state.checkpoint.approvals.is_empty() {
                return Err(AntigravityError::InputRejected("Answer the pending permission or question, or stop the turn before sending another prompt".into()));
            }
            let native = state
                .checkpoint
                .binding
                .as_ref()
                .ok_or_else(|| AntigravityError::Protocol("missing native session".into()))?
                .native_id
                .clone();
            let id = state.checkpoint.next_id()?;
            state.checkpoint.input.steer(id)?;
            let item = state
                .live
                .as_mut()
                .ok_or(AntigravityError::InputGone)?
                .steer(id, text, display)?;
            (id, native, item)
        };
        match self
            .request(
                Purpose::Prompt,
                "session/prompt",
                json!({"sessionId":native,"prompt":content}),
                Some(id),
            )
            .await
        {
            Ok(reply) => {
                // Order acceptance against native rejection so a late receipt
                // cannot overwrite the failed item published by the reader.
                let state = self.state.lock().await;
                if let Some(Err(error)) = reply.borrow().clone() {
                    return Err(error);
                }
                self.publish(vec![SessionEventKind::ItemChanged {
                    turn_id: expected.into(),
                    item: item.clone(),
                    at_ms: item.observed_at_ms.unwrap_or(0),
                }]);
                drop(state);
                let _ = self.cancel_if_due().await;
                Ok(item)
            }
            Err(error) => {
                if !matches!(error, AntigravityError::DispatchUnknown(_)) {
                    let mut state = self.state.lock().await;
                    if let Some(live) = &mut state.live {
                        live.reject_steering(id);
                    }
                    if state.checkpoint.input.operation(state.phase) == InputOperation::Idle
                        && let Some(live) = &mut state.live
                    {
                        self.publish(live.finish(&Err(error.clone())));
                    }
                }
                Err(error)
            }
        }
    }

    pub(super) async fn live_page(
        &self,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Option<TurnPage>, AntigravityError> {
        match &self.state.lock().await.live {
            Some(live) => live.read_page(before, limit),
            None => Ok(None),
        }
    }

    pub(super) async fn has_live_view(&self) -> bool {
        self.state.lock().await.live.is_some()
    }

    fn publish(&self, events: Vec<SessionEventKind>) {
        for kind in events {
            let _ = self
                .environment
                .events
                .send(AntigravityRuntimeEvent::Session(Box::new(SessionEvent {
                    thread_id: self.task_id.clone(),
                    kind,
                })));
        }
    }

    fn publish_context(&self, state: &State) {
        if let Some(context) = state.checkpoint.context {
            self.publish(vec![context.report()]);
        }
    }

    pub(super) async fn interrupt(&self) -> Result<(), AntigravityError> {
        {
            let mut state = self.state.lock().await;
            if state.phase != Phase::Ready {
                return Err(AntigravityError::Unreachable(
                    "connection is not ready".into(),
                ));
            }
            if state.checkpoint.input.stop() {
                self.publish_input(&mut state);
            }
        }
        self.cancel_if_due().await
    }

    async fn cancel_if_due(&self) -> Result<(), AntigravityError> {
        let _outbound = self.outbound.lock().await;
        let (rpc, frames, through, encoded, frame) = {
            let state = self.state.lock().await;
            let Some(rpc) = state.checkpoint.input.cancel_due() else {
                return Ok(());
            };
            let mut accepted = state.checkpoint.clone();
            accepted.input.cancel_accepted(rpc);
            let native = &accepted
                .binding
                .as_ref()
                .ok_or_else(|| AntigravityError::Protocol("missing native session".into()))?
                .native_id;
            let frame = RawValue::from_string(
                json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":native}})
                    .to_string(),
            )
            .expect("JSON value");
            (
                rpc,
                state.frames.clone(),
                state.through,
                accepted.encode()?,
                frame,
            )
        };
        match frames.send(through, encoded, frame).await {
            Ok(()) => {
                self.state
                    .lock()
                    .await
                    .checkpoint
                    .input
                    .cancel_accepted(rpc);
                Ok(())
            }
            Err(error) => {
                if !matches!(error, RunnerError::OutcomeUnknown(_)) {
                    let mut state = self.state.lock().await;
                    if state.checkpoint.input.cancel_refused(rpc) {
                        self.publish_input(&mut state);
                    }
                }
                let error = transport_error(error);
                if matches!(error, AntigravityError::DispatchUnknown(_)) {
                    self.lost(error.clone()).await;
                }
                Err(error)
            }
        }
    }

    pub(super) async fn binding(&self) -> Result<Binding, AntigravityError> {
        self.state
            .lock()
            .await
            .checkpoint
            .binding
            .clone()
            .ok_or_else(|| AntigravityError::Binding("native session has not been created".into()))
    }
    pub(super) async fn mcp_binding(&self) -> String {
        self.state.lock().await.checkpoint.mcp_binding.clone()
    }
    pub(super) async fn options(&self) -> Vec<protocol::ConfigOption> {
        self.state.lock().await.checkpoint.options.clone()
    }
    pub(super) async fn observation(&self) -> InputObservation {
        self.state.lock().await.observation.clone()
    }
    pub(super) async fn bypass(&self) -> bool {
        self.state.lock().await.checkpoint.bypass
    }
    pub(super) async fn reviewed(&self) -> bool {
        self.state.lock().await.checkpoint.reviewed
    }
    pub(super) async fn set_reviewed(&self, reviewed: bool) {
        self.state.lock().await.checkpoint.reviewed = reviewed;
    }
    pub(super) async fn ready(&self) -> bool {
        let state = self.state.lock().await;
        state.phase == Phase::Ready && !state.retired
    }
    pub(super) async fn requires_new_child(&self) -> bool {
        matches!(
            self.state.lock().await.failure,
            Some(AntigravityError::NativeEnded(_))
        )
    }
    pub(super) async fn retire(&self) {
        let _outbound = self.outbound.lock().await;
        self.state.lock().await.retired = true;
        self.environment
            .runner
            .release_observer(&self.task_id)
            .await;
    }

    pub(super) async fn close(&self) -> Result<(), AntigravityError> {
        self.close_inner(false).await
    }

    pub(super) async fn close_idle(&self) -> Result<(), AntigravityError> {
        self.close_inner(true).await
    }

    async fn close_inner(&self, idle: bool) -> Result<(), AntigravityError> {
        {
            let mut state = self.state.lock().await;
            if idle && state.checkpoint.input.operation(state.phase) != InputOperation::Idle {
                return Err(AntigravityError::InputBusy);
            }
            if state.phase == Phase::Absent {
                return Ok(());
            }
            state.phase.transition(ConnectionEvent::Close)?;
            self.publish_input(&mut state);
        }
        // Runner closes stdin first and waits for native cancellation, the
        // harness and stdout drain before acknowledging writer termination.
        match self
            .environment
            .runner
            .close_recoverable(&self.task_id)
            .await
        {
            Ok(()) => {
                let mut state = self.state.lock().await;
                if state.phase == Phase::Unavailable {
                    state.phase.transition(ConnectionEvent::Close)?;
                }
                if state.phase == Phase::Closing {
                    state.phase.transition(ConnectionEvent::Closed)?;
                }
                self.expire(&mut state);
                Ok(())
            }
            Err(error) => {
                let error = transport_error(error);
                self.lost(error.clone()).await;
                Err(error)
            }
        }
    }

    fn publish_input(&self, state: &mut State) {
        if state.retired {
            return;
        }
        let operation = state.checkpoint.input.operation(state.phase);
        let activity = if state.phase == Phase::Ready {
            Some(if operation == InputOperation::Idle {
                ThreadStatus::Idle
            } else {
                ThreadStatus::Active {
                    active_flags: if state.checkpoint.approvals.is_empty() {
                        vec![]
                    } else {
                        vec![ThreadActiveFlag::WaitingOnApproval]
                    },
                }
            })
        } else {
            None
        };
        let next = InputObservation {
            operation,
            activity,
        };
        if state.observation == next {
            return;
        }
        state.observation = next;
        let _ = self
            .environment
            .events
            .send(AntigravityRuntimeEvent::Session(Box::new(SessionEvent {
                thread_id: self.task_id.clone(),
                kind: SessionEventKind::ActivityChanged {
                    status: state
                        .observation
                        .activity
                        .clone()
                        .unwrap_or(ThreadStatus::NotLoaded),
                },
            })));
    }

    async fn lost(&self, error: AntigravityError) {
        let mut state = self.state.lock().await;
        if state.retired || state.phase == Phase::Absent {
            return;
        }
        if state.phase != Phase::Unavailable {
            let _ = state.phase.transition(ConnectionEvent::Lost);
        }
        state.failure = Some(error.clone());
        for reply in state.replies.values() {
            reply.send_replace(Some(Err(error.clone())));
        }
        self.publish_input(&mut state);
        let _ = self
            .environment
            .events
            .send(AntigravityRuntimeEvent::Unreachable {
                conversation_id: self.task_id.clone(),
                message: error.to_string(),
            });
        self.changed.notify_waiters();
    }

    fn expire(&self, state: &mut State) {
        for key in state.checkpoint.approvals.keys() {
            let _ = self
                .environment
                .events
                .send(AntigravityRuntimeEvent::ApprovalEnded {
                    conversation_id: self.task_id.clone(),
                    approval_id: permission::approval_id(&state.incarnation, key),
                    outcome: ApprovalOutcome::Unavailable,
                });
        }
        state.checkpoint.approvals.clear();
        for reply in state.replies.values() {
            reply.send_replace(Some(Err(AntigravityError::Unreachable(
                "native session closed".into(),
            ))));
        }
        state.replies.clear();
        state.checkpoint.pending.clear();
        state.checkpoint.input = state::Input::Idle;
    }
}

fn transport_error(error: RunnerError) -> AntigravityError {
    match error {
        RunnerError::OutcomeUnknown(message) => AntigravityError::DispatchUnknown(message),
        other => AntigravityError::Unreachable(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::antigravity::record::fixture::{self, FixtureData, hex};
    use crate::agent::{ContextUsage, TokenCount, TurnStatus, http_mcp::new_binding_value};
    use caffold_runner::{client::Client, daemon, protocol::Request};
    use rusqlite::Connection;
    use std::{fs, path::PathBuf};
    use tempfile::TempDir;
    use tokio::task::{JoinHandle, LocalSet};

    use uuid::Uuid;

    /// The native session ID `fixtures/fake_acp.py` answers with.
    const FIXTURE_NATIVE: &str = "63910fa2-b1ed-4e64-87b8-b9928c1d7015";

    impl Session {
        async fn test_prompt(&self, id: u64, content: Value) -> Result<(), AntigravityError> {
            self.prompt(
                id,
                content,
                "fixture",
                vec![MessageContent::Text {
                    text: "fixture".into(),
                }],
                Snapshot {
                    page: TurnPage::default(),
                    usage: BTreeMap::new(),
                    total_usage: TokenCount {
                        total_tokens: 0,
                        input_tokens: 0,
                        cached_input_tokens: 0,
                        cache_write_input_tokens: 0,
                        output_tokens: 0,
                        reasoning_output_tokens: 0,
                    },
                    created_at_ms: 0,
                    updated_at_ms: 0,
                    preview: String::new(),
                },
            )
            .await?;
            Ok(())
        }
    }

    struct Harness {
        directory: TempDir,
        environment: Arc<Environment>,
        daemon: JoinHandle<anyhow::Result<()>>,
        task: String,
        spawn: SpawnRequest,
    }
    impl Harness {
        async fn start(behavior: &str) -> Self {
            let directory = TempDir::new().unwrap();
            let socket = directory.path().join("runner.sock");
            let listener = daemon::bind(&socket).await.unwrap();
            let daemon =
                tokio::task::spawn_local(daemon::Runner::new(socket.clone(), None).serve(listener));
            let (events, _) = broadcast::channel(256);
            fs::create_dir(directory.path().join("records")).unwrap();
            let environment = Arc::new(Environment {
                authentication: Authentication::default(),
                runner: RunnerClient::at_socket(socket),
                bindings: Bindings::new(directory.path().join("bindings")),
                records: Records::new(directory.path().join("records")),
                events,
                mcp_endpoint: "http://127.0.0.1:1/api/antigravity/mcp".into(),
            });
            let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("src/agent/antigravity/session/fixtures/fake_acp.py");
            let spawn = SpawnRequest {
                argv: vec![
                    "/usr/bin/python3".into(),
                    "-u".into(),
                    fixture.display().to_string(),
                ],
                cwd: directory.path().display().to_string(),
                env: BTreeMap::from([
                    (
                        "ACP_FIXTURE_LOG".into(),
                        directory.path().join("calls.jsonl").display().to_string(),
                    ),
                    (
                        "ACP_FIXTURE_FINISH".into(),
                        directory.path().join("finish").display().to_string(),
                    ),
                    ("ACP_FIXTURE_BEHAVIOR".into(), behavior.into()),
                ]),
            };
            Self {
                directory,
                environment,
                daemon,
                task: Uuid::new_v4().to_string(),
                spawn,
            }
        }
        async fn open(&self) -> Arc<Session> {
            let binding = self.environment.bindings.read(&self.task).unwrap();
            let session = Session::attach(
                self.task.clone(),
                binding,
                new_binding_value(),
                self.spawn.clone(),
                self.environment.clone(),
                false,
            )
            .await
            .unwrap();
            session.prepare(&self.spawn.cwd, true).await.unwrap();
            session.continue_prompt().await.unwrap();
            session.publish_opened(None).await;
            session
        }
        /// The fixture child's native record with its one execution still
        /// running, and the writer that can end it.
        fn running_record(&self) -> (Connection, FixtureData) {
            let mut data = fixture::parse(include_str!("record/fixtures/single-turn.json"));
            data.identity.cascade = FIXTURE_NATIVE.into();
            let path = self
                .directory
                .path()
                .join("records")
                .join(format!("{FIXTURE_NATIVE}.db"));
            let connection = fixture::write(&path, &data);
            connection
                .execute("DELETE FROM executor_metadata", [])
                .unwrap();
            (connection, data)
        }
        fn calls(&self) -> Vec<Value> {
            fs::read_to_string(self.directory.path().join("calls.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        }
        async fn stop(self) {
            let mut client = Client::connect(&self.directory.path().join("runner.sock"))
                .await
                .unwrap();
            client.request(Request::DaemonStop).await.unwrap();
            self.daemon.await.unwrap().unwrap();
        }
    }
    async fn finished(session: &Session) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                {
                    let state = session.state.lock().await;
                    assert!(state.failure.is_none(), "native fixture failed");
                    if state.checkpoint.input.rpc().is_none() {
                        return;
                    }
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
    async fn restored(harness: &Harness, first: &Arc<Session>) -> Arc<Session> {
        first.retire().await;
        harness.environment.runner.disconnect().await;
        harness.open().await
    }

    async fn next_context(
        events: &mut broadcast::Receiver<AntigravityRuntimeEvent>,
    ) -> ContextUsage {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let AntigravityRuntimeEvent::Session(event) = events.recv().await.unwrap()
                    && let SessionEventKind::ContextReported { context } = event.kind
                {
                    return context;
                }
            }
        })
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn initial_and_loaded_context_reports_need_no_live_display_or_prompt() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("context").await;
                let mut events = harness.environment.events.subscribe();
                let first = harness.open().await;
                assert_eq!(
                    next_context(&mut events).await,
                    ContextUsage {
                        used_tokens: 0,
                        window_tokens: 64000
                    }
                );
                assert!(!first.has_live_view().await);
                first.close().await.unwrap();
                first.retire().await;
                let mut events = harness.environment.events.subscribe();
                let loaded = harness.open().await;
                assert_eq!(next_context(&mut events).await.used_tokens, 900);
                assert!(!loaded.has_live_view().await);
                assert!(
                    !harness
                        .calls()
                        .iter()
                        .any(|frame| frame["method"] == "session/prompt")
                );
                loaded.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn idle_context_restores_from_same_child_without_an_extra_request() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("context").await;
                let first = harness.open().await;
                let id = first.reserve().await.unwrap();
                first
                    .test_prompt(id, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                finished(&first).await;
                let calls: Vec<_> = harness
                    .calls()
                    .into_iter()
                    .filter(|frame| frame.get("method").is_some())
                    .collect();
                let mut events = harness.environment.events.subscribe();
                let second = restored(&harness, &first).await;
                assert_eq!(next_context(&mut events).await.used_tokens, 2400);
                assert!(!second.has_live_view().await);
                let restored_calls: Vec<_> = harness
                    .calls()
                    .into_iter()
                    .filter(|frame| frame.get("method").is_some())
                    .collect();
                assert_eq!(
                    restored_calls, calls,
                    "restore must not query or prompt the child"
                );
                assert_eq!(
                    first.state.lock().await.incarnation,
                    second.state.lock().await.incarnation
                );
                let mut events = harness.environment.events.subscribe();
                second.publish_opened(Some(TurnPage::default())).await;
                let AntigravityRuntimeEvent::Session(event) = events.recv().await.unwrap() else {
                    panic!("reconstruction must replace the display");
                };
                assert!(matches!(
                    event.kind,
                    SessionEventKind::ConversationReplaced { .. }
                ));
                assert_eq!(next_context(&mut events).await.used_tokens, 2400);
                second.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn recovered_active_context_accepts_later_reports_beside_a_continued_turn() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("context-gated").await;
                let _record = harness.running_record();
                let first = harness.open().await;
                let mut events = harness.environment.events.subscribe();
                let id = first.reserve().await.unwrap();
                first
                    .test_prompt(id, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                assert_eq!(next_context(&mut events).await.used_tokens, 1200);
                let mut events = harness.environment.events.subscribe();
                let second = restored(&harness, &first).await;
                assert_eq!(next_context(&mut events).await.used_tokens, 1200);
                assert!(second.has_live_view().await);
                assert_eq!(
                    second.observation().await.operation,
                    InputOperation::Pending
                );
                fs::write(harness.directory.path().join("finish"), b"finish").unwrap();
                assert_eq!(next_context(&mut events).await.used_tokens, 2400);
                finished(&second).await;
                second.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn display_retention_republishes_context_immediately_after_replacement() {
        LocalSet::new().run_until(async {
            let harness = Harness::start("context").await;
            let session = harness.open().await;
            for _ in 0..8 {
                let id = session.reserve().await.unwrap();
                session.test_prompt(id, json!([{"type":"text","text":"fixture"}])).await.unwrap();
                finished(&session).await;
            }
            let mut events = harness.environment.events.subscribe();
            let id = session.reserve().await.unwrap();
            session.test_prompt(id, json!([{"type":"text","text":"fixture"}])).await.unwrap();
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let AntigravityRuntimeEvent::Session(event) = events.recv().await.unwrap()
                        && matches!(event.kind, SessionEventKind::ConversationReplaced {..}) { break; }
                }
            }).await.unwrap();
            let AntigravityRuntimeEvent::Session(event) = events.recv().await.unwrap() else {panic!("context must follow replacement")};
            assert!(matches!(event.kind, SessionEventKind::ContextReported {context} if context.used_tokens == 2400));
            finished(&session).await;
            session.close().await.unwrap();
            harness.stop().await;
        }).await;
    }

    #[tokio::test]
    async fn a_new_child_without_a_report_does_not_inherit_context() {
        LocalSet::new()
            .run_until(async {
                let mut harness = Harness::start("context").await;
                let first = harness.open().await;
                assert!(first.state.lock().await.checkpoint.context.is_some());
                first.close().await.unwrap();
                first.retire().await;
                harness
                    .spawn
                    .env
                    .insert("ACP_FIXTURE_BEHAVIOR".into(), "pending".into());
                let mut events = harness.environment.events.subscribe();
                let second = harness.open().await;
                assert_ne!(
                    first.state.lock().await.incarnation,
                    second.state.lock().await.incarnation
                );
                assert!(second.state.lock().await.checkpoint.context.is_none());
                while let Ok(event) = events.try_recv() {
                    assert!(!matches!(event, AntigravityRuntimeEvent::Session(event)
                    if matches!(event.kind, SessionEventKind::ContextReported {..})));
                }
                second.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn invalid_context_keeps_the_last_valid_native_report() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("context-invalid").await;
                let mut events = harness.environment.events.subscribe();
                let session = harness.open().await;
                assert_eq!(next_context(&mut events).await.used_tokens, 0);
                assert_eq!(next_context(&mut events).await.used_tokens, 0);
                while let Ok(event) = events.try_recv() {
                    assert!(!matches!(event, AntigravityRuntimeEvent::Session(event)
                        if matches!(event.kind, SessionEventKind::ContextReported {..})));
                }
                assert!(session.ready().await);
                session.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn authentication_requirement_stops_a_probe_without_creating_a_handoff() {
        LocalSet::new()
            .run_until(async {
                for behavior in ["auth-required", "auth-network-error"] {
                    let harness = Harness::start(behavior).await;
                    let session = Session::attach(
                        harness.task.clone(),
                        None,
                        new_binding_value(),
                        harness.spawn.clone(),
                        harness.environment.clone(),
                        false,
                    )
                    .await
                    .unwrap();
                    let error = session.prepare(&harness.spawn.cwd, true).await.unwrap_err();
                    assert_eq!(
                        matches!(error, AntigravityError::SignInRequired),
                        behavior == "auth-required"
                    );
                    let status =
                        serde_json::to_value(harness.environment.authentication.status().await)
                            .unwrap();
                    assert!(status.get("phase").is_none());
                    assert!(status.get("requestId").is_none());
                    assert!(status.get("authorizationUrl").is_none());
                    if behavior == "auth-required" {
                        assert_eq!(status["verified"]["authenticated"], false);
                    } else {
                        assert!(
                            status["verified"].is_null(),
                            "network failure is not sign-out"
                        );
                    }
                    assert!(
                        !harness
                            .calls()
                            .iter()
                            .any(|frame| frame["method"] == "authenticate")
                    );
                    session.close().await.unwrap();
                    harness.stop().await;
                }
            })
            .await;
    }

    #[tokio::test]
    async fn an_idle_only_close_cannot_terminate_pending_input_or_change_launch_permissions() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("gated").await;
                let session = Session::attach(
                    harness.task.clone(),
                    None,
                    new_binding_value(),
                    harness.spawn.clone(),
                    harness.environment.clone(),
                    true,
                )
                .await
                .unwrap();
                session.prepare(&harness.spawn.cwd, true).await.unwrap();
                let id = session.reserve().await.unwrap();
                session
                    .test_prompt(id, json!([{"type":"text","text":"first"}]))
                    .await
                    .unwrap();
                assert!(matches!(
                    session.close_idle().await,
                    Err(AntigravityError::InputBusy)
                ));
                assert!(session.bypass().await);
                assert_eq!(
                    session.observation().await.operation,
                    InputOperation::Pending
                );
                fs::write(harness.directory.path().join("finish"), "go").unwrap();
                finished(&session).await;
                let reattached = restored(&harness, &session).await;
                assert!(
                    reattached.bypass().await,
                    "the same child keeps its actual launch flag"
                );
                reattached.close_idle().await.unwrap();
                harness.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn steering_keeps_the_turn_running_after_earlier_prompt_responses() {
        LocalSet::new().run_until(async {
            let harness = Harness::start("steering").await;
            let mut events = harness.environment.events.subscribe();
            let session = harness.open().await;
            let id = session.reserve().await.unwrap();
            session.test_prompt(id, json!([{"type":"text","text":"first"}])).await.unwrap();
            let turn = session.live_page(None, 8).await.unwrap().unwrap().turns[0].id.clone();
            for text in ["second", "third"] {
                session.steer(&turn, json!([{"type":"text","text":text}]), text,
                    vec![MessageContent::Text { text: text.into() }]).await.unwrap();
            }
            assert_eq!(session.observation().await.operation, InputOperation::Pending);
            let page = session.live_page(None, 8).await.unwrap().unwrap();
            assert_eq!(page.turns[0].status, TurnStatus::InProgress);
            assert_eq!(page.turns[0].items.iter().filter(|item| matches!(item.kind, crate::agent::ItemKind::UserMessage { .. })).count(), 3);
            while let Ok(event) = events.try_recv() {
                assert!(!matches!(event, AntigravityRuntimeEvent::Session(event) if matches!(event.kind, SessionEventKind::TurnEnded { .. })));
            }
            fs::write(harness.directory.path().join("finish"), "go").unwrap();
            finished(&session).await;
            assert_eq!(session.live_page(None, 8).await.unwrap().unwrap().turns[0].status, TurnStatus::Completed);
            assert!(matches!(session.steer(&turn, json!([]), "late", vec![]).await, Err(AntigravityError::InputGone)));
            assert_eq!(harness.calls().iter().filter(|frame| frame["method"] == "session/prompt").count(), 3);
            session.close().await.unwrap();
            harness.stop().await;
        }).await;
    }

    #[tokio::test]
    async fn a_native_steering_rejection_does_not_end_the_original_request() {
        LocalSet::new().run_until(async {
            let harness = Harness::start("steering-rejected").await;
            let session = harness.open().await;
            let id = session.reserve().await.unwrap();
            session.test_prompt(id, json!([{"type":"text","text":"first"}])).await.unwrap();
            let turn = session.live_page(None, 8).await.unwrap().unwrap().turns[0].id.clone();
            let result = session.steer(&turn, json!([{"type":"text","text":"second"}]), "second", vec![]).await;
            if let Err(error) = result { assert!(matches!(error, AntigravityError::Rpc { code: -32603, .. })); }
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let page = session.live_page(None, 8).await.unwrap().unwrap();
                    if page.turns[0].items.iter().any(|item| matches!(&item.kind, crate::agent::ItemKind::Failure { text } if text.contains("permission or question"))) { break; }
                    tokio::task::yield_now().await;
                }
            }).await.unwrap();
            assert_eq!(session.observation().await.operation, InputOperation::Pending);
            fs::write(harness.directory.path().join("finish"), "go").unwrap();
            finished(&session).await;
            assert_eq!(session.live_page(None, 8).await.unwrap().unwrap().turns[0].status, TurnStatus::Completed);
            session.close().await.unwrap();
            harness.stop().await;
        }).await;
    }

    #[tokio::test]
    async fn unexpected_structured_question_gets_feedback_error_without_a_permission_or_user_answer()
     {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("question").await;
                let mut events = harness.environment.events.subscribe();
                let session = harness.open().await;
                let reserved = session.reserve().await.unwrap();
                session
                    .test_prompt(reserved, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                finished(&session).await;
                assert!(harness.calls().iter().any(|frame| frame["id"] == 991
                    && frame["error"]["code"] == -32601
                    && frame.get("result").is_none()));
                while let Ok(event) = events.try_recv() {
                    assert!(!matches!(event, AntigravityRuntimeEvent::Approval { .. }));
                }
                session.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }
    #[tokio::test]
    async fn early_stop_waits_for_native_start_instead_of_losing_cancel_during_sdk_bootstrap() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("startup").await;
                let session = harness.open().await;
                let reserved = session.reserve().await.unwrap();
                session
                    .test_prompt(reserved, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                session.interrupt().await.unwrap();
                assert_eq!(
                    session.observation().await.operation,
                    InputOperation::Stopping
                );
                assert!(
                    !harness
                        .calls()
                        .iter()
                        .any(|frame| frame["method"] == "session/cancel")
                );
                fs::write(harness.directory.path().join("finish.start"), b"start").unwrap();
                finished(&session).await;
                let calls = harness.calls();
                assert!(
                    !calls
                        .iter()
                        .any(|frame| frame.get("cancel_ignored_before_start").is_some())
                );
                assert_eq!(
                    calls
                        .iter()
                        .filter(|frame| frame["method"] == "session/cancel")
                        .count(),
                    1
                );
                session.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }
    #[tokio::test]
    async fn accepted_prompt_survives_backend_detach_and_idless_stop_uses_the_same_child() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("pending").await;
                let _record = harness.running_record();
                let first = harness.open().await;
                let reserved = first.reserve().await.unwrap();
                first
                    .test_prompt(reserved, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                let second = restored(&harness, &first).await;
                assert_eq!(
                    second.observation().await.operation,
                    InputOperation::Pending
                );
                second.interrupt().await.unwrap();
                finished(&second).await;
                assert_eq!(second.observation().await.operation, InputOperation::Idle);
                let calls = harness.calls();
                assert_eq!(
                    calls
                        .iter()
                        .filter(|frame| frame.get("pid").is_some())
                        .count(),
                    1
                );
                for method in [
                    "initialize",
                    "session/new",
                    "session/prompt",
                    "session/cancel",
                ] {
                    assert_eq!(
                        calls
                            .iter()
                            .filter(|frame| frame["method"].as_str() == Some(method))
                            .count(),
                        1,
                        "{method}"
                    );
                }
                second.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }
    #[tokio::test]
    async fn native_completion_while_detached_replays_to_idle_without_resending_input() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("context-gated").await;
                let first = harness.open().await;
                let reserved = first.reserve().await.unwrap();
                first
                    .test_prompt(reserved, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                first.retire().await;
                harness.environment.runner.disconnect().await;
                fs::write(harness.directory.path().join("finish"), b"finish").unwrap();
                tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        if harness
                            .calls()
                            .iter()
                            .any(|frame| frame.get("finished").is_some())
                        {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .unwrap();
                let mut events = harness.environment.events.subscribe();
                let second = harness.open().await;
                let mut latest = None;
                while let Ok(event) = events.try_recv() {
                    if let AntigravityRuntimeEvent::Session(event) = event
                        && let SessionEventKind::ContextReported { context } = event.kind
                    {
                        latest = Some(context);
                    }
                }
                assert_eq!(
                    latest,
                    Some(ContextUsage {
                        used_tokens: 2400,
                        window_tokens: 64000
                    })
                );
                assert!(!second.has_live_view().await);
                assert_eq!(second.observation().await.operation, InputOperation::Idle);
                assert!(second.state.lock().await.checkpoint.input.rpc().is_none());
                assert_eq!(
                    harness
                        .calls()
                        .iter()
                        .filter(|frame| frame["method"] == "session/prompt")
                        .count(),
                    1
                );
                second.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }
    #[tokio::test]
    async fn stop_reserved_before_enqueue_waits_and_does_not_finish_without_the_native_result() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("pending").await;
                let session = harness.open().await;
                let reserved = session.reserve().await.unwrap();
                session.interrupt().await.unwrap();
                assert_eq!(
                    session.observation().await.operation,
                    InputOperation::Stopping
                );
                assert!(
                    !harness
                        .calls()
                        .iter()
                        .any(|frame| frame["method"] == "session/cancel")
                );
                session
                    .test_prompt(reserved, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                finished(&session).await;
                let calls = harness.calls();
                let prompt = calls
                    .iter()
                    .position(|frame| frame["method"] == "session/prompt")
                    .unwrap();
                let cancel = calls
                    .iter()
                    .position(|frame| frame["method"] == "session/cancel")
                    .unwrap();
                assert!(prompt < cancel);
                session.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }
    #[tokio::test]
    async fn pending_permission_replays_under_its_original_rpc_and_child_identity() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("permission").await;
                let _record = harness.running_record();
                let mut events = harness.environment.events.subscribe();
                let first = harness.open().await;
                let reserved = first.reserve().await.unwrap();
                first
                    .test_prompt(reserved, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                let approval = tokio::time::timeout(Duration::from_secs(10), async {
                    loop {
                        if let AntigravityRuntimeEvent::Approval { request, .. } =
                            events.recv().await.unwrap()
                        {
                            break request;
                        }
                    }
                })
                .await
                .unwrap();
                assert!(approval.turn_id.as_deref().unwrap().starts_with("acp:"));
                let mut replayed = harness.environment.events.subscribe();
                let second = restored(&harness, &first).await;
                let mut continued = None;
                let mut shown = None;
                let mut asked = Vec::new();
                while let Ok(event) = replayed.try_recv() {
                    match event {
                        AntigravityRuntimeEvent::Session(event) => match event.kind {
                            SessionEventKind::TurnStarted { turn } => continued = Some(turn.id),
                            SessionEventKind::ItemChanged { turn_id, item, .. } => {
                                shown = Some((turn_id, item.id))
                            }
                            _ => {}
                        },
                        AntigravityRuntimeEvent::Approval { request, .. } => asked.push(request),
                        _ => {}
                    }
                }
                let continued = continued.expect("the waiting prompt continues in a new turn");
                assert!(
                    continued.starts_with("acp:") && Some(&continued) != approval.turn_id.as_ref()
                );
                let [again] = asked.as_slice() else {
                    panic!("the waiting question is published once: {asked:?}")
                };
                assert_eq!(again.id, approval.id);
                assert_eq!(again.turn_id.as_ref(), Some(&continued));
                assert_eq!(
                    shown,
                    Some((continued.clone(), again.item_id.clone().unwrap())),
                    "the asked tool call shows in the continued turn"
                );
                assert!(
                    again
                        .item_id
                        .as_deref()
                        .unwrap()
                        .ends_with(":tool:wire-control-only")
                );
                second
                    .resolve(&approval.id, ApprovalDecision::Allow)
                    .await
                    .unwrap();
                finished(&second).await;
                let calls = harness.calls();
                assert_eq!(
                    calls
                        .iter()
                        .filter(|frame| frame["id"] == 991
                            && frame["result"]["outcome"]["optionId"] == "allow")
                        .count(),
                    1
                );
                assert_eq!(
                    calls
                        .iter()
                        .filter(|frame| frame.get("pid").is_some())
                        .count(),
                    1
                );
                second.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn a_prompt_running_at_attachment_continues_in_its_own_turn_and_ends_the_frozen_one() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("gated").await;
                let (writer, record) = harness.running_record();
                let first = harness.open().await;
                let reserved = first.reserve().await.unwrap();
                first
                    .test_prompt(reserved, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                let opened = harness
                    .environment
                    .records
                    .read(FIXTURE_NATIVE, None, 8)
                    .unwrap()
                    .page;
                let frozen = opened.turns[0].clone();
                assert_eq!(frozen.status, TurnStatus::InProgress);
                let mut events = harness.environment.events.subscribe();
                let second = restored(&harness, &first).await;
                assert!(second.has_live_view().await);
                second.publish_opened(Some(opened)).await;
                let executor = &record.executors[0];
                writer
                    .execute(
                        "INSERT INTO executor_metadata VALUES(?1,?2)",
                        rusqlite::params![executor.idx, hex(&executor.data)],
                    )
                    .unwrap();
                let native = harness
                    .environment
                    .records
                    .read(FIXTURE_NATIVE, None, 8)
                    .unwrap();
                fs::write(harness.directory.path().join("finish"), b"finish").unwrap();
                finished(&second).await;

                let mut started = Vec::new();
                let mut replaced = Vec::new();
                let mut ended = Vec::new();
                let mut totals = Vec::new();
                while let Ok(event) = events.try_recv() {
                    let AntigravityRuntimeEvent::Session(event) = event else {
                        continue;
                    };
                    match event.kind {
                        SessionEventKind::TurnStarted { turn } => started.push(turn.id),
                        SessionEventKind::ConversationReplaced { turns_page } => replaced.push(
                            turns_page
                                .turns
                                .into_iter()
                                .map(|turn| turn.id)
                                .collect::<Vec<_>>(),
                        ),
                        SessionEventKind::TurnEnded { turn } => {
                            ended.push((turn.id, turn.status, turn.completed_at_ms))
                        }
                        SessionEventKind::UsageReported { turn_id, usage } => {
                            totals.push((turn_id, usage.total.total_tokens))
                        }
                        _ => {}
                    }
                }
                let [continued] = started.as_slice() else {
                    panic!("one continued turn starts: {started:?}")
                };
                assert!(continued.starts_with("acp:") && continued != &frozen.id);
                assert_eq!(
                    replaced,
                    [[continued.clone(), frozen.id.clone()]],
                    "the opened conversation is the view the prompt continues in"
                );
                let natively_ended = &native.page.turns[0];
                assert_ne!(natively_ended.status, TurnStatus::InProgress);
                assert_eq!(ended.len(), 2);
                assert_eq!(&ended[0].0, continued);
                assert_eq!(
                    ended[1],
                    (
                        frozen.id.clone(),
                        natively_ended.status,
                        natively_ended.completed_at_ms
                    )
                );
                assert_eq!(
                    totals,
                    [(continued.clone(), native.total_usage.total_tokens)]
                );
                let page = second.live_page(None, 8).await.unwrap().unwrap();
                assert_eq!(&page.turns[0].id, continued);
                assert_eq!(page.turns[1].id, frozen.id);
                assert_eq!(page.turns[1].status, natively_ended.status);
                assert_eq!(page.turns[1].items, frozen.items);
                second.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }

    #[tokio::test]
    async fn a_continued_turn_whose_record_is_gone_at_its_end_still_ends_and_guesses_nothing() {
        LocalSet::new()
            .run_until(async {
                let harness = Harness::start("gated").await;
                let (writer, _) = harness.running_record();
                let first = harness.open().await;
                let reserved = first.reserve().await.unwrap();
                first
                    .test_prompt(reserved, json!([{"type":"text","text":"fixture"}]))
                    .await
                    .unwrap();
                let mut events = harness.environment.events.subscribe();
                let second = restored(&harness, &first).await;
                drop(writer);
                for entry in fs::read_dir(harness.directory.path().join("records")).unwrap() {
                    fs::remove_file(entry.unwrap().path()).unwrap();
                }
                fs::write(harness.directory.path().join("finish"), b"finish").unwrap();
                finished(&second).await;

                let mut ended = Vec::new();
                let mut reported = false;
                while let Ok(event) = events.try_recv() {
                    if let AntigravityRuntimeEvent::Session(event) = event {
                        match event.kind {
                            SessionEventKind::TurnEnded { turn } => ended.push(turn.status),
                            SessionEventKind::UsageReported { .. } => reported = true,
                            _ => {}
                        }
                    }
                }
                assert_eq!(ended, [TurnStatus::Completed]);
                assert!(!reported, "an unread record leaves the total unknown");
                let page = second.live_page(None, 8).await.unwrap().unwrap();
                assert_eq!(page.turns[1].status, TurnStatus::InProgress);
                second.close().await.unwrap();
                harness.stop().await;
            })
            .await;
    }
}
