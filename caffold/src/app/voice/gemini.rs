use axum::body::Bytes;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{
    Client, StatusCode,
    header::{CONTENT_TYPE, HeaderValue},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{PROVIDER_REQUEST_TIMEOUT, ProviderFailure, keys::ApiKey};

pub(super) const API_BASE: &str = "https://generativelanguage.googleapis.com";
pub(super) const MODEL: &str = "gemini-3.5-transcribe";

/// Transcribes a recording with one `POST /v1beta/interactions` call to
/// Gemini 3.5 Transcribe.
///
/// Interactions are stored by default; Caffold never reads one back, so it
/// asks Gemini not to keep it.
pub(super) async fn transcribe(
    client: &Client,
    api_base: &str,
    key: &ApiKey,
    wav: Bytes,
) -> Result<String, ProviderFailure> {
    let request = InteractionRequest {
        model: MODEL,
        input: [AudioInput {
            kind: "audio",
            data: STANDARD.encode(&wav),
            mime_type: "audio/wav",
        }],
        store: false,
    };
    let body = serde_json::to_vec(&request).expect("an interaction request serializes");
    let mut key_header =
        HeaderValue::from_str(key.expose()).map_err(|_| ProviderFailure::KeyRejected)?;
    key_header.set_sensitive(true);
    let response = client
        .post(format!("{api_base}/v1beta/interactions"))
        .header("x-goog-api-key", key_header)
        .header(CONTENT_TYPE, "application/json")
        .body(body)
        .timeout(PROVIDER_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| ProviderFailure::Unavailable)?;
    let status = response.status();
    let body = response
        .bytes()
        .await
        .map_err(|_| ProviderFailure::Unavailable)?;
    if status.is_success() {
        return transcript(&body);
    }
    Err(match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ProviderFailure::KeyRejected,
        StatusCode::BAD_REQUEST if names_an_invalid_key(&body) => ProviderFailure::KeyRejected,
        StatusCode::TOO_MANY_REQUESTS => ProviderFailure::RateLimited,
        StatusCode::REQUEST_TIMEOUT => ProviderFailure::Unavailable,
        status if status.is_server_error() => ProviderFailure::Unavailable,
        status if status.is_client_error() => ProviderFailure::Rejected,
        _ => ProviderFailure::UnexpectedResponse,
    })
}

#[derive(Serialize)]
struct InteractionRequest {
    model: &'static str,
    input: [AudioInput; 1],
    store: bool,
}

#[derive(Serialize)]
struct AudioInput {
    #[serde(rename = "type")]
    kind: &'static str,
    data: String,
    mime_type: &'static str,
}

#[derive(Deserialize)]
struct Interaction {
    status: String,
    #[serde(default)]
    steps: Vec<Step>,
}

#[derive(Deserialize)]
struct Step {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    content: Vec<Content>,
}

#[derive(Deserialize)]
struct Content {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    text: String,
}

/// The text of the last model output. A completed interaction without text is
/// an empty transcript, as it is for a silent recording.
fn transcript(body: &[u8]) -> Result<String, ProviderFailure> {
    let interaction: Interaction =
        serde_json::from_slice(body).map_err(|_| ProviderFailure::UnexpectedResponse)?;
    if interaction.status != "completed" {
        return Err(ProviderFailure::Rejected);
    }
    Ok(interaction
        .steps
        .iter()
        .rev()
        .find(|step| step.kind == "model_output")
        .map(|step| {
            step.content
                .iter()
                .filter(|content| content.kind == "text")
                .map(|content| content.text.as_str())
                .collect()
        })
        .unwrap_or_default())
}

/// Gemini answers an invalid key with HTTP 400 in more than one shape: Google's
/// common error with an `API_KEY_INVALID` reason, and a message naming the key
/// inside an array, as observed on the Interactions endpoint.
fn names_an_invalid_key(body: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let error = match &value {
        Value::Array(items) => items.first().and_then(|item| item.get("error")),
        value => value.get("error"),
    };
    let Some(error) = error else {
        return false;
    };
    let invalid_key_reason =
        error
            .get("details")
            .and_then(Value::as_array)
            .is_some_and(|details| {
                details.iter().any(|detail| {
                    detail.get("reason").and_then(Value::as_str) == Some("API_KEY_INVALID")
                })
            });
    let message_names_the_key = error
        .get("message")
        .and_then(Value::as_str)
        .is_some_and(|message| message.contains("API key"));
    invalid_key_reason || message_names_the_key
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        Router,
        http::{HeaderMap, Uri},
    };
    use serde_json::json;
    use tempfile::TempDir;

    use super::*;
    use crate::app::voice::{CloudProvider, keys::ApiKeyStore};

    const RECORDING: &[u8] = b"RIFF\x24\x00\x00\x00WAVEfmt recording";

    #[derive(Default)]
    struct CapturedRequest {
        path: String,
        api_key: Option<String>,
        body: Vec<u8>,
    }

    fn api_key(temp: &TempDir, value: &str) -> ApiKey {
        let store = ApiKeyStore::open(temp.path().join("voice"));
        store.store(CloudProvider::Gemini, value).unwrap();
        store.key(CloudProvider::Gemini).unwrap().unwrap()
    }

    async fn provider_server(
        status: StatusCode,
        body: &'static str,
        captured: Arc<Mutex<CapturedRequest>>,
    ) -> String {
        let app = Router::new().fallback(move |uri: Uri, headers: HeaderMap, request: Bytes| {
            let captured = captured.clone();
            async move {
                *captured.lock().unwrap() = CapturedRequest {
                    path: uri.path().to_string(),
                    api_key: headers
                        .get("x-goog-api-key")
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

    async fn transcribe_with(
        status: StatusCode,
        body: &'static str,
    ) -> Result<String, ProviderFailure> {
        let temp = TempDir::new().unwrap();
        let base = provider_server(status, body, Arc::default()).await;
        transcribe(
            &Client::new(),
            &base,
            &api_key(&temp, "gemini-key"),
            Bytes::from_static(RECORDING),
        )
        .await
    }

    #[tokio::test]
    async fn sends_inline_audio_to_the_transcription_model_without_storing_it() {
        let temp = TempDir::new().unwrap();
        let captured = Arc::new(Mutex::new(CapturedRequest::default()));
        // Captured from the live API by Google's Jot app:
        // google-gemini/jot-gemini-transcribe-macOS 8f2d7a4, InteractionsClientTests.swift.
        let base = provider_server(
            StatusCode::OK,
            r#"{"id":"interaction-1","object":"interaction","model":"gemini-3.5-transcribe","status":"completed","created":"2026-08-20T12:00:00Z","steps":[{"type":"model_output","content":[{"type":"text","text":"Let's meet at 2pm."}]}],"usage":{"total_input_tokens":268,"total_output_tokens":0}}"#,
            captured.clone(),
        )
        .await;

        let transcript = transcribe(
            &Client::new(),
            &base,
            &api_key(&temp, "gemini-key"),
            Bytes::from_static(RECORDING),
        )
        .await;

        assert_eq!(transcript, Ok("Let's meet at 2pm.".to_string()));
        let request = captured.lock().unwrap();
        assert_eq!(request.path, "/v1beta/interactions");
        assert_eq!(request.api_key.as_deref(), Some("gemini-key"));
        assert_eq!(
            serde_json::from_slice::<Value>(&request.body).unwrap(),
            json!({
                "model": "gemini-3.5-transcribe",
                "input": [{
                    "type": "audio",
                    "data": STANDARD.encode(RECORDING),
                    "mime_type": "audio/wav",
                }],
                "store": false,
            })
        );
    }

    #[tokio::test]
    async fn joins_the_text_blocks_of_the_last_model_output() {
        // Step and content shapes from https://ai.google.dev/gemini-api/docs/transcribe.md.txt.
        let transcript = transcribe_with(
            StatusCode::OK,
            r#"{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"Draft"}]},{"type":"model_output","content":[{"type":"text","text":"Hello "},{"type":"text","text":"world"}]}]}"#,
        )
        .await;

        assert_eq!(transcript, Ok("Hello world".to_string()));
    }

    #[tokio::test]
    async fn a_completed_interaction_without_text_is_an_empty_transcript() {
        // `content` is optional on a model output step in
        // https://ai.google.dev/static/api/interactions.openapi.json.
        let transcript = transcribe_with(
            StatusCode::OK,
            r#"{"status":"completed","steps":[{"type":"model_output"}]}"#,
        )
        .await;

        assert_eq!(transcript, Ok(String::new()));
    }

    #[tokio::test]
    async fn classifies_a_failure_by_its_status_and_key_error() {
        let cases = [
            // Codes from https://ai.google.dev/gemini-api/docs/api-errors.md.txt;
            // messages other than the authentication one are placeholders.
            (
                StatusCode::UNAUTHORIZED,
                r#"{"error":{"code":"authentication","message":"The API key is missing, invalid, or expired."}}"#,
                ProviderFailure::KeyRejected,
            ),
            // Observed on the live Interactions endpoint by Google's Jot app,
            // GeminiClient.swift in jot-gemini-transcribe-macOS 8f2d7a4.
            (
                StatusCode::BAD_REQUEST,
                r#"[{"error":{"code":400,"message":"API key not valid."}}]"#,
                ProviderFailure::KeyRejected,
            ),
            // gemini-cli 9c1b0a6, packages/core/src/utils/errorParsing.test.ts.
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT"}}"#,
                ProviderFailure::KeyRejected,
            ),
            // The reason from googleapis google/api/error_reason.proto.
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"code":400,"message":"Invalid request.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com"}]}}"#,
                ProviderFailure::KeyRejected,
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"code":"invalid_request","message":"The audio could not be processed."}}"#,
                ProviderFailure::Rejected,
            ),
            // A 400 body that does not name a key stays a rejected recording.
            (
                StatusCode::BAD_REQUEST,
                "not json",
                ProviderFailure::Rejected,
            ),
            (
                StatusCode::BAD_REQUEST,
                r#"{"message":"API key"}"#,
                ProviderFailure::Rejected,
            ),
            (
                StatusCode::FORBIDDEN,
                r#"{"error":{"code":"permission_denied","message":"Permission denied."}}"#,
                ProviderFailure::KeyRejected,
            ),
            (
                StatusCode::NOT_FOUND,
                r#"{"error":{"code":"model_not_found","message":"Model not found."}}"#,
                ProviderFailure::Rejected,
            ),
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":{"code":"quota_exceeded","message":"Quota exceeded."}}"#,
                ProviderFailure::RateLimited,
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                r#"{"error":{"code":"service_unavailable","message":"Service unavailable."}}"#,
                ProviderFailure::Unavailable,
            ),
            // Interaction status values from https://ai.google.dev/api/interactions-api.md.txt.
            (
                StatusCode::OK,
                r#"{"status":"failed","errors":[{"code":"internal","message":"Transcription failed."}]}"#,
                ProviderFailure::Rejected,
            ),
            (StatusCode::OK, "{}", ProviderFailure::UnexpectedResponse),
            (
                StatusCode::OK,
                "not json",
                ProviderFailure::UnexpectedResponse,
            ),
        ];

        for (status, body, expected) in cases {
            assert_eq!(
                transcribe_with(status, body).await,
                Err(expected),
                "{status} {body}"
            );
        }
    }

    #[tokio::test]
    async fn an_unreachable_provider_is_unavailable() {
        let temp = TempDir::new().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);

        let transcript = transcribe(
            &Client::new(),
            &base,
            &api_key(&temp, "gemini-key"),
            Bytes::from_static(RECORDING),
        )
        .await;

        assert_eq!(transcript, Err(ProviderFailure::Unavailable));
    }

    #[tokio::test]
    #[ignore = "requires CAFFOLD_GEMINI_API_KEY and CAFFOLD_VOICE_WAV; spends Gemini transcription usage"]
    async fn live_gemini_transcribes_a_real_wav() {
        let temp = TempDir::new().unwrap();
        let key = api_key(
            &temp,
            &std::env::var("CAFFOLD_GEMINI_API_KEY").expect("set CAFFOLD_GEMINI_API_KEY"),
        );
        let wav = std::fs::read(
            std::env::var("CAFFOLD_VOICE_WAV")
                .expect("set CAFFOLD_VOICE_WAV to a 16 kHz mono 16-bit PCM WAV file"),
        )
        .unwrap();

        let transcript = transcribe(&Client::new(), API_BASE, &key, Bytes::from(wav))
            .await
            .expect("Gemini must transcribe the recording");

        assert!(!transcript.trim().is_empty());
        println!("{transcript}");
    }
}
