//! Caffold's authenticated streamable-HTTP MCP endpoint for Codex.
//!
//! The endpoint is part of the main Caffold server so it is available before
//! Task-store startup finishes. Codex may initialize an MCP connection while
//! the application is still restoring its runtime; discovery is safe then and
//! a tool call fails explicitly until the runtime is attached.

use std::sync::{Arc, Mutex as StdMutex};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};

use super::TaskRuntime;
use crate::agent::codex::{
    CAFFOLD_MCP_BINDING_HEADER, CodexMcpBindingTarget, CodexMcpBindings, CodexMcpRequest,
    caffold_mcp_tools, decode_mcp_request, mcp_error, mcp_initialize_result, mcp_result,
    mcp_tool_result,
};

const MAX_MCP_REQUEST_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub(in crate::app) struct CodexMcpHost {
    bindings: CodexMcpBindings,
    runtime: Arc<StdMutex<Option<TaskRuntime>>>,
    tools: Arc<Vec<Value>>,
}

impl CodexMcpHost {
    pub(in crate::app) fn new(endpoint: String) -> Self {
        Self {
            bindings: CodexMcpBindings::new(endpoint),
            runtime: Arc::new(StdMutex::new(None)),
            tools: Arc::new(caffold_mcp_tools()),
        }
    }

    #[cfg(test)]
    fn with_tools(endpoint: String, tools: Vec<Value>) -> Self {
        Self {
            bindings: CodexMcpBindings::new(endpoint),
            runtime: Arc::new(StdMutex::new(None)),
            tools: Arc::new(tools),
        }
    }

    pub(super) fn bindings(&self) -> CodexMcpBindings {
        self.bindings.clone()
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
                "/api/codex/mcp",
                post(codex_mcp).layer(DefaultBodyLimit::max(MAX_MCP_REQUEST_BYTES)),
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

async fn codex_mcp(State(host): State<CodexMcpHost>, headers: HeaderMap, body: Bytes) -> Response {
    let Some(token) = headers
        .get(CAFFOLD_MCP_BINDING_HEADER)
        .and_then(|value| value.to_str().ok())
    else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let Some(binding) = host.bindings.resolve(token) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let request = match decode_mcp_request(&body) {
        Ok(request) => request,
        Err(error) => return Json(error).into_response(),
    };
    let response = match request {
        CodexMcpRequest::Notification => return StatusCode::ACCEPTED.into_response(),
        CodexMcpRequest::Initialize {
            id,
            protocol_version,
        } => mcp_result(id, mcp_initialize_result(&protocol_version)),
        CodexMcpRequest::Ping { id } => mcp_result(id, json!({})),
        CodexMcpRequest::ListTools { id } => mcp_result(id, json!({ "tools": host.tools() })),
        CodexMcpRequest::CallTool {
            id,
            tool,
            arguments,
        } => {
            let CodexMcpBindingTarget::Thread(thread_id) = binding else {
                return Json(mcp_result(
                    id,
                    mcp_tool_result(Err(
                        "Caffold has not bound this MCP connection to its new Codex thread yet."
                            .to_string(),
                    )),
                ))
                .into_response();
            };
            let Some(runtime) = host.runtime() else {
                return Json(mcp_result(
                    id,
                    mcp_tool_result(Err("Caffold's Task runtime is not ready yet.".to_string())),
                ))
                .into_response();
            };
            let outcome = runtime
                .execute_codex_mcp_tool(&thread_id, &tool, arguments)
                .await;
            mcp_result(id, mcp_tool_result(outcome))
        }
        CodexMcpRequest::Unsupported { id, method } => mcp_error(
            id,
            -32601,
            &format!("Caffold does not serve MCP method `{method}`."),
        ),
    };
    (StatusCode::OK, Json(response)).into_response()
}

#[cfg(test)]
mod tests {
    use anyhow::Context;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
    };
    use tower::ServiceExt;

    use super::*;
    use crate::{
        agent::{
            claude::ClaudeClient,
            codex::{
                CAFFOLD_MCP_SERVER_NAME, CodexNotification, CodexRuntimeEvent, CodexServerRequest,
                CodexThreadClient, CodexTurnOptions, MockCodexResponse, NORMAL_SERVICE_TIER_ID,
                inspect_codex_installation,
            },
        },
        app::tasks::{events::TaskEvents, sessions::TaskSessions},
        task_store::{ManagedThread, RunBy, TaskStore},
    };
    use tokio::sync::broadcast;

    async fn request(host: &CodexMcpHost, token: Option<&str>, body: Value) -> Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/codex/mcp")
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header(CAFFOLD_MCP_BINDING_HEADER, token);
        }
        host.router()
            .oneshot(builder.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap()
    }

    async fn response_json(response: Response) -> Value {
        serde_json::from_slice(
            &to_bytes(response.into_body(), MAX_MCP_REQUEST_BYTES)
                .await
                .unwrap(),
        )
        .unwrap()
    }

    fn bind_thread(host: &CodexMcpHost, thread_id: &str) -> String {
        let token = host.bindings.begin_reattach(thread_id);
        host.bindings.commit_reattach(&token, thread_id).unwrap();
        token
    }

    async fn start_live_mcp_host(
        tools: Option<Vec<Value>>,
    ) -> anyhow::Result<(
        CodexMcpHost,
        broadcast::Sender<()>,
        tokio::task::JoinHandle<std::io::Result<()>>,
    )> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .context("bind live MCP endpoint")?;
        let endpoint = format!("http://{}/api/codex/mcp", listener.local_addr()?);
        let host = match tools {
            Some(tools) => CodexMcpHost::with_tools(endpoint, tools),
            None => CodexMcpHost::new(endpoint),
        };
        let (server_shutdown, _) = broadcast::channel(1);
        let shutdown = server_shutdown.clone();
        let mcp_router = host.router();
        let server = tokio::spawn(async move {
            axum::serve(listener, mcp_router)
                .with_graceful_shutdown(async move {
                    let mut receiver = shutdown.subscribe();
                    let _ = receiver.recv().await;
                })
                .await
        });
        Ok((host, server_shutdown, server))
    }

    #[tokio::test]
    async fn discovery_accepts_only_a_caffold_issued_binding() {
        let host = CodexMcpHost::new("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let token = host.bindings.begin_pending();
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" },
        });

        assert_eq!(
            request(&host, None, initialize.clone()).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&host, Some("not-a-caffold-capability"), initialize.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = response_json(request(&host, Some(&token), initialize).await).await;
        assert_eq!(response["result"]["serverInfo"]["name"], "caffold");

        let response = response_json(
            request(
                &host,
                Some(&token),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            )
            .await,
        )
        .await;
        assert_eq!(response["result"]["tools"].as_array().unwrap().len(), 2);
        assert_eq!(
            response["result"]["tools"][0]["name"],
            "rename_current_task"
        );
    }

    #[tokio::test]
    async fn a_pending_connection_cannot_execute_a_task_tool() {
        let host = CodexMcpHost::new("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let token = host.bindings.begin_pending();
        let response = response_json(
            request(
                &host,
                Some(&token),
                json!({
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {
                        "name": "rename_current_task",
                        "arguments": { "name": "Too soon" },
                    },
                }),
            )
            .await,
        )
        .await;
        assert_eq!(response["result"]["isError"], true);
        assert!(
            response["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("not bound")
        );
    }

    #[tokio::test]
    async fn a_bound_connection_waits_for_the_task_runtime() {
        let host = CodexMcpHost::new("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let token = bind_thread(&host, "thread_1");
        let response = response_json(
            request(
                &host,
                Some(&token),
                json!({
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "rename_current_task",
                        "arguments": { "name": "Too early" },
                    },
                }),
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
    async fn a_bound_connection_runs_the_same_managed_task_tool_logic() {
        let host = CodexMcpHost::new("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1,
            )
            .unwrap();
        let client =
            CodexThreadClient::mock(vec![MockCodexResponse::ok("thread/name/set", json!({}))]);
        let (shutdown, _) = broadcast::channel(1);
        let runtime = TaskRuntime::new(
            ClaudeClient::mock().0,
            TaskSessions::default(),
            TaskEvents::default(),
            store.clone(),
            shutdown,
        );
        runtime.install_test_client(1, client.clone()).await;
        host.attach_runtime(runtime);
        let token = bind_thread(&host, "thread_1");

        let response = response_json(
            request(
                &host,
                Some(&token),
                json!({
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "rename_current_task",
                        "arguments": { "name": "Codex MCP task" },
                    },
                }),
            )
            .await,
        )
        .await;

        assert_eq!(response["result"]["isError"], false);
        assert_eq!(
            response["result"]["content"][0]["text"],
            "Renamed the current Caffold task to `Codex MCP task`."
        );
        assert_eq!(
            store.get("thread_1").unwrap().unwrap().display_name,
            "Codex MCP task"
        );
        assert_eq!(
            client.mock_requests().await,
            [(
                "thread/name/set".to_string(),
                json!({ "threadId": "thread_1", "name": "Codex MCP task" }),
            )]
        );

        let legacy_response = response_json(
            request(
                &host,
                Some(&token),
                json!({
                    "jsonrpc": "2.0",
                    "id": 5,
                    "method": "tools/call",
                    "params": {
                        "name": "rename_current_thread",
                        "arguments": { "name": "Legacy alias must stay dynamic" },
                    },
                }),
            )
            .await,
        )
        .await;
        assert_eq!(legacy_response["result"]["isError"], true);
        assert_eq!(
            legacy_response["result"]["content"][0]["text"],
            "Caffold does not serve the tool `rename_current_thread`."
        );
        assert_eq!(client.mock_requests().await.len(), 1);
    }

    #[tokio::test]
    #[ignore = "requires an authenticated installed Codex app-server"]
    async fn live_codex_refreshes_the_caffold_mcp_after_reconnect_and_resume() {
        use anyhow::ensure;
        use tokio::time::timeout;

        let root = tempfile::tempdir()
            .context("create live MCP test root")
            .unwrap();
        let project = root.path().join("project");
        std::fs::create_dir(&project)
            .context("create live MCP test project")
            .unwrap();
        let (host, server_shutdown, server) = start_live_mcp_host(None)
            .await
            .expect("start the first live MCP host");
        let bindings = host.bindings();

        let store = TaskStore::memory().unwrap();
        let (runtime_shutdown, _) = broadcast::channel(1);
        let runtime = TaskRuntime::new(
            ClaudeClient::mock().0,
            TaskSessions::default(),
            TaskEvents::default(),
            store.clone(),
            runtime_shutdown,
        );
        host.attach_runtime(runtime.clone());
        let installation = inspect_codex_installation()
            .await
            .expect("inspect installed Codex for the live MCP test");
        let client = CodexThreadClient::start_with_installation_and_mcp(&installation, bindings)
            .await
            .expect("connect live Codex app-server with Caffold MCP");
        runtime.install_test_client(1, client.clone()).await;

        let mut created_thread_id = None;
        let mut cleanup_client = client.clone();
        let mut refreshed_server = None;
        let result: anyhow::Result<()> = async {
            let started = client
                .start_thread(
                    project.to_str().context("live project path is not UTF-8")?,
                    None,
                    NORMAL_SERVICE_TIER_ID,
                )
                .await
                .context("start live MCP-backed Codex thread")?;
            let thread_id = started.thread_id;
            created_thread_id = Some(thread_id.clone());
            store.claim(
                ManagedThread::new(&thread_id, RunBy::Codex, None, None, None),
                1,
            )?;

            let first = client
                .mcp_server_status_for_test(&thread_id)
                .await
                .context("read initial live MCP inventory")?;
            let first_tools = mcp_tool_names(&first)?;
            ensure!(
                first_tools == ["isolate_current_task", "rename_current_task"],
                "unexpected initial Caffold MCP tools: {first_tools:?}"
            );

            // An empty app-server thread has no durable rollout to rejoin. A
            // model-driven tool call both materializes the thread and proves a
            // new MCP-only thread can use Caffold without legacy dynamic tools.
            let mut events = client.subscribe();
            client
                .start_turn(
                    &thread_id,
                    project.to_str().context("live project path is not UTF-8")?,
                    "Use the rename_current_task tool to rename the current Caffold task to exactly \"Live Caffold MCP first turn\". You must call the tool; do not merely say it was renamed. After the tool succeeds, reply with exactly MCP-READY. Do not run commands or modify files.",
                    &[],
                    CodexTurnOptions {
                        service_tier: Some(NORMAL_SERVICE_TIER_ID.to_string()),
                        ..CodexTurnOptions::default()
                    },
                )
                .await
                .context("start the live MCP persistence turn")?;
            timeout(std::time::Duration::from_secs(120), async {
                loop {
                    match events.recv().await {
                        Ok(CodexRuntimeEvent::ServerRequest(
                            CodexServerRequest::DynamicToolCall { id, .. },
                        )) => {
                            client
                                .respond_to_server_request(
                                    id,
                                    json!({
                                        "contentItems": [{
                                            "type": "inputText",
                                            "text": "New Caffold threads expose this operation through MCP only."
                                        }],
                                        "success": false,
                                    }),
                                )
                                .await
                                .context("refuse an unexpected first-turn legacy dynamic tool")?;
                            break Err(anyhow::anyhow!(
                                "new MCP-only thread requested a legacy dynamic tool"
                            ));
                        }
                        Ok(CodexRuntimeEvent::ServerRequest(request)) => break Err(anyhow::anyhow!(
                            "unexpected server request during live MCP persistence turn: {request:?}"
                        )),
                        Ok(CodexRuntimeEvent::Notification(
                            CodexNotification::TurnCompleted {
                                thread_id: completed,
                                ..
                            },
                        )) if completed == thread_id => break Ok::<(), anyhow::Error>(()),
                        Ok(CodexRuntimeEvent::Error { message }) => {
                            break Err(anyhow::anyhow!(message));
                        }
                        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(error) => break Err(anyhow::anyhow!(error)),
                    }
                }
            })
            .await
            .context("wait for live MCP persistence turn")??;
            let first_renamed = client
                .read_thread(&thread_id)
                .await
                .context("read thread after model-driven MCP rename")?;
            ensure!(
                first_renamed.name.as_deref() == Some("Live Caffold MCP first turn"),
                "model did not call rename_current_task through MCP"
            );

            let mut refreshed_catalog = caffold_mcp_tools();
            refreshed_catalog.push(json!({
                "name": "caffold_mcp_generation_probe",
                "description": "Live fixture for MCP discovery after reconnect.",
                "inputSchema": { "type": "object", "additionalProperties": false },
            }));
            let (next_host, next_server_shutdown, next_server) =
                start_live_mcp_host(Some(refreshed_catalog))
                    .await
                    .context("start the replacement live MCP host")?;
            next_host.attach_runtime(runtime.clone());
            refreshed_server = Some((next_server_shutdown, next_server));
            let next_client = CodexThreadClient::start_with_installation_and_mcp(
                &installation,
                next_host.bindings(),
            )
            .await
            .context("connect a replacement Codex app-server proxy")?;
            cleanup_client = next_client.clone();
            client.shutdown().await;
            runtime.install_test_client(2, next_client.clone()).await;
            next_client
                .resume_thread_with_page(&thread_id, false, NORMAL_SERVICE_TIER_ID)
                .await
                .context("resume through the replacement Caffold MCP generation")?;
            let refreshed = next_client
                .mcp_server_status_for_test(&thread_id)
                .await
                .context("read refreshed live MCP inventory")?;
            let refreshed_tools = mcp_tool_names(&refreshed)?;
            ensure!(
                refreshed_tools.contains(&"caffold_mcp_generation_probe"),
                "resumed Codex thread kept stale MCP tools: {refreshed_tools:?}"
            );

            let called = next_client
                .call_mcp_tool_for_test(
                    &thread_id,
                    "rename_current_task",
                    json!({ "name": "Live Caffold MCP verified" }),
                )
                .await
                .context("call Caffold-owned MCP tool through app-server")?;
            ensure!(
                called["content"][0]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("Live Caffold MCP verified")),
                "live MCP call returned an unexpected result: {called}"
            );
            let renamed = next_client
                .read_thread(&thread_id)
                .await
                .context("read thread after live MCP rename")?;
            ensure!(
                renamed.name.as_deref() == Some("Live Caffold MCP verified"),
                "live MCP tool did not rename the provider thread"
            );
            eprintln!(
                "LIVE_CODEX_MCP thread={} initial_tools={first_tools:?} refreshed_tools={refreshed_tools:?}",
                thread_id
            );
            Ok(())
        }
        .await;

        if let Some(thread_id) = created_thread_id {
            let _ = cleanup_client.delete_thread(&thread_id).await;
        }
        cleanup_client.shutdown().await;
        let _ = server_shutdown.send(());
        let _ = timeout(std::time::Duration::from_secs(5), server).await;
        if let Some((refreshed_shutdown, refreshed_server)) = refreshed_server {
            let _ = refreshed_shutdown.send(());
            let _ = timeout(std::time::Duration::from_secs(5), refreshed_server).await;
        }
        result.expect("live Caffold-owned Codex MCP contract");
    }

    fn mcp_tool_names(status: &Value) -> anyhow::Result<Vec<&str>> {
        let server = status
            .get("data")
            .and_then(Value::as_array)
            .and_then(|servers| {
                servers
                    .iter()
                    .find(|server| server["name"] == CAFFOLD_MCP_SERVER_NAME)
            })
            .context("Codex did not report the Caffold MCP server")?;
        let mut tools = server["tools"]
            .as_object()
            .context("Codex did not report the Caffold MCP tool inventory")?
            .keys()
            .map(String::as_str)
            .collect::<Vec<_>>();
        tools.sort_unstable();
        Ok(tools)
    }
}
