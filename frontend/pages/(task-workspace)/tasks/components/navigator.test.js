import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
await import("./navigator.js");
const navigator = registry.element("caffold-task-navigator").prototype;
after(() => registry.restore());

test("provides owned New Task and delegated row actions with navigator geometry", () => {
  const scrollRoot = {};
  let clicks = 0;
  const newTask = {
    disabled: false,
    click() {
      clicks += 1;
    },
  };
  let currentNewTask = newTask;
  const primaryHeader = {
    querySelector() {
      return currentNewTask;
    },
  };
  const taskTarget = { id: "task:thread-a" };
  let delegatedOptions = null;
  const activeTaskList = {
    actionHintTargets(options) {
      delegatedOptions = options;
      return [taskTarget];
    },
  };
  const owner = {
    activeTaskList,
    reorderMode: "none",
    taskOperations: { blocked: false },
    ensureChildren() {},
    actionHintReorderTarget() {
      return null;
    },
    querySelector(selector) {
      if (selector === ":scope > .task-list-scroll") {
        return scrollRoot;
      }
      if (selector === ":scope > .task-list-primary-header") {
        return primaryHeader;
      }
      if (selector.includes(".task-list-new-task")) {
        return currentNewTask;
      }
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };

  const scope = navigator.actionHintScope.call(owner);

  assert.equal(scope.blocked, false);
  assert.deepEqual(scope.targets.slice(1), [taskTarget]);
  assert.deepEqual(scope.mutationRoots, [primaryHeader, activeTaskList]);
  assert.deepEqual(scope.scrollRoots, [scrollRoot]);
  assert.deepEqual(delegatedOptions, { clipRoots: [owner, scrollRoot] });

  const target = scope.targets[0];
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "task-create:global",
      actionId: "task.create",
      label: "Create a new task",
      controlKind: "button",
    },
  );
  assert.equal(target.control, newTask);
  assert.equal(target.anchor, newTask);
  assert.deepEqual(target.clipRoots, [owner]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(clicks, 1);

  owner.taskOperations.blocked = true;
  assert.equal(target.isActionable(), false);
  owner.taskOperations.blocked = false;
  currentNewTask = { ...newTask };
  assert.equal(target.isActionable(), false);

  owner.reorderMode = "tasks";
  assert.equal(navigator.actionHintScope.call(owner).blocked, true);
});

test("provides only its exact active Task list scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 300,
    getClientRects: () => [{}],
  };
  const activeTaskList = {};
  const archivedTaskList = {};
  const owner = {
    active: true,
    activeTaskList,
    archivedTaskList,
    hidden: false,
    isConnected: true,
    reorderMode: "none",
    ensureChildren() {},
    getClientRects: () => [{}],
    querySelector(selector) {
      assert.equal(selector, ":scope > .task-list-scroll");
      return scrollport;
    },
  };

  const scope = navigator.scrollSurfaceScope.call(owner);
  assert.equal(scope.blocked, false);
  assert.deepEqual(scope.mutationRoots, [owner, activeTaskList, archivedTaskList]);
  assert.deepEqual(scope.resizeElements, [owner, scrollport]);
  assert.deepEqual(scope.scrollRoots, [scrollport]);
  assert.deepEqual(
    {
      id: scope.surfaces[0].id,
      label: scope.surfaces[0].label,
      scrollport: scope.surfaces[0].scrollport,
      clipRoots: scope.surfaces[0].clipRoots,
    },
    {
      id: "task-list",
      label: "Task list",
      scrollport,
      clipRoots: [owner, scrollport],
    },
  );
  assert.equal(scope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 101;
  assert.equal(scope.surfaces[0].isEligible(), false);
  scrollport.scrollHeight = 300;
  owner.reorderMode = "tasks";
  assert.equal(scope.surfaces[0].isEligible(), false);
  assert.equal(navigator.scrollSurfaceScope.call(owner).blocked, true);
});

test("merges Archived actions only while that direct list has a layout box", () => {
  const activeTarget = { id: "active" };
  const archivedTarget = { id: "archived" };
  const archivedTaskList = {
    visible: true,
    getClientRects() {
      return this.visible ? [{}] : [];
    },
    actionHintScope(options) {
      assert.equal(options.scopeId, "task-list:archived");
      return { targets: [archivedTarget], mutationRoots: [this] };
    },
  };
  const owner = {
    reorderMode: "none",
    activeTaskList: {
      actionHintTargets: () => [activeTarget],
    },
    archivedTaskList,
    ensureChildren() {},
    actionHintReorderTarget: () => null,
    querySelector(selector) {
      if (selector === ":scope > .task-list-scroll") return {};
      if (selector === ":scope > .task-list-primary-header") return null;
      throw new Error(`Unexpected selector: ${selector}`);
    },
  };
  assert.deepEqual(
    navigator.actionHintScope.call(owner).targets,
    [activeTarget, archivedTarget],
  );
  archivedTaskList.visible = false;
  assert.deepEqual(navigator.actionHintScope.call(owner).targets, [activeTarget]);
});

test("provides Reorder opener and exact semantic popover options", () => {
  const control = {
    disabled: false,
    clicks: 0,
    focus() {},
    click() {
      this.clicks += 1;
    },
    getAttribute(name) {
      return name === "aria-label"
        ? "Choose what to reorder"
        : name === "popovertarget"
          ? "reorder-options"
          : null;
    },
  };
  const options = [reorderOption("tasks"), reorderOption("sections")];
  const popover = {
    id: "reorder-options",
    open: false,
    matches: () => popover.open,
    contains: (candidate) => options.includes(candidate),
    querySelectorAll: () => options,
  };
  const owner = {
    active: true,
    hidden: false,
    isConnected: true,
    reorderMode: "none",
    get reorderButton() {
      return control;
    },
    reorderPopover: () => popover,
  };

  const opener = navigator.actionHintReorderTarget.call(owner);
  assert.equal(opener.actionId, "task.reorder.open");
  assert.equal(opener.isActionable(), true);
  opener.activate();
  assert.equal(control.clicks, 1);

  popover.open = true;
  const scope = navigator.reorderActionHintScope.call(owner, {
    contextId: "task-list:reorder",
    popover,
  });
  assert.deepEqual(
    scope.targets.map(({ id, actionId }) => ({ id, actionId })),
    [
      { id: "task-list:reorder:tasks", actionId: "task.reorder.select" },
      { id: "task-list:reorder:sections", actionId: "task.reorder.select" },
    ],
  );
});

function reorderOption(mode) {
  return {
    dataset: {
      taskAction: "select-reorder-mode",
      reorderMode: mode,
    },
    disabled: false,
    textContent: `Reorder ${mode}`,
    focus() {},
    click() {},
  };
}
