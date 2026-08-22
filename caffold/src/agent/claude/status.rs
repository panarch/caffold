//! What this Claude installation is, asked without a Task.
//!
//! Four sources, each answering for itself: the binary that would run, the
//! account it would run as, the plan's usage windows, and the runner holding
//! whatever sessions exist. The report is for showing, never for gating — a
//! source that cannot answer costs its own block and nothing more, and a tool
//! that is broken says so at the moment a turn tries it, which this report
//! does not predict.
//!
//! The usage windows come from the agent itself over `get_usage`, the same
//! answer its own `/usage` screen draws — the agent holds the credentials and
//! asks in its own name, so Caffold reads no keychain and calls no service.
//! The agent marks that answer experimental, which is why every field here is
//! read tolerantly: a shape this release cannot read costs the row it is in.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, json};

use super::{ANSWER_TIMEOUT, ClaudeClient};

/// The whole report, one block per source. A block a source could not fill is
/// absent, and why it is absent is under `problems` by the block's name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaudeStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    executable: Option<Executable>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth: Option<Auth>,
    #[serde(skip_serializing_if = "Option::is_none")]
    usage: Option<Usage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runner: Option<RunnerReport>,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    problems: BTreeMap<&'static str, String>,
}

/// The binary a session would run, as the shell would find it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Executable {
    /// Where it was found, when `which` could say.
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    /// What it answered `--version` with, whole: "2.1.239 (Claude Code)".
    version: String,
}

/// Who the agent works as, from `claude auth status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Auth {
    logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription: Option<String>,
}

/// The plan's usage windows, as the agent reports them.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription_type: Option<String>,
    windows: Vec<UsageWindow>,
}

/// One window: how much of it is used and when it lets go.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageWindow {
    /// The agent's own name for the window: "session", "weekly_all", ...
    kind: String,
    percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    resets_at: Option<String>,
    /// The model the window is scoped to, when it is one model's.
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
}

/// The runner, or the fact that none is running — which is an answer, not a
/// problem: nothing starts it but a session or a person.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerReport {
    running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sessions: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    idle_timeout_secs: Option<u64>,
}

impl ClaudeClient {
    /// What this installation is right now, every source asked at once.
    ///
    /// Every source is bounded and the report waits for the slowest one. The
    /// local probes get [`ANSWER_TIMEOUT`] apiece, and a source still silent
    /// past its bound is reported as unable, its process killed with the
    /// wait. The usage question bounds itself instead — its wait at the start
    /// door and its wait for the answer each carry the same deadline —
    /// because a cutoff from out here would kill a process that may be
    /// mid-way through refreshing the account's credentials, the very thing
    /// starts are spaced to protect.
    pub(crate) async fn introspect(&self) -> ClaudeStatus {
        #[cfg(test)]
        if self.inner.runner.is_mock() {
            return stand_in_status();
        }
        let (executable, auth, usage, runner) = tokio::join!(
            probe(executable_report()),
            probe(auth_report()),
            // Not probed twice: the one-off holds its own deadlines, door
            // and answer both, and says which question went dark.
            usage_report(self),
            // The runner is asked over its socket, where a wedged daemon
            // could otherwise hold this report open forever.
            tokio::time::timeout(ANSWER_TIMEOUT, self.inner.runner.status()),
        );
        let mut problems = BTreeMap::new();
        ClaudeStatus {
            executable: keep("executable", executable, &mut problems),
            auth: keep("auth", auth, &mut problems),
            usage: keep("usage", usage, &mut problems),
            runner: keep(
                "runner",
                runner.map(runner_report).map_err(|_| {
                    format!(
                        "the runner did not answer within {} seconds",
                        ANSWER_TIMEOUT.as_secs()
                    )
                }),
                &mut problems,
            ),
            problems,
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
    match tokio::time::timeout(ANSWER_TIMEOUT, asked).await {
        Ok(result) => result,
        Err(_) => Err(format!(
            "did not answer within {} seconds",
            ANSWER_TIMEOUT.as_secs()
        )),
    }
}

/// The binary, by running it: `--version` proves it runs, `which` says where.
async fn executable_report() -> Result<Executable, String> {
    let answered = run("claude", &["--version"]).await?;
    if !answered.status.success() {
        return Err(format!(
            "claude refused --version: {}",
            String::from_utf8_lossy(&answered.stderr).trim()
        ));
    }
    let version = String::from_utf8_lossy(&answered.stdout).trim().to_string();
    if version.is_empty() {
        return Err("claude answered --version with nothing".to_string());
    }
    let path = match run("which", &["claude"]).await {
        Ok(output) if output.status.success() => {
            let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
            (!found.is_empty()).then_some(found)
        }
        _ => None,
    };
    Ok(Executable { path, version })
}

/// The account, in the agent's own `auth status --json` words.
///
/// Read from what is already on this machine, not asked of the service —
/// measured against CLI 2.1.239: it answers in ~0.2s, no time for a
/// credential refresh's round trip — which is why it does not pass the
/// start door the authenticating starts do.
async fn auth_report() -> Result<Auth, String> {
    let output = run("claude", &["auth", "status", "--json"]).await?;
    // Parsed regardless of the exit code: logged out is a report, not an
    // error, and which exit code accompanies it is the agent's business.
    let answer: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
        format!(
            "claude auth status did not answer in JSON: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )
    })?;
    auth_of(&answer)
}

/// The plan's windows, asked of the agent the way its own screen asks.
async fn usage_report(client: &ClaudeClient) -> Result<Usage, String> {
    let answer = client
        .ask_one_off(json!({ "subtype": "get_usage" }))
        .await
        .map_err(|error| error.to_string())?;
    Ok(usage_of(&answer))
}

/// Run one command to completion, capturing what it wrote. Killed with the
/// probe that asked: a command still running when nobody is waiting anymore
/// is a process this report leaks.
async fn run(program: &str, arguments: &[&str]) -> Result<std::process::Output, String> {
    tokio::process::Command::new(program)
        .args(arguments)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|error| format!("could not run {program}: {error}"))
}

/// The auth answer, read tolerantly — except for the one load-bearing field:
/// an answer that does not say whether anyone is signed in is a shape this
/// release cannot read, not a confident "signed out".
fn auth_of(answer: &Value) -> Result<Auth, String> {
    let Some(logged_in) = answer.get("loggedIn").and_then(Value::as_bool) else {
        return Err("claude auth status answered without saying loggedIn".to_string());
    };
    let text = |key: &str| answer.get(key).and_then(Value::as_str).map(str::to_string);
    Ok(Auth {
        logged_in,
        method: text("authMethod"),
        email: text("email"),
        subscription: text("subscriptionType"),
    })
}

/// The usage answer, read tolerantly: a row this release cannot read costs
/// that row, and a shape with no rows costs only the rows.
fn usage_of(answer: &Value) -> Usage {
    let windows = answer["rate_limits"]["limits"]
        .as_array()
        .map(|rows| rows.iter().filter_map(window_of).collect())
        .unwrap_or_default();
    Usage {
        subscription_type: answer
            .get("subscription_type")
            .and_then(Value::as_str)
            .map(str::to_string),
        windows,
    }
}

fn window_of(row: &Value) -> Option<UsageWindow> {
    Some(UsageWindow {
        kind: row.get("kind")?.as_str()?.to_string(),
        percent: row.get("percent")?.as_f64()?,
        resets_at: row
            .get("resets_at")
            .and_then(Value::as_str)
            .map(str::to_string),
        model: row["scope"]["model"]["display_name"]
            .as_str()
            .map(str::to_string),
    })
}

/// The runner block, from the runner or from its absence.
fn runner_report(status: Option<caffold_claude_runner::protocol::DaemonStatus>) -> RunnerReport {
    match status {
        Some(status) => RunnerReport {
            running: true,
            pid: Some(status.pid),
            version: Some(status.runner_version),
            sessions: Some(status.sessions),
            idle_timeout_secs: status.idle_timeout_secs,
        },
        None => RunnerReport {
            running: false,
            pid: None,
            version: None,
            sessions: None,
            idle_timeout_secs: None,
        },
    }
}

/// What a mocked client reports: enough of every block for a route to answer
/// with, and nothing read from the machine the tests run on.
#[cfg(test)]
fn stand_in_status() -> ClaudeStatus {
    ClaudeStatus {
        executable: Some(Executable {
            path: Some("/stand-in/claude".to_string()),
            version: "0.0.0 (stand-in)".to_string(),
        }),
        auth: Some(Auth {
            logged_in: true,
            method: Some("stand-in".to_string()),
            email: Some("someone@example.test".to_string()),
            subscription: Some("stand-in".to_string()),
        }),
        usage: Some(Usage {
            subscription_type: Some("stand-in".to_string()),
            windows: vec![UsageWindow {
                kind: "session".to_string(),
                percent: 4.0,
                resets_at: Some("2026-08-22T12:30:00+00:00".to_string()),
                model: None,
            }],
        }),
        runner: Some(RunnerReport {
            running: true,
            pid: Some(4242),
            version: Some("stand-in".to_string()),
            sessions: Some(0),
            idle_timeout_secs: Some(600),
        }),
        problems: BTreeMap::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_auth_answer_arrives_in_caffolds_words() {
        // The answer a logged-in installation really gives.
        let answer = serde_json::json!({
            "loggedIn": true,
            "authMethod": "claude.ai",
            "apiProvider": "firstParty",
            "email": "someone@example.test",
            "orgId": "53fd9d66-381a-47f1-ab56-4f4c15d9ef26",
            "orgName": "someone's Organization",
            "subscriptionType": "max",
        });

        let auth = auth_of(&answer).expect("the answer says loggedIn");

        assert!(auth.logged_in);
        assert_eq!(auth.method.as_deref(), Some("claude.ai"));
        assert_eq!(auth.email.as_deref(), Some("someone@example.test"));
        assert_eq!(auth.subscription.as_deref(), Some("max"));
    }

    #[test]
    fn a_logged_out_answer_reads_as_logged_out_rather_than_failing() {
        let auth =
            auth_of(&serde_json::json!({ "loggedIn": false })).expect("the answer says loggedIn");

        assert!(!auth.logged_in);
        assert_eq!(auth.email, None);
    }

    #[test]
    fn an_answer_that_does_not_say_logged_in_is_a_problem_not_a_signed_out() {
        // A reshaped answer must not read as a confident "signed out" — that
        // would send someone to log in when nothing said they were out.
        let refused = auth_of(&serde_json::json!({ "signedIn": true }));

        assert!(refused.is_err(), "{refused:?}");
    }

    #[test]
    fn the_usage_answer_keeps_the_windows_and_the_plan() {
        // Trimmed from what `get_usage` really answered: the rows Caffold
        // reads, one unreadable row, and the internal fields it does not.
        let answer = serde_json::json!({
            "session": { "total_cost_usd": 0 },
            "subscription_type": "max",
            "rate_limits_available": true,
            "rate_limits": {
                "five_hour": { "utilization": 5, "resets_at": "2026-08-22T12:30:00.169722+00:00" },
                "extra_usage": { "is_enabled": false },
                "limits": [
                    {
                        "kind": "session",
                        "group": "session",
                        "percent": 5,
                        "severity": "normal",
                        "resets_at": "2026-08-22T12:30:00.169722+00:00",
                        "scope": null,
                        "is_active": false,
                    },
                    {
                        "kind": "weekly_all",
                        "group": "weekly",
                        "percent": 15,
                        "severity": "normal",
                        "resets_at": "2026-08-28T09:59:59.511440+00:00",
                        "scope": null,
                        "is_active": false,
                    },
                    {
                        "kind": "weekly_scoped",
                        "group": "weekly",
                        "percent": 24,
                        "severity": "normal",
                        "resets_at": "2026-08-28T09:59:59.511715+00:00",
                        "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
                        "is_active": true,
                    },
                    { "kind": "shapeless" },
                ],
            },
        });

        let usage = usage_of(&answer);

        assert_eq!(usage.subscription_type.as_deref(), Some("max"));
        assert_eq!(usage.windows.len(), 3, "the unreadable row costs itself");
        assert_eq!(usage.windows[0].kind, "session");
        assert_eq!(usage.windows[0].percent, 5.0);
        assert_eq!(usage.windows[1].kind, "weekly_all");
        assert_eq!(usage.windows[1].model, None);
        assert_eq!(usage.windows[2].model.as_deref(), Some("Fable"));
        assert_eq!(
            usage.windows[2].resets_at.as_deref(),
            Some("2026-08-28T09:59:59.511715+00:00")
        );
    }

    #[test]
    fn an_answer_with_no_usage_in_it_costs_the_windows_and_no_more() {
        // The agent marks this answer experimental; a reshaped one must not
        // take the report down with it.
        let usage = usage_of(&serde_json::json!({ "something": "else" }));

        assert_eq!(usage.subscription_type, None);
        assert!(usage.windows.is_empty());
    }

    #[test]
    fn a_runner_that_is_not_running_is_an_answer_rather_than_a_problem() {
        let report = runner_report(None);
        assert!(!report.running);

        let value = serde_json::to_value(&report).unwrap();
        assert_eq!(value, serde_json::json!({ "running": false }));
    }

    #[test]
    fn the_report_says_why_a_block_is_missing_in_that_blocks_name() {
        // The runner's own case is the one that earns this shape: a wedged
        // daemon is not "not running", so a timeout is a named problem while
        // a runner that is not listening stays an ordinary answer.
        let status = ClaudeStatus {
            executable: None,
            auth: None,
            usage: None,
            runner: None,
            problems: BTreeMap::from([
                ("executable", "could not run claude".to_string()),
                (
                    "runner",
                    "the runner did not answer within 30 seconds".to_string(),
                ),
            ]),
        };

        let value = serde_json::to_value(&status).unwrap();

        assert_eq!(value["problems"]["executable"], "could not run claude");
        assert_eq!(
            value["problems"]["runner"],
            "the runner did not answer within 30 seconds"
        );
        assert!(
            value.get("executable").is_none(),
            "a block nobody filled is absent, not null: {value}"
        );
        assert!(value.get("runner").is_none(), "{value}");
    }
}
