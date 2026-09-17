import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../../../action-hints.js";
import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";

export const SETTINGS_REFRESH_INTENT_EVENT = "caffold:settings-refresh-intent";

const LABEL = "Refresh";

/**
 * The Refresh action beside a Settings page description. The page says when
 * its report is being read and decides what a Refresh request does.
 */
class CaffoldSettingsRefreshButton extends HTMLElement {
  connectedCallback() {
    this.mount();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.renderIcon();
    warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  /** While refreshing, the action is disabled and its icon turns. */
  setState({ refreshing = false, disabled = false } = {}) {
    this.mount();
    this.button.disabled = refreshing || disabled;
    this.button.classList.toggle("is-refreshing", refreshing);
  }

  actionHintScope({ scopeId, clipRoots = [], isCurrent = () => true } = {}) {
    const control = this.button;
    if (!control || control.disabled || !hasActionHintLayoutBox(control)) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [buttonActionHintTarget({
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
      })],
      mutationRoots: [this],
      scrollRoots: [],
    };
  }

  mount() {
    if (this.button) {
      return;
    }
    this.boundIconsReady = () => this.renderIcon();
    this.innerHTML = `
      <button type="button">
        <span data-settings-icon="refresh"></span>
        <span>${LABEL}</span>
      </button>
    `;
    this.button = this.querySelector(":scope > button");
    this.icon = this.button.querySelector(":scope > [data-settings-icon]");
    this.button.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent(SETTINGS_REFRESH_INTENT_EVENT, { bubbles: true }),
      );
    });
  }

  renderIcon() {
    this.icon.innerHTML = renderInlineIcon("RefreshCw", "", "settings-refresh-icon");
  }
}

customElements.define("caffold-settings-refresh-button", CaffoldSettingsRefreshButton);
