use chrono::{DateTime, NaiveDateTime, Utc};
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::Schema,
        query_builder::{Execute, col, table, text},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, SelectResultExt},
};

use super::{Result, TaskStoreError};

pub(super) const TABLE_NAME: &str = "push_vapid_keys";
const SINGLETON_KEY_ID: &str = "server";
const COLUMN_DEFINITIONS: &[&str] = &[
    "key_id TEXT PRIMARY KEY",
    "private_key TEXT",
    "created_at TIMESTAMP",
];

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct PushVapidKeyRow {
    key_id: String,
    private_key: String,
    created_at: NaiveDateTime,
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

pub(super) fn validate_table<S>(glue: &Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let actual = glue
        .storage
        .fetch_schema(TABLE_NAME)?
        .ok_or(TaskStoreError::IncompleteSchema)?;
    let expected = Schema::from_ddl(&format!(
        "CREATE TABLE {TABLE_NAME} ({});",
        COLUMN_DEFINITIONS.join(", ")
    ))?;
    if actual.column_defs != expected.column_defs {
        return Err(TaskStoreError::InvalidSchemaTable(TABLE_NAME.to_string()));
    }
    Ok(())
}

pub(super) fn load_or_create<S>(
    glue: &mut Glue<S>,
    generated_private_key: &str,
    now_ms: u64,
) -> Result<String>
where
    S: GStore + GStoreMut + Planner,
{
    if let Some(existing) = get(glue)? {
        return Ok(existing.private_key);
    }
    let now = i64::try_from(now_ms).map_err(|_| TaskStoreError::InvalidRow("created_at"))?;
    let row = PushVapidKeyRow {
        key_id: SINGLETON_KEY_ID.to_owned(),
        private_key: generated_private_key.to_owned(),
        created_at: DateTime::<Utc>::from_timestamp_millis(now)
            .ok_or(TaskStoreError::InvalidRow("created_at"))?
            .naive_utc(),
    };
    table(TABLE_NAME)
        .insert()
        .values_from(std::slice::from_ref(&row))?
        .execute(glue)?;
    Ok(row.private_key)
}

fn get<S>(glue: &mut Glue<S>) -> Result<Option<PushVapidKeyRow>>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .select()
        .filter(col("key_id").eq(text(SINGLETON_KEY_ID)))
        .project(
            PushVapidKeyRow::glue_columns()
                .iter()
                .map(|column| col(*column))
                .collect::<Vec<_>>(),
        )
        .limit(1)
        .execute(glue)
        .rows_as::<PushVapidKeyRow>()?
        .into_iter()
        .next()
        .map_or(Ok(None), |row| {
            (row.key_id == SINGLETON_KEY_ID)
                .then_some(Some(row))
                .ok_or(TaskStoreError::InvalidRow("key_id"))
        })
}

#[cfg(test)]
mod tests {
    use gluesql::prelude::MemoryStorage;

    use super::*;

    #[test]
    fn generated_key_is_stable_after_the_first_insert() {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();

        assert_eq!(
            load_or_create(&mut glue, "first-private-key", 1_000).unwrap(),
            "first-private-key"
        );
        assert_eq!(
            load_or_create(&mut glue, "ignored-new-key", 2_000).unwrap(),
            "first-private-key"
        );
    }
}
