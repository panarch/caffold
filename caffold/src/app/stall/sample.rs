//! Captures this process from outside Tokio and outside the monitor thread.
//! Only one sampler runs at a time; the monitor requests one per stall.

use std::{
    fs::{self, File},
    io::{self, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

use chrono::Utc;
use tracing::warn;
use uuid::Uuid;

const SAMPLE_SECONDS: u32 = 3;
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(10);
const KEPT_SAMPLES: usize = 10;

pub(super) struct Sampler {
    directory: PathBuf,
    running: Arc<AtomicBool>,
}

impl Sampler {
    pub(super) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Starting a sample never waits for it on the monitor or a runtime worker.
    pub(super) fn capture(&self) {
        self.capture_with(|directory| capture_stacks(directory, std::process::id()));
    }

    fn capture_with(&self, capture: impl FnOnce(&Path) -> io::Result<PathBuf> + Send + 'static) {
        if self.running.swap(true, Ordering::AcqRel) {
            return;
        }
        let running = Sampling(self.running.clone());
        let directory = self.directory.clone();
        let result = thread::Builder::new()
            .name("caffold-stack-sample".to_string())
            .spawn(move || {
                let _running = running;
                match capture(&directory) {
                    Ok(path) => warn!("stall stack sample saved to {}", path.display()),
                    Err(error) => warn!(
                        "could not capture a stall stack sample in {}: {error}",
                        directory.display()
                    ),
                }
            });
        if let Err(error) = result {
            warn!("the stack sampling thread could not start: {error}");
        }
    }
}

/// Dropping the capture also releases the slot if starting its thread fails.
struct Sampling(Arc<AtomicBool>);

impl Drop for Sampling {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn capture_stacks(directory: &Path, pid: u32) -> io::Result<PathBuf> {
    fs::create_dir_all(directory)?;
    retain_samples(directory, KEPT_SAMPLES - 1)?;
    let name = format!(
        "stall-{}-{pid}-{}.sample.txt",
        Utc::now().format("%Y%m%dT%H%M%S%.6fZ"),
        Uuid::new_v4()
    );
    let path = directory.join(name);
    File::options().write(true).create_new(true).open(&path)?;
    // The backend log writer may itself be stuck. Run the helper before logging.
    if let Err(error) = sample_into(&path, pid) {
        // Keep partial stacks, and make an empty or incomplete report actionable.
        if let Ok(mut file) = File::options().append(true).open(&path) {
            let _ = writeln!(file, "\nCaffold stack sample failed for PID {pid}: {error}");
        }
        return Err(io::Error::new(
            error.kind(),
            format!("{}: {error}", path.display()),
        ));
    }
    Ok(path)
}

fn sample_into(path: &Path, pid: u32) -> io::Result<()> {
    let mut child = Command::new("/usr/bin/sample")
        .arg(pid.to_string())
        .arg(SAMPLE_SECONDS.to_string())
        .arg("-file")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        // No pipe whose unread output could hold up the sampler.
        .stderr(Stdio::inherit())
        .spawn()?;
    wait_for_sample(&mut child, SAMPLE_TIMEOUT)?;
    if fs::metadata(path)?.len() == 0 {
        return Err(io::Error::other("sample produced no stack report"));
    }
    Ok(())
}

fn wait_for_sample(child: &mut Child, timeout: Duration) -> io::Result<()> {
    let result = poll_sample(child, timeout);
    if result.is_err() {
        match child.kill() {
            Ok(()) => {
                let _ = child.wait();
            }
            Err(error) => warn!("could not stop the stack sampler: {error}"),
        }
    }
    result
}

fn poll_sample(child: &mut Child, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(io::Error::other(format!("sample exited with {status}")))
            };
        }
        if Instant::now() >= deadline {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "sample did not finish within its deadline",
            ));
        }
        thread::sleep(Duration::from_millis(50));
    }
}

/// This directory belongs to stall reports. Leave other names and symlinks alone.
fn retain_samples(directory: &Path, keep: usize) -> io::Result<()> {
    let mut paths = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with("stall-")
            && name.ends_with(".sample.txt")
            && entry.file_type()?.is_file()
        {
            paths.push(entry.path());
        }
    }
    paths.sort();
    let remove = paths.len().saturating_sub(keep);
    for path in paths.into_iter().take(remove) {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{os::unix::fs::symlink, sync::mpsc};

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn retention_keeps_recent_samples_and_leaves_other_files_alone() {
        let directory = tempdir().unwrap();
        for index in 0..12 {
            fs::write(
                directory
                    .path()
                    .join(format!("stall-{index:02}.sample.txt")),
                "stack report",
            )
            .unwrap();
        }
        let unrelated = directory.path().join("notes.txt");
        fs::write(&unrelated, "keep me").unwrap();
        let link = directory.path().join("stall-link.sample.txt");
        symlink(&unrelated, &link).unwrap();
        retain_samples(directory.path(), KEPT_SAMPLES).unwrap();

        assert!(!directory.path().join("stall-00.sample.txt").exists());
        assert!(!directory.path().join("stall-01.sample.txt").exists());
        for index in 2..12 {
            assert!(
                directory
                    .path()
                    .join(format!("stall-{index:02}.sample.txt"))
                    .exists()
            );
        }
        assert_eq!(fs::read_to_string(unrelated).unwrap(), "keep me");
        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
    }

    #[test]
    fn a_sampler_that_never_finishes_hits_its_deadline() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let result = wait_for_sample(&mut child, Duration::from_millis(100));
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        assert!(
            child.try_wait().unwrap().is_some(),
            "timed-out sampler was left running"
        );
    }

    #[test]
    fn an_unsuccessful_sampler_is_an_error() {
        let mut child = Command::new("/usr/bin/false").spawn().unwrap();
        let error = wait_for_sample(&mut child, Duration::from_secs(1)).unwrap_err();
        assert!(error.to_string().contains("sample exited with"));
    }

    #[test]
    fn a_failed_sample_keeps_its_report_path_and_failure_reason() {
        let directory = tempdir().unwrap();
        // Beyond macOS's PID range; this never targets another process.
        let error = capture_stacks(directory.path(), i32::MAX as u32).unwrap_err();
        let paths = fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(paths.len(), 1);
        assert!(error.to_string().contains(paths[0].to_str().unwrap()));
        let report = fs::read_to_string(&paths[0]).unwrap();
        assert!(report.contains("Caffold stack sample failed for PID 2147483647:"));
        assert!(report.contains("sample exited with"));
    }

    #[test]
    fn an_overlapping_capture_is_skipped_and_failure_releases_the_slot() {
        let directory = tempdir().unwrap();
        let sampler = Sampler::new(directory.path().to_path_buf());
        let (started, starts) = mpsc::channel();
        let (release, released) = mpsc::channel();
        sampler.capture_with({
            let started = started.clone();
            move |_| {
                started.send(1).unwrap();
                released.recv().unwrap();
                Err(io::Error::other("sampling failed"))
            }
        });
        assert_eq!(starts.recv_timeout(Duration::from_secs(5)).unwrap(), 1);
        sampler.capture_with({
            let started = started.clone();
            move |_| {
                started.send(2).unwrap();
                Ok(PathBuf::from("unexpected.sample.txt"))
            }
        });
        assert!(matches!(
            starts.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));

        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while sampler.running.load(Ordering::Acquire) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!sampler.running.load(Ordering::Acquire));
        sampler.capture_with(move |_| {
            started.send(3).unwrap();
            Ok(PathBuf::from("later.sample.txt"))
        });
        assert_eq!(starts.recv_timeout(Duration::from_secs(5)).unwrap(), 3);
    }
}
