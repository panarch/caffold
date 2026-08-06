use std::{collections::HashMap, sync::Arc};

use serde::Deserialize;
use serde_json::{Value as JsonValue, json};
use tokio::sync::{Mutex, broadcast};

use super::events::{
    TaskEventRecord, TaskEvents, event_id_from_params, now_ms, seconds_to_ms_value,
    task_event_from_item_lifecycle, task_event_from_raw_response_item, task_event_record,
};
use crate::{
    codex_app_server::{
        CodexNotification, CodexRuntimeEvent, CodexServerRequest, CodexThreadClient,
        CodexThreadError, RENAME_CURRENT_THREAD_TOOL_NAME, ThreadStatus, TurnStatus,
    },
    codex_thread_sessions::{CodexThreadSessions, ThreadSessionSnapshot},
    thread_store::ThreadStore,
};

#[derive(Clone)]
pub(in crate::app) struct CodexRuntime {
    process: Arc<CodexProcess>,
    sessions: CodexThreadSessions,
    events: TaskEvents,
    thread_store: ThreadStore,
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
        thread_store: ThreadStore,
        shutdown: broadcast::Sender<()>,
    ) -> Self {
        let (signals, _) = broadcast::channel(64);
        Self {
            process: Arc::new(CodexProcess::default()),
            sessions,
            events,
            thread_store,
            approvals: Arc::new(Mutex::new(HashMap::new())),
            signals,
            shutdown,
        }
    }

    pub(in crate::app) fn subscribe(&self) -> broadcast::Receiver<CodexRuntimeSignal> {
        self.signals.subscribe()
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

        self.restore_leased_sessions(connection.clone());
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
                                runtime.handle_server_request(&client, request).await;
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

    fn restore_leased_sessions(&self, connection: CodexConnection) {
        let sessions = self.sessions.clone();
        tokio::spawn(async move {
            for (thread_id, error) in sessions
                .resubscribe_leased(&connection.client, connection.generation)
                .await
            {
                eprintln!("failed to restore Codex thread subscription {thread_id}: {error}");
            }
        });
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
            CodexNotification::ThreadNameUpdated { .. } => {}
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

    async fn handle_server_request(&self, client: &CodexThreadClient, request: CodexServerRequest) {
        let (request_id, thread_id, params, kind) = match request {
            CodexServerRequest::DynamicToolCall {
                id,
                thread_id,
                tool,
                namespace,
                arguments,
                ..
            } => {
                self.handle_dynamic_tool_call(client, id, thread_id, tool, namespace, arguments)
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
        request_id: JsonValue,
        thread_id: String,
        tool: String,
        namespace: Option<String>,
        arguments: JsonValue,
    ) {
        let result = self
            .execute_dynamic_tool(client, &thread_id, &tool, namespace.as_deref(), arguments)
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
        thread_id: &str,
        tool: &str,
        namespace: Option<&str>,
        arguments: JsonValue,
    ) -> Result<String, String> {
        if namespace.is_some() || tool != RENAME_CURRENT_THREAD_TOOL_NAME {
            let qualified_tool = namespace
                .map(|namespace| format!("{namespace}.{tool}"))
                .unwrap_or_else(|| tool.to_string());
            return Err(format!(
                "Caffold does not support the dynamic tool `{qualified_tool}`."
            ));
        }
        let RenameCurrentThreadArguments { name } = serde_json::from_value(arguments)
            .map_err(|_| "The new task name must be a non-empty string.".to_string())?;
        let name = name.trim();
        if name.is_empty() {
            return Err("The new task name must be a non-empty string.".to_string());
        }
        if !self.manages_thread(thread_id).await? {
            return Err("Caffold can only rename tasks that it manages.".to_string());
        }
        client
            .set_thread_name(thread_id, name)
            .await
            .map_err(|error| format!("Caffold could not rename the current task: {error}"))?;
        Ok(format!("Renamed the current Caffold task to `{name}`."))
    }

    async fn manages_thread(&self, thread_id: &str) -> Result<bool, String> {
        let store = self.thread_store.clone();
        let thread_id = thread_id.to_string();
        tokio::task::spawn_blocking(move || store.get(&thread_id))
            .await
            .map_err(|error| format!("Caffold could not verify the current task: {error}"))?
            .map(|thread| thread.is_some())
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
        self.restore_leased_sessions(connection);
    }

    #[cfg(test)]
    pub(in crate::app) fn handle_test_notification(&self, notification: CodexNotification) {
        self.handle_notification(notification);
    }

    #[cfg(test)]
    pub(in crate::app) async fn handle_test_server_request(
        &self,
        client: &CodexThreadClient,
        request: CodexServerRequest,
    ) {
        self.handle_server_request(client, request).await;
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
