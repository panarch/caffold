import "../../action-hints/components/dialog.js";
import "./hud.js";
import "./selector.js";

class CaffoldKeyboardNavigationPresentation extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.innerHTML = `
      <caffold-action-hint-dialog></caffold-action-hint-dialog>
      <caffold-scroll-mode-hud></caffold-scroll-mode-hud>
      <caffold-scroll-surface-selector></caffold-scroll-surface-selector>
    `;
  }

  actionHintDialog() {
    return this.querySelector(":scope > caffold-action-hint-dialog");
  }

  scrollModeHud() {
    return this.querySelector(":scope > caffold-scroll-mode-hud");
  }

  scrollSurfaceSelector() {
    return this.querySelector(":scope > caffold-scroll-surface-selector");
  }
}

if (!customElements.get("caffold-keyboard-navigation-presentation")) {
  customElements.define(
    "caffold-keyboard-navigation-presentation",
    CaffoldKeyboardNavigationPresentation,
  );
}
