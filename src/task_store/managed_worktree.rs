use chrono::{NaiveDateTime, Utc};
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

use super::{Result, TaskStoreError};

pub(super) const TABLE_NAME: &str = "managed_worktrees";

const COLUMN_DEFINITIONS: &[&str] = &[
    "worktree_id TEXT PRIMARY KEY",
    "thread_id TEXT NULL",
    "repository_git_dir TEXT",
    "worktree_path TEXT",
    "branch_name TEXT",
    "head_sha TEXT",
    "state TEXT",
    "created_at TIMESTAMP",
    "updated_at TIMESTAMP",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ManagedWorktreeState {
    Creating,
    IsolatingClean,
    HandingOff,
    Transferring,
    Ready,
    Removing,
    Archived,
    Restoring,
    CleanRecoveryRequired,
    HandoffRecoveryRequired,
    RecoveryRequired,
}

impl ManagedWorktreeState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::IsolatingClean => "isolating_clean",
            Self::HandingOff => "handing_off",
            Self::Transferring => "transferring",
            Self::Ready => "ready",
            Self::Removing => "removing",
            Self::Archived => "archived",
            Self::Restoring => "restoring",
            Self::CleanRecoveryRequired => "clean_recovery_required",
            Self::HandoffRecoveryRequired => "handoff_recovery_required",
            Self::RecoveryRequired => "recovery_required",
        }
    }

    fn parse(value: String) -> Result<Self> {
        match value.as_str() {
            "creating" => Ok(Self::Creating),
            "isolating_clean" => Ok(Self::IsolatingClean),
            "handing_off" => Ok(Self::HandingOff),
            "transferring" => Ok(Self::Transferring),
            "ready" => Ok(Self::Ready),
            "removing" => Ok(Self::Removing),
            "archived" => Ok(Self::Archived),
            "restoring" => Ok(Self::Restoring),
            "clean_recovery_required" => Ok(Self::CleanRecoveryRequired),
            "handoff_recovery_required" => Ok(Self::HandoffRecoveryRequired),
            "recovery_required" => Ok(Self::RecoveryRequired),
            _ => Err(TaskStoreError::InvalidManagedWorktreeState(value)),
        }
    }

    fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (
                Self::Creating,
                Self::Ready | Self::Transferring | Self::RecoveryRequired
            ) | (Self::Transferring, Self::Ready | Self::RecoveryRequired)
                | (Self::RecoveryRequired, Self::Transferring)
                | (
                    Self::IsolatingClean,
                    Self::Ready | Self::CleanRecoveryRequired
                )
                | (Self::CleanRecoveryRequired, Self::IsolatingClean)
                | (
                    Self::HandingOff,
                    Self::Ready | Self::HandoffRecoveryRequired
                )
                | (Self::HandoffRecoveryRequired, Self::HandingOff)
                | (Self::Ready, Self::Removing)
                | (Self::Removing, Self::Ready | Self::Archived)
                | (Self::Archived, Self::Restoring)
                | (Self::Restoring, Self::Archived | Self::Ready)
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ManagedWorktree {
    pub worktree_id: String,
    pub thread_id: Option<String>,
    pub repository_git_dir: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub head_sha: String,
    pub state: ManagedWorktreeState,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
pub(super) struct ManagedWorktreeRow {
    pub worktree_id: String,
    pub thread_id: Option<String>,
    pub repository_git_dir: String,
    pub worktree_path: String,
    pub branch_name: String,
    pub head_sha: String,
    pub state: String,
    pub created_at: NaiveDateTime,
    pub updated_at: NaiveDateTime,
}

impl TryFrom<&ManagedWorktree> for ManagedWorktreeRow {
    type Error = TaskStoreError;

    fn try_from(worktree: &ManagedWorktree) -> Result<Self> {
        Ok(Self {
            worktree_id: worktree.worktree_id.clone(),
            thread_id: worktree.thread_id.clone(),
            repository_git_dir: worktree.repository_git_dir.clone(),
            worktree_path: worktree.worktree_path.clone(),
            branch_name: worktree.branch_name.clone(),
            head_sha: worktree.head_sha.clone(),
            state: worktree.state.as_str().to_string(),
            created_at: to_db_timestamp(worktree.created_at_ms, "created_at_ms")?,
            updated_at: to_db_timestamp(worktree.updated_at_ms, "updated_at_ms")?,
        })
    }
}

impl TryFrom<ManagedWorktreeRow> for ManagedWorktree {
    type Error = TaskStoreError;

    fn try_from(row: ManagedWorktreeRow) -> Result<Self> {
        Ok(Self {
            worktree_id: row.worktree_id,
            thread_id: row.thread_id,
            repository_git_dir: row.repository_git_dir,
            worktree_path: row.worktree_path,
            branch_name: row.branch_name,
            head_sha: row.head_sha,
            state: ManagedWorktreeState::parse(row.state)?,
            created_at_ms: from_db_timestamp(row.created_at, "created_at_ms")?,
            updated_at_ms: from_db_timestamp(row.updated_at, "updated_at_ms")?,
        })
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

pub(super) fn create<S>(glue: &mut Glue<S>, worktree: ManagedWorktree) -> Result<ManagedWorktree>
where
    S: GStore + GStoreMut + Planner,
{
    if let Some(thread_id) = worktree.thread_id.as_deref()
        && get_for_thread(glue, thread_id)?.is_some()
    {
        return Err(TaskStoreError::DuplicateManagedWorktreeThread(
            thread_id.to_string(),
        ));
    }
    if get_for_path(glue, &worktree.worktree_path)?.is_some() {
        return Err(TaskStoreError::DuplicateManagedWorktreePath(
            worktree.worktree_path.clone(),
        ));
    }
    let row = ManagedWorktreeRow::try_from(&worktree)?;
    table(TABLE_NAME)
        .insert()
        .values_from(std::slice::from_ref(&row))?
        .execute(glue)?;
    Ok(worktree)
}

pub(super) fn get<S>(glue: &mut Glue<S>, worktree_id: &str) -> Result<Option<ManagedWorktree>>
where
    S: GStore + GStoreMut + Planner,
{
    select_one(glue, col("worktree_id").eq(text(worktree_id.to_owned())))
}

pub(super) fn get_for_thread<S>(
    glue: &mut Glue<S>,
    thread_id: &str,
) -> Result<Option<ManagedWorktree>>
where
    S: GStore + GStoreMut + Planner,
{
    select_one(glue, col("thread_id").eq(text(thread_id.to_owned())))
}

fn get_for_path<S>(glue: &mut Glue<S>, worktree_path: &str) -> Result<Option<ManagedWorktree>>
where
    S: GStore + GStoreMut + Planner,
{
    select_one(
        glue,
        col("worktree_path").eq(text(worktree_path.to_owned())),
    )
}

pub(super) fn list<S>(glue: &mut Glue<S>) -> Result<Vec<ManagedWorktree>>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .select()
        .project(columns())
        .execute(glue)
        .rows_as::<ManagedWorktreeRow>()?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

#[cfg(test)]
pub(super) fn bind_thread<S>(
    glue: &mut Glue<S>,
    worktree_id: &str,
    thread_id: &str,
    updated_at_ms: u64,
) -> Result<ManagedWorktree>
where
    S: GStore + GStoreMut + Planner,
{
    if let Some(existing) = get_for_thread(glue, thread_id)?
        && existing.worktree_id != worktree_id
    {
        return Err(TaskStoreError::DuplicateManagedWorktreeThread(
            thread_id.to_string(),
        ));
    }
    let mut worktree = required(glue, worktree_id)?;
    if let Some(bound_thread_id) = worktree.thread_id.as_deref()
        && bound_thread_id != thread_id
    {
        return Err(TaskStoreError::ManagedWorktreeAlreadyBound {
            worktree_id: worktree_id.to_string(),
            thread_id: bound_thread_id.to_string(),
        });
    }
    if worktree.state != ManagedWorktreeState::Ready {
        return Err(TaskStoreError::ManagedWorktreeStateConflict {
            worktree_id: worktree_id.to_string(),
            actual: worktree.state.as_str().to_string(),
            expected: ManagedWorktreeState::Ready.as_str().to_string(),
        });
    }
    worktree.thread_id = Some(thread_id.to_string());
    worktree.updated_at_ms = updated_at_ms;
    update_all(glue, &worktree)?;
    Ok(worktree)
}

pub(super) fn update_checkout<S>(
    glue: &mut Glue<S>,
    worktree_id: &str,
    branch_name: &str,
    head_sha: &str,
    updated_at_ms: u64,
) -> Result<ManagedWorktree>
where
    S: GStore + GStoreMut + Planner,
{
    let mut worktree = required(glue, worktree_id)?;
    worktree.branch_name = branch_name.to_string();
    worktree.head_sha = head_sha.to_string();
    worktree.updated_at_ms = updated_at_ms;
    update_all(glue, &worktree)?;
    Ok(worktree)
}

pub(super) fn transition<S>(
    glue: &mut Glue<S>,
    worktree_id: &str,
    expected: ManagedWorktreeState,
    next: ManagedWorktreeState,
    updated_at_ms: u64,
) -> Result<ManagedWorktree>
where
    S: GStore + GStoreMut + Planner,
{
    let mut worktree = required(glue, worktree_id)?;
    if worktree.state != expected {
        return Err(TaskStoreError::ManagedWorktreeStateConflict {
            worktree_id: worktree_id.to_string(),
            actual: worktree.state.as_str().to_string(),
            expected: expected.as_str().to_string(),
        });
    }
    if !expected.can_transition_to(next) {
        return Err(TaskStoreError::InvalidManagedWorktreeTransition {
            from: expected.as_str().to_string(),
            to: next.as_str().to_string(),
        });
    }
    worktree.state = next;
    worktree.updated_at_ms = updated_at_ms;
    update_all(glue, &worktree)?;
    Ok(worktree)
}

pub(super) fn delete<S>(glue: &mut Glue<S>, worktree_id: &str) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(TABLE_NAME)
        .delete()
        .filter(col("worktree_id").eq(text(worktree_id.to_owned())))
        .execute(glue)?;
    match payload {
        Payload::Delete(count) => Ok(count > 0),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

pub(super) fn columns() -> Vec<ExprNode<'static>> {
    ManagedWorktreeRow::glue_columns()
        .iter()
        .map(|column| col(*column))
        .collect()
}

fn select_one<S>(glue: &mut Glue<S>, filter: ExprNode<'static>) -> Result<Option<ManagedWorktree>>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .select()
        .filter(filter)
        .project(columns())
        .limit(1)
        .execute(glue)
        .rows_as::<ManagedWorktreeRow>()?
        .into_iter()
        .next()
        .map(TryInto::try_into)
        .transpose()
}

fn required<S>(glue: &mut Glue<S>, worktree_id: &str) -> Result<ManagedWorktree>
where
    S: GStore + GStoreMut + Planner,
{
    get(glue, worktree_id)?.ok_or(TaskStoreError::InvalidRow("worktree_id"))
}

fn update_all<S>(glue: &mut Glue<S>, worktree: &ManagedWorktree) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let row = ManagedWorktreeRow::try_from(worktree)?;
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("worktree_id").eq(text(row.worktree_id)))
        .set("thread_id", optional_text(row.thread_id.as_deref()))
        .set("repository_git_dir", text(row.repository_git_dir))
        .set("worktree_path", text(row.worktree_path))
        .set("branch_name", text(row.branch_name))
        .set("head_sha", text(row.head_sha))
        .set("state", text(row.state))
        .set("created_at", timestamp_value(row.created_at))
        .set("updated_at", timestamp_value(row.updated_at))
        .execute(glue)?;
    match payload {
        Payload::Update(1) => Ok(()),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

#[cfg(test)]
fn expected_ddl() -> String {
    format!(
        "CREATE TABLE {TABLE_NAME} ({});",
        COLUMN_DEFINITIONS.join(", ")
    )
}

fn optional_text(value: Option<&str>) -> ExprNode<'static> {
    value.map_or_else(null, |value| text(value.to_owned()))
}

fn timestamp_value(timestamp: NaiveDateTime) -> ExprNode<'static> {
    glue_value(Value::Timestamp(timestamp))
}

fn to_db_timestamp(value: u64, field: &'static str) -> Result<NaiveDateTime> {
    let value = i64::try_from(value).map_err(|_| TaskStoreError::InvalidRow(field))?;
    chrono::DateTime::<Utc>::from_timestamp_millis(value)
        .map(|timestamp| timestamp.naive_utc())
        .ok_or(TaskStoreError::InvalidRow(field))
}

fn from_db_timestamp(value: NaiveDateTime, field: &'static str) -> Result<u64> {
    value
        .and_utc()
        .timestamp_millis()
        .try_into()
        .map_err(|_| TaskStoreError::InvalidRow(field))
}

#[cfg(test)]
mod tests {
    use gluesql::prelude::MemoryStorage;

    use super::*;

    fn worktree(id: &str, path: &str) -> ManagedWorktree {
        ManagedWorktree {
            worktree_id: id.to_string(),
            thread_id: None,
            repository_git_dir: "/repo/.git".to_string(),
            worktree_path: path.to_string(),
            branch_name: format!("caffold/{id}"),
            head_sha: "abc123".to_string(),
            state: ManagedWorktreeState::Creating,
            created_at_ms: 100,
            updated_at_ms: 100,
        }
    }

    fn glue() -> Glue<MemoryStorage> {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();
        glue
    }

    #[test]
    fn owns_schema_and_round_trips_lifecycle_fields() {
        let mut glue = glue();
        validate_table(&glue).unwrap();
        let expected = worktree("one", "/managed/one");
        assert_eq!(create(&mut glue, expected.clone()).unwrap(), expected);
        assert_eq!(get(&mut glue, "one").unwrap(), Some(expected));
    }

    #[test]
    fn round_trips_and_transitions_isolation_recovery_modes() {
        let mut glue = glue();
        for (index, state) in [
            ManagedWorktreeState::IsolatingClean,
            ManagedWorktreeState::HandingOff,
            ManagedWorktreeState::CleanRecoveryRequired,
            ManagedWorktreeState::HandoffRecoveryRequired,
        ]
        .into_iter()
        .enumerate()
        {
            let id = format!("mode-{index}");
            let mut expected = worktree(&id, &format!("/managed/{id}"));
            expected.state = state;
            create(&mut glue, expected.clone()).unwrap();
            assert_eq!(get(&mut glue, &id).unwrap(), Some(expected));
        }

        assert!(
            ManagedWorktreeState::IsolatingClean
                .can_transition_to(ManagedWorktreeState::CleanRecoveryRequired)
        );
        assert!(
            ManagedWorktreeState::CleanRecoveryRequired
                .can_transition_to(ManagedWorktreeState::IsolatingClean)
        );
        assert!(
            ManagedWorktreeState::HandingOff
                .can_transition_to(ManagedWorktreeState::HandoffRecoveryRequired)
        );
        assert!(
            ManagedWorktreeState::HandoffRecoveryRequired
                .can_transition_to(ManagedWorktreeState::HandingOff)
        );
    }

    #[test]
    fn binds_threads_updates_checkout_and_enforces_transitions() {
        let mut glue = glue();
        create(&mut glue, worktree("one", "/managed/one")).unwrap();
        transition(
            &mut glue,
            "one",
            ManagedWorktreeState::Creating,
            ManagedWorktreeState::Transferring,
            105,
        )
        .unwrap();
        transition(
            &mut glue,
            "one",
            ManagedWorktreeState::Transferring,
            ManagedWorktreeState::RecoveryRequired,
            106,
        )
        .unwrap();
        transition(
            &mut glue,
            "one",
            ManagedWorktreeState::RecoveryRequired,
            ManagedWorktreeState::Transferring,
            107,
        )
        .unwrap();
        let ready = transition(
            &mut glue,
            "one",
            ManagedWorktreeState::Transferring,
            ManagedWorktreeState::Ready,
            110,
        )
        .unwrap();
        assert_eq!(ready.state, ManagedWorktreeState::Ready);
        assert_eq!(
            bind_thread(&mut glue, "one", "thread", 120)
                .unwrap()
                .thread_id
                .as_deref(),
            Some("thread")
        );
        let updated = update_checkout(&mut glue, "one", "feature/renamed", "def456", 130).unwrap();
        assert_eq!(updated.branch_name, "feature/renamed");
        assert_eq!(updated.head_sha, "def456");
        assert!(matches!(
            transition(
                &mut glue,
                "one",
                ManagedWorktreeState::Creating,
                ManagedWorktreeState::Archived,
                140,
            ),
            Err(TaskStoreError::ManagedWorktreeStateConflict { .. })
        ));
        assert!(matches!(
            bind_thread(&mut glue, "one", "other-thread", 150),
            Err(TaskStoreError::ManagedWorktreeAlreadyBound { .. })
        ));
        assert!(matches!(
            transition(
                &mut glue,
                "one",
                ManagedWorktreeState::Ready,
                ManagedWorktreeState::Restoring,
                160,
            ),
            Err(TaskStoreError::InvalidManagedWorktreeTransition { .. })
        ));
    }

    #[test]
    fn binds_only_ready_worktrees() {
        let mut glue = glue();
        create(&mut glue, worktree("one", "/managed/one")).unwrap();

        assert!(matches!(
            bind_thread(&mut glue, "one", "thread", 110),
            Err(TaskStoreError::ManagedWorktreeStateConflict { .. })
        ));
    }

    #[test]
    fn rejects_duplicate_owned_paths_and_threads() {
        let mut glue = glue();
        let mut first = worktree("one", "/managed/one");
        first.thread_id = Some("thread".to_string());
        create(&mut glue, first).unwrap();
        assert!(matches!(
            create(&mut glue, worktree("two", "/managed/one")),
            Err(TaskStoreError::DuplicateManagedWorktreePath(_))
        ));
        let mut duplicate_thread = worktree("three", "/managed/three");
        duplicate_thread.thread_id = Some("thread".to_string());
        assert!(matches!(
            create(&mut glue, duplicate_thread),
            Err(TaskStoreError::DuplicateManagedWorktreeThread(_))
        ));
    }
}
