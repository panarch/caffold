//! Consistent read-only snapshots of the pinned native SQLite trajectory.
//!
//! Native primary keys order items; execution_id groups turns and executor
//! metadata ends them. ACP request IDs and arrival order never enter this read.

mod deletion;
mod format;
mod translate;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;
use std::{
    io::ErrorKind,
    sync::{Arc, RwLock},
};

use prost::Message;
use rusqlite::{Connection, OpenFlags, Row, Transaction};
use uuid::Uuid;

use super::AntigravityError;
use crate::agent::{Conversation, ItemKind, ThreadStatus, TokenCount, TokenUsage, TurnPage};
use format::{ExecutorMetadata, Step, StepMetadata, TrajectoryMetadata};

const MAX_READ_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone)]
pub(super) struct Records {
    directory: PathBuf,
    access: Arc<RwLock<()>>,
}

#[derive(Debug)]
pub(super) struct Snapshot {
    pub(super) page: TurnPage,
    pub(super) usage: BTreeMap<String, TokenCount>,
    pub(super) total_usage: TokenCount,
    pub(super) created_at_ms: u64,
    pub(super) updated_at_ms: u64,
    pub(super) preview: String,
}

struct RowMetadata {
    idx: i64,
    kind: i32,
    status: i32,
    metadata: StepMetadata,
}

struct Execution {
    id: String,
    rows: Vec<RowMetadata>,
}

struct Cursor {
    trajectory: String,
    first_idx: i64,
}

impl Records {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            access: Arc::new(RwLock::new(())),
        }
    }

    pub(super) fn path(&self, session: &str) -> Result<PathBuf, AntigravityError> {
        validate_session(session)?;
        // Resolve the configured root (including macOS's /var alias), then
        // retain NOFOLLOW for the exact native file and its sidecars.
        let directory = fs::canonicalize(&self.directory).map_err(|error| {
            if error.kind() == ErrorKind::NotFound {
                AntigravityError::ConversationGone(self.directory.display().to_string())
            } else {
                invalid(&format!("cannot resolve native record directory: {error}"))
            }
        })?;
        Ok(directory.join(format!("{session}.db")))
    }

    pub(super) fn read(
        &self,
        session: &str,
        before: Option<&str>,
        limit: usize,
    ) -> Result<Snapshot, AntigravityError> {
        let _access = self
            .access
            .read()
            .map_err(|_| invalid("native record access lock failed"))?;
        let path = self.path(session)?;
        validate_files(&path)?;
        let mut connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(sql_error)?;
        connection
            .busy_timeout(Duration::from_millis(250))
            .map_err(sql_error)?;
        connection
            .pragma_update(None, "query_only", true)
            .map_err(sql_error)?;
        let tx = connection.transaction().map_err(sql_error)?;
        let (trajectory, cascade) = read_identity(&tx)?;
        if cascade != session {
            return Err(invalid("native cascade does not match the Task binding"));
        }
        let cursor = before.map(Cursor::parse).transpose()?;
        if cursor
            .as_ref()
            .is_some_and(|cursor| cursor.trajectory != trajectory)
        {
            return Err(invalid("history cursor belongs to another trajectory"));
        }
        let mut budget = MAX_READ_BYTES;
        let (executions, usage, created, updated) = read_metadata(&tx, &mut budget)?;
        let terminal = read_executors(&tx, &mut budget)?;
        let end = match cursor.as_ref() {
            Some(cursor) => executions
                .iter()
                .position(|execution| {
                    execution
                        .rows
                        .first()
                        .is_some_and(|row| row.idx == cursor.first_idx)
                })
                .ok_or_else(|| invalid("history cursor no longer names a native turn"))?,
            None => executions.len(),
        };
        let start = end.saturating_sub(limit.clamp(1, 100));
        let selected = &executions[start..end];
        let indices = selected
            .iter()
            .flat_map(|execution| execution.rows.iter().map(|row| row.idx))
            .collect::<HashSet<_>>();
        let mut payloads = HashMap::new();
        if let (Some(first), Some(last)) = (indices.iter().min(), indices.iter().max()) {
            let mut stmt=tx.prepare("SELECT idx,length(step_payload),step_payload FROM steps WHERE idx >= ?1 AND idx <= ?2 ORDER BY idx").map_err(sql_error)?;
            let mut rows = stmt.query([first, last]).map_err(sql_error)?;
            while let Some(row) = rows.next().map_err(sql_error)? {
                let idx = row.get::<_, i64>(0).map_err(sql_error)?;
                if !indices.contains(&idx) {
                    continue;
                }
                let payload = bounded_blob(row, 1, 2, &mut budget)?;
                let step = Step::decode(payload.as_slice())
                    .map_err(|error| invalid(&format!("invalid step {idx}: {error}")))?;
                payloads.insert(idx, step);
            }
        }
        let mut turns = Vec::new();
        for execution in selected {
            let mut steps = Vec::with_capacity(execution.rows.len());
            for row in &execution.rows {
                let step = payloads
                    .remove(&row.idx)
                    .ok_or_else(|| invalid("native step payload is missing"))?;
                if step.kind != row.kind
                    || step.status != row.status
                    || step
                        .payload
                        .as_ref()
                        .is_some_and(|payload| payload.native_type() != step.kind)
                    || step
                        .metadata
                        .as_ref()
                        .is_none_or(|metadata| metadata.execution_id != execution.id)
                {
                    return Err(invalid(
                        "native row and payload disagree about type, status or execution",
                    ));
                }
                // The native store keeps a separately indexed metadata blob.
                // Tool-call fields may differ; usage must remain the exact
                // model accounting attached to this native step.
                if step
                    .metadata
                    .as_ref()
                    .and_then(|metadata| metadata.model_usage.as_ref())
                    != row.metadata.model_usage.as_ref()
                {
                    return Err(invalid("native usage metadata disagrees with its step"));
                }
                steps.push((row.idx, step));
            }
            turns.push(translate::turn(
                &trajectory,
                &execution.id,
                &steps,
                terminal.get(&execution.id),
            )?);
        }
        let preview = turns
            .last()
            .and_then(|turn| {
                turn.items.iter().rev().find_map(|item| match &item.kind {
                    ItemKind::UserMessage { text, .. } => Some(text.clone()),
                    _ => None,
                })
            })
            .unwrap_or_default();
        turns.reverse();
        let next_cursor = (start > 0).then(|| {
            Cursor {
                trajectory: trajectory.clone(),
                first_idx: selected[0].rows[0].idx,
            }
            .encode()
        });
        let mut stmt = tx
            .prepare("SELECT length(data),data FROM trajectory_metadata_blob WHERE id='main'")
            .map_err(sql_error)?;
        let mut rows = stmt.query([]).map_err(sql_error)?;
        let created_blob = rows
            .next()
            .map_err(sql_error)?
            .map(|row| bounded_blob(row, 0, 1, &mut budget))
            .transpose()?;
        let native_created = created_blob
            .map(|blob| {
                TrajectoryMetadata::decode(blob.as_slice())
                    .map_err(|error| invalid(&format!("invalid trajectory metadata: {error}")))
            })
            .transpose()?
            .and_then(|metadata| translate::timestamp_ms(metadata.created_at.as_ref()));
        let total_usage = usage
            .values()
            .try_fold(translate::empty_usage(), translate::add_usage)?;
        Ok(Snapshot {
            page: TurnPage {
                turns,
                next_cursor,
                backwards_cursor: None,
            },
            usage,
            total_usage,
            created_at_ms: native_created.or(created).unwrap_or(0),
            updated_at_ms: updated.or(created).unwrap_or(0),
            preview,
        })
    }
}

impl Records {
    /// Wait for in-flight read-only SQLite connections, which can still own
    /// WAL/SHM handles, after the caller has stopped every native writer.
    pub(super) fn erase(&self, native: &str) -> Result<(), AntigravityError> {
        let _access = self
            .access
            .write()
            .map_err(|_| invalid("native record access lock failed"))?;
        let root = self
            .directory
            .parent()
            .ok_or_else(|| invalid("native conversations directory has no parent"))?;
        deletion::erase(root, native)
    }
}

impl Snapshot {
    pub(super) fn conversation(
        &self,
        task_id: &str,
        cwd: &str,
        status: ThreadStatus,
        path: &Path,
    ) -> Conversation {
        Conversation {
            id: task_id.to_string(),
            title: None,
            preview: self.preview.clone(),
            status,
            background_work: false,
            cwd: cwd.to_string(),
            transcript_path: Some(path.display().to_string()),
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            recency_at_ms: None,
            turns: Vec::new(),
        }
    }

    pub(super) fn turn_usage(&self, turn_id: &str) -> Option<TokenUsage> {
        self.usage.get(turn_id).map(|last| TokenUsage {
            total: self.total_usage.clone(),
            last: last.clone(),
            model_context_window: None,
        })
    }
}

fn read_identity(tx: &Transaction<'_>) -> Result<(String, String), AntigravityError> {
    let mut stmt = tx
        .prepare("SELECT trajectory_id,cascade_id FROM trajectory_meta LIMIT 2")
        .map_err(sql_error)?;
    let values = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sql_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(sql_error)?;
    if values.len() != 1 {
        return Err(invalid("expected one native main trajectory"));
    }
    let (trajectory, cascade) = values.into_iter().next().expect("one above");
    validate_session(&trajectory)?;
    Ok((trajectory, cascade))
}

type MetadataRead = (
    Vec<Execution>,
    BTreeMap<String, TokenCount>,
    Option<u64>,
    Option<u64>,
);

fn read_metadata(
    tx: &Transaction<'_>,
    budget: &mut usize,
) -> Result<MetadataRead, AntigravityError> {
    let mut stmt=tx.prepare("SELECT idx,step_type,status,step_format,length(metadata),metadata FROM steps ORDER BY idx").map_err(sql_error)?;
    let mut rows = stmt.query([]).map_err(sql_error)?;
    let mut executions: Vec<Execution> = Vec::new();
    let mut positions = HashMap::new();
    let mut usage = BTreeMap::new();
    let mut created: Option<u64> = None;
    let mut updated = None;
    while let Some(row) = rows.next().map_err(sql_error)? {
        let idx = row.get::<_, i64>(0).map_err(sql_error)?;
        let kind = row.get::<_, i32>(1).map_err(sql_error)?;
        let status = row.get::<_, i32>(2).map_err(sql_error)?;
        if idx < 0 || row.get::<_, i32>(3).map_err(sql_error)? != 0 {
            return Err(invalid("unsupported native step index/format"));
        }
        let metadata = StepMetadata::decode(bounded_blob(row, 4, 5, budget)?.as_slice())
            .map_err(|error| invalid(&format!("invalid step metadata {idx}: {error}")))?;
        let observed = translate::timestamp_ms(metadata.created_at.as_ref());
        created = match (created, observed) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        for at in [
            metadata.created_at.as_ref(),
            metadata.viewable_at.as_ref(),
            metadata.started_at.as_ref(),
            metadata.completed_at.as_ref(),
            metadata.last_chunk_at.as_ref(),
        ]
        .into_iter()
        .filter_map(translate::timestamp_ms)
        {
            updated = Some(updated.unwrap_or(0).max(at));
        }
        if metadata.execution_id.is_empty() {
            if kind == 14 || kind == 15 {
                return Err(invalid("native message has no execution identity"));
            }
            continue;
        }
        let execution_id = metadata.execution_id.clone();
        if let Some(model_usage) = &metadata.model_usage {
            let count = translate::token_count(model_usage)?;
            let old = usage
                .remove(&execution_id)
                .unwrap_or_else(translate::empty_usage);
            usage.insert(execution_id.clone(), translate::add_usage(old, &count)?);
        }
        let position = *positions.entry(execution_id.clone()).or_insert_with(|| {
            let at = executions.len();
            executions.push(Execution {
                id: execution_id,
                rows: Vec::new(),
            });
            at
        });
        executions[position].rows.push(RowMetadata {
            idx,
            kind,
            status,
            metadata,
        });
    }
    Ok((executions, usage, created, updated))
}

fn read_executors(
    tx: &Transaction<'_>,
    budget: &mut usize,
) -> Result<HashMap<String, ExecutorMetadata>, AntigravityError> {
    let mut stmt = tx
        .prepare("SELECT idx,length(data),data FROM executor_metadata ORDER BY idx")
        .map_err(sql_error)?;
    let mut rows = stmt.query([]).map_err(sql_error)?;
    let mut result = HashMap::new();
    while let Some(row) = rows.next().map_err(sql_error)? {
        let value = ExecutorMetadata::decode(bounded_blob(row, 1, 2, budget)?.as_slice())
            .map_err(|error| invalid(&format!("invalid executor metadata: {error}")))?;
        if value.execution_id.is_empty() || value.last_step_idx < 0 {
            return Err(invalid(
                "native executor has no valid execution/step identity",
            ));
        }
        if result.insert(value.execution_id.clone(), value).is_some() {
            return Err(invalid("duplicate native executor identity"));
        }
    }
    Ok(result)
}

fn bounded_blob(
    row: &Row<'_>,
    length_column: usize,
    data_column: usize,
    budget: &mut usize,
) -> Result<Vec<u8>, AntigravityError> {
    let length = usize::try_from(row.get::<_, i64>(length_column).map_err(sql_error)?)
        .map_err(|_| invalid("invalid native blob length"))?;
    if length > *budget {
        return Err(invalid("native snapshot exceeds the 64 MiB read budget"));
    }
    *budget -= length;
    row.get(data_column).map_err(sql_error)
}

fn validate_files(path: &Path) -> Result<(), AntigravityError> {
    for suffix in ["", "-wal", "-shm"] {
        let candidate = if suffix.is_empty() {
            path.to_path_buf()
        } else {
            PathBuf::from(format!("{}{suffix}", path.display()))
        };
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(invalid(
                    "native database and sidecars must be regular files",
                ));
            }
            Err(error) if error.kind() == ErrorKind::NotFound && !suffix.is_empty() => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Err(AntigravityError::ConversationGone(
                    path.display().to_string(),
                ));
            }
            Err(error) => return Err(invalid(&format!("cannot inspect native record: {error}"))),
        }
    }
    Ok(())
}

pub(super) fn validate_session(value: &str) -> Result<(), AntigravityError> {
    let id = Uuid::parse_str(value).map_err(|_| invalid("invalid native session UUID"))?;
    if id.hyphenated().to_string() != value {
        return Err(invalid("native session UUID is not canonical"));
    }
    Ok(())
}

impl Cursor {
    fn parse(value: &str) -> Result<Self, AntigravityError> {
        let (trajectory, idx) = value
            .strip_prefix("native:")
            .and_then(|value| value.rsplit_once(':'))
            .ok_or_else(|| invalid("invalid native history cursor"))?;
        validate_session(trajectory)?;
        let first_idx = idx
            .parse::<i64>()
            .map_err(|_| invalid("invalid native history cursor index"))?;
        if first_idx < 0 {
            return Err(invalid("invalid native history cursor index"));
        }
        Ok(Self {
            trajectory: trajectory.to_string(),
            first_idx,
        })
    }
    fn encode(&self) -> String {
        format!("native:{}:{}", self.trajectory, self.first_idx)
    }
}

fn invalid(message: &str) -> AntigravityError {
    AntigravityError::Record(message.to_string())
}
fn sql_error(error: rusqlite::Error) -> AntigravityError {
    invalid(&error.to_string())
}

/// Native records written from captured fixtures, for the tests of this driver
/// that read one.
#[cfg(test)]
pub(super) mod fixture {
    use rusqlite::Connection;
    use serde::Deserialize;
    use std::{path::Path, str::from_utf8};

    #[derive(Deserialize)]
    pub(in crate::agent::antigravity) struct FixtureData {
        pub(in crate::agent::antigravity) identity: Identity,
        pub(in crate::agent::antigravity) rows: Vec<FixtureRow>,
        pub(in crate::agent::antigravity) executors: Vec<FixtureExecutor>,
        trajectory_metadata: String,
    }
    #[derive(Deserialize)]
    pub(in crate::agent::antigravity) struct Identity {
        pub(in crate::agent::antigravity) trajectory: String,
        pub(in crate::agent::antigravity) cascade: String,
    }
    #[derive(Deserialize)]
    pub(in crate::agent::antigravity) struct FixtureRow {
        idx: i64,
        kind: i32,
        pub(in crate::agent::antigravity) status: i32,
        format: i32,
        pub(in crate::agent::antigravity) metadata: String,
        pub(in crate::agent::antigravity) payload: String,
    }
    #[derive(Deserialize)]
    pub(in crate::agent::antigravity) struct FixtureExecutor {
        pub(in crate::agent::antigravity) idx: i64,
        pub(in crate::agent::antigravity) data: String,
    }

    pub(in crate::agent::antigravity) fn parse(bytes: &str) -> FixtureData {
        serde_json::from_str(bytes).unwrap()
    }

    /// Writes a fixture's record to `path` and returns the open writer.
    pub(in crate::agent::antigravity) fn write(path: &Path, data: &FixtureData) -> Connection {
        let connection = Connection::open(path).unwrap();
        connection.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE trajectory_meta(trajectory_id TEXT PRIMARY KEY,cascade_id TEXT);
            CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER NOT NULL,status INTEGER NOT NULL,step_format INTEGER NOT NULL,metadata BLOB,step_payload BLOB);
            CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY,data BLOB);
            CREATE TABLE trajectory_metadata_blob(id TEXT PRIMARY KEY,data BLOB);").unwrap();
        connection
            .execute(
                "INSERT INTO trajectory_meta VALUES(?1,?2)",
                [&data.identity.trajectory, &data.identity.cascade],
            )
            .unwrap();
        for row in &data.rows {
            connection
                .execute(
                    "INSERT INTO steps VALUES(?1,?2,?3,?4,?5,?6)",
                    rusqlite::params![
                        row.idx,
                        row.kind,
                        row.status,
                        row.format,
                        hex(&row.metadata),
                        hex(&row.payload)
                    ],
                )
                .unwrap();
        }
        for row in &data.executors {
            connection
                .execute(
                    "INSERT INTO executor_metadata VALUES(?1,?2)",
                    rusqlite::params![row.idx, hex(&row.data)],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO trajectory_metadata_blob VALUES('main',?1)",
                [hex(&data.trajectory_metadata)],
            )
            .unwrap();
        connection
    }

    pub(in crate::agent::antigravity) fn hex(value: &str) -> Vec<u8> {
        value
            .as_bytes()
            .chunks_exact(2)
            .map(|pair| u8::from_str_radix(from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::{ActivityStatus, TurnStatus};
    use fixture::{FixtureData, hex};
    use format::Payload;
    use std::{env, os::unix::fs::symlink};
    use tempfile::TempDir;

    struct NativeFixture {
        directory: TempDir,
        connection: Option<Connection>,
        data: FixtureData,
    }
    impl NativeFixture {
        fn new(bytes: &str) -> Self {
            let directory = TempDir::new().unwrap();
            let data = fixture::parse(bytes);
            let path = directory
                .path()
                .join(format!("{}.db", data.identity.cascade));
            let connection = fixture::write(&path, &data);
            Self {
                directory,
                connection: Some(connection),
                data,
            }
        }
        fn records(&self) -> Records {
            Records::new(self.directory.path().to_path_buf())
        }
        fn session(&self) -> &str {
            &self.data.identity.cascade
        }
        fn connection(&self) -> &Connection {
            self.connection.as_ref().unwrap()
        }
    }
    #[test]
    fn native_tools_cancel_and_usage_keep_their_execution_and_item_keys() {
        let fixture = NativeFixture::new(include_str!("record/fixtures/lifecycle.json"));
        let snapshot = fixture.records().read(fixture.session(), None, 8).unwrap();
        assert_eq!(snapshot.page.turns.len(), 2);
        let canceled = &snapshot.page.turns[0];
        let completed = &snapshot.page.turns[1];
        assert_eq!(canceled.id, "9f1acbf6865b5cabe84106414c8763a7");
        assert_eq!(canceled.status, TurnStatus::Interrupted);
        assert_eq!(completed.id, "b7d39414b03697d5bd98786018f9f974");
        assert_eq!(
            completed.status,
            TurnStatus::Completed,
            "a denied native tool is not a failed turn"
        );
        assert!(
            completed
                .items
                .iter()
                .any(|item| item.status == ActivityStatus::Failed)
        );
        assert!(completed.items.iter().any(|item|matches!(&item.kind,ItemKind::FileChange{paths} if paths==&["/fixture/output.txt"])));
        assert!(completed.items.iter().any(|item|matches!(&item.kind,ItemKind::CommandExecution(command) if command.command.as_deref()==Some("printf ACP_CMD_OK") && command.exit_code==Some(0))));
        assert!(canceled.items.iter().any(|item|matches!(&item.kind,ItemKind::CommandExecution(command) if command.command.as_deref()==Some("/bin/sleep 15") && command.exit_code.is_none())));
        let all_ids = snapshot
            .page
            .turns
            .iter()
            .flat_map(|turn| turn.items.iter().map(|item| item.id.clone()))
            .collect::<Vec<_>>();
        assert_eq!(all_ids.iter().collect::<HashSet<_>>().len(), all_ids.len());
        assert!(
            all_ids
                .iter()
                .all(|id| id.starts_with(&format!("{}:", fixture.data.identity.trajectory)))
        );
        assert_eq!(
            snapshot
                .turn_usage(&completed.id)
                .unwrap()
                .last
                .total_tokens,
            90280
        );
        assert_eq!(
            snapshot.turn_usage(&canceled.id).unwrap().last.total_tokens,
            16042
        );
        assert_eq!(snapshot.total_usage.total_tokens, 106322);
        assert!(snapshot.created_at_ms > 0 && snapshot.updated_at_ms >= snapshot.created_at_ms);
    }

    #[test]
    fn history_pages_use_native_turn_starts_and_reject_foreign_or_lost_cursors() {
        let fixture = NativeFixture::new(include_str!("record/fixtures/lifecycle.json"));
        let records = fixture.records();
        let newest = records.read(fixture.session(), None, 1).unwrap();
        assert_eq!(newest.page.turns[0].id, "9f1acbf6865b5cabe84106414c8763a7");
        let cursor = newest.page.next_cursor.as_deref().unwrap();
        assert!(cursor.ends_with(":12"));
        let older = records.read(fixture.session(), Some(cursor), 1).unwrap();
        assert_eq!(older.page.turns[0].id, "b7d39414b03697d5bd98786018f9f974");
        assert!(older.page.next_cursor.is_none());
        let foreign = format!("native:{}:12", Uuid::new_v4());
        assert!(records.read(fixture.session(), Some(&foreign), 1).is_err());
        let lost = format!("native:{}:13", fixture.data.identity.trajectory);
        assert!(records.read(fixture.session(), Some(&lost), 1).is_err());
        assert!(
            records
                .read(fixture.session(), Some("offset:0"), 1)
                .is_err()
        );
    }

    #[test]
    fn stopped_wal_without_sidecars_opens_readonly_and_preserves_main_bytes() {
        let mut fixture = NativeFixture::new(include_str!("record/fixtures/single-turn.json"));
        drop(fixture.connection.take());
        let records = fixture.records();
        let path = records.path(fixture.session()).unwrap();
        assert!(!PathBuf::from(format!("{}-wal", path.display())).exists());
        assert!(!PathBuf::from(format!("{}-shm", path.display())).exists());
        let before = fs::read(&path).unwrap();
        let snapshot = records.read(fixture.session(), None, 8).unwrap();
        assert_eq!(snapshot.page.turns.len(), 1);
        assert_eq!(snapshot.page.turns[0].status, TurnStatus::Completed);
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn mutable_native_response_and_terminal_row_update_the_same_items() {
        let fixture = NativeFixture::new(include_str!("record/fixtures/single-turn.json"));
        let records = fixture.records();
        let original = &fixture.data.rows[1];
        let full = Step::decode(hex(&original.payload).as_slice()).unwrap();
        let mut partial = full.clone();
        partial.status = 2;
        let Some(Payload::PlannerResponse(response)) = &mut partial.payload else {
            panic!("native planner response")
        };
        response.response = "ACP".to_string();
        response.modified_response.clear();
        partial.metadata.as_mut().unwrap().model_usage = None;
        fixture
            .connection()
            .execute(
                "UPDATE steps SET status=2,step_payload=?1,metadata=?2 WHERE idx=1",
                rusqlite::params![
                    partial.encode_to_vec(),
                    partial.metadata.as_ref().unwrap().encode_to_vec()
                ],
            )
            .unwrap();
        fixture
            .connection()
            .execute("DELETE FROM executor_metadata", [])
            .unwrap();
        let before = records.read(fixture.session(), None, 8).unwrap();
        let first = &before.page.turns[0];
        assert_eq!(first.status, TurnStatus::InProgress);
        let message = first
            .items
            .iter()
            .find(|item| matches!(item.kind, ItemKind::AssistantMessage { .. }))
            .unwrap();
        let message_id = message.id.clone();
        assert!(matches!(&message.kind,ItemKind::AssistantMessage{text,..} if text=="ACP"));
        fixture
            .connection()
            .execute(
                "UPDATE steps SET status=?1,step_payload=?2,metadata=?3 WHERE idx=1",
                rusqlite::params![
                    original.status,
                    hex(&original.payload),
                    hex(&original.metadata)
                ],
            )
            .unwrap();
        let executor = &fixture.data.executors[0];
        fixture
            .connection()
            .execute(
                "INSERT INTO executor_metadata VALUES(?1,?2)",
                rusqlite::params![executor.idx, hex(&executor.data)],
            )
            .unwrap();
        let after = records.read(fixture.session(), None, 8).unwrap();
        let last = &after.page.turns[0];
        assert_eq!(last.id, first.id);
        assert_eq!(last.status, TurnStatus::Completed);
        assert_eq!(
            last.items
                .iter()
                .filter(|item| item.id == message_id)
                .count(),
            1
        );
        assert!(
            matches!(&last.items.iter().find(|item|item.id==message_id).unwrap().kind,ItemKind::AssistantMessage{text,..} if text=="ACP_IDPROBE_OK")
        );
    }

    #[test]
    fn malformed_identity_format_payload_and_usage_never_become_empty_history() {
        let fixture = NativeFixture::new(include_str!("record/fixtures/single-turn.json"));
        let records = fixture.records();
        fixture
            .connection()
            .execute("UPDATE steps SET step_format=1 WHERE idx=1", [])
            .unwrap();
        assert!(matches!(
            records.read(fixture.session(), None, 8),
            Err(AntigravityError::Record(_))
        ));
        fixture
            .connection()
            .execute(
                "UPDATE steps SET step_format=0,step_payload=X'ff' WHERE idx=1",
                [],
            )
            .unwrap();
        assert!(matches!(
            records.read(fixture.session(), None, 8),
            Err(AntigravityError::Record(_))
        ));
        let original = &fixture.data.rows[1];
        let mut wrong = Step::decode(hex(&original.payload).as_slice()).unwrap();
        wrong
            .metadata
            .as_mut()
            .unwrap()
            .model_usage
            .as_mut()
            .unwrap()
            .input_tokens += 1;
        fixture
            .connection()
            .execute(
                "UPDATE steps SET step_payload=?1 WHERE idx=1",
                [wrong.encode_to_vec()],
            )
            .unwrap();
        assert!(
            records
                .read(fixture.session(), None, 8)
                .unwrap_err()
                .to_string()
                .contains("usage")
        );
        fixture
            .connection()
            .execute(
                "UPDATE trajectory_meta SET cascade_id=?1",
                [Uuid::new_v4().to_string()],
            )
            .unwrap();
        assert!(
            records
                .read(fixture.session(), None, 8)
                .unwrap_err()
                .to_string()
                .contains("binding")
        );
        assert!(records.path("../other").is_err());
        assert!(records.path(&fixture.session().to_uppercase()).is_err());
        assert!(matches!(
            records.read(&Uuid::new_v4().to_string(), None, 8),
            Err(AntigravityError::ConversationGone(_))
        ));
    }

    #[test]
    fn symlinked_database_or_sidecar_is_refused_before_sqlite_can_follow_it() {
        let fixture = NativeFixture::new(include_str!("record/fixtures/single-turn.json"));
        let records = fixture.records();
        let other = Uuid::new_v4().to_string();
        symlink(
            records.path(fixture.session()).unwrap(),
            records.path(&other).unwrap(),
        )
        .unwrap();
        assert!(
            records
                .read(&other, None, 8)
                .unwrap_err()
                .to_string()
                .contains("regular files")
        );
        let mut stopped = NativeFixture::new(include_str!("record/fixtures/single-turn.json"));
        drop(stopped.connection.take());
        let outside = stopped.directory.path().join("outside");
        fs::write(&outside, b"do not touch").unwrap();
        let wal = PathBuf::from(format!(
            "{}-wal",
            stopped.records().path(stopped.session()).unwrap().display()
        ));
        symlink(&outside, wal).unwrap();
        assert!(stopped.records().read(stopped.session(), None, 8).is_err());
        assert_eq!(fs::read(outside).unwrap(), b"do not touch");
    }

    #[test]
    #[ignore = "reads and cleans an explicitly selected owned zero-turn ACP diagnostic, no model calls"]
    fn zero_turn_native_record_reads_without_guessed_identity_and_cleans_exact_files() {
        let path = PathBuf::from(
            env::var_os("CAFFOLD_ANTIGRAVITY_EMPTY_RECORD")
                .expect("select an owned zero-turn native diagnostic"),
        );
        let session = path.file_stem().unwrap().to_str().unwrap();
        let records = Records::new(path.parent().unwrap().to_path_buf());
        let before = fs::read(&path).unwrap();
        let snapshot = records.read(session, None, 8).unwrap();
        assert!(snapshot.page.turns.is_empty());
        assert_eq!(snapshot.total_usage.total_tokens, 0);
        assert_eq!(fs::read(&path).unwrap(), before);
        records.erase(session).unwrap();
        assert!(!path.exists());
    }

    #[test]
    #[ignore = "reads an explicitly selected real ACP 1.4.5 record, no model calls"]
    fn bundled_reader_opens_a_real_stopped_native_record_without_rewriting_it() {
        let path = PathBuf::from(
            env::var_os("CAFFOLD_ANTIGRAVITY_RECORD")
                .expect("select an owned native diagnostic .db"),
        );
        let session = path.file_stem().unwrap().to_str().unwrap();
        let records = Records::new(path.parent().unwrap().to_path_buf());
        let before = fs::read(&path).unwrap();
        let snapshot = records.read(session, None, 8).unwrap();
        assert!(!snapshot.page.turns.is_empty());
        assert!(
            snapshot.page.turns.iter().all(
                |turn| !turn.id.is_empty() && turn.items.iter().all(|item| !item.id.is_empty())
            )
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        eprintln!(
            "bundled SQLite {}, native turns={}, last usage={}",
            rusqlite::version(),
            snapshot.page.turns.len(),
            snapshot.total_usage.total_tokens
        );
    }
}
