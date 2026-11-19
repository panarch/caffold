//! Query the CLI under its signed-in account and the policy applying to this directory.

use super::{
    CopilotClient, CopilotStatus, installation, permission::PendingPermissions, sdk_error,
};
use crate::agent::{
    AgentError, NORMAL_SPEED, PermissionModes, TurnOptions, TurnRejected,
    driver::{
        AgentInstallation, ModelOption, PermissionModeOption, REVIEWED_PERMISSION_MODE, bounded,
    },
};
use copilot_sdk::CreateSessionOptions;
use std::sync::Arc;

impl CopilotClient {
    pub(crate) async fn installation(&self) -> AgentInstallation {
        if self.inner.enabled {
            installation::installation().await
        } else {
            AgentInstallation::NotInstalled
        }
    }

    pub(crate) async fn status(&self) -> CopilotStatus {
        installation::status_for(self.program().ok()).await
    }

    pub(crate) async fn models(&self) -> Result<Vec<ModelOption>, AgentError> {
        let mut catalog = self.inner.catalog.lock().await;
        if let Some((fetched, models)) = &*catalog
            && fetched.elapsed() < std::time::Duration::from_secs(60)
        {
            return Ok(models.clone());
        }

        let reader = self.reader().await?;
        let auth = reader.get_auth_status().await.map_err(sdk_error)?;
        if !auth.is_authenticated {
            return Err(AgentError::Held(
                "Sign in to GitHub with copilot login.".into(),
            ));
        }

        let models: Vec<_> = reader
            .list_models()
            .await
            .map_err(sdk_error)?
            .into_iter()
            .filter_map(installation::model_option)
            .collect();
        *catalog = Some((std::time::Instant::now(), models.clone()));
        Ok(models)
    }

    pub(crate) async fn accept_options(
        &self,
        options: &TurnOptions,
    ) -> Result<TurnOptions, TurnRejected> {
        let models = self.models().await.map_err(TurnRejected::Unavailable)?;
        let model = bounded(options.model.as_deref(), 128).ok_or(TurnRejected::Model)?;
        let chosen = match &model {
            Some(id) => Some(
                models
                    .iter()
                    .find(|model| &model.model == id)
                    .ok_or(TurnRejected::Model)?,
            ),
            None => None,
        };

        let effort = bounded(options.effort.as_deref(), 64).ok_or(TurnRejected::Effort)?;
        if let Some(effort) = &effort
            && !chosen.map_or_else(
                || models.iter().any(|model| model.efforts.contains(effort)),
                |model| model.efforts.contains(effort),
            )
        {
            return Err(TurnRejected::Effort);
        }

        let mode = options.permission_mode.as_deref().unwrap_or("manual");
        if !matches!(
            mode,
            "manual" | "assisted" | "allow-all" | REVIEWED_PERMISSION_MODE
        ) {
            return Err(TurnRejected::Unavailable(AgentError::Held(
                "Unknown Copilot permission mode.".into(),
            )));
        }

        Ok(TurnOptions {
            model,
            effort,
            speed: NORMAL_SPEED.into(),
            permission_mode: Some(mode.into()),
        })
    }

    pub(crate) async fn permission_modes(&self, cwd: &str) -> Result<PermissionModes, AgentError> {
        let reader = self.reader().await?;
        let id = uuid::Uuid::new_v4().to_string();
        let options = CreateSessionOptions::default()
            .with_session_id(id.clone())
            .with_working_directory(cwd)
            .with_github(|github| github.with_fetch_managed_settings(true))
            .with_permissions(|permissions| {
                permissions.with_on_request(Arc::new(PendingPermissions))
            });
        let session = reader.create_session(options).await.map_err(sdk_error)?;
        if session.id().as_str() != id {
            return Err(AgentError::Failed(
                "Copilot returned an unexpected settings session.".into(),
            ));
        }

        let caps = session.rpc().permissions().get_capabilities().await;
        session.disconnect().await.map_err(sdk_error)?;
        reader
            .delete_session(session.id())
            .await
            .map_err(sdk_error)?;

        let caps = caps.map_err(sdk_error)?;
        let options = [
            (
                "manual",
                "Manual",
                "Ask when Copilot needs permission.",
                true,
                false,
            ),
            (
                "assisted",
                "Assisted",
                "Let Copilot assess tool requests.",
                caps.assisted_approval,
                false,
            ),
            (
                "allow-all",
                "Allow all",
                "Allow all tool requests.",
                caps.bypass_permissions,
                true,
            ),
        ]
        .into_iter()
        .map(
            |(id, label, description, allowed, dangerous)| PermissionModeOption {
                mode: id.into(),
                label: label.into(),
                description: description.into(),
                allowed,
                dangerous,
                unavailable_reason: (!allowed).then(|| "Disabled by Copilot policy.".into()),
            },
        )
        .collect();
        Ok(PermissionModes {
            default_mode: "manual".into(),
            options,
            fixed_when_conversation_starts: false,
        })
    }
}
