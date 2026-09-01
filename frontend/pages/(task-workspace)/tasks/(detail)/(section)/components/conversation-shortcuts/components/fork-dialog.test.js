import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./fork-dialog.js");
const forkDialog = registry.element("caffold-conversation-fork-dialog").prototype;
after(() => registry.restore());

test("provides the Thread ID and every owned fork dialog button", () => {
  const input = control();
  const body = {};
  const buttons = new Map([
    ["preview", control({ textContent: "Preview thread", disabled: true })],
    ["cancel", control({ textContent: "Cancel" })],
    ["fork", control({ textContent: "Fork task", disabled: true })],
  ]);
  const dialog = {
    open: true,
    querySelector(selector) {
      if (selector === ".conversation-fork-body") {
        return body;
      }
      return buttons.get(selector.match(/action="([^"]+)/)?.[1]);
    },
  };
  const owner = {
    isConnected: true,
    context: { sectionId: "section/1" },
    dialog: () => dialog,
    threadIdInput: () => input,
  };
  const scope = forkDialog.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.map(({ id, controlKind }) => [id, controlKind]), [
    ["conversation-fork:section%2F1:thread-id", "textbox"],
    ["conversation-fork:section%2F1:preview", "button"],
    ["conversation-fork:section%2F1:cancel", "button"],
    ["conversation-fork:section%2F1:fork", "button"],
  ]);
  assert.equal(scope.targets[0].isActionable(), true);
  assert.equal(scope.targets[1].isActionable(), false);
  assert.equal(scope.targets[2].isActionable(), true);
  assert.deepEqual(scope.targets[1].clipRoots, [dialog, body]);
  assert.deepEqual(scope.targets[2].clipRoots, [dialog]);
  assert.deepEqual(scope.targets[3].clipRoots, [dialog]);
});

test("declares the exact overflowing fork body", () => {
  const body = layoutElement({ clientHeight: 100, scrollHeight: 250 });
  const dialog = layoutElement({
    open: true,
    querySelector: () => body,
  });
  const owner = {
    isConnected: true,
    context: { sectionId: "section" },
    dialog: () => dialog,
  };
  const [surface] = forkDialog.scrollSurfaceScope.call(owner).surfaces;
  assert.equal(surface.scrollport, body);
  assert.equal(surface.isEligible(), true);
  dialog.open = false;
  assert.equal(surface.isEligible(), false);
});

function control(properties = {}) {
  return {
    disabled: false,
    textContent: "",
    focus() {},
    click() {},
    ...properties,
  };
}

function layoutElement(properties = {}) {
  return { getClientRects: () => [{}], ...properties };
}
