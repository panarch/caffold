import assert from "node:assert/strict";
import test from "node:test";

import { ServerSettingsLifecycle } from "./lifecycle.js";

const ICONS = [
  { id: "default", label: "Default" },
  { id: "red", label: "Red" },
  { id: "blue", label: "Blue" },
];

function settings(overrides = {}) {
  return { name: "Caffold", icon: "default", icons: ICONS, ...overrides };
}

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function refusal(message, status) {
  return Object.assign(new Error(message), { status });
}

function lifecycleWith({
  load = async () => settings(),
  update = async (changes) => settings(changes),
} = {}) {
  const snapshots = [];
  const shown = [];
  const sent = [];
  const lifecycle = new ServerSettingsLifecycle({
    load,
    update: (changes) => {
      sent.push(changes);
      return update(changes);
    },
    show: (identity) => shown.push(identity),
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { lifecycle, snapshots, shown, sent };
}

test("loading shows the saved name, icon, and offered icons and allows a change", async () => {
  const { lifecycle, snapshots, shown } = lifecycleWith({
    load: async () => settings({ name: "Caffold Studio", icon: "red" }),
  });

  lifecycle.activate();
  assert.equal(lifecycle.phase, "loading");
  assert.equal(snapshots.at(-1).busy, true);
  assert.equal(snapshots.at(-1).ready, false);
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(lifecycle.phase, "ready");
  assert.deepEqual(latest.settings, settings({ name: "Caffold Studio", icon: "red" }));
  assert.equal(latest.ready, true);
  assert.equal(latest.busy, false);
  assert.equal(latest.retry, false);
  assert.deepEqual(shown, [{ name: "Caffold Studio", icon: "red" }]);
});

test("a load that fails offers a retry, and the retry loads again", async () => {
  let attempts = 0;
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Caffold could not be reached.");
      return settings();
    },
  });

  lifecycle.activate();
  await settle();
  assert.equal(lifecycle.phase, "unavailable");
  assert.equal(snapshots.at(-1).retry, true);
  assert.equal(snapshots.at(-1).ready, false);
  assert.equal(snapshots.at(-1).message, "Caffold could not be reached.");

  lifecycle.retry();
  await settle();
  assert.equal(lifecycle.phase, "ready");
  assert.equal(snapshots.at(-1).message, "");
  assert.equal(attempts, 2);
});

test("leaving after a failed read stops offering the retry", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => {
      throw new Error("Caffold could not be reached.");
    },
  });
  lifecycle.activate();
  await settle();
  assert.equal(lifecycle.phase, "unavailable");

  lifecycle.deactivate();

  assert.equal(lifecycle.phase, "inactive");
  lifecycle.retry();
  assert.equal(lifecycle.phase, "inactive");
  assert.equal(snapshots.at(-1).retry, true, "nothing is published while away");
});

test("saving a name or an icon sends only that field and shows the answer", async () => {
  const { lifecycle, snapshots, shown, sent } = lifecycleWith({
    update: async (changes) => settings({ name: "Caffold Linux", icon: "blue", ...changes }),
  });
  lifecycle.activate();
  await settle();

  const icon = lifecycle.saveIcon("red");
  assert.equal(lifecycle.phase, "saving");
  assert.equal(snapshots.at(-1).busy, true);
  assert.equal(snapshots.at(-1).ready, false);
  assert.equal(await icon, true);
  assert.equal(snapshots.at(-1).settings.icon, "red");

  assert.equal(await lifecycle.saveName("Caffold Linux"), true);
  assert.deepEqual(sent, [{ icon: "red" }, { name: "Caffold Linux" }]);
  assert.equal(lifecycle.phase, "ready");
  assert.deepEqual(shown.slice(1), [
    { name: "Caffold Linux", icon: "red" },
    { name: "Caffold Linux", icon: "blue" },
  ]);
});

test("a second change is refused while the first is in flight", async () => {
  const first = deferred();
  const { lifecycle, sent } = lifecycleWith({ update: () => first.promise });
  lifecycle.activate();
  await settle();

  const changes = [
    lifecycle.saveIcon("red"),
    lifecycle.saveIcon("blue"),
    lifecycle.saveName("Caffold Linux"),
  ];
  assert.deepEqual(sent, [{ icon: "red" }]);
  first.resolve(settings({ icon: "red" }));

  assert.deepEqual(await Promise.all(changes), [true, false, false]);
  assert.deepEqual(sent, [{ icon: "red" }]);
});

test("nothing is changed before the settings are read or after the page is left", async () => {
  const load = deferred();
  const { lifecycle, sent } = lifecycleWith({ load: () => load.promise });

  assert.equal(await lifecycle.saveIcon("red"), false);
  lifecycle.activate();
  assert.equal(await lifecycle.saveIcon("red"), false);
  load.resolve(settings());
  await settle();
  lifecycle.deactivate();
  assert.equal(lifecycle.phase, "inactive");
  assert.equal(await lifecycle.saveIcon("red"), false);
  assert.deepEqual(sent, []);
});

test("a change the server refuses says why and allows another", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    update: async () => {
      throw refusal("server name cannot exceed 64 characters", 400);
    },
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.saveName("x".repeat(65)), false);

  const latest = snapshots.at(-1);
  assert.equal(lifecycle.phase, "ready");
  assert.equal(latest.ready, true);
  assert.equal(latest.retry, false);
  assert.equal(latest.message, "server name cannot exceed 64 characters");
  assert.equal(latest.settings.name, "Caffold");
});

test("a change whose outcome is unknown reads the settings again before another", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    update: async () => {
      throw refusal("Request timed out.", 0);
    },
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.saveIcon("red"), false);

  assert.equal(lifecycle.phase, "unavailable");
  assert.equal(snapshots.at(-1).ready, false);
  assert.equal(snapshots.at(-1).retry, true);
  assert.equal(snapshots.at(-1).message, "Request timed out.");
});

test("an answer that arrives after leaving is not published", async () => {
  const load = deferred();
  const { lifecycle, snapshots, shown } = lifecycleWith({ load: () => load.promise });
  lifecycle.activate();
  const before = snapshots.length;

  lifecycle.deactivate();
  load.resolve(settings({ name: "Late" }));
  await settle();

  assert.equal(snapshots.length, before, "nothing is published after leaving");
  assert.equal(lifecycle.phase, "inactive");
  assert.deepEqual(shown, [{ name: "Late", icon: "default" }], "the document still shows it");
});

test("a change saved after leaving is still shown in the document", async () => {
  const save = deferred();
  const { lifecycle, snapshots, shown } = lifecycleWith({ update: () => save.promise });
  lifecycle.activate();
  await settle();
  const pending = lifecycle.saveIcon("blue");

  lifecycle.deactivate();
  const published = snapshots.length;
  save.resolve(settings({ icon: "blue" }));

  assert.equal(await pending, false);
  assert.equal(snapshots.length, published);
  assert.deepEqual(shown.at(-1), { name: "Caffold", icon: "blue" });
});

test("a failure that arrives after leaving is dropped", async () => {
  const save = deferred();
  const { lifecycle, snapshots } = lifecycleWith({ update: () => save.promise });
  lifecycle.activate();
  await settle();
  const pending = lifecycle.saveIcon("blue");
  lifecycle.deactivate();
  const published = snapshots.length;

  save.reject(refusal("Request timed out.", 0));

  assert.equal(await pending, false);
  assert.equal(snapshots.length, published);
  assert.equal(lifecycle.phase, "inactive");
});

test("coming back reads the settings again", async () => {
  let reads = 0;
  const { lifecycle } = lifecycleWith({
    load: async () => {
      reads += 1;
      return settings();
    },
  });
  lifecycle.activate();
  await settle();
  lifecycle.deactivate();

  lifecycle.activate();
  assert.equal(lifecycle.phase, "loading");
  await settle();
  assert.equal(lifecycle.phase, "ready");
  assert.equal(reads, 2);
});

test("retry does nothing unless the settings could not be read", async () => {
  let reads = 0;
  const { lifecycle } = lifecycleWith({
    load: async () => {
      reads += 1;
      return settings();
    },
  });
  lifecycle.retry();
  lifecycle.activate();
  lifecycle.retry();
  await settle();
  lifecycle.retry();
  await settle();

  assert.equal(reads, 1);
  assert.equal(lifecycle.phase, "ready");
});

test("an unreadable answer is refused rather than shown", async () => {
  const { lifecycle, snapshots, shown } = lifecycleWith({
    load: async () => ({ name: "Caffold", icon: "default", icons: [{ id: "red" }] }),
  });

  lifecycle.activate();
  await settle();

  assert.equal(lifecycle.phase, "unavailable");
  assert.equal(snapshots.at(-1).settings, null);
  assert.equal(snapshots.at(-1).message, "Caffold returned invalid server settings.");
  assert.deepEqual(shown, []);
});
