//! One terminal: its shell, the screen `alacritty_terminal` keeps from the
//! shell's output, and the viewer attached to it.
//!
//! The terminal's own thread runs [`Runner`], which alone owns the screen and
//! the viewer. The rest of the backend reaches them through [`Session`]:
//! requests are sent without waiting for the thread, and answers are awaited,
//! so a busy or stuck terminal holds up only its own screens and never a
//! request thread of the server.

use std::{
    io,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    time::Instant,
};

use alacritty_terminal::{
    event::VoidListener,
    grid::Dimensions,
    term::{Config, Term},
    vte::ansi::Processor,
};
use tokio::sync::{mpsc as delivery, oneshot};

use super::{
    AttachMode, TerminalSize,
    shell::{self, ReadEvent, ShellCommand, ShellControl, ShellReader},
    snapshot,
};

const SCROLLBACK_LINES: usize = 5_000;
/// Output waiting for a slow viewer beyond this is dropped; the viewer then
/// catches up from a new snapshot.
const OUTBOX_LIMIT: usize = 1 << 20;
const READ_BUFFER: usize = 1 << 16;

/// Starts `command` in `cwd` on a new PTY of `size`. Returns the handle the
/// rest of the backend keeps and the loop the terminal's own thread runs.
///
/// Must run in the Tokio runtime's context, which the shell's input
/// registers with.
pub(super) fn start(
    id: u64,
    command: &ShellCommand,
    cwd: &Path,
    size: TerminalSize,
) -> io::Result<(Arc<Session>, Runner)> {
    let (shell, reader) = shell::spawn(command, cwd, size)?;
    let shell = Arc::new(shell);
    let (requests, received) = mpsc::channel();
    let viewed = Arc::new(AtomicBool::new(false));
    let session = Arc::new(Session {
        id,
        shell: shell.clone(),
        requests,
        viewed: viewed.clone(),
        next_viewer: AtomicU64::new(0),
    });
    let runner = Runner {
        reader,
        requests: received,
        screen: Screen::new(size, shell, viewed),
    };
    Ok((session, runner))
}

/// The rest of the backend's hold on one terminal. Nothing here waits for the
/// terminal's thread.
pub(super) struct Session {
    id: u64,
    shell: Arc<ShellControl>,
    requests: Sender<Request>,
    /// Whether a viewer is attached, as the terminal's thread last published
    /// it. Only orders the terminals a new one may close; the thread decides.
    viewed: Arc<AtomicBool>,
    next_viewer: AtomicU64,
}

/// A terminal's answer to an attach.
pub(super) enum Answer {
    Attached {
        deliveries: Deliveries,
        input: Input,
        snapshot: Vec<u8>,
    },
    /// Another tab's viewer is attached and the request did not take it over.
    Elsewhere,
    /// The terminal ended before it answered.
    Ended,
}

impl Session {
    pub(super) fn id(&self) -> u64 {
        self.id
    }

    /// A viewer identifier no earlier viewer of this terminal used.
    pub(super) fn next_viewer(&self) -> u64 {
        self.next_viewer.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Attaches `viewer`, a screen of `size` in browser tab `tab`. `Take`
    /// detaches a viewer already attached. `Resume` is refused while a viewer
    /// from another tab is attached, but replaces one from the same tab: that
    /// is the tab's own dropped connection.
    pub(super) async fn attach(
        &self,
        viewer: u64,
        mode: AttachMode,
        tab: &str,
        size: TerminalSize,
    ) -> Answer {
        let (reply, answer) = oneshot::channel();
        self.send(Request::Attach {
            viewer,
            mode,
            tab: tab.to_string(),
            size,
            reply,
        });
        match answer.await {
            Ok(Reply::Attached {
                deliveries,
                snapshot,
            }) => Answer::Attached {
                input: Input {
                    shell: self.shell.clone(),
                    shared: deliveries.shared.clone(),
                },
                deliveries,
                snapshot,
            },
            Ok(Reply::Elsewhere) => Answer::Elsewhere,
            Err(_) => Answer::Ended,
        }
    }

    /// Resizes the viewer's screen and returns once the terminal has, so input
    /// the viewer sends after a resize reaches a shell that has the new size.
    pub(super) async fn resize(&self, viewer: u64, size: TerminalSize) {
        let (applied, done) = oneshot::channel();
        self.send(Request::Resize {
            viewer,
            size,
            applied,
        });
        let _ = done.await;
    }

    pub(super) fn detach(&self, viewer: u64) {
        self.send(Request::Detach { viewer });
    }

    /// Ends the terminal unless a viewer is attached when its thread gets to
    /// the request.
    pub(super) fn evict(&self) {
        self.send(Request::Evict);
    }

    /// Ends the terminal.
    pub(super) fn stop(&self) {
        self.shell.stop();
    }

    pub(super) fn is_viewed(&self) -> bool {
        self.viewed.load(Ordering::Relaxed)
    }

    /// Whether the shell itself holds the terminal's foreground. Read once,
    /// when asked.
    pub(super) fn is_idle(&self) -> bool {
        self.shell.is_idle()
    }

    fn send(&self, request: Request) {
        // The receiver is gone once the terminal ended; the answer's sender
        // goes with the request, so an awaited answer reports the end.
        let _ = self.requests.send(request);
        self.shell.wake();
    }
}

/// Test hooks into a running terminal.
#[cfg(test)]
impl Session {
    /// Holds the terminal's thread up until the returned sender is used or
    /// dropped. Returns once the thread is held.
    pub(super) fn hold(&self) -> Sender<()> {
        let (release, released) = mpsc::channel();
        let (held, holding) = mpsc::channel();
        self.send(Request::Hold { held, released });
        holding.recv().expect("the terminal holds");
        release
    }

    /// Whether an attach has asked for a viewer identifier.
    pub(super) fn attach_requested(&self) -> bool {
        self.next_viewer.load(Ordering::Relaxed) > 0
    }

    /// The characters on the screen and scrollback, one line each.
    pub(super) async fn text(&self) -> String {
        let (reply, text) = oneshot::channel();
        self.send(Request::Text(reply));
        text.await.unwrap_or_default()
    }
}

enum Request {
    Attach {
        viewer: u64,
        mode: AttachMode,
        tab: String,
        size: TerminalSize,
        reply: oneshot::Sender<Reply>,
    },
    Resize {
        viewer: u64,
        size: TerminalSize,
        applied: oneshot::Sender<()>,
    },
    /// The viewer's output overflowed; answers the snapshot it starts over
    /// from and the epoch of the output that follows it.
    Resync {
        viewer: u64,
        reply: oneshot::Sender<(u64, Vec<u8>)>,
    },
    Detach {
        viewer: u64,
    },
    Evict,
    #[cfg(test)]
    Hold {
        held: Sender<()>,
        released: Receiver<()>,
    },
    #[cfg(test)]
    Text(oneshot::Sender<String>),
}

enum Reply {
    Attached {
        deliveries: Deliveries,
        snapshot: Vec<u8>,
    },
    Elsewhere,
}

/// The loop a terminal's own thread runs until its shell ends.
pub(super) struct Runner {
    reader: ShellReader,
    requests: Receiver<Request>,
    screen: Screen,
}

impl Runner {
    /// Runs until the shell ends or is stopped. `ended` runs as soon as the
    /// terminal has ended, before its viewer is told and its shell is reaped.
    pub(super) fn run(self, ended: impl FnOnce()) {
        let Self {
            mut reader,
            requests,
            mut screen,
        } = self;
        let mut buffer = vec![0; READ_BUFFER];
        let mut deadline = None;
        loop {
            // Requests go first, so output keeps none waiting past one read.
            while let Ok(request) = requests.try_recv() {
                screen.handle(request);
            }
            deadline = match reader.read(&mut buffer, deadline) {
                ReadEvent::Output(length) => screen.output(&buffer[..length]),
                ReadEvent::Deadline => screen.settle(),
                ReadEvent::Woken => deadline,
                ReadEvent::Ended => break,
            };
        }
        ended();
        screen.end();
        // Requests still waiting are dropped with their answers' senders.
        drop(requests);
        reader.finish();
    }
}

struct Screen {
    term: Term<VoidListener>,
    parser: Processor,
    /// The last viewer's size, which the PTY keeps.
    size: TerminalSize,
    viewer: Option<Viewer>,
    shell: Arc<ShellControl>,
    viewed: Arc<AtomicBool>,
}

struct Viewer {
    id: u64,
    /// The browser tab the viewer attached from.
    tab: String,
    sink: Sink,
}

impl Screen {
    /// The screen answers no program queries: `VoidListener` drops the replies
    /// `Term` produces, and the attached viewer's terminal answers instead.
    fn new(size: TerminalSize, shell: Arc<ShellControl>, viewed: Arc<AtomicBool>) -> Self {
        let config = Config {
            scrolling_history: SCROLLBACK_LINES,
            ..Config::default()
        };
        Self {
            term: Term::new(config, &size, VoidListener),
            parser: Processor::new(),
            size,
            viewer: None,
            shell,
            viewed,
        }
    }

    fn handle(&mut self, request: Request) {
        match request {
            Request::Attach {
                viewer,
                mode,
                tab,
                size,
                reply,
            } => self.attach(viewer, mode, tab, size, reply),
            Request::Resize {
                viewer,
                size,
                applied,
            } => {
                if self.is_viewed_by(viewer) {
                    self.resize(size);
                }
                let _ = applied.send(());
            }
            Request::Resync { viewer, reply } => self.resync(viewer, reply),
            Request::Detach { viewer } => {
                if self.is_viewed_by(viewer) {
                    self.set_viewer(None);
                }
            }
            Request::Evict => {
                if self.viewer.is_none() {
                    self.shell.stop();
                }
            }
            #[cfg(test)]
            Request::Hold { held, released } => {
                let _ = held.send(());
                let _ = released.recv();
            }
            #[cfg(test)]
            Request::Text(reply) => {
                let _ = reply.send(self.text());
            }
        }
    }

    fn attach(
        &mut self,
        viewer: u64,
        mode: AttachMode,
        tab: String,
        size: TerminalSize,
        reply: oneshot::Sender<Reply>,
    ) {
        match (&self.viewer, mode) {
            (Some(current), AttachMode::Resume) if current.tab != tab => {
                let _ = reply.send(Reply::Elsewhere);
                return;
            }
            (Some(current), _) => current.sink.close(Closed::Taken),
            (None, _) => {}
        }
        // A changed size makes the PTY signal the program to redraw.
        let resized = self.resize(size);
        let snapshot = self.snapshot();
        let (sink, deliveries) = deliveries();
        self.set_viewer(Some(Viewer {
            id: viewer,
            tab,
            sink,
        }));
        // A full-screen program draws again what the snapshot cannot carry.
        // A shell at its prompt is left alone: the snapshot already shows the
        // prompt, and a redraw there can repeat the line being typed.
        if !resized && !self.shell.is_idle() {
            self.shell.redraw();
        }
        let attached = Reply::Attached {
            deliveries,
            snapshot,
        };
        // Nobody waits for a viewer whose attach was given up.
        if reply.send(attached).is_err() {
            self.set_viewer(None);
        }
    }

    fn resync(&mut self, viewer: u64, reply: oneshot::Sender<(u64, Vec<u8>)>) {
        if !self.is_viewed_by(viewer) {
            return;
        }
        let snapshot = self.snapshot();
        if let Some(current) = &mut self.viewer {
            let epoch = current.sink.restart();
            let _ = reply.send((epoch, snapshot));
        }
    }

    /// Applies shell output and passes it to the viewer. Returns when an
    /// unfinished synchronized update must be applied regardless.
    fn output(&mut self, bytes: &[u8]) -> Option<Instant> {
        // A program can change the PTY's size; a readline shell such as bash
        // writes back the size it read whenever it starts a line, undoing a
        // resize that came meanwhile. The screen's size is put back before
        // its output shows.
        let _ = self.shell.resize(self.size);
        self.parser.advance(&mut self.term, bytes);
        if let Some(viewer) = &self.viewer {
            viewer.sink.push(bytes);
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

    /// Returns whether the size changed.
    fn resize(&mut self, size: TerminalSize) -> bool {
        if self.size == size {
            return false;
        }
        self.size = size;
        self.term.resize(size);
        let _ = self.shell.resize(size);
        true
    }

    /// Tells the attached viewer the terminal ended.
    fn end(&mut self) {
        if let Some(viewer) = &self.viewer {
            viewer.sink.close(Closed::Ended);
        }
        self.set_viewer(None);
    }

    fn set_viewer(&mut self, viewer: Option<Viewer>) {
        self.viewed.store(viewer.is_some(), Ordering::Relaxed);
        self.viewer = viewer;
    }

    fn is_viewed_by(&self, viewer: u64) -> bool {
        self.viewer
            .as_ref()
            .is_some_and(|current| current.id == viewer)
    }

    #[cfg(test)]
    fn text(&self) -> String {
        use alacritty_terminal::index::{Column, Line};

        let grid = self.term.grid();
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

/// What one attached viewer receives, in order.
#[derive(Debug)]
pub(super) enum Delivery {
    Output(Vec<u8>),
    /// Output was dropped for this slow viewer; the snapshot replaces its screen.
    Resync(Vec<u8>),
    Taken,
    Ended,
}

/// The viewer's end of its deliveries from the terminal's thread.
pub(super) struct Deliveries {
    chunks: delivery::UnboundedReceiver<Chunk>,
    shared: Arc<Shared>,
    /// Output from an earlier epoch was sent before the snapshot the viewer
    /// last started over from, which already shows it.
    epoch: u64,
    resync: Option<oneshot::Receiver<(u64, Vec<u8>)>>,
}

impl Deliveries {
    /// Waits for the viewer's next delivery. Dropping the future loses nothing.
    pub(super) async fn next(&mut self, session: &Session, viewer: u64) -> Delivery {
        loop {
            if let Some(closed) = self.shared.closed() {
                return closed;
            }
            if let Some(resync) = &mut self.resync {
                let answer = resync.await;
                self.resync = None;
                if let Ok((epoch, snapshot)) = answer {
                    self.epoch = epoch;
                    return Delivery::Resync(snapshot);
                }
                // A viewer that lost the terminal gets no snapshot; its close
                // shows next.
                continue;
            }
            if self.shared.overflowed.load(Ordering::Acquire) {
                let (reply, answer) = oneshot::channel();
                session.send(Request::Resync { viewer, reply });
                self.resync = Some(answer);
                continue;
            }
            match self.chunks.recv().await {
                Some(Chunk::Output { epoch, bytes }) => {
                    let mut output = self.current(epoch, bytes);
                    while let Ok(chunk) = self.chunks.try_recv() {
                        if let Chunk::Output { epoch, bytes } = chunk {
                            output.extend(self.current(epoch, bytes));
                        }
                    }
                    if let Some(closed) = self.shared.closed() {
                        return closed;
                    }
                    if !output.is_empty() {
                        return Delivery::Output(output);
                    }
                }
                Some(Chunk::Wake) => {}
                None => return self.shared.closed().unwrap_or(Delivery::Ended),
            }
        }
    }

    /// Counts `bytes` as delivered and keeps them unless an earlier snapshot
    /// already covers them.
    fn current(&self, epoch: u64, bytes: Vec<u8>) -> Vec<u8> {
        self.shared.pending.fetch_sub(bytes.len(), Ordering::AcqRel);
        if epoch == self.epoch {
            bytes
        } else {
            Vec::new()
        }
    }

    #[cfg(test)]
    pub(super) fn has_overflowed(&self) -> bool {
        self.shared.overflowed.load(Ordering::Acquire)
    }
}

/// Writes one viewer's input to the shell while the viewer is attached.
pub(super) struct Input {
    shell: Arc<ShellControl>,
    shared: Arc<Shared>,
}

impl Input {
    /// Writes some of `bytes` to the shell and returns how many were taken.
    /// Input is refused once the viewer is no longer attached.
    pub(super) async fn write(&self, bytes: &[u8]) -> io::Result<usize> {
        if self.shared.closed().is_some() {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        self.shell.write(bytes).await
    }
}

/// The terminal thread's end of one viewer's deliveries.
struct Sink {
    chunks: delivery::UnboundedSender<Chunk>,
    shared: Arc<Shared>,
    epoch: u64,
}

enum Chunk {
    Output {
        epoch: u64,
        bytes: Vec<u8>,
    },
    /// Makes the viewer look at the shared state again.
    Wake,
}

/// State the terminal's thread and the viewer's connection both read, kept
/// without a lock.
#[derive(Default)]
struct Shared {
    /// Output sent and not yet taken by the viewer.
    pending: AtomicUsize,
    overflowed: AtomicBool,
    /// [`OPEN`], or why the viewer was closed.
    closed: AtomicU8,
}

const OPEN: u8 = 0;

#[derive(Clone, Copy)]
enum Closed {
    Taken = 1,
    Ended = 2,
}

fn deliveries() -> (Sink, Deliveries) {
    let (chunks, received) = delivery::unbounded_channel();
    let shared = Arc::new(Shared::default());
    let sink = Sink {
        chunks,
        shared: shared.clone(),
        epoch: 0,
    };
    let deliveries = Deliveries {
        chunks: received,
        shared,
        epoch: 0,
        resync: None,
    };
    (sink, deliveries)
}

impl Sink {
    fn push(&self, bytes: &[u8]) {
        if self.shared.overflowed.load(Ordering::Acquire) {
            return;
        }
        if self.shared.pending.load(Ordering::Acquire) + bytes.len() > OUTBOX_LIMIT {
            self.shared.overflowed.store(true, Ordering::Release);
            let _ = self.chunks.send(Chunk::Wake);
            return;
        }
        self.shared.pending.fetch_add(bytes.len(), Ordering::AcqRel);
        let _ = self.chunks.send(Chunk::Output {
            epoch: self.epoch,
            bytes: bytes.to_vec(),
        });
    }

    /// Starts over after a snapshot that covers everything dropped. Returns
    /// the epoch of the output that follows.
    fn restart(&mut self) -> u64 {
        self.epoch += 1;
        self.shared.overflowed.store(false, Ordering::Release);
        self.epoch
    }

    fn close(&self, closed: Closed) {
        let _ = self.shared.closed.compare_exchange(
            OPEN,
            closed as u8,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        let _ = self.chunks.send(Chunk::Wake);
    }
}

impl Shared {
    fn closed(&self) -> Option<Delivery> {
        match self.closed.load(Ordering::Acquire) {
            OPEN => None,
            closed if closed == Closed::Taken as u8 => Some(Delivery::Taken),
            _ => Some(Delivery::Ended),
        }
    }
}
