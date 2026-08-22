//! What only the real `claude` can prove about a Claude Task.
//!
//! Most cases here are things that go wrong between processes rather than
//! inside one: the backend is replaced while an agent is working, the runner is
//! killed outright, a question is left unanswered by the client that was asked
//! it. None of that can be shown against a stand-in, because what is being
//! checked is whether the real `claude` still honours a client that left and
//! came back, and whether Caffold asks it the right question when it does. The
//! rest is the agent reaching Caffold on purpose — calling the tool Caffold
//! serves — where the stand-in would only prove that Caffold agrees with
//! itself.
//!
//! So these drive the shipped binary over HTTP, as a browser does. A case
//! reads as the sequence a person would carry out, and a failure is
//! reproducible by hand from the same requests.
//!
//! They need an authenticated Claude CLI and spend model usage, so they are
//! opt-in:
//!
//! ```sh
//! cargo test -p caffold --test claude_live -- --ignored --test-threads=1
//! ```

mod support;

use std::time::Duration;

use support::{Backend, TurnState};

/// The cheapest model that can still run a tool. Nothing here asserts anything
/// about what the model says, only about what Caffold does around it.
const MODEL: &str = "haiku";

/// Work no model will do without asking. Something obviously harmless does
/// not serve: the agent decides that for itself and never stops, and the case
/// would then be waiting for a question that never comes.
const NEEDS_APPROVAL: &str =
    "Use the Bash tool to run exactly: rm -rf /tmp/caffold-live-does-not-exist. Just run it.";

/// Work that takes long enough to restart underneath, and that any model can
/// do: read a handful of small files, one at a time.
const SLOW_WORK: &str = "Read every file in this directory one at a time, \
     and write one short sentence about each. Do not skip any.";

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_turn_running_when_the_backend_is_replaced_is_still_running_afterwards() {
    // The reason the runner exists. The backend is the part that gets replaced
    // — an application update, a crash, a developer restarting it — and the
    // agent should not lose the work it was in the middle of.
    let mut backend = Backend::start().await;
    let task = backend.start_task(SLOW_WORK, MODEL).await;
    let working = task
        .wait_for(TurnState::Running, Duration::from_secs(90))
        .await;

    backend.replace().await;

    let after = task.wait_until_known(Duration::from_secs(30)).await;
    assert_eq!(
        after.turn_id, working.turn_id,
        "the same turn, not a new one: {after:?}"
    );
    assert_eq!(after.state, TurnState::Running);
    let finished = task
        .wait_for(TurnState::Idle, Duration::from_secs(300))
        .await;
    assert!(
        finished.events > working.events,
        "and it went on working while nobody was watching: {} then {}",
        working.events,
        finished.events,
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_working_task_never_reads_as_idle_while_the_backend_comes_back() {
    // Worse than being wrong once. A Task that reads as idle for even a moment
    // is one a person will send a second prompt to, or give up on, while the
    // agent is still working on the first.
    let mut backend = Backend::start().await;
    let task = backend.start_task(SLOW_WORK, MODEL).await;
    task.wait_for(TurnState::Running, Duration::from_secs(90))
        .await;

    backend.replace().await;

    let readings = task.watch_for(Duration::from_secs(20)).await;
    // A turn that finishes during the watch is a turn finishing, so what is
    // claimed is the order rather than the absence: working, then done, and
    // never back. The defect this catches reads as idle first and only then
    // admits the turn, which is the one order a person cannot make sense of.
    let first_idle = readings.iter().position(|state| *state == TurnState::Idle);
    assert_eq!(
        readings.first(),
        Some(&TurnState::Running),
        "the Task is working the moment it can be read: {readings:?}"
    );
    if let Some(first_idle) = first_idle {
        assert!(
            readings[first_idle..]
                .iter()
                .all(|state| *state == TurnState::Idle),
            "and once it is done it stays done: {readings:?}"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_task_can_be_spoken_to_again_after_the_backend_is_replaced() {
    // Recovering the view is not enough on its own. The Task has to be usable:
    // a message sent while the agent works joins the turn it is working on, and
    // one sent afterwards starts a new turn.
    let mut backend = Backend::start().await;
    let task = backend.start_task(SLOW_WORK, MODEL).await;
    task.wait_for(TurnState::Running, Duration::from_secs(90))
        .await;
    backend.replace().await;

    let steered = task.say("and mention how many there were").await;
    assert!(
        steered.steered,
        "a message sent to a working agent joins the turn it is working on"
    );

    task.wait_for(TurnState::Idle, Duration::from_secs(300))
        .await;
    let asked = task.say("Reply with the single word: alive.").await;
    assert!(
        !asked.steered,
        "and one sent afterwards starts a turn of its own"
    );
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn the_list_shows_a_working_claude_task_without_anyone_opening_it() {
    // The list is the first thing a person sees, and the place they decide
    // whether anything needs them. A working Task that reads as nothing there
    // sends them clicking every row to find out — and after a restart, every
    // row they had not clicked yet would read that way for as long as its turn
    // runs, which is exactly the stretch worth showing.
    let mut backend = Backend::start().await;
    let task = backend.start_task(SLOW_WORK, MODEL).await;
    task.wait_for(TurnState::Running, Duration::from_secs(90))
        .await;

    let row = backend
        .wait_for_list_row(
            task.thread_id(),
            TurnState::Running,
            Duration::from_secs(30),
        )
        .await;
    assert_eq!(row["latestTurnStatus"], "inProgress", "{row}");

    backend.replace().await;

    let row = backend
        .wait_for_list_row(
            task.thread_id(),
            TurnState::Running,
            Duration::from_secs(30),
        )
        .await;
    assert_eq!(
        row["latestTurnStatus"], "inProgress",
        "after the backend was replaced, with nobody opening the Task: {row}"
    );

    task.wait_for(TurnState::Idle, Duration::from_secs(300))
        .await;
    backend
        .wait_for_list_row(task.thread_id(), TurnState::Idle, Duration::from_secs(30))
        .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_question_nobody_answered_is_asked_again_after_the_backend_is_replaced() {
    // The agent stops and waits when it needs permission. If the backend is
    // replaced before anyone answers, the client that was asked is gone — and
    // the agent waits for an answer that will never come unless it is asked
    // again. Nothing is kept anywhere to make that happen: the agent holds its
    // own unanswered questions and hands them back when greeted.
    let mut backend = Backend::start().await;
    let task = backend
        .start_task_asking_permission(NEEDS_APPROVAL, MODEL)
        .await;
    let asked = task.wait_for_a_question(Duration::from_secs(120)).await;

    backend.replace().await;

    let asked_again = task.wait_for_a_question(Duration::from_secs(60)).await;
    assert_eq!(
        asked_again, asked,
        "the same question, under the identity the agent gave it"
    );
    task.answer(&asked_again, "allow").await;
    // Answering has to reach the agent, or knowing about the question would not
    // be worth anything. The turn is not waited out: an agent granted one
    // permission may ask for another, and that is the turn going on rather than
    // the turn stuck.
    assert!(
        task.answered_a_question_within(Duration::from_secs(120))
            .await,
        "the answer reaches the agent the question came from"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn restarting_the_claude_runtime_ends_its_sessions_and_tasks_resume() {
    // The explicit restart a person asks for in Settings. The runner is
    // replaced, every session it held ends the way an application update ends
    // them, and a Task spoken to afterwards resumes its conversation on a
    // fresh agent.
    let backend = Backend::start().await;
    let task = backend
        .start_task("Reply with the single word: ok.", MODEL)
        .await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;
    let old_agent = backend.agent_process().await;

    let replaced = backend
        .post("/api/claude/restart", serde_json::json!({}))
        .await
        .expect("the restart answers");
    assert_eq!(
        replaced["sessions"], 0,
        "the replacement runner holds nothing: {replaced}"
    );
    assert!(
        support::wait_for_process_exit(old_agent),
        "the old agent ended with the old runner"
    );

    let asked = task.say("Reply with the single word: alive.").await;
    assert!(!asked.steered, "a fresh turn on a fresh session");
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn the_agent_renames_its_task_when_asked_to_in_the_conversation() {
    // The one tool Caffold serves the agent, driven the only way it is meant
    // to be driven: a person asks in the conversation, the model calls
    // `mcp__caffold__rename_current_task`, and the name every surface reads
    // changes. The whole exchange happens inside the asking turn — discovery,
    // the call, and the agent's own session title following over a control
    // request — which is exactly what a stand-in cannot vouch for.
    let backend = Backend::start().await;
    let task = backend
        .start_task(
            "Call the mcp__caffold__rename_current_task tool with name \
             'Renamed by the agent'. Then reply with the single word: done.",
            MODEL,
        )
        .await;

    backend
        .wait_for_task_name(
            task.thread_id(),
            "Renamed by the agent",
            Duration::from_secs(180),
        )
        .await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_new_task_is_named_by_the_agent_on_its_first_turn() {
    // Nothing in the prompt mentions naming. The once-only session setup on a
    // fresh session's hello is what asks for it, so the `[REQ]` placeholder a
    // Task is created wearing giving way to a real name is that setup landing,
    // the model honouring it, and the rename loop closing — unprompted.
    let backend = Backend::start().await;
    let task = backend
        .start_task(
            "Say one friendly sentence about the Rust programming language.",
            MODEL,
        )
        .await;

    let named = backend
        .wait_past_placeholder_name(task.thread_id(), "[REQ]", Duration::from_secs(180))
        .await;
    assert!(
        !named.trim().is_empty(),
        "the agent chose a name of its own: {named:?}"
    );
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_conversation_survives_the_runner_being_killed_outright() {
    // The runner is what holds the agent, and a runner killed outright runs no
    // shutdown code: its children are left running with nothing able to reach
    // them. The next runner ends what the last one left, so the conversation is
    // taken up by one agent rather than continued by two.
    let backend = Backend::start().await;
    let task = backend.start_task(SLOW_WORK, MODEL).await;
    task.wait_for(TurnState::Running, Duration::from_secs(90))
        .await;
    let orphan = backend.agent_process().await;

    backend.kill_runner_outright().await;
    assert!(
        support::is_running(orphan),
        "a runner killed outright leaves its child running"
    );

    let alive = task.say("Reply with the single word: alive.").await;
    assert!(!alive.steered, "the conversation is taken up again");
    assert!(
        support::wait_for_process_exit(orphan),
        "and the agent the dead runner left behind is ended rather than left \
         writing to the same conversation"
    );
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;
}
