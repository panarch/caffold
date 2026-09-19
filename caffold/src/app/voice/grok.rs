use axum::body::Bytes;
use reqwest::{
    Client, StatusCode,
    multipart::{Form, Part},
};
use serde::Deserialize;

use super::{PROVIDER_REQUEST_TIMEOUT, ProviderFailure, keys::ApiKey};

pub(super) const API_BASE: &str = "https://api.x.ai";
pub(super) const MODEL: &str = "grok-voice-transcribe-2.0";

/// Transcribes a recording with Grok Voice Transcribe through xAI's
/// `POST /v1/stt`.
///
/// xAI answers an incorrect key with HTTP 400 rather than the 401 its
/// documentation lists, so a 400 body is read to tell that key apart from a
/// rejected recording.
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
    // xAI may ignore fields that follow the file.
    let form = Form::new().text("model", MODEL).part("file", recording);
    let response = client
        .post(format!("{api_base}/v1/stt"))
        .bearer_auth(key.expose())
        .multipart(form)
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
        return serde_json::from_slice::<Transcription>(&body)
            .map(|transcription| transcription.text)
            .map_err(|_| ProviderFailure::UnexpectedResponse);
    }
    Err(match status {
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => ProviderFailure::KeyRejected,
        StatusCode::BAD_REQUEST if names_an_incorrect_key(&body) => ProviderFailure::KeyRejected,
        StatusCode::TOO_MANY_REQUESTS => ProviderFailure::RateLimited,
        StatusCode::REQUEST_TIMEOUT => ProviderFailure::Unavailable,
        status if status.is_server_error() => ProviderFailure::Unavailable,
        status if status.is_client_error() => ProviderFailure::Rejected,
        _ => ProviderFailure::UnexpectedResponse,
    })
}

#[derive(Deserialize)]
struct Transcription {
    text: String,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: String,
}

/// Only the message is compared: xAI's `code` for the same incorrect key
/// differs from one endpoint to another.
fn names_an_incorrect_key(body: &[u8]) -> bool {
    serde_json::from_slice::<ErrorBody>(body).is_ok_and(|body| body.error.contains("API key"))
}

#[cfg(test)]
mod tests {
    use std::{
        io::Cursor,
        sync::{Arc, Mutex},
    };

    use axum::{
        Router,
        http::{HeaderMap, Uri},
    };
    use tempfile::TempDir;

    use super::*;
    use crate::app::voice::{CloudProvider, keys::ApiKeyStore};

    const RECORDING: &[u8] = b"RIFF\x24\x00\x00\x00WAVEfmt recording";
    /// Observed on the live `/v1/stt` endpoint on 2026-09-19 with a key that
    /// does not exist.
    const INCORRECT_KEY: &str = r#"{"code":"Client specified an invalid argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}"#;

    #[derive(Default)]
    struct CapturedRequest {
        path: String,
        authorization: Option<String>,
        content_type: Option<String>,
        body: Vec<u8>,
    }

    fn api_key(temp: &TempDir, value: &str) -> ApiKey {
        let store = ApiKeyStore::open(temp.path().join("voice"));
        store.store(CloudProvider::Grok, value).unwrap();
        store.key(CloudProvider::Grok).unwrap().unwrap()
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

    async fn transcribe_with(
        status: StatusCode,
        body: &'static str,
    ) -> Result<String, ProviderFailure> {
        let temp = TempDir::new().unwrap();
        let base = provider_server(status, body, Arc::default()).await;
        transcribe(
            &Client::new(),
            &base,
            &api_key(&temp, "xai-test"),
            Bytes::from_static(RECORDING),
        )
        .await
    }

    #[tokio::test]
    async fn uploads_the_model_and_then_the_recording_with_the_key_as_a_bearer_token() {
        let temp = TempDir::new().unwrap();
        let captured = Arc::new(Mutex::new(CapturedRequest::default()));
        // The response example in
        // https://docs.x.ai/developers/model-capabilities/audio/speech-to-text.md
        let base = provider_server(
            StatusCode::OK,
            r#"{"text":"The balance is $167,983.15.","language":"en","duration":3.45,"words":[{"text":"The","start":0.24,"end":0.48},{"text":"balance","start":0.48,"end":0.96},{"text":"is","start":0.96,"end":1.12},{"text":"$167,983.15.","start":1.12,"end":3.20}]}"#,
            captured.clone(),
        )
        .await;

        let transcript = transcribe(
            &Client::new(),
            &base,
            &api_key(&temp, "xai-test"),
            Bytes::from_static(RECORDING),
        )
        .await;

        assert_eq!(transcript, Ok("The balance is $167,983.15.".to_string()));
        let request = captured.lock().unwrap();
        assert_eq!(request.path, "/v1/stt");
        assert_eq!(request.authorization.as_deref(), Some("Bearer xai-test"));
        assert!(
            request
                .content_type
                .as_deref()
                .is_some_and(|value| value.starts_with("multipart/form-data; boundary="))
        );
        let body = String::from_utf8_lossy(&request.body);
        assert_eq!(body.matches("Content-Disposition: form-data;").count(), 2);
        let model = body
            .find("name=\"model\"\r\n\r\ngrok-voice-transcribe-2.0\r\n")
            .expect("the form must name the model");
        let file = body
            .find("name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n")
            .expect("the form must carry the recording");
        assert!(model < file, "the recording must be the last field");
        assert!(
            request
                .body
                .windows(RECORDING.len())
                .any(|window| window == RECORDING)
        );
    }

    #[tokio::test]
    async fn classifies_a_failure_by_its_status_and_key_error() {
        let cases = [
            (
                StatusCode::BAD_REQUEST,
                INCORRECT_KEY,
                ProviderFailure::KeyRejected,
            ),
            // The same key answered by the live `/v1/models` endpoint, whose
            // `code` differs.
            (
                StatusCode::BAD_REQUEST,
                r#"{"code":"invalid-argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}"#,
                ProviderFailure::KeyRejected,
            ),
            // Observed on the live `/v1/stt` endpoint on 2026-09-19 without an
            // Authorization header.
            (
                StatusCode::UNAUTHORIZED,
                r#"{"code":"The request does not have valid authentication credentials","error":"No credentials presented. [WKE=unauthenticated:no-credentials]"}"#,
                ProviderFailure::KeyRejected,
            ),
            // https://docs.x.ai/developers/debugging.md lists 403 for every
            // endpoint, answered by asking the team admin for permission; the
            // body is not documented.
            (StatusCode::FORBIDDEN, "", ProviderFailure::KeyRejected),
            // A 400 that does not name the key stays a rejected recording; the
            // message is a placeholder.
            (
                StatusCode::BAD_REQUEST,
                r#"{"code":"Client specified an invalid argument","error":"Unsupported audio format."}"#,
                ProviderFailure::Rejected,
            ),
            // The remaining statuses are listed in the error table of
            // https://docs.x.ai/developers/model-capabilities/audio/speech-to-text.md
            // without a documented body.
            (StatusCode::BAD_REQUEST, "", ProviderFailure::Rejected),
            (StatusCode::PAYLOAD_TOO_LARGE, "", ProviderFailure::Rejected),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "",
                ProviderFailure::RateLimited,
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "",
                ProviderFailure::Unavailable,
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
            &api_key(&temp, "xai-test"),
            Bytes::from_static(RECORDING),
        )
        .await;

        assert_eq!(transcript, Err(ProviderFailure::Unavailable));
    }

    #[tokio::test]
    #[ignore = "requires CAFFOLD_GROK_API_KEY and CAFFOLD_VOICE_WAV; spends xAI transcription usage"]
    async fn live_grok_transcribes_a_real_wav() {
        let temp = TempDir::new().unwrap();
        let key = api_key(
            &temp,
            &std::env::var("CAFFOLD_GROK_API_KEY").expect("set CAFFOLD_GROK_API_KEY"),
        );
        let wav = std::fs::read(
            std::env::var("CAFFOLD_VOICE_WAV")
                .expect("set CAFFOLD_VOICE_WAV to a 16 kHz mono 16-bit PCM WAV file"),
        )
        .unwrap();

        let transcript = transcribe(&Client::new(), API_BASE, &key, Bytes::from(wav))
            .await
            .expect("Grok must transcribe the recording");

        assert!(!transcript.trim().is_empty());
        println!("{transcript}");
    }

    #[tokio::test]
    #[ignore = "reaches xAI over the internet with a key that does not exist"]
    async fn live_grok_rejects_an_incorrect_key() {
        let temp = TempDir::new().unwrap();
        let mut silence = Cursor::new(Vec::new());
        let mut writer = hound::WavWriter::new(
            &mut silence,
            hound::WavSpec {
                channels: 1,
                sample_rate: 16_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..16_000 {
            writer.write_sample(0_i16).unwrap();
        }
        writer.finalize().unwrap();

        let transcript = transcribe(
            &Client::new(),
            API_BASE,
            &api_key(&temp, "xai-caffold-incorrect-key"),
            Bytes::from(silence.into_inner()),
        )
        .await;

        assert_eq!(transcript, Err(ProviderFailure::KeyRejected));
    }
}
