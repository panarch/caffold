import { renderInlineIcon, warmIcons } from "../../components/icons.js";
import {
  CODE_SIZES,
  FILE_TREE_SIZES,
  getSettings,
  setCodeSize,
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
      return;
    }

    if (button.dataset.action === "set-code-size") {
      setCodeSize(button.dataset.value);
    }
  }

  render() {
    const settings = getSettings();
    const fileTreeOptions = renderOptions(
      FILE_TREE_SIZES,
      settings.fileTreeSize,
      "set-file-tree-size",
    );
    const codeOptions = renderOptions(CODE_SIZES, settings.codeSize, "set-code-size");

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
            <div class="settings-segmented-control settings-segmented-control-four" role="radiogroup" aria-label="File tree size">
              ${fileTreeOptions}
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
          <div class="settings-field">
            <div class="settings-field-copy">
              <strong>Code size</strong>
              <span>Adjusts source and diff text while keeping code line spacing independent.</span>
            </div>
            <div class="settings-segmented-control settings-segmented-control-three" role="radiogroup" aria-label="Code size">
              ${codeOptions}
            </div>
          </div>
          <div class="settings-code-preview" aria-label="Code preview">
            <span class="settings-code-preview-line-number">12</span>
            <code><span>const</span> size = "readable";</code>
            <span class="settings-code-preview-line-number">13</span>
            <code>render(size);</code>
          </div>
        </section>
      </div>
    `;
  }
}

function renderOptions(options, selectedValue, action) {
  return options
    .map(
      (option) => `
        <button
          type="button"
          role="radio"
          aria-checked="${option.value === selectedValue}"
          data-action="${action}"
          data-value="${option.value}"
        >
          <strong>${option.label}</strong>
          <span>${option.description}</span>
        </button>
      `,
    )
    .join("");
}

customElements.define("caffold-settings-page", CaffoldSettingsPage);
