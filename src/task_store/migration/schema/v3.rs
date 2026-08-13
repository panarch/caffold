#[cfg(test)]
use chrono::NaiveDateTime;
#[cfg(test)]
use gluesql::core::{
    query_builder::{ExprNode, col},
    row_conversion::ToGlueRow as _,
};
#[cfg(test)]
use gluesql::{FromGlueRow, ToGlueRow};
use gluesql::{
    core::store::{GStore, GStoreMut, Planner},
    prelude::Glue,
};

use super::{validate_table, validate_table_names};
use crate::task_store::{Result, schema_migration};

pub(in crate::task_store::migration) const MANAGED_THREADS_TABLE: &str = "managed_threads";
pub(in crate::task_store::migration) const MANAGED_WORKTREES_TABLE: &str = "managed_worktrees";

const MANAGED_THREAD_COLUMN_DEFINITIONS: &[&str] = &[
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
];

const MANAGED_WORKTREE_COLUMN_DEFINITIONS: &[&str] = &[
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

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
pub(in crate::task_store::migration) struct ManagedThreadRow {
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
}

pub(in crate::task_store::migration) fn validate<S>(glue: &Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    validate_table_names(
        glue,
        [
            MANAGED_THREADS_TABLE,
            MANAGED_WORKTREES_TABLE,
            schema_migration::TABLE_NAME,
        ],
    )?;
    validate_table(
        glue,
        MANAGED_THREADS_TABLE,
        MANAGED_THREAD_COLUMN_DEFINITIONS,
    )?;
    validate_table(
        glue,
        MANAGED_WORKTREES_TABLE,
        MANAGED_WORKTREE_COLUMN_DEFINITIONS,
    )?;
    schema_migration::validate_table(glue)
}

#[cfg(test)]
pub(in crate::task_store::migration) fn managed_thread_columns() -> Vec<ExprNode<'static>> {
    ManagedThreadRow::glue_columns()
        .iter()
        .map(|column| col(*column))
        .collect()
}
