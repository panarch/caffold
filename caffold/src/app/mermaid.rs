//! Request-local Mermaid rendering. Merman owns syntax, layout and SVG output;
//! this route owns HTTP errors and the lifetime of CPU work.

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{State, rejection::JsonRejection},
    http::header,
    response::{IntoResponse, Response},
    routing::post,
};
use merman::{
    Engine, MermaidConfig, OperationControl, RenderError, RenderOutput, RenderRequest, Renderer,
    SvgRequest,
};
use serde::Deserialize;
use tokio::sync::Semaphore;

use super::error::ApiError;

// Keep layout work off the async runtime and leave CPU capacity for the rest
// of the app. Waiting requests do not occupy a blocking worker.
const RENDER_WORKERS: usize = 2;
const RENDER_DEADLINE: Duration = Duration::from_secs(5);

pub(super) fn router() -> Router {
    Router::new()
        .route("/api/mermaid/render", post(render))
        .with_state(Arc::new(Semaphore::new(RENDER_WORKERS)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Diagram {
    source: String,
    theme: Theme,
    font_family: String,
    font_size: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Theme {
    Light,
    Dark,
}

async fn render(
    State(workers): State<Arc<Semaphore>>,
    payload: Result<Json<Diagram>, JsonRejection>,
) -> Result<Response, ApiError> {
    let diagram = match payload {
        Ok(Json(diagram)) => diagram,
        Err(rejection) => return Ok((rejection.status(), Json(serde_json::json!({
            "error": ApiError::BadRequest { code: "mermaid_invalid_request", message: rejection.body_text() }.into_error_body(),
        }))).into_response()),
    };
    if !diagram.font_size.is_finite() || diagram.font_size <= 0.0 {
        return Err(ApiError::BadRequest {
            code: "mermaid_invalid_font_size",
            message: "Diagram font size must be positive.".into(),
        });
    }
    let permit = workers.acquire_owned().await.map_err(|_| unavailable())?;
    let control = OperationControl::new();
    let _cancel_on_drop = CancelOnDrop(control.clone());
    let svg = tokio::task::spawn_blocking(move || {
        // The worker owns its permit until rendering actually exits, even if
        // the HTTP future is dropped. Cancellation is cooperative, not a kill.
        let _permit = permit;
        render_svg(diagram, control.with_deadline(RENDER_DEADLINE))
    })
    .await
    .map_err(|_| unavailable())?
    .map_err(render_error)?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/svg+xml; charset=utf-8"),
            (header::CACHE_CONTROL, "no-store"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        svg,
    )
        .into_response())
}

fn render_svg(diagram: Diagram, control: OperationControl) -> Result<String, RenderError> {
    let config = MermaidConfig::from_value(serde_json::json!({
        "theme": match diagram.theme { Theme::Light => "default", Theme::Dark => "dark" },
        "fontFamily": diagram.font_family,
        "fontSize": diagram.font_size,
        "themeVariables": { "fontSize": format!("{}px", diagram.font_size) },
    }));
    let request = SvgRequest {
        options: merman::svg::SvgRenderOptions {
            diagram_id: Some(format!("mermaid-{}", uuid::Uuid::new_v4())),
            ..Default::default()
        },
        ..Default::default()
    };
    let output = Renderer::new()
        .with_engine(Engine::new().with_site_config(config))
        .render(RenderRequest::svg(&diagram.source, control, request))?;
    match output {
        RenderOutput::Svg(Some(svg)) => Ok(svg.into_parts().0),
        _ => Err(RenderError::NoDiagram),
    }
}

fn render_error(error: RenderError) -> ApiError {
    let message = error.to_string();
    match error {
        RenderError::Cancelled(_) => ApiError::Timeout {
            code: "mermaid_render_timeout",
            message,
        },
        RenderError::ResourceLimitExceeded(_) => ApiError::BadRequest {
            code: "mermaid_resource_limit",
            message,
        },
        RenderError::NoDiagram | RenderError::Parse(_) => ApiError::BadRequest {
            code: "mermaid_invalid_source",
            message,
        },
        RenderError::Svg(_) => ApiError::BadRequest {
            code: "mermaid_render_failed",
            message,
        },
        _ => unavailable(),
    }
}

fn unavailable() -> ApiError {
    ApiError::Unavailable {
        code: "mermaid_unavailable",
        message: "Diagram rendering is temporarily unavailable. Try again.".into(),
    }
}

struct CancelOnDrop(OperationControl);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    async fn request(source: &str, theme: &str, size: f64) -> Response {
        router().oneshot(Request::post("/api/mermaid/render")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({
                "source": source, "theme": theme, "fontFamily": "system-ui", "fontSize": size,
            }).to_string())).unwrap()).await.unwrap()
    }

    #[tokio::test]
    async fn svg_response_keeps_korean_text_and_has_unique_ids() {
        let source = "flowchart TD\nP[\"SQL planner\"] --> S[\"공용 scalar 표현식·준비·평가\"]\nE[Executor] --> S\nE --> A[\"Storage adapter\"]\nA --> S\nA --> B[\"redb 등 저장 엔진\"]";
        let first = request(source, "light", 14.0).await;
        assert_eq!(first.status(), StatusCode::OK);
        assert_eq!(
            first.headers()[header::CONTENT_TYPE],
            "image/svg+xml; charset=utf-8"
        );
        assert_eq!(first.headers()[header::CACHE_CONTROL], "no-store");
        let svg = String::from_utf8(
            to_bytes(first.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        assert!(svg.contains("<svg"));
        assert!(svg.contains("공용 scalar 표현식·준비·평가"));
        assert!(svg.contains("redb 등 저장 엔진"));
        let second = request(source, "dark", 20.0).await;
        assert_eq!(second.status(), StatusCode::OK);
        let dark = String::from_utf8(
            to_bytes(second.into_body(), usize::MAX)
                .await
                .unwrap()
                .to_vec(),
        )
        .unwrap();
        let root_id = |svg: &str| {
            svg.split("id=\"mermaid-")
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap()
                .to_owned()
        };
        assert_ne!(root_id(&svg), root_id(&dark));
        assert_ne!(svg, dark);
        assert!(dark.contains("20px"));
    }

    #[tokio::test]
    async fn errors_are_local_to_the_request() {
        for source in ["", "not a diagram", "flowchart TD\nA[unterminated"] {
            let response = request(source, "light", 14.0).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{source}");
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body["error"]["code"], "mermaid_invalid_source");
        }
        assert_eq!(
            request("sequenceDiagram\nA->>B: 다시 시도", "light", 14.0)
                .await
                .status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn supported_diagrams_and_normal_image_styles_use_library_output() {
        for source in [
            "classDiagram\nAnimal <|-- Duck\nAnimal : +String name",
            "erDiagram\nCUSTOMER ||--o{ ORDER : places",
            "flowchart TD\nsubgraph outer\nsubgraph inner\nA[긴 한글 라벨을 가진 노드] --> B\nend\nend",
            "flowchart LR\nA@{ img: \"https://example.com/logo.svg\", label: \"Logo\", h: 48 }\nA --> B\nstyle B fill:#ff0000",
            "flowchart LR\nA[Link] --> B\nclick A \"https://example.com/docs\"",
        ] {
            let response = request(source, "light", 14.0).await;
            assert_eq!(response.status(), StatusCode::OK, "{source}");
            let svg = String::from_utf8(
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .unwrap()
                    .to_vec(),
            )
            .unwrap();
            if source.contains("logo.svg") {
                assert!(svg.contains("<image"));
                assert!(svg.contains("https://example.com/logo.svg"));
                assert!(svg.contains("#ff0000"));
            }
            if source.contains("click A") {
                assert!(svg.contains("<a "));
                assert!(svg.contains("https://example.com/docs"));
            }
        }
    }

    #[tokio::test]
    async fn malformed_requests_keep_json_errors_and_http_status() {
        for (body, status) in [
            ("{}".to_owned(), StatusCode::UNPROCESSABLE_ENTITY),
            (
                "x".repeat(2 * 1024 * 1024 + 1),
                StatusCode::PAYLOAD_TOO_LARGE,
            ),
        ] {
            let response = router()
                .oneshot(
                    Request::post("/api/mermaid/render")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status);
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body["error"]["code"], "mermaid_invalid_request");
        }
        let response = request("flowchart LR\nA-->B", "light", 0.0).await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["error"]["code"], "mermaid_invalid_font_size");
    }

    #[tokio::test]
    async fn cancelling_a_queued_request_leaves_capacity_for_the_next() {
        let workers = Arc::new(Semaphore::new(1));
        let held = workers.clone().acquire_owned().await.unwrap();
        let diagram = || {
            Ok(Json(Diagram {
                source: "flowchart LR\nA-->B".into(),
                theme: Theme::Light,
                font_family: "system-ui".into(),
                font_size: 14.0,
            }))
        };
        let first = tokio::spawn(render(State(workers.clone()), diagram()));
        let second = tokio::spawn(render(State(workers.clone()), diagram()));
        tokio::task::yield_now().await;
        assert!(!first.is_finished());
        assert!(!second.is_finished());
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        drop(held);
        assert_eq!(second.await.unwrap().unwrap().status(), StatusCode::OK);
        assert_eq!(workers.available_permits(), 1);
        workers.close();
        assert!(matches!(
            render(State(workers), diagram()).await,
            Err(ApiError::Unavailable {
                code: "mermaid_unavailable",
                ..
            })
        ));
    }

    #[test]
    fn deadline_and_cancel_guard_use_library_cancellation() {
        let control = OperationControl::new();
        let guard = CancelOnDrop(control.clone());
        drop(guard);
        let diagram = || Diagram {
            source: "flowchart TD\nA-->B".into(),
            theme: Theme::Light,
            font_family: "system-ui".into(),
            font_size: 14.0,
        };
        assert!(matches!(
            render_svg(diagram(), control),
            Err(RenderError::Cancelled(merman::OperationCancelled {
                reason: merman::CancelReason::Requested,
                ..
            }))
        ));
        let error = render_svg(
            diagram(),
            OperationControl::new().with_deadline(Duration::ZERO),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            RenderError::Cancelled(merman::OperationCancelled {
                reason: merman::CancelReason::DeadlineExceeded,
                ..
            })
        ));
        assert!(matches!(
            render_error(error),
            ApiError::Timeout {
                code: "mermaid_render_timeout",
                ..
            }
        ));
    }

    #[tokio::test]
    async fn larger_layout_completes_under_the_route_deadline() {
        let mut source = "flowchart TD\n".to_owned();
        for i in 0..80 {
            source.push_str(&format!("N{i}[Node {i}] --> N{}\n", i + 1));
        }
        let started = std::time::Instant::now();
        let response = request(&source, "light", 14.0).await;
        assert_eq!(response.status(), StatusCode::OK);
        eprintln!("81-node flowchart rendered in {:?}", started.elapsed());
    }

    #[test]
    fn cancellation_and_library_resource_limits_are_preserved() {
        let control = OperationControl::new();
        control.cancel();
        let result = render_svg(
            Diagram {
                source: "flowchart TD\nA-->B".into(),
                theme: Theme::Light,
                font_family: "system-ui".into(),
                font_size: 14.0,
            },
            control,
        );
        assert!(matches!(
            result,
            Err(RenderError::Cancelled(merman::OperationCancelled {
                reason: merman::CancelReason::Requested,
                ..
            }))
        ));
        let limit = merman::resources::InputResourcePolicy::default()
            .value(merman::resources::InputResourceLimitId::MaxSourceBytes)
            .unwrap();
        let result = render_svg(
            Diagram {
                source: "x".repeat(limit + 1),
                theme: Theme::Light,
                font_family: "system-ui".into(),
                font_size: 14.0,
            },
            OperationControl::new(),
        );
        let error = result.unwrap_err();
        assert!(matches!(
            error,
            RenderError::ResourceLimitExceeded(merman::ResourceLimitExceeded {
                id: "max_source_bytes",
                ..
            })
        ));
        assert!(matches!(
            render_error(error),
            ApiError::BadRequest {
                code: "mermaid_resource_limit",
                ..
            }
        ));
    }
}
