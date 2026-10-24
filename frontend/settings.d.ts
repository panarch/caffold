// What TypeScript modules use from settings.js while it is still JavaScript.
// It goes when that module moves to TypeScript.

export type FileSortMode = "folders-first" | "name";

export const FILE_SORT_MODES: Readonly<{
  FOLDERS_FIRST: "folders-first";
  NAME: "name";
}>;

export function getSettings(): { fileSortMode: FileSortMode };

export function normalizeFileSortMode(value: unknown): FileSortMode;
