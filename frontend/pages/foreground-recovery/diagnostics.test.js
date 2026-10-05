import assert from "node:assert/strict";
import test from "node:test";

import {
  DIAGNOSTICS_EDGES,
  DIAGNOSTICS_EVENT,
  DIAGNOSTICS_NODE,
  DIAGNOSTICS_STORAGE_KEY,
  ForegroundRecoveryDiagnostics,
  transitionDiagnostics,
} from "./diagnostics.js";

const ORIGIN = "https://caffold.test";

function snapshot({
  visible = true,
  node = "ready",
  list = "ready",
  detail = null,
} = {}) {
  return {
    observation: { visibility: visible ? "visible" : "hidden" },
    node: { type: node, attempt: 0 },
    targets: {
      list: { active: true, content: "present", transport: list },
      detail: detail
        ? { active: true, content: "present", transport: detail }
        : { active: false, content: "absent", transport: "inactive" },
    },
  };
}

function harness({ send = async () => {}, stored = null } = {}) {
  let clock = 1_000;
  const timers = new Map();
  let nextTimer = 0;
  const items = new Map(stored ? [[DIAGNOSTICS_STORAGE_KEY, stored]] : []);
  const queuedEntries = [];
  let deliverEntries = () => {};
  const sent = [];
  const recorder = new ForegroundRecoveryDiagnostics({
    send: (records) => {
      sent.push(records);
      return send(records);
    },
    now: () => clock,
    origin: ORIGIN,
    storage: {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => items.set(key, value),
      removeItem: (key) => items.delete(key),
    },
    observeRequests: (onEntries) => {
      deliverEntries = onEntries;
      return {
        takeRecords: () => queuedEntries.splice(0),
        disconnect() {},
      };
    },
    windowTarget: {
      setTimeout(callback, delay) {
        const id = ++nextTimer;
        timers.set(id, { callback, delay });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
  });
  recorder.connect();
  return {
    recorder,
    sent,
    timers,
    stored: () => JSON.parse(items.get(DIAGNOSTICS_STORAGE_KEY) ?? "[]"),
    at(ms) {
      clock = ms;
    },
    see(state, presentation = "none") {
      recorder.observe(snapshot(state), presentation);
    },
    entries: (entries) => deliverEntries(entries),
    queueEntries: (entries) => queuedEntries.push(...entries),
  };
}

function resource(path, { start, firstByte = start + 5, end = firstByte + 1, connect = null }) {
  return {
    name: `${ORIGIN}${path}`,
    startTime: start,
    responseStart: firstByte,
    responseEnd: end,
    connectStart: connect ? connect[0] : start,
    connectEnd: connect ? connect[1] : start,
  };
}

function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("declares the diagnostics graph and rejects every other event", () => {
  for (const node of Object.values(DIAGNOSTICS_NODE)) {
    for (const event of Object.values(DIAGNOSTICS_EVENT)) {
      const expected = DIAGNOSTICS_EDGES[node][event] ?? node;
      assert.equal(transitionDiagnostics(node, event), expected, `${node} + ${event}`);
    }
  }
  assert.equal(
    transitionDiagnostics(DIAGNOSTICS_NODE.WAITING, DIAGNOSTICS_EVENT.RETURNED),
    DIAGNOSTICS_NODE.RECORDING,
  );
  for (const end of ["settled", "hidden", "limit"]) {
    assert.equal(
      transitionDiagnostics(DIAGNOSTICS_NODE.RECORDING, end),
      DIAGNOSTICS_NODE.WAITING,
    );
  }
});

test("times a return from the moment the page is visible until it settles, and sends it", async () => {
  const browser = harness();
  browser.see({ visible: true });
  browser.at(2_000);
  browser.see({ visible: false, node: "suspended" });
  browser.recorder.reportConnection({ kind: "closed", id: 1 });

  // The workspace opens its connection before recovery sees the page.
  browser.at(185_000);
  browser.recorder.reportConnection({ kind: "opened", id: 3 });
  browser.see({ visible: true, node: "suspended" });
  browser.at(185_002);
  browser.see({ visible: true, node: "validating-status" });
  browser.at(193_003);
  browser.recorder.reportConnection({ kind: "stalled", id: 3 });
  browser.recorder.reportConnection({ kind: "opened", id: 5 });
  browser.see({ visible: true, node: "validating-status", list: "reconnecting" }, "reconnecting");
  browser.at(193_101);
  browser.recorder.reportConnection({ kind: "answered", id: 5 });
  browser.entries([
    resource("/api/task-store/status", { start: 185_003, firstByte: 193_050 }),
    resource("/api/live", { start: 193_003 }),
    resource("/api/tasks", { start: 193_102, connect: [193_102, 193_140] }),
    resource("/api/notes", { start: 1_500 }),
  ]);
  browser.queueEntries([
    resource("/api/live/connection-b/subscriptions", { start: 193_102 }),
  ]);
  browser.at(193_890);
  browser.see({ visible: true, node: "validating-list", list: "ready" });
  browser.at(194_120);
  browser.see({ visible: true, node: "ready", list: "ready" });
  await settle();

  assert.equal(browser.sent.length, 1);
  assert.deepEqual(browser.sent[0], [{
    hiddenForMs: 183_000,
    endedMs: 9_120,
    end: "settled",
    recovery: [
      { ms: 0, node: "suspended" },
      { ms: 2, node: "validating-status" },
      { ms: 8_890, node: "validating-list" },
      { ms: 9_120, node: "ready" },
    ],
    notice: [
      { ms: 0, state: "none" },
      { ms: 8_003, state: "reconnecting" },
      { ms: 8_890, state: "none" },
    ],
    targets: [
      { ms: 0, list: "ready", detail: "inactive" },
      { ms: 8_003, list: "reconnecting", detail: "inactive" },
      { ms: 8_890, list: "ready", detail: "inactive" },
    ],
    connections: [
      { id: 3, openedMs: 0, answeredMs: null, endedMs: 8_003, end: "stalled" },
      { id: 5, openedMs: 8_003, answeredMs: 8_101, endedMs: null, end: null },
    ],
    requests: [
      {
        path: "/api/task-store/status",
        startMs: 3,
        firstByteMs: 8_050,
        endMs: 8_051,
        newConnection: false,
      },
      {
        path: "/api/tasks",
        startMs: 8_102,
        firstByteMs: 8_107,
        endMs: 8_108,
        newConnection: true,
      },
      {
        path: "/api/live/connection-b/subscriptions",
        startMs: 8_102,
        firstByteMs: 8_107,
        endMs: 8_108,
        newConnection: false,
      },
    ],
  }]);
  assert.deepEqual(browser.stored(), [], "a delivered record is not kept");
});

test("a return whose transport settles after recovery is sent when it settles", async () => {
  const browser = harness();
  browser.see({ visible: true });
  browser.see({ visible: false, node: "suspended" });
  browser.see({ visible: true, node: "validating-status" });
  browser.see({ visible: true, node: "ready", list: "validating" });
  await settle();
  assert.deepEqual(browser.sent, []);

  browser.at(9_000);
  browser.see({ visible: true, node: "ready", list: "ready" });
  await settle();
  assert.equal(browser.sent.length, 1);
  assert.equal(browser.sent[0][0].end, "settled");
  assert.equal(browser.sent[0][0].endedMs, 8_000);
});

test("a page that was ready before it hid is not settled until recovery has run", () => {
  const browser = harness();
  browser.see({ visible: true });
  browser.see({ visible: false, node: "suspended" });
  browser.see({ visible: true, node: "ready", list: "ready" });

  assert.equal(browser.recorder.node, DIAGNOSTICS_NODE.RECORDING);
  assert.deepEqual(browser.sent, []);
});

test("a return hidden again before it settles waits for the next recovery to be sent", async () => {
  const browser = harness();
  browser.see({ visible: true });
  browser.see({ visible: false, node: "suspended" });
  browser.at(5_000);
  browser.see({ visible: true, node: "validating-status" });
  browser.at(9_000);
  browser.see({ visible: false, node: "suspended" });
  await settle();

  assert.deepEqual(browser.sent, []);
  assert.equal(browser.stored()[0].end, "hidden");
  assert.equal(browser.stored()[0].endedMs, 4_000);

  browser.at(20_000);
  browser.see({ visible: true, node: "validating-status" });
  browser.see({ visible: true, node: "ready" });
  await settle();
  assert.deepEqual(
    browser.sent[0].map(({ end }) => end),
    ["hidden", "settled"],
  );
});

test("a return that does not settle within the limit is recorded as such", () => {
  const browser = harness();
  browser.see({ visible: true });
  browser.see({ visible: false, node: "suspended" });
  browser.see({ visible: true, node: "validating-status" });
  const [[id, timer]] = browser.timers;
  assert.equal(timer.delay, 120_000);

  browser.at(121_000);
  browser.timers.delete(id);
  timer.callback();

  assert.equal(browser.recorder.node, DIAGNOSTICS_NODE.WAITING);
  assert.equal(browser.stored()[0].end, "limit");
  assert.equal(browser.stored()[0].endedMs, 120_000);
});

test("records that cannot be delivered stay, at most twenty, for the next recovery", async () => {
  let accept = false;
  const stored = JSON.stringify(
    Array.from({ length: 20 }, (_, index) => ({ end: "hidden", endedMs: index })),
  );
  const browser = harness({
    stored,
    send: async () => {
      if (!accept) {
        throw new TypeError("Load failed");
      }
    },
  });
  browser.see({ visible: true });
  browser.see({ visible: false, node: "suspended" });
  browser.see({ visible: true, node: "validating-status" });
  browser.see({ visible: true, node: "ready" });
  await settle();

  assert.equal(browser.sent.length, 1);
  assert.equal(browser.stored().length, 20);
  assert.equal(browser.stored()[0].endedMs, 1, "the oldest record went first");
  assert.equal(browser.stored().at(-1).end, "settled");

  accept = true;
  browser.see({ visible: true, node: "validating-status" });
  browser.see({ visible: true, node: "ready" });
  await settle();
  assert.equal(browser.sent.length, 2);
  assert.deepEqual(browser.stored(), []);
});
