import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./navigation.js");
const navigation = registry.element("caffold-task-workspace-navigation").prototype;
after(() => registry.restore());

test("provides only the non-current workspace route through its owned button", () => {
  let clicks = 0;
  const controls = {
    tasks: { disabled: false, getAttribute: () => null },
    settings: {
      disabled: false,
      getAttribute: () => "Settings — Codex ready",
      focus() {},
      click() {
        clicks += 1;
      },
    },
  };
  const owner = {
    hidden: false,
    isConnected: true,
    mode: "tasks",
    ensureRendered() {},
    querySelector(selector) {
      return controls[selector.includes('"settings"') ? "settings" : "tasks"];
    },
  };

  const scope = navigation.actionHintScope.call(owner, {
    clipRoots: [owner],
  });
  assert.equal(scope.targets.length, 1);
  assert.deepEqual(
    {
      id: scope.targets[0].id,
      actionId: scope.targets[0].actionId,
      label: scope.targets[0].label,
    },
    {
      id: "workspace:mode:settings",
      actionId: "navigation.workspace.select",
      label: "Settings — Codex ready",
    },
  );
  assert.equal(scope.targets[0].isActionable(), true);
  scope.targets[0].activate();
  assert.equal(clicks, 1);

  owner.mode = "settings";
  assert.equal(scope.targets[0].isActionable(), false);
});
