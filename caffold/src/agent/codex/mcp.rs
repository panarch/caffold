//! The Caffold-owned MCP server as one thread sees it.
//!
//! Codex's `dynamicTools` are fixed when a thread is created. An HTTP MCP
//! server gives Caffold a server-owned tool catalog that a new connection or
//! resume can discover without removing those persisted tools. Every
//! attachment carries a private binding header and a server-issued MCP session:
//! the transport itself does not tell its server which Codex thread made a
//! call, so trusting a model-supplied thread id would let a call name another
//! Task.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex, OnceLock},
};

use serde_json::{Value, json};
use uuid::Uuid;

mod capability;

use capability::{CapabilitySigner, looks_like_thread_session};

pub(crate) const CAFFOLD_MCP_SERVER_NAME: &str = "caffold";
pub(crate) const CAFFOLD_MCP_BINDING_HEADER: &str = "x-caffold-mcp-binding";
pub(crate) const MCP_SESSION_ID_HEADER: &str = "mcp-session-id";
pub(crate) const CAFFOLD_MCP_SESSION_READY_URI: &str = "caffold://session/ready";
const CURRENT_MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_MCP_PROTOCOL_VERSIONS: [&str; 2] = ["2025-06-18", "2025-03-26"];

/// One request received on the Caffold MCP transport.
///
/// MCP framing stays inside the Codex driver. The Tasks application sees only
/// the operation it must serve and the Caffold-owned tool call it may need to
/// execute.
#[derive(Debug)]
pub(crate) enum CodexMcpRequest {
    Notification,
    Initialize {
        id: Value,
        protocol_version: String,
    },
    Ping {
        id: Value,
    },
    ListTools {
        id: Value,
    },
    ListResources {
        id: Value,
    },
    ReadResource {
        id: Value,
        uri: String,
    },
    CallTool {
        id: Value,
        tool: String,
        arguments: Value,
    },
    Unsupported {
        id: Value,
        method: String,
    },
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CodexMcpBindingTarget {
    Pending,
    Thread(String),
}

#[derive(Default)]
struct BindingState {
    bootstraps: HashMap<String, BootstrapBinding>,
}

struct BootstrapBinding {
    provisional_session: String,
    phase: BootstrapPhase,
}

/// The complete process-local control graph for one MCP attachment.
///
/// `thread/start` moves `PendingStart -> Ready`, while a successful
/// `thread/resume` moves `Reattaching -> Ready`. Cancellation removes either
/// candidate, and a confirmed readiness read removes `Ready`. MCP initialize
/// returns the provisional session before `Ready` and a signed session after
/// it; no other phase edge is accepted.
enum BootstrapPhase {
    PendingStart,
    Reattaching(String),
    Ready(String),
}

struct CodexMcpBindingsInner {
    endpoint: String,
    state: StdMutex<BindingState>,
    signer: SignerBackend,
}

enum SignerBackend {
    Memory(CapabilitySigner),
    Persistent(Arc<PersistentSignerBackend>),
}

struct PersistentSignerBackend {
    state_dir: PathBuf,
    signer: OnceLock<CapabilitySigner>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CodexMcpSessionAuthorization {
    Unauthorized,
    Pending,
    Thread(String),
    Expired,
}

/// Authenticated identities for Caffold's Codex MCP clients.
///
/// Every app-server attachment receives a private binding header before Codex
/// starts or resumes its provider thread. The process keeps that binding only
/// through bootstrap. Once the provider id is known and the attachment has
/// succeeded, MCP reinitialization promotes it to a signed `P + S` session.
/// Only the signing key is persisted; no Task or connection capability record
/// is written to Caffold storage.
#[derive(Clone)]
pub(crate) struct CodexMcpBindings {
    inner: Arc<CodexMcpBindingsInner>,
}

impl CodexMcpBindings {
    pub(crate) fn memory(endpoint: String) -> Self {
        Self {
            inner: Arc::new(CodexMcpBindingsInner {
                endpoint,
                state: StdMutex::new(BindingState::default()),
                signer: SignerBackend::Memory(CapabilitySigner::memory()),
            }),
        }
    }

    /// Configure installation-local persistence without touching the filesystem.
    ///
    /// Caffold can run without Codex, including as a Claude-only service. The
    /// signer is therefore opened only when a Codex thread needs to issue or
    /// validate a session. Signer failures stay scoped to that Codex
    /// operation and fail authentication closed.
    pub(crate) fn persistent(endpoint: String, state_dir: PathBuf) -> Self {
        Self {
            inner: Arc::new(CodexMcpBindingsInner {
                endpoint,
                state: StdMutex::new(BindingState::default()),
                signer: SignerBackend::Persistent(Arc::new(PersistentSignerBackend {
                    state_dir,
                    signer: OnceLock::new(),
                })),
            }),
        }
    }

    /// Reserve an identity before Codex has returned the new thread id.
    pub(crate) async fn begin_pending(&self) -> Result<String, String> {
        Ok(self.begin_bootstrap(BootstrapPhase::PendingStart))
    }

    /// Make a successful `thread/start` bootstrap ready for session promotion.
    pub(crate) async fn bind_pending(&self, token: &str, thread_id: &str) -> Result<(), String> {
        let mut state = self.state();
        let Some(bootstrap) = state.bootstraps.get_mut(token) else {
            return Err("Codex MCP binding is no longer pending.".to_string());
        };
        if !matches!(&bootstrap.phase, BootstrapPhase::PendingStart) {
            return Err("Codex MCP binding is no longer pending.".to_string());
        }
        bootstrap.phase = BootstrapPhase::Ready(thread_id.to_string());
        Ok(())
    }

    /// Stage another bootstrap while Codex is being re-attached.
    ///
    /// A changed header makes the request-scoped MCP config observably new to
    /// app-server. The previous capability remains valid throughout; a failed
    /// transport request discards only this candidate.
    pub(crate) async fn begin_reattach(&self, thread_id: &str) -> Result<String, String> {
        Ok(self.begin_bootstrap(BootstrapPhase::Reattaching(thread_id.to_string())))
    }

    /// Make a successful `thread/resume` bootstrap ready for promotion.
    ///
    /// Previously promoted sessions are self-contained and remain valid for
    /// potentially overlapping live connections.
    pub(crate) async fn commit_reattach(&self, token: &str, thread_id: &str) -> Result<(), String> {
        let mut state = self.state();
        let Some(bootstrap) = state.bootstraps.get_mut(token) else {
            return Err("Codex MCP reattachment is no longer pending.".to_string());
        };
        if !matches!(
            &bootstrap.phase,
            BootstrapPhase::Reattaching(target) if target == thread_id
        ) {
            return Err("Codex MCP reattachment is no longer pending.".to_string());
        }
        bootstrap.phase = BootstrapPhase::Ready(thread_id.to_string());
        Ok(())
    }

    /// Forget only the bootstrap belonging to a failed resume attempt.
    pub(crate) async fn cancel_reattach(&self, token: &str, thread_id: &str) -> Result<(), String> {
        let mut state = self.state();
        if state.bootstraps.get(token).is_some_and(|bootstrap| {
            matches!(
                &bootstrap.phase,
                BootstrapPhase::Reattaching(target) | BootstrapPhase::Ready(target)
                    if target == thread_id
            )
        }) {
            state.bootstraps.remove(token);
        }
        Ok(())
    }

    pub(crate) async fn cancel_pending(&self, token: &str) -> Result<(), String> {
        self.state().bootstraps.remove(token);
        Ok(())
    }

    /// Drop the short-lived process state after Codex has adopted the signed
    /// session and successfully retried Caffold's readiness resource.
    pub(crate) async fn complete_bootstrap(
        &self,
        token: &str,
        thread_id: &str,
    ) -> Result<(), String> {
        let mut state = self.state();
        if !state.bootstraps.get(token).is_some_and(|bootstrap| {
            matches!(&bootstrap.phase, BootstrapPhase::Ready(target) if target == thread_id)
        }) {
            return Err("Codex MCP session promotion is no longer pending.".to_string());
        }
        state.bootstraps.remove(token);
        Ok(())
    }

    /// Issue the transport session returned by an MCP `initialize` response.
    pub(crate) async fn initialize_session(&self, binding: &str) -> Option<String> {
        let target = {
            let state = self.state();
            let bootstrap = state.bootstraps.get(binding)?;
            match &bootstrap.phase {
                BootstrapPhase::PendingStart | BootstrapPhase::Reattaching(_) => {
                    return Some(bootstrap.provisional_session.clone());
                }
                BootstrapPhase::Ready(thread_id) => thread_id.clone(),
            }
        };
        self.issue_thread_session(binding, &target).await.ok()
    }

    /// Authenticate a request after MCP initialization.
    pub(crate) async fn authorize_session(
        &self,
        binding: &str,
        session: &str,
    ) -> CodexMcpSessionAuthorization {
        let provisional = {
            let state = self.state();
            state.bootstraps.get(binding).map(|bootstrap| {
                (
                    bootstrap.provisional_session.clone(),
                    matches!(&bootstrap.phase, BootstrapPhase::Ready(_)),
                )
            })
        };
        if let Some((provisional_session, ready_to_promote)) = provisional
            && session == provisional_session
        {
            return if ready_to_promote {
                CodexMcpSessionAuthorization::Expired
            } else {
                CodexMcpSessionAuthorization::Pending
            };
        }
        if !looks_like_thread_session(session) {
            return CodexMcpSessionAuthorization::Unauthorized;
        }
        match self.resolve_thread_session(binding, session).await {
            Ok(Some(thread_id)) => CodexMcpSessionAuthorization::Thread(thread_id),
            Ok(None) | Err(_) => CodexMcpSessionAuthorization::Unauthorized,
        }
    }

    #[cfg(test)]
    pub(crate) async fn resolve(&self, token: &str) -> Option<CodexMcpBindingTarget> {
        self.state()
            .bootstraps
            .get(token)
            .map(|bootstrap| match &bootstrap.phase {
                BootstrapPhase::Ready(thread_id) => {
                    CodexMcpBindingTarget::Thread(thread_id.clone())
                }
                BootstrapPhase::PendingStart | BootstrapPhase::Reattaching(_) => {
                    CodexMcpBindingTarget::Pending
                }
            })
    }

    /// Request-scoped Codex config that adds only Caffold's own MCP entry.
    ///
    /// The dotted key preserves every MCP server the user configured. The
    /// token is an HTTP header instead of a URL component so ordinary access
    /// logs do not record it.
    pub(crate) fn thread_config(&self, token: &str) -> HashMap<String, Value> {
        HashMap::from([(
            format!("mcp_servers.{CAFFOLD_MCP_SERVER_NAME}"),
            json!({
                "url": self.inner.endpoint,
                "http_headers": {
                    CAFFOLD_MCP_BINDING_HEADER: token,
                },
                "default_tools_approval_mode": "approve",
                "required": true,
                "startup_timeout_ms": 10_000,
                "tool_timeout_sec": 300.0,
                "supports_parallel_tool_calls": false,
            }),
        )])
    }

    fn begin_bootstrap(&self, phase: BootstrapPhase) -> String {
        let binding = opaque_transport_value("p1");
        let bootstrap = BootstrapBinding {
            provisional_session: opaque_transport_value("b1"),
            phase,
        };
        self.state().bootstraps.insert(binding.clone(), bootstrap);
        binding
    }

    fn state(&self) -> std::sync::MutexGuard<'_, BindingState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn issue_thread_session(&self, binding: &str, thread_id: &str) -> Result<String, String> {
        match &self.inner.signer {
            SignerBackend::Memory(signer) => signer
                .issue_thread_session(binding, thread_id)
                .map_err(|error| error.to_string()),
            SignerBackend::Persistent(backend) => {
                let binding = binding.to_string();
                let thread_id = thread_id.to_string();
                run_signer(backend.clone(), move |signer| {
                    signer.issue_thread_session(&binding, &thread_id)
                })
                .await
            }
        }
    }

    async fn resolve_thread_session(
        &self,
        binding: &str,
        session: &str,
    ) -> Result<Option<String>, String> {
        match &self.inner.signer {
            SignerBackend::Memory(signer) => Ok(signer.resolve_thread_session(binding, session)),
            SignerBackend::Persistent(backend) => {
                let binding = binding.to_string();
                let session = session.to_string();
                run_signer(backend.clone(), move |signer| {
                    Ok(signer.resolve_thread_session(&binding, &session))
                })
                .await
            }
        }
    }
}

impl PersistentSignerBackend {
    fn signer(&self) -> Result<CapabilitySigner, String> {
        if let Some(signer) = self.signer.get() {
            return Ok(signer.clone());
        }

        let opened =
            CapabilitySigner::open(self.state_dir.clone()).map_err(|error| error.to_string())?;
        if self.signer.set(opened.clone()).is_ok() {
            return Ok(opened);
        }

        Ok(self
            .signer
            .get()
            .expect("a concurrent Codex MCP signer initialization completed")
            .clone())
    }
}

async fn run_signer<T, Operation>(
    backend: Arc<PersistentSignerBackend>,
    operation: Operation,
) -> Result<T, String>
where
    T: Send + 'static,
    Operation:
        FnOnce(&CapabilitySigner) -> Result<T, capability::CapabilitySignerError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let signer = backend.signer()?;
        operation(&signer).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Codex MCP signing worker failed: {error}"))?
}

fn opaque_transport_value(prefix: &str) -> String {
    format!(
        "{prefix}.{}{}",
        Uuid::new_v4().simple(),
        Uuid::new_v4().simple()
    )
}

/// Remove Caffold MCP transport identities from provider diagnostics before
/// they can reach ordinary logs or Task-facing error state.
pub(super) fn redact_mcp_capabilities(message: &str) -> String {
    if message
        .as_bytes()
        .windows(CAFFOLD_MCP_BINDING_HEADER.len())
        .any(|candidate| candidate.eq_ignore_ascii_case(CAFFOLD_MCP_BINDING_HEADER.as_bytes()))
    {
        return "[REDACTED CAFFOLD MCP HEADER DIAGNOSTIC]".to_string();
    }

    let mut redacted = message.to_string();
    for prefix in ["p1.", "b1.", "s1."] {
        redacted = redact_transport_values(&redacted, prefix);
    }
    redacted
}

fn redact_transport_values(message: &str, prefix: &str) -> String {
    let mut redacted = String::with_capacity(message.len());
    let mut cursor = 0;
    while let Some(offset) = message[cursor..].find(prefix) {
        let start = cursor + offset;
        redacted.push_str(&message[cursor..start]);
        let scanned_length = message[start..]
            .bytes()
            .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
            .count();
        let recognized_length = (prefix.len()..=scanned_length).rev().find(|length| {
            let candidate = &message[start..start + length];
            match prefix {
                "p1." | "b1." => {
                    candidate.len() == 67
                        && candidate[3..].bytes().all(|byte| byte.is_ascii_hexdigit())
                }
                "s1." => looks_like_thread_session(candidate),
                _ => false,
            }
        });
        if let Some(length) = recognized_length {
            redacted.push_str("[REDACTED CAFFOLD MCP CAPABILITY]");
            cursor = start + length;
        } else {
            redacted.push_str(prefix);
            cursor = start + prefix.len();
        }
    }
    redacted.push_str(&message[cursor..]);
    redacted
}

pub(crate) fn decode_mcp_request(body: &[u8]) -> Result<CodexMcpRequest, Value> {
    let message: Value = match serde_json::from_slice(body) {
        Ok(Value::Object(message)) => Value::Object(message),
        Ok(_) => {
            return Err(mcp_error(
                Value::Null,
                -32600,
                "MCP request must be an object.",
            ));
        }
        Err(_) => {
            return Err(mcp_error(
                Value::Null,
                -32700,
                "MCP request is not valid JSON.",
            ));
        }
    };
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Err(mcp_error(
            message.get("id").cloned().unwrap_or(Value::Null),
            -32600,
            "MCP requests must use JSON-RPC 2.0.",
        ));
    }
    let Some(id) = message.get("id").cloned() else {
        return Ok(CodexMcpRequest::Notification);
    };
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Err(mcp_error(id, -32600, "MCP request has no method."));
    };
    Ok(match method {
        "initialize" => CodexMcpRequest::Initialize {
            id,
            protocol_version: message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .map(negotiated_mcp_protocol_version)
                .unwrap_or(CURRENT_MCP_PROTOCOL_VERSION)
                .to_string(),
        },
        "ping" => CodexMcpRequest::Ping { id },
        "tools/list" => CodexMcpRequest::ListTools { id },
        "resources/list" => CodexMcpRequest::ListResources { id },
        "resources/read" => {
            let Some(uri) = message.pointer("/params/uri").and_then(Value::as_str) else {
                return Err(mcp_error(id, -32602, "MCP resource read has no URI."));
            };
            CodexMcpRequest::ReadResource {
                id,
                uri: uri.to_string(),
            }
        }
        "tools/call" => {
            let Some(tool) = message.pointer("/params/name").and_then(Value::as_str) else {
                return Err(mcp_error(id, -32602, "MCP tool call has no tool name."));
            };
            CodexMcpRequest::CallTool {
                id,
                tool: tool.to_string(),
                arguments: message
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            }
        }
        method => CodexMcpRequest::Unsupported {
            id,
            method: method.to_string(),
        },
    })
}

fn negotiated_mcp_protocol_version(requested: &str) -> &'static str {
    SUPPORTED_MCP_PROTOCOL_VERSIONS
        .into_iter()
        .find(|supported| *supported == requested)
        .unwrap_or(CURRENT_MCP_PROTOCOL_VERSION)
}

pub(crate) fn mcp_initialize_result(protocol_version: &str) -> Value {
    json!({
        "protocolVersion": protocol_version,
        "capabilities": {
            "resources": {},
            "tools": {},
        },
        "serverInfo": {
            "name": CAFFOLD_MCP_SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

pub(crate) fn caffold_mcp_resources() -> Vec<Value> {
    vec![json!({
        "uri": CAFFOLD_MCP_SESSION_READY_URI,
        "name": "Caffold MCP session readiness",
        "description": "Internal readiness probe for a Caffold-owned MCP transport session.",
        "mimeType": "text/plain",
    })]
}

pub(crate) fn mcp_resource_result(uri: &str) -> Value {
    json!({
        "contents": [{
            "uri": uri,
            "mimeType": "text/plain",
            "text": "ready",
        }],
    })
}

pub(crate) fn caffold_mcp_tools() -> Vec<Value> {
    super::served_tools::mcp_tool_specs()
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "description": tool.description,
                "inputSchema": tool.input_schema,
            })
        })
        .collect()
}

pub(crate) fn mcp_tool_result(outcome: Result<String, String>) -> Value {
    let (text, is_error) = match outcome {
        Ok(text) => (text, false),
        Err(text) => (text, true),
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "isError": is_error,
    })
}

pub(crate) fn mcp_result(id: Value, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

pub(crate) fn mcp_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn promote_started_binding(
        bindings: &CodexMcpBindings,
        binding: &str,
        thread_id: &str,
    ) -> (String, String) {
        let provisional = bindings.initialize_session(binding).await.unwrap();
        bindings.bind_pending(binding, thread_id).await.unwrap();
        assert_eq!(
            bindings.authorize_session(binding, &provisional).await,
            CodexMcpSessionAuthorization::Expired
        );
        let session = bindings.initialize_session(binding).await.unwrap();
        bindings
            .complete_bootstrap(binding, thread_id)
            .await
            .unwrap();
        (provisional, session)
    }

    async fn promote_reattached_binding(
        bindings: &CodexMcpBindings,
        binding: &str,
        thread_id: &str,
    ) -> (String, String) {
        let provisional = bindings.initialize_session(binding).await.unwrap();
        bindings.commit_reattach(binding, thread_id).await.unwrap();
        assert_eq!(
            bindings.authorize_session(binding, &provisional).await,
            CodexMcpSessionAuthorization::Expired
        );
        let session = bindings.initialize_session(binding).await.unwrap();
        bindings
            .complete_bootstrap(binding, thread_id)
            .await
            .unwrap();
        (provisional, session)
    }

    #[tokio::test]
    async fn pending_bindings_become_self_contained_thread_sessions() {
        let bindings = CodexMcpBindings::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let binding = bindings.begin_pending().await.unwrap();
        assert_eq!(
            bindings.resolve(&binding).await,
            Some(CodexMcpBindingTarget::Pending)
        );

        let (_, session) = promote_started_binding(&bindings, &binding, "thread_1").await;

        assert_eq!(bindings.resolve(&binding).await, None);
        assert_eq!(
            bindings.authorize_session(&binding, &session).await,
            CodexMcpSessionAuthorization::Thread("thread_1".to_string())
        );
    }

    #[tokio::test]
    async fn persistent_signing_is_lazy_and_codex_scoped() {
        let root = tempfile::tempdir().unwrap();
        let state_dir = root.path().join("codex-mcp");
        let bindings = CodexMcpBindings::persistent(
            "http://127.0.0.1:5177/api/codex/mcp".to_string(),
            state_dir.clone(),
        );

        assert!(
            !state_dir.exists(),
            "constructing Caffold's Codex adapter must not initialize Codex-only state"
        );

        let binding = bindings.begin_pending().await.unwrap();
        let provisional = bindings.initialize_session(&binding).await.unwrap();
        assert!(
            !state_dir.exists(),
            "pending discovery must not initialize the signing key"
        );

        bindings.bind_pending(&binding, "thread_1").await.unwrap();
        assert_eq!(
            bindings.authorize_session(&binding, &provisional).await,
            CodexMcpSessionAuthorization::Expired
        );
        let session = bindings.initialize_session(&binding).await.unwrap();
        assert!(state_dir.is_dir());
        assert_eq!(
            bindings.authorize_session(&binding, &session).await,
            CodexMcpSessionAuthorization::Thread("thread_1".to_string())
        );
    }

    #[tokio::test]
    async fn an_unavailable_signing_key_fails_only_session_promotion() {
        let root = tempfile::tempdir().unwrap();
        let obstacle = root.path().join("not-a-directory");
        std::fs::write(&obstacle, b"occupied").unwrap();
        let state_dir = obstacle.join("codex-mcp");
        let bindings = CodexMcpBindings::persistent(
            "http://127.0.0.1:5177/api/codex/mcp".to_string(),
            state_dir.clone(),
        );

        let binding = bindings.begin_pending().await.unwrap();
        bindings.bind_pending(&binding, "thread_1").await.unwrap();
        assert!(bindings.initialize_session(&binding).await.is_none());

        std::fs::remove_file(&obstacle).unwrap();
        std::fs::create_dir(&obstacle).unwrap();
        assert!(bindings.initialize_session(&binding).await.is_some());
        assert!(
            state_dir.is_dir(),
            "a later Codex promotion can retry signing-key access"
        );
    }

    #[tokio::test]
    async fn every_transport_identity_is_redacted_from_provider_diagnostics() {
        let bindings = CodexMcpBindings::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let binding = bindings.begin_pending().await.unwrap();
        let (provisional, session) = promote_started_binding(&bindings, &binding, "thread_1").await;
        for secret in [&binding, &provisional, &session] {
            let diagnostic = format!("provider echoed {secret}.");
            let redacted = redact_mcp_capabilities(&diagnostic);

            assert!(!redacted.contains(secret));
            assert!(redacted.contains("[REDACTED CAFFOLD MCP CAPABILITY]"));
        }
        assert!(
            redact_mcp_capabilities("s1.not-a-token").contains("s1.not-a-token"),
            "ordinary version-like text remains readable"
        );

        let header_diagnostic = redact_mcp_capabilities(&format!(
            "{CAFFOLD_MCP_BINDING_HEADER}: partial-provider-value"
        ));
        assert_eq!(
            header_diagnostic,
            "[REDACTED CAFFOLD MCP HEADER DIAGNOSTIC]"
        );
        assert_eq!(
            redact_mcp_capabilities("X-Caffold-Mcp-Binding: provider-value"),
            "[REDACTED CAFFOLD MCP HEADER DIAGNOSTIC]"
        );
    }

    #[tokio::test]
    async fn request_config_adds_only_the_authenticated_caffold_server() {
        let endpoint = "http://127.0.0.1:5177/api/codex/mcp";
        let bindings = CodexMcpBindings::memory(endpoint.to_string());
        let token = bindings.begin_reattach("thread_1").await.unwrap();
        let config = bindings.thread_config(&token);
        let server = &config["mcp_servers.caffold"];

        assert_eq!(server["url"], endpoint);
        assert_eq!(server["http_headers"][CAFFOLD_MCP_BINDING_HEADER], token);
        assert_eq!(server.get("enabled_tools"), None);
        assert_eq!(server["default_tools_approval_mode"], "approve");
        assert_eq!(config.len(), 1, "user-owned MCP entries remain untouched");
    }

    #[tokio::test]
    async fn backend_replacement_and_reattachment_keep_existing_sessions() {
        let root = tempfile::tempdir().unwrap();
        let endpoint = "http://127.0.0.1:5177/api/codex/mcp";
        let first_bindings =
            CodexMcpBindings::persistent(endpoint.to_string(), root.path().to_path_buf());
        let first = first_bindings.begin_reattach("thread_1").await.unwrap();
        let (_, first_session) =
            promote_reattached_binding(&first_bindings, &first, "thread_1").await;

        let replacement =
            CodexMcpBindings::persistent(endpoint.to_string(), root.path().to_path_buf());
        assert_eq!(
            replacement.authorize_session(&first, &first_session).await,
            CodexMcpSessionAuthorization::Thread("thread_1".to_string())
        );
        let second = replacement.begin_reattach("thread_1").await.unwrap();
        let (_, second_session) =
            promote_reattached_binding(&replacement, &second, "thread_1").await;

        for (binding, session) in [(&first, &first_session), (&second, &second_session)] {
            assert_eq!(
                replacement.authorize_session(binding, session).await,
                CodexMcpSessionAuthorization::Thread("thread_1".to_string())
            );
        }
    }

    #[tokio::test]
    async fn sessions_cannot_move_between_bindings_tasks_or_installations() {
        let root = tempfile::tempdir().unwrap();
        let other_root = tempfile::tempdir().unwrap();
        let endpoint = "http://127.0.0.1:5177/api/codex/mcp";
        let bindings =
            CodexMcpBindings::persistent(endpoint.to_string(), root.path().to_path_buf());
        let first = bindings.begin_reattach("thread_1").await.unwrap();
        let (_, first_session) = promote_reattached_binding(&bindings, &first, "thread_1").await;
        let second = bindings.begin_reattach("thread_2").await.unwrap();
        let (_, second_session) = promote_reattached_binding(&bindings, &second, "thread_2").await;
        let other =
            CodexMcpBindings::persistent(endpoint.to_string(), other_root.path().to_path_buf());

        assert_eq!(
            bindings.authorize_session(&first, &second_session).await,
            CodexMcpSessionAuthorization::Unauthorized
        );
        assert_eq!(
            bindings.authorize_session(&second, &first_session).await,
            CodexMcpSessionAuthorization::Unauthorized
        );
        assert_eq!(
            other.authorize_session(&first, &first_session).await,
            CodexMcpSessionAuthorization::Unauthorized
        );
    }

    #[tokio::test]
    async fn failed_reattachment_discards_only_its_provisional_session() {
        let bindings = CodexMcpBindings::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let first = bindings.begin_reattach("thread_1").await.unwrap();
        let (_, first_session) = promote_reattached_binding(&bindings, &first, "thread_1").await;
        let failed = bindings.begin_reattach("thread_1").await.unwrap();
        let failed_provisional = bindings.initialize_session(&failed).await.unwrap();

        bindings.cancel_reattach(&failed, "thread_1").await.unwrap();

        assert_eq!(
            bindings.authorize_session(&first, &first_session).await,
            CodexMcpSessionAuthorization::Thread("thread_1".to_string())
        );
        assert_eq!(
            bindings
                .authorize_session(&failed, &failed_provisional)
                .await,
            CodexMcpSessionAuthorization::Unauthorized
        );
    }

    #[tokio::test]
    async fn a_bootstrap_cannot_be_committed_to_another_thread() {
        let bindings = CodexMcpBindings::memory("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let token = bindings.begin_reattach("thread_1").await.unwrap();

        assert!(bindings.bind_pending("missing", "thread_1").await.is_err());
        assert!(bindings.bind_pending(&token, "thread_1").await.is_err());
        assert!(
            bindings
                .commit_reattach("missing", "thread_1")
                .await
                .is_err()
        );
        assert!(
            bindings
                .complete_bootstrap(&token, "thread_1")
                .await
                .is_err()
        );
        assert!(bindings.commit_reattach(&token, "thread_2").await.is_err());
        assert_eq!(
            bindings.resolve(&token).await,
            Some(CodexMcpBindingTarget::Pending)
        );
    }

    #[test]
    fn mcp_protocol_is_decoded_inside_the_codex_driver() {
        let request = decode_mcp_request(
            br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"rename_current_task","arguments":{"name":"Reviewed"}}}"#,
        )
        .unwrap();

        let CodexMcpRequest::CallTool {
            id,
            tool,
            arguments,
        } = request
        else {
            panic!("expected a tool call")
        };
        assert_eq!(id, json!(7));
        assert_eq!(tool, "rename_current_task");
        assert_eq!(arguments, json!({ "name": "Reviewed" }));
    }

    #[test]
    fn malformed_mcp_framing_returns_json_rpc_errors() {
        assert_eq!(
            decode_mcp_request(b"not json").unwrap_err(),
            mcp_error(Value::Null, -32700, "MCP request is not valid JSON.")
        );
        assert_eq!(
            decode_mcp_request(br#"[]"#).unwrap_err(),
            mcp_error(Value::Null, -32600, "MCP request must be an object.")
        );
        assert_eq!(
            decode_mcp_request(br#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{}}"#,)
                .unwrap_err(),
            mcp_error(json!(8), -32602, "MCP tool call has no tool name.")
        );
        assert_eq!(
            decode_mcp_request(br#"{"id":9,"method":"ping"}"#).unwrap_err(),
            mcp_error(json!(9), -32600, "MCP requests must use JSON-RPC 2.0.")
        );
        assert_eq!(
            decode_mcp_request(br#"{"jsonrpc":"2.0","id":10}"#).unwrap_err(),
            mcp_error(json!(10), -32600, "MCP request has no method.")
        );
        assert_eq!(
            decode_mcp_request(
                br#"{"jsonrpc":"2.0","id":11,"method":"resources/read","params":{}}"#,
            )
            .unwrap_err(),
            mcp_error(json!(11), -32602, "MCP resource read has no URI.")
        );
    }

    #[test]
    fn unsupported_mcp_methods_remain_protocol_errors() {
        let request =
            decode_mcp_request(br#"{"jsonrpc":"2.0","id":11,"method":"prompts/list"}"#).unwrap();
        let CodexMcpRequest::Unsupported { id, method } = request else {
            panic!("expected an unsupported MCP request")
        };
        assert_eq!(id, json!(11));
        assert_eq!(method, "prompts/list");
    }

    #[test]
    fn mcp_notifications_are_acknowledged_without_a_json_rpc_reply() {
        assert!(matches!(
            decode_mcp_request(br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,)
                .unwrap(),
            CodexMcpRequest::Notification
        ));
    }

    #[test]
    fn initialize_negotiates_only_versions_this_server_supports() {
        let CodexMcpRequest::Initialize {
            protocol_version, ..
        } = decode_mcp_request(
            br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2099-01-01"}}"#,
        )
        .unwrap()
        else {
            panic!("expected initialize")
        };

        assert_eq!(protocol_version, CURRENT_MCP_PROTOCOL_VERSION);
    }
}
