import assert from "node:assert/strict";
import test, { after } from "node:test";

import {
  installCustomElementUnitRegistry,
} from "../../tests/support/custom-element-unit.js";
import { KEYBOARD_SHORTCUT_HELP_SECTIONS } from "../shortcuts.js";

const registry = installCustomElementUnitRegistry();
await import("./shortcut-list.js");
const shortcutList = registry.element(
  "caffold-keyboard-shortcut-list",
).prototype;
after(() => registry.restore());

test("renders every shortcut section from the shared keymap", () => {
  const owner = {};
  shortcutList.connectedCallback.call(owner);

  for (const { title, rows } of KEYBOARD_SHORTCUT_HELP_SECTIONS) {
    assert.match(owner.innerHTML, new RegExp(`>${escapePattern(title)}<`));
    for (const { keys, description } of rows) {
      assert.match(
        owner.innerHTML,
        new RegExp(`>${escapePattern(description)}<`),
      );
      for (const key of keys) {
        assert.match(
          owner.innerHTML,
          new RegExp(`<kbd>${escapePattern(key)}</kbd>`),
        );
      }
    }
  }
});

test("retains its rendered shortcut rows when reconnected", () => {
  const owner = {};
  shortcutList.connectedCallback.call(owner);
  owner.innerHTML = "retained";
  shortcutList.connectedCallback.call(owner);
  assert.equal(owner.innerHTML, "retained");
});

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
