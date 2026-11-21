use std::{
    fmt,
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{PoisonError, RwLock},
};

#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use thiserror::Error;

use super::DecisionModelProvider;

const KEYS_FILE_NAME: &str = "keys.json";
const REPLACEMENT_FILE_NAME: &str = "keys.json.tmp";
const MAX_KEY_BYTES: usize = 512;

/// The API keys the user entered for the decision models.
///
/// A key leaves this store only as an [`ApiKey`] for the request that
/// authenticates with it; everything else learns whether a key is configured.
pub(super) struct ApiKeyStore {
    directory: PathBuf,
    keys: RwLock<Result<StoredKeys, String>>,
}

impl ApiKeyStore {
    pub(super) fn open(directory: PathBuf) -> Self {
        let keys = read_file(&directory);
        Self {
            directory,
            keys: RwLock::new(keys),
        }
    }

    pub(super) fn is_configured(
        &self,
        provider: DecisionModelProvider,
    ) -> Result<bool, KeyStoreError> {
        self.read(|keys| keys.slot(provider).is_some())
    }

    pub(super) fn key(
        &self,
        provider: DecisionModelProvider,
    ) -> Result<Option<ApiKey>, KeyStoreError> {
        self.read(|keys| keys.slot(provider).clone().map(ApiKey))
    }

    pub(super) fn store(
        &self,
        provider: DecisionModelProvider,
        key: &str,
    ) -> Result<(), KeyStoreError> {
        let key = validate_key(key)?;
        self.replace(|keys| *keys.slot_mut(provider) = Some(key))
    }

    pub(super) fn remove(&self, provider: DecisionModelProvider) -> Result<(), KeyStoreError> {
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

/// The key a Caffold that asked only Jev kept, in the file it wrote then.
pub(super) fn read_jev_key(directory: &Path) -> Result<Option<String>, String> {
    read_file::<StoredJevKey>(directory).map(|stored| stored.key)
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
    #[error("the API key could not be saved: {0}")]
    Write(#[from] io::Error),
}

#[derive(Clone, Default, Deserialize, Serialize)]
struct StoredKeys {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    jev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    openai: Option<String>,
}

impl StoredKeys {
    fn slot(&self, provider: DecisionModelProvider) -> &Option<String> {
        match provider {
            DecisionModelProvider::Jev => &self.jev,
            DecisionModelProvider::Openai => &self.openai,
        }
    }

    fn slot_mut(&mut self, provider: DecisionModelProvider) -> &mut Option<String> {
        match provider {
            DecisionModelProvider::Jev => &mut self.jev,
            DecisionModelProvider::Openai => &mut self.openai,
        }
    }
}

#[derive(Default, Deserialize)]
struct StoredJevKey {
    #[serde(default)]
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

fn read_file<T: DeserializeOwned + Default>(directory: &Path) -> Result<T, String> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err(format!("{} is not a directory", directory.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
        Err(error) => return Err(error.to_string()),
    }
    let path = directory.join(KEYS_FILE_NAME);
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err(format!("{} is not a regular file", path.display())),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
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

    const SECRET: &str = "ts-test-0123456789abcdef";

    fn store_in(temp: &TempDir) -> ApiKeyStore {
        ApiKeyStore::open(temp.path().join("decision-model"))
    }

    #[test]
    fn keeps_each_key_in_an_owner_only_file_that_survives_reopening() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        assert!(!store.is_configured(DecisionModelProvider::Jev).unwrap());

        store
            .store(DecisionModelProvider::Jev, &format!("  {SECRET}\n"))
            .unwrap();
        store
            .store(DecisionModelProvider::Openai, "sk-test-openai")
            .unwrap();

        let reopened = store_in(&temp);
        let key = |provider| reopened.key(provider).unwrap().unwrap();
        assert_eq!(key(DecisionModelProvider::Jev).expose(), SECRET);
        assert_eq!(
            key(DecisionModelProvider::Openai).expose(),
            "sk-test-openai"
        );
        assert!(!temp.path().join("decision-model/keys.json.tmp").exists());
        #[cfg(unix)]
        {
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&temp.path().join("decision-model")), 0o700);
            assert_eq!(mode(&temp.path().join("decision-model/keys.json")), 0o600);
        }
    }

    #[test]
    fn removing_one_key_leaves_the_other() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);
        store.store(DecisionModelProvider::Jev, SECRET).unwrap();
        store
            .store(DecisionModelProvider::Openai, "sk-test-openai")
            .unwrap();

        store.remove(DecisionModelProvider::Jev).unwrap();

        let reopened = store_in(&temp);
        assert!(!reopened.is_configured(DecisionModelProvider::Jev).unwrap());
        assert!(reopened.key(DecisionModelProvider::Jev).unwrap().is_none());
        assert!(
            reopened
                .is_configured(DecisionModelProvider::Openai)
                .unwrap()
        );
    }

    #[test]
    fn a_key_must_be_visible_ascii_within_the_length_bound() {
        let temp = TempDir::new().unwrap();
        let store = store_in(&temp);

        for rejected in ["", "   ", "ts key with spaces", "ts-\u{ac00}"] {
            assert!(matches!(
                store.store(DecisionModelProvider::Jev, rejected),
                Err(KeyStoreError::InvalidKey(_))
            ));
        }
        assert!(matches!(
            store.store(DecisionModelProvider::Jev, &"t".repeat(MAX_KEY_BYTES + 1)),
            Err(KeyStoreError::InvalidKey(_))
        ));
        assert!(!store.is_configured(DecisionModelProvider::Jev).unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlinked_key_file() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("decision-model");
        fs::create_dir_all(&directory).unwrap();
        let outside = temp.path().join("outside.json");
        fs::write(&outside, r#"{"jev":"ts-elsewhere"}"#).unwrap();
        symlink(&outside, directory.join("keys.json")).unwrap();

        let store = ApiKeyStore::open(directory);

        assert!(matches!(
            store.is_configured(DecisionModelProvider::Jev),
            Err(KeyStoreError::Unreadable(_))
        ));
        assert!(matches!(
            store.store(DecisionModelProvider::Jev, SECRET),
            Err(KeyStoreError::Write(_))
        ));
        assert_eq!(
            fs::read_to_string(&outside).unwrap(),
            r#"{"jev":"ts-elsewhere"}"#
        );
    }

    #[test]
    fn an_unreadable_file_is_reported_without_quoting_its_contents() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("decision-model");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("keys.json"), r#"{"jev":"ts-secret"#).unwrap();

        let store = ApiKeyStore::open(directory);

        match store.is_configured(DecisionModelProvider::Jev) {
            Err(KeyStoreError::Unreadable(message)) => {
                assert!(!message.contains("ts-secret"), "{message}");
            }
            other => panic!("expected an unreadable key store, got {other:?}"),
        }
    }

    #[test]
    fn reads_the_key_a_jev_only_caffold_kept() {
        let temp = TempDir::new().unwrap();
        let legacy = temp.path().join("jev");
        fs::create_dir_all(&legacy).unwrap();

        assert_eq!(read_jev_key(&legacy).unwrap(), None, "no file yet");

        fs::write(legacy.join("keys.json"), format!(r#"{{"key":"{SECRET}"}}"#)).unwrap();
        assert_eq!(read_jev_key(&legacy).unwrap().as_deref(), Some(SECRET));

        fs::write(legacy.join("keys.json"), r#"{"key":"ts-secret"#).unwrap();
        let unreadable = read_jev_key(&legacy).unwrap_err();
        assert!(!unreadable.contains("ts-secret"), "{unreadable}");
    }

    #[test]
    fn a_stored_key_is_never_shown_by_debug() {
        let key = ApiKey(SECRET.to_string());

        assert_eq!(format!("{key:?}"), "ApiKey([redacted])");
    }
}
