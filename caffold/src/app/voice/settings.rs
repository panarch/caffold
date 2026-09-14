use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{PoisonError, RwLock},
};

use serde::{Deserialize, Serialize};

use super::VoiceProvider;

const SETTINGS_FILE_NAME: &str = "settings.json";

/// Which speech-to-text provider transcribes voice input on this host.
pub(super) struct VoiceSettingsStore {
    directory: PathBuf,
    provider: RwLock<Result<VoiceProvider, String>>,
}

impl VoiceSettingsStore {
    pub(super) fn open(directory: PathBuf) -> Self {
        let provider = read_provider(&directory.join(SETTINGS_FILE_NAME));
        Self {
            directory,
            provider: RwLock::new(provider),
        }
    }

    pub(super) fn provider(&self) -> Result<VoiceProvider, String> {
        self.provider
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    pub(super) fn select(&self, provider: VoiceProvider) -> io::Result<()> {
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
    provider: VoiceProvider,
}

fn read_provider(path: &Path) -> Result<VoiceProvider, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice::<StoredSettings>(&body)
            .map(|settings| settings.provider)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(VoiceProvider::Whisper),
        Err(error) => Err(error.to_string()),
    }
}

fn write_provider(directory: &Path, provider: VoiceProvider) -> io::Result<()> {
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
    fn whisper_stays_selected_until_another_provider_is_chosen() {
        let temp = TempDir::new().unwrap();
        let store = VoiceSettingsStore::open(temp.path().join("voice"));

        assert_eq!(store.provider(), Ok(VoiceProvider::Whisper));
        assert!(!temp.path().join("voice").exists());

        store.select(VoiceProvider::Gemini).unwrap();

        assert_eq!(
            VoiceSettingsStore::open(temp.path().join("voice")).provider(),
            Ok(VoiceProvider::Gemini)
        );
        assert!(!temp.path().join("voice/settings.json.tmp").exists());
    }

    #[test]
    fn unreadable_settings_stay_an_error_until_a_provider_is_selected() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("voice");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("settings.json"),
            r#"{"provider":"parakeet"}"#,
        )
        .unwrap();
        let store = VoiceSettingsStore::open(directory);

        assert!(store.provider().is_err());

        store.select(VoiceProvider::Openai).unwrap();

        assert_eq!(store.provider(), Ok(VoiceProvider::Openai));
    }
}
