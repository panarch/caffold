//! What the runner promises, checked against a stand-in agent.
//!
//! Every case here is about survival and delivery rather than content: a client
//! disappears and returns, a child dies, two clients contend for one session.
//! The stand-in makes those deterministic, which the real CLI could not — its
//! timing depends on a model.

mod support;

use serde_json::{Value, json};
use support::{Runner, Wire, fake_agent};

#[test]
fn the_runner_reports_itself_before_any_session_exists() {
    let runner = Runner::start();

    let status = runner.run(&["daemon", "status"]);

    assert_eq!(status["protocol_version"], 1);
    assert_eq!(status["sessions"], 0);
    assert!(
        status["pid"].as_u64().is_some_and(|pid| pid > 0),
        "status should identify the process serving it: {status}"
    );
}

#[test]
fn asking_for_a_live_session_again_returns_the_same_one() {
    // The backend cannot always tell whether a session survived its own
    // restart, so asking twice has to be safe. If the second call started a
    // second child, two processes would be appending to one conversation.
    let runner = Runner::start();

    let first = runner.create("s1", &fake_agent(&[]));
    let second = runner.create("s1", &fake_agent(&[]));

    assert_eq!(first["pid"], second["pid"]);
    assert_eq!(runner.sessions().len(), 1);
}

#[test]
fn an_attached_client_receives_what_the_child_writes() {
    let runner = Runner::start();

    let mut attached = runner.create_attached("s1", &fake_agent(&[]));
    let frame = attached.next_frame();

    assert_eq!(frame["type"], "ready");
}

#[test]
fn a_frame_reaches_the_child_and_its_reply_comes_back() {
    let runner = Runner::start();
    let mut attached = runner.create_attached("s1", &fake_agent(&[]));
    assert_eq!(attached.next_frame()["type"], "ready");

    attached.send(r#"{"type":"user","text":"hello"}"#);

    assert_eq!(attached.next_frame()["received"], 1);
}

#[test]
fn a_frame_crosses_the_runner_unchanged() {
    // The runner carries frames it does not understand, so it must not
    // normalize them on the way through. Key order and number formatting
    // belong to whoever produced the frame.
    let runner = Runner::start();
    let mut attached = runner.create_attached("s1", &fake_agent(&[]));

    let raw = attached.next_raw_frame();

    assert_eq!(raw, r#"{"type":"ready"}"#);
}

#[test]
fn one_subscriber_carries_every_sessions_stream() {
    // The backend is one client, and its subscription is one connection: every
    // session it attaches sends its output down that same connection, told
    // apart by the session each event names. A connection per session would
    // make the wire's own session tags dead weight — and would leave the
    // runner with no one thing that is "the backend" for lifecycle to speak
    // about.
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&[]));
    runner.create("s2", &fake_agent(&[]));

    let mut wire = Wire::connect(&runner);
    wire.request(json!({ "m": "session_attach", "session": "s1" }));
    wire.request(json!({ "m": "session_attach", "session": "s2" }));

    wire.request(json!({
        "m": "session_send", "session": "s1",
        "f": { "type": "user", "text": "to the first" },
    }));
    wire.request(json!({
        "m": "session_send", "session": "s2",
        "f": { "type": "user", "text": "to the second" },
    }));

    // Both sessions answer down the one connection, each event naming its
    // session. (The ready frames may arrive first; what matters is that both
    // replies arrive here at all.)
    let mut answered = std::collections::HashSet::new();
    while answered.len() < 2 {
        let event = wire.next_event();
        if event["f"]["received"] == 1 {
            answered.insert(event["s"].as_str().expect("a tagged event").to_string());
        }
    }
    assert!(
        answered.contains("s1") && answered.contains("s2"),
        "{answered:?}"
    );
}

#[test]
fn a_subscription_held_by_one_connection_refuses_another() {
    // One backend. A second connection trying to subscribe while the first
    // holds it would split the conversation between two readers, so it is
    // refused — per client now, not per session: the subscription is the
    // relationship lifecycle rules speak about.
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&[]));
    runner.create("s2", &fake_agent(&[]));
    let mut first = Wire::connect(&runner);
    first.request(json!({ "m": "session_attach", "session": "s1" }));

    let mut second = Wire::connect(&runner);
    let refused = second.request(json!({ "m": "session_attach", "session": "s2" }));

    assert_eq!(
        refused["err"]["code"], "already_attached",
        "a different session makes no difference — the subscription is taken: {refused}"
    );
}

#[test]
fn a_second_client_is_refused_rather_than_splitting_the_stream() {
    // Two attached clients would each see part of one conversation, which is
    // worse than one of them being told to wait.
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&[]));
    let _first = runner.attach("s1");

    let refused = runner.attach_failing("s1");

    assert!(refused.contains("already_attached"), "{refused}");
}

#[test]
fn a_client_that_leaves_frees_the_session_for_the_next_one() {
    // This is the restart the runner exists for: the client disappears, the
    // child keeps running, and a replacement client picks the session up.
    let runner = Runner::start();
    let mut first = runner.create_attached("s1", &fake_agent(&[]));
    assert_eq!(first.next_frame()["type"], "ready");
    first.disconnect();

    let mut second = runner.attach("s1");
    second.send(r#"{"type":"user","text":"still here?"}"#);

    assert_eq!(second.next_frame()["received"], 1);
}

#[test]
fn the_child_survives_the_client_that_started_it() {
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&[]));
    let pid = runner.sessions()[0]["pid"].as_u64().expect("pid");

    runner.attach("s1").disconnect();

    assert_eq!(
        runner.sessions()[0]["pid"].as_u64(),
        Some(pid),
        "the child should be the same process after the client left"
    );
}

#[test]
fn output_produced_while_nobody_is_attached_is_not_kept() {
    // Stated as a promise rather than a gap: the runner holds no history, so a
    // client that missed output recovers it from the agent. A test that
    // expected replay here would be encoding a feature that was deliberately
    // left out.
    let runner = Runner::start();
    let mut first = runner.create_attached("s1", &fake_agent(&[]));
    assert_eq!(first.next_frame()["type"], "ready");
    first.disconnect();

    let mut second = runner.attach("s1");
    second.send(r#"{"type":"user","text":"anything"}"#);

    // The first frame after reattaching is the new reply, not a replay of the
    // ready frame the earlier client already consumed.
    assert_eq!(second.next_frame()["received"], 1);
}

#[test]
fn a_child_that_exits_is_reported_and_stays_listed() {
    // The session has to remain visible in its exited state. If it vanished,
    // a client returning after the exit could not tell an ended session from
    // one that never existed.
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&["--exit-code", "3"]));

    let session = runner.wait_for_exit("s1");

    assert_eq!(session["state"], "exited");
    assert_eq!(session["exit_code"], 3);
}

#[test]
fn an_attached_client_is_told_when_the_child_exits() {
    let runner = Runner::start();
    let mut attached = runner.create_attached("s1", &fake_agent(&["--exit-code", "0"]));

    let exit = attached.next_event_of_type("exit");

    assert_eq!(exit["code"], 0);
}

#[test]
fn asking_for_an_exited_session_starts_a_replacement() {
    // Recovery is the client asking again with arguments that resume the
    // conversation. The runner does not restart children on its own, because
    // whether resuming is wanted is not something it can know.
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&["--exit-code", "1"]));
    runner.wait_for_exit("s1");

    let replacement = runner.create("s1", &fake_agent(&[]));

    assert_eq!(replacement["state"], "running");
    assert_eq!(runner.sessions().len(), 1);
}

#[test]
fn what_the_child_writes_to_stderr_reaches_the_client_as_diagnostic_output() {
    let runner = Runner::start();
    let mut attached = runner.create_attached("s1", &fake_agent(&["--stderr", "a warning"]));

    let diagnostic = attached.next_event_of_type("stderr");

    assert_eq!(diagnostic["line"], "a warning");
}

#[test]
fn closing_a_session_removes_it() {
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&[]));

    runner.run_raw(&["session", "close", "--session", "s1"]);

    assert!(runner.sessions().is_empty());
}

#[test]
fn closing_a_session_that_was_never_started_is_what_was_asked_for() {
    // A client asks for a session not to be running. One it never opened - or
    // one an earlier run of itself opened and closed - is not running, and a
    // client cannot tell those apart from where it stands.
    let runner = Runner::start();

    runner.run_raw(&["session", "close", "--session", "never-started"]);

    assert!(runner.sessions().is_empty());
}

#[test]
fn sending_without_attaching_is_refused() {
    // Sending is only meaningful from the client that is reading the replies.
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&[]));

    let refused =
        runner.send_line(r#"{"id":1,"m":"session_send","session":"s1","f":{"type":"user"}}"#);

    assert!(refused.contains("not_attached"), "{refused}");
}

#[test]
fn a_request_for_an_unknown_session_names_the_reason() {
    let runner = Runner::start();

    let refused = runner.attach_failing("missing");

    assert!(refused.contains("unknown_session"), "{refused}");
}

#[test]
fn a_second_runner_on_one_data_directory_refuses_to_start() {
    // Two runners sharing a data directory would split sessions between them,
    // and a client would reach whichever bound the socket last.
    let runner = Runner::start();

    let second = runner.run_failing(&["daemon", "run"]);

    assert!(
        second.contains("already listening"),
        "a second runner should refuse: {second}"
    );
}

#[test]
fn a_socket_left_by_a_crashed_runner_does_not_block_the_next_one() {
    // A file on disk is not evidence of a live process. Treating it as one
    // would leave the user unable to start a runner again after a crash.
    let mut runner = Runner::start();
    let socket = runner.socket();
    runner.kill_without_cleanup();
    assert!(socket.exists(), "the socket file should still be there");

    let replacement = Runner::start_in(runner.data_dir());

    assert_eq!(replacement.run(&["daemon", "status"])["sessions"], 0);
}

#[test]
fn a_child_left_by_a_crashed_runner_is_ended_by_the_next_one() {
    // The runner holds that a child does not outlive the runner supervising it,
    // and shutting down acts on it. A runner killed outright runs no code, so
    // its children go on with the pipes to them gone: unreachable, and still
    // writing to a conversation the next client will be told has no session —
    // which is how a second agent ends up on it. The rule is kept at the end
    // where there is always a process to keep it.
    let mut runner = Runner::start();
    // Busy rather than waiting to be spoken to: a process reading stdin ends
    // when the pipe to it closes, and an agent in the middle of a turn does not.
    runner.create("s1", &fake_agent(&["--busy-for", "60"]));
    let orphan = runner.sessions()[0]["pid"].as_u64().expect("pid") as i32;
    runner.kill_without_cleanup();
    assert!(
        support::is_running(orphan),
        "the child outlives a runner that was killed outright"
    );

    let replacement = Runner::start_in(runner.data_dir());

    assert!(
        support::wait_for_process_exit(orphan),
        "the runner that started ended what the last one left"
    );
    assert_eq!(replacement.sessions().len(), 0, "and claims none of them");
}

#[test]
fn closing_a_session_forgets_the_child_it_ended() {
    // The record under `children/` exists so the next runner can end what a
    // crashed one left. A child this runner ended itself is nobody's to end
    // again, and a record that outlived it would sit in the book until the
    // next start for no reason.
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&[]));
    let pid = runner.sessions()[0]["pid"].as_u64().expect("pid");
    let record = runner.data_dir().join("children").join(pid.to_string());
    assert!(record.exists(), "a started child is written down");

    runner.run_raw(&["session", "close", "--session", "s1"]);

    assert!(
        !record.exists(),
        "a child this runner ended is no longer written down"
    );
}

#[test]
fn stopping_the_runner_ends_the_sessions_it_held() {
    let runner = Runner::start();
    runner.create("s1", &fake_agent(&[]));
    let pid = runner.sessions()[0]["pid"].as_u64().expect("pid") as i32;

    runner.stop();

    assert!(
        support::wait_for_process_exit(pid),
        "the child should not outlive the runner that supervised it"
    );
}

#[test]
fn a_malformed_request_is_answered_rather_than_dropped() {
    // A client waiting on a reply it will never get is worse than an error.
    let runner = Runner::start();

    let reply = runner.send_line(r#"{"id":7,"m":"nonsense"}"#);

    let parsed: Value = serde_json::from_str(&reply).expect("a reply");
    assert_eq!(parsed["id"], 7);
    assert!(reply.contains("bad_request"), "{reply}");
}
