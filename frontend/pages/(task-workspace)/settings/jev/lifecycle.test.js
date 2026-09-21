import assert from "node:assert/strict";
import test from "node:test";

import { JevSettingsLifecycle } from "./lifecycle.js";

function settings(overrides = {}) {
  return {
    model: "jev-1.13.0",
    keyConfigured: false,
    criteria: "",
    lastCheck: null,
    ...overrides,
  };
}

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}

function lifecycleWith(requests) {
  const snapshots = [];
  const lifecycle = new JevSettingsLifecycle({
    load: async () => settings(),
    saveCriteria: async () => settings(),
    storeKey: async () => settings(),
    removeKey: async () => settings(),
    ...requests,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { lifecycle, snapshots };
}

test("loading publishes the saved rules and the last check", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () =>
      settings({
        keyConfigured: true,
        criteria: "Allow reads inside the worktree.",
        lastCheck: { ok: true, message: null, model: "jev-1.13.0" },
      }),
  });

  lifecycle.activate();
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(latest.fresh, true);
  assert.equal(latest.busy, false);
  assert.equal(latest.retry, false);
  assert.equal(latest.settings.criteria, "Allow reads inside the worktree.");
  assert.deepEqual(latest.settings.lastCheck, {
    ok: true,
    message: null,
    model: "jev-1.13.0",
  });
});

test("a load failure offers a retry and keeps nothing stale", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => {
      throw new Error("Caffold could not read its Jev settings.");
    },
  });

  lifecycle.activate();
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(latest.fresh, false);
  assert.equal(latest.retry, true);
  assert.equal(latest.settings, null);
  assert.equal(latest.message, "Caffold could not read its Jev settings.");
});

test("saved rules replace what the page shows", async () => {
  let saved = null;
  const { lifecycle, snapshots } = lifecycleWith({
    saveCriteria: async (criteria) => {
      saved = criteria;
      return settings({ criteria });
    },
  });
  lifecycle.activate();
  await settle();

  const accepted = await lifecycle.saveCriteria("Never leave the worktree.");
  await settle();

  assert.equal(accepted, true);
  assert.equal(saved, "Never leave the worktree.");
  assert.equal(snapshots.at(-1).settings.criteria, "Never leave the worktree.");
});

test("rules the server refuses leave the page usable and say why", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    saveCriteria: async () => {
      const error = new Error("The rules are too long.");
      error.status = 400;
      throw error;
    },
  });
  lifecycle.activate();
  await settle();

  const accepted = await lifecycle.saveCriteria("x".repeat(20000));
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(accepted, false);
  assert.equal(latest.fresh, true, "a refused change is not a lost connection");
  assert.equal(latest.retry, false);
  assert.equal(latest.message, "The rules are too long.");
});

test("storing a key reports what checking it found", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    storeKey: async () =>
      settings({
        keyConfigured: true,
        lastCheck: { ok: false, message: "TypeSafe rejected the API key.", model: null },
      }),
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.storeKey("ts-test"), true);
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(latest.settings.keyConfigured, true);
  assert.equal(latest.settings.lastCheck.ok, false);
  assert.equal(latest.settings.lastCheck.message, "TypeSafe rejected the API key.");
});

test("removing the key forgets what the last check said", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () =>
      settings({
        keyConfigured: true,
        lastCheck: { ok: true, message: null, model: "jev-1.13.0" },
      }),
    removeKey: async () => settings({ keyConfigured: false, lastCheck: null }),
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.removeKey(), true);
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(latest.settings.keyConfigured, false);
  assert.equal(latest.settings.lastCheck, null);
});

test("a deactivated page ignores the answer it was still waiting for", async () => {
  let release = () => {};
  const { lifecycle, snapshots } = lifecycleWith({
    load: () =>
      new Promise((resolve) => {
        release = () => resolve(settings({ criteria: "late" }));
      }),
  });
  lifecycle.activate();
  await settle();
  const before = snapshots.length;

  lifecycle.deactivate();
  release();
  await settle();

  assert.equal(snapshots.length, before, "nothing is published after leaving");
});

test("an unreadable payload is refused rather than shown", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => ({ model: "jev-1.13.0" }),
  });

  lifecycle.activate();
  await settle();

  assert.equal(snapshots.at(-1).settings, null);
  assert.equal(snapshots.at(-1).message, "Caffold returned invalid Jev settings.");
});
