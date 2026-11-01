//! Antigravity's explicit installation, sign-in and unified Settings refresh actions.
use super::commands::task_cwd;
use crate::{
    agent::antigravity::AntigravityStatus,
    app::{error::ApiError, tasks::TaskState},
};
use axum::{Json, extract::State};
use serde::Deserialize;
use std::fmt::Display;
use uuid::Uuid;

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
pub(super) async fn install(
    State(state): State<TaskState>,
) -> Result<Json<AntigravityStatus>, ApiError> {
    let client = state.task_runtime.antigravity();
    client.install().await.map_err(action_error)?;
    Ok(Json(client.introspect().await))
}
pub(super) async fn login(
    State(state): State<TaskState>,
) -> Result<Json<AntigravityStatus>, ApiError> {
    let client = state.task_runtime.antigravity();
    client.sign_in().await.map_err(action_error)?;
    Ok(Json(client.introspect().await))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Callback {
    request_id: String,
    url: String,
}
pub(super) async fn callback(
    State(state): State<TaskState>,
    Json(request): Json<Callback>,
) -> Result<Json<AntigravityStatus>, ApiError> {
    let id = request_id(&request.request_id)?;
    let client = state.task_runtime.antigravity();
    client
        .complete_auth(id, &request.url)
        .await
        .map_err(action_error)?;
    Ok(Json(client.introspect().await))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Cancel {
    request_id: String,
}
pub(super) async fn cancel(
    State(state): State<TaskState>,
    Json(request): Json<Cancel>,
) -> Result<Json<AntigravityStatus>, ApiError> {
    let client = state.task_runtime.antigravity();
    client
        .cancel_auth(request_id(&request.request_id)?)
        .await
        .map_err(action_error)?;
    Ok(Json(client.introspect().await))
}
pub(super) async fn logout(
    State(state): State<TaskState>,
) -> Result<Json<AntigravityStatus>, ApiError> {
    let client = state.task_runtime.antigravity();
    client.sign_out().await.map_err(action_error)?;
    Ok(Json(client.introspect().await))
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
fn request_id(raw: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(raw).map_err(|_| ApiError::BadRequest {
        code: "invalid_auth_request",
        message: "This authentication request is invalid".into(),
    })
}
fn action_error(error: impl Display) -> ApiError {
    ApiError::Conflict {
        code: "antigravity_action_failed",
        message: error.to_string(),
    }
}
