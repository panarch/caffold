import assert from "node:assert/strict";
import test from "node:test";

import { renderTaskStatusChip } from "../frontend/pages/(codex)/tasks/components/task-status.js";
import { TASK_TRANSPORT_STATE } from "../frontend/pages/(codex)/tasks/runtime-state.js";

function activeTask(activeFlags = []) {
  return {
    threadStatus: {
      type: "active",
      activeFlags,
    },
  };
}

test("renders one canonical task status presentation for detail and list variants", () => {
  const detail = renderTaskStatusChip(
    activeTask(["waitingOnApproval"]),
    "task-detail-status",
  );
  assert.match(detail, /class="task-status-chip task-detail-status"/);
  assert.match(detail, /data-status="waiting_for_approval"/);
  assert.match(detail, /aria-label="approval"/);
  assert.match(detail, /class="task-status-label">approval/);

  const list = renderTaskStatusChip(activeTask(), "task-row-meta", {
    label: false,
  });
  assert.match(list, /data-status="running"/);
  assert.match(list, /class="task-status-spinner"/);
  assert.doesNotMatch(list, /class="task-status-label"/);
});

test("transport state changes presentation without rewriting canonical task state", () => {
  const task = activeTask();
  const html = renderTaskStatusChip(task, "", {
    transportState: TASK_TRANSPORT_STATE.UNAVAILABLE,
  });

  assert.match(html, /data-status="unavailable"/);
  assert.match(html, /aria-label="unavailable"/);
  assert.deepEqual(task.threadStatus, {
    type: "active",
    activeFlags: [],
  });
});
