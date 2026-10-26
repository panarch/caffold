import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./permission-instructions-dialog.ts");
const Dialog = registry.element("caffold-task-permission-instructions-dialog");
const { ActionHints } = await import("#app/action-hints.ts");
const { KeyboardContexts } = await import("#app/keyboard-navigation.ts");
after(() => registry.restore());

function draw(state) {
  const dialog = Object.create(Dialog.prototype, {
    state: { value: state },
    threadId: { value: "thread-a" },
  });
  dialog.hints = new ActionHints(dialog, () => {});
  dialog.keyboard = new KeyboardContexts(dialog, () => {});
  const drawn = templateHtml(dialog.render());
  return {
    text: /<pre[^>]*>([\s\S]*?)<\/pre>/.exec(drawn)?.[1],
    empty: /data-empty="(\w+)"/.exec(drawn)?.[1],
    forgetDisabled: /data-permission-instructions-action="forget"\s+\?disabled="(\w+)"/
      .exec(drawn)?.[1],
  };
}

test("shows each entry's time where the reader is, and its words as they were typed", () => {
  const shown = draw({
    loading: false,
    error: "",
    instructions: "[2026-09-21 10:43 UTC]\n네트워크 요청 거절해줘",
  });

  assert.ok(!shown.text.includes("UTC"), shown.text);
  assert.ok(shown.text.includes("네트워크 요청 거절해줘"), shown.text);
  assert.match(shown.text.split("\n")[0], /^\[.+\]$/);
  assert.equal(shown.empty, "false");
  assert.equal(shown.forgetDisabled, "false");
});

test("leaves a stamp it does not recognise exactly as the record has it", () => {
  const shown = draw({
    loading: false,
    error: "",
    instructions: "[unknown time]\n지워도 돼",
  });

  assert.equal(shown.text, "[unknown time]\n지워도 돼");
});

test("an empty record says so and offers nothing to forget", () => {
  const shown = draw({ loading: false, error: "", instructions: "" });

  assert.match(shown.text, /Nothing yet\./);
  assert.equal(shown.empty, "true");
  assert.equal(shown.forgetDisabled, "true");
});

test("says it is reading while a request runs, with Forget held", () => {
  const shown = draw({ loading: true, error: "", instructions: "kept" });

  assert.equal(shown.text, "Reading...");
  assert.equal(shown.forgetDisabled, "true");
});
