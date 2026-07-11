import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import {
  FILE_TREE_SIZES,
  getSettings,
  setFileTreeSize,
} from "../../settings.js";

class CaffoldSettingsPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.addEventListener("click", (event) => this.handleClick(event));
    this.boundSettingsChange = () => this.render();
    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:settings-change", this.boundSettingsChange);
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    warmIcons();
    this.render();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:settings-change", this.boundSettingsChange);
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  prepareRoute() {
    this.render();
  }

  handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "close-settings") {
      this.dispatchEvent(
        new CustomEvent("caffold:close-settings", {
          bubbles: true,
          composed: true,
        }),
      );
      return;
    }

    if (button.dataset.action === "set-file-tree-size") {
      setFileTreeSize(button.dataset.value);
    }
  }

  render() {
    const settings = getSettings();
    const options = FILE_TREE_SIZES.map(
      (option) => `
        <button
          type="button"
          role="radio"
          aria-checked="${option.value === settings.fileTreeSize}"
          data-action="set-file-tree-size"
          data-value="${option.value}"
        >
          <strong>${option.label}</strong>
          <span>${option.description}</span>
        </button>
      `,
    ).join("");

    this.innerHTML = `
      <header class="settings-header">
        <button
          class="settings-close-button"
          type="button"
          data-action="close-settings"
          title="Close settings"
          aria-label="Close settings"
        >
          ${renderInlineIcon("X", "Close settings", "settings-close-icon")}
        </button>
        <div>
          <h1>Settings</h1>
          <span>Local to this browser</span>
        </div>
      </header>
      <div class="settings-scroll">
        <section class="settings-section" aria-labelledby="settings-appearance-title">
          <header>
            <h2 id="settings-appearance-title">Appearance</h2>
          </header>
          <div class="settings-field">
            <div class="settings-field-copy">
              <strong>File tree size</strong>
              <span>Adjusts text, row height, icons, and indentation in every Files tree.</span>
            </div>
            <div class="settings-segmented-control" role="radiogroup" aria-label="File tree size">
              ${options}
            </div>
          </div>
          <div class="settings-tree-preview" aria-label="File tree preview">
            <div class="settings-preview-row settings-preview-directory">
              ${renderInlineIcon("FolderOpen", "Open directory", "settings-preview-icon")}
              <span>frontend</span>
            </div>
            <div class="settings-preview-row settings-preview-file">
              ${renderInlineIcon("FileCode", "Source file", "settings-preview-icon")}
              <span>settings.js</span>
            </div>
          </div>
        </section>
      </div>
    `;
  }
}

customElements.define("caffold-settings-page", CaffoldSettingsPage);
