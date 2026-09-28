mod cli;
mod status;

use std::{
    net::IpAddr,
    path::{Path, PathBuf},
    str::FromStr,
    sync::Arc,
};

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
use tracing::warn;
use url::Url;

use super::error::ApiError;
use cli::{ProcessTailscaleRunner, TailscaleExecutables, TailscaleRunner, summarize_output};
use status::{
    TailscaleNodeResponse, TailscaleReason, TailscaleState, TailscaleStatus,
    canonical_tailnet_url_value, classify_serve_status, command_failed_status,
};

const STATUS_COMMAND: &[&str] = &["status", "--json"];
const SERVE_STATUS_COMMAND: &[&str] = &["serve", "status", "--json"];

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
    failure_log: Arc<Mutex<FailureLog>>,
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
            failure_log: Arc::new(Mutex::new(FailureLog::default())),
        }
    }

    async fn refresh(&self) -> TailscaleStatus {
        let Ok(_operation) = self.operation.try_lock() else {
            return self.snapshot().await;
        };
        let inspection = self.inspect().await;
        self.publish(inspection.status, inspection.failure).await
    }

    async fn set_serve(&self, enabled: bool) -> Result<TailscaleStatus, TailscaleControlError> {
        let Ok(_operation) = self.operation.try_lock() else {
            return Err(TailscaleControlError::OperationInProgress);
        };
        let current = self.inspect().await;
        let should_run = if enabled {
            current.status.state == TailscaleState::ServeOff
        } else {
            current.status.state == TailscaleState::Ready
        };
        let Some(cli) = current.cli.filter(|_| should_run) else {
            return Ok(self.publish(current.status, current.failure).await);
        };

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
        self.publish(transition, None).await;

        let arguments: &[&str] = if enabled {
            &["serve", "--bg", "--yes", "--https=443", &self.target]
        } else {
            &["serve", "--yes", "--https=443", "off"]
        };
        if let Err(error) = self.runner.run(&cli, arguments).await {
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
            let failure = Failure {
                event: if enabled {
                    "tailscale serve could not be enabled"
                } else {
                    "tailscale serve could not be disabled"
                },
                detail: format!("{} {error}", command_line(&cli, arguments)),
            };
            return Ok(self.publish(failed, Some(failure)).await);
        }

        let inspected = self.inspect().await;
        let converged = if enabled {
            inspected.status.state == TailscaleState::Ready
        } else {
            inspected.status.state == TailscaleState::ServeOff
        };
        if converged
            || matches!(
                inspected.status.state,
                TailscaleState::Failed | TailscaleState::Unavailable
            )
        {
            return Ok(self.publish(inspected.status, inspected.failure).await);
        }
        let incomplete = TailscaleStatus::new(
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
        );
        let failure = Failure {
            event: "tailscale serve did not reach the requested state",
            detail: format!(
                "{} succeeded, but Tailscale then reported: {}",
                command_line(&cli, arguments),
                inspected.status.diagnostic_message
            ),
        };
        Ok(self.publish(incomplete, Some(failure)).await)
    }

    async fn inspect(&self) -> Inspection {
        let candidates = match self.runner.find_executables() {
            TailscaleExecutables::Found(candidates) => candidates,
            TailscaleExecutables::Missing { searched } => {
                let searched = searched
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect::<Vec<_>>();
                return Inspection {
                    status: TailscaleStatus::new(
                        TailscaleState::NotInstalled,
                        TailscaleReason::CliNotFound,
                        "Tailscale is not installed on this host.",
                    ),
                    failure: Some(Failure {
                        event: "tailscale CLI was not found",
                        detail: format!("searched {}", searched.join(", ")),
                    }),
                    cli: None,
                };
            }
        };

        let command_failed = || {
            command_failed_status(
                TailscaleReason::StatusCommandFailed,
                "Tailscale status could not be checked.",
            )
        };
        let mut reported = None;
        let mut attempts = Vec::new();
        for cli in candidates {
            let stdout = match self.runner.run(&cli, STATUS_COMMAND).await {
                Ok(stdout) => stdout,
                Err(error) => {
                    reported.get_or_insert_with(command_failed);
                    attempts.push(format!("{} {error}", command_line(&cli, STATUS_COMMAND)));
                    continue;
                }
            };
            let Ok(node) = serde_json::from_str::<TailscaleNodeResponse>(&stdout) else {
                reported.get_or_insert_with(|| {
                    command_failed_status(
                        TailscaleReason::StatusResponseInvalid,
                        "Tailscale returned an invalid status response.",
                    )
                });
                attempts.push(format!(
                    "{} returned an invalid response: {}",
                    command_line(&cli, STATUS_COMMAND),
                    summarize_output(&stdout)
                ));
                continue;
            };
            return self.inspect_connection(cli, node).await;
        }
        Inspection {
            status: reported.unwrap_or_else(command_failed),
            failure: Some(Failure {
                event: "tailscale status could not be read",
                detail: attempts.join("; "),
            }),
            cli: None,
        }
    }

    async fn inspect_connection(&self, cli: PathBuf, node: TailscaleNodeResponse) -> Inspection {
        if node.backend_state != "Running" {
            return Inspection {
                status: TailscaleStatus::new(
                    TailscaleState::Disconnected,
                    TailscaleReason::BackendNotRunning,
                    "Tailscale is installed but disconnected.",
                ),
                failure: None,
                cli: Some(cli),
            };
        }

        let stdout = match self.runner.run(&cli, SERVE_STATUS_COMMAND).await {
            Ok(stdout) => stdout,
            Err(error) => {
                return Inspection {
                    status: command_failed_status(
                        TailscaleReason::ServeStatusCommandFailed,
                        "Tailscale Serve status could not be checked.",
                    ),
                    failure: Some(Failure {
                        event: "tailscale serve status could not be read",
                        detail: format!("{} {error}", command_line(&cli, SERVE_STATUS_COMMAND)),
                    }),
                    cli: Some(cli),
                };
            }
        };
        let status = classify_serve_status(&stdout, &self.target);
        let failure = (status.state == TailscaleState::Failed).then(|| Failure {
            event: "tailscale serve status could not be read",
            detail: format!(
                "{}: {} Output: {}",
                command_line(&cli, SERVE_STATUS_COMMAND),
                status.diagnostic_message,
                summarize_output(&stdout)
            ),
        });
        Inspection {
            status,
            failure,
            cli: Some(cli),
        }
    }

    async fn snapshot(&self) -> TailscaleStatus {
        self.status.read().await.clone()
    }

    async fn publish(&self, status: TailscaleStatus, failure: Option<Failure>) -> TailscaleStatus {
        let mut failure_log = self.failure_log.lock().await;
        if let Some(failure) = failure_log.record(failure) {
            warn!(detail = %failure.detail, "{}", failure.event);
        }
        *self.status.write().await = status.clone();
        status
    }
}

struct Inspection {
    status: TailscaleStatus,
    failure: Option<Failure>,
    cli: Option<PathBuf>,
}

#[derive(PartialEq)]
struct Failure {
    event: &'static str,
    detail: String,
}

#[derive(Default)]
struct FailureLog {
    last: Option<Failure>,
}

impl FailureLog {
    fn record(&mut self, failure: Option<Failure>) -> Option<&Failure> {
        let is_new = failure.is_some() && self.last != failure;
        self.last = failure;
        self.last.as_ref().filter(|_| is_new)
    }
}

fn command_line(cli: &Path, arguments: &[&str]) -> String {
    format!("{} {}", cli.display(), arguments.join(" "))
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
        cli::{TailscaleCommandError, TailscaleCommandFuture},
        *,
    };

    const CLI: &str = "/usr/local/bin/tailscale";
    const HOMEBREW_CLI: &str = "/opt/homebrew/bin/tailscale";
    const APP_CLI: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

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
                output: String::new(),
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
                output: String::new(),
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
    async fn falls_back_to_the_next_cli_and_runs_serve_with_the_one_that_answered() {
        let runner = MockTailscaleRunner::with_executables(
            [HOMEBREW_CLI, APP_CLI],
            [
                response(false, "failed to connect to local Tailscale service"),
                response(true, node_status("Running")),
                response(true, r#"{"Web":{}}"#),
                response(true, ""),
                response(false, "failed to connect to local Tailscale service"),
                response(true, node_status("Running")),
                response(true, serve_status("http://127.0.0.1:5178")),
            ],
        );
        let ready = service(runner.clone()).set_serve(true).await.unwrap();
        assert_eq!(ready.state, TailscaleState::Ready);
        assert_eq!(
            runner.programs(),
            [
                HOMEBREW_CLI,
                APP_CLI,
                APP_CLI,
                APP_CLI,
                HOMEBREW_CLI,
                APP_CLI,
                APP_CLI
            ]
            .map(PathBuf::from)
        );
        assert_eq!(runner.calls()[3][..2], ["serve", "--bg"]);
    }

    #[test]
    fn logs_a_repeated_failure_once_until_it_changes_or_clears() {
        let mut log = FailureLog::default();
        let mut logged = |detail: Option<&str>| {
            log.record(detail.map(|detail| Failure {
                event: "tailscale status could not be read",
                detail: detail.to_string(),
            }))
            .map(|failure| failure.detail.clone())
        };

        assert_eq!(
            logged(Some("failed to connect")).as_deref(),
            Some("failed to connect")
        );
        assert_eq!(logged(Some("failed to connect")), None);
        assert_eq!(logged(Some("timed out")).as_deref(), Some("timed out"));
        assert_eq!(logged(None), None);
        assert_eq!(logged(Some("timed out")).as_deref(), Some("timed out"));
    }

    #[tokio::test]
    async fn logs_the_searched_paths_and_every_status_attempt() {
        let missing = service(MockTailscaleRunner::missing());
        missing.refresh().await;
        assert_eq!(
            logged_failure(&missing).await,
            Some(("tailscale CLI was not found", format!("searched {CLI}")))
        );

        let unreachable = service(MockTailscaleRunner::with_executables(
            [HOMEBREW_CLI, APP_CLI],
            [response(false, "failed to connect"), timed_out()],
        ));
        let failed = unreachable.refresh().await;
        assert_eq!(failed.state, TailscaleState::Failed);
        assert_eq!(failed.reason_code, TailscaleReason::StatusCommandFailed);
        assert_eq!(
            logged_failure(&unreachable).await,
            Some((
                "tailscale status could not be read",
                format!(
                    "{HOMEBREW_CLI} status --json exited with code 1: failed to connect; \
                     {APP_CLI} status --json did not finish within 10 seconds"
                )
            ))
        );
    }

    #[tokio::test]
    async fn logs_failed_serve_commands_and_unreadable_serve_status() {
        let enable = service(MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, r#"{"Web":{}}"#),
            response(false, "Serve is not enabled on your tailnet."),
        ]));
        let failed = enable.set_serve(true).await.unwrap();
        assert_eq!(
            failed.diagnostic_message,
            "Caffold's Tailscale Serve mapping could not be enabled."
        );
        assert_eq!(
            logged_failure(&enable).await,
            Some((
                "tailscale serve could not be enabled",
                format!(
                    "{CLI} serve --bg --yes --https=443 http://127.0.0.1:5178 exited with code 1: \
                     Serve is not enabled on your tailnet."
                )
            ))
        );

        let disable = service(MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, serve_status("http://127.0.0.1:5178")),
            response(false, "permission denied"),
        ]));
        disable.set_serve(false).await.unwrap();
        assert_eq!(
            logged_failure(&disable).await,
            Some((
                "tailscale serve could not be disabled",
                format!("{CLI} serve --yes --https=443 off exited with code 1: permission denied")
            ))
        );

        let unreadable = service(MockTailscaleRunner::with_responses([
            response(true, node_status("Running")),
            response(true, "not json"),
        ]));
        assert_eq!(
            unreadable.refresh().await.reason_code,
            TailscaleReason::ServeStatusResponseInvalid
        );
        assert_eq!(
            logged_failure(&unreadable).await,
            Some((
                "tailscale serve status could not be read",
                format!(
                    "{CLI} serve status --json: Tailscale returned an invalid Serve status response. \
                     Output: not json"
                )
            ))
        );
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

    fn response(success: bool, output: impl Into<String>) -> MockResponse {
        immediate(success, output)
    }

    fn immediate(success: bool, output: impl Into<String>) -> MockResponse {
        let output = output.into();
        MockResponse::Immediate(if success {
            Ok(output)
        } else {
            Err(TailscaleCommandError::Exited {
                code: Some(1),
                output,
            })
        })
    }

    fn timed_out() -> MockResponse {
        MockResponse::Immediate(Err(TailscaleCommandError::TimedOut))
    }

    async fn logged_failure(service: &TailscaleService) -> Option<(&'static str, String)> {
        let log = service.failure_log.lock().await;
        log.last
            .as_ref()
            .map(|failure| (failure.event, failure.detail.clone()))
    }

    #[derive(Clone)]
    struct MockTailscaleRunner {
        executables: Vec<PathBuf>,
        responses: Arc<StdMutex<VecDeque<MockResponse>>>,
        calls: Arc<StdMutex<Vec<MockCall>>>,
    }

    struct MockCall {
        program: PathBuf,
        arguments: Vec<String>,
    }

    impl MockTailscaleRunner {
        fn missing() -> Self {
            Self::with_executables([], [])
        }

        fn with_responses<const N: usize>(responses: [MockResponse; N]) -> Self {
            Self::with_mock_responses(responses)
        }

        fn with_mock_responses<const N: usize>(responses: [MockResponse; N]) -> Self {
            Self::with_executables([CLI], responses)
        }

        fn with_executables<const E: usize, const N: usize>(
            executables: [&str; E],
            responses: [MockResponse; N],
        ) -> Self {
            Self {
                executables: executables.map(PathBuf::from).into(),
                responses: Arc::new(StdMutex::new(responses.into())),
                calls: Arc::new(StdMutex::new(Vec::new())),
            }
        }

        fn calls(&self) -> Vec<Vec<String>> {
            let calls = self.calls.lock().unwrap();
            calls.iter().map(|call| call.arguments.clone()).collect()
        }

        fn programs(&self) -> Vec<PathBuf> {
            let calls = self.calls.lock().unwrap();
            calls.iter().map(|call| call.program.clone()).collect()
        }
    }

    impl TailscaleRunner for MockTailscaleRunner {
        fn find_executables(&self) -> TailscaleExecutables {
            if self.executables.is_empty() {
                TailscaleExecutables::Missing {
                    searched: vec![PathBuf::from(CLI)],
                }
            } else {
                TailscaleExecutables::Found(self.executables.clone())
            }
        }

        fn run(&self, executable: &Path, arguments: &[&str]) -> TailscaleCommandFuture {
            self.calls.lock().unwrap().push(MockCall {
                program: executable.to_path_buf(),
                arguments: arguments.iter().map(ToString::to_string).collect(),
            });
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
        Immediate(Result<String, TailscaleCommandError>),
        Gated {
            started: Arc<Notify>,
            release: Arc<Notify>,
            output: String,
        },
    }
}
