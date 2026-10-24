//! Colors source text for the Source and diff viewers. A syntax from bat's set
//! is chosen by file name or first line, and each line becomes a list of
//! `[start, length, color]` spans in the browser's UTF-16 string units. A file
//! no syntax matches, or one with a very long line such as minified code,
//! gets no spans and is shown as plain text.

use std::{collections::HashMap, path::Path, sync::OnceLock};

use syntect::{
    easy::ScopeRangeIterator,
    parsing::{ParseState, Scope, ScopeStack, ScopeStackOp, SyntaxReference, SyntaxSet},
    util::LinesWithEndings,
};

/// Colored spans of one line: `[start, length, color]`, in UTF-16 units.
pub(super) type LineSpans = Vec<[u32; 3]>;

pub(super) struct FileSyntax {
    pub language: String,
    pub spans: Option<Vec<LineSpans>>,
}

const LONG_LINE_CHARS: usize = 5_000;

/// The language of a file and its spans, line by line.
pub(super) fn file_syntax(path: &Path, text: &str) -> FileSyntax {
    let colorer = colorer();
    let first_line = text.lines().next().unwrap_or("");
    let Some(syntax) = colorer.syntax_for(path, first_line) else {
        return FileSyntax {
            language: colorer.syntaxes.find_syntax_plain_text().name.clone(),
            spans: None,
        };
    };
    let spans = (colorer.colors(syntax) && !text.lines().any(is_long_line))
        .then(|| colorer.file_spans(syntax, text))
        .flatten();
    FileSyntax {
        language: syntax.name.clone(),
        spans,
    }
}

/// Spans for each line of `diff`, a file's diff as the viewer shows it, read
/// from `whole_file_diff`, the same diff with both files whole as its
/// context. Removed lines are colored within the old file; added and context
/// lines within the new one. A line that is not a removed, added, or context
/// line gets `None`.
pub(super) fn diff_syntax_spans(
    path: &Path,
    diff: &str,
    whole_file_diff: &str,
) -> Option<Vec<Option<LineSpans>>> {
    let shown = ShownLines::from_diff(diff);
    if shown.is_empty() {
        return None;
    }
    let whole_file = WholeFileDiff::parse(whole_file_diff)?;
    let colorer = colorer();
    let syntax = colorer.syntax_for(path, whole_file.first_new_line())?;
    if !colorer.colors(syntax) || whole_file.lines.iter().any(|line| is_long_line(&line[1..])) {
        return None;
    }

    let mut spans = vec![None; shown.diff_line_count];
    let mut new_side = Side::new(syntax);
    // `None` while the old file has read exactly like the new one so far, so
    // a line the two share is parsed once.
    let mut old_side: Option<Side> = None;
    let (mut old_line, mut new_line) = (whole_file.old_start, whole_file.new_start);
    for line in &whole_file.lines {
        if old_line > shown.last_old && new_line > shown.last_new {
            break;
        }
        let text = &line[1..];
        match line.as_bytes()[0] {
            b' ' => {
                let shown_at = shown.new.get(&new_line).copied();
                colorer.read_line(&mut new_side, text, shown_at, &mut spans)?;
                if let Some(old) = old_side.as_mut() {
                    colorer.read_line(old, text, None, &mut spans)?;
                    if *old == new_side {
                        old_side = None;
                    }
                }
                old_line += 1;
                new_line += 1;
            }
            b'-' => {
                let old = old_side.get_or_insert_with(|| new_side.clone());
                let shown_at = shown.old.get(&old_line).copied();
                colorer.read_line(old, text, shown_at, &mut spans)?;
                old_line += 1;
            }
            b'+' => {
                if old_side.is_none() {
                    old_side = Some(new_side.clone());
                }
                let shown_at = shown.new.get(&new_line).copied();
                colorer.read_line(&mut new_side, text, shown_at, &mut spans)?;
                new_line += 1;
            }
            _ => {}
        }
    }
    spans.iter().any(Option::is_some).then_some(spans)
}

fn is_long_line(line: &str) -> bool {
    line.len() > LONG_LINE_CHARS && line.chars().count() > LONG_LINE_CHARS
}

/// The six colors the viewers have. Their numbers are the order in which
/// `frontend/components/file-viewer/syntax-spans.ts` names its classes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SyntaxColor {
    Comment = 0,
    Keyword = 1,
    Literal = 2,
    String = 3,
    Title = 4,
    Type = 5,
}

/// Scope prefixes in the order they are tried against each scope, innermost
/// scope first. `Plain` stops the search without a color, so code embedded in
/// a string or in Markdown does not take the color of what surrounds it.
const COLOR_RULES: &[(&str, Paint)] = &[
    ("comment", Paint::Color(SyntaxColor::Comment)),
    ("string", Paint::Color(SyntaxColor::String)),
    ("constant", Paint::Color(SyntaxColor::Literal)),
    ("keyword.other.unit", Paint::Color(SyntaxColor::Literal)),
    ("keyword.operator", Paint::KeywordIfWord),
    ("keyword", Paint::Color(SyntaxColor::Keyword)),
    ("storage", Paint::Color(SyntaxColor::Keyword)),
    ("entity.name.tag", Paint::Color(SyntaxColor::Keyword)),
    ("entity.name.type", Paint::Color(SyntaxColor::Type)),
    ("entity.name.class", Paint::Color(SyntaxColor::Type)),
    ("entity.name.struct", Paint::Color(SyntaxColor::Type)),
    ("entity.name.enum", Paint::Color(SyntaxColor::Type)),
    ("entity.name.trait", Paint::Color(SyntaxColor::Type)),
    ("entity.name.interface", Paint::Color(SyntaxColor::Type)),
    (
        "entity.other.inherited-class",
        Paint::Color(SyntaxColor::Type),
    ),
    ("support.type", Paint::Color(SyntaxColor::Type)),
    ("support.class", Paint::Color(SyntaxColor::Type)),
    (
        "entity.other.attribute-name",
        Paint::Color(SyntaxColor::Literal),
    ),
    ("entity.name", Paint::Color(SyntaxColor::Title)),
    ("support.function", Paint::Color(SyntaxColor::Title)),
    ("variable.function", Paint::Color(SyntaxColor::Title)),
    ("markup.heading", Paint::Color(SyntaxColor::Title)),
    ("markup.raw", Paint::Color(SyntaxColor::String)),
    ("markup.underline.link", Paint::Color(SyntaxColor::String)),
    ("meta.embedded", Paint::Plain),
    ("meta.interpolation", Paint::Plain),
    ("meta.template.expression", Paint::Plain),
    ("source", Paint::Plain),
    ("text", Paint::Plain),
];

#[derive(Debug, Clone, Copy)]
enum Paint {
    Color(SyntaxColor),
    Plain,
    /// Operators spelled as words, such as `typeof`, `export` in JavaScript
    /// or `and` in Python, read as keywords; `=` and `&&` stay plain.
    KeywordIfWord,
}

struct Colorer {
    syntaxes: SyntaxSet,
    rules: Vec<(Scope, Paint)>,
    plain_text: Scope,
}

fn colorer() -> &'static Colorer {
    static COLORER: OnceLock<Colorer> = OnceLock::new();
    COLORER.get_or_init(|| Colorer {
        syntaxes: two_face::syntax::extra_newlines(),
        rules: COLOR_RULES
            .iter()
            .map(|(prefix, paint)| (Scope::new(prefix).expect("valid scope prefix"), *paint))
            .collect(),
        plain_text: Scope::new("text.plain").expect("valid scope"),
    })
}

impl Colorer {
    fn syntax_for(&self, path: &Path, first_line: &str) -> Option<&SyntaxReference> {
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        let extension = path
            .extension()
            .and_then(|name| name.to_str())
            .unwrap_or("");
        self.syntaxes
            .find_syntax_by_extension(file_name)
            .or_else(|| self.syntaxes.find_syntax_by_extension(extension))
            .or_else(|| self.syntaxes.find_syntax_by_first_line(first_line))
    }

    fn colors(&self, syntax: &SyntaxReference) -> bool {
        syntax.scope != self.plain_text
    }

    fn file_spans(&self, syntax: &SyntaxReference, text: &str) -> Option<Vec<LineSpans>> {
        let mut side = Side::new(syntax);
        LinesWithEndings::from(text)
            .map(|line| {
                let ops = side.parse.parse_line(line, &self.syntaxes).ok()?;
                self.line_spans(line, &ops, &mut side.scopes)
            })
            .collect()
    }

    /// Reads the next line of one side of a diff, keeping its spans when the
    /// viewer shows that line at `shown_at`.
    fn read_line(
        &self,
        side: &mut Side,
        line: &str,
        shown_at: Option<usize>,
        spans: &mut [Option<LineSpans>],
    ) -> Option<()> {
        let ops = side.parse.parse_line(line, &self.syntaxes).ok()?;
        match shown_at {
            Some(index) => spans[index] = Some(self.line_spans(line, &ops, &mut side.scopes)?),
            None => {
                for (_, op) in &ops {
                    side.scopes.apply(op).ok()?;
                }
            }
        }
        Some(())
    }

    fn line_spans(
        &self,
        line: &str,
        ops: &[(usize, ScopeStackOp)],
        scopes: &mut ScopeStack,
    ) -> Option<LineSpans> {
        let content_end = line.trim_end_matches(['\n', '\r']).len();
        let mut offsets = Utf16Offsets::new(line);
        let mut spans: LineSpans = Vec::new();
        for (range, op) in ScopeRangeIterator::new(ops, line) {
            scopes.apply(op).ok()?;
            let end = range.end.min(content_end);
            if range.start >= end {
                continue;
            }
            let Some(color) = self.color_of(scopes, &line[range.start..end]) else {
                continue;
            };
            let (start, end, color) = (offsets.at(range.start)?, offsets.at(end)?, color as u32);
            match spans.last_mut() {
                Some(last) if last[2] == color && last[0] + last[1] == start => {
                    last[1] = end - last[0];
                }
                _ => spans.push([start, end - start, color]),
            }
        }
        Some(spans)
    }

    fn color_of(&self, scopes: &ScopeStack, text: &str) -> Option<SyntaxColor> {
        let paint = scopes.as_slice().iter().rev().find_map(|scope| {
            self.rules
                .iter()
                .find(|(prefix, _)| prefix.is_prefix_of(*scope))
                .map(|(_, paint)| *paint)
        })?;
        match paint {
            Paint::Color(color) => Some(color),
            Paint::Plain => None,
            Paint::KeywordIfWord => text
                .chars()
                .all(char::is_alphabetic)
                .then_some(SyntaxColor::Keyword),
        }
    }
}

/// One file's parse as it reads down the diff.
#[derive(Clone, PartialEq, Eq)]
struct Side {
    parse: ParseState,
    scopes: ScopeStack,
}

impl Side {
    fn new(syntax: &SyntaxReference) -> Self {
        Self {
            parse: ParseState::new(syntax),
            scopes: ScopeStack::new(),
        }
    }
}

/// Where each removed, added, and context line of a diff sits in the diff
/// text, by its line number in the old or new file, read the way the diff
/// viewer reads it. A context line is found by its new line number.
struct ShownLines {
    diff_line_count: usize,
    old: HashMap<u32, usize>,
    new: HashMap<u32, usize>,
    last_old: u32,
    last_new: u32,
}

impl ShownLines {
    fn from_diff(diff: &str) -> Self {
        let mut shown = Self {
            diff_line_count: 0,
            old: HashMap::new(),
            new: HashMap::new(),
            last_old: 0,
            last_new: 0,
        };
        let (mut old_line, mut new_line) = (0, 0);
        let (mut old_remaining, mut new_remaining) = (0, 0);
        for (index, line) in diff.split('\n').enumerate() {
            shown.diff_line_count = index + 1;
            if let Some(header) = HunkHeader::parse(line) {
                (old_line, old_remaining) = (header.old_start, header.old_count);
                (new_line, new_remaining) = (header.new_start, header.new_count);
            } else if line.starts_with('+') && new_remaining > 0 {
                shown.show_new(new_line, index);
                new_line += 1;
                new_remaining -= 1;
            } else if line.starts_with('-') && old_remaining > 0 {
                shown.old.insert(old_line, index);
                shown.last_old = old_line;
                old_line += 1;
                old_remaining -= 1;
            } else if line.starts_with(' ') && old_remaining > 0 && new_remaining > 0 {
                shown.show_new(new_line, index);
                old_line += 1;
                new_line += 1;
                old_remaining -= 1;
                new_remaining -= 1;
            }
        }
        shown
    }

    fn show_new(&mut self, line: u32, index: usize) {
        self.new.insert(line, index);
        self.last_new = line;
    }

    fn is_empty(&self) -> bool {
        self.old.is_empty() && self.new.is_empty()
    }
}

/// The single hunk of a diff made with whole files as context.
struct WholeFileDiff<'a> {
    old_start: u32,
    new_start: u32,
    lines: Vec<&'a str>,
}

impl<'a> WholeFileDiff<'a> {
    fn parse(diff: &'a str) -> Option<Self> {
        let mut lines = LinesWithEndings::from(diff);
        let header = lines.by_ref().find_map(HunkHeader::parse)?;
        let lines: Vec<&str> = lines.filter(|line| !line.is_empty()).collect();
        if lines.iter().any(|line| HunkHeader::parse(line).is_some()) {
            return None;
        }
        Some(Self {
            old_start: header.old_start,
            new_start: header.new_start,
            lines,
        })
    }

    fn first_new_line(&self) -> &'a str {
        self.lines
            .iter()
            .find(|line| line.starts_with([' ', '+']))
            .map_or("", |line| &line[1..])
    }
}

struct HunkHeader {
    old_start: u32,
    old_count: u32,
    new_start: u32,
    new_count: u32,
}

impl HunkHeader {
    /// Reads `@@ -<start>[,<count>] +<start>[,<count>] @@`.
    fn parse(line: &str) -> Option<Self> {
        let ranges = line.strip_prefix("@@ -")?.split_once(" @@")?.0;
        let (old, new) = ranges.split_once(" +")?;
        let (old_start, old_count) = hunk_range(old)?;
        let (new_start, new_count) = hunk_range(new)?;
        Some(Self {
            old_start,
            old_count,
            new_start,
            new_count,
        })
    }
}

fn hunk_range(range: &str) -> Option<(u32, u32)> {
    match range.split_once(',') {
        Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
        None => Some((range.parse().ok()?, 1)),
    }
}

/// Turns byte offsets into UTF-16 offsets along one line, offsets in order.
struct Utf16Offsets<'a> {
    line: &'a str,
    byte: usize,
    utf16: u32,
}

impl<'a> Utf16Offsets<'a> {
    fn new(line: &'a str) -> Self {
        Self {
            line,
            byte: 0,
            utf16: 0,
        }
    }

    fn at(&mut self, byte: usize) -> Option<u32> {
        let passed = self.line.get(self.byte..byte)?;
        self.utf16 += passed.encode_utf16().count() as u32;
        self.byte = byte;
        Some(self.utf16)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMENT: u32 = SyntaxColor::Comment as u32;
    const KEYWORD: u32 = SyntaxColor::Keyword as u32;
    const STRING: u32 = SyntaxColor::String as u32;
    const TITLE: u32 = SyntaxColor::Title as u32;

    /// The text each span covers, with its color.
    fn colored(line: &str, spans: &LineSpans) -> Vec<(String, u32)> {
        let units: Vec<u16> = line.encode_utf16().collect();
        spans
            .iter()
            .map(|[start, length, color]| {
                let piece = &units[*start as usize..(*start + *length) as usize];
                (String::from_utf16(piece).unwrap(), *color)
            })
            .collect()
    }

    fn file_lines(path: &str, text: &str) -> Vec<Vec<(String, u32)>> {
        let spans = file_syntax(Path::new(path), text).spans.unwrap();
        text.lines()
            .zip(&spans)
            .map(|(line, spans)| colored(line, spans))
            .collect()
    }

    #[test]
    fn colors_comments_keywords_names_and_strings() {
        let lines = file_lines(
            "src/lib.rs",
            "// Reads a name.\nfn read() -> &'static str {\n    \"name\"\n}\n",
        );

        assert_eq!(lines[0], [("// Reads a name.".to_string(), COMMENT)]);
        assert!(lines[1].contains(&("fn".to_string(), KEYWORD)));
        assert!(lines[1].contains(&("read".to_string(), TITLE)));
        assert!(!lines[1].iter().any(|(text, _)| text.contains("->")));
        assert_eq!(lines[2], [("\"name\"".to_string(), STRING)]);
    }

    #[test]
    fn colors_word_operators_as_keywords_and_leaves_symbols_plain() {
        let lines = file_lines(
            "main.js",
            "export const a = b instanceof C && !d;\nimport { e } from \"./e.js\";\n",
        );
        let python = file_lines("main.py", "if a and not b:\n    pass\n");

        assert!(lines[0].contains(&("export".to_string(), KEYWORD)));
        assert!(lines[0].contains(&("instanceof".to_string(), KEYWORD)));
        assert!(lines[1].contains(&("import".to_string(), KEYWORD)));
        assert!(lines[1].contains(&("from".to_string(), KEYWORD)));
        for symbol in ["=", "&&", "!"] {
            assert!(!lines[0].iter().any(|(text, _)| text == symbol), "{symbol}");
        }
        assert!(python[0].contains(&("and".to_string(), KEYWORD)));
        assert!(python[0].contains(&("not".to_string(), KEYWORD)));
    }

    #[test]
    fn colors_every_line_of_a_block_comment() {
        let lines = file_lines("main.js", "/* first\n   middle\n   last */\nconst x = 1;\n");

        assert_eq!(lines[0], [("/* first".to_string(), COMMENT)]);
        assert_eq!(lines[1], [("   middle".to_string(), COMMENT)]);
        assert_eq!(lines[2], [("   last */".to_string(), COMMENT)]);
        assert!(lines[3].contains(&("const".to_string(), KEYWORD)));
    }

    #[test]
    fn places_spans_in_utf16_units() {
        let text = "let 이름 = \"가😀나\";\n";
        let spans = file_syntax(Path::new("a.js"), text).spans.unwrap();

        let strings: Vec<_> = colored(text.trim_end(), &spans[0])
            .into_iter()
            .filter(|(_, color)| *color == STRING)
            .collect();
        assert_eq!(strings, [("\"가😀나\"".to_string(), STRING)]);
        let start = text
            .encode_utf16()
            .position(|unit| unit == u16::from(b'"'))
            .unwrap();
        assert!(spans[0].contains(&[start as u32, 6, STRING]));
    }

    #[test]
    fn names_the_syntax_it_colors_with() {
        let rust = file_syntax(Path::new("src/main.rs"), "fn main() {}\n");
        let tsx = file_syntax(Path::new("Page.tsx"), "export const a = 1;\n");
        let script = file_syntax(Path::new("bin/tool"), "#!/bin/bash\necho hi\n");
        let docker = file_syntax(Path::new("Dockerfile"), "FROM rust\n");

        assert_eq!(rust.language, "Rust");
        assert_eq!(tsx.language, "TypeScriptReact");
        assert_eq!(script.language, "Bourne Again Shell (bash)");
        assert_eq!(docker.language, "Dockerfile");
        assert!(script.spans.is_some());
    }

    #[test]
    fn leaves_unknown_plain_and_long_line_files_uncolored() {
        let unknown = file_syntax(Path::new("notes.unknownext"), "fn main() {}\n");
        let plain = file_syntax(Path::new("notes.txt"), "fn main() {}\n");
        let minified = format!("const a = \"{}\";\n", "x".repeat(LONG_LINE_CHARS));
        let long = file_syntax(Path::new("bundle.js"), &minified);
        let just_short = format!("const a = \"{}\";\n", "x".repeat(LONG_LINE_CHARS - 20));

        assert_eq!(unknown.language, "Plain Text");
        assert_eq!(unknown.spans, None);
        assert_eq!(plain.language, "Plain Text");
        assert_eq!(plain.spans, None);
        assert_eq!(long.language, "JavaScript (Babel)");
        assert_eq!(long.spans, None);
        assert!(
            file_syntax(Path::new("bundle.js"), &just_short)
                .spans
                .is_some()
        );
    }

    /// A unified diff of `old` and `new` with `context` lines around each
    /// change, made by git the way the server makes it.
    fn git_diff(old: &str, new: &str, context: &str) -> String {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("old.js"), old).unwrap();
        std::fs::write(temp.path().join("new.js"), new).unwrap();
        let output = std::process::Command::new("git")
            .current_dir(temp.path())
            .args(["diff", "--no-index", context, "--", "old.js", "new.js"])
            .output()
            .unwrap();
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_string()
    }

    fn diff_lines(old: &str, new: &str) -> Vec<(String, Vec<(String, u32)>)> {
        let diff = git_diff(old, new, "--unified=3");
        let whole_file = git_diff(old, new, "--unified=2147483647");
        let spans = diff_syntax_spans(Path::new("new.js"), &diff, &whole_file).unwrap();
        diff.split('\n')
            .zip(spans)
            .filter_map(|(line, spans)| Some((line.to_string(), colored(&line[1..], &spans?))))
            .collect()
    }

    #[test]
    fn colors_a_hunk_that_starts_inside_a_block_comment() {
        let comment: String = (1..=12).map(|n| format!(" * line {n}\n")).collect();
        let old = format!("/**\n{comment} */\nconst a = 1;\n");
        let new = old.replace(" * line 9\n", " * line nine\n");

        let lines = diff_lines(&old, &new);

        assert!(lines.len() >= 7);
        for (line, colored) in &lines {
            assert_eq!(colored, &[(line[1..].to_string(), COMMENT)], "{line}");
        }
    }

    #[test]
    fn colors_a_removed_line_within_the_old_file() {
        let old = "const a = 1;\n/*\nconst b = 2;\n*/\nconst c = 3;\n";
        let new = "const a = 1;\nconst b = 3;\nconst c = 3;\n";

        let lines = diff_lines(old, new);

        let removed = lines
            .iter()
            .find(|(line, _)| line == "-const b = 2;")
            .unwrap();
        let added = lines
            .iter()
            .find(|(line, _)| line == "+const b = 3;")
            .unwrap();
        assert_eq!(removed.1, [("const b = 2;".to_string(), COMMENT)]);
        assert!(added.1.contains(&("const".to_string(), KEYWORD)));
        let context = lines
            .iter()
            .find(|(line, _)| line == " const c = 3;")
            .unwrap();
        assert!(context.1.contains(&("const".to_string(), KEYWORD)));
    }

    #[test]
    fn colors_each_diff_line_as_its_whole_file_does() {
        let old = (1..=60)
            .map(|n| match n % 15 {
                0 => "/* a comment\n   that ends here */\n".to_string(),
                5 => format!("const text{n} = `line\n${{n}} more`;\n"),
                _ => format!("function f{n}(x) {{ return x + {n}; }}\n"),
            })
            .collect::<String>();
        let new = old
            .replace("function f3(", "/* opened\nfunction f3(")
            .replace("function f7(", "*/ function f7(")
            .replace("function f22(x) { return x + 22; }\n", "")
            .replace("const text50", "let renamed50");

        let diff = git_diff(&old, &new, "--unified=3");
        let whole_file = git_diff(&old, &new, "--unified=2147483647");
        let spans = diff_syntax_spans(Path::new("new.js"), &diff, &whole_file).unwrap();
        let old_spans = file_syntax(Path::new("old.js"), &old).spans.unwrap();
        let new_spans = file_syntax(Path::new("new.js"), &new).spans.unwrap();

        let shown = ShownLines::from_diff(&diff);
        assert!(!shown.old.is_empty() && !shown.new.is_empty());
        for (number, index) in &shown.old {
            assert_eq!(
                spans[*index].as_ref(),
                Some(&old_spans[*number as usize - 1])
            );
        }
        for (number, index) in &shown.new {
            assert_eq!(
                spans[*index].as_ref(),
                Some(&new_spans[*number as usize - 1])
            );
        }
        let code_lines = shown.old.len() + shown.new.len();
        assert_eq!(
            spans.iter().filter(|line| line.is_some()).count(),
            code_lines
        );
    }

    #[test]
    fn leaves_diffs_without_hunks_or_with_long_lines_uncolored() {
        let long = format!("const a = \"{}\";\n", "x".repeat(LONG_LINE_CHARS));
        let diff = git_diff("const a = 1;\n", &long, "--unified=3");
        let whole_file = git_diff("const a = 1;\n", &long, "--unified=2147483647");

        assert_eq!(
            diff_syntax_spans(Path::new("a.js"), &diff, &whole_file),
            None
        );
        assert_eq!(diff_syntax_spans(Path::new("a.js"), "", ""), None);
        assert_eq!(
            diff_syntax_spans(Path::new("a.bin"), "Binary files a and b differ", ""),
            None
        );
    }
}
