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

test("relative age formatter is stable at the minute boundary", () => {
  const now = 1_000_000;
  assert.equal(formatRelativeAge(now - 59_000, now), "now");
  assert.equal(formatRelativeAge(now - 60_000, now), "1m");
});

test("elapsed duration formatter decomposes rounded seconds into compact units", () => {
  assert.equal(formatDuration(1), "1s");
  assert.equal(formatDuration(1_500), "2s");
  assert.equal(formatDuration(42_000), "42s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(61_000), "1m 1s");
  assert.equal(formatDuration(188_000), "3m 8s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(3_912_000), "1h 5m 12s");
  assert.equal(formatDuration(86_400_000), "1d");
  assert.equal(formatDuration(90_000_000), "1d 1h");
  assert.equal(formatDuration(90_308_000), "1d 1h 5m 8s");
});

test("short IDs use the first eight characters", () => {
  assert.equal(shortId("1234567890"), "12345678");
});

test("command formatter handles argv, shell text, objects, and missing values", () => {
  assert.equal(formatCommand(["cargo", "test"]), "cargo test");
  assert.equal(formatCommand("cargo test"), "cargo test");
  assert.equal(formatCommand({ command: "cargo test" }), '{"command":"cargo test"}');
  assert.equal(formatCommand(null), "(command unavailable)");
});
