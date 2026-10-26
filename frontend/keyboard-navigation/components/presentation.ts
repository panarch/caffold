import { html, LitElement } from "lit";
import "../../action-hints/components/dialog.ts";
import type { CaffoldActionHintDialog } from "../../action-hints/components/dialog.ts";
import { DrawnRef, drawn } from "../../components/drawn-refs.ts";
import "./hud.ts";
import type { CaffoldScrollModeHud } from "./hud.ts";
import "./selector.ts";
import type { CaffoldScrollSurfaceSelector } from "./selector.ts";

/**
 * What one keyboard context shows its modes with: the Action Hint badges,
 * the Scroll HUD, and the Scroll surface selector. Each context draws its
 * own, so a modal or popover keeps them in its top layer.
 */
export class CaffoldKeyboardNavigationPresentation extends LitElement {
  private readonly dialog = new DrawnRef<CaffoldActionHintDialog>(this);
  private readonly hud = new DrawnRef<CaffoldScrollModeHud>(this);
  private readonly selector = new DrawnRef<CaffoldScrollSurfaceSelector>(this);

  createRenderRoot() {
    return this;
  }

  render() {
    return html`
      <caffold-action-hint-dialog
        ${drawn(this.dialog)}
      ></caffold-action-hint-dialog>
      <caffold-scroll-mode-hud ${drawn(this.hud)}></caffold-scroll-mode-hud>
      <caffold-scroll-surface-selector
        ${drawn(this.selector)}
      ></caffold-scroll-surface-selector>
    `;
  }

  actionHintDialog() {
    return this.dialog.value ?? null;
  }

  scrollModeHud() {
    return this.hud.value ?? null;
  }

  scrollSurfaceSelector() {
    return this.selector.value ?? null;
  }
}

customElements.define(
  "caffold-keyboard-navigation-presentation",
  CaffoldKeyboardNavigationPresentation,
);
