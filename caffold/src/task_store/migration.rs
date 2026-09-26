mod schema;
mod v10_to_v11;
mod v11_to_v12;
mod v5_to_v6;
mod v6_to_v7;
mod v7_to_v8;
mod v8_to_v9;
mod v9_to_v10;

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
    Result, TaskStoreError, managed_section, managed_thread, managed_worktree, note,
    note_directory, push_installation, push_vapid_key, schema_migration,
};

const LATEST_SCHEMA_VERSION: i64 = 12;
const OLDEST_SUPPORTED_SCHEMA_VERSION: i64 = 5;
const LEGACY_ARCHIVED_THREADS_TABLE: &str = "archived_threads";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct MigrationReport {
    pub migrated_tables: usize,
    pub unchanged_tables: usize,
    pub rewritten_rows: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DetectedSchemaVersion {
    Fresh,
    V5,
    V6,
    V7,
    V8,
    V9,
    V10,
    V11,
    V12,
    UnsupportedOlder(i64),
    UnsupportedNewer(i64),
}

/// Upgrades an existing database to the latest schema.
///
/// Every supported schema is migrated in a disposable staged copy that
/// replaces the source only after final validation. A schema older than
/// `OLDEST_SUPPORTED_SCHEMA_VERSION` is refused before anything is staged.
pub(crate) fn migrate_to_latest(path: &Path) -> Result<()> {
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

    match detect_redb_schema(path)? {
        DetectedSchemaVersion::Fresh | DetectedSchemaVersion::V12 => Ok(()),
        DetectedSchemaVersion::V5 => prepare_v5(path),
        DetectedSchemaVersion::V6 => prepare_v6(path),
        DetectedSchemaVersion::V7 => prepare_v7(path),
        DetectedSchemaVersion::V8 => prepare_v8(path),
        DetectedSchemaVersion::V9 => prepare_v9(path),
        DetectedSchemaVersion::V10 => prepare_v10(path),
        DetectedSchemaVersion::V11 => prepare_v11(path),
        DetectedSchemaVersion::UnsupportedOlder(found) => {
            Err(TaskStoreError::UnsupportedOlderSchemaVersion {
                found,
                path: path.display().to_string(),
            })
        }
        DetectedSchemaVersion::UnsupportedNewer(version) => {
            Err(TaskStoreError::UnsupportedNewerSchemaVersion {
                found: version,
                supported: LATEST_SCHEMA_VERSION,
            })
        }
    }
}

fn prepare_v5(path: &Path) -> Result<()> {
    prepare_v5_with_validation(path, |staged_path| {
        if detect_redb_schema(staged_path)? != DetectedSchemaVersion::V12 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        Ok(())
    })
}

fn prepare_v5_with_validation<F>(path: &Path, validate_staged: F) -> Result<()>
where
    F: FnOnce(&Path) -> Result<()>,
{
    prepare_supported_with_validation(path, DetectedSchemaVersion::V5, validate_staged)
}

fn prepare_v6(path: &Path) -> Result<()> {
    prepare_supported_with_validation(path, DetectedSchemaVersion::V6, |staged_path| {
        if detect_redb_schema(staged_path)? != DetectedSchemaVersion::V12 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        Ok(())
    })
}

fn prepare_v7(path: &Path) -> Result<()> {
    prepare_supported_with_validation(path, DetectedSchemaVersion::V7, |staged_path| {
        if detect_redb_schema(staged_path)? != DetectedSchemaVersion::V12 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        Ok(())
    })
}

fn prepare_v8(path: &Path) -> Result<()> {
    prepare_supported_with_validation(path, DetectedSchemaVersion::V8, |staged_path| {
        if detect_redb_schema(staged_path)? != DetectedSchemaVersion::V12 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        Ok(())
    })
}

fn prepare_v9(path: &Path) -> Result<()> {
    prepare_supported_with_validation(path, DetectedSchemaVersion::V9, |staged_path| {
        if detect_redb_schema(staged_path)? != DetectedSchemaVersion::V12 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        Ok(())
    })
}

fn prepare_v10(path: &Path) -> Result<()> {
    prepare_supported_with_validation(path, DetectedSchemaVersion::V10, |staged_path| {
        if detect_redb_schema(staged_path)? != DetectedSchemaVersion::V12 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        Ok(())
    })
}

fn prepare_v11(path: &Path) -> Result<()> {
    prepare_supported_with_validation(path, DetectedSchemaVersion::V11, |staged_path| {
        if detect_redb_schema(staged_path)? != DetectedSchemaVersion::V12 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        Ok(())
    })
}

fn prepare_supported_with_validation<F>(
    path: &Path,
    detected: DetectedSchemaVersion,
    validate_staged: F,
) -> Result<()>
where
    F: FnOnce(&Path) -> Result<()>,
{
    let staged = StagedDatabase::new(path);
    std::fs::copy(path, staged.path())?;
    match detected {
        DetectedSchemaVersion::V5 => {
            v5_to_v6::migrate(staged.path())?;
            v6_to_v7::migrate(staged.path())?;
            v7_to_v8::migrate(staged.path())?;
            v8_to_v9::migrate(staged.path())?;
            v9_to_v10::migrate(staged.path())?;
            v10_to_v11::migrate(staged.path())?;
            v11_to_v12::migrate(staged.path())?;
        }
        DetectedSchemaVersion::V6 => {
            v6_to_v7::migrate(staged.path())?;
            v7_to_v8::migrate(staged.path())?;
            v8_to_v9::migrate(staged.path())?;
            v9_to_v10::migrate(staged.path())?;
            v10_to_v11::migrate(staged.path())?;
            v11_to_v12::migrate(staged.path())?;
        }
        DetectedSchemaVersion::V7 => {
            v7_to_v8::migrate(staged.path())?;
            v8_to_v9::migrate(staged.path())?;
            v9_to_v10::migrate(staged.path())?;
            v10_to_v11::migrate(staged.path())?;
            v11_to_v12::migrate(staged.path())?;
        }
        DetectedSchemaVersion::V8 => {
            v8_to_v9::migrate(staged.path())?;
            v9_to_v10::migrate(staged.path())?;
            v10_to_v11::migrate(staged.path())?;
            v11_to_v12::migrate(staged.path())?;
        }
        DetectedSchemaVersion::V9 => {
            v9_to_v10::migrate(staged.path())?;
            v10_to_v11::migrate(staged.path())?;
            v11_to_v12::migrate(staged.path())?;
        }
        DetectedSchemaVersion::V10 => {
            v10_to_v11::migrate(staged.path())?;
            v11_to_v12::migrate(staged.path())?;
        }
        DetectedSchemaVersion::V11 => {
            v11_to_v12::migrate(staged.path())?;
        }
        _ => return Err(TaskStoreError::IncompleteSchema),
    }
    validate_staged(staged.path())?;
    staged.publish(path)
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

pub(super) fn initialize_memory<S>(glue: &mut Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    create_latest_schema(glue, Utc::now().naive_utc())
}

pub(super) fn initialize_redb(glue: &mut Glue<RedbStorage>, path: &Path) -> Result<()> {
    begin().execute(glue)?;
    let result = match detect_schema(glue) {
        Ok(DetectedSchemaVersion::Fresh) => create_latest_schema(glue, Utc::now().naive_utc()),
        Ok(DetectedSchemaVersion::V12) => Ok(()),
        Ok(DetectedSchemaVersion::V11) => Err(TaskStoreError::MigrationRequired(11)),
        Ok(DetectedSchemaVersion::V10) => Err(TaskStoreError::MigrationRequired(10)),
        Ok(DetectedSchemaVersion::V9) => Err(TaskStoreError::MigrationRequired(9)),
        Ok(DetectedSchemaVersion::V8) => Err(TaskStoreError::MigrationRequired(8)),
        Ok(DetectedSchemaVersion::V7) => Err(TaskStoreError::MigrationRequired(7)),
        Ok(DetectedSchemaVersion::V6) => Err(TaskStoreError::MigrationRequired(6)),
        Ok(DetectedSchemaVersion::V5) => Err(TaskStoreError::MigrationRequired(5)),
        Ok(DetectedSchemaVersion::UnsupportedOlder(found)) => {
            Err(TaskStoreError::UnsupportedOlderSchemaVersion {
                found,
                path: path.display().to_string(),
            })
        }
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
    note_directory::create_table(glue)?;
    note::create_table(glue)?;
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
        schema::v5::MANAGED_THREADS_TABLE.to_string(),
        schema::v5::MANAGED_WORKTREES_TABLE.to_string(),
        schema::v5::PUSH_INSTALLATIONS_TABLE.to_string(),
        schema::v5::PUSH_VAPID_KEYS_TABLE.to_string(),
        schema::v8::MANAGED_SECTIONS_TABLE.to_string(),
        schema::v11::NOTE_DIRECTORIES_TABLE.to_string(),
        schema::v11::NOTES_TABLE.to_string(),
        LEGACY_ARCHIVED_THREADS_TABLE.to_string(),
        schema_migration::TABLE_NAME.to_string(),
    ]);
    if let Some(unexpected) = table_names.difference(&known_names).next() {
        return Err(TaskStoreError::UnexpectedSchemaTable(unexpected.clone()));
    }

    let has_managed = table_names.contains(schema::v5::MANAGED_THREADS_TABLE);
    let has_worktrees = table_names.contains(schema::v5::MANAGED_WORKTREES_TABLE);
    let has_push_installations = table_names.contains(schema::v5::PUSH_INSTALLATIONS_TABLE);
    let has_push_vapid_keys = table_names.contains(schema::v5::PUSH_VAPID_KEYS_TABLE);
    let has_managed_sections = table_names.contains(schema::v8::MANAGED_SECTIONS_TABLE);
    let has_notes_tree = table_names.contains(schema::v11::NOTE_DIRECTORIES_TABLE)
        || table_names.contains(schema::v11::NOTES_TABLE);
    let has_legacy_archived = table_names.contains(LEGACY_ARCHIVED_THREADS_TABLE);
    let has_migrations = table_names.contains(schema_migration::TABLE_NAME);

    if !has_migrations {
        return match (
            has_managed,
            has_worktrees,
            has_push_installations,
            has_push_vapid_keys,
            has_managed_sections,
            has_notes_tree,
            has_legacy_archived,
        ) {
            (false, false, false, false, false, false, false) => Ok(DetectedSchemaVersion::Fresh),
            (true, false, false, false, false, false, _) => {
                Ok(DetectedSchemaVersion::UnsupportedOlder(0))
            }
            _ => Err(TaskStoreError::IncompleteSchema),
        };
    }

    if !has_managed || has_legacy_archived {
        return Err(TaskStoreError::IncompleteSchema);
    }
    schema_migration::validate_table(glue)?;
    let version = schema_migration::current_version(glue)?;
    match version {
        version if version < OLDEST_SUPPORTED_SCHEMA_VERSION => {
            Ok(DetectedSchemaVersion::UnsupportedOlder(version))
        }
        5 => {
            schema::v5::validate(glue)?;
            Ok(DetectedSchemaVersion::V5)
        }
        6 => {
            schema::v6::validate(glue)?;
            Ok(DetectedSchemaVersion::V6)
        }
        7 => {
            schema::v7::validate(glue)?;
            Ok(DetectedSchemaVersion::V7)
        }
        8 => {
            schema::v8::validate(glue)?;
            Ok(DetectedSchemaVersion::V8)
        }
        9 => {
            schema::v9::validate(glue)?;
            Ok(DetectedSchemaVersion::V9)
        }
        10 => {
            schema::v10::validate(glue)?;
            Ok(DetectedSchemaVersion::V10)
        }
        11 => {
            schema::v11::validate(glue)?;
            Ok(DetectedSchemaVersion::V11)
        }
        LATEST_SCHEMA_VERSION => {
            schema::v12::validate(glue)?;
            Ok(DetectedSchemaVersion::V12)
        }
        version => Ok(DetectedSchemaVersion::UnsupportedNewer(version)),
    }
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDateTime;
    use gluesql::{
        core::query_builder::{Execute, col, null, table, text},
        prelude::MemoryStorage,
    };

    use super::*;
    use crate::task_store::TaskStore;

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
    }

    fn write_v5(path: &Path) {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        schema::v5::create(&mut glue, timestamp(1)).unwrap();
    }

    fn write_v6(path: &Path) {
        write_v5(path);
        v5_to_v6::migrate(path).unwrap();
    }

    pub(super) fn write_v7(path: &Path) {
        write_v6(path);
        v6_to_v7::migrate(path).unwrap();
    }

    pub(super) fn write_v8(path: &Path) {
        write_v7(path);
        v7_to_v8::migrate(path).unwrap();
    }

    pub(super) fn write_v9(path: &Path) {
        write_v8(path);
        v8_to_v9::migrate(path).unwrap();
    }

    pub(super) fn write_v10(path: &Path) {
        write_v9(path);
        v9_to_v10::migrate(path).unwrap();
    }

    pub(super) fn write_v11(path: &Path) {
        write_v10(path);
        v10_to_v11::migrate(path).unwrap();
    }

    #[test]
    fn fresh_stores_initialize_directly_as_v12() {
        let mut memory = Glue::new(MemoryStorage::default());
        initialize_memory(&mut memory).unwrap();
        assert_eq!(
            detect_schema(&mut memory).unwrap(),
            DetectedSchemaVersion::V12
        );

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("fresh.redb");
        drop(RedbStorage::new(&path).unwrap());
        migrate_to_latest(&path).unwrap();
        drop(TaskStore::redb(&path).unwrap());
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V12
        );
    }

    #[test]
    fn every_supported_schema_path_converges_on_v12() {
        type SchemaWriter = (&'static str, fn(&Path));

        let temp = tempfile::tempdir().unwrap();
        let writers: [SchemaWriter; 6] = [
            ("v5", write_v5),
            ("v6", write_v6),
            ("v7", write_v7),
            ("v8", write_v8),
            ("v9", write_v9),
            ("v10", write_v10),
        ];
        for (name, write) in writers {
            let path = temp.path().join(format!("{name}.redb"));
            write(&path);
            migrate_to_latest(&path).unwrap();
            assert_eq!(
                detect_redb_schema(&path).unwrap(),
                DetectedSchemaVersion::V12
            );
            migrate_to_latest(&path).unwrap();
        }
    }

    #[test]
    fn schemas_older_than_v5_are_refused_without_staging_or_touching_the_source() {
        type OlderSchema = (i64, &'static [&'static str]);

        let temp = tempfile::tempdir().unwrap();
        let schemas: [OlderSchema; 6] = [
            (0, &["managed_threads"]),
            (0, &["managed_threads", LEGACY_ARCHIVED_THREADS_TABLE]),
            (1, &["managed_threads"]),
            (2, &["managed_threads"]),
            (3, &["managed_threads"]),
            (4, &["managed_threads"]),
        ];
        for (index, (version, table_names)) in schemas.into_iter().enumerate() {
            let directory = temp.path().join(index.to_string());
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("caffold.redb");
            {
                let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
                for table_name in table_names {
                    table(table_name)
                        .create_table()
                        .add_column("thread_id TEXT PRIMARY KEY")
                        .execute(&mut glue)
                        .unwrap();
                }
                if version > 0 {
                    schema_migration::create_table(&mut glue).unwrap();
                    for recorded in 1..=version {
                        schema_migration::record(&mut glue, recorded, timestamp(recorded)).unwrap();
                    }
                }
            }
            let before = std::fs::read(&path).unwrap();
            let expected_path = path.display().to_string();

            assert!(matches!(
                migrate_to_latest(&path),
                Err(TaskStoreError::UnsupportedOlderSchemaVersion { found, path: reported })
                    if found == version && reported == expected_path
            ));
            assert!(matches!(
                TaskStore::redb(&path),
                Err(TaskStoreError::UnsupportedOlderSchemaVersion { found, path: reported })
                    if found == version && reported == expected_path
            ));
            assert_eq!(std::fs::read(&path).unwrap(), before);
            assert_eq!(
                std::fs::read_dir(&directory)
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name())
                    .collect::<Vec<_>>(),
                vec![path.file_name().unwrap()]
            );
        }
    }

    #[test]
    fn supported_final_validation_failures_preserve_source_and_remove_staged_database() {
        type SupportedSchema = (&'static str, fn(&Path), DetectedSchemaVersion);
        let schemas: [SupportedSchema; 6] = [
            ("v5", write_v5, DetectedSchemaVersion::V5),
            ("v6", write_v6, DetectedSchemaVersion::V6),
            ("v7", write_v7, DetectedSchemaVersion::V7),
            ("v8", write_v8, DetectedSchemaVersion::V8),
            ("v9", write_v9, DetectedSchemaVersion::V9),
            ("v10", write_v10, DetectedSchemaVersion::V10),
        ];
        for (name, write, detected) in schemas {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join(format!("{name}.redb"));
            write(&path);
            let before = std::fs::read(&path).unwrap();

            assert!(matches!(
                prepare_supported_with_validation(&path, detected, |staged_path| {
                    assert_eq!(
                        detect_redb_schema(staged_path).unwrap(),
                        DetectedSchemaVersion::V12
                    );
                    Err(TaskStoreError::IncompleteSchema)
                }),
                Err(TaskStoreError::IncompleteSchema)
            ));

            assert_eq!(detect_redb_schema(&path).unwrap(), detected);
            assert_eq!(std::fs::read(&path).unwrap(), before);
            let filenames = std::fs::read_dir(temp.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>();
            assert_eq!(filenames, vec![path.file_name().unwrap()]);
        }
    }

    #[test]
    fn v6_intermediate_failure_preserves_source_and_removes_staged_database() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v6.redb");
        write_v6(&path);
        {
            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            table(schema::v6::MANAGED_SECTIONS_TABLE)
                .insert()
                .columns(vec!["section_id", "logical_path"])
                .values(vec![vec![text("section"), text("Workspace/section")]])
                .execute(&mut glue)
                .unwrap();
            table(schema::v6::MANAGED_SECTIONS_TABLE)
                .update()
                .filter(col("section_id").eq(text("section")))
                .set("logical_path", null())
                .execute(&mut glue)
                .unwrap();
        }
        let before = std::fs::read(&path).unwrap();

        assert!(migrate_to_latest(&path).is_err());

        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V6
        );
        assert_eq!(std::fs::read(&path).unwrap(), before);
        let filenames = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(filenames, vec![path.file_name().unwrap()]);
    }

    #[test]
    fn newer_invalid_and_missing_inputs_are_rejected() {
        let temp = tempfile::tempdir().unwrap();

        let newer = temp.path().join("newer.redb");
        {
            let mut glue = Glue::new(RedbStorage::new(&newer).unwrap());
            create_latest_schema(&mut glue, timestamp(1)).unwrap();
            schema_migration::record(&mut glue, LATEST_SCHEMA_VERSION + 1, timestamp(2)).unwrap();
        }
        assert!(matches!(
            migrate_to_latest(&newer),
            Err(TaskStoreError::UnsupportedNewerSchemaVersion {
                found,
                supported: LATEST_SCHEMA_VERSION,
            }) if found == LATEST_SCHEMA_VERSION + 1
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
            migrate_to_latest(&unexpected),
            Err(TaskStoreError::UnexpectedSchemaTable(table)) if table == "unrelated"
        ));

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
