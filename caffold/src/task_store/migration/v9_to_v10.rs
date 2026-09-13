use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, table},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

/// Keep the approval mode a started turn ran under, the way model and effort
/// are already kept. Grok does not say autoMode again after session/new, so
/// the Task record is what the follow-up composer can show after a restart.
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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V10 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 2,
        unchanged_tables: 3,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V9 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    table(schema::v9::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("permission_mode TEXT NULL")
        .execute(glue)?;
    table(schema::v9::MANAGED_SECTIONS_TABLE)
        .alter_table()
        .add_column("last_permission_mode TEXT NULL")
        .execute(glue)?;
    schema_migration::record(glue, 10, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use gluesql::{
        FromGlueRow, ToGlueRow,
        core::{
            query_builder::{Execute, col, table},
            row_conversion::ToGlueRow as _,
        },
        prelude::{Glue, RedbStorage, SelectResultExt},
    };

    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V10ManagedThreadRow {
        thread_id: String,
        permission_mode: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V10ManagedSectionRow {
        section_id: String,
        last_permission_mode: Option<String>,
    }

    fn write_v9(path: &Path) {
        super::super::tests::write_v9(path);
    }

    #[test]
    fn existing_tasks_and_sections_have_no_recorded_permission_mode() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v9.redb");
        write_v9(&path);

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 3,
                rewritten_rows: 0,
            }
        );

        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        let threads = table(schema::v10::MANAGED_THREADS_TABLE)
            .select()
            .project(
                V10ManagedThreadRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V10ManagedThreadRow>()
            .unwrap();
        assert!(
            threads
                .iter()
                .all(|thread| thread.permission_mode.is_none())
        );
        let sections = table(schema::v10::MANAGED_SECTIONS_TABLE)
            .select()
            .project(
                V10ManagedSectionRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V10ManagedSectionRow>()
            .unwrap();
        assert!(
            sections
                .iter()
                .all(|section| section.last_permission_mode.is_none())
        );
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 10);
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v10.redb");
        write_v9(&path);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V10
        );
    }
}
