//! The one thing a stand-in agent cannot prove: that Claude itself still
//! honours a client which left and came back.
//!
//! The runner exists so a turn survives its client restarting. Whether that
//! actually works depends on behaviour the runner does not own — Claude holding
//! an unanswered permission request open, and handing it back with its original
//! identity when a client re-initializes. `tests/runner.rs` covers everything
//! the runner is responsible for; this covers the assumption underneath it, and
//! so belongs with the compatibility checks rather than the ordinary suite.
//!
//! It needs an authenticated Claude CLI and spends model usage, so it is opt-in:
//!
//! ```sh
//! cargo test -p caffold-claude-runner --test live -- --ignored
//! ```

mod support;

use serde_json::{Value, json};
use support::Runner;

/// The cheapest model that can still run a tool, since the assertion is about
/// the permission handshake rather than anything the model says.
const MODEL: &str = "haiku";

/// A command that needs approval. An obviously harmless one does not: a
/// classifier lets it through, and the test would then be waiting for a prompt
/// that never comes.
const NEEDS_APPROVAL: &str = "rm -rf /tmp/caffold-runner-live-does-not-exist";

fn claude_argv() -> Vec<String> {
    [
        "claude",
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        // Without this the CLI never asks a client for permission, and the
        // scenario cannot arise. It is absent from `claude --help`.
        "--permission-prompt-tool",
        "stdio",
        // Ask every time, and ignore whatever the developer running the test
        // happens to have allowed in their own settings.
        "--permission-mode",
        "manual",
        "--setting-sources",
        "",
        "--model",
        MODEL,
    ]
    .iter()
    .map(|argument| argument.to_string())
    .collect()
}

fn initialize(id: &str) -> String {
    json!({"type": "control_request", "request_id": id, "request": {"subtype": "initialize"}})
        .to_string()
}

fn is_permission_request(frame: &Value) -> bool {
    frame["type"] == "control_request" && frame["request"]["subtype"] == "can_use_tool"
}

#[test]
#[ignore = "requires an authenticated Claude CLI and spends model usage"]
fn a_permission_request_survives_the_client_that_received_it() {
    let runner = Runner::start();
    let mut client = runner.create_attached("live", &claude_argv());
    client.send(&initialize("init-1"));
    client.send(
        &json!({
            "type": "user",
            "message": {"role": "user", "content": [{
                "type": "text",
                "text": format!("Use the Bash tool to run exactly: {NEEDS_APPROVAL}. Just run it."),
            }]},
            "parent_tool_use_id": Value::Null,
        })
        .to_string(),
    );

    let asked = client.next_frame_where(is_permission_request);
    let request_id = asked["request_id"]
        .as_str()
        .expect("a permission request carries an identifier")
        .to_string();

    // Leave without answering, the way a backend restarting mid-approval would.
    client.disconnect();

    let mut resumed = runner.attach("live");
    resumed.send(&initialize("init-2"));
    let reinitialized = resumed.next_frame_where(|frame| {
        frame["type"] == "control_response" && frame["response"]["request_id"] == "init-2"
    });

    let pending = reinitialized["response"]["pending_permission_requests"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let ids: Vec<&str> = pending
        .iter()
        .filter_map(|request| request["request_id"].as_str())
        .collect();
    assert!(
        ids.contains(&request_id.as_str()),
        "the outstanding permission should come back with the identity it was \
         given, so the new client can answer the request the old one received; \
         got {ids:?}",
    );

    // Answering with that identity has to still work, or knowing about the
    // request would not be worth anything.
    resumed.send(
        &json!({
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": request_id,
                "response": {"behavior": "deny", "message": "declined by the live test"},
            },
        })
        .to_string(),
    );

    let result = resumed.next_frame_where(|frame| frame["type"] == "result");
    assert_eq!(
        result["is_error"], false,
        "the turn should finish once the permission is answered: {result}"
    );

    runner.run_raw(&["session", "close", "--session", "live"]);
}
