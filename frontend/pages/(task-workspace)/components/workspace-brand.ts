import { html, LitElement } from "lit";

class CaffoldWorkspaceBrand extends LitElement {
  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.performUpdate();
  }

  render() {
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

customElements.define("caffold-workspace-brand", CaffoldWorkspaceBrand);
