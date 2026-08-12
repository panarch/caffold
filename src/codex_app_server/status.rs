use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{
    CodexThreadError,
    protocol::{AccountReadResponse, CodexAccount, CodexAppServerInfo},
    readiness::{
        CodexExecutableInfo, CodexInstallation, CodexReadiness, CodexReadinessReason,
        CodexReadinessState, MINIMUM_SUPPORTED_CODEX_CLI_VERSION, codex_version_from_user_agent,
        version_meets_minimum,
    },
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusResponse {
    pub readiness: CodexReadiness,
    pub account: Option<CodexAccount>,
    pub rate_limits: Option<Value>,
    pub usage: Option<Value>,
    pub app_server: Option<CodexAppServerInfo>,
    pub daemon: Option<CodexDaemonInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexDaemonInfo {
    pub status: String,
    pub backend: Option<String>,
    pub pid: Option<u32>,
    pub managed_codex_path: Option<String>,
    pub managed_codex_version: Option<String>,
    pub socket_path: Option<String>,
    pub cli_version: Option<String>,
    pub app_server_version: Option<String>,
}

pub(super) fn status_from_results(
    installation: &CodexInstallation,
    app_server: Option<CodexAppServerInfo>,
    daemon: Option<CodexDaemonInfo>,
    account_result: Result<AccountReadResponse, CodexThreadError>,
    rate_limits: Option<Value>,
    usage: Option<Value>,
) -> CodexStatusResponse {
    let runtime_facts = readiness_runtime_facts(installation, app_server.as_ref(), daemon.as_ref());
    if let Some(running) = runtime_facts
        .running_app_server_version
        .as_deref()
        .filter(|version| !version_meets_minimum(version))
    {
        let installed = runtime_facts
            .managed_executable
            .as_ref()
            .and_then(|value| value.version.as_deref())
            .or(installation.executable.version.as_deref())
            .unwrap_or("unknown");
        return CodexStatusResponse {
            readiness: readiness_with_runtime(
                runtime_facts.clone(),
                CodexReadinessState::RestartRequired,
                true,
                CodexReadinessReason::RuntimeVersionMismatch,
                format!(
                    "Codex {installed} is installed while app-server runtime {running} is below the minimum supported version {MINIMUM_SUPPORTED_CODEX_CLI_VERSION}."
                ),
            ),
            account: None,
            rate_limits: rate_limits.as_ref().map(compact_rate_limits),
            usage: usage.as_ref().map(compact_usage),
            app_server,
            daemon,
        };
    }
    let account_result = match account_result {
        Ok(account_result) => account_result,
        Err(error) => {
            return CodexStatusResponse {
                readiness: readiness_with_runtime(
                    runtime_facts,
                    CodexReadinessState::Error,
                    true,
                    CodexReadinessReason::AccountReadFailed,
                    error.to_string(),
                ),
                account: None,
                rate_limits: rate_limits.as_ref().map(compact_rate_limits),
                usage: usage.as_ref().map(compact_usage),
                app_server,
                daemon,
            };
        }
    };
    let AccountReadResponse {
        account,
        requires_openai_auth,
    } = account_result;

    let Some(account) = account else {
        let (state, reason_code, message) = if requires_openai_auth {
            (
                CodexReadinessState::SignInRequired,
                CodexReadinessReason::AuthenticationRequired,
                "Codex is ready to connect, but authentication is required.",
            )
        } else {
            (
                CodexReadinessState::Error,
                CodexReadinessReason::AccountResponseIncomplete,
                "Codex app-server returned an incomplete account response.",
            )
        };

        return CodexStatusResponse {
            readiness: readiness_with_runtime(runtime_facts, state, true, reason_code, message),
            account: None,
            rate_limits: rate_limits.as_ref().map(compact_rate_limits),
            usage: usage.as_ref().map(compact_usage),
            app_server,
            daemon,
        };
    };

    let readiness = if runtime_facts.versions_differ {
        let blocks_task_operations = !runtime_facts
            .running_app_server_version
            .as_deref()
            .is_some_and(version_meets_minimum);
        let installed = runtime_facts
            .managed_executable
            .as_ref()
            .and_then(|value| value.version.as_deref())
            .or(installation.executable.version.as_deref())
            .unwrap_or("unknown")
            .to_string();
        let running = runtime_facts
            .running_app_server_version
            .as_deref()
            .unwrap_or("unknown")
            .to_string();
        readiness_with_runtime(
            runtime_facts,
            CodexReadinessState::RestartRequired,
            blocks_task_operations,
            CodexReadinessReason::RuntimeVersionMismatch,
            format!(
                "Codex {installed} is installed while app-server runtime {running} is running."
            ),
        )
    } else {
        readiness_with_runtime(
            runtime_facts,
            CodexReadinessState::Ready,
            false,
            CodexReadinessReason::Ready,
            "Codex is ready for Task operations.",
        )
    };

    CodexStatusResponse {
        readiness,
        account: Some(account),
        rate_limits: rate_limits.as_ref().map(compact_rate_limits),
        usage: usage.as_ref().map(compact_usage),
        app_server,
        daemon,
    }
}

fn compact_rate_limits(value: &Value) -> Value {
    let mut object = serde_json::Map::new();
    if let Some(rate_limit_reset_credits) = value.get("rateLimitResetCredits") {
        object.insert(
            "rateLimitResetCredits".to_string(),
            rate_limit_reset_credits.clone(),
        );
    }
    if let Some(rate_limits) = value.get("rateLimits") {
        object.insert("rateLimits".to_string(), rate_limits.clone());
    }

    if object.is_empty() {
        value.clone()
    } else {
        Value::Object(object)
    }
}

fn compact_usage(value: &Value) -> Value {
    match value.get("summary") {
        Some(summary) => json!({ "summary": summary }),
        None => value.clone(),
    }
}

#[derive(Clone)]
struct ReadinessRuntimeFacts {
    detected_executable: CodexExecutableInfo,
    managed_executable: Option<CodexExecutableInfo>,
    running_app_server_version: Option<String>,
    versions_differ: bool,
}

fn readiness_runtime_facts(
    installation: &CodexInstallation,
    app_server: Option<&CodexAppServerInfo>,
    daemon: Option<&CodexDaemonInfo>,
) -> ReadinessRuntimeFacts {
    let managed_executable = daemon.and_then(|daemon| {
        let path = daemon.managed_codex_path.clone();
        let version = daemon
            .managed_codex_version
            .clone()
            .or_else(|| daemon.cli_version.clone());
        (path.is_some() || version.is_some()).then_some(CodexExecutableInfo { path, version })
    });
    let running_app_server_version = daemon
        .and_then(|daemon| daemon.app_server_version.clone())
        .or_else(|| {
            app_server
                .and_then(|app_server| app_server.user_agent.as_deref())
                .and_then(codex_version_from_user_agent)
        });
    let target_version = managed_executable
        .as_ref()
        .and_then(|executable| executable.version.as_deref())
        .or(installation.executable.version.as_deref());
    let versions_differ = target_version
        .zip(running_app_server_version.as_deref())
        .is_some_and(|(target, running)| target != running);

    ReadinessRuntimeFacts {
        detected_executable: installation.executable.clone(),
        managed_executable,
        running_app_server_version,
        versions_differ,
    }
}

fn readiness_with_runtime(
    facts: ReadinessRuntimeFacts,
    state: CodexReadinessState,
    blocks_task_operations: bool,
    reason_code: CodexReadinessReason,
    diagnostic_message: impl Into<String>,
) -> CodexReadiness {
    CodexReadiness {
        state,
        blocks_task_operations,
        reason_code,
        diagnostic_message: diagnostic_message.into(),
        minimum_supported_version: MINIMUM_SUPPORTED_CODEX_CLI_VERSION.to_string(),
        detected_executable: Some(facts.detected_executable),
        managed_executable: facts.managed_executable,
        running_app_server_version: facts.running_app_server_version,
    }
}

pub(super) fn unavailable_status(
    installation: Option<&CodexInstallation>,
    error: &CodexThreadError,
) -> CodexStatusResponse {
    let readiness = match error {
        CodexThreadError::Readiness(readiness) => readiness.as_ref().clone(),
        CodexThreadError::InitializationFailed { message, daemon } => {
            let installation =
                installation.expect("eligible installation accompanies init failure");
            let facts = readiness_runtime_facts(installation, None, Some(daemon.as_ref()));
            let running_is_outdated = facts
                .running_app_server_version
                .as_deref()
                .is_some_and(|version| !version_meets_minimum(version));
            if facts.versions_differ || running_is_outdated {
                let diagnostic_message = if running_is_outdated {
                    format!(
                        "The running Codex app-server is below the minimum supported version {MINIMUM_SUPPORTED_CODEX_CLI_VERSION} and could not initialize: {message}"
                    )
                } else {
                    format!(
                        "The installed and running Codex versions differ, and the running app-server could not initialize: {message}"
                    )
                };
                readiness_with_runtime(
                    facts,
                    CodexReadinessState::RestartRequired,
                    true,
                    CodexReadinessReason::RuntimeVersionMismatch,
                    diagnostic_message,
                )
            } else {
                readiness_with_runtime(
                    facts,
                    CodexReadinessState::Incompatible,
                    true,
                    CodexReadinessReason::ProtocolInitializationFailed,
                    format!("Codex app-server protocol initialization failed: {message}"),
                )
            }
        }
        CodexThreadError::StartupTimeout { .. } => {
            let detected_executable = installation.map(|value| value.executable.clone());
            CodexReadiness::blocking(
                CodexReadinessState::Error,
                CodexReadinessReason::RuntimeStartupTimedOut,
                error.to_string(),
                detected_executable,
            )
        }
        error => {
            let detected_executable = installation.map(|value| value.executable.clone());
            CodexReadiness::blocking(
                CodexReadinessState::Error,
                CodexReadinessReason::AppServerUnavailable,
                error.to_string(),
                detected_executable,
            )
        }
    };

    CodexStatusResponse {
        daemon: match error {
            CodexThreadError::InitializationFailed { daemon, .. } => Some(daemon.as_ref().clone()),
            _ => None,
        },
        readiness,
        account: None,
        rate_limits: None,
        usage: None,
        app_server: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eligible_installation(version: &str) -> CodexInstallation {
        CodexInstallation {
            path: std::path::PathBuf::from("/Users/example/.local/bin/codex"),
            executable: CodexExecutableInfo {
                path: Some("/Users/example/.local/bin/codex".to_string()),
                version: Some(version.to_string()),
            },
        }
    }

    fn daemon_versions(target: &str, running: &str) -> CodexDaemonInfo {
        CodexDaemonInfo {
            status: "alreadyRunning".to_string(),
            backend: Some("pid".to_string()),
            pid: Some(4271),
            managed_codex_path: Some(
                "/Users/example/.codex/packages/standalone/current/codex".to_string(),
            ),
            managed_codex_version: Some(target.to_string()),
            socket_path: Some("/Users/example/.codex/app-server-control.sock".to_string()),
            cli_version: Some(target.to_string()),
            app_server_version: Some(running.to_string()),
        }
    }

    fn account() -> AccountReadResponse {
        AccountReadResponse {
            account: Some(CodexAccount {
                account_type: "chatgpt".to_string(),
                email: Some("user@example.com".to_string()),
                plan_type: Some("pro".to_string()),
            }),
            requires_openai_auth: false,
        }
    }

    #[test]
    fn builds_ready_status_with_canonical_runtime_facts() {
        let installation = eligible_installation("0.147.0");
        let status = status_from_results(
            &installation,
            Some(CodexAppServerInfo {
                user_agent: Some("Codex Desktop/0.147.0".to_string()),
                codex_home: Some("/Users/example/.codex".to_string()),
                platform_family: Some("unix".to_string()),
                platform_os: Some("macos".to_string()),
            }),
            Some(daemon_versions("0.147.0", "0.147.0")),
            Ok(account()),
            Some(json!({ "rateLimits": { "primary": { "usedPercent": 42 } } })),
            Some(json!({
                "dailyUsageBuckets": [{ "startDate": "2026-07-02", "tokens": 777 }],
                "summary": { "lifetimeTokens": 123456 }
            })),
        );

        assert_eq!(status.readiness.state, CodexReadinessState::Ready);
        assert!(!status.readiness.blocks_task_operations);
        assert_eq!(status.readiness.reason_code, CodexReadinessReason::Ready);
        assert_eq!(
            status
                .readiness
                .detected_executable
                .as_ref()
                .and_then(|value| value.version.as_deref()),
            Some("0.147.0")
        );
        assert_eq!(
            status
                .readiness
                .managed_executable
                .as_ref()
                .and_then(|value| value.version.as_deref()),
            Some("0.147.0")
        );
        assert_eq!(
            status.readiness.running_app_server_version.as_deref(),
            Some("0.147.0")
        );
        assert_eq!(status.account, account().account);
        assert_eq!(
            status
                .rate_limits
                .as_ref()
                .and_then(|value| value.pointer("/rateLimits/primary/usedPercent"))
                .and_then(Value::as_u64),
            Some(42)
        );
        assert_eq!(
            status
                .usage
                .as_ref()
                .and_then(|value| value.pointer("/summary/lifetimeTokens"))
                .and_then(Value::as_u64),
            Some(123456)
        );
        assert!(
            status
                .usage
                .as_ref()
                .and_then(|value| value.get("dailyUsageBuckets"))
                .is_none()
        );
    }

    #[test]
    fn maps_missing_account_to_sign_in_required_without_message_heuristics() {
        let installation = eligible_installation("0.147.0");
        let status = status_from_results(
            &installation,
            None,
            Some(daemon_versions("0.147.0", "0.147.0")),
            Ok(AccountReadResponse {
                account: None,
                requires_openai_auth: true,
            }),
            None,
            None,
        );

        assert_eq!(status.readiness.state, CodexReadinessState::SignInRequired);
        assert!(status.readiness.blocks_task_operations);
        assert_eq!(
            status.readiness.reason_code,
            CodexReadinessReason::AuthenticationRequired
        );
        assert_eq!(status.account, None);
    }

    #[test]
    fn allows_compatible_running_runtime_while_restart_is_pending() {
        let installation = eligible_installation("0.148.0");
        let status = status_from_results(
            &installation,
            None,
            Some(daemon_versions("0.148.0", "0.147.0")),
            Ok(account()),
            None,
            None,
        );

        assert_eq!(status.readiness.state, CodexReadinessState::RestartRequired);
        assert!(!status.readiness.blocks_task_operations);
        assert_eq!(
            status.readiness.reason_code,
            CodexReadinessReason::RuntimeVersionMismatch
        );
    }

    #[test]
    fn blocks_outdated_running_runtime_until_restart() {
        let installation = eligible_installation("0.147.0");
        let status = status_from_results(
            &installation,
            None,
            Some(daemon_versions("0.147.0", "0.146.1")),
            Ok(account()),
            None,
            None,
        );

        assert_eq!(status.readiness.state, CodexReadinessState::RestartRequired);
        assert!(status.readiness.blocks_task_operations);
    }

    #[test]
    fn blocks_outdated_running_runtime_even_when_managed_version_matches_it() {
        let installation = eligible_installation("0.147.0");
        let status = status_from_results(
            &installation,
            None,
            Some(daemon_versions("0.146.1", "0.146.1")),
            Ok(account()),
            None,
            None,
        );

        assert_eq!(status.readiness.state, CodexReadinessState::RestartRequired);
        assert!(status.readiness.blocks_task_operations);
        assert_eq!(
            status.readiness.reason_code,
            CodexReadinessReason::RuntimeVersionMismatch
        );
        assert_eq!(status.account, None);
        assert!(
            status
                .readiness
                .diagnostic_message
                .contains("below the minimum supported version 0.147.0")
        );
    }

    #[test]
    fn supported_version_protocol_failure_is_incompatible() {
        let installation = eligible_installation("0.147.0");
        let error = CodexThreadError::InitializationFailed {
            message: "initialize response did not match the maintained schema".to_string(),
            daemon: Box::new(daemon_versions("0.147.0", "0.147.0")),
        };
        let status = unavailable_status(Some(&installation), &error);

        assert_eq!(status.readiness.state, CodexReadinessState::Incompatible);
        assert!(status.readiness.blocks_task_operations);
        assert_eq!(
            status.readiness.reason_code,
            CodexReadinessReason::ProtocolInitializationFailed
        );
    }

    #[test]
    fn initialization_failure_with_stale_runtime_requires_restart() {
        let installation = eligible_installation("0.147.0");
        let error = CodexThreadError::InitializationFailed {
            message: "initialize failed".to_string(),
            daemon: Box::new(daemon_versions("0.147.0", "0.146.1")),
        };
        let status = unavailable_status(Some(&installation), &error);

        assert_eq!(status.readiness.state, CodexReadinessState::RestartRequired);
        assert!(status.readiness.blocks_task_operations);
    }

    #[test]
    fn initialization_failure_with_matching_outdated_runtime_requires_restart() {
        let installation = eligible_installation("0.147.0");
        let error = CodexThreadError::InitializationFailed {
            message: "initialize failed".to_string(),
            daemon: Box::new(daemon_versions("0.146.1", "0.146.1")),
        };
        let status = unavailable_status(Some(&installation), &error);

        assert_eq!(status.readiness.state, CodexReadinessState::RestartRequired);
        assert!(status.readiness.blocks_task_operations);
        assert_eq!(
            status.readiness.reason_code,
            CodexReadinessReason::RuntimeVersionMismatch
        );
    }

    #[test]
    fn account_rpc_failure_remains_a_generic_error() {
        let installation = eligible_installation("0.147.0");
        let status = status_from_results(
            &installation,
            None,
            Some(daemon_versions("0.147.0", "0.147.0")),
            Err(CodexThreadError::Protocol(
                "account/read failed (code -32000)".to_string(),
            )),
            None,
            None,
        );

        assert_eq!(status.readiness.state, CodexReadinessState::Error);
        assert_eq!(
            status.readiness.reason_code,
            CodexReadinessReason::AccountReadFailed
        );
        assert!(status.readiness.blocks_task_operations);
    }

    #[test]
    fn daemon_start_timeout_has_a_stable_readiness_reason() {
        let installation = eligible_installation("0.147.0");
        let error = CodexThreadError::StartupTimeout {
            phase: "daemon start",
            timeout_ms: 10_000,
        };
        let status = unavailable_status(Some(&installation), &error);

        assert_eq!(status.readiness.state, CodexReadinessState::Error);
        assert!(status.readiness.blocks_task_operations);
        assert_eq!(
            status.readiness.reason_code,
            CodexReadinessReason::RuntimeStartupTimedOut
        );
        assert!(status.readiness.diagnostic_message.contains("10000ms"));
    }

    #[test]
    fn readiness_serialization_does_not_retain_legacy_boolean_fields() {
        let installation = eligible_installation("0.147.0");
        let status = status_from_results(
            &installation,
            None,
            Some(daemon_versions("0.147.0", "0.147.0")),
            Ok(account()),
            None,
            None,
        );
        let value = serde_json::to_value(status).expect("serialize Codex status");

        assert_eq!(value["readiness"]["state"], "ready");
        assert_eq!(value["readiness"]["minimumSupportedVersion"], "0.147.0");
        for legacy in [
            "available",
            "codexCliAvailable",
            "appServerAvailable",
            "requiresOpenaiAuth",
        ] {
            assert!(
                value.get(legacy).is_none(),
                "legacy field {legacy} must be removed"
            );
        }
    }
}
