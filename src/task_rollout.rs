use std::{
    collections::HashMap,
    fs::Metadata,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

type RolloutInvalidationCallback = dyn Fn(String) + Send + Sync;
const ROLLOUT_STAT_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RolloutFileStamp {
    len: u64,
    modified: Option<std::time::SystemTime>,
}

impl From<Metadata> for RolloutFileStamp {
    fn from(metadata: Metadata) -> Self {
        Self {
            len: metadata.len(),
            modified: metadata.modified().ok(),
        }
    }
}

#[derive(Default)]
struct RolloutWatchState {
    threads_by_path: HashMap<PathBuf, HashMap<String, usize>>,
    stamps_by_path: HashMap<PathBuf, Option<RolloutFileStamp>>,
    suppressed_threads: HashMap<String, usize>,
}

#[derive(Clone)]
pub(crate) struct TaskRolloutMonitor {
    state: Arc<Mutex<RolloutWatchState>>,
    #[cfg(test)]
    on_invalidate: Arc<RolloutInvalidationCallback>,
}

pub(crate) struct TaskRolloutSubscription {
    monitor: TaskRolloutMonitor,
    thread_id: String,
    path: PathBuf,
}

pub(crate) struct TaskRolloutSuppression {
    monitor: TaskRolloutMonitor,
    thread_id: String,
}

impl Drop for TaskRolloutSubscription {
    fn drop(&mut self) {
        self.monitor.unsubscribe(&self.thread_id, &self.path);
    }
}

impl Drop for TaskRolloutSuppression {
    fn drop(&mut self) {
        self.monitor.unsuppress(&self.thread_id);
    }
}

impl TaskRolloutMonitor {
    pub(crate) fn new(on_invalidate: impl Fn(String) + Send + Sync + 'static) -> Self {
        let state = Arc::new(Mutex::new(RolloutWatchState::default()));
        let on_invalidate: Arc<RolloutInvalidationCallback> = Arc::new(on_invalidate);
        let callback_state = Arc::downgrade(&state);
        let callback_on_invalidate = on_invalidate.clone();
        thread::Builder::new()
            .name("caffold-rollout-monitor".to_string())
            .spawn(move || {
                loop {
                    thread::sleep(ROLLOUT_STAT_INTERVAL);
                    let Some(state) = callback_state.upgrade() else {
                        return;
                    };
                    poll_changed_paths(&state, &callback_on_invalidate);
                }
            })
            .expect("start Codex rollout monitor");

        Self {
            state,
            #[cfg(test)]
            on_invalidate,
        }
    }

    pub(crate) fn subscribe(
        &self,
        thread_id: &str,
        rollout_path: Option<&str>,
    ) -> Option<TaskRolloutSubscription> {
        let path = normalize_path(Path::new(rollout_path?.trim()));
        if path.as_os_str().is_empty() {
            return None;
        }

        let mut state = self.state.lock().ok()?;
        let first_path_subscription = !state.threads_by_path.contains_key(&path);
        if first_path_subscription {
            state
                .stamps_by_path
                .insert(path.clone(), rollout_file_stamp(&path));
        }

        *state
            .threads_by_path
            .entry(path.clone())
            .or_default()
            .entry(thread_id.to_string())
            .or_default() += 1;

        Some(TaskRolloutSubscription {
            monitor: self.clone(),
            thread_id: thread_id.to_string(),
            path,
        })
    }

    pub(crate) fn suppress(&self, thread_id: &str) -> TaskRolloutSuppression {
        if let Ok(mut state) = self.state.lock() {
            *state
                .suppressed_threads
                .entry(thread_id.to_string())
                .or_default() += 1;
        }
        TaskRolloutSuppression {
            monitor: self.clone(),
            thread_id: thread_id.to_string(),
        }
    }

    fn unsuppress(&self, thread_id: &str) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let mut should_rebaseline = false;
        if let Some(count) = state.suppressed_threads.get_mut(thread_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.suppressed_threads.remove(thread_id);
                should_rebaseline = true;
            }
        }
        if !should_rebaseline {
            return;
        }

        let paths = state
            .threads_by_path
            .iter()
            .filter(|(_, threads)| threads.contains_key(thread_id))
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();
        for path in paths {
            state
                .stamps_by_path
                .insert(path.clone(), rollout_file_stamp(&path));
        }
    }

    fn unsubscribe(&self, thread_id: &str, path: &Path) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if let Some(threads) = state.threads_by_path.get_mut(path) {
            if let Some(count) = threads.get_mut(thread_id) {
                *count = count.saturating_sub(1);
                if *count == 0 {
                    threads.remove(thread_id);
                }
            }
            if threads.is_empty() {
                state.threads_by_path.remove(path);
                state.stamps_by_path.remove(path);
            }
        }
    }

    #[cfg(test)]
    fn invalidate_path(&self, path: &Path) {
        invalidate_changed_path(&self.state, &self.on_invalidate, path);
    }

    #[cfg(test)]
    fn subscription_count(&self, path: &Path, thread_id: &str) -> usize {
        let path = normalize_path(path);
        self.state
            .lock()
            .ok()
            .and_then(|state| state.threads_by_path.get(&path)?.get(thread_id).copied())
            .unwrap_or_default()
    }
}

#[cfg(test)]
fn invalidate_changed_path(
    state: &Mutex<RolloutWatchState>,
    on_invalidate: &Arc<RolloutInvalidationCallback>,
    path: &Path,
) {
    let path = normalize_path(path);
    let thread_ids = state
        .lock()
        .ok()
        .and_then(|state| {
            Some(
                state
                    .threads_by_path
                    .get(&path)?
                    .keys()
                    .filter(|thread_id| !state.suppressed_threads.contains_key(*thread_id))
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        })
        .unwrap_or_default();
    for thread_id in thread_ids {
        on_invalidate(thread_id);
    }
}

fn poll_changed_paths(
    state: &Mutex<RolloutWatchState>,
    on_invalidate: &Arc<RolloutInvalidationCallback>,
) {
    let paths = state
        .lock()
        .map(|state| state.stamps_by_path.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();

    for path in paths {
        let next_stamp = rollout_file_stamp(&path);
        let thread_ids = {
            let Ok(mut state) = state.lock() else {
                continue;
            };
            let Some(previous_stamp) = state.stamps_by_path.get_mut(&path) else {
                continue;
            };
            if *previous_stamp == next_stamp {
                continue;
            }
            *previous_stamp = next_stamp;
            state
                .threads_by_path
                .get(&path)
                .map(|threads| {
                    threads
                        .keys()
                        .filter(|thread_id| !state.suppressed_threads.contains_key(*thread_id))
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        for thread_id in thread_ids {
            on_invalidate(thread_id);
        }
    }
}

fn rollout_file_stamp(path: &Path) -> Option<RolloutFileStamp> {
    std::fs::metadata(path).ok().map(Into::into)
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs::OpenOptions, io::Write, sync::mpsc};

    #[test]
    fn rollout_changes_only_invalidate_subscribed_threads() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, [0xff, 0x00, 0x7f]).unwrap();
        let invalidations = Arc::new(Mutex::new(Vec::new()));
        let callback_invalidations = invalidations.clone();
        let monitor = TaskRolloutMonitor::new(move |thread_id| {
            callback_invalidations.lock().unwrap().push(thread_id);
        });
        let subscription = monitor.subscribe("thread-1", path.to_str()).unwrap();

        monitor.invalidate_path(&path);
        monitor.invalidate_path(&temp.path().join("other.jsonl"));

        assert_eq!(
            invalidations.lock().unwrap().as_slice(),
            &["thread-1".to_string()]
        );
        drop(subscription);
        monitor.invalidate_path(&path);
        assert_eq!(invalidations.lock().unwrap().len(), 1);
    }

    #[test]
    fn subscriptions_share_a_path_until_the_last_viewer_closes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, "not parsed").unwrap();
        let monitor = TaskRolloutMonitor::new(|_| {});
        let first = monitor.subscribe("thread-1", path.to_str()).unwrap();
        let second = monitor.subscribe("thread-1", path.to_str()).unwrap();

        assert_eq!(monitor.subscription_count(&path, "thread-1"), 2);
        drop(first);
        assert_eq!(monitor.subscription_count(&path, "thread-1"), 1);
        drop(second);
        assert_eq!(monitor.subscription_count(&path, "thread-1"), 0);
    }

    #[test]
    fn monitor_invalidates_when_an_open_rollout_is_appended() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, "initial\n").unwrap();
        let (sender, receiver) = mpsc::channel();
        let monitor = TaskRolloutMonitor::new(move |thread_id| {
            let _ = sender.send(thread_id);
        });
        let _subscription = monitor.subscribe("thread-1", path.to_str()).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "external update").unwrap();
        file.sync_all().unwrap();

        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
            "thread-1"
        );
    }

    #[test]
    fn monitor_invalidates_when_a_rollout_is_rewritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, "initial\n").unwrap();
        let (sender, receiver) = mpsc::channel();
        let monitor = TaskRolloutMonitor::new(move |thread_id| {
            let _ = sender.send(thread_id);
        });
        let _subscription = monitor.subscribe("thread-1", path.to_str()).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        std::fs::write(&path, "external update\n").unwrap();

        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
            "thread-1"
        );
    }

    #[test]
    fn canonical_sync_changes_are_absorbed_without_self_invalidation() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, "initial\n").unwrap();
        let (sender, receiver) = mpsc::channel();
        let monitor = TaskRolloutMonitor::new(move |thread_id| {
            let _ = sender.send(thread_id);
        });
        let _subscription = monitor.subscribe("thread-1", path.to_str()).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let suppression = monitor.suppress("thread-1");
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "canonical sync update").unwrap();
        file.sync_all().unwrap();
        drop(suppression);
        std::thread::sleep(Duration::from_millis(500));
        assert!(receiver.try_recv().is_err());

        writeln!(file, "next external update").unwrap();
        file.sync_all().unwrap();
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
            "thread-1"
        );
    }
}
