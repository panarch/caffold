use chrono::Utc;
use gluesql::{
    FromGlueRow,
    core::{
        executor::Payload,
        query_builder::{Execute, begin, col, commit, null, rollback, table, text},
    },
    prelude::{Glue, RedbStorage, SelectResultExt},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

/// Keep a Task's speed under the name its agent uses, and say which agent a
/// Section's remembered settings belong to.
///
/// A fast Task becomes Codex's `priority` or Claude's `fast`; every other Task
/// runs at `default`. A Section names the agent of the Tasks that use its
/// remembered model; when those Tasks do not name exactly one agent, the
/// Section forgets its settings and learns them again from its next turn.
/// Everything is read from this store: no agent is asked.
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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V15 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 2,
        unchanged_tables: 5,
        rewritten_rows,
    })
}

#[derive(FromGlueRow)]
struct V14TaskModel {
    model: String,
    provider: String,
}

#[derive(FromGlueRow)]
struct V14RememberedSection {
    section_id: String,
    last_model: Option<String>,
    last_fast_mode: bool,
}

fn migrate_transaction(glue: &mut Glue<RedbStorage>) -> Result<usize> {
    if detect_schema(glue)? != DetectedSchemaVersion::V14 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    let mut rewritten_rows = migrate_task_speeds(glue)?;
    rewritten_rows += migrate_section_settings(glue)?;
    schema_migration::record(glue, 15, Utc::now().naive_utc())?;
    Ok(rewritten_rows)
}

fn migrate_task_speeds(glue: &mut Glue<RedbStorage>) -> Result<usize> {
    let threads = schema::v14::MANAGED_THREADS_TABLE;
    table(threads)
        .alter_table()
        .add_column("speed TEXT NOT NULL DEFAULT 'default'")
        .execute(glue)?;
    let mut rewritten_rows = 0;
    for provider in ["codex", "claude"] {
        let payload = table(threads)
            .update()
            .filter(col("fast_mode").eq(true))
            .filter(col("provider").eq(text(provider)))
            .set("speed", text(fast_speed(provider)))
            .execute(glue)?;
        rewritten_rows += updated_rows(payload)?;
    }
    table(threads)
        .alter_table()
        .drop_column("fast_mode")
        .execute(glue)?;
    Ok(rewritten_rows)
}

fn migrate_section_settings(glue: &mut Glue<RedbStorage>) -> Result<usize> {
    let sections = schema::v14::MANAGED_SECTIONS_TABLE;
    let providers_by_model = providers_by_model(glue)?;
    let remembered = table(sections)
        .select()
        .filter(col("last_fast_mode").is_not_null())
        .project(vec![
            col("section_id"),
            col("last_model"),
            col("last_fast_mode"),
        ])
        .execute(glue)
        .rows_as::<V14RememberedSection>()?;

    for column in ["last_speed TEXT NULL", "last_provider TEXT NULL"] {
        table(sections)
            .alter_table()
            .add_column(column)
            .execute(glue)?;
    }
    let mut rewritten_rows = 0;
    for section in remembered {
        let provider = section
            .last_model
            .as_ref()
            .and_then(|model| providers_by_model.get(model))
            .filter(|providers| providers.len() == 1)
            .and_then(|providers| providers.first());
        let update = table(sections)
            .update()
            .filter(col("section_id").eq(text(section.section_id)));
        let payload = match provider {
            Some(provider) => {
                let speed = if section.last_fast_mode {
                    fast_speed(provider)
                } else {
                    "default"
                };
                update
                    .set("last_speed", text(speed))
                    .set("last_provider", text(provider.clone()))
                    .execute(glue)?
            }
            None => update
                .set("last_model", null())
                .set("last_reasoning_effort", null())
                .set("last_permission_mode", null())
                .execute(glue)?,
        };
        rewritten_rows += updated_rows(payload)?;
    }
    table(sections)
        .alter_table()
        .drop_column("last_fast_mode")
        .execute(glue)?;
    Ok(rewritten_rows)
}

/// Which agents run Tasks under each model name, archived Tasks included.
fn providers_by_model(glue: &mut Glue<RedbStorage>) -> Result<BTreeMap<String, BTreeSet<String>>> {
    let tasks = table(schema::v14::MANAGED_THREADS_TABLE)
        .select()
        .filter(col("model").is_not_null())
        .project(vec![col("model"), col("provider")])
        .execute(glue)
        .rows_as::<V14TaskModel>()?;
    let mut providers = BTreeMap::<String, BTreeSet<String>>::new();
    for task in tasks {
        providers
            .entry(task.model)
            .or_default()
            .insert(task.provider);
    }
    Ok(providers)
}

/// The name each agent gave its faster speed when fast was one switch.
fn fast_speed(provider: &str) -> &'static str {
    match provider {
        "codex" => "priority",
        "claude" => "fast",
        _ => "default",
    }
}

fn updated_rows(payload: Payload) -> Result<usize> {
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

    /// Every column a v14 Task has, so the fixture writes a whole row.
    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V14ManagedThreadRow {
        thread_id: String,
        archived_at: Option<NaiveDateTime>,
        last_observed_recency_at: Option<NaiveDateTime>,
        claimed_at: NaiveDateTime,
        last_opened_at: Option<NaiveDateTime>,
        last_seen_activity_at: Option<NaiveDateTime>,
        last_completed_at: Option<NaiveDateTime>,
        model: Option<String>,
        reasoning_effort: Option<String>,
        fast_mode: bool,
        display_name: String,
        section_id: Option<String>,
        position_in_section: Option<i64>,
        provider: String,
        cwd: Option<String>,
        permission_mode: Option<String>,
        permission_instructions: Option<String>,
        pin_position: Option<i64>,
        claude_config_dir: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V14ManagedSectionRow {
        section_id: String,
        logical_path: String,
        position: i64,
        last_model: Option<String>,
        last_reasoning_effort: Option<String>,
        last_fast_mode: Option<bool>,
        last_permission_mode: Option<String>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow)]
    struct V15TaskSpeed {
        thread_id: String,
        speed: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
    struct V15ManagedSectionRow {
        section_id: String,
        last_model: Option<String>,
        last_reasoning_effort: Option<String>,
        last_permission_mode: Option<String>,
        last_speed: Option<String>,
        last_provider: Option<String>,
    }

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
    }

    fn task(id: &str, provider: &str, model: Option<&str>, fast_mode: bool) -> V14ManagedThreadRow {
        let runs_in_a_directory = provider != "codex";
        V14ManagedThreadRow {
            thread_id: id.to_string(),
            archived_at: None,
            last_observed_recency_at: None,
            claimed_at: timestamp(1_750_000_000_000),
            last_opened_at: None,
            last_seen_activity_at: None,
            last_completed_at: None,
            model: model.map(str::to_string),
            reasoning_effort: None,
            fast_mode,
            display_name: id.to_string(),
            section_id: None,
            position_in_section: None,
            provider: provider.to_string(),
            cwd: runs_in_a_directory.then(|| "/Users/example/project".to_string()),
            permission_mode: None,
            permission_instructions: None,
            pin_position: None,
            claude_config_dir: None,
        }
    }

    fn section(id: &str, model: Option<&str>, fast_mode: Option<bool>) -> V14ManagedSectionRow {
        let remembered = fast_mode.is_some();
        V14ManagedSectionRow {
            section_id: id.to_string(),
            logical_path: format!("Workspace/{id}"),
            position: 0,
            last_model: model.map(str::to_string),
            last_reasoning_effort: remembered.then(|| "high".to_string()),
            last_fast_mode: fast_mode,
            last_permission_mode: remembered.then(|| "default".to_string()),
        }
    }

    fn write_v14(path: &Path, tasks: &[V14ManagedThreadRow], sections: &[V14ManagedSectionRow]) {
        super::super::tests::write_v14(path);
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        if !tasks.is_empty() {
            table(schema::v14::MANAGED_THREADS_TABLE)
                .insert()
                .values_from(tasks)
                .unwrap()
                .execute(&mut glue)
                .unwrap();
        }
        if !sections.is_empty() {
            table(schema::v14::MANAGED_SECTIONS_TABLE)
                .insert()
                .values_from(sections)
                .unwrap()
                .execute(&mut glue)
                .unwrap();
        }
    }

    fn read_speeds(path: &Path) -> Vec<V15TaskSpeed> {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        let mut speeds = table(schema::v15::MANAGED_THREADS_TABLE)
            .select()
            .project(vec![col("thread_id"), col("speed")])
            .execute(&mut glue)
            .rows_as::<V15TaskSpeed>()
            .unwrap();
        speeds.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        speeds
    }

    fn read_sections(path: &Path) -> Vec<V15ManagedSectionRow> {
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        let mut sections = table(schema::v15::MANAGED_SECTIONS_TABLE)
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

    fn speed(thread_id: &str, speed: &str) -> V15TaskSpeed {
        V15TaskSpeed {
            thread_id: thread_id.to_string(),
            speed: speed.to_string(),
        }
    }

    fn remembered(id: &str, model: &str, speed: &str, provider: &str) -> V15ManagedSectionRow {
        V15ManagedSectionRow {
            section_id: id.to_string(),
            last_model: Some(model.to_string()),
            last_reasoning_effort: Some("high".to_string()),
            last_permission_mode: Some("default".to_string()),
            last_speed: Some(speed.to_string()),
            last_provider: Some(provider.to_string()),
        }
    }

    fn forgotten(id: &str) -> V15ManagedSectionRow {
        V15ManagedSectionRow {
            section_id: id.to_string(),
            last_model: None,
            last_reasoning_effort: None,
            last_permission_mode: None,
            last_speed: None,
            last_provider: None,
        }
    }

    #[test]
    fn a_fast_task_keeps_its_speed_under_its_agents_name() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v14.redb");
        write_v14(
            &path,
            &[
                task("antigravity-normal", "antigravity", None, false),
                task("claude-fast", "claude", Some("opus"), true),
                task("claude-normal", "claude", Some("opus"), false),
                task("codex-fast", "codex", Some("gpt-6"), true),
                task("codex-normal", "codex", Some("gpt-6"), false),
                task("grok-marked-fast", "grok", Some("grok-4"), true),
            ],
            &[],
        );

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 5,
                rewritten_rows: 2,
            }
        );

        assert_eq!(
            read_speeds(&path),
            vec![
                speed("antigravity-normal", "default"),
                speed("claude-fast", "fast"),
                speed("claude-normal", "default"),
                speed("codex-fast", "priority"),
                speed("codex-normal", "default"),
                speed("grok-marked-fast", "default"),
            ]
        );
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 15);
    }

    #[test]
    fn a_section_names_the_agent_of_the_tasks_using_its_model_or_forgets_its_settings() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v14.redb");
        let mut archived_codex = task("archived-codex", "codex", Some("gpt-old"), false);
        archived_codex.archived_at = Some(timestamp(1_750_000_100_000));
        write_v14(
            &path,
            &[
                task("claude", "claude", Some("opus"), false),
                task("codex", "codex", Some("gpt-6"), true),
                archived_codex,
                task("grok", "grok", Some("grok-4"), false),
                task("shared-codex", "codex", Some("shared"), false),
                task("shared-grok", "grok", Some("shared"), false),
            ],
            &[
                section("claude-normal", Some("opus"), Some(false)),
                section("claude-fast", Some("opus"), Some(true)),
                section("codex-fast", Some("gpt-6"), Some(true)),
                section("codex-archived-model", Some("gpt-old"), Some(false)),
                section("grok-marked-fast", Some("grok-4"), Some(true)),
                section("model-two-agents-use", Some("shared"), Some(true)),
                section("model-no-task-uses", Some("gone"), Some(false)),
                section("no-model", None, Some(false)),
                section("never-ran", None, None),
            ],
        );

        assert_eq!(
            migrate(&path).unwrap(),
            MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 5,
                rewritten_rows: 9,
            }
        );

        assert_eq!(
            read_sections(&path),
            vec![
                remembered("claude-fast", "opus", "fast", "claude"),
                remembered("claude-normal", "opus", "default", "claude"),
                remembered("codex-archived-model", "gpt-old", "default", "codex"),
                remembered("codex-fast", "gpt-6", "priority", "codex"),
                remembered("grok-marked-fast", "grok-4", "default", "grok"),
                forgotten("model-no-task-uses"),
                forgotten("model-two-agents-use"),
                forgotten("never-ran"),
                forgotten("no-model"),
            ]
        );
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v15.redb");
        write_v14(&path, &[], &[]);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V15
        );
    }
}
