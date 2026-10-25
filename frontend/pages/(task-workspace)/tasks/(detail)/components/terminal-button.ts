import { html, LitElement } from "lit";
import type {
  ActionHintScope,
  ActionHintScopeOptions,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "#app/action-hints.js";
import { compactIconButton } from "#app/component-styles.js";
import { inlineIcon } from "#components/icons.ts";

export const TERMINAL_BUTTON_INTENT_EVENT =
  "caffold:task-detail-terminal-intent";

// The Detail header's terminal toggle. It only reports the press; the Detail
// layout decides whether that enters the terminal or returns from it. The
// layout reads it right after handing it a snapshot, so it draws at once.
export class CaffoldTaskDetailTerminal extends LitElement {
  private available = false;
  private pressed = false;
  private readonly iconsReady = () => this.requestUpdate();

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

  actionHintScope({
    scopeId = "",
    clipRoots = [],
  }: ActionHintScopeOptions = {}): ActionHintScope {
    this.performUpdate();
    const control = this.button;
    if (!scopeId || !control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:terminal`,
          actionId: ACTION_HINT_ACTION.TERMINAL_OPEN,
          label: this.pressed ? "Leave terminal" : "Open terminal",
          control,
          clipRoots: [...clipRoots],
          isActionable: () =>
            this.isConnected &&
            this.available &&
            this.button === control &&
            !control.disabled,
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  render() {
    return html`<button
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

  private get button() {
    return this.querySelector<HTMLButtonElement>(
      ":scope > .task-terminal-button",
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
