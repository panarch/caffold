use serde::Deserialize;
use serde_json::{Value as JsonValue, json};

use super::{ApprovalResolveError, TaskAgent, TaskRuntime};
use crate::agent;
use crate::agent::codex::{
    ApprovalKind, CodexServerRequest, CodexThreadClient, ISOLATE_CURRENT_TASK_TOOL_NAME,
    LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME, RENAME_CURRENT_TASK_TOOL_NAME, approval_request,
    approval_response,
};
use crate::agent::{
    ApprovalDecision, ApprovalOutcome, ApprovalRequest, SessionEvent, SessionEventKind,
    ThreadStatus, TurnStatus,
};
use crate::app::tasks::{
    events::{
        TaskEventPosition, TaskEventRecord, approval_requested_event, approval_resolved_event,
        now_ms,
    },
    worktrees::IsolateOutcome,
};
use crate::task_store;

/// An approval waiting for an answer.
///
/// The request is Caffold's, because that is what the interface shows and what
/// a person answers. Which agent asked sits beside it, because answering is
/// still each agent's own: Codex replies on the app-server request that asked,
/// and Claude on the control request it is blocked on. Both drivers remember
/// how to reply; what is kept here is only enough to know which one to ask.
#[derive(Debug, Clone)]
pub(super) struct PendingApproval {
    thread_id: String,
    request: ApprovalRequest,
    asked_by: AskedBy,
    position: TaskEventPosition,
}

/// Which agent is blocked on this answer.
#[derive(Debug, Clone)]
pub(super) enum AskedBy {
    Codex {
        /// Which of the three methods asked.
        kind: ApprovalKind,
        /// The request Codex sent, kept only so that allowing something hands
        /// back the permission profile Codex itself proposed.
        params: JsonValue,
    },
    /// Claude keeps what it proposed itself, so nothing is needed here.
    Claude,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameCurrentTaskArguments {
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

#[derive(Clone, Copy)]
enum CaffoldTaskTool {
    RenameCurrentTask,
    IsolateCurrentTask,
}

fn unsupported_caffold_tool(tool: &str, namespace: Option<&str>) -> String {
    let qualified_tool = namespace
        .map(|namespace| format!("{namespace}.{tool}"))
        .unwrap_or_else(|| tool.to_string());
    format!("Caffold does not serve the tool `{qualified_tool}`.")
}

fn legacy_dynamic_task_tool(
    tool: &str,
    namespace: Option<&str>,
) -> Result<CaffoldTaskTool, String> {
    if namespace.is_some() {
        return Err(unsupported_caffold_tool(tool, namespace));
    }
    match tool {
        LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME => Ok(CaffoldTaskTool::RenameCurrentTask),
        ISOLATE_CURRENT_TASK_TOOL_NAME => Ok(CaffoldTaskTool::IsolateCurrentTask),
        _ => Err(unsupported_caffold_tool(tool, None)),
    }
}

fn codex_mcp_task_tool(tool: &str) -> Result<CaffoldTaskTool, String> {
    match tool {
        RENAME_CURRENT_TASK_TOOL_NAME => Ok(CaffoldTaskTool::RenameCurrentTask),
        ISOLATE_CURRENT_TASK_TOOL_NAME => Ok(CaffoldTaskTool::IsolateCurrentTask),
        _ => Err(unsupported_caffold_tool(tool, None)),
    }
}

impl TaskRuntime {
    pub(in crate::app) async fn approval_events(&self, thread_id: &str) -> Vec<TaskEventRecord> {
        self.approvals
            .lock()
            .await
            .iter()
            .filter(|(_, pending)| pending.thread_id == thread_id)
            .map(|(_, pending)| {
                let mut event = approval_requested_event(
                    &pending.thread_id,
                    &pending.request,
                    pending.position.anchor_ms,
                );
                event.position = pending.position;
                event
            })
            .collect()
    }

    pub(in crate::app) async fn resolve_approval(
        &self,
        agent: &TaskAgent,
        thread_id: &str,
        approval_id: &str,
        decision: ApprovalDecision,
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

        if !pending.request.decisions.contains(&decision) {
            return Err(ApprovalResolveError::ResolutionMismatch);
        }
        match (&pending.asked_by, agent) {
            (AskedBy::Codex { kind, params }, TaskAgent::Codex(connection)) => {
                let response = approval_response(*kind, params, decision)
                    .ok_or(ApprovalResolveError::ResolutionMismatch)?;
                let Some(request_id) = connection.client.take_approval_request(approval_id).await
                else {
                    return Err(ApprovalResolveError::NotFound);
                };
                connection
                    .client
                    .respond_to_server_request(request_id, response)
                    .await?;
            }
            (AskedBy::Claude, TaskAgent::Claude { .. }) => {
                self.claude()
                    .resolve_approval(thread_id, approval_id, decision)
                    .await
                    .map_err(|error| match error {
                        agent::claude::ClaudeError::NoSuchApproval(_) => {
                            ApprovalResolveError::NotFound
                        }
                        error => ApprovalResolveError::Agent(error.into()),
                    })?;
            }
            // The Task's agent changed under an answer in flight, which means
            // the request being answered is not the one that was asked.
            _ => return Err(ApprovalResolveError::ResolutionMismatch),
        }
        let Some(pending) = self.approvals.lock().await.remove(approval_id) else {
            return Ok(());
        };

        self.events.publish_local(approval_resolved_event(
            &pending.thread_id,
            &pending.request,
            ApprovalOutcome::Decided(decision),
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
            CodexServerRequest::PermissionsApproval {
                id,
                thread_id,
                params,
            } => (id, thread_id, params, ApprovalKind::Permission),
            CodexServerRequest::Unknown { .. } => return,
        };
        let approval_id = approval_id_from_request(&request_id, &params);
        client.track_approval(&approval_id, request_id).await;
        let anchor_ms = params
            .get("startedAtMs")
            .and_then(JsonValue::as_u64)
            .filter(|started_at_ms| *started_at_ms > 0)
            .unwrap_or_else(now_ms);
        let request = approval_request(approval_id, kind, &params);
        self.record_pending_approval(
            &thread_id,
            request,
            anchor_ms,
            AskedBy::Codex { kind, params },
        )
        .await;
    }

    /// Put a question on the waiting list, show it, and tell a phone the once.
    ///
    /// Both agents' questions arrive here, and the same question can arrive
    /// more than once: app-server replays what is still pending whenever a
    /// connection is replaced. The waiting list answers to the identity the
    /// question was asked under, so a replay lands on the question it already
    /// is, and only the arrival that made a Task wait reaches a phone.
    pub(super) async fn record_pending_approval(
        &self,
        thread_id: &str,
        request: ApprovalRequest,
        anchor_ms: u64,
        asked_by: AskedBy,
    ) {
        let approval_id = request.id.clone();
        let event = self
            .events
            .record_local(approval_requested_event(thread_id, &request, anchor_ms));
        let newly_pending = self
            .approvals
            .lock()
            .await
            .insert(
                approval_id.clone(),
                PendingApproval {
                    thread_id: thread_id.to_owned(),
                    request,
                    asked_by,
                    position: event.event.position,
                },
            )
            .is_none();
        self.events.broadcast(event);
        if newly_pending {
            self.notify_action_required(thread_id, &approval_id);
        }
    }

    /// Tell a phone that a Task is waiting on a person.
    ///
    /// The name it carries is the one Caffold keeps for the Task, as a
    /// finished turn's notification carries. A question asked by a session
    /// Caffold does not manage is nobody's to answer here, and nothing is
    /// sent for it.
    fn notify_action_required(&self, thread_id: &str, approval_id: &str) {
        let Some(push) = self.push.as_ref() else {
            return;
        };
        match self.task_store.get(thread_id) {
            Ok(Some(managed)) => {
                let queued =
                    push.notify_action_required(thread_id, approval_id, &managed.display_name);
                eprintln!("Web Push waiting delivery queued for {queued} active installation(s)");
            }
            Ok(None) => eprintln!(
                "Web Push waiting delivery skipped because the question is not managed by Caffold"
            ),
            Err(_) => eprintln!(
                "managed task state could not be checked; waiting Web Push delivery skipped"
            ),
        }
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
        let result = match legacy_dynamic_task_tool(&tool, namespace.as_deref()) {
            Ok(tool) => {
                self.execute_caffold_tool(client, generation, &thread_id, tool, arguments)
                    .await
            }
            Err(error) => Err(error),
        };
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

    pub(in crate::app::tasks) async fn execute_codex_mcp_tool(
        &self,
        thread_id: &str,
        tool: &str,
        arguments: JsonValue,
    ) -> Result<String, String> {
        let tool = codex_mcp_task_tool(tool)?;
        let connection = self
            .connection()
            .await
            .map_err(|error| format!("Caffold could not reach Codex: {error}"))?;
        self.execute_caffold_tool(
            &connection.client,
            connection.generation,
            thread_id,
            tool,
            arguments,
        )
        .await
    }

    async fn execute_caffold_tool(
        &self,
        client: &CodexThreadClient,
        _generation: u64,
        thread_id: &str,
        tool: CaffoldTaskTool,
        arguments: JsonValue,
    ) -> Result<String, String> {
        let managed = self.managed_thread(thread_id).await?;
        if managed.is_none() {
            return Err(match tool {
                CaffoldTaskTool::RenameCurrentTask => {
                    "Caffold can only rename tasks that it manages.".to_string()
                }
                CaffoldTaskTool::IsolateCurrentTask => {
                    "Caffold can only isolate a task that it manages.".to_string()
                }
            });
        }
        if matches!(tool, CaffoldTaskTool::RenameCurrentTask) {
            let RenameCurrentTaskArguments { name } = serde_json::from_value(arguments)
                .map_err(|_| "The new task name must be a non-empty string.".to_string())?;
            let name = name.trim();
            if name.is_empty() {
                return Err("The new task name must be a non-empty string.".to_string());
            }
            client
                .set_thread_name(thread_id, name)
                .await
                .map_err(|error| format!("Caffold could not rename the current task: {error}"))?;
            let store = self.task_store.clone();
            let persisted_thread_id = thread_id.to_string();
            let persisted_name = name.to_string();
            let local_result = tokio::task::spawn_blocking(move || {
                store.update_display_name(&persisted_thread_id, &persisted_name)
            })
            .await
            .map_err(|error| format!("Task-store worker failed: {error}"))
            .and_then(|result| result.map_err(|error| error.to_string()))
            .and_then(|thread| {
                thread.ok_or_else(|| "renamed Task is no longer managed".to_string())
            });
            if let Err(error) = local_result {
                if let Some(previous_name) = managed.as_ref().map(|thread| &thread.display_name)
                    && let Err(rollback_error) =
                        client.set_thread_name(thread_id, previous_name).await
                {
                    eprintln!(
                        "failed to roll back Codex Task rename after local projection failure: {rollback_error}"
                    );
                }
                return Err(format!(
                    "Caffold renamed Codex but could not persist the Task name: {error}"
                ));
            }
            if let Some(lifecycle) = &self.lifecycle {
                lifecycle.refresh_task_list();
            }
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
            IsolateOutcome::AlreadyReady { worktree, checkout } => Ok(format!(
                "The current Caffold task is already isolated on branch `{}` at `{}`. End this turn; the user's next request will continue there.",
                checkout.branch_name, worktree.worktree_path
            )),
            IsolateOutcome::Isolated {
                worktree,
                checkout,
                source_warning,
            } => {
                let warning = source_warning
                    .map(|warning| format!(" The original checkout could not be switched to its default branch and remains detached: {warning}"))
                    .unwrap_or_default();
                let result = if include_changes {
                    format!(
                        "Moved the current Caffold task to branch `{}` at `{}` and preserved its tracked and untracked changes.",
                        checkout.branch_name, worktree.worktree_path
                    )
                } else {
                    format!(
                        "Prepared the current Caffold task on branch `{}` at `{}`. Source checkout changes were left in place.",
                        checkout.branch_name, worktree.worktree_path
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
    ) -> Result<Option<task_store::ManagedThread>, String> {
        let store = self.task_store.clone();
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || store.get(&thread_id))
            .await
            .map_err(|error| format!("Caffold could not verify the current task: {error}"))?
            .map_err(|error| format!("Caffold could not verify the current task: {error}"))
    }

    /// Retire the approvals this event left unanswerable.
    pub(super) async fn withdraw_unanswerable_approvals(&self, event: &SessionEvent) {
        let withdrawn = {
            let mut approvals = self.approvals.lock().await;
            let withdrawn = approvals
                .iter()
                .filter_map(|(approval_id, pending)| {
                    withdrawn_approval_outcome(pending, event)
                        .map(|outcome| (approval_id.clone(), outcome))
                })
                .collect::<Vec<_>>();
            withdrawn
                .into_iter()
                .filter_map(|(approval_id, outcome)| {
                    approvals
                        .remove(&approval_id)
                        .map(|pending| (pending, outcome))
                })
                .collect::<Vec<_>>()
        };

        for (pending, outcome) in withdrawn {
            self.events.publish_local(approval_resolved_event(
                &pending.thread_id,
                &pending.request,
                outcome,
            ));
        }
    }
}

/// Why an approval stopped being answerable, when nobody answered it here.
///
/// The agent answering the request itself and the turn moving on are different
/// things to say: one means somebody else decided, the other means the question
/// no longer applies.
fn withdrawn_approval_outcome(
    pending: &PendingApproval,
    event: &SessionEvent,
) -> Option<ApprovalOutcome> {
    if pending.thread_id != event.thread_id {
        return None;
    }
    let expired = Some(ApprovalOutcome::Expired);
    match &event.kind {
        SessionEventKind::ApprovalAnsweredElsewhere { approval_id }
            if pending.request.id == *approval_id =>
        {
            Some(ApprovalOutcome::AnsweredElsewhere)
        }
        SessionEventKind::TurnStarted { turn }
            if pending
                .request
                .turn_id
                .as_ref()
                .is_some_and(|turn_id| *turn_id != turn.id) =>
        {
            expired
        }
        SessionEventKind::TurnEnded { turn }
            if turn.status != TurnStatus::InProgress
                && pending
                    .request
                    .turn_id
                    .as_ref()
                    .is_none_or(|turn_id| *turn_id == turn.id) =>
        {
            expired
        }
        SessionEventKind::StatusChanged {
            status: ThreadStatus::Idle | ThreadStatus::SystemError,
        } => expired,
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
        agent::codex::{self, CodexThreadError, MockCodexResponse, session_event},
        app::tasks::CodexConnection,
        app::tasks::push::PushService,
        app::tasks::sessions::TaskSessions,
        app::tasks::worktrees::inspect_ready_worktree,
        app::tasks::{
            events::TaskEvents, lifecycle::TaskLifecycle, routes::TaskListEvents,
            worktrees::ManagedWorktrees,
        },
        fs::RootedFs,
        task_store::{ManagedThread, RunBy, TaskStore},
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
        codex::decode_server_request(
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

    fn permission_approval_request(request_id: i64) -> CodexServerRequest {
        codex::decode_server_request(
            json!(request_id),
            "item/permissions/requestApproval",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "itemId": "item_1",
                "cwd": "/workspace/project",
                "permissions": {
                    "network": { "enabled": true },
                    "fileSystem": {
                        "entries": [{
                            "access": "write",
                            "path": { "type": "path", "path": "/workspace/shared" }
                        }]
                    }
                },
                "reason": "Download a fixture and update the shared cache",
                "startedAtMs": 1_750_000_000_000_i64
            }),
        )
        .unwrap()
    }

    fn command_approval_request(request_id: i64) -> CodexServerRequest {
        codex::decode_server_request(
            json!(request_id),
            "item/commandExecution/requestApproval",
            json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "command": "cargo test",
                "cwd": "/workspace/project",
                "reason": "Run the test suite",
                "availableDecisions": ["accept", "acceptForSession", "decline"]
            }),
        )
        .unwrap()
    }

    fn runtime_with_events(events: TaskEvents) -> TaskRuntime {
        test_runtime_with_store(events, TaskStore::memory().unwrap())
    }

    fn test_runtime(store: TaskStore) -> TaskRuntime {
        test_runtime_with_store(TaskEvents::default(), store)
    }

    fn test_runtime_with_store(events: TaskEvents, store: TaskStore) -> TaskRuntime {
        let (shutdown, _) = broadcast::channel(1);
        TaskRuntime::new(
            agent::claude::ClaudeClient::mock().0,
            TaskSessions::default(),
            events,
            store,
            shutdown,
        )
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
                codex::decode_server_request(
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

        let event = receiver.recv().await.unwrap().event;
        assert_eq!(event.thread_id, "thread_1");
        assert_eq!(event.event_type, "approval_requested");
        assert_eq!(
            event.payload.as_ref().unwrap()["turnId"],
            "turn_1",
            "approval events must remain attached to their causal turn"
        );
        assert_eq!(event.payload.as_ref().unwrap()["command"], "cargo test");
        let approvals = runtime.approval_events("thread_1").await;
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].id, event.id);
        assert_eq!(approvals[0].position.anchor_ms, event.position.anchor_ms);
        assert_eq!(approvals[0].position.index, event.position.index);
        assert_eq!(
            approvals[0].payload.as_ref().unwrap()["command"],
            "cargo test"
        );
        assert_eq!(events.for_thread("thread_1"), vec![event]);
    }

    /// A Task that starts waiting tells a phone once, however often it is
    /// asked, and tells it nothing of what was asked.
    #[tokio::test]
    async fn a_task_that_starts_waiting_notifies_once_and_says_only_which_task() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1_000,
            )
            .unwrap();
        store
            .update_display_name("thread_1", "Review Web Push")
            .unwrap();
        store
            .upsert_push_installation(
                task_store::PushSubscriptionInput {
                    client_id: "00000000-0000-4000-8000-000000000001".to_owned(),
                    installation_label: "Chrome on macOS · 00000000".to_owned(),
                    endpoint: "https://push.example.test/subscription".to_owned(),
                    p256dh: "test-public-key".to_owned(),
                    auth: "test-auth".to_owned(),
                    expiration_time_ms: None,
                },
                1_000,
            )
            .unwrap();
        let (push, mut deliveries) = PushService::test_channel(store.clone());
        let runtime = test_runtime_with_store(TaskEvents::default(), store).with_push_service(push);
        let client = CodexThreadClient::mock(Vec::new());

        runtime
            .handle_server_request(&client, 1, command_approval_request(11))
            .await;

        let asked = deliveries.try_recv().expect("a waiting Task is announced");
        let payload: JsonValue = serde_json::from_slice(&asked.payload).unwrap();
        assert_eq!(
            payload,
            json!({
                "kind": "actionRequired",
                "threadId": "thread_1",
                "taskName": "Review Web Push",
                "tag": asked.topic,
            }),
            "the command, its cwd, and the agent's reason stay out of the payload"
        );

        // A replaced connection replays what is still pending, under the
        // identity it was asked under.
        runtime
            .handle_server_request(&client, 1, command_approval_request(11))
            .await;
        assert!(deliveries.try_recv().is_err());

        for (request, kind) in [
            (
                codex::decode_server_request(
                    json!(12),
                    "item/fileChange/requestApproval",
                    json!({
                        "threadId": "thread_1",
                        "turnId": "turn_1",
                        "itemId": "item_2",
                        "changes": [{ "path": "/workspace/project/src/main.rs" }]
                    }),
                )
                .unwrap(),
                "a file change",
            ),
            (permission_approval_request(13), "a permission profile"),
        ] {
            runtime.handle_server_request(&client, 1, request).await;
            let next = deliveries
                .try_recv()
                .unwrap_or_else(|_| panic!("{kind} is a question like any other"));
            assert_ne!(next.topic, asked.topic);
        }

        runtime
            .handle_server_request(
                &client,
                1,
                codex::decode_server_request(
                    json!(13),
                    "item/commandExecution/requestApproval",
                    json!({
                        "threadId": "outside-caffold",
                        "turnId": "turn_1",
                        "command": "cargo test",
                        "availableDecisions": ["accept", "decline"]
                    }),
                )
                .unwrap(),
            )
            .await;
        assert!(
            deliveries.try_recv().is_err(),
            "a question asked of a session Caffold does not manage notifies nobody"
        );
    }

    #[tokio::test]
    async fn standard_approval_resolutions_preserve_the_selected_codex_decision() {
        let runtime = runtime_with_events(TaskEvents::default());
        let client = CodexThreadClient::mock(Vec::new());
        runtime
            .handle_server_request(&client, 1, command_approval_request(41))
            .await;

        runtime
            .resolve_approval(
                &TaskAgent::Codex(CodexConnection {
                    client: client.clone(),
                    generation: 1,
                }),
                "thread_1",
                "41",
                ApprovalDecision::AllowAlways,
            )
            .await
            .unwrap();

        assert_eq!(
            client.mock_server_responses().await,
            [(json!(41), json!({ "decision": "acceptForSession" }))]
        );
        assert!(runtime.approval_events("thread_1").await.is_empty());
    }

    #[tokio::test]
    async fn permission_approvals_return_the_original_complete_profile_for_the_selected_scope() {
        let events = TaskEvents::default();
        let runtime = runtime_with_events(events.clone());
        let client = CodexThreadClient::mock(Vec::new());
        runtime
            .handle_server_request(&client, 1, permission_approval_request(42))
            .await;

        let requested = runtime.approval_events("thread_1").await;
        assert_eq!(requested.len(), 1);
        assert_eq!(requested[0].summary, "Permission requested");
        assert_eq!(requested[0].position.anchor_ms, 1_750_000_000_000);

        runtime
            .resolve_approval(
                &TaskAgent::Codex(CodexConnection {
                    client: client.clone(),
                    generation: 1,
                }),
                "thread_1",
                "42",
                ApprovalDecision::AllowAlways,
            )
            .await
            .unwrap();

        assert_eq!(
            client.mock_server_responses().await,
            [(
                json!(42),
                json!({
                    "permissions": {
                        "network": { "enabled": true },
                        "fileSystem": {
                            "entries": [{
                                "access": "write",
                                "path": { "type": "path", "path": "/workspace/shared" }
                            }]
                        }
                    },
                    "scope": "session"
                })
            )]
        );
        assert!(runtime.approval_events("thread_1").await.is_empty());
        let event = events.for_thread("thread_1").pop().unwrap();
        assert_eq!(event.event_type, "approval_resolved");
        assert_eq!(event.payload.as_ref().unwrap()["outcome"], "allowAlways");
    }

    #[tokio::test]
    async fn permission_approvals_support_a_turn_limited_grant() {
        let runtime = runtime_with_events(TaskEvents::default());
        let client = CodexThreadClient::mock(Vec::new());
        runtime
            .handle_server_request(&client, 1, permission_approval_request(46))
            .await;

        runtime
            .resolve_approval(
                &TaskAgent::Codex(CodexConnection {
                    client: client.clone(),
                    generation: 1,
                }),
                "thread_1",
                "46",
                ApprovalDecision::Allow,
            )
            .await
            .unwrap();

        assert_eq!(client.mock_server_responses().await[0].1["scope"], "turn");
    }

    #[tokio::test]
    async fn denying_permission_approvals_returns_an_empty_profile() {
        let runtime = runtime_with_events(TaskEvents::default());
        let client = CodexThreadClient::mock(Vec::new());
        runtime
            .handle_server_request(&client, 1, permission_approval_request(43))
            .await;

        runtime
            .resolve_approval(
                &TaskAgent::Codex(CodexConnection {
                    client: client.clone(),
                    generation: 1,
                }),
                "thread_1",
                "43",
                ApprovalDecision::Deny,
            )
            .await
            .unwrap();

        assert_eq!(
            client.mock_server_responses().await,
            [(json!(43), json!({ "permissions": {} }))]
        );
    }

    #[tokio::test]
    async fn an_approval_refuses_a_decision_it_did_not_offer() {
        let runtime = runtime_with_events(TaskEvents::default());
        let client = CodexThreadClient::mock(Vec::new());
        runtime
            .handle_server_request(&client, 1, permission_approval_request(44))
            .await;

        let result = runtime
            .resolve_approval(
                &TaskAgent::Codex(CodexConnection {
                    client: client.clone(),
                    generation: 1,
                }),
                "thread_1",
                "44",
                // Codex's permission response has no way to end a turn, so a
                // permission request never offers this.
                ApprovalDecision::DenyAndStop,
            )
            .await;

        assert!(matches!(
            result,
            Err(ApprovalResolveError::ResolutionMismatch)
        ));
        assert!(client.mock_server_responses().await.is_empty());
        assert_eq!(runtime.approval_events("thread_1").await.len(), 1);
    }

    #[tokio::test]
    async fn answering_an_approval_the_connection_no_longer_holds_is_not_found() {
        // Codex resolving a request and a person answering it can race. The
        // connection holds each request once, so whichever arrives second finds
        // nothing to answer rather than replying twice.
        let runtime = runtime_with_events(TaskEvents::default());
        let client = CodexThreadClient::mock(Vec::new());
        runtime
            .handle_server_request(&client, 1, permission_approval_request(47))
            .await;
        client
            .take_approval_request("47")
            .await
            .expect("the request was tracked");

        let result = runtime
            .resolve_approval(
                &TaskAgent::Codex(CodexConnection {
                    client: client.clone(),
                    generation: 1,
                }),
                "thread_1",
                "47",
                ApprovalDecision::Allow,
            )
            .await;

        assert!(matches!(result, Err(ApprovalResolveError::NotFound)));
        assert!(client.mock_server_responses().await.is_empty());
    }

    #[tokio::test]
    async fn an_approval_codex_answered_itself_is_withdrawn_once() {
        let events = TaskEvents::default();
        let runtime = runtime_with_events(events.clone());
        let client = CodexThreadClient::mock(Vec::new());
        runtime
            .handle_server_request(&client, 1, permission_approval_request(45))
            .await;
        let resolved = codex::decode_notification(
            "serverRequest/resolved",
            json!({ "threadId": "thread_1", "requestId": 45 }),
        )
        .unwrap();

        // Only the first says which approval was answered; after that the
        // driver has nothing left on that request to name.
        let Some(answered) = session_event(&resolved, &client).await else {
            panic!("the first resolution names the approval it answered");
        };
        assert!(
            session_event(&resolved, &client).await.is_none(),
            "the same resolution has nothing left to withdraw"
        );
        runtime.withdraw_unanswerable_approvals(&answered).await;
        runtime.withdraw_unanswerable_approvals(&answered).await;

        assert!(runtime.approval_events("thread_1").await.is_empty());
        let task_events = events.for_thread("thread_1");
        assert_eq!(task_events.len(), 2);
        assert_eq!(task_events[1].event_type, "approval_resolved");
        assert_eq!(
            task_events[1].payload.as_ref().unwrap()["outcome"],
            "answeredElsewhere"
        );
    }

    #[tokio::test]
    async fn rename_dynamic_tool_updates_only_the_current_managed_thread() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
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
                    LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME,
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
        assert_eq!(
            runtime
                .task_store
                .get("thread_1")
                .unwrap()
                .unwrap()
                .display_name,
            "Whisper voice input"
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
                    LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME,
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
    async fn rename_dynamic_tool_rolls_codex_back_when_the_local_row_disappears() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1,
            )
            .unwrap();
        store
            .update_display_name("thread_1", "Previous stable name")
            .unwrap();
        let runtime = test_runtime(store.clone());
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::delayed_ok(
                "thread/name/set",
                json!({}),
                std::time::Duration::from_millis(100),
            ),
            MockCodexResponse::ok_for(
                "thread/name/set",
                json!({
                    "threadId": "thread_1",
                    "name": "Previous stable name",
                }),
                json!({}),
            ),
        ]);
        let task_runtime = runtime.clone();
        let task_client = client.clone();
        let request = tokio::spawn(async move {
            task_runtime
                .handle_server_request(
                    &task_client,
                    1,
                    dynamic_tool_request(
                        "thread_1",
                        LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME,
                        json!({ "name": "New name" }),
                    ),
                )
                .await;
        });
        for _ in 0..100 {
            if !client.mock_requests().await.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
        assert_eq!(client.mock_requests().await.len(), 1);
        assert!(store.delete("thread_1").unwrap());

        request.await.unwrap();

        assert_eq!(
            client.mock_requests().await,
            [
                (
                    "thread/name/set".to_string(),
                    json!({"threadId": "thread_1", "name": "New name"}),
                ),
                (
                    "thread/name/set".to_string(),
                    json!({"threadId": "thread_1", "name": "Previous stable name"}),
                ),
            ]
        );
        assert_eq!(client.mock_server_responses().await[0].1["success"], false);
    }

    #[tokio::test]
    async fn rename_dynamic_tool_rejects_invalid_names_and_unknown_tools() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1,
            )
            .unwrap();
        let runtime = test_runtime(store);
        let client = CodexThreadClient::mock(Vec::new());

        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request(
                    "thread_1",
                    LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME,
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
        runtime
            .handle_server_request(
                &client,
                1,
                dynamic_tool_request(
                    "thread_1",
                    RENAME_CURRENT_TASK_TOOL_NAME,
                    json!({ "name": "Wrong ingress" }),
                ),
            )
            .await;

        assert!(client.mock_requests().await.is_empty());
        let responses = client.mock_server_responses().await;
        assert_eq!(responses.len(), 3);
        assert_eq!(responses[0].1["success"], false);
        assert_eq!(
            responses[0].1["contentItems"][0]["text"],
            "The new task name must be a non-empty string."
        );
        assert_eq!(responses[1].1["success"], false);
        assert_eq!(
            responses[1].1["contentItems"][0]["text"],
            "Caffold does not serve the tool `future_tool`."
        );
        assert_eq!(responses[2].1["success"], false);
        assert_eq!(
            responses[2].1["contentItems"][0]["text"],
            "Caffold does not serve the tool `rename_current_task`."
        );
    }

    #[tokio::test]
    async fn rename_dynamic_tool_returns_a_failed_result_when_app_server_rejects_the_name() {
        let store = TaskStore::memory().unwrap();
        store
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1,
            )
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
                    LEGACY_RENAME_CURRENT_THREAD_TOOL_NAME,
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
                codex::decode_server_request(
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
        let requested = receiver.recv().await.unwrap().event;
        assert_eq!(requested.event_type, "approval_requested");

        let completed = codex::decode_notification(
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
            .withdraw_unanswerable_approvals(
                &session_event(&completed, &CodexThreadClient::mock(Vec::new()))
                    .await
                    .expect("a completed turn is something Caffold acts on"),
            )
            .await;

        assert!(runtime.approval_events("thread_1").await.is_empty());
        let resolved = receiver.recv().await.unwrap().event;
        assert_eq!(resolved.event_type, "approval_resolved");
        assert_eq!(resolved.payload.as_ref().unwrap()["approvalId"], "11");
        assert_eq!(resolved.payload.as_ref().unwrap()["outcome"], "expired");
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
                    RunBy::Codex,
                    None,
                    Some("gpt-test".to_string()),
                    Some("high".to_string()),
                ),
                1,
            )
            .unwrap();
        let sessions = TaskSessions::default();
        let events = TaskEvents::default();
        let worktrees = ManagedWorktrees::new(
            fs.clone(),
            store.clone(),
            root.path().join("managed-worktrees"),
        )
        .unwrap();
        let (claude, _runner) = agent::claude::ClaudeClient::mock();
        let lifecycle = TaskLifecycle::new(
            fs.clone(),
            sessions.clone(),
            events.clone(),
            TaskListEvents::new(),
            store.clone(),
            worktrees,
            claude.clone(),
        );
        let (shutdown, _) = broadcast::channel(1);
        let runtime = TaskRuntime::new(claude, sessions, events, store.clone(), shutdown)
            .with_lifecycle(lifecycle);
        let thread_read = json!({
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
        });
        let client = CodexThreadClient::mock(vec![
            MockCodexResponse::ok("thread/read", thread_read.clone()),
            MockCodexResponse::ok("thread/read", thread_read),
        ]);

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
        let live_branch = inspect_ready_worktree(&records[0]).unwrap().branch_name;
        assert!(live_branch.starts_with("caffold/review-issue-42-"));
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
                live_branch, records[0].worktree_path
            )
        );

        let stored_before_switch = records[0].clone();
        let switched = Command::new("git")
            .arg("-C")
            .arg(&records[0].worktree_path)
            .args(["switch", "-c", "review/next"])
            .output()
            .unwrap();
        assert!(
            switched.status.success(),
            "{}",
            String::from_utf8_lossy(&switched.stderr)
        );
        runtime
            .handle_server_request(
                &client,
                2,
                dynamic_tool_request("thread_source", ISOLATE_CURRENT_TASK_TOOL_NAME, json!({})),
            )
            .await;

        let responses = client.mock_server_responses().await;
        assert_eq!(responses[1].1["success"], true);
        assert_eq!(
            responses[1].1["contentItems"][0]["text"],
            format!(
                "The current Caffold task is already isolated on branch `review/next` at `{}`. End this turn; the user's next request will continue there.",
                records[0].worktree_path
            )
        );
        assert_eq!(
            store.worktree(&records[0].worktree_id).unwrap().unwrap(),
            stored_before_switch
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
            .claim(
                ManagedThread::new("thread_1", RunBy::Codex, None, None, None),
                1,
            )
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
