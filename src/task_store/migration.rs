mod schema;
mod v0_to_v1;
mod v1_to_v2;
mod v2_to_v3;
mod v3_to_v4;
mod v4_to_v5;

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
    Result, TaskStoreError, managed_section, managed_thread, managed_worktree, push_installation,
    push_vapid_key, schema_migration,
};

const LATEST_SCHEMA_VERSION: i64 = 5;
const APPLICATION_TABLE_COUNT: usize = 5;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NavigatorMigrationSnapshot {
    pub sections: Vec<NavigatorMigrationSection>,
    pub threads: Vec<NavigatorMigrationThread>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NavigatorMigrationSection {
    pub section_id: String,
    pub logical_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NavigatorMigrationThread {
    pub thread_id: String,
    pub display_name: String,
    pub classification: NavigatorMigrationThreadClassification,
    pub section_id: Option<String>,
    pub position_in_section: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NavigatorMigrationThreadClassification {
    ActiveSectioned,
    ActiveUnsectioned,
    CodexArchived,
    Missing,
    LocallyArchived,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedThreadMigrationInventory {
    pub thread_id: String,
    pub archived: bool,
}

pub(crate) enum PreparedTaskStoreMigration {
    Ready,
    NeedsSnapshot(PendingTaskStoreMigration),
}

pub(crate) struct PendingTaskStoreMigration {
    staged: StagedDatabase,
    target: PathBuf,
    inventory: Vec<ManagedThreadMigrationInventory>,
    prior_report: MigrationReport,
}

impl PendingTaskStoreMigration {
    pub(crate) fn inventory(&self) -> &[ManagedThreadMigrationInventory] {
        &self.inventory
    }

    pub(crate) fn apply(self, snapshot: &NavigatorMigrationSnapshot) -> Result<()> {
        let latest = v4_to_v5::migrate(self.staged.path(), snapshot)?;
        if detect_redb_schema(self.staged.path())? != DetectedSchemaVersion::V5 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        let report = combine_reports([self.prior_report, latest]);
        self.staged.publish(&self.target)?;
        let _report = report;
        Ok(())
    }
}

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
    V5,
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

/// Prepares an existing database for a linear startup migration.
///
/// Legacy schemas are normalized to v4 in a disposable staged database. The
/// caller supplies the read-only Codex snapshot before the staged v5 database
/// can replace the source.
pub(crate) fn prepare_to_latest(path: &Path) -> Result<PreparedTaskStoreMigration> {
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
        DetectedSchemaVersion::Fresh | DetectedSchemaVersion::V5 => {
            Ok(PreparedTaskStoreMigration::Ready)
        }
        DetectedSchemaVersion::V0
        | DetectedSchemaVersion::V1
        | DetectedSchemaVersion::V2
        | DetectedSchemaVersion::V3
        | DetectedSchemaVersion::V4 => prepare_legacy(path, detected),
        DetectedSchemaVersion::UnsupportedNewer(version) => {
            Err(TaskStoreError::UnsupportedNewerSchemaVersion {
                found: version,
                supported: LATEST_SCHEMA_VERSION,
            })
        }
    }
}

fn prepare_legacy(
    path: &Path,
    detected: DetectedSchemaVersion,
) -> Result<PreparedTaskStoreMigration> {
    let staged = StagedDatabase::new(path);
    let prior_report = if detected == DetectedSchemaVersion::V0 {
        let first = v0_to_v1::migrate(path, staged.path())?;
        let remaining = migrate_supported_to_v4(staged.path(), DetectedSchemaVersion::V1)?;
        combine_reports([first, remaining])
    } else {
        std::fs::copy(path, staged.path())?;
        migrate_supported_to_v4(staged.path(), detected)?
    };
    if detect_redb_schema(staged.path())? != DetectedSchemaVersion::V4 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    let inventory = v4_to_v5::inventory(staged.path())?;
    Ok(PreparedTaskStoreMigration::NeedsSnapshot(
        PendingTaskStoreMigration {
            staged,
            target: path.to_path_buf(),
            inventory,
            prior_report,
        },
    ))
}

fn migrate_supported_to_v4(
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
            unchanged_tables: 4,
            rewritten_rows: 0,
        }),
        DetectedSchemaVersion::Fresh
        | DetectedSchemaVersion::V0
        | DetectedSchemaVersion::V5
        | DetectedSchemaVersion::UnsupportedNewer(_) => Err(TaskStoreError::IncompleteSchema),
    }
}

#[cfg(test)]
pub(crate) fn write_empty_v4_test_store(path: &Path) -> Result<()> {
    write_v4_test_store(path, &[])
}

#[cfg(test)]
pub(crate) fn write_v4_test_store(path: &Path, threads: &[(String, bool)]) -> Result<()> {
    use gluesql::core::query_builder::table;

    let applied_at = Utc::now().naive_utc();
    {
        let mut glue = Glue::new(RedbStorage::new(path)?);
        schema::v1::create(&mut glue, applied_at)?;
        if !threads.is_empty() {
            let rows = threads
                .iter()
                .map(|(thread_id, archived)| schema::v1::ManagedThreadRow {
                    thread_id: thread_id.clone(),
                    archived_at: archived.then_some(applied_at),
                    last_observed_recency_at: Some(applied_at),
                    claimed_at: applied_at,
                    last_opened_at: Some(applied_at),
                    last_seen_activity_at: Some(applied_at),
                    last_completed_at: Some(applied_at),
                    model: Some("gpt-5.3-codex-spark".to_string()),
                    reasoning_effort: Some("low".to_string()),
                })
                .collect::<Vec<_>>();
            table(schema::v1::MANAGED_THREADS_TABLE)
                .insert()
                .values_from(&rows)?
                .execute(&mut glue)?;
        }
    }
    v1_to_v2::migrate(path)?;
    v2_to_v3::migrate(path)?;
    v3_to_v4::migrate(path)?;
    Ok(())
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
        Ok(DetectedSchemaVersion::V5) => Ok(()),
        Ok(DetectedSchemaVersion::V4) => Err(TaskStoreError::MigrationRequired(4)),
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
    managed_section::create_table(glue)?;
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
        schema::v5::MANAGED_SECTIONS_TABLE.to_string(),
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
    let has_managed_sections = table_names.contains(schema::v5::MANAGED_SECTIONS_TABLE);
    let has_legacy_archived = table_names.contains(v0_to_v1::LEGACY_ARCHIVED_THREADS_TABLE);
    let has_migrations = table_names.contains(schema_migration::TABLE_NAME);

    if !has_migrations {
        return match (
            has_managed,
            has_worktrees,
            has_push_installations,
            has_push_vapid_keys,
            has_managed_sections,
            has_legacy_archived,
        ) {
            (false, false, false, false, false, false) => Ok(DetectedSchemaVersion::Fresh),
            (true, false, false, false, false, _) => Ok(DetectedSchemaVersion::V0),
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
        4 => {
            schema::v4::validate(glue)?;
            Ok(DetectedSchemaVersion::V4)
        }
        LATEST_SCHEMA_VERSION => {
            schema::v5::validate(glue)?;
            Ok(DetectedSchemaVersion::V5)
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
    use chrono::NaiveDateTime;
    use gluesql::{
        core::query_builder::{Execute, table},
        prelude::MemoryStorage,
    };

    use super::*;
    use crate::task_store::TaskStore;

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
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

    fn write_v0(path: &Path) {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        write_v0_table(&mut glue, schema::v1::MANAGED_THREADS_TABLE, &[]);
    }

    fn write_v1(path: &Path) {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        schema::v1::create(&mut glue, timestamp(1)).unwrap();
    }

    fn write_v2(path: &Path) {
        write_v1(path);
        v1_to_v2::migrate(path).unwrap();
    }

    fn write_v3(path: &Path) {
        write_v2(path);
        v2_to_v3::migrate(path).unwrap();
    }

    fn write_v4(path: &Path) {
        write_v3(path);
        v3_to_v4::migrate(path).unwrap();
    }

    fn finish_empty_migration(path: &Path) {
        let PreparedTaskStoreMigration::NeedsSnapshot(pending) = prepare_to_latest(path).unwrap()
        else {
            panic!("legacy schema should require a snapshot");
        };
        assert!(pending.inventory().is_empty());
        pending
            .apply(&NavigatorMigrationSnapshot {
                sections: Vec::new(),
                threads: Vec::new(),
            })
            .unwrap();
        assert_eq!(detect_redb_schema(path).unwrap(), DetectedSchemaVersion::V5);
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

    #[test]
    fn fresh_stores_initialize_directly_as_v5() {
        let mut memory = Glue::new(MemoryStorage::default());
        initialize_memory(&mut memory).unwrap();
        assert_eq!(
            detect_schema(&mut memory).unwrap(),
            DetectedSchemaVersion::V5
        );

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fresh.redb");
        drop(RedbStorage::new(&path).unwrap());
        assert!(matches!(
            prepare_to_latest(&path).unwrap(),
            PreparedTaskStoreMigration::Ready
        ));
        drop(TaskStore::redb(&path).unwrap());
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V5
        );
    }

    #[test]
    fn every_supported_schema_path_converges_on_v5() {
        type SchemaWriter = (&'static str, fn(&Path));

        let temp = tempfile::tempdir().unwrap();
        let writers: [SchemaWriter; 5] = [
            ("v0", write_v0),
            ("v1", write_v1),
            ("v2", write_v2),
            ("v3", write_v3),
            ("v4", write_v4),
        ];
        for (name, write) in writers {
            let path = temp.path().join(format!("{name}.redb"));
            write(&path);
            finish_empty_migration(&path);
            assert!(matches!(
                prepare_to_latest(&path).unwrap(),
                PreparedTaskStoreMigration::Ready
            ));
        }
    }

    #[test]
    fn v0_chain_preserves_legacy_rows_and_publishes_only_after_snapshot() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v0.redb");
        let active = legacy_row("active-thread", 0);
        let archived = legacy_row("archived-thread", 10_000);
        {
            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            write_v0_table(
                &mut glue,
                schema::v1::MANAGED_THREADS_TABLE,
                std::slice::from_ref(&active),
            );
            write_v0_table(
                &mut glue,
                v0_to_v1::LEGACY_ARCHIVED_THREADS_TABLE,
                std::slice::from_ref(&archived),
            );
        }

        let PreparedTaskStoreMigration::NeedsSnapshot(pending) = prepare_to_latest(&path).unwrap()
        else {
            panic!("v0 should require a live snapshot");
        };
        assert_eq!(
            pending.inventory(),
            &[
                ManagedThreadMigrationInventory {
                    thread_id: "active-thread".to_string(),
                    archived: false,
                },
                ManagedThreadMigrationInventory {
                    thread_id: "archived-thread".to_string(),
                    archived: true,
                },
            ]
        );
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V0
        );

        pending
            .apply(&NavigatorMigrationSnapshot {
                sections: vec![NavigatorMigrationSection {
                    section_id: "section-1".to_string(),
                    logical_path: "Workspace/repo".to_string(),
                }],
                threads: vec![
                    NavigatorMigrationThread {
                        thread_id: "active-thread".to_string(),
                        display_name: "Current active name".to_string(),
                        classification: NavigatorMigrationThreadClassification::ActiveSectioned,
                        section_id: Some("section-1".to_string()),
                        position_in_section: Some(0),
                    },
                    NavigatorMigrationThread {
                        thread_id: "archived-thread".to_string(),
                        display_name: "Current archived name".to_string(),
                        classification: NavigatorMigrationThreadClassification::LocallyArchived,
                        section_id: None,
                        position_in_section: None,
                    },
                ],
            })
            .unwrap();

        let store = TaskStore::redb(&path).unwrap();
        let active_thread = store.get("active-thread").unwrap().unwrap();
        assert_eq!(active_thread.display_name, "Current active name");
        assert_eq!(active_thread.section_id.as_deref(), Some("section-1"));
        assert_eq!(active_thread.position_in_section, Some(0));
        assert_eq!(
            active_thread.last_observed_recency_ms,
            active.last_observed_recency_ms.map(|value| value as u64)
        );
        assert_eq!(active_thread.claimed_at_ms, active.claimed_at_ms as u64);
        assert_eq!(
            active_thread.last_opened_at_ms,
            active.last_opened_at_ms.map(|value| value as u64)
        );
        assert_eq!(
            active_thread.last_seen_activity_ms,
            active.last_seen_activity_ms.map(|value| value as u64)
        );
        assert_eq!(active_thread.model, active.model);
        assert_eq!(active_thread.reasoning_effort, active.reasoning_effort);
        assert_eq!(active_thread.last_completed_at_ms, None);
        assert!(!active_thread.fast_mode);

        let archived_thread = store.get_archived("archived-thread").unwrap().unwrap();
        assert_eq!(archived_thread.display_name, "Current archived name");
        assert!(archived_thread.archived_at_ms.is_some());
        assert_eq!(archived_thread.section_id, None);
        assert_eq!(archived_thread.position_in_section, None);
        assert_eq!(
            archived_thread.last_observed_recency_ms,
            archived.last_observed_recency_ms.map(|value| value as u64)
        );
    }

    #[test]
    fn v4_to_v5_preserves_every_existing_field() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v4.redb");
        write_v3(&path);
        let rows = vec![
            schema::v3::ManagedThreadRow {
                thread_id: "active".to_string(),
                archived_at: None,
                last_observed_recency_at: Some(timestamp(1_000)),
                claimed_at: timestamp(2_000),
                last_opened_at: Some(timestamp(3_000)),
                last_seen_activity_at: Some(timestamp(4_000)),
                last_completed_at: Some(timestamp(5_000)),
                model: Some("gpt-active".to_string()),
                reasoning_effort: Some("high".to_string()),
                fast_mode: true,
            },
            schema::v3::ManagedThreadRow {
                thread_id: "archived".to_string(),
                archived_at: Some(timestamp(6_000)),
                last_observed_recency_at: Some(timestamp(7_000)),
                claimed_at: timestamp(8_000),
                last_opened_at: Some(timestamp(9_000)),
                last_seen_activity_at: Some(timestamp(10_000)),
                last_completed_at: Some(timestamp(11_000)),
                model: Some("gpt-archived".to_string()),
                reasoning_effort: Some("xhigh".to_string()),
                fast_mode: false,
            },
        ];
        {
            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            table(schema::v3::MANAGED_THREADS_TABLE)
                .insert()
                .values_from(&rows)
                .unwrap()
                .execute(&mut glue)
                .unwrap();
        }
        v3_to_v4::migrate(&path).unwrap();

        let PreparedTaskStoreMigration::NeedsSnapshot(pending) = prepare_to_latest(&path).unwrap()
        else {
            panic!("v4 should require a snapshot");
        };
        pending
            .apply(&NavigatorMigrationSnapshot {
                sections: vec![NavigatorMigrationSection {
                    section_id: "section".to_string(),
                    logical_path: "Workspace/project".to_string(),
                }],
                threads: vec![
                    NavigatorMigrationThread {
                        thread_id: "active".to_string(),
                        display_name: "Active display".to_string(),
                        classification: NavigatorMigrationThreadClassification::ActiveSectioned,
                        section_id: Some("section".to_string()),
                        position_in_section: Some(0),
                    },
                    NavigatorMigrationThread {
                        thread_id: "archived".to_string(),
                        display_name: "Archived display".to_string(),
                        classification: NavigatorMigrationThreadClassification::LocallyArchived,
                        section_id: None,
                        position_in_section: None,
                    },
                ],
            })
            .unwrap();

        let store = TaskStore::redb(&path).unwrap();
        let active = store.get("active").unwrap().unwrap();
        assert_eq!(active.display_name, "Active display");
        assert_eq!(active.section_id.as_deref(), Some("section"));
        assert_eq!(active.position_in_section, Some(0));
        assert_eq!(active.last_observed_recency_ms, Some(1_000));
        assert_eq!(active.claimed_at_ms, 2_000);
        assert_eq!(active.last_opened_at_ms, Some(3_000));
        assert_eq!(active.last_seen_activity_ms, Some(4_000));
        assert_eq!(active.last_completed_at_ms, Some(5_000));
        assert_eq!(active.model.as_deref(), Some("gpt-active"));
        assert_eq!(active.reasoning_effort.as_deref(), Some("high"));
        assert!(active.fast_mode);

        let archived = store.get_archived("archived").unwrap().unwrap();
        assert_eq!(archived.display_name, "Archived display");
        assert_eq!(archived.archived_at_ms, Some(6_000));
        assert_eq!(archived.last_observed_recency_ms, Some(7_000));
        assert_eq!(archived.claimed_at_ms, 8_000);
        assert_eq!(archived.last_opened_at_ms, Some(9_000));
        assert_eq!(archived.last_seen_activity_ms, Some(10_000));
        assert_eq!(archived.last_completed_at_ms, Some(11_000));
        assert_eq!(archived.model.as_deref(), Some("gpt-archived"));
        assert_eq!(archived.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(!archived.fast_mode);
        assert_eq!(archived.section_id, None);
        assert_eq!(archived.position_in_section, None);
    }

    #[test]
    fn invalid_snapshot_leaves_the_source_and_staging_cleanup_intact() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v4.redb");
        write_v3(&path);
        let row = schema::v3::ManagedThreadRow {
            thread_id: "managed".to_string(),
            archived_at: None,
            last_observed_recency_at: Some(timestamp(1_000)),
            claimed_at: timestamp(2_000),
            last_opened_at: None,
            last_seen_activity_at: None,
            last_completed_at: None,
            model: None,
            reasoning_effort: None,
            fast_mode: false,
        };
        {
            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            table(schema::v3::MANAGED_THREADS_TABLE)
                .insert()
                .values_from(std::slice::from_ref(&row))
                .unwrap()
                .execute(&mut glue)
                .unwrap();
        }
        v3_to_v4::migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        let PreparedTaskStoreMigration::NeedsSnapshot(pending) = prepare_to_latest(&path).unwrap()
        else {
            panic!("v4 should require a snapshot");
        };
        assert!(matches!(
            pending.apply(&NavigatorMigrationSnapshot {
                sections: Vec::new(),
                threads: Vec::new(),
            }),
            Err(TaskStoreError::InvalidMigrationSnapshot(
                "thread inventory mismatch"
            ))
        ));

        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V4
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let filenames = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(filenames, vec![path.file_name().unwrap()]);
    }

    #[test]
    fn v4_detection_uses_the_frozen_v4_validator() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v4.redb");
        write_v4(&path);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V4
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        begin().execute(&mut glue).unwrap();
        assert!(schema::v4::validate(&glue).is_ok());
        assert!(schema::v5::validate(&glue).is_err());
        rollback().execute(&mut glue).unwrap();
    }

    #[test]
    fn newer_invalid_and_missing_inputs_are_rejected() {
        let temp = tempfile::tempdir().unwrap();

        let newer = temp.path().join("newer.redb");
        {
            let mut glue = Glue::new(RedbStorage::new(&newer).unwrap());
            create_latest_schema(&mut glue, timestamp(1)).unwrap();
            schema_migration::record(&mut glue, 6, timestamp(2)).unwrap();
        }
        assert!(matches!(
            prepare_to_latest(&newer),
            Err(TaskStoreError::UnsupportedNewerSchemaVersion {
                found: 6,
                supported: 5,
            })
        ));

        let unexpected = temp.path().join("unexpected.redb");
        {
            let mut glue = Glue::new(RedbStorage::new(&unexpected).unwrap());
            create_latest_schema(&mut glue, timestamp(1)).unwrap();
            table("unrelated")
                .create_table()
                .add_column("id INTEGER")
                .execute(&mut glue)
                .unwrap();
        }
        assert!(matches!(
            prepare_to_latest(&unexpected),
            Err(TaskStoreError::UnexpectedSchemaTable(table)) if table == "unrelated"
        ));

        let missing = temp.path().join("missing.redb");
        assert!(matches!(
            prepare_to_latest(&missing),
            Err(TaskStoreError::MigrationPathMissing(_))
        ));
        assert!(matches!(
            prepare_to_latest(temp.path()),
            Err(TaskStoreError::MigrationPathNotFile(_))
        ));
    }
}
