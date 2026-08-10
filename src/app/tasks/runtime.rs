use std::{collections::HashMap, sync::Arc};

use futures_util::{StreamExt, stream};
use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use tokio::sync::{Mutex, broadcast};

use super::events::{
    TaskEventRecord, TaskEvents, event_id_from_params, now_ms, seconds_to_ms_value,
    task_event_from_item_lifecycle, task_event_from_raw_response_item, task_event_record,
};
use super::{lifecycle::TaskLifecycle, worktrees::IsolateOutcome};
use crate::{
    codex_app_server::{
        CodexNotification, CodexRuntimeEvent, CodexServerRequest, CodexThreadClient,
        CodexThreadError, ISOLATE_CURRENT_TASK_TOOL_NAME, RENAME_CURRENT_THREAD_TOOL_NAME,
        ThreadStatus, TurnStatus,
    },
    codex_thread_sessions::{CodexThreadSessions, ThreadSessionSnapshot},
    task_store::TaskStore,
};

#[derive(Clone)]
pub(in crate::app) struct CodexRuntime {
    process: Arc<CodexProcess>,
    sessions: CodexThreadSessions,
    events: TaskEvents,
    task_store: TaskStore,
    lifecycle: Option<TaskLifecycle>,
    approvals: Arc<Mutex<HashMap<String, PendingApproval>>>,
    signals: broadcast::Sender<CodexRuntimeSignal>,
    shutdown: broadcast::Sender<()>,
}

#[derive(Default)]
struct CodexProcess {
    state: Mutex<CodexProcessState>,
}

#[derive(Default)]
struct CodexProcessState {
    client: Option<CodexThreadClient>,
    generation: u64,
}

#[derive(Clone)]
pub(in crate::app) struct CodexConnection {
    pub(in crate::app) client: CodexThreadClient,
    pub(in crate::app) generation: u64,
}

#[derive(Clone)]
pub(in crate::app) enum CodexRuntimeSignal {
    SessionChanged {
        thread_id: String,
        snapshot: Box<ThreadSessionSnapshot>,
    },
    SessionUnavailable {
        thread_id: String,
        message: String,
    },
}

#[derive(Debug)]
pub(in crate::app) enum ApprovalResolveError {
    NotFound,
    ThreadMismatch,
    Codex(CodexThreadError),
}

impl From<CodexThreadError> for ApprovalResolveError {
    fn from(error: CodexThreadError) -> Self {
        Self::Codex(error)
    }
}

#[derive(Debug, Clone)]
struct PendingApproval {
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
    pub(in crate::app) fn new(
        sessions: CodexThreadSessions,
        events: TaskEvents,
        task_store: TaskStore,
        shutdown: broadcast::Sender<()>,
    ) -> Self {
        let (signals, _) = broadcast::channel(64);
        Self {
            process: Arc::new(CodexProcess::default()),
            sessions,
            events,
            task_store,
            lifecycle: None,
            approvals: Arc::new(Mutex::new(HashMap::new())),
            signals,
            shutdown,
        }
    }

    pub(in crate::app) fn with_lifecycle(mut self, lifecycle: TaskLifecycle) -> Self {
        self.lifecycle = Some(lifecycle);
        self
    }

    pub(in crate::app) fn subscribe(&self) -> broadcast::Receiver<CodexRuntimeSignal> {
        self.signals.subscribe()
    }

    pub(in crate::app) fn startup(&self) {
        let runtime = self.clone();
        tokio::spawn(async move {
            if let Err(error) = runtime.connection().await {
                eprintln!("failed to connect to the Codex app-server daemon: {error}");
            }
        });
    }

    pub(in crate::app) async fn connection(&self) -> Result<CodexConnection, CodexThreadError> {
        {
            let process = self.process.state.lock().await;
            if let Some(client) = process.client.clone() {
                return Ok(CodexConnection {
                    client,
                    generation: process.generation,
                });
            }
        }

        let connection = {
            let mut process = self.process.state.lock().await;
            if let Some(client) = process.client.clone() {
                return Ok(CodexConnection {
                    client,
                    generation: process.generation,
                });
            }

            let client = CodexThreadClient::start().await?;
            process.generation = process.generation.saturating_add(1);
            let generation = process.generation;
            self.spawn_bridge(client.clone(), generation, self.shutdown.subscribe());
            process.client = Some(client.clone());
            CodexConnection { client, generation }
        };

        self.restore_connection_state(connection.clone());
        Ok(connection)
    }

    pub(in crate::app) async fn client(&self) -> Result<CodexThreadClient, CodexThreadError> {
        self.connection().await.map(|connection| connection.client)
    }

    pub(in crate::app) async fn diagnostics(&self) -> (u64, bool) {
        let process = self.process.state.lock().await;
        (process.generation, process.client.is_some())
    }

    pub(in crate::app) async fn shutdown(&self) {
        let client = self.process.state.lock().await.client.take();
        if let Some(client) = client {
            client.shutdown().await;
        }
    }

    pub(in crate::app) async fn recover_connection_error(
        &self,
        connection: &CodexConnection,
        error: &CodexThreadError,
    ) {
        if !error.is_connection_failure() {
            return;
        }
        let message = error.to_string();
        let affected = self
            .sessions
            .connection_lost(connection.generation, message.clone())
            .await;
        for thread_id in affected {
            let _ = self.signals.send(CodexRuntimeSignal::SessionUnavailable {
                thread_id,
                message: message.clone(),
            });
        }
        self.process
            .invalidate_after_error(connection.generation, error)
            .await;
    }

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

    fn spawn_bridge(
        &self,
        client: CodexThreadClient,
        generation: u64,
        mut shutdown: broadcast::Receiver<()>,
    ) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let mut receiver = client.subscribe();
            let connection_error = loop {
                tokio::select! {
                    _ = shutdown.recv() => return,
                    event = receiver.recv() => {
                        let event = match event {
                            Ok(event) => event,
                            Err(error) => {
                                break format!("Codex app-server event stream closed: {error}");
                            }
                        };
                        match event {
                            CodexRuntimeEvent::Notification(notification) => {
                                let thread_id =
                                    notification_thread_id(&notification).map(str::to_string);
                                let revision = runtime
                                    .sessions
                                    .apply_notification(generation, &notification)
                                    .await;
                                runtime
                                    .expire_stale_approvals_for_notification(&notification)
                                    .await;
                                runtime.handle_notification(notification);
                                if revision.is_some()
                                    && let Some(thread_id) = thread_id
                                    && let Some(snapshot) =
                                        runtime.sessions.snapshot(&thread_id).await
                                {
                                    let _ = runtime.signals.send(
                                        CodexRuntimeSignal::SessionChanged {
                                            thread_id,
                                            snapshot: Box::new(snapshot),
                                        },
                                    );
                                }
                            }
                            CodexRuntimeEvent::ServerRequest(request) => {
                                runtime.handle_server_request(&client, generation, request).await;
                            }
                            CodexRuntimeEvent::Diagnostic { message } => {
                                eprintln!("{message}");
                            }
                            CodexRuntimeEvent::Error { message } => {
                                break message;
                            }
                        }
                    }
                }
            };
            let affected = runtime
                .sessions
                .connection_lost(generation, connection_error.clone())
                .await;
            for thread_id in affected {
                let _ = runtime
                    .signals
                    .send(CodexRuntimeSignal::SessionUnavailable {
                        thread_id,
                        message: connection_error.clone(),
                    });
            }
            runtime.process.invalidate(generation).await;
        });
    }

    fn restore_connection_state(&self, connection: CodexConnection) {
        let runtime = self.clone();
        tokio::spawn(async move {
            for (thread_id, error) in runtime
                .sessions
                .resubscribe_leased(&connection.client, connection.generation)
                .await
            {
                eprintln!("failed to restore Codex thread subscription {thread_id}: {error}");
            }
            runtime.recover_loaded_sessions(connection).await;
        });
    }

    async fn recover_loaded_sessions(&self, connection: CodexConnection) {
        let loaded_thread_ids = match connection.client.list_all_loaded_threads().await {
            Ok(thread_ids) => thread_ids,
            Err(error) => {
                eprintln!("failed to list loaded Codex threads during startup recovery: {error}");
                return;
            }
        };
        let task_store = self.task_store.clone();
        let managed_thread_ids = match tokio::task::spawn_blocking(move || {
            loaded_thread_ids
                .into_iter()
                .map(|thread_id| {
                    task_store
                        .get(&thread_id)
                        .map(|managed| managed.map(|_| thread_id))
                })
                .filter_map(|result| match result {
                    Ok(thread_id) => thread_id.map(Ok),
                    Err(error) => Some(Err(error)),
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .await
        {
            Ok(Ok(thread_ids)) => thread_ids,
            Ok(Err(error)) => {
                eprintln!("failed to read managed threads during startup recovery: {error}");
                return;
            }
            Err(error) => {
                eprintln!("managed thread recovery worker failed: {error}");
                return;
            }
        };

        stream::iter(managed_thread_ids)
            .for_each_concurrent(8, |thread_id| {
                let runtime = self.clone();
                let connection = connection.clone();
                async move {
                    match runtime
                        .sessions
                        .recover_loaded_thread(
                            &connection.client,
                            connection.generation,
                            &thread_id,
                        )
                        .await
                    {
                        Ok(Some(snapshot)) => {
                            let _ = runtime.signals.send(CodexRuntimeSignal::SessionChanged {
                                thread_id,
                                snapshot: Box::new(snapshot),
                            });
                        }
                        Ok(None) => {}
                        Err(error) => {
                            eprintln!("failed to recover loaded Codex thread {thread_id}: {error}");
                        }
                    }
                }
            })
            .await;
    }

    fn handle_notification(&self, notification: CodexNotification) {
        match notification {
            CodexNotification::TurnStarted { thread_id, turn } => {
                let started_ms = turn
                    .started_at
                    .map(seconds_to_ms_value)
                    .filter(|value| *value > 0)
                    .unwrap_or_else(now_ms);
                let params = json!({ "threadId": thread_id, "turn": turn });
                self.events.publish(task_event_record(
                    &thread_id,
                    &event_id_from_params("turn_started", &params),
                    "turn_started",
                    "Turn started",
                    Some(params),
                    started_ms,
                ));
            }
            CodexNotification::ThreadStatusChanged { thread_id, status } => {
                let task_status = match status {
                    ThreadStatus::Active { .. } => "running",
                    ThreadStatus::Idle | ThreadStatus::NotLoaded => "idle",
                    ThreadStatus::SystemError => "failed",
                };
                let summary = match task_status {
                    "running" => "Thread running",
                    "failed" => "Thread failed",
                    _ => "Thread idle",
                };
                self.events.publish(task_event_record(
                    &thread_id,
                    "thread_status_changed",
                    "thread_status_changed",
                    summary,
                    Some(json!({
                        "threadId": thread_id,
                        "status": task_status,
                    })),
                    now_ms(),
                ));
            }
            CodexNotification::ThreadNameUpdated { .. }
            | CodexNotification::ThreadSettingsUpdated { .. } => {}
            CodexNotification::ItemStarted {
                thread_id,
                turn_id,
                item,
                started_at_ms,
            } => {
                let created_ms = if started_at_ms > 0 {
                    started_at_ms
                } else {
                    now_ms()
                };
                let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
                if let Some(event) =
                    task_event_from_item_lifecycle(&thread_id, created_ms, &params, "started")
                {
                    self.events.publish(event);
                }
            }
            CodexNotification::ItemCompleted {
                thread_id,
                turn_id,
                item,
                completed_at_ms,
            } => {
                let created_ms = if completed_at_ms > 0 {
                    completed_at_ms
                } else {
                    now_ms()
                };
                let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
                if let Some(event) =
                    task_event_from_item_lifecycle(&thread_id, created_ms, &params, "completed")
                {
                    self.events.publish(event);
                }
            }
            CodexNotification::RawResponseItemCompleted {
                thread_id,
                turn_id,
                item,
            } => {
                let params = json!({ "threadId": thread_id, "turnId": turn_id, "item": item });
                if let Some(event) =
                    task_event_from_raw_response_item(&thread_id, now_ms(), &params)
                {
                    self.events.publish(event);
                }
            }
            CodexNotification::TurnCompleted { thread_id, turn } => {
                let task_status = match turn.status {
                    TurnStatus::Failed => "failed",
                    TurnStatus::Interrupted => "interrupted",
                    TurnStatus::Completed => "completed",
                    TurnStatus::InProgress => "running",
                };
                let summary = match task_status {
                    "failed" => "Turn failed",
                    "interrupted" => "Turn interrupted",
                    "completed" => "Turn completed",
                    _ => "Turn updated",
                };
                let completed_ms = turn
                    .completed_at
                    .map(seconds_to_ms_value)
                    .filter(|value| *value > 0)
                    .unwrap_or_else(now_ms);
                if let Err(error) = self
                    .task_store
                    .update_completed_at(&thread_id, completed_ms)
                {
                    eprintln!("failed to persist completed turn for {thread_id}: {error}");
                }
                let params = json!({ "threadId": thread_id, "turn": turn });
                self.events.publish(task_event_record(
                    &thread_id,
                    &event_id_from_params("turn_completed", &params),
                    "turn_completed",
                    summary,
                    Some(params),
                    completed_ms,
                ));
            }
            CodexNotification::TurnDiffUpdated { thread_id, params } => {
                self.events.publish(task_event_record(
                    &thread_id,
                    "diff_updated",
                    "diff_updated",
                    "Diff updated",
                    Some(params),
                    now_ms(),
                ));
            }
            CodexNotification::ThreadStarted { .. } | CodexNotification::Unknown { .. } => {}
        }
    }

    async fn handle_server_request(
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
            include_changes,
        } = serde_json::from_value(arguments).map_err(|_| {
            "Arguments must use an optional non-empty `branchName` and a boolean `includeChanges`."
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

    async fn expire_stale_approvals_for_notification(&self, notification: &CodexNotification) {
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

    #[cfg(test)]
    pub(in crate::app) async fn install_test_client(
        &self,
        generation: u64,
        client: CodexThreadClient,
    ) {
        let mut process = self.process.state.lock().await;
        process.generation = generation;
        process.client = Some(client);
    }

    #[cfg(test)]
    pub(in crate::app) async fn hold_process_lock_for_test(
        &self,
        entered: tokio::sync::oneshot::Sender<()>,
        duration: std::time::Duration,
    ) {
        let _process = self.process.state.lock().await;
        let _ = entered.send(());
        tokio::time::sleep(duration).await;
    }

    #[cfg(test)]
    pub(in crate::app) fn restore_test_sessions(&self, connection: CodexConnection) {
        self.restore_connection_state(connection);
    }

    #[cfg(test)]
    pub(in crate::app) async fn recover_test_loaded_sessions(&self, connection: CodexConnection) {
        self.recover_loaded_sessions(connection).await;
    }

    #[cfg(test)]
    pub(in crate::app) fn handle_test_notification(&self, notification: CodexNotification) {
        self.handle_notification(notification);
    }

    #[cfg(test)]
    pub(in crate::app) fn test_task_store(&self) -> TaskStore {
        self.task_store.clone()
    }

    #[cfg(test)]
    pub(in crate::app) async fn handle_test_server_request(
        &self,
        client: &CodexThreadClient,
        request: CodexServerRequest,
    ) {
        self.handle_server_request(client, 1, request).await;
    }

    #[cfg(test)]
    pub(in crate::app) async fn expire_test_approvals(&self, notification: &CodexNotification) {
        self.expire_stale_approvals_for_notification(notification)
            .await;
    }
}

impl CodexProcess {
    async fn invalidate(&self, generation: u64) {
        let client = {
            let mut process = self.state.lock().await;
            if process.generation != generation {
                return;
            }
            process.client.take()
        };
        if let Some(client) = client {
            client.shutdown().await;
        }
    }

    async fn invalidate_after_error(&self, generation: u64, error: &CodexThreadError) -> bool {
        if !error.is_connection_failure() {
            return false;
        }
        let client = {
            let mut process = self.state.lock().await;
            if process.generation != generation {
                return false;
            }
            process.client.take()
        };
        if let Some(client) = client {
            client.shutdown().await;
            true
        } else {
            false
        }
    }
}

fn notification_thread_id(notification: &CodexNotification) -> Option<&str> {
    match notification {
        CodexNotification::ThreadStarted { thread } => Some(&thread.id),
        CodexNotification::ThreadStatusChanged { thread_id, .. }
        | CodexNotification::ThreadNameUpdated { thread_id, .. }
        | CodexNotification::ThreadSettingsUpdated { thread_id, .. }
        | CodexNotification::TurnStarted { thread_id, .. }
        | CodexNotification::TurnCompleted { thread_id, .. }
        | CodexNotification::ItemStarted { thread_id, .. }
        | CodexNotification::ItemCompleted { thread_id, .. }
        | CodexNotification::RawResponseItemCompleted { thread_id, .. }
        | CodexNotification::TurnDiffUpdated { thread_id, .. } => Some(thread_id),
        CodexNotification::Unknown { .. } => None,
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

    use serde_json::{Value as JsonValue, json};

    use super::*;
    use crate::{
        app::tasks::{routes::TaskListEvents, worktrees::ManagedWorktrees},
        codex_app_server::{self, MockCodexResponse},
        fs::RootedFs,
        task_store::ManagedThread,
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

    fn test_runtime(store: TaskStore) -> CodexRuntime {
        let (shutdown, _) = broadcast::channel(1);
        CodexRuntime::new(
            CodexThreadSessions::default(),
            TaskEvents::default(),
            store,
            shutdown,
        )
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
            .handle_test_server_request(
                &client,
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
    fn isolate_tool_defaults_change_transfer_to_false_and_accepts_explicit_opt_in() {
        let default = serde_json::from_value::<IsolateCurrentTaskArguments>(json!({})).unwrap();
        assert!(!default.include_changes);
        let explicit = serde_json::from_value::<IsolateCurrentTaskArguments>(
            json!({ "includeChanges": true }),
        )
        .unwrap();
        assert!(explicit.include_changes);
    }

    #[tokio::test]
    async fn isolate_tool_rejects_threads_outside_caffold_management() {
        let store = TaskStore::memory().unwrap();
        let runtime = test_runtime(store);
        let client = CodexThreadClient::mock(Vec::new());

        runtime
            .handle_test_server_request(
                &client,
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
            json!({ "prompt": "unexpected" }),
            json!({ "includeChanges": "yes" }),
        ] {
            runtime
                .handle_test_server_request(
                    &client,
                    dynamic_tool_request("thread_1", ISOLATE_CURRENT_TASK_TOOL_NAME, arguments),
                )
                .await;
        }

        assert!(client.mock_requests().await.is_empty());
        let responses = client.mock_server_responses().await;
        assert_eq!(responses.len(), 3);
        assert_eq!(
            responses
                .iter()
                .map(|(_, response)| response["contentItems"][0]["text"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "`branchName` must be a non-empty string when provided.",
                "Arguments must use an optional non-empty `branchName` and a boolean `includeChanges`.",
                "Arguments must use an optional non-empty `branchName` and a boolean `includeChanges`.",
            ]
        );
    }
}
