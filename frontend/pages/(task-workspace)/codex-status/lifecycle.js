import {
  INITIAL_CODEX_STATUS_SNAPSHOT,
  codexResetCredits,
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
    consumeResetCredit,
    loadStatus,
    onResetCreditStateChange,
    onRestartStateChange,
    onRuntimeActionChange,
    onSnapshotChange,
    onUpdateStateChange,
    restartRuntime,
    retryTaskStore,
    updateRuntime,
  }) {
    this.loadStatus = loadStatus;
    this.consumeResetCredit = consumeResetCredit;
    this.onSnapshotChange = onSnapshotChange;
    this.onResetCreditStateChange = onResetCreditStateChange;
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
    this.resetCreditRequest = null;
    this.resetCreditAttempt = null;
    this.resetCreditStateValue = Object.freeze({
      state: "idle", message: "", creditId: null, retryPending: false,
    });
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

  resetCreditState() {
    return this.resetCreditStateValue;
  }

  canConsumeResetCredit(creditId = null) {
    if (!this.active || this.suspended || this.resetCreditRequest ||
      this.runtimeActionValue !== "idle") {
      return false;
    }
    const status = this.statusSnapshot();
    if (status?.account?.accountType !== "chatgpt" ||
      status?.readiness?.state !== "ready") {
      return false;
    }
    if (this.resetCreditAttempt) {
      return this.resetCreditAttempt.creditId === creditId;
    }
    const credits = codexResetCredits(status);
    return this.snapshotValue.phase === "loaded" &&
      credits?.availableCount > 0 &&
      (creditId === null || credits.credits?.some((credit) => credit.id === creditId));
  }

  requestResetCredit(creditId = null) {
    if (this.resetCreditRequest) {
      return this.resetCreditRequest;
    }
    if (!this.canConsumeResetCredit(creditId)) {
      return Promise.resolve(null);
    }
    const attempt = this.resetCreditAttempt ?? {
      creditId,
      idempotencyKey: globalThis.crypto.randomUUID(),
    };
    this.resetCreditAttempt = attempt;
    this.setResetCreditState({
      state: "submitting", message: "", creditId, retryPending: false,
    });
    const request = this.runResetCredit(attempt).finally(() => {
      if (this.resetCreditRequest === request) {
        this.resetCreditRequest = null;
      }
    });
    this.resetCreditRequest = request;
    return request;
  }

  async runResetCredit(attempt) {
    let outcome;
    try {
      const result = await this.consumeResetCredit(attempt);
      outcome = result?.outcome;
      if (!["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].includes(outcome)) {
        throw new Error("Codex returned an unknown reset outcome.");
      }
      this.setResetCreditState({
        state: "refreshing", message: "", creditId: attempt.creditId, retryPending: false,
      });
      if (["nothingToReset", "noCredit"].includes(outcome)) {
        this.resetCreditAttempt = null;
      }
      // An earlier status read may have started before Codex accepted the
      // reset. Let it finish, then request a new report of the credit count.
      if (this.statusRequest) {
        await this.statusRequest.catch(() => {});
      }
      const status = await this.refresh();
      if (!status) {
        throw new Error("Codex status is unavailable.");
      }
      this.resetCreditAttempt = null;
      const message = {
        reset: "Rate limits reset with one credit.",
        alreadyRedeemed: "This reset request was already completed.",
        nothingToReset: "Codex reports no eligible rate-limit window to reset.",
        noCredit: "Codex reports no reset credit available.",
      }[outcome];
      this.setResetCreditState({
        state: ["reset", "alreadyRedeemed"].includes(outcome) ? "succeeded" : "failed",
        message,
        creditId: null,
        retryPending: false,
      });
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : `${error}`;
      this.setResetCreditState({
        state: "failed",
        message: ["reset", "alreadyRedeemed"].includes(outcome)
          ? `Codex accepted the reset, but status could not be refreshed: ${detail}. Retry uses the same request.`
          : outcome
            ? detail
            : `Could not confirm whether Codex used the reset: ${detail}. Retry uses the same request.`,
        creditId: this.resetCreditAttempt?.creditId ?? null,
        retryPending: Boolean(this.resetCreditAttempt),
      });
      return null;
    }
  }

  setResetCreditState(value) {
    this.resetCreditStateValue = Object.freeze({ ...value });
    this.onResetCreditStateChange?.(this.resetCreditStateValue);
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
