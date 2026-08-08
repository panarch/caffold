import { escapeHtml } from "../../../../components/dom.js";
import {
  codexState,
  findRateWindow,
  formatCodexAccount,
  formatCodexPlan,
  formatRateReset,
  formatRateWindowLabel,
  formatRemainingPercent,
  formatResetCredits,
} from "../../../components/header-actions/codex-status-model.js";

class CaffoldSettingsCodexPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.statusValue = null;
    this.addEventListener("click", (event) => {
      if (event.target.closest('[data-action="refresh-codex-status"]')) {
        this.dispatchEvent(
          new CustomEvent("caffold:refresh-codex-status", { bubbles: true }),
        );
      }
    });
    this.render();
  }

  set status(value) {
    this.statusValue = value ?? null;
    if (this.initialized) {
      this.render();
    }
  }

  get status() {
    return this.statusValue ?? null;
  }

  render() {
    const status = this.status;
    const state = codexState(status);
    const stateLabel = state === "pending"
      ? "Checking"
      : state === "available" ? "Connected" : "Unavailable";

    this.innerHTML = `
      <div class="settings-content-scroll">
        <section class="settings-content-section" aria-labelledby="settings-codex-title">
          <header>
            <div>
              <h2 id="settings-codex-title">Codex</h2>
              <p>Connection, account, plan, and local app-server usage.</p>
            </div>
            <button type="button" data-action="refresh-codex-status">Refresh</button>
          </header>
          <dl class="settings-details">
            ${detail("Status", stateLabel, state)}
            ${detail("Account", formatCodexAccount(status))}
            ${detail("Plan", formatCodexPlan(status))}
            ${detail("Codex CLI", availability(status?.codexCliAvailable))}
            ${detail("App server", availability(status?.appServerAvailable))}
          </dl>
          <section class="settings-usage" aria-labelledby="settings-codex-usage-title">
            <h3 id="settings-codex-usage-title">Remaining usage</h3>
            ${usage(status, "primary")}
            ${usage(status, "secondary")}
            <div class="settings-usage-row">
              <span>Reset credits</span>
              <strong>${escapeHtml(formatResetCredits(status))}</strong>
              <span></span>
            </div>
          </section>
          ${status?.message ? `<p class="settings-status-message">${escapeHtml(status.message)}</p>` : ""}
        </section>
      </div>
    `;
  }
}

function detail(label, value, state = "") {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd${state ? ` data-state="${escapeHtml(state)}"` : ""}>${escapeHtml(value)}</dd>
    </div>
  `;
}

function usage(status, name) {
  const window = findRateWindow(status?.rateLimits, name);
  return `
    <div class="settings-usage-row">
      <span>${escapeHtml(formatRateWindowLabel(window, name))}</span>
      <strong>${escapeHtml(formatRemainingPercent(window))}</strong>
      <time>${escapeHtml(formatRateReset(window))}</time>
    </div>
  `;
}

function availability(value) {
  return value === true ? "Available" : value === false ? "Unavailable" : "Unknown";
}

customElements.define("caffold-settings-codex-page", CaffoldSettingsCodexPage);
