import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./navigator.ts");
const Navigator = registry.element("caffold-task-navigator");
after(() => registry.restore());

const ready = {
  key: "ready",
  phase: "ready",
  blocked: false,
  title: "",
  message: "",
};

test("offers its own New Task and its rows' actions with the navigator's geometry", () => {
  const scrollRoot = {};
  const primaryHeader = {};
  let clicks = 0;
  const newTask = {
    disabled: false,
    click() {
      clicks += 1;
    },
  };
  let currentNewTask = newTask;
  const taskTarget = { id: "task:thread-a" };
  const switcherTarget = { id: "task-list:switcher:open" };
  let delegatedOptions = null;
  const activeTaskList = {
    actionHintTargets(options) {
      delegatedOptions = options;
      return [taskTarget];
    },
  };
  const navigator = navigatorHost({
    scrollRoot,
    primaryHeader,
    activeTaskList,
    archivedTaskList: { getClientRects: () => [] },
    get newTaskButton() {
      return currentNewTask;
    },
    switcherTarget: () => switcherTarget,
    reorderTarget: () => null,
  });

  const scope = navigator.actionHintScope();

  assert.equal(scope.blocked, false);
  assert.equal(scope.targets[0], switcherTarget);
  assert.deepEqual(scope.targets.slice(2), [taskTarget]);
  assert.deepEqual(scope.mutationRoots, [primaryHeader, activeTaskList]);
  assert.deepEqual(scope.scrollRoots, [scrollRoot]);
  assert.deepEqual(delegatedOptions, { clipRoots: [navigator, scrollRoot] });

  const target = scope.targets[1];
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
  assert.deepEqual(target.clipRoots, [navigator]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(clicks, 1);

  navigator.taskOperations = { ...ready, key: "blocked", blocked: true };
  assert.equal(target.isActionable(), false);
  navigator.taskOperations = ready;
  currentNewTask = { ...newTask };
  assert.equal(target.isActionable(), false);

  navigator.reorderMode = "tasks";
  const reorderScope = navigator.actionHintScope();
  assert.equal(reorderScope.blocked, false);
  assert.deepEqual(reorderScope.targets, [taskTarget]);
});

test("offers the Task switcher opener only outside reorder modes", () => {
  const control = {
    disabled: false,
    clicks: 0,
    focus() {},
    click() {
      this.clicks += 1;
    },
    getAttribute: (name) => (name === "aria-label" ? "Switch task" : null),
  };
  let currentControl = control;
  const navigator = navigatorHost({
    get switcherButton() {
      return currentControl;
    },
  });

  const target = navigator.switcherTarget();

  assert.equal(target.id, "task-list:switcher:open");
  assert.equal(target.actionId, "task.switcher.open");
  assert.equal(target.label, "Switch task");
  assert.deepEqual(target.clipRoots, [navigator]);
  assert.equal(target.isActionable(), true);
  target.activate();
  assert.equal(control.clicks, 1);

  navigator.reorderMode = "sections";
  assert.equal(target.isActionable(), false);
  navigator.reorderMode = "none";
  currentControl = { ...control };
  assert.equal(target.isActionable(), false);
});

test("asks for the Task switcher without touching reorder mode or blocked Task operations", () => {
  const intents = [];
  const navigator = navigatorHost({
    reorderMode: "tasks",
    taskOperations: { ...ready, key: "blocked", blocked: true },
    dispatchIntent: (detail) => intents.push(detail),
    setReorderMode() {
      throw new Error("Opening the switcher must not change reorder mode.");
    },
    exitReorderMode() {
      throw new Error("Opening the switcher must not end reorder mode.");
    },
  });
  let stopped = false;

  navigator.openSwitcher({
    stopPropagation() {
      stopped = true;
    },
  });

  assert.deepEqual(intents, [{ type: "open-task-switcher" }]);
  assert.equal(stopped, true);
});

test("provides only its exact Task list scrollport", () => {
  const scrollport = {
    clientHeight: 100,
    scrollHeight: 300,
    getClientRects: () => [{}],
  };
  const activeTaskList = {};
  const archivedTaskList = {};
  const navigator = navigatorHost({
    scrollRoot: scrollport,
    activeTaskList,
    archivedTaskList,
    getClientRects: () => [{}],
  });

  const scope = navigator.scrollSurfaceScope();
  assert.equal(scope.blocked, false);
  assert.deepEqual(scope.mutationRoots, [
    navigator,
    activeTaskList,
    archivedTaskList,
  ]);
  assert.deepEqual(scope.resizeElements, [navigator, scrollport]);
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
      clipRoots: [navigator, scrollport],
    },
  );
  assert.equal(scope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 101;
  assert.equal(scope.surfaces[0].isEligible(), true);
  scrollport.scrollHeight = 300;
  navigator.reorderMode = "tasks";
  assert.equal(scope.surfaces[0].isEligible(), false);
  assert.equal(navigator.scrollSurfaceScope().blocked, true);
});

test("merges Archived actions only while that list has a layout box", () => {
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
  const navigator = navigatorHost({
    activeTaskList: { actionHintTargets: () => [activeTarget] },
    archivedTaskList,
    newTaskButton: null,
    switcherTarget: () => null,
    reorderTarget: () => null,
  });

  assert.deepEqual(navigator.actionHintScope().targets, [
    activeTarget,
    archivedTarget,
  ]);
  archivedTaskList.visible = false;
  assert.deepEqual(navigator.actionHintScope().targets, [activeTarget]);
});

test("provides the Reorder opener and its exact popover options", () => {
  let label = "Choose what to reorder";
  const control = {
    disabled: false,
    clicks: 0,
    focus() {},
    click() {
      this.clicks += 1;
    },
    getAttribute(name) {
      return name === "aria-label"
        ? label
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
  const navigator = navigatorHost({
    reorderButton: control,
    reorderPopover: popover,
  });

  const opener = navigator.reorderTarget();
  assert.equal(opener.actionId, "task.reorder.open");
  assert.equal(opener.isActionable(), true);
  opener.activate();
  assert.equal(control.clicks, 1);

  navigator.reorderMode = "tasks";
  label = "Finish reordering Tasks";
  assert.equal(opener.isActionable(), false);
  const finish = navigator.reorderTarget();
  assert.equal(finish.id, "task-list:reorder:finish:tasks");
  assert.equal(finish.actionId, "task.reorder.finish");
  assert.equal(finish.label, "Finish reordering Tasks");
  assert.equal(finish.isActionable(), true);
  finish.activate();
  assert.equal(control.clicks, 2);

  navigator.reorderMode = "none";
  label = "Choose what to reorder";
  popover.open = true;
  const scope = navigator.reorderActionHintScope("task-list:reorder", popover);
  assert.deepEqual(
    scope.targets.map(({ id, actionId }) => ({ id, actionId })),
    [
      { id: "task-list:reorder:tasks", actionId: "task.reorder.select" },
      { id: "task-list:reorder:sections", actionId: "task.reorder.select" },
    ],
  );
  assert.equal(scope.targets.every(({ badgeAtEnd }) => badgeAtEnd), true);
  assert.equal(opener.badgeAtEnd, false);
});

test("closes the Reorder popover when its bound Action Hint session is dismissed", () => {
  let hidden = 0;
  const popover = {
    matches: () => true,
    hidePopover() {
      hidden += 1;
    },
  };
  const navigator = navigatorHost({ reorderPopover: popover });
  navigator.handleDismiss({ target: {} });
  assert.equal(hidden, 0);
  navigator.handleDismiss({ target: popover });
  assert.equal(hidden, 1);
});

test("replaces normal navigator actions with current reorder handles and Finish", () => {
  const finish = { id: "task-list:reorder:finish:tasks" };
  const handle = { id: "task:thread-a:reorder" };
  let archivedCalls = 0;
  const navigator = navigatorHost({
    reorderMode: "tasks",
    activeTaskList: { actionHintTargets: () => [handle] },
    archivedTaskList: {
      getClientRects: () => [{}],
      actionHintScope() {
        archivedCalls += 1;
        return { targets: [{ id: "archived" }] };
      },
    },
    newTaskButton: { id: "new-task" },
    reorderTarget: () => finish,
  });

  const scope = navigator.actionHintScope();
  assert.equal(scope.blocked, false);
  assert.deepEqual(scope.targets, [finish, handle]);
  assert.equal(archivedCalls, 0);
});

test("exits active reorder only for an unclaimed Escape key", () => {
  let exits = 0;
  const navigator = navigatorHost({
    reorderMode: "tasks",
    exitReorderMode() {
      exits += 1;
      this.reorderMode = "none";
    },
  });
  const escape = keyboardEvent();

  navigator.exitReorderOnEscape(escape);

  assert.equal(exits, 1);
  assert.equal(escape.prevented, true);
  assert.equal(escape.stopped, true);

  for (const ignored of [
    keyboardEvent({ key: "Enter" }),
    keyboardEvent({ defaultPrevented: true }),
    keyboardEvent({ isComposing: true }),
    keyboardEvent({ ctrlKey: true }),
    keyboardEvent({ altKey: true }),
    keyboardEvent({ metaKey: true }),
  ]) {
    navigator.reorderMode = "sections";
    navigator.exitReorderOnEscape(ignored);
    assert.equal(ignored.prevented, false);
    assert.equal(ignored.stopped, false);
  }
  navigator.reorderMode = "none";
  navigator.exitReorderOnEscape(keyboardEvent());
  assert.equal(exits, 1);
});

test("declares a session-bound Action Hint context for the Reorder popover", () => {
  const popover = {
    id: "reorder-options",
    matches: () => false,
    contains: () => false,
    querySelectorAll: () => [],
    querySelector: () => ({
      actionHintDialog: () => ({}),
      scrollModeHud: () => ({}),
      scrollSurfaceSelector: () => ({}),
    }),
  };
  const navigator = navigatorHost({ reorderPopover: popover });

  const [context] = navigator.keyboardNavigationContexts();

  assert.equal(context.id, "task-list:reorder");
  assert.equal(context.kind, "popover");
  assert.equal(context.root, popover);
  assert.equal(context.actionHints.sessionBound, true);
});

test("reveals the Archived list once both lists have first answered", () => {
  const revealed = [];
  const active = {
    initialRequestSettled: false,
    listState: () => ({
      count: 2,
      loaded: true,
      loading: false,
      error: "",
      selectedSection: null,
      selectedRecovery: null,
    }),
  };
  const archived = {
    initialRequestSettled: true,
    setRevealed: (value) => revealed.push(value),
    listState: () => ({ count: 1, loaded: true, loading: false, error: "" }),
  };
  const published = [];
  const navigator = navigatorHost({
    activeTaskList: active,
    archivedTaskList: archived,
    lastPublishedListState: "",
    dispatchEvent: (event) => published.push(event.detail),
  });
  const settled = { stopPropagation() {} };

  navigator.listSettled(settled);
  active.initialRequestSettled = true;
  navigator.listSettled(settled);

  assert.deepEqual(revealed, [false, true]);
  assert.deepEqual(published, [
    {
      count: 3,
      activeCount: 2,
      activeError: "",
      archivedCount: 1,
      loaded: true,
      loading: false,
      error: "",
      selectedSection: null,
      selectedRecovery: null,
    },
  ]);
});

test("draws the header's actions for the reorder mode and the Task store", () => {
  const idle = html(navigatorHost({}));
  assert.match(idle, /aria-label="Choose what to reorder" aria-pressed="false" title="Reorder" popovertarget="task-list-reorder-test"/);
  assert.match(idle, /class="task-list-header-action task-list-new-task" data-task-action="open-new" aria-label="New Task" title="New Task" \?disabled="false"/);
  assert.match(idle, /<div class="task-list-scroll"><caffold-active-task-list [^>]*><\/caffold-active-task-list><caffold-archived-task-list hidden [^>]*><\/caffold-archived-task-list><\/div>$/);

  const reordering = html(navigatorHost({
    reorderMode: "sections",
    taskOperations: {
      ...ready,
      key: "blocked",
      blocked: true,
      title: "The Task store is unavailable",
    },
  }));
  assert.match(reordering, /aria-label="Finish reordering Sections" aria-pressed="true" title="Finish reordering Sections"/);
  assert.match(reordering, /title="The Task store is unavailable" \?disabled="true"/);
});

// A navigator whose children and controls are the given stand-ins.
function navigatorHost(properties) {
  return Object.create(Navigator.prototype, {
    ...Object.getOwnPropertyDescriptors({
      active: true,
      hidden: false,
      isConnected: true,
      reorderMode: "none",
      taskOperations: ready,
      reorderPopoverId: "task-list-reorder-test",
      scrollRoot: {},
      primaryHeader: {},
    }),
    ...Object.getOwnPropertyDescriptors(properties),
  });
}

function html(navigator) {
  return templateHtml(navigator.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}

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

function keyboardEvent(overrides = {}) {
  return {
    key: "Escape",
    defaultPrevented: false,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    prevented: false,
    stopped: false,
    preventDefault() {
      this.prevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    ...overrides,
  };
}
