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

/// Whether an event is something the agent said, thought, or ran — as
/// opposed to what a person said or what the Task is doing.
pub fn is_agent_work(event: &Value) -> bool {
    matches!(
        event["type"].as_str(),
        Some("assistant_message" | "reasoning" | "tool_call" | "command_execution")
    )
}

/// A Task as it stands, in the terms the cases are written in.
#[derive(Debug, Clone)]
pub struct Reading {
    pub state: TurnState,
    pub turn_id: Option<String>,
    pub events: usize,
    /// Whether the conversation holds anything the agent said, thought, or
    /// ran — the agent having visibly begun, as opposed to the prompt having
    /// merely reached it.
    pub agent_begun: bool,
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
    /// Environment the backend — and through the runner, every agent — runs
    /// with. What lets a case break the world on purpose.
    environment: Vec<(String, String)>,
}

impl Backend {
    pub async fn start() -> Self {
        Self::start_with_environment(&[]).await
    }

    /// A backend whose agents cannot reach the API at all.
    ///
    /// The endpoint is a closed local port and the retry budget is one, so a
    /// turn fails within seconds, no model is ever reached, and the case
    /// spends nothing.
    pub async fn start_with_unreachable_api() -> Self {
        Self::start_with_environment(&[
            ("ANTHROPIC_BASE_URL", "http://127.0.0.1:9"),
            ("CLAUDE_CODE_MAX_RETRIES", "1"),
        ])
        .await
    }

    async fn start_with_environment(environment: &[(&str, &str)]) -> Self {
        // Short on purpose. The runner's socket lives inside the data
        // directory, and a unix socket path must stay short of 104 bytes on
        // macOS — which the usual temporary directory very nearly spends by
        // itself.
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
            environment: environment
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect(),
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
            .envs(self.environment.iter().map(|(name, value)| (name, value)))
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

    /// Create the valid empty Task that exists before its first prompt.
    pub async fn create_empty_task(&self, title_source: &str, model: &str) -> Task {
        self.create_empty(title_source, model, "bypassPermissions")
            .await
    }

    async fn create(&self, prompt: &str, model: &str, permission_mode: &str) -> Task {
        let task = self.create_empty(prompt, model, permission_mode).await;
        task.say_with_options(prompt, model, permission_mode).await;
        task
    }

    async fn create_empty(&self, title_source: &str, model: &str, permission_mode: &str) -> Task {
        let created = self
            .post(
                "/api/tasks",
                json!({
                    "titleSource": title_source,
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

    /// Turn the notes directory into a Git repository with one commit, so a
    /// Task working there has something a worktree can be prepared from.
    pub fn make_notes_a_repository(&self) {
        let notes = self.root.join("notes");
        let git = |args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(&notes)
                .output()
                .expect("git runs");
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init", "--initial-branch=main"]);
        git(&["add", "."]);
        git(&[
            "-c",
            "user.email=caffold@live",
            "-c",
            "user.name=Caffold Live",
            "commit",
            "-m",
            "notes",
        ]);
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
    /// The turn the message belongs to, as the backend named it in its answer.
    pub turn_id: String,
    /// The identity the backend gave the message itself.
    pub user_message_id: String,
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
                agent_begun: false,
            };
        };
        let task = &body["task"];
        if task.is_null() {
            return Reading {
                state: TurnState::Unknown,
                turn_id: None,
                events: 0,
                agent_begun: false,
            };
        }
        let state = match task["threadStatus"]["type"].as_str() {
            Some("active") => TurnState::Running,
            Some("idle") => TurnState::Idle,
            _ => TurnState::Unknown,
        };
        let events = body["events"].as_array();
        Reading {
            state,
            turn_id: task["activeTurn"]["id"].as_str().map(str::to_string),
            events: events.map(Vec::len).unwrap_or_default(),
            agent_begun: events.is_some_and(|events| events.iter().any(is_agent_work)),
        }
    }

    pub async fn wait_for(&self, wanted: TurnState, within: Duration) -> Reading {
        self.wait_until(within, &format!("as {wanted:?}"), |reading| {
            reading.state == wanted
        })
        .await
    }

    /// Poll the Task at the rate a person clicking would, until it reads as
    /// the caller wants or the time is up.
    async fn wait_until(
        &self,
        within: Duration,
        wanted: &str,
        satisfied: impl Fn(&Reading) -> bool,
    ) -> Reading {
        poll_until(
            within,
            &format!("Task {} never read {wanted}", self.thread_id),
            async || Some(self.state().await),
            satisfied,
        )
        .await
    }

    /// Wait until the agent has visibly begun: something it said, thought, or
    /// ran stands in the turn. Reading as Running says only that the prompt
    /// reached the agent, which is before Claude has written the prompt to its
    /// transcript — too early for a case that takes the backend away and
    /// expects the replacement to find the turn there.
    pub async fn wait_for_work(&self, within: Duration) -> Reading {
        self.wait_until(within, "as the agent having begun", |reading| {
            reading.state == TurnState::Running && reading.turn_id.is_some() && reading.agent_begun
        })
        .await
    }

    /// Wait until the backend answers for this Task at all.
    ///
    /// A backend that has just started has not read its store yet, and a Task it
    /// cannot yet describe is not the same as one that is doing nothing — which
    /// is why [`TurnState::Unknown`] is its own answer rather than idle.
    pub async fn wait_until_known(&self, within: Duration) -> Reading {
        self.wait_until(within, "as anything at all", |reading| {
            reading.state != TurnState::Unknown
        })
        .await
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
        self.say_with_body(json!({ "prompt": text, "images": [] }))
            .await
    }

    pub async fn say_with_options(&self, text: &str, model: &str, permission_mode: &str) -> Said {
        self.say_with_body(json!({
            "prompt": text,
            "images": [],
            "model": model,
            "fastMode": false,
            "permissionMode": permission_mode,
        }))
        .await
    }

    async fn say_with_body(&self, body: Value) -> Said {
        let answer = self
            .at
            .post(&format!("/api/tasks/{}/prompts", self.thread_id), body)
            .await
            .expect("the message is accepted");
        Said {
            steered: answer["steered"].as_bool().unwrap_or(false),
            turn_id: answer["turnId"].as_str().unwrap_or_default().to_string(),
            user_message_id: answer["userMessageId"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
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

    /// The Task as the API answers it right now.
    pub async fn detail(&self) -> Value {
        self.at
            .get(&format!("/api/tasks/{}", self.thread_id))
            .await
            .expect("the task answers")
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
    /// `task-list-snapshot` channel event of one fresh connection, read and
    /// closed.
    ///
    /// This is what a person's list is drawn from — the cached rows only fill
    /// in until it arrives — so a case about what the list shows reads this
    /// rather than the store-backed `/api/tasks`.
    pub async fn list_rows(&self) -> Option<Vec<Value>> {
        use futures_util::StreamExt;

        let response = reqwest::Client::new()
            .get(self.url("/api/live"))
            .send()
            .await
            .ok()?;
        let mut stream = response.bytes_stream();
        let mut body = String::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        const READY: &str = "event: gateway-ready\ndata: ";
        let connection_id = loop {
            let chunk = match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(_) => return None,
                Err(_) if Instant::now() < deadline => continue,
                Err(_) => return None,
            };
            body.push_str(&String::from_utf8_lossy(&chunk));
            let Some(start) = body.find(READY) else {
                continue;
            };
            let Some(end) = body[start..].find("\n\n") else {
                continue;
            };
            let payload = &body[start + READY.len()..start + end];
            let ready: Value = serde_json::from_str(payload).ok()?;
            body.drain(..start + end + 2);
            break ready["connectionId"].as_str()?.to_string();
        };
        reqwest::Client::new()
            .put(self.url(&format!("/api/live/{connection_id}/subscriptions")))
            .header("origin", self.url(""))
            .header("content-type", "application/json")
            .body(
                json!({
                    "controlRevision": 1,
                    "taskList": { "generation": 1 },
                    "taskDetail": null,
                    "watches": [],
                })
                .to_string(),
            )
            .send()
            .await
            .ok()?
            .error_for_status()
            .ok()?;
        while Instant::now() < deadline {
            let chunk = match tokio::time::timeout(Duration::from_secs(5), stream.next()).await {
                Ok(Some(Ok(chunk))) => chunk,
                Ok(_) => return None,
                Err(_) => continue,
            };
            body.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(end) = body.find("\n\n") {
                let frame = body.drain(..end + 2).collect::<String>();
                let Some(payload) = frame.strip_prefix("event: live-update\ndata: ") else {
                    continue;
                };
                let parsed: Value = serde_json::from_str(payload.trim_end()).ok()?;
                if parsed["channel"] == "task-list" && parsed["type"] == "task-list-snapshot" {
                    return parsed["payload"]["tasks"].as_array().cloned();
                }
            }
        }
        None
    }
}

impl Backend {
    /// Poll fresh list snapshots until this Task's row stops wearing the
    /// given placeholder, and answer with the name it wears instead.
    pub async fn wait_past_placeholder_name(
        &self,
        thread_id: &str,
        placeholder: &str,
        within: Duration,
    ) -> String {
        let row = self
            .row_satisfying(
                thread_id,
                within,
                &format!("named past {placeholder:?}"),
                |row| {
                    row["title"]
                        .as_str()
                        .is_some_and(|title| !title.starts_with(placeholder))
                },
            )
            .await;
        row["title"].as_str().unwrap_or_default().to_string()
    }

    /// Poll fresh list snapshots until this Task's row wears the given name.
    pub async fn wait_for_task_name(&self, thread_id: &str, name: &str, within: Duration) -> Value {
        self.row_satisfying(thread_id, within, &format!("named {name:?}"), |row| {
            row["title"] == name
        })
        .await
    }

    /// Poll fresh list snapshots until this Task's row reads as wanted.
    pub async fn wait_for_list_row(
        &self,
        thread_id: &str,
        wanted: TurnState,
        within: Duration,
    ) -> Value {
        self.row_satisfying(thread_id, within, &format!("as {wanted:?}"), |row| {
            let state = match row["threadStatus"]["type"].as_str() {
                Some("active") => TurnState::Running,
                Some("idle") => TurnState::Idle,
                _ => TurnState::Unknown,
            };
            state == wanted
        })
        .await
    }

    /// Poll fresh list snapshots until this Task's row satisfies the caller.
    ///
    /// Each look is a new stream connection, which is what reopening the list
    /// does, so a row that never satisfies here is one a person never sees
    /// satisfied either.
    async fn row_satisfying(
        &self,
        thread_id: &str,
        within: Duration,
        wanted: &str,
        satisfied: impl Fn(&Value) -> bool,
    ) -> Value {
        poll_until(
            within,
            &format!("the list never showed Task {thread_id} {wanted}"),
            async || {
                self.at.list_rows().await.map(|rows| {
                    rows.iter()
                        .find(|row| row["threadId"] == thread_id)
                        .cloned()
                })
            },
            |row| row.as_ref().is_some_and(&satisfied),
        )
        .await
        .expect("a row that satisfied the caller was there")
    }
}

/// Poll at the rate a person clicking would, until what is fetched satisfies
/// the caller or the time is up. A fetch that answers nothing is a backend
/// not answering yet, which is neither.
async fn poll_until<T: std::fmt::Debug>(
    within: Duration,
    never: &str,
    mut fetch: impl AsyncFnMut() -> Option<T>,
    satisfied: impl Fn(&T) -> bool,
) -> T {
    let deadline = Instant::now() + within;
    let mut last = None;
    while Instant::now() < deadline {
        if let Some(value) = fetch().await {
            if satisfied(&value) {
                return value;
            }
            last = Some(value);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    panic!("{never}; last saw {last:?}");
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
