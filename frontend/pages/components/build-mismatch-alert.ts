import { html } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { CaffoldElement } from "#app/caffold-element.js";

import styles from "./build-mismatch-alert.css.js";

export const CAFFOLD_BUILD_MISMATCH_RELOAD_EVENT =
  "caffold:build-mismatch-reload";

/**
 * Says the server runs another Caffold build than this window loaded, with
 * Reload. It shows only while the app shell names that build.
 */
@customElement("caffold-build-mismatch-alert")
export class CaffoldBuildMismatchAlert extends CaffoldElement {
  // The server's build while it differs from this window's, or empty.
  @property({ attribute: false })
  accessor serverLabel = "";

  static override styles = styles;

  private readonly hints = new ActionHints(this, {
    clipRoots: () => [this],
  });

  actionHintScope({
    scopeId = "app:build-mismatch",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  protected override updated() {
    const hidden = !this.serverLabel;
    if (this.hidden !== hidden) {
      this.hidden = hidden;
    }
  }

  override render() {
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-build-mismatch-alert": CaffoldBuildMismatchAlert;
  }
}
