use tokio::sync::broadcast;

/// The revisioned Task Detail publications every live viewer of a Task hears.
#[derive(Clone)]
pub(in crate::app::tasks) struct TaskSync<T>
where
    T: Clone,
{
    updates: broadcast::Sender<T>,
}

impl<T> TaskSync<T>
where
    T: Clone,
{
    pub(in crate::app::tasks) fn new() -> Self {
        let (updates, _) = broadcast::channel(64);
        Self { updates }
    }

    pub(in crate::app::tasks) fn subscribe_updates(&self) -> broadcast::Receiver<T> {
        self.updates.subscribe()
    }

    pub(in crate::app::tasks) fn publish(&self, update: T) {
        let _ = self.updates.send(update);
    }
}
