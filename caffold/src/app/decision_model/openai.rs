use reqwest::{Client, StatusCode, header::HeaderMap};
use serde::Deserialize;
use serde_json::{Value, json};

use super::{
    DecisionFailure, NoJudgement, Question, REQUEST_TIMEOUT, Reading, Thresholds, keys::ApiKey,
};

pub(super) const API_BASE: &str = "https://api.openai.com";

/// The one model OpenAI's Decisions API serves.
///
/// It names no version, so the model behind it is OpenAI's to change and no
/// answer says when it did. Running the calibration cases again is how a
/// change would show.
pub(super) const MODEL: &str = "gpt-6-luna";

/// Where gpt-6-luna's answers become decisions, measured on the calibration
/// cases.
pub(super) const THRESHOLDS: Thresholds = Thresholds {
    ask: 0.7,
    keep: 0.7,
};

/// The headers worth keeping from an answer that was not a judgement.
const TRACED_HEADERS: &[&str] = &["x-request-id", "cf-ray", "retry-after"];

/// Asks OpenAI one question through `POST /v1/decisions` and reads back its
/// probability, refusing anything outside 0..=1.
///
/// The state travels as the JSON part of one user message, under `state`, so
/// a question that names `state.request` names what it reads. The question is
/// a `predicate`, whose answer is the probability that its sentence is true.
/// OpenAI may refuse it instead, and a refusal is no judgement.
///
/// The response body is read only when the request succeeded, because an
/// error body for a rejected key can repeat part of that key.
pub(super) async fn read(
    client: &Client,
    api_base: &str,
    key: &ApiKey,
    state: &Value,
    question: Question,
) -> Result<Reading, NoJudgement> {
    let body = json!({
        "model": MODEL,
        "input": [{
            "role": "user",
            "content": [{ "type": "input_json", "data": { "state": state } }],
        }],
        "questions": [{
            "type": "predicate",
            "name": question.name,
            "instructions": question.instructions,
        }],
    });
    let response = client
        .post(format!("{api_base}/v1/decisions"))
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
    let answered = |failure| NoJudgement::Answered {
        failure,
        status,
        headers: headers.clone(),
        traced: TRACED_HEADERS,
    };
    let decision = serde_json::from_slice::<Decision>(&body)
        .map_err(|_| answered(DecisionFailure::UnexpectedResponse))?;
    let probability = match decision.answer(question.name) {
        Some(DecisionAnswer::Predicate { probability, .. })
            if (0.0..=1.0).contains(probability) =>
        {
            *probability
        }
        Some(DecisionAnswer::Refusal { .. }) => return Err(answered(DecisionFailure::Rejected)),
        _ => return Err(answered(DecisionFailure::UnexpectedResponse)),
    };
    Ok(Reading {
        model: decision.model,
        probability,
    })
}

#[derive(Debug, Deserialize)]
struct Decision {
    model: String,
    answers: Vec<DecisionAnswer>,
}

impl Decision {
    fn answer(&self, name: &str) -> Option<&DecisionAnswer> {
        self.answers.iter().find(|answer| match answer {
            DecisionAnswer::Predicate { name: answered, .. }
            | DecisionAnswer::Refusal { name: answered } => answered == name,
            DecisionAnswer::Other => false,
        })
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum DecisionAnswer {
    Predicate {
        name: String,
        probability: f64,
    },
    Refusal {
        name: String,
    },
    #[serde(other)]
    Other,
}

fn no_judgement(status: StatusCode, headers: HeaderMap) -> NoJudgement {
    let failure = match status {
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
    use std::sync::{Arc, Mutex};

    use axum::{Router, body::Bytes, http::Uri};
    use tempfile::TempDir;

    use super::*;
    use crate::app::decision_model::{DecisionModelProvider, keys::ApiKeyStore};

    const SECRET: &str = "sk-test-0123456789abcdef";
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
        store.store(DecisionModelProvider::Openai, SECRET).unwrap();
        store.key(DecisionModelProvider::Openai).unwrap().unwrap()
    }

    /// A stand-in for OpenAI, which marks every answer with a request id.
    async fn openai_server(
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
                    [
                        ("content-type", "application/json"),
                        ("x-request-id", "req_1"),
                    ],
                    body,
                )
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    async fn answering(body: &'static str) -> String {
        openai_server(
            StatusCode::OK,
            body,
            Arc::new(Mutex::new(CapturedRequest::default())),
        )
        .await
    }

    #[tokio::test]
    async fn sends_the_state_as_json_and_the_question_as_a_predicate() {
        let temp = TempDir::new().unwrap();
        let captured = Arc::new(Mutex::new(CapturedRequest::default()));
        let base = openai_server(
            StatusCode::OK,
            r#"{"model":"gpt-6-luna","answers":[{"type":"predicate","name":"ask","probability":0.91}],"usage":{"input_tokens":42}}"#,
            captured.clone(),
        )
        .await;

        let reading = read(
            &Client::new(),
            &base,
            &api_key(&temp),
            &json!({ "request": { "command": "ls" } }),
            ASK,
        )
        .await
        .unwrap();

        assert_eq!(reading.model, "gpt-6-luna");
        assert_eq!(reading.probability, 0.91);
        let request = captured.lock().unwrap();
        assert_eq!(request.path, "/v1/decisions");
        assert_eq!(
            request.authorization.as_deref(),
            Some(&*format!("Bearer {SECRET}"))
        );
        let body: Value = serde_json::from_slice(&request.body).unwrap();
        assert_eq!(body["model"], MODEL);
        assert_eq!(body["input"][0]["role"], "user");
        let content = &body["input"][0]["content"][0];
        assert_eq!(content["type"], "input_json");
        assert_eq!(content["data"]["state"]["request"]["command"], "ls");
        assert_eq!(
            body["questions"],
            json!([{
                "type": "predicate",
                "name": "ask",
                "instructions": "the request needs a person",
            }])
        );
    }

    #[tokio::test]
    async fn the_answer_is_read_by_the_question_s_name() {
        let temp = TempDir::new().unwrap();
        let base = answering(
            r#"{"model":"gpt-6-luna","answers":[{"type":"predicate","name":"other","probability":0.2},{"type":"predicate","name":"ask","probability":0.6}]}"#,
        )
        .await;

        let reading = read(&Client::new(), &base, &api_key(&temp), &json!({}), ASK)
            .await
            .unwrap();

        assert_eq!(reading.probability, 0.6);
    }

    #[tokio::test]
    async fn a_refused_question_is_not_a_judgement() {
        let temp = TempDir::new().unwrap();
        let base =
            answering(r#"{"model":"gpt-6-luna","answers":[{"type":"refusal","name":"ask"}]}"#)
                .await;

        let failed = read(&Client::new(), &base, &api_key(&temp), &json!({}), ASK)
            .await
            .unwrap_err();

        assert_eq!(failed.failure(), DecisionFailure::Rejected);
        assert_eq!(
            failed.failure().message(DecisionModelProvider::Openai),
            "OpenAI could not answer this request."
        );
    }

    #[tokio::test]
    async fn an_answer_that_is_missing_out_of_range_or_unknown_is_not_a_judgement() {
        let temp = TempDir::new().unwrap();
        for body in [
            r#"{"model":"gpt-6-luna","answers":[]}"#,
            r#"{"model":"gpt-6-luna","answers":[{"type":"predicate","name":"ask","probability":1.5}]}"#,
            r#"{"model":"gpt-6-luna","answers":[{"type":"choice","name":"ask","choice":"yes"}]}"#,
            r#"{"model":"gpt-6-luna"}"#,
            "not json",
        ] {
            let base = answering(body).await;

            let failed = read(&Client::new(), &base, &api_key(&temp), &json!({}), ASK)
                .await
                .unwrap_err();

            assert_eq!(
                failed.failure(),
                DecisionFailure::UnexpectedResponse,
                "{body}"
            );
        }
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
            let base = openai_server(
                status,
                r#"{"error":{"message":"Incorrect API key provided: sk-test-0123456789abcdef"}}"#,
                Arc::new(Mutex::new(CapturedRequest::default())),
            )
            .await;

            let failed = read(&Client::new(), &base, &key, &json!({}), ASK)
                .await
                .unwrap_err();

            assert_eq!(failed.failure(), expected, "{status}");
            let message = failed.failure().message(DecisionModelProvider::Openai);
            assert!(!message.contains(SECRET));
            assert!(!failed.to_string().contains(SECRET));
        }
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
            ("x-request-id", "req_01"),
            ("cf-ray", "a3fa28d59daef8b7-LAX"),
            ("retry-after", "2"),
            ("openai-organization", "org-private"),
            ("set-cookie", "__cf_bm=private"),
        ] {
            headers.insert(name, value.parse().unwrap());
        }

        let failed = no_judgement(StatusCode::TOO_MANY_REQUESTS, headers);

        assert_eq!(
            failed.to_string(),
            "HTTP 429 Too Many Requests, x-request-id: req_01, cf-ray: a3fa28d59daef8b7-LAX, \
             retry-after: 2"
        );
    }
}
