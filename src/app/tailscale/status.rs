use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

const MAX_TAILNET_URL_BYTES: usize = 512;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum TailscaleState {
    NotInstalled,
    Disconnected,
    ServeOff,
    Configuring,
    Disabling,
    Ready,
    Unavailable,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum TailscaleReason {
    StatusNotChecked,
    CliNotFound,
    BackendNotRunning,
    ServeDisabled,
    ConfiguringServe,
    DisablingServe,
    ServeReady,
    StatusCommandFailed,
    StatusResponseInvalid,
    ServeStatusCommandFailed,
    ServeStatusResponseInvalid,
    ServeTargetConflict,
    ServeEnableFailed,
    ServeDisableFailed,
    ServeEnableIncomplete,
    ServeDisableIncomplete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct TailscaleStatus {
    pub(super) state: TailscaleState,
    pub(super) reason_code: TailscaleReason,
    pub(super) diagnostic_message: String,
    pub(super) tailnet_url: Option<String>,
}

impl TailscaleStatus {
    pub(super) fn new(
        state: TailscaleState,
        reason_code: TailscaleReason,
        diagnostic_message: impl Into<String>,
    ) -> Self {
        Self {
            state,
            reason_code,
            diagnostic_message: diagnostic_message.into(),
            tailnet_url: None,
        }
    }

    fn ready(url: String) -> Self {
        Self {
            state: TailscaleState::Ready,
            reason_code: TailscaleReason::ServeReady,
            diagnostic_message: "Caffold is available through Tailscale Serve.".to_string(),
            tailnet_url: Some(url),
        }
    }
}

pub(super) fn classify_serve_status(body: &str, target: &str) -> TailscaleStatus {
    let Ok(payload) = serde_json::from_str::<Value>(body) else {
        return command_failed_status(
            TailscaleReason::ServeStatusResponseInvalid,
            "Tailscale returned an invalid Serve status response.",
        );
    };
    let Some(payload) = payload.as_object() else {
        return command_failed_status(
            TailscaleReason::ServeStatusResponseInvalid,
            "Tailscale returned an invalid Serve status response.",
        );
    };
    let web = match payload.get("Web") {
        Some(Value::Object(web)) => web,
        Some(_) => {
            return command_failed_status(
                TailscaleReason::ServeStatusResponseInvalid,
                "Tailscale returned an invalid Serve status response.",
            );
        }
        None => {
            return TailscaleStatus::new(
                TailscaleState::ServeOff,
                TailscaleReason::ServeDisabled,
                "Tailscale is connected and Caffold Serve is off.",
            );
        }
    };

    let mut caffold_url = None;
    let mut foreign_default_https_handler = false;
    for (host, value) in web {
        if !host.ends_with(":443") {
            continue;
        }
        let Some(entry) = value.as_object() else {
            return command_failed_status(
                TailscaleReason::ServeStatusResponseInvalid,
                "Tailscale returned an invalid Serve status response.",
            );
        };
        let Some(Value::Object(handlers)) = entry.get("Handlers") else {
            return command_failed_status(
                TailscaleReason::ServeStatusResponseInvalid,
                "Tailscale returned an invalid Serve status response.",
            );
        };
        for (path, handler) in handlers {
            let matches_target = path == "/"
                && handler
                    .as_object()
                    .and_then(|handler| handler.get("Proxy"))
                    .and_then(Value::as_str)
                    == Some(target);
            if matches_target {
                let Some(url) = canonical_tailnet_url(host) else {
                    return command_failed_status(
                        TailscaleReason::ServeStatusResponseInvalid,
                        "Tailscale returned an invalid Serve address.",
                    );
                };
                if caffold_url.as_ref().is_some_and(|current| current != &url) {
                    foreign_default_https_handler = true;
                }
                caffold_url = Some(url);
            } else {
                foreign_default_https_handler = true;
            }
        }
    }

    if foreign_default_https_handler {
        TailscaleStatus::new(
            TailscaleState::Unavailable,
            TailscaleReason::ServeTargetConflict,
            "Tailscale HTTPS port 443 is already assigned to a different Serve target.",
        )
    } else if let Some(url) = caffold_url {
        TailscaleStatus::ready(url)
    } else {
        TailscaleStatus::new(
            TailscaleState::ServeOff,
            TailscaleReason::ServeDisabled,
            "Tailscale is connected and Caffold Serve is off.",
        )
    }
}

fn canonical_tailnet_url(host: &str) -> Option<String> {
    let host = host.strip_suffix(":443")?;
    canonical_tailnet_url_value(&format!("https://{host}/"))
}

pub(super) fn canonical_tailnet_url_value(value: &str) -> Option<String> {
    if value.len() > MAX_TAILNET_URL_BYTES {
        return None;
    }
    let url = Url::parse(value).ok()?;
    let tailnet_host = url.host_str()?.to_ascii_lowercase();
    (url.scheme() == "https"
        && tailnet_host.ends_with(".ts.net")
        && tailnet_host.len() > ".ts.net".len()
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url.as_str() == value)
        .then(|| value.to_string())
}

pub(super) fn command_failed_status(
    reason_code: TailscaleReason,
    message: &'static str,
) -> TailscaleStatus {
    TailscaleStatus::new(TailscaleState::Failed, reason_code, message)
}

#[derive(Debug, Deserialize)]
pub(super) struct TailscaleNodeResponse {
    #[serde(rename = "BackendState")]
    pub(super) backend_state: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    const TARGET: &str = "http://127.0.0.1:5178";

    #[test]
    fn classifies_disabled_and_owned_serve_mappings() {
        let disabled = classify_serve_status(r#"{"Web":{}}"#, TARGET);
        assert_eq!(disabled.state, TailscaleState::ServeOff);
        assert_eq!(disabled.reason_code, TailscaleReason::ServeDisabled);

        let ready = classify_serve_status(&serve_status(TARGET), TARGET);
        assert_eq!(ready.state, TailscaleState::Ready);
        assert_eq!(ready.reason_code, TailscaleReason::ServeReady);
        assert_eq!(
            ready.tailnet_url.as_deref(),
            Some("https://studio.example.ts.net/")
        );
    }

    #[test]
    fn rejects_malformed_or_foreign_serve_mappings() {
        for body in ["not json", r#"{"Web":[]}"#] {
            let status = classify_serve_status(body, TARGET);
            assert_eq!(status.state, TailscaleState::Failed);
            assert_eq!(
                status.reason_code,
                TailscaleReason::ServeStatusResponseInvalid
            );
        }

        for body in [
            serve_status("http://127.0.0.1:9999"),
            r#"{"Web":{"studio.example.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:5178"},"/other":{"Proxy":"http://127.0.0.1:9999"}}}}}"#.to_string(),
            r#"{"Web":{"studio.example.ts.net:443":{"Handlers":{"/caffold":{"Proxy":"http://127.0.0.1:5178"}}}}}"#.to_string(),
        ] {
            let status = classify_serve_status(&body, TARGET);
            assert_eq!(status.state, TailscaleState::Unavailable);
            assert_eq!(status.reason_code, TailscaleReason::ServeTargetConflict);
        }

        let invalid_host = classify_serve_status(
            r#"{"Web":{"example.com:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:5178"}}}}}"#,
            TARGET,
        );
        assert_eq!(invalid_host.state, TailscaleState::Failed);
        assert_eq!(
            invalid_host.reason_code,
            TailscaleReason::ServeStatusResponseInvalid
        );
    }

    #[test]
    fn accepts_only_canonical_private_tailnet_urls() {
        assert_eq!(
            canonical_tailnet_url_value("https://studio.example.ts.net/"),
            Some("https://studio.example.ts.net/".to_string())
        );
        for invalid in [
            "http://studio.example.ts.net/",
            "https://example.com/",
            "https://studio.example.ts.net:8443/",
            "https://studio.example.ts.net/path",
            "https://studio.example.ts.net/?value=public",
            "https://STUDIO.example.ts.net/",
        ] {
            assert_eq!(canonical_tailnet_url_value(invalid), None, "{invalid}");
        }
        assert_eq!(canonical_tailnet_url_value(&"x".repeat(513)), None);
    }

    fn serve_status(target: &str) -> String {
        format!(
            r#"{{"Web":{{"studio.example.ts.net:443":{{"Handlers":{{"/":{{"Proxy":"{target}"}}}}}}}}}}"#
        )
    }
}
