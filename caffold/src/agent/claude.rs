//! Driving Claude Code, one session at a time.
//!
//! Claude has no daemon. A conversation is a `claude` process, held by the
//! runner so that it outlives the backend, and reached over one attached
//! connection that carries the conversation out and prompts in. This module is
//! what Caffold does with that connection: it starts sessions, watches what
//! they say, asks the questions the control protocol answers, and reports the
//! result in Caffold's own vocabulary.
//!
//! Three things follow from the shape of the agent and are worth knowing before
//! reading:
//!
//! **The session identifier is Caffold's to choose.** `--session-id` is
//! accepted at start, so a Task's conversation identifier, the runner's session
//! name, and the agent's own session id are one value rather than three that
//! have to be kept in step. That matters more than it looks: the agent says
//! nothing until it is spoken to, so a conversation cannot wait to be told its
//! own name.
//!
//! **A turn is bounded by what Caffold sent and what the agent answered.** The
//! agent does not name turns, so Caffold does: a turn opens when a prompt is
//! written and closes on the `result` frame that answers it.
//!
//! **Nothing here is history.** What a session has said is kept for as long as
//! the session is watched, because that is what a viewer arriving mid-turn
//! needs. Reading a conversation back after the backend has forgotten it means
//! reading the agent's own transcript, which is the next piece of work and not
//! this one.

pub(crate) mod protocol;
pub(crate) mod runner;
pub(crate) mod translate;

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, broadcast, oneshot};

use self::protocol::{
    BASE_ARGUMENTS, ControlRequestFrame, MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION, MessageFrame,
    ResultFrame, StreamFrame, SystemFrame,
};
use self::runner::{RunnerClient, RunnerEvent, RunnerSession, SessionFrames};
use self::translate::{ToolCalls, message_items};
use crate::agent::codex::CodexThreadError;
use crate::agent::driver::{
    ClaudeConversation, Driver, ModelOption, PermissionModeOption, PermissionModes, TurnOptions,
    TurnRejected, bounded,
};
use crate::agent::{
    ActivityStatus, ApprovalDecision, ApprovalDetail, ApprovalRequest, Conversation,
    ConversationItem, ItemKind, MessageContent, SessionEvent, SessionEventKind, ThreadActiveFlag,
    ThreadStatus, TokenCount, TokenUsage, Turn, TurnStatus,
};
use caffold_claude_runner::protocol::SessionState as RunnerSessionState;

#[cfg(test)]
pub(crate) use self::runner::MockRunnerHandle;

/// How long to wait for the agent to answer something asked of it.
///
/// Every one of these blocks a request a person is waiting on, and an agent
/// that has stopped answering must surface as a failure rather than as a page
/// that never finishes loading.
const ANSWER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// Why an operation on a Claude session did not happen.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudeError {
    /// The runner could not be started, reached, or asked.
    #[error("The Claude runner is unavailable: {0}")]
    Runner(String),
    /// The agent said something this release cannot read.
    #[error("Claude protocol error: {0}")]
    Protocol(String),
    /// The agent answered, and the answer was a refusal.
    #[error("Claude refused: {0}")]
    Agent(String),
    #[error("Caffold is not watching Claude conversation {0}.")]
    NotWatching(String),
}

/// The agent Caffold drives when a Task belongs to Claude.
#[derive(Clone)]
pub(crate) struct ClaudeClient {
    inner: Arc<ClaudeClientInner>,
}

struct ClaudeClientInner {
    runner: RunnerClient,
    sessions: AsyncMutex<HashMap<String, Arc<Session>>>,
    events: broadcast::Sender<ClaudeRuntimeEvent>,
    /// The model list, once asked for. Asking costs a process start, and the
    /// answer does not change while the installation does not.
    models: AsyncMutex<Option<Vec<ModelOption>>>,
}

/// Something a Claude session did that the rest of Caffold acts on.
#[derive(Debug, Clone)]
pub(crate) enum ClaudeRuntimeEvent {
    /// The conversation moved, in the vocabulary every agent reports in.
    Session(SessionEvent),
    /// The agent is blocked until someone answers.
    Approval {
        conversation_id: String,
        request: Box<ApprovalRequest>,
    },
    /// Something worth writing down that nothing acts on.
    Diagnostic { message: String },
}

/// One session, and everything Caffold knows about it.
struct Session {
    id: String,
    cwd: String,

    frames: AsyncMutex<SessionFrames>,
    state: AsyncMutex<SessionState>,
    /// Control requests Caffold has sent and is waiting on.
    pending: AsyncMutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
    next_control_id: AtomicU64,
}

#[derive(Default)]
struct SessionState {
    /// What the agent said about itself when it started.
    introduction: Option<Introduction>,
    /// Tool calls waiting on their results.
    calls: ToolCalls,
    /// The turn Caffold opened and the agent has not answered.
    active_turn: Option<String>,
    /// The turns this session has run while Caffold watched.
    turns: Vec<Turn>,
    /// Tool calls a person refused.
    ///
    /// The agent reports a refusal as a failed tool result, which is what it is
    /// from the agent's side. Caffold knows better, because Caffold is what
    /// refused, and a conversation that draws a refusal as a failure misreports
    /// what happened.
    declined: std::collections::HashSet<String>,
    /// Approvals the agent is blocked on, by the identifier it will answer to.
    pending_approvals: HashMap<String, PendingApproval>,
    /// The agent exited, and this session can do nothing more.
    ended: bool,
    /// The model this session runs, in the words a person chose it by.
    ///
    /// The agent answers with what it resolved that to — `sonnet` becomes
    /// `claude-sonnet-5` — which is the same model under a name the list a
    /// person picked from does not contain, so the choice is what is kept.
    /// Absent for a session Caffold resumed rather than started: what the Task
    /// last ran under is the store's to remember.
    model: Option<String>,
    /// The permission mode this session runs under, as the agent names it.
    permission_mode: Option<String>,
    /// The depth this session works at, in the agent's own words.
    effort: Option<String>,
    /// Whether Caffold has asked this session to work at its faster tier.
    ///
    /// Asking is not getting: the agent answers with the state it actually
    /// reached, and an installation whose account has no extra usage stays at
    /// its ordinary speed. What was asked is kept so the same request is not
    /// made again every turn.
    fast_mode_requested: bool,
    /// Waiting on a turn Caffold asked for but is not showing.
    ///
    /// A command the agent answers — changing the depth is one — runs as a turn
    /// of its own. Opening the person's turn before that one has ended would
    /// let its answer close theirs.
    quiet_turn: Option<oneshot::Sender<()>>,
    /// When Caffold opened this session, and when it last saw it move.
    ///
    /// The agent reports neither. It is asked to run a conversation, not to
    /// keep a record of one, so what a Task list orders by is what Caffold
    /// watched — which is honest, and the only answer there is.
    opened_at_ms: u64,
    moved_at_ms: u64,
}

/// One question the agent is blocked on, and what answering it needs.
#[derive(Debug, Clone)]
struct PendingApproval {
    /// The grant the agent proposed for allowing this always. Caffold keeps it
    /// rather than reading it, so that answering hands back what the harness
    /// asked for rather than a rule Caffold invented.
    suggestions: Value,
    /// The tool call this interrupts, so that refusing it can be drawn as a
    /// refusal rather than as a failure.
    item_id: Option<String>,
}

/// What `system/init` said, which is the agent describing itself.
#[derive(Debug, Clone, Default)]
struct Introduction {
    session_id: Option<String>,
    permission_mode: Option<String>,
    fast_mode: bool,
    /// Why the agent is not working at its faster tier, when it says.
    fast_mode_blocked: Option<String>,
    cwd: Option<String>,
    version: Option<String>,
    capabilities: Vec<String>,
}

impl ClaudeClient {
    /// This agent, driving the Task that works in `cwd`.
    ///
    /// A Claude session is a process with a working directory, and resuming one
    /// starts a new process wherever it is told to, so the driver carries where
    /// the Task works.
    pub(crate) fn driver(&self, cwd: impl Into<String>) -> Driver {
        Driver::Claude(ClaudeConversation {
            client: self.clone(),
            cwd: cwd.into(),
        })
    }

    /// The agent as reached through the runner in this data directory.
    pub(crate) fn in_data_dir(data_dir: &std::path::Path) -> Self {
        Self::with_runner(RunnerClient::in_data_dir(data_dir))
    }

    /// The agent as reached through a stand-in runner, for a test.
    #[cfg(test)]
    pub(crate) fn mock() -> (Self, MockRunnerHandle) {
        let (runner, handle) = RunnerClient::mock();
        (Self::with_runner(runner), handle)
    }

    fn with_runner(runner: RunnerClient) -> Self {
        let (events, _) = broadcast::channel(256);
        Self {
            inner: Arc::new(ClaudeClientInner {
                runner,
                sessions: AsyncMutex::new(HashMap::new()),
                events,
                models: AsyncMutex::new(None),
            }),
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ClaudeRuntimeEvent> {
        self.inner.events.subscribe()
    }

    // -----------------------------------------------------------------------
    // Sessions
    // -----------------------------------------------------------------------

    /// Begin a conversation, and watch it.
    ///
    /// The identifier is minted here and handed to the agent, so that a Task,
    /// a runner session, and a Claude session are one name rather than three.
    ///
    /// Nothing is waited for. Measured against CLI 2.1.236: the agent says
    /// nothing at all until it is given something to do — `system/init` follows
    /// the first prompt rather than preceding it — so a conversation is open the
    /// moment its session is attached, and what the agent says about itself
    /// arrives later as a settings report.
    pub(crate) async fn start_conversation(
        &self,
        cwd: &str,
        options: &ClaudeTurnOptions,
    ) -> Result<Conversation, ClaudeError> {
        let id = uuid::Uuid::new_v4().to_string();
        let session = self
            .open_session(&id, cwd, SessionStart::Fresh, options)
            .await?;
        Ok(self.conversation_of(&session).await)
    }

    /// Open a conversation Caffold already knows the identifier of.
    ///
    /// A session the runner is still holding is taken over; one it is not is
    /// resumed, which is how the agent restores a conversation it wrote to its
    /// own transcript.
    pub(crate) async fn open_conversation(
        &self,
        conversation_id: &str,
        cwd: &str,
        options: &ClaudeTurnOptions,
    ) -> Result<Conversation, ClaudeError> {
        if let Some(session) = self.session(conversation_id).await {
            return Ok(self.conversation_of(&session).await);
        }
        let session = self
            .open_session(conversation_id, cwd, SessionStart::Resume, options)
            .await?;
        Ok(self.conversation_of(&session).await)
    }

    /// Let go of a conversation. Nothing happens.
    ///
    /// A Codex subscription is nearly free to drop and to take again, so
    /// Caffold drops it when the last viewer leaves. A Claude session is a
    /// process on one attached connection: letting go means detaching, and
    /// taking it back means attaching again, which the runner refuses while the
    /// old connection is still closing. So the session is held for as long as
    /// it lives, and [`ClaudeClient::close_conversation`] is what ends it.
    ///
    /// The cost of holding is a process per Task a person has opened, which is
    /// the idle-session question recorded against this integration and not yet
    /// answered.
    pub(crate) async fn stop_watching(&self, _conversation_id: &str) -> Result<(), ClaudeError> {
        Ok(())
    }

    /// End a conversation and the process behind it.
    pub(crate) async fn close_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<(), ClaudeError> {
        self.inner.sessions.lock().await.remove(conversation_id);
        self.inner.runner.close(conversation_id).await
    }

    async fn session(&self, conversation_id: &str) -> Option<Arc<Session>> {
        self.inner
            .sessions
            .lock()
            .await
            .get(conversation_id)
            .cloned()
    }

    async fn require_session(&self, conversation_id: &str) -> Result<Arc<Session>, ClaudeError> {
        self.session(conversation_id)
            .await
            .ok_or_else(|| ClaudeError::NotWatching(conversation_id.to_string()))
    }

    async fn open_session(
        &self,
        id: &str,
        cwd: &str,
        start: SessionStart,
        options: &ClaudeTurnOptions,
    ) -> Result<Arc<Session>, ClaudeError> {
        let spawn = caffold_claude_runner::protocol::SpawnRequest {
            argv: session_argv(id, start, options),
            cwd: cwd.to_string(),
            env: Default::default(),
        };
        let RunnerSession {
            info,
            frames,
            events,
        } = self.inner.runner.open(id, spawn).await?;
        if matches!(info.state, RunnerSessionState::Exited) {
            // The runner keeps an exited session listed so a client that
            // reconnects can see that it happened. Watching one would be
            // watching a process that is already gone.
            return Err(ClaudeError::Runner(format!(
                "the Claude session for {id} has already exited"
            )));
        }

        let session = Arc::new(Session {
            id: id.to_string(),
            cwd: cwd.to_string(),
            frames: AsyncMutex::new(frames),
            state: AsyncMutex::new(SessionState {
                opened_at_ms: now_ms(),
                moved_at_ms: now_ms(),
                model: options.model.clone(),
                permission_mode: options.permission_mode.clone(),
                effort: options.effort.clone(),
                // Nothing was asked at start: there is no argument for speed,
                // only a request a running session answers. The first turn
                // asks, if speed is wanted.
                fast_mode_requested: false,
                ..SessionState::default()
            }),
            pending: AsyncMutex::new(HashMap::new()),
            next_control_id: AtomicU64::new(1),
        });
        self.inner
            .sessions
            .lock()
            .await
            .insert(id.to_string(), session.clone());
        self.spawn_reader(session.clone(), events);
        Ok(session)
    }

    /// Read one session for as long as it says anything.
    fn spawn_reader(&self, session: Arc<Session>, mut events: runner::SessionEvents) {
        let client = self.clone();
        tokio::spawn(async move {
            while let Some(event) = events.next().await {
                match event {
                    RunnerEvent::Frame(line) => client.handle_line(&session, &line).await,
                    RunnerEvent::Stderr(line) => {
                        client.publish(ClaudeRuntimeEvent::Diagnostic {
                            message: format!("claude {}: {line}", session.id),
                        });
                    }
                    RunnerEvent::Exit(code) => {
                        client.handle_exit(&session, code).await;
                        break;
                    }
                }
            }
            // A session that stops speaking is no longer one Caffold can drive,
            // whether it exited or the connection went away.
            client.inner.sessions.lock().await.remove(&session.id);
        });
    }

    fn publish(&self, event: ClaudeRuntimeEvent) {
        let _ = self.inner.events.send(event);
    }

    fn report(&self, conversation_id: &str, kind: SessionEventKind) {
        self.publish(ClaudeRuntimeEvent::Session(SessionEvent {
            thread_id: conversation_id.to_string(),
            kind,
        }));
    }

    // -----------------------------------------------------------------------
    // Turns
    // -----------------------------------------------------------------------

    /// Begin a turn, and report it as begun.
    ///
    /// The identifier is Caffold's because the agent does not name turns. It is
    /// what every item of this turn is reported under, and what stops it.
    pub(crate) async fn start_turn(
        &self,
        conversation_id: &str,
        prompt: &str,
        images: &[String],
        options: &ClaudeTurnOptions,
    ) -> Result<Turn, ClaudeError> {
        let session = self.require_session(conversation_id).await?;
        self.apply_settings(&session, options).await?;
        let turn_id = uuid::Uuid::new_v4().to_string();
        let started_at_ms = now_ms();

        let prompt_item = ConversationItem {
            id: format!("{turn_id}:prompt"),
            status: ActivityStatus::Completed,
            kind: ItemKind::UserMessage {
                text: prompt.to_string(),
                content: vec![MessageContent::Text {
                    text: prompt.to_string(),
                }],
            },
        };
        let turn = Turn {
            id: turn_id.clone(),
            status: TurnStatus::InProgress,
            started_at_ms: Some(started_at_ms),
            completed_at_ms: None,
            items: vec![prompt_item.clone()],
        };
        {
            let mut state = session.state.lock().await;
            // A turn already running would be lost: its items would go on
            // arriving under an identifier nothing reads any more, and it would
            // spin for as long as the conversation is shown. Adding to a
            // running turn is steering, which is a different thing to ask for.
            if let Some(running) = state.active_turn.as_deref() {
                return Err(ClaudeError::Protocol(format!(
                    "turn {running} is still running on conversation {conversation_id}"
                )));
            }
            state.active_turn = Some(turn_id.clone());
            state.moved_at_ms = started_at_ms;
            state.turns.push(turn.clone());
        }

        session.send(protocol::user_message(prompt, images)).await?;

        self.report(
            conversation_id,
            SessionEventKind::TurnStarted { turn: turn.clone() },
        );
        self.report(
            conversation_id,
            SessionEventKind::ItemChanged {
                turn_id: turn_id.clone(),
                item: prompt_item,
                at_ms: started_at_ms,
            },
        );
        self.report(
            conversation_id,
            SessionEventKind::StatusChanged {
                status: ThreadStatus::Active {
                    active_flags: Vec::new(),
                },
            },
        );
        Ok(turn)
    }

    /// Bring the session to the settings a person has chosen.
    ///
    /// A Claude session takes its settings as arguments when it starts, so a
    /// choice made afterwards has to reach the running agent — otherwise the
    /// composer would show one thing and the conversation would run another.
    ///
    /// Most are control requests, which answer and are done with. Depth is a
    /// command the agent runs, so it takes a turn of its own, and that turn has
    /// to end before the person's begins. There is always room for it: settings
    /// are locked while a turn is running, so a choice can only have been made
    /// between turns.
    ///
    /// Speed is asked for rather than set. The agent reports what it actually
    /// reached in every `system/init`, and an installation whose account has no
    /// extra usage stays at its ordinary speed however often it is asked.
    async fn apply_settings(
        &self,
        session: &Arc<Session>,
        options: &ClaudeTurnOptions,
    ) -> Result<(), ClaudeError> {
        let (model_change, mode_change, effort_change, fast_mode_change) = {
            let state = session.state.lock().await;
            (
                changed(&state.model, &options.model),
                changed(&state.permission_mode, &options.permission_mode),
                changed(&state.effort, &options.effort),
                (state.fast_mode_requested != options.fast_mode).then_some(options.fast_mode),
            )
        };
        let changed_anything = model_change.is_some()
            || mode_change.is_some()
            || effort_change.is_some()
            || fast_mode_change.is_some();
        if let Some(model) = model_change {
            session
                .control(json!({ "subtype": "set_model", "model": model }))
                .await?;
            session.state.lock().await.model = Some(model);
        }
        if let Some(mode) = mode_change {
            session
                .control(json!({ "subtype": "set_permission_mode", "mode": mode }))
                .await?;
            session.state.lock().await.permission_mode = Some(mode);
        }
        if let Some(effort) = effort_change {
            self.ask_quietly(session, &format!("/effort {effort}"))
                .await?;
            session.state.lock().await.effort = Some(effort);
        }
        if let Some(fast_mode) = fast_mode_change {
            session
                .control(json!({
                    "subtype": "apply_flag_settings",
                    "settings": { "fastMode": fast_mode },
                }))
                .await?;
            session.state.lock().await.fast_mode_requested = fast_mode;
        }
        if changed_anything {
            let settings = self.settings_of_session(session).await;
            self.report(&session.id, SessionEventKind::SettingsChanged { settings });
        }
        Ok(())
    }

    /// Ask the agent something the conversation should not show.
    ///
    /// The answer is a turn like any other, and it is waited for: what follows
    /// is the person's turn, and a `result` arriving late would close theirs
    /// instead of this one.
    async fn ask_quietly(&self, session: &Arc<Session>, text: &str) -> Result<(), ClaudeError> {
        let (sender, receiver) = oneshot::channel();
        session.state.lock().await.quiet_turn = Some(sender);
        if let Err(error) = session.send(protocol::user_message(text, &[])).await {
            // Left standing, it would swallow the answer to the next turn.
            session.state.lock().await.quiet_turn = None;
            return Err(error);
        }
        match tokio::time::timeout(ANSWER_TIMEOUT, receiver).await {
            Ok(_) => Ok(()),
            Err(_) => {
                session.state.lock().await.quiet_turn = None;
                Err(ClaudeError::Protocol(format!(
                    "claude did not answer {text} within {} seconds",
                    ANSWER_TIMEOUT.as_secs()
                )))
            }
        }
    }

    /// Add to a turn already running.
    ///
    /// The agent takes this at its next tool-call boundary rather than at once,
    /// so this reports that the message was accepted, never that it was read.
    pub(crate) async fn steer_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
        prompt: &str,
        images: &[String],
    ) -> Result<(), ClaudeError> {
        let session = self.require_session(conversation_id).await?;
        session.send(protocol::user_message(prompt, images)).await?;

        let item = ConversationItem {
            id: format!("{turn_id}:steer:{}", now_ms()),
            status: ActivityStatus::Completed,
            kind: ItemKind::UserMessage {
                text: prompt.to_string(),
                content: vec![MessageContent::Text {
                    text: prompt.to_string(),
                }],
            },
        };
        self.record_item(&session, turn_id, item.clone()).await;
        self.report(
            conversation_id,
            SessionEventKind::ItemChanged {
                turn_id: turn_id.to_string(),
                item,
                at_ms: now_ms(),
            },
        );
        Ok(())
    }

    /// Stop a turn where it stands.
    pub(crate) async fn interrupt_turn(&self, conversation_id: &str) -> Result<(), ClaudeError> {
        let session = self.require_session(conversation_id).await?;
        session
            .control(json!({ "subtype": "interrupt" }))
            .await
            .map(|_| ())
    }

    // -----------------------------------------------------------------------
    // Settings
    // -----------------------------------------------------------------------

    /// The models this installation offers.
    ///
    /// The agent answers this over the control protocol, which means a process.
    /// There is no daemon to ask, so one is started for the question and the
    /// answer is kept.
    pub(crate) async fn models(&self) -> Result<Vec<ModelOption>, ClaudeError> {
        if let Some(cached) = self.inner.models.lock().await.clone() {
            return Ok(cached);
        }
        let answer = ask_one_off(json!({ "subtype": "list_models" })).await?;
        let models = model_options(&answer);
        *self.inner.models.lock().await = Some(models.clone());
        Ok(models)
    }

    /// Whether the model a person chose can decide permissions for itself.
    ///
    /// Read from the list the agent published. An installation whose list could
    /// not be read offers no such model, so the mode is withheld rather than
    /// offered and refused at the moment a turn starts.
    async fn model_supports_auto_mode(&self, model: Option<&str>) -> bool {
        let Some(model) = model else {
            return false;
        };
        self.models()
            .await
            .unwrap_or_default()
            .iter()
            .any(|offered| offered.model == model && offered.supports_auto_mode)
    }

    /// Answer the model list from here rather than from a process.
    ///
    /// The cache is the real field, so a test that fills it exercises the same
    /// path a second call in production takes.
    #[cfg(test)]
    pub(crate) async fn offer_models(&self, models: Vec<ModelOption>) {
        *self.inner.models.lock().await = Some(models);
    }

    /// The ways a person can let this agent work, with this model.
    ///
    /// Named here rather than asked, because the agent does not offer a list:
    /// the modes are a fixed part of its permission model, and what each one
    /// gives up is knowledge that belongs to whoever drives it.
    ///
    /// All but one are fixed. Letting the model decide for itself is something
    /// only some models can do, so it is offered when the chosen one can and
    /// withheld — visibly — when it cannot. A model this installation does not
    /// list is treated as unable, which is the safe direction: the mode that
    /// asks a person is the one that stays.
    ///
    /// That mode is also what this agent works under by default, the way it
    /// does when a person runs it themselves. A model that cannot falls back to
    /// asking, because a default nobody can use is not a default.
    pub(crate) async fn permission_modes(&self, model: Option<&str>) -> PermissionModes {
        let auto = self.model_supports_auto_mode(model).await;
        PermissionModes {
            default_mode: if auto { "auto" } else { "default" }.to_string(),
            options: vec![
                {
                    let mut mode = option(
                        "auto",
                        "Automatic",
                        "The model decides what needs asking about, and asks only for that.",
                        false,
                    );
                    mode.allowed = auto;
                    mode.unavailable_reason = (!auto)
                        .then(|| "This model cannot decide permissions for itself.".to_string());
                    mode
                },
                option(
                    "default",
                    "Ask each time",
                    "Stops for permission before every tool call it is not sure about.",
                    false,
                ),
                option(
                    "acceptEdits",
                    "Accept edits",
                    "Edits files without asking. Still stops for commands and anything reaching outside the workspace.",
                    false,
                ),
                option(
                    "plan",
                    "Plan only",
                    "Reads and reasons, and changes nothing until you accept a plan.",
                    false,
                ),
                option(
                    "bypassPermissions",
                    "Full access",
                    "Never asks. Every tool call runs, including ones that reach outside the workspace.",
                    true,
                ),
            ],
        }
    }

    // -----------------------------------------------------------------------
    // Reading a session
    // -----------------------------------------------------------------------

    /// What the agent says its settings for this conversation are, with the
    /// model and mode named the way they were chosen.
    async fn settings_of_session(&self, session: &Arc<Session>) -> BTreeMap<String, Value> {
        let state = session.state.lock().await;
        let introduction = state.introduction.clone().unwrap_or_default();
        settings_map(&introduction, &state)
    }

    async fn conversation_of(&self, session: &Arc<Session>) -> Conversation {
        let state = session.state.lock().await;
        let introduction = state.introduction.clone().unwrap_or_default();
        Conversation {
            id: session.id.clone(),
            title: None,
            preview: state
                .turns
                .first()
                .and_then(|turn| turn.items.first())
                .map(preview_of)
                .unwrap_or_default(),
            status: status_of(&state),
            cwd: introduction
                .cwd
                .clone()
                .unwrap_or_else(|| session.cwd.clone()),
            transcript_path: None,
            created_at_ms: state.opened_at_ms,
            updated_at_ms: state.moved_at_ms,
            recency_at_ms: Some(state.moved_at_ms),
            turns: state.turns.clone(),
        }
    }

    /// What the agent says its settings for this conversation are, in its own
    /// words.
    pub(crate) async fn settings_of(&self, conversation_id: &str) -> BTreeMap<String, Value> {
        let Some(session) = self.session(conversation_id).await else {
            return BTreeMap::new();
        };
        self.settings_of_session(&session).await
    }

    // -----------------------------------------------------------------------
    // Approvals
    // -----------------------------------------------------------------------

    /// Answer a question the agent is blocked on.
    pub(crate) async fn resolve_approval(
        &self,
        conversation_id: &str,
        approval_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ClaudeError> {
        let session = self.require_session(conversation_id).await?;
        let (suggestions, declined_item) = {
            let mut state = session.state.lock().await;
            let pending = state
                .pending_approvals
                .remove(approval_id)
                .ok_or_else(|| ClaudeError::NotWatching(conversation_id.to_string()))?;
            (pending.suggestions, pending.item_id)
        };
        session
            .send(protocol::control_response(
                approval_id,
                approval_answer(decision, suggestions),
            ))
            .await?;
        if matches!(
            decision,
            ApprovalDecision::Deny | ApprovalDecision::DenyAndStop
        ) && let Some(item_id) = declined_item
        {
            session.state.lock().await.declined.insert(item_id);
        }
        self.report_status(&session).await;
        if matches!(decision, ApprovalDecision::DenyAndStop) {
            self.interrupt_turn(conversation_id).await?;
        }
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Reading what the agent said
    // -----------------------------------------------------------------------

    async fn handle_line(&self, session: &Arc<Session>, line: &str) {
        let frame = match serde_json::from_str::<StreamFrame>(line) {
            Ok(frame) => frame,
            Err(error) => {
                self.publish(ClaudeRuntimeEvent::Diagnostic {
                    message: format!("unreadable Claude frame on {}: {error}", session.id),
                });
                return;
            }
        };
        match frame {
            StreamFrame::System(system) => self.handle_system(session, system).await,
            StreamFrame::Assistant(message) => self.handle_message(session, message).await,
            StreamFrame::User(message) => self.handle_message(session, message).await,
            StreamFrame::Result(result) => self.handle_result(session, result).await,
            StreamFrame::ControlRequest(request) => {
                self.handle_control_request(session, request).await;
            }
            StreamFrame::ControlResponse(response) => {
                let body = response.response;
                let request_id = body.request_id.clone();
                if let Some(waiting) = session.pending.lock().await.remove(&request_id) {
                    let _ = waiting.send(body.into_result());
                }
            }
            StreamFrame::Other => {}
        }
    }

    async fn handle_system(&self, session: &Arc<Session>, system: SystemFrame) {
        if system.subtype.as_deref() != Some("init") {
            return;
        }
        let introduction = Introduction {
            session_id: system.session_id,
            permission_mode: system.permission_mode,
            fast_mode: system.fast_mode_state.as_deref() == Some("on"),
            fast_mode_blocked: system.fast_mode_disabled_reason,
            cwd: system.cwd,
            version: system.claude_code_version,
            capabilities: system.capabilities,
        };
        {
            let mut state = session.state.lock().await;
            state.introduction = Some(introduction.clone());
        }
        for message in introduction_complaints(&session.id, &introduction) {
            self.publish(ClaudeRuntimeEvent::Diagnostic { message });
        }
        let settings = self.settings_of_session(session).await;
        self.report(&session.id, SessionEventKind::SettingsChanged { settings });
    }

    async fn handle_message(&self, session: &Arc<Session>, frame: MessageFrame) {
        // A subagent's messages belong to the tool call that started it, which
        // the conversation already shows. Folding them in would interleave two
        // conversations under one turn.
        if frame.parent_tool_use_id.is_some() {
            return;
        }
        // The frame, not the message. One assistant message is streamed as
        // several frames — thinking in one, its answer in the next — all
        // carrying the same message identifier and each numbering its own
        // blocks from zero. Anchoring on the message would make the answer
        // overwrite the thinking that preceded it. The transcript writes one
        // row per message and identifies rows the same way, so the frame
        // identifier is what both readers can agree on.
        let anchor = frame
            .uuid
            .clone()
            .or_else(|| frame.message.id.clone())
            .unwrap_or_else(|| format!("{}:{}", session.id, now_ms()));
        let at_ms = frame
            .timestamp
            .as_deref()
            .and_then(parse_timestamp_ms)
            .unwrap_or_else(now_ms);

        let (turn_id, items) = {
            let mut state = session.state.lock().await;
            let Some(turn_id) = state.active_turn.clone() else {
                // Work with no turn open belongs to nothing Caffold can show.
                return;
            };
            let mut items = message_items(&frame.message, &anchor, &mut state.calls);
            for item in &mut items {
                if state.declined.remove(&item.id) {
                    item.status = ActivityStatus::Declined;
                }
            }
            (turn_id, items)
        };
        for item in items {
            self.record_item(session, &turn_id, item.clone()).await;
            self.report(
                &session.id,
                SessionEventKind::ItemChanged {
                    turn_id: turn_id.clone(),
                    item: item.clone(),
                    at_ms,
                },
            );
            if matches!(item.kind, ItemKind::FileChange { .. }) {
                self.report(&session.id, SessionEventKind::DiffChanged);
            }
        }
    }

    async fn handle_result(&self, session: &Arc<Session>, result: ResultFrame) {
        let status = if result.was_interrupted() {
            TurnStatus::Interrupted
        } else if result.is_error {
            TurnStatus::Failed
        } else {
            TurnStatus::Completed
        };
        let completed_at_ms = now_ms();

        let (turn, abandoned) = {
            let mut state = session.state.lock().await;
            if let Some(waiting) = state.quiet_turn.take() {
                // Something Caffold asked for on its own account, answered.
                let _ = waiting.send(());
                return;
            }
            let Some(turn_id) = state.active_turn.take() else {
                return;
            };
            // Whatever the agent left open, it will not answer now.
            let abandoned = state.calls.abandon(match status {
                TurnStatus::Completed => ActivityStatus::Completed,
                _ => ActivityStatus::Failed,
            });
            state.pending_approvals.clear();
            state.declined.clear();
            let Some(turn) = state.turns.iter_mut().find(|turn| turn.id == turn_id) else {
                return;
            };
            for item in &abandoned {
                replace_item(&mut turn.items, item.clone());
            }
            turn.status = status;
            turn.completed_at_ms = Some(completed_at_ms);
            let turn = turn.clone();
            state.moved_at_ms = completed_at_ms;
            (turn, abandoned)
        };

        for item in abandoned {
            self.report(
                &session.id,
                SessionEventKind::ItemChanged {
                    turn_id: turn.id.clone(),
                    item,
                    at_ms: completed_at_ms,
                },
            );
        }
        if let Some(usage) = token_usage(&result) {
            self.report(
                &session.id,
                SessionEventKind::UsageReported {
                    turn_id: turn.id.clone(),
                    usage,
                },
            );
        }
        self.report(&session.id, SessionEventKind::TurnEnded { turn });
        self.report_status(session).await;
    }

    async fn handle_control_request(&self, session: &Arc<Session>, frame: ControlRequestFrame) {
        if frame.request.subtype.as_deref() != Some("can_use_tool") {
            // Hooks and in-process tools are asked for over this channel too.
            // Caffold registers neither, so anything else is refused rather
            // than left to block the turn forever.
            let _ = session
                .send(protocol::control_response(&frame.request_id, json!({})))
                .await;
            return;
        }
        let turn_id = {
            let mut state = session.state.lock().await;
            state.pending_approvals.insert(
                frame.request_id.clone(),
                PendingApproval {
                    suggestions: frame.request.permission_suggestions.clone(),
                    item_id: frame.request.tool_use_id.clone(),
                },
            );
            state.active_turn.clone()
        };
        let request = approval_request(&frame, turn_id);
        self.publish(ClaudeRuntimeEvent::Approval {
            conversation_id: session.id.clone(),
            request: Box::new(request),
        });
        self.report_status(session).await;
    }

    async fn handle_exit(&self, session: &Arc<Session>, code: Option<i32>) {
        {
            let mut state = session.state.lock().await;
            state.ended = true;
            state.active_turn = None;
        }
        self.publish(ClaudeRuntimeEvent::Diagnostic {
            message: match code {
                Some(code) => format!("claude {} exited with status {code}", session.id),
                None => format!("claude {} exited", session.id),
            },
        });
        self.report(
            &session.id,
            SessionEventKind::StatusChanged {
                status: ThreadStatus::Idle,
            },
        );
    }

    async fn record_item(&self, session: &Arc<Session>, turn_id: &str, item: ConversationItem) {
        let mut state = session.state.lock().await;
        state.moved_at_ms = now_ms();
        if let Some(turn) = state.turns.iter_mut().find(|turn| turn.id == turn_id) {
            replace_item(&mut turn.items, item);
        }
    }

    async fn report_status(&self, session: &Arc<Session>) {
        let status = status_of(&*session.state.lock().await);
        self.report(&session.id, SessionEventKind::StatusChanged { status });
    }
}

impl Session {
    async fn send(&self, frame: Value) -> Result<(), ClaudeError> {
        self.frames.lock().await.send(frame).await
    }

    /// Ask the agent something over the control protocol, and wait.
    async fn control(&self, body: Value) -> Result<Value, ClaudeError> {
        let request_id = format!(
            "caffold-{}",
            self.next_control_id.fetch_add(1, Ordering::Relaxed)
        );
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(request_id.clone(), sender);
        self.send(protocol::control_request(&request_id, body))
            .await?;
        match tokio::time::timeout(ANSWER_TIMEOUT, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(ClaudeError::Agent(message)),
            Ok(Err(_)) => Err(ClaudeError::Runner(
                "the Claude session ended before answering".to_string(),
            )),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err(ClaudeError::Protocol(format!(
                    "claude did not answer within {} seconds",
                    ANSWER_TIMEOUT.as_secs()
                )))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Where Claude stops
// ---------------------------------------------------------------------------

/// What Claude will accept for a turn.
///
/// Caffold names a model, a depth, and a speed. Which model answers to that
/// name, whether it works at that depth, and whether it has a faster tier are
/// all things the agent itself lists, so they are asked rather than assumed —
/// and asked before anything is created, because a session started under a
/// model that does not exist is a session left behind.
pub(crate) async fn claude_turn_options(
    client: &ClaudeClient,
    options: &TurnOptions,
) -> Result<ClaudeTurnOptions, TurnRejected> {
    let model = bounded(options.model.as_deref(), 128).ok_or(TurnRejected::Model)?;
    let effort = bounded(options.effort.as_deref(), 32).ok_or(TurnRejected::Effort)?;
    let permission_mode = bounded(options.permission_mode.as_deref(), 64).ok_or(
        // A mode is offered by the agent and carried back verbatim, so one that
        // could not have come from that list is a bad choice rather than a
        // depth the model lacks.
        TurnRejected::Model,
    )?;
    if model.is_none() && effort.is_none() && !options.fast_mode {
        return Ok(ClaudeTurnOptions {
            model,
            effort,
            fast_mode: false,
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
    Ok(ClaudeTurnOptions {
        model,
        effort,
        // A model without a faster tier answers a request for speed with its
        // ordinary one, and the person is told what they got.
        fast_mode: options.fast_mode && selected.supports_fast_mode,
        permission_mode,
    })
}

/// A Claude failure, as the rest of the application reads failures.
///
/// The vocabulary is still Codex's, so a Claude failure arrives under the one
/// variant that writes its own message. Which agent failed is already plain
/// from the message, because Claude wrote it.
impl From<ClaudeError> for CodexThreadError {
    fn from(error: ClaudeError) -> Self {
        match error {
            ClaudeError::Runner(_) | ClaudeError::NotWatching(_) => {
                Self::AgentUnavailable(error.to_string())
            }
            ClaudeError::Protocol(_) | ClaudeError::Agent(_) => Self::Agent(error.to_string()),
        }
    }
}

impl From<ClaudeError> for TurnRejected {
    fn from(error: ClaudeError) -> Self {
        Self::Unavailable(error.into())
    }
}

/// How a session is being started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionStart {
    /// A conversation that does not exist yet.
    Fresh,
    /// One the agent wrote to its own transcript and can pick up.
    Resume,
}

/// What a person chose, in the agent's own words.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ClaudeTurnOptions {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) fast_mode: bool,
    pub(crate) permission_mode: Option<String>,
}

/// The command that starts one session.
fn session_argv(id: &str, start: SessionStart, options: &ClaudeTurnOptions) -> Vec<String> {
    let mut argv = vec!["claude".to_string()];
    argv.extend(BASE_ARGUMENTS.iter().map(|argument| argument.to_string()));
    match start {
        SessionStart::Fresh => {
            argv.push("--session-id".to_string());
            argv.push(id.to_string());
        }
        SessionStart::Resume => {
            argv.push("--resume".to_string());
            argv.push(id.to_string());
        }
    }
    if let Some(model) = &options.model {
        argv.push("--model".to_string());
        argv.push(model.clone());
    }
    if let Some(effort) = &options.effort {
        argv.push("--effort".to_string());
        argv.push(effort.clone());
    }
    if let Some(mode) = &options.permission_mode {
        argv.push("--permission-mode".to_string());
        argv.push(mode.clone());
    }
    argv
}

fn option(mode: &str, label: &str, description: &str, dangerous: bool) -> PermissionModeOption {
    PermissionModeOption {
        mode: mode.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        allowed: true,
        unavailable_reason: None,
        dangerous,
    }
}

/// What is wrong with the agent that just introduced itself.
///
/// Both of these are the kind of failure that otherwise shows up much later as
/// behaviour nobody can explain — an approval that never arrives because the
/// installed CLI predates the flag, or a Task quietly writing to a conversation
/// that is not its own. Saying so at the moment the agent speaks is what makes
/// them findable.
fn introduction_complaints(expected_id: &str, introduction: &Introduction) -> Vec<String> {
    let mut complaints = Vec::new();
    if let Some(reported) = introduction.session_id.as_deref()
        && reported != expected_id
    {
        complaints.push(format!(
            "claude answered for session {reported} when Caffold asked for {expected_id}; \
             this conversation belongs to another Task"
        ));
    }
    if let Some(version) = introduction.version.as_deref()
        && is_below_minimum(version)
    {
        complaints.push(format!(
            "claude {version} is below the {MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION} Caffold \
             drives; approvals and the model list may be missing"
        ));
    }
    complaints
}

/// Whether an installed CLI is older than the one Caffold was built against.
///
/// A version that cannot be read is not treated as too old: refusing to drive
/// an installation over an unparseable string would be worse than the risk it
/// guards against.
fn is_below_minimum(version: &str) -> bool {
    let Ok(installed) = semver::Version::parse(version) else {
        return false;
    };
    let Ok(minimum) = semver::Version::parse(MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION) else {
        return false;
    };
    installed < minimum
}

/// What the agent says about itself, left in its own words.
fn settings_map(introduction: &Introduction, state: &SessionState) -> BTreeMap<String, Value> {
    let mut settings = BTreeMap::new();
    // The name it was chosen by, and nothing when Caffold did not choose. The
    // agent answers with what it resolved the choice to, which is the same
    // model under a name the list a person picked from does not contain — so
    // saying it would replace their choice with something the picker cannot
    // find. A session Caffold resumed rather than started has no such name, and
    // what the Task last ran under is the store's to remember.
    // What a person chose. A session Caffold resumed rather than started has no
    // such name, and the agent's own answer would be the resolved one — a model
    // under a name the list a person picked from does not contain — so nothing
    // is said and what the Task last ran under is the store's to remember.
    if let Some(model) = &state.model {
        settings.insert("model".to_string(), json!(model));
    }
    // What a person chose, and the agent's own answer only until they have.
    if let Some(mode) = state
        .permission_mode
        .as_ref()
        .or(introduction.permission_mode.as_ref())
    {
        settings.insert("permissionMode".to_string(), json!(mode));
    }
    if let Some(effort) = &state.effort {
        settings.insert("reasoningEffort".to_string(), json!(effort));
    }
    // What the agent reached, not what was asked for.
    settings.insert("fastMode".to_string(), json!(introduction.fast_mode));
    if let Some(reason) = &introduction.fast_mode_blocked {
        settings.insert("fastModeBlockedReason".to_string(), json!(reason));
    }
    if let Some(version) = &introduction.version {
        settings.insert("version".to_string(), json!(version));
    }
    if !introduction.capabilities.is_empty() {
        settings.insert("capabilities".to_string(), json!(introduction.capabilities));
    }
    settings
}

/// What a session has to be told, or nothing when it already runs that way.
fn changed(current: &Option<String>, wanted: &Option<String>) -> Option<String> {
    let wanted = wanted.as_deref()?;
    (current.as_deref() != Some(wanted)).then(|| wanted.to_string())
}

/// What the conversation is doing, from what the session is waiting on.
fn status_of(state: &SessionState) -> ThreadStatus {
    if state.ended {
        return ThreadStatus::Idle;
    }
    match (&state.active_turn, state.pending_approvals.is_empty()) {
        (None, _) => ThreadStatus::Idle,
        (Some(_), true) => ThreadStatus::Active {
            active_flags: Vec::new(),
        },
        (Some(_), false) => ThreadStatus::Active {
            active_flags: vec![ThreadActiveFlag::WaitingOnApproval],
        },
    }
}

/// Put an item in its place, replacing the earlier report of the same one.
fn replace_item(items: &mut Vec<ConversationItem>, item: ConversationItem) {
    match items.iter_mut().find(|existing| existing.id == item.id) {
        Some(existing) => *existing = item,
        None => items.push(item),
    }
}

fn preview_of(item: &ConversationItem) -> String {
    match &item.kind {
        ItemKind::UserMessage { text, .. } | ItemKind::AssistantMessage { text, .. } => {
            text.chars().take(120).collect()
        }
        _ => String::new(),
    }
}

/// What the agent counted for a turn.
fn token_usage(result: &ResultFrame) -> Option<TokenUsage> {
    let usage = result.usage.as_ref()?;
    let context_window = result
        .model_usage
        .values()
        .find_map(|model| model.context_window);
    let last = TokenCount {
        total_tokens: usage.input_tokens + usage.output_tokens,
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cache_read_input_tokens,
        cache_write_input_tokens: usage.cache_creation_input_tokens,
        output_tokens: usage.output_tokens,
        // The agent reports thinking tokens inside its output count rather than
        // beside it, so counting them again here would double them.
        reasoning_output_tokens: 0,
    };
    Some(TokenUsage {
        total: last.clone(),
        last,
        model_context_window: context_window,
    })
}

/// One question the agent is blocked on, written for a person to read.
fn approval_request(frame: &ControlRequestFrame, turn_id: Option<String>) -> ApprovalRequest {
    let tool = frame.request.tool_name.clone().unwrap_or_default();
    let command = frame
        .request
        .input
        .get("command")
        .and_then(Value::as_str)
        .map(str::to_string);
    let path = frame
        .request
        .input
        .get("file_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    let title = match (&command, &path) {
        (Some(command), _) => format!("Run {command}"),
        (None, Some(path)) => format!("Edit {path}"),
        (None, None) if tool.is_empty() => "Run a tool".to_string(),
        (None, None) => format!("Use {tool}"),
    };
    ApprovalRequest {
        id: frame.request_id.clone(),
        turn_id,
        item_id: frame.request.tool_use_id.clone(),
        title,
        reason: frame
            .request
            .decision_reason
            .get("reason")
            .and_then(Value::as_str)
            .map(str::to_string),
        detail: ApprovalDetail {
            command,
            cwd: None,
            network_endpoint: None,
            permissions: Vec::new(),
            grant_root: path,
            environment: None,
        },
        decisions: vec![
            ApprovalDecision::Allow,
            ApprovalDecision::AllowAlways,
            ApprovalDecision::Deny,
            ApprovalDecision::DenyAndStop,
        ],
    }
}

/// The answer, in the shape the agent's permission callback expects.
///
/// Allowing always hands back the grant the agent itself proposed. Caffold does
/// not compose one: what a rule covers is the harness's model, and writing one
/// here would be Caffold deciding what a permission means.
fn approval_answer(decision: ApprovalDecision, suggestions: Value) -> Value {
    match decision {
        ApprovalDecision::Allow => json!({ "behavior": "allow", "updatedInput": null }),
        ApprovalDecision::AllowAlways => json!({
            "behavior": "allow",
            "updatedInput": null,
            "updatedPermissions": suggestions,
        }),
        ApprovalDecision::Deny | ApprovalDecision::DenyAndStop => json!({
            "behavior": "deny",
            "message": "A person declined this.",
        }),
    }
}

/// The models the agent listed, in Caffold's words.
fn model_options(answer: &Value) -> Vec<ModelOption> {
    let Some(models) = answer.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|model| {
            let value = model.get("value")?.as_str()?.to_string();
            let efforts = model
                .get("supportedEffortLevels")
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(|level| level.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(ModelOption {
                display_name: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(&value)
                    .to_string(),
                description: model
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                // The agent names its recommendation `default` rather than
                // marking one, so that name is the mark.
                is_default: value == "default",
                default_effort: None,
                supports_fast_mode: model
                    .get("supportsFastMode")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                supports_auto_mode: model
                    .get("supportsAutoMode")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                efforts,
                model: value,
            })
        })
        .collect()
}

/// Now, as the conversation counts time.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// When the agent says something happened, in milliseconds.
fn parse_timestamp_ms(timestamp: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .and_then(|moment| u64::try_from(moment.timestamp_millis()).ok())
}

/// Ask a question that needs no conversation.
///
/// The model list is the only one so far. It costs a process start and no
/// tokens, and there is no daemon holding the answer, so a process is started
/// for the question and ended with it.
async fn ask_one_off(body: Value) -> Result<Value, ClaudeError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut child = tokio::process::Command::new("claude")
        .args(BASE_ARGUMENTS.iter().filter(|argument| {
            // The permission callback needs a conversation to belong to.
            !matches!(**argument, "--permission-prompt-tool" | "stdio")
        }))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| ClaudeError::Runner(format!("could not start claude: {error}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ClaudeError::Runner("claude has no stdin".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ClaudeError::Runner("claude has no stdout".to_string()))?;

    let request_id = "caffold-ask";
    let line = format!("{}\n", protocol::control_request(request_id, body));
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| ClaudeError::Runner(error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| ClaudeError::Runner(error.to_string()))?;

    let mut lines = BufReader::new(stdout).lines();
    let answer = tokio::time::timeout(ANSWER_TIMEOUT, async {
        loop {
            let Some(line) = lines
                .next_line()
                .await
                .map_err(|error| ClaudeError::Runner(error.to_string()))?
            else {
                break Err(ClaudeError::Protocol(
                    "claude ended without answering".to_string(),
                ));
            };
            let Ok(StreamFrame::ControlResponse(response)) =
                serde_json::from_str::<StreamFrame>(&line)
            else {
                continue;
            };
            if response.response.request_id != request_id {
                continue;
            }
            break response.response.into_result().map_err(ClaudeError::Agent);
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(ClaudeError::Protocol(format!(
            "claude did not answer within {} seconds",
            ANSWER_TIMEOUT.as_secs()
        )))
    });
    let _ = child.start_kill();
    answer
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::broadcast::Receiver;

    use super::*;

    const SESSION: &str = "conversation-1";
    const CWD: &str = "/Users/example/project";

    /// Long enough for a report to cross a channel, short enough that a report
    /// that never comes fails the test instead of stalling it.
    const REPORT_TIMEOUT: Duration = Duration::from_secs(2);

    fn init_frame(session_id: &str) -> Value {
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": session_id,
            "cwd": CWD,
            "model": "claude-opus-5",
            "permissionMode": "default",
            "claude_code_version": MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION,
            "capabilities": ["interrupt_receipt_v1"],
            "fast_mode_state": "off",
            "fast_mode_disabled_reason": "extra_usage_disabled",
        })
    }

    fn assistant_frame(id: &str, content: Value) -> Value {
        json!({
            "type": "assistant",
            "uuid": "frame-1",
            "timestamp": "2026-08-20T10:15:48.336Z",
            "message": { "id": id, "role": "assistant", "content": content },
        })
    }

    fn result_frame(stop_reason: Option<&str>) -> Value {
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "stop_reason": stop_reason,
            "usage": {
                "input_tokens": 10,
                "output_tokens": 40,
                "cache_read_input_tokens": 100,
                "cache_creation_input_tokens": 7,
            },
            "modelUsage": { "claude-opus-5": { "contextWindow": 200_000 } },
        })
    }

    fn options(model: &str) -> ClaudeTurnOptions {
        ClaudeTurnOptions {
            model: Some(model.to_string()),
            ..ClaudeTurnOptions::default()
        }
    }

    /// A client watching one conversation the stand-in has already greeted.
    async fn watching() -> (ClaudeClient, MockRunnerHandle, Receiver<ClaudeRuntimeEvent>) {
        let (client, runner) = ClaudeClient::mock();
        let events = client.subscribe();
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;
        client
            .open_conversation(SESSION, CWD, &options("opus"))
            .await
            .expect("the conversation opens");
        let mut events = events;
        next_session_event(&mut events, "settings").await;
        (client, runner, events)
    }

    /// Start a turn and consume the prompt, which is its own first item.
    async fn running_turn(
        client: &ClaudeClient,
        events: &mut Receiver<ClaudeRuntimeEvent>,
        prompt: &str,
    ) -> Turn {
        let turn = client
            .start_turn(SESSION, prompt, &[], &options("opus"))
            .await
            .expect("the turn starts");
        let SessionEventKind::ItemChanged { item, .. } = next_session_event(events, "item").await
        else {
            unreachable!("asked for an item");
        };
        assert!(
            matches!(item.kind, ItemKind::UserMessage { .. }),
            "the prompt is the turn's first item, the way it is for every agent"
        );
        let SessionEventKind::StatusChanged { status } =
            next_session_event(events, "status change").await
        else {
            unreachable!("asked for a status change");
        };
        assert_eq!(
            status,
            ThreadStatus::Active {
                active_flags: Vec::new()
            },
            "a turn that has begun is a conversation that is working"
        );
        turn
    }

    /// Every user message written to the session, in order.
    async fn spoken(runner: &MockRunnerHandle) -> Vec<String> {
        runner
            .heard(SESSION)
            .await
            .into_iter()
            .filter(|frame| frame["type"] == "user")
            .filter_map(|frame| {
                frame["message"]["content"][0]["text"]
                    .as_str()
                    .map(str::to_string)
            })
            .collect()
    }

    /// The next report of the kind this asks for, or a failure saying it never
    /// came.
    async fn next_session_event(
        events: &mut Receiver<ClaudeRuntimeEvent>,
        wanted: &str,
    ) -> SessionEventKind {
        let deadline = tokio::time::Instant::now() + REPORT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let event = tokio::time::timeout(remaining, events.recv())
                .await
                .unwrap_or_else(|_| panic!("no {wanted} was reported"))
                .expect("the report channel stays open");
            if let ClaudeRuntimeEvent::Session(SessionEvent { kind, .. }) = event
                && kind_name(&kind) == wanted
            {
                return kind;
            }
        }
    }

    async fn next_approval(events: &mut Receiver<ClaudeRuntimeEvent>) -> ApprovalRequest {
        let deadline = tokio::time::Instant::now() + REPORT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let event = tokio::time::timeout(remaining, events.recv())
                .await
                .expect("no approval was reported")
                .expect("the report channel stays open");
            if let ClaudeRuntimeEvent::Approval { request, .. } = event {
                return *request;
            }
        }
    }

    async fn next_diagnostic(events: &mut Receiver<ClaudeRuntimeEvent>) -> String {
        let deadline = tokio::time::Instant::now() + REPORT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let event = tokio::time::timeout(remaining, events.recv())
                .await
                .expect("no diagnostic was reported")
                .expect("the report channel stays open");
            if let ClaudeRuntimeEvent::Diagnostic { message } = event {
                return message;
            }
        }
    }

    fn kind_name(kind: &SessionEventKind) -> &'static str {
        match kind {
            SessionEventKind::ConversationStarted { .. } => "conversation started",
            SessionEventKind::StatusChanged { .. } => "status change",
            SessionEventKind::TitleChanged { .. } => "title change",
            SessionEventKind::SettingsChanged { .. } => "settings",
            SessionEventKind::TurnStarted { .. } => "turn start",
            SessionEventKind::TurnEnded { .. } => "turn end",
            SessionEventKind::ItemChanged { .. } => "item",
            SessionEventKind::DiffChanged => "diff",
            SessionEventKind::UsageReported { .. } => "usage",
            SessionEventKind::ApprovalAnsweredElsewhere { .. } => "approval withdrawn",
        }
    }

    #[tokio::test]
    async fn a_conversation_is_started_under_the_identifier_caffold_chose() {
        // One name for the Task, the runner session, and the agent's own
        // session is what keeps them from drifting apart.
        let (client, runner) = ClaudeClient::mock();
        runner
            .greet_next_session_with(vec![json!({
                "type": "system",
                "subtype": "init",
                "session_id": "the-agent-answers-here",
                "cwd": CWD,
            })])
            .await;

        let conversation = client
            .start_conversation(CWD, &options("opus"))
            .await
            .expect("the conversation starts");

        let spawn = runner
            .spawned(&conversation.id)
            .await
            .expect("the session was created");
        assert_eq!(spawn.cwd, CWD);
        let session_flag = spawn.argv.windows(2).find(|pair| pair[0] == "--session-id");
        assert_eq!(
            session_flag.map(|pair| pair[1].as_str()),
            Some(conversation.id.as_str()),
            "the agent is told the identifier rather than asked for one"
        );
        assert!(
            spawn
                .argv
                .windows(2)
                .any(|pair| pair[0] == "--model" && pair[1] == "opus"),
            "{:?}",
            spawn.argv
        );
        assert!(
            spawn
                .argv
                .windows(2)
                .any(|pair| pair[0] == "--permission-prompt-tool" && pair[1] == "stdio"),
            "without this the agent never asks before it acts"
        );
    }

    #[tokio::test]
    async fn opening_a_conversation_resumes_the_one_the_agent_already_has() {
        let (client, runner) = ClaudeClient::mock();
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;

        client
            .open_conversation(SESSION, CWD, &ClaudeTurnOptions::default())
            .await
            .expect("the conversation opens");

        let spawn = runner.spawned(SESSION).await.expect("a session");
        assert!(
            spawn
                .argv
                .windows(2)
                .any(|pair| pair[0] == "--resume" && pair[1] == SESSION),
            "{:?}",
            spawn.argv
        );
        assert_eq!(
            spawn.cwd, CWD,
            "resuming does not restore where the conversation ran, so Caffold says"
        );
    }

    #[tokio::test]
    async fn a_turn_carries_the_prompt_and_ends_on_the_agents_answer() {
        let (client, runner, mut events) = watching().await;

        let turn = client
            .start_turn(SESSION, "fix the test", &[], &options("opus"))
            .await
            .expect("the turn starts");

        let heard = runner.heard(SESSION).await;
        assert_eq!(heard.len(), 1, "one prompt, written once");
        assert_eq!(heard[0]["type"], "user");
        assert_eq!(
            heard[0]["message"]["content"][0]["text"], "fix the test",
            "{:?}",
            heard[0]
        );
        assert_eq!(turn.status, TurnStatus::InProgress);

        runner.say(SESSION, result_frame(Some("end_turn"))).await;

        let SessionEventKind::TurnEnded { turn: ended } =
            next_session_event(&mut events, "turn end").await
        else {
            unreachable!("asked for a turn end");
        };
        assert_eq!(
            ended.id, turn.id,
            "the turn that ended is the one that began"
        );
        assert_eq!(ended.status, TurnStatus::Completed);
        assert!(ended.completed_at_ms.is_some());
    }

    #[tokio::test]
    async fn what_the_agent_says_and_does_reaches_the_conversation_as_it_happens() {
        let (client, runner, mut events) = watching().await;
        let turn = running_turn(&client, &mut events, "run it").await;

        runner
            .say(
                SESSION,
                assistant_frame(
                    "msg_1",
                    json!([
                        { "type": "thinking", "thinking": "considering" },
                        { "type": "tool_use", "id": "toolu_1", "name": "Bash",
                          "input": { "command": "cargo test" } },
                    ]),
                ),
            )
            .await;

        let SessionEventKind::ItemChanged { turn_id, item, .. } =
            next_session_event(&mut events, "item").await
        else {
            unreachable!("asked for an item");
        };
        assert_eq!(
            turn_id, turn.id,
            "an item belongs to the turn that was running"
        );
        assert!(matches!(item.kind, ItemKind::Reasoning { .. }));

        let SessionEventKind::ItemChanged { item, .. } =
            next_session_event(&mut events, "item").await
        else {
            unreachable!("asked for an item");
        };
        assert_eq!(item.id, "toolu_1");
        assert_eq!(item.status, ActivityStatus::InProgress);
    }

    #[tokio::test]
    async fn one_message_split_across_frames_keeps_every_part_it_said() {
        // Measured against CLI 2.1.236: thinking arrives in one frame and the
        // answer in the next, both under one message identifier and both
        // numbering their blocks from zero. Numbering from the message would
        // let the answer take the place of the thinking.
        let (client, runner, mut events) = watching().await;
        running_turn(&client, &mut events, "run it").await;

        let mut thinking = assistant_frame(
            "msg_1",
            json!([{ "type": "thinking", "thinking": "considering" }]),
        );
        thinking["uuid"] = json!("frame-thinking");
        let mut answer = assistant_frame("msg_1", json!([{ "type": "text", "text": "ok" }]));
        answer["uuid"] = json!("frame-answer");
        runner.say(SESSION, thinking).await;
        runner.say(SESSION, answer).await;

        let SessionEventKind::ItemChanged { item: first, .. } =
            next_session_event(&mut events, "item").await
        else {
            unreachable!("asked for an item");
        };
        let SessionEventKind::ItemChanged { item: second, .. } =
            next_session_event(&mut events, "item").await
        else {
            unreachable!("asked for an item");
        };

        assert_ne!(
            first.id, second.id,
            "two things the agent said are two items, not one said twice"
        );
        assert!(matches!(first.kind, ItemKind::Reasoning { .. }));
        let ItemKind::AssistantMessage { text, .. } = &second.kind else {
            panic!("an assistant message");
        };
        assert_eq!(text, "ok");
    }

    #[tokio::test]
    async fn a_subagents_work_does_not_join_the_turn_a_person_is_watching() {
        // A subagent writes a conversation of its own. Folding it in would
        // interleave two conversations under one turn.
        let (client, runner, mut events) = watching().await;
        running_turn(&client, &mut events, "delegate it").await;

        let mut nested =
            assistant_frame("msg_nested", json!([{ "type": "text", "text": "inner" }]));
        nested["parent_tool_use_id"] = json!("toolu_task");
        runner.say(SESSION, nested).await;
        runner
            .say(
                SESSION,
                assistant_frame("msg_own", json!([{ "type": "text", "text": "outer" }])),
            )
            .await;

        let SessionEventKind::ItemChanged { item, .. } =
            next_session_event(&mut events, "item").await
        else {
            unreachable!("asked for an item");
        };
        let ItemKind::AssistantMessage { text, .. } = &item.kind else {
            panic!("an assistant message");
        };
        assert_eq!(
            text, "outer",
            "the first item to arrive is the one this conversation said"
        );
    }

    #[tokio::test]
    async fn a_turn_that_is_stopped_leaves_nothing_still_running() {
        let (client, runner, mut events) = watching().await;
        running_turn(&client, &mut events, "run it").await;
        runner
            .say(
                SESSION,
                assistant_frame(
                    "msg_1",
                    json!([{ "type": "tool_use", "id": "toolu_1", "name": "Bash",
                            "input": { "command": "sleep 600" } }]),
                ),
            )
            .await;
        let _started = next_session_event(&mut events, "item").await;

        runner.say(SESSION, result_frame(Some("interrupt"))).await;

        let SessionEventKind::ItemChanged { item, .. } =
            next_session_event(&mut events, "item").await
        else {
            unreachable!("asked for an item");
        };
        assert_eq!(item.id, "toolu_1");
        assert_eq!(
            item.status,
            ActivityStatus::Failed,
            "a command the agent will never answer must stop spinning"
        );

        let SessionEventKind::TurnEnded { turn } =
            next_session_event(&mut events, "turn end").await
        else {
            unreachable!("asked for a turn end");
        };
        assert_eq!(turn.status, TurnStatus::Interrupted);
    }

    #[tokio::test]
    async fn an_approval_blocks_the_turn_and_is_answered_with_the_agents_own_grant() {
        let (client, runner, mut events) = watching().await;
        client
            .start_turn(SESSION, "run it", &[], &options("opus"))
            .await
            .unwrap();

        runner
            .say(
                SESSION,
                json!({
                    "type": "control_request",
                    "request_id": "req-9",
                    "request": {
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "input": { "command": "rm -rf build" },
                        "toolUseID": "toolu_7",
                        "decision_reason": { "reason": "destructive command" },
                        "permission_suggestions": [{ "type": "addRules", "rules": ["Bash(rm:*)"] }],
                    },
                }),
            )
            .await;

        let request = next_approval(&mut events).await;
        assert_eq!(request.id, "req-9");
        assert_eq!(request.item_id.as_deref(), Some("toolu_7"));
        assert_eq!(request.title, "Run rm -rf build");
        assert_eq!(request.reason.as_deref(), Some("destructive command"));
        assert!(request.decisions.contains(&ApprovalDecision::AllowAlways));

        let SessionEventKind::StatusChanged { status } =
            next_session_event(&mut events, "status change").await
        else {
            unreachable!("asked for a status change");
        };
        assert_eq!(
            status,
            ThreadStatus::Active {
                active_flags: vec![ThreadActiveFlag::WaitingOnApproval]
            },
            "a turn waiting on a person is not a turn that is working"
        );

        client
            .resolve_approval(SESSION, "req-9", ApprovalDecision::AllowAlways)
            .await
            .expect("the approval is answered");

        let answer = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["type"] == "control_response")
            .expect("an answer was written");
        assert_eq!(answer["response"]["request_id"], "req-9");
        assert_eq!(answer["response"]["response"]["behavior"], "allow");
        assert_eq!(
            answer["response"]["response"]["updatedPermissions"],
            json!([{ "type": "addRules", "rules": ["Bash(rm:*)"] }]),
            "allowing always hands back the grant the agent proposed, not one Caffold wrote"
        );
    }

    #[tokio::test]
    async fn work_a_person_refused_reads_as_refused_rather_than_as_failed() {
        // The agent reports a refusal as a failed tool result, which is what it
        // is from where the agent stands. Caffold is what refused, so Caffold
        // is what can tell the two apart.
        let (client, runner, mut events) = watching().await;
        running_turn(&client, &mut events, "run it").await;
        runner
            .say(
                SESSION,
                assistant_frame(
                    "msg_1",
                    json!([{ "type": "tool_use", "id": "toolu_7", "name": "Bash",
                            "input": { "command": "rm -rf build" } }]),
                ),
            )
            .await;
        let _started = next_session_event(&mut events, "item").await;
        runner
            .say(
                SESSION,
                json!({
                    "type": "control_request",
                    "request_id": "req-1",
                    "request": {
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "input": { "command": "rm -rf build" },
                        "toolUseID": "toolu_7",
                    },
                }),
            )
            .await;
        next_approval(&mut events).await;

        client
            .resolve_approval(SESSION, "req-1", ApprovalDecision::Deny)
            .await
            .expect("the approval is answered");
        runner
            .say(
                SESSION,
                json!({
                    "type": "user",
                    "uuid": "frame-result",
                    "message": {
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": "toolu_7",
                            "content": "A person declined this.",
                            "is_error": true,
                        }],
                    },
                }),
            )
            .await;

        let SessionEventKind::ItemChanged { item, .. } =
            next_session_event(&mut events, "item").await
        else {
            unreachable!("asked for an item");
        };
        assert_eq!(item.id, "toolu_7");
        assert_eq!(
            item.status,
            ActivityStatus::Declined,
            "the work did not fail; a person refused it"
        );
    }

    #[tokio::test]
    async fn letting_go_of_a_conversation_keeps_the_session_it_is_reached_on() {
        // Detaching means the runner refuses the next attach while the old
        // connection is still closing, and a prompt would fail for a reason
        // nobody can see.
        let (client, runner, _events) = watching().await;

        client.stop_watching(SESSION).await.expect("letting go");

        client
            .start_turn(SESSION, "still here?", &[], &options("opus"))
            .await
            .expect("a conversation let go of is still a conversation");
        assert_eq!(
            runner.heard(SESSION).await.len(),
            1,
            "the prompt reached the same session, without attaching again"
        );
    }

    #[tokio::test]
    async fn a_request_caffold_did_not_register_for_is_answered_rather_than_left_to_block() {
        // Hooks and in-process tools ask on the same channel. Caffold registers
        // neither, and silence would hang the turn forever.
        let (client, runner, _events) = watching().await;
        client
            .start_turn(SESSION, "run it", &[], &options("opus"))
            .await
            .unwrap();

        runner
            .say(
                SESSION,
                json!({
                    "type": "control_request",
                    "request_id": "hook-1",
                    "request": { "subtype": "hook_callback" },
                }),
            )
            .await;

        let answered = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if runner
                    .heard(SESSION)
                    .await
                    .iter()
                    .any(|frame| frame["response"]["request_id"] == "hook-1")
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(
            answered.is_ok(),
            "an unregistered request must still be answered"
        );
    }

    #[tokio::test]
    async fn stopping_a_turn_reaches_the_agent_as_the_agent_words_it() {
        let (client, runner, _events) = watching().await;
        client
            .start_turn(SESSION, "run it", &[], &options("opus"))
            .await
            .unwrap();

        let interrupt = tokio::spawn({
            let client = client.clone();
            async move { client.interrupt_turn(SESSION).await }
        });

        let sent = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if let Some(frame) = runner
                    .heard(SESSION)
                    .await
                    .into_iter()
                    .find(|frame| frame["type"] == "control_request")
                {
                    return frame;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the interrupt is written");
        assert_eq!(sent["request"]["subtype"], "interrupt");

        // The agent answers, and the caller stops waiting.
        runner
            .say(
                SESSION,
                json!({
                    "type": "control_response",
                    "response": {
                        "subtype": "success",
                        "request_id": sent["request_id"].as_str().unwrap(),
                        "response": {},
                    },
                }),
            )
            .await;
        interrupt
            .await
            .expect("the interrupt task finishes")
            .expect("the agent accepted it");
    }

    #[tokio::test]
    async fn what_a_turn_cost_is_reported_in_caffolds_words() {
        let (client, runner, mut events) = watching().await;
        let turn = running_turn(&client, &mut events, "run it").await;

        runner.say(SESSION, result_frame(Some("end_turn"))).await;

        let SessionEventKind::UsageReported { turn_id, usage } =
            next_session_event(&mut events, "usage").await
        else {
            unreachable!("asked for usage");
        };
        assert_eq!(turn_id, turn.id);
        assert_eq!(usage.last.input_tokens, 10);
        assert_eq!(usage.last.output_tokens, 40);
        assert_eq!(usage.last.cached_input_tokens, 100);
        assert_eq!(usage.model_context_window, Some(200_000));
        assert_eq!(
            usage.last.reasoning_output_tokens, 0,
            "the agent counts thinking inside its output, so counting it again would double it"
        );
    }

    #[tokio::test]
    async fn an_agent_answering_for_another_conversation_is_reported() {
        // Forcing the identifier is what keeps a Task, a runner session, and a
        // Claude session one name. An agent that answers under a different one
        // means this Task is watching somebody else's conversation.
        let (client, runner) = ClaudeClient::mock();
        let mut events = client.subscribe();
        runner
            .greet_next_session_with(vec![init_frame("a-different-conversation")])
            .await;

        client
            .open_conversation(SESSION, CWD, &ClaudeTurnOptions::default())
            .await
            .expect("the conversation opens");

        let complaint = next_diagnostic(&mut events).await;
        assert!(
            complaint.contains("a-different-conversation"),
            "{complaint}"
        );
        assert!(complaint.contains(SESSION), "{complaint}");
    }

    #[tokio::test]
    async fn an_installation_below_the_minimum_says_so() {
        let (client, runner) = ClaudeClient::mock();
        let mut events = client.subscribe();
        let mut greeting = init_frame(SESSION);
        greeting["claude_code_version"] = json!("2.0.1");
        runner.greet_next_session_with(vec![greeting]).await;

        client
            .open_conversation(SESSION, CWD, &ClaudeTurnOptions::default())
            .await
            .expect("the conversation opens");

        let complaint = next_diagnostic(&mut events).await;
        assert!(complaint.contains("2.0.1"), "{complaint}");
        assert!(
            complaint.contains(MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION),
            "{complaint}"
        );
    }

    #[tokio::test]
    async fn a_model_chosen_after_the_session_started_is_told_to_the_agent() {
        // The session took its model as an argument when it started, so a
        // later choice reaches it only by being said. Without this the composer
        // shows one model and the conversation runs another.
        let (client, runner, mut events) = watching().await;

        client
            .start_turn(SESSION, "run it", &[], &options("haiku"))
            .await
            .expect("the turn starts");

        let told = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "set_model")
            .expect("the agent is told");
        assert_eq!(told["request"]["model"], "haiku");
        let SessionEventKind::SettingsChanged { settings } =
            next_session_event(&mut events, "settings").await
        else {
            unreachable!("asked for settings");
        };
        assert_eq!(
            settings["model"], "haiku",
            "and the conversation reports the name it was chosen by, not the one the agent resolved"
        );
    }

    #[tokio::test]
    async fn a_depth_chosen_after_the_session_started_is_asked_for_and_waited_on() {
        // Depth is a command the agent runs, so it takes a turn of its own.
        // Opening the person's turn before that one ends would let its answer
        // close theirs.
        let (client, runner, mut events) = watching().await;

        let turn = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .start_turn(
                        SESSION,
                        "run it",
                        &[],
                        &ClaudeTurnOptions {
                            effort: Some("xhigh".to_string()),
                            ..options("opus")
                        },
                    )
                    .await
            }
        });

        let asked = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if let Some(frame) = runner
                    .heard(SESSION)
                    .await
                    .into_iter()
                    .find(|frame| frame["type"] == "user")
                {
                    return frame;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the agent is asked");
        assert_eq!(asked["message"]["content"][0]["text"], "/effort xhigh");
        assert!(!turn.is_finished(), "the prompt waits for the answer");

        runner.say(SESSION, result_frame(Some("end_turn"))).await;
        let started = tokio::time::timeout(REPORT_TIMEOUT, turn)
            .await
            .expect("the turn stops waiting")
            .expect("the task finishes")
            .expect("the turn starts");

        let prompts = spoken(&runner).await;
        assert_eq!(prompts, ["/effort xhigh", "run it"], "in that order");

        // The answer to the command is not the answer to the turn.
        assert_eq!(started.status, TurnStatus::InProgress);
        let SessionEventKind::TurnStarted { turn } =
            next_session_event(&mut events, "turn start").await
        else {
            unreachable!("asked for a turn start");
        };
        assert_eq!(turn.id, started.id);
    }

    #[tokio::test]
    async fn asking_for_speed_reaches_the_agent_and_reports_what_it_reached() {
        // Asking is not getting. An installation whose account has no extra
        // usage stays at its ordinary speed however often it is asked, and the
        // conversation should say what the agent reached rather than what was
        // wanted.
        let (client, runner, mut events) = watching().await;

        client
            .start_turn(
                SESSION,
                "run it",
                &[],
                &ClaudeTurnOptions {
                    fast_mode: true,
                    ..options("opus")
                },
            )
            .await
            .expect("the turn starts");

        let asked = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "apply_flag_settings")
            .expect("the agent is asked");
        assert_eq!(asked["request"]["settings"]["fastMode"], true);

        let SessionEventKind::SettingsChanged { settings } =
            next_session_event(&mut events, "settings").await
        else {
            unreachable!("asked for settings");
        };
        assert_eq!(
            settings["fastMode"], false,
            "the greeting said this session is not fast, and that is what stands"
        );
        assert_eq!(
            settings["fastModeBlockedReason"], "extra_usage_disabled",
            "and why, so it does not read as a choice that was ignored"
        );
    }

    #[tokio::test]
    async fn a_depth_the_session_already_works_at_is_not_asked_for_again() {
        let (client, runner, _events) = watching().await;

        client
            .start_turn(SESSION, "run it", &[], &options("opus"))
            .await
            .expect("the turn starts");

        assert_eq!(spoken(&runner).await, ["run it"]);
    }

    #[tokio::test]
    async fn a_model_the_session_already_runs_is_not_told_again() {
        let (client, runner, _events) = watching().await;

        client
            .start_turn(SESSION, "run it", &[], &options("opus"))
            .await
            .expect("the turn starts");

        assert!(
            !runner
                .heard(SESSION)
                .await
                .iter()
                .any(|frame| frame["request"]["subtype"] == "set_model"),
            "a session already running that model has nothing to be told"
        );
    }

    #[tokio::test]
    async fn a_permission_mode_chosen_after_the_session_started_is_told_to_the_agent() {
        let (client, runner, _events) = watching().await;

        client
            .start_turn(
                SESSION,
                "run it",
                &[],
                &ClaudeTurnOptions {
                    permission_mode: Some("acceptEdits".to_string()),
                    ..options("opus")
                },
            )
            .await
            .expect("the turn starts");

        let told = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "set_permission_mode")
            .expect("the agent is told");
        assert_eq!(told["request"]["mode"], "acceptEdits");
    }

    #[tokio::test]
    async fn a_second_turn_does_not_take_the_place_of_one_still_running() {
        // Replacing it would leave the first turn's items arriving under an
        // identifier nothing reads, and the turn itself spinning forever.
        let (client, _runner, mut events) = watching().await;
        let running = running_turn(&client, &mut events, "run it").await;

        let refused = client
            .start_turn(SESSION, "and another", &[], &options("opus"))
            .await;

        assert!(
            matches!(refused, Err(ClaudeError::Protocol(ref message)) if message.contains(&running.id)),
            "{refused:?}"
        );
    }

    #[tokio::test]
    async fn a_conversation_is_dated_by_what_caffold_watched() {
        // The agent keeps no record of when a conversation happened, and a
        // Task list that ordered by nothing would sort every Claude Task to
        // the same place.
        let (client, runner, mut events) = watching().await;
        let opened = client
            .open_conversation(SESSION, CWD, &ClaudeTurnOptions::default())
            .await
            .expect("the conversation opens");
        assert!(opened.created_at_ms > 0, "a conversation has a beginning");

        running_turn(&client, &mut events, "run it").await;
        runner.say(SESSION, result_frame(Some("end_turn"))).await;
        next_session_event(&mut events, "turn end").await;

        let moved = client
            .open_conversation(SESSION, CWD, &ClaudeTurnOptions::default())
            .await
            .expect("the conversation opens");
        assert!(
            moved.updated_at_ms >= opened.updated_at_ms,
            "a turn is something happening"
        );
        assert_eq!(moved.recency_at_ms, Some(moved.updated_at_ms));
        assert_eq!(
            moved.created_at_ms, opened.created_at_ms,
            "when it began does not move"
        );
    }

    #[tokio::test]
    async fn an_agent_that_exits_leaves_the_conversation_idle_and_unwatched() {
        // The process is the conversation. When it goes, so does the turn it
        // was running, and a Task still shown as working would be waiting on
        // nobody.
        let (client, runner, mut events) = watching().await;
        running_turn(&client, &mut events, "run it").await;

        runner.exit(SESSION, Some(1)).await;

        let SessionEventKind::StatusChanged { status } =
            next_session_event(&mut events, "status change").await
        else {
            unreachable!("asked for a status change");
        };
        assert_eq!(status, ThreadStatus::Idle);
        assert!(
            matches!(
                client
                    .start_turn(SESSION, "again", &[], &options("opus"))
                    .await,
                Err(ClaudeError::NotWatching(_))
            ),
            "a session nobody holds is not one a prompt can reach"
        );
    }

    #[tokio::test]
    async fn a_frame_this_release_cannot_read_does_not_end_the_session() {
        // The union grows on minor releases, and a session that fell over on
        // the first unknown line would take the conversation with it.
        let (client, runner, mut events) = watching().await;
        running_turn(&client, &mut events, "run it").await;

        runner
            .say(SESSION, json!({ "type": "memory_recall", "detail": {} }))
            .await;
        runner
            .say(
                SESSION,
                assistant_frame("msg_1", json!([{ "type": "text", "text": "still here" }])),
            )
            .await;

        let SessionEventKind::ItemChanged { item, .. } =
            next_session_event(&mut events, "item").await
        else {
            unreachable!("asked for an item");
        };
        let ItemKind::AssistantMessage { text, .. } = &item.kind else {
            panic!("an assistant message");
        };
        assert_eq!(text, "still here");
    }

    #[tokio::test]
    async fn a_model_the_agent_does_not_offer_is_refused_before_a_session_exists() {
        // Agreeing first is what stops a conversation being created under a
        // model that never existed and then left behind.
        let (client, _runner) = ClaudeClient::mock();
        client
            .offer_models(vec![ModelOption {
                model: "opus".to_string(),
                display_name: "Opus".to_string(),
                description: None,
                is_default: true,
                default_effort: None,
                efforts: vec!["low".to_string(), "high".to_string()],
                supports_fast_mode: true,
                supports_auto_mode: true,
            }])
            .await;

        let wrong_model = claude_turn_options(
            &client,
            &TurnOptions {
                model: Some("gpt-5.6-sol".to_string()),
                ..TurnOptions::default()
            },
        )
        .await;
        let wrong_effort = claude_turn_options(
            &client,
            &TurnOptions {
                model: Some("opus".to_string()),
                effort: Some("glacial".to_string()),
                ..TurnOptions::default()
            },
        )
        .await;

        assert!(matches!(wrong_model, Err(TurnRejected::Model)));
        assert!(matches!(wrong_effort, Err(TurnRejected::Effort)));
    }

    #[tokio::test]
    async fn asking_for_speed_a_model_does_not_have_settles_for_what_it_does() {
        let (client, _runner) = ClaudeClient::mock();
        client
            .offer_models(vec![ModelOption {
                model: "haiku".to_string(),
                display_name: "Haiku".to_string(),
                description: None,
                is_default: false,
                default_effort: None,
                efforts: Vec::new(),
                supports_fast_mode: false,
                supports_auto_mode: false,
            }])
            .await;

        let accepted = claude_turn_options(
            &client,
            &TurnOptions {
                model: Some("haiku".to_string()),
                fast_mode: true,
                ..TurnOptions::default()
            },
        )
        .await
        .expect("the model is real, so the turn is accepted");

        assert!(
            !accepted.fast_mode,
            "a model with no faster tier answers a request for speed with its ordinary one"
        );
    }

    /// A client whose list holds one model that can decide for itself and one
    /// that cannot.
    async fn client_offering_both_kinds() -> ClaudeClient {
        let (client, _runner) = ClaudeClient::mock();
        client
            .offer_models(vec![
                ModelOption {
                    model: "sonnet".to_string(),
                    display_name: "Sonnet".to_string(),
                    description: None,
                    is_default: true,
                    default_effort: None,
                    efforts: vec!["high".to_string()],
                    supports_fast_mode: false,
                    supports_auto_mode: true,
                },
                ModelOption {
                    model: "haiku".to_string(),
                    display_name: "Haiku".to_string(),
                    description: None,
                    is_default: false,
                    default_effort: None,
                    efforts: Vec::new(),
                    supports_fast_mode: false,
                    supports_auto_mode: false,
                },
            ])
            .await;
        client
    }

    #[tokio::test]
    async fn every_permission_mode_reaches_the_interface_already_named() {
        let modes = client_offering_both_kinds()
            .await
            .permission_modes(Some("sonnet"))
            .await;

        assert!(
            modes
                .options
                .iter()
                .any(|option| option.mode == modes.default_mode && option.allowed),
            "the default has to be one of the choices, and one that can be used"
        );
        assert!(
            modes
                .options
                .iter()
                .all(|option| !option.label.is_empty() && !option.description.is_empty())
        );
        assert!(
            modes
                .options
                .iter()
                .any(|option| option.dangerous && option.mode == "bypassPermissions"),
            "the mode that gives up a protection has to read as one"
        );
    }

    #[tokio::test]
    async fn letting_the_model_decide_is_offered_only_by_a_model_that_can() {
        // Measured against CLI 2.1.236: `set_permission_mode auto` is refused
        // with "auto mode unavailable for this model", and the model list says
        // in advance which models can. Offering it regardless would fail at the
        // moment a turn starts, which is the worst place to find out.
        let client = client_offering_both_kinds().await;

        let able = client.permission_modes(Some("sonnet")).await;
        let unable = client.permission_modes(Some("haiku")).await;
        let unknown = client.permission_modes(None).await;

        let auto = |modes: &PermissionModes| {
            modes
                .options
                .iter()
                .find(|option| option.mode == "auto")
                .map(|option| option.allowed)
        };
        assert_eq!(auto(&able), Some(true));
        assert_eq!(able.default_mode, "auto", "it is also how this agent works");
        assert_eq!(
            unable.default_mode, "default",
            "a default nobody can use is not a default"
        );
        assert_eq!(
            auto(&unable),
            Some(false),
            "withheld reads as withheld, not as missing"
        );
        assert_eq!(
            auto(&unknown),
            Some(false),
            "a model nobody named cannot be known to manage its own permissions"
        );
        assert_eq!(
            unable.options.len(),
            able.options.len(),
            "the same choices are shown either way"
        );
    }

    #[test]
    fn the_models_the_agent_lists_arrive_in_caffolds_words() {
        // Measured against CLI 2.1.236: the recommendation is named `default`
        // rather than marked, and only some models carry effort levels.
        let answer = json!({
            "models": [
                {
                    "value": "default",
                    "resolvedModel": "claude-opus-5[1m]",
                    "displayName": "Default (recommended)",
                    "description": "Opus 5 with 1M context",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
                    "supportsFastMode": true
                },
                {
                    "value": "haiku",
                    "resolvedModel": "claude-haiku-4-5-20251001",
                    "displayName": "Haiku",
                    "description": "Fastest for quick answers"
                }
            ]
        });

        let models = model_options(&answer);

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].model, "default");
        assert!(models[0].is_default);
        assert!(models[0].supports_fast_mode);
        assert_eq!(models[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(models[1].model, "haiku");
        assert!(!models[1].is_default);
        assert!(models[1].efforts.is_empty());
        assert!(!models[1].supports_fast_mode);
    }
}
