export const DEFAULT_TYPEFACE_PRESET = "d2-coding";

const D2_CODING_STACK = '"Caffold D2 Coding", ui-monospace, monospace';
const SYSTEM_MONO_STACK = "ui-monospace, monospace";

export const TYPEFACE_PRESETS = Object.freeze({
  "d2-coding": Object.freeze({
    id: "d2-coding",
    label: "D2 Coding",
    stack: D2_CODING_STACK,
  }),
  "system-mono": Object.freeze({
    id: "system-mono",
    label: "System Mono",
    stack: SYSTEM_MONO_STACK,
  }),
});

export function normalizeTypefacePreset(value) {
  return typeof value === "string" && Object.hasOwn(TYPEFACE_PRESETS, value)
    ? value
    : DEFAULT_TYPEFACE_PRESET;
}

export function getTypefacePreset(value) {
  return TYPEFACE_PRESETS[normalizeTypefacePreset(value)];
}

export function applyTypefacePreset(value, root = document.documentElement) {
  const preset = getTypefacePreset(value);
  root.style.setProperty("--font-ui", preset.stack);
  root.style.setProperty("--font-code", preset.stack);
  root.dataset.typefacePreset = preset.id;
  return preset;
}
