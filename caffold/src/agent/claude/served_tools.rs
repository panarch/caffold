//! The tools Caffold serves the agent.
//!
//! An in-process MCP server, declared on every hello. The chatter —
//! handshake, discovery, notifications — is answered here, where it has one
//! true answer; a tool call is published for the application to do and to
//! answer back through [`ClaudeClient::answer_tool_ask`].

use std::sync::Arc;

use serde_json::{Value, json};

use super::{
    ClaudeClient, ClaudeError, ClaudeRuntimeEvent, ControlRequestFrame, Session, protocol,
};

/// One call of a Caffold-served tool, carrying everything answering it needs.
#[derive(Debug, Clone)]
pub(crate) struct ToolAsk {
    /// The control frame the answer closes.
    request_id: String,
    /// The MCP request inside it, echoed back in the answer.
    mcp_id: Value,
    pub(crate) asked: AskedTool,
}

/// The closed set of things an agent may ask Caffold to do.
///
/// A set rather than a name: like [`Driver`], a tool one release serves and
/// another does not should fail as a missing arm where the doing is, not pass
/// as a string.
#[derive(Debug, Clone)]
pub(crate) enum AskedTool {
    RenameTask { name: String },
}

impl ClaudeClient {
    /// Answer a tool the agent called, after the application did the thing —
    /// or could not.
    pub(crate) async fn answer_tool_ask(
        &self,
        conversation_id: &str,
        ask: &ToolAsk,
        outcome: &Result<String, String>,
    ) -> Result<(), ClaudeError> {
        let session = self.require_session(conversation_id).await?;
        session
            .send(protocol::mcp_tool_outcome(
                &ask.request_id,
                &ask.mcp_id,
                outcome,
            ))
            .await
    }

    /// Retitle the agent's own session, so the name Caffold keeps is also the
    /// name the agent's own surfaces show.
    pub(crate) async fn rename_conversation(
        &self,
        conversation_id: &str,
        title: &str,
    ) -> Result<(), ClaudeError> {
        let session = self.require_session(conversation_id).await?;
        session
            .control(protocol::rename_session_request(title))
            .await
            .map(|_| ())
    }

    /// One message for the MCP server Caffold hosts in this process.
    ///
    /// The chatter — handshake, discovery, notifications — is answered here,
    /// because it has one true answer and no meaning to anyone else. A tool
    /// call is the agent asking Caffold to do something, so it is published
    /// for the application to do and to answer through
    /// [`ClaudeClient::answer_tool_ask`].
    pub(super) async fn handle_mcp_message(
        &self,
        session: &Arc<Session>,
        frame: ControlRequestFrame,
    ) {
        let request_id = frame.request_id;
        if frame.request.server_name.as_deref() != Some(protocol::MCP_SERVER_NAME) {
            // A server Caffold never declared. There is nothing sensible to
            // say for it, only something to unblock.
            let _ = session
                .send(protocol::control_response(&request_id, json!({})))
                .await;
            return;
        }
        let message = frame.request.message;
        let method = message.get("method").and_then(Value::as_str);
        let mcp_id = message.get("id").cloned().unwrap_or(Value::Null);
        let (Some(method), false) = (method, mcp_id.is_null()) else {
            // A notification — or a reply, which a server is not sent — asks
            // for nothing back beyond the acknowledgement.
            let _ = session
                .send(protocol::mcp_notification_ack(&request_id))
                .await;
            return;
        };
        let answered = match method {
            "initialize" => protocol::mcp_result(
                &request_id,
                &mcp_id,
                protocol::mcp_initialize_result(&message),
            ),
            "tools/list" => {
                protocol::mcp_result(&request_id, &mcp_id, protocol::mcp_tool_listing())
            }
            "tools/call" => match tool_ask(&message, &request_id, &mcp_id) {
                Ok(ask) => {
                    self.publish(ClaudeRuntimeEvent::ToolAsked {
                        conversation_id: session.id.clone(),
                        ask,
                    });
                    return;
                }
                Err(trouble) => protocol::mcp_tool_outcome(&request_id, &mcp_id, &Err(trouble)),
            },
            method => protocol::mcp_method_refused(&request_id, &mcp_id, method),
        };
        let _ = session.send(answered).await;
    }
}

/// What a `tools/call` asks for, in Caffold's words.
///
/// The shape is checked here — a call to a tool Caffold serves, with the
/// arguments its schema promises — and what the ask means is judged where it
/// is done, by the application.
fn tool_ask(message: &Value, request_id: &str, mcp_id: &Value) -> Result<ToolAsk, String> {
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    let tool = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let asked = match tool {
        protocol::RENAME_CURRENT_TASK_TOOL_NAME => {
            let Some(name) = params
                .get("arguments")
                .and_then(|arguments| arguments.get("name"))
                .and_then(Value::as_str)
            else {
                return Err("The new task name must be a non-empty string.".to_string());
            };
            AskedTool::RenameTask {
                name: name.to_string(),
            }
        }
        tool => return Err(format!("Caffold does not serve the tool `{tool}`.")),
    };
    Ok(ToolAsk {
        request_id: request_id.to_string(),
        mcp_id: mcp_id.clone(),
        asked,
    })
}

#[cfg(test)]
mod tests {

    use serde_json::json;

    use super::super::test_support::*;
    use super::super::*;
    use super::*;

    fn mcp_frame(id: u64, method: &str, params: Value) -> Value {
        json!({
            "type": "control_request",
            "request_id": format!("agent-{id}"),
            "request": {
                "subtype": "mcp_message",
                "server_name": "caffold",
                "message": { "jsonrpc": "2.0", "id": id, "method": method, "params": params },
            },
        })
    }
    fn mcp_response_in(frame: &Value) -> &Value {
        &frame["response"]["response"]["mcp_response"]
    }

    #[tokio::test]
    async fn the_mcp_chatter_is_answered_where_it_arrives() {
        // Handshake and discovery have one true answer each; nothing should
        // wait on the application to give it.
        let (_client, runner, _events) = watching().await;

        runner
            .say(
                SESSION,
                mcp_frame(1, "initialize", json!({ "protocolVersion": "2031-01-01" })),
            )
            .await;
        let shaken = wrote(&runner, |frame| mcp_response_in(frame)["id"] == 1).await;
        let result = &mcp_response_in(&shaken)["result"];
        assert_eq!(result["protocolVersion"], "2031-01-01");
        assert_eq!(result["serverInfo"]["name"], "caffold");

        runner
            .say(SESSION, mcp_frame(2, "tools/list", json!({})))
            .await;
        let listed = wrote(&runner, |frame| mcp_response_in(frame)["id"] == 2).await;
        assert_eq!(
            mcp_response_in(&listed)["result"]["tools"][0]["name"],
            "rename_current_task"
        );
    }

    #[tokio::test]
    async fn a_tool_call_is_published_for_the_application_and_answered_through_the_client() {
        let (client, runner, mut events) = watching().await;

        runner
            .say(
                SESSION,
                mcp_frame(
                    3,
                    "tools/call",
                    json!({
                        "name": "rename_current_task",
                        "arguments": { "name": "A better name" },
                    }),
                ),
            )
            .await;
        let ask = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if let Ok(ClaudeRuntimeEvent::ToolAsked {
                    conversation_id,
                    ask,
                }) = events.recv().await
                {
                    assert_eq!(conversation_id, SESSION);
                    return ask;
                }
            }
        })
        .await
        .expect("the ask reaches the application");
        let AskedTool::RenameTask { name } = &ask.asked;
        assert_eq!(name, "A better name");

        client
            .answer_tool_ask(SESSION, &ask, &Ok("Renamed.".to_string()))
            .await
            .expect("the answer goes back");
        let answered = wrote(&runner, |frame| mcp_response_in(frame)["id"] == 3).await;
        let result = &mcp_response_in(&answered)["result"];
        assert_eq!(result["content"][0]["text"], "Renamed.");
        assert!(result.get("isError").is_none());
    }

    #[tokio::test]
    async fn a_tool_caffold_does_not_serve_is_refused_with_nobody_asked() {
        let (_client, runner, _events) = watching().await;

        runner
            .say(
                SESSION,
                mcp_frame(4, "tools/call", json!({ "name": "drop_all_tables" })),
            )
            .await;
        let refused = wrote(&runner, |frame| mcp_response_in(frame)["id"] == 4).await;
        let result = &mcp_response_in(&refused)["result"];
        assert_eq!(result["isError"], true);
        assert_eq!(
            result["content"][0]["text"],
            "Caffold does not serve the tool `drop_all_tables`."
        );
    }

    #[tokio::test]
    async fn an_mcp_notification_is_acknowledged_and_asks_nothing_of_anyone() {
        let (_client, runner, _events) = watching().await;

        runner
            .say(
                SESSION,
                json!({
                    "type": "control_request",
                    "request_id": "agent-10",
                    "request": {
                        "subtype": "mcp_message",
                        "server_name": "caffold",
                        "message": { "jsonrpc": "2.0", "method": "notifications/initialized" },
                    },
                }),
            )
            .await;
        let acknowledged = wrote(&runner, |frame| {
            frame["type"] == "control_response" && frame["response"]["request_id"] == "agent-10"
        })
        .await;
        assert_eq!(mcp_response_in(&acknowledged)["result"], json!({}));
    }

    #[tokio::test]
    async fn a_message_for_a_server_caffold_never_declared_is_unblocked_and_no_more() {
        let (_client, runner, _events) = watching().await;

        runner
            .say(
                SESSION,
                json!({
                    "type": "control_request",
                    "request_id": "agent-11",
                    "request": {
                        "subtype": "mcp_message",
                        "server_name": "somebody-else",
                        "message": { "jsonrpc": "2.0", "id": 11, "method": "tools/list" },
                    },
                }),
            )
            .await;
        let unblocked = wrote(&runner, |frame| {
            frame["type"] == "control_response" && frame["response"]["request_id"] == "agent-11"
        })
        .await;
        assert!(
            unblocked["response"]["response"]
                .get("mcp_response")
                .is_none(),
            "an undeclared server gets an unblocking nothing, not an answer"
        );
    }

    #[tokio::test]
    async fn renaming_the_agents_session_asks_the_agent_in_its_own_subtype() {
        let (client, runner, _events) = watching().await;

        client
            .rename_conversation(SESSION, "A better name")
            .await
            .expect("the agent accepts the title");

        let asked = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "rename_session")
            .expect("the title change is asked of the agent");
        assert_eq!(asked["request"]["title"], "A better name");
    }
}
