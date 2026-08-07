mod v0_to_v1;

use chrono::{NaiveDateTime, Utc};
use gluesql::{
    core::{
        query_builder::{Execute, begin, commit, rollback},
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, RedbStorage},
};
use std::{collections::BTreeSet, path::Path};

use super::{Result, ThreadStoreError, managed_thread, schema_migration};

const LATEST_SCHEMA_VERSION: i64 = 1;
const APPLICATION_TABLE_COUNT: usize = 1;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct MigrationReport {
    pub migrated_tables: usize,
    pub unchanged_tables: usize,
    pub rewritten_rows: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetectedSchemaVersion {
    Fresh,
    V0,
    V1,
    UnsupportedNewer(i64),
}

/// Migrates an existing Caffold database to the latest application schema.
///
/// Opening and migrating are separate operations, newer schemas are rejected,
/// and the report makes idempotency observable in tests.
pub(super) fn migrate_to_latest(path: &Path) -> Result<MigrationReport> {
    if !path.exists() {
        return Err(ThreadStoreError::MigrationPathMissing(
            path.display().to_string(),
        ));
    }
    if !path.is_file() {
        return Err(ThreadStoreError::MigrationPathNotFile(
            path.display().to_string(),
        ));
    }

    match detect_redb_schema(path)? {
        DetectedSchemaVersion::Fresh => Ok(MigrationReport::default()),
        DetectedSchemaVersion::V0 => v0_to_v1::migrate(path),
        DetectedSchemaVersion::V1 => Ok(MigrationReport {
            migrated_tables: 0,
            unchanged_tables: APPLICATION_TABLE_COUNT,
            rewritten_rows: 0,
        }),
        DetectedSchemaVersion::UnsupportedNewer(version) => {
            Err(ThreadStoreError::UnsupportedNewerSchemaVersion {
                found: version,
                supported: LATEST_SCHEMA_VERSION,
            })
        }
    }
}

pub(super) fn initialize_memory<S>(glue: &mut Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    create_latest_schema(glue, Utc::now().naive_utc())
}

pub(super) fn initialize_redb(glue: &mut Glue<RedbStorage>) -> Result<()> {
    begin().execute(glue)?;
    let result = match detect_schema(glue) {
        Ok(DetectedSchemaVersion::Fresh) => create_latest_schema(glue, Utc::now().naive_utc()),
        Ok(DetectedSchemaVersion::V1) => Ok(()),
        Ok(DetectedSchemaVersion::V0) => Err(ThreadStoreError::MigrationRequired(0)),
        Ok(DetectedSchemaVersion::UnsupportedNewer(version)) => {
            Err(ThreadStoreError::UnsupportedNewerSchemaVersion {
                found: version,
                supported: LATEST_SCHEMA_VERSION,
            })
        }
        Err(error) => Err(error),
    };

    match result {
        Ok(()) => {
            commit().execute(glue)?;
            Ok(())
        }
        Err(error) => {
            let _ = rollback().execute(glue);
            Err(error)
        }
    }
}

pub(super) fn create_latest_schema<S>(glue: &mut Glue<S>, applied_at: NaiveDateTime) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    managed_thread::create_table(glue)?;
    schema_migration::create_table(glue)?;
    schema_migration::record(glue, LATEST_SCHEMA_VERSION, applied_at)
}

fn detect_redb_schema(path: &Path) -> Result<DetectedSchemaVersion> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    begin().execute(&mut glue)?;
    let detected = detect_schema(&mut glue);
    let rollback_result = rollback().execute(&mut glue);
    match (detected, rollback_result) {
        (Ok(version), Ok(_)) => Ok(version),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

fn detect_schema<S>(glue: &mut Glue<S>) -> Result<DetectedSchemaVersion>
where
    S: GStore + GStoreMut + Planner,
{
    let table_names = glue
        .storage
        .fetch_all_schemas()?
        .into_iter()
        .map(|schema| schema.table_name)
        .collect::<BTreeSet<_>>();
    let known_names = BTreeSet::from([
        managed_thread::TABLE_NAME.to_string(),
        v0_to_v1::LEGACY_ARCHIVED_THREADS_TABLE.to_string(),
        schema_migration::TABLE_NAME.to_string(),
    ]);
    if let Some(unexpected) = table_names.difference(&known_names).next() {
        return Err(ThreadStoreError::UnexpectedSchemaTable(unexpected.clone()));
    }

    let has_managed = table_names.contains(managed_thread::TABLE_NAME);
    let has_legacy_archived = table_names.contains(v0_to_v1::LEGACY_ARCHIVED_THREADS_TABLE);
    let has_migrations = table_names.contains(schema_migration::TABLE_NAME);

    if !has_migrations {
        return match (has_managed, has_legacy_archived) {
            (false, false) => Ok(DetectedSchemaVersion::Fresh),
            (true, _) => Ok(DetectedSchemaVersion::V0),
            (false, true) => Err(ThreadStoreError::IncompleteSchema),
        };
    }

    if !has_managed || has_legacy_archived || table_names.len() != 2 {
        return Err(ThreadStoreError::IncompleteSchema);
    }
    schema_migration::validate_table(glue)?;
    let version = schema_migration::current_version(glue)?;
    match version {
        LATEST_SCHEMA_VERSION => {
            managed_thread::validate_table(glue)?;
            Ok(DetectedSchemaVersion::V1)
        }
        version => Ok(DetectedSchemaVersion::UnsupportedNewer(version)),
    }
}

#[cfg(test)]
mod tests {
    use gluesql::{
        core::query_builder::{Execute, table},
        prelude::MemoryStorage,
    };

    use super::*;

    fn write_v0_managed_table(path: &Path) {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        table(managed_thread::TABLE_NAME)
            .create_table()
            .add_column("thread_id TEXT PRIMARY KEY")
            .add_column("last_observed_recency_ms INTEGER NULL")
            .add_column("claimed_at_ms INTEGER")
            .add_column("last_opened_at_ms INTEGER NULL")
            .add_column("last_seen_activity_ms INTEGER NULL")
            .add_column("model TEXT NULL")
            .add_column("reasoning_effort TEXT NULL")
            .execute(&mut glue)
            .unwrap();
    }

    fn write_current_schema(path: &Path) {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        create_latest_schema(&mut glue, Utc::now().naive_utc()).unwrap();
    }

    #[test]
    fn detects_fresh_memory_and_initializes_the_latest_schema() {
        let mut glue = Glue::new(MemoryStorage::default());
        assert_eq!(
            detect_schema(&mut glue).unwrap(),
            DetectedSchemaVersion::Fresh
        );

        initialize_memory(&mut glue).unwrap();
        assert_eq!(detect_schema(&mut glue).unwrap(), DetectedSchemaVersion::V1);
    }

    #[test]
    fn migration_entrypoint_handles_fresh_v0_and_current_databases() {
        let temp = tempfile::tempdir().unwrap();

        let fresh = temp.path().join("fresh.redb");
        drop(RedbStorage::new(&fresh).unwrap());
        assert_eq!(
            migrate_to_latest(&fresh).unwrap(),
            MigrationReport::default()
        );

        let legacy = temp.path().join("legacy.redb");
        write_v0_managed_table(&legacy);
        assert_eq!(
            migrate_to_latest(&legacy).unwrap(),
            MigrationReport {
                migrated_tables: 1,
                unchanged_tables: 0,
                rewritten_rows: 0,
            }
        );
        assert_eq!(
            migrate_to_latest(&legacy).unwrap(),
            MigrationReport {
                migrated_tables: 0,
                unchanged_tables: 1,
                rewritten_rows: 0,
            }
        );
    }

    #[test]
    fn initialization_rejects_an_unmigrated_redb_schema() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy.redb");
        write_v0_managed_table(&path);
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());

        assert!(matches!(
            initialize_redb(&mut glue),
            Err(ThreadStoreError::MigrationRequired(0))
        ));
    }

    #[test]
    fn newer_and_incomplete_migration_history_are_rejected() {
        let temp = tempfile::tempdir().unwrap();

        let newer = temp.path().join("newer.redb");
        write_current_schema(&newer);
        {
            let mut glue = Glue::new(RedbStorage::new(&newer).unwrap());
            schema_migration::record(&mut glue, 2, Utc::now().naive_utc()).unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&newer),
            Err(ThreadStoreError::UnsupportedNewerSchemaVersion {
                found: 2,
                supported: 1
            })
        ));
        let mut glue = Glue::new(RedbStorage::new(&newer).unwrap());
        assert!(matches!(
            initialize_redb(&mut glue),
            Err(ThreadStoreError::UnsupportedNewerSchemaVersion {
                found: 2,
                supported: 1
            })
        ));
        drop(glue);

        let gap = temp.path().join("gap.redb");
        write_current_schema(&gap);
        {
            let mut glue = Glue::new(RedbStorage::new(&gap).unwrap());
            schema_migration::record(&mut glue, 3, Utc::now().naive_utc()).unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&gap),
            Err(ThreadStoreError::InvalidSchemaMigrationHistory)
        ));
    }

    #[test]
    fn invalid_or_incomplete_table_sets_are_rejected_without_rewriting() {
        let temp = tempfile::tempdir().unwrap();

        let unexpected = temp.path().join("unexpected.redb");
        write_current_schema(&unexpected);
        {
            let mut glue = Glue::new(RedbStorage::new(&unexpected).unwrap());
            table("unrelated_data")
                .create_table()
                .add_column("id INTEGER")
                .execute(&mut glue)
                .unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&unexpected),
            Err(ThreadStoreError::UnexpectedSchemaTable(table)) if table == "unrelated_data"
        ));
        let mut glue = Glue::new(RedbStorage::new(&unexpected).unwrap());
        assert!(matches!(
            initialize_redb(&mut glue),
            Err(ThreadStoreError::UnexpectedSchemaTable(table)) if table == "unrelated_data"
        ));
        drop(glue);

        let archived_only = temp.path().join("archived-only.redb");
        {
            let mut glue = Glue::new(RedbStorage::new(&archived_only).unwrap());
            table(v0_to_v1::LEGACY_ARCHIVED_THREADS_TABLE)
                .create_table()
                .add_column("thread_id TEXT PRIMARY KEY")
                .execute(&mut glue)
                .unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&archived_only),
            Err(ThreadStoreError::IncompleteSchema)
        ));

        let migrations_only = temp.path().join("migrations-only.redb");
        {
            let mut glue = Glue::new(RedbStorage::new(&migrations_only).unwrap());
            schema_migration::create_table(&mut glue).unwrap();
            schema_migration::record(&mut glue, 1, Utc::now().naive_utc()).unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&migrations_only),
            Err(ThreadStoreError::IncompleteSchema)
        ));

        let invalid_current = temp.path().join("invalid-current.redb");
        write_v0_managed_table(&invalid_current);
        {
            let mut glue = Glue::new(RedbStorage::new(&invalid_current).unwrap());
            schema_migration::create_table(&mut glue).unwrap();
            schema_migration::record(&mut glue, 1, Utc::now().naive_utc()).unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&invalid_current),
            Err(ThreadStoreError::InvalidSchemaTable(table))
                if table == managed_thread::TABLE_NAME
        ));
    }

    #[test]
    fn migration_validates_the_input_path() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing.redb");
        assert!(matches!(
            migrate_to_latest(&missing),
            Err(ThreadStoreError::MigrationPathMissing(_))
        ));
        assert!(matches!(
            migrate_to_latest(temp.path()),
            Err(ThreadStoreError::MigrationPathNotFile(_))
        ));
    }
}
