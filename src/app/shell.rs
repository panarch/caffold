use std::sync::Arc;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderName, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

use super::error::ApiError;
use crate::{
    fs::{MAX_FILE_BYTES, RootedFs},
    server_settings::{ServerSettings, ServerSettingsError, ServerSettingsStore},
    static_assets,
};

#[derive(Clone)]
struct ShellState {
    fs: Arc<RootedFs>,
    server_settings: Arc<ServerSettingsStore>,
    initial_path: String,
    home_path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateServerSettingsRequest {
    name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    build_id: &'static str,
    build_label: &'static str,
    build_number: &'static str,
    server_name: String,
    root: String,
    initial_path: String,
    home_path: Option<String>,
    max_file_bytes: u64,
}

pub(super) fn router(
    fs: Arc<RootedFs>,
    server_settings: Arc<ServerSettingsStore>,
    initial_path: String,
    home_path: Option<String>,
) -> Router {
    let state = ShellState {
        fs,
        server_settings,
        initial_path,
        home_path,
    };
    Router::new()
        .route("/", get(index))
        .route("/api/health", get(health))
        .route(
            "/api/server/settings",
            get(get_server_settings).patch(update_server_settings),
        )
        .route("/service-worker.js", get(service_worker))
        .route("/assets/manifest.webmanifest", get(manifest))
        .route("/assets/{*path}", get(asset))
        .route("/settings", get(index))
        .route("/settings/{*path}", get(index))
        .route("/tasks", get(index))
        .route("/tasks/{*path}", get(index))
        .route("/files", get(index))
        .route("/git", get(index))
        .route("/git/{*path}", get(index))
        .route("/github", get(index))
        .route("/github/{*path}", get(index))
        .with_state(state)
}

async fn index(State(state): State<ShellState>) -> Response {
    let name = state.server_settings.get().name;
    let body = render_index(&name);
    let mut response = Html(body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn manifest(State(state): State<ShellState>) -> Result<Response, ApiError> {
    let name = state.server_settings.get().name;
    let body = render_manifest(&name)?;
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/manifest+json; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(response)
}

fn render_index(name: &str) -> String {
    static_assets::INDEX.replace("{{CAFFOLD_SERVER_NAME}}", &escape_html(name))
}

fn render_manifest(name: &str) -> Result<Vec<u8>, ApiError> {
    let asset = static_assets::get("manifest.webmanifest")
        .ok_or_else(|| ApiError::Internal("PWA manifest asset is unavailable".to_string()))?;
    let mut manifest: JsonValue = serde_json::from_slice(asset.body)
        .map_err(|error| ApiError::Internal(format!("PWA manifest is invalid: {error}")))?;
    manifest["name"] = JsonValue::String(name.to_string());
    manifest["short_name"] = JsonValue::String(name.to_string());
    serde_json::to_vec_pretty(&manifest)
        .map_err(|error| ApiError::Internal(format!("PWA manifest failed to encode: {error}")))
}

async fn service_worker() -> Response {
    match static_assets::get("service-worker.js") {
        Some(asset) => {
            let mut response = Response::new(Body::from(asset.body));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            );
            response
                .headers_mut()
                .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
            response.headers_mut().insert(
                HeaderName::from_static("service-worker-allowed"),
                HeaderValue::from_static("/"),
            );
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn asset(AxumPath(path): AxumPath<String>) -> Response {
    match static_assets::get(&path) {
        Some(asset) => {
            let mut response = Response::new(Body::from(asset.body));
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static(asset.content_type),
            );
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn health(State(state): State<ShellState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        build_id: env!("CAFFOLD_BUILD_ID"),
        build_label: env!("CAFFOLD_BUILD_LABEL"),
        build_number: env!("CAFFOLD_BUILD_NUMBER"),
        server_name: state.server_settings.get().name,
        root: state.fs.root().display().to_string(),
        initial_path: state.initial_path,
        home_path: state.home_path,
        max_file_bytes: MAX_FILE_BYTES,
    })
}

async fn get_server_settings(State(state): State<ShellState>) -> Json<ServerSettings> {
    Json(state.server_settings.get())
}

async fn update_server_settings(
    State(state): State<ShellState>,
    Json(request): Json<UpdateServerSettingsRequest>,
) -> Result<Json<ServerSettings>, ApiError> {
    state
        .server_settings
        .update_name(&request.name)
        .map(Json)
        .map_err(server_settings_error)
}

fn server_settings_error(error: ServerSettingsError) -> ApiError {
    match error {
        ServerSettingsError::EmptyName | ServerSettingsError::NameTooLong => ApiError::BadRequest {
            code: "invalid_server_name",
            message: error.to_string(),
        },
        ServerSettingsError::Read(_)
        | ServerSettingsError::Parse(_)
        | ServerSettingsError::Write(_)
        | ServerSettingsError::Encode(_) => ApiError::Internal(error.to_string()),
    }
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests;
