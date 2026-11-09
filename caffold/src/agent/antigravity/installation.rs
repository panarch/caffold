//! Locate and inspect the user's CLI. Installation and updates belong to agy.
use super::AntigravityError;
use crate::agent::driver::AgentInstallation;
use semver::Version;
use serde::Serialize;
use std::{env, io::ErrorKind, path::PathBuf, process::Stdio, time::Duration};
use tokio::process::Command;

pub(super) const MINIMUM_VERSION: &str = "1.5.1";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallationStatus {
    installed: Option<bool>,
    ready: bool,
    version: Option<String>,
    minimum_version: &'static str,
    executable: Option<String>,
    error: Option<String>,
}

#[derive(Default)]
pub(super) struct Cli {
    #[cfg(test)]
    pub(super) executable: Option<PathBuf>,
}

impl Cli {
    pub(super) async fn executable(&self) -> Result<PathBuf, AntigravityError> {
        let (path, version) = self.inspect().await?;
        check_version(&version)?;
        Ok(path)
    }

    pub(super) async fn status(&self) -> InstallationStatus {
        let mut status = InstallationStatus {
            installed: None,
            ready: false,
            version: None,
            minimum_version: MINIMUM_VERSION,
            executable: None,
            error: None,
        };
        match self.inspect().await {
            Ok((path, version)) => {
                status.installed = Some(true);
                status.error = check_version(&version).err().map(|error| error.to_string());
                status.ready = status.error.is_none();
                status.executable = Some(path.display().to_string());
                status.version = Some(version);
            }
            Err(AntigravityError::NotInstalled) => status.installed = Some(false),
            Err(error) => status.error = Some(error.to_string()),
        }
        status
    }

    pub(super) async fn installation(&self) -> AgentInstallation {
        match self.inspect().await {
            Ok((_, version)) if check_version(&version).is_ok() => {
                AgentInstallation::Ready { version }
            }
            Ok((_, version)) => AgentInstallation::Unavailable {
                version: Some(version),
            },
            Err(AntigravityError::NotInstalled) => AgentInstallation::NotInstalled,
            Err(_) => AgentInstallation::Unavailable { version: None },
        }
    }

    async fn inspect(&self) -> Result<(PathBuf, String), AntigravityError> {
        let path = self.path();
        let output = tokio::time::timeout(
            Duration::from_secs(10),
            Command::new(&path)
                .arg("--version")
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| AntigravityError::Installation("agy --version timed out".into()))?
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                AntigravityError::NotInstalled
            } else {
                AntigravityError::Installation(error.to_string())
            }
        })?;
        if !output.status.success() {
            return Err(AntigravityError::Installation(format!(
                "agy --version exited with {}",
                output.status
            )));
        }
        let version = String::from_utf8(output.stdout)
            .map_err(|error| AntigravityError::Installation(error.to_string()))?;
        Ok((path, version.trim().to_owned()))
    }

    fn path(&self) -> PathBuf {
        #[cfg(test)]
        if let Some(path) = &self.executable {
            return path.clone();
        }
        if let Some(paths) = env::var_os("PATH") {
            for directory in env::split_paths(&paths) {
                let candidate = directory.join("agy");
                if candidate.is_file() {
                    return candidate;
                }
            }
        }
        if let Some(home) = env::var_os("HOME") {
            let candidate = PathBuf::from(home).join(".local/bin/agy");
            if candidate.is_file() {
                return candidate;
            }
        }
        PathBuf::from("agy")
    }
}

pub(super) fn check_version(value: &str) -> Result<(), AntigravityError> {
    let version = Version::parse(value).map_err(|_| {
        AntigravityError::Installation(format!("unrecognized agy version: {value}"))
    })?;
    if version < Version::new(1, 5, 1) {
        return Err(AntigravityError::Installation(format!(
            "Antigravity CLI {MINIMUM_VERSION} or newer is required; found {version}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    // The agy stand-ins are checked in. Linux refuses to run a file that is
    // open for writing, and a process another test is starting can still
    // hold a file this test has just written.
    fn cli_at(executable: PathBuf) -> Cli {
        Cli {
            executable: Some(executable),
        }
    }

    fn fake_agy(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent/antigravity/installation/fixtures")
            .join(name)
    }

    #[tokio::test]
    async fn absent_old_and_failed_cli_are_distinct_from_ready() {
        let root = tempfile::tempdir().unwrap();
        let status = cli_at(root.path().join("agy")).status().await;
        assert_eq!(status.installed, Some(false));
        assert!(!status.ready);
        let old = cli_at(fake_agy("fake-agy-1.4.5"));
        let status = old.status().await;
        assert_eq!(status.installed, Some(true));
        assert_eq!(status.version.as_deref(), Some("1.4.5"));
        assert!(!status.ready);
        assert!(matches!(
            old.executable().await,
            Err(AntigravityError::Installation(_))
        ));
        let current = fake_agy("fake-agy-1.5.1");
        assert!(cli_at(current.clone()).status().await.ready);
        assert_eq!(cli_at(current.clone()).executable().await.unwrap(), current);
        let status = cli_at(fake_agy("fake-agy-failure")).status().await;
        assert_eq!(status.installed, None);
        assert!(!status.ready);
        assert!(status.error.is_some());
    }

    #[tokio::test]
    async fn an_installation_is_ready_only_at_the_minimum_version_or_newer() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            cli_at(root.path().join("agy")).installation().await,
            AgentInstallation::NotInstalled
        );
        assert_eq!(
            cli_at(fake_agy("fake-agy-1.4.5")).installation().await,
            AgentInstallation::Unavailable {
                version: Some("1.4.5".to_string())
            }
        );
        assert_eq!(
            cli_at(fake_agy("fake-agy-1.5.1")).installation().await,
            AgentInstallation::Ready {
                version: "1.5.1".to_string()
            }
        );
        assert_eq!(
            cli_at(fake_agy("fake-agy-failure")).installation().await,
            AgentInstallation::Unavailable { version: None }
        );
    }

    #[test]
    fn minimum_version_is_not_an_exact_release_pin() {
        assert!(check_version("1.5.1").is_ok());
        assert!(check_version("1.6.0").is_ok());
        for version in ["1.5.0", "1.5.1-rc.1", "unknown"] {
            assert!(matches!(
                check_version(version),
                Err(AntigravityError::Installation(_))
            ));
        }
    }
}
