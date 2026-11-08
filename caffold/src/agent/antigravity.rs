//! Antigravity CLI's ACP connection and its native conversation record.
//!
//! ACP owns requests, permissions and settings; the native SQLite trajectory
//! owns persisted history. Fresh prompts use disposable driver-owned display
//! identities; reconstruction discards them instead of matching unlike IDs.

mod authentication;
mod binding;
mod installation;
mod protocol;
mod record;
mod runtime;
mod session;
mod settings;
mod usage;

use super::driver::{
    AgentError, AgentInstallation, Driver, ModelOption, OpenedConversation, PermissionModes,
    PromptImage, StartedConversation, StartedTurn, TurnOptions,
};
use super::history::RecordedPage;
use super::http_mcp::{TaskMcpBindings, new_binding_value};
use super::runner::RunnerClient;
use super::{
    ApprovalDecision, ApprovalOutcome, ApprovalRequest, Conversation, ConversationItem, ItemKind,
    MessageContent, SessionEvent, ThreadStatus, TokenCount, Turn, TurnPage, TurnState, TurnStatus,
};
use authentication::{AuthStatus, Authentication};
use binding::{Binding, Bindings};
use installation::{Cli, InstallationStatus};
use notify::RecommendedWatcher;
use record::Records;
use runtime::RuntimeStatus;
use serde::Serialize;
use serde_json::json;
use session::{Environment, InputOperation, Session};
use settings::Catalog;
use std::{
    collections::{BTreeMap, HashMap},
    env,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock, Weak},
};
use tokio::sync::{Mutex, RwLock, broadcast};
use tokio::task::JoinHandle;
use usage::UsageStatus;
use uuid::Uuid;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AntigravityStatus {
    installation: InstallationStatus,
    auth: AuthStatus,
    usage: UsageStatus,
    refreshing: bool,
    runtime: RuntimeStatus,
    models_available: bool,
    models_error: Option<String>,
}

#[derive(Clone)]
pub(crate) struct AntigravityClient {
    inner: Arc<Inner>,
}

struct Inner {
    data: PathBuf,
    runner: RunnerClient,
    bindings: Bindings,
    records: Records,
    events: broadcast::Sender<AntigravityRuntimeEvent>,
    sessions: Mutex<HashMap<String, Arc<Mutex<Slot>>>>,
    environment: OnceLock<Arc<Environment>>,
    mcp: OnceLock<TaskMcpBindings>,
    catalog: Mutex<Option<Catalog>>,
    refresh_job: Mutex<()>,
    runtime_gate: RwLock<()>,
    usage: Mutex<UsageStatus>,
    catalog_error: Mutex<Option<String>>,
    cli: Cli,
    authentication: Authentication,
}
#[derive(Default)]
struct Slot {
    session: Option<Arc<Session>>,
    watcher: Option<RecordWatcher>,
    native_turns: BTreeMap<String, Turn>,
    native_usage: BTreeMap<String, TokenCount>,
}
struct RecordWatcher {
    _watcher: RecommendedWatcher,
    task: JoinHandle<()>,
}
impl Drop for RecordWatcher {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl AntigravityClient {
    pub(crate) async fn introspect(&self) -> AntigravityStatus {
        AntigravityStatus {
            installation: self.inner.cli.status().await,
            auth: self.inner.authentication.status().await,
            usage: self.inner.usage.lock().await.clone(),
            refreshing: self.inner.refresh_job.try_lock().is_err(),
            runtime: self.runtime_status().await,
            models_available: self.inner.catalog.lock().await.is_some(),
            models_error: self.inner.catalog_error.lock().await.clone(),
        }
    }
    /// Whether `agy` is installed and fit to run, without starting an ACP
    /// process or asking about the account.
    pub(crate) async fn installation(&self) -> AgentInstallation {
        self.inner.cli.installation().await
    }
    #[cfg(test)]
    pub(crate) fn uninstalled() -> Self {
        let root = env::temp_dir().join(format!("caffold-agy-test-{}", Uuid::new_v4()));
        Self::at_paths(&root, root.join("native-home"))
    }
    pub(crate) fn in_data_dir(data: &Path) -> Self {
        let native_home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| data.into())
            .join(".gemini");
        Self::at_paths(data, native_home)
    }
    fn at_paths(data: &Path, native_home: PathBuf) -> Self {
        let data = data.join("antigravity");
        let (events, _) = broadcast::channel(1024);
        let bindings = Bindings::new(data.join("bindings"));
        let (catalog, catalog_error) = match Catalog::read(&data) {
            Ok(catalog) => (catalog, None),
            Err(error) => (None, Some(error.to_string())),
        };
        let runner = RunnerClient::at_socket(data.join("runner.sock"));
        #[cfg(not(test))]
        let cli = Cli::default();
        #[cfg(test)]
        let cli = Cli {
            executable: Some(native_home.join("bin/agy")),
        };
        let authentication = Authentication::default();
        Self {
            inner: Arc::new(Inner {
                runner,
                records: Records::new(native_home.join("antigravity-cli/conversations")),
                data,
                bindings,
                events,
                sessions: Mutex::new(HashMap::new()),
                environment: OnceLock::new(),
                mcp: OnceLock::new(),
                catalog: Mutex::new(catalog),
                refresh_job: Mutex::new(()),
                runtime_gate: RwLock::new(()),
                usage: Mutex::new(UsageStatus::default()),
                catalog_error: Mutex::new(catalog_error),
                cli,
                authentication,
            }),
        }
    }
    pub(crate) fn attach_mcp(&self, bindings: TaskMcpBindings, endpoint: String) {
        let _ = self.inner.mcp.set(bindings);
        let _ = self.inner.environment.set(Arc::new(Environment {
            runner: self.inner.runner.clone(),
            authentication: self.inner.authentication.clone(),
            bindings: self.inner.bindings.clone(),
            records: self.inner.records.clone(),
            events: self.inner.events.clone(),
            mcp_endpoint: endpoint,
        }));
    }
    pub(crate) fn subscribe(&self) -> broadcast::Receiver<AntigravityRuntimeEvent> {
        self.inner.events.subscribe()
    }
    pub(crate) fn driver(&self) -> Driver {
        Driver::Antigravity(self.clone())
    }
    pub(crate) async fn live_conversations(&self) -> Vec<String> {
        self.inner.runner.live_sessions().await
    }

    pub(crate) async fn has_unobserved_writer(&self, task: &str) -> Result<bool, AntigravityError> {
        Ok(self
            .inner
            .runner
            .checked_live_sessions()
            .await
            .map_err(|error| AntigravityError::Unreachable(error.to_string()))?
            .iter()
            .any(|id| id == task))
    }

    /// A closed Task retains its effective workspace independently of the
    /// native trajectory's recorded cwd. No ACP child is loaded to record it.
    pub(crate) async fn retain_closed_directory(
        &self,
        task: &str,
        cwd: &str,
    ) -> Result<(), AntigravityError> {
        let slot = self.slot(task).await?;
        let slot = slot.lock().await;
        if slot.session.is_some() || self.has_unobserved_writer(task).await? {
            return Err(AntigravityError::InputBusy);
        }
        let mut binding = self.binding(task).await?;
        binding.cwd = cwd.to_string();
        self.inner.bindings.write(&binding)
    }
    /// Backend shutdown releases observation only. The runner owns its children.
    pub(crate) async fn stop(&self) {
        for slot in self.inner.sessions.lock().await.values() {
            let mut slot = slot.lock().await;
            slot.watcher.take();
            if let Some(session) = slot.session.take() {
                session.retire().await;
            }
        }
        self.inner.runner.disconnect().await;
    }

    async fn slot(&self, task: &str) -> Result<Arc<Mutex<Slot>>, AntigravityError> {
        record::validate_session(task)?;
        Ok(self
            .inner
            .sessions
            .lock()
            .await
            .entry(task.into())
            .or_default()
            .clone())
    }
    async fn binding(&self, task: &str) -> Result<Binding, AntigravityError> {
        let bindings = self.inner.bindings.clone();
        let task = task.to_string();
        tokio::task::spawn_blocking(move || bindings.read(&task))
            .await
            .map_err(|e| AntigravityError::Binding(e.to_string()))??
            .ok_or_else(|| {
                AntigravityError::ConversationGone("Task has no Antigravity binding".into())
            })
    }

    async fn open(
        &self,
        task: &str,
        cwd: Option<&str>,
        first: bool,
    ) -> Result<Arc<Session>, AntigravityError> {
        self.open_for(task, cwd, first, true, false).await
    }

    async fn open_for(
        &self,
        task: &str,
        cwd: Option<&str>,
        first: bool,
        observe: bool,
        bypass: bool,
    ) -> Result<Arc<Session>, AntigravityError> {
        let _runtime = self.runtime_access()?;
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;
        if let Some(session) = &slot.session {
            if session.ready().await {
                if observe {
                    session.publish_opened(None).await;
                }
                return Ok(session.clone());
            }
            if session.requires_new_child().await {
                session.close().await?;
            }
            session.retire().await;
        }
        slot.watcher.take();
        slot.session.take();
        let binding = match self.binding(task).await {
            Ok(binding) => Some(binding),
            Err(AntigravityError::ConversationGone(_)) if cwd.is_some() => None,
            Err(error) => return Err(error),
        };
        let reconstructed = binding.is_some();
        if reconstructed {
            // Never ask the CLI to recreate a missing legacy conversation.
            self.read_snapshot(task, None, 1).await?;
        }
        let cwd = cwd
            .map(str::to_string)
            .or_else(|| binding.as_ref().map(|binding| binding.cwd.clone()))
            .ok_or_else(|| AntigravityError::Binding("Task has no working directory".into()))?;
        if !Path::new(&cwd).is_absolute() {
            return Err(AntigravityError::Binding(
                "Task directory must be absolute".into(),
            ));
        }
        let mcp =
            self.inner.mcp.get().ok_or_else(|| {
                AntigravityError::Unreachable("Caffold MCP is not attached".into())
            })?;
        let token = if !observe {
            binding
                .as_ref()
                .map(|binding| binding.mcp_binding.clone())
                .unwrap_or_else(new_binding_value)
        } else if let Some(binding) = &binding {
            mcp.restore(&binding.mcp_binding, task)
                .map_err(AntigravityError::Binding)?;
            binding.mcp_binding.clone()
        } else {
            mcp.bind(task)
        };
        let environment = self
            .inner
            .environment
            .get()
            .ok_or_else(|| AntigravityError::Unreachable("Caffold MCP is not attached".into()))?
            .clone();
        // The explicit catalog probe owns a short-lived native session, not
        // an application Task, MCP binding or runtime publication stream.
        let environment = if observe {
            environment
        } else {
            Arc::new(Environment {
                runner: self.inner.runner.clone(),
                authentication: self.inner.authentication.clone(),
                bindings: self.inner.bindings.clone(),
                records: self.inner.records.clone(),
                events: broadcast::channel(16).0,
                mcp_endpoint: String::new(),
            })
        };
        let executable = self.inner.cli.executable().await?;
        let mut argv = vec![
            executable.display().to_string(),
            "acp".into(),
            "--process-per-session".into(),
        ];
        if bypass {
            argv.push("--dangerously-skip-permissions".into());
        }
        let spawn = caffold_runner::protocol::SpawnRequest {
            argv,
            cwd: cwd.clone(),
            env: BTreeMap::new(),
        };
        let session = match Session::attach(
            task.into(),
            binding,
            token.clone(),
            spawn.clone(),
            environment.clone(),
            bypass,
        )
        .await
        {
            Ok(session) => session,
            Err(AntigravityError::NativeEnded(_)) => {
                self.inner
                    .runner
                    .close_recoverable(task)
                    .await
                    .map_err(|error| AntigravityError::Unreachable(error.to_string()))?;
                let binding = match self.binding(task).await {
                    Ok(binding) => Some(binding),
                    Err(AntigravityError::ConversationGone(_)) if first => None,
                    Err(error) => return Err(error),
                };
                Session::attach(task.into(), binding, token, spawn, environment, bypass).await?
            }
            Err(error) => return Err(error),
        };
        if observe {
            mcp.restore(&session.mcp_binding().await, task)
                .map_err(AntigravityError::Binding)?;
        }
        slot.session = Some(session.clone());
        session.prepare(&cwd, first).await?;
        session.continue_prompt().await?;
        if !observe {
            return Ok(session);
        }
        let native = session.binding().await?.native_id;
        let baseline = self.read_snapshot(task, None, 100).await?;
        session
            .publish_opened(reconstructed.then(|| baseline.page.clone()))
            .await;
        slot.native_turns = baseline
            .page
            .turns
            .iter()
            .map(|turn| (turn.id.clone(), turn.clone()))
            .collect();
        slot.native_usage = baseline.usage;
        slot.watcher = Some(self.watch_record(task, &native)?);
        Ok(session)
    }

    async fn current(&self, task: &str) -> Result<Arc<Session>, AntigravityError> {
        self.slot(task)
            .await?
            .lock()
            .await
            .session
            .clone()
            .ok_or_else(|| {
                AntigravityError::Unreachable("open this Task before controlling it".into())
            })
    }

    pub(crate) async fn start_conversation(
        &self,
        cwd: &str,
        options: &TurnOptions,
    ) -> Result<StartedConversation, AntigravityError> {
        let task = Uuid::new_v4().to_string();
        let result = async {
            let session = self
                .open_for(
                    &task,
                    Some(cwd),
                    true,
                    true,
                    options.permission_mode.as_deref() == Some(settings::BYPASS),
                )
                .await?;
            let applied = self.apply_options(&session, options).await?;
            let conversation = self.read_conversation(&task, ThreadStatus::Idle).await?;
            Ok(StartedConversation {
                conversation,
                settings: applied,
            })
        }
        .await;
        if result.is_err() {
            self.erase(&task).await?;
        }
        result
    }

    pub(crate) async fn open_conversation(
        &self,
        task: &str,
        with_turns: bool,
    ) -> Result<OpenedConversation, AntigravityError> {
        let session = self.open(task, None, false).await?;
        let observation = session.observation().await;
        let conversation = self
            .read_conversation(
                task,
                observation.activity.unwrap_or(ThreadStatus::NotLoaded),
            )
            .await?;
        let turns_page = if with_turns {
            Some(self.read_turns(task, None, 8).await?)
        } else {
            None
        };
        Ok(OpenedConversation {
            cwd: conversation.cwd.clone(),
            conversation,
            turns_page,
            settings: self.settings_of(task).await?,
        })
    }

    pub(crate) async fn start_turn(
        &self,
        task: &str,
        cwd: &str,
        text: &str,
        images: &[PromptImage],
        options: &TurnOptions,
    ) -> Result<StartedTurn, AntigravityError> {
        let (session, baseline) = async {
            let mut session = self.open(task, None, false).await?;
            if session.binding().await?.cwd != cwd {
                self.move_directory(task, cwd).await?;
                session = self.open(task, None, false).await?;
            }
            if let Some(mode) = &options.permission_mode {
                let bypass = mode == settings::BYPASS;
                if session.bypass().await != bypass {
                    self.close_session(task, true).await?;
                    session = self.open_for(task, None, false, true, bypass).await?;
                    if session.bypass().await != bypass {
                        return Err(AntigravityError::Protocol(
                            "native permission launch did not change".into(),
                        ));
                    }
                }
            }
            let baseline = self.read_snapshot(task, None, 8).await?;
            Ok::<_, AntigravityError>((session, baseline))
        }
        .await
        .map_err(input_rejected)?;
        let reservation = session.reserve().await.map_err(input_rejected)?;
        let prepared=async{
            let applied=self.apply_options(&session,options).await?;
            let mut content=Vec::new();if !text.is_empty(){content.push(json!({"type":"text","text":text}));}
            use base64::Engine as _;
            for image in images{
                let bytes=tokio::fs::read(&image.path).await.map_err(|error|AntigravityError::Protocol(format!("could not read prompt image: {error}")))?;
                content.push(json!({"type":"image","mimeType":image.media_type,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}));
            }
            Ok::<_,AntigravityError>((applied,json!(content)))
        }.await;
        let (applied, content) = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                session.release_reservation(reservation).await;
                return Err(input_rejected(error));
            }
        };
        let mut display = vec![MessageContent::Text { text: text.into() }];
        display.extend(images.iter().map(|image| MessageContent::LocalImage {
            path: image.path.clone(),
        }));
        match session
            .prompt(reservation, content, text, display, baseline)
            .await
        {
            Ok(turn) => Ok(StartedTurn {
                user_message: turn.items[0].clone(),
                turn: TurnState::from(&turn),
                applied,
            }),
            Err(error @ AntigravityError::DispatchUnknown(_)) => Err(error),
            Err(error) => {
                session.release_reservation(reservation).await;
                Err(input_rejected(error))
            }
        }
    }

    pub(crate) async fn steer_turn(
        &self,
        task: &str,
        turn: &str,
        text: &str,
        images: &[PromptImage],
    ) -> Result<ConversationItem, AntigravityError> {
        let session = self.open(task, None, false).await?;
        let mut content = Vec::new();
        let mut display = Vec::new();
        if !text.is_empty() {
            content.push(json!({"type":"text","text":text}));
            display.push(MessageContent::Text { text: text.into() });
        }
        use base64::Engine as _;
        for image in images {
            let bytes = tokio::fs::read(&image.path).await.map_err(|error| {
                AntigravityError::InputRejected(format!("could not read prompt image: {error}"))
            })?;
            content.push(json!({"type":"image","mimeType":image.media_type,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}));
            display.push(MessageContent::LocalImage {
                path: image.path.clone(),
            });
        }
        session.steer(turn, json!(content), text, display).await
    }

    pub(crate) async fn interrupt(&self, task: &str) -> Result<(), AntigravityError> {
        self.current(task).await?.interrupt().await
    }
    pub(crate) async fn working_directory(&self, task: &str) -> Result<String, AntigravityError> {
        Ok(self.binding(task).await?.cwd)
    }
    pub(crate) async fn reviewed_permissions(&self, task: &str) -> Result<bool, AntigravityError> {
        Ok(self.current(task).await?.reviewed().await)
    }
    pub(crate) async fn resolve_approval(
        &self,
        task: &str,
        approval: &str,
        decision: ApprovalDecision,
    ) -> Result<(), AntigravityError> {
        self.current(task).await?.resolve(approval, decision).await
    }

    pub(crate) async fn read_turns(
        &self,
        task: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<TurnPage, AntigravityError> {
        if let Ok(session) = self.current(task).await
            && let Some(page) = session.live_page(before, limit).await?
        {
            return Ok(page);
        }
        Ok(self.read_snapshot(task, before, limit).await?.page)
    }
    pub(crate) async fn read_recorded_history(
        &self,
        task: &str,
        before: Option<&str>,
    ) -> Result<RecordedPage, AntigravityError> {
        let binding = self.binding(task).await?;
        let page = self.read_snapshot(task, before, 1).await?.page;
        let after = self.binding(task).await?;
        if binding.native_id != after.native_id || binding.cwd != after.cwd {
            return Err(AntigravityError::Binding(
                "The history source changed while it was read.".into(),
            ));
        }
        Ok(RecordedPage {
            identity: format!("antigravity:{}:{}", binding.native_id, binding.cwd),
            page,
            warnings: Vec::new(),
        })
    }

    async fn read_snapshot(
        &self,
        task: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<record::Snapshot, AntigravityError> {
        let binding = self.binding(task).await?;
        let records = self.inner.records.clone();
        let before = before.map(str::to_string);
        tokio::task::spawn_blocking(move || {
            records.read(&binding.native_id, before.as_deref(), limit)
        })
        .await
        .map_err(|e| AntigravityError::Record(e.to_string()))?
    }
    async fn read_conversation(
        &self,
        task: &str,
        status: ThreadStatus,
    ) -> Result<Conversation, AntigravityError> {
        let binding = self.binding(task).await?;
        let snapshot = self.read_snapshot(task, None, 8).await?;
        let path = self.inner.records.path(&binding.native_id)?;
        let mut conversation = snapshot.conversation(task, &binding.cwd, status, &path);
        if let Ok(session) = self.current(task).await
            && let Some(page) = session.live_page(None, 8).await?
        {
            conversation.turns = page.turns;
            if let Some(turn) = conversation.turns.first() {
                conversation.updated_at_ms = turn
                    .completed_at_ms
                    .or(turn.started_at_ms)
                    .unwrap_or(conversation.updated_at_ms);
                if let Some(ItemKind::UserMessage { text, .. }) =
                    turn.items.first().map(|item| &item.kind)
                {
                    conversation.preview = text.clone();
                }
            }
        }
        Ok(conversation)
    }
    pub(crate) async fn describe(
        &self,
        task: &str,
    ) -> Result<Option<Conversation>, AntigravityError> {
        let status = match self.current(task).await {
            Ok(session) => session
                .observation()
                .await
                .activity
                .unwrap_or(ThreadStatus::NotLoaded),
            Err(_) => return Ok(None),
        };
        self.read_conversation(task, status).await.map(Some)
    }
    pub(crate) async fn conversation_exists(&self, task: &str) -> Result<bool, AntigravityError> {
        match self.binding(task).await {
            Ok(binding) => {
                match tokio::fs::symlink_metadata(
                    match self.inner.records.path(&binding.native_id) {
                        Ok(path) => path,
                        Err(AntigravityError::ConversationGone(_)) => return Ok(false),
                        Err(error) => return Err(error),
                    },
                )
                .await
                {
                    Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                        Ok(true)
                    }
                    Ok(_) => Err(AntigravityError::Record(
                        "native record is not a regular file".into(),
                    )),
                    Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
                    Err(error) => Err(AntigravityError::Record(error.to_string())),
                }
            }
            Err(AntigravityError::ConversationGone(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn close_conversation(&self, task: &str) -> Result<(), AntigravityError> {
        self.close_session(task, false).await
    }

    async fn close_session(&self, task: &str, idle: bool) -> Result<(), AntigravityError> {
        let _runtime = self.runtime_access()?;
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;
        if let Some(session) = &slot.session {
            if idle {
                session.close_idle().await?;
            } else {
                session.close().await?;
            }
            session.retire().await;
        } else {
            self.inner
                .runner
                .close_recoverable(task)
                .await
                .map_err(|e| AntigravityError::Unreachable(e.to_string()))?;
        }
        slot.watcher.take();
        slot.session.take();
        Ok(())
    }
    pub(crate) async fn move_directory(
        &self,
        task: &str,
        cwd: &str,
    ) -> Result<Conversation, AntigravityError> {
        let session = self.open(task, None, false).await?;
        if session.observation().await.operation != InputOperation::Idle {
            return Err(AntigravityError::InputBusy);
        }
        self.close_conversation(task).await?;
        let session = self.open(task, Some(cwd), false).await?;
        self.read_conversation(
            task,
            session
                .observation()
                .await
                .activity
                .unwrap_or(ThreadStatus::NotLoaded),
        )
        .await
    }

    fn watch_record(&self, task: &str, native: &str) -> Result<RecordWatcher, AntigravityError> {
        use notify::{EventKind, RecursiveMode, Watcher, event::ModifyKind};
        let path = self.inner.records.path(native)?;
        let directory = path
            .parent()
            .ok_or_else(|| AntigravityError::Record("native record has no directory".into()))?;
        let names = [format!("{native}.db"), format!("{native}.db-wal")];
        let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
        let initial = sender.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
                match event {
                    Ok(event)
                        if matches!(
                            event.kind,
                            EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_))
                        ) => {}
                    Ok(event)
                        if event.paths.iter().any(|path| {
                            path.file_name()
                                .and_then(|name| name.to_str())
                                .is_some_and(|name| names.iter().any(|candidate| candidate == name))
                        }) =>
                    {
                        let _ = sender.try_send(Ok(()));
                    }
                    Err(error) => {
                        let _ = sender.try_send(Err(error.to_string()));
                    }
                    _ => {}
                }
            })
            .map_err(|e| AntigravityError::Record(e.to_string()))?;
        watcher
            .watch(directory, RecursiveMode::NonRecursive)
            .map_err(|e| AntigravityError::Record(e.to_string()))?;
        let _ = initial.try_send(Ok(()));
        let weak: Weak<Inner> = Arc::downgrade(&self.inner);
        let task_id = task.to_string();
        let reader = tokio::spawn(async move {
            while let Some(change) = receiver.recv().await {
                let Some(inner) = weak.upgrade() else {
                    return;
                };
                let client = AntigravityClient { inner };
                let event = match change {
                    Ok(()) => match client.publish_native_changes(&task_id).await {
                        Ok(false) => continue,
                        Ok(true) => AntigravityRuntimeEvent::RecordChanged {
                            conversation_id: task_id.clone(),
                        },
                        Err(error) => AntigravityRuntimeEvent::Unreachable {
                            conversation_id: task_id.clone(),
                            message: error.to_string(),
                        },
                    },
                    Err(message) => AntigravityRuntimeEvent::Unreachable {
                        conversation_id: task_id.clone(),
                        message,
                    },
                };
                let _ = client.inner.events.send(event);
            }
        });
        Ok(RecordWatcher {
            _watcher: watcher,
            task: reader,
        })
    }

    async fn publish_native_changes(&self, task: &str) -> Result<bool, AntigravityError> {
        use super::SessionEventKind;
        let slot = self.slot(task).await?;
        let mut slot = slot.lock().await;
        if let Some(session) = &slot.session
            && session.has_live_view().await
        {
            return Ok(false);
        }
        let snapshot = self.read_snapshot(task, None, 100).await?;
        if let Some(session) = &slot.session
            && session.has_live_view().await
        {
            return Ok(false);
        }
        let mut changed = false;
        for turn in snapshot.page.turns.iter().rev() {
            let previous = slot.native_turns.get(&turn.id);
            if previous == Some(turn) {
                continue;
            }
            changed = true;
            let mut events = Vec::new();
            if previous.is_none() {
                events.push(SessionEventKind::TurnStarted {
                    turn: TurnState {
                        status: TurnStatus::InProgress,
                        completed_at_ms: None,
                        ..TurnState::from(turn)
                    },
                });
            }
            for item in &turn.items {
                if previous.is_none_or(|old| !old.items.contains(item)) {
                    events.push(SessionEventKind::ItemChanged {
                        turn_id: turn.id.clone(),
                        item: item.clone(),
                        at_ms: item.observed_at_ms.unwrap_or(0),
                    });
                }
            }
            if turn.status != TurnStatus::InProgress
                && previous.is_none_or(|old| old.status == TurnStatus::InProgress)
            {
                events.push(SessionEventKind::TurnEnded {
                    turn: TurnState::from(turn),
                });
            }
            if slot.native_usage.get(&turn.id) != snapshot.usage.get(&turn.id)
                && let Some(usage) = snapshot.turn_usage(&turn.id)
            {
                events.push(SessionEventKind::UsageReported {
                    turn_id: turn.id.clone(),
                    usage,
                });
            }
            for kind in events {
                let _ = self
                    .inner
                    .events
                    .send(AntigravityRuntimeEvent::Session(Box::new(SessionEvent {
                        thread_id: task.into(),
                        kind,
                    })));
            }
        }
        slot.native_turns = snapshot
            .page
            .turns
            .into_iter()
            .map(|turn| (turn.id.clone(), turn))
            .collect();
        slot.native_usage = snapshot.usage;
        Ok(changed)
    }

    pub(crate) async fn erase_contents(&self, task: &str) -> Result<(), AntigravityError> {
        self.close_conversation(task).await?;
        let binding = match self.binding(task).await {
            Ok(binding) => binding,
            Err(AntigravityError::ConversationGone(_)) => return Ok(()),
            Err(error) => return Err(error),
        };
        let records = self.inner.records.clone();
        let id = binding.native_id;
        tokio::task::spawn_blocking(move || records.erase(&id))
            .await
            .map_err(|e| AntigravityError::Record(e.to_string()))?
    }
    pub(crate) async fn forget_erased_binding(&self, task: &str) -> Result<(), AntigravityError> {
        let binding = match self.binding(task).await {
            Ok(binding) => binding,
            Err(AntigravityError::ConversationGone(_)) => {
                self.inner.sessions.lock().await.remove(task);
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let bindings = self.inner.bindings.clone();
        let task_id = task.to_string();
        tokio::task::spawn_blocking(move || bindings.remove(&task_id))
            .await
            .map_err(|e| AntigravityError::Binding(e.to_string()))??;
        self.inner.sessions.lock().await.remove(task);
        if let Some(mcp) = self.inner.mcp.get() {
            mcp.release(&binding.mcp_binding);
        }
        Ok(())
    }
    pub(crate) async fn erase(&self, task: &str) -> Result<(), AntigravityError> {
        self.erase_contents(task).await?;
        self.forget_erased_binding(task).await
    }
}

#[derive(Debug, Clone)]
pub(crate) enum AntigravityRuntimeEvent {
    Session(Box<SessionEvent>),
    Closed {
        conversation_id: String,
    },
    RecordChanged {
        conversation_id: String,
    },
    Approval {
        conversation_id: String,
        request: Box<ApprovalRequest>,
    },
    ApprovalEnded {
        conversation_id: String,
        approval_id: String,
        outcome: ApprovalOutcome,
    },
    Unreachable {
        conversation_id: String,
        message: String,
    },
}

#[derive(Debug, Clone, thiserror::Error)]
pub(crate) enum AntigravityError {
    #[error("Antigravity did not accept this input: {0}")]
    InputRejected(String),
    #[error("Install Antigravity CLI 1.5.1 or newer and make agy available on PATH")]
    NotInstalled,
    #[error("Antigravity installation error: {0}")]
    Installation(String),
    #[error("Run agy in a terminal and sign in, then refresh Antigravity Settings")]
    SignInRequired,
    #[error("Antigravity is unavailable: {0}")]
    Unreachable(String),
    #[error("Antigravity process ended: {0}")]
    NativeEnded(String),
    #[error("Antigravity protocol error: {0}")]
    Protocol(String),
    #[error("Antigravity record error: {0}")]
    Record(String),
    #[error("Antigravity conversation is unavailable: {0}")]
    ConversationGone(String),
    #[error("Antigravity RPC {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("Antigravity cannot accept this input while starting or stopping")]
    InputBusy,
    #[error("The Antigravity turn has ended")]
    InputGone,
    #[error("Antigravity input acceptance is unknown: {0}")]
    DispatchUnknown(String),
    #[error("Antigravity binding error: {0}")]
    Binding(String),
}

impl From<AntigravityError> for AgentError {
    fn from(error: AntigravityError) -> Self {
        match error {
            AntigravityError::InputRejected(message) => Self::Failed(message),
            AntigravityError::ConversationGone(message) => Self::ConversationGone(message),
            AntigravityError::InputGone => Self::TurnGone("The Antigravity turn has ended".into()),
            AntigravityError::InputBusy => {
                Self::TurnRunning("Antigravity already has an unresolved input request".into())
            }
            AntigravityError::Unreachable(message) | AntigravityError::NativeEnded(message) => {
                Self::Unreachable(message)
            }
            AntigravityError::DispatchUnknown(message) => Self::Unreachable(message),
            other => Self::Failed(other.to_string()),
        }
    }
}

fn input_rejected(error: AntigravityError) -> AntigravityError {
    match error {
        AntigravityError::InputBusy
        | AntigravityError::InputGone
        | AntigravityError::DispatchUnknown(_) => error,
        other => AntigravityError::InputRejected(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{SessionEventKind, http_mcp::new_binding_value};
    use std::fs;

    #[tokio::test]
    async fn recorded_history_reads_bundled_sqlite_without_a_runner_or_installed_harness() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let records = home.path().join("antigravity-cli/conversations");
        fs::create_dir_all(&records).unwrap();
        let fixture =
            record::fixture::parse(include_str!("antigravity/record/fixtures/single-turn.json"));
        let path = records.join(format!("{}.db", fixture.identity.cascade));
        drop(record::fixture::write(&path, &fixture));
        let before = fs::read(&path).unwrap();
        let client = AntigravityClient::at_paths(data.path(), home.path().to_path_buf());
        let task = Uuid::new_v4().to_string();
        client
            .inner
            .bindings
            .write(&Binding {
                version: 1,
                task_id: task.clone(),
                native_id: fixture.identity.cascade,
                cwd: data.path().display().to_string(),
                mcp_binding: new_binding_value(),
            })
            .unwrap();
        let page = client.read_recorded_history(&task, None).await.unwrap();
        assert_eq!(page.page.turns.len(), 1);
        assert_eq!(page.page.turns[0].items.len(), 2);
        assert!(client.inner.sessions.lock().await.is_empty());
        client
            .retain_closed_directory(&task, "/shared-worktree")
            .await
            .unwrap();
        assert_eq!(
            client.working_directory(&task).await.unwrap(),
            "/shared-worktree"
        );
        assert!(
            !client
                .read_recorded_history(&task, None)
                .await
                .unwrap()
                .page
                .turns
                .is_empty()
        );
        assert_eq!(before, fs::read(path).unwrap());
        assert!(client.read_recorded_history("missing", None).await.is_err());
    }

    #[tokio::test]
    async fn a_missing_cli_record_does_not_recreate_or_move_a_legacy_conversation() {
        let data = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let legacy = home.path().join("antigravity-acp/conversations");
        fs::create_dir_all(&legacy).unwrap();
        let native = Uuid::new_v4().to_string();
        let record = legacy.join(format!("{native}.db"));
        fs::write(&record, b"untouched legacy record").unwrap();
        let client = AntigravityClient::at_paths(data.path(), home.path().to_path_buf());
        let task = Uuid::new_v4().to_string();
        let binding = Binding {
            version: 1,
            task_id: task.clone(),
            native_id: native.clone(),
            cwd: data.path().display().to_string(),
            mcp_binding: new_binding_value(),
        };
        client.inner.bindings.write(&binding).unwrap();
        assert!(matches!(
            client.open(&task, None, false).await,
            Err(AntigravityError::ConversationGone(_))
        ));
        assert_eq!(client.binding(&task).await.unwrap().native_id, native);
        assert_eq!(fs::read(record).unwrap(), b"untouched legacy record");
        assert!(!home.path().join("antigravity-cli").exists());
        assert!(!client.inner.data.join("runner.sock").exists());
    }

    #[tokio::test]
    #[ignore = "read-only native record review; set CAFFOLD_AGY_REVIEW_HOME and CAFFOLD_AGY_REVIEW_SESSION"]
    async fn native_record_review_publishes_items_between_lifecycle_boundaries() {
        let native_home = PathBuf::from(env::var("CAFFOLD_AGY_REVIEW_HOME").unwrap());
        let native_id = env::var("CAFFOLD_AGY_REVIEW_SESSION").unwrap();
        let data = tempfile::tempdir().unwrap();
        let client = AntigravityClient::at_paths(data.path(), native_home);
        let task = Uuid::new_v4().to_string();
        client
            .inner
            .bindings
            .write(&Binding {
                version: 1,
                task_id: task.clone(),
                native_id,
                cwd: data.path().display().to_string(),
                mcp_binding: new_binding_value(),
            })
            .unwrap();
        let mut events = client.subscribe();
        let snapshot = client.read_snapshot(&task, None, 100).await.unwrap();
        assert!(!snapshot.page.turns.is_empty());
        assert!(client.publish_native_changes(&task).await.unwrap());
        let mut received = Vec::new();
        while let Ok(AntigravityRuntimeEvent::Session(event)) = events.try_recv() {
            received.push(event.kind);
        }
        for turn in &snapshot.page.turns {
            let items = received
                .iter()
                .filter_map(|event| match event {
                    SessionEventKind::ItemChanged { turn_id, item, .. } if turn_id == &turn.id => {
                        Some(item)
                    }
                    _ => None,
                })
                .collect::<Vec<_>>();
            assert_eq!(
                items,
                turn.items.iter().collect::<Vec<_>>(),
                "native lifecycle must not suppress item publication"
            );
        }
        assert!(
            !client.publish_native_changes(&task).await.unwrap(),
            "reading unchanged WAL must not cause another publication"
        );
        assert!(events.try_recv().is_err());
        let latest = &snapshot.page.turns[0];
        assert!(
            latest
                .items
                .iter()
                .any(|item| matches!(item.kind, ItemKind::UserMessage { .. }))
        );
        assert!(
            latest
                .items
                .iter()
                .any(|item| matches!(item.kind, ItemKind::AssistantMessage { .. }))
        );
        eprintln!(
            "read-only review: {} turns, latest {} items, exact lifecycle/item publication verified",
            snapshot.page.turns.len(),
            latest.items.len()
        );
    }
}
