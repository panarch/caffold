//! Control model B: moving a Task into its worktree.
//!
//! A Caffold Task keeps its identifier for life, while the Grok session under
//! it is forked into the worktree and the Task re-bound to the copy. The node
//! is the binding file's `switch`; every node change goes through
//! [`GrokClient::write_switch`], and the binding's own generation refuses a
//! change decided against an older file. Each effect is one native call, and
//! what it answers is read in the graph's words before anything is written.
//!
//! | node | input | next | effect |
//! | --- | --- | --- | --- |
//! | Bound | isolate prepared (`plan_switch`) | Pending | target and the copy's id written |
//! | Pending | source loaded here and idle | Forking | — |
//! | Pending | source busy, or not loaded yet | Pending | wait for the turn's end or the load |
//! | Forking | entered | Forking | `_x.ai/session/fork {a, target, b}` asked; unanswered twice → RecoveryRequired |
//! | Forking | fork answered with `b` | Verifying | — |
//! | Forking | fork answered with another id, or refused | RecoveryRequired | nothing closed or deleted |
//! | Verifying | `session/load {b, target}` and `session/info` say target | ClosingSource | binding: current = b, history += a; the watched session is b |
//! | Verifying | load failed, or the copy runs elsewhere | RecoveryRequired | b kept |
//! | ClosingSource | `session/close {a}` answered | Bound | `history[a].close_pending` records a failure |
//! | RecoveryRequired | a person prompts, or the Task is opened cold | Forking | — |
//! | any | the bridge went away | same node | the next trigger resumes |
//! | any | erase | — | a, b and the binding deleted (`GrokClient::erase`) |
//! | any | another target planned | same node | refused |
//!
//! Triggers: the end of a turn, the leader saying idle, a cold opening, and
//! starting a turn. Only the last two move a switch that stopped short:
//! nothing retries on its own where a person's look is needed.
//!
//! Nothing asks whether the copy is there before forking: Grok answers
//! `_x.ai/session/updates` and `_x.ai/session/info` about a session it has no
//! record of exactly as about an empty one, so only `session/load` tells the
//! two apart, and that is what Verifying does. A fork asked again onto the
//! same `b` rewrites the copy from the source, which no turn has touched since
//! the switch was planned.

use std::mem;

use serde_json::Value;
use tokio::sync::OwnedMutexGuard;
use uuid::Uuid;

use super::{
    GrokClient, GrokError, GrokRuntimeEvent,
    binding::{Binding, ClosedSession, NativeSession, Switch, SwitchPhase},
    protocol::{self, CloseResult},
    same_directory,
};

/// Where the graph goes after one native answer.
enum Next {
    /// Nothing was learned, or the source is still busy: the node stands and
    /// the next trigger resumes.
    Wait,
    /// Round again from the same node.
    Again,
    Phase(SwitchPhase),
    /// The copy is loaded and checked: from here the Task runs on it.
    Commit,
    /// The source's close was answered, one way or the other.
    Done {
        closed: bool,
    },
    Recovery(String),
}

/// A failed call that said nothing about the session itself.
fn nothing_learned(error: &GrokError) -> bool {
    matches!(error, GrokError::Unreachable(_) | GrokError::TimedOut(_))
}

/// Why a turn cannot start while the switch stands where it does.
pub(super) fn turn_refusal(switch: &Switch) -> String {
    let target = &switch.target_cwd;
    match &switch.phase {
        SwitchPhase::Pending => format!(
            "Caffold moves this Task into {target} when the running turn ends; send the next message after that."
        ),
        SwitchPhase::Forking | SwitchPhase::Verifying | SwitchPhase::ClosingSource => format!(
            "Caffold is still moving this Task into {target}; send the message again in a moment."
        ),
        SwitchPhase::RecoveryRequired { reason } => format!(
            "Caffold could not move this Task into {target}: {reason} Sending another message tries again."
        ),
    }
}

impl GrokClient {
    /// Write down that this Task is to move into `target_cwd`, and move it
    /// now if nothing is running. A Task already moving somewhere else is
    /// refused; one already there, or already moving there, has nothing to
    /// add.
    pub(crate) async fn plan_switch(
        &self,
        thread_id: &str,
        target_cwd: &str,
    ) -> Result<(), GrokError> {
        let binding =
            self.inner.bindings.read(thread_id).await?.ok_or_else(|| {
                GrokError::Binding(format!("Task {thread_id} has no Grok binding"))
            })?;
        if let Some(switch) = &binding.switch {
            if same_directory(&switch.target_cwd, target_cwd) {
                self.trigger_switch(thread_id);
                return Ok(());
            }
            return Err(GrokError::Agent(format!(
                "this Task is already moving into {}; it cannot move into {target_cwd} as well",
                switch.target_cwd
            )));
        }
        if same_directory(&binding.current.cwd, target_cwd) {
            return Ok(());
        }
        let target_cwd = target_cwd.to_string();
        self.inner
            .bindings
            .update_if(thread_id, binding.generation, |binding| {
                binding.switch = Some(Switch {
                    phase: SwitchPhase::Pending,
                    target_cwd,
                    new_session_id: Uuid::now_v7().to_string(),
                    source_session_id: binding.current.session_id.clone(),
                });
            })
            .await?;
        self.note_switching(thread_id);
        self.trigger_switch(thread_id);
        Ok(())
    }

    pub(super) fn note_switching(&self, thread_id: &str) {
        self.inner
            .switching
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(thread_id.to_string());
    }

    pub(super) fn settled_switch(&self, thread_id: &str) {
        self.inner
            .switching
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(thread_id);
    }

    fn switching(&self, thread_id: &str) -> bool {
        self.inner
            .switching
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains(thread_id)
    }

    /// Move the switch on in the background, if there is one.
    pub(super) fn trigger_switch(&self, thread_id: &str) {
        if !self.switching(thread_id) {
            return;
        }
        let client = self.clone();
        let thread_id = thread_id.to_string();
        tokio::spawn(async move {
            if let Err(error) = client.advance_switch(&thread_id, false).await {
                client.report_switch_trouble(&thread_id, &error);
            }
        });
    }

    /// Move the switch on while opening the Task, reporting rather than
    /// failing: opening is not what the switch is for.
    pub(super) async fn resume_switch(&self, thread_id: &str) {
        if let Err(error) = self.advance_switch(thread_id, true).await {
            self.report_switch_trouble(thread_id, &error);
        }
    }

    fn report_switch_trouble(&self, thread_id: &str, error: &GrokError) {
        self.publish(GrokRuntimeEvent::Diagnostic {
            message: format!("the worktree switch of Task {thread_id} stopped: {error}"),
        });
    }

    /// Run the switch as far as it goes now and say where it stands: `None`
    /// once the Task is bound to where it is going, or has nothing planned.
    ///
    /// `by_person` is a prompt or a cold opening, the two things that retry
    /// a switch that stopped short.
    pub(super) async fn advance_switch(
        &self,
        thread_id: &str,
        by_person: bool,
    ) -> Result<Option<Switch>, GrokError> {
        if !self.switching(thread_id) {
            return Ok(None);
        }
        let _run = self.switch_run(thread_id).await;
        let mut forks_asked = 0u8;
        for _ in 0..16 {
            let Some(binding) = self.inner.bindings.read(thread_id).await? else {
                self.settled_switch(thread_id);
                return Ok(None);
            };
            let Some(switch) = binding.switch.clone() else {
                self.settled_switch(thread_id);
                return Ok(None);
            };
            // Archived: the switch waits for the restore, whatever its phase.
            if let Some(session) = self.session(thread_id).await
                && session.state.lock().await.closed
            {
                return Ok(Some(switch));
            }
            let next = match &switch.phase {
                SwitchPhase::Pending => {
                    if self.source_is_idle(thread_id).await {
                        Next::Phase(SwitchPhase::Forking)
                    } else {
                        Next::Wait
                    }
                }
                SwitchPhase::Forking if forks_asked >= 2 => Next::Recovery(format!(
                    "Grok did not answer the fork of session {} twice.",
                    switch.source_session_id
                )),
                SwitchPhase::Forking => {
                    forks_asked += 1;
                    self.fork(&binding, &switch).await
                }
                SwitchPhase::Verifying => self.load_copy(thread_id, &switch).await,
                SwitchPhase::ClosingSource => self.close_source(thread_id, &switch).await,
                SwitchPhase::RecoveryRequired { .. } if by_person => {
                    Next::Phase(SwitchPhase::Forking)
                }
                SwitchPhase::RecoveryRequired { .. } => Next::Wait,
            };
            match next {
                Next::Wait => return Ok(Some(switch)),
                Next::Again => {}
                Next::Phase(phase) => {
                    self.write_switch(thread_id, binding.generation, move |binding| {
                        if let Some(switch) = &mut binding.switch {
                            switch.phase = phase;
                        }
                    })
                    .await?;
                }
                Next::Commit => {
                    self.write_switch(thread_id, binding.generation, commit)
                        .await?;
                }
                Next::Done { closed } => {
                    let source = switch.source_session_id.clone();
                    self.write_switch(thread_id, binding.generation, move |binding| {
                        finish(binding, &source, closed)
                    })
                    .await?;
                    self.settled_switch(thread_id);
                    return Ok(None);
                }
                Next::Recovery(reason) => {
                    self.publish(GrokRuntimeEvent::Diagnostic {
                        message: format!(
                            "Task {thread_id} could not move into {}: {reason}",
                            switch.target_cwd
                        ),
                    });
                    let written = self
                        .write_switch(thread_id, binding.generation, move |binding| {
                            if let Some(switch) = &mut binding.switch {
                                switch.phase = SwitchPhase::RecoveryRequired { reason };
                            }
                        })
                        .await?;
                    return Ok(written.switch);
                }
            }
        }
        Err(GrokError::Binding(format!(
            "the worktree switch of Task {thread_id} did not settle"
        )))
    }

    /// The one write every node change goes through. A binding that moved on
    /// since it was read — erased, or written by another run — refuses it.
    async fn write_switch(
        &self,
        thread_id: &str,
        expected: u64,
        change: impl FnOnce(&mut Binding),
    ) -> Result<Binding, GrokError> {
        self.inner
            .bindings
            .update_if(thread_id, expected, change)
            .await
    }

    async fn switch_run(&self, thread_id: &str) -> OwnedMutexGuard<()> {
        let lock = self
            .inner
            .switch_runs
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_default()
            .clone();
        lock.lock_owned().await
    }

    /// Idle means loaded on the bridge in hand, no turn known to run, and no
    /// prompt of this process still unanswered. Not loaded is not idle: what
    /// the source is doing has not been seen yet.
    async fn source_is_idle(&self, thread_id: &str) -> bool {
        let Some(session) = self.session(thread_id).await else {
            return false;
        };
        let Some(generation) = self.inner.transport.generation().await else {
            return false;
        };
        let state = session.state.lock().await;
        state.loaded_on == generation
            && state.active_turn.is_none()
            && !state.prompt_in_flight
            && !state.closed
    }

    async fn fork(&self, binding: &Binding, switch: &Switch) -> Next {
        let source = &switch.source_session_id;
        let copy = &switch.new_session_id;
        let answer = self
            .inner
            .transport
            .call(
                "_x.ai/session/fork",
                protocol::fork_params(source, &binding.current.cwd, &switch.target_cwd, copy),
            )
            .await;
        match answer {
            Ok(answer) => match answer.get("newSessionId").and_then(Value::as_str) {
                Some(id) if id == copy => Next::Phase(SwitchPhase::Verifying),
                Some(id) => Next::Recovery(format!(
                    "Grok forked session {source} into {id} instead of {copy}; neither was touched."
                )),
                None => Next::Recovery(format!(
                    "Grok answered the fork of session {source} without naming the copy."
                )),
            },
            Err(error) if nothing_learned(&error) => Next::Again,
            Err(error) => {
                Next::Recovery(format!("Grok refused to fork session {source}: {error}."))
            }
        }
    }

    /// Load the copy on the bridge in hand and check it runs in the target.
    /// From then on the watched session is the copy.
    async fn load_copy(&self, thread_id: &str, switch: &Switch) -> Next {
        let Ok(bridge) = self.inner.transport.bridge().await else {
            return Next::Wait;
        };
        let Some(session) = self.session(thread_id).await else {
            return Next::Wait;
        };
        let copy = NativeSession {
            session_id: switch.new_session_id.clone(),
            cwd: switch.target_cwd.clone(),
        };
        // Claimed and routed before the load, so what the leader streams
        // while loading the copy reaches this session.
        let previous = mem::replace(&mut session.state.lock().await.loaded_on, bridge.generation);
        self.inner
            .natives
            .lock()
            .await
            .insert(copy.session_id.clone(), thread_id.to_string());
        match self.load_and_check(&bridge, thread_id, &copy).await {
            Ok((loaded, info)) => {
                let source = mem::replace(&mut *session.native.lock().await, copy);
                self.inner.natives.lock().await.remove(&source.session_id);
                self.absorb_loaded(&session, loaded, info).await;
                Next::Commit
            }
            Err(error) => {
                self.inner.natives.lock().await.remove(&copy.session_id);
                session.state.lock().await.loaded_on = previous;
                if nothing_learned(&error) {
                    Next::Wait
                } else {
                    Next::Recovery(format!(
                        "the copy {} could not be loaded in {}: {error}.",
                        switch.new_session_id, switch.target_cwd
                    ))
                }
            }
        }
    }

    async fn close_source(&self, thread_id: &str, switch: &Switch) -> Next {
        let source = &switch.source_session_id;
        let answer = self
            .inner
            .transport
            .call("session/close", protocol::session_params(source))
            .await;
        let closed = match answer {
            Ok(value) => {
                let closed: CloseResult = serde_json::from_value(value).unwrap_or_default();
                closed.closed()
            }
            Err(GrokError::ConversationGone(_)) => true,
            Err(error) if nothing_learned(&error) => return Next::Wait,
            Err(_) => false,
        };
        if !closed {
            self.publish(GrokRuntimeEvent::Diagnostic {
                message: format!(
                    "Grok did not close session {source} of Task {thread_id}; it stays in the Task's history to close later"
                ),
            });
        }
        Next::Done { closed }
    }
}

/// The Task runs on the copy from here; the source joins its history.
fn commit(binding: &mut Binding) {
    let Some(switch) = &mut binding.switch else {
        return;
    };
    let copy = NativeSession {
        session_id: switch.new_session_id.clone(),
        cwd: switch.target_cwd.clone(),
    };
    let source = mem::replace(&mut binding.current, copy);
    binding.history.push(ClosedSession {
        session_id: source.session_id,
        cwd: source.cwd,
        close_pending: true,
    });
    switch.phase = SwitchPhase::ClosingSource;
}

fn finish(binding: &mut Binding, source: &str, closed: bool) {
    if closed
        && let Some(left) = binding
            .history
            .iter_mut()
            .find(|closed| closed.session_id == source)
    {
        left.close_pending = false;
    }
    binding.switch = None;
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::Path,
        sync::{
            Arc,
            atomic::{AtomicU8, Ordering},
        },
        time::Duration,
    };

    use serde_json::json;
    use tokio::time::{sleep, timeout};

    use super::super::{
        GrokClient, GrokError, GrokRuntimeEvent, GrokTurnOptions, MockLeader,
        binding::{Binding, ClosedSession, NativeSession, Switch, SwitchPhase},
        test_support::{scripted_leader, scripted_leader_with, update_frame},
        transport::mock::MockAnswer,
    };

    const CWD: &str = "/Users/example/project";
    const TARGET: &str = "/Users/example/worktrees/one";
    const SOURCE: &str = "01a09482-370e-7001-a329-9a7d78be2cb8";
    const COPY: &str = "01a09482-3275-7688-a619-fb65da53debe";
    const TASK: &str = "01a0a000-0000-7000-8000-000000000001";
    const WAIT: Duration = Duration::from_secs(5);

    async fn binding_of(client: &GrokClient, id: &str) -> Binding {
        client
            .inner
            .bindings
            .read(id)
            .await
            .unwrap()
            .expect("a binding")
    }

    /// The binding once its switch is over.
    async fn settled(client: &GrokClient, id: &str) -> Binding {
        timeout(WAIT, async {
            loop {
                let binding = binding_of(client, id).await;
                if binding.switch.is_none() {
                    return binding;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the switch settles")
    }

    /// The switch once it has stopped short.
    async fn stopped_short(client: &GrokClient, id: &str) -> Switch {
        timeout(WAIT, async {
            loop {
                if let Some(switch) = binding_of(client, id).await.switch
                    && matches!(switch.phase, SwitchPhase::RecoveryRequired { .. })
                {
                    return switch;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the switch stops short")
    }

    /// The requests of `method` once `count` of them have arrived: a prompt
    /// is sent from a task of its own, so it may land after the call returns.
    async fn requests_reaching(
        leader: &MockLeader,
        method: &str,
        count: usize,
    ) -> Vec<serde_json::Value> {
        timeout(WAIT, async {
            loop {
                let requests = leader.requests(method);
                if requests.len() >= count {
                    return requests;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("{count} requests of {method} arrive"))
    }

    fn write_binding(dir: &Path, binding: &Binding) {
        let dir = dir.join("grok/bindings");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{}.json", binding.thread_id)),
            serde_json::to_vec(binding).unwrap(),
        )
        .unwrap();
    }

    #[tokio::test]
    async fn the_task_moves_into_its_worktree_when_the_turn_that_asked_ends() {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, _memory) = scripted_leader(bridges);
        client.watch();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        client
            .start_turn(&id, CWD, "isolate me", &[], &GrokTurnOptions::default())
            .await
            .unwrap();
        leader.wait_for("session/prompt").await;

        client.plan_switch(&id, TARGET).await.unwrap();
        let copy = binding_of(&client, &id)
            .await
            .switch
            .expect("planned")
            .new_session_id;
        sleep(Duration::from_millis(50)).await;
        assert!(
            leader.requests("_x.ai/session/fork").is_empty(),
            "nothing moves while the turn runs"
        );

        leader
            .answer("session/prompt", json!({ "stopReason": "end_turn" }))
            .await;
        let forked = leader.wait_for("_x.ai/session/fork").await;
        assert_eq!(forked["sourceSessionId"], id);
        assert_eq!(forked["sourceCwd"], CWD);
        assert_eq!(forked["newCwd"], TARGET);
        assert_eq!(forked["newSessionId"], copy);
        let binding = settled(&client, &id).await;
        assert_eq!(
            binding.current,
            NativeSession {
                session_id: copy.clone(),
                cwd: TARGET.to_string(),
            }
        );
        assert_eq!(
            binding.history,
            vec![ClosedSession {
                session_id: id.clone(),
                cwd: CWD.to_string(),
                close_pending: false,
            }]
        );
        let loaded = leader.requests("session/load");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["sessionId"], copy);
        assert_eq!(loaded[0]["cwd"], TARGET);
        let closed = leader.requests("session/close");
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0]["sessionId"], id);
        assert_eq!(
            client.watched_conversation(&id).await.unwrap().cwd,
            TARGET,
            "the Task reads as living in the worktree"
        );

        // What the source still says is nobody's now, and history is read
        // from the copy.
        let turns_before = client.watched_conversation(&id).await.unwrap().turns;
        leader
            .notify(
                "session/update",
                update_frame(&id, "e-late", "late-turn", json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "from the source" } })),
            )
            .await;
        client.read_turns(&id, None, 2).await.unwrap();
        assert_eq!(
            leader.wait_for("_x.ai/session/updates").await["sessionId"],
            copy
        );
        assert_eq!(
            client.watched_conversation(&id).await.unwrap().turns,
            turns_before,
            "a late word from the source changes nothing"
        );

        // Turns run on the copy in the worktree, and nowhere else.
        assert!(
            client
                .start_turn(&id, CWD, "again", &[], &GrokTurnOptions::default())
                .await
                .is_err()
        );
        client
            .start_turn(&id, TARGET, "again", &[], &GrokTurnOptions::default())
            .await
            .unwrap();
        let prompts = requests_reaching(&leader, "session/prompt", 2).await;
        assert_eq!(prompts.len(), 2);
        assert_eq!(prompts[1]["sessionId"], copy);

        // The next process opens the copy and forks nothing.
        let (again, bridges) = GrokClient::mock(dir.path());
        let (leader_again, memory_again) = scripted_leader(bridges);
        memory_again
            .lock()
            .unwrap()
            .cwds
            .insert(copy.clone(), TARGET.to_string());
        again.watch();
        let opened = again.open_conversation(&id).await.unwrap();
        assert_eq!(opened.cwd, TARGET);
        assert!(leader_again.requests("_x.ai/session/fork").is_empty());
        assert_eq!(leader_again.requests("session/load")[0]["sessionId"], copy);
        drop(leader);
    }

    #[tokio::test]
    async fn an_idle_task_moves_as_soon_as_the_move_is_planned() {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, _memory) = scripted_leader(bridges);
        client.watch();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        client.plan_switch(&id, TARGET).await.unwrap();
        let binding = settled(&client, &id).await;
        assert_eq!(binding.current.cwd, TARGET);
        assert_eq!(leader.requests("_x.ai/session/fork").len(), 1);
        assert_eq!(leader.requests("session/load").len(), 1);
        assert_eq!(leader.requests("session/close").len(), 1);
        assert_eq!(client.watched_conversation(&id).await.unwrap().cwd, TARGET);
        // Planning the same move again changes nothing.
        client.plan_switch(&id, TARGET).await.unwrap();
        assert!(binding_of(&client, &id).await.switch.is_none());
        assert_eq!(leader.requests("_x.ai/session/fork").len(), 1);

        // Archiving and restoring from here on speak of the copy.
        let copy = binding.current.session_id.clone();
        client.close_conversation(&id).await.unwrap();
        let closed = leader.requests("session/close");
        assert_eq!(closed.last().unwrap()["sessionId"], copy);
        assert!(!client.conversation_exists(&id).await);
        fs::create_dir_all(client.session_directory(&binding.current)).unwrap();
        assert!(client.conversation_exists(&id).await);
        let restored = client.open_conversation(&id).await.unwrap();
        assert_eq!(restored.cwd, TARGET);
        let loaded = leader.requests("session/load");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[1]["sessionId"], copy);
        assert_eq!(loaded[1]["cwd"], TARGET);
        assert_eq!(leader.requests("_x.ai/session/fork").len(), 1);
    }

    /// Archiving a Task whose move is planned keeps the plan and moves
    /// nothing; the restore is what moves it.
    #[tokio::test]
    async fn an_archived_task_keeps_its_planned_move_for_the_restore() {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, _memory) = scripted_leader(bridges);
        client.watch();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        client
            .start_turn(&id, CWD, "isolate me", &[], &GrokTurnOptions::default())
            .await
            .unwrap();
        leader.wait_for("session/prompt").await;
        client.plan_switch(&id, TARGET).await.unwrap();

        client.close_conversation(&id).await.unwrap();
        leader
            .answer("session/prompt", json!({ "stopReason": "end_turn" }))
            .await;
        sleep(Duration::from_millis(100)).await;
        assert!(
            leader.requests("_x.ai/session/fork").is_empty(),
            "an archived Task is not moved"
        );
        assert_eq!(
            binding_of(&client, &id).await.switch.unwrap().phase,
            SwitchPhase::Pending
        );

        client.open_conversation(&id).await.unwrap();
        let binding = settled(&client, &id).await;
        assert_eq!(binding.current.cwd, TARGET);
        assert_eq!(leader.requests("_x.ai/session/fork").len(), 1);
        assert_eq!(client.watched_conversation(&id).await.unwrap().cwd, TARGET);
    }

    /// The process died somewhere along the switch; the next one takes it up
    /// from the phase on disk.
    #[tokio::test]
    async fn a_switch_interrupted_at_any_phase_is_taken_up_where_it_stopped() {
        let source = NativeSession {
            session_id: SOURCE.to_string(),
            cwd: CWD.to_string(),
        };
        let copy = NativeSession {
            session_id: COPY.to_string(),
            cwd: TARGET.to_string(),
        };
        // (case, phase on disk, whether the copy exists, current, history,
        // forks expected, sessions loaded expected). A switch still pending
        // loads the source first, to see it idle; every later phase loads
        // only the copy. Forking forks whether or not the copy is there: a
        // fork onto the same id rewrites it.
        let cases = [
            (
                "pending",
                SwitchPhase::Pending,
                false,
                source.clone(),
                vec![],
                1,
                vec![SOURCE, COPY],
            ),
            (
                "forking, copy absent",
                SwitchPhase::Forking,
                false,
                source.clone(),
                vec![],
                1,
                vec![COPY],
            ),
            (
                "forking, fork answered but lost",
                SwitchPhase::Forking,
                true,
                source.clone(),
                vec![],
                1,
                vec![COPY],
            ),
            (
                "verifying",
                SwitchPhase::Verifying,
                true,
                source.clone(),
                vec![],
                0,
                vec![COPY],
            ),
            (
                "closing the source",
                SwitchPhase::ClosingSource,
                true,
                copy.clone(),
                vec![ClosedSession {
                    session_id: SOURCE.to_string(),
                    cwd: CWD.to_string(),
                    close_pending: true,
                }],
                0,
                vec![COPY],
            ),
        ];
        for (case, phase, copy_exists, current, history, forks, loads) in cases {
            let dir = tempfile::tempdir().unwrap();
            write_binding(
                dir.path(),
                &Binding {
                    version: 1,
                    thread_id: TASK.to_string(),
                    generation: 7,
                    current,
                    history,
                    switch: Some(Switch {
                        phase,
                        target_cwd: TARGET.to_string(),
                        new_session_id: COPY.to_string(),
                        source_session_id: SOURCE.to_string(),
                    }),
                },
            );
            let (client, bridges) = GrokClient::mock(dir.path());
            let (leader, memory) = scripted_leader(bridges);
            {
                let mut memory = memory.lock().unwrap();
                memory.cwds.insert(SOURCE.to_string(), CWD.to_string());
                if copy_exists {
                    memory.cwds.insert(COPY.to_string(), TARGET.to_string());
                }
            }
            client.watch();
            let opened = client.open_conversation(TASK).await.expect(case);
            assert_eq!(opened.cwd, TARGET, "{case}");
            let binding = settled(&client, TASK).await;
            assert_eq!(binding.current, copy, "{case}");
            assert_eq!(
                binding.history,
                vec![ClosedSession {
                    session_id: SOURCE.to_string(),
                    cwd: CWD.to_string(),
                    close_pending: false,
                }],
                "{case}"
            );
            assert_eq!(leader.requests("_x.ai/session/fork").len(), forks, "{case}");
            let loaded = leader
                .requests("session/load")
                .iter()
                .map(|params| params["sessionId"].as_str().unwrap().to_string())
                .collect::<Vec<_>>();
            assert_eq!(loaded, loads, "{case}");
            let closed = leader.requests("session/close");
            assert_eq!(closed.len(), 1, "{case}");
            assert_eq!(closed[0]["sessionId"], SOURCE, "{case}");
        }
    }

    #[tokio::test]
    async fn a_refused_fork_stops_the_switch_until_a_person_prompts_again() {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let refusals = Arc::new(AtomicU8::new(2));
        let refusing = refusals.clone();
        let (leader, _memory) = scripted_leader_with(bridges, move |method, _| {
            if method != "_x.ai/session/fork" {
                return None;
            }
            let left = refusing.load(Ordering::SeqCst);
            if left == 0 {
                return None;
            }
            refusing.store(left - 1, Ordering::SeqCst);
            Some(MockAnswer::Error(-32603, "the disk is full"))
        });
        client.watch();
        let mut events = client.subscribe();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();

        client.plan_switch(&id, TARGET).await.unwrap();
        let stuck = stopped_short(&client, &id).await;
        let SwitchPhase::RecoveryRequired { reason } = &stuck.phase else {
            panic!()
        };
        assert!(reason.contains("the disk is full"), "{reason}");
        let binding = binding_of(&client, &id).await;
        assert_eq!(binding.current.cwd, CWD, "the source stays the Task's");
        assert!(leader.requests("session/close").is_empty());
        assert!(leader.requests("_x.ai/session/delete").is_empty());
        let told = timeout(WAIT, async {
            loop {
                if let Ok(GrokRuntimeEvent::Diagnostic { message }) = events.recv().await
                    && message.contains("the disk is full")
                {
                    return message;
                }
            }
        })
        .await
        .expect("the trouble is reported");
        assert!(told.contains(&id));

        // A prompt is a person looking: it tries again, and this time the
        // fork is refused once more, so the turn is refused with the reason.
        let refused = client
            .start_turn(&id, TARGET, "go on", &[], &GrokTurnOptions::default())
            .await;
        let Err(GrokError::Agent(message)) = refused else {
            panic!("{refused:?}")
        };
        assert!(message.contains("could not move this Task"), "{message}");
        assert!(message.contains("the disk is full"), "{message}");
        assert_eq!(leader.requests("_x.ai/session/fork").len(), 2);

        // The next prompt gets the fork through, and runs in the worktree.
        client
            .start_turn(&id, TARGET, "go on", &[], &GrokTurnOptions::default())
            .await
            .unwrap();
        let binding = settled(&client, &id).await;
        assert_eq!(binding.current.cwd, TARGET);
        assert_eq!(leader.requests("_x.ai/session/fork").len(), 3);
        let prompts = requests_reaching(&leader, "session/prompt", 1).await;
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0]["sessionId"], binding.current.session_id);
    }

    /// The bridge dies under the fork request, twice. A fork that never
    /// answers is not asked a third time.
    #[tokio::test]
    async fn a_fork_whose_answer_is_lost_twice_stops_the_switch() {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, _memory) = scripted_leader_with(bridges, |method, _| {
            (method == "_x.ai/session/fork").then_some(MockAnswer::Hold)
        });
        client.watch();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        client.plan_switch(&id, TARGET).await.unwrap();
        for asked in 1..=2 {
            requests_reaching(&leader, "_x.ai/session/fork", asked).await;
            leader.drop_bridge();
        }
        let stuck = stopped_short(&client, &id).await;
        let SwitchPhase::RecoveryRequired { reason } = &stuck.phase else {
            panic!()
        };
        assert!(reason.contains("twice"), "{reason}");
        assert_eq!(leader.requests("_x.ai/session/fork").len(), 2);
        assert!(leader.requests("session/close").is_empty());
        assert_eq!(binding_of(&client, &id).await.current.cwd, CWD);
    }

    /// Grok describes a copy it never wrote as an empty session, not a
    /// missing one, so the retry does not ask: it forks, onto the same id.
    #[tokio::test]
    async fn a_person_retrying_a_stopped_switch_forks_again() {
        let dir = tempfile::tempdir().unwrap();
        write_binding(
            dir.path(),
            &Binding {
                version: 1,
                thread_id: TASK.to_string(),
                generation: 7,
                current: NativeSession {
                    session_id: SOURCE.to_string(),
                    cwd: CWD.to_string(),
                },
                history: vec![],
                switch: Some(Switch {
                    phase: SwitchPhase::RecoveryRequired {
                        reason: "the copy could not be loaded.".to_string(),
                    },
                    target_cwd: TARGET.to_string(),
                    new_session_id: COPY.to_string(),
                    source_session_id: SOURCE.to_string(),
                }),
            },
        );
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, memory) = scripted_leader(bridges);
        memory
            .lock()
            .unwrap()
            .cwds
            .insert(SOURCE.to_string(), CWD.to_string());
        client.watch();
        let opened = client.open_conversation(TASK).await.unwrap();
        assert_eq!(opened.cwd, TARGET);
        let binding = settled(&client, TASK).await;
        assert_eq!(binding.current.session_id, COPY);
        let forked = leader.requests("_x.ai/session/fork");
        assert_eq!(forked.len(), 1);
        assert_eq!(forked[0]["newSessionId"], COPY);
        assert_eq!(
            leader.requests("session/load").last().unwrap()["sessionId"],
            COPY
        );
    }

    #[tokio::test]
    async fn a_fork_that_names_another_session_touches_nothing_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, _memory) = scripted_leader_with(bridges, |method, _| {
            (method == "_x.ai/session/fork").then(|| {
                MockAnswer::Result(json!({ "newSessionId": "01a0ffff-0000-7000-8000-00000000beef", "newCwd": TARGET }))
            })
        });
        client.watch();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        client.plan_switch(&id, TARGET).await.unwrap();
        let stuck = stopped_short(&client, &id).await;
        let SwitchPhase::RecoveryRequired { reason } = &stuck.phase else {
            panic!()
        };
        assert!(reason.contains("instead of"), "{reason}");
        assert!(leader.requests("session/load").is_empty());
        assert!(leader.requests("session/close").is_empty());
        assert!(leader.requests("_x.ai/session/delete").is_empty());
        assert_eq!(binding_of(&client, &id).await.current.cwd, CWD);
    }

    #[tokio::test]
    async fn erasing_a_moving_task_removes_the_copy_as_well() {
        let dir = tempfile::tempdir().unwrap();
        let (client, bridges) = GrokClient::mock(dir.path());
        let (leader, _memory) = scripted_leader(bridges);
        client.watch();
        let conversation = client
            .start_conversation(CWD, &GrokTurnOptions::default())
            .await
            .unwrap();
        let id = conversation.id.clone();
        client
            .start_turn(&id, CWD, "isolate me", &[], &GrokTurnOptions::default())
            .await
            .unwrap();
        leader.wait_for("session/prompt").await;
        client.plan_switch(&id, TARGET).await.unwrap();
        let copy = binding_of(&client, &id)
            .await
            .switch
            .expect("planned")
            .new_session_id;

        client.erase(&id).await.unwrap();
        let deleted = leader
            .requests("_x.ai/session/delete")
            .into_iter()
            .map(|params| params["sessionId"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        assert!(deleted.contains(&id), "{deleted:?}");
        assert!(deleted.contains(&copy), "{deleted:?}");
        assert!(client.inner.bindings.read(&id).await.unwrap().is_none());
    }
}
