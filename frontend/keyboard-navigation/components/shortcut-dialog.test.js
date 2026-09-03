import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";

const registry = installCustomElementUnitRegistry();
const previousButton = globalThis.HTMLButtonElement;
globalThis.HTMLButtonElement = class TestButton extends globalThis.HTMLElement {};
await import("./shortcut-dialog.js");
const dialog = registry.element("caffold-keyboard-shortcut-dialog").prototype;
after(() => {
  restoreGlobal("HTMLButtonElement", previousButton);
  registry.restore();
});

test("renders the shared shortcut map in one native dialog", () => {
  const nativeDialog = {};
  const owner = {
    querySelector: () => nativeDialog,
  };
  dialog.ensureRendered.call(owner);

  assert.equal(owner.dialog, nativeDialog);
  assert.match(owner.innerHTML, /<dialog/);
  assert.match(owner.innerHTML, /Keyboard shortcuts/);
  assert.match(owner.innerHTML, /class="keyboard-shortcut-close"/);
  assert.match(owner.innerHTML, /aria-label="Close keyboard shortcuts"/);
  assert.doesNotMatch(owner.innerHTML, />Close<\/button>/);
  assert.match(
    owner.innerHTML,
    /<caffold-keyboard-shortcut-list><\/caffold-keyboard-shortcut-list>/,
  );
});

test("opens, focuses, and closes only its retained native dialog", () => {
  const calls = [];
  const close = {
    focus: (options) => calls.push(["focus", options]),
  };
  const nativeDialog = {
    open: false,
    showModal() {
      this.open = true;
      calls.push("show-modal");
    },
    close() {
      this.open = false;
      calls.push("close");
    },
    querySelector: () => close,
  };
  const owner = { dialog: nativeDialog, ensureRendered() {} };

  assert.equal(dialog.open.call(owner), true);
  assert.deepEqual(calls, [
    "show-modal",
    ["focus", { preventScroll: true }],
  ]);
  assert.equal(dialog.open.call(owner), false);
  assert.equal(dialog.close.call(owner), true);
  assert.equal(dialog.close.call(owner), false);
  assert.equal(calls.at(-1), "close");
});

function restoreGlobal(name, value) {
  if (value === undefined) {
    delete globalThis[name];
  } else {
    globalThis[name] = value;
  }
}
