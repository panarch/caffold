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
import "../components/detail-list.js";

const CODEX_INSTALL_COMMAND = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const CODEX_SETUP_GUIDE = "https://learn.chatgpt.com/docs/codex/cli";
const CONNECTION_PRESENTATION = Object.freeze({
  pending: Object.freeze({ label: "Checking", state: "" }),
  available: Object.freeze({ label: "Connected", state: "positive" }),
  unavailable: Object.freeze({ label: "Unavailable", state: "negative" }),
});

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
            <caffold-settings-detail-list data-codex-detail></caffold-settings-detail-list>
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
              <caffold-settings-detail-list data-codex-usage></caffold-settings-detail-list>
            </section>
            <section class="settings-codex-diagnostic" aria-labelledby="settings-codex-diagnostic-title" hidden>
              <h3 id="settings-codex-diagnostic-title">Diagnostic</h3>
              <dl>
                <div><dt>Reason code</dt><dd data-diagnostic-reason></dd></div>
                <div><dt>Detail</dt><dd data-diagnostic-detail></dd></div>
              </dl>
            </section>
            <p class="settings-status-message" role="alert" hidden></p>
          </div>
        </div>
      `;
      this.detailList = this.querySelector("[data-codex-detail]");
      this.usageList = this.querySelector("[data-codex-usage]");
    }

    const snapshot = this.snapshot;
    const status = snapshot?.status;
    const readiness = status?.readiness;
    // Readiness and Connection report the check itself, so they always answer.
    // Every other row on the page is unknown until that check comes back, and
    // holds its place rather than reporting an install or a limit nobody
    // looked for.
    const answered = (value) => (readiness ? value : undefined);
    const connection = CONNECTION_PRESENTATION[codexConnection(status)];
    const restartRequired = readiness?.state === "restartRequired";
    const canRestart = restartRequired;
    const restarting = ["restarting", "refreshing"].includes(
      this.restartState,
    );
    const runtimeSummary = restartRequired
      ? `Codex ${readiness.managedExecutable?.version ?? "target"} is installed while runtime ${readiness.runningAppServerVersion ?? "another version"} is still running.`
      : "Caffold only restarts the shared runtime after an explicit confirmation when the backend reports a stale runtime.";

    const readinessLabel = formatCodexReadiness(snapshot);
    this.detailList.setRows([
      {
        key: "readiness",
        label: "Readiness",
        value: readinessLabel,
        state: readinessState(readiness),
      },
      {
        key: "connection",
        label: "Connection",
        value: connection.label,
        state: connection.state,
      },
      { key: "account", label: "Account", value: answered(formatCodexAccount(status)) },
      { key: "plan", label: "Plan", value: answered(formatCodexPlan(status)) },
      {
        key: "minimum",
        label: "Minimum supported",
        value: answered(readiness?.minimumSupportedVersion ?? "Unknown"),
      },
      {
        key: "detected-version",
        label: "Detected version",
        value: answered(readiness?.detectedExecutable?.version ?? "Not detected"),
      },
      {
        key: "detected-path",
        label: "Detected path",
        value: answered(readiness?.detectedExecutable?.path ?? "Not detected"),
      },
      {
        key: "managed-version",
        label: "Managed version",
        value: answered(readiness?.managedExecutable?.version ?? "Not available"),
      },
      {
        key: "managed-path",
        label: "Managed path",
        value: answered(readiness?.managedExecutable?.path ?? "Not available"),
      },
      {
        key: "runtime-version",
        label: "App-server runtime",
        value: answered(readiness?.runningAppServerVersion ?? "Not running"),
      },
    ]);
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

    this.usageList.setRows([
      ...usageWindowRows(status),
      {
        key: "reset-credits",
        label: "Reset credits",
        value: answered(formatResetCredits(status)),
      },
    ]);

    const diagnostic = this.querySelector(".settings-codex-diagnostic");
    diagnostic.hidden = !readiness?.diagnosticMessage;
    this.querySelector("[data-diagnostic-reason]").textContent =
      readiness?.reasonCode ?? "unknown";
    this.querySelector("[data-diagnostic-detail]").textContent =
      readiness?.diagnosticMessage ?? "";
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
    return "";
  }
  if (readiness.state === "ready") {
    return "positive";
  }
  if (["missing", "unsupportedInstall", "updateRequired", "signInRequired", "restartRequired"].includes(readiness.state)) {
    return "attention";
  }
  return "negative";
}

/** Only the windows Codex reported get a row; the rest were never metered. */
function usageWindowRows(status) {
  return ["primary", "secondary"]
    .map((name) => [name, findRateWindow(status?.rateLimits, name)])
    .filter(([, window]) => window)
    .map(([name, window]) => ({
      key: name,
      label: formatRateWindowLabel(window, name),
      value: usageWindowValue(window),
    }));
}

/** One window as its row reads: how much is left, and when it lets go. */
function usageWindowValue(window) {
  const remaining = `${formatRemainingPercent(window)} left`;
  const reset = formatRateReset(window);
  return reset === "-" ? remaining : `${remaining} · resets ${reset}`;
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
