import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { TerminalConnection } from "./connection.js";

const originalGlobals = {
  window: globalThis.window,
  WebSocket: globalThis.WebSocket,
};

afterEach(() => {
  for (const [name, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      delete globalThis[name];
    } else {
      globalThis[name] = value;
    }
  }
});

test("every connection from a tab names the same tab, and another tab its own", () => {
  const first = tabWith(sessionStorage());
  const tabs = [connect(first), connect(first)];
  const other = connect(tabWith(sessionStorage()));

  assert.match(tabs[0], /^[0-9a-f]{32}$/);
  assert.equal(tabs[1], tabs[0]);
  assert.equal(first.window.sessionStorage.getItem("caffold:terminal-tab"), tabs[0]);
  assert.notEqual(other, tabs[0]);
});

test("without session storage a page keeps one tab for its connections", () => {
  const unavailable = tabWith({
    getItem() {
      throw new DOMException("denied", "SecurityError");
    },
  });

  const tabs = [connect(unavailable), connect(unavailable)];

  assert.match(tabs[0], /^[0-9a-f]{32}$/);
  assert.equal(tabs[1], tabs[0]);
});

function sessionStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, `${value}`),
  };
}

function tabWith(storage) {
  return {
    window: { location: { origin: "http://127.0.0.1" }, sessionStorage: storage },
    urls: [],
  };
}

/** Opens a connection from `tab` and returns the tab its socket names. */
function connect(tab) {
  globalThis.window = tab.window;
  globalThis.WebSocket = class {
    static OPEN = 1;

    constructor(url) {
      tab.urls.push(url);
    }

    addEventListener() {}
  };
  new TerminalConnection({
    subject: { kind: "task", id: "thread-1" },
    mode: "resume",
    size: { cols: 80, rows: 24 },
    onMessage() {},
    onOutput() {},
    onFailure() {},
  });
  return new URL(tab.urls.at(-1)).searchParams.get("tab");
}
