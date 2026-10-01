//! The shell's PTY and child, without a process-wide signal subscription.
//! Its owning reader observes this child's exit through `waitid`.

use std::{
    fs::File,
    io,
    os::unix::process::CommandExt,
    path::Path,
    process::{Child, Command},
};

use rustix::{
    fs::{OFlags, fcntl_getfl, fcntl_setfl},
    process::{Pid, ioctl_tiocsctty, setsid},
    stdio::stdin,
    termios::{InputModes, OptionalActions, tcgetattr, tcsetattr},
};
use rustix_openpty::openpty;

use super::{ShellCommand, TerminalSize, environment, winsize};

pub(super) struct Pty {
    child: Child,
    master: File,
}

impl Pty {
    pub(super) fn spawn(shell: &ShellCommand, cwd: &Path, size: TerminalSize) -> io::Result<Self> {
        let pty = openpty(None, Some(&winsize(size)))?;
        let master = File::from(pty.controller);
        let slave = File::from(pty.user);
        fcntl_setfl(&master, fcntl_getfl(&master)? | OFlags::NONBLOCK)?;
        if let Ok(mut attrs) = tcgetattr(&master) {
            attrs.input_modes.insert(InputModes::IUTF8);
            tcsetattr(&master, OptionalActions::Now, &attrs)?;
        }

        let mut command = Command::new(&shell.program);
        command
            .args(&shell.args)
            .current_dir(cwd)
            .envs(environment())
            .env_remove("XDG_ACTIVATION_TOKEN")
            .env_remove("DESKTOP_STARTUP_ID")
            .stdin(slave.try_clone()?)
            .stderr(slave.try_clone()?)
            .stdout(slave);
        // Command sets up stdio before this callback. These child-only calls
        // are async-signal-safe; no allocation or locks may run after fork.
        unsafe {
            command.pre_exec(|| {
                setsid()?;
                ioctl_tiocsctty(stdin())?;
                for signal in [
                    libc::SIGCHLD,
                    libc::SIGHUP,
                    libc::SIGINT,
                    libc::SIGQUIT,
                    libc::SIGTERM,
                    libc::SIGALRM,
                ] {
                    if libc::signal(signal, libc::SIG_DFL) == libc::SIG_ERR {
                        return Err(io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
        Ok(Self {
            child: command.spawn().map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!("Failed to spawn command '{}': {error}", shell.program),
                )
            })?,
            master,
        })
    }

    pub(super) fn pid(&self) -> Pid {
        Pid::from_child(&self.child)
    }

    pub(super) fn file(&self) -> &File {
        &self.master
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        // Normal shutdown has already drained output and observed exit. Kill
        // also covers failures while setting up the reader after spawning.
        // The child is still unreaped, so this PID cannot have been reused.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use rustix::process::test_kill_process;

    use super::*;

    const SIZE: TerminalSize = TerminalSize {
        columns: 80,
        rows: 24,
    };

    #[test]
    fn invalid_shell_or_directory_is_reported() {
        let dir = tempfile::tempdir().unwrap();
        let absent = dir.path().join("absent");
        let valid = ShellCommand::new("/bin/sh", &[]);
        let invalid = ShellCommand::new(absent.to_str().unwrap(), &[]);

        for result in [
            Pty::spawn(&invalid, dir.path(), SIZE),
            Pty::spawn(&valid, &absent, SIZE),
        ] {
            let error = result.err().expect("an invalid start succeeded");
            assert_eq!(error.kind(), io::ErrorKind::NotFound);
        }
    }

    #[test]
    fn dropping_a_started_pty_reaps_its_child() {
        let dir = tempfile::tempdir().unwrap();
        let pty = Pty::spawn(&ShellCommand::new("/bin/sh", &[]), dir.path(), SIZE).unwrap();
        let pid = pty.pid();

        drop(pty);

        assert!(test_kill_process(pid).is_err());
    }
}
