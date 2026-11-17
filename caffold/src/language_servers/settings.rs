//! Which languages and repositories the person turned language servers on
//! for, kept in the data directory's `language-servers/settings.json`.

use std::{collections::BTreeSet, fs, io, path::PathBuf};

use serde::{Deserialize, Serialize};

use super::Language;

const SETTINGS_FILE_NAME: &str = "settings.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Settings {
    #[serde(default)]
    pub(super) languages: BTreeSet<Language>,
    /// Logical paths of the folders language servers run for: a repository's
    /// root, or a folder outside Git.
    #[serde(default)]
    pub(super) repositories: BTreeSet<String>,
}

pub(super) struct SettingsFile {
    directory: PathBuf,
}

impl SettingsFile {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    /// The saved settings; nothing is turned on when the file does not exist.
    pub(super) fn read(&self) -> Result<Settings, String> {
        match fs::read(self.path()) {
            Ok(body) => serde_json::from_slice(&body).map_err(|error| error.to_string()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Settings::default()),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(super) fn write(&self, settings: &Settings) -> io::Result<()> {
        fs::create_dir_all(&self.directory)?;
        let body = serde_json::to_vec_pretty(settings).map_err(io::Error::other)?;
        let path = self.path();
        let replacement = path.with_extension("json.tmp");
        fs::write(&replacement, body)?;
        fs::rename(&replacement, path)
    }

    fn path(&self) -> PathBuf {
        self.directory.join(SETTINGS_FILE_NAME)
    }
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn nothing_is_on_until_settings_are_saved() {
        let directory = TempDir::new().unwrap();
        let file = SettingsFile::new(directory.path().join("language-servers"));

        assert_eq!(file.read().unwrap(), Settings::default());
    }

    #[test]
    fn saved_settings_read_back_the_same() {
        let directory = TempDir::new().unwrap();
        let file = SettingsFile::new(directory.path().join("language-servers"));
        let settings = Settings {
            languages: BTreeSet::from([Language::Rust, Language::TypeScript]),
            repositories: BTreeSet::from(["Users/me/work/caffold".to_string()]),
        };

        file.write(&settings).unwrap();

        assert_eq!(file.read().unwrap(), settings);
        assert!(!file.directory.join("settings.json.tmp").exists());
    }

    #[test]
    fn an_unreadable_file_is_an_error_not_an_empty_selection() {
        let directory = TempDir::new().unwrap();
        let file = SettingsFile::new(directory.path().to_path_buf());
        fs::write(directory.path().join("settings.json"), "{ not json").unwrap();

        assert!(file.read().is_err());
    }
}
