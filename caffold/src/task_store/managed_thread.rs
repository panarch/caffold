use super::{ComposerSettings, Result, TaskStoreError};
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
    Grok,
    Antigravity,
}

impl TaskProvider {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Grok => "grok",
            Self::Antigravity => "antigravity",
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
/// The table keeps them as nullable columns, because that is what a table has.
/// Everything above the row conversion holds this instead, where the
/// combination that cannot be run cannot be written down either.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RunBy {
    Codex,
    /// `config_dir` is the `CLAUDE_CONFIG_DIR` the Task was created under, or
    /// none for Claude's default. The conversation lives in that directory, so
    /// it is fixed for the Task's life.
    Claude {
        cwd: String,
        config_dir: Option<String>,
    },
    /// A Grok Task's binding says which native session it runs on and where;
    /// the row keeps where the Task began so that lists and archives can
    /// describe it without waking the agent.
    Grok {
        cwd: String,
    },
    Antigravity {
        cwd: String,
    },
}

impl RunBy {
    pub(crate) fn provider(&self) -> TaskProvider {
        match self {
            Self::Codex => TaskProvider::Codex,
            Self::Claude { .. } => TaskProvider::Claude,
            Self::Grok { .. } => TaskProvider::Grok,
            Self::Antigravity { .. } => TaskProvider::Antigravity,
        }
    }

    /// Where Caffold runs the agent, when the agent needs telling.
    pub(crate) fn cwd(&self) -> Option<&str> {
        match self {
            Self::Codex => None,
            Self::Claude { cwd, .. } | Self::Grok { cwd } | Self::Antigravity { cwd } => Some(cwd),
        }
    }

    /// The config directory a Claude Task runs under, `None` for Claude's
    /// default and for every other agent.
    pub(crate) fn claude_config_dir(&self) -> Option<&str> {
        match self {
            Self::Claude { config_dir, .. } => config_dir.as_deref(),
            Self::Codex | Self::Grok { .. } | Self::Antigravity { .. } => None,
        }
    }

    /// Read the columns the table keeps, refusing a combination no agent can be
    /// run from.
    fn from_row(provider: &str, cwd: Option<String>, config_dir: Option<String>) -> Result<Self> {
        if config_dir.is_some() && provider != "claude" {
            return Err(TaskStoreError::InvalidRow("claude_config_dir"));
        }
        if config_dir
            .as_deref()
            .is_some_and(|config_dir| config_dir.trim().is_empty())
        {
            return Err(TaskStoreError::InvalidRow("claude_config_dir"));
        }
        match provider {
            "codex" => Ok(Self::Codex),
            "claude" => cwd
                .filter(|cwd| !cwd.trim().is_empty())
                .map(|cwd| Self::Claude { cwd, config_dir })
                .ok_or(TaskStoreError::InvalidRow("cwd")),
            "grok" => cwd
                .filter(|cwd| !cwd.trim().is_empty())
                .map(|cwd| Self::Grok { cwd })
                .ok_or(TaskStoreError::InvalidRow("cwd")),
            "antigravity" => cwd
                .filter(|cwd| !cwd.trim().is_empty())
                .map(|cwd| Self::Antigravity { cwd })
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

/// Where an active Task is listed: at its place in its Section, or at its place
/// among the pinned Tasks above every Section.
///
/// The table keeps a Section and two places as three nullable columns. Above
/// the row conversion a placed Task has its Section and exactly one place. A
/// pinned Task keeps its Section, which the list names it by and unpinning
/// returns it to. Archived Tasks, and Tasks still waiting for a Section, have
/// no placement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Placement {
    pub section_id: String,
    pub position: Position,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Position {
    InSection(i64),
    Pinned(i64),
}

impl Placement {
    fn pinned(&self) -> bool {
        matches!(self.position, Position::Pinned(_))
    }

    /// Read the three columns the table keeps, refusing any combination that
    /// does not name exactly one place.
    fn from_row(
        section_id: Option<String>,
        position_in_section: Option<i64>,
        pin_position: Option<i64>,
        archived: bool,
    ) -> Result<Option<Self>> {
        let section_id = section_id.filter(|section_id| !section_id.trim().is_empty());
        let position = match (position_in_section, pin_position) {
            (None, None) => None,
            (Some(position), None) => Some(Position::InSection(position)),
            (None, Some(position)) => Some(Position::Pinned(position)),
            (Some(_), Some(_)) => return Err(TaskStoreError::InvalidRow("section_placement")),
        };
        match (section_id, position) {
            (None, None) => Ok(None),
            (Some(section_id), Some(position)) if !archived => Ok(Some(Self {
                section_id,
                position,
            })),
            _ => Err(TaskStoreError::InvalidRow("section_placement")),
        }
    }

    /// The `section_id`, `position_in_section`, and `pin_position` columns.
    fn to_row(
        placement: Option<&Self>,
        archived: bool,
    ) -> Result<(Option<String>, Option<i64>, Option<i64>)> {
        let Some(placement) = placement else {
            return Ok((None, None, None));
        };
        if archived || placement.section_id.trim().is_empty() {
            return Err(TaskStoreError::InvalidRow("section_placement"));
        }
        let section_id = Some(placement.section_id.clone());
        Ok(match placement.position {
            Position::InSection(position) => (section_id, Some(position), None),
            Position::Pinned(position) => (section_id, None, Some(position)),
        })
    }
}

impl Position {
    /// The same kind of place, at another position.
    fn at(self, value: i64) -> Self {
        match self {
            Self::InSection(_) => Self::InSection(value),
            Self::Pinned(_) => Self::Pinned(value),
        }
    }
}

/// One ordered run of the list: a Section's own Tasks, or the pinned Tasks.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Order {
    Section(String),
    Pinned,
}

impl Order {
    fn of(placement: &Placement) -> Self {
        match placement.position {
            Position::InSection(_) => Self::Section(placement.section_id.clone()),
            Position::Pinned(_) => Self::Pinned,
        }
    }

    /// Where a Task stands in this run, if it is in it.
    fn position_of(&self, thread: &ManagedThread) -> Option<i64> {
        let placement = thread.placement.as_ref()?;
        match (self, placement.position) {
            (Self::Section(section_id), Position::InSection(position))
                if placement.section_id == *section_id =>
            {
                Some(position)
            }
            (Self::Pinned, Position::Pinned(position)) => Some(position),
            _ => None,
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
    "permission_mode TEXT NULL",
    "permission_instructions TEXT NULL",
    "pin_position INTEGER NULL",
    "claude_config_dir TEXT NULL",
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
    pub placement: Option<Placement>,
    pub archived_at_ms: Option<u64>,
    pub last_observed_recency_ms: Option<u64>,
    pub claimed_at_ms: u64,
    pub last_opened_at_ms: Option<u64>,
    pub last_seen_activity_ms: Option<u64>,
    pub last_completed_at_ms: Option<u64>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub fast_mode: bool,
    pub permission_mode: Option<String>,
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
            placement: None,
            archived_at_ms: None,
            last_observed_recency_ms,
            claimed_at_ms: 0,
            last_opened_at_ms: None,
            last_seen_activity_ms: None,
            last_completed_at_ms: None,
            model,
            reasoning_effort,
            fast_mode: false,
            permission_mode: None,
        }
    }

    /// The Section the Task is listed in or, while pinned, named by.
    pub(crate) fn section_id(&self) -> Option<&str> {
        self.placement
            .as_ref()
            .map(|placement| placement.section_id.as_str())
    }

    pub(crate) fn pinned(&self) -> bool {
        self.placement.as_ref().is_some_and(Placement::pinned)
    }

    /// The Task's place among its Section's own Tasks; none while pinned.
    pub(crate) fn position_in_section(&self) -> Option<i64> {
        match self.placement.as_ref()?.position {
            Position::InSection(position) => Some(position),
            Position::Pinned(_) => None,
        }
    }

    /// The Task's place among the pinned Tasks; none unless pinned.
    pub(crate) fn pin_position(&self) -> Option<i64> {
        match self.placement.as_ref()?.position {
            Position::Pinned(position) => Some(position),
            Position::InSection(_) => None,
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
            permission_mode: self.permission_mode.clone(),
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
    pub permission_mode: Option<String>,
    /// What this Task's own prompts have settled, oldest first.
    ///
    /// It stays off [`ManagedThread`] because it is read only when a
    /// permission request is being judged, and a Task list has no use for it.
    pub permission_instructions: Option<String>,
    pub display_name: String,
    pub section_id: Option<String>,
    pub position_in_section: Option<i64>,
    pub pin_position: Option<i64>,
    pub provider: String,
    pub cwd: Option<String>,
    pub claude_config_dir: Option<String>,
}

impl TryFrom<&ManagedThread> for ManagedThreadRow {
    type Error = TaskStoreError;

    fn try_from(thread: &ManagedThread) -> Result<Self> {
        let (section_id, position_in_section, pin_position) =
            Placement::to_row(thread.placement.as_ref(), thread.archived_at_ms.is_some())?;
        Ok(Self {
            thread_id: thread.thread_id.clone(),
            provider: thread.run_by.provider().as_str().to_string(),
            cwd: thread.run_by.cwd().map(str::to_string),
            claude_config_dir: thread.run_by.claude_config_dir().map(str::to_string),
            display_name: validate_display_name(&thread.display_name)?.to_string(),
            section_id,
            position_in_section,
            pin_position,
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
            permission_mode: thread.permission_mode.clone(),
            // A Task permits nothing of its own when it is first written,
            // and every later whole-thread write names the fields it changes.
            permission_instructions: None,
        })
    }
}

impl TryFrom<ManagedThreadRow> for ManagedThread {
    type Error = TaskStoreError;

    fn try_from(row: ManagedThreadRow) -> Result<Self> {
        Ok(Self {
            thread_id: row.thread_id,
            run_by: RunBy::from_row(&row.provider, row.cwd, row.claude_config_dir)?,
            display_name: validate_display_name(&row.display_name)?.to_string(),
            placement: Placement::from_row(
                row.section_id,
                row.position_in_section,
                row.pin_position,
                row.archived_at.is_some(),
            )?,
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
            permission_mode: row.permission_mode,
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
        thread.placement = existing.placement;
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
        if thread.permission_mode.is_none() {
            thread.permission_mode = existing.permission_mode;
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

/// A Task's record on whichever list holds it.
pub(super) fn find<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = table(TABLE_NAME)
        .select()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .project(columns())
        .limit(1)
        .execute(glue)
        .rows_as::<ManagedThreadRow>()?;
    rows.into_iter().next().map(TryInto::try_into).transpose()
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

pub(super) fn reconnect_cwd<S>(
    glue: &mut Glue<S>,
    expected: &ManagedThread,
    cwd: &str,
) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let membership = if expected.archived_at_ms.is_some() {
        Membership::Archived
    } else {
        Membership::Active
    };
    let current = match membership {
        Membership::Active => get(glue, &expected.thread_id)?,
        Membership::Archived => get_archived(glue, &expected.thread_id)?,
    };
    if current.as_ref() != Some(expected) {
        return Err(TaskStoreError::InvalidRow(
            "Section changed during reconnection",
        ));
    }
    if matches!(expected.run_by, RunBy::Codex) {
        return Ok(());
    }
    if cwd.trim().is_empty() {
        return Err(TaskStoreError::InvalidRow("cwd"));
    }
    table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(expected.thread_id.clone())))
        .filter(membership.filter())
        .set("cwd", text(cwd.to_string()))
        .execute(glue)?;
    Ok(())
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
        .set("pin_position", null())
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
    completed_at_ms: Option<u64>,
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
    thread.last_seen_activity_ms = max_optional(thread.last_seen_activity_ms, completed_at_ms);
    update_all(glue, &thread)?;
    Ok(Some(thread))
}

pub(super) fn update_composer_settings<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    settings: &ComposerSettings,
) -> Result<Option<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    if get(glue, thread_id)?.is_none() {
        return Ok(None);
    }
    let mut query = table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(Membership::Active.filter())
        .set("model", optional_text(settings.model.as_deref()))
        .set(
            "reasoning_effort",
            optional_text(settings.reasoning_effort.as_deref()),
        )
        .set("fast_mode", glue_value(Value::Bool(settings.fast_mode)));
    if let Some(permission_mode) = settings.permission_mode.as_deref() {
        query = query.set("permission_mode", optional_text(Some(permission_mode)));
    }
    query.execute(glue)?;
    get(glue, thread_id)
}

/// How much of what a Task's own prompts settled is kept.
///
/// The whole block is read whenever a permission request is judged, and both
/// TypeSafe's guidance and the size of that block argue against letting it
/// grow without end. Past the bound the oldest entries go, which is the same
/// direction as the rule that a later statement overrides an earlier one.
pub(super) const MAX_PERMISSION_INSTRUCTIONS_BYTES: usize = 8 * 1024;

const PERMISSION_INSTRUCTION_SEPARATOR: &str = "\n\n";

pub(super) fn permission_instructions<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
) -> Result<Option<String>>
where
    S: GStore + GStoreMut + Planner,
{
    Ok(read_permission_instructions(glue, thread_id)?.flatten())
}

/// Adds one entry to the end, dropping the oldest entries while the whole
/// block is over its bound. Returns what the Task now carries, or `None` when
/// there is no such active Task.
pub(super) fn append_permission_instructions<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    entry: &str,
) -> Result<Option<String>>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(existing) = read_permission_instructions(glue, thread_id)? else {
        return Ok(None);
    };
    let appended = match existing {
        Some(existing) if !existing.is_empty() => {
            format!("{existing}{PERMISSION_INSTRUCTION_SEPARATOR}{entry}")
        }
        _ => entry.to_string(),
    };
    let bounded = bound_permission_instructions(appended);
    write_permission_instructions(glue, thread_id, Some(&bounded))?;
    Ok(Some(bounded))
}

/// Forgets what a Task's prompts granted. `false` when there is no such active
/// Task.
pub(super) fn clear_permission_instructions<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    if read_permission_instructions(glue, thread_id)?.is_none() {
        return Ok(false);
    }
    write_permission_instructions(glue, thread_id, None)?;
    Ok(true)
}

/// `None` when no active Task has this identifier; the inner `None` when it
/// has one and no prompt of its own has permitted anything.
fn read_permission_instructions<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
) -> Result<Option<Option<String>>>
where
    S: GStore + GStoreMut + Planner,
{
    let rows = table(TABLE_NAME)
        .select()
        .filter(
            col("thread_id")
                .eq(text(thread_id.to_owned()))
                .and(Membership::Active.filter()),
        )
        .project(vec![col("permission_instructions")])
        .limit(1)
        .execute(glue)
        .rows_as::<PermissionInstructionsRow>()?;
    Ok(rows.into_iter().next().map(|row| {
        row.permission_instructions
            .filter(|instructions| !instructions.is_empty())
    }))
}

fn write_permission_instructions<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
    instructions: Option<&str>,
) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .update()
        .filter(col("thread_id").eq(text(thread_id.to_owned())))
        .filter(Membership::Active.filter())
        .set("permission_instructions", optional_text(instructions))
        .execute(glue)?;
    Ok(())
}

fn bound_permission_instructions(instructions: String) -> String {
    if instructions.len() <= MAX_PERMISSION_INSTRUCTIONS_BYTES {
        return instructions;
    }
    let mut entries: Vec<&str> = instructions
        .split(PERMISSION_INSTRUCTION_SEPARATOR)
        .collect();
    while entries.len() > 1
        && entries.join(PERMISSION_INSTRUCTION_SEPARATOR).len() > MAX_PERMISSION_INSTRUCTIONS_BYTES
    {
        entries.remove(0);
    }
    let bounded = entries.join(PERMISSION_INSTRUCTION_SEPARATOR);
    if bounded.len() <= MAX_PERMISSION_INSTRUCTIONS_BYTES {
        return bounded;
    }
    // One entry can be over the bound on its own. Its end is kept, because
    // that is the side a later statement was added to.
    let start = bounded.len() - MAX_PERMISSION_INSTRUCTIONS_BYTES;
    let start = (start..=bounded.len())
        .find(|index| bounded.is_char_boundary(*index))
        .unwrap_or(bounded.len());
    bounded[start..].to_string()
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct PermissionInstructionsRow {
    permission_instructions: Option<String>,
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
        .set("pin_position", optional_integer(row.pin_position))
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
    // Only unpinning and archiving take a Task out of the pinned Tasks.
    if let Some(placement) = target
        .placement
        .as_mut()
        .filter(|placement| placement.pinned())
    {
        if placement.section_id != section_id {
            placement.section_id = section_id.to_string();
            update_all(glue, &target)?;
        }
        return Ok(target);
    }
    place_first_in_section(glue, target, section_id)
}

fn place_first_in_section<S>(
    glue: &mut Glue<S>,
    mut target: ManagedThread,
    section_id: &str,
) -> Result<ManagedThread>
where
    S: GStore + GStoreMut + Planner,
{
    let order = Order::Section(section_id.to_string());
    let others = ordered(glue, &order)?
        .into_iter()
        .filter(|thread| thread.thread_id != target.thread_id)
        .collect::<Vec<_>>();
    let first = others.first().and_then(|thread| order.position_of(thread));
    if order
        .position_of(&target)
        .is_some_and(|position| first.is_none_or(|first| position < first))
    {
        return Ok(target);
    }
    let position = match first {
        Some(first) => first.checked_sub(POSITION_STEP),
        None => Some(0),
    };
    target.placement = Some(Placement {
        section_id: section_id.to_string(),
        position: Position::InSection(position.unwrap_or_default()),
    });
    if position.is_some() {
        update_all(glue, &target)?;
        return Ok(target);
    }

    let mut final_order = Vec::with_capacity(others.len() + 1);
    final_order.push(target);
    final_order.extend(others);
    rebalance(glue, &mut final_order)?;
    Ok(final_order.remove(0))
}

/// Put a placed Task first among the pinned Tasks. Reports whether it moved;
/// a Task already pinned stays where it is.
pub(super) fn pin<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(mut target) = get(glue, thread_id)? else {
        return Err(TaskStoreError::TaskPinUnavailable(
            "pinned Task is not managed and active",
        ));
    };
    let Some(section_id) = target.section_id().map(str::to_string) else {
        return Err(TaskStoreError::TaskPinUnavailable(
            "pinned Task has no Section to be listed under",
        ));
    };
    if target.pinned() {
        return Ok(false);
    }
    let pinned = ordered(glue, &Order::Pinned)?;
    let position = match pinned.first() {
        Some(first) => Order::Pinned
            .position_of(first)
            .and_then(|position| position.checked_sub(POSITION_STEP)),
        None => Some(0),
    };
    target.placement = Some(Placement {
        section_id,
        position: Position::Pinned(position.unwrap_or_default()),
    });
    if position.is_some() {
        update_all(glue, &target)?;
        return Ok(true);
    }

    let mut final_order = Vec::with_capacity(pinned.len() + 1);
    final_order.push(target);
    final_order.extend(pinned);
    rebalance(glue, &mut final_order)?;
    Ok(true)
}

/// Return a pinned Task to the top of its Section. Reports whether it moved;
/// a Task that is not pinned stays where it is.
pub(super) fn unpin<S>(glue: &mut Glue<S>, thread_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let Some(target) = get(glue, thread_id)? else {
        return Err(TaskStoreError::TaskPinUnavailable(
            "unpinned Task is not managed and active",
        ));
    };
    let Some(section_id) = target
        .placement
        .as_ref()
        .filter(|placement| placement.pinned())
        .map(|placement| placement.section_id.clone())
    else {
        return Ok(false);
    };
    place_first_in_section(glue, target, &section_id)?;
    Ok(true)
}

/// Move a Task within its own run of the list: its Section's Tasks, or the
/// pinned Tasks. The anchor has to be in the same run.
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
    let Some(order) = target.placement.as_ref().map(Order::of) else {
        return Err(TaskStoreError::TaskReorderUnavailable(
            "moved Task has no canonical Section placement",
        ));
    };
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
        if order.position_of(&anchor).is_none() {
            return Err(TaskStoreError::TaskReorderConflict(match order {
                Order::Section(_) => "the requested anchor is not placed in the same Section",
                Order::Pinned => "the requested anchor is not pinned",
            }));
        }
    }

    let original = ordered(glue, &order)?;
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
        .and_then(|index| order.position_of(&final_order[index]));
    let next = final_order
        .get(moved_index + 1)
        .and_then(|thread| order.position_of(thread));
    match (
        sparse_position_between(previous, next),
        final_order[moved_index].placement.as_mut(),
    ) {
        (Some(position), Some(placement)) => {
            placement.position = placement.position.at(position);
            update_all(glue, &final_order[moved_index])?;
        }
        _ => rebalance(glue, &mut final_order)?,
    }
    Ok(true)
}

/// The active Tasks in one run of the list, in their order.
fn ordered<S>(glue: &mut Glue<S>, order: &Order) -> Result<Vec<ManagedThread>>
where
    S: GStore + GStoreMut + Planner,
{
    let mut threads = list(glue, None, usize::MAX)?
        .0
        .into_iter()
        .filter(|thread| order.position_of(thread).is_some())
        .collect::<Vec<_>>();
    threads.sort_by(|left, right| {
        order
            .position_of(left)
            .cmp(&order.position_of(right))
            .then_with(|| left.thread_id.cmp(&right.thread_id))
    });
    Ok(threads)
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
        let placement = thread
            .placement
            .as_mut()
            .ok_or(TaskStoreError::InvalidRow("section_placement"))?;
        let position = i64::try_from(index)
            .ok()
            .and_then(|index| index.checked_mul(POSITION_STEP))
            .ok_or(TaskStoreError::InvalidRow("section_placement"))?;
        placement.position = placement.position.at(position);
        update_all(glue, thread)?;
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
        managed.placement = Some(Placement {
            section_id: section_id.to_string(),
            position: Position::InSection(position),
        });
        update_all(glue, &managed).unwrap();
    }

    fn run_order(glue: &mut Glue<MemoryStorage>, order: &Order) -> Vec<(String, i64)> {
        ordered(glue, order)
            .unwrap()
            .into_iter()
            .map(|thread| {
                let position = order.position_of(&thread).unwrap();
                (thread.thread_id, position)
            })
            .collect()
    }

    fn section_order(glue: &mut Glue<MemoryStorage>, section_id: &str) -> Vec<(String, i64)> {
        run_order(glue, &Order::Section(section_id.to_string()))
    }

    fn pinned_order(glue: &mut Glue<MemoryStorage>) -> Vec<(String, i64)> {
        run_order(glue, &Order::Pinned)
    }

    fn position_in_section(glue: &mut Glue<MemoryStorage>, id: &str) -> Option<i64> {
        let thread = get(glue, id).unwrap().unwrap();
        thread
            .section_id()
            .and_then(|section_id| Order::Section(section_id.to_string()).position_of(&thread))
    }

    #[test]
    fn find_reads_a_task_on_either_list_and_nothing_once_it_is_deleted() {
        let mut glue = memory();
        claim(&mut glue, thread("active", Some(1)), 1).unwrap();
        claim(&mut glue, thread("archived", Some(1)), 1).unwrap();
        archive(&mut glue, "archived", 2).unwrap();
        claim(&mut glue, thread("deleted", Some(1)), 1).unwrap();
        archive(&mut glue, "deleted", 2).unwrap();
        assert!(delete_archived(&mut glue, "deleted").unwrap());

        let active = find(&mut glue, "active").unwrap().unwrap();
        assert_eq!(active.archived_at_ms, None);
        let archived = find(&mut glue, "archived").unwrap().unwrap();
        assert_eq!(archived.archived_at_ms, Some(2));
        assert!(find(&mut glue, "deleted").unwrap().is_none());
        assert!(find(&mut glue, "never-claimed").unwrap().is_none());
    }

    #[test]
    fn permission_instructions_accumulate_oldest_first_and_can_be_cleared() {
        let mut glue = memory();
        claim(&mut glue, thread("task-1", Some(1)), 1).unwrap();

        assert_eq!(permission_instructions(&mut glue, "task-1").unwrap(), None);

        append_permission_instructions(&mut glue, "task-1", "target 디렉터리는 지워도 돼").unwrap();
        let stored = append_permission_instructions(&mut glue, "task-1", "이제 아무것도 지우지 마")
            .unwrap()
            .unwrap();

        assert_eq!(
            stored,
            "target 디렉터리는 지워도 돼\n\n이제 아무것도 지우지 마"
        );
        assert_eq!(
            permission_instructions(&mut glue, "task-1").unwrap(),
            Some(stored)
        );

        assert!(clear_permission_instructions(&mut glue, "task-1").unwrap());
        assert_eq!(permission_instructions(&mut glue, "task-1").unwrap(), None);
    }

    #[test]
    fn a_task_that_is_not_active_has_nothing_to_read_append_or_clear() {
        let mut glue = memory();

        assert_eq!(permission_instructions(&mut glue, "missing").unwrap(), None);
        assert_eq!(
            append_permission_instructions(&mut glue, "missing", "anything").unwrap(),
            None
        );
        assert!(!clear_permission_instructions(&mut glue, "missing").unwrap());
    }

    #[test]
    fn instructions_past_the_bound_lose_their_oldest_entries_first() {
        let mut glue = memory();
        claim(&mut glue, thread("task-1", Some(1)), 1).unwrap();
        let entry = |index: usize| format!("entry-{index:02} {}", "x".repeat(1000));

        for index in 0..12 {
            append_permission_instructions(&mut glue, "task-1", &entry(index)).unwrap();
        }

        let stored = permission_instructions(&mut glue, "task-1")
            .unwrap()
            .unwrap();
        assert!(
            stored.len() <= MAX_PERMISSION_INSTRUCTIONS_BYTES,
            "{}",
            stored.len()
        );
        assert!(stored.ends_with(&entry(11)), "the newest entry is kept");
        assert!(!stored.contains(&entry(0)), "the oldest entry is dropped");
    }

    #[test]
    fn one_entry_larger_than_the_bound_keeps_its_end_on_a_character_boundary() {
        let mut glue = memory();
        claim(&mut glue, thread("task-1", Some(1)), 1).unwrap();
        let huge = format!("{}끝", "가".repeat(MAX_PERMISSION_INSTRUCTIONS_BYTES));

        let stored = append_permission_instructions(&mut glue, "task-1", &huge)
            .unwrap()
            .unwrap();

        assert!(
            stored.len() <= MAX_PERMISSION_INSTRUCTIONS_BYTES,
            "{}",
            stored.len()
        );
        assert!(stored.ends_with("끝"));
    }

    #[test]
    fn instructions_survive_a_whole_thread_update_that_does_not_name_them() {
        let mut glue = memory();
        let managed = claim(&mut glue, thread("task-1", Some(1)), 1).unwrap();
        append_permission_instructions(&mut glue, "task-1", "테스트 돌려도 돼").unwrap();

        update_all(&mut glue, &managed).unwrap();

        assert_eq!(
            permission_instructions(&mut glue, "task-1").unwrap(),
            Some("테스트 돌려도 돼".to_string())
        );
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
    fn a_config_dir_is_read_only_for_a_claude_task_and_never_blank() {
        // Another agent with a Claude config directory, or a blank one, is a
        // row this release did not write. Reading it would start a session
        // under an account nobody chose.
        let mut row = stored_row("thread-1");
        row.claude_config_dir = Some("/Users/example/.claude-work".to_string());
        assert!(matches!(
            ManagedThread::try_from(row.clone()),
            Err(TaskStoreError::InvalidRow("claude_config_dir"))
        ));

        row.provider = "claude".to_string();
        row.cwd = Some("/Users/example/project".to_string());
        assert_eq!(
            ManagedThread::try_from(row.clone()).unwrap().run_by,
            RunBy::Claude {
                cwd: "/Users/example/project".to_string(),
                config_dir: Some("/Users/example/.claude-work".to_string()),
            }
        );

        row.claude_config_dir = Some("  ".to_string());
        assert!(matches!(
            ManagedThread::try_from(row),
            Err(TaskStoreError::InvalidRow("claude_config_dir"))
        ));
    }

    #[test]
    fn a_task_keeps_the_config_dir_it_was_claimed_under() {
        let mut glue = memory();
        let claude = ManagedThread {
            run_by: RunBy::Claude {
                cwd: "/Users/example/project".to_string(),
                config_dir: Some("/Users/example/.claude-work".to_string()),
            },
            ..ManagedThread::new("thread-1", RunBy::Codex, Some(10), None, None)
        };
        claim(&mut glue, claude.clone(), 100).unwrap();
        update_display_name(&mut glue, "thread-1", "Renamed").unwrap();
        archive(&mut glue, "thread-1", 200).unwrap();
        restore(&mut glue, "thread-1").unwrap();

        assert_eq!(
            get(&mut glue, "thread-1").unwrap().unwrap().run_by,
            claude.run_by
        );
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
                config_dir: None,
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
                config_dir: Some("/Users/example/.claude-work".to_string()),
            },
            display_name: "Fully populated".to_string(),
            placement: None,
            archived_at_ms: Some(110),
            last_observed_recency_ms: Some(120),
            claimed_at_ms: 100,
            last_opened_at_ms: Some(130),
            last_seen_activity_ms: Some(140),
            last_completed_at_ms: Some(150),
            model: Some("gpt-test".to_string()),
            reasoning_effort: Some("xhigh".to_string()),
            fast_mode: true,
            permission_mode: Some("autoMode".to_string()),
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

        update_composer_settings(
            &mut glue,
            "task",
            &ComposerSettings {
                model: Some("gpt-test".to_string()),
                reasoning_effort: Some("xhigh".to_string()),
                fast_mode: true,
                permission_mode: None,
            },
        )
        .unwrap();
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

        let seen = mark_seen(&mut glue, "task", 40, Some(45), 150)
            .unwrap()
            .unwrap();
        assert_eq!(seen.last_opened_at_ms, Some(150));
        assert_eq!(seen.last_seen_activity_ms, Some(45));
        assert!(!seen.unseen());
    }

    #[test]
    fn seeing_recovered_history_does_not_acknowledge_a_later_completion() {
        let mut glue = memory();
        claim(&mut glue, thread("task", Some(20)), 100).unwrap();
        // History was recovered without observing its live completion event.
        let seen = mark_seen(&mut glue, "task", 40, Some(45), 150)
            .unwrap()
            .unwrap();
        assert_eq!(seen.last_seen_activity_ms, Some(45));
        assert_eq!(seen.last_completed_at_ms, None);

        update_completed_at(&mut glue, "task", 60).unwrap();
        // A click for the previous completion raced with the next completion.
        let seen = mark_seen(&mut glue, "task", 40, Some(45), 160)
            .unwrap()
            .unwrap();
        assert_eq!(seen.last_completed_at_ms, Some(60));
        assert_eq!(seen.last_seen_activity_ms, Some(45));
        assert!(seen.unseen());
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
        assert_eq!(
            mark_seen(&mut glue, "missing", 100, None, 100).unwrap(),
            None
        );
        assert_eq!(
            update_composer_settings(&mut glue, "missing", &ComposerSettings::default()).unwrap(),
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
        assert_eq!(position_in_section(&mut glue, "c"), Some(-2048));

        let archived = archive(&mut glue, "b", 2).unwrap().unwrap();
        assert_eq!(archived.display_name, "Task B");
        assert_eq!(archived.placement, None);
        assert_eq!(
            section_order(&mut glue, "one"),
            [("c".to_string(), -2048), ("a".to_string(), 0)]
        );

        let restored = restore_at_top(&mut glue, "b", "one").unwrap().unwrap();
        assert_eq!(restored.display_name, "Task B");
        assert_eq!(position_in_section(&mut glue, "b"), Some(-3072));
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
        assert_eq!(position_in_section(&mut glue, "b"), Some(-1024));
        assert_eq!(position_in_section(&mut glue, "a"), Some(0));
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

    #[test]
    fn placement_columns_name_exactly_one_place() {
        let in_section = Placement {
            section_id: "one".to_string(),
            position: Position::InSection(-1024),
        };
        let pinned = Placement {
            section_id: "one".to_string(),
            position: Position::Pinned(0),
        };
        for placement in [&in_section, &pinned] {
            let (section_id, position_in_section, pin_position) =
                Placement::to_row(Some(placement), false).unwrap();
            assert_eq!(
                Placement::from_row(section_id, position_in_section, pin_position, false)
                    .unwrap()
                    .as_ref(),
                Some(placement)
            );
        }
        assert_eq!(Placement::to_row(None, true).unwrap(), (None, None, None));
        assert_eq!(
            Placement::from_row(Some(" ".to_string()), None, None, false).unwrap(),
            None
        );

        let refused = [
            (Some("one"), Some(0), Some(0), false),
            (None, None, Some(0), false),
            (Some("one"), None, None, false),
            (Some("one"), Some(0), None, true),
            (Some("one"), None, Some(0), true),
        ];
        for (section_id, position_in_section, pin_position, archived) in refused {
            assert!(matches!(
                Placement::from_row(
                    section_id.map(str::to_string),
                    position_in_section,
                    pin_position,
                    archived,
                ),
                Err(TaskStoreError::InvalidRow("section_placement"))
            ));
        }
        assert!(matches!(
            Placement::to_row(Some(&pinned), true),
            Err(TaskStoreError::InvalidRow("section_placement"))
        ));
    }

    #[test]
    fn pinning_puts_a_task_first_among_the_pinned_and_out_of_its_section() {
        let mut glue = memory();
        for id in ["a", "b", "c"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }

        assert!(pin(&mut glue, "b").unwrap());
        assert_eq!(pinned_order(&mut glue), [("b".to_string(), 0)]);
        assert_eq!(
            section_order(&mut glue, "one"),
            [("c".to_string(), -2048), ("a".to_string(), 0)]
        );
        let pinned = get(&mut glue, "b").unwrap().unwrap();
        assert!(pinned.pinned());
        assert_eq!(pinned.section_id(), Some("one"));
        assert_eq!(pinned.position_in_section(), None);

        assert!(pin(&mut glue, "a").unwrap());
        assert!(!pin(&mut glue, "a").unwrap());
        assert_eq!(
            pinned_order(&mut glue),
            [("a".to_string(), -1024), ("b".to_string(), 0)]
        );
        assert_eq!(section_order(&mut glue, "one"), [("c".to_string(), -2048)]);
    }

    #[test]
    fn unpinning_returns_a_task_to_the_top_of_its_section() {
        let mut glue = memory();
        for id in ["a", "b", "c"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }
        pin(&mut glue, "a").unwrap();
        pin(&mut glue, "b").unwrap();

        assert!(unpin(&mut glue, "a").unwrap());
        assert!(!unpin(&mut glue, "a").unwrap());
        assert!(!unpin(&mut glue, "c").unwrap());
        assert_eq!(pinned_order(&mut glue), [("b".to_string(), -1024)]);
        assert_eq!(
            section_order(&mut glue, "one"),
            [("a".to_string(), -3072), ("c".to_string(), -2048)]
        );
        assert!(!get(&mut glue, "a").unwrap().unwrap().pinned());
    }

    #[test]
    fn pinned_tasks_reorder_among_themselves_only() {
        let mut glue = memory();
        for id in ["a", "b", "c", "d"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }
        for id in ["a", "b", "c"] {
            pin(&mut glue, id).unwrap();
        }
        assert_eq!(
            pinned_order(&mut glue),
            [
                ("c".to_string(), -2048),
                ("b".to_string(), -1024),
                ("a".to_string(), 0),
            ]
        );

        assert!(move_before(&mut glue, "a", Some("c")).unwrap());
        assert!(!move_before(&mut glue, "a", Some("c")).unwrap());
        assert_eq!(
            pinned_order(&mut glue),
            [
                ("a".to_string(), -3072),
                ("c".to_string(), -2048),
                ("b".to_string(), -1024),
            ]
        );
        assert!(matches!(
            move_before(&mut glue, "a", Some("d")),
            Err(TaskStoreError::TaskReorderConflict(
                "the requested anchor is not pinned"
            ))
        ));
        assert!(matches!(
            move_before(&mut glue, "d", Some("a")),
            Err(TaskStoreError::TaskReorderConflict(
                "the requested anchor is not placed in the same Section"
            ))
        ));
        assert_eq!(section_order(&mut glue, "one"), [("d".to_string(), -3072)]);
    }

    #[test]
    fn pinning_rebalances_checked_rank_underflow() {
        let mut glue = memory();
        place_with_rank(&mut glue, "a", "one", 0);
        place_with_rank(&mut glue, "b", "one", 1024);
        let mut first = get(&mut glue, "a").unwrap().unwrap();
        first.placement = Some(Placement {
            section_id: "one".to_string(),
            position: Position::Pinned(i64::MIN),
        });
        update_all(&mut glue, &first).unwrap();

        assert!(pin(&mut glue, "b").unwrap());

        assert_eq!(
            pinned_order(&mut glue),
            [("b".to_string(), 0), ("a".to_string(), 1024)]
        );
    }

    #[test]
    fn placing_the_first_task_at_its_section_top_leaves_it_in_place() {
        let mut glue = memory();
        for id in ["a", "b"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }

        place_at_top(&mut glue, "b", "one").unwrap();

        assert_eq!(
            section_order(&mut glue, "one"),
            [("b".to_string(), -1024), ("a".to_string(), 0)]
        );
    }

    #[test]
    fn placing_at_a_section_top_leaves_a_pinned_task_pinned() {
        let mut glue = memory();
        for id in ["a", "b"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }
        pin(&mut glue, "a").unwrap();

        place_at_top(&mut glue, "a", "one").unwrap();
        claim_at_top(&mut glue, thread("a", Some(2)), "a", "one", 2).unwrap();
        assert_eq!(pinned_order(&mut glue), [("a".to_string(), 0)]);
        assert_eq!(section_order(&mut glue, "one"), [("b".to_string(), -1024)]);

        place_at_top(&mut glue, "a", "two").unwrap();
        let moved = get(&mut glue, "a").unwrap().unwrap();
        assert!(moved.pinned());
        assert_eq!(moved.section_id(), Some("two"));
        assert!(unpin(&mut glue, "a").unwrap());
        assert_eq!(section_order(&mut glue, "two"), [("a".to_string(), 0)]);
    }

    #[test]
    fn archiving_unpins_and_restoring_places_at_the_section_top() {
        let mut glue = memory();
        for id in ["a", "b"] {
            claim_at_top(&mut glue, thread(id, Some(1)), id, "one", 1).unwrap();
        }
        pin(&mut glue, "a").unwrap();

        let archived = archive(&mut glue, "a", 2).unwrap().unwrap();
        assert_eq!(archived.placement, None);
        assert!(pinned_order(&mut glue).is_empty());

        let restored = restore_at_top(&mut glue, "a", "one").unwrap().unwrap();
        assert!(!restored.pinned());
        assert_eq!(
            section_order(&mut glue, "one"),
            [("a".to_string(), -2048), ("b".to_string(), -1024)]
        );
    }

    #[test]
    fn pinning_needs_an_active_task_with_a_section() {
        let mut glue = memory();
        claim(&mut glue, thread("unplaced", Some(1)), 1).unwrap();
        place_with_rank(&mut glue, "archived", "one", 0);
        archive(&mut glue, "archived", 2).unwrap();

        for id in ["missing", "archived", "unplaced"] {
            assert!(matches!(
                pin(&mut glue, id),
                Err(TaskStoreError::TaskPinUnavailable(_))
            ));
        }
        for id in ["missing", "archived"] {
            assert!(matches!(
                unpin(&mut glue, id),
                Err(TaskStoreError::TaskPinUnavailable(_))
            ));
        }
        assert!(!unpin(&mut glue, "unplaced").unwrap());
    }
}
