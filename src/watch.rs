use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use thiserror::Error;
use tokio::{
    sync::{broadcast, mpsc, oneshot},
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
pub struct WatchReady {
    pub revision: u64,
    pub scope_path: String,
    pub repository_root_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WatchChange {
    pub revision: u64,
    pub paths: Vec<String>,
    pub git_status_changed: bool,
    pub git_refs_changed: bool,
    pub overflow: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WatchMessage {
    Change(WatchChange),
    Error(String),
}

#[derive(Debug, Error)]
pub enum WatchError {
    #[error(transparent)]
    Fs(#[from] FsError),
    #[error("native filesystem watcher is unavailable: {0}")]
    Unavailable(String),
}

#[derive(Clone)]
pub struct WatchHub {
    inner: Arc<WatchHubInner>,
}

struct WatchHubInner {
    fs: Arc<RootedFs>,
    shutdown: broadcast::Sender<()>,
    scopes: Mutex<HashMap<String, ScopeEntry>>,
}

struct ScopeEntry {
    scope: WatchScope,
    subscribers: usize,
}

struct WatchScope {
    ready: WatchReady,
    sender: broadcast::Sender<WatchMessage>,
    _watcher: Mutex<RecommendedWatcher>,
    stop: Mutex<Option<oneshot::Sender<()>>>,
}

impl Drop for WatchScope {
    fn drop(&mut self) {
        if let Ok(mut stop) = self.stop.lock()
            && let Some(stop) = stop.take()
        {
            let _ = stop.send(());
        }
    }
}

pub struct WatchSubscription {
    hub: Weak<WatchHubInner>,
    key: String,
    pub ready: WatchReady,
    receiver: broadcast::Receiver<WatchMessage>,
}

impl WatchSubscription {
    pub async fn recv(&mut self) -> Result<WatchMessage, broadcast::error::RecvError> {
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
        let remove = scopes.get_mut(&self.key).is_some_and(|entry| {
            if entry.subscribers > 1 {
                entry.subscribers -= 1;
                false
            } else {
                true
            }
        });
        if remove {
            scopes.remove(&self.key);
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
    pub fn new(fs: Arc<RootedFs>, shutdown: broadcast::Sender<()>) -> Self {
        Self {
            inner: Arc::new(WatchHubInner {
                fs,
                shutdown,
                scopes: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn subscribe(&self, requested_path: &str) -> Result<WatchSubscription, WatchError> {
        let config = self.scope_config(requested_path)?;
        let key = config.scope_path.clone();
        let mut scopes =
            self.inner.scopes.lock().map_err(|_| {
                WatchError::Unavailable("watch registry is unavailable".to_string())
            })?;

        if let Some(entry) = scopes.get_mut(&key) {
            entry.subscribers += 1;
            return Ok(WatchSubscription {
                hub: Arc::downgrade(&self.inner),
                key,
                ready: entry.scope.ready.clone(),
                receiver: entry.scope.sender.subscribe(),
            });
        }

        let scope = self.start_scope(config)?;
        let ready = scope.ready.clone();
        let receiver = scope.sender.subscribe();
        scopes.insert(
            key.clone(),
            ScopeEntry {
                scope,
                subscribers: 1,
            },
        );

        Ok(WatchSubscription {
            hub: Arc::downgrade(&self.inner),
            key,
            ready,
            receiver,
        })
    }

    fn scope_config(&self, requested_path: &str) -> Result<ScopeConfig, WatchError> {
        let requested = self.inner.fs.absolute_directory_path(requested_path)?;
        let repository = git::repository_for(&requested)
            .filter(|repository| repository.root.starts_with(self.inner.fs.root()));
        let watch_root = repository
            .as_ref()
            .map(|repository| repository.root.clone())
            .unwrap_or(requested);
        let scope_path = self.inner.fs.logical_path_for_absolute(&watch_root)?;
        let repository_root_path = repository.as_ref().map(|_| scope_path.clone());
        let metadata_paths = repository.as_ref().and_then(git::repository_metadata_paths);

        Ok(ScopeConfig {
            fs_root: self.inner.fs.root().to_path_buf(),
            watch_root,
            scope_path,
            repository,
            repository_root_path,
            metadata_paths,
        })
    }

    fn start_scope(&self, config: ScopeConfig) -> Result<WatchScope, WatchError> {
        let (raw_sender, raw_receiver) = mpsc::unbounded_channel();
        let mut watcher = notify::recommended_watcher(move |event| {
            let _ = raw_sender.send(event);
        })
        .map_err(|error| WatchError::Unavailable(error.to_string()))?;

        register_watch_paths(&mut watcher, &config)
            .map_err(|error| WatchError::Unavailable(error.to_string()))?;

        let (sender, _) = broadcast::channel(128);
        let (stop_sender, stop_receiver) = oneshot::channel();
        let shutdown = self.inner.shutdown.subscribe();
        tokio::spawn(run_scope(
            config.clone(),
            raw_receiver,
            sender.clone(),
            stop_receiver,
            shutdown,
        ));

        Ok(WatchScope {
            ready: WatchReady {
                revision: 1,
                scope_path: config.scope_path,
                repository_root_path: config.repository_root_path,
            },
            sender,
            _watcher: Mutex::new(watcher),
            stop: Mutex::new(Some(stop_sender)),
        })
    }

    #[cfg(test)]
    fn active_scope_count(&self) -> usize {
        self.inner.scopes.lock().unwrap().len()
    }
}

fn register_watch_paths(
    watcher: &mut RecommendedWatcher,
    config: &ScopeConfig,
) -> notify::Result<()> {
    let recursive = config.repository.is_some();
    watcher.watch(
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
        watcher.watch(root, RecursiveMode::NonRecursive)?;
        let refs = root.join("refs");
        if refs.is_dir() && watched.insert(refs.clone()) {
            watcher.watch(&refs, RecursiveMode::Recursive)?;
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

        match normalize_batch(&config, pending) {
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
    let mut paths = BTreeSet::new();
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
            if paths.len() < MAX_BATCH_PATHS {
                paths.insert(logical_path);
            } else {
                overflow = true;
            }

            if let Some(repository) = config.repository.as_ref()
                && let Ok(relative) = path.strip_prefix(&repository.root)
            {
                let relative = slash_path(relative);
                if relative.is_empty() {
                    git_status_changed = true;
                } else {
                    repo_relative_paths.insert(relative);
                }
            }
        }
    }

    if let Some(repository) = config.repository.as_ref()
        && !repo_relative_paths.is_empty()
    {
        let ignored = git::ignored_paths(repository, repo_relative_paths.iter().cloned());
        git_status_changed |= repo_relative_paths
            .iter()
            .any(|path| !ignored.contains(path));
    }

    if paths.is_empty() && !git_status_changed && !git_refs_changed && !overflow {
        return Ok(None);
    }

    Ok(Some(WatchChange {
        revision: 0,
        paths: paths.into_iter().collect(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
    use std::{fs, process::Command};
    use tempfile::TempDir;

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
        fs::write(root.path().join(".gitignore"), "ignored.log\n").unwrap();
        let config = config(root.path(), Some(repository));

        let change = normalize_batch(
            &config,
            vec![event(
                EventKind::Modify(ModifyKind::Any),
                root.path().join("ignored.log"),
            )],
        )
        .unwrap()
        .unwrap();

        assert_eq!(change.paths, vec!["ignored.log"]);
        assert!(!change.git_status_changed);
        assert!(!change.git_refs_changed);
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

        let first = hub.subscribe("").unwrap();
        let second = hub.subscribe("").unwrap();
        assert_eq!(hub.active_scope_count(), 1);
        assert_eq!(first.ready, second.ready);

        drop(first);
        assert_eq!(hub.active_scope_count(), 1);
        drop(second);
        assert_eq!(hub.active_scope_count(), 0);
    }

    #[tokio::test]
    async fn native_watcher_reports_external_file_changes() {
        let root = TempDir::new().unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);
        let mut subscription = hub.subscribe("").unwrap();

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
    #[test]
    fn rejects_watch_scopes_that_escape_the_root_through_symlinks() {
        use std::os::unix::fs::symlink;

        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        symlink(outside.path(), root.path().join("outside")).unwrap();
        let fs = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let hub = WatchHub::new(fs, shutdown);

        assert!(matches!(
            hub.subscribe("outside"),
            Err(WatchError::Fs(FsError::PathEscapesRoot))
        ));
    }
}
