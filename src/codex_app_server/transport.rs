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
    let output = Command::new(codex_executable)
        .arg("app-server")
        .arg("daemon")
        .arg("start")
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(start_error)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            format!("daemon start exited with {}", output.status)
        } else {
            stderr
        };
        return Err(CodexThreadError::StartFailed(message));
    }
    from_slice(&output.stdout).map_err(|error| {
        CodexThreadError::Protocol(format!(
            "invalid Codex app-server daemon start response: {error}"
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
}
