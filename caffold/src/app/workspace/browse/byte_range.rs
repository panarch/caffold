//! Which bytes of a file a request asks for (RFC 9110 §14). A viewer fetches a
//! large file one part at a time with `Range: bytes=first-last`; a request this
//! does not answer as a part is answered with the whole file, as the standard
//! allows.

use axum::http::{HeaderMap, header};

/// The bytes a request asks for, out of a file of a known size and version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum RequestedBytes {
    Whole,
    /// Bytes `first` through `last`, both inside the file.
    Part {
        first: u64,
        last: u64,
    },
    /// A range that starts past the end of the file, or any range of an empty
    /// one.
    OutOfRange,
}

/// Reads `Range` and `If-Range` for a file of `size` bytes whose version is
/// `tag`. One range of the `bytes` unit is answered as a part. A list of
/// ranges, another unit, or a malformed value asks for the whole file, and so
/// does an `If-Range` that does not name this version, so a part of another
/// version is never sent.
pub(super) fn requested(request: &HeaderMap, size: u64, tag: &str) -> RequestedBytes {
    let Some(range) = request
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
    else {
        return RequestedBytes::Whole;
    };
    if !if_range_holds(request, tag) {
        return RequestedBytes::Whole;
    }
    requested_part(range, size).unwrap_or(RequestedBytes::Whole)
}

/// `If-Range` holds only for this version under strong comparison: a weak tag
/// never does, and neither does a date, as these files send none.
fn if_range_holds(request: &HeaderMap, tag: &str) -> bool {
    request.get(header::IF_RANGE).is_none_or(|value| {
        value
            .to_str()
            .is_ok_and(|value| value.trim() == format!("\"{tag}\""))
    })
}

// `first-last`, `first-`, or `-length` counted from the end; `None` for
// anything else.
fn requested_part(range: &str, size: u64) -> Option<RequestedBytes> {
    let (unit, set) = range.split_once('=')?;
    if !unit.trim().eq_ignore_ascii_case("bytes") || set.contains(',') {
        return None;
    }
    let (first, last) = set.trim().split_once('-')?;
    let last_byte = size.checked_sub(1);

    if first.is_empty() {
        let length = digits(last)?;
        return Some(match last_byte {
            Some(last_byte) if length > 0 => RequestedBytes::Part {
                first: size.saturating_sub(length),
                last: last_byte,
            },
            _ => RequestedBytes::OutOfRange,
        });
    }

    let first = digits(first)?;
    let last = if last.is_empty() {
        None
    } else {
        Some(digits(last)?)
    };
    if last.is_some_and(|last| last < first) {
        return None;
    }
    Some(match last_byte {
        Some(last_byte) if first <= last_byte => RequestedBytes::Part {
            first,
            last: last.map_or(last_byte, |last| last.min(last_byte)),
        },
        _ => RequestedBytes::OutOfRange,
    })
}

fn digits(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderValue;

    use super::*;

    fn headers(pairs: &[(header::HeaderName, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.insert(name, HeaderValue::from_str(value).unwrap());
        }
        headers
    }

    fn range(value: &str, size: u64) -> RequestedBytes {
        requested(&headers(&[(header::RANGE, value)]), size, "v1")
    }

    fn part(first: u64, last: u64) -> RequestedBytes {
        RequestedBytes::Part { first, last }
    }

    #[test]
    fn a_single_byte_range_is_answered_as_a_part_inside_the_file() {
        for (value, expected) in [
            ("bytes=0-99", part(0, 99)),
            ("bytes=100-", part(100, 999)),
            ("bytes=-100", part(900, 999)),
            ("bytes=999-999", part(999, 999)),
            ("bytes=900-5000", part(900, 999)),
            ("bytes=-5000", part(0, 999)),
            ("BYTES = 0-9", part(0, 9)),
            ("bytes= 0-9 ", part(0, 9)),
        ] {
            assert_eq!(range(value, 1000), expected, "{value}");
        }
    }

    #[test]
    fn a_range_that_starts_past_the_end_is_out_of_range() {
        for value in ["bytes=1000-", "bytes=1000-2000", "bytes=-0"] {
            assert_eq!(range(value, 1000), RequestedBytes::OutOfRange, "{value}");
        }
        for value in ["bytes=0-99", "bytes=0-", "bytes=-5"] {
            assert_eq!(range(value, 0), RequestedBytes::OutOfRange, "{value}");
        }
    }

    #[test]
    fn a_range_answered_otherwise_asks_for_the_whole_file() {
        for value in [
            "bytes=0-1,5-9",
            "items=0-9",
            "bytes=9-0",
            "bytes=abc",
            "bytes=-",
            "bytes=1-x",
            "bytes=+1-9",
            "bytes 0-9",
            "bytes=99999999999999999999-",
        ] {
            assert_eq!(range(value, 1000), RequestedBytes::Whole, "{value}");
        }
        assert_eq!(
            requested(&HeaderMap::new(), 1000, "v1"),
            RequestedBytes::Whole
        );
    }

    #[test]
    fn if_range_lets_a_part_through_only_for_this_version() {
        let with_if_range =
            |if_range| headers(&[(header::RANGE, "bytes=0-9"), (header::IF_RANGE, if_range)]);

        assert_eq!(requested(&with_if_range("\"v1\""), 1000, "v1"), part(0, 9));
        for if_range in ["\"v2\"", "W/\"v1\"", "v1", "Wed, 21 Oct 2015 07:28:00 GMT"] {
            assert_eq!(
                requested(&with_if_range(if_range), 1000, "v1"),
                RequestedBytes::Whole,
                "{if_range}"
            );
        }
        assert_eq!(
            requested(&headers(&[(header::IF_RANGE, "\"v1\"")]), 1000, "v1"),
            RequestedBytes::Whole
        );
    }
}
