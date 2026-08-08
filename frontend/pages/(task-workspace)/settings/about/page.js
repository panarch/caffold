import { BUILD_INFO } from "../../../../build-info.js";
import { escapeHtml } from "../../../../components/dom.js";

class CaffoldSettingsAboutPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.healthValue = null;
    this.addEventListener("click", (event) => {
      if (event.target.closest('[data-action="copy-diagnostics"]')) {
        void this.copyDiagnostics();
      }
    });
    this.render();
  }

  setBuildStatus(health) {
    this.healthValue = health ?? null;
    if (this.initialized) {
      this.render();
    }
  }

  async copyDiagnostics() {
    const status = this.querySelector("[data-about-copy-status]");
    try {
      await navigator.clipboard.writeText(this.diagnosticsText());
      status.textContent = "Copied";
    } catch {
      status.textContent = "Copy failed";
    }
  }

  diagnosticsText() {
    return [
      `Caffold ${BUILD_INFO.version}`,
      `UI build: ${BUILD_INFO.id}`,
      `Server build: ${this.healthValue?.buildId ?? "unavailable"}`,
      `Built: ${buildDate().toISOString()}`,
      `Status: ${buildStatus(this.healthValue).label}`,
    ].join("\n");
  }

  render() {
    const built = buildDate();
    const status = buildStatus(this.healthValue);
    this.innerHTML = `
      <div class="settings-content-scroll">
        <section class="settings-content-section" aria-labelledby="settings-about-title">
          <header class="settings-about-heading">
            <img src="/assets/icons/caffold-mark.svg" alt="" />
            <div>
              <h2 id="settings-about-title">About Caffold</h2>
              <p>Local workspace and code review</p>
            </div>
          </header>
          <dl class="settings-details">
            ${detail("Version", BUILD_INFO.version)}
            ${detail("UI build", BUILD_INFO.id, true)}
            ${detail("Server build", this.healthValue?.buildId ?? "Unavailable", true)}
            ${detail("Built", formatBuildDate(built), false, built.toISOString())}
            ${detail("Status", status.label, false, "", status.type)}
          </dl>
          <footer class="settings-about-actions">
            <span data-about-copy-status role="status" aria-live="polite"></span>
            <button type="button" data-action="copy-diagnostics">Copy diagnostics</button>
          </footer>
        </section>
      </div>
    `;
  }
}

function detail(label, value, code = false, datetime = "", state = "") {
  const content = datetime
    ? `<time datetime="${escapeHtml(datetime)}">${escapeHtml(value)}</time>`
    : code ? `<code>${escapeHtml(value)}</code>` : escapeHtml(value);
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd${state ? ` data-state="${escapeHtml(state)}"` : ""}>${content}</dd>
    </div>
  `;
}

function buildDate() {
  return new Date(Number(BUILD_INFO.number) * 1000);
}

function formatBuildDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(date);
}

function buildStatus(health) {
  if (!health?.buildId) {
    return { type: "unavailable", label: "Server unavailable" };
  }
  if (health.buildId !== BUILD_INFO.id) {
    return { type: "mismatch", label: "Reload required" };
  }
  return { type: "current", label: "Current" };
}

customElements.define("caffold-settings-about-page", CaffoldSettingsAboutPage);
