//! The bridge to Grok's leader, and the control graph that keeps it up.
//!
//! Grok's own harness is a leader process that owns every session and a
//! stdio bridge (`grok agent --leader ... stdio`) through which a client
//! speaks JSON-RPC to it. Caffold runs one bridge per backend and multiplexes
//! every Task's session over it; the leader outlives the bridge, so a bridge
//! that dies costs an observation gap and nothing the agent was doing.
//!
//! One control graph owns the bridge: `Down`, `Starting`, `Ready`,
//! `Reconnecting`, `Stopping`. Every node change goes through
//! [`Transport::transition`], every completion carries the generation of the
//! bridge it came from, and a completion from an earlier generation is
//! refused. Sessions, pending approvals, and the catalog are the driver's,
//! not the graph's: the graph says only whether there is a bridge to talk to.

use std::{
    collections::HashMap,
    mem,
    path::{Path, PathBuf},
    pin::Pin,
    process::Stdio,
    sync::{
        Arc, Mutex as StdMutex, OnceLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::Value;
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    process::Command,
    sync::{Mutex as AsyncMutex, Notify, broadcast, oneshot},
    time::{Instant, sleep, timeout},
};

use super::{
    GrokError,
    protocol::{self, Frame, InitializeResult, RpcError},
};

/// How long the leader may take to answer an ordinary question.
pub(super) const ANSWER_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a fresh bridge may take to say hello, leader start included.
const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a leader Caffold just started may take to open its socket.
const LEADER_SOCKET_TIMEOUT: Duration = Duration::from_secs(30);
const RECONNECT_BACKOFF: [Duration; 3] = [
    Duration::from_secs(1),
    Duration::from_secs(3),
    Duration::from_secs(10),
];

/// The file name Caffold gives its leader's socket. Named `leader-*.sock`
/// so that `grok leader list` can still find it.
pub(super) const LEADER_SOCKET_FILE_NAME: &str = "leader-caffold.sock";

/// Something the bridge delivered that was not an answer to a question.
#[derive(Debug, Clone)]
pub(super) enum Incoming {
    Notification {
        generation: u64,
        method: String,
        params: Value,
    },
    /// The leader asks and waits; answer through [`Transport::respond`].
    ServerRequest {
        generation: u64,
        id: Value,
        method: String,
        params: Value,
    },
    /// The bridge of this generation is gone. Whatever it was asked and had
    /// not answered is lost; the leader, and the sessions, are not.
    BridgeLost { generation: u64 },
}

#[derive(Clone)]
pub(super) struct Transport {
    inner: Arc<Inner>,
}

struct Inner {
    launcher: Launcher,
    state: AsyncMutex<State>,
    /// Woken on every node change, so a caller waiting for `Ready` can look
    /// again.
    changed: Notify,
    incoming: broadcast::Sender<Incoming>,
    generations: AtomicU64,
}

enum Launcher {
    Grok {
        executable: PathBuf,
        leader_socket: PathBuf,
    },
    #[cfg(test)]
    Mock(mock::MockLauncher),
}

/// The control graph's nodes.
enum State {
    Down,
    Starting { generation: u64 },
    Ready(Arc<Bridge>),
    Reconnecting { attempt: usize },
    Stopping,
}

impl State {
    fn name(&self) -> &'static str {
        match self {
            Self::Down => "down",
            Self::Starting { .. } => "starting",
            Self::Ready(_) => "ready",
            Self::Reconnecting { .. } => "reconnecting",
            Self::Stopping => "stopping",
        }
    }
}

/// One bridge process and the questions it has not answered yet.
pub(super) struct Bridge {
    pub(super) generation: u64,
    /// What the leader said about itself, once it has.
    hello: OnceLock<InitializeResult>,
    writer: AsyncMutex<Pin<Box<dyn AsyncWrite + Send>>>,
    pending: StdMutex<HashMap<u64, oneshot::Sender<Result<Value, RpcError>>>>,
    next_id: AtomicU64,
    /// Held so the process ends with the bridge. `None` for a stand-in.
    _child: Option<tokio::process::Child>,
}

impl Transport {
    /// The bridge to the leader Caffold names, started when first needed.
    pub(super) fn grok(executable: PathBuf, leader_socket: PathBuf) -> Self {
        Self::with_launcher(Launcher::Grok {
            executable,
            leader_socket,
        })
    }

    fn with_launcher(launcher: Launcher) -> Self {
        let (incoming, _) = broadcast::channel(2048);
        Self {
            inner: Arc::new(Inner {
                launcher,
                state: AsyncMutex::new(State::Down),
                changed: Notify::new(),
                incoming,
                generations: AtomicU64::new(0),
            }),
        }
    }

    pub(super) fn subscribe(&self) -> broadcast::Receiver<Incoming> {
        self.inner.incoming.subscribe()
    }

    /// The bridge, started if it is not up. What every question goes through.
    pub(super) async fn bridge(&self) -> Result<Arc<Bridge>, GrokError> {
        loop {
            let generation = {
                let mut state = self.inner.state.lock().await;
                match &*state {
                    State::Ready(bridge) => return Ok(bridge.clone()),
                    State::Stopping => {
                        return Err(GrokError::Unreachable(
                            "the Grok bridge is shutting down".to_string(),
                        ));
                    }
                    State::Starting { .. } => None,
                    State::Down | State::Reconnecting { .. } => {
                        let generation = self.inner.generations.fetch_add(1, Ordering::Relaxed) + 1;
                        transition(
                            &mut state,
                            State::Starting { generation },
                            &self.inner.changed,
                        );
                        Some(generation)
                    }
                }
            };
            match generation {
                Some(generation) => {
                    let started = self.start_bridge(generation).await;
                    let mut state = self.inner.state.lock().await;
                    if !matches!(&*state, State::Starting { generation: current } if *current == generation)
                    {
                        // Somebody else moved the graph while this bridge was
                        // starting; what was started is not the bridge in hand.
                        return Err(GrokError::Unreachable(
                            "the Grok bridge was replaced while starting".to_string(),
                        ));
                    }
                    match started {
                        Ok(bridge) => {
                            transition(
                                &mut state,
                                State::Ready(bridge.clone()),
                                &self.inner.changed,
                            );
                            return Ok(bridge);
                        }
                        Err(error) => {
                            transition(&mut state, State::Down, &self.inner.changed);
                            return Err(error);
                        }
                    }
                }
                None => self.inner.changed.notified().await,
            }
        }
    }

    /// Ask the leader, and wait for its answer.
    pub(super) async fn call(&self, method: &str, params: Value) -> Result<Value, GrokError> {
        self.bridge()
            .await?
            .call(method, params, Some(ANSWER_TIMEOUT))
            .await
    }

    /// Ask the leader something that takes as long as it takes.
    pub(super) async fn call_unbounded(
        &self,
        method: &str,
        params: Value,
    ) -> Result<Value, GrokError> {
        self.bridge().await?.call(method, params, None).await
    }

    pub(super) async fn notify(&self, method: &str, params: Value) -> Result<(), GrokError> {
        self.bridge()
            .await?
            .write(protocol::notification(method, params))
            .await
    }

    /// Answer something the leader asked, on the bridge it asked it on.
    ///
    /// A bridge that has since been replaced no longer has the question, and
    /// an answer written to its successor would be an answer to nothing.
    pub(super) async fn respond(
        &self,
        generation: u64,
        id: &Value,
        result: Value,
    ) -> Result<(), GrokError> {
        let bridge = {
            let state = self.inner.state.lock().await;
            match &*state {
                State::Ready(bridge) if bridge.generation == generation => bridge.clone(),
                _ => {
                    return Err(GrokError::Unreachable(format!(
                        "the Grok bridge that asked (generation {generation}) is gone"
                    )));
                }
            }
        };
        bridge.write(protocol::response(id, result)).await
    }

    /// Refuse something the leader asked that Caffold does not implement.
    pub(super) async fn refuse(
        &self,
        generation: u64,
        id: &Value,
        message: &str,
    ) -> Result<(), GrokError> {
        let bridge = {
            let state = self.inner.state.lock().await;
            match &*state {
                State::Ready(bridge) if bridge.generation == generation => bridge.clone(),
                _ => return Ok(()),
            }
        };
        bridge
            .write(protocol::error_response(id, -32601, message))
            .await
    }

    /// The bridge generation in hand, when there is one.
    pub(super) async fn generation(&self) -> Option<u64> {
        match &*self.inner.state.lock().await {
            State::Ready(bridge) => Some(bridge.generation),
            _ => None,
        }
    }

    /// The control graph's node, by name.
    pub(super) async fn node_name(&self) -> &'static str {
        self.inner.state.lock().await.name()
    }

    /// The executable that runs the leader and where its socket is. A mock
    /// has neither.
    pub(super) fn launcher_paths(&self) -> Option<(&Path, &Path)> {
        match &self.inner.launcher {
            Launcher::Grok {
                executable,
                leader_socket,
            } => Some((executable.as_path(), leader_socket.as_path())),
            #[cfg(test)]
            Launcher::Mock(_) => None,
        }
    }

    /// Put the bridge down for good. The leader is left running: it is
    /// Grok's process, and the next Caffold attaches to it again.
    pub(super) async fn stop(&self) {
        let mut state = self.inner.state.lock().await;
        transition(&mut state, State::Stopping, &self.inner.changed);
    }

    async fn start_bridge(&self, generation: u64) -> Result<Arc<Bridge>, GrokError> {
        let (reader, writer, child) = match &self.inner.launcher {
            Launcher::Grok {
                executable,
                leader_socket,
            } => {
                ensure_leader(executable, leader_socket).await?;
                spawn_bridge(executable, leader_socket).await?
            }
            #[cfg(test)]
            Launcher::Mock(launcher) => launcher.spawn(generation),
        };
        let bridge = Arc::new(Bridge {
            generation,
            hello: OnceLock::new(),
            writer: AsyncMutex::new(writer),
            pending: StdMutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            _child: child,
        });
        self.spawn_reader(bridge.clone(), reader);
        let hello = bridge
            .call(
                "initialize",
                protocol::initialize_params(),
                Some(INITIALIZE_TIMEOUT),
            )
            .await?;
        let hello: InitializeResult = serde_json::from_value(hello).map_err(|error| {
            GrokError::Protocol(format!(
                "initialize answered with a shape this release cannot read: {error}"
            ))
        })?;
        let _ = bridge.hello.set(hello);
        Ok(bridge)
    }

    fn spawn_reader(&self, bridge: Arc<Bridge>, reader: Pin<Box<dyn AsyncRead + Send>>) {
        let transport = self.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(reader).lines();
            loop {
                let line = match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) | Err(_) => break,
                };
                let Some(frame) = protocol::read_frame(&line) else {
                    continue;
                };
                match frame {
                    Frame::Response { id, result } => {
                        let sender = bridge
                            .pending
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .remove(&id);
                        if let Some(sender) = sender {
                            let _ = sender.send(result);
                        }
                    }
                    Frame::Notification { method, params } => {
                        let _ = transport.inner.incoming.send(Incoming::Notification {
                            generation: bridge.generation,
                            method,
                            params,
                        });
                    }
                    Frame::ServerRequest { id, method, params } => {
                        let _ = transport.inner.incoming.send(Incoming::ServerRequest {
                            generation: bridge.generation,
                            id,
                            method,
                            params,
                        });
                    }
                }
            }
            // Whatever this bridge was asked and had not answered is lost
            // with it; dropping the senders says so to every waiter.
            drop(mem::take(
                &mut *bridge.pending.lock().unwrap_or_else(|p| p.into_inner()),
            ));
            transport.bridge_exited(bridge.generation).await;
        });
    }

    /// The bridge's stdout closed: the process is gone or going.
    async fn bridge_exited(&self, generation: u64) {
        let reconnect = {
            let mut state = self.inner.state.lock().await;
            match &*state {
                State::Ready(bridge) if bridge.generation == generation => {
                    transition(
                        &mut state,
                        State::Reconnecting { attempt: 1 },
                        &self.inner.changed,
                    );
                    Some(1)
                }
                // A bridge that dies while starting fails the start itself;
                // one from an earlier generation is already accounted for.
                _ => None,
            }
        };
        let _ = self
            .inner
            .incoming
            .send(Incoming::BridgeLost { generation });
        if let Some(attempt) = reconnect {
            self.reconnect_later(attempt);
        }
    }

    fn reconnect_later(&self, attempt: usize) {
        let transport = self.clone();
        tokio::spawn(async move {
            sleep(RECONNECT_BACKOFF[attempt - 1]).await;
            {
                let state = transport.inner.state.lock().await;
                // Somebody asked meanwhile and the bridge is up or starting,
                // or the transport is stopping: nothing to do.
                if !matches!(&*state, State::Reconnecting { attempt: current } if *current == attempt)
                {
                    return;
                }
            }
            if transport.bridge().await.is_ok() {
                return;
            }
            let mut state = transport.inner.state.lock().await;
            // Out of retries, the graph rests at Down and the next question
            // starts the bridge again.
            if matches!(&*state, State::Down) && attempt < RECONNECT_BACKOFF.len() {
                transition(
                    &mut state,
                    State::Reconnecting {
                        attempt: attempt + 1,
                    },
                    &transport.inner.changed,
                );
                drop(state);
                transport.reconnect_later(attempt + 1);
            }
        });
    }
}

/// The one place a node changes.
fn transition(state: &mut State, next: State, changed: &Notify) {
    let allowed = matches!(
        (&*state, &next),
        (State::Down, State::Starting { .. })
            | (State::Reconnecting { .. }, State::Starting { .. })
            | (State::Starting { .. }, State::Ready(_))
            | (State::Starting { .. }, State::Down)
            | (State::Ready(_), State::Reconnecting { .. })
            | (State::Reconnecting { .. }, State::Reconnecting { .. })
            | (State::Down, State::Reconnecting { .. })
            | (
                State::Down | State::Starting { .. } | State::Ready(_) | State::Reconnecting { .. },
                State::Stopping
            )
    );
    if !allowed {
        eprintln!(
            "Grok bridge refused a control transition from {} to {}",
            state.name(),
            next.name()
        );
        return;
    }
    *state = next;
    changed.notify_waiters();
}

impl Bridge {
    /// What the leader said about itself when this bridge said hello.
    pub(super) fn hello(&self) -> &InitializeResult {
        self.hello
            .get()
            .expect("a bridge is handed out only after its hello")
    }

    async fn write(&self, frame: Value) -> Result<(), GrokError> {
        let mut writer = self.writer.lock().await;
        let mut line = frame.to_string();
        line.push('\n');
        writer.write_all(line.as_bytes()).await.map_err(|error| {
            GrokError::Unreachable(format!("the Grok bridge stopped taking input: {error}"))
        })?;
        writer.flush().await.map_err(|error| {
            GrokError::Unreachable(format!("the Grok bridge stopped taking input: {error}"))
        })
    }

    pub(super) async fn call(
        &self,
        method: &str,
        params: Value,
        limit: Option<Duration>,
    ) -> Result<Value, GrokError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(id, sender);
        if let Err(error) = self.write(protocol::request(id, method, params)).await {
            self.pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&id);
            return Err(error);
        }
        let answered = match limit {
            Some(limit) => match timeout(limit, receiver).await {
                Ok(answered) => answered,
                Err(_) => {
                    self.pending
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .remove(&id);
                    return Err(GrokError::TimedOut(format!(
                        "Grok did not answer {method} within {} seconds",
                        limit.as_secs()
                    )));
                }
            },
            None => receiver.await,
        };
        match answered {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(GrokError::from_rpc(method, error)),
            Err(_) => Err(GrokError::Unreachable(format!(
                "the Grok bridge went away before answering {method}"
            ))),
        }
    }
}

type Pipes = (
    Pin<Box<dyn AsyncRead + Send>>,
    Pin<Box<dyn AsyncWrite + Send>>,
    Option<tokio::process::Child>,
);

/// Start Caffold's leader unless one already answers on the socket.
async fn ensure_leader(executable: &Path, leader_socket: &Path) -> Result<(), GrokError> {
    match socket_state(leader_socket).await {
        SocketState::Listening => return Ok(()),
        SocketState::Missing => {}
        SocketState::Refused => {
            // A socket file nobody answers on is what a leader that died
            // leaves behind; a new leader cannot bind while it is there.
            let _ = fs::remove_file(leader_socket).await;
        }
    }
    if let Some(parent) = leader_socket.parent() {
        fs::create_dir_all(parent).await.map_err(|error| {
            GrokError::Unreachable(format!("cannot create {}: {error}", parent.display()))
        })?;
    }
    let mut command = Command::new(executable);
    command
        .arg("agent")
        .arg("leader")
        .arg("--leader-socket")
        .arg(leader_socket)
        .arg("--no-exit-on-disconnect")
        .arg("--relay-on-demand")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    // In a process group of its own, so that a signal to Caffold's group —
    // a terminal's Ctrl-C, a test runner ending a process tree — does not
    // take the leader and every session it holds down with it.
    command.process_group(0);
    let leader = command.spawn().map_err(|error| {
        GrokError::Unreachable(format!(
            "cannot start the Grok leader with {}: {error}",
            executable.display()
        ))
    })?;
    // The leader is Grok's process from here on; it is neither waited for
    // nor ended when Caffold stops.
    mem::forget(leader);
    let deadline = Instant::now() + LEADER_SOCKET_TIMEOUT;
    loop {
        if let SocketState::Listening = socket_state(leader_socket).await {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(GrokError::TimedOut(format!(
                "the Grok leader did not open {} within {} seconds",
                leader_socket.display(),
                LEADER_SOCKET_TIMEOUT.as_secs()
            )));
        }
        sleep(Duration::from_millis(100)).await;
    }
}

pub(super) enum SocketState {
    Missing,
    Refused,
    Listening,
}

pub(super) async fn socket_state(path: &Path) -> SocketState {
    if !fs::try_exists(path).await.unwrap_or(false) {
        return SocketState::Missing;
    }
    match tokio::net::UnixStream::connect(path).await {
        Ok(stream) => {
            drop(stream);
            SocketState::Listening
        }
        Err(_) => SocketState::Refused,
    }
}

async fn spawn_bridge(executable: &Path, leader_socket: &Path) -> Result<Pipes, GrokError> {
    let mut command = Command::new(executable);
    command
        .arg("agent")
        .arg("--leader")
        .arg("--leader-socket")
        .arg(leader_socket)
        .arg("stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        GrokError::Unreachable(format!(
            "cannot start the Grok bridge with {}: {error}",
            executable.display()
        ))
    })?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| GrokError::Protocol("the Grok bridge has no stdin".to_string()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| GrokError::Protocol("the Grok bridge has no stdout".to_string()))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("grok bridge: {line}");
            }
        });
    }
    Ok((Box::pin(stdout), Box::pin(stdin), Some(child)))
}

impl GrokError {
    fn from_rpc(method: &str, error: RpcError) -> Self {
        if error.is_path_not_found() {
            return GrokError::ConversationGone(format!("{method}: {error}"));
        }
        GrokError::Agent(format!("{method}: {error}"))
    }
}

#[cfg(test)]
pub(crate) mod mock {
    //! A stand-in leader for tests: every bridge the transport spawns is a
    //! pair of in-memory pipes the test speaks the leader's side of.

    use super::*;
    use serde_json::json;
    use tokio::io::{DuplexStream, ReadHalf, WriteHalf};
    use tokio::sync::mpsc;

    /// How long a test waits for the driver to say something; a wait that
    /// never ends would hang the suite instead of failing it.
    const WAIT_FOR: Duration = Duration::from_secs(10);

    pub(crate) struct MockLauncher {
        bridges: mpsc::UnboundedSender<MockBridge>,
    }

    /// The leader's side of one spawned bridge.
    pub(crate) struct MockBridge {
        pub(crate) generation: u64,
        /// Lines the bridge writes, one frame each.
        pub(crate) from_bridge: tokio::io::Lines<BufReader<ReadHalf<DuplexStream>>>,
        pub(crate) to_bridge: WriteHalf<DuplexStream>,
    }

    impl MockBridge {
        pub(crate) async fn next_frame(&mut self) -> Option<Value> {
            let line = self.from_bridge.next_line().await.ok().flatten()?;
            serde_json::from_str(&line).ok()
        }

        pub(crate) async fn send(&mut self, frame: Value) {
            let mut line = frame.to_string();
            line.push('\n');
            self.to_bridge
                .write_all(line.as_bytes())
                .await
                .expect("the bridge reads");
        }
    }

    impl MockLauncher {
        pub(crate) fn spawn(&self, generation: u64) -> Pipes {
            let (ours, theirs) = tokio::io::duplex(1 << 20);
            let (bridge_reads, bridge_writes) = tokio::io::split(theirs);
            let (we_read, we_write) = tokio::io::split(ours);
            let _ = self.bridges.send(MockBridge {
                generation,
                from_bridge: BufReader::new(we_read).lines(),
                to_bridge: we_write,
            });
            (Box::pin(bridge_reads), Box::pin(bridge_writes), None)
        }
    }

    impl Transport {
        /// A transport whose bridges a test plays the leader for.
        pub(crate) fn mock() -> (Self, mpsc::UnboundedReceiver<MockBridge>) {
            let (bridges, spawned) = mpsc::unbounded_channel();
            (
                Self::with_launcher(Launcher::Mock(MockLauncher { bridges })),
                spawned,
            )
        }
    }

    /// What a scripted leader says to one question.
    pub(crate) enum MockAnswer {
        Result(Value),
        Error(i64, &'static str),
        /// Say nothing yet; the test answers through [`MockLeader::answer`].
        Hold,
    }

    type Script = Arc<dyn Fn(&str, &Value) -> MockAnswer + Send + Sync>;

    /// A leader played by a script: it answers every bridge the transport
    /// spawns, remembers what it was asked, and lets the test speak first.
    #[derive(Clone)]
    pub(crate) struct MockLeader {
        inner: Arc<MockLeaderInner>,
    }

    struct MockLeaderInner {
        script: Script,
        /// Every request any bridge sent: (generation, method, params).
        requests: StdMutex<Vec<(u64, String, Value)>>,
        /// Questions the script held, by method: (generation, method, id).
        held: StdMutex<Vec<(u64, String, Value)>>,
        /// Notifications and answers any bridge sent.
        notifications: StdMutex<Vec<(String, Value)>>,
        /// Where to write frames to the newest bridge.
        outbound: StdMutex<Option<(u64, mpsc::UnboundedSender<Value>)>>,
        changed: Notify,
    }

    impl MockLeader {
        pub(crate) fn start(
            mut bridges: mpsc::UnboundedReceiver<MockBridge>,
            script: impl Fn(&str, &Value) -> MockAnswer + Send + Sync + 'static,
        ) -> Self {
            let leader = Self {
                inner: Arc::new(MockLeaderInner {
                    script: Arc::new(script),
                    requests: StdMutex::new(Vec::new()),
                    held: StdMutex::new(Vec::new()),
                    notifications: StdMutex::new(Vec::new()),
                    outbound: StdMutex::new(None),
                    changed: Notify::new(),
                }),
            };
            let serving = leader.clone();
            tokio::spawn(async move {
                while let Some(bridge) = bridges.recv().await {
                    serving.serve(bridge);
                }
            });
            leader
        }

        fn serve(&self, mut bridge: MockBridge) {
            let generation = bridge.generation;
            let (outbound, mut to_send) = mpsc::unbounded_channel::<Value>();
            *self.inner.outbound.lock().unwrap() = Some((generation, outbound));
            self.inner.changed.notify_waiters();
            let leader = self.clone();
            tokio::spawn(async move {
                loop {
                    tokio::select! {
                        line = bridge.from_bridge.next_line() => {
                            let Ok(Some(line)) = line else { break };
                            let Ok(frame) = serde_json::from_str::<Value>(&line) else { continue };
                            let method = frame.get("method").and_then(Value::as_str).map(str::to_string);
                            let params = frame.get("params").cloned().unwrap_or(Value::Null);
                            match (method, frame.get("id").cloned()) {
                                (Some(method), Some(id)) => {
                                    leader.inner.requests.lock().unwrap().push((generation, method.clone(), params.clone()));
                                    leader.inner.changed.notify_waiters();
                                    let reply = match (leader.inner.script)(&method, &params) {
                                        MockAnswer::Result(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                                        MockAnswer::Error(code, message) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }),
                                        MockAnswer::Hold => {
                                            leader.inner.held.lock().unwrap().push((generation, method, id));
                                            leader.inner.changed.notify_waiters();
                                            continue;
                                        }
                                    };
                                    let mut text = reply.to_string();
                                    text.push('\n');
                                    if bridge.to_bridge.write_all(text.as_bytes()).await.is_err() { break; }
                                }
                                (Some(method), None) => {
                                    leader.inner.notifications.lock().unwrap().push((method, params));
                                    leader.inner.changed.notify_waiters();
                                }
                                (None, Some(_)) => {
                                    leader.inner.notifications.lock().unwrap().push(("<response>".to_string(), frame));
                                    leader.inner.changed.notify_waiters();
                                }
                                (None, None) => {}
                            }
                        }
                        frame = to_send.recv() => {
                            let Some(frame) = frame else { break };
                            let mut text = frame.to_string();
                            text.push('\n');
                            if bridge.to_bridge.write_all(text.as_bytes()).await.is_err() { break; }
                        }
                    }
                }
            });
        }

        /// Speak to the newest bridge.
        pub(crate) async fn send(&self, frame: Value) {
            let sender = loop {
                if let Some((_, sender)) = self.inner.outbound.lock().unwrap().clone() {
                    break sender;
                }
                self.inner.changed.notified().await;
            };
            sender.send(frame).expect("the bridge is being served");
        }

        pub(crate) async fn notify(&self, method: &str, params: Value) {
            self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
                .await;
        }

        pub(crate) async fn ask(&self, id: u64, method: &str, params: Value) {
            self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
                .await;
        }

        /// Answer the oldest held question of `method`.
        pub(crate) async fn answer(&self, method: &str, result: Value) {
            let id = self.take_held(method).await;
            self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                .await;
        }

        /// Answer the oldest held question of `method` with an error.
        pub(crate) async fn refuse(&self, method: &str, code: i64, message: &str) {
            let id = self.take_held(method).await;
            self.send(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }))
                .await;
        }

        /// The id of the oldest held question of `method`, once there is one.
        async fn take_held(&self, method: &str) -> Value {
            loop {
                let found = {
                    let mut held = self.inner.held.lock().unwrap();
                    held.iter()
                        .position(|(_, held_method, _)| held_method == method)
                        .map(|index| held.remove(index))
                };
                if let Some((_, _, id)) = found {
                    return id;
                }
                self.inner.changed.notified().await;
            }
        }

        /// Wait until a request of `method` has been received, and return
        /// the parameters of the most recent one.
        pub(crate) async fn wait_for(&self, method: &str) -> Value {
            let asked = async {
                loop {
                    let found = self
                        .inner
                        .requests
                        .lock()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|(_, requested, _)| requested == method)
                        .map(|(_, _, params)| params.clone());
                    if let Some(params) = found {
                        return params;
                    }
                    self.inner.changed.notified().await;
                }
            };
            timeout(WAIT_FOR, asked)
                .await
                .unwrap_or_else(|_| panic!("the leader was not asked {method} in time"))
        }

        /// Wait until a notification, or an answer to something this leader
        /// asked, has been received.
        pub(crate) async fn wait_for_notification(&self, method: &str) -> Value {
            let sent = async {
                loop {
                    let found = self
                        .inner
                        .notifications
                        .lock()
                        .unwrap()
                        .iter()
                        .rev()
                        .find(|(sent, _)| sent == method)
                        .map(|(_, params)| params.clone());
                    if let Some(params) = found {
                        return params;
                    }
                    self.inner.changed.notified().await;
                }
            };
            timeout(WAIT_FOR, sent)
                .await
                .unwrap_or_else(|_| panic!("the leader was not sent {method} in time"))
        }

        pub(crate) fn requests(&self, method: &str) -> Vec<Value> {
            self.inner
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, requested, _)| requested == method)
                .map(|(_, _, params)| params.clone())
                .collect()
        }

        /// Cut the newest bridge off, as a bridge process dying would.
        pub(crate) fn drop_bridge(&self) {
            *self.inner.outbound.lock().unwrap() = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Play a leader that answers `initialize` with the recorded hello.
    async fn greet(
        bridges: &mut tokio::sync::mpsc::UnboundedReceiver<mock::MockBridge>,
    ) -> mock::MockBridge {
        let mut bridge = bridges.recv().await.expect("a bridge was spawned");
        let hello = bridge.next_frame().await.expect("initialize");
        assert_eq!(hello["method"], "initialize");
        bridge
            .send(json!({ "jsonrpc": "2.0", "id": hello["id"], "result": { "protocolVersion": 1, "_meta": { "agentVersion": "1.0.30" } } }))
            .await;
        bridge
    }

    #[tokio::test]
    async fn a_question_starts_the_bridge_and_is_answered_on_it() {
        let (transport, mut bridges) = Transport::mock();
        let asking = tokio::spawn({
            let transport = transport.clone();
            async move { transport.call("_x.ai/models/list", json!({})).await }
        });
        let mut bridge = greet(&mut bridges).await;
        let question = bridge.next_frame().await.expect("the question");
        assert_eq!(question["method"], "_x.ai/models/list");
        bridge
            .send(json!({ "jsonrpc": "2.0", "id": question["id"], "result": { "result": { "availableModels": [] } } }))
            .await;
        let answer = asking.await.unwrap().expect("answered");
        assert_eq!(answer["result"]["availableModels"], json!([]));
        assert_eq!(transport.node_name().await, "ready");
        assert_eq!(transport.generation().await, Some(1));
    }

    #[tokio::test]
    async fn an_error_answer_is_the_agents_refusal_and_a_missing_path_is_a_gone_conversation() {
        let (transport, mut bridges) = Transport::mock();
        let asking = tokio::spawn({
            let transport = transport.clone();
            async move { transport.call("session/load", json!({})).await }
        });
        let mut bridge = greet(&mut bridges).await;
        let question = bridge.next_frame().await.unwrap();
        bridge
            .send(json!({ "jsonrpc": "2.0", "id": question["id"], "error": { "code": -32603, "message": "Path not found.", "data": { "code": "FS_NOT_FOUND" } } }))
            .await;
        assert!(matches!(
            asking.await.unwrap(),
            Err(GrokError::ConversationGone(_))
        ));
    }

    #[tokio::test]
    async fn notifications_and_server_requests_reach_subscribers_with_the_bridge_generation() {
        let (transport, mut bridges) = Transport::mock();
        let mut incoming = transport.subscribe();
        let ready = tokio::spawn({
            let transport = transport.clone();
            async move { transport.bridge().await.map(|_| ()) }
        });
        let mut bridge = greet(&mut bridges).await;
        ready.await.unwrap().expect("ready");
        bridge.send(json!({ "jsonrpc": "2.0", "method": "_x.ai/queue/changed", "params": { "sessionId": "s" } })).await;
        bridge.send(json!({ "jsonrpc": "2.0", "id": 0, "method": "session/request_permission", "params": { "sessionId": "s" } })).await;
        let first = incoming.recv().await.unwrap();
        assert!(
            matches!(first, Incoming::Notification { generation: 1, ref method, .. } if method == "_x.ai/queue/changed")
        );
        let second = incoming.recv().await.unwrap();
        let Incoming::ServerRequest {
            generation,
            id,
            method,
            ..
        } = second
        else {
            panic!("a server request");
        };
        assert_eq!(
            (generation, method.as_str()),
            (1, "session/request_permission")
        );
        transport
            .respond(
                generation,
                &id,
                json!({ "outcome": { "outcome": "cancelled" } }),
            )
            .await
            .expect("answered");
        let reply = bridge.next_frame().await.unwrap();
        assert_eq!(reply["id"], 0);
        assert_eq!(reply["result"]["outcome"]["outcome"], "cancelled");
        // An answer for a bridge that is not the one in hand is refused.
        assert!(transport.respond(7, &id, json!({})).await.is_err());
    }

    #[tokio::test]
    async fn a_bridge_that_dies_fails_its_questions_and_a_new_one_answers_the_next() {
        let (transport, mut bridges) = Transport::mock();
        let mut incoming = transport.subscribe();
        let hanging = tokio::spawn({
            let transport = transport.clone();
            async move { transport.call("session/prompt", json!({})).await }
        });
        let bridge = greet(&mut bridges).await;
        let mut bridge = bridge;
        let _question = bridge.next_frame().await.unwrap();
        drop(bridge);
        assert!(matches!(
            hanging.await.unwrap(),
            Err(GrokError::Unreachable(_))
        ));
        assert!(matches!(
            incoming.recv().await.unwrap(),
            Incoming::BridgeLost { generation: 1 }
        ));
        assert_eq!(transport.node_name().await, "reconnecting");
        // A question asked meanwhile starts the next bridge at once.
        let asking = tokio::spawn({
            let transport = transport.clone();
            async move { transport.call("_x.ai/models/list", json!({})).await }
        });
        let mut second = greet(&mut bridges).await;
        assert_eq!(second.generation, 2);
        let question = second.next_frame().await.unwrap();
        second
            .send(json!({ "jsonrpc": "2.0", "id": question["id"], "result": {} }))
            .await;
        asking
            .await
            .unwrap()
            .expect("answered on the second bridge");
        assert_eq!(transport.generation().await, Some(2));
    }

    #[tokio::test]
    async fn a_bridge_that_never_says_hello_leaves_the_graph_down() {
        let (transport, mut bridges) = Transport::mock();
        let asking = tokio::spawn({
            let transport = transport.clone();
            async move { transport.call("_x.ai/models/list", json!({})).await }
        });
        let bridge = bridges.recv().await.unwrap();
        drop(bridge);
        assert!(matches!(
            asking.await.unwrap(),
            Err(GrokError::Unreachable(_))
        ));
        assert_eq!(transport.node_name().await, "down");
    }

    #[tokio::test]
    async fn stopping_refuses_every_later_question() {
        let (transport, _bridges) = Transport::mock();
        transport.stop().await;
        assert!(matches!(
            transport.call("x", json!({})).await,
            Err(GrokError::Unreachable(_))
        ));
    }
}
