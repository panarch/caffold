import { html, LitElement } from "lit";
import { customElement } from "lit/decorators.js";

@customElement("caffold-workspace-brand")
class CaffoldWorkspaceBrand extends LitElement {
  override createRenderRoot() {
    return this;
  }

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
