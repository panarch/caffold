// A short phrase standing in for content that is still on its way. Its
// stylesheet keeps it out of sight for a brief wait, so loads that finish
// quickly never flash it; `immediate` is for owners that already waited.
class CaffoldLoadingText extends HTMLElement {
  connectedCallback() {
    this.setAttribute("role", "status");
  }
}

customElements.define("caffold-loading-text", CaffoldLoadingText);
