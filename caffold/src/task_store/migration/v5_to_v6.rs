use chrono::{NaiveDateTime, Utc};
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        query_builder::{Execute, begin, col, commit, rollback, table},
        row_conversion::ToGlueRow as _,
    },
    prelude::{Glue, RedbStorage, SelectResultExt},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

const REPLACEMENT_TABLE: &str = "managed_worktrees_v6";

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct V5ManagedWorktreeRow {
    worktree_id: String,
    thread_id: Option<String>,
    repository_git_dir: String,
    worktree_path: String,
    branch_name: String,
    head_sha: String,
    state: String,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct V6ManagedWorktreeRow {
    worktree_id: String,
    thread_id: Option<String>,
    repository_git_dir: String,
    worktree_path: String,
    state: String,
    anchor_branch: Option<String>,
    anchor_head_sha: Option<String>,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

pub(super) fn migrate(path: &Path) -> Result<MigrationReport> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    begin().execute(&mut glue)?;

    let rewritten_rows = match prepare_replacement(&mut glue) {
        Ok(rewritten_rows) => {
            commit().execute(&mut glue)?;
            rewritten_rows
        }
        Err(error) => {
            let _ = rollback().execute(&mut glue);
            return Err(error);
        }
    };
    begin().execute(&mut glue)?;
    if let Err(error) = publish_replacement(&mut glue) {
        let _ = rollback().execute(&mut glue);
        return Err(error);
    }
    commit().execute(&mut glue)?;
    drop(glue);

    if detect_redb_schema(path)? != DetectedSchemaVersion::V6 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 4,
        rewritten_rows,
    })
}

fn prepare_replacement(glue: &mut Glue<RedbStorage>) -> Result<usize> {
    if detect_schema(glue)? != DetectedSchemaVersion::V5 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    let legacy_rows = table(schema::v5::MANAGED_WORKTREES_TABLE)
        .select()
        .project(
            V5ManagedWorktreeRow::glue_columns()
                .iter()
                .map(|column| col(*column))
                .collect::<Vec<_>>(),
        )
        .execute(glue)
        .rows_as::<V5ManagedWorktreeRow>()?;
    let rows = legacy_rows
        .into_iter()
        .map(migrate_row)
        .collect::<Result<Vec<_>>>()?;

    schema::create_table(
        glue,
        REPLACEMENT_TABLE,
        schema::v6::MANAGED_WORKTREE_COLUMN_DEFINITIONS,
    )?;
    if !rows.is_empty() {
        table(REPLACEMENT_TABLE)
            .insert()
            .values_from(&rows)?
            .execute(glue)?;
    }
    Ok(rows.len())
}

fn publish_replacement(glue: &mut Glue<RedbStorage>) -> Result<()> {
    table(schema::v5::MANAGED_WORKTREES_TABLE)
        .drop_table()
        .execute(glue)?;
    table(REPLACEMENT_TABLE)
        .alter_table()
        .rename_table(schema::v6::MANAGED_WORKTREES_TABLE)
        .execute(glue)?;
    schema_migration::record(glue, 6, Utc::now().naive_utc())?;
    Ok(())
}

fn migrate_row(row: V5ManagedWorktreeRow) -> Result<V6ManagedWorktreeRow> {
    let (anchor_branch, anchor_head_sha) = match row.state.as_str() {
        "ready" if row.thread_id.is_some() => (None, None),
        "creating"
        | "isolating_clean"
        | "handing_off"
        | "transferring"
        | "removing"
        | "archived"
        | "restoring"
        | "clean_recovery_required"
        | "handoff_recovery_required"
        | "recovery_required" => (Some(row.branch_name), Some(row.head_sha)),
        state => {
            return Err(TaskStoreError::InvalidManagedWorktreeState(
                state.to_string(),
            ));
        }
    };
    Ok(V6ManagedWorktreeRow {
        worktree_id: row.worktree_id,
        thread_id: row.thread_id,
        repository_git_dir: row.repository_git_dir,
        worktree_path: row.worktree_path,
        state: row.state,
        anchor_branch,
        anchor_head_sha,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

#[cfg(test)]
mod tests {
    use gluesql::core::query_builder::table;

    use super::*;
    use crate::task_store::TaskStore;

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
    }

    fn row(id: &str, state: &str, thread_id: Option<&str>) -> V5ManagedWorktreeRow {
        V5ManagedWorktreeRow {
            worktree_id: id.to_string(),
            thread_id: thread_id.map(str::to_string),
            repository_git_dir: format!("/repositories/{id}/.git"),
            worktree_path: format!("/managed/{id}"),
            branch_name: format!("review/{id}"),
            head_sha: format!("head-{id}"),
            state: state.to_string(),
            created_at: timestamp(100),
            updated_at: timestamp(200),
        }
    }

    fn write_v5(path: &Path, rows: &[V5ManagedWorktreeRow]) {
        {
            let mut glue = Glue::new(RedbStorage::new(path).unwrap());
            schema::v1::create(&mut glue, timestamp(1)).unwrap();
        }
        super::super::v1_to_v2::migrate(path).unwrap();
        super::super::v2_to_v3::migrate(path).unwrap();
        super::super::v3_to_v4::migrate(path).unwrap();
        super::super::v4_to_v5::migrate(
            path,
            &super::super::NavigatorMigrationSnapshot {
                sections: Vec::new(),
                threads: Vec::new(),
            },
        )
        .unwrap();
        if !rows.is_empty() {
            let mut glue = Glue::new(RedbStorage::new(path).unwrap());
            table(schema::v5::MANAGED_WORKTREES_TABLE)
                .insert()
                .values_from(rows)
                .unwrap()
                .execute(&mut glue)
                .unwrap();
        }
    }

    #[test]
    fn ready_rows_drop_the_observation_and_every_operation_state_keeps_an_anchor() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v5.redb");
        let states = [
            "creating",
            "ready",
            "isolating_clean",
            "handing_off",
            "transferring",
            "removing",
            "archived",
            "restoring",
            "clean_recovery_required",
            "handoff_recovery_required",
            "recovery_required",
        ];
        let rows = states
            .iter()
            .map(|state| {
                row(
                    state,
                    state,
                    (*state != "creating")
                        .then(|| format!("thread-{state}"))
                        .as_deref(),
                )
            })
            .collect::<Vec<_>>();
        write_v5(&path, &rows);

        let report = migrate(&path).unwrap();
        assert_eq!(
            report,
            MigrationReport {
                migrated_tables: 1,
                unchanged_tables: 4,
                rewritten_rows: states.len(),
            }
        );
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V6
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 6);
        let mut migrated = table(schema::v6::MANAGED_WORKTREES_TABLE)
            .select()
            .project(
                V6ManagedWorktreeRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V6ManagedWorktreeRow>()
            .unwrap();
        migrated.sort_by(|left, right| left.worktree_id.cmp(&right.worktree_id));
        for state_name in states {
            let worktree = migrated
                .iter()
                .find(|worktree| worktree.worktree_id == state_name)
                .unwrap();
            assert_eq!(worktree.worktree_id, state_name);
            assert_eq!(
                worktree.thread_id.as_deref(),
                (state_name != "creating")
                    .then(|| format!("thread-{state_name}"))
                    .as_deref()
            );
            assert_eq!(
                worktree.repository_git_dir,
                format!("/repositories/{state_name}/.git")
            );
            assert_eq!(worktree.worktree_path, format!("/managed/{state_name}"));
            assert_eq!(worktree.state, state_name);
            assert_eq!(
                worktree.anchor_branch.as_deref(),
                (state_name != "ready")
                    .then(|| format!("review/{state_name}"))
                    .as_deref()
            );
            assert_eq!(
                worktree.anchor_head_sha.as_deref(),
                (state_name != "ready")
                    .then(|| format!("head-{state_name}"))
                    .as_deref()
            );
            assert_eq!(worktree.created_at, timestamp(100));
            assert_eq!(worktree.updated_at, timestamp(200));
        }
    }

    #[test]
    fn invalid_v5_lifecycle_rows_roll_back_without_publishing_a_partial_schema() {
        for (name, invalid) in [
            ("ready-unbound", row("invalid", "ready", None)),
            ("unknown", row("invalid", "unknown", Some("thread"))),
        ] {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join(format!("{name}.redb"));
            write_v5(&path, std::slice::from_ref(&invalid));

            assert!(matches!(
                migrate(&path),
                Err(TaskStoreError::InvalidManagedWorktreeState(_))
            ));
            assert_eq!(
                detect_redb_schema(&path).unwrap(),
                DetectedSchemaVersion::V5
            );

            let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
            let rows = table(schema::v5::MANAGED_WORKTREES_TABLE)
                .select()
                .project(
                    V5ManagedWorktreeRow::glue_columns()
                        .iter()
                        .map(|column| col(*column))
                        .collect::<Vec<_>>(),
                )
                .execute(&mut glue)
                .rows_as::<V5ManagedWorktreeRow>()
                .unwrap();
            assert_eq!(rows, vec![invalid]);
        }
    }

    #[test]
    fn rejects_the_wrong_source_version_without_changing_it() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v6.redb");
        write_v5(&path, &[]);
        migrate(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V6
        );
    }

    #[test]
    fn startup_stages_populated_v5_replacement_and_leaves_invalid_sources_untouched() {
        let valid_temp = tempfile::tempdir().unwrap();
        let valid_path = valid_temp.path().join("valid.redb");
        write_v5(
            &valid_path,
            &[
                row("ready", "ready", Some("thread-ready")),
                row("archived", "archived", Some("thread-archived")),
            ],
        );

        assert!(matches!(
            super::super::prepare_to_latest(&valid_path).unwrap(),
            super::super::PreparedTaskStoreMigration::Ready
        ));
        let valid_store = TaskStore::redb(&valid_path).unwrap();
        assert_eq!(valid_store.managed_worktrees().unwrap().len(), 2);

        let invalid_temp = tempfile::tempdir().unwrap();
        let invalid_path = invalid_temp.path().join("invalid.redb");
        let invalid = row("invalid", "unknown", Some("thread-invalid"));
        write_v5(&invalid_path, std::slice::from_ref(&invalid));
        let source_before = std::fs::read(&invalid_path).unwrap();

        assert!(matches!(
            super::super::prepare_to_latest(&invalid_path),
            Err(TaskStoreError::InvalidManagedWorktreeState(_))
        ));
        assert_eq!(
            detect_redb_schema(&invalid_path).unwrap(),
            DetectedSchemaVersion::V5
        );
        assert_eq!(std::fs::read(&invalid_path).unwrap(), source_before);
        assert_eq!(
            std::fs::read_dir(invalid_temp.path()).unwrap().count(),
            1,
            "failed staged migration must clean up its disposable database"
        );
    }
}
