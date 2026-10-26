import { html, LitElement } from "lit";
import {
  type ActionHintScope,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";

export const CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT =
  "caffold:build-mismatch-reload";
const RELOAD_BUTTON = ":scope > .build-mismatch-alert > button";

/**
 * Says the server runs another Caffold build than this window loaded, with
 * Reload. It shows only while the app shell names that build.
 */
export class CaffoldBuildMismatchAlert extends LitElement {
  static properties = {
    serverLabel: { attribute: false },
  };

  // The server's build while it differs from this window's, or empty.
  declare serverLabel: string;

  constructor() {
    super();
    this.serverLabel = "";
  }

  createRenderRoot() {
    return this;
  }

  actionHintScope(): ActionHintScope {
    this.performUpdate();
    const control = this.querySelector<HTMLButtonElement>(RELOAD_BUTTON);
    if (!control) {
      return emptyActionHintScope();
    }
    const visible =
      Boolean(this.serverLabel) &&
      !this.hidden &&
      hasActionHintLayoutBox(control);
    return {
      blocked: false,
      targets: visible
        ? [
            buttonActionHintTarget({
              invalidationOwner: this,
              id: "app:build-mismatch:reload",
              actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              label: control.textContent?.trim() || "Reload Caffold",
              control,
              clipRoots: [this],
              isActionable: () =>
                this.isConnected &&
                Boolean(this.serverLabel) &&
                !this.hidden &&
                this.querySelector(RELOAD_BUTTON) === control &&
                !control.disabled,
            }),
          ]
        : [],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  protected updated() {
    const hidden = !this.serverLabel;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }

  render() {
    return html`
      <div class="build-mismatch-alert" role="status" aria-live="polite">
        <span data-build-mismatch-message>${
          this.serverLabel
            ? `New Caffold build available (${this.serverLabel}).`
            : ""
        }</span>
        <button type="button" @click=${this.reload}>Reload</button>
      </div>
    `;
  }

  private reload() {
    this.dispatchEvent(
      new CustomEvent(CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT, {
        bubbles: true,
        composed: true,
      }),
    );
  }
}

customElements.define(
  "caffold-build-mismatch-alert",
  CaffoldBuildMismatchAlert,
);
