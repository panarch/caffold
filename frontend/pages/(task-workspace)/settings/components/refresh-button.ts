import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import { ACTION_HINT_ACTION } from "#app/action-hints.js";
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

  actionHintScope({
    scopeId,
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    const control = this.button;
    if (!control || control.disabled || !hasActionHintLayoutBox(control)) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [
        buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:refresh`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: LABEL,
          control,
          clipRoots,
          isActionable: () =>
            this.isConnected &&
            isCurrent() &&
            this.button === control &&
            !control.disabled &&
            hasActionHintLayoutBox(control),
        }),
      ],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  private requestRefresh() {
    this.dispatchEvent(
      new CustomEvent(SETTINGS_REFRESH_INTENT_EVENT, { bubbles: true }),
    );
  }

  private get button() {
    return this.querySelector<HTMLButtonElement>(":scope > button");
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
