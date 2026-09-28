//! Shell terminals for Tasks and Sections.
//!
//! The backend runs one login shell per Task or Section on a PTY and keeps
//! its screen, so a browser can leave a terminal and come back to it while the
//! backend runs. The browser opens and kills a terminal over HTTP and
//! exchanges its input and output over a WebSocket while a terminal screen is
//! showing. Task lifecycle code closes a Task's terminal through
//! [`TaskTerminals`].

mod registry;
mod shell;
mod snapshot;

use std::{str::FromStr, sync::Arc};

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode, header, uri::Authority},
    response::Response,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use url::Url;

use super::error::ApiError;
use crate::fs::RootedFs;
use registry::{Attach, Delivery, Registry};
use shell::ShellCommand;

const MIN_COLUMNS: u16 = 2;
const MAX_COLUMNS: u16 = 1_000;
const MAX_ROWS: u16 = 500;
const MAX_TAB_LENGTH: usize = 64;

/// The backend's terminals and their routes.
#[derive(Clone)]
pub(super) struct Terminals {
    registry: Arc<Registry>,
}

impl Terminals {
    pub(super) fn new() -> Self {
        Self {
            registry: Registry::new(ShellCommand::login()),
        }
    }

    pub(super) fn router(&self, fs: Arc<RootedFs>) -> Router {
        Router::new()
            .route(
                "/api/terminal",
                post(open_terminal)
                    .delete(kill_terminal)
                    .layer(DefaultBodyLimit::max(4_096)),
            )
            .route("/api/terminal/socket", get(terminal_socket))
            .with_state(TerminalState {
                fs,
                registry: self.registry.clone(),
            })
    }

    pub(super) fn for_tasks(&self) -> TaskTerminals {
        TaskTerminals {
            registry: self.registry.clone(),
        }
    }

    /// Ends every terminal's shell before the backend exits.
    pub(super) async fn shutdown(&self) {
        let registry = self.registry.clone();
        let _ = tokio::task::spawn_blocking(move || registry.close_all()).await;
    }
}

/// The terminal operation Task lifecycle code needs.
#[derive(Clone)]
pub(super) struct TaskTerminals {
    registry: Arc<Registry>,
}

impl TaskTerminals {
    /// Closes the Task's terminal, if it has one.
    pub(super) fn close(&self, thread_id: &str) {
        self.registry.close(&Subject::Task(thread_id.to_string()));
    }
}

/// Task lifecycle tests open a Task's terminal to see what closes it.
#[cfg(test)]
impl TaskTerminals {
    pub(super) fn for_tests() -> Self {
        Self {
            registry: Registry::new(ShellCommand::new("/bin/sh", &[])),
        }
    }

    pub(super) fn open_for_test(&self, thread_id: &str, cwd: &std::path::Path) {
        let size = TerminalSize {
            columns: 80,
            rows: 24,
        };
        self.registry
            .open(Subject::Task(thread_id.to_string()), cwd, size)
            .unwrap();
    }

    pub(super) fn is_open(&self, thread_id: &str) -> bool {
        self.registry
            .contains(&Subject::Task(thread_id.to_string()))
    }
}

#[derive(Clone)]
struct TerminalState {
    fs: Arc<RootedFs>,
    registry: Arc<Registry>,
}

/// Opens the subject's terminal unless it has one.
async fn open_terminal(
    State(state): State<TerminalState>,
    headers: HeaderMap,
    Json(request): Json<OpenTerminalRequest>,
) -> Result<StatusCode, ApiError> {
    require_same_origin(&headers)?;
    let subject = Subject::from_request(request.task, request.section)?;
    let size = TerminalSize::from_request(request.cols, request.rows)?;
    let cwd = state.fs.absolute_directory_path(&request.cwd)?;
    // Starting a shell forks the backend, which is too slow for a runtime thread.
    tokio::task::spawn_blocking(move || state.registry.open(subject, &cwd, size))
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .map_err(|error| ApiError::Unavailable {
            code: "terminal_start_failed",
            message: format!("The terminal's shell could not start: {error}"),
        })?;
    Ok(StatusCode::NO_CONTENT)
}

async fn kill_terminal(
    State(state): State<TerminalState>,
    headers: HeaderMap,
    Query(query): Query<SubjectQuery>,
) -> Result<StatusCode, ApiError> {
    require_same_origin(&headers)?;
    state
        .registry
        .close(&Subject::from_request(query.task, query.section)?);
    Ok(StatusCode::NO_CONTENT)
}

/// Upgrades to the WebSocket that carries one terminal's input and output.
/// Browsers let any page open a WebSocket, so the handler checks the origin.
async fn terminal_socket(
    State(state): State<TerminalState>,
    headers: HeaderMap,
    Query(query): Query<SocketQuery>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    require_same_origin(&headers)?;
    let subject = Subject::from_request(query.task, query.section)?;
    let size = TerminalSize::from_request(query.cols, query.rows)?;
    let tab = tab_from_request(query.tab)?;
    let mode = query.mode;
    Ok(upgrade.on_upgrade(move |socket| relay(socket, state.registry, subject, mode, tab, size)))
}

/// Attaches the socket's viewer, sends the screen, then relays output to the
/// socket and input from it until the viewer is detached either way.
async fn relay(
    mut socket: WebSocket,
    registry: Arc<Registry>,
    subject: Subject,
    mode: AttachMode,
    tab: String,
    size: TerminalSize,
) {
    let attachment = match registry.attach(&subject, mode, &tab, size) {
        Attach::Attached {
            attachment,
            snapshot,
        } => {
            if announce(&mut socket, ServerMessage::Attached, snapshot)
                .await
                .is_err()
            {
                return;
            }
            attachment
        }
        Attach::Elsewhere => return finish(socket, ServerMessage::Elsewhere).await,
        Attach::Absent => return finish(socket, ServerMessage::Absent).await,
    };
    // Input read from the socket but not yet taken by the PTY.
    let mut input = Vec::new();
    loop {
        tokio::select! {
            biased;
            delivery = attachment.next() => {
                let sent = match delivery {
                    Delivery::Output(bytes) => socket.send(Message::Binary(bytes.into())).await,
                    Delivery::Resync(snapshot) => {
                        announce(&mut socket, ServerMessage::Resync, snapshot).await
                    }
                    Delivery::Taken => return finish(socket, ServerMessage::Taken).await,
                    Delivery::Ended => return finish(socket, ServerMessage::Ended).await,
                };
                if sent.is_err() {
                    return;
                }
            }
            written = attachment.write(&input), if !input.is_empty() => match written {
                Ok(length) => {
                    input.drain(..length);
                }
                // The viewer lost the terminal; the reason arrives as a delivery.
                Err(_) => input.clear(),
            },
            message = socket.recv(), if input.is_empty() => match message {
                Some(Ok(Message::Binary(bytes))) => input.extend_from_slice(&bytes),
                Some(Ok(Message::Text(text))) => {
                    if let Ok(ClientMessage::Resize { cols, rows }) = serde_json::from_str(&text)
                        && let Ok(size) = TerminalSize::from_request(cols, rows)
                    {
                        attachment.resize(size);
                    }
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => {}
                Some(Ok(Message::Close(_)) | Err(_)) | None => return,
            },
        }
    }
}

/// Sends `message`, then the screen the viewer starts over from.
async fn announce(
    socket: &mut WebSocket,
    message: ServerMessage,
    snapshot: Vec<u8>,
) -> Result<(), axum::Error> {
    socket.send(message.into()).await?;
    socket.send(Message::Binary(snapshot.into())).await
}

/// Sends the last message and closes the socket.
async fn finish(mut socket: WebSocket, message: ServerMessage) {
    if socket.send(message.into()).await.is_ok() {
        let _ = socket.send(Message::Close(None)).await;
    }
}

/// What a terminal belongs to.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Subject {
    Task(String),
    Section(String),
}

impl Subject {
    fn from_request(task: Option<String>, section: Option<String>) -> Result<Self, ApiError> {
        match (task, section) {
            (Some(thread_id), None) if !thread_id.is_empty() => Ok(Self::Task(thread_id)),
            (None, Some(section_id)) if !section_id.is_empty() => Ok(Self::Section(section_id)),
            _ => Err(ApiError::BadRequest {
                code: "invalid_terminal_subject",
                message: "A terminal belongs to exactly one Task or Section.".to_string(),
            }),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TerminalSize {
    columns: u16,
    rows: u16,
}

impl TerminalSize {
    fn from_request(columns: u16, rows: u16) -> Result<Self, ApiError> {
        if (MIN_COLUMNS..=MAX_COLUMNS).contains(&columns) && (1..=MAX_ROWS).contains(&rows) {
            return Ok(Self { columns, rows });
        }
        Err(ApiError::BadRequest {
            code: "invalid_terminal_size",
            message: format!(
                "A terminal has {MIN_COLUMNS} to {MAX_COLUMNS} columns and 1 to {MAX_ROWS} rows."
            ),
        })
    }
}

/// The browser tab a viewer attaches from. A viewer from the same tab as the
/// attached one replaces it even on `resume`: that viewer is the tab's own
/// connection, which the network dropped before the backend noticed.
fn tab_from_request(tab: String) -> Result<String, ApiError> {
    if (1..=MAX_TAB_LENGTH).contains(&tab.len()) {
        return Ok(tab);
    }
    Err(ApiError::BadRequest {
        code: "invalid_terminal_tab",
        message: format!("A terminal viewer names its browser tab in 1 to {MAX_TAB_LENGTH} bytes."),
    })
}

/// Whether attaching takes the terminal from a viewer already attached.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
enum AttachMode {
    /// The user asked for the terminal here.
    Take,
    /// The terminal screen appeared again on its own.
    Resume,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenTerminalRequest {
    task: Option<String>,
    section: Option<String>,
    /// The logical directory the shell starts in.
    cwd: String,
    cols: u16,
    rows: u16,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SubjectQuery {
    task: Option<String>,
    section: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SocketQuery {
    task: Option<String>,
    section: Option<String>,
    mode: AttachMode,
    tab: String,
    cols: u16,
    rows: u16,
}

/// Text messages from the backend. Terminal output travels as binary
/// messages; `attached` and `resync` are each followed by one binary message
/// holding the screen the browser redraws from after a reset.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum ServerMessage {
    Attached,
    Elsewhere,
    Absent,
    Resync,
    Taken,
    Ended,
}

impl From<ServerMessage> for Message {
    fn from(message: ServerMessage) -> Self {
        Message::Text(
            serde_json::to_string(&message)
                .expect("server messages serialize")
                .into(),
        )
    }
}

/// Text messages from the browser. Input travels as binary messages.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum ClientMessage {
    Resize { cols: u16, rows: u16 },
}

fn require_same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(same_origin_required)?;
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(same_origin_required)?;
    if !same_origin_host(origin, host) {
        return Err(same_origin_required());
    }
    Ok(())
}

fn same_origin_host(origin: &str, request_host: &str) -> bool {
    let Ok(origin) = Url::parse(origin) else {
        return false;
    };
    let Ok(authority) = Authority::from_str(request_host) else {
        return false;
    };
    if !matches!(origin.scheme(), "http" | "https")
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !origin.username().is_empty()
        || origin.password().is_some()
    {
        return false;
    }
    let Some(origin_host) = origin.host_str() else {
        return false;
    };
    if !origin_host.eq_ignore_ascii_case(authority.host()) {
        return false;
    }
    let request_port = authority.port_u16().or_else(|| match origin.scheme() {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    });
    request_port == origin.port_or_known_default()
}

fn same_origin_required() -> ApiError {
    ApiError::Forbidden {
        code: "same_origin_terminal_required",
        message: "Terminal requests must come from Caffold's own page.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, time::Duration};

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio::{
        net::TcpListener,
        task::JoinHandle,
        time::{sleep, timeout},
    };
    use tokio_tungstenite::{
        MaybeTlsStream, WebSocketStream, connect_async,
        tungstenite::{self, client::IntoClientRequest, http::HeaderValue},
    };

    use super::*;

    const WAIT: Duration = Duration::from_secs(30);

    type Socket = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

    #[tokio::test(flavor = "multi_thread")]
    async fn requests_from_another_origin_are_refused() {
        let server = Server::start().await;
        let body = open_body(json!({ "task": "thread-1" }));

        for origin in [Some("http://evil.example"), None] {
            let (status, error) = server.post(&body, origin).await;
            assert_eq!(status, 403);
            assert_eq!(error["error"]["code"], "same_origin_terminal_required");
            let (status, _) = server.delete("task=thread-1", origin).await;
            assert_eq!(status, 403);
            let refused = server
                .connect("task=thread-1&mode=take&tab=tab-1&cols=80&rows=24", origin)
                .await;
            assert!(
                matches!(&refused, Err(tungstenite::Error::Http(response)) if response.status() == 403),
                "{refused:?}"
            );
        }
        server.expect_no_terminal("task=thread-1").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn opening_checks_the_subject_the_size_and_the_directory() {
        let server = Server::start().await;
        let origin = Some(server.origin());
        let origin = origin.as_deref();

        for (body, status, code) in [
            (
                json!({ "task": "t", "section": "s" }),
                400,
                "invalid_terminal_subject",
            ),
            (json!({}), 400, "invalid_terminal_subject"),
            (json!({ "task": "" }), 400, "invalid_terminal_subject"),
            (
                json!({ "task": "t", "cols": 1 }),
                400,
                "invalid_terminal_size",
            ),
            (
                json!({ "task": "t", "rows": 0 }),
                400,
                "invalid_terminal_size",
            ),
            (
                json!({ "task": "t", "cols": 1001 }),
                400,
                "invalid_terminal_size",
            ),
            (json!({ "task": "t", "cwd": "missing" }), 404, "not_found"),
            (
                json!({ "task": "t", "cwd": "notes.txt" }),
                400,
                "not_directory",
            ),
        ] {
            let (actual, error) = server.post(&open_body(body.clone()), origin).await;
            assert_eq!(
                (actual, error["error"]["code"].as_str()),
                (status, Some(code)),
                "{body}"
            );
        }
        for query in [
            "task=t&mode=take&tab=tab-1&cols=0&rows=24",
            "task=t&mode=take&tab=&cols=80&rows=24",
        ] {
            let refused = server.connect(query, origin).await;
            assert!(
                matches!(&refused, Err(tungstenite::Error::Http(response)) if response.status() == 400),
                "{query}: {refused:?}"
            );
        }
        server.expect_no_terminal("task=t").await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn viewers_attach_type_and_hand_the_terminal_over() {
        let server = Server::start().await;
        let origin = Some(server.origin());
        let origin = origin.as_deref();
        let query = "task=thread-1&cols=80&rows=24";

        server.expect_no_terminal("task=thread-1").await;

        let body = open_body(json!({ "task": "thread-1" }));
        assert_eq!(server.post(&body, origin).await.0, 204);
        assert_eq!(server.post(&body, origin).await.0, 204);

        let mut first = server
            .connect(&format!("{query}&mode=take&tab=tab-1"), origin)
            .await
            .unwrap();
        expect_attached(&mut first).await;
        send_input(&mut first, "echo typed-$((1 + 1))\n").await;
        read_until(&mut first, "typed-2").await;
        server
            .wait_for_prompt(&Subject::Task("thread-1".to_string()))
            .await;

        let mut refused = server
            .connect(&format!("{query}&mode=resume&tab=tab-2"), origin)
            .await
            .unwrap();
        expect_last_message(&mut refused, "elsewhere").await;

        let mut second = server
            .connect(&format!("{query}&mode=take&tab=tab-2"), origin)
            .await
            .unwrap();
        let snapshot = expect_attached(&mut second).await;
        assert!(String::from_utf8_lossy(&snapshot).contains("typed-2"));
        expect_last_message(&mut first, "taken").await;

        second
            .send(tungstenite::Message::Text(
                json!({ "type": "resize", "cols": 100, "rows": 40 })
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        send_input(&mut second, "stty size\n").await;
        read_until(&mut second, "40 100").await;

        assert_eq!(server.delete("task=thread-1", origin).await.0, 204);
        expect_last_message(&mut second, "ended").await;
        assert_eq!(server.delete("task=thread-1", origin).await.0, 204);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_socket_that_falls_behind_is_resynchronized() {
        let server = Server::start().await;
        let origin = Some(server.origin());
        let origin = origin.as_deref();
        let body = open_body(json!({ "section": "section-1" }));
        assert_eq!(server.post(&body, origin).await.0, 204);
        let mut socket = server
            .connect(
                "section=section-1&mode=take&tab=tab-1&cols=80&rows=24",
                origin,
            )
            .await
            .unwrap();
        expect_attached(&mut socket).await;

        // Far more output than the socket's buffers hold arrives while the
        // client reads nothing; the file marks when the shell is done.
        send_input(
            &mut socket,
            "awk 'BEGIN { for (i = 0; i < 300000; i++) print \"0123456789012345678901234567890123456789012345678901234567890123456789012345678\" }'; touch flooded\n",
        )
        .await;
        let flooded = server.root.path().join("project/flooded");
        let finished = async {
            while !flooded.exists() {
                sleep(Duration::from_millis(50)).await;
            }
        };
        timeout(WAIT, finished).await.expect("the flood finished");

        let resynced = async {
            loop {
                match socket.next().await {
                    Some(Ok(tungstenite::Message::Text(text))) => {
                        let message: Value = serde_json::from_str(&text).unwrap();
                        assert_eq!(message["type"], "resync");
                        return;
                    }
                    Some(Ok(tungstenite::Message::Binary(_))) => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
        };
        timeout(WAIT, resynced).await.expect("the socket resynced");
        assert!(matches!(
            socket.next().await,
            Some(Ok(tungstenite::Message::Binary(_)))
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_shell_that_cannot_start_is_reported() {
        let server = Server::start_with(ShellCommand::new("/nonexistent/shell", &[])).await;
        let origin = server.origin();

        let (status, error) = server
            .post(&open_body(json!({ "task": "thread-1" })), Some(&origin))
            .await;

        assert_eq!(status, 503);
        assert_eq!(error["error"]["code"], "terminal_start_failed");
        server.expect_no_terminal("task=thread-1").await;
    }

    #[test]
    fn only_the_page_s_own_origin_counts_as_same_origin() {
        for (origin, host, same) in [
            ("http://127.0.0.1:5178", "127.0.0.1:5178", true),
            (
                "https://studio.tail7c2e.ts.net",
                "studio.tail7c2e.ts.net",
                true,
            ),
            (
                "https://studio.tail7c2e.ts.net",
                "studio.tail7c2e.ts.net:443",
                true,
            ),
            ("http://STUDIO.local", "studio.local:80", true),
            ("http://127.0.0.1:5178", "127.0.0.1:5179", false),
            ("http://evil.example", "127.0.0.1:5178", false),
            ("http://127.0.0.1:5178/path", "127.0.0.1:5178", false),
            ("http://user@127.0.0.1:5178", "127.0.0.1:5178", false),
            ("file:///etc", "127.0.0.1:5178", false),
            ("null", "127.0.0.1:5178", false),
            ("http://127.0.0.1:5178", "not a host", false),
        ] {
            assert_eq!(same_origin_host(origin, host), same, "{origin} vs {host}");
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_task_closes_only_its_own_terminal() {
        let terminals = Terminals {
            registry: Registry::new(ShellCommand::new("/bin/sh", &[])),
        };
        let size = TerminalSize {
            columns: 80,
            rows: 24,
        };
        let cwd = std::env::temp_dir();
        let subjects = [
            Subject::Task("thread-1".to_string()),
            Subject::Task("thread-2".to_string()),
            // A Section at the same directory keeps its terminal.
            Subject::Section("thread-1".to_string()),
        ];
        for subject in &subjects {
            terminals
                .registry
                .open(subject.clone(), &cwd, size)
                .unwrap();
        }

        terminals.for_tasks().close("thread-1");

        let open = subjects.map(|subject| terminals.registry.contains(&subject));
        terminals.registry.close_all();
        assert_eq!(open, [false, true, true]);
    }

    struct Server {
        address: SocketAddr,
        registry: Arc<Registry>,
        root: tempfile::TempDir,
        server: JoinHandle<()>,
    }

    impl Server {
        async fn start() -> Self {
            Self::start_with(ShellCommand::new("/bin/sh", &[])).await
        }

        async fn start_with(command: ShellCommand) -> Self {
            let root = tempfile::tempdir().unwrap();
            std::fs::create_dir(root.path().join("project")).unwrap();
            std::fs::write(root.path().join("notes.txt"), "").unwrap();
            let terminals = Terminals {
                registry: Registry::new(command),
            };
            let router = terminals.router(Arc::new(RootedFs::new(root.path()).unwrap()));
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            });
            Self {
                address,
                registry: terminals.registry,
                root,
                server,
            }
        }

        fn origin(&self) -> String {
            format!("http://{}", self.address)
        }

        /// Asks for the subject's terminal the way a returning screen does.
        async fn expect_no_terminal(&self, subject: &str) {
            let origin = self.origin();
            let mut socket = self
                .connect(
                    &format!("{subject}&mode=resume&tab=tab-1&cols=80&rows=24"),
                    Some(&origin),
                )
                .await
                .unwrap();
            expect_last_message(&mut socket, "absent").await;
        }

        /// Waits until the subject's `/bin/sh` shows its prompt, `$` or `#` for
        /// root. A readline shell writes back the window size it read when it
        /// starts a line, which can undo a resize made before the prompt shows.
        async fn wait_for_prompt(&self, subject: &Subject) {
            let prompted = async {
                while !self
                    .registry
                    .screen_text(subject)
                    .trim_end()
                    .ends_with(['$', '#'])
                {
                    sleep(Duration::from_millis(10)).await;
                }
            };
            timeout(WAIT, prompted)
                .await
                .expect("the shell shows its prompt");
        }

        async fn post(&self, body: &Value, origin: Option<&str>) -> (u16, Value) {
            let request = reqwest::Client::new()
                .post(format!("http://{}/api/terminal", self.address))
                .header("content-type", "application/json")
                .body(body.to_string());
            respond(with_origin(request, origin)).await
        }

        async fn delete(&self, query: &str, origin: Option<&str>) -> (u16, Value) {
            let request = reqwest::Client::new()
                .delete(format!("http://{}/api/terminal?{query}", self.address));
            respond(with_origin(request, origin)).await
        }

        async fn connect(
            &self,
            query: &str,
            origin: Option<&str>,
        ) -> Result<Socket, tungstenite::Error> {
            let mut request = format!("ws://{}/api/terminal/socket?{query}", self.address)
                .into_client_request()
                .unwrap();
            if let Some(origin) = origin {
                request
                    .headers_mut()
                    .insert("origin", HeaderValue::from_str(origin).unwrap());
            }
            connect_async(request).await.map(|(socket, _)| socket)
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.server.abort();
            self.registry.close_all();
        }
    }

    /// A valid open request with `fields` replacing its defaults.
    fn open_body(fields: Value) -> Value {
        let mut body = json!({ "cwd": "project", "cols": 80, "rows": 24 });
        for (name, value) in fields.as_object().unwrap() {
            body[name] = value.clone();
        }
        body
    }

    fn with_origin(
        request: reqwest::RequestBuilder,
        origin: Option<&str>,
    ) -> reqwest::RequestBuilder {
        match origin {
            Some(origin) => request.header("origin", origin),
            None => request,
        }
    }

    async fn respond(request: reqwest::RequestBuilder) -> (u16, Value) {
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let text = response.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    /// Reads `attached` and the snapshot after it.
    async fn expect_attached(socket: &mut Socket) -> Vec<u8> {
        assert_eq!(next_text(socket).await["type"], "attached");
        match timeout(WAIT, socket.next()).await.unwrap() {
            Some(Ok(tungstenite::Message::Binary(snapshot))) => snapshot.to_vec(),
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    /// Reads the socket's closing message, skipping output before it.
    async fn expect_last_message(socket: &mut Socket, kind: &str) {
        assert_eq!(next_text(socket).await["type"], kind);
        let closed = timeout(WAIT, socket.next()).await.unwrap();
        assert!(
            matches!(closed, Some(Ok(tungstenite::Message::Close(_))) | None),
            "{closed:?}"
        );
    }

    async fn next_text(socket: &mut Socket) -> Value {
        loop {
            match timeout(WAIT, socket.next()).await.unwrap() {
                Some(Ok(tungstenite::Message::Text(text))) => {
                    return serde_json::from_str(&text).unwrap();
                }
                Some(Ok(tungstenite::Message::Binary(_))) => {}
                other => panic!("expected a message, got {other:?}"),
            }
        }
    }

    async fn send_input(socket: &mut Socket, text: &str) {
        socket
            .send(tungstenite::Message::Binary(
                text.as_bytes().to_vec().into(),
            ))
            .await
            .unwrap();
    }

    async fn read_until(socket: &mut Socket, text: &str) {
        let mut seen = Vec::new();
        let reading = async {
            while !String::from_utf8_lossy(&seen).contains(text) {
                match socket.next().await {
                    Some(Ok(tungstenite::Message::Binary(bytes))) => seen.extend_from_slice(&bytes),
                    other => panic!("unexpected {other:?}"),
                }
            }
        };
        if timeout(WAIT, reading).await.is_err() {
            panic!("no {text:?} in {:?}", String::from_utf8_lossy(&seen));
        }
    }
}
