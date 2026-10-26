import { html, LitElement, nothing } from "lit";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import { busySpin } from "#app/component-styles.ts";
import { inlineIcon, warmIcons } from "#components/icons.ts";

export const SETTINGS_REFRESH_INTENT_EVENT = "caffold:settings-refresh-intent";

const LABEL = "Refresh";

/**
 * The Refresh action beside a Settings page description. The page says when
 * its report is being read and decides what a Refresh request does.
 */
export class CaffoldSettingsRefreshButton extends LitElement {
  static properties = {
    refreshing: { attribute: false },
    disabled: { attribute: false },
  };

  // While refreshing, the action is disabled and its icon turns.
  declare refreshing: boolean;
  declare disabled: boolean;
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints = new ActionHints(this, () => this.performUpdate());

  constructor() {
    super();
    this.refreshing = false;
    this.disabled = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  render() {
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

await busySpin.register(
  "caffold-settings-refresh-button",
  "> button.is-refreshing > span > .settings-refresh-icon",
);

customElements.define(
  "caffold-settings-refresh-button",
  CaffoldSettingsRefreshButton,
);
