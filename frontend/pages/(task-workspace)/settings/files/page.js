import {
  FILE_SORT_MODES,
  getSettings,
  setFileSortMode,
} from "../../../../settings.js";
import {
  ACTION_HINT_ACTION,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  radioActionHintTarget,
} from "../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../../../../scroll-scope.js";

const SORT_OPTIONS = Object.freeze([
  Object.freeze({
    value: FILE_SORT_MODES.FOLDERS_FIRST,
    label: "Folders first",
    description: "Show folders before files and other entries.",
  }),
  Object.freeze({
    value: FILE_SORT_MODES.NAME,
    label: "All entries by name",
    description: "Mix folders, files, and other entries using their names.",
  }),
]);

class CaffoldSettingsFilesPage extends HTMLElement {
  connectedCallback() {
    if (!this.initialized) {
      this.initialized = true;
      this.boundSettingsChange = (event) =>
        this.syncControls(event.detail?.settings ?? getSettings());
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
    this.syncControls(getSettings());
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
    this.syncControls(getSettings());
  }

  actionHintScope({
    scopeId = "settings:files",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-files-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const targetClipRoots = [this, scrollport, ...clipRoots].filter(Boolean);
    const targets = SORT_OPTIONS.flatMap((option) => {
      const selector =
        `input[type="radio"][data-file-sort-mode][value="${option.value}"]`;
      const control = this.querySelector(selector);
      if (!fileSortControlAvailable(control) || control.checked) {
        return [];
      }
      return [radioActionHintTarget({
        id: `${scopeId}:sort:${option.value}`,
        actionId: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
        label: `Use ${option.label} ordering`,
        control,
        anchor: control.closest?.("label") ?? control,
        clipRoots: targetClipRoots,
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(selector) === control &&
          fileSortControlAvailable(control) &&
          !control.checked,
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:files",
    label = "File settings",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-files-scroll");
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
          this.querySelector(":scope > .settings-files-scroll") === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport) &&
          hasVerticalScrollOverflow(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  handleChange(event) {
    const input = event.target.closest(
      'input[type="radio"][data-file-sort-mode]',
    );
    if (!input || !this.contains(input)) {
      return;
    }
    setFileSortMode(input.value);
  }

  render() {
    const options = SORT_OPTIONS.map(
      (option) => `
        <label>
          <input
            type="radio"
            name="settings-file-sort-mode"
            value="${option.value}"
            data-file-sort-mode
          >
          <span class="settings-files-option-copy">
            <strong>${option.label}</strong>
            <span>${option.description}</span>
          </span>
        </label>
      `,
    ).join("");

    this.innerHTML = `
      <div class="settings-files-scroll">
        <section class="settings-files-section">
          <header>
            <p id="settings-files-description">
              Choose how Caffold orders shared file trees in this browser.
            </p>
          </header>
          <fieldset
            class="settings-files-options"
            aria-describedby="settings-files-description settings-files-picker-note"
          >
            <legend class="sr-only">File tree ordering</legend>
            ${options}
          </fieldset>
          <p class="settings-files-note" id="settings-files-picker-note">
            The Working Directory Picker always keeps folders first.
          </p>
        </section>
      </div>
    `;
  }

  syncControls(settings) {
    this.querySelectorAll("input[data-file-sort-mode]").forEach((input) => {
      input.checked = input.value === settings.fileSortMode;
    });
  }
}

function fileSortControlAvailable(control) {
  return Boolean(
    control &&
      !control.disabled &&
      !control.hidden &&
      hasActionHintLayoutBox(control),
  );
}

customElements.define("caffold-settings-files-page", CaffoldSettingsFilesPage);
