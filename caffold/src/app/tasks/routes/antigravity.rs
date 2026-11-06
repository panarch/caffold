//! Antigravity CLI observations and explicit Settings refresh/runtime restart.
use super::commands::task_cwd;
use crate::{
    agent::antigravity::AntigravityStatus,
    app::{error::ApiError, tasks::TaskState},
};
use axum::{Json, extract::State};
use std::fmt::Display;

pub(super) async fn status(State(state): State<TaskState>) -> Json<AntigravityStatus> {
    Json(state.task_runtime.antigravity().introspect().await)
}
pub(super) async fn restart(
    State(state): State<TaskState>,
) -> Result<Json<AntigravityStatus>, ApiError> {
    let client = state.task_runtime.antigravity().clone();
    // An accepted runtime replacement completes even after browser navigation.
    tokio::spawn(async move {
        client.restart_runtime().await.map_err(action_error)?;
        Ok(Json(client.introspect().await))
    })
    .await
    .map_err(|_| ApiError::Internal("Antigravity restart worker failed".into()))?
}
pub(super) async fn refresh(
    State(state): State<TaskState>,
) -> Result<Json<AntigravityStatus>, ApiError> {
    let cwd = task_cwd(&state, None)?;
    let client = state.task_runtime.antigravity().clone();
    // The backend owns probe cleanup even if the browser navigates away.
    tokio::spawn(async move {
        client.refresh_settings(&cwd).await.map_err(action_error)?;
        Ok(Json(client.introspect().await))
    })
    .await
    .map_err(|_| ApiError::Internal("Antigravity refresh worker failed".into()))?
}
fn action_error(error: impl Display) -> ApiError {
    ApiError::Conflict {
        code: "antigravity_action_failed",
        message: error.to_string(),
    }
}
