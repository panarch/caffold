use tokio::sync::broadcast;

use futures_util::{StreamExt, stream};

use super::{TaskRuntime, TaskRuntimeSignal, server_requests::PendingApproval};
use crate::agent::claude::{AskedTool, ClaudeRuntimeEvent, ToolAsk};
use crate::app::tasks::events::{approval_requested_event, now_ms};
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
                        runtime
                            .handle_session_event(super::CLAUDE_GENERATION, reported)
                            .await;
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
                        let RunBy::Claude { cwd } = managed.run_by else {
                            // The runner holds a session under this name and the
                            // store says the Task is somebody else's. Neither is
                            // safe to act on.
                            return;
                        };
                        let thread_id = managed.thread_id;
                        match runtime
                            .sessions
                            .recover_live_claude_session(
                                &runtime.claude.driver(cwd),
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
        };
        if let Err(error) = self.claude.answer_tool_ask(thread_id, &ask, &outcome).await {
            eprintln!("failed to answer the agent's tool call on {thread_id}: {error}");
        }
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

    async fn record_claude_approval(
        &self,
        thread_id: &str,
        request: crate::agent::ApprovalRequest,
    ) {
        let event = self
            .events
            .record(approval_requested_event(thread_id, &request, now_ms()));
        self.approvals.lock().await.insert(
            request.id.clone(),
            PendingApproval::claude(thread_id.to_string(), request, &event),
        );
        self.events.broadcast(event);
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
        let client = crate::agent::codex::CodexThreadClient::mock(Vec::new());
        let (state, runner) = task_state_with_agents(RootedFs::new(root).unwrap(), client).await;
        state.task_runtime.watch_claude();
        state
            .task_runtime
            .claude()
            .open_conversation(
                SESSION,
                &root.display().to_string(),
                &ClaudeTurnOptions::default(),
            )
            .await
            .expect("the conversation opens");
        (state, runner)
    }

    fn managed_claude_row(root: &std::path::Path) -> ManagedThread {
        ManagedThread {
            run_by: RunBy::Claude {
                cwd: root.display().to_string(),
            },
            display_name: "The name before".to_string(),
            ..ManagedThread::new(SESSION, RunBy::Codex, Some(1_000), None, None)
        }
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
}
