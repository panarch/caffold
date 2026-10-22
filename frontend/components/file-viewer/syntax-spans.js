import { escapeHtml } from "../dom.js";

// The server colors source text and sends each line's spans as
// `[start, length, color]` in UTF-16 units. The color numbers follow
// `SyntaxColor` in caffold/src/fs/syntax.rs.
const SYNTAX_CLASSES = [
  "syntax-comment",
  "syntax-keyword",
  "syntax-literal",
  "syntax-string",
  "syntax-title",
  "syntax-type",
];

export function syntaxLineHtml(text, spans) {
  let html = "";
  let position = 0;

  for (const [start, length, color] of spans ?? []) {
    const className = SYNTAX_CLASSES[color];
    if (!className || start < position) {
      continue;
    }
    html += escapeHtml(text.slice(position, start));
    html += `<span class="${className}">${escapeHtml(text.slice(start, start + length))}</span>`;
    position = start + length;
  }

  return html + escapeHtml(text.slice(position));
}
