use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc, oneshot};

use crate::task_rollout::{TaskRolloutMonitor, TaskRolloutSignal, TaskRolloutSubscription};

const TASK_SYNC_DEBOUNCE: Duration = Duration::from_millis(600);
const TASK_SYNC_MAX_LATENCY: Duration = Duration::from_secs(2);
const TASK_SYNC_RETRY_BASE: Duration = Duration::from_secs(2);
const TASK_SYNC_MAX_RETRIES: u8 = 3;

#[derive(Clone)]
pub(in crate::app) struct TaskSync<T>
where
    T: Clone,
{
    coordinator: TaskSyncCoordinator,
    updates: broadcast::Sender<T>,
    rollout_monitor: TaskRolloutMonitor,
    due: mpsc::UnboundedSender<TaskSyncJob>,
    due_receiver: Arc<AsyncMutex<Option<mpsc::UnboundedReceiver<TaskSyncJob>>>>,
    shutdown: broadcast::Sender<()>,
}

impl<T> TaskSync<T>
where
    T: Clone + Send + 'static,
{
    pub(in crate::app) fn new(shutdown: broadcast::Sender<()>) -> Self {
        let coordinator = TaskSyncCoordinator::new();
        let rollout_coordinator = coordinator.clone();
        let rollout_monitor = TaskRolloutMonitor::new(move |thread_id, signal| {
            rollout_coordinator.observe_rollout_signal(thread_id, signal);
        });
        let (updates, _) = broadcast::channel(64);
        let (due, due_receiver) = mpsc::unbounded_channel();
        Self {
            coordinator,
            updates,
            rollout_monitor,
            due,
            due_receiver: Arc::new(AsyncMutex::new(Some(due_receiver))),
            shutdown,
        }
    }

    pub(in crate::app) fn subscribe(&self, thread_id: &str) -> TaskSyncSubscription {
        self.coordinator.subscribe(thread_id)
    }

    pub(in crate::app) fn subscribe_rollout(
        &self,
        thread_id: &str,
        rollout_path: Option<&str>,
    ) -> Option<TaskRolloutSubscription> {
        self.rollout_monitor.subscribe(thread_id, rollout_path)
    }

    pub(in crate::app) fn subscribe_updates(&self) -> broadcast::Receiver<T> {
        self.updates.subscribe()
    }

    pub(in crate::app) fn publish(&self, update: T) {
        let _ = self.updates.send(update);
    }

    pub(in crate::app) async fn take_jobs(&self) -> Option<mpsc::UnboundedReceiver<TaskSyncJob>> {
        let requests = self.coordinator.take_receiver().await?;
        let jobs = self.due_receiver.lock().await.take()?;
        let coordinator = self.coordinator.clone();
        let due = self.due.clone();
        let mut shutdown = self.shutdown.subscribe();
        tokio::spawn(async move {
            run_scheduler(coordinator, requests, due, &mut shutdown).await;
        });
        Some(jobs)
    }

    #[cfg(test)]
    pub(in crate::app) fn observe_rollout_invalidation(&self, thread_id: String) {
        self.coordinator
            .observe_rollout_signal(thread_id, TaskRolloutSignal::Invalidated);
    }
}

#[derive(Clone, Default)]
pub(in crate::app) struct DeferredTaskRolloutSubscription {
    inner: Arc<Mutex<Option<TaskRolloutSubscription>>>,
}

impl DeferredTaskRolloutSubscription {
    pub(in crate::app) fn install_with(
        &self,
        create: impl FnOnce() -> Option<TaskRolloutSubscription>,
    ) {
        let Ok(mut subscription) = self.inner.lock() else {
            return;
        };
        if subscription.is_none() {
            *subscription = create();
        }
    }
}

pub(in crate::app) struct TaskSyncJob {
    pub(in crate::app) thread_id: String,
    pub(in crate::app) invalidation_revision: u64,
    completion: oneshot::Sender<TaskSyncOutcome>,
}

impl TaskSyncJob {
    pub(in crate::app) fn complete(self, outcome: TaskSyncOutcome) {
        let _ = self.completion.send(outcome);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::app) enum TaskSyncOutcome {
    Synchronized,
    Retry,
}

#[derive(Clone)]
struct TaskSyncCoordinator {
    subscribers: Arc<Mutex<HashMap<String, usize>>>,
    pending_invalidations: Arc<Mutex<HashMap<String, u64>>>,
    requests: mpsc::UnboundedSender<TaskSyncRequest>,
    receiver: Arc<AsyncMutex<Option<mpsc::UnboundedReceiver<TaskSyncRequest>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TaskSyncRequest {
    Rollout(String, TaskRolloutSignal),
    Unsubscribe(String),
}

#[derive(Clone, Copy)]
struct PendingTaskSync {
    first_invalidated_at: tokio::time::Instant,
    deadline: tokio::time::Instant,
    retry_attempt: u8,
}

impl PendingTaskSync {
    fn new(now: tokio::time::Instant) -> Self {
        Self {
            first_invalidated_at: now,
            deadline: now + TASK_SYNC_DEBOUNCE,
            retry_attempt: 0,
        }
    }

    fn retry(now: tokio::time::Instant, retry_attempt: u8) -> Self {
        let multiplier = 1_u32 << retry_attempt.saturating_sub(1);
        let delay = TASK_SYNC_RETRY_BASE.saturating_mul(multiplier);
        Self {
            first_invalidated_at: now,
            deadline: now + delay,
            retry_attempt,
        }
    }

    fn invalidate(&mut self, now: tokio::time::Instant) {
        self.retry_attempt = 0;
        self.deadline =
            (now + TASK_SYNC_DEBOUNCE).min(self.first_invalidated_at + TASK_SYNC_MAX_LATENCY);
    }

    fn deadline(self) -> tokio::time::Instant {
        self.deadline
    }
}

impl TaskSyncCoordinator {
    fn new() -> Self {
        let (requests, receiver) = mpsc::unbounded_channel();
        Self {
            subscribers: Arc::new(Mutex::new(HashMap::new())),
            pending_invalidations: Arc::new(Mutex::new(HashMap::new())),
            requests,
            receiver: Arc::new(AsyncMutex::new(Some(receiver))),
        }
    }

    fn subscribe(&self, thread_id: &str) -> TaskSyncSubscription {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            *subscribers.entry(thread_id.to_string()).or_default() += 1;
        }
        TaskSyncSubscription {
            coordinator: self.clone(),
            thread_id: thread_id.to_string(),
        }
    }

    fn observe_rollout_signal(&self, thread_id: String, signal: TaskRolloutSignal) {
        if !self.is_subscribed(&thread_id) {
            return;
        }
        if let Ok(mut pending) = self.pending_invalidations.lock() {
            let revision = pending.entry(thread_id.clone()).or_default();
            *revision = revision.saturating_add(1);
        }
        let _ = self
            .requests
            .send(TaskSyncRequest::Rollout(thread_id, signal));
    }

    fn pending_invalidation(&self, thread_id: &str) -> Option<u64> {
        self.pending_invalidations
            .lock()
            .ok()
            .and_then(|pending| pending.get(thread_id).copied())
    }

    fn mark_synchronized(&self, thread_id: &str, revision: u64) {
        let Ok(mut pending) = self.pending_invalidations.lock() else {
            return;
        };
        if pending.get(thread_id).copied() == Some(revision) {
            pending.remove(thread_id);
        }
    }

    fn is_subscribed(&self, thread_id: &str) -> bool {
        self.subscribers
            .lock()
            .ok()
            .and_then(|subscribers| subscribers.get(thread_id).copied())
            .is_some_and(|count| count > 0)
    }

    async fn take_receiver(&self) -> Option<mpsc::UnboundedReceiver<TaskSyncRequest>> {
        self.receiver.lock().await.take()
    }

    fn unsubscribe(&self, thread_id: &str) {
        let remove = {
            let Ok(mut subscribers) = self.subscribers.lock() else {
                return;
            };
            let Some(count) = subscribers.get_mut(thread_id) else {
                return;
            };
            *count -= 1;
            let remove = *count == 0;
            if remove {
                subscribers.remove(thread_id);
            }
            remove
        };
        if remove {
            if let Ok(mut pending) = self.pending_invalidations.lock() {
                pending.remove(thread_id);
            }
            let _ = self
                .requests
                .send(TaskSyncRequest::Unsubscribe(thread_id.to_string()));
        }
    }
}

pub(in crate::app) struct TaskSyncSubscription {
    coordinator: TaskSyncCoordinator,
    thread_id: String,
}

impl Drop for TaskSyncSubscription {
    fn drop(&mut self) {
        self.coordinator.unsubscribe(&self.thread_id);
    }
}

async fn run_scheduler(
    coordinator: TaskSyncCoordinator,
    mut requests: mpsc::UnboundedReceiver<TaskSyncRequest>,
    due: mpsc::UnboundedSender<TaskSyncJob>,
    shutdown: &mut broadcast::Receiver<()>,
) {
    let mut pending = HashMap::<String, PendingTaskSync>::new();

    loop {
        if pending.is_empty() {
            tokio::select! {
                _ = shutdown.recv() => return,
                request = requests.recv() => {
                    let Some(request) = request else { return; };
                    handle_request(&mut pending, request);
                }
            }
        } else {
            let deadline = pending
                .values()
                .map(|pending| pending.deadline())
                .min()
                .expect("non-empty task sync schedule");
            tokio::select! {
                _ = shutdown.recv() => return,
                request = requests.recv() => {
                    let Some(request) = request else { return; };
                    handle_request(&mut pending, request);
                }
                _ = tokio::time::sleep_until(deadline) => {}
            }
        }

        let now = tokio::time::Instant::now();
        let ready = pending
            .iter()
            .filter(|(_, pending)| pending.deadline() <= now)
            .map(|(thread_id, _)| thread_id.clone())
            .collect::<Vec<_>>();
        for thread_id in ready {
            let Some(scheduled) = pending.remove(&thread_id) else {
                continue;
            };
            if !coordinator.is_subscribed(&thread_id) {
                continue;
            }
            let Some(invalidation_revision) = coordinator.pending_invalidation(&thread_id) else {
                continue;
            };
            let (completion, completed) = oneshot::channel();
            if due
                .send(TaskSyncJob {
                    thread_id: thread_id.clone(),
                    invalidation_revision,
                    completion,
                })
                .is_err()
            {
                return;
            }
            match completed.await {
                Ok(TaskSyncOutcome::Synchronized) => {
                    coordinator.mark_synchronized(&thread_id, invalidation_revision);
                }
                Ok(TaskSyncOutcome::Retry) | Err(_) => {
                    schedule_retry(
                        &mut pending,
                        thread_id,
                        scheduled.retry_attempt,
                        tokio::time::Instant::now(),
                    );
                }
            }
        }
    }
}

fn handle_request(pending: &mut HashMap<String, PendingTaskSync>, request: TaskSyncRequest) {
    match request {
        TaskSyncRequest::Rollout(thread_id, TaskRolloutSignal::Invalidated) => {
            schedule(pending, thread_id, tokio::time::Instant::now());
        }
        TaskSyncRequest::Unsubscribe(thread_id) => {
            pending.remove(&thread_id);
        }
    }
}

fn schedule(
    pending: &mut HashMap<String, PendingTaskSync>,
    thread_id: String,
    now: tokio::time::Instant,
) {
    pending
        .entry(thread_id)
        .and_modify(|pending| pending.invalidate(now))
        .or_insert_with(|| PendingTaskSync::new(now));
}

fn schedule_retry(
    pending: &mut HashMap<String, PendingTaskSync>,
    thread_id: String,
    previous_attempt: u8,
    now: tokio::time::Instant,
) {
    let retry_attempt = previous_attempt.saturating_add(1);
    if retry_attempt > TASK_SYNC_MAX_RETRIES {
        return;
    }
    pending.insert(thread_id, PendingTaskSync::retry(now, retry_attempt));
}

#[cfg(test)]
pub(super) fn scheduled_deadline_for_test(
    started_at: tokio::time::Instant,
    invalidation_offsets: &[Duration],
) -> tokio::time::Instant {
    let mut pending = HashMap::new();
    schedule(&mut pending, "thread-1".to_string(), started_at);
    for offset in invalidation_offsets {
        schedule(&mut pending, "thread-1".to_string(), started_at + *offset);
    }
    pending["thread-1"].deadline()
}

#[cfg(test)]
pub(super) fn retry_schedule_for_test(
    previous_attempt: u8,
    started_at: tokio::time::Instant,
) -> Option<(u8, tokio::time::Instant)> {
    let mut pending = HashMap::new();
    schedule_retry(
        &mut pending,
        "thread-1".to_string(),
        previous_attempt,
        started_at,
    );
    pending
        .get("thread-1")
        .map(|pending| (pending.retry_attempt, pending.deadline()))
}

#[cfg(test)]
pub(super) const SYNC_MAX_LATENCY_FOR_TEST: Duration = TASK_SYNC_MAX_LATENCY;

#[cfg(test)]
pub(super) const SYNC_RETRY_BASE_FOR_TEST: Duration = TASK_SYNC_RETRY_BASE;
