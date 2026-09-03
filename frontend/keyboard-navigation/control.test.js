import assert from "node:assert/strict";
import test from "node:test";

import {
  KEYBOARD_NAVIGATION_EVENT,
  KEYBOARD_NAVIGATION_GRAPH,
  KEYBOARD_NAVIGATION_NODE,
  transitionKeyboardNavigation,
} from "./control.js";

test("declares every keyboard navigation edge and reaches every node", () => {
  assert.deepEqual(KEYBOARD_NAVIGATION_GRAPH, {
    normal: {
      "entry-rejected": "normal",
      "editing-started": "editing",
      "hint-started": "hint",
      "scroll-selection-started": "scroll-selecting",
      "scroll-started": "scroll-active",
      "shortcut-help-started": "shortcut-help",
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
    "scroll-selecting": {
      "scroll-selection-input-changed": "scroll-selecting",
      "scroll-selection-cancelled": "normal",
      "scroll-surface-selected": "scroll-active",
    },
    "scroll-active": {
      "scroll-command": "scroll-active",
      "scroll-cancelled": "normal",
    },
    "shortcut-help": {
      "shortcut-help-closed": "normal",
    },
  });
  const reached = new Set(Object.values(KEYBOARD_NAVIGATION_GRAPH).flatMap(
    (edges) => Object.values(edges),
  ));
  assert.deepEqual(
    [...reached].sort(),
    Object.values(KEYBOARD_NAVIGATION_NODE).sort(),
  );
});

test("rejects every event not owned by the current keyboard node", () => {
  for (const node of Object.values(KEYBOARD_NAVIGATION_NODE)) {
    for (const event of Object.values(KEYBOARD_NAVIGATION_EVENT)) {
      assert.equal(
        transitionKeyboardNavigation(node, event),
        KEYBOARD_NAVIGATION_GRAPH[node][event] ?? null,
        `${node} + ${event}`,
      );
    }
  }
  assert.equal(transitionKeyboardNavigation("unknown", "unknown"), null);
});
