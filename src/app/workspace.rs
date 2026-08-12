use std::{convert::Infallible, path::Path, sync::Arc, time::Duration};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::stream;
use serde::Deserialize;
use serde_json::json;
use tokio::sync::broadcast;

use super::error::ApiError;
use crate::{
    fs::{
        FileResponse, FsError, GitCommitResponse, GitCompareResponse, GitDiffResponse,
        GitLogResponse, GitRefsResponse, GitStatusResponse, GithubIssueResponse,
        GithubIssuesResponse, GithubPullFileResponse, GithubPullFilesResponse,
        GithubPullHeadResponse, GithubPullResponse, GithubPullsResponse, GithubStatusResponse,
        ListResponse, RootedFs,
    },
    watch::{WatchChange, WatchHub, WatchMessage},
};

const LIST_DIRECTORY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone)]
struct WorkspaceState {
    fs: Arc<RootedFs>,
    watch_hub: WatchHub,
    shutdown: broadcast::Sender<()>,
}

impl WorkspaceState {
    fn new(fs: Arc<RootedFs>, shutdown: broadcast::Sender<()>) -> Self {
        let watch_hub = WatchHub::new(fs.clone(), shutdown.clone());
        Self {
            fs,
            watch_hub,
            shutdown,
        }
    }
}

#[derive(Debug, Deserialize)]
struct PathQuery {
    #[serde(default)]
    path: String,
}

#[derive(Debug, Deserialize)]
struct TaskImageQuery {
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
#[serde(rename_all = "camelCase")]
struct GithubPullHeadRequest {
    #[serde(default)]
    path: String,
    number: u64,
    head_oid: String,
    base_repository: String,
}

#[derive(Debug, Deserialize)]
struct GithubPullFileQuery {
    #[serde(default)]
    path: String,
    number: u64,
    file: String,
}

pub(super) fn router(fs: Arc<RootedFs>, shutdown: broadcast::Sender<()>) -> Router {
    let state = WorkspaceState::new(fs, shutdown);
    Router::new()
        .route("/api/list", get(list))
        .route("/api/file", get(file))
        .route("/api/image", get(image))
        .route("/api/task-image", get(task_image))
        .route("/api/watch", get(watch_stream))
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
        .route("/api/github/pull-head", post(prepare_github_pull_head))
        .route("/api/github/pull-files", get(github_pull_files))
        .route("/api/github/pull-file", get(github_pull_file))
        .with_state(state)
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

async fn list(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<ListResponse>, ApiError> {
    let fs = state.fs.clone();
    let requested_path = query.path;
    let timeout_path = requested_path.clone();
    let list = tokio::task::spawn_blocking(move || fs.list(&requested_path));

    match tokio::time::timeout(LIST_DIRECTORY_TIMEOUT, list).await {
        Ok(Ok(Ok(response))) => Ok(Json(response)),
        Ok(Ok(Err(error))) => Err(ApiError::from(error)),
        Ok(Err(error)) => Err(ApiError::Internal(format!(
            "directory listing task failed: {error}"
        ))),
        Err(_) => Err(ApiError::Timeout {
            code: "directory_list_timeout",
            message: format!("directory listing timed out: {timeout_path}"),
        }),
    }
}

async fn file(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<FileResponse>, ApiError> {
    state
        .fs
        .read_file(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn image(
    State(state): State<WorkspaceState>,
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

async fn task_image(
    State(state): State<WorkspaceState>,
    Query(query): Query<TaskImageQuery>,
) -> Result<Response, ApiError> {
    let logical_path = task_image_logical_path(&state.fs, Path::new(&query.path))?;
    let image = state.fs.read_image(&logical_path)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(image.content_type),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    Ok((headers, image.bytes).into_response())
}

fn task_image_logical_path(fs: &RootedFs, path: &Path) -> Result<String, FsError> {
    fs.logical_path_for_absolute(path)
}

async fn watch_stream(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let subscription = state.watch_hub.subscribe(&query.path)?;
    let shutdown = state.shutdown.subscribe();
    let heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(15),
        Duration::from_secs(15),
    );
    let stream = stream::unfold(
        (false, false, subscription, shutdown, heartbeat, 1_u64),
        |(ready_sent, terminate, mut subscription, mut shutdown, mut heartbeat, mut revision)| async move {
            if terminate {
                return None;
            }
            if !ready_sent {
                revision = subscription.ready.revision;
                let payload =
                    serde_json::to_string(&subscription.ready).unwrap_or_else(|_| "{}".to_string());
                let frame = format!("event: ready\ndata: {payload}\n\n");
                return Some((
                    Ok::<_, Infallible>(Bytes::from(frame)),
                    (true, false, subscription, shutdown, heartbeat, revision),
                ));
            }

            tokio::select! {
                    _ = shutdown.recv() => None,
                    _ = heartbeat.tick() => {
                        Some((
                            Ok::<_, Infallible>(Bytes::from_static(b": heartbeat\n\n")),
                            (true, false, subscription, shutdown, heartbeat, revision),
                        ))
                    }
                    message = subscription.recv() => match message {
                        Ok(WatchMessage::Change(change)) => {
                            revision = change.revision;
                            let payload = serde_json::to_string(&change)
                                .unwrap_or_else(|_| "{}".to_string());
                            let frame = format!("event: change\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, false, subscription, shutdown, heartbeat, revision),
                            ))
                        }
                        Ok(WatchMessage::Error(message)) => {
                            let payload = json!({ "message": message }).to_string();
                            let frame = format!("event: watch-error\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, true, subscription, shutdown, heartbeat, revision),
                            ))
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {
                            revision = revision.saturating_add(1);
                            let repository = subscription.ready.repository_root_path.is_some();
                            let change = WatchChange {
                                revision,
                                paths: Vec::new(),
                                git_status_changed: repository,
                                git_refs_changed: repository,
                                overflow: true,
                            };
                            let payload = serde_json::to_string(&change)
                                .unwrap_or_else(|_| "{}".to_string());
                            let frame = format!("event: change\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, false, subscription, shutdown, heartbeat, revision),
                            ))
                        }
                        Err(broadcast::error::RecvError::Closed) => None,
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

async fn git_status(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GitStatusResponse>, ApiError> {
    state
        .fs
        .git_status(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_diff(
    State(state): State<WorkspaceState>,
    Query(query): Query<GitDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    state
        .fs
        .git_diff(&query.path, &query.file, &query.kind)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_log(
    State(state): State<WorkspaceState>,
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
    State(state): State<WorkspaceState>,
    Query(query): Query<GitCommitQuery>,
) -> Result<Json<GitCommitResponse>, ApiError> {
    state
        .fs
        .git_commit(&query.path, &query.sha)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_commit_diff(
    State(state): State<WorkspaceState>,
    Query(query): Query<GitCommitDiffQuery>,
) -> Result<Json<GitDiffResponse>, ApiError> {
    state
        .fs
        .git_commit_diff(&query.path, &query.sha, &query.file)
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_compare(
    State(state): State<WorkspaceState>,
    Query(query): Query<GitCompareQuery>,
) -> Result<Json<GitCompareResponse>, ApiError> {
    state
        .fs
        .git_compare(&query.path, query.base.as_deref(), query.head.as_deref())
        .map(Json)
        .map_err(ApiError::from)
}

async fn git_compare_diff(
    State(state): State<WorkspaceState>,
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
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GitRefsResponse>, ApiError> {
    state
        .fs
        .git_refs(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_status(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<GithubStatusResponse>, ApiError> {
    state
        .fs
        .github_status(&query.path)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_issues(
    State(state): State<WorkspaceState>,
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
    State(state): State<WorkspaceState>,
    Query(query): Query<GithubIssueQuery>,
) -> Result<Json<GithubIssueResponse>, ApiError> {
    state
        .fs
        .github_issue(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pulls(
    State(state): State<WorkspaceState>,
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
    State(state): State<WorkspaceState>,
    Query(query): Query<GithubPullQuery>,
) -> Result<Json<GithubPullResponse>, ApiError> {
    state
        .fs
        .github_pull(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn prepare_github_pull_head(
    State(state): State<WorkspaceState>,
    Json(request): Json<GithubPullHeadRequest>,
) -> Result<Json<GithubPullHeadResponse>, ApiError> {
    state
        .fs
        .prepare_github_pull_head(
            &request.path,
            request.number,
            &request.head_oid,
            &request.base_repository,
        )
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pull_files(
    State(state): State<WorkspaceState>,
    Query(query): Query<GithubPullQuery>,
) -> Result<Json<GithubPullFilesResponse>, ApiError> {
    state
        .fs
        .github_pull_files(&query.path, query.number)
        .map(Json)
        .map_err(ApiError::from)
}

async fn github_pull_file(
    State(state): State<WorkspaceState>,
    Query(query): Query<GithubPullFileQuery>,
) -> Result<Json<GithubPullFileResponse>, ApiError> {
    state
        .fs
        .github_pull_file(&query.path, query.number, &query.file)
        .map(Json)
        .map_err(ApiError::from)
}

#[cfg(test)]
mod tests;
