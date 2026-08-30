//! Caffold's authenticated streamable-HTTP MCP endpoint for Codex.
//!
//! The endpoint is part of the main Caffold server so it is available before
//! Task-store startup finishes. Codex may initialize an MCP connection while
//! the application is still restoring its runtime; discovery is safe then and
//! a tool call fails explicitly until the runtime is attached.

use std::{
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
};

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
use crate::agent::codex::{
    CAFFOLD_MCP_BINDING_HEADER, CAFFOLD_MCP_SESSION_READY_URI, CodexMcpBindings, CodexMcpRequest,
    CodexMcpSessionAuthorization, MCP_SESSION_ID_HEADER, caffold_mcp_resources, caffold_mcp_tools,
    decode_mcp_request, mcp_error, mcp_initialize_result, mcp_resource_result, mcp_result,
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
    pub(in crate::app) fn memory(endpoint: String) -> Self {
        Self {
            bindings: CodexMcpBindings::memory(endpoint),
            runtime: Arc::new(StdMutex::new(None)),
            tools: Arc::new(caffold_mcp_tools()),
        }
    }

    pub(in crate::app) fn persistent(endpoint: String, state_dir: PathBuf) -> Self {
        Self {
            bindings: CodexMcpBindings::persistent(endpoint, state_dir),
            runtime: Arc::new(StdMutex::new(None)),
            tools: Arc::new(caffold_mcp_tools()),
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

    if let CodexMcpRequest::Initialize {
        id,
        protocol_version,
    } = &request
    {
        let Some(session) = host.bindings.initialize_session(binding).await else {
            return StatusCode::UNAUTHORIZED.into_response();
        };
        let mut response = Json(mcp_result(
            id.clone(),
            mcp_initialize_result(protocol_version),
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
    let authorization = host.bindings.authorize_session(binding, session).await;
    if authorization == CodexMcpSessionAuthorization::Unauthorized {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if authorization == CodexMcpSessionAuthorization::Expired {
        return StatusCode::NOT_FOUND.into_response();
    }

    let response = match request {
        CodexMcpRequest::Notification => return StatusCode::ACCEPTED.into_response(),
        CodexMcpRequest::Initialize { .. } => unreachable!("initialize returned above"),
        CodexMcpRequest::Ping { id } => mcp_result(id, json!({})),
        CodexMcpRequest::ListTools { id } => mcp_result(id, json!({ "tools": host.tools() })),
        CodexMcpRequest::ListResources { id } => {
            mcp_result(id, json!({ "resources": caffold_mcp_resources() }))
        }
        CodexMcpRequest::ReadResource { id, uri } => {
            if uri == CAFFOLD_MCP_SESSION_READY_URI {
                mcp_result(id, mcp_resource_result(&uri))
            } else {
                mcp_error(id, -32602, "Caffold does not serve that MCP resource.")
            }
        }
        CodexMcpRequest::CallTool {
            id,
            tool,
            arguments,
        } => {
            let CodexMcpSessionAuthorization::Thread(thread_id) = authorization else {
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
                CodexNotification, CodexRuntimeEvent, CodexServerRequest, CodexThreadClient,
                CodexTurnOptions, MockCodexResponse, NORMAL_SERVICE_TIER_ID, SocketAppServer,
                inspect_codex_installation,
            },
        },
        app::tasks::{events::TaskEvents, sessions::TaskSessions},
        task_store::{ManagedThread, RunBy, TaskStore},
    };
    use tokio::sync::broadcast;

    struct TestSession {
        binding: String,
        session: String,
    }

    async fn request(host: &CodexMcpHost, token: Option<&str>, body: Value) -> Response {
        request_with_session(host, token, None, body).await
    }

    async fn request_with_session(
        host: &CodexMcpHost,
        token: Option<&str>,
        session: Option<&str>,
        body: Value,
    ) -> Response {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/codex/mcp")
            .header("content-type", "application/json");
        if let Some(token) = token {
            builder = builder.header(CAFFOLD_MCP_BINDING_HEADER, token);
        }
        if let Some(session) = session {
            builder = builder.header("mcp-session-id", session);
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

    async fn initialize(host: &CodexMcpHost, binding: &str) -> Response {
        request(
            host,
            Some(binding),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": { "protocolVersion": "2025-06-18" },
            }),
        )
        .await
    }

    fn session_header(response: &Response) -> String {
        response
            .headers()
            .get(MCP_SESSION_ID_HEADER)
            .and_then(|value| value.to_str().ok())
            .expect("initialize response carries an MCP session")
            .to_string()
    }

    async fn bind_thread(host: &CodexMcpHost, thread_id: &str) -> TestSession {
        let binding = host.bindings.begin_reattach(thread_id).await.unwrap();
        let provisional = session_header(&initialize(host, &binding).await);
        host.bindings
            .commit_reattach(&binding, thread_id)
            .await
            .unwrap();
        let expired = request_with_session(
            host,
            Some(&binding),
            Some(&provisional),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "resources/read",
                "params": { "uri": CAFFOLD_MCP_SESSION_READY_URI },
            }),
        )
        .await;
        assert_eq!(expired.status(), StatusCode::NOT_FOUND);
        let session = session_header(&initialize(host, &binding).await);
        let ready = request_with_session(
            host,
            Some(&binding),
            Some(&session),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "resources/read",
                "params": { "uri": CAFFOLD_MCP_SESSION_READY_URI },
            }),
        )
        .await;
        assert_eq!(ready.status(), StatusCode::OK);
        host.bindings
            .complete_bootstrap(&binding, thread_id)
            .await
            .unwrap();
        TestSession { binding, session }
    }

    async fn bound_request(host: &CodexMcpHost, auth: &TestSession, body: Value) -> Response {
        request_with_session(host, Some(&auth.binding), Some(&auth.session), body).await
    }

    fn forged_thread_session() -> String {
        format!("s1.{}.{}.{}", "dGhyZWFkXzE", "B".repeat(43), "C".repeat(43))
    }

    async fn start_live_mcp_host(
        address: std::net::SocketAddr,
        state_dir: &std::path::Path,
    ) -> anyhow::Result<(
        CodexMcpHost,
        std::net::SocketAddr,
        broadcast::Sender<()>,
        tokio::task::JoinHandle<std::io::Result<()>>,
    )> {
        let listener = tokio::net::TcpListener::bind(address)
            .await
            .context("bind live MCP endpoint")?;
        let address = listener.local_addr()?;
        let endpoint = format!("http://{address}/api/codex/mcp");
        let host = CodexMcpHost::persistent(endpoint, state_dir.to_path_buf());
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
        Ok((host, address, server_shutdown, server))
    }

    async fn stop_live_mcp_host(
        shutdown: broadcast::Sender<()>,
        mut server: tokio::task::JoinHandle<std::io::Result<()>>,
    ) {
        let _ = shutdown.send(());
        if tokio::time::timeout(std::time::Duration::from_secs(5), &mut server)
            .await
            .is_err()
        {
            server.abort();
            let _ = server.await;
        }
    }

    #[tokio::test]
    async fn discovery_accepts_only_a_caffold_issued_binding() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let token = host.bindings.begin_pending().await.unwrap();
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
        let initialized = request(&host, Some(&token), initialize).await;
        let session = session_header(&initialized);
        let response = response_json(initialized).await;
        assert_eq!(response["result"]["serverInfo"]["name"], "caffold");
        let instructions = response["result"]["instructions"]
            .as_str()
            .expect("every Codex MCP attachment carries the plan convention");
        assert!(instructions.contains(".caffold/plans/current/PLAN.md"));
        assert!(instructions.contains(".caffold/plans/current/CHECKLIST.md"));
        assert!(instructions.contains("Do not create these files merely"));
        assert!(instructions.contains("Checked items do not by themselves resolve"));
        assert!(!instructions.contains("collaborationMode"));

        let response = response_json(
            request_with_session(
                &host,
                Some(&token),
                Some(&session),
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
    async fn a_new_thread_promotes_its_bootstrap_session_before_task_tools_are_authorized() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let binding = host.bindings.begin_pending().await.unwrap();
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-06-18" },
        });

        let provisional = request(&host, Some(&binding), initialize.clone()).await;
        assert_eq!(provisional.status(), StatusCode::OK);
        let provisional_session = provisional
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .expect("initialize issues a provisional MCP session")
            .to_string();

        host.bindings
            .bind_pending(&binding, "thread_1")
            .await
            .unwrap();
        let expired = request_with_session(
            &host,
            Some(&binding),
            Some(&provisional_session),
            json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "resources/read",
                "params": { "uri": "caffold://session/ready" },
            }),
        )
        .await;
        assert_eq!(expired.status(), StatusCode::NOT_FOUND);

        let promoted = request(&host, Some(&binding), initialize).await;
        assert_eq!(promoted.status(), StatusCode::OK);
        let thread_session = session_header(&promoted);
        assert_ne!(thread_session, provisional_session);

        let ready = request_with_session(
            &host,
            Some(&binding),
            Some(&thread_session),
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "resources/read",
                "params": { "uri": "caffold://session/ready" },
            }),
        )
        .await;
        assert_eq!(ready.status(), StatusCode::OK);
        assert_eq!(
            response_json(ready).await["result"]["contents"][0]["text"],
            "ready"
        );
        host.bindings
            .complete_bootstrap(&binding, "thread_1")
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn authenticated_transport_handles_non_tool_mcp_frames() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let token = host.bindings.begin_pending().await.unwrap();
        let session = session_header(&initialize(&host, &token).await);

        let malformed = response_json(
            request_with_session(&host, Some(&token), Some(&session), json!([])).await,
        )
        .await;
        assert_eq!(malformed["error"]["code"], -32600);

        let notification = request_with_session(
            &host,
            Some(&token),
            Some(&session),
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        )
        .await;
        assert_eq!(notification.status(), StatusCode::ACCEPTED);

        let ping = response_json(
            request_with_session(
                &host,
                Some(&token),
                Some(&session),
                json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" }),
            )
            .await,
        )
        .await;
        assert_eq!(ping["result"], json!({}));

        let resources = response_json(
            request_with_session(
                &host,
                Some(&token),
                Some(&session),
                json!({ "jsonrpc": "2.0", "id": 8, "method": "resources/list" }),
            )
            .await,
        )
        .await;
        assert_eq!(
            resources["result"]["resources"][0]["uri"],
            CAFFOLD_MCP_SESSION_READY_URI
        );

        let unknown_resource = response_json(
            request_with_session(
                &host,
                Some(&token),
                Some(&session),
                json!({
                    "jsonrpc": "2.0",
                    "id": 9,
                    "method": "resources/read",
                    "params": { "uri": "caffold://unknown" },
                }),
            )
            .await,
        )
        .await;
        assert_eq!(unknown_resource["error"]["code"], -32602);

        let unsupported = response_json(
            request_with_session(
                &host,
                Some(&token),
                Some(&session),
                json!({ "jsonrpc": "2.0", "id": 10, "method": "prompts/list" }),
            )
            .await,
        )
        .await;
        assert_eq!(unsupported["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn every_task_scoped_tool_uses_the_same_transport_authentication() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());

        for tool in caffold_mcp_tools() {
            let call = json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": tool["name"],
                    "arguments": {},
                },
            });
            assert_eq!(
                request(&host, None, call.clone()).await.status(),
                StatusCode::UNAUTHORIZED
            );
            assert_eq!(
                request(&host, Some("not-a-caffold-capability"), call)
                    .await
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }

    #[tokio::test]
    async fn an_unavailable_codex_store_does_not_prevent_host_startup_and_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let obstacle = root.path().join("not-a-directory");
        std::fs::write(&obstacle, b"occupied").unwrap();
        let host = CodexMcpHost::persistent(
            "http://127.0.0.1:5177/api/codex/mcp".to_string(),
            obstacle.join("codex-mcp"),
        );
        let list_tools = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });

        assert_eq!(
            request(&host, None, list_tools.clone()).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_with_session(
                &host,
                Some(&format!("p1.{}", "a".repeat(64))),
                Some(&forged_thread_session()),
                list_tools,
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn a_malformed_external_header_does_not_initialize_codex_storage() {
        let root = tempfile::tempdir().unwrap();
        let state_dir = root.path().join("codex-mcp");
        let host = CodexMcpHost::persistent(
            "http://127.0.0.1:5177/api/codex/mcp".to_string(),
            state_dir.clone(),
        );

        assert_eq!(
            request(
                &host,
                Some("not-a-caffold-capability"),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert!(
            !state_dir.exists(),
            "an obviously invalid external request must not activate Codex-only state"
        );
    }

    #[tokio::test]
    async fn a_claude_only_task_does_not_open_codex_capability_storage() {
        let root = tempfile::tempdir().unwrap();
        let state_dir = root.path().join("codex-mcp");
        let host = CodexMcpHost::persistent(
            "http://127.0.0.1:5177/api/codex/mcp".to_string(),
            state_dir.clone(),
        );
        let store = TaskStore::memory().unwrap();
        let thread_id = "claude-only-thread";
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
        let runtime = TaskRuntime::new(
            ClaudeClient::mock().0,
            TaskSessions::default(),
            TaskEvents::default(),
            store,
            shutdown,
        )
        .with_codex_mcp(host.bindings());

        runtime
            .task_agent(thread_id)
            .await
            .expect("a Claude Task resolves without Codex readiness or MCP state");

        assert!(
            !state_dir.exists(),
            "using Caffold only through Claude must not initialize Codex capability storage"
        );
    }

    #[tokio::test]
    async fn an_existing_binding_survives_a_backend_generation_replacement() {
        let endpoint = "http://127.0.0.1:5177/api/codex/mcp";
        let state = tempfile::tempdir().unwrap();
        let first_host = CodexMcpHost::persistent(endpoint.to_string(), state.path().to_path_buf());
        let auth = bind_thread(&first_host, "thread_1").await;
        let list_tools = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });

        assert_eq!(
            bound_request(&first_host, &auth, list_tools.clone())
                .await
                .status(),
            StatusCode::OK
        );

        let replacement_host =
            CodexMcpHost::persistent(endpoint.to_string(), state.path().to_path_buf());
        assert_eq!(
            bound_request(&replacement_host, &auth, list_tools)
                .await
                .status(),
            StatusCode::OK,
            "a backend replacement must retain the exact Task capability used by the live MCP client"
        );
    }

    #[tokio::test]
    async fn another_installations_capability_is_rejected() {
        let endpoint = "http://127.0.0.1:5177/api/codex/mcp";
        let first_state = tempfile::tempdir().unwrap();
        let other_state = tempfile::tempdir().unwrap();
        let first =
            CodexMcpHost::persistent(endpoint.to_string(), first_state.path().to_path_buf());
        let other =
            CodexMcpHost::persistent(endpoint.to_string(), other_state.path().to_path_buf());
        let auth = bind_thread(&first, "thread_1").await;

        assert_eq!(
            request_with_session(
                &other,
                Some(&auth.binding),
                Some(&auth.session),
                json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }),
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn binding_and_session_headers_are_not_independently_authorizing() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let first = bind_thread(&host, "thread_1").await;
        let second = bind_thread(&host, "thread_2").await;
        let list_tools = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });

        assert_eq!(
            request(&host, Some(&first.binding), list_tools.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_with_session(&host, None, Some(&first.session), list_tools.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_with_session(
                &host,
                Some(&first.binding),
                Some(&second.session),
                list_tools.clone(),
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request_with_session(
                &host,
                Some(&first.binding),
                Some(&forged_thread_session()),
                list_tools,
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }

    #[tokio::test]
    async fn reattachment_keeps_old_connections_alive_until_task_deletion() {
        let endpoint = "http://127.0.0.1:5177/api/codex/mcp";
        let state = tempfile::tempdir().unwrap();
        let first = CodexMcpHost::persistent(endpoint.to_string(), state.path().to_path_buf());
        let old = bind_thread(&first, "thread_1").await;
        let replacement =
            CodexMcpHost::persistent(endpoint.to_string(), state.path().to_path_buf());
        let current = bind_thread(&replacement, "thread_1").await;
        let list_tools = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" });

        for auth in [&old, &current] {
            assert_eq!(
                bound_request(&replacement, auth, list_tools.clone())
                    .await
                    .status(),
                StatusCode::OK
            );
        }

        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1,
            )
            .unwrap();
        let client = CodexThreadClient::mock(Vec::new());
        let (shutdown, _) = broadcast::channel(1);
        let runtime = TaskRuntime::new(
            ClaudeClient::mock().0,
            TaskSessions::default(),
            TaskEvents::default(),
            store.clone(),
            shutdown,
        );
        runtime.install_test_client(1, client.clone()).await;
        replacement.attach_runtime(runtime);
        assert!(store.delete("thread_1").unwrap());

        for auth in [&old, &current] {
            let response = response_json(
                bound_request(
                    &replacement,
                    auth,
                    json!({
                        "jsonrpc": "2.0",
                        "id": 3,
                        "method": "tools/call",
                        "params": {
                            "name": "rename_current_task",
                            "arguments": { "name": "Must not be applied" },
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
                    .contains("only rename tasks that it manages")
            );
        }
        assert!(client.mock_requests().await.is_empty());
    }

    #[tokio::test]
    async fn a_pending_connection_cannot_execute_a_task_tool() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let token = host.bindings.begin_pending().await.unwrap();
        let session = session_header(&initialize(&host, &token).await);
        let response = response_json(
            request_with_session(
                &host,
                Some(&token),
                Some(&session),
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
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let auth = bind_thread(&host, "thread_1").await;
        let response = response_json(
            bound_request(
                &host,
                &auth,
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
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
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
        let auth = bind_thread(&host, "thread_1").await;

        let response = response_json(
            bound_request(
                &host,
                &auth,
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
            bound_request(
                &host,
                &auth,
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
    async fn a_binding_cannot_be_redirected_by_model_supplied_task_identity() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let store = TaskStore::memory().unwrap();
        for thread_id in ["thread_1", "thread_2"] {
            store
                .claim(
                    ManagedThread::new(thread_id, RunBy::Codex, None, None, None),
                    1,
                )
                .unwrap();
        }
        let client = CodexThreadClient::mock(Vec::new());
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
        let auth = bind_thread(&host, "thread_1").await;

        let response = response_json(
            bound_request(
                &host,
                &auth,
                json!({
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "rename_current_task",
                        "arguments": {
                            "name": "Redirected",
                            "threadId": "thread_2",
                        },
                    },
                }),
            )
            .await,
        )
        .await;

        assert_eq!(response["result"]["isError"], true);
        assert!(client.mock_requests().await.is_empty());
        assert_ne!(
            store.get("thread_1").unwrap().unwrap().display_name,
            "Redirected"
        );
        assert_ne!(
            store.get("thread_2").unwrap().unwrap().display_name,
            "Redirected"
        );
    }

    #[tokio::test]
    async fn a_deleted_task_cannot_be_mutated_through_an_older_session() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1,
            )
            .unwrap();
        let client = CodexThreadClient::mock(Vec::new());
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
        let auth = bind_thread(&host, "thread_1").await;
        assert!(store.delete("thread_1").unwrap());

        let response = response_json(
            bound_request(
                &host,
                &auth,
                json!({
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "rename_current_task",
                        "arguments": { "name": "Must not be applied" },
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
                .contains("only rename tasks that it manages")
        );
        assert!(client.mock_requests().await.is_empty());
    }

    #[tokio::test]
    async fn an_archived_task_cannot_be_mutated_through_an_older_session() {
        let host = CodexMcpHost::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1,
            )
            .unwrap();
        let client = CodexThreadClient::mock(Vec::new());
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
        let auth = bind_thread(&host, "thread_1").await;
        store.archive("thread_1", 2).unwrap().unwrap();

        let response = response_json(
            bound_request(
                &host,
                &auth,
                json!({
                    "jsonrpc": "2.0",
                    "id": 4,
                    "method": "tools/call",
                    "params": {
                        "name": "isolate_current_task",
                        "arguments": {
                            "taskName": "Must not be applied",
                            "branchName": "must-not-be-applied",
                        },
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
                .contains("only isolate a task that it manages")
        );
        assert!(client.mock_requests().await.is_empty());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires an authenticated installed Codex app-server"]
    async fn live_codex_mcp_survives_backend_replacement_and_runtime_reattachment() {
        use anyhow::ensure;
        use tokio::time::timeout;

        let root = tempfile::tempdir()
            .context("create live MCP test root")
            .unwrap();
        let project = root.path().join("project");
        let capability_state = root.path().join("codex-mcp");
        std::fs::create_dir(&project)
            .context("create live MCP test project")
            .unwrap();
        let (host, address, server_shutdown, server) = start_live_mcp_host(
            std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
            &capability_state,
        )
        .await
        .expect("start the first live MCP host");
        let bindings = host.bindings();
        let mut active_server = Some((server_shutdown, server));

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
        let result: anyhow::Result<()> = async {
            let started = client
                .start_thread(
                    project.to_str().context("live project path is not UTF-8")?,
                    None,
                    NORMAL_SERVICE_TIER_ID,
                )
                .await
                .context("start live MCP-backed Codex thread")?;
            let thread_id = started.thread_id.clone();
            created_thread_id = Some(thread_id.clone());
            store.claim(
                ManagedThread::new(&thread_id, RunBy::Codex, None, None, None),
                1,
            )?;

            let bootstrap_call = client
                .call_mcp_tool_for_test(
                    &thread_id,
                    "rename_current_task",
                    json!({ "name": "Live Caffold MCP bootstrap verified" }),
                )
                .await
                .context("call Caffold MCP immediately after session promotion")?;
            ensure!(
                bootstrap_call["content"][0]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("bootstrap verified")),
                "promoted MCP session returned an unexpected result: {bootstrap_call}"
            );

            let first = client
                .mcp_server_status_for_test(&thread_id)
                .await
                .context("read initial live MCP inventory")?;
            let first_status = first.to_string();
            ensure!(
                !first_status.contains(CAFFOLD_MCP_BINDING_HEADER)
                    && !first_status.contains("\"p1.")
                    && !first_status.contains("\"b1.")
                    && !first_status.contains("\"s1."),
                "Codex MCP status exposed Caffold's header capability"
            );

            // Materialize the provider thread and prove that its first tool
            // connection uses Caffold's MCP catalog rather than a legacy
            // dynamic-tool fallback.
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
            let provider_history = serde_json::to_string(&first_renamed)?;
            ensure!(
                !provider_history.contains(CAFFOLD_MCP_BINDING_HEADER)
                    && !provider_history.contains("\"p1.")
                    && !provider_history.contains("\"b1.")
                    && !provider_history.contains("\"s1."),
                "provider thread history exposed Caffold's header capability"
            );

            // Replace only Caffold's HTTP/backend generation. The provider
            // thread, proxy, and its already initialized MCP client remain
            // alive and keep the original header and endpoint.
            let (shutdown, server) = active_server
                .take()
                .context("first live MCP host was not running")?;
            stop_live_mcp_host(shutdown, server).await;
            let (replacement_host, replacement_address, shutdown, server) =
                start_live_mcp_host(address, &capability_state)
                    .await
                    .context("start the replacement live MCP host on the original endpoint")?;
            ensure!(replacement_address == address, "replacement MCP endpoint changed");
            active_server = Some((shutdown, server));
            let (replacement_shutdown, _) = broadcast::channel(1);
            let replacement_runtime = TaskRuntime::new(
                ClaudeClient::mock().0,
                TaskSessions::default(),
                TaskEvents::default(),
                store.clone(),
                replacement_shutdown,
            );
            replacement_runtime
                .install_test_client(1, client.clone())
                .await;
            replacement_host.attach_runtime(replacement_runtime.clone());

            let survived = client
                .call_mcp_tool_for_test(
                    &thread_id,
                    "rename_current_task",
                    json!({ "name": "Live Caffold MCP backend survived" }),
                )
                .await
                .context("call through the pre-replacement MCP connection")?;
            ensure!(
                survived["content"][0]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("backend survived")),
                "pre-replacement MCP connection returned an unexpected result: {survived}"
            );

            // Reattach through a second proxy without closing the first one.
            // Both capability generations must overlap until Task deletion.
            let next_client = CodexThreadClient::start_with_installation_and_mcp(
                &installation,
                replacement_host.bindings(),
            )
            .await
            .context("connect a replacement Codex app-server proxy")?;
            cleanup_client = next_client.clone();
            replacement_runtime
                .install_test_client(2, next_client.clone())
                .await;
            next_client
                .resume_thread_with_page(&thread_id, false, NORMAL_SERVICE_TIER_ID)
                .await
                .context("resume through the replacement Caffold MCP generation")?;

            let called = next_client
                .call_mcp_tool_for_test(
                    &thread_id,
                    "rename_current_task",
                    json!({ "name": "Live Caffold MCP reattached" }),
                )
                .await
                .context("call through the reattached MCP connection")?;
            ensure!(
                called["content"][0]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("reattached")),
                "reattached MCP call returned an unexpected result: {called}"
            );
            let overlap = client
                .call_mcp_tool_for_test(
                    &thread_id,
                    "rename_current_task",
                    json!({ "name": "Live Caffold MCP overlap verified" }),
                )
                .await
                .context("call again through the older live MCP connection")?;
            ensure!(
                overlap["content"][0]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("overlap verified")),
                "older live MCP connection was revoked during reattach: {overlap}"
            );
            ensure!(
                next_client
                    .read_thread(&thread_id)
                    .await
                    .context("read thread after overlapping MCP calls")?
                    .name
                    .as_deref()
                    == Some("Live Caffold MCP overlap verified"),
                "overlapping live MCP call did not rename the provider thread"
            );
            eprintln!("LIVE_CODEX_MCP thread={thread_id}");
            Ok(())
        }
        .await;

        let cleanup_result = match created_thread_id {
            Some(thread_id) => cleanup_client
                .delete_thread(&thread_id)
                .await
                .context("delete live backend-replacement test thread"),
            None => Ok(()),
        };
        cleanup_client.shutdown().await;
        client.shutdown().await;
        if let Some((shutdown, server)) = active_server {
            stop_live_mcp_host(shutdown, server).await;
        }
        result.expect("live Caffold-owned Codex MCP replacement contract");
        cleanup_result.expect("clean up live backend-replacement test thread");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires authenticated Codex; restarts only a test-owned app-server"]
    async fn live_codex_mcp_survives_an_isolated_app_server_restart() {
        use anyhow::ensure;
        use tokio::time::timeout;

        let root = tempfile::tempdir()
            .context("create runtime-restart MCP test root")
            .unwrap();
        let project = root.path().join("project");
        let capability_state = root.path().join("codex-mcp");
        std::fs::create_dir(&project)
            .context("create runtime-restart MCP project")
            .unwrap();
        let (host, _, server_shutdown, server) = start_live_mcp_host(
            std::net::SocketAddr::from(([127, 0, 0, 1], 0)),
            &capability_state,
        )
        .await
        .expect("start runtime-restart MCP host");
        let mut app_server = SocketAppServer::start()
            .await
            .expect("start isolated Codex app-server");
        let installation = inspect_codex_installation()
            .await
            .expect("inspect Codex for isolated runtime-restart test");
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
        let client = CodexThreadClient::start_with_installation_and_mcp_at_socket(
            &installation,
            &app_server.socket_path,
            host.bindings(),
        )
        .await
        .expect("connect to isolated Codex app-server");
        runtime.install_test_client(1, client.clone()).await;

        let mut created_thread_id = None;
        let mut cleanup_client = client.clone();
        let result: anyhow::Result<()> = async {
            let cwd = project
                .to_str()
                .context("runtime-restart project path is not UTF-8")?;
            let started = client
                .start_thread(cwd, None, NORMAL_SERVICE_TIER_ID)
                .await
                .context("start isolated runtime MCP thread")?;
            let thread_id = started.thread_id;
            created_thread_id = Some(thread_id.clone());
            store.claim(
                ManagedThread::new(&thread_id, RunBy::Codex, None, None, None),
                1,
            )?;

            let mut events = client.subscribe();
            client
                .start_turn(
                    &thread_id,
                    cwd,
                    "Use rename_current_task to rename this Caffold task to exactly \"Live MCP before runtime restart\". You must call the tool. Then reply with exactly MCP-RUNTIME-READY. Do not run commands or modify files.",
                    &[],
                    CodexTurnOptions {
                        service_tier: Some(NORMAL_SERVICE_TIER_ID.to_string()),
                        ..CodexTurnOptions::default()
                    },
                )
                .await
                .context("materialize isolated runtime MCP thread")?;
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
                                            "text": "This thread must use Caffold MCP."
                                        }],
                                        "success": false,
                                    }),
                                )
                                .await?;
                            break Err(anyhow::anyhow!(
                                "isolated runtime thread requested a legacy dynamic tool"
                            ));
                        }
                        Ok(CodexRuntimeEvent::ServerRequest(request)) => break Err(anyhow::anyhow!(
                            "unexpected server request before isolated runtime restart: {request:?}"
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
            .context("wait for isolated runtime materialization turn")??;

            client.shutdown().await;
            app_server
                .restart()
                .await
                .context("restart only the test-owned Codex app-server")?;
            let replacement = CodexThreadClient::start_with_installation_and_mcp_at_socket(
                &installation,
                &app_server.socket_path,
                host.bindings(),
            )
            .await
            .context("connect after isolated Codex app-server restart")?;
            cleanup_client = replacement.clone();
            runtime.install_test_client(2, replacement.clone()).await;
            replacement
                .resume_thread_with_page(&thread_id, false, NORMAL_SERVICE_TIER_ID)
                .await
                .context("resume MCP thread after isolated app-server restart")?;
            let called = replacement
                .call_mcp_tool_for_test(
                    &thread_id,
                    "rename_current_task",
                    json!({ "name": "Live MCP after runtime restart" }),
                )
                .await
                .context("call Caffold MCP after isolated app-server restart")?;
            ensure!(
                called["content"][0]["text"]
                    .as_str()
                    .is_some_and(|text| text.contains("after runtime restart")),
                "runtime-restarted MCP call returned an unexpected result: {called}"
            );
            ensure!(
                replacement
                    .read_thread(&thread_id)
                    .await
                    .context("read thread after isolated runtime restart")?
                    .name
                    .as_deref()
                    == Some("Live MCP after runtime restart"),
                "runtime-restarted MCP call did not affect the original Task"
            );
            eprintln!("LIVE_CODEX_MCP_RUNTIME_RESTART thread={thread_id}");
            Ok(())
        }
        .await;

        let cleanup_result = match created_thread_id {
            Some(thread_id) => cleanup_client
                .delete_thread(&thread_id)
                .await
                .context("delete live runtime-restart test thread"),
            None => Ok(()),
        };
        cleanup_client.shutdown().await;
        client.shutdown().await;
        app_server.stop().await;
        stop_live_mcp_host(server_shutdown, server).await;
        result.expect("live Caffold MCP isolated runtime-restart contract");
        cleanup_result.expect("clean up live runtime-restart test thread");
    }
}
