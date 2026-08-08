use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::{
    codex_app_server::CodexThreadError,
    fs::FsError,
    watch::{WatchError, WatchError::Unavailable},
};

#[derive(Debug)]
pub(super) enum ApiError {
    Fs(FsError),
    CodexThread(String),
    Watch(String),
    Internal(String),
    Timeout { code: &'static str, message: String },
    NotFound { code: &'static str, message: String },
    BadRequest { code: &'static str, message: String },
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

impl From<FsError> for ApiError {
    fn from(error: FsError) -> Self {
        Self::Fs(error)
    }
}

impl From<CodexThreadError> for ApiError {
    fn from(error: CodexThreadError) -> Self {
        match error {
            CodexThreadError::RequestTimeout { .. } => Self::Timeout {
                code: "codex_app_server_timeout",
                message: error.to_string(),
            },
            error => Self::CodexThread(error.to_string()),
        }
    }
}

impl From<WatchError> for ApiError {
    fn from(error: WatchError) -> Self {
        match error {
            WatchError::Fs(error) => Self::Fs(error),
            Unavailable(message) => Self::Watch(message),
        }
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
            ApiError::CodexThread(message) => {
                (StatusCode::BAD_GATEWAY, "codex_app_server_error", message)
            }
            ApiError::Watch(message) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "watch_unavailable",
                message,
            ),
            ApiError::Internal(message) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "internal_error", message)
            }
            ApiError::Timeout { code, message } => (StatusCode::GATEWAY_TIMEOUT, code, message),
            ApiError::NotFound { code, message } => (StatusCode::NOT_FOUND, code, message),
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

    #[test]
    fn app_server_timeout_preserves_rpc_context_in_api_error() {
        let error = ApiError::from(CodexThreadError::RequestTimeout {
            method: "thread/resume",
            request_id: 42,
            timeout_ms: 120_000,
        });

        match error {
            ApiError::Timeout { code, message } => {
                assert_eq!(code, "codex_app_server_timeout");
                assert!(message.contains("thread/resume"));
                assert!(message.contains("request 42"));
                assert!(message.contains("120000ms"));
            }
            error => panic!("expected timeout API error, got {error:?}"),
        }
    }
}
