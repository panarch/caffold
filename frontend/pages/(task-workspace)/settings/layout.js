import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import "./appearance/page.js";
import "./codex/page.js";
import "./about/page.js";

const TITLES = {
  appearance: "Appearance",
  codex: "Codex",
  about: "About Caffold",
};
const SETTINGS_MASTER_DETAIL_MEDIA_QUERY = "(min-width: 900px)";

class CaffoldSettingsWorkspace extends HTMLElement {
  connectedCallback() {
    this.boundIconsReady ??= () => this.renderBackIcon();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.ensureRendered();
    this.attachResponsiveListener();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
    this.detachResponsiveListener();
    this.querySelector("caffold-settings-codex-page")?.deactivate();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.section = "";
    this.masterDetailMedia = window.matchMedia(
      SETTINGS_MASTER_DETAIL_MEDIA_QUERY,
    );
    this.boundResponsiveChange = () => this.syncPresentation();
    this.responsiveListenerAttached = false;
    this.boundSettingsNavigatorIntent = (event) => {
      event.stopPropagation();
      this.requestSection(event.detail?.section);
    };
    this.innerHTML = `
      <div class="settings-workspace-surface">
        <div
          class="settings-workspace-detail-pane"
          role="region"
          aria-labelledby="settings-workspace-title"
        >
          <header class="settings-workspace-detail-header" hidden>
            <button
              type="button"
              data-action="back-to-settings"
              title="Back to settings"
              aria-label="Back to settings"
            >
              <span data-settings-back-icon>
                ${renderInlineIcon("ArrowLeft", "Back to settings", "settings-workspace-back-icon")}
              </span>
            </button>
            <h1 id="settings-workspace-title"></h1>
          </header>
          <caffold-settings-appearance-page hidden></caffold-settings-appearance-page>
          <caffold-settings-codex-page hidden></caffold-settings-codex-page>
          <caffold-settings-about-page hidden></caffold-settings-about-page>
        </div>
      </div>
    `;
    this.querySelector('[data-action="back-to-settings"]')?.addEventListener(
      "click",
      () => this.requestSection(""),
    );
    warmIcons();
    this.prepareRoute({ kind: "settings", section: "" });
  }

  connectSettingsNavigator(navigator) {
    this.ensureRendered();
    if (this.connectedSettingsNavigator === navigator) {
      return;
    }
    this.connectedSettingsNavigator?.removeEventListener(
      "caffold:settings-navigator-intent",
      this.boundSettingsNavigatorIntent,
    );
    this.connectedSettingsNavigator = navigator ?? null;
    this.connectedSettingsNavigator?.addEventListener(
      "caffold:settings-navigator-intent",
      this.boundSettingsNavigatorIntent,
    );
    this.connectedSettingsNavigator?.setSelectedSection(this.section);
  }

  attachResponsiveListener() {
    if (this.responsiveListenerAttached) {
      return;
    }
    this.responsiveListenerAttached = true;
    this.masterDetailMedia.addEventListener(
      "change",
      this.boundResponsiveChange,
    );
  }

  detachResponsiveListener() {
    if (!this.responsiveListenerAttached) {
      return;
    }
    this.responsiveListenerAttached = false;
    this.masterDetailMedia.removeEventListener(
      "change",
      this.boundResponsiveChange,
    );
  }

  renderBackIcon() {
    const target = this.querySelector("[data-settings-back-icon]");
    if (target) {
      target.innerHTML = renderInlineIcon(
        "ArrowLeft",
        "Back to settings",
        "settings-workspace-back-icon",
      );
    }
  }

  prepareRoute(route) {
    this.ensureRendered();
    this.section = route?.kind === "settings" ? route.section ?? "" : "";
    this.syncPresentation();
  }

  syncPresentation() {
    const presentedSection =
      this.section || (this.masterDetailMedia.matches ? "appearance" : "");
    this.dataset.settingsView = presentedSection ? "detail" : "list";
    this.connectedSettingsNavigator?.setSelectedSection(
      presentedSection,
    );

    const header = this.querySelector(".settings-workspace-detail-header");
    header.hidden = !presentedSection;
    header.querySelector("h1").textContent =
      TITLES[presentedSection] ?? "Settings";

    const pages = {
      appearance: this.querySelector("caffold-settings-appearance-page"),
      codex: this.querySelector("caffold-settings-codex-page"),
      about: this.querySelector("caffold-settings-about-page"),
    };
    for (const [section, page] of Object.entries(pages)) {
      page.hidden = section !== presentedSection;
    }
    if (presentedSection === "codex") {
      pages.codex?.activate();
    } else {
      pages.codex?.deactivate();
    }
    pages.appearance?.prepareRoute?.();
    this.dispatchEvent(
      new CustomEvent("caffold:settings-presentation-change", {
        bubbles: true,
      }),
    );
  }

  requestSection(section) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-settings-route", {
        bubbles: true,
        detail: { route: { kind: "settings", section: section ?? "" } },
      }),
    );
  }

  setBuildStatus(health) {
    this.ensureRendered();
    this.querySelector("caffold-settings-about-page").setBuildStatus(health);
  }
}

customElements.define("caffold-settings-workspace", CaffoldSettingsWorkspace);
