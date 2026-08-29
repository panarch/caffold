import assert from "node:assert/strict";
import test from "node:test";

import {
  LIVE_CONNECTION_EDGES,
  LIVE_CONNECTION_EFFECT,
  LIVE_CONNECTION_EVENT,
  LIVE_CONNECTION_NODE,
  transitionLiveConnection,
} from "./lifecycle.js";

const EXPECTED_EFFECT = Object.freeze({
  [LIVE_CONNECTION_EVENT.CONNECT]: LIVE_CONNECTION_EFFECT.OPEN,
  [LIVE_CONNECTION_EVENT.READY]: LIVE_CONNECTION_EFFECT.SETTLE,
  [LIVE_CONNECTION_EVENT.ERROR]: LIVE_CONNECTION_EFFECT.WAIT_TO_REPLACE,
  [LIVE_CONNECTION_EVENT.REPLACE]: LIVE_CONNECTION_EFFECT.OPEN,
  [LIVE_CONNECTION_EVENT.EXHAUST]: LIVE_CONNECTION_EFFECT.CLOSE,
  [LIVE_CONNECTION_EVENT.RETRY]: LIVE_CONNECTION_EFFECT.OPEN,
  [LIVE_CONNECTION_EVENT.SUSPEND]: LIVE_CONNECTION_EFFECT.CLOSE,
  [LIVE_CONNECTION_EVENT.RESUME]: LIVE_CONNECTION_EFFECT.OPEN,
  [LIVE_CONNECTION_EVENT.DISCONNECT]: LIVE_CONNECTION_EFFECT.CLOSE,
});

test("declares every allowed live connection edge and rejects every other event", () => {
  for (const node of Object.values(LIVE_CONNECTION_NODE)) {
    for (const event of Object.values(LIVE_CONNECTION_EVENT)) {
      const expectedNode = LIVE_CONNECTION_EDGES[node][event];
      const transition = transitionLiveConnection(node, event);
      if (expectedNode) {
        assert.equal(transition.node, expectedNode, `${node} + ${event}`);
        assert.deepEqual(
          transition.effects,
          [EXPECTED_EFFECT[event]],
          `${node} + ${event}`,
        );
      } else {
        assert.deepEqual(
          transition,
          { node, effects: [] },
          `${node} rejects ${event}`,
        );
      }
    }
  }
});

test("the declared graph reaches every live connection node", () => {
  const reached = new Set([LIVE_CONNECTION_NODE.DETACHED]);
  const pending = [LIVE_CONNECTION_NODE.DETACHED];
  while (pending.length) {
    const node = pending.shift();
    for (const next of Object.values(LIVE_CONNECTION_EDGES[node])) {
      if (!reached.has(next)) {
        reached.add(next);
        pending.push(next);
      }
    }
  }

  assert.deepEqual(
    [...reached].sort(),
    Object.values(LIVE_CONNECTION_NODE).sort(),
  );
});
