use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

const ATTEMPTS: &str = "attempts";
const RECORD: &str = "attempt.json";
const LOG: &str = "log.txt";
const LOCK: &str = "update.lock";
const BACKUP: &str = "backup";
const FAILED: &str = "failed";
/// Attempt records stay for this many attempts; app bundles stay only for the
/// newest one, because each is a full copy of the app.
const KEPT_ATTEMPTS: usize = 10;
const LOCK_WITHOUT_RECORD_GRACE: Duration = Duration::from_secs(60);

/// One run of `caffold update`. Only the process named by `pid` writes it,
/// except that the next attempt marks an abandoned one `interrupted`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Attempt {
    pub(crate) id: String,
    pub(crate) started_at: String,
    pub(crate) finished_at: Option<String>,
    pub(crate) from_version: String,
    pub(crate) to_version: Option<String>,
    pub(crate) started_from_menu_bar: bool,
    /// `caffold update` until it hands the attempt to its worker, then the
    /// worker.
    pub(crate) pid: u32,
    pub(crate) outcome: AttemptOutcome,
    /// A short sentence the menu-bar app and the browser show as it is.
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AttemptOutcome {
    Running,
    /// Homebrew had nothing newer than the app; nothing restarted.
    UpToDate,
    /// Homebrew failed and undid its own change; nothing restarted.
    HomebrewFailed,
    Succeeded,
    /// The previous app is back on disk and running.
    RolledBack,
    /// Neither the new nor the previous app could be brought back.
    RestoreFailed,
    /// The process running the attempt went away before it finished.
    Interrupted,
}

impl Attempt {
    pub(super) fn finish(&mut self, outcome: AttemptOutcome, reason: Option<String>) {
        self.outcome = outcome;
        self.reason = reason;
        self.finished_at = Some(now());
    }
}

#[derive(Debug)]
pub(super) enum BeginError {
    /// Another attempt is still running in a live process.
    Busy,
    Io(io::Error),
}

impl From<io::Error> for BeginError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// The `caffold-updates` directory of a data directory.
pub(crate) struct AttemptRecords {
    root: PathBuf,
}

impl AttemptRecords {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The newest attempt that has an outcome.
    pub(crate) fn latest_finished(&self) -> io::Result<Option<Attempt>> {
        Ok(self
            .attempts()?
            .into_iter()
            .rev()
            .find(|attempt| attempt.outcome != AttemptOutcome::Running))
    }

    /// The newest attempt whose process is still alive.
    pub(crate) fn running(&self, alive: impl Fn(u32) -> bool) -> io::Result<Option<Attempt>> {
        Ok(self
            .attempts()?
            .into_iter()
            .rev()
            .find(|attempt| attempt.outcome == AttemptOutcome::Running && alive(attempt.pid)))
    }

    /// Takes the update lock and records a new running attempt. Attempts
    /// whose process went away are marked `interrupted` first.
    pub(super) fn begin(
        &self,
        from_version: String,
        started_from_menu_bar: bool,
        pid: u32,
        alive: impl Fn(u32) -> bool,
    ) -> Result<Attempt, BeginError> {
        fs::create_dir_all(self.root.join(ATTEMPTS))?;
        if self.running(&alive)?.is_some() {
            return Err(BeginError::Busy);
        }
        for mut abandoned in self
            .attempts()?
            .into_iter()
            .filter(|attempt| attempt.outcome == AttemptOutcome::Running)
        {
            abandoned.finish(
                AttemptOutcome::Interrupted,
                Some("The update stopped before it finished".to_string()),
            );
            self.save(&abandoned)?;
        }
        let id = self.unused_id()?;
        let lock = self.root.join(LOCK);
        loop {
            match OpenOptions::new().write(true).create_new(true).open(&lock) {
                Ok(mut file) => {
                    file.write_all(id.as_bytes())?;
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    if !self.lock_is_abandoned(&alive)? {
                        return Err(BeginError::Busy);
                    }
                    fs::remove_file(&lock)?;
                }
                Err(error) => return Err(error.into()),
            }
        }
        let attempt = Attempt {
            id,
            started_at: now(),
            finished_at: None,
            from_version,
            to_version: None,
            started_from_menu_bar,
            pid,
            outcome: AttemptOutcome::Running,
            reason: None,
        };
        fs::create_dir(self.directory(&attempt.id))?;
        self.save(&attempt)?;
        Ok(attempt)
    }

    /// Replaces the record whole, so a reader never sees half of it.
    pub(super) fn save(&self, attempt: &Attempt) -> io::Result<()> {
        let record = self.directory(&attempt.id).join(RECORD);
        let staged = record.with_extension("json.tmp");
        fs::write(&staged, serde_json::to_vec_pretty(attempt)?)?;
        fs::rename(staged, record)
    }

    pub(super) fn load(&self, id: &str) -> io::Result<Attempt> {
        let body = fs::read(self.directory(id).join(RECORD))?;
        serde_json::from_slice(&body).map_err(io::Error::other)
    }

    /// Gives the lock up if this attempt still holds it.
    pub(super) fn release(&self, id: &str) -> io::Result<()> {
        let lock = self.root.join(LOCK);
        match fs::read_to_string(&lock) {
            Ok(holder) if holder == id => fs::remove_file(lock),
            Ok(_) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }

    pub(super) fn directory(&self, id: &str) -> PathBuf {
        self.root.join(ATTEMPTS).join(id)
    }

    pub(super) fn log(&self, id: &str) -> PathBuf {
        self.directory(id).join(LOG)
    }

    pub(super) fn backup(&self, id: &str, app: &Path) -> PathBuf {
        self.bundle_in(id, BACKUP, app)
    }

    pub(super) fn failed(&self, id: &str, app: &Path) -> PathBuf {
        self.bundle_in(id, FAILED, app)
    }

    /// App bundles older attempts still hold, which `prune` will delete.
    pub(super) fn retired_bundles(&self, current: &str) -> io::Result<Vec<PathBuf>> {
        let mut bundles = Vec::new();
        for id in self.ids()?.into_iter().filter(|id| id != current) {
            for kind in [BACKUP, FAILED] {
                let directory = self.directory(&id).join(kind);
                let Ok(entries) = fs::read_dir(&directory) else {
                    continue;
                };
                for entry in entries {
                    bundles.push(entry?.path());
                }
            }
        }
        bundles.sort();
        Ok(bundles)
    }

    /// Keeps the newest attempts and the app bundles of `current` only.
    pub(super) fn prune(&self, current: &str) -> io::Result<()> {
        let ids = self.ids()?;
        let dropped = ids.len().saturating_sub(KEPT_ATTEMPTS);
        for (index, id) in ids.iter().enumerate() {
            if id == current {
                continue;
            }
            if index < dropped {
                fs::remove_dir_all(self.directory(id))?;
                continue;
            }
            for kind in [BACKUP, FAILED] {
                match fs::remove_dir_all(self.directory(id).join(kind)) {
                    Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                    _ => {}
                }
            }
        }
        Ok(())
    }

    /// A lock is abandoned when its attempt is no longer running in a live
    /// process. Another `caffold update` writes its record right after taking
    /// the lock, so a lock without a record is abandoned only once it is old.
    fn lock_is_abandoned(&self, alive: &impl Fn(u32) -> bool) -> io::Result<bool> {
        let lock = self.root.join(LOCK);
        let holder = match fs::read_to_string(&lock) {
            Ok(holder) => holder,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(true),
            Err(error) => return Err(error),
        };
        if let Ok(attempt) = self.load(&holder) {
            return Ok(attempt.outcome != AttemptOutcome::Running || !alive(attempt.pid));
        }
        let age = fs::metadata(&lock)?
            .modified()?
            .elapsed()
            .unwrap_or_default();
        Ok(age >= LOCK_WITHOUT_RECORD_GRACE)
    }

    fn bundle_in(&self, id: &str, kind: &str, app: &Path) -> PathBuf {
        let name = app.file_name().unwrap_or(app.as_os_str());
        self.directory(id).join(kind).join(name)
    }

    /// Attempts oldest first. A directory without a readable record is not an
    /// attempt.
    fn attempts(&self) -> io::Result<Vec<Attempt>> {
        Ok(self
            .ids()?
            .iter()
            .filter_map(|id| self.load(id).ok())
            .collect())
    }

    /// Attempt ids oldest first; ids are UTC start times, so they sort by
    /// name.
    fn ids(&self) -> io::Result<Vec<String>> {
        let entries = match fs::read_dir(self.root.join(ATTEMPTS)) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut ids = Vec::new();
        for entry in entries {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                ids.push(entry.file_name().to_string_lossy().into_owned());
            }
        }
        ids.sort();
        Ok(ids)
    }

    fn unused_id(&self) -> io::Result<String> {
        let base = Utc::now().format("%Y%m%dT%H%M%S%.3fZ").to_string();
        let mut id = base.clone();
        let mut suffix = 2;
        while self.directory(&id).exists() {
            // Padded, so a later attempt still sorts after an earlier one.
            id = format!("{base}-{suffix:03}");
            suffix += 1;
        }
        Ok(id)
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn records() -> (tempfile::TempDir, AttemptRecords) {
        let directory = tempfile::tempdir().unwrap();
        let records = AttemptRecords::new(directory.path().join("caffold-updates"));
        (directory, records)
    }

    fn alive(_: u32) -> bool {
        true
    }

    fn dead(_: u32) -> bool {
        false
    }

    fn finished(records: &AttemptRecords, outcome: AttemptOutcome) -> Attempt {
        let mut attempt = records.begin("0.18.2".to_string(), false, 7, dead).unwrap();
        attempt.finish(outcome, None);
        records.save(&attempt).unwrap();
        records.release(&attempt.id).unwrap();
        attempt
    }

    #[test]
    fn records_a_running_attempt_and_its_outcome() {
        let (_directory, records) = records();

        let mut attempt = records
            .begin("0.18.2".to_string(), true, 41, alive)
            .unwrap();

        assert_eq!(attempt.outcome, AttemptOutcome::Running);
        assert_eq!(attempt.from_version, "0.18.2");
        assert!(attempt.started_from_menu_bar);
        assert_eq!(records.running(alive).unwrap(), Some(attempt.clone()));
        assert_eq!(records.latest_finished().unwrap(), None);

        attempt.to_version = Some("0.18.3".to_string());
        attempt.finish(
            AttemptOutcome::RolledBack,
            Some("0.18.3 could not start".to_string()),
        );
        records.save(&attempt).unwrap();

        let saved = records.load(&attempt.id).unwrap();
        assert_eq!(saved, attempt);
        assert!(saved.finished_at.is_some());
        assert_eq!(records.latest_finished().unwrap(), Some(attempt));
        assert_eq!(records.running(alive).unwrap(), None);
    }

    #[test]
    fn writes_the_record_the_browser_reads() {
        let (_directory, records) = records();
        let attempt = records
            .begin("0.18.2".to_string(), false, 41, alive)
            .unwrap();

        let json: serde_json::Value =
            serde_json::from_slice(&fs::read(records.directory(&attempt.id).join(RECORD)).unwrap())
                .unwrap();

        assert_eq!(json["fromVersion"], "0.18.2");
        assert_eq!(json["startedFromMenuBar"], false);
        assert_eq!(json["outcome"], "running");
        assert_eq!(json["toVersion"], serde_json::Value::Null);
        assert!(
            !records
                .directory(&attempt.id)
                .join("attempt.json.tmp")
                .exists()
        );
    }

    #[test]
    fn refuses_a_second_attempt_while_one_runs() {
        let (_directory, records) = records();
        let running = records
            .begin("0.18.2".to_string(), false, 41, alive)
            .unwrap();

        let refused = records.begin("0.18.2".to_string(), false, 42, alive);

        assert!(matches!(refused, Err(BeginError::Busy)));
        assert_eq!(records.running(alive).unwrap(), Some(running));
    }

    #[test]
    fn marks_an_abandoned_attempt_interrupted_and_takes_its_lock() {
        let (_directory, records) = records();
        let abandoned = records
            .begin("0.18.2".to_string(), false, 41, alive)
            .unwrap();

        let next = records
            .begin("0.18.2".to_string(), false, 42, dead)
            .unwrap();

        let abandoned = records.load(&abandoned.id).unwrap();
        assert_eq!(abandoned.outcome, AttemptOutcome::Interrupted);
        assert_eq!(
            abandoned.reason.as_deref(),
            Some("The update stopped before it finished")
        );
        assert_ne!(next.id, abandoned.id);
        assert_eq!(
            fs::read_to_string(records.root.join(LOCK)).unwrap(),
            next.id
        );
    }

    #[test]
    fn waits_for_a_lock_whose_record_is_still_being_written() {
        let (_directory, records) = records();
        fs::create_dir_all(records.root.join(ATTEMPTS)).unwrap();
        fs::write(records.root.join(LOCK), "20260101T000000Z").unwrap();

        let refused = records.begin("0.18.2".to_string(), false, 41, alive);

        assert!(matches!(refused, Err(BeginError::Busy)));
    }

    #[test]
    fn takes_over_an_old_lock_whose_attempt_is_gone() {
        let (_directory, records) = records();
        fs::create_dir_all(records.root.join(ATTEMPTS)).unwrap();
        fs::write(records.root.join(LOCK), "20260101T000000Z").unwrap();
        fs::File::options()
            .write(true)
            .open(records.root.join(LOCK))
            .unwrap()
            .set_modified(std::time::SystemTime::now() - Duration::from_secs(120))
            .unwrap();

        let attempt = records
            .begin("0.18.2".to_string(), false, 41, alive)
            .unwrap();

        assert_eq!(
            fs::read_to_string(records.root.join(LOCK)).unwrap(),
            attempt.id
        );
    }

    #[test]
    fn takes_over_a_lock_left_by_a_finished_attempt() {
        let (_directory, records) = records();
        let mut left = records
            .begin("0.18.2".to_string(), false, 41, alive)
            .unwrap();
        left.finish(AttemptOutcome::Succeeded, None);
        records.save(&left).unwrap();

        let attempt = records
            .begin("0.18.3".to_string(), false, 42, alive)
            .unwrap();

        assert_eq!(
            fs::read_to_string(records.root.join(LOCK)).unwrap(),
            attempt.id
        );
    }

    #[test]
    fn releases_only_its_own_lock() {
        let (_directory, records) = records();
        let attempt = records
            .begin("0.18.2".to_string(), false, 41, alive)
            .unwrap();

        records.release("someone-else").unwrap();
        assert!(records.root.join(LOCK).exists());

        records.release(&attempt.id).unwrap();
        assert!(!records.root.join(LOCK).exists());
        records.release(&attempt.id).unwrap();
    }

    #[test]
    fn gives_attempts_started_in_the_same_second_their_own_directory() {
        let (_directory, records) = records();

        let first = finished(&records, AttemptOutcome::UpToDate);
        let second = finished(&records, AttemptOutcome::Succeeded);

        assert_ne!(first.id, second.id);
        assert_eq!(records.latest_finished().unwrap(), Some(second));
    }

    #[test]
    fn keeps_ten_attempts_and_the_newest_bundles() {
        let (_directory, records) = records();
        let app = Path::new("/Applications/Caffold Server.app");
        let mut ids = Vec::new();
        for _ in 0..12 {
            let attempt = finished(&records, AttemptOutcome::RolledBack);
            fs::create_dir_all(records.backup(&attempt.id, app)).unwrap();
            fs::create_dir_all(records.failed(&attempt.id, app)).unwrap();
            ids.push(attempt.id);
        }
        let current = ids.last().unwrap().clone();

        let retired = records.retired_bundles(&current).unwrap();
        assert_eq!(retired.len(), 22);
        assert!(
            retired
                .iter()
                .all(|bundle| !bundle.starts_with(records.directory(&current)))
        );

        records.prune(&current).unwrap();

        assert_eq!(records.ids().unwrap(), ids[2..].to_vec());
        assert!(records.backup(&current, app).exists());
        assert!(records.failed(&current, app).exists());
        for id in &ids[2..11] {
            assert!(records.directory(id).join(RECORD).exists());
            assert!(!records.directory(id).join(BACKUP).exists());
            assert!(!records.directory(id).join(FAILED).exists());
        }
        assert!(records.retired_bundles(&current).unwrap().is_empty());
    }

    #[test]
    fn reads_nothing_before_the_first_attempt() {
        let (_directory, records) = records();

        assert_eq!(records.latest_finished().unwrap(), None);
        assert_eq!(records.running(alive).unwrap(), None);
        assert!(records.retired_bundles("none").unwrap().is_empty());
        records.prune("none").unwrap();
    }

    #[test]
    fn names_bundles_after_the_app() {
        let (_directory, records) = records();
        let app = Path::new("/Applications/Caffold Server.app");

        assert_eq!(
            records.backup("20261004T121000Z", app),
            records
                .root
                .join("attempts/20261004T121000Z/backup/Caffold Server.app")
        );
        assert_eq!(
            records.failed("20261004T121000Z", app),
            records
                .root
                .join("attempts/20261004T121000Z/failed/Caffold Server.app")
        );
        assert_eq!(
            records.log("20261004T121000Z"),
            records.root.join("attempts/20261004T121000Z/log.txt")
        );
    }
}
