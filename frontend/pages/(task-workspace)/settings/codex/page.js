import {
  CODEX_RUNTIME_RESTART_REQUEST_EVENT,
  CODEX_STATUS_REFRESH_REQUEST_EVENT,
  findRateWindow,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatRemainingPercent,
  formatResetCredits,
} from "../../codex-status.js";

const CODEX_INSTALL_COMMAND = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const CODEX_SETUP_GUIDE = "https://learn.chatgpt.com/docs/codex/cli";

class CaffoldSettingsCodexPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.snapshotValue = null;
    this.active = false;
    this.restartState = "idle";
    this.restartMessage = "";
    this.copyState = "idle";
    this.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-action="refresh-codex-status"]')) {
        this.dispatchEvent(
          new CustomEvent(CODEX_STATUS_REFRESH_REQUEST_EVENT, { bubbles: true }),
        );
        return;
      }
      if (target?.closest('[data-action="open-codex-restart"]')) {
        this.dispatchEvent(
          new CustomEvent(CODEX_RUNTIME_RESTART_REQUEST_EVENT, { bubbles: true }),
        );
        return;
      }
      if (target?.closest('[data-action="copy-codex-install"]')) {
        void this.copyInstallCommand();
      }
    });
    this.render();
  }

  disconnectedCallback() {
    this.deactivate();
  }

  activate() {
    if (this.active) {
      return;
    }
    this.active = true;
  }

  deactivate() {
    this.active = false;
  }

  set snapshot(value) {
    this.snapshotValue = value ?? null;
    this.copyState = "idle";
    if (this.initialized) {
      this.render();
    }
  }

  get snapshot() {
    return this.snapshotValue ?? null;
  }

  setRestartState(value) {
    this.restartState = value?.state ?? "idle";
    this.restartMessage = value?.message ?? "";
    if (this.initialized) {
      this.render();
    }
  }

  async copyInstallCommand() {
    try {
      await navigator.clipboard.writeText(CODEX_INSTALL_COMMAND);
      this.copyState = "copied";
    } catch {
      this.copyState = "failed";
    }
    this.render();
  }

  render() {
    if (!this.pageMounted) {
      this.pageMounted = true;
      this.innerHTML = `
        <div class="settings-content-scroll">
          <div class="settings-content-section">
            <header>
              <p>Connection, account, plan, and local app-server usage.</p>
              <button type="button" data-action="refresh-codex-status">Refresh</button>
            </header>
            <dl class="settings-details">
              ${detailSlot("readiness", "Readiness")}
              ${detailSlot("connection", "Connection")}
              ${detailSlot("account", "Account")}
              ${detailSlot("plan", "Plan")}
              ${detailSlot("minimum", "Minimum supported")}
              ${detailSlot("detected-version", "Detected version")}
              ${detailSlot("detected-path", "Detected path")}
              ${detailSlot("managed-version", "Managed version")}
              ${detailSlot("managed-path", "Managed path")}
              ${detailSlot("runtime-version", "App-server runtime")}
            </dl>
            <section class="settings-codex-repair" aria-labelledby="settings-codex-repair-title" hidden>
              <div>
                <h3 id="settings-codex-repair-title"></h3>
                <p data-repair-description></p>
              </div>
              <div class="settings-codex-command" hidden>
                <strong>Required official install or update command</strong>
                <code>${CODEX_INSTALL_COMMAND}</code>
                <button type="button" data-action="copy-codex-install">Copy command</button>
              </div>
              <p class="settings-codex-sign-in" hidden><code>codex</code></p>
              <a href="${CODEX_SETUP_GUIDE}" target="_blank" rel="noreferrer" hidden>Official Codex CLI guide</a>
            </section>
            <section class="settings-runtime-control" aria-labelledby="settings-codex-runtime-title">
              <div>
                <h3 id="settings-codex-runtime-title">Runtime</h3>
                <p data-runtime-summary></p>
              </div>
              <button type="button" data-action="open-codex-restart">Restart runtime</button>
            </section>
            <p class="settings-runtime-message" role="status" hidden></p>
            <section class="settings-usage" aria-labelledby="settings-codex-usage-title">
              <h3 id="settings-codex-usage-title">Remaining usage</h3>
              ${usageSlot("primary")}
              ${usageSlot("secondary")}
              <div class="settings-usage-row" data-usage="reset-credits">
                <span>Reset credits</span>
                <strong>-</strong>
                <span></span>
              </div>
            </section>
            <section class="settings-codex-diagnostic" aria-labelledby="settings-codex-diagnostic-title" hidden>
              <h3 id="settings-codex-diagnostic-title">Diagnostic</h3>
              <dl>
                ${detailSlot("reason-code", "Reason code")}
                ${detailSlot("diagnostic-detail", "Detail")}
              </dl>
            </section>
            <p class="settings-status-message" role="alert" hidden></p>
          </div>
        </div>
      `;
    }

    const snapshot = this.snapshot;
    const status = snapshot?.status;
    const readiness = status?.readiness;
    const connection = codexConnection(status);
    const connectionLabel = connection === "pending"
      ? "Checking"
      : connection === "available" ? "Connected" : "Unavailable";
    const restartRequired = readiness?.state === "restartRequired";
    const canRestart = restartRequired;
    const restarting = ["restarting", "refreshing"].includes(
      this.restartState,
    );
    const runtimeSummary = restartRequired
      ? `Codex ${readiness.managedExecutable?.version ?? "target"} is installed while runtime ${readiness.runningAppServerVersion ?? "another version"} is still running.`
      : "Caffold only restarts the shared runtime after an explicit confirmation when the backend reports a stale runtime.";

    const readinessLabel = formatCodexReadiness(snapshot);
    patchDetail(this, "readiness", readinessLabel, readinessState(readiness));
    patchDetail(this, "connection", connectionLabel, connection);
    patchDetail(this, "account", formatCodexAccount(status));
    patchDetail(this, "plan", formatCodexPlan(status));
    patchDetail(this, "minimum", readiness?.minimumSupportedVersion ?? "Unknown");
    patchDetail(this, "detected-version", readiness?.detectedExecutable?.version ?? "Not detected");
    patchDetail(this, "detected-path", readiness?.detectedExecutable?.path ?? "Not detected");
    patchDetail(this, "managed-version", readiness?.managedExecutable?.version ?? "Not available");
    patchDetail(this, "managed-path", readiness?.managedExecutable?.path ?? "Not available");
    patchDetail(this, "runtime-version", readiness?.runningAppServerVersion ?? "Not running");
    patchRepairSurface(this, readiness, readinessLabel, this.copyState);

    const refresh = this.querySelector('[data-action="refresh-codex-status"]');
    refresh.disabled = restarting;
    const restart = this.querySelector('[data-action="open-codex-restart"]');
    restart.disabled = !canRestart || restarting;
    restart.textContent = this.restartState === "refreshing"
      ? "Checking…"
      : restarting ? "Restarting…" : "Restart runtime";
    this.querySelector("[data-runtime-summary]").textContent = runtimeSummary;
    const restartMessage = this.querySelector(".settings-runtime-message");
    restartMessage.hidden = !this.restartMessage;
    restartMessage.dataset.state = this.restartState;
    restartMessage.textContent = this.restartMessage;

    patchUsage(this, status, "primary");
    patchUsage(this, status, "secondary");
    this.querySelector('[data-usage="reset-credits"] strong').textContent =
      formatResetCredits(status);

    const diagnostic = this.querySelector(".settings-codex-diagnostic");
    diagnostic.hidden = !readiness?.diagnosticMessage;
    patchDetail(this, "reason-code", readiness?.reasonCode ?? "unknown");
    patchDetail(this, "diagnostic-detail", readiness?.diagnosticMessage ?? "");
    const loadError = this.querySelector(".settings-status-message");
    const loadErrorMessage = snapshot?.phase === "failed"
      ? snapshot.error
      : "";
    loadError.hidden = !loadErrorMessage;
    loadError.textContent = loadErrorMessage;
  }
}

function codexConnection(status) {
  if (!status?.readiness) {
    return "pending";
  }
  return status?.diagnostics?.processConnected ? "available" : "unavailable";
}

function readinessState(readiness) {
  if (!readiness) {
    return "pending";
  }
  if (readiness.state === "ready") {
    return "available";
  }
  if (["missing", "unsupportedInstall", "updateRequired", "signInRequired", "restartRequired"].includes(readiness.state)) {
    return "attention";
  }
  return "unavailable";
}

function detailSlot(name, label) {
  return `<div data-detail="${name}"><dt>${label}</dt><dd></dd></div>`;
}

function patchDetail(root, name, value, state = "") {
  const detail = root.querySelector(`[data-detail="${name}"] dd`);
  detail.textContent = value;
  if (state) {
    detail.dataset.state = state;
  } else {
    delete detail.dataset.state;
  }
}

function usageSlot(name) {
  return `<div class="settings-usage-row" data-usage="${name}">
    <span></span>
    <strong>-</strong>
    <time>-</time>
  </div>`;
}

function patchUsage(root, status, name) {
  const window = findRateWindow(status?.rateLimits, name);
  const row = root.querySelector(`[data-usage="${name}"]`);
  row.querySelector("span").textContent = formatRateWindowLabel(window, name);
  row.querySelector("strong").textContent = formatRemainingPercent(window);
  row.querySelector("time").textContent = formatRateReset(window);
}

function patchRepairSurface(root, readiness, readinessLabel, copyState) {
  const repair = root.querySelector(".settings-codex-repair");
  const visible = Boolean(readiness && readiness.state !== "ready");
  repair.hidden = !visible;
  if (!visible) {
    return;
  }
  const install = ["missing", "unsupportedInstall", "updateRequired"].includes(readiness.state);
  const signIn = readiness.state === "signInRequired";
  const copyLabel = copyState === "copied"
    ? "Copied"
    : copyState === "failed" ? "Copy failed" : "Copy command";
  const description = readiness.reasonCode === "appServerCommandsUnavailable"
    ? "The detected CLI lacks the app-server daemon commands Caffold uses to manage Task connections. Install or update the official standalone CLI with the required command below."
    : {
      missing: "Caffold Tasks require the official standalone CLI because it includes the app-server daemon commands used for managed connections. Install it below, then run codex and sign in.",
      unsupportedInstall: "This installation does not provide a supported app-server daemon. Install the official standalone CLI with the required command below.",
      updateRequired: "Update the official standalone CLI with the required command below. Caffold rejects older versions before starting the app-server daemon.",
      signInRequired: "Run codex in a terminal and complete sign-in, then refresh this page.",
      restartRequired: "Confirm a shared runtime restart below to use the installed Codex version.",
      incompatible: "The installed version passed the minimum check, but the required app-server protocol did not initialize.",
      error: "Retry the readiness check. The diagnostic below can help identify an unclassified runtime failure.",
    }[readiness.state] ?? "Refresh the canonical Codex readiness diagnosis.";
  repair.querySelector("h3").textContent = readinessLabel;
  repair.querySelector("[data-repair-description]").textContent = description;
  const command = repair.querySelector(".settings-codex-command");
  command.hidden = !install;
  command.querySelector("button").textContent = copyLabel;
  repair.querySelector(".settings-codex-sign-in").hidden = !signIn;
  repair.querySelector("a").hidden = !(install || signIn);
}

customElements.define("caffold-settings-codex-page", CaffoldSettingsCodexPage);
