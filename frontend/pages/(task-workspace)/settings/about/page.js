import { BUILD_INFO } from "#app/build-info.js";
import { getCodexMcpDiagnostics } from "#app/api.js";
import { showLoadingText } from "#components/loading-text.js";
import "../components/detail-list.js";
import {
  ACTION_HINT_ACTION,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
} from "#app/scroll-scope.js";

/** Asks the workspace to open the update Task dialog. */
export const CAFFOLD_UPDATE_TASK_REQUEST_EVENT = "caffold:caffold-update-task-request";

class CaffoldSettingsAboutPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.copyingDiagnostics = false;
    this.healthValue = null;
    this.caffoldUpdateValue = { checking: true, status: null, error: null };
    this.updateStatusValue = {
      state: "checking",
      preparedUpdate: { ready: false, buildId: null },
      diagnostics: emptyUpdateDiagnostics(),
    };
    this.addEventListener("click", (event) => {
      if (event.target.closest('[data-action="copy-diagnostics"]')) {
        void this.copyDiagnostics();
      }
      const update = event.target.closest('[data-action="update-caffold"]');
      if (update && !update.disabled) {
        this.dispatchEvent(
          new CustomEvent(CAFFOLD_UPDATE_TASK_REQUEST_EVENT, {
            bubbles: true,
            composed: true,
            detail: { opener: update },
          }),
        );
      }
      if (event.target.closest('[data-action="reload-update"]')) {
        this.dispatchEvent(
          new CustomEvent("caffold:update-reload", {
            bubbles: true,
            composed: true,
          }),
        );
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

  /** Whether a newer Caffold exists, and how the last update ended. */
  setCaffoldUpdate(snapshot) {
    this.caffoldUpdateValue = snapshot ?? {
      checking: true,
      status: null,
      error: null,
    };
    if (this.initialized) {
      this.render();
    }
  }

  setUpdateStatus(status) {
    this.updateStatusValue = {
      state: ["checking", "ready", "settled"].includes(status?.state)
        ? status.state
        : "checking",
      preparedUpdate: {
        ready: Boolean(status?.preparedUpdate?.ready),
        buildId:
          typeof status?.preparedUpdate?.buildId === "string" &&
          status.preparedUpdate.buildId
            ? status.preparedUpdate.buildId
            : null,
      },
      diagnostics: normalizeUpdateDiagnostics(status?.diagnostics),
    };
    if (this.initialized) {
      this.render();
    }
  }

  async copyDiagnostics() {
    if (this.copyingDiagnostics) {
      return;
    }
    this.copyingDiagnostics = true;
    const status = this.querySelector("[data-about-copy-status]");
    const action = this.querySelector('[data-action="copy-diagnostics"]');
    action.disabled = true;
    status.textContent = "Collecting…";
    let codexMcpDiagnostics;
    try {
      codexMcpDiagnostics = await getCodexMcpDiagnostics();
    } catch (error) {
      codexMcpDiagnostics = {
        available: false,
        processGeneration: null,
        appServerVersion: null,
        threads: [],
        error: error instanceof Error ? error.message : "Request failed.",
      };
    }
    try {
      await navigator.clipboard.writeText(
        this.diagnosticsText(codexMcpDiagnostics),
      );
      status.textContent = "Copied";
    } catch {
      status.textContent = "Copy failed";
    } finally {
      action.disabled = false;
      this.copyingDiagnostics = false;
    }
  }

  diagnosticsText(codexMcpDiagnostics = null) {
    const diagnostics = this.updateStatusValue.diagnostics;
    return [
      `Caffold ${BUILD_INFO.version}`,
      `UI build: ${BUILD_INFO.id}`,
      `Server build: ${this.healthValue?.buildId ?? "unavailable"}`,
      `Built: ${buildDate().toISOString()}`,
      ...caffoldUpdateDiagnosticLines(this.caffoldUpdateValue, this.healthValue),
      `Status: ${buildStatus(this.healthValue, this.updateStatusValue).label}`,
      `Update lifecycle: ${this.updateStatusValue.state}`,
      `Prepared update: ${this.updateStatusValue.preparedUpdate.ready ? "ready" : "none"}`,
      `Update handoff: ${diagnostics.handoffNode ?? "none"}`,
      `Update target: ${diagnostics.targetBuildId ?? "none"}`,
      `Service Worker controller: ${diagnostics.controllerBuildId ?? "none"}`,
      `Service Worker active: ${diagnostics.activeBuildId ?? "none"}`,
      `Service Worker waiting: ${diagnostics.waitingBuildId ?? "none"}`,
      `Update navigation attempts: ${diagnostics.navigationAttemptCount}`,
      `Last update navigation target: ${diagnostics.lastNavigationAttemptBuildId ?? "none"}`,
      ...codexMcpDiagnosticLines(codexMcpDiagnostics),
    ].join("\n");
  }

  actionHintScope({
    scopeId = "settings:about",
    clipRoots = [],
    isCurrent = () => true,
  } = {}) {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const definitions = [
      {
        id: "update-caffold",
        selector: 'button[data-action="update-caffold"]',
      },
      {
        id: "reload-update",
        selector: 'button[data-action="reload-update"]',
      },
      {
        id: "copy-diagnostics",
        selector: 'button[data-action="copy-diagnostics"]',
      },
    ];
    const targets = definitions.flatMap(({ id, selector }) => {
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
        clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
        isActionable: () =>
          this.isConnected &&
          !this.hidden &&
          isCurrent() &&
          this.querySelector(selector) === control &&
          !control.disabled &&
          !control.hidden &&
          hasActionHintLayoutBox(control),
      })];
    });
    return {
      blocked: false,
      targets,
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:about",
    label = "About Caffold",
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
            <header class="settings-about-heading">
              <img src="/assets/icons/caffold.png" alt="" />
              <p>A review-first workspace for agent-assisted development.</p>
            </header>
            <section class="settings-about-updates" aria-labelledby="settings-about-updates-title">
              <div>
                <h3 id="settings-about-updates-title">Updates</h3>
                <p data-updates-summary></p>
                <dl>
                  <div><dt>Version</dt><dd data-updates-version></dd></div>
                  <div><dt>Latest version</dt><dd data-updates-latest></dd></div>
                  <div data-updates-last-row hidden><dt>Last update</dt><dd data-updates-last></dd></div>
                </dl>
              </div>
              <button type="button" data-action="update-caffold" disabled>Update Caffold</button>
            </section>
            <section aria-labelledby="settings-about-window-title">
              <h3 id="settings-about-window-title">This window</h3>
              <caffold-settings-detail-list></caffold-settings-detail-list>
            </section>
            <footer class="settings-about-actions">
              <span data-about-copy-status role="status" aria-live="polite"></span>
              <button type="button" data-action="reload-update" hidden>Reload to update</button>
              <button type="button" data-action="copy-diagnostics">Copy diagnostics</button>
            </footer>
          </div>
        </div>
      `;
      this.list = this.querySelector("caffold-settings-detail-list");
      this.reloadAction = this.querySelector('[data-action="reload-update"]');
    }

    const built = buildDate();
    const status = buildStatus(this.healthValue, this.updateStatusValue);
    const preparedUpdate = this.updateStatusValue.preparedUpdate;
    this.patchUpdates();
    this.list.setRows([
      { key: "ui-build", label: "UI build", value: BUILD_INFO.id, kind: "code" },
      {
        key: "server-build",
        label: "Server build",
        value: this.healthValue?.buildId ?? "Unavailable",
        kind: "code",
      },
      {
        key: "built",
        label: "Built",
        value: formatBuildDate(built),
        kind: "time",
        datetime: built.toISOString(),
      },
      { key: "status", label: "Status", value: status.label, state: status.state },
      ...(preparedUpdate.ready
        ? [{
          key: "prepared-update",
          label: "Prepared update",
          value: "Ready",
          state: "positive",
        }]
        : []),
    ]);
    this.reloadAction.hidden = !preparedUpdate.ready;
  }

  patchUpdates() {
    const view = caffoldUpdatesView(this.caffoldUpdateValue, this.healthValue);
    const summary = this.querySelector("[data-updates-summary]");
    if (view.checking) {
      showLoadingText(summary, view.summary);
    } else {
      summary.textContent = view.summary;
    }
    this.querySelector("[data-updates-version]").textContent = view.version;
    const latest = this.querySelector("[data-updates-latest]");
    if (view.latest.url) {
      const link = document.createElement("a");
      link.href = view.latest.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = view.latest.text;
      latest.replaceChildren(link);
    } else {
      latest.textContent = view.latest.text;
    }
    const lastRow = this.querySelector("[data-updates-last-row]");
    const last = this.querySelector("[data-updates-last]");
    lastRow.hidden = !view.lastUpdate;
    last.textContent = view.lastUpdate?.text ?? "";
    if (view.lastUpdate?.state) {
      last.dataset.state = view.lastUpdate.state;
    } else {
      delete last.dataset.state;
    }
    this.querySelector('[data-action="update-caffold"]').disabled = !view.canUpdate;
  }
}

/**
 * What the Updates section says. `snapshot` is the app shell's latest answer
 * about Caffold updates; `health` supplies the version before that answer.
 */
export function caffoldUpdatesView(snapshot, health = null) {
  const status = snapshot?.status ?? null;
  const version = status?.version ?? health?.version ?? "Unavailable";
  const lastUpdate = lastUpdateValue(status?.lastAttempt);
  if (snapshot?.checking !== false) {
    return {
      summary: "Checking for updates…",
      checking: true,
      version: health?.version ?? "Checking…",
      latest: { text: "Checking…", url: null },
      lastUpdate: null,
      canUpdate: false,
    };
  }
  if (!status) {
    return {
      summary: `Caffold could not check for updates.\n${snapshot.error ?? ""}`.trim(),
      checking: false,
      version,
      latest: { text: "Unavailable", url: null },
      lastUpdate,
      canUpdate: false,
    };
  }
  const latest = status.latestRelease
    ? { text: status.latestRelease.version, url: status.latestRelease.url }
    : { text: "Unavailable", url: null };
  const view = { checking: false, version, latest, lastUpdate, canUpdate: false };
  const running = status.runningAttempt;
  if (running) {
    const target = running.toVersion ?? status.latestRelease?.version;
    return {
      ...view,
      summary: target ? `Updating to Caffold ${target}…` : "Updating Caffold…",
      checking: true,
    };
  }
  if (!status.latestRelease) {
    return {
      ...view,
      summary: `Caffold could not check for updates.\n${status.releaseError ?? ""}`.trim(),
    };
  }
  if (!status.updateAvailable) {
    return { ...view, summary: "Caffold is up to date." };
  }
  if (!status.updateTask) {
    return {
      ...view,
      summary: `Caffold ${latest.text} is available. Install it from the release page.`,
    };
  }
  return {
    ...view,
    summary: `Caffold ${latest.text} is available. The menu-bar app can also update it.`,
    canUpdate: true,
  };
}

/** How the newest finished update ended, with when. */
export function lastUpdateValue(attempt) {
  if (!attempt) {
    return null;
  }
  const from = attempt.fromVersion;
  const outcome = {
    succeeded: { text: `Updated to ${attempt.toVersion}`, state: "positive" },
    rolledBack: {
      text: `Rolled back to ${from} — ${attempt.reason}`,
      state: "negative",
    },
    homebrewFailed: { text: "Homebrew could not update", state: "negative" },
    upToDate: { text: "Already up to date", state: "" },
    restoreFailed: { text: `Could not restore ${from}`, state: "negative" },
    interrupted: { text: "Interrupted", state: "negative" },
  }[attempt.outcome];
  if (!outcome) {
    return null;
  }
  const finished = attempt.finishedAt ? new Date(attempt.finishedAt) : null;
  const when = finished && !Number.isNaN(finished.getTime())
    ? ` · ${new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(finished)}`
    : "";
  return { text: `${outcome.text}${when}`, state: outcome.state };
}

function caffoldUpdateDiagnosticLines(snapshot, health) {
  const status = snapshot?.status ?? null;
  const attempt = status?.lastAttempt;
  return [
    `Caffold version: ${status?.version ?? health?.version ?? "unavailable"}`,
    `Latest release: ${
      status?.latestRelease?.version ??
        (status?.releaseError
          ? `unavailable (${diagnosticLineValue(status.releaseError, "")})`
          : snapshot?.checking === false ? "unavailable" : "checking")
    }`,
    `Last update: ${
      attempt
        ? `${attempt.outcome} ${attempt.fromVersion} -> ${attempt.toVersion ?? "unknown"} at ${attempt.finishedAt ?? "unknown"}`
        : "none"
    }`,
  ];
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

function buildStatus(
  health,
  updateStatus = {
    state: "checking",
    preparedUpdate: { ready: false, buildId: null },
  },
) {
  if (updateStatus.state === "ready") {
    return { state: "positive", label: "Update ready" };
  }
  if (!health?.buildId) {
    return { state: "negative", label: "Server unavailable" };
  }
  if (health.buildId !== BUILD_INFO.id) {
    if (updateStatus.state === "checking") {
      return { state: "", label: "Checking for update" };
    }
    return { state: "negative", label: "Reload required" };
  }
  return { state: "positive", label: "Current" };
}

function normalizeUpdateDiagnostics(diagnostics) {
  return {
    handoffNode: diagnosticValue(diagnostics?.handoffNode),
    targetBuildId: diagnosticValue(diagnostics?.targetBuildId),
    controllerBuildId: diagnosticValue(diagnostics?.controllerBuildId),
    activeBuildId: diagnosticValue(diagnostics?.activeBuildId),
    waitingBuildId: diagnosticValue(diagnostics?.waitingBuildId),
    navigationAttemptCount:
      Number.isInteger(diagnostics?.navigationAttemptCount) &&
      diagnostics.navigationAttemptCount >= 0
        ? diagnostics.navigationAttemptCount
        : 0,
    lastNavigationAttemptBuildId: diagnosticValue(
      diagnostics?.lastNavigationAttemptBuildId,
    ),
  };
}

function emptyUpdateDiagnostics() {
  return normalizeUpdateDiagnostics(null);
}

function diagnosticValue(value) {
  return typeof value === "string" && value ? value : null;
}

function codexMcpDiagnosticLines(diagnostics) {
  const lines = [
    `Codex app-server: ${diagnosticLineValue(diagnostics?.appServerVersion, "unavailable")}`,
    `Codex runtime generation: ${Number.isSafeInteger(diagnostics?.processGeneration) && diagnostics.processGeneration >= 0 ? diagnostics.processGeneration : "unavailable"}`,
  ];
  if (!diagnostics?.available) {
    lines.push(
      `Codex MCP diagnostics: unavailable${diagnosticErrorSuffix(diagnostics?.error)}`,
    );
    return lines;
  }

  const threads = Array.isArray(diagnostics.threads) ? diagnostics.threads : [];
  lines.push("Codex MCP diagnostics: available");
  lines.push(`Codex MCP loaded managed threads: ${threads.length}`);
  for (const thread of threads) {
    const threadId = diagnosticQuotedValue(thread?.threadId, "unknown");
    if (!thread?.available) {
      lines.push(
        `Codex MCP thread ${threadId}: unavailable${diagnosticErrorSuffix(thread?.error)}`,
      );
      continue;
    }
    const servers = Array.isArray(thread.servers) ? thread.servers : [];
    if (servers.length === 0) {
      lines.push(`Codex MCP thread ${threadId}: no servers reported`);
      continue;
    }
    for (const server of servers) {
      lines.push(
        `Codex MCP thread ${threadId}, server ${diagnosticQuotedValue(server?.name, "unknown")}: runtime=${knownMcpRuntimeStatus(server?.runtimeStatus)}; auth=${knownMcpAuthStatus(server?.authStatus)}`,
      );
    }
  }
  return lines;
}

function knownMcpRuntimeStatus(value) {
  return [
    "notStarted",
    "starting",
    "connected",
    "authenticationRequired",
    "failed",
    "cancelled",
    "disabled",
    "unknown",
  ].includes(value)
    ? value
    : "unavailable";
}

function knownMcpAuthStatus(value) {
  return ["unknown", "unsupported", "notLoggedIn", "bearerToken", "oAuth"]
    .includes(value)
    ? value
    : "unknown";
}

function diagnosticErrorSuffix(error) {
  return typeof error === "string" && error
    ? ` (${diagnosticQuotedValue(error, "unknown")})`
    : "";
}

function diagnosticQuotedValue(value, fallback) {
  return JSON.stringify(
    typeof value === "string" && value ? value : fallback,
  );
}

function diagnosticLineValue(value, fallback) {
  return typeof value === "string" && value
    ? value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n")
    : fallback;
}

customElements.define("caffold-settings-about-page", CaffoldSettingsAboutPage);
