import assert from "node:assert/strict";
import test from "node:test";

import {
  idleTimeoutValue,
  usageWindowLabel,
  usageWindowValue,
} from "./display.js";

test("usage windows read in this page's words, and unknown kinds in their own", () => {
  assert.equal(usageWindowLabel({ kind: "session" }), "Session");
  assert.equal(usageWindowLabel({ kind: "weekly_all" }), "Weekly");
  assert.equal(
    usageWindowLabel({ kind: "weekly_scoped", model: "Fable" }),
    "Weekly · Fable",
    "a scoped window is named by its model",
  );
  assert.equal(
    usageWindowLabel({ kind: "monthly_novel" }),
    "monthly_novel",
    "a kind this page does not know is shown as the agent named it",
  );
});

test("a window says how much is used and when it lets go", () => {
  const window = {
    kind: "session",
    percent: 4.4,
    resetsAt: "2026-08-22T12:30:00+00:00",
  };

  const value = usageWindowValue(window, () => "21:30");

  assert.equal(value, "4% used · resets 21:30");
});

test("a window with no reset time still says what is used", () => {
  assert.equal(usageWindowValue({ percent: 15 }, () => ""), "15% used");
  assert.equal(
    usageWindowValue({ percent: 15, resetsAt: "not-a-time" }, () => ""),
    "15% used",
    "a reset nobody can read costs the reset, not the row",
  );
});

test("a short idle timeout never reads as no timeout at all", () => {
  assert.equal(idleTimeoutValue(45), "45s");
  assert.equal(idleTimeoutValue(600), "10 min");
});
