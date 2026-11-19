//! The exact native session created for one Task, without conversation data.

use crate::agent::http_mcp::valid_binding;
use crate::agent::{AgentError, TurnOptions};
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
    pub(super) settings: TurnOptions,
    pub(super) first_attempted: bool,
    pub(super) saved: bool,
    #[serde(default)]
    pub(super) creation_attempted: bool,
    #[serde(default)]
    pub(super) replaced_empty: bool,
    pub(super) destination: Option<String>,
}

impl Bindings {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub(super) fn read(&self, task: &str) -> Result<Option<Binding>, AgentError> {
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

    pub(super) fn write(&self, binding: &Binding) -> Result<(), AgentError> {
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
            fs::rename(&temporary, &path).map_err(binding_error)?;
            fs::File::open(&self.directory)
                .and_then(|dir| dir.sync_all())
                .map_err(binding_error)
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }

    pub(super) fn remove(&self, task: &str) -> Result<(), AgentError> {
        self.check_directory()?;
        match fs::remove_file(self.path(task)?) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
            Err(e) => Err(binding_error(e)),
        }
    }

    fn path(&self, task: &str) -> Result<PathBuf, AgentError> {
        validate_session(task)?;
        Ok(self.directory.join(format!("{task}.json")))
    }

    fn check_directory(&self) -> Result<(), AgentError> {
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
    pub(super) fn validate(&self, task: &str) -> Result<(), AgentError> {
        validate_session(task)?;
        validate_session(&self.native_id)?;
        if self.version != 1
            || self.task_id != task
            || !Path::new(&self.cwd).is_absolute()
            || self
                .destination
                .as_ref()
                .is_some_and(|cwd| !Path::new(cwd).is_absolute())
            || !valid_binding(&self.mcp_binding)
        {
            return Err(AgentError::Failed(
                "invalid Task/native binding".to_string(),
            ));
        }
        Ok(())
    }
}

fn binding_error(e: impl Display) -> AgentError {
    AgentError::Failed(e.to_string())
}

pub(super) fn validate_session(value: &str) -> Result<(), AgentError> {
    if Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        Ok(())
    } else {
        Err(AgentError::Failed(
            "Copilot session ID must be a canonical UUID.".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::http_mcp::new_binding_value;

    #[test]
    fn reserved_identity_and_first_attempt_survive_reopen_without_following_replaced_files() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let root = tempfile::tempdir().unwrap();
        let bindings = Bindings::new(root.path().join("bindings"));
        let task = Uuid::new_v4().to_string();
        let mut original = Binding {
            version: 1,
            task_id: task.clone(),
            native_id: Uuid::new_v4().to_string(),
            cwd: "/project".into(),
            mcp_binding: new_binding_value(),
            settings: TurnOptions::default(),
            first_attempted: false,
            creation_attempted: true,
            replaced_empty: false,
            saved: true,
            destination: None,
        };

        assert!(bindings.read(&task).unwrap().is_none());
        bindings.write(&original).unwrap();
        let file = bindings.path(&task).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );

        original.first_attempted = true;
        original.destination = Some("/worktree".into());
        bindings.write(&original).unwrap();
        let recovered = Bindings::new(root.path().join("bindings"))
            .read(&task)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.native_id, original.native_id);
        assert_eq!(recovered.mcp_binding, original.mcp_binding);
        assert!(recovered.first_attempted);
        assert_eq!(recovered.destination.as_deref(), Some("/worktree"));

        let old = root.path().join("saved");
        fs::rename(&file, &old).unwrap();
        symlink(&old, &file).unwrap();
        assert!(matches!(bindings.read(&task), Err(AgentError::Failed(_))));
        assert!(matches!(
            bindings.read("../other"),
            Err(AgentError::Failed(_))
        ));
    }
}
