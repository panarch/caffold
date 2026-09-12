//! Where a Task's Grok session is: the binding file.
//!
//! A Caffold Task keeps one identifier for life, and a Grok session changes
//! its own when it is forked into a worktree. The binding is the address that
//! joins the two: which native session the Task runs on now, where that
//! session works, which earlier sessions the Task left behind, and — while a
//! worktree switch is under way — how far it got. It is Caffold's recovery
//! data, not conversation state: nothing in it says what the agent did.
//!
//! One file per Task under the data directory, replaced atomically and only
//! ever by one writer at a time in this process. A Task whose row says Grok
//! but whose file is missing or unreadable is a Task in need of recovery,
//! not one to guess a session for.

use std::{
    collections::HashMap,
    fs, io,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use uuid::Uuid;

use super::GrokError;

const FORMAT_VERSION: u32 = 1;

#[derive(Clone)]
pub(super) struct BindingStore {
    dir: PathBuf,
    /// One writer per Task at a time. Held across read-modify-write so two
    /// transitions cannot interleave on the same file.
    writers: Arc<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Binding {
    pub(super) version: u32,
    pub(super) thread_id: String,
    /// Incremented on every write, so a completion that started against an
    /// older binding can be told apart from one that did not.
    pub(super) generation: u64,
    pub(super) current: NativeSession,
    /// Sessions this Task ran on before, oldest first. Kept so that deleting
    /// the Task can delete exactly what it created.
    #[serde(default)]
    pub(super) history: Vec<ClosedSession>,
    /// A worktree switch in progress, or none.
    #[serde(default)]
    pub(super) switch: Option<Switch>,
}

/// The persisted node of the switch control graph, with what the graph
/// needs to carry on from it after a restart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Switch {
    #[serde(flatten)]
    pub(super) phase: SwitchPhase,
    pub(super) target_cwd: String,
    /// The session id chosen for the fork, decided before the fork is asked
    /// for so that a lost answer can be looked up rather than repeated.
    pub(super) new_session_id: String,
    pub(super) source_session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub(super) enum SwitchPhase {
    /// The worktree stands; the fork waits for the running turn to end.
    Pending,
    /// The copy is named; it is being looked up or asked for.
    Forking,
    /// The copy exists; it is being loaded and checked against the target.
    Verifying,
    /// The Task runs on the copy; the source is being closed.
    ClosingSource,
    /// The switch stopped short. A person opening or prompting the Task
    /// retries it; nothing retries on its own.
    RecoveryRequired { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeSession {
    pub(super) session_id: String,
    pub(super) cwd: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClosedSession {
    pub(super) session_id: String,
    pub(super) cwd: String,
    /// `session/close` has not succeeded for it yet.
    #[serde(default)]
    pub(super) close_pending: bool,
}

impl BindingStore {
    pub(super) fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            writers: Arc::new(AsyncMutex::new(HashMap::new())),
        }
    }

    #[cfg(test)]
    pub(super) fn dir(&self) -> &Path {
        &self.dir
    }

    /// Write a Task's first binding. Refuses to overwrite one that exists.
    pub(super) async fn create(
        &self,
        thread_id: &str,
        session_id: &str,
        cwd: &str,
    ) -> Result<Binding, GrokError> {
        let _writer = self.writer(thread_id).await;
        let path = self.path(thread_id)?;
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            return Err(GrokError::Binding(format!(
                "Task {thread_id} already has a Grok binding"
            )));
        }
        let binding = Binding {
            version: FORMAT_VERSION,
            thread_id: thread_id.to_string(),
            generation: 1,
            current: NativeSession {
                session_id: session_id.to_string(),
                cwd: cwd.to_string(),
            },
            history: Vec::new(),
            switch: None,
        };
        write_atomically(&path, &binding).await?;
        Ok(binding)
    }

    /// The binding, or `None` when the Task has never had one. A file that
    /// exists but cannot be read is an error, never `None`.
    pub(super) async fn read(&self, thread_id: &str) -> Result<Option<Binding>, GrokError> {
        let path = self.path(thread_id)?;
        read_binding(&path, thread_id).await
    }

    /// Change a binding in one step, while the file still stands at
    /// generation `expected`. The change is applied to the file's current
    /// contents under the Task's writer lock and the generation advances with
    /// the write, so a change decided against an older binding is refused.
    pub(super) async fn update_if(
        &self,
        thread_id: &str,
        expected: u64,
        change: impl FnOnce(&mut Binding),
    ) -> Result<Binding, GrokError> {
        let _writer = self.writer(thread_id).await;
        let path = self.path(thread_id)?;
        let mut binding = read_binding(&path, thread_id)
            .await?
            .ok_or_else(|| GrokError::Binding(format!("Task {thread_id} has no Grok binding")))?;
        if binding.generation != expected {
            return Err(GrokError::Binding(format!(
                "the binding of Task {thread_id} changed underneath: generation {} now, {expected} expected",
                binding.generation
            )));
        }
        change(&mut binding);
        binding.generation = binding.generation.saturating_add(1);
        write_atomically(&path, &binding).await?;
        Ok(binding)
    }

    pub(super) async fn remove(&self, thread_id: &str) -> Result<(), GrokError> {
        let _writer = self.writer(thread_id).await;
        let path = self.path(thread_id)?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(GrokError::Binding(format!(
                "cannot remove {}: {error}",
                path.display()
            ))),
        }
    }

    fn path(&self, thread_id: &str) -> Result<PathBuf, GrokError> {
        // Only a UUID may name a file here; anything else could name a path.
        Uuid::parse_str(thread_id)
            .map_err(|_| GrokError::Binding(format!("{thread_id:?} is not a Task identifier")))?;
        Ok(self.dir.join(format!("{thread_id}.json")))
    }

    async fn writer(&self, thread_id: &str) -> OwnedMutexGuard<()> {
        let lock = self
            .writers
            .lock()
            .await
            .entry(thread_id.to_string())
            .or_default()
            .clone();
        lock.lock_owned().await
    }
}

async fn read_binding(path: &Path, thread_id: &str) -> Result<Option<Binding>, GrokError> {
    let contents = match tokio::fs::read(path).await {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(GrokError::Binding(format!(
                "cannot read {}: {error}",
                path.display()
            )));
        }
    };
    let binding: Binding = serde_json::from_slice(&contents).map_err(|error| {
        GrokError::Binding(format!(
            "the Grok binding for Task {thread_id} cannot be read: {error}"
        ))
    })?;
    if binding.version != FORMAT_VERSION {
        return Err(GrokError::Binding(format!(
            "the Grok binding for Task {thread_id} is version {}, and this release reads {FORMAT_VERSION}",
            binding.version
        )));
    }
    if binding.thread_id != thread_id {
        return Err(GrokError::Binding(format!(
            "the Grok binding file for Task {thread_id} names Task {}",
            binding.thread_id
        )));
    }
    Ok(Some(binding))
}

/// Write the whole file beside its final name and rename it into place, so a
/// reader sees either the old binding or the new one and never a torn one.
async fn write_atomically(path: &Path, binding: &Binding) -> Result<(), GrokError> {
    let path = path.to_path_buf();
    let contents = serde_json::to_vec_pretty(binding)
        .map_err(|error| GrokError::Binding(format!("cannot encode the binding: {error}")))?;
    tokio::task::spawn_blocking(move || -> io::Result<()> {
        use std::io::Write;
        let dir = path.parent().expect("binding paths have a directory");
        fs::create_dir_all(dir)?;
        let staged = dir.join(format!(
            ".{}.tmp-{}",
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("binding"),
            Uuid::new_v4()
        ));
        let mut file = fs::File::create(&staged)?;
        file.write_all(&contents)?;
        file.sync_all()?;
        drop(file);
        if let Err(error) = fs::rename(&staged, &path) {
            let _ = fs::remove_file(&staged);
            return Err(error);
        }
        fs::File::open(dir).and_then(|dir| dir.sync_all())
    })
    .await
    .map_err(|error| GrokError::Binding(format!("the binding writer stopped: {error}")))?
    .map_err(|error| GrokError::Binding(format!("cannot write the binding: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const THREAD: &str = "01a09482-370e-7001-a329-9a7d78be2cb8";

    fn store() -> (tempfile::TempDir, BindingStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = BindingStore::new(dir.path().join("grok/bindings"));
        (dir, store)
    }

    #[tokio::test]
    async fn a_binding_is_created_read_changed_and_removed() {
        let (_dir, store) = store();
        assert_eq!(store.read(THREAD).await.unwrap(), None);
        let created = store.create(THREAD, THREAD, "/work/source").await.unwrap();
        assert_eq!(created.generation, 1);
        assert_eq!(created.current.session_id, THREAD);
        assert_eq!(store.read(THREAD).await.unwrap(), Some(created.clone()));
        assert!(store.create(THREAD, "other", "/x").await.is_err());

        assert!(
            matches!(
                store.update_if(THREAD, 5, |_| {}).await,
                Err(GrokError::Binding(_))
            ),
            "a change decided against another generation is refused"
        );
        let changed = store
            .update_if(THREAD, created.generation, |binding| {
                binding.history.push(ClosedSession {
                    session_id: "older".to_string(),
                    cwd: "/work".to_string(),
                    close_pending: true,
                });
            })
            .await
            .unwrap();
        assert_eq!(changed.generation, 2);
        assert_eq!(store.read(THREAD).await.unwrap(), Some(changed));

        store.remove(THREAD).await.unwrap();
        assert_eq!(store.read(THREAD).await.unwrap(), None);
        store.remove(THREAD).await.unwrap();
    }

    #[tokio::test]
    async fn a_file_that_cannot_be_read_is_an_error_not_a_missing_binding() {
        let (_dir, store) = store();
        fs::create_dir_all(store.dir()).unwrap();
        fs::write(store.dir().join(format!("{THREAD}.json")), b"{ not json").unwrap();
        assert!(matches!(
            store.read(THREAD).await,
            Err(GrokError::Binding(_))
        ));
        assert!(matches!(
            store.update_if(THREAD, 1, |_| {}).await,
            Err(GrokError::Binding(_))
        ));

        let other = Binding {
            version: FORMAT_VERSION,
            thread_id: "00000000-0000-0000-0000-000000000000".to_string(),
            generation: 1,
            current: NativeSession {
                session_id: "x".to_string(),
                cwd: "/x".to_string(),
            },
            history: Vec::new(),
            switch: None,
        };
        fs::write(
            store.dir().join(format!("{THREAD}.json")),
            serde_json::to_vec(&other).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            store.read(THREAD).await,
            Err(GrokError::Binding(_))
        ));
    }

    #[tokio::test]
    async fn only_a_uuid_may_name_a_binding_file() {
        let (_dir, store) = store();
        assert!(matches!(
            store.read("../etc/passwd").await,
            Err(GrokError::Binding(_))
        ));
        assert!(matches!(
            store.create("thread-1", "s", "/x").await,
            Err(GrokError::Binding(_))
        ));
    }

    #[tokio::test]
    async fn writers_take_turns_and_every_write_advances_the_generation() {
        let (_dir, store) = store();
        store.create(THREAD, THREAD, "/work").await.unwrap();
        let mut writers = Vec::new();
        for i in 0..8u64 {
            let store = store.clone();
            writers.push(tokio::spawn(async move {
                // Each writer changes what it read, and reads again when
                // another writer got there first.
                loop {
                    let seen = store.read(THREAD).await.unwrap().unwrap();
                    let written = store
                        .update_if(THREAD, seen.generation, |binding| {
                            binding.history.push(ClosedSession {
                                session_id: format!("s{i}"),
                                cwd: "/work".to_string(),
                                close_pending: false,
                            });
                        })
                        .await;
                    if let Ok(written) = written {
                        break written;
                    }
                }
            }));
        }
        for writer in writers {
            writer.await.unwrap();
        }
        let binding = store.read(THREAD).await.unwrap().unwrap();
        assert_eq!(binding.generation, 9);
        assert_eq!(binding.history.len(), 8);
        // No staged file is left behind.
        let leftovers = fs::read_dir(store.dir())
            .unwrap()
            .filter(|entry| {
                entry
                    .as_ref()
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".tmp-")
            })
            .count();
        assert_eq!(leftovers, 0);
    }
}
