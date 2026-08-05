use std::{
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        executor::Payload,
        query_builder::{Execute, ExprNode, col, null, num, table, text},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Error as GlueError, Glue, MemoryStorage, RedbStorage, SelectResultExt},
};
use thiserror::Error;

const MANAGED_THREADS_TABLE: &str = "managed_threads";
const ARCHIVED_THREADS_TABLE: &str = "archived_threads";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedThread {
    pub thread_id: String,
    pub last_observed_recency_ms: Option<u64>,
    pub claimed_at_ms: u64,
    pub last_opened_at_ms: Option<u64>,
    pub last_seen_activity_ms: Option<u64>,
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
            last_observed_recency_ms,
            claimed_at_ms: 0,
            last_opened_at_ms: None,
            last_seen_activity_ms: None,
            model,
            reasoning_effort,
        }
    }

    pub(crate) fn unseen(&self, canonical_activity_ms: u64) -> bool {
        self.last_seen_activity_ms
            .is_none_or(|seen| canonical_activity_ms > seen)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct ManagedThreadRow {
    thread_id: String,
    last_observed_recency_ms: Option<i64>,
    claimed_at_ms: i64,
    last_opened_at_ms: Option<i64>,
    last_seen_activity_ms: Option<i64>,
    model: Option<String>,
    reasoning_effort: Option<String>,
}

impl TryFrom<&ManagedThread> for ManagedThreadRow {
    type Error = ThreadStoreError;

    fn try_from(thread: &ManagedThread) -> Result<Self> {
        Ok(Self {
            thread_id: thread.thread_id.clone(),
            last_observed_recency_ms: to_optional_db_integer(
                thread.last_observed_recency_ms,
                "last_observed_recency_ms",
            )?,
            claimed_at_ms: to_db_integer(thread.claimed_at_ms, "claimed_at_ms")?,
            last_opened_at_ms: to_optional_db_integer(
                thread.last_opened_at_ms,
                "last_opened_at_ms",
            )?,
            last_seen_activity_ms: to_optional_db_integer(
                thread.last_seen_activity_ms,
                "last_seen_activity_ms",
            )?,
            model: thread.model.clone(),
            reasoning_effort: thread.reasoning_effort.clone(),
        })
    }
}

impl TryFrom<ManagedThreadRow> for ManagedThread {
    type Error = ThreadStoreError;

    fn try_from(row: ManagedThreadRow) -> Result<Self> {
        Ok(Self {
            thread_id: row.thread_id,
            last_observed_recency_ms: from_optional_db_integer(
                row.last_observed_recency_ms,
                "last_observed_recency_ms",
            )?,
            claimed_at_ms: from_db_integer(row.claimed_at_ms, "claimed_at_ms")?,
            last_opened_at_ms: from_optional_db_integer(
                row.last_opened_at_ms,
                "last_opened_at_ms",
            )?,
            last_seen_activity_ms: from_optional_db_integer(
                row.last_seen_activity_ms,
                "last_seen_activity_ms",
            )?,
            model: row.model,
            reasoning_effort: row.reasoning_effort,
        })
    }
}

#[derive(Debug, Error)]
pub(crate) enum ThreadStoreError {
    #[error("invalid thread pagination cursor")]
    InvalidCursor,
    #[error("unexpected thread store payload")]
    UnexpectedPayload,
    #[error("invalid thread row column: {0}")]
    InvalidRow(&'static str),
    #[error("thread store mutex was poisoned")]
    Poisoned,
    #[error("thread store error: {0}")]
    Glue(#[from] GlueError),
    #[error("filesystem error while preparing thread store: {0}")]
    Io(#[from] std::io::Error),
}

type Result<T> = std::result::Result<T, ThreadStoreError>;

#[derive(Clone)]
pub(crate) enum ThreadStore {
    Memory(Arc<Mutex<Glue<MemoryStorage>>>),
    Redb(Arc<Mutex<Glue<RedbStorage>>>),
}

impl ThreadStore {
    pub(crate) fn memory() -> Result<Self> {
        let store = Self::Memory(Arc::new(Mutex::new(Glue::new(MemoryStorage::default()))));
        store.initialize_schema()?;
        Ok(store)
    }

    pub(crate) fn redb(path: impl AsRef<Path>) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }
        let storage = RedbStorage::new(path)?;
        let store = Self::Redb(Arc::new(Mutex::new(Glue::new(storage))));
        store.initialize_schema()?;
        Ok(store)
    }

    fn initialize_schema(&self) -> Result<()> {
        match self {
            Self::Memory(glue) => initialize_schema(&mut *lock_glue(glue)?),
            Self::Redb(glue) => initialize_schema(&mut *lock_glue(glue)?),
        }
    }

    pub(crate) fn claim(&self, thread: ManagedThread, now_ms: u64) -> Result<ManagedThread> {
        match self {
            Self::Memory(glue) => claim(&mut *lock_glue(glue)?, thread, now_ms),
            Self::Redb(glue) => claim(&mut *lock_glue(glue)?, thread, now_ms),
        }
    }

    pub(crate) fn get(&self, thread_id: &str) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => get(&mut *lock_glue(glue)?, thread_id),
            Self::Redb(glue) => get(&mut *lock_glue(glue)?, thread_id),
        }
    }

    pub(crate) fn get_archived(&self, thread_id: &str) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => get_in(&mut *lock_glue(glue)?, ARCHIVED_THREADS_TABLE, thread_id),
            Self::Redb(glue) => get_in(&mut *lock_glue(glue)?, ARCHIVED_THREADS_TABLE, thread_id),
        }
    }

    pub(crate) fn list(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<ManagedThread>, Option<String>)> {
        let cursor = decode_cursor(cursor)?;
        match self {
            Self::Memory(glue) => list(&mut *lock_glue(glue)?, cursor.as_ref(), limit),
            Self::Redb(glue) => list(&mut *lock_glue(glue)?, cursor.as_ref(), limit),
        }
    }

    pub(crate) fn list_archived(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<ManagedThread>, Option<String>)> {
        let cursor = decode_cursor(cursor)?;
        match self {
            Self::Memory(glue) => list_in(
                &mut *lock_glue(glue)?,
                ARCHIVED_THREADS_TABLE,
                cursor.as_ref(),
                limit,
            ),
            Self::Redb(glue) => list_in(
                &mut *lock_glue(glue)?,
                ARCHIVED_THREADS_TABLE,
                cursor.as_ref(),
                limit,
            ),
        }
    }

    pub(crate) fn archive(&self, thread_id: &str) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => move_between(
                &mut *lock_glue(glue)?,
                MANAGED_THREADS_TABLE,
                ARCHIVED_THREADS_TABLE,
                thread_id,
            ),
            Self::Redb(glue) => move_between(
                &mut *lock_glue(glue)?,
                MANAGED_THREADS_TABLE,
                ARCHIVED_THREADS_TABLE,
                thread_id,
            ),
        }
    }

    pub(crate) fn restore(&self, thread_id: &str) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => move_between(
                &mut *lock_glue(glue)?,
                ARCHIVED_THREADS_TABLE,
                MANAGED_THREADS_TABLE,
                thread_id,
            ),
            Self::Redb(glue) => move_between(
                &mut *lock_glue(glue)?,
                ARCHIVED_THREADS_TABLE,
                MANAGED_THREADS_TABLE,
                thread_id,
            ),
        }
    }

    pub(crate) fn update_observed_recency(
        &self,
        thread_id: &str,
        activity_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => {
                update_observed_recency(&mut *lock_glue(glue)?, thread_id, activity_ms)
            }
            Self::Redb(glue) => {
                update_observed_recency(&mut *lock_glue(glue)?, thread_id, activity_ms)
            }
        }
    }

    pub(crate) fn update_archived_observed_recency(
        &self,
        thread_id: &str,
        activity_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => update_observed_recency_in(
                &mut *lock_glue(glue)?,
                ARCHIVED_THREADS_TABLE,
                thread_id,
                activity_ms,
            ),
            Self::Redb(glue) => update_observed_recency_in(
                &mut *lock_glue(glue)?,
                ARCHIVED_THREADS_TABLE,
                thread_id,
                activity_ms,
            ),
        }
    }

    pub(crate) fn mark_seen(
        &self,
        thread_id: &str,
        canonical_activity_ms: u64,
        opened_at_ms: u64,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => mark_seen(
                &mut *lock_glue(glue)?,
                thread_id,
                canonical_activity_ms,
                opened_at_ms,
            ),
            Self::Redb(glue) => mark_seen(
                &mut *lock_glue(glue)?,
                thread_id,
                canonical_activity_ms,
                opened_at_ms,
            ),
        }
    }

    pub(crate) fn update_composer_settings(
        &self,
        thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<Option<ManagedThread>> {
        match self {
            Self::Memory(glue) => {
                update_composer_settings(&mut *lock_glue(glue)?, thread_id, model, reasoning_effort)
            }
            Self::Redb(glue) => {
                update_composer_settings(&mut *lock_glue(glue)?, thread_id, model, reasoning_effort)
            }
        }
    }

    pub(crate) fn delete(&self, thread_id: &str) -> Result<bool> {
        match self {
            Self::Memory(glue) => delete(&mut *lock_glue(glue)?, thread_id),
            Self::Redb(glue) => delete(&mut *lock_glue(glue)?, thread_id),
        }
    }
}

fn lock_glue<T>(glue: &Arc<Mutex<T>>) -> Result<MutexGuard<'_, T>> {
    glue.lock().map_err(|_| ThreadStoreError::Poisoned)
}

fn initialize_schema<S>(glue: &mut Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    table(MANAGED_THREADS_TABLE)
        .create_table_if_not_exists()
        .add_column("thread_id TEXT PRIMARY KEY")
        .add_column("last_observed_recency_ms INTEGER NULL")
        .add_column("claimed_at_ms INTEGER")
        .add_column("last_opened_at_ms INTEGER NULL")
        .add_column("last_seen_activity_ms INTEGER NULL")
        .add_column("model TEXT NULL")
        .add_column("reasoning_effort TEXT NULL")
        .execute(glue)?;
    table(ARCHIVED_THREADS_TABLE)
        .create_table_if_not_exists()
        .add_column("thread_id TEXT PRIMARY KEY")
        .add_column("last_observed_recency_ms INTEGER NULL")
        .add_column("claimed_at_ms INTEGER")
        .add_column("last_opened_at_ms INTEGER NULL")
        .add_column("last_seen_activity_ms INTEGER NULL")
        .add_column("model TEXT NULL")
        .add_column("reasoning_effort TEXT NULL")
        .execute(glue)?;
    Ok(())
}

fn claim<S>(glue: &mut Glue<S>, mut thread: ManagedThread, now_ms: u64) -> Result<ManagedThread>
where
    S: GStore + GStoreMut + Planner,
{
    if let Some(existing) = get(glue, &thread.thread_id)? {
        thread.claimed_at_ms = existing.claimed_at_ms;
        thread.last_opened_at_ms = max_optional(existing.last_opened_at_ms, Some(now_ms));
        thread.last_seen_activity_ms = max_optional(
            existing.last_seen_activity_ms,
            thread.last_observed_recency_ms,
        );
        if thread.model.is_none() {
            thread.model = existing.model;
        }
        if thread.reasoning_effort.is_none() {
            thread.reasoning_effort = existing.reasoning_effort;
        }
        update_all(glue, &thread)?;
    } else {
        thread.claimed_at_ms = now_ms;
        thread.last_opened_at_ms = Some(now_ms);
        thread.last_seen_activity_ms = thread.last_observed_recency_ms;
        insert(glue, &thread)?;
    }
    Ok(thread)
}

fn get<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    get_in(glue, MANAGED_THREADS_TABLE, thread_id)
}

fn get_in<S>(
    glue: &mut Glue<S>,
    table_name: &'static str,
    thread_id: &str,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = table(table_name)
        .select()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .project(managed_thread_columns())
        .limit(2)
        .execute(glue)
        .rows_as::<ManagedThreadRow>()?;
    match rows.as_slice() {
        [] => Ok(None),
        [row] => Ok(Some(row.clone().try_into()?)),
        _ => Err(ThreadStoreError::UnexpectedPayload),
    }
}

fn list<S>(
    glue: &mut Glue<S>,
    cursor: Option<&ManagedThreadCursor>,
    limit: usize,
) -> Result<(Vec<ManagedThread>, Option<String>)>
where
    S: GStore + GStoreMut + Planner,
{
    list_in(glue, MANAGED_THREADS_TABLE, cursor, limit)
}

fn list_in<S>(
    glue: &mut Glue<S>,
    table_name: &'static str,
    cursor: Option<&ManagedThreadCursor>,
    limit: usize,
) -> Result<(Vec<ManagedThread>, Option<String>)>
where
    S: GStore + GStoreMut + Planner,
{
    if limit == 0 {
        return Ok((Vec::new(), None));
    }
    let rows = table(table_name)
        .select()
        .project(managed_thread_columns())
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

fn update_observed_recency<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    activity_ms: u64,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    update_observed_recency_in(glue, MANAGED_THREADS_TABLE, thread_id, activity_ms)
}

fn update_observed_recency_in<S>(
    glue: &mut Glue<S>,
    table_name: &'static str,
    thread_id: &str,
    activity_ms: u64,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(existing) = get_in(glue, table_name, thread_id)? else {
        return Ok(None);
    };
    let activity_ms = existing
        .last_observed_recency_ms
        .unwrap_or_default()
        .max(activity_ms);
    table(table_name)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .set(
            "last_observed_recency_ms",
            num(to_db_integer(activity_ms, "last_observed_recency_ms")?),
        )
        .execute(glue)?;
    get_in(glue, table_name, thread_id)
}

fn mark_seen<S>(
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
        max_optional(thread.last_seen_activity_ms, Some(canonical_activity_ms));
    update_all(glue, &thread)?;
    Ok(Some(thread))
}

fn update_composer_settings<S>(
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
    table(MANAGED_THREADS_TABLE)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .set("model", optional_text(model))
        .set("reasoning_effort", optional_text(reasoning_effort))
        .execute(glue)?;
    get(glue, thread_id)
}

fn insert<S>(glue: &mut Glue<S>, thread: &ManagedThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    insert_in(glue, MANAGED_THREADS_TABLE, thread)
}

fn insert_in<S>(glue: &mut Glue<S>, table_name: &'static str, thread: &ManagedThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let row = ManagedThreadRow::try_from(thread)?;
    table(table_name)
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
    table(MANAGED_THREADS_TABLE)
        .update()
        .filter(col("thread_id").eq(text(row.thread_id)))
        .set(
            "last_observed_recency_ms",
            optional_integer(row.last_observed_recency_ms),
        )
        .set("claimed_at_ms", num(row.claimed_at_ms))
        .set("last_opened_at_ms", optional_integer(row.last_opened_at_ms))
        .set(
            "last_seen_activity_ms",
            optional_integer(row.last_seen_activity_ms),
        )
        .set("model", optional_text(row.model.as_deref()))
        .set(
            "reasoning_effort",
            optional_text(row.reasoning_effort.as_deref()),
        )
        .execute(glue)?;
    Ok(())
}

fn delete<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    delete_in(glue, MANAGED_THREADS_TABLE, thread_id)
}

fn delete_in<S>(glue: &mut Glue<S>, table_name: &'static str, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(table_name)
        .delete()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .execute(glue)?;
    let Payload::Delete(count) = payload else {
        return Err(ThreadStoreError::UnexpectedPayload);
    };
    Ok(count > 0)
}

fn move_between<S>(
    glue: &mut Glue<S>,
    source_table: &'static str,
    destination_table: &'static str,
    thread_id: &str,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(thread) = get_in(glue, source_table, thread_id)? else {
        return Ok(None);
    };
    if get_in(glue, destination_table, thread_id)?.is_some() {
        return Err(ThreadStoreError::UnexpectedPayload);
    }
    insert_in(glue, destination_table, &thread)?;
    if !delete_in(glue, source_table, thread_id)? {
        let _ = delete_in(glue, destination_table, thread_id);
        return Err(ThreadStoreError::UnexpectedPayload);
    }
    Ok(Some(thread))
}

fn managed_thread_columns() -> Vec<ExprNode<'static>> {
    ManagedThreadRow::glue_columns()
        .iter()
        .map(|column| col(*column))
        .collect()
}

fn optional_text(value: Option<&str>) -> ExprNode<'static> {
    value.map_or_else(null, |value| text(value.to_owned()))
}

fn optional_integer(value: Option<i64>) -> ExprNode<'static> {
    value.map_or_else(null, num)
}

fn max_optional(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    left.into_iter().chain(right).max()
}

fn to_db_integer(value: u64, field: &'static str) -> Result<i64> {
    value
        .try_into()
        .map_err(|_| ThreadStoreError::InvalidRow(field))
}

fn to_optional_db_integer(value: Option<u64>, field: &'static str) -> Result<Option<i64>> {
    value.map(|value| to_db_integer(value, field)).transpose()
}

fn from_db_integer(value: i64, field: &'static str) -> Result<u64> {
    value
        .try_into()
        .map_err(|_| ThreadStoreError::InvalidRow(field))
}

fn from_optional_db_integer(value: Option<i64>, field: &'static str) -> Result<Option<u64>> {
    value.map(|value| from_db_integer(value, field)).transpose()
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
        .ok_or(ThreadStoreError::InvalidCursor)?;
    let last_observed_recency_ms = if recency == "-" {
        None
    } else {
        Some(
            recency
                .parse()
                .map_err(|_| ThreadStoreError::InvalidCursor)?,
        )
    };
    Ok(Some(ManagedThreadCursor {
        last_observed_recency_ms,
        thread_id: thread_id.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, recency_ms: u64) -> ManagedThread {
        ManagedThread::new(id, Some(recency_ms), None, None)
    }

    #[test]
    fn claims_lists_and_paginates_managed_threads_by_observed_recency() {
        let store = ThreadStore::memory().unwrap();
        store.claim(thread("older", 20), 100).unwrap();
        store.claim(thread("newer", 30), 110).unwrap();

        let (first, cursor) = store.list(None, 1).unwrap();
        assert_eq!(first[0].thread_id, "newer");
        let (second, cursor) = store.list(cursor.as_deref(), 1).unwrap();
        assert_eq!(second[0].thread_id, "older");
        assert!(cursor.is_none());
    }

    #[test]
    fn pagination_cursor_survives_recency_updates_to_the_previous_page() {
        let store = ThreadStore::memory().unwrap();
        store.claim(thread("first", 40), 100).unwrap();
        store.claim(thread("second", 30), 100).unwrap();
        store.claim(thread("third", 20), 100).unwrap();

        let (first_page, cursor) = store.list(None, 2).unwrap();
        assert_eq!(
            first_page
                .iter()
                .map(|thread| thread.thread_id.as_str())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        store.update_observed_recency("second", 50).unwrap();

        let (second_page, cursor) = store.list(cursor.as_deref(), 2).unwrap();
        assert_eq!(second_page[0].thread_id, "third");
        assert!(cursor.is_none());
    }

    #[test]
    fn recency_seen_and_composer_settings_are_the_only_mutable_metadata() {
        let store = ThreadStore::memory().unwrap();
        let claimed = store.claim(thread("task", 20), 100).unwrap();
        assert_eq!(claimed.claimed_at_ms, 100);
        assert_eq!(claimed.last_seen_activity_ms, Some(20));

        store
            .update_composer_settings("task", Some("gpt-test"), Some("xhigh"))
            .unwrap();
        let refreshed = store.update_observed_recency("task", 40).unwrap().unwrap();
        assert_eq!(refreshed.claimed_at_ms, 100);
        assert_eq!(refreshed.last_seen_activity_ms, Some(20));
        assert_eq!(refreshed.model.as_deref(), Some("gpt-test"));
        assert_eq!(refreshed.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(refreshed.unseen(40));

        let seen = store.mark_seen("task", 40, 150).unwrap().unwrap();
        assert_eq!(seen.last_opened_at_ms, Some(150));
        assert_eq!(seen.last_seen_activity_ms, Some(40));
        assert!(!seen.unseen(40));
    }

    #[test]
    fn archive_and_restore_move_membership_without_losing_metadata() {
        let store = ThreadStore::memory().unwrap();
        let mut managed = thread("task", 40);
        managed.model = Some("gpt-test".to_string());
        managed.reasoning_effort = Some("xhigh".to_string());
        let claimed = store.claim(managed, 100).unwrap();

        let archived = store.archive("task").unwrap().unwrap();
        assert_eq!(archived, claimed);
        assert!(store.get("task").unwrap().is_none());
        assert_eq!(store.get_archived("task").unwrap(), Some(claimed.clone()));
        assert_eq!(store.list(None, 30).unwrap().0, Vec::new());
        assert_eq!(
            store.list_archived(None, 30).unwrap().0,
            vec![claimed.clone()]
        );

        let restored = store.restore("task").unwrap().unwrap();
        assert_eq!(restored, claimed);
        assert_eq!(store.get("task").unwrap(), Some(claimed));
        assert!(store.get_archived("task").unwrap().is_none());
        assert!(store.list_archived(None, 30).unwrap().0.is_empty());
    }

    #[test]
    fn archived_membership_survives_redb_reopen() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("caffold.redb");
        {
            let store = ThreadStore::redb(&path).unwrap();
            store.claim(thread("persisted", 20), 100).unwrap();
            store.archive("persisted").unwrap().unwrap();
        }
        let store = ThreadStore::redb(&path).unwrap();
        assert!(store.get("persisted").unwrap().is_none());
        assert_eq!(
            store.get_archived("persisted").unwrap().unwrap().thread_id,
            "persisted"
        );
    }

    #[test]
    fn query_builder_round_trips_literal_text_without_manual_escaping() {
        let store = ThreadStore::memory().unwrap();
        let quoted = ManagedThread::new(
            "task'quoted",
            Some(20),
            Some("model'quoted".to_string()),
            Some("reasoning'quoted".to_string()),
        );

        store.claim(quoted.clone(), 100).unwrap();
        let stored = store.get(&quoted.thread_id).unwrap().unwrap();
        assert_eq!(stored.model, quoted.model);
        assert_eq!(stored.reasoning_effort, quoted.reasoning_effort);
        assert!(store.delete(&quoted.thread_id).unwrap());
        assert!(store.get(&quoted.thread_id).unwrap().is_none());
    }

    #[test]
    fn redb_reopens_the_same_managed_threads_table() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("caffold.redb");
        {
            let store = ThreadStore::redb(&path).unwrap();
            store.claim(thread("persisted", 20), 100).unwrap();
        }
        let store = ThreadStore::redb(&path).unwrap();
        assert_eq!(
            store.get("persisted").unwrap().unwrap().thread_id,
            "persisted"
        );
    }
}
