//! Caffold's authenticated streamable-HTTP MCP endpoint for Grok.
//!
//! Grok sessions are declared with this address and a binding already bound to
//! their Task, so an `initialize` here either answers with the session signed
//! to that Task or is refused. The address serves Caffold's Task tools and no
//! resources. Like Codex's address it is part of the main Caffold server, so
//! it answers before Task-store startup finishes; a tool call fails explicitly
//! until the runtime is attached.

use std::sync::{Arc, Mutex as StdMutex};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, HeaderValue, StatusCode, header::HeaderName},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};

use super::TaskRuntime;
use crate::agent::{
    grok::{GrokMcpBindings, grok_mcp_initialize_result},
    http_mcp::{
        CAFFOLD_MCP_BINDING_HEADER, MCP_SESSION_ID_HEADER, McpRequest, McpSessionSigner,
        caffold_mcp_tools, decode_mcp_request, mcp_error, mcp_result, mcp_tool_result,
    },
};

const MAX_MCP_REQUEST_BYTES: usize = 256 * 1024;
const GROK_MCP_PATH: &str = "/api/grok/mcp";

#[derive(Clone)]
pub(in crate::app) struct GrokMcpHost {
    bindings: GrokMcpBindings,
    endpoint: String,
    runtime: Arc<StdMutex<Option<TaskRuntime>>>,
    tools: Arc<Vec<Value>>,
}

impl GrokMcpHost {
    /// `origin` is the server's own address, such as `http://127.0.0.1:5178`.
    pub(in crate::app) fn new(origin: &str, signer: McpSessionSigner) -> Self {
        Self {
            bindings: GrokMcpBindings::new(signer),
            endpoint: format!("{origin}{GROK_MCP_PATH}"),
            runtime: Arc::new(StdMutex::new(None)),
            tools: Arc::new(caffold_mcp_tools()),
        }
    }

    pub(super) fn bindings(&self) -> GrokMcpBindings {
        self.bindings.clone()
    }

    /// Where a Grok session reaches these tools.
    pub(super) fn endpoint(&self) -> String {
        self.endpoint.clone()
    }

    pub(super) fn attach_runtime(&self, runtime: TaskRuntime) {
        *self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(runtime);
    }

    pub(in crate::app) fn router(&self) -> Router {
        Router::new()
            .route(
                GROK_MCP_PATH,
                post(serve_mcp).layer(DefaultBodyLimit::max(MAX_MCP_REQUEST_BYTES)),
            )
            .with_state(self.clone())
    }

    fn runtime(&self) -> Option<TaskRuntime> {
        self.runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn tools(&self) -> Vec<Value> {
        self.tools.as_ref().clone()
    }
}

async fn serve_mcp(State(host): State<GrokMcpHost>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(binding) = headers
        .get(CAFFOLD_MCP_BINDING_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let request = match decode_mcp_request(&body) {
        Ok(request) => request,
        Err(error) => return Json(error).into_response(),
    };

    if let McpRequest::Initialize {
        id,
        protocol_version,
    } = &request
    {
        let Some(session) = host.bindings.initialize_session(binding).await else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        let mut response = Json(mcp_result(
            id.clone(),
            grok_mcp_initialize_result(protocol_version),
        ))
        .into_response();
        response.headers_mut().insert(
            HeaderName::from_static(MCP_SESSION_ID_HEADER),
            HeaderValue::from_str(&session)
                .expect("Caffold MCP session values contain only HTTP header characters"),
        );
        return response;
    }

    let Some(session) = headers
        .get(MCP_SESSION_ID_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(thread_id) = host.bindings.authorize_session(binding, session).await else {
        return StatusCode::UNAUTHORIZED.into_response();
    };

    let response = match request {
        McpRequest::Notification => return StatusCode::ACCEPTED.into_response(),
        McpRequest::Initialize { .. } => unreachable!("initialize returned above"),
        McpRequest::Ping { id } => mcp_result(id, json!({})),
        McpRequest::ListTools { id } => mcp_result(id, json!({ "tools": host.tools() })),
        McpRequest::ListResources { id } => unsupported_method(id, "resources/list"),
        McpRequest::ReadResource { id, .. } => unsupported_method(id, "resources/read"),
        McpRequest::CallTool {
            id,
            tool,
            arguments,
        } => {
            let Some(runtime) = host.runtime() else {
                return Json(mcp_result(
                    id,
                    mcp_tool_result(Err("Caffold's Task runtime is not ready yet.".to_string())),
                ))
                .into_response();
            };
            let outcome = runtime.execute_mcp_tool(&thread_id, &tool, arguments).await;
            mcp_result(id, mcp_tool_result(outcome))
        }
        McpRequest::Unsupported { id, method } => unsupported_method(id, &method),
    };
    (StatusCode::OK, Json(response)).into_response()
}

fn unsupported_method(id: Value, method: &str) -> Value {
    mcp_error(
        id,
        -32601,
        &format!("Caffold does not serve MCP method `{method}`."),
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, process::Command, time::Duration};

    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tokio::{
        sync::broadcast,
        time::{sleep, timeout},
    };
    use tower::ServiceExt;

    use super::*;
    use crate::{
        agent::{claude::ClaudeClient, codex::CodexThreadClient, grok::GrokClient},
        app::tasks::{
            CodexMcpHost, events::TaskEvents, routes::router, sessions::TaskSessions,
            test_support::task_state_with_grok,
        },
        fs::RootedFs,
        task_store::{ManagedThread, RunBy, TaskStore},
    };

    async fn send(
        router: Router,
        path: &str,
        binding: Option<&str>,
        session: Option<&str>,
        body: Value,
    ) -> Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri(path)
            .header("content-type", "application/json");
        if let Some(binding) = binding {
            builder = builder.header(CAFFOLD_MCP_BINDING_HEADER, binding);
        }
        if let Some(session) = session {
            builder = builder.header(MCP_SESSION_ID_HEADER, session);
        }
        router
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap()
    }

    async fn request(
        host: &GrokMcpHost,
        binding: Option<&str>,
        session: Option<&str>,
        body: Value,
    ) -> Response {
        send(host.router(), GROK_MCP_PATH, binding, session, body).await
    }

    async fn response_json(response: Response) -> Value {
        serde_json::from_slice(
            &to_bytes(response.into_body(), MAX_MCP_REQUEST_BYTES)
                .await
                .unwrap(),
        )
        .unwrap()
    }

    fn session_header(response: &Response) -> String {
        response
            .headers()
            .get(MCP_SESSION_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .expect("initialize response carries an MCP session")
            .to_string()
    }

    fn initialize(protocol_version: &str) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": protocol_version },
        })
    }

    fn forged_thread_session() -> String {
        format!("s1.{}.{}.{}", "dGhyZWFkXzE", "B".repeat(43), "C".repeat(43))
    }

    #[test]
    fn the_grok_address_is_named_from_the_server_origin() {
        let host = GrokMcpHost::new("http://127.0.0.1:5178", McpSessionSigner::memory());
        assert_eq!(host.endpoint(), "http://127.0.0.1:5178/api/grok/mcp");
    }

    #[tokio::test]
    async fn the_grok_address_takes_only_a_bound_binding_and_refuses_forgeries() {
        let host = GrokMcpHost::new("http://127.0.0.1:5177", McpSessionSigner::memory());
        // Grok proposes a protocol version this server does not speak. The
        // answer names one it does, and Grok follows it.
        assert_eq!(
            request(&host, None, None, initialize("2025-11-25"))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(
                &host,
                Some("not-a-caffold-capability"),
                None,
                initialize("2025-11-25")
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );

        let binding = host.bindings.bind("thread_1");
        let initialized = request(&host, Some(&binding), None, initialize("2025-11-25")).await;
        assert_eq!(initialized.status(), StatusCode::OK);
        let session = session_header(&initialized);
        let response = response_json(initialized).await;
        assert_eq!(response["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(response["result"]["serverInfo"]["name"], "caffold");

        let without_session = request(
            &host,
            Some(&binding),
            None,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .await;
        assert_eq!(without_session.status(), StatusCode::UNAUTHORIZED);
        let forged = request(
            &host,
            Some(&binding),
            Some(&forged_thread_session()),
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
        )
        .await;
        assert_eq!(forged.status(), StatusCode::UNAUTHORIZED);
        let tools = response_json(
            request(
                &host,
                Some(&binding),
                Some(&session),
                json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }),
            )
            .await,
        )
        .await;
        assert_eq!(tools["result"]["tools"], json!(caffold_mcp_tools()));
    }

    #[tokio::test]
    async fn the_grok_address_serves_no_resources() {
        let host = GrokMcpHost::new("http://127.0.0.1:5177", McpSessionSigner::memory());
        let binding = host.bindings.bind("thread_1");
        let initialized = request(&host, Some(&binding), None, initialize("2025-06-18")).await;
        let session = session_header(&initialized);
        assert_eq!(
            response_json(initialized).await["result"]["capabilities"],
            json!({ "tools": {} })
        );

        for body in [
            json!({ "jsonrpc": "2.0", "id": 4, "method": "resources/list" }),
            json!({
                "jsonrpc": "2.0",
                "id": 5,
                "method": "resources/read",
                "params": { "uri": "caffold://session/ready" },
            }),
        ] {
            let id = body["id"].clone();
            let answer =
                response_json(request(&host, Some(&binding), Some(&session), body).await).await;
            assert_eq!(answer["id"], id);
            assert_eq!(answer["error"]["code"], -32601, "{answer}");
        }
    }

    /// Each address issues sessions only for the bindings its own agent was
    /// given. A signed session is checked with the one installation key
    /// wherever it arrives, so the two addresses are names, not an isolation
    /// boundary.
    #[tokio::test]
    async fn a_binding_initializes_only_at_its_own_agents_address() {
        let signer = McpSessionSigner::memory();
        let grok = GrokMcpHost::new("http://127.0.0.1:5177", signer.clone());
        let codex = CodexMcpHost::new("http://127.0.0.1:5177", signer);
        let grok_binding = grok.bindings.bind("thread_grok");
        let codex_binding = codex.bindings().begin_pending().await.unwrap();

        assert_eq!(
            send(
                codex.router(),
                "/api/codex/mcp",
                Some(&grok_binding),
                None,
                initialize("2025-06-18"),
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&grok, Some(&codex_binding), None, initialize("2025-06-18"))
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );

        let session = session_header(
            &request(&grok, Some(&grok_binding), None, initialize("2025-06-18")).await,
        );
        assert_eq!(
            send(
                codex.router(),
                "/api/codex/mcp",
                Some(&grok_binding),
                Some(&session),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            )
            .await
            .status(),
            StatusCode::OK
        );
    }

    fn rename_call(name: &str) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": { "name": "rename_current_task", "arguments": { "name": name } },
        })
    }

    #[tokio::test]
    async fn the_grok_address_handles_non_tool_mcp_frames() {
        let host = GrokMcpHost::new("http://127.0.0.1:5177", McpSessionSigner::memory());
        let binding = host.bindings.bind("thread_1");
        let session =
            session_header(&request(&host, Some(&binding), None, initialize("2025-06-18")).await);

        let malformed =
            response_json(request(&host, Some(&binding), Some(&session), json!([])).await).await;
        assert_eq!(malformed["error"]["code"], -32600);

        let notification = request(
            &host,
            Some(&binding),
            Some(&session),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        )
        .await;
        assert_eq!(notification.status(), StatusCode::ACCEPTED);

        let ping = response_json(
            request(
                &host,
                Some(&binding),
                Some(&session),
                json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" }),
            )
            .await,
        )
        .await;
        assert_eq!(ping["result"], json!({}));

        let unsupported = response_json(
            request(
                &host,
                Some(&binding),
                Some(&session),
                json!({ "jsonrpc": "2.0", "id": 8, "method": "prompts/list" }),
            )
            .await,
        )
        .await;
        assert_eq!(unsupported["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn a_tool_call_at_the_grok_address_waits_for_the_task_runtime() {
        let host = GrokMcpHost::new("http://127.0.0.1:5177", McpSessionSigner::memory());
        let binding = host.bindings.bind("thread_1");
        let session =
            session_header(&request(&host, Some(&binding), None, initialize("2025-06-18")).await);

        let response = response_json(
            request(
                &host,
                Some(&binding),
                Some(&session),
                rename_call("Too early"),
            )
            .await,
        )
        .await;

        assert_eq!(response["result"]["isError"], true);
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("runtime is not ready")
        );
    }

    #[tokio::test]
    async fn a_claude_task_cannot_use_the_grok_address() {
        let root = tempfile::tempdir().unwrap();
        let host = GrokMcpHost::new("http://127.0.0.1:5177", McpSessionSigner::memory());
        let store = TaskStore::memory().unwrap();
        let thread_id = "claude-thread";
        store
            .claim(
                ManagedThread {
                    run_by: RunBy::Claude {
                        cwd: root.path().display().to_string(),
                    },
                    ..ManagedThread::new(thread_id, RunBy::Codex, None, None, None)
                },
                1,
            )
            .unwrap();
        let (shutdown, _) = broadcast::channel(1);
        host.attach_runtime(TaskRuntime::new(
            ClaudeClient::mock().0,
            GrokClient::unreachable(),
            TaskSessions::default(),
            TaskEvents::default(),
            store.clone(),
            shutdown,
        ));
        let binding = host.bindings.bind(thread_id);
        let session =
            session_header(&request(&host, Some(&binding), None, initialize("2025-06-18")).await);

        let response = response_json(
            request(
                &host,
                Some(&binding),
                Some(&session),
                rename_call("Must not be applied"),
            )
            .await,
        )
        .await;

        assert_eq!(response["result"]["isError"], true);
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("Claude Tasks reach Caffold's tools through their own session")
        );
        assert_ne!(
            store.get(thread_id).unwrap().unwrap().display_name,
            "Must not be applied"
        );
    }

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_is_available() -> bool {
        Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    async fn task_call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json = if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        };
        (status, json)
    }

    /// A Grok Task keeps Notes through its own address, and the Notes record
    /// which Task wrote them.
    #[tokio::test]
    async fn a_grok_task_keeps_notes_through_its_own_address() {
        let root = tempfile::tempdir().unwrap();
        let (state, leader, _memory, host) = task_state_with_grok(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        let store = state.task_store.clone();
        let app = router(state);

        let (status, created) = task_call(
            &app,
            Request::post("/api/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "titleSource": "Keep notes", "provider": "grok" }).to_string(),
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let thread_id = created["detail"]["threadId"].as_str().unwrap().to_string();
        let asked = leader.wait_for("session/new").await;
        let token = asked["mcpServers"][0]["headers"][0]["value"]
            .as_str()
            .unwrap()
            .to_string();
        let session =
            session_header(&request(&host, Some(&token), None, initialize("2025-11-25")).await);
        let call = |id: u64, tool: &str, arguments: Value| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": { "name": tool, "arguments": arguments },
            })
        };

        let created_note = response_json(
            request(
                &host,
                Some(&token),
                Some(&session),
                call(
                    2,
                    "create_note",
                    json!({ "name": "Bridge", "content": "# Bridge\n" }),
                ),
            )
            .await,
        )
        .await;
        assert_eq!(created_note["result"]["isError"], false, "{created_note}");
        let answer: Value = serde_json::from_str(
            created_note["result"]["content"][0]["text"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        let note_id = answer["noteId"].as_str().unwrap().to_string();

        let refused = response_json(
            request(
                &host,
                Some(&token),
                Some(&session),
                call(
                    3,
                    "delete_note_directory",
                    json!({ "directoryId": "missing" }),
                ),
            )
            .await,
        )
        .await;
        assert_eq!(refused["result"]["isError"], true);
        assert_eq!(
            refused["result"]["content"][0]["text"],
            "No Note directory has the id `missing`."
        );

        let note = store
            .read(|tables| tables.note(&note_id))
            .unwrap()
            .expect("the Note is stored");
        assert_eq!(note.content, "# Bridge\n");
        assert_eq!(note.created_by_thread_id, thread_id);
        assert_eq!(note.updated_by_thread_id, thread_id);
    }

    /// A Grok Task calls the rename and isolate tools through its own address:
    /// the binding its session was started with names the Task, the rename
    /// lands on the row and on the leader's session, and isolating prepares
    /// the worktree and writes down the move without moving anything yet.
    #[tokio::test]
    async fn a_grok_task_renames_and_isolates_itself_through_its_own_address() {
        if !git_is_available() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        git(root.path(), &["init", "--initial-branch=main"]);
        fs::write(root.path().join("README.md"), "hello\n").unwrap();
        git(root.path(), &["add", "README.md"]);
        git(
            root.path(),
            &[
                "-c",
                "user.email=caffold@test",
                "-c",
                "user.name=Caffold",
                "commit",
                "-m",
                "start",
            ],
        );
        let (state, leader, _memory, host) = task_state_with_grok(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        let store = state.task_store.clone();
        let bindings_dir = root.path().join(".caffold-test/grok/bindings");
        let app = router(state);

        let (status, created) = task_call(
            &app,
            Request::post("/api/tasks")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "titleSource": "Look into the bridge", "provider": "grok" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{created}");
        let thread_id = created["detail"]["threadId"].as_str().unwrap().to_string();
        let asked = leader.wait_for("session/new").await;
        let server = &asked["mcpServers"][0];
        assert_eq!(server["url"], host.endpoint());
        let token = server["headers"][0]["value"].as_str().unwrap().to_string();
        let home = asked["cwd"].as_str().unwrap().to_string();

        let initialized = request(&host, Some(&token), None, initialize("2025-11-25")).await;
        assert_eq!(initialized.status(), StatusCode::OK);
        let session = session_header(&initialized);
        let call = |id: u64, tool: &str, arguments: Value| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "tools/call",
                "params": { "name": tool, "arguments": arguments },
            })
        };

        let renamed = response_json(
            request(
                &host,
                Some(&token),
                Some(&session),
                call(
                    2,
                    "rename_current_task",
                    json!({ "name": "  Grok bridge  " }),
                ),
            )
            .await,
        )
        .await;
        assert_eq!(
            renamed["result"]["content"][0]["text"],
            "Renamed the current Caffold task to `Grok bridge`.",
            "{renamed}"
        );
        let retitled = leader.wait_for("_x.ai/session/rename").await;
        assert_eq!(retitled["sessionId"], thread_id);
        assert_eq!(retitled["title"], "Grok bridge");
        assert_eq!(
            store.get(&thread_id).unwrap().unwrap().display_name,
            "Grok bridge"
        );

        let isolated = response_json(
            request(
                &host,
                Some(&token),
                Some(&session),
                call(
                    3,
                    "isolate_current_task",
                    json!({ "branchName": "grok-bridge" }),
                ),
            )
            .await,
        )
        .await;
        let text = isolated["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.starts_with("Prepared the current Caffold task on branch `grok-bridge` at `"),
            "{text}"
        );
        assert!(text.contains("End this turn; the user's next request will continue there."));
        let worktree = store
            .worktree_for_thread(&thread_id)
            .unwrap()
            .expect("the Task owns a worktree now");
        // Nothing is running, so the move follows at once: the session is
        // forked into the worktree, the Task re-bound to the copy, and the
        // source closed.
        let binding_file = bindings_dir.join(format!("{thread_id}.json"));
        let binding = timeout(Duration::from_secs(5), async {
            loop {
                let binding: Value =
                    serde_json::from_str(&fs::read_to_string(&binding_file).unwrap()).unwrap();
                if binding["switch"].is_null() {
                    return binding;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the move settles");
        assert_eq!(binding["current"]["cwd"], worktree.worktree_path);
        let copy = binding["current"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(copy, thread_id);
        assert_eq!(binding["history"][0]["sessionId"], thread_id);
        assert_eq!(binding["history"][0]["closePending"], false);
        let forked = leader.wait_for("_x.ai/session/fork").await;
        assert_eq!(forked["sourceSessionId"], thread_id);
        assert_eq!(forked["sourceCwd"], home);
        assert_eq!(forked["newCwd"], worktree.worktree_path);
        assert_eq!(forked["newSessionId"], copy);
        assert_eq!(leader.wait_for("session/load").await["sessionId"], copy);
        assert_eq!(
            leader.wait_for("session/close").await["sessionId"],
            thread_id
        );

        let again = response_json(
            request(
                &host,
                Some(&token),
                Some(&session),
                call(4, "isolate_current_task", json!({})),
            )
            .await,
        )
        .await;
        let text = again["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.starts_with(
                "The current Caffold task is already isolated on branch `grok-bridge` at `"
            ),
            "{text}"
        );
        let binding: Value =
            serde_json::from_str(&fs::read_to_string(&binding_file).unwrap()).unwrap();
        assert!(
            binding["switch"].is_null(),
            "asking again plans no second move"
        );
        assert_eq!(binding["current"]["sessionId"], copy);

        // The next message runs in the worktree, on the copy.
        let (status, prompted) = task_call(
            &app,
            Request::post(format!("/api/tasks/{thread_id}/prompts"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "prompt": "Carry on here." }).to_string(),
                ))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{prompted}");
        let prompt = leader.wait_for("session/prompt").await;
        assert_eq!(prompt["sessionId"], copy);
        assert_eq!(prompt["prompt"][0]["text"], "Carry on here.");
    }
}
