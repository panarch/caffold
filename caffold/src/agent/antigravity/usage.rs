//! Model-free quota query owned by the CLI's headless command.
use super::AntigravityError;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::{path::Path, process::Stdio, time::Duration};

#[derive(Debug, Clone, Default, Serialize)]
pub(super) struct UsageStatus {
    windows: Vec<UsageWindow>,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageWindow {
    group: String,
    period: Period,
    percent: f64,
    resets_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Period {
    FiveHours,
    Weekly,
}

#[derive(Deserialize)]
struct Report {
    status: String,
    num_turns: u64,
    command: NativeCommand,
}
#[derive(Deserialize)]
struct NativeCommand {
    name: String,
    data: Quota,
}
#[derive(Deserialize)]
struct Quota {
    groups: Vec<Group>,
}
#[derive(Deserialize)]
struct Group {
    name: String,
    buckets: Vec<Bucket>,
}
#[derive(Deserialize)]
struct Bucket {
    window: String,
    remaining_fraction: f64,
    reset_time: String,
}

impl UsageStatus {
    pub(super) fn from_result(result: Result<Self, AntigravityError>) -> Self {
        result.unwrap_or_else(|error| Self {
            windows: vec![],
            error: Some(error.to_string()),
        })
    }

    pub(super) async fn read(executable: &Path, cwd: &str) -> Result<Self, AntigravityError> {
        let output = tokio::time::timeout(
            Duration::from_secs(30),
            tokio::process::Command::new(executable)
                .args([
                    "--print",
                    "/usage",
                    "--output-format",
                    "json",
                    "--print-timeout",
                    "20s",
                ])
                .current_dir(cwd)
                .stdin(Stdio::null())
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| invalid("native usage read timed out"))?
        .map_err(|error| AntigravityError::Unreachable(error.to_string()))?;
        if !output.status.success() {
            return Err(invalid(
                "agy --print /usage failed; check CLI authentication and retry",
            ));
        }
        Self::from_report(&output.stdout)
    }

    fn from_report(bytes: &[u8]) -> Result<Self, AntigravityError> {
        let report: Report = serde_json::from_slice(bytes)
            .map_err(|error| invalid(&format!("invalid native usage report: {error}")))?;
        if report.status != "SUCCESS" || report.num_turns != 0 || report.command.name != "usage" {
            return Err(invalid(
                "native usage was not a successful model-free command",
            ));
        }
        let mut windows = Vec::new();
        for group in report.command.data.groups {
            if group.name.is_empty() {
                return Err(invalid("native quota group is empty"));
            }
            for bucket in group.buckets {
                let period = match bucket.window.as_str() {
                    "5h" => Period::FiveHours,
                    "weekly" => Period::Weekly,
                    _ => continue,
                };
                if !bucket.remaining_fraction.is_finite()
                    || !(0.0..=1.0).contains(&bucket.remaining_fraction)
                {
                    return Err(invalid("native quota remaining fraction is invalid"));
                }
                let resets_at = DateTime::parse_from_rfc3339(&bucket.reset_time)
                    .map_err(|_| invalid("native quota reset time is invalid"))?
                    .to_rfc3339();
                windows.push(UsageWindow {
                    group: match group.name.as_str() {
                        "Gemini Models" => "Gemini",
                        "Claude and GPT models" => "Claude / GPT",
                        other => other,
                    }
                    .into(),
                    period,
                    percent: (1.0 - bucket.remaining_fraction) * 100.0,
                    resets_at,
                });
            }
        }
        if windows.is_empty() {
            return Err(invalid("Antigravity did not report quota windows"));
        }
        Ok(Self {
            windows,
            error: None,
        })
    }
}
fn invalid(message: &str) -> AntigravityError {
    AntigravityError::Protocol(message.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn report() -> Value {
        json!({"status":"SUCCESS","num_turns":0,"command":{"name":"usage","data":{"groups":[
            {"name":"Gemini Models","buckets":[
                {"window":"weekly","remaining_fraction":0.75,"reset_time":"2026-11-07T08:50:32Z"},
                {"window":"5h","remaining_fraction":1.0,"reset_time":"2026-11-06T09:33:37Z"}
            ]}
        ]}}})
    }

    #[test]
    fn native_structured_quota_is_used_without_parsing_display_text() {
        let usage = UsageStatus::from_report(&serde_json::to_vec(&report()).unwrap()).unwrap();
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].group, "Gemini");
        assert_eq!(usage.windows[0].period, Period::Weekly);
        assert_eq!(usage.windows[0].percent, 25.0);
        assert_eq!(usage.windows[0].resets_at, "2026-11-07T08:50:32+00:00");
        assert_eq!(usage.windows[1].period, Period::FiveHours);
        assert_eq!(usage.windows[1].percent, 0.0);
    }

    #[test]
    fn model_answers_missing_quota_and_invalid_native_values_are_unavailable() {
        for (pointer, value) in [
            ("/num_turns", json!(1)),
            ("/status", json!("ERROR")),
            ("/command/name", json!("prompt")),
            ("/command/data/groups", json!([])),
            (
                "/command/data/groups/0/buckets/0/remaining_fraction",
                json!(1.1),
            ),
            (
                "/command/data/groups/0/buckets/0/reset_time",
                json!("unknown"),
            ),
        ] {
            let mut report = report();
            *report.pointer_mut(pointer).unwrap() = value;
            let status = UsageStatus::from_result(UsageStatus::from_report(
                &serde_json::to_vec(&report).unwrap(),
            ));
            assert!(status.windows.is_empty(), "{pointer}");
            assert!(status.error.is_some(), "{pointer}");
        }
        assert!(matches!(
            UsageStatus::from_report(b"model response"),
            Err(AntigravityError::Protocol(_))
        ));
    }
}
