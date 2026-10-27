import assert from "node:assert/strict";
import test from "node:test";
import { ConversationProjection } from "./conversation.js";

const item = (id, time, text = id) => ({
  id, threadId: "t", type: "assistant_message",
  position: { anchorMs: time, index: 0 }, payload: { itemId: id, text },
});
const snapshot = (events, eventRevision, eventsRange) => ({ events, eventRevision, eventsRange });
const from = (time) => ({ from: { anchorMs: time, index: 0 }, to: null });

test("publication order is scoped to a snapshot's extent and a delta's identity", () => {
  const model = new ConversationProjection();
  let events = model.snapshot([], snapshot([item("one", 1)], 10, from(1)));
  events = model.snapshot(events, snapshot([item("three", 3)], 30, from(3)));
  events = model.delta(events, item("two", 2), 20);
  assert.deepEqual(events.map(({ id }) => id), ["one", "two", "three"]);
  assert.equal(model.delta(events, item("three", 3, "stale"), 29), null);
  assert.equal(model.delta(events, item("two", 2), 20), null);
});

test("late recovery adds missing records while retaining newer identities and completion", () => {
  const model = new ConversationProjection();
  let events = model.delta([], item("three", 3, "complete"), 31);
  events = model.snapshot(events, snapshot([item("one", 1), item("two", 2)], 30, from(1)));
  assert.deepEqual(events.map(({ payload }) => payload.text), ["one", "two", "complete"]);
});

test("a deletion extent rejects even an unseen stale delta and stale snapshot", () => {
  const model = new ConversationProjection();
  let events = model.snapshot([], snapshot([], 20, from(1)));
  assert.equal(model.delta(events, item("deleted", 2), 19), null);
  events = model.snapshot(events, snapshot([item("deleted", 2)], 19, from(1)));
  assert.deepEqual(events, []);
  assert.equal(model.delta(events, item("new", 2), 21).length, 1);
});

test("repeated boundaries outside membership preserve their retained content and position", () => {
  const model = new ConversationProjection();
  let events = model.snapshot([], snapshot([item("prompt", 1)], 10, from(1)));
  events = model.snapshot(events, snapshot([item("prompt", 4, "repeat"), item("answer", 5)], 20, from(3)));
  assert.equal(events[0].payload.text, "prompt");
  assert.equal(events[0].position.anchorMs, 1);
});

test("unscoped snapshots own exact identities only, and optimistic overlays survive deletion", () => {
  const model = new ConversationProjection();
  const optimistic = { ...item("local", 2), payload: { text: "pending", optimistic: true } };
  let events = model.snapshot([optimistic], snapshot([item("one", 1)], 10));
  events = model.snapshot(events, snapshot([item("one", 1, "new")], 11));
  assert.deepEqual(events.map(({ payload }) => payload.text), ["new", "pending"]);
  events = model.snapshot(events, snapshot([], 12, { from: null, to: null }));
  assert.deepEqual(events, [optimistic]);
});

test("invalid revisions are rejected and a new baseline may restart revision numbering", () => {
  const model = new ConversationProjection();
  for (const revision of [undefined, null, -1, 1.5, "12"]) {
    assert.equal(model.snapshot([], snapshot([], revision)), null);
    assert.equal(model.delta([], item("one", 1), revision), null);
  }
  let events = model.delta([], item("one", 1), 100);
  model.reset();
  events = model.snapshot(events, snapshot([item("one", 1, "restart")], 1, from(1)));
  assert.equal(events[0].payload.text, "restart");
});
