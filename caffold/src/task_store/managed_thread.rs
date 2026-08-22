#[cfg(test)]
use super::ComposerSettings;
use super::{Result, TaskStoreError};
use chrono::{DateTime, NaiveDateTime, Utc};
#[cfg(test)]
use gluesql::core::data::Schema;
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::Value,
        executor::Payload,
        query_builder::{Execute, ExprNode, col, null, table, text, value as glue_value},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, SelectResultExt},
};
use serde::{Deserialize, Serialize};

pub(super) const TABLE_NAME: &str = "managed_threads";

/// Which agent a Task is run by.
///
/// A closed set, like the drivers themselves: Caffold routes a Task to the agent
/// that owns its conversation, and there is no agent it was not built against.
/// There is no default. A Task always belongs to exactly one agent, and a place
/// that cannot say which is a place that does not know — which is worth saying
/// out loud rather than answering with whichever agent came first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskProvider {
    Codex,
    Claude,
}

impl TaskProvider {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }
}

/// How a Task is run: which agent, and what that agent needs to be reached.
///
/// The two travel together because for one of them they are one fact. Codex
/// holds a thread's working directory and answers for it, so a second copy here
/// would only go stale. A Claude session is a process, resuming one starts a new
/// process, and that process works wherever it is started — so a Claude Task
/// that names no directory is a Task nothing can run.
///
/// The table keeps them as two nullable columns, because that is what a table
/// has. Everything above the row conversion holds this instead, where the
/// combination that cannot be run cannot be written down either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunBy {
    Codex,
    Claude { cwd: String },
}

impl RunBy {
    pub(crate) fn provider(&self) -> TaskProvider {
        match self {
            Self::Codex => TaskProvider::Codex,
            Self::Claude { .. } => TaskProvider::Claude,
        }
    }

    /// Where Caffold runs the agent, when the agent needs telling.
    fn cwd(&self) -> Option<&str> {
        match self {
            Self::Codex => None,
            Self::Claude { cwd } => Some(cwd),
        }
    }

    /// Read the pair of columns the table keeps, refusing a pair no agent can
    /// be run from.
    fn from_row(provider: &str, cwd: Option<String>) -> Result<Self> {
        match provider {
            "codex" => Ok(Self::Codex),
            "claude" => cwd
                .filter(|cwd| !cwd.trim().is_empty())
                .map(|cwd| Self::Claude { cwd })
                .ok_or(TaskStoreError::InvalidRow("cwd")),
            // Not a guess to make. The migration wrote a provider into every
            // row that existed, so an unrecognized one is a Task written by a
            // Caffold that drives an agent this one does not — and reading it
            // as some other agent would send the conversation to the wrong
            // place.
            _ => Err(TaskStoreError::InvalidRow("provider")),
        }
    }
}
pub(super) const POSITION_STEP: i64 = 1024;

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
    "fast_mode BOOLEAN NOT NULL DEFAULT FALSE",
    "display_name TEXT",
    "section_id TEXT NULL",
    "position_in_section INTEGER NULL",
    "provider TEXT NOT NULL DEFAULT 'codex'",
    "cwd TEXT NULL",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedThread {
    pub thread_id: String,
    /// How this Task is run.
    ///
    /// Known before the agent is woken, because the Task list has to decide who
    /// to ask about a Task without asking anyone.
    pub run_by: RunBy,
    pub display_name: String,
    pub section_id: Option<String>,
    pub position_in_section: Option<i64>,
    pub archived_at_ms: Option<u64>,
    pub last_observed_recency_ms: Option<u64>,
    pub claimed_at_ms: u64,
    pub last_opened_at_ms: Option<u64>,
    pub last_seen_activity_ms: Option<u64>,
    pub last_completed_at_ms: Option<u64>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: bool,
}

impl ManagedThread {
    pub(crate) fn new(
        thread_id: impl Into<String>,
        run_by: RunBy,
        last_observed_recency_ms: Option<u64>,
        model: Option<String>,
        reasoning_effort: Option<String>,
    ) -> Self {
        let thread_id = thread_id.into();
        Self {
            display_name: fallback_display_name(&thread_id),
            thread_id,
            run_by,
            section_id: None,
            position_in_section: None,
            archived_at_ms: None,
            last_observed_recency_ms,
            claimed_at_ms: 0,
            last_opened_at_ms: None,
            last_seen_activity_ms: None,
            last_completed_at_ms: None,
            model,
            reasoning_effort,
            fast_mode: false,
        }
    }

    pub(crate) fn unseen(&self) -> bool {
        self.last_completed_at_ms.is_some_and(|completed| {
            self.last_seen_activity_ms
                .is_none_or(|seen| completed > seen)
        })
    }

    #[cfg(test)]
    pub(crate) fn composer_settings(&self) -> ComposerSettings {
        ComposerSettings {
            model: self.model.clone(),
            reasoning_effort: self.reasoning_effort.clone(),
            fast_mode: self.fast_mode,
        }
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
    pub fast_mode: bool,
    pub display_name: String,
    pub section_id: Option<String>,
    pub position_in_section: Option<i64>,
    pub provider: String,
    pub cwd: Option<String>,
}

impl TryFrom<&ManagedThread> for ManagedThreadRow {
    type Error = TaskStoreError;

    fn try_from(thread: &ManagedThread) -> Result<Self> {
        Ok(Self {
            thread_id: thread.thread_id.clone(),
            provider: thread.run_by.provider().as_str().to_string(),
            cwd: thread.run_by.cwd().map(str::to_string),
            display_name: validate_display_name(&thread.display_name)?.to_string(),
            section_id: thread.section_id.clone(),
            position_in_section: to_db_position(
                thread.section_id.as_deref(),
                thread.position_in_section,
                thread.archived_at_ms.is_some(),
            )?,
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
            fast_mode: thread.fast_mode,
        })
    }
}

impl TryFrom<ManagedThreadRow> for ManagedThread {
    type Error = TaskStoreError;

    fn try_from(row: ManagedThreadRow) -> Result<Self> {
        Ok(Self {
            thread_id: row.thread_id,
            run_by: RunBy::from_row(&row.provider, row.cwd)?,
            display_name: validate_display_name(&row.display_name)?.to_string(),
            position_in_section: from_db_position(
                row.section_id.as_deref(),
                row.position_in_section,
                row.archived_at.is_some(),
            )?,
            section_id: row.section_id,
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
            fast_mode: row.fast_mode,
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

#[cfg(test)]
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
        // Which agent runs a Task is settled when the Task is created and never
        // again. A claim carries whatever the caller happened to build, so
        // taking it here would let a Task change agent — and lose the working
        // directory its agent is started in.
        thread.run_by = existing.run_by;
        thread.display_name = existing.display_name;
        thread.section_id = existing.section_id;
        thread.position_in_section = existing.position_in_section;
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
        thread.fast_mode = existing.fast_mode;
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

pub(super) fn list_all_active<S>(glue: &mut Glue<S>) -> Result<Vec<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    Ok(list(glue, None, usize::MAX)?.0)
}

pub(super) fn claim_at_top<S>(
    glue: &mut Glue<S>,
    mut thread: ManagedThread,
    display_name: &str,
    section_id: &str,
    now_ms: u64,
) -> Result<ManagedThread>
where
    S: GStore + GStoreMut + Planner,
{
    thread.display_name = validate_display_name(display_name)?.to_string();
    let mut claimed = claim(glue, thread, now_ms)?;
    claimed.display_name = display_name.to_string();
    place_at_top_inner(glue, claimed, section_id)
}

pub(super) fn place_at_top<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    section_id: &str,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(thread) = get(glue, thread_id)? else {
        return Ok(None);
    };
    place_at_top_inner(glue, thread, section_id).map(Some)
}

pub(super) fn restore_at_top<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    section_id: &str,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(thread) = restore(glue, thread_id)? else {
        return Ok(None);
    };
    place_at_top_inner(glue, thread, section_id).map(Some)
}

pub(super) fn update_display_name<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    display_name: &str,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let display_name = validate_display_name(display_name)?;
    let Some(mut thread) = get(glue, thread_id)? else {
        return Ok(None);
    };
    thread.display_name = display_name.to_string();
    update_all(glue, &thread)?;
    Ok(Some(thread))
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
        .set("section_id", null())
        .set("position_in_section", null())
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

#[cfg(test)]
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

#[cfg(test)]
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

pub(super) fn record_completed_turn<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    completed_at_ms: u64,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(mut thread) = get(glue, thread_id)? else {
        return Ok(None);
    };
    thread.last_completed_at_ms = Some(
        thread
            .last_completed_at_ms
            .unwrap_or_default()
            .max(completed_at_ms),
    );
    thread.last_observed_recency_ms = Some(
        thread
            .last_observed_recency_ms
            .unwrap_or_default()
            .max(completed_at_ms),
    );
    update_all(glue, &thread)?;
    Ok(Some(thread))
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
    fast_mode: bool,
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
        .set("fast_mode", glue_value(Value::Bool(fast_mode)))
        .execute(glue)?;
    get(glue, thread_id)
}

pub(super) fn delete<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(TABLE_NAME)
        .delete()
        .filter(
            col("thread_id")
                .eq(text(thread_id.to_owned()))
                .and(Membership::Active.filter()),
        )
        .execute(glue)?;
    deleted(payload)
}

pub(super) fn delete_archived<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(TABLE_NAME)
        .delete()
        .filter(
            col("thread_id")
                .eq(text(thread_id.to_owned()))
                .and(Membership::Archived.filter()),
        )
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

pub(super) fn update_all<S>(glue: &mut Glue<S>, thread: &ManagedThread) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let row = ManagedThreadRow::try_from(thread)?;
    table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(row.thread_id)))
        .filter(Membership::Active.filter())
        .set("archived_at", optional_timestamp(row.archived_at))
        .set("display_name", text(row.display_name))
        .set("section_id", optional_text(row.section_id.as_deref()))
        .set(
            "position_in_section",
            optional_integer(row.position_in_section),
        )
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
        .set("fast_mode", glue_value(Value::Bool(row.fast_mode)))
        .execute(glue)?;
    Ok(())
}

#[cfg(test)]
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

fn optional_integer(value: Option<i64>) -> ExprNode<'static> {
    value.map_or_else(null, |value| glue_value(Value::I64(value)))
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

fn place_at_top_inner<S>(
    glue: &mut Glue<S>,
    mut target: ManagedThread,
    section_id: &str,
) -> Result<ManagedThread>
where
    S: GStore + GStoreMut + Planner,
{
    if section_id.trim().is_empty() {
        return Err(TaskStoreError::InvalidRow("section_id"));
    }
    let mut target_section = list(glue, None, usize::MAX)?
        .0
        .into_iter()
        .filter(|thread| {
            thread.thread_id != target.thread_id && thread.section_id.as_deref() == Some(section_id)
        })
        .collect::<Vec<_>>();
    sort_placed_threads(&mut target_section)?;
    if target.section_id.as_deref() == Some(section_id)
        && target_section
            .first()
            .is_none_or(|thread| target.position_in_section < thread.position_in_section)
    {
        return Ok(target);
    }
    target.section_id = Some(section_id.to_string());
    target.position_in_section = match target_section.first() {
        Some(first) => first
            .position_in_section
            .and_then(|position| position.checked_sub(POSITION_STEP)),
        None => Some(0),
    };
    if target.position_in_section.is_some() {
        update_all(glue, &target)?;
        return Ok(target);
    }

    let mut final_order = Vec::with_capacity(target_section.len() + 1);
    final_order.push(target);
    final_order.extend(target_section);
    rebalance(glue, &mut final_order)?;
    Ok(final_order.remove(0))
}

pub(super) fn move_before<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    before_thread_id: Option<&str>,
) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(target) = get(glue, thread_id)? else {
        return Err(TaskStoreError::TaskReorderUnavailable(
            "moved Task is not managed and active",
        ));
    };
    let Some(section_id) = target.section_id.as_deref() else {
        return Err(TaskStoreError::TaskReorderUnavailable(
            "moved Task has no canonical Section placement",
        ));
    };
    if target.position_in_section.is_none() {
        return Err(TaskStoreError::TaskReorderUnavailable(
            "moved Task has no canonical Section rank",
        ));
    }
    if before_thread_id == Some(thread_id) {
        return Err(TaskStoreError::TaskReorderConflict(
            "a Task cannot be placed before itself",
        ));
    }
    if let Some(before_thread_id) = before_thread_id {
        let Some(anchor) = get(glue, before_thread_id)? else {
            return Err(TaskStoreError::TaskReorderConflict(
                "the requested anchor is missing or inactive",
            ));
        };
        if anchor.section_id.as_deref() != Some(section_id) || anchor.position_in_section.is_none()
        {
            return Err(TaskStoreError::TaskReorderConflict(
                "the requested anchor is not placed in the same Section",
            ));
        }
    }

    let mut original = list(glue, None, usize::MAX)?
        .0
        .into_iter()
        .filter(|thread| thread.section_id.as_deref() == Some(section_id))
        .collect::<Vec<_>>();
    sort_placed_threads(&mut original)?;
    let Some(target_index) = original
        .iter()
        .position(|thread| thread.thread_id == thread_id)
    else {
        return Err(TaskStoreError::TaskReorderUnavailable(
            "moved Task is absent from its canonical Section",
        ));
    };
    let original_ids = original
        .iter()
        .map(|thread| thread.thread_id.as_str())
        .collect::<Vec<_>>();
    let mut final_order = original.clone();
    let target = final_order.remove(target_index);
    let destination = match before_thread_id {
        Some(anchor_id) => final_order
            .iter()
            .position(|thread| thread.thread_id == anchor_id)
            .ok_or(TaskStoreError::TaskReorderConflict(
                "the requested anchor changed before the move committed",
            ))?,
        None => final_order.len(),
    };
    final_order.insert(destination, target);
    if final_order
        .iter()
        .map(|thread| thread.thread_id.as_str())
        .eq(original_ids)
    {
        return Ok(false);
    }

    let moved_index = final_order
        .iter()
        .position(|thread| thread.thread_id == thread_id)
        .ok_or(TaskStoreError::UnexpectedPayload)?;
    let previous = moved_index
        .checked_sub(1)
        .and_then(|index| final_order[index].position_in_section);
    let next = final_order
        .get(moved_index + 1)
        .and_then(|thread| thread.position_in_section);
    if let Some(position) = sparse_position_between(previous, next) {
        final_order[moved_index].position_in_section = Some(position);
        update_all(glue, &final_order[moved_index])?;
    } else {
        rebalance(glue, &mut final_order)?;
    }
    Ok(true)
}

fn sort_placed_threads(threads: &mut [ManagedThread]) -> Result<()> {
    if threads
        .iter()
        .any(|thread| thread.position_in_section.is_none())
    {
        return Err(TaskStoreError::InvalidRow("section_placement"));
    }
    threads.sort_by(|left, right| {
        left.position_in_section
            .cmp(&right.position_in_section)
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    Ok(())
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

pub(crate) fn fallback_display_name(thread_id: &str) -> String {
    format!("Thread {}", thread_id.chars().take(8).collect::<String>())
}

fn validate_display_name(display_name: &str) -> Result<&str> {
    if display_name.trim().is_empty() {
        return Err(TaskStoreError::InvalidRow("display_name"));
    }
    Ok(display_name)
}

fn to_db_position(
    section_id: Option<&str>,
    position: Option<i64>,
    archived: bool,
) -> Result<Option<i64>> {
    validate_placement(section_id, position.is_some(), archived)?;
    Ok(position)
}

fn from_db_position(
    section_id: Option<&str>,
    position: Option<i64>,
    archived: bool,
) -> Result<Option<i64>> {
    validate_placement(section_id, position.is_some(), archived)?;
    Ok(position)
}

fn sparse_position_between(previous: Option<i64>, next: Option<i64>) -> Option<i64> {
    match (previous, next) {
        (None, None) => Some(0),
        (None, Some(next)) => next.checked_sub(POSITION_STEP),
        (Some(previous), None) => previous.checked_add(POSITION_STEP),
        (Some(previous), Some(next)) => {
            let gap = i128::from(next) - i128::from(previous);
            (gap > 1)
                .then(|| i128::from(previous) + gap / 2)
                .and_then(|position| i64::try_from(position).ok())
        }
    }
}

fn rebalance<S>(glue: &mut Glue<S>, threads: &mut [ManagedThread]) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    for (index, thread) in threads.iter_mut().enumerate() {
        let index =
            i64::try_from(index).map_err(|_| TaskStoreError::InvalidRow("position_in_section"))?;
        thread.position_in_section = Some(
            index
                .checked_mul(POSITION_STEP)
                .ok_or(TaskStoreError::InvalidRow("position_in_section"))?,
        );
        update_all(glue, thread)?;
    }
    Ok(())
}

fn validate_placement(section_id: Option<&str>, has_position: bool, archived: bool) -> Result<()> {
    let has_section = section_id.is_some_and(|section_id| !section_id.trim().is_empty());
    if has_section != has_position || (archived && has_section) {
        return Err(TaskStoreError::InvalidRow("section_placement"));
    }
    Ok(())
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
        ManagedThread::new(id, RunBy::Codex, recency_ms, None, None)
    }

    fn place_with_rank(glue: &mut Glue<MemoryStorage>, id: &str, section_id: &str, position: i64) {
        let mut managed = claim(glue, thread(id, Some(1)), 1).unwrap();
        managed.section_id = Some(section_id.to_string());
        managed.position_in_section = Some(position);
        update_all(glue, &managed).unwrap();
    }

    fn section_order(glue: &mut Glue<MemoryStorage>, section_id: &str) -> Vec<(String, i64)> {
        let mut threads = list(glue, None, usize::MAX)
            .unwrap()
            .0
            .into_iter()
            .filter(|thread| thread.section_id.as_deref() == Some(section_id))
            .collect::<Vec<_>>();
        sort_placed_threads(&mut threads).unwrap();
        threads
            .into_iter()
            .map(|thread| (thread.thread_id, thread.position_in_section.unwrap()))
            .collect()
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

    /// A row as the table would hold it for an ordinary Codex Task.
    fn stored_row(thread_id: &str) -> ManagedThreadRow {
        ManagedThreadRow::try_from(&ManagedThread::new(
            thread_id,
            RunBy::Codex,
            Some(10),
            None,
            None,
        ))
        .expect("a Task Caffold just built is one it can store")
    }

    #[test]
    fn a_claude_row_that_names_no_directory_is_refused_rather_than_read() {
        // A Claude session is a process, and a process has to start somewhere.
        // Reading the row anyway would produce a Task nothing can run, and the
        // failure would surface much later as a session that will not open.
        let mut row = stored_row("thread-1");
        row.provider = "claude".to_string();
        row.cwd = None;

        let refused = ManagedThread::try_from(row);

        assert!(matches!(refused, Err(TaskStoreError::InvalidRow("cwd"))));
    }

    #[test]
    fn a_provider_this_release_does_not_drive_is_refused_rather_than_guessed() {
        // The migration wrote a provider into every row that existed, so an
        // unrecognized one was written by a Caffold that drives an agent this
        // one does not. Reading it as Codex would send the conversation to the
        // wrong agent.
        let mut row = stored_row("thread-1");
        row.provider = "some-later-agent".to_string();
        row.cwd = Some("/Users/example/project".to_string());

        let refused = ManagedThread::try_from(row);

        assert!(matches!(
            refused,
            Err(TaskStoreError::InvalidRow("provider"))
        ));
    }

    #[test]
    fn claiming_a_task_again_does_not_change_which_agent_runs_it() {
        // A claim carries whatever the caller happened to build. Taking its
        // agent would convert a Claude Task to Codex and lose the directory its
        // session is started in — silently, because both are valid values.
        let mut glue = memory();
        let claude = ManagedThread {
            run_by: RunBy::Claude {
                cwd: "/Users/example/project".to_string(),
            },
            ..ManagedThread::new("thread-1", RunBy::Codex, Some(10), None, None)
        };
        claim(&mut glue, claude.clone(), 100).unwrap();

        claim(
            &mut glue,
            ManagedThread::new("thread-1", RunBy::Codex, Some(20), None, None),
            200,
        )
        .unwrap();

        let stored = get(&mut glue, "thread-1").unwrap().unwrap();
        assert_eq!(stored.run_by, claude.run_by);
    }

    #[test]
    fn row_conversion_round_trips_all_persisted_fields() {
        let thread = ManagedThread {
            thread_id: "fully-populated".to_string(),
            run_by: RunBy::Claude {
                cwd: "/Users/example/project".to_string(),
            },
            display_name: "Fully populated".to_string(),
            section_id: None,
            position_in_section: None,
            archived_at_ms: Some(110),
            last_observed_recency_ms: Some(120),
            claimed_at_ms: 100,
            last_opened_at_ms: Some(130),
            last_seen_activity_ms: Some(140),
            last_completed_at_ms: Some(150),
            model: Some("gpt-test".to_string()),
            reasoning_effort: Some("xhigh".to_string()),
            fast_mode: true,
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

        let thread = ManagedThread::new("invalid", RunBy::Codex, None, None, None);
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

        update_composer_settings(&mut glue, "task", Some("gpt-test"), Some("xhigh"), true).unwrap();
        let refreshed = update_observed_recency(&mut glue, "task", 40)
            .unwrap()
            .unwrap();
        assert_eq!(refreshed.claimed_at_ms, 100);
        assert_eq!(refreshed.last_seen_activity_ms, None);
        assert_eq!(refreshed.model.as_deref(), Some("gpt-test"));
        assert_eq!(refreshed.reasoning_effort.as_deref(), Some("xhigh"));
        assert!(refreshed.fast_mode);
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
    fn deletes_target_only_the_requested_membership() {
        let mut glue = memory();
        claim(&mut glue, thread("active", Some(20)), 100).unwrap();
        claim(&mut glue, thread("other-active", Some(25)), 100).unwrap();
        claim(&mut glue, thread("archived", Some(30)), 100).unwrap();
        archive(&mut glue, "archived", 200).unwrap().unwrap();

        assert!(!delete_archived(&mut glue, "active").unwrap());
        assert!(get(&mut glue, "active").unwrap().is_some());
        assert!(delete_archived(&mut glue, "archived").unwrap());
        assert!(get_archived(&mut glue, "archived").unwrap().is_none());
        assert!(!delete_archived(&mut glue, "archived").unwrap());
        assert!(delete(&mut glue, "active").unwrap());
        assert!(get(&mut glue, "active").unwrap().is_none());
        assert!(get(&mut glue, "other-active").unwrap().is_some());
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
            update_composer_settings(&mut glue, "missing", None, None, false).unwrap(),
            None
        );
        assert!(!delete(&mut glue, "missing").unwrap());
        assert!(!delete_archived(&mut glue, "missing").unwrap());
    }

    #[test]
    fn query_builder_round_trips_literal_text_without_manual_escaping() {
        let mut glue = memory();
        let quoted = ManagedThread::new(
            "task'quoted",
            RunBy::Codex,
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

    #[test]
    fn section_lifecycle_uses_sparse_top_ranks_and_preserves_gaps_and_names() {
        let mut glue = memory();
        for (id, name) in [("a", "Task A"), ("b", "Task B"), ("c", "Task C")] {
            claim_at_top(&mut glue, thread(id, Some(1)), name, "one", 1).unwrap();
        }
        assert_eq!(
            get(&mut glue, "c").unwrap().unwrap().position_in_section,
            Some(-2048)
        );

        let archived = archive(&mut glue, "b", 2).unwrap().unwrap();
        assert_eq!(archived.display_name, "Task B");
        assert_eq!(
            (archived.section_id, archived.position_in_section),
            (None, None)
        );
        assert_eq!(
            section_order(&mut glue, "one"),
            [("c".to_string(), -2048), ("a".to_string(), 0)]
        );

        let restored = restore_at_top(&mut glue, "b", "one").unwrap().unwrap();
        assert_eq!(restored.display_name, "Task B");
        assert_eq!(restored.position_in_section, Some(-3072));
        assert_eq!(
            section_order(&mut glue, "one"),
            [
                ("b".to_string(), -3072),
                ("c".to_string(), -2048),
                ("a".to_string(), 0),
            ]
        );
    }

    #[test]
    fn deleting_an_active_thread_preserves_section_rank_gaps() {
        let mut glue = memory();
        for id in ["a", "b", "c"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }

        assert!(delete(&mut glue, "b").unwrap());
        assert!(get(&mut glue, "b").unwrap().is_none());
        assert_eq!(
            section_order(&mut glue, "one"),
            [("c".to_string(), -2048), ("a".to_string(), 0)]
        );
    }

    #[test]
    fn moving_between_sections_leaves_the_previous_section_rank_untouched() {
        let mut glue = memory();
        for id in ["a", "b"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }
        place_at_top(&mut glue, "a", "two").unwrap();
        assert_eq!(
            get(&mut glue, "b").unwrap().unwrap().position_in_section,
            Some(-1024)
        );
        assert_eq!(
            get(&mut glue, "a").unwrap().unwrap().position_in_section,
            Some(0)
        );
    }

    #[test]
    fn move_before_places_at_top_middle_and_end_with_successful_noops() {
        let mut glue = memory();
        for id in ["c", "b", "a"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }

        assert!(move_before(&mut glue, "c", Some("a")).unwrap());
        assert_eq!(
            section_order(&mut glue, "one"),
            [
                ("c".to_string(), -3072),
                ("a".to_string(), -2048),
                ("b".to_string(), -1024),
            ]
        );

        assert!(move_before(&mut glue, "c", Some("b")).unwrap());
        assert_eq!(
            section_order(&mut glue, "one"),
            [
                ("a".to_string(), -2048),
                ("c".to_string(), -1536),
                ("b".to_string(), -1024),
            ]
        );

        assert!(move_before(&mut glue, "c", None).unwrap());
        assert_eq!(
            section_order(&mut glue, "one"),
            [
                ("a".to_string(), -2048),
                ("b".to_string(), -1024),
                ("c".to_string(), 0),
            ]
        );
        assert!(!move_before(&mut glue, "c", None).unwrap());
        assert!(!move_before(&mut glue, "b", Some("c")).unwrap());
    }

    #[test]
    fn move_before_rebalances_dense_ranks_only_when_the_requested_gap_is_exhausted() {
        let mut glue = memory();
        place_with_rank(&mut glue, "a", "one", 0);
        place_with_rank(&mut glue, "b", "one", 1);
        place_with_rank(&mut glue, "c", "one", 2);

        assert!(move_before(&mut glue, "c", Some("b")).unwrap());
        assert_eq!(
            section_order(&mut glue, "one"),
            [
                ("a".to_string(), 0),
                ("c".to_string(), 1024),
                ("b".to_string(), 2048),
            ]
        );
    }

    #[test]
    fn move_before_rebalances_checked_top_and_end_overflow() {
        let mut glue = memory();
        place_with_rank(&mut glue, "a", "one", i64::MIN);
        place_with_rank(&mut glue, "b", "one", 0);
        assert!(move_before(&mut glue, "b", Some("a")).unwrap());
        assert_eq!(
            section_order(&mut glue, "one"),
            [("b".to_string(), 0), ("a".to_string(), 1024)]
        );

        let mut glue = memory();
        place_with_rank(&mut glue, "a", "one", 0);
        place_with_rank(&mut glue, "b", "one", i64::MAX);
        assert!(move_before(&mut glue, "a", None).unwrap());
        assert_eq!(
            section_order(&mut glue, "one"),
            [("b".to_string(), 0), ("a".to_string(), 1024)]
        );
    }

    #[test]
    fn placing_at_top_rebalances_checked_rank_underflow() {
        let mut glue = memory();
        place_with_rank(&mut glue, "a", "one", i64::MIN);
        claim(&mut glue, thread("b", Some(1)), 1).unwrap();

        place_at_top(&mut glue, "b", "one").unwrap();

        assert_eq!(
            section_order(&mut glue, "one"),
            [("b".to_string(), 0), ("a".to_string(), 1024)]
        );
    }

    #[test]
    fn move_before_rejects_unavailable_tasks_and_stale_or_cross_section_anchors() {
        let mut glue = memory();
        place_with_rank(&mut glue, "a", "one", 0);
        place_with_rank(&mut glue, "b", "two", 0);
        claim(&mut glue, thread("unplaced", Some(1)), 1).unwrap();
        place_with_rank(&mut glue, "archived", "one", 1024);
        archive(&mut glue, "archived", 2).unwrap();

        assert!(matches!(
            move_before(&mut glue, "missing", None),
            Err(TaskStoreError::TaskReorderUnavailable(_))
        ));
        assert!(matches!(
            move_before(&mut glue, "archived", None),
            Err(TaskStoreError::TaskReorderUnavailable(_))
        ));
        assert!(matches!(
            move_before(&mut glue, "unplaced", None),
            Err(TaskStoreError::TaskReorderUnavailable(_))
        ));
        for anchor in [Some("missing"), Some("a"), Some("b")] {
            let result = move_before(&mut glue, "a", anchor);
            assert!(matches!(
                result,
                Err(TaskStoreError::TaskReorderConflict(_))
            ));
        }
        assert_eq!(section_order(&mut glue, "one"), [("a".to_string(), 0)]);
    }
}
