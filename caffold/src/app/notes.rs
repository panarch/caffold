//! Notes: Markdown records that agents keep in Caffold's store through the
//! Notes tools, and the read-only projection the Notes workspace shows.
//!
//! Every change arrives as a tool call from a Task Caffold manages; the
//! browser only reads. Directories and Notes live in two tables, so each rule
//! that spans both is checked here inside one store transaction.

use std::collections::{HashMap, HashSet};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::get,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use super::error::ApiError;
use crate::{
    agent::notes_tools::NotesToolCall,
    task_store::{
        Note, NoteContentUpdate, NoteDirectory, NoteSummary, TaskStore, TaskStoreError,
        TaskStoreTables,
    },
};

pub(in crate::app) fn router(store: TaskStore) -> Router {
    Router::new()
        .route("/api/notes", get(notes_level))
        .route("/api/notes/{note_id}", get(note_detail))
        .with_state(NotesState { store })
}

/// Carry out a Notes tool call made by the managed Task `thread_id`, and say
/// what happened in the words the agent reads.
pub(in crate::app) async fn execute_tool(
    store: TaskStore,
    thread_id: String,
    call: NotesToolCall,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || apply_tool(&store, &thread_id, call, now_ms()))
        .await
        .map_err(|error| format!("Caffold's Notes worker failed: {error}"))?
}

#[derive(Clone)]
struct NotesState {
    store: TaskStore,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotesLevelQuery {
    directory_id: Option<String>,
}

/// What one directory, or the top of the Notes tree, directly holds.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NotesLevelResponse {
    directories: Vec<DirectoryResponse>,
    notes: Vec<NoteSummaryResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryResponse {
    id: String,
    name: String,
    updated_at_ms: u64,
    directory_count: usize,
    note_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteSummaryResponse {
    id: String,
    name: String,
    updated_at_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteResponse {
    id: String,
    name: String,
    content: String,
    /// The directories that hold the Note, from the top of the tree.
    location: Vec<LocationResponse>,
    created_at_ms: u64,
    updated_at_ms: u64,
    created_by: NoteTaskResponse,
    updated_by: NoteTaskResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocationResponse {
    id: String,
    name: String,
}

/// The Task that wrote a Note. Only an active Task has a page to open, and a
/// Task deleted since then keeps only its id.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteTaskResponse {
    thread_id: String,
    #[serde(flatten)]
    state: NoteTaskState,
}

#[derive(Debug, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum NoteTaskState {
    Active {
        #[serde(rename = "displayName")]
        display_name: String,
    },
    Archived {
        #[serde(rename = "displayName")]
        display_name: String,
    },
    Deleted,
}

async fn notes_level(
    State(state): State<NotesState>,
    Query(query): Query<NotesLevelQuery>,
) -> Result<Json<NotesLevelResponse>, ApiError> {
    let store = state.store;
    let level = tokio::task::spawn_blocking(move || {
        store.read(|tables| {
            let directory_id = query.directory_id.as_deref();
            if let Some(directory_id) = directory_id
                && tables.note_directory(directory_id)?.is_none()
            {
                return Ok(Err(ApiError::NotFound {
                    code: "note_directory_not_found",
                    message: missing_directory(directory_id),
                }));
            }
            Ok(Ok(read_level(tables, directory_id)?))
        })
    })
    .await
    .map_err(worker_failure)?
    .map_err(store_api_error)??;
    Ok(Json(NotesLevelResponse {
        directories: level
            .directories
            .into_iter()
            .map(|entry| DirectoryResponse {
                id: entry.directory.directory_id,
                name: entry.directory.name,
                updated_at_ms: entry.directory.updated_at_ms,
                directory_count: entry.directory_count,
                note_count: entry.note_count,
            })
            .collect(),
        notes: level
            .notes
            .into_iter()
            .map(|note| NoteSummaryResponse {
                id: note.note_id,
                name: note.name,
                updated_at_ms: note.updated_at_ms,
            })
            .collect(),
    }))
}

async fn note_detail(
    State(state): State<NotesState>,
    Path(note_id): Path<String>,
) -> Result<Json<NoteResponse>, ApiError> {
    let store = state.store;
    let requested = note_id.clone();
    let found = tokio::task::spawn_blocking(move || {
        store.read(|tables| {
            let Some(note) = tables.note(&requested)? else {
                return Ok(None);
            };
            let location = note_location(&tables.note_directories()?, note.directory_id.as_deref());
            let created_by = note_task_state(tables, &note.created_by_thread_id)?;
            let updated_by = note_task_state(tables, &note.updated_by_thread_id)?;
            Ok(Some((note, location, created_by, updated_by)))
        })
    })
    .await
    .map_err(worker_failure)?
    .map_err(store_api_error)?;
    let Some((note, location, created_by, updated_by)) = found else {
        return Err(ApiError::NotFound {
            code: "note_not_found",
            message: format!("No Note has the id `{note_id}`."),
        });
    };
    Ok(Json(NoteResponse {
        id: note.note_id,
        name: note.name,
        content: note.content,
        location,
        created_at_ms: note.created_at_ms,
        updated_at_ms: note.updated_at_ms,
        created_by: NoteTaskResponse {
            thread_id: note.created_by_thread_id,
            state: created_by,
        },
        updated_by: NoteTaskResponse {
            thread_id: note.updated_by_thread_id,
            state: updated_by,
        },
    }))
}

/// What one directory, or the top of the Notes tree when there is none,
/// directly holds, each kind in name order.
struct NotesLevel {
    directories: Vec<LevelDirectory>,
    notes: Vec<NoteSummary>,
}

/// A directory in a level, with how many directories and Notes it directly
/// holds.
struct LevelDirectory {
    directory: NoteDirectory,
    directory_count: usize,
    note_count: usize,
}

fn read_level(
    tables: &mut TaskStoreTables<'_>,
    directory_id: Option<&str>,
) -> Result<NotesLevel, TaskStoreError> {
    let directories = tables.note_directories()?;
    let notes = tables.note_summaries()?;
    let mut directory_counts = HashMap::<String, usize>::new();
    for parent in directories
        .iter()
        .filter_map(|directory| directory.parent_directory_id.clone())
    {
        *directory_counts.entry(parent).or_default() += 1;
    }
    let mut note_counts = HashMap::<String, usize>::new();
    for parent in notes.iter().filter_map(|note| note.directory_id.clone()) {
        *note_counts.entry(parent).or_default() += 1;
    }

    let mut level_directories = directories
        .into_iter()
        .filter(|directory| directory.parent_directory_id.as_deref() == directory_id)
        .map(|directory| LevelDirectory {
            directory_count: directory_counts
                .get(&directory.directory_id)
                .copied()
                .unwrap_or_default(),
            note_count: note_counts
                .get(&directory.directory_id)
                .copied()
                .unwrap_or_default(),
            directory,
        })
        .collect::<Vec<_>>();
    level_directories.sort_by(|left, right| {
        left.directory
            .name
            .cmp(&right.directory.name)
            .then_with(|| {
                left.directory
                    .directory_id
                    .cmp(&right.directory.directory_id)
            })
    });
    let mut level_notes = notes
        .into_iter()
        .filter(|note| note.directory_id.as_deref() == directory_id)
        .collect::<Vec<_>>();
    level_notes.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then_with(|| left.note_id.cmp(&right.note_id))
    });
    Ok(NotesLevel {
        directories: level_directories,
        notes: level_notes,
    })
}

/// The directories that hold `directory_id`, from the top of the tree. The
/// walk stops after as many steps as there are directories, so a damaged
/// parent chain cannot loop.
fn note_location(
    directories: &[NoteDirectory],
    directory_id: Option<&str>,
) -> Vec<LocationResponse> {
    let by_id = directories
        .iter()
        .map(|directory| (directory.directory_id.as_str(), directory))
        .collect::<HashMap<_, _>>();
    let mut location = Vec::new();
    let mut current = directory_id.and_then(|id| by_id.get(id));
    for _ in 0..directories.len() {
        let Some(directory) = current else {
            break;
        };
        location.push(LocationResponse {
            id: directory.directory_id.clone(),
            name: directory.name.clone(),
        });
        current = directory
            .parent_directory_id
            .as_deref()
            .and_then(|id| by_id.get(id));
    }
    location.reverse();
    location
}

fn note_task_state(
    tables: &mut TaskStoreTables<'_>,
    thread_id: &str,
) -> Result<NoteTaskState, TaskStoreError> {
    if let Some(task) = tables.managed_thread(thread_id)? {
        return Ok(NoteTaskState::Active {
            display_name: task.display_name,
        });
    }
    Ok(match tables.archived_managed_thread(thread_id)? {
        Some(task) => NoteTaskState::Archived {
            display_name: task.display_name,
        },
        None => NoteTaskState::Deleted,
    })
}

fn apply_tool(
    store: &TaskStore,
    thread_id: &str,
    call: NotesToolCall,
    now_ms: u64,
) -> Result<String, String> {
    match call {
        NotesToolCall::ListNotes { directory_id } => list_notes(store, directory_id.as_deref()),
        NotesToolCall::ReadNote { note_id } => read_note(store, &note_id),
        NotesToolCall::CreateNote {
            name,
            content,
            directory_id,
        } => create_note(
            store,
            Note {
                note_id: Uuid::new_v4().to_string(),
                directory_id,
                name,
                content,
                content_version: 1,
                created_by_thread_id: thread_id.to_string(),
                updated_by_thread_id: thread_id.to_string(),
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            },
        ),
        NotesToolCall::UpdateNoteContent {
            note_id,
            content,
            expected_content_version,
        } => update_note_content(
            store,
            &note_id,
            &content,
            expected_content_version,
            thread_id,
            now_ms,
        ),
        NotesToolCall::RenameNote { note_id, name } => {
            rename_note(store, &note_id, &name, thread_id, now_ms)
        }
        NotesToolCall::MoveNote {
            note_id,
            directory_id,
        } => move_note(store, &note_id, directory_id.as_deref(), thread_id, now_ms),
        NotesToolCall::DeleteNote { note_id } => delete_note(store, &note_id),
        NotesToolCall::CreateNoteDirectory {
            name,
            parent_directory_id,
        } => create_directory(
            store,
            NoteDirectory {
                directory_id: Uuid::new_v4().to_string(),
                parent_directory_id,
                name,
                created_at_ms: now_ms,
                updated_at_ms: now_ms,
            },
        ),
        NotesToolCall::RenameNoteDirectory { directory_id, name } => {
            rename_directory(store, &directory_id, &name, now_ms)
        }
        NotesToolCall::MoveNoteDirectory {
            directory_id,
            parent_directory_id,
        } => move_directory(store, &directory_id, parent_directory_id.as_deref(), now_ms),
        NotesToolCall::DeleteNoteDirectory { directory_id } => {
            delete_directory(store, &directory_id)
        }
    }
}

fn list_notes(store: &TaskStore, directory_id: Option<&str>) -> Result<String, String> {
    let level = store
        .read(|tables| {
            if let Some(directory_id) = directory_id
                && tables.note_directory(directory_id)?.is_none()
            {
                return Ok(Err(missing_directory(directory_id)));
            }
            Ok(Ok(read_level(tables, directory_id)?))
        })
        .map_err(store_failure)??;
    Ok(json!({
        "directories": level
            .directories
            .iter()
            .map(|entry| json!({
                "directoryId": entry.directory.directory_id,
                "name": entry.directory.name,
                "updatedAt": timestamp(entry.directory.updated_at_ms),
                "directoryCount": entry.directory_count,
                "noteCount": entry.note_count,
            }))
            .collect::<Vec<_>>(),
        "notes": level
            .notes
            .iter()
            .map(|note| json!({
                "noteId": note.note_id,
                "name": note.name,
                "updatedAt": timestamp(note.updated_at_ms),
            }))
            .collect::<Vec<_>>(),
    })
    .to_string())
}

fn read_note(store: &TaskStore, note_id: &str) -> Result<String, String> {
    let note = store
        .read(|tables| tables.note(note_id))
        .map_err(store_failure)?
        .ok_or_else(|| missing_note(note_id))?;
    Ok(json!({
        "noteId": note.note_id,
        "directoryId": note.directory_id,
        "name": note.name,
        "contentVersion": note.content_version,
        "updatedAt": timestamp(note.updated_at_ms),
        "content": note.content,
    })
    .to_string())
}

fn create_note(store: &TaskStore, note: Note) -> Result<String, String> {
    store
        .transaction(|tables| {
            if let Some(directory_id) = note.directory_id.as_deref()
                && tables.note_directory(directory_id)?.is_none()
            {
                return Ok(Err(missing_directory(directory_id)));
            }
            tables.insert_note(&note)?;
            Ok(Ok(json!({
                "noteId": note.note_id,
                "contentVersion": note.content_version,
            })
            .to_string()))
        })
        .map_err(store_failure)?
}

fn update_note_content(
    store: &TaskStore,
    note_id: &str,
    content: &str,
    expected_content_version: i64,
    thread_id: &str,
    now_ms: u64,
) -> Result<String, String> {
    let update = store
        .transaction(|tables| {
            tables.update_note_content(
                note_id,
                content,
                expected_content_version,
                thread_id,
                now_ms,
            )
        })
        .map_err(store_failure)?;
    match update {
        NoteContentUpdate::Updated { content_version } => Ok(json!({
            "noteId": note_id,
            "contentVersion": content_version,
        })
        .to_string()),
        NoteContentUpdate::Stale { content_version } => Err(format!(
            "The Note `{note_id}` changed after it was read, so nothing was written. Its contentVersion is now {content_version}: read it again, reapply the change, and retry with that version."
        )),
        NoteContentUpdate::Missing => Err(missing_note(note_id)),
    }
}

fn rename_note(
    store: &TaskStore,
    note_id: &str,
    name: &str,
    thread_id: &str,
    now_ms: u64,
) -> Result<String, String> {
    let renamed = store
        .transaction(|tables| tables.rename_note(note_id, name, thread_id, now_ms))
        .map_err(store_failure)?;
    if !renamed {
        return Err(missing_note(note_id));
    }
    Ok(format!("Renamed the Note `{note_id}` to `{name}`."))
}

fn move_note(
    store: &TaskStore,
    note_id: &str,
    directory_id: Option<&str>,
    thread_id: &str,
    now_ms: u64,
) -> Result<String, String> {
    store
        .transaction(|tables| {
            if let Some(directory_id) = directory_id
                && tables.note_directory(directory_id)?.is_none()
            {
                return Ok(Err(missing_directory(directory_id)));
            }
            if !tables.move_note(note_id, directory_id, thread_id, now_ms)? {
                return Ok(Err(missing_note(note_id)));
            }
            Ok(Ok(match directory_id {
                Some(directory_id) => {
                    format!("Moved the Note `{note_id}` into the directory `{directory_id}`.")
                }
                None => format!("Moved the Note `{note_id}` to the top of the Notes tree."),
            }))
        })
        .map_err(store_failure)?
}

fn delete_note(store: &TaskStore, note_id: &str) -> Result<String, String> {
    let deleted = store
        .transaction(|tables| tables.delete_note(note_id))
        .map_err(store_failure)?;
    if !deleted {
        return Err(missing_note(note_id));
    }
    Ok(format!("Deleted the Note `{note_id}`."))
}

fn create_directory(store: &TaskStore, directory: NoteDirectory) -> Result<String, String> {
    store
        .transaction(|tables| {
            if let Some(parent_id) = directory.parent_directory_id.as_deref()
                && tables.note_directory(parent_id)?.is_none()
            {
                return Ok(Err(missing_directory(parent_id)));
            }
            tables.insert_note_directory(&directory)?;
            Ok(Ok(
                json!({ "directoryId": directory.directory_id }).to_string()
            ))
        })
        .map_err(store_failure)?
}

fn rename_directory(
    store: &TaskStore,
    directory_id: &str,
    name: &str,
    now_ms: u64,
) -> Result<String, String> {
    let renamed = store
        .transaction(|tables| tables.rename_note_directory(directory_id, name, now_ms))
        .map_err(store_failure)?;
    if !renamed {
        return Err(missing_directory(directory_id));
    }
    Ok(format!(
        "Renamed the directory `{directory_id}` to `{name}`."
    ))
}

fn move_directory(
    store: &TaskStore,
    directory_id: &str,
    parent_id: Option<&str>,
    now_ms: u64,
) -> Result<String, String> {
    store
        .transaction(|tables| {
            let directories = tables.note_directories()?;
            if !directories
                .iter()
                .any(|directory| directory.directory_id == directory_id)
            {
                return Ok(Err(missing_directory(directory_id)));
            }
            if let Some(parent_id) = parent_id {
                if !directories
                    .iter()
                    .any(|directory| directory.directory_id == parent_id)
                {
                    return Ok(Err(missing_directory(parent_id)));
                }
                if holds(&directories, directory_id, parent_id) {
                    return Ok(Err(format!(
                        "The directory `{directory_id}` cannot move into itself or one of its subdirectories."
                    )));
                }
            }
            tables.move_note_directory(directory_id, parent_id, now_ms)?;
            Ok(Ok(match parent_id {
                Some(parent_id) => {
                    format!("Moved the directory `{directory_id}` into the directory `{parent_id}`.")
                }
                None => {
                    format!("Moved the directory `{directory_id}` to the top of the Notes tree.")
                }
            }))
        })
        .map_err(store_failure)?
}

fn delete_directory(store: &TaskStore, directory_id: &str) -> Result<String, String> {
    store
        .transaction(|tables| {
            if tables.note_directory(directory_id)?.is_none() {
                return Ok(Err(missing_directory(directory_id)));
            }
            if tables.note_directory_has_child_directories(directory_id)?
                || tables.note_directory_has_notes(directory_id)?
            {
                return Ok(Err(format!(
                    "The directory `{directory_id}` still holds Notes or directories, so it was not deleted. Delete or move what it holds first."
                )));
            }
            tables.delete_note_directory(directory_id)?;
            Ok(Ok(format!("Deleted the directory `{directory_id}`.")))
        })
        .map_err(store_failure)?
}

/// Whether `candidate` is `directory_id` or lies anywhere below it.
fn holds(directories: &[NoteDirectory], directory_id: &str, candidate: &str) -> bool {
    let mut pending = vec![directory_id];
    let mut visited = HashSet::new();
    while let Some(current) = pending.pop() {
        if current == candidate {
            return true;
        }
        if !visited.insert(current) {
            continue;
        }
        pending.extend(
            directories
                .iter()
                .filter(|directory| directory.parent_directory_id.as_deref() == Some(current))
                .map(|directory| directory.directory_id.as_str()),
        );
    }
    false
}

fn missing_note(note_id: &str) -> String {
    format!("No Note has the id `{note_id}`.")
}

fn missing_directory(directory_id: &str) -> String {
    format!("No Note directory has the id `{directory_id}`.")
}

fn store_failure(error: TaskStoreError) -> String {
    format!("Caffold could not reach its Notes store: {error}")
}

fn store_api_error(error: TaskStoreError) -> ApiError {
    ApiError::Internal(format!("Caffold could not read its Notes store: {error}"))
}

fn worker_failure(error: tokio::task::JoinError) -> ApiError {
    ApiError::Internal(format!("Caffold's Notes worker failed: {error}"))
}

fn timestamp(milliseconds: u64) -> Value {
    i64::try_from(milliseconds)
        .ok()
        .and_then(DateTime::<Utc>::from_timestamp_millis)
        .map_or(Value::Null, |time| {
            Value::String(time.to_rfc3339_opts(SecondsFormat::Millis, true))
        })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    use super::*;
    use crate::task_store::{ManagedThread, RunBy};

    fn apply(store: &TaskStore, thread_id: &str, call: NotesToolCall, now_ms: u64) -> Value {
        let answer = apply_tool(store, thread_id, call, now_ms).unwrap();
        serde_json::from_str(&answer).unwrap_or(Value::String(answer))
    }

    fn create_directory_call(name: &str, parent: Option<&str>) -> NotesToolCall {
        NotesToolCall::CreateNoteDirectory {
            name: name.to_string(),
            parent_directory_id: parent.map(str::to_string),
        }
    }

    fn directory_id(answer: &Value) -> String {
        answer["directoryId"].as_str().unwrap().to_string()
    }

    fn list_call(directory_id: Option<&str>) -> NotesToolCall {
        NotesToolCall::ListNotes {
            directory_id: directory_id.map(str::to_string),
        }
    }

    #[test]
    fn a_note_goes_through_its_whole_life_by_tool_calls() {
        let store = TaskStore::memory().unwrap();
        let decisions = directory_id(&apply(
            &store,
            "task-a",
            create_directory_call("Decisions", None),
            1_000,
        ));

        let created = apply(
            &store,
            "task-a",
            NotesToolCall::CreateNote {
                name: "Storage".to_string(),
                content: "# Storage\n".to_string(),
                directory_id: Some(decisions.clone()),
            },
            2_000,
        );
        let note_id = created["noteId"].as_str().unwrap().to_string();
        assert_eq!(created["contentVersion"], 1);

        let top = apply(&store, "task-b", list_call(None), 3_000);
        assert_eq!(
            top,
            json!({
                "directories": [{
                    "directoryId": decisions,
                    "name": "Decisions",
                    "updatedAt": "1970-01-01T00:00:01.000Z",
                    "directoryCount": 0,
                    "noteCount": 1,
                }],
                "notes": [],
            })
        );
        let inside = apply(&store, "task-b", list_call(Some(&decisions)), 3_000);
        assert_eq!(
            inside,
            json!({
                "directories": [],
                "notes": [{
                    "noteId": note_id,
                    "name": "Storage",
                    "updatedAt": "1970-01-01T00:00:02.000Z",
                }],
            })
        );

        let read = apply(
            &store,
            "task-b",
            NotesToolCall::ReadNote {
                note_id: note_id.clone(),
            },
            3_000,
        );
        assert_eq!(read["content"], "# Storage\n");
        assert_eq!(read["contentVersion"], 1);

        let updated = apply(
            &store,
            "task-b",
            NotesToolCall::UpdateNoteContent {
                note_id: note_id.clone(),
                content: "# Storage\n\nUse redb.\n".to_string(),
                expected_content_version: 1,
            },
            4_000,
        );
        assert_eq!(updated["contentVersion"], 2);
        let stale = apply_tool(
            &store,
            "task-c",
            NotesToolCall::UpdateNoteContent {
                note_id: note_id.clone(),
                content: "lost".to_string(),
                expected_content_version: 1,
            },
            5_000,
        )
        .unwrap_err();
        assert!(stale.contains("contentVersion is now 2"), "{stale}");

        apply(
            &store,
            "task-c",
            NotesToolCall::RenameNote {
                note_id: note_id.clone(),
                name: "Storage decision".to_string(),
            },
            6_000,
        );
        let refused = apply_tool(
            &store,
            "task-c",
            NotesToolCall::DeleteNoteDirectory {
                directory_id: decisions.clone(),
            },
            6_500,
        )
        .unwrap_err();
        assert!(refused.contains("still holds"), "{refused}");
        apply(
            &store,
            "task-c",
            NotesToolCall::MoveNote {
                note_id: note_id.clone(),
                directory_id: None,
            },
            7_000,
        );

        let stored = store.read(|tables| tables.note(&note_id)).unwrap().unwrap();
        assert_eq!(stored.name, "Storage decision");
        assert_eq!(stored.directory_id, None);
        assert_eq!(stored.content, "# Storage\n\nUse redb.\n");
        assert_eq!(stored.content_version, 2);
        assert_eq!(stored.created_by_thread_id, "task-a");
        assert_eq!(stored.updated_by_thread_id, "task-c");
        assert_eq!(stored.updated_at_ms, 7_000);

        assert_eq!(
            apply(
                &store,
                "task-c",
                NotesToolCall::DeleteNoteDirectory {
                    directory_id: decisions.clone(),
                },
                8_000,
            ),
            Value::String(format!("Deleted the directory `{decisions}`."))
        );
        apply(
            &store,
            "task-c",
            NotesToolCall::DeleteNote {
                note_id: note_id.clone(),
            },
            9_000,
        );
        let emptied = apply(&store, "task-c", list_call(None), 9_000);
        assert_eq!(emptied, json!({ "directories": [], "notes": [] }));
    }

    #[test]
    fn a_level_lists_only_what_its_directory_directly_holds() {
        let store = TaskStore::memory().unwrap();
        let projects = directory_id(&apply(
            &store,
            "task",
            create_directory_call("Projects", None),
            1_000,
        ));
        let caffold = directory_id(&apply(
            &store,
            "task",
            create_directory_call("Caffold", Some(&projects)),
            1_000,
        ));
        let empty = directory_id(&apply(
            &store,
            "task",
            create_directory_call("Empty", Some(&projects)),
            1_000,
        ));
        for (name, directory) in [
            ("Inbox", None),
            ("Plan", Some(projects.as_str())),
            ("Storage", Some(caffold.as_str())),
            ("History", Some(caffold.as_str())),
        ] {
            apply(
                &store,
                "task",
                NotesToolCall::CreateNote {
                    name: name.to_string(),
                    content: String::new(),
                    directory_id: directory.map(str::to_string),
                },
                1_000,
            );
        }
        let names = |level: &Value, kind: &str| {
            level[kind]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["name"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };

        let top = apply(&store, "task", list_call(None), 1_000);
        assert_eq!(names(&top, "directories"), ["Projects"]);
        assert_eq!(top["directories"][0]["directoryCount"], 2);
        assert_eq!(top["directories"][0]["noteCount"], 1);
        assert_eq!(names(&top, "notes"), ["Inbox"]);

        let inside_projects = apply(&store, "task", list_call(Some(&projects)), 1_000);
        assert_eq!(names(&inside_projects, "directories"), ["Caffold", "Empty"]);
        assert_eq!(inside_projects["directories"][0]["directoryId"], caffold);
        assert_eq!(inside_projects["directories"][0]["directoryCount"], 0);
        assert_eq!(inside_projects["directories"][0]["noteCount"], 2);
        assert_eq!(inside_projects["directories"][1]["directoryId"], empty);
        assert_eq!(inside_projects["directories"][1]["noteCount"], 0);
        assert_eq!(names(&inside_projects, "notes"), ["Plan"]);

        let inside_caffold = apply(&store, "task", list_call(Some(&caffold)), 1_000);
        assert_eq!(names(&inside_caffold, "directories"), Vec::<String>::new());
        assert_eq!(names(&inside_caffold, "notes"), ["History", "Storage"]);
    }

    #[test]
    fn listing_orders_directories_and_notes_by_name_then_id() {
        let store = TaskStore::memory().unwrap();
        for name in ["Zeta", "Alpha", "Alpha"] {
            apply(&store, "task", create_directory_call(name, None), 1_000);
        }
        for name in ["Later", "Earlier"] {
            apply(
                &store,
                "task",
                NotesToolCall::CreateNote {
                    name: name.to_string(),
                    content: String::new(),
                    directory_id: None,
                },
                1_000,
            );
        }

        let listed = apply(&store, "task", list_call(None), 1_000);
        let names = |kind: &str| {
            listed[kind]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["name"].as_str().unwrap().to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(names("directories"), ["Alpha", "Alpha", "Zeta"]);
        assert_eq!(names("notes"), ["Earlier", "Later"]);
        let alpha_ids = listed["directories"]
            .as_array()
            .unwrap()
            .iter()
            .take(2)
            .map(|entry| entry["directoryId"].as_str().unwrap().to_string())
            .collect::<Vec<_>>();
        let mut sorted_ids = alpha_ids.clone();
        sorted_ids.sort();
        assert_eq!(alpha_ids, sorted_ids);
    }

    #[test]
    fn a_note_moves_into_a_directory_and_a_directory_takes_a_new_name() {
        let store = TaskStore::memory().unwrap();
        let directory = directory_id(&apply(
            &store,
            "task",
            create_directory_call("Drafts", None),
            1_000,
        ));
        let note_id = apply(
            &store,
            "task",
            NotesToolCall::CreateNote {
                name: "Loose".to_string(),
                content: String::new(),
                directory_id: None,
            },
            1_000,
        )["noteId"]
            .as_str()
            .unwrap()
            .to_string();

        assert_eq!(
            apply(
                &store,
                "mover",
                NotesToolCall::MoveNote {
                    note_id: note_id.clone(),
                    directory_id: Some(directory.clone()),
                },
                2_000,
            ),
            Value::String(format!(
                "Moved the Note `{note_id}` into the directory `{directory}`."
            ))
        );
        assert_eq!(
            apply(
                &store,
                "renamer",
                NotesToolCall::RenameNoteDirectory {
                    directory_id: directory.clone(),
                    name: "Published".to_string(),
                },
                3_000,
            ),
            Value::String(format!(
                "Renamed the directory `{directory}` to `Published`."
            ))
        );
        assert_eq!(
            apply_tool(
                &store,
                "mover",
                NotesToolCall::MoveNote {
                    note_id: note_id.clone(),
                    directory_id: Some("gone".to_string()),
                },
                4_000,
            ),
            Err("No Note directory has the id `gone`.".to_string())
        );

        let note = store.read(|tables| tables.note(&note_id)).unwrap().unwrap();
        assert_eq!(note.directory_id.as_deref(), Some(directory.as_str()));
        assert_eq!(note.updated_by_thread_id, "mover");
        let renamed = store
            .read(|tables| tables.note_directory(&directory))
            .unwrap()
            .unwrap();
        assert_eq!(renamed.name, "Published");
        assert_eq!(renamed.updated_at_ms, 3_000);
    }

    #[test]
    fn a_missing_note_or_directory_is_named_and_nothing_is_written() {
        let store = TaskStore::memory().unwrap();

        let calls = [
            NotesToolCall::ReadNote {
                note_id: "gone".to_string(),
            },
            NotesToolCall::UpdateNoteContent {
                note_id: "gone".to_string(),
                content: "x".to_string(),
                expected_content_version: 1,
            },
            NotesToolCall::RenameNote {
                note_id: "gone".to_string(),
                name: "x".to_string(),
            },
            NotesToolCall::MoveNote {
                note_id: "gone".to_string(),
                directory_id: None,
            },
            NotesToolCall::DeleteNote {
                note_id: "gone".to_string(),
            },
        ];
        for call in calls {
            assert_eq!(
                apply_tool(&store, "task", call, 1_000),
                Err("No Note has the id `gone`.".to_string())
            );
        }

        let calls = [
            NotesToolCall::CreateNote {
                name: "Orphan".to_string(),
                content: String::new(),
                directory_id: Some("gone".to_string()),
            },
            create_directory_call("Orphan", Some("gone")),
            NotesToolCall::RenameNoteDirectory {
                directory_id: "gone".to_string(),
                name: "x".to_string(),
            },
            NotesToolCall::MoveNoteDirectory {
                directory_id: "gone".to_string(),
                parent_directory_id: None,
            },
            NotesToolCall::DeleteNoteDirectory {
                directory_id: "gone".to_string(),
            },
            list_call(Some("gone")),
        ];
        for call in calls {
            assert_eq!(
                apply_tool(&store, "task", call, 1_000),
                Err("No Note directory has the id `gone`.".to_string())
            );
        }
        assert_eq!(
            apply(&store, "task", list_call(None), 1_000),
            json!({ "directories": [], "notes": [] })
        );
    }

    #[test]
    fn a_directory_moves_anywhere_except_into_itself_or_below_itself() {
        let store = TaskStore::memory().unwrap();
        let top = directory_id(&apply(
            &store,
            "task",
            create_directory_call("Top", None),
            1_000,
        ));
        let child = directory_id(&apply(
            &store,
            "task",
            create_directory_call("Child", Some(&top)),
            1_000,
        ));
        let grandchild = directory_id(&apply(
            &store,
            "task",
            create_directory_call("Grandchild", Some(&child)),
            1_000,
        ));
        let other = directory_id(&apply(
            &store,
            "task",
            create_directory_call("Other", None),
            1_000,
        ));
        let moving = |directory_id: &str, parent: Option<&str>| {
            apply_tool(
                &store,
                "task",
                NotesToolCall::MoveNoteDirectory {
                    directory_id: directory_id.to_string(),
                    parent_directory_id: parent.map(str::to_string),
                },
                2_000,
            )
        };

        for into in [top.as_str(), child.as_str(), grandchild.as_str()] {
            let refused = moving(&top, Some(into)).unwrap_err();
            assert!(refused.contains("cannot move into itself"), "{refused}");
        }
        assert_eq!(
            moving(&child, Some("gone")),
            Err("No Note directory has the id `gone`.".to_string())
        );
        assert!(moving(&child, Some(&other)).is_ok());
        assert!(moving(&top, Some(&grandchild)).is_ok());
        assert!(moving(&top, None).is_ok());

        let directories = store.read(|tables| tables.note_directories()).unwrap();
        let parent_of = |id: &str| {
            directories
                .iter()
                .find(|directory| directory.directory_id == id)
                .unwrap()
                .parent_directory_id
                .clone()
        };
        assert_eq!(parent_of(&top), None);
        assert_eq!(parent_of(&child), Some(other.clone()));
        assert_eq!(parent_of(&grandchild), Some(child.clone()));
    }

    #[tokio::test]
    async fn the_browser_reads_the_tree_and_one_note_with_the_tasks_that_wrote_it() {
        let store = TaskStore::memory().unwrap();
        let mut writer = ManagedThread::new("task-writer", RunBy::Codex, None, None, None);
        writer.display_name = "Write storage notes".to_string();
        store.claim(writer, 100).unwrap();
        let directory = directory_id(&apply(
            &store,
            "task-writer",
            create_directory_call("Decisions", None),
            1_000,
        ));
        let note_id = apply(
            &store,
            "task-writer",
            NotesToolCall::CreateNote {
                name: "Storage".to_string(),
                content: "# Storage\n".to_string(),
                directory_id: Some(directory.clone()),
            },
            2_000,
        )["noteId"]
            .as_str()
            .unwrap()
            .to_string();
        apply(
            &store,
            "task-deleted",
            NotesToolCall::RenameNote {
                note_id: note_id.clone(),
                name: "Storage decision".to_string(),
            },
            3_000,
        );
        let app = router(store.clone());

        let top = get_json(&app, "/api/notes").await;
        assert_eq!(
            top,
            json!({
                "directories": [{
                    "id": directory,
                    "name": "Decisions",
                    "updatedAtMs": 1_000,
                    "directoryCount": 0,
                    "noteCount": 1,
                }],
                "notes": [],
            })
        );
        let inside = get_json(&app, &format!("/api/notes?directoryId={directory}")).await;
        assert_eq!(
            inside,
            json!({
                "directories": [],
                "notes": [{
                    "id": note_id,
                    "name": "Storage decision",
                    "updatedAtMs": 3_000,
                }],
            })
        );

        let note = get_json(&app, &format!("/api/notes/{note_id}")).await;
        assert_eq!(
            note,
            json!({
                "id": note_id,
                "name": "Storage decision",
                "content": "# Storage\n",
                "location": [{ "id": directory, "name": "Decisions" }],
                "createdAtMs": 2_000,
                "updatedAtMs": 3_000,
                "createdBy": {
                    "threadId": "task-writer",
                    "state": "active",
                    "displayName": "Write storage notes",
                },
                "updatedBy": { "threadId": "task-deleted", "state": "deleted" },
            })
        );

        store.archive("task-writer", 4_000).unwrap();
        let after_archive = get_json(&app, &format!("/api/notes/{note_id}")).await;
        assert_eq!(
            after_archive["createdBy"],
            json!({
                "threadId": "task-writer",
                "state": "archived",
                "displayName": "Write storage notes",
            })
        );

        for (uri, code) in [
            ("/api/notes/gone", "note_not_found"),
            ("/api/notes?directoryId=gone", "note_directory_not_found"),
        ] {
            let missing = app
                .clone()
                .oneshot(Request::get(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(missing.status(), StatusCode::NOT_FOUND, "{uri}");
            let body: Value =
                serde_json::from_slice(&to_bytes(missing.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body["error"]["code"], code, "{uri}");
        }
    }

    #[test]
    fn a_location_names_the_directories_from_the_top_and_ends_on_a_broken_chain() {
        let directory = |id: &str, parent: Option<&str>| NoteDirectory {
            directory_id: id.to_string(),
            parent_directory_id: parent.map(str::to_string),
            name: format!("Directory {id}"),
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
        };
        let ids = |location: Vec<LocationResponse>| {
            location
                .into_iter()
                .map(|entry| entry.id)
                .collect::<Vec<_>>()
        };
        let tree = [
            directory("top", None),
            directory("middle", Some("top")),
            directory("deep", Some("middle")),
        ];
        assert_eq!(
            ids(note_location(&tree, Some("deep"))),
            ["top", "middle", "deep"]
        );
        assert_eq!(ids(note_location(&tree, None)), Vec::<String>::new());
        assert_eq!(
            ids(note_location(&tree, Some("gone"))),
            Vec::<String>::new()
        );

        let looped = [directory("a", Some("b")), directory("b", Some("a"))];
        assert_eq!(ids(note_location(&looped, Some("a"))).len(), 2);
    }

    async fn get_json(app: &Router, uri: &str) -> Value {
        let response = app
            .clone()
            .oneshot(Request::get(uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
    }
}
