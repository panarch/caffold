use chrono::{DateTime, NaiveDateTime, Utc};
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::{Schema, Value},
        executor::Payload,
        query_builder::{Execute, ExprNode, col, null, table, text, value as glue_value},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, SelectResultExt},
};

use super::{Result, TaskStoreError};

pub(super) const TABLE_NAME: &str = "managed_threads";

const COLUMN_DEFINITIONS: &[&str] = &[
    "thread_id TEXT PRIMARY KEY",
    "archived_at TIMESTAMP NULL",
    "last_observed_recency_at TIMESTAMP NULL",
    "claimed_at TIMESTAMP",
    "last_opened_at TIMESTAMP NULL",
    "last_seen_activity_at TIMESTAMP NULL",
    "last_completed_at TIMESTAMP NULL",
    "model TEXT NULL",
    "reasoning_effort TEXT NULL",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedThread {
    pub thread_id: String,
    pub archived_at_ms: Option<u64>,
    pub last_observed_recency_ms: Option<u64>,
    pub claimed_at_ms: u64,
    pub last_opened_at_ms: Option<u64>,
    pub last_seen_activity_ms: Option<u64>,
    pub last_completed_at_ms: Option<u64>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

impl ManagedThread {
    pub(crate) fn new(
        thread_id: impl Into<String>,
        last_observed_recency_ms: Option<u64>,
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Self {
        Self {
            thread_id: thread_id.into(),
            archived_at_ms: None,
            last_observed_recency_ms,
            claimed_at_ms: 0,
            last_opened_at_ms: None,
            last_seen_activity_ms: None,
            last_completed_at_ms: None,
            model,
            reasoning_effort,
        }
    }

    pub(crate) fn unseen(&self) -> bool {
        self.last_completed_at_ms.is_some_and(|completed| {
            self.last_seen_activity_ms
                .is_none_or(|seen| completed > seen)
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
pub(super) struct ManagedThreadRow {
    pub thread_id: String,
    pub archived_at: Option<NaiveDateTime>,
    pub last_observed_recency_at: Option<NaiveDateTime>,
    pub claimed_at: NaiveDateTime,
    pub last_opened_at: Option<NaiveDateTime>,
    pub last_seen_activity_at: Option<NaiveDateTime>,
    pub last_completed_at: Option<NaiveDateTime>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

impl TryFrom<&ManagedThread> for ManagedThreadRow {
    type Error = TaskStoreError;

    fn try_from(thread: &ManagedThread) -> Result<Self> {
        Ok(Self {
            thread_id: thread.thread_id.clone(),
            archived_at: to_optional_db_timestamp(thread.archived_at_ms, "archived_at_ms")?,
            last_observed_recency_at: to_optional_db_timestamp(
                thread.last_observed_recency_ms,
                "last_observed_recency_ms",
            )?,
            claimed_at: to_db_timestamp(thread.claimed_at_ms, "claimed_at_ms")?,
            last_opened_at: to_optional_db_timestamp(
                thread.last_opened_at_ms,
                "last_opened_at_ms",
            )?,
            last_seen_activity_at: to_optional_db_timestamp(
                thread.last_seen_activity_ms,
                "last_seen_activity_ms",
            )?,
            last_completed_at: to_optional_db_timestamp(
                thread.last_completed_at_ms,
                "last_completed_at_ms",
            )?,
            model: thread.model.clone(),
            reasoning_effort: thread.reasoning_effort.clone(),
        })
    }
}

impl TryFrom<ManagedThreadRow> for ManagedThread {
    type Error = TaskStoreError;

    fn try_from(row: ManagedThreadRow) -> Result<Self> {
        Ok(Self {
            thread_id: row.thread_id,
            archived_at_ms: from_optional_db_timestamp(row.archived_at, "archived_at_ms")?,
            last_observed_recency_ms: from_optional_db_timestamp(
                row.last_observed_recency_at,
                "last_observed_recency_ms",
            )?,
            claimed_at_ms: from_db_timestamp(row.claimed_at, "claimed_at_ms")?,
            last_opened_at_ms: from_optional_db_timestamp(row.last_opened_at, "last_opened_at_ms")?,
            last_seen_activity_ms: from_optional_db_timestamp(
                row.last_seen_activity_at,
                "last_seen_activity_ms",
            )?,
            last_completed_at_ms: from_optional_db_timestamp(
                row.last_completed_at,
                "last_completed_at_ms",
            )?,
            model: row.model,
            reasoning_effort: row.reasoning_effort,
        })
    }
}

#[derive(Debug, Clone, Copy)]
enum Membership {
    Active,
    Archived,
}

impl Membership {
    fn filter(self) -> ExprNode<'static> {
        match self {
            Self::Active => col("archived_at").is_null(),
            Self::Archived => col("archived_at").is_not_null(),
        }
    }
}

pub(super) fn create_table<S>(glue: &mut Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let mut query = table(TABLE_NAME).create_table_if_not_exists();
    for definition in COLUMN_DEFINITIONS {
        query = query.add_column(*definition);
    }
    query.execute(glue)?;
    Ok(())
}

pub(super) fn validate_table<S>(glue: &Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let actual = glue
        .storage
        .fetch_schema(TABLE_NAME)?
        .ok_or(TaskStoreError::IncompleteSchema)?;
    let expected = Schema::from_ddl(&expected_ddl())?;
    if actual.column_defs != expected.column_defs {
        return Err(TaskStoreError::InvalidSchemaTable(TABLE_NAME.to_string()));
    }
    Ok(())
}

pub(super) fn claim<S>(
    glue: &mut Glue<S>,
    mut thread: ManagedThread,
    now_ms: u64,
) -> Result<ManagedThread>
where
    S: GStore + GStoreMut + Planner,
{
    if let Some(existing) = get(glue, &thread.thread_id)? {
        thread.archived_at_ms = None;
        thread.claimed_at_ms = existing.claimed_at_ms;
        thread.last_opened_at_ms = max_optional(existing.last_opened_at_ms, Some(now_ms));
        thread.last_completed_at_ms =
            max_optional(existing.last_completed_at_ms, thread.last_completed_at_ms);
        thread.last_seen_activity_ms =
            max_optional(existing.last_seen_activity_ms, thread.last_completed_at_ms);
        if thread.model.is_none() {
            thread.model = existing.model;
        }
        if thread.reasoning_effort.is_none() {
            thread.reasoning_effort = existing.reasoning_effort;
        }
        update_all(glue, &thread)?;
    } else {
        if get_archived(glue, &thread.thread_id)?.is_some() {
            return Err(TaskStoreError::ArchivedThreadCannotBeClaimed(
                thread.thread_id,
            ));
        }
        thread.archived_at_ms = None;
        thread.claimed_at_ms = now_ms;
        thread.last_opened_at_ms = Some(now_ms);
        thread.last_seen_activity_ms = thread.last_completed_at_ms;
        insert(glue, &thread)?;
    }
    Ok(thread)
}

pub(super) fn get<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    get_by_membership(glue, thread_id, Membership::Active)
}

pub(super) fn get_archived<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    get_by_membership(glue, thread_id, Membership::Archived)
}

pub(super) fn list<S>(
    glue: &mut Glue<S>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(Vec<ManagedThread>, Option<String>)>
where
    S: GStore + GStoreMut + Planner,
{
    list_by_membership(
        glue,
        decode_cursor(cursor)?.as_ref(),
        limit,
        Membership::Active,
    )
}

pub(super) fn list_archived<S>(
    glue: &mut Glue<S>,
    cursor: Option<&str>,
    limit: usize,
) -> Result<(Vec<ManagedThread>, Option<String>)>
where
    S: GStore + GStoreMut + Planner,
{
    list_by_membership(
        glue,
        decode_cursor(cursor)?.as_ref(),
        limit,
        Membership::Archived,
    )
}

pub(super) fn archive<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    archived_at_ms: u64,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    if get(glue, thread_id)?.is_none() {
        return Ok(None);
    }
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(Membership::Active.filter())
        .set(
            "archived_at",
            timestamp_expr(archived_at_ms, "archived_at_ms")?,
        )
        .execute(glue)?;
    expect_single_update(payload)?;
    get_archived(glue, thread_id)
}

pub(super) fn restore<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    if get_archived(glue, thread_id)?.is_none() {
        return Ok(None);
    }
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(Membership::Archived.filter())
        .set("archived_at", null())
        .execute(glue)?;
    expect_single_update(payload)?;
    get(glue, thread_id)
}

pub(super) fn update_observed_recency<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    activity_ms: u64,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    update_observed_recency_by_membership(glue, thread_id, activity_ms, Membership::Active)
}

pub(super) fn update_archived_observed_recency<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    activity_ms: u64,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    update_observed_recency_by_membership(glue, thread_id, activity_ms, Membership::Archived)
}

pub(super) fn update_completed_at<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    completed_at_ms: u64,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(existing) = get(glue, thread_id)? else {
        return Ok(None);
    };
    let completed_at_ms = existing
        .last_completed_at_ms
        .unwrap_or_default()
        .max(completed_at_ms);
    table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(Membership::Active.filter())
        .set(
            "last_completed_at",
            timestamp_expr(completed_at_ms, "last_completed_at_ms")?,
        )
        .execute(glue)?;
    get(glue, thread_id)
}

pub(super) fn mark_seen<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    canonical_activity_ms: u64,
    opened_at_ms: u64,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(mut thread) = get(glue, thread_id)? else {
        return Ok(None);
    };
    thread.last_observed_recency_ms =
        max_optional(thread.last_observed_recency_ms, Some(canonical_activity_ms));
    thread.last_opened_at_ms = max_optional(thread.last_opened_at_ms, Some(opened_at_ms));
    thread.last_seen_activity_ms =
        max_optional(thread.last_seen_activity_ms, thread.last_completed_at_ms);
    update_all(glue, &thread)?;
    Ok(Some(thread))
}

pub(super) fn update_composer_settings<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    if get(glue, thread_id)?.is_none() {
        return Ok(None);
    }
    table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(Membership::Active.filter())
        .set("model", optional_text(model))
        .set("reasoning_effort", optional_text(reasoning_effort))
        .execute(glue)?;
    get(glue, thread_id)
}

pub(super) fn delete<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(TABLE_NAME)
        .delete()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(Membership::Active.filter())
        .execute(glue)?;
    deleted(payload)
}

pub(super) fn columns() -> Vec<ExprNode<'static>> {
    ManagedThreadRow::glue_columns()
        .iter()
        .map(|column| col(*column))
        .collect()
}

pub(super) fn to_db_timestamp(value: u64, field: &'static str) -> Result<NaiveDateTime> {
    let value = i64::try_from(value).map_err(|_| TaskStoreError::InvalidRow(field))?;
    DateTime::<Utc>::from_timestamp_millis(value)
        .map(|timestamp| timestamp.naive_utc())
        .ok_or(TaskStoreError::InvalidRow(field))
}

fn get_by_membership<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    membership: Membership,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = table(TABLE_NAME)
        .select()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(membership.filter())
        .project(columns())
        .limit(1)
        .execute(glue)
        .rows_as::<ManagedThreadRow>()?;
    rows.into_iter().next().map(TryInto::try_into).transpose()
}

fn list_by_membership<S>(
    glue: &mut Glue<S>,
    cursor: Option<&ManagedThreadCursor>,
    limit: usize,
    membership: Membership,
) -> Result<(Vec<ManagedThread>, Option<String>)>
where
    S: GStore + GStoreMut + Planner,
{
    if limit == 0 {
        return Ok((Vec::new(), None));
    }
    let rows = table(TABLE_NAME)
        .select()
        .filter(membership.filter())
        .project(columns())
        .execute(glue)
        .rows_as::<ManagedThreadRow>()?;
    let mut threads = rows
        .into_iter()
        .map(TryInto::try_into)
        .collect::<Result<Vec<_>>>()?;
    threads.sort_by(managed_thread_order);
    if let Some(cursor) = cursor {
        threads.retain(|thread| managed_thread_is_after(thread, cursor));
    }
    let has_more = threads.len() > limit;
    threads.truncate(limit);
    let next_cursor = has_more
        .then(|| threads.last().map(encode_cursor))
        .flatten();
    Ok((threads, next_cursor))
}

fn update_observed_recency_by_membership<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    activity_ms: u64,
    membership: Membership,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let existing = match membership {
        Membership::Active => get(glue, thread_id)?,
        Membership::Archived => get_archived(glue, thread_id)?,
    };
    let Some(existing) = existing else {
        return Ok(None);
    };
    let activity_ms = existing
        .last_observed_recency_ms
        .unwrap_or_default()
        .max(activity_ms);
    table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(membership.filter())
        .set(
            "last_observed_recency_at",
            timestamp_expr(activity_ms, "last_observed_recency_ms")?,
        )
        .execute(glue)?;
    match membership {
        Membership::Active => get(glue, thread_id),
        Membership::Archived => get_archived(glue, thread_id),
    }
}

fn insert<S>(glue: &mut Glue<S>, thread: &ManagedThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let row = ManagedThreadRow::try_from(thread)?;
    table(TABLE_NAME)
        .insert()
        .values_from(std::slice::from_ref(&row))?
        .execute(glue)?;
    Ok(())
}

fn update_all<S>(glue: &mut Glue<S>, thread: &ManagedThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let row = ManagedThreadRow::try_from(thread)?;
    table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(row.thread_id)))
        .filter(Membership::Active.filter())
        .set("archived_at", optional_timestamp(row.archived_at))
        .set(
            "last_observed_recency_at",
            optional_timestamp(row.last_observed_recency_at),
        )
        .set("claimed_at", timestamp_value(row.claimed_at))
        .set("last_opened_at", optional_timestamp(row.last_opened_at))
        .set(
            "last_seen_activity_at",
            optional_timestamp(row.last_seen_activity_at),
        )
        .set(
            "last_completed_at",
            optional_timestamp(row.last_completed_at),
        )
        .set("model", optional_text(row.model.as_deref()))
        .set(
            "reasoning_effort",
            optional_text(row.reasoning_effort.as_deref()),
        )
        .execute(glue)?;
    Ok(())
}

fn expected_ddl() -> String {
    format!(
        "CREATE TABLE {TABLE_NAME} ({});",
        COLUMN_DEFINITIONS.join(", ")
    )
}

fn expect_single_update(payload: Payload) -> Result<()> {
    match payload {
        Payload::Update(1) => Ok(()),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn deleted(payload: Payload) -> Result<bool> {
    match payload {
        Payload::Delete(count) => Ok(count > 0),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn optional_text(value: Option<&str>) -> ExprNode<'static> {
    value.map_or_else(null, |value| text(value.to_owned()))
}

fn timestamp_value(timestamp: NaiveDateTime) -> ExprNode<'static> {
    glue_value(Value::Timestamp(timestamp))
}

fn optional_timestamp(timestamp: Option<NaiveDateTime>) -> ExprNode<'static> {
    timestamp.map_or_else(null, timestamp_value)
}

fn timestamp_expr(value: u64, field: &'static str) -> Result<ExprNode<'static>> {
    Ok(timestamp_value(to_db_timestamp(value, field)?))
}

fn max_optional(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    left.into_iter().chain(right).max()
}

fn to_optional_db_timestamp(
    value: Option<u64>,
    field: &'static str,
) -> Result<Option<NaiveDateTime>> {
    value.map(|value| to_db_timestamp(value, field)).transpose()
}

fn from_db_timestamp(value: NaiveDateTime, field: &'static str) -> Result<u64> {
    value
        .and_utc()
        .timestamp_millis()
        .try_into()
        .map_err(|_| TaskStoreError::InvalidRow(field))
}

fn from_optional_db_timestamp(
    value: Option<NaiveDateTime>,
    field: &'static str,
) -> Result<Option<u64>> {
    value
        .map(|value| from_db_timestamp(value, field))
        .transpose()
}

fn managed_thread_order(left: &ManagedThread, right: &ManagedThread) -> std::cmp::Ordering {
    right
        .last_observed_recency_ms
        .cmp(&left.last_observed_recency_ms)
        .then_with(|| left.thread_id.cmp(&right.thread_id))
}

fn managed_thread_is_after(thread: &ManagedThread, cursor: &ManagedThreadCursor) -> bool {
    match (
        thread.last_observed_recency_ms,
        cursor.last_observed_recency_ms,
    ) {
        (Some(thread_recency), Some(cursor_recency)) => {
            thread_recency < cursor_recency
                || (thread_recency == cursor_recency && thread.thread_id > cursor.thread_id)
        }
        (None, Some(_)) => true,
        (Some(_), None) => false,
        (None, None) => thread.thread_id > cursor.thread_id,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedThreadCursor {
    last_observed_recency_ms: Option<u64>,
    thread_id: String,
}

fn encode_cursor(thread: &ManagedThread) -> String {
    let recency = thread
        .last_observed_recency_ms
        .map_or_else(|| "-".to_string(), |value| value.to_string());
    format!("v2:{recency}:{}", thread.thread_id)
}

fn decode_cursor(cursor: Option<&str>) -> Result<Option<ManagedThreadCursor>> {
    let Some(cursor) = cursor.map(str::trim).filter(|cursor| !cursor.is_empty()) else {
        return Ok(None);
    };
    let (recency, thread_id) = cursor
        .strip_prefix("v2:")
        .and_then(|value| value.split_once(':'))
        .filter(|(_, thread_id)| !thread_id.is_empty())
        .ok_or(TaskStoreError::InvalidCursor)?;
    let last_observed_recency_ms = if recency == "-" {
        None
    } else {
        Some(recency.parse().map_err(|_| TaskStoreError::InvalidCursor)?)
    };
    Ok(Some(ManagedThreadCursor {
        last_observed_recency_ms,
        thread_id: thread_id.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use gluesql::prelude::MemoryStorage;

    use super::*;

    fn memory() -> Glue<MemoryStorage> {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();
        glue
    }

    fn thread(id: &str, recency_ms: Option<u64>) -> ManagedThread {
        ManagedThread::new(id, recency_ms, None, None)
    }

    #[test]
    fn creates_and_validates_the_owned_table_schema() {
        let glue = memory();
        validate_table(&glue).unwrap();

        let missing = Glue::new(MemoryStorage::default());
        assert!(matches!(
            validate_table(&missing),
            Err(TaskStoreError::IncompleteSchema)
        ));

        let mut invalid = Glue::new(MemoryStorage::default());
        table(TABLE_NAME)
            .create_table()
            .add_column("thread_id TEXT PRIMARY KEY")
            .execute(&mut invalid)
            .unwrap();
        assert!(matches!(
            validate_table(&invalid),
            Err(TaskStoreError::InvalidSchemaTable(table)) if table == TABLE_NAME
        ));
    }

    #[test]
    fn row_conversion_round_trips_all_persisted_fields() {
        let thread = ManagedThread {
            thread_id: "fully-populated".to_string(),
            archived_at_ms: Some(110),
            last_observed_recency_ms: Some(120),
            claimed_at_ms: 100,
            last_opened_at_ms: Some(130),
            last_seen_activity_ms: Some(140),
            last_completed_at_ms: Some(150),
            model: Some("gpt-test".to_string()),
            reasoning_effort: Some("xhigh".to_string()),
        };

        let row = ManagedThreadRow::try_from(&thread).unwrap();
        assert_eq!(ManagedThread::try_from(row).unwrap(), thread);

        let mut invalid = thread;
        invalid.claimed_at_ms = u64::MAX;
        assert!(matches!(
            ManagedThreadRow::try_from(&invalid),
            Err(TaskStoreError::InvalidRow("claimed_at_ms"))
        ));
    }

    #[test]
    fn row_conversion_rejects_each_out_of_range_optional_timestamp() {
        fn assert_thread_error(
            mut thread: ManagedThread,
            field: &'static str,
            make_invalid: impl FnOnce(&mut ManagedThread),
        ) {
            make_invalid(&mut thread);
            assert!(matches!(
                ManagedThreadRow::try_from(&thread),
                Err(TaskStoreError::InvalidRow(found)) if found == field
            ));
        }

        let thread = ManagedThread::new("invalid", None, None, None);
        assert_thread_error(thread.clone(), "archived_at_ms", |thread| {
            thread.archived_at_ms = Some(u64::MAX);
        });
        assert_thread_error(thread.clone(), "last_observed_recency_ms", |thread| {
            thread.last_observed_recency_ms = Some(u64::MAX);
        });
        assert_thread_error(thread.clone(), "last_opened_at_ms", |thread| {
            thread.last_opened_at_ms = Some(u64::MAX);
        });
        assert_thread_error(thread.clone(), "last_seen_activity_ms", |thread| {
            thread.last_seen_activity_ms = Some(u64::MAX);
        });
        assert_thread_error(thread.clone(), "last_completed_at_ms", |thread| {
            thread.last_completed_at_ms = Some(u64::MAX);
        });

        fn assert_row_error(
            mut row: ManagedThreadRow,
            field: &'static str,
            make_invalid: impl FnOnce(&mut ManagedThreadRow, NaiveDateTime),
        ) {
            let before_epoch = DateTime::<Utc>::from_timestamp_millis(-1)
                .unwrap()
                .naive_utc();
            make_invalid(&mut row, before_epoch);
            assert!(matches!(
                ManagedThread::try_from(row),
                Err(TaskStoreError::InvalidRow(found)) if found == field
            ));
        }

        let row = ManagedThreadRow::try_from(&thread).unwrap();
        assert_row_error(row.clone(), "archived_at_ms", |row, value| {
            row.archived_at = Some(value);
        });
        assert_row_error(row.clone(), "last_observed_recency_ms", |row, value| {
            row.last_observed_recency_at = Some(value);
        });
        assert_row_error(row.clone(), "last_opened_at_ms", |row, value| {
            row.last_opened_at = Some(value);
        });
        assert_row_error(row.clone(), "last_seen_activity_ms", |row, value| {
            row.last_seen_activity_at = Some(value);
        });
        assert_row_error(row, "last_completed_at_ms", |row, value| {
            row.last_completed_at = Some(value);
        });
    }

    #[test]
    fn claims_lists_and_paginates_by_observed_recency() {
        let mut glue = memory();
        claim(&mut glue, thread("older", Some(20)), 100).unwrap();
        claim(&mut glue, thread("newer", Some(30)), 110).unwrap();

        let (first, cursor) = list(&mut glue, None, 1).unwrap();
        assert_eq!(first[0].thread_id, "newer");
        let (second, cursor) = list(&mut glue, cursor.as_deref(), 1).unwrap();
        assert_eq!(second[0].thread_id, "older");
        assert!(cursor.is_none());
    }

    #[test]
    fn pagination_cursor_covers_equal_and_missing_recency() {
        let mut glue = memory();
        for thread in [
            thread("same-a", Some(30)),
            thread("same-b", Some(30)),
            thread("none-a", None),
            thread("none-b", None),
        ] {
            claim(&mut glue, thread, 100).unwrap();
        }

        let mut ids = Vec::new();
        let mut cursor = None;
        loop {
            let (page, next) = list(&mut glue, cursor.as_deref(), 1).unwrap();
            ids.extend(page.into_iter().map(|thread| thread.thread_id));
            let Some(next) = next else {
                break;
            };
            cursor = Some(next);
        }
        assert_eq!(ids, ["same-a", "same-b", "none-a", "none-b"]);
        assert_eq!(list(&mut glue, None, 0).unwrap(), (Vec::new(), None));
    }

    #[test]
    fn pagination_cursor_survives_updates_to_the_previous_page() {
        let mut glue = memory();
        claim(&mut glue, thread("first", Some(40)), 100).unwrap();
        claim(&mut glue, thread("second", Some(30)), 100).unwrap();
        claim(&mut glue, thread("third", Some(20)), 100).unwrap();

        let (first_page, cursor) = list(&mut glue, None, 2).unwrap();
        assert_eq!(
            first_page
                .iter()
                .map(|thread| thread.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        update_observed_recency(&mut glue, "second", 50).unwrap();

        let (second_page, cursor) = list(&mut glue, cursor.as_deref(), 2).unwrap();
        assert_eq!(second_page[0].thread_id, "third");
        assert!(cursor.is_none());
    }

    #[test]
    fn rejects_malformed_pagination_cursors() {
        let mut glue = memory();
        for cursor in ["v1:1:task", "v2:not-a-number:task", "v2:1:"] {
            assert!(matches!(
                list(&mut glue, Some(cursor), 1),
                Err(TaskStoreError::InvalidCursor)
            ));
        }
        assert_eq!(list(&mut glue, Some("  "), 1).unwrap(), (Vec::new(), None));
    }

    #[test]
    fn reclaiming_an_active_thread_preserves_owned_history() {
        let mut glue = memory();
        let mut initial = thread("task", Some(20));
        initial.model = Some("gpt-test".to_string());
        initial.reasoning_effort = Some("xhigh".to_string());
        claim(&mut glue, initial, 100).unwrap();
        update_completed_at(&mut glue, "task", 40).unwrap();

        let mut incoming = thread("task", Some(50));
        incoming.last_completed_at_ms = Some(35);
        let reclaimed = claim(&mut glue, incoming, 150).unwrap();

        assert_eq!(reclaimed.claimed_at_ms, 100);
        assert_eq!(reclaimed.last_opened_at_ms, Some(150));
        assert_eq!(reclaimed.last_completed_at_ms, Some(40));
        assert_eq!(reclaimed.last_seen_activity_ms, Some(40));
        assert_eq!(reclaimed.model.as_deref(), Some("gpt-test"));
        assert_eq!(reclaimed.reasoning_effort.as_deref(), Some("xhigh"));
    }

    #[test]
    fn completion_seen_and_composer_metadata_update_independently() {
        let mut glue = memory();
        let claimed = claim(&mut glue, thread("task", Some(20)), 100).unwrap();
        assert_eq!(claimed.claimed_at_ms, 100);
        assert_eq!(claimed.last_seen_activity_ms, None);
        assert!(!claimed.unseen());

        update_composer_settings(&mut glue, "task", Some("gpt-test"), Some("xhigh")).unwrap();
        let refreshed = update_observed_recency(&mut glue, "task", 40)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.claimed_at_ms, 100);
        assert_eq!(refreshed.last_seen_activity_ms, None);
        assert_eq!(refreshed.model.as_deref(), Some("gpt-test"));
        assert_eq!(refreshed.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(!refreshed.unseen());

        let completed = update_completed_at(&mut glue, "task", 45).unwrap().unwrap();
        assert_eq!(completed.last_completed_at_ms, Some(45));
        assert!(completed.unseen());
        let completed = update_completed_at(&mut glue, "task", 35).unwrap().unwrap();
        assert_eq!(completed.last_completed_at_ms, Some(45));

        let seen = mark_seen(&mut glue, "task", 40, 150).unwrap().unwrap();
        assert_eq!(seen.last_opened_at_ms, Some(150));
        assert_eq!(seen.last_seen_activity_ms, Some(45));
        assert!(!seen.unseen());
    }

    #[test]
    fn archive_and_restore_update_one_row_without_losing_metadata() {
        let mut glue = memory();
        let mut managed = thread("task", Some(40));
        managed.model = Some("gpt-test".to_string());
        managed.reasoning_effort = Some("xhigh".to_string());
        let claimed = claim(&mut glue, managed, 100).unwrap();

        let archived = archive(&mut glue, "task", 200).unwrap().unwrap();
        assert_eq!(archived.archived_at_ms, Some(200));
        assert_eq!(archived.model, claimed.model);
        assert_eq!(archived.reasoning_effort, claimed.reasoning_effort);
        assert!(get(&mut glue, "task").unwrap().is_none());
        assert_eq!(
            get_archived(&mut glue, "task").unwrap(),
            Some(archived.clone())
        );
        assert_eq!(list(&mut glue, None, 30).unwrap().0, Vec::new());
        assert_eq!(
            list_archived(&mut glue, None, 30).unwrap().0,
            vec![archived]
        );

        let restored = restore(&mut glue, "task").unwrap().unwrap();
        assert_eq!(restored, claimed);
        assert_eq!(get(&mut glue, "task").unwrap(), Some(claimed));
        assert!(get_archived(&mut glue, "task").unwrap().is_none());
        assert!(list_archived(&mut glue, None, 30).unwrap().0.is_empty());
    }

    #[test]
    fn archived_thread_cannot_be_claimed_without_restore() {
        let mut glue = memory();
        claim(&mut glue, thread("archived", Some(20)), 100).unwrap();
        archive(&mut glue, "archived", 200).unwrap().unwrap();

        let error = claim(&mut glue, thread("archived", Some(30)), 300)
            .expect_err("claim must not bypass archived membership");
        assert!(matches!(
            error,
            TaskStoreError::ArchivedThreadCannotBeClaimed(thread_id)
                if thread_id == "archived"
        ));
        assert!(get(&mut glue, "archived").unwrap().is_none());
        assert_eq!(
            get_archived(&mut glue, "archived")
                .unwrap()
                .unwrap()
                .archived_at_ms,
            Some(200)
        );
    }

    #[test]
    fn missing_thread_mutations_are_noops() {
        let mut glue = memory();
        assert_eq!(archive(&mut glue, "missing", 100).unwrap(), None);
        assert_eq!(restore(&mut glue, "missing").unwrap(), None);
        assert_eq!(
            update_observed_recency(&mut glue, "missing", 100).unwrap(),
            None
        );
        assert_eq!(
            update_archived_observed_recency(&mut glue, "missing", 100).unwrap(),
            None
        );
        assert_eq!(
            update_completed_at(&mut glue, "missing", 100).unwrap(),
            None
        );
        assert_eq!(mark_seen(&mut glue, "missing", 100, 100).unwrap(), None);
        assert_eq!(
            update_composer_settings(&mut glue, "missing", None, None).unwrap(),
            None
        );
        assert!(!delete(&mut glue, "missing").unwrap());
    }

    #[test]
    fn query_builder_round_trips_literal_text_without_manual_escaping() {
        let mut glue = memory();
        let quoted = ManagedThread::new(
            "task'quoted",
            Some(20),
            Some("model'quoted".to_string()),
            Some("reasoning'quoted".to_string()),
        );

        claim(&mut glue, quoted.clone(), 100).unwrap();
        let stored = get(&mut glue, &quoted.thread_id).unwrap().unwrap();
        assert_eq!(stored.model, quoted.model);
        assert_eq!(stored.reasoning_effort, quoted.reasoning_effort);
        assert!(delete(&mut glue, &quoted.thread_id).unwrap());
        assert!(get(&mut glue, &quoted.thread_id).unwrap().is_none());
    }

    #[test]
    fn update_count_contract_rejects_non_single_updates() {
        assert!(expect_single_update(Payload::Update(1)).is_ok());
        assert!(matches!(
            expect_single_update(Payload::Update(0)),
            Err(TaskStoreError::UnexpectedPayload)
        ));
        assert!(deleted(Payload::Delete(1)).unwrap());
        assert!(!deleted(Payload::Delete(0)).unwrap());
        assert!(matches!(
            deleted(Payload::Update(0)),
            Err(TaskStoreError::UnexpectedPayload)
        ));
    }
}
