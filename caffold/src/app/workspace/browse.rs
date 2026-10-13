mod download;

use std::{path::Path, time::Duration};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;

use download::download;

use super::{PathQuery, WorkspaceState};
use crate::{
    app::{conditional, error::ApiError},
    fs::{BinaryFile, FsError, ListResponse, RootedFs},
};

const LIST_DIRECTORY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
struct TaskImageQuery {
    path: String,
}

pub(super) fn router() -> Router<WorkspaceState> {
    Router::new()
        .route("/api/list", get(list))
        .route("/api/file", get(file))
        .route("/api/image", get(image))
        .route("/api/document", get(document))
        .route("/api/download", get(download))
        .route("/api/task-image", get(task_image))
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
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let file = state.fs.open_text(&query.path)?;
    viewer_response(&request, file.version(), || file.read().map(Json))
}

async fn image(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let image = state.fs.open_image(&query.path)?;
    viewer_response(&request, image.version(), || {
        image.read().map(binary_response)
    })
}

async fn document(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let document = state.fs.open_document(&query.path)?;
    viewer_response(&request, document.version(), || {
        document.read().map(binary_response)
    })
}

async fn task_image(
    State(state): State<WorkspaceState>,
    Query(query): Query<TaskImageQuery>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let logical_path = task_image_logical_path(&state.fs, Path::new(&query.path))?;
    let image = state.fs.open_image(&logical_path)?;
    viewer_response(&request, image.version(), || {
        image.read().map(binary_response)
    })
}

/// A viewer shows the file as it is on disk now. A browser that already holds
/// that version gets it back without the file being read; a file the file
/// system keeps no modification time for is never reused.
fn viewer_response<T: IntoResponse>(
    request: &HeaderMap,
    version: Option<String>,
    read: impl FnOnce() -> Result<T, FsError>,
) -> Result<Response, ApiError> {
    let Some(version) = version else {
        let no_store = [(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))];
        return Ok((no_store, read()?).into_response());
    };
    if conditional::holds(request, &version) {
        return Ok(conditional::not_modified(&version));
    }
    Ok((conditional::validators(&version), read()?).into_response())
}

fn binary_response(file: BinaryFile) -> impl IntoResponse {
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static(file.content_type),
        )],
        file.bytes,
    )
}

fn task_image_logical_path(fs: &RootedFs, path: &Path) -> Result<String, FsError> {
    fs.logical_path_for_absolute(path)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use super::*;

    fn app(root: &Path) -> Router {
        router().with_state(WorkspaceState::new(Arc::new(RootedFs::new(root).unwrap())))
    }

    async fn request(app: Router, uri: &str) -> Response {
        app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn request_holding(app: Router, uri: &str, tag: &str) -> Response {
        app.oneshot(
            Request::builder()
                .uri(uri)
                .header(header::IF_NONE_MATCH, tag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
    }

    fn set_modified(path: &Path, seconds: u64) {
        std::fs::File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + Duration::from_secs(seconds))
            .unwrap();
    }

    #[tokio::test]
    async fn a_file_the_viewer_already_holds_is_answered_without_its_bytes() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("notes.md"), "# Notes\n").unwrap();
        std::fs::write(root.path().join("picture.png"), b"picture").unwrap();
        std::fs::write(root.path().join("manual.pdf"), b"%PDF-1.7").unwrap();
        let task_image = format!(
            "/api/task-image?path={}",
            root.path().join("picture.png").display()
        );

        for uri in [
            "/api/file?path=notes.md",
            "/api/image?path=picture.png",
            "/api/document?path=manual.pdf",
            task_image.as_str(),
        ] {
            let first = request(app(root.path()), uri).await;
            assert_eq!(first.status(), StatusCode::OK, "{uri}");
            assert_eq!(first.headers()[header::CACHE_CONTROL], "no-cache", "{uri}");
            let tag = first.headers()[header::ETAG].to_str().unwrap().to_string();

            let held = request_holding(app(root.path()), uri, &tag).await;

            assert_eq!(held.status(), StatusCode::NOT_MODIFIED, "{uri}");
            assert_eq!(held.headers()[header::ETAG], tag.as_str(), "{uri}");
            assert_eq!(held.headers()[header::CACHE_CONTROL], "no-cache", "{uri}");
            let body = to_bytes(held.into_body(), 1024).await.unwrap();
            assert!(body.is_empty(), "{uri}");
        }
    }

    #[tokio::test]
    async fn a_changed_file_is_sent_again_under_a_new_tag() {
        let root = tempfile::tempdir().unwrap();
        let picture = root.path().join("picture.png");
        std::fs::write(&picture, b"first").unwrap();
        set_modified(&picture, 1_700_000_000);
        let first = request(app(root.path()), "/api/image?path=picture.png").await;
        let tag = first.headers()[header::ETAG].to_str().unwrap().to_string();

        std::fs::write(&picture, b"fixed").unwrap();
        set_modified(&picture, 1_700_000_001);
        let changed = request_holding(app(root.path()), "/api/image?path=picture.png", &tag).await;

        assert_eq!(changed.status(), StatusCode::OK);
        assert_ne!(changed.headers()[header::ETAG], tag.as_str());
        let body = to_bytes(changed.into_body(), 1024).await.unwrap();
        assert_eq!(&body[..], b"fixed");
    }

    #[tokio::test]
    async fn a_refused_file_carries_no_tag() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("notes.txt"), "notes").unwrap();

        for (uri, status) in [
            (
                "/api/image?path=notes.txt",
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
            ),
            ("/api/document?path=missing.pdf", StatusCode::NOT_FOUND),
        ] {
            let response = request_holding(app(root.path()), uri, "*").await;

            assert_eq!(response.status(), status, "{uri}");
            assert!(!response.headers().contains_key(header::ETAG), "{uri}");
        }
    }

    #[tokio::test]
    async fn documents_are_answered_as_their_own_bytes_and_type() {
        let root = tempfile::tempdir().unwrap();
        for name in [
            "manual.pdf",
            "report.docx",
            "deck.pptx",
            "budget.xlsx",
            "macros.xlsm",
        ] {
            std::fs::write(root.path().join(name), name.as_bytes()).unwrap();
        }

        for (name, content_type) in [
            ("manual.pdf", "application/pdf"),
            (
                "report.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ),
            (
                "deck.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
            (
                "budget.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
            (
                "macros.xlsm",
                "application/vnd.ms-excel.sheet.macroEnabled.12",
            ),
        ] {
            let response = request(app(root.path()), &format!("/api/document?path={name}")).await;

            assert_eq!(response.status(), StatusCode::OK, "{name}");
            let headers = response.headers();
            assert_eq!(headers[header::CONTENT_TYPE], content_type, "{name}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache", "{name}");
            assert!(headers.contains_key(header::ETAG), "{name}");
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert_eq!(body, name.as_bytes(), "{name}");
        }
    }

    #[tokio::test]
    async fn another_file_type_is_refused_as_a_document() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("report.doc"), b"legacy").unwrap();

        let response = request(app(root.path()), "/api/document?path=report.doc").await;

        assert_eq!(response.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "unsupported_document");
    }

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
}
