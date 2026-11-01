//! Opt-in official ACP checks through the shipped backend and HTTP surface.
//! Uses the local personal Google sign-in; never logs out or copies credentials.
//! The no-credentials case needs a separate macOS account: GEMINI_HOME does not
//! isolate the official agent from saved OS Keychain credentials.
use caffold_runner::{
    client::Client,
    protocol::{ReplyBody, Request},
};
use serde_json::{Value, json};
use std::{
    fs,
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

struct Backend {
    root: PathBuf,
    empty_native_home: bool,
    port: u16,
    child: Option<Child>,
    http: reqwest::Client,
}
impl Backend {
    async fn start() -> Self {
        Self::start_with_empty_home(false).await
    }
    async fn start_with_empty_home(empty_native_home: bool) -> Self {
        let root = tempfile::Builder::new()
            .prefix("ca-agy-")
            .tempdir_in("/tmp")
            .unwrap()
            .keep();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut owner = Self {
            root,
            empty_native_home,
            port,
            child: None,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .unwrap(),
        };
        owner.spawn().await;
        owner
    }
    async fn spawn(&mut self) {
        let log = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.root.join("backend.log"))
            .unwrap();
        let fake = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-codex");
        let mut command = Command::new(env!("CARGO_BIN_EXE_caffold"));
        if self.empty_native_home {
            command.env("GEMINI_HOME", self.root.join("empty-native-home"));
        }
        self.child = Some(
            command
                .args(["serve", "--host", "127.0.0.1", "--port"])
                .arg(self.port.to_string())
                .arg("--root")
                .arg(&self.root)
                .arg("--data-dir")
                .arg(self.root.join("data"))
                .arg("--worktree-root")
                .arg(self.root.join("worktrees"))
                .env("CAFFOLD_CODEX_BIN", fake)
                .env("CAFFOLD_LATEST_RELEASE_URL", "http://127.0.0.1:9/")
                .stdin(Stdio::null())
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(response) = self
                .http
                .get(self.url("/api/task-store/status"))
                .send()
                .await
            {
                let status: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
                if status["state"] == "ready" {
                    break;
                }
                assert_ne!(status["state"], "failed", "{status}");
            }
            assert!(
                Instant::now() < deadline,
                "backend did not start; {}",
                self.root.display()
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    async fn replace(&mut self) {
        let mut child = self.child.take().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        self.spawn().await;
    }
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
    async fn request(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Value {
        let mut request = self.http.request(method, self.url(path));
        if let Some(body) = body {
            request = request
                .header("content-type", "application/json")
                .body(body.to_string());
        }
        let response = request.send().await.unwrap();
        let status = response.status();
        let text = response.text().await.unwrap();
        assert!(status.is_success(), "{path}: {status} {text}");
        serde_json::from_str(&text).unwrap()
    }
    async fn get(&self, path: &str) -> Value {
        self.request(reqwest::Method::GET, path, None).await
    }
    async fn post(&self, path: &str, body: Value) -> Value {
        self.request(reqwest::Method::POST, path, Some(body)).await
    }
    async fn install(&self) {
        self.post("/api/antigravity/install", json!({})).await;
        let deadline = Instant::now() + Duration::from_secs(650);
        loop {
            let status = self.get("/api/antigravity/status").await;
            if status["installation"]["phase"] == "idle" {
                assert_eq!(status["installation"]["installed"], true, "{status}");
                break;
            }
            assert!(Instant::now() < deadline, "{status}");
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }

    async fn create(&self) -> String {
        let models = self.get("/api/agent/models").await;
        let model = models["models"]
            .as_array()
            .unwrap()
            .iter()
            .find(|model| model["provider"] == "antigravity" && model["isDefault"] == true)
            .unwrap();
        let created=self.post("/api/tasks",json!({"provider":"antigravity","cwd":".","titleSource":"ACP live check","model":model["model"],"effort":"low","permissionMode":"default"})).await;
        assert!(created["detail"].get("inputOperation").is_none());
        assert_eq!(created["detail"]["supportsSteering"], false);
        created["detail"]["threadId"].as_str().unwrap().into()
    }
    async fn erase(&self, task: &str) {
        self.post(&format!("/api/tasks/{task}/archive"), json!({}))
            .await;
        self.request(reqwest::Method::DELETE, &format!("/api/tasks/{task}"), None)
            .await;
    }
    fn runner(&self, args: &[&str]) {
        let binary = PathBuf::from(env!("CARGO_BIN_EXE_caffold")).with_file_name("caffold-runner");
        let _ = Command::new(binary)
            .args(args)
            .arg("--socket")
            .arg(self.root.join("data/antigravity/runner.sock"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
impl Drop for Backend {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.runner(&["daemon", "stop"]);
        eprintln!(
            "ACP live evidence and any retained bindings: {}",
            self.root.display()
        );
    }
}

#[tokio::test]
#[ignore = "official macOS arm64 ACP download and cached personal Google sign-in; zero model prompts"]
async fn official_install_auth_catalog_and_empty_task_lifecycle() {
    let mut backend = Backend::start().await;
    backend.install().await;
    let http = backend.http.clone();
    let url = backend.url("/api/antigravity/refresh");
    let refresh = tokio::spawn(async move { http.post(url).send().await.unwrap() });
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if backend.get("/api/antigravity/status").await["refreshing"] == true {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "refresh was not observed running"
        );
        tokio::task::yield_now().await;
    }
    for path in [
        "/api/antigravity/refresh",
        "/api/antigravity/auth/login",
        "/api/antigravity/restart",
    ] {
        let rejected = backend.http.post(backend.url(path)).send().await.unwrap();
        assert_eq!(rejected.status(), reqwest::StatusCode::CONFLICT);
    }
    let response = refresh.await.unwrap();
    assert!(response.status().is_success());
    let status: Value = serde_json::from_str(&response.text().await.unwrap()).unwrap();
    assert_eq!(
        status["auth"]["verified"]["authenticated"], true,
        "{status}"
    );
    assert_eq!(status["modelsAvailable"], true, "{status}");

    let usage = backend.get("/api/antigravity/status").await;
    assert!(
        usage["usage"]["error"].is_null(),
        "native quota read failed"
    );
    let windows = usage["usage"]["windows"].as_array().unwrap();
    assert!(!windows.is_empty());
    for window in windows {
        let percent = window["percent"].as_f64().unwrap();
        assert!((0.0..=100.0).contains(&percent));
        chrono::DateTime::parse_from_rfc3339(window["resetsAt"].as_str().unwrap()).unwrap();
    }
    assert_eq!(usage["refreshing"], false);
    assert!(usage["auth"]["requestId"].is_null());
    assert!(usage["auth"]["authorizationUrl"].is_null());
    let bindings = backend.root.join("data/antigravity/bindings");
    assert_eq!(
        fs::read_dir(bindings).unwrap().count(),
        0,
        "probes leave no bindings"
    );
    let mut runner = Client::connect(&backend.root.join("data/antigravity/runner.sock"))
        .await
        .unwrap();
    let response = runner.request(Request::SessionList).await.unwrap();
    let ReplyBody::Sessions { sessions } = response else {
        panic!("runner did not report its children");
    };
    assert!(
        sessions.is_empty(),
        "refresh must close and remove its native child"
    );
    let task = backend.create().await;
    let empty = backend.get(&format!("/api/tasks/{task}")).await;
    assert_eq!(empty["events"], json!([]));
    assert_eq!(empty["task"]["threadStatus"]["type"], "idle");
    let binding_file = backend
        .root
        .join("data/antigravity/bindings")
        .join(format!("{task}.json"));
    let binding = fs::read(&binding_file).unwrap();
    let before = backend.get("/api/antigravity/status").await;
    assert_eq!(before["runtime"]["running"], true);
    assert_eq!(before["runtime"]["sessions"], 1);
    let other_socket = backend.root.join("other-runner.sock");
    let runner_binary =
        PathBuf::from(env!("CARGO_BIN_EXE_caffold")).with_file_name("caffold-runner");
    assert!(
        Command::new(&runner_binary)
            .args(["daemon", "start", "--socket"])
            .arg(&other_socket)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
    let mut other = Client::connect(&other_socket).await.unwrap();
    let ReplyBody::Daemon(other_before) = other.request(Request::DaemonStatus).await.unwrap()
    else {
        panic!("other runner missing")
    };
    let restarted = backend.post("/api/antigravity/restart", json!({})).await;
    let ReplyBody::Daemon(other_after) = other.request(Request::DaemonStatus).await.unwrap() else {
        panic!("other runner was replaced")
    };
    assert_eq!(
        other_before.pid, other_after.pid,
        "only the AGY instance may restart"
    );
    other.request(Request::DaemonStop).await.unwrap();
    assert_eq!(restarted["runtime"]["running"], true);
    assert_eq!(restarted["runtime"]["restarting"], false);
    assert_ne!(restarted["runtime"]["pid"], before["runtime"]["pid"]);
    assert_eq!(restarted["runtime"]["sessions"], 0);
    assert_eq!(
        restarted["auth"], before["auth"],
        "restart must retain verified sign-in"
    );
    assert_eq!(restarted["usage"], before["usage"]);
    assert_eq!(fs::read(&binding_file).unwrap(), binding);
    let passive = backend.get("/api/antigravity/status").await;
    assert_eq!(
        passive["runtime"]["sessions"], 0,
        "passive reads must not reopen tasks"
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    let reopened = loop {
        let detail = backend.get(&format!("/api/tasks/{task}")).await;
        if detail["task"]["threadStatus"]["type"] == "idle" {
            break detail;
        }
        assert!(
            Instant::now() < deadline,
            "the Task did not reopen: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    assert_eq!(reopened["threadId"], task);
    assert_eq!(reopened["events"], json!([]));
    assert_eq!(
        fs::read(&binding_file).unwrap(),
        binding,
        "same native conversation reopens"
    );
    assert_eq!(
        backend.get("/api/antigravity/status").await["runtime"]["sessions"],
        1
    );
    backend
        .post(&format!("/api/tasks/{task}/archive"), json!({}))
        .await;
    backend.replace().await;
    backend
        .post(&format!("/api/tasks/{task}/restore"), json!({}))
        .await;
    let reopened = backend.get(&format!("/api/tasks/{task}")).await;
    assert_eq!(reopened["threadId"], task);
    assert_eq!(reopened["events"], json!([]));
    backend.erase(&task).await;
    assert!(
        !backend
            .root
            .join("data/antigravity/bindings")
            .join(format!("{task}.json"))
            .exists()
    );
}

#[tokio::test]
#[ignore = "official ACP on a dedicated macOS account without saved ACP Keychain credentials; zero model prompts"]
async fn native_sign_in_required_without_saved_os_credentials() {
    let backend = Backend::start_with_empty_home(true).await;
    backend.install().await;
    let status = backend.post("/api/antigravity/refresh", json!({})).await;
    assert_eq!(status["auth"]["phase"], "idle");
    assert_eq!(
        status["auth"]["verified"]["authenticated"], false,
        "{status}"
    );
    assert!(status["auth"]["requestId"].is_null());
    assert!(status["auth"]["authorizationUrl"].is_null());
    assert_eq!(status["refreshing"], false);
    assert_eq!(status["modelsAvailable"], false);
    assert!(
        status["usage"]["error"]
            .as_str()
            .unwrap()
            .contains("Sign in")
    );
    let bindings = backend.root.join("data/antigravity/bindings");
    assert!(!bindings.exists() || fs::read_dir(&bindings).unwrap().count() == 0);

    backend.post("/api/antigravity/auth/login", json!({})).await;
    let deadline = Instant::now() + Duration::from_secs(60);
    let id = loop {
        let status = backend.get("/api/antigravity/status").await;
        if status["auth"]["phase"] == "awaitingCallback" {
            assert!(
                status["auth"]["authorizationUrl"]
                    .as_str()
                    .unwrap()
                    .starts_with("https://accounts.google.com/")
            );
            break status["auth"]["requestId"].clone();
        }
        assert!(
            Instant::now() < deadline,
            "explicit sign-in did not offer a handoff"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    let busy = backend
        .http
        .post(backend.url("/api/antigravity/refresh"))
        .send()
        .await
        .unwrap();
    assert_eq!(busy.status(), reqwest::StatusCode::CONFLICT);
    backend
        .post("/api/antigravity/auth/cancel", json!({"requestId":id}))
        .await;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let status = backend.get("/api/antigravity/status").await;
        if status["auth"]["phase"] == "idle" {
            assert!(status["auth"]["authorizationUrl"].is_null());
            break;
        }
        assert!(
            Instant::now() < deadline,
            "sign-in cancellation did not finish"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
#[ignore = "official ACP and cached Google sign-in; one short model prompt"]
async fn native_prompt_permission_survives_display_reconstruction() {
    let mut backend = Backend::start().await;
    backend.install().await;
    let status = backend.post("/api/antigravity/refresh", json!({})).await;
    assert_eq!(
        status["auth"]["verified"]["authenticated"], true,
        "{status}"
    );
    assert_eq!(status["modelsAvailable"], true, "{status}");
    let task = backend.create().await;
    let receipt=backend.post(&format!("/api/tasks/{task}/prompts"),json!({"prompt":"Use the Caffold rename_current_task tool to name this Task ACP live check. Then run pwd once and finish in one brief sentence. Do not edit files or browse the web.","effort":"low","permissionMode":"default"})).await;
    let display_turn = receipt["turnId"].as_str().unwrap();
    assert!(display_turn.starts_with("acp:"));
    assert_eq!(receipt["userMessageId"], format!("{display_turn}:prompt"));
    assert!(receipt.get("receipt").is_none());
    let deadline = Instant::now() + Duration::from_secs(90);
    let (approval, initial_context) = loop {
        let detail = backend.get(&format!("/api/tasks/{task}")).await;
        if let Some(approval) = detail["pendingApprovals"]
            .as_array()
            .and_then(|values| values.first())
            && detail["context"]["usedTokens"]
                .as_u64()
                .is_some_and(|used| used > 0)
        {
            break (approval.clone(), detail["context"].clone());
        }
        assert!(
            Instant::now() < deadline,
            "native permission did not arrive: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(approval["payload"]["turnId"], display_turn);
    assert!(
        approval["payload"]["itemId"]
            .as_str()
            .unwrap()
            .starts_with(display_turn)
    );
    let id = approval["payload"]["approvalId"].as_str().unwrap();
    backend.replace().await;
    let deadline = Instant::now() + Duration::from_secs(30);
    let recovered = loop {
        let detail = backend.get(&format!("/api/tasks/{task}")).await;
        if detail["context"] == initial_context {
            break detail;
        }
        assert!(
            Instant::now() < deadline,
            "active context did not recover: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert!(
        recovered["events"]
            .as_array()
            .unwrap()
            .iter()
            .all(|event| event["payload"]["turnId"] != display_turn)
    );
    let account = backend.get("/api/antigravity/status").await;
    assert_eq!(account["auth"]["verified"]["authenticated"], true);
    let waiting = recovered["pendingApprovals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["payload"]["approvalId"] == id)
        .expect("the waiting permission survives the replacement");
    let continued = waiting["payload"]["turnId"].as_str().unwrap().to_string();
    assert!(
        continued.starts_with("acp:") && continued != display_turn,
        "the running prompt continues in a new display turn: {waiting}"
    );
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail = backend.get(&format!("/api/tasks/{task}")).await;
        if detail["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "turn_started" && event["payload"]["turnId"] == continued)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "the continued turn did not appear: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    backend
        .post(
            &format!("/api/tasks/{task}/approvals/{id}"),
            json!({"decision":"allow"}),
        )
        .await;
    let deadline = Instant::now() + Duration::from_secs(90);
    let final_detail = loop {
        let detail = backend.get(&format!("/api/tasks/{task}")).await;
        for approval in detail["pendingApprovals"].as_array().unwrap() {
            let id = approval["payload"]["approvalId"].as_str().unwrap();
            backend
                .post(
                    &format!("/api/tasks/{task}/approvals/{id}"),
                    json!({"decision":"allow"}),
                )
                .await;
        }
        if detail["task"]["threadStatus"]["type"] == "idle"
            && detail["task"]["latestTurnStatus"] == "completed"
        {
            break detail;
        }
        assert!(
            Instant::now() < deadline,
            "native prompt did not finish: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    };
    let final_events = final_detail["events"].as_array().unwrap();
    let frozen = final_events
        .iter()
        .find(|event| {
            event["type"] == "user_message"
                && event["payload"]["itemId"]
                    .as_str()
                    .is_some_and(|id| id.contains(':'))
        })
        .expect("the prompt stays in its native turn")["payload"]["turnId"]
        .clone();
    for turn in [json!(continued), frozen] {
        assert!(
            final_events.iter().any(
                |event| event["type"] == "turn_completed" && event["payload"]["turnId"] == turn
            ),
            "turn {turn} ends: {final_detail}"
        );
    }
    let completed_context = final_detail["context"].clone();
    assert!(
        completed_context["usedTokens"].as_u64().unwrap()
            > initial_context["usedTokens"].as_u64().unwrap(),
        "recovered turn must accept later context reports"
    );
    assert_eq!(
        completed_context["windowTokens"],
        initial_context["windowTokens"]
    );
    backend.replace().await;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let detail = backend.get(&format!("/api/tasks/{task}")).await;
        if detail["context"] == completed_context {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "idle context did not recover: {detail}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    eprintln!(
        "context before active restart: {initial_context}; after recovered completion and idle restart: {completed_context}"
    );
    backend.erase(&task).await;
}
