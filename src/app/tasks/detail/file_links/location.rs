use percent_encoding::percent_decode_str;
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct FileCoordinates {
    pub(super) start_line: u32,
    pub(super) column: Option<u32>,
    pub(super) end_line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileLocation {
    pub(super) path: String,
    pub(super) coordinates: Option<FileCoordinates>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileLocationPlan {
    pub(super) exact: FileLocation,
    pub(super) fallback: LocationFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum LocationFallback {
    None,
    Located(FileLocation),
    Malformed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum FileLocationFailure {
    InvalidTarget,
    UnknownScheme,
}

pub(super) fn parse_file_location(
    target: &str,
    recovered: bool,
) -> Result<FileLocationPlan, FileLocationFailure> {
    let target = target.trim();
    validate_raw_target(target)?;
    if recovered && target.contains(['\'', '"']) {
        return Err(FileLocationFailure::InvalidTarget);
    }

    if target
        .get(..5)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("file:"))
    {
        return parse_file_url(target);
    }
    if has_unknown_scheme(target) {
        return Err(FileLocationFailure::UnknownScheme);
    }

    let exact_path = decode_path(target)?;
    let fallback = match parse_literal_suffix(target) {
        ParsedSuffix::None => LocationFallback::None,
        ParsedSuffix::Malformed => LocationFallback::Malformed,
        ParsedSuffix::Located {
            raw_path,
            coordinates,
        } => LocationFallback::Located(FileLocation {
            path: decode_path(raw_path)?,
            coordinates: Some(coordinates),
        }),
    };
    Ok(FileLocationPlan {
        exact: FileLocation {
            path: exact_path,
            coordinates: None,
        },
        fallback,
    })
}

fn parse_file_url(target: &str) -> Result<FileLocationPlan, FileLocationFailure> {
    let url = Url::parse(target).map_err(|_| FileLocationFailure::InvalidTarget)?;
    if url.scheme() != "file"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url
            .host_str()
            .is_some_and(|host| !host.is_empty() && !host.eq_ignore_ascii_case("localhost"))
    {
        return Err(FileLocationFailure::InvalidTarget);
    }

    let coordinates = url
        .fragment()
        .map(parse_hash_coordinates)
        .transpose()
        .map_err(|()| FileLocationFailure::InvalidTarget)?;
    let path = url
        .to_file_path()
        .map_err(|()| FileLocationFailure::InvalidTarget)?
        .into_os_string()
        .into_string()
        .map_err(|_| FileLocationFailure::InvalidTarget)?;
    validate_decoded_path(&path)?;

    Ok(FileLocationPlan {
        exact: FileLocation { path, coordinates },
        fallback: LocationFallback::None,
    })
}

fn validate_raw_target(target: &str) -> Result<(), FileLocationFailure> {
    if target.is_empty()
        || target.chars().any(char::is_control)
        || !has_valid_percent_encoding(target)
    {
        return Err(FileLocationFailure::InvalidTarget);
    }
    Ok(())
}

fn has_valid_percent_encoding(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            index += 1;
            continue;
        }
        if bytes
            .get(index + 1)
            .is_none_or(|byte| !byte.is_ascii_hexdigit())
            || bytes
                .get(index + 2)
                .is_none_or(|byte| !byte.is_ascii_hexdigit())
        {
            return false;
        }
        index += 3;
    }
    true
}

fn decode_path(value: &str) -> Result<String, FileLocationFailure> {
    let decoded = percent_decode_str(value)
        .decode_utf8()
        .map_err(|_| FileLocationFailure::InvalidTarget)?
        .into_owned();
    validate_decoded_path(&decoded)?;
    Ok(decoded)
}

fn validate_decoded_path(path: &str) -> Result<(), FileLocationFailure> {
    if path.is_empty() || path.chars().any(char::is_control) {
        return Err(FileLocationFailure::InvalidTarget);
    }
    Ok(())
}

fn has_unknown_scheme(target: &str) -> bool {
    let Some(colon) = target.find(':') else {
        return false;
    };
    let scheme = &target[..colon];
    if !is_uri_scheme(scheme) {
        return false;
    }
    let suffix = &target[colon + 1..];
    !looks_like_coordinate_suffix(suffix)
}

fn is_uri_scheme(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && chars.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')
        })
}

fn looks_like_coordinate_suffix(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b':' | b'-'))
}

enum ParsedSuffix<'a> {
    None,
    Located {
        raw_path: &'a str,
        coordinates: FileCoordinates,
    },
    Malformed,
}

fn parse_literal_suffix(target: &str) -> ParsedSuffix<'_> {
    if let Some(marker) = target.rfind("#L") {
        let raw_path = &target[..marker];
        let suffix = &target[marker + 2..];
        return match parse_hash_coordinates(suffix) {
            Ok(coordinates) if !raw_path.is_empty() => ParsedSuffix::Located {
                raw_path,
                coordinates,
            },
            _ => ParsedSuffix::Malformed,
        };
    }

    let Some(last_colon) = target.rfind(':') else {
        return ParsedSuffix::None;
    };
    let before = &target[..last_colon];
    let suffix = &target[last_colon + 1..];

    if suffix.bytes().all(|byte| byte.is_ascii_digit()) && !suffix.is_empty() {
        if let Some(previous_colon) = before.rfind(':') {
            let line_text = &before[previous_colon + 1..];
            if line_text.bytes().all(|byte| byte.is_ascii_digit()) && !line_text.is_empty() {
                return match (
                    positive_u32(line_text),
                    positive_u32(suffix),
                    &before[..previous_colon],
                ) {
                    (Some(start_line), Some(column), raw_path) if !raw_path.is_empty() => {
                        ParsedSuffix::Located {
                            raw_path,
                            coordinates: FileCoordinates {
                                start_line,
                                column: Some(column),
                                end_line: None,
                            },
                        }
                    }
                    _ => ParsedSuffix::Malformed,
                };
            }
        }
        return match (positive_u32(suffix), before) {
            (Some(start_line), raw_path) if !raw_path.is_empty() => ParsedSuffix::Located {
                raw_path,
                coordinates: FileCoordinates {
                    start_line,
                    column: None,
                    end_line: None,
                },
            },
            _ => ParsedSuffix::Malformed,
        };
    }

    if let Some((start, end)) = suffix.split_once('-') {
        if suffix.matches('-').count() != 1 {
            return ParsedSuffix::Malformed;
        }
        return match (positive_u32(start), positive_u32(end), before) {
            (Some(start_line), Some(end_line), raw_path)
                if !raw_path.is_empty() && end_line >= start_line =>
            {
                ParsedSuffix::Located {
                    raw_path,
                    coordinates: FileCoordinates {
                        start_line,
                        column: None,
                        end_line: Some(end_line),
                    },
                }
            }
            _ => ParsedSuffix::Malformed,
        };
    }

    if suffix.is_empty()
        || suffix.starts_with(|character: char| character.is_ascii_digit() || character == '-')
        || before.rsplit_once(':').is_some_and(|(_, line)| {
            !line.is_empty() && line.bytes().all(|byte| byte.is_ascii_digit())
        })
    {
        ParsedSuffix::Malformed
    } else {
        ParsedSuffix::None
    }
}

fn parse_hash_coordinates(value: &str) -> Result<FileCoordinates, ()> {
    let value = value.strip_prefix('L').unwrap_or(value);
    if let Some((start, end)) = value.split_once("-L") {
        if value.matches("-L").count() != 1 {
            return Err(());
        }
        let start_line = positive_u32(start).ok_or(())?;
        let end_line = positive_u32(end)
            .filter(|end| *end >= start_line)
            .ok_or(())?;
        return Ok(FileCoordinates {
            start_line,
            column: None,
            end_line: Some(end_line),
        });
    }
    Ok(FileCoordinates {
        start_line: positive_u32(value).ok_or(())?,
        column: None,
        end_line: None,
    })
}

fn positive_u32(value: &str) -> Option<u32> {
    value
        .parse::<u32>()
        .ok()
        .filter(|coordinate| *coordinate > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_supported_location_corpus() {
        struct Case<'a> {
            target: &'a str,
            path: &'a str,
            coordinates: Option<FileCoordinates>,
            fallback: bool,
        }
        let line = |start_line| FileCoordinates {
            start_line,
            column: None,
            end_line: None,
        };
        let cases = [
            Case {
                target: "path/to/file.rs",
                path: "path/to/file.rs",
                coordinates: None,
                fallback: false,
            },
            Case {
                target: "file.rs:12",
                path: "file.rs",
                coordinates: Some(line(12)),
                fallback: true,
            },
            Case {
                target: "./file.rs:12:5",
                path: "./file.rs",
                coordinates: Some(FileCoordinates {
                    start_line: 12,
                    column: Some(5),
                    end_line: None,
                }),
                fallback: true,
            },
            Case {
                target: "../file.rs:12-20",
                path: "../file.rs",
                coordinates: Some(FileCoordinates {
                    start_line: 12,
                    column: None,
                    end_line: Some(20),
                }),
                fallback: true,
            },
            Case {
                target: "/tmp/file.rs",
                path: "/tmp/file.rs",
                coordinates: None,
                fallback: false,
            },
            Case {
                target: "/tmp/file.rs#L12",
                path: "/tmp/file.rs",
                coordinates: Some(line(12)),
                fallback: true,
            },
            Case {
                target: "경로/괄호 (초안)/file.rs#L12-L20",
                path: "경로/괄호 (초안)/file.rs",
                coordinates: Some(FileCoordinates {
                    start_line: 12,
                    column: None,
                    end_line: Some(20),
                }),
                fallback: true,
            },
            Case {
                target: "space%20name.rs:12",
                path: "space name.rs",
                coordinates: Some(line(12)),
                fallback: true,
            },
            Case {
                target: "file:///tmp/space%20name.rs#L12",
                path: "/tmp/space name.rs",
                coordinates: Some(line(12)),
                fallback: false,
            },
            Case {
                target: "file:///tmp/space%20name.rs",
                path: "/tmp/space name.rs",
                coordinates: None,
                fallback: false,
            },
            Case {
                target: "file:///tmp/space%20name.rs#L12-L20",
                path: "/tmp/space name.rs",
                coordinates: Some(FileCoordinates {
                    start_line: 12,
                    column: None,
                    end_line: Some(20),
                }),
                fallback: false,
            },
        ];

        for case in cases {
            let plan = parse_file_location(case.target, false).unwrap();
            let location = if case.fallback {
                match plan.fallback {
                    LocationFallback::Located(location) => location,
                    other => panic!("unexpected fallback for {}: {other:?}", case.target),
                }
            } else {
                plan.exact
            };
            assert_eq!(location.path, case.path, "{}", case.target);
            assert_eq!(location.coordinates, case.coordinates, "{}", case.target);
        }
    }

    #[test]
    fn preserves_encoded_delimiters_as_filename_data() {
        let cases = [
            ("report%3A17", "report:17"),
            ("report%23L12", "report#L12"),
            ("file:///tmp/report%23L12", "/tmp/report#L12"),
        ];

        for (target, expected) in cases {
            let plan = parse_file_location(target, false).unwrap();
            assert_eq!(plan.exact.path, expected);
            assert_eq!(plan.exact.coordinates, None);
            assert_eq!(plan.fallback, LocationFallback::None);
        }
    }

    #[test]
    fn identifies_malformed_coordinates_without_discarding_the_exact_filename() {
        let cases = [
            "file.rs:0",
            "file.rs:0:5",
            "file.rs:-1",
            "file.rs:12:0",
            "file.rs:12:-1",
            "file.rs:12:4294967296",
            "file.rs:12:",
            "file.rs:12-",
            "file.rs:20-12",
            "file.rs:4294967296",
            "file.rs#L0",
            "file.rs#L4294967296",
            "file.rs#L12-L",
            "file.rs#L12-L4294967296",
            "file.rs#L20-L12",
        ];

        for target in cases {
            let plan = parse_file_location(target, false).unwrap();
            assert_eq!(plan.exact.path, target, "{target}");
            assert_eq!(plan.fallback, LocationFallback::Malformed, "{target}");
        }
    }

    #[test]
    fn rejects_unknown_schemes_and_unsafe_encodings() {
        let cases = [
            "vscode://file/tmp/a.rs:12",
            "javascript:alert(1)",
            "file://remotehost/tmp/a.rs",
            "file:///tmp/a.rs?query=1",
            "file:///tmp/a.rs#not-a-line",
            "bad%2",
            "bad%GG",
            "bad%FFpath",
            "bad%00path",
            "bad\0path",
        ];

        for target in cases {
            assert!(parse_file_location(target, false).is_err(), "{target}");
        }
    }

    #[test]
    fn raw_space_recovery_does_not_consume_markdown_titles() {
        assert_eq!(
            parse_file_location("/tmp/My Project/file.rs \"title\"", true),
            Err(FileLocationFailure::InvalidTarget)
        );
    }
}
