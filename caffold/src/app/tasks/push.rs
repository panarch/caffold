use std::{
    collections::{HashSet, VecDeque},
    future::Future,
    pin::Pin,
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode, header::HOST, uri::Authority},
    response::IntoResponse,
    routing::{get, put},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use reqwest::{Client, Url, redirect::Policy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{sync::mpsc, task::JoinHandle};
use uuid::Uuid;
use web_push_native::{
    Auth, WebPushBuilder,
    jwt_simple::algorithms::ES256KeyPair,
    p256::{PublicKey, elliptic_curve::sec1::ToEncodedPoint as _},
};

use super::{TaskState, now_ms};
use crate::{
    app::error::ApiError,
    task_store::{PushInstallation, PushInstallationSummary, PushSubscriptionInput, TaskStore},
};

const MAX_PUSH_REQUEST_BYTES: usize = 16 * 1024;
const MAX_CLIENT_ID_BYTES: usize = 64;
const MAX_INSTALLATION_LABEL_CHARS: usize = 120;
const MAX_ENDPOINT_BYTES: usize = 4 * 1024;
const MAX_TASK_ID_CHARS: usize = 256;
const MAX_TASK_NAME_CHARS: usize = 120;
const PUSH_QUEUE_CAPACITY: usize = 256;
const PUSH_DELIVERY_CONCURRENCY: usize = 4;
const RECENT_DELIVERY_CAPACITY: usize = 2_048;
const PUSH_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const PUSH_DRAIN_TIMEOUT: Duration = Duration::from_secs(3);
const VAPID_CONTACT: &str = "https://github.com/panarch/caffold";

/// What tells a waiting Task's notice apart from a finished turn's.
///
/// A finished turn's notice carries a terminal status and no kind, which is
/// the only shape a browser running an older service worker knows how to
/// read. That browser drops what it cannot read rather than showing it, so
/// the older notice needs no version of its own.
const ACTION_REQUIRED_KIND: &str = "actionRequired";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum TerminalPushStatus {
    Completed,
    Failed,
    Interrupted,
}

impl TerminalPushStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
        }
    }
}

/// What a finished turn tells a browser.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalPayload {
    thread_id: String,
    turn_id: String,
    status: TerminalPushStatus,
    task_name: Option<String>,
    tag: String,
}

/// What a Task waiting on a person tells a browser.
///
/// It names the Task and says nothing of the question. Which question is
/// waiting lives only inside the hash the tag is made of, because routing
/// needs the Task and the browser needs one notification per question, and
/// neither needs the agent's name for what it asked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionRequiredPayload {
    kind: &'static str,
    thread_id: String,
    task_name: Option<String>,
    tag: String,
}

#[derive(Debug, Clone)]
pub(super) struct PushDeliveryJob {
    pub(super) client_id: String,
    pub(super) endpoint: String,
    pub(super) p256dh: String,
    pub(super) auth: String,
    pub(super) topic: String,
    pub(super) payload: Vec<u8>,
}

impl PushDeliveryJob {
    fn delivery_key(&self) -> String {
        format!("{}:{}", self.client_id, self.topic)
    }
}

#[derive(Clone)]
pub(super) struct PushService {
    inner: Arc<PushServiceInner>,
}

struct PushServiceInner {
    task_store: TaskStore,
    public_key: String,
    sender: Mutex<Option<mpsc::Sender<PushDeliveryJob>>>,
}

impl PushService {
    fn new(
        task_store: TaskStore,
        public_key: String,
        sender: mpsc::Sender<PushDeliveryJob>,
    ) -> Self {
        Self {
            inner: Arc::new(PushServiceInner {
                task_store,
                public_key,
                sender: Mutex::new(Some(sender)),
            }),
        }
    }

    fn public_key(&self) -> &str {
        &self.inner.public_key
    }

    /// Tell every subscribed browser that a turn ended.
    pub(super) fn notify_terminal(
        &self,
        thread_id: &str,
        turn_id: &str,
        status: TerminalPushStatus,
        task_name: &str,
    ) -> usize {
        if !safe_push_id(thread_id) || !safe_push_id(turn_id) {
            eprintln!("Web Push route identifiers were invalid; terminal delivery skipped");
            return 0;
        }
        let topic = delivery_topic(&[thread_id, turn_id, status.as_str()]);
        self.enqueue(
            topic.clone(),
            &TerminalPayload {
                thread_id: thread_id.to_owned(),
                turn_id: turn_id.to_owned(),
                status,
                task_name: truncated_task_name(task_name),
                tag: topic,
            },
        )
    }

    /// Tell every subscribed browser that a Task is waiting on a person.
    ///
    /// The approval identity decides the tag and nothing else. A second
    /// question therefore raises a second notification, and the same question
    /// asked again replaces the one already on screen instead of stacking
    /// beside it — which is what a connection replaced mid-question produces,
    /// because the agent asks again with the identity it asked under.
    pub(super) fn notify_action_required(
        &self,
        thread_id: &str,
        approval_id: &str,
        task_name: &str,
    ) -> usize {
        if !safe_push_id(thread_id) {
            eprintln!("Web Push route identifier was invalid; waiting delivery skipped");
            return 0;
        }
        let topic = delivery_topic(&[thread_id, approval_id, ACTION_REQUIRED_KIND]);
        self.enqueue(
            topic.clone(),
            &ActionRequiredPayload {
                kind: ACTION_REQUIRED_KIND,
                thread_id: thread_id.to_owned(),
                task_name: truncated_task_name(task_name),
                tag: topic,
            },
        )
    }

    /// One independent job per subscribed browser, dropped rather than waited
    /// on.
    ///
    /// Nothing that calls this waits for queue capacity or for a provider. A
    /// browser that cannot be reached loses its notification, and the Task it
    /// was about carries on either way.
    fn enqueue(&self, topic: String, payload: &impl Serialize) -> usize {
        let installations = match self.inner.task_store.active_push_installations() {
            Ok(installations) => installations,
            Err(_) => {
                eprintln!("Web Push recipients could not be loaded; delivery skipped");
                return 0;
            }
        };
        let payload = match serde_json::to_vec(payload) {
            Ok(payload) => payload,
            Err(_) => {
                eprintln!("Web Push payload encoding failed; delivery skipped");
                return 0;
            }
        };
        let sender = self
            .inner
            .sender
            .lock()
            .ok()
            .and_then(|sender| sender.clone());
        let Some(sender) = sender else {
            return 0;
        };
        let mut queued = 0;
        for installation in installations {
            let (Some(endpoint), Some(p256dh), Some(auth)) = (
                installation.endpoint,
                installation.p256dh,
                installation.auth,
            ) else {
                continue;
            };
            let client_hint = short_client_id(&installation.client_id).to_owned();
            let job = PushDeliveryJob {
                client_id: installation.client_id,
                endpoint,
                p256dh,
                auth,
                topic: topic.clone(),
                payload: payload.clone(),
            };
            match sender.try_send(job) {
                Ok(()) => queued += 1,
                Err(_) => {
                    eprintln!(
                        "Web Push queue unavailable for installation {client_hint}; delivery dropped"
                    );
                }
            }
        }
        queued
    }

    fn close(&self) {
        if let Ok(mut sender) = self.inner.sender.lock() {
            sender.take();
        }
    }

    #[cfg(test)]
    pub(super) fn test_channel(task_store: TaskStore) -> (Self, mpsc::Receiver<PushDeliveryJob>) {
        let (sender, receiver) = mpsc::channel(32);
        (
            Self::new(task_store, "test-public-key".to_owned(), sender),
            receiver,
        )
    }
}

pub(super) struct PushRuntime {
    service: PushService,
    worker: Option<JoinHandle<()>>,
}

impl PushRuntime {
    pub(super) fn new(task_store: TaskStore) -> anyhow::Result<Self> {
        let generated = ES256KeyPair::generate();
        let generated_private = URL_SAFE_NO_PAD.encode(generated.to_bytes());
        let persisted_private = task_store
            .load_or_create_vapid_private_key(&generated_private, now_ms())
            .map_err(|error| anyhow::anyhow!("failed to load Caffold Web Push key: {error}"))?;
        let private_bytes = URL_SAFE_NO_PAD
            .decode(persisted_private)
            .map_err(|_| anyhow::anyhow!("persisted Caffold Web Push key is invalid"))?;
        let key_pair = Arc::new(
            ES256KeyPair::from_bytes(&private_bytes)
                .map_err(|_| anyhow::anyhow!("persisted Caffold Web Push key is invalid"))?,
        );
        let secret = web_push_native::p256::SecretKey::from_slice(&private_bytes)
            .map_err(|_| anyhow::anyhow!("persisted Caffold Web Push key is invalid"))?;
        let public_key =
            URL_SAFE_NO_PAD.encode(secret.public_key().to_encoded_point(false).as_bytes());
        let (sender, receiver) = mpsc::channel(PUSH_QUEUE_CAPACITY);
        let service = PushService::new(task_store.clone(), public_key, sender);
        let worker = match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                let transport = ReqwestPushTransport::new()?;
                Some(handle.spawn(run_dispatcher(receiver, task_store, key_pair, transport)))
            }
            Err(_) => {
                drop(receiver);
                None
            }
        };
        Ok(Self { service, worker })
    }

    pub(super) fn service(&self) -> PushService {
        self.service.clone()
    }

    pub(super) async fn shutdown(self) {
        self.service.close();
        let Some(mut worker) = self.worker else {
            return;
        };
        if tokio::time::timeout(PUSH_DRAIN_TIMEOUT, &mut worker)
            .await
            .is_err()
        {
            worker.abort();
            let _ = worker.await;
            eprintln!(
                "Web Push shutdown drain timed out; remaining best-effort deliveries dropped"
            );
        }
    }
}

#[derive(Clone)]
struct ReqwestPushTransport {
    client: Client,
}

impl ReqwestPushTransport {
    fn new() -> anyhow::Result<Self> {
        Ok(Self {
            client: Client::builder()
                .redirect(Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(15))
                .build()?,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeliveryOutcome {
    Delivered,
    InvalidSubscription,
    Failed,
}

trait PushTransport: Clone + Send + Sync + 'static {
    fn send(
        &self,
        job: PushDeliveryJob,
        vapid_key: Arc<ES256KeyPair>,
    ) -> Pin<Box<dyn Future<Output = DeliveryOutcome> + Send>>;
}

impl PushTransport for ReqwestPushTransport {
    fn send(
        &self,
        job: PushDeliveryJob,
        vapid_key: Arc<ES256KeyPair>,
    ) -> Pin<Box<dyn Future<Output = DeliveryOutcome> + Send>> {
        let client = self.client.clone();
        Box::pin(async move {
            let client_hint = short_client_id(&job.client_id).to_owned();
            let request = match build_push_request(&job, &vapid_key) {
                Ok(request) => request,
                Err(()) => {
                    eprintln!(
                        "Web Push request could not be constructed for installation {client_hint}"
                    );
                    return DeliveryOutcome::Failed;
                }
            };
            let request = match reqwest::Request::try_from(request) {
                Ok(request) => request,
                Err(_) => {
                    eprintln!(
                        "Web Push request could not be converted for installation {client_hint}"
                    );
                    return DeliveryOutcome::Failed;
                }
            };
            match client.execute(request).await {
                Ok(response) => {
                    let status = response.status();
                    eprintln!(
                        "Web Push provider responded with HTTP {} for installation {client_hint}",
                        status.as_u16()
                    );
                    delivery_outcome(status)
                }
                Err(_) => {
                    eprintln!(
                        "Web Push provider request failed before a response for installation {client_hint}"
                    );
                    DeliveryOutcome::Failed
                }
            }
        })
    }
}

fn delivery_outcome(status: StatusCode) -> DeliveryOutcome {
    if status.is_success() {
        DeliveryOutcome::Delivered
    } else if matches!(status, StatusCode::NOT_FOUND | StatusCode::GONE) {
        DeliveryOutcome::InvalidSubscription
    } else {
        DeliveryOutcome::Failed
    }
}

fn build_push_request(
    job: &PushDeliveryJob,
    vapid_key: &ES256KeyPair,
) -> Result<axum::http::Request<Vec<u8>>, ()> {
    let endpoint = job.endpoint.parse().map_err(|_| ())?;
    let public_key = URL_SAFE_NO_PAD.decode(&job.p256dh).map_err(|_| ())?;
    let public_key = PublicKey::from_sec1_bytes(&public_key).map_err(|_| ())?;
    let auth = URL_SAFE_NO_PAD.decode(&job.auth).map_err(|_| ())?;
    let auth: [u8; 16] = auth.try_into().map_err(|_| ())?;
    let mut request = WebPushBuilder::new(endpoint, public_key, Auth::clone_from_slice(&auth))
        .with_valid_duration(PUSH_TTL)
        .with_vapid(vapid_key, VAPID_CONTACT)
        .build(job.payload.clone())
        .map_err(|_| ())?;
    request
        .headers_mut()
        .insert("Topic", job.topic.parse().map_err(|_| ())?);
    request
        .headers_mut()
        .insert("Urgency", axum::http::HeaderValue::from_static("normal"));
    Ok(request)
}

async fn run_dispatcher<T: PushTransport>(
    mut receiver: mpsc::Receiver<PushDeliveryJob>,
    task_store: TaskStore,
    vapid_key: Arc<ES256KeyPair>,
    transport: T,
) {
    let mut tasks = tokio::task::JoinSet::new();
    let mut recent = RecentDeliveries::new(RECENT_DELIVERY_CAPACITY);
    while let Some(job) = receiver.recv().await {
        if !recent.insert(job.delivery_key()) {
            continue;
        }
        if tasks.len() >= PUSH_DELIVERY_CONCURRENCY {
            let _ = tasks.join_next().await;
        }
        let transport = transport.clone();
        let vapid_key = vapid_key.clone();
        let task_store = task_store.clone();
        tasks.spawn(async move {
            let client_id = job.client_id.clone();
            let endpoint = job.endpoint.clone();
            let outcome = transport.send(job, vapid_key).await;
            match outcome {
                DeliveryOutcome::Delivered => {}
                DeliveryOutcome::InvalidSubscription => {
                    if task_store
                        .delete_invalid_push_installation(&client_id, &endpoint)
                        .is_err()
                    {
                        eprintln!(
                            "invalid Web Push installation {} could not be removed",
                            short_client_id(&client_id)
                        );
                    }
                }
                DeliveryOutcome::Failed => eprintln!(
                    "best-effort Web Push delivery failed for installation {}",
                    short_client_id(&client_id)
                ),
            }
        });
    }
    while tasks.join_next().await.is_some() {}
}

struct RecentDeliveries {
    capacity: usize,
    order: VecDeque<String>,
    keys: HashSet<String>,
}

impl RecentDeliveries {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            order: VecDeque::with_capacity(capacity),
            keys: HashSet::with_capacity(capacity),
        }
    }

    fn insert(&mut self, key: String) -> bool {
        if self.capacity == 0 || self.keys.contains(&key) {
            return false;
        }
        if self.order.len() == self.capacity
            && let Some(expired) = self.order.pop_front()
        {
            self.keys.remove(&expired);
        }
        self.keys.insert(key.clone());
        self.order.push_back(key);
        true
    }
}

/// One deterministic name for one notice, for the provider and the browser.
///
/// What the notice is about is hashed rather than written out, so an
/// identifier Caffold does not send a browser can still tell two notices
/// apart.
fn delivery_topic(parts: &[&str]) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    URL_SAFE_NO_PAD.encode(&hash.finalize()[..24])
}

fn truncated_task_name(task_name: &str) -> Option<String> {
    let name = task_name.trim();
    if name.is_empty() || name.chars().any(char::is_control) {
        return None;
    }
    let mut chars = name.chars();
    let mut truncated = chars.by_ref().take(MAX_TASK_NAME_CHARS).collect::<String>();
    if chars.next().is_some() {
        truncated.pop();
        truncated.push('…');
    }
    Some(truncated)
}

fn safe_push_id(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_TASK_ID_CHARS
        && !matches!(value, "." | "..")
        && !value
            .chars()
            .any(|character| matches!(character, '/' | '\\') || character.is_control())
}

fn short_client_id(client_id: &str) -> &str {
    client_id.get(..8).unwrap_or(client_id)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PushConfigResponse {
    public_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallationsQuery {
    client_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallationsResponse {
    current_state: ClientInstallationState,
    installations: Vec<InstallationResponse>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum ClientInstallationState {
    Unknown,
    Subscribed,
    Revoked,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallationResponse {
    client_id: String,
    installation_label: String,
    created_at_ms: u64,
    updated_at_ms: u64,
}

impl From<PushInstallationSummary> for InstallationResponse {
    fn from(summary: PushInstallationSummary) -> Self {
        Self {
            client_id: summary.client_id,
            installation_label: summary.installation_label,
            created_at_ms: summary.created_at_ms,
            updated_at_ms: summary.updated_at_ms,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertSubscriptionRequest {
    installation_label: String,
    endpoint: String,
    expiration_time: Option<u64>,
    keys: SubscriptionKeys,
}

#[derive(Debug, Deserialize)]
struct SubscriptionKeys {
    p256dh: String,
    auth: String,
}

pub(super) fn router() -> Router<TaskState> {
    Router::new()
        .route("/api/push/config", get(push_config))
        .route("/api/push/installations", get(list_installations))
        .route(
            "/api/push/installations/{client_id}",
            put(upsert_installation)
                .delete(delete_installation)
                .layer(DefaultBodyLimit::max(MAX_PUSH_REQUEST_BYTES)),
        )
}

async fn push_config(State(state): State<TaskState>) -> impl IntoResponse {
    Json(PushConfigResponse {
        public_key: state.push.public_key().to_owned(),
    })
}

async fn list_installations(
    State(state): State<TaskState>,
    Query(query): Query<InstallationsQuery>,
) -> Result<Json<InstallationsResponse>, ApiError> {
    validate_client_id(&query.client_id)?;
    let current_state = match state
        .task_store
        .push_installation(&query.client_id)
        .map_err(push_store_error)?
    {
        Some(installation) if installation.is_active() => ClientInstallationState::Subscribed,
        Some(_) => ClientInstallationState::Revoked,
        None => ClientInstallationState::Unknown,
    };
    let installations = state
        .task_store
        .push_installation_summaries()
        .map_err(push_store_error)?
        .into_iter()
        .map(Into::into)
        .collect();
    Ok(Json(InstallationsResponse {
        current_state,
        installations,
    }))
}

async fn upsert_installation(
    State(state): State<TaskState>,
    Path(client_id): Path<String>,
    headers: HeaderMap,
    Json(request): Json<UpsertSubscriptionRequest>,
) -> Result<Json<InstallationResponse>, ApiError> {
    require_same_origin(&headers)?;
    let input = validate_subscription(client_id, request)?;
    let installation = state
        .task_store
        .upsert_push_installation(input, now_ms())
        .map_err(push_store_error)?;
    Ok(Json(summary_from_active(installation)?.into()))
}

async fn delete_installation(
    State(state): State<TaskState>,
    Path(client_id): Path<String>,
    headers: HeaderMap,
) -> Result<StatusCode, ApiError> {
    require_same_origin(&headers)?;
    validate_client_id(&client_id)?;
    state
        .task_store
        .revoke_push_installation(&client_id, now_ms())
        .map_err(push_store_error)?;
    Ok(StatusCode::NO_CONTENT)
}

fn validate_subscription(
    client_id: String,
    request: UpsertSubscriptionRequest,
) -> Result<PushSubscriptionInput, ApiError> {
    validate_client_id(&client_id)?;
    let label = request.installation_label.trim();
    if label.is_empty()
        || label.chars().count() > MAX_INSTALLATION_LABEL_CHARS
        || label.chars().any(char::is_control)
    {
        return Err(bad_push_request("invalid installation label"));
    }
    if request.endpoint.len() > MAX_ENDPOINT_BYTES {
        return Err(bad_push_request("invalid Push endpoint"));
    }
    let endpoint =
        Url::parse(&request.endpoint).map_err(|_| bad_push_request("invalid Push endpoint"))?;
    if endpoint.scheme() != "https"
        || endpoint.host().is_none()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.fragment().is_some()
    {
        return Err(bad_push_request("invalid Push endpoint"));
    }
    let p256dh = URL_SAFE_NO_PAD
        .decode(&request.keys.p256dh)
        .map_err(|_| bad_push_request("invalid p256dh key"))?;
    if p256dh.len() != 65 || PublicKey::from_sec1_bytes(&p256dh).is_err() {
        return Err(bad_push_request("invalid p256dh key"));
    }
    let auth = URL_SAFE_NO_PAD
        .decode(&request.keys.auth)
        .map_err(|_| bad_push_request("invalid auth key"))?;
    if auth.len() != 16 {
        return Err(bad_push_request("invalid auth key"));
    }
    if let Some(expiration_time) = request.expiration_time {
        let expiration_time = i64::try_from(expiration_time)
            .map_err(|_| bad_push_request("invalid subscription expiration"))?;
        if DateTime::<Utc>::from_timestamp_millis(expiration_time).is_none() {
            return Err(bad_push_request("invalid subscription expiration"));
        }
    }
    Ok(PushSubscriptionInput {
        client_id,
        installation_label: label.to_owned(),
        endpoint: endpoint.into(),
        p256dh: URL_SAFE_NO_PAD.encode(p256dh),
        auth: URL_SAFE_NO_PAD.encode(auth),
        expiration_time_ms: request.expiration_time,
    })
}

fn validate_client_id(client_id: &str) -> Result<(), ApiError> {
    let parsed = Uuid::parse_str(client_id);
    if client_id.len() > MAX_CLIENT_ID_BYTES
        || parsed
            .map(|parsed| parsed.hyphenated().to_string() != client_id)
            .unwrap_or(true)
    {
        return Err(bad_push_request("invalid client ID"));
    }
    Ok(())
}

fn require_same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| bad_push_request("same-origin request required"))?;
    let host = headers
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| bad_push_request("same-origin request required"))?;
    if !same_origin_host(origin, host) {
        return Err(bad_push_request("same-origin request required"));
    }
    Ok(())
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

fn summary_from_active(
    installation: PushInstallation,
) -> Result<PushInstallationSummary, ApiError> {
    Ok(PushInstallationSummary {
        client_id: installation.client_id,
        installation_label: installation
            .installation_label
            .ok_or_else(|| push_store_error(()))?,
        created_at_ms: installation.created_at_ms,
        updated_at_ms: installation.updated_at_ms,
    })
}

fn push_store_error<T>(_: T) -> ApiError {
    ApiError::Internal("Web Push subscription state is unavailable".to_owned())
}

fn bad_push_request(message: &'static str) -> ApiError {
    ApiError::BadRequest {
        code: "invalid_push_subscription",
        message: message.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use crate::agent;
    use std::collections::HashMap;

    use axum::{body::Body, http::Request};
    use serde_json::{Value as JsonValue, json};
    use tokio::sync::broadcast;
    use tower::ServiceExt as _;
    use web_push_native::p256::SecretKey;

    use super::*;
    use crate::fs::RootedFs;

    fn subscription(client_id: &str, endpoint: &str) -> PushSubscriptionInput {
        let secret =
            SecretKey::random(&mut web_push_native::p256::elliptic_curve::rand_core::OsRng);
        let public = secret.public_key().to_encoded_point(false);
        PushSubscriptionInput {
            client_id: client_id.to_owned(),
            installation_label: format!("Chrome on macOS · {}", short_client_id(client_id)),
            endpoint: endpoint.to_owned(),
            p256dh: URL_SAFE_NO_PAD.encode(public.as_bytes()),
            auth: URL_SAFE_NO_PAD.encode([7; 16]),
            expiration_time_ms: None,
        }
    }

    fn job(client_id: &str, endpoint: &str, topic: &str) -> PushDeliveryJob {
        let subscription = subscription(client_id, endpoint);
        PushDeliveryJob {
            client_id: subscription.client_id,
            endpoint: subscription.endpoint,
            p256dh: subscription.p256dh,
            auth: subscription.auth,
            topic: topic.to_owned(),
            payload: br#"{"status":"completed"}"#.to_vec(),
        }
    }

    #[derive(Clone)]
    struct MockTransport {
        outcomes: Arc<HashMap<String, DeliveryOutcome>>,
        sent: Arc<Mutex<Vec<String>>>,
    }

    impl PushTransport for MockTransport {
        fn send(
            &self,
            job: PushDeliveryJob,
            _vapid_key: Arc<ES256KeyPair>,
        ) -> Pin<Box<dyn Future<Output = DeliveryOutcome> + Send>> {
            let outcome = self
                .outcomes
                .get(&job.client_id)
                .copied()
                .unwrap_or(DeliveryOutcome::Delivered);
            self.sent.lock().unwrap().push(job.client_id);
            Box::pin(async move { outcome })
        }
    }

    #[test]
    fn origin_validation_matches_host_and_rejects_cross_origin_inputs() {
        assert!(same_origin_host("http://localhost:5178", "localhost:5178"));
        assert!(same_origin_host("https://Example.test", "example.test"));
        assert!(same_origin_host("http://[::1]:5178", "[::1]:5178"));
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
    }

    #[test]
    fn subscription_validation_bounds_and_normalizes_untrusted_fields() {
        let client_id = "00000000-0000-4000-8000-000000000001".to_owned();
        let source = subscription(&client_id, "https://push.example.test/subscription");
        let valid = validate_subscription(
            client_id.clone(),
            UpsertSubscriptionRequest {
                installation_label: "  Chrome on macOS · 00000000  ".to_owned(),
                endpoint: source.endpoint.clone(),
                expiration_time: Some(1234),
                keys: SubscriptionKeys {
                    p256dh: source.p256dh,
                    auth: source.auth,
                },
            },
        )
        .unwrap();
        assert_eq!(valid.installation_label, "Chrome on macOS · 00000000");
        assert_eq!(valid.expiration_time_ms, Some(1234));

        assert!(validate_client_id("00000000000040008000000000000001").is_err());
        assert!(validate_client_id("00000000-0000-4000-8000-00000000000A").is_err());

        let invalid_endpoint = UpsertSubscriptionRequest {
            installation_label: "Chrome".to_owned(),
            endpoint: "http://push.example.test/not-secure".to_owned(),
            expiration_time: None,
            keys: SubscriptionKeys {
                p256dh: valid.p256dh.clone(),
                auth: valid.auth.clone(),
            },
        };
        assert!(validate_subscription(client_id.clone(), invalid_endpoint).is_err());

        let invalid_expiration = UpsertSubscriptionRequest {
            installation_label: "Chrome".to_owned(),
            endpoint: source.endpoint,
            expiration_time: Some(u64::MAX),
            keys: SubscriptionKeys {
                p256dh: valid.p256dh,
                auth: valid.auth,
            },
        };
        assert!(validate_subscription(client_id, invalid_expiration).is_err());
    }

    #[test]
    fn topic_and_payload_name_are_deterministic_bounded_and_unicode_safe() {
        let ended = delivery_topic(&["thread", "turn", TerminalPushStatus::Completed.as_str()]);
        assert_eq!(ended.len(), 32);
        assert_eq!(
            ended,
            delivery_topic(&["thread", "turn", TerminalPushStatus::Completed.as_str()])
        );
        assert_ne!(
            ended,
            delivery_topic(&["thread", "turn", TerminalPushStatus::Failed.as_str()])
        );
        let waiting = delivery_topic(&["thread", "approval-1", ACTION_REQUIRED_KIND]);
        assert_eq!(
            waiting,
            delivery_topic(&["thread", "approval-1", ACTION_REQUIRED_KIND])
        );
        assert_ne!(
            waiting,
            delivery_topic(&["thread", "approval-2", ACTION_REQUIRED_KIND]),
            "two questions on one Task are two notifications"
        );
        assert_ne!(waiting, ended);
        let long = "작".repeat(MAX_TASK_NAME_CHARS + 20);
        let truncated = truncated_task_name(&long).unwrap();
        assert_eq!(truncated.chars().count(), MAX_TASK_NAME_CHARS);
        assert!(truncated.ends_with('…'));
        assert_eq!(truncated_task_name("unsafe\nname"), None);
        assert!(safe_push_id("thread-id"));
        assert!(!safe_push_id("../thread"));
        assert!(!safe_push_id("thread\nsecret"));
    }

    #[test]
    fn push_request_uses_one_day_ttl_normal_urgency_and_deterministic_topic() {
        let vapid = ES256KeyPair::generate();
        let request = build_push_request(
            &job(
                "00000000-0000-4000-8000-000000000001",
                "https://push.example.test/subscription",
                "topic-value",
            ),
            &vapid,
        )
        .unwrap();
        assert_eq!(request.headers()["TTL"], "86400");
        assert_eq!(request.headers()["Urgency"], "normal");
        assert_eq!(request.headers()["Topic"], "topic-value");
        assert_eq!(request.headers()["Content-Encoding"], "aes128gcm");
        assert!(request.headers().contains_key("Authorization"));
    }

    #[test]
    fn provider_statuses_expire_only_not_found_and_gone_subscriptions() {
        assert_eq!(
            delivery_outcome(StatusCode::CREATED),
            DeliveryOutcome::Delivered
        );
        assert_eq!(
            delivery_outcome(StatusCode::NOT_FOUND),
            DeliveryOutcome::InvalidSubscription
        );
        assert_eq!(
            delivery_outcome(StatusCode::GONE),
            DeliveryOutcome::InvalidSubscription
        );
        assert_eq!(
            delivery_outcome(StatusCode::TOO_MANY_REQUESTS),
            DeliveryOutcome::Failed
        );
        assert_eq!(
            delivery_outcome(StatusCode::INTERNAL_SERVER_ERROR),
            DeliveryOutcome::Failed
        );
        assert_eq!(
            delivery_outcome(StatusCode::TEMPORARY_REDIRECT),
            DeliveryOutcome::Failed
        );
    }

    #[test]
    fn recent_delivery_set_is_bounded_and_suppresses_only_recent_keys() {
        let mut recent = RecentDeliveries::new(2);
        assert!(recent.insert("a".to_owned()));
        assert!(!recent.insert("a".to_owned()));
        assert!(recent.insert("b".to_owned()));
        assert!(recent.insert("c".to_owned()));
        assert!(recent.insert("a".to_owned()));
        assert_eq!(recent.keys.len(), 2);
    }

    #[tokio::test]
    async fn dispatcher_drains_independent_jobs_suppresses_duplicates_and_cleans_only_invalid() {
        let store = TaskStore::memory().unwrap();
        let invalid_id = "00000000-0000-4000-8000-000000000001";
        let failed_id = "00000000-0000-4000-8000-000000000002";
        let delivered_id = "00000000-0000-4000-8000-000000000003";
        for (client_id, endpoint) in [
            (invalid_id, "https://push.example.test/invalid"),
            (failed_id, "https://push.example.test/failed"),
            (delivered_id, "https://push.example.test/delivered"),
        ] {
            store
                .upsert_push_installation(subscription(client_id, endpoint), 1_000)
                .unwrap();
        }
        let transport = MockTransport {
            outcomes: Arc::new(HashMap::from([
                (invalid_id.to_owned(), DeliveryOutcome::InvalidSubscription),
                (failed_id.to_owned(), DeliveryOutcome::Failed),
                (delivered_id.to_owned(), DeliveryOutcome::Delivered),
            ])),
            sent: Arc::new(Mutex::new(Vec::new())),
        };
        let sent = transport.sent.clone();
        let (sender, receiver) = mpsc::channel(8);
        let worker = tokio::spawn(run_dispatcher(
            receiver,
            store.clone(),
            Arc::new(ES256KeyPair::generate()),
            transport,
        ));
        for delivery in [
            job(
                invalid_id,
                "https://push.example.test/invalid",
                "same-topic",
            ),
            job(
                invalid_id,
                "https://push.example.test/invalid",
                "same-topic",
            ),
            job(
                failed_id,
                "https://push.example.test/failed",
                "failed-topic",
            ),
            job(
                delivered_id,
                "https://push.example.test/delivered",
                "delivered-topic",
            ),
        ] {
            sender.send(delivery).await.unwrap();
        }
        drop(sender);
        worker.await.unwrap();

        assert!(store.push_installation(invalid_id).unwrap().is_none());
        assert!(store.push_installation(failed_id).unwrap().is_some());
        assert!(store.push_installation(delivered_id).unwrap().is_some());
        let sent = sent.lock().unwrap();
        assert_eq!(
            sent.iter().filter(|id| id.as_str() == invalid_id).count(),
            1
        );
        assert_eq!(sent.len(), 3);
    }

    /// What a waiting Task sends is the Task, and not the question.
    #[test]
    fn a_waiting_task_notifies_every_installation_without_naming_the_question() {
        let store = TaskStore::memory().unwrap();
        let first_id = "00000000-0000-4000-8000-000000000001";
        let second_id = "00000000-0000-4000-8000-000000000002";
        for (client_id, endpoint) in [
            (first_id, "https://push.example.test/first"),
            (second_id, "https://push.example.test/second"),
        ] {
            store
                .upsert_push_installation(subscription(client_id, endpoint), 1_000)
                .unwrap();
        }
        let (sender, mut receiver) = mpsc::channel(8);
        let service = PushService::new(store, "public-key".to_owned(), sender);

        assert_eq!(
            service.notify_action_required("thread", "approval-1", "Review Web Push"),
            2
        );

        let first = receiver.try_recv().unwrap();
        let payload: JsonValue = serde_json::from_slice(&first.payload).unwrap();
        assert_eq!(
            payload,
            json!({
                "kind": "actionRequired",
                "threadId": "thread",
                "taskName": "Review Web Push",
                "tag": first.topic,
            }),
            "the payload carries the Task and the tag, and nothing of the question"
        );
        let second = receiver.try_recv().unwrap();
        assert_eq!(second.client_id, second_id);
        assert_eq!(first.client_id, first_id);
        assert_eq!(second.topic, first.topic);
        assert!(receiver.try_recv().is_err());

        assert_eq!(
            service.notify_action_required("../thread", "approval-1", "Review Web Push"),
            0,
            "a thread id that cannot be routed to is not sent anywhere"
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn queue_saturation_drops_only_jobs_that_do_not_fit() {
        let store = TaskStore::memory().unwrap();
        for (client_id, endpoint) in [
            (
                "00000000-0000-4000-8000-000000000001",
                "https://push.example.test/first",
            ),
            (
                "00000000-0000-4000-8000-000000000002",
                "https://push.example.test/second",
            ),
        ] {
            store
                .upsert_push_installation(subscription(client_id, endpoint), 1_000)
                .unwrap();
        }
        let (sender, mut receiver) = mpsc::channel(1);
        let service = PushService::new(store, "public-key".to_owned(), sender);

        service.notify_terminal("thread", "turn", TerminalPushStatus::Completed, "Task");

        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err());
    }

    #[tokio::test]
    async fn runtime_shutdown_closes_the_queue_and_drains_pending_delivery() {
        let store = TaskStore::memory().unwrap();
        let client_id = "00000000-0000-4000-8000-000000000001";
        store
            .upsert_push_installation(
                subscription(client_id, "https://push.example.test/pending"),
                1_000,
            )
            .unwrap();
        let transport = MockTransport {
            outcomes: Arc::new(HashMap::new()),
            sent: Arc::new(Mutex::new(Vec::new())),
        };
        let sent = transport.sent.clone();
        let (sender, receiver) = mpsc::channel(1);
        let service = PushService::new(store.clone(), "public-key".to_owned(), sender);
        let worker = tokio::spawn(run_dispatcher(
            receiver,
            store,
            Arc::new(ES256KeyPair::generate()),
            transport,
        ));
        let runtime = PushRuntime {
            service: service.clone(),
            worker: Some(worker),
        };
        service.notify_terminal("thread", "turn", TerminalPushStatus::Completed, "Task");

        runtime.shutdown().await;

        assert_eq!(sent.lock().unwrap().as_slice(), [client_id]);
    }

    #[tokio::test]
    async fn push_runtime_reuses_the_persisted_vapid_key_after_restart() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("caffold.redb");
        let store = TaskStore::redb(&path).unwrap();
        let first = PushRuntime::new(store.clone()).unwrap();
        let public_key = first.service().public_key().to_owned();
        assert_eq!(URL_SAFE_NO_PAD.decode(&public_key).unwrap().len(), 65);
        first.shutdown().await;
        drop(store);

        let reopened = TaskStore::redb(&path).unwrap();
        let second = PushRuntime::new(reopened).unwrap();
        assert_eq!(second.service().public_key(), public_key);
        second.shutdown().await;
    }

    #[tokio::test]
    async fn api_requires_same_origin_and_round_trips_subscription_without_exposing_secrets() {
        let root = tempfile::tempdir().unwrap();
        let store = TaskStore::memory().unwrap();
        let (shutdown, _) = broadcast::channel(1);
        let push_runtime = PushRuntime::new(store.clone()).unwrap();
        let state = TaskState::new_with_push(
            Arc::new(RootedFs::new(root.path()).unwrap()),
            String::new(),
            shutdown,
            store.clone(),
            root.path().join("worktrees"),
            push_runtime.service(),
            super::super::AgentRuntimeDependencies {
                claude: agent::claude::ClaudeClient::mock().0,
                codex_mcp: None,
            },
        )
        .unwrap();
        let app = router().with_state(state);
        let client_id = "00000000-0000-4000-8000-000000000001";
        let source = subscription(client_id, "https://push.example.test/subscription");
        let body = json!({
            "installationLabel": source.installation_label,
            "endpoint": source.endpoint,
            "expirationTime": null,
            "keys": { "p256dh": source.p256dh, "auth": source.auth },
        })
        .to_string();

        let config = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/push/config")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(config.status(), StatusCode::OK);
        let config: JsonValue = serde_json::from_slice(
            &axum::body::to_bytes(config.into_body(), 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD
                .decode(config["publicKey"].as_str().unwrap())
                .unwrap()
                .len(),
            65
        );

        let oversized = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/push/installations/{client_id}"))
                    .header(HOST, "localhost:5178")
                    .header("origin", "http://localhost:5178")
                    .header("content-type", "application/json")
                    .body(Body::from(vec![b' '; MAX_PUSH_REQUEST_BYTES + 1]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert!(store.push_installation(client_id).unwrap().is_none());

        let missing_origin = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/push/installations/{client_id}"))
                    .header(HOST, "localhost:5178")
                    .header("content-type", "application/json")
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_origin.status(), StatusCode::BAD_REQUEST);
        assert!(store.push_installation(client_id).unwrap().is_none());

        let registered = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(format!("/api/push/installations/{client_id}"))
                    .header(HOST, "localhost:5178")
                    .header("origin", "http://localhost:5178")
                    .header("content-type", "application/json")
                    .body(Body::from(body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(registered.status(), StatusCode::OK);
        assert!(
            store
                .push_installation(client_id)
                .unwrap()
                .unwrap()
                .is_active()
        );

        let listed = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/push/installations?clientId={client_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let listed: JsonValue = serde_json::from_slice(
            &axum::body::to_bytes(listed.into_body(), 16 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(listed["currentState"], "subscribed");
        assert_eq!(listed["installations"].as_array().unwrap().len(), 1);
        let encoded = listed.to_string();
        assert!(!encoded.contains("endpoint"));
        assert!(!encoded.contains("p256dh"));
        assert!(!encoded.contains("auth"));

        let deleted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/push/installations/{client_id}"))
                    .header(HOST, "localhost:5178")
                    .header("origin", "http://localhost:5178")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        let tombstone = store.push_installation(client_id).unwrap().unwrap();
        assert_eq!(tombstone.endpoint, None);
        assert!(tombstone.revoked_at_ms.is_some());

        let listed = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/push/installations?clientId={client_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let listed: JsonValue = serde_json::from_slice(
            &axum::body::to_bytes(listed.into_body(), 16 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(listed["currentState"], "revoked");
        assert!(listed["installations"].as_array().unwrap().is_empty());

        push_runtime.shutdown().await;
    }
}
