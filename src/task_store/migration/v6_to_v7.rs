use chrono::{NaiveDateTime, Utc};
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        query_builder::{Execute, begin, col, commit, rollback, table},
        row_conversion::ToGlueRow as _,
    },
    prelude::{Glue, RedbStorage, SelectResultExt},
};
use std::{collections::BTreeMap, path::Path};

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, detect_schema, schema};
use crate::task_store::{Result, TaskStoreError, schema_migration};

const POSITION_STEP: i64 = 1024;
const REPLACEMENT_TABLE: &str = "managed_sections_v7";

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct V6ManagedSectionRow {
    section_id: String,
    logical_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct V6ManagedThreadPlacementRow {
    archived_at: Option<NaiveDateTime>,
    last_observed_recency_at: Option<NaiveDateTime>,
    claimed_at: NaiveDateTime,
    section_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct V7ManagedSectionRow {
    section_id: String,
    logical_path: String,
    position: i64,
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

    if detect_redb_schema(path)? != DetectedSchemaVersion::V7 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(MigrationReport {
        migrated_tables: 1,
        unchanged_tables: 4,
        rewritten_rows,
    })
}

fn prepare_replacement(glue: &mut Glue<RedbStorage>) -> Result<usize> {
    if detect_schema(glue)? != DetectedSchemaVersion::V6 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    let sections = table(schema::v6::MANAGED_SECTIONS_TABLE)
        .select()
        .project(
            V6ManagedSectionRow::glue_columns()
                .iter()
                .map(|column| col(*column))
                .collect::<Vec<_>>(),
        )
        .execute(glue)
        .rows_as::<V6ManagedSectionRow>()?;
    let threads = table(schema::v6::MANAGED_THREADS_TABLE)
        .select()
        .project(
            V6ManagedThreadPlacementRow::glue_columns()
                .iter()
                .map(|column| col(*column))
                .collect::<Vec<_>>(),
        )
        .execute(glue)
        .rows_as::<V6ManagedThreadPlacementRow>()?;
    let rows = ordered_sections(sections, threads)?;

    schema::create_table(
        glue,
        REPLACEMENT_TABLE,
        schema::v7::MANAGED_SECTION_COLUMN_DEFINITIONS,
    )?;
    if !rows.is_empty() {
        table(REPLACEMENT_TABLE)
            .insert()
            .values_from(&rows)?
            .execute(glue)?;
    }
    Ok(rows.len())
}

fn ordered_sections(
    mut sections: Vec<V6ManagedSectionRow>,
    threads: Vec<V6ManagedThreadPlacementRow>,
) -> Result<Vec<V7ManagedSectionRow>> {
    let mut recency_by_section = BTreeMap::<String, NaiveDateTime>::new();
    for thread in threads
        .into_iter()
        .filter(|thread| thread.archived_at.is_none())
    {
        let Some(section_id) = thread.section_id else {
            continue;
        };
        let recency = thread.last_observed_recency_at.unwrap_or(thread.claimed_at);
        recency_by_section
            .entry(section_id)
            .and_modify(|current| *current = (*current).max(recency))
            .or_insert(recency);
    }
    sections.sort_by(|left, right| {
        match (
            recency_by_section.get(&left.section_id),
            recency_by_section.get(&right.section_id),
        ) {
            (Some(left_recency), Some(right_recency)) => right_recency.cmp(left_recency),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| left.logical_path.cmp(&right.logical_path))
        .then_with(|| left.section_id.cmp(&right.section_id))
    });
    sections
        .into_iter()
        .enumerate()
        .map(|(index, section)| {
            let index =
                i64::try_from(index).map_err(|_| TaskStoreError::InvalidRow("section_position"))?;
            let position = index
                .checked_mul(POSITION_STEP)
                .ok_or(TaskStoreError::InvalidRow("section_position"))?;
            Ok(V7ManagedSectionRow {
                section_id: section.section_id,
                logical_path: section.logical_path,
                position,
            })
        })
        .collect()
}

fn publish_replacement(glue: &mut Glue<RedbStorage>) -> Result<()> {
    table(schema::v6::MANAGED_SECTIONS_TABLE)
        .drop_table()
        .execute(glue)?;
    table(REPLACEMENT_TABLE)
        .alter_table()
        .rename_table(schema::v7::MANAGED_SECTIONS_TABLE)
        .execute(glue)?;
    schema_migration::record(glue, 7, Utc::now().naive_utc())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use gluesql::{
        core::{
            data::Value,
            query_builder::{Execute, col, null, table, text, value},
        },
        prelude::{Glue, RedbStorage, SelectResultExt},
    };

    use super::*;
    use crate::task_store::migration::{
        NavigatorMigrationSection, NavigatorMigrationSnapshot, NavigatorMigrationThread,
        NavigatorMigrationThreadClassification, write_v4_test_store,
    };

    fn timestamp(milliseconds: i64) -> NaiveDateTime {
        chrono::DateTime::from_timestamp_millis(milliseconds)
            .unwrap()
            .naive_utc()
    }

    fn write_v6(path: &Path) {
        write_v4_test_store(
            path,
            &[
                ("older".to_string(), false),
                ("older-fresh".to_string(), false),
                ("newer".to_string(), false),
                ("claimed".to_string(), false),
                ("unsectioned".to_string(), false),
                ("archived".to_string(), true),
            ],
        )
        .unwrap();
        super::super::v4_to_v5::migrate(
            path,
            &NavigatorMigrationSnapshot {
                sections: vec![
                    NavigatorMigrationSection {
                        section_id: "section-hidden-z".to_string(),
                        logical_path: "Workspace/z-hidden".to_string(),
                    },
                    NavigatorMigrationSection {
                        section_id: "section-hidden-a".to_string(),
                        logical_path: "Workspace/a-hidden".to_string(),
                    },
                    NavigatorMigrationSection {
                        section_id: "section-older".to_string(),
                        logical_path: "Workspace/older".to_string(),
                    },
                    NavigatorMigrationSection {
                        section_id: "section-newer".to_string(),
                        logical_path: "Workspace/newer".to_string(),
                    },
                    NavigatorMigrationSection {
                        section_id: "section-claimed".to_string(),
                        logical_path: "Workspace/claimed".to_string(),
                    },
                ],
                threads: vec![
                    NavigatorMigrationThread {
                        thread_id: "older".to_string(),
                        display_name: "Older".to_string(),
                        classification: NavigatorMigrationThreadClassification::ActiveSectioned,
                        section_id: Some("section-older".to_string()),
                        position_in_section: Some(0),
                    },
                    NavigatorMigrationThread {
                        thread_id: "older-fresh".to_string(),
                        display_name: "Older fresh".to_string(),
                        classification: NavigatorMigrationThreadClassification::ActiveSectioned,
                        section_id: Some("section-older".to_string()),
                        position_in_section: Some(1),
                    },
                    NavigatorMigrationThread {
                        thread_id: "newer".to_string(),
                        display_name: "Newer".to_string(),
                        classification: NavigatorMigrationThreadClassification::ActiveSectioned,
                        section_id: Some("section-newer".to_string()),
                        position_in_section: Some(0),
                    },
                    NavigatorMigrationThread {
                        thread_id: "claimed".to_string(),
                        display_name: "Claimed".to_string(),
                        classification: NavigatorMigrationThreadClassification::ActiveSectioned,
                        section_id: Some("section-claimed".to_string()),
                        position_in_section: Some(0),
                    },
                    NavigatorMigrationThread {
                        thread_id: "unsectioned".to_string(),
                        display_name: "Unsectioned".to_string(),
                        classification: NavigatorMigrationThreadClassification::ActiveUnsectioned,
                        section_id: None,
                        position_in_section: None,
                    },
                    NavigatorMigrationThread {
                        thread_id: "archived".to_string(),
                        display_name: "Archived".to_string(),
                        classification: NavigatorMigrationThreadClassification::LocallyArchived,
                        section_id: None,
                        position_in_section: None,
                    },
                ],
            },
        )
        .unwrap();
        super::super::v5_to_v6::migrate(path).unwrap();
        let mut glue = Glue::new(RedbStorage::new(path).unwrap());
        for (thread_id, recency) in [("older", 1_000), ("older-fresh", 1_500), ("newer", 2_000)] {
            table(schema::v6::MANAGED_THREADS_TABLE)
                .update()
                .filter(col("thread_id").eq(text(thread_id)))
                .set(
                    "last_observed_recency_at",
                    value(Value::Timestamp(timestamp(recency))),
                )
                .execute(&mut glue)
                .unwrap();
        }
        table(schema::v6::MANAGED_THREADS_TABLE)
            .update()
            .filter(col("thread_id").eq(text("claimed")))
            .set("last_observed_recency_at", null())
            .set("claimed_at", value(Value::Timestamp(timestamp(2_500))))
            .execute(&mut glue)
            .unwrap();
        table(schema::v6::MANAGED_THREADS_TABLE)
            .update()
            .filter(col("thread_id").eq(text("archived")))
            .set("section_id", text("section-newer"))
            .set(
                "last_observed_recency_at",
                value(Value::Timestamp(timestamp(9_999))),
            )
            .execute(&mut glue)
            .unwrap();
    }

    #[test]
    fn preserves_current_visible_order_and_appends_hidden_sections() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v6.redb");
        write_v6(&path);

        let report = migrate(&path).unwrap();

        assert_eq!(report.migrated_tables, 1);
        assert_eq!(report.unchanged_tables, 4);
        assert_eq!(report.rewritten_rows, 5);
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        let rows = table(schema::v7::MANAGED_SECTIONS_TABLE)
            .select()
            .project(
                V7ManagedSectionRow::glue_columns()
                    .iter()
                    .map(|column| col(*column))
                    .collect::<Vec<_>>(),
            )
            .execute(&mut glue)
            .rows_as::<V7ManagedSectionRow>()
            .unwrap();
        let mut rows = rows;
        rows.sort_by_key(|row| row.position);
        assert_eq!(
            rows.iter()
                .map(|row| (row.section_id.as_str(), row.position))
                .collect::<Vec<_>>(),
            [
                ("section-claimed", 0),
                ("section-newer", POSITION_STEP),
                ("section-older", POSITION_STEP * 2),
                ("section-hidden-a", POSITION_STEP * 3),
                ("section-hidden-z", POSITION_STEP * 4),
            ]
        );
    }

    #[test]
    fn rejects_the_wrong_input_version_without_writes() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v7.redb");
        write_v6(&path);
        migrate(&path).unwrap();
        let before = std::fs::read(&path).unwrap();

        assert!(matches!(
            migrate(&path),
            Err(TaskStoreError::IncompleteSchema)
        ));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V7
        );
    }
}
