import { getCodexUpdates } from "../../../../api.js";
import {
  CODEX_RUNTIME_RESTART_REQUEST_EVENT,
  CODEX_RUNTIME_UPDATE_REQUEST_EVENT,
  CODEX_STATUS_REFRESH_REQUEST_EVENT,
  codexRateWindows,
  codexRuntimeRestartAvailable,
  codexRuntimeUpdateAvailable,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatResetCredits,
  formatUsedPercent,
} from "../../codex-status.js";
import "../components/detail-list.js";
import { SETTINGS_REFRESH_INTENT_EVENT } from "../components/refresh-button.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
  linkActionHintTarget,
  mergeActionHintScopes,
} from "../../../../action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "../../../../scroll-scope.js";
import { serviceStatusTargets } from "../service-status.js";

const CODEX_INSTALL_COMMAND = "curl -fsSL https://chatgpt.com/codex/install.sh | sh";
const CODEX_SERVICE_STATUS_URL = "https://status.openai.com";
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
    this.updateState = "idle";
    this.updateMessage = "";
    this.runtimeAction = "idle";
    this.updates = null;
    this.updatesState = "idle";
    this.updatesProblem = "";
    this.updatesOperation = 0;
    this.copyState = "idle";
    this.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('[data-action="open-codex-restart"]')) {
        this.dispatchEvent(
          new CustomEvent(CODEX_RUNTIME_RESTART_REQUEST_EVENT, { bubbles: true }),
        );
        return;
      }
      if (target?.closest('[data-action="open-codex-update"]')) {
        this.dispatchEvent(
          new CustomEvent(CODEX_RUNTIME_UPDATE_REQUEST_EVENT, { bubbles: true }),
        );
        return;
      }
      if (target?.closest('[data-action="copy-codex-install"]')) {
        void this.copyInstallCommand();
      }
    });
    this.addEventListener(SETTINGS_REFRESH_INTENT_EVENT, (event) => {
      event.stopPropagation();
      this.dispatchEvent(
        new CustomEvent(CODEX_STATUS_REFRESH_REQUEST_EVENT, { bubbles: true }),
      );
      void this.reconcileUpdates();
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
    void this.reconcileUpdates();
  }

  deactivate() {
    this.active = false;
    this.updatesOperation += 1;
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
    const before = this.restartState;
    this.restartState = value?.state ?? "idle";
    this.restartMessage = value?.message ?? "";
    if (this.initialized) {
      this.render();
      if (settled(before, this.restartState)) {
        // The report still names the runtime that was just replaced.
        void this.reconcileUpdates();
      }
    }
  }

  setUpdateState(value) {
    const before = this.updateState;
    this.updateState = value?.state ?? "idle";
    this.updateMessage = value?.message ?? "";
    if (this.initialized) {
      this.render();
      if (settled(before, this.updateState)) {
        void this.reconcileUpdates();
      }
    }
  }

  setRuntimeAction(action) {
    this.runtimeAction = action ?? "idle";
    if (this.initialized) {
      this.render();
    }
  }

  /**
   * Reads the update report while the page is shown. The newest release is
   * checked only here, never in the background.
   */
  async reconcileUpdates() {
    if (!this.active) {
      return;
    }
    const operation = ++this.updatesOperation;
    this.updatesState = "loading";
    this.render();
    try {
      const updates = await getCodexUpdates();
      if (operation !== this.updatesOperation) return;
      this.updates = updates;
      this.updatesState = "loaded";
    } catch (error) {
      if (operation !== this.updatesOperation) return;
      this.updates = null;
      this.updatesState = "unavailable";
      this.updatesProblem = error instanceof Error ? error.message : `${error}`;
    }
    this.render();
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

  actionHintScope({
    scopeId = "settings:codex",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const definitions = [
      {
        id: "copy-install-command",
        selector: 'button[data-action="copy-codex-install"]',
      },
      {
        id: "restart-runtime",
        selector: 'button[data-action="open-codex-restart"]',
      },
      {
        id: "update-runtime",
        selector: 'button[data-action="open-codex-update"]',
      },
    ];
    const targetClipRoots = [this, scrollport, ...clipRoots].filter(Boolean);
    const targets = [
      ...serviceStatusTargets(this, {
        scopeId,
        clipRoots: targetClipRoots,
        isCurrent,
      }),
      ...definitions.flatMap(({ id, selector }) => {
        const control = this.querySelector(selector);
        if (
          !control ||
          control.disabled ||
          control.hidden ||
          !hasActionHintLayoutBox(control)
        ) {
          return [];
        }
        return [buttonActionHintTarget({
          invalidationOwner: this,
          id: `${scopeId}:${id}`,
          actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
          label: control.getAttribute("aria-label") ||
            control.textContent?.trim() ||
            id,
          control,
          clipRoots: targetClipRoots,
          isActionable: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.querySelector(selector) === control &&
            !control.disabled &&
            !control.hidden &&
            hasActionHintLayoutBox(control),
        })];
      }),
    ];
    const guide = this.querySelector(
      '.settings-codex-repair a[href]',
    );
    if (
      guide &&
      !guide.hidden &&
      hasActionHintLayoutBox(guide)
    ) {
      targets.push(linkActionHintTarget({
        invalidationOwner: this,
        id: `${scopeId}:official-guide`,
        actionId: ACTION_HINT_ACTION.LINK_OPEN,
        label: "Open Official Codex CLI guide in a new tab",
        control: guide,
        clipRoots: targetClipRoots,
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector('.settings-codex-repair a[href]') === guide &&
          !guide.hidden &&
          hasActionHintLayoutBox(guide),
      }));
    }
    return mergeActionHintScopes(
      this.refreshButton.actionHintScope({
        scopeId,
        clipRoots: targetClipRoots,
        isCurrent: () => this.isConnected && !this.hidden && isCurrent(),
      }),
      {
        blocked: false,
        targets,
        mutationRoots: [this],
        scrollRoots: [scrollport],
      },
    );
  }

  scrollSurfaceScope({
    scopeId = "settings:codex",
    label = "Codex settings",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [{
        id: `${scopeId}:scroll`,
        label,
        scrollport,
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isEligible: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(":scope > .settings-content-scroll") ===
            scrollport &&
          hasScrollLayoutBox(this) &&
          hasScrollLayoutBox(scrollport),
      }],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
  }

  render() {
    if (!this.pageMounted) {
      this.pageMounted = true;
      this.innerHTML = `
        <div class="settings-content-scroll">
          <div class="settings-content-section">
            <header>
              <div>
                <p>Connection, account, plan, and local app-server usage.</p>
                <a class="settings-service-status" href="${CODEX_SERVICE_STATUS_URL}" target="_blank" rel="noreferrer">Service status</a>
              </div>
              <caffold-settings-refresh-button></caffold-settings-refresh-button>
            </header>
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
            <section aria-labelledby="settings-codex-usage-title">
              <h3 id="settings-codex-usage-title">Usage</h3>
              <caffold-settings-detail-list data-codex-usage></caffold-settings-detail-list>
            </section>
            <section aria-labelledby="settings-codex-agent-title">
              <h3 id="settings-codex-agent-title">Agent</h3>
              <caffold-settings-detail-list data-codex-detail></caffold-settings-detail-list>
            </section>
            <section class="settings-runtime-control" aria-labelledby="settings-codex-runtime-title">
              <div>
                <h3 id="settings-codex-runtime-title">Runtime</h3>
                <p data-runtime-summary></p>
              </div>
              <button type="button" data-action="open-codex-restart">Restart runtime…</button>
            </section>
            <p class="settings-runtime-message" data-restart-message role="status" hidden></p>
            <section class="settings-codex-updates" aria-labelledby="settings-codex-updates-title">
              <div>
                <h3 id="settings-codex-updates-title">Updates</h3>
                <p data-updates-summary></p>
                <dl>
                  <div><dt>Latest version</dt><dd data-updates-latest></dd></div>
                  <div><dt>Automatic updates</dt><dd data-updates-automatic></dd></div>
                </dl>
              </div>
              <button type="button" data-action="open-codex-update">Update Codex…</button>
            </section>
            <p class="settings-runtime-message" data-update-message role="status" hidden></p>
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
      this.refreshButton = this.querySelector("caffold-settings-refresh-button");
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
    const canRestart = codexRuntimeRestartAvailable(status);
    const restarting = ["restarting", "refreshing"].includes(
      this.restartState,
    );
    const runtimeBusy = this.runtimeAction !== "idle";
    const runtimeSummary = restartRequired
      ? `Codex ${readiness.managedExecutable?.version ?? "target"} is installed while runtime ${readiness.runningAppServerVersion ?? "another version"} is still running.`
      : readiness?.state === "ready"
        ? "The shared Codex runtime is ready.\nYou can restart it manually after confirmation."
        : "Caffold enables an explicit runtime restart only when the backend reports a supported restart target.";

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

    this.refreshButton.setState({
      refreshing: snapshot?.phase === "checking",
      disabled: runtimeBusy,
    });
    this.querySelector(".settings-runtime-control").dataset.restartEmphasis =
      restartRequired ? "attention" : "neutral";
    const restart = this.querySelector('[data-action="open-codex-restart"]');
    restart.disabled = !canRestart || runtimeBusy;
    restart.textContent = this.restartState === "refreshing"
      ? "Checking…"
      : restarting ? "Restarting…" : "Restart runtime…";
    this.querySelector("[data-runtime-summary]").textContent = runtimeSummary;
    patchMessage(
      this.querySelector("[data-restart-message]"),
      this.restartState,
      this.restartMessage,
    );
    patchUpdates(this, {
      status,
      runtimeBusy,
      updateState: this.updateState,
      updateMessage: this.updateMessage,
      updates: this.updates,
      updatesState: this.updatesState,
      updatesProblem: this.updatesProblem,
    });

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

function settled(before, after) {
  return ["restarting", "updating", "refreshing"].includes(before) &&
    ["succeeded", "failed"].includes(after);
}

function patchMessage(message, state, text) {
  message.hidden = !text;
  message.dataset.state = state;
  message.textContent = text;
}

/**
 * The Update button follows the backend's `update` answer: on when an update
 * would change what runs or when that is unknown, off when Codex is current.
 */
function patchUpdates(root, view) {
  const report = view.updates;
  const availability = view.updatesState === "unavailable"
    ? "unknown"
    : report?.update;
  const updating = ["updating", "refreshing"].includes(view.updateState);
  const update = root.querySelector('[data-action="open-codex-update"]');
  update.disabled = view.runtimeBusy ||
    !codexRuntimeUpdateAvailable(view.status) ||
    !["available", "unknown"].includes(availability);
  update.textContent = view.updateState === "refreshing"
    ? "Checking…"
    : updating ? "Updating…" : "Update Codex…";
  root.querySelector("[data-updates-summary]").textContent =
    updatesSummary(view);
  root.querySelector("[data-updates-latest]").textContent = report
    ? report.latestVersion ?? "Unavailable"
    : view.updatesState === "unavailable" ? "Unavailable" : "Checking…";
  root.querySelector("[data-updates-automatic]").textContent = report
    ? AUTOMATIC_UPDATES_LABEL[report.automaticUpdates] ?? "Unknown"
    : view.updatesState === "unavailable" ? "Unknown" : "Checking…";
  patchMessage(
    root.querySelector("[data-update-message]"),
    view.updateState,
    view.updateMessage,
  );
}

const AUTOMATIC_UPDATES_LABEL = Object.freeze({
  enabled: "On",
  disabled: "Off",
});

function updatesSummary({ updates: report, updatesState, updatesProblem }) {
  if (updatesState === "unavailable") {
    return `Caffold could not check for a Codex update.\n${updatesProblem}`;
  }
  if (!report) {
    return "Checking for updates…";
  }
  const { installedVersion, runningVersion, latestVersion } = report;
  if (report.update === "available") {
    if (installedVersion && runningVersion && installedVersion !== runningVersion) {
      return `Codex ${installedVersion} is installed while the runtime is on ${runningVersion}.`;
    }
    return runningVersion
      ? `Codex ${latestVersion} is available. The runtime is on ${runningVersion}.`
      : `Codex ${latestVersion} is available. Codex ${installedVersion} is installed.`;
  }
  if (report.update === "upToDate") {
    return "Codex is up to date.";
  }
  const reason = report.problems?.latestVersion ?? report.problems?.installation;
  return reason
    ? `Caffold could not check for a Codex update.\n${reason}`
    : "Caffold could not check for a Codex update.";
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
  return codexRateWindows(status).map(({ limitId, limitName, name, window }) => ({
    key: limitId ? `${limitId}:${name}` : name,
    label: limitName
      ? `${formatRateWindowLabel(window, name)} · ${limitName}`
      : formatRateWindowLabel(window, name),
    value: usageWindowValue(window),
  }));
}

/** One window as its row reads: how much is used, and when it lets go. */
function usageWindowValue(window) {
  const used = `${formatUsedPercent(window)} used`;
  const reset = formatRateReset(window);
  return reset === "-" ? used : `${used} · resets ${reset}`;
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
