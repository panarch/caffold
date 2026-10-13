//! A response names its version in an `ETag`, and a browser that already holds
//! that version is answered without the body.

use axum::{
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};

/// The headers that name a response's version and make the browser ask
/// before it reuses that version. A tag is visible ASCII without quotes.
pub(super) fn headers(tag: &str) -> [(HeaderName, HeaderValue); 2] {
    [
        (
            header::ETAG,
            HeaderValue::from_str(&format!("\"{tag}\""))
                .expect("a version tag is a valid header value"),
        ),
        (header::CACHE_CONTROL, HeaderValue::from_static("no-cache")),
    ]
}

/// Whether the request already holds this version. `If-None-Match` compares
/// tags weakly, so a `W/` prefix does not matter, and `*` holds every tag.
pub(super) fn matches(request: &HeaderMap, tag: &str) -> bool {
    request
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|held| {
            held.trim() == "*" || held.split('"').skip(1).step_by(2).any(|held| held == tag)
        })
}

/// The answer to a request that already holds this version.
pub(super) fn not_modified(tag: &str) -> Response {
    (StatusCode::NOT_MODIFIED, headers(tag)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(if_none_match: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::IF_NONE_MATCH,
            HeaderValue::from_str(if_none_match).unwrap(),
        );
        headers
    }

    #[test]
    fn a_request_matches_a_tag_it_names_in_any_form_if_none_match_allows() {
        for held in ["\"v1\"", "W/\"v1\"", "\"elsewhere,1\", \"v1\"", "*", " * "] {
            assert!(matches(&request(held), "v1"), "{held}");
        }
        for held in ["\"v2\"", "\"v1-old\"", "v1", ""] {
            assert!(!matches(&request(held), "v1"), "{held}");
        }
        assert!(!matches(&HeaderMap::new(), "v1"));
    }

    #[test]
    fn an_unchanged_answer_carries_the_tag_without_a_body() {
        let response = not_modified("v1");

        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert_eq!(response.headers()[header::ETAG], "\"v1\"");
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-cache");
    }
}
