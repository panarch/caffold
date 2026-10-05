//! What the browser shows about updating the Caffold app: the newest release
//! on GitHub, the latest update attempt, and whether this server can start an
//! update Task.

use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use semver::Version;
use serde::Serialize;
use tokio::sync::Mutex;

use crate::{
    fs::RootedFs,
    update::{
        Attempt, AttemptOutcome, AttemptRecords, HomebrewRecord, LatestRelease, UPDATES_DIRECTORY,
        fetch_latest_release, homebrew_record, process_alive,
    },
};

/// GitHub is asked again once its answer is this old, the same as the
/// menu-bar app's own check.
const RELEASE_CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// The server's place among the app's files.
pub(super) struct UpdateConfig {
    pub(super) data_dir: PathBuf,
    /// The Caffold Server app that runs this server, when one does.
    pub(super) app_bundle: Option<PathBuf>,
    pub(super) port: u16,
}

#[derive(Clone)]
pub(super) struct UpdateRoutes {
    service: UpdateService,
}

impl UpdateRoutes {
    pub(super) fn new(fs: Arc<RootedFs>, config: UpdateConfig) -> Self {
        Self::with_sources(fs, config, Arc::new(MacSources))
    }

    fn with_sources(
        fs: Arc<RootedFs>,
        config: UpdateConfig,
        sources: Arc<dyn UpdateSources>,
    ) -> Self {
        Self {
            service: UpdateService {
                fs,
                records: Arc::new(AttemptRecords::new(config.data_dir.join(UPDATES_DIRECTORY))),
                data_dir: config.data_dir,
                app_bundle: config.app_bundle,
                port: config.port,
                sources,
                release: Arc::new(Mutex::new(None)),
            },
        }
    }

    pub(super) fn router(&self) -> Router {
        Router::new()
            .route("/api/caffold/update", get(update_status))
            .route("/api/caffold/update/check", post(check_for_update))
            .with_state(self.service.clone())
    }

    /// Asks GitHub once when the server starts.
    pub(super) fn check_release_in_background(&self) {
        let service = self.service.clone();
        tokio::spawn(async move {
            let _ = service.latest_release().await;
        });
    }

    /// The directory an update Task works in, which must exist before a
    /// Task can start there.
    pub(super) fn update_directory(&self) -> Option<PathBuf> {
        self.service
            .app_bundle
            .as_ref()
            .map(|_| self.service.data_dir.join(UPDATES_DIRECTORY))
    }
}

async fn update_status(State(service): State<UpdateService>) -> Json<UpdateStatusResponse> {
    let release = service.latest_release().await;
    Json(service.status(release).await)
}

/// Asks GitHub now, whatever the age of the last answer, for someone who
/// chose to check.
async fn check_for_update(State(service): State<UpdateService>) -> Json<UpdateStatusResponse> {
    let release = service.current_release().await;
    Json(service.status(release).await)
}

#[derive(Clone)]
struct UpdateService {
    fs: Arc<RootedFs>,
    records: Arc<AttemptRecords>,
    data_dir: PathBuf,
    app_bundle: Option<PathBuf>,
    port: u16,
    sources: Arc<dyn UpdateSources>,
    release: Arc<Mutex<Option<ReleaseCheck>>>,
}

struct ReleaseCheck {
    checked_at: Instant,
    result: Result<LatestRelease, String>,
}

impl UpdateService {
    async fn status(&self, release: Result<LatestRelease, String>) -> UpdateStatusResponse {
        let version =
            Version::parse(env!("CARGO_PKG_VERSION")).expect("the package version is semver");
        let update_available = release
            .as_ref()
            .is_ok_and(|release| release.version > version);
        let (last_attempt, running_attempt) = self.attempts().await;
        let update_task = if update_available {
            self.update_task().await
        } else {
            None
        };
        let (latest_release, release_error) = match release {
            Ok(release) => (
                Some(ReleaseResponse {
                    version: release.version.to_string(),
                    url: release.url,
                }),
                None,
            ),
            Err(problem) => (None, Some(problem)),
        };
        UpdateStatusResponse {
            version: version.to_string(),
            latest_release,
            release_error,
            update_available,
            update_task,
            last_attempt,
            running_attempt,
        }
    }

    /// The newest release, asking GitHub again once the last answer is old.
    /// Requests that arrive during a check wait for that check.
    async fn latest_release(&self) -> Result<LatestRelease, String> {
        let mut check = self.release.lock().await;
        if let Some(check) = check.as_ref()
            && check.checked_at.elapsed() < RELEASE_CHECK_INTERVAL
        {
            return check.result.clone();
        }
        self.ask_github(&mut check).await
    }

    /// The newest release as GitHub tells it after this request arrived. A
    /// check that ends while this request waits for it answers this request
    /// too.
    async fn current_release(&self) -> Result<LatestRelease, String> {
        let arrived_at = Instant::now();
        let mut check = self.release.lock().await;
        if let Some(check) = check.as_ref()
            && check.checked_at > arrived_at
        {
            return check.result.clone();
        }
        self.ask_github(&mut check).await
    }

    async fn ask_github(&self, check: &mut Option<ReleaseCheck>) -> Result<LatestRelease, String> {
        let result = self.sources.latest_release().await;
        *check = Some(ReleaseCheck {
            checked_at: Instant::now(),
            result: result.clone(),
        });
        result
    }

    /// The newest finished attempt, and the attempt still running in a live
    /// process.
    async fn attempts(&self) -> (Option<AttemptResponse>, Option<AttemptResponse>) {
        let records = self.records.clone();
        let sources = self.sources.clone();
        tokio::task::spawn_blocking(move || {
            (
                records
                    .latest_finished()
                    .ok()
                    .flatten()
                    .map(AttemptResponse::from),
                records
                    .running(|pid| sources.alive(pid))
                    .ok()
                    .flatten()
                    .map(AttemptResponse::from),
            )
        })
        .await
        .unwrap_or_default()
    }

    /// Where and how an update Task updates the app this server runs from.
    /// Only a server the app runs, from an app Homebrew installed, offers one.
    async fn update_task(&self) -> Option<UpdateTaskResponse> {
        let app = self.app_bundle.as_ref()?;
        if !matches!(
            self.sources.homebrew_record().await,
            HomebrewRecord::Installed(_)
        ) {
            return None;
        }
        let cwd = self
            .fs
            .logical_path_for_absolute(&self.data_dir.join(UPDATES_DIRECTORY))
            .ok()?;
        Some(UpdateTaskResponse {
            cwd,
            command: update_command(app, &self.data_dir, self.port),
        })
    }
}

/// The command an update Task runs, with every path quoted for the shell.
fn update_command(app: &Path, data_dir: &Path, port: u16) -> String {
    format!(
        "{} update --app {} --data-dir {} --port {port}",
        quote(&app.join("Contents/Resources/caffold")),
        quote(app),
        quote(data_dir),
    )
}

fn quote(path: &Path) -> String {
    let mut quoted = String::from("\"");
    for character in path.to_string_lossy().chars() {
        if matches!(character, '"' | '\\' | '$' | '`') {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.push('"');
    quoted
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatusResponse {
    /// The version this server runs.
    version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_release: Option<ReleaseResponse>,
    /// Why the newest release is unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    release_error: Option<String>,
    update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    update_task: Option<UpdateTaskResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_attempt: Option<AttemptResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    running_attempt: Option<AttemptResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseResponse {
    version: String,
    url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskResponse {
    /// The update directory, as a Task `cwd`.
    cwd: String,
    command: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AttemptResponse {
    id: String,
    started_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    finished_at: Option<String>,
    from_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    to_version: Option<String>,
    started_from_menu_bar: bool,
    outcome: AttemptOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

impl From<Attempt> for AttemptResponse {
    fn from(attempt: Attempt) -> Self {
        Self {
            id: attempt.id,
            started_at: attempt.started_at,
            finished_at: attempt.finished_at,
            from_version: attempt.from_version,
            to_version: attempt.to_version,
            started_from_menu_bar: attempt.started_from_menu_bar,
            outcome: attempt.outcome,
            reason: attempt.reason,
        }
    }
}

type SourceFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// What the status reads outside this server.
trait UpdateSources: Send + Sync {
    fn latest_release(&self) -> SourceFuture<Result<LatestRelease, String>>;
    fn homebrew_record(&self) -> SourceFuture<HomebrewRecord>;
    fn alive(&self, pid: u32) -> bool;
}

struct MacSources;

impl UpdateSources for MacSources {
    fn latest_release(&self) -> SourceFuture<Result<LatestRelease, String>> {
        Box::pin(fetch_latest_release())
    }

    fn homebrew_record(&self) -> SourceFuture<HomebrewRecord> {
        Box::pin(homebrew_record())
    }

    fn alive(&self, pid: u32) -> bool {
        process_alive(pid)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        RwLock,
        atomic::{AtomicUsize, Ordering},
    };

    use axum::{
        body::Body,
        http::{Request, request::Builder},
    };
    use tower::ServiceExt;

    use super::*;

    const APP: &str = "/Applications/Caffold Server.app";

    struct FakeSources {
        /// What GitHub answers now.
        release: RwLock<Result<LatestRelease, String>>,
        homebrew: HomebrewRecord,
        alive: bool,
        release_requests: AtomicUsize,
    }

    impl FakeSources {
        fn new(release: Result<&str, &str>) -> Self {
            Self {
                release: RwLock::new(release.map(published).map_err(str::to_string)),
                homebrew: HomebrewRecord::Installed(None),
                alive: true,
                release_requests: AtomicUsize::new(0),
            }
        }
    }

    fn published(version: &str) -> LatestRelease {
        LatestRelease {
            version: Version::parse(version).unwrap(),
            url: format!("https://github.com/panarch/caffold/releases/tag/v{version}"),
        }
    }

    impl UpdateSources for FakeSources {
        fn latest_release(&self) -> SourceFuture<Result<LatestRelease, String>> {
            self.release_requests.fetch_add(1, Ordering::SeqCst);
            let release = self.release.read().unwrap().clone();
            Box::pin(async move { release })
        }

        fn homebrew_record(&self) -> SourceFuture<HomebrewRecord> {
            let record = self.homebrew.clone();
            Box::pin(async move { record })
        }

        fn alive(&self, _pid: u32) -> bool {
            self.alive
        }
    }

    struct Server {
        _root: tempfile::TempDir,
        data_dir: PathBuf,
        routes: UpdateRoutes,
        sources: Arc<FakeSources>,
    }

    fn server(sources: FakeSources, app_bundle: Option<&str>) -> Server {
        let root = tempfile::tempdir().unwrap();
        let data_dir = root.path().canonicalize().unwrap().join("data");
        std::fs::create_dir_all(data_dir.join(UPDATES_DIRECTORY)).unwrap();
        let sources = Arc::new(sources);
        let routes = UpdateRoutes::with_sources(
            Arc::new(RootedFs::new(root.path().to_path_buf()).unwrap()),
            UpdateConfig {
                data_dir: data_dir.clone(),
                app_bundle: app_bundle.map(PathBuf::from),
                port: 5178,
            },
            sources.clone(),
        );
        Server {
            _root: root,
            data_dir,
            routes,
            sources,
        }
    }

    async fn status(server: &Server) -> serde_json::Value {
        answer(server, Request::get("/api/caffold/update")).await
    }

    async fn check(server: &Server) -> serde_json::Value {
        answer(server, Request::post("/api/caffold/update/check")).await
    }

    async fn answer(server: &Server, request: Builder) -> serde_json::Value {
        let response = server
            .routes
            .router()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn newer() -> String {
        let version = Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
        Version::new(version.major, version.minor + 1, 0).to_string()
    }

    #[tokio::test]
    async fn offers_an_update_task_for_the_app_homebrew_installed() {
        let newer = newer();
        let server = server(FakeSources::new(Ok(&newer)), Some(APP));

        let status = status(&server).await;

        assert_eq!(status["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(status["latestRelease"]["version"], newer);
        assert_eq!(
            status["latestRelease"]["url"],
            format!("https://github.com/panarch/caffold/releases/tag/v{newer}")
        );
        assert_eq!(status["updateAvailable"], true);
        assert_eq!(status["updateTask"]["cwd"], "data/caffold-updates");
        assert_eq!(
            status["updateTask"]["command"],
            format!(
                "\"{APP}/Contents/Resources/caffold\" update --app \"{APP}\" --data-dir \"{}\" --port 5178",
                server.data_dir.display()
            )
        );
        assert!(status.get("releaseError").is_none());
        assert!(status.get("lastAttempt").is_none());
        assert!(status.get("runningAttempt").is_none());
    }

    #[tokio::test]
    async fn offers_no_update_task_without_a_newer_release_homebrew_or_the_app() {
        let current = env!("CARGO_PKG_VERSION");
        let status_of = |server: Server| async move { status(&server).await };

        let up_to_date = status_of(server(FakeSources::new(Ok(current)), Some(APP))).await;
        assert_eq!(up_to_date["updateAvailable"], false);
        assert!(up_to_date.get("updateTask").is_none());

        let mut sources = FakeSources::new(Ok(&newer()));
        sources.homebrew = HomebrewRecord::NotInstalled;
        let copied = status_of(server(sources, Some(APP))).await;
        assert_eq!(copied["updateAvailable"], true);
        assert!(copied.get("updateTask").is_none());

        let mut sources = FakeSources::new(Ok(&newer()));
        sources.homebrew = HomebrewRecord::NoHomebrew;
        assert!(
            status_of(server(sources, Some(APP)))
                .await
                .get("updateTask")
                .is_none()
        );

        let developer = status_of(server(FakeSources::new(Ok(&newer())), None)).await;
        assert_eq!(developer["updateAvailable"], true);
        assert!(developer.get("updateTask").is_none());
    }

    #[tokio::test]
    async fn says_why_the_newest_release_is_unknown() {
        let server = server(
            FakeSources::new(Err("Caffold could not reach GitHub: timed out")),
            Some(APP),
        );

        let status = status(&server).await;

        assert_eq!(
            status["releaseError"],
            "Caffold could not reach GitHub: timed out"
        );
        assert_eq!(status["updateAvailable"], false);
        assert!(status.get("latestRelease").is_none());
        assert!(status.get("updateTask").is_none());
    }

    #[tokio::test]
    async fn asks_github_once_until_its_answer_is_old() {
        let server = server(FakeSources::new(Ok(&newer())), Some(APP));

        status(&server).await;
        status(&server).await;
        assert_eq!(server.sources.release_requests.load(Ordering::SeqCst), 1);

        server
            .routes
            .service
            .release
            .lock()
            .await
            .as_mut()
            .unwrap()
            .checked_at = Instant::now() - RELEASE_CHECK_INTERVAL;
        status(&server).await;
        assert_eq!(server.sources.release_requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_check_asks_github_at_once_for_a_release_the_last_answer_missed() {
        let current = env!("CARGO_PKG_VERSION");
        let server = server(FakeSources::new(Ok(current)), Some(APP));
        assert_eq!(status(&server).await["updateAvailable"], false);

        let newer = newer();
        *server.sources.release.write().unwrap() = Ok(published(&newer));
        assert_eq!(status(&server).await["updateAvailable"], false);
        assert_eq!(server.sources.release_requests.load(Ordering::SeqCst), 1);

        let checked = check(&server).await;
        assert_eq!(server.sources.release_requests.load(Ordering::SeqCst), 2);
        assert_eq!(checked["version"], current);
        assert_eq!(checked["latestRelease"]["version"], newer);
        assert_eq!(checked["updateAvailable"], true);
        assert_eq!(checked["updateTask"]["cwd"], "data/caffold-updates");

        // The check is the server's newest answer now.
        assert_eq!(status(&server).await, checked);
        assert_eq!(server.sources.release_requests.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_check_takes_an_answer_that_ended_after_it_arrived() {
        let server = server(FakeSources::new(Ok(&newer())), Some(APP));
        check(&server).await;
        assert_eq!(server.sources.release_requests.load(Ordering::SeqCst), 1);

        // As if a check this request waited for ended after it arrived.
        server
            .routes
            .service
            .release
            .lock()
            .await
            .as_mut()
            .unwrap()
            .checked_at = Instant::now() + Duration::from_secs(1);
        check(&server).await;
        assert_eq!(server.sources.release_requests.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn reports_the_latest_finished_and_the_running_attempt() {
        let server = server(FakeSources::new(Ok(env!("CARGO_PKG_VERSION"))), Some(APP));
        write_attempt(
            &server.data_dir,
            "20261004T100000Z",
            AttemptOutcome::RolledBack,
            1,
        );
        write_attempt(
            &server.data_dir,
            "20261004T110000Z",
            AttemptOutcome::Running,
            2,
        );

        let status = status(&server).await;

        assert_eq!(status["lastAttempt"]["id"], "20261004T100000Z");
        assert_eq!(status["lastAttempt"]["outcome"], "rolledBack");
        assert_eq!(status["lastAttempt"]["reason"], "0.18.3 could not start");
        assert_eq!(status["lastAttempt"]["fromVersion"], "0.18.2");
        assert_eq!(status["lastAttempt"]["toVersion"], "0.18.3");
        assert_eq!(status["lastAttempt"]["startedFromMenuBar"], true);
        assert!(status["lastAttempt"].get("pid").is_none());
        assert_eq!(status["runningAttempt"]["id"], "20261004T110000Z");
        assert_eq!(status["runningAttempt"]["outcome"], "running");
    }

    #[tokio::test]
    async fn leaves_out_an_attempt_whose_process_is_gone() {
        let mut sources = FakeSources::new(Ok(env!("CARGO_PKG_VERSION")));
        sources.alive = false;
        let server = server(sources, Some(APP));
        write_attempt(
            &server.data_dir,
            "20261004T110000Z",
            AttemptOutcome::Running,
            2,
        );

        let status = status(&server).await;

        assert!(status.get("runningAttempt").is_none());
        assert!(status.get("lastAttempt").is_none());
    }

    #[test]
    fn needs_the_update_directory_only_for_the_app() {
        assert_eq!(
            server(FakeSources::new(Ok("0.0.1")), None)
                .routes
                .update_directory(),
            None
        );
        let app_server = server(FakeSources::new(Ok("0.0.1")), Some(APP));
        assert_eq!(
            app_server.routes.update_directory(),
            Some(app_server.data_dir.join(UPDATES_DIRECTORY))
        );
    }

    #[test]
    fn quotes_paths_for_the_shell() {
        assert_eq!(
            update_command(
                Path::new("/Applications/Caffold \"Dev\" $HOME.app"),
                Path::new("/data"),
                5178
            ),
            "\"/Applications/Caffold \\\"Dev\\\" \\$HOME.app/Contents/Resources/caffold\" update --app \"/Applications/Caffold \\\"Dev\\\" \\$HOME.app\" --data-dir \"/data\" --port 5178"
        );
    }

    /// Writes a record where `caffold update` keeps it.
    fn write_attempt(data_dir: &Path, id: &str, outcome: AttemptOutcome, pid: u32) {
        let attempt = Attempt {
            id: id.to_string(),
            started_at: "2026-10-04T10:00:00Z".to_string(),
            finished_at: (outcome != AttemptOutcome::Running)
                .then(|| "2026-10-04T10:02:00Z".to_string()),
            from_version: "0.18.2".to_string(),
            to_version: Some("0.18.3".to_string()),
            started_from_menu_bar: true,
            pid,
            outcome,
            reason: (outcome == AttemptOutcome::RolledBack)
                .then(|| "0.18.3 could not start".to_string()),
        };
        let directory = data_dir.join(UPDATES_DIRECTORY).join("attempts").join(id);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("attempt.json"),
            serde_json::to_vec(&attempt).unwrap(),
        )
        .unwrap();
    }
}
