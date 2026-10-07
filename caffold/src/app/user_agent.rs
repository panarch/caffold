//! How server log lines name the browser behind a request, so lines that
//! different routes write about the same device can be matched.

use axum::http::{HeaderMap, header};

const BROWSER_LIMIT: usize = 160;

/// The request's `User-Agent`, shortened.
pub(super) fn browser_name(headers: &HeaderMap) -> String {
    headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(BROWSER_LIMIT).collect())
        .unwrap_or_else(|| "an unnamed browser".to_string())
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn headers(user_agent: Option<HeaderValue>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(user_agent) = user_agent {
            headers.insert(header::USER_AGENT, user_agent);
        }
        headers
    }

    #[test]
    fn a_browser_is_named_by_its_user_agent() {
        let user_agent = "Mozilla/5.0 (Linux; Android 10; K) Chrome/154.0.0.0 Mobile";

        assert_eq!(
            browser_name(&headers(Some(HeaderValue::from_static(user_agent)))),
            user_agent
        );
    }

    #[test]
    fn a_long_user_agent_is_shortened() {
        let long = "a".repeat(BROWSER_LIMIT + 40);

        let name = browser_name(&headers(Some(HeaderValue::from_str(&long).unwrap())));

        assert_eq!(name, "a".repeat(BROWSER_LIMIT));
    }

    #[test]
    fn a_missing_or_unreadable_user_agent_is_an_unnamed_browser() {
        assert_eq!(browser_name(&headers(None)), "an unnamed browser");
        assert_eq!(
            browser_name(&headers(Some(HeaderValue::from_bytes(b"\xff").unwrap()))),
            "an unnamed browser"
        );
    }
}
