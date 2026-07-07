use std::{
    collections::HashMap,
    convert::Infallible,
    net::IpAddr,
    path::{Path, PathBuf},
    sync::Arc,
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, patch, post},
};
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use tracing::info;

use crate::{
    codex_app_server::{
        self, CodexRuntimeEvent, CodexStatusResponse, CodexThreadClient, CodexTurnOptions,
    },
    fs::{
        FileResponse, FsError, GitCommitResponse, GitCompareResponse, GitDiffResponse,
        GitLogResponse, GitRefsResponse, GitStatusResponse, GithubIssueResponse,
        GithubIssuesResponse, GithubPullFileResponse, GithubPullFilesResponse, GithubPullResponse,
        GithubPullsResponse, GithubStatusResponse, ListResponse, MAX_FILE_BYTES, ProjectRoot,
        RootedFs,
    },
    project_store::{ProjectRecord, ProjectStore, ProjectStoreError},
    static_assets,
};

const TASK_DETAIL_TURNS_PAGE_SIZE: usize = 8;

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
    codex_threads: Arc<CodexThreadRuntime>,
    pending_approvals: Arc<AsyncMutex<HashMap<String, PendingApproval>>>,
    task_events: broadcast::Sender<TaskEventRecord>,
    shutdown: broadcast::Sender<()>,
    initial_path: String,
    home_path: Option<String>,
}

#[derive(Default)]
struct CodexThreadRuntime {
    state: AsyncMutex<CodexThreadRuntimeState>,
}

#[derive(Default)]
struct CodexThreadRuntimeState {
    client: Option<CodexThreadClient>,
}

impl CodexThreadRuntime {
    async fn shutdown(&self) {
        let client = self.state.lock().await.client.take();
        if let Some(client) = client {
            client.shutdown().await;
        }
    }
}

#[derive(Debug, Clone)]
struct PendingApproval {
    thread_id: String,
    project_id: String,
    request_id: JsonValue,
    method: String,
    params: JsonValue,
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
struct GithubIssuesQuery {
    #[serde(default)]
    path: String,
    #[serde(default = "default_github_issue_state")]
    state: String,
    #[serde(default = "default_github_issues_page")]
    page: usize,
    #[serde(rename = "perPage")]
    per_page: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GithubIssueQuery {
    #[serde(default)]
    path: String,
    number: u64,
}

#[derive(Debug, Deserialize)]
struct GithubPullsQuery {
    #[serde(default)]
    path: String,
    #[serde(default = "default_github_issue_state")]
    state: String,
    #[serde(default = "default_github_issues_page")]
    page: usize,
    #[serde(rename = "perPage")]
    per_page: Option<usize>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct GithubPullQuery {
    #[serde(default)]
    path: String,
    number: u64,
}

#[derive(Debug, Deserialize)]
struct GithubPullFileQuery {
    #[serde(default)]
    path: String,
    number: u64,
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TasksQuery {
    project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDetailQuery {
    project_id: String,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTaskRequest {
    project_id: String,
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskPromptRequest {
    prompt: String,
    model: Option<String>,
    effort: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TaskApprovalRequest {
    decision: String,
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
#[serde(rename_all = "camelCase")]
struct TaskListResponse {
    tasks: Vec<TaskRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TaskRecord {
    id: String,
    thread_id: String,
    project_id: String,
    title: String,
    preview: String,
    status: String,
    cwd: String,
    relative_cwd: String,
    created_ms: u64,
    updated_ms: u64,
    recency_ms: Option<u64>,
    active_turn_id: Option<String>,
    last_event_summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TaskEventRecord {
    id: String,
    thread_id: String,
    project_id: String,
    #[serde(rename = "type")]
    event_type: String,
    summary: String,
    payload: Option<JsonValue>,
    created_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskDetailResponse {
    task: TaskRecord,
    events: Vec<TaskEventRecord>,
    events_page: TaskEventsPage,
    pending_approvals: Vec<TaskEventRecord>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskEventsPage {
    next_cursor: Option<String>,
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
    let project_store = ProjectStore::redb(data_dir.join("caffold.redb"))?;
    let (task_events, _) = broadcast::channel(256);
    let (shutdown, _) = broadcast::channel(16);
    let pending_approvals = Arc::new(AsyncMutex::new(HashMap::new()));
    let codex_threads = Arc::new(CodexThreadRuntime::default());
    let root = fs.root().to_path_buf();
    let app = router_with_state(AppState {
        fs: Arc::new(fs),
        projects: project_store,
        codex_threads: codex_threads.clone(),
        pending_approvals,
        task_events,
        shutdown: shutdown.clone(),
        initial_path: initial_path.clone(),
        home_path,
    });
    let listener = TcpListener::bind((config.host, config.port)).await?;
    let addr = listener.local_addr()?;

    info!("serving Caffold at http://{addr}");
    info!("browsing root {}", root.display());
    info!("initial path {initial_path}");
    println!("Caffold is serving http://{addr}");
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

    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(shutdown))
        .await;
    codex_threads.shutdown().await;
    result?;

    Ok(())
}

pub fn router(fs: RootedFs) -> anyhow::Result<Router> {
    let (task_events, _) = broadcast::channel(256);
    let (shutdown, _) = broadcast::channel(16);
    Ok(router_with_state(AppState {
        fs: Arc::new(fs),
        projects: ProjectStore::memory()?,
        codex_threads: Arc::new(CodexThreadRuntime::default()),
        pending_approvals: Arc::new(AsyncMutex::new(HashMap::new())),
        task_events,
        shutdown,
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
        .route("/api/github/status", get(github_status))
        .route("/api/github/issues", get(github_issues))
        .route("/api/github/issue", get(github_issue))
        .route("/api/github/pulls", get(github_pulls))
        .route("/api/github/pull", get(github_pull))
        .route("/api/github/pull-files", get(github_pull_files))
        .route("/api/github/pull-file", get(github_pull_file))
        .route("/api/codex/status", get(codex_status))
        .route("/api/codex/models", get(codex_models))
        .route("/api/tasks", get(list_tasks).post(create_task))
        .route("/api/tasks/{thread_id}", get(task_detail))
        .route("/api/tasks/{thread_id}/stream", get(task_stream))
        .route("/api/tasks/{thread_id}/prompts", post(task_prompt))
        .route("/api/tasks/{thread_id}/interrupt", post(task_interrupt))
        .route(
            "/api/tasks/{thread_id}/approvals/{approval_id}",
            post(task_approval),
        )
        .route("/service-worker.js", get(service_worker))
        .route("/assets/{*path}", get(asset))
        .route("/projects", get(index))
        .route("/projects/{*path}", get(index))
        .with_state(state)
}

fn default_data_dir() -> anyhow::Result<PathBuf> {
    Ok(RootedFs::home_dir()?.join(".caffold"))
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

fn default_github_issue_state() -> String {
    "open".to_string()
}

fn default_github_issues_page() -> usize {
    1
}

fn default_github_issues_per_page() -> usize {
    50
}

async fn shutdown_signal(shutdown: broadcast::Sender<()>) {
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
    let _ = shutdown.send(());
}

async fn index() -> Html<&'static str> {
    Html(static_assets::INDEX)
}

async fn service_worker() -> Response {
    match static_assets::get("service-worker.js") {
        Some(asset) => {
            let mut response = Response::new(Body::from(asset.body));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            response.headers_mut().insert(
                HeaderName::from_static("service-worker-allowed"),
                HeaderValue::from_static("/"),
            );
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn asset(AxumPath(path): AxumPath<String>) -> Response {
    match static_assets::get(&path) {
        Some(asset) => {
            let mut response = Response::new(Body::from(asset.body));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            );
            response
        }
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

async fn github_status(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GithubStatusResponse>, ApiError> {
    state
        .fs
        .github_status(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_issues(
    State(state): State<AppState>,
    Query(query): Query<GithubIssuesQuery>,
) -> Result<Json<GithubIssuesResponse>, ApiError> {
    let per_page = query
        .per_page
        .or(query.limit)
        .unwrap_or_else(default_github_issues_per_page);
    state
        .fs
        .github_issues(&query.path, &query.state, query.page, per_page)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_issue(
    State(state): State<AppState>,
    Query(query): Query<GithubIssueQuery>,
) -> Result<Json<GithubIssueResponse>, ApiError> {
    state
        .fs
        .github_issue(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pulls(
    State(state): State<AppState>,
    Query(query): Query<GithubPullsQuery>,
) -> Result<Json<GithubPullsResponse>, ApiError> {
    let per_page = query
        .per_page
        .or(query.limit)
        .unwrap_or_else(default_github_issues_per_page);
    state
        .fs
        .github_pulls(&query.path, &query.state, query.page, per_page)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pull(
    State(state): State<AppState>,
    Query(query): Query<GithubPullQuery>,
) -> Result<Json<GithubPullResponse>, ApiError> {
    state
        .fs
        .github_pull(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pull_files(
    State(state): State<AppState>,
    Query(query): Query<GithubPullQuery>,
) -> Result<Json<GithubPullFilesResponse>, ApiError> {
    state
        .fs
        .github_pull_files(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pull_file(
    State(state): State<AppState>,
    Query(query): Query<GithubPullFileQuery>,
) -> Result<Json<GithubPullFileResponse>, ApiError> {
    state
        .fs
        .github_pull_file(&query.path, query.number, &query.file)
        .map(Json)
        .map_err(ApiError::from)
}

async fn codex_status() -> Json<CodexStatusResponse> {
    Json(codex_app_server::status().await)
}

async fn codex_models(State(state): State<AppState>) -> Result<Json<JsonValue>, ApiError> {
    let client = require_codex_thread_client(&state).await?;
    client
        .list_models(100)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

async fn list_tasks(
    State(state): State<AppState>,
    Query(query): Query<TasksQuery>,
) -> Result<Json<TaskListResponse>, ApiError> {
    let project = state.projects.get_project(&query.project_id)?;
    let client = require_codex_thread_client(&state).await?;
    let response = client.list_threads(100).await?;
    let tasks = thread_list_response(&project, &response);
    Ok(Json(TaskListResponse { tasks }))
}

async fn create_task(
    State(state): State<AppState>,
    Json(request): Json<CreateTaskRequest>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let project = state.projects.get_project(&request.project_id)?;
    let prompt = normalize_prompt(&request.prompt)?;
    let cwd = project_task_cwd(&project, request.cwd.as_deref())?;
    let turn_options = codex_turn_options(request.model, request.effort)?;
    let client = require_codex_thread_client(&state).await?;

    let thread = client.start_thread(&cwd).await?;
    let _turn = client
        .start_turn(&thread.thread_id, &cwd, prompt, turn_options)
        .await?;
    Ok(Json(
        read_task_detail(&state, &client, &project, &thread.thread_id, None).await?,
    ))
}

async fn task_detail(
    State(state): State<AppState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<TaskDetailQuery>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let project = state.projects.get_project(&query.project_id)?;
    let client = require_codex_thread_client(&state).await?;
    Ok(Json(
        read_task_detail(
            &state,
            &client,
            &project,
            &thread_id,
            query.cursor.as_deref(),
        )
        .await?,
    ))
}

async fn task_stream(
    State(state): State<AppState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<TasksQuery>,
) -> Result<Response, ApiError> {
    let project = state.projects.get_project(&query.project_id)?;
    // Validate route ownership once before subscribing. The stream itself is
    // ephemeral and only forwards live app-server events.
    let client = require_codex_thread_client(&state).await?;
    validate_thread_belongs_to_project(&project, &thread_id, &client).await?;
    let receiver = state.task_events.subscribe();
    let shutdown = state.shutdown.subscribe();
    let stream = stream::unfold(
        (receiver, shutdown, thread_id),
        |(mut receiver, mut shutdown, thread_id)| async move {
            loop {
                tokio::select! {
                    _ = shutdown.recv() => return None,
                    message = receiver.recv() => {
                        match message {
                            Ok(event) if event.thread_id == thread_id => {
                                let payload = serde_json::to_string(&event)
                                    .unwrap_or_else(|_| "{}".to_string());
                                let frame = format!("event: task-event\ndata: {payload}\n\n");
                                return Some((
                                    Ok::<_, Infallible>(Bytes::from(frame)),
                                    (receiver, shutdown, thread_id),
                                ));
                            }
                            Ok(_) => continue,
                            Err(broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(broadcast::error::RecvError::Closed) => return None,
                        }
                    }
                }
            }
        },
    );

    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(response)
}

async fn task_prompt(
    State(state): State<AppState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<TasksQuery>,
    Json(request): Json<TaskPromptRequest>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let project = state.projects.get_project(&query.project_id)?;
    let prompt = normalize_prompt(&request.prompt)?;
    let turn_options = codex_turn_options(request.model, request.effort)?;
    let client = require_codex_thread_client(&state).await?;
    let thread = client.read_thread(&thread_id, false).await?;
    let thread_value = thread.get("thread").unwrap_or(&thread);
    ensure_thread_belongs_to_project(&project, thread_value)?;
    let cwd = thread_value
        .get("cwd")
        .and_then(JsonValue::as_str)
        .unwrap_or(&project.root_path);
    client.resume_thread(&thread_id, cwd).await?;
    client
        .start_turn(&thread_id, cwd, prompt, turn_options)
        .await?;
    Ok(Json(
        read_task_detail(&state, &client, &project, &thread_id, None).await?,
    ))
}

async fn task_interrupt(
    State(state): State<AppState>,
    AxumPath(thread_id): AxumPath<String>,
    Query(query): Query<TasksQuery>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let project = state.projects.get_project(&query.project_id)?;
    let client = require_codex_thread_client(&state).await?;
    let thread = client.read_thread(&thread_id, false).await?;
    let thread_value = thread.get("thread").unwrap_or(&thread);
    ensure_thread_belongs_to_project(&project, thread_value)?;
    let turns_response = client
        .list_thread_turns(&thread_id, None, TASK_DETAIL_TURNS_PAGE_SIZE)
        .await?;
    let mut turns = turns_response
        .get("data")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    turns.reverse();
    let thread_value = thread_with_turns(thread_value, turns)?;
    let Some(turn_id) = active_turn_id(&thread_value) else {
        return Err(ApiError::BadRequest {
            code: "task_turn_missing",
            message: "thread does not have an active turn to interrupt".to_string(),
        });
    };
    client.interrupt_turn(&thread_id, &turn_id).await?;
    Ok(Json(
        read_task_detail(&state, &client, &project, &thread_id, None).await?,
    ))
}

async fn task_approval(
    State(state): State<AppState>,
    AxumPath((thread_id, approval_id)): AxumPath<(String, String)>,
    Query(query): Query<TasksQuery>,
    Json(request): Json<TaskApprovalRequest>,
) -> Result<Json<TaskDetailResponse>, ApiError> {
    let project = state.projects.get_project(&query.project_id)?;
    let pending = {
        let approvals = state.pending_approvals.lock().await;
        let Some(pending) = approvals.get(&approval_id).cloned() else {
            return Err(ApiError::BadRequest {
                code: "approval_not_found",
                message: "approval request is no longer pending".to_string(),
            });
        };
        pending
    };
    if pending.thread_id != thread_id {
        return Err(ApiError::BadRequest {
            code: "approval_task_mismatch",
            message: "approval request belongs to another thread".to_string(),
        });
    }
    if !pending.project_id.is_empty() && pending.project_id != query.project_id {
        return Err(ApiError::BadRequest {
            code: "approval_project_mismatch",
            message: "approval request belongs to another project".to_string(),
        });
    }

    let client = require_codex_thread_client(&state).await?;
    let decision = normalize_approval_decision(&request.decision)?;
    client
        .respond_to_server_request(pending.request_id.clone(), json!({ "decision": decision }))
        .await?;
    {
        let mut approvals = state.pending_approvals.lock().await;
        approvals.remove(&approval_id);
    }

    let event = task_event_record(
        &pending.thread_id,
        &pending.project_id,
        &format!("approval_resolved:{approval_id}"),
        "approval_resolved",
        &format!("Approval resolved: {decision}"),
        Some(json!({
            "approvalId": approval_id,
            "method": pending.method,
            "decision": decision
        })),
        now_ms(),
    );
    let _ = state.task_events.send(event);

    Ok(Json(
        read_task_detail(&state, &client, &project, &thread_id, None).await?,
    ))
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

async fn require_codex_thread_client(state: &AppState) -> Result<CodexThreadClient, ApiError> {
    {
        let runtime = state.codex_threads.state.lock().await;
        if let Some(client) = runtime.client.clone() {
            return Ok(client);
        }
    }

    let mut runtime = state.codex_threads.state.lock().await;
    if let Some(client) = runtime.client.clone() {
        return Ok(client);
    }

    match CodexThreadClient::start().await {
        Ok(client) => {
            spawn_codex_thread_bridge(
                state.projects.clone(),
                client.clone(),
                state.task_events.clone(),
                state.pending_approvals.clone(),
                state.shutdown.subscribe(),
            );
            runtime.client = Some(client.clone());
            Ok(client)
        }
        Err(error) => {
            let message = error.to_string();
            Err(ApiError::CodexThread(message))
        }
    }
}

async fn read_task_detail(
    state: &AppState,
    client: &CodexThreadClient,
    project: &ProjectRecord,
    thread_id: &str,
    cursor: Option<&str>,
) -> Result<TaskDetailResponse, ApiError> {
    let response = client.read_thread(thread_id, false).await?;
    let thread = response.get("thread").unwrap_or(&response);
    ensure_thread_belongs_to_project(project, thread)?;
    let turns_response = client
        .list_thread_turns(thread_id, cursor, TASK_DETAIL_TURNS_PAGE_SIZE)
        .await?;
    let mut turns = turns_response
        .get("data")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    turns.reverse();
    let next_cursor = turns_response
        .get("nextCursor")
        .and_then(JsonValue::as_str)
        .map(ToOwned::to_owned);
    let thread = thread_with_turns(thread, turns)?;
    let mut events = thread_events(project, &thread);
    let pending_approvals = pending_approval_events(state, thread_id).await;
    events.extend(pending_approvals.iter().cloned());
    events.sort_by(|left, right| {
        left.created_ms
            .cmp(&right.created_ms)
            .then_with(|| left.id.cmp(&right.id))
    });
    let task = task_record_from_thread(project, &thread, &events)?;
    Ok(TaskDetailResponse {
        task,
        events,
        events_page: TaskEventsPage { next_cursor },
        pending_approvals,
    })
}

fn thread_with_turns(thread: &JsonValue, turns: Vec<JsonValue>) -> Result<JsonValue, ApiError> {
    let mut thread = thread.clone();
    let Some(object) = thread.as_object_mut() else {
        return Err(ApiError::CodexThread(
            "thread/read response did not include a thread object".to_string(),
        ));
    };
    object.insert("turns".to_string(), JsonValue::Array(turns));
    Ok(thread)
}

async fn validate_thread_belongs_to_project(
    project: &ProjectRecord,
    thread_id: &str,
    client: &CodexThreadClient,
) -> Result<(), ApiError> {
    let response = client.read_thread(thread_id, false).await?;
    let thread = response.get("thread").unwrap_or(&response);
    ensure_thread_belongs_to_project(project, thread)
}

fn thread_list_response(project: &ProjectRecord, response: &JsonValue) -> Vec<TaskRecord> {
    let mut tasks = response
        .get("data")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter(|thread| thread_belongs_to_project(project, thread))
        .filter_map(|thread| task_record_from_thread(project, thread, &[]).ok())
        .collect::<Vec<_>>();
    tasks.sort_by(|left, right| {
        right
            .recency_ms
            .unwrap_or(right.updated_ms)
            .cmp(&left.recency_ms.unwrap_or(left.updated_ms))
            .then_with(|| right.updated_ms.cmp(&left.updated_ms))
    });
    tasks
}

fn task_record_from_thread(
    project: &ProjectRecord,
    thread: &JsonValue,
    events: &[TaskEventRecord],
) -> Result<TaskRecord, ApiError> {
    let thread_id = thread_id(thread).ok_or_else(|| ApiError::BadRequest {
        code: "thread_id_missing",
        message: "Codex thread did not include an id".to_string(),
    })?;
    let cwd = thread_cwd(thread).unwrap_or(&project.root_path).to_string();
    let title = non_empty_string(thread.get("name").and_then(JsonValue::as_str))
        .or_else(|| non_empty_string(thread.get("preview").and_then(JsonValue::as_str)))
        .unwrap_or_else(|| format!("Thread {}", short_thread_id(thread_id)));
    let preview = thread
        .get("preview")
        .and_then(JsonValue::as_str)
        .unwrap_or("")
        .to_string();
    let active_turn_id = active_turn_id(thread);
    let has_pending_approval = events
        .iter()
        .any(|event| event.event_type == "approval_requested");
    let status = if has_pending_approval {
        "waiting_for_approval".to_string()
    } else if active_turn_id.is_some() {
        "running".to_string()
    } else {
        thread_status(thread)
    };
    let last_event_summary = events
        .last()
        .map(|event| event.summary.clone())
        .or_else(|| non_empty_string(Some(&preview)));
    Ok(TaskRecord {
        id: thread_id.to_string(),
        thread_id: thread_id.to_string(),
        project_id: project.id.clone(),
        title,
        preview,
        status,
        relative_cwd: relative_cwd(project, &cwd),
        cwd,
        created_ms: seconds_to_ms(thread.get("createdAt").and_then(JsonValue::as_f64)),
        updated_ms: seconds_to_ms(thread.get("updatedAt").and_then(JsonValue::as_f64)),
        recency_ms: thread
            .get("recencyAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value),
        active_turn_id,
        last_event_summary,
    })
}

fn thread_events(project: &ProjectRecord, thread: &JsonValue) -> Vec<TaskEventRecord> {
    let Some(thread_id) = thread_id(thread) else {
        return Vec::new();
    };
    let mut events = Vec::new();
    let created_ms = seconds_to_ms(thread.get("createdAt").and_then(JsonValue::as_f64));
    for turn in thread
        .get("turns")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
    {
        let turn_id = turn.get("id").and_then(JsonValue::as_str).unwrap_or("turn");
        let started_ms = turn
            .get("startedAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value)
            .unwrap_or(created_ms);
        events.push(task_event_record(
            thread_id,
            &project.id,
            &format!("{turn_id}:started"),
            "turn_started",
            "Turn started",
            Some(json!({ "threadId": thread_id, "turnId": turn_id })),
            started_ms,
        ));
        for item in turn
            .get("items")
            .and_then(JsonValue::as_array)
            .into_iter()
            .flatten()
        {
            let params = json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "item": item
            });
            if let Some(event) =
                task_event_from_thread_item(thread_id, &project.id, started_ms, &params)
            {
                events.push(event);
            }
        }
        if let Some(completed_ms) = turn
            .get("completedAt")
            .and_then(JsonValue::as_f64)
            .map(seconds_to_ms_value)
        {
            let status = turn
                .get("status")
                .and_then(JsonValue::as_str)
                .unwrap_or("completed");
            let summary = match status {
                "failed" => "Turn failed",
                "interrupted" => "Turn interrupted",
                "completed" => "Turn completed",
                _ => "Turn updated",
            };
            events.push(task_event_record(
                thread_id,
                &project.id,
                &format!("{turn_id}:completed"),
                "turn_completed",
                summary,
                Some(json!({ "threadId": thread_id, "turnId": turn_id, "status": status })),
                completed_ms,
            ));
        }
    }
    events
}

async fn pending_approval_events(state: &AppState, thread_id: &str) -> Vec<TaskEventRecord> {
    state
        .pending_approvals
        .lock()
        .await
        .iter()
        .filter(|(_, pending)| pending.thread_id == thread_id)
        .map(|(approval_id, pending)| {
            let kind = if pending.method == "item/commandExecution/requestApproval" {
                "command"
            } else {
                "file_change"
            };
            task_event_record(
                &pending.thread_id,
                &pending.project_id,
                &format!("approval_requested:{approval_id}"),
                "approval_requested",
                if kind == "command" {
                    "Command approval requested"
                } else {
                    "File change approval requested"
                },
                Some(json!({
                    "approvalId": approval_id,
                    "kind": kind,
                    "method": pending.method,
                    "params": pending.params
                })),
                now_ms(),
            )
        })
        .collect()
}

fn task_event_record(
    thread_id: &str,
    project_id: &str,
    event_id: &str,
    event_type: &str,
    summary: &str,
    payload: Option<JsonValue>,
    created_ms: u64,
) -> TaskEventRecord {
    TaskEventRecord {
        id: format!("{thread_id}:{event_id}"),
        thread_id: thread_id.to_string(),
        project_id: project_id.to_string(),
        event_type: event_type.to_string(),
        summary: summary.to_string(),
        payload,
        created_ms,
    }
}

fn spawn_codex_thread_bridge(
    projects: ProjectStore,
    client: CodexThreadClient,
    task_events: broadcast::Sender<TaskEventRecord>,
    pending_approvals: Arc<AsyncMutex<HashMap<String, PendingApproval>>>,
    mut shutdown: broadcast::Receiver<()>,
) {
    tokio::spawn(async move {
        let mut receiver = client.subscribe();
        loop {
            tokio::select! {
                _ = shutdown.recv() => break,
                event = receiver.recv() => {
                    let Ok(event) = event else {
                        break;
                    };
                    match event {
                        CodexRuntimeEvent::Notification { method, params } => {
                            handle_codex_notification(&task_events, &method, params);
                        }
                        CodexRuntimeEvent::ServerRequest { id, method, params } => {
                            handle_codex_server_request(
                                &projects,
                                &task_events,
                                &pending_approvals,
                                id,
                                &method,
                                params,
                            )
                            .await;
                        }
                        CodexRuntimeEvent::Error { .. } => {}
                    }
                }
            }
        }
    });
}

fn handle_codex_notification(
    task_events: &broadcast::Sender<TaskEventRecord>,
    method: &str,
    params: JsonValue,
) {
    let Some(thread_id) = codex_thread_id(method, &params) else {
        return;
    };
    match method {
        "item/completed" => {
            if let Some(event) = task_event_from_thread_item(&thread_id, "", now_ms(), &params) {
                let _ = task_events.send(event);
            }
        }
        "rawResponseItem/completed" => {
            if let Some(event) =
                task_event_from_raw_response_item(&thread_id, "", now_ms(), &params)
            {
                let _ = task_events.send(event);
            }
        }
        "turn/completed" => {
            let status = params
                .pointer("/turn/status")
                .and_then(JsonValue::as_str)
                .unwrap_or("completed");
            let task_status = match status {
                "failed" => "failed",
                "interrupted" => "interrupted",
                "completed" => "completed",
                _ => "running",
            };
            let summary = match task_status {
                "failed" => "Turn failed",
                "interrupted" => "Turn interrupted",
                "completed" => "Turn completed",
                _ => "Turn updated",
            };
            let event = task_event_record(
                &thread_id,
                "",
                &event_id_from_params("turn_completed", &params),
                "turn_completed",
                summary,
                Some(params),
                now_ms(),
            );
            let _ = task_events.send(event);
        }
        "turn/diff/updated" => {
            let event = task_event_record(
                &thread_id,
                "",
                "diff_updated",
                "diff_updated",
                "Diff updated",
                None,
                now_ms(),
            );
            let _ = task_events.send(event);
        }
        _ => {}
    }
}

fn task_event_from_thread_item(
    thread_id: &str,
    project_id: &str,
    created_ms: u64,
    params: &JsonValue,
) -> Option<TaskEventRecord> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let turn_id = params.get("turnId").and_then(JsonValue::as_str);
    let item_id = item.get("id").and_then(JsonValue::as_str);

    let (event_type, summary, payload) = match item_type {
        "userMessage" => {
            let text = user_message_text(item)?;
            (
                "user_message",
                "User prompt".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "text": text,
                    "item": item,
                }),
            )
        }
        "agentMessage" => {
            let text = non_empty_string(item.get("text").and_then(JsonValue::as_str))?;
            (
                "assistant_message",
                "Assistant response".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "phase": item.get("phase").and_then(JsonValue::as_str),
                    "text": text,
                    "item": item,
                }),
            )
        }
        "reasoning" => {
            let summary = string_array(item.get("summary"));
            let content = string_array(item.get("content"));
            if summary.is_empty() && content.is_empty() {
                return None;
            }
            (
                "reasoning",
                reasoning_event_summary(&summary, &content),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "summary": summary,
                    "content": content,
                    "item": item,
                }),
            )
        }
        "plan" => {
            let text = non_empty_string(item.get("text").and_then(JsonValue::as_str))?;
            (
                "plan",
                "Plan updated".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "text": text,
                    "item": item,
                }),
            )
        }
        "commandExecution" => (
            "command_execution",
            command_execution_summary(item),
            json!({
                "threadId": thread_id,
                "turnId": turn_id,
                "itemId": item_id,
                "command": item.get("command").and_then(JsonValue::as_str),
                "cwd": item.get("cwd").and_then(JsonValue::as_str),
                "status": item.get("status").and_then(JsonValue::as_str),
                "aggregatedOutput": item.get("aggregatedOutput").and_then(JsonValue::as_str),
                "exitCode": item.get("exitCode"),
                "durationMs": item.get("durationMs"),
                "item": item,
            }),
        ),
        "fileChange" => {
            let change_count = item
                .get("changes")
                .and_then(JsonValue::as_array)
                .map(Vec::len)
                .unwrap_or(0);
            (
                "file_change",
                format!("File changes: {change_count}"),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "changeCount": change_count,
                    "status": item.get("status").and_then(JsonValue::as_str),
                    "changes": item.get("changes"),
                    "item": item,
                }),
            )
        }
        _ => return None,
    };
    Some(task_event_record(
        thread_id,
        project_id,
        item_id.unwrap_or(event_type),
        event_type,
        &summary,
        Some(payload),
        created_ms,
    ))
}

fn task_event_from_raw_response_item(
    thread_id: &str,
    project_id: &str,
    created_ms: u64,
    params: &JsonValue,
) -> Option<TaskEventRecord> {
    let item = params.get("item")?;
    let item_type = item.get("type").and_then(JsonValue::as_str)?;
    let turn_id = params.get("turnId").and_then(JsonValue::as_str);
    let item_id = item.get("id").and_then(JsonValue::as_str);

    let (event_type, summary, payload) = match item_type {
        "message" => {
            let role = item.get("role").and_then(JsonValue::as_str).unwrap_or("");
            if role != "assistant" {
                return None;
            }
            let text = response_content_text(item.get("content"))?;
            (
                "assistant_message",
                "Assistant response".to_string(),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "phase": item.get("phase").and_then(JsonValue::as_str),
                    "text": text,
                    "item": item,
                }),
            )
        }
        "reasoning" => {
            let summary = reasoning_response_summary(item.get("summary"));
            let content = reasoning_response_content(item.get("content"));
            if summary.is_empty() && content.is_empty() {
                return None;
            }
            (
                "reasoning",
                reasoning_event_summary(&summary, &content),
                json!({
                    "threadId": thread_id,
                    "turnId": turn_id,
                    "itemId": item_id,
                    "summary": summary,
                    "content": content,
                    "item": item,
                }),
            )
        }
        _ => return None,
    };
    Some(task_event_record(
        thread_id,
        project_id,
        item_id.unwrap_or(event_type),
        event_type,
        &summary,
        Some(payload),
        created_ms,
    ))
}

fn user_message_text(item: &JsonValue) -> Option<String> {
    let content = item.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .collect::<Vec<_>>()
        .join("\n\n");
    non_empty_string(Some(&text))
}

fn response_content_text(content: Option<&JsonValue>) -> Option<String> {
    let content = content?.as_array()?;
    let text = content
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("output_text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .collect::<Vec<_>>()
        .join("\n\n");
    non_empty_string(Some(&text))
}

fn reasoning_response_summary(summary: Option<&JsonValue>) -> Vec<String> {
    let Some(summary) = summary.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    summary
        .iter()
        .filter_map(
            |entry| match entry.get("type").and_then(JsonValue::as_str) {
                Some("summary_text") => entry.get("text").and_then(JsonValue::as_str),
                _ => None,
            },
        )
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

fn reasoning_response_content(content: Option<&JsonValue>) -> Vec<String> {
    let Some(content) = content.and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    content
        .iter()
        .filter_map(|entry| {
            entry.as_str().or_else(|| {
                entry
                    .get("text")
                    .and_then(JsonValue::as_str)
                    .or_else(|| entry.get("content").and_then(JsonValue::as_str))
            })
        })
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

fn reasoning_event_summary(summary: &[String], content: &[String]) -> String {
    if summary.is_empty() && !content.is_empty() {
        "Reasoning".to_string()
    } else {
        "Reasoning summary".to_string()
    }
}

fn string_array(value: Option<&JsonValue>) -> Vec<String> {
    value
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(JsonValue::as_str)
        .filter_map(|text| non_empty_string(Some(text)))
        .collect()
}

fn non_empty_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn command_execution_summary(item: &JsonValue) -> String {
    let status = item
        .get("status")
        .and_then(JsonValue::as_str)
        .unwrap_or("updated");
    format!("Command {status}")
}

async fn handle_codex_server_request(
    projects: &ProjectStore,
    task_events: &broadcast::Sender<TaskEventRecord>,
    pending_approvals: &Arc<AsyncMutex<HashMap<String, PendingApproval>>>,
    request_id: JsonValue,
    method: &str,
    params: JsonValue,
) {
    if method != "item/commandExecution/requestApproval"
        && method != "item/fileChange/requestApproval"
    {
        return;
    }
    let Some(thread_id) = params.get("threadId").and_then(JsonValue::as_str) else {
        return;
    };
    let approval_id = approval_id_from_request(&request_id, &params);
    let project_id = project_id_for_approval(projects, &params).unwrap_or_default();
    pending_approvals.lock().await.insert(
        approval_id.clone(),
        PendingApproval {
            thread_id: thread_id.to_string(),
            project_id: project_id.clone(),
            request_id: request_id.clone(),
            method: method.to_string(),
            params: params.clone(),
        },
    );

    let kind = if method == "item/commandExecution/requestApproval" {
        "command"
    } else {
        "file_change"
    };
    let summary = if kind == "command" {
        "Command approval requested"
    } else {
        "File change approval requested"
    };
    let event = task_event_record(
        thread_id,
        &project_id,
        &format!("approval_requested:{approval_id}"),
        "approval_requested",
        summary,
        Some(json!({
            "approvalId": approval_id,
            "kind": kind,
            "method": method,
            "requestId": request_id,
            "params": params
        })),
        now_ms(),
    );
    let _ = task_events.send(event);
}

fn codex_thread_id(method: &str, params: &JsonValue) -> Option<String> {
    match method {
        "thread/started" => params
            .pointer("/thread/id")
            .and_then(JsonValue::as_str)
            .map(ToOwned::to_owned),
        _ => params
            .get("threadId")
            .and_then(JsonValue::as_str)
            .map(ToOwned::to_owned),
    }
}

fn approval_id_from_request(request_id: &JsonValue, params: &JsonValue) -> String {
    params
        .get("approvalId")
        .and_then(JsonValue::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| match request_id {
            JsonValue::String(value) => value.clone(),
            JsonValue::Number(value) => value.to_string(),
            _ => request_id.to_string(),
        })
}

fn ensure_thread_belongs_to_project(
    project: &ProjectRecord,
    thread: &JsonValue,
) -> Result<(), ApiError> {
    if thread_belongs_to_project(project, thread) {
        return Ok(());
    }
    Err(ApiError::BadRequest {
        code: "thread_project_mismatch",
        message: "thread cwd is not inside the requested project".to_string(),
    })
}

fn thread_belongs_to_project(project: &ProjectRecord, thread: &JsonValue) -> bool {
    thread_cwd(thread)
        .map(|cwd| path_is_inside(Path::new(cwd), Path::new(&project.root_path)))
        .unwrap_or(false)
}

fn project_for_cwd(projects: &ProjectStore, cwd: &str) -> Option<ProjectRecord> {
    let cwd = Path::new(cwd);
    let mut candidates = projects
        .list_projects()
        .ok()?
        .into_iter()
        .filter(|project| path_is_inside(cwd, Path::new(&project.root_path)))
        .collect::<Vec<_>>();
    candidates.sort_by_key(|project| project.root_path.len());
    candidates.pop()
}

fn project_id_for_approval(projects: &ProjectStore, params: &JsonValue) -> Option<String> {
    let cwd = params
        .get("cwd")
        .and_then(JsonValue::as_str)
        .or_else(|| params.get("grantRoot").and_then(JsonValue::as_str))?;
    project_for_cwd(projects, cwd).map(|project| project.id)
}

fn path_is_inside(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

fn thread_id(thread: &JsonValue) -> Option<&str> {
    thread.get("id").and_then(JsonValue::as_str)
}

fn thread_cwd(thread: &JsonValue) -> Option<&str> {
    thread.get("cwd").and_then(JsonValue::as_str)
}

fn thread_status(thread: &JsonValue) -> String {
    match thread
        .get("status")
        .and_then(|status| status.get("type"))
        .and_then(JsonValue::as_str)
    {
        Some("active") => "running",
        Some("systemError") => "failed",
        Some("idle") => "idle",
        Some(status) => status,
        None => "unknown",
    }
    .to_string()
}

fn active_turn_id(thread: &JsonValue) -> Option<String> {
    thread
        .get("turns")
        .and_then(JsonValue::as_array)?
        .iter()
        .rev()
        .find(|turn| {
            turn.get("status")
                .and_then(JsonValue::as_str)
                .is_some_and(|status| status == "inProgress")
        })
        .and_then(|turn| turn.get("id").and_then(JsonValue::as_str))
        .map(ToOwned::to_owned)
}

fn relative_cwd(project: &ProjectRecord, cwd: &str) -> String {
    Path::new(cwd)
        .strip_prefix(Path::new(&project.root_path))
        .ok()
        .and_then(|path| path.to_str())
        .map(|path| path.trim_start_matches('/').to_string())
        .unwrap_or_default()
}

fn seconds_to_ms(value: Option<f64>) -> u64 {
    value.map(seconds_to_ms_value).unwrap_or(0)
}

fn seconds_to_ms_value(value: f64) -> u64 {
    if value.is_finite() && value > 0.0 {
        (value * 1000.0) as u64
    } else {
        0
    }
}

fn event_id_from_params(prefix: &str, params: &JsonValue) -> String {
    let turn_id = params
        .get("turnId")
        .or_else(|| params.pointer("/turn/id"))
        .and_then(JsonValue::as_str)
        .unwrap_or("turn");
    format!("{prefix}:{turn_id}")
}

fn short_thread_id(thread_id: &str) -> &str {
    thread_id.get(..8).unwrap_or(thread_id)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn project_task_cwd(project: &ProjectRecord, relative: Option<&str>) -> Result<String, ApiError> {
    let relative = normalize_project_relative_path(relative.unwrap_or(""))?;
    let root = PathBuf::from(&project.root_path);
    let cwd = if relative.is_empty() {
        root
    } else {
        root.join(relative)
    };
    Ok(cwd.display().to_string())
}

fn normalize_project_relative_path(path: &str) -> Result<String, ApiError> {
    let mut parts = Vec::new();
    for segment in path.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err(ApiError::BadRequest {
                code: "invalid_task_cwd",
                message: "task cwd must stay inside the project".to_string(),
            });
        }
        parts.push(segment);
    }
    Ok(parts.join("/"))
}

fn normalize_prompt(prompt: &str) -> Result<&str, ApiError> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(ApiError::BadRequest {
            code: "empty_task_prompt",
            message: "task prompt cannot be empty".to_string(),
        });
    }
    Ok(prompt)
}

fn codex_turn_options(
    model: Option<String>,
    effort: Option<String>,
) -> Result<CodexTurnOptions, ApiError> {
    Ok(CodexTurnOptions {
        model: normalize_codex_model(model)?,
        effort: normalize_codex_effort(effort)?,
    })
}

fn normalize_codex_model(model: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(model) = model else {
        return Ok(None);
    };
    let model = model.trim();
    if model.is_empty() {
        return Ok(None);
    }
    if model.len() > 128 || model.chars().any(char::is_control) {
        return Err(ApiError::BadRequest {
            code: "invalid_codex_model",
            message: "Codex model value is not supported".to_string(),
        });
    }
    Ok(Some(model.to_string()))
}

fn normalize_codex_effort(effort: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(effort) = effort else {
        return Ok(None);
    };
    let effort = effort.trim();
    if effort.is_empty() {
        return Ok(None);
    }
    match effort {
        "minimal" | "low" | "medium" | "high" | "ultra" => Ok(Some(effort.to_string())),
        _ => Err(ApiError::BadRequest {
            code: "invalid_codex_effort",
            message: "Codex reasoning effort is not supported".to_string(),
        }),
    }
}

fn normalize_approval_decision(decision: &str) -> Result<&str, ApiError> {
    match decision {
        "accept" | "acceptForSession" | "decline" | "cancel" => Ok(decision),
        _ => Err(ApiError::BadRequest {
            code: "invalid_approval_decision",
            message: "approval decision is not supported".to_string(),
        }),
    }
}

#[derive(Debug)]
enum ApiError {
    Fs(FsError),
    Project(ProjectStoreError),
    CodexThread(String),
    BadRequest { code: &'static str, message: String },
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

impl From<codex_app_server::CodexThreadError> for ApiError {
    fn from(error: codex_app_server::CodexThreadError) -> Self {
        Self::CodexThread(error.to_string())
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
            ApiError::Fs(FsError::GithubRepositoryNotFound { path }) => (
                StatusCode::BAD_REQUEST,
                "github_repository_not_found",
                format!("path is not inside a GitHub repository: {path}"),
            ),
            ApiError::Fs(FsError::GithubUnavailable { action, path }) => (
                StatusCode::BAD_REQUEST,
                "github_unavailable",
                format!("GitHub is unavailable while trying to {action}: {path}"),
            ),
            ApiError::Fs(FsError::GithubCommandFailed { action, path }) => (
                StatusCode::BAD_REQUEST,
                "github_command_failed",
                format!("GitHub CLI command failed while trying to {action}: {path}"),
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
            | ApiError::Project(ProjectStoreError::IdCollision)
            | ApiError::Project(ProjectStoreError::Glue(_))
            | ApiError::Project(ProjectStoreError::Io(_)) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "project_store_error",
                "project store failed".to_string(),
            ),
            ApiError::CodexThread(message) => {
                (StatusCode::BAD_GATEWAY, "codex_app_server_error", message)
            }
            ApiError::BadRequest { code, message } => (StatusCode::BAD_REQUEST, code, message),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn task_test_project() -> (ProjectRecord, tempfile::TempDir) {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        let projects = ProjectStore::memory().unwrap();
        let project = projects
            .create_project("project", &project_root.display().to_string())
            .unwrap();
        (project, temp)
    }

    #[test]
    fn thread_cwd_prefix_filter_includes_subdirectories_and_rejects_outside_roots() {
        let (project, temp) = task_test_project();
        let subdir_thread = json!({
            "id": "thread_subdir",
            "cwd": temp.path().join("project/src").display().to_string()
        });
        let outside_thread = json!({
            "id": "thread_outside",
            "cwd": temp.path().join("other").display().to_string()
        });

        assert!(thread_belongs_to_project(&project, &subdir_thread));
        assert!(!thread_belongs_to_project(&project, &outside_thread));
    }

    #[test]
    fn thread_list_response_filters_project_threads_and_sorts_by_recency() {
        let (project, temp) = task_test_project();
        let response = json!({
            "data": [
                {
                    "id": "thread_old",
                    "preview": "Old thread",
                    "cwd": temp.path().join("project").display().to_string(),
                    "createdAt": 1.0,
                    "updatedAt": 2.0,
                    "recencyAt": 3.0,
                    "status": { "type": "idle" }
                },
                {
                    "id": "thread_new",
                    "preview": "New thread",
                    "cwd": temp.path().join("project/src").display().to_string(),
                    "createdAt": 4.0,
                    "updatedAt": 5.0,
                    "recencyAt": 6.0,
                    "status": { "type": "active" },
                    "turns": [{ "id": "turn_1", "status": "inProgress" }]
                },
                {
                    "id": "thread_outside",
                    "preview": "Outside thread",
                    "cwd": temp.path().join("other").display().to_string(),
                    "createdAt": 7.0,
                    "updatedAt": 8.0,
                    "recencyAt": 9.0,
                    "status": { "type": "idle" }
                }
            ]
        });

        let tasks = thread_list_response(&project, &response);
        assert_eq!(
            tasks
                .iter()
                .map(|task| task.thread_id.as_str())
                .collect::<Vec<_>>(),
            vec!["thread_new", "thread_old"]
        );
        assert_eq!(tasks[0].status, "running");
        assert_eq!(tasks[0].relative_cwd, "src");
    }

    #[test]
    fn thread_read_turns_normalize_transcript_items_into_timeline_events() {
        let (project, temp) = task_test_project();
        let thread = json!({
            "id": "thread_1",
            "name": "Readable thread",
            "preview": "Inspect the diff",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 5.0,
            "status": { "type": "idle" },
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "startedAt": 2.0,
                    "completedAt": 4.0,
                    "items": [
                        {
                            "type": "userMessage",
                            "id": "item_prompt",
                            "content": [{ "type": "text", "text": "Inspect the diff" }]
                        },
                        {
                            "type": "reasoning",
                            "id": "item_reasoning",
                            "summary": ["Checked the relevant files"],
                            "content": ["Compared the diff"]
                        },
                        {
                            "type": "agentMessage",
                            "id": "item_answer",
                            "text": "The change is ready to review.",
                            "phase": "final"
                        },
                        {
                            "type": "plan",
                            "id": "item_plan",
                            "text": "Open the diff."
                        },
                        {
                            "type": "commandExecution",
                            "id": "item_command",
                            "command": "cargo test",
                            "cwd": "src",
                            "status": "completed",
                            "aggregatedOutput": "test result: ok"
                        },
                        {
                            "type": "fileChange",
                            "id": "item_file_change",
                            "status": "completed",
                            "changes": [{ "path": "src/lib.rs" }]
                        }
                    ]
                }
            ]
        });

        let events = thread_events(&project, &thread);
        let event_types = events
            .iter()
            .map(|event| event.event_type.as_str())
            .collect::<Vec<_>>();
        assert!(event_types.contains(&"turn_started"));
        assert!(event_types.contains(&"user_message"));
        assert!(event_types.contains(&"reasoning"));
        assert!(event_types.contains(&"assistant_message"));
        assert!(event_types.contains(&"plan"));
        assert!(event_types.contains(&"command_execution"));
        assert!(event_types.contains(&"file_change"));
        assert!(event_types.contains(&"turn_completed"));

        let reasoning = events
            .iter()
            .find(|event| event.event_type == "reasoning")
            .unwrap();
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["summary"][0],
            "Checked the relevant files"
        );
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["content"][0],
            "Compared the diff"
        );
        let command = events
            .iter()
            .find(|event| event.event_type == "command_execution")
            .unwrap();
        assert_eq!(
            command.payload.as_ref().unwrap()["aggregatedOutput"],
            "test result: ok"
        );
        let assistant = events
            .iter()
            .find(|event| event.event_type == "assistant_message")
            .unwrap();
        assert_eq!(
            assistant.payload.as_ref().unwrap()["text"],
            "The change is ready to review."
        );
    }

    #[test]
    fn reasoning_content_without_summary_is_preserved() {
        let (project, temp) = task_test_project();
        let thread = json!({
            "id": "thread_1",
            "preview": "Inspect the diff",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 2.0,
            "status": { "type": "idle" },
            "turns": [
                {
                    "id": "turn_1",
                    "status": "completed",
                    "startedAt": 1.0,
                    "items": [
                        {
                            "type": "reasoning",
                            "id": "item_reasoning",
                            "content": ["Reasoned without a summary"]
                        }
                    ]
                }
            ]
        });

        let events = thread_events(&project, &thread);
        let reasoning = events
            .iter()
            .find(|event| event.event_type == "reasoning")
            .unwrap();

        assert_eq!(reasoning.summary, "Reasoning");
        assert_eq!(
            reasoning.payload.as_ref().unwrap()["content"][0],
            "Reasoned without a summary"
        );
    }

    #[test]
    fn raw_response_items_normalize_assistant_messages() {
        let event = task_event_from_raw_response_item(
            "thread_1",
            "project_1",
            1,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "message",
                    "id": "raw_answer",
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "Raw response fallback." }],
                    "phase": "final"
                }
            }),
        )
        .unwrap();

        assert_eq!(event.event_type, "assistant_message");
        assert_eq!(
            event.payload.as_ref().unwrap()["text"],
            "Raw response fallback."
        );
    }

    #[test]
    fn raw_response_reasoning_content_without_summary_is_preserved() {
        let event = task_event_from_raw_response_item(
            "thread_1",
            "project_1",
            1,
            &json!({
                "threadId": "thread_1",
                "turnId": "turn_1",
                "item": {
                    "type": "reasoning",
                    "id": "raw_reasoning",
                    "content": [
                        { "type": "reasoning_text", "text": "Raw reasoning content" }
                    ]
                }
            }),
        )
        .unwrap();

        assert_eq!(event.event_type, "reasoning");
        assert_eq!(event.summary, "Reasoning");
        assert_eq!(
            event.payload.as_ref().unwrap()["content"][0],
            "Raw reasoning content"
        );
    }

    #[test]
    fn pending_approval_events_mark_task_as_waiting_for_approval() {
        let (project, temp) = task_test_project();
        let thread = json!({
            "id": "thread_1",
            "preview": "Needs approval",
            "cwd": temp.path().join("project").display().to_string(),
            "createdAt": 1.0,
            "updatedAt": 1.0,
            "status": { "type": "active" }
        });
        let events = vec![task_event_record(
            "thread_1",
            &project.id,
            "approval_requested:1",
            "approval_requested",
            "Command approval requested",
            Some(json!({ "approvalId": "1" })),
            1,
        )];

        let task = task_record_from_thread(&project, &thread, &events).unwrap();
        assert_eq!(task.status, "waiting_for_approval");
    }

    #[tokio::test]
    async fn server_requests_store_live_pending_approvals_without_local_task_ledger() {
        let temp = tempfile::tempdir().unwrap();
        let project_root = temp.path().join("project");
        std::fs::create_dir(&project_root).unwrap();
        let projects = ProjectStore::memory().unwrap();
        let project = projects
            .create_project("project", &project_root.display().to_string())
            .unwrap();
        let (sender, mut receiver) = broadcast::channel(4);
        let pending = Arc::new(AsyncMutex::new(HashMap::new()));

        handle_codex_server_request(
            &projects,
            &sender,
            &pending,
            json!(11),
            "item/commandExecution/requestApproval",
            json!({
                "threadId": "thread_1",
                "command": "cargo test",
                "cwd": project_root.join("src").display().to_string(),
                "reason": "Run tests",
                "availableDecisions": ["accept", "decline"]
            }),
        )
        .await;

        let approvals = pending.lock().await;
        let approval = approvals.get("11").unwrap();
        assert_eq!(approval.thread_id, "thread_1");
        assert_eq!(approval.project_id, project.id);
        assert_eq!(approval.params["command"], "cargo test");
        drop(approvals);

        let event = receiver.recv().await.unwrap();
        assert_eq!(event.thread_id, "thread_1");
        assert_eq!(event.event_type, "approval_requested");
        assert_eq!(event.project_id, project.id);
    }
}
