//! Claude's runner adapter and protocol-aware test double.
//!
//! Socket transport is shared with other drivers. This owner keeps Claude
//! errors, JSON frame construction and the mock that speaks Claude's protocol.

use std::path::Path;

use caffold_runner::protocol::{SessionInfo, SpawnRequest};
use caffold_runner::{SOCKET_NAME, protocol};
use serde_json::Value;
use serde_json::value::RawValue;

use super::ClaudeError;
use crate::agent::runner::{
    RunnerClient as TransportClient, RunnerError, SessionEvents, SessionFrames as TransportFrames,
};

#[derive(Clone)]
pub(crate) enum RunnerClient {
    Socket(TransportClient),
    #[cfg(test)]
    Mock(MockRunnerHandle),
}

pub(crate) struct RunnerSession {
    pub(crate) info: SessionInfo,
    pub(crate) frames: SessionFrames,
    pub(crate) events: SessionEvents,
}

pub(crate) enum SessionFrames {
    Socket(TransportFrames),
    #[cfg(test)]
    Mock(mock::Frames),
}

impl RunnerClient {
    pub(crate) fn in_data_dir(data_dir: &Path) -> Self {
        Self::Socket(TransportClient::at_socket(data_dir.join(SOCKET_NAME)))
    }

    pub(crate) async fn open(
        &self,
        session: &str,
        spawn: SpawnRequest,
    ) -> Result<RunnerSession, ClaudeError> {
        match self {
            Self::Socket(client) => {
                let opened = client.open(session, spawn).await?;
                Ok(RunnerSession {
                    info: opened.info,
                    frames: SessionFrames::Socket(opened.frames),
                    events: opened.events,
                })
            }
            #[cfg(test)]
            Self::Mock(mock) => mock.open(session, spawn).await,
        }
    }

    pub(crate) async fn status(&self) -> Option<protocol::DaemonStatus> {
        match self {
            Self::Socket(client) => client.status().await,
            #[cfg(test)]
            Self::Mock(mock) => Some(mock.status().await),
        }
    }

    pub(super) fn socket_problem(&self) -> Option<String> {
        match self {
            Self::Socket(client) => client.socket_problem(),
            #[cfg(test)]
            Self::Mock(_) => None,
        }
    }

    pub(crate) async fn live_sessions(&self) -> Vec<String> {
        match self {
            Self::Socket(client) => client.live_sessions().await,
            #[cfg(test)]
            Self::Mock(mock) => mock.live_sessions().await,
        }
    }

    pub(crate) async fn restart(&self) -> Result<protocol::DaemonStatus, ClaudeError> {
        match self {
            Self::Socket(client) => client.restart().await.map_err(Into::into),
            #[cfg(test)]
            Self::Mock(mock) => Ok(mock.restart().await),
        }
    }

    pub(crate) async fn close(&self, session: &str) -> Result<(), ClaudeError> {
        match self {
            Self::Socket(client) => client.close(session).await.map_err(Into::into),
            #[cfg(test)]
            Self::Mock(mock) => {
                mock.close(session).await;
                Ok(())
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn mock() -> (Self, MockRunnerHandle) {
        let mock = MockRunnerHandle::new();
        (Self::Mock(mock.clone()), mock)
    }

    #[cfg(test)]
    pub(super) fn is_mock(&self) -> bool {
        matches!(self, Self::Mock(_))
    }
}

impl SessionFrames {
    pub(crate) async fn send(&mut self, frame: Value) -> Result<(), ClaudeError> {
        match self {
            Self::Socket(frames) => {
                let encoded = serde_json::to_string(&frame)
                    .map_err(|error| ClaudeError::Protocol(error.to_string()))?;
                let raw = RawValue::from_string(encoded)
                    .map_err(|error| ClaudeError::Protocol(error.to_string()))?;
                frames.send(raw).await.map_err(Into::into)
            }
            #[cfg(test)]
            Self::Mock(frames) => frames.send(frame).await,
        }
    }
}

impl From<RunnerError> for ClaudeError {
    fn from(error: RunnerError) -> Self {
        Self::Runner(error.to_string())
    }
}

#[cfg(test)]
pub(crate) use mock::MockRunnerHandle;

#[cfg(test)]
mod mock {
    use super::{ClaudeError, RunnerSession, SessionFrames};
    use crate::agent::runner::{RunnerEvent, SessionEvents};
    use caffold_runner::{
        protocol,
        protocol::{SessionInfo, SpawnRequest},
    };
    use serde_json::Value;
    use std::collections::HashMap;
    use std::sync::Arc;
    use tokio::sync::{Mutex as AsyncMutex, mpsc};

    // ---------------------------------------------------------------------------
    // The stand-in
    // ---------------------------------------------------------------------------

    /// A runner that starts nothing.
    ///
    /// It is the runner and the agent at once, because from Caffold's side those
    /// are one thing reached through one pipe. A test writes what the agent says
    /// and reads what the driver wrote back, and everything between the two is the
    /// same code the real runner drives.
    #[derive(Default)]
    struct MockRunner {
        state: AsyncMutex<MockRunnerState>,
    }

    #[derive(Default)]
    struct MockRunnerState {
        sessions: HashMap<String, MockSession>,
        /// What the next session created will say the moment it is attached.
        greeting: Vec<Value>,
        /// What the next session created will answer when it is greeted: the state
        /// it was already in, and the questions it is already held up by.
        hello: Value,
    }

    /// A session that has just started and is holding nothing up.
    fn default_hello() -> Value {
        serde_json::json!({ "response": { "session_state": "idle" } })
    }

    struct MockSession {
        spawn: SpawnRequest,
        /// What this session answers when it is greeted.
        hello: Value,
        agent: mpsc::UnboundedSender<RunnerEvent>,
        heard: Vec<Value>,
        /// Whether the agent behind it has exited. The daemon keeps an exited
        /// session listed, and asking for it again spawns a replacement.
        exited: bool,
        /// Hand every prompt back marked as a replay, the way a session an
        /// earlier Caffold started with `--replay-user-messages` still does.
        hands_prompts_back: bool,
        /// Refuse the next frame before it reaches the agent, the way the daemon
        /// refuses a `SessionSend` it cannot accept.
        reject_next_send: Option<String>,
        distrusts_moves: bool,
        refuses_moves: u32,
        holds_next_move: bool,
        held_move_answer: Option<Value>,
        holds_next_stop: bool,
        /// The request a held-back stop is answered under.
        held_stop: Option<String>,
    }

    /// What a test speaks to a stand-in runner through.
    #[derive(Clone)]
    pub(crate) struct MockRunnerHandle(Arc<MockRunner>);

    pub(crate) struct Frames {
        session: String,
        runner: Arc<MockRunner>,
    }

    impl Frames {
        pub(super) async fn send(&mut self, frame: Value) -> Result<(), ClaudeError> {
            self.runner.heard(&self.session, frame).await
        }
    }

    impl MockRunnerHandle {
        pub(super) fn new() -> Self {
            Self(Arc::new(MockRunner::default()))
        }
        pub(super) async fn open(
            &self,
            session: &str,
            spawn: SpawnRequest,
        ) -> Result<RunnerSession, ClaudeError> {
            MockRunner::open(&self.0, session, spawn).await
        }
        pub(super) async fn status(&self) -> protocol::DaemonStatus {
            self.0.status().await
        }
        pub(super) async fn live_sessions(&self) -> Vec<String> {
            self.0.state.lock().await.sessions.keys().cloned().collect()
        }
        pub(super) async fn restart(&self) -> protocol::DaemonStatus {
            self.0.restart().await
        }
        pub(super) async fn close(&self, session: &str) {
            self.0.close(session).await
        }
    }

    impl MockRunner {
        async fn open(
            runner: &Arc<Self>,
            session: &str,
            spawn: SpawnRequest,
        ) -> Result<RunnerSession, ClaudeError> {
            let mut state = runner.state.lock().await;
            let (sender, receiver) = mpsc::unbounded_channel();
            for frame in state.greeting.drain(..).collect::<Vec<_>>() {
                let _ = sender.send(RunnerEvent::Frame(frame.to_string()));
            }
            let hello = std::mem::replace(&mut state.hello, default_hello());
            // The way the daemon answers it: only the open that brought the
            // session into being says it started something, and an exited one is
            // replaced, which is a beginning again.
            let spawned = match state.sessions.get(session) {
                Some(held) => held.exited,
                None => true,
            };
            state.sessions.insert(
                session.to_string(),
                MockSession {
                    spawn,
                    hello,
                    agent: sender,
                    heard: Vec::new(),
                    exited: false,
                    hands_prompts_back: false,
                    reject_next_send: None,
                    distrusts_moves: false,
                    refuses_moves: 0,
                    holds_next_move: false,
                    held_move_answer: None,
                    holds_next_stop: false,
                    held_stop: None,
                },
            );
            Ok(RunnerSession {
                info: SessionInfo {
                    session: session.to_string(),
                    state: protocol::SessionState::Running,
                    pid: Some(4242),
                    attached: true,
                    spawned,
                    exit_code: None,
                    incarnation: None,
                },
                frames: SessionFrames::Mock(Frames {
                    session: session.to_string(),
                    runner: runner.clone(),
                }),
                events: SessionEvents::from_channel(receiver),
            })
        }

        async fn heard(&self, session: &str, frame: Value) -> Result<(), ClaudeError> {
            let mut state = self.state.lock().await;
            let Some(existing) = state.sessions.get_mut(session) else {
                return Err(ClaudeError::Runner(format!(
                    "UnknownSession: no session named {session}"
                )));
            };
            if let Some(message) = existing.reject_next_send.take() {
                return Err(ClaudeError::Runner(message));
            }
            // The agent files a message under the name on its frame, and Caffold
            // reads the turn back by that name. A stand-in that took a nameless
            // message would let a turn be split without any test noticing.
            if frame["type"] == "user" && !frame["uuid"].is_string() {
                return Err(ClaudeError::Protocol(format!(
                    "a user message sent to {session} carries no name"
                )));
            }
            let holds_stop = frame["type"] == "control_request"
                && frame["request"]["subtype"] == "interrupt"
                && std::mem::take(&mut existing.holds_next_stop);
            if holds_stop {
                existing.held_stop = frame["request_id"].as_str().map(str::to_string);
            }
            // Measured against CLI 2.1.316: only a session started in
            // `bypassPermissions`, or allowed to enter it, can be switched in.
            let argv = &existing.spawn.argv;
            if frame["type"] == "control_request"
                && frame["request"]["subtype"] == "set_permission_mode"
                && frame["request"]["mode"] == "bypassPermissions"
                && !argv
                    .iter()
                    .any(|argument| argument == "--allow-dangerously-skip-permissions")
                && !argv
                    .windows(2)
                    .any(|pair| pair[0] == "--permission-mode" && pair[1] == "bypassPermissions")
                && let Some(request_id) = frame["request_id"].as_str()
            {
                let refusal = serde_json::json!({ "type": "control_response", "response": {
                    "subtype": "error",
                    "request_id": request_id,
                    "error": "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions",
                    "error_code": "bypass_not_launched",
                } });
                let _ = existing.agent.send(RunnerEvent::Frame(refusal.to_string()));
                existing.heard.push(frame);
                return Ok(());
            }
            // The agent answers what it is asked. A stand-in that stayed silent
            // would not stand in for it: every caller waiting on a control request
            // would wait out its whole timeout.
            if !holds_stop
                && frame["type"] == "control_request"
                && let Some(request_id) = frame["request_id"].as_str()
            {
                let mut body = if frame["request"]["subtype"] == "initialize" {
                    existing.hello.clone()
                } else if frame["request"]["subtype"] == "set_cwd" {
                    // The real agent moves only between turns and demands trust
                    // for a directory it has not seen; a stand-in that always
                    // moved would leave both halves of the dance untested.
                    if existing.refuses_moves > 0 {
                        existing.refuses_moves -= 1;
                        serde_json::json!({ "response": {
                            "status": "rejected",
                            "reason": "busy",
                            "message": "A turn is in progress.",
                        } })
                    } else if existing.distrusts_moves && frame["request"]["trust_accepted"] != true
                    {
                        serde_json::json!({ "response": {
                            "status": "needs_trust",
                            "directory": frame["request"]["path"],
                        } })
                    } else {
                        serde_json::json!({ "response": {
                            "status": "ok",
                            "cwd": frame["request"]["path"],
                            "changed": true,
                            "transcript_relocated": true,
                        } })
                    }
                } else if frame["request"]["subtype"] == "get_context_usage" {
                    // Trimmed from what the agent answered after one short turn:
                    // what Caffold reads, beside some of what it does not.
                    serde_json::json!({ "response": {
                        "totalTokens": 29_669,
                        "maxTokens": 200_000,
                        "percentage": 15,
                        "autoCompactThreshold": 167_000,
                        "categories": [{ "name": "Messages", "tokens": 1 }],
                        "apiUsage": {
                            "input_tokens": 10,
                            "output_tokens": 61,
                            "cache_creation_input_tokens": 7_780,
                            "cache_read_input_tokens": 13_796,
                        },
                    } })
                } else {
                    serde_json::json!({ "response": {} })
                };
                let moved =
                    frame["request"]["subtype"] == "set_cwd" && body["response"]["status"] == "ok";
                body["subtype"] = serde_json::json!("success");

                body["request_id"] = serde_json::json!(request_id);
                let answer = serde_json::json!({ "type": "control_response", "response": body });
                if moved && std::mem::take(&mut existing.holds_next_move) {
                    existing.held_move_answer = Some(answer);
                } else {
                    let _ = existing.agent.send(RunnerEvent::Frame(answer.to_string()));
                }
            }
            // A session started with `--replay-user-messages` hands a prompt back
            // under the name it was sent with. Sessions started now are not, and
            // say nothing until they have something to say.
            if frame["type"] == "user" && existing.hands_prompts_back {
                let mut replay = frame.clone();
                replay["isReplay"] = serde_json::json!(true);
                let _ = existing.agent.send(RunnerEvent::Frame(replay.to_string()));
            }
            existing.heard.push(frame);
            Ok(())
        }

        /// End a session as the daemon does: the child is stopped and its exit
        /// reported before the session is forgotten.
        async fn close(&self, session: &str) {
            let mut state = self.state.lock().await;
            if let Some(held) = state.sessions.remove(session) {
                let _ = held.agent.send(RunnerEvent::Exit(None));
            }
        }

        /// Restart as the real runner restarts: every session ends, and the
        /// replacement holds nothing.
        async fn restart(&self) -> protocol::DaemonStatus {
            let mut state = self.state.lock().await;
            for (_, session) in state.sessions.drain() {
                let _ = session.agent.send(RunnerEvent::Exit(Some(0)));
            }
            drop(state);
            self.status().await
        }

        /// Answer as the real runner answers, holding whatever the test opened.
        async fn status(&self) -> protocol::DaemonStatus {
            protocol::DaemonStatus {
                protocol_version: protocol::PROTOCOL_VERSION,
                runner_version: "stand-in".to_string(),
                pid: 4242,
                socket: "stand-in".to_string(),
                sessions: self.state.lock().await.sessions.len(),
                recovery_version: Some(protocol::RECOVERY_VERSION),
                idle_timeout_secs: Some(600),
                unsubscribed_for_secs: None,
            }
        }
    }

    impl MockRunnerHandle {
        /// What the next session created will say as soon as it is attached.
        ///
        /// A driver that opens a conversation waits for the agent to introduce
        /// itself before it answers, so the greeting has to be there before the
        /// session is.
        pub(crate) async fn greet_next_session_with(&self, frames: Vec<Value>) {
            self.0.state.lock().await.greeting = frames;
        }

        /// What the next session created will answer when it is greeted.
        ///
        /// A session the runner held across a restart of the client answers with
        /// the state it was already in and the questions it is already held up by,
        /// and that answer is the only way the client learns either.
        pub(crate) async fn greet_next_session_as(&self, hello: Value) {
            self.0.state.lock().await.hello = hello;
        }

        /// Say one more thing as the agent, now.
        pub(crate) async fn say(&self, session: &str, frame: Value) {
            let state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get(session) {
                let _ = held.agent.send(RunnerEvent::Frame(frame.to_string()));
            }
        }

        /// Hand every prompt back, as a session an earlier Caffold started with
        /// `--replay-user-messages` still does.
        pub(crate) async fn hand_prompts_back(&self, session: &str) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session) {
                held.hands_prompts_back = true;
            }
        }

        /// Refuse the next frame before the agent hears it.
        pub(crate) async fn reject_next_send(&self, session: &str, message: &str) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session) {
                held.reject_next_send = Some(message.to_string());
            }
        }

        /// Demand trust before the next move, the way the real agent does for a
        /// directory it has not seen.
        pub(crate) async fn demand_trust_for_moves(&self, session: &str) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session) {
                held.distrusts_moves = true;
            }
        }

        /// Refuse the next `times` moves as mid-turn, the way the real agent does
        /// while a turn is running.
        pub(crate) async fn refuse_moves_while_busy(&self, session: &str, times: u32) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session) {
                held.refuses_moves = times;
            }
        }

        /// Hold back the answer to the next move that lands, until
        /// [`Self::answer_held_move`].
        ///
        /// The real agent moves what it wrote into the new directory first and
        /// answers only once it has settled there, so a move can be done and not
        /// yet answered.
        pub(crate) async fn hold_next_move_answer(&self, session: &str) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session) {
                held.holds_next_move = true;
            }
        }

        /// Send the move answer held back.
        pub(crate) async fn answer_held_move(&self, session: &str) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session)
                && let Some(answer) = held.held_move_answer.take()
            {
                let _ = held.agent.send(RunnerEvent::Frame(answer.to_string()));
            }
        }

        /// Hold back the answer to the next stop, until
        /// [`Self::answer_held_stop`].
        ///
        /// The real agent answers a stop a moment before the stopped turn's
        /// result, and names in that answer what it cancelled with the turn.
        pub(crate) async fn hold_next_stop_answer(&self, session: &str) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session) {
                held.holds_next_stop = true;
            }
        }

        /// Answer the stop held back with the `receipt` the agent gives, which says
        /// what it cancelled along with the turn.
        pub(crate) async fn answer_held_stop(&self, session: &str, receipt: Value) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session)
                && let Some(request_id) = held.held_stop.take()
            {
                let answer = serde_json::json!({ "type": "control_response", "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": receipt,
                } });
                let _ = held.agent.send(RunnerEvent::Frame(answer.to_string()));
            }
        }

        /// Go away without a word, the way a runner killed outright does.
        ///
        /// Distinct from the agent exiting, which is something the runner is there
        /// to report. Here the reporting itself stops.
        pub(crate) async fn vanish(&self, session: &str) {
            self.0.state.lock().await.sessions.remove(session);
        }

        /// End the session as the agent exiting.
        pub(crate) async fn exit(&self, session: &str, code: Option<i32>) {
            let mut state = self.0.state.lock().await;
            if let Some(held) = state.sessions.get_mut(session) {
                held.exited = true;
                let _ = held.agent.send(RunnerEvent::Exit(code));
            }
        }

        /// Everything the driver wrote to that session.
        pub(crate) async fn heard(&self, session: &str) -> Vec<Value> {
            let state = self.0.state.lock().await;
            state
                .sessions
                .get(session)
                .map(|held| held.heard.clone())
                .unwrap_or_default()
        }

        /// What the session was asked to do, without the housekeeping around it.
        ///
        /// Every session is greeted the moment it opens, so a test about prompts
        /// has to say that prompts are what it means.
        pub(crate) async fn prompts(&self, session: &str) -> Vec<Value> {
            self.heard(session)
                .await
                .into_iter()
                .filter(|frame| frame["type"] == "user")
                .collect()
        }

        /// How the session was started.
        pub(crate) async fn spawned(&self, session: &str) -> Option<SpawnRequest> {
            let state = self.0.state.lock().await;
            state.sessions.get(session).map(|held| held.spawn.clone())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mock_has_no_socket_problem() {
        let (mock, _handle) = RunnerClient::mock();
        assert_eq!(mock.socket_problem(), None, "a mock has no socket to cap");
    }
}
