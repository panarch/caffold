use chrono::Utc;
#[cfg(test)]
use gluesql::{FromGlueRow, ToGlueRow};
use gluesql::{
    core::{
        data::Schema,
        query_builder::{Execute, table},
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema};
use crate::task_store::{Result, TaskStoreError, managed_thread, schema_migration};

pub(super) const MANAGED_THREAD_V2_COLUMN_DEFINITIONS: &[&str] = &[
    "thread_id TEXT PRIMARY KEY",
    "archived_at TIMESTAMP NULL",
    "last_observed_recency_at TIMESTAMP NULL",
    "claimed_at TIMESTAMP",
    "last_opened_at TIMESTAMP NULL",
    "last_seen_activity_at TIMESTAMP NULL",
    "last_completed_at TIMESTAMP NULL",
    "model TEXT NULL",
    "reasoning_effort TEXT NULL",
];

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
pub(super) struct ManagedThreadV2Row {
    pub thread_id: String,
    pub archived_at: Option<chrono::NaiveDateTime>,
    pub last_observed_recency_at: Option<chrono::NaiveDateTime>,
    pub claimed_at: chrono::NaiveDateTime,
    pub last_opened_at: Option<chrono::NaiveDateTime>,
    pub last_seen_activity_at: Option<chrono::NaiveDateTime>,
    pub last_completed_at: Option<chrono::NaiveDateTime>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
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
    table(managed_thread::TABLE_NAME)
        .alter_table()
        .add_column("fast_mode BOOLEAN NOT NULL DEFAULT FALSE")
        .execute(glue)?;
    schema_migration::record(glue, 3, Utc::now().naive_utc())
}

#[cfg(test)]
pub(super) fn create_managed_thread_v2_table<S>(glue: &mut Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let mut query = table(managed_thread::TABLE_NAME).create_table();
    for definition in MANAGED_THREAD_V2_COLUMN_DEFINITIONS {
        query = query.add_column(*definition);
    }
    query.execute(glue)?;
    Ok(())
}

pub(super) fn validate_managed_thread_v2_table<S>(glue: &Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let actual = glue
        .storage
        .fetch_schema(managed_thread::TABLE_NAME)?
        .ok_or(TaskStoreError::IncompleteSchema)?;
    let expected = Schema::from_ddl(&format!(
        "CREATE TABLE {} ({});",
        managed_thread::TABLE_NAME,
        MANAGED_THREAD_V2_COLUMN_DEFINITIONS.join(", ")
    ))?;
    if actual.column_defs != expected.column_defs {
        return Err(TaskStoreError::InvalidSchemaTable(
            managed_thread::TABLE_NAME.to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::task_store::managed_worktree;
    use chrono::NaiveDateTime;
    use gluesql::core::query_builder::table;

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
        create_managed_thread_v2_table(&mut glue).unwrap();
        managed_worktree::create_table(&mut glue).unwrap();
        schema_migration::create_table(&mut glue).unwrap();
        schema_migration::record(&mut glue, 1, timestamp(1)).unwrap();
        schema_migration::record(&mut glue, 2, timestamp(2)).unwrap();
        let row = ManagedThreadV2Row {
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
        table(managed_thread::TABLE_NAME)
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
        let thread = managed_thread::get(&mut glue, "thread-v2")
            .unwrap()
            .unwrap();
        assert_eq!(thread.model.as_deref(), Some("gpt-test"));
        assert_eq!(thread.reasoning_effort.as_deref(), Some("high"));
        assert!(!thread.fast_mode);
        managed_thread::validate_table(&glue).unwrap();
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
