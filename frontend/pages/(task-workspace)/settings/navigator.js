import "../components/workspace-brand.js";
import "./navigator/components/item.js";
import {
  emptyActionHintScope,
  mergeActionHintScopes,
} from "#app/action-hint-scope.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  scrollBackToTop,
} from "#app/scroll-scope.js";

// Each brand mark is published in a single color so it can be tinted, and the
// theme tints it through --brand-monochrome-filter.
const ITEMS = [
  { section: "appearance", label: "Appearance", icon: "Palette" },
  { section: "keyboard", label: "Keyboard", icon: "Keyboard" },
  { section: "files", label: "Files", icon: "File" },
  { section: "notifications", label: "Notifications", icon: "Bell" },
  { section: "remote-access", label: "Remote Access", icon: "Link" },
  { section: "voice", label: "Voice Input", icon: "Mic" },
  { section: "jev", label: "Jev Permissions", icon: "ShieldCheck" },
  { section: "codex", label: "Codex", brand: "codex-template@2x.png" },
  { section: "claude", label: "Claude", brand: "claude-template.png" },
  { section: "grok", label: "Grok", brand: "grok-template.png" },
  { section: "about", label: "About Caffold", icon: "Info" },
];

class CaffoldSettingsNavigator extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.selectedSection = "";
    this.updateAvailable = false;
    this.reloadReady = false;
    this.render();
  }

  setSelectedSection(section) {
    this.selectedSection = section ?? "";
    this.syncSelection();
  }

  setCaffoldUpdate(snapshot) {
    this.updateAvailable = snapshot?.status?.updateAvailable === true;
    this.syncUpdateNotice();
  }

  /** Whether this window has a new build ready to load. */
  setUpdateStatus(status) {
    this.reloadReady = status?.preparedUpdate?.ready === true;
    this.syncUpdateNotice();
  }

  actionHintScope({ scopeId = "settings", clipRoots = [] } = {}) {
    if (!this.initialized || this.hidden) {
      return emptyActionHintScope();
    }
    const scroller = this.querySelector(":scope > .settings-navigator-list");
    if (!scroller) {
      return emptyActionHintScope();
    }
    const isCurrent = () => this.isConnected && !this.hidden;
    return mergeActionHintScopes(
      {
        blocked: false,
        targets: [],
        mutationRoots: [this],
        scrollRoots: [scroller],
      },
      ...this.items().map((item) => item.actionHintScope({
        scopeId,
        clipRoots: [...clipRoots, scroller],
        isCurrent,
      })),
    );
  }

  scrollSurfaceScope({
    scopeId = "settings",
    label = "Settings sections",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    if (!this.initialized || this.hidden) {
      return emptyScrollSurfaceScope();
    }
    const scrollport = this.querySelector(":scope > .settings-navigator-list");
    if (!scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:sections:scroll`,
        label,
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(":scope > .settings-navigator-list") ===
            scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  scrollToTop() {
    scrollBackToTop(this.querySelector(":scope > .settings-navigator-list"));
  }

  render() {
    this.innerHTML = `
      <header class="settings-navigator-header">
        <caffold-workspace-brand></caffold-workspace-brand>
      </header>
      <nav class="settings-navigator-list" aria-label="Settings sections"></nav>
    `;
    this.querySelector(":scope > .settings-navigator-list").append(
      ...ITEMS.map((entry) => {
        const item = document.createElement("caffold-settings-navigator-item");
        item.setEntry(entry);
        return item;
      }),
    );
    this.syncSelection();
    this.syncUpdateNotice();
  }

  syncSelection() {
    for (const item of this.items()) {
      item.setSelected(item.section === this.selectedSection);
    }
  }

  // Only the About entry shows that Caffold has an update: a newer release, or
  // a new build this window can load.
  syncUpdateNotice() {
    this.items()
      .find((item) => item.section === "about")
      ?.setUpdateNotice({
        updateAvailable: this.updateAvailable,
        reloadReady: this.reloadReady,
      });
  }

  items() {
    return [...this.querySelectorAll(
      ":scope > .settings-navigator-list > caffold-settings-navigator-item",
    )];
  }
}

customElements.define("caffold-settings-navigator", CaffoldSettingsNavigator);
