//! One shell process on its own pseudo-terminal.
//!
//! [`spawn`] splits a shell into two halves. The registry's reader thread owns
//! the [`ShellReader`], which pumps the PTY's output and finally reaps the
//! shell. Everything else steers the shell through its [`ShellControl`]:
//! input, window size, the idle check, and the request to stop.

use std::{
    collections::HashMap,
    env,
    fs::File,
    io::{self, ErrorKind, Read, Write},
    os::unix::net::UnixStream,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use alacritty_terminal::{
    event::WindowSize,
    tty::{self, Options, Pty, Shell},
};
use rustix::{
    event::{PollFd, PollFlags, Timespec, poll},
    io::Errno,
    process::{Pid, Signal, WaitId, WaitIdOptions, kill_process, kill_process_group, waitid},
    termios::{Winsize, tcgetpgrp, tcsetwinsize},
};
use tokio::io::{Interest, unix::AsyncFd};

use super::TerminalSize;

/// How long a stopped shell has to exit after its hangup before it is killed.
const HANGUP_GRACE: Duration = Duration::from_secs(3);

#[cfg(target_os = "macos")]
const UTF8_LOCALE: &str = "UTF-8";
#[cfg(not(target_os = "macos"))]
const UTF8_LOCALE: &str = "C.UTF-8";

/// The program a new terminal runs.
#[derive(Clone)]
pub(super) struct ShellCommand {
    program: String,
    args: Vec<String>,
}

impl ShellCommand {
    /// The user's shell started as a login shell, so it reads the same profile
    /// a terminal app's shell does. The shell is started directly rather than
    /// through macOS `login`, which would print a "Last login" line and leave
    /// `login` as the process the idle check compares against.
    pub(super) fn login() -> Self {
        let program = env::var("SHELL")
            .ok()
            .filter(|shell| !shell.is_empty())
            .unwrap_or_else(|| "/bin/sh".to_string());
        Self {
            program,
            args: vec!["-l".to_string()],
        }
    }

    #[cfg(test)]
    pub(super) fn new(program: &str, args: &[&str]) -> Self {
        Self {
            program: program.to_string(),
            args: args.iter().map(|arg| arg.to_string()).collect(),
        }
    }
}

/// Starts `command` in `cwd` on a new PTY of `size`.
pub(super) fn spawn(
    command: &ShellCommand,
    cwd: &Path,
    size: TerminalSize,
) -> io::Result<(ShellControl, ShellReader)> {
    let options = Options {
        shell: Some(Shell::new(command.program.clone(), command.args.clone())),
        working_directory: Some(cwd.to_path_buf()),
        drain_on_exit: false,
        env: environment(),
    };
    let pty = tty::new(&options, window_size(size), 0)?;
    let pid = Pid::from_child(pty.child());
    let master = AsyncFd::with_interest(pty.file().try_clone()?, Interest::WRITABLE)?;
    let (wake, waker) = UnixStream::pair()?;
    wake.set_nonblocking(true)?;
    waker.set_nonblocking(true)?;
    let signals = Arc::new(Signals {
        stop: AtomicBool::new(false),
        exited: AtomicBool::new(false),
        waker,
    });
    let waiter = thread::Builder::new()
        .name("caffold-terminal-wait".to_string())
        .spawn({
            let signals = signals.clone();
            move || {
                block_until_exited(pid);
                signals.raise(&signals.exited);
            }
        })?;
    Ok((
        ShellControl {
            pid,
            master,
            signals: signals.clone(),
        },
        ShellReader {
            pty,
            pid,
            wake,
            signals,
            waiter,
            output_closed: false,
        },
    ))
}

/// The half of a shell that the rest of the backend holds.
pub(super) struct ShellControl {
    pid: Pid,
    /// A duplicate of the PTY master; the reader thread owns the original.
    master: AsyncFd<File>,
    signals: Arc<Signals>,
}

impl ShellControl {
    /// Writes some of `bytes` to the shell's input and returns how many were
    /// taken. Dropping the future before it completes writes nothing.
    pub(super) async fn write(&self, bytes: &[u8]) -> io::Result<usize> {
        loop {
            let mut ready = self.master.writable().await?;
            if let Ok(written) = ready.try_io(|master| master.get_ref().write(bytes)) {
                return written;
            }
        }
    }

    pub(super) fn resize(&self, size: TerminalSize) -> io::Result<()> {
        tcsetwinsize(self.master.get_ref(), winsize(size))?;
        Ok(())
    }

    /// Whether the shell itself holds the terminal's foreground, so no command
    /// it started is running there. Read once, when asked.
    pub(super) fn is_idle(&self) -> bool {
        tcgetpgrp(self.master.get_ref()).is_ok_and(|group| group == self.pid)
    }

    /// Tells the foreground program its window changed, so a full-screen
    /// program draws itself again.
    pub(super) fn redraw(&self) {
        if let Ok(group) = tcgetpgrp(self.master.get_ref()) {
            let _ = kill_process_group(group, Signal::WINCH);
        }
    }

    /// Asks the reader thread to end the shell. Returns at once.
    pub(super) fn stop(&self) {
        self.signals.raise(&self.signals.stop);
    }
}

/// The half of a shell that its reader thread owns.
pub(super) struct ShellReader {
    pty: Pty,
    pid: Pid,
    wake: UnixStream,
    signals: Arc<Signals>,
    waiter: JoinHandle<()>,
    output_closed: bool,
}

pub(super) enum ReadEvent {
    /// This many bytes of output were read into the buffer.
    Output(usize),
    /// The deadline passed with no output.
    Deadline,
    /// The shell exited or was asked to stop; call [`ShellReader::finish`].
    Ended,
}

impl ShellReader {
    /// Waits until the PTY has output, the shell ends, or `deadline` passes.
    pub(super) fn read(&mut self, buffer: &mut [u8], deadline: Option<Instant>) -> ReadEvent {
        loop {
            if self.signals.stop.load(Ordering::SeqCst)
                || self.signals.exited.load(Ordering::SeqCst)
            {
                return ReadEvent::Ended;
            }
            if let Some(length) = self.read_output(buffer) {
                return ReadEvent::Output(length);
            }
            match self.wait(deadline) {
                Ok(true) => {}
                Ok(false) => return ReadEvent::Deadline,
                Err(_) => return ReadEvent::Ended,
            }
        }
    }

    /// Ends the shell and waits for it. A shell that is still running gets a
    /// hangup, then a kill if it outlives [`HANGUP_GRACE`]. Dropping the PTY
    /// reaps the exited shell and closes the master.
    pub(super) fn finish(mut self) {
        if !self.signals.exited.load(Ordering::SeqCst) {
            let _ = kill_process(self.pid, Signal::HUP);
            if !self.wait_for_exit(Some(Instant::now() + HANGUP_GRACE)) {
                let _ = kill_process(self.pid, Signal::KILL);
                self.wait_for_exit(None);
            }
        }
        let _ = self.waiter.join();
        drop(self.pty);
    }

    /// Waits for the shell's exit without reaping it, so its pid cannot be
    /// reused while this thread may still signal it. An exiting shell waits
    /// until its terminal output has been read, so the output is discarded
    /// meanwhile.
    fn wait_for_exit(&mut self, deadline: Option<Instant>) -> bool {
        let mut discarded = [0; 4096];
        loop {
            if self.signals.exited.load(Ordering::SeqCst) {
                return true;
            }
            while self.read_output(&mut discarded).is_some() {}
            match self.wait(deadline) {
                Ok(true) => {}
                Ok(false) => return false,
                // The wake stream failing leaves nothing to wait on.
                Err(_) => return self.signals.exited.load(Ordering::SeqCst),
            }
        }
    }

    /// Reads output that is already waiting, if any.
    fn read_output(&mut self, buffer: &mut [u8]) -> Option<usize> {
        while !self.output_closed {
            match self.pty.file().read(buffer) {
                Ok(0) => self.output_closed = true,
                Ok(length) => return Some(length),
                Err(error) if error.kind() == ErrorKind::WouldBlock => return None,
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                // Linux reports EIO once no process holds the PTY's other end.
                Err(_) => self.output_closed = true,
            }
        }
        None
    }

    /// Polls the PTY (while it can still have output) and the wake stream.
    /// Returns `false` once `deadline` passes.
    fn wait(&mut self, deadline: Option<Instant>) -> io::Result<bool> {
        let timeout = deadline
            .map(|deadline| Timespec::try_from(deadline.saturating_duration_since(Instant::now())))
            .transpose()
            .map_err(|_| io::Error::from(ErrorKind::InvalidInput))?;
        let ready = {
            let mut fds = vec![PollFd::new(&self.wake, PollFlags::IN)];
            if !self.output_closed {
                fds.push(PollFd::new(self.pty.file(), PollFlags::IN));
            }
            match poll(&mut fds, timeout.as_ref()) {
                Ok(ready) => ready,
                Err(Errno::INTR) => return Ok(true),
                Err(error) => return Err(error.into()),
            }
        };
        if ready == 0 {
            return Ok(false);
        }
        let mut drained = [0; 64];
        while matches!((&self.wake).read(&mut drained), Ok(length) if length > 0) {}
        Ok(true)
    }
}

struct Signals {
    stop: AtomicBool,
    exited: AtomicBool,
    waker: UnixStream,
}

impl Signals {
    fn raise(&self, flag: &AtomicBool) {
        flag.store(true, Ordering::SeqCst);
        let _ = (&self.waker).write(&[0]);
    }
}

/// Blocks until `pid` exits, leaving it unreaped.
fn block_until_exited(pid: Pid) {
    while let Err(Errno::INTR) = waitid(
        WaitId::Pid(pid),
        WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
    ) {}
}

fn environment() -> HashMap<String, String> {
    let mut environment = HashMap::from([
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ]);
    let has_locale = ["LANG", "LC_ALL", "LC_CTYPE"]
        .iter()
        .any(|name| env::var_os(name).is_some_and(|value| !value.is_empty()));
    if !has_locale {
        environment.insert("LC_CTYPE".to_string(), UTF8_LOCALE.to_string());
    }
    environment
}

fn window_size(size: TerminalSize) -> WindowSize {
    WindowSize {
        num_lines: size.rows,
        num_cols: size.columns,
        cell_width: 0,
        cell_height: 0,
    }
}

fn winsize(size: TerminalSize) -> Winsize {
    Winsize {
        ws_row: size.rows,
        ws_col: size.columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc::{self, RecvTimeoutError};

    use rustix::{
        io::{FdFlags, fcntl_getfd},
        process::test_kill_process,
    };

    use super::*;

    const WAIT: Duration = Duration::from_secs(10);

    #[test]
    fn every_descriptor_of_the_pty_closes_on_exec() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _entered = runtime.enter();
        let (control, reader) = spawn(
            &ShellCommand::new("/bin/sh", &[]),
            &env::temp_dir(),
            size(80, 24),
        )
        .unwrap();

        for flags in [
            fcntl_getfd(reader.pty.file()),
            fcntl_getfd(control.master.get_ref()),
            fcntl_getfd(&reader.wake),
            fcntl_getfd(&control.signals.waker),
        ] {
            assert!(flags.unwrap().contains(FdFlags::CLOEXEC));
        }

        control.stop();
        reader.finish();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_shell_sees_the_terminal_environment() {
        let mut shell = Running::start(
            "/bin/sh",
            &[
                "-c",
                r#"printf '[%s|%s|%s|%s|%s]' "$TERM" "$COLORTERM" "$LANG" "$LC_ALL" "$LC_CTYPE""#,
            ],
        );
        let inherited = |name| env::var(name).unwrap_or_default();
        let has_locale = ["LANG", "LC_ALL", "LC_CTYPE"]
            .into_iter()
            .any(|name| !inherited(name).is_empty());
        let expected_ctype = if has_locale {
            inherited("LC_CTYPE")
        } else {
            UTF8_LOCALE.to_string()
        };

        shell.wait_for(&format!(
            "[xterm-256color|truecolor|{}|{}|{expected_ctype}]",
            inherited("LANG"),
            inherited("LC_ALL"),
        ));
        shell.wait_for_end();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn input_output_and_size_cross_the_pty() {
        let mut shell = Running::start("/bin/sh", &[]);

        shell.send("echo sum-$((40 + 2))\n").await;
        shell.wait_for("sum-42");
        shell.wait_for_prompt();
        shell.control.resize(size(100, 40)).unwrap();
        shell.send("stty size\n").await;
        shell.wait_for("40 100");

        shell.stop();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_idle_check_follows_the_foreground_process_group() {
        // Markers are computed by the shell, so the echoed command line cannot match them.
        let mut shell = Running::start("/bin/sh", &[]);
        shell.send("echo ready-$((1 + 1))\n").await;
        shell.wait_for("ready-2");
        assert!(shell.control.is_idle());

        shell
            .send("/bin/sh -c 'echo started-$((1 + 2)); exec sleep 30'\n")
            .await;
        shell.wait_for("started-3");
        assert!(!shell.control.is_idle());

        shell.send("\x03").await;
        shell.send("echo back-$((1 + 3))\n").await;
        shell.wait_for("back-4");
        assert!(shell.control.is_idle());

        shell.stop();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_ends_the_reader_when_it_exits() {
        let mut shell = Running::start("/bin/sh", &["-c", "echo bye"]);

        shell.wait_for("bye");
        shell.wait_for_end();

        assert!(test_kill_process(shell.control.pid).is_err());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stopping_kills_a_shell_that_ignores_the_hangup() {
        let mut shell = Running::start(
            "/bin/sh",
            &["-c", "trap '' HUP; echo trapped; while :; do sleep 1; done"],
        );
        shell.wait_for("trapped");
        let stopped = Instant::now();

        shell.stop();

        assert!(stopped.elapsed() >= HANGUP_GRACE);
        assert!(test_kill_process(shell.control.pid).is_err());
    }

    struct Running {
        control: ShellControl,
        output: mpsc::Receiver<Vec<u8>>,
        seen: Vec<u8>,
    }

    impl Running {
        /// Starts the shell with a thread that forwards its output until it ends.
        fn start(program: &str, args: &[&str]) -> Self {
            let (control, mut reader) = spawn(
                &ShellCommand::new(program, args),
                &env::temp_dir(),
                size(80, 24),
            )
            .unwrap();
            let (sender, output) = mpsc::channel();
            thread::spawn(move || {
                let mut buffer = [0; 4096];
                while let ReadEvent::Output(length) = reader.read(&mut buffer, None) {
                    let _ = sender.send(buffer[..length].to_vec());
                }
                reader.finish();
            });
            Self {
                control,
                output,
                seen: Vec::new(),
            }
        }

        async fn send(&self, text: &str) {
            let mut bytes = text.as_bytes();
            while !bytes.is_empty() {
                let written = self.control.write(bytes).await.unwrap();
                bytes = &bytes[written..];
            }
        }

        fn wait_for(&mut self, text: &str) {
            self.wait_until(text, |seen| seen.contains(text));
        }

        /// Waits for the prompt of a plain `/bin/sh`, `$` or `#` for root. A
        /// readline shell writes back the window size it read when it starts a
        /// line, which can undo a resize made before the prompt shows.
        fn wait_for_prompt(&mut self) {
            self.wait_until("the prompt", |seen| seen.trim_end().ends_with(['$', '#']));
        }

        fn wait_until(&mut self, what: &str, done: impl Fn(&str) -> bool) {
            let deadline = Instant::now() + WAIT;
            while !done(&String::from_utf8_lossy(&self.seen)) {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match self.output.recv_timeout(remaining) {
                    Ok(bytes) => self.seen.extend(bytes),
                    Err(error) => panic!(
                        "{error:?} before {what:?}; output so far: {:?}",
                        String::from_utf8_lossy(&self.seen)
                    ),
                }
            }
        }

        /// Waits for the reader thread to finish the shell and drop its sender.
        fn wait_for_end(&mut self) {
            let deadline = Instant::now() + WAIT;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match self.output.recv_timeout(remaining) {
                    Ok(bytes) => self.seen.extend(bytes),
                    Err(RecvTimeoutError::Disconnected) => return,
                    Err(RecvTimeoutError::Timeout) => panic!("the shell did not end"),
                }
            }
        }

        fn stop(&mut self) {
            self.control.stop();
            self.wait_for_end();
        }
    }

    impl Drop for Running {
        /// Ends the shell of a test that failed before stopping it.
        fn drop(&mut self) {
            self.control.stop();
        }
    }

    fn size(columns: u16, rows: u16) -> TerminalSize {
        TerminalSize { columns, rows }
    }
}
