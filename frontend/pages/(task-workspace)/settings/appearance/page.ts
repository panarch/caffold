import { html, LitElement, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.js";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.js";
import {
  APPEARANCE_RANGE_SETTINGS,
  type AppearanceRangeName,
  type AppearanceRangeSetting,
  CODE_TYPEFACE_PRESETS,
  DEFAULT_APPEARANCE_SETTINGS,
  getSettings,
  resetAppearanceRangeSetting,
  resetAppearanceSettings,
  type Settings,
  setAppearanceRangeSetting,
  setCodeTypefacePreset,
  setThemeMode,
  setUiTypefacePreset,
  THEME_MODES,
  type TypefacePreset,
  UI_TYPEFACE_PRESETS,
} from "#app/settings.js";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.js";
import { inlineIcon, warmIcons } from "#components/icons.js";

type TypefaceSetting = "uiTypefacePreset" | "codeTypefacePreset";

const TYPEFACE_SETTINGS: Readonly<
  Record<
    TypefaceSetting,
    {
      label: string;
      presets: Readonly<Record<string, TypefacePreset>>;
      apply: (value: string) => unknown;
    }
  >
> = Object.freeze({
  uiTypefacePreset: Object.freeze({
    label: "Interface font",
    presets: UI_TYPEFACE_PRESETS,
    apply: setUiTypefacePreset,
  }),
  codeTypefacePreset: Object.freeze({
    label: "Code font",
    presets: CODE_TYPEFACE_PRESETS,
    apply: setCodeTypefacePreset,
  }),
});

const SETTING_DESCRIPTIONS: Readonly<Record<AppearanceRangeName, string>> =
  Object.freeze({
    interfaceScalePercent:
      "Makes controls, icons, spacing, and interface text larger or smaller.",
    conversationTextPx:
      "Changes the size of task conversations and long-form reviews.",
    codeTextPx: "Changes the size of code, diffs, and command output.",
  });

const INTERFACE_GROUP =
  "settings-appearance-group settings-range-group settings-interface-group";

const TYPEFACES = Object.keys(TYPEFACE_SETTINGS) as TypefaceSetting[];
const RANGES = Object.keys(APPEARANCE_RANGE_SETTINGS) as AppearanceRangeName[];

// The controls stay in place while settings change, so a range being dragged
// keeps its element and focus while its value and preview follow it.
@customElement("caffold-settings-appearance-page")
export class CaffoldSettingsAppearancePage extends LitElement {
  @state()
  private accessor settings: Settings = getSettings();

  private readonly settingsChanged = (event: Event) => {
    this.settings =
      (event as CustomEvent<{ settings?: Settings }>).detail?.settings ??
      getSettings();
  };
  private readonly iconsReady = () => this.requestUpdate();
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly themeLabels = new DrawnRefs<HTMLLabelElement>(this);
  private readonly typefaceSelects = new DrawnRefs<HTMLSelectElement>(this);

  override createRenderRoot() {
    return this;
  }

  override connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:settings-change", this.settingsChanged);
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    this.settings = getSettings();
    void warmIcons();
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:settings-change", this.settingsChanged);
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  prepareRoute() {
    this.settings = getSettings();
  }

  override render() {
    const settings = this.settings;
    const allDefault =
      settings.themeMode === DEFAULT_APPEARANCE_SETTINGS.themeMode &&
      [...TYPEFACES, ...RANGES].every(
        (name) => settings[name] === DEFAULT_APPEARANCE_SETTINGS[name],
      );
    const resetAllIcon = inlineIcon("RotateCcw", "", "settings-reset-all-icon");
    return html`
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="settings-scroll"
      >
        <div class="settings-section">
          <header>
            <p>
              Choose Caffold's theme and font, then adjust interface and text
              size.
            </p>
            <button
              ${this.hints.button({
                id: "reset-all",
                label: "Reset all",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              class="settings-reset-all"
              data-action="reset-appearance"
              ?disabled=${allDefault}
              @click=${resetAppearanceSettings}
            >
              <span data-settings-icon="reset-all">${resetAllIcon}</span>
              <span>Reset all</span>
            </button>
          </header>
          ${this.themeSetting()}
          ${this.typefaceSetting()}
          <div class=${INTERFACE_GROUP}>
            ${this.rangeField("interfaceScalePercent")}
          </div>
          ${this.textSettings()}
        </div>
      </div>
    `;
  }

  // A `.value` binding would land before the options it names.
  override updated() {
    for (const setting of TYPEFACES) {
      const select = this.typefaceSelects.get(setting);
      if (select && select.value !== this.settings[setting]) {
        select.value = this.settings[setting];
      }
    }
  }

  actionHintScope({
    scopeId = "settings:appearance",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:appearance",
    label = "Appearance settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private themeSetting() {
    const themeMode = this.settings.themeMode;
    const options = Object.values(THEME_MODES).map(
      (theme) => html`
        <label ${drawn(this.themeLabels.of(theme.id))}>
          <input
            ${this.hints.radio({
              id: `theme:${theme.id}`,
              label: `Use ${theme.label} theme`,
              action: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
              when: theme.id !== themeMode,
              anchor: () => this.themeLabels.get(theme.id),
            })}
            type="radio"
            name="settings-theme"
            value=${theme.id}
            data-theme-setting
            .checked=${theme.id === themeMode}
            @change=${() => setThemeMode(theme.id)}
          >
          <span>${theme.label}</span>
        </label>
      `,
    );
    return html`
      <div class="settings-appearance-group settings-theme-group">
        <div class="settings-field">
          <div class="settings-field-copy">
            <span
              class="settings-field-label"
              id="settings-theme-label"
            >Theme</span>
            <span id="settings-theme-description">
              Use your system setting, or always use Light or Dark.
            </span>
          </div>
          <div class="settings-theme-control">
            <fieldset
              aria-labelledby="settings-theme-label"
              aria-describedby="settings-theme-description"
            >
              <legend class="sr-only">Theme</legend>
              ${options}
            </fieldset>
            ${resetAction(this.hints, {
              id: "reset-theme",
              action: "reset-theme",
              label: "Reset theme",
              isDefault: themeMode === DEFAULT_APPEARANCE_SETTINGS.themeMode,
              reset: () => setThemeMode(DEFAULT_APPEARANCE_SETTINGS.themeMode),
            })}
          </div>
        </div>
      </div>
    `;
  }

  private typefaceSetting() {
    return html`
      <div class="settings-appearance-group settings-typeface-group">
        ${TYPEFACES.map((setting) => this.typefaceField(setting))}
        <div class="settings-preview-field">
          <div class="settings-typeface-preview" aria-label="Font preview">
            <span>Latin · 한글 · 漢字 · ひらがな · カタカナ · 123</span>
            <code>const tree = "├─ src/main.rs";</code>
          </div>
        </div>
      </div>
    `;
  }

  private typefaceField(setting: TypefaceSetting) {
    const definition = TYPEFACE_SETTINGS[setting];
    const id = `settings-${toKebabCase(setting)}`;
    const presets = Object.values(definition.presets);
    const nerdFonts = presets.filter((preset) => preset.nerdFont);
    const label = definition.label.toLowerCase();
    const selected = this.settings[setting];
    const shown = definition.presets[selected]?.label || selected;
    return html`
      <div class="settings-field">
        <div class="settings-field-copy">
          <label for=${id}>${definition.label}</label>
        </div>
        <div class="settings-typeface-control">
          <select
            ${drawn(this.typefaceSelects.of(setting))}
            ${this.hints.select({
              id: `typeface:${setting}`,
              label: shown
                ? `Choose ${label} (current ${shown})`
                : `Choose ${label}`,
              action: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN,
            })}
            id=${id}
            data-typeface-setting=${setting}
            @change=${(event: Event) =>
              definition.apply((event.target as HTMLSelectElement).value)}
          >
            ${typefaceOptions(presets.filter((preset) => !preset.nerdFont))}
            ${
              nerdFonts.length > 0
                ? html`
                  <optgroup label="Nerd Fonts">
                    ${typefaceOptions(nerdFonts)}
                  </optgroup>
                `
                : ""
            }
          </select>
          ${resetAction(this.hints, {
            id: `reset-typeface:${setting}`,
            action: "reset-typeface",
            label: `Reset ${label}`,
            typefaceSetting: setting,
            isDefault:
              this.settings[setting] === DEFAULT_APPEARANCE_SETTINGS[setting],
            reset: () => definition.apply(DEFAULT_APPEARANCE_SETTINGS[setting]),
          })}
        </div>
      </div>
    `;
  }

  private textSettings() {
    return html`
      <div class="settings-appearance-group settings-text-group">
        ${this.rangeField("conversationTextPx")}
        ${this.rangeField("codeTextPx")}
        <div class="settings-preview-field">
          <div
            class="settings-text-preview"
            aria-label="Conversation and code preview"
          >
            <div class="settings-conversation-preview">
              <div
                class="settings-conversation-message"
                data-message-role="user"
              >
                <time>10:42</time>
                <p>Keep the review focused.</p>
              </div>
              <div
                class="settings-conversation-message"
                data-message-role="assistant"
              >
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

  private rangeField(name: AppearanceRangeName) {
    const definition: AppearanceRangeSetting = APPEARANCE_RANGE_SETTINGS[name];
    const id = `settings-${toKebabCase(name)}`;
    const descriptionId = `${id}-description`;
    const value = this.settings[name];
    const valueText = `${value}${definition.suffix}`;
    return html`
      <div class="settings-field">
        <div class="settings-field-copy">
          <label for=${id}>${definition.label}</label>
          <span id=${descriptionId}>${SETTING_DESCRIPTIONS[name]}</span>
        </div>
        <div class="settings-range-control">
          <input
            ${this.hints.range({
              id: `range:${name}`,
              label: `Adjust ${definition.label} (${valueText})`,
              action: ACTION_HINT_ACTION.CONTROL_RANGE_FOCUS,
            })}
            id=${id}
            type="range"
            min=${definition.min}
            max=${definition.max}
            step=${definition.step}
            .value=${`${value}`}
            data-setting=${name}
            aria-describedby=${descriptionId}
            aria-valuetext=${valueText}
            @input=${(event: Event) =>
              setAppearanceRangeSetting(
                name,
                (event.target as HTMLInputElement).valueAsNumber,
              )}
          >
          <output
            for=${id}
            data-setting-value=${name}
            .value=${valueText}
          ></output>
          ${resetAction(this.hints, {
            id: `reset-setting:${name}`,
            action: "reset-setting",
            label: `Reset ${definition.label.toLowerCase()}`,
            setting: name,
            isDefault: value === definition.defaultValue,
            reset: () => resetAppearanceRangeSetting(name),
          })}
        </div>
      </div>
    `;
  }
}

function typefaceOptions(presets: TypefacePreset[]) {
  return presets.map(
    (preset) => html`
      <option value=${preset.id}>
        ${preset.label}
      </option>
    `,
  );
}

function resetAction(
  hints: ActionHints,
  {
    id,
    action,
    label,
    setting,
    typefaceSetting,
    isDefault,
    reset,
  }: {
    id: string;
    action: string;
    label: string;
    setting?: string;
    typefaceSetting?: string;
    isDefault: boolean;
    reset: () => unknown;
  },
) {
  return html`
    <span class="settings-reset-slot">
      <button
        ${hints.button({
          id,
          label,
          action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        })}
        type="button"
        class="settings-inline-reset"
        data-action=${action}
        data-reset-label=${label}
        title=${label}
        data-setting=${setting ?? nothing}
        data-typeface-setting=${typefaceSetting ?? nothing}
        ?disabled=${isDefault}
        ?hidden=${isDefault}
        @click=${reset}
      >
        ${inlineIcon("RotateCcw", label, "settings-reset-icon")}
      </button>
    </span>
  `;
}

function toKebabCase(value: string) {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-settings-appearance-page": CaffoldSettingsAppearancePage;
  }
}
