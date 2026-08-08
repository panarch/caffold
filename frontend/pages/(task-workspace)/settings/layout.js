import { renderInlineIcon, warmIcons } from "../../../components/icons.js";
import "./navigator.js";
import "./appearance/page.js";
import "./codex/page.js";
import "./about/page.js";

const TITLES = {
  appearance: "Appearance",
  codex: "Codex",
  about: "About Caffold",
};

class CaffoldSettingsWorkspace extends HTMLElement {
  connectedCallback() {
    this.boundIconsReady ??= () => this.renderBackIcon();
    window.addEventListener("caffold:icons-ready", this.boundIconsReady);
    this.ensureRendered();
  }

  disconnectedCallback() {
    window.removeEventListener("caffold:icons-ready", this.boundIconsReady);
  }

  ensureRendered() {
    if (this.rendered) {
      return;
    }
    this.rendered = true;
    this.section = "";
    this.innerHTML = `
      <section class="settings-workspace-surface" aria-label="Settings">
        <div class="settings-workspace-master-detail">
          <aside class="settings-workspace-list-pane" aria-label="Settings list">
            <caffold-settings-navigator></caffold-settings-navigator>
          </aside>
          <main class="settings-workspace-detail-pane" aria-label="Settings content">
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
              <h1></h1>
            </header>
            <div class="settings-workspace-empty">
              <p>Select a setting to inspect it.</p>
            </div>
            <caffold-settings-appearance-page hidden></caffold-settings-appearance-page>
            <caffold-settings-codex-page hidden></caffold-settings-codex-page>
            <caffold-settings-about-page hidden></caffold-settings-about-page>
          </main>
        </div>
      </section>
    `;
    this.addEventListener("caffold:settings-navigator-intent", (event) => {
      event.stopPropagation();
      this.requestSection(event.detail?.section);
    });
    this.querySelector('[data-action="back-to-settings"]')?.addEventListener(
      "click",
      () => this.requestSection(""),
    );
    warmIcons();
    this.prepareRoute({ kind: "settings", section: "" });
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
    this.dataset.settingsView = this.section ? "detail" : "list";
    this.querySelector("caffold-settings-navigator")?.setSelectedSection(this.section);

    const header = this.querySelector(".settings-workspace-detail-header");
    header.hidden = !this.section;
    header.querySelector("h1").textContent = TITLES[this.section] ?? "Settings";
    this.querySelector(".settings-workspace-empty").hidden = Boolean(this.section);

    const pages = {
      appearance: this.querySelector("caffold-settings-appearance-page"),
      codex: this.querySelector("caffold-settings-codex-page"),
      about: this.querySelector("caffold-settings-about-page"),
    };
    for (const [section, page] of Object.entries(pages)) {
      page.hidden = section !== this.section;
    }
    pages.appearance?.prepareRoute?.();
  }

  requestSection(section) {
    this.dispatchEvent(
      new CustomEvent("caffold:request-settings-route", {
        bubbles: true,
        detail: { route: { kind: "settings", section: section ?? "" } },
      }),
    );
  }

  setCodexStatus(status) {
    this.ensureRendered();
    this.querySelector("caffold-settings-codex-page").status = status;
  }

  setBuildStatus(health) {
    this.ensureRendered();
    this.querySelector("caffold-settings-about-page").setBuildStatus(health);
  }
}

customElements.define("caffold-settings-workspace", CaffoldSettingsWorkspace);
