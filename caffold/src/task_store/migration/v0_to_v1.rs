use chrono::{DateTime, NaiveDateTime, Utc};
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::Schema,
        query_builder::{Execute, begin, col, rollback, table},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner, Store},
    },
    prelude::{Glue, RedbStorage, SelectResultExt},
};
use std::{collections::BTreeSet, path::Path};

use super::{DetectedSchemaVersion, MigrationReport, detect_redb_schema, schema};
use crate::task_store::{Result, TaskStoreError};

pub(super) const LEGACY_ARCHIVED_THREADS_TABLE: &str = "archived_threads";

const LEGACY_COLUMN_DEFINITIONS: &[&str] = &[
    "thread_id TEXT PRIMARY KEY",
    "last_observed_recency_ms INTEGER NULL",
    "claimed_at_ms INTEGER",
    "last_opened_at_ms INTEGER NULL",
    "last_seen_activity_ms INTEGER NULL",
    "model TEXT NULL",
    "reasoning_effort TEXT NULL",
];

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
pub(super) struct LegacyManagedThreadRow {
    pub thread_id: String,
    pub last_observed_recency_ms: Option<i64>,
    pub claimed_at_ms: i64,
    pub last_opened_at_ms: Option<i64>,
    pub last_seen_activity_ms: Option<i64>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug)]
struct LegacySnapshot {
    managed: Vec<LegacyManagedThreadRow>,
    archived: Vec<LegacyManagedThreadRow>,
    source_table_count: usize,
}

pub(super) fn migrate(source: &Path, destination: &Path) -> Result<MigrationReport> {
    let snapshot = read_legacy_snapshot(source)?;
    ensure_disjoint_membership(&snapshot)?;
    let rewritten_rows = snapshot.managed.len() + snapshot.archived.len();
    let migrated_tables = snapshot.source_table_count;
    let applied_at = Utc::now().naive_utc();

    write_v1(destination, snapshot, applied_at)?;

    Ok(MigrationReport {
        migrated_tables,
        unchanged_tables: 0,
        rewritten_rows,
    })
}

fn read_legacy_snapshot(path: &Path) -> Result<LegacySnapshot> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    begin().execute(&mut glue)?;
    let snapshot = (|| {
        validate_legacy_table(&glue, schema::v1::MANAGED_THREADS_TABLE)?;
        let managed = read_legacy_rows(&mut glue, schema::v1::MANAGED_THREADS_TABLE)?;
        let has_archived = glue
            .storage
            .fetch_schema(LEGACY_ARCHIVED_THREADS_TABLE)?
            .is_some();
        let actual_table_names = glue
            .storage
            .fetch_all_schemas()?
            .into_iter()
            .map(|schema| schema.table_name)
            .collect::<BTreeSet<_>>();
        let mut expected_table_names =
            BTreeSet::from([schema::v1::MANAGED_THREADS_TABLE.to_string()]);
        if has_archived {
            expected_table_names.insert(LEGACY_ARCHIVED_THREADS_TABLE.to_string());
        }
        if actual_table_names != expected_table_names {
            return Err(TaskStoreError::IncompleteSchema);
        }
        let archived = if has_archived {
            validate_legacy_table(&glue, LEGACY_ARCHIVED_THREADS_TABLE)?;
            read_legacy_rows(&mut glue, LEGACY_ARCHIVED_THREADS_TABLE)?
        } else {
            Vec::new()
        };

        Ok(LegacySnapshot {
            managed,
            archived,
            source_table_count: 1 + usize::from(has_archived),
        })
    })();
    let rollback_result = rollback().execute(&mut glue);
    match (snapshot, rollback_result) {
        (Ok(snapshot), Ok(_)) => Ok(snapshot),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error.into()),
    }
}

fn ensure_disjoint_membership(snapshot: &LegacySnapshot) -> Result<()> {
    let managed_ids = snapshot
        .managed
        .iter()
        .map(|row| row.thread_id.as_str())
        .collect::<BTreeSet<_>>();
    if let Some(duplicate) = snapshot
        .archived
        .iter()
        .find(|row| managed_ids.contains(row.thread_id.as_str()))
    {
        return Err(TaskStoreError::DuplicateLegacyThread(
            duplicate.thread_id.clone(),
        ));
    }
    Ok(())
}

fn write_v1(path: &Path, snapshot: LegacySnapshot, applied_at: NaiveDateTime) -> Result<()> {
    let storage = RedbStorage::new(path)?;
    let mut glue = Glue::new(storage);
    schema::v1::create(&mut glue, applied_at)?;
    rewrite_rows(&mut glue, snapshot, applied_at)?;
    drop(glue);
    if detect_redb_schema(path)? != DetectedSchemaVersion::V1 {
        return Err(TaskStoreError::IncompleteSchema);
    }
    Ok(())
}

fn rewrite_rows<S>(
    glue: &mut Glue<S>,
    snapshot: LegacySnapshot,
    archived_at: NaiveDateTime,
) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let mut expected = snapshot
        .managed
        .into_iter()
        .map(|row| convert_legacy_row(row, None))
        .chain(
            snapshot
                .archived
                .into_iter()
                // V0 stored only archived membership, not the transition time. Backfill the
                // time when v1 first persisted that state; this is not the original archive time.
                .map(|row| convert_legacy_row(row, Some(archived_at))),
        )
        .collect::<Result<Vec<_>>>()?;
    expected.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    if !expected.is_empty() {
        table(schema::v1::MANAGED_THREADS_TABLE)
            .insert()
            .values_from(&expected)?
            .execute(glue)?;
    }

    let mut actual = table(schema::v1::MANAGED_THREADS_TABLE)
        .select()
        .project(schema::v1::columns())
        .execute(glue)
        .rows_as::<schema::v1::ManagedThreadRow>()?;
    actual.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
    if actual != expected {
        return Err(TaskStoreError::UnexpectedPayload);
    }
    Ok(())
}

pub(super) fn read_legacy_rows<S>(
    glue: &mut Glue<S>,
    table_name: &'static str,
) -> Result<Vec<LegacyManagedThreadRow>>
where
    S: GStore + GStoreMut + Planner,
{
    table(table_name)
        .select()
        .project(
            LegacyManagedThreadRow::glue_columns()
                .iter()
                .map(|column| col(*column))
                .collect::<Vec<_>>(),
        )
        .execute(glue)
        .rows_as::<LegacyManagedThreadRow>()
        .map_err(Into::into)
}

fn validate_legacy_table<S>(glue: &Glue<S>, table_name: &str) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let actual = glue
        .storage
        .fetch_schema(table_name)?
        .ok_or(TaskStoreError::IncompleteSchema)?;
    let expected = Schema::from_ddl(&legacy_table_ddl(table_name))?;
    if actual.column_defs != expected.column_defs {
        return Err(TaskStoreError::InvalidSchemaTable(table_name.to_string()));
    }
    Ok(())
}

fn legacy_table_ddl(table_name: &str) -> String {
    format!(
        "CREATE TABLE {table_name} ({});",
        LEGACY_COLUMN_DEFINITIONS.join(", ")
    )
}

fn convert_legacy_row(
    row: LegacyManagedThreadRow,
    archived_at: Option<NaiveDateTime>,
) -> Result<schema::v1::ManagedThreadRow> {
    Ok(schema::v1::ManagedThreadRow {
        thread_id: row.thread_id,
        archived_at,
        last_observed_recency_at: legacy_optional_timestamp(
            row.last_observed_recency_ms,
            "last_observed_recency_ms",
        )?,
        claimed_at: legacy_timestamp(row.claimed_at_ms, "claimed_at_ms")?,
        last_opened_at: legacy_optional_timestamp(row.last_opened_at_ms, "last_opened_at_ms")?,
        last_seen_activity_at: legacy_optional_timestamp(
            row.last_seen_activity_ms,
            "last_seen_activity_ms",
        )?,
        last_completed_at: None,
        model: row.model,
        reasoning_effort: row.reasoning_effort,
    })
}

fn legacy_timestamp(value: i64, field: &'static str) -> Result<NaiveDateTime> {
    let value = u64::try_from(value).map_err(|_| TaskStoreError::InvalidRow(field))?;
    let value = i64::try_from(value).map_err(|_| TaskStoreError::InvalidRow(field))?;
    DateTime::<Utc>::from_timestamp_millis(value)
        .map(|timestamp| timestamp.naive_utc())
        .ok_or(TaskStoreError::InvalidRow(field))
}

fn legacy_optional_timestamp(
    value: Option<i64>,
    field: &'static str,
) -> Result<Option<NaiveDateTime>> {
    value
        .map(|value| legacy_timestamp(value, field))
        .transpose()
}

#[cfg(test)]
mod tests {
    use gluesql::prelude::SelectResultExt;

    use super::*;
    use crate::task_store::schema_migration;

    fn managed_legacy_row() -> LegacyManagedThreadRow {
        LegacyManagedThreadRow {
            thread_id: "managed-legacy".to_string(),
            last_observed_recency_ms: Some(1_750_000_001_234),
            claimed_at_ms: 1_750_000_000_111,
            last_opened_at_ms: Some(1_750_000_002_345),
            last_seen_activity_ms: Some(1_750_000_003_456),
            model: Some("gpt-legacy".to_string()),
            reasoning_effort: Some("xhigh".to_string()),
        }
    }

    fn archived_legacy_row() -> LegacyManagedThreadRow {
        LegacyManagedThreadRow {
            thread_id: "archived-legacy".to_string(),
            last_observed_recency_ms: None,
            claimed_at_ms: 1_749_000_000_000,
            last_opened_at_ms: None,
            last_seen_activity_ms: None,
            model: None,
            reasoning_effort: None,
        }
    }

    fn write_v0_database(
        path: &Path,
        managed_rows: &[LegacyManagedThreadRow],
        archived_rows: Option<&[LegacyManagedThreadRow]>,
    ) {
        let mut glue = Glue::new(RedbStorage::new(path).expect("create v0 Redb fixture"));
        write_v0_table(&mut glue, schema::v1::MANAGED_THREADS_TABLE, managed_rows);
        if let Some(rows) = archived_rows {
            write_v0_table(&mut glue, LEGACY_ARCHIVED_THREADS_TABLE, rows);
        }
    }

    fn write_v0_table(
        glue: &mut Glue<RedbStorage>,
        table_name: &'static str,
        rows: &[LegacyManagedThreadRow],
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
            .expect("create v0 thread table");
        if !rows.is_empty() {
            table(table_name)
                .insert()
                .values_from(rows)
                .expect("encode v0 rows")
                .execute(glue)
                .expect("insert v0 rows");
        }
    }

    #[test]
    fn produces_exact_v1_with_active_and_archived_rows() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("legacy-caffold.redb");
        let destination = temp.path().join("v1.redb");
        write_v0_database(
            &source,
            std::slice::from_ref(&managed_legacy_row()),
            Some(std::slice::from_ref(&archived_legacy_row())),
        );

        assert_eq!(
            migrate(&source, &destination).unwrap(),
            MigrationReport {
                migrated_tables: 2,
                unchanged_tables: 0,
                rewritten_rows: 2,
            }
        );
        assert_eq!(
            detect_redb_schema(&source).unwrap(),
            DetectedSchemaVersion::V0
        );
        assert_eq!(
            detect_redb_schema(&destination).unwrap(),
            DetectedSchemaVersion::V1
        );

        let mut glue = Glue::new(RedbStorage::new(&destination).unwrap());
        assert_eq!(schema_migration::current_version(&mut glue).unwrap(), 1);
        let mut rows = table(schema::v1::MANAGED_THREADS_TABLE)
            .select()
            .project(schema::v1::columns())
            .execute(&mut glue)
            .rows_as::<schema::v1::ManagedThreadRow>()
            .unwrap();
        rows.sort_by(|left, right| left.thread_id.cmp(&right.thread_id));
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].thread_id, "archived-legacy");
        assert!(rows[0].archived_at.is_some());
        assert_eq!(
            rows[0].claimed_at,
            legacy_timestamp(1_749_000_000_000, "claimed_at_ms").unwrap()
        );
        assert_eq!(
            rows[1],
            convert_legacy_row(managed_legacy_row(), None).unwrap()
        );
    }

    #[test]
    fn migrates_a_v0_database_without_an_archived_table() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("managed-only.redb");
        let destination = temp.path().join("v1.redb");
        write_v0_database(&source, std::slice::from_ref(&managed_legacy_row()), None);

        assert_eq!(
            migrate(&source, &destination).unwrap(),
            MigrationReport {
                migrated_tables: 1,
                unchanged_tables: 0,
                rewritten_rows: 1,
            }
        );
        assert_eq!(
            detect_redb_schema(&destination).unwrap(),
            DetectedSchemaVersion::V1
        );
    }

    #[test]
    fn invalid_v0_row_leaves_the_original_database_unchanged() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("invalid-legacy.redb");
        let destination = temp.path().join("v1.redb");
        let invalid = LegacyManagedThreadRow {
            claimed_at_ms: -1,
            ..managed_legacy_row()
        };
        write_v0_database(&source, std::slice::from_ref(&invalid), Some(&[]));

        assert!(matches!(
            migrate(&source, &destination),
            Err(TaskStoreError::InvalidRow("claimed_at_ms"))
        ));

        let mut glue = Glue::new(RedbStorage::new(&source).unwrap());
        assert_eq!(
            read_legacy_rows(&mut glue, schema::v1::MANAGED_THREADS_TABLE).unwrap(),
            vec![invalid]
        );
    }

    #[test]
    fn duplicate_legacy_membership_is_rejected_without_modifying_the_database() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("duplicate-membership.redb");
        let destination = temp.path().join("v1.redb");
        let duplicate = managed_legacy_row();
        write_v0_database(
            &source,
            std::slice::from_ref(&duplicate),
            Some(std::slice::from_ref(&duplicate)),
        );

        assert!(matches!(
            migrate(&source, &destination),
            Err(TaskStoreError::DuplicateLegacyThread(thread_id))
                if thread_id == "managed-legacy"
        ));
        assert!(!destination.exists());

        let mut glue = Glue::new(RedbStorage::new(&source).unwrap());
        assert_eq!(
            read_legacy_rows(&mut glue, schema::v1::MANAGED_THREADS_TABLE).unwrap(),
            vec![duplicate.clone()]
        );
        assert_eq!(
            read_legacy_rows(&mut glue, LEGACY_ARCHIVED_THREADS_TABLE).unwrap(),
            vec![duplicate]
        );
    }

    #[test]
    fn rejects_a_legacy_table_with_an_unknown_definition() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("invalid-schema.redb");
        let destination = temp.path().join("v1.redb");
        let mut glue = Glue::new(RedbStorage::new(&source).unwrap());
        table(schema::v1::MANAGED_THREADS_TABLE)
            .create_table()
            .add_column("thread_id TEXT PRIMARY KEY")
            .execute(&mut glue)
            .unwrap();
        drop(glue);

        assert!(matches!(
            migrate(&source, &destination),
            Err(TaskStoreError::InvalidSchemaTable(table))
                if table == schema::v1::MANAGED_THREADS_TABLE
        ));
    }

    #[test]
    fn rejects_non_v0_input_without_writing_a_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = temp.path().join("v1-source.redb");
        let destination = temp.path().join("v1-destination.redb");
        let mut glue = Glue::new(RedbStorage::new(&source).unwrap());
        schema::v1::create(&mut glue, Utc::now().naive_utc()).unwrap();
        drop(glue);

        assert!(matches!(
            migrate(&source, &destination),
            Err(TaskStoreError::InvalidSchemaTable(table))
                if table == schema::v1::MANAGED_THREADS_TABLE
        ));
        assert!(!destination.exists());
        assert_eq!(
            detect_redb_schema(&source).unwrap(),
            DetectedSchemaVersion::V1
        );
    }

    #[test]
    fn rejects_each_negative_legacy_timestamp() {
        fn assert_invalid(
            mut row: LegacyManagedThreadRow,
            field: &'static str,
            make_invalid: impl FnOnce(&mut LegacyManagedThreadRow),
        ) {
            make_invalid(&mut row);
            assert!(matches!(
                convert_legacy_row(row, None),
                Err(TaskStoreError::InvalidRow(found)) if found == field
            ));
        }

        assert_invalid(managed_legacy_row(), "last_observed_recency_ms", |row| {
            row.last_observed_recency_ms = Some(-1)
        });
        assert_invalid(managed_legacy_row(), "claimed_at_ms", |row| {
            row.claimed_at_ms = -1;
        });
        assert_invalid(managed_legacy_row(), "last_opened_at_ms", |row| {
            row.last_opened_at_ms = Some(-1);
        });
        assert_invalid(managed_legacy_row(), "last_seen_activity_ms", |row| {
            row.last_seen_activity_ms = Some(-1);
        });
    }
}
