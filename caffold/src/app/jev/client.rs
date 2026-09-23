use std::{collections::BTreeMap, time::Duration};

use reqwest::{Client, StatusCode};
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

/// What Jev answered, and which model version answered it.
#[derive(Debug)]
pub(super) struct Answers {
    model: String,
    answers: BTreeMap<String, Answer>,
}

impl Answers {
    pub(super) fn model(&self) -> &str {
        &self.model
    }

    /// The probability Jev gave one question, refusing anything outside 0..=1.
    pub(super) fn noul(&self, name: &str) -> Result<f64, JevFailure> {
        let noul = self
            .answers
            .get(name)
            .map(|answer| answer.noul)
            .ok_or(JevFailure::UnexpectedResponse)?;
        if !(0.0..=1.0).contains(&noul) {
            return Err(JevFailure::UnexpectedResponse);
        }
        Ok(noul)
    }
}

/// Why Jev returned no judgement.
///
/// Every one of these ends the same way for a person — the request stays
/// theirs to answer — but they are kept apart so Settings can say which one a
/// saved key hit.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum JevFailure {
    KeyRejected,
    RateLimited,
    Rejected,
    Unavailable,
    UnexpectedResponse,
}

impl JevFailure {
    pub(super) fn message(self) -> String {
        match self {
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

/// Asks Jev, once more if TypeSafe refuses the key.
///
/// TypeSafe sometimes refuses a key it accepts moments before and after, so one
/// refusal does not yet mean the key is wrong.
pub(super) async fn ask(
    client: &Client,
    api_base: &str,
    key: &ApiKey,
    query: &Query,
) -> Result<Answers, JevFailure> {
    let asking = async {
        match ask_once(client, api_base, key, query).await {
            Err(JevFailure::KeyRejected) => ask_once(client, api_base, key, query).await,
            answered => answered,
        }
    };
    tokio::time::timeout(REQUEST_TIMEOUT, asking)
        .await
        .unwrap_or(Err(JevFailure::Unavailable))
}

/// Asks Jev through `POST /v1/systemone`.
///
/// The response body is read only when the request succeeded. TypeSafe's error
/// bodies are not read at all, because the one for a rejected key can repeat
/// part of that key.
async fn ask_once(
    client: &Client,
    api_base: &str,
    key: &ApiKey,
    query: &Query,
) -> Result<Answers, JevFailure> {
    let body = serde_json::to_vec(&query.body()).expect("a JSON value serializes");
    let response = client
        .post(format!("{api_base}/v1/systemone"))
        .bearer_auth(key.expose())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body)
        .send()
        .await
        .map_err(|_| JevFailure::Unavailable)?;
    match response.status() {
        status if status.is_success() => {
            let body = response
                .bytes()
                .await
                .map_err(|_| JevFailure::Unavailable)?;
            serde_json::from_slice::<SystemOneResponse>(&body)
                .map(|response| Answers {
                    model: response.model,
                    answers: response.answers,
                })
                .map_err(|_| JevFailure::UnexpectedResponse)
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(JevFailure::KeyRejected),
        StatusCode::TOO_MANY_REQUESTS => Err(JevFailure::RateLimited),
        StatusCode::REQUEST_TIMEOUT => Err(JevFailure::Unavailable),
        status if status.is_server_error() => Err(JevFailure::Unavailable),
        status if status.is_client_error() => Err(JevFailure::Rejected),
        _ => Err(JevFailure::UnexpectedResponse),
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
                (status, [("content-type", "application/json")], body)
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    async fn jev_server_answering_in_turn(
        answers: Vec<(StatusCode, &'static str)>,
    ) -> (String, Arc<AtomicUsize>) {
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let app = Router::new().fallback(move || {
            let call = counted.fetch_add(1, Ordering::SeqCst);
            let (status, body) = answers[call.min(answers.len() - 1)];
            async move { (status, [("content-type", "application/json")], body) }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), calls)
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

        let answers = ask(&Client::new(), &base, &api_key(&temp), &query)
            .await
            .unwrap();

        assert_eq!(answers.model(), "jev-1.13.0");
        assert_eq!(answers.noul("ask").unwrap(), 0.91);
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

        let answers = ask(&Client::new(), &base, &api_key(&temp), &query)
            .await
            .unwrap();

        assert_eq!(answers.noul("ask"), Err(JevFailure::UnexpectedResponse));
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

        let answers = ask(&Client::new(), &base, &api_key(&temp), &query)
            .await
            .unwrap();

        assert_eq!(answers.noul("ask"), Err(JevFailure::UnexpectedResponse));
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

            let failure = ask(&Client::new(), &base, &key, &query).await.unwrap_err();

            assert_eq!(failure, expected, "{status}");
            assert!(!failure.message().contains(SECRET));
        }
    }

    #[tokio::test]
    async fn a_refused_key_is_asked_once_more_and_that_answer_stands() {
        let temp = TempDir::new().unwrap();
        let key = api_key(&temp);

        for refusal in [StatusCode::UNAUTHORIZED, StatusCode::FORBIDDEN] {
            let (base, calls) = jev_server_answering_in_turn(vec![
                (refusal, r#"{"error":"invalid key"}"#),
                (
                    StatusCode::OK,
                    r#"{"model":"jev-1.13.0","answers":{"ask":{"noul":0.12}}}"#,
                ),
            ])
            .await;
            let query = Query::new(json!({})).asking("ask", "ask");

            let answers = ask(&Client::new(), &base, &key, &query).await.unwrap();

            assert_eq!(answers.noul("ask").unwrap(), 0.12, "{refusal}");
            assert_eq!(calls.load(Ordering::SeqCst), 2, "{refusal}");
        }
    }

    #[tokio::test]
    async fn a_key_refused_twice_is_rejected() {
        let temp = TempDir::new().unwrap();
        let (base, calls) =
            jev_server_answering_in_turn(vec![(StatusCode::UNAUTHORIZED, "{}")]).await;
        let query = Query::new(json!({})).asking("ask", "ask");

        let failure = ask(&Client::new(), &base, &api_key(&temp), &query)
            .await
            .unwrap_err();

        assert_eq!(failure, JevFailure::KeyRejected);
        assert_eq!(calls.load(Ordering::SeqCst), 2, "once more, and no further");
    }

    #[tokio::test]
    async fn only_a_refused_key_is_asked_again() {
        let temp = TempDir::new().unwrap();
        let key = api_key(&temp);

        for status in [
            StatusCode::TOO_MANY_REQUESTS,
            StatusCode::REQUEST_TIMEOUT,
            StatusCode::BAD_GATEWAY,
            StatusCode::BAD_REQUEST,
        ] {
            let (base, calls) = jev_server_answering_in_turn(vec![(status, "{}")]).await;
            let query = Query::new(json!({})).asking("ask", "ask");

            ask(&Client::new(), &base, &key, &query).await.unwrap_err();

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

        let failure = ask(&Client::new(), &base, &api_key(&temp), &query)
            .await
            .unwrap_err();

        assert_eq!(failure, JevFailure::UnexpectedResponse);
    }

    #[tokio::test]
    async fn an_unreachable_host_is_unavailable() {
        let temp = TempDir::new().unwrap();
        let query = Query::new(json!({})).asking("ask", "ask");

        let failure = ask(
            &Client::new(),
            "http://127.0.0.1:1",
            &api_key(&temp),
            &query,
        )
        .await
        .unwrap_err();

        assert_eq!(failure, JevFailure::Unavailable);
    }
}
