//! Passive installation checks and on-demand account and model observations.

use super::connect;
use crate::agent::driver::{AgentInstallation, ModelOption};
use copilot_sdk::{Client, Model, rpc::ModelPolicyState};
use semver::Version;
use serde::Serialize;
use std::{
    env,
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
    protocol_version: Option<u32>,
    authenticated: Option<bool>,
    login: Option<String>,
    models: Vec<ModelOption>,
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
        .arg("--version")
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

pub(super) async fn status_for(program: Option<PathBuf>) -> CopilotStatus {
    let installation = match &program {
        Some(program) => inspect(program).await,
        None => AgentInstallation::NotInstalled,
    };
    let mut status = CopilotStatus {
        installation,
        protocol_version: None,
        authenticated: None,
        login: None,
        models: vec![],
        error: None,
    };
    if let Some(path) = program
        && matches!(status.installation, AgentInstallation::Ready { .. })
    {
        let observed = timeout(Duration::from_secs(30), connect(&path)).await;
        match observed {
            Ok(Ok(client)) => {
                match timeout(Duration::from_secs(30), read_runtime(&client, &mut status)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => status.error = Some(error.to_string()),
                    Err(_) => {
                        status.error = Some("Copilot CLI did not answer the status request.".into())
                    }
                }
                if let Err(error) = client.stop().await
                    && status.error.is_none()
                {
                    status.error = Some(error.to_string());
                }
            }
            Ok(Err(error)) => status.error = Some(error.to_string()),
            Err(_) => status.error = Some("Copilot CLI did not finish the SDK handshake.".into()),
        }
    }
    status
}

async fn read_runtime(client: &Client, status: &mut CopilotStatus) -> copilot_sdk::Result<()> {
    status.protocol_version = Some(client.get_status().await?.protocol_version);
    let auth = client.get_auth_status().await?;
    status.authenticated = Some(auth.is_authenticated);
    status.login = auth.login;
    if auth.is_authenticated {
        status.models = client
            .list_models()
            .await?
            .into_iter()
            .filter_map(model_option)
            .collect();
    } else {
        status.error = Some(
            auth.status_message
                .unwrap_or_else(|| "Sign in to GitHub with copilot login.".into()),
        );
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
