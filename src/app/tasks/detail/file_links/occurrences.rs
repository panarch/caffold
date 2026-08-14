use std::ops::Range;

use pulldown_cmark::{Event, Options, Parser, Tag};

use super::{MAX_FILE_LINK_TARGET_BYTES, is_local_file_candidate};

const MAX_RECOVERED_LABEL_BYTES: usize = 4096;
const MAX_RECOVERED_NESTING: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LinkOccurrence {
    pub(super) target: String,
    pub(super) source_range: Range<usize>,
    pub(super) label: String,
    pub(super) recovered: bool,
}

pub(super) fn collect_link_occurrences(markdown: &str) -> Vec<LinkOccurrence> {
    let mut protected = Vec::new();
    let mut occurrences = Vec::new();

    for (event, range) in Parser::new_ext(markdown, Options::ENABLE_GFM).into_offset_iter() {
        match event {
            Event::Start(Tag::Link { dest_url, .. }) => {
                protected.push(range.clone());
                let target = dest_url.into_string();
                if target.len() > MAX_FILE_LINK_TARGET_BYTES || !is_local_file_candidate(&target) {
                    continue;
                }
                let source = markdown.get(range.clone()).unwrap_or_default();
                let Some(label) = link_label(source, &target) else {
                    continue;
                };
                occurrences.push(LinkOccurrence {
                    target,
                    source_range: range,
                    label,
                    recovered: false,
                });
            }
            Event::Start(Tag::Image { .. } | Tag::CodeBlock(_) | Tag::HtmlBlock)
            | Event::Code(_)
            | Event::Html(_)
            | Event::InlineHtml(_) => protected.push(range),
            _ => {}
        }
    }

    protected.sort_by_key(|range| (range.start, range.end));
    collect_recovered_links(markdown, &protected, &mut occurrences);
    occurrences
        .sort_by_key(|occurrence| (occurrence.source_range.start, occurrence.source_range.end));
    occurrences
}

fn collect_recovered_links(
    markdown: &str,
    protected: &[Range<usize>],
    occurrences: &mut Vec<LinkOccurrence>,
) {
    let bytes = markdown.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'['
            || byte_is_protected(index, protected)
            || is_escaped(bytes, index)
            || index
                .checked_sub(1)
                .is_some_and(|before| bytes[before] == b'!' && !is_escaped(bytes, before))
        {
            index += 1;
            continue;
        }

        let Some(candidate) = scan_inline_link(markdown, index) else {
            index += 1;
            continue;
        };
        if overlaps_protected(&candidate.source_range, protected) {
            index += 1;
            continue;
        }
        if !candidate
            .target
            .bytes()
            .any(|byte| byte.is_ascii_whitespace())
            || candidate.target.len() > MAX_FILE_LINK_TARGET_BYTES
            || !is_local_file_candidate(candidate.target.trim())
        {
            index = candidate.source_range.end;
            continue;
        }

        occurrences.push(LinkOccurrence {
            target: candidate.target.trim().to_string(),
            source_range: candidate.source_range.clone(),
            label: candidate.label.to_string(),
            recovered: true,
        });
        index = candidate.source_range.end;
    }
}

struct ScannedInlineLink<'a> {
    source_range: Range<usize>,
    label: &'a str,
    target: &'a str,
}

fn scan_inline_link(markdown: &str, start: usize) -> Option<ScannedInlineLink<'_>> {
    let label_end = scan_label_end(markdown, start)?;
    let open = label_end.checked_add(1)?;
    if markdown.as_bytes().get(open) != Some(&b'(') {
        return None;
    }
    let target_start = open + 1;
    let target_end = scan_destination_end(markdown, target_start)?;
    Some(ScannedInlineLink {
        source_range: start..target_end + 1,
        label: markdown.get(start + 1..label_end)?,
        target: markdown.get(target_start..target_end)?,
    })
}

fn link_label(source: &str, target: &str) -> Option<String> {
    if source.starts_with('[') {
        let end = scan_label_end(source, 0)?;
        return source.get(1..end).map(str::to_string);
    }
    source.starts_with('<').then(|| escape_label(target))
}

fn scan_label_end(source: &str, start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    if bytes.get(start) != Some(&b'[') {
        return None;
    }
    let limit = start
        .saturating_add(MAX_RECOVERED_LABEL_BYTES + 2)
        .min(bytes.len());
    let mut depth = 1usize;
    let mut index = start + 1;
    while index < limit {
        match bytes[index] {
            b'\\' => index = (index + 2).min(limit),
            b'`' => index = skip_code_span(bytes, index, limit),
            b'[' => {
                depth += 1;
                if depth > MAX_RECOVERED_NESTING {
                    return None;
                }
                index += 1;
            }
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    None
}

fn skip_code_span(bytes: &[u8], start: usize, limit: usize) -> usize {
    let delimiter_len = bytes[start..limit]
        .iter()
        .take_while(|byte| **byte == b'`')
        .count();
    let mut index = start + delimiter_len;
    while index < limit {
        if bytes[index] != b'`' {
            index += 1;
            continue;
        }
        let run = bytes[index..limit]
            .iter()
            .take_while(|byte| **byte == b'`')
            .count();
        if run == delimiter_len {
            return index + run;
        }
        index += run;
    }
    start + delimiter_len
}

fn scan_destination_end(source: &str, start: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let limit = start
        .saturating_add(MAX_FILE_LINK_TARGET_BYTES + 1)
        .min(bytes.len());
    let mut depth = 1usize;
    let mut index = start;
    while index < limit {
        match bytes[index] {
            b'\n' | b'\r' => return None,
            b'\\' => index = (index + 2).min(limit),
            b'(' => {
                depth += 1;
                if depth > MAX_RECOVERED_NESTING {
                    return None;
                }
                index += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(index);
                }
                index += 1;
            }
            _ => index += 1,
        }
    }
    None
}

fn is_escaped(bytes: &[u8], index: usize) -> bool {
    let mut backslashes = 0;
    let mut cursor = index;
    while cursor > 0 && bytes[cursor - 1] == b'\\' {
        backslashes += 1;
        cursor -= 1;
    }
    backslashes % 2 == 1
}

fn byte_is_protected(index: usize, protected: &[Range<usize>]) -> bool {
    protected
        .iter()
        .any(|range| range.start <= index && index < range.end)
}

fn overlaps_protected(candidate: &Range<usize>, protected: &[Range<usize>]) -> bool {
    protected
        .iter()
        .any(|range| candidate.start < range.end && range.start < candidate.end)
}

fn escape_label(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('[', "\\[")
        .replace(']', "\\]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_normal_and_raw_space_occurrences_in_source_order() {
        let markdown = concat!(
            "🙂 [normal](src/lib.rs#L12) ",
            "[policy](/Users/name/Library/Application Support/project/policy.md:22) ",
            "[again](src/lib.rs#L12)"
        );

        let occurrences = collect_link_occurrences(markdown);

        assert_eq!(occurrences.len(), 3);
        assert_eq!(occurrences[0].target, "src/lib.rs#L12");
        assert!(!occurrences[0].recovered);
        assert_eq!(
            occurrences[1].target,
            "/Users/name/Library/Application Support/project/policy.md:22"
        );
        assert!(occurrences[1].recovered);
        assert_eq!(occurrences[1].label, "policy");
        assert_eq!(
            &markdown[occurrences[1].source_range.clone()],
            "[policy](/Users/name/Library/Application Support/project/policy.md:22)"
        );
        assert_ne!(occurrences[0].source_range, occurrences[2].source_range);
    }

    #[test]
    fn recovers_balanced_parentheses_but_not_non_link_markdown_contexts() {
        let markdown = concat!(
            "[draft](/tmp/My Project (draft)/policy.md:12)\n",
            "![image](/tmp/My Image.png)\n",
            "`[code](/tmp/My Project/code.rs:3)`\n",
            "\\[escaped](/tmp/My Project/escaped.rs:4)\n",
            "```text\n[fenced](/tmp/My Project/fenced.rs:5)\n```\n",
            "<div>\n[html](/tmp/My Project/html.rs:6)\n</div>"
        );

        let occurrences = collect_link_occurrences(markdown);

        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].label, "draft");
        assert_eq!(
            occurrences[0].target,
            "/tmp/My Project (draft)/policy.md:12"
        );
    }

    #[test]
    fn leaves_external_multiline_and_unbalanced_forms_unrecovered() {
        let markdown = concat!(
            "[external](https://example.com/a b)\n",
            "[multiline](/tmp/My\nProject/a.rs:2)\n",
            "[unbalanced](/tmp/My Project/a.rs:2"
        );

        assert!(collect_link_occurrences(markdown).is_empty());
    }

    #[test]
    fn bounds_recovered_labels_destinations_and_nesting() {
        let long_label = "a".repeat(MAX_RECOVERED_LABEL_BYTES + 1);
        let long_target = "a".repeat(MAX_FILE_LINK_TARGET_BYTES + 1);
        let nested = "(".repeat(MAX_RECOVERED_NESTING + 1);
        let unnested = ")".repeat(MAX_RECOVERED_NESTING + 1);
        let markdown = format!(
            "[{long_label}](/tmp/My Project/a.rs) [large](/tmp/{long_target} file.rs) [nested](/tmp/My Project/{nested}a.rs{unnested})"
        );

        assert!(collect_link_occurrences(&markdown).is_empty());
    }

    #[test]
    fn rewrites_reference_links_with_their_original_label_markdown() {
        let markdown = "[**policy**][policy]\n\n[policy]: docs/policy.md#L22";

        let occurrences = collect_link_occurrences(markdown);

        assert_eq!(occurrences.len(), 1);
        assert_eq!(occurrences[0].label, "**policy**");
        assert_eq!(occurrences[0].target, "docs/policy.md#L22");
        assert_eq!(occurrences[0].label, "**policy**");
    }
}
