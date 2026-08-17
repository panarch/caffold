import assert from "node:assert/strict";
import test from "node:test";
import {
  TailscaleLifecycle,
  canonicalTailnetUrl,
  normalizeTailscaleStatus,
  tailscaleQrCodeUrl,
} from "./tailscale.js";

function status(state, overrides = {}) {
  return {
    state,
    reasonCode: `${state}Reason`,
    diagnosticMessage: `${state} diagnostic`,
    tailnetUrl: state === "ready" ? "https://caffold.example.ts.net/" : null,
    canManage: true,
    ...overrides,
  };
}

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

test("normalizes every canonical server state and preserves remote read-only access", () => {
  for (const stateName of [
    "notInstalled",
    "disconnected",
    "serveOff",
    "configuring",
    "disabling",
    "ready",
    "unavailable",
    "failed",
  ]) {
    const normalized = normalizeTailscaleStatus(status(stateName, { canManage: false }));
    assert.equal(normalized.state, stateName);
    assert.equal(normalized.canManage, false);
  }
});

test("accepts only canonical private HTTPS Tailnet URLs", () => {
  const privateUrl = "https://caffold.example.ts.net/";
  assert.equal(canonicalTailnetUrl(privateUrl), privateUrl);
  for (const invalid of [
    "http://caffold.example.ts.net/",
    "https://example.com/",
    "https://caffold.example.ts.net:8443/",
    "https://caffold.example.ts.net/path",
    "https://caffold.example.ts.net/?public=true",
  ]) {
    assert.throws(() => canonicalTailnetUrl(invalid), /invalid Tailnet URL/);
  }
  assert.throws(
    () => normalizeTailscaleStatus(status("ready", { tailnetUrl: null })),
    /without a Tailnet URL/,
  );
});

test("builds the server QR resource from the exact canonical Tailnet URL", () => {
  assert.equal(
    tailscaleQrCodeUrl("https://caffold.example.ts.net/"),
    "/api/tailscale/qr.svg?url=https%3A%2F%2Fcaffold.example.ts.net%2F",
  );
  assert.throws(
    () => tailscaleQrCodeUrl("https://example.com/"),
    /invalid Tailnet URL/,
  );
});

test("polls a server-owned transition until the canonical state is ready", async () => {
  const responses = [status("configuring"), status("ready")];
  const snapshots = [];
  let poll;
  const lifecycle = new TailscaleLifecycle({
    load: async () => responses.shift(),
    update: async () => status("ready"),
    onChange: (snapshot) => snapshots.push(snapshot),
    schedule: (callback) => {
      poll = callback;
      return 1;
    },
    cancel: () => {},
  });

  lifecycle.activate();
  await settle();
  assert.equal(snapshots.at(-1).status.state, "configuring");
  assert.equal(snapshots.at(-1).busy, true);
  poll();
  await settle();
  assert.equal(snapshots.at(-1).status.state, "ready");
  assert.equal(snapshots.at(-1).busy, false);
  lifecycle.deactivate();
});

test("retains canonical state until the server publishes mutation progress", async () => {
  const gate = deferred();
  const updates = [];
  const snapshots = [];
  const loads = [status("serveOff"), status("configuring")];
  const scheduled = [];
  const lifecycle = new TailscaleLifecycle({
    load: async () => loads.shift(),
    update: async (enabled) => {
      updates.push(enabled);
      await gate.promise;
      return status("ready");
    },
    onChange: (snapshot) => snapshots.push(snapshot),
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel: () => {},
  });

  lifecycle.activate();
  await settle();
  const updating = lifecycle.setEnabled(true);
  assert.equal(snapshots.at(-1).status.state, "serveOff");
  assert.equal(snapshots.at(-1).busy, true);
  assert.deepEqual(updates, [true]);
  scheduled.shift()();
  await settle();
  assert.equal(snapshots.at(-1).status.state, "configuring");
  assert.equal(snapshots.at(-1).busy, true);
  gate.resolve();
  await updating;
  assert.equal(snapshots.at(-1).status.state, "ready");
  lifecycle.deactivate();
});

test("ignores a late status response after the page is deactivated", async () => {
  const gate = deferred();
  const snapshots = [];
  const lifecycle = new TailscaleLifecycle({
    load: async () => gate.promise,
    update: async () => status("ready"),
    onChange: (snapshot) => snapshots.push(snapshot),
    schedule: () => 1,
    cancel: () => {},
  });

  lifecycle.activate();
  lifecycle.deactivate();
  gate.resolve(status("ready"));
  await settle();
  assert.equal(snapshots.at(-1).status, null);
  assert.equal(snapshots.at(-1).busy, true);
});

test("ignores late mutation and mutation-poll responses after deactivation", async () => {
  const updateGate = deferred();
  const pollGate = deferred();
  const snapshots = [];
  const scheduled = [];
  let loads = 0;
  const lifecycle = new TailscaleLifecycle({
    load: async () => {
      loads += 1;
      return loads === 1 ? status("serveOff") : pollGate.promise;
    },
    update: async () => updateGate.promise,
    onChange: (snapshot) => snapshots.push(snapshot),
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel: () => {},
  });

  lifecycle.activate();
  await settle();
  const updating = lifecycle.setEnabled(true);
  scheduled.shift()();
  lifecycle.deactivate();
  pollGate.resolve(status("configuring"));
  updateGate.resolve(status("ready"));
  await updating;
  await settle();
  assert.equal(
    snapshots.some((snapshot) => snapshot.status?.state === "configuring"),
    false,
  );
  assert.equal(
    snapshots.some((snapshot) => snapshot.status?.state === "ready"),
    false,
  );
});

test("keeps the last canonical status when a refresh request fails", async () => {
  let loads = 0;
  const lifecycle = new TailscaleLifecycle({
    load: async () => {
      loads += 1;
      if (loads === 1) return status("ready");
      throw new Error("The status request was interrupted.");
    },
    schedule: () => 1,
    cancel: () => {},
  });

  lifecycle.activate();
  await settle();
  await lifecycle.refresh();
  assert.equal(lifecycle.snapshot.status.state, "ready");
  assert.equal(lifecycle.snapshot.status.canManage, true);
  assert.equal(lifecycle.snapshot.statusFresh, false);
  assert.equal(lifecycle.snapshot.busy, false);
  assert.equal(lifecycle.snapshot.retryIntent, "refresh");
  assert.match(lifecycle.snapshot.message, /interrupted/);
  lifecycle.deactivate();
});

test("does not invent a domain status when the initial request fails", async () => {
  const lifecycle = new TailscaleLifecycle({
    load: async () => {
      throw new Error("The host is unavailable.");
    },
    schedule: () => 1,
    cancel: () => {},
  });

  lifecycle.activate();
  await settle();
  assert.equal(lifecycle.snapshot.status, null);
  assert.equal(lifecycle.snapshot.statusFresh, false);
  assert.equal(lifecycle.snapshot.busy, false);
  assert.equal(lifecycle.snapshot.retryIntent, "refresh");
  assert.match(lifecycle.snapshot.message, /unavailable/);
  lifecycle.deactivate();
});

test("keeps mutation transport failure separate from canonical status", async () => {
  const scheduled = [];
  const lifecycle = new TailscaleLifecycle({
    load: async () => status("serveOff"),
    update: async () => {
      throw new Error("The update response was interrupted.");
    },
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel: () => {},
  });

  lifecycle.activate();
  await settle();
  await lifecycle.setEnabled(true);
  assert.equal(lifecycle.snapshot.status.state, "serveOff");
  assert.equal(lifecycle.snapshot.status.canManage, true);
  assert.equal(lifecycle.snapshot.statusFresh, false);
  assert.equal(lifecycle.snapshot.busy, true);
  assert.equal(lifecycle.snapshot.retryIntent, "enable");
  assert.match(lifecycle.snapshot.message, /interrupted/);
  lifecycle.deactivate();
});

test("retries the failed Caffold Serve operation only when management is local", async () => {
  const updates = [];
  const lifecycle = new TailscaleLifecycle({
    load: async () => status("failed", { reasonCode: "serveEnableFailed" }),
    update: async (enabled) => {
      updates.push(enabled);
      return status("ready");
    },
    schedule: () => 1,
    cancel: () => {},
  });
  lifecycle.activate();
  await settle();
  await lifecycle.retry();
  assert.deepEqual(updates, [true]);
  lifecycle.deactivate();

  const remote = new TailscaleLifecycle({
    load: async () => status("failed", {
      reasonCode: "serveEnableFailed",
      canManage: false,
    }),
    update: async (enabled) => updates.push(enabled),
    schedule: () => 1,
    cancel: () => {},
  });
  remote.activate();
  await settle();
  await remote.retry();
  assert.deepEqual(updates, [true]);
  remote.deactivate();
});
