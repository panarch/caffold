import { type CSSResultGroup, LitElement } from "lit";
import { addShadowRoot, removeShadowRoot } from "./shadow-roots.js";

import baseStyles from "./caffold-element/base.css.js";

/**
 * A Caffold component that renders into an open shadow root. Its styles begin
 * with the base rules every component's elements take, which the document
 * takes through `styles.css`, and its root joins the document's shadow roots
 * while it is connected.
 */
export class CaffoldElement extends LitElement {
  protected static override finalizeStyles(styles?: CSSResultGroup) {
    return LitElement.finalizeStyles([baseStyles, styles ?? []]);
  }

  override connectedCallback() {
    super.connectedCallback();
    if (this.shadowRoot) {
      addShadowRoot(this.shadowRoot);
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    if (this.shadowRoot) {
      removeShadowRoot(this.shadowRoot);
    }
  }
}
