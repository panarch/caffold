use std::{
    collections::HashMap,
    path::Path,
    sync::{Arc, Mutex, MutexGuard},
};

use gluesql::{
    core::{
        data::Value,
        executor::Payload,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Error as GlueError, Glue, MemoryStorage, RedbStorage},
};
use thiserror::Error;

const CREATE_THREADS_TABLE: &str = "
    CREATE TABLE IF NOT EXISTS threads (
        thread_id TEXT PRIMARY KEY,
        title TEXT,
        preview TEXT,
        cwd TEXT,
        created_ms INTEGER,
        updated_ms INTEGER,
        recency_ms INTEGER NULL,
        activity_ms INTEGER,
        status TEXT,
        active_turn_id TEXT NULL,
        active_turn_started_ms INTEGER NULL,
        last_event_summary TEXT NULL,
        claimed_at_ms INTEGER,
        last_opened_at_ms INTEGER NULL,
        last_seen_activity_ms INTEGER NULL
    )
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoredThread {
    pub thread_id: String,
    pub title: String,
    pub preview: String,
    pub cwd: String,
    pub created_ms: u64,
    pub updated_ms: u64,
    pub recency_ms: Option<u64>,
    pub status: String,
    pub active_turn_id: Option<String>,
    pub active_turn_started_ms: Option<u64>,
    pub last_event_summary: Option<String>,
    pub claimed_at_ms: u64,
    pub last_opened_at_ms: Option<u64>,
    pub last_seen_activity_ms: Option<u64>,
}

impl StoredThread {
    pub(crate) fn activity_ms(&self) -> u64 {
        self.recency_ms
            .unwrap_or(self.updated_ms)
            .max(self.created_ms)
    }

    pub(crate) fn unseen(&self) -> bool {
        matches!(
            self.status.as_str(),
            "" | "completed" | "idle" | "notLoaded"
        ) && self
            .last_seen_activity_ms
            .is_none_or(|seen| self.activity_ms() > seen)
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

    pub(crate) fn claim(&self, thread: StoredThread, now_ms: u64) -> Result<StoredThread> {
        match self {
            Self::Memory(glue) => claim(&mut *lock_glue(glue)?, thread, now_ms),
            Self::Redb(glue) => claim(&mut *lock_glue(glue)?, thread, now_ms),
        }
    }

    pub(crate) fn get(&self, thread_id: &str) -> Result<Option<StoredThread>> {
        match self {
            Self::Memory(glue) => get(&mut *lock_glue(glue)?, thread_id),
            Self::Redb(glue) => get(&mut *lock_glue(glue)?, thread_id),
        }
    }

    pub(crate) fn list(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<StoredThread>, Option<String>)> {
        let offset = decode_cursor(cursor)?;
        match self {
            Self::Memory(glue) => list(&mut *lock_glue(glue)?, offset, limit),
            Self::Redb(glue) => list(&mut *lock_glue(glue)?, offset, limit),
        }
    }

    pub(crate) fn update_projection(&self, thread: &StoredThread) -> Result<Option<StoredThread>> {
        match self {
            Self::Memory(glue) => update_projection(&mut *lock_glue(glue)?, thread),
            Self::Redb(glue) => update_projection(&mut *lock_glue(glue)?, thread),
        }
    }

    pub(crate) fn mark_seen(
        &self,
        thread_id: &str,
        opened_at_ms: u64,
    ) -> Result<Option<StoredThread>> {
        match self {
            Self::Memory(glue) => mark_seen(&mut *lock_glue(glue)?, thread_id, opened_at_ms),
            Self::Redb(glue) => mark_seen(&mut *lock_glue(glue)?, thread_id, opened_at_ms),
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
    glue.execute(CREATE_THREADS_TABLE)?;
    Ok(())
}

fn claim<S>(glue: &mut Glue<S>, mut thread: StoredThread, now_ms: u64) -> Result<StoredThread>
where
    S: GStore + GStoreMut + Planner,
{
    if let Some(existing) = get(glue, &thread.thread_id)? {
        thread.claimed_at_ms = existing.claimed_at_ms;
    } else {
        thread.claimed_at_ms = now_ms;
    }
    thread.last_opened_at_ms = Some(thread.last_opened_at_ms.unwrap_or_default().max(now_ms));
    thread.last_seen_activity_ms = Some(
        thread
            .last_seen_activity_ms
            .unwrap_or_default()
            .max(thread.activity_ms()),
    );

    if get(glue, &thread.thread_id)?.is_some() {
        update_all(glue, &thread)?;
    } else {
        insert(glue, &thread)?;
    }
    Ok(thread)
}

fn get<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<Option<StoredThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = select_rows(glue.execute(format!(
        "{} WHERE thread_id = {}",
        select_columns(),
        sql_string(thread_id)
    ))?)?;
    rows.first().map(stored_thread_from_row).transpose()
}

fn list<S>(
    glue: &mut Glue<S>,
    offset: usize,
    limit: usize,
) -> Result<(Vec<StoredThread>, Option<String>)>
where
    S: GStore + GStoreMut + Planner,
{
    if limit == 0 {
        return Ok((Vec::new(), None));
    }
    let rows = select_rows(glue.execute(format!(
        "{} ORDER BY activity_ms DESC, thread_id ASC LIMIT {} OFFSET {}",
        select_columns(),
        limit.saturating_add(1),
        offset
    ))?)?;
    let mut threads = rows
        .iter()
        .map(stored_thread_from_row)
        .collect::<Result<Vec<_>>>()?;
    let has_more = threads.len() > limit;
    threads.truncate(limit);
    let next_cursor = has_more.then(|| encode_cursor(offset.saturating_add(limit)));
    Ok((threads, next_cursor))
}

fn update_projection<S>(glue: &mut Glue<S>, thread: &StoredThread) -> Result<Option<StoredThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(mut existing) = get(glue, &thread.thread_id)? else {
        return Ok(None);
    };
    existing.title.clone_from(&thread.title);
    existing.preview.clone_from(&thread.preview);
    existing.cwd.clone_from(&thread.cwd);
    existing.created_ms = thread.created_ms;
    existing.updated_ms = thread.updated_ms;
    existing.recency_ms = thread.recency_ms;
    existing.status.clone_from(&thread.status);
    existing.active_turn_id.clone_from(&thread.active_turn_id);
    existing.active_turn_started_ms = thread.active_turn_started_ms;
    existing
        .last_event_summary
        .clone_from(&thread.last_event_summary);
    update_all(glue, &existing)?;
    Ok(Some(existing))
}

fn mark_seen<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    opened_at_ms: u64,
) -> Result<Option<StoredThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(mut thread) = get(glue, thread_id)? else {
        return Ok(None);
    };
    thread.last_opened_at_ms = Some(
        thread
            .last_opened_at_ms
            .unwrap_or_default()
            .max(opened_at_ms),
    );
    thread.last_seen_activity_ms = Some(
        thread
            .last_seen_activity_ms
            .unwrap_or_default()
            .max(thread.activity_ms()),
    );
    update_all(glue, &thread)?;
    Ok(Some(thread))
}

fn insert<S>(glue: &mut Glue<S>, thread: &StoredThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    glue.execute(format!(
        "INSERT INTO threads VALUES ({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})",
        sql_string(&thread.thread_id),
        sql_string(&thread.title),
        sql_string(&thread.preview),
        sql_string(&thread.cwd),
        thread.created_ms,
        thread.updated_ms,
        sql_optional_u64(thread.recency_ms),
        thread.activity_ms(),
        sql_string(&thread.status),
        sql_optional_string(thread.active_turn_id.as_deref()),
        sql_optional_u64(thread.active_turn_started_ms),
        sql_optional_string(thread.last_event_summary.as_deref()),
        thread.claimed_at_ms,
        sql_optional_u64(thread.last_opened_at_ms),
        sql_optional_u64(thread.last_seen_activity_ms),
    ))?;
    Ok(())
}

fn update_all<S>(glue: &mut Glue<S>, thread: &StoredThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    glue.execute(format!(
        "UPDATE threads SET title = {}, preview = {}, cwd = {}, created_ms = {}, updated_ms = {}, recency_ms = {}, activity_ms = {}, status = {}, active_turn_id = {}, active_turn_started_ms = {}, last_event_summary = {}, claimed_at_ms = {}, last_opened_at_ms = {}, last_seen_activity_ms = {} WHERE thread_id = {}",
        sql_string(&thread.title),
        sql_string(&thread.preview),
        sql_string(&thread.cwd),
        thread.created_ms,
        thread.updated_ms,
        sql_optional_u64(thread.recency_ms),
        thread.activity_ms(),
        sql_string(&thread.status),
        sql_optional_string(thread.active_turn_id.as_deref()),
        sql_optional_u64(thread.active_turn_started_ms),
        sql_optional_string(thread.last_event_summary.as_deref()),
        thread.claimed_at_ms,
        sql_optional_u64(thread.last_opened_at_ms),
        sql_optional_u64(thread.last_seen_activity_ms),
        sql_string(&thread.thread_id),
    ))?;
    Ok(())
}

fn delete<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payloads = glue.execute(format!(
        "DELETE FROM threads WHERE thread_id = {}",
        sql_string(thread_id)
    ))?;
    let Some(Payload::Delete(count)) = payloads.into_iter().next() else {
        return Err(ThreadStoreError::UnexpectedPayload);
    };
    Ok(count > 0)
}

fn select_columns() -> &'static str {
    "SELECT thread_id, title, preview, cwd, created_ms, updated_ms, recency_ms, status, active_turn_id, active_turn_started_ms, last_event_summary, claimed_at_ms, last_opened_at_ms, last_seen_activity_ms FROM threads"
}

fn select_rows(payloads: Vec<Payload>) -> Result<Vec<HashMap<String, Value>>> {
    let Some(Payload::Select { labels, rows }) = payloads.into_iter().next() else {
        return Err(ThreadStoreError::UnexpectedPayload);
    };
    Ok(rows
        .into_iter()
        .map(|row| labels.iter().cloned().zip(row).collect())
        .collect())
}

fn stored_thread_from_row(row: &HashMap<String, Value>) -> Result<StoredThread> {
    Ok(StoredThread {
        thread_id: required_string(row, "thread_id")?,
        title: required_string(row, "title")?,
        preview: required_string(row, "preview")?,
        cwd: required_string(row, "cwd")?,
        created_ms: required_u64(row, "created_ms")?,
        updated_ms: required_u64(row, "updated_ms")?,
        recency_ms: optional_u64(row, "recency_ms")?,
        status: required_string(row, "status")?,
        active_turn_id: optional_string(row, "active_turn_id")?,
        active_turn_started_ms: optional_u64(row, "active_turn_started_ms")?,
        last_event_summary: optional_string(row, "last_event_summary")?,
        claimed_at_ms: required_u64(row, "claimed_at_ms")?,
        last_opened_at_ms: optional_u64(row, "last_opened_at_ms")?,
        last_seen_activity_ms: optional_u64(row, "last_seen_activity_ms")?,
    })
}

fn required_string(row: &HashMap<String, Value>, key: &'static str) -> Result<String> {
    match row.get(key) {
        Some(Value::Str(value)) => Ok(value.clone()),
        _ => Err(ThreadStoreError::InvalidRow(key)),
    }
}

fn optional_string(row: &HashMap<String, Value>, key: &'static str) -> Result<Option<String>> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::Str(value)) => Ok(Some(value.clone())),
        _ => Err(ThreadStoreError::InvalidRow(key)),
    }
}

fn required_u64(row: &HashMap<String, Value>, key: &'static str) -> Result<u64> {
    match row.get(key) {
        Some(Value::I64(value)) if *value >= 0 => Ok(*value as u64),
        Some(Value::U64(value)) => Ok(*value),
        _ => Err(ThreadStoreError::InvalidRow(key)),
    }
}

fn optional_u64(row: &HashMap<String, Value>, key: &'static str) -> Result<Option<u64>> {
    match row.get(key) {
        Some(Value::Null) | None => Ok(None),
        Some(Value::I64(value)) if *value >= 0 => Ok(Some(*value as u64)),
        Some(Value::U64(value)) => Ok(Some(*value)),
        _ => Err(ThreadStoreError::InvalidRow(key)),
    }
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn sql_optional_string(value: Option<&str>) -> String {
    value.map_or_else(|| "NULL".to_string(), sql_string)
}

fn sql_optional_u64(value: Option<u64>) -> String {
    value.map_or_else(|| "NULL".to_string(), |value| value.to_string())
}

fn encode_cursor(offset: usize) -> String {
    format!("v1:{offset}")
}

fn decode_cursor(cursor: Option<&str>) -> Result<usize> {
    let Some(cursor) = cursor.map(str::trim).filter(|cursor| !cursor.is_empty()) else {
        return Ok(0);
    };
    cursor
        .strip_prefix("v1:")
        .and_then(|value| value.parse().ok())
        .ok_or(ThreadStoreError::InvalidCursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn thread(id: &str, activity_ms: u64) -> StoredThread {
        StoredThread {
            thread_id: id.to_string(),
            title: format!("Task {id}"),
            preview: String::new(),
            cwd: "/tmp/project".to_string(),
            created_ms: 10,
            updated_ms: activity_ms,
            recency_ms: None,
            status: "idle".to_string(),
            active_turn_id: None,
            active_turn_started_ms: None,
            last_event_summary: None,
            claimed_at_ms: 0,
            last_opened_at_ms: None,
            last_seen_activity_ms: None,
        }
    }

    #[test]
    fn claims_lists_and_paginates_threads_by_activity() {
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
    fn projection_updates_preserve_caffold_metadata() {
        let store = ThreadStore::memory().unwrap();
        let claimed = store.claim(thread("task", 20), 100).unwrap();
        assert_eq!(claimed.claimed_at_ms, 100);
        assert_eq!(claimed.last_seen_activity_ms, Some(20));

        let mut refreshed = thread("task", 40);
        refreshed.title = "Refreshed title".to_string();
        let refreshed = store.update_projection(&refreshed).unwrap().unwrap();
        assert_eq!(refreshed.title, "Refreshed title");
        assert_eq!(refreshed.claimed_at_ms, 100);
        assert_eq!(refreshed.last_seen_activity_ms, Some(20));
        assert!(refreshed.unseen());

        let seen = store.mark_seen("task", 150).unwrap().unwrap();
        assert_eq!(seen.last_opened_at_ms, Some(150));
        assert_eq!(seen.last_seen_activity_ms, Some(40));
        assert!(!seen.unseen());
    }

    #[test]
    fn redb_reopens_the_same_single_database_file() {
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
