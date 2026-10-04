use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use semver::Version;

use super::records::{Attempt, AttemptOutcome, AttemptRecords, BeginError};

/// Waits match `desktop/macos/install-local`: 20 seconds for the app to quit
/// and 30 seconds for a server to answer.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const STOP_POLLS: u32 = 80;
const SERVE_POLLS: u32 = 120;
/// How long `caffold update` waits for its worker to take the attempt over.
const WORKER_START_POLLS: u32 = 40;
const FOLLOW_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UpdateRequest {
    pub(crate) app: PathBuf,
    pub(crate) data_dir: PathBuf,
    pub(crate) port: u16,
    pub(crate) from_menu_bar: bool,
}

/// Starts an attempt and reports it until it ends. The attempt itself runs in
/// a worker apart from this process, so it finishes even if whoever ran
/// `caffold update` stops waiting. Returns whether Caffold ended up updated or
/// already current.
pub(super) async fn start(
    host: &impl Host,
    records: &AttemptRecords,
    request: &UpdateRequest,
    out: &mut impl Write,
) -> bool {
    match prepare(host, records, request).await {
        Ok(attempt) => {
            note(
                out,
                &format!(
                    "Updating Caffold {}. This attempt is recorded in {}.",
                    attempt.from_version,
                    records.directory(&attempt.id).display()
                ),
            );
            follow(host, records, attempt, out).await
        }
        Err(refusal) => {
            note(out, &refusal);
            false
        }
    }
}

/// Checks that this Caffold can update itself, records the attempt, backs the
/// app up, and hands the attempt to a worker. Nothing has changed when this
/// fails, so no attempt is left behind.
async fn prepare(
    host: &impl Host,
    records: &AttemptRecords,
    request: &UpdateRequest,
) -> Result<Attempt, String> {
    let app = &request.app;
    match host.homebrew_record().await {
        HomebrewRecord::NoHomebrew => {
            return Err(
                "Homebrew is not installed, so Caffold cannot update itself. Install the new version from its release page.".to_string(),
            );
        }
        HomebrewRecord::NotInstalled => {
            return Err(
                "This Caffold was not installed with Homebrew, so it cannot update itself. Install the new version from its release page.".to_string(),
            );
        }
        HomebrewRecord::Installed(_) => {}
    }
    if let Some(owner) = host.server_owner(request.port).await
        && !serves_from(&owner, app)
    {
        return Err(format!(
            "The server on port {} is not run by {}, so updating the app would not update it.",
            request.port,
            app.display()
        ));
    }
    let from = host.bundle_version(app).await.map_err(|error| {
        format!(
            "Caffold could not read the version of {}: {error}",
            app.display()
        )
    })?;
    let attempt = match records.begin(from.to_string(), request.from_menu_bar, host.pid(), |pid| {
        host.alive(pid)
    }) {
        Ok(attempt) => attempt,
        Err(BeginError::Busy) => {
            return Err("Another Caffold update is already running.".to_string());
        }
        Err(BeginError::Io(error)) => {
            return Err(format!("Caffold could not record the update: {error}"));
        }
    };
    if let Err(problem) = back_up(host, records, &attempt, app).await {
        abandon(records, &attempt);
        return Err(problem);
    }
    if let Err(error) = host
        .start_worker(request, &attempt.id, &records.log(&attempt.id))
        .await
    {
        abandon(records, &attempt);
        return Err(format!("Caffold could not start the update: {error}"));
    }
    Ok(attempt)
}

/// Copies the app aside after dropping the copies older attempts kept.
async fn back_up(
    host: &impl Host,
    records: &AttemptRecords,
    attempt: &Attempt,
    app: &Path,
) -> Result<(), String> {
    let retired = records
        .retired_bundles(&attempt.id)
        .map_err(|error| format!("Caffold could not read earlier updates: {error}"))?;
    for bundle in retired {
        host.forget_bundle(&bundle).await;
    }
    records
        .prune(&attempt.id)
        .map_err(|error| format!("Caffold could not remove earlier backups: {error}"))?;
    let backup = records.backup(&attempt.id, app);
    host.copy_bundle(app, &backup)
        .await
        .map_err(|error| format!("Caffold could not back up {}: {error}", app.display()))?;
    host.forget_bundle(&backup).await;
    Ok(())
}

/// Removes an attempt that never changed anything.
fn abandon(records: &AttemptRecords, attempt: &Attempt) {
    let _ = fs::remove_dir_all(records.directory(&attempt.id));
    let _ = records.release(&attempt.id);
}

/// Prints the worker's log as it grows, then the outcome.
async fn follow(
    host: &impl Host,
    records: &AttemptRecords,
    started: Attempt,
    out: &mut impl Write,
) -> bool {
    let mut printed = 0;
    let mut waited_for_worker = 0;
    loop {
        host.sleep(FOLLOW_INTERVAL).await;
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
        if attempt.pid == host.pid() {
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
        } else if !host.alive(attempt.pid) {
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

fn result_line(records: &AttemptRecords, attempt: &Attempt) -> String {
    let from = &attempt.from_version;
    let to = attempt.to_version.as_deref().unwrap_or("the new version");
    let reason = attempt.reason.as_deref().unwrap_or("");
    match attempt.outcome {
        AttemptOutcome::Succeeded => format!("Result: Caffold {to} is running."),
        AttemptOutcome::UpToDate => {
            format!("Result: Caffold {from} is already the newest version Homebrew offers.")
        }
        AttemptOutcome::HomebrewFailed => {
            format!("Result: Homebrew could not update Caffold. {reason}")
        }
        AttemptOutcome::RolledBack => {
            format!("Result: Caffold was rolled back to {from}: {reason}.")
        }
        AttemptOutcome::RestoreFailed => format!(
            "Result: Caffold could not be restored: {reason}. The records of this attempt are in {}.",
            records.directory(&attempt.id).display()
        ),
        AttemptOutcome::Interrupted => {
            format!("Result: The update stopped before it finished. {reason}")
        }
        AttemptOutcome::Running => "Result: The update is still running.".to_string(),
    }
}

/// Runs a recorded attempt to its outcome: Homebrew installs the new app while
/// the old one keeps running, then the app restarts on the new version, or on
/// the backup if the new version does not start.
pub(super) async fn run_attempt(
    host: &impl Host,
    records: &AttemptRecords,
    request: &UpdateRequest,
    id: &str,
) {
    let Ok(mut attempt) = records.load(id) else {
        return;
    };
    attempt.pid = host.pid();
    let _ = records.save(&attempt);
    let (outcome, reason) = update(host, records, request, &mut attempt).await;
    attempt.finish(outcome, reason);
    log(&format!("Finished: {:?}.", attempt.outcome));
    let _ = records.save(&attempt);
    let _ = records.release(id);
}

async fn update(
    host: &impl Host,
    records: &AttemptRecords,
    request: &UpdateRequest,
    attempt: &mut Attempt,
) -> (AttemptOutcome, Option<String>) {
    let app = &request.app;
    let from = attempt.from_version.clone();
    // Homebrew compares only its own record with its tap. After a rollback
    // the record is ahead of the app, and only a reinstall installs that
    // version again.
    let reinstall = match host.homebrew_record().await {
        HomebrewRecord::Installed(Some(recorded)) => Version::parse(&from)
            .map(|app_version| recorded > app_version)
            .unwrap_or(false),
        _ => false,
    };
    log(if reinstall {
        "Reinstalling Caffold with Homebrew, because its record is ahead of the app."
    } else {
        "Upgrading Caffold with Homebrew."
    });
    match host.homebrew_install(reinstall).await {
        Ok(output) => log(output.trim_end()),
        Err(output) => {
            log(output.trim_end());
            return (AttemptOutcome::HomebrewFailed, Some(last_line(&output)));
        }
    }
    let to = match host.bundle_version(app).await {
        Ok(version) => version,
        Err(error) => {
            log(&format!(
                "Caffold could not read the installed version: {error}"
            ));
            return restore_without_restart(
                host,
                records,
                attempt,
                app,
                "Caffold could not read the installed version",
            )
            .await;
        }
    };
    attempt.to_version = Some(to.to_string());
    let _ = records.save(attempt);
    if Version::parse(&from).is_ok_and(|from| to <= from) {
        log(&format!("Homebrew has nothing newer than Caffold {from}."));
        return (AttemptOutcome::UpToDate, None);
    }

    log(&format!("Restarting Caffold on {to}."));
    host.quit_app(app).await;
    if !wait_until_stopped(host, app, request.port).await {
        log("Caffold did not quit, so the previous app goes back in place.");
        return restore_without_restart(host, records, attempt, app, "Caffold did not quit").await;
    }
    if let Err(error) = host.launch_app(app).await {
        log(&format!("Caffold {to} could not be opened: {error}"));
    } else if wait_until_serving(host, app, request.port, &to.to_string()).await {
        log(&format!("Caffold {to} is serving."));
        return (AttemptOutcome::Succeeded, None);
    }

    let reason = format!("{to} could not start");
    log(&format!(
        "Caffold {reason}, so the previous app goes back in place."
    ));
    restore(host, records, attempt, request, reason).await
}

/// Puts the backup back while the previous app is still running.
async fn restore_without_restart(
    host: &impl Host,
    records: &AttemptRecords,
    attempt: &Attempt,
    app: &Path,
    reason: &str,
) -> (AttemptOutcome, Option<String>) {
    match swap_back(host, records, attempt, app).await {
        Ok(()) => (AttemptOutcome::RolledBack, Some(reason.to_string())),
        Err(error) => {
            log(&error);
            (
                AttemptOutcome::RestoreFailed,
                Some(format!(
                    "{reason}, and {} could not be put back",
                    attempt.from_version
                )),
            )
        }
    }
}

/// Stops the new app, puts the backup back, and starts it.
async fn restore(
    host: &impl Host,
    records: &AttemptRecords,
    attempt: &Attempt,
    request: &UpdateRequest,
    reason: String,
) -> (AttemptOutcome, Option<String>) {
    let app = &request.app;
    let from = &attempt.from_version;
    let failed = (
        AttemptOutcome::RestoreFailed,
        Some(format!("{reason}, and {from} could not be restored")),
    );
    host.quit_app(app).await;
    if !wait_until_stopped(host, app, request.port).await {
        log("The new app did not quit.");
        return failed;
    }
    if let Err(error) = swap_back(host, records, attempt, app).await {
        log(&error);
        return failed;
    }
    if let Err(error) = host.launch_app(app).await {
        log(&format!("Caffold {from} could not be opened: {error}"));
        return failed;
    }
    if !wait_until_serving(host, app, request.port, from).await {
        log(&format!("Caffold {from} did not answer either."));
        return failed;
    }
    log(&format!("Caffold {from} is serving again."));
    (AttemptOutcome::RolledBack, Some(reason))
}

/// Moves the new app into the attempt and the backup back into place.
async fn swap_back(
    host: &impl Host,
    records: &AttemptRecords,
    attempt: &Attempt,
    app: &Path,
) -> Result<(), String> {
    let failed = records.failed(&attempt.id, app);
    let backup = records.backup(&attempt.id, app);
    host.move_bundle(app, &failed)
        .await
        .map_err(|error| format!("The new app could not be moved aside: {error}"))?;
    host.forget_bundle(&failed).await;
    host.move_bundle(&backup, app)
        .await
        .map_err(|error| format!("The backup could not be put back: {error}"))
}

async fn wait_until_stopped(host: &impl Host, app: &Path, port: u16) -> bool {
    for _ in 0..STOP_POLLS {
        if host.app_stopped(app, port).await {
            return true;
        }
        host.sleep(POLL_INTERVAL).await;
    }
    host.app_stopped(app, port).await
}

/// The server answers with `version`, and it is this app's server, not a
/// server another process started on the same port.
async fn wait_until_serving(host: &impl Host, app: &Path, port: u16, version: &str) -> bool {
    for _ in 0..SERVE_POLLS {
        if host.server_version(port).await.as_deref() == Some(version)
            && host
                .server_owner(port)
                .await
                .is_some_and(|owner| serves_from(&owner, app))
        {
            return true;
        }
        host.sleep(POLL_INTERVAL).await;
    }
    false
}

/// Whether a process command line is the server bundled in `app`.
fn serves_from(command: &str, app: &Path) -> bool {
    command.starts_with(&format!(
        "{}/Contents/Resources/caffold serve",
        app.display()
    ))
}

fn last_line(output: &str) -> String {
    output
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Homebrew failed without saying why.")
        .to_string()
}

/// The worker's output is its log.
fn log(line: &str) {
    let _ = writeln!(io::stdout(), "{line}");
}

fn note(out: &mut impl Write, line: &str) {
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

/// What Homebrew records for the `caffold` cask.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HomebrewRecord {
    NoHomebrew,
    NotInstalled,
    /// The recorded version, when Homebrew names one Caffold can read.
    Installed(Option<Version>),
}

/// Everything the update does outside its records: Homebrew, the app bundle,
/// the running app and its server, and time.
pub(super) trait Host {
    fn pid(&self) -> u32;
    fn alive(&self, pid: u32) -> bool;
    async fn homebrew_record(&self) -> HomebrewRecord;
    /// Upgrades the cask, or reinstalls it, and returns what Homebrew said.
    async fn homebrew_install(&self, reinstall: bool) -> Result<String, String>;
    async fn bundle_version(&self, app: &Path) -> Result<Version, String>;
    async fn copy_bundle(&self, from: &Path, to: &Path) -> Result<(), String>;
    async fn move_bundle(&self, from: &Path, to: &Path) -> Result<(), String>;
    /// Removes a copy of the app from LaunchServices, so the system never
    /// opens it in place of the installed one.
    async fn forget_bundle(&self, bundle: &Path);
    /// The command line of the process listening on `port`.
    async fn server_owner(&self, port: u16) -> Option<String>;
    async fn server_version(&self, port: u16) -> Option<String>;
    async fn quit_app(&self, app: &Path);
    async fn app_stopped(&self, app: &Path, port: u16) -> bool;
    async fn launch_app(&self, app: &Path) -> Result<(), String>;
    async fn start_worker(
        &self,
        request: &UpdateRequest,
        id: &str,
        log: &Path,
    ) -> Result<(), String>;
    async fn sleep(&self, duration: Duration);
}

#[cfg(test)]
mod tests {
    use std::{
        cell::{Cell, RefCell},
        collections::HashMap,
    };

    use super::*;

    const APP: &str = "/Applications/Caffold Server.app";
    const PORT: u16 = 5178;
    const OWN_PID: u32 = 100;
    const WORKER_PID: u32 = 200;

    /// A Mac with one Caffold app: bundles on disk by path, the running app,
    /// and Homebrew's record and offer.
    struct FakeMac {
        homebrew: Cell<bool>,
        record: RefCell<Option<Version>>,
        offer: Version,
        homebrew_fails: bool,
        bundles: RefCell<HashMap<PathBuf, Version>>,
        running: RefCell<Option<Version>>,
        quits: bool,
        starts: Vec<Version>,
        foreign_server: bool,
        copy_fails: bool,
        worker_starts: bool,
        log: RefCell<Vec<String>>,
    }

    impl FakeMac {
        fn new(installed: &str, offer: &str) -> Self {
            let installed = version(installed);
            Self {
                homebrew: Cell::new(true),
                record: RefCell::new(Some(installed.clone())),
                offer: version(offer),
                homebrew_fails: false,
                bundles: RefCell::new(HashMap::from([(PathBuf::from(APP), installed.clone())])),
                running: RefCell::new(Some(installed.clone())),
                quits: true,
                starts: vec![installed, version(offer)],
                foreign_server: false,
                copy_fails: false,
                worker_starts: true,
                log: RefCell::new(Vec::new()),
            }
        }

        fn did(&self, step: impl Into<String>) {
            self.log.borrow_mut().push(step.into());
        }

        fn steps(&self) -> Vec<String> {
            self.log.borrow().clone()
        }

        fn app_version(&self) -> Option<Version> {
            self.bundles.borrow().get(Path::new(APP)).cloned()
        }
    }

    impl Host for FakeMac {
        fn pid(&self) -> u32 {
            WORKER_PID
        }

        fn alive(&self, pid: u32) -> bool {
            pid == WORKER_PID || pid == OWN_PID
        }

        async fn homebrew_record(&self) -> HomebrewRecord {
            if !self.homebrew.get() {
                return HomebrewRecord::NoHomebrew;
            }
            match self.record.borrow().clone() {
                Some(version) => HomebrewRecord::Installed(Some(version)),
                None => HomebrewRecord::NotInstalled,
            }
        }

        async fn homebrew_install(&self, reinstall: bool) -> Result<String, String> {
            self.did(if reinstall {
                "brew reinstall"
            } else {
                "brew upgrade"
            });
            if self.homebrew_fails {
                return Err("==> Downloading\nError: Download failed".to_string());
            }
            let recorded = self.record.borrow().clone();
            if reinstall || recorded.as_ref() < Some(&self.offer) {
                *self.record.borrow_mut() = Some(self.offer.clone());
                self.bundles
                    .borrow_mut()
                    .insert(PathBuf::from(APP), self.offer.clone());
            }
            Ok("==> Upgrading 1 outdated package".to_string())
        }

        async fn bundle_version(&self, app: &Path) -> Result<Version, String> {
            self.bundles
                .borrow()
                .get(app)
                .cloned()
                .ok_or_else(|| "no bundle".to_string())
        }

        async fn copy_bundle(&self, from: &Path, to: &Path) -> Result<(), String> {
            self.did(format!("copy {} -> {}", from.display(), to.display()));
            if self.copy_fails {
                return Err("No space left on device".to_string());
            }
            let version = self.bundles.borrow().get(from).cloned().unwrap();
            self.bundles.borrow_mut().insert(to.to_path_buf(), version);
            Ok(())
        }

        async fn move_bundle(&self, from: &Path, to: &Path) -> Result<(), String> {
            self.did(format!("move {} -> {}", from.display(), to.display()));
            let version = self.bundles.borrow_mut().remove(from).ok_or("missing")?;
            self.bundles.borrow_mut().insert(to.to_path_buf(), version);
            Ok(())
        }

        async fn forget_bundle(&self, bundle: &Path) {
            self.did(format!("forget {}", bundle.display()));
        }

        async fn server_owner(&self, _port: u16) -> Option<String> {
            if self.foreign_server {
                return Some("/usr/local/bin/caffold serve --port 5178".to_string());
            }
            self.running
                .borrow()
                .as_ref()
                .map(|_| format!("{APP}/Contents/Resources/caffold serve --port 5178"))
        }

        async fn server_version(&self, _port: u16) -> Option<String> {
            self.running.borrow().as_ref().map(Version::to_string)
        }

        async fn quit_app(&self, _app: &Path) {
            self.did("quit");
            if self.quits {
                *self.running.borrow_mut() = None;
            }
        }

        async fn app_stopped(&self, _app: &Path, _port: u16) -> bool {
            self.running.borrow().is_none()
        }

        async fn launch_app(&self, app: &Path) -> Result<(), String> {
            let version = self.bundles.borrow().get(app).cloned().ok_or("missing")?;
            self.did(format!("launch {version}"));
            if self.starts.contains(&version) {
                *self.running.borrow_mut() = Some(version);
            }
            Ok(())
        }

        async fn start_worker(
            &self,
            _request: &UpdateRequest,
            id: &str,
            _log: &Path,
        ) -> Result<(), String> {
            self.did(format!("start worker {id}"));
            if self.worker_starts {
                Ok(())
            } else {
                Err("sh: not found".to_string())
            }
        }

        async fn sleep(&self, _duration: Duration) {}
    }

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn request() -> UpdateRequest {
        UpdateRequest {
            app: PathBuf::from(APP),
            data_dir: PathBuf::from("/unused"),
            port: PORT,
            from_menu_bar: false,
        }
    }

    fn records() -> (tempfile::TempDir, AttemptRecords) {
        let directory = tempfile::tempdir().unwrap();
        let records = AttemptRecords::new(directory.path().join("caffold-updates"));
        (directory, records)
    }

    /// Runs an attempt the way the worker does, from a recorded start.
    async fn attempt(mac: &FakeMac, records: &AttemptRecords) -> Attempt {
        let started = records
            .begin(
                mac.app_version().unwrap().to_string(),
                false,
                OWN_PID,
                |pid| mac.alive(pid),
            )
            .unwrap();
        back_up(mac, records, &started, Path::new(APP))
            .await
            .unwrap();
        run_attempt(mac, records, &request(), &started.id).await;
        records.load(&started.id).unwrap()
    }

    #[tokio::test]
    async fn updates_while_the_old_app_runs_then_restarts_on_the_new_one() {
        let (_directory, records) = records();
        let mac = FakeMac::new("0.18.2", "0.18.3");

        let attempt = attempt(&mac, &records).await;

        assert_eq!(attempt.outcome, AttemptOutcome::Succeeded);
        assert_eq!(attempt.to_version.as_deref(), Some("0.18.3"));
        assert_eq!(attempt.pid, WORKER_PID);
        assert_eq!(mac.app_version(), Some(version("0.18.3")));
        assert_eq!(*mac.running.borrow(), Some(version("0.18.3")));
        let steps = mac.steps();
        let upgrade = steps
            .iter()
            .position(|step| step == "brew upgrade")
            .unwrap();
        let quit = steps.iter().position(|step| step == "quit").unwrap();
        assert!(upgrade < quit, "{steps:?}");
        assert_eq!(steps.last().map(String::as_str), Some("launch 0.18.3"));
        assert!(
            !records
                .directory(&attempt.id)
                .join("../../update.lock")
                .exists()
        );
    }

    #[tokio::test]
    async fn stops_when_homebrew_has_nothing_newer() {
        let (_directory, records) = records();
        let mac = FakeMac::new("0.18.2", "0.18.2");

        let attempt = attempt(&mac, &records).await;

        assert_eq!(attempt.outcome, AttemptOutcome::UpToDate);
        assert!(!mac.steps().contains(&"quit".to_string()));
        assert_eq!(*mac.running.borrow(), Some(version("0.18.2")));
    }

    #[tokio::test]
    async fn leaves_everything_running_when_homebrew_fails() {
        let (_directory, records) = records();
        let mut mac = FakeMac::new("0.18.2", "0.18.3");
        mac.homebrew_fails = true;

        let attempt = attempt(&mac, &records).await;

        assert_eq!(attempt.outcome, AttemptOutcome::HomebrewFailed);
        assert_eq!(attempt.reason.as_deref(), Some("Error: Download failed"));
        assert!(!mac.steps().contains(&"quit".to_string()));
        assert_eq!(*mac.running.borrow(), Some(version("0.18.2")));
    }

    #[tokio::test]
    async fn rolls_back_when_the_new_version_does_not_start() {
        let (_directory, records) = records();
        let mut mac = FakeMac::new("0.18.2", "0.18.3");
        mac.starts = vec![version("0.18.2")];

        let attempt = attempt(&mac, &records).await;

        assert_eq!(attempt.outcome, AttemptOutcome::RolledBack);
        assert_eq!(attempt.reason.as_deref(), Some("0.18.3 could not start"));
        assert_eq!(mac.app_version(), Some(version("0.18.2")));
        assert_eq!(*mac.running.borrow(), Some(version("0.18.2")));
        assert_eq!(
            mac.bundles
                .borrow()
                .get(&records.failed(&attempt.id, Path::new(APP)))
                .cloned(),
            Some(version("0.18.3"))
        );
        assert_eq!(*mac.record.borrow(), Some(version("0.18.3")));
        let steps = mac.steps();
        assert!(steps.contains(&format!(
            "forget {}",
            records.failed(&attempt.id, Path::new(APP)).display()
        )));
        assert_eq!(steps.last().map(String::as_str), Some("launch 0.18.2"));
    }

    #[tokio::test]
    async fn puts_the_backup_back_when_the_old_app_does_not_quit() {
        let (_directory, records) = records();
        let mut mac = FakeMac::new("0.18.2", "0.18.3");
        mac.quits = false;

        let attempt = attempt(&mac, &records).await;

        assert_eq!(attempt.outcome, AttemptOutcome::RolledBack);
        assert_eq!(attempt.reason.as_deref(), Some("Caffold did not quit"));
        assert_eq!(mac.app_version(), Some(version("0.18.2")));
        assert_eq!(*mac.running.borrow(), Some(version("0.18.2")));
        assert!(!mac.steps().iter().any(|step| step.starts_with("launch")));
    }

    #[tokio::test]
    async fn reports_a_restore_that_also_fails() {
        let (_directory, records) = records();
        let mut mac = FakeMac::new("0.18.2", "0.18.3");
        mac.starts = Vec::new();

        let attempt = attempt(&mac, &records).await;

        assert_eq!(attempt.outcome, AttemptOutcome::RestoreFailed);
        assert_eq!(
            attempt.reason.as_deref(),
            Some("0.18.3 could not start, and 0.18.2 could not be restored")
        );
        assert_eq!(mac.app_version(), Some(version("0.18.2")));
    }

    #[tokio::test]
    async fn reinstalls_when_homebrew_records_a_version_ahead_of_the_app() {
        let (_directory, records) = records();
        let mac = FakeMac::new("0.18.2", "0.18.3");
        *mac.record.borrow_mut() = Some(version("0.18.3"));

        let attempt = attempt(&mac, &records).await;

        assert_eq!(attempt.outcome, AttemptOutcome::Succeeded);
        assert!(mac.steps().contains(&"brew reinstall".to_string()));
        assert!(!mac.steps().contains(&"brew upgrade".to_string()));
    }

    #[tokio::test]
    async fn waits_for_a_server_that_answers_from_this_app() {
        let mut mac = FakeMac::new("0.18.2", "0.18.3");

        assert!(wait_until_serving(&mac, Path::new(APP), PORT, "0.18.2").await);
        assert!(!wait_until_serving(&mac, Path::new(APP), PORT, "0.18.3").await);
        mac.foreign_server = true;
        assert!(!wait_until_serving(&mac, Path::new(APP), PORT, "0.18.2").await);
    }

    #[tokio::test]
    async fn refuses_without_homebrew_or_its_record() {
        let (_directory, records) = records();
        let mac = FakeMac::new("0.18.2", "0.18.3");
        mac.homebrew.set(false);
        let mut out = Vec::new();

        assert!(!start(&mac, &records, &request(), &mut out).await);
        assert!(
            String::from_utf8(out)
                .unwrap()
                .starts_with("Homebrew is not installed")
        );

        mac.homebrew.set(true);
        *mac.record.borrow_mut() = None;
        let mut out = Vec::new();
        assert!(!start(&mac, &records, &request(), &mut out).await);
        assert!(
            String::from_utf8(out)
                .unwrap()
                .starts_with("This Caffold was not installed with Homebrew")
        );
        assert_eq!(records.latest_finished().unwrap(), None);
    }

    #[tokio::test]
    async fn refuses_to_update_an_app_whose_server_another_process_runs() {
        let (_directory, records) = records();
        let mut mac = FakeMac::new("0.18.2", "0.18.3");
        mac.foreign_server = true;
        let mut out = Vec::new();

        assert!(!start(&mac, &records, &request(), &mut out).await);

        assert!(
            String::from_utf8(out).unwrap().starts_with(
                "The server on port 5178 is not run by /Applications/Caffold Server.app"
            )
        );
        assert!(mac.steps().is_empty());
    }

    #[tokio::test]
    async fn refuses_while_another_update_runs() {
        let (_directory, records) = records();
        let mac = FakeMac::new("0.18.2", "0.18.3");
        records
            .begin("0.18.2".to_string(), false, OWN_PID, |pid| mac.alive(pid))
            .unwrap();
        let mut out = Vec::new();

        assert!(!start(&mac, &records, &request(), &mut out).await);

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Another Caffold update is already running.\n"
        );
    }

    #[tokio::test]
    async fn leaves_no_attempt_when_the_backup_fails() {
        let (_directory, records) = records();
        let mut mac = FakeMac::new("0.18.2", "0.18.3");
        mac.copy_fails = true;
        let mut out = Vec::new();

        assert!(!start(&mac, &records, &request(), &mut out).await);

        assert!(String::from_utf8(out).unwrap().starts_with(
            "Caffold could not back up /Applications/Caffold Server.app: No space left on device"
        ));
        assert_eq!(records.latest_finished().unwrap(), None);
        assert!(records.retired_bundles("none").unwrap().is_empty());
        assert!(
            records
                .begin("0.18.2".to_string(), false, OWN_PID, |pid| mac.alive(pid))
                .is_ok()
        );
    }

    #[tokio::test]
    async fn leaves_no_attempt_when_the_worker_does_not_start() {
        let (_directory, records) = records();
        let mut mac = FakeMac::new("0.18.2", "0.18.3");
        mac.worker_starts = false;
        let mut out = Vec::new();

        assert!(!start(&mac, &records, &request(), &mut out).await);

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Caffold could not start the update: sh: not found\n"
        );
        assert_eq!(records.latest_finished().unwrap(), None);
    }

    #[tokio::test]
    async fn follows_the_worker_and_reports_its_outcome() {
        let (_directory, records) = records();
        let mac = FakeMac::new("0.18.2", "0.18.3");
        let mut started = records
            .begin("0.18.2".to_string(), false, OWN_PID, |pid| mac.alive(pid))
            .unwrap();
        fs::write(
            records.log(&started.id),
            "Upgrading Caffold with Homebrew.\n",
        )
        .unwrap();
        started.pid = WORKER_PID;
        started.to_version = Some("0.18.3".to_string());
        started.finish(
            AttemptOutcome::RolledBack,
            Some("0.18.3 could not start".to_string()),
        );
        records.save(&started).unwrap();
        let mut out = Vec::new();

        assert!(!follow(&mac, &records, started.clone(), &mut out).await);

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Upgrading Caffold with Homebrew.\nResult: Caffold was rolled back to 0.18.2: 0.18.3 could not start.\n"
        );
    }

    #[tokio::test]
    async fn gives_up_on_a_worker_that_never_takes_the_attempt_over() {
        let (_directory, records) = records();
        let mac = FakeMac::new("0.18.2", "0.18.3");
        let started = records
            .begin("0.18.2".to_string(), false, WORKER_PID, |pid| {
                mac.alive(pid)
            })
            .unwrap();
        let mut out = Vec::new();

        assert!(!follow(&mac, &records, started.clone(), &mut out).await);

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
        let mac = FakeMac::new("0.18.2", "0.18.3");
        let mut started = records
            .begin("0.18.2".to_string(), false, OWN_PID, |pid| mac.alive(pid))
            .unwrap();
        started.pid = 300;
        records.save(&started).unwrap();
        let mut out = Vec::new();

        assert!(!follow(&mac, &records, started, &mut out).await);

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "The update stopped before it finished. The next update marks it interrupted.\n"
        );
    }

    #[test]
    fn recognizes_the_server_bundled_in_the_app() {
        let app = Path::new(APP);

        assert!(serves_from(
            "/Applications/Caffold Server.app/Contents/Resources/caffold serve --host 127.0.0.1 --port 5178",
            app
        ));
        assert!(!serves_from(
            "/Applications/Caffold Server.app/Contents/Resources/caffold update --attempt 1",
            app
        ));
        assert!(!serves_from(
            "/Users/me/caffold/target/debug/caffold serve",
            app
        ));
    }

    #[test]
    fn writes_one_result_line_per_outcome() {
        let (_directory, records) = records();
        let attempt = |outcome, to: Option<&str>, reason: Option<&str>| Attempt {
            id: "20261004T121000Z".to_string(),
            started_at: String::new(),
            finished_at: None,
            from_version: "0.18.2".to_string(),
            to_version: to.map(str::to_string),
            started_from_menu_bar: false,
            pid: 1,
            outcome,
            reason: reason.map(str::to_string),
        };

        for (outcome, to, reason, expected) in [
            (
                AttemptOutcome::Succeeded,
                Some("0.18.3"),
                None,
                "Result: Caffold 0.18.3 is running.",
            ),
            (
                AttemptOutcome::UpToDate,
                Some("0.18.2"),
                None,
                "Result: Caffold 0.18.2 is already the newest version Homebrew offers.",
            ),
            (
                AttemptOutcome::HomebrewFailed,
                None,
                Some("Error: Download failed"),
                "Result: Homebrew could not update Caffold. Error: Download failed",
            ),
            (
                AttemptOutcome::Interrupted,
                None,
                Some("The update did not start"),
                "Result: The update stopped before it finished. The update did not start",
            ),
        ] {
            assert_eq!(
                result_line(&records, &attempt(outcome, to, reason)),
                expected
            );
        }
        assert!(
            result_line(
                &records,
                &attempt(
                    AttemptOutcome::RestoreFailed,
                    Some("0.18.3"),
                    Some("0.18.3 could not start, and 0.18.2 could not be restored")
                )
            )
            .starts_with(
                "Result: Caffold could not be restored: 0.18.3 could not start, and 0.18.2 could not be restored. The records of this attempt are in "
            )
        );
    }

    #[test]
    fn keeps_the_last_thing_homebrew_said() {
        assert_eq!(
            last_line("==> Upgrading\nError: failed\n\n"),
            "Error: failed"
        );
        assert_eq!(last_line(""), "Homebrew failed without saying why.");
    }
}
