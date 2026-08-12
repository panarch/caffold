class CaffoldWorkspaceBrand extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.innerHTML = `
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
