import assert from "node:assert/strict";
import test from "node:test";
import { CodexStatusLifecycle } from "./lifecycle.js";
import {
  taskStoreRecoveryVisible,
  codexBlocksTaskOperations,
  createCodexStatusSnapshot,
} from "./model.js";

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

function resetCreditStatus(count = 1) {
  return {
    ...codexStatus("ready", false),
    account: { accountType: "chatgpt" },
    rateLimits: { rateLimitResetCredits: {
      availableCount: count,
      credits: count ? [{ id: "credit-1", status: "available", expiresAt: 1792700687 }] : [],
    } },
  };
}

test("reset credits are consumed only on request and ambiguous retries reuse the same key", async () => {
  const attempts = [];
  let count = 1;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => resetCreditStatus(count),
    consumeResetCredit: async (attempt) => {
      attempts.push(attempt);
      if (attempts.length === 1) throw new Error("connection lost");
      count = 0;
      return { outcome: "alreadyRedeemed" };
    },
  });
  lifecycle.connect();
  await settle();
  assert.equal(attempts.length, 0);
  assert.equal(lifecycle.canConsumeResetCredit("credit-1"), true);

  assert.equal(await lifecycle.requestResetCredit("credit-1"), null);
  assert.equal(lifecycle.resetCreditState().retryPending, true);
  assert.equal(lifecycle.canConsumeResetCredit("another-credit"), false);
  assert.deepEqual(await lifecycle.requestResetCredit("credit-1"), {
    outcome: "alreadyRedeemed",
  });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
  assert.match(attempts[0].idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(lifecycle.snapshot().status.rateLimits.rateLimitResetCredits.availableCount, 0);
  assert.equal(lifecycle.resetCreditState().state, "succeeded");
  lifecycle.disconnect();
});

test("a reset with no eligible window refreshes credits without reporting success", async () => {
  let reads = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      reads += 1;
      return resetCreditStatus();
    },
    consumeResetCredit: async () => ({ outcome: "nothingToReset" }),
  });
  lifecycle.connect();
  await settle();

  assert.deepEqual(await lifecycle.requestResetCredit("credit-1"), {
    outcome: "nothingToReset",
  });
  assert.equal(reads, 2);
  assert.equal(lifecycle.resetCreditState().state, "failed");
  assert.equal(lifecycle.resetCreditState().retryPending, false);
  lifecycle.disconnect();
});

test("a completed reset reads status after an earlier in-flight status request", async () => {
  const consume = deferred();
  const staleStatus = deferred();
  let reads = 0;
  let count = 1;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      reads += 1;
      if (reads === 2) return staleStatus.promise;
      return resetCreditStatus(count);
    },
    consumeResetCredit: () => consume.promise,
  });
  lifecycle.connect();
  await settle();

  const reset = lifecycle.requestResetCredit("credit-1");
  const earlierRefresh = lifecycle.refresh();
  await settle();
  assert.equal(reads, 2);

  count = 0;
  consume.resolve({ outcome: "reset" });
  await settle();
  staleStatus.resolve(resetCreditStatus(1));
  await earlierRefresh;
  assert.deepEqual(await reset, { outcome: "reset" });
  assert.equal(reads, 3);
  assert.equal(lifecycle.snapshot().status.rateLimits.rateLimitResetCredits.availableCount, 0);
  lifecycle.disconnect();
});

test("a successful reset with a failed status refresh retries the same redemption", async () => {
  const attempts = [];
  let reads = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      reads += 1;
      if (reads === 2) throw new Error("status unavailable");
      return resetCreditStatus(reads === 1 ? 1 : 0);
    },
    consumeResetCredit: async (attempt) => {
      attempts.push(attempt);
      return { outcome: attempts.length === 1 ? "reset" : "alreadyRedeemed" };
    },
  });
  lifecycle.connect();
  await settle();

  assert.equal(await lifecycle.requestResetCredit("credit-1"), null);
  assert.equal(lifecycle.resetCreditState().retryPending, true);
  assert.match(lifecycle.resetCreditState().message, /accepted the reset/);
  assert.equal(lifecycle.snapshot().phase, "failed");
  assert.deepEqual(await lifecycle.requestResetCredit("credit-1"), {
    outcome: "alreadyRedeemed",
  });
  assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
  assert.equal(lifecycle.snapshot().status.rateLimits.rateLimitResetCredits.availableCount, 0);
  lifecycle.disconnect();
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

test("Codex status owns one ready-state restart request and refreshes canonical readiness", async () => {
  let status = codexStatus("ready", false);
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
  assert.equal(snapshots.at(-1)?.status?.readiness?.state, "ready");
  assert.equal(lifecycle.canRestartRuntime(), true);

  const first = lifecycle.requestRuntimeRestart();
  const second = lifecycle.requestRuntimeRestart();
  assert.strictEqual(first, second);
  assert.equal(restartRequests, 1);
  assert.equal(restartStates.at(-1)?.state, "restarting");
  assert.equal(lifecycle.canRestartRuntime(), false);

  restartGate.resolve();
  await first;
  assert.deepEqual(
    restartStates.map((value) => value.state),
    ["restarting", "refreshing", "succeeded"],
  );
  assert.equal(snapshots.at(-1)?.status?.readiness?.state, "ready");
  assert.equal(lifecycle.canRestartRuntime(), true);
});

test("Codex status rejects manual restart without a supported restart target", async () => {
  for (const state of [
    "missing",
    "unsupportedInstall",
    "updateRequired",
    "signInRequired",
    "incompatible",
    "error",
  ]) {
    let restartRequests = 0;
    const lifecycle = new CodexStatusLifecycle({
      loadStatus: async () => codexStatus(state),
      restartRuntime: async () => {
        restartRequests += 1;
      },
    });

    lifecycle.connect();
    await settle();

    assert.equal(lifecycle.canRestartRuntime(), false, state);
    assert.equal(await lifecycle.requestRuntimeRestart(), null, state);
    assert.equal(restartRequests, 0, state);
    lifecycle.disconnect();
  }
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
  assert.equal(codexBlocksTaskOperations(lifecycle.snapshot().status), false);
  assert.equal(taskStoreRecoveryVisible(lifecycle.snapshot()), false);
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

test("restart and update each hold the one runtime slot and give it back", async () => {
  const updateGate = deferred();
  const actions = [];
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => codexStatus("ready", false),
    restartRuntime: async () => {},
    updateRuntime: async () => {
      await updateGate.promise;
      return { status: "noUpdate", message: "Codex was already current." };
    },
    onRuntimeActionChange: (action) => actions.push(action),
  });

  lifecycle.connect();
  await settle();
  const update = lifecycle.requestRuntimeUpdate();
  assert.equal(lifecycle.runtimeAction(), "updating");
  assert.equal(lifecycle.canUpdateRuntime(), false);
  assert.equal(lifecycle.canRestartRuntime(), false);

  updateGate.resolve();
  await update;
  assert.equal(lifecycle.runtimeAction(), "idle");
  assert.equal(lifecycle.updateSnapshot().state, "succeeded");

  await lifecycle.requestRuntimeRestart();
  assert.deepEqual(actions, ["updating", "idle", "restarting", "idle"]);
});

test("a restart is refused while an update runs, and an update while a restart runs", async () => {
  const updateGate = deferred();
  const restartGate = deferred();
  let restartRequests = 0;
  let updateRequests = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => codexStatus("restartRequired"),
    restartRuntime: async () => {
      restartRequests += 1;
      await restartGate.promise;
    },
    updateRuntime: async () => {
      updateRequests += 1;
      await updateGate.promise;
      return { status: "noUpdate", message: "Codex was already current." };
    },
  });

  lifecycle.connect();
  await settle();
  const update = lifecycle.requestRuntimeUpdate();
  assert.equal(await lifecycle.requestRuntimeRestart(), null);
  assert.equal(restartRequests, 0);
  updateGate.resolve();
  await update;

  const restart = lifecycle.requestRuntimeRestart();
  assert.equal(await lifecycle.requestRuntimeUpdate(), null);
  assert.equal(updateRequests, 1);
  restartGate.resolve();
  await restart;
  assert.equal(lifecycle.runtimeAction(), "idle");
});

test("a repeated update request shares the update in flight", async () => {
  const updateGate = deferred();
  let updateRequests = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => codexStatus("ready", false),
    restartRuntime: async () => {},
    updateRuntime: async () => {
      updateRequests += 1;
      await updateGate.promise;
      return { status: "noUpdate", message: "Codex was already current." };
    },
  });

  lifecycle.connect();
  await settle();
  const first = lifecycle.requestRuntimeUpdate();
  const second = lifecycle.requestRuntimeUpdate();
  assert.strictEqual(first, second);

  updateGate.resolve();
  await first;
  assert.equal(updateRequests, 1);
});

test("disconnect frees the runtime slot and a late update cannot take it back", async () => {
  const lateUpdate = deferred();
  const restartGate = deferred();
  let loads = 0;
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => {
      loads += 1;
      return codexStatus("ready", false);
    },
    restartRuntime: async () => restartGate.promise,
    updateRuntime: async () => {
      await lateUpdate.promise;
      return { status: "updated", installedVersion: "0.156.0", message: "Updated." };
    },
  });

  lifecycle.connect();
  await settle();
  const update = lifecycle.requestRuntimeUpdate();
  lifecycle.disconnect();
  assert.equal(lifecycle.runtimeAction(), "idle");

  lifecycle.connect();
  await settle();
  const restart = lifecycle.requestRuntimeRestart();
  assert.equal(lifecycle.runtimeAction(), "restarting");

  lateUpdate.resolve();
  await update;
  assert.equal(lifecycle.runtimeAction(), "restarting");
  assert.equal(lifecycle.updateSnapshot().state, "idle");

  restartGate.resolve();
  await restart;
  assert.equal(lifecycle.runtimeAction(), "idle");
  assert.ok(loads >= 2);
});

test("Codex status refuses an update without a supported target", async () => {
  for (const state of [
    "missing",
    "unsupportedInstall",
    "updateRequired",
    "signInRequired",
    "incompatible",
    "error",
  ]) {
    let updateRequests = 0;
    const lifecycle = new CodexStatusLifecycle({
      loadStatus: async () => codexStatus(state),
      restartRuntime: async () => {},
      updateRuntime: async () => {
        updateRequests += 1;
      },
    });

    lifecycle.connect();
    await settle();

    assert.equal(lifecycle.canUpdateRuntime(), false, state);
    assert.equal(await lifecycle.requestRuntimeUpdate(), null, state);
    assert.equal(updateRequests, 0, state);
    lifecycle.disconnect();
  }
});

test("a later readiness change clears a finished update message", async () => {
  let status = codexStatus("restartRequired");
  const lifecycle = new CodexStatusLifecycle({
    loadStatus: async () => status,
    restartRuntime: async () => {},
    updateRuntime: async () => {
      status = codexStatus("ready", false);
      return { status: "noUpdate", message: "Codex restarted the runtime." };
    },
  });

  lifecycle.connect();
  await settle();
  await lifecycle.requestRuntimeUpdate();
  assert.equal(lifecycle.updateSnapshot().state, "succeeded");

  status = codexStatus("restartRequired");
  await lifecycle.refresh();

  assert.equal(lifecycle.updateSnapshot().state, "idle");
});
