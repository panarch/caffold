import assert from "node:assert/strict";
import test from "node:test";
import {
  PENDING_CODEX_TASK_OPERATIONS,
  codexTaskRecoveryVisible,
  codexTaskOperationsPresentation,
  createCodexStatusSnapshot,
} from "./model.js";

function codexStatus(state, blocksTaskOperations = state !== "ready") {
  return {
    readiness: {
      state,
      blocksTaskOperations,
      reasonCode: state === "ready" ? "ready" : "runtimeVersionMismatch",
      diagnosticMessage: state === "ready"
        ? "Codex is ready."
        : "The runtime version differs.",
      minimumSupportedVersion: "0.147.0",
      detectedExecutable: { path: "/opt/codex", version: "0.148.0" },
      managedExecutable: { path: "/opt/codex", version: "0.148.0" },
      runningAppServerVersion: state === "ready" ? "0.148.0" : "0.147.0",
    },
  };
}

function loadedSnapshot(status) {
  return createCodexStatusSnapshot({ phase: "loaded", status });
}

test("Codex Task operations and recovery use distinct projections", () => {
  const initial = createCodexStatusSnapshot();
  const failed = createCodexStatusSnapshot({
    phase: "failed",
    error: "status unavailable",
  });
  const blockingSnapshot = loadedSnapshot(codexStatus("updateRequired"));
  const readySnapshot = loadedSnapshot(codexStatus("restartRequired", false));
  const inconsistentSnapshot = loadedSnapshot(codexStatus("ready", true));
  const pending = codexTaskOperationsPresentation(initial);
  const checkFailed = codexTaskOperationsPresentation(failed);
  const blocking = codexTaskOperationsPresentation(blockingSnapshot);
  const ready = codexTaskOperationsPresentation(readySnapshot);
  const inconsistentReady = codexTaskOperationsPresentation(inconsistentSnapshot);

  assert.deepEqual(
    [pending, checkFailed, blocking, ready, inconsistentReady].map((view) => ({
      phase: view.phase,
      blocked: view.blocked,
      title: view.title,
    })),
    [
      {
        phase: "pending",
        blocked: true,
        title: "Checking Codex readiness…",
      },
      {
        phase: "checkFailed",
        blocked: true,
        title: "Codex readiness check failed",
      },
      {
        phase: "blocking",
        blocked: true,
        title: "Codex update required",
      },
      { phase: "ready", blocked: false, title: "New Task" },
      { phase: "blocking", blocked: true, title: "Codex unavailable" },
    ],
  );
  assert.strictEqual(pending, PENDING_CODEX_TASK_OPERATIONS);
  assert.equal(Object.isFrozen(pending), true);
  assert.equal(Object.isFrozen(blocking), true);
  assert.deepEqual(
    [initial, failed, blockingSnapshot, readySnapshot, inconsistentSnapshot]
      .map(codexTaskRecoveryVisible),
    [false, true, true, false, true],
  );
});

test("Task-store readiness owns migration blocking and preserves the Codex cause", () => {
  const migrating = codexStatus("ready", false);
  migrating.taskStoreReadiness = {
    state: "migrating",
    blocksTaskOperations: true,
    diagnosticMessage: "Applying the staged v5 database.",
  };
  const waiting = codexStatus("updateRequired", true);
  waiting.taskStoreReadiness = {
    state: "waitingForCodex",
    blocksTaskOperations: true,
    diagnosticMessage: "Task-store migration is waiting for Codex.",
  };
  const failed = codexStatus("ready", false);
  failed.taskStoreReadiness = {
    state: "failed",
    blocksTaskOperations: true,
    diagnosticMessage: "The staged database could not be published.",
  };

  assert.deepEqual(
    [migrating, waiting, failed].map((status) => {
      const view = codexTaskOperationsPresentation(loadedSnapshot(status));
      return {
        phase: view.phase,
        title: view.title,
        message: view.message,
      };
    }),
    [
      {
        phase: "taskStore:migrating",
        title: "Preparing Tasks…",
        message: "Applying the staged v5 database.",
      },
      {
        phase: "taskStore:waitingForCodex",
        title: "Codex update required",
        message: "The runtime version differs.",
      },
      {
        phase: "taskStore:failed",
        title: "Task data upgrade failed",
        message: "The staged database could not be published.",
      },
    ],
  );
});
