//! Grok, driven through its own leader and stdio bridge.
//!
//! Grok's harness is a leader process that owns sessions and turns, and a
//! bridge process that speaks JSON-RPC to it over stdio. Caffold runs one
//! bridge and multiplexes every Grok Task over it. What the leader owns
//! survives a Caffold restart; what this driver keeps is how to reach it: a
//! binding file per Task naming the native session the Task runs on, and the
//! session state it watches while a bridge is up.
//!
//! A Task's identifier is chosen by Caffold and given to Grok as the first
//! session's id, so the two are one name until a worktree switch forks the
//! session — from then on the binding says which native session answers to
//! the Task.

mod binding;
mod history;
mod protocol;
mod reading;
mod session;
mod status;
mod switching;
mod translate;
mod transport;

pub(crate) use self::status::GrokStatus;
#[cfg(test)]
pub(crate) use self::transport::mock::MockLeader;

use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};
#[cfg(test)]
use tokio::sync::mpsc;
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use uuid::Uuid;

#[cfg(test)]
use self::transport::mock::MockBridge;
use self::{
    binding::{BindingStore, NativeSession},
    history::Cursor,
    protocol::{
        CAFFOLD_FIRST_TURN_NAMING_INSTRUCTIONS, CONFIG_MODEL, CONFIG_REASONING_EFFORT, CloseResult,
        ConfigOption, ModelState, ModelsListResult, NewSession, PermissionMode, PromptResult,
        SessionInfoResult, SessionLoadResult, SessionNewResult, SetConfigOptionResult, Update,
        UpdatesResult, UpdatesWindow,
    },
    session::{Session, SessionState},
    transport::{Bridge, LEADER_SOCKET_FILE_NAME, Transport},
};
use super::{
    ActivityStatus, ApprovalDecision, ApprovalRequest, Conversation, ConversationItem, ItemKind,
    SessionEvent, SessionEventKind, ThreadStatus, Turn, TurnPage, TurnState, TurnStatus,
    codex::{CAFFOLD_MCP_BINDING_HEADER, CAFFOLD_MCP_SERVER_NAME, CodexMcpBindings},
    driver::{
        AgentError, Driver, ModelOption, PermissionModeOption, PermissionModes, TurnOptions,
        TurnRejected, bounded,
    },
};

/// Why an operation on a Grok session did not happen.
#[derive(Debug, thiserror::Error, Clone)]
pub(crate) enum GrokError {
    /// The leader or the bridge could not be started, reached, or kept.
    #[error("The Grok bridge is unavailable: {0}")]
    Unreachable(String),
    /// Waiting on the leader ran out.
    #[error("Grok did not answer in time: {0}")]
    TimedOut(String),
    /// The leader said something this release cannot read.
    #[error("Grok protocol error: {0}")]
    Protocol(String),
    /// The leader answered, and the answer was a refusal.
    #[error("Grok refused: {0}")]
    Agent(String),
    /// The session's files are not where the leader was told to look.
    #[error("Grok no longer has the conversation: {0}")]
    ConversationGone(String),
    /// The turn asked about is not the one running.
    #[error("The Grok turn is not running: {0}")]
    TurnGone(String),
    /// No session is being watched under that Task's name.
    #[error("Caffold is not watching Grok conversation {0}.")]
    NotWatching(String),
    /// The question was no longer waiting.
    #[error("Nothing is waiting on approval {0}.")]
    NoSuchApproval(String),
    /// The Task's binding to its native session could not be read or kept.
    #[error("Grok binding error: {0}")]
    Binding(String),
}

impl From<GrokError> for AgentError {
    fn from(error: GrokError) -> Self {
        match error {
            GrokError::Unreachable(_) => AgentError::Unreachable(error.to_string()),
            GrokError::TimedOut(_) => AgentError::TimedOut(error.to_string()),
            GrokError::ConversationGone(_) | GrokError::NotWatching(_) => {
                AgentError::ConversationGone(error.to_string())
            }
            GrokError::TurnGone(_) => AgentError::TurnGone(error.to_string()),
            GrokError::Protocol(_)
            | GrokError::Agent(_)
            | GrokError::NoSuchApproval(_)
            | GrokError::Binding(_) => AgentError::Failed(error.to_string()),
        }
    }
}

impl From<GrokError> for TurnRejected {
    fn from(error: GrokError) -> Self {
        Self::Unavailable(error.into())
    }
}

/// Something a Grok session did that the rest of Caffold acts on.
#[derive(Debug, Clone)]
pub(crate) enum GrokRuntimeEvent {
    /// The conversation moved, in the vocabulary every agent reports in.
    Session(Box<SessionEvent>),
    /// The agent is blocked until someone answers.
    Approval {
        conversation_id: String,
        request: Box<ApprovalRequest>,
    },
    /// The bridge this session was watched through is gone, or the leader
    /// behind it was replaced. Opening the Task again loads it afresh.
    Unreachable {
        conversation_id: String,
        message: String,
    },
    /// Something worth writing down that nothing acts on.
    Diagnostic { message: String },
}

/// What a person chose for a turn, in Grok's terms.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct GrokTurnOptions {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) permission_mode: Option<String>,
}

/// The agent Caffold drives when a Task belongs to Grok.
#[derive(Clone)]
pub(crate) struct GrokClient {
    inner: Arc<GrokClientInner>,
}

struct GrokClientInner {
    transport: Transport,
    bindings: BindingStore,
    /// Grok's own store of session records, a directory per session under
    /// one named after the working directory.
    records: PathBuf,
    /// Watched sessions, by Task id.
    sessions: AsyncMutex<HashMap<String, Arc<Session>>>,
    /// Which Task each native session id belongs to, for routing what the
    /// leader says.
    natives: AsyncMutex<HashMap<String, String>>,
    events: broadcast::Sender<GrokRuntimeEvent>,
    /// The catalog, as the bridge of one generation reported it.
    catalog: AsyncMutex<Option<(u64, Vec<ModelOption>)>>,
    /// How sessions reach the tools Caffold serves, once the server exists.
    mcp: StdMutex<Option<McpCarrier>>,
    /// The binding each open session was started or loaded with, by Task.
    mcp_tokens: AsyncMutex<HashMap<String, String>>,
    /// Tasks whose binding carries a worktree switch, so that turn ends and
    /// idle reports look at the file only for them.
    switching: StdMutex<HashSet<String>>,
    /// One switch run per Task at a time.
    switch_runs: AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

/// The Caffold MCP server, as declared to every session.
///
/// The binding capability is Codex's own — one installation key, one
/// signed-session shape — reused here for the narrow thing it does: prove to
/// Caffold's own HTTP endpoint which Task a tool call belongs to. A Grok
/// Task's identity is known before its session exists, so the binding is
/// bound to the Task before the session is asked for and the first
/// `initialize` already answers with the signed session.
///
/// Grok initializes the connection during session creation and again
/// whenever it sees fit, so the binding stays bound for as long as the
/// session is open. It is let go when the session is closed or erased, or
/// replaced when the session is loaded again under a new one.
struct McpCarrier {
    bindings: CodexMcpBindings,
    endpoint: String,
}

/// A binding handed to one session start or load, to be completed or
/// cancelled when that request comes back.
struct McpBootstrap {
    token: String,
}

/// How long `session/load` may take: it replays the session's history.
const LOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// What Grok leaves as it is when it names a session directory after the
/// working directory: ASCII letters and digits, `-`, `_`, `.` and `~`. Every
/// other byte of the UTF-8 path is percent-encoded.
const SESSION_DIRECTORY_NAME: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

fn session_directory_name(cwd: &str) -> String {
    utf8_percent_encode(cwd, SESSION_DIRECTORY_NAME).to_string()
}

impl GrokClient {
    /// The agent as reached through Caffold's own leader.
    ///
    /// Bindings live under the data directory; the leader socket lives where
    /// Grok looks for leaders, under a name of Caffold's.
    pub(crate) fn in_data_dir(data_dir: &Path) -> Self {
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| data_dir.to_path_buf());
        let grok_home = home.join(".grok");
        Self::with_transport(
            Transport::grok(executable_path(), grok_home.join(LEADER_SOCKET_FILE_NAME)),
            data_dir.join("grok").join("bindings"),
            grok_home.join("sessions"),
        )
    }

    #[cfg(test)]
    pub(crate) fn mock(data_dir: &Path) -> (Self, mpsc::UnboundedReceiver<MockBridge>) {
        let (transport, bridges) = Transport::mock();
        (
            Self::with_transport(
                transport,
                data_dir.join("grok").join("bindings"),
                data_dir.join(".grok").join("sessions"),
            ),
            bridges,
        )
    }

    /// A client whose bridge dies the moment it is spawned, for tests that
    /// need Grok present and unreachable.
    #[cfg(test)]
    pub(crate) fn unreachable() -> Self {
        let (transport, bridges) = Transport::mock();
        drop(bridges);
        let dir = env::temp_dir().join(format!("caffold-grok-test-{}", Uuid::new_v4()));
        Self::with_transport(transport, dir.join("bindings"), dir.join("sessions"))
    }

    fn with_transport(transport: Transport, bindings: PathBuf, records: PathBuf) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(GrokClientInner {
                transport,
                bindings: BindingStore::new(bindings),
                records,
                sessions: AsyncMutex::new(HashMap::new()),
                natives: AsyncMutex::new(HashMap::new()),
                events,
                catalog: AsyncMutex::new(None),
                mcp: StdMutex::new(None),
                mcp_tokens: AsyncMutex::new(HashMap::new()),
                switching: StdMutex::new(HashSet::new()),
                switch_runs: AsyncMutex::new(HashMap::new()),
            }),
        }
    }

    pub(crate) fn driver(&self) -> Driver {
        Driver::Grok(self.clone())
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<GrokRuntimeEvent> {
        self.inner.events.subscribe()
    }

    /// Tell sessions where Caffold's tools are served, and how to prove which
    /// Task calls them.
    pub(crate) fn attach_mcp(&self, bindings: CodexMcpBindings, endpoint: String) {
        *self.inner.mcp.lock().unwrap_or_else(|p| p.into_inner()) =
            Some(McpCarrier { bindings, endpoint });
    }

    /// Begin carrying what the leader says into events. Armed once, at
    /// startup; nothing is started by it.
    pub(crate) fn watch(&self) {
        self.spawn_router();
    }

    /// Put the bridge down. The leader keeps running.
    pub(crate) async fn stop(&self) {
        self.inner.transport.stop().await;
    }

    // -----------------------------------------------------------------------
    // What the installation offers
    // -----------------------------------------------------------------------

    /// The models the leader offers, in the order it lists them.
    /// Forget the catalog, so the next asking reads it again.
    async fn forget_catalog(&self) {
        *self.inner.catalog.lock().await = None;
    }

    pub(crate) async fn models(&self) -> Result<Vec<ModelOption>, GrokError> {
        let bridge = self.inner.transport.bridge().await?;
        if let Some((generation, models)) = &*self.inner.catalog.lock().await
            && *generation == bridge.generation
        {
            return Ok(models.clone());
        }
        let state = match &bridge.hello().meta.model_state {
            // The hello carries the catalog; asking again would only repeat it.
            Some(state) => state.clone(),
            None => {
                let listed: ModelsListResult = serde_json::from_value(
                    self.inner
                        .transport
                        .call("_x.ai/models/list", json!({}))
                        .await?,
                )
                .map_err(|error| GrokError::Protocol(format!("models/list: {error}")))?;
                listed.result
            }
        };
        let models = model_options(&state);
        *self.inner.catalog.lock().await = Some((bridge.generation, models.clone()));
        Ok(models)
    }

    /// The ways a person can let Grok work. Named here, because the leader
    /// takes them as session-creation flags rather than listing them.
    pub(crate) fn permission_modes(&self) -> PermissionModes {
        let option =
            |mode: &str, label: &str, description: &str, dangerous: bool| PermissionModeOption {
                mode: mode.to_string(),
                label: label.to_string(),
                description: description.to_string(),
                allowed: true,
                unavailable_reason: None,
                dangerous,
            };
        PermissionModes {
            default_mode: PermissionMode::ASK.to_string(),
            options: vec![
                option(
                    PermissionMode::ASK,
                    "Ask each time",
                    "Stops for permission before every tool call its own policy does not already allow.",
                    false,
                ),
                option(
                    PermissionMode::AUTO,
                    "Automatic",
                    "Grok decides what to allow, and asks nobody.",
                    false,
                ),
                option(
                    PermissionMode::BYPASS,
                    "Full access",
                    "Never asks. Every tool call runs.",
                    true,
                ),
            ],
        }
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    /// Begin a conversation, under an identifier Caffold chose.
    ///
    /// The binding is written first: a session the leader has and Caffold
    /// cannot find again would be a conversation lost, so the address exists
    /// before the thing it addresses. A session the leader creates under any
    /// other name is closed and deleted rather than adopted.
    pub(crate) async fn start_conversation(
        &self,
        cwd: &str,
        options: &GrokTurnOptions,
    ) -> Result<Conversation, GrokError> {
        let id = Uuid::now_v7().to_string();
        let mode = options
            .permission_mode
            .as_deref()
            .map(|name| {
                PermissionMode::from_name(name).ok_or_else(|| {
                    GrokError::Agent(format!("Grok has no permission mode named {name:?}"))
                })
            })
            .transpose()?
            .unwrap_or(PermissionMode::Ask);
        let bridge = self.inner.transport.bridge().await?;
        self.inner.bindings.create(&id, &id, cwd).await?;
        let (mcp_servers, bootstrap) = self.mcp_servers_for(&id).await;
        let rules = format!(
            "{}\n\n{}",
            super::CAFFOLD_PLAN_DOCUMENT_INSTRUCTIONS,
            CAFFOLD_FIRST_TURN_NAMING_INSTRUCTIONS
        );
        let created = self
            .inner
            .transport
            .call(
                "session/new",
                protocol::session_new_params(NewSession {
                    session_id: &id,
                    cwd,
                    mcp_servers,
                    rules: Some(&rules),
                    mode,
                }),
            )
            .await;
        let created: SessionNewResult = match created.and_then(|value| {
            serde_json::from_value(value)
                .map_err(|error| GrokError::Protocol(format!("session/new: {error}")))
        }) {
            Ok(created) => {
                self.mcp_bootstrap_done(bootstrap, &id, true).await;
                created
            }
            Err(error) => {
                self.mcp_bootstrap_done(bootstrap, &id, false).await;
                let _ = self.inner.bindings.remove(&id).await;
                return Err(error);
            }
        };
        if created.session_id != id {
            let stray = created.session_id.clone();
            let _ = self
                .inner
                .transport
                .call("session/close", protocol::session_params(&stray))
                .await;
            let _ = self
                .inner
                .transport
                .call("_x.ai/session/delete", protocol::session_params(&stray))
                .await;
            let _ = self.inner.bindings.remove(&id).await;
            return Err(GrokError::Protocol(format!(
                "Grok created session {stray} when Caffold asked for {id}"
            )));
        }
        let session = Arc::new(Session {
            thread_id: id.clone(),
            native: AsyncMutex::new(NativeSession {
                session_id: id.clone(),
                cwd: cwd.to_string(),
            }),
            state: AsyncMutex::new(SessionState::new(mode, None, None)),
        });
        {
            let mut state = session.state.lock().await;
            state.loaded_on = bridge.generation;
            apply_catalog_facts(
                &mut state,
                created.models.as_ref(),
                &created.config_options,
                &GrokTurnOptions::default(),
            );
        }
        self.remember(session.clone()).await;
        if let Err(error) = self.apply_config(&session, options).await {
            let _ = self
                .inner
                .transport
                .call("session/close", protocol::session_params(&id))
                .await;
            let _ = self
                .inner
                .transport
                .call("_x.ai/session/delete", protocol::session_params(&id))
                .await;
            let _ = self.inner.bindings.remove(&id).await;
            self.forget(&id).await;
            return Err(error);
        }
        Ok(self.conversation_of(&session).await)
    }

    /// Open a conversation Caffold already knows the identifier of, loading
    /// it on the bridge in hand if it is not loaded there yet.
    pub(crate) async fn open_conversation(
        &self,
        thread_id: &str,
    ) -> Result<Conversation, GrokError> {
        let session = self.ensure_loaded(thread_id).await?;
        Ok(self.conversation_of(&session).await)
    }

    /// A conversation as it stands, if it is being watched on the bridge in
    /// hand. Nothing is loaded to find out.
    pub(crate) async fn watched_conversation(&self, thread_id: &str) -> Option<Conversation> {
        let session = self.session(thread_id).await?;
        let generation = self.inner.transport.generation().await?;
        if session.state.lock().await.loaded_on != generation {
            return None;
        }
        Some(self.conversation_of(&session).await)
    }

    /// What the session's settings are, in the keys the driver reads back.
    pub(crate) async fn settings_of(&self, thread_id: &str) -> BTreeMap<String, Value> {
        let Some(session) = self.session(thread_id).await else {
            return BTreeMap::new();
        };
        let state = session.state.lock().await;
        let mut settings = BTreeMap::new();
        if let Some(model) = &state.model {
            settings.insert("model".to_string(), json!(model));
        }
        if let Some(effort) = &state.effort {
            settings.insert("reasoningEffort".to_string(), json!(effort));
        }
        settings.insert("permissionMode".to_string(), json!(state.mode.name()));
        settings
    }

    /// Put a conversation away: the leader closes the session and keeps its
    /// files. The binding stays, because restoring is opening again.
    pub(crate) async fn close_conversation(&self, thread_id: &str) -> Result<(), GrokError> {
        let native = self.native_of(thread_id).await?;
        let closed: CloseResult = serde_json::from_value(
            self.inner
                .transport
                .call(
                    "session/close",
                    protocol::session_params(&native.session_id),
                )
                .await?,
        )
        .unwrap_or_default();
        if let Some(session) = self.session(thread_id).await {
            let mut state = session.state.lock().await;
            state.closed = true;
            state.loaded_on = 0;
            state.working = false;
        }
        self.forget_mcp_binding(thread_id).await;
        if !closed.closed() {
            self.publish(GrokRuntimeEvent::Diagnostic {
                message: format!(
                    "Grok did not report session {} as closed",
                    native.session_id
                ),
            });
        }
        Ok(())
    }

    /// Whether Grok still keeps the session's record. The leader is not
    /// asked: it describes a session it has no record of as an empty one,
    /// and only loading would tell the difference.
    pub(crate) async fn conversation_exists(&self, thread_id: &str) -> bool {
        let Ok(native) = self.native_of(thread_id).await else {
            return false;
        };
        let directory = self.session_directory(&native);
        tokio::task::spawn_blocking(move || directory.is_dir())
            .await
            .unwrap_or(false)
    }

    /// Where Grok keeps the session's record.
    fn session_directory(&self, native: &NativeSession) -> PathBuf {
        self.inner
            .records
            .join(session_directory_name(&native.cwd))
            .join(&native.session_id)
    }

    /// Remove every session this Task created, then the binding.
    pub(crate) async fn erase(&self, thread_id: &str) -> Result<(), GrokError> {
        let binding =
            self.inner.bindings.read(thread_id).await?.ok_or_else(|| {
                GrokError::Binding(format!("Task {thread_id} has no Grok binding"))
            })?;
        let mut sessions = binding
            .history
            .iter()
            .map(|closed| closed.session_id.clone())
            .collect::<Vec<_>>();
        sessions.push(binding.current.session_id.clone());
        // A copy the switch made, or only named, is the Task's as well.
        if let Some(switch) = &binding.switch
            && !sessions.contains(&switch.new_session_id)
        {
            sessions.push(switch.new_session_id.clone());
        }
        for session_id in sessions {
            let _ = self
                .inner
                .transport
                .call("session/close", protocol::session_params(&session_id))
                .await;
            match self
                .inner
                .transport
                .call(
                    "_x.ai/session/delete",
                    protocol::session_params(&session_id),
                )
                .await
            {
                Ok(_) | Err(GrokError::ConversationGone(_)) => {}
                Err(error) => return Err(error),
            }
        }
        self.inner.bindings.remove(thread_id).await?;
        self.settled_switch(thread_id);
        self.forget_mcp_binding(thread_id).await;
        self.forget(thread_id).await;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Turns
    // -----------------------------------------------------------------------

    /// Begin a turn, under the identity Caffold chose for it.
    ///
    /// The prompt request returns when the turn ends, so it is sent and left
    /// running; the turn is reported as begun here and ended when the leader
    /// says so or the request comes back.
    pub(crate) async fn start_turn(
        &self,
        thread_id: &str,
        cwd: &str,
        prompt: &str,
        images: &[String],
        options: &GrokTurnOptions,
    ) -> Result<Turn, GrokError> {
        let session = self.ensure_loaded(thread_id).await?;
        // A move into a worktree that is planned or under way comes first:
        // the turn runs where the Task is going, or not at all.
        if let Some(switch) = self.advance_switch(thread_id, true).await? {
            return Err(GrokError::Agent(switching::turn_refusal(&switch)));
        }
        let native = session.native.lock().await.clone();
        if !same_directory(&native.cwd, cwd) {
            return Err(GrokError::Agent(format!(
                "this conversation works in {} and cannot run a turn in {cwd}",
                native.cwd
            )));
        }
        if let Some(mode) = options.permission_mode.as_deref() {
            let current = session.state.lock().await.mode;
            if PermissionMode::from_name(mode) != Some(current) {
                return Err(GrokError::Agent(
                    "Grok fixes the permission mode when the conversation starts; start a new Task to change it."
                        .to_string(),
                ));
            }
        }
        self.apply_config(&session, options).await?;
        let prompt_id = Uuid::new_v4().to_string();
        let mut blocks = Vec::new();
        if !prompt.is_empty() {
            blocks.push(protocol::text_block(prompt));
        }
        for image in images {
            blocks.push(protocol::image_block(image).ok_or_else(|| {
                GrokError::Agent("an image must be a base64 data URL".to_string())
            })?);
        }
        let item = ConversationItem {
            id: format!("{prompt_id}:prompt"),
            observed_at_ms: Some(session::now_ms()),
            status: ActivityStatus::Completed,
            kind: ItemKind::UserMessage {
                text: prompt.to_string(),
                content: translate::prompt_content_of(prompt, images),
            },
        };
        let turn = {
            let mut state = session.state.lock().await;
            if let Some(running) = state.active_turn.as_deref() {
                return Err(GrokError::Agent(format!(
                    "turn {running} is still running on conversation {thread_id}"
                )));
            }
            if state.closed {
                return Err(GrokError::Agent(format!(
                    "Grok conversation {thread_id} is closed"
                )));
            }
            state.working = true;
            state.prompt_in_flight = true;
            state.open_turn(&prompt_id, item.clone())
        };
        let params = protocol::prompt_params(&native.session_id, &prompt_id, blocks);
        let client = self.clone();
        let thread = thread_id.to_string();
        let returned_prompt = prompt_id.clone();
        tokio::spawn(async move {
            let result = client
                .inner
                .transport
                .call_unbounded("session/prompt", params)
                .await;
            client
                .prompt_returned(&thread, &returned_prompt, result)
                .await;
        });
        self.report(
            thread_id,
            SessionEventKind::StatusChanged {
                status: ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
            },
        );
        self.report(
            thread_id,
            SessionEventKind::TurnStarted {
                turn: TurnState::from(&turn),
            },
        );
        self.report(
            thread_id,
            SessionEventKind::ItemChanged {
                turn_id: prompt_id.clone(),
                at_ms: item.observed_at_ms.unwrap_or_default(),
                item,
            },
        );
        Ok(turn)
    }

    /// Add to the running turn. The leader reads it at its next safe point.
    pub(crate) async fn steer_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
        prompt: &str,
        images: &[String],
    ) -> Result<ConversationItem, GrokError> {
        let session = self.require_session(thread_id).await?;
        let native = session.native.lock().await.clone();
        {
            let state = session.state.lock().await;
            if state.active_turn.as_deref() != Some(turn_id) {
                return Err(GrokError::TurnGone(format!(
                    "turn {turn_id} is not running on conversation {thread_id}"
                )));
            }
        }
        let interjection_id = Uuid::new_v4().to_string();
        let mut blocks = vec![protocol::text_block(prompt)];
        for image in images {
            blocks.push(protocol::image_block(image).ok_or_else(|| {
                GrokError::Agent("an image must be a base64 data URL".to_string())
            })?);
        }
        self.inner
            .transport
            .call(
                "_x.ai/interject",
                protocol::interject_params(&native.session_id, &interjection_id, prompt, blocks),
            )
            .await?;
        let item = ConversationItem {
            id: interjection_id,
            observed_at_ms: Some(session::now_ms()),
            status: ActivityStatus::Completed,
            kind: ItemKind::UserMessage {
                text: prompt.to_string(),
                content: translate::prompt_content_of(prompt, images),
            },
        };
        session.state.lock().await.place(item.clone());
        self.report(
            thread_id,
            SessionEventKind::ItemChanged {
                turn_id: turn_id.to_string(),
                at_ms: item.observed_at_ms.unwrap_or_default(),
                item: item.clone(),
            },
        );
        Ok(item)
    }

    /// Stop the running turn where it stands.
    pub(crate) async fn interrupt_turn(
        &self,
        thread_id: &str,
        turn_id: &str,
    ) -> Result<(), GrokError> {
        let session = self.require_session(thread_id).await?;
        let native = session.native.lock().await.clone();
        if session.state.lock().await.active_turn.as_deref() != Some(turn_id) {
            return Err(GrokError::TurnGone(format!(
                "turn {turn_id} is not running on conversation {thread_id}"
            )));
        }
        self.inner
            .transport
            .notify(
                "session/cancel",
                protocol::cancel_params(&native.session_id),
            )
            .await
    }

    /// A conversation's turns, newest first, from the leader's log.
    pub(crate) async fn read_turns(
        &self,
        thread_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<TurnPage, GrokError> {
        let native = self.native_of(thread_id).await?;
        let limit = limit.max(1);
        let (result, window_start) = match cursor {
            None => {
                let mut result: UpdatesResult = self
                    .updates(&native, UpdatesWindow::LastTurns(limit))
                    .await?;
                let mut window_start = result.total_count.saturating_sub(result.updates.len());
                // The leader counts interjections as turns, so the window
                // can begin inside one; walk back to where that turn began.
                while window_start > 0 && !begins_a_turn(&result) {
                    let Some((start, len)) =
                        history::older_window(&result.prompt_starts, window_start, 1)
                    else {
                        break;
                    };
                    let earlier: UpdatesResult = self
                        .updates(
                            &native,
                            UpdatesWindow::Range {
                                offset: start,
                                limit: len,
                            },
                        )
                        .await?;
                    let mut updates = earlier.updates;
                    updates.append(&mut result.updates);
                    result.updates = updates;
                    window_start = start;
                }
                (result, window_start)
            }
            Some(cursor) => {
                let cursor = Cursor::read(cursor).ok_or_else(|| {
                    GrokError::Agent(format!("{cursor:?} is not a Grok history cursor"))
                })?;
                let probe: UpdatesResult = self
                    .updates(
                        &native,
                        UpdatesWindow::Range {
                            offset: cursor.oldest_start,
                            limit: 1,
                        },
                    )
                    .await?;
                let Some((start, len)) =
                    history::older_window(&probe.prompt_starts, cursor.oldest_start, limit)
                else {
                    return Ok(TurnPage::default());
                };
                let result: UpdatesResult = self
                    .updates(
                        &native,
                        UpdatesWindow::Range {
                            offset: start,
                            limit: len,
                        },
                    )
                    .await?;
                (result, start)
            }
        };
        let live_turn = match self.session(thread_id).await {
            Some(session) => session.state.lock().await.active_turn.clone(),
            None => None,
        };
        let mut page = history::turns_page(&result, window_start, live_turn.as_deref());
        if let Some(session) = self.session(thread_id).await {
            let state = session.state.lock().await;
            for turn in &state.turns {
                if let Some(known) = page.turns.iter_mut().find(|known| known.id == turn.id) {
                    *known = turn.clone();
                }
            }
        }
        Ok(page)
    }

    // -----------------------------------------------------------------------
    // Approvals
    // -----------------------------------------------------------------------

    /// Answer a question the agent is blocked on.
    pub(crate) async fn resolve_approval(
        &self,
        thread_id: &str,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), GrokError> {
        let session = self.require_session(thread_id).await?;
        let (pending, option_id) = {
            let mut state = session.state.lock().await;
            let pending = state
                .pending_approvals
                .get(approval_id)
                .ok_or_else(|| GrokError::NoSuchApproval(approval_id.to_string()))?;
            let kind = translate::option_kind_for(decision).ok_or_else(|| {
                GrokError::Protocol("approval decision is not supported by Grok".to_string())
            })?;
            let option_id = pending
                .options
                .iter()
                .find(|option| option.kind == kind)
                .map(|option| option.option_id.clone())
                .ok_or_else(|| {
                    GrokError::Protocol(format!("Grok did not offer {kind} for this request"))
                })?;
            let pending = state
                .pending_approvals
                .remove(approval_id)
                .expect("checked pending approval");
            if decision == ApprovalDecision::Deny {
                state.declined.insert(approval_id.to_string());
            }
            (pending, option_id)
        };
        self.inner
            .transport
            .respond(
                pending.generation,
                &pending.request_id,
                protocol::permission_selected(&option_id),
            )
            .await?;
        self.report_activity(thread_id, &session).await;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Inside
    // -----------------------------------------------------------------------

    async fn session(&self, thread_id: &str) -> Option<Arc<Session>> {
        self.inner.sessions.lock().await.get(thread_id).cloned()
    }

    async fn require_session(&self, thread_id: &str) -> Result<Arc<Session>, GrokError> {
        self.session(thread_id)
            .await
            .ok_or_else(|| GrokError::NotWatching(thread_id.to_string()))
    }

    async fn session_by_native(&self, session_id: &str) -> Option<Arc<Session>> {
        let thread_id = self.inner.natives.lock().await.get(session_id).cloned()?;
        self.session(&thread_id).await
    }

    async fn remember(&self, session: Arc<Session>) {
        let native = session.native.lock().await.session_id.clone();
        self.inner
            .natives
            .lock()
            .await
            .insert(native, session.thread_id.clone());
        self.inner
            .sessions
            .lock()
            .await
            .insert(session.thread_id.clone(), session);
    }

    async fn forget(&self, thread_id: &str) {
        let removed = self.inner.sessions.lock().await.remove(thread_id);
        if let Some(session) = removed {
            let native = session.native.lock().await.session_id.clone();
            self.inner.natives.lock().await.remove(&native);
        }
    }

    /// Where the Task runs, from the watched session or else the binding.
    async fn native_of(&self, thread_id: &str) -> Result<NativeSession, GrokError> {
        if let Some(session) = self.session(thread_id).await {
            return Ok(session.native.lock().await.clone());
        }
        let binding =
            self.inner.bindings.read(thread_id).await?.ok_or_else(|| {
                GrokError::Binding(format!("Task {thread_id} has no Grok binding"))
            })?;
        Ok(binding.current)
    }

    /// The session, loaded on the bridge in hand.
    async fn ensure_loaded(&self, thread_id: &str) -> Result<Arc<Session>, GrokError> {
        let bridge = self.inner.transport.bridge().await?;
        let session = match self.session(thread_id).await {
            Some(session) => session,
            None => {
                let binding = self.inner.bindings.read(thread_id).await?.ok_or_else(|| {
                    GrokError::Binding(format!("Task {thread_id} has no Grok binding"))
                })?;
                if binding.switch.is_some() {
                    self.note_switching(thread_id);
                }
                let session = Arc::new(Session {
                    thread_id: thread_id.to_string(),
                    native: AsyncMutex::new(binding.current),
                    state: AsyncMutex::new(SessionState::new(PermissionMode::Ask, None, None)),
                });
                self.remember(session.clone()).await;
                session
            }
        };
        if session.state.lock().await.loaded_on == bridge.generation {
            return Ok(session);
        }
        // A worktree switch that got past the fork loads the copy, not the
        // source; one that has not waits until the source is loaded and seen
        // idle. Either way the switch is not what opening is for, so its
        // trouble is reported rather than returned.
        self.resume_switch(thread_id).await;
        if session.state.lock().await.loaded_on == bridge.generation {
            return Ok(session);
        }
        let native = session.native.lock().await.clone();
        // Claimed for this bridge before the load is asked for, so that what
        // the leader streams while loading — a turn another client left
        // running — is routed rather than dropped. A failed load takes the
        // claim back.
        session.state.lock().await.loaded_on = bridge.generation;
        let loaded = self.load_and_check(&bridge, thread_id, &native).await;
        let (loaded, info) = match loaded {
            Ok(answered) => answered,
            Err(error) => {
                session.state.lock().await.loaded_on = 0;
                return Err(error);
            }
        };
        self.absorb_loaded(&session, loaded, info).await;
        self.reconcile_turn(thread_id, &session, &native).await;
        self.resume_switch(thread_id).await;
        Ok(session)
    }

    /// After a gap in observation, the record says whether the turn this
    /// process knew as running still runs. Its end is taken from the record
    /// when the record has it. A turn the record no longer shows as its
    /// newest is over as well, though how it ended is not written where this
    /// reader looked, and that is what its note says.
    async fn reconcile_turn(
        &self,
        thread_id: &str,
        session: &Arc<Session>,
        native: &NativeSession,
    ) {
        let Some(active) = session.state.lock().await.active_turn.clone() else {
            return;
        };
        let result = match self.updates(native, UpdatesWindow::LastTurns(3)).await {
            Ok(result) => result,
            Err(error) => {
                self.publish(GrokRuntimeEvent::Diagnostic {
                    message: format!(
                        "the record of Grok conversation {thread_id} could not be read after reconnecting: {error}"
                    ),
                });
                return;
            }
        };
        let window_start = result.total_count.saturating_sub(result.updates.len());
        let page = history::turns_page(&result, window_start, Some(&active));
        let (status, failure) = match page.turns.iter().find(|turn| turn.id == active) {
            Some(turn) if turn.status == TurnStatus::InProgress => return,
            Some(turn) => (turn.status, None),
            None => (
                TurnStatus::Failed,
                Some(
                    "Caffold lost sight of this turn while disconnected; how it ended is not in the record it read."
                        .to_string(),
                ),
            ),
        };
        let ended = session
            .state
            .lock()
            .await
            .end_turn(&active, status, failure);
        if let Some((turn, changed)) = ended {
            self.report_turn_ended(thread_id, turn, changed);
        }
    }

    /// Take in what a load and the session's own account said.
    async fn absorb_loaded(
        &self,
        session: &Arc<Session>,
        loaded: SessionLoadResult,
        info: SessionInfoResult,
    ) {
        let mut state = session.state.lock().await;
        state.closed = false;
        apply_catalog_facts(
            &mut state,
            loaded.models.as_ref(),
            &loaded.config_options,
            &GrokTurnOptions::default(),
        );
        if let Some(model) = info.result.model {
            state.model = Some(model);
        }
        if let Some(context) = info.result.context {
            state.context_window = context.total.or(state.context_window);
            state.session_tokens = context.used;
        }
    }

    /// Load the session on this bridge and check it runs where the binding
    /// says. The load replays history as notifications; the check reads the
    /// leader's own account of the session afterwards.
    async fn load_and_check(
        &self,
        bridge: &Bridge,
        thread_id: &str,
        native: &NativeSession,
    ) -> Result<(SessionLoadResult, SessionInfoResult), GrokError> {
        let (mcp_servers, bootstrap) = self.mcp_servers_for(thread_id).await;
        let loaded = bridge
            .call(
                "session/load",
                protocol::session_load_params(&native.session_id, &native.cwd, mcp_servers),
                Some(LOAD_TIMEOUT),
            )
            .await;
        self.mcp_bootstrap_done(bootstrap, thread_id, loaded.is_ok())
            .await;
        let loaded: SessionLoadResult = serde_json::from_value(loaded?).unwrap_or_default();
        let info: SessionInfoResult = serde_json::from_value(
            self.inner
                .transport
                .call(
                    "_x.ai/session/info",
                    protocol::session_params(&native.session_id),
                )
                .await?,
        )
        .map_err(|error| GrokError::Protocol(format!("session/info: {error}")))?;
        if let Some(cwd) = info.result.cwd.as_deref()
            && !same_directory(cwd, &native.cwd)
        {
            return Err(GrokError::Binding(format!(
                "Grok runs session {} in {cwd}, not in {} as the Task's binding says",
                native.session_id, native.cwd
            )));
        }
        Ok((loaded, info))
    }

    /// The MCP servers a session is started or loaded with: Caffold's own,
    /// bound to this Task, when the server exists.
    async fn mcp_servers_for(&self, thread_id: &str) -> (Vec<Value>, Option<McpBootstrap>) {
        let carrier = {
            let mcp = self.inner.mcp.lock().unwrap_or_else(|p| p.into_inner());
            mcp.as_ref()
                .map(|carrier| (carrier.bindings.clone(), carrier.endpoint.clone()))
        };
        let Some((bindings, endpoint)) = carrier else {
            return (Vec::new(), None);
        };
        let Ok(token) = bindings.begin_pending().await else {
            return (Vec::new(), None);
        };
        if bindings.bind_pending(&token, thread_id).await.is_err() {
            let _ = bindings.cancel_pending(&token).await;
            return (Vec::new(), None);
        }
        let server = protocol::http_mcp_server(
            CAFFOLD_MCP_SERVER_NAME,
            &endpoint,
            &[(CAFFOLD_MCP_BINDING_HEADER, token.as_str())],
        );
        (vec![server], Some(McpBootstrap { token }))
    }

    async fn mcp_bootstrap_done(
        &self,
        bootstrap: Option<McpBootstrap>,
        thread_id: &str,
        succeeded: bool,
    ) {
        let Some(bootstrap) = bootstrap else {
            return;
        };
        let bindings = {
            let mcp = self.inner.mcp.lock().unwrap_or_else(|p| p.into_inner());
            mcp.as_ref().map(|carrier| carrier.bindings.clone())
        };
        let Some(bindings) = bindings else {
            return;
        };
        if !succeeded {
            let _ = bindings.cancel_pending(&bootstrap.token).await;
            return;
        }
        let previous = self
            .inner
            .mcp_tokens
            .lock()
            .await
            .insert(thread_id.to_string(), bootstrap.token);
        if let Some(previous) = previous {
            let _ = bindings.cancel_pending(&previous).await;
        }
    }

    /// Let go of the binding a session was open under.
    async fn forget_mcp_binding(&self, thread_id: &str) {
        let token = self.inner.mcp_tokens.lock().await.remove(thread_id);
        let bindings = {
            let mcp = self.inner.mcp.lock().unwrap_or_else(|p| p.into_inner());
            mcp.as_ref().map(|carrier| carrier.bindings.clone())
        };
        if let (Some(token), Some(bindings)) = (token, bindings) {
            let _ = bindings.cancel_pending(&token).await;
        }
    }

    /// Where the Task works now, from its binding.
    pub(crate) async fn working_directory(&self, thread_id: &str) -> Result<String, GrokError> {
        Ok(self.native_of(thread_id).await?.cwd)
    }

    /// Retitle the leader's own session, so its surfaces show the name
    /// Caffold keeps.
    pub(crate) async fn rename_conversation(
        &self,
        thread_id: &str,
        title: &str,
    ) -> Result<(), GrokError> {
        let native = self.native_of(thread_id).await?;
        self.inner
            .transport
            .call(
                "_x.ai/session/rename",
                protocol::rename_params(&native.session_id, title),
            )
            .await
            .map(|_| ())
    }

    /// Bring the session to the model and depth chosen, where they differ.
    async fn apply_config(
        &self,
        session: &Arc<Session>,
        options: &GrokTurnOptions,
    ) -> Result<(), GrokError> {
        let native = session.native.lock().await.clone();
        let (model, effort) = {
            let state = session.state.lock().await;
            (
                options
                    .model
                    .clone()
                    .filter(|wanted| state.model.as_ref() != Some(wanted)),
                options
                    .effort
                    .clone()
                    .filter(|wanted| state.effort.as_ref() != Some(wanted)),
            )
        };
        for (config_id, value) in [(CONFIG_MODEL, model), (CONFIG_REASONING_EFFORT, effort)] {
            let Some(value) = value else { continue };
            let applied: SetConfigOptionResult = serde_json::from_value(
                self.inner
                    .transport
                    .call(
                        "session/set_config_option",
                        protocol::set_config_option_params(&native.session_id, config_id, &value),
                    )
                    .await?,
            )
            .unwrap_or_default();
            let mut state = session.state.lock().await;
            apply_catalog_facts(
                &mut state,
                None,
                &applied.config_options,
                &GrokTurnOptions::default(),
            );
            match config_id {
                CONFIG_MODEL => state.model = Some(value),
                _ => state.effort = Some(value),
            }
        }
        Ok(())
    }

    async fn updates(
        &self,
        native: &NativeSession,
        window: UpdatesWindow,
    ) -> Result<UpdatesResult, GrokError> {
        serde_json::from_value(
            self.inner
                .transport
                .call(
                    "_x.ai/session/updates",
                    protocol::updates_params(&native.session_id, &native.cwd, window),
                )
                .await?,
        )
        .map_err(|error| GrokError::Protocol(format!("session/updates: {error}")))
    }

    /// The prompt request came back: the turn is over as far as the leader
    /// is concerned, whether or not it said so on the stream first.
    async fn prompt_returned(
        &self,
        thread_id: &str,
        prompt_id: &str,
        result: Result<Value, GrokError>,
    ) {
        let Some(session) = self.session(thread_id).await else {
            return;
        };
        session.state.lock().await.prompt_in_flight = false;
        let (status, failure) = match result {
            Ok(value) => {
                let returned: PromptResult =
                    serde_json::from_value(value).unwrap_or(PromptResult { stop_reason: None });
                let stop_reason = returned.stop_reason.as_deref();
                (
                    translate::turn_status(stop_reason),
                    stop_reason.and_then(translate::failure_text),
                )
            }
            // The bridge went away under the request. The leader may well be
            // finishing the turn without an audience; that is an observation
            // gap, not a failure, and the session has already been reported
            // as one to open again.
            Err(GrokError::Unreachable(_)) => return,
            Err(error) => (TurnStatus::Failed, Some(error.to_string())),
        };
        let ended = session
            .state
            .lock()
            .await
            .end_turn(prompt_id, status, failure);
        if let Some((turn, changed)) = ended {
            self.report_turn_ended(thread_id, turn, changed);
        }
        // The answer to the prompt is the leader's last word on the turn; a
        // move waiting for it can go now.
        self.trigger_switch(thread_id);
    }

    fn report_turn_ended(&self, thread_id: &str, turn: Turn, changed: Vec<ConversationItem>) {
        let at_ms = turn.completed_at_ms.unwrap_or_else(session::now_ms);
        for item in changed {
            self.report(
                thread_id,
                SessionEventKind::ItemChanged {
                    turn_id: turn.id.clone(),
                    item,
                    at_ms,
                },
            );
        }
        self.report(
            thread_id,
            SessionEventKind::TurnEnded {
                turn: TurnState::from(&turn),
            },
        );
        self.trigger_switch(thread_id);
    }

    async fn report_activity(&self, thread_id: &str, session: &Arc<Session>) {
        let status = {
            let state = session.state.lock().await;
            translate::thread_status(state.working, state.waiting_on_approval())
        };
        self.report(thread_id, SessionEventKind::ActivityChanged { status });
    }

    async fn conversation_of(&self, session: &Arc<Session>) -> Conversation {
        let cwd = session.native.lock().await.cwd.clone();
        let state = session.state.lock().await;
        Conversation {
            id: session.thread_id.clone(),
            title: state.title.clone(),
            preview: state
                .turns
                .last()
                .and_then(|turn| turn.items.first())
                .map(|item| match &item.kind {
                    ItemKind::UserMessage { text, .. }
                    | ItemKind::AssistantMessage { text, .. } => text.chars().take(120).collect(),
                    _ => String::new(),
                })
                .unwrap_or_default(),
            status: translate::thread_status(state.working, state.waiting_on_approval()),
            cwd,
            transcript_path: None,
            created_at_ms: state.opened_at_ms,
            updated_at_ms: state.moved_at_ms,
            recency_at_ms: Some(state.moved_at_ms),
            turns: state.turns.clone(),
        }
    }

    fn publish(&self, event: GrokRuntimeEvent) {
        let _ = self.inner.events.send(event);
    }

    fn report(&self, thread_id: &str, kind: SessionEventKind) {
        self.publish(GrokRuntimeEvent::Session(Box::new(SessionEvent {
            thread_id: thread_id.to_string(),
            kind,
        })));
    }

    fn transport(&self) -> &Transport {
        &self.inner.transport
    }
}

/// Whether the leader's window begins where a turn begins.
fn begins_a_turn(result: &UpdatesResult) -> bool {
    match result.updates.first() {
        Some(first) => matches!(
            Update::read(&first.params.update),
            Update::UserMessage(_, meta) if !meta.interjection
        ),
        None => true,
    }
}

/// Take what a catalog or option list says about the session.
fn apply_catalog_facts(
    state: &mut SessionState,
    models: Option<&ModelState>,
    config_options: &[ConfigOption],
    chosen: &GrokTurnOptions,
) {
    for option in config_options {
        match option.id.as_str() {
            CONFIG_MODEL => state.model = option.current_value.clone().or(state.model.clone()),
            CONFIG_REASONING_EFFORT => {
                state.effort = option.current_value.clone().or(state.effort.clone())
            }
            _ => {}
        }
    }
    if let Some(models) = models {
        let current = state
            .model
            .clone()
            .or_else(|| models.current_model_id.clone());
        state.context_window = models
            .available_models
            .iter()
            .find(|model| Some(&model.model_id) == current.as_ref())
            .and_then(|model| model.meta.total_context_tokens)
            .or(state.context_window);
    }
    if let Some(model) = &chosen.model {
        state.model = Some(model.clone());
    }
    if let Some(effort) = &chosen.effort {
        state.effort = Some(effort.clone());
    }
}

fn model_options(state: &ModelState) -> Vec<ModelOption> {
    state
        .available_models
        .iter()
        .map(|model| ModelOption {
            model: model.model_id.clone(),
            display_name: model.name.clone().unwrap_or_else(|| model.model_id.clone()),
            description: model.description.clone(),
            is_default: state.current_model_id.as_deref() == Some(model.model_id.as_str()),
            default_effort: model.meta.reasoning_effort.clone(),
            efforts: model
                .meta
                .reasoning_efforts
                .iter()
                .map(|effort| effort.value.clone())
                .collect(),
            supports_fast_mode: false,
            supports_auto_mode: true,
        })
        .collect()
}

fn same_directory(left: &str, right: &str) -> bool {
    let trim = |path: &str| path.trim_end_matches('/').to_string();
    if trim(left) == trim(right) {
        return true;
    }
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

/// Where `grok` is, looking where its installer puts it when the shell's
/// path does not say.
fn executable_path() -> PathBuf {
    if let Some(paths) = env::var_os("PATH") {
        for dir in env::split_paths(&paths) {
            let candidate = dir.join("grok");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        for candidate in [home.join(".grok/bin/grok"), home.join(".local/bin/grok")] {
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    PathBuf::from("grok")
}

/// What Grok will accept for a turn, given what the person asked for.
pub(crate) async fn grok_turn_options(
    client: &GrokClient,
    options: &TurnOptions,
) -> Result<GrokTurnOptions, TurnRejected> {
    let model = bounded(options.model.as_deref(), 128).ok_or(TurnRejected::Model)?;
    let effort = bounded(options.effort.as_deref(), 32).ok_or(TurnRejected::Effort)?;
    let permission_mode =
        bounded(options.permission_mode.as_deref(), 64).ok_or(TurnRejected::Model)?;
    if let Some(mode) = permission_mode.as_deref()
        && PermissionMode::from_name(mode).is_none()
    {
        return Err(TurnRejected::Model);
    }
    if model.is_none() && effort.is_none() {
        return Ok(GrokTurnOptions {
            model,
            effort,
            permission_mode,
        });
    }
    let models = client.models().await?;
    let selected = match model.as_deref() {
        Some(requested) => models.iter().find(|candidate| candidate.model == requested),
        None => models
            .iter()
            .find(|candidate| candidate.is_default)
            .or_else(|| models.first()),
    };
    let Some(selected) = selected else {
        return Err(if model.is_some() {
            TurnRejected::Model
        } else {
            TurnRejected::Effort
        });
    };
    if effort
        .as_deref()
        .is_some_and(|requested| !selected.efforts.iter().any(|offered| offered == requested))
    {
        return Err(TurnRejected::Effort);
    }
    Ok(GrokTurnOptions {
        model,
        effort,
        permission_mode,
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A scripted leader that answers the way `grok 1.0.30` did, for tests
    //! above this driver that need a Grok Task to exist.

    use std::{
        collections::HashMap,
        fs,
        path::Path,
        sync::{Arc, Mutex},
    };

    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::transport::mock::{MockAnswer, MockBridge, MockLeader};

    fn fixture(name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent/grok/fixtures")
            .join(name);
        serde_json::from_str(&fs::read_to_string(path).expect("fixture exists"))
            .expect("fixture is JSON")
    }

    /// The leader's catalog, as recorded.
    pub(crate) fn model_state() -> Value {
        fixture("initialize-result.json")["_meta"]["modelState"].clone()
    }

    fn config_options(model: &str, effort: &str) -> Value {
        json!([
            { "id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": model,
              "options": [{ "value": "grok-4.6", "name": "Grok 4.6" }, { "value": "grok-4.5", "name": "Grok 4.5" }] },
            { "id": "reasoning_effort", "name": "Reasoning Effort", "category": "thought_level", "type": "select", "currentValue": effort,
              "options": [{ "value": "xhigh", "name": "Extra High Effort" }, { "value": "high", "name": "High Effort" }, { "value": "medium", "name": "Medium Effort" }, { "value": "low", "name": "Low Effort" }] }
        ])
    }

    /// What the scripted leader remembers about its sessions.
    #[derive(Default)]
    pub(crate) struct LeaderMemory {
        /// Session id to working directory, from `session/new` and `session/load`.
        pub(crate) cwds: HashMap<String, String>,
        /// The stored updates `_x.ai/session/updates` answers with, by session.
        pub(crate) updates: HashMap<String, Value>,
        /// Per-session config values as last set.
        pub(crate) config: HashMap<String, (String, String)>,
    }

    /// A leader that answers every question a Task needs answered, and holds
    /// `session/prompt` until the test ends the turn.
    pub(crate) fn scripted_leader(
        bridges: mpsc::UnboundedReceiver<MockBridge>,
    ) -> (MockLeader, Arc<Mutex<LeaderMemory>>) {
        scripted_leader_with(bridges, |_, _| None)
    }

    /// The scripted leader, with `answer_instead` getting the first say on
    /// every request: `Some` replaces the script's answer for that request.
    pub(crate) fn scripted_leader_with(
        bridges: mpsc::UnboundedReceiver<MockBridge>,
        answer_instead: impl Fn(&str, &Value) -> Option<MockAnswer> + Send + Sync + 'static,
    ) -> (MockLeader, Arc<Mutex<LeaderMemory>>) {
        let memory = Arc::new(Mutex::new(LeaderMemory::default()));
        let remembered = memory.clone();
        let leader = MockLeader::start(bridges, move |method, params| {
            if let Some(answer) = answer_instead(method, params) {
                return answer;
            }
            let mut memory = remembered.lock().unwrap();
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            match method {
                "initialize" => MockAnswer::Result(fixture("initialize-result.json")),
                "_x.ai/models/list" => MockAnswer::Result(json!({ "result": model_state() })),
                "session/new" => {
                    let id = params["_meta"]["sessionId"]
                        .as_str()
                        .expect("Caffold names the session")
                        .to_string();
                    memory
                        .cwds
                        .insert(id.clone(), params["cwd"].as_str().unwrap_or("").to_string());
                    memory
                        .config
                        .insert(id.clone(), ("grok-4.6".to_string(), "xhigh".to_string()));
                    MockAnswer::Result(
                        json!({ "sessionId": id, "models": model_state(), "configOptions": config_options("grok-4.6", "xhigh"), "_meta": {} }),
                    )
                }
                "session/load" => {
                    if !memory.cwds.contains_key(&session_id) {
                        return MockAnswer::Error(-32603, "Path not found.");
                    }
                    memory.cwds.insert(
                        session_id.clone(),
                        params["cwd"].as_str().unwrap_or("").to_string(),
                    );
                    let (model, effort) = memory
                        .config
                        .get(&session_id)
                        .cloned()
                        .unwrap_or(("grok-4.6".to_string(), "xhigh".to_string()));
                    MockAnswer::Result(
                        json!({ "models": model_state(), "configOptions": config_options(&model, &effort), "_meta": {} }),
                    )
                }
                "session/set_config_option" => {
                    let entry = memory
                        .config
                        .entry(session_id.clone())
                        .or_insert(("grok-4.6".to_string(), "xhigh".to_string()));
                    let value = params["value"].as_str().unwrap_or("").to_string();
                    match params["configId"].as_str() {
                        Some("model") => entry.0 = value,
                        Some("reasoning_effort") => entry.1 = value,
                        _ => return MockAnswer::Error(-32602, "unknown config option"),
                    }
                    let (model, effort) = entry.clone();
                    MockAnswer::Result(json!({ "configOptions": config_options(&model, &effort) }))
                }
                "_x.ai/session/info" => match memory.cwds.get(&session_id) {
                    Some(cwd) => {
                        let (model, _) = memory
                            .config
                            .get(&session_id)
                            .cloned()
                            .unwrap_or(("grok-4.6".to_string(), "xhigh".to_string()));
                        MockAnswer::Result(
                            json!({ "result": { "sessionId": session_id, "cwd": cwd, "model": model, "context": { "used": 1500, "total": 500000 } } }),
                        )
                    }
                    None => MockAnswer::Result(json!({ "result": {} })),
                },
                // A session the leader has no record of is described as an
                // empty one, as `grok 1.0.30` does.
                "_x.ai/session/updates" => match memory.updates.get(&session_id) {
                    Some(updates) => MockAnswer::Result(updates.clone()),
                    None => MockAnswer::Result(
                        json!({ "updates": [], "totalCount": 0, "hasMore": false, "lastEventId": null, "promptStarts": [] }),
                    ),
                },
                "session/prompt" => MockAnswer::Hold,
                "_x.ai/interject" => {
                    MockAnswer::Result(json!({ "result": { "status": "queued" } }))
                }
                "session/close" => {
                    MockAnswer::Result(json!({ "_meta": { "x.ai/closeOutcome": "closed" } }))
                }
                "_x.ai/session/delete" => {
                    memory.cwds.remove(&session_id);
                    MockAnswer::Result(json!({ "success": true }))
                }
                "_x.ai/session/rename" => MockAnswer::Result(json!({ "success": true })),
                "_x.ai/session/fork" => {
                    let new_id = params["newSessionId"].as_str().unwrap_or("").to_string();
                    memory.cwds.insert(
                        new_id.clone(),
                        params["newCwd"].as_str().unwrap_or("").to_string(),
                    );
                    MockAnswer::Result(
                        json!({ "newSessionId": new_id, "chatMessagesCopied": 2, "updatesCopied": 4, "planStateCopied": false, "newCwd": params["newCwd"], "parentSessionId": params["sourceSessionId"] }),
                    )
                }
                _ => MockAnswer::Error(-32601, "Method not found"),
            }
        });
        (leader, memory)
    }

    /// One live update frame for a session, as the leader sends them.
    pub(crate) fn update_frame(
        session_id: &str,
        event_id: &str,
        prompt_id: &str,
        update: Value,
    ) -> Value {
        json!({ "sessionId": session_id, "update": update, "_meta": { "eventId": event_id, "agentTimestampMs": 1_789_197_957_299u64, "promptId": prompt_id } })
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, time::Duration};

    use serde_json::json;
    use tokio::{sync::broadcast, time::timeout};

    use super::binding::{ClosedSession, SwitchPhase};
    use super::test_support::{scripted_leader, update_frame};
    use super::*;
    use crate::agent::{ApprovalDecision, ThreadActiveFlag, codex::CodexMcpSessionAuthorization};

    const CWD: &str = "/Users/example/project";
    const WAIT: Duration = Duration::from_secs(5);

    async fn client() -> (GrokClient, MockLeader, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, _memory) = scripted_leader(bridges);
        client.watch();
        (client, leader, dir)
    }

    async fn next_event(events: &mut broadcast::Receiver<GrokRuntimeEvent>) -> GrokRuntimeEvent {
        timeout(WAIT, events.recv())
            .await
            .expect("an event in time")
            .expect("the channel is open")
    }

    async fn next_session_event(
        events: &mut broadcast::Receiver<GrokRuntimeEvent>,
    ) -> SessionEvent {
        loop {
            match next_event(events).await {
                GrokRuntimeEvent::Session(event) => return *event,
                GrokRuntimeEvent::Diagnostic { .. } => continue,
                other => panic!("expected a session event, got {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn a_conversation_is_started_under_the_identifier_caffold_chose_and_written_down() {
        let (client, leader, _dir) = client().await;
        let conversation = client
            .start_conversation(
                CWD,
                &GrokTurnOptions {
                    model: Some("grok-4.5".to_string()),
                    effort: Some("low".to_string()),
                    permission_mode: Some("bypass".to_string()),
                },
            )
            .await
            .expect("the conversation opens");
        let created = leader.wait_for("session/new").await;
        assert_eq!(created["_meta"]["sessionId"], conversation.id);
        assert_eq!(created["_meta"]["yoloMode"], true);
        assert!(
            created["_meta"]["rules"]
                .as_str()
                .unwrap()
                .contains("PLAN.md")
        );
        assert_eq!(created["cwd"], CWD);
        assert_eq!(conversation.cwd, CWD);
        assert_eq!(conversation.status, ThreadStatus::Idle);
        let set = leader.requests("session/set_config_option");
        assert_eq!(set.len(), 2, "the model and the depth were asked for");
        assert_eq!(set[0]["configId"], "model");
        assert_eq!(set[0]["value"], "grok-4.5");
        let binding = client
            .inner
            .bindings
            .read(&conversation.id)
            .await
            .unwrap()
            .expect("a binding");
        assert_eq!(binding.current.session_id, conversation.id);
        assert_eq!(binding.current.cwd, CWD);
        let settings = client.settings_of(&conversation.id).await;
        assert_eq!(settings["model"], "grok-4.5");
        assert_eq!(settings["reasoningEffort"], "low");
        assert_eq!(settings["permissionMode"], "bypass");
        assert!(
            client
                .watched_conversation(&conversation.id)
                .await
                .is_some()
        );
    }

    #[tokio::test]
    async fn the_catalog_is_offered_in_caffolds_words() {
        let (client, _leader, _dir) = client().await;
        let models = client.models().await.expect("the catalog");
        assert_eq!(models[0].model, "grok-4.6");
        assert_eq!(models[0].display_name, "Grok 4.6");
        assert!(models[0].is_default);
        assert_eq!(models[0].default_effort.as_deref(), Some("xhigh"));
        assert_eq!(models[0].efforts, ["xhigh", "high", "medium", "low"]);
        assert!(!models[0].supports_fast_mode);
        assert!(!models[1].is_default);
        let modes = client.permission_modes();
        assert_eq!(modes.default_mode, "default");
        assert_eq!(
            modes
                .options
                .iter()
                .map(|o| o.mode.as_str())
                .collect::<Vec<_>>(),
            ["default", "auto", "bypass"]
        );
        let rejected = grok_turn_options(
            &client,
            &TurnOptions {
                model: Some("gpt-9".to_string()),
                ..TurnOptions::default()
            },
        )
        .await;
        assert!(matches!(rejected, Err(TurnRejected::Model)));
        let rejected = grok_turn_options(
            &client,
            &TurnOptions {
                effort: Some("max".to_string()),
                ..TurnOptions::default()
            },
        )
        .await;
        assert!(matches!(rejected, Err(TurnRejected::Effort)));
        let accepted = grok_turn_options(
            &client,
            &TurnOptions {
                model: Some("grok-4.5".to_string()),
                effort: Some("low".to_string()),
                fast_mode: true,
                permission_mode: Some("auto".to_string()),
            },
        )
        .await
        .unwrap();
        assert_eq!(accepted.model.as_deref(), Some("grok-4.5"));
    }

    #[tokio::test]
    async fn a_turn_is_named_by_caffold_and_what_the_leader_streams_becomes_the_conversation() {
        let (client, leader, _dir) = client().await;
        let mut events = client.subscribe();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        let turn = client
            .start_turn(
                &id,
                CWD,
                "hello",
                &["data:image/png;base64,AAAA".to_string()],
                &GrokTurnOptions::default(),
            )
            .await
            .expect("the turn begins");
        let prompt = leader.wait_for("session/prompt").await;
        assert_eq!(prompt["_meta"]["promptId"], turn.id);
        assert_eq!(prompt["prompt"][0]["text"], "hello");
        assert_eq!(prompt["prompt"][1]["type"], "image");
        assert_eq!(prompt["prompt"][1]["mimeType"], "image/png");
        assert!(matches!(
            next_session_event(&mut events).await.kind,
            SessionEventKind::StatusChanged {
                status: ThreadStatus::Active { .. }
            }
        ));
        assert!(matches!(
            next_session_event(&mut events).await.kind,
            SessionEventKind::TurnStarted { .. }
        ));
        let SessionEventKind::ItemChanged { item, .. } = next_session_event(&mut events).await.kind
        else {
            panic!("the prompt item")
        };
        assert!(matches!(item.kind, ItemKind::UserMessage { ref text, .. } if text == "hello"));

        leader.notify("session/update", update_frame(&id, "e-30", &turn.id, json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "think" } }))).await;
        leader.notify("session/update", update_frame(&id, "e-31", &turn.id, json!({ "sessionUpdate": "agent_thought_chunk", "content": { "type": "text", "text": "ing" } }))).await;
        leader.notify("session/update", update_frame(&id, "e-40", &turn.id, json!({ "sessionUpdate": "tool_call", "toolCallId": "call-1", "title": "run_terminal_command", "rawInput": { "command": "ls" }, "_meta": { "x.ai/tool": { "name": "run_terminal_command", "kind": "execute" } } }))).await;
        leader.notify("session/update", update_frame(&id, "e-41", &turn.id, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call-1", "status": "completed", "rawOutput": { "type": "Bash", "output_for_prompt": "exit: 0\na\n", "exit_code": 0, "current_dir": CWD } }))).await;
        leader.notify("session/update", update_frame(&id, "e-50", &turn.id, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "done" } }))).await;
        let SessionEventKind::ItemChanged { item: first, .. } =
            next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        let SessionEventKind::ItemChanged { item: second, .. } =
            next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        assert_eq!(first.id, second.id, "streamed chunks are one item");
        assert_eq!(
            second.kind,
            ItemKind::Reasoning {
                summary: vec![],
                content: vec!["thinking".to_string()]
            }
        );
        let SessionEventKind::ItemChanged { item: call, .. } =
            next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        assert_eq!(call.id, "call-1");
        assert_eq!(call.status, ActivityStatus::InProgress);
        let SessionEventKind::ItemChanged { item: finished, .. } =
            next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        assert_eq!(finished.status, ActivityStatus::Completed);
        let ItemKind::CommandExecution(command) = &finished.kind else {
            panic!("a command")
        };
        assert_eq!(command.output.as_deref(), Some("exit: 0\na\n"));
        assert!(matches!(
            next_session_event(&mut events).await.kind,
            SessionEventKind::DiffChanged
        ));
        let SessionEventKind::ItemChanged { item: answer, .. } =
            next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        assert!(
            matches!(answer.kind, ItemKind::AssistantMessage { ref text, .. } if text == "done")
        );

        leader.notify("_x.ai/session_notification", update_frame(&id, "e-60", &turn.id, json!({ "sessionUpdate": "turn_completed", "prompt_id": turn.id, "stop_reason": "end_turn", "usage": { "inputTokens": 100, "outputTokens": 10, "totalTokens": 110, "cachedReadTokens": 0, "cacheCreationTokens": 0, "reasoningTokens": 2 } }))).await;
        let SessionEventKind::UsageReported { turn_id, usage } =
            next_session_event(&mut events).await.kind
        else {
            panic!("usage")
        };
        assert_eq!(turn_id, turn.id);
        assert_eq!(usage.last.input_tokens, 100);
        assert_eq!(usage.model_context_window, Some(500_000));
        let SessionEventKind::TurnEnded { turn: ended } =
            next_session_event(&mut events).await.kind
        else {
            panic!("the end")
        };
        assert_eq!(ended.id, turn.id);
        assert_eq!(ended.status, TurnStatus::Completed);
        // The request coming back afterwards changes nothing.
        leader
            .answer("session/prompt", json!({ "stopReason": "end_turn" }))
            .await;
        leader.notify("_x.ai/sessions/changed", json!({ "upserted": [{ "sessionId": id, "activity": "idle", "resident": true, "yolo": false }], "removed": [] })).await;
        let SessionEventKind::ActivityChanged { status } =
            next_session_event(&mut events).await.kind
        else {
            panic!("activity")
        };
        assert_eq!(status, ThreadStatus::Idle);
        assert!(
            client.watched_conversation(&id).await.unwrap().turns[0]
                .items
                .len()
                >= 4
        );
    }

    #[tokio::test]
    async fn a_prompt_request_that_fails_ends_the_turn_as_failed() {
        let (client, leader, _dir) = client().await;
        let mut events = client.subscribe();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let turn = client
            .start_turn(
                &conversation.id,
                CWD,
                "hi",
                &[],
                &GrokTurnOptions::default(),
            )
            .await
            .unwrap();
        leader.wait_for("session/prompt").await;
        for _ in 0..3 {
            next_session_event(&mut events).await;
        }
        leader.send(json!({ "jsonrpc": "2.0", "id": leader.requests("session/prompt").len() + 5, "result": {} })).await;
        // The leader answers the held prompt with an error.
        leader
            .answer("session/prompt", json!({ "stopReason": "refusal" }))
            .await;
        let SessionEventKind::ItemChanged { item, .. } = next_session_event(&mut events).await.kind
        else {
            panic!("the failure note")
        };
        assert!(matches!(item.kind, ItemKind::Failure { .. }));
        let SessionEventKind::TurnEnded { turn: ended } =
            next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        assert_eq!(ended.id, turn.id);
        assert_eq!(ended.status, TurnStatus::Failed);
    }

    #[tokio::test]
    async fn a_permission_request_is_answered_with_the_option_the_decision_names() {
        let (client, leader, _dir) = client().await;
        let mut events = client.subscribe();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        let turn = client
            .start_turn(&id, CWD, "run it", &[], &GrokTurnOptions::default())
            .await
            .unwrap();
        leader.wait_for("session/prompt").await;
        for _ in 0..3 {
            next_session_event(&mut events).await;
        }
        leader.ask(7, "session/request_permission", json!({
            "sessionId": id,
            "toolCall": { "toolCallId": "call-9", "kind": "execute", "title": "Execute `rm -rf x`", "rawInput": { "variant": "Bash", "command": "rm -rf x" }, "_meta": { "x.ai/tool": { "name": "run_terminal_command", "kind": "execute" } } },
            "options": [{ "optionId": "always-allow", "name": "always", "kind": "allow_always" }, { "optionId": "allow-once", "name": "once", "kind": "allow_once" }, { "optionId": "reject-once", "name": "no", "kind": "reject_once" }, { "optionId": "reject-always", "name": "never", "kind": "reject_always" }]
        })).await;
        let GrokRuntimeEvent::Approval {
            conversation_id,
            request,
        } = next_event(&mut events).await
        else {
            panic!("an approval")
        };
        assert_eq!(conversation_id, id);
        assert_eq!(request.id, "call-9");
        assert_eq!(request.turn_id.as_deref(), Some(turn.id.as_str()));
        assert_eq!(request.detail.command.as_deref(), Some("rm -rf x"));
        assert_eq!(request.detail.cwd.as_deref(), Some(CWD));
        assert_eq!(
            request.decisions,
            [
                ApprovalDecision::Allow,
                ApprovalDecision::AllowAlways,
                ApprovalDecision::Deny
            ]
        );
        let SessionEventKind::ActivityChanged { status } =
            next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        assert_eq!(
            status,
            ThreadStatus::Active {
                active_flags: vec![ThreadActiveFlag::WaitingOnApproval]
            }
        );

        assert!(matches!(
            client
                .resolve_approval(&id, "call-9", ApprovalDecision::Cancel)
                .await,
            Err(GrokError::Protocol(_))
        ));
        client
            .resolve_approval(&id, "call-9", ApprovalDecision::Deny)
            .await
            .expect("answered");
        let reply = leader.wait_for_notification("<response>").await;
        assert_eq!(reply["id"], 7);
        assert_eq!(reply["result"]["outcome"]["optionId"], "reject-once");
        assert!(matches!(
            client
                .resolve_approval(&id, "call-9", ApprovalDecision::Deny)
                .await,
            Err(GrokError::NoSuchApproval(_))
        ));
        let SessionEventKind::ActivityChanged { status } =
            next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        assert_eq!(
            status,
            ThreadStatus::Active {
                active_flags: vec![]
            }
        );
        // The refused call reads as declined, not failed.
        leader.notify("session/update", update_frame(&id, "e-70", &turn.id, json!({ "sessionUpdate": "tool_call", "toolCallId": "call-9", "title": "run_terminal_command", "rawInput": { "command": "rm -rf x" }, "_meta": { "x.ai/tool": { "name": "run_terminal_command", "kind": "execute" } } }))).await;
        leader.notify("session/update", update_frame(&id, "e-71", &turn.id, json!({ "sessionUpdate": "tool_call_update", "toolCallId": "call-9", "status": "failed", "content": [{ "type": "content", "content": { "type": "text", "text": "User rejected" } }] }))).await;
        next_session_event(&mut events).await;
        let SessionEventKind::ItemChanged { item, .. } = next_session_event(&mut events).await.kind
        else {
            panic!()
        };
        assert_eq!(item.status, ActivityStatus::Declined);
    }

    #[tokio::test]
    async fn steering_and_stopping_reach_the_leader_under_the_running_turn() {
        let (client, leader, _dir) = client().await;
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        assert!(matches!(
            client.interrupt_turn(&id, "nothing").await,
            Err(GrokError::TurnGone(_))
        ));
        let turn = client
            .start_turn(&id, CWD, "go", &[], &GrokTurnOptions::default())
            .await
            .unwrap();
        leader.wait_for("session/prompt").await;
        assert!(matches!(
            client
                .start_turn(&id, CWD, "again", &[], &GrokTurnOptions::default())
                .await,
            Err(GrokError::Agent(_))
        ));
        let item = client
            .steer_turn(&id, &turn.id, "faster", &[])
            .await
            .expect("steered");
        let interject = leader.wait_for("_x.ai/interject").await;
        assert_eq!(interject["interjectionId"], item.id);
        assert_eq!(interject["text"], "faster");
        assert!(matches!(
            client.steer_turn(&id, "other", "x", &[]).await,
            Err(GrokError::TurnGone(_))
        ));
        client
            .interrupt_turn(&id, &turn.id)
            .await
            .expect("cancelled");
        let cancel = leader.wait_for_notification("session/cancel").await;
        assert_eq!(cancel["sessionId"], id);
        let mismatched = client
            .start_turn(&id, "/elsewhere", "x", &[], &GrokTurnOptions::default())
            .await;
        assert!(matches!(mismatched, Err(GrokError::Agent(_))));
    }

    #[tokio::test]
    async fn the_permission_mode_cannot_change_after_the_session_started() {
        let (client, _leader, _dir) = client().await;
        let conversation = client
            .start_conversation(
                CWD,
                &GrokTurnOptions {
                    permission_mode: Some("auto".to_string()),
                    ..GrokTurnOptions::default()
                },
            )
            .await
            .unwrap();
        let refused = client
            .start_turn(
                &conversation.id,
                CWD,
                "x",
                &[],
                &GrokTurnOptions {
                    permission_mode: Some("bypass".to_string()),
                    ..GrokTurnOptions::default()
                },
            )
            .await;
        assert!(
            matches!(refused, Err(GrokError::Agent(ref message)) if message.contains("permission mode"))
        );
        client
            .start_turn(
                &conversation.id,
                CWD,
                "x",
                &[],
                &GrokTurnOptions {
                    permission_mode: Some("auto".to_string()),
                    ..GrokTurnOptions::default()
                },
            )
            .await
            .expect("the same mode is fine");
    }

    #[tokio::test]
    async fn opening_loads_the_session_from_its_binding_and_history_comes_from_the_log() {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, memory) = scripted_leader(bridges);
        client.watch();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        let stored = serde_json::from_str::<Value>(
            &fs::read_to_string(
                Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("src/agent/grok/fixtures/updates-result.json"),
            )
            .unwrap(),
        )
        .unwrap();
        memory.lock().unwrap().updates.insert(id.clone(), stored);

        // A second client over the same data directory is what a backend
        // replacement is: nothing watched, the binding on disk.
        let (again, bridges) = GrokClient::mock(dir.path());
        let (leader_again, memory_again) = scripted_leader(bridges);
        memory_again
            .lock()
            .unwrap()
            .cwds
            .insert(id.clone(), CWD.to_string());
        memory_again.lock().unwrap().updates = memory.lock().unwrap().updates.clone();
        again.watch();
        assert!(again.watched_conversation(&id).await.is_none());
        let opened = again
            .open_conversation(&id)
            .await
            .expect("loaded from the binding");
        assert_eq!(opened.cwd, CWD);
        let loaded = leader_again.wait_for("session/load").await;
        assert_eq!(loaded["sessionId"], id);
        assert_eq!(loaded["cwd"], CWD);
        leader_again.wait_for("_x.ai/session/info").await;
        let page = again.read_turns(&id, None, 3).await.expect("history");
        assert_eq!(
            page.turns.len(),
            5,
            "the scripted leader answers the whole log"
        );
        let asked = leader_again.wait_for("_x.ai/session/updates").await;
        assert_eq!(asked["turnIndex"], 3);
        drop(leader);
    }

    #[test]
    fn a_session_directory_is_named_after_the_working_directory_as_grok_names_it() {
        // Two names `grok 1.0.30` gave, one of them for a path with every kind
        // of character a person's directory can carry.
        assert_eq!(
            session_directory_name(
                "/Users/example/Library/Application Support/Caffold/data/worktrees/0f24e647-6d10-4753-bda4-c2a1a6ec827b"
            ),
            "%2FUsers%2Fexample%2FLibrary%2FApplication%20Support%2FCaffold%2Fdata%2Fworktrees%2F0f24e647-6d10-4753-bda4-c2a1a6ec827b"
        );
        assert_eq!(
            session_directory_name("/private/tmp/caffold-enc-probe/한글 a~b+c(d),e@f:g'h;i=j&k"),
            "%2Fprivate%2Ftmp%2Fcaffold-enc-probe%2F%ED%95%9C%EA%B8%80%20a~b%2Bc%28d%29%2Ce%40f%3Ag%27h%3Bi%3Dj%26k"
        );
    }

    #[tokio::test]
    async fn a_conversation_exists_while_grok_keeps_its_session_directory() {
        let (client, _leader, _dir) = client().await;
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        assert!(!client.conversation_exists(&id).await);
        let directory = client.session_directory(&NativeSession {
            session_id: id.clone(),
            cwd: CWD.to_string(),
        });
        fs::create_dir_all(&directory).unwrap();
        assert!(client.conversation_exists(&id).await);
        fs::remove_dir_all(&directory).unwrap();
        assert!(!client.conversation_exists(&id).await);
    }

    #[tokio::test]
    async fn closing_keeps_the_binding_and_erasing_removes_every_session_and_the_binding() {
        let (client, leader, _dir) = client().await;
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        client.close_conversation(&id).await.expect("closed");
        assert_eq!(leader.wait_for("session/close").await["sessionId"], id);
        assert!(client.inner.bindings.read(&id).await.unwrap().is_some());
        assert!(
            client.watched_conversation(&id).await.is_none(),
            "a closed session is not being watched"
        );
        let generation = client
            .inner
            .bindings
            .read(&id)
            .await
            .unwrap()
            .unwrap()
            .generation;
        client
            .inner
            .bindings
            .update_if(&id, generation, |binding| {
                binding.history.push(ClosedSession {
                    session_id: "older".to_string(),
                    cwd: CWD.to_string(),
                    close_pending: false,
                });
            })
            .await
            .unwrap();
        client.erase(&id).await.expect("erased");
        let deleted = leader.requests("_x.ai/session/delete");
        assert_eq!(
            deleted
                .iter()
                .map(|p| p["sessionId"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["older", id.as_str()]
        );
        assert!(client.inner.bindings.read(&id).await.unwrap().is_none());
        assert!(!client.conversation_exists(&id).await);
    }

    #[tokio::test]
    async fn a_bridge_that_goes_away_reports_every_watched_session_and_the_next_opening_loads_again()
     {
        let (client, leader, _dir) = client().await;
        let mut events = client.subscribe();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        leader.drop_bridge();
        let GrokRuntimeEvent::Unreachable {
            conversation_id, ..
        } = next_event(&mut events).await
        else {
            panic!("unreachable")
        };
        assert_eq!(conversation_id, id);
        assert!(client.watched_conversation(&id).await.is_none());
        client
            .open_conversation(&id)
            .await
            .expect("opened on the next bridge");
        assert_eq!(leader.requests("session/load").len(), 1);
        assert!(client.watched_conversation(&id).await.is_some());
    }

    #[tokio::test]
    async fn a_question_caffold_does_not_implement_is_refused_rather_than_left_blocking() {
        let (client, leader, _dir) = client().await;
        client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        leader
            .ask(3, "fs/read_text_file", json!({ "path": "/x" }))
            .await;
        let reply = leader.wait_for_notification("<response>").await;
        assert_eq!(reply["id"], 3);
        assert_eq!(reply["error"]["code"], -32601);
    }

    #[tokio::test]
    async fn sessions_carry_caffolds_tools_bound_to_the_task_and_a_new_task_is_told_to_name_itself()
    {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, _memory) = scripted_leader(bridges);
        let bindings = CodexMcpBindings::memory("http://127.0.0.1:1/api/codex/mcp".to_string());
        client.attach_mcp(
            bindings.clone(),
            "http://127.0.0.1:1/api/grok/mcp".to_string(),
        );
        client.watch();
        let mut events = client.subscribe();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();

        let asked = leader.wait_for("session/new").await;
        let server = &asked["mcpServers"][0];
        assert_eq!(server["name"], "caffold");
        assert_eq!(server["type"], "http");
        assert_eq!(server["url"], "http://127.0.0.1:1/api/grok/mcp");
        assert_eq!(server["headers"][0]["name"], "x-caffold-mcp-binding");
        let token = server["headers"][0]["value"].as_str().unwrap();
        // The Task was named before the session was asked for, so the very
        // first `initialize` on the door answers with the signed session, and
        // so does every later one while the session is open.
        for _ in 0..2 {
            let session = bindings.initialize_session(token).await.expect("a session");
            assert_eq!(
                bindings.authorize_session(token, &session).await,
                CodexMcpSessionAuthorization::Thread(id.clone())
            );
        }
        let rules = asked["_meta"]["rules"].as_str().unwrap();
        assert!(rules.contains(".caffold/plans/current/PLAN.md"));
        assert!(rules.contains("caffold__rename_current_task"));

        // Loaded again on the next bridge, the Task gets a fresh binding to
        // the same door and no naming rule: it is not new any more.
        leader.drop_bridge();
        let GrokRuntimeEvent::Unreachable { .. } = next_event(&mut events).await else {
            panic!("unreachable")
        };
        client.open_conversation(&id).await.expect("loaded again");
        let loaded = leader.wait_for("session/load").await;
        let again = loaded["mcpServers"][0]["headers"][0]["value"]
            .as_str()
            .unwrap();
        assert_ne!(again, token);
        assert!(
            bindings.initialize_session(token).await.is_none(),
            "the binding the lost bridge's session ran under is let go"
        );
        let session = bindings.initialize_session(again).await.expect("a session");
        assert_eq!(
            bindings.authorize_session(again, &session).await,
            CodexMcpSessionAuthorization::Thread(id.clone())
        );
        assert!(loaded.get("_meta").is_none());

        client.close_conversation(&id).await.unwrap();
        assert!(
            bindings.initialize_session(again).await.is_none(),
            "a closed session's binding is let go too"
        );

        // A client that knows the Task only from its binding on disk — the
        // next process — loads it with a binding of its own.
        let (cold, bridges) = GrokClient::mock(dir.path());
        let (cold_leader, cold_memory) = scripted_leader(bridges);
        cold_memory
            .lock()
            .unwrap()
            .cwds
            .insert(id.clone(), CWD.to_string());
        cold.attach_mcp(
            bindings.clone(),
            "http://127.0.0.1:1/api/grok/mcp".to_string(),
        );
        cold.watch();
        cold.open_conversation(&id).await.expect("loaded cold");
        let loaded = cold_leader.wait_for("session/load").await;
        let cold_token = loaded["mcpServers"][0]["headers"][0]["value"]
            .as_str()
            .unwrap();
        let session = bindings
            .initialize_session(cold_token)
            .await
            .expect("a session");
        assert_eq!(
            bindings.authorize_session(cold_token, &session).await,
            CodexMcpSessionAuthorization::Thread(id)
        );
        drop(leader);
    }

    fn stored(session_id: &str, event_id: &str, prompt_id: &str, update: Value) -> Value {
        json!({
            "timestamp": 1_789_197_957u64,
            "method": "session/update",
            "params": update_frame(session_id, event_id, prompt_id, update),
        })
    }

    /// The record of one turn as the leader keeps it, ended or not.
    fn stored_log(session_id: &str, prompt_id: &str, ended: bool) -> Value {
        let mut updates = vec![
            stored(
                session_id,
                "e-1",
                prompt_id,
                json!({ "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": "build it" } }),
            ),
            stored(
                session_id,
                "e-2",
                prompt_id,
                json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "working" } }),
            ),
        ];
        if ended {
            updates.push(stored(session_id, "e-3", prompt_id, json!({ "sessionUpdate": "turn_completed", "prompt_id": prompt_id, "stop_reason": "end_turn" })));
        }
        json!({ "updates": updates, "totalCount": updates.len(), "hasMore": false, "lastEventId": "e-3", "promptStarts": [0] })
    }

    async fn next_turn_ended(events: &mut broadcast::Receiver<GrokRuntimeEvent>) -> TurnState {
        loop {
            if let SessionEventKind::TurnEnded { turn } = next_session_event(events).await.kind {
                return turn;
            }
        }
    }

    /// A gap in observation, with the session running a turn of this
    /// process when the bridge went. Opening again reads the record: a turn
    /// the leader has ended is ended here from the record, one it has not is
    /// left running until the leader says otherwise, and no prompt is ever
    /// sent again on the Task's behalf.
    #[tokio::test]
    async fn after_a_gap_the_record_says_whether_the_turn_ended() {
        for ended_meanwhile in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let (client, bridges) = GrokClient::mock(dir.path());
            let (leader, memory) = scripted_leader(bridges);
            client.watch();
            let mut events = client.subscribe();
            let conversation = client
                .start_conversation(CWD, &GrokTurnOptions::default())
                .await
                .unwrap();
            let id = conversation.id.clone();
            let turn = client
                .start_turn(&id, CWD, "build it", &[], &GrokTurnOptions::default())
                .await
                .unwrap();
            leader.wait_for("session/prompt").await;
            for _ in 0..3 {
                next_session_event(&mut events).await;
            }
            leader
                .notify(
                    "session/update",
                    update_frame(&id, "e-2", &turn.id, json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "working" } })),
                )
                .await;
            next_session_event(&mut events).await;

            leader.drop_bridge();
            let GrokRuntimeEvent::Unreachable { .. } = next_event(&mut events).await else {
                panic!("unreachable")
            };
            memory
                .lock()
                .unwrap()
                .updates
                .insert(id.clone(), stored_log(&id, &turn.id, ended_meanwhile));

            client.open_conversation(&id).await.expect("opened again");
            assert_eq!(leader.requests("session/load").len(), 1);
            if ended_meanwhile {
                let ended = next_turn_ended(&mut events).await;
                assert_eq!(ended.id, turn.id);
                assert_eq!(ended.status, TurnStatus::Completed);
            } else {
                let still_running = client
                    .start_turn(&id, CWD, "next", &[], &GrokTurnOptions::default())
                    .await;
                assert!(
                    matches!(&still_running, Err(GrokError::Agent(message)) if message.contains("still running")),
                    "{still_running:?}"
                );
                leader
                    .notify(
                        "_x.ai/session_notification",
                        update_frame(&id, "e-3", &turn.id, json!({ "sessionUpdate": "turn_completed", "prompt_id": turn.id, "stop_reason": "end_turn" })),
                    )
                    .await;
                let ended = next_turn_ended(&mut events).await;
                assert_eq!(ended.id, turn.id);
            }
            assert_eq!(
                leader.requests("session/prompt").len(),
                1,
                "the interrupted prompt is not sent again"
            );
            client
                .start_turn(&id, CWD, "next", &[], &GrokTurnOptions::default())
                .await
                .expect("the Task takes the next turn");
            assert_eq!(
                client
                    .inner
                    .bindings
                    .read(&id)
                    .await
                    .unwrap()
                    .unwrap()
                    .current
                    .session_id,
                id
            );
        }
    }

    /// The leader itself was replaced under a running turn. The bridge stays;
    /// the session has to be opened again, and the prompt ends the way the
    /// leader ends it — with an error, which is a failed turn, not a gap.
    #[tokio::test]
    async fn a_replaced_leader_is_a_session_to_open_again_and_its_prompt_ends_failed() {
        let (client, leader, _dir) = client().await;
        let mut events = client.subscribe();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        let turn = client
            .start_turn(&id, CWD, "hi", &[], &GrokTurnOptions::default())
            .await
            .unwrap();
        leader.wait_for("session/prompt").await;
        for _ in 0..3 {
            next_session_event(&mut events).await;
        }
        leader
            .notify("_x.ai/leader_reconnected", json!({ "sessionId": id }))
            .await;
        let GrokRuntimeEvent::Unreachable {
            conversation_id,
            message,
        } = next_event(&mut events).await
        else {
            panic!("unreachable")
        };
        assert_eq!(conversation_id, id);
        assert!(message.contains("leader was replaced"), "{message}");
        assert!(client.watched_conversation(&id).await.is_none());

        leader
            .refuse("session/prompt", -32603, "the leader restarted")
            .await;
        let ended = next_turn_ended(&mut events).await;
        assert_eq!(ended.id, turn.id);
        assert_eq!(ended.status, TurnStatus::Failed);

        client.open_conversation(&id).await.expect("opened again");
        assert_eq!(leader.requests("session/load").len(), 1);
        assert_eq!(leader.requests("session/prompt").len(), 1);
        assert!(client.watched_conversation(&id).await.is_some());
    }

    #[tokio::test]
    async fn renaming_reaches_the_leader_under_the_tasks_session() {
        let (client, leader, _dir) = client().await;
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        client
            .rename_conversation(&conversation.id, "Grok bridge")
            .await
            .unwrap();
        let asked = leader.wait_for("_x.ai/session/rename").await;
        assert_eq!(asked["sessionId"], conversation.id);
        assert_eq!(asked["title"], "Grok bridge");
        assert!(
            client
                .rename_conversation("no-such-task", "x")
                .await
                .is_err(),
            "a Task without a binding cannot be renamed"
        );
    }

    #[tokio::test]
    async fn a_planned_switch_is_written_down_once_and_a_second_target_is_refused() {
        let (client, _leader, _dir) = client().await;
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        let target = "/Users/example/worktrees/one";

        client.plan_switch(&id, target).await.unwrap();
        let binding = client.inner.bindings.read(&id).await.unwrap().unwrap();
        let switch = binding.switch.clone().expect("a switch is planned");
        assert_eq!(switch.phase, SwitchPhase::Pending);
        assert_eq!(switch.target_cwd, target);
        assert_eq!(switch.source_session_id, id);
        assert_ne!(switch.new_session_id, id);
        assert_eq!(binding.current.cwd, CWD, "nothing has moved yet");

        // Asked again for the same place: the same plan, not a second one.
        client.plan_switch(&id, target).await.unwrap();
        let binding = client.inner.bindings.read(&id).await.unwrap().unwrap();
        assert_eq!(binding.switch, Some(switch.clone()));

        // Asked for somewhere else while moving: refused, the plan stands.
        assert!(
            client
                .plan_switch(&id, "/Users/example/worktrees/two")
                .await
                .is_err()
        );
        let binding = client.inner.bindings.read(&id).await.unwrap().unwrap();
        assert_eq!(binding.switch, Some(switch));
        assert!(client.plan_switch("no-such-task", target).await.is_err());

        // A Task asked to move to where it already runs has nothing to plan.
        let other = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        client.plan_switch(&other.id, CWD).await.unwrap();
        let binding = client
            .inner
            .bindings
            .read(&other.id)
            .await
            .unwrap()
            .unwrap();
        assert!(binding.switch.is_none());
    }
}
