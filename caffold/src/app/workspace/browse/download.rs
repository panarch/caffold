use std::io;

use axum::{
    body::{Body, Bytes},
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, header},
    response::{IntoResponse, Response},
};
use futures_util::{Stream, stream};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use tokio::io::AsyncReadExt;

use crate::{
    app::{
        error::ApiError,
        workspace::{PathQuery, WorkspaceState},
    },
    fs::DownloadFile,
};

const DOWNLOAD_CHUNK_BYTES: usize = 64 * 1024;

/// What the `filename*` parameter of a download keeps as it is. Every other
/// byte of the UTF-8 name is percent-encoded.
const FILENAME_UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

pub(super) async fn download(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let download = state.fs.open_download(&query.path)?;
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(download.size));
    headers.insert(
        header::CONTENT_DISPOSITION,
        attachment_disposition(&download.name),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));

    Ok((headers, Body::from_stream(file_chunks(download))).into_response())
}

// The stream stops at the size the response announced, so a file that grows
// while it downloads cannot overrun its Content-Length.
fn file_chunks(download: DownloadFile) -> impl Stream<Item = io::Result<Bytes>> {
    let reader = tokio::fs::File::from_std(download.file).take(download.size);
    stream::try_unfold(reader, |mut reader| async move {
        let mut chunk = vec![0; DOWNLOAD_CHUNK_BYTES];
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        chunk.truncate(read);
        Ok(Some((Bytes::from(chunk), reader)))
    })
}

// `filename*` carries the exact name; the plain `filename` is an ASCII stand-in
// for a client that reads only that one.
fn attachment_disposition(name: &str) -> HeaderValue {
    let ascii_name: String = name
        .chars()
        .map(|character| match character {
            ' ' | '!' | '#'..='[' | ']'..='~' => character,
            _ => '_',
        })
        .collect();
    let encoded_name = utf8_percent_encode(name, FILENAME_UNRESERVED);
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"
    ))
    .expect("a download disposition holds only visible ASCII")
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use axum::{
        Router,
        body::to_bytes,
        http::{Request, StatusCode},
    };
    use serde_json::Value;
    use tower::ServiceExt;

    use super::super::router;
    use super::*;
    use crate::fs::RootedFs;

    fn app(root: &Path) -> Router {
        router().with_state(WorkspaceState::new(Arc::new(RootedFs::new(root).unwrap())))
    }

    async fn request(app: Router, uri: &str) -> Response {
        app.oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn download_streams_the_whole_file_as_an_attachment() {
        let root = tempfile::tempdir().unwrap();
        let bytes = [
            &[0, 159, 146, 150][..],
            &vec![b'a'; DOWNLOAD_CHUNK_BYTES * 2 + 1],
        ]
        .concat();
        std::fs::write(root.path().join("보고서 \"최종\".bin"), &bytes).unwrap();
        let path = utf8_percent_encode("보고서 \"최종\".bin", NON_ALPHANUMERIC);

        let response = request(app(root.path()), &format!("/api/download?path={path}")).await;

        assert_eq!(response.status(), StatusCode::OK);
        let headers = response.headers();
        assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
        assert_eq!(headers[header::CONTENT_LENGTH], bytes.len().to_string());
        assert_eq!(
            headers[header::CONTENT_DISPOSITION],
            "attachment; filename=\"___ ____.bin\"; \
             filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C%20%22%EC%B5%9C%EC%A2%85%22.bin"
        );
        assert_eq!(headers[header::CACHE_CONTROL], "no-store");
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body, bytes);
    }

    #[tokio::test]
    async fn download_answers_a_directory_with_a_json_error() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("dist")).unwrap();

        let response = request(app(root.path()), "/api/download?path=dist").await;

        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = to_bytes(response.into_body(), 64 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], "is_directory");
    }
}
