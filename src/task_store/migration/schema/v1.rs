use chrono::NaiveDateTime;
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        query_builder::{ExprNode, col},
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::Glue,
};

use super::{create_table, validate_table, validate_table_names};
use crate::task_store::{Result, schema_migration};

pub(in crate::task_store::migration) const MANAGED_THREADS_TABLE: &str = "managed_threads";

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
];

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
}

pub(in crate::task_store::migration) fn create<S>(
    glue: &mut Glue<S>,
    applied_at: NaiveDateTime,
) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    create_table(
        glue,
        MANAGED_THREADS_TABLE,
        MANAGED_THREAD_COLUMN_DEFINITIONS,
    )?;
    schema_migration::create_table(glue)?;
    schema_migration::record(glue, 1, applied_at)
}

pub(in crate::task_store::migration) fn validate<S>(glue: &Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    validate_table_names(glue, [MANAGED_THREADS_TABLE, schema_migration::TABLE_NAME])?;
    validate_table(
        glue,
        MANAGED_THREADS_TABLE,
        MANAGED_THREAD_COLUMN_DEFINITIONS,
    )?;
    schema_migration::validate_table(glue)
}

pub(in crate::task_store::migration) fn columns() -> Vec<ExprNode<'static>> {
    ManagedThreadRow::glue_columns()
        .iter()
        .map(|column| col(*column))
        .collect()
}
