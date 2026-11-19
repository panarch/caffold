//! GitHub Copilot CLI, reached through its installed runtime and official SDK.

mod adapter;
mod binding;
mod installation;
mod lifecycle;
mod permission;
mod protocol;
mod record;
mod runtime;
mod settings;
mod transport;
mod usage;

pub(crate) use adapter::run;
pub(crate) use installation::CopilotStatus;
pub(crate) use permission::ApprovalReply;

use super::{
    AgentError, ApprovalOutcome, ApprovalRequest, ConversationItem, Driver, OpenedConversation,
    PromptImage, SessionEvent, TurnOptions, TurnOrigin, TurnState, TurnStatus,
    driver::{
        CancelledPrompt, ModelOption, StartedConversation, StartedTurn, submitted_user_message,
    },
    http_mcp::{TaskMcpBindings, new_binding_value},
    runner::RunnerClient,
};
use binding::{Binding, Bindings, validate_session};
use copilot_sdk::{
    CliProgram, Client, ClientMode, ClientOptions, RuntimeConnection, SpawnedProcessOptions,
};
use protocol::{OpenSession, Operation};
use record::Record;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Instant,
};
use tokio::sync::{Mutex, RwLock, broadcast};
use transport::{Connection, runner_error};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct CopilotClient {
    inner: Arc<Inner>,
}

#[derive(Debug, Clone)]
pub(crate) enum CopilotRuntimeEvent {
    Session(Box<SessionEvent>),
    Approval {
        conversation_id: String,
        request: Box<ApprovalRequest>,
    },
    PendingApprovals {
        conversation_id: String,
        requests: Vec<ApprovalRequest>,
    },
    ApprovalEnded {
        conversation_id: String,
        approval_id: String,
        outcome: ApprovalOutcome,
    },
    Closed {
        conversation_id: String,
    },
    Unreachable {
        conversation_id: String,
        message: String,
    },
}

type TaskSlot = Arc<Mutex<Option<Arc<Connection>>>>;

struct Inner {
    bindings: Bindings,
    runner: RunnerClient,
    mcp: OnceLock<(TaskMcpBindings, String)>,
    slots: Mutex<HashMap<String, TaskSlot>>,
    runtime_gate: RwLock<()>,
    events: broadcast::Sender<CopilotRuntimeEvent>,
    catalog: Mutex<Option<(Instant, Vec<ModelOption>)>>,
    enabled: bool,
}

impl CopilotClient {
    pub(crate) fn in_data_dir(data: &Path) -> Self {
        Self::new(&data.join("copilot"), true)
    }

    #[cfg(test)]
    pub(crate) fn uninstalled() -> Self {
        Self::new(
            &std::env::temp_dir().join(Uuid::new_v4().to_string()),
            false,
        )
    }

    fn new(data: &Path, enabled: bool) -> Self {
        let (events, _) = broadcast::channel(1024);
        Self {
            inner: Arc::new(Inner {
                bindings: Bindings::new(data.join("bindings")),
                runner: RunnerClient::at_socket(data.join("runner.sock")),
                mcp: OnceLock::new(),
                slots: Default::default(),
                runtime_gate: RwLock::new(()),
                events,
                catalog: Default::default(),
                enabled,
            }),
        }
    }

    pub(crate) fn attach_mcp(&self, bindings: TaskMcpBindings, endpoint: String) {
        let _ = self.inner.mcp.set((bindings, endpoint));
    }

    pub(crate) fn driver(&self) -> Driver {
        Driver::Copilot(self.clone())
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<CopilotRuntimeEvent> {
        self.inner.events.subscribe()
    }

    pub(crate) async fn live_conversations(&self) -> Vec<String> {
        self.inner.runner.live_sessions().await
    }

    pub(crate) async fn has_unobserved_writer(&self, task: &str) -> Result<bool, AgentError> {
        let live = self
            .inner
            .runner
            .checked_live_sessions()
            .await
            .map_err(runner_error)?;
        Ok(live.iter().any(|id| id == task))
    }

    pub(crate) async fn stop(&self) {
        self.inner.runner.disconnect().await;
        self.inner.slots.lock().await.clear();
    }

    fn program(&self) -> Result<PathBuf, AgentError> {
        self.inner
            .enabled
            .then(installation::executable)
            .flatten()
            .ok_or_else(|| AgentError::Held("GitHub Copilot CLI is not installed.".into()))
    }

    fn binding(&self, task: &str) -> Result<Binding, AgentError> {
        self.inner
            .bindings
            .read(task)?
            .ok_or_else(|| AgentError::ConversationGone("Copilot Task binding is missing.".into()))
    }

    async fn slot(&self, task: &str) -> Result<TaskSlot, AgentError> {
        validate_session(task)?;
        Ok(self
            .inner
            .slots
            .lock()
            .await
            .entry(task.into())
            .or_default()
            .clone())
    }

    async fn reader(&self) -> Result<Client, AgentError> {
        connect(&self.program()?).await
    }

    async fn current(&self, task: &str) -> Result<Arc<Connection>, AgentError> {
        let _runtime = self.runtime_access()?;
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;
        self.open_locked(&mut slot, &mut self.binding(task)?).await
    }

    async fn open_locked(
        &self,
        slot: &mut Option<Arc<Connection>>,
        binding: &mut Binding,
    ) -> Result<Arc<Connection>, AgentError> {
        if let Some(connection) = slot.as_ref()
            && !connection.lost()
        {
            return Ok(connection.clone());
        }

        let task_id = binding.task_id.clone();
        let task = task_id.as_str();
        let (mcp, endpoint) = self
            .inner
            .mcp
            .get()
            .ok_or_else(|| AgentError::Held("Copilot Task tools are not configured.".into()))?;
        mcp.restore(&binding.mcp_binding, task)
            .map_err(AgentError::Failed)?;

        if let Some(connection) = slot.take() {
            connection.retire();
            self.inner.runner.release_observer(task).await;
        }

        let spawn = caffold_runner::protocol::SpawnRequest {
            argv: vec![
                std::env::current_exe()
                    .map_err(|error| AgentError::Failed(error.to_string()))?
                    .display()
                    .to_string(),
                "copilot-adapter".into(),
                "--program".into(),
                self.program()?.display().to_string(),
            ],
            cwd: binding.destination.as_ref().unwrap_or(&binding.cwd).clone(),
            env: Default::default(),
        };

        let reader = self.reader().await?;
        let native_exists = reader
            .rpc()
            .sessions()
            .has_events(copilot_sdk::rpc::SessionsHasEventsRequest {
                session_id: binding.native_id.clone().into(),
            })
            .await
            .map_err(sdk_error)?
            .exists;
        let record = if native_exists {
            Record::read(&reader, task, &binding.native_id, &binding.cwd).await?
        } else {
            Record::new(task, &binding.cwd)
        };

        let mut attached = self
            .inner
            .runner
            .open_recoverable(task, spawn.clone())
            .await
            .map_err(runner_error)?;
        if matches!(
            attached.snapshot.session.state,
            caffold_runner::protocol::SessionState::Exited
        ) {
            self.inner.runner.release_observer(task).await;
            self.inner
                .runner
                .close_recoverable(task)
                .await
                .map_err(runner_error)?;
            attached = self
                .inner
                .runner
                .open_recoverable(task, spawn)
                .await
                .map_err(runner_error)?;
        }

        if !attached.snapshot.checkpoint.is_empty()
            && attached.snapshot.checkpoint != protocol::VERSION.to_string()
        {
            self.inner.runner.release_observer(task).await;
            return Err(AgentError::Held(
                "The running Copilot adapter uses another protocol version.".into(),
            ));
        }

        let fresh_writer = attached.snapshot.session.spawned;
        let connection = Connection::attach(attached, binding, record, self.inner.events.clone());
        if let Err(error) = self
            .restore_native_session(&connection, binding, endpoint, native_exists, fresh_writer)
            .await
        {
            connection.retire();
            self.inner.runner.release_observer(task).await;
            return Err(error);
        }

        *slot = Some(connection.clone());
        Ok(connection)
    }

    async fn restore_native_session(
        &self,
        connection: &Connection,
        binding: &mut Binding,
        endpoint: &str,
        native_exists: bool,
        fresh_writer: bool,
    ) -> Result<(), AgentError> {
        let create = !native_exists && !binding.creation_attempted && !binding.first_attempted;
        if create {
            binding.creation_attempted = true;
            self.inner.bindings.write(binding)?;
        }

        let open = |binding: &Binding, create| {
            Operation::Open(OpenSession {
                session: binding.native_id.clone(),
                cwd: binding.destination.as_ref().unwrap_or(&binding.cwd).clone(),
                create,
                persist: !binding.saved,
                first: !binding.first_attempted,
                binding: binding.mcp_binding.clone(),
                endpoint: endpoint.to_owned(),
                settings: binding.settings.clone(),
            })
        };

        match connection.restore(open(binding, create)).await {
            Err(AgentError::ConversationGone(_))
                if !create
                    && fresh_writer
                    && !native_exists
                    && !binding.first_attempted
                    && !binding.replaced_empty =>
            {
                binding.native_id = Uuid::new_v4().to_string();
                binding.replaced_empty = true;
                binding.saved = false;
                self.inner.bindings.write(binding)?;
                connection.restore(open(binding, true)).await?
            }
            // The same live adapter may never have received its first Open.
            // Reuse its reservation after a definite native miss.
            Err(AgentError::ConversationGone(_))
                if !create && !native_exists && !binding.saved && !binding.first_attempted =>
            {
                connection.restore(open(binding, true)).await?
            }
            result => result?,
        };

        if let Some(destination) = binding.destination.clone() {
            connection
                .request(Operation::FinishIsolation {
                    destination: Some(destination),
                })
                .await?;
        }
        binding.saved = true;
        self.inner.bindings.write(binding)
    }

    fn reserve(
        &self,
        cwd: &str,
        settings: &TurnOptions,
        native_id: Option<String>,
    ) -> Result<Binding, AgentError> {
        let task = Uuid::new_v4().to_string();
        let fork = native_id.is_some();
        let binding = Binding {
            version: 1,
            task_id: task,
            native_id: native_id.unwrap_or_else(|| Uuid::new_v4().to_string()),
            cwd: cwd.into(),
            mcp_binding: new_binding_value(),
            settings: settings.clone(),
            first_attempted: fork,
            creation_attempted: fork,
            replaced_empty: false,
            saved: fork,
            destination: None,
        };
        self.inner.bindings.write(&binding)?;
        Ok(binding)
    }

    pub(crate) async fn start_conversation(
        &self,
        cwd: &str,
        settings: &TurnOptions,
    ) -> Result<StartedConversation, AgentError> {
        let _runtime = self.runtime_access()?;
        self.program()?;
        let binding = self.reserve(cwd, settings, None)?;
        let opened = match self.open_conversation(&binding.task_id, false).await {
            Ok(opened) => opened,
            Err(error) => {
                if let Err(cleanup) = self.erase(&binding.task_id).await {
                    tracing::warn!(%cleanup, "Copilot could not clean up the unclaimed Task");
                }
                return Err(error);
            }
        };

        Ok(StartedConversation {
            conversation: opened.conversation,
            settings: settings.clone(),
        })
    }

    pub(crate) async fn open_conversation(
        &self,
        task: &str,
        with_turns: bool,
    ) -> Result<OpenedConversation, AgentError> {
        let connection = self.current(task).await?;
        connection.restore(Operation::Inspect).await?;

        let record = connection.record.lock().await;
        let mut conversation = record.conversation.clone();
        conversation.turns.clear();
        let turns_page = with_turns.then(|| record.page(None, 8)).transpose()?;

        let settings = self.binding(task)?.settings;
        let settings = [
            ("model".into(), serde_json::json!(settings.model)),
            ("reasoningEffort".into(), serde_json::json!(settings.effort)),
            (
                "permissionMode".into(),
                serde_json::json!(settings.permission_mode),
            ),
            ("speed".into(), serde_json::json!(settings.speed)),
        ]
        .into();

        Ok(OpenedConversation {
            cwd: conversation.cwd.clone(),
            conversation,
            turns_page,
            settings,
        })
    }

    pub(crate) async fn start_turn(
        &self,
        task: &str,
        cwd: &str,
        prompt: &str,
        images: &[PromptImage],
        settings: &TurnOptions,
    ) -> Result<StartedTurn, AgentError> {
        let _runtime = self.runtime_access()?;
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;
        let mut binding = self.binding(task)?;
        let connection = self.open_locked(&mut slot, &mut binding).await?;

        if binding.cwd != cwd || binding.destination.is_some() {
            connection
                .request(Operation::Move { cwd: cwd.into() })
                .await?;
            binding.cwd = cwd.into();
            binding.destination = None;
        }

        binding.first_attempted = true;
        self.inner.bindings.write(&binding)?;
        let item = Self::submit(&connection, None, prompt, images, Some(settings.clone())).await?;

        binding.settings = settings.clone();
        self.inner.bindings.write(&binding)?;

        Ok(StartedTurn {
            turn: TurnState {
                id: item.id.clone(),
                origin: TurnOrigin::User,
                status: TurnStatus::InProgress,
                started_at_ms: None,
                completed_at_ms: None,
            },
            user_message: item,
            applied: settings.clone(),
        })
    }

    pub(crate) async fn steer_turn(
        &self,
        task: &str,
        target: &str,
        prompt: &str,
        images: &[PromptImage],
    ) -> Result<ConversationItem, AgentError> {
        Self::submit(
            &self.current(task).await?,
            Some(target.into()),
            prompt,
            images,
            None,
        )
        .await
    }

    async fn submit(
        connection: &Arc<Connection>,
        target: Option<String>,
        prompt: &str,
        images: &[PromptImage],
        settings: Option<TurnOptions>,
    ) -> Result<ConversationItem, AgentError> {
        let paths: Vec<_> = images.iter().map(|image| image.path.clone()).collect();
        let answer = connection
            .request(Operation::Send {
                prompt: prompt.into(),
                images: paths.clone(),
                target,
                settings,
            })
            .await?;

        let id = answer["messageId"].as_str().ok_or_else(|| {
            AgentError::Failed("Copilot did not report the submitted message ID.".into())
        })?;
        Ok(submitted_user_message(id, prompt, &paths))
    }

    pub(crate) async fn interrupt(&self, task: &str) -> Result<Vec<CancelledPrompt>, AgentError> {
        let connection = self.current(task).await?;
        let result = connection.request(Operation::Stop).await?;
        let cancelled: Vec<String> = serde_json::from_value(result)
            .map_err(|error| AgentError::Failed(error.to_string()))?;
        if !cancelled.is_empty() {
            connection.publish_history().await?;
        }

        Ok(cancelled
            .into_iter()
            .map(|prompt| CancelledPrompt { prompt })
            .collect())
    }

    pub(crate) async fn working_directory(&self, task: &str) -> Result<String, AgentError> {
        Ok(self.binding(task)?.cwd)
    }

    pub(crate) async fn rename(&self, task: &str, name: &str) -> Result<(), AgentError> {
        self.current(task)
            .await?
            .request(Operation::Rename { name: name.into() })
            .await?;
        Ok(())
    }
}

async fn connect(program: &Path) -> Result<Client, AgentError> {
    let process = SpawnedProcessOptions::new().with_program(CliProgram::Path(program.to_owned()));
    let options = ClientOptions::new(ClientMode::CodingAgent)
        .with_runtime(RuntimeConnection::for_spawned_stdio(process));

    Client::start(options).await.map_err(|error| {
        AgentError::Unreachable(format!(
            "Copilot CLI could not start its SDK runtime: {error}"
        ))
    })
}

fn sdk_error(error: copilot_sdk::Error) -> AgentError {
    AgentError::Failed(format!("Copilot SDK: {error}"))
}
