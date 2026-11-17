export function languageServerMemory(bytes: number | null | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  const gibibyte = 1024 ** 3;
  return bytes >= gibibyte
    ? `${(bytes / gibibyte).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

// Tells the page a language or repository was turned on or off, so Integrated
// Review reads again whether names can be pressed.
export function announceLanguageServersChange() {
  window.dispatchEvent(new CustomEvent("caffold:language-servers-changed"));
}
