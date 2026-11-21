use chrono::Utc;
use gluesql::{
    core::{
        executor::Payload,
        query_builder::{Execute, begin, col, commit, rollback, table, text},
    },
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

/// What Caffold's own permission mode was recorded as while Jev was the only
/// decision model.
const JEV_MODE: &str = "caffold:ask-jev-first";

/// What it is recorded as for every decision model.
const DECIDES_MODE: &str = "caffold:decides";

/// Give Caffold's own permission mode the name it has for every decision model.
///
/// A Task, and a Section's remembered settings, recorded under
/// `caffold:ask-jev-first` are recorded under `caffold:decides`. No table or
/// column changes and every other value stays. Everything is read from this
/// store: no agent is asked.
pub(super) fn migrate(path: &Path) -> Result<MigrationReport> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    begin().execute(&mut glue)?;

    let rewritten_rows = match migrate_transaction(&mut glue) {
        Ok(rewritten_rows) => {
            commit().execute(&mut glue)?;
            rewritten_rows
        }
        Err(error) => {
            let _ = rollback().execute(&mut glue);
            return Err(error);
        }
    };
    drop(glue);

    if detect_redb_schema(path)? != DetectedSchemaVersion::V16 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 2,
        unchanged_tables: 5,
        rewritten_rows,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<usize> {
    if detect_schema(glue)? != DetectedSchemaVersion::V15 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    let mut rewritten_rows =
        rename_mode(glue, schema::v15::MANAGED_THREADS_TABLE, "permission_mode")?;
    rewritten_rows += rename_mode(
        glue,
        schema::v15::MANAGED_SECTIONS_TABLE,
        "last_permission_mode",
    )?;
    schema_migration::record(glue, 16, Utc::now().naive_utc())?;
    Ok(rewritten_rows)
}

fn rename_mode(glue: &mut Glue<RedbStorage>, table_name: &str, column: &str) -> Result<usize> {
    let payload = table(table_name)
        .update()
        .filter(col(column).eq(text(JEV_MODE)))
        .set(column, text(DECIDES_MODE))
        .execute(glue)?;
    match payload {
        Payload::Update(rows) => Ok(rows),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDateTime;
    use gluesql::{
        FromGlueRow, ToGlueRow,
        core::{
            query_builder::{Execute, col, table},
            row_conversion::ToGlueRow as _,
        },
        prelude::{Glue, RedbStorage, SelectResultExt},
    };

    use super::*;

    /// Every column a v15 Task has, so the fixture writes a whole row.
    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V15ManagedThreadRow {
        thread_id: String,
        archived_at: Option<NaiveDateTime>,
        last_observed_recency_at: Option<NaiveDateTime>,
        claimed_at: NaiveDateTime,
        last_opened_at: Option<NaiveDateTime>,
        last_seen_activity_at: Option<NaiveDateTime>,
        last_completed_at: Option<NaiveDateTime>,
        model: Option<String>,
        reasoning_effort: Option<String>,
        display_name: String,
        section_id: Option<String>,
        position_in_section: Option<i64>,
        provider: String,
        cwd: Option<String>,
        permission_mode: Option<String>,
        permission_instructions: Option<String>,
        pin_position: Option<i64>,
        claude_config_dir: Option<String>,
        speed: String,
    }

    /// Every column a v15 Section has.
    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V15ManagedSectionRow {
        section_id: String,
        logical_path: String,
        position: i64,
        last_model: Option<String>,
        last_reasoning_effort: Option<String>,
        last_permission_mode: Option<String>,
        last_speed: Option<String>,
        last_provider: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow)]
    struct TaskMode {
        thread_id: String,
        permission_mode: Option<String>,
    }

    fn task(id: &str, permission_mode: Option<&str>) -> V15ManagedThreadRow {
        V15ManagedThreadRow {
            thread_id: id.to_string(),
            archived_at: None,
            last_observed_recency_at: None,
            claimed_at: chrono::DateTime::from_timestamp_millis(1_750_000_000_000)
                .unwrap()
                .naive_utc(),
            last_opened_at: None,
            last_seen_activity_at: None,
            last_completed_at: None,
            model: Some("opus".to_string()),
            reasoning_effort: Some("high".to_string()),
            display_name: id.to_string(),
            section_id: None,
            position_in_section: None,
            provider: "claude".to_string(),
            cwd: Some("/Users/example/project".to_string()),
            permission_mode: permission_mode.map(str::to_string),
            permission_instructions: Some("[time]\ntarget 밑은 지워도 돼".to_string()),
            pin_position: None,
            claude_config_dir: None,
            speed: "default".to_string(),
        }
    }

    fn section(id: &str, permission_mode: Option<&str>) -> V15ManagedSectionRow {
        let remembered = permission_mode.is_some();
        V15ManagedSectionRow {
            section_id: id.to_string(),
            logical_path: format!("Workspace/{id}"),
            position: 0,
            last_model: remembered.then(|| "gpt-6".to_string()),
            last_reasoning_effort: remembered.then(|| "high".to_string()),
            last_permission_mode: permission_mode.map(str::to_string),
            last_speed: remembered.then(|| "priority".to_string()),
            last_provider: remembered.then(|| "codex".to_string()),
        }
    }

    fn write_v15(path: &Path, tasks: &[V15ManagedThreadRow], sections: &[V15ManagedSectionRow]) {
        super::super::tests::write_v15(path);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        if !tasks.is_empty() {
            table(schema::v15::MANAGED_THREADS_TABLE)
                .insert()
                .values_from(tasks)
                .unwrap()
                .execute(&mut glue)
                .unwrap();
        }
        if !sections.is_empty() {
            table(schema::v15::MANAGED_SECTIONS_TABLE)
                .insert()
                .values_from(sections)
                .unwrap()
                .execute(&mut glue)
                .unwrap();
        }
    }

    fn read_tasks(path: &Path) -> Vec<V15ManagedThreadRow> {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        let mut tasks = table(schema::v16::MANAGED_THREADS_TABLE)
            .select()
            .project(
                V15ManagedThreadRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V15ManagedThreadRow>()
            .unwrap();
        tasks.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        tasks
    }

    fn read_sections(path: &Path) -> Vec<V15ManagedSectionRow> {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        let mut sections = table(schema::v16::MANAGED_SECTIONS_TABLE)
            .select()
            .project(
                V15ManagedSectionRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V15ManagedSectionRow>()
            .unwrap();
        sections.sort_by(|left, right| left.section_id.cmp(&right.section_id));
        sections
    }

    #[test]
    fn caffold_s_own_mode_is_renamed_in_tasks_and_sections_and_nothing_else_changes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v15.redb");
        let tasks = [
            task("ask-each-time", Some("default")),
            task("jev", Some(JEV_MODE)),
            task("no-mode", None),
            task("other-jev", Some(JEV_MODE)),
        ];
        let sections = [
            section("jev", Some(JEV_MODE)),
            section("never-ran", None),
            section("plan", Some("plan")),
        ];
        write_v15(&path, &tasks, &sections);

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 5,
                rewritten_rows: 3,
            }
        );

        let renamed = |mut row: V15ManagedThreadRow| {
            if row.permission_mode.as_deref() == Some(JEV_MODE) {
                row.permission_mode = Some(DECIDES_MODE.to_string());
            }
            row
        };
        assert_eq!(
            read_tasks(&path),
            tasks.clone().map(renamed).to_vec(),
            "only the mode changes, on every Task that ran under it"
        );
        assert_eq!(
            read_sections(&path),
            vec![
                section("jev", Some(DECIDES_MODE)),
                section("never-ran", None),
                section("plan", Some("plan")),
            ]
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 16);
        let modes = table(schema::v16::MANAGED_THREADS_TABLE)
            .select()
            .filter(col("permission_mode").eq(text(JEV_MODE)))
            .project(vec![col("thread_id"), col("permission_mode")])
            .execute(&mut glue)
            .rows_as::<TaskMode>()
            .unwrap();
        assert!(modes.is_empty(), "{modes:?}");
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v16.redb");
        write_v15(&path, &[task("jev", Some(JEV_MODE))], &[]);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V16
        );
    }
}
