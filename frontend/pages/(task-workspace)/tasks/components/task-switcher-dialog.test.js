import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const previousElement = globalThis.Element;
class TestElement {}
globalThis.Element = TestElement;
const { TASK_SWITCHER_SELECT_EVENT } = await import("./task-switcher-dialog.js");
const switcher = registry.element("caffold-task-switcher-dialog").prototype;
after(() => {
  registry.restore();
  if (previousElement === undefined) {
    delete globalThis.Element;
  } else {
    globalThis.Element = previousElement;
  }
});

test("offers Close and one Action Hint target per listed Task", () => {
  const rows = [row("thread/1"), row("thread-2", { recovery: true })];
  const owner = openedSwitcher(rows);

  const scope = switcher.actionHintScope.call(owner);

  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "task-switcher-dialog:close",
    "task-switcher:thread%2F1",
    "task-switcher:thread-2",
  ]);
  assert.deepEqual(scope.targets.map(({ actionId }) => actionId), [
    "dialog.button",
    "task.switch",
    "task.switch",
  ]);
  const [close, ...rowTargets] = scope.targets;
  assert.equal(close.control, owner.closeButton);
  assert.equal(close.label, "Close task switcher");
  assert.equal(close.invalidationOwner, owner);
  // The badge sits beside the title it names, not across the row from it.
  assert.ok(rowTargets.every(({ badgeAtEnd }) => !badgeAtEnd));
  assert.deepEqual(rowTargets.map(({ invalidationOwner }) => invalidationOwner), rows);
  assert.ok(scope.targets.every((target) => target.isActionable()));
});

test("retires Close once the dialog closes or its control is replaced", () => {
  const owner = openedSwitcher([row("thread-1")]);
  const [close] = switcher.actionHintScope.call(owner).targets;
  const closeButton = owner.closeButton;

  assert.ok(close.isActionable());
  owner.closeButton = withAttributes(new TestElement(), {});
  assert.ok(!close.isActionable());
  owner.closeButton = closeButton;
  owner.dialogElement().open = false;
  assert.ok(!close.isActionable());
});

test("retires a row target once the dialog closes", () => {
  const owner = openedSwitcher([row("thread-1")]);
  const [target] = rowTargets(owner);

  assert.ok(target.isActionable());
  owner.dialogElement().open = false;
  assert.ok(!target.isActionable());
});

test("retires a row target whose control was replaced", () => {
  const listed = row("thread-1");
  const owner = openedSwitcher([listed]);
  const [target] = rowTargets(owner);

  assert.ok(target.isActionable());
  listed.control = control(listed);
  assert.ok(!target.isActionable());
});

test("retires a row target that left the list", () => {
  const listed = row("thread-1");
  const owner = openedSwitcher([listed]);
  const [target] = rowTargets(owner);

  assert.ok(target.isActionable());
  listed.isConnected = false;
  assert.ok(!target.isActionable());
});

test("publishes one session-bound modal context for the open dialog", () => {
  const owner = openedSwitcher([row("thread-1")]);

  const [context] = switcher.keyboardNavigationContexts.call(owner);

  assert.equal(context.id, "task-switcher");
  assert.equal(context.kind, "modal");
  assert.equal(context.root, owner.dialogElement());
  assert.equal(context.actionHints.sessionBound, true);
  assert.equal(context.actionHints.scope.targets.length, 2);
  assert.equal(context.scroll.scope.surfaces.length, 1);
});

test("publishes no context while its keyboard presentation is missing", () => {
  const owner = openedSwitcher([row("thread-1")]);
  owner.presentation = null;

  assert.deepEqual(switcher.keyboardNavigationContexts.call(owner), []);
});

test("closes and reports the chosen Task", () => {
  const listed = row("thread/1", { recovery: true });
  const owner = openedSwitcher([listed]);
  const dispatched = [];
  owner.dispatchEvent = (event) => dispatched.push(event);

  switcher.handleClick.call(owner, { target: listed.control });

  assert.equal(owner.dialogElement().open, false);
  assert.deepEqual(dispatched.map(({ type }) => type), [
    TASK_SWITCHER_SELECT_EVENT,
  ]);
  assert.deepEqual(dispatched[0].detail, {
    threadId: "thread/1",
    recovery: true,
  });
});

test("ignores a click that did not land on a listed Task", () => {
  const owner = openedSwitcher([row("thread-1")]);
  owner.dispatchEvent = () => {
    throw new Error("A click outside a row must not choose a Task.");
  };

  switcher.handleClick.call(owner, { target: { closest: () => null } });

  assert.equal(owner.dialogElement().open, true);
});

test("closes when its own Action Hint session is dismissed", () => {
  const owner = openedSwitcher([row("thread-1")]);

  switcher.handleDismiss.call(owner, { target: {} });
  assert.equal(owner.dialogElement().open, true);

  switcher.handleDismiss.call(owner, { target: owner.dialogElement() });
  assert.equal(owner.dialogElement().open, false);
});

test("drops the rows a newer snapshot no longer has, in place", () => {
  const rows = [row("thread-1"), row("thread-2"), row("thread-3")];
  const owner = openedSwitcher(rows);

  assert.equal(switcher.updateTasks.call(owner, { rows: [] }), true);

  assert.deepEqual(owner.rows, []);
  assert.equal(owner.emptyState.hidden, false);
  assert.equal(owner.emptyState.textContent, "No active tasks.");
});

test("says the list is unloaded rather than claiming it is empty", () => {
  const owner = openedSwitcher([]);

  switcher.updateTasks.call(owner, { rows: [], loaded: false });

  assert.equal(owner.emptyState.hidden, false);
  assert.equal(owner.emptyState.textContent, "Active tasks have not loaded.");
});

test("orders by when a Task last finished, not by when it was last looked at", () => {
  const owner = openedSwitcher([]);
  const dialog = owner.dialogElement();
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  const rendered = [];
  owner.renderRows = (rows) =>
    rendered.push(rows.map(({ task }) => task.threadId));

  switcher.open.call(owner, {
    rows: [
      // Opening a Claude Task moves its recency to now, which would carry a
      // Task nobody ran to the top.
      { task: { threadId: "looked-at", recencyMs: 400, lastCompletedMs: 1 } },
      { task: { threadId: "finished-last", lastCompletedMs: 3 } },
      { task: { threadId: "never-finished", updatedMs: 2 } },
    ],
  });

  assert.deepEqual(rendered, [
    ["finished-last", "never-finished", "looked-at"],
  ]);
});

test("takes its order from the first loaded list when it opened without one", () => {
  const owner = openedSwitcher([]);
  owner.tasksLoaded = false;
  const rendered = [];
  owner.renderRows = (rows) =>
    rendered.push(rows.map(({ task }) => task.threadId));

  switcher.updateTasks.call(owner, {
    rows: [
      { task: { threadId: "older", lastCompletedMs: 1 }, sectionName: "one" },
      { task: { threadId: "newer", lastCompletedMs: 2 }, sectionName: "two" },
    ],
    loaded: true,
  });

  assert.deepEqual(rendered, [["newer", "older"]]);

  switcher.updateTasks.call(owner, {
    rows: [
      { task: { threadId: "newer", lastCompletedMs: 3 }, sectionName: "two" },
    ],
    loaded: true,
  });

  assert.equal(rendered.length, 1);
});

test("keeps a row's recovery flag and title current when its Task changes", () => {
  const listed = row("thread-1");
  const owner = openedSwitcher([listed]);
  owner.patchIndicators = () => {};

  switcher.patchRow.call(owner, listed, {
    task: {
      threadId: "thread-1",
      title: "Recovering task",
      recovery: { reason: "threadMissing" },
    },
    sectionName: "caffold",
  });

  assert.equal(listed.dataset.taskRecovery, "true");
  assert.equal(listed.control.getAttribute("title"), "Recovering task");
  assert.equal(listed.title.textContent, "Recovering task");
  assert.equal(listed.context.textContent, "caffold");
  assert.equal(
    listed.control.getAttribute("aria-label"),
    "Open task: Recovering task in caffold",
  );
});

test("takes no snapshot while it is closed", () => {
  const owner = openedSwitcher([row("thread-1")]);
  owner.dialogElement().open = false;

  assert.equal(switcher.updateTasks.call(owner, { rows: [] }), false);
  assert.equal(owner.rows.length, 1);
});

function openedSwitcher(rows) {
  const presentation = {
    actionHintDialog: () => ({ id: "hints" }),
    scrollModeHud: () => ({ id: "hud" }),
    scrollSurfaceSelector: () => ({ id: "selector" }),
  };
  const dialog = { open: true, close() { this.open = false; } };
  const scrollport = { getClientRects: () => [{}] };
  const closeButton = withAttributes(new TestElement(), {
    "aria-label": "Close task switcher",
  });
  closeButton.disabled = false;
  const owner = {
    isConnected: true,
    rows: [...rows],
    presentation,
    closeButton,
    emptyState: { hidden: true, textContent: "" },
    tasksLoaded: true,
    ensureRendered() {},
    dialogElement: () => dialog,
    closeControl: () => owner.closeButton,
    list: () => ({
      get children() {
        return [...owner.rows];
      },
      get childElementCount() {
        return owner.rows.length;
      },
    }),
    scrollport: () => scrollport,
    querySelector: () => owner.emptyState,
    contains: () => true,
    dispatchEvent: () => {},
  };
  dialog.querySelector = () => owner.presentation;
  dialog.getClientRects = () => [{}];
  owner.close = () => switcher.close.call(owner);
  owner.syncEmptyState = () => switcher.syncEmptyState.call(owner);
  owner.actionHintScope = () => switcher.actionHintScope.call(owner);
  owner.scrollSurfaceScope = () => switcher.scrollSurfaceScope.call(owner);
  for (const listed of owner.rows) {
    listed.remove = () => {
      owner.rows = owner.rows.filter((candidate) => candidate !== listed);
      listed.isConnected = false;
    };
  }
  return owner;
}

function rowTargets(owner) {
  return switcher.actionHintScope.call(owner).targets.filter(
    ({ actionId }) => actionId === "task.switch",
  );
}

function row(threadId, { recovery = false } = {}) {
  const listed = withAttributes(new TestElement(), {
    "data-thread-id": threadId,
    "data-task-recovery": `${recovery}`,
  });
  listed.isConnected = true;
  listed.control = control(listed);
  listed.title = withAttributes(new TestElement(), {});
  listed.context = withAttributes(new TestElement(), {});
  listed.indicators = withAttributes(new TestElement(), {});
  listed.querySelector = (selector) => ({
    ":scope > .task-switcher-row": listed.control,
    ".task-switcher-row-title": listed.title,
    ".task-switcher-row-context": listed.context,
    ".task-switcher-row-indicators": listed.indicators,
  })[selector] ?? null;
  return listed;
}

function control(listed) {
  const button = withAttributes(new TestElement(), {
    "aria-label": "Open task: listed",
  });
  button.disabled = false;
  button.closest = (selector) =>
    selector === ".task-switcher-row"
      ? listed.control
      : selector === ".task-switcher-item"
        ? listed
        : null;
  button.focus = () => {};
  button.click = () => {};
  return button;
}

/** A stand-in element whose attributes and `dataset` stay in step. */
function withAttributes(element, attributes) {
  const values = new Map(Object.entries(attributes));
  element.dataset = {};
  element.getAttribute = (name) => values.get(name) ?? null;
  element.setAttribute = (name, value) => {
    values.set(name, `${value}`);
    syncDataset();
  };
  syncDataset();
  return element;

  function syncDataset() {
    for (const [name, value] of values) {
      if (!name.startsWith("data-")) {
        continue;
      }
      element.dataset[datasetKey(name)] = value;
    }
  }
}

function datasetKey(name) {
  return name
    .slice("data-".length)
    .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
