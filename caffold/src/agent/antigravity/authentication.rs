//! Observations from native sessions. Credentials and login belong to the CLI.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct AuthStatus {
    verified: Option<Verified>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verified {
    authenticated: bool,
    tier: Option<Tier>,
    verified_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Tier {
    id: String,
    name: String,
}

#[derive(Clone, Default)]
pub(super) struct Authentication {
    state: Arc<Mutex<AuthStatus>>,
}

impl Verified {
    pub(super) fn from_result(authenticated: bool, result: &Value) -> Self {
        Self {
            authenticated,
            tier: authenticated
                .then(|| result.pointer("/_meta/antigravity/tier"))
                .flatten()
                .cloned()
                .and_then(|tier| serde_json::from_value(tier).ok()),
            verified_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        }
    }
}

impl Authentication {
    pub(super) async fn status(&self) -> AuthStatus {
        self.state.lock().await.clone()
    }

    pub(super) async fn observe(&self, verified: Verified) {
        let mut state = self.state.lock().await;
        if state
            .verified
            .as_ref()
            .is_none_or(|old| old.verified_at_ms <= verified.verified_at_ms)
        {
            state.verified = Some(verified);
        }
    }

    pub(super) async fn require_sign_in(&self) {
        self.observe(Verified::from_result(false, &Value::Null))
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn native_account_observation_does_not_start_or_control_authentication() {
        let owner = Authentication::default();
        assert!(owner.status().await.verified.is_none());
        owner
            .observe(Verified::from_result(
                true,
                &json!({"_meta":{"antigravity":{"tier":{"id":"pro","name":"Pro"}}}}),
            ))
            .await;
        let state = owner.status().await.verified.unwrap();
        assert!(state.authenticated);
        assert_eq!(state.tier.unwrap().id, "pro");
        owner.require_sign_in().await;
        assert!(!owner.status().await.verified.unwrap().authenticated);
        owner
            .observe(Verified {
                authenticated: true,
                tier: None,
                verified_at_ms: 0,
            })
            .await;
        assert!(!owner.status().await.verified.unwrap().authenticated);
    }
}
