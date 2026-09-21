use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::{PoisonError, RwLock},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

const CRITERIA_FILE_NAME: &str = "criteria.json";
const REPLACEMENT_FILE_NAME: &str = "criteria.json.tmp";

/// How long the rules may be.
///
/// Jev reads the rules, the request, and the Task's record in one 64k-token
/// state, and its own guidance warns that padding a state with material the
/// question does not need costs accuracy. This bound keeps the rules a page of
/// judgement rather than a document.
pub(super) const MAX_CRITERIA_BYTES: usize = 16 * 1024;

/// The rules a person wrote for deciding permission requests on this host.
///
/// Empty is a meaningful value and the one a fresh installation has: these are
/// extra rules, and with none written Jev judges by the standard alone.
pub(super) struct CriteriaStore {
    directory: PathBuf,
    criteria: RwLock<Result<String, String>>,
}

impl CriteriaStore {
    pub(super) fn open(directory: PathBuf) -> Self {
        let criteria = read_criteria(&directory.join(CRITERIA_FILE_NAME));
        Self {
            directory,
            criteria: RwLock::new(criteria),
        }
    }

    pub(super) fn criteria(&self) -> Result<String, CriteriaError> {
        match &*self.criteria.read().unwrap_or_else(PoisonError::into_inner) {
            Ok(criteria) => Ok(criteria.clone()),
            Err(message) => Err(CriteriaError::Unreadable(message.clone())),
        }
    }

    pub(super) fn save(&self, criteria: &str) -> Result<(), CriteriaError> {
        if criteria.len() > MAX_CRITERIA_BYTES {
            return Err(CriteriaError::TooLong);
        }
        let mut current = self
            .criteria
            .write()
            .unwrap_or_else(PoisonError::into_inner);
        write_criteria(&self.directory, criteria)?;
        *current = Ok(criteria.to_string());
        Ok(())
    }
}

#[derive(Debug, Error)]
pub(super) enum CriteriaError {
    #[error("the stored rules could not be read: {0}")]
    Unreadable(String),
    #[error("The rules are too long.")]
    TooLong,
    #[error("the rules could not be saved: {0}")]
    Write(#[from] io::Error),
}

#[derive(Deserialize, Serialize)]
struct StoredCriteria {
    criteria: String,
}

fn read_criteria(path: &Path) -> Result<String, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice::<StoredCriteria>(&body)
            .map(|stored| stored.criteria)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_criteria(directory: &Path, criteria: &str) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let body = serde_json::to_vec_pretty(&StoredCriteria {
        criteria: criteria.to_string(),
    })
    .map_err(io::Error::other)?;
    let path = directory.join(CRITERIA_FILE_NAME);
    let replacement = directory.join(REPLACEMENT_FILE_NAME);
    fs::write(&replacement, body)?;
    fs::rename(&replacement, path)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn a_fresh_installation_has_no_rules_and_writes_no_file() {
        let temp = TempDir::new().unwrap();
        let store = CriteriaStore::open(temp.path().join("jev"));

        assert_eq!(store.criteria().unwrap(), "");
        assert!(!temp.path().join("jev").exists());
    }

    #[test]
    fn saved_rules_survive_reopening_verbatim() {
        let temp = TempDir::new().unwrap();
        let store = CriteriaStore::open(temp.path().join("jev"));
        let rules = "워크트리 안의 파일을 읽는 건 허용.\n밖으로 나가는 건 허용하지 않음.\n";

        store.save(rules).unwrap();

        assert_eq!(
            CriteriaStore::open(temp.path().join("jev"))
                .criteria()
                .unwrap(),
            rules
        );
        assert!(!temp.path().join("jev/criteria.json.tmp").exists());
    }

    #[test]
    fn rules_can_be_cleared_back_to_empty() {
        let temp = TempDir::new().unwrap();
        let store = CriteriaStore::open(temp.path().join("jev"));
        store.save("allow reads").unwrap();

        store.save("").unwrap();

        assert_eq!(store.criteria().unwrap(), "");
        assert_eq!(
            CriteriaStore::open(temp.path().join("jev"))
                .criteria()
                .unwrap(),
            ""
        );
    }

    #[test]
    fn rules_longer_than_the_bound_are_refused_and_change_nothing() {
        let temp = TempDir::new().unwrap();
        let store = CriteriaStore::open(temp.path().join("jev"));
        store.save("allow reads").unwrap();

        let result = store.save(&"r".repeat(MAX_CRITERIA_BYTES + 1));

        assert!(matches!(result, Err(CriteriaError::TooLong)));
        assert_eq!(store.criteria().unwrap(), "allow reads");
    }

    #[test]
    fn unreadable_rules_stay_an_error_until_they_are_saved_again() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("jev");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("criteria.json"), "{ not json").unwrap();
        let store = CriteriaStore::open(directory);

        assert!(matches!(
            store.criteria(),
            Err(CriteriaError::Unreadable(_))
        ));

        store.save("allow reads").unwrap();

        assert_eq!(store.criteria().unwrap(), "allow reads");
    }
}
