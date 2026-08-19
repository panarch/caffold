use std::{path::Path, time::Duration};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;

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

#[cfg(test)]
mod tests {
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
}
