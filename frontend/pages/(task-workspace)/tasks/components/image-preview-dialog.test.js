import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./image-preview-dialog.js");
const imageDialog = registry.element("caffold-task-image-preview-dialog").prototype;
after(() => registry.restore());

test("keeps the retained image Close control as its only target", () => {
  const control = {
    disabled: false,
    getAttribute: () => "Close image preview",
    focus() {},
    click() {},
  };
  const dialog = {
    open: true,
    querySelector: () => control,
  };
  const owner = { isConnected: true, dialog: () => dialog };
  const scope = imageDialog.actionHintScope.call(owner);

  assert.equal(scope.targets.length, 1);
  assert.equal(scope.targets[0].id, "task-image-preview:close");
  assert.equal(scope.targets[0].isActionable(), true);
  dialog.querySelector = () => null;
  assert.equal(scope.targets[0].isActionable(), false);
});
