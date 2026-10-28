import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { CaffoldElement } from "../caffold-element.js";

import styles from "./loading-text.css.js";

// A short phrase standing in for content that is still on its way. Its
// stylesheet keeps it out of sight for a brief wait, so loads that finish
// quickly never flash it; `immediate` is for owners that already waited. The
// owner gives the phrase as the element's text.
@customElement("caffold-loading-text")
class CaffoldLoadingText extends CaffoldElement {
  static override styles = styles;

  override connectedCallback() {
    super.connectedCallback();
    this.setAttribute("role", "status");
  }

  override render() {
    return html`<slot></slot>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-loading-text": CaffoldLoadingText;
  }
}
