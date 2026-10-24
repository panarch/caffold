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

export function syntaxLine(
  text: string,
  spans: readonly SyntaxSpan[] | null | undefined,
) {
  const parts: Array<string | TemplateResult> = [];
  let position = 0;

  for (const [start, length, color] of spans ?? []) {
    const className = SYNTAX_CLASSES[color];
    if (!className || start < position) {
      continue;
    }
    if (start > position) {
      parts.push(text.slice(position, start));
    }
    const token = text.slice(start, start + length);
    parts.push(html`<span class=${className}>${token}</span>`);
    position = start + length;
  }

  if (position < text.length) {
    parts.push(text.slice(position));
  }
  return parts;
}
