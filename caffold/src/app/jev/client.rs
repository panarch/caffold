use std::{collections::BTreeMap, error::Error as _, fmt, time::Duration};

use reqwest::{Client, StatusCode, header::HeaderMap};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::keys::ApiKey;

pub(super) const API_BASE: &str = "https://api.typesafe.ai";

/// The model version every request names.
///
/// Jev's answers are read against a fixed threshold, and TypeSafe's guidance is
/// that a later version shifts where that threshold sits. Naming the version
/// keeps a release from quietly becoming a different policy.
pub(super) const MODEL: &str = "jev-1.13.0";

/// How long a judgement may take before the request becomes the person's.
///
/// TypeSafe answers in 70-500ms. The turn is already blocked while Caffold
/// waits, but the person must not be, so the wait is bounded well above the
/// expected answer and far below a person's patience.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

/// The header TypeSafe's own refusals carry and Cloudflare's, in front of it,
/// do not.
const REQUEST_ID: &str = "x-typesafe-request-id";

/// One state and the yes-or-no questions asked against it.
///
/// Every question is a `noul`, which answers with the probability that its
/// sentence is true of the state. Jev also offers a labelled choice and an
/// ordered score; Caffold asks neither, because each of its questions is
/// already a sentence that is either true or not.
pub(super) struct Query {
    state: Value,
    questions: BTreeMap<&'static str, String>,
}

impl Query {
    pub(super) fn new(state: Value) -> Self {
        Self {
            state,
            questions: BTreeMap::new(),
        }
    }

    pub(super) fn asking(mut self, name: &'static str, instructions: impl Into<String>) -> Self {
        self.questions.insert(name, instructions.into());
        self
    }

    fn body(&self) -> Value {
        let questions: BTreeMap<&str, Value> = self
            .questions
            .iter()
            .map(|(name, instructions)| {
                (
                    *name,
                    json!({ "type": "noul", "instructions": instructions }),
                )
            })
            .collect();
        json!({
            "model": MODEL,
            "state": self.state,
            "questions": questions,
        })
    }
}

/// The probability Jev gave one question, and which model version gave it.
#[derive(Debug)]
pub(super) struct Reading {
    pub(super) model: String,
    pub(super) noul: f64,
}

/// Why Jev returned no judgement.
///
/// Every one of these ends the same way for a person — the request stays
/// theirs to answer — but they are kept apart so Settings and the log can say
/// which one it was.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum JevFailure {
    /// Cloudflare, in front of TypeSafe, refused the request before TypeSafe
    /// read it. It judges the wording, so the same request is refused again.
    Blocked,
    KeyRejected,
    RateLimited,
    Rejected,
    Unavailable,
    UnexpectedResponse,
}

impl JevFailure {
    pub(super) fn message(self) -> String {
        match self {
            Self::Blocked => {
                "Cloudflare, in front of TypeSafe, blocked the request before TypeSafe read it."
                    .to_string()
            }
            Self::KeyRejected => "TypeSafe rejected the API key.".to_string(),
            Self::RateLimited => "TypeSafe's rate limit or quota was reached.".to_string(),
            Self::Rejected => "TypeSafe could not answer this request.".to_string(),
            Self::Unavailable => "Caffold could not reach TypeSafe.".to_string(),
            Self::UnexpectedResponse => {
                "TypeSafe returned a response Caffold could not read.".to_string()
            }
        }
    }
}

#[derive(Debug, Deserialize)]
struct SystemOneResponse {
    model: String,
    answers: BTreeMap<String, Answer>,
}

#[derive(Debug, Deserialize, Serialize)]
struct Answer {
    noul: f64,
}

/// Asks Jev through `POST /v1/systemone` and reads back one question's
/// probability, refusing anything outside 0..=1.
///
/// A failed call is not made again: the refusals that recur are Cloudflare's,
/// and it refuses the same request every time.
///
/// The response body is read only when the request succeeded. TypeSafe's error
/// bodies are not read at all, because the one for a rejected key can repeat
/// part of that key.
pub(super) async fn read(
    client: &Client,
    api_base: &str,
    key: &ApiKey,
    query: &Query,
    question: &str,
) -> Result<Reading, NoJudgement> {
    let body = serde_json::to_vec(&query.body()).expect("a JSON value serializes");
    let response = client
        .post(format!("{api_base}/v1/systemone"))
        .bearer_auth(key.expose())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(NoJudgement::NoAnswer)?;
    let status = response.status();
    let headers = response.headers().clone();
    if !status.is_success() {
        return Err(NoJudgement::Answered { status, headers });
    }
    let body = response.bytes().await.map_err(NoJudgement::NoAnswer)?;
    serde_json::from_slice::<SystemOneResponse>(&body)
        .ok()
        .and_then(|response| {
            let noul = response.answers.get(question)?.noul;
            (0.0..=1.0).contains(&noul).then_some(Reading {
                model: response.model,
                noul,
            })
        })
        .ok_or(NoJudgement::Answered { status, headers })
}

/// A call to Jev that brought back no judgement, and what came back instead.
#[derive(Debug)]
pub(super) enum NoJudgement {
    /// An answer that was not a judgement, from TypeSafe or from Cloudflare in
    /// front of it.
    Answered {
        status: StatusCode,
        headers: HeaderMap,
    },
    /// No whole answer arrived: the connection failed, broke off, or ran out
    /// of time.
    NoAnswer(reqwest::Error),
}

impl NoJudgement {
    pub(super) fn failure(&self) -> JevFailure {
        let Self::Answered { status, headers } = self else {
            return JevFailure::Unavailable;
        };
        match *status {
            StatusCode::FORBIDDEN if !headers.contains_key(REQUEST_ID) => JevFailure::Blocked,
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => JevFailure::KeyRejected,
            StatusCode::TOO_MANY_REQUESTS => JevFailure::RateLimited,
            StatusCode::REQUEST_TIMEOUT => JevFailure::Unavailable,
            status if status.is_server_error() => JevFailure::Unavailable,
            status if status.is_client_error() => JevFailure::Rejected,
            _ => JevFailure::UnexpectedResponse,
        }
    }
}

/// The headers worth keeping from an answer that was not a judgement.
const TRACED_HEADERS: [&str; 4] = [
    REQUEST_ID,
    "cf-ray",
    "x-envoy-upstream-service-time",
    "retry-after",
];

impl fmt::Display for NoJudgement {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Answered { status, headers } => {
                write!(f, "HTTP {status}")?;
                for name in TRACED_HEADERS {
                    if let Some(value) = headers.get(name).and_then(|value| value.to_str().ok()) {
                        write!(f, ", {name}: {value}")?;
                    }
                }
                Ok(())
            }
            Self::NoAnswer(error) => {
                write!(f, "{error}")?;
                let mut cause = error.source();
                while let Some(error) = cause {
                    write!(f, ": {error}")?;
                    cause = error.source();
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };

    use axum::{
        Router,
        body::Bytes,
        http::{HeaderMap, Uri},
    };
    use tempfile::TempDir;

    use super::*;
    use crate::app::jev::keys::ApiKeyStore;

    const SECRET: &str = "ts-test-0123456789abcdef";
    const JUDGEMENT: &str = r#"{"model":"jev-1.13.0","answers":{"ask":{"noul":0.12}}}"#;

    #[derive(Default)]
    struct CapturedRequest {
        path: String,
        authorization: Option<String>,
        body: Vec<u8>,
    }

    fn api_key(temp: &TempDir) -> ApiKey {
        let store = ApiKeyStore::open(temp.path().join("jev"));
        store.store(SECRET).unwrap();
        store.key().unwrap().unwrap()
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
    async fn sends_the_pinned_model_with_every_question_as_a_noul() {
        let temp = TempDir::new().unwrap();
        let captured = Arc::new(Mutex::new(CapturedRequest::default()));
        let base = jev_server(
            StatusCode::OK,
            r#"{"model":"jev-1.13.0","answers":{"ask":{"noul":0.91}}}"#,
            captured.clone(),
        )
        .await;
        let query =
            Query::new(json!({ "command": "ls" })).asking("ask", "the request is clearly ask");

        let reading = read(&Client::new(), &base, &api_key(&temp), &query, "ask")
            .await
            .unwrap();

        assert_eq!(reading.model, "jev-1.13.0");
        assert_eq!(reading.noul, 0.91);
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
            "the request is clearly ask"
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
        let query = Query::new(json!({})).asking("ask", "ask");

        let failed = read(&Client::new(), &base, &api_key(&temp), &query, "ask")
            .await
            .unwrap_err();

        assert_eq!(failed.failure(), JevFailure::UnexpectedResponse);
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
        let query = Query::new(json!({})).asking("ask", "ask");

        let failed = read(&Client::new(), &base, &api_key(&temp), &query, "ask")
            .await
            .unwrap_err();

        assert_eq!(failed.failure(), JevFailure::UnexpectedResponse);
    }

    #[tokio::test]
    async fn every_http_status_maps_to_its_own_failure() {
        let temp = TempDir::new().unwrap();
        let key = api_key(&temp);
        let cases = [
            (StatusCode::UNAUTHORIZED, JevFailure::KeyRejected),
            (StatusCode::FORBIDDEN, JevFailure::KeyRejected),
            (StatusCode::TOO_MANY_REQUESTS, JevFailure::RateLimited),
            (StatusCode::REQUEST_TIMEOUT, JevFailure::Unavailable),
            (StatusCode::BAD_GATEWAY, JevFailure::Unavailable),
            (StatusCode::BAD_REQUEST, JevFailure::Rejected),
        ];

        for (status, expected) in cases {
            let base = jev_server(
                status,
                r#"{"error":"ts-test-0123456789abcdef is invalid"}"#,
                Arc::new(Mutex::new(CapturedRequest::default())),
            )
            .await;
            let query = Query::new(json!({})).asking("ask", "ask");

            let failed = read(&Client::new(), &base, &key, &query, "ask")
                .await
                .unwrap_err();

            assert_eq!(failed.failure(), expected, "{status}");
            assert!(!failed.failure().message().contains(SECRET));
            assert!(!failed.to_string().contains(SECRET));
        }
    }

    #[tokio::test]
    async fn a_refusal_from_cloudflare_is_told_apart_from_typesafe_s_own() {
        let temp = TempDir::new().unwrap();
        let query = Query::new(json!({})).asking("ask", "ask");

        let failed = read(
            &Client::new(),
            &cloudflare_refusing().await,
            &api_key(&temp),
            &query,
            "ask",
        )
        .await
        .unwrap_err();

        assert_eq!(failed.failure(), JevFailure::Blocked);
        assert!(failed.failure().message().starts_with("Cloudflare"));
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
            let query = Query::new(json!({})).asking("ask", "ask");

            read(&Client::new(), &base, &key, &query, "ask")
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
        let query = Query::new(json!({})).asking("ask", "ask");

        let failed = read(&Client::new(), &base, &api_key(&temp), &query, "ask")
            .await
            .unwrap_err();

        assert_eq!(failed.failure(), JevFailure::UnexpectedResponse);
    }

    #[tokio::test]
    async fn an_unreachable_host_is_unavailable() {
        let temp = TempDir::new().unwrap();
        let query = Query::new(json!({})).asking("ask", "ask");

        let failed = read(
            &Client::new(),
            "http://127.0.0.1:1",
            &api_key(&temp),
            &query,
            "ask",
        )
        .await
        .unwrap_err();

        assert_eq!(failed.failure(), JevFailure::Unavailable);
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
        let failed = NoJudgement::Answered {
            status: StatusCode::UNAUTHORIZED,
            headers,
        };

        assert_eq!(
            failed.to_string(),
            "HTTP 401 Unauthorized, x-typesafe-request-id: req_01, \
             cf-ray: a3fa28d59daef8b7-LAX, x-envoy-upstream-service-time: 23, retry-after: 2"
        );
    }

    #[tokio::test]
    async fn a_call_that_got_no_answer_is_logged_with_what_caused_it() {
        let temp = TempDir::new().unwrap();
        let query = Query::new(json!({})).asking("ask", "ask");
        let Err(NoJudgement::NoAnswer(error)) = read(
            &Client::new(),
            "http://127.0.0.1:1",
            &api_key(&temp),
            &query,
            "ask",
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
