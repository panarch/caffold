const SYSTEM_THEME_QUERY = "(prefers-color-scheme: dark)";

export type ThemeMode = "system" | "light" | "dark";

// The theme the page draws in, with System resolved.
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME_MODE: ThemeMode = "system";
export const THEME_MODES: Readonly<
  Record<ThemeMode, Readonly<{ id: ThemeMode; label: string }>>
> = Object.freeze({
  system: Object.freeze({
    id: "system",
    label: "System",
  }),
  light: Object.freeze({
    id: "light",
    label: "Light",
  }),
  dark: Object.freeze({
    id: "dark",
    label: "Dark",
  }),
});

export const THEME_COLORS = Object.freeze({
  light: "#ffffff",
  dark: "#1b1b1b",
});

let activeThemeMode: ThemeMode = DEFAULT_THEME_MODE;
let activeResolvedTheme: ResolvedTheme = "light";
let initialized = false;
let systemThemeMedia: MediaQueryList | null = null;

export function normalizeThemeMode(value: unknown): ThemeMode {
  return Object.hasOwn(THEME_MODES, value as PropertyKey)
    ? (value as ThemeMode)
    : DEFAULT_THEME_MODE;
}

export function resolveTheme(
  value: unknown,
  prefersDark = systemPrefersDark(),
): ResolvedTheme {
  const themeMode = normalizeThemeMode(value);
  if (themeMode === "system") {
    return prefersDark ? "dark" : "light";
  }
  return themeMode;
}

export function applyThemeMode(value: unknown) {
  activeThemeMode = normalizeThemeMode(value);
  ensureSystemThemeListener();
  return applyResolvedTheme(resolveTheme(activeThemeMode));
}

export function getThemeState() {
  return {
    themeMode: activeThemeMode,
    resolvedTheme: activeResolvedTheme,
  };
}

function applyResolvedTheme(resolvedTheme: ResolvedTheme) {
  const previousTheme = activeResolvedTheme;
  activeResolvedTheme = resolvedTheme;

  const root = globalThis.document?.documentElement;
  if (root) {
    root.dataset.theme = resolvedTheme;
    root.style.colorScheme = resolvedTheme;
  }

  const themeColor = globalThis.document?.querySelector?.<HTMLMetaElement>(
    'meta[name="theme-color"]',
  );
  if (themeColor) {
    themeColor.content = THEME_COLORS[resolvedTheme];
  }

  if (initialized && previousTheme !== resolvedTheme) {
    globalThis.window?.dispatchEvent?.(
      new CustomEvent("caffold:theme-change", {
        detail: getThemeState(),
      }),
    );
  }
  initialized = true;
  return getThemeState();
}

function ensureSystemThemeListener() {
  if (systemThemeMedia || typeof globalThis.matchMedia !== "function") {
    return;
  }

  systemThemeMedia = globalThis.matchMedia(SYSTEM_THEME_QUERY);
  if (typeof systemThemeMedia.addEventListener === "function") {
    systemThemeMedia.addEventListener("change", handleSystemThemeChange);
  } else {
    systemThemeMedia.addListener?.(handleSystemThemeChange);
  }
}

function handleSystemThemeChange(event: MediaQueryListEvent) {
  if (activeThemeMode !== "system") {
    return;
  }
  applyResolvedTheme(event.matches ? "dark" : "light");
}

function systemPrefersDark() {
  ensureSystemThemeListener();
  return systemThemeMedia?.matches ?? false;
}
