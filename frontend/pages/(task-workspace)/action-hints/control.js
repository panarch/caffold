export const ACTION_HINT_CONTROL_NODE = Object.freeze({
  NORMAL: "normal",
  EDITING: "editing",
  HINT: "hint",
});

export const ACTION_HINT_CONTROL_EVENT = Object.freeze({
  ENTRY_REJECTED: "entry-rejected",
  EDITING_STARTED: "editing-started",
  EDITING_CONTINUED: "editing-continued",
  EDITING_ENDED: "editing-ended",
  HINT_STARTED: "hint-started",
  HINT_INPUT_CHANGED: "hint-input-changed",
  HINT_CANCELLED: "hint-cancelled",
  HINT_CLOSED_FOR_ACTIVATION: "hint-closed-for-activation",
});

// Normal and Editing are derived from focus/composition. Hint is the only
// stored node, but every controller-owned node change still passes through
// this complete event table.
export const ACTION_HINT_CONTROL_GRAPH = Object.freeze({
  [ACTION_HINT_CONTROL_NODE.NORMAL]: Object.freeze({
    [ACTION_HINT_CONTROL_EVENT.ENTRY_REJECTED]:
      ACTION_HINT_CONTROL_NODE.NORMAL,
    [ACTION_HINT_CONTROL_EVENT.EDITING_STARTED]:
      ACTION_HINT_CONTROL_NODE.EDITING,
    [ACTION_HINT_CONTROL_EVENT.HINT_STARTED]: ACTION_HINT_CONTROL_NODE.HINT,
  }),
  [ACTION_HINT_CONTROL_NODE.EDITING]: Object.freeze({
    [ACTION_HINT_CONTROL_EVENT.EDITING_CONTINUED]:
      ACTION_HINT_CONTROL_NODE.EDITING,
    [ACTION_HINT_CONTROL_EVENT.EDITING_ENDED]:
      ACTION_HINT_CONTROL_NODE.NORMAL,
  }),
  [ACTION_HINT_CONTROL_NODE.HINT]: Object.freeze({
    [ACTION_HINT_CONTROL_EVENT.HINT_INPUT_CHANGED]:
      ACTION_HINT_CONTROL_NODE.HINT,
    [ACTION_HINT_CONTROL_EVENT.HINT_CANCELLED]:
      ACTION_HINT_CONTROL_NODE.NORMAL,
    [ACTION_HINT_CONTROL_EVENT.HINT_CLOSED_FOR_ACTIVATION]:
      ACTION_HINT_CONTROL_NODE.NORMAL,
  }),
});

export const ACTION_HINT_ACTIVATE_EVENT = "caffold:action-hint-activate";
export const ACTION_HINT_CANCEL_EVENT = "caffold:action-hint-cancel";

export function transitionActionHintControl(node, event) {
  return ACTION_HINT_CONTROL_GRAPH[node]?.[event] ?? null;
}
