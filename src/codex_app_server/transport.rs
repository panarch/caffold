use std::{
    io::ErrorKind,
    path::Path,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
};

use serde_json::from_slice;
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command},
};
use tokio_tungstenite::{WebSocketStream, client_async};

use super::{CodexDaemonInfo, CodexThreadError};

pub(super) struct ProxyConnection {
    pub socket: WebSocketStream<ProxyStream>,
    pub child: Child,
    pub stderr: ChildStderr,
}

pub(super) struct ManagedProxyConnection {
    pub proxy: ProxyConnection,
    pub daemon: CodexDaemonInfo,
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

pub(super) async fn connect_managed_proxy(
    codex_executable: &Path,
) -> Result<ManagedProxyConnection, CodexThreadError> {
    let daemon = ensure_daemon(codex_executable).await?;
    let proxy = connect_proxy(codex_executable, None).await?;
    Ok(ManagedProxyConnection { proxy, daemon })
}

pub(super) async fn connect_proxy(
    codex_executable: &Path,
    socket_path: Option<&Path>,
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
    let (socket, response) = client_async("ws://localhost/", stream)
        .await
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

async fn ensure_daemon(codex_executable: &Path) -> Result<CodexDaemonInfo, CodexThreadError> {
    daemon_command(codex_executable, "start").await
}

pub(super) async fn restart_daemon(
    codex_executable: &Path,
) -> Result<CodexDaemonInfo, CodexThreadError> {
    daemon_command(codex_executable, "restart").await
}

async fn daemon_command(
    codex_executable: &Path,
    action: &'static str,
) -> Result<CodexDaemonInfo, CodexThreadError> {
    let output = Command::new(codex_executable)
        .arg("app-server")
        .arg("daemon")
        .arg(action)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(start_error)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!("daemon {action} exited with {}", output.status)
        } else {
            stderr
        };
        return Err(CodexThreadError::StartFailed(message));
    }
    from_slice(&output.stdout).map_err(|error| {
        CodexThreadError::Protocol(format!(
            "invalid Codex app-server daemon {action} response: {error}"
        ))
    })
}

fn start_error(error: std::io::Error) -> CodexThreadError {
    if error.kind() == ErrorKind::NotFound {
        CodexThreadError::MissingCli
    } else {
        CodexThreadError::StartFailed(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

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
    async fn restart_invokes_the_daemon_lifecycle_command_and_decodes_status() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let codex = temp.path().join("codex");
        std::fs::write(
            &codex,
            r#"#!/bin/sh
if [ "$1 $2 $3" != "app-server daemon restart" ]; then
  echo "unexpected arguments: $*" >&2
  exit 2
fi
printf '%s' '{"status":"restarted","backend":"pid","pid":4271,"managedCodexVersion":"0.147.0","cliVersion":"0.147.0","appServerVersion":"0.147.0"}'
"#,
        )
        .expect("write fake Codex executable");
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755))
            .expect("make fake Codex executable runnable");

        let daemon = restart_daemon(&codex)
            .await
            .expect("restart daemon through fake Codex executable");

        assert_eq!(daemon.status, "restarted");
        assert_eq!(daemon.pid, Some(4271));
        assert_eq!(daemon.managed_codex_version.as_deref(), Some("0.147.0"));
        assert_eq!(daemon.app_server_version.as_deref(), Some("0.147.0"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_preserves_daemon_command_failure_details() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let codex = temp.path().join("codex");
        std::fs::write(
            &codex,
            r#"#!/bin/sh
echo "daemon is busy" >&2
exit 9
"#,
        )
        .expect("write failing Codex executable");
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755))
            .expect("make failing Codex executable runnable");

        let error = restart_daemon(&codex)
            .await
            .expect_err("restart command must fail");

        assert!(error.to_string().contains("daemon is busy"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn restart_identifies_an_invalid_restart_response() {
        let temp = tempfile::tempdir().expect("temporary Codex fixture");
        let codex = temp.path().join("codex");
        std::fs::write(&codex, "#!/bin/sh\nprintf '%s' 'not-json'\n")
            .expect("write invalid Codex executable");
        std::fs::set_permissions(&codex, std::fs::Permissions::from_mode(0o755))
            .expect("make invalid Codex executable runnable");

        let error = restart_daemon(&codex)
            .await
            .expect_err("invalid daemon response must fail");

        assert!(error.to_string().contains("daemon restart response"));
    }
}
