const STORAGE_KEY = "caffold:settings";

export const APPEARANCE_VERSION = 2;

export const APPEARANCE_SETTINGS = Object.freeze({
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
    defaultValue: 15,
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

export const DEFAULT_SETTINGS = Object.freeze({
  appearanceVersion: APPEARANCE_VERSION,
  interfaceScalePercent: APPEARANCE_SETTINGS.interfaceScalePercent.defaultValue,
  conversationTextPx: APPEARANCE_SETTINGS.conversationTextPx.defaultValue,
  codeTextPx: APPEARANCE_SETTINGS.codeTextPx.defaultValue,
});

const LEGACY_TEXT_SIZES = Object.freeze({
  compact: 13,
  default: 15,
  large: 17,
});

let currentSettings = readStoredSettings();

persistSettings(currentSettings);
applySettings(currentSettings);

export function getSettings() {
  return { ...currentSettings };
}

export function setAppearanceSetting(name, value) {
  if (!Object.hasOwn(APPEARANCE_SETTINGS, name)) {
    return getSettings();
  }

  const settings = normalizeSettings({
    ...currentSettings,
    [name]: value,
  });
  persistApplyAndPublish(settings);
  return getSettings();
}

export function resetAppearanceSetting(name) {
  if (!Object.hasOwn(APPEARANCE_SETTINGS, name)) {
    return getSettings();
  }

  return setAppearanceSetting(name, APPEARANCE_SETTINGS[name].defaultValue);
}

export function resetAppearanceSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  persistApplyAndPublish(settings);
  return getSettings();
}

export function applySettings(settings = currentSettings) {
  if (typeof document === "undefined") {
    return;
  }

  const normalized = normalizeSettings(settings);
  const root = document.documentElement;
  root.style.setProperty(
    "--interface-scale",
    `${normalized.interfaceScalePercent / 100}`,
  );
  root.style.setProperty(
    "--conversation-font-size",
    `${normalized.conversationTextPx}px`,
  );
  root.style.setProperty("--code-font-size", `${normalized.codeTextPx}px`);
}

export function normalizeSettings(value) {
  const legacyConversationTextPx = legacyTextSize(value?.taskDetailSize);
  const legacyCodeTextPx = legacyTextSize(value?.codeSize);
  const conversationTextPx = hasSetting(value, "conversationTextPx")
    ? value.conversationTextPx
    : legacyConversationTextPx;
  const codeTextPx = hasSetting(value, "codeTextPx")
    ? value.codeTextPx
    : legacyCodeTextPx;

  return {
    appearanceVersion: APPEARANCE_VERSION,
    interfaceScalePercent: normalizeSettingValue(
      value?.interfaceScalePercent,
      APPEARANCE_SETTINGS.interfaceScalePercent,
    ),
    conversationTextPx: normalizeSettingValue(
      conversationTextPx,
      APPEARANCE_SETTINGS.conversationTextPx,
    ),
    codeTextPx: normalizeSettingValue(
      codeTextPx,
      APPEARANCE_SETTINGS.codeTextPx,
    ),
  };
}

function hasSetting(value, name) {
  return value !== null && typeof value === "object" && Object.hasOwn(value, name);
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

function legacyTextSize(value) {
  return typeof value === "string" ? LEGACY_TEXT_SIZES[value] : undefined;
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
