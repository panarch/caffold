use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, begin, commit, rollback},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema};
use crate::task_store::{Result, TaskStoreError, managed_worktree, schema_migration};

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
    managed_worktree::create_table(glue)?;
    schema_migration::record(glue, 2, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::{managed_thread, migration::v2_to_v3};
    use gluesql::core::query_builder::table;
    use gluesql::prelude::SelectResultExt;

    #[test]
    fn adds_the_worktree_table_without_rewriting_thread_rows() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v1.redb");
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        v2_to_v3::create_managed_thread_v2_table(&mut glue).unwrap();
        schema_migration::create_table(&mut glue).unwrap();
        schema_migration::record(&mut glue, 1, Utc::now().naive_utc()).unwrap();
        let thread = v2_to_v3::ManagedThreadV2Row {
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
        table(managed_thread::TABLE_NAME)
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
            table(managed_thread::TABLE_NAME)
                .select()
                .execute(&mut glue)
                .rows_as::<v2_to_v3::ManagedThreadV2Row>()
                .unwrap(),
            vec![thread]
        );
        managed_worktree::validate_table(&glue).unwrap();
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
