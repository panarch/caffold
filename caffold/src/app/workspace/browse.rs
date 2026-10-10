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
    app::error::ApiError,
    fs::{FileResponse, FsError, ListResponse, RootedFs},
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
    Ok(viewer_bytes(image.content_type, image.bytes))
}

async fn document(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let document = state.fs.read_document(&query.path)?;
    Ok(viewer_bytes(document.content_type, document.bytes))
}

async fn task_image(
    State(state): State<WorkspaceState>,
    Query(query): Query<TaskImageQuery>,
) -> Result<Response, ApiError> {
    let logical_path = task_image_logical_path(&state.fs, Path::new(&query.path))?;
    let image = state.fs.read_image(&logical_path)?;
    Ok(viewer_bytes(image.content_type, image.bytes))
}

// A viewer shows the file as it is on disk now, so no response is reused.
fn viewer_bytes(content_type: &'static str, bytes: Vec<u8>) -> Response {
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    (headers, bytes).into_response()
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
            assert_eq!(headers[header::CACHE_CONTROL], "no-store", "{name}");
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
