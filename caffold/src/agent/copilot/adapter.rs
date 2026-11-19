//! The runner owns this process. Losing a browser or backend never drops its SDK client.

use super::{
    connect, permission,
    protocol::{Failure, Operation, Output, Request, VERSION},
};
use crate::agent::driver::{REVIEWED_PERMISSION_MODE, TurnOptions};
use copilot_sdk::{
    Attachment, Client, DeliveryMode, MessageOptions, PermissionMode, SetModelOptions,
    rpc::{MetadataSetWorkingDirectoryRequest, PermissionsSetModeRequest},
    session::Session,
};
use serde_json::{Value, json};
use std::{collections::VecDeque, path::Path, sync::Arc};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{Mutex, Notify, mpsc},
};

mod open;

#[derive(Default)]
struct Live {
    active_turn: Option<String>,
    context: Option<Value>,
    usage: super::usage::Usage,
    usage_turn: Option<String>,
    pending_inputs: VecDeque<(String, String)>,
}

struct Adapter {
    session: Option<Session>,
    settings: TurnOptions,
    live: Arc<Mutex<Live>>,
    events: Option<tokio::task::JoinHandle<()>>,
    changed: Arc<Notify>,
    closed: Arc<Notify>,
    isolation: bool,
    destination: Option<String>,
}

pub(crate) async fn run(program: &Path) -> anyhow::Result<()> {
    let client = connect(program).await?;
    let (output, mut receive) = mpsc::channel::<Output>(256);
    let writing = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = receive.recv().await {
            let mut line = serde_json::to_vec(&frame)?;
            line.push(b'\n');
            stdout.write_all(&line).await?;
            stdout.flush().await?;
        }
        Ok::<_, anyhow::Error>(())
    });
    let mut state = Adapter {
        session: None,
        settings: TurnOptions::default(),
        live: Default::default(),
        events: None,
        changed: Default::default(),
        closed: Default::default(),
        isolation: false,
        destination: None,
    };
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let result = async {
        loop {
            let line = tokio::select! {
                line = stdin.next_line() => match line? {
                    Some(line) => line,
                    None => break,
                },
                _ = state.closed.notified() => anyhow::bail!("Copilot CLI event stream closed"),
                _ = state.changed.notified() => {
                    if let Err(error) = state.activity_changed(&output).await {
                        tracing::warn!(?error, "Copilot activity refresh failed");
                    }
                    continue;
                }
            };
            let req: Request = serde_json::from_str(&line)?;
            let answer = if req.version == VERSION {
                state.execute(&client, req.operation, &output).await
            } else {
                Err(Failure::Failed(format!(
                    "Unsupported Caffold Copilot adapter protocol {}.",
                    req.version
                )))
            };
            output
                .send(Output::Reply {
                    id: req.id,
                    result: answer,
                })
                .await?;
        }
        Ok::<_, anyhow::Error>(())
    }
    .await;
    if let Some(events) = state.events.take() {
        events.abort();
    }
    if let Err(error) = client.stop().await {
        tracing::warn!(%error,"Copilot shutdown failed");
    }
    drop(output);
    writing.await??;
    result
}

impl Adapter {
    async fn execute(
        &mut self,
        client: &Client,
        command: Operation,
        output: &mpsc::Sender<Output>,
    ) -> Result<Value, Failure> {
        match command {
            Operation::Open(open) => self.open(client, open, output).await,
            Operation::Inspect => self.inspect().await,
            Operation::Send {
                prompt,
                images,
                target,
                settings,
            } => self.send(prompt, images, target, settings).await,
            Operation::Stop => self.stop().await,
            Operation::Decide {
                request,
                decision,
                source,
            } => Ok(json!(
                permission::decide(self.session()?, &request, decision, source).await?
            )),
            Operation::PrepareIsolation => {
                let session = self.session()?;
                if self.isolation {
                    return Err(Failure::Held(
                        "Copilot is already preparing the worktree.".into(),
                    ));
                }
                session
                    .rpc()
                    .queue()
                    .set_drain_paused(serde_json::from_value(json!({"paused": true}))?)
                    .await?;
                self.isolation = true;
                let pending = self.session()?.rpc().queue().pending_items().await;
                match pending {
                    Ok(queue)
                        if queue.steering_messages.len() as i64
                            <= queue.in_flight_steering_count.unwrap_or(0) =>
                    {
                        Ok(Value::Null)
                    }
                    other => {
                        self.release_queue().await?;
                        match other {
                            Err(error) => Err(error.into()),
                            Ok(_) => Err(Failure::Held(
                                "Read the pending follow-up before retrying worktree isolation. The worktree has not been created.".into()
                            )),
                        }
                    }
                }
            }
            Operation::FinishIsolation { destination } => {
                self.destination = destination;
                if self.destination.is_none() {
                    self.release_queue().await?;
                } else if !self
                    .session()?
                    .rpc()
                    .metadata()
                    .is_processing()
                    .await?
                    .processing
                {
                    self.finish_move().await?;
                }
                Ok(Value::Null)
            }
            Operation::Move { cwd } => {
                if self
                    .session()?
                    .rpc()
                    .metadata()
                    .is_processing()
                    .await?
                    .processing
                {
                    return Err(Failure::TurnRunning);
                }
                self.destination = Some(cwd);
                self.finish_move().await?;
                Ok(Value::Null)
            }
            Operation::Rename { name } => {
                self.session()?
                    .rpc()
                    .name()
                    .set(serde_json::from_value(json!({"name":name}))?)
                    .await?;
                Ok(Value::Null)
            }
        }
    }

    fn session(&self) -> Result<&Session, Failure> {
        self.session
            .as_ref()
            .ok_or_else(|| Failure::Failed("Open the Copilot session first.".into()))
    }

    async fn inspect(&self) -> Result<Value, Failure> {
        let session = self.session()?;
        let rpc = session.rpc();
        let snapshot = rpc.metadata().snapshot().await?;
        let pending = rpc.permissions().pending_requests().await?;
        let mode = rpc.permissions().get_mode().await?;
        let processing = rpc.metadata().is_processing().await?.processing;
        let active_jobs = background_jobs(session).await?;
        let live = self.live.lock().await;
        Ok(json!({
            "metadata": snapshot,
            "permissions": pending.items,
            "mode": mode.mode,
            "settings": self.settings,
            "processing": processing,
            "background": !active_jobs.is_empty(),
            "usage": live.usage,
            "usageTurn": live.usage_turn,
            "activeTurn": live.active_turn,
            "context": live.context,
            "isolating": self.isolation,
            "destination": self.destination,
        }))
    }

    async fn activity_changed(&mut self, output: &mpsc::Sender<Output>) -> Result<(), Failure> {
        let session = self.session()?;
        let active = !background_jobs(session).await?.is_empty();
        output
            .send(Output::Background { active })
            .await
            .map_err(|e| Failure::Failed(e.to_string()))?;
        if self.destination.is_some() && !session.rpc().metadata().is_processing().await?.processing
        {
            self.finish_move().await?;
        }
        Ok(())
    }

    async fn release_queue(&mut self) -> Result<(), Failure> {
        if self.isolation {
            self.session()?
                .rpc()
                .queue()
                .set_drain_paused(serde_json::from_value(json!({"paused":false}))?)
                .await?;
            self.isolation = false;
        }
        Ok(())
    }

    async fn finish_move(&mut self) -> Result<(), Failure> {
        if let Some(cwd) = self.destination.as_ref() {
            let rpc = self.session()?.rpc();
            rpc.metadata()
                .set_working_directory(MetadataSetWorkingDirectoryRequest {
                    working_directory: cwd.clone(),
                })
                .await?;
            if rpc.metadata().snapshot().await?.working_directory != *cwd {
                return Err(Failure::Held(
                    "Copilot did not confirm the destination worktree.".into(),
                ));
            }
            self.release_queue().await?;
            self.destination = None;
        }
        Ok(())
    }

    async fn send(
        &mut self,
        prompt: String,
        images: Vec<String>,
        target: Option<String>,
        settings: Option<TurnOptions>,
    ) -> Result<Value, Failure> {
        let active = self.live.lock().await.active_turn.clone();
        if let Some(target) = &target {
            if active.as_ref() != Some(target) {
                return Err(Failure::TurnGone);
            }
        } else if active.is_some() {
            return Err(Failure::TurnRunning);
        }
        if target.is_none() {
            if self.destination.is_some() {
                self.finish_move().await?;
            } else if self.isolation
                && !self
                    .session()?
                    .rpc()
                    .metadata()
                    .is_processing()
                    .await?
                    .processing
            {
                // The backend may have stopped after pausing the queue and before
                // changing Git. A fresh idle turn uses the Task's confirmed cwd.
                self.release_queue().await?;
            }
        }
        if let Some(settings) = settings {
            let session = self.session()?;
            if let Some(model) = &settings.model {
                let options = settings
                    .effort
                    .as_ref()
                    .map(|e| SetModelOptions::default().with_reasoning_effort(e));
                session.set_model(model, options).await?;
            }
            let mode = native_mode(&settings);
            let result = session
                .rpc()
                .permissions()
                .set_mode(PermissionsSetModeRequest {
                    mode: mode.clone(),
                    ..Default::default()
                })
                .await?;
            if !result.success || result.mode != mode {
                return Err(Failure::Held(
                    "Copilot policy refused the selected permission mode.".into(),
                ));
            }
            self.settings = settings;
        }
        let attachments = images
            .into_iter()
            .map(|p| Attachment::File {
                path: p.into(),
                display_name: None,
                line_range: None,
            })
            .collect();
        let mut message = MessageOptions::new(&prompt).with_attachments(attachments);
        if target.is_some() && !self.isolation {
            message = message.with_mode(DeliveryMode::Immediate);
        }
        let mut live = self.live.lock().await;
        if target
            .as_ref()
            .is_some_and(|wanted| live.active_turn.as_ref() != Some(wanted))
        {
            return Err(Failure::TurnGone);
        }
        if target.is_none() && live.active_turn.is_some() {
            return Err(Failure::TurnRunning);
        }
        let id = self.session()?.send(message).await?;
        if target.is_some() {
            live.pending_inputs.push_back((id.clone(), prompt));
        } else {
            live.active_turn = Some(id.clone());
        }
        Ok(json!({"messageId":id}))
    }

    async fn stop(&mut self) -> Result<Value, Failure> {
        let own_pause = !self.isolation;
        if own_pause {
            self.session()?
                .rpc()
                .queue()
                .set_drain_paused(serde_json::from_value(json!({"paused":true}))?)
                .await?;
        }
        let result = self.stop_with_queue_paused().await;
        if own_pause {
            self.session()?
                .rpc()
                .queue()
                .set_drain_paused(serde_json::from_value(json!({"paused":false}))?)
                .await?;
        }
        result
    }

    async fn stop_with_queue_paused(&mut self) -> Result<Value, Failure> {
        let session = self.session()?;
        let rpc = session.rpc();
        rpc.interrupt_main_turn(serde_json::from_value(json!({"flushQueued":true}))?)
            .await?;
        let mut pending = rpc.queue().pending_items().await?;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while pending.steering_messages.len() as i64 > pending.in_flight_steering_count.unwrap_or(0)
        {
            if tokio::time::Instant::now() >= deadline {
                return Err(Failure::Held("Copilot has not finished moving pending messages to its queue. Stop can be retried.".into()));
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            pending = rpc.queue().pending_items().await?;
        }
        let sent = self.live.lock().await.pending_inputs.clone();
        let mut cancelled = Vec::new();
        for (id, prompt) in sent {
            if let Some(item) = pending
                .items
                .iter()
                .find(|item| item.message_id.as_deref() == Some(&id))
                && rpc
                    .queue()
                    .remove_at(serde_json::from_value(json!({"id":item.id}))?)
                    .await?
                    .removed
            {
                cancelled.push(prompt);
            }
        }
        session.abort().await?;
        for id in background_jobs(session).await? {
            rpc.tasks()
                .cancel(copilot_sdk::rpc::TasksCancelRequest { id })
                .await?;
        }
        self.live.lock().await.pending_inputs.clear();
        Ok(json!(cancelled))
    }
}

fn native_mode(settings: &TurnOptions) -> PermissionMode {
    match settings.permission_mode.as_deref() {
        Some("assisted") => PermissionMode::Assisted,
        Some("allow-all") => PermissionMode::AllowAll,
        Some(REVIEWED_PERMISSION_MODE) | Some("manual") | None => PermissionMode::Manual,
        _ => PermissionMode::Manual,
    }
}

async fn background_jobs(session: &Session) -> Result<Vec<String>, Failure> {
    let list = session.rpc().tasks().list().await?;
    Ok(list
        .tasks
        .iter()
        .filter(|task| {
            matches!(
                task["status"].as_str(),
                Some("running" | "pending" | "in_progress" | "queued")
            )
        })
        .filter_map(|task| task["id"].as_str().map(str::to_owned))
        .collect())
}
