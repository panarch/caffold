import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./command-dialog.js");
const commandDialog = registry.element("caffold-task-command-dialog").prototype;
after(() => registry.restore());

test("binds Close and vertical Scroll to retained command dialog controls", () => {
  const close = {
    disabled: false,
    getAttribute: () => "Close command output",
    focus() {},
    click() {},
  };
  const body = layoutElement({ clientHeight: 100, scrollHeight: 260 });
  const dialog = layoutElement({
    open: true,
    querySelector(selector) {
      return selector.includes("data-command-dialog-action") ? close : body;
    },
  });
  const owner = {
    isConnected: true,
    threadId: "thread/1",
    dialog: () => dialog,
  };
  const action = commandDialog.actionHintScope.call(owner).targets[0];
  const surface = commandDialog.scrollSurfaceScope.call(owner).surfaces[0];

  assert.equal(action.id, "task-command:thread%2F1:close");
  assert.equal(action.isActionable(), true);
  assert.equal(surface.id, "task-command:thread%2F1:output");
  assert.equal(surface.scrollport, body);
  assert.equal(surface.isEligible(), true);
  owner.threadId = "thread/2";
  assert.equal(action.isActionable(), false);
  assert.equal(surface.isEligible(), false);
});

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
