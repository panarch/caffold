//! HTTP routes for language servers: Settings → Language Servers, a
//! repository's switch in Task details, and the code viewers' definition and
//! reference questions. Turning languages and repositories on starts
//! processes, so those requests must come from the same origin.

use std::{collections::BTreeSet, str::FromStr};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::{HeaderMap, header, uri::Authority},
    routing::{get, patch, post},
};
use serde::{Deserialize, Serialize};
use url::Url;

use super::error::ApiError;
use crate::language_servers::{
    Failure, Language, LanguageServerError, LanguageServers, LanguageSetting, Place,
    RepositoryUsage, ServerState, ServerUsage,
};

pub(super) fn router(language_servers: LanguageServers) -> Router {
    Router::new()
        .route("/api/language-servers", get(languages))
        .route("/api/language-servers/settings", patch(update_languages))
        .route("/api/language-servers/running", get(running))
        .route(
            "/api/language-servers/repository",
            get(repository).put(update_repository),
        )
        .route(
            "/api/language-servers/repository/check",
            post(recheck_repository),
        )
        .route("/api/language-servers/definition", post(definition))
        .route("/api/language-servers/references", post(references))
        .with_state(language_servers)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LanguagesResponse {
    languages: Vec<LanguageResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LanguageResponse {
    id: Language,
    name: &'static str,
    enabled: bool,
    server_name: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateLanguagesRequest {
    languages: BTreeSet<Language>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RunningResponse {
    servers: Vec<ServerResponse>,
    total_memory_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryResponse {
    path: String,
    enabled: bool,
    servers: Vec<ServerResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerResponse {
    repository_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    repository_branch: Option<String>,
    language: Language,
    language_name: &'static str,
    /// The extensions of the files the server reads.
    extensions: Vec<&'static str>,
    server_name: &'static str,
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<FailureResponse>,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_bytes: Option<u64>,
}

/// Why a server is not answering, by which check failed. Only a server that
/// did not start or that stopped carries what it said.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum FailureResponse {
    #[serde(rename_all = "camelCase")]
    NotInstalled {
        #[serde(skip_serializing_if = "Option::is_none")]
        toolchain: Option<String>,
        install_command: String,
        check_command: String,
    },
    CouldNotStart {
        reason: String,
    },
    Stopped,
}

#[derive(Deserialize)]
struct RepositoryQuery {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRepositoryRequest {
    path: String,
    enabled: bool,
}

#[derive(Deserialize)]
struct RecheckRepositoryRequest {
    path: String,
}

/// A name in a file: `line` is one-based like the viewers' line numbers,
/// `character` a zero-based UTF-16 offset.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PositionRequest {
    path: String,
    line: u32,
    character: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlacesResponse {
    places: Vec<PlaceResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaceResponse {
    /// The logical path, or `null` outside the browsing root.
    path: Option<String>,
    name: String,
    line: u32,
    character: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    length: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

async fn languages(
    State(language_servers): State<LanguageServers>,
) -> Result<Json<LanguagesResponse>, ApiError> {
    let languages = language_servers.languages().await.map_err(api_error)?;
    Ok(Json(languages_response(languages)))
}

async fn update_languages(
    State(language_servers): State<LanguageServers>,
    headers: HeaderMap,
    Json(request): Json<UpdateLanguagesRequest>,
) -> Result<Json<LanguagesResponse>, ApiError> {
    require_same_origin(&headers)?;
    let languages = language_servers
        .set_languages(request.languages)
        .await
        .map_err(api_error)?;
    Ok(Json(languages_response(languages)))
}

async fn running(State(language_servers): State<LanguageServers>) -> Json<RunningResponse> {
    let servers = language_servers.servers().await;
    let total_memory_bytes = servers
        .iter()
        .filter_map(|server| server.memory_bytes)
        .sum();
    Json(RunningResponse {
        servers: servers.into_iter().map(server_response).collect(),
        total_memory_bytes,
    })
}

async fn repository(
    State(language_servers): State<LanguageServers>,
    Query(query): Query<RepositoryQuery>,
) -> Result<Json<RepositoryResponse>, ApiError> {
    let repository = language_servers
        .repository(&query.path)
        .await
        .map_err(api_error)?;
    Ok(Json(repository_response(repository)))
}

async fn update_repository(
    State(language_servers): State<LanguageServers>,
    headers: HeaderMap,
    Json(request): Json<UpdateRepositoryRequest>,
) -> Result<Json<RepositoryResponse>, ApiError> {
    require_same_origin(&headers)?;
    let repository = language_servers
        .set_repository(&request.path, request.enabled)
        .await
        .map_err(api_error)?;
    Ok(Json(repository_response(repository)))
}

/// Looks for the repository's failed servers again; one found starts, so
/// this requires the same origin as turning a repository on.
async fn recheck_repository(
    State(language_servers): State<LanguageServers>,
    headers: HeaderMap,
    Json(request): Json<RecheckRepositoryRequest>,
) -> Result<Json<RepositoryResponse>, ApiError> {
    require_same_origin(&headers)?;
    let repository = language_servers
        .recheck_repository(&request.path)
        .await
        .map_err(api_error)?;
    Ok(Json(repository_response(repository)))
}

async fn definition(
    State(language_servers): State<LanguageServers>,
    Json(request): Json<PositionRequest>,
) -> Result<Json<PlacesResponse>, ApiError> {
    let places = language_servers
        .definition(&request.path, request.line, request.character)
        .await
        .map_err(api_error)?;
    Ok(Json(places_response(places)))
}

async fn references(
    State(language_servers): State<LanguageServers>,
    Json(request): Json<PositionRequest>,
) -> Result<Json<PlacesResponse>, ApiError> {
    let places = language_servers
        .references(&request.path, request.line, request.character)
        .await
        .map_err(api_error)?;
    Ok(Json(places_response(places)))
}

fn languages_response(languages: Vec<LanguageSetting>) -> LanguagesResponse {
    LanguagesResponse {
        languages: languages
            .into_iter()
            .map(|setting| {
                let language = setting.language;
                LanguageResponse {
                    id: language,
                    name: language.name(),
                    enabled: setting.enabled,
                    server_name: language.server_name(),
                }
            })
            .collect(),
    }
}

fn repository_response(repository: RepositoryUsage) -> RepositoryResponse {
    RepositoryResponse {
        path: repository.path,
        enabled: repository.enabled,
        servers: repository
            .servers
            .into_iter()
            .map(server_response)
            .collect(),
    }
}

fn server_response(usage: ServerUsage) -> ServerResponse {
    let language = usage.server.language;
    let (state, progress, failure) = match usage.server.state {
        ServerState::Off => ("off", None, None),
        ServerState::Starting { progress } => ("starting", progress, None),
        ServerState::Ready => ("ready", None, None),
        ServerState::Sleeping => ("sleeping", None, None),
        ServerState::Failed(failure) => ("failed", None, Some(failure_response(failure))),
    };
    ServerResponse {
        repository_path: usage.server.repository,
        repository_branch: usage.branch,
        language,
        language_name: language.name(),
        extensions: language.extensions(),
        server_name: language.server_name(),
        state,
        progress,
        failure,
        memory_bytes: usage.memory_bytes,
    }
}

fn failure_response(failure: Failure) -> FailureResponse {
    match failure {
        Failure::NotInstalled(missing) => FailureResponse::NotInstalled {
            toolchain: missing.toolchain,
            install_command: missing.install_command,
            check_command: missing.check_command,
        },
        Failure::CouldNotStart { reason } => FailureResponse::CouldNotStart { reason },
        Failure::Stopped => FailureResponse::Stopped,
    }
}

fn places_response(places: Vec<Place>) -> PlacesResponse {
    PlacesResponse {
        places: places
            .into_iter()
            .map(|place| PlaceResponse {
                path: place.path,
                name: place.name,
                line: place.line,
                character: place.character,
                length: place.length,
                text: place.text,
            })
            .collect(),
    }
}

fn api_error(error: LanguageServerError) -> ApiError {
    let message = error.to_string();
    match error {
        LanguageServerError::Fs(error) => error.into(),
        LanguageServerError::Watch(error) => error.into(),
        LanguageServerError::UnsupportedFile => ApiError::BadRequest {
            code: "language_server_unsupported_file",
            message,
        },
        LanguageServerError::NotText => ApiError::BadRequest {
            code: "language_server_file_not_text",
            message,
        },
        LanguageServerError::NotReady(ServerState::Off) => ApiError::Conflict {
            code: "language_server_off",
            message: "Language servers are off for this repository.".to_string(),
        },
        LanguageServerError::NotReady(ServerState::Failed(failure)) => ApiError::Conflict {
            code: "language_server_failed",
            message: match failure {
                Failure::NotInstalled(missing) => match missing.toolchain {
                    Some(toolchain) => {
                        format!(
                            "The language server is not installed for the {toolchain} toolchain."
                        )
                    }
                    None => "The language server is not installed.".to_string(),
                },
                Failure::CouldNotStart { reason } => reason,
                Failure::Stopped => "The language server stopped.".to_string(),
            },
        },
        LanguageServerError::NotReady(_) => ApiError::Conflict {
            code: "language_server_starting",
            message: "The language server is getting ready.".to_string(),
        },
        LanguageServerError::Settings(message) => ApiError::Unavailable {
            code: "language_server_settings_unavailable",
            message,
        },
        LanguageServerError::Request(message) => ApiError::Unavailable {
            code: "language_server_request_failed",
            message,
        },
    }
}

fn require_same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(same_origin_required)?;
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(same_origin_required)?;
    if !same_origin_host(origin, host) {
        return Err(same_origin_required());
    }
    Ok(())
}

fn same_origin_host(origin: &str, request_host: &str) -> bool {
    let Ok(origin) = Url::parse(origin) else {
        return false;
    };
    let Ok(authority) = Authority::from_str(request_host) else {
        return false;
    };
    if !matches!(origin.scheme(), "http" | "https")
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !origin.username().is_empty()
        || origin.password().is_some()
    {
        return false;
    }
    let Some(origin_host) = origin.host_str() else {
        return false;
    };
    if !origin_host.eq_ignore_ascii_case(authority.host()) {
        return false;
    }
    let request_port = authority.port_u16().or_else(|| match origin.scheme() {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    });
    request_port == origin.port_or_known_default()
}

fn same_origin_required() -> ApiError {
    ApiError::Forbidden {
        code: "same_origin_language_server_control_required",
        message: "Turning language servers on or off requires a same-origin request.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, sync::Arc};

    use axum::{
        body::Body,
        http::{Request, StatusCode},
        response::Response,
    };
    use serde_json::{Value, json};
    use tempfile::TempDir;
    use tokio::sync::broadcast;
    use tower::ServiceExt;

    use super::*;
    use crate::{fs::RootedFs, language_servers::MissingServer, watch::WatchHub};

    fn app(root: &Path) -> Router {
        let fs = Arc::new(RootedFs::new(root).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let watch = WatchHub::new(fs.clone(), shutdown);
        router(LanguageServers::open(&root.join("data"), fs, watch))
    }

    fn project() -> TempDir {
        let root = TempDir::new().unwrap();
        fs::create_dir_all(root.path().join("repo/src")).unwrap();
        fs::write(root.path().join("repo/Cargo.toml"), "").unwrap();
        fs::write(root.path().join("repo/src/main.rs"), "fn main() {}\n").unwrap();
        fs::write(root.path().join("repo/notes.md"), "# Notes\n").unwrap();
        let initialized = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(root.path().join("repo"))
            .status()
            .unwrap();
        assert!(initialized.success());
        root
    }

    async fn send(
        app: Router,
        method: &str,
        uri: &str,
        body: Option<Value>,
        same_origin: bool,
    ) -> Response {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "localhost:5178");
        if same_origin {
            request = request.header("origin", "http://localhost:5178");
        }
        let body = match body {
            Some(body) => {
                request = request.header(header::CONTENT_TYPE, "application/json");
                Body::from(body.to_string())
            }
            None => Body::empty(),
        };
        app.oneshot(request.body(body).unwrap()).await.unwrap()
    }

    async fn json_body(response: Response) -> Value {
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn every_language_starts_off_with_its_server_name() {
        let root = project();

        let response = send(
            app(root.path()),
            "GET",
            "/api/language-servers",
            None,
            false,
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(
            body["languages"],
            json!([
                { "id": "rust", "name": "Rust", "enabled": false, "serverName": "rust-analyzer" },
                {
                    "id": "typescript",
                    "name": "TypeScript/JavaScript",
                    "enabled": false,
                    "serverName": "typescript-language-server",
                },
            ])
        );
    }

    #[test]
    fn a_failure_says_which_check_failed_and_what_installing_takes() {
        let not_installed = failure_response(Failure::NotInstalled(MissingServer {
            toolchain: Some("1.94-aarch64-apple-darwin".to_string()),
            install_command:
                "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin"
                    .to_string(),
            check_command: "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version"
                .to_string(),
        }));
        let could_not_start = failure_response(Failure::CouldNotStart {
            reason: "could not load the sysroot".to_string(),
        });
        let stopped = failure_response(Failure::Stopped);

        assert_eq!(
            serde_json::to_value(not_installed).unwrap(),
            json!({
                "kind": "notInstalled",
                "toolchain": "1.94-aarch64-apple-darwin",
                "installCommand": "rustup component add rust-analyzer rust-src --toolchain 1.94-aarch64-apple-darwin",
                "checkCommand": "rustup run 1.94-aarch64-apple-darwin rust-analyzer --version",
            })
        );
        assert_eq!(
            serde_json::to_value(could_not_start).unwrap(),
            json!({ "kind": "couldNotStart", "reason": "could not load the sysroot" })
        );
        assert_eq!(
            serde_json::to_value(stopped).unwrap(),
            json!({ "kind": "stopped" })
        );
    }

    #[tokio::test]
    async fn turning_things_on_requires_the_same_origin() {
        let root = project();
        let app = app(root.path());

        let languages = send(
            app.clone(),
            "PATCH",
            "/api/language-servers/settings",
            Some(json!({ "languages": ["rust"] })),
            false,
        )
        .await;
        let repository = send(
            app.clone(),
            "PUT",
            "/api/language-servers/repository",
            Some(json!({ "path": "repo", "enabled": true })),
            false,
        )
        .await;
        let recheck = send(
            app,
            "POST",
            "/api/language-servers/repository/check",
            Some(json!({ "path": "repo" })),
            false,
        )
        .await;

        assert_eq!(languages.status(), StatusCode::FORBIDDEN);
        assert_eq!(repository.status(), StatusCode::FORBIDDEN);
        assert_eq!(recheck.status(), StatusCode::FORBIDDEN);
        assert!(
            !root
                .path()
                .join("data/language-servers/settings.json")
                .exists()
        );
    }

    #[tokio::test]
    async fn a_repository_lists_the_turned_on_languages_it_holds() {
        let root = project();
        let app = app(root.path());
        let turned_on = send(
            app.clone(),
            "PATCH",
            "/api/language-servers/settings",
            Some(json!({ "languages": ["rust", "typescript"] })),
            true,
        )
        .await;
        assert_eq!(turned_on.status(), StatusCode::OK);

        let response = send(
            app.clone(),
            "GET",
            "/api/language-servers/repository?path=repo/src",
            None,
            false,
        )
        .await;

        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["path"], "repo");
        assert_eq!(body["enabled"], false);
        assert_eq!(body["servers"][0]["language"], "rust");
        assert_eq!(body["servers"][0]["state"], "off");
        assert_eq!(body["servers"].as_array().unwrap().len(), 1);

        let rechecked = send(
            app,
            "POST",
            "/api/language-servers/repository/check",
            Some(json!({ "path": "repo/src" })),
            true,
        )
        .await;
        assert_eq!(rechecked.status(), StatusCode::OK);
        assert_eq!(json_body(rechecked).await, body);
    }

    #[tokio::test]
    async fn a_turned_on_repository_answers_definitions_and_references() {
        let root = project();
        fs::write(
            root.path().join("repo/src/main.rs"),
            "fn main() {\n    helper();\n}\n",
        )
        .unwrap();
        fs::write(
            root.path().join("repo/src/target.rs"),
            "// The helper.\n\npub fn helper() {}\n",
        )
        .unwrap();
        let rooted = Arc::new(RootedFs::new(root.path()).unwrap());
        let (shutdown, _) = broadcast::channel(1);
        let watch = WatchHub::new(rooted.clone(), shutdown);
        let language_servers =
            LanguageServers::with_fake_server(&root.path().join("data"), rooted, watch);
        let app = router(language_servers.clone());
        let languages = json!({ "languages": ["rust"] });
        let turned_on = send(
            app.clone(),
            "PATCH",
            "/api/language-servers/settings",
            Some(languages),
            true,
        );
        assert_eq!(turned_on.await.status(), StatusCode::OK);

        let repository = json!({ "path": "repo", "enabled": true });
        let response = send(
            app.clone(),
            "PUT",
            "/api/language-servers/repository",
            Some(repository),
            true,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["enabled"], true);
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let response = send(
                app.clone(),
                "GET",
                "/api/language-servers/repository?path=repo",
                None,
                false,
            )
            .await;
            let body = json_body(response).await;
            if body["servers"][0]["state"] == "ready" {
                assert_eq!(body["servers"][0]["extensions"], json!(["rs"]));
                break;
            }
            assert!(tokio::time::Instant::now() < deadline, "not ready: {body}");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let position = json!({ "path": "repo/src/main.rs", "line": 2, "character": 4 });

        let definition = send(
            app.clone(),
            "POST",
            "/api/language-servers/definition",
            Some(position.clone()),
            false,
        )
        .await;
        let references = send(
            app,
            "POST",
            "/api/language-servers/references",
            Some(position),
            false,
        )
        .await;

        assert_eq!(
            json_body(definition).await,
            json!({ "places": [{
                "path": "repo/src/target.rs",
                "name": "target.rs",
                "line": 3,
                "character": 7,
                "length": 6,
                "text": "pub fn helper() {}",
            }] })
        );
        assert_eq!(
            json_body(references).await,
            json!({ "places": [{
                "path": "repo/src/main.rs",
                "name": "main.rs",
                "line": 2,
                "character": 4,
                "length": 6,
                "text": "    helper();",
            }] })
        );
        language_servers.shutdown().await;
    }

    #[tokio::test]
    async fn questions_need_a_supported_file_and_a_turned_on_repository() {
        let root = project();
        let app = app(root.path());
        let position = |path: &str| Some(json!({ "path": path, "line": 1, "character": 3 }));

        let markdown = send(
            app.clone(),
            "POST",
            "/api/language-servers/definition",
            position("repo/notes.md"),
            false,
        )
        .await;
        let off = send(
            app.clone(),
            "POST",
            "/api/language-servers/references",
            position("repo/src/main.rs"),
            false,
        )
        .await;
        let missing = send(
            app,
            "POST",
            "/api/language-servers/definition",
            position("repo/src/gone.rs"),
            false,
        )
        .await;

        assert_eq!(markdown.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_body(markdown).await["error"]["code"],
            "language_server_unsupported_file"
        );
        assert_eq!(off.status(), StatusCode::CONFLICT);
        assert_eq!(json_body(off).await["error"]["code"], "language_server_off");
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn nothing_runs_while_nothing_is_on() {
        let root = project();

        let response = send(
            app(root.path()),
            "GET",
            "/api/language-servers/running",
            None,
            false,
        )
        .await;

        assert_eq!(
            json_body(response).await,
            json!({ "servers": [], "totalMemoryBytes": 0 })
        );
    }
}
