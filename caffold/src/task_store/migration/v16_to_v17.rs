use chrono::Utc;
use gluesql::{
    core::query_builder::{Execute, begin, commit, rollback, table},
    prelude::{Glue, RedbStorage},
};
use std::path::Path;

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

/// Keep the person's latest prompts on each Task in place of what its prompts
/// were once judged to have settled.
///
/// A Task gains `recent_prompts`, empty until its next prompt, and loses
/// `permission_instructions`. The entries that column held are not moved: they
/// were the prompts a judgement picked out, not the latest ones, so as recent
/// prompts they would say something the person did not. Everything is read
/// from this store: no agent is asked.
pub(super) fn migrate(path: &Path) -> Result<MigrationReport> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    begin().execute(&mut glue)?;

    match migrate_transaction(&mut glue) {
        Ok(()) => {
            commit().execute(&mut glue)?;
        }
        Err(error) => {
            let _ = rollback().execute(&mut glue);
            return Err(error);
        }
    }
    drop(glue);

    if detect_redb_schema(path)? != DetectedSchemaVersion::V17 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 6,
        rewritten_rows: 0,
    })
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<()> {
    if detect_schema(glue)? != DetectedSchemaVersion::V16 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    let threads = schema::v16::MANAGED_THREADS_TABLE;
    table(threads)
        .alter_table()
        .add_column("recent_prompts TEXT NULL")
        .execute(glue)?;
    table(threads)
        .alter_table()
        .drop_column("permission_instructions")
        .execute(glue)?;
    schema_migration::record(glue, 17, Utc::now().naive_utc())
}

#[cfg(test)]
mod tests {
    use chrono::NaiveDateTime;
    use gluesql::{
        FromGlueRow, ToGlueRow,
        core::query_builder::{Execute, col, table},
        prelude::{Glue, RedbStorage, SelectResultExt},
    };

    use super::*;

    /// Every column a v16 Task has, so the fixture writes a whole row.
    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V16ManagedThreadRow {
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

    /// Every column a v17 Task has.
    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow)]
    struct V17ManagedThreadRow {
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
        pin_position: Option<i64>,
        claude_config_dir: Option<String>,
        speed: String,
        recent_prompts: Option<String>,
    }

    fn timestamp(ms: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .naive_utc()
    }

    fn task(id: &str, permission_instructions: Option<&str>) -> V16ManagedThreadRow {
        V16ManagedThreadRow {
            thread_id: id.to_string(),
            archived_at: None,
            last_observed_recency_at: Some(timestamp(1_750_000_000_500)),
            claimed_at: timestamp(1_750_000_000_000),
            last_opened_at: Some(timestamp(1_750_000_001_000)),
            last_seen_activity_at: Some(timestamp(1_750_000_002_000)),
            last_completed_at: None,
            model: Some("opus".to_string()),
            reasoning_effort: Some("high".to_string()),
            display_name: id.to_string(),
            section_id: Some("section".to_string()),
            position_in_section: Some(1024),
            provider: "claude".to_string(),
            cwd: Some("/Users/example/project".to_string()),
            permission_mode: Some("caffold:decides".to_string()),
            permission_instructions: permission_instructions.map(str::to_string),
            pin_position: Some(2048),
            claude_config_dir: Some("/Users/example/.claude-work".to_string()),
            speed: "default".to_string(),
        }
    }

    /// The same Task as v17 keeps it: every value but the record, and no
    /// recent prompts yet.
    fn migrated(task: &V16ManagedThreadRow) -> V17ManagedThreadRow {
        let task = task.clone();
        V17ManagedThreadRow {
            thread_id: task.thread_id,
            archived_at: task.archived_at,
            last_observed_recency_at: task.last_observed_recency_at,
            claimed_at: task.claimed_at,
            last_opened_at: task.last_opened_at,
            last_seen_activity_at: task.last_seen_activity_at,
            last_completed_at: task.last_completed_at,
            model: task.model,
            reasoning_effort: task.reasoning_effort,
            display_name: task.display_name,
            section_id: task.section_id,
            position_in_section: task.position_in_section,
            provider: task.provider,
            cwd: task.cwd,
            permission_mode: task.permission_mode,
            pin_position: task.pin_position,
            claude_config_dir: task.claude_config_dir,
            speed: task.speed,
            recent_prompts: None,
        }
    }

    fn write_v16(path: &Path, tasks: &[V16ManagedThreadRow]) {
        super::super::tests::write_v16(path);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        table(schema::v16::MANAGED_THREADS_TABLE)
            .insert()
            .values_from(tasks)
            .unwrap()
            .execute(&mut glue)
            .unwrap();
    }

    fn read_tasks(path: &Path) -> Vec<V17ManagedThreadRow> {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        let mut tasks = table(schema::v17::MANAGED_THREADS_TABLE)
            .select()
            .execute(&mut glue)
            .rows_as::<V17ManagedThreadRow>()
            .unwrap();
        tasks.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        tasks
    }

    #[test]
    fn the_record_column_gives_way_to_empty_recent_prompts_and_nothing_else_changes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v16.redb");
        let tasks = [
            task("kept-none", None),
            task(
                "kept-two",
                Some("[time]\ntarget 밑은 지워도 돼\n\n[time]\npush는 하지 마"),
            ),
        ];
        write_v16(&path, &tasks);

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 1,
                unchanged_tables: 6,
                rewritten_rows: 0,
            }
        );

        assert_eq!(
            read_tasks(&path),
            tasks.iter().map(migrated).collect::<Vec<_>>()
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 17);
        assert!(
            table(schema::v17::MANAGED_THREADS_TABLE)
                .select()
                .project(vec![col("permission_instructions")])
                .execute(&mut glue)
                .is_err(),
            "the record column is gone"
        );
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v17.redb");
        write_v16(&path, &[task("kept-none", None)]);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V17
        );
    }
}
