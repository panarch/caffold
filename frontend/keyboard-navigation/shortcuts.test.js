import assert from "node:assert/strict";
import test from "node:test";

import { SCROLL_COMMAND } from "./model.js";
import {
  KEYBOARD_NAVIGATION_KEY,
  KEYBOARD_SHORTCUT_HELP_SECTIONS,
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
