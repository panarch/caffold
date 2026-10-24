import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./update-dialog.ts");
const updateDialog = registry.element("caffold-update-dialog").prototype;
after(() => registry.restore());

test("provides both native update decisions in one exact modal context", () => {
  const calls = [];
  const controls = new Map([
    ["later", button("Later", calls)],
    ["reload", button("Reload", calls)],
  ]);
  const hintDialog = {};
  const presentation = { actionHintDialog: () => hintDialog };
  const dialog = {
    open: true,
    querySelector(selector) {
      if (selector.includes("keyboard-navigation-presentation")) {
        return presentation;
      }
      return controls.get(selector.match(/value="([^"]+)/)?.[1]) ?? null;
    },
  };
  const owner = Object.assign(Object.create(updateDialog), {
    isConnected: true,
    querySelector(selector) {
      assert.equal(selector, ":scope > dialog");
      return dialog;
    },
  });

  const scope = owner.actionHintScope();
  assert.deepEqual(
    scope.targets.map(({ id, actionId, label }) => [id, actionId, label]),
    [
      ["app:update:later", "dialog.button", "Later"],
      ["app:update:reload", "dialog.button", "Reload"],
    ],
  );
  assert.ok(scope.targets.every((target) => target.isActionable()));
  scope.targets[1].activate();
  assert.deepEqual(calls, ["focus:Reload", "click:Reload"]);

  const [context] = owner.keyboardNavigationContexts();
  assert.equal(context.id, "app:update");
  assert.equal(context.kind, "modal");
  assert.equal(context.root, dialog);
  assert.equal(context.actionHints.dialog, hintDialog);
  assert.equal(Object.hasOwn(context, "scroll"), false);

  dialog.open = false;
  assert.ok(scope.targets.every((target) => !target.isActionable()));
});

function button(label, calls) {
  return {
    disabled: false,
    textContent: label,
    focus: () => calls.push(`focus:${label}`),
    click: () => calls.push(`click:${label}`),
  };
}
