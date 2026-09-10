//! Codex's empty-form MCP tool approval, expressed as a Caffold approval.

use std::collections::HashSet;

use serde_json::{Value, json};

use super::text_field;
use crate::agent::{
    ApprovalArgument, ApprovalDecision, ApprovalDetail, ApprovalRequest, ApprovalToolDetail,
};

pub(super) fn request(id: String, params: &Value) -> ApprovalRequest {
    let meta = &params["_meta"];
    ApprovalRequest {
        id,
        turn_id: text_field(params, "turnId"),
        item_id: None,
        title: text_field(meta, "tool_title")
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| "Tool approval requested".to_string()),
        reason: text_field(params, "message"),
        detail: ApprovalDetail {
            tool: Some(ApprovalToolDetail {
                server_name: text_field(params, "serverName").unwrap_or_default(),
                app_name: text_field(meta, "connector_name"),
                description: text_field(meta, "tool_description"),
                arguments: arguments(meta),
            }),
            ..ApprovalDetail::default()
        },
        decisions: decisions(params),
    }
}

pub(super) fn decisions(params: &Value) -> Vec<ApprovalDecision> {
    let mut offered = vec![ApprovalDecision::Allow];
    for (scope, decision) in [
        ("session", ApprovalDecision::AllowForSession),
        ("always", ApprovalDecision::AllowAlways),
    ] {
        let persist = &params["_meta"]["persist"];
        if persist.as_str() == Some(scope)
            || persist
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(scope)))
        {
            offered.push(decision);
        }
    }
    offered.extend([ApprovalDecision::Deny, ApprovalDecision::Cancel]);
    offered
}

pub(super) fn response(params: &Value, decision: ApprovalDecision) -> Option<Value> {
    if !decisions(params).contains(&decision) {
        return None;
    }
    Some(match decision {
        ApprovalDecision::Allow => json!({ "action": "accept", "content": {} }),
        ApprovalDecision::AllowForSession => json!({
            "action": "accept", "content": {}, "_meta": { "persist": "session" },
        }),
        ApprovalDecision::AllowAlways => json!({
            "action": "accept", "content": {}, "_meta": { "persist": "always" },
        }),
        ApprovalDecision::Deny => json!({ "action": "decline", "content": null }),
        ApprovalDecision::Cancel => json!({ "action": "cancel", "content": null }),
        ApprovalDecision::DenyAndStop => return None,
    })
}

/// Display metadata may name and order arguments, but cannot replace their values.
fn arguments(meta: &Value) -> Vec<ApprovalArgument> {
    let Some(params) = meta.get("tool_params") else {
        return Vec::new();
    };
    let Some(object) = params.as_object() else {
        return vec![ApprovalArgument {
            name: "arguments".to_string(),
            label: "Arguments".to_string(),
            value: params.clone(),
        }];
    };
    let mut rows = Vec::new();
    let mut shown = HashSet::new();
    if let Some(display) = meta.get("tool_params_display").and_then(Value::as_array) {
        for field in display {
            let Some(name) = field.get("name").and_then(Value::as_str) else {
                continue;
            };
            let Some(value) = object.get(name) else {
                continue;
            };
            if !shown.insert(name) {
                continue;
            }
            rows.push(ApprovalArgument {
                name: name.to_string(),
                label: text_field(field, "display_name")
                    .filter(|label| !label.trim().is_empty())
                    .unwrap_or_else(|| name.to_string()),
                value: value.clone(),
            });
        }
    }
    for (name, value) in object {
        if shown.insert(name) {
            rows.push(ApprovalArgument {
                name: name.clone(),
                label: name.clone(),
                value: value.clone(),
            });
        }
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_approval_scopes_are_offered_once_and_never_invented() {
        for (persist, scopes) in [
            (Value::Null, vec![]),
            (json!("session"), vec![ApprovalDecision::AllowForSession]),
            (json!("always"), vec![ApprovalDecision::AllowAlways]),
            (
                json!(["always", "session", "session", "future"]),
                vec![
                    ApprovalDecision::AllowForSession,
                    ApprovalDecision::AllowAlways,
                ],
            ),
            (json!("future"), vec![]),
        ] {
            let params = json!({ "_meta": { "persist": persist } });
            let mut expected = vec![ApprovalDecision::Allow];
            expected.extend(scopes);
            expected.extend([ApprovalDecision::Deny, ApprovalDecision::Cancel]);
            assert_eq!(decisions(&params), expected);
            assert!(response(&params, ApprovalDecision::DenyAndStop).is_none());
        }
        assert!(response(&json!({}), ApprovalDecision::AllowAlways).is_none());
        assert!(response(&json!({}), ApprovalDecision::AllowForSession).is_none());
    }

    #[test]
    fn mcp_approval_replies_preserve_scope_and_cancellation() {
        let params = json!({ "_meta": { "persist": ["session", "always"] } });
        for (decision, expected) in [
            (
                ApprovalDecision::Allow,
                json!({"action":"accept","content":{}}),
            ),
            (
                ApprovalDecision::AllowForSession,
                json!({"action":"accept","content":{},"_meta":{"persist":"session"}}),
            ),
            (
                ApprovalDecision::AllowAlways,
                json!({"action":"accept","content":{},"_meta":{"persist":"always"}}),
            ),
            (
                ApprovalDecision::Deny,
                json!({"action":"decline","content":null}),
            ),
            (
                ApprovalDecision::Cancel,
                json!({"action":"cancel","content":null}),
            ),
        ] {
            assert_eq!(response(&params, decision), Some(expected));
        }
    }

    #[test]
    fn mcp_approval_display_metadata_cannot_hide_or_replace_arguments() {
        let params = json!({
            "serverName": "docs", "turnId": null, "itemId": "not-a-protocol-item",
            "message": "Allow reading this document?",
            "_meta": {
                "tool_title": "Read document", "connector_name": "Documents",
                "tool_description": "Read a document's content.",
                "tool_params": { "document": {"id": 42}, "include_comments": false },
                "tool_params_display": [
                    {"name":"document","display_name":"Document","value":"different"},
                    {"name":"document","display_name":"Duplicate"},
                    {"name":"missing","value":"invented"}, null
                ]
            }
        });
        let normalized = request("approval-1".to_string(), &params);
        assert_eq!(normalized.title, "Read document");
        assert_eq!(
            normalized.reason.as_deref(),
            Some("Allow reading this document?")
        );
        assert_eq!(normalized.turn_id, None);
        assert_eq!(normalized.item_id, None);
        let tool = normalized.detail.tool.unwrap();
        assert_eq!(tool.server_name, "docs");
        assert_eq!(tool.app_name.as_deref(), Some("Documents"));
        assert_eq!(
            tool.description.as_deref(),
            Some("Read a document's content.")
        );
        assert_eq!(
            tool.arguments,
            vec![
                ApprovalArgument {
                    name: "document".into(),
                    label: "Document".into(),
                    value: json!({"id":42})
                },
                ApprovalArgument {
                    name: "include_comments".into(),
                    label: "include_comments".into(),
                    value: json!(false)
                },
            ]
        );
    }

    #[test]
    fn mcp_approval_optional_details_and_non_object_values_are_preserved() {
        let request = request(
            "1".into(),
            &json!({"serverName":"docs","message":"Allow?","_meta":{"tool_title":" "}}),
        );
        assert_eq!(request.title, "Tool approval requested");
        assert!(request.detail.tool.unwrap().arguments.is_empty());
        for value in [json!(null), json!([1, true]), json!("text"), json!(42)] {
            let rows = arguments(&json!({"tool_params":value}));
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].value, value);
        }
        let rows = arguments(
            &json!({"tool_params":{"a":null},"tool_params_display":[{"name":"a","display_name":" "}]}),
        );
        assert_eq!(rows[0].label, "a");
        assert_eq!(rows[0].value, Value::Null);
    }
    /// The installed harness must ask before executing this test-owned tool.
    /// This exercises actual provider metadata as well as the production decoder
    /// and response writer. It makes one authenticated model request.
    #[tokio::test]
    #[ignore = "requires an authenticated Codex CLI and makes a real model request"]
    async fn live_codex_mcp_tool_approval_uses_normalized_contract() {
        use crate::agent::codex::{
            CodexDaemonInfo, CodexNotification, CodexRuntimeEvent, CodexServerRequest,
            CodexThreadClient, inspect_codex_installation, protocol::TurnStatus,
            reconnect_spike::SocketAppServer,
        };
        use anyhow::{Context, bail, ensure};
        use std::time::Duration;

        let installation = inspect_codex_installation()
            .await
            .expect("installed Codex CLI");
        let temp = tempfile::tempdir().unwrap();
        let script = temp.path().join("approval_probe.py");
        let called = temp.path().join("called");
        std::fs::write(&script, r#"import json, pathlib, sys
for line in sys.stdin:
    request = json.loads(line)
    if 'id' not in request:
        continue
    method = request['method']
    if method == 'initialize':
        result = {'protocolVersion':request['params']['protocolVersion'], 'capabilities':{'tools':{}}, 'serverInfo':{'name':'approval-probe','version':'1'}}
    elif method == 'tools/list':
        result = {'tools':[{'name':'read_probe','description':'Harmless approval test: returns a fixed marker.', 'inputSchema':{'type':'object','properties':{},'additionalProperties':False},'annotations':{'readOnlyHint':True,'destructiveHint':False,'openWorldHint':False}}]}
    elif method == 'tools/call':
        pathlib.Path(sys.argv[1]).write_text('called')
        result = {'content':[{'type':'text','text':'CAFFOLD_APPROVAL_PROBE_OK'}]}
    else:
        result = {}
    print(json.dumps({'jsonrpc':'2.0','id':request['id'],'result':result}), flush=True)
"#).unwrap();
        let mut server = SocketAppServer::start().await.expect("isolated app-server");
        let result: anyhow::Result<()> = async {
            let client = CodexThreadClient::start_with_proxy(
                &installation.path, Some(&server.socket_path), CodexDaemonInfo {
                    status:"isolatedTestRuntime".into(),backend:None,pid:None,
                    managed_codex_path:None,managed_codex_version:None,
                    socket_path:Some(server.socket_path.display().to_string()),cli_version:None,app_server_version:None,
                }, None,
            ).await?;
            let mut events = client.subscribe();
            let started = client.request_value("thread/start", json!({
                "cwd":temp.path(), "ephemeral":true, "approvalPolicy":"on-request", "approvalsReviewer":"user",
                "sandbox":"workspace-write", "model":"gpt-5.6-sol",
                "config": {
                    "features.tool_call_mcp_elicitation":true,
                    "mcp_servers.caffold_approval_probe":{
                        "command":"/usr/bin/python3", "args":[script,called],
                        "default_tools_approval_mode":"prompt",
                    },
                },
            })).await?;
            let thread_id = started["thread"]["id"].as_str().context("created thread id")?;
            client.request_value("turn/start",json!({
                "threadId":thread_id, "effort":"low",
                "input":[{"type":"text","text":"Call the caffold_approval_probe read_probe MCP tool exactly once. Use only that tool, which returns a harmless fixed marker. Do not use shell commands or other tools. After its result, reply with CAFFOLD_APPROVAL_PROBE_OK.","text_elements":[]}],
            })).await?;
            let verification = tokio::time::timeout(Duration::from_secs(120), async {
                let mut approved = false;
                loop {
                    match events.recv().await? {
                        CodexRuntimeEvent::ServerRequest(CodexServerRequest::McpToolApproval {id,params,..}) => {
                            ensure!(!approved, "the test tool requested approval twice");
                            ensure!(!called.exists(), "tool executed before approval");
                            let normalized = request(id.to_string(), &params);
                            ensure!(normalized.detail.tool.as_ref().is_some_and(|tool| tool.server_name == "caffold_approval_probe"), "approval belongs to the test tool");
                            eprintln!("Live MCP approval choices: {:?}", normalized.decisions);
                            let reply = response(&params, ApprovalDecision::Allow).context("allow offered")?;
                            client.respond_to_server_request(id, reply).await?;
                            approved = true;
                        }
                        CodexRuntimeEvent::ServerRequest(other) => bail!("unexpected request: {other:?}"),
                        CodexRuntimeEvent::Notification(CodexNotification::TurnCompleted {turn,..}) => {
                            ensure!(approved, "turn finished without MCP approval");
                            ensure!(called.exists(), "tool did not execute after approval");
                            ensure!(turn.status == TurnStatus::Completed, "turn failed: {:?}", turn.error);
                            return Ok::<_,anyhow::Error>(());
                        }
                        CodexRuntimeEvent::Error {message} => bail!("{message}"),
                        _ => {}
                    }
                }
            }).await.context("MCP approval round trip timed out")?;
            client.shutdown().await;
            verification
        }.await;
        server.stop().await;
        result.expect("live MCP tool approval round trip");
    }
}
