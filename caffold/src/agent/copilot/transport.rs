//! One observer lease on the Task adapter. Only a completed replay can accept a command.

use super::{
    CopilotRuntimeEvent,
    binding::Binding,
    permission,
    protocol::{Operation, Output, Request, VERSION},
    record::{Record, context},
};
use crate::agent::{
    AgentError, ApprovalOutcome, ApprovalRequest, SessionEvent, SessionEventKind,
    runner::{RecoveryEvent, RecoveryFrames, RecoveryOutput, RecoverySession},
};
use serde_json::{Value, value::to_raw_value};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, broadcast, oneshot, watch};

type Reply = Result<Value, AgentError>;
type Waiting = HashMap<String, oneshot::Sender<Reply>>;

pub(super) struct Connection {
    retired: AtomicBool,
    snapshot_revision: AtomicU64,
    restoring: Mutex<()>,
    task: String,
    incarnation: String,
    fence: u64,
    frames: RecoveryFrames,
    through: Mutex<u64>,
    waiting: Mutex<Waiting>,
    ready: watch::Sender<Result<bool, AgentError>>,
    pub record: Mutex<Record>,
    events: broadcast::Sender<CopilotRuntimeEvent>,
}

impl Connection {
    pub fn attach(
        session: RecoverySession,
        binding: &Binding,
        record: Record,
        events: broadcast::Sender<CopilotRuntimeEvent>,
    ) -> Arc<Self> {
        let (ready, _) = watch::channel(Ok(false));
        let this = Arc::new(Self {
            retired: AtomicBool::new(false),
            snapshot_revision: AtomicU64::new(0),
            restoring: Mutex::new(()),
            task: binding.task_id.clone(),
            incarnation: session.snapshot.incarnation,
            fence: session.snapshot.fence,
            frames: session.frames,
            through: Mutex::new(session.snapshot.acknowledged),
            waiting: Default::default(),
            ready,
            record: Mutex::new(record),
            events,
        });

        let reading = this.clone();
        tokio::spawn(async move {
            let mut stream = session.events;
            let error = loop {
                match stream.next().await {
                    Some(RecoveryEvent::Output {
                        incarnation,
                        seq,
                        body,
                    }) => {
                        if let Err(error) = reading.output(&incarnation, seq, body).await {
                            break error;
                        }
                    }
                    Some(RecoveryEvent::ProtocolFailure(error)) => break AgentError::Failed(error),
                    None => {
                        break AgentError::Unreachable(
                            "Connection to the Copilot runner closed.".into(),
                        );
                    }
                }
            };

            let _ = reading.ready.send_replace(Err(error.clone()));
            for (_, answer) in reading.waiting.lock().await.drain() {
                let _ = answer.send(Err(error.clone()));
            }

            if reading.retired.load(Ordering::Acquire) {
                return;
            }
            let _ = reading.events.send(CopilotRuntimeEvent::Unreachable {
                conversation_id: reading.task.clone(),
                message: error.to_string(),
            });
        });
        this
    }

    pub fn retire(&self) {
        self.retired.store(true, Ordering::Release);
    }

    pub fn lost(&self) -> bool {
        self.ready.borrow().is_err()
    }

    pub async fn request(&self, operation: Operation) -> Reply {
        let mut ready = self.ready.subscribe();
        tokio::time::timeout(
            Duration::from_secs(60),
            ready.wait_for(|state| !matches!(state, Ok(false))),
        )
        .await
        .map_err(|_| AgentError::TimedOut("Copilot runner replay timed out.".into()))?
        .map_err(|error| AgentError::Unreachable(error.to_string()))?
        .clone()?;

        let id = uuid::Uuid::new_v4().to_string();
        let frame = to_raw_value(&Request {
            version: VERSION,
            id: id.clone(),
            operation,
        })
        .map_err(|error| AgentError::Failed(error.to_string()))?;

        let (reply_sender, reply) = oneshot::channel();
        self.waiting.lock().await.insert(id.clone(), reply_sender);
        let result = async {
            {
                let through = self.through.lock().await;
                self.frames
                    .send(*through, VERSION.to_string(), frame)
                    .await
                    .map_err(runner_error)?;
            }

            tokio::time::timeout(Duration::from_secs(90), reply)
                .await
                .map_err(|_| {
                    AgentError::TimedOut(
                        "Copilot did not return a receipt. Reopen the Task to check its state."
                            .into(),
                    )
                })?
                .map_err(|_| {
                    AgentError::Unreachable("Copilot adapter disconnected before replying.".into())
                })?
        }
        .await;

        self.waiting.lock().await.remove(&id);
        result
    }

    async fn output(
        &self,
        incarnation: &str,
        seq: u64,
        body: RecoveryOutput,
    ) -> Result<(), AgentError> {
        let mut through = self.through.lock().await;
        let fence = matches!(body, RecoveryOutput::Fence);
        let valid_sequence = if fence {
            seq == self.fence && seq == *through
        } else {
            through.checked_add(1) == Some(seq)
        };
        if incarnation != self.incarnation || !valid_sequence {
            return Err(AgentError::Failed(
                "Non-contiguous Copilot runner journal.".into(),
            ));
        }

        let mut reply = None;
        let mut lost = None;
        match body {
            RecoveryOutput::Frame(line) => match serde_json::from_str::<Output>(&line)
                .map_err(|error| AgentError::Failed(error.to_string()))?
            {
                Output::Event { event } => self.observe(&event).await?,
                Output::Reply { id, result } => {
                    reply = Some((id, result.map_err(AgentError::from)))
                }
                Output::Usage { turn, usage } => {
                    let record = self.record.lock().await;
                    self.publish(SessionEventKind::UsageReported {
                        turn_id: turn,
                        usage: usage.normalized(record.context.map(|c| c.window_tokens)),
                    });
                }
                Output::Background { active } => {
                    let mut record = self.record.lock().await;
                    if record.conversation.background_work != active {
                        record.conversation.background_work = active;
                        self.publish(SessionEventKind::BackgroundWorkChanged {
                            background_work: active,
                        });
                    }
                }
                Output::ObservationLost { message } => {
                    lost = Some(message);
                }
            },
            RecoveryOutput::Exit(code) => {
                return Err(AgentError::Unreachable(format!(
                    "Copilot adapter exited ({code:?})."
                )));
            }
            RecoveryOutput::TransportError(message) => {
                return Err(AgentError::Unreachable(message));
            }
            RecoveryOutput::Fence => {}
        }

        if fence {
            self.frames
                .finish_replay(seq, VERSION.to_string())
                .await
                .map_err(runner_error)?;
            let _ = self.ready.send_replace(Ok(true));
        } else {
            self.frames
                .checkpoint(seq, VERSION.to_string())
                .await
                .map_err(runner_error)?;
        }
        *through = seq;

        if let Some(message) = lost {
            return Err(AgentError::Unreachable(message));
        }
        if let Some((id, result)) = reply
            && let Some(waiting) = self.waiting.lock().await.remove(&id)
        {
            let _ = waiting.send(result);
        }
        Ok(())
    }

    async fn observe(&self, event: &copilot_sdk::SessionEvent) -> Result<(), AgentError> {
        let mut record = self.record.lock().await;
        let changes = record.apply(event);
        for kind in changes {
            self.publish(kind);
        }

        match event.event_type.as_str() {
            "user.message" | "abort" | "session.error" | "session.idle" | "session.shutdown"
                if event.agent_id.is_none() =>
            {
                self.snapshot_revision.fetch_add(1, Ordering::Relaxed);
            }
            "permission.requested" => {
                let data = &event.data;
                if let (Some(id), Some(request)) = (
                    data["requestId"].as_str(),
                    data.get("promptRequest")
                        .filter(|v| !v.is_null())
                        .or_else(|| data.get("permissionRequest")),
                ) {
                    self.snapshot_revision.fetch_add(1, Ordering::Relaxed);
                    let request = self.approval(&record, id, request)?;
                    let _ = self.events.send(CopilotRuntimeEvent::Approval {
                        conversation_id: self.task.clone(),
                        request: Box::new(request),
                    });
                }
            }
            "permission.completed" => {
                if let Some(id) = event.data["requestId"].as_str() {
                    self.snapshot_revision.fetch_add(1, Ordering::Relaxed);
                    let outcome = if event.data.pointer("/result/kind").and_then(Value::as_str)
                        == Some("cancelled")
                    {
                        ApprovalOutcome::Expired
                    } else {
                        ApprovalOutcome::AnsweredElsewhere
                    };
                    let _ = self.events.send(CopilotRuntimeEvent::ApprovalEnded {
                        conversation_id: self.task.clone(),
                        approval_id: format!("copilot:{}:{id}", self.task),
                        outcome,
                    });
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn approval(
        &self,
        record: &Record,
        id: &str,
        request: &Value,
    ) -> Result<ApprovalRequest, AgentError> {
        Ok(permission::card(
            &self.task,
            id,
            request,
            record.active_turn().map(|t| t.id.clone()),
            &record.conversation.cwd,
        )?)
    }

    /// If activity or permissions changed during a snapshot read, repeat Inspect.
    /// Open can create a session, so it must only run once.
    pub async fn restore(&self, mut operation: Operation) -> Result<(), AgentError> {
        let _restoring = self.restoring.lock().await;
        loop {
            let revision = self.snapshot_revision.load(Ordering::Relaxed);
            let snapshot = self.request(operation).await?;
            let mut record = self.record.lock().await;
            if self.retired.load(Ordering::Acquire) || self.lost() {
                return Err(AgentError::Unreachable(
                    "Copilot disconnected while reading the session.".into(),
                ));
            }
            if self.snapshot_revision.load(Ordering::Relaxed) == revision {
                return self.restore_snapshot(&mut record, &snapshot);
            }
            operation = Operation::Inspect;
        }
    }

    fn restore_snapshot(&self, record: &mut Record, snapshot: &Value) -> Result<(), AgentError> {
        if let Some(cwd) = snapshot
            .pointer("/metadata/workingDirectory")
            .and_then(Value::as_str)
        {
            record.conversation.cwd = cwd.into();
        }
        if let Some(event) = record.restore_activity(snapshot) {
            self.publish(event);
        }

        if let Some(context) = context(&snapshot["context"]) {
            record.context = Some(context);
            self.publish(SessionEventKind::ContextReported { context });
        }
        record.conversation.background_work = snapshot["background"].as_bool().unwrap_or(false);

        let usage = snapshot["usageTurn"]
            .as_str()
            .and_then(|turn| {
                serde_json::from_value::<super::usage::Usage>(snapshot["usage"].clone())
                    .ok()
                    .map(|usage| (turn.to_owned(), usage))
            })
            .or_else(|| record.recorded_usage.clone());
        if let Some((turn_id, usage)) = usage {
            self.publish(SessionEventKind::UsageReported {
                turn_id,
                usage: usage.normalized(record.context.map(|c| c.window_tokens)),
            });
        }

        let requests = permission::pending_permissions(snapshot)?
            .into_iter()
            .map(|(id, request)| self.approval(record, id, request))
            .collect::<Result<Vec<_>, _>>()?;
        let _ = self.events.send(CopilotRuntimeEvent::PendingApprovals {
            conversation_id: self.task.clone(),
            requests,
        });
        Ok(())
    }

    /// An input removed from the native queue must also leave its optimistic turn.
    pub async fn publish_history(&self) -> Result<(), AgentError> {
        let record = self.record.lock().await;
        self.publish(SessionEventKind::ConversationReplaced {
            turns_page: record.page(None, 8)?,
        });
        if let Some(context) = record.context {
            self.publish(SessionEventKind::ContextReported { context });
        }
        Ok(())
    }

    fn publish(&self, kind: SessionEventKind) {
        let _ = self
            .events
            .send(CopilotRuntimeEvent::Session(Box::new(SessionEvent {
                thread_id: self.task.clone(),
                kind,
            })));
    }
}

pub(super) fn runner_error(error: crate::agent::runner::RunnerError) -> AgentError {
    AgentError::Unreachable(error.to_string())
}
