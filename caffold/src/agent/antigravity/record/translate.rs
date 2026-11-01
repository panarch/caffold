//! Native trajectory facts projected once for both live observation and history.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use url::Url;

use super::format::{
    ExecutorMetadata, ImageData, Media, ModelUsage, Payload, Step, StepMetadata, Timestamp,
};
use super::invalid;
use crate::agent::antigravity::AntigravityError;
use crate::agent::{
    ActivityStatus, CommandExecution, ConversationItem, GeneratedImage, ItemKind, MessageContent,
    MessagePhase, TokenCount, Turn, TurnOrigin, TurnStatus,
};

pub(super) fn turn(
    trajectory: &str,
    id: &str,
    steps: &[(i64, Step)],
    terminal: Option<&ExecutorMetadata>,
) -> Result<Turn, AntigravityError> {
    let status = match terminal.map(|value| value.termination_reason) {
        None | Some(0) => TurnStatus::InProgress,
        Some(2) => TurnStatus::Interrupted,
        Some(1 | 3 | 6 | 11) => TurnStatus::Failed,
        Some(4 | 7 | 8 | 9 | 10) => TurnStatus::Completed,
        Some(reason) => {
            return Err(invalid(&format!(
                "unsupported native termination reason {reason}"
            )));
        }
    };
    if let Some(terminal) = terminal
        && !steps
            .iter()
            .any(|(idx, _)| *idx == i64::from(terminal.last_step_idx))
    {
        return Err(invalid(
            "native terminal metadata names a step outside its execution",
        ));
    }
    let origin = if steps
        .iter()
        .any(|(_, step)| matches!(step.payload, Some(Payload::UserInput(_))))
    {
        TurnOrigin::User
    } else {
        TurnOrigin::Unknown
    };
    let started_at_ms = steps
        .iter()
        .filter_map(|(_, step)| {
            timestamp_ms(
                step.metadata
                    .as_ref()
                    .and_then(|metadata| metadata.created_at.as_ref()),
            )
        })
        .min();
    let completed_at_ms = terminal
        .filter(|_| status != TurnStatus::InProgress)
        .and_then(|terminal| {
            steps
                .iter()
                .find(|(idx, _)| *idx == i64::from(terminal.last_step_idx))
        })
        .and_then(|(_, step)| {
            timestamp_ms(
                step.metadata
                    .as_ref()
                    .and_then(|metadata| metadata.completed_at.as_ref()),
            )
        });
    let mut items = Vec::new();
    for (idx, step) in steps {
        let metadata = step
            .metadata
            .as_ref()
            .ok_or_else(|| invalid("native step has no metadata"))?;
        let base = format!("{trajectory}:{idx}");
        let observed_at_ms = timestamp_ms(metadata.created_at.as_ref());
        let activity = activity(step.status)?;
        let item = |suffix: &str, kind: ItemKind, status: ActivityStatus| ConversationItem {
            id: format!("{base}{suffix}"),
            observed_at_ms,
            status,
            kind,
        };
        match &step.payload {
            Some(Payload::UserInput(input)) => {
                let mut content = Vec::new();
                if !input.response.is_empty() {
                    content.push(MessageContent::Text {
                        text: input.response.clone(),
                    });
                }
                if input.media.is_empty() {
                    content.extend(input.images.iter().filter_map(image_content));
                } else {
                    content.extend(input.media.iter().filter_map(media_content));
                }
                items.push(item(
                    "",
                    ItemKind::UserMessage {
                        text: input.response.clone(),
                        content,
                    },
                    activity,
                ));
            }
            Some(Payload::PlannerResponse(response)) => {
                if !response.thinking.is_empty() {
                    items.push(item(
                        ":thought",
                        ItemKind::Reasoning {
                            summary: Vec::new(),
                            content: vec![response.thinking.clone()],
                        },
                        activity,
                    ));
                }
                let text = if response.modified_response.is_empty() {
                    &response.response
                } else {
                    &response.modified_response
                };
                if !text.is_empty() {
                    let phase = terminal
                        .filter(|terminal| {
                            status == TurnStatus::Completed
                                && i64::from(terminal.last_step_idx) == *idx
                        })
                        .map(|_| MessagePhase::Final)
                        .unwrap_or(MessagePhase::Progress);
                    items.push(item(
                        ":message",
                        ItemKind::AssistantMessage {
                            text: text.clone(),
                            phase: Some(phase),
                            suggested_prompts: Vec::new(),
                        },
                        activity,
                    ));
                }
            }
            Some(Payload::RunCommand(command)) => {
                let output = command.combined_output.as_ref().map(|output| {
                    if output.full.is_empty() {
                        output.truncated.clone()
                    } else {
                        output.full.clone()
                    }
                });
                let kind = ItemKind::CommandExecution(CommandExecution {
                    command: nonempty(&command.command_line),
                    cwd: nonempty(&command.cwd),
                    output,
                    exit_code: command.exit_code.map(i64::from),
                    duration_ms: duration_ms(metadata),
                    background_task: None,
                });
                items.push(item(
                    "",
                    kind,
                    if command.user_rejected {
                        ActivityStatus::Declined
                    } else {
                        activity
                    },
                ));
            }
            Some(Payload::ShellExec(command)) => {
                let kind = ItemKind::CommandExecution(CommandExecution {
                    command: nonempty(&command.command),
                    cwd: None,
                    output: nonempty(&command.output),
                    exit_code: command.exit_code.map(i64::from),
                    duration_ms: duration_ms(metadata),
                    background_task: None,
                });
                items.push(item("", kind, activity));
            }
            Some(Payload::CodeAction(action)) => {
                let path = action
                    .result
                    .as_ref()
                    .and_then(|result| result.edit.as_ref())
                    .and_then(|edit| {
                        if edit.absolute_uri.is_empty() {
                            nonempty(&edit.absolute_path)
                        } else {
                            native_path(&edit.absolute_uri)
                        }
                    });
                items.push(item(
                    "",
                    ItemKind::FileChange {
                        paths: path.into_iter().collect(),
                    },
                    activity,
                ));
            }
            Some(Payload::FileChange(change)) => {
                items.push(item(
                    "",
                    ItemKind::FileChange {
                        paths: native_path(&change.absolute_path_uri).into_iter().collect(),
                    },
                    activity,
                ));
            }
            Some(Payload::GenerateImage(image)) => {
                let saved_path = image
                    .paths
                    .first()
                    .cloned()
                    .or_else(|| {
                        image
                            .image
                            .as_ref()
                            .and_then(|value| native_path(&value.uri))
                    })
                    .or_else(|| {
                        image
                            .media
                            .as_ref()
                            .and_then(|value| native_path(&value.uri))
                    });
                let encoded = image
                    .image
                    .as_ref()
                    .and_then(|value| nonempty(&value.base64_data))
                    .or_else(|| {
                        image
                            .media
                            .as_ref()
                            .filter(|value| !value.inline_data.is_empty())
                            .map(|value| STANDARD.encode(&value.inline_data))
                    });
                items.push(item(
                    "",
                    ItemKind::GeneratedImage(GeneratedImage {
                        revised_prompt: nonempty(&image.prompt),
                        saved_path,
                        encoded,
                    }),
                    activity,
                ));
            }
            Some(Payload::ErrorMessage(error)) if error.show_user => {
                let text = error
                    .error
                    .as_ref()
                    .map(|error| {
                        if error.user_message.is_empty() {
                            error.short_error.clone()
                        } else {
                            error.user_message.clone()
                        }
                    })
                    .filter(|text| !text.is_empty())
                    .unwrap_or_else(|| "Antigravity reported an error.".to_string());
                items.push(item("", ItemKind::Failure { text }, ActivityStatus::Failed));
            }
            Some(Payload::McpTool(tool)) => {
                let name = tool
                    .call
                    .as_ref()
                    .and_then(|call| nonempty(&call.name))
                    .or_else(|| tool_name(metadata))
                    .unwrap_or_else(|| "mcp_tool".to_string());
                let name = if tool.server.is_empty() {
                    name
                } else {
                    format!("{}: {name}", tool.server)
                };
                items.push(item("", ItemKind::ToolCall { name }, activity));
            }
            Some(Payload::ViewFile(_) | Payload::ErrorMessage(_)) | None => {
                if (step.kind == 14 || step.kind == 15) && step.payload.is_none() {
                    return Err(invalid("native message payload is missing"));
                }
                let name = tool_name(metadata)
                    .unwrap_or_else(|| format!("Antigravity step {}", step.kind));
                items.push(item("", ItemKind::ToolCall { name }, activity));
            }
        }
    }
    Ok(Turn {
        id: id.to_string(),
        origin,
        status,
        started_at_ms,
        completed_at_ms,
        items,
    })
}

pub(super) fn timestamp_ms(timestamp: Option<&Timestamp>) -> Option<u64> {
    let timestamp = timestamp?;
    if !(0..1_000_000_000).contains(&timestamp.nanos) {
        return None;
    }
    u64::try_from(timestamp.seconds)
        .ok()?
        .checked_mul(1000)?
        .checked_add(u64::try_from(timestamp.nanos).ok()? / 1_000_000)
}

pub(super) fn empty_usage() -> TokenCount {
    TokenCount {
        total_tokens: 0,
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
    }
}

pub(super) fn token_count(usage: &ModelUsage) -> Result<TokenCount, AntigravityError> {
    Ok(TokenCount {
        total_tokens: usage
            .input_tokens
            .checked_add(usage.output_tokens)
            .ok_or_else(|| invalid("native token count overflow"))?,
        input_tokens: usage.input_tokens,
        cached_input_tokens: usage.cache_read_tokens,
        cache_write_input_tokens: usage.cache_write_tokens,
        output_tokens: usage.output_tokens,
        reasoning_output_tokens: usage.thinking_tokens,
    })
}

pub(super) fn add_usage(a: TokenCount, b: &TokenCount) -> Result<TokenCount, AntigravityError> {
    let add = |a: u64, b: u64| {
        a.checked_add(b)
            .ok_or_else(|| invalid("native token count overflow"))
    };
    Ok(TokenCount {
        total_tokens: add(a.total_tokens, b.total_tokens)?,
        input_tokens: add(a.input_tokens, b.input_tokens)?,
        cached_input_tokens: add(a.cached_input_tokens, b.cached_input_tokens)?,
        cache_write_input_tokens: add(a.cache_write_input_tokens, b.cache_write_input_tokens)?,
        output_tokens: add(a.output_tokens, b.output_tokens)?,
        reasoning_output_tokens: add(a.reasoning_output_tokens, b.reasoning_output_tokens)?,
    })
}

fn activity(status: i32) -> Result<ActivityStatus, AntigravityError> {
    match status {
        0 | 1 | 2 | 8 | 9 | 11 => Ok(ActivityStatus::InProgress),
        3 => Ok(ActivityStatus::Completed),
        4 | 5 | 6 | 7 | 12 => Ok(ActivityStatus::Failed),
        _ => Err(invalid(&format!("unsupported native step status {status}"))),
    }
}

fn native_path(value: &str) -> Option<String> {
    if value.is_empty() {
        return None;
    }
    if value.starts_with('/') {
        return Some(value.to_string());
    }
    Url::parse(value)
        .ok()?
        .to_file_path()
        .ok()
        .map(|path| path.display().to_string())
}

fn image_content(image: &ImageData) -> Option<MessageContent> {
    if !image.base64_data.is_empty() {
        Some(MessageContent::Image {
            url: format!("data:{};base64,{}", image.mime_type, image.base64_data),
        })
    } else {
        native_path(&image.uri).map(|path| MessageContent::LocalImage { path })
    }
}

fn media_content(media: &Media) -> Option<MessageContent> {
    if !media.mime_type.starts_with("image/") {
        return None;
    }
    if !media.inline_data.is_empty() {
        Some(MessageContent::Image {
            url: format!(
                "data:{};base64,{}",
                media.mime_type,
                STANDARD.encode(&media.inline_data)
            ),
        })
    } else {
        native_path(&media.uri).map(|path| MessageContent::LocalImage { path })
    }
}

fn duration_ms(metadata: &StepMetadata) -> Option<u64> {
    timestamp_ms(metadata.completed_at.as_ref())?
        .checked_sub(timestamp_ms(metadata.started_at.as_ref())?)
}

fn tool_name(metadata: &StepMetadata) -> Option<String> {
    metadata
        .tool_call
        .as_ref()
        .and_then(|call| nonempty(&call.name))
}
fn nonempty(value: &str) -> Option<String> {
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::super::format::{ActionEdit, ActionResult, CodeAction, FileChange, GenerateImage};
    use super::*;

    #[test]
    fn native_file_changes_preserve_step_identity_and_decode_file_uris() {
        let steps = [
            (
                7,
                Step {
                    kind: 5,
                    status: 3,
                    metadata: Some(StepMetadata::default()),
                    payload: Some(Payload::CodeAction(CodeAction {
                        result: Some(ActionResult {
                            edit: Some(ActionEdit {
                                absolute_path: "/legacy/path".into(),
                                absolute_uri: "file:///fixture/source%20file.rs".into(),
                            }),
                        }),
                    })),
                },
            ),
            (
                8,
                Step {
                    kind: 86,
                    status: 3,
                    metadata: Some(StepMetadata::default()),
                    payload: Some(Payload::FileChange(FileChange {
                        absolute_path_uri: "file:///fixture/created.rs".into(),
                    })),
                },
            ),
        ];
        let translated = turn("native-trajectory", "native-execution", &steps, None).unwrap();
        assert_eq!(
            translated
                .items
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            ["native-trajectory:7", "native-trajectory:8"]
        );
        assert!(
            matches!(&translated.items[0].kind, ItemKind::FileChange { paths }
            if paths == &["/fixture/source file.rs"])
        );
        assert!(
            matches!(&translated.items[1].kind, ItemKind::FileChange { paths }
            if paths == &["/fixture/created.rs"])
        );
    }

    #[test]
    fn generated_image_records_keep_native_files_and_the_available_image_bytes() {
        for (image, expected_path, expected_bytes) in [
            (
                GenerateImage {
                    prompt: "native revised prompt".into(),
                    paths: vec!["/fixture/native.png".into()],
                    image: Some(ImageData {
                        base64_data: "AQID".into(),
                        ..ImageData::default()
                    }),
                    media: None,
                },
                "/fixture/native.png",
                "AQID",
            ),
            (
                GenerateImage {
                    media: Some(Media {
                        mime_type: "image/png".into(),
                        inline_data: vec![4, 5, 6],
                        uri: "file:///fixture/media%20image.png".into(),
                    }),
                    ..GenerateImage::default()
                },
                "/fixture/media image.png",
                "BAUG",
            ),
        ] {
            let step = Step {
                kind: 91,
                status: 3,
                metadata: Some(StepMetadata::default()),
                payload: Some(Payload::GenerateImage(image)),
            };
            let translated = turn("trajectory", "execution", &[(9, step)], None).unwrap();
            assert_eq!(translated.items[0].id, "trajectory:9");
            let ItemKind::GeneratedImage(image) = &translated.items[0].kind else {
                panic!("native generated-image payload must remain an image");
            };
            assert_eq!(image.saved_path.as_deref(), Some(expected_path));
            assert_eq!(image.encoded.as_deref(), Some(expected_bytes));
        }
    }
}
