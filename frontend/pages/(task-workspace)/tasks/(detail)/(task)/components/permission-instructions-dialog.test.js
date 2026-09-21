import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./permission-instructions-dialog.js");
const dialog = registry.element(
  "caffold-task-permission-instructions-dialog",
).prototype;
after(() => registry.restore());

function owner(state) {
  const parts = {
    ".task-permission-instructions-text": { textContent: "", dataset: {} },
    ".task-permission-instructions-error": { textContent: "", hidden: false },
    'button[data-permission-instructions-action="forget"]': { disabled: false },
  };
  return { state, parts, querySelector: (selector) => parts[selector] ?? null };
}

test("shows each entry's time where the reader is, and its words as they were typed", () => {
  const subject = owner({
    loading: false,
    error: "",
    instructions: "[2026-09-21 10:43 UTC]\n네트워크 요청 거절해줘",
  });

  dialog.patch.call(subject);

  const shown = subject.parts[".task-permission-instructions-text"].textContent;
  assert.ok(!shown.includes("UTC"), shown);
  assert.ok(shown.includes("네트워크 요청 거절해줘"), shown);
  assert.match(shown.split("\n")[0], /^\[.+\]$/);
  assert.equal(
    subject.parts['button[data-permission-instructions-action="forget"]'].disabled,
    false,
  );
});

test("leaves a stamp it does not recognise exactly as the record has it", () => {
  const subject = owner({
    loading: false,
    error: "",
    instructions: "[unknown time]\n지워도 돼",
  });

  dialog.patch.call(subject);

  assert.equal(
    subject.parts[".task-permission-instructions-text"].textContent,
    "[unknown time]\n지워도 돼",
  );
});

test("an empty record says so and offers nothing to forget", () => {
  const subject = owner({ loading: false, error: "", instructions: "" });

  dialog.patch.call(subject);

  assert.match(
    subject.parts[".task-permission-instructions-text"].textContent,
    /Nothing yet\./,
  );
  assert.equal(
    subject.parts['button[data-permission-instructions-action="forget"]'].disabled,
    true,
  );
});
