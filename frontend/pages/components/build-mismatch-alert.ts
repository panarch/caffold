import { html, LitElement } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";

export const CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT =
  "caffold:build-mismatch-reload";

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
  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });

  constructor() {
    super();
    this.serverLabel = "";
  }

  createRenderRoot() {
    return this;
  }

  actionHintScope({
    scopeId = "app:build-mismatch",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
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
        <button
          ${this.hints.button({
            id: "reload",
            label: "Reload",
            action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          })}
          type="button"
          @click=${this.reload}
        >Reload</button>
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
