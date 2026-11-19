//! Passive installation checks and on-demand account and model observations.

mod quota;

use super::connect;
use crate::agent::{
    driver::{AgentInstallation, ModelOption},
    runner::RunnerStatus,
};
use copilot_sdk::{Client, Model, rpc::ModelPolicyState};
use quota::AccountUsage;
use semver::Version;
use serde::Serialize;
use std::{
    env,
    fmt::Display,
    io::ErrorKind,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{process::Command, time::timeout};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopilotStatus {
    installation: AgentInstallation,
    runtime: RunnerStatus,
    cli_path: Option<PathBuf>,
    protocol_version: Option<u32>,
    authenticated: Option<bool>,
    login: Option<String>,
    usage: Option<AccountUsage>,
    models: Vec<ModelOption>,
    models_error: Option<String>,
    error: Option<String>,
}

pub(super) fn executable() -> Option<PathBuf> {
    let paths = env::var_os("PATH");
    let directories = paths.as_deref().into_iter().flat_map(env::split_paths);
    let local_bin = env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/bin"));

    directories
        .chain(local_bin)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join("copilot"))
        .find(|path| {
            path.metadata()
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

pub(crate) async fn installation() -> AgentInstallation {
    match executable() {
        Some(path) => inspect(&path).await,
        None => AgentInstallation::NotInstalled,
    }
}

async fn inspect(path: &Path) -> AgentInstallation {
    let child = Command::new(path)
        .args(["--no-auto-update", "--version"])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output();
    match timeout(Duration::from_secs(10), child).await {
        Ok(Ok(output)) if output.status.success() => {
            let version = std::str::from_utf8(&output.stdout)
                .ok()
                .and_then(parse_version);
            match version {
                Some(version) => AgentInstallation::Ready {
                    version: version.to_string(),
                },
                None => AgentInstallation::Unavailable { version: None },
            }
        }
        Ok(Err(err)) if err.kind() == ErrorKind::NotFound => AgentInstallation::NotInstalled,
        _ => AgentInstallation::Unavailable { version: None },
    }
}

fn parse_version(output: &str) -> Option<Version> {
    let line = output.lines().next()?.trim();
    let version = line
        .strip_prefix("GitHub Copilot CLI ")
        .unwrap_or(line)
        .trim_end_matches('.');
    Version::parse(version).ok()
}

pub(super) async fn status_for(program: Option<PathBuf>, runtime: RunnerStatus) -> CopilotStatus {
    let installation = match &program {
        Some(program) => inspect(program).await,
        None => AgentInstallation::NotInstalled,
    };
    let mut status = CopilotStatus {
        installation,
        runtime,
        cli_path: program.clone(),
        protocol_version: None,
        authenticated: None,
        login: None,
        usage: None,
        models: vec![],
        models_error: None,
        error: None,
    };

    if let Some(path) = program
        && matches!(status.installation, AgentInstallation::Ready { .. })
    {
        let observed = timeout(Duration::from_secs(30), connect(&path)).await;
        match observed {
            Ok(Ok(client)) => {
                if let Err(error) = read_runtime(&client, &mut status).await {
                    status.error = Some(error);
                }
                if let Err(error) = observe(client.stop()).await {
                    status.error.get_or_insert(error);
                }
            }
            Ok(Err(error)) => status.error = Some(error.to_string()),
            Err(_) => status.error = Some("Copilot CLI did not finish the SDK handshake.".into()),
        }
    }
    status
}

async fn observe<T, E: Display>(request: impl Future<Output = Result<T, E>>) -> Result<T, String> {
    timeout(Duration::from_secs(15), request)
        .await
        .map_err(|_| "Copilot CLI did not answer in time.".to_string())?
        .map_err(|error| error.to_string())
}

async fn read_runtime(client: &Client, status: &mut CopilotStatus) -> Result<(), String> {
    let (runtime, auth) = tokio::join!(
        observe(client.get_status()),
        observe(client.get_auth_status())
    );
    match runtime {
        Ok(runtime) => {
            status.installation = AgentInstallation::Ready {
                version: runtime.version,
            };
            status.protocol_version = Some(runtime.protocol_version);
        }
        Err(error) => status.error = Some(error),
    }

    let auth = auth?;
    status.authenticated = Some(auth.is_authenticated);
    status.login = auth.login;

    if !auth.is_authenticated {
        return Err(auth
            .status_message
            .unwrap_or_else(|| "Sign in to GitHub with copilot login.".into()));
    }

    let (models, usage) = tokio::join!(observe(client.list_models()), quota::read(client));
    status.usage = Some(usage);
    match models {
        Ok(models) => status.models = models.into_iter().filter_map(model_option).collect(),
        Err(error) => status.models_error = Some(error),
    }
    Ok(())
}

pub(super) fn model_option(model: Model) -> Option<ModelOption> {
    if model
        .policy
        .is_some_and(|policy| matches!(policy.state, ModelPolicyState::Disabled))
    {
        return None;
    }
    Some(ModelOption {
        is_default: model.id == "auto",
        model: model.id,
        display_name: model.name,
        description: model
            .warning_text
            .and_then(|warning| warning.data_retention),
        default_effort: model.default_reasoning_effort,
        efforts: model.supported_reasoning_efforts.unwrap_or_default(),
        speeds: Vec::new(),
        supports_auto_mode: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn version_probe_uses_the_same_executable_version_as_sdk_tasks() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("copilot");
        std::fs::write(
            &program,
            "#!/bin/sh\ncase \"$*\" in\n  '--no-auto-update --version') echo 1.0.114;;\n  '--version') echo 9.0.0;;\n  *) exit 1;;\nesac\n",
        ).unwrap();
        std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(
            matches!(inspect(&program).await, AgentInstallation::Ready { version } if version == "1.0.114")
        );
    }

    #[test]
    fn the_cli_version_comes_from_its_banner() {
        assert_eq!(
            parse_version(
                "GitHub Copilot CLI 1.0.114.\nRun 'copilot update' to check for updates."
            ),
            Some(Version::new(1, 0, 114))
        );
        assert_eq!(parse_version("1.0.113"), Some(Version::new(1, 0, 113)));
        assert_eq!(parse_version("try another executable"), None);
    }
}
