import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./command.js");
const command = registry.element("caffold-task-command").prototype;
after(() => registry.restore());

test("provides View output only for the retained terminal command", () => {
  let control = {
    disabled: false,
    textContent: "View output",
    clicks: 0,
    getAttribute: () => null,
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
  const owner = {
    isConnected: true,
    commandKey: "command-a",
    presentation: { mode: "terminal" },
    ensureState() {},
    action: () => control,
  };
  const target = command.actionHintScope.call(owner, {
    scopeId: "task:a:command:a",
  }).targets[0];
  assert.equal(target.id, "task:a:command:a:view-output");
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(control.clicks, 1);
  owner.commandKey = "command-b";
  assert.equal(target.isActionable(), false);
  control = null;
});
