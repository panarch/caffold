import assert from "node:assert/strict";
import test from "node:test";

import { DecisionModelSettingsLifecycle } from "./lifecycle.js";

function provider(overrides = {}) {
  return { keyConfigured: false, lastCheck: null, ...overrides };
}

function settings(overrides = {}) {
  return {
    selected: "jev",
    criteria: "",
    jev: provider(),
    openai: provider(),
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
  const lifecycle = new DecisionModelSettingsLifecycle({
    load: async () => settings(),
    selectProvider: async () => settings(),
    saveCriteria: async () => settings(),
    storeKey: async () => settings(),
    removeKey: async () => settings(),
    ...requests,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { lifecycle, snapshots };
}

test("loading publishes the choice, each provider's key state, and the rules", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () =>
      settings({
        selected: "openai",
        criteria: "Allow reads inside the worktree.",
        openai: provider({ keyConfigured: true, lastCheck: { ok: true, message: null } }),
      }),
  });

  lifecycle.activate();
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(latest.fresh, true);
  assert.equal(latest.busy, false);
  assert.equal(latest.retry, false);
  assert.equal(latest.settings.selected, "openai");
  assert.equal(latest.settings.criteria, "Allow reads inside the worktree.");
  assert.deepEqual(latest.settings.openai, {
    keyConfigured: true,
    lastCheck: { ok: true, message: null },
  });
  assert.deepEqual(latest.settings.jev, { keyConfigured: false, lastCheck: null });
});

test("a load failure offers a retry and keeps nothing stale", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => {
      throw new Error("Caffold could not read its decision model settings.");
    },
  });

  lifecycle.activate();
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(latest.fresh, false);
  assert.equal(latest.retry, true);
  assert.equal(latest.settings, null);
  assert.equal(latest.message, "Caffold could not read its decision model settings.");
});

test("choosing a provider asks the server and shows what it kept", async () => {
  let chosen = null;
  const { lifecycle, snapshots } = lifecycleWith({
    selectProvider: async (provider) => {
      chosen = provider;
      return settings({ selected: provider });
    },
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.selectProvider("openai"), true);
  await settle();

  assert.equal(chosen, "openai");
  assert.equal(snapshots.at(-1).settings.selected, "openai");
});

test("choosing the provider already chosen asks nothing", async () => {
  let asked = 0;
  const { lifecycle } = lifecycleWith({
    selectProvider: async () => {
      asked += 1;
      return settings();
    },
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.selectProvider("jev"), false);
  assert.equal(asked, 0);
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

test("storing a key goes to its provider and reports what checking it found", async () => {
  let stored = null;
  const { lifecycle, snapshots } = lifecycleWith({
    storeKey: async (provider, key) => {
      stored = { provider, key };
      return settings({
        openai: provider === "openai"
          ? { keyConfigured: true, lastCheck: { ok: false, message: "OpenAI rejected the API key." } }
          : { keyConfigured: false, lastCheck: null },
      });
    },
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.storeKey("openai", "sk-test"), true);
  await settle();

  assert.deepEqual(stored, { provider: "openai", key: "sk-test" });
  const latest = snapshots.at(-1);
  assert.equal(latest.settings.openai.keyConfigured, true);
  assert.equal(latest.settings.openai.lastCheck.message, "OpenAI rejected the API key.");
  assert.equal(latest.settings.jev.keyConfigured, false);
});

test("removing a key forgets what its last check said", async () => {
  let removed = null;
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () =>
      settings({ jev: provider({ keyConfigured: true, lastCheck: { ok: true, message: null } }) }),
    removeKey: async (provider) => {
      removed = provider;
      return settings();
    },
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.removeKey("jev"), true);
  await settle();

  assert.equal(removed, "jev");
  const latest = snapshots.at(-1);
  assert.equal(latest.settings.jev.keyConfigured, false);
  assert.equal(latest.settings.jev.lastCheck, null);
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
  for (const payload of [
    { selected: "jev", criteria: "" },
    settings({ selected: "gemini" }),
    settings({ openai: { keyConfigured: "yes", lastCheck: null } }),
  ]) {
    const { lifecycle, snapshots } = lifecycleWith({ load: async () => payload });

    lifecycle.activate();
    await settle();

    assert.equal(snapshots.at(-1).settings, null);
    assert.equal(
      snapshots.at(-1).message,
      "Caffold returned invalid decision model settings.",
    );
  }
});
