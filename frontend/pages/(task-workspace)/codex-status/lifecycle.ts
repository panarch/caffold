import type {
  CodexResetCreditOutcome,
  CodexStatus,
  CodexUpdateOutcome,
} from "#app/api.ts";
import {
  type CodexRuntimeRequestState,
  type CodexStatusSnapshot,
  codexResetCredits,
  codexRuntimeRestartAvailable,
  codexRuntimeUpdateAvailable,
  createCodexStatusSnapshot,
  INITIAL_CODEX_STATUS_SNAPSHOT,
  sameCodexStatusSnapshot,
} from "./model.ts";
import { CodexRuntimeRestartLifecycle } from "./runtime-restart-lifecycle.ts";
import { CodexRuntimeUpdateLifecycle } from "./runtime-update-lifecycle.ts";

/**
 * Restarting and updating both replace the shared Codex runtime, so at most
 * one of them runs. These are the only edges between runtime actions; each
 * action's own request, refresh, and outcome stay with its lifecycle.
 */
type RuntimeAction = "idle" | "restarting" | "updating";

type RuntimeActionEvent =
  | "restartRequested"
  | "updateRequested"
  | "restartSettled"
  | "updateSettled"
  | "disconnected";

const RUNTIME_ACTION_EDGES: Readonly<
  Record<
    RuntimeAction,
    Readonly<Partial<Record<RuntimeActionEvent, RuntimeAction>>>
  >
> = Object.freeze({
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

// What a reset credit request is doing.
export interface CodexResetCreditRequestState {
  state: string;
  message: string;
  retryPending: boolean;
  creditId?: string | null;
}

interface ResetCreditAttempt {
  creditId: string | null;
  idempotencyKey: string;
}

export interface CodexStatusLifecycleOptions {
  consumeResetCredit: (
    attempt: ResetCreditAttempt,
  ) => Promise<{ outcome: CodexResetCreditOutcome } | null>;
  loadStatus: () => Promise<CodexStatus>;
  onResetCreditStateChange?: (state: CodexResetCreditRequestState) => void;
  onRestartStateChange?: (state: CodexRuntimeRequestState) => void;
  onRuntimeActionChange?: (action: RuntimeAction) => void;
  onSnapshotChange?: (snapshot: CodexStatusSnapshot) => void;
  onUpdateStateChange?: (state: CodexRuntimeRequestState) => void;
  restartRuntime: () => Promise<unknown>;
  updateRuntime: () => Promise<CodexUpdateOutcome>;
}

// The workspace's one Codex status: it loads and refreshes it, and runs the
// runtime restart and update and the reset credit the person confirms.
export class CodexStatusLifecycle {
  private readonly loadStatus: CodexStatusLifecycleOptions["loadStatus"];
  private readonly consumeResetCredit: CodexStatusLifecycleOptions["consumeResetCredit"];
  private readonly onSnapshotChange: CodexStatusLifecycleOptions["onSnapshotChange"];
  private readonly onResetCreditStateChange: CodexStatusLifecycleOptions["onResetCreditStateChange"];
  private readonly onRuntimeActionChange: CodexStatusLifecycleOptions["onRuntimeActionChange"];
  private active: boolean;
  private suspended: boolean;
  private statusRequestId: number;
  private statusRequest: Promise<CodexStatus | null> | null;
  private snapshotValue: CodexStatusSnapshot;
  private runtimeActionValue: RuntimeAction;
  private runtimeActionId: number;
  private runtimeActionRequest: Promise<unknown> | null;
  private resetCreditRequest: Promise<unknown> | null;
  private resetCreditAttempt: ResetCreditAttempt | null;
  private resetCreditStateValue: CodexResetCreditRequestState;
  private readonly runtimeRestart: CodexRuntimeRestartLifecycle;
  private readonly runtimeUpdate: CodexRuntimeUpdateLifecycle;

  constructor({
    consumeResetCredit,
    loadStatus,
    onResetCreditStateChange,
    onRestartStateChange,
    onRuntimeActionChange,
    onSnapshotChange,
    onUpdateStateChange,
    restartRuntime,
    updateRuntime,
  }: CodexStatusLifecycleOptions) {
    this.loadStatus = loadStatus;
    this.consumeResetCredit = consumeResetCredit;
    this.onSnapshotChange = onSnapshotChange;
    this.onResetCreditStateChange = onResetCreditStateChange;
    this.onRuntimeActionChange = onRuntimeActionChange;
    this.active = false;
    this.suspended = false;
    this.statusRequestId = 0;
    this.statusRequest = null;
    this.snapshotValue = INITIAL_CODEX_STATUS_SNAPSHOT;
    this.runtimeActionValue = "idle";
    this.runtimeActionId = 0;
    this.runtimeActionRequest = null;
    this.resetCreditRequest = null;
    this.resetCreditAttempt = null;
    this.resetCreditStateValue = Object.freeze({
      state: "idle",
      message: "",
      creditId: null,
      retryPending: false,
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
  }

  disconnect() {
    if (!this.active) {
      return;
    }
    this.active = false;
    this.suspended = false;
    this.statusRequestId += 1;
    this.statusRequest = null;
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

  canConsumeResetCredit(creditId: string | null = null) {
    if (
      !this.active ||
      this.suspended ||
      this.resetCreditRequest ||
      this.runtimeActionValue !== "idle"
    ) {
      return false;
    }
    const status = this.statusSnapshot();
    if (
      status?.account?.accountType !== "chatgpt" ||
      status?.readiness?.state !== "ready"
    ) {
      return false;
    }
    if (this.resetCreditAttempt) {
      return this.resetCreditAttempt.creditId === creditId;
    }
    const credits = codexResetCredits(status);
    return (
      this.snapshotValue.phase === "loaded" &&
      (credits?.availableCount ?? 0) > 0 &&
      (creditId === null ||
        credits?.credits?.some((credit) => credit.id === creditId) === true)
    );
  }

  requestResetCredit(creditId: string | null = null) {
    if (this.resetCreditRequest) {
      return this.resetCreditRequest;
    }
    if (!this.canConsumeResetCredit(creditId)) {
      return Promise.resolve(null);
    }
    const attempt: ResetCreditAttempt = this.resetCreditAttempt ?? {
      creditId,
      idempotencyKey: globalThis.crypto.randomUUID(),
    };
    this.resetCreditAttempt = attempt;
    this.setResetCreditState({
      state: "submitting",
      message: "",
      creditId,
      retryPending: false,
    });
    const request = this.runResetCredit(attempt).finally(() => {
      if (this.resetCreditRequest === request) {
        this.resetCreditRequest = null;
      }
    });
    this.resetCreditRequest = request;
    return request;
  }

  private async runResetCredit(attempt: ResetCreditAttempt) {
    let outcome = "";
    try {
      const result = await this.consumeResetCredit(attempt);
      outcome = result?.outcome ?? "";
      if (
        !["reset", "alreadyRedeemed", "nothingToReset", "noCredit"].includes(
          outcome,
        )
      ) {
        throw new Error("Codex returned an unknown reset outcome.");
      }
      this.setResetCreditState({
        state: "refreshing",
        message: "",
        creditId: attempt.creditId,
        retryPending: false,
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
      const messages: Record<string, string> = {
        reset: "Rate limits reset with one credit.",
        alreadyRedeemed: "This reset request was already completed.",
        nothingToReset: "Codex reports no eligible rate-limit window to reset.",
        noCredit: "Codex reports no reset credit available.",
      };
      const message = messages[outcome];
      this.setResetCreditState({
        state: ["reset", "alreadyRedeemed"].includes(outcome)
          ? "succeeded"
          : "failed",
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

  private setResetCreditState(value: CodexResetCreditRequestState) {
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
    return this.startRuntimeAction("restartRequested", "restartSettled", () =>
      this.runtimeRestart.restart(),
    );
  }

  requestRuntimeUpdate() {
    if (this.runtimeActionValue === "updating") {
      return this.runtimeActionRequest;
    }
    if (!this.active || !this.canUpdateRuntime()) {
      return Promise.resolve(null);
    }
    return this.startRuntimeAction("updateRequested", "updateSettled", () =>
      this.runtimeUpdate.update(),
    );
  }

  private startRuntimeAction(
    requested: RuntimeActionEvent,
    settled: RuntimeActionEvent,
    start: () => Promise<unknown>,
  ) {
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

  private transitionRuntimeAction(event: RuntimeActionEvent) {
    const next = RUNTIME_ACTION_EDGES[this.runtimeActionValue][event];
    if (!next) {
      return false;
    }
    this.runtimeActionValue = next;
    this.onRuntimeActionChange?.(next);
    return true;
  }

  async refresh(): Promise<CodexStatus | null> {
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

  private async performRefresh() {
    const requestId = ++this.statusRequestId;
    this.setSnapshot(
      createCodexStatusSnapshot({
        phase: "checking",
        status: this.snapshotValue.status,
      }),
    );
    try {
      const status = await this.loadStatus();
      if (!this.isCurrent(requestId)) {
        return null;
      }
      this.setSnapshot(
        createCodexStatusSnapshot({
          phase: "loaded",
          status,
        }),
      );
      return status;
    } catch (error) {
      if (!this.isCurrent(requestId)) {
        return null;
      }
      this.setSnapshot(
        createCodexStatusSnapshot({
          phase: "failed",
          status: this.snapshotValue.status,
          error: error instanceof Error ? error.message : `${error}`,
        }),
      );
      throw error;
    }
  }

  private isCurrent(requestId: number) {
    return this.active && !this.suspended && requestId === this.statusRequestId;
  }

  private setSnapshot(snapshot: CodexStatusSnapshot) {
    if (sameCodexStatusSnapshot(this.snapshotValue, snapshot)) {
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
    return true;
  }
}
