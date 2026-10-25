import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./row.ts");
const Row = registry.element("caffold-active-task-row");
after(() => registry.restore());

const taskOperations = {
  key: "ready",
  phase: "ready",
  blocked: false,
  title: "",
  message: "",
};

function listedTask(overrides = {}) {
  return {
    threadId: "thread-a",
    title: "Alpha",
    threadStatus: { type: "idle" },
    unseen: false,
    lastCompletedMs: Date.UTC(2026, 0, 1),
    recencyMs: null,
    updatedMs: Date.UTC(2026, 0, 1),
    worktree: false,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    task: listedTask(),
    selectedThreadId: "",
    taskOperations,
    reorderMode: false,
    reorderable: true,
    pending: false,
    ...overrides,
  };
}

test("offers its open button as the Task's Action Hint target", () => {
  const clipRoot = {};
  const clipRoots = [clipRoot];
  const focusOptions = [];
  let clicks = 0;
  let currentControl = {
    dataset: { activeTaskRowAction: "open-task" },
    disabled: false,
    focus(options) {
      focusOptions.push(options);
    },
    click() {
      clicks += 1;
    },
  };
  const row = rowHost({
    snapshot: snapshot(),
    querySelector: () => currentControl,
  });

  const target = row.actionHintTarget({ clipRoots });

  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      label: target.label,
      controlKind: target.controlKind,
    },
    {
      id: "task:thread-a",
      actionId: "task.open",
      label: "Open task: Alpha",
      controlKind: "button",
    },
  );
  assert.equal(target.control, currentControl);
  assert.equal(target.anchor, currentControl);
  assert.deepEqual(target.clipRoots, [clipRoot]);
  assert.notEqual(target.clipRoots, clipRoots);
  assert.equal(target.isActionable(), true);

  target.activate();
  assert.deepEqual(focusOptions, [{ preventScroll: true }]);
  assert.equal(clicks, 1);

  currentControl.dataset.activeTaskRowAction = "open-task-recovery";
  assert.equal(target.isActionable(), false);
  const recovery = row.actionHintTarget();
  assert.equal(recovery.actionId, "task.open-recovery");
  assert.equal(recovery.label, "Open task recovery: Alpha");

  currentControl = { ...currentControl };
  assert.equal(recovery.isActionable(), false);
});

test("offers its reorder handle as a focus-only target while Tasks reorder", () => {
  let focused = 0;
  let clicks = 0;
  let control = {
    disabled: false,
    getAttribute: () => "Reorder Alpha. Use Up and Down arrow keys to move.",
    focus() {
      focused += 1;
    },
    click() {
      clicks += 1;
    },
  };
  const row = rowHost({
    isConnected: true,
    snapshot: snapshot({ reorderMode: true }),
    querySelector: () => control,
  });

  const target = row.reorderActionHintTarget({
    clipRoots: [{ id: "task-list" }],
  });
  assert.deepEqual(
    {
      id: target.id,
      actionId: target.actionId,
      controlKind: target.controlKind,
      label: target.label,
    },
    {
      id: "task:thread-a:reorder",
      actionId: "task.reorder.handle.focus",
      controlKind: "reorder-handle",
      label: "Reorder Alpha. Use Up and Down arrow keys to move.",
    },
  );
  target.activate();
  assert.equal(focused, 1);
  assert.equal(clicks, 0);

  row.snapshot = snapshot({ reorderMode: true, pending: true });
  assert.equal(target.isActionable(), false);
  assert.equal(row.reorderActionHintTarget(), null);
  row.snapshot = snapshot({ reorderMode: true });
  control = { ...control };
  assert.equal(target.isActionable(), false);
  row.snapshot = snapshot();
  assert.equal(row.reorderActionHintTarget(), null);
});

test("draws one thing beside the title: recovery, an unseen finish, the agent's status, or the time", () => {
  const draw = (overrides) => html(rowHost({ snapshot: snapshot(overrides) }));

  const idle = draw();
  assert.match(idle, /^<button type="button" class="task-row" data-active-task-row-action="open-task" data-thread-id="thread-a" data-task-status="idle"/);
  assert.match(idle, /<time class="task-row-meta task-row-time" datetime="2026-01-01T00:00:00.000Z"/);

  const running = draw({
    task: listedTask({ threadStatus: { type: "active", activeFlags: [] } }),
  });
  assert.match(running, /aria-busy="true"/);
  assert.match(running, /<caffold-task-status-chip class="task-row-meta" \.task="" staggered><\/caffold-task-status-chip>/);

  const unseen = draw({ task: listedTask({ unseen: true }) });
  assert.match(unseen, /class="task-row-meta task-unseen-complete"[^>]*style="--task-unseen-attention-delay: -\d+ms"/);
  assert.doesNotMatch(
    draw({ task: listedTask({ unseen: true }), selectedThreadId: "thread-a" }),
    /task-unseen-complete/,
    "the open Task has been seen",
  );

  const recovery = draw({
    task: listedTask({
      recovery: { reason: "codexArchived", actions: ["restoreToActive"] },
    }),
  });
  assert.match(recovery, /data-active-task-row-action="open-task-recovery"/);
  assert.match(recovery, /data-task-recovery-reason="codexArchived"/);
  assert.match(recovery, /title="Alpha — Archived in Codex"/);
  assert.match(recovery, /<span class="task-row-recovery-status" title="Archived in Codex">/);
});

test("draws the title beside a handle while Tasks reorder", () => {
  const reordering = html(rowHost({ snapshot: snapshot({ reorderMode: true }) }));
  assert.match(reordering, /^<div class="task-row task-row-reorder-mode"/);
  assert.match(reordering, /<button type="button" class="task-reorder-handle" aria-label="Reorder Alpha. Use Up and Down arrow keys to move."/);

  const recovery = html(
    rowHost({ snapshot: snapshot({ reorderMode: true, reorderable: false }) }),
  );
  assert.match(recovery, /^<button type="button" class="task-row"/);
});

function rowHost(properties) {
  return Object.create(Row.prototype, Object.getOwnPropertyDescriptors({
    isConnected: true,
    querySelector: () => null,
    ...properties,
  }));
}

function html(row) {
  return templateHtml(row.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .trim();
}
