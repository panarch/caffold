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

test("joins a key combination's keys with or, under its description and above its note", () => {
  const owner = {};
  shortcutList.connectedCallback.call(owner);
  const combinations = KEYBOARD_SHORTCUT_HELP_SECTIONS.at(-1);

  const section = owner.innerHTML.slice(
    owner.innerHTML.indexOf(`<h3>${combinations.title}</h3>`),
  );
  assert.match(section, new RegExp(`</h3>\\s*<p>${escapePattern(combinations.description)}</p>`));
  assert.match(section, /<kbd>⌘J<\/kbd><span class="keyboard-shortcut-or">or<\/span><kbd>Ctrl\+`<\/kbd>/);
  assert.match(section, new RegExp(`</dl>\\s*<p>${escapePattern(combinations.note)}</p>`));
  // The pairs of the other sections, such as J and K, keep their slash.
  assert.match(owner.innerHTML, /<kbd>J<\/kbd><span aria-hidden="true">\/<\/span><kbd>K<\/kbd>/);
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
