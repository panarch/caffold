//! What Caffold's HTTP MCP server keeps the same at every agent's address.
//!
//! Codex and Grok reach Caffold's Task tools at addresses of their own,
//! `/api/codex/mcp` and `/api/grok/mcp`, and each address has its own bindings
//! and handler. What stays here does not differ between them: the header
//! names, how a request is framed and answered, the Task tool catalog, and the
//! installation key that signs a session to the Task its binding names. Claude
//! serves the same tools in-process and uses none of it.

use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

use serde_json::{Value, json};
use uuid::Uuid;

mod served_tools;
mod signer;

pub(crate) use served_tools::{
    ISOLATE_CURRENT_TASK_TOOL_NAME, RENAME_CURRENT_TASK_TOOL_NAME, caffold_mcp_tools,
};
#[cfg(test)]
pub(in crate::agent) use served_tools::{McpToolSpec, caffold_mcp_tool_specs};
pub(in crate::agent) use signer::looks_like_thread_session;
use signer::{CapabilitySigner, CapabilitySignerError};

pub(crate) const CAFFOLD_MCP_SERVER_NAME: &str = "caffold";
pub(crate) const CAFFOLD_MCP_BINDING_HEADER: &str = "x-caffold-mcp-binding";
pub(crate) const MCP_SESSION_ID_HEADER: &str = "mcp-session-id";
const CURRENT_MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_MCP_PROTOCOL_VERSIONS: [&str; 2] = ["2025-06-18", "2025-03-26"];

/// One request received at an agent's MCP address.
///
/// Framing stays in the agent layer: the handler at an address sees only the
/// operation it must serve and the Task tool call it may need to execute.
/// Which of these operations an address serves is that address's decision.
#[derive(Debug)]
pub(crate) enum McpRequest {
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

/// The installation key that signs a session to the Task its binding names.
///
/// Caffold can run without either agent that reaches this server, including
/// as a Claude-only service, so configuring the key touches no files. The key
/// is opened the first time a session is issued or a well-formed one is
/// checked, and a failure to open it fails only that authentication.
#[derive(Clone)]
pub(crate) struct McpSessionSigner {
    backend: SignerBackend,
}

#[derive(Clone)]
enum SignerBackend {
    Memory(CapabilitySigner),
    Persistent(Arc<PersistentSignerBackend>),
}

struct PersistentSignerBackend {
    state_dir: PathBuf,
    signer: OnceLock<CapabilitySigner>,
}

impl McpSessionSigner {
    pub(crate) fn memory() -> Self {
        Self {
            backend: SignerBackend::Memory(CapabilitySigner::memory()),
        }
    }

    pub(crate) fn persistent(state_dir: PathBuf) -> Self {
        Self {
            backend: SignerBackend::Persistent(Arc::new(PersistentSignerBackend {
                state_dir,
                signer: OnceLock::new(),
            })),
        }
    }

    pub(crate) async fn issue_thread_session(
        &self,
        binding: &str,
        thread_id: &str,
    ) -> Result<String, String> {
        match &self.backend {
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

    /// The Task a session was signed to, when this installation's key signed
    /// it for this binding. A value not shaped like a signed session is refused
    /// without opening the key.
    pub(crate) async fn resolve_thread_session(
        &self,
        binding: &str,
        session: &str,
    ) -> Option<String> {
        if !looks_like_thread_session(session) {
            return None;
        }
        match &self.backend {
            SignerBackend::Memory(signer) => signer.resolve_thread_session(binding, session),
            SignerBackend::Persistent(backend) => {
                let binding = binding.to_string();
                let session = session.to_string();
                run_signer(backend.clone(), move |signer| {
                    Ok(signer.resolve_thread_session(&binding, &session))
                })
                .await
                .ok()
                .flatten()
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
            .expect("a concurrent Caffold MCP signer initialization completed")
            .clone())
    }
}

async fn run_signer<T, Operation>(
    backend: Arc<PersistentSignerBackend>,
    operation: Operation,
) -> Result<T, String>
where
    T: Send + 'static,
    Operation: FnOnce(&CapabilitySigner) -> Result<T, CapabilitySignerError> + Send + 'static,
{
    tokio::task::spawn_blocking(move || {
        let signer = backend.signer()?;
        operation(&signer).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Caffold MCP signing worker failed: {error}"))?
}

pub(crate) fn new_binding_value() -> String {
    format!("p1.{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub(crate) fn decode_mcp_request(body: &[u8]) -> Result<McpRequest, Value> {
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
        return Ok(McpRequest::Notification);
    };
    let Some(method) = message.get("method").and_then(Value::as_str) else {
        return Err(mcp_error(id, -32600, "MCP request has no method."));
    };
    Ok(match method {
        "initialize" => McpRequest::Initialize {
            id,
            protocol_version: message
                .pointer("/params/protocolVersion")
                .and_then(Value::as_str)
                .map(negotiated_mcp_protocol_version)
                .unwrap_or(CURRENT_MCP_PROTOCOL_VERSION)
                .to_string(),
        },
        "ping" => McpRequest::Ping { id },
        "tools/list" => McpRequest::ListTools { id },
        "resources/list" => McpRequest::ListResources { id },
        "resources/read" => {
            let Some(uri) = message.pointer("/params/uri").and_then(Value::as_str) else {
                return Err(mcp_error(id, -32602, "MCP resource read has no URI."));
            };
            McpRequest::ReadResource {
                id,
                uri: uri.to_string(),
            }
        }
        "tools/call" => {
            let Some(tool) = message.pointer("/params/name").and_then(Value::as_str) else {
                return Err(mcp_error(id, -32602, "MCP tool call has no tool name."));
            };
            McpRequest::CallTool {
                id,
                tool: tool.to_string(),
                arguments: message
                    .pointer("/params/arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            }
        }
        method => McpRequest::Unsupported {
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

    #[tokio::test]
    async fn a_persistent_key_is_opened_only_for_a_signed_session() {
        let root = tempfile::tempdir().unwrap();
        let state_dir = root.path().join("codex-mcp");
        let signer = McpSessionSigner::persistent(state_dir.clone());
        let binding = new_binding_value();

        assert_eq!(
            signer
                .resolve_thread_session(&binding, "not-a-signed-session")
                .await,
            None
        );
        assert!(
            !state_dir.exists(),
            "a value that is not a signed session must not open the key"
        );

        let session = signer
            .issue_thread_session(&binding, "thread_1")
            .await
            .unwrap();
        assert!(state_dir.is_dir());
        assert_eq!(
            signer.resolve_thread_session(&binding, &session).await,
            Some("thread_1".to_string())
        );
    }

    #[tokio::test]
    async fn a_cloned_signer_checks_the_sessions_its_original_signed() {
        let signer = McpSessionSigner::memory();
        let binding = new_binding_value();
        let session = signer
            .issue_thread_session(&binding, "thread_1")
            .await
            .unwrap();

        assert_eq!(
            signer
                .clone()
                .resolve_thread_session(&binding, &session)
                .await,
            Some("thread_1".to_string())
        );
        assert_eq!(
            McpSessionSigner::memory()
                .resolve_thread_session(&binding, &session)
                .await,
            None,
            "another installation's key does not"
        );
    }

    #[test]
    fn a_tool_call_is_decoded_into_the_operation_it_asks_for() {
        let request = decode_mcp_request(
            br#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"rename_current_task","arguments":{"name":"Reviewed"}}}"#,
        )
        .unwrap();

        let McpRequest::CallTool {
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
        let McpRequest::Unsupported { id, method } = request else {
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
            McpRequest::Notification
        ));
    }

    #[test]
    fn initialize_negotiates_only_versions_this_server_supports() {
        let McpRequest::Initialize {
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
