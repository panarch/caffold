//! Apply native RPC control, then acknowledge the exact contiguous runner prefix.
use super::*;
use crate::agent::antigravity::{authentication::authorization_url, record};

impl Session {
    pub(super) async fn read(self: Arc<Self>, mut events: RecoveryEvents) {
        while let Some(event) = events.next().await {
            let reauthentication =
                matches!(&event,RecoveryEvent::Stderr(line) if authorization_url(line).is_some());
            let result = match event {
                RecoveryEvent::Stderr(line) => {
                    // Native stderr may contain OAuth URLs/codes. Runtime
                    // reauthentication belongs in Settings, never diagnostics.
                    if authorization_url(&line).is_some() {
                        Err(AntigravityError::SignInRequired)
                    } else {
                        Ok(())
                    }
                }
                RecoveryEvent::ProtocolFailure(message) => Err(AntigravityError::Protocol(message)),
                RecoveryEvent::Output {
                    incarnation,
                    seq,
                    body,
                } => self.output(&incarnation, seq, body).await,
            };
            if let Err(error) = result {
                {
                    let state = self.state.lock().await;
                    if state.retired || matches!(state.phase, Phase::Closing | Phase::Absent) {
                        return;
                    }
                }
                if reauthentication {
                    self.environment.authentication.require_sign_in().await;
                }
                self.lost(error).await;
                if reauthentication {
                    let _ = self
                        .environment
                        .runner
                        .close_recoverable(&self.task_id)
                        .await;
                }
                return;
            }
        }
        {
            let state = self.state.lock().await;
            if state.retired || matches!(state.phase, Phase::Closing | Phase::Absent) {
                return;
            }
        }
        self.lost(AntigravityError::Unreachable(
            "runner observation connection ended; open the Task to reconnect".into(),
        ))
        .await;
    }

    async fn output(
        &self,
        incarnation: &str,
        seq: u64,
        body: RecoveryOutput,
    ) -> Result<(), AntigravityError> {
        let is_fence = matches!(body, RecoveryOutput::Fence);
        {
            let state = self.state.lock().await;
            if state.retired || matches!(state.phase, Phase::Closing | Phase::Absent) {
                return Ok(());
            }
            if state.incarnation != incarnation
                || if is_fence {
                    seq != state.fence || seq != state.through
                } else {
                    state.through.checked_add(1) != Some(seq)
                }
            {
                return Err(AntigravityError::Protocol(
                    "non-contiguous or foreign runner replay".into(),
                ));
            }
        }
        match body {
            RecoveryOutput::Frame(line) => self.apply_frame(&line).await?,
            RecoveryOutput::Fence => {}
            RecoveryOutput::Exit(code) => {
                return Err(AntigravityError::NativeEnded(format!(
                    "native ACP process exited ({code:?})"
                )));
            }
            RecoveryOutput::TransportError(message) => {
                return Err(AntigravityError::NativeEnded(message));
            }
        }
        {
            let mut state = self.state.lock().await;
            state.through = seq;
        }
        let _outbound = self.outbound.lock().await;
        let (frames, through, encoded) = {
            let state = self.state.lock().await;
            if state.retired {
                return Ok(());
            }
            (
                state.frames.clone(),
                state.through,
                state.checkpoint.encode()?,
            )
        };
        if is_fence {
            frames
                .finish_replay(through, encoded)
                .await
                .map_err(transport_error)?;
        } else {
            frames
                .checkpoint(through, encoded)
                .await
                .map_err(transport_error)?;
        }
        if is_fence {
            self.state.lock().await.replay_complete = true;
            self.changed.notify_waiters();
        }
        drop(_outbound);
        self.flush_responses().await?;
        self.cancel_if_due().await?;
        Ok(())
    }

    async fn apply_frame(&self, line: &str) -> Result<(), AntigravityError> {
        let frame: Value =
            serde_json::from_str(line).map_err(|e| AntigravityError::Protocol(e.to_string()))?;
        if frame.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            return Err(AntigravityError::Protocol(
                "invalid native RPC envelope".into(),
            ));
        }
        if let Some(method) = frame.get("method").and_then(Value::as_str) {
            if frame.get("id").is_some() {
                return self.incoming(method, frame.clone()).await;
            }
            // Context is a session observation, including load and replay.
            // Only fresh prompts own an in-memory conversation display.
            if method == "session/update" {
                let params = frame.get("params").ok_or_else(|| {
                    AntigravityError::Protocol("session update has no params".into())
                })?;
                let native = protocol::required_string(params, "sessionId")?;
                let mut state = self.state.lock().await;
                if state
                    .checkpoint
                    .binding
                    .as_ref()
                    .is_some_and(|binding| binding.native_id != native)
                {
                    return Err(AntigravityError::Protocol(
                        "update belongs to another native session".into(),
                    ));
                }
                if let Some(options) = params.pointer("/update/configOptions") {
                    state.checkpoint.options = serde_json::from_value(options.clone())
                        .map_err(|e| AntigravityError::Protocol(e.to_string()))?;
                }
                let update = &params["update"];
                if let Some(context) = Context::from_update(update) {
                    state.checkpoint.context = Some(context);
                    self.publish_context(&state);
                }
                if let Some(report) = state.report.as_mut()
                    && update["sessionUpdate"].as_str() == Some("agent_message_chunk")
                    && update["content"]["type"].as_str() == Some("text")
                {
                    let text = protocol::required_string(&update["content"], "text")?;
                    if report.len() + text.len() > 64 * 1024 {
                        return Err(AntigravityError::Protocol(
                            "native usage report exceeds its limit".into(),
                        ));
                    }
                    report.push_str(text);
                }

                if let Some(live) = state.live.as_mut() {
                    self.publish(live.start_events());
                    self.publish(live.update(update)?);
                }
                if matches!(
                    update["sessionUpdate"].as_str(),
                    Some("agent_thought_chunk" | "tool_call" | "tool_call_update")
                ) {
                    state.checkpoint.input.native_started();
                }

                if update["sessionUpdate"].as_str() == Some("tool_call_update")
                    && matches!(update["status"].as_str(), Some("completed" | "failed"))
                {
                    let tool = protocol::required_string(update, "toolCallId")?;
                    let expired = state
                        .checkpoint
                        .approvals
                        .iter()
                        .filter(|(_, frame)| {
                            frame
                                .pointer("/params/toolCall/toolCallId")
                                .and_then(Value::as_str)
                                == Some(tool)
                        })
                        .map(|(key, _)| key.clone())
                        .collect::<Vec<_>>();
                    for key in expired {
                        state.checkpoint.approvals.remove(&key);
                        let _ =
                            self.environment
                                .events
                                .send(AntigravityRuntimeEvent::ApprovalEnded {
                                    conversation_id: self.task_id.clone(),
                                    approval_id: permission::approval_id(&state.incarnation, &key),
                                    outcome: ApprovalOutcome::Expired,
                                });
                    }
                    self.publish_input(&mut state);
                }
                if state.live.is_none() {
                    let _ = self
                        .environment
                        .events
                        .send(AntigravityRuntimeEvent::RecordChanged {
                            conversation_id: self.task_id.clone(),
                        });
                }
            }
            return Ok(());
        }
        let id = frame.get("id").and_then(Value::as_u64).ok_or_else(|| {
            AntigravityError::Protocol("native response has no request ID".into())
        })?;
        let result = if let Some(error) = frame.get("error") {
            Err(AntigravityError::Rpc {
                code: error
                    .get("code")
                    .and_then(Value::as_i64)
                    .ok_or_else(|| AntigravityError::Protocol("invalid RPC error code".into()))?,
                message: protocol::required_string(error, "message")?.into(),
            })
        } else {
            Ok(frame.get("result").cloned().ok_or_else(|| {
                AntigravityError::Protocol("native response has neither result nor error".into())
            })?)
        };
        let mut state = self.state.lock().await;
        if state.retired {
            return Ok(());
        }
        let purpose = state.checkpoint.pending.get(&id).cloned().ok_or_else(|| {
            AntigravityError::Protocol("native response refers to an unknown request".into())
        })?;
        if let Ok(value) = &result {
            match &purpose {
                Purpose::Initialize => {
                    if value.get("protocolVersion").and_then(Value::as_u64) != Some(1)
                        || value.pointer("/agentInfo/version").and_then(Value::as_str)
                            != Some(protocol::VERSION)
                    {
                        return Err(AntigravityError::Protocol(
                            "unsupported native ACP protocol".into(),
                        ));
                    }
                    state.checkpoint.initialized = true;
                }
                Purpose::Authenticate => {
                    state.checkpoint.authenticated = true;
                    let account = Verified::from_result(true, value);
                    self.environment
                        .authentication
                        .observe(account.clone())
                        .await;
                    state.checkpoint.account = Some(account);
                }
                Purpose::New { cwd, .. } | Purpose::Load { cwd, .. } => {
                    let (native_id, options) = match &purpose {
                        Purpose::New { .. } => {
                            let native: protocol::SessionState =
                                serde_json::from_value(value.clone())
                                    .map_err(|e| AntigravityError::Protocol(e.to_string()))?;
                            (native.session_id, native.config_options)
                        }
                        Purpose::Load { native_id, .. } => {
                            let native: protocol::ConfigResult =
                                serde_json::from_value(value.clone())
                                    .map_err(|e| AntigravityError::Protocol(e.to_string()))?;
                            (native_id.clone(), native.config_options)
                        }
                        _ => unreachable!("matched session purpose"),
                    };
                    record::validate_session(&native_id)?;
                    let binding = Binding {
                        version: 1,
                        task_id: self.task_id.clone(),
                        native_id,
                        cwd: cwd.clone(),
                        mcp_binding: state.checkpoint.mcp_binding.clone(),
                    };
                    let bindings = self.environment.bindings.clone();
                    let saved = binding.clone();
                    // Persist only the exact native binding before acknowledging
                    // the result. A crash before this finishes replays it.
                    tokio::task::spawn_blocking(move || bindings.write(&saved))
                        .await
                        .map_err(|e| AntigravityError::Binding(e.to_string()))??;
                    state.checkpoint.binding = Some(binding);
                    state.checkpoint.options = options;
                    state.checkpoint.loaded = true;
                }
                Purpose::Configure { .. } => {
                    let config: protocol::ConfigResult = serde_json::from_value(value.clone())
                        .map_err(|e| AntigravityError::Protocol(e.to_string()))?;
                    state.checkpoint.options = config.config_options;
                }
                Purpose::Prompt => {}
            }
        }
        state.checkpoint.pending.remove(&id);
        if let Some(reply) = state.replies.remove(&id) {
            reply.send_replace(Some(result.clone()));
        }
        if purpose == Purpose::Prompt && state.checkpoint.input.finish(id) {
            if let Some(live) = state.live.as_mut() {
                self.publish(live.start_events());
                self.publish(live.finish(&result));
            }
            self.publish_input(&mut state);
            if state.live.is_none() {
                let _ = self
                    .environment
                    .events
                    .send(AntigravityRuntimeEvent::RecordChanged {
                        conversation_id: self.task_id.clone(),
                    });
            }
        }
        self.changed.notify_waiters();
        Ok(())
    }
}
