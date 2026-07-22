use std::{
    collections::HashMap,
    fs::Metadata,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

type RolloutSignalCallback = dyn Fn(String, TaskRolloutSignal) + Send + Sync;
const ROLLOUT_STAT_INTERVAL: Duration = Duration::from_millis(250);
const ROLLOUT_INITIAL_TAIL_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TaskRolloutSignal {
    Invalidated,
    ExternalStarted {
        turn_id: String,
        started_at_ms: u64,
    },
    ExternalFinished {
        turn_id: String,
        completed_at_ms: Option<u64>,
        aborted: bool,
    },
}

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
    readers_by_path: HashMap<PathBuf, RolloutReader>,
}

#[derive(Default)]
struct RolloutReader {
    offset: u64,
    carry: Vec<u8>,
}

#[derive(Clone)]
pub(crate) struct TaskRolloutMonitor {
    state: Arc<Mutex<RolloutWatchState>>,
    on_signal: Arc<RolloutSignalCallback>,
}

pub(crate) struct TaskRolloutSubscription {
    monitor: TaskRolloutMonitor,
    thread_id: String,
    path: PathBuf,
}

impl Drop for TaskRolloutSubscription {
    fn drop(&mut self) {
        self.monitor.unsubscribe(&self.thread_id, &self.path);
    }
}

impl TaskRolloutMonitor {
    pub(crate) fn new(
        on_signal: impl Fn(String, TaskRolloutSignal) + Send + Sync + 'static,
    ) -> Self {
        let state = Arc::new(Mutex::new(RolloutWatchState::default()));
        let on_signal: Arc<RolloutSignalCallback> = Arc::new(on_signal);
        let callback_state = Arc::downgrade(&state);
        let callback_on_signal = on_signal.clone();
        thread::Builder::new()
            .name("caffold-rollout-monitor".to_string())
            .spawn(move || {
                loop {
                    thread::sleep(ROLLOUT_STAT_INTERVAL);
                    let Some(state) = callback_state.upgrade() else {
                        return;
                    };
                    poll_changed_paths(&state, &callback_on_signal);
                }
            })
            .expect("start Codex rollout monitor");

        Self { state, on_signal }
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

        let initial_signal = {
            let mut state = self.state.lock().ok()?;
            let first_path_subscription = !state.threads_by_path.contains_key(&path);
            if first_path_subscription {
                state
                    .stamps_by_path
                    .insert(path.clone(), rollout_file_stamp(&path));
                let (reader, signal) = initial_rollout_reader(&path);
                state.readers_by_path.insert(path.clone(), reader);
                *state
                    .threads_by_path
                    .entry(path.clone())
                    .or_default()
                    .entry(thread_id.to_string())
                    .or_default() += 1;
                signal
            } else {
                *state
                    .threads_by_path
                    .entry(path.clone())
                    .or_default()
                    .entry(thread_id.to_string())
                    .or_default() += 1;
                None
            }
        };
        if let Some(signal) = initial_signal {
            (self.on_signal)(thread_id.to_string(), signal);
        }

        Some(TaskRolloutSubscription {
            monitor: self.clone(),
            thread_id: thread_id.to_string(),
            path,
        })
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
                state.readers_by_path.remove(path);
            }
        }
    }

    #[cfg(test)]
    fn invalidate_path(&self, path: &Path) {
        invalidate_changed_path(&self.state, &self.on_signal, path);
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
    on_signal: &Arc<RolloutSignalCallback>,
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
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        })
        .unwrap_or_default();
    for thread_id in thread_ids {
        on_signal(thread_id, TaskRolloutSignal::Invalidated);
    }
}

fn poll_changed_paths(state: &Mutex<RolloutWatchState>, on_signal: &Arc<RolloutSignalCallback>) {
    let paths = state
        .lock()
        .map(|state| state.stamps_by_path.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();

    for path in paths {
        let next_stamp = rollout_file_stamp(&path);
        let (thread_ids, signals) = {
            let Ok(mut state) = state.lock() else {
                continue;
            };
            let Some(previous_stamp) = state.stamps_by_path.get_mut(&path) else {
                continue;
            };
            if *previous_stamp == next_stamp {
                continue;
            }
            let previous = *previous_stamp;
            *previous_stamp = next_stamp;
            let signals = state
                .readers_by_path
                .get_mut(&path)
                .map(|reader| read_rollout_changes(&path, reader, previous, next_stamp))
                .unwrap_or_default();
            let thread_ids = state
                .threads_by_path
                .get(&path)
                .map(|threads| threads.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            (thread_ids, signals)
        };
        for thread_id in thread_ids {
            for signal in &signals {
                on_signal(thread_id.clone(), signal.clone());
            }
            on_signal(thread_id, TaskRolloutSignal::Invalidated);
        }
    }
}

fn initial_rollout_reader(path: &Path) -> (RolloutReader, Option<TaskRolloutSignal>) {
    let Ok(mut file) = std::fs::File::open(path) else {
        return (RolloutReader::default(), None);
    };
    let len = file.metadata().map_or(0, |metadata| metadata.len());
    let start = len.saturating_sub(ROLLOUT_INITIAL_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return (RolloutReader::default(), None);
    }
    let mut bytes = Vec::new();
    if file.read_to_end(&mut bytes).is_err() {
        return (RolloutReader::default(), None);
    }
    if start > 0
        && let Some(index) = bytes.iter().position(|byte| *byte == b'\n')
    {
        bytes.drain(..=index);
    }
    let complete_len = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let carry = bytes.split_off(complete_len);
    let signal = latest_external_activity_signal(&bytes);
    (RolloutReader { offset: len, carry }, signal)
}

fn read_rollout_changes(
    path: &Path,
    reader: &mut RolloutReader,
    previous: Option<RolloutFileStamp>,
    next: Option<RolloutFileStamp>,
) -> Vec<TaskRolloutSignal> {
    let Some(next) = next else {
        reader.offset = 0;
        reader.carry.clear();
        return Vec::new();
    };
    let append_only =
        previous.is_some_and(|stamp| stamp.len == reader.offset && next.len > reader.offset);
    if !append_only {
        let (next_reader, signal) = initial_rollout_reader(path);
        *reader = next_reader;
        return signal.into_iter().collect();
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    if file.seek(SeekFrom::Start(reader.offset)).is_err() {
        return Vec::new();
    }
    let mut bytes = std::mem::take(&mut reader.carry);
    if file.read_to_end(&mut bytes).is_err() {
        return Vec::new();
    }
    reader.offset = next.len;
    let complete_len = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    reader.carry = bytes.split_off(complete_len);
    bytes
        .split(|byte| *byte == b'\n')
        .filter_map(parse_rollout_line)
        .collect()
}

fn latest_external_activity_signal(bytes: &[u8]) -> Option<TaskRolloutSignal> {
    let mut active: Option<TaskRolloutSignal> = None;
    for signal in bytes
        .split(|byte| *byte == b'\n')
        .filter_map(parse_rollout_line)
    {
        match &signal {
            TaskRolloutSignal::ExternalStarted { .. } => active = Some(signal),
            TaskRolloutSignal::ExternalFinished { turn_id, .. } => {
                if active.as_ref().is_some_and(|active| {
                    matches!(active, TaskRolloutSignal::ExternalStarted { turn_id: active_id, .. } if active_id == turn_id)
                }) {
                    active = None;
                }
            }
            TaskRolloutSignal::Invalidated => {}
        }
    }
    active
}

fn parse_rollout_line(line: &[u8]) -> Option<TaskRolloutSignal> {
    let value: serde_json::Value = serde_json::from_slice(line).ok()?;
    if value.get("type").and_then(serde_json::Value::as_str) != Some("event_msg") {
        return None;
    }
    let payload = value.get("payload")?;
    let event_type = payload.get("type")?.as_str()?;
    let turn_id = payload.get("turn_id")?.as_str()?.to_string();
    match event_type {
        "task_started" => Some(TaskRolloutSignal::ExternalStarted {
            turn_id,
            started_at_ms: seconds_value_to_ms(payload.get("started_at")?)?,
        }),
        "task_complete" => Some(TaskRolloutSignal::ExternalFinished {
            turn_id,
            completed_at_ms: payload.get("completed_at").and_then(seconds_value_to_ms),
            aborted: false,
        }),
        "turn_aborted" => Some(TaskRolloutSignal::ExternalFinished {
            turn_id,
            completed_at_ms: payload.get("completed_at").and_then(seconds_value_to_ms),
            aborted: true,
        }),
        _ => None,
    }
}

fn seconds_value_to_ms(value: &serde_json::Value) -> Option<u64> {
    value
        .as_u64()
        .map(|seconds| seconds.saturating_mul(1000))
        .or_else(|| value.as_f64().map(|seconds| (seconds * 1000.0) as u64))
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
    fn task_started_is_reported_as_external_activity() {
        let signal = parse_rollout_line(
            br#"{"timestamp":"2026-07-21T00:00:00Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-gui","started_at":1784569546}}"#,
        );

        assert_eq!(
            signal,
            Some(TaskRolloutSignal::ExternalStarted {
                turn_id: "turn-gui".to_string(),
                started_at_ms: 1_784_569_546_000,
            })
        );
    }

    #[test]
    fn task_complete_and_turn_aborted_finish_external_activity() {
        let completed = parse_rollout_line(
            br#"{"timestamp":"2026-07-21T00:00:02Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"turn-gui","completed_at":1784569548}}"#,
        );
        let aborted = parse_rollout_line(
            br#"{"timestamp":"2026-07-21T00:00:03Z","type":"event_msg","payload":{"type":"turn_aborted","turn_id":"turn-2"}}"#,
        );

        assert_eq!(
            completed,
            Some(TaskRolloutSignal::ExternalFinished {
                turn_id: "turn-gui".to_string(),
                completed_at_ms: Some(1_784_569_548_000),
                aborted: false,
            })
        );
        assert_eq!(
            aborted,
            Some(TaskRolloutSignal::ExternalFinished {
                turn_id: "turn-2".to_string(),
                completed_at_ms: None,
                aborted: true,
            })
        );
    }

    #[test]
    fn unrelated_rollout_lines_are_only_invalidations() {
        assert_eq!(
            parse_rollout_line(
                br#"{"timestamp":"2026-07-21T00:00:01Z","type":"response_item","payload":{"type":"message"}}"#,
            ),
            None
        );
        assert_eq!(parse_rollout_line(b"not-json"), None);
    }

    #[test]
    fn rollout_changes_only_invalidate_subscribed_threads() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, [0xff, 0x00, 0x7f]).unwrap();
        let invalidations = Arc::new(Mutex::new(Vec::new()));
        let callback_invalidations = invalidations.clone();
        let monitor = TaskRolloutMonitor::new(move |thread_id, signal| {
            callback_invalidations
                .lock()
                .unwrap()
                .push((thread_id, signal));
        });
        let subscription = monitor.subscribe("thread-1", path.to_str()).unwrap();

        monitor.invalidate_path(&path);
        monitor.invalidate_path(&temp.path().join("other.jsonl"));

        assert_eq!(
            invalidations.lock().unwrap().as_slice(),
            &[("thread-1".to_string(), TaskRolloutSignal::Invalidated)]
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
        let monitor = TaskRolloutMonitor::new(|_, _| {});
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
        let monitor = TaskRolloutMonitor::new(move |thread_id, signal| {
            let _ = sender.send((thread_id, signal));
        });
        let _subscription = monitor.subscribe("thread-1", path.to_str()).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "external update").unwrap();
        file.sync_all().unwrap();

        let received = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(received.0, "thread-1");
        assert_eq!(received.1, TaskRolloutSignal::Invalidated);
    }

    #[test]
    fn monitor_reports_external_activity_when_a_rollout_is_appended() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, "initial\n").unwrap();
        let (sender, receiver) = mpsc::channel();
        let monitor = TaskRolloutMonitor::new(move |thread_id, signal| {
            let _ = sender.send((thread_id, signal));
        });
        let _subscription = monitor.subscribe("thread-1", path.to_str()).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            r#"{{"timestamp":"2026-07-21T00:00:00Z","type":"event_msg","payload":{{"type":"task_started","turn_id":"turn-gui","started_at":1784569546}}}}"#
        )
        .unwrap();
        file.sync_all().unwrap();

        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(5)).unwrap(),
            (
                "thread-1".to_string(),
                TaskRolloutSignal::ExternalStarted {
                    turn_id: "turn-gui".to_string(),
                    started_at_ms: 1_784_569_546_000,
                }
            )
        );
        assert_eq!(
            receiver.recv_timeout(Duration::from_secs(1)).unwrap(),
            ("thread-1".to_string(), TaskRolloutSignal::Invalidated)
        );
    }

    #[test]
    fn monitor_invalidates_when_a_rollout_is_rewritten() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, "initial\n").unwrap();
        let (sender, receiver) = mpsc::channel();
        let monitor = TaskRolloutMonitor::new(move |thread_id, signal| {
            let _ = sender.send((thread_id, signal));
        });
        let _subscription = monitor.subscribe("thread-1", path.to_str()).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        std::fs::write(&path, "external update\n").unwrap();

        let received = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(received.0, "thread-1");
        assert_eq!(received.1, TaskRolloutSignal::Invalidated);
    }

    #[test]
    fn incomplete_rollout_lines_wait_for_a_trailing_newline() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("rollout.jsonl");
        std::fs::write(&path, "initial\n").unwrap();
        let mut reader = RolloutReader {
            offset: std::fs::metadata(&path).unwrap().len(),
            carry: Vec::new(),
        };
        let previous = rollout_file_stamp(&path);

        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_started\",\"turn_id\":\"turn-1\"").unwrap();
        file.sync_all().unwrap();
        assert!(
            read_rollout_changes(&path, &mut reader, previous, rollout_file_stamp(&path))
                .is_empty()
        );

        let previous = rollout_file_stamp(&path);
        writeln!(file, ",\"started_at\":1784569546}}}}").unwrap();
        file.sync_all().unwrap();
        assert_eq!(
            read_rollout_changes(&path, &mut reader, previous, rollout_file_stamp(&path)),
            vec![TaskRolloutSignal::ExternalStarted {
                turn_id: "turn-1".to_string(),
                started_at_ms: 1_784_569_546_000,
            }]
        );
    }
}
