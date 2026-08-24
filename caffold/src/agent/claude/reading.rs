//! Reading what the agent said, as it says it.
//!
//! One reader per session pumps every frame the agent writes: the
//! conversation stream opens and closes turns, control requests surface as
//! approvals or served-tool calls, and the stream ending is the difference
//! between an agent that exited and a runner that went away mid-sentence.

use std::sync::Arc;

use serde_json::{Value, json};

use super::runner::{self, RunnerEvent};
use super::translate::message_items;
use super::{
    ActivityStatus, ApprovalDecision, ApprovalDetail, ApprovalRequest, ClaudeClient, ClaudeError,
    ClaudeRuntimeEvent, ControlRequestFrame, ConversationItem, Introduction, ItemKind,
    MINIMUM_SUPPORTED_CLAUDE_CLI_VERSION, MessageFrame, PendingApproval, ResultFrame, Session,
    SessionEventKind, StreamFrame, SystemFrame, ThreadStatus, TokenCount, TokenUsage, TurnStatus,
    end_pending_prompt, now_ms, open_pending_turn, parse_timestamp_ms, protocol, replace_item,
    status_of,
};

impl ClaudeClient {
    /// Whether a written prompt is still waiting to learn its turn's name.
    async fn awaiting_a_turn_name(&self, session: &Arc<Session>) -> bool {
        let state = session.state.lock().await;
        state.pending_prompt.is_some() && state.active_turn.is_none()
    }

    /// The name the agent filed the pending prompt under.
    ///
    /// Asked of the conversation on disk when the prompt has not come home: the
    /// agent files a prompt the moment it takes one, so the newest turn there
    /// is the one the pending prompt opened, under the name every later reader
    /// of the file will use. A name this session already knows is an older turn
    /// read ahead of a prompt not yet flushed, and is refused — new work must
    /// not be filed into a turn that already ended.
    async fn filed_prompt_name(&self, session: &Arc<Session>) -> Option<String> {
        let cwd = session.cwd.lock().await.clone();
        let candidate = self.newest_filed_turn(&cwd, &session.id).await?.id;
        let state = session.state.lock().await;
        if state.turns.iter().any(|turn| turn.id == candidate) {
            return None;
        }
        Some(candidate)
    }

    /// Read one session for as long as it says anything.
    pub(super) fn spawn_reader(&self, session: Arc<Session>, mut events: runner::SessionEvents) {
        let client = self.clone();
        tokio::spawn(async move {
            let mut said_goodbye = false;
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
                        said_goodbye = true;
                        break;
                    }
                }
            }
            // A session that stops speaking is no longer one Caffold can drive,
            // whether it exited or the connection went away.
            if !said_goodbye {
                {
                    let mut state = session.state.lock().await;
                    state.ended = true;
                    state.active_turn = None;
                    end_pending_prompt(
                        &mut state,
                        ClaudeError::Runner(format!(
                            "the Claude runner went away before conversation {} identified its prompt",
                            session.id
                        )),
                    );
                }
            }
            client.inner.sessions.lock().await.remove(&session.id);
            if !said_goodbye {
                // Nothing said it was ending, so the runner went away under it.
                // Said out loud rather than dropped: everything Caffold last
                // heard would otherwise stand as the current state of a
                // conversation nothing can reach, and the way back to it is to
                // open it again — which nobody does for a Task that looks like
                // it is already being watched.
                client.publish(ClaudeRuntimeEvent::Unreachable {
                    conversation_id: session.id.clone(),
                    message: "the Claude runner went away".to_string(),
                });
            }
        });
    }

    pub(super) async fn handle_line(&self, session: &Arc<Session>, line: &str) {
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
            StreamFrame::Assistant(message) => self.handle_message(session, message, false).await,
            StreamFrame::User(message) => self.handle_message(session, message, true).await,
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

    async fn handle_message(
        &self,
        session: &Arc<Session>,
        frame: MessageFrame,
        spoken_by_user: bool,
    ) {
        // A subagent's messages belong to the tool call that started it, which
        // the conversation already shows. Folding them in would interleave two
        // conversations under one turn.
        if frame.parent_tool_use_id.is_some() {
            return;
        }
        if frame.is_replay {
            self.handle_replayed_prompt(session, frame).await;
            return;
        }
        let awaiting_name = self.awaiting_a_turn_name(session).await;
        if awaiting_name && spoken_by_user {
            // A user frame between the prompt going in and the prompt coming
            // home is the prompt's own reflection — the resize note a large
            // image earns, or a replay that lost its marking — not new work.
            // Taken as the agent answering unprompted, it would name the turn
            // with an invented id while the file names it something else, and
            // the same answer would then stand twice, once under each name.
            // The file keeps whatever the reflection said, so nothing is lost
            // by not drawing it live.
            return;
        }
        // The name the turn will be known by, read from the conversation on
        // disk when the prompt has not come home. Some sessions never hand one
        // back — a session started before Caffold began asking still has the
        // arguments it was started with — and the file names their turns too.
        let filed = if awaiting_name {
            self.filed_prompt_name(session).await
        } else {
            None
        };
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
            // The agent answering a prompt it never handed back. Waiting for a
            // handback that will never come would let this answer, and the
            // `result` that ends it, arrive before the turn they belong to
            // existed.
            open_pending_turn(&mut state, filed.as_deref());
            let Some(turn_id) = state.active_turn.clone() else {
                // Work with no turn open belongs to nothing Caffold can show.
                return;
            };
            let mut items = message_items(
                &frame.message,
                &anchor,
                &mut state.calls,
                frame.is_api_error_message,
            );
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

    /// A prompt coming home, which is the agent saying what it filed it as.
    ///
    /// The turn opens here rather than where the prompt was written, because
    /// this is the last moment before the agent starts answering: everything
    /// the agent says next arrives on this same stream, in order, and finds a
    /// turn already waiting for it.
    ///
    /// A prompt nobody is waiting on is one Caffold sent on its own account — a
    /// depth change, a message steering a running turn — and opens nothing.
    async fn handle_replayed_prompt(&self, session: &Arc<Session>, frame: MessageFrame) {
        let Some(anchor) = frame.uuid.as_deref() else {
            return;
        };
        let mut state = session.state.lock().await;
        open_pending_turn(&mut state, Some(anchor));
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

        // A turn that began and ended without the agent handing its prompt
        // back, which is a short answer on a session that cannot hand one back
        // at all. Its name is read from the file like any other unhanded turn.
        let filed = if self.awaiting_a_turn_name(session).await {
            self.filed_prompt_name(session).await
        } else {
            None
        };
        let (turn, abandoned) = {
            let mut state = session.state.lock().await;
            if let Some(waiting) = state.quiet_turn.take() {
                // Something Caffold asked for on its own account, answered.
                let _ = waiting.send(());
                return;
            }
            open_pending_turn(&mut state, filed.as_deref());
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
        match frame.request.subtype.as_deref() {
            Some("can_use_tool") => {}
            Some("mcp_message") => {
                self.handle_mcp_message(session, frame).await;
                return;
            }
            _ => {
                // Hooks are asked for over this channel too. Caffold registers
                // none, so anything unrecognized is answered empty rather than
                // left to block the turn forever.
                let _ = session
                    .send(protocol::control_response(&frame.request_id, json!({})))
                    .await;
                return;
            }
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
            end_pending_prompt(
                &mut state,
                ClaudeError::Agent(format!(
                    "Claude conversation {} exited before identifying its prompt",
                    session.id
                )),
            );
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

    pub(super) async fn record_item(
        &self,
        session: &Arc<Session>,
        turn_id: &str,
        item: ConversationItem,
    ) {
        let mut state = session.state.lock().await;
        state.moved_at_ms = now_ms();
        if let Some(turn) = state.turns.iter_mut().find(|turn| turn.id == turn_id) {
            replace_item(&mut turn.items, item);
        }
    }

    pub(super) async fn report_status(&self, session: &Arc<Session>) {
        let status = status_of(&*session.state.lock().await);
        self.report(&session.id, SessionEventKind::StatusChanged { status });
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

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::super::test_support::*;
    use super::super::*;

    #[tokio::test]
    async fn a_session_that_stops_speaking_without_ending_is_one_to_open_again() {
        // The runner killed outright. Nothing says the agent ended, because
        // nothing is left to say it, and what Caffold last heard would go on
        // standing as the state of a conversation it can no longer reach. Said
        // out loud instead, because opening it again is the whole repair — and
        // nothing opens a Task that already looks like one being watched.
        let (client, runner, mut events) = watching().await;

        runner.vanish(SESSION).await;

        let reported = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if let Ok(ClaudeRuntimeEvent::Unreachable {
                    conversation_id, ..
                }) = events.recv().await
                {
                    return conversation_id;
                }
            }
        })
        .await
        .expect("the session says it can no longer be reached");
        assert_eq!(reported, SESSION);
        assert!(
            client.session(SESSION).await.is_none(),
            "and it is no longer one this client holds"
        );
    }

    #[tokio::test]
    async fn a_session_the_agent_ended_says_so_rather_than_asking_to_be_opened_again() {
        // The other half. An agent that exits has said what happened, and a
        // conversation with no process behind it is not one to re-open behind
        // a person's back.
        let (_client, runner, mut events) = watching().await;

        runner.exit(SESSION, Some(0)).await;

        let ended = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                match events.recv().await {
                    Ok(ClaudeRuntimeEvent::Unreachable { .. }) => return false,
                    Ok(ClaudeRuntimeEvent::Session(SessionEvent {
                        kind:
                            SessionEventKind::StatusChanged {
                                status: ThreadStatus::Idle,
                            },
                        ..
                    })) => return true,
                    Ok(_) => continue,
                    Err(_) => return false,
                }
            }
        })
        .await
        .expect("the exit is reported");
        assert!(ended, "an exit is reported as an exit");
    }

    #[tokio::test]
    async fn a_prompts_reflection_does_not_take_the_turn_from_the_name_the_agent_filed() {
        // A large image earns a resize note: an extra user row the agent adds
        // beside the prompt, and on some models an extra user frame ahead of
        // the prompt coming home. Taken as the agent answering unprompted, that
        // frame named the turn with an invented id — and the file names it
        // something else, so the same answer stood twice, once under each name.
        let projects = tempfile::tempdir().expect("a projects directory");
        transcript::plant(
            projects.path(),
            CWD,
            SESSION,
            concat!(
                r#"{"type":"user","uuid":"filed-prompt","timestamp":"2026-08-21T13:38:40.000Z","promptSource":"sdk","message":{"role":"user","content":[{"type":"text","text":"do you see it?"}]}}"#,
                "\n",
                r#"{"type":"user","uuid":"note-row","timestamp":"2026-08-21T13:38:40.500Z","message":{"role":"user","content":[{"type":"text","text":"[Image: original 2004x410, displayed at 2000x409]"}]}}"#,
                "\n",
            ),
        );
        let (client, runner) = ClaudeClient::mock_writing_to(projects.path().to_path_buf());
        runner
            .greet_next_session_with(vec![init_frame(SESSION)])
            .await;
        client
            .open_conversation(SESSION, CWD, &options("opus"))
            .await
            .expect("the conversation opens");
        runner.swallow_prompts(SESSION).await;

        let starting = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .start_turn(SESSION, "do you see it?", &[], &options("opus"))
                    .await
            }
        });
        heard_the_prompt(&runner).await;

        // The reflection arrives before the prompt comes home: a user frame
        // with no replay marking.
        runner
            .say(
                SESSION,
                json!({
                    "type": "user",
                    "uuid": "note-row",
                    "timestamp": "2026-08-21T13:38:40.500Z",
                    "message": { "role": "user", "content": [{
                        "type": "text",
                        "text": "[Image: original 2004x410, displayed at 2000x409]",
                    }]},
                }),
            )
            .await;
        // And the agent starts answering before any replay has arrived.
        runner
            .say(
                SESSION,
                assistant_frame("msg_1", json!([{ "type": "text", "text": "I see it." }])),
            )
            .await;

        let turn = tokio::time::timeout(REPORT_TIMEOUT, starting)
            .await
            .expect("the turn opens without waiting out the handback")
            .expect("the task finishes")
            .expect("the turn starts");
        assert_eq!(
            turn.id, "filed-prompt",
            "the turn is named what the agent filed the prompt as"
        );
    }

    #[tokio::test]
    async fn a_turn_carries_the_prompt_and_ends_on_the_agents_answer() {
        let (client, runner, mut events) = watching().await;

        let turn = client
            .start_turn(SESSION, "fix the test", &[], &options("opus"))
            .await
            .expect("the turn starts");

        let heard = runner.prompts(SESSION).await;
        assert_eq!(heard.len(), 1, "one prompt, written once");
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
    async fn a_turn_is_called_what_the_agent_filed_the_prompt_as() {
        // The name is the whole point: it is what the transcript will know this
        // turn by, so a Caffold that restarts reads this turn back as this turn
        // rather than as one more just like it.
        let (client, runner, _events) = watching().await;

        let turn = client
            .start_turn(SESSION, "fix the test", &[], &options("opus"))
            .await
            .expect("the turn starts");

        assert_eq!(turn.id, format!("{SESSION}-prompt-1"));
        assert_eq!(turn.items[0].id, format!("{SESSION}-prompt-1:prompt"));
        assert!(matches!(
            &turn.items[0].kind,
            ItemKind::UserMessage { text, .. } if text == "fix the test"
        ));
        let heard = runner.prompts(SESSION).await;
        assert_eq!(heard.len(), 1, "the prompt was written once, not twice");
    }

    #[tokio::test]
    async fn a_picture_sent_with_a_prompt_belongs_to_the_turn_it_started() {
        // Until now Caffold showed one from an event of its own, which lives in
        // the backend rather than in the conversation and dies with it. The
        // turn carrying it is what survives being read back.
        let (client, runner, _events) = watching().await;
        let picture = "data:image/png;base64,aGVsbG8=".to_string();

        let turn = client
            .start_turn(
                SESSION,
                "what is this",
                std::slice::from_ref(&picture),
                &options("opus"),
            )
            .await
            .expect("the turn starts");

        let ItemKind::UserMessage { text, content } = &turn.items[0].kind else {
            panic!("the prompt is what a person said: {:?}", turn.items[0].kind);
        };
        assert_eq!(text, "what is this", "the words are the words");
        assert_eq!(
            content,
            &vec![
                MessageContent::Text {
                    text: "what is this".to_string()
                },
                MessageContent::Image {
                    url: picture.clone()
                },
            ]
        );

        // And it reached the agent as a picture rather than as its data URL.
        let heard = runner.prompts(SESSION).await;
        let blocks = heard[0]["message"]["content"]
            .as_array()
            .expect("content")
            .clone();
        assert_eq!(blocks[1]["type"], "image");
        assert_eq!(blocks[1]["source"]["media_type"], "image/png");
    }

    #[tokio::test]
    async fn a_session_that_never_hands_a_prompt_back_still_runs_and_ends_its_turn() {
        // A session the runner held from before Caffold began asking to be
        // handed prompts back cannot hand one back, and its arguments are fixed
        // for as long as it lives. Waiting for one let the answer — and the
        // `result` that ends the turn — go by before the turn existed, and what
        // was opened afterwards had nothing left to close it.
        let (client, runner, mut events) = watching().await;
        runner.swallow_prompts(SESSION).await;

        let starting = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .start_turn(SESSION, "fix the test", &[], &options("opus"))
                    .await
            }
        });
        heard_the_prompt(&runner).await;

        // The agent answers as though nothing had to be acknowledged.
        runner
            .say(
                SESSION,
                assistant_frame("msg_1", json!([{ "type": "text", "text": "done" }])),
            )
            .await;
        let turn = tokio::time::timeout(REPORT_TIMEOUT, starting)
            .await
            .expect("the turn does not wait out the handback")
            .expect("the task finishes")
            .expect("the turn starts");
        assert_eq!(turn.status, TurnStatus::InProgress);

        runner.say(SESSION, result_frame(Some("end_turn"))).await;

        let ended = loop {
            if let SessionEventKind::TurnEnded { turn } =
                next_session_event(&mut events, "turn end").await
            {
                break turn;
            }
        };
        assert_eq!(
            ended.id, turn.id,
            "the turn that ended is the one that began"
        );
        assert_eq!(ended.status, TurnStatus::Completed);
        assert!(
            ended.items.iter().any(|item| matches!(
                &item.kind,
                ItemKind::AssistantMessage { text, .. } if text == "done"
            )),
            "the answer belongs to the turn: {:?}",
            ended.items
        );
    }

    #[tokio::test]
    async fn a_turn_answered_only_by_its_result_is_still_a_turn() {
        // The shortest way for the answer to outrun the handback: nothing to
        // say, and the turn over.
        let (client, runner, mut events) = watching().await;
        runner.swallow_prompts(SESSION).await;

        let starting = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .start_turn(SESSION, "fix the test", &[], &options("opus"))
                    .await
            }
        });
        heard_the_prompt(&runner).await;
        runner.say(SESSION, result_frame(Some("end_turn"))).await;

        let turn = tokio::time::timeout(REPORT_TIMEOUT, starting)
            .await
            .expect("the turn does not wait out the handback")
            .expect("the task finishes")
            .expect("the turn starts");

        let ended = loop {
            if let SessionEventKind::TurnEnded { turn } =
                next_session_event(&mut events, "turn end").await
            {
                break turn;
            }
        };
        assert_eq!(ended.id, turn.id);
        assert_eq!(ended.status, TurnStatus::Completed);
    }

    #[tokio::test]
    async fn a_failure_of_the_agents_own_is_drawn_as_a_failure_not_as_the_agent_talking() {
        // The frames are what a session really says when the API cannot be
        // reached: a `<synthetic>` assistant message marked
        // `is_api_error_message`, then a result that is an error while its
        // subtype still says success — so the turn must fail by reading
        // `is_error`, never the subtype.
        let (client, runner, mut events) = watching().await;
        let turn = running_turn(&client, &mut events, "run it").await;

        runner
            .say(
                SESSION,
                json!({
                    "type": "assistant",
                    "uuid": "frame-err",
                    "error": "server_error",
                    "is_api_error_message": true,
                    "message": {
                        "id": "7a308aee-16a8-4321-b39a-a70bb8d6891f",
                        "model": "<synthetic>",
                        "role": "assistant",
                        "content": [{
                            "type": "text",
                            "text": "API Error: Connection refused — a firewall or proxy may be blocking it (ConnectionRefused)",
                        }],
                    },
                }),
            )
            .await;

        let item = loop {
            if let SessionEventKind::ItemChanged { item, .. } =
                next_session_event(&mut events, "item").await
            {
                break item;
            }
        };
        assert!(
            matches!(&item.kind, ItemKind::Failure { text } if text.starts_with("API Error")),
            "{item:?}"
        );

        runner
            .say(
                SESSION,
                json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": true,
                    "terminal_reason": "api_error",
                    "stop_reason": null,
                }),
            )
            .await;
        let ended = loop {
            if let SessionEventKind::TurnEnded { turn } =
                next_session_event(&mut events, "turn end").await
            {
                break turn;
            }
        };
        assert_eq!(ended.id, turn.id);
        assert_eq!(ended.status, TurnStatus::Failed);
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
                        "tool_use_id": "toolu_7",
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
}
