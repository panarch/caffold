import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  hasVerticalScrollOverflow,
} from "../../../../scroll-scope.js";
import {
  APPEARANCE_RANGE_SETTINGS,
  DEFAULT_APPEARANCE_SETTINGS,
  THEME_MODES,
  TYPEFACE_PRESETS,
  getSettings,
  resetAppearanceRangeSetting,
  resetAppearanceSettings,
  setAppearanceRangeSetting,
  setThemeMode,
  setTypefacePreset,
} from "../../../../settings.js";

const SETTING_DESCRIPTIONS = Object.freeze({
  interfaceScalePercent:
    "Makes controls, icons, spacing, and interface text larger or smaller.",
  conversationTextPx:
    "Changes the size of task conversations and long-form reviews.",
  codeTextPx: "Changes the size of code, diffs, and command output.",
});

class CaffoldSettingsAppearancePage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => this.handleClick(event));
    this.addEventListener("input", (event) => this.handleInput(event));
    this.addEventListener("change", (event) => this.handleChange(event));
    this.boundSettingsChange = (event) =>
      this.syncControls(event.detail?.settings ?? getSettings());
    this.boundIconsReady = () => this.refreshIcons();
    window.addEventListener("caffold:settings-change", this.boundSettingsChange);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
    this.syncControls(getSettings());
    warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:settings-change", this.boundSettingsChange);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  prepareRoute() {
    this.syncControls(getSettings());
  }

  actionHintScope({
    scopeId = "settings:appearance",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const definitions = [
      {
        id: "reset-all",
        selector: 'button[data-action="reset-appearance"]',
        label: "Reset all appearance settings",
      },
      {
        id: "reset-theme",
        selector: 'button[data-action="reset-theme"]',
        label: "Reset theme",
      },
      {
        id: "reset-typeface",
        selector: 'button[data-action="reset-typeface"]',
        label: "Reset font",
      },
      ...Object.keys(APPEARANCE_RANGE_SETTINGS).map((setting) => ({
        id: `reset-setting:${setting}`,
        selector:
          `button[data-action="reset-setting"][data-setting="${setting}"]`,
        label: `Reset ${APPEARANCE_RANGE_SETTINGS[setting].label.toLowerCase()}`,
      })),
    ];
    const targets = definitions.flatMap(({ id, selector, label }) => {
      const control = this.querySelector(selector);
      if (
        !control ||
        control.disabled ||
        control.hidden ||
        !hasActionHintLayoutBox(control)
      ) {
        return [];
      }
      return [buttonActionHintTarget({
        id: `${scopeId}:${id}`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label: control.getAttribute("aria-label") ||
          control.title ||
          control.textContent?.trim() ||
          label,
        control,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(selector) === control &&
          !control.disabled &&
          !control.hidden &&
          hasActionHintLayoutBox(control),
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
    scopeId = "settings:appearance",
    label = "Appearance settings",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-scroll");
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
          this.querySelector(":scope > .settings-scroll") === scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport) &&
          hasVerticalScrollOverflow(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  handleInput(event) {
    const range = event.target.closest('input[type="range"][data-setting]');
    if (!range) {
      return;
    }

    setAppearanceRangeSetting(range.dataset.setting, range.valueAsNumber);
  }

  handleChange(event) {
    const theme = event.target.closest('input[type="radio"][data-theme-setting]');
    if (theme) {
      setThemeMode(theme.value);
      return;
    }

    const select = event.target.closest("select[data-typeface-setting]");
    if (!select) {
      return;
    }

    setTypefacePreset(select.value);
  }

  handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "reset-setting") {
      resetAppearanceRangeSetting(button.dataset.setting);
      return;
    }

    if (button.dataset.action === "reset-typeface") {
      setTypefacePreset(DEFAULT_APPEARANCE_SETTINGS.typefacePreset);
      return;
    }

    if (button.dataset.action === "reset-theme") {
      setThemeMode(DEFAULT_APPEARANCE_SETTINGS.themeMode);
      return;
    }

    if (button.dataset.action === "reset-appearance") {
      resetAppearanceSettings();
    }
  }

  render() {
    this.innerHTML = `
      <div class="settings-scroll">
        <div class="settings-section">
          <header>
            <p>Choose Caffold's theme and font, then adjust interface and text size.</p>
            <button type="button" class="settings-reset-all" data-action="reset-appearance">
              <span data-settings-icon="reset-all">
                ${renderInlineIcon("RotateCcw", "", "settings-reset-all-icon")}
              </span>
              <span>Reset all</span>
            </button>
          </header>
          ${renderThemeSetting()}
          ${renderTypefaceSetting()}
          ${renderRangeSetting("interfaceScalePercent", "settings-interface-group")}
          ${renderTextSettings()}
        </div>
      </div>
    `;
  }

  syncControls(settings) {
    this.querySelectorAll("input[data-theme-setting]").forEach((input) => {
      input.checked = input.value === settings.themeMode;
    });
    const themeReset = this.querySelector('button[data-action="reset-theme"]');
    if (themeReset) {
      syncResetAction(
        themeReset,
        settings.themeMode === DEFAULT_APPEARANCE_SETTINGS.themeMode,
      );
    }

    const typefaceSelect = this.querySelector("select[data-typeface-setting]");
    const typefaceReset = this.querySelector(
      'button[data-action="reset-typeface"]',
    );
    if (typefaceSelect) {
      typefaceSelect.value = settings.typefacePreset;
    }
    if (typefaceReset) {
      syncResetAction(
        typefaceReset,
        settings.typefacePreset === DEFAULT_APPEARANCE_SETTINGS.typefacePreset,
      );
    }

    for (const [name, definition] of Object.entries(
      APPEARANCE_RANGE_SETTINGS,
    )) {
      const value = settings[name];
      const range = this.querySelector(`input[data-setting="${name}"]`);
      const output = this.querySelector(`output[data-setting-value="${name}"]`);
      const reset = this.querySelector(
        `button[data-action="reset-setting"][data-setting="${name}"]`,
      );
      if (!range || !output || !reset) {
        continue;
      }

      range.value = `${value}`;
      range.setAttribute("aria-valuetext", `${value}${definition.suffix}`);
      output.value = `${value}${definition.suffix}`;
      output.textContent = `${value}${definition.suffix}`;
      syncResetAction(reset, value === definition.defaultValue);
    }

    const resetAll = this.querySelector('button[data-action="reset-appearance"]');
    if (resetAll) {
      resetAll.disabled =
        settings.themeMode === DEFAULT_APPEARANCE_SETTINGS.themeMode &&
        settings.typefacePreset === DEFAULT_APPEARANCE_SETTINGS.typefacePreset &&
        Object.keys(APPEARANCE_RANGE_SETTINGS).every(
          (name) => settings[name] === DEFAULT_APPEARANCE_SETTINGS[name],
        );
    }
  }

  refreshIcons() {
    const resetAllIcon = this.querySelector(
      '[data-settings-icon="reset-all"]',
    );
    if (resetAllIcon) {
      resetAllIcon.innerHTML = renderInlineIcon(
        "RotateCcw",
        "",
        "settings-reset-all-icon",
      );
    }
    this.querySelectorAll("button[data-reset-label]").forEach((button) => {
      button.innerHTML = renderInlineIcon(
        "RotateCcw",
        button.dataset.resetLabel,
        "settings-reset-icon",
      );
    });
  }
}

function renderThemeSetting() {
  const options = Object.values(THEME_MODES)
    .map(
      (theme) => `
        <label>
          <input
            type="radio"
            name="settings-theme"
            value="${theme.id}"
            data-theme-setting
          >
          <span>${theme.label}</span>
        </label>
      `,
    )
    .join("");

  return `
    <div class="settings-appearance-group settings-theme-group">
      <div class="settings-field">
        <div class="settings-field-copy">
          <span class="settings-field-label" id="settings-theme-label">Theme</span>
          <span id="settings-theme-description">Use your system setting, or always use Light or Dark.</span>
        </div>
        <div class="settings-theme-control">
          <fieldset
            aria-labelledby="settings-theme-label"
            aria-describedby="settings-theme-description"
          >
            <legend class="sr-only">Theme</legend>
            ${options}
          </fieldset>
          ${renderResetAction("reset-theme", "Reset theme")}
        </div>
      </div>
    </div>
  `;
}

function renderTypefaceSetting() {
  const options = Object.values(TYPEFACE_PRESETS)
    .map(
      (preset) => `
        <option value="${preset.id}">
          ${preset.label}
        </option>
      `,
    )
    .join("");

  return `
    <div class="settings-appearance-group settings-typeface-group">
      <div class="settings-field settings-typeface-field">
        <div class="settings-field-copy">
          <label for="settings-typeface-preset">Font</label>
        </div>
        <div class="settings-typeface-detail">
          <div class="settings-typeface-control">
            <select
              id="settings-typeface-preset"
              data-typeface-setting
            >
              ${options}
            </select>
            ${renderResetAction("reset-typeface", "Reset font")}
          </div>
          <div class="settings-typeface-preview" aria-label="Font preview">
            <span>Latin · 한글 · 漢字 · ひらがな · カタカナ · 123</span>
            <code>const tree = "├─ src/main.rs";</code>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderRangeSetting(name, className = "") {
  return `
    <div class="settings-appearance-group settings-range-group ${className}">
      ${renderRangeField(name)}
    </div>
  `;
}

function renderTextSettings() {
  return `
    <div class="settings-appearance-group settings-text-group">
      ${renderRangeField("conversationTextPx")}
      ${renderRangeField("codeTextPx")}
      <div class="settings-preview-field">
        <div class="settings-text-preview" aria-label="Conversation and code preview">
          <div class="settings-conversation-preview">
            <div class="settings-conversation-message" data-message-role="user">
              <time>10:42</time>
              <p>Keep the review focused.</p>
            </div>
            <div class="settings-conversation-message" data-message-role="assistant">
              <time>10:43</time>
              <h3>Review complete</h3>
              <p>The changed behavior is covered by a focused test.</p>
            </div>
          </div>
          <div class="settings-code-preview">
            <span class="settings-code-preview-line-number">12</span>
            <code><span>const</span> size = "readable";</code>
            <span class="settings-code-preview-line-number">13</span>
            <code>render(size);</code>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderRangeField(name) {
  const definition = APPEARANCE_RANGE_SETTINGS[name];
  const id = `settings-${toKebabCase(name)}`;
  const descriptionId = `${id}-description`;
  const defaultLabel = `${definition.defaultValue}${definition.suffix}`;

  return `
    <div class="settings-field">
      <div class="settings-field-copy">
        <label for="${id}">${definition.label}</label>
        <span id="${descriptionId}">${SETTING_DESCRIPTIONS[name]}</span>
      </div>
      <div class="settings-range-control">
        <input
          id="${id}"
          type="range"
          min="${definition.min}"
          max="${definition.max}"
          step="${definition.step}"
          value="${definition.defaultValue}"
          data-setting="${name}"
          aria-describedby="${descriptionId}"
        >
        <output for="${id}" data-setting-value="${name}">${defaultLabel}</output>
        ${renderResetAction(
          "reset-setting",
          `Reset ${definition.label.toLowerCase()}`,
          `data-setting="${name}"`,
        )}
      </div>
    </div>
  `;
}

function renderResetAction(action, label, attributes = "") {
  return `
    <span class="settings-reset-slot">
      <button
        type="button"
        class="settings-inline-reset"
        data-action="${action}"
        data-reset-label="${label}"
        title="${label}"
        ${attributes}
        disabled
        hidden
      >
        ${renderInlineIcon("RotateCcw", label, "settings-reset-icon")}
      </button>
    </span>
  `;
}

function syncResetAction(button, isDefault) {
  button.disabled = isDefault;
  button.hidden = isDefault;
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

customElements.define(
  "caffold-settings-appearance-page",
  CaffoldSettingsAppearancePage,
);
