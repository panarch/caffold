import assert from "node:assert/strict";
import test from "node:test";

import {
  TASK_STORE_STATUS_EVENT as EVENT,
  TASK_STORE_STATUS_NODE as NODE,
  TASK_STORE_STATUS_TRANSITIONS,
  TaskStoreStatusLifecycle,
  createTaskStoreStatusState,
  transitionTaskStoreStatus,
} from "./lifecycle.js";

const READY = { state: "ready", blocksTaskOperations: false, diagnosticMessage: "" };
const MIGRATING = {
  state: "migrating",
  blocksTaskOperations: true,
  diagnosticMessage: "Caffold is preparing the Task store.",
};
const FAILED = {
  state: "failed",
  blocksTaskOperations: true,
  diagnosticMessage: "Task-store migration failed: disk full",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
}

function harness() {
  const loads = [];
  const retries = [];
  const timers = new Map();
  let timerId = 0;
  const snapshots = [];
  const lifecycle = new TaskStoreStatusLifecycle({
    loadStatus: () => {
      const answer = deferred();
      loads.push(answer);
      return answer.promise;
    },
    retryMigration: () => {
      const answer = deferred();
      retries.push(answer);
      return answer.promise;
    },
    onSnapshotChange: (snapshot) => snapshots.push(snapshot),
    setTimer: (callback, delay) => {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimer: (id) => timers.delete(id),
  });
  return {
    lifecycle,
    loads,
    retries,
    snapshots,
    timers,
    node: () => lifecycle.state.node,
    fireTimer() {
      const [[id, timer]] = timers;
      timers.delete(id);
      timer.callback();
    },
  };
}

function stateAt(node, readiness = null) {
  return Object.freeze({ node, readiness });
}

test("the edge table is the whole graph and rejects every other pair unchanged", () => {
  const expected = {
    [NODE.DETACHED]: { [EVENT.CONNECT]: NODE.CHECKING },
    [NODE.IDLE]: {
      [EVENT.CHECK]: NODE.CHECKING,
      [EVENT.SUSPEND]: NODE.SUSPENDED,
      [EVENT.DISCONNECT]: NODE.DETACHED,
    },
    [NODE.CHECKING]: {
      [EVENT.CHECK]: NODE.CHECKING,
      [EVENT.ANSWERED]: "answer",
      [EVENT.CHECK_FAILED]: "unanswered",
      [EVENT.SUSPEND]: NODE.SUSPENDED,
      [EVENT.DISCONNECT]: NODE.DETACHED,
    },
    [NODE.WAITING]: {
      [EVENT.RECHECK_DUE]: NODE.CHECKING,
      [EVENT.CHECK]: NODE.CHECKING,
      [EVENT.SUSPEND]: NODE.SUSPENDED,
      [EVENT.DISCONNECT]: NODE.DETACHED,
    },
    [NODE.FAILED]: {
      [EVENT.RETRY]: NODE.RETRYING,
      [EVENT.CHECK]: NODE.CHECKING,
      [EVENT.SUSPEND]: NODE.SUSPENDED,
      [EVENT.DISCONNECT]: NODE.DETACHED,
    },
    [NODE.RETRYING]: {
      [EVENT.RETRY_ACCEPTED]: NODE.CHECKING,
      [EVENT.RETRY_FAILED]: NODE.FAILED,
      [EVENT.SUSPEND]: NODE.SUSPENDED,
      [EVENT.DISCONNECT]: NODE.DETACHED,
    },
    [NODE.SUSPENDED]: {
      [EVENT.RESUME]: "answer",
      [EVENT.DISCONNECT]: NODE.DETACHED,
    },
  };
  assert.deepEqual(
    JSON.parse(JSON.stringify(TASK_STORE_STATUS_TRANSITIONS)),
    expected,
  );

  for (const node of Object.values(NODE)) {
    for (const event of Object.values(EVENT)) {
      if (expected[node][event]) {
        continue;
      }
      const state = stateAt(node, FAILED);
      assert.equal(
        transitionTaskStoreStatus(state, { type: event }),
        state,
        `${node} rejects ${event}`,
      );
    }
  }
  assert.deepEqual(createTaskStoreStatusState(), {
    node: NODE.DETACHED,
    readiness: null,
  });
});

test("an answer settles on the node its state names", () => {
  for (const [readiness, node] of [
    [READY, NODE.IDLE],
    [MIGRATING, NODE.WAITING],
    [FAILED, NODE.FAILED],
    [{ state: "unknown" }, NODE.IDLE],
  ]) {
    assert.equal(
      transitionTaskStoreStatus(stateAt(NODE.CHECKING), {
        type: EVENT.ANSWERED,
        readiness,
      }).node,
      node,
    );
  }
  for (const [readiness, node] of [
    [null, NODE.IDLE],
    [MIGRATING, NODE.WAITING],
    [FAILED, NODE.FAILED],
  ]) {
    assert.equal(
      transitionTaskStoreStatus(stateAt(NODE.SUSPENDED, readiness), {
        type: EVENT.RESUME,
      }).node,
      node,
      "resuming returns to the last answer's node",
    );
  }
  for (const [readiness, node] of [
    [null, NODE.IDLE],
    [MIGRATING, NODE.IDLE],
    [FAILED, NODE.FAILED],
  ]) {
    const failed = transitionTaskStoreStatus(stateAt(NODE.CHECKING, readiness), {
      type: EVENT.CHECK_FAILED,
    });
    assert.equal(
      failed.node,
      node,
      "a failed check keeps a failed store's retry and watches nothing",
    );
    assert.equal(failed.readiness, readiness, "a failed check keeps the last answer");
  }
});

test("connecting checks once and a ready answer settles without blocking", async () => {
  const store = harness();
  assert.equal(store.node(), NODE.DETACHED);
  store.lifecycle.connect();
  assert.equal(store.node(), NODE.CHECKING);
  await settle();
  assert.equal(store.loads.length, 1);
  assert.deepEqual(store.lifecycle.snapshot(), {
    readiness: null,
    retryAvailable: false,
  });

  store.loads[0].resolve(READY);
  await settle();
  assert.equal(store.node(), NODE.IDLE);
  assert.deepEqual(store.lifecycle.snapshot().readiness, READY);
  assert.equal(store.timers.size, 0);
});

test("checks share the request in flight and resolve with its answer", async () => {
  const store = harness();
  store.lifecycle.connect();
  const first = store.lifecycle.check();
  const second = store.lifecycle.check();
  await settle();
  assert.equal(store.loads.length, 1);

  store.loads[0].resolve(READY);
  assert.deepEqual(await first, READY);
  assert.deepEqual(await second, READY);

  const third = store.lifecycle.check();
  assert.equal(store.node(), NODE.CHECKING);
  await settle();
  assert.equal(store.loads.length, 2);
  store.loads[1].reject(new TypeError("Load failed"));
  await assert.rejects(third, TypeError);
  assert.equal(store.node(), NODE.IDLE);
  assert.deepEqual(store.lifecycle.snapshot().readiness, READY);
});

test("a migrating store is rechecked on its timer until it answers ready", async () => {
  const store = harness();
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(MIGRATING);
  await settle();
  assert.equal(store.node(), NODE.WAITING);
  assert.equal([...store.timers.values()][0].delay, 500);
  assert.equal(store.lifecycle.snapshot().readiness.blocksTaskOperations, true);
  assert.equal(store.lifecycle.snapshot().retryAvailable, false);

  store.fireTimer();
  assert.equal(store.node(), NODE.CHECKING);
  await settle();
  assert.equal(store.loads.length, 2);
  store.loads[1].resolve(READY);
  await settle();
  assert.equal(store.node(), NODE.IDLE);
  assert.equal(store.timers.size, 0);
});

test("a recheck that cannot reach the store stops watching until the next check", async () => {
  const store = harness();
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(MIGRATING);
  await settle();
  store.fireTimer();
  await settle();
  store.loads[1].reject(new TypeError("Load failed"));
  await settle();

  assert.equal(store.node(), NODE.IDLE);
  assert.equal(store.timers.size, 0);
  assert.deepEqual(store.lifecycle.snapshot(), {
    readiness: MIGRATING,
    retryAvailable: false,
  });

  const answer = store.lifecycle.check();
  await settle();
  assert.equal(store.loads.length, 3);
  store.loads[2].resolve(READY);
  assert.deepEqual(await answer, READY);
  assert.equal(store.node(), NODE.IDLE);
});

test("a check that cannot reach a failed store keeps its retry", async () => {
  const store = harness();
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(FAILED);
  await settle();

  const answer = store.lifecycle.check();
  await settle();
  store.loads[1].reject(new TypeError("Load failed"));
  await assert.rejects(answer, TypeError);
  assert.equal(store.node(), NODE.FAILED);
  assert.equal(store.lifecycle.snapshot().retryAvailable, true);
});

test("a check while waiting replaces the timer with an immediate request", async () => {
  const store = harness();
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(MIGRATING);
  await settle();
  assert.equal(store.timers.size, 1);

  const answer = store.lifecycle.check();
  assert.equal(store.timers.size, 0);
  await settle();
  store.loads[1].resolve(READY);
  assert.deepEqual(await answer, READY);
});

test("a failed store waits for a person, then retries and checks again", async () => {
  const store = harness();
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(FAILED);
  await settle();
  assert.equal(store.node(), NODE.FAILED);
  assert.equal(store.lifecycle.snapshot().retryAvailable, true);
  assert.equal(store.timers.size, 0);

  store.lifecycle.retry();
  assert.equal(store.node(), NODE.RETRYING);
  assert.equal(store.lifecycle.snapshot().retryAvailable, false);
  assert.deepEqual(
    await store.lifecycle.check(),
    store.lifecycle.snapshot().readiness,
    "a check during a retry answers with the last answer",
  );
  await settle();
  assert.equal(store.retries.length, 1);
  assert.equal(store.loads.length, 1);

  store.retries[0].resolve({ accepted: true });
  await settle();
  assert.equal(store.node(), NODE.CHECKING);
  assert.equal(store.loads.length, 2);
  store.loads[1].resolve(MIGRATING);
  await settle();
  assert.equal(store.node(), NODE.WAITING);
});

test("a refused retry returns to failed and can be tried again", async () => {
  const store = harness();
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(FAILED);
  await settle();

  store.lifecycle.retry();
  await settle();
  store.retries[0].reject(new Error("retry refused"));
  await settle();
  assert.equal(store.node(), NODE.FAILED);
  assert.equal(store.lifecycle.snapshot().retryAvailable, true);

  store.lifecycle.retry();
  await settle();
  assert.equal(store.retries.length, 2);
});

test("retry outside failed is rejected", async () => {
  const store = harness();
  store.lifecycle.retry();
  assert.equal(store.node(), NODE.DETACHED);
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(READY);
  await settle();
  store.lifecycle.retry();
  await settle();
  assert.equal(store.node(), NODE.IDLE);
  assert.equal(store.retries.length, 0);
});

test("suspending invalidates the request in flight and resumes on the last answer", async () => {
  const store = harness();
  store.lifecycle.connect();
  const pending = store.lifecycle.check();
  await settle();
  store.lifecycle.suspend();
  assert.equal(store.node(), NODE.SUSPENDED);
  assert.equal(await pending, null);
  assert.equal(await store.lifecycle.check(), null, "no check while suspended");

  store.loads[0].resolve(FAILED);
  await settle();
  assert.equal(store.node(), NODE.SUSPENDED, "a late answer is ignored");
  assert.equal(store.lifecycle.snapshot().readiness, null);

  store.lifecycle.resume();
  assert.equal(store.node(), NODE.IDLE);
  const answer = store.lifecycle.check();
  await settle();
  store.loads[1].resolve(MIGRATING);
  assert.deepEqual(await answer, MIGRATING);

  store.lifecycle.suspend();
  assert.equal(store.timers.size, 0, "suspending stops the recheck timer");
  store.lifecycle.resume();
  assert.equal(store.node(), NODE.WAITING);
  assert.equal(store.timers.size, 1, "resuming a migrating store rechecks");
});

test("suspending a retry ignores its late result", async () => {
  const store = harness();
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(FAILED);
  await settle();
  store.lifecycle.retry();
  await settle();
  store.lifecycle.suspend();
  store.retries[0].resolve({ accepted: true });
  await settle();
  assert.equal(store.node(), NODE.SUSPENDED);
  assert.equal(store.loads.length, 1);
  store.lifecycle.resume();
  assert.equal(store.node(), NODE.FAILED);
});

test("disconnecting from any node stops work and later connects check again", async () => {
  const store = harness();
  store.lifecycle.connect();
  const pending = store.lifecycle.check();
  store.lifecycle.disconnect();
  assert.equal(store.node(), NODE.DETACHED);
  assert.equal(await pending, null);
  await settle();
  store.loads[0]?.resolve(FAILED);
  await settle();
  assert.equal(store.node(), NODE.DETACHED);

  store.lifecycle.connect();
  await settle();
  store.loads.at(-1).resolve(MIGRATING);
  await settle();
  assert.equal(store.node(), NODE.WAITING);
  store.lifecycle.disconnect();
  assert.equal(store.timers.size, 0);
  assert.equal(await store.lifecycle.check(), null);
});

test("publishes a snapshot only when the answer or retry availability changes", async () => {
  const store = harness();
  store.lifecycle.connect();
  await settle();
  store.loads[0].resolve(MIGRATING);
  await settle();
  store.fireTimer();
  await settle();
  store.loads[1].resolve(MIGRATING);
  await settle();
  store.fireTimer();
  await settle();
  store.loads[2].resolve(FAILED);
  await settle();

  assert.deepEqual(
    store.snapshots.map((snapshot) => [
      snapshot.readiness?.state ?? null,
      snapshot.retryAvailable,
    ]),
    [["migrating", false], ["failed", true]],
  );
});
