export const DEFAULT_TYPEFACE_PRESET = "d2-coding";

const SYSTEM_MONO_STACK = "ui-monospace, monospace";

export const TYPEFACE_PRESETS = Object.freeze({
  "d2-coding": bundledTypeface("d2-coding", "D2 Coding"),
  "0xproto": bundledTypeface("0xproto", "0xProto"),
  "geist-mono": bundledTypeface("geist-mono", "Geist Mono"),
  "ibm-plex-mono": bundledTypeface("ibm-plex-mono", "IBM Plex Mono"),
  "jetbrains-mono": bundledTypeface("jetbrains-mono", "JetBrains Mono"),
  "monaspace-neon": bundledTypeface("monaspace-neon", "Monaspace Neon"),
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

// Each bundled label matches a "Caffold <label>" @font-face family in styles.css.
function bundledTypeface(id, label) {
  return Object.freeze({
    id,
    label,
    stack: `"Caffold ${label}", ${SYSTEM_MONO_STACK}`,
  });
}
