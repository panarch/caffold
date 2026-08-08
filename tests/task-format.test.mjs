import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanRelativeTaskPath,
  formatCommand,
  formatDuration,
  formatRelativeAge,
  normalizeTaskPath,
  shortId,
} from "../frontend/pages/(task-workspace)/tasks/task-format.js";

test("task paths normalize separators without allowing parent traversal", () => {
  assert.equal(normalizeTaskPath(".\\workspace//project/"), "workspace/project");
  assert.equal(
    cleanRelativeTaskPath("../workspace/./project/../../src"),
    "workspace/project/src",
  );
});

test("task formatters are stable at duration and recency boundaries", () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 59_000, now), "now");
  assert.equal(formatRelativeAge(now - 60_000, now), "1m");
  assert.equal(formatDuration(1), "1s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(shortId("1234567890"), "12345678");
});

test("command formatter handles argv, shell text, objects, and missing values", () => {
  assert.equal(formatCommand(["cargo", "test"]), "cargo test");
  assert.equal(formatCommand("cargo test"), "cargo test");
  assert.equal(formatCommand({ command: "cargo test" }), '{"command":"cargo test"}');
  assert.equal(formatCommand(null), "(command unavailable)");
});
