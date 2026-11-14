import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./archived-task-list.js");
const { ActionHints } = await import("#app/action-hints.js");
const Archived = registry.element("caffold-archived-task-list");
after(() => registry.restore());

const ready = {
  key: "ready",
  phase: "ready",
  blocked: false,
  title: "",
  message: "",
};

function archivedTask(overrides = {}) {
  return {
    threadId: "thread-a",
    title: "Alpha",
    conversationAvailable: true,
    cwd: "/repo/alpha",
    cwdPath: "/repo/alpha",
    relativeCwd: "",
    worktree: null,
    createdMs: Date.UTC(2026, 0, 1),
    updatedMs: Date.UTC(2026, 0, 1),
    recencyMs: null,
    lastCompletedMs: Date.UTC(2026, 0, 1),
    repositoryPath: null,
    ...overrides,
  };
}

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

test("stays hidden while the server has answered that no Task is archived", () => {
  const list = archivedHost({ revealed: true, loaded: true });
  const visible = () => {
    list.updated();
    const drawn = templateHtml(list.render()) !== "";
    assert.equal(drawn, !list.hidden);
    return drawn;
  };

  assert.equal(visible(), false);
  assert.deepEqual(list.attributes, {});

  list.loading = true;
  assert.equal(visible(), false, "a refresh does not show it to say Loading");
  list.loading = false;

  list.taskOperations = { ...ready, key: "blocked", blocked: true, message: "The Task store is unavailable." };
  assert.equal(visible(), false);
  list.taskOperations = ready;

  list.nextCursor = "cursor-2";
  assert.equal(visible(), true, "a further page may hold Tasks");
  list.nextCursor = null;
  assert.equal(visible(), false);

  list.archivedTasks = [archivedTask()];
  assert.equal(visible(), true);
  assert.equal(list.attributes.role, "region");
  list.archivedTasks = [];
  assert.equal(visible(), false);

  list.loaded = false;
  list.error = new Error("Archive unavailable.");
  assert.equal(visible(), true, "an unread list says why");
});

test("draws each archived Task with its time, availability and two actions", () => {
  const list = archivedHost({
    revealed: true,
    archivedTasks: [
      archivedTask(),
      archivedTask({
        threadId: "thread-b",
        title: "Beta",
        conversationAvailable: false,
        updatedMs: Date.UTC(2026, 0, 2),
        lastCompletedMs: Date.UTC(2026, 0, 2),
      }),
    ],
    nextCursor: "cursor-2",
  });
  list.deleting.add("thread-a");

  const drawn = html(list);
  assert.doesNotMatch(drawn, /caffold-task-status-chip/);
  assert.match(drawn, /^<header class="task-list-section-header"><h2>Archived<\/h2><span class="task-list-section-count">2<\/span><\/header>/);
  assert.ok(drawn.indexOf("Beta") < drawn.indexOf("Alpha"), "most recent first");
  assert.match(drawn, /<li class="task-archived-row" data-thread-id="thread-b" data-task-list-key="[^"]*"><div class="task-archived-copy" title="Beta"><span class="task-row-title">Beta<\/span><span class="task-row-indicators"><time class="task-row-meta task-row-time" datetime="2026-01-02T00:00:00.000Z"[^>]*>[^<]*<\/time><\/span><\/div><div class="task-archived-actions"><span class="task-archived-unavailable-status" role="img" aria-label="Conversation unavailable; restore is not available"/);
  assert.match(drawn, /<button type="button" class="task-archived-action-button" data-task-action="restore-archived-task" data-thread-id="thread-a" aria-label="Restore Alpha" title="Restore task" \?disabled="true"/);
  assert.match(drawn, /<button type="button" class="task-archived-action-button task-delete-button is-loading" data-task-action="delete-archived-task" data-thread-id="thread-a" aria-label="Deleting Alpha" title="Deleting task" \?disabled="true"/);
  assert.match(drawn, /<time class="task-row-meta task-row-time" datetime="2026-01-01T00:00:00.000Z"/);
  assert.match(drawn, /<button type="button" class="task-secondary-button" data-task-action="load-more-archived-tasks" \?disabled="false" @click="">Load more archived tasks<\/button><\/div>$/);
});

test("uses completion, recency, then update time for archived row metadata", () => {
  const times = [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 3)];
  for (const [lastCompletedMs, recencyMs, expected] of [
    [times[0], times[1], times[0]],
    [null, times[1], times[1]],
    [null, null, times[2]],
  ]) {
    const list = archivedHost({ revealed: true, archivedTasks: [archivedTask({
      lastCompletedMs, recencyMs, updatedMs: times[2],
    })] });
    assert.ok(html(list).includes(`datetime="${new Date(expected).toISOString()}"`));
  }
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
  const list = Object.create(Archived.prototype, Object.getOwnPropertyDescriptors({
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
    ...properties,
  }));
  list.hints = new ActionHints(list);
  return list;
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
