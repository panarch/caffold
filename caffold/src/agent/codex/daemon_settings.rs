//! Codex's automatic updater replaces the shared app-server daemon whenever a
//! release lands, and a turn still running after the daemon's shutdown grace
//! period is killed. Caffold restarts that daemon only when a person confirms
//! it, so before each daemon command it runs, it turns the updater off in
//! Codex's own settings file, unless that file already says whether the
//! updater runs.

use std::{
    env,
    ffi::OsStr,
    io::ErrorKind,
    path::{Path, PathBuf},
    process,
};

use serde::Serialize;
use serde_json::{Map, Value};
use tokio::fs;

const SETTINGS_FILE: &str = "app-server-daemon/settings.json";
const UPDATER: &str = "updater";
const AUTO_UPDATE_ENABLED: &str = "autoUpdateEnabled";

/// Whether Codex's updater runs, as Codex reads its settings file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum AutomaticUpdates {
    Enabled,
    Disabled,
}

/// Writes `updater.autoUpdateEnabled: false` unless the settings file already
/// holds a value there, whichever it is. Every other setting stays as it was.
pub(super) async fn turn_off_automatic_updates_when_unset(codex_home: &Path) -> Result<(), String> {
    let path = codex_home.join(SETTINGS_FILE);
    let mut settings = match fs::read_to_string(&path).await {
        Ok(contents) => settings_object(&path, &contents)?,
        Err(error) if error.kind() == ErrorKind::NotFound => Map::new(),
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    let Value::Object(updater) = settings
        .entry(UPDATER)
        .or_insert_with(|| Value::Object(Map::new()))
    else {
        return Err(updater_not_an_object(&path));
    };
    if updater.contains_key(AUTO_UPDATE_ENABLED) {
        return Ok(());
    }
    updater.insert(AUTO_UPDATE_ENABLED.to_string(), Value::Bool(false));
    write_settings(&path, &settings).await
}

/// What Codex's updater will do, read from the file Codex reads. Codex runs
/// the updater when the file or the value is missing.
pub(super) async fn automatic_updates(codex_home: &Path) -> Result<AutomaticUpdates, String> {
    let path = codex_home.join(SETTINGS_FILE);
    let contents = match fs::read_to_string(&path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(AutomaticUpdates::Enabled);
        }
        Err(error) => return Err(format!("Failed to read {}: {error}", path.display())),
    };
    let settings = settings_object(&path, &contents)?;
    let updater = match settings.get(UPDATER) {
        None => return Ok(AutomaticUpdates::Enabled),
        Some(Value::Object(updater)) => updater,
        Some(_) => return Err(updater_not_an_object(&path)),
    };
    match updater.get(AUTO_UPDATE_ENABLED) {
        None | Some(Value::Bool(true)) => Ok(AutomaticUpdates::Enabled),
        Some(Value::Bool(false)) => Ok(AutomaticUpdates::Disabled),
        Some(_) => Err(format!(
            "{} gives `updater.autoUpdateEnabled` a value that is neither true nor false.",
            path.display()
        )),
    }
}

/// Where the Codex CLI keeps its state: `CODEX_HOME` when it is set,
/// otherwise `~/.codex`.
pub(super) fn codex_home() -> Result<PathBuf, String> {
    codex_home_from(
        env::var_os("CODEX_HOME").as_deref(),
        env::var_os("HOME").as_deref(),
    )
    .ok_or_else(|| {
        "Neither CODEX_HOME nor HOME is set, so the Codex home directory is unknown.".to_string()
    })
}

fn codex_home_from(codex_home: Option<&OsStr>, home: Option<&OsStr>) -> Option<PathBuf> {
    codex_home
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|value| !value.is_empty())
                .map(|home| Path::new(home).join(".codex"))
        })
}

fn settings_object(path: &Path, contents: &str) -> Result<Map<String, Value>, String> {
    match serde_json::from_str::<Value>(contents) {
        Ok(Value::Object(settings)) => Ok(settings),
        Ok(_) => Err(format!("{} does not hold a JSON object.", path.display())),
        Err(error) => Err(format!("Failed to parse {}: {error}", path.display())),
    }
}

fn updater_not_an_object(path: &Path) -> String {
    format!(
        "{} gives `updater` a value that is not an object.",
        path.display()
    )
}

/// Replaces the file whole, as Codex does, so no reader sees half of it.
async fn write_settings(path: &Path, settings: &Map<String, Value>) -> Result<(), String> {
    let directory = path
        .parent()
        .expect("the settings file lives in a directory");
    fs::create_dir_all(directory)
        .await
        .map_err(|error| format!("Failed to create {}: {error}", directory.display()))?;
    let contents = serde_json::to_vec_pretty(settings).expect("a JSON object serializes");
    // Codex writes its own replacement to `settings.tmp`; this name never meets it.
    let replacement = directory.join(format!("settings.json.caffold-{}.tmp", process::id()));
    if let Err(error) = fs::write(&replacement, contents).await {
        let _ = fs::remove_file(&replacement).await;
        return Err(format!(
            "Failed to write {}: {error}",
            replacement.display()
        ));
    }
    if let Err(error) = fs::rename(&replacement, path).await {
        let _ = fs::remove_file(&replacement).await;
        return Err(format!("Failed to replace {}: {error}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;

    #[tokio::test]
    async fn turns_updates_off_in_a_settings_file_that_does_not_exist_yet() {
        let home = TempDir::new().unwrap();

        turn_off_automatic_updates_when_unset(home.path())
            .await
            .unwrap();

        assert_eq!(
            settings(&home),
            json!({ "updater": { "autoUpdateEnabled": false } })
        );
        assert_eq!(
            entries(&home),
            vec!["settings.json".to_string()],
            "the replacement file must not be left behind"
        );
    }

    #[tokio::test]
    async fn adds_only_the_updater_value_and_keeps_every_other_setting() {
        let home = TempDir::new().unwrap();
        write(
            &home,
            &json!({
                "remoteControlEnabled": true,
                "shutdownGraceSeconds": 120,
                "updater": { "updateIntervalMinutes": 30 },
                "settingCodexAddsLater": { "kept": [1, 2] }
            })
            .to_string(),
        );

        turn_off_automatic_updates_when_unset(home.path())
            .await
            .unwrap();

        assert_eq!(
            settings(&home),
            json!({
                "remoteControlEnabled": true,
                "shutdownGraceSeconds": 120,
                "updater": { "updateIntervalMinutes": 30, "autoUpdateEnabled": false },
                "settingCodexAddsLater": { "kept": [1, 2] }
            })
        );
    }

    #[tokio::test]
    async fn adds_the_updater_object_when_the_file_has_none() {
        let home = TempDir::new().unwrap();
        write(&home, r#"{"remoteControlEnabled":false}"#);

        turn_off_automatic_updates_when_unset(home.path())
            .await
            .unwrap();

        assert_eq!(
            settings(&home),
            json!({
                "remoteControlEnabled": false,
                "updater": { "autoUpdateEnabled": false }
            })
        );
    }

    #[tokio::test]
    async fn leaves_a_value_someone_already_chose_untouched() {
        for chosen in [
            r#"{"updater":{"autoUpdateEnabled":true}}"#,
            r#"{ "updater": { "autoUpdateEnabled": false } }"#,
        ] {
            let home = TempDir::new().unwrap();
            write(&home, chosen);

            turn_off_automatic_updates_when_unset(home.path())
                .await
                .unwrap();

            assert_eq!(contents(&home), chosen, "the file must stay byte for byte");
        }
    }

    #[tokio::test]
    async fn refuses_to_rewrite_a_file_it_cannot_read_as_settings() {
        for unreadable in ["{not json", "[]", r#"{"updater":true}"#] {
            let home = TempDir::new().unwrap();
            write(&home, unreadable);

            let problem = turn_off_automatic_updates_when_unset(home.path())
                .await
                .unwrap_err();

            assert!(problem.contains("settings.json"), "{problem}");
            assert_eq!(
                contents(&home),
                unreadable,
                "the file must stay byte for byte"
            );
        }
    }

    #[tokio::test]
    async fn a_settings_file_that_cannot_be_read_is_an_error_not_codex_default() {
        let home = TempDir::new().unwrap();
        std::fs::create_dir_all(home.path().join(SETTINGS_FILE)).unwrap();

        let writing = turn_off_automatic_updates_when_unset(home.path())
            .await
            .unwrap_err();
        let reading = automatic_updates(home.path()).await.unwrap_err();

        assert!(writing.starts_with("Failed to read"), "{writing}");
        assert!(reading.starts_with("Failed to read"), "{reading}");
        assert!(home.path().join(SETTINGS_FILE).is_dir());
    }

    #[tokio::test]
    async fn a_replacement_that_cannot_be_written_leaves_the_settings_as_they_were() {
        let home = TempDir::new().unwrap();
        write(&home, r#"{"remoteControlEnabled":true}"#);
        std::fs::create_dir(home.path().join(format!(
            "app-server-daemon/settings.json.caffold-{}.tmp",
            process::id()
        )))
        .unwrap();

        let problem = turn_off_automatic_updates_when_unset(home.path())
            .await
            .unwrap_err();

        assert!(problem.starts_with("Failed to write"), "{problem}");
        assert_eq!(contents(&home), r#"{"remoteControlEnabled":true}"#);
    }

    #[tokio::test]
    async fn reads_the_updater_the_way_codex_does() {
        let home = TempDir::new().unwrap();
        assert_eq!(
            automatic_updates(home.path()).await,
            Ok(AutomaticUpdates::Enabled),
            "a missing file leaves Codex's default"
        );

        for (file, expected) in [
            ("{}", AutomaticUpdates::Enabled),
            (r#"{"updater":{}}"#, AutomaticUpdates::Enabled),
            (
                r#"{"updater":{"autoUpdateEnabled":true}}"#,
                AutomaticUpdates::Enabled,
            ),
            (
                r#"{"updater":{"autoUpdateEnabled":false}}"#,
                AutomaticUpdates::Disabled,
            ),
        ] {
            write(&home, file);
            assert_eq!(automatic_updates(home.path()).await, Ok(expected), "{file}");
        }

        for file in [
            "{not json",
            r#"{"updater":[]}"#,
            r#"{"updater":{"autoUpdateEnabled":"no"}}"#,
        ] {
            write(&home, file);
            assert!(automatic_updates(home.path()).await.is_err(), "{file}");
        }
    }

    #[test]
    fn finds_the_codex_home_where_codex_does() {
        let home = Some(OsStr::new("/Users/example"));

        assert_eq!(
            codex_home_from(Some(OsStr::new("/srv/codex")), home),
            Some(PathBuf::from("/srv/codex"))
        );
        assert_eq!(
            codex_home_from(Some(OsStr::new("")), home),
            Some(PathBuf::from("/Users/example/.codex"))
        );
        assert_eq!(
            codex_home_from(None, home),
            Some(PathBuf::from("/Users/example/.codex"))
        );
        assert_eq!(codex_home_from(None, None), None);
    }

    fn write(home: &TempDir, contents: &str) {
        let path = home.path().join(SETTINGS_FILE);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn contents(home: &TempDir) -> String {
        std::fs::read_to_string(home.path().join(SETTINGS_FILE)).unwrap()
    }

    fn settings(home: &TempDir) -> Value {
        serde_json::from_str(&contents(home)).unwrap()
    }

    fn entries(home: &TempDir) -> Vec<String> {
        let mut names = std::fs::read_dir(home.path().join("app-server-daemon"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        names.sort();
        names
    }
}
