import {
  applyCodeTypefacePreset,
  applyUiTypefacePreset,
  CODE_TYPEFACE_PRESETS,
  DEFAULT_CODE_TYPEFACE_PRESET,
  DEFAULT_UI_TYPEFACE_PRESET,
  normalizeCodeTypefacePreset,
  normalizeUiTypefacePreset,
  UI_TYPEFACE_PRESETS,
} from "./fonts.js";
import {
  applyThemeMode,
  DEFAULT_THEME_MODE,
  normalizeThemeMode,
  THEME_MODES,
  type ThemeMode,
} from "./theme.js";

export type { TypefacePreset } from "./fonts.js";

const STORAGE_KEY = "caffold:settings";

export const FILE_SORT_MODES = Object.freeze({
  FOLDERS_FIRST: "folders-first",
  NAME: "name",
});
export type FileSortMode =
  (typeof FILE_SORT_MODES)[keyof typeof FILE_SORT_MODES];
export const DEFAULT_FILE_SORT_MODE: FileSortMode =
  FILE_SORT_MODES.FOLDERS_FIRST;
export { CODE_TYPEFACE_PRESETS, THEME_MODES, UI_TYPEFACE_PRESETS };

// A ranged Appearance setting: how it reads, its bounds and step, and the
// unit it shows.
export interface AppearanceRangeSetting {
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  suffix: string;
}

export type AppearanceRangeName =
  | "interfaceScalePercent"
  | "conversationTextPx"
  | "codeTextPx";

export const APPEARANCE_RANGE_SETTINGS: Readonly<
  Record<AppearanceRangeName, Readonly<AppearanceRangeSetting>>
> = Object.freeze({
  interfaceScalePercent: Object.freeze({
    label: "Interface size",
    min: 90,
    max: 120,
    step: 5,
    defaultValue: 100,
    suffix: "%",
  }),
  conversationTextPx: Object.freeze({
    label: "Conversation text",
    min: 13,
    max: 20,
    step: 1,
    defaultValue: 14,
    suffix: "px",
  }),
  codeTextPx: Object.freeze({
    label: "Code text",
    min: 12,
    max: 20,
    step: 1,
    defaultValue: 13,
    suffix: "px",
  }),
});

export interface AppearanceSettings {
  themeMode: ThemeMode;
  uiTypefacePreset: string;
  codeTypefacePreset: string;
  interfaceScalePercent: number;
  conversationTextPx: number;
  codeTextPx: number;
}

export interface Settings extends AppearanceSettings {
  fileSortMode: FileSortMode;
  actionHintsEnabled: boolean;
}

export const DEFAULT_APPEARANCE_SETTINGS: Readonly<AppearanceSettings> =
  Object.freeze({
    themeMode: DEFAULT_THEME_MODE,
    uiTypefacePreset: DEFAULT_UI_TYPEFACE_PRESET,
    codeTypefacePreset: DEFAULT_CODE_TYPEFACE_PRESET,
    interfaceScalePercent:
      APPEARANCE_RANGE_SETTINGS.interfaceScalePercent.defaultValue,
    conversationTextPx:
      APPEARANCE_RANGE_SETTINGS.conversationTextPx.defaultValue,
    codeTextPx: APPEARANCE_RANGE_SETTINGS.codeTextPx.defaultValue,
  });

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  ...DEFAULT_APPEARANCE_SETTINGS,
  fileSortMode: DEFAULT_FILE_SORT_MODE,
  actionHintsEnabled: true,
});

let currentSettings = readStoredSettings();

persistSettings(currentSettings);
applySettings(currentSettings);

export function getSettings(): Settings {
  return { ...currentSettings };
}

export function setAppearanceRangeSetting(name: string, value: number) {
  if (!Object.hasOwn(APPEARANCE_RANGE_SETTINGS, name)) {
    return getSettings();
  }

  const settings = normalizeSettings({
    ...currentSettings,
    [name]: value,
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function setUiTypefacePreset(value: unknown) {
  const settings = normalizeSettings({
    ...currentSettings,
    uiTypefacePreset: normalizeUiTypefacePreset(value),
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function setCodeTypefacePreset(value: unknown) {
  const settings = normalizeSettings({
    ...currentSettings,
    codeTypefacePreset: normalizeCodeTypefacePreset(value),
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function setThemeMode(value: unknown) {
  const themeMode = normalizeThemeMode(value);
  const settings = normalizeSettings({
    ...currentSettings,
    themeMode,
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function setFileSortMode(value: unknown) {
  const settings = normalizeSettings({
    ...currentSettings,
    fileSortMode: normalizeFileSortMode(value),
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function setActionHintsEnabled(value: unknown) {
  const settings = normalizeSettings({
    ...currentSettings,
    actionHintsEnabled: Boolean(value),
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function resetAppearanceRangeSetting(name: string) {
  if (!Object.hasOwn(APPEARANCE_RANGE_SETTINGS, name)) {
    return getSettings();
  }

  return setAppearanceRangeSetting(
    name,
    APPEARANCE_RANGE_SETTINGS[name as AppearanceRangeName].defaultValue,
  );
}

export function resetAppearanceSettings() {
  const settings = normalizeSettings({
    ...currentSettings,
    ...DEFAULT_APPEARANCE_SETTINGS,
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function applySettings(settings: unknown = currentSettings) {
  if (typeof document === "undefined") {
    return;
  }

  const normalized = normalizeSettings(settings);
  const root = document.documentElement;
  applyThemeMode(normalized.themeMode);
  root.style.setProperty(
    "--interface-scale",
    `${normalized.interfaceScalePercent / 100}`,
  );
  root.style.setProperty(
    "--conversation-font-size",
    `${normalized.conversationTextPx}px`,
  );
  root.style.setProperty("--code-font-size", `${normalized.codeTextPx}px`);
  applyUiTypefacePreset(normalized.uiTypefacePreset);
  applyCodeTypefacePreset(normalized.codeTypefacePreset);
}

export function normalizeSettings(input: unknown): Settings {
  const value = input as Partial<Record<keyof Settings, unknown>> | null;
  return {
    themeMode: normalizeThemeMode(value?.themeMode),
    uiTypefacePreset: normalizeUiTypefacePreset(value?.uiTypefacePreset),
    codeTypefacePreset: normalizeCodeTypefacePreset(value?.codeTypefacePreset),
    interfaceScalePercent: normalizeSettingValue(
      value?.interfaceScalePercent,
      APPEARANCE_RANGE_SETTINGS.interfaceScalePercent,
    ),
    conversationTextPx: normalizeSettingValue(
      value?.conversationTextPx,
      APPEARANCE_RANGE_SETTINGS.conversationTextPx,
    ),
    codeTextPx: normalizeSettingValue(
      value?.codeTextPx,
      APPEARANCE_RANGE_SETTINGS.codeTextPx,
    ),
    fileSortMode: normalizeFileSortMode(value?.fileSortMode),
    actionHintsEnabled:
      typeof value?.actionHintsEnabled === "boolean"
        ? value.actionHintsEnabled
        : true,
  };
}

export function normalizeFileSortMode(value: unknown): FileSortMode {
  return (Object.values(FILE_SORT_MODES) as unknown[]).includes(value)
    ? (value as FileSortMode)
    : DEFAULT_FILE_SORT_MODE;
}

function normalizeSettingValue(
  value: unknown,
  definition: Readonly<AppearanceRangeSetting>,
) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return definition.defaultValue;
  }

  const stepped =
    definition.min +
    Math.round((value - definition.min) / definition.step) * definition.step;
  return Math.min(definition.max, Math.max(definition.min, stepped));
}

function readStoredSettings(): Settings {
  if (typeof window === "undefined") {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "null",
    );
    return normalizeSettings(stored);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistApplyAndPublish(settings: Settings) {
  currentSettings = { ...settings };
  persistSettings(currentSettings);
  applySettings(currentSettings);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("caffold:settings-change", {
        detail: { settings: getSettings() },
      }),
    );
  }
}

function persistSettings(settings: Settings) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Keep the normalized in-memory setting active when storage is unavailable.
  }
}
