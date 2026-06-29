use std::{net::IpAddr, path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tracing::info;

use crate::{
    fs::{
        FileResponse, FsError, GitDiffResponse, GitStatusResponse, ListResponse, MAX_FILE_BYTES,
        RootedFs,
    },
    static_assets,
};

#[derive(Debug, Clone)]
pub struct ServeConfig {
    pub host: IpAddr,
    pub port: u16,
    pub root: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    fs: Arc<RootedFs>,
    initial_path: String,
    home_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Debug, Deserialize)]
struct GitDiffQuery {
    #[serde(default)]
    path: String,
    file: String,
    #[serde(default = "default_diff_kind")]
    kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    root: String,
    initial_path: String,
    home_path: Option<String>,
    max_file_bytes: u64,
}

#[derive(Debug, Serialize)]
struct ErrorResponse {
    error: ErrorBody,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

pub async fn serve(config: ServeConfig) -> anyhow::Result<()> {
    let (fs, initial_path, home_path) = match config.root {
        Some(root) => (RootedFs::new(root)?, String::new(), None),
        None => {
            let fs = RootedFs::from_filesystem_root()?;
            let home = RootedFs::home_dir()?;
            let home_path = fs.logical_path_for_absolute(&home)?;
            (fs, home_path.clone(), Some(home_path))
        }
    };
    let root = fs.root().to_path_buf();
    let app = router_with_state(AppState {
        fs: Arc::new(fs),
        initial_path: initial_path.clone(),
        home_path,
    });
    let listener = TcpListener::bind((config.host, config.port)).await?;
    let addr = listener.local_addr()?;

    info!("serving Codger at http://{addr}");
    info!("browsing root {}", root.display());
    info!("initial path {initial_path}");
    println!("Codger is serving http://{addr}");
    println!("Browsing root {}", root.display());
    println!(
        "Initial path {}",
        if initial_path.is_empty() {
            "/"
        } else {
            &initial_path
        }
    );

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    Ok(())
}

pub fn router(fs: RootedFs) -> Router {
    router_with_state(AppState {
        fs: Arc::new(fs),
        initial_path: String::new(),
        home_path: None,
    })
}

fn router_with_state(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/health", get(health))
        .route("/api/list", get(list))
        .route("/api/file", get(file))
        .route("/api/git/status", get(git_status))
        .route("/api/git/diff", get(git_diff))
        .route("/assets/{*path}", get(asset))
        .with_state(state)
}

fn default_diff_kind() -> String {
    "unstaged".to_string()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        use tokio::signal::unix::{SignalKind, signal};

        if let Ok(mut signal) = signal(SignalKind::terminate()) {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

async fn index() -> Html<&'static str> {
    Html(static_assets::INDEX)
}

async fn asset(Path(path): Path<String>) -> Response {
    match static_assets::get(&path) {
        Some(asset) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, asset.content_type)],
            asset.body,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        root: state.fs.root().display().to_string(),
        initial_path: state.initial_path,
        home_path: state.home_path,
        max_file_bytes: MAX_FILE_BYTES,
    })
}

async fn list(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<ListResponse>, ApiError> {
    state.fs.list(&query.path).map(Json).map_err(ApiError::from)
}

async fn file(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<FileResponse>, ApiError> {
    state
        .fs
        .read_file(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_status(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    state
        .fs
        .git_status(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_diff(
    State(state): State<AppState>,
    Query(query): Query<GitDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    state
        .fs
        .git_diff(&query.path, &query.file, &query.kind)
        .map(Json)
        .map_err(ApiError::from)
}

struct ApiError(FsError);

impl From<FsError> for ApiError {
    fn from(error: FsError) -> Self {
        Self(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self.0 {
            FsError::RootUnavailable { path, .. } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "root_unavailable",
                format!("root path is not accessible: {}", path.display()),
            ),
            FsError::RootNotDirectory { path } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "root_not_directory",
                format!("root path is not a directory: {}", path.display()),
            ),
            FsError::PathEscapesRoot => (
                StatusCode::BAD_REQUEST,
                "path_escapes_root",
                "path escapes the browsing root".to_string(),
            ),
            FsError::NotFound { path } => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("path was not found: {path}"),
            ),
            FsError::NotDirectory { path } => (
                StatusCode::BAD_REQUEST,
                "not_directory",
                format!("path is not a directory: {path}"),
            ),
            FsError::IsDirectory { path } => (
                StatusCode::BAD_REQUEST,
                "is_directory",
                format!("path is a directory, not a file: {path}"),
            ),
            FsError::NotFile { path } => (
                StatusCode::BAD_REQUEST,
                "not_file",
                format!("path is not a regular file: {path}"),
            ),
            FsError::FileTooLarge { path, size, limit } => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "file_too_large",
                format!("file is too large: {path} ({size} bytes, limit {limit} bytes)"),
            ),
            FsError::BinaryFile { path } => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "binary_file",
                format!("binary-looking files are not supported: {path}"),
            ),
            FsError::InvalidUtf8 { path } => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_utf8",
                format!("invalid UTF-8 files are not supported: {path}"),
            ),
            FsError::GitRepositoryNotFound { path } => (
                StatusCode::BAD_REQUEST,
                "git_repository_not_found",
                format!("path is not inside a Git repository: {path}"),
            ),
            FsError::GitCommandFailed { action, path } => (
                StatusCode::BAD_REQUEST,
                "git_command_failed",
                format!("git command failed while trying to {action}: {path}"),
            ),
            FsError::Io { action, path, .. } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "filesystem_error",
                format!("filesystem error while trying to {action}: {path}"),
            ),
        };

        (
            status,
            Json(ErrorResponse {
                error: ErrorBody { code, message },
            }),
        )
            .into_response()
    }
}
