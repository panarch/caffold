use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

type RolloutInvalidationCallback = dyn Fn(String) + Send + Sync;

#[derive(Default)]
struct RolloutWatchState {
    threads_by_path: HashMap<PathBuf, HashMap<String, usize>>,
    subscriptions_by_directory: HashMap<PathBuf, usize>,
}

#[derive(Clone)]
pub(crate) struct TaskRolloutMonitor {
    state: Arc<Mutex<RolloutWatchState>>,
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    #[cfg(test)]
    on_invalidate: Arc<RolloutInvalidationCallback>,
}

pub(crate) struct TaskRolloutSubscription {
    monitor: TaskRolloutMonitor,
    thread_id: String,
    path: PathBuf,
    directory: PathBuf,
}

impl Drop for TaskRolloutSubscription {
    fn drop(&mut self) {
        self.monitor
            .unsubscribe(&self.thread_id, &self.path, &self.directory);
    }
}

impl TaskRolloutMonitor {
    pub(crate) fn new(on_invalidate: impl Fn(String) + Send + Sync + 'static) -> Self {
        let state = Arc::new(Mutex::new(RolloutWatchState::default()));
        let callback_state = state.clone();
        let on_invalidate: Arc<RolloutInvalidationCallback> = Arc::new(on_invalidate);
        let callback_on_invalidate = on_invalidate.clone();
        let callback = move |event: notify::Result<notify::Event>| match event {
            Ok(event) => {
                for path in event.paths {
                    invalidate_changed_path(&callback_state, &callback_on_invalidate, &path);
                }
            }
            Err(error) => eprintln!("Codex rollout watcher error: {error}"),
        };
        let watcher = match notify::recommended_watcher(callback) {
            Ok(watcher) => Some(watcher),
            Err(error) => {
                eprintln!("Codex rollout watcher unavailable: {error}");
                None
            }
        };
        Self {
            state,
            watcher: Arc::new(Mutex::new(watcher)),
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
        let directory = path.parent().map(normalize_path)?;

        let mut state = self.state.lock().ok()?;
        let first_directory_subscription =
            !state.subscriptions_by_directory.contains_key(&directory);
        if first_directory_subscription {
            let mut watcher = self.watcher.lock().ok()?;
            let watcher = watcher.as_mut()?;
            if let Err(error) = watcher.watch(&directory, RecursiveMode::NonRecursive) {
                eprintln!(
                    "failed to watch Codex rollout directory {}: {error}",
                    directory.display()
                );
                return None;
            }
        }

        *state
            .subscriptions_by_directory
            .entry(directory.clone())
            .or_default() += 1;
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
            directory,
        })
    }

    fn unsubscribe(&self, thread_id: &str, path: &Path, directory: &Path) {
        let should_unwatch = {
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
                }
            }

            let Some(count) = state.subscriptions_by_directory.get_mut(directory) else {
                return;
            };
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.subscriptions_by_directory.remove(directory);
                true
            } else {
                false
            }
        };

        if should_unwatch
            && let Ok(mut watcher) = self.watcher.lock()
            && let Some(watcher) = watcher.as_mut()
        {
            let _ = watcher.unwatch(directory);
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

fn invalidate_changed_path(
    state: &Mutex<RolloutWatchState>,
    on_invalidate: &Arc<RolloutInvalidationCallback>,
    path: &Path,
) {
    let path = normalize_path(path);
    let thread_ids = state
        .lock()
        .ok()
        .and_then(|state| state.threads_by_path.get(&path).cloned())
        .map(|threads| threads.into_keys().collect::<Vec<_>>())
        .unwrap_or_default();
    for thread_id in thread_ids {
        on_invalidate(thread_id);
    }
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
