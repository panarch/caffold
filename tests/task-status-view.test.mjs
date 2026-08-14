import assert from "node:assert/strict";
import test from "node:test";

import { renderTaskStatusChip } from "../frontend/pages/(task-workspace)/tasks/components/task-status.js";

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

test("transport options cannot replace canonical task presentation", () => {
  const task = activeTask();
  const html = renderTaskStatusChip(task, "", {
    transportState: "unavailable",
  });

  assert.match(html, /data-status="running"/);
  assert.match(html, /aria-label="running"/);
  assert.doesNotMatch(html, /unavailable/);
  assert.deepEqual(task.threadStatus, {
    type: "active",
    activeFlags: [],
  });
});
