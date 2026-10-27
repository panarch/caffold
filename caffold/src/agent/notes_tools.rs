//! The Notes tools Caffold serves every agent.
//!
//! Notes are Caffold's own durable records, shared by every Task. Codex and
//! Grok reach these tools at Caffold's HTTP MCP addresses and Claude through
//! its in-process server; all three list them from this one catalog, and a
//! call's arguments are checked here once, whichever agent made it.

use std::path::Path;

use serde::Deserialize;
use serde_json::{Value, json};

pub(crate) const MAX_NOTE_FILE_BYTES: u64 = 1024 * 1024;

/// The supplied Markdown, or a file the calling Task asks Caffold to read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NoteContent {
    Text(String),
    File(String),
}

impl From<String> for NoteContent {
    fn from(content: String) -> Self {
        Self::Text(content)
    }
}

/// A Notes tool call whose arguments have been checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum NotesToolCall {
    ListNotes {
        directory_id: Option<String>,
    },
    ReadNote {
        note_id: String,
    },
    CreateNote {
        name: String,
        content: NoteContent,
        directory_id: Option<String>,
    },
    UpdateNoteContent {
        note_id: String,
        content: NoteContent,
        expected_content_version: i64,
    },
    RenameNote {
        note_id: String,
        name: String,
    },
    MoveNote {
        note_id: String,
        directory_id: Option<String>,
    },
    DeleteNote {
        note_id: String,
    },
    CreateNoteDirectory {
        name: String,
        parent_directory_id: Option<String>,
    },
    RenameNoteDirectory {
        directory_id: String,
        name: String,
    },
    MoveNoteDirectory {
        directory_id: String,
        parent_directory_id: Option<String>,
    },
    DeleteNoteDirectory {
        directory_id: String,
    },
}

impl NotesToolCall {
    pub(crate) fn needs_working_directory(&self) -> bool {
        match self {
            Self::CreateNote { content, .. } | Self::UpdateNoteContent { content, .. } => {
                matches!(content, NoteContent::File(path) if !Path::new(path).is_absolute())
            }
            _ => false,
        }
    }
}

pub(crate) struct NotesToolSpec {
    pub(crate) name: &'static str,
    pub(crate) description: &'static str,
    pub(crate) input_schema: Value,
}

/// The call a Notes tool asked for, an explanation of what is wrong with its
/// arguments, or `None` when the tool is not a Notes tool.
pub(crate) fn notes_tool_call(
    tool: &str,
    arguments: &Value,
) -> Option<Result<NotesToolCall, String>> {
    let call = match tool {
        LIST_NOTES => parse::<ListNotesArguments>(tool, arguments).and_then(|arguments| {
            Ok(NotesToolCall::ListNotes {
                directory_id: optional_text("directoryId", arguments.directory_id)?,
            })
        }),
        READ_NOTE => parse::<NoteArguments>(tool, arguments).and_then(|arguments| {
            Ok(NotesToolCall::ReadNote {
                note_id: required_text("noteId", arguments.note_id)?,
            })
        }),
        CREATE_NOTE => parse::<CreateNoteArguments>(tool, arguments).and_then(|arguments| {
            Ok(NotesToolCall::CreateNote {
                name: required_text("name", arguments.name)?,
                content: note_content(arguments.content, arguments.content_path)?,
                directory_id: optional_text("directoryId", arguments.directory_id)?,
            })
        }),
        UPDATE_NOTE_CONTENT => {
            parse::<UpdateNoteContentArguments>(tool, arguments).and_then(|arguments| {
                if arguments.expected_content_version < 1 {
                    return Err(
                        "`expectedContentVersion` must be the positive contentVersion read_note returned."
                            .to_string(),
                    );
                }
                Ok(NotesToolCall::UpdateNoteContent {
                    note_id: required_text("noteId", arguments.note_id)?,
                    content: note_content(arguments.content, arguments.content_path)?,
                    expected_content_version: arguments.expected_content_version,
                })
            })
        }
        RENAME_NOTE => parse::<RenameNoteArguments>(tool, arguments).and_then(|arguments| {
            Ok(NotesToolCall::RenameNote {
                note_id: required_text("noteId", arguments.note_id)?,
                name: required_text("name", arguments.name)?,
            })
        }),
        MOVE_NOTE => parse::<MoveNoteArguments>(tool, arguments).and_then(|arguments| {
            Ok(NotesToolCall::MoveNote {
                note_id: required_text("noteId", arguments.note_id)?,
                directory_id: optional_text("directoryId", arguments.directory_id)?,
            })
        }),
        DELETE_NOTE => parse::<NoteArguments>(tool, arguments).and_then(|arguments| {
            Ok(NotesToolCall::DeleteNote {
                note_id: required_text("noteId", arguments.note_id)?,
            })
        }),
        CREATE_NOTE_DIRECTORY => {
            parse::<CreateDirectoryArguments>(tool, arguments).and_then(|arguments| {
                Ok(NotesToolCall::CreateNoteDirectory {
                    name: required_text("name", arguments.name)?,
                    parent_directory_id: optional_text(
                        "parentDirectoryId",
                        arguments.parent_directory_id,
                    )?,
                })
            })
        }
        RENAME_NOTE_DIRECTORY => {
            parse::<RenameDirectoryArguments>(tool, arguments).and_then(|arguments| {
                Ok(NotesToolCall::RenameNoteDirectory {
                    directory_id: required_text("directoryId", arguments.directory_id)?,
                    name: required_text("name", arguments.name)?,
                })
            })
        }
        MOVE_NOTE_DIRECTORY => {
            parse::<MoveDirectoryArguments>(tool, arguments).and_then(|arguments| {
                Ok(NotesToolCall::MoveNoteDirectory {
                    directory_id: required_text("directoryId", arguments.directory_id)?,
                    parent_directory_id: optional_text(
                        "parentDirectoryId",
                        arguments.parent_directory_id,
                    )?,
                })
            })
        }
        DELETE_NOTE_DIRECTORY => parse::<DirectoryArguments>(tool, arguments).and_then(|arguments| {
            Ok(NotesToolCall::DeleteNoteDirectory {
                directory_id: required_text("directoryId", arguments.directory_id)?,
            })
        }),
        _ => return None,
    };
    Some(call)
}

pub(crate) fn notes_tool_specs() -> [NotesToolSpec; 11] {
    [
        NotesToolSpec {
            name: LIST_NOTES,
            description: concat!(
                "List what one Caffold Note directory directly holds: its directories, ",
                "each with how many directories and Notes it directly holds, ",
                "and its Notes, with ids, names, and last change times but no Note content. ",
                "Omit directoryId for the top of the Notes tree, ",
                "and pass a listed directory's id to look one level down. ",
                "Caffold Notes are durable records shared by every Caffold task and kept after a task ends; ",
                "they are not the current task's plan documents under .caffold/plans/current. ",
                "Find and read Caffold Notes only through these Notes tools, ",
                "not in the Caffold app, a browser, or on screen.",
            ),
            input_schema: object_schema(
                json!({
                    "directoryId": text_schema("The Note directory to list. Omit it for the top of the Notes tree."),
                }),
                &[],
            ),
        },
        NotesToolSpec {
            name: READ_NOTE,
            description: concat!(
                "Read one Caffold Note: its name, directory, Markdown content, and contentVersion. ",
                "Pass that contentVersion to update_note_content. ",
                "Find and read Caffold Notes only through these Notes tools, ",
                "not in the Caffold app, a browser, or on screen.",
            ),
            input_schema: object_schema(
                json!({ "noteId": text_schema("The id of the Note to read.") }),
                &["noteId"],
            ),
        },
        NotesToolSpec {
            name: CREATE_NOTE,
            description: concat!(
                "Create a Caffold Note only when the user explicitly asks to save something as a note. ",
                "Notes are durable records shared by every Caffold task; ",
                "keep the current task's own plan in .caffold/plans/current instead. ",
                "Omit directoryId to place the Note at the top of the Notes tree. ",
                "Supply exactly one of content or contentPath. ",
                "Use contentPath when the content is an existing file, such as a finished plan. ",
                "Relative paths start in this Task's working directory; absolute paths are accepted. ",
                "After following symlinks, the file must be inside the server's filesystem root, ",
                "which may include files outside this Task's directory. ",
                "The file must be regular, UTF-8, and at most 1 MiB (1,048,576 bytes); ",
                "its content is stored unchanged.",
            ),
            input_schema: note_content_schema(
                json!({
                    "name": text_schema("The Note's name."),
                    "content": content_schema("The Note's Markdown content."),
                    "contentPath": text_schema(concat!(
                        "An existing UTF-8 file to use as the Note's content. ",
                        "Relative to this Task's working directory, ",
                        "or an absolute path within the server's filesystem root. ",
                        "Maximum 1 MiB. ",
                        "Supply this or content, exactly one.",
                    )),
                    "directoryId": text_schema("The Note directory to create the Note in. Omit it for the top of the Notes tree."),
                }),
                &["name"],
            ),
        },
        NotesToolSpec {
            name: UPDATE_NOTE_CONTENT,
            description: concat!(
                "Replace a Caffold Note's entire Markdown content ",
                "only when the user explicitly asks to change that Note. ",
                "Caffold keeps no history, so the replaced content cannot be recovered. ",
                "Pass the contentVersion read_note returned: ",
                "if the Note changed since then nothing is written ",
                "and the result gives the current contentVersion, ",
                "so read the Note again, reapply the change, and retry. ",
                "Supply exactly one of content or contentPath. ",
                "Use contentPath when the complete new content is an existing file. ",
                "Relative paths start in this Task's working directory; absolute paths are accepted. ",
                "After following symlinks, the file must be inside the server's filesystem root, ",
                "which may include files outside this Task's directory. ",
                "The file must be regular, UTF-8, and at most 1 MiB (1,048,576 bytes); ",
                "its content is stored unchanged.",
            ),
            input_schema: note_content_schema(
                json!({
                    "noteId": text_schema("The id of the Note to change."),
                    "content": content_schema("The Note's complete new Markdown content."),
                    "contentPath": text_schema(concat!(
                        "An existing UTF-8 file containing the Note's complete new content. ",
                        "Relative to this Task's working directory, ",
                        "or an absolute path within the server's filesystem root. ",
                        "Maximum 1 MiB. ",
                        "Supply this or content, exactly one.",
                    )),
                    "expectedContentVersion": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "The contentVersion read_note returned for the content this change starts from.",
                    },
                }),
                &["noteId", "expectedContentVersion"],
            ),
        },
        NotesToolSpec {
            name: RENAME_NOTE,
            description: "Rename a Caffold Note only when the user explicitly asks.",
            input_schema: object_schema(
                json!({
                    "noteId": text_schema("The id of the Note to rename."),
                    "name": text_schema("The Note's new name."),
                }),
                &["noteId", "name"],
            ),
        },
        NotesToolSpec {
            name: MOVE_NOTE,
            description: concat!(
                "Move a Caffold Note into another Note directory only when the user explicitly asks. ",
                "Omit directoryId to move it to the top of the Notes tree.",
            ),
            input_schema: object_schema(
                json!({
                    "noteId": text_schema("The id of the Note to move."),
                    "directoryId": text_schema("The Note directory to move the Note into. Omit it for the top of the Notes tree."),
                }),
                &["noteId"],
            ),
        },
        NotesToolSpec {
            name: DELETE_NOTE,
            description: concat!(
                "Delete a Caffold Note only when the user explicitly asks. ",
                "Caffold keeps no history, so a deleted Note cannot be recovered.",
            ),
            input_schema: object_schema(
                json!({ "noteId": text_schema("The id of the Note to delete.") }),
                &["noteId"],
            ),
        },
        NotesToolSpec {
            name: CREATE_NOTE_DIRECTORY,
            description: concat!(
                "Create a directory in the Caffold Notes tree ",
                "only when the user explicitly asks to create or organize Notes. ",
                "Omit parentDirectoryId to create it at the top of the Notes tree.",
            ),
            input_schema: object_schema(
                json!({
                    "name": text_schema("The directory's name."),
                    "parentDirectoryId": text_schema("The Note directory to create it in. Omit it for the top of the Notes tree."),
                }),
                &["name"],
            ),
        },
        NotesToolSpec {
            name: RENAME_NOTE_DIRECTORY,
            description: "Rename a directory in the Caffold Notes tree only when the user explicitly asks.",
            input_schema: object_schema(
                json!({
                    "directoryId": text_schema("The id of the Note directory to rename."),
                    "name": text_schema("The directory's new name."),
                }),
                &["directoryId", "name"],
            ),
        },
        NotesToolSpec {
            name: MOVE_NOTE_DIRECTORY,
            description: concat!(
                "Move a directory in the Caffold Notes tree, with everything in it, ",
                "only when the user explicitly asks. ",
                "A directory cannot move into itself or one of its subdirectories. ",
                "Omit parentDirectoryId to move it to the top of the Notes tree.",
            ),
            input_schema: object_schema(
                json!({
                    "directoryId": text_schema("The id of the Note directory to move."),
                    "parentDirectoryId": text_schema("The Note directory to move it into. Omit it for the top of the Notes tree."),
                }),
                &["directoryId"],
            ),
        },
        NotesToolSpec {
            name: DELETE_NOTE_DIRECTORY,
            description: concat!(
                "Delete an empty directory from the Caffold Notes tree ",
                "only when the user explicitly asks. ",
                "A directory that still holds Notes or directories is not deleted; ",
                "delete or move what it holds first. ",
                "Caffold keeps no history, so a deleted directory cannot be recovered.",
            ),
            input_schema: object_schema(
                json!({ "directoryId": text_schema("The id of the empty Note directory to delete.") }),
                &["directoryId"],
            ),
        },
    ]
}

const LIST_NOTES: &str = "list_notes";
const READ_NOTE: &str = "read_note";
const CREATE_NOTE: &str = "create_note";
const UPDATE_NOTE_CONTENT: &str = "update_note_content";
const RENAME_NOTE: &str = "rename_note";
const MOVE_NOTE: &str = "move_note";
const DELETE_NOTE: &str = "delete_note";
const CREATE_NOTE_DIRECTORY: &str = "create_note_directory";
const RENAME_NOTE_DIRECTORY: &str = "rename_note_directory";
const MOVE_NOTE_DIRECTORY: &str = "move_note_directory";
const DELETE_NOTE_DIRECTORY: &str = "delete_note_directory";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListNotesArguments {
    directory_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NoteArguments {
    note_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateNoteArguments {
    name: String,
    #[serde(default, deserialize_with = "present_string")]
    content: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    content_path: Option<String>,
    directory_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateNoteContentArguments {
    note_id: String,
    #[serde(default, deserialize_with = "present_string")]
    content: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    content_path: Option<String>,
    expected_content_version: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameNoteArguments {
    note_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveNoteArguments {
    note_id: String,
    directory_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DirectoryArguments {
    directory_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateDirectoryArguments {
    name: String,
    parent_directory_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameDirectoryArguments {
    directory_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveDirectoryArguments {
    directory_id: String,
    parent_directory_id: Option<String>,
}

/// Read a call's arguments, treating an absent argument object as empty.
fn parse<T: for<'de> Deserialize<'de>>(tool: &str, arguments: &Value) -> Result<T, String> {
    let parsed = if arguments.is_null() {
        T::deserialize(&json!({}))
    } else {
        T::deserialize(arguments)
    };
    parsed.map_err(|error| {
        format!("The arguments for `{tool}` do not match its input schema: {error}.")
    })
}

fn required_text(field: &str, value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(format!("`{field}` must be a non-empty string."));
    }
    Ok(value.to_string())
}

fn optional_text(field: &str, value: Option<String>) -> Result<Option<String>, String> {
    value.map(|value| required_text(field, value)).transpose()
}

fn present_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

fn note_content(
    content: Option<String>,
    content_path: Option<String>,
) -> Result<NoteContent, String> {
    match (content, content_path) {
        (Some(content), None) => Ok(NoteContent::Text(content)),
        (None, Some(path)) if !path.is_empty() => Ok(NoteContent::File(path)),
        (None, Some(_)) => Err("`contentPath` must be a non-empty file path.".to_string()),
        _ => Err("Supply exactly one of `content` or `contentPath`.".to_string()),
    }
}

fn note_content_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = object_schema(properties, required);
    schema["oneOf"] = json!([
        { "required": ["content"] },
        { "required": ["contentPath"] },
    ]);
    schema
}

fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": properties,
        "required": required,
    })
}

fn text_schema(description: &str) -> Value {
    json!({ "type": "string", "minLength": 1, "description": description })
}

fn content_schema(description: &str) -> Value {
    json!({ "type": "string", "description": description })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(tool: &str, arguments: Value) -> Result<NotesToolCall, String> {
        notes_tool_call(tool, &arguments).expect("a Notes tool")
    }

    #[test]
    fn the_catalog_names_every_tool_the_parser_reads() {
        let specs = notes_tool_specs();
        let names = specs.iter().map(|spec| spec.name).collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                "list_notes",
                "read_note",
                "create_note",
                "update_note_content",
                "rename_note",
                "move_note",
                "delete_note",
                "create_note_directory",
                "rename_note_directory",
                "move_note_directory",
                "delete_note_directory",
            ]
        );
        for spec in &specs {
            assert!(
                notes_tool_call(spec.name, &Value::Null).is_some(),
                "{} is listed but not parsed",
                spec.name
            );
            assert_eq!(spec.input_schema["type"], "object");
            assert_eq!(spec.input_schema["additionalProperties"], false);
            for required in spec.input_schema["required"].as_array().unwrap() {
                assert!(
                    spec.input_schema["properties"]
                        .get(required.as_str().unwrap())
                        .is_some(),
                    "{} requires an undeclared {required}",
                    spec.name
                );
            }
        }
    }

    #[test]
    fn writing_tools_are_described_as_answering_an_explicit_request() {
        for spec in notes_tool_specs() {
            if matches!(spec.name, "list_notes" | "read_note") {
                assert!(!spec.description.contains("explicitly asks"));
            } else {
                assert!(
                    spec.description
                        .contains("only when the user explicitly asks"),
                    "{} does not limit when it is called",
                    spec.name
                );
            }
        }
        let specs = notes_tool_specs();
        for irreversible in [
            "update_note_content",
            "delete_note",
            "delete_note_directory",
        ] {
            let spec = specs.iter().find(|spec| spec.name == irreversible).unwrap();
            assert!(spec.description.contains("Caffold keeps no history"));
        }
        for plan_aware in ["list_notes", "create_note"] {
            let spec = specs.iter().find(|spec| spec.name == plan_aware).unwrap();
            assert!(spec.description.contains(".caffold/plans/current"));
        }
        for reading in ["list_notes", "read_note"] {
            let spec = specs.iter().find(|spec| spec.name == reading).unwrap();
            assert!(
                spec.description
                    .contains("only through these Notes tools, not in the Caffold app"),
                "{reading} does not keep the agent off the Caffold app"
            );
        }
    }

    #[test]
    fn a_tool_outside_the_notes_catalog_is_not_a_notes_call() {
        assert!(notes_tool_call("rename_current_task", &json!({ "name": "x" })).is_none());
        assert!(notes_tool_call("", &Value::Null).is_none());
    }

    #[test]
    fn content_input_requires_exactly_one_string_and_keeps_file_paths_verbatim() {
        for (tool, base) in [
            ("create_note", json!({"name": "File"})),
            (
                "update_note_content",
                json!({"noteId": "note", "expectedContentVersion": 1}),
            ),
        ] {
            for invalid in [
                json!({}),
                json!({"content": "", "contentPath": "file.md"}),
                json!({"content": null}),
                json!({"contentPath": null}),
                json!({"content": "x", "contentPath": null}),
                json!({"content": null, "contentPath": "file.md"}),
                json!({"contentPath": ""}),
                json!({"contentPath": 1}),
                json!({"content": []}),
            ] {
                let mut arguments = base.clone();
                arguments
                    .as_object_mut()
                    .unwrap()
                    .extend(invalid.as_object().unwrap().clone());
                assert!(
                    call(tool, arguments.clone()).is_err(),
                    "{tool}: {arguments}"
                );
            }
            for (input, expected, needs_cwd) in [
                (
                    json!({"content": ""}),
                    NoteContent::Text(String::new()),
                    false,
                ),
                (
                    json!({"contentPath": " ../shared/file.md "}),
                    NoteContent::File(" ../shared/file.md ".to_string()),
                    true,
                ),
                (
                    json!({"contentPath": "/workspace/file.md"}),
                    NoteContent::File("/workspace/file.md".to_string()),
                    false,
                ),
            ] {
                let mut arguments = base.clone();
                arguments
                    .as_object_mut()
                    .unwrap()
                    .extend(input.as_object().unwrap().clone());
                let parsed = call(tool, arguments).unwrap();
                assert_eq!(parsed.needs_working_directory(), needs_cwd);
                match parsed {
                    NotesToolCall::CreateNote { content, .. }
                    | NotesToolCall::UpdateNoteContent { content, .. } => {
                        assert_eq!(content, expected)
                    }
                    _ => panic!("expected a writing tool"),
                }
            }
        }
    }

    #[test]
    fn writing_schemas_offer_exclusive_content_sources_and_document_the_file_boundary() {
        for spec in notes_tool_specs()
            .into_iter()
            .filter(|spec| matches!(spec.name, "create_note" | "update_note_content"))
        {
            assert_eq!(
                spec.input_schema["oneOf"],
                json!([{"required": ["content"]}, {"required": ["contentPath"]}])
            );
            assert!(
                !spec.input_schema["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("content"))
            );
            assert_eq!(
                spec.input_schema["properties"]["contentPath"]["minLength"],
                1
            );
            for phrase in [
                "Use contentPath",
                "Task's working directory",
                "server's filesystem root",
                "1,048,576 bytes",
            ] {
                assert!(spec.description.contains(phrase), "{}: {phrase}", spec.name);
            }
        }
    }

    #[test]
    fn arguments_become_trimmed_calls() {
        assert_eq!(
            call("list_notes", Value::Null),
            Ok(NotesToolCall::ListNotes { directory_id: None })
        );
        assert_eq!(
            call("list_notes", json!({ "directoryId": null })),
            Ok(NotesToolCall::ListNotes { directory_id: None })
        );
        assert_eq!(
            call("list_notes", json!({ "directoryId": " dir " })),
            Ok(NotesToolCall::ListNotes {
                directory_id: Some("dir".to_string()),
            })
        );
        assert_eq!(
            call(
                "create_note",
                json!({ "name": "  Decisions ", "content": "", "directoryId": " dir " })
            ),
            Ok(NotesToolCall::CreateNote {
                name: "Decisions".to_string(),
                content: String::new().into(),
                directory_id: Some("dir".to_string()),
            })
        );
        assert_eq!(
            call(
                "update_note_content",
                json!({ "noteId": "note", "content": "  kept as written  ", "expectedContentVersion": 3 })
            ),
            Ok(NotesToolCall::UpdateNoteContent {
                note_id: "note".to_string(),
                content: "  kept as written  ".to_string().into(),
                expected_content_version: 3,
            })
        );
        assert_eq!(
            call(
                "move_note",
                json!({ "noteId": "note", "directoryId": null })
            ),
            Ok(NotesToolCall::MoveNote {
                note_id: "note".to_string(),
                directory_id: None,
            })
        );
        assert_eq!(
            call("move_note_directory", json!({ "directoryId": "dir" })),
            Ok(NotesToolCall::MoveNoteDirectory {
                directory_id: "dir".to_string(),
                parent_directory_id: None,
            })
        );
        assert_eq!(
            call(
                "rename_note_directory",
                json!({ "directoryId": "dir", "name": "Plans" })
            ),
            Ok(NotesToolCall::RenameNoteDirectory {
                directory_id: "dir".to_string(),
                name: "Plans".to_string(),
            })
        );
        assert_eq!(
            call("create_note_directory", json!({ "name": "Plans" })),
            Ok(NotesToolCall::CreateNoteDirectory {
                name: "Plans".to_string(),
                parent_directory_id: None,
            })
        );
        assert_eq!(
            call("read_note", json!({ "noteId": "note" })),
            Ok(NotesToolCall::ReadNote {
                note_id: "note".to_string(),
            })
        );
        assert_eq!(
            call(
                "rename_note",
                json!({ "noteId": "note", "name": "Renamed" })
            ),
            Ok(NotesToolCall::RenameNote {
                note_id: "note".to_string(),
                name: "Renamed".to_string(),
            })
        );
        assert_eq!(
            call("delete_note", json!({ "noteId": "note" })),
            Ok(NotesToolCall::DeleteNote {
                note_id: "note".to_string(),
            })
        );
        assert_eq!(
            call("delete_note_directory", json!({ "directoryId": "dir" })),
            Ok(NotesToolCall::DeleteNoteDirectory {
                directory_id: "dir".to_string(),
            })
        );
    }

    #[test]
    fn malformed_arguments_are_refused_with_a_reason() {
        let unknown_field =
            call("read_note", json!({ "noteId": "note", "path": "x" })).unwrap_err();
        assert!(unknown_field.contains("read_note"), "{unknown_field}");

        assert!(call("read_note", json!({})).is_err());
        assert!(call("list_notes", json!({ "noteId": "note" })).is_err());
        assert_eq!(
            call("list_notes", json!({ "directoryId": " " })),
            Err("`directoryId` must be a non-empty string.".to_string())
        );
        assert!(call("create_note", json!({ "name": "x" })).is_err());
        assert_eq!(
            call("rename_note", json!({ "noteId": "note", "name": "   " })),
            Err("`name` must be a non-empty string.".to_string())
        );
        assert_eq!(
            call("move_note", json!({ "noteId": "note", "directoryId": "" })),
            Err("`directoryId` must be a non-empty string.".to_string())
        );
        assert_eq!(
            call(
                "create_note_directory",
                json!({ "name": "Plans", "parentDirectoryId": " " })
            ),
            Err("`parentDirectoryId` must be a non-empty string.".to_string())
        );
        assert_eq!(
            call(
                "move_note_directory",
                json!({ "directoryId": "dir", "parentDirectoryId": " " })
            ),
            Err("`parentDirectoryId` must be a non-empty string.".to_string())
        );
        assert!(
            call(
                "update_note_content",
                json!({ "noteId": "note", "content": "x" })
            )
            .is_err()
        );
        assert!(
            call(
                "update_note_content",
                json!({ "noteId": "note", "content": "x", "expectedContentVersion": 0 })
            )
            .is_err()
        );
        assert!(
            call(
                "update_note_content",
                json!({ "noteId": "note", "content": "x", "expectedContentVersion": "1" })
            )
            .is_err()
        );
    }
}
