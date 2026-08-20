//! The agents Caffold can drive, and the questions it asks one.
//!
//! The set is closed on purpose. Caffold supports the agents it was built
//! against and loads nothing at run time, so an agent is a variant rather than
//! something reached behind a pointer. That choice is what turns a capability
//! one agent has and another lacks into a missing match arm — an error at every
//! place that has to decide — instead of a default quietly standing in.
//!
//! What is here is what a Task needs of an agent: begin a conversation, open
//! one and watch it, page back through its turns, stop watching, begin a turn,
//! add to a running one, stop it, and say how the agent can be allowed to work.
//! Answering an approval, reporting readiness, and the rest of settings are
//! still each agent's own, because Caffold has not yet watched two agents do
//! them and would be guessing at the shared shape.
//!
//! This module holds the vocabulary and the choosing. What a choice means to an
//! agent belongs to that agent — `codex::contract` for Codex, `claude` for
//! Claude — so that a third agent adds a match arm here rather than a third
//! pile of internals.
//!
//! The failures are still Codex's, for a reason of the same kind: sixty places
//! across the application read a `CodexThreadError` by variant, and giving the
//! failures a shared vocabulary is its own change rather than a detail of this
//! one.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use super::claude::{ClaudeClient, ClaudeTurnOptions, claude_turn_options};
use super::codex::{
    CodexThreadClient, CodexThreadError, CodexTurnOptions, codex_mode_id, codex_models,
    codex_permission_mode_name, codex_permission_modes, codex_turn_options, is_fast_service_tier,
    service_tier_for_fast_mode,
};
use super::{Conversation, Turn, TurnPage};

/// One agent, reached the way that agent is reached.
#[derive(Clone)]
pub(crate) enum Driver {
    Codex(CodexThreadClient),
    Claude(ClaudeConversation),
}

/// Claude, and where the Task being asked about works.
///
/// Codex holds a thread's working directory and answers for it. Claude does
/// not: a session is a process, resuming one starts a new process, and the new
/// process works wherever it was started. So a driver for a Claude Task carries
/// where that Task works, which is why the store keeps it.
#[derive(Clone)]
pub(crate) struct ClaudeConversation {
    pub(crate) client: ClaudeClient,
    pub(crate) cwd: String,
}

/// A conversation as it stands, and the most recent of its turns.
///
/// An agent answers both in one exchange, because a conversation without its
/// last turns is not yet something a person can read.
pub(crate) struct OpenedConversation {
    pub(crate) conversation: Conversation,
    /// Absent when the turns were not asked for.
    pub(crate) turns_page: Option<TurnPage>,
    /// Where the agent is working, as the agent reports it.
    pub(crate) cwd: String,
    /// What the agent says its settings for this conversation are, in its own
    /// words. Caffold has not decided what a setting means across agents, so
    /// this crosses unread and the agent's own reader takes it from here.
    pub(crate) settings: BTreeMap<String, Value>,
}

/// One model an agent offers, in Caffold's words.
///
/// Both agents describe a model the same way once each one's own parts are set
/// aside: something to send back, something to show, whether it is the one
/// chosen by default, the depths it works at, and whether it has a faster tier.
/// Everything else — service tiers by name, modalities, adaptive thinking — is
/// the agent's own and stays there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelOption {
    /// What to send back when this one is chosen. The agent's own name for it.
    pub(crate) model: String,
    pub(crate) display_name: String,
    pub(crate) description: Option<String>,
    /// True for the one the agent would choose if nobody did.
    pub(crate) is_default: bool,
    pub(crate) default_effort: Option<String>,
    /// The depths this model works at, in the agent's own words. Empty when it
    /// offers no choice.
    pub(crate) efforts: Vec<String>,
    pub(crate) supports_fast_mode: bool,
    /// Whether this model can decide permissions for itself.
    ///
    /// A capability of the model rather than of the agent: Claude offers a mode
    /// where the model classifies each request, and only some models can. It is
    /// carried here because the ways a person can let an agent work then depend
    /// on which model they chose.
    pub(crate) supports_auto_mode: bool,
}

/// The ways a person can let an agent work, as that agent offers them.
///
/// Neither agent hands this over ready to show. Codex has permission profiles
/// and a separate reviewer setting, and the choices worth offering are
/// combinations of the two; Claude names its modes outright but calls one of
/// them `bypassPermissions`. Either way the assembling and the naming are the
/// driver's, because knowing what a mode does to an agent is knowing that
/// agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionModes {
    /// What this installation works under when nobody chooses.
    pub(crate) default_mode: String,
    pub(crate) options: Vec<PermissionModeOption>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PermissionModeOption {
    /// The agent's own name for it. Caffold carries this back verbatim when a
    /// turn starts rather than translating it, so a mode an agent adds needs
    /// nothing from Caffold to become choosable.
    pub(crate) mode: String,
    pub(crate) label: String,
    pub(crate) description: String,
    /// False when this installation cannot offer it — a profile the workspace
    /// forbids, say. The choice is still shown, so that it reads as withheld
    /// rather than missing.
    pub(crate) allowed: bool,
    /// Why it is withheld, when it is. Written by the driver, because the
    /// reason belongs to the agent: a profile a workspace forbids and a model
    /// that cannot manage its own permissions are not the same sentence.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) unavailable_reason: Option<String>,
    /// True when choosing it gives up a protection.
    pub(crate) dangerous: bool,
}

/// What a person chose for a turn.
///
/// Every field is Caffold's word for something, and what each one means to an
/// agent is the agent's to work out — which model answers to that name, whether
/// it has a faster tier, what that permission mode does.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TurnOptions {
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) fast_mode: bool,
    /// A mode the agent itself offered, carried back under the agent's own name
    /// for it. Caffold does not read this.
    pub(crate) permission_mode: Option<String>,
}

/// A value a person typed, or nothing when they typed nothing.
///
/// `None` from an absent or blank choice means "whatever the agent prefers".
/// A value too long or carrying control characters never came from the choices
/// the agent offered, and is refused before it reaches one.
pub(super) fn bounded(value: Option<&str>, limit: usize) -> Option<Option<String>> {
    let Some(value) = value.map(str::trim) else {
        return Some(None);
    };
    if value.is_empty() {
        return Some(None);
    }
    if value.len() > limit || value.chars().any(char::is_control) {
        return None;
    }
    Some(Some(value.to_string()))
}

/// Options an agent has agreed to.
///
/// Agreeing is a question asked of the agent — which model answers to that
/// name, what depths it works at — so it happens once, before anything is
/// created, and the answer is carried to whatever needs it. Starting a
/// conversation and then discovering the model was never real would leave the
/// conversation behind.
pub(crate) struct AcceptedTurnOptions {
    /// What the agent settled on, which is what the interface should report.
    pub(crate) applied: TurnOptions,
    agreed: AgreedTurnOptions,
}

/// The same agreement, in the agent's own terms.
enum AgreedTurnOptions {
    Codex(CodexTurnOptions),
    Claude(ClaudeTurnOptions),
}

impl AcceptedTurnOptions {
    fn codex(&self) -> Result<&CodexTurnOptions, CodexThreadError> {
        match &self.agreed {
            AgreedTurnOptions::Codex(codex) => Ok(codex),
            AgreedTurnOptions::Claude(_) => Err(mismatched_agent()),
        }
    }

    fn claude(&self) -> Result<&ClaudeTurnOptions, CodexThreadError> {
        match &self.agreed {
            AgreedTurnOptions::Claude(claude) => Ok(claude),
            AgreedTurnOptions::Codex(_) => Err(mismatched_agent()),
        }
    }
}

/// Options one agent agreed to, carried to another.
///
/// Nothing in the application can produce this: options are agreed and used
/// within one request, against one Task, whose agent does not change. It is a
/// programming error rather than something a person can cause, so it is
/// reported rather than guessed past.
fn mismatched_agent() -> CodexThreadError {
    CodexThreadError::Agent(
        "Caffold offered one agent's turn options to another. This is a defect.".to_string(),
    )
}

/// A conversation the agent has just begun, and what it begins under.
///
/// An agent settles the settings at the same moment it makes the conversation,
/// and what it settled on is not always what was asked for, so it says.
pub(crate) struct StartedConversation {
    pub(crate) conversation: Conversation,
    pub(crate) settings: TurnOptions,
}

/// A turn the agent has begun.
pub(crate) struct StartedTurn {
    pub(crate) turn: Turn,
    /// What the agent settled on, which is not always what was asked for: a
    /// model without a faster tier answers a request for speed with its normal
    /// one, and the person should be told what they got.
    pub(crate) applied: TurnOptions,
}

/// Why an agent would not start a turn as asked.
#[derive(Debug)]
pub(crate) enum TurnRejected {
    /// No such model, by that name, for this agent.
    Model,
    /// The chosen model does not work at that depth.
    Effort,
    /// The agent could not be reached to find out.
    Unavailable(CodexThreadError),
}

impl From<CodexThreadError> for TurnRejected {
    fn from(error: CodexThreadError) -> Self {
        Self::Unavailable(error)
    }
}

impl Driver {
    /// Ask the agent whether it will work this way.
    pub(crate) async fn accept_turn_options(
        &self,
        options: &TurnOptions,
    ) -> Result<AcceptedTurnOptions, TurnRejected> {
        match self {
            Self::Codex(client) => {
                let codex = codex_turn_options(client, options).await?;
                Ok(AcceptedTurnOptions {
                    applied: TurnOptions {
                        model: codex.model.clone(),
                        effort: codex.effort.clone(),
                        fast_mode: is_fast_service_tier(codex.service_tier.as_deref()),
                        permission_mode: options.permission_mode.clone(),
                    },
                    agreed: AgreedTurnOptions::Codex(codex),
                })
            }
            Self::Claude(claude) => {
                let accepted = claude_turn_options(&claude.client, options).await?;
                Ok(AcceptedTurnOptions {
                    applied: TurnOptions {
                        model: accepted.model.clone(),
                        effort: accepted.effort.clone(),
                        fast_mode: accepted.fast_mode,
                        permission_mode: accepted.permission_mode.clone(),
                    },
                    agreed: AgreedTurnOptions::Claude(accepted),
                })
            }
        }
    }

    /// Read back what the agent said its settings are.
    ///
    /// The settings crossed the boundary unread, in the agent's own keys, so
    /// the agent is what reads them: Codex resolves a permission mode from five
    /// configuration values and names a service tier, Claude names its mode
    /// outright and says whether fast mode is on. Only the four values the
    /// composer shows come back.
    pub(crate) fn read_settings(&self, settings: &BTreeMap<String, Value>) -> TurnOptions {
        match self {
            Self::Codex(_) => TurnOptions {
                model: settings
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                effort: settings
                    .get("reasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                fast_mode: is_fast_service_tier(
                    settings.get("serviceTier").and_then(Value::as_str),
                ),
                permission_mode: codex_permission_mode_name(settings),
            },
            Self::Claude(_) => TurnOptions {
                model: settings
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                effort: settings
                    .get("reasoningEffort")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                fast_mode: settings
                    .get("fastMode")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                permission_mode: settings
                    .get("permissionMode")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            },
        }
    }

    /// The models this agent offers, in the order to show them.
    pub(crate) async fn models(&self) -> Result<Vec<ModelOption>, CodexThreadError> {
        match self {
            Self::Codex(client) => codex_models(client).await,
            Self::Claude(claude) => Ok(claude.client.models().await?),
        }
    }

    /// Begin a conversation for work in `cwd`.
    pub(crate) async fn start_conversation(
        &self,
        cwd: &str,
        options: &AcceptedTurnOptions,
    ) -> Result<StartedConversation, CodexThreadError> {
        match self {
            Self::Codex(client) => {
                let codex = options.codex()?;
                let started = client
                    .start_thread(
                        cwd,
                        codex.permission_mode,
                        codex
                            .service_tier
                            .as_deref()
                            .unwrap_or_else(|| service_tier_for_fast_mode(false)),
                    )
                    .await?;
                Ok(StartedConversation {
                    settings: TurnOptions {
                        model: started.model.clone(),
                        effort: started.reasoning_effort.clone(),
                        fast_mode: started.fast_mode,
                        permission_mode: started.permission_mode.map(codex_mode_id),
                    },
                    conversation: Conversation::from(&started.thread),
                })
            }
            Self::Claude(claude) => {
                let agreed = options.claude()?;
                let conversation = claude.client.start_conversation(cwd, agreed).await?;
                Ok(StartedConversation {
                    conversation,
                    settings: options.applied.clone(),
                })
            }
        }
    }

    /// Begin a turn on options the agent has already agreed to.
    pub(crate) async fn start_turn(
        &self,
        conversation_id: &str,
        cwd: &str,
        prompt: &str,
        images: &[String],
        options: &AcceptedTurnOptions,
    ) -> Result<StartedTurn, CodexThreadError> {
        match self {
            Self::Codex(client) => {
                let started = client
                    .start_turn(
                        conversation_id,
                        cwd,
                        prompt,
                        images,
                        options.codex()?.clone(),
                    )
                    .await?;
                Ok(StartedTurn {
                    turn: Turn::from(&started.turn),
                    applied: options.applied.clone(),
                })
            }
            Self::Claude(claude) => {
                let turn = claude
                    .client
                    .start_turn(conversation_id, prompt, images, options.claude()?)
                    .await?;
                Ok(StartedTurn {
                    turn,
                    applied: options.applied.clone(),
                })
            }
        }
    }

    /// Add to a turn already running, without starting another.
    pub(crate) async fn steer_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
        prompt: &str,
        images: &[String],
    ) -> Result<(), CodexThreadError> {
        match self {
            Self::Codex(client) => client
                .steer_turn(conversation_id, turn_id, prompt, images)
                .await
                .map(|_| ()),
            Self::Claude(claude) => Ok(claude
                .client
                .steer_turn(conversation_id, turn_id, prompt, images)
                .await?),
        }
    }

    /// Stop a turn where it stands.
    pub(crate) async fn interrupt_turn(
        &self,
        conversation_id: &str,
        turn_id: &str,
    ) -> Result<(), CodexThreadError> {
        match self {
            Self::Codex(client) => client.interrupt_turn(conversation_id, turn_id).await,
            Self::Claude(claude) => Ok(claude.client.interrupt_turn(conversation_id).await?),
        }
    }

    /// The ways a person can let this agent work, here, with this model.
    ///
    /// The model matters to one agent and not the other. Codex resolves the
    /// modes from the profiles a workspace allows and who reviews; Claude has
    /// one mode — the model deciding for itself — that only some models can do.
    pub(crate) async fn permission_modes(
        &self,
        cwd: &str,
        model: Option<&str>,
    ) -> Result<PermissionModes, CodexThreadError> {
        match self {
            Self::Codex(client) => {
                let (default_mode, options) = codex_permission_modes(client, cwd).await?;
                Ok(PermissionModes {
                    default_mode,
                    options,
                })
            }
            Self::Claude(claude) => Ok(claude.client.permission_modes(model).await),
        }
    }

    /// Open a conversation, and watch it from here on.
    ///
    /// Opening is what starts the watching; there is no separate step, and
    /// [`Driver::stop_watching`] is what ends it. `with_turns` asks for the most
    /// recent turns in the same answer, which a reader about to show the
    /// conversation wants and a caller about to send a prompt does not.
    ///
    /// How fast the agent should work is Caffold's word for it. What that means
    /// to the agent — a service tier, a model, nothing at all — the agent
    /// decides.
    pub(crate) async fn open_conversation(
        &self,
        conversation_id: &str,
        with_turns: bool,
        fast_mode: bool,
    ) -> Result<OpenedConversation, CodexThreadError> {
        match self {
            Self::Codex(client) => {
                let response = client
                    .resume_thread_with_page(
                        conversation_id,
                        with_turns,
                        service_tier_for_fast_mode(fast_mode),
                    )
                    .await?;
                Ok(OpenedConversation {
                    conversation: Conversation::from(&response.thread),
                    turns_page: response.initial_turns_page.as_ref().map(TurnPage::from),
                    cwd: response.cwd,
                    settings: response.extra,
                })
            }
            Self::Claude(claude) => {
                let options = ClaudeTurnOptions {
                    fast_mode,
                    ..ClaudeTurnOptions::default()
                };
                let conversation = claude
                    .client
                    .open_conversation(conversation_id, &claude.cwd, &options)
                    .await?;
                let turns_page = with_turns.then(|| TurnPage {
                    // Newest first, which is the order history is read in.
                    turns: conversation.turns.iter().rev().cloned().collect(),
                    // Everything this session has said is here. Older turns
                    // live in the agent's transcript, which nothing reads yet.
                    next_cursor: None,
                    backwards_cursor: None,
                });
                Ok(OpenedConversation {
                    settings: claude.client.settings_of(conversation_id).await,
                    cwd: conversation.cwd.clone(),
                    conversation,
                    turns_page,
                })
            }
        }
    }

    /// Read a page of turns, continuing from a cursor the agent gave out.
    pub(crate) async fn read_turns(
        &self,
        conversation_id: &str,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<TurnPage, CodexThreadError> {
        match self {
            Self::Codex(client) => Ok(TurnPage::from(
                &client
                    .list_thread_turns(conversation_id, cursor, limit)
                    .await?,
            )),
            // A cursor is only ever one this agent gave out, and it gives out
            // none, so there is nothing further to read.
            Self::Claude(_) => Ok(TurnPage::default()),
        }
    }

    /// Stop watching a conversation. It carries on without an audience.
    pub(crate) async fn stop_watching(
        &self,
        conversation_id: &str,
    ) -> Result<(), CodexThreadError> {
        match self {
            Self::Codex(client) => client.unsubscribe_thread(conversation_id).await.map(|_| ()),
            Self::Claude(claude) => Ok(claude.client.stop_watching(conversation_id).await?),
        }
    }
}

/// What Codex will accept for a turn, given what the person asked for.
///
/// Codex answers depth and speed per model — a model has its own reasoning
/// efforts and its own faster tier, or none — so the model list has to be read
/// before either can be honoured. Nothing is asked of Codex when there is
/// nothing to check.
impl CodexThreadClient {
    /// This client as the agent it drives.
    pub(crate) fn driver(&self) -> Driver {
        Driver::Codex(self.clone())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::agent::codex::MockCodexResponse;

    fn conversation_answer() -> Value {
        json!({
            "cwd": "/Users/example/project",
            "thread": {
                "id": "thread_1",
                "preview": "Task",
                "status": { "type": "idle" },
                "cwd": "/Users/example/project",
                "createdAt": 1.0,
                "updatedAt": 2.0,
                "turns": []
            },
            "initialTurnsPage": {
                "data": [{
                    "id": "turn_1",
                    "items": [],
                    "itemsView": "full",
                    "status": "completed",
                    "startedAt": 1.0
                }],
                "nextCursor": "older-1",
                "backwardsCursor": null
            },
            "model": "gpt-5.6-sol"
        })
    }

    fn codex(responses: Vec<MockCodexResponse>) -> CodexThreadClient {
        CodexThreadClient::mock(responses)
    }

    #[tokio::test]
    async fn how_fast_to_work_reaches_the_agent_in_the_agents_own_terms() {
        // Fast mode is Caffold's word. Codex answers it with a service tier,
        // and deciding that is the driver's job rather than the caller's.
        for (fast_mode, tier) in [(true, "priority"), (false, "default")] {
            let client = codex(vec![MockCodexResponse::ok(
                "thread/resume",
                conversation_answer(),
            )]);

            client
                .driver()
                .open_conversation("thread_1", true, fast_mode)
                .await
                .expect("the conversation opens");

            let requests = client.mock_requests().await;
            assert_eq!(requests[0].0, "thread/resume");
            assert_eq!(
                requests[0].1["serviceTier"], tier,
                "fast mode {fast_mode} must reach Codex as the tier Codex calls it"
            );
        }
    }

    #[tokio::test]
    async fn a_caller_with_nothing_to_show_does_not_ask_for_the_turns() {
        // Sending a prompt needs the conversation, not its history. Asking for
        // turns nobody will read costs the person waiting for the prompt.
        let mut answer = conversation_answer();
        answer["initialTurnsPage"] = Value::Null;
        let client = codex(vec![MockCodexResponse::ok("thread/resume", answer)]);

        let opened = client
            .driver()
            .open_conversation("thread_1", false, false)
            .await
            .expect("the conversation opens");

        let requests = client.mock_requests().await;
        assert_eq!(requests[0].1["initialTurnsPage"], Value::Null);
        assert!(opened.turns_page.is_none());
    }

    #[tokio::test]
    async fn an_opened_conversation_arrives_in_caffolds_shape() {
        let client = codex(vec![MockCodexResponse::ok(
            "thread/resume",
            conversation_answer(),
        )]);

        let opened = client
            .driver()
            .open_conversation("thread_1", true, false)
            .await
            .expect("the conversation opens");

        assert_eq!(opened.conversation.id, "thread_1");
        assert_eq!(opened.cwd, "/Users/example/project");
        let page = opened.turns_page.expect("the turns were asked for");
        assert_eq!(page.turns.len(), 1);
        assert_eq!(page.next_cursor.as_deref(), Some("older-1"));
        // Settings cross unread: what a model or a permission mode means across
        // agents is not Caffold's to say yet.
        assert_eq!(opened.settings["model"], json!("gpt-5.6-sol"));
    }

    #[tokio::test]
    async fn reading_older_turns_carries_the_cursor_the_agent_gave_out() {
        let client = codex(vec![MockCodexResponse::ok(
            "thread/turns/list",
            json!({ "data": [], "nextCursor": null, "backwardsCursor": null }),
        )]);

        let page = client
            .driver()
            .read_turns("thread_1", Some("older-1"), 8)
            .await
            .expect("the turns are read");

        let requests = client.mock_requests().await;
        assert_eq!(requests[0].0, "thread/turns/list");
        assert_eq!(requests[0].1["cursor"], json!("older-1"));
        assert!(page.turns.is_empty());
    }

    #[tokio::test]
    async fn giving_up_the_audience_reaches_the_agent() {
        let client = codex(vec![MockCodexResponse::ok(
            "thread/unsubscribe",
            json!({ "status": "unsubscribed" }),
        )]);

        client
            .driver()
            .stop_watching("thread_1")
            .await
            .expect("watching stops");

        let requests = client.mock_requests().await;
        assert_eq!(requests[0].0, "thread/unsubscribe");
        assert_eq!(requests[0].1["threadId"], json!("thread_1"));
    }
}
