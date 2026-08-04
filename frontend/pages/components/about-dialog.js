import { BUILD_INFO } from "../../build-info.js";

class CaffoldAboutDialog extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    this.health = null;
    this.addEventListener("click", (event) => this.handleClick(event));
    this.render();
  }

  setBuildStatus(health) {
    this.health = health;
  }

  open() {
    this.render();
    this.querySelector("dialog")?.showModal();
  }

  handleClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    if (button.dataset.action === "close-about") {
      this.querySelector("dialog")?.close();
      return;
    }

    if (button.dataset.action === "copy-diagnostics") {
      this.copyDiagnostics();
    }
  }

  async copyDiagnostics() {
    const status = this.querySelector("[data-about-copy-status]");
    try {
      await navigator.clipboard.writeText(this.diagnosticsText());
      if (status) {
        status.textContent = "Copied";
      }
    } catch {
      if (status) {
        status.textContent = "Copy failed";
      }
    }
  }

  diagnosticsText() {
    const serverId = this.health?.buildId ?? "unavailable";
    return [
      `Caffold ${BUILD_INFO.version}`,
      `UI build: ${BUILD_INFO.id}`,
      `Server build: ${serverId}`,
      `Built: ${buildDate().toISOString()}`,
      `Status: ${buildStatus(this.health).label}`,
    ].join("\n");
  }

  render() {
    const built = buildDate();
    const serverId = this.health?.buildId ?? "Unavailable";
    const status = buildStatus(this.health);

    this.innerHTML = `
      <dialog aria-labelledby="about-caffold-title">
        <article class="about-card">
          <header class="about-header">
            <img src="/assets/icons/caffold-mark.svg" alt="" />
            <div>
              <h1 id="about-caffold-title">Caffold</h1>
              <p>Local workspace and code review</p>
            </div>
          </header>
          <dl class="about-build-details">
            <div>
              <dt>Version</dt>
              <dd data-about-value="version">${escapeHtml(BUILD_INFO.version)}</dd>
            </div>
            <div>
              <dt>UI build</dt>
              <dd><code data-about-value="ui-build">${escapeHtml(BUILD_INFO.id)}</code></dd>
            </div>
            <div>
              <dt>Server build</dt>
              <dd><code data-about-value="server-build">${escapeHtml(serverId)}</code></dd>
            </div>
            <div>
              <dt>Built</dt>
              <dd><time data-about-built datetime="${built.toISOString()}">${escapeHtml(formatBuildDate(built))}</time></dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd><span class="about-build-status" data-status="${status.type}">${status.label}</span></dd>
            </div>
          </dl>
          <footer class="about-actions">
            <span data-about-copy-status role="status" aria-live="polite"></span>
            <button type="button" data-action="copy-diagnostics">Copy diagnostics</button>
            <button type="button" data-action="close-about">Done</button>
          </footer>
        </article>
      </dialog>
    `;
  }
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

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

customElements.define("caffold-about-dialog", CaffoldAboutDialog);
