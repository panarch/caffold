import { html } from "lit";
import { customElement } from "lit/decorators.js";
import { CaffoldElement } from "#app/caffold-element.js";

import styles from "./workspace-brand.css.js";

@customElement("caffold-workspace-brand")
class CaffoldWorkspaceBrand extends CaffoldElement {
  static override styles = styles;

  override render() {
    return html`
      <img
        class="workspace-brand-icon"
        src="/assets/icons/favicon-32.png"
        alt=""
      >
      <span class="workspace-brand-title">Caffold</span>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "caffold-workspace-brand": CaffoldWorkspaceBrand;
  }
}
