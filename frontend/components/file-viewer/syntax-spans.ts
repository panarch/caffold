import { html, type TemplateResult } from "lit";
import type { SyntaxSpan } from "#app/api.js";

// The class for each color number, in the order `SyntaxColor` lists them.
const SYNTAX_CLASSES = [
  "syntax-comment",
  "syntax-keyword",
  "syntax-literal",
  "syntax-string",
  "syntax-title",
  "syntax-type",
];

// Text colored as one of these never names something a language server can
// find: comments, keywords, and strings. Literals stay, since constants such
// as `SLEEP_AFTER` share their color.
const NAMELESS_COLORS = new Set([0, 1, 3]);

const NAME_PATTERN = /[A-Za-z_$][A-Za-z0-9_$]*/g;

// What a name cannot follow: a match right after one of these is the end of
// a number, such as the `xFF` of `0xFF` or the `u32` of `10u32`.
const NAME_PART = /[A-Za-z0-9_$]/;

// A line as the viewers draw it. With `names`, every identifier outside
// comments, keywords, and strings becomes a `.code-name` that knows its
// zero-based UTF-16 offset in the line, so a press on it says which name it
// is.
export function syntaxLine(
  text: string,
  spans: readonly SyntaxSpan[] | null | undefined,
  { names = false }: { names?: boolean } = {},
) {
  const parts: Array<string | TemplateResult> = [];
  const plain = (start: number, end: number) =>
    names ? namedText(text, start, end) : [text.slice(start, end)];
  let position = 0;

  for (const [start, length, color] of spans ?? []) {
    const className = SYNTAX_CLASSES[color];
    if (!className || start < position) {
      continue;
    }
    if (start > position) {
      parts.push(...plain(position, start));
    }
    const token =
      names && !NAMELESS_COLORS.has(color)
        ? namedText(text, start, start + length)
        : text.slice(start, start + length);
    parts.push(html`<span class=${className}>${token}</span>`);
    position = start + length;
  }

  if (position < text.length) {
    parts.push(...plain(position, text.length));
  }
  return parts;
}

function namedText(text: string, start: number, end: number) {
  const slice = text.slice(start, end);
  const parts: Array<string | TemplateResult> = [];
  let position = 0;
  for (const match of slice.matchAll(NAME_PATTERN)) {
    const character = start + match.index;
    if (NAME_PART.test(text[character - 1] ?? "")) {
      continue;
    }
    if (match.index > position) {
      parts.push(slice.slice(position, match.index));
    }
    parts.push(
      html`<span class="code-name" data-character=${character}>${match[0]}</span>`,
    );
    position = match.index + match[0].length;
  }
  if (position < slice.length) {
    parts.push(slice.slice(position));
  }
  return parts;
}
