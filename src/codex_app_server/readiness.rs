use std::{
    env,
    ffi::OsStr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use semver::Version;
use serde::{Deserialize, Serialize};
use tokio::{process::Command, time::timeout};

pub use super::protocol::MINIMUM_SUPPORTED_CODEX_CLI_VERSION;

const VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const CAPABILITY_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const REQUIRED_APP_SERVER_COMMANDS: [&str; 2] = ["daemon", "proxy"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CodexReadinessState {
    Missing,
    UnsupportedInstall,
    UpdateRequired,
    SignInRequired,
    RestartRequired,
    Incompatible,
    Ready,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CodexReadinessReason {
    OfficialStandaloneNotFound,
    OverrideNotExecutable,
    UnsupportedPathInstall,
    VersionCommandFailed,
    VersionOutputMalformed,
    VersionBelowMinimum,
    AppServerCommandsUnavailable,
    AppServerCapabilityCheckFailed,
    AuthenticationRequired,
    AccountResponseIncomplete,
    AccountReadFailed,
    RuntimeVersionMismatch,
    ProtocolInitializationFailed,
    RuntimeStartupTimedOut,
    AppServerUnavailable,
    ReadyRuntimeUnavailable,
    Ready,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexExecutableInfo {
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexReadiness {
    pub state: CodexReadinessState,
    pub blocks_task_operations: bool,
    pub reason_code: CodexReadinessReason,
    pub diagnostic_message: String,
    pub minimum_supported_version: String,
    pub detected_executable: Option<CodexExecutableInfo>,
    pub managed_executable: Option<CodexExecutableInfo>,
    pub running_app_server_version: Option<String>,
}

impl CodexReadiness {
    pub(crate) fn blocking(
        state: CodexReadinessState,
        reason_code: CodexReadinessReason,
        diagnostic_message: impl Into<String>,
        detected_executable: Option<CodexExecutableInfo>,
    ) -> Self {
        Self {
            state,
            blocks_task_operations: true,
            reason_code,
            diagnostic_message: diagnostic_message.into(),
            minimum_supported_version: MINIMUM_SUPPORTED_CODEX_CLI_VERSION.to_string(),
            detected_executable,
            managed_executable: None,
            running_app_server_version: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CodexInstallation {
    pub(crate) path: PathBuf,
    pub(crate) executable: CodexExecutableInfo,
}

enum DiscoveredCodex {
    Supported(PathBuf),
    Unsupported(PathBuf),
    Missing,
    InvalidOverride(PathBuf),
}

pub(crate) async fn inspect_codex_installation() -> Result<CodexInstallation, CodexReadiness> {
    let explicit = env::var_os("CAFFOLD_CODEX_BIN");
    let search_path = env::var_os("PATH");
    let home = env::var_os("HOME").map(PathBuf::from);
    inspect_codex_installation_from(
        explicit.as_deref(),
        search_path.as_deref(),
        home.as_deref(),
        &[
            PathBuf::from("/opt/homebrew/bin/codex"),
            PathBuf::from("/usr/local/bin/codex"),
        ],
    )
    .await
}

async fn inspect_codex_installation_from(
    explicit: Option<&OsStr>,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
    platform_paths: &[PathBuf],
) -> Result<CodexInstallation, CodexReadiness> {
    match discover_codex(explicit, search_path, home, platform_paths) {
        DiscoveredCodex::Missing => Err(CodexReadiness::blocking(
            CodexReadinessState::Missing,
            CodexReadinessReason::OfficialStandaloneNotFound,
            "The official standalone Codex installation was not found.",
            None,
        )),
        DiscoveredCodex::InvalidOverride(path) => {
            let executable = executable_info(&path, None);
            Err(CodexReadiness::blocking(
                CodexReadinessState::Error,
                CodexReadinessReason::OverrideNotExecutable,
                format!(
                    "CAFFOLD_CODEX_BIN does not point to an executable: {}",
                    path.display()
                ),
                Some(executable),
            ))
        }
        DiscoveredCodex::Unsupported(path) => {
            let version = probe_codex_version(&path).await.ok();
            let executable = executable_info(&path, version);
            Err(CodexReadiness::blocking(
                CodexReadinessState::UnsupportedInstall,
                CodexReadinessReason::UnsupportedPathInstall,
                format!(
                    "A Codex executable was found at {}, but Caffold requires the official standalone installation.",
                    path.display()
                ),
                Some(executable),
            ))
        }
        DiscoveredCodex::Supported(path) => {
            let version = match probe_codex_version(&path).await {
                Ok(version) => version,
                Err(VersionProbeError::CommandFailed(message)) => {
                    return Err(CodexReadiness::blocking(
                        CodexReadinessState::UnsupportedInstall,
                        CodexReadinessReason::VersionCommandFailed,
                        message,
                        Some(executable_info(&path, None)),
                    ));
                }
                Err(VersionProbeError::Malformed(output)) => {
                    return Err(CodexReadiness::blocking(
                        CodexReadinessState::UnsupportedInstall,
                        CodexReadinessReason::VersionOutputMalformed,
                        format!(
                            "Codex returned an unsupported version response: {}",
                            output.trim()
                        ),
                        Some(executable_info(&path, None)),
                    ));
                }
            };
            let executable = executable_info(&path, Some(version.clone()));
            if !version_meets_minimum(&version) {
                return Err(CodexReadiness::blocking(
                    CodexReadinessState::UpdateRequired,
                    CodexReadinessReason::VersionBelowMinimum,
                    format!(
                        "Codex CLI {version} is older than the minimum supported version {MINIMUM_SUPPORTED_CODEX_CLI_VERSION}.",
                    ),
                    Some(executable),
                ));
            }
            if let Err(error) = probe_required_app_server_commands(&path).await {
                let (state, reason_code) = match &error {
                    CapabilityProbeError::Unavailable(_) => (
                        CodexReadinessState::UnsupportedInstall,
                        CodexReadinessReason::AppServerCommandsUnavailable,
                    ),
                    CapabilityProbeError::CheckFailed(_) => (
                        CodexReadinessState::Error,
                        CodexReadinessReason::AppServerCapabilityCheckFailed,
                    ),
                };
                return Err(CodexReadiness::blocking(
                    state,
                    reason_code,
                    error.message(),
                    Some(executable),
                ));
            }
            Ok(CodexInstallation { path, executable })
        }
    }
}

fn discover_codex(
    explicit: Option<&OsStr>,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
    platform_paths: &[PathBuf],
) -> DiscoveredCodex {
    if let Some(explicit) = explicit.filter(|value| !value.is_empty()) {
        return find_executable_in_path(explicit, search_path)
            .map(DiscoveredCodex::Supported)
            .unwrap_or_else(|| DiscoveredCodex::InvalidOverride(PathBuf::from(explicit)));
    }

    if let Some(standalone) = home.map(|home| home.join(".local/bin/codex"))
        && is_executable_file(&standalone)
    {
        return DiscoveredCodex::Supported(standalone);
    }

    if let Some(path_install) =
        find_executable_in_path(OsStr::new("codex"), search_path).or_else(|| {
            platform_paths
                .iter()
                .find(|candidate| is_executable_file(candidate))
                .cloned()
        })
    {
        return DiscoveredCodex::Unsupported(path_install);
    }

    DiscoveredCodex::Missing
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn find_executable_in_path(command: &OsStr, search_path: Option<&OsStr>) -> Option<PathBuf> {
    let command_path = Path::new(command);
    if command_path.components().count() > 1 {
        return is_executable_file(command_path).then(|| command_path.to_path_buf());
    }

    search_path.and_then(|search_path| {
        env::split_paths(search_path)
            .map(|directory| directory.join(command_path))
            .find(|candidate| is_executable_file(candidate))
    })
}

#[derive(Debug)]
enum VersionProbeError {
    CommandFailed(String),
    Malformed(String),
}

async fn probe_codex_version(path: &Path) -> Result<String, VersionProbeError> {
    let output = timeout(
        VERSION_PROBE_TIMEOUT,
        Command::new(path)
            .arg("--version")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| {
        VersionProbeError::CommandFailed(format!(
            "Timed out while reading the Codex version from {}.",
            path.display()
        ))
    })?
    .map_err(|error| {
        VersionProbeError::CommandFailed(format!(
            "Failed to read the Codex version from {}: {error}",
            path.display()
        ))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(VersionProbeError::CommandFailed(if stderr.is_empty() {
            format!(
                "Codex version command at {} exited with {}.",
                path.display(),
                output.status
            )
        } else {
            format!("Codex version command failed: {stderr}")
        }));
    }

    let output = String::from_utf8_lossy(&output.stdout).trim().to_string();
    parse_codex_version(&output).ok_or(VersionProbeError::Malformed(output))
}

fn parse_codex_version(output: &str) -> Option<String> {
    let mut words = output.split_whitespace();
    while let Some(word) = words.next() {
        if word == "codex-cli" {
            let version = words.next()?;
            return Version::parse(version)
                .ok()
                .map(|version| version.to_string());
        }
    }
    None
}

enum CapabilityProbeError {
    Unavailable(String),
    CheckFailed(String),
}

impl CapabilityProbeError {
    fn message(&self) -> String {
        match self {
            Self::Unavailable(message) | Self::CheckFailed(message) => message.clone(),
        }
    }
}

async fn probe_required_app_server_commands(path: &Path) -> Result<(), CapabilityProbeError> {
    for subcommand in REQUIRED_APP_SERVER_COMMANDS {
        let status = timeout(
            CAPABILITY_PROBE_TIMEOUT,
            Command::new(path)
                .arg("app-server")
                .arg(subcommand)
                .arg("--help")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await
        .map_err(|_| CapabilityProbeError::CheckFailed(
            format!(
                "Timed out while checking the required Codex app-server {subcommand} command at {}.",
                path.display()
            )
        ))?
        .map_err(|error| CapabilityProbeError::CheckFailed(
            format!(
                "Failed to check the required Codex app-server {subcommand} command at {}: {error}",
                path.display()
            )
        ))?;

        if !status.success() {
            return Err(CapabilityProbeError::Unavailable(format!(
                "The Codex installation at {} does not provide the required app-server {subcommand} command.",
                path.display()
            )));
        }
    }

    Ok(())
}

pub(crate) fn version_meets_minimum(version: &str) -> bool {
    let Ok(version) = Version::parse(version) else {
        return false;
    };
    let minimum = Version::parse(MINIMUM_SUPPORTED_CODEX_CLI_VERSION)
        .expect("maintained Codex minimum version is valid semver");
    version >= minimum
}

pub(crate) fn codex_version_from_user_agent(user_agent: &str) -> Option<String> {
    let version = user_agent.rsplit_once('/')?.1.split_whitespace().next()?;
    Version::parse(version)
        .ok()
        .map(|version| version.to_string())
}

fn executable_info(path: &Path, version: Option<String>) -> CodexExecutableInfo {
    CodexExecutableInfo {
        path: Some(path.display().to_string()),
        version,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn readiness_reason_codes_serialize_as_the_stable_wire_contract() {
        for (reason, expected) in [
            (
                CodexReadinessReason::OfficialStandaloneNotFound,
                "officialStandaloneNotFound",
            ),
            (
                CodexReadinessReason::OverrideNotExecutable,
                "overrideNotExecutable",
            ),
            (
                CodexReadinessReason::UnsupportedPathInstall,
                "unsupportedPathInstall",
            ),
            (
                CodexReadinessReason::VersionCommandFailed,
                "versionCommandFailed",
            ),
            (
                CodexReadinessReason::VersionOutputMalformed,
                "versionOutputMalformed",
            ),
            (
                CodexReadinessReason::VersionBelowMinimum,
                "versionBelowMinimum",
            ),
            (
                CodexReadinessReason::AppServerCommandsUnavailable,
                "appServerCommandsUnavailable",
            ),
            (
                CodexReadinessReason::AppServerCapabilityCheckFailed,
                "appServerCapabilityCheckFailed",
            ),
            (
                CodexReadinessReason::AuthenticationRequired,
                "authenticationRequired",
            ),
            (
                CodexReadinessReason::AccountResponseIncomplete,
                "accountResponseIncomplete",
            ),
            (CodexReadinessReason::AccountReadFailed, "accountReadFailed"),
            (
                CodexReadinessReason::RuntimeVersionMismatch,
                "runtimeVersionMismatch",
            ),
            (
                CodexReadinessReason::ProtocolInitializationFailed,
                "protocolInitializationFailed",
            ),
            (
                CodexReadinessReason::RuntimeStartupTimedOut,
                "runtimeStartupTimedOut",
            ),
            (
                CodexReadinessReason::AppServerUnavailable,
                "appServerUnavailable",
            ),
            (
                CodexReadinessReason::ReadyRuntimeUnavailable,
                "readyRuntimeUnavailable",
            ),
            (CodexReadinessReason::Ready, "ready"),
        ] {
            assert_eq!(
                serde_json::to_value(reason).expect("serialize readiness reason"),
                expected
            );
        }
    }

    #[cfg(unix)]
    fn write_executable(path: &Path, body: &str) {
        std::fs::write(path, format!("#!/bin/sh\n{body}\n")).expect("write executable fixture");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("mark fixture executable");
    }

    #[cfg(unix)]
    fn write_supported_executable(path: &Path, version: &str) {
        write_executable(
            path,
            &format!(
                concat!(
                    "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli {}'; exit 0; fi; ",
                    "if [ \"$1 $3\" = \"app-server --help\" ] && ",
                    "{{ [ \"$2\" = \"daemon\" ] || [ \"$2\" = \"proxy\" ]; }}; then exit 0; fi; ",
                    "exit 2"
                ),
                version
            ),
        );
    }

    #[test]
    fn parses_codex_semver_without_accepting_unrelated_output() {
        assert_eq!(
            parse_codex_version("codex-cli 0.147.0"),
            Some("0.147.0".to_string())
        );
        assert_eq!(
            parse_codex_version("codex-cli 0.148.0-beta.1"),
            Some("0.148.0-beta.1".to_string())
        );
        assert_eq!(parse_codex_version("Codex 0.147.0"), None);
        assert_eq!(parse_codex_version("codex-cli unknown"), None);
    }

    #[test]
    fn minimum_policy_accepts_compatible_upgrades() {
        assert!(!version_meets_minimum("0.146.9"));
        assert!(!version_meets_minimum("0.147.0-alpha.1"));
        assert!(version_meets_minimum("0.147.0"));
        assert!(version_meets_minimum("0.148.0"));
        assert!(version_meets_minimum("1.0.0"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn explicit_override_precedes_the_official_standalone_install() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        let standalone = home_bin.join("codex");
        let explicit = temp.path().join("override-codex");
        write_supported_executable(&standalone, "0.148.0");
        write_supported_executable(&explicit, "0.147.0");

        let installation = inspect_codex_installation_from(
            Some(explicit.as_os_str()),
            None,
            Some(temp.path()),
            &[],
        )
        .await
        .expect("explicit override is eligible");

        assert_eq!(installation.path, explicit);
        assert_eq!(installation.executable.version.as_deref(), Some("0.147.0"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn official_standalone_wins_over_an_arbitrary_path_install() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        let path_bin = temp.path().join("path-bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        std::fs::create_dir(&path_bin).expect("create PATH bin");
        let standalone = home_bin.join("codex");
        let path_codex = path_bin.join("codex");
        write_supported_executable(&standalone, "0.147.0");
        write_executable(&path_codex, "echo 'codex-cli 9.0.0'");
        let search_path = env::join_paths([&path_bin]).expect("join PATH");

        let installation = inspect_codex_installation_from(
            None,
            Some(search_path.as_os_str()),
            Some(temp.path()),
            &[],
        )
        .await
        .expect("standalone install is eligible");

        assert_eq!(installation.path, standalone);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn arbitrary_path_install_is_diagnostic_only() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let path_bin = temp.path().join("path-bin");
        std::fs::create_dir(&path_bin).expect("create PATH bin");
        let path_codex = path_bin.join("codex");
        write_executable(&path_codex, "echo 'codex-cli 0.200.0'");
        let search_path = env::join_paths([&path_bin]).expect("join PATH");

        let readiness = inspect_codex_installation_from(
            None,
            Some(search_path.as_os_str()),
            Some(temp.path()),
            &[],
        )
        .await
        .expect_err("PATH install must not be launched");

        assert_eq!(readiness.state, CodexReadinessState::UnsupportedInstall);
        assert_eq!(
            readiness.reason_code,
            CodexReadinessReason::UnsupportedPathInstall
        );
        assert_eq!(
            readiness
                .detected_executable
                .as_ref()
                .and_then(|value| value.version.as_deref()),
            Some("0.200.0")
        );
    }

    #[tokio::test]
    async fn reports_missing_when_no_supported_or_diagnostic_candidate_exists() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let readiness = inspect_codex_installation_from(None, None, Some(temp.path()), &[])
            .await
            .expect_err("missing standalone install");

        assert_eq!(readiness.state, CodexReadinessState::Missing);
        assert_eq!(
            readiness.reason_code,
            CodexReadinessReason::OfficialStandaloneNotFound
        );
        assert!(readiness.detected_executable.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn malformed_version_is_an_unsupported_install() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        write_executable(&home_bin.join("codex"), "echo 'codex-cli unknown'");

        let readiness = inspect_codex_installation_from(None, None, Some(temp.path()), &[])
            .await
            .expect_err("malformed version must be rejected");

        assert_eq!(readiness.state, CodexReadinessState::UnsupportedInstall);
        assert_eq!(
            readiness.reason_code,
            CodexReadinessReason::VersionOutputMalformed
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn outdated_version_is_rejected_before_any_daemon_command() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        let marker = temp.path().join("daemon-invoked");
        let codex = home_bin.join("codex");
        write_executable(
            &codex,
            &format!(
                "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.146.9'; else touch '{}'; fi",
                marker.display()
            ),
        );

        let readiness = inspect_codex_installation_from(None, None, Some(temp.path()), &[])
            .await
            .expect_err("outdated version must be rejected");

        assert_eq!(readiness.state, CodexReadinessState::UpdateRequired);
        assert_eq!(
            readiness.reason_code,
            CodexReadinessReason::VersionBelowMinimum
        );
        assert!(
            !marker.exists(),
            "daemon command must not run before the version gate"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn standalone_without_the_daemon_command_is_unsupported() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        write_executable(
            &home_bin.join("codex"),
            "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.147.0'; exit 0; fi; exit 2",
        );

        let readiness = inspect_codex_installation_from(None, None, Some(temp.path()), &[])
            .await
            .expect_err("standalone without daemon support must be rejected");

        assert_eq!(readiness.state, CodexReadinessState::UnsupportedInstall);
        assert_eq!(
            readiness.reason_code,
            CodexReadinessReason::AppServerCommandsUnavailable
        );
        assert!(readiness.diagnostic_message.contains("app-server daemon"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn standalone_without_the_proxy_command_is_unsupported() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        write_executable(
            &home_bin.join("codex"),
            concat!(
                "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.147.0'; exit 0; fi; ",
                "if [ \"$1 $2 $3\" = \"app-server daemon --help\" ]; then exit 0; fi; ",
                "exit 2"
            ),
        );

        let readiness = inspect_codex_installation_from(None, None, Some(temp.path()), &[])
            .await
            .expect_err("standalone without proxy support must be rejected");

        assert_eq!(readiness.state, CodexReadinessState::UnsupportedInstall);
        assert_eq!(
            readiness.reason_code,
            CodexReadinessReason::AppServerCommandsUnavailable
        );
        assert!(readiness.diagnostic_message.contains("app-server proxy"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capability_probe_execution_failure_remains_a_generic_error() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        write_executable(
            &home_bin.join("codex"),
            "if [ \"$1\" = \"--version\" ]; then rm -- \"$0\"; echo 'codex-cli 0.147.0'; exit 0; fi",
        );

        let readiness = inspect_codex_installation_from(None, None, Some(temp.path()), &[])
            .await
            .expect_err("a failed capability check must not imply unsupported capabilities");

        assert_eq!(readiness.state, CodexReadinessState::Error);
        assert_eq!(
            readiness.reason_code,
            CodexReadinessReason::AppServerCapabilityCheckFailed
        );
    }

    #[test]
    fn parses_running_version_from_initialized_user_agent() {
        assert_eq!(
            codex_version_from_user_agent("Codex Desktop/0.147.0"),
            Some("0.147.0".to_string())
        );
        assert_eq!(codex_version_from_user_agent("Codex Desktop"), None);
    }
}
