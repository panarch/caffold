use chrono::{DateTime, NaiveDateTime, Utc};
use gluesql::{
    FromGlueRow, ToGlueRow,
    core::{
        data::Value,
        executor::Payload,
        query_builder::{
            Execute, ExprNode, begin, col, commit, null, rollback, table, text, value as glue_value,
        },
        row_conversion::ToGlueRow as _,
        store::{GStore, GStoreMut, Planner},
    },
    prelude::{Glue, RedbStorage, SelectResultExt},
};

use super::{Result, TaskStoreError};

pub(super) const TABLE_NAME: &str = "push_installations";

const COLUMN_DEFINITIONS: &[&str] = &[
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushSubscriptionInput {
    pub client_id: String,
    pub installation_label: String,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    pub expiration_time_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushInstallation {
    pub client_id: String,
    pub installation_label: Option<String>,
    pub endpoint: Option<String>,
    pub p256dh: Option<String>,
    pub auth: Option<String>,
    pub expiration_time_ms: Option<u64>,
    pub revoked_at_ms: Option<u64>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

impl PushInstallation {
    pub(crate) fn is_active(&self) -> bool {
        self.revoked_at_ms.is_none()
            && self.installation_label.is_some()
            && self.endpoint.is_some()
            && self.p256dh.is_some()
            && self.auth.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PushInstallationSummary {
    pub client_id: String,
    pub installation_label: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, FromGlueRow, ToGlueRow)]
struct PushInstallationRow {
    client_id: String,
    installation_label: Option<String>,
    endpoint: Option<String>,
    p256dh: Option<String>,
    auth: Option<String>,
    expiration_at: Option<NaiveDateTime>,
    revoked_at: Option<NaiveDateTime>,
    created_at: NaiveDateTime,
    updated_at: NaiveDateTime,
}

impl TryFrom<PushInstallationRow> for PushInstallation {
    type Error = TaskStoreError;

    fn try_from(row: PushInstallationRow) -> Result<Self> {
        let installation = Self {
            client_id: row.client_id,
            installation_label: row.installation_label,
            endpoint: row.endpoint,
            p256dh: row.p256dh,
            auth: row.auth,
            expiration_time_ms: from_optional_timestamp(row.expiration_at, "expiration_at")?,
            revoked_at_ms: from_optional_timestamp(row.revoked_at, "revoked_at")?,
            created_at_ms: from_timestamp(row.created_at, "created_at")?,
            updated_at_ms: from_timestamp(row.updated_at, "updated_at")?,
        };
        let active_shape = installation.revoked_at_ms.is_none()
            && installation.installation_label.is_some()
            && installation.endpoint.is_some()
            && installation.p256dh.is_some()
            && installation.auth.is_some();
        let revoked_shape = installation.revoked_at_ms.is_some()
            && installation.endpoint.is_none()
            && installation.p256dh.is_none()
            && installation.auth.is_none()
            && installation.expiration_time_ms.is_none();
        if !active_shape && !revoked_shape {
            return Err(TaskStoreError::InvalidRow("push_installations"));
        }
        Ok(installation)
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

pub(super) fn get<S>(glue: &mut Glue<S>, client_id: &str) -> Result<Option<PushInstallation>>
where
    S: GStore + GStoreMut + Planner,
{
    rows(glue, Some(col("client_id").eq(text(client_id.to_owned()))))?
        .into_iter()
        .next()
        .map(TryInto::try_into)
        .transpose()
}

pub(super) fn list_active<S>(glue: &mut Glue<S>) -> Result<Vec<PushInstallation>>
where
    S: GStore + GStoreMut + Planner,
{
    rows(glue, Some(col("revoked_at").is_null()))?
        .into_iter()
        .map(TryInto::try_into)
        .collect()
}

pub(super) fn list_summaries<S>(glue: &mut Glue<S>) -> Result<Vec<PushInstallationSummary>>
where
    S: GStore + GStoreMut + Planner,
{
    let mut summaries = list_active(glue)?
        .into_iter()
        .map(|installation| {
            Ok(PushInstallationSummary {
                client_id: installation.client_id,
                installation_label: installation
                    .installation_label
                    .ok_or(TaskStoreError::InvalidRow("installation_label"))?,
                created_at_ms: installation.created_at_ms,
                updated_at_ms: installation.updated_at_ms,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    summaries.sort_by(|left, right| {
        right
            .updated_at_ms
            .cmp(&left.updated_at_ms)
            .then_with(|| left.client_id.cmp(&right.client_id))
    });
    Ok(summaries)
}

pub(super) fn upsert<S>(
    glue: &mut Glue<S>,
    input: PushSubscriptionInput,
    now_ms: u64,
) -> Result<PushInstallation>
where
    S: GStore + GStoreMut + Planner,
{
    upsert_inner(glue, input, now_ms)
}

pub(super) fn upsert_transactional(
    glue: &mut Glue<RedbStorage>,
    input: PushSubscriptionInput,
    now_ms: u64,
) -> Result<PushInstallation> {
    begin().execute(glue)?;
    let result = upsert_inner(glue, input, now_ms);
    match result {
        Ok(installation) => {
            commit().execute(glue)?;
            Ok(installation)
        }
        Err(error) => {
            let _ = rollback().execute(glue);
            Err(error)
        }
    }
}

fn upsert_inner<S>(
    glue: &mut Glue<S>,
    input: PushSubscriptionInput,
    now_ms: u64,
) -> Result<PushInstallation>
where
    S: GStore + GStoreMut + Planner,
{
    let now = to_timestamp(now_ms, "updated_at")?;
    let expiration_at = input
        .expiration_time_ms
        .map(|value| to_timestamp(value, "expiration_at"))
        .transpose()?;
    let created_at = get(glue, &input.client_id)?
        .map(|existing| to_timestamp(existing.created_at_ms, "created_at"))
        .transpose()?
        .unwrap_or(now);

    // A Push endpoint identifies one provider subscription. Replacing its owning
    // installation prevents a regenerated local client ID from leaving an orphan.
    table(TABLE_NAME)
        .delete()
        .filter(
            col("endpoint")
                .eq(text(input.endpoint.clone()))
                .and(col("client_id").neq(text(input.client_id.clone()))),
        )
        .execute(glue)?;

    let row = PushInstallationRow {
        client_id: input.client_id.clone(),
        installation_label: Some(input.installation_label),
        endpoint: Some(input.endpoint),
        p256dh: Some(input.p256dh),
        auth: Some(input.auth),
        expiration_at,
        revoked_at: None,
        created_at,
        updated_at: now,
    };
    if get(glue, &input.client_id)?.is_some() {
        update_row(glue, row)?;
    } else {
        table(TABLE_NAME)
            .insert()
            .values_from(std::slice::from_ref(&row))?
            .execute(glue)?;
    }
    get(glue, &input.client_id)?.ok_or(TaskStoreError::UnexpectedPayload)
}

pub(super) fn revoke<S>(glue: &mut Glue<S>, client_id: &str, now_ms: u64) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    revoke_inner(glue, client_id, now_ms)
}

pub(super) fn revoke_transactional(
    glue: &mut Glue<RedbStorage>,
    client_id: &str,
    now_ms: u64,
) -> Result<()> {
    begin().execute(glue)?;
    let result = revoke_inner(glue, client_id, now_ms);
    match result {
        Ok(()) => {
            commit().execute(glue)?;
            Ok(())
        }
        Err(error) => {
            let _ = rollback().execute(glue);
            Err(error)
        }
    }
}

fn revoke_inner<S>(glue: &mut Glue<S>, client_id: &str, now_ms: u64) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let now = to_timestamp(now_ms, "revoked_at")?;
    let existing = get(glue, client_id)?;
    let row = PushInstallationRow {
        client_id: client_id.to_owned(),
        installation_label: existing
            .as_ref()
            .and_then(|installation| installation.installation_label.clone()),
        endpoint: None,
        p256dh: None,
        auth: None,
        expiration_at: None,
        revoked_at: Some(now),
        created_at: existing
            .as_ref()
            .map(|installation| to_timestamp(installation.created_at_ms, "created_at"))
            .transpose()?
            .unwrap_or(now),
        updated_at: now,
    };
    if existing.is_some() {
        update_row(glue, row)?;
    } else {
        table(TABLE_NAME)
            .insert()
            .values_from(std::slice::from_ref(&row))?
            .execute(glue)?;
    }
    Ok(())
}

pub(super) fn delete_if_endpoint_matches<S>(
    glue: &mut Glue<S>,
    client_id: &str,
    endpoint: &str,
) -> Result<bool>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(TABLE_NAME)
        .delete()
        .filter(
            col("client_id")
                .eq(text(client_id.to_owned()))
                .and(col("endpoint").eq(text(endpoint.to_owned()))),
        )
        .execute(glue)?;
    match payload {
        Payload::Delete(count) => Ok(count > 0),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn rows<S>(
    glue: &mut Glue<S>,
    filter: Option<ExprNode<'static>>,
) -> Result<Vec<PushInstallationRow>>
where
    S: GStore + GStoreMut + Planner,
{
    table(TABLE_NAME)
        .select()
        .filter(filter.unwrap_or_else(|| col("client_id").is_not_null()))
        .project(
            PushInstallationRow::glue_columns()
                .iter()
                .map(|column| col(*column))
                .collect::<Vec<_>>(),
        )
        .execute(glue)
        .rows_as::<PushInstallationRow>()
        .map_err(Into::into)
}

fn update_row<S>(glue: &mut Glue<S>, row: PushInstallationRow) -> Result<()>
where
    S: GStore + GStoreMut + Planner,
{
    let payload = table(TABLE_NAME)
        .update()
        .filter(col("client_id").eq(text(row.client_id)))
        .set("installation_label", optional_text(row.installation_label))
        .set("endpoint", optional_text(row.endpoint))
        .set("p256dh", optional_text(row.p256dh))
        .set("auth", optional_text(row.auth))
        .set("expiration_at", optional_timestamp(row.expiration_at))
        .set("revoked_at", optional_timestamp(row.revoked_at))
        .set("created_at", timestamp(row.created_at))
        .set("updated_at", timestamp(row.updated_at))
        .execute(glue)?;
    match payload {
        Payload::Update(1) => Ok(()),
        _ => Err(TaskStoreError::UnexpectedPayload),
    }
}

fn optional_text(value: Option<String>) -> ExprNode<'static> {
    value.map_or_else(null, text)
}

fn timestamp(value: NaiveDateTime) -> ExprNode<'static> {
    glue_value(Value::Timestamp(value))
}

fn optional_timestamp(timestamp: Option<NaiveDateTime>) -> ExprNode<'static> {
    timestamp.map_or_else(null, |timestamp| glue_value(Value::Timestamp(timestamp)))
}

fn to_timestamp(value: u64, field: &'static str) -> Result<NaiveDateTime> {
    let value = i64::try_from(value).map_err(|_| TaskStoreError::InvalidRow(field))?;
    DateTime::<Utc>::from_timestamp_millis(value)
        .map(|timestamp| timestamp.naive_utc())
        .ok_or(TaskStoreError::InvalidRow(field))
}

fn from_timestamp(value: NaiveDateTime, field: &'static str) -> Result<u64> {
    u64::try_from(value.and_utc().timestamp_millis()).map_err(|_| TaskStoreError::InvalidRow(field))
}

fn from_optional_timestamp(
    value: Option<NaiveDateTime>,
    field: &'static str,
) -> Result<Option<u64>> {
    value.map(|value| from_timestamp(value, field)).transpose()
}

#[cfg(test)]
mod tests {
    use gluesql::prelude::MemoryStorage;

    use super::*;

    fn input(client_id: &str, endpoint: &str) -> PushSubscriptionInput {
        PushSubscriptionInput {
            client_id: client_id.to_owned(),
            installation_label: format!("Chrome on macOS · {client_id}"),
            endpoint: endpoint.to_owned(),
            p256dh: "public-key".to_owned(),
            auth: "auth-secret".to_owned(),
            expiration_time_ms: Some(2_000),
        }
    }

    #[test]
    fn upsert_replaces_client_and_endpoint_owners_idempotently() {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();

        let first = upsert(&mut glue, input("client-a", "https://push/a"), 1_000).unwrap();
        assert!(first.is_active());
        assert_eq!(first.created_at_ms, 1_000);

        let replacement = upsert(&mut glue, input("client-a", "https://push/b"), 1_500).unwrap();
        assert_eq!(replacement.endpoint.as_deref(), Some("https://push/b"));
        assert_eq!(replacement.created_at_ms, 1_000);
        assert_eq!(replacement.updated_at_ms, 1_500);

        upsert(&mut glue, input("client-b", "https://push/b"), 1_600).unwrap();
        assert!(get(&mut glue, "client-a").unwrap().is_none());
        assert_eq!(list_active(&mut glue).unwrap().len(), 1);
    }

    #[test]
    fn revocation_is_a_tombstone_and_explicit_upsert_reactivates_it() {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();
        upsert(&mut glue, input("client-a", "https://push/a"), 1_000).unwrap();

        revoke(&mut glue, "client-a", 2_000).unwrap();
        let revoked = get(&mut glue, "client-a").unwrap().unwrap();
        assert!(!revoked.is_active());
        assert_eq!(revoked.revoked_at_ms, Some(2_000));
        assert!(revoked.endpoint.is_none());
        assert!(list_active(&mut glue).unwrap().is_empty());

        let active = upsert(&mut glue, input("client-a", "https://push/new"), 3_000).unwrap();
        assert!(active.is_active());
        assert_eq!(active.revoked_at_ms, None);
        assert_eq!(active.created_at_ms, 1_000);
    }

    #[test]
    fn invalid_provider_cleanup_is_conditional_and_does_not_leave_a_tombstone() {
        let mut glue = Glue::new(MemoryStorage::default());
        create_table(&mut glue).unwrap();
        upsert(&mut glue, input("client-a", "https://push/current"), 1_000).unwrap();

        assert!(!delete_if_endpoint_matches(&mut glue, "client-a", "https://push/stale").unwrap());
        assert!(get(&mut glue, "client-a").unwrap().is_some());
        assert!(delete_if_endpoint_matches(&mut glue, "client-a", "https://push/current").unwrap());
        assert!(get(&mut glue, "client-a").unwrap().is_none());
    }
}
