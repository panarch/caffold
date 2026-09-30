import { compactIconButton } from "../../../../../component-styles.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
} from "../../../../../action-hints.js";
import { renderInlineIcon } from "../../../../../components/icons.js";

export const TERMINAL_BUTTON_INTENT_EVENT = "caffold:task-detail-terminal-intent";

// The Detail header's terminal toggle. It only reports the press; the Detail
// layout decides whether that enters the terminal or returns from it.
class CaffoldTaskDetailTerminal extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.snapshot = { available: false, pressed: false };
    this.boundIconsReady = () => this.renderIcon();
    this.innerHTML = `
      <button
        type="button"
        class="task-terminal-button"
        aria-label="Terminal"
        aria-pressed="false"
      ></button>
    `;
    this.button().addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent(TERMINAL_BUTTON_INTENT_EVENT, {
        bubbles: true,
        composed: true,
        detail: { type: "toggle" },
      }));
    });
    this.renderIcon();
    this.patch();
  }

  setSnapshot(snapshot = {}) {
    this.ensureRendered();
    this.snapshot = {
      available: Boolean(snapshot.available),
      pressed: Boolean(snapshot.pressed),
    };
    this.patch();
  }

  actionHintScope({ scopeId = "", clipRoots = [] } = {}) {
    this.ensureRendered();
    const control = this.button();
    if (!scopeId || !control) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:terminal`,
        actionId: ACTION_HINT_ACTION.TERMINAL_OPEN,
        label: this.snapshot.pressed ? "Leave terminal" : "Open terminal",
        control,
        clipRoots: [...clipRoots],
        isActionable: () =>
          this.isConnected &&
          this.snapshot.available &&
          this.button() === control &&
          !control.disabled,
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  patch() {
    const button = this.button();
    if (!button) {
      return;
    }
    button.disabled = !this.snapshot.available;
    button.setAttribute("aria-pressed", this.snapshot.pressed ? "true" : "false");
    const title = this.snapshot.available
      ? "Terminal (Ctrl+`)"
      : "Terminal opens once the Task has loaded";
    if (button.title !== title) {
      button.title = title;
    }
  }

  renderIcon() {
    const button = this.button();
    const icon = renderInlineIcon("SquareTerminal", "Terminal", "task-terminal-icon");
    if (button && button.innerHTML.trim() !== icon.trim()) {
      button.innerHTML = icon;
    }
  }

  button() {
    return this.querySelector(":scope > .task-terminal-button");
  }
}

await compactIconButton.register("caffold-task-detail-terminal", "> .task-terminal-button");

if (!customElements.get("caffold-task-detail-terminal")) {
  customElements.define("caffold-task-detail-terminal", CaffoldTaskDetailTerminal);
}
