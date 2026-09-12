//! What this Grok installation is, asked without a Task.
//!
//! Four sources, each answering for itself: the executable that would run,
//! the leader that owns sessions, Caffold's own bridge to it, and the account
//! the leader is signed in as. The report is for showing, never for gating —
//! a source that cannot answer costs its own block and nothing more.
//!
//! Nothing here starts a leader. A leader that is not running is an answer,
//! and only a leader already listening is attached to — with Caffold's own
//! bridge, which is Caffold's process — so that the account can be asked
//! about. What is asked never makes a session or a turn.

use std::{
    collections::BTreeMap,
    path::Path,
    process::{Output, Stdio},
};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::time::timeout;

use super::{
    GrokClient,
    transport::{ANSWER_TIMEOUT, SocketState, socket_state},
};

/// The whole report, one block per source. A block a source could not fill is
/// absent, and why it is absent is under `problems` by the block's name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrokStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    executable: Option<Executable>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leader: Option<LeaderReport>,
    connection: Connection,
    auth: Auth,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    problems: BTreeMap<&'static str, String>,
}

/// The executable, by running it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Executable {
    path: String,
    /// What it answered `--version` with, whole: "grok 1.0.30 (04b7ffed98c6) [stable]".
    version: String,
}

/// The leader on Caffold's socket, or the fact that none is running — which
/// is an answer, not a problem: the first Grok Task starts it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeaderReport {
    socket_path: String,
    running: bool,
    /// A socket file nobody answers on: what a leader that died leaves
    /// behind, replaced the next time Caffold connects.
    socket_stale: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u64>,
    /// The running leader's own build, which an update can leave behind the
    /// installed executable until the leader is replaced.
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protocol_version: Option<u64>,
}

/// Caffold's own bridge to the leader.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    /// The connection graph's node: down, starting, ready, reconnecting, stopping.
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_version: Option<String>,
    auth_methods: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    default_auth_method: Option<String>,
}

/// The account: the cached sign-in on disk, which is what a leader starts
/// from, and what a running leader confirms about it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Auth {
    cached_sign_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<Verified>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Verified {
    authenticated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription_tier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
}

impl GrokClient {
    /// What this installation is right now, every source asked at once and
    /// each bounded by [`ANSWER_TIMEOUT`].
    pub(crate) async fn introspect(&self) -> GrokStatus {
        #[cfg(test)]
        let Some((executable, socket)) = self.inner.transport.launcher_paths() else {
            return stand_in_status();
        };
        #[cfg(not(test))]
        let (executable, socket) = self
            .inner
            .transport
            .launcher_paths()
            .expect("a real launcher has paths");
        let mut problems = BTreeMap::new();
        let (executable_report, leader_report) = tokio::join!(
            probe(executable_report(executable)),
            probe(leader_report(executable, socket)),
        );
        let leader_running = leader_report.as_ref().is_ok_and(|leader| leader.running);
        let connection = self.connection_report(leader_running, &mut problems).await;
        let auth = self
            .auth_report(socket, connection.state == "ready", &mut problems)
            .await;
        GrokStatus {
            executable: keep("executable", executable_report, &mut problems),
            leader: keep("leader", leader_report, &mut problems),
            connection,
            auth,
            problems,
        }
    }

    /// The bridge as it stands. A leader already listening is attached to
    /// when nothing is connected yet; a leader that is not running is left
    /// alone.
    async fn connection_report(
        &self,
        leader_running: bool,
        problems: &mut BTreeMap<&'static str, String>,
    ) -> Connection {
        let transport = &self.inner.transport;
        if leader_running && transport.node_name().await != "ready" {
            match timeout(ANSWER_TIMEOUT, transport.bridge()).await {
                Ok(Ok(_)) => {}
                Ok(Err(error)) => {
                    problems.insert(
                        "connection",
                        format!("Caffold could not attach to the running leader: {error}"),
                    );
                }
                Err(_) => {
                    problems.insert(
                        "connection",
                        format!(
                            "the leader did not answer Caffold's bridge within {} seconds",
                            ANSWER_TIMEOUT.as_secs()
                        ),
                    );
                }
            }
        }
        let state = transport.node_name().await;
        let bridge = match state {
            "ready" => transport.bridge().await.ok(),
            _ => None,
        };
        let hello = bridge.as_ref().map(|bridge| bridge.hello());
        Connection {
            state,
            generation: bridge.as_ref().map(|bridge| bridge.generation),
            agent_version: hello.and_then(|hello| hello.meta.agent_version.clone()),
            auth_methods: hello
                .map(|hello| {
                    hello
                        .auth_methods
                        .iter()
                        .map(|method| method.name.clone().unwrap_or_else(|| method.id.clone()))
                        .collect()
                })
                .unwrap_or_default(),
            default_auth_method: hello.and_then(|hello| hello.meta.default_auth_method_id.clone()),
        }
    }

    /// The sign-in on disk, and the leader's word on it when connected.
    async fn auth_report(
        &self,
        socket: &Path,
        connected: bool,
        problems: &mut BTreeMap<&'static str, String>,
    ) -> Auth {
        let cached_sign_in = socket
            .parent()
            .map(|home| home.join("auth.json").is_file())
            .unwrap_or(false);
        if !connected {
            return Auth {
                cached_sign_in,
                verified: None,
            };
        }
        let answer = self
            .inner
            .transport
            .call("_x.ai/auth/check_subscription", json!({}))
            .await;
        let verified = match answer
            .map_err(|error| error.to_string())
            .and_then(|answer| verified_of(&answer))
        {
            Ok(verified) => Some(verified),
            Err(problem) => {
                problems.insert("auth", problem);
                None
            }
        };
        Auth {
            cached_sign_in,
            verified,
        }
    }
}

/// The block when the source answered, or its name under `problems`.
fn keep<T>(
    name: &'static str,
    result: Result<T, String>,
    problems: &mut BTreeMap<&'static str, String>,
) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(problem) => {
            problems.insert(name, problem);
            None
        }
    }
}

/// One probe, allowed [`ANSWER_TIMEOUT`] and reported as unable past it.
async fn probe<T>(asked: impl Future<Output = Result<T, String>>) -> Result<T, String> {
    match timeout(ANSWER_TIMEOUT, asked).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "did not answer within {} seconds",
            ANSWER_TIMEOUT.as_secs()
        )),
    }
}

/// The executable, by running it: `--version` proves it runs.
async fn executable_report(executable: &Path) -> Result<Executable, String> {
    if !executable.is_file() {
        return Err(
            "grok was not found on PATH, in ~/.grok/bin or in ~/.local/bin. Install the Grok CLI to use Grok."
                .to_string(),
        );
    }
    let answered = run(executable, &["--version"]).await?;
    if !answered.status.success() {
        return Err(format!(
            "grok refused --version: {}",
            String::from_utf8_lossy(&answered.stderr).trim()
        ));
    }
    let version = String::from_utf8_lossy(&answered.stdout).trim().to_string();
    if version.is_empty() {
        return Err("grok answered --version with nothing".to_string());
    }
    Ok(Executable {
        path: executable.display().to_string(),
        version,
    })
}

/// The leader on Caffold's socket: whether anything listens there, and what
/// it says about itself when asked through the CLI.
async fn leader_report(executable: &Path, socket: &Path) -> Result<LeaderReport, String> {
    let socket_path = socket.display().to_string();
    let not_running = |socket_stale| LeaderReport {
        socket_path: socket_path.clone(),
        running: false,
        socket_stale,
        pid: None,
        version: None,
        protocol_version: None,
    };
    match socket_state(socket).await {
        SocketState::Missing => return Ok(not_running(false)),
        SocketState::Refused => return Ok(not_running(true)),
        SocketState::Listening => {}
    }
    let described = run(
        executable,
        &["leader", "info", "--leader-socket", &socket_path],
    )
    .await?;
    if !described.status.success() {
        return Err(format!(
            "a leader answers on {socket_path} but did not describe itself: {}",
            String::from_utf8_lossy(&described.stderr).trim()
        ));
    }
    let text = String::from_utf8_lossy(&described.stdout);
    Ok(LeaderReport {
        socket_path,
        running: true,
        socket_stale: false,
        pid: debug_field(&text, "pid").and_then(|value| value.parse().ok()),
        version: debug_field(&text, "leader_binary_version").map(str::to_string),
        protocol_version: debug_field(&text, "leader_protocol_version")
            .and_then(|value| value.parse().ok()),
    })
}

/// One field of the CLI's `LeaderInfo { key: value, ... }` text, unquoted.
fn debug_field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let start = text.find(&format!("{key}: "))? + key.len() + 2;
    let rest = &text[start..];
    let end = rest.find([',', '\n']).unwrap_or(rest.len());
    Some(rest[..end].trim().trim_matches('"'))
}

/// Run one command to completion, capturing what it wrote. Killed with the
/// probe that asked.
async fn run(program: &Path, arguments: &[&str]) -> Result<Output, String> {
    tokio::process::Command::new(program)
        .args(arguments)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("could not run {}: {error}", program.display()))
}

/// The leader's account answer, read tolerantly — except for the one
/// load-bearing field: an answer that does not say whether anyone is signed
/// in is a shape this release cannot read, not a confident "signed out".
fn verified_of(answer: &Value) -> Result<Verified, String> {
    let Some(authenticated) = answer.get("authenticated").and_then(Value::as_bool) else {
        return Err("Grok answered check_subscription without saying authenticated".to_string());
    };
    let meta = &answer["meta"];
    let text = |key: &str| meta.get(key).and_then(Value::as_str).map(str::to_string);
    Ok(Verified {
        authenticated,
        mode: text("auth_mode"),
        subscription_tier: text("subscription_tier"),
        email: text("email"),
    })
}

/// What a mocked client reports: enough of every block for a route to answer
/// with, and nothing read from the machine the tests run on.
#[cfg(test)]
fn stand_in_status() -> GrokStatus {
    GrokStatus {
        executable: Some(Executable {
            path: "/stand-in/grok".to_string(),
            version: "grok 0.0.0 (stand-in) [stable]".to_string(),
        }),
        leader: Some(LeaderReport {
            socket_path: "/stand-in/.grok/leader-caffold.sock".to_string(),
            running: true,
            socket_stale: false,
            pid: Some(4242),
            version: Some("0.0.0".to_string()),
            protocol_version: Some(1),
        }),
        connection: Connection {
            state: "ready",
            generation: Some(1),
            agent_version: Some("0.0.0".to_string()),
            auth_methods: vec!["cached_token".to_string(), "Grok".to_string()],
            default_auth_method: Some("cached_token".to_string()),
        },
        auth: Auth {
            cached_sign_in: true,
            verified: Some(Verified {
                authenticated: true,
                mode: Some("Oidc".to_string()),
                subscription_tier: Some("SuperGrok".to_string()),
                email: None,
            }),
        },
        problems: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::net::UnixListener;

    use super::*;

    const LEADER_INFO: &str = "LeaderInfo {\n    pid: 36832,\n    socket_path: \"/Users/example/.grok/leader-caffold.sock\",\n    lock_path: \"/Users/example/.grok/leader-caffold.lock\",\n    ws_url_suffix: \"\",\n    leader_protocol_version: 1,\n    leader_binary_version: \"1.0.30\",\n    profiling_supported: true,\n}\n";

    #[test]
    fn the_leaders_debug_text_gives_up_its_fields() {
        assert_eq!(debug_field(LEADER_INFO, "pid"), Some("36832"));
        assert_eq!(
            debug_field(LEADER_INFO, "leader_binary_version"),
            Some("1.0.30")
        );
        assert_eq!(
            debug_field(LEADER_INFO, "leader_protocol_version"),
            Some("1")
        );
        assert_eq!(debug_field(LEADER_INFO, "ws_url_suffix"), Some(""));
        assert_eq!(debug_field(LEADER_INFO, "absent"), None);
    }

    #[test]
    fn the_account_answer_needs_only_to_say_whether_anyone_is_signed_in() {
        let verified = verified_of(&json!({
            "authenticated": true,
            "meta": { "email": "someone@example.com", "auth_mode": "Oidc", "subscription_tier": "SuperGrok", "team_id": "t" }
        }))
        .unwrap();
        assert!(verified.authenticated);
        assert_eq!(verified.mode.as_deref(), Some("Oidc"));
        assert_eq!(verified.subscription_tier.as_deref(), Some("SuperGrok"));
        assert_eq!(verified.email.as_deref(), Some("someone@example.com"));
        let signed_out = verified_of(&json!({ "authenticated": false })).unwrap();
        assert!(!signed_out.authenticated);
        assert!(signed_out.mode.is_none());
        assert!(verified_of(&json!({ "meta": {} })).is_err());
    }

    #[tokio::test]
    async fn a_missing_executable_is_named_with_where_it_was_looked_for() {
        let dir = tempfile::tempdir().unwrap();
        let problem = executable_report(&dir.path().join("grok"))
            .await
            .unwrap_err();
        assert!(problem.contains("not found"), "{problem}");
        assert!(problem.contains("Install the Grok CLI"), "{problem}");
    }

    #[tokio::test]
    async fn a_leader_that_is_not_running_is_an_answer_and_a_dead_socket_is_named_stale() {
        let dir = tempfile::tempdir().unwrap();
        let socket = dir.path().join("leader-caffold.sock");
        let absent = leader_report(&dir.path().join("grok"), &socket)
            .await
            .unwrap();
        assert!(!absent.running);
        assert!(!absent.socket_stale);
        assert_eq!(absent.socket_path, socket.display().to_string());

        // A socket file nobody listens on.
        let listener = UnixListener::bind(&socket).unwrap();
        drop(listener);
        let stale = leader_report(&dir.path().join("grok"), &socket)
            .await
            .unwrap();
        assert!(!stale.running);
        assert!(stale.socket_stale);
    }
}
