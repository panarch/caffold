//! Quota windows reported by the pinned agent's model-free /usage command.
use super::AntigravityError;
use chrono::NaiveDateTime;
use serde::Serialize;

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

impl UsageStatus {
    pub(super) fn from_result(result: Result<Self, AntigravityError>) -> Self {
        result.unwrap_or_else(|error| Self {
            windows: vec![],
            error: Some(error.to_string()),
        })
    }

    pub(super) fn from_report(report: &str) -> Result<Self, AntigravityError> {
        let (_, quota) = report
            .split_once("### Quota Limits\n")
            .ok_or_else(|| invalid("native /usage did not return its quota section"))?;
        let mut group = "";
        let mut windows = Vec::new();
        for line in quota.lines() {
            if line.starts_with("### ") {
                break;
            }
            if let Some(label) = line
                .strip_prefix("- **")
                .and_then(|line| line.strip_suffix("**"))
            {
                group = label;
                continue;
            }
            let Some((label, value)) = line
                .strip_prefix("  - **")
                .and_then(|line| line.split_once(":** "))
            else {
                continue; // Group membership and plan prose are not quota windows.
            };
            let period = match label {
                "Five Hour Limit Remaining" => Period::FiveHours,
                "Weekly Limit Remaining" => Period::Weekly,
                label if !group.is_empty() && label == format!("{group} Weekly Limit") => {
                    Period::Weekly
                }
                _ => continue,
            };
            let (remaining, reset) = value
                .split_once("% remaining (resets ")
                .ok_or_else(|| invalid("native quota window has an unsupported format"))?;
            let remaining: f64 = remaining
                .parse()
                .map_err(|_| invalid("native quota percentage is invalid"))?;
            if group.is_empty() || !remaining.is_finite() || !(0.0..=100.0).contains(&remaining) {
                return Err(invalid("native quota group or percentage is invalid"));
            }
            let reset = reset
                .strip_suffix(')')
                .ok_or_else(|| invalid("native quota reset time is invalid"))?;
            let reset = NaiveDateTime::parse_from_str(reset, "%b %d, %Y, %H:%M UTC")
                .map_err(|_| invalid("native quota reset time is invalid"))?;
            windows.push(UsageWindow {
                group: match group {
                    "Gemini Models" => "Gemini",
                    "Claude and GPT models" => "Claude / GPT",
                    other => other,
                }
                .into(),
                period,
                percent: 100.0 - remaining,
                resets_at: reset.and_utc().to_rfc3339(),
            });
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

    #[test]
    fn native_groups_windows_and_utc_resets_are_structured_without_report_prose() {
        let report = "### Session Usage\n- no usage\n\n### Quota Limits\n- **Gemini Models**\n  - *(Models within this group: Gemini Flash, Gemini Pro)*\n  - **Weekly Limit Remaining:** 99% remaining (resets Nov 07, 2026, 08:50 UTC)\n  - **Five Hour Limit Remaining:** 98.5% remaining (resets Nov 01, 2026, 08:24 UTC)\n- **Claude and GPT models**\n  - **Weekly Limit Remaining:** 100% remaining (resets Nov 08, 2026, 05:30 UTC)\n- **Gemini 4 Argon**\n  - *(For paid Pro plans, Argon quota is separate.)*\n  - **Gemini 4 Argon Weekly Limit:** 99% remaining (resets Nov 07, 2026, 03:18 UTC)\n";
        let usage = UsageStatus::from_report(report).unwrap();
        assert_eq!(usage.windows.len(), 4);
        assert_eq!(usage.windows[0].group, "Gemini");
        assert_eq!(usage.windows[0].period, Period::Weekly);
        assert_eq!(usage.windows[0].percent, 1.0);
        assert_eq!(usage.windows[0].resets_at, "2026-11-07T08:50:00+00:00");
        assert_eq!(usage.windows[1].period, Period::FiveHours);
        assert_eq!(usage.windows[1].percent, 1.5);
        assert_eq!(usage.windows[2].group, "Claude / GPT");
        assert_eq!(usage.windows[2].percent, 0.0);
        assert_eq!(usage.windows[3].group, "Gemini 4 Argon");
    }

    #[test]
    fn missing_or_invalid_quota_is_unavailable_never_zero_usage() {
        for value in [
            "101% remaining (resets Nov 07, 2026, 08:50 UTC)",
            "NaN% remaining (resets Nov 07, 2026, 08:50 UTC)",
            "99% remaining (resets unknown)",
            "unavailable",
        ] {
            let report = format!(
                "### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** {value}\n"
            );
            let status = UsageStatus::from_result(UsageStatus::from_report(&report));
            assert!(status.windows.is_empty());
            assert!(status.error.is_some());
        }
        for report in [
            "unexpected",
            "### Quota Limits\n- data not available yet",
            "### Quota Limits\n- **Gemini Models**\n  - **Unknown Limit:** 99%",
        ] {
            assert!(UsageStatus::from_report(report).is_err());
        }
    }
}
