use serde::Deserialize;
use serde_json::{Value as JsonValue, json};

use super::{ApprovalResolveError, CodexConnection, CodexRuntime};
use crate::app::tasks::{
    events::{TaskEventRecord, now_ms, task_event_record},
    worktrees::IsolateOutcome,
};
use crate::codex_app_server::{
    CodexNotification, CodexServerRequest, CodexThreadClient, ISOLATE_CURRENT_TASK_TOOL_NAME,
    RENAME_CURRENT_THREAD_TOOL_NAME, ThreadStatus, TurnStatus,
};

#[derive(Debug, Clone)]
pub(super) struct PendingApproval {
    thread_id: String,
    request_id: JsonValue,
    kind: ApprovalKind,
    params: JsonValue,
    created_ms: u64,
    sort_index: Option<u32>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameCurrentThreadArguments {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IsolateCurrentTaskArguments {
    branch_name: Option<String>,
    base_ref: Option<String>,
    #[serde(default)]
    include_changes: bool,
}

struct DynamicToolInvocation {
    request_id: JsonValue,
    thread_id: String,
    tool: String,
    namespace: Option<String>,
    arguments: JsonValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ApprovalKind {
    Command,
    FileChange,
}

impl ApprovalKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::FileChange => "file_change",
        }
    }
}

impl CodexRuntime {
    pub(in crate::app) async fn approval_events(&self, thread_id: &str) -> Vec<TaskEventRecord> {
        self.approvals
            .lock()
            .await
            .iter()
            .filter(|(_, pending)| pending.thread_id == thread_id)
            .map(|(approval_id, pending)| {
                let kind = pending.kind.as_str();
                let mut event = task_event_record(
                    &pending.thread_id,
                    &format!("approval_requested:{approval_id}"),
                    "approval_requested",
                    if kind == "command" {
                        "Command approval requested"
                    } else {
                        "File change approval requested"
                    },
                    Some(json!({
                        "approvalId": approval_id,
                        "kind": kind,
                        "turnId": pending.params.get("turnId"),
                        "params": pending.params
                    })),
                    pending.created_ms,
                );
                event.sort_index = pending.sort_index;
                event
            })
            .collect()
    }

    pub(in crate::app) async fn resolve_approval(
        &self,
        connection: &CodexConnection,
        thread_id: &str,
        approval_id: &str,
        decision: &str,
    ) -> Result<(), ApprovalResolveError> {
        let pending = self
            .approvals
            .lock()
            .await
            .get(approval_id)
            .cloned()
            .ok_or(ApprovalResolveError::NotFound)?;
        if pending.thread_id != thread_id {
            return Err(ApprovalResolveError::ThreadMismatch);
        }

        connection
            .client
            .respond_to_server_request(pending.request_id.clone(), json!({ "decision": decision }))
            .await?;
        self.approvals.lock().await.remove(approval_id);

        self.events.publish(task_event_record(
            &pending.thread_id,
            &format!("approval_resolved:{approval_id}"),
            "approval_resolved",
            &format!("Approval resolved: {decision}"),
            Some(json!({
                "approvalId": approval_id,
                "kind": pending.kind.as_str(),
                "turnId": pending.params.get("turnId"),
                "decision": decision
            })),
            now_ms(),
        ));
        Ok(())
    }

    pub(super) async fn handle_server_request(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        request: CodexServerRequest,
    ) {
        let (request_id, thread_id, params, kind) = match request {
            CodexServerRequest::DynamicToolCall {
                id,
                thread_id,
                tool,
                namespace,
                arguments,
                ..
            } => {
                self.handle_dynamic_tool_call(
                    client,
                    generation,
                    DynamicToolInvocation {
                        request_id: id,
                        thread_id,
                        tool,
                        namespace,
                        arguments,
                    },
                )
                .await;
                return;
            }
            CodexServerRequest::CommandExecutionApproval {
                id,
                thread_id,
                params,
            } => (id, thread_id, params, ApprovalKind::Command),
            CodexServerRequest::FileChangeApproval {
                id,
                thread_id,
                params,
            } => (id, thread_id, params, ApprovalKind::FileChange),
            CodexServerRequest::Unknown { .. } => return,
        };
        let approval_id = approval_id_from_request(&request_id, &params);
        let created_ms = now_ms();
        let summary = if kind == ApprovalKind::Command {
            "Command approval requested"
        } else {
            "File change approval requested"
        };
        let event = self.events.record(task_event_record(
            &thread_id,
            &format!("approval_requested:{approval_id}"),
            "approval_requested",
            summary,
            Some(json!({
                "approvalId": approval_id,
                "kind": kind.as_str(),
                "turnId": params.get("turnId"),
                "requestId": request_id,
                "params": params
            })),
            created_ms,
        ));
        self.approvals.lock().await.insert(
            approval_id,
            PendingApproval {
                thread_id,
                request_id,
                kind,
                params,
                created_ms: event.created_ms,
                sort_index: event.sort_index,
            },
        );
        self.events.broadcast(event);
    }

    async fn handle_dynamic_tool_call(
        &self,
        client: &CodexThreadClient,
        generation: u64,
        invocation: DynamicToolInvocation,
    ) {
        let DynamicToolInvocation {
            request_id,
            thread_id,
            tool,
            namespace,
            arguments,
        } = invocation;
        let result = self
            .execute_dynamic_tool(
                client,
                generation,
                &thread_id,
                &tool,
                namespace.as_deref(),
                arguments,
            )
            .await;
        let (success, text) = match result {
            Ok(text) => (true, text),
            Err(message) => (false, message),
        };
        if let Err(error) = client
            .respond_to_server_request(
                request_id,
                json!({
                    "contentItems": [{
                        "type": "inputText",
                        "text": text
                    }],
                    "success": success
                }),
            )
            .await
        {
            eprintln!("failed to respond to Codex dynamic tool call: {error}");
        }
    }

    async fn execute_dynamic_tool(
        &self,
        client: &CodexThreadClient,
        _generation: u64,
        thread_id: &str,
        tool: &str,
        namespace: Option<&str>,
        arguments: JsonValue,
    ) -> Result<String, String> {
        if namespace.is_some()
            || !matches!(
                tool,
                RENAME_CURRENT_THREAD_TOOL_NAME | ISOLATE_CURRENT_TASK_TOOL_NAME
            )
        {
            let qualified_tool = namespace
                .map(|namespace| format!("{namespace}.{tool}"))
                .unwrap_or_else(|| tool.to_string());
            return Err(format!(
                "Caffold does not support the dynamic tool `{qualified_tool}`."
            ));
        }
        if self.managed_thread(thread_id).await?.is_none() {
            return Err(if tool == RENAME_CURRENT_THREAD_TOOL_NAME {
                "Caffold can only rename tasks that it manages.".to_string()
            } else {
                "Caffold can only isolate a task that it manages.".to_string()
            });
        }
        if tool == RENAME_CURRENT_THREAD_TOOL_NAME {
            let RenameCurrentThreadArguments { name } = serde_json::from_value(arguments)
                .map_err(|_| "The new task name must be a non-empty string.".to_string())?;
            let name = name.trim();
            if name.is_empty() {
                return Err("The new task name must be a non-empty string.".to_string());
            }
            client
                .set_thread_name(thread_id, name)
                .await
                .map_err(|error| format!("Caffold could not rename the current task: {error}"))?;
            return Ok(format!("Renamed the current Caffold task to `{name}`."));
        }

        let IsolateCurrentTaskArguments {
            branch_name,
            base_ref,
            include_changes,
        } = serde_json::from_value(arguments).map_err(|_| {
            "Arguments must use optional non-empty `branchName` and `baseRef` values plus a boolean `includeChanges`."
                .to_string()
        })?;
        let branch_name = branch_name
            .map(|branch| {
                let branch = branch.trim().to_string();
                if branch.is_empty() {
                    Err("`branchName` must be a non-empty string when provided.".to_string())
                } else {
                    Ok(branch)
                }
            })
            .transpose()?;
        let base_ref = base_ref
            .map(|base_ref| {
                let base_ref = base_ref.trim().to_string();
                if base_ref.is_empty() {
                    Err("`baseRef` must be a non-empty string when provided.".to_string())
                } else {
                    Ok(base_ref)
                }
            })
            .transpose()?;
        if base_ref.is_some() && include_changes {
            return Err("`baseRef` cannot be combined with `includeChanges: true`.".to_string());
        }
        let thread = client
            .read_thread(thread_id)
            .await
            .map_err(|error| format!("Caffold could not read the current task: {error}"))?;
        let task_name = thread
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .or_else(|| {
                let preview = thread.preview.trim();
                (!preview.is_empty()).then_some(preview)
            })
            .unwrap_or("task")
            .to_string();
        let lifecycle = self
            .lifecycle
            .as_ref()
            .ok_or_else(|| "Caffold task lifecycle is unavailable.".to_string())?;
        let isolated = lifecycle
            .isolate_current_task(
                thread.cwd.into(),
                thread_id.to_string(),
                task_name,
                branch_name,
                base_ref,
                include_changes,
            )
            .await
            .map_err(|error| format!("Caffold could not isolate the current task: {error}"))?;
        match isolated {
            IsolateOutcome::AlreadyReady(worktree) => Ok(format!(
                "The current Caffold task is already isolated on branch `{}` at `{}`. End this turn; the user's next request will continue there.",
                worktree.branch_name, worktree.worktree_path
            )),
            IsolateOutcome::Isolated {
                worktree,
                source_warning,
            } => {
                let warning = source_warning
                    .map(|warning| format!(" The original checkout could not be switched to its default branch and remains detached: {warning}"))
                    .unwrap_or_default();
                let result = if include_changes {
                    format!(
                        "Moved the current Caffold task to branch `{}` at `{}` and preserved its tracked and untracked changes.",
                        worktree.branch_name, worktree.worktree_path
                    )
                } else {
                    format!(
                        "Prepared the current Caffold task on branch `{}` at `{}`. Source checkout changes were left in place.",
                        worktree.branch_name, worktree.worktree_path
                    )
                };
                Ok(format!(
                    "{result} End this turn; the user's next request will continue there.{warning}"
                ))
            }
        }
    }

    async fn managed_thread(
        &self,
        thread_id: &str,
    ) -> Result<Option<crate::task_store::ManagedThread>, String> {
        let store = self.task_store.clone();
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || store.get(&thread_id))
            .await
            .map_err(|error| format!("Caffold could not verify the current task: {error}"))?
            .map_err(|error| format!("Caffold could not verify the current task: {error}"))
    }

    pub(super) async fn expire_stale_approvals_for_notification(
        &self,
        notification: &CodexNotification,
    ) {
        let expired = {
            let mut approvals = self.approvals.lock().await;
            let expired_ids = approvals
                .iter()
                .filter_map(|(approval_id, pending)| {
                    stale_approval_reason(pending, notification)
                        .map(|reason| (approval_id.clone(), reason))
                })
                .collect::<Vec<_>>();
            expired_ids
                .into_iter()
                .filter_map(|(approval_id, reason)| {
                    approvals
                        .remove(&approval_id)
                        .map(|pending| (approval_id, pending, reason))
                })
                .collect::<Vec<_>>()
        };

        for (approval_id, pending, reason) in expired {
            self.events.publish(task_event_record(
                &pending.thread_id,
                &format!("approval_resolved:{approval_id}"),
                "approval_resolved",
                "Approval expired",
                Some(json!({
                    "approvalId": approval_id,
                    "kind": pending.kind.as_str(),
                    "turnId": pending.params.get("turnId"),
                    "decision": "expired",
                    "reason": reason
                })),
                now_ms(),
            ));
        }
    }
}

fn stale_approval_reason(
    pending: &PendingApproval,
    notification: &CodexNotification,
) -> Option<&'static str> {
    match notification {
        CodexNotification::TurnStarted { thread_id, turn }
            if pending.thread_id == *thread_id
                && pending
                    .params
                    .get("turnId")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|turn_id| turn_id != turn.id) =>
        {
            Some("another turn started")
        }
        CodexNotification::TurnCompleted { thread_id, turn }
            if pending.thread_id == *thread_id
                && turn.status != TurnStatus::InProgress
                && pending
                    .params
                    .get("turnId")
                    .and_then(JsonValue::as_str)
                    .is_none_or(|turn_id| turn_id == turn.id) =>
        {
            Some("turn completed")
        }
        CodexNotification::ThreadStatusChanged { thread_id, status }
            if pending.thread_id == *thread_id
                && matches!(status, ThreadStatus::Idle | ThreadStatus::SystemError) =>
        {
            Some("thread became inactive")
        }
        _ => None,
    }
}

fn approval_id_from_request(request_id: &JsonValue, params: &JsonValue) -> String {
    params
        .get("approvalId")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| match request_id {
            JsonValue::String(value) => value.clone(),
            JsonValue::Number(value) => value.to_string(),
            _ => request_id.to_string(),
        })
}

#[cfg(test)]
mod tests {
    use std::{path::Path, process::Command, sync::Arc};

    use tokio::sync::broadcast;

    use super::*;
    use crate::{
        app::tasks::{
            events::TaskEvents, lifecycle::TaskLifecycle, routes::TaskListEvents,
            worktrees::ManagedWorktrees,
        },
        codex_app_server::{self, CodexThreadError, MockCodexResponse},
        codex_thread_sessions::CodexThreadSessions,
        fs::RootedFs,
        task_store::{ManagedThread, TaskStore},
    };

    fn initialize_repository(path: &Path) {
        std::fs::create_dir(path).unwrap();
        for arguments in [
            &["init"][..],
            &["config", "user.email", "test@example.com"],
            &["config", "user.name", "Caffold Test"],
        ] {
            let output = Command::new("git")
                .arg("-C")
                .arg(path)
                .args(arguments)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
        std::fs::write(path.join("README.md"), "initial\n").unwrap();
        for arguments in [&["add", "README.md"][..], &["commit", "-m", "Initial"]] {
            let output = Command::new("git")
                .arg("-C")
                .arg(path)
                .args(arguments)
                .output()
                .unwrap();
            assert!(output.status.success());
        }
    }

    fn dynamic_tool_request(
        thread_id: &str,
        tool: &str,
        arguments: JsonValue,
    ) -> CodexServerRequest {
        codex_app_server::decode_server_request(
            json!(31),
            "item/tool/call",
            json!({
                "threadId": thread_id,
                "turnId": "turn_1",
                "callId": "call_1",
                "tool": tool,
                "arguments": arguments
            }),
        )
        .unwrap()
    }

    fn runtime_with_events(events: TaskEvents) -> CodexRuntime {
        test_runtime_with_store(events, TaskStore::memory().unwrap())
    }

    fn test_runtime(store: TaskStore) -> CodexRuntime {
        test_runtime_with_store(TaskEvents::default(), store)
    }

    fn test_runtime_with_store(events: TaskEvents, store: TaskStore) -> CodexRuntime {
        let (shutdown, _) = broadcast::channel(1);
        CodexRuntime::new(CodexThreadSessions::default(), events, store, shutdown)
    }

    #[tokio::test]
    async fn server_requests_store_live_pending_approvals_without_local_task_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        let events = TaskEvents::default();
        let mut receiver = events.subscribe();
        let runtime = runtime_with_events(events.clone());

        runtime
            .handle_server_request(
                &CodexThreadClient::mock(Vec::new()),
                1,
                codex_app_server::decode_server_request(
                    json!(11),
                    "item/commandExecution/requestApproval",
                    json!({
                        "threadId": "thread_1",
                        "turnId": "turn_1",
                        "command": "cargo test",
                        "cwd": project_root.join("src").display().to_string(),
                        "reason": "Run tests",
                        "availableDecisions": ["accept", "decline"]
                    }),
                )
                .unwrap(),
            )
            .await;

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.thread_id, "thread_1");
        assert_eq!(event.event_type, "approval_requested");
        assert_eq!(
            event.payload.as_ref().unwrap()["turnId"],
            "turn_1",
            "approval events must remain attached to their causal turn"
        );
        assert_eq!(
            event.payload.as_ref().unwrap()["params"]["command"],
            "cargo test"
        );
        let approvals = runtime.approval_events("thread_1").await;
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].id, event.id);
        assert_eq!(approvals[0].created_ms, event.created_ms);
        assert_eq!(approvals[0].sort_index, event.sort_index);
        assert_eq!(
            approvals[0].payload.as_ref().unwrap()["params"]["command"],
            "cargo test"
        );
        assert_eq!(events.for_thread("thread_1"), vec![event]);
    }

    #[tokio::test]
    async fn rename_dynamic_tool_updates_only_the_current_managed_thread() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", None, None, None),
                1_750_000_000_000,
            )
            .unwrap();
        let runtime = test_runtime(store);
        let client =
            CodexThreadClient::mock(vec![MockCodexResponse::ok("thread/name/set", json!({}))]);

        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request(
                    "thread_1",
                    RENAME_CURRENT_THREAD_TOOL_NAME,
                    json!({ "name": "  Whisper voice input  " }),
                ),
            )
            .await;

        assert_eq!(
            client.mock_requests().await,
            [(
                "thread/name/set".to_string(),
                json!({
                    "threadId": "thread_1",
                    "name": "Whisper voice input"
                })
            )]
        );
        assert_eq!(
            client.mock_server_responses().await,
            [(
                json!(31),
                json!({
                    "contentItems": [{
                        "type": "inputText",
                        "text": "Renamed the current Caffold task to `Whisper voice input`."
                    }],
                    "success": true
                })
            )]
        );
    }

    #[tokio::test]
    async fn rename_dynamic_tool_rejects_threads_outside_caffold_management() {
        let client = CodexThreadClient::mock(Vec::new());
        let runtime = test_runtime(TaskStore::memory().unwrap());

        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request(
                    "external_thread",
                    RENAME_CURRENT_THREAD_TOOL_NAME,
                    json!({ "name": "Must not change" }),
                ),
            )
            .await;

        assert!(client.mock_requests().await.is_empty());
        assert_eq!(
            client.mock_server_responses().await[0].1,
            json!({
                "contentItems": [{
                    "type": "inputText",
                    "text": "Caffold can only rename tasks that it manages."
                }],
                "success": false
            })
        );
    }

    #[tokio::test]
    async fn rename_dynamic_tool_rejects_invalid_names_and_unknown_tools() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(ManagedThread::new("thread_1", None, None, None), 1)
            .unwrap();
        let runtime = test_runtime(store);
        let client = CodexThreadClient::mock(Vec::new());

        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request(
                    "thread_1",
                    RENAME_CURRENT_THREAD_TOOL_NAME,
                    json!({ "name": "   " }),
                ),
            )
            .await;
        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request("thread_1", "future_tool", json!({})),
            )
            .await;

        assert!(client.mock_requests().await.is_empty());
        let responses = client.mock_server_responses().await;
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].1["success"], false);
        assert_eq!(
            responses[0].1["contentItems"][0]["text"],
            "The new task name must be a non-empty string."
        );
        assert_eq!(responses[1].1["success"], false);
        assert_eq!(
            responses[1].1["contentItems"][0]["text"],
            "Caffold does not support the dynamic tool `future_tool`."
        );
    }

    #[tokio::test]
    async fn rename_dynamic_tool_returns_a_failed_result_when_app_server_rejects_the_name() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(ManagedThread::new("thread_1", None, None, None), 1)
            .unwrap();
        let runtime = test_runtime(store);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            "thread/name/set",
            CodexThreadError::InvalidParams("name rejected".to_string()),
        )]);

        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request(
                    "thread_1",
                    RENAME_CURRENT_THREAD_TOOL_NAME,
                    json!({ "name": "Rejected name" }),
                ),
            )
            .await;

        assert_eq!(client.mock_requests().await.len(), 1);
        let response = &client.mock_server_responses().await[0].1;
        assert_eq!(response["success"], false);
        assert_eq!(
            response["contentItems"][0]["text"],
            "Caffold could not rename the current task: Codex app-server rejected invalid parameters: name rejected"
        );
    }

    #[tokio::test]
    async fn completed_turn_expires_live_pending_approval() {
        let events = TaskEvents::default();
        let mut receiver = events.subscribe();
        let runtime = runtime_with_events(events.clone());

        runtime
            .handle_server_request(
                &CodexThreadClient::mock(Vec::new()),
                1,
                codex_app_server::decode_server_request(
                    json!(11),
                    "item/commandExecution/requestApproval",
                    json!({
                        "threadId": "thread_1",
                        "turnId": "turn_1",
                        "command": "cargo test",
                        "availableDecisions": ["accept", "decline"]
                    }),
                )
                .unwrap(),
            )
            .await;
        let requested = receiver.recv().await.unwrap();
        assert_eq!(requested.event_type, "approval_requested");

        let completed = codex_app_server::decode_notification(
            "turn/completed",
            json!({
                "threadId": "thread_1",
                "turn": {
                    "id": "turn_1",
                    "status": "completed",
                    "completedAt": 1_750_000_004.5
                }
            }),
        )
        .unwrap();
        runtime
            .expire_stale_approvals_for_notification(&completed)
            .await;

        assert!(runtime.approval_events("thread_1").await.is_empty());
        let resolved = receiver.recv().await.unwrap();
        assert_eq!(resolved.event_type, "approval_resolved");
        assert_eq!(resolved.payload.as_ref().unwrap()["approvalId"], "11");
        assert_eq!(resolved.payload.as_ref().unwrap()["decision"], "expired");
        assert_eq!(
            events
                .for_thread("thread_1")
                .iter()
                .map(|event| event.event_type.as_str())
                .collect::<Vec<_>>(),
            ["approval_requested", "approval_resolved"]
        );
    }

    #[tokio::test]
    async fn isolate_tool_prepares_the_same_task_without_requesting_source_changes() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        initialize_repository(&source);

        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new(
                    "thread_source",
                    None,
                    Some("gpt-test".to_string()),
                    Some("high".to_string()),
                ),
                1,
            )
            .unwrap();
        let sessions = CodexThreadSessions::default();
        let events = TaskEvents::default();
        let worktrees = ManagedWorktrees::new(
            fs.clone(),
            store.clone(),
            root.path().join("managed-worktrees"),
        )
        .unwrap();
        let lifecycle = TaskLifecycle::new(
            fs,
            sessions.clone(),
            events.clone(),
            TaskListEvents::new(),
            store.clone(),
            worktrees,
        );
        let (shutdown, _) = broadcast::channel(1);
        let runtime =
            CodexRuntime::new(sessions, events, store.clone(), shutdown).with_lifecycle(lifecycle);
        let client = CodexThreadClient::mock(vec![MockCodexResponse::ok(
            "thread/read",
            json!({
                "thread": {
                    "id": "thread_source",
                    "name": "Review issue 42",
                    "preview": "Source task",
                    "status": { "type": "idle" },
                    "cwd": source.display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 1.0,
                    "turns": []
                }
            }),
        )]);

        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request("thread_source", ISOLATE_CURRENT_TASK_TOOL_NAME, json!({})),
            )
            .await;

        let records = store.managed_worktrees().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].thread_id.as_deref(), Some("thread_source"));
        assert!(
            records[0]
                .branch_name
                .starts_with("caffold/review-issue-42-")
        );
        assert!(Path::new(&records[0].worktree_path).is_dir());
        let requests = client.mock_requests().await;
        assert_eq!(
            requests
                .iter()
                .map(|(method, _)| method.as_str())
                .collect::<Vec<_>>(),
            ["thread/read"]
        );
        let response = &client.mock_server_responses().await[0].1;
        assert_eq!(response["success"], true);
        assert_eq!(
            response["contentItems"][0]["text"],
            format!(
                "Prepared the current Caffold task on branch `{}` at `{}`. Source checkout changes were left in place. End this turn; the user's next request will continue there.",
                records[0].branch_name, records[0].worktree_path
            )
        );
    }

    #[test]
    fn isolate_tool_defaults_change_transfer_to_false_and_accepts_selected_base() {
        let default = serde_json::from_value::<IsolateCurrentTaskArguments>(json!({})).unwrap();
        assert!(!default.include_changes);
        assert!(default.base_ref.is_none());
        let explicit = serde_json::from_value::<IsolateCurrentTaskArguments>(
            json!({ "baseRef": "origin/release", "includeChanges": false }),
        )
        .unwrap();
        assert_eq!(explicit.base_ref.as_deref(), Some("origin/release"));
        assert!(!explicit.include_changes);
    }

    #[tokio::test]
    async fn isolate_tool_rejects_threads_outside_caffold_management() {
        let runtime = test_runtime(TaskStore::memory().unwrap());
        let client = CodexThreadClient::mock(Vec::new());

        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request("external_thread", ISOLATE_CURRENT_TASK_TOOL_NAME, json!({})),
            )
            .await;

        assert!(client.mock_requests().await.is_empty());
        assert_eq!(
            client.mock_server_responses().await[0].1,
            json!({
                "contentItems": [{
                    "type": "inputText",
                    "text": "Caffold can only isolate a task that it manages."
                }],
                "success": false
            })
        );
    }

    #[tokio::test]
    async fn isolate_tool_rejects_invalid_arguments_before_reading_the_thread() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(ManagedThread::new("thread_1", None, None, None), 1)
            .unwrap();
        let runtime = test_runtime(store);
        let client = CodexThreadClient::mock(Vec::new());

        for arguments in [
            json!({ "branchName": " " }),
            json!({ "baseRef": " " }),
            json!({ "baseRef": "main", "includeChanges": true }),
            json!({ "prompt": "unexpected" }),
            json!({ "includeChanges": "yes" }),
        ] {
            runtime
                .handle_server_request(
                    &client,
                    1,
                    dynamic_tool_request("thread_1", ISOLATE_CURRENT_TASK_TOOL_NAME, arguments),
                )
                .await;
        }

        assert!(client.mock_requests().await.is_empty());
        let responses = client.mock_server_responses().await;
        assert_eq!(responses.len(), 5);
        assert_eq!(
            responses
                .iter()
                .map(|(_, response)| response["contentItems"][0]["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "`branchName` must be a non-empty string when provided.",
                "`baseRef` must be a non-empty string when provided.",
                "`baseRef` cannot be combined with `includeChanges: true`.",
                "Arguments must use optional non-empty `branchName` and `baseRef` values plus a boolean `includeChanges`.",
                "Arguments must use optional non-empty `branchName` and `baseRef` values plus a boolean `includeChanges`.",
            ]
        );
    }
}
