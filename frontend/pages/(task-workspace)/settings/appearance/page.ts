import { html, LitElement, nothing } from "lit";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  type ActionHintTarget,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  selectActionHintTarget,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  radioActionHintTarget,
  rangeActionHintTarget,
} from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
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
import { inlineIcon, warmIcons } from "#components/icons.ts";

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

type ScopeOptions = ActionHintScopeOptions & { isCurrent?: () => boolean };

interface ScopeContext {
  scopeId: string;
  clipRoots: Element[];
  isCurrent: () => boolean;
}

// The controls stay in place while settings change, so a range being dragged
// keeps its element and focus while its value and preview follow it.
export class CaffoldSettingsAppearancePage extends LitElement {
  static properties = {
    settings: { state: true },
  };

  declare private settings: Settings;
  private readonly settingsChanged = (event: Event) => {
    this.settings =
      (event as CustomEvent<{ settings?: Settings }>).detail?.settings ??
      getSettings();
  };
  private readonly iconsReady = () => this.requestUpdate();

  constructor() {
    super();
    this.settings = getSettings();
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("caffold:settings-change", this.settingsChanged);
    window.addEventListener("caffold:icons-ready", this.iconsReady);
    this.settings = getSettings();
    void warmIcons();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("caffold:settings-change", this.settingsChanged);
    window.removeEventListener("caffold:icons-ready", this.iconsReady);
  }

  prepareRoute() {
    this.settings = getSettings();
  }

  render() {
    const settings = this.settings;
    const allDefault =
      settings.themeMode === DEFAULT_APPEARANCE_SETTINGS.themeMode &&
      [...TYPEFACES, ...RANGES].every(
        (name) => settings[name] === DEFAULT_APPEARANCE_SETTINGS[name],
      );
    const resetAllIcon = inlineIcon("RotateCcw", "", "settings-reset-all-icon");
    return html`
      <div class="settings-scroll">
        <div class="settings-section">
          <header>
            <p>
              Choose Caffold's theme and font, then adjust interface and text
              size.
            </p>
            <button
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
  updated() {
    for (const setting of TYPEFACES) {
      const select = this.querySelector<HTMLSelectElement>(
        `select[data-typeface-setting="${setting}"]`,
      );
      if (select && select.value !== this.settings[setting]) {
        select.value = this.settings[setting];
      }
    }
  }

  actionHintScope({
    scopeId = "settings:appearance",
    clipRoots = [],
    isCurrent = () => true,
  }: ScopeOptions = {}): ActionHintScope {
    const scrollport = this.querySelector(":scope > .settings-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const context = {
      scopeId,
      clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
      isCurrent,
    };
    return {
      blocked: false,
      targets: appearanceActionHintTargets(this, context),
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:appearance",
    label = "Appearance settings",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.querySelector(":scope > .settings-scroll");
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
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
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  private themeSetting() {
    const themeMode = this.settings.themeMode;
    const options = Object.values(THEME_MODES).map(
      (theme) => html`
        <label>
          <input
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
            ${resetAction({
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
    return html`
      <div class="settings-field">
        <div class="settings-field-copy">
          <label for=${id}>${definition.label}</label>
        </div>
        <div class="settings-typeface-control">
          <select
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
          ${resetAction({
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
          ${resetAction({
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

function resetAction({
  action,
  label,
  setting,
  typefaceSetting,
  isDefault,
  reset,
}: {
  action: string;
  label: string;
  setting?: string;
  typefaceSetting?: string;
  isDefault: boolean;
  reset: () => unknown;
}) {
  return html`
    <span class="settings-reset-slot">
      <button
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

function appearanceActionHintTargets(
  owner: HTMLElement,
  context: ScopeContext,
): ActionHintTarget[] {
  return [
    ...resetActionHintTargets(owner, context, [
      {
        id: "reset-all",
        selector: 'button[data-action="reset-appearance"]',
        label: "Reset all appearance settings",
      },
    ]),
    ...themeActionHintTargets(owner, context),
    ...resetActionHintTargets(owner, context, [
      {
        id: "reset-theme",
        selector: 'button[data-action="reset-theme"]',
        label: "Reset theme",
      },
    ]),
    ...TYPEFACES.flatMap((setting) => {
      const definition = TYPEFACE_SETTINGS[setting];
      return [
        ...typefaceActionHintTargets(owner, context, setting, definition),
        ...resetActionHintTargets(owner, context, [
          {
            id: `reset-typeface:${setting}`,
            selector: `button[data-action="reset-typeface"][data-typeface-setting="${setting}"]`,
            label: `Reset ${definition.label.toLowerCase()}`,
          },
        ]),
      ];
    }),
    ...RANGES.flatMap((setting) => {
      const definition = APPEARANCE_RANGE_SETTINGS[setting];
      return [
        ...rangeActionHintTargets(owner, context, setting, definition),
        ...resetActionHintTargets(owner, context, [
          {
            id: `reset-setting:${setting}`,
            selector: `button[data-action="reset-setting"][data-setting="${setting}"]`,
            label: `Reset ${definition.label.toLowerCase()}`,
          },
        ]),
      ];
    }),
  ];
}

function themeActionHintTargets(owner: HTMLElement, context: ScopeContext) {
  return Object.values(THEME_MODES).flatMap((theme) => {
    const selector = `input[type="radio"][data-theme-setting][value="${theme.id}"]`;
    const control = owner.querySelector<HTMLInputElement>(selector);
    if (!control || !actionHintControlAvailable(control) || control.checked) {
      return [];
    }
    return [
      radioActionHintTarget({
        invalidationOwner: owner,
        id: `${context.scopeId}:theme:${theme.id}`,
        actionId: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
        label: `Use ${theme.label} theme`,
        control,
        anchor: control.closest("label") ?? control,
        clipRoots: context.clipRoots,
        isActionable: () =>
          actionHintOwnerIsCurrent(owner, context) &&
          owner.querySelector(selector) === control &&
          actionHintControlAvailable(control) &&
          !control.checked,
      }),
    ];
  });
}

function typefaceActionHintTargets(
  owner: HTMLElement,
  context: ScopeContext,
  setting: TypefaceSetting,
  definition: (typeof TYPEFACE_SETTINGS)[TypefaceSetting],
) {
  const selector = `select[data-typeface-setting="${setting}"]`;
  const control = owner.querySelector<HTMLSelectElement>(selector);
  if (!control || !actionHintControlAvailable(control)) {
    return [];
  }
  const action = `Choose ${definition.label.toLowerCase()}`;
  const selectedLabel =
    control.selectedOptions?.[0]?.textContent?.trim() ||
    definition.presets[control.value]?.label ||
    control.value;
  return [
    selectActionHintTarget({
      invalidationOwner: owner,
      id: `${context.scopeId}:typeface:${setting}`,
      actionId: ACTION_HINT_ACTION.CONTROL_SELECT_OPEN,
      label: selectedLabel ? `${action} (current ${selectedLabel})` : action,
      control,
      clipRoots: context.clipRoots,
      isActionable: () =>
        actionHintOwnerIsCurrent(owner, context) &&
        owner.querySelector(selector) === control &&
        actionHintControlAvailable(control),
    }),
  ];
}

function rangeActionHintTargets(
  owner: HTMLElement,
  context: ScopeContext,
  setting: AppearanceRangeName,
  definition: AppearanceRangeSetting,
) {
  const selector = `input[type="range"][data-setting="${setting}"]`;
  const control = owner.querySelector<HTMLInputElement>(selector);
  if (!control || !actionHintControlAvailable(control)) {
    return [];
  }
  const currentValue =
    control.getAttribute("aria-valuetext") ||
    `${control.value}${definition.suffix}`;
  return [
    rangeActionHintTarget({
      invalidationOwner: owner,
      id: `${context.scopeId}:range:${setting}`,
      actionId: ACTION_HINT_ACTION.CONTROL_RANGE_FOCUS,
      label: `Adjust ${definition.label} (${currentValue})`,
      control,
      clipRoots: context.clipRoots,
      isActionable: () =>
        actionHintOwnerIsCurrent(owner, context) &&
        owner.querySelector(selector) === control &&
        actionHintControlAvailable(control),
    }),
  ];
}

function resetActionHintTargets(
  owner: HTMLElement,
  context: ScopeContext,
  definitions: Array<{ id: string; selector: string; label: string }>,
) {
  return definitions.flatMap(({ id, selector, label }) => {
    const control = owner.querySelector<HTMLButtonElement>(selector);
    if (!control || !actionHintControlAvailable(control)) {
      return [];
    }
    return [
      buttonActionHintTarget({
        invalidationOwner: owner,
        id: `${context.scopeId}:${id}`,
        actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
        label:
          control.getAttribute("aria-label") ||
          control.title ||
          control.textContent?.trim() ||
          label,
        control,
        clipRoots: context.clipRoots,
        isActionable: () =>
          actionHintOwnerIsCurrent(owner, context) &&
          owner.querySelector(selector) === control &&
          actionHintControlAvailable(control),
      }),
    ];
  });
}

function actionHintOwnerIsCurrent(
  owner: HTMLElement,
  { isCurrent }: ScopeContext,
) {
  return owner.isConnected && !owner.hidden && isCurrent();
}

function actionHintControlAvailable(
  control: HTMLInputElement | HTMLSelectElement | HTMLButtonElement,
) {
  return (
    !control.disabled && !control.hidden && hasActionHintLayoutBox(control)
  );
}

function toKebabCase(value: string) {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

customElements.define(
  "caffold-settings-appearance-page",
  CaffoldSettingsAppearancePage,
);
