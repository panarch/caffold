//! The update on Linux, for a Caffold its install script installed: the new
//! release is unpacked into a version directory beside the running one, the
//! `caffold` link moves to it, and the systemd service restarts. When the new
//! version does not answer, the link moves back and the service restarts on
//! the previous version. After a successful update only the new and the
//! previous version stay.

mod host;

use std::{
    fs,
    io::{self, Write},
    os::unix::fs::symlink,
    path::{Path, PathBuf},
    time::Duration,
};

use semver::Version;

use super::{
    LatestRelease, Processes, abandon, follow, log, note,
    records::{Attempt, AttemptOutcome, AttemptRecords, BeginError},
};
pub(super) use host::LinuxHost;

/// The service has 30 seconds to answer on a version, as the app has on macOS.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const SERVE_POLLS: u32 = 120;
const VERSIONS: &str = "versions";
const EXECUTABLE: &str = "caffold";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UpdateRequest {
    /// Where the install script keeps Caffold: one directory per version
    /// beneath its `versions`.
    pub(crate) install_root: PathBuf,
    /// The `caffold` link that names the version the service runs.
    pub(crate) link: PathBuf,
    pub(crate) data_dir: PathBuf,
    pub(crate) port: u16,
}

/// The `caffold` link the install script puts on the `PATH` of `home`.
pub(crate) fn caffold_link(home: &Path) -> PathBuf {
    home.join(".local/bin").join(EXECUTABLE)
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
            follow(host, records, attempt, out, result_line).await
        }
        Err(refusal) => {
            note(out, &refusal);
            false
        }
    }
}

/// Checks that the systemd service runs the version the link names, records
/// the attempt, and hands it to a worker. Nothing has changed when this
/// fails, so no attempt is left behind.
async fn prepare(
    host: &impl Host,
    records: &AttemptRecords,
    request: &UpdateRequest,
) -> Result<Attempt, String> {
    let Ok(from) = linked_version(&request.link, &request.install_root) else {
        return Err(
            "This Caffold was not installed by its install script, so it cannot update itself. Install the new version from its release page.".to_string(),
        );
    };
    if !runs_version(host, &request.install_root, &from).await {
        return Err(format!(
            "The caffold systemd service does not run Caffold {from} from {}, so updating it would not update the server on port {}.",
            request.install_root.display(),
            request.port
        ));
    }
    let attempt = match records.begin(from, false, host.pid(), |pid| host.alive(pid)) {
        Ok(attempt) => attempt,
        Err(BeginError::Busy) => {
            return Err("Another Caffold update is already running.".to_string());
        }
        Err(BeginError::Io(error)) => {
            return Err(format!("Caffold could not record the update: {error}"));
        }
    };
    if let Err(error) = records.prune(&attempt.id) {
        abandon(records, &attempt);
        return Err(format!(
            "Caffold could not remove earlier update records: {error}"
        ));
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

/// Runs a recorded attempt to its outcome.
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
    let root = &request.install_root;
    let from = attempt.from_version.clone();
    log("Asking GitHub for the newest Caffold.");
    let to = match host.latest_release().await {
        Ok(release) => release.version,
        Err(problem) => {
            log(&problem);
            return (AttemptOutcome::DownloadFailed, Some(problem));
        }
    };
    attempt.to_version = Some(to.to_string());
    let _ = records.save(attempt);
    if Version::parse(&from).is_ok_and(|from| to <= from) {
        log(&format!("Caffold {from} is already the newest release."));
        return (AttemptOutcome::UpToDate, None);
    }

    log(&format!("Downloading Caffold {to}."));
    if let Err(problem) = host
        .install_version(&to, &version_directory(root, &to.to_string()))
        .await
    {
        log(&problem);
        return (AttemptOutcome::DownloadFailed, Some(problem));
    }

    log(&format!("Restarting Caffold on {to}."));
    let to = to.to_string();
    if let Err(error) = point_link(&request.link, &executable(root, &to)) {
        let reason = format!("the caffold link could not move to {to}: {error}");
        log(&format!("Caffold {from} keeps running, because {reason}."));
        return (AttemptOutcome::RolledBack, Some(reason));
    }
    if let Err(error) = host.restart().await {
        log(&format!("The service could not restart: {error}"));
    } else if wait_until_serving(host, request, &to).await {
        log(&format!("Caffold {to} is serving."));
        if let Err(error) = remove_other_versions(root, &[&to, &from]) {
            log(&format!("Caffold could not remove older versions: {error}"));
        }
        return (AttemptOutcome::Succeeded, None);
    }

    let reason = format!("{to} could not start");
    log(&format!(
        "Caffold {reason}, so the link goes back to {from}."
    ));
    restore(host, request, &from, reason).await
}

/// Points the link back at `from` and restarts the service on it.
async fn restore(
    host: &impl Host,
    request: &UpdateRequest,
    from: &str,
    reason: String,
) -> (AttemptOutcome, Option<String>) {
    let failed = (
        AttemptOutcome::RestoreFailed,
        Some(format!("{reason}, and {from} could not be restored")),
    );
    if let Err(error) = point_link(&request.link, &executable(&request.install_root, from)) {
        log(&format!("The caffold link could not move back: {error}"));
        return failed;
    }
    if let Err(error) = host.restart().await {
        log(&format!("The service could not restart: {error}"));
        return failed;
    }
    if !wait_until_serving(host, request, from).await {
        log(&format!("Caffold {from} did not answer either."));
        return failed;
    }
    log(&format!("Caffold {from} is serving again."));
    (AttemptOutcome::RolledBack, Some(reason))
}

/// The server on the port answers with `version`, and the service runs that
/// version's executable, not a server another process started on the same
/// port.
async fn wait_until_serving(host: &impl Host, request: &UpdateRequest, version: &str) -> bool {
    for _ in 0..SERVE_POLLS {
        if host.server_version(request.port).await.as_deref() == Some(version)
            && runs_version(host, &request.install_root, version).await
        {
            return true;
        }
        host.sleep(POLL_INTERVAL).await;
    }
    false
}

async fn runs_version(host: &impl Host, root: &Path, version: &str) -> bool {
    let Some(running) = host.service_executable().await else {
        return false;
    };
    fs::canonicalize(executable(root, version)).is_ok_and(|expected| expected == running)
}

fn result_line(records: &AttemptRecords, attempt: &Attempt) -> String {
    let from = &attempt.from_version;
    let to = attempt.to_version.as_deref().unwrap_or("the new version");
    let reason = attempt.reason.as_deref().unwrap_or("");
    match attempt.outcome {
        AttemptOutcome::Succeeded => format!("Result: Caffold {to} is running."),
        AttemptOutcome::UpToDate => {
            format!("Result: Caffold {from} is already the newest release.")
        }
        AttemptOutcome::DownloadFailed => {
            format!("Result: Caffold could not download {to}. {reason}")
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

/// The version the link names: `<root>/versions/<version>/caffold`.
fn linked_version(link: &Path, root: &Path) -> io::Result<String> {
    let executable = fs::canonicalize(link)?;
    let versions = fs::canonicalize(root.join(VERSIONS))?;
    executable
        .strip_prefix(&versions)
        .ok()
        .and_then(|inside| {
            let mut parts = inside.components();
            let version = parts.next()?.as_os_str().to_str()?;
            let named = parts.next()?.as_os_str() == EXECUTABLE && parts.next().is_none();
            (named && Version::parse(version).is_ok()).then(|| version.to_string())
        })
        .ok_or_else(|| io::Error::other("the link does not name an installed version"))
}

/// Points `link` at `target` in one step: a new link beside it replaces it,
/// so the link always names a version.
fn point_link(link: &Path, target: &Path) -> io::Result<()> {
    let staged = link.with_file_name(format!(".{EXECUTABLE}-{}.link", std::process::id()));
    let _ = fs::remove_file(&staged);
    symlink(target, &staged)?;
    fs::rename(&staged, link)
}

/// Removes every version directory but `kept`, and anything an interrupted
/// download left there.
fn remove_other_versions(root: &Path, kept: &[&str]) -> io::Result<()> {
    for entry in fs::read_dir(root.join(VERSIONS))? {
        let entry = entry?;
        if !kept.iter().any(|version| entry.file_name() == **version) {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

fn version_directory(root: &Path, version: &str) -> PathBuf {
    root.join(VERSIONS).join(version)
}

fn executable(root: &Path, version: &str) -> PathBuf {
    version_directory(root, version).join(EXECUTABLE)
}

/// Everything the update does outside its records and the install
/// directory: GitHub, the systemd service and its server, and time.
pub(super) trait Host: Processes {
    async fn latest_release(&self) -> Result<LatestRelease, String>;
    /// Downloads, checks, and unpacks `version` into `directory`, replacing
    /// whatever an earlier attempt left there. Nothing is left there when
    /// this fails.
    async fn install_version(&self, version: &Version, directory: &Path) -> Result<(), String>;
    async fn restart(&self) -> Result<(), String>;
    /// The executable the service's main process runs, when it runs.
    async fn service_executable(&self) -> Option<PathBuf>;
    async fn server_version(&self, port: u16) -> Option<String>;
    async fn start_worker(
        &self,
        request: &UpdateRequest,
        id: &str,
        log: &Path,
    ) -> Result<(), String>;
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};

    use super::*;

    const PORT: u16 = 5178;
    const OWN_PID: u32 = 100;
    const WORKER_PID: u32 = 200;

    /// A Linux user with Caffold installed in a temporary home: what GitHub
    /// offers, which versions start, and the service, which runs whatever
    /// the link names when it restarts.
    struct FakeLinux {
        home: tempfile::TempDir,
        offer: Result<Version, String>,
        download_fails: bool,
        starts: Vec<String>,
        running: RefCell<Option<PathBuf>>,
        restart_fails: Cell<bool>,
        worker_starts: bool,
        log: RefCell<Vec<String>>,
    }

    impl FakeLinux {
        /// `installed` versions, the first of them linked and running.
        fn new(installed: &[&str], offer: &str) -> Self {
            let fake = Self {
                home: tempfile::tempdir().unwrap(),
                offer: Ok(version(offer)),
                download_fails: false,
                starts: vec![installed[0].to_string(), offer.to_string()],
                running: RefCell::new(None),
                restart_fails: Cell::new(false),
                worker_starts: true,
                log: RefCell::new(Vec::new()),
            };
            for version in installed {
                unpack(&version_directory(&fake.root(), version));
            }
            fs::create_dir_all(fake.link().parent().unwrap()).unwrap();
            point_link(&fake.link(), &executable(&fake.root(), installed[0])).unwrap();
            *fake.running.borrow_mut() = Some(fs::canonicalize(fake.link()).unwrap());
            fake
        }

        fn root(&self) -> PathBuf {
            self.home.path().join(".local/share/caffold")
        }

        fn link(&self) -> PathBuf {
            caffold_link(self.home.path())
        }

        fn request(&self) -> UpdateRequest {
            UpdateRequest {
                install_root: self.root(),
                link: self.link(),
                data_dir: self.home.path().join(".caffold"),
                port: PORT,
            }
        }

        fn did(&self, step: impl Into<String>) {
            self.log.borrow_mut().push(step.into());
        }

        fn steps(&self) -> Vec<String> {
            self.log.borrow().clone()
        }

        fn linked(&self) -> String {
            linked_version(&self.link(), &self.root()).unwrap()
        }

        fn running_version(&self) -> Option<String> {
            let running = self.running.borrow().clone()?;
            let directory = running.parent()?.file_name()?;
            Some(directory.to_string_lossy().into_owned())
        }

        fn versions(&self) -> Vec<String> {
            let mut versions: Vec<String> = fs::read_dir(self.root().join(VERSIONS))
                .unwrap()
                .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            versions.sort();
            versions
        }
    }

    fn unpack(directory: &Path) {
        fs::create_dir_all(directory).unwrap();
        fs::write(directory.join(EXECUTABLE), "").unwrap();
        fs::write(directory.join("caffold-runner"), "").unwrap();
    }

    impl Processes for FakeLinux {
        fn pid(&self) -> u32 {
            WORKER_PID
        }

        fn alive(&self, pid: u32) -> bool {
            pid == WORKER_PID || pid == OWN_PID
        }

        async fn sleep(&self, _duration: Duration) {}
    }

    impl Host for FakeLinux {
        async fn latest_release(&self) -> Result<LatestRelease, String> {
            self.offer.clone().map(|version| LatestRelease {
                url: format!("https://github.com/panarch/caffold/releases/tag/v{version}"),
                version,
            })
        }

        async fn install_version(&self, version: &Version, directory: &Path) -> Result<(), String> {
            self.did(format!("install {version}"));
            if self.download_fails {
                return Err(
                    "The checksum of Caffold-0.24.0-linux-x86_64.tar.gz does not match."
                        .to_string(),
                );
            }
            let _ = fs::remove_dir_all(directory);
            unpack(directory);
            Ok(())
        }

        async fn restart(&self) -> Result<(), String> {
            let linked = self.linked();
            self.did(format!("restart on {linked}"));
            if self.restart_fails.get() {
                return Err("Failed to connect to bus".to_string());
            }
            *self.running.borrow_mut() = self
                .starts
                .contains(&linked)
                .then(|| fs::canonicalize(self.link()).unwrap());
            Ok(())
        }

        async fn service_executable(&self) -> Option<PathBuf> {
            self.running.borrow().clone()
        }

        async fn server_version(&self, _port: u16) -> Option<String> {
            self.running_version()
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
    }

    fn version(text: &str) -> Version {
        Version::parse(text).unwrap()
    }

    fn records(linux: &FakeLinux) -> AttemptRecords {
        AttemptRecords::new(linux.home.path().join(".caffold/caffold-updates"))
    }

    /// Runs an attempt the way the worker does, from a recorded start.
    async fn attempt(linux: &FakeLinux) -> Attempt {
        let records = records(linux);
        let started = records
            .begin(linux.linked(), false, OWN_PID, |pid| linux.alive(pid))
            .unwrap();
        run_attempt(linux, &records, &linux.request(), &started.id).await;
        records.load(&started.id).unwrap()
    }

    #[tokio::test]
    async fn restarts_on_the_new_version_and_keeps_the_previous_one() {
        let linux = FakeLinux::new(&["0.23.0", "0.22.0"], "0.24.0");

        let attempt = attempt(&linux).await;

        assert_eq!(attempt.outcome, AttemptOutcome::Succeeded);
        assert_eq!(attempt.to_version.as_deref(), Some("0.24.0"));
        assert_eq!(attempt.pid, WORKER_PID);
        assert_eq!(linux.linked(), "0.24.0");
        assert_eq!(linux.running_version().as_deref(), Some("0.24.0"));
        assert_eq!(linux.versions(), ["0.23.0", "0.24.0"]);
        assert_eq!(linux.steps(), ["install 0.24.0", "restart on 0.24.0"]);
    }

    #[tokio::test]
    async fn changes_nothing_when_nothing_newer_is_released() {
        let linux = FakeLinux::new(&["0.23.0"], "0.23.0");

        let attempt = attempt(&linux).await;

        assert_eq!(attempt.outcome, AttemptOutcome::UpToDate);
        assert!(linux.steps().is_empty());
        assert_eq!(linux.linked(), "0.23.0");
    }

    #[tokio::test]
    async fn keeps_running_when_the_release_cannot_be_downloaded() {
        let mut linux = FakeLinux::new(&["0.23.0", "0.22.0"], "0.24.0");
        linux.download_fails = true;

        let attempt = attempt(&linux).await;

        assert_eq!(attempt.outcome, AttemptOutcome::DownloadFailed);
        assert_eq!(
            attempt.reason.as_deref(),
            Some("The checksum of Caffold-0.24.0-linux-x86_64.tar.gz does not match.")
        );
        assert_eq!(linux.steps(), ["install 0.24.0"]);
        assert_eq!(linux.linked(), "0.23.0");
        assert_eq!(linux.versions(), ["0.22.0", "0.23.0"]);
    }

    #[tokio::test]
    async fn keeps_running_when_github_cannot_be_asked() {
        let mut linux = FakeLinux::new(&["0.23.0"], "0.24.0");
        linux.offer = Err("Caffold could not reach GitHub: timed out".to_string());

        let attempt = attempt(&linux).await;

        assert_eq!(attempt.outcome, AttemptOutcome::DownloadFailed);
        assert_eq!(
            attempt.reason.as_deref(),
            Some("Caffold could not reach GitHub: timed out")
        );
        assert!(linux.steps().is_empty());
    }

    #[tokio::test]
    async fn moves_the_link_back_when_the_new_version_does_not_start() {
        let mut linux = FakeLinux::new(&["0.23.0", "0.22.0"], "0.24.0");
        linux.starts = vec!["0.23.0".to_string()];

        let attempt = attempt(&linux).await;

        assert_eq!(attempt.outcome, AttemptOutcome::RolledBack);
        assert_eq!(attempt.reason.as_deref(), Some("0.24.0 could not start"));
        assert_eq!(linux.linked(), "0.23.0");
        assert_eq!(linux.running_version().as_deref(), Some("0.23.0"));
        assert_eq!(
            linux.steps(),
            ["install 0.24.0", "restart on 0.24.0", "restart on 0.23.0"]
        );
        assert_eq!(linux.versions(), ["0.22.0", "0.23.0", "0.24.0"]);
    }

    #[tokio::test]
    async fn reports_a_restore_that_also_fails() {
        let mut linux = FakeLinux::new(&["0.23.0"], "0.24.0");
        linux.starts = Vec::new();

        let attempt = attempt(&linux).await;

        assert_eq!(attempt.outcome, AttemptOutcome::RestoreFailed);
        assert_eq!(
            attempt.reason.as_deref(),
            Some("0.24.0 could not start, and 0.23.0 could not be restored")
        );
        assert_eq!(linux.linked(), "0.23.0");
    }

    #[tokio::test]
    async fn restores_when_the_service_cannot_restart() {
        let linux = FakeLinux::new(&["0.23.0"], "0.24.0");
        linux.restart_fails.set(true);

        let attempt = attempt(&linux).await;

        assert_eq!(attempt.outcome, AttemptOutcome::RestoreFailed);
        assert_eq!(linux.linked(), "0.23.0");
        assert_eq!(
            linux.steps(),
            ["install 0.24.0", "restart on 0.24.0", "restart on 0.23.0"]
        );
    }

    #[tokio::test]
    async fn records_the_attempt_and_hands_it_to_a_worker() {
        let linux = FakeLinux::new(&["0.23.0"], "0.24.0");
        let records = records(&linux);

        let attempt = prepare(&linux, &records, &linux.request()).await.unwrap();

        assert_eq!(attempt.from_version, "0.23.0");
        assert_eq!(attempt.outcome, AttemptOutcome::Running);
        assert_eq!(linux.steps(), [format!("start worker {}", attempt.id)]);
    }

    #[tokio::test]
    async fn refuses_a_caffold_the_install_script_did_not_install() {
        let linux = FakeLinux::new(&["0.23.0"], "0.24.0");
        let records = records(&linux);
        fs::remove_file(linux.link()).unwrap();
        symlink("/usr/bin/caffold", linux.link()).unwrap();

        let refusal = prepare(&linux, &records, &linux.request())
            .await
            .unwrap_err();

        assert_eq!(
            refusal,
            "This Caffold was not installed by its install script, so it cannot update itself. Install the new version from its release page."
        );
        assert!(linux.steps().is_empty());
    }

    #[tokio::test]
    async fn refuses_when_the_service_runs_another_version() {
        let linux = FakeLinux::new(&["0.23.0", "0.22.0"], "0.24.0");
        let records = records(&linux);
        *linux.running.borrow_mut() = Some(executable(&linux.root(), "0.22.0"));

        let refusal = prepare(&linux, &records, &linux.request())
            .await
            .unwrap_err();

        assert!(
            refusal.starts_with("The caffold systemd service does not run Caffold 0.23.0 from "),
            "{refusal}"
        );
        assert_eq!(records.latest_finished().unwrap(), None);
    }

    #[tokio::test]
    async fn refuses_while_another_update_runs() {
        let linux = FakeLinux::new(&["0.23.0"], "0.24.0");
        let records = records(&linux);
        records
            .begin("0.23.0".to_string(), false, WORKER_PID, |pid| {
                linux.alive(pid)
            })
            .unwrap();

        assert_eq!(
            prepare(&linux, &records, &linux.request())
                .await
                .unwrap_err(),
            "Another Caffold update is already running."
        );
    }

    #[tokio::test]
    async fn leaves_no_attempt_when_the_worker_does_not_start() {
        let mut linux = FakeLinux::new(&["0.23.0"], "0.24.0");
        linux.worker_starts = false;
        let records = records(&linux);
        let mut out = Vec::new();

        assert!(!start(&linux, &records, &linux.request(), &mut out).await);

        assert_eq!(
            String::from_utf8(out).unwrap(),
            "Caffold could not start the update: sh: not found\n"
        );
        assert_eq!(records.latest_finished().unwrap(), None);
        assert!(records.running(|_| true).unwrap().is_none());
    }

    #[test]
    fn moves_the_link_in_one_step() {
        let directory = tempfile::tempdir().unwrap();
        let link = directory.path().join("caffold");
        point_link(&link, Path::new("/opt/first/caffold")).unwrap();
        point_link(&link, Path::new("/opt/second/caffold")).unwrap();

        assert_eq!(
            fs::read_link(&link).unwrap(),
            Path::new("/opt/second/caffold")
        );
        let names: Vec<_> = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, ["caffold"]);
    }

    #[test]
    fn reads_the_version_only_from_a_link_into_the_versions() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("caffold");
        let link = directory.path().join("bin/caffold");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        unpack(&version_directory(&root, "0.23.0"));
        unpack(&version_directory(&root, "latest"));

        point_link(&link, &executable(&root, "0.23.0")).unwrap();
        assert_eq!(linked_version(&link, &root).unwrap(), "0.23.0");

        point_link(&link, &executable(&root, "latest")).unwrap();
        assert!(linked_version(&link, &root).is_err());
        point_link(
            &link,
            &version_directory(&root, "0.23.0").join("caffold-runner"),
        )
        .unwrap();
        assert!(linked_version(&link, &root).is_err());
        point_link(&link, &directory.path().join("elsewhere")).unwrap();
        assert!(linked_version(&link, &root).is_err());
    }

    #[test]
    fn keeps_only_the_versions_it_is_told_to() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        for version in ["0.22.0", "0.23.0", "0.24.0", ".partial-0.25.0"] {
            unpack(&version_directory(root, version));
        }

        remove_other_versions(root, &["0.24.0", "0.23.0"]).unwrap();

        let mut left: Vec<_> = fs::read_dir(root.join(VERSIONS))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["0.23.0", "0.24.0"]);
    }

    #[test]
    fn writes_one_result_line_per_outcome() {
        let linux = FakeLinux::new(&["0.23.0"], "0.24.0");
        let records = records(&linux);
        let attempt = |outcome, to: Option<&str>, reason: Option<&str>| Attempt {
            id: "20261110T121000Z".to_string(),
            started_at: String::new(),
            finished_at: None,
            from_version: "0.23.0".to_string(),
            to_version: to.map(str::to_string),
            started_from_menu_bar: false,
            pid: 1,
            outcome,
            reason: reason.map(str::to_string),
        };

        for (outcome, to, reason, expected) in [
            (
                AttemptOutcome::Succeeded,
                Some("0.24.0"),
                None,
                "Result: Caffold 0.24.0 is running.",
            ),
            (
                AttemptOutcome::UpToDate,
                Some("0.23.0"),
                None,
                "Result: Caffold 0.23.0 is already the newest release.",
            ),
            (
                AttemptOutcome::DownloadFailed,
                Some("0.24.0"),
                Some("GitHub answered HTTP 404 Not Found."),
                "Result: Caffold could not download 0.24.0. GitHub answered HTTP 404 Not Found.",
            ),
            (
                AttemptOutcome::RolledBack,
                Some("0.24.0"),
                Some("0.24.0 could not start"),
                "Result: Caffold was rolled back to 0.23.0: 0.24.0 could not start.",
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
                    Some("0.24.0"),
                    Some("0.24.0 could not start, and 0.23.0 could not be restored")
                )
            )
            .starts_with(
                "Result: Caffold could not be restored: 0.24.0 could not start, and 0.23.0 could not be restored. The records of this attempt are in "
            )
        );
    }
}
