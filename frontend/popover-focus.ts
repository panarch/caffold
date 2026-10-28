import { containsAcrossShadowRoots, focusedElement } from "./shadow-roots.js";

// A popover that closes with focus inside it hands focus back to what had it
// as the popover opened, when the popover is in the document. In a shadow root
// Chromium leaves focus on the hidden element, so a popover there takes this
// as its `beforetoggle` listener to do the same.
export function returnPopoverFocus(event: ToggleEvent) {
  const popover = event.currentTarget;
  if (!(popover instanceof HTMLElement)) {
    return;
  }
  if (event.newState === "open") {
    const focused = focusedElement();
    if (focused instanceof HTMLElement) {
      focusBeforeOpen.set(popover, focused);
    } else {
      focusBeforeOpen.delete(popover);
    }
    return;
  }
  const before = focusBeforeOpen.get(popover);
  focusBeforeOpen.delete(popover);
  if (
    before?.isConnected &&
    containsAcrossShadowRoots(popover, focusedElement())
  ) {
    before.focus({ preventScroll: true });
  }
}

const focusBeforeOpen = new WeakMap<HTMLElement, HTMLElement>();
