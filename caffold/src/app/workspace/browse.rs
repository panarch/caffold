mod byte_range;
mod download;

use std::{path::Path, time::Duration};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde::Deserialize;

use byte_range::RequestedBytes;
use download::download;

use super::{PathQuery, WorkspaceState};
use crate::{
    app::{error::ApiError, etag},
    fs::{FileBytes, FsError, ListResponse, OpenedBinary, RootedFs},
};

const LIST_DIRECTORY_TIMEOUT: Duration = Duration::from_secs(5);

/// A viewer's request for an image or document. A part fetched after the
/// first names the version it belongs to.
#[derive(Debug, Deserialize)]
struct BinaryQuery {
    #[serde(default)]
    path: String,
    version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TaskImageQuery {
    path: String,
    version: Option<String>,
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
    // Reading colors the file, which takes a noticeable share of a second for
    // a large one, so it runs on the blocking pool.
    let fs = state.fs.clone();
    tokio::task::spawn_blocking(move || {
        let file = fs.open_text(&query.path)?;
        viewer_response(&request, file.version(), || file.read().map(Json))
    })
    .await
    .map_err(|error| ApiError::Internal(format!("File read task failed: {error}")))?
}

async fn image(
    State(state): State<WorkspaceState>,
    Query(query): Query<BinaryQuery>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let image = state.fs.open_image(&query.path)?;
    binary_viewer_response(&request, query.version.as_deref(), image)
}

async fn document(
    State(state): State<WorkspaceState>,
    Query(query): Query<BinaryQuery>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let document = state.fs.open_document(&query.path)?;
    binary_viewer_response(&request, query.version.as_deref(), document)
}

async fn task_image(
    State(state): State<WorkspaceState>,
    Query(query): Query<TaskImageQuery>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let logical_path = task_image_logical_path(&state.fs, Path::new(&query.path))?;
    let image = state.fs.open_image(&logical_path)?;
    binary_viewer_response(&request, query.version.as_deref(), image)
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
    if etag::matches(request, &version) {
        return Ok(etag::not_modified(&version));
    }
    Ok((etag::headers(&version), read()?).into_response())
}

/// An image or document is also sent one part at a time, for a viewer that
/// fetches a large file in parts. A part fetched at an address naming the
/// file's version never changes, so the browser keeps it without asking again;
/// an address naming another version is refused, so parts of two versions are
/// never put together.
fn binary_viewer_response(
    request: &HeaderMap,
    addressed_version: Option<&str>,
    file: OpenedBinary,
) -> Result<Response, ApiError> {
    let Some(version) = file.version() else {
        if let Some(addressed) = addressed_version {
            return Err(file_changed(addressed));
        }
        return viewer_response(request, None, || file.read().map(binary_response));
    };
    let cache_headers = match addressed_version {
        None => etag::headers(&version),
        Some(addressed) if addressed == version => immutable_headers(&version),
        Some(addressed) => return Err(file_changed(addressed)),
    };
    if etag::matches(request, &version) {
        return Ok((StatusCode::NOT_MODIFIED, cache_headers).into_response());
    }

    let size = file.size();
    Ok(match byte_range::requested(request, size, &version) {
        RequestedBytes::Whole => (cache_headers, binary_response(file.read()?)).into_response(),
        RequestedBytes::Part { first, last } => (
            StatusCode::PARTIAL_CONTENT,
            cache_headers,
            [(
                header::CONTENT_RANGE,
                format!("bytes {first}-{last}/{size}"),
            )],
            binary_response(file.read_part(first, last)?),
        )
            .into_response(),
        RequestedBytes::OutOfRange => (
            StatusCode::RANGE_NOT_SATISFIABLE,
            [(header::CONTENT_RANGE, format!("bytes */{size}"))],
        )
            .into_response(),
    })
}

/// The headers for a part fetched at an address naming its version: that
/// address never answers differently, so the browser keeps the part without
/// asking, and `private` keeps a work file out of shared caches.
fn immutable_headers(tag: &str) -> [(HeaderName, HeaderValue); 2] {
    let [version_header, _] = etag::headers(tag);
    [
        version_header,
        (
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, max-age=31536000, immutable"),
        ),
    ]
}

fn file_changed(addressed: &str) -> ApiError {
    ApiError::PreconditionFailed {
        code: "file_changed",
        message: format!("the file is no longer version {addressed}"),
    }
}

fn binary_response(file: FileBytes) -> impl IntoResponse {
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

    async fn request_with(app: Router, uri: &str, headers: &[(HeaderName, &str)]) -> Response {
        let mut request = Request::builder().uri(uri);
        for (name, value) in headers {
            request = request.header(name, *value);
        }
        app.oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn body(response: Response) -> Vec<u8> {
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }

    // An image, a document, and a conversation image holding the same ten
    // bytes, each with the address its route reads it from.
    fn ten_byte_files(root: &Path) -> Vec<String> {
        for name in ["digits.png", "digits.pdf"] {
            std::fs::write(root.join(name), b"0123456789").unwrap();
        }
        vec![
            "/api/image?path=digits.png".to_string(),
            "/api/document?path=digits.pdf".to_string(),
            format!("/api/task-image?path={}", root.join("digits.png").display()),
        ]
    }

    fn tag_of(response: &Response) -> String {
        response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .trim_matches('"')
            .to_string()
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
    async fn a_text_file_is_sent_with_its_language_and_colors() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.rs"), "fn main() {}\n").unwrap();
        std::fs::write(root.path().join("notes.unknownext"), "fn main() {}\n").unwrap();

        let rust = request(app(root.path()), "/api/file?path=main.rs").await;
        let unknown = request(app(root.path()), "/api/file?path=notes.unknownext").await;

        assert_eq!(rust.status(), StatusCode::OK);
        let rust: serde_json::Value =
            serde_json::from_slice(&to_bytes(rust.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(rust["language"], "Rust");
        assert_eq!(rust["syntaxSpans"][0][0], serde_json::json!([0, 2, 1]));
        let unknown: serde_json::Value =
            serde_json::from_slice(&to_bytes(unknown.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(unknown["language"], "Plain Text");
        assert_eq!(unknown["syntaxSpans"], serde_json::Value::Null);
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
    async fn an_image_or_document_is_sent_in_the_part_a_range_asks_for() {
        let root = tempfile::tempdir().unwrap();

        for uri in ten_byte_files(root.path()) {
            let response =
                request_with(app(root.path()), &uri, &[(header::RANGE, "bytes=2-5")]).await;

            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{uri}");
            let headers = response.headers();
            assert_eq!(headers[header::CONTENT_RANGE], "bytes 2-5/10", "{uri}");
            assert_eq!(headers[header::CACHE_CONTROL], "no-cache", "{uri}");
            assert!(headers.contains_key(header::ETAG), "{uri}");
            assert!(headers.contains_key(header::CONTENT_TYPE), "{uri}");
            assert_eq!(body(response).await, b"2345", "{uri}");
        }
    }

    #[tokio::test]
    async fn a_range_past_the_end_is_refused_without_the_file() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("empty.png"), b"").unwrap();

        for (uri, size) in ten_byte_files(root.path())
            .into_iter()
            .map(|uri| (uri, 10))
            .chain([("/api/image?path=empty.png".to_string(), 0)])
        {
            let response =
                request_with(app(root.path()), &uri, &[(header::RANGE, "bytes=10-")]).await;

            assert_eq!(
                response.status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{uri}"
            );
            assert_eq!(
                response.headers()[header::CONTENT_RANGE],
                format!("bytes */{size}"),
                "{uri}"
            );
            assert!(body(response).await.is_empty(), "{uri}");
        }
    }

    #[tokio::test]
    async fn a_held_version_is_not_sent_again_in_part() {
        let root = tempfile::tempdir().unwrap();

        for uri in ten_byte_files(root.path()) {
            let tag = tag_of(&request(app(root.path()), &uri).await);
            let held = format!("\"{tag}\"");

            let response = request_with(
                app(root.path()),
                &uri,
                &[(header::RANGE, "bytes=2-5"), (header::IF_NONE_MATCH, &held)],
            )
            .await;

            assert_eq!(response.status(), StatusCode::NOT_MODIFIED, "{uri}");
            assert!(body(response).await.is_empty(), "{uri}");
        }
    }

    #[tokio::test]
    async fn if_range_naming_another_version_gets_the_whole_file() {
        let root = tempfile::tempdir().unwrap();
        let uri = &ten_byte_files(root.path())[0];
        let current = format!("\"{}\"", tag_of(&request(app(root.path()), uri).await));

        let same = request_with(
            app(root.path()),
            uri,
            &[(header::RANGE, "bytes=2-5"), (header::IF_RANGE, &current)],
        )
        .await;
        assert_eq!(same.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(body(same).await, b"2345");

        let other = request_with(
            app(root.path()),
            uri,
            &[
                (header::RANGE, "bytes=2-5"),
                (header::IF_RANGE, "\"other\""),
            ],
        )
        .await;
        assert_eq!(other.status(), StatusCode::OK);
        assert_eq!(body(other).await, b"0123456789");
    }

    #[tokio::test]
    async fn several_ranges_or_a_malformed_one_get_the_whole_file() {
        let root = tempfile::tempdir().unwrap();
        let uri = &ten_byte_files(root.path())[0];

        for range in ["bytes=0-1,4-5", "bytes=5-2", "lines=0-1"] {
            let response = request_with(app(root.path()), uri, &[(header::RANGE, range)]).await;

            assert_eq!(response.status(), StatusCode::OK, "{range}");
            assert!(
                !response.headers().contains_key(header::CONTENT_RANGE),
                "{range}"
            );
            assert_eq!(body(response).await, b"0123456789", "{range}");
        }
    }

    #[tokio::test]
    async fn a_part_at_an_address_naming_its_version_may_be_kept() {
        let root = tempfile::tempdir().unwrap();

        for uri in ten_byte_files(root.path()) {
            let tag = tag_of(&request(app(root.path()), &uri).await);
            let versioned = format!("{uri}&version={tag}");

            let part = request_with(
                app(root.path()),
                &versioned,
                &[(header::RANGE, "bytes=6-9")],
            )
            .await;
            assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT, "{uri}");
            assert_eq!(
                part.headers()[header::CACHE_CONTROL],
                "private, max-age=31536000, immutable",
                "{uri}"
            );
            assert_eq!(tag_of(&part), tag, "{uri}");
            assert_eq!(body(part).await, b"6789", "{uri}");

            let whole = request(app(root.path()), &versioned).await;
            assert_eq!(whole.status(), StatusCode::OK, "{uri}");
            assert_eq!(
                whole.headers()[header::CACHE_CONTROL],
                "private, max-age=31536000, immutable",
                "{uri}"
            );
        }
    }

    #[tokio::test]
    async fn an_address_naming_another_version_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let picture = root.path().join("digits.png");
        let uri = &ten_byte_files(root.path())[0];
        set_modified(&picture, 1_700_000_000);
        let tag = tag_of(&request(app(root.path()), uri).await);
        std::fs::write(&picture, b"9876543210").unwrap();
        set_modified(&picture, 1_700_000_001);

        for versioned in [
            format!("{uri}&version={tag}"),
            format!("{uri}&version=stale"),
        ] {
            let response = request_with(
                app(root.path()),
                &versioned,
                &[(header::RANGE, "bytes=0-3")],
            )
            .await;

            assert_eq!(
                response.status(),
                StatusCode::PRECONDITION_FAILED,
                "{versioned}"
            );
            assert!(
                !response.headers().contains_key(header::ETAG),
                "{versioned}"
            );
            let body: Value = serde_json::from_slice(&body(response).await).unwrap();
            assert_eq!(body["error"]["code"], "file_changed", "{versioned}");
        }
    }

    #[tokio::test]
    async fn text_and_downloads_are_always_sent_whole() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("notes.md"), "# Notes\n").unwrap();
        std::fs::write(root.path().join("digits.bin"), b"0123456789").unwrap();

        let text = request_with(
            app(root.path()),
            "/api/file?path=notes.md&version=stale",
            &[(header::RANGE, "bytes=0-1")],
        )
        .await;
        assert_eq!(text.status(), StatusCode::OK);
        let text: Value = serde_json::from_slice(&body(text).await).unwrap();
        assert_eq!(text["content"], "# Notes\n");

        let download = request_with(
            app(root.path()),
            "/api/download?path=digits.bin&version=stale",
            &[(header::RANGE, "bytes=0-1")],
        )
        .await;
        assert_eq!(download.status(), StatusCode::OK);
        assert_eq!(body(download).await, b"0123456789");
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
