import { escapeHtml } from "../../../../components/dom.js";
import { restartCodexRuntime } from "../../../../api.js";
import {
  CODEX_RUNTIME_RESTART_CONFIRMED_EVENT,
} from "./components/runtime-restart-dialog.js";
import {
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
    this.restartState = "idle";
    this.restartMessage = "";
    this.addEventListener("click", (event) => {
      if (event.target.closest('[data-action="refresh-codex-status"]')) {
        this.dispatchEvent(
          new CustomEvent("caffold:refresh-codex-status", { bubbles: true }),
        );
        return;
      }
      if (event.target.closest('[data-action="open-codex-restart"]')) {
        this.querySelector("caffold-codex-runtime-restart-dialog")?.open();
      }
    });
    this.addEventListener(CODEX_RUNTIME_RESTART_CONFIRMED_EVENT, (event) => {
      event.stopPropagation();
      void this.restartRuntime();
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

  async restartRuntime() {
    if (this.restartState === "pending") {
      return;
    }
    this.restartState = "pending";
    this.restartMessage = "";
    this.render();

    try {
      await restartCodexRuntime();
      this.restartState = "succeeded";
      this.restartMessage = "Codex runtime restarted.";
      this.render();
      this.dispatchEvent(
        new CustomEvent("caffold:refresh-codex-status", { bubbles: true }),
      );
    } catch (error) {
      this.restartState = "failed";
      this.restartMessage = error.message;
      this.render();
    }
  }

  render() {
    const status = this.status;
    const connection = codexConnection(status);
    const connectionLabel = connection === "pending"
      ? "Checking"
      : connection === "available" ? "Connected" : "Unavailable";
    const cliVersion = codexCliVersion(status);
    const runtimeVersion = codexRuntimeVersion(status);
    const targetVersion = codexTargetRuntimeVersion(status);
    const restartRequired = runtimeRestartRequired(status);
    const canRestart = Boolean(status) && status?.codexCliAvailable !== false;
    const restarting = this.restartState === "pending";
    const runtimeSummary = restartRequired
      ? `Codex ${targetVersion} is installed while runtime ${runtimeVersion} is still running.`
      : "Restart the shared runtime when Codex has been updated or its connection needs recovery.";

    this.innerHTML = `
      <div class="settings-content-scroll">
        <section class="settings-content-section" aria-labelledby="settings-codex-title">
          <header>
            <div>
              <h2 id="settings-codex-title">Codex</h2>
              <p>Connection, account, plan, and local app-server usage.</p>
            </div>
            <button type="button" data-action="refresh-codex-status"${restarting ? " disabled" : ""}>Refresh</button>
          </header>
          <dl class="settings-details">
            ${detail("Connection", connectionLabel, connection)}
            ${detail("Account", formatCodexAccount(status))}
            ${detail("Plan", formatCodexPlan(status))}
            ${detail("Codex CLI", cliVersion ?? availability(status?.codexCliAvailable))}
            ${detail("App-server runtime", runtimeVersion ?? availability(status?.appServerAvailable))}
            ${restartRequired ? detail("Runtime state", "Restart required", "restart-required") : ""}
          </dl>
          <section class="settings-runtime-control" aria-labelledby="settings-codex-runtime-title">
            <div>
              <h3 id="settings-codex-runtime-title">Runtime</h3>
              <p>${escapeHtml(runtimeSummary)}</p>
            </div>
            <button
              type="button"
              data-action="open-codex-restart"
              ${!canRestart || restarting ? "disabled" : ""}
            >${restarting ? "Restarting…" : "Restart runtime"}</button>
          </section>
          ${this.restartMessage
            ? `<p class="settings-runtime-message" data-state="${escapeHtml(this.restartState)}" role="status">${escapeHtml(this.restartMessage)}</p>`
            : ""}
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
      <caffold-codex-runtime-restart-dialog></caffold-codex-runtime-restart-dialog>
    `;
  }
}

function codexCliVersion(status) {
  return status?.daemon?.cliVersion ?? status?.daemon?.managedCodexVersion ?? null;
}

function codexRuntimeVersion(status) {
  return status?.daemon?.appServerVersion ?? status?.diagnostics?.codexCliVersion ?? null;
}

function codexTargetRuntimeVersion(status) {
  return status?.daemon?.managedCodexVersion ?? status?.daemon?.cliVersion ?? null;
}

function codexConnection(status) {
  if (!status) {
    return "pending";
  }
  const connected = status?.diagnostics?.processConnected ?? status?.appServerAvailable;
  return connected ? "available" : "unavailable";
}

function runtimeRestartRequired(status) {
  const target = codexTargetRuntimeVersion(status);
  const running = status?.daemon?.appServerVersion;
  return Boolean(target && running && target !== running);
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
