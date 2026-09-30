//! Notices when the server's request threads stop running work, and logs when
//! that began, how many files the process holds open, and which requests were
//! still waiting, so a freeze leaves evidence in the server log. It also logs
//! each request whose handler has gone too long without answering, so requests
//! that pile up before a freeze leave evidence as they go.
//!
//! The monitor runs on its own thread outside the Tokio runtime, so it keeps
//! running when every worker is held up. At a fixed interval it hands the
//! runtime an empty task, and it counts the runtime as stalled once none has
//! run for the threshold. At the same interval it looks through the waiting
//! requests and logs each one once when it passes its own threshold.
//! On macOS, the first detection of each stall starts an independent stack
//! sample before reporting, so a blocked log writer cannot delay its start.

use std::{
    cmp::Reverse,
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
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

#[cfg(target_os = "macos")]
mod sample;

#[cfg(target_os = "macos")]
use sample::Sampler;

const TIMING: Timing = Timing {
    probe: Duration::from_secs(1),
    stall_after: Duration::from_secs(5),
    repeat: Duration::from_secs(60),
    unanswered_after: Duration::from_secs(60),
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
    pub(super) fn start(requests: RequestsInFlight, _sample_directory: PathBuf) -> Self {
        #[cfg(target_os = "macos")]
        let sampler = Sampler::new(_sample_directory);
        Self::start_with(Handle::current(), requests, TIMING, log_report, move || {
            #[cfg(target_os = "macos")]
            sampler.capture();
        })
    }

    fn start_with(
        runtime: Handle,
        requests: RequestsInFlight,
        timing: Timing,
        report: impl Fn(Report) + Send + 'static,
        on_stall: impl Fn() + Send + 'static,
    ) -> Self {
        let (stop, stopped) = mpsc::channel();
        let thread = thread::Builder::new()
            .name("caffold-stall-monitor".to_string())
            .spawn(move || watch(&runtime, &requests, timing, &stopped, report, on_stall));
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
/// how often a stall that lasts is reported again, and how long a request may
/// wait for its handler before it is reported.
#[derive(Clone, Copy)]
struct Timing {
    probe: Duration,
    stall_after: Duration,
    repeat: Duration,
    unanswered_after: Duration,
}

/// The body of the monitor thread, until the monitor stops.
fn watch(
    runtime: &Handle,
    requests: &RequestsInFlight,
    timing: Timing,
    stopped: &Receiver<()>,
    report: impl Fn(Report),
    on_stall: impl Fn(),
) {
    let started = Instant::now();
    // When a handed task last ran, as nanoseconds after `started`.
    let last_ran = Arc::new(AtomicU64::new(0));
    let probing = Arc::new(AtomicBool::new(false));
    let mut stall: Option<Stall> = None;
    while let Err(RecvTimeoutError::Timeout) = stopped.recv_timeout(timing.probe) {
        let now = Instant::now();
        let ran_at = started + Duration::from_nanos(last_ran.load(Ordering::Acquire));
        let silent = now.saturating_duration_since(ran_at);
        if silent < timing.stall_after {
            if let Some(ended) = stall.take() {
                report(Report::Resumed {
                    stalled_for: ran_at.saturating_duration_since(ended.began),
                });
            }
        } else {
            match &mut stall {
                None => {
                    on_stall();
                    stall = Some(Stall {
                        began: ran_at,
                        next_report: now + timing.repeat,
                    });
                    report(Report::Stalled(snapshot(silent, requests, now)));
                }
                Some(ongoing) if now >= ongoing.next_report => {
                    report(Report::Stalled(snapshot(silent, requests, now)));
                    ongoing.next_report += timing.repeat;
                }
                Some(_) => {}
            }
        }

        // Starting evidence must precede the request lock and report writer.
        // A task that has not run yet is left waiting, without piling up probes.
        if !probing.swap(true, Ordering::AcqRel) {
            let last_ran = last_ran.clone();
            let probing = probing.clone();
            runtime.spawn(async move {
                last_ran.store(nanos(started.elapsed()), Ordering::Release);
                probing.store(false, Ordering::Release);
            });
        }
        for request in requests.newly_unanswered(now, timing.unanswered_after) {
            report(Report::Unanswered(request));
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

enum Report {
    Stalled(StallSnapshot),
    Resumed { stalled_for: Duration },
    Unanswered(WaitingRequest),
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

fn log_report(report: Report) {
    warn!("{}", report_message(&report));
}

fn report_message(report: &Report) -> String {
    match report {
        Report::Stalled(snapshot) => {
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
        Report::Resumed { stalled_for } => format!(
            "request threads ran again after {:.1}s",
            stalled_for.as_secs_f64()
        ),
        Report::Unanswered(request) => format!(
            "request unanswered after {:.1}s: {} {}",
            request.age.as_secs_f64(),
            request.method,
            request.path
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
    /// Whether the monitor has reported this request as unanswered.
    reported: bool,
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
                reported: false,
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

    /// The requests that have waited at least `after` and were not returned
    /// before. Each request is returned once.
    fn newly_unanswered(&self, now: Instant, after: Duration) -> Vec<WaitingRequest> {
        let mut unanswered = Vec::new();
        // Request registration must never prevent this native monitor from
        // reaching the next stall check. Retry a busy tracker on the next tick.
        let mut requests = match self.inner.waiting.try_lock() {
            Ok(requests) => requests,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return unanswered,
        };
        for waiting in requests.values_mut() {
            let age = now.saturating_duration_since(waiting.started);
            if waiting.reported || age < after {
                continue;
            }
            waiting.reported = true;
            unanswered.push(WaitingRequest {
                method: waiting.method.clone(),
                path: waiting.path.clone(),
                age,
            });
        }
        unanswered
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
        unanswered_after: Duration::from_secs(60),
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
    ) -> (StallMonitor, Receiver<Report>, Receiver<()>) {
        let (sender, reports) = mpsc::channel();
        let (capture, captures) = mpsc::channel();
        let monitor = StallMonitor::start_with(
            runtime.handle().clone(),
            requests.clone(),
            timing,
            move |report| {
                let _ = sender.send(report);
            },
            move || {
                let _ = capture.send(());
            },
        );
        (monitor, reports, captures)
    }

    #[test]
    fn a_locked_request_tracker_cannot_delay_stall_capture() {
        let runtime = one_worker();
        let requests = RequestsInFlight::default();
        let (release, released) = mpsc::channel::<()>();
        let (held, holding) = mpsc::channel::<()>();
        runtime.spawn(async move {
            held.send(()).unwrap();
            let _ = released.recv();
        });
        holding.recv_timeout(WAIT).unwrap();
        let tracker = requests.lock();
        let (monitor, _reports, captures) = monitor(&runtime, &requests, FAST);
        let captured = captures.recv_timeout(WAIT);
        drop(tracker);
        release.send(()).unwrap();
        monitor.stop();
        assert!(captured.is_ok(), "capture waited on the request tracker");
    }

    #[test]
    fn a_blocked_report_writer_cannot_delay_stall_capture() {
        let runtime = one_worker();
        let (release, released) = mpsc::channel::<()>();
        let (held, holding) = mpsc::channel::<()>();
        runtime.spawn(async move {
            held.send(()).unwrap();
            let _ = released.recv();
        });
        holding.recv_timeout(WAIT).unwrap();
        let (writer_release, writer_released) = mpsc::channel::<()>();
        let (capture, captures) = mpsc::channel();
        let monitor = StallMonitor::start_with(
            runtime.handle().clone(),
            RequestsInFlight::default(),
            FAST,
            move |_| {
                let _ = writer_released.recv();
            },
            move || {
                let _ = capture.send(());
            },
        );
        let captured = captures.recv_timeout(WAIT);
        let _ = writer_release.send(());
        release.send(()).unwrap();
        monitor.stop();
        assert!(captured.is_ok(), "capture waited on the report writer");
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
        let (monitor, reports, captures) = monitor(&runtime, &requests, timing);

        let Ok(Report::Stalled(first)) = reports.recv_timeout(WAIT) else {
            panic!("the stall was not reported");
        };
        assert!(first.silent >= timing.stall_after);
        assert_eq!(first.waiting, 1);
        assert_eq!(first.requests[0].method, Method::GET);
        assert_eq!(first.requests[0].path, "/api/github/status");
        assert!(matches!(first.open_files, Ok(count) if count > 0));
        captures.recv_timeout(WAIT).unwrap();
        let Ok(Report::Stalled(again)) = reports.recv_timeout(WAIT) else {
            panic!("the lasting stall was not reported again");
        };
        assert!(again.silent >= first.silent + timing.repeat);
        assert!(matches!(
            captures.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));

        release.send(()).unwrap();
        let Ok(Report::Resumed { stalled_for }) = reports.recv_timeout(WAIT) else {
            panic!("the end of the stall was not reported");
        };
        assert!(stalled_for >= again.silent);

        // Recovery rearms collection for a separate incident.
        let (release, released) = mpsc::channel::<()>();
        let (held, holding) = mpsc::channel::<()>();
        runtime.spawn(async move {
            let _ = held.send(());
            let _ = released.recv();
        });
        holding.recv_timeout(WAIT).unwrap();
        assert!(matches!(reports.recv_timeout(WAIT), Ok(Report::Stalled(_))));
        captures.recv_timeout(WAIT).unwrap();
        release.send(()).unwrap();
        monitor.stop();
    }

    #[test]
    fn a_request_left_unanswered_is_reported_while_a_worker_is_free() {
        let runtime = one_worker();
        let requests = RequestsInFlight::default();
        let _entry = requests.enter(&Method::GET, "/api/github/status");
        let timing = Timing {
            stall_after: Duration::from_secs(60),
            unanswered_after: Duration::from_millis(200),
            ..FAST
        };
        let (monitor, reports, captures) = monitor(&runtime, &requests, timing);

        let Ok(Report::Unanswered(request)) = reports.recv_timeout(WAIT) else {
            panic!("the unanswered request was not reported");
        };
        assert_eq!(request.method, Method::GET);
        assert_eq!(request.path, "/api/github/status");
        assert!(request.age >= timing.unanswered_after);
        assert!(matches!(
            captures.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
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
        let (monitor, reports, captures) = monitor(&runtime, &requests, timing);

        assert!(matches!(
            reports.recv_timeout(Duration::from_millis(1_500)),
            Err(RecvTimeoutError::Timeout)
        ));
        assert!(matches!(
            captures.try_recv(),
            Err(mpsc::TryRecvError::Empty)
        ));
        monitor.stop();
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires macOS permission for /usr/bin/sample to inspect this test process"]
    fn a_blocked_runtime_automatically_saves_real_macos_thread_stacks() {
        use std::{io, sync::Condvar};

        let log_gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (log_entered, log_seen) = mpsc::channel();
        let (sample_saved, sample_completed) = mpsc::channel();
        let gate = log_gate.clone();
        tracing_subscriber::fmt()
            .with_max_level(tracing::Level::WARN)
            .with_writer(move || BlockedLog {
                gate: gate.clone(),
                entered: log_entered.clone(),
                saved: sample_saved.clone(),
            })
            .try_init()
            .expect("run this process-level capture test in isolation with --exact");
        let runtime = one_worker();
        let directory = tempfile::tempdir().unwrap();
        let (release, released) = mpsc::channel::<()>();
        let (held, holding) = mpsc::channel::<()>();
        runtime.spawn(async move {
            let _ = held.send(());
            let _ = released.recv();
        });
        holding.recv_timeout(WAIT).unwrap();
        let monitor = {
            let _entered = runtime.enter();
            StallMonitor::start(RequestsInFlight::default(), directory.path().to_path_buf())
        };

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut report = String::new();
        while Instant::now() < deadline {
            for entry in fs::read_dir(directory.path()).unwrap() {
                report = fs::read_to_string(entry.unwrap().path()).unwrap();
            }
            if report.contains("Binary Images:") || report.contains("Caffold stack sample failed") {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        let logging_blocked = log_seen.recv_timeout(WAIT);
        // Always release both blocked boundaries before asserting or joining.
        *log_gate.0.lock().unwrap() = true;
        log_gate.1.notify_all();
        release.send(()).unwrap();
        monitor.stop();
        let helper_finished = sample_completed.recv_timeout(Duration::from_secs(12));

        assert!(
            logging_blocked.is_ok(),
            "the real log writer was not reached"
        );
        assert!(
            helper_finished.is_ok(),
            "the sampler did not confirm successful helper exit"
        );
        assert!(report.contains("Call graph:"), "no stack report: {report}");
        assert!(
            report.contains("tokio-rt-worker"),
            "no Tokio worker stack: {report}"
        );
        assert!(report.contains(&format!("[{}]", std::process::id())));
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 1);
        // Retain successful evidence, including while the detached sampler
        // finishes its exit/status checks, for inspection after this test.
        println!(
            "Automatic stack report retained in {}",
            directory.keep().display()
        );

        struct BlockedLog {
            gate: Arc<(Mutex<bool>, Condvar)>,
            entered: Sender<()>,
            saved: Sender<()>,
        }

        impl io::Write for BlockedLog {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                let _ = self.entered.send(());
                let mut released = self.gate.0.lock().unwrap();
                while !*released {
                    released = self.gate.1.wait(released).unwrap();
                }
                if String::from_utf8_lossy(bytes).contains("stall stack sample saved") {
                    let _ = self.saved.send(());
                }
                Ok(bytes.len())
            }

            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
    }

    #[test]
    fn a_report_names_the_stall_the_files_and_the_waiting_requests() {
        let stalled = Report::Stalled(StallSnapshot {
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

        let exhausted = Report::Stalled(StallSnapshot {
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

        let resumed = Report::Resumed {
            stalled_for: Duration::from_millis(61_400),
        };
        assert_eq!(
            report_message(&resumed),
            "request threads ran again after 61.4s"
        );

        let unanswered = Report::Unanswered(WaitingRequest {
            method: Method::GET,
            path: "/api/github/status".to_string(),
            age: Duration::from_millis(60_200),
        });
        assert_eq!(
            report_message(&unanswered),
            "request unanswered after 60.2s: GET /api/github/status"
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

    #[test]
    fn a_request_is_returned_as_unanswered_one_time_after_it_has_waited_long_enough() {
        let requests = RequestsInFlight::default();
        let after = Duration::from_secs(60);
        let _waiting = requests.enter(&Method::GET, "/api/github/status");
        assert!(requests.newly_unanswered(Instant::now(), after).is_empty());

        let later = Instant::now() + after;
        let unanswered = requests.newly_unanswered(later, after);
        assert_eq!(unanswered.len(), 1);
        assert_eq!(unanswered[0].path, "/api/github/status");
        assert!(unanswered[0].age >= after);
        assert!(requests.newly_unanswered(later + after, after).is_empty());

        drop(requests.enter(&Method::POST, "/api/tasks"));
        assert!(
            requests
                .newly_unanswered(Instant::now() + after, after)
                .is_empty()
        );
    }
}
