use std::{collections::BTreeMap, io::ErrorKind, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    time::{Instant, timeout},
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(500);

const INITIALIZE_ID: u64 = 1;
const ACCOUNT_ID: u64 = 2;
const RATE_LIMITS_ID: u64 = 3;
const USAGE_ID: u64 = 4;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatusResponse {
    pub available: bool,
    pub codex_cli_available: bool,
    pub app_server_available: bool,
    pub message: Option<String>,
    pub account: Option<CodexAccount>,
    pub requires_openai_auth: Option<bool>,
    pub rate_limits: Option<Value>,
    pub usage: Option<Value>,
    pub app_server: Option<CodexAppServerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAccount {
    #[serde(rename = "accountType", alias = "type")]
    pub account_type: String,
    pub email: Option<String>,
    pub plan_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerInfo {
    pub user_agent: Option<String>,
    pub codex_home: Option<String>,
    pub platform_family: Option<String>,
    pub platform_os: Option<String>,
}

pub async fn status() -> CodexStatusResponse {
    match read_app_server_status().await {
        Ok(responses) => status_from_responses(responses),
        Err(AppServerReadError::MissingCli) => unavailable(
            false,
            false,
            "Codex CLI is not available on this machine.".to_string(),
        ),
        Err(AppServerReadError::StartFailed(message)) => unavailable(true, false, message),
        Err(AppServerReadError::Protocol(message)) => unavailable(true, false, message),
    }
}

async fn read_app_server_status() -> Result<BTreeMap<u64, Value>, AppServerReadError> {
    let mut child = Command::new("codex")
        .arg("app-server")
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                AppServerReadError::MissingCli
            } else {
                AppServerReadError::StartFailed(format!(
                    "Failed to start Codex app-server: {error}"
                ))
            }
        })?;

    let mut stdin = child.stdin.take().ok_or_else(|| {
        AppServerReadError::Protocol("Failed to open Codex app-server stdin.".to_string())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppServerReadError::Protocol("Failed to open Codex app-server stdout.".to_string())
    })?;

    let messages = json_rpc_messages();
    stdin
        .write_all(messages.as_bytes())
        .await
        .map_err(|error| {
            AppServerReadError::Protocol(format!(
                "Failed to write Codex app-server request: {error}"
            ))
        })?;
    stdin.flush().await.map_err(|error| {
        AppServerReadError::Protocol(format!("Failed to flush Codex app-server request: {error}"))
    })?;

    let mut responses = BTreeMap::new();
    let mut lines = BufReader::new(stdout).lines();
    let deadline = Instant::now() + REQUEST_TIMEOUT;

    while !has_required_responses(&responses) {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }

        let line = match timeout(remaining, lines.next_line()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => break,
            Ok(Err(error)) => {
                return Err(AppServerReadError::Protocol(format!(
                    "Failed to read Codex app-server response: {error}"
                )));
            }
            Err(_) => break,
        };

        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = value.get("id").and_then(Value::as_u64) else {
            continue;
        };
        responses.insert(id, value);
    }

    drop(stdin);
    let _ = child.start_kill();
    let _ = timeout(SHUTDOWN_TIMEOUT, child.wait()).await;

    Ok(responses)
}

fn json_rpc_messages() -> String {
    [
        json!({
            "jsonrpc": "2.0",
            "id": INITIALIZE_ID,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "caffold",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true
                },
                "title": "Caffold"
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "method": "initialized",
            "params": {}
        }),
        json!({
            "jsonrpc": "2.0",
            "id": ACCOUNT_ID,
            "method": "account/read",
            "params": {
                "proactivelyRefreshToken": false
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "id": RATE_LIMITS_ID,
            "method": "account/rateLimits/read",
            "params": {}
        }),
        json!({
            "jsonrpc": "2.0",
            "id": USAGE_ID,
            "method": "account/usage/read",
            "params": {}
        }),
    ]
    .into_iter()
    .map(|value| value.to_string())
    .collect::<Vec<_>>()
    .join("\n")
        + "\n"
}

fn has_required_responses(responses: &BTreeMap<u64, Value>) -> bool {
    responses.contains_key(&INITIALIZE_ID)
        && responses.contains_key(&ACCOUNT_ID)
        && responses.contains_key(&RATE_LIMITS_ID)
        && responses.contains_key(&USAGE_ID)
}

fn status_from_responses(responses: BTreeMap<u64, Value>) -> CodexStatusResponse {
    let app_server = response_result(&responses, INITIALIZE_ID)
        .and_then(|value| serde_json::from_value::<CodexAppServerInfo>(value.clone()).ok());
    let account_result = response_result(&responses, ACCOUNT_ID);
    let account_error = response_error_message(&responses, ACCOUNT_ID);
    let app_server_available = app_server.is_some()
        || account_result.is_some()
        || account_error.is_some()
        || responses.contains_key(&ACCOUNT_ID);

    let Some(account_result) = account_result else {
        return CodexStatusResponse {
            available: false,
            codex_cli_available: true,
            app_server_available,
            message: Some(
                account_error.unwrap_or_else(|| {
                    "Codex app-server did not return account status.".to_string()
                }),
            ),
            account: None,
            requires_openai_auth: None,
            rate_limits: response_result(&responses, RATE_LIMITS_ID).map(compact_rate_limits),
            usage: response_result(&responses, USAGE_ID).map(compact_usage),
            app_server,
        };
    };

    let account = account_result
        .get("account")
        .and_then(|value| serde_json::from_value::<CodexAccount>(value.clone()).ok());
    let requires_openai_auth = account_result
        .get("requiresOpenaiAuth")
        .and_then(Value::as_bool);

    let Some(account) = account else {
        let message = if requires_openai_auth == Some(true) {
            "Codex authentication is required.".to_string()
        } else {
            "Codex app-server account response was incomplete.".to_string()
        };

        return CodexStatusResponse {
            available: false,
            codex_cli_available: true,
            app_server_available,
            message: Some(message),
            account: None,
            requires_openai_auth,
            rate_limits: response_result(&responses, RATE_LIMITS_ID).map(compact_rate_limits),
            usage: response_result(&responses, USAGE_ID).map(compact_usage),
            app_server,
        };
    };

    CodexStatusResponse {
        available: true,
        codex_cli_available: true,
        app_server_available,
        message: None,
        account: Some(account),
        requires_openai_auth,
        rate_limits: response_result(&responses, RATE_LIMITS_ID).map(compact_rate_limits),
        usage: response_result(&responses, USAGE_ID).map(compact_usage),
        app_server,
    }
}

fn response_result(responses: &BTreeMap<u64, Value>, id: u64) -> Option<&Value> {
    responses.get(&id)?.get("result")
}

fn response_error_message(responses: &BTreeMap<u64, Value>, id: u64) -> Option<String> {
    responses
        .get(&id)?
        .get("error")?
        .get("message")?
        .as_str()
        .map(ToOwned::to_owned)
}

fn compact_rate_limits(value: &Value) -> Value {
    let mut object = serde_json::Map::new();
    if let Some(rate_limit_reset_credits) = value.get("rateLimitResetCredits") {
        object.insert(
            "rateLimitResetCredits".to_string(),
            rate_limit_reset_credits.clone(),
        );
    }
    if let Some(rate_limits) = value.get("rateLimits") {
        object.insert("rateLimits".to_string(), rate_limits.clone());
    }

    if object.is_empty() {
        value.clone()
    } else {
        Value::Object(object)
    }
}

fn compact_usage(value: &Value) -> Value {
    match value.get("summary") {
        Some(summary) => json!({ "summary": summary }),
        None => value.clone(),
    }
}

fn unavailable(
    codex_cli_available: bool,
    app_server_available: bool,
    message: String,
) -> CodexStatusResponse {
    CodexStatusResponse {
        available: false,
        codex_cli_available,
        app_server_available,
        message: Some(message),
        account: None,
        requires_openai_auth: None,
        rate_limits: None,
        usage: None,
        app_server: None,
    }
}

#[derive(Debug)]
enum AppServerReadError {
    MissingCli,
    StartFailed(String),
    Protocol(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_available_status_from_account_response() {
        let status = status_from_responses(responses([
            (
                INITIALIZE_ID,
                json!({
                    "id": INITIALIZE_ID,
                    "result": {
                        "userAgent": "Codex Desktop/0.142.3",
                        "codexHome": "/Users/example/.codex",
                        "platformFamily": "unix",
                        "platformOs": "macos"
                    }
                }),
            ),
            (
                ACCOUNT_ID,
                json!({
                    "id": ACCOUNT_ID,
                    "result": {
                        "account": {
                            "type": "chatgpt",
                            "email": "user@example.com",
                            "planType": "pro"
                        },
                        "requiresOpenaiAuth": true
                    }
                }),
            ),
            (
                RATE_LIMITS_ID,
                json!({
                    "id": RATE_LIMITS_ID,
                    "result": {
                        "rateLimits": {
                            "primary": {
                                "usedPercent": 42
                            }
                        }
                    }
                }),
            ),
            (
                USAGE_ID,
                json!({
                    "id": USAGE_ID,
                    "result": {
                        "dailyUsageBuckets": [
                            {
                                "startDate": "2026-07-02",
                                "tokens": 777
                            }
                        ],
                        "summary": {
                            "lifetimeTokens": 123456
                        }
                    }
                }),
            ),
        ]));

        assert!(status.available);
        assert!(status.codex_cli_available);
        assert!(status.app_server_available);
        assert_eq!(status.message, None);
        assert_eq!(
            status.account,
            Some(CodexAccount {
                account_type: "chatgpt".to_string(),
                email: Some("user@example.com".to_string()),
                plan_type: Some("pro".to_string()),
            })
        );
        assert_eq!(status.requires_openai_auth, Some(true));
        assert_eq!(
            status
                .rate_limits
                .as_ref()
                .and_then(|value| value.pointer("/rateLimits/primary/usedPercent"))
                .and_then(Value::as_u64),
            Some(42)
        );
        assert_eq!(
            status
                .usage
                .as_ref()
                .and_then(|value| value.pointer("/summary/lifetimeTokens"))
                .and_then(Value::as_u64),
            Some(123456)
        );
        assert!(
            status
                .usage
                .as_ref()
                .and_then(|value| value.get("dailyUsageBuckets"))
                .is_none()
        );
    }

    #[test]
    fn keeps_account_available_when_usage_details_are_missing() {
        let status = status_from_responses(responses([(
            ACCOUNT_ID,
            json!({
                "id": ACCOUNT_ID,
                "result": {
                    "account": {
                        "type": "apiKey"
                    },
                    "requiresOpenaiAuth": false
                }
            }),
        )]));

        assert!(status.available);
        assert!(status.app_server_available);
        assert_eq!(
            status.account,
            Some(CodexAccount {
                account_type: "apiKey".to_string(),
                email: None,
                plan_type: None,
            })
        );
        assert_eq!(status.rate_limits, None);
        assert_eq!(status.usage, None);
    }

    #[test]
    fn maps_account_error_to_unavailable_status() {
        let status = status_from_responses(responses([(
            ACCOUNT_ID,
            json!({
                "id": ACCOUNT_ID,
                "error": {
                    "code": -32000,
                    "message": "not authenticated"
                }
            }),
        )]));

        assert!(!status.available);
        assert!(status.codex_cli_available);
        assert!(status.app_server_available);
        assert_eq!(status.message, Some("not authenticated".to_string()));
        assert_eq!(status.account, None);
    }

    fn responses<const N: usize>(entries: [(u64, Value); N]) -> BTreeMap<u64, Value> {
        entries.into_iter().collect()
    }
}
