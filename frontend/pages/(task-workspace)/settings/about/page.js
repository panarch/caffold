import { BUILD_INFO } from "../../../../build-info.js";
import "../components/detail-list.js";

class CaffoldSettingsAboutPage extends HTMLElement {
  connectedCallback() {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.healthValue = null;
    this.updateStatusValue = {
      state: "checking",
      preparedUpdate: { ready: false, buildId: null },
      diagnostics: emptyUpdateDiagnostics(),
    };
    this.addEventListener("click", (event) => {
      if (event.target.closest('[data-action="copy-diagnostics"]')) {
        void this.copyDiagnostics();
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
    const status = this.querySelector("[data-about-copy-status]");
    try {
      await navigator.clipboard.writeText(this.diagnosticsText());
      status.textContent = "Copied";
    } catch {
      status.textContent = "Copy failed";
    }
  }

  diagnosticsText() {
    const diagnostics = this.updateStatusValue.diagnostics;
    return [
      `Caffold ${BUILD_INFO.version}`,
      `UI build: ${BUILD_INFO.id}`,
      `Server build: ${this.healthValue?.buildId ?? "unavailable"}`,
      `Built: ${buildDate().toISOString()}`,
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
    ].join("\n");
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
            <caffold-settings-detail-list></caffold-settings-detail-list>
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
    this.list.setRows([
      { key: "version", label: "Version", value: BUILD_INFO.version },
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

customElements.define("caffold-settings-about-page", CaffoldSettingsAboutPage);
