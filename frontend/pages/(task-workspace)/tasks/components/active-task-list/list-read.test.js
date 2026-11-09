import assert from "node:assert/strict";
import test from "node:test";

import {
  LIST_READ_EFFECT,
  LIST_READ_EVENT,
  LIST_READ_NODE,
  transitionListRead,
} from "./list-read.js";

const NODE = LIST_READ_NODE;
const EVENT = LIST_READ_EVENT;
const EFFECT = LIST_READ_EFFECT;

// The graph written out once more, so any change to an edge shows here.
const EDGES = [
  [NODE.IDLE, EVENT.READ, NODE.READING, EFFECT.START],
  [NODE.IDLE, EVENT.REFRESH, NODE.READING, EFFECT.START],
  [NODE.IDLE, EVENT.CHANGED, NODE.IDLE, EFFECT.NONE],
  [NODE.IDLE, EVENT.DETACHED, NODE.IDLE, EFFECT.NONE],
  [NODE.READING, EVENT.READ, NODE.READING, EFFECT.NONE],
  [NODE.READING, EVENT.REFRESH, NODE.SUPERSEDED, EFFECT.NONE],
  [NODE.READING, EVENT.CHANGED, NODE.SUPERSEDED, EFFECT.NONE],
  [NODE.READING, EVENT.ANSWERED, NODE.IDLE, EFFECT.SHOW],
  [NODE.READING, EVENT.FAILED, NODE.IDLE, EFFECT.FAIL],
  [NODE.READING, EVENT.DETACHED, NODE.IDLE, EFFECT.ABANDON],
  [NODE.SUPERSEDED, EVENT.READ, NODE.SUPERSEDED, EFFECT.NONE],
  [NODE.SUPERSEDED, EVENT.REFRESH, NODE.SUPERSEDED, EFFECT.NONE],
  [NODE.SUPERSEDED, EVENT.CHANGED, NODE.SUPERSEDED, EFFECT.NONE],
  [NODE.SUPERSEDED, EVENT.ANSWERED, NODE.READING, EFFECT.RESTART],
  [NODE.SUPERSEDED, EVENT.FAILED, NODE.READING, EFFECT.RESTART],
  [NODE.SUPERSEDED, EVENT.DETACHED, NODE.IDLE, EFFECT.ABANDON],
];

function walk(start, events) {
  const effects = [];
  let node = start;
  for (const event of events) {
    const transition = transitionListRead(node, event);
    assert.ok(transition, `${node} accepts ${event}`);
    node = transition.node;
    effects.push(transition.effect);
  }
  return { node, effects };
}

test("follows every edge of the read graph and rejects every other event", () => {
  const expected = new Map(
    EDGES.map(([node, event, next, effect]) => [
      `${node} ${event}`,
      { node: next, effect },
    ]),
  );
  for (const node of Object.values(NODE)) {
    for (const event of Object.values(EVENT)) {
      assert.deepEqual(
        transitionListRead(node, event),
        expected.get(`${node} ${event}`) ?? null,
        `${node} on ${event}`,
      );
    }
  }
});

test("drops an answer or failure that arrives when no read is in flight", () => {
  assert.equal(transitionListRead(NODE.IDLE, EVENT.ANSWERED), null);
  assert.equal(transitionListRead(NODE.IDLE, EVENT.FAILED), null);
});

test("shows no answer read before a change, however the change arrived", () => {
  for (const change of [EVENT.CHANGED, EVENT.REFRESH]) {
    assert.deepEqual(
      walk(NODE.IDLE, [EVENT.READ, change, EVENT.ANSWERED, EVENT.ANSWERED]),
      {
        node: NODE.IDLE,
        effects: [EFFECT.START, EFFECT.NONE, EFFECT.RESTART, EFFECT.SHOW],
      },
      change,
    );
  }
});

test("reads again when a superseded read fails, and shows that read", () => {
  assert.deepEqual(
    walk(NODE.IDLE, [EVENT.READ, EVENT.CHANGED, EVENT.FAILED, EVENT.ANSWERED]),
    {
      node: NODE.IDLE,
      effects: [EFFECT.START, EFFECT.NONE, EFFECT.RESTART, EFFECT.SHOW],
    },
  );
});

test("lets callers join a current read without starting another", () => {
  assert.deepEqual(walk(NODE.IDLE, [EVENT.READ, EVENT.READ, EVENT.ANSWERED]), {
    node: NODE.IDLE,
    effects: [EFFECT.START, EFFECT.NONE, EFFECT.SHOW],
  });
});

test("abandons a read in flight when the list leaves the document", () => {
  assert.deepEqual(walk(NODE.IDLE, [EVENT.READ, EVENT.DETACHED]), {
    node: NODE.IDLE,
    effects: [EFFECT.START, EFFECT.ABANDON],
  });
  assert.deepEqual(
    walk(NODE.IDLE, [EVENT.REFRESH, EVENT.CHANGED, EVENT.DETACHED]),
    {
      node: NODE.IDLE,
      effects: [EFFECT.START, EFFECT.NONE, EFFECT.ABANDON],
    },
  );
});
