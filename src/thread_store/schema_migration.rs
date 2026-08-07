use chrono::NaiveDateTime;
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::Schema,
        query_builder::{Execute, col, table},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, SelectResultExt},
};

use super::{Result, ThreadStoreError};

pub(super) const TABLE_NAME: &str = "schema_migrations";

const COLUMN_DEFINITIONS: &[&str] = &["version INTEGER PRIMARY KEY", "applied_at TIMESTAMP"];

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct SchemaMigration {
    version: i64,
    applied_at: NaiveDateTime,
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
        .ok_or(ThreadStoreError::IncompleteSchema)?;
    let expected = Schema::from_ddl(&expected_ddl())?;
    if actual.column_defs != expected.column_defs {
        return Err(ThreadStoreError::InvalidSchemaTable(TABLE_NAME.to_string()));
    }
    Ok(())
}

pub(super) fn current_version<S>(glue: &mut Glue<S>) -> Result<i64>
where
    S: GStore + GStoreMut + Planner,
{
    let mut versions = table(TABLE_NAME)
        .select()
        .project(
            SchemaMigration::glue_columns()
                .iter()
                .map(|column| col(*column))
                .collect::<Vec<_>>(),
        )
        .execute(glue)
        .rows_as::<SchemaMigration>()?
        .into_iter()
        .map(|migration| migration.version)
        .collect::<Vec<_>>();
    versions.sort_unstable();

    let history_is_complete = !versions.is_empty()
        && versions
            .iter()
            .enumerate()
            .all(|(index, version)| *version == index as i64 + 1);
    if !history_is_complete {
        return Err(ThreadStoreError::InvalidSchemaMigrationHistory);
    }

    versions
        .last()
        .copied()
        .ok_or(ThreadStoreError::InvalidSchemaMigrationHistory)
}

pub(super) fn record<S>(glue: &mut Glue<S>, version: i64, applied_at: NaiveDateTime) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let migration = SchemaMigration {
        version,
        applied_at,
    };
    table(TABLE_NAME)
        .insert()
        .values_from(std::slice::from_ref(&migration))?
        .execute(glue)?;
    Ok(())
}

fn expected_ddl() -> String {
    format!(
        "CREATE TABLE {TABLE_NAME} ({});",
        COLUMN_DEFINITIONS.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use gluesql::prelude::MemoryStorage;

    use super::*;

    #[test]
    fn owns_schema_creation_validation_and_contiguous_history() {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();
        validate_table(&glue).unwrap();
        assert!(matches!(
            current_version(&mut glue),
            Err(ThreadStoreError::InvalidSchemaMigrationHistory)
        ));

        let applied_at = Utc::now().naive_utc();
        record(&mut glue, 1, applied_at).unwrap();
        assert_eq!(current_version(&mut glue).unwrap(), 1);
        record(&mut glue, 2, applied_at).unwrap();
        assert_eq!(current_version(&mut glue).unwrap(), 2);
    }

    #[test]
    fn rejects_missing_invalid_and_non_contiguous_schema_state() {
        let missing = Glue::new(MemoryStorage::default());
        assert!(matches!(
            validate_table(&missing),
            Err(ThreadStoreError::IncompleteSchema)
        ));

        let mut invalid = Glue::new(MemoryStorage::default());
        table(TABLE_NAME)
            .create_table()
            .add_column("version INTEGER PRIMARY KEY")
            .execute(&mut invalid)
            .unwrap();
        assert!(matches!(
            validate_table(&invalid),
            Err(ThreadStoreError::InvalidSchemaTable(table)) if table == TABLE_NAME
        ));

        let mut gap = Glue::new(MemoryStorage::default());
        create_table(&mut gap).unwrap();
        record(&mut gap, 2, Utc::now().naive_utc()).unwrap();
        assert!(matches!(
            current_version(&mut gap),
            Err(ThreadStoreError::InvalidSchemaMigrationHistory)
        ));
    }
}
