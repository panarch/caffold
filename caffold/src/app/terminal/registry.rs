//! The backend's open terminals, at most one per Task or Section.
//!
//! A terminal is a shell on a PTY plus the screen `alacritty_terminal` keeps
//! from the shell's output, so a viewer that attaches later first receives
//! the current screen and then the live output. A reader thread per terminal
//! feeds both. At most one viewer is attached to a terminal at a time.
//!
//! Locks are taken in one order: the registry's state, a terminal's screen,
//! a viewer's outbox.

use std::{
    collections::{HashMap, hash_map::Entry},
    io,
    path::Path,
    sync::{Arc, Mutex},
    thread::{self, JoinHandle},
    time::Instant,
};

use alacritty_terminal::{
    event::VoidListener,
    grid::Dimensions,
    term::{Config, Term},
    vte::ansi::Processor,
};
use tokio::sync::Notify;

use super::{
    AttachMode, Subject, TerminalSize,
    shell::{self, ReadEvent, ShellCommand, ShellControl, ShellReader},
    snapshot,
};

/// Terminals the backend keeps before opening one closes another.
const MAX_TERMINALS: usize = 10;
const SCROLLBACK_LINES: usize = 5_000;
/// Output waiting for a slow viewer beyond this is dropped; the viewer then
/// catches up from a new snapshot.
const OUTBOX_LIMIT: usize = 1 << 20;
const READ_BUFFER: usize = 1 << 16;

pub(super) struct Registry {
    command: ShellCommand,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    terminals: HashMap<Subject, Slot>,
    next_session: u64,
    next_viewer: u64,
    /// Orders opens, attaches, and detaches for "least recently viewed".
    clock: u64,
}

struct Slot {
    session: Arc<Session>,
    last_viewed: u64,
    reader: JoinHandle<()>,
}

pub(super) enum Attach {
    Attached {
        attachment: Attachment,
        snapshot: Vec<u8>,
    },
    /// Another viewer is attached and the request did not take it over.
    Elsewhere,
    Absent,
}

impl Registry {
    pub(super) fn new(command: ShellCommand) -> Arc<Self> {
        Arc::new(Self {
            command,
            state: Mutex::default(),
        })
    }

    /// Opens a terminal for `subject` in `cwd` unless it already has one. At
    /// the cap, the new terminal replaces the one [`least_needed`] picks.
    pub(super) fn open(
        self: &Arc<Self>,
        subject: Subject,
        cwd: &Path,
        size: TerminalSize,
    ) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.terminals.contains_key(&subject) {
            return Ok(());
        }
        let (shell, reader) = shell::spawn(&self.command, cwd, size)?;
        state.next_session += 1;
        let session = Arc::new(Session {
            id: state.next_session,
            shell,
            screen: Mutex::new(Screen::new(size)),
        });
        let reader = thread::Builder::new()
            .name("caffold-terminal".to_string())
            .spawn({
                let session = session.clone();
                let registry = Arc::downgrade(self);
                let subject = subject.clone();
                move || {
                    session.pump(reader, || {
                        if let Some(registry) = registry.upgrade() {
                            registry.shell_ended(&subject, session.id);
                        }
                    });
                }
            })?;
        if state.terminals.len() >= MAX_TERMINALS
            && let Some(victim) = least_needed(&state.terminals)
            && let Some(slot) = state.terminals.remove(&victim)
        {
            slot.session.end();
        }
        state.clock += 1;
        let last_viewed = state.clock;
        state.terminals.insert(
            subject,
            Slot {
                session,
                last_viewed,
                reader,
            },
        );
        Ok(())
    }

    pub(super) fn close(&self, subject: &Subject) {
        let slot = self.state.lock().unwrap().terminals.remove(subject);
        if let Some(slot) = slot {
            slot.session.end();
        }
    }

    /// Closes every terminal and waits until their shells have ended.
    pub(super) fn close_all(&self) {
        let slots: Vec<Slot> = self
            .state
            .lock()
            .unwrap()
            .terminals
            .drain()
            .map(|(_, slot)| slot)
            .collect();
        for slot in &slots {
            slot.session.end();
        }
        for slot in slots {
            let _ = slot.reader.join();
        }
    }

    /// Attaches a viewer of `size` from browser tab `tab` to `subject`'s
    /// terminal. `Take` detaches a viewer already attached. `Resume` leaves a
    /// viewer from another tab attached and is refused, but replaces one from
    /// the same tab: that is the tab's own dropped connection.
    pub(super) fn attach(
        self: &Arc<Self>,
        subject: &Subject,
        mode: AttachMode,
        tab: &str,
        size: TerminalSize,
    ) -> Attach {
        let mut state = self.state.lock().unwrap();
        let State {
            terminals,
            next_viewer,
            clock,
            ..
        } = &mut *state;
        let Some(slot) = terminals.get_mut(subject) else {
            return Attach::Absent;
        };
        let session = slot.session.clone();
        let mut screen = session.screen.lock().unwrap();
        match (&screen.viewer, mode) {
            (Some(viewer), AttachMode::Resume) if viewer.tab != tab => return Attach::Elsewhere,
            (Some(viewer), _) => viewer.outbox.close(Closed::Taken),
            (None, _) => {}
        }
        // A changed size makes the PTY signal the program to redraw.
        let resized = screen.resize(size, &session.shell);
        let snapshot = screen.snapshot();
        *next_viewer += 1;
        let outbox = Arc::new(Outbox::default());
        screen.viewer = Some(Viewer {
            id: *next_viewer,
            tab: tab.to_string(),
            outbox: outbox.clone(),
        });
        drop(screen);
        *clock += 1;
        slot.last_viewed = *clock;
        // A full-screen program draws again what the snapshot cannot carry.
        // A shell at its prompt is left alone: the snapshot already shows the
        // prompt, and a redraw there can repeat the line being typed.
        if !resized && !session.shell.is_idle() {
            session.shell.redraw();
        }
        Attach::Attached {
            attachment: Attachment {
                registry: self.clone(),
                subject: subject.clone(),
                session,
                viewer: *next_viewer,
                outbox,
            },
            snapshot,
        }
    }

    #[cfg(test)]
    pub(super) fn contains(&self, subject: &Subject) -> bool {
        self.state.lock().unwrap().terminals.contains_key(subject)
    }

    /// The characters on the subject's screen and scrollback, one line each.
    #[cfg(test)]
    pub(super) fn screen_text(&self, subject: &Subject) -> String {
        use alacritty_terminal::index::{Column, Line};

        let state = self.state.lock().unwrap();
        let Some(slot) = state.terminals.get(subject) else {
            return String::new();
        };
        let screen = slot.session.screen.lock().unwrap();
        let grid = screen.term.grid();
        (grid.topmost_line().0..=grid.bottommost_line().0)
            .map(|line| {
                let row = &grid[Line(line)];
                (0..grid.columns())
                    .map(|column| row[Column(column)].c)
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn detach(&self, subject: &Subject, session: &Session, viewer: u64) {
        let mut state = self.state.lock().unwrap();
        let mut screen = session.screen.lock().unwrap();
        if !screen.is_viewed_by(viewer) {
            return;
        }
        screen.viewer = None;
        drop(screen);
        state.clock += 1;
        let clock = state.clock;
        if let Some(slot) = state.terminals.get_mut(subject)
            && slot.session.id == session.id
        {
            slot.last_viewed = clock;
        }
    }

    /// Removes the terminal whose shell ended, unless a newer terminal for the
    /// same subject has replaced it since.
    fn shell_ended(&self, subject: &Subject, session: u64) {
        let mut state = self.state.lock().unwrap();
        if let Entry::Occupied(slot) = state.terminals.entry(subject.clone())
            && slot.get().session.id == session
        {
            slot.remove().session.end();
        }
    }
}

/// The terminal to close for a new one: never one a viewer is attached to,
/// an idle shell before a busy one, and the least recently viewed first.
fn least_needed(terminals: &HashMap<Subject, Slot>) -> Option<Subject> {
    terminals
        .iter()
        .filter(|(_, slot)| slot.session.screen.lock().unwrap().viewer.is_none())
        .min_by_key(|(_, slot)| (!slot.session.shell.is_idle(), slot.last_viewed))
        .map(|(subject, _)| subject.clone())
}

struct Session {
    id: u64,
    shell: ShellControl,
    screen: Mutex<Screen>,
}

impl Session {
    /// Runs on the terminal's reader thread until the shell ends.
    fn pump(&self, mut reader: ShellReader, ended: impl FnOnce()) {
        let mut buffer = vec![0; READ_BUFFER];
        let mut deadline = None;
        loop {
            deadline = match reader.read(&mut buffer, deadline) {
                ReadEvent::Output(length) => {
                    let mut screen = self.screen.lock().unwrap();
                    // A program can change the PTY's size; a readline shell
                    // such as bash writes back the size it read whenever it
                    // starts a line, undoing a resize that came meanwhile.
                    // The screen's size is put back before its output shows.
                    let _ = self.shell.resize(screen.size);
                    screen.output(&buffer[..length])
                }
                ReadEvent::Deadline => self.screen.lock().unwrap().settle(),
                ReadEvent::Ended => break,
            };
        }
        ended();
        reader.finish();
    }

    /// Tells the attached viewer the terminal ended and stops the shell.
    fn end(&self) {
        if let Some(viewer) = self.screen.lock().unwrap().viewer.take() {
            viewer.outbox.close(Closed::Ended);
        }
        self.shell.stop();
    }
}

struct Screen {
    term: Term<VoidListener>,
    parser: Processor,
    viewer: Option<Viewer>,
    /// The last viewer's size, which the PTY keeps.
    size: TerminalSize,
}

impl Screen {
    /// The screen answers no program queries: `VoidListener` drops the replies
    /// `Term` produces, and the attached viewer's terminal answers instead.
    fn new(size: TerminalSize) -> Self {
        let config = Config {
            scrolling_history: SCROLLBACK_LINES,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &size, VoidListener),
            parser: Processor::new(),
            viewer: None,
            size,
        }
    }

    /// Applies shell output and passes it to the viewer. Returns when an
    /// unfinished synchronized update must be applied regardless.
    fn output(&mut self, bytes: &[u8]) -> Option<Instant> {
        self.parser.advance(&mut self.term, bytes);
        if let Some(viewer) = &self.viewer {
            viewer.outbox.push(bytes);
        }
        self.settle()
    }

    /// Applies a synchronized update whose time is up.
    fn settle(&mut self) -> Option<Instant> {
        let deadline = self.parser.sync_timeout().sync_timeout();
        if deadline.is_some_and(|deadline| deadline <= Instant::now()) {
            self.parser.stop_sync(&mut self.term);
            return None;
        }
        deadline
    }

    fn snapshot(&mut self) -> Vec<u8> {
        // Output held back by an unfinished synchronized update is already
        // with any earlier viewer, so the screen must include it too.
        if self.parser.sync_timeout().sync_timeout().is_some() {
            self.parser.stop_sync(&mut self.term);
        }
        snapshot::serialize(&self.term)
    }

    fn is_viewed_by(&self, viewer: u64) -> bool {
        self.viewer
            .as_ref()
            .is_some_and(|current| current.id == viewer)
    }

    /// Returns whether the size changed.
    fn resize(&mut self, size: TerminalSize, shell: &ShellControl) -> bool {
        if self.size == size {
            return false;
        }
        self.size = size;
        self.term.resize(size);
        let _ = shell.resize(size);
        true
    }
}

impl Dimensions for TerminalSize {
    fn total_lines(&self) -> usize {
        self.screen_lines()
    }

    fn screen_lines(&self) -> usize {
        usize::from(self.rows)
    }

    fn columns(&self) -> usize {
        usize::from(self.columns)
    }
}

struct Viewer {
    id: u64,
    /// The browser tab the viewer attached from.
    tab: String,
    outbox: Arc<Outbox>,
}

/// One attached viewer's hold on a terminal. Dropping it detaches the viewer.
pub(super) struct Attachment {
    registry: Arc<Registry>,
    subject: Subject,
    session: Arc<Session>,
    viewer: u64,
    outbox: Arc<Outbox>,
}

#[derive(Debug)]
pub(super) enum Delivery {
    Output(Vec<u8>),
    /// Output was dropped for this slow viewer; the snapshot replaces its screen.
    Resync(Vec<u8>),
    Taken,
    Ended,
}

impl Attachment {
    /// Waits for the viewer's next delivery. Dropping the future loses nothing.
    pub(super) async fn next(&self) -> Delivery {
        loop {
            let ready = self.outbox.ready.notified();
            match self.outbox.take() {
                Queued::Closed(Closed::Taken) => return Delivery::Taken,
                Queued::Closed(Closed::Ended) => return Delivery::Ended,
                Queued::Output(bytes) => return Delivery::Output(bytes),
                Queued::Overflowed => {
                    // Without a snapshot the viewer is gone, which its outbox shows next.
                    if let Some(snapshot) = self.resync() {
                        return Delivery::Resync(snapshot);
                    }
                }
                Queued::Nothing => ready.await,
            }
        }
    }

    /// Writes some of `bytes` to the shell and returns how many were taken.
    /// Input is refused once this viewer is no longer attached.
    pub(super) async fn write(&self, bytes: &[u8]) -> io::Result<usize> {
        if self.outbox.is_closed() {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        self.session.shell.write(bytes).await
    }

    pub(super) fn resize(&self, size: TerminalSize) {
        let mut screen = self.session.screen.lock().unwrap();
        if screen.is_viewed_by(self.viewer) {
            screen.resize(size, &self.session.shell);
        }
    }

    fn resync(&self) -> Option<Vec<u8>> {
        let mut screen = self.session.screen.lock().unwrap();
        if !screen.is_viewed_by(self.viewer) {
            return None;
        }
        let snapshot = screen.snapshot();
        self.outbox.restart();
        Some(snapshot)
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.registry
            .detach(&self.subject, &self.session, self.viewer);
    }
}

/// Output and events waiting for one viewer.
#[derive(Default)]
struct Outbox {
    queue: Mutex<Queue>,
    ready: Notify,
}

#[derive(Default)]
struct Queue {
    bytes: Vec<u8>,
    overflowed: bool,
    closed: Option<Closed>,
}

#[derive(Clone, Copy)]
enum Closed {
    Taken,
    Ended,
}

enum Queued {
    Closed(Closed),
    Overflowed,
    Output(Vec<u8>),
    Nothing,
}

impl Outbox {
    fn push(&self, bytes: &[u8]) {
        let mut queue = self.queue.lock().unwrap();
        if queue.closed.is_some() || queue.overflowed {
            return;
        }
        if queue.bytes.len() + bytes.len() > OUTBOX_LIMIT {
            queue.overflowed = true;
            queue.bytes = Vec::new();
        } else {
            queue.bytes.extend_from_slice(bytes);
        }
        drop(queue);
        self.ready.notify_one();
    }

    fn close(&self, closed: Closed) {
        self.queue.lock().unwrap().closed.get_or_insert(closed);
        self.ready.notify_one();
    }

    fn is_closed(&self) -> bool {
        self.queue.lock().unwrap().closed.is_some()
    }

    fn take(&self) -> Queued {
        let mut queue = self.queue.lock().unwrap();
        if let Some(closed) = queue.closed {
            Queued::Closed(closed)
        } else if queue.overflowed {
            Queued::Overflowed
        } else if !queue.bytes.is_empty() {
            Queued::Output(std::mem::take(&mut queue.bytes))
        } else {
            Queued::Nothing
        }
    }

    /// Starts over after a snapshot, taken under the screen lock, covered
    /// everything dropped.
    fn restart(&self) {
        let mut queue = self.queue.lock().unwrap();
        queue.overflowed = false;
        queue.bytes = Vec::new();
    }
}

#[cfg(test)]
mod tests {
    use std::{
        env,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    use tokio::time::{sleep, timeout};

    use super::*;

    const WAIT: Duration = Duration::from_secs(10);
    const SIZE: TerminalSize = TerminalSize {
        columns: 80,
        rows: 24,
    };

    #[tokio::test(flavor = "multi_thread")]
    async fn opening_an_open_terminal_keeps_it() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let first = terminals.session_id(&task(0));

        terminals.open(task(0)).await;

        assert_eq!(terminals.session_id(&task(0)), first);
        assert_eq!(terminals.count(), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_shows_earlier_output_then_live_output() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);
        send(&viewer, "echo earlier-$((1 + 1))\n").await;
        read_until(&viewer, "earlier-2").await;
        drop(viewer);

        let (viewer, snapshot) = terminals.attach(&task(0), AttachMode::Resume);
        assert!(String::from_utf8_lossy(&snapshot).contains("earlier-2"));
        send(&viewer, "echo live-$((2 + 2))\n").await;
        read_until(&viewer, "live-4").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_resizes_the_pty_to_the_viewer() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;

        let Attach::Attached {
            attachment: viewer, ..
        } = terminals.registry.attach(
            &task(0),
            AttachMode::Take,
            "tab",
            TerminalSize {
                columns: 100,
                rows: 40,
            },
        )
        else {
            panic!("the terminal is open");
        };
        send(&viewer, "stty size\n").await;
        read_until(&viewer, "40 100").await;
        terminals.wait_for_prompt(&task(0)).await;

        viewer.resize(TerminalSize {
            columns: 90,
            rows: 30,
        });
        send(&viewer, "stty size\n").await;
        read_until(&viewer, "30 90").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_program_that_changes_the_window_size_gets_the_viewer_s_size_back() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);

        send(&viewer, "stty rows 10 cols 50; echo changed-$((1 + 1))\n").await;
        read_until(&viewer, "changed-2").await;
        terminals.wait_for_prompt(&task(0)).await;
        send(&viewer, "stty size\n").await;

        read_until(&viewer, "24 80").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_at_the_same_size_asks_a_running_program_to_redraw() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);
        send(
            &viewer,
            "/bin/sh -c 'trap \"echo redrawn\" WINCH; echo waiting; while :; do sleep 1; done'\n",
        )
        .await;
        read_until(&viewer, "waiting\r\n").await;
        drop(viewer);

        let (viewer, _) = terminals.attach(&task(0), AttachMode::Resume);

        read_until(&viewer, "redrawn").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_leaves_a_shell_at_its_prompt_alone() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);
        send(
            &viewer,
            "trap 'echo redrawn' WINCH; echo armed-$((1 + 1))\n",
        )
        .await;
        read_until(&viewer, "armed-2").await;
        drop(viewer);

        let (viewer, _) = terminals.attach(&task(0), AttachMode::Resume);
        send(&viewer, "echo after-$((2 + 2))\n").await;
        let seen = read_until(&viewer, "after-4").await;

        assert!(!seen.contains("redrawn"), "{seen:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn taking_moves_the_terminal_to_the_new_viewer() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (first, _) = terminals.attach(&task(0), AttachMode::Take);

        let (second, _) = terminals.attach(&task(0), AttachMode::Take);

        assert!(matches!(first.next().await, Delivery::Taken));
        assert!(first.write(b"echo refused\n").await.is_err());
        send(&second, "echo taken-$((3 + 3))\n").await;
        read_until(&second, "taken-6").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resuming_leaves_another_viewer_attached() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (first, _) = terminals.attach(&task(0), AttachMode::Take);

        assert!(matches!(
            terminals
                .registry
                .attach(&task(0), AttachMode::Resume, "another-tab", SIZE),
            Attach::Elsewhere
        ));

        send(&first, "echo still-$((4 + 4))\n").await;
        read_until(&first, "still-8").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resuming_from_the_attached_viewer_s_tab_replaces_it() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (dropped, _) = terminals.attach_from(&task(0), AttachMode::Take, "tab");

        let (back, _) = terminals.attach_from(&task(0), AttachMode::Resume, "tab");

        assert!(matches!(dropped.next().await, Delivery::Taken));
        send(&back, "echo back-$((5 + 5))\n").await;
        read_until(&back, "back-10").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_the_attached_viewer_detaches_the_terminal() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (first, _) = terminals.attach(&task(0), AttachMode::Take);
        let (second, _) = terminals.attach(&task(0), AttachMode::Take);

        drop(first);
        assert!(matches!(
            terminals
                .registry
                .attach(&task(0), AttachMode::Resume, "another-tab", SIZE),
            Attach::Elsewhere
        ));

        drop(second);
        let (_third, _) = terminals.attach(&task(0), AttachMode::Resume);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_to_a_subject_without_a_terminal_finds_none() {
        let terminals = Terminals::new();

        for mode in [AttachMode::Take, AttachMode::Resume] {
            assert!(matches!(
                terminals.registry.attach(&task(0), mode, "tab", SIZE),
                Attach::Absent
            ));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_ends_the_attached_viewer() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);

        terminals.registry.close(&task(0));

        assert!(matches!(viewer.next().await, Delivery::Ended));
        assert_eq!(terminals.count(), 0);
        terminals.registry.close(&task(0));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_that_exits_ends_its_terminal() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);

        send(&viewer, "exit\n").await;

        let ended = timeout(WAIT, async {
            loop {
                match viewer.next().await {
                    Delivery::Ended => return,
                    Delivery::Output(_) => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
        });
        ended.await.expect("the terminal ended");
        assert_eq!(terminals.count(), 0);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_late_exit_of_a_replaced_shell_is_ignored() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let replaced = terminals.session_id(&task(0));
        terminals.registry.close(&task(0));
        terminals.open(task(0)).await;
        let current = terminals.session_id(&task(0));

        terminals.registry.shell_ended(&task(0), replaced);
        terminals.registry.shell_ended(&task(1), current);

        assert_eq!(terminals.session_id(&task(0)), current);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_cap_closes_the_least_recently_viewed_idle_terminal() {
        let terminals = Terminals::new();
        for index in 0..MAX_TERMINALS {
            terminals.open(task(index)).await;
        }
        // The oldest is busy, and the next oldest is attached.
        terminals.run_foreground(&task(0)).await;
        let (_attached, _) = terminals.attach(&task(1), AttachMode::Take);

        terminals.open(task(MAX_TERMINALS)).await;

        assert_eq!(terminals.count(), MAX_TERMINALS);
        assert!(!terminals.contains(&task(2)));
        for kept in [0, 1, 3, MAX_TERMINALS] {
            assert!(terminals.contains(&task(kept)), "task {kept} is kept");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_cap_closes_a_busy_terminal_when_no_other_is_free() {
        let terminals = Terminals::new();
        for index in 0..MAX_TERMINALS {
            terminals.open(task(index)).await;
        }
        terminals.run_foreground(&task(0)).await;
        let mut attached = Vec::new();
        for index in 1..MAX_TERMINALS {
            attached.push(terminals.attach(&task(index), AttachMode::Take).0);
        }

        terminals.open(task(MAX_TERMINALS)).await;

        assert_eq!(terminals.count(), MAX_TERMINALS);
        assert!(!terminals.contains(&task(0)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_cap_is_exceeded_while_every_terminal_is_attached() {
        let terminals = Terminals::new();
        let mut attached = Vec::new();
        for index in 0..MAX_TERMINALS {
            terminals.open(task(index)).await;
            attached.push(terminals.attach(&task(index), AttachMode::Take).0);
        }

        terminals
            .open(Subject::Section("section".to_string()))
            .await;

        assert_eq!(terminals.count(), MAX_TERMINALS + 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_slow_viewer_catches_up_from_a_snapshot() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);
        send(
            &viewer,
            "awk 'BEGIN { for (i = 0; i < 40000; i++) print \"0123456789012345678901234567890123456789\" }'; echo flood-$((5 + 5))\n",
        )
        .await;
        let overflowed = async {
            while !viewer.outbox.queue.lock().unwrap().overflowed {
                sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(WAIT, overflowed)
            .await
            .expect("the outbox overflowed");

        let Delivery::Resync(snapshot) = viewer.next().await else {
            panic!("the viewer resyncs first");
        };
        let mut seen = String::from_utf8_lossy(&snapshot).into_owned();
        if !seen.contains("flood-10") {
            seen = read_until(&viewer, "flood-10").await;
        }
        assert!(seen.contains("flood-10"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unfinished_synchronized_update_reaches_the_screen_when_its_time_is_up() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let session = terminals.registry.state.lock().unwrap().terminals[&task(0)]
            .session
            .clone();
        let mut input: &[u8] = b"printf '\\033[?2026hheld-%s' back\n";
        while !input.is_empty() {
            let written = session.shell.write(input).await.unwrap();
            input = &input[written..];
        }

        // The program never ends the update; the reader thread applies it once
        // the parser's deadline passes, without a viewer asking for a snapshot.
        let applied = async {
            while !terminals
                .registry
                .screen_text(&task(0))
                .contains("held-back")
            {
                sleep(Duration::from_millis(20)).await;
            }
        };
        timeout(WAIT, applied)
            .await
            .expect("the held output was applied");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_backend_leaves_terminal_queries_to_the_viewer() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);

        // Reads for a second whatever arrives after asking for the cursor position.
        send(
            &viewer,
            "stty -echo -icanon min 0 time 10; printf '\\033[6n'; dd bs=1 count=16 2>/dev/null | od -An -c; stty echo icanon; echo asked-$((6 + 6))\n",
        )
        .await;
        let seen = read_until(&viewer, "asked-12").await;

        assert!(!seen.contains("033   ["), "an answer arrived: {seen:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_all_ends_every_viewer_and_shell() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        terminals
            .open(Subject::Section("section".to_string()))
            .await;
        let (viewer, _) = terminals.attach(&task(0), AttachMode::Take);

        let registry = terminals.registry.clone();
        tokio::task::spawn_blocking(move || registry.close_all())
            .await
            .unwrap();

        assert!(matches!(viewer.next().await, Delivery::Ended));
        assert_eq!(terminals.count(), 0);
    }

    /// A registry of plain `/bin/sh` terminals whose shells end with the test.
    struct Terminals {
        registry: Arc<Registry>,
        tabs: AtomicUsize,
    }

    impl Terminals {
        fn new() -> Self {
            Self {
                registry: Registry::new(ShellCommand::new("/bin/sh", &[])),
                tabs: AtomicUsize::new(0),
            }
        }

        /// Opens a terminal and waits for its shell's first prompt, so a test
        /// that attaches at another size resizes a shell sitting at it.
        async fn open(&self, subject: Subject) {
            self.registry
                .open(subject.clone(), &env::temp_dir(), SIZE)
                .unwrap();
            self.wait_for_prompt(&subject).await;
        }

        /// Waits until the shell shows its prompt again. A readline shell
        /// writes back the window size it read when it starts a line, which
        /// can undo a resize made before the prompt shows.
        async fn wait_for_prompt(&self, subject: &Subject) {
            let prompted = async {
                while !shows_prompt(&self.registry.screen_text(subject)) {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            timeout(WAIT, prompted)
                .await
                .expect("the shell shows its prompt");
        }

        /// Attaches a viewer from a browser tab no other viewer came from.
        fn attach(&self, subject: &Subject, mode: AttachMode) -> (Attachment, Vec<u8>) {
            let tab = format!("tab-{}", self.tabs.fetch_add(1, Ordering::Relaxed));
            self.attach_from(subject, mode, &tab)
        }

        fn attach_from(
            &self,
            subject: &Subject,
            mode: AttachMode,
            tab: &str,
        ) -> (Attachment, Vec<u8>) {
            match self.registry.attach(subject, mode, tab, SIZE) {
                Attach::Attached {
                    attachment,
                    snapshot,
                } => (attachment, snapshot),
                Attach::Elsewhere => panic!("another viewer is attached"),
                Attach::Absent => panic!("no terminal is open"),
            }
        }

        /// Starts a long command in the terminal without attaching to it.
        async fn run_foreground(&self, subject: &Subject) {
            let session = self.registry.state.lock().unwrap().terminals[subject]
                .session
                .clone();
            let mut input: &[u8] = b"sleep 30\n";
            while !input.is_empty() {
                let written = session.shell.write(input).await.unwrap();
                input = &input[written..];
            }
            let busy = async {
                while session.shell.is_idle() {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            timeout(WAIT, busy).await.expect("the command started");
        }

        fn session_id(&self, subject: &Subject) -> u64 {
            self.registry.state.lock().unwrap().terminals[subject]
                .session
                .id
        }

        fn contains(&self, subject: &Subject) -> bool {
            self.registry.contains(subject)
        }

        fn count(&self) -> usize {
            self.registry.state.lock().unwrap().terminals.len()
        }
    }

    impl Drop for Terminals {
        fn drop(&mut self) {
            self.registry.close_all();
        }
    }

    fn task(index: usize) -> Subject {
        Subject::Task(format!("task-{index}"))
    }

    /// A plain `/bin/sh` waiting for a line ends its screen with `$`, or `#`
    /// for root.
    fn shows_prompt(screen: &str) -> bool {
        screen.trim_end().ends_with(['$', '#'])
    }

    async fn send(viewer: &Attachment, text: &str) {
        let mut input = text.as_bytes();
        while !input.is_empty() {
            let written = viewer.write(input).await.unwrap();
            input = &input[written..];
        }
    }

    /// Reads deliveries until the output so far contains `text`.
    async fn read_until(viewer: &Attachment, text: &str) -> String {
        let mut seen = Vec::new();
        let reading = async {
            loop {
                match viewer.next().await {
                    Delivery::Output(bytes) | Delivery::Resync(bytes) => seen.extend(bytes),
                    other => panic!("unexpected {other:?}"),
                }
                if String::from_utf8_lossy(&seen).contains(text) {
                    return;
                }
            }
        };
        if timeout(WAIT, reading).await.is_err() {
            panic!("no {text:?} in {:?}", String::from_utf8_lossy(&seen));
        }
        String::from_utf8_lossy(&seen).into_owned()
    }
}
