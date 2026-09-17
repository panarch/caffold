use chrono::Utc;
use gluesql::{
    core::query_builder::Execute,
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

/// Add the Notes tree: its directories and its Notes, both empty. No existing
/// row changes.
pub(super) fn migrate(path: &Path) -> Result<MigrationReport> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    gluesql::core::query_builder::begin().execute(&mut glue)?;

    let result = migrate_transaction(&mut glue);
    match result {
        Ok(()) => {
            gluesql::core::query_builder::commit().execute(&mut glue)?;
        }
        Err(error) => {
            let _ = gluesql::core::query_builder::rollback().execute(&mut glue);
            return Err(error);
        }
    }
    drop(glue);

    if detect_redb_schema(path)? != DetectedSchemaVersion::V11 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 2,
        unchanged_tables: 5,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V10 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    schema::create_table(
        glue,
        schema::v11::NOTE_DIRECTORIES_TABLE,
        schema::v11::NOTE_DIRECTORY_COLUMN_DEFINITIONS,
    )?;
    schema::create_table(
        glue,
        schema::v11::NOTES_TABLE,
        schema::v11::NOTE_COLUMN_DEFINITIONS,
    )?;
    schema_migration::record(glue, 11, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDateTime;
    use gluesql::{
        FromGlueRow, ToGlueRow,
        core::{
            executor::Payload,
            query_builder::{Execute, col, table},
            row_conversion::ToGlueRow as _,
        },
        prelude::{Glue, RedbStorage, SelectResultExt},
    };

    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V10PushVapidKeyRow {
        key_id: String,
        private_key: String,
        created_at: NaiveDateTime,
    }

    fn row_count(glue: &mut Glue<RedbStorage>, table_name: &str) -> usize {
        match table(table_name).select().execute(glue).unwrap() {
            Payload::Select { rows, .. } => rows.len(),
            payload => panic!("a select answered with {payload:?}"),
        }
    }

    fn write_v10(path: &Path) {
        super::super::tests::write_v10(path);
    }

    #[test]
    fn existing_rows_are_kept_and_the_notes_tree_starts_empty() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v10.redb");
        write_v10(&path);
        let key = V10PushVapidKeyRow {
            key_id: "server".to_string(),
            private_key: "private-key".to_string(),
            created_at: chrono::DateTime::from_timestamp_millis(1_000)
                .unwrap()
                .naive_utc(),
        };
        {
            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            table(schema::v10::PUSH_VAPID_KEYS_TABLE)
                .insert()
                .values_from(std::slice::from_ref(&key))
                .unwrap()
                .execute(&mut glue)
                .unwrap();
        }

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 5,
                rewritten_rows: 0,
            }
        );

        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        let keys = table(schema::v11::PUSH_VAPID_KEYS_TABLE)
            .select()
            .project(
                V10PushVapidKeyRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V10PushVapidKeyRow>()
            .unwrap();
        assert_eq!(keys, [key]);
        assert_eq!(row_count(&mut glue, schema::v11::NOTE_DIRECTORIES_TABLE), 0);
        assert_eq!(row_count(&mut glue, schema::v11::NOTES_TABLE), 0);
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 11);
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v11.redb");
        write_v10(&path);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V11
        );
    }
}
