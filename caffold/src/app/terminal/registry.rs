//! The backend's open terminals, at most one per Task or Section.
//!
//! Each terminal runs on its own thread, which starts its shell and owns its
//! screen and viewer (see [`session`](super::session)). The registry keeps
//! only which subject has which terminal and when each was last viewed. Its
//! lock covers finding and changing that list and nothing else, so no request
//! waits here for a terminal's work.

use std::{
    collections::HashMap,
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, Weak},
    thread::{self, JoinHandle},
};

use tokio::{runtime::Handle, sync::watch};

use super::{
    AttachMode, Subject, TerminalSize,
    session::{self, Answer, Deliveries, Delivery, Input, Session},
    shell::ShellCommand,
};

/// Terminals the backend keeps before opening one closes another.
const MAX_TERMINALS: usize = 10;

pub(super) struct Registry {
    command: ShellCommand,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    terminals: HashMap<Subject, Slot>,
    next_session: u64,
    /// Orders opens, attaches, and detaches for "least recently viewed".
    clock: u64,
}

struct Slot {
    session: u64,
    phase: Phase,
    last_viewed: u64,
    thread: Option<JoinHandle<()>>,
}

enum Phase {
    /// The terminal's thread is starting its shell; the value says how that
    /// went once it is known.
    Starting(watch::Receiver<Option<Started>>),
    Running(Arc<Session>),
}

/// Whether a terminal's shell started, with the error's message if not.
type Started = Result<(), String>;

pub(super) enum Attach {
    Attached {
        attachment: Attachment,
        input: Input,
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

    /// Opens a terminal for `subject` in `cwd` unless it has one, and returns
    /// once its shell has started. Opens of a subject whose terminal is still
    /// starting wait for that same terminal.
    pub(super) async fn open(
        self: &Arc<Self>,
        subject: Subject,
        cwd: &Path,
        size: TerminalSize,
    ) -> io::Result<()> {
        let mut started = {
            let mut state = self.state.lock().unwrap();
            match state.terminals.get(&subject).map(|slot| &slot.phase) {
                Some(Phase::Running(_)) => return Ok(()),
                Some(Phase::Starting(started)) => started.clone(),
                None => {
                    let (report, started) = watch::channel(None);
                    let session = state.add(subject.clone(), Phase::Starting(started.clone()));
                    drop(state);
                    self.start(subject, session, cwd.to_path_buf(), size, report);
                    started
                }
            }
        };
        match started.wait_for(Option::is_some).await {
            Ok(started) => started
                .clone()
                .expect("a started terminal reports how")
                .map_err(io::Error::other),
            Err(_) => Err(io::Error::other(
                "the terminal ended before its shell started",
            )),
        }
    }

    /// Ends the subject's terminal, if it has one. Returns at once.
    pub(super) fn close(&self, subject: &Subject) {
        let slot = self.state.lock().unwrap().terminals.remove(subject);
        // A starting terminal ends itself once it finds it was closed.
        if let Some(Slot {
            phase: Phase::Running(session),
            ..
        }) = slot
        {
            session.stop();
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
            if let Phase::Running(session) = &slot.phase {
                session.stop();
            }
        }
        for thread in slots.into_iter().filter_map(|slot| slot.thread) {
            let _ = thread.join();
        }
    }

    /// Attaches a viewer of `size` from browser tab `tab` to `subject`'s
    /// terminal, waiting for a terminal that is still starting.
    pub(super) async fn attach(
        self: &Arc<Self>,
        subject: &Subject,
        mode: AttachMode,
        tab: &str,
        size: TerminalSize,
    ) -> Attach {
        let session = loop {
            let mut started = {
                let state = self.state.lock().unwrap();
                match state.terminals.get(subject).map(|slot| &slot.phase) {
                    None => return Attach::Absent,
                    Some(Phase::Running(session)) => break session.clone(),
                    Some(Phase::Starting(started)) => started.clone(),
                }
            };
            let _ = started.wait_for(Option::is_some).await;
        };
        let viewer = session.next_viewer();
        match session.attach(viewer, mode, tab, size).await {
            Answer::Attached {
                deliveries,
                input,
                snapshot,
            } => {
                self.viewed(subject, session.id());
                Attach::Attached {
                    attachment: Attachment {
                        registry: self.clone(),
                        subject: subject.clone(),
                        session,
                        viewer,
                        deliveries,
                    },
                    input,
                    snapshot,
                }
            }
            Answer::Elsewhere => Attach::Elsewhere,
            Answer::Ended => Attach::Absent,
        }
    }

    /// Starts the terminal's own thread, which starts the shell and then runs
    /// the terminal until it ends.
    fn start(
        self: &Arc<Self>,
        subject: Subject,
        session: u64,
        cwd: PathBuf,
        size: TerminalSize,
        report: watch::Sender<Option<Started>>,
    ) {
        let launch = Launch {
            registry: Arc::downgrade(self),
            subject: subject.clone(),
            session,
            command: self.command.clone(),
            cwd,
            size,
            runtime: Handle::current(),
            report,
        };
        let spawned = thread::Builder::new()
            .name("caffold-terminal".to_string())
            .spawn(move || launch.run());
        match spawned {
            Ok(thread) => {
                let mut state = self.state.lock().unwrap();
                if let Some(slot) = state.slot_mut(&subject, session) {
                    slot.thread = Some(thread);
                }
            }
            // The report's sender went with the thread, so waiting opens
            // learn that the terminal ended before its shell started.
            Err(_) => self.remove(&subject, session),
        }
    }

    /// Marks the subject's starting terminal running, unless it was closed
    /// meanwhile, and asks one other terminal to close if the new one is past
    /// the cap. Returns whether the terminal is still wanted.
    fn started(&self, subject: &Subject, session: &Arc<Session>) -> bool {
        let candidates = {
            let mut state = self.state.lock().unwrap();
            let Some(slot) = state.slot_mut(subject, session.id()) else {
                return false;
            };
            slot.phase = Phase::Running(session.clone());
            if state.terminals.len() <= MAX_TERMINALS {
                return true;
            }
            state
                .terminals
                .iter()
                .filter(|(other, _)| *other != subject)
                .filter_map(|(_, slot)| match &slot.phase {
                    Phase::Running(session) => Some((session.clone(), slot.last_viewed)),
                    Phase::Starting(_) => None,
                })
                .collect()
        };
        // A terminal a viewer attaches to meanwhile refuses, and the backend
        // holds more than the cap until some terminal ends.
        if let Some(victim) = least_needed(candidates) {
            victim.evict();
        }
        true
    }

    /// Removes the subject's terminal if it is still this session.
    fn remove(&self, subject: &Subject, session: u64) {
        let mut state = self.state.lock().unwrap();
        if state.slot_mut(subject, session).is_some() {
            state.terminals.remove(subject);
        }
    }

    /// Records that the subject's terminal was just attached to or detached
    /// from.
    fn viewed(&self, subject: &Subject, session: u64) {
        let mut state = self.state.lock().unwrap();
        state.clock += 1;
        let clock = state.clock;
        if let Some(slot) = state.slot_mut(subject, session) {
            slot.last_viewed = clock;
        }
    }
}

/// One attached viewer's hold on a terminal. Dropping it detaches the viewer.
pub(super) struct Attachment {
    registry: Arc<Registry>,
    subject: Subject,
    session: Arc<Session>,
    viewer: u64,
    deliveries: Deliveries,
}

impl Attachment {
    /// Waits for the viewer's next delivery. Dropping the future loses nothing.
    pub(super) async fn next(&mut self) -> Delivery {
        self.deliveries.next(&self.session, self.viewer).await
    }

    /// Returns once the terminal has the new size.
    pub(super) async fn resize(&self, size: TerminalSize) {
        self.session.resize(self.viewer, size).await;
    }
}

impl Drop for Attachment {
    fn drop(&mut self) {
        self.session.detach(self.viewer);
        self.registry.viewed(&self.subject, self.session.id());
    }
}

/// Test hooks into the registry's terminals.
#[cfg(test)]
impl Registry {
    pub(super) fn contains(&self, subject: &Subject) -> bool {
        self.state.lock().unwrap().terminals.contains_key(subject)
    }

    /// The characters on the subject's screen and scrollback, one line each.
    pub(super) async fn screen_text(&self, subject: &Subject) -> String {
        match self.running(subject) {
            Some(session) => session.text().await,
            None => String::new(),
        }
    }

    /// Holds the subject's terminal up until the returned sender is used or
    /// dropped.
    pub(super) fn hold(&self, subject: &Subject) -> std::sync::mpsc::Sender<()> {
        self.running(subject).expect("the terminal runs").hold()
    }

    /// Whether an attach to the subject has started.
    pub(super) fn attach_requested(&self, subject: &Subject) -> bool {
        self.running(subject)
            .is_some_and(|session| session.attach_requested())
    }

    fn running(&self, subject: &Subject) -> Option<Arc<Session>> {
        match &self.state.lock().unwrap().terminals.get(subject)?.phase {
            Phase::Running(session) => Some(session.clone()),
            Phase::Starting(_) => None,
        }
    }
}

impl State {
    /// Adds a slot for a new terminal and returns its session.
    fn add(&mut self, subject: Subject, phase: Phase) -> u64 {
        self.next_session += 1;
        self.clock += 1;
        self.terminals.insert(
            subject,
            Slot {
                session: self.next_session,
                phase,
                last_viewed: self.clock,
                thread: None,
            },
        );
        self.next_session
    }

    fn slot_mut(&mut self, subject: &Subject, session: u64) -> Option<&mut Slot> {
        self.terminals
            .get_mut(subject)
            .filter(|slot| slot.session == session)
    }
}

/// What a terminal's own thread needs to start and run the terminal.
struct Launch {
    registry: Weak<Registry>,
    subject: Subject,
    session: u64,
    command: ShellCommand,
    cwd: PathBuf,
    size: TerminalSize,
    runtime: Handle,
    report: watch::Sender<Option<Started>>,
}

impl Launch {
    /// The body of the terminal's own thread.
    fn run(self) {
        let started = {
            // The shell's input registers with the runtime.
            let _runtime = self.runtime.enter();
            session::start(self.session, &self.command, &self.cwd, self.size)
        };
        let (session, runner) = match started {
            Ok(started) => started,
            Err(error) => {
                self.remove();
                let _ = self.report.send(Some(Err(error.to_string())));
                return;
            }
        };
        let wanted = self
            .registry
            .upgrade()
            .is_some_and(|registry| registry.started(&self.subject, &session));
        let _ = self.report.send(Some(Ok(())));
        if !wanted {
            session.stop();
        }
        runner.run(|| self.remove());
    }

    fn remove(&self) {
        if let Some(registry) = self.registry.upgrade() {
            registry.remove(&self.subject, self.session);
        }
    }
}

/// The terminal to close for a new one: never one a viewer is attached to,
/// an idle shell before a busy one, and the least recently viewed first.
fn least_needed(candidates: Vec<(Arc<Session>, u64)>) -> Option<Arc<Session>> {
    candidates
        .into_iter()
        .filter(|(session, _)| !session.is_viewed())
        .map(|(session, last_viewed)| (!session.is_idle(), last_viewed, session))
        .min_by_key(|(busy, last_viewed, _)| (*busy, *last_viewed))
        .map(|(_, _, session)| session)
}

#[cfg(test)]
mod tests {
    use std::{
        env,
        pin::pin,
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };

    use futures_util::poll;
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
    async fn opens_of_a_starting_terminal_wait_for_the_same_shell() {
        let terminals = Terminals::new();
        let registry = &terminals.registry;

        let cwd = env::temp_dir();
        let (first, second) = tokio::join!(
            registry.open(task(0), &cwd, SIZE),
            registry.open(task(0), &cwd, SIZE),
        );

        first.unwrap();
        second.unwrap();
        assert_eq!(terminals.count(), 1);
        assert_eq!(terminals.session_id(&task(0)), 1);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn every_open_waiting_for_a_shell_that_cannot_start_is_refused() {
        let registry = Registry::new(ShellCommand::new("/nonexistent/shell", &[]));

        let cwd = env::temp_dir();
        let (first, second) = tokio::join!(
            registry.open(task(0), &cwd, SIZE),
            registry.open(task(0), &cwd, SIZE),
        );

        for refused in [first, second] {
            let error = refused.unwrap_err().to_string();
            assert!(error.contains("/nonexistent/shell"), "{error}");
        }
        assert!(!registry.contains(&task(0)));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_terminal_closed_while_it_starts_ends_once_its_shell_starts() {
        let terminals = Terminals::new();
        let registry = &terminals.registry;
        let cwd = env::temp_dir();
        let mut opening = pin!(registry.open(task(0), &cwd, SIZE));
        assert!(poll!(&mut opening).is_pending());

        registry.close(&task(0));

        opening.await.unwrap();
        assert!(!registry.contains(&task(0)));
        assert!(matches!(
            registry
                .attach(&task(0), AttachMode::Take, "tab", SIZE)
                .await,
            Attach::Absent
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_attach_to_a_starting_terminal_waits_for_its_shell() {
        let terminals = Terminals::new();
        let registry = &terminals.registry;
        let cwd = env::temp_dir();
        let mut opening = pin!(registry.open(task(0), &cwd, SIZE));
        assert!(poll!(&mut opening).is_pending());

        let subject = task(0);
        let (opened, attached) = tokio::join!(
            opening,
            registry.attach(&subject, AttachMode::Take, "tab", SIZE),
        );

        opened.unwrap();
        assert!(matches!(attached, Attach::Attached { .. }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_shows_earlier_output_then_live_output() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;
        viewer.send("echo earlier-$((1 + 1))\n").await;
        viewer.read_until("earlier-2").await;
        drop(viewer);

        let (mut viewer, snapshot) = terminals.attach(&task(0), AttachMode::Resume).await;
        assert!(String::from_utf8_lossy(&snapshot).contains("earlier-2"));
        viewer.send("echo live-$((2 + 2))\n").await;
        viewer.read_until("live-4").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_resizes_the_pty_to_the_viewer() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;

        let mut viewer = terminals
            .attach_sized(
                &task(0),
                AttachMode::Take,
                "tab",
                TerminalSize {
                    columns: 100,
                    rows: 40,
                },
            )
            .await
            .0;
        viewer.send("stty size\n").await;
        viewer.read_until("40 100").await;
        terminals.wait_for_prompt(&task(0)).await;

        viewer
            .attachment
            .resize(TerminalSize {
                columns: 90,
                rows: 30,
            })
            .await;
        viewer.send("stty size\n").await;
        viewer.read_until("30 90").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_program_that_changes_the_window_size_gets_the_viewer_s_size_back() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;

        viewer
            .send("stty rows 10 cols 50; echo changed-$((1 + 1))\n")
            .await;
        viewer.read_until("changed-2").await;
        terminals.wait_for_prompt(&task(0)).await;
        viewer.send("stty size\n").await;

        viewer.read_until("24 80").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_at_the_same_size_asks_a_running_program_to_redraw() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;
        viewer
            .send(
                "/bin/sh -c 'trap \"echo redrawn\" WINCH; echo waiting; while :; do sleep 1; done'\n",
            )
            .await;
        viewer.read_until("waiting\r\n").await;
        drop(viewer);

        let mut viewer = terminals.attach(&task(0), AttachMode::Resume).await.0;

        viewer.read_until("redrawn").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_leaves_a_shell_at_its_prompt_alone() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;
        viewer
            .send("trap 'echo redrawn' WINCH; echo armed-$((1 + 1))\n")
            .await;
        viewer.read_until("armed-2").await;
        drop(viewer);

        let mut viewer = terminals.attach(&task(0), AttachMode::Resume).await.0;
        viewer.send("echo after-$((2 + 2))\n").await;
        let seen = viewer.read_until("after-4").await;

        assert!(!seen.contains("redrawn"), "{seen:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn taking_moves_the_terminal_to_the_new_viewer() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut first = terminals.attach(&task(0), AttachMode::Take).await.0;

        let mut second = terminals.attach(&task(0), AttachMode::Take).await.0;

        assert!(matches!(first.attachment.next().await, Delivery::Taken));
        assert!(first.input.write(b"echo refused\n").await.is_err());
        second.send("echo taken-$((3 + 3))\n").await;
        second.read_until("taken-6").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resuming_leaves_another_viewer_attached() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut first = terminals.attach(&task(0), AttachMode::Take).await.0;

        assert!(matches!(
            terminals
                .registry
                .attach(&task(0), AttachMode::Resume, "another-tab", SIZE)
                .await,
            Attach::Elsewhere
        ));

        first.send("echo still-$((4 + 4))\n").await;
        first.read_until("still-8").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn resuming_from_the_attached_viewer_s_tab_replaces_it() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut dropped = terminals
            .attach_from(&task(0), AttachMode::Take, "tab")
            .await
            .0;

        let mut back = terminals
            .attach_from(&task(0), AttachMode::Resume, "tab")
            .await
            .0;

        assert!(matches!(dropped.attachment.next().await, Delivery::Taken));
        back.send("echo back-$((5 + 5))\n").await;
        back.read_until("back-10").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn only_the_attached_viewer_detaches_the_terminal() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let first = terminals.attach(&task(0), AttachMode::Take).await.0;
        let second = terminals.attach(&task(0), AttachMode::Take).await.0;

        drop(first);
        assert!(matches!(
            terminals
                .registry
                .attach(&task(0), AttachMode::Resume, "another-tab", SIZE)
                .await,
            Attach::Elsewhere
        ));

        drop(second);
        let (_third, _) = terminals.attach(&task(0), AttachMode::Resume).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn attaching_to_a_subject_without_a_terminal_finds_none() {
        let terminals = Terminals::new();

        for mode in [AttachMode::Take, AttachMode::Resume] {
            assert!(matches!(
                terminals.registry.attach(&task(0), mode, "tab", SIZE).await,
                Attach::Absent
            ));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_ends_the_attached_viewer() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;

        terminals.registry.close(&task(0));

        assert!(matches!(viewer.attachment.next().await, Delivery::Ended));
        assert_eq!(terminals.count(), 0);
        terminals.registry.close(&task(0));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_that_exits_ends_its_terminal() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;

        viewer.send("exit\n").await;

        let ended = timeout(WAIT, async {
            loop {
                match viewer.attachment.next().await {
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
    async fn the_late_end_of_a_replaced_terminal_is_ignored() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let replaced = terminals.session_id(&task(0));
        terminals.registry.close(&task(0));
        terminals.open(task(0)).await;
        let current = terminals.session_id(&task(0));

        terminals.registry.remove(&task(0), replaced);
        terminals.registry.remove(&task(1), current);

        assert_eq!(terminals.session_id(&task(0)), current);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_terminal_refuses_to_be_evicted_while_a_viewer_is_attached() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        terminals.open(task(1)).await;
        let _viewer = terminals.attach(&task(0), AttachMode::Take).await.0;

        terminals.session(&task(0)).evict();
        terminals.session(&task(1)).evict();

        // The screen answers after the request before it.
        terminals.registry.screen_text(&task(0)).await;
        assert!(terminals.contains(&task(0)));
        terminals.wait_until_closed(&task(1)).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_cap_closes_the_least_recently_viewed_idle_terminal() {
        let terminals = Terminals::new();
        for index in 0..MAX_TERMINALS {
            terminals.open(task(index)).await;
        }
        // The oldest is busy, and the next oldest is attached.
        terminals.run_foreground(&task(0)).await;
        let _attached = terminals.attach(&task(1), AttachMode::Take).await.0;

        terminals.open(task(MAX_TERMINALS)).await;

        terminals.wait_until_closed(&task(2)).await;
        assert_eq!(terminals.count(), MAX_TERMINALS);
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
            attached.push(terminals.attach(&task(index), AttachMode::Take).await.0);
        }

        terminals.open(task(MAX_TERMINALS)).await;

        terminals.wait_until_closed(&task(0)).await;
        assert_eq!(terminals.count(), MAX_TERMINALS);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_cap_is_exceeded_while_every_terminal_is_attached() {
        let terminals = Terminals::new();
        let mut attached = Vec::new();
        for index in 0..MAX_TERMINALS {
            terminals.open(task(index)).await;
            attached.push(terminals.attach(&task(index), AttachMode::Take).await.0);
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
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;
        viewer
            .send(
                "awk 'BEGIN { for (i = 0; i < 40000; i++) print \"0123456789012345678901234567890123456789\" }'; echo flood-$((5 + 5))\n",
            )
            .await;
        let overflowed = async {
            while !viewer.attachment.deliveries.has_overflowed() {
                sleep(Duration::from_millis(10)).await;
            }
        };
        timeout(WAIT, overflowed)
            .await
            .expect("the output overflowed");

        let Delivery::Resync(snapshot) = viewer.attachment.next().await else {
            panic!("the viewer resyncs first");
        };
        let mut seen = String::from_utf8_lossy(&snapshot).into_owned();
        if !seen.contains("flood-10") {
            seen = viewer.read_until("flood-10").await;
        }
        assert!(seen.contains("flood-10"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn an_unfinished_synchronized_update_reaches_the_screen_when_its_time_is_up() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        let viewer = terminals.attach(&task(0), AttachMode::Take).await.0;
        viewer.send("printf '\\033[?2026hheld-%s' back\n").await;
        drop(viewer);

        // The program never ends the update; the terminal's thread applies it
        // once the parser's deadline passes, without a viewer asking for a
        // snapshot.
        let applied = async {
            while !terminals
                .registry
                .screen_text(&task(0))
                .await
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
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;

        // Reads for a second whatever arrives after asking for the cursor position.
        viewer
            .send(
                "stty -echo -icanon min 0 time 10; printf '\\033[6n'; dd bs=1 count=16 2>/dev/null | od -An -c; stty echo icanon; echo asked-$((6 + 6))\n",
            )
            .await;
        let seen = viewer.read_until("asked-12").await;

        assert!(!seen.contains("033   ["), "an answer arrived: {seen:?}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn closing_all_ends_every_viewer_and_shell() {
        let terminals = Terminals::new();
        terminals.open(task(0)).await;
        terminals
            .open(Subject::Section("section".to_string()))
            .await;
        let mut viewer = terminals.attach(&task(0), AttachMode::Take).await.0;

        let registry = terminals.registry.clone();
        tokio::task::spawn_blocking(move || registry.close_all())
            .await
            .unwrap();

        assert!(matches!(viewer.attachment.next().await, Delivery::Ended));
        assert_eq!(terminals.count(), 0);
    }

    /// A registry of plain `/bin/sh` terminals whose shells end with the test.
    struct Terminals {
        registry: Arc<Registry>,
        tabs: AtomicUsize,
    }

    /// An attached viewer and its input.
    struct Viewer {
        attachment: Attachment,
        input: Input,
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
                .await
                .unwrap();
            self.wait_for_prompt(&subject).await;
        }

        /// Waits until the shell shows its prompt again. A readline shell
        /// writes back the window size it read when it starts a line, which
        /// can undo a resize made before the prompt shows.
        async fn wait_for_prompt(&self, subject: &Subject) {
            let prompted = async {
                while !shows_prompt(&self.registry.screen_text(subject).await) {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            timeout(WAIT, prompted)
                .await
                .expect("the shell shows its prompt");
        }

        /// Attaches a viewer from a browser tab no other viewer came from.
        async fn attach(&self, subject: &Subject, mode: AttachMode) -> (Viewer, Vec<u8>) {
            let tab = format!("tab-{}", self.tabs.fetch_add(1, Ordering::Relaxed));
            self.attach_from(subject, mode, &tab).await
        }

        async fn attach_from(
            &self,
            subject: &Subject,
            mode: AttachMode,
            tab: &str,
        ) -> (Viewer, Vec<u8>) {
            self.attach_sized(subject, mode, tab, SIZE).await
        }

        async fn attach_sized(
            &self,
            subject: &Subject,
            mode: AttachMode,
            tab: &str,
            size: TerminalSize,
        ) -> (Viewer, Vec<u8>) {
            match self.registry.attach(subject, mode, tab, size).await {
                Attach::Attached {
                    attachment,
                    input,
                    snapshot,
                } => (Viewer { attachment, input }, snapshot),
                Attach::Elsewhere => panic!("another viewer is attached"),
                Attach::Absent => panic!("no terminal is open"),
            }
        }

        /// Starts a long command in the terminal and leaves it unattached.
        async fn run_foreground(&self, subject: &Subject) {
            let viewer = self.attach(subject, AttachMode::Take).await.0;
            viewer.send("sleep 30\n").await;
            drop(viewer);
            let session = self.session(subject);
            let busy = async {
                while session.is_idle() || session.is_viewed() {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            timeout(WAIT, busy).await.expect("the command started");
        }

        async fn wait_until_closed(&self, subject: &Subject) {
            let closed = async {
                while self.contains(subject) {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            timeout(WAIT, closed).await.expect("the terminal closed");
        }

        fn session(&self, subject: &Subject) -> Arc<Session> {
            self.registry.running(subject).expect("the terminal runs")
        }

        fn session_id(&self, subject: &Subject) -> u64 {
            self.registry.state.lock().unwrap().terminals[subject].session
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

    impl Viewer {
        async fn send(&self, text: &str) {
            let mut input = text.as_bytes();
            while !input.is_empty() {
                let written = self.input.write(input).await.unwrap();
                input = &input[written..];
            }
        }

        /// Reads deliveries until the output so far contains `text`.
        async fn read_until(&mut self, text: &str) -> String {
            let mut seen = Vec::new();
            let reading = async {
                loop {
                    match self.attachment.next().await {
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

    fn task(index: usize) -> Subject {
        Subject::Task(format!("task-{index}"))
    }

    /// A plain `/bin/sh` waiting for a line ends its screen with `$`, or `#`
    /// for root.
    fn shows_prompt(screen: &str) -> bool {
        screen.trim_end().ends_with(['$', '#'])
    }
}
