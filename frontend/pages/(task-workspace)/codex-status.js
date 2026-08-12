import {
  getCodexStatus,
  restartCodexRuntime,
} from "../../api.js";
import {
  codexBlocksTaskOperations,
  codexState,
  findRateWindow,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatRemainingPercent,
  formatResetCredits,
  sameCodexStatus,
} from "./codex-status/model.js";
import {
  CodexRuntimeRestartLifecycle,
} from "./codex-status/runtime-restart-lifecycle.js";

export const CODEX_STATUS_REFRESH_REQUEST_EVENT =
  "caffold:refresh-codex-status";
export const CODEX_RUNTIME_RESTART_REQUEST_EVENT =
  "caffold:request-codex-runtime-restart";

export {
  codexBlocksTaskOperations,
  codexState,
  findRateWindow,
  formatCodexAccount,
  formatCodexPlan,
  formatCodexReadiness,
  formatRateReset,
  formatRateWindowLabel,
  formatRemainingPercent,
  formatResetCredits,
};

export class CodexStatusLifecycle {
  constructor({
    loadStatus = getCodexStatus,
    onRestartStateChange,
    onStatusChange,
    restartRuntime = restartCodexRuntime,
  } = {}) {
    this.loadStatus = loadStatus;
    this.onStatusChange = onStatusChange;
    this.active = false;
    this.statusRequestId = 0;
    this.statusValue = null;
    this.runtimeRestart = new CodexRuntimeRestartLifecycle({
      restartRuntime,
      refreshStatus: () => this.refresh(),
      onStateChange: onRestartStateChange,
    });
  }

  connect() {
    if (this.active) {
      return;
    }
    this.active = true;
    this.runtimeRestart.connect();
    void this.refresh().catch(() => {});
  }

  disconnect() {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.statusRequestId += 1;
    this.runtimeRestart.disconnect();
  }

  statusSnapshot() {
    return this.statusValue;
  }

  restartSnapshot() {
    return this.runtimeRestart.snapshot();
  }

  canRestartRuntime() {
    return (
      this.statusValue?.readiness?.state === "restartRequired" &&
      !["restarting", "refreshing"].includes(
        this.runtimeRestart.snapshot().state,
      )
    );
  }

  requestRuntimeRestart() {
    if (this.statusValue?.readiness?.state !== "restartRequired") {
      return Promise.resolve(null);
    }
    return this.runtimeRestart.restart();
  }

  async refresh() {
    if (!this.active) {
      return null;
    }
    const requestId = ++this.statusRequestId;
    try {
      const status = await this.loadStatus();
      if (!this.isCurrent(requestId)) {
        return null;
      }
      this.setStatus(status);
      return status;
    } catch (error) {
      if (!this.isCurrent(requestId)) {
        return null;
      }
      this.setStatus({
        readiness: null,
        readinessLoadError: error instanceof Error ? error.message : `${error}`,
      });
      throw error;
    }
  }

  isCurrent(requestId) {
    return this.active && requestId === this.statusRequestId;
  }

  setStatus(status) {
    const nextStatus = status ?? null;
    if (sameCodexStatus(this.statusValue, nextStatus)) {
      return false;
    }
    const previousReadinessState = this.statusValue?.readiness?.state ?? null;
    const nextReadinessState = nextStatus?.readiness?.state ?? null;
    this.statusValue = nextStatus;
    if (previousReadinessState !== nextReadinessState) {
      this.runtimeRestart.reset();
    }
    this.onStatusChange?.(nextStatus);
    return true;
  }
}
