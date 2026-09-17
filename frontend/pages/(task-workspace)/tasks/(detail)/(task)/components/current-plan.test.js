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
    status: actionControl("Plan status: Plan updates paused", "status", calls),
  };
  controls.status.hidden = true;
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

test("provides the status popover opener while the strip needs attention", () => {
  const calls = [];
  const strip = { hidden: false };
  const controls = {
    plan: actionControl("Open plan", "plan", calls),
    checklist: actionControl("Open checklist", "checklist", calls),
    status: actionControl("Plan status: CHECKLIST.md missing", "status", calls),
  };
  controls.plan.hidden = true;
  controls.checklist.hidden = true;
  const owner = currentPlanOwner({ strip, controls });
  owner.projection = {
    status: "problem",
    plan: null,
    problems: [{ document: "checklist", code: "missing", message: "Missing" }],
  };

  const scope = currentPlan.actionHintScope.call(owner, {
    scopeId: "task:thread-a:current-plan",
  });
  assert.deepEqual(
    scope.targets.map(({ id, actionId, label, control, clipRoots }) => ({
      id,
      actionId,
      label,
      control,
      clipRoots,
    })),
    [{
      id: "task:thread-a:current-plan:status",
      actionId: "task.current-plan.status.open",
      label: "Plan status: CHECKLIST.md missing",
      control: controls.status,
      clipRoots: [owner, strip],
    }],
  );
  const [target] = scope.targets;
  assert.equal(target.isActionable(), true);
  owner.popover.open = true;
  assert.equal(target.isActionable(), false);
  owner.popover.open = false;
  controls.status.hidden = true;
  assert.equal(target.isActionable(), false);
});

test("excludes stale, hidden, and non-ready Current Plan owners", () => {
  const strip = { hidden: false };
  const controls = {
    plan: actionControl("Open plan", "plan", []),
    checklist: actionControl("Open checklist", "checklist", []),
    status: actionControl("Plan status", "status", []),
  };
  controls.status.hidden = true;
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

test("declares Refresh as the only status popover action while it is available", () => {
  const owner = statusPopoverOwner();

  const [context] = currentPlan.statusKeyboardNavigationContexts.call(owner);
  assert.equal(context.id, "task:thread-a:current-plan:status");
  assert.equal(context.kind, "popover");
  assert.equal(context.root, owner.popover);
  assert.equal(context.actionHints.dialog, owner.presentation.dialog);
  assert.equal(context.actionHints.sessionBound, true);
  assert.deepEqual(
    context.actionHints.scope.targets.map(({ id, actionId, label, control }) => ({
      id,
      actionId,
      label,
      control,
    })),
    [{
      id: "task:thread-a:current-plan:status:refresh",
      actionId: "button.activate",
      label: "Refresh",
      control: owner.refresh,
    }],
  );
  assert.equal(context.actionHints.scope.targets[0].isActionable(), true);
  owner.contextGeneration += 1;
  assert.equal(context.actionHints.scope.targets[0].isActionable(), false);
  assert.deepEqual(
    context.scroll.scope.surfaces.map(({ id, scrollport }) => ({ id, scrollport })),
    [{ id: "task:thread-a:current-plan:status", scrollport: owner.popover }],
  );

  owner.refresh.layoutBox = false;
  const [withoutRefresh] = currentPlan.statusKeyboardNavigationContexts.call(owner);
  assert.equal(withoutRefresh.actionHints.sessionBound, false);
  assert.deepEqual(withoutRefresh.actionHints.scope.targets, []);
});

test("passes through the status popover and document dialog keyboard contexts", () => {
  const popover = { id: "popover" };
  const modal = { id: "modal" };
  const owner = {
    statusKeyboardNavigationContexts: () => [popover],
    documentDialog: () => ({
      keyboardNavigationContexts: () => [modal],
    }),
  };
  assert.deepEqual(
    currentPlan.keyboardNavigationContexts.call(owner),
    [popover, modal],
  );
});

function currentPlanOwner({ strip, controls }) {
  const popover = {
    id: "task-current-plan-status-1",
    open: false,
    matches(selector) {
      return selector === ":popover-open" && this.open;
    },
  };
  controls.status.popoverTarget = popover.id;
  return {
    context: { threadId: "thread-a" },
    contextGeneration: 3,
    hidden: false,
    isConnected: true,
    popover,
    projection: readyProjection(),
    ensureState() {},
    statusPopover() {
      return popover;
    },
    querySelector(selector) {
      for (const [action, control] of Object.entries(controls)) {
        if (selector.includes(`[data-current-plan-action="${action}"]`)) {
          return control;
        }
      }
      return selector === ":scope > .task-current-plan-strip" ? strip : null;
    },
  };
}

function statusPopoverOwner() {
  const presentation = {
    dialog: { id: "hint-dialog" },
    actionHintDialog() {
      return this.dialog;
    },
    scrollModeHud: () => ({ id: "hud" }),
    scrollSurfaceSelector: () => ({ id: "selector" }),
  };
  const refresh = {
    layoutBox: true,
    textContent: "Refresh",
    getClientRects() {
      return this.layoutBox ? [{}] : [];
    },
  };
  const popover = {
    querySelector(selector) {
      if (selector === ":scope > caffold-keyboard-navigation-presentation") {
        return presentation;
      }
      return selector === '[data-current-plan-action="refresh"]' ? refresh : null;
    },
  };
  return {
    context: { threadId: "thread-a" },
    contextGeneration: 2,
    isConnected: true,
    popover,
    presentation,
    refresh,
    statusPopover() {
      return popover;
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
    popoverTarget: "",
    getAttribute(name) {
      if (name === "popovertarget") {
        return this.popoverTarget;
      }
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
