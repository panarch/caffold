import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import "./appearance/page.js";
import "./files/page.js";
import "./notifications/page.js";
import "./remote-access/page.js";
import "./codex/page.js";
import "./claude/page.js";
import "./about/page.js";

const TITLES = {
  appearance: "Appearance",
  files: "Files",
  notifications: "Notifications",
  "remote-access": "Remote Access",
  codex: "Codex",
  claude: "Claude",
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
    this.querySelector("caffold-settings-notifications-page")?.deactivate();
    this.querySelector("caffold-settings-remote-access-page")?.deactivate();
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.section = "";
    this.codexStatusSnapshotValue = null;
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
          <caffold-settings-files-page hidden></caffold-settings-files-page>
          <caffold-settings-notifications-page hidden></caffold-settings-notifications-page>
          <caffold-settings-remote-access-page hidden></caffold-settings-remote-access-page>
          <caffold-settings-codex-page hidden></caffold-settings-codex-page>
          <caffold-settings-claude-page hidden></caffold-settings-claude-page>
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
    this.connectedSettingsNavigator?.setCodexStatusSnapshot(
      this.codexStatusSnapshotValue,
    );
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
      files: this.querySelector("caffold-settings-files-page"),
      notifications: this.querySelector("caffold-settings-notifications-page"),
      "remote-access": this.querySelector("caffold-settings-remote-access-page"),
      codex: this.querySelector("caffold-settings-codex-page"),
      claude: this.querySelector("caffold-settings-claude-page"),
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
    if (presentedSection === "notifications") {
      pages.notifications?.activate();
    } else {
      pages.notifications?.deactivate();
    }
    if (presentedSection === "remote-access") {
      pages["remote-access"]?.activate();
    } else {
      pages["remote-access"]?.deactivate();
    }
    pages.appearance?.prepareRoute?.();
    pages.files?.prepareRoute?.();
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

  setCodexStatusSnapshot(snapshot) {
    this.ensureRendered();
    this.codexStatusSnapshotValue = snapshot ?? null;
    this.querySelector("caffold-settings-codex-page").snapshot =
      this.codexStatusSnapshotValue;
    this.connectedSettingsNavigator?.setCodexStatusSnapshot(
      this.codexStatusSnapshotValue,
    );
  }

  setCodexRestartState(state) {
    this.ensureRendered();
    this.querySelector("caffold-settings-codex-page").setRestartState(state);
  }

  setClaudeRestartState(state) {
    this.ensureRendered();
    this.querySelector("caffold-settings-claude-page").setRestartState(state);
  }

  setBuildStatus(health) {
    this.ensureRendered();
    this.querySelector("caffold-settings-about-page").setBuildStatus(health);
  }

  setUpdateStatus(status) {
    this.ensureRendered();
    this.querySelector("caffold-settings-about-page").setUpdateStatus(status);
  }
}

customElements.define("caffold-settings-workspace", CaffoldSettingsWorkspace);
