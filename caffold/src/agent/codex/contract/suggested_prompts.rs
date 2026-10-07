//! Codex's suggested next requests, taken out of the message that offers them.
//!
//! The document skills Codex installs for its own app tell the model to end an
//! answer with its next steps, one list item each, as
//! `- :codex-followup[Short action]{prompt="Complete request"}`. Markdown has
//! no such construct, so left alone each shows as raw text. A line holding one
//! whole suggestion becomes a suggested prompt and leaves the text. The same
//! syntax inside a sentence is being talked about, so it stays.

use crate::agent::SuggestedPrompt;

use super::code_ranges;

const OPENING: &str = ":codex-followup[";

/// `markdown` without the lines outside code that each hold one whole
/// suggestion, and those suggestions in the order they were written.
pub(super) fn take_suggested_prompts(markdown: String) -> (String, Vec<SuggestedPrompt>) {
    if !markdown.contains(OPENING) {
        return (markdown, Vec::new());
    }
    let code = code_ranges(&markdown);
    let mut kept = String::with_capacity(markdown.len());
    let mut prompts = Vec::new();
    let mut line_start = 0;
    for line in markdown.split_inclusive('\n') {
        // An indented code block starts after its indentation, so the line is
        // placed by its first character rather than its first byte.
        let first = line_start + line.len() - line.trim_start().len();
        line_start += line.len();
        if !code.iter().any(|range| range.contains(&first))
            && let Some(prompt) = suggestion(line)
        {
            prompts.push(prompt);
            continue;
        }
        kept.push_str(line);
    }
    if prompts.is_empty() {
        return (markdown, prompts);
    }
    kept.truncate(kept.trim_end().len());
    (kept, prompts)
}

/// The suggestion `line` holds, when nothing but a list marker comes with it.
fn suggestion(line: &str) -> Option<SuggestedPrompt> {
    let (label, attributes) = without_list_marker(line.trim())
        .strip_prefix(OPENING)?
        .strip_suffix('}')?
        .split_once("]{")?;
    let label = label.trim();
    let prompt = prompt_attribute(attributes)?;
    (!label.is_empty() && !prompt.trim().is_empty()).then(|| SuggestedPrompt {
        label: label.to_string(),
        prompt,
    })
}

fn without_list_marker(line: &str) -> &str {
    let ordinal = line.bytes().take_while(u8::is_ascii_digit).count();
    let marked = if ordinal == 0 {
        line.strip_prefix(['-', '*', '+'])
    } else {
        line[ordinal..].strip_prefix(['.', ')'])
    };
    marked
        .filter(|rest| rest.starts_with([' ', '\t']))
        .map_or(line, str::trim_start)
}

/// The `prompt` among `name="value"` pairs. A backslash escapes the quote or
/// backslash after it, so a request can quote something.
fn prompt_attribute(mut attributes: &str) -> Option<String> {
    let mut prompt = None;
    loop {
        attributes = attributes.trim_start_matches([' ', '\t']);
        if attributes.is_empty() {
            return prompt;
        }
        let (name, quoted) = attributes.split_once("=\"")?;
        if !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
        {
            return None;
        }
        let (value, rest) = quoted_value(quoted)?;
        if name == "prompt" {
            prompt = Some(value);
        }
        attributes = rest;
    }
}

/// The value a closing quote ends, and what follows that quote.
fn quoted_value(quoted: &str) -> Option<(String, &str)> {
    let mut value = String::new();
    let mut characters = quoted.char_indices();
    while let Some((index, character)) = characters.next() {
        match character {
            '"' => return Some((value, &quoted[index + 1..])),
            '\\' => {
                let (_, escaped) = characters.next()?;
                if !matches!(escaped, '"' | '\\') {
                    value.push('\\');
                }
                value.push(escaped);
            }
            _ => value.push(character),
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn suggested(label: &str, prompt: &str) -> SuggestedPrompt {
        SuggestedPrompt {
            label: label.to_string(),
            prompt: prompt.to_string(),
        }
    }

    #[test]
    fn a_closing_list_of_suggestions_leaves_the_answer_as_prompts() {
        let answer = concat!(
            "Created the report.\n",
            "\n",
            "- :codex-followup[Compare vendors]{prompt=\"Compare the two vendors' shared features.\"}\n",
            "- :codex-followup[Trace a payment]{prompt=\"Explain the card approval flow end to end.\"}\n",
            "- :codex-followup[Review test logs]{prompt=\"Summarize the failed and held test cases.\"}\n",
        );

        let (text, prompts) = take_suggested_prompts(answer.to_string());

        assert_eq!(text, "Created the report.");
        assert_eq!(
            prompts,
            vec![
                suggested(
                    "Compare vendors",
                    "Compare the two vendors' shared features."
                ),
                suggested(
                    "Trace a payment",
                    "Explain the card approval flow end to end."
                ),
                suggested(
                    "Review test logs",
                    "Summarize the failed and held test cases."
                ),
            ]
        );
    }

    #[test]
    fn any_list_marker_or_none_holds_a_suggestion() {
        let answer = concat!(
            "Done.\n",
            "- :codex-followup[Dash]{prompt=\"one\"}\n",
            "* :codex-followup[Star]{prompt=\"two\"}\n",
            "+ :codex-followup[Plus]{prompt=\"three\"}\n",
            "  1. :codex-followup[Ordered]{prompt=\"four\"}\n",
            "12) :codex-followup[Parenthesis]{prompt=\"five\"}\n",
            ":codex-followup[Bare]{prompt=\"six\"}\n",
            "\t-\t:codex-followup[Tabs]{prompt=\"seven\"}",
        );

        let (text, prompts) = take_suggested_prompts(answer.to_string());

        assert_eq!(text, "Done.");
        assert_eq!(
            prompts
                .iter()
                .map(|prompt| prompt.label.as_str())
                .collect::<Vec<_>>(),
            [
                "Dash",
                "Star",
                "Plus",
                "Ordered",
                "Parenthesis",
                "Bare",
                "Tabs"
            ]
        );
    }

    #[test]
    fn a_request_is_read_as_written_with_its_escapes() {
        let answer = concat!(
            r#"- :codex-followup[ Quote it ]{prompt="Explain the \"approval\" step, not C:\\temp or \d." label="ignored"}"#,
            "\n",
            r#"- :codex-followup[Braces]{id="x" prompt="Use {placeholders} and ]{ as written"}"#,
            "\n",
            r#"- :codex-followup[Code]{prompt="Run `cargo test` again."}"#,
        );

        let (text, prompts) = take_suggested_prompts(answer.to_string());

        assert_eq!(text, "");
        assert_eq!(
            prompts,
            vec![
                suggested(
                    "Quote it",
                    r#"Explain the "approval" step, not C:\temp or \d."#
                ),
                suggested("Braces", "Use {placeholders} and ]{ as written"),
                suggested("Code", "Run `cargo test` again."),
            ]
        );
    }

    #[test]
    fn a_suggestion_in_a_sentence_or_in_code_stays_in_the_text() {
        let answer = concat!(
            "End with `- :codex-followup[Name]{prompt=\"Request\"}` items.\n",
            "Write :codex-followup[Name]{prompt=\"Request\"} on its own line.\n",
            "\n",
            "```markdown\n",
            "- :codex-followup[Name]{prompt=\"Request\"}\n",
            "```\n",
            "\n",
            "    - :codex-followup[Indented code]{prompt=\"Request\"}\n",
        );

        assert_eq!(
            take_suggested_prompts(answer.to_string()),
            (answer.to_string(), Vec::new())
        );
    }

    #[test]
    fn a_line_that_is_not_one_whole_suggestion_stays_in_the_text() {
        for line in [
            "- :codex-followup[Name]{prompt=\"Request\"",
            "- :codex-followup[Name]{prompt=\"Request}",
            "- :codex-followup[Name]{prompt=\"Request\"} and more",
            "- :codex-followup[Name]{label=\"Request\"}",
            "- :codex-followup[ ]{prompt=\"Request\"}",
            "- :codex-followup[Name]{prompt=\" \"}",
            "- :codex-followup[Name]{prompt='Request'}",
            "- :codex-followup[Name]{bad name=\"x\" prompt=\"Request\"}",
            "- :codex-followup[Name]{prompt=\"Request\\\"}",
            "- :codex-followup[Name](prompt=\"Request\")",
            "-:codex-followup[Name]{prompt=\"Request\"}",
            "1.:codex-followup[Name]{prompt=\"Request\"}",
            "> - :codex-followup[Name]{prompt=\"Request\"}",
        ] {
            let answer = format!("Done.\n{line}");

            assert_eq!(
                take_suggested_prompts(answer.clone()),
                (answer, Vec::new()),
                "{line}"
            );
        }
    }

    #[test]
    fn suggestions_between_paragraphs_leave_the_rest_in_place() {
        let answer = concat!(
            "First part.\n",
            "- :codex-followup[Next]{prompt=\"Do the next thing.\"}\n",
            "Second part.\n",
            "\n",
        );

        let (text, prompts) = take_suggested_prompts(answer.to_string());

        assert_eq!(text, "First part.\nSecond part.");
        assert_eq!(prompts, vec![suggested("Next", "Do the next thing.")]);
    }
}
