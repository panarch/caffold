//! Files a person attaches to a prompt, kept where the Task's agent works.
//!
//! Each send gets its own folder, `.caffold/uploads/<folder>/`, named by the
//! browser when the person sends. The prompt names every file by its path
//! under the agent's working directory.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use axum::Json;
use axum::body::Body;
use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode, header};
use futures_util::StreamExt;
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use super::commands::{managed_prompt_cwd, working_directory};
use super::conversation::task_not_managed_error;
use super::store::{task_store_get, task_store_worktree_for_thread};
use crate::app::error::ApiError;
use crate::app::tasks::TaskState;

const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;
const UPLOADS_DIRECTORY: [&str; 2] = [".caffold", "uploads"];
const MAX_NAME_BYTES: usize = 255;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct UploadedFileResponse {
    path: String,
}

/// Keep one file of a send, as its bytes arrive.
///
/// A file is never replaced: the browser names each send's folder and numbers
/// names that repeat within it, so a name already taken is a mistake to report.
pub(super) async fn task_upload(
    State(state): State<TaskState>,
    AxumPath((thread_id, folder, name)): AxumPath<(String, String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<(StatusCode, Json<UploadedFileResponse>), ApiError> {
    validate_folder(&folder)?;
    validate_name(&name)?;
    if declared_length(&headers).is_some_and(|length| length > MAX_UPLOAD_BYTES) {
        return Err(upload_too_large());
    }
    let working_directory = task_working_directory(&state, &thread_id).await?;
    let uploads = uploads_directory(state.fs.root(), &working_directory, true)?
        .ok_or_else(|| ApiError::Internal("the uploads directory was not created".to_string()))?;
    let folder_path = uploads.join(&folder);
    if !real_directory(&folder_path)? {
        create_directory(&folder_path)?;
    }
    let path = folder_path.join(&name);
    let file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|error| match error.kind() {
            ErrorKind::AlreadyExists => ApiError::Conflict {
                code: "upload_exists",
                message: format!("{name} was already uploaded in this send"),
            },
            _ => ApiError::Internal(format!("could not create {name}: {error}")),
        })?;
    let partial = PartialUpload::new(path);
    write_body(file, body, &name, MAX_UPLOAD_BYTES).await?;
    partial.keep();
    Ok((
        StatusCode::CREATED,
        Json(UploadedFileResponse {
            path: relative_upload_path(&folder, &name),
        }),
    ))
}

/// Remove one send's files, for a send the agent never received.
pub(super) async fn task_upload_discard(
    State(state): State<TaskState>,
    AxumPath((thread_id, folder)): AxumPath<(String, String)>,
) -> Result<StatusCode, ApiError> {
    validate_folder(&folder)?;
    let working_directory = task_working_directory(&state, &thread_id).await?;
    let Some(uploads) = uploads_directory(state.fs.root(), &working_directory, false)? else {
        return Ok(StatusCode::NO_CONTENT);
    };
    let folder_path = uploads.join(&folder);
    if real_directory(&folder_path)? {
        std::fs::remove_dir_all(&folder_path).map_err(|error| {
            ApiError::Internal(format!("could not remove upload folder {folder}: {error}"))
        })?;
    }
    Ok(StatusCode::NO_CONTENT)
}

/// The file a prompt names by its upload path, as an absolute path inside the
/// working directory.
pub(super) fn uploaded_file(
    root: &Path,
    working_directory: &str,
    relative: &str,
) -> Result<PathBuf, ApiError> {
    let (folder, name) = parse_upload_path(relative)?;
    let missing = || ApiError::BadRequest {
        code: "upload_missing",
        message: format!("{relative} was not uploaded"),
    };
    let uploads = uploads_directory(root, working_directory, false)?.ok_or_else(missing)?;
    let folder_path = uploads.join(folder);
    if !real_directory(&folder_path)? {
        return Err(missing());
    }
    let path = folder_path.join(name);
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(path),
        Ok(_) => Err(not_plain(relative)),
        Err(error) if error.kind() == ErrorKind::NotFound => Err(missing()),
        Err(error) => Err(ApiError::Internal(format!(
            "could not read {relative}: {error}"
        ))),
    }
}

/// Split `.caffold/uploads/<folder>/<name>` into its folder and name.
fn parse_upload_path(relative: &str) -> Result<(&str, &str), ApiError> {
    let invalid = || ApiError::BadRequest {
        code: "invalid_upload_path",
        message: format!("{relative} is not a path under .caffold/uploads/<folder>/"),
    };
    let rest = relative
        .strip_prefix(".caffold/uploads/")
        .ok_or_else(invalid)?;
    let (folder, name) = rest.split_once('/').ok_or_else(invalid)?;
    validate_folder(folder).map_err(|_| invalid())?;
    validate_name(name).map_err(|_| invalid())?;
    Ok((folder, name))
}

async fn task_working_directory(state: &TaskState, thread_id: &str) -> Result<String, ApiError> {
    task_store_get(state, thread_id)
        .await?
        .ok_or_else(task_not_managed_error)?;
    let worktree = task_store_worktree_for_thread(state, thread_id).await?;
    let managed_cwd = managed_prompt_cwd(worktree.as_ref())?;
    working_directory(
        managed_cwd.as_deref(),
        state.task_sessions.snapshot(thread_id).await.as_ref(),
    )
}

async fn write_body(
    mut file: tokio::fs::File,
    body: Body,
    name: &str,
    limit: u64,
) -> Result<(), ApiError> {
    let mut written = 0u64;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| ApiError::BadRequest {
            code: "upload_interrupted",
            message: format!("{name} did not finish uploading: {error}"),
        })?;
        written += chunk.len() as u64;
        if written > limit {
            return Err(upload_too_large());
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| ApiError::Internal(format!("could not write {name}: {error}")))?;
    }
    file.flush()
        .await
        .map_err(|error| ApiError::Internal(format!("could not write {name}: {error}")))
}

/// `<working directory>/.caffold/uploads`, with every step a real directory
/// inside the server root. `None` when it does not exist and was not asked for.
fn uploads_directory(
    root: &Path,
    working_directory: &str,
    create: bool,
) -> Result<Option<PathBuf>, ApiError> {
    let unavailable = |error: std::io::Error| ApiError::Conflict {
        code: "task_directory_unavailable",
        message: format!(
            "the task's working directory {working_directory} is unavailable: {error}"
        ),
    };
    let base = Path::new(working_directory)
        .canonicalize()
        .map_err(unavailable)?;
    let root = root.canonicalize().map_err(unavailable)?;
    if !base.starts_with(&root) {
        return Err(ApiError::Forbidden {
            code: "task_directory_outside_root",
            message: format!(
                "the task's working directory {working_directory} is outside the server root"
            ),
        });
    }
    let mut directory = base;
    for step in UPLOADS_DIRECTORY {
        directory.push(step);
        if real_directory(&directory)? {
            continue;
        }
        if !create {
            return Ok(None);
        }
        create_directory(&directory)?;
    }
    Ok(Some(directory))
}

/// Whether a directory is there, refusing anything that only stands in for
/// one, such as a link that could lead outside the working directory.
fn real_directory(path: &Path) -> Result<bool, ApiError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(true),
        Ok(_) => Err(not_plain(&path.display().to_string())),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ApiError::Internal(format!(
            "could not inspect {}: {error}",
            path.display()
        ))),
    }
}

fn create_directory(path: &Path) -> Result<(), ApiError> {
    match std::fs::create_dir(path) {
        Ok(()) => Ok(()),
        // Another file of the same send made it first.
        Err(error) if error.kind() == ErrorKind::AlreadyExists => real_directory(path).map(|_| ()),
        Err(error) => Err(ApiError::Internal(format!(
            "could not create {}: {error}",
            path.display()
        ))),
    }
}

/// `YYYYMMDD-HHMMSS-xxxx`: when the person sent, and four base-36 characters
/// that keep two sends in the same second apart.
fn validate_folder(folder: &str) -> Result<(), ApiError> {
    let bytes = folder.as_bytes();
    let well_formed = bytes.len() == 20
        && bytes[8] == b'-'
        && bytes[15] == b'-'
        && bytes[..8].iter().all(u8::is_ascii_digit)
        && bytes[9..15].iter().all(u8::is_ascii_digit)
        && bytes[16..]
            .iter()
            .all(|byte| byte.is_ascii_digit() || byte.is_ascii_lowercase());
    if well_formed {
        Ok(())
    } else {
        Err(ApiError::BadRequest {
            code: "invalid_upload_folder",
            message: format!("{folder} is not an upload folder name"),
        })
    }
}

fn validate_name(name: &str) -> Result<(), ApiError> {
    let well_formed = !name.is_empty()
        && name != "."
        && name != ".."
        && name.len() <= MAX_NAME_BYTES
        && !name
            .chars()
            .any(|character| matches!(character, '/' | '\\') || character.is_control());
    if well_formed {
        Ok(())
    } else {
        Err(ApiError::BadRequest {
            code: "invalid_upload_name",
            message: format!("{name:?} cannot be used as an uploaded file name"),
        })
    }
}

fn declared_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)?
        .to_str()
        .ok()?
        .parse()
        .ok()
}

fn relative_upload_path(folder: &str, name: &str) -> String {
    format!(".caffold/uploads/{folder}/{name}")
}

fn upload_too_large() -> ApiError {
    ApiError::BadRequest {
        code: "upload_too_large",
        message: format!("an uploaded file must be at most {MAX_UPLOAD_BYTES} bytes"),
    }
}

fn not_plain(path: &str) -> ApiError {
    ApiError::Forbidden {
        code: "upload_path_not_plain",
        message: format!("{path} is not a plain file or directory"),
    }
}

/// A file being written, removed unless it was finished — including when the
/// browser goes away and the request is dropped mid-body.
struct PartialUpload {
    path: Option<PathBuf>,
}

impl PartialUpload {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn keep(mut self) {
        self.path = None;
    }
}

impl Drop for PartialUpload {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use axum::body::{Body, Bytes, to_bytes};
    use axum::http::{Request, StatusCode};
    use futures_util::stream;
    use serde_json::Value;
    use tower::ServiceExt;

    use super::super::router;
    use super::*;
    use crate::agent::codex::CodexThreadClient;
    use crate::app::tasks::test_support::{
        cache_and_manage_test_thread, manage_test_thread, task_state_with_codex_client,
    };
    use crate::fs::RootedFs;

    const THREAD: &str = "thread-uploads";
    const FOLDER: &str = "20260926-153012-a1b2";

    async fn task_in(root: &Path) -> axum::Router {
        let state = task_state_with_codex_client(
            RootedFs::new(root).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        cache_and_manage_test_thread(&state, THREAD, root).await;
        router(state)
    }

    async fn send(app: &axum::Router, request: Request<Body>) -> (StatusCode, Value) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let json = serde_json::from_slice(&body).unwrap_or(Value::Null);
        (status, json)
    }

    fn put(folder: &str, name: &str, body: impl Into<Body>) -> Request<Body> {
        Request::put(format!("/api/tasks/{THREAD}/uploads/{folder}/{name}"))
            .body(body.into())
            .unwrap()
    }

    fn discard(folder: &str) -> Request<Body> {
        Request::delete(format!("/api/tasks/{THREAD}/uploads/{folder}"))
            .body(Body::empty())
            .unwrap()
    }

    #[tokio::test]
    async fn an_upload_is_kept_under_the_working_directory_and_named_by_its_path() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;

        let (status, uploaded) = send(&app, put(FOLDER, "server%20log.txt", "line one\n")).await;

        assert_eq!(status, StatusCode::CREATED, "{uploaded}");
        assert_eq!(
            uploaded["path"],
            format!(".caffold/uploads/{FOLDER}/server log.txt")
        );
        assert_eq!(
            std::fs::read_to_string(
                root.path()
                    .join(".caffold/uploads")
                    .join(FOLDER)
                    .join("server log.txt")
            )
            .unwrap(),
            "line one\n"
        );
    }

    #[tokio::test]
    async fn a_name_already_taken_in_the_send_is_refused_rather_than_replaced() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;
        send(&app, put(FOLDER, "log.txt", "first")).await;

        let (status, refused) = send(&app, put(FOLDER, "log.txt", "second")).await;

        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["error"]["code"], "upload_exists");
        assert_eq!(
            std::fs::read_to_string(
                root.path()
                    .join(".caffold/uploads")
                    .join(FOLDER)
                    .join("log.txt")
            )
            .unwrap(),
            "first"
        );
    }

    #[tokio::test]
    async fn folders_and_names_outside_the_upload_grammar_are_refused() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;

        for (folder, name, code) in [
            ("latest", "log.txt", "invalid_upload_folder"),
            ("20260926-153012-A1B2", "log.txt", "invalid_upload_folder"),
            (FOLDER, "..", "invalid_upload_name"),
            (FOLDER, "nested%2Flog.txt", "invalid_upload_name"),
            (FOLDER, "back%5Cslash.txt", "invalid_upload_name"),
            (FOLDER, "line%0Abreak.txt", "invalid_upload_name"),
        ] {
            let (status, refused) = send(&app, put(folder, name, "x")).await;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "{folder}/{name}: {refused}"
            );
            assert_eq!(refused["error"]["code"], code, "{folder}/{name}");
        }
        assert!(!root.path().join(".caffold").exists());
    }

    #[tokio::test]
    async fn a_body_declared_over_the_limit_is_refused_before_anything_is_written() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;
        let mut request = put(FOLDER, "huge.bin", "x");
        request.headers_mut().insert(
            header::CONTENT_LENGTH,
            (MAX_UPLOAD_BYTES + 1).to_string().parse().unwrap(),
        );

        let (status, refused) = send(&app, request).await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"]["code"], "upload_too_large");
        assert!(!root.path().join(".caffold").exists());
    }

    #[tokio::test]
    async fn a_body_that_outgrows_the_limit_is_stopped_and_removed() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("growing.bin");
        let file = tokio::fs::File::create(&path).await.unwrap();
        let partial = PartialUpload::new(path.clone());

        let result = write_body(file, Body::from("12345"), "growing.bin", 4).await;
        drop(partial);

        assert!(matches!(
            result,
            Err(ApiError::BadRequest {
                code: "upload_too_large",
                ..
            })
        ));
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn an_upload_the_browser_abandons_leaves_no_partial_file() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;
        let body = Body::from_stream(stream::iter([
            Ok::<_, std::io::Error>(Bytes::from_static(b"half")),
            Err(std::io::Error::new(ErrorKind::ConnectionReset, "gone")),
        ]));

        let (status, refused) = send(&app, put(FOLDER, "half.txt", body)).await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"]["code"], "upload_interrupted");
        assert!(
            !root
                .path()
                .join(".caffold/uploads")
                .join(FOLDER)
                .join("half.txt")
                .exists()
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_linked_caffold_directory_is_not_followed() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let elsewhere = root.path().join("elsewhere");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(elsewhere.join("uploads")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, project.join(".caffold")).unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        cache_and_manage_test_thread(&state, THREAD, &project).await;
        let app = router(state);

        let (status, refused) = send(&app, put(FOLDER, "log.txt", "x")).await;

        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert_eq!(refused["error"]["code"], "upload_path_not_plain");
        assert!(!elsewhere.join("uploads").join(FOLDER).exists());
    }

    // Uploads and discards take PUT and DELETE, which a browser never sends to
    // another site without asking first; Caffold grants no such request.
    #[tokio::test]
    async fn a_cross_site_request_to_upload_is_never_granted() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;

        for method in ["PUT", "DELETE"] {
            let response = app
                .clone()
                .oneshot(
                    Request::options(format!("/api/tasks/{THREAD}/uploads/{FOLDER}/log.txt"))
                        .header(header::ORIGIN, "https://elsewhere.example")
                        .header(header::ACCESS_CONTROL_REQUEST_METHOD, method)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();

            assert!(
                !response.status().is_success(),
                "{method}: {}",
                response.status()
            );
            assert!(
                response
                    .headers()
                    .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                    .is_none(),
                "{method}"
            );
        }
        assert!(!root.path().join(".caffold").exists());
    }

    #[tokio::test]
    async fn a_working_directory_that_is_gone_takes_no_uploads() {
        let root = tempfile::tempdir().unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        cache_and_manage_test_thread(&state, THREAD, &root.path().join("removed")).await;
        let app = router(state);

        let (status, refused) = send(&app, put(FOLDER, "log.txt", "x")).await;

        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["error"]["code"], "task_directory_unavailable");
    }

    #[tokio::test]
    async fn a_working_directory_outside_the_server_root_takes_no_uploads() {
        let root = tempfile::tempdir().unwrap();
        let served = root.path().join("served");
        let outside = root.path().join("outside");
        std::fs::create_dir_all(&served).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(&served).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        cache_and_manage_test_thread(&state, THREAD, &outside).await;
        let app = router(state);

        let (status, refused) = send(&app, put(FOLDER, "log.txt", "x")).await;

        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert_eq!(refused["error"]["code"], "task_directory_outside_root");
        assert!(!outside.join(".caffold").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_directory_that_cannot_be_written_is_reported() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;
        let caffold = root.path().join(".caffold");
        std::fs::create_dir(&caffold).unwrap();
        let read_only = |path: &Path| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o555)).unwrap()
        };
        let writable = |path: &Path| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap()
        };

        read_only(&caffold);
        let (no_uploads, _) = send(&app, put(FOLDER, "log.txt", "x")).await;
        writable(&caffold);
        let folder = caffold.join("uploads").join(FOLDER);
        std::fs::create_dir_all(&folder).unwrap();
        read_only(&folder);
        let (no_file, _) = send(&app, put(FOLDER, "log.txt", "x")).await;
        writable(&folder);

        assert_eq!(no_uploads, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(no_file, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(!folder.join("log.txt").exists());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_send_that_cannot_be_removed_is_reported() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;
        send(&app, put(FOLDER, "log.txt", "x")).await;
        let uploads = root.path().join(".caffold/uploads");
        std::fs::set_permissions(&uploads, std::fs::Permissions::from_mode(0o555)).unwrap();

        let (status, _) = send(&app, discard(FOLDER)).await;

        std::fs::set_permissions(&uploads, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(uploads.join(FOLDER).exists());
    }

    #[cfg(unix)]
    #[test]
    fn an_upload_that_cannot_be_looked_at_is_reported() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let working_directory = root.path().display().to_string();
        let caffold = root.path().join(".caffold");
        let folder = caffold.join("uploads").join(FOLDER);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("shot.png"), "png").unwrap();
        let relative = format!(".caffold/uploads/{FOLDER}/shot.png");
        let closed = |path: &Path| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o000)).unwrap()
        };
        let open = |path: &Path| {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap()
        };

        closed(&folder);
        let inside_folder = uploaded_file(root.path(), &working_directory, &relative);
        open(&folder);
        closed(&caffold);
        let inside_caffold = uploaded_file(root.path(), &working_directory, &relative);
        open(&caffold);

        assert!(matches!(inside_folder, Err(ApiError::Internal(_))));
        assert!(matches!(inside_caffold, Err(ApiError::Internal(_))));
    }

    #[tokio::test]
    async fn discarding_a_send_removes_its_folder_and_nothing_else() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;
        let kept = "20260926-153000-zzzz";
        send(&app, put(FOLDER, "a.txt", "a")).await;
        send(&app, put(FOLDER, "b.txt", "b")).await;
        send(&app, put(kept, "c.txt", "c")).await;

        let (status, _) = send(&app, discard(FOLDER)).await;

        assert_eq!(status, StatusCode::NO_CONTENT);
        let uploads = root.path().join(".caffold/uploads");
        assert!(!uploads.join(FOLDER).exists());
        assert!(uploads.join(kept).join("c.txt").exists());
    }

    #[tokio::test]
    async fn discarding_a_send_with_nothing_uploaded_succeeds() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;

        let (status, _) = send(&app, discard(FOLDER)).await;

        assert_eq!(status, StatusCode::NO_CONTENT);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discarding_a_linked_folder_leaves_its_target_alone() {
        let root = tempfile::tempdir().unwrap();
        let app = task_in(root.path()).await;
        let target = root.path().join("keep-me");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("precious.txt"), "x").unwrap();
        let uploads = root.path().join(".caffold/uploads");
        std::fs::create_dir_all(&uploads).unwrap();
        std::os::unix::fs::symlink(&target, uploads.join(FOLDER)).unwrap();

        let (status, refused) = send(&app, discard(FOLDER)).await;

        assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");
        assert!(target.join("precious.txt").exists());
    }

    #[tokio::test]
    async fn an_unmanaged_task_takes_no_uploads() {
        let root = tempfile::tempdir().unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        let app = router(state);

        let (status, refused) = send(&app, put(FOLDER, "log.txt", "x")).await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        assert_eq!(refused["error"]["code"], "task_not_managed");
    }

    #[tokio::test]
    async fn a_task_whose_conversation_is_not_open_says_where_it_works_is_unknown() {
        let root = tempfile::tempdir().unwrap();
        let state = task_state_with_codex_client(
            RootedFs::new(root.path()).unwrap(),
            CodexThreadClient::mock(Vec::new()),
        )
        .await;
        manage_test_thread(&state, THREAD, root.path()).await;
        let app = router(state);

        let (status, refused) = send(&app, put(FOLDER, "log.txt", "x")).await;

        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(refused["error"]["code"], "task_directory_unavailable");
        assert!(!root.path().join(".caffold").exists());
    }

    #[test]
    fn a_prompt_names_only_files_that_were_uploaded_as_plain_files() {
        let root = tempfile::tempdir().unwrap();
        let working_directory = root.path().display().to_string();
        let folder = root.path().join(".caffold/uploads").join(FOLDER);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("shot.png"), "png").unwrap();
        let relative = format!(".caffold/uploads/{FOLDER}/shot.png");

        assert_eq!(
            uploaded_file(root.path(), &working_directory, &relative).unwrap(),
            root.path()
                .canonicalize()
                .unwrap()
                .join(".caffold/uploads")
                .join(FOLDER)
                .join("shot.png")
        );
        for (relative, code) in [
            (
                format!(".caffold/uploads/{FOLDER}/missing.png"),
                "upload_missing",
            ),
            (
                ".caffold/uploads/20260926-153012-zzzz/shot.png".to_string(),
                "upload_missing",
            ),
            ("shot.png".to_string(), "invalid_upload_path"),
            (
                format!(".caffold/uploads/{FOLDER}/../shot.png"),
                "invalid_upload_path",
            ),
            (format!(".caffold/uploads/{FOLDER}"), "invalid_upload_path"),
        ] {
            let Err(ApiError::BadRequest { code: actual, .. }) =
                uploaded_file(root.path(), &working_directory, &relative)
            else {
                panic!("{relative} was accepted");
            };
            assert_eq!(actual, code, "{relative}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_prompt_cannot_name_a_link_placed_among_the_uploads() {
        let root = tempfile::tempdir().unwrap();
        let working_directory = root.path().display().to_string();
        let folder = root.path().join(".caffold/uploads").join(FOLDER);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(root.path().join("secret.png"), "png").unwrap();
        std::os::unix::fs::symlink(root.path().join("secret.png"), folder.join("shot.png"))
            .unwrap();

        assert!(matches!(
            uploaded_file(
                root.path(),
                &working_directory,
                &format!(".caffold/uploads/{FOLDER}/shot.png")
            ),
            Err(ApiError::Forbidden {
                code: "upload_path_not_plain",
                ..
            })
        ));
    }
}
