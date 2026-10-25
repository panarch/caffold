import { html, LitElement, nothing } from "lit";

// The keys a phone keyboard lacks. Ctrl waits for the next key, from this row
// or the keyboard, and applies to that one key only.

export const TERMINAL_SPECIAL_KEY_EVENT = "caffold:terminal-special-key";

// A key from the row, and whether Ctrl was waiting for it.
export interface TerminalSpecialKeyDetail {
  key: string;
  control: boolean;
}

const KEYS = Object.freeze([
  { key: "escape", label: "Esc", name: "Escape" },
  { key: "tab", label: "Tab", name: "Tab" },
  { key: "control", label: "Ctrl", name: "Control" },
  { key: "left", label: "←", name: "Left arrow" },
  { key: "up", label: "↑", name: "Up arrow" },
  { key: "down", label: "↓", name: "Down arrow" },
  { key: "right", label: "→", name: "Right arrow" },
]);

export class CaffoldTerminalSpecialKeys extends LitElement {
  private controlPending = false;

  constructor() {
    super();
    // The keys must not take focus from the terminal, or a phone would close
    // its keyboard on every press.
    this.addEventListener("pointerdown", (event) => {
      if (event.target instanceof Element && event.target.closest("button")) {
        event.preventDefault();
      }
    });
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    setAttribute(this, "role", "toolbar");
    setAttribute(this, "aria-label", "Special keys");
  }

  /** Whether Ctrl was waiting for this key; it stops waiting either way. */
  consumeControl() {
    const pending = this.controlPending;
    this.setControlPending(false);
    return pending;
  }

  render() {
    return KEYS.map(
      ({ key, label, name }) => html`<button
        type="button"
        class="terminal-special-key"
        data-terminal-special-key=${key}
        aria-label=${name}
        aria-pressed=${
          key === "control" ? (this.controlPending ? "true" : "false") : nothing
        }
        @click=${this.pressKey}
      >${label}</button>`,
    );
  }

  private pressKey(event: Event) {
    const key = `${(event.currentTarget as HTMLButtonElement).dataset.terminalSpecialKey}`;
    if (key === "control") {
      this.setControlPending(!this.controlPending);
      return;
    }
    this.dispatchEvent(
      new CustomEvent<TerminalSpecialKeyDetail>(TERMINAL_SPECIAL_KEY_EVENT, {
        bubbles: true,
        detail: { key, control: this.consumeControl() },
      }),
    );
  }

  private setControlPending(pending: boolean) {
    this.controlPending = pending;
    this.requestUpdate();
    this.performUpdate();
  }
}

customElements.define(
  "caffold-terminal-special-keys",
  CaffoldTerminalSpecialKeys,
);

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}
