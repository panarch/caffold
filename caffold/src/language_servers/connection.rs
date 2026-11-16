//! One running language server and the LSP conversation with it: JSON-RPC
//! messages framed by `Content-Length` headers over the child's stdin and
//! stdout.
//!
//! The connection asks only what the code viewers need: where a name is
//! defined and where it is used. It answers the requests a server makes of
//! its client, and passes on what the server reports about its own progress.

use std::{
    collections::{HashMap, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex, PoisonError, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{mpsc, oneshot},
};
use url::Url;

use super::{Language, discovery::FoundServer};

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(120);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// Documents stay open between requests so a server keeps their analysis;
/// past this many, the longest unused one closes.
const OPEN_DOCUMENT_LIMIT: usize = 32;

/// What the server reports about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Notice {
    /// The work in progress it reported last, or `None` once none is.
    Progress(Option<String>),
    /// rust-analyzer's `experimental/serverStatus` `quiescent` flag.
    Quiescent(bool),
    Exited,
}

/// A source file as the viewer shows it, sent to the server before a
/// question about it.
pub(super) struct Document {
    pub(super) path: PathBuf,
    pub(super) language_id: &'static str,
    pub(super) text: String,
}

/// A place a server answered with, in LSP's zero-based lines and UTF-16
/// columns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Target {
    pub(super) path: PathBuf,
    pub(super) line: u32,
    pub(super) character: u32,
    /// How many UTF-16 units the name takes, when it ends on its own line.
    pub(super) length: Option<u32>,
}

pub(super) struct Connection {
    pid: Option<u32>,
    configuration: Value,
    writer: tokio::sync::Mutex<ChildStdin>,
    child: tokio::sync::Mutex<Child>,
    pending: Arc<Pending>,
    next_id: AtomicU64,
    documents: tokio::sync::Mutex<VecDeque<OpenDocument>>,
}

type Answer = Result<Value, String>;
type Pending = Mutex<HashMap<u64, oneshot::Sender<Answer>>>;

struct OpenDocument {
    uri: Url,
    version: i32,
    text: String,
}

impl Connection {
    /// Starts the server in `root` and completes the `initialize` handshake.
    /// The server goes on indexing afterwards and says so through `notices`.
    pub(super) async fn start(
        server: &FoundServer,
        root: &Path,
        language: Language,
        notices: mpsc::UnboundedSender<Notice>,
    ) -> Result<Arc<Self>, String> {
        let root_uri = Url::from_directory_path(root)
            .map_err(|()| format!("{} is not an absolute folder.", root.display()))?;
        let mut child = Command::new(&server.program)
            .args(&server.arguments)
            .current_dir(root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| format!("{} could not start: {error}", server.program.display()))?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let connection = Arc::new(Self {
            pid: child.id(),
            configuration: language.configuration(),
            writer: tokio::sync::Mutex::new(stdin),
            child: tokio::sync::Mutex::new(child),
            pending: Arc::default(),
            next_id: AtomicU64::new(1),
            documents: tokio::sync::Mutex::default(),
        });
        tokio::spawn(read_messages(
            stdout,
            Arc::downgrade(&connection),
            connection.pending.clone(),
            notices,
        ));

        let name = root
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        connection
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "clientInfo": { "name": "Caffold" },
                    "rootUri": root_uri.as_str(),
                    "workspaceFolders": [{ "uri": root_uri.as_str(), "name": name }],
                    "capabilities": {
                        "general": { "positionEncodings": ["utf-16"] },
                        "window": { "workDoneProgress": true },
                        "workspace": { "configuration": true, "workspaceFolders": true },
                        "textDocument": {
                            "synchronization": { "didSave": false },
                            "definition": { "linkSupport": true },
                            "references": {},
                        },
                        "experimental": { "serverStatusNotification": true },
                    },
                    "initializationOptions": connection.configuration,
                }),
                INITIALIZE_TIMEOUT,
            )
            .await?;
        connection.notify("initialized", json!({})).await?;
        Ok(connection)
    }

    pub(super) fn pid(&self) -> Option<u32> {
        self.pid
    }

    /// Where the name at `line` and `character` of `document` is defined.
    pub(super) async fn definition(
        &self,
        document: Document,
        line: u32,
        character: u32,
    ) -> Result<Vec<Target>, String> {
        let uri = self.open(document).await?;
        let answer = self
            .request(
                "textDocument/definition",
                json!({
                    "textDocument": { "uri": uri.as_str() },
                    "position": { "line": line, "character": character },
                }),
                REQUEST_TIMEOUT,
            )
            .await?;
        Ok(targets(&answer))
    }

    /// Where the name at `line` and `character` of `document` is declared and
    /// used.
    pub(super) async fn references(
        &self,
        document: Document,
        line: u32,
        character: u32,
    ) -> Result<Vec<Target>, String> {
        let uri = self.open(document).await?;
        let answer = self
            .request(
                "textDocument/references",
                json!({
                    "textDocument": { "uri": uri.as_str() },
                    "position": { "line": line, "character": character },
                    "context": { "includeDeclaration": true },
                }),
                REQUEST_TIMEOUT,
            )
            .await?;
        Ok(targets(&answer))
    }

    /// Asks the server to shut down and exit, and ends the process if it
    /// does not within a short wait.
    pub(super) async fn stop(&self) {
        let asked = self
            .request("shutdown", Value::Null, SHUTDOWN_TIMEOUT)
            .await;
        if asked.is_ok() {
            let _ = self.notify("exit", Value::Null).await;
        }
        let mut child = self.child.lock().await;
        if tokio::time::timeout(SHUTDOWN_TIMEOUT, child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }

    /// Opens the document, or brings the server's copy up to date with the
    /// viewer's, before a question about it.
    async fn open(&self, document: Document) -> Result<Url, String> {
        let uri = Url::from_file_path(&document.path)
            .map_err(|()| format!("{} is not an absolute path.", document.path.display()))?;
        let mut open = self.documents.lock().await;
        if let Some(index) = open.iter().position(|open| open.uri == uri) {
            let mut current = open.remove(index).expect("the position is in range");
            if current.text != document.text {
                current.version += 1;
                current.text = document.text;
                self.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri.as_str(), "version": current.version },
                        "contentChanges": [{ "text": current.text }],
                    }),
                )
                .await?;
            }
            open.push_back(current);
            return Ok(uri);
        }
        self.notify(
            "textDocument/didOpen",
            json!({
                "textDocument": {
                    "uri": uri.as_str(),
                    "languageId": document.language_id,
                    "version": 1,
                    "text": document.text,
                },
            }),
        )
        .await?;
        open.push_back(OpenDocument {
            uri: uri.clone(),
            version: 1,
            text: document.text,
        });
        if open.len() > OPEN_DOCUMENT_LIMIT
            && let Some(oldest) = open.pop_front()
        {
            self.notify(
                "textDocument/didClose",
                json!({ "textDocument": { "uri": oldest.uri.as_str() } }),
            )
            .await?;
        }
        Ok(uri)
    }

    async fn request(&self, method: &str, params: Value, timeout: Duration) -> Answer {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, answer) = oneshot::channel();
        lock(&self.pending).insert(id, sender);
        let sent = self
            .send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        if let Err(error) = sent {
            lock(&self.pending).remove(&id);
            return Err(error);
        }
        match tokio::time::timeout(timeout, answer).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("The language server exited.".to_string()),
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(format!("The language server did not answer {method}."))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    async fn send(&self, message: &Value) -> Result<(), String> {
        let body = message.to_string();
        let mut writer = self.writer.lock().await;
        let written = async {
            writer
                .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
                .await?;
            writer.write_all(body.as_bytes()).await?;
            writer.flush().await
        };
        written
            .await
            .map_err(|error| format!("The language server stopped reading: {error}"))
    }
}

/// Reads the server's messages until its stdout closes, then fails every
/// question still waiting and reports the exit.
async fn read_messages(
    stdout: ChildStdout,
    connection: Weak<Connection>,
    pending: Arc<Pending>,
    notices: mpsc::UnboundedSender<Notice>,
) {
    let mut reader = BufReader::new(stdout);
    let mut progress = Progress::default();
    while let Some(message) = read_message(&mut reader).await {
        let method = message.get("method").and_then(Value::as_str);
        match (message.get("id"), method) {
            (Some(id), Some(method)) => {
                let Some(connection) = connection.upgrade() else {
                    break;
                };
                let result = answer_server_request(method, &message, &connection.configuration);
                let _ = connection
                    .send(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
                    .await;
            }
            (Some(id), None) => {
                let sender = id.as_u64().and_then(|id| lock(&pending).remove(&id));
                if let Some(sender) = sender {
                    let answer = match message.get("error") {
                        Some(error) => Err(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("The language server refused the request.")
                            .to_string()),
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = sender.send(answer);
                }
            }
            (None, Some("$/progress")) => {
                if let Some(text) = progress.update(&message["params"]) {
                    let _ = notices.send(Notice::Progress(text));
                }
            }
            (None, Some("experimental/serverStatus")) => {
                let quiescent = message["params"]["quiescent"].as_bool().unwrap_or(false);
                let _ = notices.send(Notice::Quiescent(quiescent));
            }
            _ => {}
        }
    }
    lock(&pending).clear();
    let _ = notices.send(Notice::Exited);
}

/// One framed message, or `None` once the stream ends or breaks.
async fn read_message(reader: &mut BufReader<ChildStdout>) -> Option<Value> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).await.ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let mut body = vec![0; length?];
    reader.read_exact(&mut body).await.ok()?;
    serde_json::from_slice(&body).ok()
}

/// Every configuration item gets the same settings the server started with;
/// other requests (progress tokens, capability registration) need no answer
/// beyond acceptance.
fn answer_server_request(method: &str, message: &Value, configuration: &Value) -> Value {
    match method {
        "workspace/configuration" => {
            let items = message["params"]["items"].as_array().map_or(0, Vec::len);
            Value::Array(vec![configuration.clone(); items])
        }
        _ => Value::Null,
    }
}

/// `Location`, `Location[]`, or `LocationLink[]`, kept to the file places.
fn targets(answer: &Value) -> Vec<Target> {
    let items = match answer {
        Value::Array(items) => items.as_slice(),
        Value::Null => &[],
        single => std::slice::from_ref(single),
    };
    items
        .iter()
        .filter_map(|item| {
            let uri = item
                .get("targetUri")
                .or_else(|| item.get("uri"))?
                .as_str()?;
            let range = item
                .get("targetSelectionRange")
                .or_else(|| item.get("range"))?;
            let path = Url::parse(uri).ok()?.to_file_path().ok()?;
            let line = u32::try_from(range["start"]["line"].as_u64()?).ok()?;
            let character = u32::try_from(range["start"]["character"].as_u64()?).ok()?;
            let end = &range["end"];
            let length = (end["line"].as_u64() == Some(u64::from(line)))
                .then(|| end["character"].as_u64())
                .flatten()
                .and_then(|end| u32::try_from(end).ok())
                .and_then(|end| end.checked_sub(character))
                .filter(|length| *length > 0);
            Some(Target {
                path,
                line,
                character,
                length,
            })
        })
        .collect()
}

/// The server's `$/progress` reports, reduced to the latest one still open.
#[derive(Default)]
struct Progress {
    /// Open tokens in the order they began, each with its title and latest
    /// message.
    open: Vec<(String, String, Option<String>)>,
}

impl Progress {
    /// The new progress text when it changed.
    fn update(&mut self, params: &Value) -> Option<Option<String>> {
        let before = self.text();
        let token = params["token"].to_string();
        let value = &params["value"];
        let message = value["message"].as_str().map(str::to_string);
        match value["kind"].as_str() {
            Some("begin") => {
                let title = value["title"].as_str().unwrap_or_default().to_string();
                self.open.retain(|(open, ..)| *open != token);
                self.open.push((token, title, message));
            }
            Some("report") => {
                if let Some(open) = self.open.iter_mut().find(|(open, ..)| *open == token) {
                    open.2 = message;
                }
            }
            Some("end") => self.open.retain(|(open, ..)| *open != token),
            _ => {}
        }
        let after = self.text();
        (after != before).then_some(after)
    }

    fn text(&self) -> Option<String> {
        self.open.last().map(|(_, title, message)| match message {
            Some(message) if !message.is_empty() => format!("{title} {message}"),
            _ => title.clone(),
        })
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The checked-in wire fixture `fixtures/fake_language_server.py` in one of
/// its modes.
#[cfg(test)]
pub(super) fn fake_server(mode: &str) -> FoundServer {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src/language_servers/fixtures/fake_language_server.py");
    FoundServer {
        program: PathBuf::from("/usr/bin/python3"),
        arguments: vec!["-u".into(), fixture.display().to_string(), mode.into()],
        version: "fake".into(),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::TempDir;

    use super::*;

    async fn next(notices: &mut mpsc::UnboundedReceiver<Notice>) -> Notice {
        tokio::time::timeout(Duration::from_secs(10), notices.recv())
            .await
            .expect("the server reports within the wait")
            .expect("the notice channel stays open")
    }

    fn project() -> TempDir {
        let root = TempDir::new().unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(
            root.path().join("src/main.rs"),
            "fn main() {\n    helper();\n}\n",
        )
        .unwrap();
        fs::write(
            root.path().join("src/target.rs"),
            "\n\npub fn helper() {}\n",
        )
        .unwrap();
        root
    }

    fn main_document(root: &Path) -> Document {
        let path = root.join("src/main.rs");
        Document {
            text: fs::read_to_string(&path).unwrap(),
            path,
            language_id: "rust",
        }
    }

    #[tokio::test]
    async fn indexing_progress_and_readiness_arrive_after_the_handshake() {
        let root = project();
        let (sender, mut notices) = mpsc::unbounded_channel();

        let connection =
            Connection::start(&fake_server("status"), root.path(), Language::Rust, sender)
                .await
                .unwrap();

        // The fixture reports readiness only after it receives the answer to
        // its `workspace/configuration` request, carrying the settings.
        assert_eq!(next(&mut notices).await, Notice::Quiescent(false));
        assert_eq!(
            next(&mut notices).await,
            Notice::Progress(Some("Indexing".into()))
        );
        assert_eq!(
            next(&mut notices).await,
            Notice::Progress(Some("Indexing 1/2 (core)".into()))
        );
        assert_eq!(next(&mut notices).await, Notice::Progress(None));
        assert_eq!(next(&mut notices).await, Notice::Quiescent(true));
        assert!(connection.pid().is_some());
        connection.stop().await;
        assert_eq!(next(&mut notices).await, Notice::Exited);
    }

    #[tokio::test]
    async fn a_definition_opens_the_document_and_names_the_target_file() {
        let root = project();
        let (sender, _notices) = mpsc::unbounded_channel();
        let connection =
            Connection::start(&fake_server("status"), root.path(), Language::Rust, sender)
                .await
                .unwrap();

        let targets = connection
            .definition(main_document(root.path()), 1, 4)
            .await
            .unwrap();

        assert_eq!(
            targets,
            vec![Target {
                path: root.path().join("src/target.rs"),
                line: 2,
                character: 7,
                length: Some(6),
            }]
        );
        connection.stop().await;
    }

    #[tokio::test]
    async fn references_follow_an_edited_document() {
        let root = project();
        let (sender, _notices) = mpsc::unbounded_channel();
        let connection =
            Connection::start(&fake_server("status"), root.path(), Language::Rust, sender)
                .await
                .unwrap();
        connection
            .definition(main_document(root.path()), 1, 4)
            .await
            .unwrap();
        let mut edited = main_document(root.path());
        edited
            .text
            .push_str("fn more() {\n    helper();\n}\nfn helper() {}\n");

        let targets = connection.references(edited, 1, 4).await.unwrap();

        // The fixture answers one place per line that names `helper`, in the
        // text it was last sent, its declaration included only when asked.
        let main = root.path().join("src/main.rs");
        assert_eq!(
            targets,
            vec![
                Target {
                    path: main.clone(),
                    line: 1,
                    character: 4,
                    length: Some(6),
                },
                Target {
                    path: main.clone(),
                    line: 4,
                    character: 4,
                    length: Some(6),
                },
                Target {
                    path: main,
                    line: 6,
                    character: 3,
                    length: Some(6),
                },
            ]
        );
        connection.stop().await;
    }

    #[tokio::test]
    async fn a_server_that_exits_fails_waiting_questions_and_reports_it() {
        let root = project();
        let (sender, mut notices) = mpsc::unbounded_channel();
        let connection = Connection::start(
            &fake_server("exit-on-definition"),
            root.path(),
            Language::Rust,
            sender,
        )
        .await
        .unwrap();

        let answer = connection
            .definition(main_document(root.path()), 1, 4)
            .await;

        assert_eq!(answer, Err("The language server exited.".to_string()));
        loop {
            if next(&mut notices).await == Notice::Exited {
                break;
            }
        }
    }

    #[test]
    fn progress_shows_the_latest_open_work() {
        let mut progress = Progress::default();
        let begin = |token: &str, title: &str| json!({ "token": token, "value": { "kind": "begin", "title": title } });

        assert_eq!(
            progress.update(&begin("a", "Fetching")),
            Some(Some("Fetching".into()))
        );
        assert_eq!(
            progress.update(&begin("b", "Indexing")),
            Some(Some("Indexing".into()))
        );
        assert_eq!(
            progress
                .update(&json!({ "token": "b", "value": { "kind": "report", "message": "3/9" } })),
            Some(Some("Indexing 3/9".into()))
        );
        assert_eq!(
            progress.update(&json!({ "token": "a", "value": { "kind": "end" } })),
            None
        );
        assert_eq!(
            progress.update(&json!({ "token": "b", "value": { "kind": "end" } })),
            Some(None)
        );
    }

    #[test]
    fn locations_and_location_links_become_file_targets() {
        let link = json!([{
            "targetUri": "file:///work/a%20b/lib.rs",
            "targetRange": { "start": { "line": 0, "character": 0 }, "end": { "line": 9, "character": 0 } },
            "targetSelectionRange": { "start": { "line": 3, "character": 7 }, "end": { "line": 3, "character": 9 } },
        }]);
        let single = json!({
            "uri": "file:///work/main.rs",
            "range": { "start": { "line": 1, "character": 2 }, "end": { "line": 1, "character": 5 } },
        });
        let elsewhere = json!([{
            "uri": "untitled:Untitled-1",
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
        }]);

        assert_eq!(
            targets(&link),
            vec![Target {
                path: PathBuf::from("/work/a b/lib.rs"),
                line: 3,
                character: 7,
                length: Some(2),
            }]
        );
        assert_eq!(
            targets(&single),
            vec![Target {
                path: PathBuf::from("/work/main.rs"),
                line: 1,
                character: 2,
                length: Some(3),
            }]
        );
        assert_eq!(targets(&elsewhere), Vec::new());
        assert_eq!(targets(&Value::Null), Vec::new());
    }
}
