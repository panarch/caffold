//! What this installation offers, and bringing a session to what was chosen.
//!
//! The model list and the permission modes are answered without a Task, and
//! a choice made after a session started — model, depth, speed, mode — is
//! carried to the running agent, so the composer and the conversation never
//! say two different things.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Value, json};
use tokio::sync::oneshot;

use super::protocol::{BASE_ARGUMENTS, StreamFrame};
use super::{
    ANSWER_TIMEOUT, ClaudeClient, ClaudeError, ClaudeTurnOptions, Introduction, ModelOption,
    PermissionModeOption, PermissionModes, Session, SessionEventKind, SessionState, protocol,
};

impl ClaudeClient {
    /// Bring the session to the settings a person has chosen.
    ///
    /// A Claude session takes its settings as arguments when it starts, so a
    /// choice made afterwards has to reach the running agent — otherwise the
    /// composer would show one thing and the conversation would run another.
    ///
    /// Most are control requests, which answer and are done with. Depth is a
    /// command the agent runs, so it takes a turn of its own, and that turn has
    /// to end before the person's begins. There is always room for it: settings
    /// are locked while a turn is running, so a choice can only have been made
    /// between turns.
    ///
    /// Speed is asked for rather than set. The agent reports what it actually
    /// reached in every `system/init`, and an installation whose account has no
    /// extra usage stays at its ordinary speed however often it is asked.
    pub(super) async fn apply_settings(
        &self,
        session: &Arc<Session>,
        options: &ClaudeTurnOptions,
    ) -> Result<(), ClaudeError> {
        let (model_change, mode_change, effort_change, fast_mode_change) = {
            let state = session.state.lock().await;
            (
                changed(&state.model, &options.model),
                changed(&state.permission_mode, &options.permission_mode),
                changed(&state.effort, &options.effort),
                (state.fast_mode_requested != options.fast_mode).then_some(options.fast_mode),
            )
        };
        let changed_anything = model_change.is_some()
            || mode_change.is_some()
            || effort_change.is_some()
            || fast_mode_change.is_some();
        if let Some(model) = model_change {
            session
                .control(json!({ "subtype": "set_model", "model": model }))
                .await?;
            session.state.lock().await.model = Some(model);
        }
        if let Some(mode) = mode_change {
            session
                .control(json!({ "subtype": "set_permission_mode", "mode": mode }))
                .await?;
            session.state.lock().await.permission_mode = Some(mode);
        }
        if let Some(effort) = effort_change {
            self.ask_quietly(session, &format!("/effort {effort}"))
                .await?;
            session.state.lock().await.effort = Some(effort);
        }
        if let Some(fast_mode) = fast_mode_change {
            session
                .control(json!({
                    "subtype": "apply_flag_settings",
                    "settings": { "fastMode": fast_mode },
                }))
                .await?;
            session.state.lock().await.fast_mode_requested = fast_mode;
        }
        if changed_anything {
            let settings = self.settings_of_session(session).await;
            self.report(&session.id, SessionEventKind::SettingsChanged { settings });
        }
        Ok(())
    }

    /// Ask the agent something the conversation should not show.
    ///
    /// The answer is a turn like any other, and it is waited for: what follows
    /// is the person's turn, and a `result` arriving late would close theirs
    /// instead of this one.
    async fn ask_quietly(&self, session: &Arc<Session>, text: &str) -> Result<(), ClaudeError> {
        let (sender, receiver) = oneshot::channel();
        session.state.lock().await.quiet_turn = Some(sender);
        if let Err(error) = session.send(protocol::user_message(text, &[])).await {
            // Left standing, it would swallow the answer to the next turn.
            session.state.lock().await.quiet_turn = None;
            return Err(error);
        }
        match tokio::time::timeout(ANSWER_TIMEOUT, receiver).await {
            Ok(_) => Ok(()),
            Err(_) => {
                session.state.lock().await.quiet_turn = None;
                Err(ClaudeError::Protocol(format!(
                    "claude did not answer {text} within {} seconds",
                    ANSWER_TIMEOUT.as_secs()
                )))
            }
        }
    }

    /// The models this installation offers.
    ///
    /// The agent answers this over the control protocol, which means a process.
    /// There is no daemon to ask, so one is started for the question and the
    /// answer is kept.
    pub(crate) async fn models(&self) -> Result<Vec<ModelOption>, ClaudeError> {
        if let Some(cached) = self.inner.models.lock().await.clone() {
            return Ok(cached);
        }
        let answer = ask_one_off(json!({ "subtype": "list_models" })).await?;
        let models = model_options(&answer);
        *self.inner.models.lock().await = Some(models.clone());
        Ok(models)
    }

    /// Whether the model a person chose can decide permissions for itself.
    ///
    /// Read from the list the agent published. An installation whose list could
    /// not be read offers no such model, so the mode is withheld rather than
    /// offered and refused at the moment a turn starts.
    async fn model_supports_auto_mode(&self, model: Option<&str>) -> bool {
        let Some(model) = model else {
            return false;
        };
        self.models()
            .await
            .unwrap_or_default()
            .iter()
            .any(|offered| offered.model == model && offered.supports_auto_mode)
    }

    /// Answer the model list from here rather than from a process.
    ///
    /// The cache is the real field, so a test that fills it exercises the same
    /// path a second call in production takes.
    #[cfg(test)]
    pub(crate) async fn offer_models(&self, models: Vec<ModelOption>) {
        *self.inner.models.lock().await = Some(models);
    }

    /// The ways a person can let this agent work, with this model.
    ///
    /// Named here rather than asked, because the agent does not offer a list:
    /// the modes are a fixed part of its permission model, and what each one
    /// gives up is knowledge that belongs to whoever drives it.
    ///
    /// All but one are fixed. Letting the model decide for itself is something
    /// only some models can do, so it is offered when the chosen one can and
    /// withheld — visibly — when it cannot. A model this installation does not
    /// list is treated as unable, which is the safe direction: the mode that
    /// asks a person is the one that stays.
    ///
    /// That mode is also what this agent works under by default, the way it
    /// does when a person runs it themselves. A model that cannot falls back to
    /// asking, because a default nobody can use is not a default.
    pub(crate) async fn permission_modes(&self, model: Option<&str>) -> PermissionModes {
        let auto = self.model_supports_auto_mode(model).await;
        PermissionModes {
            default_mode: if auto { "auto" } else { "default" }.to_string(),
            options: vec![
                {
                    let mut mode = option(
                        "auto",
                        "Automatic",
                        "The model decides what needs asking about, and asks only for that.",
                        false,
                    );
                    mode.allowed = auto;
                    mode.unavailable_reason = (!auto)
                        .then(|| "This model cannot decide permissions for itself.".to_string());
                    mode
                },
                option(
                    "default",
                    "Ask each time",
                    "Stops for permission before every tool call it is not sure about.",
                    false,
                ),
                option(
                    "acceptEdits",
                    "Accept edits",
                    "Edits files without asking. Still stops for commands and anything reaching outside the workspace.",
                    false,
                ),
                option(
                    "plan",
                    "Plan only",
                    "Reads and reasons, and changes nothing until you accept a plan.",
                    false,
                ),
                option(
                    "bypassPermissions",
                    "Full access",
                    "Never asks. Every tool call runs, including ones that reach outside the workspace.",
                    true,
                ),
            ],
        }
    }

    /// What the agent says its settings for this conversation are, with the
    /// model and mode named the way they were chosen.
    pub(super) async fn settings_of_session(
        &self,
        session: &Arc<Session>,
    ) -> BTreeMap<String, Value> {
        let state = session.state.lock().await;
        let introduction = state.introduction.clone().unwrap_or_default();
        settings_map(&introduction, &state)
    }

    /// What the agent says its settings for this conversation are, in its own
    /// words.
    pub(crate) async fn settings_of(&self, conversation_id: &str) -> BTreeMap<String, Value> {
        let Some(session) = self.session(conversation_id).await else {
            return BTreeMap::new();
        };
        self.settings_of_session(&session).await
    }
}

fn option(mode: &str, label: &str, description: &str, dangerous: bool) -> PermissionModeOption {
    PermissionModeOption {
        mode: mode.to_string(),
        label: label.to_string(),
        description: description.to_string(),
        allowed: true,
        unavailable_reason: None,
        dangerous,
    }
}

/// What the agent says about itself, left in its own words.
fn settings_map(introduction: &Introduction, state: &SessionState) -> BTreeMap<String, Value> {
    let mut settings = BTreeMap::new();
    // The name it was chosen by, and nothing when Caffold did not choose. The
    // agent answers with what it resolved the choice to, which is the same
    // model under a name the list a person picked from does not contain — so
    // saying it would replace their choice with something the picker cannot
    // find. A session Caffold resumed rather than started has no such name, and
    // what the Task last ran under is the store's to remember.
    // What a person chose. A session Caffold resumed rather than started has no
    // such name, and the agent's own answer would be the resolved one — a model
    // under a name the list a person picked from does not contain — so nothing
    // is said and what the Task last ran under is the store's to remember.
    if let Some(model) = &state.model {
        settings.insert("model".to_string(), json!(model));
    }
    // What a person chose, and the agent's own answer only until they have.
    if let Some(mode) = state
        .permission_mode
        .as_ref()
        .or(introduction.permission_mode.as_ref())
    {
        settings.insert("permissionMode".to_string(), json!(mode));
    }
    if let Some(effort) = &state.effort {
        settings.insert("reasoningEffort".to_string(), json!(effort));
    }
    // What the agent reached, not what was asked for.
    settings.insert("fastMode".to_string(), json!(introduction.fast_mode));
    if let Some(reason) = &introduction.fast_mode_blocked {
        settings.insert("fastModeBlockedReason".to_string(), json!(reason));
    }
    if let Some(version) = &introduction.version {
        settings.insert("version".to_string(), json!(version));
    }
    if !introduction.capabilities.is_empty() {
        settings.insert("capabilities".to_string(), json!(introduction.capabilities));
    }
    settings
}

/// What a session has to be told, or nothing when it already runs that way.
fn changed(current: &Option<String>, wanted: &Option<String>) -> Option<String> {
    let wanted = wanted.as_deref()?;
    (current.as_deref() != Some(wanted)).then(|| wanted.to_string())
}

/// The models the agent listed, in Caffold's words.
fn model_options(answer: &Value) -> Vec<ModelOption> {
    let Some(models) = answer.get("models").and_then(Value::as_array) else {
        return Vec::new();
    };
    models
        .iter()
        .filter_map(|model| {
            let value = model.get("value")?.as_str()?.to_string();
            let efforts = model
                .get("supportedEffortLevels")
                .and_then(Value::as_array)
                .map(|levels| {
                    levels
                        .iter()
                        .filter_map(|level| level.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(ModelOption {
                display_name: model
                    .get("displayName")
                    .and_then(Value::as_str)
                    .unwrap_or(&value)
                    .to_string(),
                description: model
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                // The agent names its recommendation `default` rather than
                // marking one, so that name is the mark.
                is_default: value == "default",
                default_effort: None,
                supports_fast_mode: model
                    .get("supportsFastMode")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                supports_auto_mode: model
                    .get("supportsAutoMode")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                efforts,
                model: value,
            })
        })
        .collect()
}

/// Ask a question that needs no conversation.
///
/// The model list and the usage report are the ones so far. Each costs a
/// process start and no tokens, and there is no daemon holding the answer, so
/// a process is started for the question and ended with it.
pub(super) async fn ask_one_off(body: Value) -> Result<Value, ClaudeError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let mut child = tokio::process::Command::new("claude")
        .args(BASE_ARGUMENTS.iter().filter(|argument| {
            // The permission callback needs a conversation to belong to.
            !matches!(**argument, "--permission-prompt-tool" | "stdio")
        }))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| ClaudeError::Runner(format!("could not start claude: {error}")))?;

    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| ClaudeError::Runner("claude has no stdin".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| ClaudeError::Runner("claude has no stdout".to_string()))?;

    let request_id = "caffold-ask";
    let line = format!("{}\n", protocol::control_request(request_id, body));
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|error| ClaudeError::Runner(error.to_string()))?;
    stdin
        .flush()
        .await
        .map_err(|error| ClaudeError::Runner(error.to_string()))?;

    let mut lines = BufReader::new(stdout).lines();
    let answer = tokio::time::timeout(ANSWER_TIMEOUT, async {
        loop {
            let Some(line) = lines
                .next_line()
                .await
                .map_err(|error| ClaudeError::Runner(error.to_string()))?
            else {
                break Err(ClaudeError::Protocol(
                    "claude ended without answering".to_string(),
                ));
            };
            let Ok(StreamFrame::ControlResponse(response)) =
                serde_json::from_str::<StreamFrame>(&line)
            else {
                continue;
            };
            if response.response.request_id != request_id {
                continue;
            }
            break response
                .response
                .into_result()
                .map(|answer| answer.payload)
                .map_err(ClaudeError::Agent);
        }
    })
    .await
    .unwrap_or_else(|_| {
        Err(ClaudeError::Protocol(format!(
            "claude did not answer within {} seconds",
            ANSWER_TIMEOUT.as_secs()
        )))
    });
    let _ = child.start_kill();
    answer
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;

    use super::super::test_support::*;
    use super::super::*;
    use super::*;

    #[tokio::test]
    async fn a_model_chosen_after_the_session_started_is_told_to_the_agent() {
        // The session took its model as an argument when it started, so a
        // later choice reaches it only by being said. Without this the composer
        // shows one model and the conversation runs another.
        let (client, runner, mut events) = watching().await;

        client
            .start_turn(SESSION, "run it", &[], &options("haiku"))
            .await
            .expect("the turn starts");

        let told = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "set_model")
            .expect("the agent is told");
        assert_eq!(told["request"]["model"], "haiku");
        let SessionEventKind::SettingsChanged { settings } =
            next_session_event(&mut events, "settings").await
        else {
            unreachable!("asked for settings");
        };
        assert_eq!(
            settings["model"], "haiku",
            "and the conversation reports the name it was chosen by, not the one the agent resolved"
        );
    }

    #[tokio::test]
    async fn a_depth_chosen_after_the_session_started_is_asked_for_and_waited_on() {
        // Depth is a command the agent runs, so it takes a turn of its own.
        // Opening the person's turn before that one ends would let its answer
        // close theirs.
        let (client, runner, mut events) = watching().await;

        let turn = tokio::spawn({
            let client = client.clone();
            async move {
                client
                    .start_turn(
                        SESSION,
                        "run it",
                        &[],
                        &ClaudeTurnOptions {
                            effort: Some("xhigh".to_string()),
                            ..options("opus")
                        },
                    )
                    .await
            }
        });

        let asked = tokio::time::timeout(REPORT_TIMEOUT, async {
            loop {
                if let Some(frame) = runner
                    .heard(SESSION)
                    .await
                    .into_iter()
                    .find(|frame| frame["type"] == "user")
                {
                    return frame;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("the agent is asked");
        assert_eq!(asked["message"]["content"][0]["text"], "/effort xhigh");
        assert!(!turn.is_finished(), "the prompt waits for the answer");

        runner.say(SESSION, result_frame(Some("end_turn"))).await;
        let started = tokio::time::timeout(REPORT_TIMEOUT, turn)
            .await
            .expect("the turn stops waiting")
            .expect("the task finishes")
            .expect("the turn starts");

        let prompts = spoken(&runner).await;
        assert_eq!(prompts, ["/effort xhigh", "run it"], "in that order");

        // The answer to the command is not the answer to the turn.
        assert_eq!(started.status, TurnStatus::InProgress);
        let SessionEventKind::TurnStarted { turn } =
            next_session_event(&mut events, "turn start").await
        else {
            unreachable!("asked for a turn start");
        };
        assert_eq!(turn.id, started.id);
    }

    #[tokio::test]
    async fn asking_for_speed_reaches_the_agent_and_reports_what_it_reached() {
        // Asking is not getting. An installation whose account has no extra
        // usage stays at its ordinary speed however often it is asked, and the
        // conversation should say what the agent reached rather than what was
        // wanted.
        let (client, runner, mut events) = watching().await;

        client
            .start_turn(
                SESSION,
                "run it",
                &[],
                &ClaudeTurnOptions {
                    fast_mode: true,
                    ..options("opus")
                },
            )
            .await
            .expect("the turn starts");

        let asked = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "apply_flag_settings")
            .expect("the agent is asked");
        assert_eq!(asked["request"]["settings"]["fastMode"], true);

        let SessionEventKind::SettingsChanged { settings } =
            next_session_event(&mut events, "settings").await
        else {
            unreachable!("asked for settings");
        };
        assert_eq!(
            settings["fastMode"], false,
            "the greeting said this session is not fast, and that is what stands"
        );
        assert_eq!(
            settings["fastModeBlockedReason"], "extra_usage_disabled",
            "and why, so it does not read as a choice that was ignored"
        );
    }

    #[tokio::test]
    async fn a_depth_the_session_already_works_at_is_not_asked_for_again() {
        let (client, runner, _events) = watching().await;

        client
            .start_turn(SESSION, "run it", &[], &options("opus"))
            .await
            .expect("the turn starts");

        assert_eq!(spoken(&runner).await, ["run it"]);
    }

    #[tokio::test]
    async fn a_model_the_session_already_runs_is_not_told_again() {
        let (client, runner, _events) = watching().await;

        client
            .start_turn(SESSION, "run it", &[], &options("opus"))
            .await
            .expect("the turn starts");

        assert!(
            !runner
                .heard(SESSION)
                .await
                .iter()
                .any(|frame| frame["request"]["subtype"] == "set_model"),
            "a session already running that model has nothing to be told"
        );
    }

    #[tokio::test]
    async fn a_permission_mode_chosen_after_the_session_started_is_told_to_the_agent() {
        let (client, runner, _events) = watching().await;

        client
            .start_turn(
                SESSION,
                "run it",
                &[],
                &ClaudeTurnOptions {
                    permission_mode: Some("acceptEdits".to_string()),
                    ..options("opus")
                },
            )
            .await
            .expect("the turn starts");

        let told = runner
            .heard(SESSION)
            .await
            .into_iter()
            .find(|frame| frame["request"]["subtype"] == "set_permission_mode")
            .expect("the agent is told");
        assert_eq!(told["request"]["mode"], "acceptEdits");
    }

    #[tokio::test]
    async fn a_model_the_agent_does_not_offer_is_refused_before_a_session_exists() {
        // Agreeing first is what stops a conversation being created under a
        // model that never existed and then left behind.
        let (client, _runner) = ClaudeClient::mock();
        client
            .offer_models(vec![ModelOption {
                model: "opus".to_string(),
                display_name: "Opus".to_string(),
                description: None,
                is_default: true,
                default_effort: None,
                efforts: vec!["low".to_string(), "high".to_string()],
                supports_fast_mode: true,
                supports_auto_mode: true,
            }])
            .await;

        let wrong_model = claude_turn_options(
            &client,
            &TurnOptions {
                model: Some("gpt-5.6-sol".to_string()),
                ..TurnOptions::default()
            },
        )
        .await;
        let wrong_effort = claude_turn_options(
            &client,
            &TurnOptions {
                model: Some("opus".to_string()),
                effort: Some("glacial".to_string()),
                ..TurnOptions::default()
            },
        )
        .await;

        assert!(matches!(wrong_model, Err(TurnRejected::Model)));
        assert!(matches!(wrong_effort, Err(TurnRejected::Effort)));
    }

    #[tokio::test]
    async fn asking_for_speed_a_model_does_not_have_settles_for_what_it_does() {
        let (client, _runner) = ClaudeClient::mock();
        client
            .offer_models(vec![ModelOption {
                model: "haiku".to_string(),
                display_name: "Haiku".to_string(),
                description: None,
                is_default: false,
                default_effort: None,
                efforts: Vec::new(),
                supports_fast_mode: false,
                supports_auto_mode: false,
            }])
            .await;

        let accepted = claude_turn_options(
            &client,
            &TurnOptions {
                model: Some("haiku".to_string()),
                fast_mode: true,
                ..TurnOptions::default()
            },
        )
        .await
        .expect("the model is real, so the turn is accepted");

        assert!(
            !accepted.fast_mode,
            "a model with no faster tier answers a request for speed with its ordinary one"
        );
    }

    /// A client whose list holds one model that can decide for itself and one
    /// that cannot.
    async fn client_offering_both_kinds() -> ClaudeClient {
        let (client, _runner) = ClaudeClient::mock();
        client
            .offer_models(vec![
                ModelOption {
                    model: "sonnet".to_string(),
                    display_name: "Sonnet".to_string(),
                    description: None,
                    is_default: true,
                    default_effort: None,
                    efforts: vec!["high".to_string()],
                    supports_fast_mode: false,
                    supports_auto_mode: true,
                },
                ModelOption {
                    model: "haiku".to_string(),
                    display_name: "Haiku".to_string(),
                    description: None,
                    is_default: false,
                    default_effort: None,
                    efforts: Vec::new(),
                    supports_fast_mode: false,
                    supports_auto_mode: false,
                },
            ])
            .await;
        client
    }

    #[tokio::test]
    async fn every_permission_mode_reaches_the_interface_already_named() {
        let modes = client_offering_both_kinds()
            .await
            .permission_modes(Some("sonnet"))
            .await;

        assert!(
            modes
                .options
                .iter()
                .any(|option| option.mode == modes.default_mode && option.allowed),
            "the default has to be one of the choices, and one that can be used"
        );
        assert!(
            modes
                .options
                .iter()
                .all(|option| !option.label.is_empty() && !option.description.is_empty())
        );
        assert!(
            modes
                .options
                .iter()
                .any(|option| option.dangerous && option.mode == "bypassPermissions"),
            "the mode that gives up a protection has to read as one"
        );
    }

    #[tokio::test]
    async fn letting_the_model_decide_is_offered_only_by_a_model_that_can() {
        // Measured against CLI 2.1.236: `set_permission_mode auto` is refused
        // with "auto mode unavailable for this model", and the model list says
        // in advance which models can. Offering it regardless would fail at the
        // moment a turn starts, which is the worst place to find out.
        let client = client_offering_both_kinds().await;

        let able = client.permission_modes(Some("sonnet")).await;
        let unable = client.permission_modes(Some("haiku")).await;
        let unknown = client.permission_modes(None).await;

        let auto = |modes: &PermissionModes| {
            modes
                .options
                .iter()
                .find(|option| option.mode == "auto")
                .map(|option| option.allowed)
        };
        assert_eq!(auto(&able), Some(true));
        assert_eq!(able.default_mode, "auto", "it is also how this agent works");
        assert_eq!(
            unable.default_mode, "default",
            "a default nobody can use is not a default"
        );
        assert_eq!(
            auto(&unable),
            Some(false),
            "withheld reads as withheld, not as missing"
        );
        assert_eq!(
            auto(&unknown),
            Some(false),
            "a model nobody named cannot be known to manage its own permissions"
        );
        assert_eq!(
            unable.options.len(),
            able.options.len(),
            "the same choices are shown either way"
        );
    }

    #[test]
    fn the_models_the_agent_lists_arrive_in_caffolds_words() {
        // Measured against CLI 2.1.236: the recommendation is named `default`
        // rather than marked, and only some models carry effort levels.
        let answer = json!({
            "models": [
                {
                    "value": "default",
                    "resolvedModel": "claude-opus-5[1m]",
                    "displayName": "Default (recommended)",
                    "description": "Opus 5 with 1M context",
                    "supportsEffort": true,
                    "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"],
                    "supportsFastMode": true
                },
                {
                    "value": "haiku",
                    "resolvedModel": "claude-haiku-4-5-20251001",
                    "displayName": "Haiku",
                    "description": "Fastest for quick answers"
                }
            ]
        });

        let models = model_options(&answer);

        assert_eq!(models.len(), 2);
        assert_eq!(models[0].model, "default");
        assert!(models[0].is_default);
        assert!(models[0].supports_fast_mode);
        assert_eq!(models[0].efforts, ["low", "medium", "high", "xhigh", "max"]);
        assert_eq!(models[1].model, "haiku");
        assert!(!models[1].is_default);
        assert!(models[1].efforts.is_empty());
        assert!(!models[1].supports_fast_mode);
    }
}
