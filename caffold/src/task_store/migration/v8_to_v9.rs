use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, table},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

/// Say which agent a Task belongs to, and where Caffold runs it.
///
/// A Task was a Codex thread and its identifier was Codex's, so neither
/// question had to be asked. A second agent makes both real: which driver to ask
/// about a Task has to be answerable before the agent is woken, and an agent
/// Caffold starts per Task has to be started somewhere.
///
/// Existing rows are Codex's, and their working directory stays empty. It is not
/// unknown so much as not Caffold's: the Codex daemon holds a thread's cwd and
/// answers for it, and copying that answer into this table would make a second
/// one that goes stale the moment a Task is isolated into a worktree.
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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V9 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 4,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V8 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    table(schema::v8::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("provider TEXT NOT NULL DEFAULT 'codex'")
        .execute(glue)?;
    table(schema::v8::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("cwd TEXT NULL")
        .execute(glue)?;
    schema_migration::record(glue, 9, Utc::now().naive_utc())
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

    #[derive(ToGlueRow)]
    struct V8ManagedThreadRow {
        thread_id: String,
        display_name: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V9ManagedThreadRow {
        thread_id: String,
        display_name: String,
        provider: String,
        cwd: Option<String>,
    }

    fn write_v8(path: &Path) {
        super::super::tests::write_v8(path);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        table(schema::v8::MANAGED_THREADS_TABLE)
            .insert()
            .values_from(&[V8ManagedThreadRow {
                thread_id: "thread-v8".to_string(),
                display_name: "Kept from v8".to_string(),
            }])
            .unwrap()
            .execute(&mut glue)
            .unwrap();
    }

    fn threads(path: &Path) -> Vec<V9ManagedThreadRow> {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        table(schema::v9::MANAGED_THREADS_TABLE)
            .select()
            .project(
                V9ManagedThreadRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V9ManagedThreadRow>()
            .unwrap()
    }

    #[test]
    fn every_task_that_existed_belongs_to_codex_and_names_no_directory() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v8.redb");
        write_v8(&path);

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 1,
                unchanged_tables: 4,
                rewritten_rows: 0,
            }
        );

        let rows = threads(&path);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].thread_id, "thread-v8");
        assert_eq!(rows[0].display_name, "Kept from v8");
        assert_eq!(rows[0].provider, "codex");
        assert_eq!(rows[0].cwd, None);

        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 9);
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v9.redb");
        write_v8(&path);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V9
        );
    }
}
