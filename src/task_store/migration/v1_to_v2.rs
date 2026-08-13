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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V2 {
        return Err(TaskStoreError::IncompleteSchema);
    }

    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 1,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V1 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    schema::v2::create_managed_worktrees(glue)?;
    schema_migration::record(glue, 2, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use super::*;
    use gluesql::core::query_builder::table;
    use gluesql::prelude::SelectResultExt;

    #[test]
    fn adds_the_worktree_table_without_rewriting_thread_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v1.redb");
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        schema::v1::create(&mut glue, Utc::now().naive_utc()).unwrap();
        let thread = schema::v1::ManagedThreadRow {
            thread_id: "thread-v1".to_string(),
            archived_at: None,
            last_observed_recency_at: None,
            claimed_at: chrono::DateTime::from_timestamp_millis(1_750_000_000_000)
                .unwrap()
                .naive_utc(),
            last_opened_at: None,
            last_seen_activity_at: None,
            last_completed_at: None,
            model: Some("gpt-test".to_string()),
            reasoning_effort: Some("high".to_string()),
        };
        table(schema::v1::MANAGED_THREADS_TABLE)
            .insert()
            .values_from(std::slice::from_ref(&thread))
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
        assert_eq!(
            table(schema::v1::MANAGED_THREADS_TABLE)
                .select()
                .execute(&mut glue)
                .rows_as::<schema::v1::ManagedThreadRow>()
                .unwrap(),
            vec![thread]
        );
        drop(glue);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V2
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 2);
    }

    #[test]
    fn rolls_back_if_the_source_is_not_v1() {
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
