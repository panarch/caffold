use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, table},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V3 {
        return Err(TaskStoreError::IncompleteSchema);
    }

    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 1,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V2 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    table(schema::v2::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("fast_mode BOOLEAN NOT NULL DEFAULT FALSE")
        .execute(glue)?;
    schema_migration::record(glue, 3, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDateTime;
    use gluesql::core::query_builder::table;
    use gluesql::prelude::SelectResultExt;

    use super::*;

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
    }

    #[test]
    fn adds_normal_fast_mode_without_rewriting_thread_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v2.redb");
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        schema::v1::create(&mut glue, timestamp(1)).unwrap();
        schema::v2::create_managed_worktrees(&mut glue).unwrap();
        schema_migration::record(&mut glue, 2, timestamp(2)).unwrap();
        let row = schema::v2::ManagedThreadRow {
            thread_id: "thread-v2".to_string(),
            archived_at: None,
            last_observed_recency_at: None,
            claimed_at: timestamp(1_750_000_000_000),
            last_opened_at: None,
            last_seen_activity_at: None,
            last_completed_at: None,
            model: Some("gpt-test".to_string()),
            reasoning_effort: Some("high".to_string()),
        };
        table(schema::v2::MANAGED_THREADS_TABLE)
            .insert()
            .values_from(std::slice::from_ref(&row))
            .unwrap()
            .execute(&mut glue)
            .unwrap();
        drop(glue);

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 1,
                unchanged_tables: 1,
                rewritten_rows: 0,
            }
        );

        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        let thread = table(schema::v3::MANAGED_THREADS_TABLE)
            .select()
            .project(schema::v3::managed_thread_columns())
            .execute(&mut glue)
            .rows_as::<schema::v3::ManagedThreadRow>()
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(thread.model.as_deref(), Some("gpt-test"));
        assert_eq!(thread.reasoning_effort.as_deref(), Some("high"));
        assert!(!thread.fast_mode);
        drop(glue);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V3
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 3);
    }

    #[test]
    fn rolls_back_if_the_source_is_not_v2() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fresh.redb");
        drop(RedbStorage::new(&path).unwrap());

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::Fresh
        );
    }
}
