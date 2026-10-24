// What TypeScript modules use from presentation.js while it is still
// JavaScript. It goes when that module moves to TypeScript.

export interface CaffoldKeyboardNavigationPresentation extends HTMLElement {
  actionHintDialog(): HTMLElement | null;
  scrollModeHud(): HTMLElement | null;
  scrollSurfaceSelector(): HTMLElement | null;
}
