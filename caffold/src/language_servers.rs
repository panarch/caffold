//! Language servers that tell the code viewers where a name is defined and
//! where it is used.
//!
//! Caffold finds the server a language needs (it never installs one) and
//! runs it for a repository only after the person turns the repository on.
//! Servers sleep once no screen has shown their repository for a while, and
//! start again when one does. Answers are places in files, given back as
//! Caffold's logical paths when they lie inside the browsing root.

mod connection;
mod discovery;
mod languages;
mod memory;
mod settings;
mod supervisor;

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
};

use thiserror::Error;

use crate::{
    fs::{FsError, RootedFs},
    git,
    watch::{WatchError, WatchHub},
};
use connection::{Document, Target};
use settings::SettingsFile;
use supervisor::{Finder, SLEEP_AFTER, Supervisor};

#[cfg(test)]
pub(crate) use discovery::MissingServer;
pub(crate) use languages::Language;
pub(crate) use supervisor::{Failure, RepositoryView, ServerState, ServerView};

/// The longest line text a place carries.
const PLACE_TEXT_LIMIT: usize = 400;

#[derive(Clone)]
pub(crate) struct LanguageServers {
    supervisor: Supervisor,
    fs: Arc<RootedFs>,
    watch: WatchHub,
}

/// A language as Settings shows it: on or off. Whether its server is there
/// depends on each repository, which its own status answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LanguageSetting {
    pub(crate) language: Language,
    pub(crate) enabled: bool,
}

/// A running or sleeping server with the memory its process holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerUsage {
    pub(crate) server: ServerView,
    pub(crate) memory_bytes: Option<u64>,
    /// The branch checked out in the server's repository, which names a
    /// Caffold worktree better than its folder does.
    pub(crate) branch: Option<String>,
}

/// A repository's switch and servers, each with its memory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RepositoryUsage {
    pub(crate) path: String,
    pub(crate) enabled: bool,
    pub(crate) servers: Vec<ServerUsage>,
}

/// A place a server answered with. `path` is the logical path, or `None` for
/// a file outside the browsing root, which only `name` describes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Place {
    pub(crate) path: Option<String>,
    pub(crate) name: String,
    /// One-based, like the viewers' line numbers.
    pub(crate) line: u32,
    /// Zero-based, in UTF-16 code units.
    pub(crate) character: u32,
    /// The name's length in UTF-16 code units, when it ends on its line.
    pub(crate) length: Option<u32>,
    /// The line's text, for a place inside the browsing root.
    pub(crate) text: Option<String>,
}

#[derive(Debug, Error)]
pub(crate) enum LanguageServerError {
    #[error(transparent)]
    Fs(#[from] FsError),
    #[error(transparent)]
    Watch(#[from] WatchError),
    #[error("No language server reads this kind of file.")]
    UnsupportedFile,
    #[error("The file is not text.")]
    NotText,
    #[error("The language server is not ready.")]
    NotReady(ServerState),
    #[error("{0}")]
    Settings(String),
    #[error("{0}")]
    Request(String),
}

impl LanguageServers {
    pub(crate) fn open(data_dir: &Path, fs: Arc<RootedFs>, watch: WatchHub) -> Self {
        Self::with_finder(data_dir, fs, watch, Finder::Installed)
    }

    /// Language servers whose every server is the checked-in fake one.
    #[cfg(test)]
    pub(crate) fn with_fake_server(data_dir: &Path, fs: Arc<RootedFs>, watch: WatchHub) -> Self {
        let fake = Finder::Fixed(discovery::Discovery::Found(connection::fake_server(
            "status",
        )));
        Self::with_finder(data_dir, fs, watch, fake)
    }

    fn with_finder(data_dir: &Path, fs: Arc<RootedFs>, watch: WatchHub, finder: Finder) -> Self {
        let supervisor = Supervisor::spawn(
            fs.clone(),
            SettingsFile::new(data_dir.join("language-servers")),
            watch.open_scopes(),
            SLEEP_AFTER,
            finder,
        );
        Self {
            supervisor,
            fs,
            watch,
        }
    }

    pub(crate) async fn languages(&self) -> Result<Vec<LanguageSetting>, LanguageServerError> {
        let settings = self
            .supervisor
            .settings()
            .await
            .map_err(LanguageServerError::Settings)?;
        Ok(Language::ALL
            .into_iter()
            .map(|language| LanguageSetting {
                language,
                enabled: settings.languages.contains(&language),
            })
            .collect())
    }

    pub(crate) async fn set_languages(
        &self,
        languages: BTreeSet<Language>,
    ) -> Result<Vec<LanguageSetting>, LanguageServerError> {
        self.supervisor
            .set_languages(languages)
            .await
            .map_err(LanguageServerError::Settings)?;
        self.languages().await
    }

    /// Every server of every turned-on repository.
    pub(crate) async fn servers(&self) -> Vec<ServerUsage> {
        with_usage(self.fs.clone(), self.supervisor.servers().await).await
    }

    /// The switch and servers of the repository holding `path`: its Git
    /// repository's root, or the folder itself outside Git.
    pub(crate) async fn repository(
        &self,
        path: &str,
    ) -> Result<RepositoryUsage, LanguageServerError> {
        let repository = self.watch.scope_path_for(path).await?;
        let view = self
            .supervisor
            .repository(repository)
            .await
            .map_err(LanguageServerError::Settings)?;
        Ok(self.repository_usage(view).await)
    }

    /// The repository holding `path` after its failed servers were looked
    /// for again, each one found starting, as when a screen shows it.
    pub(crate) async fn recheck_repository(
        &self,
        path: &str,
    ) -> Result<RepositoryUsage, LanguageServerError> {
        let repository = self.watch.scope_path_for(path).await?;
        let view = self
            .supervisor
            .recheck(repository)
            .await
            .map_err(LanguageServerError::Settings)?;
        Ok(self.repository_usage(view).await)
    }

    pub(crate) async fn set_repository(
        &self,
        path: &str,
        enabled: bool,
    ) -> Result<RepositoryUsage, LanguageServerError> {
        let repository = self.watch.scope_path_for(path).await?;
        let view = self
            .supervisor
            .set_repository(repository, enabled)
            .await
            .map_err(LanguageServerError::Settings)?;
        Ok(self.repository_usage(view).await)
    }

    /// Where the name at `line` (one-based) and `character` (UTF-16) of the
    /// file at logical `path` is defined, each with its line's text.
    pub(crate) async fn definition(
        &self,
        path: &str,
        line: u32,
        character: u32,
    ) -> Result<Vec<Place>, LanguageServerError> {
        let (connection, document) = self.ready_for(path).await?;
        let targets = connection
            .definition(document, line.saturating_sub(1), character)
            .await
            .map_err(LanguageServerError::Request)?;
        Ok(places(&self.fs, targets).await)
    }

    /// Where the name at `line` (one-based) and `character` (UTF-16) of the
    /// file at logical `path` is used, each with its line's text.
    pub(crate) async fn references(
        &self,
        path: &str,
        line: u32,
        character: u32,
    ) -> Result<Vec<Place>, LanguageServerError> {
        let (connection, document) = self.ready_for(path).await?;
        let targets = connection
            .references(document, line.saturating_sub(1), character)
            .await
            .map_err(LanguageServerError::Request)?;
        Ok(places(&self.fs, targets).await)
    }

    pub(crate) async fn shutdown(&self) {
        self.supervisor.shutdown().await;
    }

    /// The ready server for the file and the file as it is on disk, which is
    /// what the viewer shows of the working tree.
    async fn ready_for(
        &self,
        path: &str,
    ) -> Result<(Arc<connection::Connection>, Document), LanguageServerError> {
        let absolute = self.file_path(path)?;
        let (language, language_id) =
            Language::for_file(&absolute).ok_or(LanguageServerError::UnsupportedFile)?;
        let folder = path.rsplit_once('/').map_or("", |(folder, _)| folder);
        let repository = self.watch.scope_path_for(folder).await?;
        let connection = self
            .supervisor
            .connection(repository, language)
            .await
            .map_err(LanguageServerError::NotReady)?;
        let text = tokio::fs::read_to_string(&absolute)
            .await
            .map_err(|_| LanguageServerError::NotText)?;
        Ok((
            connection,
            Document {
                path: absolute,
                language_id,
                text,
            },
        ))
    }

    /// The canonical absolute path of the file at logical `path`, kept inside
    /// the browsing root the way the file system owner keeps every path.
    fn file_path(&self, path: &str) -> Result<PathBuf, LanguageServerError> {
        let (folder, name) = path.rsplit_once('/').unwrap_or(("", path));
        let candidate = self.fs.absolute_directory_path(folder)?.join(name);
        if !candidate.exists() {
            return Err(FsError::NotFound {
                path: path.to_string(),
            }
            .into());
        }
        self.fs.logical_path_for_absolute(&candidate)?;
        let absolute = candidate.canonicalize().map_err(|_| FsError::NotFound {
            path: path.to_string(),
        })?;
        if !absolute.is_file() {
            return Err(FsError::NotFile {
                path: path.to_string(),
            }
            .into());
        }
        Ok(absolute)
    }
}

/// The server's places as the browser reads them: a logical path and the
/// line's text inside the browsing root, only the file name outside it.
async fn places(fs: &RootedFs, targets: Vec<Target>) -> Vec<Place> {
    let mut texts: BTreeMap<PathBuf, Option<Vec<String>>> = BTreeMap::new();
    let mut places = Vec::with_capacity(targets.len());
    for target in targets {
        let name = target
            .path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let path = fs.logical_path_for_absolute(&target.path).ok();
        let text = match &path {
            Some(_) => {
                if !texts.contains_key(&target.path) {
                    let lines = tokio::fs::read_to_string(&target.path)
                        .await
                        .ok()
                        .map(|text| text.lines().map(str::to_string).collect());
                    texts.insert(target.path.clone(), lines);
                }
                texts[&target.path]
                    .as_ref()
                    .and_then(|lines| lines.get(target.line as usize))
                    .map(|line| line.trim_end().chars().take(PLACE_TEXT_LIMIT).collect())
            }
            None => None,
        };
        places.push(Place {
            path,
            name,
            line: target.line + 1,
            character: target.character,
            length: target.length,
            text,
        });
    }
    places
}

impl LanguageServers {
    async fn repository_usage(&self, view: RepositoryView) -> RepositoryUsage {
        RepositoryUsage {
            path: view.path,
            enabled: view.enabled,
            servers: with_usage(self.fs.clone(), view.servers).await,
        }
    }
}

/// Each server with its process's memory and its repository's branch, read
/// on the blocking pool since both run or read outside the process.
async fn with_usage(fs: Arc<RootedFs>, servers: Vec<ServerView>) -> Vec<ServerUsage> {
    tokio::task::spawn_blocking(move || {
        let mut branches: BTreeMap<String, Option<String>> = BTreeMap::new();
        servers
            .into_iter()
            .map(|server| {
                let branch = branches
                    .entry(server.repository.clone())
                    .or_insert_with(|| {
                        fs.absolute_directory_path(&server.repository)
                            .ok()
                            .and_then(|root| git::repository_for(&root))
                            .and_then(|repository| repository.branch)
                    })
                    .clone();
                ServerUsage {
                    memory_bytes: server.pid.and_then(memory::resident_bytes),
                    branch,
                    server,
                }
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    fn target(path: PathBuf, line: u32, character: u32, length: Option<u32>) -> Target {
        Target {
            path,
            line,
            character,
            length,
        }
    }

    #[tokio::test]
    async fn places_inside_the_root_carry_a_logical_path_and_their_line() {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("repo/src")).unwrap();
        fs::write(
            root.path().join("repo/src/lib.rs"),
            "pub fn helper() {}\n\tlet value = helper();   \n",
        )
        .unwrap();
        let rooted = RootedFs::new(root.path()).unwrap();
        let file = root.path().join("repo/src/lib.rs").canonicalize().unwrap();

        let answered = places(
            &rooted,
            vec![
                target(file.clone(), 1, 13, Some(6)),
                target(file, 9, 0, None),
            ],
        )
        .await;

        assert_eq!(
            answered,
            vec![
                Place {
                    path: Some("repo/src/lib.rs".to_string()),
                    name: "lib.rs".to_string(),
                    line: 2,
                    character: 13,
                    length: Some(6),
                    text: Some("\tlet value = helper();".to_string()),
                },
                Place {
                    path: Some("repo/src/lib.rs".to_string()),
                    name: "lib.rs".to_string(),
                    line: 10,
                    character: 0,
                    length: None,
                    text: None,
                },
            ]
        );
    }

    #[tokio::test]
    async fn places_outside_the_root_carry_only_their_file_name() {
        let root = TempDir::new().unwrap();
        let elsewhere = TempDir::new().unwrap();
        fs::write(elsewhere.path().join("time.rs"), "pub struct Duration;\n").unwrap();
        let rooted = RootedFs::new(root.path()).unwrap();

        let answered = places(
            &rooted,
            vec![target(
                elsewhere.path().join("time.rs").canonicalize().unwrap(),
                0,
                11,
                Some(8),
            )],
        )
        .await;

        assert_eq!(
            answered,
            vec![Place {
                path: None,
                name: "time.rs".to_string(),
                line: 1,
                character: 11,
                length: Some(8),
                text: None,
            }]
        );
    }
}
