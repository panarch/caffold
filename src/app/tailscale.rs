mod cli;
mod status;

use std::{net::IpAddr, str::FromStr, sync::Arc};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Query, State},
    http::{
        HeaderMap, HeaderValue,
        header::{CACHE_CONTROL, CONTENT_TYPE, HOST, X_CONTENT_TYPE_OPTIONS},
        uri::Authority,
    },
    response::IntoResponse,
    routing::{get, put},
};
use qrcode::{EcLevel, QrCode, render::svg};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};
use url::Url;

use super::error::ApiError;
use cli::{ProcessTailscaleRunner, TailscaleRunner};
use status::{
    TailscaleNodeResponse, TailscaleReason, TailscaleState, TailscaleStatus,
    canonical_tailnet_url_value, classify_serve_status, command_failed_status,
};

pub(super) fn router(port: u16) -> Router {
    router_with_service(TailscaleService::new(
        format!("http://127.0.0.1:{port}"),
        Arc::new(ProcessTailscaleRunner),
    ))
}

fn router_with_service(service: TailscaleService) -> Router {
    Router::new()
        .route("/api/tailscale/status", get(tailscale_status))
        .route(
            "/api/tailscale/serve",
            put(update_tailscale_serve).layer(DefaultBodyLimit::max(1_024)),
        )
        .route("/api/tailscale/qr.svg", get(tailscale_qr))
        .with_state(service)
}

async fn tailscale_status(
    State(service): State<TailscaleService>,
    headers: HeaderMap,
) -> Json<TailscaleStatusResponse> {
    Json(TailscaleStatusResponse::new(
        service.refresh().await,
        is_local_request(&headers),
    ))
}

async fn update_tailscale_serve(
    State(service): State<TailscaleService>,
    headers: HeaderMap,
    Json(request): Json<UpdateTailscaleServeRequest>,
) -> Result<Json<TailscaleStatusResponse>, ApiError> {
    require_local_request(&headers)?;
    let status = service.set_serve(request.enabled).await.map_err(
        |TailscaleControlError::OperationInProgress| ApiError::Conflict {
            code: "tailscale_operation_in_progress",
            message: "A Tailscale Serve operation is already in progress.".to_string(),
        },
    )?;
    Ok(Json(TailscaleStatusResponse::new(status, true)))
}

async fn tailscale_qr(
    Query(request): Query<TailscaleQrRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let url = canonical_tailnet_url_value(&request.url).ok_or_else(|| ApiError::BadRequest {
        code: "invalid_tailnet_qr_url",
        message: "The QR code URL must be a canonical private Tailnet address.".to_string(),
    })?;
    let code = QrCode::with_error_correction_level(url.as_bytes(), EcLevel::M).map_err(|_| {
        ApiError::BadRequest {
            code: "invalid_tailnet_qr_url",
            message: "The private Tailnet address could not be encoded as a QR code.".to_string(),
        }
    })?;
    let body = code
        .render::<svg::Color>()
        .min_dimensions(256, 256)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();
    let mut headers = HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    headers.insert(
        CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    Ok((headers, body))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TailscaleStatusResponse {
    #[serde(flatten)]
    status: TailscaleStatus,
    can_manage: bool,
}

impl TailscaleStatusResponse {
    fn new(status: TailscaleStatus, can_manage: bool) -> Self {
        Self { status, can_manage }
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateTailscaleServeRequest {
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TailscaleQrRequest {
    url: String,
}

#[derive(Clone)]
struct TailscaleService {
    target: Arc<str>,
    runner: Arc<dyn TailscaleRunner>,
    operation: Arc<Mutex<()>>,
    status: Arc<RwLock<TailscaleStatus>>,
}

impl TailscaleService {
    fn new(target: String, runner: Arc<dyn TailscaleRunner>) -> Self {
        Self {
            target: target.into(),
            runner,
            operation: Arc::new(Mutex::new(())),
            status: Arc::new(RwLock::new(TailscaleStatus::new(
                TailscaleState::Unavailable,
                TailscaleReason::StatusNotChecked,
                "Tailscale status has not been checked yet.",
            ))),
        }
    }

    async fn refresh(&self) -> TailscaleStatus {
        let Ok(_operation) = self.operation.try_lock() else {
            return self.snapshot().await;
        };
        let status = self.inspect().await;
        self.publish(status.clone()).await;
        status
    }

    async fn set_serve(&self, enabled: bool) -> Result<TailscaleStatus, TailscaleControlError> {
        let Ok(_operation) = self.operation.try_lock() else {
            return Err(TailscaleControlError::OperationInProgress);
        };
        let current = self.inspect().await;
        let should_run = if enabled {
            current.state == TailscaleState::ServeOff
        } else {
            current.state == TailscaleState::Ready
        };
        if !should_run {
            self.publish(current.clone()).await;
            return Ok(current);
        }

        let transition = if enabled {
            TailscaleStatus::new(
                TailscaleState::Configuring,
                TailscaleReason::ConfiguringServe,
                "Configuring Caffold's Tailscale Serve mapping.",
            )
        } else {
            TailscaleStatus::new(
                TailscaleState::Disabling,
                TailscaleReason::DisablingServe,
                "Disabling Caffold's Tailscale Serve mapping.",
            )
        };
        self.publish(transition).await;

        let arguments = if enabled {
            vec![
                "serve".to_string(),
                "--bg".to_string(),
                "--yes".to_string(),
                "--https=443".to_string(),
                self.target.to_string(),
            ]
        } else {
            vec![
                "serve".to_string(),
                "--yes".to_string(),
                "--https=443".to_string(),
                "off".to_string(),
            ]
        };
        let command = self.runner.run(arguments).await;
        if !matches!(command, Ok(output) if output.success) {
            let failed = TailscaleStatus::new(
                TailscaleState::Failed,
                if enabled {
                    TailscaleReason::ServeEnableFailed
                } else {
                    TailscaleReason::ServeDisableFailed
                },
                if enabled {
                    "Caffold's Tailscale Serve mapping could not be enabled."
                } else {
                    "Caffold's Tailscale Serve mapping could not be disabled."
                },
            );
            self.publish(failed.clone()).await;
            return Ok(failed);
        }

        let inspected = self.inspect().await;
        let converged = if enabled {
            inspected.state == TailscaleState::Ready
        } else {
            inspected.state == TailscaleState::ServeOff
        };
        let status = if converged
            || matches!(
                inspected.state,
                TailscaleState::Failed | TailscaleState::Unavailable
            ) {
            inspected
        } else {
            TailscaleStatus::new(
                TailscaleState::Failed,
                if enabled {
                    TailscaleReason::ServeEnableIncomplete
                } else {
                    TailscaleReason::ServeDisableIncomplete
                },
                if enabled {
                    "Tailscale completed the command, but Caffold's Serve mapping is not ready."
                } else {
                    "Tailscale completed the command, but Caffold's Serve mapping is still enabled."
                },
            )
        };
        self.publish(status.clone()).await;
        Ok(status)
    }

    async fn inspect(&self) -> TailscaleStatus {
        if !self.runner.is_available() {
            return TailscaleStatus::new(
                TailscaleState::NotInstalled,
                TailscaleReason::CliNotFound,
                "Tailscale is not installed on this host.",
            );
        }

        let status_command = self
            .runner
            .run(vec!["status".to_string(), "--json".to_string()])
            .await;
        let Ok(status_command) = status_command else {
            return command_failed_status(
                TailscaleReason::StatusCommandFailed,
                "Tailscale status could not be checked.",
            );
        };
        if !status_command.success {
            return command_failed_status(
                TailscaleReason::StatusCommandFailed,
                "Tailscale status could not be checked.",
            );
        }
        let Ok(node) = serde_json::from_str::<TailscaleNodeResponse>(&status_command.stdout) else {
            return command_failed_status(
                TailscaleReason::StatusResponseInvalid,
                "Tailscale returned an invalid status response.",
            );
        };
        if node.backend_state != "Running" {
            return TailscaleStatus::new(
                TailscaleState::Disconnected,
                TailscaleReason::BackendNotRunning,
                "Tailscale is installed but disconnected.",
            );
        }

        let serve_command = self
            .runner
            .run(vec![
                "serve".to_string(),
                "status".to_string(),
                "--json".to_string(),
            ])
            .await;
        let Ok(serve_command) = serve_command else {
            return command_failed_status(
                TailscaleReason::ServeStatusCommandFailed,
                "Tailscale Serve status could not be checked.",
            );
        };
        if !serve_command.success {
            return command_failed_status(
                TailscaleReason::ServeStatusCommandFailed,
                "Tailscale Serve status could not be checked.",
            );
        }
        classify_serve_status(&serve_command.stdout, &self.target)
    }

    async fn snapshot(&self) -> TailscaleStatus {
        self.status.read().await.clone()
    }

    async fn publish(&self, status: TailscaleStatus) {
        *self.status.write().await = status;
    }
}

#[derive(Debug)]
enum TailscaleControlError {
    OperationInProgress,
}

fn require_local_request(headers: &HeaderMap) -> Result<(), ApiError> {
    if !is_local_request(headers) {
        return Err(ApiError::Forbidden {
            code: "local_tailscale_control_required",
            message: "Tailscale Serve can only be changed from the Caffold host.".to_string(),
        });
    }
    if let Some(origin) = headers.get("origin") {
        let origin = origin.to_str().ok();
        let host = headers.get(HOST).and_then(|value| value.to_str().ok());
        if !matches!((origin, host), (Some(origin), Some(host)) if same_origin(origin, host)) {
            return Err(ApiError::Forbidden {
                code: "same_origin_tailscale_control_required",
                message: "Tailscale Serve changes require a same-origin request.".to_string(),
            });
        }
    }
    Ok(())
}

fn is_local_request(headers: &HeaderMap) -> bool {
    headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .and_then(|host| Authority::from_str(host).ok())
        .is_some_and(|authority| is_loopback_host(authority.host()))
}

fn same_origin(origin: &str, request_host: &str) -> bool {
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
        || !origin
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case(authority.host()))
    {
        return false;
    }
    let request_port = authority.port_u16().or_else(|| match origin.scheme() {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    });
    request_port == origin.port_or_known_default()
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .trim_matches(['[', ']'])
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        sync::{Arc, Mutex as StdMutex},
    };

    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use serde_json::Value;
    use tokio::sync::Notify;
    use tower::ServiceExt;

    use super::{
        cli::{TailscaleCommandError, TailscaleCommandFuture, TailscaleCommandOutput},
        *,
    };

    #[tokio::test]
    async fn classifies_installation_connection_serve_and_failure_states() {
        let missing = service(MockTailscaleRunner::missing()).refresh().await;
        assert_eq!(missing.state, TailscaleState::NotInstalled);
        assert_eq!(missing.reason_code, TailscaleReason::CliNotFound);

        let disconnected = service(MockTailscaleRunner::with_responses([response(
            true,
            node_status("Stopped"),
        )]))
        .refresh()
        .await;
        assert_eq!(disconnected.state, TailscaleState::Disconnected);

        let off = service(MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, r#"{"Web":{}}"#),
        ]))
        .refresh()
        .await;
        assert_eq!(off.state, TailscaleState::ServeOff);

        let ready = service(MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, serve_status("http://127.0.0.1:5178")),
        ]))
        .refresh()
        .await;
        assert_eq!(ready.state, TailscaleState::Ready);
        assert_eq!(
            ready.tailnet_url.as_deref(),
            Some("https://studio.example.ts.net/")
        );

        let failed = service(MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(false, "serve status failed"),
        ]))
        .refresh()
        .await;
        assert_eq!(failed.state, TailscaleState::Failed);
        assert_eq!(
            failed.reason_code,
            TailscaleReason::ServeStatusCommandFailed
        );
    }

    #[tokio::test]
    async fn rejects_invalid_node_responses_and_foreign_serve_ownership() {
        let invalid_node = service(MockTailscaleRunner::with_responses([response(
            true, "not json",
        )]))
        .refresh()
        .await;
        assert_eq!(
            invalid_node.reason_code,
            TailscaleReason::StatusResponseInvalid
        );

        let conflict_runner = MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, serve_status("http://127.0.0.1:9999")),
        ]);
        let conflict = service(conflict_runner.clone())
            .set_serve(true)
            .await
            .unwrap();
        assert_eq!(conflict.state, TailscaleState::Unavailable);
        assert_eq!(conflict.reason_code, TailscaleReason::ServeTargetConflict);
        assert_eq!(conflict_runner.calls().len(), 2);
    }

    #[tokio::test]
    async fn enabling_publishes_transition_and_uses_only_the_caffold_target() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let runner = MockTailscaleRunner::with_mock_responses([
            immediate(true, node_status("Running")),
            immediate(true, r#"{"Web":{}}"#),
            MockResponse::Gated {
                started: started.clone(),
                release: release.clone(),
                output: output(true, ""),
            },
            immediate(true, node_status("Running")),
            immediate(true, serve_status("http://127.0.0.1:5178")),
        ]);
        let service = service(runner.clone());
        let operation = {
            let service = service.clone();
            tokio::spawn(async move { service.set_serve(true).await.unwrap() })
        };
        started.notified().await;
        assert_eq!(service.snapshot().await.state, TailscaleState::Configuring);
        assert!(matches!(
            service.set_serve(false).await,
            Err(TailscaleControlError::OperationInProgress)
        ));
        release.notify_one();
        assert_eq!(operation.await.unwrap().state, TailscaleState::Ready);
        assert_eq!(
            runner.calls()[2],
            [
                "serve",
                "--bg",
                "--yes",
                "--https=443",
                "http://127.0.0.1:5178",
            ]
        );
    }

    #[tokio::test]
    async fn disabling_revalidates_ownership_and_publishes_transition() {
        let started = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let runner = MockTailscaleRunner::with_mock_responses([
            immediate(true, node_status("Running")),
            immediate(true, serve_status("http://127.0.0.1:5178")),
            MockResponse::Gated {
                started: started.clone(),
                release: release.clone(),
                output: output(true, ""),
            },
            immediate(true, node_status("Running")),
            immediate(true, r#"{"Web":{}}"#),
        ]);
        let service = service(runner.clone());
        let operation = {
            let service = service.clone();
            tokio::spawn(async move { service.set_serve(false).await.unwrap() })
        };
        started.notified().await;
        assert_eq!(service.snapshot().await.state, TailscaleState::Disabling);
        release.notify_one();
        assert_eq!(operation.await.unwrap().state, TailscaleState::ServeOff);
        assert_eq!(runner.calls()[2], ["serve", "--yes", "--https=443", "off"]);
    }

    #[tokio::test]
    async fn reports_command_and_convergence_failures_without_expanding_the_operation() {
        let enable_runner = MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, r#"{"Web":{}}"#),
            response(false, "command details stay private"),
        ]);
        let failed_enable = service(enable_runner.clone())
            .set_serve(true)
            .await
            .unwrap();
        assert_eq!(failed_enable.state, TailscaleState::Failed);
        assert_eq!(
            failed_enable.reason_code,
            TailscaleReason::ServeEnableFailed
        );
        assert_eq!(enable_runner.calls().len(), 3);

        let disable_runner = MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, serve_status("http://127.0.0.1:5178")),
            response(true, ""),
            response(true, node_status("Running")),
            response(true, serve_status("http://127.0.0.1:5178")),
        ]);
        let incomplete_disable = service(disable_runner.clone())
            .set_serve(false)
            .await
            .unwrap();
        assert_eq!(incomplete_disable.state, TailscaleState::Failed);
        assert_eq!(
            incomplete_disable.reason_code,
            TailscaleReason::ServeDisableIncomplete
        );
        assert_eq!(disable_runner.calls().len(), 5);
    }

    #[tokio::test]
    async fn renders_qr_svg_only_for_a_canonical_private_tailnet_url() {
        let app = router_with_service(service(MockTailscaleRunner::with_responses([])));
        let response = app
            .oneshot(
                Request::get("/api/tailscale/qr.svg?url=https%3A%2F%2Fstudio.example.ts.net%2F")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "image/svg+xml; charset=utf-8"
        );
        assert_eq!(response.headers()[X_CONTENT_TYPE_OPTIONS], "nosniff");
        let body = to_bytes(response.into_body(), 65_536).await.unwrap();
        let svg = std::str::from_utf8(&body).unwrap();
        assert!(svg.starts_with("<?xml"));
        assert!(svg.contains("<svg"));
        assert!(svg.contains("<path"));

        let invalid = router_with_service(service(MockTailscaleRunner::with_responses([])));
        let response = invalid
            .oneshot(
                Request::get("/api/tailscale/qr.svg?url=https%3A%2F%2Fexample.com%2F")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn exposes_status_remotely_but_restricts_serve_changes_to_local_origin() {
        let remote_runner = MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, serve_status("http://127.0.0.1:5178")),
        ]);
        let remote = router_with_service(service(remote_runner));
        let response = remote
            .oneshot(
                Request::get("/api/tailscale/status")
                    .header(HOST, "studio.example.ts.net")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        assert_eq!(body["state"], "ready");
        assert_eq!(body["canManage"], false);

        let denied_runner = MockTailscaleRunner::with_responses([]);
        let denied = router_with_service(service(denied_runner.clone()));
        let response = denied
            .oneshot(
                Request::put("/api/tailscale/serve")
                    .header(HOST, "studio.example.ts.net")
                    .header("origin", "https://studio.example.ts.net")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(denied_runner.calls().is_empty());
    }

    #[tokio::test]
    async fn accepts_local_same_origin_control_and_rejects_foreign_origins() {
        let foreign_runner = MockTailscaleRunner::with_responses([]);
        let foreign = router_with_service(service(foreign_runner.clone()));
        let foreign_response = foreign
            .oneshot(
                Request::put("/api/tailscale/serve")
                    .header(HOST, "127.0.0.1:5178")
                    .header("origin", "https://example.test")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(foreign_response.status(), StatusCode::FORBIDDEN);
        assert!(foreign_runner.calls().is_empty());

        let local_runner =
            MockTailscaleRunner::with_responses([response(true, node_status("Stopped"))]);
        let local = router_with_service(service(local_runner.clone()));
        let local_response = local
            .oneshot(
                Request::put("/api/tailscale/serve")
                    .header(HOST, "127.0.0.1:5178")
                    .header("origin", "http://127.0.0.1:5178")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"enabled":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(local_response.status(), StatusCode::OK);
        assert_eq!(local_runner.calls(), [["status", "--json"]]);

        let expanded_runner = MockTailscaleRunner::with_responses([]);
        let expanded = router_with_service(service(expanded_runner.clone()));
        let expanded_response = expanded
            .oneshot(
                Request::put("/api/tailscale/serve")
                    .header(HOST, "127.0.0.1:5178")
                    .header("origin", "http://127.0.0.1:5178")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"enabled":true,"target":"http://127.0.0.1:9999"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(expanded_response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert!(expanded_runner.calls().is_empty());
    }

    fn service(runner: MockTailscaleRunner) -> TailscaleService {
        TailscaleService::new("http://127.0.0.1:5178".to_string(), Arc::new(runner))
    }

    fn node_status(state: &str) -> String {
        format!(r#"{{"BackendState":"{state}"}}"#)
    }

    fn serve_status(target: &str) -> String {
        format!(
            r#"{{"Web":{{"studio.example.ts.net:443":{{"Handlers":{{"/":{{"Proxy":"{target}"}}}}}}}}}}"#
        )
    }

    fn response(success: bool, stdout: impl Into<String>) -> MockResponse {
        immediate(success, stdout)
    }

    fn immediate(success: bool, stdout: impl Into<String>) -> MockResponse {
        MockResponse::Immediate(Ok(output(success, stdout)))
    }

    fn output(success: bool, stdout: impl Into<String>) -> TailscaleCommandOutput {
        TailscaleCommandOutput {
            success,
            stdout: stdout.into(),
        }
    }

    #[derive(Clone)]
    struct MockTailscaleRunner {
        available: bool,
        responses: Arc<StdMutex<VecDeque<MockResponse>>>,
        calls: Arc<StdMutex<Vec<Vec<String>>>>,
    }

    impl MockTailscaleRunner {
        fn missing() -> Self {
            Self {
                available: false,
                responses: Arc::new(StdMutex::new(VecDeque::new())),
                calls: Arc::new(StdMutex::new(Vec::new())),
            }
        }

        fn with_responses<const N: usize>(responses: [MockResponse; N]) -> Self {
            Self::with_mock_responses(responses)
        }

        fn with_mock_responses<const N: usize>(responses: [MockResponse; N]) -> Self {
            Self {
                available: true,
                responses: Arc::new(StdMutex::new(responses.into())),
                calls: Arc::new(StdMutex::new(Vec::new())),
            }
        }

        fn calls(&self) -> Vec<Vec<String>> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl TailscaleRunner for MockTailscaleRunner {
        fn is_available(&self) -> bool {
            self.available
        }

        fn run(&self, arguments: Vec<String>) -> TailscaleCommandFuture {
            self.calls.lock().unwrap().push(arguments);
            let response = self.responses.lock().unwrap().pop_front().unwrap();
            Box::pin(async move {
                match response {
                    MockResponse::Immediate(result) => result,
                    MockResponse::Gated {
                        started,
                        release,
                        output,
                    } => {
                        started.notify_one();
                        release.notified().await;
                        Ok(output)
                    }
                }
            })
        }
    }

    enum MockResponse {
        Immediate(Result<TailscaleCommandOutput, TailscaleCommandError>),
        Gated {
            started: Arc<Notify>,
            release: Arc<Notify>,
            output: TailscaleCommandOutput,
        },
    }
}
