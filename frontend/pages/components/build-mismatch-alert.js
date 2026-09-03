import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../action-hints.js";

export const CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT =
  "caffold:build-mismatch-reload";

class CaffoldBuildMismatchAlert extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.render();
    this.querySelector("button")?.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent(CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT, {
          bubbles: true,
          composed: true,
        }),
      );
    });
    this.applyStatus();
  }

  setStatus(status) {
    this.status = status?.serverLabel
      ? { serverLabel: status.serverLabel }
      : null;
    this.applyStatus();
  }

  applyStatus() {
    if (!this.initialized) {
      return;
    }
    const message = this.querySelector("[data-build-mismatch-message]");
    if (!message) {
      return;
    }
    message.textContent = this.status
      ? `New Caffold build available (${this.status.serverLabel}).`
      : "";
    this.hidden = !this.status;
  }

  actionHintScope() {
    const control = this.querySelector(":scope > .build-mismatch-alert > button");
    if (!control) {
      return emptyActionHintScope();
    }
    const visible =
      Boolean(this.status) &&
      !this.hidden &&
      hasActionHintLayoutBox(control);
    return {
      blocked: false,
      targets: visible ? [buttonActionHintTarget({
        invalidationOwner: this,
        id: "app:build-mismatch:reload",
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.textContent?.trim() || "Reload Caffold",
        control,
        clipRoots: [this],
        isActionable: () =>
          this.isConnected &&
          Boolean(this.status) &&
          !this.hidden &&
          this.querySelector(":scope > .build-mismatch-alert > button") ===
            control &&
          !control.disabled,
      })] : [],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  render() {
    this.innerHTML = `
      <div class="build-mismatch-alert" role="status" aria-live="polite">
        <span data-build-mismatch-message></span>
        <button type="button">Reload</button>
      </div>
    `;
  }
}

customElements.define(
  "caffold-build-mismatch-alert",
  CaffoldBuildMismatchAlert,
);
