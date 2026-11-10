//! Updating the installed Caffold to a newer release.
//!
//! `caffold update` installs the new release while the current one keeps
//! running, restarts Caffold on it, and goes back to the current version when
//! the new one does not start. How it installs and restarts follows how
//! Caffold is installed: the Caffold Server app through Homebrew on macOS, a
//! version directory and the systemd service on Linux. Each attempt is
//! recorded in the data directory's `caffold-updates`, where the server reads
//! the outcome. The server also asks GitHub for the newest release.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod mac;
mod process;
mod records;
mod release;

use std::{
    fs,
    io::{self, Write},
    process::ExitCode,
    time::Duration,
};

#[cfg(target_os = "linux")]
use linux::{self as installed, LinuxHost as SystemHost};
#[cfg(target_os = "macos")]
use mac::{self as installed, MacHost as SystemHost};

#[cfg(target_os = "linux")]
pub(crate) use linux::{UpdateRequest, caffold_link};
#[cfg(target_os = "macos")]
pub(crate) use mac::{HomebrewRecord, UpdateRequest, homebrew_record};
pub(crate) use process::process_alive;
pub(crate) use records::{Attempt, AttemptOutcome, AttemptRecords};
pub(crate) use release::{LatestRelease, fetch_latest_release};

/// The data directory's update records. An update Task works here too.
pub(crate) const UPDATES_DIRECTORY: &str = "caffold-updates";

/// How long `caffold update` waits for its worker to take the attempt over.
const WORKER_START_POLLS: u32 = 40;
const FOLLOW_INTERVAL: Duration = Duration::from_secs(1);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(2);

/// Starts an attempt and reports it until it ends, or, as the worker that
/// `caffold update` starts, runs `attempt` to its outcome.
pub(crate) async fn run(request: UpdateRequest, attempt: Option<String>) -> ExitCode {
    let records = AttemptRecords::new(request.data_dir.join(UPDATES_DIRECTORY));
    let updated = match attempt {
        Some(id) => {
            installed::run_attempt(&SystemHost, &records, &request, &id).await;
            true
        }
        None => installed::start(&SystemHost, &records, &request, &mut io::stdout()).await,
    };
    if updated {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// What following and running an attempt ask of the system: this process,
/// whether another one is alive, and time.
trait Processes {
    fn pid(&self) -> u32 {
        std::process::id()
    }

    fn alive(&self, pid: u32) -> bool {
        process_alive(pid)
    }

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

/// Prints the worker's log as it grows, then the outcome in `result_line`'s
/// words. Returns whether Caffold ended up updated or already current.
async fn follow(
    processes: &impl Processes,
    records: &AttemptRecords,
    started: Attempt,
    out: &mut impl Write,
    result_line: fn(&AttemptRecords, &Attempt) -> String,
) -> bool {
    let mut printed = 0;
    let mut waited_for_worker = 0;
    loop {
        processes.sleep(FOLLOW_INTERVAL).await;
        printed = print_new_log(records, &started.id, printed, out);
        let Ok(attempt) = records.load(&started.id) else {
            note(out, "The record of this update disappeared.");
            return false;
        };
        if attempt.outcome != AttemptOutcome::Running {
            note(out, &result_line(records, &attempt));
            return matches!(
                attempt.outcome,
                AttemptOutcome::Succeeded | AttemptOutcome::UpToDate
            );
        }
        if attempt.pid == processes.pid() {
            waited_for_worker += 1;
            if waited_for_worker >= WORKER_START_POLLS {
                let mut attempt = attempt;
                attempt.finish(
                    AttemptOutcome::Interrupted,
                    Some("The update did not start".to_string()),
                );
                let _ = records.save(&attempt);
                let _ = records.release(&attempt.id);
                note(out, "The update did not start.");
                return false;
            }
        } else if !processes.alive(attempt.pid) {
            note(
                out,
                "The update stopped before it finished. The next update marks it interrupted.",
            );
            return false;
        }
    }
}

fn print_new_log(
    records: &AttemptRecords,
    id: &str,
    printed: usize,
    out: &mut impl Write,
) -> usize {
    let Ok(log) = fs::read_to_string(records.log(id)) else {
        return printed;
    };
    if let Some(new) = log.get(printed..)
        && !new.is_empty()
    {
        let _ = out.write_all(new.as_bytes());
        let _ = out.flush();
    }
    log.len()
}

/// Removes an attempt that never changed anything.
fn abandon(records: &AttemptRecords, attempt: &Attempt) {
    let _ = fs::remove_dir_all(records.directory(&attempt.id));
    let _ = records.release(&attempt.id);
}

/// The version the server on `port` answers with.
async fn server_version(port: u16) -> Option<String> {
    let response = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/api/health"))
        .timeout(HEALTH_TIMEOUT)
        .send()
        .await
        .ok()?;
    let body = response.bytes().await.ok()?;
    let health = serde_json::from_slice::<serde_json::Value>(&body).ok()?;
    health["version"].as_str().map(str::to_string)
}

/// The worker's output is its log.
fn log(line: &str) {
    let _ = writeln!(io::stdout(), "{line}");
}

fn note(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN_PID: u32 = 100;
    const WORKER_PID: u32 = 200;

    /// This process is `OWN_PID`, and only it and the worker are alive.
    struct FakeProcesses;

    impl Processes for FakeProcesses {
        fn pid(&self) -> u32 {
            OWN_PID
        }

        fn alive(&self, pid: u32) -> bool {
            pid == WORKER_PID || pid == OWN_PID
        }

        async fn sleep(&self, _duration: Duration) {}
    }

    fn records() -> (tempfile::TempDir, AttemptRecords) {
        let directory = tempfile::tempdir().unwrap();
        let records = AttemptRecords::new(directory.path().join(UPDATES_DIRECTORY));
        (directory, records)
    }

    fn outcome_line(_records: &AttemptRecords, attempt: &Attempt) -> String {
        format!(
            "Result: {:?} because {}.",
            attempt.outcome,
            attempt.reason.as_deref().unwrap_or("nothing")
        )
    }

    #[tokio::test]
    async fn follows_the_worker_and_reports_its_outcome() {
        let (_directory, records) = records();
        let mut started = records
            .begin("0.18.2".to_string(), false, OWN_PID, |pid| {
                FakeProcesses.alive(pid)
            })
            .unwrap();
        fs::write(records.log(&started.id), "Downloading Caffold 0.18.3.\n").unwrap();
        started.pid = WORKER_PID;
        started.to_version = Some("0.18.3".to_string());
        started.finish(
            AttemptOutcome::RolledBack,
            Some("0.18.3 could not start".to_string()),
        );
        records.save(&started).unwrap();
        let mut out = Vec::new();

        assert!(!follow(&FakeProcesses, &records, started, &mut out, outcome_line).await);

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Downloading Caffold 0.18.3.\nResult: RolledBack because 0.18.3 could not start.\n"
        );
    }

    #[tokio::test]
    async fn reports_an_update_or_a_current_version_as_success() {
        for outcome in [AttemptOutcome::Succeeded, AttemptOutcome::UpToDate] {
            let (_directory, records) = records();
            let mut started = records
                .begin("0.18.2".to_string(), false, OWN_PID, |pid| {
                    FakeProcesses.alive(pid)
                })
                .unwrap();
            started.pid = WORKER_PID;
            started.finish(outcome, None);
            records.save(&started).unwrap();

            assert!(
                follow(
                    &FakeProcesses,
                    &records,
                    started,
                    &mut Vec::new(),
                    outcome_line
                )
                .await
            );
        }
    }

    #[tokio::test]
    async fn gives_up_on_a_worker_that_never_takes_the_attempt_over() {
        let (_directory, records) = records();
        let started = records
            .begin("0.18.2".to_string(), false, OWN_PID, |pid| {
                FakeProcesses.alive(pid)
            })
            .unwrap();
        let mut out = Vec::new();

        assert!(
            !follow(
                &FakeProcesses,
                &records,
                started.clone(),
                &mut out,
                outcome_line
            )
            .await
        );

        let attempt = records.load(&started.id).unwrap();
        assert_eq!(attempt.outcome, AttemptOutcome::Interrupted);
        assert_eq!(attempt.reason.as_deref(), Some("The update did not start"));
        assert_eq!(
            String::from_utf8(out).unwrap(),
            "The update did not start.\n"
        );
    }

    #[tokio::test]
    async fn notices_a_worker_that_went_away() {
        let (_directory, records) = records();
        let mut started = records
            .begin("0.18.2".to_string(), false, OWN_PID, |pid| {
                FakeProcesses.alive(pid)
            })
            .unwrap();
        started.pid = 300;
        records.save(&started).unwrap();
        let mut out = Vec::new();

        assert!(!follow(&FakeProcesses, &records, started, &mut out, outcome_line).await);

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "The update stopped before it finished. The next update marks it interrupted.\n"
        );
    }

    #[test]
    fn abandoning_an_attempt_removes_it_and_its_lock() {
        let (_directory, records) = records();
        let started = records
            .begin("0.18.2".to_string(), false, OWN_PID, |pid| {
                FakeProcesses.alive(pid)
            })
            .unwrap();

        abandon(&records, &started);

        assert!(!records.directory(&started.id).exists());
        assert_eq!(records.latest_finished().unwrap(), None);
        assert!(
            records
                .begin("0.18.2".to_string(), false, OWN_PID, |pid| {
                    FakeProcesses.alive(pid)
                })
                .is_ok()
        );
    }

    #[tokio::test]
    async fn reads_the_version_a_server_answers_with() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = axum::Router::new().route(
            "/api/health",
            axum::routing::get(|| async { axum::Json(serde_json::json!({"version": "0.18.3"})) }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        assert_eq!(server_version(port).await.as_deref(), Some("0.18.3"));

        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let unused = free.local_addr().unwrap().port();
        drop(free);
        assert_eq!(server_version(unused).await, None);
    }
}
