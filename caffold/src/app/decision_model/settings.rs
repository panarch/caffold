use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{PoisonError, RwLock},
};

use serde::{Deserialize, Serialize};

use super::DecisionModelProvider;

const SETTINGS_FILE_NAME: &str = "settings.json";

/// Which decision model answers permission requests on this host.
pub(super) struct DecisionModelSettingsStore {
    directory: PathBuf,
    provider: RwLock<Result<DecisionModelProvider, String>>,
}

impl DecisionModelSettingsStore {
    pub(super) fn open(directory: PathBuf) -> Self {
        let provider = read_provider(&directory.join(SETTINGS_FILE_NAME));
        Self {
            directory,
            provider: RwLock::new(provider),
        }
    }

    pub(super) fn provider(&self) -> Result<DecisionModelProvider, String> {
        self.provider
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(super) fn select(&self, provider: DecisionModelProvider) -> io::Result<()> {
        let mut current = self
            .provider
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        write_provider(&self.directory, provider)?;
        *current = Ok(provider);
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
struct StoredSettings {
    provider: DecisionModelProvider,
}

fn read_provider(path: &Path) -> Result<DecisionModelProvider, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice::<StoredSettings>(&body)
            .map(|settings| settings.provider)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(DecisionModelProvider::Jev),
        Err(error) => Err(error.to_string()),
    }
}

fn write_provider(directory: &Path, provider: DecisionModelProvider) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let body = serde_json::to_vec_pretty(&StoredSettings { provider }).map_err(io::Error::other)?;
    let path = directory.join(SETTINGS_FILE_NAME);
    let replacement = path.with_extension("json.tmp");
    fs::write(&replacement, body)?;
    fs::rename(&replacement, path)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn jev_stays_chosen_until_another_provider_is() {
        let temp = TempDir::new().unwrap();
        let store = DecisionModelSettingsStore::open(temp.path().join("decision-model"));

        assert_eq!(store.provider(), Ok(DecisionModelProvider::Jev));
        assert!(!temp.path().join("decision-model").exists());

        store.select(DecisionModelProvider::Openai).unwrap();

        assert_eq!(
            DecisionModelSettingsStore::open(temp.path().join("decision-model")).provider(),
            Ok(DecisionModelProvider::Openai)
        );
        assert!(
            !temp
                .path()
                .join("decision-model/settings.json.tmp")
                .exists()
        );
    }

    #[test]
    fn unreadable_settings_stay_an_error_until_a_provider_is_chosen() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("decision-model");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("settings.json"), r#"{"provider":"gemini"}"#).unwrap();
        let store = DecisionModelSettingsStore::open(directory);

        assert!(store.provider().is_err());

        store.select(DecisionModelProvider::Jev).unwrap();

        assert_eq!(store.provider(), Ok(DecisionModelProvider::Jev));
    }
}
