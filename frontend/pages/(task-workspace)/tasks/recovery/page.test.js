import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const recovery = registry.element("caffold-task-recovery").prototype;
after(() => registry.restore());

function button(action) {
  return {
    dataset: { taskRecoveryAction: action },
    disabled: false,
    textContent: action,
    clicks: 0,
    getAttribute: () => null,
    getClientRects: () => [{}],
    focus() {},
    click() {
      this.clicks += 1;
    },
  };
}

test("provides the current recovery actions and exact recovery body", () => {
  const actions = [
    "restore",
    "archive",
    "remove",
    "recheck",
    "cancel-remove",
    "confirm-remove",
  ];
  let controls = actions.map(button);
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 300,
    getClientRects: () => [{}],
  };
  const owner = {
    hidden: false,
    isConnected: true,
    recovery: { threadId: "thread-a" },
    ensureState() {},
    getClientRects: () => [{}],
    querySelector(selector) {
      if (selector.includes("task-recovery-body")) return scrollport;
      return controls.find((control) =>
        selector.includes(`\"${control.dataset.taskRecoveryAction}\"`)
      ) ?? null;
    },
    querySelectorAll: () => controls,
  };

  const scope = recovery.actionHintScope.call(owner);
  assert.deepEqual(
    scope.targets.map(({ id }) => id),
    actions.map((action) => `task-recovery:thread-a:${action}`),
  );
  scope.targets.forEach((target) => target.activate());
  assert.deepEqual(controls.map(({ clicks }) => clicks), [1, 1, 1, 1, 1, 1]);

  const scrollScope = recovery.scrollSurfaceScope.call(owner);
  assert.equal(scrollScope.surfaces[0].scrollport, scrollport);
  assert.equal(scrollScope.surfaces[0].isEligible(), true);
  owner.recovery = { threadId: "thread-b" };
  assert.equal(scope.targets[0].isActionable(), false);
  assert.equal(scrollScope.surfaces[0].isEligible(), false);
  owner.recovery = { threadId: "thread-a" };
  scrollport.scrollHeight = 100;
  assert.equal(scrollScope.surfaces[0].isEligible(), true);
  controls = [];
  assert.equal(scope.targets[0].isActionable(), false);
});
