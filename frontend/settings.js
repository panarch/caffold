import {
  DEFAULT_TYPEFACE_PRESET,
  TYPEFACE_PRESETS,
  applyTypefacePreset,
  normalizeTypefacePreset,
} from "./fonts.js";
import {
  DEFAULT_THEME_MODE,
  THEME_MODES,
  applyThemeMode,
  normalizeThemeMode,
} from "./theme.js";

const STORAGE_KEY = "caffold:settings";

export const FILE_SORT_MODES = Object.freeze({
  FOLDERS_FIRST: "folders-first",
  NAME: "name",
});
export const DEFAULT_FILE_SORT_MODE = FILE_SORT_MODES.FOLDERS_FIRST;
export { THEME_MODES, TYPEFACE_PRESETS };

export const APPEARANCE_RANGE_SETTINGS = Object.freeze({
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

export const DEFAULT_APPEARANCE_SETTINGS = Object.freeze({
  themeMode: DEFAULT_THEME_MODE,
  typefacePreset: DEFAULT_TYPEFACE_PRESET,
  interfaceScalePercent:
    APPEARANCE_RANGE_SETTINGS.interfaceScalePercent.defaultValue,
  conversationTextPx:
    APPEARANCE_RANGE_SETTINGS.conversationTextPx.defaultValue,
  codeTextPx: APPEARANCE_RANGE_SETTINGS.codeTextPx.defaultValue,
});

export const DEFAULT_SETTINGS = Object.freeze({
  ...DEFAULT_APPEARANCE_SETTINGS,
  fileSortMode: DEFAULT_FILE_SORT_MODE,
  actionHintsEnabled: true,
});

let currentSettings = readStoredSettings();

persistSettings(currentSettings);
applySettings(currentSettings);

export function getSettings() {
  return { ...currentSettings };
}

export function setAppearanceRangeSetting(name, value) {
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

export function setTypefacePreset(value) {
  const typefacePreset = normalizeTypefacePreset(value);
  const settings = normalizeSettings({
    ...currentSettings,
    typefacePreset,
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function setThemeMode(value) {
  const themeMode = normalizeThemeMode(value);
  const settings = normalizeSettings({
    ...currentSettings,
    themeMode,
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function setFileSortMode(value) {
  const settings = normalizeSettings({
    ...currentSettings,
    fileSortMode: normalizeFileSortMode(value),
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function setActionHintsEnabled(value) {
  const settings = normalizeSettings({
    ...currentSettings,
    actionHintsEnabled: Boolean(value),
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function resetAppearanceRangeSetting(name) {
  if (!Object.hasOwn(APPEARANCE_RANGE_SETTINGS, name)) {
    return getSettings();
  }

  return setAppearanceRangeSetting(
    name,
    APPEARANCE_RANGE_SETTINGS[name].defaultValue,
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

export function applySettings(settings = currentSettings) {
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
  applyTypefacePreset(normalized.typefacePreset);
}

export function normalizeSettings(value) {
  return {
    themeMode: normalizeThemeMode(value?.themeMode),
    typefacePreset: normalizeTypefacePreset(value?.typefacePreset),
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

export function normalizeFileSortMode(value) {
  return Object.values(FILE_SORT_MODES).includes(value)
    ? value
    : DEFAULT_FILE_SORT_MODE;
}

function normalizeSettingValue(value, definition) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return definition.defaultValue;
  }

  const stepped =
    definition.min +
    Math.round((value - definition.min) / definition.step) * definition.step;
  return Math.min(definition.max, Math.max(definition.min, stepped));
}

function readStoredSettings() {
  if (typeof window === "undefined") {
    return { ...DEFAULT_SETTINGS };
  }

  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    return normalizeSettings(stored);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function persistApplyAndPublish(settings) {
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

function persistSettings(settings) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Keep the normalized in-memory setting active when storage is unavailable.
  }
}
