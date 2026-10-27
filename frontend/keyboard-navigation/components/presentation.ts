import { html } from "lit";
import { customElement } from "lit/decorators.js";
import "../../action-hints/components/dialog.js";
import type { CaffoldActionHintDialog } from "../../action-hints/components/dialog.js";
import { DrawnRef, drawn } from "../../components/drawn-refs.js";
import "./hud.js";
import type { CaffoldScrollModeHud } from "./hud.js";
import "./selector.js";
import { CaffoldElement } from "../../caffold-element.js";
import type { CaffoldScrollSurfaceSelector } from "./selector.js";

import styles from "./presentation.css.js";

/**
 * What one keyboard context shows its modes with: the Action Hint badges,
 * the Scroll HUD, and the Scroll surface selector. Each context draws its
 * own, so a modal or popover keeps them in its top layer.
 */
@customElement("caffold-keyboard-navigation-presentation")
export class CaffoldKeyboardNavigationPresentation extends CaffoldElement {
  static override styles = styles;

  private readonly dialog = new DrawnRef<CaffoldActionHintDialog>(this);
  private readonly hud = new DrawnRef<CaffoldScrollModeHud>(this);
  private readonly selector = new DrawnRef<CaffoldScrollSurfaceSelector>(this);

  override render() {
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

declare global {
  interface HTMLElementTagNameMap {
    "caffold-keyboard-navigation-presentation": CaffoldKeyboardNavigationPresentation;
  }
}
