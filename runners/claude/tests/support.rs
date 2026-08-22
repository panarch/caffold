//! Setup and transport shared by the runner's integration tests.
//!
//! This module starts runners, runs commands, and holds connections open. It
//! does not decide whether the runner behaved correctly — every such judgement
//! belongs to the test that made it, so the contract reads in one place. A
//! failure here means the harness could not carry out the setup, and is raised
//! as a panic to keep it distinguishable from an assertion about behaviour.
//!
//! Everything goes through the shipped command line rather than the crate's own
//! types, so a failing case can be reproduced by hand from the arguments the
//! panic prints.

// Two test binaries compile this module, and neither uses all of it: the live
// test has no stand-in agent to kill, and the ordinary suite does not filter
// frames by content. Every item here is used by one of them.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

use serde_json::Value;

const BINARY: &str = env!("CARGO_BIN_EXE_caffold-claude-runner");

/// Long enough to absorb process startup on a loaded machine, short enough that
/// a genuine hang fails the run instead of stalling it.
const TIMEOUT: Duration = Duration::from_secs(10);

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// The command that stands in for `claude`, with any behaviour flags appended.
pub fn fake_agent(arguments: &[&str]) -> Vec<String> {
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-agent");
    let mut argv = vec![fixture.display().to_string()];
    argv.extend(arguments.iter().map(|argument| argument.to_string()));
    argv
}

/// A runner serving one temporary data directory.
pub struct Runner {
    data_dir: PathBuf,
    process: Option<Child>,
    owns_directory: bool,
}

impl Runner {
    pub fn start() -> Self {
        let unique = format!(
            "caffold-runner-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let data_dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir).expect("create the data directory");
        let mut runner = Self::start_in(&data_dir);
        runner.owns_directory = true;
        runner
    }

    /// Start with extra `daemon run` arguments, in a directory of its own.
    pub fn start_with_args(extra: &[&str]) -> Self {
        let unique = format!(
            "caffold-runner-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        );
        let data_dir = std::env::temp_dir().join(unique);
        std::fs::create_dir_all(&data_dir).expect("create the data directory");
        let mut runner = Self::start_in_with(&data_dir, extra);
        runner.owns_directory = true;
        runner
    }

    /// Start against an existing directory, so a test can replace a runner that
    /// left state behind.
    pub fn start_in(data_dir: &Path) -> Self {
        Self::start_in_with(data_dir, &[])
    }

    fn start_in_with(data_dir: &Path, extra: &[&str]) -> Self {
        let process = Command::new(BINARY)
            .args(["daemon", "run", "--data-dir"])
            .arg(data_dir)
            .args(extra)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start the runner");

        let runner = Self {
            data_dir: data_dir.to_path_buf(),
            process: Some(process),
            owns_directory: false,
        };
        runner.wait_until_listening();
        runner
    }

    fn wait_until_listening(&self) {
        let deadline = Instant::now() + TIMEOUT;
        while Instant::now() < deadline {
            let ready = Command::new(BINARY)
                .args(["daemon", "status", "--data-dir"])
                .arg(&self.data_dir)
                .output()
                .expect("run status");
            if ready.status.success() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!(
            "the runner never began listening on {}",
            self.socket().display()
        );
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn socket(&self) -> PathBuf {
        self.data_dir.join("claude-runner.sock")
    }

    /// Run a command that is expected to succeed and parse its JSON output.
    pub fn run(&self, arguments: &[&str]) -> Value {
        let output = self.run_raw(arguments);
        serde_json::from_str(&output).unwrap_or_else(|error| {
            panic!("expected JSON from {arguments:?}, got {output:?}: {error}")
        })
    }

    pub fn run_raw(&self, arguments: &[&str]) -> String {
        let mut command = Command::new(BINARY);
        command.args(arguments);
        // Commands that end in a `--` separator carry the data directory
        // themselves; appending it here would hand it to the child instead.
        if !arguments.contains(&"--") {
            command.arg("--data-dir").arg(&self.data_dir);
        }
        let output = command.output().expect("run the command");
        if !output.status.success() {
            panic!(
                "{arguments:?} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    /// Run a command that is expected to fail, returning what it reported so
    /// the test can judge the reason.
    pub fn run_failing(&self, arguments: &[&str]) -> String {
        let output = Command::new(BINARY)
            .args(arguments)
            .arg("--data-dir")
            .arg(&self.data_dir)
            .stdin(Stdio::null())
            .output()
            .expect("run the command");
        if output.status.success() {
            panic!("{arguments:?} unexpectedly succeeded");
        }
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    }

    pub fn create(&self, session: &str, argv: &[String]) -> Value {
        let data_dir = self.data_dir.display().to_string();
        let mut arguments = vec![
            "session",
            "create",
            "--session",
            session,
            "--cwd",
            &data_dir,
            "--data-dir",
            &data_dir,
            "--",
        ];
        let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
        arguments.extend(argv);
        let output = self.run_raw(&arguments);
        serde_json::from_str(&output)
            .unwrap_or_else(|error| panic!("expected JSON from create, got {output:?}: {error}"))
    }

    pub fn sessions(&self) -> Vec<Value> {
        self.run(&["session", "list"])["sessions"]
            .as_array()
            .cloned()
            .expect("a sessions array")
    }

    pub fn session(&self, id: &str) -> Option<Value> {
        self.sessions()
            .into_iter()
            .find(|session| session["session"] == id)
    }

    /// Poll until the runner stops answering, so a test does not depend on how
    /// promptly it acts on its own timeout.
    pub fn wait_until_gone(&self) {
        let deadline = Instant::now() + TIMEOUT;
        while Instant::now() < deadline {
            let answering = Command::new(BINARY)
                .args(["daemon", "status", "--data-dir"])
                .arg(&self.data_dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if !answering {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("the runner never stopped answering");
    }

    /// Poll until the child has exited, so a test does not depend on how long a
    /// process takes to die.
    pub fn wait_for_exit(&self, id: &str) -> Value {
        let deadline = Instant::now() + TIMEOUT;
        while Instant::now() < deadline {
            if let Some(session) = self.session(id)
                && session["state"] == "exited"
            {
                return session;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        panic!("session {id} never reported an exit");
    }

    /// Attach to a session that already exists.
    pub fn attach(&self, session: &str) -> Attached {
        let attached = Attached::open(&self.data_dir, session, &[]);
        self.wait_until_attached(session);
        attached
    }

    /// Create a session and attach in one request, which is how a client avoids
    /// missing what an agent says as it starts.
    pub fn create_attached(&self, session: &str, argv: &[String]) -> Attached {
        let attached = Attached::open(&self.data_dir, session, argv);
        self.wait_until_attached(session);
        attached
    }

    /// Opening a connection returns before the runner has accepted the attach,
    /// so anything that depends on a session being taken has to wait for the
    /// runner to say so rather than for the process to exist.
    fn wait_until_attached(&self, id: &str) {
        let deadline = Instant::now() + TIMEOUT;
        while Instant::now() < deadline {
            if self
                .session(id)
                .is_some_and(|session| session["attached"] == true)
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("session {id} never reported an attached client");
    }

    pub fn attach_failing(&self, session: &str) -> String {
        self.run_failing(&["attach", "--session", session])
    }

    /// Send one request over the socket directly, for cases the command line
    /// deliberately cannot express.
    pub fn send_line(&self, line: &str) -> String {
        use std::os::unix::net::UnixStream;
        let mut stream = UnixStream::connect(self.socket()).expect("connect");
        stream.set_read_timeout(Some(TIMEOUT)).expect("set timeout");
        writeln!(stream, "{line}").expect("write the request");
        stream.flush().expect("flush the request");
        let mut reply = String::new();
        BufReader::new(stream)
            .read_line(&mut reply)
            .expect("read the reply");
        reply.trim().to_string()
    }

    pub fn stop(&self) {
        self.run_raw(&["daemon", "stop"]);
    }

    /// Kill the runner without letting it clean up, leaving the socket file
    /// behind the way a crash would.
    pub fn kill_without_cleanup(&mut self) {
        let Some(mut process) = self.process.take() else {
            return;
        };
        let pid = process.id() as i32;
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).status();
        // Reaping matters: an unwaited child stays a zombie, and a zombie still
        // answers `kill -0`, so the wait below would never settle.
        let _ = process.wait();
        if !wait_for_process_exit(pid) {
            panic!("the runner did not die");
        }
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }
        if self.owns_directory {
            let _ = std::fs::remove_dir_all(&self.data_dir);
        }
    }
}

/// One socket connection speaking the wire protocol directly.
///
/// The CLI holds one session per connection by construction, so a case about
/// one connection carrying several sessions needs the wire itself. Transport
/// only: what a reply or an event means stays with the test reading it.
pub struct Wire {
    stream: std::os::unix::net::UnixStream,
    reader: BufReader<std::os::unix::net::UnixStream>,
    next_id: u64,
    /// Events that arrived while a reply was being awaited.
    ///
    /// The wire carries replies and events interleaved, written by different
    /// tasks — a handler answers, the event pump forwards — so their relative
    /// order is not promised: a session's output can land between a request
    /// and that request's reply. A reader waiting for one kind has to keep
    /// the other, or an event consumed at the wrong moment is simply gone,
    /// which reads as the runner never having sent it.
    events: std::collections::VecDeque<Value>,
}

impl Wire {
    pub fn connect(runner: &Runner) -> Self {
        let stream = std::os::unix::net::UnixStream::connect(runner.socket())
            .expect("connect to the runner");
        stream
            .set_read_timeout(Some(TIMEOUT))
            .expect("a read deadline");
        let reader = BufReader::new(stream.try_clone().expect("clone the stream"));
        Self {
            stream,
            reader,
            next_id: 1,
            events: std::collections::VecDeque::new(),
        }
    }

    /// Send one request and return its reply, keeping events that arrive in
    /// between for [`Wire::next_event`] to hand out in order.
    pub fn request(&mut self, mut body: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        body["id"] = Value::from(id);
        let mut line = body.to_string();
        line.push('\n');
        self.stream
            .write_all(line.as_bytes())
            .expect("write the request");
        loop {
            let row = self.next_line();
            if row.get("id").and_then(Value::as_u64) == Some(id) {
                return row;
            }
            if row.get("t").is_some() {
                self.events.push_back(row);
            }
        }
    }

    /// The next event line, in arrival order — kept ones first — letting
    /// replies pass by.
    pub fn next_event(&mut self) -> Value {
        if let Some(kept) = self.events.pop_front() {
            return kept;
        }
        loop {
            let row = self.next_line();
            if row.get("t").is_some() {
                return row;
            }
        }
    }

    fn next_line(&mut self) -> Value {
        let mut line = String::new();
        let read = self
            .reader
            .read_line(&mut line)
            .expect("read from the runner");
        assert!(read > 0, "the runner closed the connection");
        serde_json::from_str(line.trim()).expect("a JSON line")
    }
}

/// A client attached to one session, reading on a background thread so a test
/// can wait with a deadline rather than block forever.
pub struct Attached {
    process: Child,
    lines: Receiver<String>,
}

impl Attached {
    fn open(data_dir: &Path, session: &str, argv: &[String]) -> Self {
        let mut command = Command::new(BINARY);
        command
            .args(["attach", "--session", session, "--data-dir"])
            .arg(data_dir);
        if !argv.is_empty() {
            command.arg("--cwd").arg(data_dir).arg("--").args(argv);
        }
        let mut process = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("attach");
        let stdout = process.stdout.take().expect("attach stdout");
        let (sender, lines) = channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    return;
                }
            }
        });
        Self { process, lines }
    }

    pub fn send(&mut self, frame: &str) {
        let stdin = self.process.stdin.as_mut().expect("attach stdin");
        writeln!(stdin, "{frame}").expect("write the frame");
        stdin.flush().expect("flush the frame");
    }

    fn next_line(&mut self) -> String {
        match self.lines.recv_timeout(TIMEOUT) {
            Ok(line) => line,
            Err(RecvTimeoutError::Timeout) => panic!("no output within {TIMEOUT:?}"),
            Err(RecvTimeoutError::Disconnected) => panic!("the attached client ended"),
        }
    }

    /// The next carried frame, unwrapped from its envelope.
    pub fn next_frame(&mut self) -> Value {
        self.next_event_of_type("frame")["f"].clone()
    }

    /// The next carried frame exactly as it crossed the socket, for checking
    /// that the runner did not rewrite it.
    pub fn next_raw_frame(&mut self) -> String {
        loop {
            let line = self.next_line();
            if !line.contains(r#""t":"frame""#) {
                continue;
            }
            let Some(start) = line.find(r#""f":"#) else {
                continue;
            };
            // The frame is the envelope's last field, so exactly one closing
            // brace belongs to the envelope. Trimming every trailing brace
            // would eat the frame's own.
            let body = &line[start + 4..];
            return body.strip_suffix('}').unwrap_or(body).to_string();
        }
    }

    /// The next carried frame the caller recognizes, skipping the rest.
    ///
    /// A live agent interleaves frames a test has no interest in, so waiting
    /// for a particular one has to be a filter rather than an assumption about
    /// ordering.
    pub fn next_frame_where(&mut self, wanted: impl Fn(&Value) -> bool) -> Value {
        loop {
            let frame = self.next_frame();
            if wanted(&frame) {
                return frame;
            }
        }
    }

    pub fn next_event_of_type(&mut self, kind: &str) -> Value {
        loop {
            let line = self.next_line();
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if value["t"] == kind {
                return value;
            }
        }
    }

    pub fn disconnect(mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

impl Drop for Attached {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

/// Whether a process is gone, polled rather than assumed so the result does not
/// depend on scheduling.
/// Whether this process is still running, answered at once.
pub fn is_running(pid: i32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

pub fn wait_for_process_exit(pid: i32) -> bool {
    let deadline = Instant::now() + TIMEOUT;
    while Instant::now() < deadline {
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !alive {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    false
}
