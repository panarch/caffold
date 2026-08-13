use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, begin, commit, rollback},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

pub(super) fn migrate(path: &Path) -> Result<MigrationReport> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    begin().execute(&mut glue)?;

    let result = migrate_transaction(&mut glue);
    match result {
        Ok(()) => {
            commit().execute(&mut glue)?;
        }
        Err(error) => {
            let _ = rollback().execute(&mut glue);
            return Err(error);
        }
    }
    drop(glue);

    if detect_redb_schema(path)? != DetectedSchemaVersion::V4 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 2,
        unchanged_tables: 2,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V3 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    schema::v4::create_push_tables(glue)?;
    schema_migration::record(glue, 4, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDateTime;
    use gluesql::{core::query_builder::table, prelude::SelectResultExt};

    use super::*;

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
    }

    #[test]
    fn adds_push_state_tables_without_rewriting_existing_application_tables() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v3.redb");
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        schema::v1::create(&mut glue, timestamp(1)).unwrap();
        schema::v2::create_managed_worktrees(&mut glue).unwrap();
        schema_migration::record(&mut glue, 2, timestamp(2)).unwrap();
        drop(glue);
        super::super::v2_to_v3::migrate(&path).unwrap();

        let thread = schema::v3::ManagedThreadRow {
            thread_id: "thread-v3".to_string(),
            archived_at: None,
            last_observed_recency_at: Some(timestamp(1_750_000_001_000)),
            claimed_at: timestamp(1_750_000_000_000),
            last_opened_at: Some(timestamp(1_750_000_002_000)),
            last_seen_activity_at: Some(timestamp(1_750_000_003_000)),
            last_completed_at: Some(timestamp(1_750_000_004_000)),
            model: Some("gpt-test".to_string()),
            reasoning_effort: Some("high".to_string()),
            fast_mode: true,
        };
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        table(schema::v3::MANAGED_THREADS_TABLE)
            .insert()
            .values_from(std::slice::from_ref(&thread))
            .unwrap()
            .execute(&mut glue)
            .unwrap();
        drop(glue);

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 2,
                rewritten_rows: 0,
            }
        );

        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(
            table(schema::v3::MANAGED_THREADS_TABLE)
                .select()
                .project(schema::v3::managed_thread_columns())
                .execute(&mut glue)
                .rows_as::<schema::v3::ManagedThreadRow>()
                .unwrap(),
            vec![thread]
        );
        drop(glue);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V4
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 4);
    }

    #[test]
    fn rolls_back_if_the_source_is_not_v3() {
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
