//! Task-bound HTTP MCP sessions, shared by Grok and Antigravity.
//!
//! Each endpoint owns a separate binding map. Signed sessions retain the
//! installation-local key contract across backend replacement.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex, MutexGuard},
};

use serde_json::{Value, json};

use crate::agent::{
    CAFFOLD_SESSION_INSTRUCTIONS,
    http_mcp::{CAFFOLD_MCP_SERVER_NAME, McpSessionSigner, new_binding_value},
};

/// Bindings declared before a native session exists, each naming its Task.
#[derive(Clone)]
pub(crate) struct TaskMcpBindings {
    inner: Arc<TaskMcpBindingsInner>,
}

struct TaskMcpBindingsInner {
    /// The Task each binding names, for every binding a session is open under.
    bound: StdMutex<HashMap<String, String>>,
    signer: McpSessionSigner,
}

impl TaskMcpBindings {
    pub(crate) fn new(signer: McpSessionSigner) -> Self {
        Self {
            inner: Arc::new(TaskMcpBindingsInner {
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

    /// Restore the exact header already held by a surviving native child.
    pub(crate) fn restore(&self, binding: &str, thread_id: &str) -> Result<(), String> {
        if !valid_binding(binding) {
            return Err("invalid Task MCP binding".to_string());
        }
        let mut bound = self.bound();
        if bound
            .get(binding)
            .is_some_and(|existing| existing != thread_id)
        {
            return Err("MCP binding belongs to another Task".to_string());
        }
        bound.insert(binding.to_string(), thread_id.to_string());
        Ok(())
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

    fn bound(&self) -> MutexGuard<'_, HashMap<String, String>> {
        self.inner
            .bound
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub(crate) fn valid_binding(binding: &str) -> bool {
    binding.len() == 67
        && binding.starts_with("p1.")
        && binding[3..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// What Caffold answers when an agent initializes its MCP connection. Each
/// address serves Caffold's Task tools and nothing else.
pub(crate) fn task_mcp_initialize_result(protocol_version: &str) -> Value {
    json!({
        "protocolVersion": protocol_version,
        "capabilities": {
            "tools": {},
        },
        "serverInfo": {
            "name": CAFFOLD_MCP_SERVER_NAME,
            "version": env!("CARGO_PKG_VERSION"),
        },
        "instructions": CAFFOLD_SESSION_INSTRUCTIONS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_initialize_under_a_bound_binding_answers_with_the_tasks_session() {
        let bindings = TaskMcpBindings::new(McpSessionSigner::memory());
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
        let bindings = TaskMcpBindings::new(McpSessionSigner::memory());
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
        let bindings = TaskMcpBindings::new(McpSessionSigner::memory());
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
        let bindings = TaskMcpBindings::new(McpSessionSigner::persistent(state_dir.clone()));

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

    #[tokio::test]
    async fn restored_binding_and_signed_session_survive_a_fresh_backend_but_never_change_task() {
        let root = tempfile::tempdir().unwrap();
        let key = root.path().join("key");
        let first = TaskMcpBindings::new(McpSessionSigner::persistent(key.clone()));
        let binding = first.bind("task-1");
        let session = first.initialize_session(&binding).await.unwrap();
        drop(first);
        let replacement = TaskMcpBindings::new(McpSessionSigner::persistent(key));
        assert_eq!(
            replacement.authorize_session(&binding, &session).await,
            Some("task-1".into())
        );
        assert!(replacement.initialize_session(&binding).await.is_none());
        replacement.restore(&binding, "task-1").unwrap();
        assert!(replacement.initialize_session(&binding).await.is_some());
        assert!(replacement.restore(&binding, "task-2").is_err());
        assert!(replacement.restore("p1.invalid", "task-1").is_err());
        assert_eq!(
            replacement.authorize_session(&binding, &session).await,
            Some("task-1".into())
        );
    }
}
