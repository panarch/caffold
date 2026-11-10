use std::{
    fs,
    path::{Path, PathBuf},
    sync::RwLock,
};

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;

const DEFAULT_SERVER_NAME: &str = "Caffold";
const MAX_SERVER_NAME_CHARS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct ServerSettings {
    pub name: String,
    #[serde(default)]
    pub icon: ServerIcon,
}

impl Default for ServerSettings {
    fn default() -> Self {
        Self {
            name: DEFAULT_SERVER_NAME.to_string(),
            icon: ServerIcon::Default,
        }
    }
}

/// The icons a server can show, in the order Settings offers them. Default is
/// Caffold's gray meerkat, and every other icon is that meerkat in one color.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ServerIcon {
    #[default]
    Default,
    Red,
    Orange,
    Gold,
    Lime,
    Green,
    Teal,
    Sky,
    Blue,
    Violet,
    Purple,
    Pink,
}

impl ServerIcon {
    pub(crate) const ALL: [Self; 12] = [
        Self::Default,
        Self::Red,
        Self::Orange,
        Self::Gold,
        Self::Lime,
        Self::Green,
        Self::Teal,
        Self::Sky,
        Self::Blue,
        Self::Violet,
        Self::Purple,
        Self::Pink,
    ];

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Red => "red",
            Self::Orange => "orange",
            Self::Gold => "gold",
            Self::Lime => "lime",
            Self::Green => "green",
            Self::Teal => "teal",
            Self::Sky => "sky",
            Self::Blue => "blue",
            Self::Violet => "violet",
            Self::Purple => "purple",
            Self::Pink => "pink",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Default => "Default",
            Self::Red => "Red",
            Self::Orange => "Orange",
            Self::Gold => "Gold",
            Self::Lime => "Lime",
            Self::Green => "Green",
            Self::Teal => "Teal",
            Self::Sky => "Sky",
            Self::Blue => "Blue",
            Self::Violet => "Violet",
            Self::Purple => "Purple",
            Self::Pink => "Pink",
        }
    }

    pub(crate) fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|icon| icon.id() == id)
    }
}

impl Serialize for ServerIcon {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.id())
    }
}

// An icon this build does not know, such as one a newer release saved before
// an update was rolled back, shows as Default rather than keeping the server
// from starting.
impl<'de> Deserialize<'de> for ServerIcon {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let id = String::deserialize(deserializer)?;
        Ok(Self::from_id(&id).unwrap_or_default())
    }
}

pub(crate) struct ServerSettingsStore {
    settings: RwLock<ServerSettings>,
    path: Option<PathBuf>,
}

impl ServerSettingsStore {
    pub(crate) fn memory() -> Self {
        Self {
            settings: RwLock::new(ServerSettings::default()),
            path: None,
        }
    }

    pub(crate) fn persistent(path: PathBuf) -> Result<Self, ServerSettingsError> {
        let settings = load_settings(&path)?;
        Ok(Self {
            settings: RwLock::new(settings),
            path: Some(path),
        })
    }

    pub(crate) fn get(&self) -> ServerSettings {
        self.settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Changes the fields given and keeps the rest. Nothing is saved unless
    /// every given field is valid.
    pub(crate) fn update(
        &self,
        name: Option<&str>,
        icon: Option<&str>,
    ) -> Result<ServerSettings, ServerSettingsError> {
        let mut settings = self
            .settings
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut next = settings.clone();
        if let Some(name) = name {
            next.name = validate_name(name)?;
        }
        if let Some(icon) = icon {
            next.icon = ServerIcon::from_id(icon).ok_or(ServerSettingsError::UnknownIcon)?;
        }
        if next != *settings {
            if let Some(path) = &self.path {
                persist_settings(path, &next)?;
            }
            *settings = next;
        }
        Ok(settings.clone())
    }
}

#[derive(Debug, Error)]
pub(crate) enum ServerSettingsError {
    #[error("server name cannot be empty")]
    EmptyName,
    #[error("server name cannot exceed {MAX_SERVER_NAME_CHARS} characters")]
    NameTooLong,
    #[error("server icon is not one Caffold offers")]
    UnknownIcon,
    #[error("failed to read server settings: {0}")]
    Read(#[source] std::io::Error),
    #[error("failed to parse server settings: {0}")]
    Parse(#[source] serde_json::Error),
    #[error("failed to write server settings: {0}")]
    Write(#[source] std::io::Error),
    #[error("failed to encode server settings: {0}")]
    Encode(#[source] serde_json::Error),
}

fn validate_name(name: &str) -> Result<String, ServerSettingsError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ServerSettingsError::EmptyName);
    }
    if name.chars().count() > MAX_SERVER_NAME_CHARS {
        return Err(ServerSettingsError::NameTooLong);
    }
    Ok(name.to_string())
}

fn load_settings(path: &Path) -> Result<ServerSettings, ServerSettingsError> {
    if !path.exists() {
        return Ok(ServerSettings::default());
    }
    let body = fs::read(path).map_err(ServerSettingsError::Read)?;
    serde_json::from_slice(&body).map_err(ServerSettingsError::Parse)
}

fn persist_settings(path: &Path, settings: &ServerSettings) -> Result<(), ServerSettingsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(ServerSettingsError::Write)?;
    }
    let body = serde_json::to_vec_pretty(settings).map_err(ServerSettingsError::Encode)?;
    let temporary_path = path.with_extension("json.tmp");
    fs::write(&temporary_path, body).map_err(ServerSettingsError::Write)?;
    fs::rename(&temporary_path, path).map_err(ServerSettingsError::Write)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_store_trims_and_updates_the_name() {
        let store = ServerSettingsStore::memory();

        assert_eq!(store.get().name, "Caffold");
        assert_eq!(
            store.update(Some("  Caffold Studio  "), None).unwrap().name,
            "Caffold Studio"
        );
        assert_eq!(store.get().name, "Caffold Studio");
    }

    #[test]
    fn rejects_empty_and_oversized_names() {
        let store = ServerSettingsStore::memory();

        assert!(matches!(
            store.update(Some("   "), None),
            Err(ServerSettingsError::EmptyName)
        ));
        assert!(matches!(
            store.update(Some(&"a".repeat(MAX_SERVER_NAME_CHARS + 1)), None),
            Err(ServerSettingsError::NameTooLong)
        ));
    }

    #[test]
    fn each_field_changes_without_the_other() {
        let store = ServerSettingsStore::memory();

        let blue = store.update(None, Some("blue")).unwrap();
        assert_eq!(blue.name, "Caffold");
        assert_eq!(blue.icon, ServerIcon::Blue);

        let renamed = store.update(Some("Caffold Linux"), None).unwrap();
        assert_eq!(renamed.name, "Caffold Linux");
        assert_eq!(renamed.icon, ServerIcon::Blue);
    }

    #[test]
    fn a_request_with_one_invalid_field_saves_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("server.json");
        let store = ServerSettingsStore::persistent(path.clone()).unwrap();
        store.update(Some("Caffold Studio"), Some("teal")).unwrap();
        let saved = fs::read(&path).unwrap();

        assert!(matches!(
            store.update(Some("Caffold Linux"), Some("chartreuse")),
            Err(ServerSettingsError::UnknownIcon)
        ));
        assert!(matches!(
            store.update(Some(" "), Some("pink")),
            Err(ServerSettingsError::EmptyName)
        ));

        assert_eq!(store.get().name, "Caffold Studio");
        assert_eq!(store.get().icon, ServerIcon::Teal);
        assert_eq!(fs::read(&path).unwrap(), saved);
    }

    #[test]
    fn a_request_that_changes_nothing_writes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("server.json");
        let store = ServerSettingsStore::persistent(path.clone()).unwrap();

        assert_eq!(store.update(None, None).unwrap(), ServerSettings::default());
        assert_eq!(
            store.update(Some("Caffold"), Some("default")).unwrap(),
            ServerSettings::default()
        );
        assert!(!path.exists());
    }

    #[test]
    fn persistent_store_restores_the_saved_name_and_icon() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("server.json");
        let store = ServerSettingsStore::persistent(path.clone()).unwrap();
        store
            .update(Some("Caffold MacBook"), Some("violet"))
            .unwrap();

        let restored = ServerSettingsStore::persistent(path).unwrap();
        assert_eq!(restored.get().name, "Caffold MacBook");
        assert_eq!(restored.get().icon, ServerIcon::Violet);
    }

    #[test]
    fn a_file_without_a_known_icon_shows_default() {
        let temp = tempfile::tempdir().unwrap();
        for (file, body) in [
            ("before-icons.json", r#"{"name":"Caffold Studio"}"#),
            (
                "from-a-newer-release.json",
                r#"{"name":"Caffold Studio","icon":"chartreuse"}"#,
            ),
        ] {
            let path = temp.path().join(file);
            fs::write(&path, body).unwrap();

            let store = ServerSettingsStore::persistent(path).unwrap();
            assert_eq!(store.get().name, "Caffold Studio", "{file}");
            assert_eq!(store.get().icon, ServerIcon::Default, "{file}");
        }
    }

    #[test]
    fn icons_are_offered_in_settings_order_by_their_ids() {
        let ids: Vec<_> = ServerIcon::ALL.into_iter().map(ServerIcon::id).collect();

        assert_eq!(
            ids,
            [
                "default", "red", "orange", "gold", "lime", "green", "teal", "sky", "blue",
                "violet", "purple", "pink"
            ]
        );
        for icon in ServerIcon::ALL {
            assert_eq!(ServerIcon::from_id(icon.id()), Some(icon));
            assert_eq!(serde_json::to_value(icon).unwrap(), icon.id());
        }
        assert_eq!(ServerIcon::from_id("Red"), None);
    }
}
