import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
const { TASK_SWITCHER_SELECT_EVENT } = await import("./task-switcher-dialog.ts");
const { ActionHints } = await import("#app/action-hints.ts");
const { KeyboardContexts } = await import("#app/keyboard-navigation.ts");
const { ScrollSurfaces } = await import("#app/scroll-scope.ts");
const { DrawnRefs } = await import("#components/drawn-refs.ts");
const Switcher = registry.element("caffold-task-switcher-dialog");
after(() => registry.restore());

test("closes and reports the chosen Task", () => {
  const switcher = openedSwitcher();
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
  const switcher = openedSwitcher();

  switcher.handleDismiss({ target: {} });
  assert.equal(switcher.dialog.open, true);

  switcher.handleDismiss({ target: switcher.dialog });
  assert.equal(switcher.dialog.open, false);
});

test("orders by when a Task last finished, not by when it was last looked at", () => {
  const switcher = openedSwitcher();
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
  assert.equal(switcher.scrollport.value.scrollTop, 0);
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
  const switcher = openedSwitcher();
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
  const switcher = openedSwitcher();
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
  const switcher = openedSwitcher();
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
  const switcher = openedSwitcher();
  switcher.dialog.open = false;

  assert.equal(switcher.updateTasks({ rows: [entry("thread-1")] }), false);
  assert.deepEqual(threadIds(switcher), []);
});

// A switcher whose dialog is open.
function openedSwitcher() {
  const dialog = {
    open: true,
    close() {
      this.open = false;
    },
    showModal() {
      this.open = true;
    },
  };
  const switcher = Object.create(
    Switcher.prototype,
    Object.getOwnPropertyDescriptors({
      tasksLoaded: true,
      order: [],
      entries: new Map(),
      dialog,
      scrollport: { value: { scrollTop: 120 } },
      draw() {},
      dispatchEvent() {},
    }),
  );
  switcher.hints = new ActionHints(switcher);
  switcher.surfaces = new ScrollSurfaces(switcher);
  switcher.keyboard = new KeyboardContexts(switcher);
  switcher.items = new DrawnRefs(switcher);
  return switcher;
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
