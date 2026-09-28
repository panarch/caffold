import assert from "node:assert/strict";
import test from "node:test";

import { controlCharacter, specialKeySequence } from "./keys.js";

test("Esc and Tab send their own characters", () => {
  assert.equal(specialKeySequence("escape"), "\x1b");
  assert.equal(specialKeySequence("tab"), "\t");
});

test("arrows follow the cursor-key mode the program chose", () => {
  assert.deepEqual(
    ["up", "down", "right", "left"].map((key) => specialKeySequence(key)),
    ["\x1b[A", "\x1b[B", "\x1b[C", "\x1b[D"],
  );
  assert.deepEqual(
    ["up", "down", "right", "left"].map((key) =>
      specialKeySequence(key, { applicationCursor: true })
    ),
    ["\x1bOA", "\x1bOB", "\x1bOC", "\x1bOD"],
  );
  assert.equal(
    specialKeySequence("left", { applicationCursor: true, control: true }),
    "\x1b[1;5D",
  );
  assert.equal(specialKeySequence("unknown"), "");
});

test("Ctrl turns the next typed key into its control character", () => {
  assert.equal(controlCharacter("c"), "\x03");
  assert.equal(controlCharacter("C"), "\x03");
  assert.equal(controlCharacter("d"), "\x04");
  assert.equal(controlCharacter("["), "\x1b");
  assert.equal(controlCharacter("@"), "\x00");
  assert.equal(controlCharacter(" "), "\x00");
  assert.equal(controlCharacter("?"), "\x7f");
  assert.equal(controlCharacter("1"), "1");
  assert.equal(controlCharacter("한"), "한");
  assert.equal(controlCharacter("ab"), "ab");
});
