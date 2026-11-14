import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeSettingsLifecycle } from "./lifecycle.js";

const DEFAULT = "/Users/someone/.claude";

function settings(configDir = null) {
  return { configDir, defaultConfigDir: DEFAULT };
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
  update = async (configDir) => settings(configDir || null),
} = {}) {
  const snapshots = [];
  const sent = [];
  const lifecycle = new ClaudeSettingsLifecycle({
    load,
    update: (configDir) => {
      sent.push(configDir);
      return update(configDir);
    },
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { lifecycle, snapshots, sent };
}

test("loading shows the saved folder and the default and allows a change", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => settings("/Volumes/work/.claude"),
  });

  lifecycle.activate();
  assert.equal(lifecycle.phase, "loading");
  assert.equal(snapshots.at(-1).busy, true);
  assert.equal(snapshots.at(-1).ready, false);
  await settle();

  const latest = snapshots.at(-1);
  assert.equal(lifecycle.phase, "ready");
  assert.deepEqual(latest.settings, settings("/Volumes/work/.claude"));
  assert.equal(latest.ready, true);
  assert.equal(latest.busy, false);
  assert.equal(latest.retry, false);
});

test("a load that fails offers a retry, and the retry loads again", async () => {
  let attempts = 0;
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Claude settings cannot be read.");
      return settings();
    },
  });

  lifecycle.activate();
  await settle();
  assert.equal(lifecycle.phase, "unavailable");
  assert.equal(snapshots.at(-1).retry, true);
  assert.equal(snapshots.at(-1).message, "Claude settings cannot be read.");

  lifecycle.retry();
  assert.equal(lifecycle.phase, "loading");
  assert.equal(snapshots.at(-1).message, "");
  await settle();
  assert.equal(lifecycle.phase, "ready");
});

test("saving sends the folder, holds the field, and shows the server's answer", async () => {
  const answer = deferred();
  const { lifecycle, snapshots, sent } = lifecycleWith({
    update: () => answer.promise,
  });
  lifecycle.activate();
  await settle();

  const saving = lifecycle.save("~/.claude-work");
  assert.equal(lifecycle.phase, "saving");
  assert.equal(snapshots.at(-1).ready, false);
  assert.equal(snapshots.at(-1).busy, true);
  answer.resolve(settings("/Users/someone/.claude-work"));

  assert.equal(await saving, true);
  assert.deepEqual(sent, ["~/.claude-work"]);
  assert.equal(lifecycle.phase, "ready");
  assert.deepEqual(
    snapshots.at(-1).settings,
    settings("/Users/someone/.claude-work"),
  );
});

test("a second save is refused while the first is in flight", async () => {
  const answer = deferred();
  const { lifecycle, sent } = lifecycleWith({ update: () => answer.promise });
  lifecycle.activate();
  await settle();

  const first = lifecycle.save("/Volumes/work/.claude");
  const second = lifecycle.save("/Volumes/other/.claude");
  // Counted before anything is awaited: a second save that reached the
  // server would wait on the same held answer.
  assert.deepEqual(sent, ["/Volumes/work/.claude"]);
  answer.resolve(settings("/Volumes/work/.claude"));

  assert.equal(await second, false);
  assert.equal(await first, true);
});

test("nothing is saved before the setting is read or after the page is left", async () => {
  const { lifecycle, sent } = lifecycleWith();

  assert.equal(await lifecycle.save("/Volumes/work/.claude"), false);
  lifecycle.activate();
  assert.equal(await lifecycle.save("/Volumes/work/.claude"), false);
  await settle();
  lifecycle.deactivate();
  assert.equal(await lifecycle.save("/Volumes/work/.claude"), false);

  assert.deepEqual(sent, []);
});

test("a folder the server refuses says why and keeps the saved one", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => settings("/Volumes/work/.claude"),
    update: async () => {
      throw refusal("This folder does not exist.", 400);
    },
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.save("/Volumes/missing"), false);

  const latest = snapshots.at(-1);
  assert.equal(lifecycle.phase, "ready");
  assert.equal(latest.message, "This folder does not exist.");
  assert.deepEqual(latest.settings, settings("/Volumes/work/.claude"));
  assert.equal(latest.retry, false);
});

test("a save whose outcome is unknown reads the setting again before another", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    update: async () => {
      throw refusal("Caffold could not be reached.", 0);
    },
  });
  lifecycle.activate();
  await settle();

  assert.equal(await lifecycle.save("/Volumes/work/.claude"), false);

  assert.equal(lifecycle.phase, "unavailable");
  assert.equal(snapshots.at(-1).retry, true);
  assert.equal(snapshots.at(-1).message, "Caffold could not be reached.");
});

test("an answer that arrives after leaving is not published", async () => {
  const answer = deferred();
  const { lifecycle, snapshots } = lifecycleWith({ load: () => answer.promise });
  lifecycle.activate();
  lifecycle.deactivate();
  const published = snapshots.length;

  answer.resolve(settings("/Volumes/work/.claude"));
  await settle();

  assert.equal(lifecycle.phase, "inactive");
  assert.equal(snapshots.length, published);
});

test("a save that ends after leaving is dropped", async () => {
  const answer = deferred();
  const { lifecycle, snapshots } = lifecycleWith({
    update: () => answer.promise,
  });
  lifecycle.activate();
  await settle();
  const saving = lifecycle.save("/Volumes/work/.claude");
  lifecycle.deactivate();
  const published = snapshots.length;

  answer.reject(refusal("This folder does not exist.", 400));

  assert.equal(await saving, false);
  assert.equal(lifecycle.phase, "inactive");
  assert.equal(snapshots.length, published);
});

test("leaving after a failed read stops offering the retry", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => {
      throw new Error("Claude settings cannot be read.");
    },
  });
  lifecycle.activate();
  await settle();

  lifecycle.deactivate();
  lifecycle.retry();

  assert.equal(lifecycle.phase, "inactive");
  assert.equal(snapshots.at(-1).retry, true, "nothing new is published");
});

test("coming back reads the setting again", async () => {
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
  await settle();

  assert.equal(reads, 2);
  assert.equal(lifecycle.phase, "ready");
});

test("retry does nothing unless the setting could not be read", async () => {
  let reads = 0;
  const { lifecycle } = lifecycleWith({
    load: async () => {
      reads += 1;
      return settings();
    },
  });
  lifecycle.activate();
  await settle();

  lifecycle.retry();
  await settle();

  assert.equal(reads, 1);
  assert.equal(lifecycle.phase, "ready");
});

test("an unreadable answer is refused rather than shown", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => ({ configDir: 7, defaultConfigDir: DEFAULT }),
  });

  lifecycle.activate();
  await settle();

  assert.equal(lifecycle.phase, "unavailable");
  assert.equal(snapshots.at(-1).settings, null);
  assert.equal(
    snapshots.at(-1).message,
    "Caffold returned invalid Claude settings.",
  );
});
