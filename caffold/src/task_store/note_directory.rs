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

pub(super) const TABLE_NAME: &str = "note_directories";

const COLUMN_DEFINITIONS: &[&str] = &[
    "directory_id TEXT PRIMARY KEY",
    "parent_directory_id TEXT NULL",
    "name TEXT",
    "created_at TIMESTAMP",
    "updated_at TIMESTAMP",
];

/// A directory in the Notes tree. A directory without a parent sits at the top
/// of the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NoteDirectory {
    pub directory_id: String,
    pub parent_directory_id: Option<String>,
    pub name: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct NoteDirectoryRow {
    directory_id: String,
    parent_directory_id: Option<String>,
    name: String,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

impl TryFrom<&NoteDirectory> for NoteDirectoryRow {
    type Error = TaskStoreError;

    fn try_from(directory: &NoteDirectory) -> Result<Self> {
        Ok(Self {
            directory_id: directory.directory_id.clone(),
            parent_directory_id: directory.parent_directory_id.clone(),
            name: directory.name.clone(),
            created_at: to_timestamp(directory.created_at_ms, "created_at")?,
            updated_at: to_timestamp(directory.updated_at_ms, "updated_at")?,
        })
    }
}

impl TryFrom<NoteDirectoryRow> for NoteDirectory {
    type Error = TaskStoreError;

    fn try_from(row: NoteDirectoryRow) -> Result<Self> {
        Ok(Self {
            directory_id: row.directory_id,
            parent_directory_id: row.parent_directory_id,
            name: row.name,
            created_at_ms: from_timestamp(row.created_at, "created_at")?,
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

pub(super) fn list<S>(glue: &mut Glue<S>) -> Result<Vec<NoteDirectory>>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .select()
        .project(columns())
        .execute(glue)
        .rows_as::<NoteDirectoryRow>()?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(super) fn get<S>(glue: &mut Glue<S>, directory_id: &str) -> Result<Option<NoteDirectory>>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .select()
        .filter(col("directory_id").eq(text(directory_id.to_owned())))
        .project(columns())
        .limit(1)
        .execute(glue)
        .rows_as::<NoteDirectoryRow>()?
        .into_iter()
        .next()
        .map(TryInto::try_into)
        .transpose()
}

pub(super) fn insert<S>(glue: &mut Glue<S>, directory: &NoteDirectory) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    if directory.directory_id.trim().is_empty() {
        return Err(TaskStoreError::InvalidRow("directory_id"));
    }
    let row = NoteDirectoryRow::try_from(directory)?;
    table(TABLE_NAME)
        .insert()
        .values_from(std::slice::from_ref(&row))?
        .execute(glue)?;
    Ok(())
}

pub(super) fn has_child_directories<S>(glue: &mut Glue<S>, directory_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let children = table(TABLE_NAME)
        .select()
        .filter(col("parent_directory_id").eq(text(directory_id.to_owned())))
        .project(columns())
        .limit(1)
        .execute(glue)
        .rows_as::<NoteDirectoryRow>()?;
    Ok(!children.is_empty())
}

pub(super) fn rename<S>(
    glue: &mut Glue<S>,
    directory_id: &str,
    name: &str,
    now_ms: u64,
) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("directory_id").eq(text(directory_id.to_owned())))
        .set("name", text(name.to_owned()))
        .set("updated_at", timestamp_value(now_ms, "updated_at")?)
        .execute(glue)?;
    updated_one(payload)
}

pub(super) fn move_to<S>(
    glue: &mut Glue<S>,
    directory_id: &str,
    parent_directory_id: Option<&str>,
    now_ms: u64,
) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let parent = parent_directory_id
        .map(|parent| text(parent.to_owned()))
        .unwrap_or_else(null);
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("directory_id").eq(text(directory_id.to_owned())))
        .set("parent_directory_id", parent)
        .set("updated_at", timestamp_value(now_ms, "updated_at")?)
        .execute(glue)?;
    updated_one(payload)
}

pub(super) fn delete<S>(glue: &mut Glue<S>, directory_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    match table(TABLE_NAME)
        .delete()
        .filter(col("directory_id").eq(text(directory_id.to_owned())))
        .execute(glue)?
    {
        Payload::Delete(0) => Ok(false),
        Payload::Delete(1) => Ok(true),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn columns() -> Vec<ExprNode<'static>> {
    NoteDirectoryRow::glue_columns()
        .iter()
        .map(|column| col(*column))
        .collect()
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

    fn directory(directory_id: &str, parent_directory_id: Option<&str>) -> NoteDirectory {
        NoteDirectory {
            directory_id: directory_id.to_string(),
            parent_directory_id: parent_directory_id.map(str::to_string),
            name: format!("Directory {directory_id}"),
            created_at_ms: 1_000,
            updated_at_ms: 1_000,
        }
    }

    #[test]
    fn inserted_directories_read_back_from_get_and_list() {
        let mut glue = memory();
        let top = directory("top", None);
        let child = directory("child", Some("top"));
        insert(&mut glue, &top).unwrap();
        insert(&mut glue, &child).unwrap();

        assert_eq!(get(&mut glue, "child").unwrap(), Some(child.clone()));
        assert_eq!(get(&mut glue, "missing").unwrap(), None);
        let mut listed = list(&mut glue).unwrap();
        listed.sort_by(|left, right| left.directory_id.cmp(&right.directory_id));
        assert_eq!(listed, [child, top]);
    }

    #[test]
    fn a_directory_without_an_id_is_not_stored() {
        let mut glue = memory();

        assert!(matches!(
            insert(&mut glue, &directory(" ", None)),
            Err(TaskStoreError::InvalidRow("directory_id"))
        ));
        assert!(list(&mut glue).unwrap().is_empty());
    }

    #[test]
    fn rename_and_move_report_whether_the_directory_existed() {
        let mut glue = memory();
        insert(&mut glue, &directory("parent", None)).unwrap();
        insert(&mut glue, &directory("moved", None)).unwrap();

        assert!(rename(&mut glue, "moved", "Renamed", 2_000).unwrap());
        assert!(move_to(&mut glue, "moved", Some("parent"), 3_000).unwrap());
        let moved = get(&mut glue, "moved").unwrap().unwrap();
        assert_eq!(moved.name, "Renamed");
        assert_eq!(moved.parent_directory_id.as_deref(), Some("parent"));
        assert_eq!(moved.created_at_ms, 1_000);
        assert_eq!(moved.updated_at_ms, 3_000);

        assert!(move_to(&mut glue, "moved", None, 4_000).unwrap());
        assert_eq!(
            get(&mut glue, "moved")
                .unwrap()
                .unwrap()
                .parent_directory_id,
            None
        );

        assert!(!rename(&mut glue, "missing", "Renamed", 2_000).unwrap());
        assert!(!move_to(&mut glue, "missing", None, 2_000).unwrap());
    }

    #[test]
    fn child_directories_are_found_by_their_parent() {
        let mut glue = memory();
        insert(&mut glue, &directory("parent", None)).unwrap();
        insert(&mut glue, &directory("empty", None)).unwrap();
        insert(&mut glue, &directory("child", Some("parent"))).unwrap();

        assert!(has_child_directories(&mut glue, "parent").unwrap());
        assert!(!has_child_directories(&mut glue, "empty").unwrap());
        assert!(!has_child_directories(&mut glue, "child").unwrap());
    }

    #[test]
    fn delete_removes_only_the_named_directory() {
        let mut glue = memory();
        insert(&mut glue, &directory("kept", None)).unwrap();
        insert(&mut glue, &directory("deleted", None)).unwrap();

        assert!(delete(&mut glue, "deleted").unwrap());
        assert!(!delete(&mut glue, "deleted").unwrap());
        assert_eq!(list(&mut glue).unwrap(), [directory("kept", None)]);
    }
}
