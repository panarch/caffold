use super::{CodexStatusDiagnostics, CodexStatusPayload};
use crate::agent::ApprovalDecision;
use crate::agent::codex::CodexDaemonInfo;
use crate::app::error::ApiError;
use crate::app::tasks::TaskState;
use crate::task_store::RunBy;
use crate::{
    agent::codex::CodexMcpServerDiagnostic,
    task_store::{TaskStore, TaskStoreError},
};
use axum::Json;
use axum::extract::State;
use futures_util::StreamExt;
use futures_util::stream;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CodexMcpDiagnosticsPayload {
    available: bool,
    process_generation: Option<u64>,
    app_server_version: Option<String>,
    threads: Vec<CodexMcpThreadDiagnostics>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexMcpThreadDiagnostics {
    thread_id: String,
    available: bool,
    servers: Vec<CodexMcpServerDiagnostic>,
    error: Option<String>,
}

pub(super) async fn codex_status(State(state): State<TaskState>) -> Json<CodexStatusPayload> {
    let (status, process_generation, process_connected) =
        state.task_runtime.status_with_diagnostics().await;
    let diagnostics = CodexStatusDiagnostics {
        process_generation,
        process_connected,
        thread_sessions: state.task_sessions.diagnostics().await,
        usage: state.task_runtime.usage_diagnostics(),
    };
    Json(CodexStatusPayload {
        status,
        diagnostics,
    })
}

pub(super) async fn codex_mcp_diagnostics(
    State(state): State<TaskState>,
) -> Json<CodexMcpDiagnosticsPayload> {
    let Some(connection) = state.task_runtime.codex_diagnostic_connection().await else {
        return Json(unavailable_mcp_diagnostics(
            None,
            None,
            "Codex app-server connection is unavailable.".to_string(),
        ));
    };
    let process_generation = connection.generation;
    let app_server_version = connection.client.app_server_version().map(str::to_string);
    let loaded_thread_ids = match connection.client.list_all_loaded_threads().await {
        Ok(thread_ids) => thread_ids,
        Err(_) => {
            return Json(unavailable_mcp_diagnostics(
                Some(process_generation),
                app_server_version,
                "Unable to read loaded Codex threads.".to_string(),
            ));
        }
    };
    let task_store = state.task_store.clone();
    let managed_thread_ids = match tokio::task::spawn_blocking(move || {
        managed_codex_thread_ids(&task_store, loaded_thread_ids)
    })
    .await
    {
        Ok(Ok(thread_ids)) => thread_ids,
        Ok(Err(_)) => {
            return Json(unavailable_mcp_diagnostics(
                Some(process_generation),
                app_server_version,
                "Unable to match loaded Codex threads to Caffold Tasks.".to_string(),
            ));
        }
        Err(_) => {
            return Json(unavailable_mcp_diagnostics(
                Some(process_generation),
                app_server_version,
                "Unable to inspect Caffold Task membership.".to_string(),
            ));
        }
    };

    let client = connection.client;
    let mut threads = stream::iter(managed_thread_ids.into_iter().map(|thread_id| {
        let client = client.clone();
        async move {
            match client.list_all_mcp_server_diagnostics(&thread_id).await {
                Ok(mut servers) => {
                    servers.sort_by(|left, right| left.name.cmp(&right.name));
                    CodexMcpThreadDiagnostics {
                        thread_id,
                        available: true,
                        servers,
                        error: None,
                    }
                }
                Err(_) => CodexMcpThreadDiagnostics {
                    thread_id,
                    available: false,
                    servers: Vec::new(),
                    error: Some("Codex MCP status request failed.".to_string()),
                },
            }
        }
    }))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;
    threads.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));

    Json(CodexMcpDiagnosticsPayload {
        available: true,
        process_generation: Some(process_generation),
        app_server_version,
        threads,
        error: None,
    })
}

pub(super) async fn codex_restart(
    State(state): State<TaskState>,
) -> Result<Json<CodexDaemonInfo>, ApiError> {
    state
        .task_runtime
        .restart_daemon()
        .await
        .map(Json)
        .map_err(ApiError::from)
}

fn managed_codex_thread_ids(
    task_store: &TaskStore,
    loaded_thread_ids: Vec<String>,
) -> Result<Vec<String>, TaskStoreError> {
    let mut managed = Vec::new();
    for thread_id in loaded_thread_ids {
        if task_store
            .get(&thread_id)?
            .is_some_and(|thread| matches!(thread.run_by, RunBy::Codex))
        {
            managed.push(thread_id);
        }
    }
    managed.sort();
    Ok(managed)
}

fn unavailable_mcp_diagnostics(
    process_generation: Option<u64>,
    app_server_version: Option<String>,
    error: String,
) -> CodexMcpDiagnosticsPayload {
    CodexMcpDiagnosticsPayload {
        available: false,
        process_generation,
        app_server_version,
        threads: Vec::new(),
        error: Some(error),
    }
}

pub(super) fn normalize_approval_decision(decision: &str) -> Result<ApprovalDecision, ApiError> {
    match decision {
        "allow" => Ok(ApprovalDecision::Allow),
        "allowAlways" => Ok(ApprovalDecision::AllowAlways),
        "deny" => Ok(ApprovalDecision::Deny),
        "denyAndStop" => Ok(ApprovalDecision::DenyAndStop),
        _ => Err(ApiError::BadRequest {
            code: "invalid_approval_decision",
            message: "approval decision is not supported".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::json;
    use tokio::sync::broadcast;

    use super::*;
    use crate::{
        agent::{
            claude::ClaudeClient,
            codex::{CodexThreadClient, CodexThreadError, MockCodexResponse},
        },
        app::tasks::test_support::{manage_test_thread, task_state_with_codex_client},
        fs::RootedFs,
    };

    #[tokio::test]
    async fn mcp_diagnostics_report_unavailable_without_starting_a_codex_proxy() {
        let root = tempfile::tempdir().unwrap();
        let fs = RootedFs::new(root.path()).unwrap();
        let (shutdown, _) = broadcast::channel(1);
        let (claude, _runner) =
            ClaudeClient::mock_writing_to(root.path().join(".caffold-test/projects"));
        let state = TaskState::new(
            Arc::new(fs),
            String::new(),
            shutdown,
            TaskStore::memory().unwrap(),
            root.path().join(".caffold-test/worktrees"),
            claude,
        )
        .unwrap();

        let Json(payload) = codex_mcp_diagnostics(State(state)).await;

        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            json!({
                "available": false,
                "processGeneration": null,
                "appServerVersion": null,
                "threads": [],
                "error": "Codex app-server connection is unavailable."
            })
        );
    }

    #[tokio::test]
    async fn mcp_diagnostics_query_only_loaded_managed_codex_threads_and_drop_inventory() {
        let root = tempfile::tempdir().unwrap();
        let first_thread_id = "managed-a";
        let failed_thread_id = "managed-b";
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok_for(
                "thread/loaded/list",
                json!({ "limit": 100 }),
                json!({
                    "data": ["external", failed_thread_id, first_thread_id],
                    "nextCursor": null
                }),
            ),
            MockCodexResponse::ok_for(
                "mcpServerStatus/list",
                json!({
                    "limit": 100,
                    "detail": "toolsAndAuthOnly",
                    "threadId": first_thread_id
                }),
                json!({
                    "data": [{
                        "name": "remote-tools",
                        "runtimeStatus": "connected",
                        "authStatus": "oAuth",
                        "pluginId": "private-plugin",
                        "tools": { "private-tool": { "name": "private-tool" } },
                        "resources": [{ "uri": "https://private.example/resource" }]
                    }],
                    "nextCursor": null
                }),
            ),
            MockCodexResponse::error_for(
                "mcpServerStatus/list",
                json!({
                    "limit": 100,
                    "detail": "toolsAndAuthOnly",
                    "threadId": failed_thread_id
                }),
                CodexThreadError::Protocol(
                    "MCP status unavailable at https://private.example/mcp".to_string(),
                ),
            ),
        ]);
        let state =
            task_state_with_codex_client(RootedFs::new(root.path()).unwrap(), client.clone()).await;
        manage_test_thread(&state, first_thread_id, root.path()).await;
        manage_test_thread(&state, failed_thread_id, root.path()).await;

        let Json(payload) = codex_mcp_diagnostics(State(state)).await;
        let value = serde_json::to_value(payload).expect("diagnostic response JSON");

        assert_eq!(
            value,
            json!({
                "available": true,
                "processGeneration": 1,
                "appServerVersion": null,
                "threads": [
                    {
                        "threadId": first_thread_id,
                        "available": true,
                        "servers": [{
                            "name": "remote-tools",
                            "runtimeStatus": "connected",
                            "authStatus": "oAuth"
                        }],
                        "error": null
                    },
                    {
                        "threadId": failed_thread_id,
                        "available": false,
                        "servers": [],
                        "error": "Codex MCP status request failed."
                    }
                ],
                "error": null
            })
        );
        let response_text = value.to_string();
        assert!(!response_text.contains("private-plugin"));
        assert!(!response_text.contains("private-tool"));
        assert!(!response_text.contains("private.example"));
        assert!(
            client
                .mock_requests()
                .await
                .iter()
                .all(|(_, params)| params["threadId"] != "external")
        );
    }

    #[test]
    fn the_browser_answers_with_one_of_caffolds_four_decisions() {
        let decisions = [
            ("allow", ApprovalDecision::Allow),
            ("allowAlways", ApprovalDecision::AllowAlways),
            ("deny", ApprovalDecision::Deny),
            ("denyAndStop", ApprovalDecision::DenyAndStop),
        ];

        for (sent, expected) in decisions {
            assert_eq!(normalize_approval_decision(sent).unwrap(), expected);
        }
    }

    #[test]
    fn a_decision_caffold_does_not_offer_is_refused() {
        // A card from an older page, or an agent's own vocabulary leaking
        // through, is a bad request rather than something to guess at.
        for sent in ["accept", "acceptForSession", "decline", "cancel", ""] {
            assert!(matches!(
                normalize_approval_decision(sent),
                Err(ApiError::BadRequest {
                    code: "invalid_approval_decision",
                    ..
                })
            ));
        }
    }
}
