import assert from "node:assert/strict";
import test from "node:test";

import {
  announceLanguageServersChange,
  languageServerMemory,
} from "./language-servers.js";

test("shows gigabytes with one decimal and smaller sizes in whole megabytes", () => {
  assert.equal(languageServerMemory(3_006_477_107), "2.8 GB");
  assert.equal(languageServerMemory(1024 ** 3), "1.0 GB");
  assert.equal(languageServerMemory(671_088_640), "640 MB");
  assert.equal(languageServerMemory(0), "0 MB");
});

test("shows nothing for memory the server did not report", () => {
  assert.equal(languageServerMemory(undefined), "");
  assert.equal(languageServerMemory(null), "");
  assert.equal(languageServerMemory(Number.NaN), "");
});

test("announces a change on the window without a detail", () => {
  const events = [];
  const previous = globalThis.window;
  globalThis.window = { dispatchEvent: (event) => events.push(event) };
  try {
    announceLanguageServersChange();
  } finally {
    globalThis.window = previous;
  }
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "caffold:language-servers-changed");
  assert.equal(events[0].detail, null);
});
