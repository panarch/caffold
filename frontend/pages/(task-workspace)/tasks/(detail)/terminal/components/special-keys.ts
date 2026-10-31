import { html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { CaffoldElement } from "#app/caffold-element.js";
import { inlineIcon, warmIcons } from "#components/icons.js";

import styles from "./special-keys.css.js";

// The keys a phone keyboard lacks, then Copy and Paste. Ctrl waits for the
// next key, from this row or the keyboard, and applies to that one key only;
// Paste turns a waiting Ctrl off, so pasted text goes as it is.

export const TERMINAL_SPECIAL_KEY_EVENT = "caffold:terminal-special-key";
export const TERMINAL_CLIPBOARD_EVENT = "caffold:terminal-clipboard";

// A key from the row, and whether Ctrl was waiting for it.
export interface TerminalSpecialKeyDetail {
  key: string;
  control: boolean;
}

// Copy or Paste from the row. The terminal screen does the clipboard work and
// reports back how it went.
export interface TerminalClipboardDetail {
  action: "copy" | "paste";
}

// As long as the other copy buttons show how a copy went.
const CLIPBOARD_FEEDBACK_DURATION_MS = 1_800;

const KEYS = Object.freeze([
  { key: "escape", label: "Esc", name: "Escape" },
  { key: "tab", label: "Tab", name: "Tab" },
  { key: "control", label: "Ctrl", name: "Control" },
  { key: "left", label: "←", name: "Left arrow" },
  { key: "up", label: "↑", name: "Up arrow" },
  { key: "down", label: "↓", name: "Down arrow" },
  { key: "right", label: "→", name: "Right arrow" },
]);

type CopyResult = "idle" | "copied" | "failed";

const COPY_LOOKS = Object.freeze({
  idle: { name: "Copy", icon: "Copy", status: "" },
  copied: { name: "Copied", icon: "Check", status: "Copied" },
  failed: { name: "Copy failed", icon: "TriangleAlert", status: "Copy failed" },
});

@customElement("caffold-terminal-special-keys")
export class CaffoldTerminalSpecialKeys extends CaffoldElement {
  /** Whether the terminal has text selected for Copy to take. */
  @property({ attribute: false })
  accessor copyAvailable = false;
  @state()
  private accessor controlPending = false;
  @state()
  private accessor copyResult: CopyResult = "idle";
  @state()
  private accessor pasteFailed = false;

  static override styles = styles;

  private copyTimer: number | undefined;
  private pasteTimer: number | undefined;
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    // The keys must not take focus from the terminal, or a phone would close
    // its keyboard on every press.
    this.addEventListener("pointerdown", (event) => {
      const pressed = event.composedPath()[0];
      if (pressed instanceof Element && pressed.closest("button")) {
        event.preventDefault();
      }
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    setAttribute(this, "role", "toolbar");
    setAttribute(this, "aria-label", "Special keys");
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
    window.clearTimeout(this.copyTimer);
    window.clearTimeout(this.pasteTimer);
    this.copyResult = "idle";
    this.pasteFailed = false;
  }

  /** Whether Ctrl was waiting for this key; it stops waiting either way. */
  consumeControl() {
    const pending = this.controlPending;
    this.controlPending = false;
    return pending;
  }

  /** Shows a check when Copy put the text on the clipboard, a warning when not. */
  showCopyResult(copied: boolean) {
    window.clearTimeout(this.copyTimer);
    this.copyResult = copied ? "copied" : "failed";
    this.copyTimer = window.setTimeout(() => {
      this.copyResult = "idle";
    }, CLIPBOARD_FEEDBACK_DURATION_MS);
  }

  /** Shows a warning when Paste could not read the clipboard. */
  showPasteFailure() {
    window.clearTimeout(this.pasteTimer);
    this.pasteFailed = true;
    this.pasteTimer = window.setTimeout(() => {
      this.pasteFailed = false;
    }, CLIPBOARD_FEEDBACK_DURATION_MS);
  }

  override render() {
    const copy = COPY_LOOKS[this.copyResult];
    const paste = this.pasteFailed ? "Paste failed" : "Paste";
    return html`${KEYS.map(
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
    )}<button
        type="button"
        class="terminal-special-key"
        data-terminal-clipboard="copy"
        data-clipboard-result=${
          this.copyResult === "idle" ? nothing : this.copyResult
        }
        aria-label=${copy.name}
        title=${copy.name}
        ?disabled=${!this.copyAvailable && this.copyResult === "idle"}
        @click=${this.copy}
      >${inlineIcon(copy.icon, "", "terminal-special-key-icon")}</button><button
        type="button"
        class="terminal-special-key"
        data-terminal-clipboard="paste"
        data-clipboard-result=${this.pasteFailed ? "failed" : nothing}
        aria-label=${paste}
        title=${paste}
        @click=${this.paste}
      >${inlineIcon(
        this.pasteFailed ? "TriangleAlert" : "ClipboardPaste",
        "",
        "terminal-special-key-icon",
      )}</button><span class="sr-only" role="status" aria-live="polite">${
        this.pasteFailed ? "Paste failed" : copy.status
      }</span>`;
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

  private copy() {
    this.dispatchClipboard("copy");
  }

  private paste() {
    this.controlPending = false;
    this.dispatchClipboard("paste");
  }

  private dispatchClipboard(action: TerminalClipboardDetail["action"]) {
    this.dispatchEvent(
      new CustomEvent<TerminalClipboardDetail>(TERMINAL_CLIPBOARD_EVENT, {
        bubbles: true,
        detail: { action },
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

  interface HTMLElementEventMap {
    [TERMINAL_SPECIAL_KEY_EVENT]: CustomEvent<TerminalSpecialKeyDetail>;
    [TERMINAL_CLIPBOARD_EVENT]: CustomEvent<TerminalClipboardDetail>;
  }
}
