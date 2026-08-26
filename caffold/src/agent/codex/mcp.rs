//! The Caffold-owned MCP server as one thread sees it.
//!
//! Codex's `dynamicTools` are fixed when a thread is created. An HTTP MCP
//! server gives Caffold a server-owned tool catalog that a new connection or
//! resume can discover without removing those persisted tools. Every
//! connection carries an opaque binding token: the MCP transport itself does
//! not tell its server which Codex thread made a call, so trusting a
//! model-supplied thread id would let a call name another Task.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex as StdMutex},
};

use serde_json::{Value, json};
use uuid::Uuid;

pub(crate) const CAFFOLD_MCP_SERVER_NAME: &str = "caffold";
pub(crate) const CAFFOLD_MCP_BINDING_HEADER: &str = "x-caffold-mcp-binding";
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CodexMcpBindingTarget {
    Pending,
    Thread(String),
}

#[derive(Default)]
struct BindingState {
    by_token: HashMap<String, CodexMcpBindingTarget>,
    by_thread: HashMap<String, HashSet<String>>,
}

struct CodexMcpBindingsInner {
    endpoint: String,
    state: StdMutex<BindingState>,
}

/// Authenticated, process-local identities for Caffold's Codex MCP clients.
///
/// A newly created thread receives a pending token because its provider id is
/// not known until `thread/start` answers. A resumed thread is known already
/// and receives a bound token immediately. Tokens live only for this Caffold
/// process; a restart rotates them when each thread is resumed.
#[derive(Clone)]
pub(crate) struct CodexMcpBindings {
    inner: Arc<CodexMcpBindingsInner>,
}

impl CodexMcpBindings {
    pub(crate) fn new(endpoint: String) -> Self {
        Self {
            inner: Arc::new(CodexMcpBindingsInner {
                endpoint,
                state: StdMutex::new(BindingState::default()),
            }),
        }
    }

    /// Reserve an identity before Codex has returned the new thread id.
    pub(crate) fn begin_pending(&self) -> String {
        let token = opaque_token();
        self.state()
            .by_token
            .insert(token.clone(), CodexMcpBindingTarget::Pending);
        token
    }

    /// Commit a pending identity to the provider id Codex returned.
    pub(crate) fn bind_pending(&self, token: &str, thread_id: &str) -> Result<(), String> {
        let mut state = self.state();
        if !matches!(
            state.by_token.get(token),
            Some(CodexMcpBindingTarget::Pending)
        ) {
            return Err("Codex MCP binding is no longer pending.".to_string());
        }
        state
            .by_thread
            .entry(thread_id.to_string())
            .or_default()
            .insert(token.to_string());
        state.by_token.insert(
            token.to_string(),
            CodexMcpBindingTarget::Thread(thread_id.to_string()),
        );
        Ok(())
    }

    /// Stage another capability while Codex is being re-attached.
    ///
    /// A changed header makes the request-scoped MCP config observably new to
    /// app-server. The previous capability remains valid until the resume
    /// succeeds, so a failed transport request does not break the existing
    /// connection.
    pub(crate) fn begin_reattach(&self, thread_id: &str) -> String {
        let mut state = self.state();
        let token = opaque_token();
        state
            .by_thread
            .entry(thread_id.to_string())
            .or_default()
            .insert(token.clone());
        state.by_token.insert(
            token.clone(),
            CodexMcpBindingTarget::Thread(thread_id.to_string()),
        );
        token
    }

    /// Make the successfully resumed connection the thread's only capability.
    pub(crate) fn commit_reattach(&self, token: &str, thread_id: &str) -> Result<(), String> {
        let mut state = self.state();
        if !matches!(
            state.by_token.get(token),
            Some(CodexMcpBindingTarget::Thread(bound_thread_id)) if bound_thread_id == thread_id
        ) {
            return Err("Codex MCP reattachment is no longer pending.".to_string());
        }
        let previous = state
            .by_thread
            .insert(thread_id.to_string(), HashSet::from([token.to_string()]))
            .unwrap_or_default();
        for previous_token in previous {
            if previous_token != token {
                state.by_token.remove(&previous_token);
            }
        }
        Ok(())
    }

    /// Discard only the capability belonging to a failed resume attempt.
    pub(crate) fn cancel_reattach(&self, token: &str, thread_id: &str) {
        let mut state = self.state();
        if !matches!(
            state.by_token.get(token),
            Some(CodexMcpBindingTarget::Thread(bound_thread_id)) if bound_thread_id == thread_id
        ) {
            return;
        }
        state.by_token.remove(token);
        let remove_thread = state.by_thread.get_mut(thread_id).is_some_and(|tokens| {
            tokens.remove(token);
            tokens.is_empty()
        });
        if remove_thread {
            state.by_thread.remove(thread_id);
        }
    }

    pub(crate) fn cancel_pending(&self, token: &str) {
        let mut state = self.state();
        if matches!(
            state.by_token.get(token),
            Some(CodexMcpBindingTarget::Pending)
        ) {
            state.by_token.remove(token);
        }
    }

    pub(crate) fn revoke_thread(&self, thread_id: &str) {
        let mut state = self.state();
        if let Some(tokens) = state.by_thread.remove(thread_id) {
            for token in tokens {
                state.by_token.remove(&token);
            }
        }
    }

    pub(crate) fn resolve(&self, token: &str) -> Option<CodexMcpBindingTarget> {
        self.state().by_token.get(token).cloned()
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

    fn state(&self) -> std::sync::MutexGuard<'_, BindingState> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn opaque_token() -> String {
    // Two UUIDv4 values keep the token opaque and comfortably above the
    // entropy needed for this process-local HTTP capability.
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
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
        "capabilities": { "tools": {} },
        "serverInfo": {
            "name": CAFFOLD_MCP_SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
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

    #[test]
    fn pending_bindings_become_one_thread_scoped_capability() {
        let bindings = CodexMcpBindings::new("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let token = bindings.begin_pending();
        assert_eq!(
            bindings.resolve(&token),
            Some(CodexMcpBindingTarget::Pending)
        );

        bindings.bind_pending(&token, "thread_1").unwrap();
        assert_eq!(
            bindings.resolve(&token),
            Some(CodexMcpBindingTarget::Thread("thread_1".to_string()))
        );

        bindings.revoke_thread("thread_1");
        assert_eq!(bindings.resolve(&token), None);
    }

    #[test]
    fn request_config_adds_only_the_authenticated_caffold_server() {
        let endpoint = "http://127.0.0.1:5177/api/codex/mcp";
        let bindings = CodexMcpBindings::new(endpoint.to_string());
        let token = bindings.begin_reattach("thread_1");
        bindings.commit_reattach(&token, "thread_1").unwrap();
        let config = bindings.thread_config(&token);
        let server = &config["mcp_servers.caffold"];

        assert_eq!(server["url"], endpoint);
        assert_eq!(server["http_headers"][CAFFOLD_MCP_BINDING_HEADER], token);
        assert_eq!(server.get("enabled_tools"), None);
        assert_eq!(server["default_tools_approval_mode"], "approve");
        assert_eq!(config.len(), 1, "user-owned MCP entries remain untouched");
    }

    #[test]
    fn reattachment_replaces_the_previous_capability_only_after_success() {
        let bindings = CodexMcpBindings::new("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let first = bindings.begin_reattach("thread_1");
        bindings.commit_reattach(&first, "thread_1").unwrap();
        let second = bindings.begin_reattach("thread_1");

        assert_ne!(first, second);
        assert_eq!(
            bindings.resolve(&first),
            Some(CodexMcpBindingTarget::Thread("thread_1".to_string()))
        );
        assert_eq!(
            bindings.resolve(&second),
            Some(CodexMcpBindingTarget::Thread("thread_1".to_string()))
        );
        bindings.commit_reattach(&second, "thread_1").unwrap();
        assert_eq!(bindings.resolve(&first), None);
        assert_eq!(
            bindings.resolve(&second),
            Some(CodexMcpBindingTarget::Thread("thread_1".to_string()))
        );
    }

    #[test]
    fn failed_reattachment_keeps_the_previous_capability() {
        let bindings = CodexMcpBindings::new("http://127.0.0.1:5177/api/codex/mcp".to_string());
        let first = bindings.begin_reattach("thread_1");
        bindings.commit_reattach(&first, "thread_1").unwrap();
        let failed = bindings.begin_reattach("thread_1");

        bindings.cancel_reattach(&failed, "thread_1");

        assert_eq!(bindings.resolve(&failed), None);
        assert_eq!(
            bindings.resolve(&first),
            Some(CodexMcpBindingTarget::Thread("thread_1".to_string()))
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
            decode_mcp_request(br#"{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{}}"#,)
                .unwrap_err(),
            mcp_error(json!(8), -32602, "MCP tool call has no tool name.")
        );
        assert_eq!(
            decode_mcp_request(br#"{"id":9,"method":"ping"}"#).unwrap_err(),
            mcp_error(json!(9), -32600, "MCP requests must use JSON-RPC 2.0.")
        );
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
