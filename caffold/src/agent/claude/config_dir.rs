//! Which directory Claude keeps its sign-in, settings, and conversations in.
//!
//! Claude reads `~/.claude` unless `CLAUDE_CONFIG_DIR` names another directory.
//! Settings → Claude picks the one new Tasks run under, and each Task keeps the
//! one it was created under, because its conversation is written there.
//!
//! The variable is passed only for a directory other than the default. Whenever
//! it is set, Claude names the keychain item holding its sign-in after the
//! variable's exact text, so even the default directory spelled out would look
//! for a sign-in nobody made. For the same reason a value is kept the way a
//! shell hands it over: `~` expanded, no trailing `/`.
//!
//! A `CLAUDE_CONFIG_DIR` the backend inherited is never used. Every `claude`
//! Caffold starts runs under the directory chosen here, and the runner that
//! starts sessions is itself started without it.

use std::{
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    sync::{PoisonError, RwLock},
};

use serde::{Deserialize, Serialize};

use super::status;

pub(super) const ENVIRONMENT_NAME: &str = "CLAUDE_CONFIG_DIR";
const SETTINGS_FILE_NAME: &str = "settings.json";

/// The directory new Tasks run under, as Settings → Claude saved it. `None` is
/// Claude's default.
pub(super) struct ConfigDirSetting {
    /// Where the setting is kept. Absent for a client that keeps it in memory.
    directory: Option<PathBuf>,
    /// A file that cannot be read stays an error until a value is saved over
    /// it: reading it as the default would start Tasks under another account.
    value: RwLock<Result<Option<String>, String>>,
}

impl ConfigDirSetting {
    pub(super) fn open(directory: PathBuf) -> Self {
        let value = read(&directory.join(SETTINGS_FILE_NAME));
        Self {
            directory: Some(directory),
            value: RwLock::new(value),
        }
    }

    #[cfg(test)]
    pub(super) fn unsaved() -> Self {
        Self {
            directory: None,
            value: RwLock::new(Ok(None)),
        }
    }

    pub(super) fn get(&self) -> Result<Option<String>, String> {
        self.value
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Keep `config_dir`, answering whether it differs from what was kept.
    pub(super) fn save(&self, config_dir: Option<String>) -> io::Result<bool> {
        let mut current = self.value.write().unwrap_or_else(PoisonError::into_inner);
        if let Some(directory) = &self.directory {
            write(directory, config_dir.as_deref())?;
        }
        let changed = current.as_ref() != Ok(&config_dir);
        *current = Ok(config_dir);
        Ok(changed)
    }
}

/// Why a directory cannot be the one new Tasks run under, in words for the
/// person choosing it.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub(crate) enum ConfigDirRefusal {
    #[error("Enter an absolute path.")]
    NotAbsolute,
    #[error("This folder does not exist.")]
    Missing,
    #[error(
        "Claude Code is not signed in with this folder. Sign in from a terminal with CLAUDE_CONFIG_DIR={0} claude, then save again."
    )]
    SignedOut(String),
    #[error("Couldn't check the sign-in: {0}")]
    Unchecked(String),
}

/// Why a typed config directory was not saved.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ConfigDirSaveError {
    #[error(transparent)]
    Refused(#[from] ConfigDirRefusal),
    #[error("Couldn't save the setting: {0}")]
    Unsaved(#[from] io::Error),
}

/// The value to keep for what a person typed, once `program` shows it is
/// signed in there. Blank, and the default however it is spelled, keep
/// nothing.
pub(super) async fn validate(
    program: &OsStr,
    typed: &str,
    home: Option<&Path>,
) -> Result<Option<String>, ConfigDirRefusal> {
    let Some(directory) = normalize(typed, home)? else {
        return Ok(None);
    };
    match tokio::fs::metadata(&directory).await {
        Ok(metadata) if metadata.is_dir() => {}
        _ => return Err(ConfigDirRefusal::Missing),
    }
    match status::signed_in(program, &directory).await {
        Ok(true) => Ok(Some(directory)),
        Ok(false) => Err(ConfigDirRefusal::SignedOut(directory)),
        Err(problem) => Err(ConfigDirRefusal::Unchecked(problem)),
    }
}

/// Run `command` under `config_dir`, and never under one it inherited.
pub(super) fn apply(command: &mut tokio::process::Command, config_dir: Option<&str>) {
    command.env_remove(ENVIRONMENT_NAME);
    if let Some(config_dir) = config_dir {
        command.env(ENVIRONMENT_NAME, config_dir);
    }
}

/// Claude's own default, which an empty setting runs under.
pub(super) fn default_dir(home: Option<&Path>) -> Option<String> {
    home.and_then(|home| home.join(".claude").to_str().map(str::to_string))
}

pub(super) fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

/// What a shell would hand Claude for `typed`.
fn normalize(typed: &str, home: Option<&Path>) -> Result<Option<String>, ConfigDirRefusal> {
    let typed = typed.trim();
    if typed.is_empty() {
        return Ok(None);
    }
    let expanded = match typed.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => home
            .ok_or(ConfigDirRefusal::NotAbsolute)?
            .join(rest.trim_start_matches('/')),
        _ => PathBuf::from(typed),
    };
    if !expanded.is_absolute() {
        return Err(ConfigDirRefusal::NotAbsolute);
    }
    let expanded = expanded.to_str().ok_or(ConfigDirRefusal::NotAbsolute)?;
    let directory = match expanded.trim_end_matches('/') {
        "" => "/",
        trimmed => trimmed,
    };
    if default_dir(home).as_deref() == Some(directory) {
        return Ok(None);
    }
    Ok(Some(directory.to_string()))
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    config_dir: Option<String>,
}

fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read(path) {
        Ok(body) => serde_json::from_slice::<StoredSettings>(&body)
            .map(|settings| settings.config_dir)
            .map_err(|error| error.to_string()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn write(directory: &Path, config_dir: Option<&str>) -> io::Result<()> {
    fs::create_dir_all(directory)?;
    let body = serde_json::to_vec_pretty(&StoredSettings {
        config_dir: config_dir.map(str::to_string),
    })
    .map_err(io::Error::other)?;
    let path = directory.join(SETTINGS_FILE_NAME);
    let replacement = path.with_extension("json.tmp");
    fs::write(&replacement, body)?;
    fs::rename(&replacement, path)
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    const HOME: &str = "/Users/someone";

    fn normalized(typed: &str) -> Result<Option<String>, ConfigDirRefusal> {
        normalize(typed, Some(Path::new(HOME)))
    }

    /// Checked in rather than written by the test: Linux refuses to run a file
    /// that another test's starting process may still hold open for writing.
    fn fake_claude() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/agent/claude/status/fixtures/fake-claude-auth")
    }

    #[test]
    fn a_typed_directory_is_kept_the_way_a_shell_hands_it_over() {
        assert_eq!(
            normalized("~/.claude-work"),
            Ok(Some("/Users/someone/.claude-work".to_string()))
        );
        assert_eq!(
            normalized("  /Volumes/work/.claude/  "),
            Ok(Some("/Volumes/work/.claude".to_string()))
        );
        assert_eq!(normalized("~"), Ok(Some(HOME.to_string())));
        assert_eq!(normalized("/"), Ok(Some("/".to_string())));
    }

    #[test]
    fn blank_and_the_default_however_spelled_keep_nothing() {
        for typed in [
            "",
            "   ",
            "~/.claude",
            "~/.claude/",
            "/Users/someone/.claude//",
        ] {
            assert_eq!(normalized(typed), Ok(None), "{typed:?}");
        }
    }

    #[test]
    fn a_relative_directory_or_another_users_home_is_refused() {
        for typed in [".claude-work", "work/.claude", "~other/.claude"] {
            assert_eq!(
                normalized(typed),
                Err(ConfigDirRefusal::NotAbsolute),
                "{typed:?}"
            );
        }
        assert_eq!(
            normalize("~/.claude-work", None),
            Err(ConfigDirRefusal::NotAbsolute),
            "`~` means nothing without a home"
        );
    }

    #[tokio::test]
    async fn a_directory_is_kept_only_once_claude_is_signed_in_there() {
        let temp = TempDir::new().unwrap();
        let signed_in = temp.path().join("work");
        let signed_out = temp.path().join("personal");
        fs::create_dir(&signed_in).unwrap();
        fs::write(signed_in.join("signed-in"), "").unwrap();
        fs::create_dir(&signed_out).unwrap();
        let home = Some(temp.path());
        let claude = fake_claude();

        assert_eq!(
            validate(claude.as_os_str(), signed_in.to_str().unwrap(), home).await,
            Ok(Some(signed_in.to_str().unwrap().to_string()))
        );
        assert_eq!(
            validate(claude.as_os_str(), signed_out.to_str().unwrap(), home).await,
            Err(ConfigDirRefusal::SignedOut(
                signed_out.to_str().unwrap().to_string()
            ))
        );
        assert_eq!(
            validate(
                claude.as_os_str(),
                temp.path().join("missing").to_str().unwrap(),
                home
            )
            .await,
            Err(ConfigDirRefusal::Missing)
        );
        assert_eq!(
            validate(
                claude.as_os_str(),
                signed_in.join("signed-in").to_str().unwrap(),
                home
            )
            .await,
            Err(ConfigDirRefusal::Missing),
            "a file is not a folder"
        );
        assert!(matches!(
            validate(
                temp.path().join("no-claude").as_os_str(),
                signed_in.to_str().unwrap(),
                home
            )
            .await,
            Err(ConfigDirRefusal::Unchecked(_))
        ));
        assert_eq!(
            validate(temp.path().join("no-claude").as_os_str(), "", home).await,
            Ok(None),
            "keeping the default asks nothing"
        );
    }

    #[test]
    fn the_setting_survives_reopening_and_says_whether_it_changed() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("claude");
        let setting = ConfigDirSetting::open(directory.clone());

        assert_eq!(setting.get(), Ok(None));
        assert!(!directory.exists(), "reading the default writes nothing");

        assert!(
            setting
                .save(Some("/Volumes/work/.claude".to_string()))
                .unwrap()
        );
        assert!(
            !setting
                .save(Some("/Volumes/work/.claude".to_string()))
                .unwrap()
        );
        assert_eq!(
            ConfigDirSetting::open(directory.clone()).get(),
            Ok(Some("/Volumes/work/.claude".to_string()))
        );
        assert!(!directory.join("settings.json.tmp").exists());

        assert!(setting.save(None).unwrap());
        assert_eq!(ConfigDirSetting::open(directory).get(), Ok(None));
    }

    #[test]
    fn an_unreadable_setting_stays_an_error_until_a_value_is_saved() {
        let temp = TempDir::new().unwrap();
        let directory = temp.path().join("claude");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("settings.json"), r#"{"configDir": 7}"#).unwrap();
        let setting = ConfigDirSetting::open(directory);

        assert!(setting.get().is_err());

        assert!(setting.save(None).unwrap());
        assert_eq!(setting.get(), Ok(None));

        let blocked = temp.path().join("blocked");
        fs::create_dir_all(blocked.join("settings.json")).unwrap();
        assert!(
            ConfigDirSetting::open(blocked).get().is_err(),
            "a file that cannot be read is not the default"
        );
    }

    #[test]
    fn a_started_claude_runs_under_the_chosen_directory_only() {
        let mut command = tokio::process::Command::new("claude");
        apply(&mut command, None);
        assert_eq!(
            command.as_std().get_envs().collect::<Vec<_>>(),
            vec![(OsStr::new(ENVIRONMENT_NAME), None)]
        );

        let mut command = tokio::process::Command::new("claude");
        apply(&mut command, Some("/Volumes/work/.claude"));
        assert_eq!(
            command.as_std().get_envs().collect::<Vec<_>>(),
            vec![(
                OsStr::new(ENVIRONMENT_NAME),
                Some(OsStr::new("/Volumes/work/.claude"))
            )]
        );
    }
}
