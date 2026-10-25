import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./archived-task-list.ts");
const Archived = registry.element("caffold-archived-task-list");
after(() => registry.restore());

const ready = {
  key: "ready",
  phase: "ready",
  blocked: false,
  title: "",
  message: "",
};

function ownedButton(action, threadId = "") {
  return {
    dataset: { taskAction: action, threadId },
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

function archivedTask(overrides = {}) {
  return {
    threadId: "thread-a",
    title: "Alpha",
    conversationAvailable: true,
    threadStatus: { type: "idle" },
    cwd: "/repo/alpha",
    cwdPath: "/repo/alpha",
    relativeCwd: "",
    worktree: null,
    createdMs: Date.UTC(2026, 0, 1),
    updatedMs: Date.UTC(2026, 0, 1),
    recencyMs: null,
    lastCompletedMs: Date.UTC(2026, 0, 1),
    unseen: false,
    ...overrides,
  };
}

test("offers every visible archived-list button through the controls it drew", () => {
  const retry = ownedButton("retry-archived-task-list");
  const loadMore = ownedButton("load-more-archived-tasks");
  const restore = ownedButton("restore-archived-task", "thread-a");
  const remove = ownedButton("delete-archived-task", "thread-a");
  let controls = [retry, loadMore, restore, remove];
  const matching = (selector) => controls.filter((control) =>
    selector.includes(`"${control.dataset.taskAction}"`) &&
    (!selector.includes("[data-thread-id]") || control.dataset.threadId)
  );
  const list = archivedHost({
    revealed: true,
    querySelector: (selector) => matching(selector)[0] ?? null,
    querySelectorAll: matching,
  });

  const scope = list.actionHintScope();
  assert.deepEqual(scope.targets.map(({ id }) => id), [
    "task-list:archived:retry",
    "task-list:archived:load-more",
    "task-list:archived:restore-archived-task:thread-a",
    "task-list:archived:delete-archived-task:thread-a",
  ]);
  assert.ok(scope.targets.every(({ actionId }) => actionId === "button.activate"));
  scope.targets[2].activate();
  assert.equal(restore.clicks, 1);

  controls = controls.filter((control) => control !== restore);
  assert.equal(scope.targets[2].isActionable(), false);
  list.taskOperations = { ...ready, key: "blocked", blocked: true };
  assert.equal(scope.targets[0].isActionable(), false);

  list.revealed = false;
  assert.deepEqual(list.actionHintScope().targets, []);
});

test("draws nothing and stays hidden until its navigator reveals it", () => {
  const list = archivedHost({ archivedTasks: [archivedTask()] });
  assert.equal(templateHtml(list.render()), "");
  list.updated();
  assert.equal(list.hidden, true);
  assert.deepEqual(list.attributes, {});

  list.revealed = true;
  list.updated();
  assert.equal(list.hidden, false);
  assert.deepEqual(list.attributes, {
    "data-task-section": "archived",
    role: "region",
    "aria-label": "Archived Caffold Tasks",
  });
  assert.deepEqual([...list.classes], ["task-list-section"]);

  list.revealed = false;
  list.updated();
  assert.equal(list.hidden, true);
  assert.deepEqual(list.attributes, {});
  assert.deepEqual([...list.classes], []);
});

test("draws each archived Task with its status or time and its two actions", () => {
  const list = archivedHost({
    revealed: true,
    archivedTasks: [
      archivedTask(),
      archivedTask({
        threadId: "thread-b",
        title: "Beta",
        conversationAvailable: false,
        threadStatus: { type: "systemError" },
        updatedMs: Date.UTC(2026, 0, 2),
        lastCompletedMs: Date.UTC(2026, 0, 2),
      }),
    ],
    nextCursor: "cursor-2",
  });
  list.deleting.add("thread-a");

  const drawn = html(list);
  assert.match(drawn, /^<header class="task-list-section-header"><h2>Archived<\/h2><span class="task-list-section-count">2<\/span><\/header>/);
  assert.ok(drawn.indexOf("Beta") < drawn.indexOf("Alpha"), "most recent first");
  assert.match(drawn, /<li class="task-archived-row" data-thread-id="thread-b" data-task-list-key="[^"]*"><div class="task-archived-copy" title="Beta"><span class="task-row-title">Beta<\/span><span class="task-row-indicators"><caffold-task-status-chip class="task-row-meta" \.task=""><\/caffold-task-status-chip><\/span><\/div><div class="task-archived-actions"><span class="task-archived-unavailable-status" role="img" aria-label="Conversation unavailable; restore is not available"/);
  assert.match(drawn, /<button type="button" class="task-archived-action-button" data-task-action="restore-archived-task" data-thread-id="thread-a" aria-label="Restore Alpha" title="Restore task" \?disabled="true"/);
  assert.match(drawn, /<button type="button" class="task-archived-action-button task-delete-button is-loading" data-task-action="delete-archived-task" data-thread-id="thread-a" aria-label="Deleting Alpha" title="Deleting task" \?disabled="true"/);
  assert.match(drawn, /<time class="task-row-meta task-row-time" datetime="2026-01-01T00:00:00.000Z"/);
  assert.match(drawn, /<button type="button" class="task-secondary-button" data-task-action="load-more-archived-tasks" \?disabled="false" @click="">Load more archived tasks<\/button><\/div>$/);
});

test("says why the list is empty", () => {
  const draw = (properties) => html(archivedHost({ revealed: true, ...properties }));

  assert.match(draw({ loading: true }), /<caffold-loading-text>Loading...<\/caffold-loading-text>/);
  assert.match(
    draw({ error: new Error("Archive unavailable.") }),
    /<div class="task-section-message" role="alert"><p>Archive unavailable.<\/p><button type="button" class="task-secondary-button" data-task-action="retry-archived-task-list"/,
  );
  assert.match(draw({}), />No archived Caffold tasks.<\/p>/);
  assert.match(
    draw({
      taskOperations: {
        ...ready,
        key: "blocked",
        blocked: true,
        message: "The Task store is unavailable.",
      },
    }),
    />The Task store is unavailable.<\/p>/,
  );
});

// An Archived list whose host attributes and classes are plain records.
function archivedHost(properties) {
  const attributes = {};
  const classes = new Set();
  return Object.create(Archived.prototype, Object.getOwnPropertyDescriptors({
    archivedTasks: [],
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
    nextCursor: null,
    revealed: false,
    hidden: false,
    isConnected: true,
    transportState: "ready",
    taskOperations: ready,
    restoring: new Set(),
    restoreErrors: new Map(),
    deleting: new Set(),
    deleteErrors: new Map(),
    attributes,
    classes,
    classList: {
      toggle: (name, force) => (force ? classes.add(name) : classes.delete(name)),
    },
    dataset: new Proxy({}, {
      set: (_, name, value) => {
        attributes[`data-${dashed(name)}`] = value;
        return true;
      },
      deleteProperty: (_, name) => delete attributes[`data-${dashed(name)}`],
    }),
    setAttribute: (name, value) => {
      attributes[name] = value;
    },
    removeAttribute: (name) => {
      delete attributes[name];
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    ...properties,
  }));
}

function dashed(name) {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function html(list) {
  return templateHtml(list.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .replaceAll("> <", "><")
    .trim();
}
