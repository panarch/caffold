import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import "../components/workspace-brand.js";

const ITEMS = [
  { section: "appearance", label: "Appearance", icon: "Settings" },
  { section: "codex", label: "Codex", brand: true },
  { section: "about", label: "About Caffold", icon: "Info" },
];

class CaffoldSettingsNavigator extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.selectedSection = "";
    this.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-settings-section]");
      if (!button) {
        return;
      }
      this.dispatchEvent(
        new CustomEvent("caffold:settings-navigator-intent", {
          bubbles: true,
          detail: { section: button.dataset.settingsSection },
        }),
      );
    });
    this.boundIconsReady = () => this.render();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.render();
    warmIcons();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  setSelectedSection(section) {
    this.selectedSection = section ?? "";
    this.syncSelection();
  }

  render() {
    this.innerHTML = `
      <header class="settings-navigator-header">
        <caffold-workspace-brand></caffold-workspace-brand>
      </header>
      <nav class="settings-navigator-list" aria-label="Settings sections">
        ${ITEMS.map((item) => `
          <button
            type="button"
            data-settings-section="${item.section}"
          >
            ${item.brand
              ? `<img class="settings-navigator-brand" src="/assets/brand/codex-template@2x.png" alt="" />`
              : renderInlineIcon(item.icon, "", "settings-navigator-icon")}
            <span>${item.label}</span>
          </button>
        `).join("")}
      </nav>
    `;
    this.syncSelection();
  }

  syncSelection() {
    this.querySelectorAll("button[data-settings-section]").forEach((button) => {
      const selected = button.dataset.settingsSection === this.selectedSection;
      button.toggleAttribute("aria-current", selected);
    });
  }
}

customElements.define("caffold-settings-navigator", CaffoldSettingsNavigator);
