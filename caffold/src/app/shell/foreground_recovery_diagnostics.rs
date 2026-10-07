//! Foreground recovery diagnostics, as the browser timed them. The browser
//! measures each recovery after the page returns; this route checks the shape
//! and writes one server log line per recovery, so the timings can be read
//! back later.

use axum::{
    Json,
    http::{HeaderMap, StatusCode},
};
use serde::{Deserialize, Serialize};

use crate::app::{error::ApiError, user_agent::browser_name};

const RECORD_LIMIT: usize = 20;
const LIST_LIMIT: usize = 64;
const TOKEN_LIMIT: usize = 40;
const PATH_LIMIT: usize = 200;

pub(super) async fn record_diagnostics(
    headers: HeaderMap,
    Json(request): Json<DiagnosticsRequest>,
) -> Result<StatusCode, ApiError> {
    request.validate()?;
    let browser = browser_name(&headers);
    for record in &request.records {
        tracing::info!(target: "caffold::foreground_recovery", "{}", log_line(record, &browser)?);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct DiagnosticsRequest {
    records: Vec<RecoveryRecord>,
}

/// One recovery after a return, every time in milliseconds since the page
/// became visible.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryRecord {
    hidden_for_ms: u64,
    ended_ms: u64,
    end: RecoveryEnd,
    recovery: Vec<RecoveryStep>,
    notice: Vec<NoticeStep>,
    targets: Vec<TargetStep>,
    connections: Vec<ConnectionTiming>,
    requests: Vec<RequestTiming>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum RecoveryEnd {
    Settled,
    Hidden,
    Limit,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RecoveryStep {
    ms: u64,
    node: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NoticeStep {
    ms: u64,
    state: NoticeState,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum NoticeState {
    None,
    Reconnecting,
    Offline,
    Unavailable,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TargetStep {
    ms: u64,
    list: String,
    detail: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConnectionTiming {
    id: u64,
    opened_ms: u64,
    answered_ms: Option<u64>,
    ended_ms: Option<u64>,
    end: Option<ConnectionEnd>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum ConnectionEnd {
    Stalled,
    Failed,
    Closed,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestTiming {
    path: String,
    start_ms: u64,
    first_byte_ms: Option<u64>,
    end_ms: u64,
    new_connection: Option<bool>,
}

impl DiagnosticsRequest {
    fn validate(&self) -> Result<(), ApiError> {
        if self.records.len() > RECORD_LIMIT {
            return Err(invalid("too many foreground recovery records"));
        }
        self.records.iter().try_for_each(RecoveryRecord::validate)
    }
}

impl RecoveryRecord {
    fn validate(&self) -> Result<(), ApiError> {
        let lengths = [
            self.recovery.len(),
            self.notice.len(),
            self.targets.len(),
            self.connections.len(),
            self.requests.len(),
        ];
        if lengths.iter().any(|length| *length > LIST_LIMIT) {
            return Err(invalid("a foreground recovery record lists too many steps"));
        }
        let mut names = self.recovery.iter().map(|step| step.node.as_str()).chain(
            self.targets
                .iter()
                .flat_map(|step| [step.list.as_str(), step.detail.as_str()]),
        );
        if !names.all(is_name) {
            return Err(invalid(
                "a foreground recovery record step has an unknown name",
            ));
        }
        if !self
            .requests
            .iter()
            .all(|request| is_api_path(&request.path))
        {
            return Err(invalid(
                "a foreground recovery record request is not a Caffold API path",
            ));
        }
        Ok(())
    }
}

fn log_line(record: &RecoveryRecord, browser: &str) -> Result<String, ApiError> {
    let json = serde_json::to_string(record).map_err(|error| {
        ApiError::Internal(format!(
            "foreground recovery record failed to encode: {error}"
        ))
    })?;
    Ok(format!("foreground recovery from {browser}: {json}"))
}

fn is_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= TOKEN_LIMIT
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
}

fn is_api_path(path: &str) -> bool {
    path.len() <= PATH_LIMIT
        && path.starts_with("/api/")
        && path.bytes().all(|byte| byte.is_ascii_graphic())
}

fn invalid(message: &str) -> ApiError {
    ApiError::BadRequest {
        code: "invalid_foreground_recovery_diagnostics",
        message: message.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::Request;
    use serde_json::{Value, json};
    use tower::ServiceExt;

    use super::*;
    use crate::fs::RootedFs;
    use crate::server_settings::ServerSettingsStore;

    fn stalled_recovery() -> Value {
        json!({
            "hiddenForMs": 183_000,
            "endedMs": 9_120,
            "end": "settled",
            "recovery": [
                { "ms": 0, "node": "suspended" },
                { "ms": 2, "node": "validating-status" },
                { "ms": 9_120, "node": "ready" }
            ],
            "notice": [
                { "ms": 0, "state": "none" },
                { "ms": 8_004, "state": "reconnecting" },
                { "ms": 8_890, "state": "none" }
            ],
            "targets": [{ "ms": 0, "list": "ready", "detail": "inactive" }],
            "connections": [
                { "id": 4, "openedMs": 0, "answeredMs": null, "endedMs": 8_003, "end": "stalled" },
                { "id": 5, "openedMs": 8_003, "answeredMs": 8_101, "endedMs": null, "end": null }
            ],
            "requests": [{
                "path": "/api/task-store/status",
                "startMs": 3,
                "firstByteMs": 9_050,
                "endMs": 9_051,
                "newConnection": false
            }]
        })
    }

    async fn post(body: Value) -> StatusCode {
        let root = tempfile::tempdir().unwrap();
        let router = super::super::router(
            Arc::new(RootedFs::new(root.path().to_path_buf()).unwrap()),
            Arc::new(ServerSettingsStore::memory()),
            String::new(),
            None,
        );
        router
            .oneshot(
                Request::post("/api/diagnostics/foreground-recovery")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    #[tokio::test]
    async fn a_recovery_record_is_accepted_without_content() {
        assert_eq!(
            post(json!({ "records": [stalled_recovery()] })).await,
            StatusCode::NO_CONTENT
        );
    }

    #[tokio::test]
    async fn a_record_naming_a_path_outside_the_api_is_refused() {
        let mut record = stalled_recovery();
        record["requests"][0]["path"] = json!("https://example.com/");

        assert_eq!(
            post(json!({ "records": [record] })).await,
            StatusCode::BAD_REQUEST
        );
    }

    #[tokio::test]
    async fn a_record_with_an_unknown_name_or_field_is_refused() {
        let mut renamed = stalled_recovery();
        renamed["recovery"][0]["node"] = json!("Suspended <script>");
        assert_eq!(
            post(json!({ "records": [renamed] })).await,
            StatusCode::BAD_REQUEST
        );

        let mut extended = stalled_recovery();
        extended["note"] = json!("free text");
        assert_eq!(
            post(json!({ "records": [extended] })).await,
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[tokio::test]
    async fn too_many_records_at_once_are_refused() {
        let records = vec![stalled_recovery(); RECORD_LIMIT + 1];

        assert_eq!(
            post(json!({ "records": records })).await,
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn each_recovery_is_one_log_line_naming_the_browser() {
        let record: RecoveryRecord = serde_json::from_value(stalled_recovery()).unwrap();

        let line = log_line(&record, "iPhone Safari").unwrap();

        assert!(line.starts_with("foreground recovery from iPhone Safari: {"));
        assert!(!line.contains('\n'));
        let record: Value = serde_json::from_str(line.split_once(": ").unwrap().1).unwrap();
        assert_eq!(record, stalled_recovery());
    }
}
