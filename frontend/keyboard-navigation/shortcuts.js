export const KEYBOARD_NAVIGATION_KEY = Object.freeze({
  ACTION_HINTS: "F",
  SCROLL_SELECT: "S",
  TASK_SWITCHER: "T",
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

export const KEY_COMBINATION_ACTION = Object.freeze({
  TERMINAL: "terminal",
  SIDE_PANE: "side-pane",
});

// Key combinations work while typing, in the terminal, and with keyboard
// navigation off, so each holds Ctrl or ⌘: typing leaves those alone, and a
// shell never gets ⌘ or tells Ctrl+Shift+B from Ctrl+B. Each is read from the
// physical key, so a Korean input source, which types ₩ on Backquote, matches.
// Every action has one combination for Apple keyboards, listed first, and one
// without ⌘.
export const KEY_COMBINATIONS = Object.freeze([
  combination(
    KEY_COMBINATION_ACTION.TERMINAL,
    "Open the terminal, or return from it",
    [
      chord("⌘J", { code: "KeyJ", meta: true }),
      chord("Ctrl+`", { code: "Backquote", ctrl: true }),
    ],
  ),
  combination(
    KEY_COMBINATION_ACTION.SIDE_PANE,
    "Show or hide the side panel",
    [
      chord("⌘B", { code: "KeyB", meta: true }),
      chord("Ctrl+Shift+B", { code: "KeyB", ctrl: true, shift: true }),
    ],
  ),
]);

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
        [KEYBOARD_NAVIGATION_KEY.TASK_SWITCHER],
        "Switch to a recently active task",
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
        [KEYBOARD_NAVIGATION_KEY.SCROLL_SELECT],
        "Switch to scrolling the surface you are in",
      ),
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
      shortcut(
        [KEYBOARD_NAVIGATION_KEY.SCROLL_SELECT],
        "Select another scroll area",
      ),
      shortcut([KEYBOARD_NAVIGATION_KEY.ESCAPE], "Exit Scroll mode"),
    ]),
  }),
  Object.freeze({
    title: "Key combinations",
    description: "Work while typing, in the terminal, and with keyboard navigation off.",
    rows: Object.freeze(KEY_COMBINATIONS.map(({ chords, description }) =>
      shortcut(chords.map(({ label }) => label), description, { alternatives: true })
    )),
    note: "In the terminal, Esc goes to the program running there.",
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

/** The action of the key combination `event` presses, or "" for none. */
export function keyCombinationAction(event, { compositionActive = false } = {}) {
  if (!event || event.repeat || event.isComposing || compositionActive || event.altKey) {
    return "";
  }
  const pressed = KEY_COMBINATIONS.find(({ chords }) => chords.some((chord) =>
    event.code === chord.code &&
    Boolean(event.ctrlKey) === chord.ctrl &&
    Boolean(event.metaKey) === chord.meta &&
    Boolean(event.shiftKey) === chord.shift
  ));
  return pressed?.action ?? "";
}

// `alternatives` marks keys that each do the whole action, rather than a pair
// such as J and K that splits it.
function shortcut(keys, description, { alternatives = false } = {}) {
  return Object.freeze({ keys: Object.freeze(keys), description, alternatives });
}

function combination(action, description, chords) {
  return Object.freeze({ action, description, chords: Object.freeze(chords) });
}

function chord(label, { code, ctrl = false, meta = false, shift = false }) {
  return Object.freeze({ label, code, ctrl, meta, shift });
}
