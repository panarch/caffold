import assert from "node:assert/strict";
import test from "node:test";
import { CodexRuntimeUpdateLifecycle } from "./runtime-update-lifecycle.js";

const RESTARTED =
  "The managed installation is ready and the running daemon was restarted. Active or queued work may have been interrupted.";
const LEFT_RUNNING =
  "The managed installation and running daemon are already current; the daemon was left running.";

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function lifecycleWith({ updateRuntime, refreshStatus = async () => ({}) }) {
  const states = [];
  const lifecycle = new CodexRuntimeUpdateLifecycle({
    updateRuntime,
    refreshStatus,
    onStateChange: (value) => states.push(value),
  });
  lifecycle.connect();
  return { lifecycle, states };
}

test("an update that installed a release names it before Codex's account", async () => {
  const { lifecycle, states } = lifecycleWith({
    updateRuntime: async () => ({
      status: "updated",
      installedVersion: "0.156.0",
      runningVersion: "0.156.0",
      message: RESTARTED,
    }),
  });

  await lifecycle.update();

  assert.deepEqual(
    states.map(({ state }) => state),
    ["updating", "refreshing", "succeeded"],
  );
  assert.equal(
    states.at(-1).message,
    `Codex updated to 0.156.0. ${RESTARTED}`,
  );
});

test("an update that installed nothing still says whether Codex restarted", async () => {
  for (const message of [RESTARTED, LEFT_RUNNING]) {
    const { lifecycle, states } = lifecycleWith({
      updateRuntime: async () => ({
        status: "noUpdate",
        installedVersion: "0.155.1",
        runningVersion: "0.155.1",
        message,
      }),
    });

    await lifecycle.update();

    assert.deepEqual(states.at(-1), { state: "succeeded", message });
  }
});

test("an installation Codex cannot update from here reads as a failure", async () => {
  const message =
    "This command requires a CLI-managed daemon and a stable latest-channel standalone install; update this installation with its owning installer.";
  const { lifecycle, states } = lifecycleWith({
    updateRuntime: async () => ({ status: "unsupported", message }),
  });

  await lifecycle.update();

  assert.deepEqual(states.at(-1), { state: "failed", message });
});

test("a failed update keeps the reason Caffold was given", async () => {
  const { lifecycle, states } = lifecycleWith({
    updateRuntime: async () => {
      throw new Error("Codex update failed: standalone Codex updater exited with status 1");
    },
  });

  assert.equal(await lifecycle.update(), null);

  assert.deepEqual(
    states.map(({ state }) => state),
    ["updating", "failed"],
  );
  assert.equal(
    states.at(-1).message,
    "Codex update failed: standalone Codex updater exited with status 1",
  );
});

test("an update whose readiness refresh fails keeps what the update did", async () => {
  const { lifecycle, states } = lifecycleWith({
    updateRuntime: async () => ({
      status: "noUpdate",
      message: LEFT_RUNNING,
    }),
    refreshStatus: async () => {
      throw new Error("status unavailable");
    },
  });

  await lifecycle.update();

  assert.equal(states.at(-1).state, "failed");
  assert.equal(
    states.at(-1).message,
    `${LEFT_RUNNING} Readiness could not be refreshed: status unavailable`,
  );
});

test("a repeated update request shares the one in flight", async () => {
  const gate = deferred();
  let requests = 0;
  const { lifecycle } = lifecycleWith({
    updateRuntime: async () => {
      requests += 1;
      await gate.promise;
      return { status: "noUpdate", message: LEFT_RUNNING };
    },
  });

  const first = lifecycle.update();
  const second = lifecycle.update();
  gate.resolve();
  await first;

  assert.strictEqual(first, second);
  assert.equal(requests, 1);
});

test("disconnect drops an update response that arrives later", async () => {
  const gate = deferred();
  const { lifecycle, states } = lifecycleWith({
    updateRuntime: async () => {
      await gate.promise;
      return { status: "updated", installedVersion: "0.156.0", message: RESTARTED };
    },
  });

  const request = lifecycle.update();
  lifecycle.disconnect();
  gate.resolve();

  assert.equal(await request, null);
  assert.deepEqual(
    states.map(({ state }) => state),
    ["updating", "idle"],
  );
});

test("reset clears a finished outcome but not an update in flight", async () => {
  const gate = deferred();
  const { lifecycle } = lifecycleWith({
    updateRuntime: async () => {
      await gate.promise;
      return { status: "noUpdate", message: LEFT_RUNNING };
    },
  });

  const request = lifecycle.update();
  lifecycle.reset();
  assert.equal(lifecycle.snapshot().state, "updating");

  gate.resolve();
  await request;
  lifecycle.reset();
  assert.deepEqual(lifecycle.snapshot(), { state: "idle", message: "" });
});
