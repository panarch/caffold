//! The children a runner is responsible for, written down where its successor
//! can find them.
//!
//! The runner already holds that a child does not outlive the runner
//! supervising it: nothing could reach one afterwards, and it would hold a
//! conversation open that no client could join. Shutting down acts on that. But
//! shutting down is code, and a process that is killed outright does not run
//! any — so the children of a runner that crashed go on running, reparented,
//! with the pipes to them gone. The next client to ask for one of those
//! conversations is told there is no session, and starts a second agent on the
//! same conversation while the first is still writing to it.
//!
//! So the rule is kept at the other end instead, where there is always a
//! process to keep it: a runner that starts owns nothing from before, and ends
//! whatever the last one left.

use std::path::{Path, PathBuf};

const CHILDREN: &str = "children";

pub struct Leftovers {
    directory: PathBuf,
}

impl Leftovers {
    /// The record kept alongside a runner's socket.
    pub fn beside(socket: &Path) -> Self {
        let directory = socket
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(CHILDREN);
        Self { directory }
    }

    /// End every child the last runner left behind, and forget them.
    ///
    /// Called before serving, so no client can be told about a session while
    /// the process behind an older one of the same name is still running.
    pub async fn clear(&self) {
        let Ok(mut entries) = tokio::fs::read_dir(&self.directory).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let Some(pid) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.parse::<u32>().ok())
            else {
                let _ = tokio::fs::remove_file(&path).await;
                continue;
            };
            let started = tokio::fs::read_to_string(&path).await.unwrap_or_default();
            if is_the_same_process(pid, started.trim()).await {
                end(pid).await;
            }
            let _ = tokio::fs::remove_file(&path).await;
        }
    }

    /// Write down a child this runner has started.
    ///
    /// Kept under the number rather than the session, because the number is
    /// what the next runner has to act on and a session name is a client's to
    /// choose. What is written under it is when that process started, which is
    /// what tells it apart from whatever is given the number after it goes.
    pub async fn remember(&self, pid: u32) {
        let Some(started) = started_at(pid).await else {
            return;
        };
        self.write_record(pid, &started).await;
    }

    async fn write_record(&self, pid: u32, started: &str) {
        if tokio::fs::create_dir_all(&self.directory).await.is_err() {
            return;
        }
        let _ = tokio::fs::write(self.directory.join(pid.to_string()), started).await;
    }

    /// Forget a child this runner has ended itself.
    pub async fn forget(&self, pid: u32) {
        let _ = tokio::fs::remove_file(self.directory.join(pid.to_string())).await;
    }
}

/// Whether the process answering to this number is the one written down.
///
/// Numbers are reused, and a crash is exactly when a stale one is most likely
/// to have been handed to something else — so the number alone is not enough to
/// end anything on. When a process started is what tells one apart from its
/// successor, and it is asked of the same system in the same words both times.
///
/// What the process is running is deliberately not compared. A child may be a
/// script, and the system reports those under the interpreter running them, so
/// a comparison against what the runner was asked to start would answer no for
/// exactly the children it is answerable for.
async fn is_the_same_process(pid: u32, started: &str) -> bool {
    !started.is_empty() && started_at(pid).await.as_deref() == Some(started)
}

/// When the process answering to this number started, in the system's own
/// words. Absent if nothing answers to it.
async fn started_at(pid: u32) -> Option<String> {
    let output = tokio::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "lstart="])
        .output()
        .await
        .ok()?;
    let started = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!started.is_empty()).then_some(started)
}

/// End a child outright.
///
/// Nothing holds a handle to this process and nothing can speak to it, so there
/// is no gentler request to make of it and nothing to wait for it to finish
/// saying. Asked of the system the same way it was asked about, which keeps the
/// runner free of a dependency for two calls made once at startup.
async fn end(pid: u32) {
    let _ = tokio::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .await;
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A data directory of this test's own, removed when it is done with.
    struct DataDirectory(PathBuf);

    impl DataDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "caffold-leftovers-{}-{}",
                std::process::id(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).expect("a data directory");
            Self(path)
        }

        fn socket(&self) -> PathBuf {
            self.0.join("claude-runner.sock")
        }
    }

    impl Drop for DataDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A process of our own that will outlive the test unless it is ended.
    async fn a_long_lived_child() -> (tokio::process::Child, u32) {
        let child = tokio::process::Command::new("/bin/sleep")
            .arg("600")
            .spawn()
            .expect("start a child");
        let pid = child.id().expect("a running child has a number");
        (child, pid)
    }

    #[tokio::test]
    async fn a_child_left_by_the_last_runner_is_ended() {
        let directory = DataDirectory::new();
        let leftovers = Leftovers::beside(&directory.socket());
        let (mut child, pid) = a_long_lived_child().await;
        leftovers.remember(pid).await;

        leftovers.clear().await;

        let ended = tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .expect("the child is ended rather than left running");
        assert!(ended.is_ok());
        assert!(
            started_at(pid).await.is_none(),
            "and nothing answers for it afterwards"
        );
    }

    #[tokio::test]
    async fn what_was_ended_is_not_looked_for_again() {
        // A record outliving the child it names would have the next runner act
        // on a number that now belongs to something else.
        let directory = DataDirectory::new();
        let leftovers = Leftovers::beside(&directory.socket());
        let (mut child, pid) = a_long_lived_child().await;
        leftovers.remember(pid).await;

        leftovers.clear().await;
        let _ = child.wait().await;

        assert!(
            !leftovers.directory.join(pid.to_string()).exists(),
            "the record goes with the child"
        );
    }

    #[tokio::test]
    async fn a_number_now_answering_for_something_else_is_left_alone() {
        // Numbers are reused, and a crash is when a stale one is most likely to
        // have been handed on. Ending one on the strength of the number alone
        // would end whatever happened to be given it, so the record has to say
        // which process had the number and not only that something did.
        let directory = DataDirectory::new();
        let leftovers = Leftovers::beside(&directory.socket());
        let (mut child, pid) = a_long_lived_child().await;
        // A record left by a process that has since gone, whose number this
        // one was given afterwards.
        leftovers
            .write_record(pid, "Thu Jan  1 00:00:00 1970")
            .await;

        leftovers.clear().await;

        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(500), child.wait())
                .await
                .is_err(),
            "a process this runner never started is not this runner's to end"
        );
        let _ = child.kill().await;
    }

    #[tokio::test]
    async fn a_runner_starting_where_none_ran_has_nothing_to_end() {
        let directory = DataDirectory::new();
        let leftovers = Leftovers::beside(&directory.socket());

        leftovers.clear().await;
    }

    #[tokio::test]
    async fn a_child_this_runner_ended_is_forgotten() {
        let directory = DataDirectory::new();
        let leftovers = Leftovers::beside(&directory.socket());
        leftovers.write_record(4242, "whenever").await;

        leftovers.forget(4242).await;

        assert!(!leftovers.directory.join("4242").exists());
    }
}
