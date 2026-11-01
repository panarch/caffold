//! Native model/configuration choices. Passive menus only read the last explicit
//! catalog refresh; they never start OAuth or create a native session.
use super::{
    AntigravityClient, AntigravityError, ModelOption, PermissionModes, Session, TurnOptions,
    installation, protocol, usage::UsageStatus,
};
use crate::agent::driver::{PermissionModeOption, REVIEWED_PERMISSION_MODE, TurnRejected, bounded};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{ErrorKind, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::Path,
};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Catalog {
    version: u32,
    models: Vec<CatalogModel>,
    modes: protocol::ConfigOption,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogModel {
    id: String,
    name: String,
    is_default: bool,
    thinking: protocol::ConfigOption,
}

impl AntigravityClient {
    pub(crate) async fn models(&self) -> Result<Vec<ModelOption>, AntigravityError> {
        let catalog = self.inner.catalog.lock().await;
        let catalog = catalog.as_ref().ok_or_else(|| {
            AntigravityError::Unreachable("Refresh Antigravity Settings after signing in".into())
        })?;
        Ok(catalog
            .models
            .iter()
            .map(|model| ModelOption {
                model: model.id.clone(),
                display_name: model.name.clone(),
                description: None,
                is_default: model.is_default,
                default_effort: Some(model.thinking.current_value.clone()),
                efforts: model
                    .thinking
                    .options
                    .iter()
                    .map(|choice| choice.value.clone())
                    .collect(),
                supports_fast_mode: false,
                supports_auto_mode: false,
            })
            .collect())
    }
    pub(crate) async fn permission_modes(&self) -> Result<PermissionModes, AntigravityError> {
        let catalog = self.inner.catalog.lock().await;
        let catalog = catalog.as_ref().ok_or_else(|| {
            AntigravityError::Unreachable("Refresh Antigravity Settings after signing in".into())
        })?;
        Ok(PermissionModes {
            default_mode: catalog.modes.current_value.clone(),
            fixed_when_conversation_starts: false,
            options: catalog
                .modes
                .options
                .iter()
                .map(|choice| PermissionModeOption {
                    mode: choice.value.clone(),
                    label: choice.name.clone(),
                    description: choice.description.clone().unwrap_or_default(),
                    allowed: true,
                    unavailable_reason: None,
                    dangerous: choice.value == "yolo",
                })
                .collect(),
        })
    }
    pub(crate) async fn accept_options(
        &self,
        options: &TurnOptions,
    ) -> Result<TurnOptions, TurnRejected> {
        let models = self
            .models()
            .await
            .map_err(|error| TurnRejected::Unavailable(error.into()))?;
        let model = bounded(options.model.as_deref(), 128).ok_or(TurnRejected::Model)?;
        let chosen = match model.as_deref() {
            Some(id) => Some(
                models
                    .iter()
                    .find(|model| model.model == id)
                    .ok_or(TurnRejected::Model)?,
            ),
            None => None,
        };
        let effort = bounded(options.effort.as_deref(), 64).ok_or(TurnRejected::Effort)?;
        if effort.as_ref().is_some_and(|effort| match chosen {
            Some(model) => !model.efforts.contains(effort),
            None => !models.iter().any(|model| model.efforts.contains(effort)),
        }) {
            return Err(TurnRejected::Effort);
        }
        let permissions = self
            .permission_modes()
            .await
            .map_err(|error| TurnRejected::Unavailable(error.into()))?;
        let mode = options.permission_mode.clone();
        if mode.as_ref().is_some_and(|mode| {
            mode != REVIEWED_PERMISSION_MODE
                && !permissions
                    .options
                    .iter()
                    .any(|choice| choice.mode == *mode)
        }) {
            return Err(TurnRejected::Unavailable(
                AntigravityError::Protocol("unsupported Antigravity permission mode".into()).into(),
            ));
        }
        Ok(TurnOptions {
            model,
            effort,
            fast_mode: false,
            permission_mode: mode,
        })
    }

    pub(super) async fn apply_options(
        &self,
        session: &Session,
        options: &TurnOptions,
    ) -> Result<TurnOptions, AntigravityError> {
        if let Some(model) = &options.model {
            session.configure(protocol::MODEL, model).await?;
        }
        if let Some(effort) = &options.effort {
            session.configure(protocol::THINKING, effort).await?;
        }
        if let Some(mode) = &options.permission_mode {
            let reviewed = mode == REVIEWED_PERMISSION_MODE;
            session
                .configure(protocol::MODE, if reviewed { "default" } else { mode })
                .await?;
            session.set_reviewed(reviewed).await;
        }
        settings(&session.options().await, session.reviewed().await)
    }
    pub(crate) async fn settings_of(
        &self,
        task: &str,
    ) -> Result<BTreeMap<String, Value>, AntigravityError> {
        let session = self.current(task).await?;
        let options = settings(&session.options().await, session.reviewed().await)?;
        Ok(BTreeMap::from([
            ("model".into(), serde_json::json!(options.model)),
            ("reasoningEffort".into(), serde_json::json!(options.effort)),
            (
                "permissionMode".into(),
                serde_json::json!(options.permission_mode),
            ),
        ]))
    }

    pub(crate) async fn refresh_settings(&self, cwd: &str) -> Result<(), AntigravityError> {
        let _runtime = self.runtime_access()?;
        let _job = self.inner.refresh_job.try_lock().map_err(|_| {
            AntigravityError::Protocol("a Settings refresh is already running".into())
        })?;
        self.inner.authentication.allow_refresh().await?;
        match installation::executable(&self.inner.data) {
            Ok(_) => {}
            Err(AntigravityError::NotInstalled) => return Ok(()),
            Err(error) => return Err(error),
        }
        let task = Uuid::new_v4().to_string();
        let (mut catalog, mut usage) = match self.open_for(&task, Some(cwd), false, false).await {
            Ok(session) => {
                let usage = session
                    .usage()
                    .await
                    .and_then(|report| UsageStatus::from_report(&report));
                let catalog = Catalog::inspect(&session).await;
                (catalog, usage)
            }
            Err(error) => (Err(error.clone()), Err(error)),
        };
        // A single explicit probe owns both reads. Cleanup failure cannot be
        // reported as a completed refresh; retain its exact binding for retry.
        if let Err(error) = self.erase(&task).await {
            catalog = Err(error.clone());
            usage = Err(error);
        }
        *self.inner.usage.lock().await = UsageStatus::from_result(usage);
        let result = async {
            let catalog = catalog?;
            let directory = self.inner.data.clone();
            let saved = catalog.clone();
            tokio::task::spawn_blocking(move || saved.write(&directory))
                .await
                .map_err(|e| AntigravityError::Record(e.to_string()))??;
            *self.inner.catalog.lock().await = Some(catalog);
            Ok::<_, AntigravityError>(())
        }
        .await;
        *self.inner.catalog_error.lock().await = result.err().map(|error| error.to_string());
        Ok(())
    }
}

fn settings(
    options: &[protocol::ConfigOption],
    reviewed: bool,
) -> Result<TurnOptions, AntigravityError> {
    Ok(TurnOptions {
        model: Some(
            protocol::config(options, protocol::MODEL)?
                .current_value
                .clone(),
        ),
        effort: Some(
            protocol::config(options, protocol::THINKING)?
                .current_value
                .clone(),
        ),
        fast_mode: false,
        permission_mode: Some(if reviewed {
            REVIEWED_PERMISSION_MODE.into()
        } else {
            protocol::config(options, protocol::MODE)?
                .current_value
                .clone()
        }),
    })
}
impl Catalog {
    async fn inspect(session: &Session) -> Result<Self, AntigravityError> {
        let options = session.options().await;
        let model = protocol::config(&options, protocol::MODEL)?.clone();
        let modes = protocol::config(&options, protocol::MODE)?.clone();
        let mut models = Vec::new();
        for choice in &model.options {
            session.configure(protocol::MODEL, &choice.value).await?;
            let options = session.options().await;
            models.push(CatalogModel {
                id: choice.value.clone(),
                name: choice.name.clone(),
                is_default: choice.value == model.current_value,
                thinking: protocol::config(&options, protocol::THINKING)?.clone(),
            });
        }
        let catalog = Self {
            version: 1,
            models,
            modes,
        };
        catalog.validate()?;
        Ok(catalog)
    }
    pub(super) fn read(directory: &Path) -> Result<Option<Self>, AntigravityError> {
        check_directory(directory)?;
        let mut file = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(directory.join("catalog.json"))
        {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(AntigravityError::Record(error.to_string())),
        };
        if !file
            .metadata()
            .map_err(|error| AntigravityError::Record(error.to_string()))?
            .is_file()
        {
            return Err(AntigravityError::Record(
                "model catalog is not a regular file".into(),
            ));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(|error| AntigravityError::Record(error.to_string()))?;
        if bytes.len() > 65536 {
            return Err(AntigravityError::Record(
                "model catalog exceeds its limit".into(),
            ));
        }
        let catalog: Self = serde_json::from_slice(&bytes)
            .map_err(|e| AntigravityError::Protocol(e.to_string()))?;
        catalog.validate()?;
        Ok(Some(catalog))
    }
    fn validate(&self) -> Result<(), AntigravityError> {
        if self.version != 1
            || self.models.is_empty()
            || self.models.iter().filter(|model| model.is_default).count() != 1
            || self.models.iter().any(|model| {
                model.id.is_empty()
                    || !model
                        .thinking
                        .options
                        .iter()
                        .any(|choice| choice.value == model.thinking.current_value)
            })
            || !self
                .modes
                .options
                .iter()
                .any(|choice| choice.value == self.modes.current_value)
        {
            return Err(AntigravityError::Protocol("invalid native catalog".into()));
        }
        Ok(())
    }
    fn write(&self, directory: &Path) -> Result<(), AntigravityError> {
        check_directory(directory)?;
        fs::create_dir_all(directory).map_err(|e| AntigravityError::Record(e.to_string()))?;
        let temporary = directory.join(format!(".catalog-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(|e| AntigravityError::Record(e.to_string()))?;
            file.write_all(
                &serde_json::to_vec(self).map_err(|e| AntigravityError::Record(e.to_string()))?,
            )
            .map_err(|e| AntigravityError::Record(e.to_string()))?;
            fs::rename(&temporary, directory.join("catalog.json"))
                .map_err(|e| AntigravityError::Record(e.to_string()))
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
}

fn check_directory(directory: &Path) -> Result<(), AntigravityError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
        Ok(_) => Err(AntigravityError::Record(
            "catalog directory is not a regular directory".into(),
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AntigravityError::Record(error.to_string())),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    fn catalog() -> Catalog {
        serde_json::from_value(serde_json::json!({"version":1,"models":[{"id":"native-model","name":"Native model","isDefault":true,"thinking":{"id":"thinking_level","currentValue":"low","options":[{"value":"low","name":"Low"},{"value":"high","name":"High"}]}}],"modes":{"id":"mode","currentValue":"default","options":[{"value":"default","name":"Default"},{"value":"yolo","name":"Yolo"}]}})).unwrap()
    }
    #[tokio::test]
    async fn one_refresh_owner_excludes_auth_actions_and_releases_after_inspection() {
        let client = AntigravityClient::uninstalled();
        let job = client.inner.refresh_job.lock().await;
        assert!(client.refresh_settings(".").await.is_err());
        assert!(client.sign_in().await.is_err());
        assert!(client.sign_out().await.is_err());
        assert!(client.introspect().await.refreshing);
        drop(job);
        client.refresh_settings(".").await.unwrap();
        assert!(!client.introspect().await.refreshing);
    }

    #[tokio::test]
    async fn cached_native_choices_validate_explicit_options_without_overwriting_unspecified_task_choices()
     {
        let client = AntigravityClient::uninstalled();
        *client.inner.catalog.lock().await = Some(catalog());
        let options = client
            .accept_options(&TurnOptions {
                model: None,
                effort: None,
                fast_mode: false,
                permission_mode: None,
            })
            .await
            .unwrap();
        assert!(
            options.model.is_none()
                && options.effort.is_none()
                && options.permission_mode.is_none()
        );
        assert!(
            client
                .accept_options(&TurnOptions {
                    model: Some("invented".into()),
                    ..options.clone()
                })
                .await
                .is_err()
        );
        assert!(
            client
                .accept_options(&TurnOptions {
                    effort: Some("ultra".into()),
                    ..options.clone()
                })
                .await
                .is_err()
        );
        // Like Grok, the native agent has no faster tier; the applied
        // settings explicitly report ordinary speed.
        assert!(
            !client
                .accept_options(&TurnOptions {
                    fast_mode: true,
                    ..options.clone()
                })
                .await
                .unwrap()
                .fast_mode
        );
        assert!(
            client
                .accept_options(&TurnOptions {
                    permission_mode: Some("invented".into()),
                    ..options
                })
                .await
                .is_err()
        );
        assert_eq!(client.models().await.unwrap()[0].efforts, ["low", "high"]);
        assert!(
            client
                .permission_modes()
                .await
                .unwrap()
                .options
                .iter()
                .any(|mode| mode.mode == "yolo" && mode.dangerous)
        );
    }
    #[test]
    fn catalog_roundtrip_rejects_malformed_and_linked_sources() {
        let root = tempfile::tempdir().unwrap();
        assert!(Catalog::read(root.path()).unwrap().is_none());
        catalog().write(root.path()).unwrap();
        assert_eq!(
            Catalog::read(root.path()).unwrap().unwrap().models[0].id,
            "native-model"
        );
        let path = root.path().join("catalog.json");
        fs::write(&path, b"malformed").unwrap();
        assert!(Catalog::read(root.path()).is_err());
        fs::remove_file(&path).unwrap();
        symlink("/etc/hosts", &path).unwrap();
        assert!(Catalog::read(root.path()).is_err());
    }
}
