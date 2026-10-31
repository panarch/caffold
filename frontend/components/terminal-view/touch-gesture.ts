// What one finger on the terminal screen is doing. A finger that moves right
// away scrolls the history; one held in place selects the word under it and
// then stretches the selection as it moves, scrolling the history while it
// rests on the screen's top or bottom row. A tap while text is selected only
// clears the selection. The terminal view turns touch events and its two
// timers into these events and runs the effects; this model knows no DOM and
// no time.

export const TOUCH_GESTURE_NODE = Object.freeze({
  IDLE: "idle",
  // One finger is down and has not moved far; the hold timer runs.
  PRESSING: "pressing",
  SCROLLING: "scrolling",
  // The hold ended on a word, and the finger now stretches the selection.
  SELECTING: "selecting",
});

export type TouchGestureNode =
  (typeof TOUCH_GESTURE_NODE)[keyof typeof TOUCH_GESTURE_NODE];

export const TOUCH_GESTURE_EVENT = Object.freeze({
  // One finger touched a screen no other finger was on.
  PRESS: "press",
  // Another finger joined, or the browser took the touch away.
  ABANDON: "abandon",
  MOVE: "move",
  HOLD_ELAPSED: "hold-elapsed",
  EDGE_TICK: "edge-tick",
  LIFT: "lift",
});

type TouchGestureEventType =
  (typeof TOUCH_GESTURE_EVENT)[keyof typeof TOUCH_GESTURE_EVENT];

export interface TouchGestureEvent {
  type: TouchGestureEventType;
  // For a move: whether the finger is now farther than a tap's slack from
  // where it pressed.
  pastSlop?: boolean;
}

export const TOUCH_GESTURE_EFFECT = Object.freeze({
  START_HOLD: "start-hold",
  CANCEL_HOLD: "cancel-hold",
  SCROLL: "scroll",
  SELECT_WORD: "select-word",
  STRETCH_SELECTION: "stretch-selection",
  // While selecting, a timer asks every so often whether the finger rests on
  // an edge row, and scrolls a row that way if it does.
  START_EDGE_SCROLL: "start-edge-scroll",
  EDGE_SCROLL: "edge-scroll",
  STOP_EDGE_SCROLL: "stop-edge-scroll",
  // A tap: with text selected it only clears the selection and goes no
  // further; without, it goes on as a tap.
  DISMISS_SELECTION: "dismiss-selection",
  // The lift ends a selection, so the browser makes no tap of it.
  CLAIM_LIFT: "claim-lift",
});

export type TouchGestureEffect =
  (typeof TOUCH_GESTURE_EFFECT)[keyof typeof TOUCH_GESTURE_EFFECT];

const { IDLE, PRESSING, SCROLLING, SELECTING } = TOUCH_GESTURE_NODE;
const {
  START_HOLD,
  CANCEL_HOLD,
  SCROLL,
  SELECT_WORD,
  STRETCH_SELECTION,
  START_EDGE_SCROLL,
  EDGE_SCROLL,
  STOP_EDGE_SCROLL,
  DISMISS_SELECTION,
  CLAIM_LIFT,
} = TOUCH_GESTURE_EFFECT;

/**
 * Applies one event. Returns the next node and the effects to run, or null
 * when the current node does not accept the event.
 */
export function touchGestureTransition(
  node: TouchGestureNode,
  event: TouchGestureEvent,
): { node: TouchGestureNode; effects: readonly TouchGestureEffect[] } | null {
  switch (`${node}:${event.type}`) {
    case `${IDLE}:${TOUCH_GESTURE_EVENT.PRESS}`:
      return edge(PRESSING, START_HOLD);
    case `${IDLE}:${TOUCH_GESTURE_EVENT.ABANDON}`:
      return edge(IDLE);
    case `${PRESSING}:${TOUCH_GESTURE_EVENT.MOVE}`:
      return event.pastSlop
        ? edge(SCROLLING, CANCEL_HOLD, SCROLL)
        : edge(PRESSING);
    case `${PRESSING}:${TOUCH_GESTURE_EVENT.HOLD_ELAPSED}`:
      return edge(SELECTING, SELECT_WORD, START_EDGE_SCROLL);
    case `${PRESSING}:${TOUCH_GESTURE_EVENT.LIFT}`:
      return edge(IDLE, CANCEL_HOLD, DISMISS_SELECTION);
    case `${PRESSING}:${TOUCH_GESTURE_EVENT.ABANDON}`:
      return edge(IDLE, CANCEL_HOLD);
    case `${SCROLLING}:${TOUCH_GESTURE_EVENT.MOVE}`:
      return edge(SCROLLING, SCROLL);
    case `${SCROLLING}:${TOUCH_GESTURE_EVENT.LIFT}`:
    case `${SCROLLING}:${TOUCH_GESTURE_EVENT.ABANDON}`:
      return edge(IDLE);
    case `${SELECTING}:${TOUCH_GESTURE_EVENT.MOVE}`:
      return edge(SELECTING, STRETCH_SELECTION);
    case `${SELECTING}:${TOUCH_GESTURE_EVENT.EDGE_TICK}`:
      return edge(SELECTING, EDGE_SCROLL);
    case `${SELECTING}:${TOUCH_GESTURE_EVENT.LIFT}`:
      return edge(IDLE, STOP_EDGE_SCROLL, CLAIM_LIFT);
    case `${SELECTING}:${TOUCH_GESTURE_EVENT.ABANDON}`:
      // The selection made so far stays.
      return edge(IDLE, STOP_EDGE_SCROLL);
    default:
      return null;
  }
}

/**
 * Which way a selecting finger scrolls the history: -1 up, 1 down, 0 not at
 * all. The top and bottom rows count as edges, except the row the finger
 * pressed on, so a word held there does not start the history moving.
 * `row` is the screen row under the finger and may lie outside the screen.
 */
export function edgeScrollDirection(
  row: number,
  rows: number,
  pressedRow: number,
) {
  if (row < 0 || (row === 0 && pressedRow !== 0)) {
    return -1;
  }
  if (row > rows - 1 || (row === rows - 1 && pressedRow !== rows - 1)) {
    return 1;
  }
  return 0;
}

function edge(node: TouchGestureNode, ...effects: TouchGestureEffect[]) {
  return Object.freeze({ node, effects: Object.freeze(effects) });
}
