//! Original ACP request identities and the exact choices advertised on them.
use super::*;
use crate::agent::{
    ApprovalArgument, ApprovalDetail, ApprovalToolDetail, CAFFOLD_CLARIFICATION_FEEDBACK,
};

pub(super) fn approval_id(incarnation: &str, key: &str) -> String {
    format!("antigravity:{incarnation}:{key}")
}

impl Session {
    pub(super) async fn incoming(
        &self,
        method: &str,
        frame: Value,
    ) -> Result<(), AntigravityError> {
        let id: RpcId = serde_json::from_value(frame["id"].clone())
            .map_err(|e| AntigravityError::Protocol(e.to_string()))?;
        if method != "session/request_permission" {
            return self
                .reply_error(
                    &id,
                    -32601,
                    "Caffold does not implement this ACP client method",
                )
                .await;
        }
        let params = frame
            .get("params")
            .ok_or_else(|| AntigravityError::Protocol("permission request has no params".into()))?;
        let native = protocol::required_string(params, "sessionId")?;
        {
            let state = self.state.lock().await;
            if state
                .checkpoint
                .binding
                .as_ref()
                .is_none_or(|binding| binding.native_id != native)
            {
                return Err(AntigravityError::Protocol(
                    "permission request belongs to another native session".into(),
                ));
            }
        }
        let tool = protocol::required_string(&params["toolCall"], "toolCallId")?;
        // The native question callback uses this reserved tool-call ID.
        // Titles, labels and prompt text never classify a permission request.
        if is_question(tool) {
            return self
                .reply_error(&id, -32601, CAFFOLD_CLARIFICATION_FEEDBACK)
                .await;
        }
        let mut state = self.state.lock().await;
        state.checkpoint.input.native_started();
        let key = id.key();
        if let Some(existing) = state.checkpoint.approvals.get(&key) {
            if *existing != frame {
                return Err(AntigravityError::Protocol(
                    "incoming RPC ID reused for a different permission".into(),
                ));
            }
            return Ok(());
        }
        let mut request = normalize(&state.incarnation, &key, &frame)?;
        if let Some(live) = state.live.as_mut() {
            self.show_in_live(live, &frame, &mut request)?;
        }
        state.checkpoint.approvals.insert(key, frame);
        if state.phase == Phase::Ready {
            let _ = self
                .environment
                .events
                .send(AntigravityRuntimeEvent::Approval {
                    conversation_id: self.task_id.clone(),
                    request: Box::new(request),
                });
            self.publish_input(&mut state);
        }
        Ok(())
    }

    async fn reply_error(
        &self,
        id: &RpcId,
        code: i64,
        message: &str,
    ) -> Result<(), AntigravityError> {
        self.state.lock().await.checkpoint.responses.insert(
            id.key(),
            json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}),
        );
        Ok(())
    }

    pub(super) async fn flush_responses(&self) -> Result<(), AntigravityError> {
        let _outbound = self.outbound.lock().await;
        loop {
            let (key, frames, through, checkpoint, frame) = {
                let state = self.state.lock().await;
                if !state.replay_complete {
                    return Ok(());
                }
                let Some((key, frame)) = state.checkpoint.responses.first_key_value() else {
                    return Ok(());
                };
                let mut accepted = state.checkpoint.clone();
                accepted.responses.remove(key);
                (
                    key.clone(),
                    state.frames.clone(),
                    state.through,
                    accepted.encode()?,
                    RawValue::from_string(frame.to_string()).expect("JSON value"),
                )
            };
            frames
                .send(through, checkpoint, frame)
                .await
                .map_err(transport_error)?;
            self.state.lock().await.checkpoint.responses.remove(&key);
        }
    }

    /// Questions still waiting on the child, published again for a connection
    /// that attached to it. A live view shows and names each asked tool call,
    /// as it does for a question asked while the view is open.
    pub(super) fn publish_approvals(&self, state: &mut State) -> Result<(), AntigravityError> {
        let waiting = state.checkpoint.approvals.clone();
        for (key, frame) in &waiting {
            let mut request = normalize(&state.incarnation, key, frame)?;
            if let Some(live) = state.live.as_mut() {
                self.show_in_live(live, frame, &mut request)?;
            }
            let _ = self
                .environment
                .events
                .send(AntigravityRuntimeEvent::Approval {
                    conversation_id: self.task_id.clone(),
                    request: Box::new(request),
                });
        }
        Ok(())
    }

    /// The asked tool call becomes an item of the live view's active turn, and
    /// the question names that turn and item.
    fn show_in_live(
        &self,
        live: &mut Live,
        frame: &Value,
        request: &mut ApprovalRequest,
    ) -> Result<(), AntigravityError> {
        let tool = &frame["params"]["toolCall"];
        self.publish(live.start_events());
        let mut update = tool.clone();
        update["sessionUpdate"] = json!("tool_call");
        self.publish(live.update(&update)?);
        if let Some((turn, item)) = live.active_ids(protocol::required_string(tool, "toolCallId")?)
        {
            request.turn_id = Some(turn);
            request.item_id = Some(item);
        }
        Ok(())
    }

    pub(in crate::agent::antigravity) async fn resolve(
        &self,
        approval: &str,
        decision: ApprovalDecision,
    ) -> Result<(), AntigravityError> {
        let _outbound = self.outbound.lock().await;
        let (key, frames, through, encoded, frame) = {
            let state = self.state.lock().await;
            if state.phase != Phase::Ready {
                return Err(AntigravityError::Unreachable(
                    "connection is not ready".into(),
                ));
            }
            let (key, request) = state
                .checkpoint
                .approvals
                .iter()
                .find(|(key, _)| approval_id(&state.incarnation, key) == approval)
                .ok_or_else(|| {
                    AntigravityError::Protocol("permission request is no longer pending".into())
                })?;
            let normalized = normalize(&state.incarnation, key, request)?;
            if !normalized.decisions.contains(&decision) {
                return Err(AntigravityError::Protocol(
                    "permission decision was not offered".into(),
                ));
            }
            let outcome = if decision == ApprovalDecision::Cancel {
                json!({"outcome":"cancelled"})
            } else {
                let kind = match decision {
                    ApprovalDecision::Allow => "allow_once",
                    ApprovalDecision::AllowAlways => "allow_always",
                    ApprovalDecision::Deny | ApprovalDecision::DenyAndStop => "reject_once",
                    ApprovalDecision::AllowForSession | ApprovalDecision::Cancel => {
                        return Err(AntigravityError::Protocol(
                            "unsupported permission scope".into(),
                        ));
                    }
                };
                let option = request["params"]["options"]
                    .as_array()
                    .and_then(|choices| {
                        choices
                            .iter()
                            .find(|choice| choice["kind"].as_str() == Some(kind))
                    })
                    .ok_or_else(|| {
                        AntigravityError::Protocol("native permission choice is missing".into())
                    })?;
                json!({"outcome":"selected","optionId":protocol::required_string(option,"optionId")?})
            };
            let mut accepted = state.checkpoint.clone();
            accepted.approvals.remove(key);
            let frame = RawValue::from_string(
                json!({"jsonrpc":"2.0","id":request["id"],"result":{"outcome":outcome}})
                    .to_string(),
            )
            .expect("JSON value");
            (
                key.clone(),
                state.frames.clone(),
                state.through,
                accepted.encode()?,
                frame,
            )
        };
        match frames.send(through, encoded, frame).await {
            Ok(()) => {
                let mut state = self.state.lock().await;
                state.checkpoint.approvals.remove(&key);
                self.publish_input(&mut state);
                let _ = self
                    .environment
                    .events
                    .send(AntigravityRuntimeEvent::ApprovalEnded {
                        conversation_id: self.task_id.clone(),
                        approval_id: approval.into(),
                        outcome: ApprovalOutcome::Decided(decision),
                    });
            }
            Err(error) => {
                let error = transport_error(error);
                if matches!(error, AntigravityError::DispatchUnknown(_)) {
                    self.lost(error.clone()).await;
                }
                return Err(error);
            }
        }
        drop(_outbound);
        if decision == ApprovalDecision::DenyAndStop {
            self.interrupt().await?;
        }
        Ok(())
    }
}

fn is_question(tool: &str) -> bool {
    tool.strip_prefix("interaction_").is_some_and(|suffix| {
        suffix.len() == 8
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn normalize(
    incarnation: &str,
    key: &str,
    frame: &Value,
) -> Result<ApprovalRequest, AntigravityError> {
    let params = &frame["params"];
    let tool = &params["toolCall"];
    let title = protocol::required_string(tool, "title")?.to_string();
    let choices = params
        .get("options")
        .and_then(Value::as_array)
        .ok_or_else(|| AntigravityError::Protocol("permission request has no choices".into()))?;
    let mut decisions = Vec::new();
    for choice in choices {
        protocol::required_string(choice, "optionId")?;
        let decision = match protocol::required_string(choice, "kind")? {
            "allow_once" => Some(ApprovalDecision::Allow),
            "allow_always" => Some(ApprovalDecision::AllowAlways),
            "reject_once" => Some(ApprovalDecision::Deny),
            _ => None,
        };
        if let Some(decision) = decision
            && !decisions.contains(&decision)
        {
            decisions.push(decision);
        }
    }
    if decisions.is_empty() {
        return Err(AntigravityError::Protocol(
            "permission request has no supported native choices".into(),
        ));
    }
    if decisions.contains(&ApprovalDecision::Deny) {
        decisions.push(ApprovalDecision::DenyAndStop);
    }
    decisions.push(ApprovalDecision::Cancel);
    let arguments = tool
        .get("rawInput")
        .and_then(Value::as_object)
        .map(|arguments| {
            arguments
                .iter()
                .map(|(name, value)| ApprovalArgument {
                    name: name.clone(),
                    label: name.clone(),
                    value: value.clone(),
                })
                .collect()
        })
        .unwrap_or_default();
    let warning = tool
        .pointer("/_meta/agy.security.warning/message")
        .and_then(Value::as_str)
        .or_else(|| {
            choices.iter().find_map(|choice| {
                choice
                    .pointer("/_meta/agy.security.warning/message")
                    .and_then(Value::as_str)
            })
        })
        .map(str::to_string);
    Ok(ApprovalRequest {
        id: approval_id(incarnation, key),
        turn_id: None,
        item_id: None,
        title,
        reason: warning,
        detail: ApprovalDetail {
            tool: Some(ApprovalToolDetail {
                server_name: "Antigravity".into(),
                app_name: None,
                description: None,
                arguments,
            }),
            ..Default::default()
        },
        decisions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserved_question_ids_are_exact_and_do_not_read_titles() {
        assert!(is_question("interaction_012aef98"));
        for id in [
            "interaction_012aef9",
            "interaction_012AEF98",
            "read_file",
            "interaction_012aef98extra",
        ] {
            assert!(!is_question(id));
        }
    }
    #[test]
    fn permission_ids_keep_the_child_and_rpc_type_and_offer_only_native_grants() {
        let frame = json!({"id":7,"params":{"toolCall":{"toolCallId":"live-control-id","title":"A question-looking title?","rawInput":{"CommandLine":"pwd"}},"options":[{"optionId":"a","kind":"allow_once"},{"optionId":"d","kind":"reject_once"}]}});
        let request = normalize("child-1", &RpcId::Number(7).key(), &frame).unwrap();
        assert!(request.turn_id.is_none() && request.item_id.is_none());
        assert_eq!(
            request.decisions,
            vec![
                ApprovalDecision::Allow,
                ApprovalDecision::Deny,
                ApprovalDecision::DenyAndStop,
                ApprovalDecision::Cancel
            ]
        );
        assert_ne!(
            request.id,
            approval_id("child-1", &RpcId::String("7".into()).key())
        );
        assert_ne!(request.id, approval_id("child-2", &RpcId::Number(7).key()));
    }
}
