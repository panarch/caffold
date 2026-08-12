import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexStatusLifecycle,
  PENDING_CODEX_TASK_OPERATIONS,
  codexTaskOperationsPresentation,
} from "../frontend/pages/(task-workspace)/codex-status.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

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

test("Codex Task operations use one fail-closed presentation snapshot", () => {
  const pending = codexTaskOperationsPresentation(null);
  const checkFailed = codexTaskOperationsPresentation({
    readiness: null,
    readinessLoadError: "status unavailable",
  });
  const blocking = codexTaskOperationsPresentation(
    codexStatus("updateRequired"),
  );
  const ready = codexTaskOperationsPresentation(
    codexStatus("restartRequired", false),
  );
  const inconsistentReady = codexTaskOperationsPresentation(
    codexStatus("ready", true),
  );

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
});

test("Codex status owns one restart request and refreshes canonical readiness", async () => {
  let status = codexStatus("restartRequired");
  let restartRequests = 0;
  const restartGate = deferred();
  const statuses = [];
  const restartStates = [];
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => status,
    restartRuntime: async () => {
      restartRequests += 1;
      await restartGate.promise;
      status = codexStatus("ready", false);
    },
    onStatusChange: (value) => statuses.push(value),
    onRestartStateChange: (value) => restartStates.push(value),
  });

  lifecycle.connect();
  await settle();
  assert.equal(statuses.at(-1)?.readiness?.state, "restartRequired");
  assert.equal(lifecycle.canRestartRuntime(), true);

  const first = lifecycle.requestRuntimeRestart();
  const second = lifecycle.requestRuntimeRestart();
  assert.strictEqual(first, second);
  assert.equal(restartRequests, 1);
  assert.equal(restartStates.at(-1)?.state, "restarting");

  restartGate.resolve();
  await first;
  assert.deepEqual(
    restartStates.map((value) => value.state),
    ["restarting", "refreshing", "succeeded"],
  );
  assert.equal(statuses.at(-1)?.readiness?.state, "ready");
  assert.equal(lifecycle.canRestartRuntime(), false);
});

test("Codex restart reports a post-restart readiness refresh failure", async () => {
  let loadRequests = 0;
  const restartStates = [];
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      loadRequests += 1;
      if (loadRequests === 1) {
        return codexStatus("restartRequired");
      }
      throw new Error("status unavailable");
    },
    restartRuntime: async () => {},
    onRestartStateChange: (value) => restartStates.push(value),
  });

  lifecycle.connect();
  await settle();
  await lifecycle.requestRuntimeRestart();

  assert.equal(restartStates.at(-1)?.state, "failed");
  assert.match(
    restartStates.at(-1)?.message,
    /runtime restarted, but readiness could not be refreshed: status unavailable/i,
  );
});

test("a later runtime mismatch clears a stale restart success message", async () => {
  let status = codexStatus("restartRequired");
  const restartStates = [];
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => status,
    restartRuntime: async () => {
      status = codexStatus("ready", false);
    },
    onRestartStateChange: (value) => restartStates.push(value),
  });

  lifecycle.connect();
  await settle();
  await lifecycle.requestRuntimeRestart();
  assert.equal(lifecycle.restartSnapshot().state, "succeeded");

  status = codexStatus("restartRequired");
  await lifecycle.refresh();

  assert.equal(lifecycle.restartSnapshot().state, "idle");
  assert.equal(restartStates.at(-1)?.state, "idle");
});

test("disconnect invalidates a pending Codex restart response", async () => {
  const restartGate = deferred();
  const restartStates = [];
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => codexStatus("restartRequired"),
    restartRuntime: async () => restartGate.promise,
    onRestartStateChange: (value) => restartStates.push(value),
  });

  lifecycle.connect();
  await settle();
  const request = lifecycle.requestRuntimeRestart();
  lifecycle.disconnect();
  restartGate.resolve();
  await request;

  assert.equal(lifecycle.restartSnapshot().state, "idle");
  assert.deepEqual(
    restartStates.map((value) => value.state),
    ["restarting", "idle"],
  );
});
