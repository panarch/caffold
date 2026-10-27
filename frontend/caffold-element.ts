import { type CSSResultGroup, LitElement } from "lit";

import baseStyles from "./caffold-element/base.css.js";

/**
 * A Caffold component that renders into an open shadow root. Its styles begin
 * with the base rules every component's elements take, which the document
 * takes through `styles.css`.
 */
export class CaffoldElement extends LitElement {
  protected static override finalizeStyles(styles?: CSSResultGroup) {
    return LitElement.finalizeStyles([baseStyles, styles ?? []]);
  }
}
