import assert from "node:assert/strict";
import test from "node:test";

import { syntaxLine } from "./syntax-spans.js";

test("wraps each span in its color class between the plain text around it", () => {
  assert.deepEqual(
    described(
      syntaxLine('if (a < b) return "<b>";', [
        [0, 2, 1],
        [11, 6, 1],
        [18, 5, 3],
      ]),
    ),
    [
      ["syntax-keyword", "if"],
      " (a < b) ",
      ["syntax-keyword", "return"],
      " ",
      ["syntax-string", '"<b>"'],
      ";",
    ],
  );
});

test("names all six colors in the server's order", () => {
  assert.deepEqual(
    described(syntaxLine("abcdef", [0, 1, 2, 3, 4, 5].map((color) => [color, 1, color]))),
    ["comment", "keyword", "literal", "string", "title", "type"].map(
      (name, index) => [`syntax-${name}`, "abcdef"[index]],
    ),
  );
});

test("counts positions in UTF-16 units", () => {
  assert.deepEqual(described(syntaxLine('let 이름 = "😀";', [[9, 4, 3]])), [
    "let 이름 = ",
    ["syntax-string", '"😀"'],
    ";",
  ]);
});

test("leaves a line without spans as plain text", () => {
  assert.deepEqual(described(syntaxLine("a && b", undefined)), ["a && b"]);
  assert.deepEqual(described(syntaxLine("", [])), []);
});

test("skips spans it cannot place", () => {
  assert.deepEqual(
    described(
      syntaxLine("abc", [
        [0, 2, 9],
        [1, 1, 0],
        [0, 1, 0],
      ]),
    ),
    ["a", ["syntax-comment", "b"], "c"],
  );
});

// A colored span reads as its class and text; text between spans stays plain.
function described(parts) {
  return parts.map((part) =>
    typeof part === "string" ? part : [part.values[0], part.values[1]],
  );
}
