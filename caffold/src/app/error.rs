use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

use crate::{
    agent::TurnRejected,
    agent::codex::CodexThreadError,
    fs::FsError,
    watch::{WatchError, WatchError::Unavailable},
};

#[derive(Debug)]
pub(super) enum ApiError {
    Fs(FsError),
    CodexThread(String),
    Watch(String),
    Internal(String),
    Unavailable { code: &'static str, message: String },
    Timeout { code: &'static str, message: String },
    NotFound { code: &'static str, message: String },
    BadRequest { code: &'static str, message: String },
    Forbidden { code: &'static str, message: String },
    Conflict { code: &'static str, message: String },
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Fs(error) => error.fmt(formatter),
            Self::CodexThread(message) | Self::Watch(message) | Self::Internal(message) => {
                formatter.write_str(message)
            }
            Self::Timeout { message, .. }
            | Self::Unavailable { message, .. }
            | Self::NotFound { message, .. }
            | Self::BadRequest { message, .. }
            | Self::Forbidden { message, .. }
            | Self::Conflict { message, .. } => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ApiError {}

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
            CodexThreadError::Readiness(readiness) => Self::Unavailable {
                code: "codex_readiness_blocked",
                message: readiness.diagnostic_message,
            },
            CodexThreadError::RequestTimeout { .. } | CodexThreadError::StartupTimeout { .. } => {
                Self::Timeout {
                    code: "codex_app_server_timeout",
                    message: error.to_string(),
                }
            }
            error => Self::CodexThread(error.to_string()),
        }
    }
}

impl From<TurnRejected> for ApiError {
    fn from(rejected: TurnRejected) -> Self {
        let (code, message) = match rejected {
            TurnRejected::Model => ("unsupported_model", "the agent does not offer that model"),
            TurnRejected::Effort => (
                "unsupported_effort",
                "the agent does not work at that depth with the chosen model",
            ),
            TurnRejected::Unavailable(error) => return Self::from(error),
        };
        Self::BadRequest {
            code,
            message: message.to_string(),
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
            ApiError::Fs(FsError::GitRemoteNotFound { path }) => (
                StatusCode::BAD_REQUEST,
                "git_remote_not_found",
                format!("no Git fetch remote is configured for: {path}"),
            ),
            ApiError::Fs(FsError::GitRemoteAmbiguous { path }) => (
                StatusCode::CONFLICT,
                "git_remote_ambiguous",
                format!("multiple Git fetch remotes are configured for: {path}"),
            ),
            ApiError::Fs(FsError::GitRemoteHeadUnavailable { remote }) => (
                StatusCode::BAD_GATEWAY,
                "git_remote_head_unavailable",
                format!("the default branch is unavailable for Git remote: {remote}"),
            ),
            ApiError::Fs(FsError::GitFetchFailed { remote, branch }) => (
                StatusCode::BAD_GATEWAY,
                "git_fetch_failed",
                format!("Git fetch failed for {remote}/{branch}"),
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
            ApiError::Fs(FsError::InvalidGithubPullHeadOid { oid }) => (
                StatusCode::BAD_REQUEST,
                "invalid_github_pull_head_oid",
                format!("invalid pull request head OID: {oid}"),
            ),
            ApiError::Fs(FsError::GithubPullHeadUnavailable { path }) => (
                StatusCode::BAD_GATEWAY,
                "github_pull_head_unavailable",
                format!(
                    "Pull request head is unavailable for {path}. Refresh the PR details and try again."
                ),
            ),
            ApiError::Fs(FsError::GithubPullHeadStale { expected, actual }) => (
                StatusCode::CONFLICT,
                "github_pull_head_stale",
                format!(
                    "Pull request head moved from {expected} to {actual}. Refresh the PR details before starting a Task."
                ),
            ),
            ApiError::Fs(FsError::GithubPullRepositoryMismatch { expected, actual }) => (
                StatusCode::CONFLICT,
                "github_pull_repository_mismatch",
                format!(
                    "Pull request base repository changed from {expected} to {actual}. Refresh the GitHub surface before starting a Task."
                ),
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
            ApiError::Unavailable { code, message } => {
                (StatusCode::SERVICE_UNAVAILABLE, code, message)
            }
            ApiError::Timeout { code, message } => (StatusCode::GATEWAY_TIMEOUT, code, message),
            ApiError::NotFound { code, message } => (StatusCode::NOT_FOUND, code, message),
            ApiError::BadRequest { code, message } => (StatusCode::BAD_REQUEST, code, message),
            ApiError::Forbidden { code, message } => (StatusCode::FORBIDDEN, code, message),
            ApiError::Conflict { code, message } => (StatusCode::CONFLICT, code, message),
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

    async fn assert_pull_head_error(error: FsError, status: StatusCode, code: &str) {
        let response = ApiError::from(error).into_response();
        assert_eq!(response.status(), status);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["error"]["code"], code);
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|message| !message.is_empty())
        );
    }

    #[tokio::test]
    async fn github_pull_head_failures_have_recoverable_http_contracts() {
        assert_pull_head_error(
            FsError::InvalidGithubPullHeadOid {
                oid: "not-an-oid".to_string(),
            },
            StatusCode::BAD_REQUEST,
            "invalid_github_pull_head_oid",
        )
        .await;
        assert_pull_head_error(
            FsError::GithubPullHeadUnavailable {
                path: "example/caffold#97".to_string(),
            },
            StatusCode::BAD_GATEWAY,
            "github_pull_head_unavailable",
        )
        .await;
        assert_pull_head_error(
            FsError::GithubPullHeadStale {
                expected: "1".repeat(40),
                actual: "2".repeat(40),
            },
            StatusCode::CONFLICT,
            "github_pull_head_stale",
        )
        .await;
        assert_pull_head_error(
            FsError::GithubPullRepositoryMismatch {
                expected: "example/old".to_string(),
                actual: "example/caffold".to_string(),
            },
            StatusCode::CONFLICT,
            "github_pull_repository_mismatch",
        )
        .await;
    }

    #[test]
    fn blocking_readiness_has_a_stable_task_api_error() {
        let error = ApiError::from(CodexThreadError::Readiness(Box::new(
            crate::agent::codex::CodexReadiness::blocking(
                crate::agent::codex::CodexReadinessState::UpdateRequired,
                crate::agent::codex::CodexReadinessReason::VersionBelowMinimum,
                "Codex must be updated.",
                None,
            ),
        )));

        match error {
            ApiError::Unavailable { code, message } => {
                assert_eq!(code, "codex_readiness_blocked");
                assert_eq!(message, "Codex must be updated.");
            }
            error => panic!("expected unavailable API error, got {error:?}"),
        }
    }
}
