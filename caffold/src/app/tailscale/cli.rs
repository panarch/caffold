use std::{
    env,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    time::Duration,
};

use tokio::{process::Command, time::timeout};

const TAILSCALE_COMMAND_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug)]
pub(super) struct TailscaleCommandOutput {
    pub(super) success: bool,
    pub(super) stdout: String,
}

pub(super) type TailscaleCommandFuture =
    Pin<Box<dyn Future<Output = Result<TailscaleCommandOutput, TailscaleCommandError>> + Send>>;

pub(super) trait TailscaleRunner: Send + Sync {
    fn is_available(&self) -> bool;
    fn run(&self, arguments: Vec<String>) -> TailscaleCommandFuture;
}

#[derive(Debug)]
pub(super) struct TailscaleCommandError;

pub(super) struct ProcessTailscaleRunner;

impl TailscaleRunner for ProcessTailscaleRunner {
    fn is_available(&self) -> bool {
        tailscale_executable().is_some()
    }

    fn run(&self, arguments: Vec<String>) -> TailscaleCommandFuture {
        let executable = tailscale_executable();
        Box::pin(async move {
            let executable = executable.ok_or(TailscaleCommandError)?;
            let mut command = Command::new(executable);
            command.kill_on_drop(true).args(arguments);
            let output = timeout(TAILSCALE_COMMAND_TIMEOUT, command.output())
                .await
                .map_err(|_| TailscaleCommandError)?
                .map_err(|_| TailscaleCommandError)?;
            Ok(TailscaleCommandOutput {
                success: output.status.success(),
                stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            })
        })
    }
}

fn tailscale_executable() -> Option<PathBuf> {
    env::var_os("PATH")
        .into_iter()
        .flat_map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join("tailscale"))
        .chain([PathBuf::from(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        )])
        .find(|candidate| is_executable_file(candidate))
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

#[cfg(all(test, unix))]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt};

    use super::*;

    #[test]
    fn recognizes_only_executable_files() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("tailscale");
        fs::write(&executable, b"binary").unwrap();
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!is_executable_file(&executable));

        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(is_executable_file(&executable));
        assert!(!is_executable_file(temp.path()));
        assert!(!is_executable_file(&temp.path().join("missing")));
    }
}
