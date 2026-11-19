//! Read the signed-in account's entitlements without starting a Task or sending a prompt.

use super::observe;
use chrono::{DateTime, SecondsFormat};
use copilot_sdk::{
    Client, CreateSessionOptions, SessionId,
    rpc::{AccountGetQuotaResult, SessionQuotaPlanTier, SessionQuotaProjection},
    session_events::{
        ModelProviderKind, ProviderQuotaAcquisitionStatus, ProviderQuotaObservationKind,
        ProviderQuotaQuantityKind, ProviderQuotaState, ProviderQuotaUnit,
    },
};
use serde::Serialize;
use std::collections::BTreeMap;

#[derive(Debug, Default, Serialize)]
pub(super) struct AccountUsage {
    plan: Option<&'static str>,
    quotas: Vec<Quota>,
    errors: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Quota {
    key: String,
    unit: Option<&'static str>,
    unlimited: bool,
    used: f64,
    entitlement: f64,
    remaining_percentage: f64,
    resets_at: Option<String>,
    reset_estimated: bool,
}

pub(super) async fn read(client: &Client) -> AccountUsage {
    let rpc = client.rpc();
    let account = rpc.account();
    let (account, details) = tokio::join!(observe(account.get_quota()), read_session(client));
    let mut usage = AccountUsage::default();
    let mut quotas = BTreeMap::new();

    match account {
        Ok(account) => quotas = account_quotas(account),
        Err(error) => usage
            .errors
            .push(format!("Could not read account allowances. {error}")),
    }
    match details {
        Ok((projection, warning)) => {
            usage.plan = plan(projection.plan_tier);
            if let Some(error) = warning {
                usage.errors.push(error);
            } else {
                apply_budgets(
                    &mut quotas,
                    projection.provider_quotas.unwrap_or_default(),
                    &mut usage.errors,
                );
            }
        }
        Err(error) => usage.errors.push(format!(
            "Could not read Copilot plan and quota details. {error}"
        )),
    }

    usage.quotas = quotas.into_values().collect();
    usage.quotas.sort_by_key(|quota| quota.unlimited);
    usage
}

async fn read_session(client: &Client) -> Result<(SessionQuotaProjection, Option<String>), String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    let id = SessionId::new(uuid::Uuid::new_v4().to_string());
    let options = CreateSessionOptions::default()
        .with_session_id(id.clone())
        .with_working_directory(dir.path())
        .with_enable_config_discovery(false)
        .with_permissions(|permissions| permissions.deny_all_permissions());

    let session = observe(client.create_session(options)).await;
    let result = match session {
        Ok(session) if session.id() == id => {
            let rpc = session.rpc();
            let result = match observe(rpc.quota().refresh()).await {
                Ok(quota) => Ok((quota, None)),
                Err(error) => observe(rpc.quota().get()).await.map(|quota| {
                    (
                        quota,
                        Some(format!("Could not refresh quota details. {error}")),
                    )
                }),
            };
            if let Err(error) = observe(session.disconnect()).await {
                tracing::warn!(%error, "could not disconnect Copilot quota session");
            }
            result
        }
        Ok(_) => Err("Copilot returned an unexpected quota session.".into()),
        Err(error) => Err(error),
    };

    // A timed-out create may already have succeeded in the CLI. Only delete our own ID.
    observe(client.delete_session(&id)).await?;
    result
}

fn account_quotas(account: AccountGetQuotaResult) -> BTreeMap<String, Quota> {
    account
        .quota_snapshots
        .into_iter()
        .map(|(key, row)| {
            let quota = Quota {
                key: key.clone(),
                unit: None,
                unlimited: row.is_unlimited_entitlement || row.entitlement_requests == -1,
                used: row.used_requests as f64,
                entitlement: row.entitlement_requests as f64,
                remaining_percentage: row.remaining_percentage,
                resets_at: row.reset_date,
                reset_estimated: false,
            };
            (key, quota)
        })
        .collect()
}

fn apply_budgets(
    quotas: &mut BTreeMap<String, Quota>,
    observations: Vec<ProviderQuotaState>,
    errors: &mut Vec<String>,
) {
    // The provider ID is opaque. A session can report several accounts; the
    // host account allowances remain scoped to the current login in that case.
    let mut rows = observations
        .iter()
        .filter(|row| {
            row.provider.kind == ModelProviderKind::Copilot
                && row.observation_kind == Some(ProviderQuotaObservationKind::AccountSnapshot)
        })
        .peekable();
    let Some(first) = rows.peek().copied() else {
        return;
    };
    let provider = &first.provider.id;
    if rows.clone().any(|row| &row.provider.id != provider) {
        errors.push("Copilot returned quota details for multiple accounts.".into());
        return;
    }

    for row in rows {
        if matches!(
            row.acquisition_status,
            Some(
                ProviderQuotaAcquisitionStatus::Failed
                    | ProviderQuotaAcquisitionStatus::Unavailable
            )
        ) {
            let key = row.compatibility_key.as_deref().unwrap_or(&row.quota_id);
            errors.push(format!("Copilot could not refresh the {key} allowance."));
            continue;
        }
        if row.acquisition_status != Some(ProviderQuotaAcquisitionStatus::Succeeded)
            || row.quantity_kind != Some(ProviderQuotaQuantityKind::AuthoritativeBudget)
        {
            continue;
        }
        let (Some(key), Some(budget)) = (&row.compatibility_key, &row.budget_metadata) else {
            continue;
        };
        let resets_at = budget.reset_at_epoch_ms.and_then(|ms| {
            DateTime::from_timestamp_millis(ms as i64)
                .map(|time| time.to_rfc3339_opts(SecondsFormat::AutoSi, true))
        });
        quotas.insert(
            key.clone(),
            Quota {
                key: key.clone(),
                unit: match row.unit {
                    ProviderQuotaUnit::AiCredits => Some("aiCredits"),
                    ProviderQuotaUnit::Requests => Some("requests"),
                    ProviderQuotaUnit::Tokens => Some("tokens"),
                    _ => None,
                },
                unlimited: budget.unlimited || budget.entitlement == -1.0,
                used: budget.consumed,
                entitlement: budget.entitlement,
                remaining_percentage: budget.remaining_percentage,
                resets_at,
                reset_estimated: budget.reset_estimated.unwrap_or(false),
            },
        );
    }
}

fn plan(tier: SessionQuotaPlanTier) -> Option<&'static str> {
    Some(match tier {
        SessionQuotaPlanTier::Free => "Copilot Free",
        SessionQuotaPlanTier::Edu => "Copilot Student",
        SessionQuotaPlanTier::Pro => "Copilot Pro",
        SessionQuotaPlanTier::ProPlus => "Copilot Pro+",
        SessionQuotaPlanTier::Business => "Copilot Business",
        SessionQuotaPlanTier::Enterprise => "Copilot Enterprise",
        SessionQuotaPlanTier::Access => "Copilot Access",
        SessionQuotaPlanTier::Max => "Copilot Max",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use copilot_sdk::{
        rpc::AccountQuotaSnapshot,
        session_events::{ModelProviderRef, ProviderQuotaBudgetMetadata},
    };

    fn premium_budget() -> ProviderQuotaState {
        ProviderQuotaState {
            provider: ModelProviderRef {
                id: "github-primary".into(),
                kind: ModelProviderKind::Copilot,
                ..Default::default()
            },
            quota_id: "monthly".into(),
            compatibility_key: Some("premium_interactions".into()),
            acquisition_status: Some(ProviderQuotaAcquisitionStatus::Succeeded),
            observation_kind: Some(ProviderQuotaObservationKind::AccountSnapshot),
            quantity_kind: Some(ProviderQuotaQuantityKind::AuthoritativeBudget),
            unit: ProviderQuotaUnit::AiCredits,
            budget_metadata: Some(ProviderQuotaBudgetMetadata {
                consumed: 0.125,
                entitlement: 12.5,
                remaining_percentage: 99.0,
                reset_at_epoch_ms: Some(1_798_761_600_000.0),
                reset_estimated: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        }
    }

    #[test]
    fn displays_github_plan_names_and_leaves_unknown_tiers_unavailable() {
        use SessionQuotaPlanTier::*;
        for (tier, name) in [
            (Free, "Copilot Free"),
            (Edu, "Copilot Student"),
            (Pro, "Copilot Pro"),
            (ProPlus, "Copilot Pro+"),
            (Business, "Copilot Business"),
            (Enterprise, "Copilot Enterprise"),
            (Access, "Copilot Access"),
            (Max, "Copilot Max"),
        ] {
            assert_eq!(plan(tier), Some(name));
        }
        assert_eq!(plan(UnknownValue), None);
        assert_eq!(plan(Unknown), None);
    }

    #[test]
    fn preserves_the_provider_unit_and_does_not_invent_a_reset_window() {
        for (unit, name) in [
            (ProviderQuotaUnit::Requests, Some("requests")),
            (ProviderQuotaUnit::Tokens, Some("tokens")),
            (ProviderQuotaUnit::Unknown, None),
        ] {
            let mut row = premium_budget();
            row.unit = unit;
            row.budget_metadata.as_mut().unwrap().reset_at_epoch_ms = None;
            let mut quotas = BTreeMap::new();
            apply_budgets(&mut quotas, vec![row], &mut Vec::new());
            assert_eq!(quotas["premium_interactions"].unit, name);
            assert!(quotas["premium_interactions"].resets_at.is_none());
        }
    }

    #[test]
    fn account_allowances_preserve_unlimited_and_reported_zero() {
        let mut account = AccountGetQuotaResult::default();
        account.quota_snapshots.insert(
            "chat".into(),
            AccountQuotaSnapshot {
                is_unlimited_entitlement: true,
                ..Default::default()
            },
        );
        account.quota_snapshots.insert(
            "completions".into(),
            AccountQuotaSnapshot {
                entitlement_requests: -1,
                ..Default::default()
            },
        );
        account.quota_snapshots.insert(
            "premium_interactions".into(),
            AccountQuotaSnapshot {
                entitlement_requests: 100,
                used_requests: 100,
                remaining_percentage: 0.0,
                reset_date: Some("2027-01-01".into()),
                ..Default::default()
            },
        );
        let quotas = account_quotas(account);
        assert!(quotas["chat"].unlimited);
        assert!(quotas["completions"].unlimited);
        let finite = &quotas["premium_interactions"];
        assert!(!finite.unlimited);
        assert_eq!(
            (finite.used, finite.entitlement, finite.remaining_percentage),
            (100.0, 100.0, 0.0)
        );
        assert_eq!(finite.unit, None);
        assert_eq!(finite.resets_at.as_deref(), Some("2027-01-01"));
    }

    #[test]
    fn authoritative_budget_replaces_the_compatibility_allowance_once() {
        let mut account = AccountGetQuotaResult::default();
        account.quota_snapshots.insert(
            "premium_interactions".into(),
            AccountQuotaSnapshot::default(),
        );
        let mut quotas = account_quotas(account);
        let mut errors = vec![];
        apply_budgets(&mut quotas, vec![premium_budget()], &mut errors);
        assert!(errors.is_empty());
        assert_eq!(quotas.len(), 1);
        let quota = &quotas["premium_interactions"];
        assert_eq!(quota.unit, Some("aiCredits"));
        assert_eq!(
            (quota.used, quota.entitlement, quota.remaining_percentage),
            (0.125, 12.5, 99.0)
        );
        assert_eq!(quota.resets_at.as_deref(), Some("2027-01-01T00:00:00Z"));
        assert!(quota.reset_estimated);
    }

    #[test]
    fn ambiguous_accounts_and_non_budget_readings_never_supply_a_percentage() {
        let mut quotas = BTreeMap::new();
        let mut errors = vec![];
        let mut second = premium_budget();
        second.provider.id = "second-account".into();
        apply_budgets(&mut quotas, vec![premium_budget(), second], &mut errors);
        assert!(quotas.is_empty());
        assert_eq!(
            errors,
            ["Copilot returned quota details for multiple accounts."]
        );

        let mut unrelated = premium_budget();
        unrelated.provider.kind = ModelProviderKind::Loki;
        let advisory = ProviderQuotaState {
            quantity_kind: Some(ProviderQuotaQuantityKind::AdvisoryBalance),
            ..premium_budget()
        };
        let admission = ProviderQuotaState {
            observation_kind: Some(ProviderQuotaObservationKind::AdmissionState),
            ..premium_budget()
        };
        let missing = ProviderQuotaState {
            budget_metadata: None,
            ..premium_budget()
        };
        let failed = ProviderQuotaState {
            acquisition_status: Some(ProviderQuotaAcquisitionStatus::Failed),
            ..premium_budget()
        };
        errors.clear();
        apply_budgets(
            &mut quotas,
            vec![unrelated, advisory, admission, missing, failed],
            &mut errors,
        );
        assert!(quotas.is_empty());
        assert_eq!(
            errors,
            ["Copilot could not refresh the premium_interactions allowance."]
        );
    }
}
