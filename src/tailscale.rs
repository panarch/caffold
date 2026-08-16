use std::{io, path::PathBuf, process::Command};

use anyhow::{Context, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

pub const DEFAULT_TARGET: &str = "http://127.0.0.1:5177";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    pub connected: bool,
    pub serve_enabled: bool,
    pub target: String,
    pub url: Option<String>,
    pub conflict: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug)]
struct CommandOutput {
    success: bool,
    stdout: String,
    stderr: String,
}

trait CommandRunner {
    fn run(&self, arguments: &[&str]) -> io::Result<CommandOutput>;
}

struct ProcessRunner;

impl CommandRunner for ProcessRunner {
    fn run(&self, arguments: &[&str]) -> io::Result<CommandOutput> {
        let output = match Command::new("tailscale").args(arguments).output() {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let Some(fallback) = platform_tailscale_executable() else {
                    return Err(error);
                };
                Command::new(fallback).args(arguments).output()?
            }
            result => result?,
        };
        Ok(CommandOutput {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        })
    }
}

fn platform_tailscale_executable() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let path = PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
        path.is_file().then_some(path)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

#[derive(Debug, Deserialize)]
struct NodeStatus {
    #[serde(rename = "BackendState")]
    backend_state: String,
    #[serde(rename = "Self")]
    node: Option<Node>,
}

#[derive(Debug, Deserialize)]
struct Node {
    #[serde(rename = "DNSName")]
    dns_name: Option<String>,
}

#[derive(Debug, Default)]
struct ServeInspection {
    owned: bool,
    url: Option<String>,
    conflict: Option<String>,
}

#[derive(Debug)]
struct Snapshot {
    status: TailscaleStatus,
    serve: ServeInspection,
}

pub fn status(target: &str) -> anyhow::Result<TailscaleStatus> {
    Ok(snapshot(&ProcessRunner, target)?.status)
}

pub fn enable(target: &str) -> anyhow::Result<TailscaleStatus> {
    enable_with_runner(&ProcessRunner, target)
}

pub fn disable(target: &str) -> anyhow::Result<TailscaleStatus> {
    disable_with_runner(&ProcessRunner, target)
}

pub fn print_status(status: &TailscaleStatus, json: bool) -> anyhow::Result<()> {
    if json {
        println!("{}", serde_json::to_string(status)?);
        return Ok(());
    }

    if !status.installed {
        println!("Tailscale is not installed; local Caffold remains available.");
        return Ok(());
    }
    if !status.connected {
        println!("Tailscale is installed but not connected.");
        if let Some(message) = &status.message {
            println!("{message}");
        }
        return Ok(());
    }

    println!(
        "Tailscale Serve: {}",
        if status.serve_enabled {
            "enabled"
        } else {
            "disabled"
        }
    );
    println!("Target: {}", status.target);
    if let Some(url) = &status.url {
        println!("URL: {url}");
    }
    if let Some(conflict) = &status.conflict {
        println!("Conflict: {conflict}");
    }
    Ok(())
}

fn enable_with_runner(runner: &dyn CommandRunner, target: &str) -> anyhow::Result<TailscaleStatus> {
    let before = snapshot(runner, target)?;
    require_available(&before.status)?;
    if before.serve.owned {
        return Ok(before.status);
    }
    if let Some(conflict) = before.serve.conflict {
        bail!("Tailscale Serve is already configured for another target: {conflict}");
    }

    let output = runner
        .run(&["serve", "--bg", "--yes", "--https=443", target])
        .context("could not run tailscale serve")?;
    require_success("enable Tailscale Serve", &output)?;
    let after = snapshot(runner, target)?;
    if !after.serve.owned {
        bail!("Tailscale reported success but HTTPS Serve is not owned by {target}");
    }
    Ok(after.status)
}

fn disable_with_runner(
    runner: &dyn CommandRunner,
    target: &str,
) -> anyhow::Result<TailscaleStatus> {
    let before = snapshot(runner, target)?;
    require_available(&before.status)?;
    if let Some(conflict) = before.serve.conflict {
        bail!("refusing to disable Tailscale Serve owned by another target: {conflict}");
    }
    if !before.serve.owned {
        return Ok(before.status);
    }

    let output = runner
        .run(&["serve", "--yes", "--https=443", "off"])
        .context("could not run tailscale serve")?;
    require_success("disable Tailscale Serve", &output)?;
    let after = snapshot(runner, target)?;
    if after.serve.owned {
        bail!("Tailscale reported success but HTTPS Serve remains enabled for {target}");
    }
    Ok(after.status)
}

fn require_available(status: &TailscaleStatus) -> anyhow::Result<()> {
    if !status.installed {
        bail!("Tailscale is not installed; install and connect it before enabling remote access");
    }
    if !status.connected {
        bail!("Tailscale is not connected; run tailscale up before enabling remote access");
    }
    Ok(())
}

fn snapshot(runner: &dyn CommandRunner, target: &str) -> anyhow::Result<Snapshot> {
    validate_target(target)?;
    let node_output = match runner.run(&["status", "--json"]) {
        Ok(output) => output,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(Snapshot {
                status: TailscaleStatus {
                    installed: false,
                    connected: false,
                    serve_enabled: false,
                    target: target.to_string(),
                    url: None,
                    conflict: None,
                    message: None,
                },
                serve: ServeInspection::default(),
            });
        }
        Err(error) => return Err(error).context("could not run tailscale status"),
    };
    if !node_output.success {
        return Ok(Snapshot {
            status: TailscaleStatus {
                installed: true,
                connected: false,
                serve_enabled: false,
                target: target.to_string(),
                url: None,
                conflict: None,
                message: Some(command_message(&node_output)),
            },
            serve: ServeInspection::default(),
        });
    }

    let node: NodeStatus = serde_json::from_str(&node_output.stdout)
        .context("tailscale status returned invalid JSON")?;
    let dns_name = node
        .node
        .and_then(|node| node.dns_name)
        .map(|name| name.trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty());
    if node.backend_state != "Running" {
        return Ok(Snapshot {
            status: TailscaleStatus {
                installed: true,
                connected: false,
                serve_enabled: false,
                target: target.to_string(),
                url: dns_name.map(|name| format!("https://{name}/")),
                conflict: None,
                message: Some(format!("Tailscale backend state is {}", node.backend_state)),
            },
            serve: ServeInspection::default(),
        });
    }

    let serve_output = runner
        .run(&["serve", "status", "--json"])
        .context("could not run tailscale serve status")?;
    let serve = if serve_output.success {
        let payload: Value = serde_json::from_str(&serve_output.stdout)
            .context("tailscale serve status returned invalid JSON")?;
        inspect_serve(&payload, target, dns_name.as_deref())
    } else {
        ServeInspection {
            url: dns_name.as_deref().map(|name| format!("https://{name}/")),
            ..ServeInspection::default()
        }
    };
    let status = TailscaleStatus {
        installed: true,
        connected: true,
        serve_enabled: serve.owned,
        target: target.to_string(),
        url: serve.url.clone(),
        conflict: serve.conflict.clone(),
        message: (!serve_output.success).then(|| command_message(&serve_output)),
    };
    Ok(Snapshot { status, serve })
}

fn validate_target(target: &str) -> anyhow::Result<()> {
    let url = Url::parse(target).context("Tailscale target must be a local HTTP URL")?;
    let port = url.port();
    let canonical = port.map(|port| format!("http://127.0.0.1:{port}"));
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || port.is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || canonical.as_deref() != Some(target)
    {
        bail!("Tailscale target must look like http://127.0.0.1:5177");
    }
    Ok(())
}

fn inspect_serve(payload: &Value, target: &str, dns_name: Option<&str>) -> ServeInspection {
    let fallback_url = dns_name.map(|name| format!("https://{name}/"));
    let tcp_443_configured = payload.get("TCP").and_then(|tcp| tcp.get("443")).is_some();
    let Some(web) = payload.get("Web").and_then(Value::as_object) else {
        return ServeInspection {
            url: fallback_url,
            conflict: tcp_443_configured.then(|| "TCP 443 handler".to_string()),
            ..ServeInspection::default()
        };
    };

    let mut handlers = Vec::new();
    let mut url = fallback_url;
    for (host, entry) in web {
        if !host_has_https_port(host) {
            continue;
        }
        if url.is_none() {
            url = Some(format!("https://{}/", host.trim_end_matches(":443")));
        }
        let Some(entries) = entry.get("Handlers").and_then(Value::as_object) else {
            continue;
        };
        for (path, handler) in entries {
            let proxy = handler
                .get("Proxy")
                .and_then(Value::as_str)
                .unwrap_or("non-proxy handler");
            handlers.push((path.as_str(), proxy));
        }
    }

    if handlers.len() == 1 && handlers[0] == ("/", target) {
        return ServeInspection {
            owned: true,
            url,
            conflict: None,
        };
    }
    if handlers.is_empty() {
        if tcp_443_configured {
            return ServeInspection {
                url,
                conflict: Some("TCP 443 handler".to_string()),
                ..ServeInspection::default()
            };
        }
        return ServeInspection {
            url,
            ..ServeInspection::default()
        };
    }

    let conflict = handlers
        .iter()
        .map(|(path, proxy)| format!("{path} -> {proxy}"))
        .collect::<Vec<_>>()
        .join(", ");
    ServeInspection {
        owned: false,
        url,
        conflict: Some(conflict),
    }
}

fn host_has_https_port(host: &str) -> bool {
    host.rsplit_once(':').is_some_and(|(_, port)| port == "443")
}

fn require_success(action: &str, output: &CommandOutput) -> anyhow::Result<()> {
    if output.success {
        return Ok(());
    }
    bail!("could not {action}: {}", command_message(output));
}

fn command_message(output: &CommandOutput) -> String {
    if !output.stderr.is_empty() {
        output.stderr.clone()
    } else if !output.stdout.is_empty() {
        output.stdout.clone()
    } else {
        "command failed without output".to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::{collections::VecDeque, sync::Mutex};

    use super::*;

    struct FakeRunner {
        responses: Mutex<VecDeque<io::Result<CommandOutput>>>,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl FakeRunner {
        fn new(responses: Vec<io::Result<CommandOutput>>) -> Self {
            Self {
                responses: Mutex::new(responses.into()),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl CommandRunner for FakeRunner {
        fn run(&self, arguments: &[&str]) -> io::Result<CommandOutput> {
            self.calls
                .lock()
                .unwrap()
                .push(arguments.iter().map(|value| value.to_string()).collect());
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .expect("missing fake command response")
        }
    }

    fn success(stdout: &str) -> io::Result<CommandOutput> {
        Ok(CommandOutput {
            success: true,
            stdout: stdout.to_string(),
            stderr: String::new(),
        })
    }

    fn node_status() -> io::Result<CommandOutput> {
        success(r#"{"BackendState":"Running","Self":{"DNSName":"host.tail.ts.net."}}"#)
    }

    fn serve_status(proxy: Option<&str>) -> io::Result<CommandOutput> {
        let handler = proxy
            .map(|proxy| format!(r#""/":{{"Proxy":"{proxy}"}}"#))
            .unwrap_or_default();
        success(&format!(
            r#"{{"Web":{{"host.tail.ts.net:443":{{"Handlers":{{{handler}}}}}}}}}"#
        ))
    }

    #[test]
    fn status_reports_missing_cli_without_failing_local_caffold() {
        let runner = FakeRunner::new(vec![Err(io::Error::new(
            io::ErrorKind::NotFound,
            "missing",
        ))]);
        let snapshot = snapshot(&runner, DEFAULT_TARGET).unwrap();
        assert!(!snapshot.status.installed);
        assert!(!snapshot.status.connected);
        assert_eq!(runner.calls(), vec![vec!["status", "--json"]]);
    }

    #[test]
    fn recognizes_only_an_exclusive_root_handler_as_owned() {
        let owned = serde_json::json!({
            "Web": {
                "host.tail.ts.net:443": {
                    "Handlers": { "/": { "Proxy": DEFAULT_TARGET } }
                }
            }
        });
        assert!(inspect_serve(&owned, DEFAULT_TARGET, None).owned);

        let shared = serde_json::json!({
            "Web": {
                "host.tail.ts.net:443": {
                    "Handlers": {
                        "/": { "Proxy": DEFAULT_TARGET },
                        "/other": { "Proxy": "http://127.0.0.1:9000" }
                    }
                }
            }
        });
        let inspection = inspect_serve(&shared, DEFAULT_TARGET, None);
        assert!(!inspection.owned);
        assert!(inspection.conflict.is_some());

        let tcp = serde_json::json!({ "TCP": { "443": { "TCPForward": "localhost:9000" } } });
        let inspection = inspect_serve(&tcp, DEFAULT_TARGET, None);
        assert_eq!(inspection.conflict.as_deref(), Some("TCP 443 handler"));
    }

    #[test]
    fn enable_is_idempotent_for_the_owned_target() {
        let runner = FakeRunner::new(vec![node_status(), serve_status(Some(DEFAULT_TARGET))]);
        let status = enable_with_runner(&runner, DEFAULT_TARGET).unwrap();
        assert!(status.serve_enabled);
        assert_eq!(runner.calls().len(), 2);
    }

    #[test]
    fn enable_configures_an_empty_https_port_and_verifies_ownership() {
        let runner = FakeRunner::new(vec![
            node_status(),
            serve_status(None),
            success("configured"),
            node_status(),
            serve_status(Some(DEFAULT_TARGET)),
        ]);
        let status = enable_with_runner(&runner, DEFAULT_TARGET).unwrap();
        assert!(status.serve_enabled);
        assert_eq!(
            runner.calls()[2],
            ["serve", "--bg", "--yes", "--https=443", DEFAULT_TARGET]
        );
    }

    #[test]
    fn enable_and_disable_refuse_another_targets_configuration() {
        let responses = || vec![node_status(), serve_status(Some("http://127.0.0.1:9000"))];
        let enable_runner = FakeRunner::new(responses());
        assert!(
            enable_with_runner(&enable_runner, DEFAULT_TARGET)
                .unwrap_err()
                .to_string()
                .contains("another target")
        );
        let disable_runner = FakeRunner::new(responses());
        assert!(
            disable_with_runner(&disable_runner, DEFAULT_TARGET)
                .unwrap_err()
                .to_string()
                .contains("refusing")
        );
    }

    #[test]
    fn disable_turns_off_only_the_exclusively_owned_target() {
        let runner = FakeRunner::new(vec![
            node_status(),
            serve_status(Some(DEFAULT_TARGET)),
            success("disabled"),
            node_status(),
            serve_status(None),
        ]);
        let status = disable_with_runner(&runner, DEFAULT_TARGET).unwrap();
        assert!(!status.serve_enabled);
        assert_eq!(runner.calls()[2], ["serve", "--yes", "--https=443", "off"]);
    }

    #[test]
    fn rejects_non_local_targets() {
        let runner = FakeRunner::new(Vec::new());
        for target in [
            "https://example.com",
            "http://localhost:5177",
            "http://127.0.0.1:5177/",
        ] {
            let error = snapshot(&runner, target).unwrap_err();
            assert!(error.to_string().contains("must look like"));
        }
        assert!(runner.calls().is_empty());
    }
}
