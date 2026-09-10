//! Redirect a received structured question without supplying a user's answer.

use serde_json::{Value, json};

use super::protocol::THREAD_INJECT_ITEMS;
use super::{CodexThreadClient, CodexThreadError, protocol::EmptyResponse};
use crate::agent::CAFFOLD_CLARIFICATION_FEEDBACK;

impl CodexThreadClient {
    /// The model must receive host-authored guidance before its tool resumes.
    /// A requestUserInput RPC error alone loses its message inside app-server.
    /// Injecting a developer item preserves authorship; the empty answers map
    /// settles the original request without inventing a choice for any question.
    pub(crate) async fn redirect_user_input(
        &self,
        request_id: Value,
        params: &Value,
    ) -> Result<(), CodexThreadError> {
        let feedback = async {
            let params = feedback_params(&request_id, params)?;
            self.request_typed::<EmptyResponse, _>(THREAD_INJECT_ITEMS, params)
                .await
        }
        .await;
        if let Err(error) = feedback {
            let reason = format!("Caffold could not deliver clarification guidance: {error}");
            self.reject_server_request(request_id, &reason)
                .await
                .map_err(|settlement| {
                    CodexThreadError::Protocol(format!(
                        "{reason}; could not settle the clarification request: {settlement}"
                    ))
                })?;
            return Err(error);
        }
        self.respond_to_server_request(request_id, json!({ "answers": {} }))
            .await
    }
}

fn feedback_params(request_id: &Value, params: &Value) -> Result<Value, CodexThreadError> {
    if !(request_id.is_string() || request_id.is_i64() || request_id.is_u64()) {
        return Err(CodexThreadError::Protocol(
            "requestUserInput did not include a valid JSON-RPC request id".to_string(),
        ));
    }
    let thread_id = params
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| {
            CodexThreadError::Protocol("requestUserInput did not include threadId".to_string())
        })?;
    Ok(json!({
        "threadId": thread_id,
        "items": [{
            "type": "message",
            "role": "developer",
            "content": [{"type": "input_text", "text": CAFFOLD_CLARIFICATION_FEEDBACK}],
        }],
    }))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;
    use crate::agent::codex::MockCodexResponse;

    #[tokio::test]
    async fn clarification_feedback_is_acknowledged_before_resuming_without_user_answers() {
        let (response, release) = MockCodexResponse::gated_ok(THREAD_INJECT_ITEMS, json!({}));
        let client = CodexThreadClient::mock(vec![response]);
        let redirect = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .redirect_user_input(
                        json!("request-7"),
                        &json!({ "threadId": "thread_1", "questions": [{"id":"choice"}] }),
                    )
                    .await
            }
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while client.mock_requests().await.is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("feedback injection started");
        assert!(client.mock_server_responses().await.is_empty());
        assert_eq!(
            client.mock_requests().await,
            vec![(
                THREAD_INJECT_ITEMS.to_string(),
                json!({
                    "threadId": "thread_1",
                    "items": [{"type":"message","role":"developer","content":[{
                        "type":"input_text", "text":CAFFOLD_CLARIFICATION_FEEDBACK
                    }]}]
                }),
            )]
        );
        release.send(()).unwrap();
        redirect.await.unwrap().unwrap();
        assert_eq!(
            client.mock_server_responses().await,
            vec![(json!("request-7"), json!({"answers":{}}))]
        );
        assert!(client.mock_server_errors().await.is_empty());
    }

    #[tokio::test]
    async fn clarification_injection_failure_settles_the_request_without_claiming_feedback() {
        let client = CodexThreadClient::mock(vec![MockCodexResponse::error(
            THREAD_INJECT_ITEMS,
            CodexThreadError::Protocol("injection refused".to_string()),
        )]);
        let error = client
            .redirect_user_input(json!(9), &json!({"threadId":"thread_1"}))
            .await
            .unwrap_err();
        assert!(error.to_string().contains("injection refused"));
        assert!(client.mock_server_responses().await.is_empty());
        let errors = client.mock_server_errors().await;
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0]["id"], 9);
        assert!(
            errors[0]["error"]["message"]
                .as_str()
                .unwrap()
                .contains("could not deliver")
        );
    }

    #[tokio::test]
    async fn clarification_invalid_identifiers_are_settled_without_injecting() {
        for (id, params) in [
            (Value::Null, json!({"threadId":"thread_1"})),
            (json!(1.5), json!({"threadId":"thread_1"})),
            (json!("id"), json!({})),
            (json!("id"), json!({"threadId":42})),
            (json!("id"), json!({"threadId":"  "})),
        ] {
            let client = CodexThreadClient::mock(Vec::new());
            assert!(client.redirect_user_input(id, &params).await.is_err());
            assert!(client.mock_requests().await.is_empty());
            assert!(client.mock_server_responses().await.is_empty());
            assert_eq!(client.mock_server_errors().await.len(), 1);
        }
    }

    #[tokio::test]
    async fn clarification_response_failure_is_reported_without_resending_feedback() {
        let client =
            CodexThreadClient::mock(vec![MockCodexResponse::ok(THREAD_INJECT_ITEMS, json!({}))]);
        let (_, release) = client
            .mock_server_reply(Err(CodexThreadError::ProcessUnavailable))
            .await;
        release.send(()).unwrap();
        assert!(matches!(
            client
                .redirect_user_input(json!(11), &json!({"threadId":"thread_1"}))
                .await,
            Err(CodexThreadError::ProcessUnavailable)
        ));
        assert_eq!(client.mock_requests().await.len(), 1);
        assert!(client.mock_server_responses().await.is_empty());
    }

    /// Exercise the real model continuation: an RPC error by itself cannot
    /// prove that app-server delivered host feedback to request_user_input.
    #[tokio::test]
    #[ignore = "requires an authenticated Codex CLI and spends model usage"]
    async fn live_codex_clarification_returns_to_chat_and_accepts_a_reply() {
        use crate::agent::codex::{
            CodexDaemonInfo, CodexNotification, CodexRuntimeEvent, CodexServerRequest,
            inspect_codex_installation, protocol::TurnStatus, reconnect_spike::SocketAppServer,
        };
        use anyhow::{Context, bail, ensure};

        let installation = inspect_codex_installation().await.unwrap();
        let temp = tempfile::tempdir().unwrap();
        let mut server = SocketAppServer::start().await.unwrap();
        let result: anyhow::Result<()> = async {
            let client = CodexThreadClient::start_with_proxy(
                &installation.path, Some(&server.socket_path), CodexDaemonInfo {
                    status: "isolatedTestRuntime".into(), backend: None, pid: None,
                    managed_codex_path: None, managed_codex_version: None,
                    socket_path: Some(server.socket_path.display().to_string()),
                    cli_version: None, app_server_version: None,
                }, None,
            ).await?;
            let verification = tokio::time::timeout(Duration::from_secs(180), async {
                let mut events = client.subscribe();
                let started = client.request_value("thread/start", json!({
                    "cwd": temp.path(), "ephemeral": true, "model": "gpt-5.6-sol",
                    "approvalPolicy": "on-request", "sandbox": "workspace-write",
                    "config": {"features.default_mode_request_user_input": true},
                })).await?;
                let thread_id = started["thread"]["id"].as_str().context("thread id")?;
                client.request_value("turn/start", json!({
                    "threadId": thread_id, "effort": "low",
                    "input": [{"type":"text", "text_elements":[], "text":
                        "Use request_user_input exactly once to ask whether my report should prioritize speed or detail. Do not use request_user_input_async or any other tool. After the tool response, continue according to the response you received."
                    }],
                })).await?;
                let mut redirects = 0;
                let mut chat = String::new();
                loop {
                    match events.recv().await? {
                        CodexRuntimeEvent::ServerRequest(CodexServerRequest::UserInput {id, params}) => {
                            redirects += 1;
                            ensure!(redirects == 1, "the model repeated the structured question");
                            client.redirect_user_input(id, &params).await?;
                        }
                        CodexRuntimeEvent::ServerRequest(other) => bail!("unexpected request: {other:?}"),
                        CodexRuntimeEvent::Notification(CodexNotification::ItemCompleted {item, ..})
                            if item["type"] == "agentMessage" && redirects > 0 => {
                                chat.push_str(item["text"].as_str().unwrap_or_default());
                            }
                        CodexRuntimeEvent::Notification(CodexNotification::TurnCompleted {turn, ..}) => {
                            ensure!(turn.status == TurnStatus::Completed, "turn failed: {:?}", turn.error);
                            break;
                        }
                        CodexRuntimeEvent::Error {message} => bail!("{message}"),
                        _ => {}
                    }
                }
                eprintln!("Codex chat after automatic clarification feedback: {chat}");
                ensure!(redirects == 1, "no structured request reached the adapter");
                ensure!(chat.contains('?') && chat.to_lowercase().contains("speed")
                    && chat.to_lowercase().contains("detail"), "no chat question after feedback: {chat}");

                client.request_value("turn/start", json!({
                    "threadId": thread_id, "effort": "low",
                    "input": [{"type":"text", "text_elements":[], "text":
                        "I choose detail. Acknowledge my choice by replying exactly DETAILED_REPORT_CONFIRMED. Do not use tools."
                    }],
                })).await?;
                let mut answer = String::new();
                loop {
                    match events.recv().await? {
                        CodexRuntimeEvent::Notification(CodexNotification::ItemCompleted {item, ..})
                            if item["type"] == "agentMessage" => {
                                answer.push_str(item["text"].as_str().unwrap_or_default());
                            }
                        CodexRuntimeEvent::Notification(CodexNotification::TurnCompleted {turn, ..}) => {
                            ensure!(turn.status == TurnStatus::Completed, "reply failed: {:?}", turn.error);
                            ensure!(answer.contains("DETAILED_REPORT_CONFIRMED"), "reply not acknowledged: {answer}");
                            return Ok::<_, anyhow::Error>(());
                        }
                        CodexRuntimeEvent::ServerRequest(other) => bail!("unexpected request after reply: {other:?}"),
                        CodexRuntimeEvent::Error {message} => bail!("{message}"),
                        _ => {}
                    }
                }
            }).await.context("clarification round trip timed out");
            client.shutdown().await;
            verification?
        }.await;
        server.stop().await;
        result.expect("live Codex clarification round trip");
    }
}
