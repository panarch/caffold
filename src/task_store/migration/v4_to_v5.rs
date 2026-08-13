use chrono::{NaiveDateTime, Utc};
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::Value,
        query_builder::{Execute, begin, col, commit, null, rollback, table, text, value},
        row_conversion::ToGlueRow as _,
    },
    prelude::{Glue, RedbStorage, SelectResultExt},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

use super::{
    DetectedSchemaVersion, ManagedThreadMigrationInventory, MigrationReport,
    NavigatorMigrationSnapshot, NavigatorMigrationThreadClassification, detect_redb_schema,
    detect_schema, schema,
};
use crate::task_store::{Result, TaskStoreError, schema_migration};

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct V4ManagedThreadRow {
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
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct V5ManagedThreadUpdate {
    thread_id: String,
    display_name: String,
    section_id: Option<String>,
    position_in_section: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, ToGlueRow)]
struct V5ManagedSectionRow {
    section_id: String,
    logical_path: String,
}

pub(super) fn migrate(
    path: &Path,
    snapshot: &NavigatorMigrationSnapshot,
) -> Result<MigrationReport> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    begin().execute(&mut glue)?;

    let result = migrate_transaction(&mut glue, snapshot);
    match result {
        Ok(rewritten_rows) => {
            commit().execute(&mut glue)?;
            drop(glue);
            if detect_redb_schema(path)? != DetectedSchemaVersion::V5 {
                return Err(TaskStoreError::IncompleteSchema);
            }
            Ok(MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 3,
                rewritten_rows,
            })
        }
        Err(error) => {
            let _ = rollback().execute(&mut glue);
            Err(error)
        }
    }
}

pub(super) fn inventory(path: &Path) -> Result<Vec<ManagedThreadMigrationInventory>> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    begin().execute(&mut glue)?;
    let result = (|| {
        if detect_schema(&mut glue)? != DetectedSchemaVersion::V4 {
            return Err(TaskStoreError::IncompleteSchema);
        }
        let mut inventory = read_v4_threads(&mut glue)?
            .into_iter()
            .map(|row| ManagedThreadMigrationInventory {
                thread_id: row.thread_id,
                archived: row.archived_at.is_some(),
            })
            .collect::<Vec<_>>();
        inventory.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        Ok(inventory)
    })();
    let rollback_result = rollback().execute(&mut glue);
    match (result, rollback_result) {
        (Ok(inventory), Ok(_)) => Ok(inventory),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

fn migrate_transaction(
    glue: &mut Glue<RedbStorage>,
    snapshot: &NavigatorMigrationSnapshot,
) -> Result<usize> {
    if detect_schema(glue)? != DetectedSchemaVersion::V4 {
        return Err(TaskStoreError::IncompleteSchema);
    }

    let legacy_rows = read_v4_threads(glue)?;
    let (sections, threads) = validate_snapshot(&legacy_rows, snapshot)?;

    table(schema::v4::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("display_name TEXT")
        .execute(glue)?;
    table(schema::v4::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("section_id TEXT NULL")
        .execute(glue)?;
    table(schema::v4::MANAGED_THREADS_TABLE)
        .alter_table()
        .add_column("position_in_section INTEGER NULL")
        .execute(glue)?;
    schema::create_table(
        glue,
        schema::v5::MANAGED_SECTIONS_TABLE,
        schema::v5::MANAGED_SECTION_COLUMN_DEFINITIONS,
    )?;

    if !sections.is_empty() {
        table(schema::v5::MANAGED_SECTIONS_TABLE)
            .insert()
            .values_from(&sections)?
            .execute(glue)?;
    }
    for thread in &threads {
        table(schema::v5::MANAGED_THREADS_TABLE)
            .update()
            .filter(col("thread_id").eq(text(thread.thread_id.clone())))
            .set("display_name", text(thread.display_name.clone()))
            .set(
                "section_id",
                thread.section_id.clone().map(text).unwrap_or_else(null),
            )
            .set(
                "position_in_section",
                thread
                    .position_in_section
                    .map(|position| value(Value::I64(position)))
                    .unwrap_or_else(null),
            )
            .execute(glue)?;
    }
    schema_migration::record(glue, 5, Utc::now().naive_utc())?;
    Ok(threads.len())
}

fn read_v4_threads(glue: &mut Glue<RedbStorage>) -> Result<Vec<V4ManagedThreadRow>> {
    table(schema::v4::MANAGED_THREADS_TABLE)
        .select()
        .project(
            V4ManagedThreadRow::glue_columns()
                .iter()
                .map(|column| col(*column))
                .collect::<Vec<_>>(),
        )
        .execute(glue)
        .rows_as::<V4ManagedThreadRow>()
        .map_err(Into::into)
}

fn validate_snapshot(
    legacy_rows: &[V4ManagedThreadRow],
    snapshot: &NavigatorMigrationSnapshot,
) -> Result<(Vec<V5ManagedSectionRow>, Vec<V5ManagedThreadUpdate>)> {
    let mut section_ids = BTreeSet::new();
    let mut sections = Vec::with_capacity(snapshot.sections.len());
    for section in &snapshot.sections {
        if section.section_id.trim().is_empty() {
            return Err(TaskStoreError::InvalidMigrationSnapshot("invalid section"));
        }
        if !section_ids.insert(section.section_id.as_str()) {
            return Err(TaskStoreError::InvalidMigrationSnapshot(
                "duplicate section",
            ));
        }
        sections.push(V5ManagedSectionRow {
            section_id: section.section_id.clone(),
            logical_path: section.logical_path.clone(),
        });
    }

    let snapshots_by_id = snapshot
        .threads
        .iter()
        .map(|thread| (thread.thread_id.as_str(), thread))
        .collect::<BTreeMap<_, _>>();
    if snapshots_by_id.len() != snapshot.threads.len() {
        return Err(TaskStoreError::InvalidMigrationSnapshot("duplicate thread"));
    }
    let legacy_ids = legacy_rows
        .iter()
        .map(|row| row.thread_id.as_str())
        .collect::<BTreeSet<_>>();
    if legacy_ids != snapshots_by_id.keys().copied().collect() {
        return Err(TaskStoreError::InvalidMigrationSnapshot(
            "thread inventory mismatch",
        ));
    }

    let mut positions = BTreeMap::<&str, Vec<u64>>::new();
    let mut threads = Vec::with_capacity(legacy_rows.len());
    for legacy in legacy_rows {
        let snapshot = snapshots_by_id[legacy.thread_id.as_str()];
        if snapshot.display_name.trim().is_empty() {
            return Err(TaskStoreError::InvalidMigrationSnapshot(
                "empty display name",
            ));
        }
        let placement_is_paired =
            snapshot.section_id.is_some() == snapshot.position_in_section.is_some();
        let classification_is_valid = match snapshot.classification {
            NavigatorMigrationThreadClassification::ActiveSectioned => {
                legacy.archived_at.is_none() && snapshot.section_id.is_some()
            }
            NavigatorMigrationThreadClassification::ActiveUnsectioned
            | NavigatorMigrationThreadClassification::CodexArchived
            | NavigatorMigrationThreadClassification::Missing => {
                legacy.archived_at.is_none() && snapshot.section_id.is_none()
            }
            NavigatorMigrationThreadClassification::LocallyArchived => {
                legacy.archived_at.is_some() && snapshot.section_id.is_none()
            }
        };
        if !placement_is_paired || !classification_is_valid {
            return Err(TaskStoreError::InvalidMigrationSnapshot(
                "invalid thread placement",
            ));
        }
        if let (Some(section_id), Some(position)) =
            (snapshot.section_id.as_deref(), snapshot.position_in_section)
        {
            if !section_ids.contains(section_id) {
                return Err(TaskStoreError::InvalidMigrationSnapshot(
                    "unknown thread section",
                ));
            }
            positions.entry(section_id).or_default().push(position);
        }
        threads.push(V5ManagedThreadUpdate {
            thread_id: legacy.thread_id.clone(),
            display_name: snapshot.display_name.clone(),
            section_id: snapshot.section_id.clone(),
            position_in_section: snapshot
                .position_in_section
                .map(|position| {
                    i64::try_from(position).map_err(|_| {
                        TaskStoreError::InvalidMigrationSnapshot("position out of range")
                    })
                })
                .transpose()?,
        });
    }
    for section_positions in positions.values_mut() {
        section_positions.sort_unstable();
        if !section_positions
            .iter()
            .enumerate()
            .all(|(expected, actual)| *actual == expected as u64)
        {
            return Err(TaskStoreError::InvalidMigrationSnapshot(
                "non-dense section positions",
            ));
        }
    }
    Ok((sections, threads))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_incomplete_snapshot_before_mutating_v4() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("v4.redb");
        let mut glue = Glue::new(RedbStorage::new(&path).unwrap());
        super::super::schema::v1::create(&mut glue, Utc::now().naive_utc()).unwrap();
        drop(glue);
        super::super::v1_to_v2::migrate(&path).unwrap();
        super::super::v2_to_v3::migrate(&path).unwrap();
        super::super::v3_to_v4::migrate(&path).unwrap();

        assert!(matches!(
            migrate(
                &path,
                &NavigatorMigrationSnapshot {
                    sections: Vec::new(),
                    threads: vec![super::super::NavigatorMigrationThread {
                        thread_id: "not-managed".to_string(),
                        display_name: "Not managed".to_string(),
                        classification: NavigatorMigrationThreadClassification::ActiveUnsectioned,
                        section_id: None,
                        position_in_section: None,
                    }],
                },
            ),
            Err(TaskStoreError::InvalidMigrationSnapshot(
                "thread inventory mismatch"
            ))
        ));
        assert_eq!(
            detect_redb_schema(&path).unwrap(),
            DetectedSchemaVersion::V4
        );
    }
}
