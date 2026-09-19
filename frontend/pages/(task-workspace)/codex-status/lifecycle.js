import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
  codexRuntimeRestartAvailable,
  codexRuntimeUpdateAvailable,
  createCodexStatusSnapshot,
  sameCodexStatusSnapshot,
} from "./model.js";
import {
  CodexRuntimeRestartLifecycle,
} from "./runtime-restart-lifecycle.js";
import {
  CodexRuntimeUpdateLifecycle,
} from "./runtime-update-lifecycle.js";

/**
 * Restarting and updating both replace the shared Codex runtime, so at most
 * one of them runs. These are the only edges between runtime actions; each
 * action's own request, refresh, and outcome stay with its lifecycle.
 */
const RUNTIME_ACTION_EDGES = Object.freeze({
  idle: Object.freeze({
    restartRequested: "restarting",
    updateRequested: "updating",
  }),
  restarting: Object.freeze({
    restartSettled: "idle",
    disconnected: "idle",
  }),
  updating: Object.freeze({
    updateSettled: "idle",
    disconnected: "idle",
  }),
});

export class CodexStatusLifecycle {
  constructor({
    loadStatus,
    onRestartStateChange,
    onRuntimeActionChange,
    onSnapshotChange,
    onUpdateStateChange,
    restartRuntime,
    retryTaskStore,
    updateRuntime,
  }) {
    this.loadStatus = loadStatus;
    this.onSnapshotChange = onSnapshotChange;
    this.onRuntimeActionChange = onRuntimeActionChange;
    this.active = false;
    this.suspended = false;
    this.statusRequestId = 0;
    this.statusRequest = null;
    this.taskStorePollTimer = null;
    this.retryTaskStore = retryTaskStore;
    this.snapshotValue = INITIAL_CODEX_STATUS_SNAPSHOT;
    this.runtimeActionValue = "idle";
    this.runtimeActionId = 0;
    this.runtimeActionRequest = null;
    this.runtimeRestart = new CodexRuntimeRestartLifecycle({
      restartRuntime,
      refreshStatus: () => this.refresh(),
      onStateChange: onRestartStateChange,
    });
    this.runtimeUpdate = new CodexRuntimeUpdateLifecycle({
      updateRuntime,
      refreshStatus: () => this.refresh(),
      onStateChange: onUpdateStateChange,
    });
  }

  connect() {
    if (this.active) {
      return;
    }
    this.active = true;
    this.suspended = false;
    this.runtimeRestart.connect();
    this.runtimeUpdate.connect();
    void this.refresh().catch(() => {});
  }

  disconnect() {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.suspended = false;
    this.statusRequestId += 1;
    this.statusRequest = null;
    this.clearTaskStorePoll();
    this.runtimeActionId += 1;
    this.runtimeActionRequest = null;
    this.transitionRuntimeAction("disconnected");
    this.runtimeRestart.disconnect();
    this.runtimeUpdate.disconnect();
  }

  suspend() {
    if (!this.active || this.suspended) {
      return;
    }
    this.suspended = true;
    this.statusRequestId += 1;
    this.statusRequest = null;
    this.clearTaskStorePoll();
  }

  resume() {
    if (!this.active) {
      return false;
    }
    const changed = this.suspended;
    this.suspended = false;
    return changed;
  }

  snapshot() {
    return this.snapshotValue;
  }

  statusSnapshot() {
    return this.snapshotValue.status;
  }

  restartSnapshot() {
    return this.runtimeRestart.snapshot();
  }

  updateSnapshot() {
    return this.runtimeUpdate.snapshot();
  }

  runtimeAction() {
    return this.runtimeActionValue;
  }

  canRestartRuntime() {
    return (
      this.runtimeActionValue === "idle" &&
      codexRuntimeRestartAvailable(this.statusSnapshot())
    );
  }

  canUpdateRuntime() {
    return (
      this.runtimeActionValue === "idle" &&
      codexRuntimeUpdateAvailable(this.statusSnapshot())
    );
  }

  requestRuntimeRestart() {
    if (this.runtimeActionValue === "restarting") {
      return this.runtimeActionRequest;
    }
    if (!this.active || !this.canRestartRuntime()) {
      return Promise.resolve(null);
    }
    return this.startRuntimeAction(
      "restartRequested",
      "restartSettled",
      () => this.runtimeRestart.restart(),
    );
  }

  requestRuntimeUpdate() {
    if (this.runtimeActionValue === "updating") {
      return this.runtimeActionRequest;
    }
    if (!this.active || !this.canUpdateRuntime()) {
      return Promise.resolve(null);
    }
    return this.startRuntimeAction(
      "updateRequested",
      "updateSettled",
      () => this.runtimeUpdate.update(),
    );
  }

  startRuntimeAction(requested, settled, start) {
    if (!this.transitionRuntimeAction(requested)) {
      return Promise.resolve(null);
    }
    const actionId = ++this.runtimeActionId;
    const request = start().finally(() => {
      if (actionId === this.runtimeActionId) {
        this.runtimeActionRequest = null;
        this.transitionRuntimeAction(settled);
      }
    });
    this.runtimeActionRequest = request;
    return request;
  }

  transitionRuntimeAction(event) {
    const next = RUNTIME_ACTION_EDGES[this.runtimeActionValue][event];
    if (!next) {
      return false;
    }
    this.runtimeActionValue = next;
    this.onRuntimeActionChange?.(next);
    return true;
  }

  async retryTaskStoreMigration() {
    if (
      !this.active ||
      !this.retryTaskStore ||
      this.statusSnapshot()?.taskStoreReadiness?.blocksTaskOperations !== true
    ) {
      return null;
    }
    await this.retryTaskStore();
    return await this.refresh();
  }

  async refresh() {
    if (!this.active || this.suspended) {
      return null;
    }
    if (this.statusRequest) {
      return await this.statusRequest;
    }
    const request = this.performRefresh();
    this.statusRequest = request;
    try {
      return await request;
    } finally {
      if (this.statusRequest === request) {
        this.statusRequest = null;
      }
    }
  }

  async performRefresh() {
    const requestId = ++this.statusRequestId;
    this.setSnapshot(createCodexStatusSnapshot({
      phase: "checking",
      status: this.snapshotValue.status,
    }));
    try {
      const status = await this.loadStatus();
      if (!this.isCurrent(requestId)) {
        return null;
      }
      this.setSnapshot(createCodexStatusSnapshot({
        phase: "loaded",
        status,
      }));
      return status;
    } catch (error) {
      if (!this.isCurrent(requestId)) {
        return null;
      }
      this.setSnapshot(createCodexStatusSnapshot({
        phase: "failed",
        status: this.snapshotValue.status,
        error: error instanceof Error ? error.message : `${error}`,
      }));
      throw error;
    }
  }

  isCurrent(requestId) {
    return (
      this.active &&
      !this.suspended &&
      requestId === this.statusRequestId
    );
  }

  setSnapshot(snapshot) {
    if (sameCodexStatusSnapshot(this.snapshotValue, snapshot)) {
      this.scheduleTaskStorePoll(snapshot);
      return false;
    }
    const previousReadinessState =
      this.snapshotValue.status?.readiness?.state ?? null;
    const nextReadinessState = snapshot.status?.readiness?.state ?? null;
    this.snapshotValue = snapshot;
    if (previousReadinessState !== nextReadinessState) {
      this.runtimeRestart.reset();
      this.runtimeUpdate.reset();
    }
    this.onSnapshotChange?.(snapshot);
    this.scheduleTaskStorePoll(snapshot);
    return true;
  }

  scheduleTaskStorePoll(snapshot) {
    this.clearTaskStorePoll();
    if (
      !this.active ||
      this.suspended ||
      snapshot.phase !== "loaded" ||
      snapshot.status?.taskStoreReadiness?.state !== "migrating"
    ) {
      return;
    }
    this.taskStorePollTimer = setTimeout(() => {
      this.taskStorePollTimer = null;
      void this.refresh().catch(() => {});
    }, 500);
  }

  clearTaskStorePoll() {
    if (this.taskStorePollTimer !== null) {
      clearTimeout(this.taskStorePollTimer);
      this.taskStorePollTimer = null;
    }
  }
}
