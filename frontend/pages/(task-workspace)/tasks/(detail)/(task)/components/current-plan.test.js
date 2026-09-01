import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./current-plan.js");
const currentPlan = registry.element("caffold-task-current-plan").prototype;
after(() => registry.restore());

test("provides the exact ready Plan and Checklist opener buttons", () => {
  const calls = [];
  const strip = { hidden: false };
  const controls = {
    plan: actionControl("Open plan: Keyboard scrolling", "plan", calls),
    checklist: actionControl(
      "Open checklist: 4 of 9 complete",
      "checklist",
      calls,
    ),
  };
  const owner = currentPlanOwner({ strip, controls });
  const outerClip = {};

  const scope = currentPlan.actionHintScope.call(owner, {
    scopeId: "task:thread-a:current-plan",
    clipRoots: [outerClip],
  });

  assert.deepEqual(
    scope.targets.map(({ id, actionId, label, control, clipRoots }) => ({
      id,
      actionId,
      label,
      control,
      clipRoots,
    })),
    [
      {
        id: "task:thread-a:current-plan:plan",
        actionId: "task.current-plan.document.open",
        label: "Open plan: Keyboard scrolling",
        control: controls.plan,
        clipRoots: [owner, strip, outerClip],
      },
      {
        id: "task:thread-a:current-plan:checklist",
        actionId: "task.current-plan.document.open",
        label: "Open checklist: 4 of 9 complete",
        control: controls.checklist,
        clipRoots: [owner, strip, outerClip],
      },
    ],
  );
  assert.deepEqual(scope.mutationRoots, [owner]);
  assert.deepEqual(scope.scrollRoots, []);
  assert.equal(scope.targets.every(({ isActionable }) => isActionable()), true);

  scope.targets[1].activate();
  assert.deepEqual(calls, [
    ["focus", "checklist", { preventScroll: true }],
    ["click", "checklist"],
  ]);

  owner.projection.plan.completed = 5;
  controls.checklist.label = "Open checklist: 5 of 9 complete";
  assert.equal(scope.targets[1].isActionable(), true);
  assert.equal(
    currentPlan.actionHintScope.call(owner).targets[1].label,
    "Open checklist: 5 of 9 complete",
  );
  owner.projection.plan.checklistDocument.path = "task/OTHER.md";
  assert.equal(scope.targets[1].isActionable(), false);
});

test("excludes stale, hidden, and non-ready Current Plan owners", () => {
  const strip = { hidden: false };
  const controls = {
    plan: actionControl("Open plan", "plan", []),
    checklist: actionControl("Open checklist", "checklist", []),
  };
  const owner = currentPlanOwner({ strip, controls });

  const ready = currentPlan.actionHintScope.call(owner);
  assert.equal(ready.targets.length, 2);
  owner.contextGeneration += 1;
  assert.equal(ready.targets.every(({ isActionable }) => !isActionable()), true);

  owner.projection = { status: "absent", plan: null };
  assert.deepEqual(currentPlan.actionHintScope.call(owner).targets, []);
  owner.projection = readyProjection();
  strip.hidden = true;
  assert.deepEqual(currentPlan.actionHintScope.call(owner).targets, []);
  strip.hidden = false;
  owner.isConnected = false;
  assert.deepEqual(currentPlan.actionHintScope.call(owner).targets, []);
});

function currentPlanOwner({ strip, controls }) {
  return {
    context: { threadId: "thread-a" },
    contextGeneration: 3,
    hidden: false,
    isConnected: true,
    projection: readyProjection(),
    ensureState() {},
    querySelector(selector) {
      if (selector.includes('[data-current-plan-action="plan"]')) {
        return controls.plan;
      }
      if (selector.includes('[data-current-plan-action="checklist"]')) {
        return controls.checklist;
      }
      return selector === ":scope > .task-current-plan-strip" ? strip : null;
    },
  };
}

function readyProjection() {
  return {
    status: "ready",
    plan: {
      title: "Keyboard scrolling",
      completed: 4,
      total: 9,
      planDocument: { path: "task/PLAN.md" },
      checklistDocument: { path: "task/CHECKLIST.md" },
    },
  };
}

function actionControl(label, action, calls) {
  return {
    dataset: { currentPlanAction: action },
    disabled: false,
    hidden: false,
    label,
    getAttribute(name) {
      return name === "aria-label" ? this.label : null;
    },
    focus(options) {
      calls.push(["focus", action, options]);
    },
    click() {
      calls.push(["click", action]);
    },
  };
}
