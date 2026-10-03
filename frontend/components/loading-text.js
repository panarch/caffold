// A short phrase standing in for content that is still on its way. Its
// stylesheet keeps it out of sight for a brief wait, so loads that finish
// quickly never flash it; `immediate` is for owners that already waited.
class CaffoldLoadingText extends HTMLElement {
  connectedCallback() {
    this.setAttribute("role", "status");
  }
}

// Owners that patch their DOM keep the phrase already shown when it still
// says the same thing; a new element would start its delay and animation over.
export function retainLoadingText(current, text, { immediate = false } = {}) {
  if (
    current?.localName === "caffold-loading-text" &&
    current.textContent === text &&
    current.hasAttribute("immediate") === immediate
  ) {
    return current;
  }
  const loadingText = document.createElement("caffold-loading-text");
  loadingText.toggleAttribute("immediate", immediate);
  loadingText.textContent = text;
  return loadingText;
}

// Makes the phrase the container's only content, keeping a matching one.
export function showLoadingText(container, text) {
  const loadingText = retainLoadingText(container.firstChild, text);
  if (container.childNodes.length !== 1 || container.firstChild !== loadingText) {
    container.replaceChildren(loadingText);
  }
}

if (!customElements.get("caffold-loading-text")) {
  customElements.define("caffold-loading-text", CaffoldLoadingText);
}
