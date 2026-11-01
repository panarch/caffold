//! A bounded, opaque output journal for one child incarnation.
//!
//! The subscriber graph owns replay and live delivery. Child status is owned
//! by the supervisor; the checkpoint is owned by the driver and never parsed.

use std::collections::VecDeque;
use std::mem;
use std::sync::Arc;

use tokio::sync::{Mutex, Notify, mpsc, oneshot};
use tokio::task::AbortHandle;
use uuid::Uuid;

use super::{Outbound, SessionError};
use crate::protocol::{
    Checkpoint, Event, EventKind, MAX_CHECKPOINT_BYTES, MAX_JOURNAL_BYTES, RecoveryLimits,
    RecoverySnapshot, SessionInfo, WireEvent,
};

pub(super) struct Recovery {
    session: String,
    incarnation: String,
    limits: RecoveryLimits,
    state: Mutex<State>,
    changed: Notify,
}

struct State {
    node: Node,
    journal: VecDeque<Entry>,
    bytes: usize,
    produced: u64,
    acknowledged: u64,
    checkpoint: String,
}

enum Node {
    Detached,
    Replaying {
        subscriber: Subscriber,
        fence: u64,
        fence_offered: bool,
        fence_written: bool,
    },
    Live(Subscriber),
    Closed,
}

struct Subscriber {
    connection: u64,
    lease: String,
    lane: mpsc::Sender<Outbound>,
    task: Option<AbortHandle>,
    delivered: u64,
    in_flight: Option<u64>,
}

struct Entry {
    seq: u64,
    encoded: Arc<Vec<u8>>,
}

enum Delivery {
    Entry { seq: u64, encoded: Arc<Vec<u8>> },
    Fence(Arc<Vec<u8>>),
}

impl Recovery {
    pub(super) fn new(session: &str, limits: RecoveryLimits) -> Result<Arc<Self>, SessionError> {
        if !(1024..=MAX_JOURNAL_BYTES).contains(&limits.journal_bytes)
            || !(1..=MAX_CHECKPOINT_BYTES).contains(&limits.checkpoint_bytes)
        {
            return Err(SessionError::InvalidLimits);
        }
        Ok(Arc::new(Self {
            session: session.to_string(),
            incarnation: Uuid::new_v4().to_string(),
            limits,
            state: Mutex::new(State {
                node: Node::Detached,
                journal: VecDeque::new(),
                bytes: 0,
                produced: 0,
                acknowledged: 0,
                checkpoint: String::new(),
            }),
            changed: Notify::new(),
        }))
    }

    pub(super) fn incarnation(&self) -> &str {
        &self.incarnation
    }

    pub(super) async fn attached(&self) -> bool {
        self.state.lock().await.node.subscriber().is_some()
    }

    /// Freeze the replay extent. Delivery starts only after this snapshot's
    /// reply has been written, so no output can precede its checkpoint.
    pub(super) async fn attach(
        &self,
        connection: u64,
        lane: mpsc::Sender<Outbound>,
        expected: &str,
        mut info: SessionInfo,
    ) -> Result<RecoverySnapshot, SessionError> {
        if expected != self.incarnation {
            return Err(SessionError::WrongIncarnation);
        }
        let mut state = self.state.lock().await;
        match &state.node {
            Node::Closed => return Err(wrong_state("the recovery session is closed")),
            Node::Detached => {}
            node if node.subscriber().is_some_and(|held| !held.lane.is_closed()) => {
                return Err(SessionError::AlreadyAttached);
            }
            _ => state.detach(),
        }
        let lease = Uuid::new_v4().to_string();
        let fence = state.produced;
        let delivered = state.acknowledged;
        state.node = Node::Replaying {
            subscriber: Subscriber {
                connection,
                lease: lease.clone(),
                lane,
                task: None,
                delivered,
                in_flight: None,
            },
            fence,
            fence_offered: false,
            fence_written: false,
        };
        info.attached = true;
        Ok(RecoverySnapshot {
            session: info,
            incarnation: self.incarnation.clone(),
            lease,
            acknowledged: state.acknowledged,
            fence,
            checkpoint: state.checkpoint.clone(),
            limits: self.limits,
        })
    }

    pub(super) async fn start(self: &Arc<Self>, lease: &str) {
        let mut state = self.state.lock().await;
        let Some(held) = state.node.subscriber_mut() else {
            return;
        };
        if held.lease != lease || held.task.is_some() {
            return;
        }
        let owner = Arc::clone(self);
        let lease = lease.to_string();
        let task = tokio::spawn(async move { owner.deliver(lease).await });
        held.task = Some(task.abort_handle());
    }

    /// Accept the checkpoint and optional stdin frame without an intervening
    /// await. Capacity reservation makes a full stdin queue a definite refusal.
    pub(super) async fn commit(
        &self,
        connection: u64,
        checkpoint: Checkpoint,
        finish_replay: bool,
        mut input: Option<(Vec<u8>, &mpsc::Sender<Vec<u8>>)>,
    ) -> Result<(), SessionError> {
        if checkpoint.incarnation != self.incarnation {
            return Err(SessionError::WrongIncarnation);
        }
        if checkpoint.state.len() > self.limits.checkpoint_bytes {
            return Err(invalid("checkpoint exceeds its byte limit"));
        }
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut state = self.state.lock().await;
            let held = state
                .node
                .subscriber()
                .ok_or(SessionError::StaleSubscriber)?;
            if held.connection != connection || held.lease != checkpoint.lease {
                return Err(SessionError::StaleSubscriber);
            }
            if checkpoint.through < state.acknowledged {
                return Err(invalid("checkpoint regresses the acknowledged prefix"));
            }
            if checkpoint.through > held.delivered {
                // A fast reader can answer before the delivery task handles
                // the socket writer's completion. Wait only for that one
                // already offered frame, never for arbitrary future output.
                if held.in_flight == Some(checkpoint.through) {
                    drop(state);
                    notified.await;
                    continue;
                }
                return Err(invalid("checkpoint acknowledges output not delivered"));
            }
            if finish_replay {
                match &state.node {
                    Node::Replaying {
                        fence,
                        fence_written: true,
                        ..
                    } if checkpoint.through == *fence => {}
                    Node::Replaying {
                        fence,
                        fence_offered: true,
                        fence_written: false,
                        ..
                    } if checkpoint.through == *fence => {
                        drop(state);
                        notified.await;
                        continue;
                    }
                    _ => return Err(invalid("apply the exact replay fence before going live")),
                }
            }
            if input.is_some() && !matches!(state.node, Node::Live(_)) {
                return Err(wrong_state("finish replay before sending input"));
            }
            let permit = match input.as_ref() {
                Some((_, stdin)) => Some(stdin.try_reserve().map_err(|error| match error {
                    mpsc::error::TrySendError::Full(_) => SessionError::Backpressure,
                    mpsc::error::TrySendError::Closed(_) => SessionError::Exited,
                })?),
                None => None,
            };
            state.acknowledged = checkpoint.through;
            state.checkpoint = checkpoint.state;
            while state
                .journal
                .front()
                .is_some_and(|entry| entry.seq <= checkpoint.through)
            {
                let entry = state.journal.pop_front().expect("front checked");
                state.bytes -= entry.encoded.len();
            }
            if finish_replay {
                let Node::Replaying { subscriber, .. } =
                    mem::replace(&mut state.node, Node::Detached)
                else {
                    unreachable!("replay validated under this lock")
                };
                state.node = Node::Live(subscriber);
            }
            if let Some(permit) = permit {
                permit.send(input.take().expect("a reserved frame").0);
            }
            drop(state);
            self.changed.notify_waiters();
            return Ok(());
        }
    }

    pub(super) async fn append(&self, event: Event) -> Result<(), SessionError> {
        self.append_wire(event.into_wire()).await
    }

    pub(super) async fn failure(&self, message: String) {
        let event = self.control(EventKind::TransportError, Some(message), None);
        let _ = self.append_wire(event).await;
    }

    /// Stderr is diagnostic, not a second durable stream or credential log.
    pub(super) async fn diagnostic(&self, event: Event) {
        let lane = match &self.state.lock().await.node {
            Node::Live(held) => Some(held.lane.clone()),
            Node::Detached | Node::Replaying { .. } | Node::Closed => None,
        };
        if let Some(lane) = lane {
            let _ = lane.send(Outbound::Relay(event)).await;
        }
    }

    pub(super) async fn detach_lane(&self, lane: &mpsc::Sender<Outbound>) {
        let mut state = self.state.lock().await;
        if state
            .node
            .subscriber()
            .is_some_and(|held| held.lane.same_channel(lane))
        {
            state.detach();
            self.changed.notify_waiters();
        }
    }

    pub(super) async fn close(&self) {
        let mut state = self.state.lock().await;
        state.detach();
        state.node = Node::Closed;
        state.journal.clear();
        state.bytes = 0;
        state.checkpoint.clear();
        self.changed.notify_waiters();
    }

    async fn append_wire(&self, mut event: WireEvent) -> Result<(), SessionError> {
        // Only stdout and supervisor errors append; holding this lock is never
        // needed while awaiting buffer capacity. No frame is dropped on detach.
        let mut encoded = None;
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let mut state = self.state.lock().await;
            if matches!(state.node, Node::Closed) {
                return Err(wrong_state("the recovery session is closed"));
            }
            let next = state
                .produced
                .checked_add(1)
                .ok_or_else(|| wrong_state("output sequence exhausted"))?;
            // Another producer can append while this one waits for space, so
            // the sequence and envelope are assigned at the acceptance lock.
            if encoded
                .as_ref()
                .is_none_or(|(seq, _): &(u64, Arc<Vec<u8>>)| *seq != next)
            {
                event.seq = Some(next);
                event.incarnation = Some(self.incarnation.clone());
                let mut bytes =
                    serde_json::to_vec(&event).map_err(|error| wrong_state(&error.to_string()))?;
                bytes.push(b'\n');
                if bytes.len() > self.limits.journal_bytes {
                    return Err(wrong_state(
                        "encoded output frame exceeds the journal byte limit",
                    ));
                }
                encoded = Some((next, Arc::new(bytes)));
            }
            let (_, bytes) = encoded.as_ref().expect("encoded above");
            if state.bytes + bytes.len() <= self.limits.journal_bytes {
                let (seq, encoded) = encoded.take().expect("encoded above");
                state.bytes += encoded.len();
                state.produced = seq;
                state.journal.push_back(Entry { seq, encoded });
                drop(state);
                self.changed.notify_waiters();
                return Ok(());
            }
            drop(state);
            notified.await;
        }
    }

    async fn deliver(self: Arc<Self>, lease: String) {
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let delivery = {
                let mut state = self.state.lock().await;
                let Some(held) = state.node.subscriber() else {
                    return;
                };
                if held.lease != lease {
                    return;
                }
                let lane = held.lane.clone();
                let next = held.delivered.checked_add(1);
                let limit = match &state.node {
                    Node::Replaying { fence, .. } => *fence,
                    Node::Live(_) => state.produced,
                    _ => return,
                };
                let entry = next
                    .filter(|next| *next <= limit)
                    .and_then(|next| state.journal.iter().find(|entry| entry.seq == next))
                    .map(|entry| (entry.seq, Arc::clone(&entry.encoded)));
                if let Some((seq, encoded)) = entry {
                    state.node.subscriber_mut().expect("held").in_flight = Some(seq);
                    Some((lane, Delivery::Entry { seq, encoded }))
                } else if let Node::Replaying {
                    fence,
                    fence_offered,
                    ..
                } = &mut state.node
                {
                    if !*fence_offered {
                        let event = self.control(EventKind::ReplayFence, None, Some(*fence));
                        let mut bytes = serde_json::to_vec(&event).expect("transport envelope");
                        bytes.push(b'\n');
                        *fence_offered = true;
                        Some((lane, Delivery::Fence(Arc::new(bytes))))
                    } else {
                        None
                    }
                } else {
                    None
                }
            };
            let Some((lane, delivery)) = delivery else {
                notified.await;
                continue;
            };
            let encoded = match &delivery {
                Delivery::Entry { encoded, .. } | Delivery::Fence(encoded) => Arc::clone(encoded),
            };
            let (written, completion) = oneshot::channel();
            if lane
                .send(Outbound::Buffered { encoded, written })
                .await
                .is_err()
                || completion.await.is_err()
            {
                let mut state = self.state.lock().await;
                if state
                    .node
                    .subscriber()
                    .is_some_and(|held| held.lease == lease)
                {
                    state.detach();
                    self.changed.notify_waiters();
                }
                return;
            }
            let mut state = self.state.lock().await;
            if state
                .node
                .subscriber()
                .is_none_or(|held| held.lease != lease)
            {
                return;
            }
            match delivery {
                Delivery::Entry { seq, .. } => {
                    let held = state.node.subscriber_mut().expect("held");
                    held.delivered = seq;
                    held.in_flight = None;
                }
                Delivery::Fence(_) => {
                    if let Node::Replaying { fence_written, .. } = &mut state.node {
                        *fence_written = true;
                    }
                }
            }
            drop(state);
            self.changed.notify_waiters();
        }
    }

    fn control(&self, t: EventKind, line: Option<String>, seq: Option<u64>) -> WireEvent {
        WireEvent {
            t,
            s: self.session.clone(),
            frame: None,
            line,
            code: None,
            incarnation: Some(self.incarnation.clone()),
            seq,
        }
    }
}

impl State {
    fn detach(&mut self) {
        if let Some(held) = self.node.subscriber_mut()
            && let Some(task) = held.task.take()
        {
            task.abort();
        }
        if !matches!(self.node, Node::Closed) {
            self.node = Node::Detached;
        }
    }
}

impl Node {
    fn subscriber(&self) -> Option<&Subscriber> {
        match self {
            Self::Replaying { subscriber, .. } | Self::Live(subscriber) => Some(subscriber),
            Self::Detached | Self::Closed => None,
        }
    }

    fn subscriber_mut(&mut self) -> Option<&mut Subscriber> {
        match self {
            Self::Replaying { subscriber, .. } | Self::Live(subscriber) => Some(subscriber),
            Self::Detached | Self::Closed => None,
        }
    }
}

fn invalid(message: &str) -> SessionError {
    SessionError::InvalidCheckpoint(message.to_string())
}

fn wrong_state(message: &str) -> SessionError {
    SessionError::RecoveryState(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::SessionState;
    use serde_json::value::RawValue;
    use std::future::{Future, poll_fn};
    use std::task::Poll;

    fn info() -> SessionInfo {
        SessionInfo {
            session: "s".to_string(),
            state: SessionState::Running,
            pid: Some(123),
            attached: false,
            spawned: false,
            exit_code: None,
            incarnation: None,
        }
    }

    fn frame(text: &str) -> Event {
        Event::Frame {
            session: "s".to_string(),
            frame: RawValue::from_string(format!(
                "{{\"text\":{}}}",
                serde_json::to_string(text).unwrap()
            ))
            .unwrap(),
        }
    }

    fn checkpoint(snapshot: &RecoverySnapshot, through: u64, state: &str) -> Checkpoint {
        Checkpoint {
            incarnation: snapshot.incarnation.clone(),
            lease: snapshot.lease.clone(),
            through,
            state: state.to_string(),
        }
    }

    async fn read(lane: &mut mpsc::Receiver<Outbound>) -> WireEvent {
        let Outbound::Buffered { encoded, written } = lane.recv().await.expect("delivery") else {
            panic!("a journal entry")
        };
        let event = serde_json::from_slice(&encoded).expect("wire event");
        let _ = written.send(());
        event
    }

    #[tokio::test]
    async fn snapshot_replay_fence_and_live_form_one_explicit_graph() {
        let recovery = Recovery::new("s", RecoveryLimits::default()).unwrap();
        recovery.append(frame("before attach")).await.unwrap();
        let (tx, mut rx) = mpsc::channel(1);
        let snapshot = recovery
            .attach(1, tx.clone(), recovery.incarnation(), info())
            .await
            .unwrap();
        assert_eq!((snapshot.acknowledged, snapshot.fence), (0, 1));
        assert!(
            rx.try_recv().is_err(),
            "nothing precedes the snapshot reply"
        );
        assert!(matches!(
            recovery
                .commit(
                    1,
                    checkpoint(&snapshot, 0, "sending"),
                    false,
                    Some((b"{}\n".to_vec(), &mpsc::channel(1).0))
                )
                .await,
            Err(SessionError::RecoveryState(_))
        ));
        recovery.start(&snapshot.lease).await;
        assert_eq!(read(&mut rx).await.seq, Some(1));
        assert_eq!(read(&mut rx).await.t, EventKind::ReplayFence);
        recovery
            .commit(1, checkpoint(&snapshot, 1, "live"), true, None)
            .await
            .unwrap();
        assert!(matches!(recovery.state.lock().await.node, Node::Live(_)));
        recovery.append(frame("live output")).await.unwrap();
        assert_eq!(read(&mut rx).await.seq, Some(2));
        recovery
            .commit(1, checkpoint(&snapshot, 2, "applied"), false, None)
            .await
            .unwrap();
        recovery.detach_lane(&tx).await;
        assert!(!recovery.attached().await);
        let next = recovery
            .attach(2, tx, recovery.incarnation(), info())
            .await
            .unwrap();
        assert_eq!((next.acknowledged, next.fence), (2, 2));
        assert_eq!(next.checkpoint, "applied");
        recovery.close().await;
        assert!(matches!(recovery.state.lock().await.node, Node::Closed));
        assert!(
            recovery
                .attach(3, mpsc::channel(1).0, recovery.incarnation(), info())
                .await
                .is_err()
        );
        assert!(recovery.append(frame("late output")).await.is_err());
    }

    #[tokio::test]
    async fn connected_unacknowledged_output_and_interrupted_replay_are_retained() {
        let recovery = Recovery::new("s", RecoveryLimits::default()).unwrap();
        for text in ["one", "two", "three"] {
            recovery.append(frame(text)).await.unwrap();
        }
        let (first, mut first_rx) = mpsc::channel(1);
        let snapshot = recovery
            .attach(1, first.clone(), recovery.incarnation(), info())
            .await
            .unwrap();
        recovery.start(&snapshot.lease).await;
        assert_eq!(read(&mut first_rx).await.seq, Some(1));
        recovery
            .commit(1, checkpoint(&snapshot, 1, "prefix one"), false, None)
            .await
            .unwrap();
        assert_eq!(read(&mut first_rx).await.seq, Some(2));
        recovery.detach_lane(&first).await;

        let (second, mut second_rx) = mpsc::channel(1);
        let second_snapshot = recovery
            .attach(2, second.clone(), recovery.incarnation(), info())
            .await
            .unwrap();
        assert_eq!(second_snapshot.acknowledged, 1);
        assert_eq!(second_snapshot.checkpoint, "prefix one");
        recovery.start(&second_snapshot.lease).await;
        assert_eq!(read(&mut second_rx).await.seq, Some(2));
        recovery.detach_lane(&second).await;

        let (third, mut third_rx) = mpsc::channel(1);
        let third_snapshot = recovery
            .attach(3, third, recovery.incarnation(), info())
            .await
            .unwrap();
        assert_ne!(snapshot.lease, third_snapshot.lease);
        recovery.start(&third_snapshot.lease).await;
        assert_eq!(read(&mut third_rx).await.seq, Some(2));
        assert_eq!(read(&mut third_rx).await.seq, Some(3));
        assert_eq!(read(&mut third_rx).await.t, EventKind::ReplayFence);
        recovery
            .commit(3, checkpoint(&third_snapshot, 3, "restored"), true, None)
            .await
            .unwrap();
        // Old cleanup is fenced just like old acknowledgements.
        recovery.detach_lane(&first).await;
        assert!(recovery.attached().await);
        assert!(matches!(
            recovery
                .commit(1, checkpoint(&snapshot, 1, "stale"), false, None)
                .await,
            Err(SessionError::StaleSubscriber)
        ));
    }

    #[tokio::test]
    async fn foreign_future_regressing_and_oversized_checkpoints_leave_state_unchanged() {
        let recovery = Recovery::new(
            "s",
            RecoveryLimits {
                journal_bytes: 1024,
                checkpoint_bytes: 8,
            },
        )
        .unwrap();
        let (tx, mut rx) = mpsc::channel(1);
        assert!(matches!(
            recovery
                .attach(1, tx.clone(), "another child", info())
                .await,
            Err(SessionError::WrongIncarnation)
        ));
        let snapshot = recovery
            .attach(1, tx, recovery.incarnation(), info())
            .await
            .unwrap();
        recovery
            .append(frame("later than the fence"))
            .await
            .unwrap();
        assert!(matches!(
            recovery
                .commit(1, checkpoint(&snapshot, 1, "future"), false, None)
                .await,
            Err(SessionError::InvalidCheckpoint(_))
        ));
        let mut foreign = checkpoint(&snapshot, 0, "foreign");
        foreign.incarnation = "another".to_string();
        assert!(matches!(
            recovery.commit(1, foreign, false, None).await,
            Err(SessionError::WrongIncarnation)
        ));
        assert!(matches!(
            recovery
                .commit(2, checkpoint(&snapshot, 0, "foreign"), false, None)
                .await,
            Err(SessionError::StaleSubscriber)
        ));
        assert!(matches!(
            recovery
                .commit(1, checkpoint(&snapshot, 0, "too large"), false, None)
                .await,
            Err(SessionError::InvalidCheckpoint(_))
        ));
        assert_eq!(recovery.state.lock().await.checkpoint, "");
        recovery.start(&snapshot.lease).await;
        assert_eq!(read(&mut rx).await.t, EventKind::ReplayFence);
        recovery
            .commit(1, checkpoint(&snapshot, 0, "ready"), true, None)
            .await
            .unwrap();
        assert_eq!(read(&mut rx).await.seq, Some(1));
        recovery
            .commit(1, checkpoint(&snapshot, 1, "once"), false, None)
            .await
            .unwrap();
        // Equal prefixes are required for new stdin/checkpoint state; they
        // never release output twice. A regressing prefix is refused.
        recovery
            .commit(1, checkpoint(&snapshot, 1, "twice"), false, None)
            .await
            .unwrap();
        assert!(matches!(
            recovery
                .commit(1, checkpoint(&snapshot, 0, "older"), false, None)
                .await,
            Err(SessionError::InvalidCheckpoint(_))
        ));
        let state = recovery.state.lock().await;
        assert_eq!(
            (state.acknowledged, state.bytes, state.journal.len()),
            (1, 0, 0)
        );
        assert_eq!(state.checkpoint, "twice");
    }

    #[tokio::test]
    async fn capacity_stalls_the_producer_and_acknowledgement_releases_it() {
        let recovery = Recovery::new(
            "s",
            RecoveryLimits {
                journal_bytes: 1024,
                checkpoint_bytes: 64,
            },
        )
        .unwrap();
        recovery.append(frame(&"a".repeat(500))).await.unwrap();
        let pending = recovery.append(frame(&"b".repeat(500)));
        tokio::pin!(pending);
        assert!(
            poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        assert_eq!(recovery.state.lock().await.produced, 1);
        let (tx, mut rx) = mpsc::channel(1);
        let snapshot = recovery
            .attach(1, tx, recovery.incarnation(), info())
            .await
            .unwrap();
        recovery.start(&snapshot.lease).await;
        assert_eq!(read(&mut rx).await.seq, Some(1));
        recovery
            .commit(1, checkpoint(&snapshot, 1, "free prefix"), false, None)
            .await
            .unwrap();
        pending.await.unwrap();
        assert_eq!(recovery.state.lock().await.produced, 2);
        assert!(recovery.state.lock().await.bytes <= 1024);
        assert!(matches!(
            recovery.append(frame(&"x".repeat(1024))).await,
            Err(SessionError::RecoveryState(_))
        ));
        recovery.close().await;
    }

    #[tokio::test]
    async fn stdin_capacity_and_checkpoint_are_accepted_together() {
        let recovery = Recovery::new("s", RecoveryLimits::default()).unwrap();
        let (lane, mut events) = mpsc::channel(1);
        let snapshot = recovery
            .attach(1, lane, recovery.incarnation(), info())
            .await
            .unwrap();
        recovery.start(&snapshot.lease).await;
        assert_eq!(read(&mut events).await.t, EventKind::ReplayFence);
        recovery
            .commit(1, checkpoint(&snapshot, 0, "idle"), true, None)
            .await
            .unwrap();
        let (stdin, mut input) = mpsc::channel(1);
        stdin.try_send(b"occupied\n".to_vec()).unwrap();
        assert!(matches!(
            recovery
                .commit(
                    1,
                    checkpoint(&snapshot, 0, "pending"),
                    false,
                    Some((b"prompt\n".to_vec(), &stdin))
                )
                .await,
            Err(SessionError::Backpressure)
        ));
        assert_eq!(recovery.state.lock().await.checkpoint, "idle");
        assert_eq!(input.recv().await.unwrap(), b"occupied\n");
        recovery
            .commit(
                1,
                checkpoint(&snapshot, 0, "pending"),
                false,
                Some((b"prompt\n".to_vec(), &stdin)),
            )
            .await
            .unwrap();
        assert_eq!(input.recv().await.unwrap(), b"prompt\n");
        assert_eq!(recovery.state.lock().await.checkpoint, "pending");
        drop(input);
        assert!(matches!(
            recovery
                .commit(
                    1,
                    checkpoint(&snapshot, 0, "unaccepted"),
                    false,
                    Some((b"second\n".to_vec(), &stdin))
                )
                .await,
            Err(SessionError::Exited)
        ));
        assert_eq!(recovery.state.lock().await.checkpoint, "pending");
    }

    #[test]
    fn limits_cannot_expand_the_runner_memory_contract() {
        for limits in [
            RecoveryLimits {
                journal_bytes: 0,
                checkpoint_bytes: 1,
            },
            RecoveryLimits {
                journal_bytes: MAX_JOURNAL_BYTES + 1,
                checkpoint_bytes: 1,
            },
            RecoveryLimits {
                journal_bytes: 1024,
                checkpoint_bytes: 0,
            },
            RecoveryLimits {
                journal_bytes: 1024,
                checkpoint_bytes: MAX_CHECKPOINT_BYTES + 1,
            },
        ] {
            assert!(matches!(
                Recovery::new("s", limits),
                Err(SessionError::InvalidLimits)
            ));
        }
    }

    #[tokio::test]
    async fn a_second_attach_and_a_wrong_fence_cannot_change_the_subscriber() {
        let recovery = Recovery::new("s", RecoveryLimits::default()).unwrap();
        let (first, mut first_rx) = mpsc::channel(1);
        let snapshot = recovery
            .attach(1, first.clone(), recovery.incarnation(), info())
            .await
            .unwrap();
        assert!(matches!(
            recovery
                .attach(2, mpsc::channel(1).0, recovery.incarnation(), info())
                .await,
            Err(SessionError::AlreadyAttached)
        ));
        assert!(matches!(
            recovery
                .commit(1, checkpoint(&snapshot, 0, "too early"), true, None)
                .await,
            Err(SessionError::InvalidCheckpoint(_))
        ));
        recovery.start("stale start").await;
        assert!(first_rx.try_recv().is_err());
        recovery.start(&snapshot.lease).await;
        recovery.start(&snapshot.lease).await;
        assert_eq!(read(&mut first_rx).await.t, EventKind::ReplayFence);
        recovery
            .commit(1, checkpoint(&snapshot, 0, "live"), true, None)
            .await
            .unwrap();
        assert!(matches!(
            recovery
                .commit(1, checkpoint(&snapshot, 0, "second transition"), true, None)
                .await,
            Err(SessionError::InvalidCheckpoint(_))
        ));
        recovery.detach_lane(&first).await;
        recovery.start(&snapshot.lease).await;
        assert!(!recovery.attached().await);
    }

    #[tokio::test]
    async fn diagnostics_do_not_precede_the_snapshot_and_stay_outside_the_journal() {
        let recovery = Recovery::new("s", RecoveryLimits::default()).unwrap();
        let (lane, mut rx) = mpsc::channel(1);
        let snapshot = recovery
            .attach(1, lane, recovery.incarnation(), info())
            .await
            .unwrap();
        recovery
            .diagnostic(Event::Stderr {
                session: "s".to_string(),
                line: "not yet live".to_string(),
            })
            .await;
        assert!(rx.try_recv().is_err());
        recovery.start(&snapshot.lease).await;
        assert_eq!(read(&mut rx).await.t, EventKind::ReplayFence);
        recovery
            .commit(1, checkpoint(&snapshot, 0, "live"), true, None)
            .await
            .unwrap();
        recovery
            .diagnostic(Event::Stderr {
                session: "s".to_string(),
                line: "diagnostic".to_string(),
            })
            .await;
        let Outbound::Relay(Event::Stderr { line, .. }) = rx.recv().await.unwrap() else {
            panic!("a nonjournaled diagnostic")
        };
        assert_eq!(line, "diagnostic");
        let state = recovery.state.lock().await;
        assert_eq!((state.produced, state.journal.len()), (0, 0));
    }

    #[tokio::test]
    async fn a_closed_delivery_lane_can_be_replaced_and_close_releases_a_blocked_producer() {
        let recovery = Recovery::new(
            "s",
            RecoveryLimits {
                journal_bytes: 1024,
                checkpoint_bytes: 64,
            },
        )
        .unwrap();
        let (first, rx) = mpsc::channel(1);
        let snapshot = recovery
            .attach(1, first, recovery.incarnation(), info())
            .await
            .unwrap();
        drop(rx);
        let (second, mut rx) = mpsc::channel(1);
        let replacement = recovery
            .attach(2, second, recovery.incarnation(), info())
            .await
            .unwrap();
        assert_ne!(replacement.lease, snapshot.lease);
        recovery.append(frame(&"a".repeat(500))).await.unwrap();
        let pending = recovery.append(frame(&"b".repeat(500)));
        tokio::pin!(pending);
        assert!(
            poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        recovery.start(&replacement.lease).await;
        assert_eq!(read(&mut rx).await.t, EventKind::ReplayFence);
        // Closing is the accepted loss boundary, even with unacknowledged
        // bytes and a stdout producer waiting for capacity.
        recovery.close().await;
        assert!(matches!(pending.await, Err(SessionError::RecoveryState(_))));
        assert_eq!(recovery.state.lock().await.bytes, 0);
    }

    #[tokio::test]
    async fn a_failed_socket_delivery_detaches_without_acknowledging_the_frame() {
        let recovery = Recovery::new("s", RecoveryLimits::default()).unwrap();
        recovery.append(frame("unwritten")).await.unwrap();
        let (lane, mut events) = mpsc::channel(1);
        let snapshot = recovery
            .attach(1, lane, recovery.incarnation(), info())
            .await
            .unwrap();
        recovery.start(&snapshot.lease).await;
        let Outbound::Buffered { written, .. } = events.recv().await.unwrap() else {
            panic!("journal delivery")
        };
        // The socket writer failed and dropped its completion sender.
        drop(written);
        loop {
            let notified = recovery.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if matches!(recovery.state.lock().await.node, Node::Detached) {
                break;
            }
            notified.await;
        }
        let state = recovery.state.lock().await;
        assert_eq!((state.acknowledged, state.journal.len()), (0, 1));
    }
}
