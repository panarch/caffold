import { html, LitElement, nothing } from "lit";
import { customElement, property } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { inlineIcon, warmIcons } from "#components/icons.js";

import { busySpin } from "#app/component-styles.js";

export const SETTINGS_REFRESH_INTENT_EVENT = "caffold:settings-refresh-intent";

const LABEL = "Refresh";

await busySpin.register(
  "caffold-settings-refresh-button",
  "> button.is-refreshing > span > .settings-refresh-icon",
);

/**
 * The Refresh action beside a Settings page description. The page says when
 * its report is being read and decides what a Refresh request does.
 */
@customElement("caffold-settings-refresh-button")
export class CaffoldSettingsRefreshButton extends LitElement {
  // While refreshing, the action is disabled and its icon turns.
  @property({ attribute: false })
  accessor refreshing = false;
  @property({ attribute: false })
  accessor disabled = false;

  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  override render() {
    return html`
      <button
        ${this.hints.button({
          id: "refresh",
          label: LABEL,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class=${this.refreshing ? "is-refreshing" : nothing}
        ?disabled=${this.refreshing || this.disabled}
        @click=${this.requestRefresh}
      >
        <span data-settings-icon="refresh">${inlineIcon(
          "RefreshCw",
          "",
          "settings-refresh-icon",
        )}</span>
        <span>${LABEL}</span>
      </button>
    `;
  }

  actionHintScope(pull: ActionHintPull = {}) {
    return this.hints.scope(pull);
  }

  private requestRefresh() {
    this.dispatchEvent(
      new CustomEvent(SETTINGS_REFRESH_INTENT_EVENT, { bubbles: true }),
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-refresh-button": CaffoldSettingsRefreshButton;
  }
}
