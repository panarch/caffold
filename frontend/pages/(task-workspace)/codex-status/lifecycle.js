import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
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
  }) {
    this.loadStatus = loadStatus;
    this.onSnapshotChange = onSnapshotChange;
    this.active = false;
    this.statusRequestId = 0;
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
      this.statusSnapshot()?.readiness?.state === "restartRequired" &&
      !["restarting", "refreshing"].includes(
        this.runtimeRestart.snapshot().state,
      )
    );
  }

  requestRuntimeRestart() {
    if (this.statusSnapshot()?.readiness?.state !== "restartRequired") {
      return Promise.resolve(null);
    }
    return this.runtimeRestart.restart();
  }

  async refresh() {
    if (!this.active) {
      return null;
    }
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
        error: error instanceof Error ? error.message : `${error}`,
      }));
      throw error;
    }
  }

  isCurrent(requestId) {
    return this.active && requestId === this.statusRequestId;
  }

  setSnapshot(snapshot) {
    if (sameCodexStatusSnapshot(this.snapshotValue, snapshot)) {
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
    return true;
  }
}
