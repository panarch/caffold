use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{PoisonError, RwLock},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use super::CloudProvider;

const KEYS_FILE_NAME: &str = "keys.json";
const REPLACEMENT_FILE_NAME: &str = "keys.json.tmp";
const MAX_KEY_BYTES: usize = 512;

/// The API keys the user entered for cloud speech-to-text providers.
///
/// A key leaves this store only as an [`ApiKey`] for the adapter that
/// authenticates with it; everything else learns whether a key is configured.
pub(super) struct ApiKeyStore {
    directory: PathBuf,
    keys: RwLock<Result<StoredKeys, String>>,
}

impl ApiKeyStore {
    pub(super) fn open(directory: PathBuf) -> Self {
        let keys = read_keys(&directory);
        Self {
            directory,
            keys: RwLock::new(keys),
        }
    }

    pub(super) fn is_configured(&self, provider: CloudProvider) -> Result<bool, KeyStoreError> {
        self.read(|keys| keys.slot(provider).is_some())
    }

    pub(super) fn key(&self, provider: CloudProvider) -> Result<Option<ApiKey>, KeyStoreError> {
        self.read(|keys| keys.slot(provider).clone().map(ApiKey))
    }

    pub(super) fn store(&self, provider: CloudProvider, key: &str) -> Result<(), KeyStoreError> {
        let key = validate_key(key)?;
        self.replace(|keys| *keys.slot_mut(provider) = Some(key))
    }

    pub(super) fn remove(&self, provider: CloudProvider) -> Result<(), KeyStoreError> {
        self.replace(|keys| *keys.slot_mut(provider) = None)
    }

    fn read<T>(&self, read: impl FnOnce(&StoredKeys) -> T) -> Result<T, KeyStoreError> {
        match &*self.keys.read().unwrap_or_else(PoisonError::into_inner) {
            Ok(keys) => Ok(read(keys)),
            Err(message) => Err(KeyStoreError::Unreadable(message.clone())),
        }
    }

    /// Persists the change before publishing it. A file that could not be read
    /// is replaced rather than repaired, so the entries it held are lost.
    fn replace(&self, update: impl FnOnce(&mut StoredKeys)) -> Result<(), KeyStoreError> {
        let mut current = self.keys.write().unwrap_or_else(PoisonError::into_inner);
        let mut keys = current.as_ref().cloned().unwrap_or_default();
        update(&mut keys);
        write_keys(&self.directory, &keys)?;
        *current = Ok(keys);
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct ApiKey(String);

impl ApiKey {
    pub(super) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ApiKey([redacted])")
    }
}

#[derive(Debug, Error)]
pub(super) enum KeyStoreError {
    #[error("the stored API keys could not be read: {0}")]
    Unreadable(String),
    #[error("{0}")]
    InvalidKey(&'static str),
    #[error("the API keys could not be saved: {0}")]
    Write(#[from] io::Error),
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct StoredKeys {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    openai: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    gemini: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    grok: Option<String>,
}

impl StoredKeys {
    fn slot(&self, provider: CloudProvider) -> &Option<String> {
        match provider {
            CloudProvider::Openai => &self.openai,
            CloudProvider::Gemini => &self.gemini,
            CloudProvider::Grok => &self.grok,
        }
    }

    fn slot_mut(&mut self, provider: CloudProvider) -> &mut Option<String> {
        match provider {
            CloudProvider::Openai => &mut self.openai,
            CloudProvider::Gemini => &mut self.gemini,
            CloudProvider::Grok => &mut self.grok,
        }
    }
}

fn validate_key(key: &str) -> Result<String, KeyStoreError> {
    let key = key.trim();
    if key.is_empty() {
        return Err(KeyStoreError::InvalidKey("Enter an API key."));
    }
    if key.len() > MAX_KEY_BYTES {
        return Err(KeyStoreError::InvalidKey("The API key is too long."));
    }
    if !key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(KeyStoreError::InvalidKey(
            "An API key can contain only visible ASCII characters.",
        ));
    }
    Ok(key.to_string())
}

fn read_keys(directory: &Path) -> Result<StoredKeys, String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err(format!("{} is not a directory", directory.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(StoredKeys::default()),
        Err(error) => return Err(error.to_string()),
    }
    let path = directory.join(KEYS_FILE_NAME);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err(format!("{} is not a regular file", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(StoredKeys::default()),
        Err(error) => return Err(error.to_string()),
    }
    #[cfg(unix)]
    {
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    let body = fs::read(&path).map_err(|error| error.to_string())?;
    // serde_json's message can quote a string from the file, and that string may be a key.
    serde_json::from_slice(&body).map_err(|error| {
        format!(
            "{} could not be parsed (line {}, column {})",
            path.display(),
            error.line(),
            error.column()
        )
    })
}

fn write_keys(directory: &Path, keys: &StoredKeys) -> io::Result<()> {
    secure_directory(directory)?;
    let path = directory.join(KEYS_FILE_NAME);
    if fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        return Err(io::Error::other(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    let replacement = directory.join(REPLACEMENT_FILE_NAME);
    if let Err(error) = fs::remove_file(&replacement)
        && error.kind() != io::ErrorKind::NotFound
    {
        return Err(error);
    }
    let body = serde_json::to_vec_pretty(keys).map_err(io::Error::other)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&replacement)?;
    let written = file.write_all(&body).and_then(|()| file.sync_all());
    drop(file);
    if let Err(error) = written.and_then(|()| fs::rename(&replacement, &path)) {
        let _ = fs::remove_file(&replacement);
        return Err(error);
    }
    Ok(())
}

fn secure_directory(directory: &Path) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    if !fs::symlink_metadata(directory)?.file_type().is_dir() {
        return Err(io::Error::other(format!(
            "{} is not a directory",
            directory.display()
        )));
    }
    #[cfg(unix)]
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use std::os::unix::fs::symlink;

    use tempfile::TempDir;

    use super::*;

    const SECRET: &str = "sk-test-0123456789abcdef";

    fn store_in(temp: &TempDir) -> ApiKeyStore {
        ApiKeyStore::open(temp.path().join("voice"))
    }

    #[test]
    fn keeps_keys_in_an_owner_only_file_that_survives_reopening() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        assert!(!store.is_configured(CloudProvider::Openai).unwrap());

        store
            .store(CloudProvider::Openai, &format!("  {SECRET}\n"))
            .unwrap();

        let reopened = store_in(&temp);
        assert_eq!(
            reopened
                .key(CloudProvider::Openai)
                .unwrap()
                .unwrap()
                .expose(),
            SECRET
        );
        assert!(!reopened.is_configured(CloudProvider::Gemini).unwrap());
        assert!(!temp.path().join("voice/keys.json.tmp").exists());
        #[cfg(unix)]
        {
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&temp.path().join("voice")), 0o700);
            assert_eq!(mode(&temp.path().join("voice/keys.json")), 0o600);
        }
    }

    #[cfg(unix)]
    #[test]
    fn narrows_an_existing_key_file_to_its_owner() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("voice");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("keys.json"),
            format!(r#"{{"gemini":"{SECRET}"}}"#),
        )
        .unwrap();
        fs::set_permissions(
            directory.join("keys.json"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();

        let store = ApiKeyStore::open(directory.clone());

        assert!(store.is_configured(CloudProvider::Gemini).unwrap());
        assert_eq!(
            fs::metadata(directory.join("keys.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_key_file() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("voice");
        fs::create_dir_all(&directory).unwrap();
        let outside = temp.path().join("outside.json");
        let outside_body = format!(r#"{{"openai":"{SECRET}"}}"#);
        fs::write(&outside, &outside_body).unwrap();
        symlink(&outside, directory.join("keys.json")).unwrap();

        let store = ApiKeyStore::open(directory);

        assert!(matches!(
            store.is_configured(CloudProvider::Openai),
            Err(KeyStoreError::Unreadable(_))
        ));
        assert!(matches!(
            store.store(CloudProvider::Openai, "sk-replacement"),
            Err(KeyStoreError::Write(_))
        ));
        assert_eq!(fs::read_to_string(outside).unwrap(), outside_body);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_key_directory() {
        let temp = TempDir::new().unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let outside_body = format!(r#"{{"openai":"{SECRET}"}}"#);
        fs::write(outside.join("keys.json"), &outside_body).unwrap();
        let directory = temp.path().join("voice");
        symlink(&outside, &directory).unwrap();

        let store = ApiKeyStore::open(directory);

        assert!(matches!(
            store.is_configured(CloudProvider::Openai),
            Err(KeyStoreError::Unreadable(_))
        ));
        assert!(matches!(
            store.store(CloudProvider::Openai, "sk-replacement"),
            Err(KeyStoreError::Write(_))
        ));
        assert_eq!(
            fs::read_to_string(outside.join("keys.json")).unwrap(),
            outside_body
        );
    }

    #[test]
    fn removing_one_key_keeps_the_others() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        store.store(CloudProvider::Openai, SECRET).unwrap();
        store.store(CloudProvider::Gemini, "gemini-key").unwrap();
        store.store(CloudProvider::Grok, "xai-key").unwrap();

        store.remove(CloudProvider::Openai).unwrap();

        let reopened = store_in(&temp);
        assert!(!reopened.is_configured(CloudProvider::Openai).unwrap());
        for (provider, key) in [
            (CloudProvider::Gemini, "gemini-key"),
            (CloudProvider::Grok, "xai-key"),
        ] {
            assert_eq!(reopened.key(provider).unwrap().unwrap().expose(), key);
        }
        let stored = fs::read_to_string(temp.path().join("voice/keys.json")).unwrap();
        assert!(!stored.contains(SECRET));
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&stored).unwrap()["grok"],
            "xai-key"
        );
    }

    #[test]
    fn an_unreadable_key_file_stays_an_error_until_a_key_replaces_it() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("voice");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("keys.json"), "not json").unwrap();
        let store = ApiKeyStore::open(directory);

        assert!(matches!(
            store.key(CloudProvider::Openai),
            Err(KeyStoreError::Unreadable(_))
        ));

        store.store(CloudProvider::Gemini, "gemini-key").unwrap();

        assert!(!store.is_configured(CloudProvider::Openai).unwrap());
        assert!(store.is_configured(CloudProvider::Gemini).unwrap());
    }

    #[test]
    fn an_unreadable_key_file_is_reported_without_its_contents() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("voice");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("keys.json"), format!(r#""{SECRET}""#)).unwrap();
        let store = ApiKeyStore::open(directory);

        let Err(KeyStoreError::Unreadable(detail)) = store.key(CloudProvider::Openai) else {
            panic!("a key file holding a bare string must be unreadable");
        };
        assert!(!detail.contains(SECRET));
    }

    #[test]
    fn rejects_values_that_cannot_be_api_keys() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        let oversized = "k".repeat(MAX_KEY_BYTES + 1);

        for key in [
            "",
            "   ",
            "sk-with space",
            "sk-line\nbreak",
            oversized.as_str(),
        ] {
            assert!(
                matches!(
                    store.store(CloudProvider::Openai, key),
                    Err(KeyStoreError::InvalidKey(_))
                ),
                "{key:?} must be rejected"
            );
        }
        assert!(!temp.path().join("voice").exists());
    }

    #[test]
    fn debug_output_never_shows_a_key() {
        let key = ApiKey(SECRET.to_string());

        assert!(!format!("{key:?}").contains(SECRET));
    }
}
