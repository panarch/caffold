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
//! **A turn is bounded by what Caffold sent and what the agent answered.** It
//! opens when the agent identifies the prompt it took and closes on the
//! `result` frame that answers it. Its name comes from the agent: a prompt is
//! handed back under the identity the agent filed it as, and that identity is
//! what the transcript knows the turn by, so a turn watched here and the same
//! turn read from disk are one turn.
//!
//! **History belongs to the agent.** What a session has said is kept here for
//! as long as the session is watched, because that is what a viewer arriving
//! mid-turn needs, and it is thrown away with the session. The record that
//! outlives a restart is the one the agent writes, which [`transcript`] reads.
//!
//! This file is the client's surface — its types, its turns, its approvals —
//! and each larger concern lives with its own module: [`session`] opens and
//! takes back up, [`starting`] paces every authenticating start, [`reading`]
//! interprets everything the agent says, [`served_tools`] answers for the
//! tools Caffold serves it, and [`settings`] carries what a person chose to a
//! running session.

pub(crate) mod protocol;
mod reading;
pub(crate) mod runner;
mod served_tools;
mod session;
mod settings;
mod starting;
pub(crate) mod status;
pub(crate) mod transcript;
pub(crate) mod translate;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, broadcast, oneshot};

use self::protocol::{
    ControlRequestFrame, MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION, MessageFrame, ResultFrame,
    StreamFrame, SystemFrame,
};
use self::runner::{RunnerClient, SessionFrames};
use self::session::SessionStart;
use self::translate::ToolCalls;
use crate::agent::driver::{
    ClaudeConversation, Driver, ModelOption, PermissionModeOption, PermissionModes, TurnOptions,
    TurnRejected, bounded,
};
use crate::agent::{
    ActivityStatus, ApprovalDecision, ApprovalDetail, ApprovalRequest, Conversation,
    ConversationItem, ItemKind, MessageContent, SessionEvent, SessionEventKind, ThreadActiveFlag,
    ThreadStatus, TokenCount, TokenUsage, Turn, TurnOrigin, TurnPage, TurnStatus,
};

pub(crate) use self::served_tools::{AskedTool, ToolAsk};
pub(crate) use self::session::WorkingDirectoryMove;

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
    /// No session is being watched under that conversation's name.
    #[error("Caffold is not watching Claude conversation {0}.")]
    NotWatching(String),
    /// The question was no longer waiting — answered already, or overtaken
    /// by the turn ending.
    #[error("Nothing is waiting on approval {0}.")]
    NoSuchApproval(String),
}

/// The agent Caffold drives when a Task belongs to Claude.
#[derive(Clone)]
pub(crate) struct ClaudeClient {
    inner: Arc<ClaudeClientInner>,
}

struct ClaudeClientInner {
    runner: RunnerClient,
    /// The one door every authenticating start passes through — a session the
    /// runner spawns, or a one-off question asked directly. Why one:
    /// [`starting`].
    starts: starting::StartGate,
    /// Where the agent keeps every project's conversations. Absent when this
    /// installation's environment names no home, in which case a conversation
    /// can be neither read nor removed and neither is reported as done.
    projects: Option<std::path::PathBuf>,
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
    /// Claude completed work that no Caffold-owned live turn can contain.
    ///
    /// The stream does not say what opened that work. The transcript does, so
    /// this asks the application to read that canonical evidence rather than
    /// making a turn up from the frames around it.
    TranscriptChanged { conversation_id: String },
    /// The agent is blocked until someone answers.
    Approval {
        conversation_id: String,
        request: Box<ApprovalRequest>,
    },
    /// The agent called a tool Caffold serves, and is blocked until the
    /// application does the thing and answers through
    /// [`ClaudeClient::answer_tool_ask`].
    ToolAsked {
        conversation_id: String,
        ask: ToolAsk,
    },
    /// The session can no longer be reached, and did not say it was ending.
    ///
    /// Distinct from the agent exiting, which the agent says and which leaves a
    /// conversation that simply has no process behind it. This is the runner
    /// going away underneath one — nothing said, and what Caffold last heard
    /// left standing as though it were still true.
    Unreachable {
        conversation_id: String,
        message: String,
    },
    /// Something worth writing down that nothing acts on.
    Diagnostic { message: String },
}

/// One session, and everything Caffold knows about it.
struct Session {
    id: String,
    /// Where the session runs — and so where the agent keeps its transcript,
    /// which follows a moved session. Moves once at most, when the Task is
    /// isolated into a worktree.
    cwd: AsyncMutex<String>,

    frames: AsyncMutex<SessionFrames>,
    state: AsyncMutex<SessionState>,
    /// Control requests Caffold has sent and is waiting on.
    pending: AsyncMutex<HashMap<String, oneshot::Sender<Result<protocol::ControlAnswer, String>>>>,
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
    /// A prompt sent and not yet given a turn: what was said, and who is
    /// waiting to hear what the turn is called.
    ///
    /// The turn has no name until the agent says what it filed the prompt as,
    /// so this holds the place between writing the prompt and learning what to
    /// call what follows. What was said is kept because the turn may end up
    /// being opened by a frame that is not the prompt coming home, and that
    /// frame does not know what was asked.
    pending_prompt: Option<PendingPrompt>,
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

/// A submitted prompt waiting for Claude to establish its turn.
struct PendingPrompt {
    said: Vec<MessageContent>,
    waiting: oneshot::Sender<Result<Turn, ClaudeError>>,
}

/// One question the agent is blocked on, and what answering it needs.
#[derive(Debug, Clone)]
struct PendingApproval {
    /// The grants the agent proposed for allowing this always, kept as
    /// proposed so that answering reads from them rather than from a rule
    /// Caffold invented.
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

    /// A client that keeps conversations somewhere a test owns.
    #[cfg(test)]
    pub(crate) fn mock_writing_to(projects: std::path::PathBuf) -> (Self, MockRunnerHandle) {
        let (runner, handle) = RunnerClient::mock();
        (
            Self::with_runner_and_projects(runner, Some(projects)),
            handle,
        )
    }

    /// Put canonical history where this test client's Claude installation
    /// keeps it. Tests outside the transcript module use this instead of
    /// copying Claude's project-directory encoding.
    #[cfg(test)]
    pub(crate) fn write_test_transcript(&self, cwd: &str, conversation_id: &str, contents: &str) {
        let projects = self
            .projects()
            .expect("the test client has a projects directory");
        transcript::plant(projects, cwd, conversation_id, contents);
    }

    /// Hold the start door shut, the way a start mid-passage holds it.
    #[cfg(test)]
    async fn hold_starts_for_tests(&self) -> starting::Starting<'_> {
        self.inner.starts.one_at_a_time().await
    }

    fn with_runner(runner: RunnerClient) -> Self {
        Self::with_runner_and_projects(runner, transcript::projects_root())
    }

    fn with_runner_and_projects(
        runner: RunnerClient,
        projects: Option<std::path::PathBuf>,
    ) -> Self {
        let (events, _) = broadcast::channel(256);
        let starts = starting::StartGate::spaced();
        // A stand-in runner spawns nothing, so its door needs no spacing —
        // and a spaced one would slow every test that opens two sessions.
        #[cfg(test)]
        let starts = if runner.is_mock() {
            starting::StartGate::unspaced()
        } else {
            starts
        };
        Self {
            inner: Arc::new(ClaudeClientInner {
                runner,
                starts,
                projects,
                sessions: AsyncMutex::new(HashMap::new()),
                events,
                models: AsyncMutex::new(None),
            }),
        }
    }

    /// Where this client reads and removes conversations.
    fn projects(&self) -> Option<&std::path::Path> {
        self.inner.projects.as_deref()
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

    /// Stop the runner and start a fresh one, reporting the replacement.
    ///
    /// Every session ends with the old runner and every Task it was running
    /// goes idle, exactly as an application update leaves them; conversations
    /// resume from their files as Tasks are opened. What this buys is a runner
    /// running the currently installed binary, and a deliberate way to put the
    /// whole Claude runtime down and up again.
    pub(crate) async fn restart_runtime(
        &self,
    ) -> Result<caffold_claude_runner::protocol::DaemonStatus, ClaudeError> {
        self.inner.runner.restart().await
    }

    /// The conversations that still have a process behind them.
    ///
    /// Asked of the runner rather than of any agent, because it is the one
    /// thing that outlives this process and so the only thing that knows what
    /// survived it. Nothing is started to answer it: everything it names is
    /// already running, and a runner that has just started names nothing.
    pub(crate) async fn live_conversations(&self) -> Vec<String> {
        self.inner.runner.live_sessions().await
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

    /// A conversation as it stands, if anyone is watching it.
    ///
    /// Nothing is started to find out. A conversation nobody is watching is not
    /// doing anything — the agent only works while a turn is running, and a
    /// turn only runs on a session — so the absence of a session is an answer
    /// rather than a reason to go and get one. It is the answer that matters
    /// where this is asked: putting a Task away should not start it first.
    pub(crate) async fn watched_conversation(&self, conversation_id: &str) -> Option<Conversation> {
        let session = self.session(conversation_id).await?;
        Some(self.conversation_of(&session).await)
    }

    /// Whether the agent still has this conversation written down.
    ///
    /// This is the whole of a local session's existence: no server holds a
    /// copy, so the file being there is the conversation being there.
    ///
    /// Asked once per row of a list, and answered by a disk that may be a
    /// network away, so the look happens off the runtime's own threads.
    pub(crate) async fn was_written_down(&self, cwd: &str, conversation_id: &str) -> bool {
        let Some(path) = self
            .projects()
            .and_then(|projects| transcript::locate(projects, cwd, conversation_id))
        else {
            return false;
        };
        tokio::task::spawn_blocking(move || path.exists())
            .await
            .unwrap_or(false)
    }

    /// Remove a conversation from the world.
    ///
    /// What the agent wrote is a local session in its entirety: there is
    /// nothing to ask a server to forget, and nothing that comes back.
    ///
    /// The session is closed first, because a process still writing to a file
    /// that has been removed would write the conversation back.
    pub(crate) async fn erase(&self, conversation_id: &str, cwd: &str) -> Result<(), ClaudeError> {
        self.close_conversation(conversation_id).await?;
        // Not knowing where it is, is not the same as it being gone. Reporting
        // this as done would delete the only row pointing at a conversation
        // that is still on disk.
        let Some(written) = self
            .projects()
            .and_then(|projects| transcript::locate(projects, cwd, conversation_id))
        else {
            return Err(ClaudeError::Runner(format!(
                "cannot work out where conversation {conversation_id} is written down"
            )));
        };
        tokio::task::spawn_blocking(move || transcript::erase(&written))
            .await
            .map_err(|error| ClaudeError::Runner(error.to_string()))?
            .map_err(|error| {
                ClaudeError::Runner(format!("could not remove what the agent wrote: {error}"))
            })
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

    /// The newest turn the conversation on disk holds.
    ///
    /// Both recoveries read the file the same way — the turn a resumed session
    /// was in the middle of, and the name an unhanded prompt was filed under —
    /// and this is that one way.
    async fn newest_filed_turn(&self, cwd: &str, id: &str) -> Option<Turn> {
        let path = self
            .projects()
            .and_then(|projects| transcript::locate(projects, cwd, id))?;
        let reading = tokio::task::spawn_blocking(move || transcript::read(&path, None, 1))
            .await
            .ok()?;
        reading.page.turns.into_iter().next()
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
    /// The turn is named by the agent, which hands a prompt back under the
    /// identity it filed it as. That is the name every item of this turn is
    /// reported under, the name that stops it, and the name the transcript will
    /// know it by — which is what makes reading this turn back later find this
    /// turn rather than another one just like it.
    pub(crate) async fn start_turn(
        &self,
        conversation_id: &str,
        prompt: &str,
        images: &[String],
        options: &ClaudeTurnOptions,
    ) -> Result<Turn, ClaudeError> {
        let session = self.require_session(conversation_id).await?;
        self.apply_settings(&session, options).await?;

        let handed_back = {
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
            // A prompt already written has no turn yet, and would lose its name
            // to this one.
            if state.pending_prompt.is_some() {
                return Err(ClaudeError::Protocol(format!(
                    "a prompt is already being sent on conversation {conversation_id}"
                )));
            }
            if state.ended {
                return Err(ClaudeError::Agent(format!(
                    "Claude conversation {conversation_id} has ended"
                )));
            }
            let (sender, receiver) = oneshot::channel();
            state.pending_prompt = Some(PendingPrompt {
                said: translate::prompt_content_of(prompt, images),
                waiting: sender,
            });
            receiver
        };

        if let Err(error) = session.send(protocol::user_message(prompt, images)).await {
            session.state.lock().await.pending_prompt = None;
            return Err(error);
        }

        // The turn is opened by the first thing the agent says, not here, so
        // that nothing it says arrives before there is a turn to say it in.
        // Only Claude identifying the turn, or the session ending, can finish
        // this wait; time passing says nothing about either.
        let turn = handed_back.await.map_err(|_| {
            ClaudeError::Protocol(format!(
                "the pending prompt disappeared on conversation {conversation_id}"
            ))
        })??;

        let prompt_item = turn.items.first().cloned();
        self.report(
            conversation_id,
            SessionEventKind::TurnStarted { turn: turn.clone() },
        );
        if let Some(prompt_item) = prompt_item {
            self.report(
                conversation_id,
                SessionEventKind::ItemChanged {
                    turn_id: turn.id.clone(),
                    item: prompt_item,
                    at_ms: turn.started_at_ms.unwrap_or_else(now_ms),
                },
            );
        }
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

        let item = translate::user_message_item(
            &format!("{turn_id}:steer:{}", now_ms()),
            translate::prompt_content_of(prompt, images),
        );
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
    // Reading a session
    // -----------------------------------------------------------------------

    async fn conversation_of(&self, session: &Arc<Session>) -> Conversation {
        let session_cwd = session.cwd.lock().await.clone();
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
                .unwrap_or_else(|| session_cwd.clone()),
            transcript_path: None,
            created_at_ms: state.opened_at_ms,
            updated_at_ms: state.moved_at_ms,
            recency_at_ms: Some(state.moved_at_ms),
            turns: state.turns.clone(),
        }
    }

    /// A conversation's turns, newest first, and where the older ones are.
    ///
    /// The history is the agent's transcript, not what this session remembers,
    /// because the session remembers only what it watched and a Task outlives
    /// every session that ever ran it.
    ///
    /// What a running session knows is laid over the top of it. Both describe
    /// the same turns under the same names, and where they differ the session
    /// is the one that can say a turn is still running, that a tool is waiting
    /// on an answer, or that a failed tool result was somebody declining.
    pub(crate) async fn read_turns(
        &self,
        conversation_id: &str,
        cwd: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> TurnPage {
        let Some(path) = self
            .projects()
            .and_then(|projects| transcript::locate(projects, cwd, conversation_id))
        else {
            return TurnPage::default();
        };
        let cursor = cursor.map(str::to_string);
        let reading =
            tokio::task::spawn_blocking(move || transcript::read(&path, cursor.as_deref(), limit))
                .await
                .unwrap_or_default();
        if reading.unreadable > 0 {
            self.publish(ClaudeRuntimeEvent::Diagnostic {
                message: format!(
                    "conversation {conversation_id} has {} line(s) this release cannot read; \
                     what is shown is missing that much of it",
                    reading.unreadable
                ),
            });
        }
        let mut page = reading.page;
        if let Some(session) = self.session(conversation_id).await {
            let state = session.state.lock().await;
            for turn in &state.turns {
                if let Some(known) = page.turns.iter_mut().find(|known| known.id == turn.id) {
                    *known = turn.clone();
                }
            }
        }
        page
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
        // Marked declined before the answer goes out: the agent's report of
        // the refused call races this future once the answer is on the wire.
        let suggestions = {
            let mut state = session.state.lock().await;
            let pending = state
                .pending_approvals
                .remove(approval_id)
                .ok_or_else(|| ClaudeError::NoSuchApproval(approval_id.to_string()))?;
            if matches!(
                decision,
                ApprovalDecision::Deny | ApprovalDecision::DenyAndStop
            ) && let Some(item_id) = pending.item_id
            {
                state.declined.insert(item_id);
            }
            pending.suggestions
        };
        session
            .send(protocol::control_response(
                approval_id,
                approval_answer(decision, &suggestions),
            ))
            .await?;
        self.report_status(&session).await;
        if matches!(decision, ApprovalDecision::DenyAndStop) {
            self.interrupt_turn(conversation_id).await?;
        }
        Ok(())
    }
}

impl Session {
    async fn send(&self, frame: Value) -> Result<(), ClaudeError> {
        self.frames.lock().await.send(frame).await
    }

    /// Ask the agent something over the control protocol, and wait.
    async fn control(&self, body: Value) -> Result<protocol::ControlAnswer, ClaudeError> {
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

/// A Claude failure, in the words every agent shares.
///
/// The runner gone is the agent unreachable; a conversation nobody is
/// watching is a conversation that is not there to be asked about; the rest
/// is carried as what happened, in Claude's own words.
impl From<ClaudeError> for crate::agent::AgentError {
    fn from(error: ClaudeError) -> Self {
        use crate::agent::AgentError;
        match error {
            ClaudeError::Runner(_) => AgentError::Unreachable(error.to_string()),
            // Not watching is not unreachable: the runner is fine and the
            // conversation is simply not there to be asked about.
            ClaudeError::NotWatching(_) => AgentError::ConversationGone(error.to_string()),
            ClaudeError::Protocol(_) | ClaudeError::Agent(_) | ClaudeError::NoSuchApproval(_) => {
                AgentError::Failed(error.to_string())
            }
        }
    }
}

impl From<ClaudeError> for TurnRejected {
    fn from(error: ClaudeError) -> Self {
        Self::Unavailable(error.into())
    }
}

/// What a person chose, in the agent's own words.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ClaudeTurnOptions {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) fast_mode: bool,
    pub(crate) permission_mode: Option<String>,
}

/// Open the turn a written prompt is waiting for, if one is waiting.
///
/// `named` is what the agent filed the prompt as — said by the prompt coming
/// home, or read back from the conversation on disk when the agent answered
/// without handing it back. Only after actual output proves a turn exists can
/// a missing name be replaced locally; silence never reaches this function.
/// That keeps an answer from passing before there is a turn for its result to
/// close when the transcript is unavailable.
fn open_pending_turn(state: &mut SessionState, named: Option<&str>) -> Option<Turn> {
    if state.ended {
        return None;
    }
    let PendingPrompt { said, waiting } = state.pending_prompt.take()?;
    let turn_id = named
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let turn = open_turn(state, &turn_id, said);
    // The caller may have gone away, but actual agent output still opened this
    // turn and remains the authority for the session state.
    let _ = waiting.send(Ok(turn.clone()));
    Some(turn)
}

/// End a prompt that never received a turn identity from the agent.
///
/// The source of the terminal fact supplies the error: an ordinary agent exit
/// is different from losing the runner underneath it.
fn end_pending_prompt(state: &mut SessionState, error: ClaudeError) {
    if let Some(PendingPrompt { waiting, .. }) = state.pending_prompt.take() {
        let _ = waiting.send(Err(error));
    }
}

/// Open a turn on a session, under the name it will be known by.
///
/// Whoever calls this holds the session's state, which is what makes the turn
/// exist before anything the agent says next can arrive looking for it.
fn open_turn(state: &mut SessionState, turn_id: &str, said: Vec<MessageContent>) -> Turn {
    let started_at_ms = now_ms();
    let turn = Turn {
        id: turn_id.to_string(),
        origin: TurnOrigin::User,
        status: TurnStatus::InProgress,
        started_at_ms: Some(started_at_ms),
        completed_at_ms: None,
        items: vec![translate::user_message_item(
            &format!("{turn_id}:prompt"),
            said,
        )],
    };
    state.active_turn = Some(turn_id.to_string());
    state.moved_at_ms = started_at_ms;
    state.turns.push(turn.clone());
    turn
}

/// What the conversation is doing, from what the agent has reported.
///
/// A prompt accepted by the runner but not identified by Claude is request
/// state, not evidence of an active turn. Keeping that distinction here avoids
/// turning transport progress into agent-owned domain state.
fn status_of(state: &SessionState) -> ThreadStatus {
    if state.ended {
        return ThreadStatus::Idle;
    }
    if !state.pending_approvals.is_empty() {
        // Waiting on a person is not being idle, whether or not a turn is open
        // here. A conversation taken up while the agent was already blocked on a
        // question has the question and not yet the turn it belongs to, and
        // reading that as idle would withdraw the very question just recovered.
        return ThreadStatus::Active {
            active_flags: vec![ThreadActiveFlag::WaitingOnApproval],
        };
    }
    match &state.active_turn {
        None => ThreadStatus::Idle,
        Some(_) => ThreadStatus::Active {
            active_flags: Vec::new(),
        },
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

/// The answer, in the shape the agent's permission callback expects.
///
/// Optional means absent. The agent validates `updatedInput?: object` and
/// rejects `null` — measured, as a tool failing with "invalid permission
/// result" after a person allowed it — so a field with nothing to say is
/// omitted rather than sent empty. `updatedInput` is never sent at all: it
/// replaces the input the agent already holds, and a person allowing a call
/// changed nothing, so absence is the truthful answer.
///
/// Allowing always hands back the whole grant the agent proposed. The
/// proposal is the agent's own "don't ask this again" — a bundle whose parts
/// carry it together, and a subset does not: keeping only its rule entries
/// was probed against the real agent, which then asked about the identical
/// command again. Composing a narrower grant here would be Caffold deciding
/// what a permission means, and one that does not work.
fn approval_answer(decision: ApprovalDecision, suggestions: &Value) -> Value {
    match decision {
        ApprovalDecision::Allow => json!({ "behavior": "allow" }),
        ApprovalDecision::AllowAlways => {
            let mut answer = json!({ "behavior": "allow" });
            if !suggestions.is_null() {
                answer["updatedPermissions"] = suggestions.clone();
            }
            answer
        }
        ApprovalDecision::Deny | ApprovalDecision::DenyAndStop => json!({
            "behavior": "deny",
            "message": "A person declined this.",
        }),
    }
}

/// Now, as the conversation counts time.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Put an item in its place, replacing the earlier report of the same one.
fn replace_item(items: &mut Vec<ConversationItem>, item: ConversationItem) {
    match items.iter_mut().find(|existing| existing.id == item.id) {
        Some(existing) => *existing = item,
        None => items.push(item),
    }
}

/// When the agent says something happened, in milliseconds.
fn parse_timestamp_ms(timestamp: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(timestamp)
        .ok()
        .and_then(|moment| u64::try_from(moment.timestamp_millis()).ok())
}

#[cfg(test)]
mod test_support {
    use std::time::Duration;

    use serde_json::json;
    use tokio::sync::broadcast::Receiver;

    use super::*;

    pub(super) const SESSION: &str = "conversation-1";
    pub(super) const CWD: &str = "/Users/example/project";
    /// Long enough for a report to cross a channel, short enough that a report
    /// that never comes fails the test instead of stalling it.
    pub(super) const REPORT_TIMEOUT: Duration = Duration::from_secs(2);
    pub(super) fn init_frame(session_id: &str) -> Value {
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
    pub(super) fn assistant_frame(id: &str, content: Value) -> Value {
        json!({
            "type": "assistant",
            "uuid": "frame-1",
            "timestamp": "2026-08-20T10:15:48.336Z",
            "message": { "id": id, "role": "assistant", "content": content },
        })
    }
    pub(super) fn result_frame(stop_reason: Option<&str>) -> Value {
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
    pub(super) fn options(model: &str) -> ClaudeTurnOptions {
        ClaudeTurnOptions {
            model: Some(model.to_string()),
            ..ClaudeTurnOptions::default()
        }
    }

    /// A conversation the agent has already written, where it writes them.
    ///
    /// A session Caffold restarted under is one whose whole history is on
    /// disk, so a case about picking one up has to start from a file rather
    /// than from what a stand-in says next.
    pub(super) fn written_conversation() -> tempfile::TempDir {
        let projects = tempfile::tempdir().expect("a projects directory");
        transcript::plant(
            projects.path(),
            CWD,
            SESSION,
            include_str!("claude/transcript/a-session-claude-wrote.jsonl"),
        );
        projects
    }

    /// A client watching one conversation the stand-in has already greeted.
    pub(super) async fn watching() -> (ClaudeClient, MockRunnerHandle, Receiver<ClaudeRuntimeEvent>)
    {
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
    pub(super) async fn running_turn(
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
    pub(super) async fn spoken(runner: &MockRunnerHandle) -> Vec<String> {
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
    pub(super) async fn next_session_event(
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
    pub(super) async fn next_approval(
        events: &mut Receiver<ClaudeRuntimeEvent>,
    ) -> ApprovalRequest {
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
    pub(super) async fn next_diagnostic(events: &mut Receiver<ClaudeRuntimeEvent>) -> String {
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
    pub(super) fn kind_name(kind: &SessionEventKind) -> &'static str {
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

    /// Wait until the prompt has reached the agent, so what the agent says next
    /// is said to a session that is waiting for it.
    pub(super) async fn heard_the_prompt(runner: &MockRunnerHandle) {
        tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if runner
                    .heard(SESSION)
                    .await
                    .iter()
                    .any(|frame| frame["type"] == "user")
                {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the prompt reaches the agent");
    }

    /// Wait until the driver has written a frame the predicate accepts.
    pub(super) async fn wrote(
        runner: &MockRunnerHandle,
        accepted: impl Fn(&Value) -> bool,
    ) -> Value {
        tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if let Some(frame) = runner
                    .heard(SESSION)
                    .await
                    .iter()
                    .find(|frame| accepted(frame))
                {
                    return frame.clone();
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the driver answers")
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::test_support::*;
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn a_session_does_not_start_while_another_start_is_in_the_door() {
        // Two young processes can race the account's stored credentials — see
        // [`starting`] — so every start, however it is asked for, waits for
        // the one already going.
        let (client, runner) = ClaudeClient::mock();
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;
        let held = client.hold_starts_for_tests().await;

        let mut opening = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .open_conversation(SESSION, CWD, &options("opus"))
                    .await
            }
        });
        tokio::time::timeout(Duration::from_millis(10), &mut opening)
            .await
            .expect_err("the open waits at the door");

        drop(held);
        opening
            .await
            .expect("the task finishes")
            .expect("the conversation opens once the door is free");
    }

    #[tokio::test]
    async fn a_rejected_prompt_never_becomes_a_turn() {
        let (client, runner, mut events) = watching().await;
        runner
            .reject_next_send(SESSION, "NotAttached: subscribe before sending")
            .await;

        let refused = client
            .start_turn(SESSION, "run it", &[], &options("opus"))
            .await;

        assert!(
            matches!(
                refused,
                Err(ClaudeError::Runner(ref message))
                    if message == "NotAttached: subscribe before sending"
            ),
            "a runner rejection must not invent a turn: {refused:?}"
        );
        assert!(
            matches!(
                events.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ),
            "a prompt the runner refused reports no turn or active status"
        );
        assert!(
            runner.prompts(SESSION).await.is_empty(),
            "the rejected frame never reached the agent"
        );

        client
            .start_turn(SESSION, "try again", &[], &options("opus"))
            .await
            .expect("a rejected prompt leaves the session retryable");
        assert_eq!(spoken(&runner).await, vec!["try again"]);
    }

    #[tokio::test(start_paused = true)]
    async fn time_passing_does_not_report_or_activate_a_turn() {
        let (client, runner, mut events) = watching().await;
        runner.swallow_prompts(SESSION).await;

        let mut starting = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .start_turn(SESSION, "run it", &[], &options("opus"))
                    .await
            }
        });
        heard_the_prompt(&runner).await;

        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        assert!(
            matches!(
                events.try_recv(),
                Err(tokio::sync::broadcast::error::TryRecvError::Empty)
            ),
            "a clock is not a Claude runtime event"
        );

        assert!(
            !starting.is_finished(),
            "a clock says nothing about whether Claude began a turn"
        );
        let watched = client
            .watched_conversation(SESSION)
            .await
            .expect("the conversation is still watched");
        assert_eq!(watched.status, ThreadStatus::Idle);
        assert!(
            watched.turns.is_empty(),
            "silence must not be replaced with an invented turn: {:?}",
            watched.turns
        );
        runner.exit(SESSION, Some(0)).await;
        let stopped = tokio::time::timeout(REPORT_TIMEOUT, &mut starting)
            .await
            .expect("the exit releases the pending request")
            .expect("the start task finishes");
        assert!(
            matches!(stopped, Err(ClaudeError::Agent(ref message)) if message.contains("exited")),
            "an exit, not the clock, explains why the turn did not begin: {stopped:?}"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_exit_cannot_be_followed_by_a_late_turn_start() {
        let (client, runner, mut events) = watching().await;
        runner.swallow_prompts(SESSION).await;

        let mut starting = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .start_turn(SESSION, "run it", &[], &options("opus"))
                    .await
            }
        });
        heard_the_prompt(&runner).await;
        runner.exit(SESSION, Some(0)).await;

        let stopped = tokio::time::timeout(REPORT_TIMEOUT, &mut starting)
            .await
            .expect("the exit releases the pending request")
            .expect("the start task finishes");
        assert!(
            matches!(stopped, Err(ClaudeError::Agent(ref message)) if message.contains("exited")),
            "the request ends with the session: {stopped:?}"
        );

        let SessionEventKind::StatusChanged { status } =
            next_session_event(&mut events, "status change").await
        else {
            unreachable!("asked for a status change");
        };
        assert_eq!(status, ThreadStatus::Idle, "the exit is terminal");

        while let Ok(event) = events.try_recv() {
            if let ClaudeRuntimeEvent::Session(SessionEvent {
                kind:
                    SessionEventKind::TurnStarted { .. }
                    | SessionEventKind::StatusChanged {
                        status: ThreadStatus::Active { .. },
                    },
                ..
            }) = event
            {
                panic!("an ended session cannot become active again: {event:?}");
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_lost_runner_releases_a_prompt_without_inventing_its_turn() {
        let (client, runner, mut events) = watching().await;
        runner.swallow_prompts(SESSION).await;

        let mut starting = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .start_turn(SESSION, "run it", &[], &options("opus"))
                    .await
            }
        });
        heard_the_prompt(&runner).await;
        runner.vanish(SESSION).await;

        let unreachable = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                match events.recv().await {
                    Ok(ClaudeRuntimeEvent::Unreachable {
                        conversation_id, ..
                    }) => return conversation_id,
                    Ok(ClaudeRuntimeEvent::Session(SessionEvent {
                        kind:
                            SessionEventKind::TurnStarted { .. }
                            | SessionEventKind::StatusChanged {
                                status: ThreadStatus::Active { .. },
                            },
                        ..
                    })) => panic!("a lost session cannot report new work"),
                    Ok(_) => {}
                    Err(error) => panic!("the report channel stays open: {error}"),
                }
            }
        })
        .await
        .expect("the lost runner is reported as unreachable");
        assert_eq!(unreachable, SESSION);

        let stopped = tokio::time::timeout(REPORT_TIMEOUT, &mut starting)
            .await
            .expect("losing the runner releases the pending request")
            .expect("the start task finishes");
        assert!(
            matches!(stopped, Err(ClaudeError::Runner(ref message)) if message.contains("went away")),
            "the lost transport, not an invented turn, ends the request: {stopped:?}"
        );
        tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if client.watched_conversation(SESSION).await.is_none() {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the unreachable session is no longer watched");
    }

    #[tokio::test]
    async fn taking_up_a_live_session_is_not_spaced_as_a_start() {
        // A backend restart builds a fresh client over the same runner, and
        // every conversation it takes back up is a hand-back, not a spawn.
        // Spacing those would delay recovery by the spacing per Task, for
        // processes that were never young.
        let (first, runner) = ClaudeClient::mock();
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;
        first
            .open_conversation(SESSION, CWD, &options("opus"))
            .await
            .expect("the first backend opens the conversation");
        assert!(
            first.inner.starts.stamped_at_for_tests().await.is_some(),
            "the open that spawned the session counts as a start"
        );

        let second = ClaudeClient::with_runner(first.inner.runner.clone());
        second
            .open_conversation(SESSION, CWD, &options("opus"))
            .await
            .expect("the second backend takes the session up");

        assert_eq!(
            second.inner.starts.stamped_at_for_tests().await,
            None,
            "a session handed back started nothing, so nothing is spaced behind it"
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
                        "tool_use_id": "toolu_7",
                        "decision_reason": { "reason": "destructive command" },
                        "permission_suggestions": [
                            { "type": "addRules", "rules": ["Bash(rm:*)"] },
                            { "type": "setMode", "mode": "acceptEdits", "destination": "session" },
                            { "type": "addDirectories", "directories": ["/tmp"], "destination": "session" },
                        ],
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

        let overtaken = client
            .resolve_approval(SESSION, "req-gone", ApprovalDecision::Allow)
            .await;
        assert!(
            matches!(overtaken, Err(ClaudeError::NoSuchApproval(_))),
            "a question no longer waiting reads as that, not as an unwatched \
             conversation: {overtaken:?}"
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
        assert_eq!(
            answer["response"]["response"],
            json!({
                "behavior": "allow",
                "updatedPermissions": [
                    { "type": "addRules", "rules": ["Bash(rm:*)"] },
                    { "type": "setMode", "mode": "acceptEdits", "destination": "session" },
                    { "type": "addDirectories", "directories": ["/tmp"], "destination": "session" },
                ],
            }),
            "always hands the whole proposed grant back — a subset was probed \
             and does not stop the agent asking again — and no echoed or null \
             input rides along"
        );
    }

    #[test]
    fn an_allowance_never_carries_a_null_where_the_agent_expects_an_absence() {
        // The agent validates `updatedInput?: object` and rejects null — a
        // tool a person allowed then fails with "invalid permission result".
        let bare = approval_answer(ApprovalDecision::Allow, &Value::Null);
        assert_eq!(bare, json!({ "behavior": "allow" }));

        let always_unproposed = approval_answer(ApprovalDecision::AllowAlways, &Value::Null);
        assert_eq!(
            always_unproposed,
            json!({ "behavior": "allow" }),
            "no proposal from the agent, no invented grant and no null in its place"
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
            runner.prompts(SESSION).await.len(),
            1,
            "the prompt reached the same session, without attaching again"
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
                    .find(|frame| frame["request"]["subtype"] == "interrupt")
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
    async fn refusing_and_stopping_answers_the_agent_and_interrupts_its_turn() {
        // One decision, two promises: the agent hears the refusal, and the
        // turn it was refused in is told to stop rather than left to try the
        // next thing anyway.
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
                    "request_id": "req-19",
                    "request": {
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "input": { "command": "rm -rf build" },
                        "tool_use_id": "toolu_19",
                    },
                }),
            )
            .await;
        let request = next_approval(&mut events).await;

        client
            .resolve_approval(SESSION, &request.id, ApprovalDecision::DenyAndStop)
            .await
            .expect("the refusal is answered");

        let denied = wrote(&runner, |frame| frame["response"]["request_id"] == "req-19").await;
        assert_eq!(denied["response"]["response"]["behavior"], "deny");
        wrote(&runner, |frame| frame["request"]["subtype"] == "interrupt").await;
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
}
