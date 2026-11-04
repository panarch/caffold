//! The `Content-Disposition` that makes a browser save a response as a file
//! under a given name instead of showing it.

use axum::http::HeaderValue;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

/// What the `filename*` parameter of a download keeps as it is. Every other
/// byte of the UTF-8 name is percent-encoded.
const FILENAME_UNRESERVED: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

// `filename*` carries the exact name; the plain `filename` is an ASCII stand-in
// for a client that reads only that one.
pub(super) fn attachment_disposition(name: &str) -> HeaderValue {
    let ascii_name: String = name
        .chars()
        .map(|character| match character {
            ' ' | '!' | '#'..='[' | ']'..='~' => character,
            _ => '_',
        })
        .collect();
    let encoded_name = utf8_percent_encode(name, FILENAME_UNRESERVED);
    HeaderValue::from_str(&format!(
        "attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_name}"
    ))
    .expect("a download disposition holds only visible ASCII")
}
