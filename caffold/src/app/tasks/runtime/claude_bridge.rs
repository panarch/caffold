use tokio::sync::broadcast;

use futures_util::{StreamExt, stream};

use super::{TaskRuntime, TaskRuntimeSignal, server_requests::AskedBy};
use crate::agent::SessionEventKind;
use crate::agent::claude::{AskedTool, ClaudeRuntimeEvent, ToolAsk, WorkingDirectoryMove};
use crate::app::tasks::events::now_ms;
use crate::app::tasks::worktrees::IsolateOutcome;
use crate::task_store::RunBy;

impl TaskRuntime {
    /// Carry what Claude sessions say into the Task application.
    ///
    /// The Codex bridge translates notifications first and reports second,
    /// because app-server speaks in Codex's own vocabulary. Claude's driver has
    /// already done its translating by the time anything reaches here, so this
    /// bridge only routes: a conversation report goes where every agent's
    /// conversation reports go, and an approval joins the same waiting list a
    /// Codex approval joins.
    pub(super) fn spawn_claude_bridge(&self, mut shutdown: broadcast::Receiver<()>) {
        let runtime = self.clone();
        let mut events = self.claude.subscribe();
        tokio::spawn(async move {
            loop {
                let event = tokio::select! {
                    _ = shutdown.recv() => return,
                    event = events.recv() => event,
                };
                match event {
                    Ok(ClaudeRuntimeEvent::Session(reported)) => {
                        if matches!(reported.kind, SessionEventKind::TurnEnded { .. }) {
                            runtime.finish_pending_claude_move(&reported.thread_id);
                        }
                        runtime
                            .handle_session_event(super::CLAUDE_GENERATION, reported)
                            .await;
                    }
                    Ok(ClaudeRuntimeEvent::TranscriptChanged { conversation_id }) => {
                        // A transcript read walks the agent's history and may
                        // wait on filesystem work. Keep it off the one loop
                        // carrying every Claude session; refreshes for one
                        // thread serialize inside TaskSessions.
                        let runtime = runtime.clone();
                        tokio::spawn(async move {
                            runtime.refresh_claude_transcript(&conversation_id).await;
                        });
                    }
                    Ok(ClaudeRuntimeEvent::Approval {
                        conversation_id,
                        request,
                    }) => {
                        runtime
                            .record_claude_approval(&conversation_id, *request)
                            .await;
                    }
                    Ok(ClaudeRuntimeEvent::ToolAsked {
                        conversation_id,
                        ask,
                    }) => {
                        // Off this loop, which carries every session: the ask
                        // waits on the store and on the agent answering a
                        // control request, and one slow answer must not hold
                        // every other conversation's reports behind it.
                        let runtime = runtime.clone();
                        tokio::spawn(async move {
                            runtime.answer_claude_tool_ask(&conversation_id, ask).await;
                        });
                    }
                    Ok(ClaudeRuntimeEvent::Unreachable {
                        conversation_id,
                        message,
                    }) => {
                        runtime
                            .lost_claude_session(&conversation_id, &message)
                            .await;
                    }
                    Ok(ClaudeRuntimeEvent::Diagnostic { message }) => eprintln!("{message}"),
                    // A backlog long enough to drop from would mean a report is
                    // already lost; saying so beats carrying on as though the
                    // conversation were whole.
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        eprintln!("Claude runtime dropped {missed} reports behind a slow reader");
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                }
            }
        });
    }

    /// Carry agent-owned work that had no live Caffold turn into the canonical
    /// Task snapshot. The transcript decides what the work belongs to; this
    /// bridge only asks for that answer and tells existing viewers it changed.
    async fn refresh_claude_transcript(&self, thread_id: &str) {
        match self
            .sessions
            .refresh_latest_turns(super::CLAUDE_GENERATION, thread_id)
            .await
        {
            Ok(Some(snapshot)) => {
                let _ = self.signals.send(TaskRuntimeSignal::SessionChanged {
                    thread_id: thread_id.to_string(),
                    snapshot: Box::new(snapshot),
                });
            }
            Ok(None) => {}
            Err(error) => {
                eprintln!("failed to refresh Claude transcript for {thread_id}: {error}");
            }
        }
    }

    /// Take up the conversations that outlived this process.
    ///
    /// The Claude half of what Codex does with its loaded threads, and the same
    /// two steps. The runner answers which conversations still have a process
    /// behind them — one request, and it starts nothing, because everything it
    /// names is already running. Each of those is then opened, which attaches
    /// rather than spawns, and greeted, which is where the agent says whether a
    /// prompt is still outstanding and hands back anything it is held up by.
    ///
    /// A runner that has just started answers with nothing, and rightly: it
    /// ended whatever the last one left, so there is nothing to take up. Every
    /// other Task waits to be opened by somebody.
    pub(super) fn take_up_live_conversations(&self) {
        let runtime = self.clone();
        tokio::spawn(async move {
            let live = runtime.claude.live_conversations().await;
            if live.is_empty() {
                return;
            }
            let store = runtime.task_store.clone();
            let managed = match tokio::task::spawn_blocking(move || {
                live.into_iter()
                    .filter_map(|thread_id| match store.get(thread_id.as_str()) {
                        Ok(Some(managed)) => Some(Ok(managed)),
                        Ok(None) => None,
                        Err(error) => Some(Err(error)),
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .await
            {
                Ok(Ok(managed)) => managed,
                Ok(Err(error)) => {
                    eprintln!(
                        "failed to read managed Tasks while taking up Claude sessions: {error}"
                    );
                    return;
                }
                Err(error) => {
                    eprintln!("the worker reading managed Tasks failed: {error}");
                    return;
                }
            };

            stream::iter(managed)
                .for_each_concurrent(8, |managed| {
                    let runtime = runtime.clone();
                    async move {
                        if !matches!(managed.run_by, RunBy::Claude { .. }) {
                            // The runner holds a session under this name and the
                            // store says the Task is somebody else's. Neither is
                            // safe to act on.
                            return;
                        }
                        // Built from the row, so an isolated Task is taken
                        // back up where it moved to rather than where it began.
                        let driver = match runtime.agent_for(&managed).await {
                            Ok(agent) => agent.driver(),
                            Err(error) => {
                                eprintln!(
                                    "failed to route Claude conversation {}: {error}",
                                    managed.thread_id
                                );
                                return;
                            }
                        };
                        let thread_id = managed.thread_id;
                        match runtime
                            .sessions
                            .recover_live_claude_session(
                                &driver,
                                super::CLAUDE_GENERATION,
                                &thread_id,
                            )
                            .await
                        {
                            Ok(Some(snapshot)) => {
                                let _ = runtime.signals.send(TaskRuntimeSignal::SessionChanged {
                                    thread_id,
                                    snapshot: Box::new(snapshot),
                                });
                            }
                            Ok(None) => {}
                            Err(error) => eprintln!(
                                "failed to take up Claude conversation {thread_id}: {error}"
                            ),
                        }
                    }
                })
                .await;
        });
    }

    /// Stop answering for a Claude session that can no longer be reached.
    ///
    /// The Codex half of this is a connection going and taking every thread on
    /// it; here it is one conversation, because that is all a Claude connection
    /// ever carries. Both end the same way: the session says it is no longer
    /// current, and whoever is watching is told, so opening it again asks the
    /// agent rather than repeating what was last heard.
    async fn lost_claude_session(&self, thread_id: &str, message: &str) {
        self.sessions.session_needs_opening_again(thread_id).await;
        let _ = self
            .signals
            .send(super::TaskRuntimeSignal::SessionUnavailable {
                thread_id: thread_id.to_string(),
                message: message.to_string(),
            });
    }

    /// Do what the agent asked of Caffold, and answer it.
    ///
    /// The Claude twin of the Codex dynamic-tool handler, under the same
    /// contract: the agent is blocked mid-turn until an answer goes back, so
    /// every path answers, the failures included.
    async fn answer_claude_tool_ask(&self, thread_id: &str, ask: ToolAsk) {
        let outcome = match &ask.asked {
            AskedTool::RenameTask { name } => self.rename_claude_task(thread_id, name).await,
            AskedTool::IsolateTask {
                branch_name,
                base_ref,
                include_changes,
            } => {
                self.isolate_claude_task(
                    thread_id,
                    branch_name.as_deref(),
                    base_ref.as_deref(),
                    *include_changes,
                )
                .await
            }
        };
        if let Err(error) = self.claude.answer_tool_ask(thread_id, &ask, &outcome).await {
            eprintln!("failed to answer the agent's tool call on {thread_id}: {error}");
        }
    }

    /// Move the Task whose conversation asked into a managed worktree.
    ///
    /// The worktree half is the machinery every agent shares — the same
    /// branches, hand-offs, and checks Codex's dynamic tool drives. The Claude
    /// half is the move itself: one `set_cwd`, after which the session runs in
    /// the worktree and the agent keeps its transcript there, which is also
    /// where every later opening of this Task looks for both.
    async fn isolate_claude_task(
        &self,
        thread_id: &str,
        branch_name: Option<&str>,
        base_ref: Option<&str>,
        include_changes: bool,
    ) -> Result<String, String> {
        let branch_name = match branch_name.map(str::trim) {
            Some("") => {
                return Err("`branchName` must be a non-empty string when provided.".to_string());
            }
            other => other.map(str::to_string),
        };
        let base_ref = match base_ref.map(str::trim) {
            Some("") => {
                return Err("`baseRef` must be a non-empty string when provided.".to_string());
            }
            other => other.map(str::to_string),
        };
        if base_ref.is_some() && include_changes {
            return Err("`baseRef` cannot be combined with `includeChanges: true`.".to_string());
        }
        let managed = {
            let store = self.task_store.clone();
            let thread_id = thread_id.to_string();
            tokio::task::spawn_blocking(move || store.get(&thread_id))
                .await
                .map_err(|error| format!("Task-store worker failed: {error}"))?
                .map_err(|error| error.to_string())?
        };
        let Some(managed) = managed else {
            return Err("Caffold can only isolate a task that it manages.".to_string());
        };
        let RunBy::Claude { cwd } = &managed.run_by else {
            return Err("Caffold can only isolate a task that it manages.".to_string());
        };
        let task_name = {
            let name = managed.display_name.trim();
            if name.is_empty() { "task" } else { name }.to_string()
        };
        let lifecycle = self
            .lifecycle
            .as_ref()
            .ok_or_else(|| "Caffold task lifecycle is unavailable.".to_string())?;
        let isolated = lifecycle
            .isolate_current_task(
                cwd.into(),
                thread_id.to_string(),
                task_name,
                branch_name,
                base_ref,
                include_changes,
            )
            .await
            .map_err(|error| format!("Caffold could not isolate the current task: {error}"))?;
        let (worktree, checkout, source_warning, already_ready) = match isolated {
            IsolateOutcome::AlreadyReady { worktree, checkout } => (worktree, checkout, None, true),
            IsolateOutcome::Isolated {
                worktree,
                checkout,
                source_warning,
            } => (worktree, checkout, source_warning, false),
        };
        // The session moves as part of being isolated. The agent only moves
        // between turns, and the turn that asked is still running — so a
        // busy answer is the expected one, and the move lands the moment
        // that turn ends, which is before the "next request" the answer
        // below promises. Asked even when the worktree already stood,
        // because the session at hand may never have moved.
        match self
            .claude
            .move_working_directory(thread_id, &worktree.worktree_path)
            .await
        {
            Ok(WorkingDirectoryMove::Moved) => {}
            Ok(WorkingDirectoryMove::TurnRunning) => {
                self.pending_claude_moves
                    .lock()
                    .await
                    .insert(thread_id.to_string(), worktree.worktree_path.clone());
            }
            Err(error) => {
                return Err(format!(
                    "Caffold prepared the worktree at `{}` but could not move the running \
                     session there: {error} Reopen the Task to continue in the worktree.",
                    worktree.worktree_path
                ));
            }
        }
        if already_ready {
            return Ok(format!(
                "The current Caffold task is already isolated on branch `{}` at `{}`. End this \
                 turn; the user's next request will continue there.",
                checkout.branch_name, worktree.worktree_path
            ));
        }
        let warning = source_warning
            .map(|warning| {
                format!(
                    " The original checkout could not be switched to its default branch and \
                     remains detached: {warning}"
                )
            })
            .unwrap_or_default();
        let result = if include_changes {
            format!(
                "Moved the current Caffold task to branch `{}` at `{}` and preserved its \
                 tracked and untracked changes.",
                checkout.branch_name, worktree.worktree_path
            )
        } else {
            format!(
                "Prepared the current Caffold task on branch `{}` at `{}`. Source checkout \
                 changes were left in place.",
                checkout.branch_name, worktree.worktree_path
            )
        };
        Ok(format!(
            "{result} End this turn; the user's next request will continue there.{warning}"
        ))
    }

    /// Rename the Task whose conversation asked, everywhere a name lives.
    ///
    /// Caffold's row is the name a Task goes by, so it is what must change;
    /// the agent's own session title is renamed first so a failure there
    /// leaves both names as they were, exactly as the Codex rename orders it.
    async fn rename_claude_task(&self, thread_id: &str, name: &str) -> Result<String, String> {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("The new task name must be a non-empty string.".to_string());
        }
        let managed = {
            let store = self.task_store.clone();
            let thread_id = thread_id.to_string();
            tokio::task::spawn_blocking(move || store.get(&thread_id))
                .await
                .map_err(|error| format!("Task-store worker failed: {error}"))?
                .map_err(|error| error.to_string())?
        };
        let Some(managed) = managed else {
            return Err("Caffold can only rename tasks that it manages.".to_string());
        };
        self.claude
            .rename_conversation(thread_id, &name)
            .await
            .map_err(|error| format!("Caffold could not rename the current task: {error}"))?;
        let persisted = {
            let store = self.task_store.clone();
            let thread_id = thread_id.to_string();
            let name = name.clone();
            tokio::task::spawn_blocking(move || store.update_display_name(&thread_id, &name))
                .await
                .map_err(|error| format!("Task-store worker failed: {error}"))
                .and_then(|result| result.map_err(|error| error.to_string()))
                .and_then(|thread| {
                    thread.ok_or_else(|| "renamed Task is no longer managed".to_string())
                })
        };
        if let Err(error) = persisted {
            if let Err(rollback_error) = self
                .claude
                .rename_conversation(thread_id, &managed.display_name)
                .await
            {
                eprintln!(
                    "failed to roll back Claude session rename after local projection failure: {rollback_error}"
                );
            }
            return Err(format!(
                "Caffold renamed the agent's session but could not persist the Task name: {error}"
            ));
        }
        if let Some(lifecycle) = &self.lifecycle {
            lifecycle.refresh_task_list();
        }
        Ok(format!("Renamed the current Caffold task to `{name}`."))
    }

    /// Carry out a move that was waiting for this conversation's turn to end.
    ///
    /// Runs on every turn end and does nothing for the many conversations
    /// with no move pending. The agent has just gone idle, so the ask lands
    /// at once; the brief retry is for a beat of lag, and a session that
    /// stays busy has started another turn — the move waits for that one's
    /// end instead. A session that ends or is lost meanwhile is fine as it
    /// is: the next opening of the Task spawns in the worktree.
    fn finish_pending_claude_move(&self, thread_id: &str) {
        let runtime = self.clone();
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            let Some(path) = runtime.pending_claude_moves.lock().await.remove(&thread_id) else {
                return;
            };
            for attempt in 0..10u32 {
                if attempt > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
                match runtime
                    .claude
                    .move_working_directory(&thread_id, &path)
                    .await
                {
                    Ok(WorkingDirectoryMove::Moved) => return,
                    Ok(WorkingDirectoryMove::TurnRunning) => continue,
                    Err(error) => {
                        eprintln!(
                            "could not move {thread_id} into its worktree: {error}; the Task \
                             moves when it is next opened"
                        );
                        return;
                    }
                }
            }
            runtime
                .pending_claude_moves
                .lock()
                .await
                .insert(thread_id, path);
        });
    }

    async fn record_claude_approval(
        &self,
        thread_id: &str,
        request: crate::agent::ApprovalRequest,
    ) {
        self.record_pending_approval(thread_id, request, now_ms(), AskedBy::Claude)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::{Value, json};

    use crate::agent::claude::{ClaudeTurnOptions, MockRunnerHandle};
    use crate::app::tasks::TaskState;
    use crate::app::tasks::test_support::task_state_with_agents;
    use crate::fs::RootedFs;
    use crate::task_store::{ManagedThread, RunBy};

    const SESSION: &str = "claude-thread-1";
    const WAIT: Duration = Duration::from_secs(2);
    const POLL: Duration = Duration::from_millis(5);

    /// A state whose Claude bridge is listening, with a watched conversation
    /// the stand-in runner can speak as.
    async fn watched(root: &std::path::Path) -> (TaskState, MockRunnerHandle) {
        watched_in(root, root).await
    }

    /// The same, for a conversation working somewhere below the root.
    async fn watched_in(
        root: &std::path::Path,
        cwd: &std::path::Path,
    ) -> (TaskState, MockRunnerHandle) {
        let client = crate::agent::codex::CodexThreadClient::mock(Vec::new());
        let (state, runner) = task_state_with_agents(RootedFs::new(root).unwrap(), client).await;
        state.task_runtime.watch_claude();
        state
            .task_runtime
            .claude()
            .open_conversation(
                SESSION,
                &cwd.display().to_string(),
                &ClaudeTurnOptions::default(),
            )
            .await
            .expect("the conversation opens");
        (state, runner)
    }

    fn managed_claude_row(cwd: &std::path::Path) -> ManagedThread {
        ManagedThread {
            run_by: RunBy::Claude {
                cwd: cwd.display().to_string(),
            },
            display_name: "The name before".to_string(),
            ..ManagedThread::new(SESSION, RunBy::Codex, Some(1_000), None, None)
        }
    }

    #[tokio::test]
    async fn unowned_claude_work_reaches_task_detail_from_canonical_history() {
        let root = tempfile::tempdir().unwrap();
        let cwd = root.path().display().to_string();
        let (state, runner) = watched(root.path()).await;
        state
            .task_store
            .claim(managed_claude_row(root.path()), 1)
            .unwrap();
        let driver = state.task_runtime.claude().driver(cwd.clone());
        let _viewer = state
            .task_sessions
            .acquire_viewer(&driver, super::super::CLAUDE_GENERATION, SESSION)
            .await
            .expect("the Claude Task is subscribed");
        state
            .detail
            .agent(SESSION)
            .await
            .expect("the Task detail signal driver starts");
        let mut detail_syncs = state.task_sync.subscribe_updates();

        state.task_runtime.claude().write_test_transcript(
            &cwd,
            SESSION,
            concat!(
                r#"{"type":"user","uuid":"report-1","timestamp":"2026-08-23T06:25:55.000Z","promptSource":"sdk","origin":{"kind":"task-notification"},"message":{"role":"user","content":"<task-notification>\n<task-id>bgxe14776</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n</task-notification>"}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"answer-2","timestamp":"2026-08-23T06:25:57.000Z","message":{"id":"message-2","role":"assistant","content":[{"type":"text","text":"the build is done"}]}}"#,
                "\n",
            ),
        );

        // These are real stream frames, but there is no Caffold-owned turn to
        // assign them to. Their transcript row is the only evidence that says
        // what opened the work.
        runner
            .say(
                SESSION,
                json!({
                    "type": "assistant",
                    "uuid": "answer-2",
                    "timestamp": "2026-08-23T06:25:57.000Z",
                    "message": {
                        "id": "message-2",
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "the build is done" }],
                    },
                }),
            )
            .await;
        runner
            .say(
                SESSION,
                json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": false,
                    "stop_reason": "end_turn",
                }),
            )
            .await;

        let detail = tokio::time::timeout(WAIT, async {
            loop {
                let sync = detail_syncs
                    .recv()
                    .await
                    .expect("the Task detail sync channel stays open");
                if sync.thread_id == SESSION
                    && sync.detail.events.iter().any(|event| {
                        event.event_type == "assistant_message"
                            && event
                                .payload
                                .as_ref()
                                .is_some_and(|payload| payload["text"] == "the build is done")
                    })
                {
                    return sync.detail;
                }
            }
        })
        .await
        .expect("canonical history reaches the subscribed Task detail");
        let user_messages = detail
            .events
            .iter()
            .filter(|event| event.event_type == "user_message")
            .collect::<Vec<_>>();
        let answers = detail
            .events
            .iter()
            .filter(|event| {
                event.event_type == "assistant_message"
                    && event
                        .payload
                        .as_ref()
                        .is_some_and(|payload| payload["text"] == "the build is done")
            })
            .collect::<Vec<_>>();
        let started = detail
            .events
            .iter()
            .find(|event| event.event_type == "turn_started")
            .expect("the canonical turn start");

        assert!(
            user_messages.is_empty(),
            "the machine report is not a person speaking"
        );
        assert_eq!(
            answers.len(),
            1,
            "the background answer reaches the UI once"
        );
        assert_eq!(
            started.payload.as_ref().expect("turn payload")["origin"]["type"],
            "backgroundTask"
        );
    }

    fn isolate_call(id: u64, arguments: Value) -> Value {
        json!({
            "type": "control_request",
            "request_id": format!("agent-{id}"),
            "request": {
                "subtype": "mcp_message",
                "server_name": "caffold",
                "message": {
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "tools/call",
                    "params": {
                        "name": "isolate_current_task",
                        "arguments": arguments,
                    },
                },
            },
        })
    }

    fn git(path: &std::path::Path, args: &[&str]) {
        let output = std::process::Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .expect("git runs");
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_is_available() -> bool {
        std::process::Command::new("git")
            .arg("--version")
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn rename_call(id: u64, name: &str) -> Value {
        json!({
            "type": "control_request",
            "request_id": format!("agent-{id}"),
            "request": {
                "subtype": "mcp_message",
                "server_name": "caffold",
                "message": {
                    "jsonrpc": "2.0",
                    "id": id,
                    "method": "tools/call",
                    "params": {
                        "name": "rename_current_task",
                        "arguments": { "name": name },
                    },
                },
            },
        })
    }

    /// The answer the agent eventually hears for one call, or the wait fails.
    async fn call_answered(runner: &MockRunnerHandle, id: u64) -> Value {
        tokio::time::timeout(WAIT, async {
            loop {
                if let Some(frame) = runner
                    .heard(SESSION)
                    .await
                    .iter()
                    .find(|frame| frame["response"]["response"]["mcp_response"]["id"] == id)
                {
                    return frame["response"]["response"]["mcp_response"]["result"].clone();
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await
        .expect("the tool call is answered")
    }

    /// A question Claude asks joins the list Codex's questions join.
    ///
    /// Which matters beyond the conversation view: the waiting list is what
    /// tells a phone that a Task has stopped for a person, so a question that
    /// arrived beside it rather than on it would be answered by nobody who
    /// had walked away.
    #[tokio::test]
    async fn a_question_claude_asks_joins_the_shared_waiting_list() {
        let root = tempfile::tempdir().unwrap();
        let (state, runner) = watched(root.path()).await;

        runner
            .say(
                SESSION,
                json!({
                    "type": "control_request",
                    "request_id": "req-1",
                    "request": {
                        "subtype": "can_use_tool",
                        "tool_name": "Bash",
                        "input": { "command": "cargo test" },
                        "tool_use_id": "toolu_1",
                    },
                }),
            )
            .await;

        let waiting = tokio::time::timeout(WAIT, async {
            loop {
                let waiting = state.task_runtime.approval_events(SESSION).await;
                if !waiting.is_empty() {
                    return waiting;
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await
        .expect("the question waits for an answer");
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].event_type, "approval_requested");
        assert_eq!(
            waiting[0].payload.as_ref().unwrap()["command"],
            "cargo test"
        );
    }

    #[tokio::test]
    async fn the_agent_renaming_its_task_renames_the_row_and_its_own_session() {
        let root = tempfile::tempdir().unwrap();
        let (state, runner) = watched(root.path()).await;
        state
            .task_store
            .claim(managed_claude_row(root.path()), 1)
            .unwrap();

        runner
            .say(SESSION, rename_call(1, "  A better name  "))
            .await;

        let answered = call_answered(&runner, 1).await;
        assert_eq!(
            answered["content"][0]["text"],
            "Renamed the current Caffold task to `A better name`."
        );
        assert!(answered.get("isError").is_none());
        // The row is the name a Task goes by, trimmed the way it was promised.
        let renamed = state.task_store.get(SESSION).unwrap().unwrap();
        assert_eq!(renamed.display_name, "A better name");
        // And the agent's own session title was asked to follow.
        let asked = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "rename_session")
            .expect("the agent's own title is renamed too");
        assert_eq!(asked["request"]["title"], "A better name");
    }

    #[tokio::test]
    async fn a_rename_for_a_task_caffold_does_not_manage_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let (_state, runner) = watched(root.path()).await;

        runner.say(SESSION, rename_call(2, "A better name")).await;

        let answered = call_answered(&runner, 2).await;
        assert_eq!(answered["isError"], true);
        assert_eq!(
            answered["content"][0]["text"],
            "Caffold can only rename tasks that it manages."
        );
    }

    #[tokio::test]
    async fn a_rename_to_nothing_is_refused_and_the_row_keeps_its_name() {
        let root = tempfile::tempdir().unwrap();
        let (state, runner) = watched(root.path()).await;
        state
            .task_store
            .claim(managed_claude_row(root.path()), 1)
            .unwrap();

        runner.say(SESSION, rename_call(3, "   ")).await;

        let answered = call_answered(&runner, 3).await;
        assert_eq!(answered["isError"], true);
        assert_eq!(
            answered["content"][0]["text"],
            "The new task name must be a non-empty string."
        );
        let kept = state.task_store.get(SESSION).unwrap().unwrap();
        assert_eq!(kept.display_name, "The name before");
    }

    #[tokio::test]
    async fn the_agent_isolating_its_task_moves_the_session_into_the_worktree() {
        if !git_is_available() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("repo");
        std::fs::create_dir(&source).unwrap();
        git(&source, &["init", "--initial-branch=main"]);
        std::fs::write(source.join("README.md"), "hello\n").unwrap();
        git(&source, &["add", "."]);
        git(
            &source,
            &[
                "-c",
                "user.email=caffold@test",
                "-c",
                "user.name=Caffold",
                "commit",
                "-m",
                "start",
            ],
        );
        let (state, runner) = watched_in(root.path(), &source).await;
        state
            .task_store
            .claim(managed_claude_row(&source), 1)
            .unwrap();

        runner
            .say(SESSION, isolate_call(8, json!({ "branchName": "fix/one" })))
            .await;

        let answered = call_answered(&runner, 8).await;
        assert!(answered.get("isError").is_none(), "{answered}");
        let text = answered["content"][0]["text"].as_str().unwrap();
        assert!(
            text.starts_with("Prepared the current Caffold task on branch `fix/one` at `"),
            "{text}"
        );
        assert!(
            text.contains("End this turn; the user's next request will continue there."),
            "{text}"
        );
        // The worktree is recorded for the Task...
        let worktree = state
            .task_store
            .worktree_for_thread(SESSION)
            .unwrap()
            .expect("the Task has a worktree now");
        // ...and the very session that asked was moved into it.
        let moved = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "set_cwd")
            .expect("the session is asked to move");
        assert_eq!(moved["request"]["path"], worktree.worktree_path.as_str());
    }

    #[tokio::test]
    async fn a_session_still_in_its_turn_moves_the_moment_the_turn_ends() {
        if !git_is_available() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("repo");
        std::fs::create_dir(&source).unwrap();
        git(&source, &["init", "--initial-branch=main"]);
        std::fs::write(source.join("README.md"), "hello\n").unwrap();
        git(&source, &["add", "."]);
        git(
            &source,
            &[
                "-c",
                "user.email=caffold@test",
                "-c",
                "user.name=Caffold",
                "commit",
                "-m",
                "start",
            ],
        );
        let (state, runner) = watched_in(root.path(), &source).await;
        state
            .task_store
            .claim(managed_claude_row(&source), 1)
            .unwrap();
        // A turn is running when the tool call arrives, so the first ask to
        // move is answered mid-turn.
        state
            .task_runtime
            .claude()
            .start_turn(SESSION, "isolate it", &[], &ClaudeTurnOptions::default())
            .await
            .unwrap();
        runner.refuse_moves_while_busy(SESSION, 2).await;

        runner.say(SESSION, isolate_call(11, json!({}))).await;

        // The call is answered as done — the move is the turn ending's job.
        let answered = call_answered(&runner, 11).await;
        assert!(answered.get("isError").is_none(), "{answered}");

        // The turn ends, and the waiting move is carried out.
        runner
            .say(
                SESSION,
                json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": false,
                    "stop_reason": null,
                }),
            )
            .await;
        tokio::time::timeout(WAIT, async {
            loop {
                let moved = runner
                    .heard(SESSION)
                    .await
                    .into_iter()
                    .filter(|frame| frame["request"]["subtype"] == "set_cwd")
                    .count();
                if moved >= 3 {
                    return;
                }
                tokio::time::sleep(POLL).await;
            }
        })
        .await
        .expect("the move lands once the turn ends");
    }

    #[tokio::test]
    async fn an_isolate_ask_mixing_base_ref_and_changes_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let (state, runner) = watched(root.path()).await;
        state
            .task_store
            .claim(managed_claude_row(root.path()), 1)
            .unwrap();

        runner
            .say(
                SESSION,
                isolate_call(
                    9,
                    json!({ "baseRef": "origin/main", "includeChanges": true }),
                ),
            )
            .await;

        let answered = call_answered(&runner, 9).await;
        assert_eq!(answered["isError"], true);
        assert_eq!(
            answered["content"][0]["text"],
            "`baseRef` cannot be combined with `includeChanges: true`."
        );
        assert!(
            state
                .task_store
                .worktree_for_thread(SESSION)
                .unwrap()
                .is_none(),
            "nothing was prepared for a refused ask"
        );
    }

    #[tokio::test]
    async fn an_isolate_ask_for_a_task_caffold_does_not_manage_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let (_state, runner) = watched(root.path()).await;

        runner.say(SESSION, isolate_call(10, json!({}))).await;

        let answered = call_answered(&runner, 10).await;
        assert_eq!(answered["isError"], true);
        assert_eq!(
            answered["content"][0]["text"],
            "Caffold can only isolate a task that it manages."
        );
    }
}
