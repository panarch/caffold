use std::{process::Command, sync::Arc};

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode, header},
};
use serde_json::{Value as JsonValue, json};
use tokio::sync::broadcast;
use tower::ServiceExt;

use super::*;

#[test]
fn task_images_must_stay_inside_the_browsing_root() {
    let root = tempfile::tempdir().unwrap();
    let image_path = root.path().join("task-image.png");
    let outside = tempfile::tempdir().unwrap();
    let outside_path = outside.path().join("outside.png");
    std::fs::write(&image_path, b"image").unwrap();
    std::fs::write(&outside_path, b"image").unwrap();

    let fs = RootedFs::new(root.path()).unwrap();
    assert_eq!(
        task_image_logical_path(&fs, &image_path).unwrap(),
        "task-image.png"
    );
    assert!(matches!(
        task_image_logical_path(&fs, &outside_path),
        Err(FsError::PathEscapesRoot)
    ));
}

#[tokio::test]
async fn github_pull_head_route_prepares_the_exact_ref_without_moving_the_source_checkout() {
    let root = tempfile::tempdir().unwrap();
    let remote_path = root.path().join("remote");
    let repo_path = root.path().join("repo");
    std::fs::create_dir(&remote_path).unwrap();
    std::fs::create_dir(&repo_path).unwrap();

    git(&remote_path, &["init"]);
    std::fs::write(remote_path.join("pull.txt"), "first head\n").unwrap();
    git(&remote_path, &["add", "pull.txt"]);
    commit(&remote_path, "First pull head");
    let first_oid = git_output(&remote_path, &["rev-parse", "HEAD"]);
    git(
        &remote_path,
        &["update-ref", "refs/pull/97/head", &first_oid],
    );

    git(&repo_path, &["init"]);
    std::fs::write(repo_path.join("local.txt"), "checked out\n").unwrap();
    git(&repo_path, &["add", "local.txt"]);
    commit(&repo_path, "Keep the source checkout");
    git(
        &repo_path,
        &["remote", "add", "cache", remote_path.to_str().unwrap()],
    );
    git(
        &repo_path,
        &[
            "remote",
            "add",
            "origin",
            "https://github.com/panarch/caffold.git",
        ],
    );
    let local_url = format!("file://{}", remote_path.display());
    git(
        &repo_path,
        &[
            "config",
            &format!("url.{local_url}.insteadOf"),
            "https://github.com/panarch/caffold.git",
        ],
    );
    std::fs::write(repo_path.join("local.txt"), "dirty checkout\n").unwrap();
    std::fs::write(repo_path.join("untracked.txt"), "untracked\n").unwrap();
    let checkout_head = git_output(&repo_path, &["rev-parse", "HEAD"]);
    let checkout_status = git_output(&repo_path, &["status", "--short"]);
    let fetch_head = repo_path.join(".git/FETCH_HEAD");
    std::fs::write(&fetch_head, "existing fetch state\n").unwrap();

    let fs = Arc::new(RootedFs::new(root.path()).unwrap());
    let (shutdown, _) = broadcast::channel(1);
    let app = router(fs, shutdown);

    let prepared = post_pull_head(
        app.clone(),
        json!({
            "path": "repo",
            "number": 97,
            "headOid": first_oid,
            "baseRepository": "panarch/caffold"
        }),
    )
    .await;
    assert_eq!(prepared.status(), StatusCode::OK);
    let prepared = response_json(prepared).await;
    assert_eq!(prepared["repository"]["rootPath"], "repo");
    assert_eq!(prepared["github"]["nameWithOwner"], "panarch/caffold");
    assert_eq!(prepared["number"], 97);
    assert_eq!(prepared["headOid"], first_oid);
    assert_eq!(
        prepared["headRef"],
        format!("refs/caffold/github/pulls/97/{first_oid}")
    );
    assert_eq!(
        git_output(&repo_path, &["rev-parse", "HEAD"]),
        checkout_head
    );
    assert_eq!(
        git_output(&repo_path, &["status", "--short"]),
        checkout_status
    );
    assert_eq!(
        std::fs::read_to_string(&fetch_head).unwrap(),
        "existing fetch state\n"
    );

    let mismatch = post_pull_head(
        app.clone(),
        json!({
            "path": "repo",
            "number": 97,
            "headOid": "not-an-oid",
            "baseRepository": "other/caffold"
        }),
    )
    .await;
    assert_eq!(mismatch.status(), StatusCode::CONFLICT);
    assert_error_code(mismatch, "github_pull_repository_mismatch").await;

    let invalid_oid = post_pull_head(
        app.clone(),
        json!({
            "path": "repo",
            "number": 97,
            "headOid": "not-an-oid",
            "baseRepository": "panarch/caffold"
        }),
    )
    .await;
    assert_eq!(invalid_oid.status(), StatusCode::BAD_REQUEST);
    assert_error_code(invalid_oid, "invalid_github_pull_head_oid").await;

    std::fs::write(remote_path.join("pull.txt"), "moved head\n").unwrap();
    git(&remote_path, &["add", "pull.txt"]);
    commit(&remote_path, "Move the pull head");
    let moved_oid = git_output(&remote_path, &["rev-parse", "HEAD"]);
    git(
        &remote_path,
        &["update-ref", "refs/pull/97/head", &moved_oid],
    );

    let stale = post_pull_head(
        app.clone(),
        json!({
            "path": "repo",
            "number": 97,
            "headOid": first_oid,
            "baseRepository": "panarch/caffold"
        }),
    )
    .await;
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    assert_error_code(stale, "github_pull_head_stale").await;

    let unavailable = post_pull_head(
        app,
        json!({
            "path": "repo",
            "number": 98,
            "headOid": first_oid,
            "baseRepository": "panarch/caffold"
        }),
    )
    .await;
    assert_eq!(unavailable.status(), StatusCode::BAD_GATEWAY);
    assert_error_code(unavailable, "github_pull_head_unavailable").await;
}

async fn post_pull_head(app: axum::Router, body: JsonValue) -> axum::response::Response {
    app.oneshot(
        Request::post("/api/github/pull-head")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
    )
    .await
    .unwrap()
}

async fn assert_error_code(response: axum::response::Response, expected: &str) {
    let body = response_json(response).await;
    assert_eq!(body["error"]["code"], expected);
}

async fn response_json(response: axum::response::Response) -> JsonValue {
    let body = to_bytes(response.into_body(), 4096).await.unwrap();
    serde_json::from_slice(&body).unwrap()
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
