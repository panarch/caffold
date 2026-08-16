use unicode_segmentation::UnicodeSegmentation;

const PREFIX: &str = "[REQ] ";
const PREVIEW_GRAPHEMES: usize = 32;
const WORD_BOUNDARY_WINDOW: usize = 8;

pub(super) fn from_prompt(prompt: &str) -> Option<String> {
    let normalized = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }

    let graphemes = normalized.graphemes(true).collect::<Vec<_>>();
    if graphemes.len() <= PREVIEW_GRAPHEMES {
        return Some(format!("{PREFIX}{normalized}"));
    }

    let minimum_word_boundary = PREVIEW_GRAPHEMES - WORD_BOUNDARY_WINDOW;
    let preview_end = graphemes[..PREVIEW_GRAPHEMES]
        .iter()
        .rposition(|grapheme| *grapheme == " ")
        .filter(|index| *index >= minimum_word_boundary)
        .unwrap_or(PREVIEW_GRAPHEMES);
    let preview = graphemes[..preview_end].concat();
    Some(format!("{PREFIX}{preview}…"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_prompt_has_no_request_name() {
        assert_eq!(from_prompt(" \n\t "), None);
    }

    #[test]
    fn short_prompt_is_prefixed_and_whitespace_is_normalized() {
        assert_eq!(
            from_prompt("  Review\n\tthis   task  ").as_deref(),
            Some("[REQ] Review this task")
        );
    }

    #[test]
    fn exact_limit_has_no_ellipsis() {
        let prompt = "가".repeat(PREVIEW_GRAPHEMES);

        assert_eq!(from_prompt(&prompt), Some(format!("[REQ] {prompt}")));
    }

    #[test]
    fn nearby_word_boundary_is_preferred() {
        assert_eq!(
            from_prompt("1234567890123456789012345678 remaining request").as_deref(),
            Some("[REQ] 1234567890123456789012345678…")
        );
    }

    #[test]
    fn word_boundary_before_window_does_not_shorten_the_preview() {
        assert_eq!(
            from_prompt("12345678901234567890123 567890123456789").as_deref(),
            Some("[REQ] 12345678901234567890123 56789012…")
        );
    }

    #[test]
    fn extended_graphemes_are_not_split() {
        let family = "👨‍👩‍👧‍👦";
        let prompt = family.repeat(PREVIEW_GRAPHEMES + 1);
        let expected = family.repeat(PREVIEW_GRAPHEMES);

        assert_eq!(from_prompt(&prompt), Some(format!("[REQ] {expected}…")));
    }

    #[test]
    fn decomposed_hangul_graphemes_are_not_split() {
        let han = "한";
        let prompt = han.repeat(PREVIEW_GRAPHEMES + 1);
        let expected = han.repeat(PREVIEW_GRAPHEMES);

        assert_eq!(from_prompt(&prompt), Some(format!("[REQ] {expected}…")));
    }
}
