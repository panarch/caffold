//! What Settings shows about keeping Codex current, and what an update a
//! person asked for did.

mod latest_release;

use std::collections::BTreeMap;

use semver::Version;
use serde::{Deserialize, Serialize};

use super::{
    daemon_settings::{self, AutomaticUpdates},
    readiness::inspect_codex_installation,
    status::CodexDaemonInfo,
    transport,
};

/// What Settings shows about keeping Codex current.
///
/// Four facts, each from its own source and each allowed to be missing, with
/// why under `problems`: the installed and running app-server, the newest
/// release on the channel Codex's own installer reads, and
/// whether Codex's updater is on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexUpdateReport {
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    running_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    automatic_updates: Option<AutomaticUpdates>,
    update: UpdateAvailability,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    problems: BTreeMap<&'static str, String>,
}

/// Whether an update now would change what runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum UpdateAvailability {
    /// A newer release or a newer installed app-server can be applied.
    Available,
    UpToDate,
    /// The newest release, or the version to compare it with, is unknown.
    Unknown,
}

/// What `codex app-server daemon update` reported, as Settings shows it.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexUpdateOutcome {
    status: CodexUpdateStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    installed_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    running_version: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum CodexUpdateStatus {
    Updated,
    NoUpdate,
    Unsupported,
}

/// Each request reads Codex's current daemon report; no readiness cache or
/// CLI version substitutes for an app-server version.
pub(super) async fn update_report() -> CodexUpdateReport {
    let (daemon, latest_version, automatic_updates) = tokio::join!(
        async {
            let installation = inspect_codex_installation()
                .await
                .map_err(|readiness| readiness.diagnostic_message)?;
            transport::daemon_versions(&installation.path)
                .await
                .map_err(|error| error.to_string())
        },
        latest_release::fetch(),
        async {
            let codex_home = daemon_settings::codex_home()?;
            daemon_settings::automatic_updates(&codex_home).await
        },
    );
    report(Observations {
        daemon,
        latest_version,
        automatic_updates,
    })
}

struct Observations {
    daemon: Result<CodexDaemonInfo, String>,
    latest_version: Result<Version, String>,
    automatic_updates: Result<AutomaticUpdates, String>,
}

fn report(observations: Observations) -> CodexUpdateReport {
    let mut problems = BTreeMap::new();
    let daemon = answered("installation", observations.daemon, &mut problems);
    let installed_version = daemon
        .as_ref()
        .and_then(CodexDaemonInfo::managed_executable)
        .and_then(|executable| executable.version);
    let running_version = daemon
        .as_ref()
        .and_then(|daemon| daemon.app_server_version.clone());
    if daemon.is_some() && installed_version.is_none() {
        problems.insert(
            "installation",
            "Codex did not report the installed app-server version.".to_string(),
        );
    }
    if daemon.is_some() && running_version.is_none() {
        problems.insert(
            "runtime",
            "Codex did not report a running app-server version.".to_string(),
        );
    }
    let latest_version = answered("latestVersion", observations.latest_version, &mut problems);
    let automatic_updates = answered("settings", observations.automatic_updates, &mut problems);
    let update = availability(
        installed_version.as_deref(),
        running_version.as_deref(),
        latest_version.as_ref(),
    );
    CodexUpdateReport {
        installed_version,
        running_version,
        latest_version: latest_version.map(|version| version.to_string()),
        automatic_updates,
        update,
        problems,
    }
}

fn answered<T>(
    source: &'static str,
    result: Result<T, String>,
    problems: &mut BTreeMap<&'static str, String>,
) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(problem) => {
            problems.insert(source, problem);
            None
        }
    }
}

/// A runtime older than the installed app-server can apply that installation,
/// whatever the newest release is. Otherwise the newest release is compared
/// with what runs, or with what is installed when nothing runs.
fn availability(
    installed: Option<&str>,
    running: Option<&str>,
    latest: Option<&Version>,
) -> UpdateAvailability {
    let installed = installed.and_then(|version| Version::parse(version).ok());
    let running = running.and_then(|version| Version::parse(version).ok());
    if let (Some(installed), Some(running)) = (&installed, &running)
        && installed > running
    {
        return UpdateAvailability::Available;
    }
    match (running.or(installed), latest) {
        (Some(current), Some(latest)) if *latest > current => UpdateAvailability::Available,
        (Some(_), Some(_)) => UpdateAvailability::UpToDate,
        _ => UpdateAvailability::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn decides_whether_an_update_would_change_what_runs() {
        let latest = |version: &str| Some(Version::parse(version).unwrap());
        for (installed, running, newest, expected) in [
            (
                Some("0.155.1"),
                Some("0.155.0"),
                latest("0.155.1"),
                UpdateAvailability::Available,
            ),
            (
                Some("0.155.1"),
                Some("0.155.0"),
                None,
                UpdateAvailability::Available,
            ),
            (
                Some("0.155.1"),
                Some("0.155.1"),
                latest("0.156.0"),
                UpdateAvailability::Available,
            ),
            (
                Some("0.155.1"),
                Some("0.155.1"),
                latest("0.155.1"),
                UpdateAvailability::UpToDate,
            ),
            (
                Some("0.156.0"),
                Some("0.156.0"),
                latest("0.155.1"),
                UpdateAvailability::UpToDate,
            ),
            (
                Some("0.155.1"),
                None,
                latest("0.156.0"),
                UpdateAvailability::Available,
            ),
            (
                Some("0.155.1"),
                None,
                latest("0.155.1"),
                UpdateAvailability::UpToDate,
            ),
            (
                Some("0.155.1"),
                Some("0.155.1"),
                None,
                UpdateAvailability::Unknown,
            ),
            (None, None, latest("0.156.0"), UpdateAvailability::Unknown),
            (
                Some("not a version"),
                None,
                latest("0.156.0"),
                UpdateAvailability::Unknown,
            ),
        ] {
            assert_eq!(
                availability(installed, running, newest.as_ref()),
                expected,
                "installed {installed:?}, running {running:?}, newest {newest:?}"
            );
        }
    }

    #[test]
    fn reports_every_fact_that_answered_in_camel_case() {
        let report = report(Observations {
            daemon: Ok(serde_json::from_value(json!({
                "status": "running", "cliVersion": "0.162.1",
                "managedCodexVersion": "0.155.1", "appServerVersion": "0.155.1"
            }))
            .unwrap()),
            latest_version: Ok(Version::parse("0.156.0").unwrap()),
            automatic_updates: Ok(AutomaticUpdates::Disabled),
        });

        assert_eq!(
            serde_json::to_value(report).unwrap(),
            json!({
                "installedVersion": "0.155.1",
                "runningVersion": "0.155.1",
                "latestVersion": "0.156.0",
                "automaticUpdates": "disabled",
                "update": "available"
            })
        );
    }

    #[test]
    fn a_source_that_could_not_answer_leaves_its_reason_and_no_value() {
        let report = report(Observations {
            daemon: Err("Codex CLI 0.150.0 is older than the minimum.".to_string()),
            latest_version: Err("The Codex release channel answered HTTP 503.".to_string()),
            automatic_updates: Err("settings.json does not hold a JSON object.".to_string()),
        });

        assert_eq!(
            serde_json::to_value(report).unwrap(),
            json!({
                "update": "unknown",
                "problems": {
                    "installation": "Codex CLI 0.150.0 is older than the minimum.",
                    "latestVersion": "The Codex release channel answered HTTP 503.",
                    "settings": "settings.json does not hold a JSON object."
                }
            })
        );
    }

    #[test]
    fn cli_difference_is_reference_information_only() {
        for cli in ["0.162.1", "0.170.0"] {
            let report = report(Observations {
                daemon: Ok(serde_json::from_value(json!({ "status": "running",
                    "cliVersion": cli, "managedCodexVersion": "0.166.0",
                    "appServerVersion": "0.166.0" }))
                .unwrap()),
                latest_version: Ok(Version::parse("0.166.0").unwrap()),
                automatic_updates: Ok(AutomaticUpdates::Disabled),
            });
            assert_eq!(report.update, UpdateAvailability::UpToDate);
            assert_eq!(report.installed_version.as_deref(), Some("0.166.0"));
        }
        assert_eq!(
            availability(
                Some("0.165.0"),
                Some("0.166.0"),
                Some(&Version::parse("0.166.0").unwrap())
            ),
            UpdateAvailability::UpToDate
        );
    }

    #[test]
    fn missing_daemon_versions_are_not_filled_from_cli() {
        let report = report(Observations {
            daemon: Ok(serde_json::from_value(
                json!({"status": "running", "cliVersion": "0.162.1"}),
            )
            .unwrap()),
            latest_version: Ok(Version::parse("0.166.0").unwrap()),
            automatic_updates: Ok(AutomaticUpdates::Disabled),
        });
        assert_eq!(report.update, UpdateAvailability::Unknown);
        assert!(report.installed_version.is_none());
        assert!(report.running_version.is_none());
        assert!(report.problems.contains_key("installation"));
        assert!(report.problems.contains_key("runtime"));
    }

    #[test]
    fn keeps_what_codex_says_an_update_did_without_its_install_path() {
        for (status, expected) in [
            ("updated", "updated"),
            ("noUpdate", "noUpdate"),
            ("unsupported", "unsupported"),
        ] {
            let outcome: CodexUpdateOutcome = serde_json::from_value(json!({
                "status": status,
                "managedCodexPath": "/Users/example/.codex/packages/standalone/current/bin/codex",
                "installedVersion": "0.156.0",
                "runningVersion": "0.156.0",
                "message": "Codex reported this outcome."
            }))
            .unwrap();

            assert_eq!(
                serde_json::to_value(outcome).unwrap(),
                json!({
                    "status": expected,
                    "installedVersion": "0.156.0",
                    "runningVersion": "0.156.0",
                    "message": "Codex reported this outcome."
                })
            );
        }
    }
}
