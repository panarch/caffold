import assert from "node:assert/strict";
import test from "node:test";

import { SCROLL_COMMAND } from "./model.js";
import {
  KEYBOARD_NAVIGATION_KEY,
  KEYBOARD_SHORTCUT_HELP_SECTIONS,
  KEY_COMBINATION_ACTION,
  keyCombinationAction,
  matchesKeyboardNavigationKey,
} from "./shortcuts.js";

test("keeps the displayed Scroll keys aligned with executable commands", () => {
  assert.deepEqual(Object.keys(SCROLL_COMMAND), ["J", "K", "D", "U", "H", "L"]);
  const displayed = KEYBOARD_SHORTCUT_HELP_SECTIONS.find(
    ({ title }) => title === "Scrolling",
  ).rows.flatMap(({ keys }) => keys);
  assert.deepEqual(
    Object.keys(SCROLL_COMMAND).filter((key) => !displayed.includes(key)),
    [],
  );
});

test("accepts the exact help character outside repeat and composition", () => {
  const event = {
    key: KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP,
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: true,
  };
  assert.equal(
    matchesKeyboardNavigationKey(
      event,
      KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP,
    ),
    true,
  );
  for (const blocked of [
    { repeat: true },
    { isComposing: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ]) {
    assert.equal(
      matchesKeyboardNavigationKey(
        { ...event, ...blocked },
        KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP,
      ),
      false,
    );
  }
  assert.equal(
    matchesKeyboardNavigationKey(
      event,
      KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP,
      { compositionActive: true },
    ),
    false,
  );
});

test("each key combination is read from its physical key and listed in help", () => {
  const press = (code, modifiers) => ({
    key: "",
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    ...modifiers,
  });
  // The Korean characters are what a Korean input source types on each key.
  for (const [event, action] of [
    [press("Backquote", { key: "₩", ctrlKey: true }), KEY_COMBINATION_ACTION.TERMINAL],
    [press("KeyJ", { key: "ㅓ", metaKey: true }), KEY_COMBINATION_ACTION.TERMINAL],
    [press("KeyB", { key: "ㅠ", metaKey: true }), KEY_COMBINATION_ACTION.SIDE_PANE],
    [press("KeyB", { key: "B", ctrlKey: true, shiftKey: true }), KEY_COMBINATION_ACTION.SIDE_PANE],
  ]) {
    assert.equal(keyCombinationAction(event), action, event.code);
    assert.equal(keyCombinationAction(event, { compositionActive: true }), "");
    for (const variant of [
      { repeat: true },
      { isComposing: true },
      { altKey: true },
      { ctrlKey: !event.ctrlKey },
      { metaKey: !event.metaKey },
      { shiftKey: !event.shiftKey },
    ]) {
      assert.equal(
        keyCombinationAction({ ...event, ...variant }),
        "",
        `${event.code} ${JSON.stringify(variant)}`,
      );
    }
  }
  // A shell's own Ctrl+B stays with the shell.
  assert.equal(keyCombinationAction(press("KeyB", { ctrlKey: true })), "");

  const combinations = KEYBOARD_SHORTCUT_HELP_SECTIONS.at(-1);
  assert.equal(combinations.title, "Key combinations");
  assert.deepEqual(
    combinations.rows.map(({ keys, alternatives }) => ({ keys, alternatives })),
    [
      { keys: ["⌘J", "Ctrl+`"], alternatives: true },
      { keys: ["⌘B", "Ctrl+Shift+B"], alternatives: true },
    ],
  );
  assert.ok(
    KEYBOARD_SHORTCUT_HELP_SECTIONS.slice(0, -1).every(({ rows }) =>
      rows.every(({ alternatives }) => !alternatives)
    ),
  );
});
