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

const THREADS_TABLE: &str = "threads";

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
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct StoredThreadRow {
    thread_id: String,
    title: String,
    preview: String,
    cwd: String,
    created_ms: i64,
    updated_ms: i64,
    recency_ms: Option<i64>,
    activity_ms: i64,
    status: String,
    active_turn_id: Option<String>,
    active_turn_started_ms: Option<i64>,
    last_event_summary: Option<String>,
    claimed_at_ms: i64,
    last_opened_at_ms: Option<i64>,
    last_seen_activity_ms: Option<i64>,
    model: Option<String>,
    reasoning_effort: Option<String>,
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

impl TryFrom<&StoredThread> for StoredThreadRow {
    type Error = ThreadStoreError;

    fn try_from(thread: &StoredThread) -> Result<Self> {
        Ok(Self {
            thread_id: thread.thread_id.clone(),
            title: thread.title.clone(),
            preview: thread.preview.clone(),
            cwd: thread.cwd.clone(),
            created_ms: to_db_integer(thread.created_ms, "created_ms")?,
            updated_ms: to_db_integer(thread.updated_ms, "updated_ms")?,
            recency_ms: to_optional_db_integer(thread.recency_ms, "recency_ms")?,
            activity_ms: to_db_integer(thread.activity_ms(), "activity_ms")?,
            status: thread.status.clone(),
            active_turn_id: thread.active_turn_id.clone(),
            active_turn_started_ms: to_optional_db_integer(
                thread.active_turn_started_ms,
                "active_turn_started_ms",
            )?,
            last_event_summary: thread.last_event_summary.clone(),
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

impl TryFrom<StoredThreadRow> for StoredThread {
    type Error = ThreadStoreError;

    fn try_from(row: StoredThreadRow) -> Result<Self> {
        from_db_integer(row.activity_ms, "activity_ms")?;
        Ok(Self {
            thread_id: row.thread_id,
            title: row.title,
            preview: row.preview,
            cwd: row.cwd,
            created_ms: from_db_integer(row.created_ms, "created_ms")?,
            updated_ms: from_db_integer(row.updated_ms, "updated_ms")?,
            recency_ms: from_optional_db_integer(row.recency_ms, "recency_ms")?,
            status: row.status,
            active_turn_id: row.active_turn_id,
            active_turn_started_ms: from_optional_db_integer(
                row.active_turn_started_ms,
                "active_turn_started_ms",
            )?,
            last_event_summary: row.last_event_summary,
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

    pub(crate) fn update_composer_settings(
        &self,
        thread_id: &str,
        model: Option<&str>,
        reasoning_effort: Option<&str>,
    ) -> Result<Option<StoredThread>> {
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
    table(THREADS_TABLE)
        .create_table_if_not_exists()
        .add_column("thread_id TEXT PRIMARY KEY")
        .add_column("title TEXT")
        .add_column("preview TEXT")
        .add_column("cwd TEXT")
        .add_column("created_ms INTEGER")
        .add_column("updated_ms INTEGER")
        .add_column("recency_ms INTEGER NULL")
        .add_column("activity_ms INTEGER")
        .add_column("status TEXT")
        .add_column("active_turn_id TEXT NULL")
        .add_column("active_turn_started_ms INTEGER NULL")
        .add_column("last_event_summary TEXT NULL")
        .add_column("claimed_at_ms INTEGER")
        .add_column("last_opened_at_ms INTEGER NULL")
        .add_column("last_seen_activity_ms INTEGER NULL")
        .add_column("model TEXT NULL")
        .add_column("reasoning_effort TEXT NULL")
        .execute(glue)?;
    Ok(())
}

fn claim<S>(glue: &mut Glue<S>, mut thread: StoredThread, now_ms: u64) -> Result<StoredThread>
where
    S: GStore + GStoreMut + Planner,
{
    if let Some(existing) = get(glue, &thread.thread_id)? {
        thread.claimed_at_ms = existing.claimed_at_ms;
        if thread.model.is_none() {
            thread.model = existing.model;
        }
        if thread.reasoning_effort.is_none() {
            thread.reasoning_effort = existing.reasoning_effort;
        }
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
    let rows = table(THREADS_TABLE)
        .select()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .project(stored_thread_columns())
        .limit(2)
        .execute(glue)
        .rows_as::<StoredThreadRow>()?;
    match rows.as_slice() {
        [] => Ok(None),
        [row] => Ok(Some(row.clone().try_into()?)),
        _ => Err(ThreadStoreError::UnexpectedPayload),
    }
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
    let page_size = limit.saturating_add(1);
    let rows = table(THREADS_TABLE)
        .select()
        .project(stored_thread_columns())
        .order_by(vec![col("activity_ms").desc(), col("thread_id").asc()])
        .offset(num(to_query_integer(offset, "offset")?))
        .limit(num(to_query_integer(page_size, "limit")?))
        .execute(glue)
        .rows_as::<StoredThreadRow>()?;
    let mut threads = rows
        .into_iter()
        .map(TryInto::try_into)
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

fn update_composer_settings<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
) -> Result<Option<StoredThread>>
where
    S: GStore + GStoreMut + Planner,
{
    if get(glue, thread_id)?.is_none() {
        return Ok(None);
    }
    table(THREADS_TABLE)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .set("model", optional_text(model))
        .set("reasoning_effort", optional_text(reasoning_effort))
        .execute(glue)?;
    get(glue, thread_id)
}

fn insert<S>(glue: &mut Glue<S>, thread: &StoredThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let row = StoredThreadRow::try_from(thread)?;
    table(THREADS_TABLE)
        .insert()
        .values_from(std::slice::from_ref(&row))?
        .execute(glue)?;
    Ok(())
}

fn update_all<S>(glue: &mut Glue<S>, thread: &StoredThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let row = StoredThreadRow::try_from(thread)?;
    table(THREADS_TABLE)
        .update()
        .filter(col("thread_id").eq(text(row.thread_id)))
        .set("title", text(row.title))
        .set("preview", text(row.preview))
        .set("cwd", text(row.cwd))
        .set("created_ms", num(row.created_ms))
        .set("updated_ms", num(row.updated_ms))
        .set("recency_ms", optional_integer(row.recency_ms))
        .set("activity_ms", num(row.activity_ms))
        .set("status", text(row.status))
        .set(
            "active_turn_id",
            optional_text(row.active_turn_id.as_deref()),
        )
        .set(
            "active_turn_started_ms",
            optional_integer(row.active_turn_started_ms),
        )
        .set(
            "last_event_summary",
            optional_text(row.last_event_summary.as_deref()),
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
    let payload = table(THREADS_TABLE)
        .delete()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .execute(glue)?;
    let Payload::Delete(count) = payload else {
        return Err(ThreadStoreError::UnexpectedPayload);
    };
    Ok(count > 0)
}

fn stored_thread_columns() -> Vec<ExprNode<'static>> {
    StoredThreadRow::glue_columns()
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

fn to_query_integer(value: usize, field: &'static str) -> Result<u64> {
    value
        .try_into()
        .map_err(|_| ThreadStoreError::InvalidRow(field))
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
            model: None,
            reasoning_effort: None,
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
        store
            .update_composer_settings("task", Some("gpt-test"), Some("xhigh"))
            .unwrap();

        let mut refreshed = thread("task", 40);
        refreshed.title = "Refreshed title".to_string();
        let refreshed = store.update_projection(&refreshed).unwrap().unwrap();
        assert_eq!(refreshed.title, "Refreshed title");
        assert_eq!(refreshed.claimed_at_ms, 100);
        assert_eq!(refreshed.last_seen_activity_ms, Some(20));
        assert_eq!(refreshed.model.as_deref(), Some("gpt-test"));
        assert_eq!(refreshed.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(refreshed.unseen());

        let seen = store.mark_seen("task", 150).unwrap().unwrap();
        assert_eq!(seen.last_opened_at_ms, Some(150));
        assert_eq!(seen.last_seen_activity_ms, Some(40));
        assert!(!seen.unseen());
    }

    #[test]
    fn query_builder_round_trips_literal_text_without_manual_escaping() {
        let store = ThreadStore::memory().unwrap();
        let mut quoted = thread("task'quoted", 20);
        quoted.title = "Don't escape this by hand".to_string();
        quoted.preview = "It's GlueSQL's job".to_string();
        quoted.cwd = "/tmp/it's-a-project".to_string();

        store.claim(quoted.clone(), 100).unwrap();
        store
            .update_composer_settings(
                &quoted.thread_id,
                Some("model'quoted"),
                Some("reasoning'quoted"),
            )
            .unwrap();

        let stored = store.get(&quoted.thread_id).unwrap().unwrap();
        assert_eq!(stored.title, quoted.title);
        assert_eq!(stored.preview, quoted.preview);
        assert_eq!(stored.cwd, quoted.cwd);
        assert_eq!(stored.model.as_deref(), Some("model'quoted"));
        assert_eq!(stored.reasoning_effort.as_deref(), Some("reasoning'quoted"));
        assert!(store.delete(&quoted.thread_id).unwrap());
        assert!(store.get(&quoted.thread_id).unwrap().is_none());
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

    #[test]
    fn redb_accepts_the_manual_composer_settings_alter() {
        #[derive(gluesql::ToGlueRow)]
        struct LegacyStoredThreadRow {
            thread_id: String,
            title: String,
            preview: String,
            cwd: String,
            created_ms: i64,
            updated_ms: i64,
            recency_ms: Option<i64>,
            activity_ms: i64,
            status: String,
            active_turn_id: Option<String>,
            active_turn_started_ms: Option<i64>,
            last_event_summary: Option<String>,
            claimed_at_ms: i64,
            last_opened_at_ms: Option<i64>,
            last_seen_activity_ms: Option<i64>,
        }

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("caffold.redb");
        {
            let storage = RedbStorage::new(&path).unwrap();
            let mut glue = Glue::new(storage);
            table(THREADS_TABLE)
                .create_table()
                .add_column("thread_id TEXT PRIMARY KEY")
                .add_column("title TEXT")
                .add_column("preview TEXT")
                .add_column("cwd TEXT")
                .add_column("created_ms INTEGER")
                .add_column("updated_ms INTEGER")
                .add_column("recency_ms INTEGER NULL")
                .add_column("activity_ms INTEGER")
                .add_column("status TEXT")
                .add_column("active_turn_id TEXT NULL")
                .add_column("active_turn_started_ms INTEGER NULL")
                .add_column("last_event_summary TEXT NULL")
                .add_column("claimed_at_ms INTEGER")
                .add_column("last_opened_at_ms INTEGER NULL")
                .add_column("last_seen_activity_ms INTEGER NULL")
                .execute(&mut glue)
                .unwrap();
            let legacy = LegacyStoredThreadRow {
                thread_id: "legacy".to_string(),
                title: "Legacy task".to_string(),
                preview: String::new(),
                cwd: "/tmp/project".to_string(),
                created_ms: 1,
                updated_ms: 2,
                recency_ms: None,
                activity_ms: 2,
                status: "idle".to_string(),
                active_turn_id: None,
                active_turn_started_ms: None,
                last_event_summary: None,
                claimed_at_ms: 3,
                last_opened_at_ms: None,
                last_seen_activity_ms: None,
            };
            table(THREADS_TABLE)
                .insert()
                .values_from(&[legacy])
                .unwrap()
                .execute(&mut glue)
                .unwrap();
            table(THREADS_TABLE)
                .alter_table()
                .add_column("model TEXT NULL")
                .execute(&mut glue)
                .unwrap();
            table(THREADS_TABLE)
                .alter_table()
                .add_column("reasoning_effort TEXT NULL")
                .execute(&mut glue)
                .unwrap();
            table(THREADS_TABLE)
                .update()
                .filter(col("thread_id").eq(text("legacy")))
                .set("model", text("gpt-test"))
                .set("reasoning_effort", text("xhigh"))
                .execute(&mut glue)
                .unwrap();
        }

        let store = ThreadStore::redb(&path).unwrap();
        let legacy = store.get("legacy").unwrap().unwrap();
        assert_eq!(legacy.title, "Legacy task");
        assert_eq!(legacy.model.as_deref(), Some("gpt-test"));
        assert_eq!(legacy.reasoning_effort.as_deref(), Some("xhigh"));
    }
}
