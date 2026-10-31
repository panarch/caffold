import assert from "node:assert/strict";
import test from "node:test";

import { stretchFromWord, wordAt } from "./word-range.js";

// xterm.js's default word separators.
const SEPARATORS = " ()[]{}',\"`";

test("a held cell selects its word, which ends at separators and blanks", () => {
  const lines = buffer(20, [{ text: "ls (foo-bar) baz" }]);

  assert.deepEqual(wordAt(lines, 20, { x: 6, y: 0 }, SEPARATORS), { x: 4, y: 0, length: 7 });
  assert.deepEqual(wordAt(lines, 20, { x: 14, y: 0 }, SEPARATORS), { x: 13, y: 0, length: 3 });
});

test("a separator or a blank cell is a range of its own", () => {
  const lines = buffer(20, [{ text: "ls (foo-bar) baz" }]);

  assert.deepEqual(wordAt(lines, 20, { x: 3, y: 0 }, SEPARATORS), { x: 3, y: 0, length: 1 });
  assert.deepEqual(wordAt(lines, 20, { x: 18, y: 0 }, SEPARATORS), { x: 18, y: 0, length: 1 });
});

test("wide characters span two cells, from either half", () => {
  const lines = buffer(20, [{ text: "echo 한글-단어 끝" }]);
  const word = { x: 5, y: 0, length: 9 };

  assert.deepEqual(wordAt(lines, 20, { x: 5, y: 0 }, SEPARATORS), word);
  assert.deepEqual(wordAt(lines, 20, { x: 6, y: 0 }, SEPARATORS), word);
  assert.deepEqual(wordAt(lines, 20, { x: 13, y: 0 }, SEPARATORS), word);
  // A one-syllable word takes both its cells.
  assert.deepEqual(wordAt(lines, 20, { x: 16, y: 0 }, SEPARATORS), { x: 15, y: 0, length: 2 });
});

test("a word carries on across a row the terminal wrapped, and only that", () => {
  const wrapped = buffer(8, [{ text: "abc defg" }, { text: "hij kl", wrapped: true }]);
  const word = { x: 4, y: 0, length: 7 };

  assert.deepEqual(wordAt(wrapped, 8, { x: 5, y: 0 }, SEPARATORS), word);
  assert.deepEqual(wordAt(wrapped, 8, { x: 1, y: 1 }, SEPARATORS), word);

  const separate = buffer(8, [{ text: "abc defg" }, { text: "hij kl" }]);
  assert.deepEqual(wordAt(separate, 8, { x: 5, y: 0 }, SEPARATORS), { x: 4, y: 0, length: 4 });
  assert.deepEqual(wordAt(separate, 8, { x: 1, y: 1 }, SEPARATORS), { x: 0, y: 1, length: 3 });
});

test("a word at the end of the buffer stops there", () => {
  const lines = buffer(4, [{ text: "abcd" }]);

  assert.deepEqual(wordAt(lines, 4, { x: 2, y: 0 }, SEPARATORS), { x: 0, y: 0, length: 4 });
});

test("a stretch keeps the word and reaches the cell under the finger on either side", () => {
  const lines = buffer(10, [{ text: "one two" }, { text: "한글 three" }]);
  const word = wordAt(lines, 10, { x: 5, y: 0 }, SEPARATORS);
  assert.deepEqual(word, { x: 4, y: 0, length: 3 });

  // Forward to a wide character takes both its cells.
  assert.deepEqual(stretchFromWord(lines, 10, word, { x: 0, y: 1 }), { x: 4, y: 0, length: 8 });
  assert.deepEqual(stretchFromWord(lines, 10, word, { x: 1, y: 1 }), { x: 4, y: 0, length: 8 });
  // Backward starts at the finger and still ends after the word.
  assert.deepEqual(stretchFromWord(lines, 10, word, { x: 1, y: 0 }), { x: 1, y: 0, length: 6 });
  // Inside the word the selection is the word.
  assert.deepEqual(stretchFromWord(lines, 10, word, { x: 5, y: 0 }), word);
});

// Rows of cells as xterm.js's buffer gives them: a wide character fills its
// cell and leaves the next one empty with no width, and the rest of the row
// is blank.
function buffer(cols, rows) {
  const lines = rows.map(({ text, wrapped = false }) => {
    const cells = [];
    for (const character of text) {
      if (/[가-힣]/.test(character)) {
        cells.push(cell(character, 2), cell("", 0));
      } else {
        cells.push(cell(character, 1));
      }
    }
    while (cells.length < cols) {
      cells.push(cell("", 1));
    }
    return { isWrapped: wrapped, getCell: (x) => cells[x] };
  });
  return { getLine: (y) => lines[y] };
}

function cell(chars, width) {
  return { getChars: () => chars, getWidth: () => width };
}
