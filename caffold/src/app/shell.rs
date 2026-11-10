use std::sync::Arc;

use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};

use super::{error::ApiError, etag};
use crate::{
    fs::{MAX_FILE_BYTES, RootedFs},
    server_settings::{ServerIcon, ServerSettings, ServerSettingsError, ServerSettingsStore},
    static_assets,
};

mod foreground_recovery_diagnostics;
mod server_icon;

const SERVICE_WORKER_CACHE_NAME_PLACEHOLDER: &str = "\"caffold-shell-__CAFFOLD_BUILD_ID__\"";

#[derive(Clone)]
struct ShellState {
    fs: Arc<RootedFs>,
    server_settings: Arc<ServerSettingsStore>,
    initial_path: String,
    home_path: Option<String>,
}

/// The settings to change. A field left out keeps its value.
#[derive(Debug, Deserialize)]
struct UpdateServerSettingsRequest {
    name: Option<String>,
    icon: Option<String>,
}

/// The server's settings and the icons Settings offers, in their order.
#[derive(Debug, Serialize)]
struct ServerSettingsResponse {
    name: String,
    icon: ServerIcon,
    icons: Vec<ServerIconChoice>,
}

#[derive(Debug, Serialize)]
struct ServerIconChoice {
    id: &'static str,
    label: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
    /// The release version, which the build id does not carry.
    version: &'static str,
    build_id: &'static str,
    build_label: &'static str,
    build_number: &'static str,
    server_name: String,
    server_icon: ServerIcon,
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
            "/api/diagnostics/foreground-recovery",
            post(foreground_recovery_diagnostics::record_diagnostics),
        )
        .route(
            "/api/server/settings",
            get(get_server_settings).patch(update_server_settings),
        )
        .route("/service-worker.js", get(service_worker))
        .route("/assets/manifest.webmanifest", get(manifest))
        .route("/assets/{*path}", get(asset))
        .route("/icons/{icon}/{file}", get(server_icon_file))
        .route("/notes", get(index))
        .route("/notes/{*path}", get(index))
        .route("/settings", get(index))
        .route("/settings/{*path}", get(index))
        .route("/tasks", get(index))
        .route("/tasks/{*path}", get(index))
        .with_state(state)
}

async fn index(State(state): State<ShellState>) -> Response {
    let body = render_index(&state.server_settings.get());
    let mut response = Html(body).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn manifest(State(state): State<ShellState>) -> Result<Response, ApiError> {
    let body = render_manifest(&state.server_settings.get())?;
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

fn render_index(settings: &ServerSettings) -> String {
    static_assets::INDEX
        .replace("{{CAFFOLD_SERVER_NAME}}", &escape_html(&settings.name))
        .replace("{{CAFFOLD_SERVER_ICON}}", settings.icon.id())
}

fn render_manifest(settings: &ServerSettings) -> Result<Vec<u8>, ApiError> {
    let asset = static_assets::get("manifest.webmanifest")
        .ok_or_else(|| ApiError::Internal("PWA manifest asset is unavailable".to_string()))?;
    let mut manifest: JsonValue = serde_json::from_slice(asset.body)
        .map_err(|error| ApiError::Internal(format!("PWA manifest is invalid: {error}")))?;
    manifest["name"] = JsonValue::String(settings.name.clone());
    manifest["short_name"] = JsonValue::String(settings.name.clone());
    for icon in manifest["icons"].as_array_mut().into_iter().flatten() {
        let file = icon["src"]
            .as_str()
            .and_then(|src| src.rsplit('/').next())
            .unwrap_or_default();
        icon["src"] = JsonValue::String(format!("/icons/{}/{file}", settings.icon.id()));
    }
    serde_json::to_vec_pretty(&manifest)
        .map_err(|error| ApiError::Internal(format!("PWA manifest failed to encode: {error}")))
}

async fn service_worker() -> Result<Response, ApiError> {
    let asset = static_assets::get("service-worker.js")
        .ok_or_else(|| ApiError::Internal("service worker asset is unavailable".to_string()))?;
    let body = render_service_worker(asset.body, env!("CAFFOLD_BUILD_ID"))?;
    let mut response = Response::new(Body::from(body));
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
    Ok(response)
}

fn render_service_worker(source: &[u8], build_id: &str) -> Result<String, ApiError> {
    let source = std::str::from_utf8(source)
        .map_err(|error| ApiError::Internal(format!("service worker asset is invalid: {error}")))?;
    if source
        .matches(SERVICE_WORKER_CACHE_NAME_PLACEHOLDER)
        .count()
        != 1
    {
        return Err(ApiError::Internal(
            "service worker cache name placeholder is missing or duplicated".to_string(),
        ));
    }
    let cache_name =
        serde_json::to_string(&format!("caffold-shell-{build_id}")).map_err(|error| {
            ApiError::Internal(format!(
                "service worker cache name failed to encode: {error}"
            ))
        })?;
    Ok(source.replacen(SERVICE_WORKER_CACHE_NAME_PLACEHOLDER, &cache_name, 1))
}

async fn asset(AxumPath(path): AxumPath<String>, request: HeaderMap) -> Response {
    let Some(asset) = static_assets::get(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let tag = content_tag(asset.body);
    if etag::matches(&request, &tag) {
        return etag::not_modified(&tag);
    }
    (
        etag::headers(&tag),
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static(asset.content_type),
        )],
        Body::from(asset.body),
    )
        .into_response()
}

/// An icon file in one of the server's icons. `current` is whichever icon the
/// server shows now, for a notification drawn outside every page.
async fn server_icon_file(
    State(state): State<ShellState>,
    AxumPath((icon, file)): AxumPath<(String, String)>,
    request: HeaderMap,
) -> Result<Response, ApiError> {
    let icon = match icon.as_str() {
        "current" => Some(state.server_settings.get().icon),
        id => ServerIcon::from_id(id),
    };
    let Some(image) = icon.and_then(|icon| server_icon::image(icon, &file)) else {
        return Ok(StatusCode::NOT_FOUND.into_response());
    };
    let image = image.map_err(ApiError::Internal)?;
    let tag = content_tag(&image);
    if etag::matches(&request, &tag) {
        return Ok(etag::not_modified(&tag));
    }
    Ok((
        etag::headers(&tag),
        [(header::CONTENT_TYPE, HeaderValue::from_static("image/png"))],
        Body::from(image),
    )
        .into_response())
}

/// Name an asset by its contents, so a file a new build did not change keeps
/// its tag and the browser revalidates it instead of downloading it again.
fn content_tag(body: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(body))
}

async fn health(State(state): State<ShellState>) -> Json<HealthResponse> {
    let settings = state.server_settings.get();
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        build_id: env!("CAFFOLD_BUILD_ID"),
        build_label: env!("CAFFOLD_BUILD_LABEL"),
        build_number: env!("CAFFOLD_BUILD_NUMBER"),
        server_name: settings.name,
        server_icon: settings.icon,
        root: state.fs.root().display().to_string(),
        initial_path: state.initial_path,
        home_path: state.home_path,
        max_file_bytes: MAX_FILE_BYTES,
    })
}

async fn get_server_settings(State(state): State<ShellState>) -> Json<ServerSettingsResponse> {
    settings_response(state.server_settings.get())
}

async fn update_server_settings(
    State(state): State<ShellState>,
    Json(request): Json<UpdateServerSettingsRequest>,
) -> Result<Json<ServerSettingsResponse>, ApiError> {
    state
        .server_settings
        .update(request.name.as_deref(), request.icon.as_deref())
        .map(settings_response)
        .map_err(server_settings_error)
}

fn settings_response(settings: ServerSettings) -> Json<ServerSettingsResponse> {
    Json(ServerSettingsResponse {
        name: settings.name,
        icon: settings.icon,
        icons: ServerIcon::ALL
            .into_iter()
            .map(|icon| ServerIconChoice {
                id: icon.id(),
                label: icon.label(),
            })
            .collect(),
    })
}

fn server_settings_error(error: ServerSettingsError) -> ApiError {
    match error {
        ServerSettingsError::EmptyName | ServerSettingsError::NameTooLong => ApiError::BadRequest {
            code: "invalid_server_name",
            message: error.to_string(),
        },
        ServerSettingsError::UnknownIcon => ApiError::BadRequest {
            code: "invalid_server_icon",
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
mod tests {
    use axum::http::Request;
    use tower::ServiceExt;

    use super::*;

    #[test]
    fn server_name_and_icon_are_applied_to_install_metadata() {
        let index = render_index(&ServerSettings {
            name: "Caffold & Mac Studio".to_string(),
            icon: ServerIcon::Sky,
        });
        assert!(index.contains("<title>Caffold &amp; Mac Studio</title>"));
        assert!(index.contains("content=\"Caffold &amp; Mac Studio\""));
        assert!(index.contains("<meta name=\"caffold-server-icon\" content=\"sky\" />"));
        assert!(index.contains("href=\"/icons/sky/favicon-32.png\""));
        assert!(index.contains("href=\"/icons/sky/apple-touch-icon.png\""));
        assert!(!index.contains("{{CAFFOLD_SERVER_"));

        let manifest: JsonValue = serde_json::from_slice(
            &render_manifest(&ServerSettings {
                name: "Caffold Studio".to_string(),
                icon: ServerIcon::Gold,
            })
            .unwrap(),
        )
        .unwrap();
        assert_eq!(manifest["name"], "Caffold Studio");
        assert_eq!(manifest["short_name"], "Caffold Studio");
        assert_eq!(manifest["id"], "/");
        assert_eq!(manifest["display"], "standalone");
        assert_eq!(manifest["theme_color"], "#ffffff");
        assert_eq!(manifest["background_color"], "#f5f5f5");
        let icons: Vec<_> = manifest["icons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|icon| {
                (
                    icon["src"].as_str().unwrap(),
                    icon["purpose"].as_str().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            icons,
            [
                ("/icons/gold/icon-192.png", "any"),
                ("/icons/gold/icon-512.png", "any"),
                ("/icons/gold/maskable-192.png", "maskable"),
                ("/icons/gold/maskable-512.png", "maskable"),
            ]
        );
    }

    #[test]
    fn service_worker_cache_name_uses_safely_serialized_build_id() {
        let source = static_assets::get("service-worker.js")
            .expect("service worker asset")
            .body;
        let first = render_service_worker(source, "first-build").unwrap();
        let second = render_service_worker(source, "second\"\\\nbuild").unwrap();

        assert!(
            first.starts_with("\"use strict\";\nconst CACHE_NAME = \"caffold-shell-first-build\";")
        );
        assert!(second.starts_with(
            "\"use strict\";\nconst CACHE_NAME = \"caffold-shell-second\\\"\\\\\\nbuild\";"
        ));
        assert_ne!(first, second);
        assert!(!first.contains("__CAFFOLD_BUILD_ID__"));
        assert!(!second.contains("__CAFFOLD_BUILD_ID__"));
    }

    #[tokio::test]
    async fn health_names_the_release_version_beside_the_build() {
        let root = tempfile::tempdir().unwrap();
        let state = ShellState {
            fs: Arc::new(RootedFs::new(root.path().to_path_buf()).unwrap()),
            server_settings: Arc::new(ServerSettingsStore::memory()),
            initial_path: String::new(),
            home_path: None,
        };

        state
            .server_settings
            .update(Some("Caffold Linux"), Some("lime"))
            .unwrap();

        let Json(health) = health(State(state)).await;

        let health = serde_json::to_value(health).unwrap();
        assert_eq!(health["status"], "ok");
        assert_eq!(health["version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(health["buildId"], env!("CAFFOLD_BUILD_ID"));
        assert_eq!(health["serverName"], "Caffold Linux");
        assert_eq!(health["serverIcon"], "lime");
    }

    #[tokio::test]
    async fn settings_offer_every_icon_and_change_only_the_fields_sent() {
        let (_root, router) = shell_router();

        let settings = settings_request(&router, "GET", None).await;
        assert_eq!(settings.0, StatusCode::OK);
        assert_eq!(settings.1["name"], "Caffold");
        assert_eq!(settings.1["icon"], "default");
        let icons = settings.1["icons"].as_array().unwrap();
        assert_eq!(icons.len(), 12);
        assert_eq!(
            icons[0],
            serde_json::json!({"id": "default", "label": "Default"})
        );
        assert_eq!(
            icons[11],
            serde_json::json!({"id": "pink", "label": "Pink"})
        );

        let icon = settings_request(&router, "PATCH", Some(r#"{"icon":"violet"}"#)).await;
        assert_eq!(icon.0, StatusCode::OK);
        assert_eq!(icon.1["name"], "Caffold");
        assert_eq!(icon.1["icon"], "violet");
        assert_eq!(icon.1["icons"].as_array().unwrap().len(), 12);

        // The menu-bar app sends only the name.
        let name = settings_request(&router, "PATCH", Some(r#"{"name":" Caffold Studio "}"#)).await;
        assert_eq!(name.0, StatusCode::OK);
        assert_eq!(name.1["name"], "Caffold Studio");
        assert_eq!(name.1["icon"], "violet");
    }

    #[tokio::test]
    async fn an_icon_caffold_does_not_offer_is_refused() {
        let (_root, router) = shell_router();

        let refused = settings_request(
            &router,
            "PATCH",
            Some(r#"{"name":"Elsewhere","icon":"Red"}"#),
        )
        .await;

        assert_eq!(refused.0, StatusCode::BAD_REQUEST);
        assert_eq!(refused.1["error"]["code"], "invalid_server_icon");
        let settings = settings_request(&router, "GET", None).await.1;
        assert_eq!(settings["name"], "Caffold");
        assert_eq!(settings["icon"], "default");
    }

    #[tokio::test]
    async fn icon_files_are_drawn_in_the_icon_named_and_revalidated_before_use() {
        let (_root, router) = shell_router();
        let original = static_assets::get("icons/favicon-32.png").unwrap().body;

        let default = get_path(&router, "/icons/default/favicon-32.png", None).await;
        assert_eq!(default.status(), StatusCode::OK);
        assert_eq!(default.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(default.headers()[header::CACHE_CONTROL], "no-cache");
        assert_eq!(body(default).await, original);

        let red = get_path(&router, "/icons/red/favicon-32.png", None).await;
        assert_eq!(red.status(), StatusCode::OK);
        let tag = red.headers()[header::ETAG].to_str().unwrap().to_string();
        let red = body(red).await;
        assert!(red.starts_with(b"\x89PNG"));
        assert_ne!(red, original);

        let held = get_path(&router, "/icons/red/favicon-32.png", Some(&tag)).await;
        assert_eq!(held.status(), StatusCode::NOT_MODIFIED);
        assert!(body(held).await.is_empty());
        let blue = get_path(&router, "/icons/blue/favicon-32.png", Some(&tag)).await;
        assert_eq!(blue.status(), StatusCode::OK);

        for missing in [
            "/icons/chartreuse/favicon-32.png",
            "/icons/Red/favicon-32.png",
            "/icons/red/unknown.png",
            "/icons/red/manifest.webmanifest",
        ] {
            let response = get_path(&router, missing, Some("*")).await;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{missing}");
            assert!(response.headers().get(header::ETAG).is_none(), "{missing}");
        }
    }

    #[tokio::test]
    async fn the_page_and_manifest_carry_the_saved_name_and_icon() {
        let (_root, router) = shell_router();
        settings_request(
            &router,
            "PATCH",
            Some(r#"{"name":"Caffold Linux","icon":"purple"}"#),
        )
        .await;

        let page = get_path(&router, "/settings/name-and-icon", None).await;
        assert_eq!(page.headers()[header::CACHE_CONTROL], "no-cache");
        let page = String::from_utf8(body(page).await).unwrap();
        assert!(page.contains("<title>Caffold Linux</title>"));
        assert!(page.contains("href=\"/icons/purple/favicon-32.png\""));

        let manifest = get_path(&router, "/assets/manifest.webmanifest", None).await;
        assert_eq!(manifest.headers()[header::CACHE_CONTROL], "no-cache");
        let manifest: JsonValue = serde_json::from_slice(&body(manifest).await).unwrap();
        assert_eq!(manifest["name"], "Caffold Linux");
        assert_eq!(manifest["icons"][0]["src"], "/icons/purple/icon-192.png");
    }

    #[tokio::test]
    async fn the_current_icon_follows_the_saved_icon() {
        let (_root, router) = shell_router();
        let default = body(get_path(&router, "/icons/current/icon-192.png", None).await).await;
        assert_eq!(
            default,
            static_assets::get("icons/icon-192.png").unwrap().body
        );

        settings_request(&router, "PATCH", Some(r#"{"icon":"green"}"#)).await;

        let current = body(get_path(&router, "/icons/current/icon-192.png", None).await).await;
        let green = body(get_path(&router, "/icons/green/icon-192.png", None).await).await;
        assert_eq!(current, green);
        assert_ne!(current, default);
    }

    #[tokio::test]
    async fn assets_are_tagged_by_their_contents_and_revalidated_before_use() {
        let (_root, router) = shell_router();
        let script = static_assets::get("app.js").unwrap();

        let response = get_asset(&router, "app.js", None).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            script.content_type
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
        let tag = response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_string();
        assert_eq!(
            tag,
            format!(
                "\"{}\"",
                URL_SAFE_NO_PAD.encode(Sha256::digest(script.body))
            )
        );
        assert_eq!(body(response).await, script.body);
        let again = get_asset(&router, "app.js", None).await;
        assert_eq!(again.headers()[header::ETAG], tag.as_str());
        let font = get_asset(&router, "fonts/GeistSans-Variable.woff2", None).await;
        assert_ne!(font.headers()[header::ETAG], tag.as_str());
    }

    #[tokio::test]
    async fn an_asset_the_browser_already_holds_is_answered_without_its_body() {
        let (_root, router) = shell_router();
        let tag = get_asset(&router, "app.js", None).await.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .to_string();

        for held in [
            tag.clone(),
            format!("W/{tag}"),
            format!("\"elsewhere,1\", {tag}"),
            "*".to_string(),
        ] {
            let response = get_asset(&router, "app.js", Some(&held)).await;
            assert_eq!(response.status(), StatusCode::NOT_MODIFIED, "{held}");
            assert_eq!(response.headers()[header::ETAG], tag.as_str());
            assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
            assert!(body(response).await.is_empty());
        }

        let changed = get_asset(&router, "app.js", Some("\"an-older-build\"")).await;
        assert_eq!(changed.status(), StatusCode::OK);
        assert_eq!(
            body(changed).await,
            static_assets::get("app.js").unwrap().body
        );
    }

    #[tokio::test]
    async fn a_missing_asset_is_not_tagged() {
        let (_root, router) = shell_router();

        let response = get_asset(&router, "missing.js", Some("*")).await;

        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert!(response.headers().get(header::ETAG).is_none());
    }

    fn shell_router() -> (tempfile::TempDir, Router) {
        let root = tempfile::tempdir().unwrap();
        let router = router(
            Arc::new(RootedFs::new(root.path().to_path_buf()).unwrap()),
            Arc::new(ServerSettingsStore::memory()),
            String::new(),
            None,
        );
        (root, router)
    }

    async fn get_asset(router: &Router, path: &str, if_none_match: Option<&str>) -> Response {
        get_path(router, &format!("/assets/{path}"), if_none_match).await
    }

    async fn get_path(router: &Router, path: &str, if_none_match: Option<&str>) -> Response {
        let mut request = Request::builder().uri(path);
        if let Some(held) = if_none_match {
            request = request.header(header::IF_NONE_MATCH, held);
        }
        router
            .clone()
            .oneshot(request.body(Body::empty()).unwrap())
            .await
            .unwrap()
    }

    async fn settings_request(
        router: &Router,
        method: &str,
        json: Option<&str>,
    ) -> (StatusCode, JsonValue) {
        let request = Request::builder()
            .method(method)
            .uri("/api/server/settings")
            .header(header::CONTENT_TYPE, "application/json")
            .body(json.map_or_else(Body::empty, |json| Body::from(json.to_string())))
            .unwrap();
        let response = router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        (
            status,
            serde_json::from_slice(&body(response).await).unwrap(),
        )
    }

    async fn body(response: Response) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }
}
