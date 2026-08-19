use std::{
    fs,
    path::{Path, PathBuf},
    sync::RwLock,
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const DEFAULT_SERVER_NAME: &str = "Caffold";
const MAX_SERVER_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServerSettings {
    pub name: String,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            name: DEFAULT_SERVER_NAME.to_string(),
        }
    }
}

pub struct ServerSettingsStore {
    settings: RwLock<ServerSettings>,
    path: Option<PathBuf>,
}

impl ServerSettingsStore {
    pub fn memory() -> Self {
        Self {
            settings: RwLock::new(ServerSettings::default()),
            path: None,
        }
    }

    pub fn persistent(path: PathBuf) -> Result<Self, ServerSettingsError> {
        let settings = load_settings(&path)?;
        Ok(Self {
            settings: RwLock::new(settings),
            path: Some(path),
        })
    }

    pub fn get(&self) -> ServerSettings {
        self.settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn update_name(&self, name: &str) -> Result<ServerSettings, ServerSettingsError> {
        let name = validate_name(name)?;
        let settings = ServerSettings { name };
        if let Some(path) = &self.path {
            persist_settings(path, &settings)?;
        }
        *self
            .settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = settings.clone();
        Ok(settings)
    }
}

#[derive(Debug, Error)]
pub enum ServerSettingsError {
    #[error("server name cannot be empty")]
    EmptyName,
    #[error("server name cannot exceed {MAX_SERVER_NAME_CHARS} characters")]
    NameTooLong,
    #[error("failed to read server settings: {0}")]
    Read(#[source] std::io::Error),
    #[error("failed to parse server settings: {0}")]
    Parse(#[source] serde_json::Error),
    #[error("failed to write server settings: {0}")]
    Write(#[source] std::io::Error),
    #[error("failed to encode server settings: {0}")]
    Encode(#[source] serde_json::Error),
}

fn validate_name(name: &str) -> Result<String, ServerSettingsError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ServerSettingsError::EmptyName);
    }
    if name.chars().count() > MAX_SERVER_NAME_CHARS {
        return Err(ServerSettingsError::NameTooLong);
    }
    Ok(name.to_string())
}

fn load_settings(path: &Path) -> Result<ServerSettings, ServerSettingsError> {
    if !path.exists() {
        return Ok(ServerSettings::default());
    }
    let body = fs::read(path).map_err(ServerSettingsError::Read)?;
    serde_json::from_slice(&body).map_err(ServerSettingsError::Parse)
}

fn persist_settings(path: &Path, settings: &ServerSettings) -> Result<(), ServerSettingsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(ServerSettingsError::Write)?;
    }
    let body = serde_json::to_vec_pretty(settings).map_err(ServerSettingsError::Encode)?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, body).map_err(ServerSettingsError::Write)?;
    fs::rename(&temporary_path, path).map_err(ServerSettingsError::Write)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_trims_and_updates_the_name() {
        let store = ServerSettingsStore::memory();

        assert_eq!(store.get().name, "Caffold");
        assert_eq!(
            store.update_name("  Caffold Studio  ").unwrap().name,
            "Caffold Studio"
        );
        assert_eq!(store.get().name, "Caffold Studio");
    }

    #[test]
    fn rejects_empty_and_oversized_names() {
        let store = ServerSettingsStore::memory();

        assert!(matches!(
            store.update_name("   "),
            Err(ServerSettingsError::EmptyName)
        ));
        assert!(matches!(
            store.update_name(&"a".repeat(MAX_SERVER_NAME_CHARS + 1)),
            Err(ServerSettingsError::NameTooLong)
        ));
    }

    #[test]
    fn persistent_store_restores_the_saved_name() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("server.json");
        let store = ServerSettingsStore::persistent(path.clone()).unwrap();
        store.update_name("Caffold MacBook").unwrap();

        let restored = ServerSettingsStore::persistent(path).unwrap();
        assert_eq!(restored.get().name, "Caffold MacBook");
    }
}
