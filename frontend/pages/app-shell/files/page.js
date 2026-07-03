import "../../../components/file-list.js";
import "../../../components/file-viewer.js";

class CaffoldFilesPage extends HTMLElement {
  connectedCallback() {
    this.ensureRendered();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }

    this.rendered = true;
    this.innerHTML = `
      <caffold-file-list></caffold-file-list>
      <div
        class="panel-resizer"
        role="separator"
        aria-label="Resize left panel"
        aria-orientation="vertical"
        tabindex="0"
      ></div>
      <caffold-file-viewer></caffold-file-viewer>
    `;
  }
}

customElements.define("caffold-files-page", CaffoldFilesPage);
