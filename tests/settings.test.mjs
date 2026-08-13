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

test("settings assets stay in the application shell", () => {
  assert.match(readFrontend("app.js"), /import "\.\/settings\.js";/);
  assert.match(
    readFrontend("styles.css"),
    /@import "\.\/pages\/\(task-workspace\)\/settings\/appearance\/page\.css";/,
  );
  assert.match(
    readFrontend("styles.css"),
    /@import "\.\/pages\/\(task-workspace\)\/settings\/files\/page\.css";/,
  );

  const serviceWorker = readFrontend("service-worker.js");
  assert.match(serviceWorker, /"\/assets\/fonts\.js"/);
  assert.match(serviceWorker, /"\/assets\/settings\.js"/);
  assert.match(serviceWorker, /"\/assets\/theme\.js"/);
  assert.match(serviceWorker, /"\/assets\/fonts\/D2Coding-Regular\.woff2"/);
  assert.match(serviceWorker, /"\/assets\/fonts\/D2Coding-Bold\.woff2"/);
  assert.match(
    serviceWorker,
    /"\/assets\/pages\/\(task-workspace\)\/settings\/appearance\/page\.js"/,
  );
  assert.match(
    serviceWorker,
    /"\/assets\/pages\/\(task-workspace\)\/settings\/appearance\/page\.css"/,
  );
  assert.match(
    serviceWorker,
    /"\/assets\/pages\/\(task-workspace\)\/settings\/files\/page\.js"/,
  );
  assert.match(
    serviceWorker,
    /"\/assets\/pages\/\(task-workspace\)\/settings\/files\/page\.css"/,
  );
});

test("normalizes settings, malformed input, ranges, steps, and file order", async () => {
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
      themeMode: "dark",
      typefacePreset: "noto-sans-mono-cjk-kr",
      interfaceScalePercent: 117,
      conversationTextPx: 12.5,
      codeTextPx: 24.4,
      fileSortMode: "name",
    }),
    {
      themeMode: "dark",
      typefacePreset: "d2-coding",
      interfaceScalePercent: 115,
      conversationTextPx: 13,
      codeTextPx: 20,
      fileSortMode: "name",
    },
  );
  assert.deepEqual(
    normalizeSettings({
      themeMode: "sepia",
      typefacePreset: "unknown-font",
      interfaceScalePercent: 118,
      conversationTextPx: 19.6,
      codeTextPx: 11.2,
    }),
    {
      themeMode: "system",
      typefacePreset: "d2-coding",
      interfaceScalePercent: 120,
      conversationTextPx: 20,
      codeTextPx: 12,
      fileSortMode: "folders-first",
    },
  );
});

test("drops obsolete fields instead of maintaining a migration layer", async () => {
  const { DEFAULT_SETTINGS, normalizeSettings } =
    await importFreshSettings("obsolete-fields");

  assert.deepEqual(
    normalizeSettings({
      fileTreeSize: "large",
      taskListSize: "compact",
      taskDetailSize: "large",
      codeSize: "default",
    }),
    DEFAULT_SETTINGS,
  );
});

test("initial load rewrites obsolete state without publishing a change", async () => {
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
      assert.deepEqual(settings.getSettings(), settings.DEFAULT_SETTINGS);
    },
  );

  assert.deepEqual(events, []);
  assert.deepEqual(writes, [
    [
      "caffold:settings",
      {
        themeMode: "system",
        typefacePreset: "d2-coding",
        interfaceScalePercent: 100,
        conversationTextPx: 14,
        codeTextPx: 13,
        fileSortMode: "folders-first",
      },
    ],
  ]);
  assert.equal(properties.get("--interface-scale"), "1");
  assert.equal(properties.get("--conversation-font-size"), "14px");
  assert.equal(properties.get("--code-font-size"), "13px");
  assert.match(properties.get("--font-ui"), /Caffold D2 Coding/);
  assert.match(properties.get("--font-code"), /Caffold D2 Coding/);
});

test("malformed storage resets and persists the defaults silently", async () => {
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
        themeMode: "system",
        typefacePreset: "d2-coding",
        interfaceScalePercent: 100,
        conversationTextPx: 14,
        codeTextPx: 13,
        fileSortMode: "folders-first",
      },
    ],
  ]);
});

test("appearance reset preserves the global file ordering preference", async () => {
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
      settings.setFileSortMode("name");
      settings.setAppearanceRangeSetting("interfaceScalePercent", 113);
      settings.setAppearanceRangeSetting("conversationTextPx", 19.6);
      settings.resetAppearanceRangeSetting("conversationTextPx");
      settings.resetAppearanceSettings();

      assert.deepEqual(settings.getSettings(), {
        ...settings.DEFAULT_SETTINGS,
        fileSortMode: "name",
      });
    },
  );

  assert.equal(events.length, 5);
  assert.deepEqual(events[0].detail.settings, {
    themeMode: "system",
    typefacePreset: "d2-coding",
    interfaceScalePercent: 100,
    conversationTextPx: 14,
    codeTextPx: 13,
    fileSortMode: "name",
  });
  assert.equal(properties.get("--interface-scale"), "1");
  assert.equal(properties.get("--conversation-font-size"), "14px");
  assert.equal(properties.get("--code-font-size"), "13px");
});

test("invalid file ordering values normalize to folders first", async () => {
  const events = [];
  const properties = new Map();

  await withBrowserGlobals(
    {
      getItem: () => JSON.stringify({ fileSortMode: "unknown" }),
      setItem: () => {},
    },
    events,
    properties,
    async () => {
      const settings = await importFreshSettings("invalid-file-order");
      assert.equal(settings.getSettings().fileSortMode, "folders-first");
      settings.setFileSortMode("name");
      assert.equal(settings.getSettings().fileSortMode, "name");
      settings.setFileSortMode(false);
      assert.equal(settings.getSettings().fileSortMode, "folders-first");
    },
  );

  assert.deepEqual(
    events.map((event) => event.detail.settings.fileSortMode),
    ["name", "folders-first"],
  );
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
      settings.setAppearanceRangeSetting("codeTextPx", 18);
      assert.equal(settings.getSettings().codeTextPx, 18);
    },
  );

  assert.equal(events.length, 1);
  assert.equal(properties.get("--code-font-size"), "18px");
});

test("theme updates apply, normalize, persist, and publish settings", async () => {
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
      const settings = await importFreshSettings("theme-updates");
      settings.setThemeMode("dark");
      assert.equal(settings.getSettings().themeMode, "dark");
      assert.equal(document.documentElement.dataset.theme, "dark");
      assert.equal(document.documentElement.style.colorScheme, "dark");

      settings.setThemeMode("unknown");
      assert.equal(settings.getSettings().themeMode, "system");
      assert.equal(document.documentElement.dataset.theme, "light");
    },
  );

  assert.deepEqual(
    events.map((event) => event.type),
    [
      "caffold:theme-change",
      "caffold:settings-change",
      "caffold:theme-change",
      "caffold:settings-change",
    ],
  );
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
