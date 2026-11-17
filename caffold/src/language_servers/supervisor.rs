//! The language servers running for each repository and the one place their
//! lifecycles change.
//!
//! A person turns language servers on for a repository (a repository's root,
//! or a folder outside Git) and for each language in Settings. Every server
//! of a turned-on repository and language then lives through these nodes; a
//! server that is off has no entry at all:
//!
//! - `Starting`: found and started, or being found; it is indexing.
//! - `Ready`: it answers definition and reference questions.
//! - `Sleeping`: no screen has shown the repository for the sleep time, so
//!   its process was ended. Showing the repository again starts it.
//! - `Failed`: it could not be found or started, or it exited. A screen
//!   that shows the repository asks for it to be found again, since the
//!   person may have installed it meanwhile; until then it stays so.
//!
//! Allowed edges, each through [`next`]:
//!
//! - off → `Starting` when the repository is turned on, or a language is
//!   turned on while a screen shows the repository; off → `Sleeping` for a
//!   language turned on while none does, and for every server after Caffold
//!   starts.
//! - `Starting` → `Starting` on `Started` for a server whose readiness comes
//!   later, on `Progress`, and on `Quiescent(false)`.
//! - `Starting` → `Ready` on `Started` for a server ready once initialized,
//!   and on `Quiescent(true)`.
//! - `Ready` → `Ready` on `Progress` and `Quiescent`.
//! - `Starting` → `Failed` on `StartFailed` and `Exited`; `Ready` →
//!   `Failed` on `Exited`.
//! - `Starting` and `Ready` → `Sleeping` on `SleepTimeElapsed`.
//! - `Sleeping` → `Starting` on `ScopeOpened`.
//! - `Failed` → `Starting` on `Rechecked` that found the server, and
//!   `Failed` → `Failed` on one that did not, with what the finding said.
//! - every node → off when the repository or language is turned off, or the
//!   repository's folder is gone once its screens close.
//!
//! Everything else is refused, and so is any event from a process older
//! than the server's current one.
//!
//! What screens show is the open scopes of the file watcher: a repository
//! counts as shown while a scope at or beneath its folder is open. That is
//! orthogonal to each server's node; it decides only when the sleep timer
//! runs.
//!
//! Finding a failed server again runs outside this task and comes back as
//! one `Rechecked` per server, for the process generation it began with. The
//! screen that asked is answered only then, so the answer says whether the
//! server was found rather than showing it starting for a moment.

use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use tokio::sync::{mpsc, oneshot, watch};
use tracing::{info, warn};

use super::{
    Language,
    connection::{Connection, Notice},
    discovery::{self, Discovery, FoundServer, MissingServer},
    languages::ReadySignal,
    settings::{Settings, SettingsFile},
};
use crate::fs::RootedFs;

/// How long a repository goes unshown before its servers sleep.
pub(super) const SLEEP_AFTER: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Node {
    Starting,
    Ready,
    Sleeping,
    Failed,
}

enum Event {
    Started(Arc<Connection>),
    Progress(Option<String>),
    Quiescent(bool),
    StartFailed(Failure),
    Exited,
    ScopeOpened,
    SleepTimeElapsed,
    /// The failed server was looked for again: found, or why not.
    Rechecked(Result<FoundServer, Failure>),
}

/// The one transition authority: the node `event` moves `node` to, or
/// `None` when the edge is not allowed.
fn next(node: Node, event: &Event, ready: ReadySignal) -> Option<Node> {
    use Node::*;
    match (node, event) {
        (Starting, Event::Started(_)) => Some(match ready {
            ReadySignal::Initialized => Ready,
            ReadySignal::Quiescent => Starting,
        }),
        (Starting, Event::Progress(_) | Event::Quiescent(false)) => Some(Starting),
        (Starting, Event::Quiescent(true)) => Some(Ready),
        (Ready, Event::Progress(_) | Event::Quiescent(_)) => Some(Ready),
        (Starting, Event::StartFailed(_) | Event::Exited) | (Ready, Event::Exited) => Some(Failed),
        (Starting | Ready, Event::SleepTimeElapsed) => Some(Sleeping),
        (Sleeping, Event::ScopeOpened) => Some(Starting),
        (Failed, Event::Rechecked(Ok(_))) => Some(Starting),
        (Failed, Event::Rechecked(Err(_))) => Some(Failed),
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Failure {
    /// The project has no server; installing one on the host is the way on.
    NotInstalled(MissingServer),
    /// A server is there but did not start, with what it said.
    CouldNotStart { reason: String },
    /// It started and then exited. Its output is not kept, so there is
    /// nothing it said to pass on.
    Stopped,
}

/// One server as the screens see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ServerState {
    Off,
    Starting { progress: Option<String> },
    Ready,
    Sleeping,
    Failed(Failure),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ServerView {
    pub(crate) repository: String,
    pub(crate) language: Language,
    pub(crate) state: ServerState,
    pub(crate) pid: Option<u32>,
}

/// A repository's switch and its languages' servers. A language is listed
/// when it is turned on in Settings and the repository holds its project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RepositoryView {
    pub(crate) path: String,
    pub(crate) enabled: bool,
    pub(crate) servers: Vec<ServerView>,
}

/// Where a server for a starting language comes from.
#[derive(Clone)]
pub(super) enum Finder {
    Installed,
    #[cfg(test)]
    Fixed(Discovery),
    /// What a test sets, as when a server is installed meanwhile.
    #[cfg(test)]
    Changing(Arc<std::sync::Mutex<Discovery>>),
}

impl Finder {
    /// The server to start, or the failure that keeps it from starting.
    async fn find(&self, language: Language, root: &Path) -> Result<FoundServer, Failure> {
        let discovery = match self {
            Finder::Installed => discovery::find_server(language, root).await,
            #[cfg(test)]
            Finder::Fixed(discovery) => discovery.clone(),
            #[cfg(test)]
            Finder::Changing(discovery) => discovery.lock().unwrap().clone(),
        };
        match discovery {
            Discovery::Found(found) => Ok(found),
            Discovery::NotInstalled(missing) => Err(Failure::NotInstalled(missing)),
            Discovery::CouldNotStart { reason } => Err(Failure::CouldNotStart { reason }),
        }
    }
}

/// The handle every caller holds; the servers themselves live in one task
/// that takes these questions and events in order.
#[derive(Clone)]
pub(super) struct Supervisor {
    messages: mpsc::UnboundedSender<Message>,
}

enum Message {
    Settings(oneshot::Sender<Result<Settings, String>>),
    SetLanguages(BTreeSet<Language>, oneshot::Sender<Result<(), String>>),
    Repository(String, oneshot::Sender<Result<RepositoryView, String>>),
    SetRepository {
        path: String,
        enabled: bool,
        reply: oneshot::Sender<Result<RepositoryView, String>>,
    },
    Recheck(String, oneshot::Sender<Result<RepositoryView, String>>),
    Rechecked {
        path: String,
        found: Vec<(Language, u64, Result<FoundServer, Failure>)>,
        reply: oneshot::Sender<Result<RepositoryView, String>>,
    },
    Servers(oneshot::Sender<Vec<ServerView>>),
    Connection {
        repository: String,
        language: Language,
        reply: oneshot::Sender<Result<Arc<Connection>, ServerState>>,
    },
    Scopes(BTreeSet<String>),
    Process {
        repository: String,
        language: Language,
        generation: u64,
        event: Event,
    },
    SleepTime {
        repository: String,
        timer: u64,
    },
    Shutdown(oneshot::Sender<()>),
}

impl Supervisor {
    pub(super) fn spawn(
        fs: Arc<RootedFs>,
        file: SettingsFile,
        mut scopes: watch::Receiver<BTreeSet<String>>,
        sleep_after: Duration,
        finder: Finder,
    ) -> Self {
        let (messages, inbox) = mpsc::unbounded_channel();
        let state = State::open(fs, file, sleep_after, finder, messages.clone());
        tokio::spawn(state.run(inbox));
        let forward = messages.clone();
        tokio::spawn(async move {
            loop {
                let open = scopes.borrow_and_update().clone();
                if forward.send(Message::Scopes(open)).is_err() || scopes.changed().await.is_err() {
                    break;
                }
            }
        });
        Self { messages }
    }

    pub(super) async fn settings(&self) -> Result<Settings, String> {
        self.ask(Message::Settings)
            .await
            .unwrap_or_else(|| Err(stopped()))
    }

    pub(super) async fn set_languages(&self, languages: BTreeSet<Language>) -> Result<(), String> {
        self.ask(|reply| Message::SetLanguages(languages, reply))
            .await
            .unwrap_or_else(|| Err(stopped()))
    }

    pub(super) async fn repository(&self, path: String) -> Result<RepositoryView, String> {
        self.ask(|reply| Message::Repository(path, reply))
            .await
            .unwrap_or_else(|| Err(stopped()))
    }

    pub(super) async fn set_repository(
        &self,
        path: String,
        enabled: bool,
    ) -> Result<RepositoryView, String> {
        self.ask(|reply| Message::SetRepository {
            path,
            enabled,
            reply,
        })
        .await
        .unwrap_or_else(|| Err(stopped()))
    }

    /// Looks again for the repository's failed servers and starts each one
    /// found, then answers the repository as that leaves it.
    pub(super) async fn recheck(&self, path: String) -> Result<RepositoryView, String> {
        self.ask(|reply| Message::Recheck(path, reply))
            .await
            .unwrap_or_else(|| Err(stopped()))
    }

    pub(super) async fn servers(&self) -> Vec<ServerView> {
        self.ask(Message::Servers).await.unwrap_or_default()
    }

    /// The ready server's connection, or the state that keeps it from
    /// answering.
    pub(super) async fn connection(
        &self,
        repository: String,
        language: Language,
    ) -> Result<Arc<Connection>, ServerState> {
        self.ask(|reply| Message::Connection {
            repository,
            language,
            reply,
        })
        .await
        .unwrap_or(Err(ServerState::Off))
    }

    /// Ends every server and waits for them to exit.
    pub(super) async fn shutdown(&self) {
        self.ask(Message::Shutdown).await;
    }

    async fn ask<T>(&self, message: impl FnOnce(oneshot::Sender<T>) -> Message) -> Option<T> {
        let (reply, answer) = oneshot::channel();
        self.messages.send(message(reply)).ok()?;
        answer.await.ok()
    }
}

fn stopped() -> String {
    "Language servers have stopped.".to_string()
}

struct State {
    fs: Arc<RootedFs>,
    file: SettingsFile,
    settings: Result<Settings, String>,
    repositories: BTreeMap<String, Repository>,
    open_scopes: BTreeSet<String>,
    sleep_after: Duration,
    finder: Finder,
    messages: mpsc::UnboundedSender<Message>,
}

struct Repository {
    root: PathBuf,
    shown: bool,
    /// The current sleep timer; an elapsed timer counts only while it is
    /// still this one.
    timer: u64,
    servers: BTreeMap<Language, Server>,
}

struct Server {
    node: Node,
    /// The current process; events from an older one are stale.
    generation: u64,
    connection: Option<Arc<Connection>>,
    progress: Option<String>,
    failure: Option<Failure>,
}

impl State {
    /// Every repository saved as turned on starts asleep: Caffold just
    /// started, and showing it wakes it. A saved folder that is gone is
    /// dropped from the settings.
    fn open(
        fs: Arc<RootedFs>,
        file: SettingsFile,
        sleep_after: Duration,
        finder: Finder,
        messages: mpsc::UnboundedSender<Message>,
    ) -> Self {
        let settings = file.read();
        if let Err(error) = &settings {
            warn!("language server settings cannot be read: {error}");
        }
        let mut state = Self {
            fs,
            file,
            settings,
            repositories: BTreeMap::new(),
            open_scopes: BTreeSet::new(),
            sleep_after,
            finder,
            messages,
        };
        let Ok(settings) = state.settings.clone() else {
            return state;
        };
        let mut kept = settings.clone();
        for path in &settings.repositories {
            match state.fs.absolute_directory_path(path) {
                Ok(root) => {
                    let languages: Vec<Language> = settings.languages.iter().copied().collect();
                    let servers = discovery::languages_in(&root, &languages)
                        .into_iter()
                        .map(|language| (language, Server::new(Node::Sleeping)))
                        .collect();
                    state.repositories.insert(
                        path.clone(),
                        Repository {
                            root,
                            shown: false,
                            timer: 0,
                            servers,
                        },
                    );
                }
                Err(error) => {
                    info!("dropping language servers for {path}: {error}");
                    kept.repositories.remove(path);
                }
            }
        }
        if kept != settings {
            state.save(kept);
        }
        state
    }

    async fn run(mut self, mut inbox: mpsc::UnboundedReceiver<Message>) {
        while let Some(message) = inbox.recv().await {
            match message {
                Message::Settings(reply) => {
                    let _ = reply.send(self.settings.clone());
                }
                Message::SetLanguages(languages, reply) => {
                    let _ = reply.send(self.set_languages(languages));
                }
                Message::Repository(path, reply) => {
                    let _ = reply.send(self.repository_view(&path));
                }
                Message::SetRepository {
                    path,
                    enabled,
                    reply,
                } => {
                    let _ = reply.send(self.set_repository(path, enabled));
                }
                Message::Recheck(path, reply) => self.recheck(path, reply),
                Message::Rechecked { path, found, reply } => {
                    let _ = reply.send(self.rechecked(&path, found));
                }
                Message::Servers(reply) => {
                    let _ = reply.send(self.server_views());
                }
                Message::Connection {
                    repository,
                    language,
                    reply,
                } => {
                    let _ = reply.send(self.connection(&repository, language));
                }
                Message::Scopes(open) => self.scopes_changed(open),
                Message::Process {
                    repository,
                    language,
                    generation,
                    event,
                } => {
                    let current = self
                        .server(&repository, language)
                        .is_some_and(|server| server.generation == generation);
                    if current {
                        self.apply(&repository, language, event);
                    }
                }
                Message::SleepTime { repository, timer } => self.sleep_time(&repository, timer),
                Message::Shutdown(reply) => {
                    let stops: Vec<_> = self
                        .repositories
                        .values_mut()
                        .flat_map(|repository| repository.servers.values_mut())
                        .filter_map(|server| server.connection.take())
                        .collect();
                    for connection in stops {
                        connection.stop().await;
                    }
                    let _ = reply.send(());
                    return;
                }
            }
        }
    }

    fn set_languages(&mut self, languages: BTreeSet<Language>) -> Result<(), String> {
        let mut settings = self.settings.clone()?;
        let previous = std::mem::replace(&mut settings.languages, languages.clone());
        self.write(&settings)?;
        self.settings = Ok(settings);
        for language in previous.difference(&languages) {
            for repository in self.repositories.values_mut() {
                if let Some(server) = repository.servers.remove(language) {
                    server.turn_off();
                }
            }
        }
        let added: Vec<Language> = languages.difference(&previous).copied().collect();
        let paths: Vec<String> = self.repositories.keys().cloned().collect();
        for path in paths {
            let repository = &self.repositories[&path];
            let shown = repository.shown;
            for language in discovery::languages_in(&repository.root.clone(), &added) {
                if shown {
                    self.start(&path, language);
                } else {
                    self.repositories
                        .get_mut(&path)
                        .expect("the repository is listed")
                        .servers
                        .insert(language, Server::new(Node::Sleeping));
                }
            }
        }
        Ok(())
    }

    fn set_repository(&mut self, path: String, enabled: bool) -> Result<RepositoryView, String> {
        let mut settings = self.settings.clone()?;
        if enabled == self.repositories.contains_key(&path) {
            return self.repository_view(&path);
        }
        if !enabled {
            self.release(&path);
            return self.repository_view(&path);
        }
        let root = self
            .fs
            .absolute_directory_path(&path)
            .map_err(|error| error.to_string())?;
        settings.repositories.insert(path.clone());
        self.write(&settings)?;
        let languages: Vec<Language> = settings.languages.iter().copied().collect();
        self.settings = Ok(settings);
        let shown = self.open_scopes.iter().any(|scope| covers(&path, scope));
        self.repositories.insert(
            path.clone(),
            Repository {
                root: root.clone(),
                shown,
                timer: 0,
                servers: BTreeMap::new(),
            },
        );
        for language in discovery::languages_in(&root, &languages) {
            self.start(&path, language);
        }
        if !shown {
            self.arm_sleep_timer(&path);
        }
        self.repository_view(&path)
    }

    /// Turns the repository off: its servers end and the settings forget it.
    fn release(&mut self, path: &str) {
        let Some(repository) = self.repositories.remove(path) else {
            return;
        };
        for server in repository.servers.into_values() {
            server.turn_off();
        }
        if let Ok(mut settings) = self.settings.clone()
            && settings.repositories.remove(path)
        {
            self.save(settings);
        }
    }

    /// Looks for every failed server of the repository again, outside this
    /// task; the answer waits for what that found.
    fn recheck(&mut self, path: String, reply: oneshot::Sender<Result<RepositoryView, String>>) {
        let failed: Vec<(Language, u64)> = self
            .repositories
            .get(&path)
            .map(|repository| {
                repository
                    .servers
                    .iter()
                    .filter(|(_, server)| server.node == Node::Failed)
                    .map(|(language, server)| (*language, server.generation))
                    .collect()
            })
            .unwrap_or_default();
        if failed.is_empty() {
            let _ = reply.send(self.repository_view(&path));
            return;
        }
        let root = self.repositories[&path].root.clone();
        let finder = self.finder.clone();
        let messages = self.messages.clone();
        tokio::spawn(async move {
            let mut found = Vec::new();
            for (language, generation) in failed {
                found.push((language, generation, finder.find(language, &root).await));
            }
            let _ = messages.send(Message::Rechecked { path, found, reply });
        });
    }

    /// Applies what looking again found to each server still in the process
    /// generation it was looked for in. A server started here while no
    /// screen shows the repository sleeps after the usual time.
    fn rechecked(
        &mut self,
        path: &str,
        found: Vec<(Language, u64, Result<FoundServer, Failure>)>,
    ) -> Result<RepositoryView, String> {
        let mut started = false;
        for (language, generation, result) in found {
            let current = self.server(path, language).is_some_and(|server| {
                server.generation == generation && server.node == Node::Failed
            });
            if current {
                started |= result.is_ok();
                self.apply(path, language, Event::Rechecked(result));
            }
        }
        if started
            && self
                .repositories
                .get(path)
                .is_some_and(|repository| !repository.shown)
        {
            self.arm_sleep_timer(path);
        }
        self.repository_view(path)
    }

    fn scopes_changed(&mut self, open: BTreeSet<String>) {
        self.open_scopes = open;
        let paths: Vec<String> = self.repositories.keys().cloned().collect();
        for path in paths {
            let shown = self.open_scopes.iter().any(|scope| covers(&path, scope));
            let repository = self
                .repositories
                .get_mut(&path)
                .expect("the path is listed");
            if repository.shown == shown {
                continue;
            }
            repository.shown = shown;
            if shown {
                repository.timer += 1;
                let languages: Vec<Language> = repository.servers.keys().copied().collect();
                for language in languages {
                    self.apply(&path, language, Event::ScopeOpened);
                }
            } else if !repository.root.exists() {
                info!("{path} is gone; its language servers end");
                self.release(&path);
            } else {
                self.arm_sleep_timer(&path);
            }
        }
    }

    fn sleep_time(&mut self, path: &str, timer: u64) {
        let Some(repository) = self.repositories.get(path) else {
            return;
        };
        if repository.timer != timer || repository.shown {
            return;
        }
        let languages: Vec<Language> = repository.servers.keys().copied().collect();
        for language in languages {
            self.apply(path, language, Event::SleepTimeElapsed);
        }
    }

    fn arm_sleep_timer(&mut self, path: &str) {
        let repository = self.repositories.get_mut(path).expect("the path is listed");
        repository.timer += 1;
        let timer = repository.timer;
        let repository = path.to_string();
        let sleep_after = self.sleep_after;
        let messages = self.messages.clone();
        tokio::spawn(async move {
            tokio::time::sleep(sleep_after).await;
            let _ = messages.send(Message::SleepTime { repository, timer });
        });
    }

    /// Creates the server as `Starting` and starts finding and starting it.
    fn start(&mut self, path: &str, language: Language) {
        let repository = self.repositories.get_mut(path).expect("the path is listed");
        repository
            .servers
            .insert(language, Server::new(Node::Starting));
        self.begin_start(path, language, None);
    }

    fn apply(&mut self, path: &str, language: Language, event: Event) {
        let Some(server) = self.server_mut(path, language) else {
            return;
        };
        let Some(node) = next(server.node, &event, language.ready_signal()) else {
            return;
        };
        let previous = server.node;
        let mut found = None;
        match event {
            Event::Started(connection) => server.connection = Some(connection),
            Event::Progress(progress) => server.progress = progress,
            Event::StartFailed(failure) | Event::Rechecked(Err(failure)) => {
                server.failure = Some(failure);
            }
            Event::Exited => {
                server.failure = Some(Failure::Stopped);
            }
            Event::Rechecked(Ok(server_found)) => found = Some(server_found),
            Event::Quiescent(_) | Event::ScopeOpened | Event::SleepTimeElapsed => {}
        }
        server.node = node;
        match (previous, node) {
            (Node::Sleeping, Node::Starting) => self.begin_start(path, language, None),
            (Node::Failed, Node::Starting) => self.begin_start(path, language, found),
            (Node::Starting | Node::Ready, Node::Sleeping | Node::Failed) => {
                let server = self
                    .server_mut(path, language)
                    .expect("the server is listed");
                server.end_process();
            }
            (Node::Starting, Node::Ready) => {
                let server = self
                    .server_mut(path, language)
                    .expect("the server is listed");
                server.progress = None;
            }
            _ => {}
        }
    }

    /// Starts a new process for the server: finding the server unless it was
    /// just found, starting it, then passing on what it reports, all as
    /// events of this generation.
    fn begin_start(&mut self, path: &str, language: Language, found: Option<FoundServer>) {
        let root = self.repositories[path].root.clone();
        let server = self
            .server_mut(path, language)
            .expect("the server is listed");
        server.generation += 1;
        server.progress = None;
        server.failure = None;
        let generation = server.generation;
        let finder = self.finder.clone();
        let report = Reporter {
            messages: self.messages.clone(),
            repository: path.to_string(),
            language,
            generation,
        };
        tokio::spawn(async move {
            let found = match found {
                Some(found) => found,
                None => match finder.find(language, &root).await {
                    Ok(found) => found,
                    Err(failure) => {
                        report.send(Event::StartFailed(failure));
                        return;
                    }
                },
            };
            let (notices, mut reported) = mpsc::unbounded_channel();
            match Connection::start(&found, &root, language, notices).await {
                Ok(connection) => report.send(Event::Started(connection)),
                Err(reason) => {
                    report.send(Event::StartFailed(Failure::CouldNotStart { reason }));
                    return;
                }
            }
            while let Some(notice) = reported.recv().await {
                report.send(match notice {
                    Notice::Progress(progress) => Event::Progress(progress),
                    Notice::Quiescent(quiescent) => Event::Quiescent(quiescent),
                    Notice::Exited => Event::Exited,
                });
            }
        });
    }

    fn connection(&self, path: &str, language: Language) -> Result<Arc<Connection>, ServerState> {
        let server = self.server(path, language).ok_or(ServerState::Off)?;
        match (server.node, &server.connection) {
            (Node::Ready, Some(connection)) => Ok(connection.clone()),
            _ => Err(server.state()),
        }
    }

    fn repository_view(&self, path: &str) -> Result<RepositoryView, String> {
        let settings = self.settings.clone()?;
        if let Some(repository) = self.repositories.get(path) {
            return Ok(RepositoryView {
                path: path.to_string(),
                enabled: true,
                servers: repository
                    .servers
                    .iter()
                    .map(|(language, server)| server.view(path, *language))
                    .collect(),
            });
        }
        let root = self
            .fs
            .absolute_directory_path(path)
            .map_err(|error| error.to_string())?;
        let languages: Vec<Language> = settings.languages.iter().copied().collect();
        Ok(RepositoryView {
            path: path.to_string(),
            enabled: false,
            servers: discovery::languages_in(&root, &languages)
                .into_iter()
                .map(|language| ServerView {
                    repository: path.to_string(),
                    language,
                    state: ServerState::Off,
                    pid: None,
                })
                .collect(),
        })
    }

    fn server_views(&self) -> Vec<ServerView> {
        self.repositories
            .iter()
            .flat_map(|(path, repository)| {
                repository
                    .servers
                    .iter()
                    .map(move |(language, server)| server.view(path, *language))
            })
            .collect()
    }

    fn server(&self, path: &str, language: Language) -> Option<&Server> {
        self.repositories.get(path)?.servers.get(&language)
    }

    fn server_mut(&mut self, path: &str, language: Language) -> Option<&mut Server> {
        self.repositories.get_mut(path)?.servers.get_mut(&language)
    }

    fn write(&self, settings: &Settings) -> Result<(), String> {
        self.file
            .write(settings)
            .map_err(|error| format!("Language server settings could not be saved: {error}"))
    }

    /// Saves settings the person did not ask to change, keeping the change in
    /// memory even when the file cannot be written.
    fn save(&mut self, settings: Settings) {
        if let Err(error) = self.write(&settings) {
            warn!("{error}");
        }
        self.settings = Ok(settings);
    }
}

impl Server {
    fn new(node: Node) -> Self {
        Self {
            node,
            generation: 0,
            connection: None,
            progress: None,
            failure: None,
        }
    }

    fn state(&self) -> ServerState {
        match self.node {
            Node::Starting => ServerState::Starting {
                progress: self.progress.clone(),
            },
            Node::Ready => ServerState::Ready,
            Node::Sleeping => ServerState::Sleeping,
            Node::Failed => ServerState::Failed(self.failure.clone().unwrap_or(Failure::Stopped)),
        }
    }

    fn view(&self, repository: &str, language: Language) -> ServerView {
        ServerView {
            repository: repository.to_string(),
            language,
            state: self.state(),
            pid: self
                .connection
                .as_ref()
                .and_then(|connection| connection.pid()),
        }
    }

    /// Ends the process; whatever it still reports is stale.
    fn end_process(&mut self) {
        self.generation += 1;
        if let Some(connection) = self.connection.take() {
            stop_in_background(connection);
        }
    }

    fn turn_off(mut self) {
        self.end_process();
    }
}

fn stop_in_background(connection: Arc<Connection>) {
    tokio::spawn(async move { connection.stop().await });
}

/// Sends a starting process's events back into the supervisor, tagged with
/// the generation they belong to.
struct Reporter {
    messages: mpsc::UnboundedSender<Message>,
    repository: String,
    language: Language,
    generation: u64,
}

impl Reporter {
    fn send(&self, event: Event) {
        let _ = self.messages.send(Message::Process {
            repository: self.repository.clone(),
            language: self.language,
            generation: self.generation,
            event,
        });
    }
}

/// Whether a scope open at `scope` shows the folder `repository`: the folder
/// itself or anything beneath it. Logical paths have no leading `/`, and the
/// root is the empty path.
fn covers(repository: &str, scope: &str) -> bool {
    repository.is_empty()
        || scope == repository
        || scope
            .strip_prefix(repository)
            .is_some_and(|rest| rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;
    use crate::language_servers::connection::{Document, fake_server};

    const WAIT: Duration = Duration::from_secs(10);

    struct Fixture {
        root: TempDir,
        scopes: watch::Sender<BTreeSet<String>>,
        supervisor: Supervisor,
    }

    impl Fixture {
        fn new(sleep_after: Duration, finder: Finder) -> Self {
            Self::with_settings(sleep_after, finder, None)
        }

        fn with_settings(sleep_after: Duration, finder: Finder, saved: Option<Settings>) -> Self {
            let root = TempDir::new().unwrap();
            fs::create_dir_all(root.path().join("repo/src")).unwrap();
            fs::write(root.path().join("repo/Cargo.toml"), "").unwrap();
            fs::write(
                root.path().join("repo/src/main.rs"),
                "fn main() {\n    helper();\n}\n",
            )
            .unwrap();
            let file = SettingsFile::new(root.path().join("data/language-servers"));
            if let Some(saved) = saved {
                file.write(&saved).unwrap();
            }
            let fs = Arc::new(RootedFs::new(root.path()).unwrap());
            let (scopes, open) = watch::channel(BTreeSet::new());
            let supervisor = Supervisor::spawn(fs, file, open, sleep_after, finder);
            Self {
                root,
                scopes,
                supervisor,
            }
        }

        fn saved(&self) -> Settings {
            SettingsFile::new(self.root.path().join("data/language-servers"))
                .read()
                .unwrap()
        }

        fn show(&self, scopes: &[&str]) {
            self.scopes
                .send_replace(scopes.iter().map(|scope| (*scope).to_string()).collect());
        }

        async fn state(&self) -> ServerState {
            let view = self.supervisor.repository("repo".into()).await.unwrap();
            view.servers
                .into_iter()
                .find(|server| server.language == Language::Rust)
                .map_or(ServerState::Off, |server| server.state)
        }

        async fn wait_for(&self, expected: ServerState) {
            let waited = tokio::time::timeout(WAIT, async {
                loop {
                    if self.state().await == expected {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            assert!(
                waited.is_ok(),
                "expected {expected:?}, still {:?}",
                self.state().await
            );
        }

        async fn turn_on_rust(&self) {
            self.supervisor
                .set_languages(BTreeSet::from([Language::Rust]))
                .await
                .unwrap();
        }
    }

    fn installed() -> Finder {
        Finder::Fixed(Discovery::Found(fake_server("status")))
    }

    #[test]
    fn the_allowed_edges_are_exactly_these() {
        let ready = ReadySignal::Quiescent;
        let progress = || Event::Progress(None);
        let failed = || {
            Event::StartFailed(Failure::CouldNotStart {
                reason: String::new(),
            })
        };
        let found = || Event::Rechecked(Ok(fake_server("status")));
        let still_missing = || Event::Rechecked(Err(Failure::Stopped));
        let allowed = [
            (Node::Starting, progress(), Node::Starting),
            (Node::Starting, Event::Quiescent(false), Node::Starting),
            (Node::Starting, Event::Quiescent(true), Node::Ready),
            (Node::Ready, progress(), Node::Ready),
            (Node::Ready, Event::Quiescent(false), Node::Ready),
            (Node::Starting, failed(), Node::Failed),
            (Node::Starting, Event::Exited, Node::Failed),
            (Node::Ready, Event::Exited, Node::Failed),
            (Node::Starting, Event::SleepTimeElapsed, Node::Sleeping),
            (Node::Ready, Event::SleepTimeElapsed, Node::Sleeping),
            (Node::Sleeping, Event::ScopeOpened, Node::Starting),
            (Node::Failed, found(), Node::Starting),
            (Node::Failed, still_missing(), Node::Failed),
        ];
        for (node, event, expected) in &allowed {
            assert_eq!(next(*node, event, ready), Some(*expected), "{node:?}");
        }
        let refused = [
            (Node::Ready, failed()),
            (Node::Sleeping, Event::Exited),
            (Node::Sleeping, Event::SleepTimeElapsed),
            (Node::Sleeping, progress()),
            (Node::Failed, Event::ScopeOpened),
            (Node::Failed, Event::Exited),
            (Node::Starting, Event::ScopeOpened),
            (Node::Ready, Event::ScopeOpened),
            (Node::Starting, found()),
            (Node::Ready, found()),
            (Node::Sleeping, found()),
            (Node::Ready, still_missing()),
        ];
        for (node, event) in &refused {
            assert_eq!(next(*node, event, ready), None, "{node:?}");
        }
    }

    #[tokio::test]
    async fn started_is_ready_only_for_a_server_ready_once_initialized() {
        let root = TempDir::new().unwrap();
        let (notices, _) = mpsc::unbounded_channel();
        let connection = Connection::start(
            &fake_server("initialized"),
            root.path(),
            Language::Rust,
            notices,
        )
        .await
        .unwrap();
        let started = Event::Started(connection.clone());

        assert_eq!(
            next(Node::Starting, &started, ReadySignal::Initialized),
            Some(Node::Ready)
        );
        assert_eq!(
            next(Node::Starting, &started, ReadySignal::Quiescent),
            Some(Node::Starting)
        );
        assert_eq!(next(Node::Ready, &started, ReadySignal::Initialized), None);
        connection.stop().await;
    }

    #[tokio::test]
    async fn rust_analyzer_is_not_ready_before_it_reports_quiescence() {
        let fixture = Fixture::new(
            SLEEP_AFTER,
            Finder::Fixed(Discovery::Found(fake_server("initialized"))),
        );
        fixture.turn_on_rust().await;
        fixture.show(&["repo"]);
        fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();

        // This fixture never reports quiescence after the handshake.
        let waited = tokio::time::timeout(WAIT, async {
            while fixture.supervisor.servers().await[0].pid.is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(waited.is_ok());

        assert_eq!(
            fixture.state().await,
            ServerState::Starting { progress: None }
        );
        assert!(matches!(
            fixture
                .supervisor
                .connection("repo".into(), Language::Rust)
                .await,
            Err(ServerState::Starting { .. })
        ));
        fixture.supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn turning_a_shown_repository_on_starts_and_readies_its_servers() {
        let fixture = Fixture::new(SLEEP_AFTER, installed());
        fixture.turn_on_rust().await;
        fixture.show(&["repo/src"]);

        let view = fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();

        assert!(view.enabled);
        assert_eq!(view.servers.len(), 1);
        fixture.wait_for(ServerState::Ready).await;
        assert!(
            fixture
                .supervisor
                .connection("repo".into(), Language::Rust)
                .await
                .is_ok()
        );
        assert_eq!(
            fixture.saved().repositories,
            BTreeSet::from(["repo".to_string()])
        );
        fixture.supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn an_unshown_repository_sleeps_and_wakes_when_shown_again() {
        let fixture = Fixture::new(Duration::ZERO, installed());
        fixture.turn_on_rust().await;
        fixture.show(&["repo"]);
        fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();
        fixture.wait_for(ServerState::Ready).await;

        fixture.show(&["elsewhere"]);
        fixture.wait_for(ServerState::Sleeping).await;
        let views = fixture.supervisor.servers().await;
        assert_eq!(views[0].pid, None);

        fixture.show(&["repo"]);
        fixture.wait_for(ServerState::Ready).await;
        fixture.supervisor.shutdown().await;
    }

    /// Drives the state directly, so each scope change and elapsed timer
    /// lands in a known order.
    #[tokio::test]
    async fn only_the_timer_of_the_latest_close_puts_servers_to_sleep() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("repo")).unwrap();
        fs::write(root.path().join("repo/Cargo.toml"), "").unwrap();
        let file = SettingsFile::new(root.path().join("data"));
        file.write(&Settings {
            languages: BTreeSet::from([Language::Rust]),
            repositories: BTreeSet::from(["repo".to_string()]),
        })
        .unwrap();
        let (messages, _inbox) = mpsc::unbounded_channel();
        let finder = Finder::Fixed(Discovery::CouldNotStart {
            reason: String::new(),
        });
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let mut state = State::open(fs, file, SLEEP_AFTER, finder, messages);
        let node = |state: &State| state.server("repo", Language::Rust).unwrap().node;
        let shown = |state: &mut State, scopes: &[&str]| {
            state.scopes_changed(scopes.iter().map(|scope| (*scope).to_string()).collect());
        };
        assert_eq!(node(&state), Node::Sleeping);

        shown(&mut state, &["repo/src"]);
        assert_eq!(node(&state), Node::Starting);
        shown(&mut state, &[]);
        let first_close = state.repositories["repo"].timer;
        shown(&mut state, &["repo"]);
        state.sleep_time("repo", first_close);
        assert_eq!(node(&state), Node::Starting);

        shown(&mut state, &["elsewhere"]);
        let latest_close = state.repositories["repo"].timer;
        state.sleep_time("repo", latest_close);
        assert_eq!(node(&state), Node::Sleeping);
    }

    #[tokio::test]
    async fn turning_the_repository_off_ends_its_servers_and_forgets_it() {
        let fixture = Fixture::new(SLEEP_AFTER, installed());
        fixture.turn_on_rust().await;
        fixture.show(&["repo"]);
        fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();
        fixture.wait_for(ServerState::Ready).await;

        let view = fixture
            .supervisor
            .set_repository("repo".into(), false)
            .await
            .unwrap();

        assert!(!view.enabled);
        assert_eq!(fixture.state().await, ServerState::Off);
        assert!(fixture.supervisor.servers().await.is_empty());
        assert!(fixture.saved().repositories.is_empty());
        fixture.supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn turning_a_language_off_ends_its_servers_everywhere() {
        let fixture = Fixture::new(SLEEP_AFTER, installed());
        fixture.turn_on_rust().await;
        fixture.show(&["repo"]);
        fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();
        fixture.wait_for(ServerState::Ready).await;

        fixture
            .supervisor
            .set_languages(BTreeSet::new())
            .await
            .unwrap();

        assert!(fixture.supervisor.servers().await.is_empty());
        assert!(fixture.saved().languages.is_empty());
        fixture.supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_folder_gone_when_its_screens_close_is_forgotten() {
        let fixture = Fixture::new(SLEEP_AFTER, installed());
        fixture.turn_on_rust().await;
        fixture.show(&["repo"]);
        fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();
        fixture.wait_for(ServerState::Ready).await;

        fs::remove_dir_all(fixture.root.path().join("repo")).unwrap();
        fixture.show(&[]);

        let waited = tokio::time::timeout(WAIT, async {
            while !fixture.supervisor.servers().await.is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        assert!(waited.is_ok());
        assert!(fixture.saved().repositories.is_empty());
        fixture.supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_missing_server_fails_with_what_installing_it_takes() {
        let missing = MissingServer {
            toolchain: Some("1.94-aarch64-apple-darwin".into()),
            install_command:
                "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin"
                    .into(),
            check_command: "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version".into(),
        };
        let fixture = Fixture::new(
            SLEEP_AFTER,
            Finder::Fixed(Discovery::NotInstalled(missing.clone())),
        );
        fixture.turn_on_rust().await;
        fixture.show(&["repo"]);
        fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();

        fixture
            .wait_for(ServerState::Failed(Failure::NotInstalled(missing)))
            .await;
        fixture.supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn looking_again_starts_a_server_installed_meanwhile_and_only_then() {
        let missing = MissingServer {
            toolchain: Some("1.94-aarch64-apple-darwin".into()),
            install_command:
                "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin"
                    .into(),
            check_command: "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version".into(),
        };
        let discovery = Arc::new(std::sync::Mutex::new(Discovery::NotInstalled(
            missing.clone(),
        )));
        let fixture = Fixture::new(SLEEP_AFTER, Finder::Changing(discovery.clone()));
        fixture.turn_on_rust().await;
        fixture.show(&["repo"]);
        fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();
        let not_installed = ServerState::Failed(Failure::NotInstalled(missing));
        fixture.wait_for(not_installed.clone()).await;

        // Still missing: the answer says so, never starting for a moment.
        let view = fixture.supervisor.recheck("repo".into()).await.unwrap();
        assert_eq!(view.servers[0].state, not_installed);

        *discovery.lock().unwrap() = Discovery::Found(fake_server("status"));
        let view = fixture.supervisor.recheck("repo".into()).await.unwrap();
        assert_eq!(
            view.servers[0].state,
            ServerState::Starting { progress: None }
        );
        fixture.wait_for(ServerState::Ready).await;

        // A server that runs is left as it is.
        let view = fixture.supervisor.recheck("repo".into()).await.unwrap();
        assert_eq!(view.servers[0].state, ServerState::Ready);
        fixture.supervisor.shutdown().await;
    }

    /// Drives the state directly, so the timer it arms is the one checked.
    #[tokio::test]
    async fn a_server_found_again_while_unshown_sleeps_after_the_usual_time() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("repo")).unwrap();
        fs::write(root.path().join("repo/Cargo.toml"), "").unwrap();
        let file = SettingsFile::new(root.path().join("data"));
        file.write(&Settings {
            languages: BTreeSet::from([Language::Rust]),
            repositories: BTreeSet::from(["repo".to_string()]),
        })
        .unwrap();
        let (messages, _inbox) = mpsc::unbounded_channel();
        let finder = Finder::Fixed(Discovery::CouldNotStart {
            reason: String::new(),
        });
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let mut state = State::open(fs, file, SLEEP_AFTER, finder, messages);
        let node = |state: &State| state.server("repo", Language::Rust).unwrap().node;
        state.scopes_changed(BTreeSet::from(["repo".to_string()]));
        let generation = state.server("repo", Language::Rust).unwrap().generation;
        state.apply(
            "repo",
            Language::Rust,
            Event::StartFailed(Failure::CouldNotStart {
                reason: String::new(),
            }),
        );
        state.scopes_changed(BTreeSet::new());
        let closed = state.repositories["repo"].timer;
        state.sleep_time("repo", closed);
        assert_eq!(node(&state), Node::Failed);

        // A program that is not there fails to start without a process.
        let missing_program = FoundServer {
            program: root.path().join("no-such-server"),
            arguments: Vec::new(),
            version: String::new(),
        };
        let failed_generation = state.server("repo", Language::Rust).unwrap().generation;
        assert_ne!(failed_generation, generation);
        let view = state
            .rechecked(
                "repo",
                vec![(Language::Rust, failed_generation, Ok(missing_program))],
            )
            .unwrap();
        assert_eq!(
            view.servers[0].state,
            ServerState::Starting { progress: None }
        );
        let armed = state.repositories["repo"].timer;
        assert!(armed > closed);
        state.sleep_time("repo", armed);
        assert_eq!(node(&state), Node::Sleeping);
    }

    #[tokio::test]
    async fn a_server_that_exits_fails() {
        let fixture = Fixture::new(
            SLEEP_AFTER,
            Finder::Fixed(Discovery::Found(fake_server("exit-on-definition"))),
        );
        fixture.turn_on_rust().await;
        fixture.show(&["repo"]);
        fixture
            .supervisor
            .set_repository("repo".into(), true)
            .await
            .unwrap();
        fixture.wait_for(ServerState::Ready).await;
        let connection = fixture
            .supervisor
            .connection("repo".into(), Language::Rust)
            .await
            .unwrap();
        let main = fixture.root.path().join("repo/src/main.rs");

        let _ = connection
            .definition(
                Document {
                    text: fs::read_to_string(&main).unwrap(),
                    path: main,
                    language_id: "rust",
                },
                1,
                4,
            )
            .await;

        fixture
            .wait_for(ServerState::Failed(Failure::Stopped))
            .await;
        fixture.supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn saved_repositories_start_asleep_and_wake_when_shown() {
        let fixture = Fixture::with_settings(
            SLEEP_AFTER,
            installed(),
            Some(Settings {
                languages: BTreeSet::from([Language::Rust]),
                repositories: BTreeSet::from(["repo".to_string(), "gone".to_string()]),
            }),
        );

        assert_eq!(fixture.state().await, ServerState::Sleeping);
        assert_eq!(
            fixture.saved().repositories,
            BTreeSet::from(["repo".to_string()])
        );

        fixture.show(&["repo"]);
        fixture.wait_for(ServerState::Ready).await;
        fixture.supervisor.shutdown().await;
    }

    #[tokio::test]
    async fn a_repository_that_is_off_lists_its_languages_as_off() {
        let fixture = Fixture::new(SLEEP_AFTER, installed());
        fixture.turn_on_rust().await;

        let view = fixture.supervisor.repository("repo".into()).await.unwrap();

        assert_eq!(
            view,
            RepositoryView {
                path: "repo".into(),
                enabled: false,
                servers: vec![ServerView {
                    repository: "repo".into(),
                    language: Language::Rust,
                    state: ServerState::Off,
                    pid: None,
                }],
            }
        );
        fixture.supervisor.shutdown().await;
    }

    #[test]
    fn a_repository_is_shown_by_scopes_at_or_beneath_it() {
        assert!(covers("work/app", "work/app"));
        assert!(covers("work/app", "work/app/src"));
        assert!(!covers("work/app", "work/application"));
        assert!(!covers("work/app", "work"));
        assert!(covers("", "anything"));
    }
}
