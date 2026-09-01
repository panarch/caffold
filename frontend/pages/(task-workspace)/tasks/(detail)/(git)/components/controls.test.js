import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./controls.js");
const controls = registry.element("caffold-git-review-controls").prototype;
after(() => registry.restore());

test("provides only the retained Refresh Git button", () => {
  let button = {
    disabled: false,
    getAttribute: () => "Refresh Git review",
    focus() {},
    click() {},
  };
  const owner = {
    hidden: false,
    isConnected: true,
    ensureRendered() {},
    get refreshButton() {
      return button;
    },
  };
  const target = controls.actionHintScope.call(owner, {
    scopeId: "git:/repo",
  }).targets[0];
  assert.equal(target.id, "git:/repo:refresh");
  assert.equal(target.actionId, "button.activate");
  assert.equal(target.isActionable(), true);
  button = { disabled: false };
  assert.equal(target.isActionable(), false);
});
