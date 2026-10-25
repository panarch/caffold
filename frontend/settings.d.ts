// What TypeScript modules use from settings.js while it is still JavaScript.
// It goes when that module moves to TypeScript.

export type FileSortMode = "folders-first" | "name";

export const FILE_SORT_MODES: Readonly<{
  FOLDERS_FIRST: "folders-first";
  NAME: "name";
}>;

export type ThemeMode = "system" | "light" | "dark";

export interface TypefacePreset {
  id: string;
  label: string;
  stack: string;
  nerdFont?: boolean;
}

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

export const THEME_MODES: Readonly<
  Record<ThemeMode, Readonly<{ id: ThemeMode; label: string }>>
>;

export const UI_TYPEFACE_PRESETS: Readonly<Record<string, TypefacePreset>>;

export const CODE_TYPEFACE_PRESETS: Readonly<Record<string, TypefacePreset>>;

export const APPEARANCE_RANGE_SETTINGS: Readonly<
  Record<AppearanceRangeName, Readonly<AppearanceRangeSetting>>
>;

export const DEFAULT_APPEARANCE_SETTINGS: Readonly<AppearanceSettings>;

export function getSettings(): Settings;

export function normalizeFileSortMode(value: unknown): FileSortMode;

export function setAppearanceRangeSetting(
  name: string,
  value: number,
): Settings;

export function resetAppearanceRangeSetting(name: string): Settings;

export function resetAppearanceSettings(): Settings;

export function setUiTypefacePreset(value: string): Settings;

export function setCodeTypefacePreset(value: string): Settings;

export function setThemeMode(value: string): Settings;

export function setFileSortMode(value: string): Settings;

export function setActionHintsEnabled(value: boolean): Settings;
