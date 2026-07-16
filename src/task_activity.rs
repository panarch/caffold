use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use serde_json::Value as JsonValue;

const READ_CHUNK_BYTES: usize = 64 * 1024;
const TASK_STARTED_MARKER: &[u8] = br#""type":"task_started""#;
const TASK_COMPLETE_MARKER: &[u8] = br#""type":"task_complete""#;
type ActivityChangeCallback = dyn Fn(String, bool) + Send + Sync;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RolloutActivity {
    Running,
    Complete,
}

#[derive(Default)]
struct ObservedThreads {
    thread_by_path: HashMap<PathBuf, String>,
    activity_by_thread: HashMap<String, RolloutActivity>,
}

#[derive(Clone)]
pub(crate) struct TaskActivityMonitor {
    observed: Arc<Mutex<ObservedThreads>>,
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    on_change: Arc<ActivityChangeCallback>,
}

impl TaskActivityMonitor {
    pub(crate) fn new(on_change: impl Fn(String, bool) + Send + Sync + 'static) -> Self {
        let observed = Arc::new(Mutex::new(ObservedThreads::default()));
        let callback_observed = observed.clone();
        let on_change: Arc<ActivityChangeCallback> = Arc::new(on_change);
        let callback_on_change = on_change.clone();
        let callback = move |event: notify::Result<notify::Event>| {
            let Ok(event) = event else {
                return;
            };
            for path in event.paths {
                refresh_observed_path(&callback_observed, &callback_on_change, &path);
            }
        };
        let watcher = notify::recommended_watcher(callback).ok();
        Self {
            observed,
            watcher: Arc::new(Mutex::new(watcher)),
            on_change,
        }
    }

    pub(crate) fn observe_threads(&self, response: &JsonValue) {
        for thread in response
            .get("data")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
        {
            self.observe_thread(thread);
        }
    }

    pub(crate) fn observe_thread(&self, thread: &JsonValue) {
        let Some(thread_id) = thread.get("id").and_then(JsonValue::as_str) else {
            return;
        };
        let Some(path) = thread
            .get("path")
            .and_then(JsonValue::as_str)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
        else {
            return;
        };
        let path = path.canonicalize().unwrap_or(path);
        let activity = latest_rollout_activity(&path);
        let should_watch = {
            let Ok(mut observed) = self.observed.lock() else {
                return;
            };
            if let Some(activity) = activity {
                observed
                    .activity_by_thread
                    .insert(thread_id.to_string(), activity);
            }
            observed
                .thread_by_path
                .insert(path.clone(), thread_id.to_string())
                .is_none()
        };
        if should_watch
            && let Ok(mut watcher) = self.watcher.lock()
            && let Some(watcher) = watcher.as_mut()
        {
            let _ = watcher.watch(&path, RecursiveMode::NonRecursive);
        }
    }

    pub(crate) fn is_running(&self, thread_id: &str) -> bool {
        self.observed
            .lock()
            .ok()
            .and_then(|observed| observed.activity_by_thread.get(thread_id).copied())
            == Some(RolloutActivity::Running)
    }

    pub(crate) fn reconcile_running(&self) {
        let running_paths = {
            let Ok(observed) = self.observed.lock() else {
                return;
            };
            observed
                .thread_by_path
                .iter()
                .filter(|(_, thread_id)| {
                    observed.activity_by_thread.get(*thread_id) == Some(&RolloutActivity::Running)
                })
                .map(|(path, _)| path.clone())
                .collect::<Vec<_>>()
        };

        for path in running_paths {
            refresh_observed_path(&self.observed, &self.on_change, &path);
        }
    }
}

fn refresh_observed_path(
    observed: &Mutex<ObservedThreads>,
    on_change: &Arc<ActivityChangeCallback>,
    path: &Path,
) {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let Some(activity) = latest_rollout_activity(&path) else {
        return;
    };
    let changed = {
        let Ok(mut observed) = observed.lock() else {
            return;
        };
        let Some(thread_id) = observed.thread_by_path.get(&path).cloned() else {
            return;
        };
        if observed.activity_by_thread.get(&thread_id) == Some(&activity) {
            return;
        }
        observed
            .activity_by_thread
            .insert(thread_id.clone(), activity);
        Some((thread_id, activity == RolloutActivity::Running))
    };
    if let Some((thread_id, running)) = changed {
        on_change(thread_id, running);
    }
}

fn latest_rollout_activity(path: &Path) -> Option<RolloutActivity> {
    let mut file = File::open(path).ok()?;
    let mut end = file.metadata().ok()?.len();
    let overlap_len = TASK_STARTED_MARKER
        .len()
        .max(TASK_COMPLETE_MARKER.len())
        .saturating_sub(1);
    let mut right_prefix = Vec::new();

    while end > 0 {
        let start = end.saturating_sub(READ_CHUNK_BYTES as u64);
        let mut chunk = vec![0; (end - start) as usize];
        file.seek(SeekFrom::Start(start)).ok()?;
        file.read_exact(&mut chunk).ok()?;
        let mut searchable = chunk.clone();
        searchable.extend_from_slice(&right_prefix);

        let started = find_last(&searchable, TASK_STARTED_MARKER);
        let complete = find_last(&searchable, TASK_COMPLETE_MARKER);
        match (started, complete) {
            (Some(started), Some(complete)) => {
                return Some(if started > complete {
                    RolloutActivity::Running
                } else {
                    RolloutActivity::Complete
                });
            }
            (Some(_), None) => return Some(RolloutActivity::Running),
            (None, Some(_)) => return Some(RolloutActivity::Complete),
            (None, None) => {}
        }

        right_prefix = chunk.into_iter().take(overlap_len).collect();
        end = start;
    }
    None
}

fn find_last(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .rposition(|candidate| candidate == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_latest_task_lifecycle_from_rollout_tail() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(
            &path,
            concat!(
                "{\"payload\":{\"type\":\"task_started\"}}\n",
                "{\"payload\":{\"type\":\"task_complete\"}}\n"
            ),
        )
        .unwrap();
        assert_eq!(
            latest_rollout_activity(&path),
            Some(RolloutActivity::Complete)
        );

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{{\"payload\":{{\"type\":\"task_started\"}}}}").unwrap();
        assert_eq!(
            latest_rollout_activity(&path),
            Some(RolloutActivity::Running)
        );
    }

    #[test]
    fn finds_running_marker_before_large_active_turn() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        let mut file = File::create(&path).unwrap();
        writeln!(file, "{{\"payload\":{{\"type\":\"task_started\"}}}}").unwrap();
        file.write_all(&vec![b'x'; READ_CHUNK_BYTES * 3]).unwrap();
        assert_eq!(
            latest_rollout_activity(&path),
            Some(RolloutActivity::Running)
        );
    }

    #[test]
    fn reconciles_a_missed_completion_for_a_running_rollout() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, "{\"payload\":{\"type\":\"task_started\"}}\n").unwrap();
        let changes = Arc::new(Mutex::new(Vec::new()));
        let callback_changes = changes.clone();
        let monitor = TaskActivityMonitor::new(move |thread_id, running| {
            callback_changes.lock().unwrap().push((thread_id, running));
        });
        monitor.observe_thread(&serde_json::json!({
            "id": "thread-1",
            "path": path.to_string_lossy(),
        }));
        assert!(monitor.is_running("thread-1"));

        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        writeln!(file, "{{\"payload\":{{\"type\":\"task_complete\"}}}}").unwrap();
        monitor.reconcile_running();

        assert!(!monitor.is_running("thread-1"));
        assert!(
            changes
                .lock()
                .unwrap()
                .contains(&("thread-1".to_string(), false))
        );
    }
}
