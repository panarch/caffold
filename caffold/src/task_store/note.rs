use chrono::{DateTime, NaiveDateTime, Utc};
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::Value,
        executor::Payload,
        query_builder::{Execute, ExprNode, col, null, table, text, value as glue_value},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, SelectResultExt},
};

use super::{Result, TaskStoreError};

pub(super) const TABLE_NAME: &str = "notes";

const COLUMN_DEFINITIONS: &[&str] = &[
    "note_id TEXT PRIMARY KEY",
    "directory_id TEXT NULL",
    "name TEXT",
    "content TEXT",
    "content_version INTEGER",
    "created_by_thread_id TEXT",
    "updated_by_thread_id TEXT",
    "created_at TIMESTAMP",
    "updated_at TIMESTAMP",
];

/// A Note as the Notes tree lists it, without its content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NoteSummary {
    pub note_id: String,
    pub directory_id: Option<String>,
    pub name: String,
    pub updated_at_ms: u64,
}

/// A Note with its content. Every Note is written by an agent through a Task,
/// so both the Task that created it and the Task that last changed it are
/// always known.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Note {
    pub note_id: String,
    pub directory_id: Option<String>,
    pub name: String,
    pub content: String,
    pub content_version: i64,
    pub created_by_thread_id: String,
    pub updated_by_thread_id: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

/// What replacing a Note's content did. A content version other than the one
/// the writer read leaves the Note unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoteContentUpdate {
    Updated { content_version: i64 },
    Stale { content_version: i64 },
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct NoteRow {
    note_id: String,
    directory_id: Option<String>,
    name: String,
    content: String,
    content_version: i64,
    created_by_thread_id: String,
    updated_by_thread_id: String,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct NoteSummaryRow {
    note_id: String,
    directory_id: Option<String>,
    name: String,
    updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct NoteVersionRow {
    content_version: i64,
}

impl TryFrom<&Note> for NoteRow {
    type Error = TaskStoreError;

    fn try_from(note: &Note) -> Result<Self> {
        Ok(Self {
            note_id: note.note_id.clone(),
            directory_id: note.directory_id.clone(),
            name: note.name.clone(),
            content: note.content.clone(),
            content_version: note.content_version,
            created_by_thread_id: note.created_by_thread_id.clone(),
            updated_by_thread_id: note.updated_by_thread_id.clone(),
            created_at: to_timestamp(note.created_at_ms, "created_at")?,
            updated_at: to_timestamp(note.updated_at_ms, "updated_at")?,
        })
    }
}

impl TryFrom<NoteRow> for Note {
    type Error = TaskStoreError;

    fn try_from(row: NoteRow) -> Result<Self> {
        Ok(Self {
            note_id: row.note_id,
            directory_id: row.directory_id,
            name: row.name,
            content: row.content,
            content_version: row.content_version,
            created_by_thread_id: row.created_by_thread_id,
            updated_by_thread_id: row.updated_by_thread_id,
            created_at_ms: from_timestamp(row.created_at, "created_at")?,
            updated_at_ms: from_timestamp(row.updated_at, "updated_at")?,
        })
    }
}

impl TryFrom<NoteSummaryRow> for NoteSummary {
    type Error = TaskStoreError;

    fn try_from(row: NoteSummaryRow) -> Result<Self> {
        Ok(Self {
            note_id: row.note_id,
            directory_id: row.directory_id,
            name: row.name,
            updated_at_ms: from_timestamp(row.updated_at, "updated_at")?,
        })
    }
}

pub(super) fn create_table<S>(glue: &mut Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let mut query = table(TABLE_NAME).create_table_if_not_exists();
    for definition in COLUMN_DEFINITIONS {
        query = query.add_column(*definition);
    }
    query.execute(glue)?;
    Ok(())
}

pub(super) fn list_summaries<S>(glue: &mut Glue<S>) -> Result<Vec<NoteSummary>>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .select()
        .project(columns(NoteSummaryRow::glue_columns()))
        .execute(glue)
        .rows_as::<NoteSummaryRow>()?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(super) fn get<S>(glue: &mut Glue<S>, note_id: &str) -> Result<Option<Note>>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .select()
        .filter(col("note_id").eq(text(note_id.to_owned())))
        .project(columns(NoteRow::glue_columns()))
        .limit(1)
        .execute(glue)
        .rows_as::<NoteRow>()?
        .into_iter()
        .next()
        .map(TryInto::try_into)
        .transpose()
}

pub(super) fn insert<S>(glue: &mut Glue<S>, note: &Note) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    if note.note_id.trim().is_empty() {
        return Err(TaskStoreError::InvalidRow("note_id"));
    }
    let row = NoteRow::try_from(note)?;
    table(TABLE_NAME)
        .insert()
        .values_from(std::slice::from_ref(&row))?
        .execute(glue)?;
    Ok(())
}

pub(super) fn any_in_directory<S>(glue: &mut Glue<S>, directory_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let notes = table(TABLE_NAME)
        .select()
        .filter(col("directory_id").eq(text(directory_id.to_owned())))
        .project(columns(NoteSummaryRow::glue_columns()))
        .limit(1)
        .execute(glue)
        .rows_as::<NoteSummaryRow>()?;
    Ok(!notes.is_empty())
}

pub(super) fn update_content<S>(
    glue: &mut Glue<S>,
    note_id: &str,
    content: &str,
    expected_content_version: i64,
    thread_id: &str,
    now_ms: u64,
) -> Result<NoteContentUpdate>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(current) = table(TABLE_NAME)
        .select()
        .filter(col("note_id").eq(text(note_id.to_owned())))
        .project(columns(NoteVersionRow::glue_columns()))
        .limit(1)
        .execute(glue)
        .rows_as::<NoteVersionRow>()?
        .into_iter()
        .next()
    else {
        return Ok(NoteContentUpdate::Missing);
    };
    if current.content_version != expected_content_version {
        return Ok(NoteContentUpdate::Stale {
            content_version: current.content_version,
        });
    }
    let content_version = current
        .content_version
        .checked_add(1)
        .ok_or(TaskStoreError::InvalidRow("content_version"))?;
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("note_id").eq(text(note_id.to_owned())))
        .set("content", text(content.to_owned()))
        .set("content_version", glue_value(Value::I64(content_version)))
        .set("updated_by_thread_id", text(thread_id.to_owned()))
        .set("updated_at", timestamp_value(now_ms, "updated_at")?)
        .execute(glue)?;
    match payload {
        Payload::Update(1) => Ok(NoteContentUpdate::Updated { content_version }),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

pub(super) fn rename<S>(
    glue: &mut Glue<S>,
    note_id: &str,
    name: &str,
    thread_id: &str,
    now_ms: u64,
) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("note_id").eq(text(note_id.to_owned())))
        .set("name", text(name.to_owned()))
        .set("updated_by_thread_id", text(thread_id.to_owned()))
        .set("updated_at", timestamp_value(now_ms, "updated_at")?)
        .execute(glue)?;
    updated_one(payload)
}

pub(super) fn move_to<S>(
    glue: &mut Glue<S>,
    note_id: &str,
    directory_id: Option<&str>,
    thread_id: &str,
    now_ms: u64,
) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let directory = directory_id
        .map(|directory| text(directory.to_owned()))
        .unwrap_or_else(null);
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("note_id").eq(text(note_id.to_owned())))
        .set("directory_id", directory)
        .set("updated_by_thread_id", text(thread_id.to_owned()))
        .set("updated_at", timestamp_value(now_ms, "updated_at")?)
        .execute(glue)?;
    updated_one(payload)
}

pub(super) fn delete<S>(glue: &mut Glue<S>, note_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    match table(TABLE_NAME)
        .delete()
        .filter(col("note_id").eq(text(note_id.to_owned())))
        .execute(glue)?
    {
        Payload::Delete(0) => Ok(false),
        Payload::Delete(1) => Ok(true),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn columns(names: &'static [&'static str]) -> Vec<ExprNode<'static>> {
    names.iter().map(|column| col(*column)).collect()
}

fn updated_one(payload: Payload) -> Result<bool> {
    match payload {
        Payload::Update(0) => Ok(false),
        Payload::Update(1) => Ok(true),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn timestamp_value(value: u64, field: &'static str) -> Result<ExprNode<'static>> {
    Ok(glue_value(Value::Timestamp(to_timestamp(value, field)?)))
}

fn to_timestamp(value: u64, field: &'static str) -> Result<NaiveDateTime> {
    let milliseconds = i64::try_from(value).map_err(|_| TaskStoreError::InvalidRow(field))?;
    DateTime::<Utc>::from_timestamp_millis(milliseconds)
        .map(|timestamp| timestamp.naive_utc())
        .ok_or(TaskStoreError::InvalidRow(field))
}

fn from_timestamp(value: NaiveDateTime, field: &'static str) -> Result<u64> {
    u64::try_from(value.and_utc().timestamp_millis()).map_err(|_| TaskStoreError::InvalidRow(field))
}

#[cfg(test)]
mod tests {
    use gluesql::prelude::MemoryStorage;

    use super::*;

    fn memory() -> Glue<MemoryStorage> {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();
        glue
    }

    fn note(note_id: &str, directory_id: Option<&str>) -> Note {
        Note {
            note_id: note_id.to_string(),
            directory_id: directory_id.map(str::to_string),
            name: format!("Note {note_id}"),
            content: format!("# {note_id}\n"),
            content_version: 1,
            created_by_thread_id: "creator-task".to_string(),
            updated_by_thread_id: "creator-task".to_string(),
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
        }
    }

    #[test]
    fn inserted_notes_read_back_whole_and_list_without_content() {
        let mut glue = memory();
        let top = note("top", None);
        let nested = note("nested", Some("directory"));
        insert(&mut glue, &top).unwrap();
        insert(&mut glue, &nested).unwrap();

        assert_eq!(get(&mut glue, "nested").unwrap(), Some(nested));
        assert_eq!(get(&mut glue, "missing").unwrap(), None);
        let mut summaries = list_summaries(&mut glue).unwrap();
        summaries.sort_by(|left, right| left.note_id.cmp(&right.note_id));
        assert_eq!(
            summaries,
            [
                NoteSummary {
                    note_id: "nested".to_string(),
                    directory_id: Some("directory".to_string()),
                    name: "Note nested".to_string(),
                    updated_at_ms: 1_000,
                },
                NoteSummary {
                    note_id: "top".to_string(),
                    directory_id: None,
                    name: "Note top".to_string(),
                    updated_at_ms: 1_000,
                },
            ]
        );
    }

    #[test]
    fn a_note_without_an_id_is_not_stored() {
        let mut glue = memory();

        assert!(matches!(
            insert(&mut glue, &note("", None)),
            Err(TaskStoreError::InvalidRow("note_id"))
        ));
        assert!(list_summaries(&mut glue).unwrap().is_empty());
    }

    #[test]
    fn content_changes_only_against_the_version_the_writer_read() {
        let mut glue = memory();
        insert(&mut glue, &note("note", None)).unwrap();

        assert_eq!(
            update_content(&mut glue, "note", "second", 1, "editor-task", 2_000).unwrap(),
            NoteContentUpdate::Updated { content_version: 2 }
        );
        assert_eq!(
            update_content(&mut glue, "note", "stale write", 1, "late-task", 3_000).unwrap(),
            NoteContentUpdate::Stale { content_version: 2 }
        );
        assert_eq!(
            update_content(&mut glue, "missing", "anything", 1, "editor-task", 3_000).unwrap(),
            NoteContentUpdate::Missing
        );

        let stored = get(&mut glue, "note").unwrap().unwrap();
        assert_eq!(stored.content, "second");
        assert_eq!(stored.content_version, 2);
        assert_eq!(stored.created_by_thread_id, "creator-task");
        assert_eq!(stored.updated_by_thread_id, "editor-task");
        assert_eq!(stored.updated_at_ms, 2_000);
    }

    #[test]
    fn rename_and_move_record_the_task_without_touching_the_content_version() {
        let mut glue = memory();
        insert(&mut glue, &note("note", None)).unwrap();

        assert!(rename(&mut glue, "note", "Renamed", "renaming-task", 2_000).unwrap());
        assert!(move_to(&mut glue, "note", Some("directory"), "moving-task", 3_000).unwrap());
        let moved = get(&mut glue, "note").unwrap().unwrap();
        assert_eq!(moved.name, "Renamed");
        assert_eq!(moved.directory_id.as_deref(), Some("directory"));
        assert_eq!(moved.content_version, 1);
        assert_eq!(moved.updated_by_thread_id, "moving-task");
        assert_eq!(moved.updated_at_ms, 3_000);

        assert!(move_to(&mut glue, "note", None, "moving-task", 4_000).unwrap());
        assert_eq!(get(&mut glue, "note").unwrap().unwrap().directory_id, None);

        assert!(!rename(&mut glue, "missing", "Renamed", "renaming-task", 2_000).unwrap());
        assert!(!move_to(&mut glue, "missing", None, "moving-task", 2_000).unwrap());
    }

    #[test]
    fn notes_are_found_by_their_directory() {
        let mut glue = memory();
        insert(&mut glue, &note("top", None)).unwrap();
        insert(&mut glue, &note("nested", Some("directory"))).unwrap();

        assert!(any_in_directory(&mut glue, "directory").unwrap());
        assert!(!any_in_directory(&mut glue, "other").unwrap());
    }

    #[test]
    fn delete_removes_only_the_named_note() {
        let mut glue = memory();
        insert(&mut glue, &note("kept", None)).unwrap();
        insert(&mut glue, &note("deleted", None)).unwrap();

        assert!(delete(&mut glue, "deleted").unwrap());
        assert!(!delete(&mut glue, "deleted").unwrap());
        assert_eq!(get(&mut glue, "kept").unwrap(), Some(note("kept", None)));
        assert_eq!(list_summaries(&mut glue).unwrap().len(), 1);
    }
}
