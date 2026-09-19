use std::{
    io::ErrorKind,
    path::Path,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
};

use serde::de::DeserializeOwned;
use serde_json::from_slice;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
    time::timeout,
};
use tokio_tungstenite::{
    WebSocketStream, client_async_with_config, tungstenite::protocol::WebSocketConfig,
};

use super::{CodexDaemonInfo, CodexThreadError, CodexUpdateOutcome};

const DAEMON_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// An update downloads a release, then waits out the daemon's shutdown grace
/// period, at most five minutes, before the new runtime starts.
const DAEMON_UPDATE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);
const PROXY_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub(super) struct ProxyConnection {
    pub socket: WebSocketStream<ProxyStream>,
    pub child: Child,
    pub stderr: ChildStderr,
}

pub(super) struct ProxyStream {
    reader: ChildStdout,
    writer: ChildStdin,
}

impl AsyncRead for ProxyStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.reader).poll_read(cx, buffer)
    }
}

impl AsyncWrite for ProxyStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.writer).poll_write(cx, buffer)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.writer).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.writer).poll_shutdown(cx)
    }
}

pub(super) async fn connect_proxy(
    codex_executable: &Path,
    socket_path: Option<&Path>,
) -> Result<ProxyConnection, CodexThreadError> {
    connect_proxy_with_timeout(codex_executable, socket_path, PROXY_HANDSHAKE_TIMEOUT).await
}

async fn connect_proxy_with_timeout(
    codex_executable: &Path,
    socket_path: Option<&Path>,
    handshake_timeout: std::time::Duration,
) -> Result<ProxyConnection, CodexThreadError> {
    let mut command = Command::new(codex_executable);
    command.arg("app-server").arg("proxy");
    if let Some(socket_path) = socket_path {
        command.arg("--sock").arg(socket_path);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(start_error)?;
    let writer = child.stdin.take().ok_or_else(|| {
        CodexThreadError::Protocol("failed to open Codex app-server proxy stdin".to_string())
    })?;
    let reader = child.stdout.take().ok_or_else(|| {
        CodexThreadError::Protocol("failed to open Codex app-server proxy stdout".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        CodexThreadError::Protocol("failed to open Codex app-server proxy stderr".to_string())
    })?;
    let stream = ProxyStream { reader, writer };
    let (socket, response) = timeout(
        handshake_timeout,
        client_async_with_config("ws://localhost/", stream, Some(proxy_socket_config())),
    )
    .await
    .map_err(|_| CodexThreadError::StartupTimeout {
        phase: "proxy handshake",
        timeout_ms: handshake_timeout.as_millis() as u64,
    })?
    .map_err(|error| CodexThreadError::Protocol(error.to_string()))?;
    if response.status().as_u16() != 101 {
        return Err(CodexThreadError::Protocol(format!(
            "Codex app-server proxy returned WebSocket status {}",
            response.status()
        )));
    }
    Ok(ProxyConnection {
        socket,
        child,
        stderr,
    })
}

/// The app-server answers `thread/resume` with a turn's full items in one
/// frame, and a turn that has run for hours is larger than the 16 MiB frame
/// tungstenite accepts by default.
fn proxy_socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_frame_size(None)
        .max_message_size(None)
}

pub(super) async fn ensure_daemon(
    codex_executable: &Path,
) -> Result<CodexDaemonInfo, CodexThreadError> {
    daemon_command_with_timeout(
        codex_executable,
        DaemonCommand::Start,
        DAEMON_COMMAND_TIMEOUT,
    )
    .await
}

pub(super) async fn restart_daemon(
    codex_executable: &Path,
) -> Result<CodexDaemonInfo, CodexThreadError> {
    daemon_command_with_timeout(
        codex_executable,
        DaemonCommand::Restart,
        DAEMON_COMMAND_TIMEOUT,
    )
    .await
}

pub(super) async fn update_daemon(
    codex_executable: &Path,
) -> Result<CodexUpdateOutcome, CodexThreadError> {
    daemon_command_with_timeout(
        codex_executable,
        DaemonCommand::Update,
        DAEMON_UPDATE_TIMEOUT,
    )
    .await
}

async fn daemon_command_with_timeout<Response: DeserializeOwned>(
    codex_executable: &Path,
    daemon_command: DaemonCommand,
    command_timeout: std::time::Duration,
) -> Result<Response, CodexThreadError> {
    let action = daemon_command.argument();
    let mut command = Command::new(codex_executable);
    command
        .arg("app-server")
        .arg("daemon")
        .arg(action)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = timeout(command_timeout, command.output())
        .await
        .map_err(|_| CodexThreadError::StartupTimeout {
            phase: daemon_command.phase(),
            timeout_ms: command_timeout.as_millis() as u64,
        })?
        .map_err(start_error)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!("daemon {action} exited with {}", output.status)
        } else {
            stderr
        };
        return Err(daemon_command.failure(message));
    }
    from_slice(&output.stdout).map_err(|error| {
        CodexThreadError::Protocol(format!(
            "invalid Codex app-server daemon {action} response: {error}"
        ))
    })
}

#[derive(Debug, Clone, Copy)]
enum DaemonCommand {
    Start,
    Restart,
    Update,
}

impl DaemonCommand {
    fn argument(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Restart => "restart",
            Self::Update => "update",
        }
    }

    fn phase(self) -> &'static str {
        match self {
            Self::Start => "daemon start",
            Self::Restart => "daemon restart",
            Self::Update => "daemon update",
        }
    }

    /// Starting and restarting fail to bring an app-server up; an update fails
    /// to install one.
    fn failure(self, message: String) -> CodexThreadError {
        match self {
            Self::Start | Self::Restart => CodexThreadError::StartFailed(message),
            Self::Update => CodexThreadError::UpdateFailed(message),
        }
    }
}

fn start_error(error: std::io::Error) -> CodexThreadError {
    if error.kind() == ErrorKind::NotFound {
        CodexThreadError::StartFailed("Codex executable disappeared before startup.".to_string())
    } else {
        CodexThreadError::StartFailed(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_started_and_existing_daemon_diagnostics() {
        for status in ["started", "alreadyRunning"] {
            let daemon: CodexDaemonInfo = serde_json::from_value(serde_json::json!({
                "status": status,
                "backend": "pid",
                "pid": 32723,
                "managedCodexPath": "/Users/example/.codex/packages/standalone/current/codex",
                "managedCodexVersion": "0.146.1",
                "socketPath": "/Users/example/.codex/app-server-control/app-server-control.sock",
                "cliVersion": "0.146.0",
                "appServerVersion": "0.146.1"
            }))
            .expect("daemon diagnostics");

            assert_eq!(daemon.status, status);
            assert_eq!(daemon.pid, Some(32723));
            assert_eq!(daemon.app_server_version.as_deref(), Some("0.146.1"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn supported_installation_starts_the_managed_daemon() {
        let codex = checked_in_codex_fixture("fake-codex-daemon");

        let daemon = ensure_daemon(&codex)
            .await
            .expect("start daemon through eligible Codex executable");

        assert_eq!(daemon.status, "started");
        assert_eq!(daemon.managed_codex_version.as_deref(), Some("0.155.1"));
        assert_eq!(daemon.app_server_version.as_deref(), Some("0.155.1"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_invokes_the_daemon_lifecycle_command_and_decodes_status() {
        let codex = checked_in_codex_fixture("fake-codex-daemon");

        let daemon = restart_daemon(&codex)
            .await
            .expect("restart daemon through fake Codex executable");

        assert_eq!(daemon.status, "restarted");
        assert_eq!(daemon.pid, Some(4271));
        assert_eq!(daemon.managed_codex_version.as_deref(), Some("0.155.1"));
        assert_eq!(daemon.app_server_version.as_deref(), Some("0.155.1"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_preserves_daemon_command_failure_details() {
        let codex = checked_in_codex_fixture("fake-codex-daemon-failure");

        let error = restart_daemon(&codex)
            .await
            .expect_err("restart command must fail");

        assert!(error.to_string().contains("daemon is busy"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_identifies_an_invalid_restart_response() {
        let codex = checked_in_codex_fixture("fake-codex-invalid-response");

        let error = restart_daemon(&codex)
            .await
            .expect_err("invalid daemon response must fail");

        assert!(error.to_string().contains("daemon restart response"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_runs_the_daemon_update_command_and_keeps_its_outcome() {
        let codex = checked_in_codex_fixture("fake-codex-daemon");

        let outcome = update_daemon(&codex)
            .await
            .expect("update through fake Codex executable");

        assert_eq!(
            serde_json::to_value(outcome).unwrap(),
            serde_json::json!({
                "status": "updated",
                "installedVersion": "0.156.0",
                "runningVersion": "0.156.0",
                "message": "The managed installation is ready and the running daemon was restarted. Active or queued work may have been interrupted."
            })
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_update_reads_as_an_update_failure() {
        let codex = checked_in_codex_fixture("fake-codex-daemon-failure");

        let error = update_daemon(&codex)
            .await
            .expect_err("update command must fail");

        assert_eq!(error.to_string(), "Codex update failed: daemon is busy");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_and_update_are_bounded_when_codex_hangs() {
        let codex = checked_in_codex_fixture("fake-codex-hang");

        for (command, expected_phase) in [
            (DaemonCommand::Restart, "daemon restart"),
            (DaemonCommand::Update, "daemon update"),
        ] {
            let error = daemon_command_with_timeout::<serde_json::Value>(
                &codex,
                command,
                std::time::Duration::from_millis(30),
            )
            .await
            .expect_err("a hanging daemon command must time out");

            assert!(
                matches!(
                    error,
                    CodexThreadError::StartupTimeout { phase, .. } if phase == expected_phase
                ),
                "{error}"
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn daemon_start_is_bounded_when_codex_hangs() {
        let codex = checked_in_codex_fixture("fake-codex-hang");

        let error = daemon_command_with_timeout::<CodexDaemonInfo>(
            &codex,
            DaemonCommand::Start,
            std::time::Duration::from_millis(30),
        )
        .await
        .expect_err("hanging daemon command must time out");

        assert!(matches!(
            error,
            CodexThreadError::StartupTimeout {
                phase: "daemon start",
                ..
            }
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn proxy_handshake_is_bounded_when_codex_never_responds() {
        let codex = checked_in_codex_fixture("fake-codex-hang");

        let error =
            match connect_proxy_with_timeout(&codex, None, std::time::Duration::from_millis(30))
                .await
            {
                Ok(_) => panic!("hanging proxy handshake must time out"),
                Err(error) => error,
            };

        assert!(matches!(
            error,
            CodexThreadError::StartupTimeout {
                phase: "proxy handshake",
                ..
            }
        ));
    }

    #[cfg(unix)]
    fn checked_in_codex_fixture(name: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent/codex/transport/fixtures")
            .join(name)
    }
}
