import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
  codexRuntimeRestartAvailable,
  createCodexStatusSnapshot,
  sameCodexStatusSnapshot,
} from "./model.js";
import {
  CodexRuntimeRestartLifecycle,
} from "./runtime-restart-lifecycle.js";

export class CodexStatusLifecycle {
  constructor({
    loadStatus,
    onRestartStateChange,
    onSnapshotChange,
    restartRuntime,
    retryTaskStore,
  }) {
    this.loadStatus = loadStatus;
    this.onSnapshotChange = onSnapshotChange;
    this.active = false;
    this.suspended = false;
    this.statusRequestId = 0;
    this.statusRequest = null;
    this.taskStorePollTimer = null;
    this.retryTaskStore = retryTaskStore;
    this.snapshotValue = INITIAL_CODEX_STATUS_SNAPSHOT;
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
    this.suspended = false;
    this.runtimeRestart.connect();
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
    this.runtimeRestart.disconnect();
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

  canRestartRuntime() {
    return (
      codexRuntimeRestartAvailable(this.statusSnapshot()) &&
      !["restarting", "refreshing"].includes(
        this.runtimeRestart.snapshot().state,
      )
    );
  }

  requestRuntimeRestart() {
    if (!codexRuntimeRestartAvailable(this.statusSnapshot())) {
      return Promise.resolve(null);
    }
    return this.runtimeRestart.restart();
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
