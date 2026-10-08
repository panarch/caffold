import assert from "node:assert/strict";
import test from "node:test";

import { TASK_TRANSPORT_STATE } from "../runtime-state.js";
import {
  TASK_STREAM_EDGES,
  TASK_STREAM_EVENT,
  TASK_STREAM_NODE,
  presentTaskStream,
  transitionTaskStream,
} from "./machine.js";

const NODE = TASK_STREAM_NODE;
const EVENT = TASK_STREAM_EVENT;

// Every combination of the facts and the owner's request flags that can choose
// among an edge's targets.
function* situations(type) {
  for (const visible of [true, false]) {
    for (const prepares of [true, false]) {
      for (const reconcilePending of [true, false]) {
        for (const retryBudgetLeft of [true, false]) {
          for (const sameContext of [true, false]) {
            for (const forced of [true, false]) {
              yield {
                event: { type, sameContext, forced },
                facts: { visible, prepares, reconcilePending, retryBudgetLeft },
              };
            }
          }
        }
      }
    }
  }
}

test("reaches every edge in the table and rejects every other event", () => {
  for (const node of Object.values(NODE)) {
    assert.ok(TASK_STREAM_EDGES[node], `${node} has an edge table`);
    for (const type of Object.values(EVENT)) {
      const allowed = TASK_STREAM_EDGES[node][type] ?? [];
      const reached = new Set();
      for (const { event, facts } of situations(type)) {
        const next = transitionTaskStream(node, event, facts);
        if (next !== null) {
          assert.ok(allowed.includes(next), `${node} --${type}--> ${next}`);
          reached.add(next);
        }
      }
      assert.deepEqual([...reached].sort(), [...allowed].sort(), `${node} --${type}`);
    }
  }
});

test("takes a repeated request for the same context as a new attempt only when unavailable", () => {
  const repeat = { type: EVENT.ACTIVATE, sameContext: true, forced: false };
  const visible = { visible: true };

  assert.equal(transitionTaskStream(NODE.READY, repeat, visible), null);
  assert.equal(transitionTaskStream(NODE.BACKING_OFF, repeat, visible), null);
  assert.equal(transitionTaskStream(NODE.SUSPENDED, repeat, visible), null);
  assert.equal(
    transitionTaskStream(NODE.UNAVAILABLE, repeat, visible),
    NODE.SUBSCRIBING,
  );
  assert.equal(
    transitionTaskStream(NODE.UNAVAILABLE, repeat, { visible: false }),
    null,
  );
});

test("keeps a recovery reading that settles before the channel is ready as data", () => {
  for (const node of [NODE.SUBSCRIBING, NODE.PREPARING]) {
    for (const type of [EVENT.RECONCILED, EVENT.RECONCILE_FAILED]) {
      assert.equal(
        transitionTaskStream(node, { type }, { retryBudgetLeft: true }),
        node,
      );
    }
  }
  assert.equal(
    transitionTaskStream(NODE.RECONCILING, { type: EVENT.RECONCILED }, {}),
    NODE.READY,
  );
  assert.equal(
    transitionTaskStream(
      NODE.RECONCILING,
      { type: EVENT.RECONCILE_FAILED },
      { retryBudgetLeft: false },
    ),
    NODE.UNAVAILABLE,
  );
});

test("goes from an opened channel through preparation and reading only when needed", () => {
  const opened = { type: EVENT.CHANNEL_OPENED };

  assert.equal(
    transitionTaskStream(NODE.SUBSCRIBING, opened, { prepares: true }),
    NODE.PREPARING,
  );
  assert.equal(
    transitionTaskStream(NODE.SUBSCRIBING, opened, { reconcilePending: true }),
    NODE.RECONCILING,
  );
  assert.equal(
    transitionTaskStream(NODE.SUBSCRIBING, opened, {}),
    NODE.READY,
  );
  // A reopened subscription always reads again, so it never goes straight to
  // ready from these nodes.
  for (const node of [
    NODE.SUSPENDED,
    NODE.WAITING_FOR_GATEWAY,
    NODE.UNAVAILABLE,
  ]) {
    assert.equal(transitionTaskStream(node, opened, {}), null);
  }
});

test("presents waiting on the gateway or a backoff as reconnecting", () => {
  const quiet = { validating: false, needsReconcile: false };

  assert.equal(presentTaskStream(NODE.INACTIVE, quiet), TASK_TRANSPORT_STATE.IDLE);
  assert.equal(presentTaskStream(NODE.SUSPENDED, quiet), TASK_TRANSPORT_STATE.IDLE);
  assert.equal(presentTaskStream(NODE.READY, quiet), TASK_TRANSPORT_STATE.READY);
  assert.equal(
    presentTaskStream(NODE.UNAVAILABLE, quiet),
    TASK_TRANSPORT_STATE.UNAVAILABLE,
  );
  for (const node of [NODE.WAITING_FOR_GATEWAY, NODE.BACKING_OFF]) {
    assert.equal(presentTaskStream(node, quiet), TASK_TRANSPORT_STATE.RECONNECTING);
  }
  for (const node of [NODE.SUBSCRIBING, NODE.PREPARING, NODE.RECONCILING]) {
    assert.equal(presentTaskStream(node, quiet), TASK_TRANSPORT_STATE.CONNECTING);
    assert.equal(
      presentTaskStream(node, { validating: false, needsReconcile: true }),
      TASK_TRANSPORT_STATE.RECONNECTING,
    );
    assert.equal(
      presentTaskStream(node, { validating: true, needsReconcile: true }),
      TASK_TRANSPORT_STATE.VALIDATING,
    );
  }
});
