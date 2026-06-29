import { escapeHtml, formatBytes, formatModified, languageLabel } from "./dom.js";
import "./code-viewer.js";

class CodgerFileViewer extends HTMLElement {
  connectedCallback() {
    if (!this.state) {
      this.setEmpty();
    }
  }

  setEmpty() {
    this.state = { status: "empty" };
    this.render();
  }

  setLoading(path) {
    this.state = { status: "loading", path };
    this.render();
  }

  setFile(file) {
    this.state = { status: "file", file };
    this.render();
  }

  setError(path, error) {
    this.state = { status: "error", path, error };
    this.render();
  }

  render() {
    if (!this.state || this.state.status === "empty") {
      this.innerHTML = `
        <section class="viewer-panel empty-panel">
          <p>Select a file to inspect it.</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "loading") {
      this.innerHTML = `
        <section class="viewer-panel" aria-busy="true">
          <header>
            <h2>${escapeHtml(this.state.path)}</h2>
          </header>
          <p class="surface-message">Loading file...</p>
        </section>
      `;
      return;
    }

    if (this.state.status === "error") {
      this.innerHTML = `
        <section class="viewer-panel error-panel">
          <header>
            <h2>${escapeHtml(this.state.path || "File")}</h2>
          </header>
          <p class="surface-message">${escapeHtml(this.state.error.message)}</p>
        </section>
      `;
      return;
    }

    const { file } = this.state;
    const language = languageLabel(file.languageHint);
    this.innerHTML = `
      <section class="viewer-panel file-panel">
        <header>
          <h2>${escapeHtml(file.name)}</h2>
          <dl>
            <div data-field="path">
              <dt>Path</dt>
              <dd>${escapeHtml(file.path)}</dd>
            </div>
            <div data-field="size">
              <dt>Size</dt>
              <dd>${escapeHtml(formatBytes(file.size))}</dd>
            </div>
            <div data-field="modified">
              <dt>Modified</dt>
              <dd>${escapeHtml(formatModified(file.modifiedMs) || "Unknown")}</dd>
            </div>
            <div data-field="language">
              <dt>Language</dt>
              <dd>${escapeHtml(language)}</dd>
            </div>
          </dl>
        </header>
        <codger-code-viewer></codger-code-viewer>
      </section>
    `;

    this.querySelector("codger-code-viewer").setFile(file);
  }
}

customElements.define("codger-file-viewer", CodgerFileViewer);
