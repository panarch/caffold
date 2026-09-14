//! The Caffold-owned MCP server as one Grok session sees it.
//!
//! A Grok Task's id exists before its session does, so the binding a session
//! is declared with is bound to the Task from the start, and the first
//! `initialize` at Grok's address already answers with the session signed to
//! that Task. Grok initializes the connection while a session is created and
//! again whenever it sees fit, so a binding stays bound until the driver lets
//! it go: when the session is closed or erased, or loaded again under a new
//! binding.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
};

use serde_json::{Value, json};

use crate::agent::{
    CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS,
    http_mcp::{CAFFOLD_MCP_SERVER_NAME, McpSessionSigner, new_binding_value},
};

/// The bindings Grok sessions are declared with, each naming its Task.
#[derive(Clone)]
pub(crate) struct GrokMcpBindings {
    inner: Arc<GrokMcpBindingsInner>,
}

struct GrokMcpBindingsInner {
    /// The Task each binding names, for every binding a session is open under.
    bound: StdMutex<HashMap<String, String>>,
    signer: McpSessionSigner,
}

impl GrokMcpBindings {
    pub(crate) fn new(signer: McpSessionSigner) -> Self {
        Self {
            inner: Arc::new(GrokMcpBindingsInner {
                bound: StdMutex::new(HashMap::new()),
                signer,
            }),
        }
    }

    /// A new binding, bound to the Task before its session is asked for.
    pub(crate) fn bind(&self, thread_id: &str) -> String {
        let binding = new_binding_value();
        self.bound().insert(binding.clone(), thread_id.to_string());
        binding
    }

    /// Issue no more sessions under a binding. A session already signed
    /// under it stays valid, because sessions are checked with the key alone;
    /// the Task runtime checks the Task on every call.
    pub(crate) fn release(&self, binding: &str) {
        self.bound().remove(binding);
    }

    /// The session an MCP `initialize` answers with, while the binding is bound.
    pub(crate) async fn initialize_session(&self, binding: &str) -> Option<String> {
        let thread_id = self.bound().get(binding)?.clone();
        self.inner
            .signer
            .issue_thread_session(binding, &thread_id)
            .await
            .ok()
    }

    /// The Task a request's session was signed to under this binding.
    pub(crate) async fn authorize_session(&self, binding: &str, session: &str) -> Option<String> {
        self.inner
            .signer
            .resolve_thread_session(binding, session)
            .await
    }

    fn bound(&self) -> std::sync::MutexGuard<'_, HashMap<String, String>> {
        self.inner
            .bound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// What Caffold answers when Grok initializes its MCP connection. Grok's
/// address serves Caffold's Task tools and nothing else.
pub(crate) fn grok_mcp_initialize_result(protocol_version: &str) -> Value {
    json!({
        "protocolVersion": protocol_version,
        "capabilities": {
            "tools": {},
        },
        "serverInfo": {
            "name": CAFFOLD_MCP_SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_initialize_under_a_bound_binding_answers_with_the_tasks_session() {
        let bindings = GrokMcpBindings::new(McpSessionSigner::memory());
        let binding = bindings.bind("task_1");

        for _ in 0..2 {
            let session = bindings
                .initialize_session(&binding)
                .await
                .expect("a session");
            assert_eq!(
                bindings.authorize_session(&binding, &session).await,
                Some("task_1".to_string())
            );
        }
    }

    #[tokio::test]
    async fn a_released_binding_issues_no_more_sessions() {
        let bindings = GrokMcpBindings::new(McpSessionSigner::memory());
        let binding = bindings.bind("task_1");
        let session = bindings.initialize_session(&binding).await.unwrap();

        bindings.release(&binding);

        assert_eq!(bindings.initialize_session(&binding).await, None);
        assert_eq!(
            bindings.authorize_session(&binding, &session).await,
            Some("task_1".to_string()),
            "a session signed before the release is checked with the key alone"
        );
    }

    #[tokio::test]
    async fn a_session_answers_only_under_the_binding_it_was_signed_for() {
        let bindings = GrokMcpBindings::new(McpSessionSigner::memory());
        let first = bindings.bind("task_1");
        let second = bindings.bind("task_2");
        let first_session = bindings.initialize_session(&first).await.unwrap();

        assert_eq!(
            bindings.authorize_session(&second, &first_session).await,
            None
        );
        assert_eq!(bindings.initialize_session("p1.not-issued").await, None);
    }

    #[tokio::test]
    async fn binding_a_task_does_not_open_the_signing_key() {
        let root = tempfile::tempdir().unwrap();
        let state_dir = root.path().join("codex-mcp");
        let bindings = GrokMcpBindings::new(McpSessionSigner::persistent(state_dir.clone()));

        let binding = bindings.bind("task_1");
        assert!(
            !state_dir.exists(),
            "binding a Task before its session exists must not open the key"
        );

        bindings
            .initialize_session(&binding)
            .await
            .expect("a session");
        assert!(state_dir.is_dir());
    }
}
