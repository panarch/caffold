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

/// The model for the cases that hang on unprompted instruction-following —
/// the first-turn naming setup, the guide-phrase isolation. The cheapest
/// model skips an instructed tool call often enough to make those cases
/// flaky about the model rather than about Caffold, the same way the Codex
/// live suite pins particular models to particular coverage.
const INSTRUCTED_MODEL: &str = "sonnet";

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
            INSTRUCTED_MODEL,
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
async fn the_agent_isolates_its_task_into_a_worktree_when_asked() {
    // The whole loop, driven by the phrase the new-Task page suggests: the
    // model calls the isolate tool Caffold serves, the shared worktree
    // machinery prepares the checkout, the session is moved into it — and the
    // proof is the next turn's `pwd` coming back from inside the worktree.
    let backend = Backend::start().await;
    backend.make_notes_a_repository();
    let task = backend
        .start_task(
            "Prepare this task in an isolated worktree. Leave my current checkout changes \
             in place. Stop when the worktree is ready.",
            INSTRUCTED_MODEL,
        )
        .await;
    task.wait_for(TurnState::Idle, Duration::from_secs(180))
        .await;

    // The Task now works somewhere else, and says so.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let worktree_cwd = loop {
        let detail = backend
            .get(&format!("/api/tasks/{}", task.thread_id()))
            .await;
        let cwd = detail
            .as_ref()
            .and_then(|detail| detail["task"]["cwd"].as_str())
            .unwrap_or_default()
            .to_string();
        if cwd.contains("worktrees") {
            break cwd;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the Task never moved: {detail:?}"
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
    };

    // A relative write is the proof: it lands wherever the agent's tools
    // actually run, and nowhere else.
    task.say(
        "Use the Bash tool to run exactly: pwd > caffold-live-proof.txt. \
         Then reply with the single word: done.",
    )
    .await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;
    let proof =
        std::fs::read_to_string(std::path::Path::new(&worktree_cwd).join("caffold-live-proof.txt"))
            .expect("the write landed in the worktree the agent was moved to");
    assert_eq!(proof.trim(), worktree_cwd);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_command_a_person_allows_actually_runs() {
    // Allowing is only real if the tool then runs. The regression this pins:
    // the answer carried `updatedInput: null` where the agent validates
    // `updatedInput?: object`, so every allowed tool failed with "invalid
    // permission result" — while the old assertion, which only watched the
    // question get resolved, stayed green.
    let backend = Backend::start().await;
    let task = backend
        .start_task_asking_permission(NEEDS_APPROVAL, MODEL)
        .await;
    let asked = task.wait_for_a_question(Duration::from_secs(120)).await;

    task.answer(&asked, "allow").await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;

    let detail = task.detail().await;
    let text = detail.to_string();
    assert!(
        detail["events"]
            .as_array()
            .expect("events")
            .iter()
            .any(|event| {
                event["type"] == "command_execution" && event["summary"] == "Command completed"
            }),
        "the allowed command ran: {text}"
    );
    assert!(
        !text.contains("canUseTool callback returned"),
        "and the answer was a shape the agent accepts: {text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_command_allowed_always_runs_and_is_not_asked_about_again() {
    // Allowing always carries the grant the agent proposed, so the same
    // command asked a second time runs without stopping anyone.
    let backend = Backend::start().await;
    let task = backend
        .start_task_asking_permission(NEEDS_APPROVAL, MODEL)
        .await;
    let asked = task.wait_for_a_question(Duration::from_secs(120)).await;

    task.answer(&asked, "allowAlways").await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;
    task.say("Run the exact same command once more, then reply done.")
        .await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;

    let detail = task.detail().await;
    let text = detail.to_string();
    assert!(!text.contains("canUseTool callback returned"), "{text}");
    let events = detail["events"].as_array().expect("events");
    let ran = events
        .iter()
        .filter(|event| {
            event["type"] == "command_execution" && event["summary"] == "Command completed"
        })
        .count();
    assert!(ran >= 2, "the command ran both times: {text}");
    let questions = events
        .iter()
        .filter(|event| event["type"] == "approval_requested")
        .count();
    assert_eq!(
        questions, 1,
        "the grant covered the second run, so nobody was asked again: {text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_command_a_person_declines_reads_as_declined_and_does_not_run() {
    let backend = Backend::start().await;
    let task = backend
        .start_task_asking_permission(NEEDS_APPROVAL, MODEL)
        .await;
    let asked = task.wait_for_a_question(Duration::from_secs(120)).await;

    task.answer(&asked, "deny").await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;

    let detail = task.detail().await;
    let text = detail.to_string();
    let events = detail["events"].as_array().expect("events");
    assert!(
        events.iter().any(|event| {
            event["type"] == "command_execution" && event["summary"] == "Command declined"
        }),
        "a refusal reads as a refusal: {text}"
    );
    assert!(
        !events.iter().any(|event| {
            event["type"] == "command_execution" && event["summary"] == "Command completed"
        }),
        "and the declined command never ran: {text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn declining_and_stopping_ends_the_turn_instead_of_letting_it_argue() {
    // The rider invites a retry on purpose: a plain decline leaves the agent
    // free to ask again, and stopping is only proven by that not happening.
    let backend = Backend::start().await;
    let task = backend
        .start_task_asking_permission(
            &format!("{NEEDS_APPROVAL} If it is declined or fails, run it once more."),
            MODEL,
        )
        .await;
    let asked = task.wait_for_a_question(Duration::from_secs(120)).await;

    task.answer(&asked, "denyAndStop").await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;

    let detail = task.detail().await;
    let text = detail.to_string();
    let events = detail["events"].as_array().expect("events");
    assert!(
        !events.iter().any(|event| {
            event["type"] == "command_execution" && event["summary"] == "Command completed"
        }),
        "nothing ran after the refusal: {text}"
    );
    let questions = events
        .iter()
        .filter(|event| event["type"] == "approval_requested")
        .count();
    assert_eq!(
        questions, 1,
        "the turn was stopped before it could ask again: {text}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn the_installation_reports_itself_without_spending_anything() {
    // The Settings page's data: the binary by running it, the account and the
    // plan's usage windows in the agent's own name over `get_usage`. No model
    // is called, so this spends nothing — and what only the real thing can
    // prove is that every source actually answers.
    let backend = Backend::start().await;

    let status = backend
        .get("/api/claude/status")
        .await
        .expect("the status answers");

    assert_eq!(
        status.get("problems"),
        None,
        "every source answered: {status}"
    );
    assert!(
        status["executable"]["version"]
            .as_str()
            .unwrap_or_default()
            .contains("Claude Code"),
        "{status}"
    );
    assert_eq!(status["auth"]["loggedIn"], true, "{status}");
    assert!(status["usage"].is_object(), "{status}");
    assert_eq!(
        status["runner"]["running"], false,
        "nothing here started a runner: {status}"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
async fn a_turn_that_cannot_run_reads_as_a_failure_not_as_the_agent_talking() {
    // The API is a closed port, so no model is ever reached and this case
    // spends nothing. What only the real `claude` can prove is the frames it
    // writes for that: a `<synthetic>` assistant message marked as an API
    // error, and a result that is an error while its subtype says success —
    // crossing the runner and the backend to arrive as a failure a person can
    // read, not as the agent answering strangely.
    let backend = Backend::start_with_unreachable_api().await;
    let task = backend
        .start_task("Reply with the single word: ok.", MODEL)
        .await;
    task.wait_for(TurnState::Idle, Duration::from_secs(120))
        .await;

    let detail = task.detail().await;
    let events = detail["events"].as_array().expect("events");
    let failure = events
        .iter()
        .find(|event| event["type"] == "agent_failure")
        .unwrap_or_else(|| panic!("no failure event in {events:?}"));
    assert!(
        failure["payload"]["text"]
            .as_str()
            .unwrap_or_default()
            .starts_with("API Error"),
        "{failure}"
    );
    assert!(
        !events.iter().any(|event| {
            event["type"] == "assistant_message"
                && event["payload"]["text"]
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("API Error")
        }),
        "the harness's report must not read as the agent answering: {events:?}"
    );
    let row = backend
        .wait_for_list_row(task.thread_id(), TurnState::Idle, Duration::from_secs(30))
        .await;
    assert_eq!(row["latestTurnStatus"], "failed", "{row}");
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
