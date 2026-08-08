import { renderInlineIcon, warmIcons } from "../../../../components/icons.js";
import {
  APPEARANCE_SETTINGS,
  DEFAULT_SETTINGS,
  TYPEFACE_PRESETS,
  getSettings,
  resetAppearanceSetting,
  resetAppearanceSettings,
  setAppearanceSetting,
  setTypefacePreset,
} from "../../../../settings.js";

const SETTING_DESCRIPTIONS = Object.freeze({
  interfaceScalePercent:
    "Adjusts app controls, rows, icons, spacing, and interface text.",
  conversationTextPx:
    "Adjusts task conversation and long-form GitHub review text.",
  codeTextPx: "Adjusts source, diff, command output, and embedded code text.",
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

  handleInput(event) {
    const range = event.target.closest('input[type="range"][data-setting]');
    if (!range) {
      return;
    }

    setAppearanceSetting(range.dataset.setting, range.valueAsNumber);
  }

  handleChange(event) {
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
      resetAppearanceSetting(button.dataset.setting);
      return;
    }

    if (button.dataset.action === "reset-typeface") {
      setTypefacePreset(DEFAULT_SETTINGS.typefacePreset);
      return;
    }

    if (button.dataset.action === "reset-appearance") {
      resetAppearanceSettings();
    }
  }

  render() {
    this.innerHTML = `
      <div class="settings-scroll">
        <section class="settings-section" aria-labelledby="settings-appearance-title">
          <header>
            <div>
              <h2 id="settings-appearance-title">Appearance</h2>
              <p>Typeface and independent sizing controls keep every surface consistent.</p>
            </div>
            <button type="button" class="settings-reset-all" data-action="reset-appearance">
              Reset appearance
            </button>
          </header>
          ${renderTypefaceSetting()}
          ${renderSetting(
            "interfaceScalePercent",
            `
              <div class="settings-interface-preview" aria-label="Interface preview">
                <div class="settings-interface-preview-header">
                  <span data-settings-icon="preview">
                    ${renderInlineIcon("FolderGit2", "Git repository", "settings-preview-icon")}
                  </span>
                  <strong>caffold</strong>
                  <button type="button" tabindex="-1">Open</button>
                </div>
                <div class="settings-interface-preview-row">
                  <span>Review appearance settings</span>
                  <time>now</time>
                </div>
              </div>
            `,
          )}
          ${renderSetting(
            "conversationTextPx",
            `
              <div class="settings-conversation-preview" aria-label="Conversation preview">
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
            `,
          )}
          ${renderSetting(
            "codeTextPx",
            `
              <div class="settings-code-preview" aria-label="Code preview">
                <span class="settings-code-preview-line-number">12</span>
                <code><span>const</span> size = "readable";</code>
                <span class="settings-code-preview-line-number">13</span>
                <code>render(size);</code>
              </div>
            `,
          )}
        </section>
      </div>
    `;
  }

  syncControls(settings) {
    const typefaceSelect = this.querySelector("select[data-typeface-setting]");
    const typefaceReset = this.querySelector(
      'button[data-action="reset-typeface"]',
    );
    if (typefaceSelect) {
      typefaceSelect.value = settings.typefacePreset;
      this.syncTypefaceSummary(settings.typefacePreset);
    }
    if (typefaceReset) {
      typefaceReset.disabled =
        settings.typefacePreset === DEFAULT_SETTINGS.typefacePreset;
    }

    for (const [name, definition] of Object.entries(APPEARANCE_SETTINGS)) {
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
      reset.disabled = value === definition.defaultValue;
    }

    const resetAll = this.querySelector('button[data-action="reset-appearance"]');
    if (resetAll) {
      resetAll.disabled =
        settings.typefacePreset === DEFAULT_SETTINGS.typefacePreset &&
        Object.keys(APPEARANCE_SETTINGS).every(
          (name) => settings[name] === DEFAULT_SETTINGS[name],
        );
    }
  }

  syncTypefaceSummary(typefacePreset) {
    const preset = TYPEFACE_PRESETS[typefacePreset];
    const description = this.querySelector("[data-typeface-description]");
    const availability = this.querySelector("[data-typeface-availability]");
    if (description) {
      description.textContent = preset?.description ?? "";
    }
    if (availability) {
      availability.textContent = preset?.availability ?? "";
    }
  }

  refreshIcons() {
    const previewIcon = this.querySelector('[data-settings-icon="preview"]');
    if (previewIcon) {
      previewIcon.innerHTML = renderInlineIcon(
        "FolderGit2",
        "Git repository",
        "settings-preview-icon",
      );
    }
  }
}

function renderTypefaceSetting() {
  const options = Object.values(TYPEFACE_PRESETS)
    .map(
      (preset) => `
        <option value="${preset.id}">
          ${preset.label} · ${preset.availability}
        </option>
      `,
    )
    .join("");

  return `
    <div class="settings-appearance-group settings-typeface-group">
      <div class="settings-field settings-typeface-field">
        <div class="settings-field-copy">
          <label for="settings-typeface-preset">Typeface</label>
          <span data-typeface-description></span>
        </div>
        <div class="settings-typeface-control">
          <select
            id="settings-typeface-preset"
            data-typeface-setting
          >
            ${options}
          </select>
          <button type="button" data-action="reset-typeface">Reset</button>
        </div>
      </div>
      <span class="settings-typeface-meta" data-typeface-availability></span>
      <div class="settings-typeface-preview" aria-label="Typeface preview">
        <span>Caffold 한글 ABC</span>
        <code>const tree = "├─ 漢字";</code>
      </div>
    </div>
  `;
}

function renderSetting(name, preview) {
  const definition = APPEARANCE_SETTINGS[name];
  const id = `settings-${toKebabCase(name)}`;
  const defaultLabel = `${definition.defaultValue}${definition.suffix}`;

  return `
    <div class="settings-appearance-group">
      <div class="settings-field">
        <div class="settings-field-copy">
          <label for="${id}">${definition.label}</label>
          <span>${SETTING_DESCRIPTIONS[name]}</span>
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
          >
          <output for="${id}" data-setting-value="${name}">${defaultLabel}</output>
          <button
            type="button"
            data-action="reset-setting"
            data-setting="${name}"
          >
            Reset
          </button>
        </div>
      </div>
      ${preview}
    </div>
  `;
}

function toKebabCase(value) {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

customElements.define(
  "caffold-settings-appearance-page",
  CaffoldSettingsAppearancePage,
);
