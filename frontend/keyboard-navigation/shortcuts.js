export const KEYBOARD_NAVIGATION_KEY = Object.freeze({
  ACTION_HINTS: "F",
  SCROLL_SELECT: "S",
  SHORTCUT_HELP: "?",
  SCROLL_DOWN: "J",
  SCROLL_UP: "K",
  SCROLL_HALF_DOWN: "D",
  SCROLL_HALF_UP: "U",
  SCROLL_LEFT: "H",
  SCROLL_RIGHT: "L",
  BACKSPACE: "Backspace",
  ESCAPE: "Escape",
});

export const KEYBOARD_SHORTCUT_CLOSE_EVENT =
  "caffold:keyboard-shortcut-close";

export const KEYBOARD_SHORTCUT_HELP_SECTIONS = Object.freeze([
  Object.freeze({
    title: "Navigation",
    rows: Object.freeze([
      shortcut([KEYBOARD_NAVIGATION_KEY.ACTION_HINTS], "Show available actions"),
      shortcut(
        [KEYBOARD_NAVIGATION_KEY.SCROLL_SELECT],
        "Select a scroll area",
      ),
      shortcut(
        [KEYBOARD_NAVIGATION_KEY.SHORTCUT_HELP],
        "Open or close keyboard shortcut help",
      ),
      shortcut(
        [KEYBOARD_NAVIGATION_KEY.ESCAPE],
        "Leave the editor when its surface supports it",
      ),
    ]),
  }),
  Object.freeze({
    title: "Choosing a target",
    rows: Object.freeze([
      shortcut(["shown code"], "Choose the matching action or scroll area"),
      shortcut(
        [KEYBOARD_NAVIGATION_KEY.BACKSPACE],
        "Remove the last typed letter",
      ),
      shortcut([KEYBOARD_NAVIGATION_KEY.ESCAPE], "Exit target selection"),
    ]),
  }),
  Object.freeze({
    title: "Scrolling",
    rows: Object.freeze([
      shortcut(
        [
          KEYBOARD_NAVIGATION_KEY.SCROLL_DOWN,
          KEYBOARD_NAVIGATION_KEY.SCROLL_UP,
        ],
        "Scroll down or up",
      ),
      shortcut(
        [
          KEYBOARD_NAVIGATION_KEY.SCROLL_HALF_DOWN,
          KEYBOARD_NAVIGATION_KEY.SCROLL_HALF_UP,
        ],
        "Scroll down or up by half a page",
      ),
      shortcut(
        [
          KEYBOARD_NAVIGATION_KEY.SCROLL_LEFT,
          KEYBOARD_NAVIGATION_KEY.SCROLL_RIGHT,
        ],
        "Scroll left or right",
      ),
      shortcut(
        [KEYBOARD_NAVIGATION_KEY.ACTION_HINTS],
        "Switch to available actions",
      ),
      shortcut([KEYBOARD_NAVIGATION_KEY.ESCAPE], "Exit Scroll mode"),
    ]),
  }),
]);

export function matchesKeyboardNavigationKey(
  event,
  key,
  { compositionActive = false } = {},
) {
  return Boolean(
    event?.key === key &&
      !compositionActive &&
      !event.isComposing &&
      !event.repeat &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.metaKey
  );
}

function shortcut(keys, description) {
  return Object.freeze({ keys: Object.freeze(keys), description });
}
