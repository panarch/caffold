use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, table},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

/// Give a Task a place among the pinned Tasks. Existing Tasks start unpinned,
/// in the Section place they already have.
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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V13 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 6,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V12 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    table(schema::v12::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("pin_position INTEGER NULL")
        .execute(glue)?;
    schema_migration::record(glue, 13, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDateTime;
    use gluesql::{
        FromGlueRow, ToGlueRow,
        core::{
            query_builder::{Execute, col, table},
            row_conversion::ToGlueRow as _,
        },
        prelude::{Glue, RedbStorage, SelectResultExt},
    };

    use super::*;

    /// Every column a v12 Task has, so the fixture writes a whole row.
    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V12ManagedThreadRow {
        thread_id: String,
        archived_at: Option<NaiveDateTime>,
        last_observed_recency_at: Option<NaiveDateTime>,
        claimed_at: NaiveDateTime,
        last_opened_at: Option<NaiveDateTime>,
        last_seen_activity_at: Option<NaiveDateTime>,
        last_completed_at: Option<NaiveDateTime>,
        model: Option<String>,
        reasoning_effort: Option<String>,
        fast_mode: bool,
        display_name: String,
        section_id: Option<String>,
        position_in_section: Option<i64>,
        provider: String,
        cwd: Option<String>,
        permission_mode: Option<String>,
        permission_instructions: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V13ManagedThreadRow {
        thread_id: String,
        display_name: String,
        section_id: Option<String>,
        position_in_section: Option<i64>,
        permission_instructions: Option<String>,
        pin_position: Option<i64>,
    }

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
    }

    fn write_v12_with_a_task(path: &Path) {
        super::super::tests::write_v12(path);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        let row = V12ManagedThreadRow {
            thread_id: "thread-1".to_string(),
            archived_at: None,
            last_observed_recency_at: Some(timestamp(1_750_000_001_000)),
            claimed_at: timestamp(1_750_000_000_000),
            last_opened_at: Some(timestamp(1_750_000_002_000)),
            last_seen_activity_at: Some(timestamp(1_750_000_003_000)),
            last_completed_at: None,
            model: Some("gpt-5.5".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: false,
            display_name: "A Task that already existed".to_string(),
            section_id: Some("section".to_string()),
            position_in_section: Some(-1024),
            provider: "codex".to_string(),
            cwd: None,
            permission_mode: Some("default".to_string()),
            permission_instructions: Some("never touch production".to_string()),
        };
        table(schema::v12::MANAGED_THREADS_TABLE)
            .insert()
            .values_from(std::slice::from_ref(&row))
            .unwrap()
            .execute(&mut glue)
            .unwrap();
    }

    fn read_threads(path: &Path) -> Vec<V13ManagedThreadRow> {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        table(schema::v13::MANAGED_THREADS_TABLE)
            .select()
            .project(
                V13ManagedThreadRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V13ManagedThreadRow>()
            .unwrap()
    }

    #[test]
    fn an_existing_task_keeps_its_section_place_and_starts_unpinned() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v12.redb");
        write_v12_with_a_task(&path);

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 1,
                unchanged_tables: 6,
                rewritten_rows: 0,
            }
        );

        assert_eq!(
            read_threads(&path),
            vec![V13ManagedThreadRow {
                thread_id: "thread-1".to_string(),
                display_name: "A Task that already existed".to_string(),
                section_id: Some("section".to_string()),
                position_in_section: Some(-1024),
                permission_instructions: Some("never touch production".to_string()),
                pin_position: None,
            }]
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 13);
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v13.redb");
        write_v12_with_a_task(&path);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V13
        );
    }
}
