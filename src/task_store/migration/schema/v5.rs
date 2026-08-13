use gluesql::{
    core::store::{GStore, GStoreMut, Planner},
    prelude::Glue,
};

use super::{validate_table, validate_table_names};
use crate::task_store::{Result, schema_migration};

pub(in crate::task_store::migration) const MANAGED_THREADS_TABLE: &str = "managed_threads";
pub(in crate::task_store::migration) const MANAGED_SECTIONS_TABLE: &str = "managed_sections";
pub(in crate::task_store::migration) const MANAGED_WORKTREES_TABLE: &str = "managed_worktrees";
pub(in crate::task_store::migration) const PUSH_INSTALLATIONS_TABLE: &str = "push_installations";
pub(in crate::task_store::migration) const PUSH_VAPID_KEYS_TABLE: &str = "push_vapid_keys";

pub(in crate::task_store::migration) const MANAGED_THREAD_COLUMN_DEFINITIONS: &[&str] = &[
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
];

pub(in crate::task_store::migration) const MANAGED_SECTION_COLUMN_DEFINITIONS: &[&str] =
    &["section_id TEXT PRIMARY KEY", "logical_path TEXT"];

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

const PUSH_INSTALLATION_COLUMN_DEFINITIONS: &[&str] = &[
    "client_id TEXT PRIMARY KEY",
    "installation_label TEXT NULL",
    "endpoint TEXT NULL",
    "p256dh TEXT NULL",
    "auth TEXT NULL",
    "expiration_at TIMESTAMP NULL",
    "revoked_at TIMESTAMP NULL",
    "created_at TIMESTAMP",
    "updated_at TIMESTAMP",
];

const PUSH_VAPID_KEY_COLUMN_DEFINITIONS: &[&str] = &[
    "key_id TEXT PRIMARY KEY",
    "private_key TEXT",
    "created_at TIMESTAMP",
];

pub(in crate::task_store::migration) fn validate<S>(glue: &Glue<S>) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    validate_table_names(
        glue,
        [
            MANAGED_THREADS_TABLE,
            MANAGED_SECTIONS_TABLE,
            MANAGED_WORKTREES_TABLE,
            PUSH_INSTALLATIONS_TABLE,
            PUSH_VAPID_KEYS_TABLE,
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
        MANAGED_SECTIONS_TABLE,
        MANAGED_SECTION_COLUMN_DEFINITIONS,
    )?;
    validate_table(
        glue,
        MANAGED_WORKTREES_TABLE,
        MANAGED_WORKTREE_COLUMN_DEFINITIONS,
    )?;
    validate_table(
        glue,
        PUSH_INSTALLATIONS_TABLE,
        PUSH_INSTALLATION_COLUMN_DEFINITIONS,
    )?;
    validate_table(
        glue,
        PUSH_VAPID_KEYS_TABLE,
        PUSH_VAPID_KEY_COLUMN_DEFINITIONS,
    )?;
    schema_migration::validate_table(glue)
}
