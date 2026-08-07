import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL("../frontend/", import.meta.url));
const settingsModuleUrl = new URL("../frontend/settings.js", import.meta.url);

function readFrontend(path) {
  return readFileSync(new URL(path, `file://${frontendRoot}/`), "utf8");
}

async function importFreshSettings(label) {
  const url = new URL(settingsModuleUrl);
  url.searchParams.set("test", `${label}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

test("appearance settings assets stay in the application shell", () => {
  assert.match(readFrontend("app.js"), /import "\.\/settings\.js";/);
  assert.match(
    readFrontend("styles.css"),
    /@import "\.\/pages\/settings\/page\.css";/,
  );

  const serviceWorker = readFrontend("service-worker.js");
  assert.match(serviceWorker, /"\/assets\/fonts\.js"/);
  assert.match(serviceWorker, /"\/assets\/settings\.js"/);
  assert.match(serviceWorker, /"\/assets\/fonts\/D2Coding-Regular\.woff2"/);
  assert.match(serviceWorker, /"\/assets\/fonts\/D2Coding-Bold\.woff2"/);
  assert.match(serviceWorker, /"\/assets\/pages\/settings\/page\.js"/);
  assert.match(serviceWorker, /"\/assets\/pages\/settings\/page\.css"/);
});

test("normalizes v3 values, malformed input, ranges, and steps", async () => {
  const { DEFAULT_SETTINGS, normalizeSettings } =
    await importFreshSettings("normalization");

  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(
    normalizeSettings({
      interfaceScalePercent: "105",
      conversationTextPx: Number.NaN,
      codeTextPx: Number.POSITIVE_INFINITY,
    }),
    DEFAULT_SETTINGS,
  );
  assert.deepEqual(
    normalizeSettings({
      typefacePreset: "noto-sans-mono-cjk-kr",
      interfaceScalePercent: 117,
      conversationTextPx: 12.5,
      codeTextPx: 24.4,
    }),
    {
      appearanceVersion: 3,
      typefacePreset: "d2-coding",
      interfaceScalePercent: 115,
      conversationTextPx: 13,
      codeTextPx: 20,
    },
  );
  assert.deepEqual(
    normalizeSettings({
      typefacePreset: "unknown-font",
      interfaceScalePercent: 118,
      conversationTextPx: 19.6,
      codeTextPx: 11.2,
    }),
    {
      appearanceVersion: 3,
      typefacePreset: "d2-coding",
      interfaceScalePercent: 120,
      conversationTextPx: 20,
      codeTextPx: 12,
    },
  );
});

test("preserves legacy text choices but resets conflicting density choices", async () => {
  const { normalizeSettings } = await importFreshSettings("legacy");

  assert.deepEqual(
    normalizeSettings({
      fileTreeSize: "large",
      taskListSize: "compact",
      taskDetailSize: "large",
      codeSize: "default",
    }),
    {
      appearanceVersion: 3,
      typefacePreset: "d2-coding",
      interfaceScalePercent: 100,
      conversationTextPx: 17,
      codeTextPx: 15,
    },
  );
  assert.deepEqual(
    normalizeSettings({
      taskDetailSize: "large",
      codeSize: "large",
      conversationTextPx: null,
      codeTextPx: "17",
    }),
    {
      appearanceVersion: 3,
      typefacePreset: "d2-coding",
      interfaceScalePercent: 100,
      conversationTextPx: 15,
      codeTextPx: 13,
    },
    "present fields take precedence over legacy values even when malformed",
  );
});

test("initial load writes normalized v3 state without publishing a change", async () => {
  const stored = JSON.stringify({
    fileTreeSize: "compact",
    taskListSize: "large",
    taskDetailSize: "large",
    codeSize: "compact",
  });
  const writes = [];
  const events = [];
  const properties = new Map();

  await withBrowserGlobals(
    {
      getItem: () => stored,
      setItem: (key, value) => writes.push([key, JSON.parse(value)]),
    },
    events,
    properties,
    async () => {
      const settings = await importFreshSettings("initial-load");
      assert.deepEqual(settings.getSettings(), {
        appearanceVersion: 3,
        typefacePreset: "d2-coding",
        interfaceScalePercent: 100,
        conversationTextPx: 17,
        codeTextPx: 13,
      });
    },
  );

  assert.deepEqual(events, []);
  assert.deepEqual(writes, [
    [
      "caffold:settings",
      {
        appearanceVersion: 3,
        typefacePreset: "d2-coding",
        interfaceScalePercent: 100,
        conversationTextPx: 17,
        codeTextPx: 13,
      },
    ],
  ]);
  assert.equal(properties.get("--interface-scale"), "1");
  assert.equal(properties.get("--conversation-font-size"), "17px");
  assert.equal(properties.get("--code-font-size"), "13px");
  assert.match(properties.get("--font-ui"), /Caffold D2 Coding/);
  assert.match(properties.get("--font-code"), /Caffold D2 Coding/);
});

test("malformed storage resets and persists the v3 defaults silently", async () => {
  const writes = [];
  const events = [];
  const properties = new Map();

  await withBrowserGlobals(
    {
      getItem: () => "{not-json",
      setItem: (key, value) => writes.push([key, JSON.parse(value)]),
    },
    events,
    properties,
    async () => {
      const settings = await importFreshSettings("malformed-storage");
      assert.deepEqual(settings.getSettings(), settings.DEFAULT_SETTINGS);
    },
  );

  assert.deepEqual(events, []);
  assert.deepEqual(writes, [
    [
      "caffold:settings",
      {
        appearanceVersion: 3,
        typefacePreset: "d2-coding",
        interfaceScalePercent: 100,
        conversationTextPx: 15,
        codeTextPx: 13,
      },
    ],
  ]);
});

test("user updates and resets publish one normalized snapshot each", async () => {
  const events = [];
  const properties = new Map();

  await withBrowserGlobals(
    {
      getItem: () => null,
      setItem: () => {},
    },
    events,
    properties,
    async () => {
      const settings = await importFreshSettings("updates");
      settings.setAppearanceSetting("interfaceScalePercent", 113);
      settings.setAppearanceSetting("conversationTextPx", 19.6);
      settings.resetAppearanceSetting("conversationTextPx");
      settings.resetAppearanceSettings();

      assert.deepEqual(settings.getSettings(), settings.DEFAULT_SETTINGS);
    },
  );

  assert.equal(events.length, 4);
  assert.deepEqual(events[0].detail.settings, {
    appearanceVersion: 3,
    typefacePreset: "d2-coding",
    interfaceScalePercent: 115,
    conversationTextPx: 15,
    codeTextPx: 13,
  });
  assert.equal(properties.get("--interface-scale"), "1");
  assert.equal(properties.get("--conversation-font-size"), "15px");
  assert.equal(properties.get("--code-font-size"), "13px");
});

test("storage failure does not roll back the live session value", async () => {
  const events = [];
  const properties = new Map();

  await withBrowserGlobals(
    {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage unavailable");
      },
    },
    events,
    properties,
    async () => {
      const settings = await importFreshSettings("storage-failure");
      settings.setAppearanceSetting("codeTextPx", 18);
      assert.equal(settings.getSettings().codeTextPx, 18);
    },
  );

  assert.equal(events.length, 1);
  assert.equal(properties.get("--code-font-size"), "18px");
});

async function withBrowserGlobals(localStorage, events, properties, run) {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    CustomEvent: globalThis.CustomEvent,
  };

  class TestCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  globalThis.window = {
    localStorage,
    dispatchEvent: (event) => {
      events.push(event);
      return true;
    },
  };
  globalThis.document = {
    documentElement: {
      dataset: {},
      style: {
        setProperty: (name, value) => properties.set(name, value),
      },
    },
  };
  globalThis.CustomEvent = TestCustomEvent;

  try {
    await run();
  } finally {
    restoreGlobal("window", previous.window);
    restoreGlobal("document", previous.document);
    restoreGlobal("CustomEvent", previous.CustomEvent);
  }
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
    return;
  }
  globalThis[name] = value;
}
