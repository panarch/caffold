//! Codex's inline file citations, read as links to the files they cite.
//!
//! The document skills Codex installs for its own app tell the model to cite a
//! file it read or made as `:codex-file-citation{path="…" purpose="…"}` inside
//! the answer's prose. Markdown has no such construct, so left alone it shows
//! as raw text. A Markdown link to a local file already opens that file in
//! Integrated Review, so a citation becomes one, named after the file. Only the
//! path is read: the prose already says what the file was cited for, and the
//! pages and slides a citation can name are in Word and PowerPoint files
//! Integrated Review cannot show.

use std::path::Path;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};

use super::code_ranges;

const OPENING: &str = ":codex-file-citation{";

/// What a link target keeps as written. Encoding the rest lets the path decode
/// back exactly, and keeps a `:` or `#` in a file name from reading as a line.
const TARGET_KEEPS: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~')
    .remove(b'/');

/// `markdown` with each whole citation outside code replaced by a link to the
/// file it cites. Anything else that starts like a citation stays as written.
pub(super) fn link_cited_files(markdown: String) -> String {
    if !markdown.contains(OPENING) {
        return markdown;
    }
    let code = code_ranges(&markdown);
    let mut linked = String::with_capacity(markdown.len());
    let mut copied = 0;
    for (start, _) in markdown.match_indices(OPENING) {
        if code.iter().any(|range| range.contains(&start)) {
            continue;
        }
        let Some((path, end)) = citation(&markdown, start + OPENING.len()) else {
            continue;
        };
        linked.push_str(&markdown[copied..start]);
        linked.push_str(&file_link(path));
        copied = end;
    }
    linked.push_str(&markdown[copied..]);
    linked
}

/// The cited path and the end of the citation whose attributes begin at
/// `start`, when they are `name="value"` pairs closed on the same line.
fn citation(markdown: &str, start: usize) -> Option<(&str, usize)> {
    let mut rest = &markdown[start..];
    let mut path = None;
    loop {
        rest = rest.trim_start_matches([' ', '\t']);
        if let Some(after) = rest.strip_prefix('}') {
            let path = path.filter(|path: &&str| !path.is_empty())?;
            return Some((path, markdown.len() - after.len()));
        }
        let (name, quoted) = rest.split_once("=\"")?;
        let (value, after) = quoted.split_once('"')?;
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
            || value.contains('\n')
        {
            return None;
        }
        if name == "path" {
            path = Some(value.trim());
        }
        rest = after;
    }
}

fn file_link(path: &str) -> String {
    let name = Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(path);
    let mut label = String::with_capacity(name.len());
    for character in name.chars() {
        if matches!(
            character,
            '\\' | '[' | ']' | '`' | '*' | '_' | '<' | '&' | '~' | '|'
        ) {
            label.push('\\');
        }
        label.push(character);
    }
    format!("[{label}]({})", utf8_percent_encode(path, TARGET_KEEPS))
}

#[cfg(test)]
mod tests {
    use percent_encoding::percent_decode_str;
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

    use super::*;

    #[test]
    fn a_citation_becomes_a_link_named_after_the_file() {
        let answer = r#"Created :codex-file-citation{path="/abs/path/report.pdf" purpose="output"}, with the completed analysis."#;

        assert_eq!(
            link_cited_files(answer.to_string()),
            "Created [report.pdf](/abs/path/report.pdf), with the completed analysis."
        );
    }

    #[test]
    fn every_citation_in_an_answer_becomes_a_link() {
        let answer = concat!(
            "The question only starts on page 21 of 35. ",
            r#":codex-file-citation{path="/Users/me/lecture/Open Source Basics - slides.pdf" purpose="source"}"#,
            "\n\nThere are three tracks. ",
            r#":codex-file-citation{path="/Users/me/lecture/semester_orientation.pdf" purpose="source"}"#,
        );

        let linked = link_cited_files(answer.to_string());

        assert_eq!(
            links(&linked),
            vec![
                (
                    "Open Source Basics - slides.pdf".to_string(),
                    "/Users/me/lecture/Open Source Basics - slides.pdf".to_string(),
                ),
                (
                    "semester_orientation.pdf".to_string(),
                    "/Users/me/lecture/semester_orientation.pdf".to_string(),
                ),
            ]
        );
        assert!(linked.starts_with("The question only starts on page 21 of 35. ["));
        assert!(linked.contains(")\n\nThere are three tracks. ["));
        assert!(!linked.contains(OPENING));
    }

    #[test]
    fn a_link_names_and_opens_exactly_the_cited_file() {
        for name in [
            "notice (no. 2026-0881).pdf",
            "notes:12.pdf",
            "report#L3.pdf",
            "100% done.pdf",
            "[draft] *v2*_final_ <b>&amp; ~~x~~ | `y` \\.pdf",
        ] {
            let path = format!("/tmp/notices/{name}");
            let answer = format!(r#"See :codex-file-citation{{path="{path}" purpose="source"}}."#);

            assert_eq!(
                links(&link_cited_files(answer)),
                vec![(name.to_string(), path.clone())],
                "{name}"
            );
        }
    }

    #[test]
    fn what_a_citation_was_for_and_where_in_the_file_change_nothing() {
        let plain = link_cited_files(
            r#"See :codex-file-citation{path="/abs/path/deck.pptx" purpose="source"}."#.to_string(),
        );
        for located in [
            r#"See :codex-file-citation{path="/abs/path/deck.pptx" purpose="output" artifact_kind="presentation" slide_number="1" slide_id="sl/gs5z1kshq0xv" object_id="ch/pz9t1r3ka8vn" label="ARR by segment chart"}."#,
            r#"See :codex-file-citation{artifact_kind="document" path="/abs/path/deck.pptx" page_number="4"}."#,
        ] {
            assert_eq!(link_cited_files(located.to_string()), plain, "{located}");
        }
    }

    #[test]
    fn a_citation_inside_code_is_shown_as_written() {
        let answer = concat!(
            "Use `:codex-file-citation{path=\"/abs/path/report.pdf\" purpose=\"output\"}` inline.\n\n",
            "```markdown\n",
            "Created :codex-file-citation{path=\"/abs/path/report.pdf\" purpose=\"output\"}.\n",
            "```\n",
        );

        assert_eq!(link_cited_files(answer.to_string()), answer);
    }

    #[test]
    fn something_that_only_starts_like_a_citation_stays_as_written() {
        for answer in [
            "Place :codex-file-citation{...} inline in prose.",
            r#"Cite :codex-file-citation{purpose="source"} once."#,
            r#"Cite :codex-file-citation{path="" purpose="source"} once."#,
            r#"Cite :codex-file-citation{path=" " purpose="source"} once."#,
            "Cite :codex-file-citation{path=\"/abs/path/report.pdf\" purpose=\"source\"\n} once.",
            "Cite :codex-file-citation{path=\"/abs/path/\nreport.pdf\"} once.",
            "Cite :codex-file-citation{path=\"/abs/path/report.pdf\"\npurpose=\"source\"} once.",
            r#"Cite :codex-file-citation{path="/abs/path/report.pdf" purpose="source" once."#,
            r#"Cite :codex-file-citation{path='/abs/path/report.pdf'} once."#,
        ] {
            assert_eq!(link_cited_files(answer.to_string()), answer);
        }
    }

    #[test]
    fn a_broken_citation_leaves_the_next_whole_one_to_be_linked() {
        let answer = concat!(
            "Broken :codex-file-citation{...} and whole ",
            r#":codex-file-citation{path="/abs/path/report.pdf" purpose="source"}."#,
        );

        assert_eq!(
            link_cited_files(answer.to_string()),
            "Broken :codex-file-citation{...} and whole [report.pdf](/abs/path/report.pdf)."
        );
    }

    #[test]
    fn a_path_that_itself_reads_like_a_citation_is_linked_once() {
        let answer =
            r#"See :codex-file-citation{path="/abs/:codex-file-citation{x.pdf" purpose="source"}."#;

        assert_eq!(
            links(&link_cited_files(answer.to_string())),
            vec![(
                ":codex-file-citation{x.pdf".to_string(),
                "/abs/:codex-file-citation{x.pdf".to_string(),
            )]
        );
    }

    /// Each link as the conversation renders it: its visible text and the path
    /// its target decodes to.
    fn links(markdown: &str) -> Vec<(String, String)> {
        let mut links = Vec::new();
        let mut open: Option<(String, String)> = None;
        let options = Options::ENABLE_GFM | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES;
        for event in Parser::new_ext(markdown, options) {
            match event {
                Event::Start(Tag::Link { dest_url, .. }) => {
                    let target = percent_decode_str(&dest_url).decode_utf8().unwrap();
                    open = Some((String::new(), target.into_owned()));
                }
                Event::Text(text) => {
                    if let Some((label, _)) = open.as_mut() {
                        label.push_str(&text);
                    }
                }
                Event::Code(_)
                | Event::InlineHtml(_)
                | Event::Start(Tag::Emphasis | Tag::Strong | Tag::Strikethrough) => {
                    assert!(open.is_none(), "a file name rendered as markup: {markdown}");
                }
                Event::End(TagEnd::Link) => links.extend(open.take()),
                _ => {}
            }
        }
        links
    }
}
