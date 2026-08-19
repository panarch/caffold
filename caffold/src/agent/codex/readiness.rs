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
    inspect_codex_installation_from_with_probe(
        explicit,
        search_path,
        home,
        platform_paths,
        &ProcessCodexProbe,
    )
    .await
}

async fn inspect_codex_installation_from_with_probe(
    explicit: Option<&OsStr>,
    search_path: Option<&OsStr>,
    home: Option<&Path>,
    platform_paths: &[PathBuf],
    probe: &impl CodexProbe,
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
            let version = probe.version(&path).await.ok();
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
            let version = match probe.version(&path).await {
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
            if let Err(error) = probe_required_app_server_commands(probe, &path).await {
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

trait CodexProbe {
    async fn version(&self, path: &Path) -> Result<String, VersionProbeError>;

    async fn app_server_command(
        &self,
        path: &Path,
        subcommand: &'static str,
    ) -> Result<(), CapabilityProbeError>;
}

struct ProcessCodexProbe;

impl CodexProbe for ProcessCodexProbe {
    async fn version(&self, path: &Path) -> Result<String, VersionProbeError> {
        probe_codex_version(path).await
    }

    async fn app_server_command(
        &self,
        path: &Path,
        subcommand: &'static str,
    ) -> Result<(), CapabilityProbeError> {
        probe_app_server_command(path, subcommand).await
    }
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

async fn probe_required_app_server_commands(
    probe: &impl CodexProbe,
    path: &Path,
) -> Result<(), CapabilityProbeError> {
    for subcommand in REQUIRED_APP_SERVER_COMMANDS {
        probe.app_server_command(path, subcommand).await?;
    }

    Ok(())
}

async fn probe_app_server_command(
    path: &Path,
    subcommand: &'static str,
) -> Result<(), CapabilityProbeError> {
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
    .map_err(|_| {
        CapabilityProbeError::CheckFailed(format!(
            "Timed out while checking the required Codex app-server {subcommand} command at {}.",
            path.display()
        ))
    })?
    .map_err(|error| {
        CapabilityProbeError::CheckFailed(format!(
            "Failed to check the required Codex app-server {subcommand} command at {}: {error}",
            path.display()
        ))
    })?;

    if !status.success() {
        return Err(CapabilityProbeError::Unavailable(format!(
            "The Codex installation at {} does not provide the required app-server {subcommand} command.",
            path.display()
        )));
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
    use std::cell::RefCell;

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[derive(Debug, Clone, Copy)]
    enum ScriptedVersion {
        Supported(&'static str),
        CommandFailed(&'static str),
        Malformed(&'static str),
    }

    #[derive(Debug, Clone, Copy)]
    enum ScriptedCapability {
        Supported,
        Unavailable(&'static str),
        CheckFailed(&'static str),
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    enum ProbeCall {
        Version,
        AppServerCommand(&'static str),
    }

    struct ScriptedCodexProbe {
        version: ScriptedVersion,
        daemon: ScriptedCapability,
        proxy: ScriptedCapability,
        calls: RefCell<Vec<ProbeCall>>,
    }

    impl ScriptedCodexProbe {
        fn supported(version: &'static str) -> Self {
            Self {
                version: ScriptedVersion::Supported(version),
                daemon: ScriptedCapability::Supported,
                proxy: ScriptedCapability::Supported,
                calls: RefCell::new(Vec::new()),
            }
        }

        fn with_version(version: ScriptedVersion) -> Self {
            Self {
                version,
                ..Self::supported("0.147.0")
            }
        }

        fn with_daemon(mut self, daemon: ScriptedCapability) -> Self {
            self.daemon = daemon;
            self
        }

        fn with_proxy(mut self, proxy: ScriptedCapability) -> Self {
            self.proxy = proxy;
            self
        }

        fn calls(&self) -> Vec<ProbeCall> {
            self.calls.borrow().clone()
        }
    }

    impl CodexProbe for ScriptedCodexProbe {
        async fn version(&self, _path: &Path) -> Result<String, VersionProbeError> {
            self.calls.borrow_mut().push(ProbeCall::Version);
            match self.version {
                ScriptedVersion::Supported(version) => Ok(version.to_string()),
                ScriptedVersion::CommandFailed(message) => {
                    Err(VersionProbeError::CommandFailed(message.to_string()))
                }
                ScriptedVersion::Malformed(output) => {
                    Err(VersionProbeError::Malformed(output.to_string()))
                }
            }
        }

        async fn app_server_command(
            &self,
            _path: &Path,
            subcommand: &'static str,
        ) -> Result<(), CapabilityProbeError> {
            self.calls
                .borrow_mut()
                .push(ProbeCall::AppServerCommand(subcommand));
            let outcome = match subcommand {
                "daemon" => self.daemon,
                "proxy" => self.proxy,
                _ => panic!("unexpected app-server command: {subcommand}"),
            };
            match outcome {
                ScriptedCapability::Supported => Ok(()),
                ScriptedCapability::Unavailable(message) => {
                    Err(CapabilityProbeError::Unavailable(message.to_string()))
                }
                ScriptedCapability::CheckFailed(message) => {
                    Err(CapabilityProbeError::CheckFailed(message.to_string()))
                }
            }
        }
    }

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
    fn write_executable_marker(path: &Path) {
        std::fs::write(path, "fixture selected by discovery tests\n")
            .expect("write executable marker");
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("mark discovery fixture executable");
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
        write_executable_marker(&standalone);
        write_executable_marker(&explicit);
        let probe = ScriptedCodexProbe::supported("0.147.0");

        let installation = inspect_codex_installation_from_with_probe(
            Some(explicit.as_os_str()),
            None,
            Some(temp.path()),
            &[],
            &probe,
        )
        .await
        .expect("explicit override is eligible");

        assert_eq!(installation.path, explicit);
        assert_eq!(installation.executable.version.as_deref(), Some("0.147.0"));
        assert_eq!(
            probe.calls(),
            [
                ProbeCall::Version,
                ProbeCall::AppServerCommand("daemon"),
                ProbeCall::AppServerCommand("proxy")
            ]
        );
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
        write_executable_marker(&standalone);
        write_executable_marker(&path_codex);
        let search_path = env::join_paths([&path_bin]).expect("join PATH");
        let probe = ScriptedCodexProbe::supported("0.147.0");

        let installation = inspect_codex_installation_from_with_probe(
            None,
            Some(search_path.as_os_str()),
            Some(temp.path()),
            &[],
            &probe,
        )
        .await
        .expect("standalone install is eligible");

        assert_eq!(installation.path, standalone);
        assert_eq!(
            probe.calls(),
            [
                ProbeCall::Version,
                ProbeCall::AppServerCommand("daemon"),
                ProbeCall::AppServerCommand("proxy")
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn arbitrary_path_install_is_diagnostic_only() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let path_bin = temp.path().join("path-bin");
        std::fs::create_dir(&path_bin).expect("create PATH bin");
        let path_codex = path_bin.join("codex");
        write_executable_marker(&path_codex);
        let search_path = env::join_paths([&path_bin]).expect("join PATH");
        let probe = ScriptedCodexProbe::supported("0.200.0");

        let readiness = inspect_codex_installation_from_with_probe(
            None,
            Some(search_path.as_os_str()),
            Some(temp.path()),
            &[],
            &probe,
        )
        .await
        .expect_err("PATH install must remain diagnostic-only");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::UnsupportedInstall,
                CodexReadinessReason::UnsupportedPathInstall
            )
        );
        assert_eq!(
            readiness
                .detected_executable
                .as_ref()
                .and_then(|value| value.path.as_deref()),
            path_codex.to_str()
        );
        assert_eq!(
            readiness
                .detected_executable
                .as_ref()
                .and_then(|value| value.version.as_deref()),
            Some("0.200.0")
        );
        assert_eq!(probe.calls(), [ProbeCall::Version]);
    }

    #[tokio::test]
    async fn reports_missing_when_no_supported_or_diagnostic_candidate_exists() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let probe = ScriptedCodexProbe::supported("0.147.0");
        let readiness =
            inspect_codex_installation_from_with_probe(None, None, Some(temp.path()), &[], &probe)
                .await
                .expect_err("missing standalone install");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::Missing,
                CodexReadinessReason::OfficialStandaloneNotFound
            )
        );
        assert!(readiness.detected_executable.is_none());
        assert!(probe.calls().is_empty());
    }

    #[tokio::test]
    async fn invalid_override_is_rejected_without_running_a_probe() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let missing = temp.path().join("missing-codex");
        let probe = ScriptedCodexProbe::supported("0.147.0");

        let readiness = inspect_codex_installation_from_with_probe(
            Some(missing.as_os_str()),
            None,
            None,
            &[],
            &probe,
        )
        .await
        .expect_err("invalid override must be rejected");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::Error,
                CodexReadinessReason::OverrideNotExecutable
            )
        );
        assert!(readiness.diagnostic_message.contains("missing-codex"));
        assert!(probe.calls().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn malformed_version_is_an_unsupported_install() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        write_executable_marker(&home_bin.join("codex"));
        let probe =
            ScriptedCodexProbe::with_version(ScriptedVersion::Malformed("codex-cli unknown"));

        let readiness =
            inspect_codex_installation_from_with_probe(None, None, Some(temp.path()), &[], &probe)
                .await
                .expect_err("malformed version must be rejected");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::UnsupportedInstall,
                CodexReadinessReason::VersionOutputMalformed
            )
        );
        assert!(readiness.diagnostic_message.contains("codex-cli unknown"));
        assert_eq!(probe.calls(), [ProbeCall::Version]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn version_command_failure_is_an_unsupported_install() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        write_executable_marker(&home_bin.join("codex"));
        let probe = ScriptedCodexProbe::with_version(ScriptedVersion::CommandFailed(
            "scripted version failure",
        ));

        let readiness =
            inspect_codex_installation_from_with_probe(None, None, Some(temp.path()), &[], &probe)
                .await
                .expect_err("failed version command must be rejected");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::UnsupportedInstall,
                CodexReadinessReason::VersionCommandFailed
            )
        );
        assert_eq!(readiness.diagnostic_message, "scripted version failure");
        assert_eq!(probe.calls(), [ProbeCall::Version]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn outdated_version_is_rejected_before_any_daemon_command() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        let codex = home_bin.join("codex");
        write_executable_marker(&codex);
        let probe = ScriptedCodexProbe::supported("0.146.9");

        let readiness =
            inspect_codex_installation_from_with_probe(None, None, Some(temp.path()), &[], &probe)
                .await
                .expect_err("outdated version must be rejected");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::UpdateRequired,
                CodexReadinessReason::VersionBelowMinimum
            )
        );
        assert!(readiness.diagnostic_message.contains("0.146.9"));
        assert_eq!(probe.calls(), [ProbeCall::Version]);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn standalone_without_the_daemon_command_is_unsupported() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        write_executable_marker(&home_bin.join("codex"));
        let probe = ScriptedCodexProbe::supported("0.147.0").with_daemon(
            ScriptedCapability::Unavailable("scripted app-server daemon unavailable"),
        );

        let readiness =
            inspect_codex_installation_from_with_probe(None, None, Some(temp.path()), &[], &probe)
                .await
                .expect_err("standalone without daemon support must be rejected");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::UnsupportedInstall,
                CodexReadinessReason::AppServerCommandsUnavailable
            )
        );
        assert!(readiness.diagnostic_message.contains("app-server daemon"));
        assert_eq!(
            probe.calls(),
            [ProbeCall::Version, ProbeCall::AppServerCommand("daemon")]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn standalone_without_the_proxy_command_is_unsupported() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        write_executable_marker(&home_bin.join("codex"));
        let probe = ScriptedCodexProbe::supported("0.147.0").with_proxy(
            ScriptedCapability::Unavailable("scripted app-server proxy unavailable"),
        );

        let readiness =
            inspect_codex_installation_from_with_probe(None, None, Some(temp.path()), &[], &probe)
                .await
                .expect_err("standalone without proxy support must be rejected");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::UnsupportedInstall,
                CodexReadinessReason::AppServerCommandsUnavailable
            )
        );
        assert!(readiness.diagnostic_message.contains("app-server proxy"));
        assert_eq!(
            probe.calls(),
            [
                ProbeCall::Version,
                ProbeCall::AppServerCommand("daemon"),
                ProbeCall::AppServerCommand("proxy")
            ]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn capability_probe_execution_failure_remains_a_generic_error() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let home_bin = temp.path().join(".local/bin");
        std::fs::create_dir_all(&home_bin).expect("create standalone bin");
        let codex = home_bin.join("codex");
        write_executable_marker(&codex);
        let probe = ScriptedCodexProbe::supported("0.147.0").with_daemon(
            ScriptedCapability::CheckFailed("scripted capability execution failure"),
        );

        let readiness =
            inspect_codex_installation_from_with_probe(None, None, Some(temp.path()), &[], &probe)
                .await
                .expect_err("a failed capability check must not imply unsupported capabilities");

        assert_eq!(
            (readiness.state, readiness.reason_code),
            (
                CodexReadinessState::Error,
                CodexReadinessReason::AppServerCapabilityCheckFailed
            )
        );
        assert_eq!(
            readiness.diagnostic_message,
            "scripted capability execution failure"
        );
        assert_eq!(
            probe.calls(),
            [ProbeCall::Version, ProbeCall::AppServerCommand("daemon")]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn checked_in_fixture_exercises_the_process_probe_boundary() {
        let codex = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-codex");

        let installation =
            inspect_codex_installation_from(Some(codex.as_os_str()), None, None, &[])
                .await
                .expect("checked-in fixture must satisfy every process probe");

        assert_eq!(installation.path, codex);
        assert_eq!(installation.executable.version.as_deref(), Some("0.147.0"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn checked_in_fixture_reports_an_unavailable_process_capability() {
        let codex = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-codex");

        let error = probe_app_server_command(&codex, "missing")
            .await
            .expect_err("unknown fixture capability must be unavailable");

        let CapabilityProbeError::Unavailable(message) = error else {
            panic!("non-zero capability exit must remain unavailable");
        };
        assert!(message.contains("app-server missing"));
    }

    #[tokio::test]
    async fn missing_executable_reports_process_probe_execution_failures() {
        let missing = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/missing-codex");

        let version_error = probe_codex_version(&missing)
            .await
            .expect_err("missing version executable must fail");
        let VersionProbeError::CommandFailed(version_message) = version_error else {
            panic!("missing version executable must be a command failure");
        };
        assert!(version_message.contains("Failed to read the Codex version"));

        let capability_error = probe_app_server_command(&missing, "daemon")
            .await
            .expect_err("missing capability executable must fail");
        let CapabilityProbeError::CheckFailed(capability_message) = capability_error else {
            panic!("missing capability executable must be a check failure");
        };
        assert!(capability_message.contains("Failed to check the required Codex app-server"));
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
