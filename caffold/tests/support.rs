//! Setup and transport for the live Claude cases.
//!
//! This module starts backends and carries requests. It decides nothing about
//! whether Caffold behaved correctly — every such judgement belongs to the case
//! that made it, so the contract reads in one place. A failure here means the
//! setup could not be carried out, and is raised as a panic to keep it
//! distinguishable from an assertion about behaviour.
//!
//! Everything goes through the shipped binary and its HTTP surface rather than
//! the crate's own types. That is what makes a restart a real one — the process
//! is replaced, exactly as it is when the application updates — and it means a
//! failing case can be repeated by hand with `curl`.

#![allow(dead_code)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const BINARY: &str = env!("CARGO_BIN_EXE_caffold");

/// Long enough for a process to start on a loaded machine, short enough that a
/// backend that never comes up fails the run instead of stalling it.
const STARTUP: Duration = Duration::from_secs(30);

static COUNTER: AtomicU32 = AtomicU32::new(0);

/// What a Task is doing, as a person reading the screen would say it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    /// Nothing is outstanding.
    Idle,
    /// The agent is working on something.
    Running,
    /// The backend has not answered for this Task yet.
    Unknown,
}

/// A Task as it stands, in the terms the cases are written in.
#[derive(Debug, Clone)]
pub struct Reading {
    pub state: TurnState,
    pub turn_id: Option<String>,
    pub events: usize,
}

/// Where a backend answers. Copied rather than borrowed so that a Task can
/// outlive the process it was created against, which is what every case here
/// does.
#[derive(Debug, Clone, Copy)]
pub struct Http {
    port: u16,
}

/// One backend, its data, and the runner underneath it.
pub struct Backend {
    root: PathBuf,
    at: Http,
    process: Option<Child>,
}

impl Backend {
    pub async fn start() -> Self {
        // Short on purpose. The runner's socket lives inside the data
        // directory, and a unix socket path may not exceed 104 bytes on macOS —
        // which the usual temporary directory very nearly spends by itself.
        let root = PathBuf::from(format!(
            "/tmp/cf-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(root.join("notes")).expect("a root to work in");
        for (name, body) in [
            ("one.txt", "the first note"),
            ("two.txt", "the second note"),
            ("three.txt", "the third note"),
        ] {
            std::fs::write(root.join("notes").join(name), body).expect("a file to read");
        }
        let port =
            5300 + (std::process::id() as u16 % 200) + COUNTER.load(Ordering::Relaxed) as u16;
        let mut backend = Self {
            root,
            at: Http { port },
            process: None,
        };
        backend.spawn().await;
        backend
    }

    /// Replace the backend, leaving the runner and every agent under it alone.
    ///
    /// The whole point of the cases that use it: this is what an application
    /// update does, and the agent should not notice.
    ///
    /// The old process is waited for rather than merely asked to stop. It holds
    /// a lock on the Task store until it is really gone, and a replacement that
    /// started before that would come up unable to read a single Task.
    pub async fn replace(&mut self) {
        if let Some(mut old) = self.process.take() {
            let _ = old.kill();
            let _ = old.wait();
        }
        wait_until_gone(self.at.port).await;
        self.spawn().await;
    }

    async fn spawn(&mut self) {
        let process = Command::new(BINARY)
            .args(["serve", "--host", "127.0.0.1", "--port"])
            .arg(self.at.port.to_string())
            .arg("--root")
            .arg(&self.root)
            .arg("--data-dir")
            .arg(self.root.join("data"))
            .arg("--worktree-root")
            .arg(self.root.join("data/worktrees"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("start the backend");
        self.process = Some(process);
        let deadline = Instant::now() + STARTUP;
        while Instant::now() < deadline {
            if self.get("/api/tasks").await.is_some() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        panic!("the backend never began answering on port {}", self.at.port);
    }

    pub async fn get(&self, path: &str) -> Option<Value> {
        self.at.get(path).await
    }

    pub async fn post(&self, path: &str, body: Value) -> Option<Value> {
        self.at.post(path, body).await
    }
}

impl Http {
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }

    pub async fn get(&self, path: &str) -> Option<Value> {
        let response = reqwest::Client::new()
            .get(self.url(path))
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .ok()?;
        serde_json::from_str(&response.text().await.ok()?).ok()
    }

    pub async fn post(&self, path: &str, body: Value) -> Option<Value> {
        let response = reqwest::Client::new()
            .post(self.url(path))
            .header("content-type", "application/json")
            .body(body.to_string())
            .timeout(Duration::from_secs(120))
            .send()
            .await
            .ok()?;
        serde_json::from_str(&response.text().await.ok()?).ok()
    }
}

impl Backend {
    /// Start a Task that will not be stopped for permission.
    pub async fn start_task(&self, prompt: &str, model: &str) -> Task {
        self.create(prompt, model, "bypassPermissions").await
    }

    /// Start a Task that will be stopped for permission before it changes
    /// anything.
    pub async fn start_task_asking_permission(&self, prompt: &str, model: &str) -> Task {
        self.create(prompt, model, "default").await
    }

    async fn create(&self, prompt: &str, model: &str, permission_mode: &str) -> Task {
        let created = self
            .post(
                "/api/tasks",
                json!({
                    "prompt": prompt,
                    "cwd": "notes",
                    "provider": "claude",
                    "model": model,
                    "permissionMode": permission_mode,
                }),
            )
            .await
            .expect("the Task is created");
        let thread_id = created["threadId"]
            .as_str()
            .unwrap_or_else(|| panic!("a created Task is named: {created}"))
            .to_string();
        Task {
            at: self.at,
            thread_id,
        }
    }

    /// The `claude` process the runner is holding for the one live session.
    pub async fn agent_process(&self) -> i32 {
        let listed = self.runner(&["session", "list"]);
        listed["sessions"][0]["pid"]
            .as_i64()
            .unwrap_or_else(|| panic!("the runner is holding a session: {listed}")) as i32
    }

    /// Kill the runner the way a crash does, without letting it tidy up.
    ///
    /// Waited out by asking whether it still answers rather than whether its
    /// number is still taken. The runner is a child of the backend, which does
    /// not reap it, so a killed runner stays a zombie — and a zombie still
    /// answers `kill -0` for as long as its parent lives.
    pub async fn kill_runner_outright(&self) {
        let status = self.runner(&["daemon", "status"]);
        let pid = status["pid"]
            .as_i64()
            .unwrap_or_else(|| panic!("the runner reports itself: {status}"));
        Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .expect("kill the runner");
        let deadline = Instant::now() + STARTUP;
        while Instant::now() < deadline {
            if !self.runner_is_answering() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("the runner went on answering after it was killed");
    }

    fn runner_is_answering(&self) -> bool {
        Command::new(self.runner_binary())
            .args(["daemon", "status", "--data-dir"])
            .arg(self.root.join("data"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn runner_binary(&self) -> PathBuf {
        PathBuf::from(BINARY)
            .parent()
            .expect("the binary lives somewhere")
            .join("caffold-claude-runner")
    }

    fn runner(&self, arguments: &[&str]) -> Value {
        let output = Command::new(self.runner_binary())
            .args(arguments)
            .arg("--data-dir")
            .arg(self.root.join("data"))
            .output()
            .expect("ask the runner");
        serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "expected JSON from the runner {arguments:?}: {error}; {}",
                String::from_utf8_lossy(&output.stderr)
            )
        })
    }
}

impl Drop for Backend {
    fn drop(&mut self) {
        Command::new("pkill")
            .args([
                "-f",
                &format!("caffold serve --host 127.0.0.1 --port {}", self.at.port),
            ])
            .status()
            .ok();
        Command::new(self.runner_binary())
            .args(["daemon", "stop", "--data-dir"])
            .arg(self.root.join("data"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .ok();
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// What a Task answered when it was asked to do something.
#[derive(Debug, Clone)]
pub struct Said {
    /// Whether the message joined a turn already running rather than opening
    /// one of its own.
    pub steered: bool,
}

pub struct Task {
    at: Http,
    thread_id: String,
}

impl Task {
    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }
}

impl Task {
    pub async fn state(&self) -> Reading {
        let Some(body) = self.at.get(&format!("/api/tasks/{}", self.thread_id)).await else {
            return Reading {
                state: TurnState::Unknown,
                turn_id: None,
                events: 0,
            };
        };
        let task = &body["task"];
        if task.is_null() {
            return Reading {
                state: TurnState::Unknown,
                turn_id: None,
                events: 0,
            };
        }
        let state = match task["threadStatus"]["type"].as_str() {
            Some("active") => TurnState::Running,
            Some("idle") => TurnState::Idle,
            _ => TurnState::Unknown,
        };
        Reading {
            state,
            turn_id: task["activeTurn"]["id"].as_str().map(str::to_string),
            events: body["events"].as_array().map(Vec::len).unwrap_or_default(),
        }
    }

    pub async fn wait_for(&self, wanted: TurnState, within: Duration) -> Reading {
        let deadline = Instant::now() + within;
        let mut last = None;
        while Instant::now() < deadline {
            let reading = self.state().await;
            if reading.state == wanted {
                return reading;
            }
            last = Some(reading);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!(
            "Task {} never read as {wanted:?}; last saw {last:?}",
            self.thread_id
        );
    }

    /// Wait until the backend answers for this Task at all.
    ///
    /// A backend that has just started has not read its store yet, and a Task it
    /// cannot yet describe is not the same as one that is doing nothing — which
    /// is why [`TurnState::Unknown`] is its own answer rather than idle.
    pub async fn wait_until_known(&self, within: Duration) -> Reading {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            let reading = self.state().await;
            if reading.state != TurnState::Unknown {
                return reading;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        panic!(
            "Task {} was never described at all; it answered {}",
            self.thread_id,
            self.raw().await,
        );
    }

    /// What the conversation records, in one line, for when a case fails
    /// because the agent did something other than what it was asked.
    pub async fn what_happened(&self) -> String {
        let Some(body) = self.at.get(&format!("/api/tasks/{}", self.thread_id)).await else {
            return "nothing that could be read".to_string();
        };
        body["events"]
            .as_array()
            .map(|events| {
                events
                    .iter()
                    .map(|event| {
                        format!(
                            "{}({})",
                            event["type"].as_str().unwrap_or("?"),
                            event["summary"].as_str().unwrap_or_default()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default()
    }

    /// What the backend actually said, for when a case fails on a shape rather
    /// than on behaviour.
    pub async fn raw(&self) -> String {
        match self.at.get(&format!("/api/tasks/{}", self.thread_id)).await {
            Some(body) => body.to_string().chars().take(600).collect(),
            None => "nothing that could be read".to_string(),
        }
    }

    /// Every reading over a stretch of time, at the rate a person clicking
    /// would produce.
    pub async fn watch_for(&self, span: Duration) -> Vec<TurnState> {
        let deadline = Instant::now() + span;
        let mut seen = Vec::new();
        while Instant::now() < deadline {
            seen.push(self.state().await.state);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        seen
    }

    pub async fn say(&self, text: &str) -> Said {
        let answer = self
            .at
            .post(
                &format!("/api/tasks/{}/prompts", self.thread_id),
                json!({ "prompt": text, "images": [] }),
            )
            .await
            .expect("the message is accepted");
        Said {
            steered: answer["steered"].as_bool().unwrap_or(false),
        }
    }

    /// The identity of a question the agent is held up by, once it asks one.
    pub async fn wait_for_a_question(&self, within: Duration) -> String {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if let Some(body) = self.at.get(&format!("/api/tasks/{}", self.thread_id)).await
                && let Some(asked) = body["pendingApprovals"][0]["payload"]["approvalId"].as_str()
            {
                return asked.to_string();
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!(
            "Task {} was never held up by a question; it did {}",
            self.thread_id,
            self.what_happened().await,
        );
    }

    pub async fn answer(&self, question: &str, decision: &str) {
        self.at
            .post(
                &format!("/api/tasks/{}/approvals/{question}", self.thread_id),
                json!({ "decision": decision }),
            )
            .await
            .expect("the question is answered");
    }

    /// Whether the conversation has recorded an answer to a question, once one
    /// is recorded or the wait runs out.
    pub async fn answered_a_question_within(&self, within: Duration) -> bool {
        let deadline = Instant::now() + within;
        while Instant::now() < deadline {
            if let Some(body) = self.at.get(&format!("/api/tasks/{}", self.thread_id)).await
                && body["events"].as_array().is_some_and(|events| {
                    events
                        .iter()
                        .any(|event| event["type"] == "approval_resolved")
                })
            {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        false
    }
}

impl Http {
    /// The rows of the list as the stream first paints them: the
    /// `task-list-snapshot` frame of one fresh connection, read and closed.
    ///
    /// This is what a person's list is drawn from — the cached rows only fill
    /// in until it arrives — so a case about what the list shows reads this
    /// rather than the store-backed `/api/tasks`.
    pub async fn list_rows(&self) -> Option<Vec<Value>> {
        use futures_util::StreamExt;

        let response = reqwest::Client::new()
            .get(self.url("/api/tasks/stream"))
            .send()
            .await
            .ok()?;
        let mut stream = response.bytes_stream();
        let mut body = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        const FRAME: &str = "event: task-list-snapshot\ndata: ";
        while Instant::now() < deadline {
            let chunk = match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(_) => return None,
                Err(_) => continue,
            };
            body.push_str(&String::from_utf8_lossy(&chunk));
            if let Some(start) = body.find(FRAME)
                && let Some(end) = body[start..].find("\n\n")
            {
                let payload = &body[start + FRAME.len()..start + end];
                let parsed: Value = serde_json::from_str(payload).ok()?;
                return parsed["tasks"].as_array().cloned();
            }
        }
        None
    }
}

impl Backend {
    /// Poll fresh list snapshots until this Task's row reads as wanted.
    ///
    /// Each look is a new stream connection, which is what reopening the list
    /// does, so a row that never satisfies here is one a person never sees
    /// satisfied either.
    pub async fn wait_for_list_row(
        &self,
        thread_id: &str,
        wanted: TurnState,
        within: Duration,
    ) -> Value {
        let deadline = Instant::now() + within;
        let mut last = None;
        while Instant::now() < deadline {
            if let Some(rows) = self.at.list_rows().await {
                let row = rows
                    .iter()
                    .find(|row| row["threadId"] == thread_id)
                    .cloned();
                if let Some(row) = &row {
                    let state = match row["threadStatus"]["type"].as_str() {
                        Some("active") => TurnState::Running,
                        Some("idle") => TurnState::Idle,
                        _ => TurnState::Unknown,
                    };
                    if state == wanted {
                        return row.clone();
                    }
                }
                last = Some(row);
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        panic!(
            "the list never showed Task {thread_id} as {wanted:?}; \
             the last snapshot had {last:?}"
        );
    }
}

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
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if !is_running(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

async fn wait_until_gone(port: u16) {
    let deadline = Instant::now() + STARTUP;
    while Instant::now() < deadline {
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("the backend on port {port} never let go of it");
}
