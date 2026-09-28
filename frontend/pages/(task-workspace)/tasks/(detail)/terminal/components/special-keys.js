// The keys a phone keyboard lacks. Ctrl waits for the next key, from this row
// or the keyboard, and applies to that one key only.

export const TERMINAL_SPECIAL_KEY_EVENT = "caffold:terminal-special-key";

const KEYS = Object.freeze([
  { key: "escape", label: "Esc", name: "Escape" },
  { key: "tab", label: "Tab", name: "Tab" },
  { key: "control", label: "Ctrl", name: "Control" },
  { key: "left", label: "←", name: "Left arrow" },
  { key: "up", label: "↑", name: "Up arrow" },
  { key: "down", label: "↓", name: "Down arrow" },
  { key: "right", label: "→", name: "Right arrow" },
]);

class CaffoldTerminalSpecialKeys extends HTMLElement {
  connectedCallback() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.controlPending = false;
    this.setAttribute("role", "toolbar");
    this.setAttribute("aria-label", "Special keys");
    this.innerHTML = KEYS.map(({ key, label, name }) => `
      <button
        type="button"
        class="terminal-special-key"
        data-terminal-special-key="${key}"
        aria-label="${name}"
        ${key === "control" ? 'aria-pressed="false"' : ""}
      >${label}</button>
    `).join("");
    // The keys must not take focus from the terminal, or a phone would close
    // its keyboard on every press.
    this.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) {
        event.preventDefault();
      }
    });
    this.addEventListener("click", (event) => this.handleClick(event));
  }

  /** Whether Ctrl was waiting for this key; it stops waiting either way. */
  consumeControl() {
    const pending = Boolean(this.controlPending);
    this.setControlPending(false);
    return pending;
  }

  handleClick(event) {
    const button = event.target instanceof Element
      ? event.target.closest("[data-terminal-special-key]")
      : null;
    if (!button || !this.contains(button)) {
      return;
    }
    const key = button.dataset.terminalSpecialKey;
    if (key === "control") {
      this.setControlPending(!this.controlPending);
      return;
    }
    this.dispatchEvent(new CustomEvent(TERMINAL_SPECIAL_KEY_EVENT, {
      bubbles: true,
      detail: { key, control: this.consumeControl() },
    }));
  }

  setControlPending(pending) {
    this.controlPending = pending;
    this.querySelector('[data-terminal-special-key="control"]')
      ?.setAttribute("aria-pressed", pending ? "true" : "false");
  }
}

if (!customElements.get("caffold-terminal-special-keys")) {
  customElements.define(
    "caffold-terminal-special-keys",
    CaffoldTerminalSpecialKeys,
  );
}
