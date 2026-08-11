use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    task::{Context as TaskContext, Poll},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{sleep, timeout},
};
use tokio_tungstenite::{WebSocketStream, client_async, tungstenite::Message};

use super::{
    CodexPermissionMode, CodexTurnOptions, NORMAL_SERVICE_TIER_ID,
    protocol::{
        INITIALIZE, INITIALIZED, RENAME_CURRENT_THREAD_TOOL_NAME, THREAD_ARCHIVE, THREAD_NAME_SET,
        THREAD_READ, THREAD_RESUME, THREAD_START, TURN_INTERRUPT, TURN_START,
        thread_archive_params, thread_read_params, thread_resume_params, thread_set_name_params,
        thread_start_params, turn_interrupt_params, turn_start_params,
    },
    resolve_codex_executable,
};

const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const TURN_TIMEOUT: Duration = Duration::from_secs(90);
const SPIKE_MODEL: &str = "gpt-5.3-codex-spark";

struct SocketAppServer {
    child: Child,
    socket_path: PathBuf,
    _temp: tempfile::TempDir,
}

impl SocketAppServer {
    async fn start() -> Result<Self> {
        let temp = tempfile::Builder::new()
            .prefix("caffold-reconnect-")
            .tempdir_in("/tmp")
            .context("create temporary app-server directory")?;
        let socket_path = temp.path().join("app-server.sock");
        let listen = format!("unix://{}", socket_path.display());
        let mut child = Command::new(resolve_codex_executable()?)
            .arg("app-server")
            .arg("--listen")
            .arg(&listen)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .with_context(|| format!("start Codex app-server at {listen}"))?;

        for _ in 0..200 {
            if socket_path.exists() {
                eprintln!("SPIKE app_server_socket={}", socket_path.display());
                return Ok(Self {
                    child,
                    socket_path,
                    _temp: temp,
                });
            }
            if let Some(status) = child.try_wait().context("poll Codex app-server")? {
                bail!("Codex app-server exited before opening its socket: {status}");
            }
            sleep(Duration::from_millis(25)).await;
        }

        bail!(
            "Codex app-server did not open {} within 5 seconds",
            socket_path.display()
        )
    }

    async fn stop(&mut self) {
        let _ = self.child.start_kill();
        let _ = timeout(Duration::from_secs(2), self.child.wait()).await;
    }
}

struct RpcClient {
    socket: WebSocketStream<ProxyStream>,
    _proxy_child: Child,
    buffered: VecDeque<Value>,
    next_id: u64,
}

struct ProxyStream {
    reader: ChildStdout,
    writer: ChildStdin,
}

impl AsyncRead for ProxyStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.reader).poll_read(cx, buffer)
    }
}

impl AsyncWrite for ProxyStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.writer).poll_write(cx, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.writer).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.writer).poll_shutdown(cx)
    }
}

impl RpcClient {
    async fn connect(socket_path: &Path) -> Result<Self> {
        let mut proxy_child = Command::new(resolve_codex_executable()?)
            .arg("app-server")
            .arg("proxy")
            .arg("--sock")
            .arg(socket_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .context("start Codex app-server proxy")?;
        let writer = proxy_child
            .stdin
            .take()
            .context("open Codex app-server proxy stdin")?;
        let reader = proxy_child
            .stdout
            .take()
            .context("open Codex app-server proxy stdout")?;
        let stream = ProxyStream { reader, writer };
        let (socket, response) = client_async("ws://localhost/", stream)
            .await
            .context("upgrade proxied stream to WebSocket")?;
        ensure!(
            response.status().as_u16() == 101,
            "unexpected WebSocket response: {}",
            response.status()
        );
        let mut client = Self {
            socket,
            _proxy_child: proxy_child,
            buffered: VecDeque::new(),
            next_id: 100,
        };
        client.initialize().await?;
        Ok(client)
    }

    async fn initialize(&mut self) -> Result<()> {
        self.request(
            INITIALIZE,
            json!({
                "clientInfo": {
                    "name": "caffold-reconnect-spike",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                },
                "title": "Caffold reconnect spike"
            }),
        )
        .await?;
        self.notify(INITIALIZED, json!({})).await
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        }))
        .await?;

        timeout(RPC_TIMEOUT, async {
            loop {
                if let Some(index) = self.buffered.iter().position(|value| {
                    value.get("id").and_then(Value::as_u64) == Some(id)
                        && value.get("method").is_none()
                }) {
                    let response = self
                        .buffered
                        .remove(index)
                        .expect("buffered response index remains valid");
                    return response_result(method, response);
                }

                let value = self.receive().await?;
                if value.get("id").and_then(Value::as_u64) == Some(id)
                    && value.get("method").is_none()
                {
                    return response_result(method, value);
                }
                self.buffered.push_back(value);
            }
        })
        .await
        .with_context(|| format!("wait for {method} response"))?
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<()> {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params
        }))
        .await
    }

    async fn respond(&mut self, id: Value, result: Value) -> Result<()> {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result
        }))
        .await
    }

    async fn wait_for_method(&mut self, method: &str, wait: Duration) -> Result<Value> {
        timeout(wait, async {
            loop {
                if let Some(index) = self
                    .buffered
                    .iter()
                    .position(|value| value.get("method").and_then(Value::as_str) == Some(method))
                {
                    return Ok(self
                        .buffered
                        .remove(index)
                        .expect("buffered method index remains valid"));
                }

                let value = self.receive().await?;
                if value.get("method").and_then(Value::as_str) == Some(method) {
                    return Ok(value);
                }
                self.buffered.push_back(value);
            }
        })
        .await
        .with_context(|| format!("wait for {method}"))?
    }

    async fn send(&mut self, value: Value) -> Result<()> {
        self.socket
            .send(Message::Text(value.to_string().into()))
            .await
            .context("send WebSocket JSON message")
    }

    async fn receive(&mut self) -> Result<Value> {
        loop {
            let message = self
                .socket
                .next()
                .await
                .context("app-server closed WebSocket")?
                .context("read app-server WebSocket message")?;
            match message {
                Message::Text(text) => {
                    return serde_json::from_str(text.as_str())
                        .context("decode app-server WebSocket text message");
                }
                Message::Binary(bytes) => {
                    return serde_json::from_slice(bytes.as_ref())
                        .context("decode app-server WebSocket binary message");
                }
                Message::Ping(payload) => {
                    self.socket
                        .send(Message::Pong(payload))
                        .await
                        .context("respond to app-server WebSocket ping")?;
                }
                Message::Pong(_) => {}
                Message::Close(frame) => bail!("app-server closed WebSocket: {frame:?}"),
                Message::Frame(_) => {}
            }
        }
    }
}

fn response_result(method: &str, response: Value) -> Result<Value> {
    if let Some(error) = response.get("error") {
        bail!("{method} failed: {error}");
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

#[derive(Default)]
struct SpikeIds {
    thread_id: Option<String>,
    turn_id: Option<String>,
}

async fn run_reconnect_spike(socket_path: &Path, ids: &mut SpikeIds) -> Result<()> {
    let cwd = std::env::current_dir().context("read spike cwd")?;
    let cwd = cwd.to_str().context("spike cwd must be valid UTF-8")?;
    let marker = uuid::Uuid::new_v4().simple().to_string();
    let requested_name = format!("Caffold reconnect spike {}", &marker[..8]);
    let final_reply = format!("caffold-reconnect-complete-{}", &marker[..8]);

    let mut first = RpcClient::connect(socket_path).await?;
    let started = first
        .request(
            THREAD_START,
            serde_json::to_value(thread_start_params(cwd, None, Some(NORMAL_SERVICE_TIER_ID)))
                .context("serialize thread/start params")?,
        )
        .await?;
    let thread_id = started
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .context("thread/start response did not include thread.id")?
        .to_string();
    ids.thread_id = Some(thread_id.clone());
    eprintln!("SPIKE thread_id={thread_id}");

    let prompt = format!(
        "Rename the current Caffold task to exactly \"{requested_name}\" using the rename_current_thread tool. You must call the tool; do not merely say it was renamed. After the tool succeeds, reply with exactly {final_reply}. Do not modify files or run commands."
    );
    let turn = first
        .request(
            TURN_START,
            serde_json::to_value(turn_start_params(
                &thread_id,
                cwd,
                &prompt,
                &[],
                &CodexTurnOptions {
                    model: Some(SPIKE_MODEL.to_string()),
                    effort: Some("low".to_string()),
                    ..CodexTurnOptions::default()
                },
            ))
            .context("serialize turn/start params")?,
        )
        .await?;
    let turn_id = turn
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .context("turn/start response did not include turn.id")?
        .to_string();
    ids.turn_id = Some(turn_id.clone());

    let original_request = first
        .wait_for_method("item/tool/call", TURN_TIMEOUT)
        .await?;
    let original_request_id = original_request
        .get("id")
        .cloned()
        .context("dynamic tool request did not include id")?;
    ensure!(
        original_request
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            == Some(thread_id.as_str()),
        "dynamic tool request belonged to another thread: {original_request}"
    );
    ensure!(
        original_request
            .pointer("/params/turnId")
            .and_then(Value::as_str)
            == Some(turn_id.as_str()),
        "dynamic tool request belonged to another turn: {original_request}"
    );
    ensure!(
        original_request
            .pointer("/params/tool")
            .and_then(Value::as_str)
            == Some(RENAME_CURRENT_THREAD_TOOL_NAME),
        "unexpected dynamic tool request: {original_request}"
    );
    eprintln!("SPIKE pending_request_id={original_request_id}");

    // Simulate replacing Caffold while app-server is blocked on a server request.
    drop(first);
    sleep(Duration::from_millis(250)).await;

    let mut second = RpcClient::connect(socket_path).await?;
    let resumed = second
        .request(
            THREAD_RESUME,
            serde_json::to_value(thread_resume_params(
                &thread_id,
                true,
                Some(NORMAL_SERVICE_TIER_ID),
            ))
            .context("serialize thread/resume params")?,
        )
        .await?;
    let resumed_status = resumed
        .pointer("/thread/status/type")
        .and_then(Value::as_str)
        .context("thread/resume response did not include thread.status.type")?;
    ensure!(
        resumed_status == "active",
        "resumed thread was not active: {resumed}"
    );
    eprintln!("SPIKE resumed_status={resumed_status}");

    let replayed_request = second
        .wait_for_method("item/tool/call", RPC_TIMEOUT)
        .await?;
    ensure!(
        replayed_request.get("id") == Some(&original_request_id),
        "resume did not replay the same pending request: original={original_request}, replayed={replayed_request}"
    );
    eprintln!("SPIKE replayed_request_id={original_request_id}");

    second
        .request(
            THREAD_NAME_SET,
            serde_json::to_value(thread_set_name_params(&thread_id, &requested_name))
                .context("serialize thread/name/set params")?,
        )
        .await?;
    second
        .respond(
            original_request_id,
            json!({
                "contentItems": [{
                    "type": "inputText",
                    "text": format!("Renamed the current Caffold task to `{requested_name}`.")
                }],
                "success": true
            }),
        )
        .await?;

    let completed = second
        .wait_for_method("turn/completed", TURN_TIMEOUT)
        .await?;
    ensure!(
        completed
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            == Some(thread_id.as_str()),
        "completed notification belonged to another thread: {completed}"
    );
    ensure!(
        completed.pointer("/params/turn/id").and_then(Value::as_str) == Some(turn_id.as_str()),
        "completed notification belonged to another turn: {completed}"
    );

    let read = second
        .request(
            THREAD_READ,
            serde_json::to_value(thread_read_params(&thread_id))
                .context("serialize thread/read params")?,
        )
        .await?;
    ensure!(
        read.pointer("/thread/name").and_then(Value::as_str) == Some(requested_name.as_str()),
        "renamed thread name did not persist: {read}"
    );
    eprintln!("SPIKE completed_turn_id={turn_id} persisted_name={requested_name:?}");
    Ok(())
}

async fn run_approval_reconnect_spike(socket_path: &Path, ids: &mut SpikeIds) -> Result<()> {
    let cwd = std::env::current_dir().context("read spike cwd")?;
    let cwd = cwd.to_str().context("spike cwd must be valid UTF-8")?;
    let marker = uuid::Uuid::new_v4().simple().to_string();
    let final_reply = format!("caffold-approval-complete-{}", &marker[..8]);

    let mut first = RpcClient::connect(socket_path).await?;
    let started = first
        .request(
            THREAD_START,
            serde_json::to_value(thread_start_params(
                cwd,
                Some(CodexPermissionMode::AskForApproval),
                Some(NORMAL_SERVICE_TIER_ID),
            ))
            .context("serialize approval thread/start params")?,
        )
        .await?;
    let thread_id = started
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .context("approval thread/start response did not include thread.id")?
        .to_string();
    ids.thread_id = Some(thread_id.clone());
    eprintln!("SPIKE approval_thread_id={thread_id}");

    let prompt = format!(
        "Use the command execution tool to run exactly /usr/bin/true. You must request escalated execution with sandbox_permissions=require_escalated so the user has to approve it; do not run it inside the sandbox. After approval and successful execution, reply with exactly {final_reply}. Do not modify files."
    );
    let turn = first
        .request(
            TURN_START,
            serde_json::to_value(turn_start_params(
                &thread_id,
                cwd,
                &prompt,
                &[],
                &CodexTurnOptions {
                    model: Some(SPIKE_MODEL.to_string()),
                    effort: Some("low".to_string()),
                    permission_mode: Some(CodexPermissionMode::AskForApproval),
                    ..CodexTurnOptions::default()
                },
            ))
            .context("serialize approval turn/start params")?,
        )
        .await?;
    let turn_id = turn
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .context("approval turn/start response did not include turn.id")?
        .to_string();
    ids.turn_id = Some(turn_id.clone());

    let original_request = first
        .wait_for_method("item/commandExecution/requestApproval", TURN_TIMEOUT)
        .await?;
    let original_request_id = original_request
        .get("id")
        .cloned()
        .context("command approval request did not include id")?;
    ensure!(
        original_request
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            == Some(thread_id.as_str()),
        "command approval request belonged to another thread: {original_request}"
    );
    ensure!(
        original_request
            .pointer("/params/turnId")
            .and_then(Value::as_str)
            == Some(turn_id.as_str()),
        "command approval request belonged to another turn: {original_request}"
    );
    eprintln!("SPIKE pending_approval_id={original_request_id}");

    drop(first);
    sleep(Duration::from_millis(250)).await;

    let mut second = RpcClient::connect(socket_path).await?;
    let resumed = second
        .request(
            THREAD_RESUME,
            serde_json::to_value(thread_resume_params(
                &thread_id,
                true,
                Some(NORMAL_SERVICE_TIER_ID),
            ))
            .context("serialize approval thread/resume params")?,
        )
        .await?;
    ensure!(
        resumed
            .pointer("/thread/status/type")
            .and_then(Value::as_str)
            == Some("active"),
        "approval thread was not active after resume: {resumed}"
    );

    let replayed_request = second
        .wait_for_method("item/commandExecution/requestApproval", RPC_TIMEOUT)
        .await?;
    ensure!(
        replayed_request.get("id") == Some(&original_request_id),
        "resume did not replay the same approval: original={original_request}, replayed={replayed_request}"
    );
    eprintln!("SPIKE replayed_approval_id={original_request_id}");

    second
        .respond(original_request_id, json!({ "decision": "accept" }))
        .await?;
    let completed = second
        .wait_for_method("turn/completed", TURN_TIMEOUT)
        .await?;
    ensure!(
        completed
            .pointer("/params/threadId")
            .and_then(Value::as_str)
            == Some(thread_id.as_str()),
        "approval turn completion belonged to another thread: {completed}"
    );
    ensure!(
        completed.pointer("/params/turn/id").and_then(Value::as_str) == Some(turn_id.as_str()),
        "approval turn completion belonged to another turn: {completed}"
    );
    eprintln!("SPIKE completed_approval_turn_id={turn_id}");
    Ok(())
}

async fn cleanup_spike(socket_path: &Path, ids: &SpikeIds) {
    let Some(thread_id) = ids.thread_id.as_deref() else {
        return;
    };
    let Ok(mut client) = RpcClient::connect(socket_path).await else {
        return;
    };
    if let Some(turn_id) = ids.turn_id.as_deref() {
        let _ = client
            .request(
                TURN_INTERRUPT,
                serde_json::to_value(turn_interrupt_params(thread_id, turn_id))
                    .unwrap_or(Value::Null),
            )
            .await;
    }
    match client
        .request(
            THREAD_ARCHIVE,
            serde_json::to_value(thread_archive_params(thread_id)).unwrap_or(Value::Null),
        )
        .await
    {
        Ok(_) => eprintln!("SPIKE archived_thread_id={thread_id}"),
        Err(error) => eprintln!("SPIKE cleanup_error={error:#}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an authenticated Codex CLI and makes a real model request"]
async fn live_proxy_replays_pending_dynamic_tool_after_reconnect() {
    let mut server = SocketAppServer::start()
        .await
        .expect("start isolated socket app-server");
    let mut ids = SpikeIds::default();
    let result = run_reconnect_spike(&server.socket_path, &mut ids).await;
    cleanup_spike(&server.socket_path, &ids).await;
    server.stop().await;
    result.expect("validate app-server WebSocket reconnect and pending request replay");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires an authenticated Codex CLI and makes a real model request"]
async fn live_proxy_replays_pending_approval_after_reconnect() {
    let mut server = SocketAppServer::start()
        .await
        .expect("start isolated socket app-server");
    let mut ids = SpikeIds::default();
    let result = run_approval_reconnect_spike(&server.socket_path, &mut ids).await;
    cleanup_spike(&server.socket_path, &ids).await;
    server.stop().await;
    result.expect("validate app-server proxy reconnect and pending approval replay");
}
