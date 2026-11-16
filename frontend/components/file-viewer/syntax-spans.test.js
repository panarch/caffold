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

test("with names, marks each identifier outside comments, keywords, literals, and strings", () => {
  assert.deepEqual(
    named(
      syntaxLine('let total = sum(a, "b") // count', [
        [0, 3, 1],
        [16, 1, 2],
        [19, 3, 3],
        [24, 8, 0],
        [12, 3, 4],
      ].sort((left, right) => left[0] - right[0]), { names: true }),
    ),
    [
      ["syntax-keyword", "let"],
      " ",
      ["name", 4, "total"],
      " = ",
      ["syntax-title", [["name", 12, "sum"]]],
      "(",
      ["syntax-literal", [["name", 16, "a"]]],
      ", ",
      ["syntax-string", '"b"'],
      ") ",
      ["syntax-comment", "// count"],
    ],
  );
});

test("with names, counts each name's place in UTF-16 units", () => {
  assert.deepEqual(named(syntaxLine("가 😀 value_1", null, { names: true })), [
    "가 😀 ",
    ["name", 5, "value_1"],
  ]);
});

test("with names, a constant is a name and the end of a number is not", () => {
  assert.deepEqual(
    named(
      syntaxLine("const LIMIT: u32 = 0xFF + 10u32;", [
        [0, 5, 1],
        [6, 5, 2],
        [13, 3, 5],
        [19, 4, 2],
        [26, 5, 2],
      ], { names: true }),
    ),
    [
      ["syntax-keyword", "const"],
      " ",
      ["syntax-literal", [["name", 6, "LIMIT"]]],
      ": ",
      ["syntax-type", [["name", 13, "u32"]]],
      " = ",
      ["syntax-literal", ["0xFF"]],
      " + ",
      ["syntax-literal", ["10u32"]],
      ";",
    ],
  );
});

// A name reads as its offset and text, a colored span as its class and what
// it holds.
function named(parts) {
  return parts.flatMap((part) => {
    if (typeof part === "string") {
      return part === "" ? [] : [part];
    }
    if (part.strings.join("").includes("code-name")) {
      return [["name", part.values[0], part.values[1]]];
    }
    const token = part.values[1];
    return [[part.values[0], typeof token === "string" ? token : named(token)]];
  });
}

// A colored span reads as its class and text; text between spans stays plain.
function described(parts) {
  return parts.map((part) =>
    typeof part === "string" ? part : [part.values[0], part.values[1]],
  );
}
