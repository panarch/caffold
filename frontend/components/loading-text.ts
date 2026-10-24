// A short phrase standing in for content that is still on its way. Its
// stylesheet keeps it out of sight for a brief wait, so loads that finish
// quickly never flash it; `immediate` is for owners that already waited.
class CaffoldLoadingText extends HTMLElement {
  connectedCallback() {
    this.setAttribute("role", "status");
  }
}

// Makes the phrase the container's only content, for owners that patch their
// DOM. A phrase already shown that still says the same thing stays; a new
// element would start its delay and animation over.
export function showLoadingText(container: Element, text: string) {
  const current = container.firstChild as Element | null;
  if (
    current?.localName === "caffold-loading-text" &&
    current.textContent === text &&
    !current.hasAttribute("immediate")
  ) {
    if (container.childNodes.length !== 1) {
      container.replaceChildren(current);
    }
    return;
  }
  const loadingText = document.createElement("caffold-loading-text");
  loadingText.textContent = text;
  container.replaceChildren(loadingText);
}

customElements.define("caffold-loading-text", CaffoldLoadingText);
