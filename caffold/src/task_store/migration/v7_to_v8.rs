use chrono::Utc;
#[cfg(test)]
use gluesql::{FromGlueRow, ToGlueRow};
use gluesql::{
    core::query_builder::{Execute, table},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct V8ManagedSectionRow {
    section_id: String,
    logical_path: String,
    position: i64,
    last_model: Option<String>,
    last_reasoning_effort: Option<String>,
    last_fast_mode: Option<bool>,
}

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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V8 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 4,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V7 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    table(schema::v7::MANAGED_SECTIONS_TABLE)
        .alter_table()
        .add_column("last_model TEXT NULL")
        .execute(glue)?;
    table(schema::v7::MANAGED_SECTIONS_TABLE)
        .alter_table()
        .add_column("last_reasoning_effort TEXT NULL")
        .execute(glue)?;
    table(schema::v7::MANAGED_SECTIONS_TABLE)
        .alter_table()
        .add_column("last_fast_mode BOOLEAN NULL")
        .execute(glue)?;
    schema_migration::record(glue, 8, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use gluesql::{
        ToGlueRow,
        core::{
            query_builder::{Execute, col, table},
            row_conversion::ToGlueRow as _,
        },
        prelude::{Glue, RedbStorage, SelectResultExt},
    };

    use super::*;

    #[derive(ToGlueRow)]
    struct V7ManagedSectionRow {
        section_id: String,
        logical_path: String,
        position: i64,
    }

    fn write_v7(path: &Path) {
        super::super::tests::write_v7(path);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        table(schema::v7::MANAGED_SECTIONS_TABLE)
            .insert()
            .values_from(&[V7ManagedSectionRow {
                section_id: "section-v7".to_string(),
                logical_path: "Workspace/v7".to_string(),
                position: 2048,
            }])
            .unwrap()
            .execute(&mut glue)
            .unwrap();
    }

    #[test]
    fn adds_empty_section_composer_settings_without_rewriting_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v7.redb");
        write_v7(&path);

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 1,
                unchanged_tables: 4,
                rewritten_rows: 0,
            }
        );

        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        let rows = table(schema::v8::MANAGED_SECTIONS_TABLE)
            .select()
            .project(
                V8ManagedSectionRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V8ManagedSectionRow>()
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].section_id, "section-v7");
        assert_eq!(rows[0].logical_path, "Workspace/v7");
        assert_eq!(rows[0].position, 2048);
        assert_eq!(rows[0].last_model, None);
        assert_eq!(rows[0].last_reasoning_effort, None);
        assert_eq!(rows[0].last_fast_mode, None);
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 8);
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v8.redb");
        write_v7(&path);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V8
        );
    }
}
