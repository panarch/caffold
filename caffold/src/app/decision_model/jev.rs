use std::collections::BTreeMap;

use reqwest::{Client, StatusCode, header::HeaderMap};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{
    DecisionFailure, NoJudgement, Question, REQUEST_TIMEOUT, Reading, Thresholds, keys::ApiKey,
};

pub(super) const API_BASE: &str = "https://api.typesafe.ai";

/// The model version every request names.
///
/// Jev's answers are read against fixed thresholds, and TypeSafe's guidance is
/// that a later version shifts where they sit. Naming the version keeps a
/// release from quietly becoming a different policy.
pub(super) const MODEL: &str = "jev-1.13.0";

/// Where Jev 1.13's answers become decisions.
///
/// Live testing put the line here: work inside a Task's worktree scored 14–32%
/// and a commit carrying a forbidden attribution 72–87%. The calibration cases
/// hold both questions to it.
pub(super) const THRESHOLDS: Thresholds = Thresholds {
    ask: 0.7,
    keep: 0.7,
};

/// The header TypeSafe's own refusals carry and Cloudflare's, in front of it,
/// do not.
const REQUEST_ID: &str = "x-typesafe-request-id";

/// The headers worth keeping from an answer that was not a judgement.
const TRACED_HEADERS: &[&str] = &[
    REQUEST_ID,
    "cf-ray",
    "x-envoy-upstream-service-time",
    "retry-after",
];

/// Asks Jev one question through `POST /v1/systemone` and reads back its
/// probability, refusing anything outside 0..=1.
///
/// The question is a `noul`, which answers with the probability that its
/// sentence is true of the state. Jev also offers a labelled choice and an
/// ordered score; Caffold asks neither, because each of its questions is
/// already a sentence that is either true or not.
///
/// A failed call is not made again: the refusals that recur are Cloudflare's,
/// and it refuses the same request every time. The response body is read only
/// when the request succeeded, because TypeSafe's body for a rejected key can
/// repeat part of that key.
pub(super) async fn read(
    client: &Client,
    api_base: &str,
    key: &ApiKey,
    state: &Value,
    question: Question,
) -> Result<Reading, NoJudgement> {
    let mut questions = Map::new();
    questions.insert(
        question.name.to_string(),
        json!({ "type": "noul", "instructions": question.instructions }),
    );
    let body = json!({ "model": MODEL, "state": state, "questions": questions });
    let response = client
        .post(format!("{api_base}/v1/systemone"))
        .bearer_auth(key.expose())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::to_vec(&body).expect("a JSON value serializes"))
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(NoJudgement::NoAnswer)?;
    let status = response.status();
    let headers = response.headers().clone();
    if !status.is_success() {
        return Err(no_judgement(status, headers));
    }
    let body = response.bytes().await.map_err(NoJudgement::NoAnswer)?;
    serde_json::from_slice::<SystemOneResponse>(&body)
        .ok()
        .and_then(|response| {
            let noul = response.answers.get(question.name)?.noul;
            (0.0..=1.0).contains(&noul).then_some(Reading {
                model: response.model,
                probability: noul,
            })
        })
        .ok_or(NoJudgement::Answered {
            failure: DecisionFailure::UnexpectedResponse,
            status,
            headers,
            traced: TRACED_HEADERS,
        })
}

#[derive(Debug, Deserialize)]
struct SystemOneResponse {
    model: String,
    answers: BTreeMap<String, Answer>,
}

#[derive(Debug, Deserialize)]
struct Answer {
    noul: f64,
}

fn no_judgement(status: StatusCode, headers: HeaderMap) -> NoJudgement {
    let failure = match status {
        StatusCode::FORBIDDEN if !headers.contains_key(REQUEST_ID) => DecisionFailure::Blocked,
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => DecisionFailure::KeyRejected,
        StatusCode::TOO_MANY_REQUESTS => DecisionFailure::RateLimited,
        StatusCode::REQUEST_TIMEOUT => DecisionFailure::Unavailable,
        status if status.is_server_error() => DecisionFailure::Unavailable,
        status if status.is_client_error() => DecisionFailure::Rejected,
        _ => DecisionFailure::UnexpectedResponse,
    };
    NoJudgement::Answered {
        failure,
        status,
        headers,
        traced: TRACED_HEADERS,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use axum::{Router, body::Bytes, http::Uri};
    use tempfile::TempDir;

    use super::*;
    use crate::app::decision_model::{DecisionModelProvider, keys::ApiKeyStore};

    const SECRET: &str = "ts-test-0123456789abcdef";
    const JUDGEMENT: &str = r#"{"model":"jev-1.13.0","answers":{"ask":{"noul":0.12}}}"#;
    const ASK: Question = Question {
        name: "ask",
        instructions: "the request needs a person",
    };

    #[derive(Default)]
    struct CapturedRequest {
        path: String,
        authorization: Option<String>,
        body: Vec<u8>,
    }

    fn api_key(temp: &TempDir) -> ApiKey {
        let store = ApiKeyStore::open(temp.path().join("decision-model"));
        store.store(DecisionModelProvider::Jev, SECRET).unwrap();
        store.key(DecisionModelProvider::Jev).unwrap().unwrap()
    }

    /// A stand-in for TypeSafe's own service, which marks every answer with a
    /// request id.
    async fn jev_server(
        status: StatusCode,
        body: &'static str,
        captured: Arc<Mutex<CapturedRequest>>,
    ) -> String {
        let app = Router::new().fallback(move |uri: Uri, headers: HeaderMap, request: Bytes| {
            let captured = captured.clone();
            async move {
                *captured.lock().unwrap() = CapturedRequest {
                    path: uri.path().to_string(),
                    authorization: headers
                        .get("authorization")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string),
                    body: request.to_vec(),
                };
                (
                    status,
                    [("content-type", "application/json"), (REQUEST_ID, "req_1")],
                    body,
                )
            }
        });
        serve(app).await
    }

    /// The same stand-in, answering each call in turn and repeating the last.
    async fn jev_server_answering_in_turn(
        answers: Vec<(StatusCode, &'static str)>,
    ) -> (String, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let app = Router::new().fallback(move || {
            let call = counted.fetch_add(1, Ordering::SeqCst);
            let (status, body) = answers[call.min(answers.len() - 1)];
            async move {
                (
                    status,
                    [("content-type", "application/json"), (REQUEST_ID, "req_1")],
                    body,
                )
            }
        });
        (serve(app).await, calls)
    }

    /// Cloudflare refusing a request in front of TypeSafe, as it answers one:
    /// an HTML page carrying none of TypeSafe's headers.
    async fn cloudflare_refusing() -> String {
        let app = Router::new().fallback(|| async {
            (
                StatusCode::FORBIDDEN,
                [
                    ("content-type", "text/html; charset=UTF-8"),
                    ("cf-ray", "a3fa5986cbbdf7d1-LAX"),
                ],
                "<title>Attention Required! | Cloudflare</title>",
            )
        });
        serve(app).await
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn sends_the_pinned_model_with_the_question_as_a_noul() {
        let temp = TempDir::new().unwrap();
        let captured = Arc::new(Mutex::new(CapturedRequest::default()));
        let base = jev_server(
            StatusCode::OK,
            r#"{"model":"jev-1.13.0","answers":{"ask":{"noul":0.91}}}"#,
            captured.clone(),
        )
        .await;

        let reading = read(
            &Client::new(),
            &base,
            &api_key(&temp),
            &json!({ "command": "ls" }),
            ASK,
        )
        .await
        .unwrap();

        assert_eq!(reading.model, "jev-1.13.0");
        assert_eq!(reading.probability, 0.91);
        let request = captured.lock().unwrap();
        assert_eq!(request.path, "/v1/systemone");
        assert_eq!(
            request.authorization.as_deref(),
            Some(&*format!("Bearer {SECRET}"))
        );
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["state"]["command"], "ls");
        assert_eq!(body["questions"]["ask"]["type"], "noul");
        assert_eq!(
            body["questions"]["ask"]["instructions"],
            "the request needs a person"
        );
    }

    #[tokio::test]
    async fn an_answer_outside_zero_to_one_is_not_a_judgement() {
        let temp = TempDir::new().unwrap();
        let base = jev_server(
            StatusCode::OK,
            r#"{"model":"jev-1.13.0","answers":{"ask":{"noul":1.5}}}"#,
            Arc::new(Mutex::new(CapturedRequest::default())),
        )
        .await;

        let failed = read(&Client::new(), &base, &api_key(&temp), &json!({}), ASK)
            .await
            .unwrap_err();

        assert_eq!(failed.failure(), DecisionFailure::UnexpectedResponse);
    }

    #[tokio::test]
    async fn a_missing_answer_is_not_a_judgement() {
        let temp = TempDir::new().unwrap();
        let base = jev_server(
            StatusCode::OK,
            r#"{"model":"jev-1.13.0","answers":{}}"#,
            Arc::new(Mutex::new(CapturedRequest::default())),
        )
        .await;

        let failed = read(&Client::new(), &base, &api_key(&temp), &json!({}), ASK)
            .await
            .unwrap_err();

        assert_eq!(failed.failure(), DecisionFailure::UnexpectedResponse);
    }

    #[tokio::test]
    async fn every_http_status_maps_to_its_own_failure() {
        let temp = TempDir::new().unwrap();
        let key = api_key(&temp);
        let cases = [
            (StatusCode::UNAUTHORIZED, DecisionFailure::KeyRejected),
            (StatusCode::FORBIDDEN, DecisionFailure::KeyRejected),
            (StatusCode::TOO_MANY_REQUESTS, DecisionFailure::RateLimited),
            (StatusCode::REQUEST_TIMEOUT, DecisionFailure::Unavailable),
            (StatusCode::BAD_GATEWAY, DecisionFailure::Unavailable),
            (StatusCode::BAD_REQUEST, DecisionFailure::Rejected),
        ];

        for (status, expected) in cases {
            let base = jev_server(
                status,
                r#"{"error":"ts-test-0123456789abcdef is invalid"}"#,
                Arc::new(Mutex::new(CapturedRequest::default())),
            )
            .await;

            let failed = read(&Client::new(), &base, &key, &json!({}), ASK)
                .await
                .unwrap_err();

            assert_eq!(failed.failure(), expected, "{status}");
            let message = failed.failure().message(DecisionModelProvider::Jev);
            assert!(!message.contains(SECRET));
            assert!(!failed.to_string().contains(SECRET));
        }
    }

    #[tokio::test]
    async fn a_refusal_from_cloudflare_is_told_apart_from_typesafe_s_own() {
        let temp = TempDir::new().unwrap();

        let failed = read(
            &Client::new(),
            &cloudflare_refusing().await,
            &api_key(&temp),
            &json!({}),
            ASK,
        )
        .await
        .unwrap_err();

        assert_eq!(failed.failure(), DecisionFailure::Blocked);
        assert_eq!(
            failed.failure().message(DecisionModelProvider::Jev),
            "Cloudflare, in front of TypeSafe, blocked the request before TypeSafe read it."
        );
        assert_eq!(
            failed.to_string(),
            "HTTP 403 Forbidden, cf-ray: a3fa5986cbbdf7d1-LAX"
        );
    }

    #[tokio::test]
    async fn a_failed_call_is_not_made_again() {
        let temp = TempDir::new().unwrap();
        let key = api_key(&temp);

        for status in [
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
        ] {
            let (base, calls) =
                jev_server_answering_in_turn(vec![(status, "{}"), (StatusCode::OK, JUDGEMENT)])
                    .await;

            read(&Client::new(), &base, &key, &json!({}), ASK)
                .await
                .unwrap_err();

            assert_eq!(calls.load(Ordering::SeqCst), 1, "{status}");
        }
    }

    #[tokio::test]
    async fn a_body_that_is_not_a_judgement_is_an_unexpected_response() {
        let temp = TempDir::new().unwrap();
        let base = jev_server(
            StatusCode::OK,
            r#"{"model":"jev-1.13.0"}"#,
            Arc::new(Mutex::new(CapturedRequest::default())),
        )
        .await;

        let failed = read(&Client::new(), &base, &api_key(&temp), &json!({}), ASK)
            .await
            .unwrap_err();

        assert_eq!(failed.failure(), DecisionFailure::UnexpectedResponse);
    }

    #[tokio::test]
    async fn an_unreachable_host_is_unavailable() {
        let temp = TempDir::new().unwrap();

        let failed = read(
            &Client::new(),
            "http://127.0.0.1:1",
            &api_key(&temp),
            &json!({}),
            ASK,
        )
        .await
        .unwrap_err();

        assert_eq!(failed.failure(), DecisionFailure::Unavailable);
    }

    #[test]
    fn a_failed_answer_is_logged_by_its_status_and_tracing_headers_alone() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("x-typesafe-request-id", "req_01"),
            ("cf-ray", "a3fa28d59daef8b7-LAX"),
            ("x-envoy-upstream-service-time", "23"),
            ("retry-after", "2"),
            ("www-authenticate", "Bearer ts-test-0123456789abcdef"),
            ("set-cookie", "session=private"),
        ] {
            headers.insert(name, value.parse().unwrap());
        }

        let failed = no_judgement(StatusCode::UNAUTHORIZED, headers);

        assert_eq!(
            failed.to_string(),
            "HTTP 401 Unauthorized, x-typesafe-request-id: req_01, \
             cf-ray: a3fa28d59daef8b7-LAX, x-envoy-upstream-service-time: 23, retry-after: 2"
        );
    }

    #[tokio::test]
    async fn a_call_that_got_no_answer_is_logged_with_what_caused_it() {
        let temp = TempDir::new().unwrap();
        let Err(NoJudgement::NoAnswer(error)) = read(
            &Client::new(),
            "http://127.0.0.1:1",
            &api_key(&temp),
            &json!({}),
            ASK,
        )
        .await
        else {
            panic!("an unreachable host gives no answer");
        };
        let outermost = error.to_string();

        let logged = NoJudgement::NoAnswer(error).to_string();

        assert!(logged.starts_with(&outermost));
        assert!(logged.len() > outermost.len(), "{logged}");
        assert!(!logged.contains(SECRET));
    }
}
