import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../../../../../../../tests/support/custom-element-unit.js";
import { templateHtml } from "../../../../../../../../tests/support/lit-template.js";

const registry = installCustomElementUnitRegistry();
await import("./row.ts");
const { ActionHints } = await import("#app/action-hints.ts");
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
  const row = Object.create(Row.prototype, Object.getOwnPropertyDescriptors({
    isConnected: true,
    ...properties,
  }));
  row.hints = new ActionHints(row);
  return row;
}

function html(row) {
  return templateHtml(row.render())
    .replace(/\s+/g, " ")
    .replaceAll(" >", ">")
    .trim();
}
