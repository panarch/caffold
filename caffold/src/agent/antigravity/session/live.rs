//! One in-memory display conversation. ACP controls it; native history is a
//! frozen prefix, never a second writer for the prompts accepted here.
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use uuid::Uuid;

use super::super::{AntigravityError, protocol};
use crate::agent::{
    ActivityStatus, CommandExecution, ConversationItem, GeneratedImage, ItemKind, MessageContent,
    MessagePhase, SessionEventKind, TokenCount, TokenUsage, ToolCall, Turn, TurnOrigin, TurnPage,
    TurnState, TurnStatus,
};

pub(super) struct Live {
    epoch: String,
    // Newest first. Only the initial native page and this process's live turns
    // are retained; older native pages are read using their original cursor.
    turns: Vec<Turn>,
    native_next: Option<String>,
    active: Option<String>,
    tools: BTreeMap<String, Value>,
    chunk: Option<(String, usize)>,
    pending_start: bool,
    live_turns: usize,
    total_usage: Option<TokenCount>,
}

impl Live {
    pub(super) fn new(baseline: TurnPage) -> Self {
        Self {
            epoch: Uuid::new_v4().to_string(),
            turns: baseline.turns,
            native_next: baseline.next_cursor,
            active: None,
            tools: BTreeMap::new(),
            chunk: None,
            pending_start: false,
            live_turns: 0,
            total_usage: None,
        }
    }

    pub(super) fn set_baseline_usage(&mut self, usage: TokenCount) {
        self.total_usage = Some(usage);
    }

    pub(super) fn needs_rebuild(&self) -> bool {
        self.active.is_none()
            && (self.live_turns >= 8
                || self
                    .turns
                    .iter()
                    .map(|turn| turn.items.len())
                    .sum::<usize>()
                    >= 300)
    }

    pub(super) fn begin(&mut self, text: &str, content: Vec<MessageContent>) -> Turn {
        let id = format!("acp:{}:{}", self.epoch, Uuid::new_v4());
        let at = now_ms();
        let turn = Turn {
            id: id.clone(),
            origin: TurnOrigin::User,
            status: TurnStatus::InProgress,
            started_at_ms: Some(at),
            completed_at_ms: None,
            items: vec![ConversationItem {
                id: format!("{id}:prompt"),
                observed_at_ms: Some(at),
                status: ActivityStatus::Completed,
                kind: ItemKind::UserMessage {
                    text: text.into(),
                    content,
                },
            }],
        };
        self.active = Some(id);
        self.live_turns += 1;
        self.pending_start = true;
        self.chunk = None;
        self.tools.clear();
        self.turns.insert(0, turn.clone());
        turn
    }

    pub(super) fn reject(&mut self, id: &str) {
        if self.active.as_deref() == Some(id) {
            self.turns.retain(|turn| turn.id != id);
            self.active = None;
            self.live_turns = self.live_turns.saturating_sub(1);
            self.chunk = None;
            self.tools.clear();
            self.pending_start = false;
        }
    }

    pub(super) fn start_events(&mut self) -> Vec<SessionEventKind> {
        if !std::mem::take(&mut self.pending_start) {
            return vec![];
        }
        let turn = &self.turns[0];
        vec![
            SessionEventKind::TurnStarted {
                turn: TurnState::from(turn),
            },
            SessionEventKind::ItemChanged {
                turn_id: turn.id.clone(),
                item: turn.items[0].clone(),
                at_ms: turn.started_at_ms.unwrap_or(0),
            },
        ]
    }

    pub(super) fn read_page(
        &self,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Option<TurnPage>, AntigravityError> {
        let prefix = format!("acp:{}:page:", self.epoch);
        let start = match before {
            None => 0,
            Some(cursor) if cursor.starts_with(&prefix) => self
                .turns
                .iter()
                .position(|turn| cursor.strip_prefix(&prefix) == Some(turn.id.as_str()))
                .map(|index| index + 1)
                .ok_or_else(|| invalid("unknown display history cursor"))?,
            Some(cursor) if cursor.starts_with("acp:") => {
                return Err(invalid(
                    "this history page belongs to a discarded display conversation",
                ));
            }
            Some(_) => return Ok(None),
        };
        let end = (start + limit.clamp(1, 100)).min(self.turns.len());
        Ok(Some(TurnPage {
            turns: self.turns[start..end].to_vec(),
            next_cursor: if end < self.turns.len() {
                Some(format!("{prefix}{}", self.turns[end - 1].id))
            } else {
                self.native_next.clone()
            },
            backwards_cursor: None,
        }))
    }

    pub(super) fn active_ids(&self, tool: &str) -> Option<(String, String)> {
        let turn = self.active.as_ref()?;
        Some((turn.clone(), format!("{turn}:tool:{tool}")))
    }

    pub(super) fn update(
        &mut self,
        update: &Value,
    ) -> Result<Vec<SessionEventKind>, AntigravityError> {
        let kind = protocol::required_string(update, "sessionUpdate")?;
        let Some(id) = self.active.clone() else {
            return Ok(vec![]);
        };
        let turn = self
            .turns
            .iter_mut()
            .find(|turn| turn.id == id)
            .expect("active display turn");
        let at = now_ms();
        let index = match kind {
            "agent_message_chunk" | "agent_thought_chunk" => {
                let content = &update["content"];
                if content["type"].as_str() != Some("text") {
                    return Ok(vec![]);
                }
                let text = protocol::required_string(content, "text")?;
                let index = match &self.chunk {
                    Some((previous, index)) if previous == kind => *index,
                    _ => {
                        let index = turn.items.len();
                        turn.items.push(ConversationItem {
                            id: format!("{id}:item:{index}"),
                            observed_at_ms: Some(at),
                            status: ActivityStatus::InProgress,
                            kind: if kind == "agent_thought_chunk" {
                                ItemKind::Reasoning {
                                    summary: vec![],
                                    content: vec![String::new()],
                                }
                            } else {
                                ItemKind::AssistantMessage {
                                    text: String::new(),
                                    phase: Some(MessagePhase::Progress),
                                    suggested_prompts: vec![],
                                }
                            },
                        });
                        self.chunk = Some((kind.into(), index));
                        index
                    }
                };
                match &mut turn.items[index].kind {
                    ItemKind::AssistantMessage { text: value, .. } => value.push_str(text),
                    ItemKind::Reasoning { content, .. } => content[0].push_str(text),
                    _ => unreachable!("chunk owns its item"),
                }
                index
            }
            "tool_call" | "tool_call_update" => {
                self.chunk = None;
                let tool = protocol::required_string(update, "toolCallId")?;
                let full = self
                    .tools
                    .entry(tool.into())
                    .or_insert_with(|| serde_json::json!({}));
                for (key, value) in update
                    .as_object()
                    .ok_or_else(|| invalid("invalid tool update"))?
                {
                    if !value.is_null() {
                        full[key] = value.clone();
                    }
                }
                let item_id = format!("{id}:tool:{tool}");
                let previous = turn.items.iter().position(|item| item.id == item_id);
                let item = tool_item(full, item_id, previous.map(|i| &turn.items[i]), at)?;
                match previous {
                    Some(index) => {
                        turn.items[index] = item;
                        index
                    }
                    None => {
                        turn.items.push(item);
                        turn.items.len() - 1
                    }
                }
            }
            _ => return Ok(vec![]),
        };
        Ok(vec![SessionEventKind::ItemChanged {
            turn_id: id,
            item: turn.items[index].clone(),
            at_ms: at,
        }])
    }

    pub(super) fn finish(
        &mut self,
        result: &Result<Value, AntigravityError>,
    ) -> Vec<SessionEventKind> {
        let Some(id) = self.active.take() else {
            return vec![];
        };
        let turn = self
            .turns
            .iter_mut()
            .find(|turn| turn.id == id)
            .expect("active display turn");
        let at = now_ms();
        turn.status = match result {
            Ok(value) if value["stopReason"].as_str() == Some("cancelled") => {
                TurnStatus::Interrupted
            }
            Ok(_) => TurnStatus::Completed,
            Err(_) => TurnStatus::Failed,
        };
        turn.completed_at_ms = Some(at);
        if let Err(error) = result {
            turn.items.push(ConversationItem {
                id: format!("{id}:failure"),
                observed_at_ms: Some(at),
                status: ActivityStatus::Failed,
                kind: ItemKind::Failure {
                    text: error.to_string(),
                },
            });
        }
        let last_answer = turn
            .items
            .iter()
            .rposition(|item| matches!(item.kind, ItemKind::AssistantMessage { .. }));
        for (index, item) in turn.items.iter_mut().enumerate() {
            if item.status == ActivityStatus::InProgress {
                item.status = if turn.status == TurnStatus::Completed {
                    ActivityStatus::Completed
                } else {
                    ActivityStatus::Failed
                };
            }
            if Some(index) == last_answer
                && turn.status == TurnStatus::Completed
                && let ItemKind::AssistantMessage { phase, .. } = &mut item.kind
            {
                *phase = Some(MessagePhase::Final);
            }
        }
        let mut events = turn
            .items
            .iter()
            .map(|item| SessionEventKind::ItemChanged {
                turn_id: id.clone(),
                item: item.clone(),
                at_ms: at,
            })
            .collect::<Vec<_>>();
        if let Ok(result) = result
            && let Some(usage) = turn_usage(&result["usage"])
            && let Some(total) = &mut self.total_usage
        {
            total.total_tokens += usage.total_tokens;
            total.input_tokens += usage.input_tokens;
            total.cached_input_tokens += usage.cached_input_tokens;
            total.cache_write_input_tokens += usage.cache_write_input_tokens;
            total.output_tokens += usage.output_tokens;
            total.reasoning_output_tokens += usage.reasoning_output_tokens;
            events.push(SessionEventKind::UsageReported {
                turn_id: id.clone(),
                usage: TokenUsage {
                    total: total.clone(),
                    last: usage,
                    model_context_window: None,
                },
            });
        }
        events.push(SessionEventKind::TurnEnded {
            turn: TurnState::from(&*turn),
        });
        self.tools.clear();
        self.chunk = None;
        events
    }
}

fn tool_item(
    value: &Value,
    id: String,
    previous: Option<&ConversationItem>,
    at: u64,
) -> Result<ConversationItem, AntigravityError> {
    let status = match value["status"].as_str() {
        Some("pending" | "in_progress") | None => ActivityStatus::InProgress,
        Some("completed") => ActivityStatus::Completed,
        Some("failed") => ActivityStatus::Failed,
        _ => return Err(invalid("unknown ACP tool status")),
    };
    let title = value["title"].as_str().unwrap_or("Tool").to_string();
    let input = &value["rawInput"];
    let output = &value["rawOutput"];
    let image = value["content"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|content| (content["content"]["type"] == "image").then_some(&content["content"]));
    let kind = if output["imagePath"]
        .as_str()
        .is_some_and(|path| !path.is_empty())
        || image.is_some()
    {
        ItemKind::GeneratedImage(GeneratedImage {
            saved_path: output["imagePath"]
                .as_str()
                .filter(|path| !path.is_empty())
                .map(str::to_string),
            encoded: image
                .and_then(|image| image["data"].as_str())
                .map(str::to_string),
            revised_prompt: output["prompt"].as_str().map(str::to_string),
        })
    } else {
        match value["kind"].as_str() {
            Some("execute") => ItemKind::CommandExecution(CommandExecution {
                command: input["CommandLine"]
                    .as_str()
                    .or_else(|| input["command_line"].as_str())
                    .or_else(|| input["command"].as_str())
                    .map(str::to_string),
                cwd: input["working_dir"]
                    .as_str()
                    .or_else(|| input["cwd"].as_str())
                    .or_else(|| input["Cwd"].as_str())
                    .or_else(|| output["workingDir"].as_str())
                    .map(str::to_string),
                output: output["combinedOutput"]
                    .as_str()
                    .or_else(|| output.as_str())
                    .map(str::to_string),
                exit_code: output["exitCode"]
                    .as_i64()
                    .or_else(|| output["exit_code"].as_i64()),
                duration_ms: None,
                background_task: None,
            }),
            Some("edit" | "delete" | "move") => ItemKind::FileChange {
                paths: value["locations"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|location| location["path"].as_str().map(str::to_string))
                    .collect(),
            },
            _ => tool_call(value, title),
        }
    };
    Ok(ConversationItem {
        id,
        observed_at_ms: previous.and_then(|item| item.observed_at_ms).or(Some(at)),
        status,
        kind,
    })
}

/// A tool call from the frames merged so far. An MCP call names its tool and
/// server in `_meta.mcp` and carries its arguments twice in `rawInput`, spread
/// out and once more under `arguments`; the latter is the shape the native
/// record keeps. The server fills a finished call's `rawOutput` with the step's
/// summary, such as "List notes", rather than what the tool returned, so the
/// call has no result here; reading the native record brings the result.
fn tool_call(value: &Value, title: String) -> ItemKind {
    let mcp = &value["_meta"]["mcp"];
    let input = match &value["rawInput"] {
        input if mcp.is_object() && !input["arguments"].is_null() => &input["arguments"],
        input => input,
    };
    ItemKind::ToolCall(ToolCall {
        name: mcp["tool"].as_str().map_or(title, str::to_string),
        server: mcp["server"].as_str().map(str::to_string),
        input: (!input.is_null()).then(|| input.clone()),
        result: Vec::new(),
        duration_ms: None,
    })
}

fn turn_usage(value: &Value) -> Option<TokenCount> {
    Some(TokenCount {
        total_tokens: value["totalTokens"].as_u64()?,
        input_tokens: value["inputTokens"].as_u64()?,
        output_tokens: value["outputTokens"].as_u64()?,
        cached_input_tokens: value["cachedReadTokens"].as_u64().unwrap_or(0),
        cache_write_input_tokens: value["cachedWriteTokens"].as_u64().unwrap_or(0),
        reasoning_output_tokens: value["thoughtTokens"].as_u64().unwrap_or(0),
    })
}

pub(super) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn invalid(message: &str) -> AntigravityError {
    AntigravityError::Protocol(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn prompt(live: &mut Live) -> Turn {
        live.begin(
            "Inspect",
            vec![MessageContent::Text {
                text: "Inspect".into(),
            }],
        )
    }

    #[test]
    fn an_mcp_call_shows_its_own_tool_server_and_arguments() {
        let mut live = Live::new(TurnPage::default());
        let turn = prompt(&mut live);
        live.update(&json!({
            "sessionUpdate":"tool_call", "toolCallId":"call_1", "kind":"other", "status":"pending",
            "title":"caffold_rename_current_task", "content":[],
            "rawInput":{"arguments":{"name":"Greeting"}, "name":"Greeting"},
            "_meta":{"mcp":{"tool":"rename_current_task", "server":"caffold"}, "is_mcp_tool_call":true, "prompt":"Renaming current task"}
        })).unwrap();
        let running = live.read_page(None, 8).unwrap().unwrap().turns[0].items[1].clone();
        live.update(&json!({
            "sessionUpdate":"tool_call_update", "toolCallId":"call_1", "status":"completed",
            "rawOutput":"Rename current task",
            "content":[{"type":"content", "content":{"type":"text", "text":"Rename current task"}}]
        }))
        .unwrap();
        let page = live.read_page(None, 8).unwrap().unwrap();
        let done = &page.turns[0].items[1];

        assert_eq!(page.turns[0].id, turn.id);
        assert_eq!(running.status, ActivityStatus::InProgress);
        assert!(matches!(&running.kind, ItemKind::ToolCall(call) if call.result.is_empty()));
        assert_eq!(done.id, running.id);
        assert_eq!(done.status, ActivityStatus::Completed);
        assert_eq!(
            done.kind,
            ItemKind::ToolCall(ToolCall {
                name: "rename_current_task".into(),
                server: Some("caffold".into()),
                input: Some(json!({"name":"Greeting"})),
                result: Vec::new(),
                duration_ms: None,
            })
        );
    }

    #[test]
    fn a_tool_call_without_mcp_keeps_its_title_and_input_but_not_the_step_summary() {
        let mut live = Live::new(TurnPage::default());
        prompt(&mut live);
        live.update(&json!({
            "sessionUpdate":"tool_call", "toolCallId":"fetch", "kind":"fetch", "status":"in_progress",
            "title":"Running read_url_content", "rawInput":{"Url":"https://example.com", "toolSummary":"Read example"},
            "content":[{"type":"content", "content":{"type":"text", "text":"https://example.com"}}]
        })).unwrap();
        live.update(&json!({"sessionUpdate":"tool_call_update", "toolCallId":"fetch", "status":"completed", "rawOutput":"Read example"})).unwrap();
        let page = live.read_page(None, 8).unwrap().unwrap();
        let item = &page.turns[0].items[1];

        assert_eq!(item.status, ActivityStatus::Completed);
        assert_eq!(
            item.kind,
            ItemKind::ToolCall(ToolCall {
                name: "Running read_url_content".into(),
                server: None,
                input: Some(json!({"Url":"https://example.com", "toolSummary":"Read example"})),
                result: Vec::new(),
                duration_ms: None,
            })
        );
    }

    #[test]
    fn native_usage_and_generated_images_survive_the_live_projection() {
        let mut live = Live::new(TurnPage::default());
        live.set_baseline_usage(
            turn_usage(&json!({"totalTokens":10,"inputTokens":7,"outputTokens":3})).unwrap(),
        );
        let accepted = prompt(&mut live);
        live.update(&json!({"sessionUpdate":"tool_call", "toolCallId":"image", "kind":"other", "status":"completed", "rawOutput":{"imagePath":"/tmp/fixture.png", "prompt":"a tree"}})).unwrap();
        let events = live.finish(&Ok(json!({"stopReason":"end_turn", "usage":{"totalTokens":25,"inputTokens":20,"outputTokens":5,"cachedReadTokens":4,"thoughtTokens":2}})));
        let usage = events
            .iter()
            .find_map(|event| match event {
                SessionEventKind::UsageReported { turn_id, usage } => Some((turn_id, usage)),
                _ => None,
            })
            .unwrap();
        assert_eq!(usage.0, &accepted.id);
        assert_eq!(usage.1.total.total_tokens, 35);
        assert_eq!(usage.1.last.cached_input_tokens, 4);
        assert_eq!(usage.1.last.reasoning_output_tokens, 2);
        assert!(
            matches!(&live.read_page(None, 8).unwrap().unwrap().turns[0].items[1].kind, ItemKind::GeneratedImage(image) if image.saved_path.as_deref()==Some("/tmp/fixture.png"))
        );
    }

    #[test]
    fn file_change_updates_keep_the_exact_tool_identity_and_paths() {
        let mut live = Live::new(TurnPage::default());
        let accepted = prompt(&mut live);
        live.update(&json!({"sessionUpdate":"tool_call", "toolCallId":"edit-1", "kind":"edit", "status":"in_progress", "locations":[{"path":"/tmp/project/src/main.rs"}]})).unwrap();
        let (_, id) = live.active_ids("edit-1").unwrap();
        live.update(&json!({"sessionUpdate":"tool_call_update", "toolCallId":"edit-1", "status":"completed"})).unwrap();
        let page = live.read_page(None, 8).unwrap().unwrap();
        assert_eq!(page.turns[0].id, accepted.id);
        assert_eq!(page.turns[0].items.len(), 2);
        let item = &page.turns[0].items[1];
        assert_eq!(item.id, id);
        assert_eq!(item.status, ActivityStatus::Completed);
        assert!(matches!(&item.kind, ItemKind::FileChange { paths }
            if paths == &["/tmp/project/src/main.rs"]));
    }

    #[test]
    fn live_chunks_tools_and_final_answer_have_one_stable_display_identity() {
        let mut live = Live::new(TurnPage::default());
        let accepted = prompt(&mut live);
        assert_eq!(live.start_events().len(), 2);
        assert!(live.start_events().is_empty());
        for text in ["Thinking ", "now"] {
            live.update(&json!({"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":text}})).unwrap();
        }
        live.update(&json!({"sessionUpdate":"tool_call","toolCallId":"permission-frame","kind":"execute","title":"Run pwd","rawInput":{"command_line":"pwd","working_dir":"/tmp"},"status":"pending"})).unwrap();
        let (turn_id, item_id) = live.active_ids("permission-frame").unwrap();
        assert_eq!(turn_id, accepted.id);
        live.update(&json!({"sessionUpdate":"tool_call_update","toolCallId":"permission-frame","status":"completed","rawOutput":{"combinedOutput":"/tmp\n","exitCode":0,"exit_code":0}})).unwrap();
        for text in ["Done", "."] {
            live.update(&json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":text}})).unwrap();
        }
        live.finish(&Ok(json!({"stopReason":"end_turn"})));
        let page = live.read_page(None, 8).unwrap().unwrap();
        let turn = &page.turns[0];
        assert_eq!(turn.id, accepted.id);
        assert_eq!(turn.items[0].id, accepted.items[0].id);
        assert_eq!(turn.items.len(), 4);
        assert_eq!(turn.items[2].id, item_id);
        let ItemKind::CommandExecution(command) = &turn.items[2].kind else {
            panic!("command")
        };
        assert_eq!(command.command.as_deref(), Some("pwd"));
        assert_eq!(command.cwd.as_deref(), Some("/tmp"));
        assert_eq!(command.output.as_deref(), Some("/tmp\n"));
        assert_eq!(command.exit_code, Some(0));
        assert!(
            matches!(&turn.items[3].kind, ItemKind::AssistantMessage { text, phase: Some(MessagePhase::Final), .. } if text == "Done.")
        );
        assert_eq!(turn.status, TurnStatus::Completed);
        assert_eq!(live.read_page(None, 8).unwrap().unwrap(), page);
    }

    #[test]
    fn pagination_never_reads_the_persisted_live_interval_a_second_time() {
        let mut native = Live::new(TurnPage::default());
        let mut old = prompt(&mut native);
        old.id = "native-execution".into();
        old.status = TurnStatus::Completed;
        let mut live = Live::new(TurnPage {
            turns: vec![old.clone()],
            next_cursor: Some("native-older-cursor".into()),
            backwards_cursor: None,
        });
        let accepted = prompt(&mut live);
        live.finish(&Ok(json!({"stopReason":"end_turn"})));
        let latest = live.read_page(None, 1).unwrap().unwrap();
        assert_eq!(latest.turns[0].id, accepted.id);
        let older = live
            .read_page(latest.next_cursor.as_deref(), 1)
            .unwrap()
            .unwrap();
        assert_eq!(older.turns, vec![old]);
        assert_eq!(older.next_cursor.as_deref(), Some("native-older-cursor"));
        assert!(
            live.read_page(older.next_cursor.as_deref(), 8)
                .unwrap()
                .is_none()
        );
        let reconstructed = Live::new(TurnPage::default());
        assert!(
            reconstructed
                .read_page(latest.next_cursor.as_deref(), 8)
                .is_err()
        );
    }

    #[test]
    fn cancellation_failure_and_rejected_enqueue_do_not_invent_success() {
        let mut live = Live::new(TurnPage::default());
        let first = prompt(&mut live);
        live.reject(&first.id);
        assert!(live.read_page(None, 8).unwrap().unwrap().turns.is_empty());
        prompt(&mut live);
        live.finish(&Ok(json!({"stopReason":"cancelled"})));
        assert_eq!(live.turns[0].status, TurnStatus::Interrupted);
        prompt(&mut live);
        live.finish(&Err(invalid("native failure")));
        assert_eq!(live.turns[0].status, TurnStatus::Failed);
        assert!(matches!(
            live.turns[0].items.last().unwrap().kind,
            ItemKind::Failure { .. }
        ));
    }

    #[test]
    fn completed_retention_rebuilds_only_between_inputs_and_optional_updates_are_ignored() {
        let mut live = Live::new(TurnPage::default());
        assert!(
            live.update(&json!({"sessionUpdate":"future_optional_update"}))
                .unwrap()
                .is_empty()
        );
        for _ in 0..8 {
            prompt(&mut live);
            assert!(!live.needs_rebuild());
            live.finish(&Ok(json!({"stopReason":"end_turn"})));
        }
        assert!(live.needs_rebuild());
        prompt(&mut live);
        assert!(live.update(&json!({"sessionUpdate":"tool_call"})).is_err());
    }
}
