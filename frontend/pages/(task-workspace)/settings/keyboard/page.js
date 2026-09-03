import {
  getSettings,
  setActionHintsEnabled,
} from "../../../../settings.js";
import {
  ACTION_HINT_ACTION,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  switchActionHintTarget,
} from "../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../scroll-scope.js";
import "../../../../keyboard-navigation/components/shortcut-list.js";

class CaffoldSettingsKeyboardPage extends HTMLElement {
  connectedCallback() {
    if (!this.initialized) {
      this.initialized = true;
      this.boundSettingsChange = (event) =>
        this.syncControl(event.detail?.settings ?? getSettings());
      this.addEventListener("change", (event) => this.handleChange(event));
      this.render();
    }
    if (!this.settingsListening) {
      window.addEventListener(
        "caffold:settings-change",
        this.boundSettingsChange,
      );
      this.settingsListening = true;
    }
    this.syncControl(getSettings());
  }

  disconnectedCallback() {
    if (this.settingsListening) {
      window.removeEventListener(
        "caffold:settings-change",
        this.boundSettingsChange,
      );
      this.settingsListening = false;
    }
  }

  prepareRoute() {
    this.syncControl(getSettings());
  }

  actionHintScope({
    scopeId = "settings:keyboard",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-keyboard-scroll");
    const selector = "input[data-action-hints-enabled]";
    const control = this.querySelector(selector);
    if (
      this.hidden ||
      !scrollport ||
      !keyboardSwitchAvailable(control) ||
      !control.checked
    ) {
      return emptyActionHintScope();
    }
    return {
      blocked: false,
      targets: [switchActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:action-hints:disable`,
        actionId: ACTION_HINT_ACTION.CONTROL_SWITCH_TOGGLE,
        label: "Turn keyboard navigation off",
        control,
        anchor: control.closest?.("label") ?? control,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(selector) === control &&
          keyboardSwitchAvailable(control) &&
          control.checked,
      })],
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:keyboard",
    label = "Keyboard settings",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-keyboard-scroll");
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(":scope > .settings-keyboard-scroll") ===
            scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  handleChange(event) {
    const input = event.target.closest(
      "input[data-action-hints-enabled]",
    );
    if (!input || !this.contains(input)) {
      return;
    }
    setActionHintsEnabled(input.checked);
  }

  render() {
    this.innerHTML = `
      <div class="settings-keyboard-scroll">
        <section class="settings-keyboard-section">
          <header>
            <p>Navigate Caffold with single keys when you are not typing.</p>
          </header>
          <label class="settings-keyboard-toggle">
            <span class="settings-keyboard-copy">
              <strong id="settings-action-hints-label">
                Keyboard navigation
              </strong>
              <span id="settings-action-hints-description">
                Enable keyboard shortcuts outside editing fields.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              data-action-hints-enabled
              aria-labelledby="settings-action-hints-label"
              aria-describedby="settings-action-hints-description"
            >
            <span class="settings-keyboard-state" aria-hidden="true"></span>
          </label>
          <section
            class="settings-keyboard-shortcuts"
            aria-labelledby="settings-keyboard-shortcuts-title"
          >
            <header>
              <h2 id="settings-keyboard-shortcuts-title">
                Keyboard shortcuts
              </h2>
              <p>Available when Keyboard navigation is on.</p>
            </header>
            <caffold-keyboard-shortcut-list></caffold-keyboard-shortcut-list>
          </section>
        </section>
      </div>
    `;
  }

  syncControl(settings) {
    const input = this.querySelector("input[data-action-hints-enabled]");
    if (input) {
      input.checked = settings.actionHintsEnabled !== false;
    }
  }
}

function keyboardSwitchAvailable(control) {
  return Boolean(
    control &&
      !control.disabled &&
      !control.hidden &&
      hasActionHintLayoutBox(control),
  );
}

if (!customElements.get("caffold-settings-keyboard-page")) {
  customElements.define(
    "caffold-settings-keyboard-page",
    CaffoldSettingsKeyboardPage,
  );
}
