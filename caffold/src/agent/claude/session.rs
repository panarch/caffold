//! Opening a session, and what a reopened one already was.
//!
//! A session is opened by attaching to the runner — which spawns the agent
//! for a fresh conversation, resumes it for one the agent wrote down, or
//! hands back the process a previous backend left running. A conversation
//! with a past is greeted, which is where the agent says what it was doing
//! and hands over every question it is still held up by.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;

use serde_json::Value;
use tokio::sync::Mutex as AsyncMutex;

use caffold_claude_runner::protocol::SessionState as RunnerSessionState;

use super::protocol::BASE_ARGUMENTS;
use super::runner::RunnerSession;
use super::{
    ClaudeClient, ClaudeError, ClaudeRuntimeEvent, ClaudeTurnOptions, Session, SessionState, Turn,
    TurnStatus, now_ms, protocol,
};

/// What asking a session to move came to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkingDirectoryMove {
    /// The session runs in the new directory now.
    Moved,
    /// The agent moves only between turns, and one is running. The same ask
    /// succeeds once it ends.
    TurnRunning,
}

/// How a session is being started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum SessionStart {
    /// A conversation that does not exist yet.
    Fresh,
    /// One the agent wrote to its own transcript and can pick up.
    Resume,
}

impl ClaudeClient {
    pub(super) async fn open_session(
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
            cwd: AsyncMutex::new(cwd.to_string()),
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
        match start {
            SessionStart::Fresh => {
                // Declaring what Caffold serves — and the once-only session
                // setup asking the agent to name the new Task — must land
                // before the first prompt, and needs nothing back: an answer
                // nobody registered for is dropped by the reader. Waiting for
                // it would put the agent's cold start in front of every Task
                // somebody creates, for a reply that says nothing a fresh
                // session needs.
                if let Err(error) = session
                    .send(protocol::control_request(
                        "caffold-hello",
                        protocol::initialize_request_for_a_new_task(),
                    ))
                    .await
                {
                    // A conversation whose open failed is not one this client
                    // holds; leaving it in would answer for a session nobody
                    // was ever handed.
                    self.inner.sessions.lock().await.remove(id);
                    return Err(error);
                }
            }
            SessionStart::Resume => self.take_up_what_was_already_happening(&session).await,
        }
        Ok(session)
    }

    /// Move a watched conversation's session into another directory.
    ///
    /// Where a session runs is also where the agent keeps its transcript —
    /// the CLI relocates the file with the move — so from here on the
    /// conversation is read, resumed, and erased where it now lives, which
    /// the application accounts for by asking for the worktree path whenever
    /// a Task has one.
    ///
    /// The agent may not trust the destination yet. It answers `needs_trust`
    /// with the directory it wants accepted, and the acceptance is echoed
    /// back on the user's behalf: the only directories Caffold moves a
    /// session into are worktrees Caffold itself made.
    pub(crate) async fn move_working_directory(
        &self,
        conversation_id: &str,
        path: &str,
    ) -> Result<WorkingDirectoryMove, ClaudeError> {
        let session = self.require_session(conversation_id).await?;
        let mut answer = session.control(protocol::set_cwd_request(path)).await?;
        if answer.payload.get("status").and_then(Value::as_str) == Some("needs_trust") {
            let directory = answer
                .payload
                .get("directory")
                .and_then(Value::as_str)
                .unwrap_or(path)
                .to_string();
            answer = session
                .control(protocol::set_cwd_trusted_request(path, &directory))
                .await?;
        }
        match answer.payload.get("status").and_then(Value::as_str) {
            Some("ok") => {
                *session.cwd.lock().await = path.to_string();
                Ok(WorkingDirectoryMove::Moved)
            }
            // The agent moves only between turns. Not a refusal: the same ask
            // succeeds the moment the running turn ends.
            Some("rejected")
                if answer.payload.get("reason").and_then(Value::as_str) == Some("busy") =>
            {
                Ok(WorkingDirectoryMove::TurnRunning)
            }
            answered => {
                let explanation = answer
                    .payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                Err(ClaudeError::Protocol(format!(
                    "the agent did not move to {path}: set_cwd answered {}{}{explanation}",
                    answered.unwrap_or("nothing"),
                    if explanation.is_empty() { "" } else { " — " },
                )))
            }
        }
    }

    /// Learn what this session was doing before Caffold was here.
    ///
    /// A session the runner held across a restart of this process has a past
    /// that nothing in this process remembers: a prompt may still be
    /// outstanding, and questions may be waiting on an answer that the client
    /// which was asked them is no longer around to give. The agent keeps both
    /// and hands them over when a client says hello, which is what this is.
    ///
    /// Only for a conversation that had a past. A session started here and now
    /// has nothing outstanding by construction, and asking anyway would put the
    /// wait for an agent to come up in front of every Task somebody creates.
    async fn take_up_what_was_already_happening(&self, session: &Arc<Session>) {
        let hello = match session.control(protocol::initialize_request()).await {
            Ok(hello) => hello,
            Err(error) => {
                self.publish(ClaudeRuntimeEvent::Diagnostic {
                    message: format!("claude {} did not say hello: {error}", session.id),
                });
                return;
            }
        };
        let working = hello.payload.get("session_state").and_then(Value::as_str) == Some("running");
        if working
            && let Some(turn) = self
                .turn_left_running(&session.id, &session.cwd.lock().await.clone())
                .await
        {
            let mut state = session.state.lock().await;
            state.active_turn = Some(turn.id.clone());
            state.turns = vec![turn];
        }
        // Asked again exactly as they were first asked, so a question the agent
        // is held up by reaches the reader by the path every other question
        // takes. Nothing here decides what any of them means.
        for question in hello.unanswered {
            self.handle_line(session, &question.to_string()).await;
        }
    }

    /// The turn a session is in the middle of, once the agent has said it is
    /// in one.
    ///
    /// The agent answers *that* a prompt is outstanding and not *which* turn it
    /// belongs to, so which one is read from the conversation the agent writes
    /// for itself: a prompt still being answered opened the newest turn there.
    ///
    /// Without this, work arriving for a turn nothing knows about is dropped as
    /// belonging to nothing, and the Task reads as idle for as long as the turn
    /// runs — which is exactly as long as there is something to watch.
    async fn turn_left_running(&self, id: &str, cwd: &str) -> Option<Turn> {
        // The newest turn the conversation holds, which is the one the prompt
        // the runner is still waiting on opened.
        let mut turn = self.newest_filed_turn(cwd, id).await?;
        turn.status = TurnStatus::InProgress;
        Some(turn)
    }
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

#[cfg(test)]
mod tests {

    use serde_json::json;

    use super::super::test_support::*;
    use super::super::*;

    use super::super::test_support::written_conversation;

    #[tokio::test]
    async fn a_session_still_working_is_picked_up_in_the_turn_it_is_working_on() {
        // Caffold restarted while the agent was answering. The agent kept
        // working and says so when it is greeted; the turn that prompt opened is
        // read from what the agent has written so far. Without both, the rest of
        // that turn arrives for a turn nothing knows about and is dropped, and
        // the Task reads as idle for exactly as long as there is something to
        // watch.
        let projects = written_conversation();
        let (client, runner) = ClaudeClient::mock_writing_to(projects.path().to_path_buf());
        runner
            .greet_next_session_as(json!({ "response": { "session_state": "running" } }))
            .await;
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;

        client
            .open_conversation(SESSION, CWD, &options("opus"))
            .await
            .expect("the conversation opens");

        let page = client.read_turns(SESSION, CWD, None, 8).await;
        let running = page.turns.first().expect("the turn it was working on");
        assert_eq!(running.id, "e848560b-26f6-4bcf-92e2-86539d420ab9");
        assert_eq!(running.status, TurnStatus::InProgress);
    }

    #[tokio::test]
    async fn a_conversation_waiting_on_a_person_is_not_idle_without_a_turn_to_show() {
        // A conversation taken up while the agent was already blocked has the
        // question before it has the turn the question belongs to. Read as idle
        // in that moment, the Task withdraws the very question it just
        // recovered, and the agent waits for an answer nobody can give.
        let projects = written_conversation();
        let (client, runner) = ClaudeClient::mock_writing_to(projects.path().to_path_buf());
        runner
            .greet_next_session_as(json!({
                "response": { "session_state": "running" },
                "pending_permission_requests": [{
                    "type": "control_request",
                    "request_id": "req-left-waiting",
                    "request": {
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "input": { "command": "rm -rf build" },
                        "toolUseID": "toolu_7",
                    },
                }],
            }))
            .await;
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;
        client
            .open_conversation(SESSION, CWD, &options("opus"))
            .await
            .expect("the conversation opens");

        let session = client.session(SESSION).await.expect("the session");
        {
            // The turn it belongs to is not always recoverable, and the
            // question is outstanding either way.
            let mut state = session.state.lock().await;
            state.active_turn = None;
        }

        let status = status_of(&*session.state.lock().await);
        assert_eq!(
            status,
            ThreadStatus::Active {
                active_flags: vec![ThreadActiveFlag::WaitingOnApproval],
            },
        );
    }

    #[tokio::test]
    async fn a_question_the_agent_is_held_up_by_comes_back_when_it_is_greeted() {
        // The client that was asked is gone, and the agent is waiting on an
        // answer only a client can give. It hands the question back, as it
        // asked it, to whichever client says hello next — so the question
        // arrives here by the path every other question takes, and nothing has
        // to be kept anywhere in the meantime.
        let projects = written_conversation();
        let (client, runner) = ClaudeClient::mock_writing_to(projects.path().to_path_buf());
        let events = client.subscribe();
        runner
            .greet_next_session_as(json!({
                "response": { "session_state": "running" },
                "pending_permission_requests": [{
                    "type": "control_request",
                    "request_id": "req-left-waiting",
                    "request": {
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "input": { "command": "rm -rf build" },
                        "toolUseID": "toolu_7",
                    },
                }],
            }))
            .await;
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;

        client
            .open_conversation(SESSION, CWD, &options("opus"))
            .await
            .expect("the conversation opens");

        let mut events = events;
        let asked = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if let Ok(ClaudeRuntimeEvent::Approval { request, .. }) = events.recv().await {
                    return request;
                }
            }
        })
        .await
        .expect("the question is put to somebody who can answer it");
        assert_eq!(asked.id, "req-left-waiting");
    }

    #[tokio::test]
    async fn a_session_working_on_nothing_is_picked_up_with_no_turn_open() {
        // The half that keeps the other half honest. Taken as running without
        // asking, every conversation would show its last turn as never having
        // ended.
        let projects = written_conversation();
        let (client, runner) = ClaudeClient::mock_writing_to(projects.path().to_path_buf());
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;

        client
            .open_conversation(SESSION, CWD, &options("opus"))
            .await
            .expect("the conversation opens");

        let page = client.read_turns(SESSION, CWD, None, 8).await;
        assert!(
            page.turns
                .iter()
                .all(|turn| turn.status == TurnStatus::Completed),
            "nothing is outstanding: {:?}",
            page.turns
                .iter()
                .map(|turn| turn.status)
                .collect::<Vec<_>>()
        );
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
    async fn a_fresh_session_declares_what_caffold_serves_before_anything_else() {
        let (client, runner) = ClaudeClient::mock();
        let conversation = client
            .start_conversation(CWD, &options("opus"))
            .await
            .expect("the conversation opens");

        let heard = runner.heard(&conversation.id).await;
        let hello = heard.first().expect("the declaration is the first word");
        assert_eq!(hello["type"], "control_request");
        assert_eq!(hello["request"]["subtype"], "initialize");
        assert_eq!(hello["request"]["sdkMcpServers"], json!(["caffold"]));
        // A fresh session is a newly created Task, so its hello also carries
        // the once-only setup asking the agent to name it on the first turn.
        assert!(hello["request"]["appendSystemPrompt"].is_string());
    }

    #[tokio::test]
    async fn a_session_taken_back_up_declares_the_same_way_it_greets() {
        // `sdkMcpServers` is processed on every initialize, so the greeting a
        // re-attached session already sends is also its declaration.
        let (_client, runner, _events) = watching().await;

        let heard = runner.heard(SESSION).await;
        let hello = heard.first().expect("the greeting is the first word");
        assert_eq!(hello["request"]["subtype"], "initialize");
        assert_eq!(hello["request"]["sdkMcpServers"], json!(["caffold"]));
        // But not the new-Task setup: this conversation is not newly created,
        // and its first turn has long since happened.
        assert!(hello["request"].get("appendSystemPrompt").is_none());
    }

    #[tokio::test]
    async fn moving_a_session_accepts_the_trust_the_agent_demands() {
        // The agent has never seen the worktree, so it answers `needs_trust`
        // before it moves. The acceptance is echoed on the user's behalf —
        // the destination is a directory Caffold itself made — and only the
        // `ok` that follows counts as having moved.
        let (client, runner, _events) = watching().await;
        runner.demand_trust_for_moves(SESSION).await;

        client
            .move_working_directory(SESSION, "/somewhere/worktrees/task-1")
            .await
            .expect("the session moves");

        let moves: Vec<Value> = runner
            .heard(SESSION)
            .await
            .into_iter()
            .filter(|frame| frame["request"]["subtype"] == "set_cwd")
            .collect();
        assert_eq!(moves.len(), 2, "asked plainly, then with trust accepted");
        assert!(moves[0]["request"].get("trust_accepted").is_none());
        assert_eq!(moves[1]["request"]["trust_accepted"], true);
        assert_eq!(
            moves[1]["request"]["trusted_directory"], "/somewhere/worktrees/task-1",
            "the trusted directory is the one the agent's answer named"
        );
    }

    #[tokio::test]
    async fn a_move_asked_mid_turn_reports_the_turn_rather_than_failing() {
        // `busy` is not a refusal: the same ask succeeds the moment the
        // running turn ends, and the caller decides when to ask again.
        let (client, runner, _events) = watching().await;
        runner.refuse_moves_while_busy(SESSION, 1).await;

        assert_eq!(
            client
                .move_working_directory(SESSION, "/somewhere/worktrees/task-1")
                .await
                .unwrap(),
            WorkingDirectoryMove::TurnRunning
        );
        assert_eq!(
            client
                .move_working_directory(SESSION, "/somewhere/worktrees/task-1")
                .await
                .unwrap(),
            WorkingDirectoryMove::Moved
        );
    }

    #[tokio::test]
    async fn moving_a_trusted_session_asks_once_and_is_done() {
        let (client, runner, _events) = watching().await;

        client
            .move_working_directory(SESSION, "/somewhere/worktrees/task-1")
            .await
            .expect("the session moves");

        let moves = runner
            .heard(SESSION)
            .await
            .into_iter()
            .filter(|frame| frame["request"]["subtype"] == "set_cwd")
            .count();
        assert_eq!(moves, 1);
    }
}
