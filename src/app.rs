use std::{net::IpAddr, path::PathBuf, sync::Arc};

use axum::{
    Json, Router,
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, patch, post},
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tracing::info;

use crate::{
    fs::{
        FileResponse, FsError, GitCommitResponse, GitCompareResponse, GitDiffResponse,
        GitLogResponse, GitRefsResponse, GitStatusResponse, ListResponse, MAX_FILE_BYTES,
        ProjectRoot, RootedFs,
    },
    project_store::{ProjectRecord, ProjectStore, ProjectStoreError},
    static_assets,
};

#[derive(Debug, Clone)]
pub struct ServeConfig {
    pub host: IpAddr,
    pub port: u16,
    pub root: Option<PathBuf>,
    pub data_dir: Option<PathBuf>,
}

#[derive(Clone)]
struct AppState {
    fs: Arc<RootedFs>,
    projects: ProjectStore,
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

#[derive(Debug, Deserialize)]
struct GitLogQuery {
    #[serde(default)]
    path: String,
    #[serde(default = "default_git_log_page")]
    page: usize,
    #[serde(rename = "perPage")]
    per_page: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GitCommitQuery {
    #[serde(default)]
    path: String,
    sha: String,
}

#[derive(Debug, Deserialize)]
struct GitCommitDiffQuery {
    #[serde(default)]
    path: String,
    sha: String,
    file: String,
}

#[derive(Debug, Deserialize)]
struct GitCompareQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    head: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GitCompareDiffQuery {
    #[serde(default)]
    path: String,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    head: Option<String>,
    file: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectRequest {
    root_path: String,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RenameProjectRequest {
    name: String,
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
#[serde(rename_all = "camelCase")]
struct ProjectListResponse {
    projects: Vec<ProjectResponse>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectResponse {
    id: String,
    name: String,
    root_path: String,
    relative_path: String,
    created_ms: u64,
    updated_ms: u64,
    last_opened_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCandidateResponse {
    candidate: Option<ProjectCandidate>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCandidate {
    name: String,
    root_path: String,
    relative_path: String,
    already_registered: bool,
    project_id: Option<String>,
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
    let data_dir = config.data_dir.unwrap_or(default_data_dir()?);
    let project_store = ProjectStore::redb(data_dir.join("codger.redb"))?;
    let root = fs.root().to_path_buf();
    let app = router_with_state(AppState {
        fs: Arc::new(fs),
        projects: project_store,
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
    println!("Data directory {}", data_dir.display());
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

pub fn router(fs: RootedFs) -> anyhow::Result<Router> {
    Ok(router_with_state(AppState {
        fs: Arc::new(fs),
        projects: ProjectStore::memory()?,
        initial_path: String::new(),
        home_path: None,
    }))
}

fn router_with_state(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/api/health", get(health))
        .route("/api/list", get(list))
        .route("/api/file", get(file))
        .route("/api/image", get(image))
        .route("/api/projects", get(list_projects).post(create_project))
        .route(
            "/api/projects/{id}",
            patch(rename_project).delete(delete_project),
        )
        .route("/api/projects/{id}/open", post(open_project))
        .route("/api/project-candidate", get(project_candidate))
        .route("/api/git/status", get(git_status))
        .route("/api/git/diff", get(git_diff))
        .route("/api/git/log", get(git_log))
        .route("/api/git/commit", get(git_commit))
        .route("/api/git/commit-diff", get(git_commit_diff))
        .route("/api/git/compare", get(git_compare))
        .route("/api/git/compare-diff", get(git_compare_diff))
        .route("/api/git/refs", get(git_refs))
        .route("/assets/{*path}", get(asset))
        .with_state(state)
}

fn default_data_dir() -> anyhow::Result<PathBuf> {
    Ok(RootedFs::home_dir()?.join(".codger"))
}

fn default_diff_kind() -> String {
    "unstaged".to_string()
}

fn default_git_log_page() -> usize {
    1
}

fn default_git_log_per_page() -> usize {
    50
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

async fn asset(AxumPath(path): AxumPath<String>) -> Response {
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

async fn image(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let image = state.fs.read_image(&query.path)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(image.content_type),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    Ok((headers, image.bytes).into_response())
}

async fn list_projects(
    State(state): State<AppState>,
) -> Result<Json<ProjectListResponse>, ApiError> {
    let projects = state
        .projects
        .list_projects()?
        .into_iter()
        .map(|project| project_response(&state.fs, project))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(ProjectListResponse { projects }))
}

async fn project_candidate(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<ProjectCandidateResponse>, ApiError> {
    let candidate = match state.fs.project_candidate_for_path(&query.path)? {
        Some(project_root) => Some(project_candidate_response(&state.projects, project_root)?),
        None => None,
    };

    Ok(Json(ProjectCandidateResponse { candidate }))
}

async fn create_project(
    State(state): State<AppState>,
    Json(request): Json<CreateProjectRequest>,
) -> Result<Json<ProjectResponse>, ApiError> {
    let project_root = state.fs.project_root_for_path(&request.root_path)?;
    let name = request
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .unwrap_or(&project_root.name);
    let project = state
        .projects
        .create_project(name, &project_root.root_path)?;

    Ok(Json(project_response(&state.fs, project)?))
}

async fn rename_project(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<RenameProjectRequest>,
) -> Result<Json<ProjectResponse>, ApiError> {
    let project = state.projects.rename_project(&id, &request.name)?;
    Ok(Json(project_response(&state.fs, project)?))
}

async fn delete_project(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, ApiError> {
    state.projects.delete_project(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn open_project(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProjectResponse>, ApiError> {
    let project = state.projects.open_project(&id)?;
    Ok(Json(project_response(&state.fs, project)?))
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

async fn git_log(
    State(state): State<AppState>,
    Query(query): Query<GitLogQuery>,
) -> Result<Json<GitLogResponse>, ApiError> {
    let per_page = query
        .per_page
        .or(query.limit)
        .unwrap_or_else(default_git_log_per_page);
    state
        .fs
        .git_log(&query.path, query.page, per_page)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_commit(
    State(state): State<AppState>,
    Query(query): Query<GitCommitQuery>,
) -> Result<Json<GitCommitResponse>, ApiError> {
    state
        .fs
        .git_commit(&query.path, &query.sha)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_commit_diff(
    State(state): State<AppState>,
    Query(query): Query<GitCommitDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    state
        .fs
        .git_commit_diff(&query.path, &query.sha, &query.file)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_compare(
    State(state): State<AppState>,
    Query(query): Query<GitCompareQuery>,
) -> Result<Json<GitCompareResponse>, ApiError> {
    state
        .fs
        .git_compare(&query.path, query.base.as_deref(), query.head.as_deref())
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_compare_diff(
    State(state): State<AppState>,
    Query(query): Query<GitCompareDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    state
        .fs
        .git_compare_diff(
            &query.path,
            query.base.as_deref(),
            query.head.as_deref(),
            &query.file,
        )
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_refs(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GitRefsResponse>, ApiError> {
    state
        .fs
        .git_refs(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

fn project_candidate_response(
    store: &ProjectStore,
    project_root: ProjectRoot,
) -> Result<ProjectCandidate, ProjectStoreError> {
    let registered = store.find_by_root_path(&project_root.root_path)?;

    Ok(ProjectCandidate {
        name: registered
            .as_ref()
            .map(|project| project.name.clone())
            .unwrap_or(project_root.name),
        root_path: project_root.root_path,
        relative_path: project_root.relative_path,
        already_registered: registered.is_some(),
        project_id: registered.map(|project| project.id),
    })
}

fn project_response(fs: &RootedFs, project: ProjectRecord) -> Result<ProjectResponse, FsError> {
    Ok(ProjectResponse {
        id: project.id,
        name: project.name,
        relative_path: fs.logical_path_for_absolute(std::path::Path::new(&project.root_path))?,
        root_path: project.root_path,
        created_ms: project.created_ms,
        updated_ms: project.updated_ms,
        last_opened_ms: project.last_opened_ms,
    })
}

enum ApiError {
    Fs(FsError),
    Project(ProjectStoreError),
}

impl From<FsError> for ApiError {
    fn from(error: FsError) -> Self {
        Self::Fs(error)
    }
}

impl From<ProjectStoreError> for ApiError {
    fn from(error: ProjectStoreError) -> Self {
        Self::Project(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message) = match self {
            ApiError::Fs(FsError::RootUnavailable { path, .. }) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "root_unavailable",
                format!("root path is not accessible: {}", path.display()),
            ),
            ApiError::Fs(FsError::RootNotDirectory { path }) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "root_not_directory",
                format!("root path is not a directory: {}", path.display()),
            ),
            ApiError::Fs(FsError::PathEscapesRoot) => (
                StatusCode::BAD_REQUEST,
                "path_escapes_root",
                "path escapes the browsing root".to_string(),
            ),
            ApiError::Fs(FsError::NotFound { path }) => (
                StatusCode::NOT_FOUND,
                "not_found",
                format!("path was not found: {path}"),
            ),
            ApiError::Fs(FsError::NotDirectory { path }) => (
                StatusCode::BAD_REQUEST,
                "not_directory",
                format!("path is not a directory: {path}"),
            ),
            ApiError::Fs(FsError::IsDirectory { path }) => (
                StatusCode::BAD_REQUEST,
                "is_directory",
                format!("path is a directory, not a file: {path}"),
            ),
            ApiError::Fs(FsError::NotFile { path }) => (
                StatusCode::BAD_REQUEST,
                "not_file",
                format!("path is not a regular file: {path}"),
            ),
            ApiError::Fs(FsError::FileTooLarge { path, size, limit }) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "file_too_large",
                format!("file is too large: {path} ({size} bytes, limit {limit} bytes)"),
            ),
            ApiError::Fs(FsError::BinaryFile { path }) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "binary_file",
                format!("binary-looking files are not supported: {path}"),
            ),
            ApiError::Fs(FsError::InvalidUtf8 { path }) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "invalid_utf8",
                format!("invalid UTF-8 files are not supported: {path}"),
            ),
            ApiError::Fs(FsError::UnsupportedImage { path }) => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "unsupported_image",
                format!("image preview is not supported for this file type: {path}"),
            ),
            ApiError::Fs(FsError::GitRepositoryNotFound { path }) => (
                StatusCode::BAD_REQUEST,
                "git_repository_not_found",
                format!("path is not inside a Git repository: {path}"),
            ),
            ApiError::Fs(FsError::GitCommandFailed { action, path }) => (
                StatusCode::BAD_REQUEST,
                "git_command_failed",
                format!("git command failed while trying to {action}: {path}"),
            ),
            ApiError::Fs(FsError::Io { action, path, .. }) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "filesystem_error",
                format!("filesystem error while trying to {action}: {path}"),
            ),
            ApiError::Project(ProjectStoreError::NotFound(id)) => (
                StatusCode::NOT_FOUND,
                "project_not_found",
                format!("project was not found: {id}"),
            ),
            ApiError::Project(ProjectStoreError::EmptyName) => (
                StatusCode::BAD_REQUEST,
                "empty_project_name",
                "project name cannot be empty".to_string(),
            ),
            ApiError::Project(ProjectStoreError::UnexpectedPayload)
            | ApiError::Project(ProjectStoreError::InvalidRow(_))
            | ApiError::Project(ProjectStoreError::Poisoned)
            | ApiError::Project(ProjectStoreError::Glue(_))
            | ApiError::Project(ProjectStoreError::Io(_)) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "project_store_error",
                "project store failed".to_string(),
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
