//! Establish the native session, subscribing before create or resume emits its first event.
use super::{Adapter, Live, native_mode};
use crate::agent::{
    CAFFOLD_CLARIFICATION_FEEDBACK, CAFFOLD_SESSION_INSTRUCTIONS,
    copilot::{
        permission::PendingPermissions,
        protocol::{Failure, OpenSession, Output},
        usage::Counters,
    },
    http_mcp::{CAFFOLD_MCP_BINDING_HEADER, CAFFOLD_MCP_SERVER_NAME},
};
use copilot_sdk::{
    Client, CreateSessionOptions, McpHttpServerConfig, McpServerConfig, ResumeSessionOptions,
    SystemMessageConfig,
    rpc::{SessionsHasEventsRequest, SessionsSaveRequest},
    subscription::{EventSubscription, RecvErrorKind},
};
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify, mpsc};

impl Adapter {
    pub(super) async fn open(
        &mut self,
        client: &Client,
        open: OpenSession,
        output: &mpsc::Sender<Output>,
    ) -> Result<Value, Failure> {
        if let Some(session) = self.session.as_ref() {
            if session.id().as_str() != open.session {
                return Err(Failure::Failed(
                    "This adapter belongs to another Copilot session.".into(),
                ));
            }
        } else {
            let options = options(&open);
            let prepared = if open.create {
                client.prepare_session(options)?
            } else {
                let mut resume = ResumeSessionOptions::new(open.session.clone().into())
                    .with_continue_pending_work(true);
                resume.working_directory = options.working_directory;
                resume.model = options.model;
                resume.github = options.github;
                resume.inference = options.inference;
                resume.permissions = options.permissions;
                resume.mcp = options.mcp;
                resume.system_message = options.system_message;
                resume.tools = options.tools;
                client.prepare_resume_session(resume)?
            };
            let mut subscription = prepared.subscribe();
            let live = self.live.clone();
            let changed = self.changed.clone();
            let closed = self.closed.clone();
            let output = output.clone();
            let watching = tokio::spawn(async move {
                observe(&mut subscription, &live, &changed, &closed, &output).await
            });
            let started = match prepared.start().await {
                Ok(session) => session,
                Err(error) => {
                    watching.abort();
                    return Err(error.into());
                }
            };
            if started.id().as_str() != open.session {
                watching.abort();
                return Err(Failure::Failed(
                    "Copilot returned a different session ID.".into(),
                ));
            }
            self.session = Some(started);
            self.events = Some(watching);
            self.settings = open.settings.clone();
            let session = self.session()?;
            let metrics = session.rpc().usage().get_metrics().await?;
            self.live.lock().await.usage.total = Counters::from_metrics(&metrics);
        }
        let mode = self.session()?.rpc().permissions().get_mode().await?.mode;
        if mode != native_mode(&self.settings) {
            return Err(Failure::Held(
                "Copilot policy refused the selected permission mode.".into(),
            ));
        }
        if open.create || open.persist {
            let session_id: copilot_sdk::SessionId = open.session.into();
            client
                .rpc()
                .sessions()
                .save(SessionsSaveRequest {
                    session_id: session_id.clone(),
                })
                .await?;
            if !client
                .rpc()
                .sessions()
                .has_events(SessionsHasEventsRequest { session_id })
                .await?
                .exists
            {
                return Err(Failure::Failed(
                    "Copilot did not persist the new session.".into(),
                ));
            }
        }
        self.inspect().await
    }
}

fn options(open: &OpenSession) -> CreateSessionOptions {
    let mut instructions =
        format!("{CAFFOLD_SESSION_INSTRUCTIONS}\n\n{CAFFOLD_CLARIFICATION_FEEDBACK}");
    if open.first {
        instructions.push_str("\n\nOn the first ordinary user request, use the Caffold MCP server's rename_current_task tool to give this Task a concise name for that work. Do this once, then continue the user's request.");
    }
    let server = McpHttpServerConfig {
        url: open.endpoint.clone(),
        tools: Some(vec!["*".into()]),
        headers: [(CAFFOLD_MCP_BINDING_HEADER.into(), open.binding.clone())]
            .into_iter()
            .collect(),
        ..Default::default()
    };
    let mut options = CreateSessionOptions::default()
        .with_session_id(open.session.clone())
        .with_name(format!("Caffold {}", open.session))
        .with_working_directory(&open.cwd)
        .with_github(|g| g.with_fetch_managed_settings(true))
        .with_permissions(|p| {
            p.with_on_request(Arc::new(PendingPermissions))
                .with_mode(native_mode(&open.settings))
        })
        .with_mcp(|m| {
            m.with_servers(
                [(
                    CAFFOLD_MCP_SERVER_NAME.into(),
                    McpServerConfig::Http(server),
                )]
                .into_iter()
                .collect(),
            )
        })
        .with_tools(|t| t.with_excluded_tools(["ask_user"]))
        .with_system_message(
            SystemMessageConfig::new()
                .with_mode("append")
                .with_content(instructions),
        );
    if let Some(model) = &open.settings.model {
        options = options.with_model(model);
    }
    if let Some(effort) = &open.settings.effort {
        options = options.with_inference(|i| i.with_reasoning_effort(effort));
    }
    options
}

async fn observe(
    subscription: &mut EventSubscription,
    live: &Mutex<Live>,
    changed: &Notify,
    closed: &Notify,
    output: &mpsc::Sender<Output>,
) {
    loop {
        let event = match subscription.recv().await {
            Ok(event) => event,
            Err(error) => {
                if matches!(error.kind(), RecvErrorKind::Lagged(_)) {
                    if output
                        .send(Output::ObservationLost {
                            message: error.to_string(),
                        })
                        .await
                        .is_err()
                    {
                        return;
                    }
                    continue;
                }
                closed.notify_one();
                return;
            }
        };
        let mut usage = None;
        if event.agent_id.is_none() {
            let mut state = live.lock().await;
            match event.event_type.as_str() {
                "user.message" => {
                    let id = event.data["messageId"].as_str().unwrap_or(&event.id);
                    state.pending_inputs.retain(|(mid, _)| mid != id);
                    if event.data["delivery"] != "steering" {
                        state.active_turn = Some(id.to_owned());
                        if state.usage_turn.as_deref() != Some(id) {
                            state.usage_turn = Some(id.into());
                            state.usage.last = Counters::default();
                        }
                    }
                }
                "session.idle" | "session.shutdown" => {
                    state.active_turn = None;
                    changed.notify_one();
                }
                "session.background_tasks_changed" => changed.notify_one(),
                "session.model_change" | "session.compaction_complete" => state.context = None,
                "session.usage_info" => state.context = Some(event.data.clone()),
                "assistant.usage" => {
                    if let Some(call) = Counters::from_call(&event.data) {
                        state.usage.total.add(call);
                        state.usage.last.add(call);
                        if let Some(turn) = &state.usage_turn {
                            usage = Some(Output::Usage {
                                turn: turn.clone(),
                                usage: state.usage,
                            });
                        }
                    }
                }
                _ => {}
            }
        }
        if output.send(Output::Event { event }).await.is_err() {
            return;
        }
        if let Some(usage) = usage
            && output.send(usage).await.is_err()
        {
            return;
        }
    }
}
