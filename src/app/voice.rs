use std::{
    io::Cursor,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use hound::{SampleFormat, WavReader};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, OnceCell, Semaphore},
};
use tracing::{error, warn};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, install_logging_hooks,
};

const MODEL_ID: &str = "large-v3-turbo";
const MODEL_FILENAME: &str = "ggml-large-v3-turbo.bin";
const MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
const MODEL_SHA256: &str = "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69";
const MODEL_BYTES: u64 = 1_624_555_275;
const MAX_AUDIO_BYTES: usize = 10 * 1024 * 1024;
const AUDIO_SAMPLE_RATE: u32 = 16_000;
const MAX_AUDIO_SECONDS: usize = 5 * 60;
const MAX_AUDIO_SAMPLES: usize = AUDIO_SAMPLE_RATE as usize * MAX_AUDIO_SECONDS;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceAcceleration {
    Auto,
    Cpu,
}

impl VoiceAcceleration {
    fn use_gpu(self) -> bool {
        matches!(self, Self::Auto)
    }
}

#[derive(Clone)]
struct ModelSpec {
    id: String,
    filename: String,
    url: String,
    sha256: String,
    bytes: u64,
}

impl ModelSpec {
    fn large_v3_turbo() -> Self {
        Self {
            id: MODEL_ID.to_string(),
            filename: MODEL_FILENAME.to_string(),
            url: format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/{MODEL_REVISION}/{MODEL_FILENAME}"
            ),
            sha256: MODEL_SHA256.to_string(),
            bytes: MODEL_BYTES,
        }
    }
}

trait VoiceEngine: Send + Sync {
    fn load(&self, path: &Path) -> Result<Arc<dyn LoadedVoiceModel>, String>;
}

trait LoadedVoiceModel: Send + Sync {
    fn transcribe(&self, audio: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, String>;
}

struct WhisperVoiceEngine {
    acceleration: VoiceAcceleration,
}

impl WhisperVoiceEngine {
    fn new(acceleration: VoiceAcceleration) -> Self {
        Self { acceleration }
    }
}

impl VoiceEngine for WhisperVoiceEngine {
    fn load(&self, path: &Path) -> Result<Arc<dyn LoadedVoiceModel>, String> {
        install_logging_hooks();
        let mut params = WhisperContextParameters::default();
        params.use_gpu(self.acceleration.use_gpu());
        let context = WhisperContext::new_with_params(path, params)
            .map_err(|error| format!("could not load Whisper model: {error}"))?;
        Ok(Arc::new(WhisperVoiceModel { context }))
    }
}

struct WhisperVoiceModel {
    context: WhisperContext,
}

impl LoadedVoiceModel for WhisperVoiceModel {
    fn transcribe(&self, audio: &[f32], cancelled: Arc<AtomicBool>) -> Result<String, String> {
        let mut state = self
            .context
            .create_state()
            .map_err(|error| format!("could not create Whisper state: {error}"))?;
        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_language(None);
        params.set_translate(false);
        params.set_no_context(true);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_n_threads(
            std::thread::available_parallelism()
                .map(|threads| threads.get().min(8) as i32)
                .unwrap_or(4),
        );
        let abort: Box<dyn FnMut() -> bool> = Box::new(move || cancelled.load(Ordering::Relaxed));
        params.set_abort_callback_safe::<_, Box<dyn FnMut() -> bool>>(Some(abort));
        state
            .full(params, audio)
            .map_err(|error| format!("Whisper transcription failed: {error}"))?;

        Ok(state
            .as_iter()
            .map(|segment| segment.to_string())
            .collect::<String>()
            .trim()
            .to_string())
    }
}

#[derive(Clone)]
struct VoiceService {
    inner: Arc<VoiceServiceInner>,
}

struct VoiceServiceInner {
    client: reqwest::Client,
    engine: Arc<dyn VoiceEngine>,
    inference: Semaphore,
    install: Mutex<()>,
    downloading: AtomicBool,
    model: OnceCell<Arc<dyn LoadedVoiceModel>>,
    model_dir: PathBuf,
    spec: ModelSpec,
}

struct DownloadingGuard<'a>(&'a AtomicBool);

impl<'a> DownloadingGuard<'a> {
    fn new(flag: &'a AtomicBool) -> Self {
        flag.store(true, Ordering::Relaxed);
        Self(flag)
    }
}

impl Drop for DownloadingGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

struct TranscriptionGuard(Arc<AtomicBool>);

impl Drop for TranscriptionGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

impl VoiceService {
    fn new(model_dir: PathBuf, acceleration: VoiceAcceleration) -> Self {
        Self::with_dependencies(
            model_dir,
            ModelSpec::large_v3_turbo(),
            reqwest::Client::new(),
            Arc::new(WhisperVoiceEngine::new(acceleration)),
        )
    }

    fn with_dependencies(
        model_dir: PathBuf,
        spec: ModelSpec,
        client: reqwest::Client,
        engine: Arc<dyn VoiceEngine>,
    ) -> Self {
        Self {
            inner: Arc::new(VoiceServiceInner {
                client,
                engine,
                inference: Semaphore::new(1),
                install: Mutex::new(()),
                downloading: AtomicBool::new(false),
                model: OnceCell::new(),
                model_dir,
                spec,
            }),
        }
    }

    fn model_path(&self) -> PathBuf {
        self.inner.model_dir.join(&self.inner.spec.filename)
    }

    fn checksum_path(&self) -> PathBuf {
        self.inner
            .model_dir
            .join(format!("{}.sha256", self.inner.spec.filename))
    }

    async fn status(&self) -> VoiceStatusResponse {
        VoiceStatusResponse {
            supported: true,
            model: VoiceModelStatus {
                id: self.inner.spec.id.clone(),
                bytes: self.inner.spec.bytes,
                installed: self.is_installed().await,
                loaded: self.inner.model.get().is_some(),
                downloading: self.inner.downloading.load(Ordering::Relaxed),
            },
            max_recording_seconds: MAX_AUDIO_SECONDS,
        }
    }

    async fn is_installed(&self) -> bool {
        let Ok(metadata) = tokio::fs::metadata(self.model_path()).await else {
            return false;
        };
        if metadata.len() != self.inner.spec.bytes {
            return false;
        }
        tokio::fs::read_to_string(self.checksum_path())
            .await
            .is_ok_and(|checksum| checksum.trim() == self.inner.spec.sha256)
    }

    async fn install(&self) -> Result<VoiceStatusResponse, VoiceApiError> {
        let _install = self.inner.install.lock().await;
        if self.is_installed().await {
            return Ok(self.status().await);
        }

        let downloading = DownloadingGuard::new(&self.inner.downloading);
        self.download_model().await?;
        drop(downloading);
        Ok(self.status().await)
    }

    async fn download_model(&self) -> Result<(), VoiceApiError> {
        tokio::fs::create_dir_all(&self.inner.model_dir)
            .await
            .map_err(|error| VoiceApiError::internal("voice_model_install_failed", error))?;
        let model_path = self.model_path();
        let part_path = model_path.with_extension("bin.part");
        let checksum_path = self.checksum_path();
        let checksum_part_path = checksum_path.with_extension("sha256.part");
        let _ = tokio::fs::remove_file(&part_path).await;
        let _ = tokio::fs::remove_file(&checksum_part_path).await;

        let result = async {
            let response = self
                .inner
                .client
                .get(&self.inner.spec.url)
                .send()
                .await
                .and_then(reqwest::Response::error_for_status)
                .map_err(|error| {
                    warn!(error = ?error, "voice model request failed");
                    VoiceApiError::download(error.to_string())
                })?;
            if response
                .content_length()
                .is_some_and(|length| length != self.inner.spec.bytes)
            {
                return Err(VoiceApiError::download(
                    "the model download size did not match the pinned model".to_string(),
                ));
            }

            let mut file = tokio::fs::File::create(&part_path)
                .await
                .map_err(|error| VoiceApiError::internal("voice_model_install_failed", error))?;
            let mut stream = response.bytes_stream();
            let mut hasher = Sha256::new();
            let mut bytes = 0_u64;
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| VoiceApiError::download(error.to_string()))?;
                bytes = bytes.saturating_add(chunk.len() as u64);
                if bytes > self.inner.spec.bytes {
                    return Err(VoiceApiError::download(
                        "the model download exceeded the pinned size".to_string(),
                    ));
                }
                hasher.update(&chunk);
                file.write_all(&chunk).await.map_err(|error| {
                    VoiceApiError::internal("voice_model_install_failed", error)
                })?;
            }
            file.flush()
                .await
                .map_err(|error| VoiceApiError::internal("voice_model_install_failed", error))?;
            file.sync_all()
                .await
                .map_err(|error| VoiceApiError::internal("voice_model_install_failed", error))?;
            drop(file);

            if bytes != self.inner.spec.bytes {
                return Err(VoiceApiError::download(format!(
                    "the model download was incomplete ({bytes} of {} bytes)",
                    self.inner.spec.bytes
                )));
            }
            let checksum = format!("{:x}", hasher.finalize());
            if checksum != self.inner.spec.sha256 {
                return Err(VoiceApiError::download(
                    "the model download failed checksum verification".to_string(),
                ));
            }

            tokio::fs::write(&checksum_part_path, format!("{checksum}\n"))
                .await
                .map_err(|error| VoiceApiError::internal("voice_model_install_failed", error))?;
            tokio::fs::rename(&part_path, &model_path)
                .await
                .map_err(|error| VoiceApiError::internal("voice_model_install_failed", error))?;
            tokio::fs::rename(&checksum_part_path, &checksum_path)
                .await
                .map_err(|error| VoiceApiError::internal("voice_model_install_failed", error))?;
            Ok(())
        }
        .await;

        if result.is_err() {
            let _ = tokio::fs::remove_file(&part_path).await;
            let _ = tokio::fs::remove_file(&checksum_part_path).await;
        }
        result
    }

    async fn loaded_model(&self) -> Result<Arc<dyn LoadedVoiceModel>, VoiceApiError> {
        if !self.is_installed().await {
            return Err(VoiceApiError::new(
                StatusCode::CONFLICT,
                "voice_model_unavailable",
                format!(
                    "Download the Whisper {} model before using voice input.",
                    self.inner.spec.id
                ),
            ));
        }
        let engine = self.inner.engine.clone();
        let model_path = self.model_path();
        self.inner
            .model
            .get_or_try_init(|| async move {
                tokio::task::spawn_blocking(move || engine.load(&model_path))
                    .await
                    .map_err(|error| VoiceApiError::internal("voice_model_load_failed", error))?
                    .map_err(|message| {
                        error!(%message, "failed to load voice model");
                        VoiceApiError::new(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            "voice_model_load_failed",
                            "Caffold could not load the Whisper model.",
                        )
                    })
            })
            .await
            .cloned()
    }

    async fn transcribe(&self, wav: Bytes) -> Result<VoiceTranscriptResponse, VoiceApiError> {
        let audio = decode_wav(&wav)?;
        let _inference = self
            .inner
            .inference
            .acquire()
            .await
            .map_err(|error| VoiceApiError::internal("voice_unavailable", error))?;
        let model = self.loaded_model().await?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let _transcription = TranscriptionGuard(cancelled.clone());
        let result = tokio::task::spawn_blocking(move || model.transcribe(&audio, cancelled))
            .await
            .map_err(|error| VoiceApiError::internal("voice_transcription_failed", error))?;
        let text = result.map_err(|message| {
            warn!(%message, "voice transcription failed");
            VoiceApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "voice_transcription_failed",
                "Caffold could not transcribe this recording.",
            )
        })?;
        Ok(VoiceTranscriptResponse {
            text,
            model: self.inner.spec.id.clone(),
        })
    }
}

fn decode_wav(bytes: &[u8]) -> Result<Vec<f32>, VoiceApiError> {
    let reader = WavReader::new(Cursor::new(bytes)).map_err(|error| {
        VoiceApiError::bad_audio(format!("The recording is not a valid WAV file: {error}"))
    })?;
    let spec = reader.spec();
    if spec.channels != 1
        || spec.sample_rate != AUDIO_SAMPLE_RATE
        || spec.bits_per_sample != 16
        || spec.sample_format != SampleFormat::Int
    {
        return Err(VoiceApiError::bad_audio(
            "Use 16 kHz mono 16-bit PCM WAV audio.".to_string(),
        ));
    }
    if reader.duration() as usize > MAX_AUDIO_SAMPLES {
        return Err(VoiceApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "voice_recording_too_long",
            format!("Recordings must be {MAX_AUDIO_SECONDS} seconds or shorter."),
        ));
    }
    let samples = reader
        .into_samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| VoiceApiError::bad_audio(format!("Invalid PCM samples: {error}")))?;
    if samples.is_empty() {
        return Err(VoiceApiError::bad_audio(
            "The recording did not contain any audio samples.".to_string(),
        ));
    }
    let mut audio = vec![0.0; samples.len()];
    whisper_rs::convert_integer_to_float_audio(&samples, &mut audio)
        .map_err(|error| VoiceApiError::bad_audio(error.to_string()))?;
    Ok(audio)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceStatusResponse {
    supported: bool,
    model: VoiceModelStatus,
    max_recording_seconds: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceModelStatus {
    id: String,
    bytes: u64,
    installed: bool,
    loaded: bool,
    downloading: bool,
}

#[derive(Debug, Serialize)]
struct VoiceTranscriptResponse {
    text: String,
    model: String,
}

#[derive(Debug)]
struct VoiceApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl VoiceApiError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn bad_audio(message: String) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_voice_audio", message)
    }

    fn download(message: String) -> Self {
        warn!(%message, "voice model download failed");
        Self::new(
            StatusCode::BAD_GATEWAY,
            "voice_model_download_failed",
            message,
        )
    }

    fn internal(code: &'static str, error: impl std::fmt::Display) -> Self {
        error!(%error, "voice service failure");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            code,
            "Caffold's voice service encountered an internal error.",
        )
    }
}

#[derive(Serialize)]
struct VoiceErrorResponse {
    error: VoiceErrorBody,
}

#[derive(Serialize)]
struct VoiceErrorBody {
    code: &'static str,
    message: String,
}

impl IntoResponse for VoiceApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(VoiceErrorResponse {
                error: VoiceErrorBody {
                    code: self.code,
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

pub(super) fn router(model_dir: PathBuf, acceleration: VoiceAcceleration) -> Router {
    router_with_service(VoiceService::new(model_dir, acceleration))
}

fn router_with_service(service: VoiceService) -> Router {
    Router::new()
        .route("/api/voice/status", get(voice_status))
        .route("/api/voice/model/install", post(install_voice_model))
        .route(
            "/api/voice/transcribe",
            post(transcribe_voice).layer(DefaultBodyLimit::max(MAX_AUDIO_BYTES)),
        )
        .with_state(service)
}

async fn voice_status(State(service): State<VoiceService>) -> Json<VoiceStatusResponse> {
    Json(service.status().await)
}

async fn install_voice_model(
    State(service): State<VoiceService>,
) -> Result<Json<VoiceStatusResponse>, VoiceApiError> {
    service.install().await.map(Json)
}

async fn transcribe_voice(
    State(service): State<VoiceService>,
    headers: axum::http::HeaderMap,
    body: Bytes,
) -> Result<Json<VoiceTranscriptResponse>, VoiceApiError> {
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        != Some("audio/wav")
    {
        return Err(VoiceApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_voice_audio",
            "Send the recording as audio/wav.",
        ));
    }
    service.transcribe(body).await.map(Json)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use axum::{body::Body, http::Request};
    use tempfile::TempDir;
    use tower::ServiceExt;

    use super::*;

    fn wav_bytes(samples: &[i16], sample_rate: u32, channels: u16) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer = hound::WavWriter::new(
                &mut cursor,
                hound::WavSpec {
                    channels,
                    sample_rate,
                    bits_per_sample: 16,
                    sample_format: SampleFormat::Int,
                },
            )
            .unwrap();
            for sample in samples {
                writer.write_sample(*sample).unwrap();
            }
            writer.finalize().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn decodes_exact_browser_wav_contract() {
        let audio = decode_wav(&wav_bytes(&[i16::MIN, 0, i16::MAX], 16_000, 1)).unwrap();
        assert_eq!(audio.len(), 3);
        assert_eq!(audio[0], -1.0);
        assert_eq!(audio[1], 0.0);
        assert!(audio[2] > 0.999);
    }

    #[test]
    fn acceleration_selects_gpu_probe_or_cpu_only() {
        assert!(VoiceAcceleration::Auto.use_gpu());
        assert!(!VoiceAcceleration::Cpu.use_gpu());
    }

    #[test]
    fn rejects_audio_outside_the_browser_wav_contract() {
        let error = decode_wav(&wav_bytes(&[0, 0], 48_000, 1)).unwrap_err();
        assert_eq!(error.code, "invalid_voice_audio");

        let error = decode_wav(&wav_bytes(&[0, 0], 16_000, 2)).unwrap_err();
        assert_eq!(error.code, "invalid_voice_audio");

        let error = decode_wav(b"not wave audio").unwrap_err();
        assert_eq!(error.code, "invalid_voice_audio");

        let error = decode_wav(&wav_bytes(&vec![0; MAX_AUDIO_SAMPLES + 1], 16_000, 1)).unwrap_err();
        assert_eq!(error.code, "voice_recording_too_long");
    }

    #[derive(Default)]
    struct FakeEngine {
        loads: Arc<AtomicUsize>,
    }

    impl VoiceEngine for FakeEngine {
        fn load(&self, _path: &Path) -> Result<Arc<dyn LoadedVoiceModel>, String> {
            self.loads.fetch_add(1, Ordering::SeqCst);
            Ok(Arc::new(FakeModel))
        }
    }

    struct FakeModel;

    impl LoadedVoiceModel for FakeModel {
        fn transcribe(
            &self,
            _audio: &[f32],
            _cancelled: Arc<AtomicBool>,
        ) -> Result<String, String> {
            Ok("테스트 transcript".to_string())
        }
    }

    fn fake_service(temp: &TempDir, engine: Arc<FakeEngine>) -> VoiceService {
        let body = b"model";
        let checksum = format!("{:x}", Sha256::digest(body));
        let spec = ModelSpec {
            id: "test-small".to_string(),
            filename: "model.bin".to_string(),
            url: "http://127.0.0.1/unused".to_string(),
            sha256: checksum.clone(),
            bytes: body.len() as u64,
        };
        std::fs::write(temp.path().join("model.bin"), body).unwrap();
        std::fs::write(temp.path().join("model.bin.sha256"), checksum).unwrap();
        VoiceService::with_dependencies(
            temp.path().to_path_buf(),
            spec,
            reqwest::Client::new(),
            engine,
        )
    }

    async fn model_server(body: Vec<u8>, requests: Arc<AtomicUsize>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route(
            "/model.bin",
            get(move || {
                let body = body.clone();
                let requests = requests.clone();
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    body
                }
            }),
        );
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}/model.bin")
    }

    fn download_service(
        temp: &TempDir,
        url: String,
        body: &[u8],
        checksum: String,
    ) -> VoiceService {
        VoiceService::with_dependencies(
            temp.path().to_path_buf(),
            ModelSpec {
                id: "test-small".to_string(),
                filename: "model.bin".to_string(),
                url,
                sha256: checksum,
                bytes: body.len() as u64,
            },
            reqwest::Client::new(),
            Arc::new(FakeEngine::default()),
        )
    }

    #[tokio::test]
    async fn lazy_loads_the_model_once_and_keeps_it_available() {
        let temp = TempDir::new().unwrap();
        let engine = Arc::new(FakeEngine::default());
        let service = fake_service(&temp, engine.clone());
        let wav = Bytes::from(wav_bytes(&[0; 1_600], 16_000, 1));

        assert!(!service.status().await.model.loaded);
        assert_eq!(
            service.transcribe(wav.clone()).await.unwrap().text,
            "테스트 transcript"
        );
        assert_eq!(
            service.transcribe(wav).await.unwrap().text,
            "테스트 transcript"
        );
        assert_eq!(engine.loads.load(Ordering::SeqCst), 1);
        assert!(service.status().await.model.loaded);
        let mut files = std::fs::read_dir(temp.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        files.sort();
        assert_eq!(files, ["model.bin", "model.bin.sha256"]);
    }

    #[tokio::test]
    async fn requires_the_pinned_install_marker_before_loading() {
        let temp = TempDir::new().unwrap();
        let engine = Arc::new(FakeEngine::default());
        let service = fake_service(&temp, engine.clone());
        std::fs::remove_file(temp.path().join("model.bin.sha256")).unwrap();

        let error = service
            .transcribe(Bytes::from(wav_bytes(&[0; 1_600], 16_000, 1)))
            .await
            .unwrap_err();
        assert_eq!(error.code, "voice_model_unavailable");
        assert_eq!(engine.loads.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn downloads_once_and_publishes_only_a_verified_model() {
        let temp = TempDir::new().unwrap();
        let body = b"verified model".to_vec();
        let requests = Arc::new(AtomicUsize::new(0));
        let url = model_server(body.clone(), requests.clone()).await;
        let checksum = format!("{:x}", Sha256::digest(&body));
        let service = download_service(&temp, url, &body, checksum.clone());

        let (first, second) = tokio::join!(service.install(), service.install());
        let first = first.unwrap().model;
        let second = second.unwrap().model;
        assert!(first.installed);
        assert!(second.installed);
        assert!(!first.downloading);
        assert!(!second.downloading);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(std::fs::read(temp.path().join("model.bin")).unwrap(), body);
        assert_eq!(
            std::fs::read_to_string(temp.path().join("model.bin.sha256"))
                .unwrap()
                .trim(),
            checksum
        );
        assert!(!temp.path().join("model.bin.part").exists());
    }

    #[tokio::test]
    async fn checksum_failure_leaves_no_model_or_partial_file() {
        let temp = TempDir::new().unwrap();
        let body = b"wrong model".to_vec();
        let url = model_server(body.clone(), Arc::new(AtomicUsize::new(0))).await;
        let service = download_service(&temp, url, &body, "0".repeat(64));

        let error = service.install().await.unwrap_err();
        assert_eq!(error.code, "voice_model_download_failed");
        assert!(!temp.path().join("model.bin").exists());
        assert!(!temp.path().join("model.bin.part").exists());
        assert!(!service.status().await.model.downloading);
    }

    #[tokio::test]
    async fn voice_routes_enforce_content_type_and_body_limit() {
        let temp = TempDir::new().unwrap();
        let service = fake_service(&temp, Arc::new(FakeEngine::default()));
        let app = router_with_service(service);

        let status = app
            .clone()
            .oneshot(
                Request::get("/api/voice/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(status.status(), StatusCode::OK);

        let transcript = app
            .clone()
            .oneshot(
                Request::post("/api/voice/transcribe")
                    .header(header::CONTENT_TYPE, "audio/wav")
                    .body(Body::from(wav_bytes(&[0; 1_600], 16_000, 1)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(transcript.status(), StatusCode::OK);
        let transcript = axum::body::to_bytes(transcript.into_body(), MAX_AUDIO_BYTES)
            .await
            .unwrap();
        let transcript: serde_json::Value = serde_json::from_slice(&transcript).unwrap();
        assert_eq!(transcript["text"], "테스트 transcript");
        assert_eq!(transcript["model"], "test-small");

        let unsupported = app
            .clone()
            .oneshot(
                Request::post("/api/voice/transcribe")
                    .body(Body::from("not audio"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unsupported.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);

        let too_large = app
            .oneshot(
                Request::post("/api/voice/transcribe")
                    .header(header::CONTENT_TYPE, "audio/wav")
                    .body(Body::from(vec![0; MAX_AUDIO_BYTES + 1]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(too_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    #[ignore = "requires CAFFOLD_WHISPER_MODEL and CAFFOLD_WHISPER_WAV"]
    fn live_pinned_model_transcribes_a_real_wav() {
        let model_path = std::env::var("CAFFOLD_WHISPER_MODEL")
            .expect("set CAFFOLD_WHISPER_MODEL to a pinned Whisper GGML model");
        let wav_path =
            std::env::var("CAFFOLD_WHISPER_WAV").expect("set CAFFOLD_WHISPER_WAV to a WAV file");
        let wav = std::fs::read(wav_path).unwrap();
        let audio = decode_wav(&wav).unwrap();
        let model = WhisperVoiceEngine::new(VoiceAcceleration::Cpu)
            .load(Path::new(&model_path))
            .unwrap();
        let transcript = model
            .transcribe(&audio, Arc::new(AtomicBool::new(false)))
            .unwrap();
        assert!(!transcript.trim().is_empty());
        println!("{transcript}");
    }
}
