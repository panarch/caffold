import assert from "node:assert/strict";
import test from "node:test";

const themeModuleUrl = new URL("./theme.js", import.meta.url);

test("theme modes resolve System, Light, and Dark explicitly", async () => {
  const { DEFAULT_THEME_MODE, normalizeThemeMode, resolveTheme } =
    await importFreshTheme("resolution");

  assert.equal(DEFAULT_THEME_MODE, "system");
  assert.equal(normalizeThemeMode("light"), "light");
  assert.equal(normalizeThemeMode("dark"), "dark");
  assert.equal(normalizeThemeMode("unknown"), "system");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("active theme owns document state, browser chrome, and System changes", async () => {
  const listeners = [];
  const events = [];
  const media = {
    matches: true,
    addEventListener: (type, listener) => listeners.push([type, listener]),
  };
  const themeColor = { content: "" };
  const root = { dataset: {}, style: {} };
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    matchMedia: globalThis.matchMedia,
    CustomEvent: globalThis.CustomEvent,
  };

  class TestCustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  globalThis.matchMedia = (query) => {
    assert.equal(query, "(prefers-color-scheme: dark)");
    return media;
  };
  globalThis.document = {
    documentElement: root,
    querySelector: (selector) => {
      assert.equal(selector, 'meta[name="theme-color"]');
      return themeColor;
    },
  };
  globalThis.window = {
    dispatchEvent: (event) => events.push(event),
  };
  globalThis.CustomEvent = TestCustomEvent;

  try {
    const theme = await importFreshTheme("lifecycle");
    assert.deepEqual(theme.applyThemeMode("system"), {
      themeMode: "system",
      resolvedTheme: "dark",
    });
    assert.equal(root.dataset.theme, "dark");
    assert.equal(root.style.colorScheme, "dark");
    assert.equal(themeColor.content, "#1b1b1b");
    assert.deepEqual(events, [], "initial application stays silent");
    assert.equal(listeners.length, 1);

    theme.applyThemeMode("light");
    assert.equal(root.dataset.theme, "light");
    assert.equal(themeColor.content, "#ffffff");
    assert.equal(events.at(-1).type, "caffold:theme-change");
    assert.deepEqual(events.at(-1).detail, {
      themeMode: "light",
      resolvedTheme: "light",
    });

    media.matches = false;
    listeners[0][1]({ matches: false });
    assert.equal(events.length, 1, "explicit Light ignores system changes");

    theme.applyThemeMode("system");
    media.matches = true;
    listeners[0][1]({ matches: true });
    assert.equal(root.dataset.theme, "dark");
    assert.equal(events.at(-1).detail.themeMode, "system");
    assert.equal(events.at(-1).detail.resolvedTheme, "dark");
  } finally {
    restoreGlobal("window", previous.window);
    restoreGlobal("document", previous.document);
    restoreGlobal("matchMedia", previous.matchMedia);
    restoreGlobal("CustomEvent", previous.CustomEvent);
  }
});

async function importFreshTheme(label) {
  const url = new URL(themeModuleUrl);
  url.searchParams.set("test", `${label}-${Date.now()}-${Math.random()}`);
  return import(url.href);
}

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
    return;
  }
  globalThis[name] = value;
}
