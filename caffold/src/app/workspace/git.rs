use axum::{
    Json, Router,
    extract::{Query, State},
    routing::{get, post},
};
use serde::Deserialize;

use super::{PathQuery, WorkspaceState};
use crate::{
    app::error::ApiError,
    fs::{
        GitCommitResponse, GitCompareResponse, GitDiffResponse, GitFetchResponse, GitLogResponse,
        GitRefsResponse, GitStatusResponse,
    },
};

#[derive(Debug, Deserialize)]
struct GitFetchRequest {
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

pub(super) fn router() -> Router<WorkspaceState> {
    Router::new()
        .route("/api/git/status", get(git_status))
        .route("/api/git/diff", get(git_diff))
        .route("/api/git/log", get(git_log))
        .route("/api/git/fetch", post(git_fetch))
        .route("/api/git/commit", get(git_commit))
        .route("/api/git/commit-diff", get(git_commit_diff))
        .route("/api/git/compare", get(git_compare))
        .route("/api/git/compare-diff", get(git_compare_diff))
        .route("/api/git/refs", get(git_refs))
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

async fn git_fetch(
    State(state): State<WorkspaceState>,
    Json(request): Json<GitFetchRequest>,
) -> Result<Json<GitFetchResponse>, ApiError> {
    let fs = state.fs.clone();
    tokio::task::spawn_blocking(move || fs.git_fetch(&request.path))
        .await
        .map_err(|error| ApiError::Internal(format!("Git fetch task failed: {error}")))?
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

#[cfg(test)]
mod tests {
    use std::{path::Path, process::Command, sync::Arc};

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode, header},
    };
    use serde_json::{Value as JsonValue, json};
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use crate::fs::RootedFs;

    #[tokio::test]
    async fn git_fetch_route_fetches_remote_default_without_changing_checkout_state() {
        let root = tempfile::tempdir().unwrap();
        let remote = create_remote_with_main(root.path(), "remote");
        let repo = root.path().join("repo");
        git(
            root.path(),
            &["clone", remote.to_str().unwrap(), repo.to_str().unwrap()],
        );
        git(&repo, &["checkout", "-b", "feature/review"]);
        std::fs::write(repo.join("feature.txt"), "feature\n").unwrap();
        git(&repo, &["add", "feature.txt"]);
        commit(&repo, "Add feature");

        let seed = root.path().join("remote-seed");
        std::fs::write(seed.join("remote.txt"), "remote\n").unwrap();
        git(&seed, &["add", "remote.txt"]);
        commit(&seed, "Advance main");
        git(&seed, &["push", "origin", "main"]);

        std::fs::write(repo.join("base.txt"), "dirty\n").unwrap();
        let checkout_head = git_output(&repo, &["rev-parse", "HEAD"]);
        let checkout_status = git_output(&repo, &["status", "--short"]);
        let fetch_head = repo.join(".git/FETCH_HEAD");
        std::fs::write(&fetch_head, "existing fetch state\n").unwrap();

        let fetched = post_fetch(app(root.path()), json!({ "path": "repo" })).await;
        assert_eq!(fetched.status(), StatusCode::OK);
        let fetched = response_json(fetched).await;
        assert_eq!(fetched["repository"]["rootPath"], "repo");
        assert_eq!(fetched["repository"]["branch"], "feature/review");
        assert_eq!(fetched["remote"], "origin");
        assert_eq!(fetched["branch"], "main");
        assert_eq!(fetched["reference"], "origin/main");
        assert_eq!(fetched["ahead"], 1);
        assert_eq!(fetched["behind"], 1);
        assert_eq!(git_output(&repo, &["rev-parse", "HEAD"]), checkout_head);
        assert_eq!(git_output(&repo, &["status", "--short"]), checkout_status);
        assert_eq!(
            std::fs::read_to_string(fetch_head).unwrap(),
            "existing fetch state\n"
        );
    }

    #[tokio::test]
    async fn git_fetch_route_reports_missing_remote() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        create_committed_repository(&repo);

        assert_fetch_error(
            app(root.path()),
            "repo",
            StatusCode::BAD_REQUEST,
            "git_remote_not_found",
            "no Git fetch remote is configured for: repo",
        )
        .await;
    }

    #[tokio::test]
    async fn git_fetch_route_reports_ambiguous_remotes() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        create_committed_repository(&repo);
        git(&repo, &["remote", "add", "company", "../company.git"]);
        git(&repo, &["remote", "add", "upstream", "../upstream.git"]);

        assert_fetch_error(
            app(root.path()),
            "repo",
            StatusCode::CONFLICT,
            "git_remote_ambiguous",
            "multiple Git fetch remotes are configured for: repo",
        )
        .await;
    }

    #[tokio::test]
    async fn git_fetch_route_reports_remote_without_default_branch() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        let remote = root.path().join("empty.git");
        create_committed_repository(&repo);
        std::fs::create_dir(&remote).unwrap();
        git(&remote, &["init", "--bare"]);
        git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );

        assert_fetch_error(
            app(root.path()),
            "repo",
            StatusCode::BAD_GATEWAY,
            "git_remote_head_unavailable",
            "the default branch is unavailable for Git remote: origin",
        )
        .await;
    }

    #[tokio::test]
    async fn git_fetch_route_reports_unreachable_remote() {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        create_committed_repository(&repo);
        git(&repo, &["remote", "add", "origin", "../missing.git"]);

        assert_fetch_error(
            app(root.path()),
            "repo",
            StatusCode::BAD_GATEWAY,
            "git_remote_head_unavailable",
            "the default branch is unavailable for Git remote: origin",
        )
        .await;
    }

    #[tokio::test]
    async fn git_fetch_route_reports_fetch_command_failure() {
        let root = tempfile::tempdir().unwrap();
        let remote = create_remote_with_main(root.path(), "remote");
        let repo = root.path().join("repo");
        create_committed_repository(&repo);
        git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&repo, &["update-ref", "refs/remotes/origin", "HEAD"]);

        assert_fetch_error(
            app(root.path()),
            "repo",
            StatusCode::BAD_GATEWAY,
            "git_fetch_failed",
            "Git fetch failed for origin/main",
        )
        .await;
    }

    #[tokio::test]
    async fn git_fetch_route_reports_relationship_failure_after_fetch() {
        let root = tempfile::tempdir().unwrap();
        let remote = create_remote_with_main(root.path(), "remote");
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init"]);
        git(&repo, &["branch", "-M", "main"]);
        git(
            &repo,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );

        assert_fetch_error(
            app(root.path()),
            "repo",
            StatusCode::BAD_REQUEST,
            "git_command_failed",
            "git command failed while trying to compare the fetched branch: repo",
        )
        .await;
        assert_eq!(
            git_output(&repo, &["rev-parse", "refs/remotes/origin/main"]),
            git_output(&remote, &["rev-parse", "refs/heads/main"])
        );
    }

    fn app(root: &Path) -> axum::Router {
        let fs = Arc::new(RootedFs::new(root).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        super::super::router(fs, shutdown)
    }

    async fn assert_fetch_error(
        app: axum::Router,
        path: &str,
        status: StatusCode,
        code: &str,
        message: &str,
    ) {
        let response = post_fetch(app, json!({ "path": path })).await;
        assert_eq!(response.status(), status);
        let response = response_json(response).await;
        assert_eq!(response["error"]["code"], code);
        assert_eq!(response["error"]["message"], message);
    }

    async fn post_fetch(app: axum::Router, body: JsonValue) -> axum::response::Response {
        app.oneshot(
            Request::post("/api/git/fetch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap()
    }

    async fn response_json(response: axum::response::Response) -> JsonValue {
        let body = to_bytes(response.into_body(), 4096).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn create_committed_repository(path: &Path) {
        std::fs::create_dir(path).unwrap();
        git(path, &["init"]);
        std::fs::write(path.join("base.txt"), "base\n").unwrap();
        git(path, &["add", "base.txt"]);
        commit(path, "Add base");
        git(path, &["branch", "-M", "main"]);
    }

    fn create_remote_with_main(root: &Path, name: &str) -> std::path::PathBuf {
        let seed = root.join(format!("{name}-seed"));
        let remote = root.join(format!("{name}.git"));
        create_committed_repository(&seed);
        std::fs::create_dir(&remote).unwrap();
        git(&remote, &["init", "--bare"]);
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        git(
            &seed,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&seed, &["push", "origin", "main"]);
        remote
    }

    fn git(path: &std::path::Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_output(path: &std::path::Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn commit(path: &std::path::Path, message: &str) {
        git(
            path,
            &[
                "-c",
                "user.name=Caffold Test",
                "-c",
                "user.email=caffold@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-m",
                message,
            ],
        );
    }
}
