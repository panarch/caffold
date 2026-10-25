import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const { TASK_SWITCHER_SELECT_EVENT } = await import("./task-switcher-dialog.ts");
const Switcher = registry.element("caffold-task-switcher-dialog");
after(() => registry.restore());

test("offers Close and one Action Hint target per listed Task", () => {
  const rows = [row("thread/1"), row("thread-2")];
  const switcher = openedSwitcher(rows);

  const scope = switcher.actionHintScope();

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
  assert.equal(close.control, switcher.closeControl);
  assert.equal(close.label, "Close task switcher");
  assert.equal(close.invalidationOwner, switcher);
  // The badge sits beside the title it names, not across the row from it.
  assert.ok(rowTargets.every(({ badgeAtEnd }) => !badgeAtEnd));
  assert.deepEqual(
    rowTargets.map(({ invalidationOwner }) => invalidationOwner),
    rows,
  );
  assert.ok(scope.targets.every((target) => target.isActionable()));
});

test("retires Close once the dialog closes or its control is replaced", () => {
  const switcher = openedSwitcher([row("thread-1")]);
  const [close] = switcher.actionHintScope().targets;
  const closeControl = switcher.closeControl;

  assert.ok(close.isActionable());
  switcher.closeControl = button("Close task switcher");
  assert.ok(!close.isActionable());
  switcher.closeControl = closeControl;
  switcher.dialog.open = false;
  assert.ok(!close.isActionable());
});

test("retires a row target once the dialog closes", () => {
  const switcher = openedSwitcher([row("thread-1")]);
  const [target] = rowTargets(switcher);

  assert.ok(target.isActionable());
  switcher.dialog.open = false;
  assert.ok(!target.isActionable());
});

test("retires a row target whose control was replaced", () => {
  const listed = row("thread-1");
  const switcher = openedSwitcher([listed]);
  const [target] = rowTargets(switcher);

  assert.ok(target.isActionable());
  listed.control = button("Open task: listed");
  assert.ok(!target.isActionable());
});

test("retires a row target that left the list", () => {
  const listed = row("thread-1");
  const switcher = openedSwitcher([listed]);
  const [target] = rowTargets(switcher);

  assert.ok(target.isActionable());
  listed.isConnected = false;
  assert.ok(!target.isActionable());
});

test("publishes one session-bound modal context for the open dialog", () => {
  const switcher = openedSwitcher([row("thread-1")]);

  const [context] = switcher.keyboardNavigationContexts();

  assert.equal(context.id, "task-switcher");
  assert.equal(context.kind, "modal");
  assert.equal(context.root, switcher.dialog);
  assert.equal(context.actionHints.sessionBound, true);
  assert.equal(context.actionHints.scope.targets.length, 2);
  assert.equal(context.scroll.scope.surfaces.length, 1);
});

test("publishes no context while its keyboard presentation is missing", () => {
  const switcher = openedSwitcher([row("thread-1")]);
  switcher.dialog.querySelector = () => null;

  assert.deepEqual(switcher.keyboardNavigationContexts(), []);
});

test("closes and reports the chosen Task", () => {
  const switcher = openedSwitcher([]);
  const dispatched = [];
  switcher.dispatchEvent = (event) => dispatched.push(event);

  switcher.select({ threadId: "thread/1", recovery: true });

  assert.equal(switcher.dialog.open, false);
  assert.deepEqual(dispatched.map(({ type }) => type), [
    TASK_SWITCHER_SELECT_EVENT,
  ]);
  assert.deepEqual(dispatched[0].detail, {
    threadId: "thread/1",
    recovery: true,
  });
});

test("closes when its own Action Hint session is dismissed", () => {
  const switcher = openedSwitcher([]);

  switcher.handleDismiss({ target: {} });
  assert.equal(switcher.dialog.open, true);

  switcher.handleDismiss({ target: switcher.dialog });
  assert.equal(switcher.dialog.open, false);
});

test("orders by when a Task last finished, not by when it was last looked at", () => {
  const switcher = openedSwitcher([]);
  switcher.dialog.open = false;

  assert.equal(
    switcher.open({
      rows: [
        // Opening a Claude Task moves its recency to now, which would carry a
        // Task nobody ran to the top.
        entry("looked-at", { recencyMs: 400, lastCompletedMs: 1 }),
        entry("finished-last", { lastCompletedMs: 3 }),
        entry("never-finished", { updatedMs: 2 }),
      ],
    }),
    true,
  );

  assert.equal(switcher.dialog.open, true);
  assert.equal(switcher.scrollport.scrollTop, 0);
  assert.deepEqual(threadIds(switcher), [
    "finished-last",
    "never-finished",
    "looked-at",
  ]);
  assert.match(
    html(switcher),
    /data-thread-id="finished-last"[^>]*><button[^>]*\?autofocus="true"/,
    "the newest Task takes the focus the dialog hands out",
  );
  assert.equal(switcher.open({ rows: [] }), false, "an open dialog stays as it is");
});

test("takes its order from the first loaded list when it opened without one", () => {
  const switcher = openedSwitcher([]);
  switcher.dialog.open = false;
  switcher.open({ rows: [], loaded: false });

  switcher.updateTasks({
    rows: [entry("older", { lastCompletedMs: 1 }), entry("newer", { lastCompletedMs: 2 })],
    loaded: true,
  });
  assert.deepEqual(threadIds(switcher), ["newer", "older"]);

  switcher.updateTasks({
    rows: [
      entry("older", { lastCompletedMs: 3 }),
      entry("newer", { lastCompletedMs: 2 }),
    ],
    loaded: true,
  });
  assert.deepEqual(threadIds(switcher), ["newer", "older"], "an open list holds its order");
});

test("drops the Tasks a newer snapshot no longer has and says why the list is empty", () => {
  const switcher = openedSwitcher([]);
  switcher.dialog.open = false;
  switcher.open({ rows: [entry("thread-1"), entry("thread-2")] });

  assert.equal(switcher.updateTasks({ rows: [entry("thread-2")] }), true);
  assert.deepEqual(threadIds(switcher), ["thread-2"]);

  switcher.updateTasks({ rows: [] });
  assert.match(html(switcher), /<p class="task-switcher-empty" \?hidden="false">No active tasks.<\/p>/);

  switcher.updateTasks({ rows: [], loaded: false });
  assert.match(html(switcher), />Active tasks have not loaded.<\/p>/);
});

test("draws each row's title, Section, and the one thing it says about the Task", () => {
  const switcher = openedSwitcher([]);
  switcher.dialog.open = false;
  switcher.open({
    rows: [
      {
        task: {
          ...entry("thread-1").task,
          title: "Recovering task",
          recovery: { reason: "threadMissing", actions: [] },
          unseen: true,
        },
        sectionName: "caffold",
      },
      entry("thread-2", {
        title: "Running task",
        threadStatus: { type: "active", activeFlags: [] },
        lastCompletedMs: 0,
      }),
    ],
  });

  const drawn = html(switcher);
  assert.match(drawn, /<li class="task-switcher-item" data-thread-id="thread-1" data-task-recovery="true"><button type="button" class="task-switcher-row" data-task-status="idle" title="Recovering task" aria-label="Open task: Recovering task in caffold"/);
  assert.match(drawn, /<span class="task-switcher-row-context" title="caffold">caffold<\/span>/);
  assert.match(drawn, /<span class="task-switcher-row-meta task-switcher-row-unseen" title="Completed - not viewed"/);
  assert.match(drawn, /data-task-recovery="false"><button type="button" class="task-switcher-row" data-task-status="running" title="Running task" aria-label="Open task: Running task"/);
  assert.match(drawn, /<caffold-task-status-chip class="task-switcher-row-meta task-switcher-row-status" \.task=""><\/caffold-task-status-chip>/);
});

test("takes no snapshot while it is closed", () => {
  const switcher = openedSwitcher([]);
  switcher.dialog.open = false;

  assert.equal(switcher.updateTasks({ rows: [entry("thread-1")] }), false);
  assert.deepEqual(threadIds(switcher), []);
});

// A switcher whose dialog is open and whose drawn rows are `rows`.
function openedSwitcher(rows) {
  const presentation = {
    actionHintDialog: () => ({ id: "hints" }),
    scrollModeHud: () => ({ id: "hud" }),
    scrollSurfaceSelector: () => ({ id: "selector" }),
  };
  const dialog = {
    open: true,
    close() {
      this.open = false;
    },
    showModal() {
      this.open = true;
    },
    querySelector: () => presentation,
    getClientRects: () => [{}],
  };
  return Object.create(Switcher.prototype, Object.getOwnPropertyDescriptors({
    isConnected: true,
    tasksLoaded: true,
    order: [],
    entries: new Map(),
    dialog,
    list: { querySelectorAll: () => rows },
    scrollport: { scrollTop: 120, getClientRects: () => [{}] },
    closeControl: button("Close task switcher"),
    draw() {},
    dispatchEvent() {},
  }));
}

function rowTargets(switcher) {
  return switcher.actionHintScope().targets.filter(
    ({ actionId }) => actionId === "task.switch",
  );
}

function row(threadId) {
  const listed = {
    dataset: { threadId },
    isConnected: true,
    control: button("Open task: listed"),
    querySelector: (selector) =>
      selector === ":scope > .task-switcher-row" ? listed.control : null,
  };
  return listed;
}

function button(label) {
  return {
    disabled: false,
    getAttribute: (name) => (name === "aria-label" ? label : null),
    focus() {},
    click() {},
  };
}

function entry(threadId, task = {}) {
  return {
    task: {
      threadId,
      title: threadId,
      threadStatus: { type: "idle" },
      unseen: false,
      lastCompletedMs: null,
      recencyMs: null,
      updatedMs: 0,
      worktree: false,
      ...task,
    },
    sectionName: "",
  };
}

function threadIds(switcher) {
  return [...html(switcher).matchAll(/data-thread-id="([^"]+)"/g)].map(
    ([, threadId]) => threadId,
  );
}

function html(switcher) {
  return templateHtml(switcher.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}
