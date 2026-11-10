//! The commands an update runs, and the processes it starts and checks.

use std::{
    ffi::{OsStr, OsString},
    path::Path,
    process::Output,
    time::Duration,
};

use rustix::{
    io::Errno,
    process::{Pid, test_kill_process},
};
use tokio::{process::Command, time::timeout};

/// Whether a process exists. One owned by another user still exists.
pub(crate) fn process_alive(pid: u32) -> bool {
    let Some(pid) = i32::try_from(pid).ok().and_then(Pid::from_raw) else {
        return false;
    };
    match test_kill_process(pid) {
        Ok(()) => true,
        Err(error) => error == Errno::PERM,
    }
}

/// A shell that starts `program` in the background with its output appended
/// to `log`, then exits. The program then belongs neither to this process tree
/// nor to this process group, so whoever stops waiting on `caffold update`
/// does not stop it.
pub(super) fn detached(log: &Path, program: &Path, arguments: &[OsString]) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(r#"log="$1"; shift; "$@" </dev/null >>"$log" 2>&1 &"#)
        .arg("caffold-update")
        .arg(log)
        .arg(program)
        .args(arguments)
        .process_group(0);
    command
}

pub(super) async fn run(
    program: &Path,
    arguments: &[impl AsRef<OsStr>],
    limit: Duration,
) -> Result<CommandOutput, String> {
    let output = timeout(
        limit,
        Command::new(program)
            .args(arguments)
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| {
        format!(
            "{} did not finish within {} seconds",
            program.display(),
            limit.as_secs()
        )
    })?
    .map_err(|error| format!("{} could not start: {error}", program.display()))?;
    Ok(CommandOutput::from(output))
}

pub(super) fn succeed(output: CommandOutput) -> Result<(), String> {
    if output.success {
        Ok(())
    } else {
        Err(output.combined.trim().to_string())
    }
}

pub(super) struct CommandOutput {
    pub(super) success: bool,
    pub(super) stdout: String,
    /// Standard output followed by standard error.
    pub(super) combined: String,
}

impl From<Output> for CommandOutput {
    fn from(output: Output) -> Self {
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr);
        Self {
            success: output.status.success(),
            combined: format!("{stdout}{stderr}"),
            stdout,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn knows_this_process_is_alive() {
        assert!(process_alive(std::process::id()));
        assert!(!process_alive(0));
    }

    #[tokio::test]
    async fn starts_a_detached_program_that_appends_to_the_log() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("log.txt");
        fs::write(&log, "earlier\n").unwrap();
        let done = directory.path().join("done");

        // The shell has exited by the time `status` returns; the program
        // signals its own end by creating `done` after writing.
        let status = detached(
            &log,
            Path::new("/bin/sh"),
            &[
                "-c".into(),
                r#"echo "worker ran"; : > "$0""#.into(),
                done.clone().into(),
            ],
        )
        .status()
        .await
        .unwrap();
        assert!(status.success());

        for _ in 0..250 {
            if done.exists() {
                assert_eq!(fs::read_to_string(&log).unwrap(), "earlier\nworker ran\n");
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the detached program did not finish");
    }

    #[tokio::test]
    async fn reports_how_a_command_ended() {
        let finished = run(
            Path::new("/bin/sh"),
            &["-c", "echo out; echo err >&2"],
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert!(finished.success);
        assert_eq!(finished.stdout, "out\n");
        assert_eq!(finished.combined, "out\nerr\n");

        let failed = run(
            Path::new("/bin/sh"),
            &["-c", "echo nope >&2; exit 3"],
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(succeed(failed), Err("nope".to_string()));
    }
}
