mod schema;
mod v0_to_v1;
mod v1_to_v2;
mod v2_to_v3;
mod v3_to_v4;

use chrono::{NaiveDateTime, Utc};
use gluesql::{
    core::{
        query_builder::{Execute, begin, commit, rollback},
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, RedbStorage},
};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use uuid::Uuid;

use super::{
    Result, TaskStoreError, managed_thread, managed_worktree, push_installation, push_vapid_key,
    schema_migration,
};

const LATEST_SCHEMA_VERSION: i64 = 4;
const APPLICATION_TABLE_COUNT: usize = 4;

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
    V2,
    V3,
    V4,
    UnsupportedNewer(i64),
}

struct StagedDatabase {
    path: PathBuf,
    published: bool,
}

impl StagedDatabase {
    fn new(target: &Path) -> Self {
        let filename = target
            .file_name()
            .and_then(|filename| filename.to_str())
            .unwrap_or("caffold.redb");
        let path = target.with_file_name(format!(".{filename}.migration-{}", Uuid::new_v4()));
        Self {
            path,
            published: false,
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn publish(mut self, target: &Path) -> Result<()> {
        let permissions = std::fs::metadata(target)?.permissions();
        std::fs::set_permissions(&self.path, permissions)?;
        std::fs::rename(&self.path, target)?;
        self.published = true;
        Ok(())
    }
}

impl Drop for StagedDatabase {
    fn drop(&mut self) {
        if !self.published {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Migrates an existing Caffold database to the latest application schema.
///
/// Opening and migrating are separate operations, newer schemas are rejected,
/// and the report makes idempotency observable in tests.
pub(super) fn migrate_to_latest(path: &Path) -> Result<MigrationReport> {
    if !path.exists() {
        return Err(TaskStoreError::MigrationPathMissing(
            path.display().to_string(),
        ));
    }
    if !path.is_file() {
        return Err(TaskStoreError::MigrationPathNotFile(
            path.display().to_string(),
        ));
    }

    let detected = detect_redb_schema(path)?;
    match detected {
        DetectedSchemaVersion::Fresh => Ok(MigrationReport::default()),
        DetectedSchemaVersion::V0 => migrate_v0_to_latest(path),
        DetectedSchemaVersion::V1
        | DetectedSchemaVersion::V2
        | DetectedSchemaVersion::V3
        | DetectedSchemaVersion::V4 => migrate_supported_to_latest(path, detected),
        DetectedSchemaVersion::UnsupportedNewer(version) => {
            Err(TaskStoreError::UnsupportedNewerSchemaVersion {
                found: version,
                supported: LATEST_SCHEMA_VERSION,
            })
        }
    }
}

fn migrate_v0_to_latest(path: &Path) -> Result<MigrationReport> {
    migrate_v0_to_latest_with(path, |staged_path| {
        migrate_supported_to_latest(staged_path, DetectedSchemaVersion::V1)
    })
}

fn migrate_v0_to_latest_with<F>(path: &Path, migrate_staged: F) -> Result<MigrationReport>
where
    F: FnOnce(&Path) -> Result<MigrationReport>,
{
    let staged = StagedDatabase::new(path);
    let first = v0_to_v1::migrate(path, staged.path())?;
    let remaining = migrate_staged(staged.path())?;
    if detect_redb_schema(staged.path())? != DetectedSchemaVersion::V4 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    staged.publish(path)?;
    Ok(combine_reports([first, remaining]))
}

fn migrate_supported_to_latest(
    path: &Path,
    detected: DetectedSchemaVersion,
) -> Result<MigrationReport> {
    match detected {
        DetectedSchemaVersion::V1 => {
            let first = v1_to_v2::migrate(path)?;
            let second = v2_to_v3::migrate(path)?;
            let third = v3_to_v4::migrate(path)?;
            Ok(combine_reports([first, second, third]))
        }
        DetectedSchemaVersion::V2 => {
            let first = v2_to_v3::migrate(path)?;
            let second = v3_to_v4::migrate(path)?;
            Ok(combine_reports([first, second]))
        }
        DetectedSchemaVersion::V3 => v3_to_v4::migrate(path),
        DetectedSchemaVersion::V4 => Ok(MigrationReport {
            migrated_tables: 0,
            unchanged_tables: APPLICATION_TABLE_COUNT,
            rewritten_rows: 0,
        }),
        DetectedSchemaVersion::Fresh
        | DetectedSchemaVersion::V0
        | DetectedSchemaVersion::UnsupportedNewer(_) => Err(TaskStoreError::IncompleteSchema),
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
        Ok(DetectedSchemaVersion::V4) => Ok(()),
        Ok(DetectedSchemaVersion::V3) => Err(TaskStoreError::MigrationRequired(3)),
        Ok(DetectedSchemaVersion::V2) => Err(TaskStoreError::MigrationRequired(2)),
        Ok(DetectedSchemaVersion::V1) => Err(TaskStoreError::MigrationRequired(1)),
        Ok(DetectedSchemaVersion::V0) => Err(TaskStoreError::MigrationRequired(0)),
        Ok(DetectedSchemaVersion::UnsupportedNewer(version)) => {
            Err(TaskStoreError::UnsupportedNewerSchemaVersion {
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
    managed_worktree::create_table(glue)?;
    push_installation::create_table(glue)?;
    push_vapid_key::create_table(glue)?;
    schema_migration::create_table(glue)?;
    for version in 1..=LATEST_SCHEMA_VERSION {
        schema_migration::record(glue, version, applied_at)?;
    }
    Ok(())
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
        schema::v4::MANAGED_THREADS_TABLE.to_string(),
        schema::v4::MANAGED_WORKTREES_TABLE.to_string(),
        schema::v4::PUSH_INSTALLATIONS_TABLE.to_string(),
        schema::v4::PUSH_VAPID_KEYS_TABLE.to_string(),
        v0_to_v1::LEGACY_ARCHIVED_THREADS_TABLE.to_string(),
        schema_migration::TABLE_NAME.to_string(),
    ]);
    if let Some(unexpected) = table_names.difference(&known_names).next() {
        return Err(TaskStoreError::UnexpectedSchemaTable(unexpected.clone()));
    }

    let has_managed = table_names.contains(schema::v4::MANAGED_THREADS_TABLE);
    let has_worktrees = table_names.contains(schema::v4::MANAGED_WORKTREES_TABLE);
    let has_push_installations = table_names.contains(schema::v4::PUSH_INSTALLATIONS_TABLE);
    let has_push_vapid_keys = table_names.contains(schema::v4::PUSH_VAPID_KEYS_TABLE);
    let has_legacy_archived = table_names.contains(v0_to_v1::LEGACY_ARCHIVED_THREADS_TABLE);
    let has_migrations = table_names.contains(schema_migration::TABLE_NAME);

    if !has_migrations {
        return match (
            has_managed,
            has_worktrees,
            has_push_installations,
            has_push_vapid_keys,
            has_legacy_archived,
        ) {
            (false, false, false, false, false) => Ok(DetectedSchemaVersion::Fresh),
            (true, false, false, false, _) => Ok(DetectedSchemaVersion::V0),
            _ => Err(TaskStoreError::IncompleteSchema),
        };
    }

    if !has_managed || has_legacy_archived {
        return Err(TaskStoreError::IncompleteSchema);
    }
    schema_migration::validate_table(glue)?;
    let version = schema_migration::current_version(glue)?;
    match version {
        1 => {
            schema::v1::validate(glue)?;
            Ok(DetectedSchemaVersion::V1)
        }
        2 => {
            schema::v2::validate(glue)?;
            Ok(DetectedSchemaVersion::V2)
        }
        3 => {
            schema::v3::validate(glue)?;
            Ok(DetectedSchemaVersion::V3)
        }
        LATEST_SCHEMA_VERSION => {
            schema::v4::validate(glue)?;
            Ok(DetectedSchemaVersion::V4)
        }
        version => Ok(DetectedSchemaVersion::UnsupportedNewer(version)),
    }
}

fn combine_reports<const N: usize>(reports: [MigrationReport; N]) -> MigrationReport {
    let mut combined = reports
        .into_iter()
        .fold(MigrationReport::default(), |combined, report| {
            MigrationReport {
                migrated_tables: combined.migrated_tables + report.migrated_tables,
                unchanged_tables: 0,
                rewritten_rows: combined.rewritten_rows + report.rewritten_rows,
            }
        });
    // A table unchanged in an intermediate step can still be migrated later.
    combined.unchanged_tables = APPLICATION_TABLE_COUNT.saturating_sub(combined.migrated_tables);
    combined
}

#[cfg(test)]
mod tests {
    use crate::task_store::{
        ManagedThread, ManagedWorktree, ManagedWorktreeState, PushSubscriptionInput, TaskStore,
    };
    use gluesql::{
        core::query_builder::{Execute, table},
        prelude::MemoryStorage,
    };

    use super::*;

    fn write_v0_managed_table(path: &Path) {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        write_v0_table(&mut glue, schema::v1::MANAGED_THREADS_TABLE, &[]);
    }

    fn write_v0_table(
        glue: &mut Glue<RedbStorage>,
        table_name: &'static str,
        rows: &[v0_to_v1::LegacyManagedThreadRow],
    ) {
        table(table_name)
            .create_table()
            .add_column("thread_id TEXT PRIMARY KEY")
            .add_column("last_observed_recency_ms INTEGER NULL")
            .add_column("claimed_at_ms INTEGER")
            .add_column("last_opened_at_ms INTEGER NULL")
            .add_column("last_seen_activity_ms INTEGER NULL")
            .add_column("model TEXT NULL")
            .add_column("reasoning_effort TEXT NULL")
            .execute(glue)
            .unwrap();
        if !rows.is_empty() {
            table(table_name)
                .insert()
                .values_from(rows)
                .unwrap()
                .execute(glue)
                .unwrap();
        }
    }

    fn write_v0_database(
        path: &Path,
        managed: &[v0_to_v1::LegacyManagedThreadRow],
        archived: &[v0_to_v1::LegacyManagedThreadRow],
    ) {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        write_v0_table(&mut glue, schema::v1::MANAGED_THREADS_TABLE, managed);
        write_v0_table(&mut glue, v0_to_v1::LEGACY_ARCHIVED_THREADS_TABLE, archived);
    }

    fn legacy_row(thread_id: &str, offset: i64) -> v0_to_v1::LegacyManagedThreadRow {
        v0_to_v1::LegacyManagedThreadRow {
            thread_id: thread_id.to_string(),
            last_observed_recency_ms: Some(1_750_000_001_000 + offset),
            claimed_at_ms: 1_750_000_000_000 + offset,
            last_opened_at_ms: Some(1_750_000_002_000 + offset),
            last_seen_activity_ms: Some(1_750_000_003_000 + offset),
            model: Some(format!("gpt-{thread_id}")),
            reasoning_effort: Some("high".to_string()),
        }
    }

    fn assert_v0_source_intact(path: &Path, expected: &v0_to_v1::LegacyManagedThreadRow) {
        assert_eq!(detect_redb_schema(path).unwrap(), DetectedSchemaVersion::V0);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        assert_eq!(
            v0_to_v1::read_legacy_rows(&mut glue, schema::v1::MANAGED_THREADS_TABLE).unwrap(),
            vec![expected.clone()]
        );
    }

    fn assert_only_original_file_remains(path: &Path) {
        let filenames = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(filenames, vec![path.file_name().unwrap()]);
    }

    fn write_v1_schema(path: &Path) {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        schema::v1::create(&mut glue, Utc::now().naive_utc()).unwrap();
    }

    fn write_v2_schema(path: &Path) {
        write_v1_schema(path);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        schema::v2::create_managed_worktrees(&mut glue).unwrap();
        schema_migration::record(&mut glue, 2, Utc::now().naive_utc()).unwrap();
    }

    fn write_v3_schema(path: &Path) {
        write_v2_schema(path);
        v2_to_v3::migrate(path).unwrap();
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
        assert_eq!(detect_schema(&mut glue).unwrap(), DetectedSchemaVersion::V4);
    }

    #[test]
    fn migration_entrypoint_handles_every_supported_schema_version() {
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
                migrated_tables: 5,
                unchanged_tables: 0,
                rewritten_rows: 0,
            }
        );
        assert_eq!(
            migrate_to_latest(&legacy).unwrap(),
            MigrationReport {
                migrated_tables: 0,
                unchanged_tables: 4,
                rewritten_rows: 0,
            }
        );

        let v1 = temp.path().join("v1.redb");
        write_v1_schema(&v1);
        assert_eq!(
            migrate_to_latest(&v1).unwrap(),
            MigrationReport {
                migrated_tables: 4,
                unchanged_tables: 0,
                rewritten_rows: 0,
            }
        );

        let v2 = temp.path().join("v2.redb");
        write_v2_schema(&v2);
        assert_eq!(
            migrate_to_latest(&v2).unwrap(),
            MigrationReport {
                migrated_tables: 3,
                unchanged_tables: 1,
                rewritten_rows: 0,
            }
        );

        let v3 = temp.path().join("v3.redb");
        write_v3_schema(&v3);
        assert_eq!(
            migrate_to_latest(&v3).unwrap(),
            MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 2,
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
            Err(TaskStoreError::MigrationRequired(0))
        ));
    }

    #[test]
    fn v0_runs_the_complete_chain_and_preserves_every_legacy_field() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy.redb");
        let active = legacy_row("active", 0);
        let archived = legacy_row("archived", 10_000);
        write_v0_database(
            &path,
            std::slice::from_ref(&active),
            std::slice::from_ref(&archived),
        );

        assert_eq!(
            migrate_to_latest(&path).unwrap(),
            MigrationReport {
                migrated_tables: 6,
                unchanged_tables: 0,
                rewritten_rows: 2,
            }
        );
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V4
        );

        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        let migrated_active = managed_thread::get(&mut glue, "active").unwrap().unwrap();
        assert_eq!(migrated_active.thread_id, active.thread_id);
        assert_eq!(
            migrated_active.last_observed_recency_ms,
            active.last_observed_recency_ms.map(|value| value as u64)
        );
        assert_eq!(migrated_active.claimed_at_ms, active.claimed_at_ms as u64);
        assert_eq!(
            migrated_active.last_opened_at_ms,
            active.last_opened_at_ms.map(|value| value as u64)
        );
        assert_eq!(
            migrated_active.last_seen_activity_ms,
            active.last_seen_activity_ms.map(|value| value as u64)
        );
        assert_eq!(migrated_active.last_completed_at_ms, None);
        assert_eq!(migrated_active.model, active.model);
        assert_eq!(migrated_active.reasoning_effort, active.reasoning_effort);
        assert!(!migrated_active.fast_mode);

        let migrated_archived = managed_thread::get_archived(&mut glue, "archived")
            .unwrap()
            .unwrap();
        assert!(migrated_archived.archived_at_ms.is_some());
        assert_eq!(
            migrated_archived.last_observed_recency_ms,
            archived.last_observed_recency_ms.map(|value| value as u64)
        );
        assert_eq!(
            migrated_archived.claimed_at_ms,
            archived.claimed_at_ms as u64
        );
        assert_eq!(
            migrated_archived.last_opened_at_ms,
            archived.last_opened_at_ms.map(|value| value as u64)
        );
        assert_eq!(
            migrated_archived.last_seen_activity_ms,
            archived.last_seen_activity_ms.map(|value| value as u64)
        );
        assert_eq!(migrated_archived.last_completed_at_ms, None);
        assert_eq!(migrated_archived.model, archived.model);
        assert_eq!(
            migrated_archived.reasoning_effort,
            archived.reasoning_effort
        );
        assert!(!migrated_archived.fast_mode);
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 4);
        drop(glue);
        assert_only_original_file_remains(&path);
    }

    #[test]
    fn intermediate_v0_chain_failure_preserves_source_and_removes_staged_database() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy.redb");
        let row = legacy_row("active", 0);
        write_v0_database(&path, std::slice::from_ref(&row), &[]);

        assert!(matches!(
            migrate_v0_to_latest_with(&path, |staged_path| {
                v1_to_v2::migrate(staged_path)?;
                assert_eq!(detect_redb_schema(staged_path)?, DetectedSchemaVersion::V2);
                Err(TaskStoreError::UnexpectedPayload)
            }),
            Err(TaskStoreError::UnexpectedPayload)
        ));
        assert_v0_source_intact(&path, &row);
        assert_only_original_file_remains(&path);
    }

    #[test]
    fn final_v0_validation_failure_preserves_source_and_removes_staged_database() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("legacy.redb");
        let row = legacy_row("active", 0);
        write_v0_database(&path, std::slice::from_ref(&row), &[]);

        assert!(matches!(
            migrate_v0_to_latest_with(&path, |staged_path| {
                let report = migrate_supported_to_latest(
                    staged_path,
                    DetectedSchemaVersion::V1,
                )?;
                let mut glue = Glue::new(RedbStorage::new(staged_path)?);
                table("unexpected_after_migration")
                    .create_table()
                    .add_column("id INTEGER")
                    .execute(&mut glue)?;
                drop(glue);
                Ok(report)
            }),
            Err(TaskStoreError::UnexpectedSchemaTable(table))
                if table == "unexpected_after_migration"
        ));
        assert_v0_source_intact(&path, &row);
        assert_only_original_file_remains(&path);
    }

    #[test]
    fn current_v4_data_is_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("current.redb");
        let store = TaskStore::redb(&path).unwrap();
        let expected_thread = store
            .claim(
                ManagedThread {
                    thread_id: "thread-v4".to_string(),
                    archived_at_ms: None,
                    last_observed_recency_ms: Some(1_000),
                    claimed_at_ms: 0,
                    last_opened_at_ms: None,
                    last_seen_activity_ms: None,
                    last_completed_at_ms: Some(2_000),
                    model: Some("gpt-test".to_string()),
                    reasoning_effort: Some("high".to_string()),
                    fast_mode: true,
                },
                3_000,
            )
            .unwrap();
        let expected_worktree = ManagedWorktree {
            worktree_id: "worktree-v4".to_string(),
            thread_id: Some("thread-v4".to_string()),
            repository_git_dir: "/repo/.git".to_string(),
            worktree_path: "/repo/worktree".to_string(),
            branch_name: "feature/v4".to_string(),
            head_sha: "abc123".to_string(),
            state: ManagedWorktreeState::Ready,
            created_at_ms: 4_000,
            updated_at_ms: 5_000,
        };
        store.create_worktree(expected_worktree.clone()).unwrap();
        let expected_push = store
            .upsert_push_installation(
                PushSubscriptionInput {
                    client_id: "client-v4".to_string(),
                    installation_label: "Browser".to_string(),
                    endpoint: "https://push.example/subscription".to_string(),
                    p256dh: "p256dh".to_string(),
                    auth: "auth".to_string(),
                    expiration_time_ms: Some(10_000),
                },
                6_000,
            )
            .unwrap();
        assert_eq!(
            store
                .load_or_create_vapid_private_key("private-key", 7_000)
                .unwrap(),
            "private-key"
        );
        drop(store);

        assert_eq!(
            migrate_to_latest(&path).unwrap(),
            MigrationReport {
                migrated_tables: 0,
                unchanged_tables: 4,
                rewritten_rows: 0,
            }
        );

        let reopened = TaskStore::redb(&path).unwrap();
        assert_eq!(reopened.get("thread-v4").unwrap(), Some(expected_thread));
        assert_eq!(
            reopened.worktree("worktree-v4").unwrap(),
            Some(expected_worktree)
        );
        assert_eq!(
            reopened.push_installation("client-v4").unwrap(),
            Some(expected_push)
        );
        assert_eq!(
            reopened
                .load_or_create_vapid_private_key("replacement", 8_000)
                .unwrap(),
            "private-key"
        );
    }

    #[test]
    fn newer_and_incomplete_migration_history_are_rejected() {
        let temp = tempfile::tempdir().unwrap();

        let newer = temp.path().join("newer.redb");
        write_current_schema(&newer);
        {
            let mut glue = Glue::new(RedbStorage::new(&newer).unwrap());
            schema_migration::record(&mut glue, 5, Utc::now().naive_utc()).unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&newer),
            Err(TaskStoreError::UnsupportedNewerSchemaVersion {
                found: 5,
                supported: 4
            })
        ));
        let mut glue = Glue::new(RedbStorage::new(&newer).unwrap());
        assert!(matches!(
            initialize_redb(&mut glue),
            Err(TaskStoreError::UnsupportedNewerSchemaVersion {
                found: 5,
                supported: 4
            })
        ));
        drop(glue);

        let gap = temp.path().join("gap.redb");
        write_current_schema(&gap);
        {
            let mut glue = Glue::new(RedbStorage::new(&gap).unwrap());
            schema_migration::record(&mut glue, 6, Utc::now().naive_utc()).unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&gap),
            Err(TaskStoreError::InvalidSchemaMigrationHistory)
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
            Err(TaskStoreError::UnexpectedSchemaTable(table)) if table == "unrelated_data"
        ));
        let mut glue = Glue::new(RedbStorage::new(&unexpected).unwrap());
        assert!(matches!(
            initialize_redb(&mut glue),
            Err(TaskStoreError::UnexpectedSchemaTable(table)) if table == "unrelated_data"
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
            Err(TaskStoreError::IncompleteSchema)
        ));

        let migrations_only = temp.path().join("migrations-only.redb");
        {
            let mut glue = Glue::new(RedbStorage::new(&migrations_only).unwrap());
            schema_migration::create_table(&mut glue).unwrap();
            schema_migration::record(&mut glue, 1, Utc::now().naive_utc()).unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&migrations_only),
            Err(TaskStoreError::IncompleteSchema)
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
            Err(TaskStoreError::InvalidSchemaTable(table))
                if table == managed_thread::TABLE_NAME
        ));
    }

    #[test]
    fn migration_validates_the_input_path() {
        let temp = tempfile::tempdir().unwrap();
        let missing = temp.path().join("missing.redb");
        assert!(matches!(
            migrate_to_latest(&missing),
            Err(TaskStoreError::MigrationPathMissing(_))
        ));
        assert!(matches!(
            migrate_to_latest(temp.path()),
            Err(TaskStoreError::MigrationPathNotFile(_))
        ));
    }
}
