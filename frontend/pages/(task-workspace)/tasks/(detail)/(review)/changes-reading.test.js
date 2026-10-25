import assert from "node:assert/strict";
import test from "node:test";

import { ChangesReading } from "./changes-reading.ts";

const facts = {
  empty: { hasData: false, fromBeforeReturn: false, reading: false, failed: false },
  loading: { hasData: false, fromBeforeReturn: false, reading: true, failed: false },
  failed: { hasData: false, fromBeforeReturn: false, reading: false, failed: true },
  current: { hasData: true, fromBeforeReturn: false, reading: false, failed: false },
  outdated: { hasData: true, fromBeforeReturn: true, reading: false, failed: false },
  rereading: { hasData: true, fromBeforeReturn: true, reading: true, failed: false },
  rereadFailed: { hasData: true, fromBeforeReturn: true, reading: false, failed: true },
};

// The events that lead from a new reading to each state.
const paths = {
  empty: [],
  loading: ["start"],
  failed: ["start", "fail"],
  current: ["start", "succeed"],
  outdated: ["start", "succeed", "markReturned"],
  rereading: ["start", "succeed", "markReturned", "start"],
  rereadFailed: ["start", "succeed", "markReturned", "start", "fail"],
};

// Where each event leads from each state; null means the event is rejected.
const edges = {
  empty: { start: "loading", succeed: null, fail: null, markReturned: "empty", reset: "empty" },
  loading: { start: "loading", succeed: "current", fail: "failed", markReturned: "empty", reset: "empty" },
  failed: { start: "loading", succeed: null, fail: null, markReturned: "failed", reset: "empty" },
  current: { start: "current", succeed: "current", fail: "current", markReturned: "outdated", reset: "empty" },
  outdated: { start: "rereading", succeed: null, fail: null, markReturned: "outdated", reset: "empty" },
  rereading: { start: "rereading", succeed: "current", fail: "rereadFailed", markReturned: "outdated", reset: "empty" },
  rereadFailed: { start: "rereading", succeed: null, fail: null, markReturned: "rereadFailed", reset: "empty" },
};

function readingAt(name) {
  const reading = new ChangesReading();
  for (const event of paths[name]) {
    assert.equal(reading[event]().accepted, true, `${name} path ${event}`);
  }
  assert.deepEqual(reading.state, facts[name], `reaches ${name}`);
  return reading;
}

test("reaches every reading state with distinct facts", () => {
  for (const name of Object.keys(facts)) {
    readingAt(name);
  }
  const distinct = new Set(Object.values(facts).map((value) => JSON.stringify(value)));
  assert.equal(distinct.size, Object.keys(facts).length);
});

test("follows every allowed transition and rejects the rest without moving", () => {
  for (const [from, events] of Object.entries(edges)) {
    for (const [event, to] of Object.entries(events)) {
      const reading = readingAt(from);
      const result = reading[event]();
      assert.deepEqual(result.previous, facts[from], `${from} ${event} previous`);
      if (to === null) {
        assert.equal(result.accepted, false, `${from} rejects ${event}`);
        assert.deepEqual(reading.state, facts[from], `${from} stays after ${event}`);
      } else {
        assert.equal(result.accepted, true, `${from} accepts ${event}`);
        assert.deepEqual(reading.state, facts[to], `${from} ${event} -> ${to}`);
      }
    }
  }
});

test("a completion after a return cannot make data from before it current", () => {
  const reading = readingAt("current");
  reading.markReturned();
  assert.equal(reading.succeed().accepted, false);
  assert.deepEqual(reading.state, facts.outdated);
  reading.start();
  reading.markReturned();
  assert.deepEqual(reading.state, facts.outdated);
  assert.equal(reading.fail().accepted, false);
  assert.deepEqual(reading.state, facts.outdated);
});
