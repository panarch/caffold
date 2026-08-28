use serde::{Deserialize, Serialize};

pub(crate) const MCP_SERVER_STATUS_LIST: &str = "mcpServerStatus/list";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CodexMcpServerDiagnostic {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) runtime_status: Option<CodexMcpRuntimeStatus>,
    pub(crate) auth_status: CodexMcpAuthStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CodexMcpRuntimeStatus {
    NotStarted,
    Starting,
    Connected,
    AuthenticationRequired,
    Failed,
    Cancelled,
    Disabled,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CodexMcpAuthStatus {
    Unsupported,
    NotLoggedIn,
    BearerToken,
    #[serde(rename = "oAuth")]
    OAuth,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerStatusListResponse {
    #[serde(default)]
    pub(crate) data: Vec<CodexMcpServerDiagnostic>,
    #[serde(default)]
    pub(crate) next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerStatusListParams<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
    limit: usize,
    detail: &'static str,
    thread_id: &'a str,
}

pub(crate) fn mcp_server_status_list_params<'a>(
    thread_id: &'a str,
    cursor: Option<&'a str>,
    limit: usize,
) -> McpServerStatusListParams<'a> {
    McpServerStatusListParams {
        cursor,
        limit,
        detail: "toolsAndAuthOnly",
        thread_id,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn minimum_and_current_mcp_status_shapes_decode_to_safe_diagnostics() {
        let minimum: McpServerStatusListResponse = serde_json::from_value(json!({
            "data": [{
                "name": "caffold",
                "serverInfo": null,
                "tools": {},
                "resources": [],
                "resourceTemplates": [],
                "authStatus": "unsupported"
            }],
            "nextCursor": null
        }))
        .expect("Codex 0.147 MCP status response");
        assert_eq!(minimum.data[0].runtime_status, None);
        assert_eq!(minimum.data[0].auth_status, CodexMcpAuthStatus::Unsupported);

        let current: McpServerStatusListResponse = serde_json::from_value(json!({
            "data": [{
                "name": "remote-tools",
                "runtimeStatus": "authenticationRequired",
                "pluginId": "private-plugin",
                "serverInfo": { "name": "private", "version": "1" },
                "tools": { "secret-tool": { "name": "secret-tool" } },
                "resources": [{ "uri": "https://private.example/resource" }],
                "resourceTemplates": [],
                "authStatus": "oAuth"
            }],
            "nextCursor": "next"
        }))
        .expect("Codex 0.150 MCP status response");
        assert_eq!(
            current.data,
            [CodexMcpServerDiagnostic {
                name: "remote-tools".to_string(),
                runtime_status: Some(CodexMcpRuntimeStatus::AuthenticationRequired),
                auth_status: CodexMcpAuthStatus::OAuth,
            }]
        );
        assert_eq!(current.next_cursor.as_deref(), Some("next"));
        let projected = serde_json::to_value(&current.data[0]).expect("safe diagnostic JSON");
        assert_eq!(
            projected,
            json!({
                "name": "remote-tools",
                "runtimeStatus": "authenticationRequired",
                "authStatus": "oAuth"
            })
        );
    }

    #[test]
    fn future_mcp_status_values_degrade_to_unknown() {
        let response: McpServerStatusListResponse = serde_json::from_value(json!({
            "data": [{
                "name": "future",
                "runtimeStatus": "pausedByPolicy",
                "authStatus": "deviceCode"
            }],
            "nextCursor": null
        }))
        .expect("future optional statuses remain diagnostic");

        assert_eq!(
            serde_json::to_value(&response.data[0]).unwrap(),
            json!({
                "name": "future",
                "runtimeStatus": "unknown",
                "authStatus": "unknown"
            })
        );
    }

    #[test]
    fn diagnostic_status_params_request_only_tools_and_auth_inventory() {
        let first = serde_json::to_value(mcp_server_status_list_params("thread-1", None, 100))
            .expect("first page params");
        assert_eq!(
            first,
            json!({
                "limit": 100,
                "detail": "toolsAndAuthOnly",
                "threadId": "thread-1"
            })
        );

        let next = serde_json::to_value(mcp_server_status_list_params(
            "thread-1",
            Some("cursor-2"),
            100,
        ))
        .expect("next page params");
        assert_eq!(next["cursor"], Value::String("cursor-2".to_string()));
    }
}
