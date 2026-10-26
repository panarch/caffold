import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import { compactIconButton } from "#app/component-styles.ts";
import { inlineIcon } from "#components/icons.ts";

export const TERMINAL_BUTTON_INTENT_EVENT =
  "caffold:task-detail-terminal-intent";

// The Detail header's terminal toggle. It only reports the press; the Detail
// layout decides whether that enters the terminal or returns from it.
export class CaffoldTaskDetailTerminal extends LitElement {
  private available = false;
  private pressed = false;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  setSnapshot({
    available = false,
    pressed = false,
  }: {
    available?: boolean;
    pressed?: boolean;
  } = {}) {
    this.available = Boolean(available);
    this.pressed = Boolean(pressed);
    this.requestUpdate();
    this.performUpdate();
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  render() {
    return html`<button
      ${this.hints.button({
        id: "terminal",
        label: this.pressed ? "Leave terminal" : "Open terminal",
        action: ACTION_HINT_ACTION.TERMINAL_OPEN,
      })}
      type="button"
      class="task-terminal-button"
      aria-label="Terminal"
      aria-pressed=${this.pressed ? "true" : "false"}
      title=${
        this.available
          ? "Terminal (Ctrl+`)"
          : "Terminal opens once the Task has loaded"
      }
      ?disabled=${!this.available}
      @click=${this.toggle}
    >${inlineIcon(
      "SquareTerminal",
      "Terminal",
      "task-terminal-icon",
    )}</button>`;
  }

  private toggle() {
    this.dispatchEvent(
      new CustomEvent<{ type: "toggle" }>(TERMINAL_BUTTON_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { type: "toggle" },
      }),
    );
  }
}

await compactIconButton.register(
  "caffold-task-detail-terminal",
  "> .task-terminal-button",
);

customElements.define(
  "caffold-task-detail-terminal",
  CaffoldTaskDetailTerminal,
);
