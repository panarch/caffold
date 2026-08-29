use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    str::FromStr,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, uri::Authority},
    response::Response,
    routing::{get, put},
};
use futures_util::{Stream, StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::{
    sync::{broadcast, mpsc},
    task::JoinHandle,
};
use url::Url;
use uuid::Uuid;

use super::{error::ApiError, tasks::TaskLiveSource};
use crate::watch::{WatchChange, WatchHub, WatchMessage};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const CHANNEL_QUEUE_CAPACITY: usize = 16;
const CONTROL_QUEUE_CAPACITY: usize = 8;
const MAX_WATCH_SUBSCRIPTIONS: usize = 64;

#[derive(Clone)]
struct LiveUpdatesState {
    task_source: TaskLiveSource,
    watch_hub: WatchHub,
    shutdown: broadcast::Sender<()>,
    sessions: Arc<Mutex<HashMap<Uuid, mpsc::Sender<SubscriptionSnapshot>>>>,
}

pub(in crate::app) fn router(
    task_source: TaskLiveSource,
    watch_hub: WatchHub,
    shutdown: broadcast::Sender<()>,
) -> Router {
    let state = LiveUpdatesState {
        task_source,
        watch_hub,
        shutdown,
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };
    Router::new()
        .route("/api/live", get(live_stream))
        .route(
            "/api/live/{connection_id}/subscriptions",
            put(update_subscriptions),
        )
        .with_state(state)
}

async fn live_stream(State(state): State<LiveUpdatesState>) -> Result<Response, ApiError> {
    let connection_id = Uuid::new_v4();
    let (control, controls) = mpsc::channel(CONTROL_QUEUE_CAPACITY);
    state
        .sessions
        .lock()
        .map_err(|_| ApiError::Internal("live session registry is unavailable".to_string()))?
        .insert(connection_id, control);
    Ok(LiveSession::new(connection_id, controls, state).response())
}

async fn update_subscriptions(
    State(state): State<LiveUpdatesState>,
    Path(connection_id): Path<String>,
    headers: HeaderMap,
    Json(subscriptions): Json<SubscriptionSnapshot>,
) -> Result<StatusCode, ApiError> {
    require_same_origin(&headers)?;
    let connection_id = parse_connection_id(&connection_id)?;
    subscriptions.validate()?;
    let sender = state
        .sessions
        .lock()
        .map_err(|_| ApiError::Internal("live session registry is unavailable".to_string()))?
        .get(&connection_id)
        .cloned()
        .ok_or_else(live_session_not_found)?;
    sender
        .send(subscriptions)
        .await
        .map_err(|_| live_session_not_found())?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SubscriptionSnapshot {
    control_revision: u64,
    task_list: Option<ChannelSubscription>,
    task_detail: Option<TaskDetailSubscription>,
    #[serde(default)]
    watches: Vec<WatchSubscription>,
}

impl SubscriptionSnapshot {
    fn validate(&self) -> Result<(), ApiError> {
        if self.control_revision == 0 {
            return Err(invalid_subscriptions("control revision must be positive"));
        }
        if self
            .task_list
            .as_ref()
            .is_some_and(|subscription| subscription.generation == 0)
            || self
                .task_detail
                .as_ref()
                .is_some_and(|subscription| subscription.generation == 0)
            || self
                .watches
                .iter()
                .any(|subscription| subscription.generation == 0)
        {
            return Err(invalid_subscriptions(
                "subscription generations must be positive",
            ));
        }
        if self.task_detail.as_ref().is_some_and(|subscription| {
            subscription.thread_id.trim().is_empty()
                || subscription.thread_id.trim() != subscription.thread_id
        }) {
            return Err(invalid_subscriptions(
                "Task Detail requires a canonical thread ID",
            ));
        }
        if self.watches.len() > MAX_WATCH_SUBSCRIPTIONS {
            return Err(invalid_subscriptions("too many Watch subscriptions"));
        }
        let mut watch_ids = HashSet::new();
        if self.watches.iter().any(|subscription| {
            subscription.subscription_id.trim().is_empty()
                || subscription.subscription_id.trim() != subscription.subscription_id
                || !watch_ids.insert(subscription.subscription_id.as_str())
        }) {
            return Err(invalid_subscriptions(
                "Watch subscription IDs must be canonical and unique",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChannelSubscription {
    generation: u64,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskDetailSubscription {
    generation: u64,
    thread_id: String,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WatchSubscription {
    subscription_id: String,
    generation: u64,
    #[serde(default)]
    path: String,
}

struct LiveSession {
    controls: mpsc::Receiver<SubscriptionSnapshot>,
    _registration: SessionRegistration,
    task_source: TaskLiveSource,
    watch_hub: WatchHub,
    shutdown: broadcast::Receiver<()>,
    heartbeat: tokio::time::Interval,
    initial_frame: Option<Bytes>,
    control_revision: u64,
    desired_task_list: Option<ChannelSubscription>,
    desired_task_detail: Option<TaskDetailSubscription>,
    desired_watches: HashMap<String, WatchSubscription>,
    channel_outputs: futures_util::stream::SelectAll<ChannelStream>,
    task_list: Option<ChannelTask>,
    task_detail: Option<ChannelTask>,
    watches: HashMap<String, ChannelTask>,
}

impl LiveSession {
    fn new(
        connection_id: Uuid,
        controls: mpsc::Receiver<SubscriptionSnapshot>,
        state: LiveUpdatesState,
    ) -> Self {
        let heartbeat = tokio::time::interval_at(
            tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
            HEARTBEAT_INTERVAL,
        );
        Self {
            controls,
            _registration: SessionRegistration {
                connection_id,
                sessions: state.sessions,
            },
            task_source: state.task_source,
            watch_hub: state.watch_hub,
            shutdown: state.shutdown.subscribe(),
            heartbeat,
            initial_frame: Some(gateway_ready_frame(connection_id)),
            control_revision: 0,
            desired_task_list: None,
            desired_task_detail: None,
            desired_watches: HashMap::new(),
            channel_outputs: futures_util::stream::SelectAll::new(),
            task_list: None,
            task_detail: None,
            watches: HashMap::new(),
        }
    }

    fn response(self) -> Response {
        let stream = stream::unfold(self, |mut session| async move {
            if let Some(frame) = session.initial_frame.take() {
                return Some((Ok::<_, Infallible>(frame), session));
            }
            loop {
                tokio::select! {
                    _ = session.shutdown.recv() => return None,
                    control = session.controls.recv() => match control {
                        Some(control) => session.apply(control),
                        None => return None,
                    },
                    _ = session.heartbeat.tick() => {
                        return Some((
                            Ok(Bytes::from_static(b": heartbeat\n\n")),
                            session,
                        ));
                    }
                    Some(frame) = session.channel_outputs.next() => {
                        return Some((Ok(frame), session));
                    }
                }
            }
        });
        let mut response = Response::new(Body::from_stream(stream));
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream; charset=utf-8"),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        response
    }

    fn apply(&mut self, subscriptions: SubscriptionSnapshot) {
        if subscriptions.control_revision <= self.control_revision {
            return;
        }
        self.control_revision = subscriptions.control_revision;

        if subscriptions.task_list != self.desired_task_list {
            self.task_list = subscriptions.task_list.as_ref().map(|subscription| {
                self.spawn(spawn_task_list(
                    self.task_source.clone(),
                    subscription.generation,
                ))
            });
            self.desired_task_list = subscriptions.task_list;
        }
        if subscriptions.task_detail != self.desired_task_detail {
            self.task_detail = subscriptions.task_detail.as_ref().map(|subscription| {
                self.spawn(spawn_task_detail(
                    self.task_source.clone(),
                    subscription.generation,
                    subscription.thread_id.trim().to_string(),
                ))
            });
            self.desired_task_detail = subscriptions.task_detail;
        }

        let desired_watches = subscriptions
            .watches
            .into_iter()
            .map(|subscription| (subscription.subscription_id.clone(), subscription))
            .collect::<HashMap<_, _>>();
        self.watches
            .retain(|subscription_id, _| desired_watches.contains_key(subscription_id));
        for (subscription_id, subscription) in &desired_watches {
            if self.desired_watches.get(subscription_id) == Some(subscription) {
                continue;
            }
            let spawned = spawn_watch(
                self.watch_hub.clone(),
                subscription.subscription_id.clone(),
                subscription.generation,
                subscription.path.clone(),
            );
            let task = self.spawn(spawned);
            self.watches.insert(subscription_id.clone(), task);
        }
        self.desired_watches = desired_watches;
    }

    fn spawn(&mut self, channel: SpawnedChannel) -> ChannelTask {
        self.channel_outputs.push(channel.messages);
        ChannelTask(channel.task)
    }
}

struct SessionRegistration {
    connection_id: Uuid,
    sessions: Arc<Mutex<HashMap<Uuid, mpsc::Sender<SubscriptionSnapshot>>>>,
}

impl Drop for SessionRegistration {
    fn drop(&mut self) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&self.connection_id);
        }
    }
}

struct ChannelTask(JoinHandle<()>);

impl Drop for ChannelTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

type ChannelStream = std::pin::Pin<Box<dyn Stream<Item = Bytes> + Send>>;

struct SpawnedChannel {
    messages: ChannelStream,
    task: JoinHandle<()>,
}

fn spawn_task_list(source: TaskLiveSource, generation: u64) -> SpawnedChannel {
    spawn_channel(move |messages| async move {
        send_frame(&messages, channel_open_frame("task-list", None, generation)).await?;
        let mut events = match source.task_list().await {
            Ok(events) => events,
            Err(error) => {
                send_frame(
                    &messages,
                    channel_error_frame("task-list", None, generation, &error.to_string()),
                )
                .await?;
                return Some(());
            }
        };
        while let Some(event) = events.next().await {
            send_frame(
                &messages,
                channel_event_frame("task-list", None, generation, &event),
            )
            .await?;
        }
        None
    })
}

fn spawn_task_detail(source: TaskLiveSource, generation: u64, thread_id: String) -> SpawnedChannel {
    spawn_channel(move |messages| async move {
        send_frame(
            &messages,
            channel_open_frame("task-detail", None, generation),
        )
        .await?;
        let mut events = match source.task_detail(&thread_id).await {
            Ok(events) => events,
            Err(error) => {
                send_frame(
                    &messages,
                    channel_error_frame("task-detail", None, generation, &error.to_string()),
                )
                .await?;
                return Some(());
            }
        };
        while let Some(event) = events.next().await {
            send_frame(
                &messages,
                channel_event_frame("task-detail", None, generation, &event),
            )
            .await?;
        }
        None
    })
}

fn spawn_watch(
    hub: WatchHub,
    subscription_id: String,
    generation: u64,
    path: String,
) -> SpawnedChannel {
    spawn_channel(move |messages| async move {
        send_frame(
            &messages,
            channel_open_frame("watch", Some(&subscription_id), generation),
        )
        .await?;
        let mut subscription = match hub.subscribe(&path) {
            Ok(subscription) => subscription,
            Err(error) => {
                send_frame(
                    &messages,
                    channel_error_frame(
                        "watch",
                        Some(&subscription_id),
                        generation,
                        &error.to_string(),
                    ),
                )
                .await?;
                return Some(());
            }
        };
        let mut revision = subscription.ready.revision;
        send_frame(
            &messages,
            channel_event_frame(
                "watch",
                Some(&subscription_id),
                generation,
                &WatchLiveEvent::Ready(subscription.ready.clone()),
            ),
        )
        .await?;
        loop {
            match subscription.recv().await {
                Ok(WatchMessage::Change(change)) => {
                    revision = change.revision;
                    send_frame(
                        &messages,
                        channel_event_frame(
                            "watch",
                            Some(&subscription_id),
                            generation,
                            &WatchLiveEvent::Change(change),
                        ),
                    )
                    .await?;
                }
                Ok(WatchMessage::Error(message)) => {
                    send_frame(
                        &messages,
                        channel_event_frame(
                            "watch",
                            Some(&subscription_id),
                            generation,
                            &WatchLiveEvent::Error(WatchErrorPayload { message }),
                        ),
                    )
                    .await?;
                    return Some(());
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    revision = revision.saturating_add(1);
                    let repository = subscription.ready.repository_root_path.is_some();
                    let change = WatchChange {
                        revision,
                        paths: Vec::new(),
                        git_status_changed: repository,
                        git_refs_changed: repository,
                        overflow: true,
                    };
                    send_frame(
                        &messages,
                        channel_event_frame(
                            "watch",
                            Some(&subscription_id),
                            generation,
                            &WatchLiveEvent::Change(change),
                        ),
                    )
                    .await?;
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    })
}

fn spawn_channel<F, Fut>(run: F) -> SpawnedChannel
where
    F: FnOnce(mpsc::Sender<Bytes>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Option<()>> + Send + 'static,
{
    let (messages, receiver) = mpsc::channel(CHANNEL_QUEUE_CAPACITY);
    let task = tokio::spawn(async move {
        let _ = run(messages).await;
    });
    let messages = Box::pin(stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|message| (message, receiver))
    }));
    SpawnedChannel { messages, task }
}

async fn send_frame(messages: &mpsc::Sender<Bytes>, frame: Bytes) -> Option<()> {
    messages.send(frame).await.ok()
}

#[derive(Serialize)]
struct ChannelEnvelope<'a, T> {
    channel: &'static str,
    #[serde(rename = "subscriptionId", skip_serializing_if = "Option::is_none")]
    subscription_id: Option<&'a str>,
    generation: u64,
    #[serde(flatten)]
    event: &'a T,
}

#[derive(Serialize)]
#[serde(tag = "type", content = "payload")]
enum WatchLiveEvent {
    #[serde(rename = "ready")]
    Ready(crate::watch::WatchReady),
    #[serde(rename = "change")]
    Change(WatchChange),
    #[serde(rename = "watch-error")]
    Error(WatchErrorPayload),
}

#[derive(Serialize)]
struct WatchErrorPayload {
    message: String,
}

#[derive(Serialize)]
#[serde(tag = "type", content = "payload")]
enum ChannelLifecycleEvent<'a> {
    #[serde(rename = "channel-open")]
    Open,
    #[serde(rename = "channel-error")]
    Error(ChannelErrorPayload<'a>),
}

#[derive(Serialize)]
struct ChannelErrorPayload<'a> {
    message: &'a str,
}

fn gateway_ready_frame(connection_id: Uuid) -> Bytes {
    sse_frame(
        "gateway-ready",
        &json!({ "connectionId": connection_id.hyphenated().to_string() }),
    )
}

fn channel_open_frame(
    channel: &'static str,
    subscription_id: Option<&str>,
    generation: u64,
) -> Bytes {
    channel_event_frame(
        channel,
        subscription_id,
        generation,
        &ChannelLifecycleEvent::Open,
    )
}

fn channel_error_frame(
    channel: &'static str,
    subscription_id: Option<&str>,
    generation: u64,
    message: &str,
) -> Bytes {
    channel_event_frame(
        channel,
        subscription_id,
        generation,
        &ChannelLifecycleEvent::Error(ChannelErrorPayload { message }),
    )
}

fn channel_event_frame<T: Serialize>(
    channel: &'static str,
    subscription_id: Option<&str>,
    generation: u64,
    event: &T,
) -> Bytes {
    sse_frame(
        "live-update",
        &ChannelEnvelope {
            channel,
            subscription_id,
            generation,
            event,
        },
    )
}

fn sse_frame<T: Serialize>(event: &str, payload: &T) -> Bytes {
    let payload = serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string());
    Bytes::from(format!("event: {event}\ndata: {payload}\n\n"))
}

fn parse_connection_id(value: &str) -> Result<Uuid, ApiError> {
    Uuid::parse_str(value).map_err(|_| invalid_subscriptions("invalid live connection ID"))
}

fn require_same_origin(headers: &HeaderMap) -> Result<(), ApiError> {
    let origin = headers
        .get("origin")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(same_origin_required)?;
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(same_origin_required)?;
    if !same_origin_host(origin, host) {
        return Err(same_origin_required());
    }
    Ok(())
}

fn same_origin_host(origin: &str, request_host: &str) -> bool {
    let Ok(origin) = Url::parse(origin) else {
        return false;
    };
    let Ok(authority) = Authority::from_str(request_host) else {
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

fn invalid_subscriptions(message: &str) -> ApiError {
    ApiError::BadRequest {
        code: "invalid_live_subscriptions",
        message: message.to_string(),
    }
}

fn same_origin_required() -> ApiError {
    ApiError::Forbidden {
        code: "same_origin_live_control_required",
        message: "Live subscription changes require a same-origin request.".to_string(),
    }
}

fn live_session_not_found() -> ApiError {
    ApiError::NotFound {
        code: "live_session_not_found",
        message: "Live connection is no longer active.".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use axum::{body::Body, http::Request};
    use futures_util::StreamExt;
    use tower::ServiceExt;

    use super::*;
    use crate::fs::RootedFs;

    #[test]
    fn validates_ordering_and_channel_identity() {
        let valid = SubscriptionSnapshot {
            control_revision: 4,
            task_list: Some(ChannelSubscription { generation: 2 }),
            task_detail: Some(TaskDetailSubscription {
                generation: 7,
                thread_id: "thread-a".to_string(),
            }),
            watches: vec![
                WatchSubscription {
                    subscription_id: "review".to_string(),
                    generation: 9,
                    path: "workspace".to_string(),
                },
                WatchSubscription {
                    subscription_id: "files".to_string(),
                    generation: 3,
                    path: "other".to_string(),
                },
            ],
        };
        valid
            .validate()
            .expect("complete subscription state is valid");

        let mut invalid = valid.clone();
        invalid.task_detail.as_mut().unwrap().thread_id.clear();
        assert!(invalid.validate().is_err());
        invalid = valid.clone();
        invalid.control_revision = 0;
        assert!(invalid.validate().is_err());

        let mut zero_generation = valid.clone();
        zero_generation.task_list.as_mut().unwrap().generation = 0;
        assert!(zero_generation.validate().is_err());
        zero_generation = valid.clone();
        zero_generation.task_detail.as_mut().unwrap().generation = 0;
        assert!(zero_generation.validate().is_err());
        zero_generation = valid.clone();
        zero_generation.watches[0].generation = 0;
        assert!(zero_generation.validate().is_err());

        let duplicate_watch = SubscriptionSnapshot {
            control_revision: 5,
            task_list: None,
            task_detail: None,
            watches: vec![
                WatchSubscription {
                    subscription_id: "same".to_string(),
                    generation: 1,
                    path: "first".to_string(),
                },
                WatchSubscription {
                    subscription_id: "same".to_string(),
                    generation: 2,
                    path: "second".to_string(),
                },
            ],
        };
        assert!(duplicate_watch.validate().is_err());

        let noncanonical = SubscriptionSnapshot {
            control_revision: 6,
            task_list: None,
            task_detail: Some(TaskDetailSubscription {
                generation: 1,
                thread_id: " thread-a".to_string(),
            }),
            watches: vec![WatchSubscription {
                subscription_id: "watch".to_string(),
                generation: 1,
                path: String::new(),
            }],
        };
        assert!(noncanonical.validate().is_err());

        let mut noncanonical_watch = valid.clone();
        noncanonical_watch.watches[0].subscription_id = " watch".to_string();
        assert!(noncanonical_watch.validate().is_err());

        let too_many_watches = SubscriptionSnapshot {
            control_revision: 7,
            task_list: None,
            task_detail: None,
            watches: (0..=MAX_WATCH_SUBSCRIPTIONS)
                .map(|index| WatchSubscription {
                    subscription_id: format!("watch-{index}"),
                    generation: 1,
                    path: String::new(),
                })
                .collect(),
        };
        assert!(too_many_watches.validate().is_err());
    }

    #[test]
    fn validates_same_origin_control_hosts() {
        assert!(same_origin_host("http://localhost:5178", "localhost:5178"));
        assert!(same_origin_host("https://Example.test", "example.test"));
        assert!(!same_origin_host("https://elsewhere.test", "example.test"));
    }

    #[tokio::test]
    async fn gateway_registers_controls_and_unregisters_with_the_response_body() {
        let root = tempfile::tempdir().unwrap();
        let app = super::super::router(RootedFs::new(root.path()).unwrap()).unwrap();
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/live")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/event-stream; charset=utf-8"
        );
        let mut body = response.into_body().into_data_stream();
        let ready = tokio::time::timeout(Duration::from_millis(100), body.next())
            .await
            .expect("gateway-ready frame")
            .expect("gateway remains open")
            .unwrap();
        let ready = std::str::from_utf8(&ready).unwrap();
        let payload = ready
            .strip_prefix("event: gateway-ready\ndata: ")
            .and_then(|frame| frame.strip_suffix("\n\n"))
            .expect("gateway-ready SSE envelope");
        let connection_id =
            serde_json::from_str::<serde_json::Value>(payload).unwrap()["connectionId"]
                .as_str()
                .unwrap()
                .to_string();

        let control_uri = format!("/api/live/{connection_id}/subscriptions");
        let accepted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(&control_uri)
                    .header(header::HOST, "localhost:5178")
                    .header("origin", "http://localhost:5178")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "controlRevision": 2,
                            "taskList": null,
                            "taskDetail": null,
                            "watches": [
                                {
                                    "subscriptionId": "first",
                                    "generation": 1,
                                    "path": "",
                                },
                                {
                                    "subscriptionId": "second",
                                    "generation": 2,
                                    "path": "",
                                },
                            ],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::NO_CONTENT);

        let stale = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(&control_uri)
                    .header(header::HOST, "localhost:5178")
                    .header("origin", "http://localhost:5178")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "controlRevision": 1,
                            "taskList": null,
                            "taskDetail": null,
                            "watches": [],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::NO_CONTENT);

        let mut ready_watches = HashSet::new();
        tokio::time::timeout(Duration::from_millis(500), async {
            while ready_watches.len() < 2 {
                let frame = body.next().await.expect("gateway remains open").unwrap();
                let frame = std::str::from_utf8(&frame).unwrap();
                let Some(payload) = frame
                    .strip_prefix("event: live-update\ndata: ")
                    .and_then(|frame| frame.strip_suffix("\n\n"))
                else {
                    continue;
                };
                let payload: serde_json::Value = serde_json::from_str(payload).unwrap();
                if payload["channel"] == "watch" && payload["type"] == "ready" {
                    ready_watches.insert(payload["subscriptionId"].as_str().unwrap().to_string());
                }
            }
        })
        .await
        .expect("both Watch channels become ready");
        assert_eq!(
            ready_watches,
            HashSet::from(["first".to_string(), "second".to_string()])
        );

        drop(body);
        tokio::task::yield_now().await;
        let gone = app
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri(&control_uri)
                    .header(header::HOST, "localhost:5178")
                    .header("origin", "http://localhost:5178")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "controlRevision": 3,
                            "taskList": null,
                            "taskDetail": null,
                            "watches": [],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(gone.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn live_control_rejects_cross_origin_and_legacy_stream_routes_are_absent() {
        let root = tempfile::tempdir().unwrap();
        let app = super::super::router(RootedFs::new(root.path()).unwrap()).unwrap();
        let forbidden = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PUT")
                    .uri("/api/live/00000000-0000-0000-0000-000000000000/subscriptions")
                    .header(header::HOST, "localhost:5178")
                    .header("origin", "http://elsewhere.test")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "controlRevision": 1,
                            "taskList": null,
                            "taskDetail": null,
                            "watches": [],
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(forbidden.status(), StatusCode::FORBIDDEN);

        for uri in ["/api/watch?path=", "/api/tasks/unknown/stream"] {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        }
        let legacy_list = app
            .oneshot(
                Request::builder()
                    .uri("/api/tasks/stream")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(legacy_list.status(), StatusCode::BAD_REQUEST);
        assert_ne!(
            legacy_list.headers().get(header::CONTENT_TYPE),
            Some(&HeaderValue::from_static(
                "text/event-stream; charset=utf-8"
            ))
        );
    }

    #[test]
    fn frames_carry_channel_and_watch_subscription_identity() {
        let task = channel_event_frame(
            "task-list",
            None,
            4,
            &json!({ "type": "task-list-refresh" }),
        );
        assert_eq!(
            std::str::from_utf8(&task).unwrap(),
            "event: live-update\ndata: {\"channel\":\"task-list\",\"generation\":4,\"type\":\"task-list-refresh\"}\n\n"
        );
        let watch = channel_event_frame(
            "watch",
            Some("files"),
            7,
            &json!({ "type": "change", "payload": { "revision": 2 } }),
        );
        let watch = std::str::from_utf8(&watch).unwrap();
        assert!(watch.contains("\"subscriptionId\":\"files\""));
        assert!(watch.contains("\"generation\":7"));
    }
}
