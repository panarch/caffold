import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_HINT_CONTROL_EVENT,
  ACTION_HINT_CONTROL_GRAPH,
  ACTION_HINT_CONTROL_NODE,
  transitionActionHintControl,
} from "./control.js";

test("declares every Action Hint control edge and reaches every node", () => {
  assert.deepEqual(ACTION_HINT_CONTROL_GRAPH, {
    normal: {
      "entry-rejected": "normal",
      "editing-started": "editing",
      "hint-started": "hint",
    },
    editing: {
      "editing-continued": "editing",
      "editing-ended": "normal",
    },
    hint: {
      "hint-input-changed": "hint",
      "hint-cancelled": "normal",
      "hint-closed-for-activation": "normal",
    },
  });

  const reached = new Set(Object.values(ACTION_HINT_CONTROL_GRAPH).flatMap(
    (edges) => Object.values(edges),
  ));
  assert.deepEqual(
    [...reached].sort(),
    Object.values(ACTION_HINT_CONTROL_NODE).sort(),
  );
});

test("accepts only the event owned by the current Action Hint node", () => {
  for (const node of Object.values(ACTION_HINT_CONTROL_NODE)) {
    for (const event of Object.values(ACTION_HINT_CONTROL_EVENT)) {
      assert.equal(
        transitionActionHintControl(node, event),
        ACTION_HINT_CONTROL_GRAPH[node][event] ?? null,
        `${node} + ${event}`,
      );
    }
  }
  assert.equal(transitionActionHintControl("unknown", "unknown"), null);
});
