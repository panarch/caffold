import assert from "node:assert/strict";
import test from "node:test";

import { VoiceSettingsLifecycle, voiceReadinessKey } from "./lifecycle.js";

function settings({ selected = "whisper", whisper = {}, openai = {}, gemini = {} } = {}) {
  return {
    selected,
    whisper: {
      model: "large-v3-turbo",
      revision: "5359861c739e955e79d9a303bcbc70fb988958b1",
      bytes: 1_624_555_275,
      installed: false,
      loaded: false,
      downloading: false,
      downloadError: null,
      ...whisper,
    },
    openai: { model: "gpt-transcribe", keyConfigured: false, ...openai },
    gemini: { model: "gemini-3.5-transcribe", keyConfigured: false, ...gemini },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function settle() {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}

function lifecycleWith(requests) {
  const snapshots = [];
  const scheduled = [];
  const cancelled = [];
  const lifecycle = new VoiceSettingsLifecycle({
    load: async () => settings(),
    select: async () => settings(),
    startDownload: async () => settings(),
    removeModel: async () => settings(),
    storeKey: async () => settings(),
    removeKey: async () => settings(),
    ...requests,
    onChange: (snapshot) => snapshots.push(snapshot),
    schedule: (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    },
    cancel: (timer) => cancelled.push(timer),
  });
  return { lifecycle, snapshots, scheduled, cancelled };
}

test("accepts only the settings shape the server publishes", async () => {
  for (const invalid of [
    null,
    { ...settings(), selected: "parakeet" },
    { ...settings(), whisper: { ...settings().whisper, installed: "yes" } },
    { ...settings(), whisper: { ...settings().whisper, downloadError: 5 } },
    { ...settings(), whisper: { ...settings().whisper, revision: undefined } },
    { ...settings(), openai: undefined },
    { ...settings(), gemini: { keyConfigured: false } },
  ]) {
    const { lifecycle, snapshots } = lifecycleWith({ load: async () => invalid });
    lifecycle.activate();
    await settle();
    assert.equal(snapshots.at(-1).settings, null);
    assert.equal(snapshots.at(-1).retry, true);
    assert.equal(snapshots.at(-1).message, "Caffold returned invalid voice settings.");
    lifecycle.deactivate();
  }

  const { lifecycle, snapshots } = lifecycleWith({
    load: async () => ({ ...settings(), unexpected: "dropped" }),
  });
  lifecycle.activate();
  await settle();
  assert.deepEqual(snapshots.at(-1).settings, settings());
  lifecycle.deactivate();
});

test("changes the readiness key only with what decides Composer readiness", () => {
  const base = voiceReadinessKey(settings());
  assert.equal(
    voiceReadinessKey(settings({ whisper: { loaded: true, downloading: true, downloadError: "failed" } })),
    base,
  );
  for (const changed of [
    settings({ selected: "openai" }),
    settings({ whisper: { installed: true } }),
    settings({ openai: { keyConfigured: true } }),
    settings({ gemini: { keyConfigured: true } }),
  ]) {
    assert.notEqual(voiceReadinessKey(changed), base);
  }
});

test("loads once active and ignores a load that finishes after deactivation", async () => {
  const firstLoad = deferred();
  const loads = [firstLoad.promise, Promise.resolve(settings({ openai: { keyConfigured: true } }))];
  const { lifecycle, snapshots } = lifecycleWith({ load: () => loads.shift() });

  lifecycle.activate();
  assert.deepEqual(snapshots.at(-1), {
    settings: null,
    fresh: false,
    busy: true,
    retry: false,
    message: "",
  });
  lifecycle.deactivate();
  firstLoad.resolve(settings());
  await settle();
  assert.equal(snapshots.at(-1).settings, null);

  lifecycle.activate();
  await settle();
  assert.equal(snapshots.at(-1).settings.openai.keyConfigured, true);
  assert.equal(snapshots.at(-1).busy, false);
  assert.equal(snapshots.at(-1).fresh, true);
  lifecycle.deactivate();
});

test("a failed load is retryable and invents no settings", async () => {
  const loads = [
    Promise.reject(Object.assign(new Error("Caffold is unreachable."), { status: 0 })),
    Promise.resolve(settings()),
  ];
  const { lifecycle, snapshots } = lifecycleWith({ load: () => loads.shift() });

  lifecycle.activate();
  await settle();
  assert.deepEqual(snapshots.at(-1), {
    settings: null,
    fresh: false,
    busy: false,
    retry: true,
    message: "Caffold is unreachable.",
  });
  assert.equal(await lifecycle.storeKey("openai", "sk-test"), false);

  await lifecycle.refresh();
  assert.equal(snapshots.at(-1).fresh, true);
  assert.equal(snapshots.at(-1).retry, false);
  assert.equal(snapshots.at(-1).message, "");
  lifecycle.deactivate();
});

test("polls while the Whisper download runs and stops when the server says it ended", async () => {
  const loads = [
    settings({ whisper: { downloading: true } }),
    settings({ whisper: { downloading: true } }),
    settings({ whisper: { installed: true } }),
  ];
  const { lifecycle, snapshots, scheduled } = lifecycleWith({
    load: async () => loads.shift(),
  });

  lifecycle.activate();
  await settle();
  assert.equal(snapshots.at(-1).settings.whisper.downloading, true);
  assert.equal(snapshots.at(-1).busy, false);
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  await settle();
  assert.equal(snapshots.at(-1).settings.whisper.downloading, true);
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  await settle();
  assert.equal(snapshots.at(-1).settings.whisper.installed, true);
  assert.equal(scheduled.length, 0);
  lifecycle.deactivate();
});

test("a failed poll keeps polling until the server answers again", async () => {
  const loads = [
    Promise.resolve(settings({ whisper: { downloading: true } })),
    Promise.reject(new Error("Voice settings could not be read.")),
    Promise.resolve(settings({ whisper: { downloading: true } })),
  ];
  const { lifecycle, snapshots, scheduled } = lifecycleWith({ load: () => loads.shift() });

  lifecycle.activate();
  await settle();
  scheduled.shift()();
  await settle();
  assert.equal(snapshots.at(-1).fresh, false);
  assert.equal(snapshots.at(-1).retry, false);
  assert.equal(snapshots.at(-1).message, "Voice settings could not be read.");
  assert.equal(scheduled.length, 1);

  scheduled.shift()();
  await settle();
  assert.equal(snapshots.at(-1).fresh, true);
  lifecycle.deactivate();
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  await settle();
  assert.equal(snapshots.at(-1).fresh, true);
});

test("starts and cancels a download while dropping the poll it replaces", async () => {
  const { lifecycle, snapshots, scheduled, cancelled } = lifecycleWith({
    startDownload: async () => settings({ whisper: { downloading: true } }),
    removeModel: async () => settings(),
  });

  lifecycle.activate();
  await settle();
  assert.equal(await lifecycle.startDownload(), true);
  assert.equal(snapshots.at(-1).settings.whisper.downloading, true);
  assert.equal(scheduled.length, 1);

  const staleLoad = scheduled.shift();
  const cancelling = lifecycle.removeModel();
  assert.deepEqual(cancelled, [1]);
  assert.equal(snapshots.at(-1).busy, true);
  assert.equal(await cancelling, true);
  staleLoad();
  await settle();
  assert.equal(snapshots.at(-1).settings.whisper.downloading, false);
  assert.equal(scheduled.length, 0);
  lifecycle.deactivate();
});

test("a server rejection keeps the page current while a transport failure asks to retry", async () => {
  const { lifecycle, snapshots } = lifecycleWith({
    storeKey: async () => {
      throw Object.assign(new Error("Enter an API key."), { status: 400 });
    },
    select: async () => {
      throw new Error("Failed to fetch");
    },
  });

  lifecycle.activate();
  await settle();
  assert.equal(await lifecycle.storeKey("openai", " "), false);
  assert.equal(snapshots.at(-1).fresh, true);
  assert.equal(snapshots.at(-1).message, "Enter an API key.");

  assert.equal(await lifecycle.selectProvider("gemini"), false);
  assert.equal(snapshots.at(-1).fresh, false);
  assert.equal(snapshots.at(-1).retry, true);
  assert.equal(snapshots.at(-1).settings.selected, "whisper");
  lifecycle.deactivate();
});

test("refuses a second change while one is in flight and ignores it after deactivation", async () => {
  const pending = deferred();
  const requested = [];
  const { lifecycle, snapshots } = lifecycleWith({
    storeKey: (provider) => {
      requested.push(["store", provider]);
      return pending.promise;
    },
    removeKey: async (provider) => {
      requested.push(["remove", provider]);
      return settings();
    },
  });

  lifecycle.activate();
  await settle();
  const storing = lifecycle.storeKey("openai", "sk-test");
  assert.equal(await lifecycle.removeKey("gemini"), false);
  lifecycle.deactivate();
  pending.resolve(settings({ openai: { keyConfigured: true } }));

  assert.equal(await storing, false);
  assert.deepEqual(requested, [["store", "openai"]]);
  assert.equal(snapshots.at(-1).settings.openai.keyConfigured, false);
});

test("rejects a transition outside the declared graph", () => {
  const { lifecycle } = lifecycleWith({});
  assert.throws(() => lifecycle.transition("polling"), /inactive -> polling/);
});
