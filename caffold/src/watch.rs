use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    thread,
    time::Duration,
};

use notify::{Event, EventKind, PathsMut, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use thiserror::Error;
use tokio::{
    sync::{broadcast, mpsc, oneshot, watch},
    task,
    time::{Instant, sleep_until},
};

use crate::{
    fs::{FsError, RootedFs},
    git::{self, Repository, RepositoryMetadataPaths},
};

const QUIET_DEBOUNCE: Duration = Duration::from_millis(250);
const MAX_BATCH_LATENCY: Duration = Duration::from_secs(1);
const MAX_BATCH_PATHS: usize = 128;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchReady {
    pub revision: u64,
    pub scope_path: String,
    pub repository_root_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WatchChange {
    pub revision: u64,
    pub paths: Vec<String>,
    pub git_status_changed: bool,
    pub git_refs_changed: bool,
    pub overflow: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum WatchMessage {
    Change(WatchChange),
    Error(String),
}

#[derive(Debug, Error)]
pub(crate) enum WatchError {
    #[error(transparent)]
    Fs(#[from] FsError),
    #[error("native filesystem watcher is unavailable: {0}")]
    Unavailable(String),
}

/// The backend's native filesystem watches, one per canonical scope shared by
/// its subscribers.
///
/// Each scope's native watcher lives on the scope's own thread, which
/// registers it and finally drops it. notify's FSEvents backend waits without
/// a bound when it stops a stream, so a request thread of the server never
/// does either, and the hub's lock covers only its list of scopes. A native
/// watcher that never finishes starting or stopping holds up only that scope's
/// subscribers.
#[derive(Clone)]
pub(crate) struct WatchHub {
    inner: Arc<WatchHubInner>,
}

struct WatchHubInner {
    fs: Arc<RootedFs>,
    shutdown: broadcast::Sender<()>,
    scopes: Mutex<Scopes>,
    #[cfg(test)]
    hold: Mutex<Option<Hold>>,
}

#[derive(Default)]
struct Scopes {
    entries: HashMap<String, ScopeEntry>,
    next_scope: u64,
}

/// Dropping an entry ends its scope: the batching task stops, and the scope's
/// thread drops the native watcher.
struct ScopeEntry {
    scope: u64,
    ready: WatchReady,
    sender: broadcast::Sender<WatchMessage>,
    started: watch::Receiver<Option<Started>>,
    subscribers: usize,
    _stop_batches: oneshot::Sender<()>,
    _release_watcher: oneshot::Sender<()>,
}

/// Whether a scope's native watcher registered, with the error's message if
/// not.
type Started = Result<(), String>;

pub(crate) struct WatchSubscription {
    hub: Weak<WatchHubInner>,
    key: String,
    scope: u64,
    pub ready: WatchReady,
    receiver: broadcast::Receiver<WatchMessage>,
}

impl WatchSubscription {
    pub(crate) async fn recv(&mut self) -> Result<WatchMessage, broadcast::error::RecvError> {
        self.receiver.recv().await
    }
}

impl Drop for WatchSubscription {
    fn drop(&mut self) {
        let Some(hub) = self.hub.upgrade() else {
            return;
        };
        let Ok(mut scopes) = hub.scopes.lock() else {
            return;
        };
        let remove = match scopes.entries.get_mut(&self.key) {
            Some(entry) if entry.scope == self.scope => {
                entry.subscribers -= 1;
                entry.subscribers == 0
            }
            _ => false,
        };
        if remove {
            scopes.entries.remove(&self.key);
        }
    }
}

#[derive(Clone)]
struct ScopeConfig {
    fs_root: PathBuf,
    watch_root: PathBuf,
    scope_path: String,
    repository: Option<Repository>,
    repository_root_path: Option<String>,
    metadata_paths: Option<RepositoryMetadataPaths>,
}

impl WatchHub {
    pub(crate) fn new(fs: Arc<RootedFs>, shutdown: broadcast::Sender<()>) -> Self {
        Self {
            inner: Arc::new(WatchHubInner {
                fs,
                shutdown,
                scopes: Mutex::default(),
                #[cfg(test)]
                hold: Mutex::default(),
            }),
        }
    }

    /// Subscribes to the canonical scope of `requested_path` and returns once
    /// its native watcher is registered, so every later change reaches the
    /// subscription.
    pub(crate) async fn subscribe(
        &self,
        requested_path: &str,
    ) -> Result<WatchSubscription, WatchError> {
        let config = self.scope_config(requested_path).await?;
        // The subscription exists before the wait, so a caller that gives up
        // waiting still leaves the scope.
        let (subscription, mut started) = self.join_scope(config)?;
        let started = match started.wait_for(Option::is_some).await {
            Ok(started) => started.clone().expect("a started scope reports how"),
            Err(_) => Err("the native watcher ended before it started".to_string()),
        };
        started.map_err(WatchError::Unavailable)?;
        Ok(subscription)
    }

    /// Resolving a scope runs Git, so it happens on the blocking pool.
    async fn scope_config(&self, requested_path: &str) -> Result<ScopeConfig, WatchError> {
        let inner = self.inner.clone();
        let requested_path = requested_path.to_string();
        task::spawn_blocking(move || inner.scope_config(&requested_path))
            .await
            .map_err(|error| WatchError::Unavailable(error.to_string()))?
    }

    /// Counts a subscriber of the config's scope, starting the scope if it has
    /// none, and returns the subscription with the scope's start report.
    fn join_scope(
        &self,
        config: ScopeConfig,
    ) -> Result<(WatchSubscription, watch::Receiver<Option<Started>>), WatchError> {
        let key = config.scope_path.clone();
        let mut scopes =
            self.inner.scopes.lock().map_err(|_| {
                WatchError::Unavailable("watch registry is unavailable".to_string())
            })?;

        if let Some(entry) = scopes.entries.get_mut(&key) {
            entry.subscribers += 1;
            return Ok((self.subscription(&key, entry), entry.started.clone()));
        }

        scopes.next_scope += 1;
        let scope = scopes.next_scope;
        let (sender, _) = broadcast::channel(128);
        let (report, started) = watch::channel(None);
        let (stop_batches, batches_stopped) = oneshot::channel();
        let (release_watcher, watcher_released) = oneshot::channel();
        let entry = ScopeEntry {
            scope,
            ready: WatchReady {
                revision: 1,
                scope_path: config.scope_path.clone(),
                repository_root_path: config.repository_root_path.clone(),
            },
            sender: sender.clone(),
            started: started.clone(),
            subscribers: 1,
            _stop_batches: stop_batches,
            _release_watcher: release_watcher,
        };
        let subscription = self.subscription(&key, &entry);
        scopes.entries.insert(key.clone(), entry);
        drop(scopes);

        let (events, raw_receiver) = mpsc::unbounded_channel();
        tokio::spawn(run_scope(
            config.clone(),
            raw_receiver,
            sender,
            batches_stopped,
            self.inner.shutdown.subscribe(),
        ));
        let native = NativeWatcher {
            hub: Arc::downgrade(&self.inner),
            scope,
            config,
            events,
            report,
            released: watcher_released,
            #[cfg(test)]
            hold: self.inner.hold.lock().unwrap().take(),
        };
        let spawned = thread::Builder::new()
            .name("caffold-watch".to_string())
            .spawn(move || native.run());
        // The report's sender went with the thread, so waiting subscribers
        // learn that the scope ended before its native watcher started.
        if spawned.is_err() {
            self.inner.remove(&key, scope);
        }
        Ok((subscription, started))
    }

    fn subscription(&self, key: &str, entry: &ScopeEntry) -> WatchSubscription {
        WatchSubscription {
            hub: Arc::downgrade(&self.inner),
            key: key.to_string(),
            scope: entry.scope,
            ready: entry.ready.clone(),
            receiver: entry.sender.subscribe(),
        }
    }
}

impl WatchHubInner {
    fn scope_config(&self, requested_path: &str) -> Result<ScopeConfig, WatchError> {
        let requested = self.fs.absolute_directory_path(requested_path)?;
        let repository = git::repository_for(&requested)
            .filter(|repository| repository.root.starts_with(self.fs.root()));
        let watch_root = repository
            .as_ref()
            .map(|repository| repository.root.clone())
            .unwrap_or(requested);
        let scope_path = self.fs.logical_path_for_absolute(&watch_root)?;
        let repository_root_path = repository.as_ref().map(|_| scope_path.clone());
        let metadata_paths = repository.as_ref().and_then(git::repository_metadata_paths);

        Ok(ScopeConfig {
            fs_root: self.fs.root().to_path_buf(),
            watch_root,
            scope_path,
            repository,
            repository_root_path,
            metadata_paths,
        })
    }

    /// Removes the key's scope if it is still `scope`.
    fn remove(&self, key: &str, scope: u64) {
        if let Ok(mut scopes) = self.scopes.lock()
            && scopes
                .entries
                .get(key)
                .is_some_and(|entry| entry.scope == scope)
        {
            scopes.entries.remove(key);
        }
    }
}

/// What a scope's own thread needs to register, keep, and finally drop its
/// native watcher.
struct NativeWatcher {
    hub: Weak<WatchHubInner>,
    scope: u64,
    config: ScopeConfig,
    events: mpsc::UnboundedSender<notify::Result<Event>>,
    report: watch::Sender<Option<Started>>,
    released: oneshot::Receiver<()>,
    #[cfg(test)]
    hold: Option<Hold>,
}

impl NativeWatcher {
    /// The body of the scope's thread.
    fn run(self) {
        let Self {
            hub,
            scope,
            config,
            events,
            report,
            released,
            #[cfg(test)]
            mut hold,
        } = self;
        #[cfg(test)]
        pause(&mut hold, HoldPoint::Starting);
        let watcher = match start_native_watcher(&config, events) {
            Ok(watcher) => watcher,
            Err(error) => {
                // A subscriber that arrives after the failure starts a new
                // scope rather than joining this one.
                if let Some(hub) = hub.upgrade() {
                    hub.remove(&config.scope_path, scope);
                }
                let _ = report.send(Some(Err(error.to_string())));
                return;
            }
        };
        let _ = report.send(Some(Ok(())));
        // Returns once the hub drops the scope's entry, which holds the sender.
        let _ = released.blocking_recv();
        #[cfg(test)]
        pause(&mut hold, HoldPoint::Stopping);
        drop(watcher);
    }
}

/// Registers every path of the scope at once, so FSEvents starts one stream
/// instead of restarting it for each path.
fn start_native_watcher(
    config: &ScopeConfig,
    events: mpsc::UnboundedSender<notify::Result<Event>>,
) -> notify::Result<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = events.send(event);
    })?;
    let mut paths = watcher.paths_mut();
    register_watch_paths(&mut *paths, config)?;
    paths.commit()?;
    Ok(watcher)
}

fn register_watch_paths(paths: &mut dyn PathsMut, config: &ScopeConfig) -> notify::Result<()> {
    let recursive = config.repository.is_some();
    paths.add(
        &config.watch_root,
        if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        },
    )?;

    if !recursive {
        return Ok(());
    }

    let Some(metadata) = config.metadata_paths.as_ref() else {
        return Ok(());
    };
    let mut watched = HashSet::new();
    watched.insert(config.watch_root.clone());
    for root in [&metadata.git_dir, &metadata.common_dir] {
        if root.starts_with(&config.watch_root) || !watched.insert(root.clone()) {
            continue;
        }
        paths.add(root, RecursiveMode::NonRecursive)?;
        let refs = root.join("refs");
        if refs.is_dir() && watched.insert(refs.clone()) {
            paths.add(&refs, RecursiveMode::Recursive)?;
        }
    }
    Ok(())
}

async fn run_scope(
    config: ScopeConfig,
    mut raw_receiver: mpsc::UnboundedReceiver<notify::Result<Event>>,
    sender: broadcast::Sender<WatchMessage>,
    mut stop: oneshot::Receiver<()>,
    mut shutdown: broadcast::Receiver<()>,
) {
    let mut revision = 1_u64;
    loop {
        let first = tokio::select! {
            _ = &mut stop => return,
            _ = shutdown.recv() => return,
            event = raw_receiver.recv() => match event {
                Some(event) => event,
                None => return,
            },
        };

        let started = Instant::now();
        let mut pending = vec![first];
        let quiet = sleep_until(started + QUIET_DEBOUNCE);
        let deadline = sleep_until(started + MAX_BATCH_LATENCY);
        tokio::pin!(quiet);
        tokio::pin!(deadline);

        loop {
            tokio::select! {
                _ = &mut stop => return,
                _ = shutdown.recv() => return,
                _ = &mut quiet => break,
                _ = &mut deadline => break,
                event = raw_receiver.recv() => match event {
                    Some(event) => {
                        pending.push(event);
                        quiet.as_mut().reset(Instant::now() + QUIET_DEBOUNCE);
                    }
                    None => break,
                },
            }
        }

        if let Some(error) = pending.iter().find_map(|event| event.as_ref().err()) {
            let _ = sender.send(WatchMessage::Error(error.to_string()));
            continue;
        }

        let batch_config = config.clone();
        let normalized =
            tokio::task::spawn_blocking(move || normalize_batch(&batch_config, pending)).await;
        let normalized = match normalized {
            Ok(normalized) => normalized,
            Err(error) => {
                let _ = sender.send(WatchMessage::Error(format!(
                    "filesystem change processing failed: {error}"
                )));
                continue;
            }
        };

        match normalized {
            Ok(Some(mut change)) => {
                revision = revision.saturating_add(1);
                change.revision = revision;
                let _ = sender.send(WatchMessage::Change(change));
            }
            Ok(None) => {}
            Err(error) => {
                let _ = sender.send(WatchMessage::Error(error));
            }
        }
    }
}

fn normalize_batch(
    config: &ScopeConfig,
    events: Vec<notify::Result<Event>>,
) -> Result<Option<WatchChange>, String> {
    let mut paths = BTreeMap::new();
    let mut repo_relative_paths = BTreeSet::new();
    let mut git_status_changed = false;
    let mut git_refs_changed = false;
    let mut overflow = false;

    for event in events {
        let event = match event {
            Ok(event) => event,
            Err(error) => return Err(error.to_string()),
        };

        if matches!(event.kind, EventKind::Access(_)) {
            continue;
        }
        if event.paths.is_empty() {
            overflow = true;
            git_status_changed |= config.repository.is_some();
            git_refs_changed |= config.repository.is_some();
            continue;
        }

        for path in event.paths {
            if let Some((status_changed, refs_changed)) = classify_git_metadata(config, &path) {
                git_status_changed |= status_changed;
                git_refs_changed |= refs_changed;
                continue;
            }

            let Some(logical_path) = logical_path(&config.fs_root, &path) else {
                overflow = true;
                git_status_changed |= config.repository.is_some();
                continue;
            };

            let repo_relative_path = if let Some(repository) = config.repository.as_ref()
                && let Ok(relative) = path.strip_prefix(&repository.root)
            {
                let relative = slash_path(relative);
                if relative.is_empty() {
                    git_status_changed = true;
                } else {
                    repo_relative_paths.insert(relative.clone());
                }
                Some(relative)
            } else {
                None
            };
            paths.entry(logical_path).or_insert(repo_relative_path);
        }
    }

    let ignored = config
        .repository
        .as_ref()
        .filter(|_| !repo_relative_paths.is_empty())
        .map(|repository| git::ignored_paths(repository, repo_relative_paths.iter().cloned()))
        .unwrap_or_default();
    if !repo_relative_paths.is_empty() {
        git_status_changed |= repo_relative_paths
            .iter()
            .any(|path| !ignored.contains(path));
    }

    let mut visible_paths = Vec::new();
    let mut ignored_paths = Vec::new();
    for (logical_path, repo_relative_path) in paths {
        if repo_relative_path
            .as_ref()
            .is_some_and(|path| !path.is_empty() && ignored.contains(path))
        {
            ignored_paths.push(logical_path);
        } else {
            visible_paths.push(logical_path);
        }
    }
    overflow |= visible_paths.len() > MAX_BATCH_PATHS;
    let mut outgoing_paths = visible_paths
        .into_iter()
        .take(MAX_BATCH_PATHS)
        .collect::<Vec<_>>();
    let remaining = MAX_BATCH_PATHS.saturating_sub(outgoing_paths.len());
    outgoing_paths.extend(ignored_paths.into_iter().take(remaining));

    if outgoing_paths.is_empty() && !git_status_changed && !git_refs_changed && !overflow {
        return Ok(None);
    }

    Ok(Some(WatchChange {
        revision: 0,
        paths: outgoing_paths,
        git_status_changed,
        git_refs_changed,
        overflow,
    }))
}

fn classify_git_metadata(config: &ScopeConfig, path: &Path) -> Option<(bool, bool)> {
    let metadata = config.metadata_paths.as_ref()?;
    for root in [&metadata.git_dir, &metadata.common_dir] {
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let relative = slash_path(relative);
        if relative.is_empty() {
            return Some((true, true));
        }
        if relative == "index" {
            return Some((true, false));
        }
        if relative == "HEAD" || relative == "packed-refs" || relative.starts_with("refs/") {
            return Some((true, true));
        }
        return Some((false, false));
    }
    None
}

fn logical_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    Some(slash_path(relative))
}

fn slash_path(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// Test hooks into the hub's scopes.
#[cfg(test)]
impl WatchHub {
    fn active_scope_count(&self) -> usize {
        self.inner.scopes.lock().unwrap().entries.len()
    }

    /// Holds the next scope's thread at `point` until the returned sender is
    /// used or dropped. The receiver resolves once the thread is held.
    fn hold_next_scope(&self, point: HoldPoint) -> (oneshot::Sender<()>, oneshot::Receiver<()>) {
        let (release, released) = oneshot::channel();
        let (held_sender, held) = oneshot::channel();
        *self.inner.hold.lock().unwrap() = Some(Hold {
            point,
            held: held_sender,
            released,
        });
        (release, held)
    }
}

/// Where a test holds a scope's thread.
#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum HoldPoint {
    /// Before the native watcher registers.
    Starting,
    /// After the scope ended and before the native watcher is dropped.
    Stopping,
}

#[cfg(test)]
struct Hold {
    point: HoldPoint,
    held: oneshot::Sender<()>,
    released: oneshot::Receiver<()>,
}

#[cfg(test)]
fn pause(hold: &mut Option<Hold>, point: HoldPoint) {
    if let Some(current) = hold.take_if(|hold| hold.point == point) {
        let _ = current.held.send(());
        let _ = current.released.blocking_recv();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
    use std::{fs, process::Command};
    use tempfile::TempDir;
    use tokio::{task::JoinHandle, time::timeout};

    const WAIT: Duration = Duration::from_secs(30);

    fn config(root: &Path, repository: Option<Repository>) -> ScopeConfig {
        ScopeConfig {
            fs_root: root.to_path_buf(),
            watch_root: repository
                .as_ref()
                .map(|repository| repository.root.clone())
                .unwrap_or_else(|| root.to_path_buf()),
            scope_path: String::new(),
            repository_root_path: repository.as_ref().map(|_| String::new()),
            metadata_paths: repository.as_ref().and_then(git::repository_metadata_paths),
            repository,
        }
    }

    fn event(kind: EventKind, path: PathBuf) -> notify::Result<Event> {
        Ok(Event::new(kind).add_path(path))
    }

    fn git(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repository(root: &Path) -> Repository {
        git(root, &["init"]);
        git(root, &["config", "user.name", "Caffold Tests"]);
        git(root, &["config", "user.email", "tests@example.com"]);
        git::repository_for(root).unwrap()
    }

    #[test]
    fn normalizes_create_modify_remove_and_rename_as_invalidations() {
        let root = TempDir::new().unwrap();
        let config = config(root.path(), None);
        let changes = normalize_batch(
            &config,
            vec![
                event(
                    EventKind::Create(CreateKind::File),
                    root.path().join("created.txt"),
                ),
                event(
                    EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Any)),
                    root.path().join("changed.txt"),
                ),
                event(
                    EventKind::Remove(RemoveKind::File),
                    root.path().join("removed.txt"),
                ),
                event(
                    EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                    root.path().join("renamed.txt"),
                ),
            ],
        )
        .unwrap()
        .unwrap();

        assert_eq!(
            changes.paths,
            vec!["changed.txt", "created.txt", "removed.txt", "renamed.txt"]
        );
        assert!(!changes.git_status_changed);
    }

    #[test]
    fn caps_large_batches_and_marks_overflow() {
        let root = TempDir::new().unwrap();
        let config = config(root.path(), None);
        let events = (0..MAX_BATCH_PATHS + 10)
            .map(|index| {
                event(
                    EventKind::Create(CreateKind::File),
                    root.path().join(format!("{index}.txt")),
                )
            })
            .collect();
        let change = normalize_batch(&config, events).unwrap().unwrap();
        assert_eq!(change.paths.len(), MAX_BATCH_PATHS);
        assert!(change.overflow);
    }

    #[test]
    fn ignored_worktree_changes_do_not_invalidate_git_status() {
        let root = TempDir::new().unwrap();
        let repository = repository(root.path());
        let repository_root = repository.root.clone();
        fs::write(root.path().join(".gitignore"), "ignored.log\n").unwrap();
        let config = config(&repository_root, Some(repository));

        let change = normalize_batch(
            &config,
            vec![event(
                EventKind::Modify(ModifyKind::Any),
                repository_root.join("ignored.log"),
            )],
        )
        .unwrap()
        .unwrap();

        assert_eq!(change.paths, vec!["ignored.log"]);
        assert!(!change.git_status_changed);
        assert!(!change.git_refs_changed);
    }

    #[test]
    fn ignored_path_overflow_does_not_request_a_global_refresh() {
        let root = TempDir::new().unwrap();
        let repository = repository(root.path());
        let repository_root = repository.root.clone();
        fs::write(root.path().join(".gitignore"), "ignored-*\n").unwrap();
        let config = config(&repository_root, Some(repository));
        let events = (0..MAX_BATCH_PATHS + 1)
            .map(|index| {
                event(
                    EventKind::Modify(ModifyKind::Any),
                    repository_root.join(format!("ignored-{index}.log")),
                )
            })
            .collect();

        let change = normalize_batch(&config, events).unwrap().unwrap();

        assert_eq!(change.paths.len(), MAX_BATCH_PATHS);
        assert!(!change.overflow);
        assert!(!change.git_status_changed);
    }

    #[test]
    fn large_mixed_batch_prioritizes_the_non_ignored_path() {
        let root = TempDir::new().unwrap();
        let repository = repository(root.path());
        let repository_root = repository.root.clone();
        fs::write(root.path().join(".gitignore"), "ignored-*\n").unwrap();
        fs::write(root.path().join("visible.rs"), "tracked\n").unwrap();
        git(root.path(), &["add", "visible.rs"]);
        let config = config(&repository_root, Some(repository));
        let mut events = (0..MAX_BATCH_PATHS + 1)
            .map(|index| {
                event(
                    EventKind::Modify(ModifyKind::Any),
                    repository_root.join(format!("ignored-{index}.log")),
                )
            })
            .collect::<Vec<_>>();
        events.push(event(
            EventKind::Modify(ModifyKind::Any),
            repository_root.join("visible.rs"),
        ));

        let change = normalize_batch(&config, events).unwrap().unwrap();

        assert!(change.paths.iter().any(|path| path == "visible.rs"));
        assert!(!change.overflow);
        assert!(change.git_status_changed);
    }

    #[test]
    fn classifies_git_index_and_ref_changes() {
        let root = TempDir::new().unwrap();
        let repository = repository(root.path());
        let config = config(root.path(), Some(repository));
        let metadata = config.metadata_paths.as_ref().unwrap();

        assert_eq!(
            classify_git_metadata(&config, &metadata.git_dir.join("index")),
            Some((true, false))
        );
        assert_eq!(
            classify_git_metadata(&config, &metadata.common_dir.join("refs/heads/main")),
            Some((true, true))
        );
        assert_eq!(
            classify_git_metadata(&config, &metadata.common_dir.join("objects/ab/cd")),
            Some((false, false))
        );
    }

    #[tokio::test]
    async fn shares_native_watchers_until_the_last_subscription_closes() {
        let root = TempDir::new().unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);

        let first = hub.subscribe("").await.unwrap();
        let second = hub.subscribe("").await.unwrap();
        assert_eq!(hub.active_scope_count(), 1);
        assert_eq!(first.ready, second.ready);

        drop(first);
        assert_eq!(hub.active_scope_count(), 1);
        drop(second);
        assert_eq!(hub.active_scope_count(), 0);
    }

    /// A native watcher that never finishes registering delays only its own
    /// subscribers. With a single worker thread, another scope still starts,
    /// the waiting subscriber can leave, and its path starts again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn a_scope_held_while_starting_holds_up_only_its_own_subscribers() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("held")).unwrap();
        fs::create_dir(root.path().join("other")).unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);
        let (release, held) = hub.hold_next_scope(HoldPoint::Starting);

        let waiting = subscribe_on_worker(&hub, "held");
        timeout(WAIT, held)
            .await
            .expect("the scope is held")
            .unwrap();

        let other = timeout(WAIT, subscribe_on_worker(&hub, "other"))
            .await
            .expect("another scope starts")
            .unwrap()
            .unwrap();
        assert_eq!(other.ready.scope_path, "other");

        waiting.abort();
        assert!(matches!(waiting.await, Err(error) if error.is_cancelled()));
        assert_eq!(hub.active_scope_count(), 1);

        let again = timeout(WAIT, subscribe_on_worker(&hub, "held"))
            .await
            .expect("the held path starts a new scope")
            .unwrap()
            .unwrap();
        assert_eq!(again.ready.scope_path, "held");
        assert_eq!(hub.active_scope_count(), 2);
        drop(release);
    }

    /// Dropping the last subscriber returns at once even when the native
    /// watcher never finishes stopping, and the path can start again.
    #[tokio::test(flavor = "multi_thread", worker_threads = 1)]
    async fn a_scope_held_while_stopping_leaves_its_path_free_to_start_again() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("held")).unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);
        let (release, held) = hub.hold_next_scope(HoldPoint::Stopping);

        let first = timeout(WAIT, subscribe_on_worker(&hub, "held"))
            .await
            .expect("the scope starts")
            .unwrap()
            .unwrap();
        timeout(WAIT, tokio::spawn(async move { drop(first) }))
            .await
            .expect("the last subscriber leaves at once")
            .unwrap();
        timeout(WAIT, held)
            .await
            .expect("the scope is held")
            .unwrap();
        assert_eq!(hub.active_scope_count(), 0);

        let again = timeout(WAIT, subscribe_on_worker(&hub, "held"))
            .await
            .expect("the path starts a new scope")
            .unwrap()
            .unwrap();
        assert_eq!(again.ready.scope_path, "held");
        assert_eq!(hub.active_scope_count(), 1);
        drop(release);
    }

    #[tokio::test]
    async fn a_native_watcher_that_cannot_start_is_reported_and_forgotten() {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("vanishing")).unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);
        let (release, held) = hub.hold_next_scope(HoldPoint::Starting);

        let waiting = subscribe_on_worker(&hub, "vanishing");
        timeout(WAIT, held)
            .await
            .expect("the scope is held")
            .unwrap();
        fs::remove_dir(root.path().join("vanishing")).unwrap();
        drop(release);

        let refused = timeout(WAIT, waiting)
            .await
            .expect("the subscriber hears the failure")
            .unwrap();
        assert!(matches!(refused, Err(WatchError::Unavailable(_))));
        assert_eq!(hub.active_scope_count(), 0);
    }

    /// A linked worktree's scope registers its own tree and the Git metadata
    /// outside it together, so a ref created from the main checkout reaches it.
    #[tokio::test]
    async fn a_linked_worktree_scope_hears_refs_change_in_the_common_git_directory() {
        let root = TempDir::new().unwrap();
        let main = root.path().join("main");
        fs::create_dir(&main).unwrap();
        repository(&main);
        fs::write(main.join("tracked.txt"), "tracked\n").unwrap();
        git(&main, &["add", "tracked.txt"]);
        git(&main, &["commit", "-m", "initial"]);
        git(&main, &["worktree", "add", "-b", "linked", "../linked"]);
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);
        let mut subscription = hub.subscribe("linked").await.unwrap();
        assert_eq!(
            subscription.ready.repository_root_path.as_deref(),
            Some("linked")
        );

        tokio::time::sleep(Duration::from_millis(300)).await;
        git(&main, &["branch", "from-main"]);
        let change = timeout(Duration::from_secs(10), async {
            loop {
                if let WatchMessage::Change(change) = subscription.recv().await.unwrap()
                    && change.git_refs_changed
                {
                    return change;
                }
            }
        })
        .await
        .expect("ref change");

        assert!(change.git_status_changed);
    }

    fn subscribe_on_worker(
        hub: &WatchHub,
        path: &'static str,
    ) -> JoinHandle<Result<WatchSubscription, WatchError>> {
        let hub = hub.clone();
        tokio::spawn(async move { hub.subscribe(path).await })
    }

    #[tokio::test]
    async fn native_watcher_reports_external_file_changes() {
        let root = TempDir::new().unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);
        let mut subscription = hub.subscribe("").await.unwrap();

        tokio::time::sleep(Duration::from_millis(300)).await;
        fs::write(root.path().join("live.txt"), "changed").unwrap();
        let change = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let WatchMessage::Change(change) = subscription.recv().await.unwrap()
                    && change.paths.iter().any(|path| path == "live.txt")
                {
                    return change;
                }
            }
        })
        .await
        .expect("native watcher change");

        assert!(!change.overflow);
    }

    #[tokio::test]
    async fn quiet_debounce_combines_nearby_changes() {
        let root = TempDir::new().unwrap();
        let config = config(root.path(), None);
        let (raw_sender, raw_receiver) = mpsc::unbounded_channel();
        let (sender, mut receiver) = broadcast::channel(4);
        let (stop_sender, stop_receiver) = oneshot::channel();
        let (shutdown, _) = broadcast::channel(1);
        tokio::spawn(run_scope(
            config,
            raw_receiver,
            sender,
            stop_receiver,
            shutdown.subscribe(),
        ));

        raw_sender
            .send(event(
                EventKind::Create(CreateKind::File),
                root.path().join("first.txt"),
            ))
            .unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        raw_sender
            .send(event(
                EventKind::Modify(ModifyKind::Any),
                root.path().join("second.txt"),
            ))
            .unwrap();

        let WatchMessage::Change(change) =
            tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .expect("debounced change")
                .unwrap()
        else {
            panic!("expected change");
        };
        assert_eq!(change.paths, vec!["first.txt", "second.txt"]);
        let _ = stop_sender.send(());
    }

    #[tokio::test]
    async fn continuous_changes_flush_at_the_max_batch_latency() {
        let root = TempDir::new().unwrap();
        let root_path = root.path().to_path_buf();
        let config = config(root.path(), None);
        let (raw_sender, raw_receiver) = mpsc::unbounded_channel();
        let (sender, mut receiver) = broadcast::channel(4);
        let (stop_sender, stop_receiver) = oneshot::channel();
        let (shutdown, _) = broadcast::channel(1);
        tokio::spawn(run_scope(
            config,
            raw_receiver,
            sender,
            stop_receiver,
            shutdown.subscribe(),
        ));
        tokio::spawn(async move {
            for index in 0..30 {
                let _ = raw_sender.send(event(
                    EventKind::Modify(ModifyKind::Any),
                    root_path.join(format!("{index}.txt")),
                ));
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });

        let WatchMessage::Change(change) =
            tokio::time::timeout(Duration::from_secs(2), receiver.recv())
                .await
                .expect("maximum latency change")
                .unwrap()
        else {
            panic!("expected change");
        };
        assert!(!change.paths.is_empty());
        let _ = stop_sender.send(());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_watch_scopes_that_escape_the_root_through_symlinks() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), root.path().join("outside")).unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);

        assert!(matches!(
            hub.subscribe("outside").await,
            Err(WatchError::Fs(FsError::PathEscapesRoot))
        ));
    }
}
