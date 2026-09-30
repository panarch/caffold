import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./page.js");
const Recovery = registry.element("caffold-task-recovery");
const recovery = Recovery.prototype;
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

test("stores an equivalent fresh projection without clearing confirmation or error", () => {
  const current = recoveryTask();
  const { view, renders } = recoveryView(current);
  const error = new Error("Removal failed");
  view.confirmingRemoval = true;
  view.actionError = error;
  const refreshed = {
    ...current,
    updatedMs: 2,
    unseen: true,
    recovery: { ...current.recovery, actions: [...current.recovery.actions] },
  };

  view.updateRecovery(refreshed);

  assert.equal(view.recovery, refreshed);
  assert.deepEqual(renders, []);
  assert.equal(view.confirmingRemoval, true);
  assert.equal(view.actionError, error);
});

test("keeps a pending action through an equivalent projection update", () => {
  const current = recoveryTask();
  const { view, renders } = recoveryView(current);
  view.pendingAction = "recheck";
  const refreshed = { ...current, updatedMs: 2 };

  view.updateRecovery(refreshed);

  assert.equal(view.recovery, refreshed);
  assert.equal(view.pendingAction, "recheck");
  assert.deepEqual(renders, []);
});

test("preparing the same Task explicitly resets interaction and renders its entry state", () => {
  const current = recoveryTask();
  const { view, renders } = recoveryView(current);
  view.confirmingRemoval = true;
  view.actionError = new Error("Removal failed");

  view.prepare(current);

  assert.equal(view.confirmingRemoval, false);
  assert.equal(view.actionError, null);
  assert.deepEqual(renders, [current]);
});

for (const [name, change] of [
  ["title", { title: "Renamed recovery" }],
  ["reason", {
    recovery: { reason: "temporarilyUnavailable", actions: ["removeFromCaffold", "recheck"] },
  }],
  ["actions", {
    recovery: { reason: "threadMissing", actions: ["recheck"] },
  }],
  ["Task identity", { threadId: "another-thread" }],
  ["unavailable projection", null],
]) {
  test(`renders a changed Recovery ${name} and resets obsolete interaction state`, () => {
    const current = recoveryTask();
    const { view, renders } = recoveryView(current);
    view.confirmingRemoval = true;
    view.actionError = new Error("Removal failed");
    const refreshed = change === null ? null : { ...current, ...change };

    view.updateRecovery(refreshed);

    assert.equal(view.recovery, refreshed);
    assert.equal(view.confirmingRemoval, false);
    assert.equal(view.actionError, null);
    assert.deepEqual(renders, [refreshed]);
  });
}

function recoveryTask() {
  return {
    threadId: "thread-recovery",
    title: "Recovery Task",
    updatedMs: 1,
    recovery: { reason: "threadMissing", actions: ["removeFromCaffold", "recheck"] },
  };
}

function recoveryView(current) {
  const view = new Recovery();
  Object.assign(view, {
    stateReady: true,
    recovery: current,
    pendingAction: "",
    actionError: null,
    confirmingRemoval: false,
  });
  const renders = [];
  view.render = () => renders.push(view.recovery);
  return { view, renders };
}
