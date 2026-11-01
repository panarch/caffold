//! The exact native session created for one Task, without conversation data.
use super::{AntigravityError, record::validate_session};
use crate::agent::http_mcp::valid_binding;
use serde::{Deserialize, Serialize};
use std::{
    fmt::Display,
    fs,
    io::{ErrorKind, Read, Write},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct Bindings {
    directory: PathBuf,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Binding {
    pub(super) version: u32,
    pub(super) task_id: String,
    pub(super) native_id: String,
    pub(super) cwd: String,
    pub(super) mcp_binding: String,
}
impl Bindings {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    pub(super) fn read(&self, task: &str) -> Result<Option<Binding>, AntigravityError> {
        self.check_directory()?;
        let mut file = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(self.path(task)?)
        {
            Ok(file) => file,
            Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(binding_error(e)),
        };
        if !file.metadata().map_err(binding_error)?.is_file() {
            return Err(binding_error("binding is not a regular file"));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(65537)
            .read_to_end(&mut bytes)
            .map_err(binding_error)?;
        if bytes.len() > 65536 {
            return Err(binding_error("binding is too large"));
        }
        let binding: Binding = serde_json::from_slice(&bytes).map_err(binding_error)?;
        binding.validate(task)?;
        Ok(Some(binding))
    }
    pub(super) fn write(&self, binding: &Binding) -> Result<(), AntigravityError> {
        binding.validate(&binding.task_id)?;
        fs::create_dir_all(&self.directory).map_err(binding_error)?;
        self.check_directory()?;
        let path = self.path(&binding.task_id)?;
        let temporary = self
            .directory
            .join(format!(".{}.{}.tmp", binding.task_id, Uuid::new_v4()));
        let result = (|| {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temporary)
                .map_err(binding_error)?;
            file.write_all(&serde_json::to_vec(binding).map_err(binding_error)?)
                .map_err(binding_error)?;
            file.sync_all().map_err(binding_error)?;
            fs::rename(&temporary, &path).map_err(binding_error)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
    pub(super) fn remove(&self, task: &str) -> Result<(), AntigravityError> {
        self.check_directory()?;
        match fs::remove_file(self.path(task)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(binding_error(e)),
        }
    }
    fn path(&self, task: &str) -> Result<PathBuf, AntigravityError> {
        validate_session(task)?;
        Ok(self.directory.join(format!("{task}.json")))
    }
    fn check_directory(&self) -> Result<(), AntigravityError> {
        match fs::symlink_metadata(&self.directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Ok(()),
            Ok(_) => Err(binding_error(
                "binding directory is not a regular directory",
            )),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(binding_error(error)),
        }
    }
}
impl Binding {
    pub(super) fn validate(&self, task: &str) -> Result<(), AntigravityError> {
        validate_session(task)?;
        validate_session(&self.native_id)?;
        if self.version != 1
            || self.task_id != task
            || !Path::new(&self.cwd).is_absolute()
            || !valid_binding(&self.mcp_binding)
        {
            return Err(AntigravityError::Binding(
                "invalid Task/native binding".to_string(),
            ));
        }
        Ok(())
    }
}

fn binding_error(e: impl Display) -> AntigravityError {
    AntigravityError::Binding(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::http_mcp::new_binding_value;
    use std::os::unix::fs::{PermissionsExt, symlink};
    fn binding() -> Binding {
        Binding {
            version: 1,
            task_id: Uuid::new_v4().to_string(),
            native_id: Uuid::new_v4().to_string(),
            cwd: "/fixture".into(),
            mcp_binding: new_binding_value(),
        }
    }
    #[test]
    fn binding_round_trip_is_private_and_only_accepts_exact_task_and_native_ids() {
        let root = tempfile::tempdir().unwrap();
        let bindings = Bindings::new(root.path().join("bindings"));
        let binding = binding();
        assert!(bindings.read(&binding.task_id).unwrap().is_none());
        bindings.write(&binding).unwrap();
        let path = bindings.path(&binding.task_id).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            bindings.read(&binding.task_id).unwrap().unwrap().native_id,
            binding.native_id
        );
        assert!(bindings.read("../outside").is_err());
        let mut wrong = binding.clone();
        wrong.native_id = "not-a-native-id".into();
        assert!(bindings.write(&wrong).is_err());
        assert_eq!(
            bindings.read(&binding.task_id).unwrap().unwrap().native_id,
            binding.native_id
        );
        bindings.remove(&binding.task_id).unwrap();
        bindings.remove(&binding.task_id).unwrap();
    }
    #[test]
    fn malformed_or_linked_bindings_are_errors_and_do_not_follow_external_files() {
        let root = tempfile::tempdir().unwrap();
        let bindings = Bindings::new(root.path().join("bindings"));
        let binding = binding();
        bindings.write(&binding).unwrap();
        let path = bindings.path(&binding.task_id).unwrap();
        fs::write(&path, b"malformed").unwrap();
        assert!(bindings.read(&binding.task_id).is_err());
        let outside = root.path().join("outside");
        fs::write(&outside, b"kept").unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&outside, &path).unwrap();
        assert!(bindings.read(&binding.task_id).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"kept");
        let linked = Bindings::new(root.path().join("linked"));
        symlink(root.path(), &linked.directory).unwrap();
        assert!(linked.write(&binding).is_err());
    }
}
