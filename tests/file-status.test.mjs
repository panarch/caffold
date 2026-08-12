import assert from "node:assert/strict";
import test from "node:test";
import { fileStatusPresentation } from "../frontend/file-status.js";

test("normalizes Working Tree porcelain status by its owning section", () => {
  const cases = [
    [" M", { category: "unstaged" }, "M"],
    ["M ", { category: "staged" }, "M"],
    ["MM", { category: "unstaged" }, "M"],
    ["AM", { category: "unstaged" }, "M"],
    ["??", { category: "untracked" }, "A"],
    ["R ", { category: "staged" }, "R"],
    [" D", { category: "unstaged" }, "D"],
  ];

  for (const [status, context, expected] of cases) {
    assert.equal(fileStatusPresentation(status, context).code, expected, status);
  }
});

test("presents exceptional, provider, and unknown states as one character", () => {
  assert.deepEqual(fileStatusPresentation("copied"), {
    code: "C",
    label: "Copied",
    tone: "copied",
  });
  assert.equal(fileStatusPresentation("UU", { category: "unstaged" }).code, "U");
  assert.equal(fileStatusPresentation("type-changed").code, "T");
  assert.deepEqual(fileStatusPresentation("provider-mystery"), {
    code: "?",
    label: "Unknown",
    tone: "unknown",
  });
  assert.equal(fileStatusPresentation("").code, "");
});
