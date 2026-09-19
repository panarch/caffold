use std::{
    io::{self, Cursor},
    mem,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        Arc, PoisonError, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, Path as PathParam, State},
    http::{HeaderMap, StatusCode, header, uri::Authority},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
};
use futures_util::StreamExt;
use hound::{SampleFormat, WavReader};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    io::AsyncWriteExt,
    sync::{Mutex, Semaphore},
    task::JoinHandle,
};
use tracing::{error, warn};
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, install_logging_hooks,
};

use keys::{ApiKeyStore, KeyStoreError};
use settings::VoiceSettingsStore;

mod gemini;
mod grok;
mod keys;
mod openai;
mod settings;

const MODEL_ID: &str = "large-v3-turbo";
const MODEL_FILENAME: &str = "ggml-large-v3-turbo.bin";
const MODEL_REVISION: &str = "5359861c739e955e79d9a303bcbc70fb988958b1";
const MODEL_SHA256: &str = "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69";
const MODEL_BYTES: u64 = 1_624_555_275;
const MAX_AUDIO_BYTES: usize = 10 * 1024 * 1024;
const AUDIO_SAMPLE_RATE: u32 = 16_000;
const MAX_AUDIO_SECONDS: usize = 5 * 60;
const MAX_AUDIO_SAMPLES: usize = AUDIO_SAMPLE_RATE as usize * MAX_AUDIO_SECONDS;
const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);

/// The speech-to-text provider that transcribes a recording.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum VoiceProvider {
    Whisper,
    Openai,
    Gemini,
    Grok,
}

/// A provider reached over HTTPS with an API key the user entered.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum CloudProvider {
    Openai,
    Gemini,
    Grok,
}

impl CloudProvider {
    fn name(self) -> &'static str {
        match self {
            Self::Openai => "OpenAI",
            Self::Gemini => "Gemini",
            Self::Grok => "Grok",
        }
    }
}

/// Why a cloud provider returned no transcript.
#[derive(Debug, PartialEq, Eq)]
enum ProviderFailure {
    KeyRejected,
    RateLimited,
    Rejected,
    Unavailable,
    UnexpectedResponse,
}

#[derive(Clone)]
struct ProviderEndpoints {
    openai: String,
    gemini: String,
    grok: String,
}

impl ProviderEndpoints {
    fn public() -> Self {
        Self {
            openai: openai::API_BASE.to_string(),
            gemini: gemini::API_BASE.to_string(),
            grok: grok::API_BASE.to_string(),
        }
    }
}

#[derive(Clone)]
struct ModelSpec {
    id: String,
    revision: String,
    filename: String,
    url: String,
    sha256: String,
    bytes: u64,
}

impl ModelSpec {
    fn large_v3_turbo() -> Self {
        Self {
            id: MODEL_ID.to_string(),
            revision: MODEL_REVISION.to_string(),
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

struct WhisperVoiceEngine;

impl VoiceEngine for WhisperVoiceEngine {
    fn load(&self, path: &Path) -> Result<Arc<dyn LoadedVoiceModel>, String> {
        install_logging_hooks();
        let mut params = WhisperContextParameters::default();
        params.use_gpu(true);
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
    endpoints: ProviderEndpoints,
    engine: Arc<dyn VoiceEngine>,
    inference: Semaphore,
    keys: ApiKeyStore,
    /// Serializes Whisper model transitions. Loading holds it, so requests
    /// that arrive during a load are handled after the load.
    lifecycle: Mutex<ModelLifecycle>,
    model_dir: PathBuf,
    settings: VoiceSettingsStore,
    /// Published by every lifecycle transition for reads that must not wait
    /// for a load or download step to finish.
    snapshot: RwLock<ModelSnapshot>,
    spec: ModelSpec,
}

struct ModelLifecycle {
    node: ModelNode,
    generation: u64,
    download_error: Option<String>,
}

enum ModelNode {
    Idle,
    Downloading {
        generation: u64,
        task: JoinHandle<()>,
    },
    Loaded(Arc<dyn LoadedVoiceModel>),
}

#[derive(Clone, Default)]
struct ModelSnapshot {
    downloading: bool,
    loaded: bool,
    download_error: Option<String>,
}

struct PartialModelPaths {
    model: PathBuf,
    checksum: PathBuf,
}

struct TranscriptionGuard(Arc<AtomicBool>);

impl Drop for TranscriptionGuard {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

impl VoiceService {
    fn new(data_dir: &Path) -> Self {
        Self::with_dependencies(
            data_dir,
            ModelSpec::large_v3_turbo(),
            reqwest::Client::new(),
            Arc::new(WhisperVoiceEngine),
            ProviderEndpoints::public(),
        )
    }

    fn with_dependencies(
        data_dir: &Path,
        spec: ModelSpec,
        client: reqwest::Client,
        engine: Arc<dyn VoiceEngine>,
        endpoints: ProviderEndpoints,
    ) -> Self {
        let voice_dir = data_dir.join("voice");
        Self {
            inner: Arc::new(VoiceServiceInner {
                client,
                endpoints,
                engine,
                inference: Semaphore::new(1),
                keys: ApiKeyStore::open(voice_dir.clone()),
                lifecycle: Mutex::new(ModelLifecycle {
                    node: ModelNode::Idle,
                    generation: 0,
                    download_error: None,
                }),
                model_dir: data_dir.join("models/whisper"),
                settings: VoiceSettingsStore::open(voice_dir),
                snapshot: RwLock::new(ModelSnapshot::default()),
                spec,
            }),
        }
    }

    async fn status(&self) -> Result<VoiceStatusResponse, VoiceApiError> {
        let provider = self.provider()?;
        let ready = match provider {
            VoiceProvider::Whisper => self.is_installed().await,
            VoiceProvider::Openai => self.key_configured(CloudProvider::Openai)?,
            VoiceProvider::Gemini => self.key_configured(CloudProvider::Gemini)?,
            VoiceProvider::Grok => self.key_configured(CloudProvider::Grok)?,
        };
        Ok(VoiceStatusResponse {
            provider,
            ready,
            max_recording_seconds: MAX_AUDIO_SECONDS,
        })
    }

    async fn settings(&self) -> Result<VoiceSettingsResponse, VoiceApiError> {
        let selected = self.provider()?;
        let openai = CloudProviderSettings {
            model: openai::MODEL,
            key_configured: self.key_configured(CloudProvider::Openai)?,
        };
        let gemini = CloudProviderSettings {
            model: gemini::MODEL,
            key_configured: self.key_configured(CloudProvider::Gemini)?,
        };
        let grok = CloudProviderSettings {
            model: grok::MODEL,
            key_configured: self.key_configured(CloudProvider::Grok)?,
        };
        let snapshot = self
            .inner
            .snapshot
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        Ok(VoiceSettingsResponse {
            selected,
            whisper: WhisperSettings {
                model: self.inner.spec.id.clone(),
                revision: self.inner.spec.revision.clone(),
                bytes: self.inner.spec.bytes,
                installed: self.is_installed().await,
                loaded: snapshot.loaded,
                downloading: snapshot.downloading,
                download_error: snapshot.download_error,
            },
            openai,
            gemini,
            grok,
        })
    }

    async fn select_provider(
        &self,
        provider: VoiceProvider,
    ) -> Result<VoiceSettingsResponse, VoiceApiError> {
        self.inner
            .settings
            .select(provider)
            .map_err(|error| VoiceApiError::internal("voice_settings_write_failed", error))?;
        if provider != VoiceProvider::Whisper {
            self.release_model().await;
        }
        self.settings().await
    }

    async fn store_key(
        &self,
        provider: CloudProvider,
        key: &str,
    ) -> Result<VoiceSettingsResponse, VoiceApiError> {
        self.inner
            .keys
            .store(provider, key)
            .map_err(VoiceApiError::keys)?;
        self.settings().await
    }

    async fn remove_key(
        &self,
        provider: CloudProvider,
    ) -> Result<VoiceSettingsResponse, VoiceApiError> {
        self.inner
            .keys
            .remove(provider)
            .map_err(VoiceApiError::keys)?;
        self.settings().await
    }

    async fn transcribe(&self, wav: Bytes) -> Result<VoiceTranscriptResponse, VoiceApiError> {
        let audio = decode_wav(&wav)?;
        let provider = self.provider()?;
        let text = match provider {
            VoiceProvider::Whisper => self.transcribe_locally(audio).await?,
            VoiceProvider::Openai => self.transcribe_remotely(CloudProvider::Openai, wav).await?,
            VoiceProvider::Gemini => self.transcribe_remotely(CloudProvider::Gemini, wav).await?,
            VoiceProvider::Grok => self.transcribe_remotely(CloudProvider::Grok, wav).await?,
        };
        Ok(VoiceTranscriptResponse { text, provider })
    }

    async fn transcribe_locally(&self, audio: Vec<f32>) -> Result<String, VoiceApiError> {
        let model = self.loaded_model().await?;
        let _inference = self
            .inner
            .inference
            .acquire()
            .await
            .map_err(|error| VoiceApiError::internal("voice_unavailable", error))?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let _transcription = TranscriptionGuard(cancelled.clone());
        tokio::task::spawn_blocking(move || model.transcribe(&audio, cancelled))
            .await
            .map_err(|error| VoiceApiError::internal("voice_transcription_failed", error))?
            .map_err(|message| {
                warn!(%message, "voice transcription failed");
                VoiceApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "voice_transcription_failed",
                    "Caffold could not transcribe this recording.",
                )
            })
    }

    async fn transcribe_remotely(
        &self,
        provider: CloudProvider,
        wav: Bytes,
    ) -> Result<String, VoiceApiError> {
        let key = self
            .inner
            .keys
            .key(provider)
            .map_err(VoiceApiError::keys)?
            .ok_or_else(|| {
                VoiceApiError::not_ready(format!(
                    "Add your {} API key in Settings → Voice Input.",
                    provider.name()
                ))
            })?;
        let transcript = match provider {
            CloudProvider::Openai => {
                openai::transcribe(&self.inner.client, &self.inner.endpoints.openai, &key, wav)
                    .await
            }
            CloudProvider::Gemini => {
                gemini::transcribe(&self.inner.client, &self.inner.endpoints.gemini, &key, wav)
                    .await
            }
            CloudProvider::Grok => {
                grok::transcribe(&self.inner.client, &self.inner.endpoints.grok, &key, wav).await
            }
        };
        transcript.map_err(|failure| VoiceApiError::provider(provider, failure))
    }

    async fn start_model_download(&self) -> Result<VoiceSettingsResponse, VoiceApiError> {
        {
            let mut lifecycle = self.inner.lifecycle.lock().await;
            if matches!(lifecycle.node, ModelNode::Idle) && !self.is_installed().await {
                self.remove_partial_downloads().await.map_err(|error| {
                    VoiceApiError::internal("voice_model_install_failed", error)
                })?;
                lifecycle.generation += 1;
                let generation = lifecycle.generation;
                let service = self.clone();
                let task = tokio::spawn(async move { service.download_model(generation).await });
                lifecycle.download_error = None;
                self.transition(&mut lifecycle, ModelNode::Downloading { generation, task });
            }
        }
        self.settings().await
    }

    /// Runs as the `Downloading(generation)` task. Removing the model aborts
    /// this task and waits for it while holding the lifecycle lock, so the
    /// task reaches the lock only while its own node is still current.
    async fn download_model(&self, generation: u64) {
        let partial = self.partial_paths(generation);
        let fetched = self.fetch_verified_model(&partial.model).await;
        let mut lifecycle = self.inner.lifecycle.lock().await;
        debug_assert!(matches!(
            lifecycle.node,
            ModelNode::Downloading { generation: running, .. } if running == generation
        ));
        let outcome = match fetched {
            Ok(checksum) => self.publish_model(&partial, &checksum).await,
            Err(message) => Err(message),
        };
        discard_partial(&partial.model).await;
        discard_partial(&partial.checksum).await;
        if let Err(message) = outcome {
            warn!(%message, "voice model download failed");
            lifecycle.download_error = Some(message);
        }
        self.transition(&mut lifecycle, ModelNode::Idle);
    }

    async fn fetch_verified_model(&self, part_path: &Path) -> Result<String, String> {
        tokio::fs::create_dir_all(&self.inner.model_dir)
            .await
            .map_err(model_write_error)?;
        let response = self
            .inner
            .client
            .get(&self.inner.spec.url)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|error| format!("The model download failed: {error}"))?;
        if response
            .content_length()
            .is_some_and(|length| length != self.inner.spec.bytes)
        {
            return Err("The model download size did not match the pinned model.".to_string());
        }

        let mut file = tokio::fs::File::create(part_path)
            .await
            .map_err(model_write_error)?;
        let mut stream = response.bytes_stream();
        let mut hasher = Sha256::new();
        let mut bytes = 0_u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| format!("The model download failed: {error}"))?;
            bytes = bytes.saturating_add(chunk.len() as u64);
            if bytes > self.inner.spec.bytes {
                return Err("The model download exceeded the pinned size.".to_string());
            }
            hasher.update(&chunk);
            file.write_all(&chunk).await.map_err(model_write_error)?;
        }
        file.flush().await.map_err(model_write_error)?;
        file.sync_all().await.map_err(model_write_error)?;

        if bytes != self.inner.spec.bytes {
            return Err(format!(
                "The model download was incomplete ({bytes} of {} bytes).",
                self.inner.spec.bytes
            ));
        }
        let checksum = format!("{:x}", hasher.finalize());
        if checksum != self.inner.spec.sha256 {
            return Err("The model download failed checksum verification.".to_string());
        }
        Ok(checksum)
    }

    async fn publish_model(
        &self,
        partial: &PartialModelPaths,
        checksum: &str,
    ) -> Result<(), String> {
        tokio::fs::write(&partial.checksum, format!("{checksum}\n"))
            .await
            .map_err(model_write_error)?;
        tokio::fs::rename(&partial.model, self.model_path())
            .await
            .map_err(model_write_error)?;
        tokio::fs::rename(&partial.checksum, self.checksum_path())
            .await
            .map_err(model_write_error)
    }

    async fn remove_model(&self) -> Result<VoiceSettingsResponse, VoiceApiError> {
        {
            let mut lifecycle = self.inner.lifecycle.lock().await;
            if !matches!(lifecycle.node, ModelNode::Idle) {
                let previous = self.transition(&mut lifecycle, ModelNode::Idle);
                if let ModelNode::Downloading { task, .. } = previous {
                    task.abort();
                    let _ = task.await;
                }
            }
            for path in [self.model_path(), self.checksum_path()] {
                remove_file_if_present(&path)
                    .await
                    .map_err(|error| VoiceApiError::internal("voice_model_remove_failed", error))?;
            }
            self.remove_partial_downloads()
                .await
                .map_err(|error| VoiceApiError::internal("voice_model_remove_failed", error))?;
        }
        self.settings().await
    }

    async fn release_model(&self) {
        let mut lifecycle = self.inner.lifecycle.lock().await;
        if matches!(lifecycle.node, ModelNode::Loaded(_)) {
            self.transition(&mut lifecycle, ModelNode::Idle);
        }
    }

    async fn loaded_model(&self) -> Result<Arc<dyn LoadedVoiceModel>, VoiceApiError> {
        let mut lifecycle = self.inner.lifecycle.lock().await;
        match &lifecycle.node {
            ModelNode::Loaded(model) => return Ok(model.clone()),
            ModelNode::Downloading { .. } => return Err(VoiceApiError::whisper_not_ready()),
            ModelNode::Idle => {}
        }
        if !self.is_installed().await {
            return Err(VoiceApiError::whisper_not_ready());
        }
        let engine = self.inner.engine.clone();
        let model_path = self.model_path();
        let model = tokio::task::spawn_blocking(move || engine.load(&model_path))
            .await
            .map_err(|error| VoiceApiError::internal("voice_model_load_failed", error))?
            .map_err(|message| {
                error!(%message, "failed to load voice model");
                VoiceApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "voice_model_load_failed",
                    "Caffold could not load the Whisper model.",
                )
            })?;
        if self.inner.settings.provider() == Ok(VoiceProvider::Whisper) {
            self.transition(&mut lifecycle, ModelNode::Loaded(model.clone()));
        }
        Ok(model)
    }

    /// The single transition authority for the Whisper model. Callers hold the
    /// lifecycle lock; the allowed edges are `Idle` to `Downloading` or
    /// `Loaded`, and either of those back to `Idle`. Every change is published
    /// for status reads.
    fn transition(&self, lifecycle: &mut ModelLifecycle, next: ModelNode) -> ModelNode {
        debug_assert!(
            matches!(
                (&lifecycle.node, &next),
                (
                    ModelNode::Idle,
                    ModelNode::Downloading { .. } | ModelNode::Loaded(_)
                ) | (
                    ModelNode::Downloading { .. } | ModelNode::Loaded(_),
                    ModelNode::Idle
                )
            ),
            "invalid Whisper model transition"
        );
        let previous = mem::replace(&mut lifecycle.node, next);
        *self
            .inner
            .snapshot
            .write()
            .unwrap_or_else(PoisonError::into_inner) = ModelSnapshot {
            downloading: matches!(lifecycle.node, ModelNode::Downloading { .. }),
            loaded: matches!(lifecycle.node, ModelNode::Loaded(_)),
            download_error: lifecycle.download_error.clone(),
        };
        previous
    }

    fn provider(&self) -> Result<VoiceProvider, VoiceApiError> {
        self.inner
            .settings
            .provider()
            .map_err(VoiceApiError::settings_unavailable)
    }

    fn key_configured(&self, provider: CloudProvider) -> Result<bool, VoiceApiError> {
        self.inner
            .keys
            .is_configured(provider)
            .map_err(VoiceApiError::keys)
    }

    fn model_path(&self) -> PathBuf {
        self.inner.model_dir.join(&self.inner.spec.filename)
    }

    fn checksum_path(&self) -> PathBuf {
        self.inner
            .model_dir
            .join(format!("{}.sha256", self.inner.spec.filename))
    }

    fn partial_paths(&self, generation: u64) -> PartialModelPaths {
        let filename = &self.inner.spec.filename;
        PartialModelPaths {
            model: self
                .inner
                .model_dir
                .join(format!("{filename}.{generation}.part")),
            checksum: self
                .inner
                .model_dir
                .join(format!("{filename}.sha256.{generation}.part")),
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

    async fn remove_partial_downloads(&self) -> io::Result<()> {
        let mut entries = match tokio::fs::read_dir(&self.inner.model_dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(&self.inner.spec.filename) && name.ends_with(".part") {
                remove_file_if_present(&entry.path()).await?;
            }
        }
        Ok(())
    }
}

async fn remove_file_if_present(path: &Path) -> io::Result<()> {
    match tokio::fs::remove_file(path).await {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

async fn discard_partial(path: &Path) {
    if let Err(error) = remove_file_if_present(path).await {
        warn!(%error, path = %path.display(), "could not remove a partial voice model download");
    }
}

fn model_write_error(error: io::Error) -> String {
    format!("Caffold could not save the model: {error}")
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

/// What the Composer and the macOS menu need to offer voice input.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceStatusResponse {
    provider: VoiceProvider,
    ready: bool,
    max_recording_seconds: usize,
}

/// What Settings → Voice Input manages. Key values never appear here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceSettingsResponse {
    selected: VoiceProvider,
    whisper: WhisperSettings,
    openai: CloudProviderSettings,
    gemini: CloudProviderSettings,
    grok: CloudProviderSettings,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WhisperSettings {
    model: String,
    revision: String,
    bytes: u64,
    installed: bool,
    loaded: bool,
    downloading: bool,
    download_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudProviderSettings {
    model: &'static str,
    key_configured: bool,
}

#[derive(Debug, Serialize)]
struct VoiceTranscriptResponse {
    text: String,
    provider: VoiceProvider,
}

#[derive(Deserialize)]
struct SelectProviderRequest {
    provider: VoiceProvider,
}

#[derive(Deserialize)]
struct StoreKeyRequest {
    key: String,
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

    /// The selected provider cannot transcribe until Settings → Voice Input fixes it.
    fn not_ready(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, "voice_provider_not_ready", message)
    }

    fn whisper_not_ready() -> Self {
        Self::not_ready("Download the Whisper model in Settings → Voice Input.")
    }

    fn provider(provider: CloudProvider, failure: ProviderFailure) -> Self {
        let name = provider.name();
        warn!(provider = name, ?failure, "cloud transcription failed");
        let failed = |message: String| {
            Self::new(
                StatusCode::BAD_GATEWAY,
                "voice_transcription_failed",
                message,
            )
        };
        match failure {
            ProviderFailure::KeyRejected => Self::not_ready(format!(
                "{name} rejected the API key. Update it in Settings → Voice Input."
            )),
            ProviderFailure::RateLimited => {
                failed(format!("{name} rate limit or quota was reached."))
            }
            ProviderFailure::Rejected => {
                failed(format!("{name} could not transcribe this recording."))
            }
            ProviderFailure::Unavailable => failed(format!("Caffold could not reach {name}.")),
            ProviderFailure::UnexpectedResponse => failed(format!(
                "{name} returned a response Caffold could not read."
            )),
        }
    }

    fn settings_unavailable(detail: String) -> Self {
        error!(%detail, "voice settings are unreadable");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "voice_settings_unavailable",
            "Caffold could not read its voice settings.",
        )
    }

    fn keys(error: KeyStoreError) -> Self {
        match error {
            KeyStoreError::Unreadable(detail) => Self::settings_unavailable(detail),
            KeyStoreError::InvalidKey(message) => {
                Self::new(StatusCode::BAD_REQUEST, "invalid_voice_key", message)
            }
            KeyStoreError::Write(error) => Self::internal("voice_settings_write_failed", error),
        }
    }

    fn same_origin_required() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "voice_same_origin_required",
            "Voice settings changes require a same-origin request.",
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

pub(super) fn router(data_dir: &Path) -> Router {
    router_with_service(VoiceService::new(data_dir))
}

fn router_with_service(service: VoiceService) -> Router {
    Router::new()
        .route("/api/voice/status", get(voice_status))
        .route("/api/voice/settings", get(voice_settings))
        .route("/api/voice/provider", put(select_voice_provider))
        .route("/api/voice/model", delete(remove_voice_model))
        .route("/api/voice/model/install", post(install_voice_model))
        .route(
            "/api/voice/keys/{provider}",
            put(store_voice_key).delete(remove_voice_key),
        )
        .route(
            "/api/voice/transcribe",
            post(transcribe_voice).layer(DefaultBodyLimit::max(MAX_AUDIO_BYTES)),
        )
        .with_state(service)
}

async fn voice_status(
    State(service): State<VoiceService>,
) -> Result<Json<VoiceStatusResponse>, VoiceApiError> {
    service.status().await.map(Json)
}

async fn voice_settings(
    State(service): State<VoiceService>,
) -> Result<Json<VoiceSettingsResponse>, VoiceApiError> {
    service.settings().await.map(Json)
}

async fn select_voice_provider(
    State(service): State<VoiceService>,
    headers: HeaderMap,
    Json(request): Json<SelectProviderRequest>,
) -> Result<Json<VoiceSettingsResponse>, VoiceApiError> {
    require_same_origin(&headers)?;
    service.select_provider(request.provider).await.map(Json)
}

async fn install_voice_model(
    State(service): State<VoiceService>,
    headers: HeaderMap,
) -> Result<Json<VoiceSettingsResponse>, VoiceApiError> {
    require_same_origin(&headers)?;
    service.start_model_download().await.map(Json)
}

async fn remove_voice_model(
    State(service): State<VoiceService>,
    headers: HeaderMap,
) -> Result<Json<VoiceSettingsResponse>, VoiceApiError> {
    require_same_origin(&headers)?;
    service.remove_model().await.map(Json)
}

async fn store_voice_key(
    State(service): State<VoiceService>,
    PathParam(provider): PathParam<CloudProvider>,
    headers: HeaderMap,
    Json(request): Json<StoreKeyRequest>,
) -> Result<Json<VoiceSettingsResponse>, VoiceApiError> {
    require_same_origin(&headers)?;
    service.store_key(provider, &request.key).await.map(Json)
}

async fn remove_voice_key(
    State(service): State<VoiceService>,
    PathParam(provider): PathParam<CloudProvider>,
    headers: HeaderMap,
) -> Result<Json<VoiceSettingsResponse>, VoiceApiError> {
    require_same_origin(&headers)?;
    service.remove_key(provider).await.map(Json)
}

async fn transcribe_voice(
    State(service): State<VoiceService>,
    headers: HeaderMap,
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

fn require_same_origin(headers: &HeaderMap) -> Result<(), VoiceApiError> {
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    match (origin, host) {
        (Some(origin), Some(host)) if same_origin_host(origin, host) => Ok(()),
        _ => Err(VoiceApiError::same_origin_required()),
    }
}

fn same_origin_host(origin: &str, request_host: &str) -> bool {
    let Ok(origin) = Url::parse(origin) else {
        return false;
    };
    if !matches!(origin.scheme(), "http" | "https")
        || origin.path() != "/"
        || origin.query().is_some()
        || origin.fragment().is_some()
        || !origin.username().is_empty()
        || origin.password().is_some()
    {
        return false;
    }
    let Ok(authority) = Authority::from_str(request_host) else {
        return false;
    };
    let Some(origin_host) = origin.host_str() else {
        return false;
    };
    if !origin_host.eq_ignore_ascii_case(authority.host()) {
        return false;
    }
    let request_port = authority.port_u16().or_else(|| match origin.scheme() {
        "http" => Some(80),
        "https" => Some(443),
        _ => None,
    });
    request_port == origin.port_or_known_default()
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicUsize, mpsc};

    use axum::{body::Body, http::Request};
    use tempfile::TempDir;
    use tower::ServiceExt;

    use super::*;

    const SAME_ORIGIN: &str = "http://127.0.0.1:5177";
    const SAME_HOST: &str = "127.0.0.1:5177";
    const TEST_MODEL: &[u8] = b"verified model";

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

    fn short_recording() -> Bytes {
        Bytes::from(wav_bytes(&[0; 1_600], 16_000, 1))
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
        loads: AtomicUsize,
        failing_loads: AtomicUsize,
        gate: Option<LoadGate>,
    }

    struct LoadGate {
        started: std::sync::Mutex<mpsc::Sender<()>>,
        release: std::sync::Mutex<mpsc::Receiver<()>>,
    }

    impl FakeEngine {
        /// An engine whose load reports that it started and then waits to be released.
        fn gated() -> (Arc<Self>, mpsc::Receiver<()>, mpsc::Sender<()>) {
            let (started, load_started) = mpsc::channel();
            let (release_load, release) = mpsc::channel();
            let engine = Self {
                loads: AtomicUsize::new(0),
                failing_loads: AtomicUsize::new(0),
                gate: Some(LoadGate {
                    started: std::sync::Mutex::new(started),
                    release: std::sync::Mutex::new(release),
                }),
            };
            (Arc::new(engine), load_started, release_load)
        }
    }

    impl VoiceEngine for FakeEngine {
        fn load(&self, _path: &Path) -> Result<Arc<dyn LoadedVoiceModel>, String> {
            self.loads.fetch_add(1, Ordering::SeqCst);
            if let Some(gate) = &self.gate {
                gate.started.lock().unwrap().send(()).unwrap();
                gate.release.lock().unwrap().recv().unwrap();
            }
            if self
                .failing_loads
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                    remaining.checked_sub(1)
                })
                .is_ok()
            {
                return Err("the model file is damaged".to_string());
            }
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

    fn spec_for(url: String, body: &[u8]) -> ModelSpec {
        ModelSpec {
            id: "test-small".to_string(),
            revision: "test-revision".to_string(),
            filename: "model.bin".to_string(),
            url,
            sha256: format!("{:x}", Sha256::digest(body)),
            bytes: body.len() as u64,
        }
    }

    fn unreachable_endpoints() -> ProviderEndpoints {
        ProviderEndpoints {
            openai: "http://127.0.0.1:9".to_string(),
            gemini: "http://127.0.0.1:9".to_string(),
            grok: "http://127.0.0.1:9".to_string(),
        }
    }

    fn service_with(
        temp: &TempDir,
        spec: ModelSpec,
        engine: Arc<FakeEngine>,
        endpoints: ProviderEndpoints,
    ) -> VoiceService {
        VoiceService::with_dependencies(
            temp.path(),
            spec,
            reqwest::Client::new(),
            engine,
            endpoints,
        )
    }

    fn uninstalled_service(temp: &TempDir) -> VoiceService {
        service_with(
            temp,
            spec_for("http://127.0.0.1:9/unused".to_string(), TEST_MODEL),
            Arc::new(FakeEngine::default()),
            unreachable_endpoints(),
        )
    }

    fn installed_service(temp: &TempDir, engine: Arc<FakeEngine>) -> VoiceService {
        let spec = spec_for("http://127.0.0.1:9/unused".to_string(), TEST_MODEL);
        let model_dir = temp.path().join("models/whisper");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.bin"), TEST_MODEL).unwrap();
        std::fs::write(model_dir.join("model.bin.sha256"), &spec.sha256).unwrap();
        service_with(temp, spec, engine, unreachable_endpoints())
    }

    fn model_dir_entries(temp: &TempDir) -> Vec<String> {
        let mut names = std::fs::read_dir(temp.path().join("models/whisper"))
            .map(|entries| {
                entries
                    .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        names.sort();
        names
    }

    async fn serve(app: Router) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    async fn model_server(body: Vec<u8>, requests: Arc<AtomicUsize>) -> String {
        let base = serve(Router::new().route(
            "/model.bin",
            get(move || {
                let body = body.clone();
                let requests = requests.clone();
                async move {
                    requests.fetch_add(1, Ordering::SeqCst);
                    body
                }
            }),
        ))
        .await;
        format!("{base}/model.bin")
    }

    /// Sends one chunk of the model and then never finishes the response.
    async fn stalled_model_server(first_chunk: &'static [u8]) -> String {
        let base = serve(Router::new().route(
            "/model.bin",
            get(move || async move {
                let chunks = futures_util::stream::iter([Ok::<_, io::Error>(Bytes::from_static(
                    first_chunk,
                ))])
                .chain(futures_util::stream::pending());
                Body::from_stream(chunks)
            }),
        ))
        .await;
        format!("{base}/model.bin")
    }

    async fn wait_until(mut condition: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(10), async {
            while !condition() {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the condition must hold before the deadline");
    }

    async fn settled_settings(service: &VoiceService) -> VoiceSettingsResponse {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let settings = service.settings().await.unwrap();
                if !settings.whisper.downloading {
                    return settings;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the model download must settle before the deadline")
    }

    async fn wait_for_load(load_started: mpsc::Receiver<()>) {
        tokio::task::spawn_blocking(move || load_started.recv_timeout(Duration::from_secs(10)))
            .await
            .unwrap()
            .expect("the model load must start before the deadline");
    }

    #[tokio::test]
    async fn lazy_loads_the_model_once_and_keeps_it_available() {
        let temp = TempDir::new().unwrap();
        let engine = Arc::new(FakeEngine::default());
        let service = installed_service(&temp, engine.clone());

        assert!(!service.settings().await.unwrap().whisper.loaded);
        assert_eq!(
            service.transcribe(short_recording()).await.unwrap().text,
            "테스트 transcript"
        );
        assert_eq!(
            service.transcribe(short_recording()).await.unwrap().text,
            "테스트 transcript"
        );
        assert_eq!(engine.loads.load(Ordering::SeqCst), 1);
        assert!(service.settings().await.unwrap().whisper.loaded);
        assert_eq!(model_dir_entries(&temp), ["model.bin", "model.bin.sha256"]);
    }

    #[tokio::test]
    async fn requires_the_pinned_install_marker_before_loading() {
        let temp = TempDir::new().unwrap();
        let engine = Arc::new(FakeEngine::default());
        let service = installed_service(&temp, engine.clone());
        std::fs::remove_file(temp.path().join("models/whisper/model.bin.sha256")).unwrap();

        let error = service.transcribe(short_recording()).await.unwrap_err();

        assert_eq!(error.code, "voice_provider_not_ready");
        assert_eq!(
            error.message,
            "Download the Whisper model in Settings → Voice Input."
        );
        assert_eq!(engine.loads.load(Ordering::SeqCst), 0);
        assert!(!service.status().await.unwrap().ready);
    }

    #[tokio::test]
    async fn a_failed_load_stays_unloaded_and_the_next_transcription_loads_again() {
        let temp = TempDir::new().unwrap();
        let engine = Arc::new(FakeEngine::default());
        engine.failing_loads.store(1, Ordering::SeqCst);
        let service = installed_service(&temp, engine.clone());

        let error = service.transcribe(short_recording()).await.unwrap_err();

        assert_eq!(error.code, "voice_model_load_failed");
        assert!(!error.message.contains("damaged"));
        assert!(!service.settings().await.unwrap().whisper.loaded);
        assert_eq!(
            service.transcribe(short_recording()).await.unwrap().text,
            "테스트 transcript"
        );
        assert_eq!(engine.loads.load(Ordering::SeqCst), 2);
        assert!(service.settings().await.unwrap().whisper.loaded);
    }

    #[tokio::test]
    async fn downloads_once_in_the_background_and_publishes_only_a_verified_model() {
        let temp = TempDir::new().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let url = model_server(TEST_MODEL.to_vec(), requests.clone()).await;
        let service = service_with(
            &temp,
            spec_for(url, TEST_MODEL),
            Arc::new(FakeEngine::default()),
            unreachable_endpoints(),
        );

        let (first, second) = tokio::join!(
            service.start_model_download(),
            service.start_model_download()
        );
        assert!(first.unwrap().whisper.downloading);
        second.unwrap();
        let settled = settled_settings(&service).await;

        assert!(settled.whisper.installed);
        assert_eq!(settled.whisper.download_error, None);
        assert_eq!(requests.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read(temp.path().join("models/whisper/model.bin")).unwrap(),
            TEST_MODEL
        );
        assert_eq!(model_dir_entries(&temp), ["model.bin", "model.bin.sha256"]);
        assert!(service.status().await.unwrap().ready);
    }

    #[tokio::test]
    async fn a_failed_download_keeps_its_reason_until_the_next_download_starts() {
        let temp = TempDir::new().unwrap();
        let url = model_server(b"wrong model".to_vec(), Arc::new(AtomicUsize::new(0))).await;
        let service = service_with(
            &temp,
            spec_for(url, b"right model"),
            Arc::new(FakeEngine::default()),
            unreachable_endpoints(),
        );

        service.start_model_download().await.unwrap();
        let failed = settled_settings(&service).await;

        assert!(!failed.whisper.installed);
        assert!(
            failed
                .whisper
                .download_error
                .as_deref()
                .is_some_and(|reason| reason.contains("checksum"))
        );
        assert!(model_dir_entries(&temp).is_empty());

        let restarted = service.start_model_download().await.unwrap();

        assert!(restarted.whisper.downloading);
        assert_eq!(restarted.whisper.download_error, None);
        settled_settings(&service).await;
    }

    #[tokio::test]
    async fn removing_the_model_cancels_a_running_download_without_recording_a_failure() {
        let temp = TempDir::new().unwrap();
        let url = stalled_model_server(b"partial").await;
        let service = service_with(
            &temp,
            spec_for(url, TEST_MODEL),
            Arc::new(FakeEngine::default()),
            unreachable_endpoints(),
        );

        service.start_model_download().await.unwrap();
        let partial = temp.path().join("models/whisper/model.bin.1.part");
        wait_until(|| std::fs::metadata(&partial).is_ok_and(|metadata| metadata.len() == 7)).await;

        let removed = service.remove_model().await.unwrap();

        assert!(!removed.whisper.downloading);
        assert!(!removed.whisper.installed);
        assert_eq!(removed.whisper.download_error, None);
        assert!(model_dir_entries(&temp).is_empty());
    }

    #[tokio::test]
    async fn removing_the_model_during_a_load_unloads_it_after_the_load() {
        let temp = TempDir::new().unwrap();
        let (engine, load_started, release_load) = FakeEngine::gated();
        let service = installed_service(&temp, engine);
        let transcription = tokio::spawn({
            let service = service.clone();
            async move { service.transcribe(short_recording()).await }
        });
        wait_for_load(load_started).await;

        let removal = tokio::spawn({
            let service = service.clone();
            async move { service.remove_model().await }
        });
        release_load.send(()).unwrap();

        assert_eq!(
            transcription.await.unwrap().unwrap().text,
            "테스트 transcript"
        );
        let removed = removal.await.unwrap().unwrap();
        assert!(!removed.whisper.loaded);
        assert!(!removed.whisper.installed);
        assert!(model_dir_entries(&temp).is_empty());
    }

    #[tokio::test]
    async fn choosing_another_provider_releases_the_loaded_model() {
        let temp = TempDir::new().unwrap();
        let engine = Arc::new(FakeEngine::default());
        let service = installed_service(&temp, engine.clone());
        service.transcribe(short_recording()).await.unwrap();

        let switched = service
            .select_provider(VoiceProvider::Openai)
            .await
            .unwrap();

        assert!(!switched.whisper.loaded);
        assert!(switched.whisper.installed);
        service
            .select_provider(VoiceProvider::Whisper)
            .await
            .unwrap();
        service.transcribe(short_recording()).await.unwrap();
        assert_eq!(engine.loads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_load_that_ends_after_switching_providers_is_not_kept() {
        let temp = TempDir::new().unwrap();
        let (engine, load_started, release_load) = FakeEngine::gated();
        let service = installed_service(&temp, engine);
        let transcription = tokio::spawn({
            let service = service.clone();
            async move { service.transcribe(short_recording()).await }
        });
        wait_for_load(load_started).await;

        let switch = tokio::spawn({
            let service = service.clone();
            async move { service.select_provider(VoiceProvider::Openai).await }
        });
        wait_until(|| service.inner.settings.provider() == Ok(VoiceProvider::Openai)).await;
        release_load.send(()).unwrap();

        assert_eq!(
            transcription.await.unwrap().unwrap().provider,
            VoiceProvider::Whisper
        );
        assert!(!switch.await.unwrap().unwrap().whisper.loaded);
        assert!(!service.settings().await.unwrap().whisper.loaded);
    }

    #[tokio::test]
    async fn readiness_follows_the_selected_provider() {
        let temp = TempDir::new().unwrap();
        let service = uninstalled_service(&temp);

        let status = service.status().await.unwrap();
        assert_eq!(
            (status.provider, status.ready),
            (VoiceProvider::Whisper, false)
        );

        service
            .select_provider(VoiceProvider::Gemini)
            .await
            .unwrap();
        assert!(!service.status().await.unwrap().ready);

        service
            .store_key(CloudProvider::Gemini, "gemini-key")
            .await
            .unwrap();
        assert!(service.status().await.unwrap().ready);

        service.remove_key(CloudProvider::Gemini).await.unwrap();
        assert!(!service.status().await.unwrap().ready);

        service
            .select_provider(VoiceProvider::Openai)
            .await
            .unwrap();
        assert!(!service.status().await.unwrap().ready);
        service
            .store_key(CloudProvider::Openai, "sk-test")
            .await
            .unwrap();
        assert!(service.status().await.unwrap().ready);

        service.select_provider(VoiceProvider::Grok).await.unwrap();
        assert!(!service.status().await.unwrap().ready);
        service
            .store_key(CloudProvider::Grok, "xai-test")
            .await
            .unwrap();
        assert!(service.status().await.unwrap().ready);
    }

    #[tokio::test]
    async fn a_missing_key_is_a_readiness_problem() {
        let temp = TempDir::new().unwrap();
        let service = uninstalled_service(&temp);
        service
            .select_provider(VoiceProvider::Openai)
            .await
            .unwrap();

        let error = service.transcribe(short_recording()).await.unwrap_err();

        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "voice_provider_not_ready");
        assert_eq!(
            error.message,
            "Add your OpenAI API key in Settings → Voice Input."
        );
    }

    #[tokio::test]
    async fn a_running_download_is_not_ready_and_survives_other_requests() {
        let temp = TempDir::new().unwrap();
        let url = stalled_model_server(b"partial").await;
        let service = service_with(
            &temp,
            spec_for(url, TEST_MODEL),
            Arc::new(FakeEngine::default()),
            unreachable_endpoints(),
        );
        service.start_model_download().await.unwrap();
        let partial = temp.path().join("models/whisper/model.bin.1.part");
        wait_until(|| std::fs::metadata(&partial).is_ok_and(|metadata| metadata.len() == 7)).await;

        let restarted = service.start_model_download().await.unwrap();
        let error = service.transcribe(short_recording()).await.unwrap_err();
        let switched = service
            .select_provider(VoiceProvider::Openai)
            .await
            .unwrap();

        assert!(restarted.whisper.downloading);
        assert_eq!(error.code, "voice_provider_not_ready");
        assert!(switched.whisper.downloading);
        assert_eq!(model_dir_entries(&temp), ["model.bin.1.part"]);
        service.remove_model().await.unwrap();
    }

    #[tokio::test]
    async fn starting_a_download_does_nothing_once_the_model_is_installed_or_loaded() {
        let temp = TempDir::new().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let spec = spec_for(
            model_server(TEST_MODEL.to_vec(), requests.clone()).await,
            TEST_MODEL,
        );
        let model_dir = temp.path().join("models/whisper");
        std::fs::create_dir_all(&model_dir).unwrap();
        std::fs::write(model_dir.join("model.bin"), TEST_MODEL).unwrap();
        std::fs::write(model_dir.join("model.bin.sha256"), &spec.sha256).unwrap();
        let service = service_with(
            &temp,
            spec,
            Arc::new(FakeEngine::default()),
            unreachable_endpoints(),
        );

        let installed = service.start_model_download().await.unwrap();
        service.transcribe(short_recording()).await.unwrap();
        let loaded = service.start_model_download().await.unwrap();

        assert!(!installed.whisper.downloading);
        assert!(!loaded.whisper.downloading);
        assert!(loaded.whisper.loaded);
        assert_eq!(requests.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn removing_an_installed_model_deletes_its_files() {
        let temp = TempDir::new().unwrap();
        let service = installed_service(&temp, Arc::new(FakeEngine::default()));

        let removed = service.remove_model().await.unwrap();

        assert!(!removed.whisper.installed);
        assert!(model_dir_entries(&temp).is_empty());
        assert!(!service.status().await.unwrap().ready);
    }

    #[cfg(debug_assertions)]
    #[tokio::test]
    #[should_panic(expected = "invalid Whisper model transition")]
    async fn rejects_a_model_transition_outside_the_declared_graph() {
        let temp = TempDir::new().unwrap();
        let service = uninstalled_service(&temp);
        let mut lifecycle = service.inner.lifecycle.lock().await;

        service.transition(&mut lifecycle, ModelNode::Idle);
    }

    async fn cloud_service(
        temp: &TempDir,
        openai_status: StatusCode,
        openai_body: &'static str,
    ) -> VoiceService {
        let openai = serve(Router::new().route(
            "/v1/audio/transcriptions",
            post(move || async move { (openai_status, openai_body) }),
        ))
        .await;
        let service = service_with(
            temp,
            spec_for("http://127.0.0.1:9/unused".to_string(), TEST_MODEL),
            Arc::new(FakeEngine::default()),
            ProviderEndpoints {
                openai,
                gemini: "http://127.0.0.1:9".to_string(),
                grok: "http://127.0.0.1:9".to_string(),
            },
        );
        service
            .select_provider(VoiceProvider::Openai)
            .await
            .unwrap();
        service
            .store_key(CloudProvider::Openai, "sk-rejected-secret")
            .await
            .unwrap();
        service
    }

    #[tokio::test]
    async fn transcribes_with_the_selected_cloud_provider() {
        let temp = TempDir::new().unwrap();
        let service =
            cloud_service(&temp, StatusCode::OK, r#"{"text":"클라우드 transcript"}"#).await;

        let transcript = service.transcribe(short_recording()).await.unwrap();

        assert_eq!(transcript.text, "클라우드 transcript");
        assert_eq!(transcript.provider, VoiceProvider::Openai);
    }

    #[tokio::test]
    async fn a_rejected_cloud_key_leads_back_to_settings_without_the_provider_response() {
        let temp = TempDir::new().unwrap();
        let service = cloud_service(
            &temp,
            StatusCode::UNAUTHORIZED,
            r#"{"error":{"message":"Incorrect API key provided: sk-rejected-secret.","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}"#,
        )
        .await;

        let error = service.transcribe(short_recording()).await.unwrap_err();

        assert_eq!(error.code, "voice_provider_not_ready");
        assert!(!error.message.contains("sk-rejected-secret"));
        assert_eq!(
            error.message,
            "OpenAI rejected the API key. Update it in Settings → Voice Input."
        );
    }

    #[tokio::test]
    async fn reports_each_non_key_cloud_failure_with_its_own_message() {
        for (status, body, message) in [
            (
                StatusCode::TOO_MANY_REQUESTS,
                r#"{"error":{"message":"Quota exceeded for sk-rejected-secret."}}"#,
                "OpenAI rate limit or quota was reached.",
            ),
            (
                StatusCode::BAD_REQUEST,
                "",
                "OpenAI could not transcribe this recording.",
            ),
            (
                StatusCode::SERVICE_UNAVAILABLE,
                "",
                "Caffold could not reach OpenAI.",
            ),
            (
                StatusCode::OK,
                "not json",
                "OpenAI returned a response Caffold could not read.",
            ),
        ] {
            let temp = TempDir::new().unwrap();
            let service = cloud_service(&temp, status, body).await;

            let error = service.transcribe(short_recording()).await.unwrap_err();

            assert_eq!(error.status, StatusCode::BAD_GATEWAY, "{status}");
            assert_eq!(error.code, "voice_transcription_failed");
            assert_eq!(error.message, message);
        }
    }

    #[tokio::test]
    async fn transcribes_with_gemini_when_it_is_selected() {
        let temp = TempDir::new().unwrap();
        let gemini = serve(Router::new().route(
            "/v1beta/interactions",
            post(|| async {
                r#"{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"제미나이 transcript"}]}]}"#
            }),
        ))
        .await;
        let service = service_with(
            &temp,
            spec_for("http://127.0.0.1:9/unused".to_string(), TEST_MODEL),
            Arc::new(FakeEngine::default()),
            ProviderEndpoints {
                openai: "http://127.0.0.1:9".to_string(),
                gemini,
                grok: "http://127.0.0.1:9".to_string(),
            },
        );
        service
            .select_provider(VoiceProvider::Gemini)
            .await
            .unwrap();
        service
            .store_key(CloudProvider::Gemini, "gemini-key")
            .await
            .unwrap();

        let transcript = service.transcribe(short_recording()).await.unwrap();

        assert_eq!(transcript.text, "제미나이 transcript");
        assert_eq!(transcript.provider, VoiceProvider::Gemini);
    }

    async fn grok_service(
        temp: &TempDir,
        grok_status: StatusCode,
        grok_body: &'static str,
    ) -> VoiceService {
        let grok = serve(Router::new().route(
            "/v1/stt",
            post(move || async move { (grok_status, grok_body) }),
        ))
        .await;
        service_with(
            temp,
            spec_for("http://127.0.0.1:9/unused".to_string(), TEST_MODEL),
            Arc::new(FakeEngine::default()),
            ProviderEndpoints {
                grok,
                ..unreachable_endpoints()
            },
        )
    }

    #[tokio::test]
    async fn transcribes_with_grok_once_it_is_chosen_over_http() {
        let temp = TempDir::new().unwrap();
        let app = router_with_service(
            grok_service(&temp, StatusCode::OK, r#"{"text":"그록 transcript"}"#).await,
        );
        for (uri, body) in [
            ("/api/voice/provider", r#"{"provider":"grok"}"#),
            ("/api/voice/keys/grok", r#"{"key":"xai-test"}"#),
        ] {
            let (status, _) = send(&app, settings_change("PUT", uri, body, true)).await;
            assert_eq!(status, StatusCode::OK, "{uri}");
        }

        let (status, transcript) = send(
            &app,
            Request::post("/api/voice/transcribe")
                .header(header::CONTENT_TYPE, "audio/wav")
                .body(Body::from(wav_bytes(&[0; 1_600], 16_000, 1)))
                .unwrap(),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            transcript,
            serde_json::json!({ "text": "그록 transcript", "provider": "grok" })
        );
    }

    #[tokio::test]
    async fn an_incorrect_grok_key_leads_back_to_settings() {
        let temp = TempDir::new().unwrap();
        // xAI's answer to a key that does not exist, observed on 2026-09-19.
        let service = grok_service(
            &temp,
            StatusCode::BAD_REQUEST,
            r#"{"code":"Client specified an invalid argument","error":"Incorrect API key provided. You can obtain an API key from https://console.x.ai."}"#,
        )
        .await;
        service.select_provider(VoiceProvider::Grok).await.unwrap();
        service
            .store_key(CloudProvider::Grok, "xai-incorrect")
            .await
            .unwrap();

        let error = service.transcribe(short_recording()).await.unwrap_err();

        assert_eq!(error.status, StatusCode::CONFLICT);
        assert_eq!(error.code, "voice_provider_not_ready");
        assert_eq!(
            error.message,
            "Grok rejected the API key. Update it in Settings → Voice Input."
        );
    }

    async fn send(app: &Router, request: Request<Body>) -> (StatusCode, serde_json::Value) {
        let response = app.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), MAX_AUDIO_BYTES)
            .await
            .unwrap();
        (
            status,
            serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
        )
    }

    fn settings_change(method: &str, uri: &str, body: &str, same_origin: bool) -> Request<Body> {
        let mut request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, SAME_HOST)
            .header(header::CONTENT_TYPE, "application/json");
        if same_origin {
            request = request.header(header::ORIGIN, SAME_ORIGIN);
        }
        request.body(Body::from(body.to_string())).unwrap()
    }

    #[tokio::test]
    async fn setting_changes_require_a_same_origin_request() {
        let temp = TempDir::new().unwrap();
        let app = router_with_service(uninstalled_service(&temp));
        let changes = [
            ("PUT", "/api/voice/provider", r#"{"provider":"openai"}"#),
            ("PUT", "/api/voice/keys/openai", r#"{"key":"sk-test"}"#),
            ("DELETE", "/api/voice/keys/openai", ""),
            ("POST", "/api/voice/model/install", ""),
            ("DELETE", "/api/voice/model", ""),
        ];

        for (method, uri, body) in changes {
            let (status, rejected) = send(&app, settings_change(method, uri, body, false)).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
            assert_eq!(rejected["error"]["code"], "voice_same_origin_required");
        }
        assert!(!temp.path().join("voice").exists());
        assert!(!temp.path().join("models").exists());

        for (method, uri, body) in changes {
            let (status, _) = send(&app, settings_change(method, uri, body, true)).await;
            assert_eq!(status, StatusCode::OK, "{method} {uri}");
        }
        let (_, settings) = send(
            &app,
            Request::get("/api/voice/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(settings["selected"], "openai");
        assert_eq!(settings["whisper"]["downloading"], false);
    }

    #[test]
    fn origin_validation_matches_host_and_rejects_cross_origin_inputs() {
        assert!(same_origin_host("http://localhost:5178", "localhost:5178"));
        assert!(same_origin_host("https://Example.test", "example.test"));
        assert!(same_origin_host("http://[::1]:5178", "[::1]:5178"));
        assert!(same_origin_host("https://example.test", "example.test:443"));
        assert!(!same_origin_host("https://evil.test", "example.test"));
        assert!(!same_origin_host("null", "example.test"));
        assert!(!same_origin_host(
            "https://example.test:8443",
            "example.test:9443"
        ));
        assert!(!same_origin_host(
            "https://example.test:8443",
            "example.test"
        ));
        assert!(!same_origin_host(
            "https://user@example.test",
            "example.test"
        ));
        assert!(!same_origin_host(
            "https://example.test/app",
            "example.test"
        ));
        assert!(!same_origin_host("file://example.test", "example.test"));
        assert!(!same_origin_host("https://example.test", "example test"));
    }

    #[tokio::test]
    async fn an_unreadable_key_file_is_reported_without_its_contents() {
        let temp = TempDir::new().unwrap();
        let voice_dir = temp.path().join("voice");
        std::fs::create_dir_all(&voice_dir).unwrap();
        std::fs::write(voice_dir.join("keys.json"), r#""sk-unreadable-secret""#).unwrap();
        let app = router_with_service(uninstalled_service(&temp));

        let (status, body) = send(
            &app,
            Request::get("/api/voice/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body["error"]["code"], "voice_settings_unavailable");
        assert!(!body.to_string().contains("sk-unreadable-secret"));
    }

    #[tokio::test]
    async fn a_stored_key_is_reported_as_configured_but_never_returned() {
        let temp = TempDir::new().unwrap();
        let app = router_with_service(uninstalled_service(&temp));
        let secret = "sk-never-returned-0123456789";

        let (status, stored) = send(
            &app,
            settings_change(
                "PUT",
                "/api/voice/keys/openai",
                &format!(r#"{{"key":"{secret}"}}"#),
                true,
            ),
        )
        .await;
        let (_, settings) = send(
            &app,
            Request::get("/api/voice/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(stored["openai"]["keyConfigured"], true);
        assert_eq!(stored["gemini"]["keyConfigured"], false);
        assert_eq!(stored["grok"]["keyConfigured"], false);
        assert_eq!(settings["openai"]["keyConfigured"], true);
        for body in [&stored, &settings] {
            assert!(!body.to_string().contains(secret));
        }

        let (status, rejected) = send(
            &app,
            settings_change("PUT", "/api/voice/keys/gemini", r#"{"key":"  "}"#, true),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(rejected["error"]["code"], "invalid_voice_key");
    }

    #[tokio::test]
    async fn settings_report_the_model_each_provider_uses() {
        let temp = TempDir::new().unwrap();
        let app = router_with_service(uninstalled_service(&temp));

        let (status, settings) = send(
            &app,
            Request::get("/api/voice/settings")
                .body(Body::empty())
                .unwrap(),
        )
        .await;

        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings["whisper"]["model"], "test-small");
        assert_eq!(settings["whisper"]["revision"], "test-revision");
        assert_eq!(settings["openai"]["model"], "gpt-transcribe");
        assert_eq!(settings["gemini"]["model"], "gemini-3.5-transcribe");
        assert_eq!(settings["grok"]["model"], "grok-voice-transcribe-2.0");
    }

    #[tokio::test]
    async fn voice_routes_enforce_content_type_and_body_limit() {
        let temp = TempDir::new().unwrap();
        let app = router_with_service(installed_service(&temp, Arc::new(FakeEngine::default())));

        let (status, voice) = send(
            &app,
            Request::get("/api/voice/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            voice,
            serde_json::json!({
                "provider": "whisper",
                "ready": true,
                "maxRecordingSeconds": MAX_AUDIO_SECONDS,
            })
        );

        let (status, transcript) = send(
            &app,
            Request::post("/api/voice/transcribe")
                .header(header::CONTENT_TYPE, "audio/wav")
                .body(Body::from(wav_bytes(&[0; 1_600], 16_000, 1)))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(transcript["text"], "테스트 transcript");
        assert_eq!(transcript["provider"], "whisper");

        let (status, _) = send(
            &app,
            Request::post("/api/voice/transcribe")
                .body(Body::from("not audio"))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);

        let (status, _) = send(
            &app,
            Request::post("/api/voice/transcribe")
                .header(header::CONTENT_TYPE, "audio/wav")
                .body(Body::from(vec![0; MAX_AUDIO_BYTES + 1]))
                .unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
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
        let model = WhisperVoiceEngine.load(Path::new(&model_path)).unwrap();
        let transcript = model
            .transcribe(&audio, Arc::new(AtomicBool::new(false)))
            .unwrap();
        assert!(!transcript.trim().is_empty());
        println!("{transcript}");
    }
}
