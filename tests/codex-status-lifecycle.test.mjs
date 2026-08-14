import assert from "node:assert/strict";
import test from "node:test";
import {
  CodexStatusLifecycle,
  PENDING_CODEX_TASK_OPERATIONS,
  codexTaskRecoveryVisible,
  codexTaskOperationsPresentation,
  createCodexStatusSnapshot,
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
  const blocking = codexTaskOperationsPresentation(
    blockingSnapshot,
  );
  const ready = codexTaskOperationsPresentation(
    readySnapshot,
  );
  const inconsistentReady = codexTaskOperationsPresentation(
    inconsistentSnapshot,
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

test("Task-store migration retry is an explicit mutation followed by status refresh", async () => {
  let status = codexStatus("ready", false);
  status.taskStoreReadiness = {
    state: "failed",
    blocksTaskOperations: true,
    diagnosticMessage: "Migration failed.",
  };
  let retries = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => status,
    retryTaskStore: async () => {
      retries += 1;
      status = codexStatus("ready", false);
      status.taskStoreReadiness = {
        state: "migrating",
        blocksTaskOperations: true,
        diagnosticMessage: "Retrying migration.",
      };
    },
    restartRuntime: async () => {},
  });

  lifecycle.connect();
  await settle();
  await lifecycle.retryTaskStoreMigration();

  assert.equal(retries, 1);
  assert.equal(
    lifecycle.snapshot().status?.taskStoreReadiness?.state,
    "migrating",
  );
  lifecycle.disconnect();
});

test("Task-store migration status polls until startup leaves migrating", async () => {
  let loads = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      loads += 1;
      const status = codexStatus("ready", false);
      if (loads === 1) {
        status.taskStoreReadiness = {
          state: "migrating",
          blocksTaskOperations: true,
          diagnosticMessage: "Migration is running.",
        };
      }
      return status;
    },
    restartRuntime: async () => {},
  });

  lifecycle.connect();
  await new Promise((resolve) => setTimeout(resolve, 550));

  assert.equal(loads, 2);
  assert.equal(lifecycle.snapshot().status?.taskStoreReadiness, undefined);
  lifecycle.disconnect();
});

test("Codex status owns one restart request and refreshes canonical readiness", async () => {
  let status = codexStatus("restartRequired");
  let restartRequests = 0;
  const restartGate = deferred();
  const snapshots = [];
  const restartStates = [];
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => status,
    restartRuntime: async () => {
      restartRequests += 1;
      await restartGate.promise;
      status = codexStatus("ready", false);
    },
    onSnapshotChange: (value) => snapshots.push(value),
    onRestartStateChange: (value) => restartStates.push(value),
  });

  lifecycle.connect();
  await settle();
  assert.equal(snapshots.at(-1)?.status?.readiness?.state, "restartRequired");
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
  assert.equal(snapshots.at(-1)?.status?.readiness?.state, "ready");
  assert.equal(lifecycle.canRestartRuntime(), false);
});

test("a status refresh keeps the last canonical status while checking", async () => {
  const refreshGate = deferred();
  let loadRequests = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      loadRequests += 1;
      if (loadRequests === 1) {
        return codexStatus("ready", false);
      }
      await refreshGate.promise;
      return codexStatus("ready", false);
    },
    restartRuntime: async () => {},
  });

  lifecycle.connect();
  await settle();
  const refresh = lifecycle.refresh();

  assert.equal(lifecycle.snapshot().phase, "checking");
  assert.equal(lifecycle.snapshot().status?.readiness?.state, "ready");

  refreshGate.resolve();
  await refresh;
  assert.equal(lifecycle.snapshot().phase, "loaded");
});

test("overlapping status refreshes share one canonical request", async () => {
  const initialGate = deferred();
  let loadRequests = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      loadRequests += 1;
      await initialGate.promise;
      return codexStatus("ready", false);
    },
    restartRuntime: async () => {},
  });

  lifecycle.connect();
  const first = lifecycle.refresh();
  const second = lifecycle.refresh();

  assert.equal(loadRequests, 1);
  initialGate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [
    codexStatus("ready", false),
    codexStatus("ready", false),
  ]);
  assert.equal(loadRequests, 1);
  lifecycle.disconnect();
});

test("a failed foreground status refresh preserves the last useful readiness", async () => {
  let loadRequests = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      loadRequests += 1;
      if (loadRequests === 1) {
        return codexStatus("ready", false);
      }
      throw new Error("status unavailable");
    },
    restartRuntime: async () => {},
  });

  lifecycle.connect();
  await settle();
  await assert.rejects(lifecycle.refresh(), /status unavailable/);

  assert.equal(lifecycle.snapshot().phase, "failed");
  assert.equal(lifecycle.snapshot().status?.readiness?.state, "ready");
  assert.equal(codexTaskOperationsPresentation(lifecycle.snapshot()).blocked, false);
  assert.equal(codexTaskRecoveryVisible(lifecycle.snapshot()), false);
  lifecycle.disconnect();
});

test("suspending status recovery invalidates work and pauses migration polling", async () => {
  const pendingGate = deferred();
  let loadRequests = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      loadRequests += 1;
      if (loadRequests === 1) {
        const status = codexStatus("ready", false);
        status.taskStoreReadiness = {
          state: "migrating",
          blocksTaskOperations: true,
          diagnosticMessage: "Migration is running.",
        };
        return status;
      }
      if (loadRequests === 2) {
        await pendingGate.promise;
      }
      return codexStatus("ready", false);
    },
    restartRuntime: async () => {},
  });

  lifecycle.connect();
  await settle();
  lifecycle.suspend();
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(loadRequests, 1);

  lifecycle.resume();
  const refresh = lifecycle.refresh();
  assert.equal(loadRequests, 2);
  lifecycle.suspend();
  pendingGate.resolve();
  await refresh;

  assert.equal(lifecycle.snapshot().status?.taskStoreReadiness?.state, "migrating");
  lifecycle.disconnect();
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
