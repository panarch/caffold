import assert from "node:assert/strict";
import test from "node:test";
import { fileStatusPresentation } from "./file-status.js";

test("presents git's change letter as itself", () => {
  const cases = [
    ["M", "M", "modified"],
    ["A", "A", "added"],
    ["D", "D", "deleted"],
    ["R", "R", "renamed"],
    ["C", "C", "copied"],
    ["T", "T", "type-changed"],
    ["U", "U", "unmerged"],
  ];

  for (const [status, code, tone] of cases) {
    const presentation = fileStatusPresentation(status);
    assert.equal(presentation.code, code, status);
    assert.equal(presentation.tone, tone, status);
  }
});

test("presents provider and unknown states as one character", () => {
  assert.deepEqual(fileStatusPresentation("copied"), {
    code: "C",
    label: "Copied",
    tone: "copied",
  });
  assert.equal(fileStatusPresentation("type-changed").code, "T");
  for (const unknown of ["provider-mystery", "X", "MM"]) {
    assert.deepEqual(fileStatusPresentation(unknown), {
      code: "?",
      label: "Unknown",
      tone: "unknown",
    }, unknown);
  }
  assert.equal(fileStatusPresentation("").code, "");
});
