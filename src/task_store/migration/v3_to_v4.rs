use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, begin, commit, rollback},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema};
use crate::task_store::{
    Result, TaskStoreError, push_installation, push_vapid_key, schema_migration,
};

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
    push_installation::create_table(glue)?;
    push_vapid_key::create_table(glue)?;
    schema_migration::record(glue, 4, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use crate::task_store::{managed_thread, managed_worktree};

    use super::*;

    #[test]
    fn adds_push_state_tables_without_rewriting_existing_application_tables() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v3.redb");
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        managed_thread::create_table(&mut glue).unwrap();
        managed_worktree::create_table(&mut glue).unwrap();
        schema_migration::create_table(&mut glue).unwrap();
        for version in 1..=3 {
            schema_migration::record(&mut glue, version, Utc::now().naive_utc()).unwrap();
        }
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
        push_installation::validate_table(&glue).unwrap();
        push_vapid_key::validate_table(&glue).unwrap();
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 4);
    }
}
