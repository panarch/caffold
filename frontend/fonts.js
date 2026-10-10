export const DEFAULT_UI_TYPEFACE_PRESET = "geist-sans";
export const DEFAULT_CODE_TYPEFACE_PRESET = "geist-mono-nerd-font";

const SYSTEM_SANS_STACK = "system-ui, sans-serif";
const SYSTEM_MONO_STACK = "ui-monospace, monospace";

export const UI_TYPEFACE_PRESETS = Object.freeze({
  "geist-sans": bundledTypeface("geist-sans", "Geist Sans", SYSTEM_SANS_STACK),
  inter: bundledTypeface("inter", "Inter", SYSTEM_SANS_STACK),
  pretendard: bundledTypeface("pretendard", "Pretendard", SYSTEM_SANS_STACK),
  system: Object.freeze({
    id: "system",
    label: "System",
    stack: SYSTEM_SANS_STACK,
  }),
});

export const CODE_TYPEFACE_PRESETS = Object.freeze({
  "d2-coding": bundledTypeface("d2-coding", "D2 Coding", SYSTEM_MONO_STACK),
  "0xproto": bundledTypeface("0xproto", "0xProto", SYSTEM_MONO_STACK),
  "geist-mono": bundledTypeface("geist-mono", "Geist Mono", SYSTEM_MONO_STACK),
  "ibm-plex-mono": bundledTypeface(
    "ibm-plex-mono",
    "IBM Plex Mono",
    SYSTEM_MONO_STACK,
  ),
  "jetbrains-mono": bundledTypeface(
    "jetbrains-mono",
    "JetBrains Mono",
    SYSTEM_MONO_STACK,
  ),
  "monaspace-neon": bundledTypeface(
    "monaspace-neon",
    "Monaspace Neon",
    SYSTEM_MONO_STACK,
  ),
  "system-mono": Object.freeze({
    id: "system-mono",
    label: "System Mono",
    stack: SYSTEM_MONO_STACK,
  }),
  "d2-koding-ligature-nerd-font": nerdFontTypeface(
    "d2-koding-ligature-nerd-font",
    "D2KodingLigature Nerd Font",
  ),
  "0xproto-nerd-font": nerdFontTypeface(
    "0xproto-nerd-font",
    "0xProto Nerd Font",
  ),
  "geist-mono-nerd-font": nerdFontTypeface(
    "geist-mono-nerd-font",
    "GeistMono Nerd Font",
  ),
  "blex-mono-nerd-font": nerdFontTypeface(
    "blex-mono-nerd-font",
    "BlexMono Nerd Font",
  ),
  "jetbrains-mono-nerd-font": nerdFontTypeface(
    "jetbrains-mono-nerd-font",
    "JetBrainsMono Nerd Font",
  ),
  "monaspice-ne-nerd-font": nerdFontTypeface(
    "monaspice-ne-nerd-font",
    "MonaspiceNe Nerd Font",
  ),
});

export function normalizeUiTypefacePreset(value) {
  return normalizePreset(
    UI_TYPEFACE_PRESETS,
    value,
    DEFAULT_UI_TYPEFACE_PRESET,
  );
}

export function normalizeCodeTypefacePreset(value) {
  return normalizePreset(
    CODE_TYPEFACE_PRESETS,
    value,
    DEFAULT_CODE_TYPEFACE_PRESET,
  );
}

export function applyUiTypefacePreset(value, root = document.documentElement) {
  const preset = UI_TYPEFACE_PRESETS[normalizeUiTypefacePreset(value)];
  root.style.setProperty("--font-ui", preset.stack);
  root.dataset.uiTypefacePreset = preset.id;
  return preset;
}

export function applyCodeTypefacePreset(value, root = document.documentElement) {
  const preset = CODE_TYPEFACE_PRESETS[normalizeCodeTypefacePreset(value)];
  root.style.setProperty("--font-code", preset.stack);
  root.dataset.codeTypefacePreset = preset.id;
  return preset;
}

function normalizePreset(presets, value, fallback) {
  return typeof value === "string" && Object.hasOwn(presets, value)
    ? value
    : fallback;
}

// Each bundled label matches a "Caffold <label>" @font-face family in styles.css.
function bundledTypeface(id, label, systemFallback) {
  return Object.freeze({
    id,
    label,
    stack: `"Caffold ${label}", ${systemFallback}`,
  });
}

// A Nerd Fonts build adds the icons and Powerline symbols of terminal prompts.
function nerdFontTypeface(id, label) {
  return Object.freeze({
    ...bundledTypeface(id, label, SYSTEM_MONO_STACK),
    nerdFont: true,
  });
}
