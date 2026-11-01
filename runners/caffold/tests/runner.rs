//! What the runner promises, checked against a stand-in agent.
//!
//! Every case here is about survival and delivery rather than content: a client
//! disappears and returns, a child dies, two clients contend for one session.
//! The stand-in makes those deterministic, which the real CLI could not — its
//! timing depends on a model.

mod support;

use std::time::Duration;

use serde_json::{Value, json};
use support::{Runner, Wire, fake_agent};

#[test]
fn recovery_acceptance_survives_a_lost_receipt_without_resending_input() {
    let mut runner = Runner::start();
    assert_eq!(runner.run(&["daemon", "status"])["recovery_version"], 1);
    let marker = runner.data_dir().join("received-count");
    let argv = fake_agent(&["--no-ready", "--received-file", marker.to_str().unwrap()]);
    let mut first = Wire::connect(&runner);
    first.send_request(json!({
        "m": "session_create_recoverable", "session": "s", "argv": argv,
        "cwd": runner.data_dir(), "limits": {"journal_bytes": 4096, "checkpoint_bytes": 1024}
    }));
    let raw_snapshot = first.read_raw_line().unwrap();
    let reply: Value = serde_json::from_str(&raw_snapshot).unwrap();
    assert!(
        reply.get("ok").is_some(),
        "snapshot reply precedes output: {reply}"
    );
    let snapshot = &reply["ok"]["recovery"];
    assert_eq!(snapshot["fence"], 0);
    let pid = snapshot["session"]["pid"].clone();
    assert_eq!(first.next_event()["t"], "replay_fence");
    let live = first.request(json!({
        "m": "session_replay_live", "session": "s", "checkpoint": recovery_checkpoint(snapshot, 0, "idle")
    }));
    assert!(live.get("err").is_none(), "{live}");

    first.send_request(json!({
        "m": "session_send_recovery", "session": "s", "f": {"prompt":"once"},
        "checkpoint": recovery_checkpoint(snapshot, 0, "pending request 17")
    }));
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while std::fs::read_to_string(&marker).unwrap_or_default() != "1" {
        assert!(
            std::time::Instant::now() < deadline,
            "the child must receive the input"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    // The native marker proves acceptance without reading the send receipt.
    drop(first);
    wait_until_detached(&runner, "s");
    let mut second = Wire::connect(&runner);
    let reply = second.request(json!({
        "m": "session_attach_recovery", "session": "s", "incarnation": snapshot["incarnation"]
    }));
    let restored = &reply["ok"]["recovery"];
    assert_eq!(restored["session"]["pid"], pid);
    assert_eq!(restored["checkpoint"], "pending request 17");
    assert_eq!(
        (
            restored["acknowledged"].as_u64(),
            restored["fence"].as_u64()
        ),
        (Some(0), Some(1))
    );
    assert_ne!(restored["lease"], snapshot["lease"]);
    let replayed = second.next_event();
    assert_eq!(replayed["seq"], 1);
    assert_eq!(replayed["f"]["received"], 1);
    assert_eq!(second.next_event()["t"], "replay_fence");
    let live = second.request(json!({
        "m": "session_replay_live", "session": "s", "checkpoint": recovery_checkpoint(restored, 1, "applied result 17")
    }));
    assert!(live.get("err").is_none(), "{live}");
    let sent = second.request(json!({
        "m": "session_send_recovery", "session": "s", "f": {"prompt":"a different request"},
        "checkpoint": recovery_checkpoint(restored, 1, "pending request 18")
    }));
    assert!(sent.get("err").is_none(), "{sent}");
    let next = second.next_event();
    assert_eq!(next["seq"], 2);
    assert_eq!(
        next["f"]["received"], 2,
        "the first request was never resent"
    );
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "2");
    runner.stop();
    runner.wait_until_gone();
}

#[test]
fn a_recovery_checkpoint_receipt_can_be_lost_and_replay_can_disconnect_again() {
    let mut runner = Runner::start();
    let mut first = Wire::connect(&runner);
    let reply = first.request(json!({
        "m":"session_create_recoverable", "session":"s", "argv":["/bin/cat"],
        "cwd":runner.data_dir(), "limits":{"journal_bytes":4096,"checkpoint_bytes":1024}
    }));
    let snapshot = &reply["ok"]["recovery"];
    assert_eq!(first.next_event()["t"], "replay_fence");
    assert!(first.request(json!({"m":"session_replay_live","session":"s","checkpoint":recovery_checkpoint(snapshot,0,"idle")})).get("err").is_none());
    for n in 1..=3 {
        let reply = first.request(json!({"m":"session_send_recovery","session":"s","f":{"n":n},"checkpoint":recovery_checkpoint(snapshot,0,"unacknowledged")}));
        assert!(reply.get("err").is_none(), "{reply}");
        let event = first.next_event();
        assert_eq!(event["seq"], n);
        assert_eq!(event["f"]["n"], n);
    }
    first.send_request(json!({"m":"session_checkpoint","session":"s","checkpoint":recovery_checkpoint(snapshot,1,"only one applied")}));
    // A later reply on this same ordered request lane proves the checkpoint
    // was processed, without consuming its own receipt as the authority.
    assert!(
        first
            .request(json!({"m":"daemon_status"}))
            .get("err")
            .is_none()
    );
    drop(first);
    wait_until_detached(&runner, "s");

    let mut second = Wire::connect(&runner);
    let reply = second.request(
        json!({"m":"session_attach_recovery","session":"s","incarnation":snapshot["incarnation"]}),
    );
    let replay = &reply["ok"]["recovery"];
    assert_eq!(replay["acknowledged"], 1);
    assert_eq!(replay["checkpoint"], "only one applied");
    assert_eq!(second.next_event()["seq"], 2);
    drop(second);
    wait_until_detached(&runner, "s");

    let mut third = Wire::connect(&runner);
    let reply = third.request(
        json!({"m":"session_attach_recovery","session":"s","incarnation":snapshot["incarnation"]}),
    );
    let replay = &reply["ok"]["recovery"];
    assert_eq!(
        third.next_event()["seq"],
        2,
        "unacknowledged replay is retained again"
    );
    assert_eq!(third.next_event()["seq"], 3);
    assert_eq!(third.next_event()["t"], "replay_fence");
    let stale = third.request(json!({"m":"session_checkpoint","session":"s","checkpoint":recovery_checkpoint(snapshot,3,"old lease")}));
    assert_eq!(stale["err"]["code"], "stale_subscriber");
    let future = third.request(json!({"m":"session_checkpoint","session":"s","checkpoint":recovery_checkpoint(replay,4,"future")}));
    assert_eq!(future["err"]["code"], "invalid_checkpoint");
    let live = third.request(json!({"m":"session_replay_live","session":"s","checkpoint":recovery_checkpoint(replay,3,"all applied")}));
    assert!(live.get("err").is_none(), "{live}");
    let regressed = third.request(json!({"m":"session_checkpoint","session":"s","checkpoint":recovery_checkpoint(replay,2,"older")}));
    assert_eq!(regressed["err"]["code"], "invalid_checkpoint");
    runner.stop();
    runner.wait_until_gone();
}

#[test]
fn recovery_backpressure_preserves_every_final_frame_before_exit() {
    let mut runner = Runner::start();
    let text = "x".repeat(500);
    let script = format!(
        "i=0; while [ $i -lt 40 ]; do i=$((i+1)); printf '{{\"n\":%s,\"text\":\"{text}\"}}\\n' \"$i\"; done; read -r release; exit 7"
    );
    let mut wire = Wire::connect(&runner);
    let reply = wire.request(json!({"m":"session_create_recoverable","session":"s","argv":["/bin/sh","-c",script],"cwd":runner.data_dir(),"limits":{"journal_bytes":1024,"checkpoint_bytes":1024}}));
    let snapshot = &reply["ok"]["recovery"];
    assert_eq!(
        std::fs::read_dir(runner.data_dir().join("children"))
            .unwrap()
            .count(),
        1,
        "the child stays alive until its spawn record can be observed"
    );
    let mut count = 0;
    loop {
        let event = wire.next_event();
        if event["t"] == "replay_fence" {
            let live = wire.request(json!({"m":"session_replay_live","session":"s","checkpoint":recovery_checkpoint(snapshot,count,"fence applied")}));
            assert!(live.get("err").is_none(), "{live}");
            let released = wire.request(json!({"m":"session_send_recovery","session":"s","f":{"finish":true},"checkpoint":recovery_checkpoint(snapshot,count,"release child")}));
            assert!(released.get("err").is_none(), "{released}");
            continue;
        }
        if event["t"] == "exit" {
            assert_eq!(count, 40, "all stdout drained before Exit");
            assert_eq!(event["seq"], 41);
            assert_eq!(event["code"], 7);
            break;
        }
        count += 1;
        assert_eq!(event["t"], "frame");
        assert_eq!(event["seq"], count);
        assert_eq!(event["f"]["n"], count);
        assert_eq!(event["f"]["text"], text);
        let ack = wire.request(json!({"m":"session_checkpoint","session":"s","checkpoint":recovery_checkpoint(snapshot,count,"applied")}));
        assert!(ack.get("err").is_none(), "{ack}");
    }
    assert_eq!(runner.session("s").unwrap()["state"], "exited");
    let legacy_replace = wire.request(
        json!({"m":"session_create","session":"s","argv":["/bin/cat"],"cwd":runner.data_dir()}),
    );
    assert_eq!(
        legacy_replace["err"]["code"], "recovery_state",
        "unacknowledged Exit may not be replaced"
    );
    assert!(
        wire.request(json!({"m":"session_close","session":"s"}))
            .get("err")
            .is_none()
    );
    assert_eq!(
        std::fs::read_dir(runner.data_dir().join("children"))
            .unwrap()
            .count(),
        0,
        "closing an exited journal also removes its spawn record"
    );
    runner.stop();
    runner.wait_until_gone();
}

#[test]
fn a_frame_that_cannot_fit_is_an_explicit_transport_failure() {
    let mut runner = Runner::start();
    let script = format!(
        "printf '%s\\n' '{{\"oversized\":\"{}\"}}'",
        "x".repeat(2000)
    );
    let mut wire = Wire::connect(&runner);
    let reply = wire.request(json!({"m":"session_create_recoverable","session":"s","argv":["/bin/sh","-c",script],"cwd":runner.data_dir(),"limits":{"journal_bytes":1024,"checkpoint_bytes":1024}}));
    let snapshot = &reply["ok"]["recovery"];
    let mut failure = false;
    loop {
        let event = wire.next_event();
        match event["t"].as_str().unwrap() {
            "replay_fence" => {
                let live = wire.request(json!({"m":"session_replay_live","session":"s","checkpoint":recovery_checkpoint(snapshot,event["seq"].as_u64().unwrap(),"replay applied")}));
                assert!(live.get("err").is_none(), "{live}");
            }
            "transport_error" => {
                assert!(event["line"].as_str().unwrap().contains("byte limit"));
                assert_eq!(event["seq"], 1);
                failure = true;
            }
            "exit" => {
                assert!(failure);
                assert_eq!(event["seq"], 2);
                break;
            }
            unexpected => panic!("{unexpected}: {event}"),
        }
    }
    runner.stop();
    runner.wait_until_gone();
}

#[test]
fn a_socket_read_error_releases_a_quiet_subscription() {
    let mut runner = Runner::start();
    let original = runner.create("quiet", &["/bin/cat".to_string()]);
    let mut first = Wire::connect(&runner);
    assert!(
        first
            .request(json!({"m":"session_attach","session":"quiet"}))
            .get("err")
            .is_none()
    );
    first.write_raw(&[0xff, b'\n']);
    assert_eq!(
        first.read_raw_line().unwrap(),
        "",
        "a malformed UTF-8 connection is closed"
    );
    wait_until_detached(&runner, "quiet");
    let mut next = Wire::connect(&runner);
    let attached = next.request(json!({"m":"session_attach","session":"quiet"}));
    assert_eq!(attached["ok"]["pid"], original["pid"]);
    assert!(
        next.request(json!({"m":"session_send","session":"quiet","f":{"still":"alive"}}))
            .get("err")
            .is_none()
    );
    assert_eq!(next.next_event()["f"], json!({"still":"alive"}));
    runner.stop();
    runner.wait_until_gone();
}

#[test]
fn recovery_reports_a_stdin_failure_after_enqueue_acceptance() {
    let mut runner = Runner::start();
    let mut wire = Wire::connect(&runner);
    let reply = wire.request(json!({"m":"session_create_recoverable","session":"s","argv":["/bin/sh","-c","exec 0<&-; printf '{\"stdinClosed\":true}\\n'; exec /bin/sleep 30"],"cwd":runner.data_dir(),"limits":{"journal_bytes":4096,"checkpoint_bytes":1024}}));
    let snapshot = &reply["ok"]["recovery"];
    let mut through = 0;
    let mut stdin_closed = false;
    while !stdin_closed {
        let event = wire.next_event();
        if event["t"] == "replay_fence" {
            assert!(wire.request(json!({"m":"session_replay_live","session":"s","checkpoint":recovery_checkpoint(snapshot,through,"live")})).get("err").is_none());
        } else {
            assert_eq!(event["f"]["stdinClosed"], true);
            stdin_closed = true;
            through = event["seq"].as_u64().unwrap();
        }
    }
    // If ready was inside replay, finish that replay before submitting input.
    if snapshot["fence"].as_u64().unwrap() > 0 {
        assert_eq!(wire.next_event()["t"], "replay_fence");
        assert!(wire.request(json!({"m":"session_replay_live","session":"s","checkpoint":recovery_checkpoint(snapshot,through,"live")})).get("err").is_none());
    }
    let accepted = wire.request(json!({"m":"session_send_recovery","session":"s","f":{"request":"cannot be written"},"checkpoint":recovery_checkpoint(snapshot,through,"pending")}));
    assert!(accepted.get("err").is_none(), "enqueue success: {accepted}");
    let failure = wire.next_event();
    assert_eq!(failure["t"], "transport_error");
    assert!(
        failure["line"]
            .as_str()
            .unwrap()
            .contains("after transport acceptance")
    );
    assert_eq!(failure["seq"], through + 1);
    runner.stop();
    runner.wait_until_gone();
}

#[test]
fn replacing_the_runner_discards_recovery_memory_and_has_a_new_child_incarnation() {
    let mut runner = Runner::start();
    let mut wire = Wire::connect(&runner);
    let reply = wire.request(json!({"m":"session_create_recoverable","session":"s","argv":["/bin/cat"],"cwd":runner.data_dir(),"limits":{"journal_bytes":4096,"checkpoint_bytes":1024}}));
    let snapshot = &reply["ok"]["recovery"];
    assert_eq!(wire.next_event()["t"], "replay_fence");
    assert!(wire.request(json!({"m":"session_replay_live","session":"s","checkpoint":recovery_checkpoint(snapshot,0,"memory only")})).get("err").is_none());
    runner.kill_without_cleanup();
    drop(wire);
    let mut replacement = Runner::start_in(runner.data_dir());
    assert!(replacement.sessions().is_empty());
    let mut next = Wire::connect(&replacement);
    let missing = next.request(
        json!({"m":"session_attach_recovery","session":"s","incarnation":snapshot["incarnation"]}),
    );
    assert_eq!(missing["err"]["code"], "unknown_session");
    let reply = next.request(json!({"m":"session_create_recoverable","session":"s","argv":["/bin/cat"],"cwd":replacement.data_dir(),"limits":{"journal_bytes":4096,"checkpoint_bytes":1024}}));
    let fresh = &reply["ok"]["recovery"];
    assert_ne!(fresh["incarnation"], snapshot["incarnation"]);
    assert_eq!(fresh["checkpoint"], "");
    let wrong_child = next.request(
        json!({"m":"session_attach_recovery","session":"s","incarnation":snapshot["incarnation"]}),
    );
    assert_eq!(wrong_child["err"]["code"], "wrong_incarnation");
    let stale = next.request(json!({"m":"session_checkpoint","session":"s","checkpoint":recovery_checkpoint(snapshot,0,"previous child")}));
    assert_eq!(stale["err"]["code"], "wrong_incarnation");
    replacement.stop();
    replacement.wait_until_gone();
}

#[test]
fn immediate_runner_replacement_allows_the_old_child_to_finish_eof_cleanup() {
    let mut runner = Runner::start();
    let marker = runner.data_dir().join("native-eof-cleanup");
    let mut wire = Wire::connect(&runner);
    let reply=wire.request(json!({"m":"session_create_recoverable","session":"s","argv":fake_agent(&["--no-ready","--eof-delay","0.2","--eof-marker",marker.to_str().unwrap()]),"cwd":runner.data_dir(),"limits":{"journal_bytes":4096,"checkpoint_bytes":1024}}));
    assert!(reply.get("err").is_none(), "{reply}");
    let original_pid = reply["ok"]["recovery"]["session"]["pid"].clone();
    runner.kill_without_cleanup();
    // Start immediately, while the old child is still doing EOF cleanup.
    let mut replacement = Runner::start_in(runner.data_dir());
    assert_eq!(std::fs::read_to_string(marker).unwrap(), "EOF_CLEANUP_DONE");
    assert!(replacement.sessions().is_empty());
    assert_eq!(
        std::fs::read_dir(replacement.data_dir().join("children"))
            .unwrap()
            .count(),
        0
    );
    assert!(
        std::process::Command::new("ps")
            .args([
                "-p",
                &original_pid.as_u64().unwrap().to_string(),
                "-o",
                "pid="
            ])
            .output()
            .unwrap()
            .stdout
            .is_empty()
    );
    drop(wire);
    replacement.stop();
    replacement.wait_until_gone();
}

fn recovery_checkpoint(snapshot: &Value, through: u64, state: &str) -> Value {
    json!({"incarnation":snapshot["incarnation"],"lease":snapshot["lease"],"through":through,"state":state})
}

fn wait_until_detached(runner: &Runner, session: &str) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while runner
        .session(session)
        .is_some_and(|session| session["attached"] == true)
    {
        assert!(
            std::time::Instant::now() < deadline,
            "the old subscription must be released"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

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
fn dedicated_instances_keep_their_sessions_and_child_records_separate() {
    let mut original = Runner::start();
    let first = original.create("same-session", &fake_agent(&[]));
    let dedicated_socket = original.data_dir().join("other/runner.sock");
    let mut other = Runner::start_at_socket(&dedicated_socket);
    let second = other.create("same-session", &fake_agent(&[]));

    assert_ne!(first["pid"], second["pid"]);
    assert_ne!(original.socket(), other.socket());
    assert_eq!(
        std::fs::read_dir(original.data_dir().join("children"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(
        std::fs::read_dir(other.data_dir().join("children"))
            .unwrap()
            .count(),
        1
    );

    other.kill_without_cleanup();
    let mut replacement = Runner::start_at_socket(&dedicated_socket);
    assert!(
        replacement.sessions().is_empty(),
        "only the replaced instance's child is reaped"
    );
    assert_eq!(
        std::fs::read_dir(replacement.data_dir().join("children"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(
        std::fs::read_dir(original.data_dir().join("children"))
            .unwrap()
            .count(),
        1
    );

    let mut attached = original.attach("same-session");
    attached.send(r#"{"type":"user","text":"still alive"}"#);
    assert_eq!(
        attached.next_frame()["received"],
        1,
        "the original child still executes requests"
    );
    assert_eq!(
        original.session("same-session").unwrap()["pid"],
        first["pid"]
    );
    drop(attached);

    replacement.stop();
    replacement.wait_until_gone();
    original.stop();
    original.wait_until_gone();
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
    // The caller spaces genuine starts apart, so the answer has to say which
    // this was: only the create that began the child counts as a start.
    assert_eq!(first["spawned"], true);
    assert_eq!(second["spawned"], false);
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
    assert_eq!(
        replacement["spawned"], true,
        "a replacement is a genuine start, and the answer says so"
    );
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
    let mut attached = runner.create_attached("s1", &fake_agent(&["--busy-for", "60"]));
    // What a child writes goes into a pipe the runner holds the other end of,
    // so a child that has not written yet when the runner dies is killed by
    // the write it was about to make rather than left behind by it. A frame
    // that has come out the far side is the child saying it is past that, and
    // the case here is a child that was already running.
    assert_eq!(attached.next_frame()["type"], "ready");
    attached.disconnect();
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
fn a_runner_nobody_subscribes_to_ends_itself_after_its_timeout() {
    // The runner outlives the backend on purpose, and a backend that dies
    // without ceremony leaves nothing behind to say so. Going unsubscribed for
    // the configured stretch is itself the signal — the runner takes the same
    // way out a deliberate stop takes, so nothing lingers as a zombie for a
    // client that is never coming back.
    let mut runner = Runner::start_with_args(&["--idle-timeout", "1"]);
    let socket = runner.socket();
    let status = runner.run(&["daemon", "status"]);
    assert_eq!(
        status["idle_timeout_secs"], 1,
        "the timeout is part of what the runner reports about itself: {status}"
    );

    runner.wait_until_gone();

    assert!(
        !socket.exists(),
        "it ended the way a deliberate stop ends, tidying the socket"
    );
}

#[test]
fn a_subscriber_holds_the_runner_open_past_its_timeout() {
    // The subscription is what "a backend is connected" means, so as long as
    // one is held the clock never starts. Its end starts the clock, and the
    // end that follows is the graceful one: the child is closed rather than
    // orphaned, and the book of children is emptied.
    let mut runner = Runner::start_with_args(&["--idle-timeout", "1"]);
    let mut attached = runner.create_attached("s1", &fake_agent(&["--busy-for", "60"]));
    assert_eq!(attached.next_frame()["type"], "ready");
    let child = runner.sessions()[0]["pid"].as_u64().expect("pid") as i32;

    std::thread::sleep(Duration::from_millis(2_500));
    assert_eq!(
        runner.run(&["daemon", "status"])["sessions"],
        1,
        "still serving while somebody subscribes"
    );

    attached.disconnect();
    runner.wait_until_gone();
    assert!(
        support::wait_for_process_exit(child),
        "the agent ended with the runner rather than being left behind"
    );
    let records = std::fs::read_dir(runner.data_dir().join("children"))
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(records, 0, "and nothing is left written down");
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
