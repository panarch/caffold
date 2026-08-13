import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanRelativeTaskPath,
  formatCommand,
  formatDuration,
  formatRelativeAge,
  formatRelativeAgePresentation,
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

test("formats Task navigator relative ages within three characters", () => {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 12 * month;
  const now = 20 * year;
  const cases = [
    [59_000, "now", "just now"],
    [minute, "1m", "1 minute ago"],
    [59 * minute, "59m", "59 minutes ago"],
    [hour, "1h", "1 hour ago"],
    [23 * hour, "23h", "23 hours ago"],
    [day, "1d", "1 day ago"],
    [29 * day, "29d", "29 days ago"],
    [month, "1M", "1 month ago"],
    [9 * month, "9M", "9 months ago"],
    [10 * month, "10M", "10 months ago"],
    [11 * month, "11M", "11 months ago"],
    [year, "1y", "1 year ago"],
    [9 * year, "9y", "9 years ago"],
    [10 * year, "9y+", "more than 9 years ago"],
  ];

  for (const [elapsed, text, label] of cases) {
    assert.deepEqual(formatRelativeAgePresentation(now - elapsed, now), {
      text,
      label,
    });
    assert.equal(formatRelativeAge(now - elapsed, now), text);
    assert.ok(text.length <= 3, `${text} exceeds the three-character slot`);
  }
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
