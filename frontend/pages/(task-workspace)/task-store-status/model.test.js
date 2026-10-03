import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_TASK_STORE_STATUS_SNAPSHOT,
  createTaskStoreStatusSnapshot,
  sameTaskStoreStatusSnapshot,
  taskStoreBlocksTaskOperations,
  taskStoreOperationsPresentation,
} from "./model.js";

function snapshot(state, diagnosticMessage = "") {
  return createTaskStoreStatusSnapshot({
    readiness: {
      state,
      blocksTaskOperations: state !== "ready",
      diagnosticMessage,
    },
  });
}

test("only a store that says it blocks takes every Task operation", () => {
  assert.deepEqual(
    [
      snapshot("migrating", "Applying the staged v5 database."),
      snapshot("failed", "The staged database could not be published."),
    ].map((value) => {
      const view = taskStoreOperationsPresentation(value);
      return { phase: view.phase, title: view.title, message: view.message };
    }),
    [
      {
        phase: "taskStore:migrating",
        title: "Preparing Tasks…",
        message: "Applying the staged v5 database.",
      },
      {
        phase: "taskStore:failed",
        title: "Task data upgrade failed",
        message: "The staged database could not be published.",
      },
    ],
  );

  for (const open of [
    null,
    INITIAL_TASK_STORE_STATUS_SNAPSHOT,
    snapshot("ready"),
  ]) {
    assert.equal(taskStoreBlocksTaskOperations(open), false);
    assert.deepEqual(taskStoreOperationsPresentation(open), {
      key: "ready|false|New Task|",
      phase: "ready",
      blocked: false,
      title: "New Task",
      message: "",
    });
  }
  assert.equal(taskStoreBlocksTaskOperations(snapshot("migrating")), true);
});

test("snapshots compare by the store's answer and retry availability", () => {
  assert.equal(
    sameTaskStoreStatusSnapshot(snapshot("migrating", "a"), snapshot("migrating", "a")),
    true,
  );
  assert.equal(
    sameTaskStoreStatusSnapshot(snapshot("migrating", "a"), snapshot("migrating", "b")),
    false,
  );
  assert.equal(
    sameTaskStoreStatusSnapshot(
      createTaskStoreStatusSnapshot({ readiness: snapshot("failed").readiness }),
      createTaskStoreStatusSnapshot({
        readiness: snapshot("failed").readiness,
        retryAvailable: true,
      }),
    ),
    false,
  );
  assert.equal(
    sameTaskStoreStatusSnapshot(INITIAL_TASK_STORE_STATUS_SNAPSHOT, snapshot("ready")),
    false,
  );
});
