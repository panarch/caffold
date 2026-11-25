use std::{fs, io, path::Path};

use gluesql::{
    gluesql_redb_storage::{self, REDB_STORAGE_FORMAT_VERSION},
    prelude::{Error as GlueError, Glue, RedbStorage},
};
use tempfile::NamedTempFile;
use uuid::Uuid;

use super::{
    DetectedSchemaVersion, Result, StagedDatabase, TaskStoreError, detect_redb_schema,
    initialize_redb, migrate_staged_schema,
};

/// GlueSQL 0.21 reports older formats through a StorageMsg when opening the file.
pub(super) fn migration_required(error: &TaskStoreError) -> bool {
    let TaskStoreError::Glue(GlueError::StorageMsg(message)) = error else {
        return false;
    };
    let expected = REDB_STORAGE_FORMAT_VERSION;
    (1..expected).any(|found| {
        message == &format!("[RedbStorage] migration required (found v{found}, expected v{expected}); migrate redb-storage data to the latest format before opening")
    })
}

pub(super) fn migrate(path: &Path) -> Result<()> {
    let source = fs::File::open(path)?;
    source.try_lock().map_err(io::Error::from)?;
    let staged = StagedDatabase::new(path);
    fs::copy(path, staged.path())?;

    // Another startup may have completed the upgrade before we acquired the lock.
    let (schema, upgraded_format) = match detect_redb_schema(staged.path()) {
        Ok(DetectedSchemaVersion::Fresh | DetectedSchemaVersion::V17) => return Ok(()),
        Ok(schema) => (schema, false),
        Err(error) if migration_required(&error) => {
            gluesql_redb_storage::migrate_to_latest(staged.path())?;
            (detect_redb_schema(staged.path())?, true)
        }
        Err(error) => return Err(error),
    };

    match schema {
        DetectedSchemaVersion::V17 => {}
        DetectedSchemaVersion::Fresh
        | DetectedSchemaVersion::UnsupportedOlder(_)
        | DetectedSchemaVersion::UnsupportedNewer(_) => {
            // The existing initializer creates empty stores and reports unsupported
            // versions with the configured database path.
            initialize_redb(&mut Glue::new(RedbStorage::new(staged.path())?), path)?;
        }
        version => migrate_staged_schema(&staged, version)?,
    }
    if detect_redb_schema(staged.path())? != DetectedSchemaVersion::V17 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    if upgraded_format {
        back_up_original(path)?;
    }
    staged.publish(path)
}

fn back_up_original(path: &Path) -> Result<()> {
    let backup = path.with_added_extension(format!("before-gluesql-0.21-{}.bak", Uuid::new_v4()));
    let parent = path.parent().unwrap_or(Path::new("."));
    let temp = NamedTempFile::new_in(parent)?;
    fs::copy(path, temp.path())?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(&backup)
        .map_err(|error| error.error)?;
    tracing::info!(backup = %backup.display(), "Saved the original Task store");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::migrate_task_store;
    use chrono::NaiveDateTime;
    use flate2::read::GzDecoder;
    use gluesql::prelude::{Payload, Value};
    use std::{
        os::unix::fs::{MetadataExt, PermissionsExt},
        path::PathBuf,
    };

    fn write_legacy_fixture(name: &str, path: &Path) {
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/redb");
        let input = fs::File::open(fixtures.join(format!("{name}.redb.gz"))).unwrap();
        io::copy(
            &mut GzDecoder::new(input),
            &mut fs::File::create(path).unwrap(),
        )
        .unwrap();
    }

    fn select(glue: &mut Glue<RedbStorage>, sql: &str) -> Vec<Vec<Value>> {
        let Some(Payload::Select { rows, .. }) = glue.execute(sql).unwrap().pop() else {
            panic!("expected rows for {sql}");
        };
        rows
    }

    #[test]
    fn v3_databases_keep_their_data_and_defaults_across_upgrade_and_restart() {
        let string = |s: &str| Value::Str(s.to_owned());
        let recorded = "2026-07-01T00:00:00".parse::<NaiveDateTime>().unwrap();
        for version in [16, 17] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("caffold.redb");
            write_legacy_fixture(&format!("v3-schema-{version}"), &path);
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
            let original = fs::read(&path).unwrap();
            migrate_task_store(&path).unwrap();

            let backups: Vec<PathBuf> = fs::read_dir(&dir)
                .unwrap()
                .map(|e| e.unwrap().path())
                .filter(|p| p.extension().is_some_and(|ext| ext == "bak"))
                .collect();
            assert_eq!(backups.len(), 1);
            assert_eq!(fs::read(&backups[0]).unwrap(), original);
            assert_eq!(fs::metadata(&backups[0]).unwrap().mode() & 0o777, 0o600);
            assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);

            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            let prompts = if version == 16 {
                Value::Null
            } else {
                string(r#"[{"turn_id":"turn-1","prompt":"Kept prompt"}]"#)
            };
            assert_eq!(
                select(
                    &mut glue,
                    "SELECT thread_id, display_name, section_id, recent_prompts FROM managed_threads"
                ),
                vec![vec![
                    string("task-1"),
                    string("First task"),
                    string("section-1"),
                    prompts
                ]]
            );
            assert_eq!(
                select(
                    &mut glue,
                    "SELECT section_id, logical_path, position FROM managed_sections"
                ),
                vec![vec![string("section-1"), string("/fixture"), Value::I64(0)]]
            );
            assert_eq!(
                select(
                    &mut glue,
                    "SELECT worktree_id, thread_id, worktree_path FROM managed_worktrees"
                ),
                vec![vec![
                    string("00000000-0000-4000-8000-000000000001"),
                    string("task-1"),
                    string("/fixture/worktrees/00000000-0000-4000-8000-000000000001")
                ]]
            );
            assert_eq!(
                select(&mut glue, "SELECT content, content_version FROM notes"),
                vec![vec![string("Kept note"), Value::I64(3)]]
            );
            let history = select(
                &mut glue,
                "SELECT version, applied_at FROM schema_migrations ORDER BY version",
            );
            assert_eq!(history.len(), 17);
            for (index, row) in history.iter().enumerate().take(version) {
                assert_eq!(
                    *row,
                    vec![Value::I64(index as i64 + 1), Value::Timestamp(recorded)]
                );
            }
            glue.execute(
                "INSERT INTO managed_threads (thread_id, claimed_at, display_name)
                VALUES ('new-task', TIMESTAMP '2026-07-01 00:00:00', 'New task')",
            )
            .unwrap();
            drop(glue);

            let inode = fs::metadata(&path).unwrap().ino();
            migrate_task_store(&path).unwrap();
            assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            assert_eq!(
                select(
                    &mut glue,
                    "SELECT provider, speed FROM managed_threads WHERE thread_id = 'new-task'"
                ),
                vec![vec![string("codex"), string("default")]]
            );
        }
    }

    #[test]
    fn refusing_schema_v4_preserves_the_recovered_source_and_previous_backup_for_retry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("caffold.redb");
        let backup = path.with_added_extension("before-gluesql-0.21-previous.bak");
        write_legacy_fixture("v3-schema-4-unclean", &path);
        write_legacy_fixture("v3-schema-16", &backup);
        let backup_bytes = fs::read(&backup).unwrap();

        let recovered = NamedTempFile::new().unwrap();
        fs::copy(&path, recovered.path()).unwrap();
        assert!(matches!(
            RedbStorage::new(recovered.path()),
            Err(GlueError::StorageMsg(_))
        ));
        let recovered_bytes = fs::read(recovered.path()).unwrap();
        assert!(fs::read(&path).unwrap() != recovered_bytes);

        // The first attempt opens the interrupted store. The retry opens the recovered store.
        for _ in 0..2 {
            let error = migrate_task_store(&path).unwrap_err();
            assert!(
                matches!(&error, TaskStoreError::UnsupportedOlderSchemaVersion { found: 4, path: source }
                if source == &path.display().to_string())
            );
            assert!(error.to_string().contains("v0.16.0"));
            assert_eq!(fs::read(&path).unwrap(), recovered_bytes);
            assert_eq!(fs::read(&backup).unwrap(), backup_bytes);
            assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        }

        fs::copy(&backup, &path).unwrap();
        migrate_task_store(&path).unwrap();
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V17
        );
        assert_eq!(fs::read(&backup).unwrap(), backup_bytes);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 3);
    }

    #[test]
    fn concurrent_startups_respect_the_source_lock_and_skip_a_completed_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("caffold.redb");
        write_legacy_fixture("v3-schema-17", &path);
        let before = fs::read(&path).unwrap();
        let source = fs::File::open(&path).unwrap();
        source.try_lock().unwrap();
        assert!(migrate(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        drop(source);

        migrate_task_store(&path).unwrap();
        let inode = fs::metadata(&path).unwrap().ino();
        migrate(&path).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().ino(), inode);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
    }

    #[test]
    fn a_replaced_input_uses_its_actual_format_before_saving_a_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("caffold.redb");
        write_legacy_fixture("v3-schema-16", &path);
        gluesql_redb_storage::migrate_to_latest(&path).unwrap();

        migrate(&path).unwrap();
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V17
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);

        fs::write(&path, b"invalid database").unwrap();
        assert!(matches!(migrate(&path), Err(TaskStoreError::Glue(_))));
        assert_eq!(fs::read(&path).unwrap(), b"invalid database");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }
}
