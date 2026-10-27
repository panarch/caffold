import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";

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

@customElement("caffold-terminal-special-keys")
export class CaffoldTerminalSpecialKeys extends LitElement {
  @state()
  private accessor controlPending = false;

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

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    setAttribute(this, "role", "toolbar");
    setAttribute(this, "aria-label", "Special keys");
  }

  /** Whether Ctrl was waiting for this key; it stops waiting either way. */
  consumeControl() {
    const pending = this.controlPending;
    this.controlPending = false;
    return pending;
  }

  override render() {
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
      this.controlPending = !this.controlPending;
      return;
    }
    this.dispatchEvent(
      new CustomEvent<TerminalSpecialKeyDetail>(TERMINAL_SPECIAL_KEY_EVENT, {
        bubbles: true,
        detail: { key, control: this.consumeControl() },
      }),
    );
  }
}

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-terminal-special-keys": CaffoldTerminalSpecialKeys;
  }
}
