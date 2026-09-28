// What the special key row sends. Arrows follow the cursor-key mode the
// program chose, and a pending Ctrl turns the next key into its control form.

const ARROW_LETTERS = Object.freeze({
  up: "A",
  down: "B",
  right: "C",
  left: "D",
});

export function specialKeySequence(key, { applicationCursor = false, control = false } = {}) {
  if (key === "escape") {
    return "\x1b";
  }
  if (key === "tab") {
    return "\t";
  }
  const letter = ARROW_LETTERS[key];
  if (!letter) {
    return "";
  }
  if (control) {
    return `\x1b[1;5${letter}`;
  }
  return applicationCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
}

/** The control character for one typed character, as Ctrl with that key sends. */
export function controlCharacter(text) {
  if ([...text].length !== 1) {
    return text;
  }
  if (text === " ") {
    return "\x00";
  }
  if (text === "?") {
    return "\x7f";
  }
  const code = text.toUpperCase().charCodeAt(0);
  return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : text;
}
