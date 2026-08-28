import assert from "node:assert/strict";
import test from "node:test";
import {
  codexBlocksTaskOperations,
  codexRuntimeRestartAvailable,
  codexSetupVisible,
  createCodexStatusSnapshot,
  formatRateWindowLabel,
  taskStoreOperationsPresentation,
  taskStoreRecoveryVisible,
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

test("manual runtime restart is available only for supported running states", () => {
  const states = [
    "missing",
    "unsupportedInstall",
    "updateRequired",
    "signInRequired",
    "restartRequired",
    "incompatible",
    "ready",
    "error",
  ];

  assert.deepEqual(
    [null, ...states.map((state) => codexStatus(state))]
      .map(codexRuntimeRestartAvailable),
    [false, false, false, false, false, true, false, true, false],
  );
});

test("Codex readiness gates only Codex surfaces, and unknown is not blocked", () => {
  const initial = createCodexStatusSnapshot();
  const failed = createCodexStatusSnapshot({
    phase: "failed",
    error: "status unavailable",
  });
  const blockingSnapshot = loadedSnapshot(codexStatus("updateRequired"));
  const readySnapshot = loadedSnapshot(codexStatus("restartRequired", false));
  const inconsistentSnapshot = loadedSnapshot(codexStatus("ready", true));

  // A status nobody has loaded — or could load — blocks nothing: an
  // operation tried too early is refused by the server, which is the true
  // answer, and the other agent is not Codex's to hold.
  assert.deepEqual(
    [initial, failed, blockingSnapshot, readySnapshot, inconsistentSnapshot]
      .map((snapshot) => codexBlocksTaskOperations(snapshot.status)),
    [false, false, true, false, true],
  );
  assert.deepEqual(
    [initial, failed, blockingSnapshot, readySnapshot, inconsistentSnapshot]
      .map(codexSetupVisible),
    [false, true, true, false, true],
    "the setup card shows for a blocked Codex or a status nobody could load",
  );
});

test("only the Task store takes every Task operation, and only when it says so", () => {
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
      const view = taskStoreOperationsPresentation(loadedSnapshot(status));
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

  // Codex being blocked is not the store being blocked: no takeover, and
  // nothing store-gated locks.
  const codexOnly = loadedSnapshot(codexStatus("updateRequired"));
  assert.equal(taskStoreOperationsPresentation(codexOnly).blocked, false);
  assert.equal(taskStoreRecoveryVisible(codexOnly), false);
  assert.equal(taskStoreRecoveryVisible(loadedSnapshot(migrating)), true);
});

test("a rate window is labelled by the period it meters, never by a guess", () => {
  assert.equal(formatRateWindowLabel({ windowDurationMins: 300 }, "primary"), "5 hours");
  assert.equal(formatRateWindowLabel({ windowDurationMins: 60 }, "primary"), "1 hour");
  assert.equal(formatRateWindowLabel({ windowDurationMins: 10080 }, "secondary"), "1 week");
  assert.equal(formatRateWindowLabel({ windowDurationMins: 20160 }, "secondary"), "2 weeks");
  assert.equal(formatRateWindowLabel({ windowDurationMins: 90 }, "primary"), "90 min");

  // A window Codex metered without stating its period keeps its own name; the
  // label must not invent a duration the response never reported.
  for (const window of [undefined, {}, { windowDurationMins: 0 }]) {
    assert.equal(formatRateWindowLabel(window, "primary"), "Primary limit");
    assert.equal(formatRateWindowLabel(window, "secondary"), "Secondary limit");
  }
});
