use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, table},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

/// Keep what a person's own prompts granted this Task, so a permission
/// reviewer reads the same latitude the person gave in conversation. Existing
/// Tasks start with none, which is what they were decided under.
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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V12 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 6,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V11 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    table(schema::v11::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("permission_instructions TEXT NULL")
        .execute(glue)?;
    schema_migration::record(glue, 12, Utc::now().naive_utc())
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

    /// Every column a v11 Task has, so the fixture writes a whole row.
    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V11ManagedThreadRow {
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
    }

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V12ManagedThreadRow {
        thread_id: String,
        display_name: String,
        model: Option<String>,
        permission_mode: Option<String>,
        permission_instructions: Option<String>,
    }

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
    }

    fn write_v11_with_a_task(path: &Path) {
        super::super::tests::write_v11(path);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        let row = V11ManagedThreadRow {
            thread_id: "thread-1".to_string(),
            archived_at: None,
            last_observed_recency_at: Some(timestamp(1_750_000_001_000)),
            claimed_at: timestamp(1_750_000_000_000),
            last_opened_at: Some(timestamp(1_750_000_002_000)),
            last_seen_activity_at: Some(timestamp(1_750_000_003_000)),
            last_completed_at: None,
            model: Some("claude-opus-5".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: false,
            display_name: "A Task that already existed".to_string(),
            section_id: None,
            position_in_section: None,
            provider: "claude".to_string(),
            cwd: Some("/repository".to_string()),
            permission_mode: Some("default".to_string()),
        };
        table(schema::v11::MANAGED_THREADS_TABLE)
            .insert()
            .values_from(std::slice::from_ref(&row))
            .unwrap()
            .execute(&mut glue)
            .unwrap();
    }

    fn read_threads(path: &Path) -> Vec<V12ManagedThreadRow> {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        table(schema::v12::MANAGED_THREADS_TABLE)
            .select()
            .project(
                V12ManagedThreadRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V12ManagedThreadRow>()
            .unwrap()
    }

    #[test]
    fn an_existing_task_keeps_its_settings_and_carries_no_permission_instructions() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v11.redb");
        write_v11_with_a_task(&path);

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
            vec![V12ManagedThreadRow {
                thread_id: "thread-1".to_string(),
                display_name: "A Task that already existed".to_string(),
                model: Some("claude-opus-5".to_string()),
                permission_mode: Some("default".to_string()),
                permission_instructions: None,
            }]
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 12);
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v12.redb");
        write_v11_with_a_task(&path);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V12
        );
    }
}
