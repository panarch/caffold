use std::{convert::Infallible, time::Duration};

use axum::{
    Router,
    body::{Body, Bytes},
    extract::{Query, State},
    http::{HeaderValue, header},
    response::Response,
    routing::get,
};
use futures_util::stream;
use serde_json::json;
use tokio::sync::broadcast;

use super::{PathQuery, WorkspaceState};
use crate::{
    app::error::ApiError,
    watch::{WatchChange, WatchMessage},
};

pub(super) fn router() -> Router<WorkspaceState> {
    Router::new().route("/api/watch", get(watch_stream))
}

async fn watch_stream(
    State(state): State<WorkspaceState>,
    Query(query): Query<PathQuery>,
) -> Result<Response, ApiError> {
    let subscription = state.watch_hub.subscribe(&query.path)?;
    let shutdown = state.shutdown.subscribe();
    let heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(15),
        Duration::from_secs(15),
    );
    let stream = stream::unfold(
        (false, false, subscription, shutdown, heartbeat, 1_u64),
        |(ready_sent, terminate, mut subscription, mut shutdown, mut heartbeat, mut revision)| async move {
            if terminate {
                return None;
            }
            if !ready_sent {
                revision = subscription.ready.revision;
                let payload =
                    serde_json::to_string(&subscription.ready).unwrap_or_else(|_| "{}".to_string());
                let frame = format!("event: ready\ndata: {payload}\n\n");
                return Some((
                    Ok::<_, Infallible>(Bytes::from(frame)),
                    (true, false, subscription, shutdown, heartbeat, revision),
                ));
            }

            tokio::select! {
                    _ = shutdown.recv() => None,
                    _ = heartbeat.tick() => {
                        Some((
                            Ok::<_, Infallible>(Bytes::from_static(b": heartbeat\n\n")),
                            (true, false, subscription, shutdown, heartbeat, revision),
                        ))
                    }
                    message = subscription.recv() => match message {
                        Ok(WatchMessage::Change(change)) => {
                            revision = change.revision;
                            let payload = serde_json::to_string(&change)
                                .unwrap_or_else(|_| "{}".to_string());
                            let frame = format!("event: change\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, false, subscription, shutdown, heartbeat, revision),
                            ))
                        }
                        Ok(WatchMessage::Error(message)) => {
                            let payload = json!({ "message": message }).to_string();
                            let frame = format!("event: watch-error\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, true, subscription, shutdown, heartbeat, revision),
                            ))
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
                            let payload = serde_json::to_string(&change)
                                .unwrap_or_else(|_| "{}".to_string());
                            let frame = format!("event: change\ndata: {payload}\n\n");
                            Some((
                                Ok::<_, Infallible>(Bytes::from(frame)),
                                (true, false, subscription, shutdown, heartbeat, revision),
                            ))
                        }
                        Err(broadcast::error::RecvError::Closed) => None,
                    }
            }
        },
    );

    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(response)
}
