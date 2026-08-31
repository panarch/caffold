import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import {
  codexState,
  formatCodexReadiness,
} from "../codex-status.js";
import "../components/workspace-brand.js";
import { emptyActionHintScope } from "../../../action-hint-scope.js";
import { ACTION_HINT_ACTION } from "../action-hints.js";

// Each brand mark is published in a single color so it can be tinted, and the
// theme tints it through --brand-monochrome-filter.
const ITEMS = [
  { section: "appearance", label: "Appearance", icon: "Settings" },
  { section: "keyboard", label: "Keyboard", icon: "Keyboard" },
  { section: "files", label: "Files", icon: "File" },
  { section: "notifications", label: "Notifications", icon: "Bell" },
  { section: "remote-access", label: "Remote Access", icon: "Link" },
  { section: "codex", label: "Codex", brand: "codex-template@2x.png" },
  { section: "claude", label: "Claude", brand: "claude-template.png" },
  { section: "about", label: "About Caffold", icon: "Info" },
];

class CaffoldSettingsNavigator extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.selectedSection = "";
    this.codexStatusSnapshotValue = null;
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

  setCodexStatusSnapshot(snapshot) {
    this.codexStatusSnapshotValue = snapshot ?? null;
    this.syncCodexStatus();
  }

  actionHintScope({ scopeId = "settings", clipRoots = [] } = {}) {
    if (!this.initialized || this.hidden) {
      return emptyActionHintScope();
    }
    const scroller = this.querySelector(":scope > .settings-navigator-list");
    if (!scroller) {
      return emptyActionHintScope();
    }
    const targets = ITEMS.flatMap((item) => {
      const control = this.querySelector(
        `:scope > .settings-navigator-list > button[data-settings-section="${item.section}"]`,
      );
      if (
        !control ||
        control.disabled ||
        item.section === this.selectedSection
      ) {
        return [];
      }
      return [{
        id: `${scopeId}:section:${item.section}`,
        actionId: ACTION_HINT_ACTION.SETTINGS_SECTION,
        label: control.getAttribute("aria-label") || `Open ${item.label} settings`,
        controlKind: "button",
        control,
        anchor: control,
        clipRoots: [...clipRoots, scroller],
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          this.selectedSection !== item.section &&
          this.querySelector(
            `:scope > .settings-navigator-list > button[data-settings-section="${item.section}"]`,
          ) === control &&
          !control.disabled,
        activate: () => {
          control.focus({ preventScroll: true });
          control.click();
        },
      }];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [scroller],
    };
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
              ? `<img class="settings-navigator-brand" src="/assets/brand/${item.brand}" alt="" />`
              : renderInlineIcon(item.icon, "", "settings-navigator-icon")}
            <span>${item.label}</span>
          </button>
        `).join("")}
      </nav>
    `;
    this.syncSelection();
    this.syncCodexStatus();
  }

  syncSelection() {
    this.querySelectorAll("button[data-settings-section]").forEach((button) => {
      const selected = button.dataset.settingsSection === this.selectedSection;
      button.toggleAttribute("aria-current", selected);
    });
  }

  syncCodexStatus() {
    const button = this.querySelector('button[data-settings-section="codex"]');
    if (!button) {
      return;
    }
    const state = codexState(this.codexStatusSnapshotValue);
    const readiness = formatCodexReadiness(this.codexStatusSnapshotValue);
    const label = state === "available"
      ? "Codex — ready"
      : state === "pending"
        ? "Codex — checking readiness"
        : `Codex — ${readiness.toLowerCase()}`;
    button.dataset.codexState = state;
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

customElements.define("caffold-settings-navigator", CaffoldSettingsNavigator);
