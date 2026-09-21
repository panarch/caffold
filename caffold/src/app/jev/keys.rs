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

const KEYS_FILE_NAME: &str = "keys.json";
const REPLACEMENT_FILE_NAME: &str = "keys.json.tmp";
const MAX_KEY_BYTES: usize = 512;

/// The API key the user entered for Jev.
///
/// The key leaves this store only as an [`ApiKey`] for the request that
/// authenticates with it; everything else learns whether one is configured.
pub(super) struct ApiKeyStore {
    directory: PathBuf,
    key: RwLock<Result<Option<String>, String>>,
}

impl ApiKeyStore {
    pub(super) fn open(directory: PathBuf) -> Self {
        let key = read_key(&directory);
        Self {
            directory,
            key: RwLock::new(key),
        }
    }

    pub(super) fn is_configured(&self) -> Result<bool, KeyStoreError> {
        self.read(|key| key.is_some())
    }

    pub(super) fn key(&self) -> Result<Option<ApiKey>, KeyStoreError> {
        self.read(|key| key.clone().map(ApiKey))
    }

    pub(super) fn store(&self, key: &str) -> Result<(), KeyStoreError> {
        let key = validate_key(key)?;
        self.replace(Some(key))
    }

    pub(super) fn remove(&self) -> Result<(), KeyStoreError> {
        self.replace(None)
    }

    fn read<T>(&self, read: impl FnOnce(&Option<String>) -> T) -> Result<T, KeyStoreError> {
        match &*self.key.read().unwrap_or_else(PoisonError::into_inner) {
            Ok(key) => Ok(read(key)),
            Err(message) => Err(KeyStoreError::Unreadable(message.clone())),
        }
    }

    /// Persists the change before publishing it. A file that could not be read
    /// is replaced rather than repaired, so the key it held is lost.
    fn replace(&self, key: Option<String>) -> Result<(), KeyStoreError> {
        let mut current = self.key.write().unwrap_or_else(PoisonError::into_inner);
        write_key(&self.directory, &StoredKey { key: key.clone() })?;
        *current = Ok(key);
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
    #[error("the stored API key could not be read: {0}")]
    Unreadable(String),
    #[error("{0}")]
    InvalidKey(&'static str),
    #[error("the API key could not be saved: {0}")]
    Write(#[from] io::Error),
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct StoredKey {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<String>,
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

fn read_key(directory: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err(format!("{} is not a directory", directory.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    }
    let path = directory.join(KEYS_FILE_NAME);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err(format!("{} is not a regular file", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
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
    // serde_json's message can quote a string from the file, and that string may be the key.
    serde_json::from_slice::<StoredKey>(&body)
        .map(|stored| stored.key)
        .map_err(|error| {
            format!(
                "{} could not be parsed (line {}, column {})",
                path.display(),
                error.line(),
                error.column()
            )
        })
}

fn write_key(directory: &Path, key: &StoredKey) -> io::Result<()> {
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
    let body = serde_json::to_vec_pretty(key).map_err(io::Error::other)?;
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

    const SECRET: &str = "ts-test-0123456789abcdef";

    fn store_in(temp: &TempDir) -> ApiKeyStore {
        ApiKeyStore::open(temp.path().join("jev"))
    }

    #[test]
    fn keeps_the_key_in_an_owner_only_file_that_survives_reopening() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        assert!(!store.is_configured().unwrap());

        store.store(&format!("  {SECRET}\n")).unwrap();

        let reopened = store_in(&temp);
        assert_eq!(reopened.key().unwrap().unwrap().expose(), SECRET);
        assert!(reopened.is_configured().unwrap());
        assert!(!temp.path().join("jev/keys.json.tmp").exists());
        #[cfg(unix)]
        {
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&temp.path().join("jev")), 0o700);
            assert_eq!(mode(&temp.path().join("jev/keys.json")), 0o600);
        }
    }

    #[test]
    fn removing_the_key_leaves_nothing_configured() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        store.store(SECRET).unwrap();

        store.remove().unwrap();

        assert!(!store.is_configured().unwrap());
        assert!(store.key().unwrap().is_none());
        assert!(!store_in(&temp).is_configured().unwrap());
    }

    #[test]
    fn a_key_must_be_visible_ascii_within_the_length_bound() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);

        for rejected in ["", "   ", "ts key with spaces", "ts-\u{ac00}"] {
            assert!(matches!(
                store.store(rejected),
                Err(KeyStoreError::InvalidKey(_))
            ));
        }
        assert!(matches!(
            store.store(&"t".repeat(MAX_KEY_BYTES + 1)),
            Err(KeyStoreError::InvalidKey(_))
        ));
        assert!(!store.is_configured().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_key_file() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("jev");
        fs::create_dir_all(&directory).unwrap();
        let outside = temp.path().join("outside.json");
        fs::write(&outside, r#"{"key":"ts-elsewhere"}"#).unwrap();
        symlink(&outside, directory.join("keys.json")).unwrap();

        let store = ApiKeyStore::open(directory);

        assert!(matches!(
            store.is_configured(),
            Err(KeyStoreError::Unreadable(_))
        ));
        assert!(matches!(store.store(SECRET), Err(KeyStoreError::Write(_))));
        assert_eq!(
            fs::read_to_string(&outside).unwrap(),
            r#"{"key":"ts-elsewhere"}"#
        );
    }

    #[test]
    fn an_unreadable_file_is_reported_without_quoting_its_contents() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("jev");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("keys.json"), r#"{"key":"ts-secret"#).unwrap();

        let store = ApiKeyStore::open(directory);

        match store.is_configured() {
            Err(KeyStoreError::Unreadable(message)) => {
                assert!(!message.contains("ts-secret"), "{message}");
            }
            other => panic!("expected an unreadable key store, got {other:?}"),
        }
    }

    #[test]
    fn a_stored_key_is_never_shown_by_debug() {
        let key = ApiKey(SECRET.to_string());

        assert_eq!(format!("{key:?}"), "ApiKey([redacted])");
    }
}
