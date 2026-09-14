use axum::body::Bytes;
use reqwest::{
    Client, StatusCode,
    multipart::{Form, Part},
};
use serde::Deserialize;

use super::{PROVIDER_REQUEST_TIMEOUT, ProviderFailure, keys::ApiKey};

pub(super) const API_BASE: &str = "https://api.openai.com";
pub(super) const MODEL: &str = "gpt-transcribe";

/// Transcribes a recording with OpenAI's `POST /v1/audio/transcriptions`.
///
/// The provider's error bodies are never read: the one for a rejected key
/// repeats part of that key.
pub(super) async fn transcribe(
    client: &Client,
    api_base: &str,
    key: &ApiKey,
    wav: Bytes,
) -> Result<String, ProviderFailure> {
    let length = wav.len() as u64;
    let recording = Part::stream_with_length(wav, length)
        .file_name("recording.wav")
        .mime_str("audio/wav")
        .expect("audio/wav is a valid MIME type");
    let form = Form::new().text("model", MODEL).part("file", recording);
    let response = client
        .post(format!("{api_base}/v1/audio/transcriptions"))
        .bearer_auth(key.expose())
        .multipart(form)
        .timeout(PROVIDER_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| ProviderFailure::Unavailable)?;
    match response.status() {
        status if status.is_success() => {
            let body = response
                .bytes()
                .await
                .map_err(|_| ProviderFailure::Unavailable)?;
            serde_json::from_slice::<Transcription>(&body)
                .map(|transcription| transcription.text)
                .map_err(|_| ProviderFailure::UnexpectedResponse)
        }
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => Err(ProviderFailure::KeyRejected),
        StatusCode::TOO_MANY_REQUESTS => Err(ProviderFailure::RateLimited),
        StatusCode::REQUEST_TIMEOUT => Err(ProviderFailure::Unavailable),
        status if status.is_server_error() => Err(ProviderFailure::Unavailable),
        status if status.is_client_error() => Err(ProviderFailure::Rejected),
        _ => Err(ProviderFailure::UnexpectedResponse),
    }
}

#[derive(Deserialize)]
struct Transcription {
    text: String,
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use axum::{
        Router,
        http::{HeaderMap, Uri},
    };
    use tempfile::TempDir;

    use super::*;
    use crate::app::voice::{CloudProvider, keys::ApiKeyStore};

    const RECORDING: &[u8] = b"RIFF\x24\x00\x00\x00WAVEfmt recording";

    #[derive(Default)]
    struct CapturedRequest {
        path: String,
        authorization: Option<String>,
        content_type: Option<String>,
        body: Vec<u8>,
    }

    fn api_key(temp: &TempDir, value: &str) -> ApiKey {
        let store = ApiKeyStore::open(temp.path().join("voice"));
        store.store(CloudProvider::Openai, value).unwrap();
        store.key(CloudProvider::Openai).unwrap().unwrap()
    }

    async fn provider_server(
        status: StatusCode,
        body: &'static str,
        captured: Arc<Mutex<CapturedRequest>>,
    ) -> String {
        let app = Router::new().fallback(move |uri: Uri, headers: HeaderMap, request: Bytes| {
            let captured = captured.clone();
            async move {
                let header = |name: &str| {
                    headers
                        .get(name)
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string)
                };
                *captured.lock().unwrap() = CapturedRequest {
                    path: uri.path().to_string(),
                    authorization: header("authorization"),
                    content_type: header("content-type"),
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

    #[tokio::test]
    async fn uploads_the_recording_and_model_with_the_key_as_a_bearer_token() {
        let temp = TempDir::new().unwrap();
        let captured = Arc::new(Mutex::new(CapturedRequest::default()));
        // The gpt-transcribe JSON response from
        // https://developers.openai.com/api/docs/guides/speech-to-text.md
        let base = provider_server(
            StatusCode::OK,
            r#"{"text":"Bonjour, pouvez-vous m'entendre ?","languages":[{"code":"fr"}]}"#,
            captured.clone(),
        )
        .await;

        let transcript = transcribe(
            &Client::new(),
            &base,
            &api_key(&temp, "sk-test"),
            Bytes::from_static(RECORDING),
        )
        .await;

        assert_eq!(
            transcript,
            Ok("Bonjour, pouvez-vous m'entendre ?".to_string())
        );
        let request = captured.lock().unwrap();
        assert_eq!(request.path, "/v1/audio/transcriptions");
        assert_eq!(request.authorization.as_deref(), Some("Bearer sk-test"));
        assert!(
            request
                .content_type
                .as_deref()
                .is_some_and(|value| value.starts_with("multipart/form-data; boundary="))
        );
        let body = String::from_utf8_lossy(&request.body);
        assert!(body.contains("name=\"model\"\r\n\r\ngpt-transcribe\r\n"));
        assert!(body.contains(
            "name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        ));
        assert!(
            request
                .body
                .windows(RECORDING.len())
                .any(|window| window == RECORDING)
        );
    }

    #[tokio::test]
    async fn classifies_a_failure_by_its_status() {
        let temp = TempDir::new().unwrap();
        let key = api_key(&temp, "sk-test");
        let cases = [
            // Recorded by openai-dotnet ae2bccb,
            // tests/SessionRecords/ChatTests/AuthFailure.json.
            (
                StatusCode::UNAUTHORIZED,
                r#"{"error":{"message":"Incorrect API key provided: sk-te**st. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}"#,
                ProviderFailure::KeyRejected,
            ),
            // 403 is listed in guides/error-codes.md without a documented body.
            (StatusCode::FORBIDDEN, "", ProviderFailure::KeyRejected),
            // openai-cookbook examples/How_to_handle_rate_limits.ipynb, cell 4.
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}"#,
                ProviderFailure::RateLimited,
            ),
            // openai-openapi 4bb21ba, components.responses.InferenceRateLimited.
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":{"message":"Your request rate increased too quickly. Please reduce the request rate and gradually increase it again.","type":"rate_limit_error","param":null,"code":"slow_down"}}"#,
                ProviderFailure::RateLimited,
            ),
            // server_is_overloaded in guides/rate-limits.md; the body is not documented.
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "",
                ProviderFailure::Unavailable,
            ),
            // Rejected recordings have no documented body.
            (StatusCode::BAD_REQUEST, "", ProviderFailure::Rejected),
            (StatusCode::OK, "{}", ProviderFailure::UnexpectedResponse),
            (
                StatusCode::OK,
                "not json",
                ProviderFailure::UnexpectedResponse,
            ),
        ];

        for (status, body, expected) in cases {
            let base = provider_server(status, body, Arc::default()).await;
            let transcript =
                transcribe(&Client::new(), &base, &key, Bytes::from_static(RECORDING)).await;
            assert_eq!(transcript, Err(expected), "{status} {body}");
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
            &api_key(&temp, "sk-test"),
            Bytes::from_static(RECORDING),
        )
        .await;

        assert_eq!(transcript, Err(ProviderFailure::Unavailable));
    }

    #[tokio::test]
    #[ignore = "requires CAFFOLD_OPENAI_API_KEY and CAFFOLD_VOICE_WAV; spends OpenAI transcription usage"]
    async fn live_openai_transcribes_a_real_wav() {
        let temp = TempDir::new().unwrap();
        let key = api_key(
            &temp,
            &std::env::var("CAFFOLD_OPENAI_API_KEY").expect("set CAFFOLD_OPENAI_API_KEY"),
        );
        let wav = std::fs::read(
            std::env::var("CAFFOLD_VOICE_WAV")
                .expect("set CAFFOLD_VOICE_WAV to a 16 kHz mono 16-bit PCM WAV file"),
        )
        .unwrap();

        let transcript = transcribe(&Client::new(), API_BASE, &key, Bytes::from(wav))
            .await
            .expect("OpenAI must transcribe the recording");

        assert!(!transcript.trim().is_empty());
        println!("{transcript}");
    }
}
