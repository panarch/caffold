import assert from "node:assert/strict";
import test from "node:test";

import {
  edgeScrollDirection,
  TOUCH_GESTURE_EFFECT,
  TOUCH_GESTURE_EVENT,
  TOUCH_GESTURE_NODE,
  touchGestureTransition,
} from "./touch-gesture.js";

const { IDLE, PRESSING, SCROLLING, SELECTING } = TOUCH_GESTURE_NODE;
const { PRESS, ABANDON, MOVE, HOLD_ELAPSED, EDGE_TICK, LIFT } = TOUCH_GESTURE_EVENT;
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

test("a finger pressed on the screen starts the hold", () => {
  assert.deepEqual(apply(IDLE, { type: PRESS }), [PRESSING, [START_HOLD]]);
});

test("fingers that arrive together are left to the browser", () => {
  assert.deepEqual(apply(IDLE, { type: ABANDON }), [IDLE, []]);
});

test("a finger that moves past the slack scrolls instead of selecting", () => {
  assert.deepEqual(apply(PRESSING, { type: MOVE, pastSlop: false }), [PRESSING, []]);
  assert.deepEqual(
    apply(PRESSING, { type: MOVE, pastSlop: true }),
    [SCROLLING, [CANCEL_HOLD, SCROLL]],
  );
  assert.deepEqual(apply(SCROLLING, { type: MOVE, pastSlop: true }), [SCROLLING, [SCROLL]]);
  // Coming back near where it pressed does not make a scroll a hold again.
  assert.deepEqual(apply(SCROLLING, { type: MOVE, pastSlop: false }), [SCROLLING, [SCROLL]]);
});

test("a finger held still selects the word under it and watches the edges", () => {
  assert.deepEqual(
    apply(PRESSING, { type: HOLD_ELAPSED }),
    [SELECTING, [SELECT_WORD, START_EDGE_SCROLL]],
  );
});

test("a selecting finger stretches the selection and scrolls at an edge", () => {
  assert.deepEqual(apply(SELECTING, { type: MOVE, pastSlop: true }), [SELECTING, [STRETCH_SELECTION]]);
  assert.deepEqual(apply(SELECTING, { type: MOVE, pastSlop: false }), [SELECTING, [STRETCH_SELECTION]]);
  assert.deepEqual(apply(SELECTING, { type: EDGE_TICK }), [SELECTING, [EDGE_SCROLL]]);
});

test("lifting a tap dismisses a selection, and lifting a selection keeps it from becoming a tap", () => {
  assert.deepEqual(apply(PRESSING, { type: LIFT }), [IDLE, [CANCEL_HOLD, DISMISS_SELECTION]]);
  assert.deepEqual(apply(SELECTING, { type: LIFT }), [IDLE, [STOP_EDGE_SCROLL, CLAIM_LIFT]]);
  assert.deepEqual(apply(SCROLLING, { type: LIFT }), [IDLE, []]);
});

test("a second finger or a cancelled touch ends every gesture and its timers", () => {
  assert.deepEqual(apply(PRESSING, { type: ABANDON }), [IDLE, [CANCEL_HOLD]]);
  assert.deepEqual(apply(SCROLLING, { type: ABANDON }), [IDLE, []]);
  // The selection made so far stays; only the edge timer stops.
  assert.deepEqual(apply(SELECTING, { type: ABANDON }), [IDLE, [STOP_EDGE_SCROLL]]);
});

test("timers that fire after their phase ended are not taken", () => {
  for (const node of [IDLE, SCROLLING, SELECTING]) {
    assert.equal(touchGestureTransition(node, { type: HOLD_ELAPSED }), null, node);
  }
  for (const node of [IDLE, PRESSING, SCROLLING]) {
    assert.equal(touchGestureTransition(node, { type: EDGE_TICK }), null, node);
  }
});

test("without a finger down nothing moves or lifts, and a finger already down does not press again", () => {
  assert.equal(touchGestureTransition(IDLE, { type: MOVE, pastSlop: true }), null);
  assert.equal(touchGestureTransition(IDLE, { type: LIFT }), null);
  for (const node of [PRESSING, SCROLLING, SELECTING]) {
    assert.equal(touchGestureTransition(node, { type: PRESS }), null, node);
  }
});

test("the top and bottom rows scroll the history, except the row the finger pressed on", () => {
  const rows = 24;
  assert.equal(edgeScrollDirection(10, rows, 10), 0);
  assert.equal(edgeScrollDirection(0, rows, 10), -1);
  assert.equal(edgeScrollDirection(-3, rows, 10), -1);
  assert.equal(edgeScrollDirection(23, rows, 10), 1);
  assert.equal(edgeScrollDirection(30, rows, 10), 1);
  assert.equal(edgeScrollDirection(0, rows, 0), 0);
  assert.equal(edgeScrollDirection(23, rows, 23), 0);
  // Leaving the screen still scrolls from the row it pressed on.
  assert.equal(edgeScrollDirection(-1, rows, 0), -1);
  assert.equal(edgeScrollDirection(24, rows, 23), 1);
});

function apply(node, event) {
  const result = touchGestureTransition(node, event);
  assert.ok(result, `${node} takes ${event.type}`);
  return [result.node, [...result.effects]];
}
