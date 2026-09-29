//! Notices when the server's request threads stop running work, and logs when
//! that began, how many files the process holds open, and which requests were
//! still waiting, so a freeze leaves evidence in the server log.
//!
//! The monitor runs on its own thread outside the Tokio runtime, so it keeps
//! running when every worker is held up. At a fixed interval it hands the
//! runtime an empty task, and it counts the runtime as stalled once none has
//! run for the threshold.

use std::{
    cmp::Reverse,
    collections::HashMap,
    fs,
    sync::{
        Arc, Mutex, MutexGuard,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use axum::{
    Router,
    extract::{Request, State},
    http::Method,
    middleware::{self, Next},
    response::Response,
};
use rustix::process::{Resource, getrlimit};
use tokio::runtime::Handle;
use tracing::warn;

const TIMING: Timing = Timing {
    probe: Duration::from_secs(1),
    stall_after: Duration::from_secs(5),
    repeat: Duration::from_secs(60),
};

/// The most waiting requests one report lists.
const REPORTED_REQUESTS: usize = 20;

/// The monitor thread. Stopping it ends the thread.
pub(super) struct StallMonitor {
    stop: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl StallMonitor {
    /// Starts watching the current runtime. Must be called inside it.
    pub(super) fn start(requests: RequestsInFlight) -> Self {
        Self::start_with(Handle::current(), requests, TIMING, log_report)
    }

    fn start_with(
        runtime: Handle,
        requests: RequestsInFlight,
        timing: Timing,
        report: impl Fn(StallReport) + Send + 'static,
    ) -> Self {
        let (stop, stopped) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("caffold-stall-monitor".to_string())
            .spawn(move || watch(&runtime, &requests, timing, &stopped, report));
        let thread = match thread {
            Ok(thread) => Some(thread),
            Err(error) => {
                warn!("the stall monitor could not start: {error}");
                None
            }
        };
        Self {
            stop: Some(stop),
            thread,
        }
    }

    pub(super) fn stop(mut self) {
        drop(self.stop.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// How often the monitor looks, how long without a task counts as a stall,
/// and how often a stall that lasts is reported again.
#[derive(Clone, Copy)]
struct Timing {
    probe: Duration,
    stall_after: Duration,
    repeat: Duration,
}

/// The body of the monitor thread, until the monitor stops.
fn watch(
    runtime: &Handle,
    requests: &RequestsInFlight,
    timing: Timing,
    stopped: &Receiver<()>,
    report: impl Fn(StallReport),
) {
    let started = Instant::now();
    // When a handed task last ran, as nanoseconds after `started`.
    let last_ran = Arc::new(AtomicU64::new(0));
    let probing = Arc::new(AtomicBool::new(false));
    let mut stall: Option<Stall> = None;
    while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(timing.probe) {
        // A task that has not run yet is left waiting rather than joined by
        // another, so a stall does not pile tasks up.
        if !probing.swap(true, Ordering::AcqRel) {
            let last_ran = last_ran.clone();
            let probing = probing.clone();
            runtime.spawn(async move {
                last_ran.store(nanos(started.elapsed()), Ordering::Release);
                probing.store(false, Ordering::Release);
            });
        }

        let now = Instant::now();
        let ran_at = started + Duration::from_nanos(last_ran.load(Ordering::Acquire));
        let silent = now.saturating_duration_since(ran_at);
        if silent < timing.stall_after {
            if let Some(ended) = stall.take() {
                report(StallReport::Resumed {
                    stalled_for: ran_at.saturating_duration_since(ended.began),
                });
            }
            continue;
        }
        match &mut stall {
            None => {
                report(StallReport::Stalled(snapshot(silent, requests, now)));
                stall = Some(Stall {
                    began: ran_at,
                    next_report: now + timing.repeat,
                });
            }
            Some(ongoing) if now >= ongoing.next_report => {
                report(StallReport::Stalled(snapshot(silent, requests, now)));
                ongoing.next_report += timing.repeat;
            }
            Some(_) => {}
        }
    }
}

struct Stall {
    /// When a handed task last ran before the stall.
    began: Instant,
    next_report: Instant,
}

fn nanos(duration: Duration) -> u64 {
    u64::try_from(duration.as_nanos()).unwrap_or(u64::MAX)
}

enum StallReport {
    Stalled(StallSnapshot),
    Resumed { stalled_for: Duration },
}

struct StallSnapshot {
    /// How long no handed task has run.
    silent: Duration,
    open_files: Result<usize, String>,
    file_limit: Option<u64>,
    /// The longest-waiting requests, at most [`REPORTED_REQUESTS`].
    requests: Vec<WaitingRequest>,
    /// How many requests were waiting in all.
    waiting: usize,
}

fn snapshot(silent: Duration, requests: &RequestsInFlight, now: Instant) -> StallSnapshot {
    let (listed, waiting) = requests.waiting(now);
    StallSnapshot {
        silent,
        open_files: open_file_count(),
        file_limit: getrlimit(Resource::Nofile).current,
        requests: listed,
        waiting,
    }
}

fn log_report(report: StallReport) {
    warn!("{}", report_message(&report));
}

fn report_message(report: &StallReport) -> String {
    match report {
        StallReport::Stalled(snapshot) => {
            let open_files = match &snapshot.open_files {
                Ok(count) => count.to_string(),
                Err(error) => format!("unknown ({error})"),
            };
            let limit = snapshot
                .file_limit
                .map_or_else(|| "no limit".to_string(), |limit| limit.to_string());
            let mut message = format!(
                "request threads have run nothing for {:.1}s; open files {open_files} of {limit}; waiting requests: {}",
                snapshot.silent.as_secs_f64(),
                snapshot.waiting,
            );
            for request in &snapshot.requests {
                message.push_str(&format!(
                    "\n  {} {} for {:.1}s",
                    request.method,
                    request.path,
                    request.age.as_secs_f64()
                ));
            }
            message
        }
        StallReport::Resumed { stalled_for } => format!(
            "request threads ran again after {:.1}s",
            stalled_for.as_secs_f64()
        ),
    }
}

/// The descriptors the process holds, counted from `/dev/fd`. Failing to open
/// it is itself a sign that the process has run out.
fn open_file_count() -> Result<usize, String> {
    let entries = fs::read_dir("/dev/fd").map_err(|error| error.to_string())?;
    // The listing holds one descriptor of its own while it is open.
    Ok(entries.count().saturating_sub(1))
}

/// The HTTP requests whose handlers have not answered yet.
#[derive(Clone, Default)]
pub(super) struct RequestsInFlight {
    inner: Arc<Requests>,
}

#[derive(Default)]
struct Requests {
    next: AtomicU64,
    waiting: Mutex<HashMap<u64, Waiting>>,
}

struct Waiting {
    method: Method,
    path: String,
    started: Instant,
}

struct WaitingRequest {
    method: Method,
    path: String,
    age: Duration,
}

impl RequestsInFlight {
    /// Keeps every request that `router` handles in the table until its
    /// handler answers or the request is dropped.
    pub(super) fn track(&self, router: Router) -> Router {
        router.layer(middleware::from_fn_with_state(self.clone(), track_request))
    }

    fn enter(&self, method: &Method, path: &str) -> RequestEntry {
        let id = self.inner.next.fetch_add(1, Ordering::Relaxed);
        self.lock().insert(
            id,
            Waiting {
                method: method.clone(),
                path: path.to_string(),
                started: Instant::now(),
            },
        );
        RequestEntry {
            requests: self.clone(),
            id,
        }
    }

    /// The longest-waiting requests, at most [`REPORTED_REQUESTS`], and how
    /// many are waiting in all.
    fn waiting(&self, now: Instant) -> (Vec<WaitingRequest>, usize) {
        let mut listed = self
            .lock()
            .values()
            .map(|waiting| WaitingRequest {
                method: waiting.method.clone(),
                path: waiting.path.clone(),
                age: now.saturating_duration_since(waiting.started),
            })
            .collect::<Vec<_>>();
        let waiting = listed.len();
        listed.sort_by_key(|request| Reverse(request.age));
        listed.truncate(REPORTED_REQUESTS);
        (listed, waiting)
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<u64, Waiting>> {
        self.inner
            .waiting
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Only the path is kept: a query can carry file paths or tokens.
async fn track_request(
    State(requests): State<RequestsInFlight>,
    request: Request,
    next: Next,
) -> Response {
    let _entry = requests.enter(request.method(), request.uri().path());
    next.run(request).await
}

/// Takes its request out of the table when dropped.
struct RequestEntry {
    requests: RequestsInFlight,
    id: u64,
}

impl Drop for RequestEntry {
    fn drop(&mut self) {
        self.requests.lock().remove(&self.id);
    }
}

#[cfg(test)]
mod tests {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        routing::get,
    };
    use tokio::{
        runtime::{Builder, Runtime},
        sync::{mpsc as async_mpsc, oneshot},
        time::timeout,
    };
    use tower::ServiceExt;

    use super::*;

    const WAIT: Duration = Duration::from_secs(10);
    const FAST: Timing = Timing {
        probe: Duration::from_millis(10),
        stall_after: Duration::from_millis(200),
        repeat: Duration::from_secs(60),
    };

    fn one_worker() -> Runtime {
        Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .unwrap()
    }

    fn monitor(
        runtime: &Runtime,
        requests: &RequestsInFlight,
        timing: Timing,
    ) -> (StallMonitor, Receiver<StallReport>) {
        let (sender, reports) = mpsc::channel();
        let monitor = StallMonitor::start_with(
            runtime.handle().clone(),
            requests.clone(),
            timing,
            move |report| {
                let _ = sender.send(report);
            },
        );
        (monitor, reports)
    }

    #[test]
    fn a_held_up_runtime_is_reported_while_it_lasts_and_when_it_runs_again() {
        let runtime = one_worker();
        let requests = RequestsInFlight::default();
        let _entry = requests.enter(&Method::GET, "/api/github/status");
        // The only worker is held until the stall has been reported twice.
        let (release, released) = mpsc::channel::<()>();
        let (held, holding) = mpsc::channel::<()>();
        runtime.spawn(async move {
            let _ = held.send(());
            let _ = released.recv();
        });
        holding.recv_timeout(WAIT).unwrap();
        let timing = Timing {
            repeat: Duration::from_millis(300),
            ..FAST
        };
        let (monitor, reports) = monitor(&runtime, &requests, timing);

        let Ok(StallReport::Stalled(first)) = reports.recv_timeout(WAIT) else {
            panic!("the stall was not reported");
        };
        assert!(first.silent >= timing.stall_after);
        assert_eq!(first.waiting, 1);
        assert_eq!(first.requests[0].method, Method::GET);
        assert_eq!(first.requests[0].path, "/api/github/status");
        assert!(matches!(first.open_files, Ok(count) if count > 0));
        let Ok(StallReport::Stalled(again)) = reports.recv_timeout(WAIT) else {
            panic!("the lasting stall was not reported again");
        };
        assert!(again.silent >= first.silent + timing.repeat);

        release.send(()).unwrap();
        let Ok(StallReport::Resumed { stalled_for }) = reports.recv_timeout(WAIT) else {
            panic!("the end of the stall was not reported");
        };
        assert!(stalled_for >= again.silent);
        monitor.stop();
    }

    #[test]
    fn a_runtime_with_a_free_worker_is_not_reported() {
        let runtime = one_worker();
        let requests = RequestsInFlight::default();
        let timing = Timing {
            stall_after: Duration::from_secs(1),
            ..FAST
        };
        let (monitor, reports) = monitor(&runtime, &requests, timing);

        assert!(matches!(
            reports.recv_timeout(Duration::from_millis(1_500)),
            Err(RecvTimeoutError::Timeout)
        ));
        monitor.stop();
    }

    #[test]
    fn a_report_names_the_stall_the_files_and_the_waiting_requests() {
        let stalled = StallReport::Stalled(StallSnapshot {
            silent: Duration::from_millis(5_200),
            open_files: Ok(37),
            file_limit: Some(256),
            requests: vec![WaitingRequest {
                method: Method::GET,
                path: "/api/github/status".to_string(),
                age: Duration::from_millis(12_300),
            }],
            waiting: 1,
        });
        assert_eq!(
            report_message(&stalled),
            "request threads have run nothing for 5.2s; open files 37 of 256; waiting requests: 1\n  GET /api/github/status for 12.3s"
        );

        let exhausted = StallReport::Stalled(StallSnapshot {
            silent: Duration::from_secs(5),
            open_files: Err("Too many open files (os error 24)".to_string()),
            file_limit: Some(256),
            requests: Vec::new(),
            waiting: 0,
        });
        assert_eq!(
            report_message(&exhausted),
            "request threads have run nothing for 5.0s; open files unknown (Too many open files (os error 24)) of 256; waiting requests: 0"
        );

        let resumed = StallReport::Resumed {
            stalled_for: Duration::from_millis(61_400),
        };
        assert_eq!(
            report_message(&resumed),
            "request threads ran again after 61.4s"
        );
    }

    #[tokio::test]
    async fn the_table_keeps_a_request_until_its_handler_answers_or_it_is_dropped() {
        let requests = RequestsInFlight::default();
        let (entered, mut handler_entered) = async_mpsc::unbounded_channel::<()>();
        let answers = Arc::new(Mutex::new(Vec::<oneshot::Receiver<()>>::new()));
        let router = requests.track(Router::new().route(
            "/slow",
            get({
                let answers = answers.clone();
                move || {
                    let answer = answers.lock().unwrap().pop();
                    let _ = entered.send(());
                    async move {
                        if let Some(answer) = answer {
                            let _ = answer.await;
                        }
                        "done"
                    }
                }
            }),
        ));

        let (answer, answered) = oneshot::channel();
        answers.lock().unwrap().push(answered);
        let request = Request::get("/slow?token=secret")
            .body(Body::empty())
            .unwrap();
        let pending = tokio::spawn(router.clone().oneshot(request));
        timeout(WAIT, handler_entered.recv()).await.unwrap();
        let (listed, waiting) = requests.waiting(Instant::now());
        assert_eq!(waiting, 1);
        assert_eq!(listed[0].path, "/slow");
        answer.send(()).unwrap();
        let response = pending.await.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(requests.waiting(Instant::now()).1, 0);

        let (_never_answered, answered) = oneshot::channel::<()>();
        answers.lock().unwrap().push(answered);
        let request = Request::get("/slow").body(Body::empty()).unwrap();
        let abandoned = tokio::spawn(router.oneshot(request));
        timeout(WAIT, handler_entered.recv()).await.unwrap();
        assert_eq!(requests.waiting(Instant::now()).1, 1);
        abandoned.abort();
        assert!(matches!(abandoned.await, Err(error) if error.is_cancelled()));
        assert_eq!(requests.waiting(Instant::now()).1, 0);
    }
}
