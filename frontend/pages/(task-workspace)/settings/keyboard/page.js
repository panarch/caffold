import {
  getSettings,
  setActionHintsEnabled,
} from "../../../../settings.js";

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
            <p>Choose how Caffold responds to keyboard-first navigation.</p>
          </header>
          <label class="settings-keyboard-toggle">
            <span class="settings-keyboard-copy">
              <strong>Keyboard navigation</strong>
              <span id="settings-action-hints-description">
                Press F outside an editing field to show available actions. Press S to select a scroll area, then use J/K or D/U to move it.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              data-action-hints-enabled
              aria-describedby="settings-action-hints-description"
            >
            <span class="settings-keyboard-state" aria-hidden="true"></span>
          </label>
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

if (!customElements.get("caffold-settings-keyboard-page")) {
  customElements.define(
    "caffold-settings-keyboard-page",
    CaffoldSettingsKeyboardPage,
  );
}
