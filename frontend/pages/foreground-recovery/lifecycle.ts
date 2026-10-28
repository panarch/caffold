import {
  type BrowserSignal,
  type BrowserSignalsOptions,
  FOREGROUND_RECOVERY_BROWSER_SIGNAL,
  type ForegroundRecoveryBrowserSignal,
  ForegroundRecoveryBrowserSignals,
} from "./browser-signals.js";
import {
  createForegroundRecoveryState,
  FOREGROUND_RECOVERY_EVENT,
  FOREGROUND_RECOVERY_INTENT,
  FOREGROUND_RECOVERY_NODE,
  FOREGROUND_RECOVERY_TRIGGER,
  type ForegroundRecoveryEvent,
  type ForegroundRecoveryIntent,
  type ForegroundRecoveryNode,
  type ForegroundRecoveryState,
  type ForegroundRecoveryTrigger,
  isDefinitelyOfflineObservation,
  isNetworkFailure,
  mergePendingRequest,
  normalizeRecoveryRequest,
  type RecoveryRequest,
  transitionForegroundRecovery,
} from "./machine.js";

export const NOTIFICATION_ACTIVATION_MESSAGE =
  "caffold:notification-activation";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);
// Delays between automatic recovery attempts while the page is visible; the
// last one repeats.
const DEFAULT_AUTOMATIC_RETRY_DELAYS_MS = Object.freeze([
  5_000, 10_000, 20_000, 30_000,
]);

// A settled attempt or a new visit starts the automatic delays over.
const AUTOMATIC_RETRY_RESET_EVENTS = new Set<ForegroundRecoveryEvent["type"]>([
  FOREGROUND_RECOVERY_EVENT.ATTEMPT_SETTLED,
  FOREGROUND_RECOVERY_EVENT.SUSPENDED,
  FOREGROUND_RECOVERY_EVENT.DISCONNECTED,
]);

// Runtime effects consume the private machine contract and cannot bypass its reducer.
const triggerByBrowserSignal: Readonly<
  Partial<Record<ForegroundRecoveryBrowserSignal, ForegroundRecoveryTrigger>>
> = Object.freeze({
  [FOREGROUND_RECOVERY_BROWSER_SIGNAL.VISIBILITY_CHANGED]:
    FOREGROUND_RECOVERY_TRIGGER.DOCUMENT_VISIBLE,
  [FOREGROUND_RECOVERY_BROWSER_SIGNAL.DOCUMENT_RESUMED]:
    FOREGROUND_RECOVERY_TRIGGER.DOCUMENT_RESUMED,
  [FOREGROUND_RECOVERY_BROWSER_SIGNAL.BFCACHE_RESTORED]:
    FOREGROUND_RECOVERY_TRIGGER.BFCACHE_RESTORED,
  [FOREGROUND_RECOVERY_BROWSER_SIGNAL.WINDOW_FOCUSED]:
    FOREGROUND_RECOVERY_TRIGGER.WINDOW_FOCUSED,
  [FOREGROUND_RECOVERY_BROWSER_SIGNAL.NETWORK_ONLINE]:
    FOREGROUND_RECOVERY_TRIGGER.NETWORK_ONLINE,
  [FOREGROUND_RECOVERY_BROWSER_SIGNAL.CONNECTION_CHANGED]:
    FOREGROUND_RECOVERY_TRIGGER.CONNECTION_CHANGED,
  [FOREGROUND_RECOVERY_BROWSER_SIGNAL.NOTIFICATION_ACTIVATED]:
    FOREGROUND_RECOVERY_TRIGGER.NOTIFICATION_ACTIVATED,
});

// What one attempt hands its owner: the work, which attempt and generation
// it is, whether it is still current, and where to report its stage.
export interface RecoveryAttempt extends RecoveryRequest {
  attempt: number;
  generation: number;
  isCurrent(): boolean;
  reportStage(nodeType: ForegroundRecoveryNode): boolean;
}

export interface ForegroundRecoveryRuntimeOptions
  extends Omit<BrowserSignalsOptions, "notificationMessageType" | "onSignal"> {
  onRecover?: (attempt: RecoveryAttempt) => Promise<unknown>;
  onStateChange?: (snapshot: ForegroundRecoveryRuntimeSnapshot) => void;
  onSuspend?: () => void;
  retryDelaysMs?: readonly number[];
  automaticRetryDelaysMs?: readonly number[];
}

export type ForegroundRecoveryRuntimeSnapshot = Readonly<
  Pick<
    ForegroundRecoveryState,
    "generation" | "lastTrigger" | "node" | "observation" | "targets"
  >
>;

export class ForegroundRecoveryRuntime {
  private readonly onRecover: NonNullable<
    ForegroundRecoveryRuntimeOptions["onRecover"]
  >;
  private readonly onStateChange: NonNullable<
    ForegroundRecoveryRuntimeOptions["onStateChange"]
  >;
  private readonly onSuspend: () => void;
  private readonly retryDelaysMs: number[];
  private readonly automaticRetryDelaysMs: number[];
  private readonly windowTarget: Window;
  private readonly runtime: {
    inFlight: Promise<unknown> | null;
    retryTimer: number | null;
    automaticRetryTimer: number | null;
    automaticRetryAttempt: number;
  };
  private readonly browserSignals: ForegroundRecoveryBrowserSignals;
  private state: ForegroundRecoveryState;

  constructor({
    documentTarget = document,
    navigatorTarget = navigator,
    onRecover = () => Promise.resolve(),
    onStateChange = () => {},
    onSuspend = () => {},
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    automaticRetryDelaysMs = DEFAULT_AUTOMATIC_RETRY_DELAYS_MS,
    serviceWorkerTarget = navigatorTarget.serviceWorker,
    windowTarget = window,
  }: ForegroundRecoveryRuntimeOptions = {}) {
    this.onRecover = onRecover;
    this.onStateChange = onStateChange;
    this.onSuspend = onSuspend;
    this.retryDelaysMs = [...retryDelaysMs];
    this.automaticRetryDelaysMs = [...automaticRetryDelaysMs];
    this.windowTarget = windowTarget;
    this.runtime = {
      inFlight: null,
      retryTimer: null,
      automaticRetryTimer: null,
      automaticRetryAttempt: 0,
    };
    this.browserSignals = new ForegroundRecoveryBrowserSignals({
      documentTarget,
      navigatorTarget,
      notificationMessageType: NOTIFICATION_ACTIVATION_MESSAGE,
      onSignal: (signal) => this.handleBrowserSignal(signal),
      serviceWorkerTarget,
      windowTarget,
    });
    this.state = createForegroundRecoveryState({
      observation: this.browserSignals.observe(),
    });
  }

  connect() {
    if (this.state.node.type !== FOREGROUND_RECOVERY_NODE.DETACHED) {
      return;
    }
    this.browserSignals.connect();
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.CONNECTED,
      observation: this.browserSignals.observe(),
    });
    if (
      (
        [
          FOREGROUND_RECOVERY_NODE.SUSPENDED,
          FOREGROUND_RECOVERY_NODE.OFFLINE,
        ] as ForegroundRecoveryNode[]
      ).includes(this.state.node.type)
    ) {
      this.onSuspend();
    }
  }

  disconnect() {
    if (this.state.node.type === FOREGROUND_RECOVERY_NODE.DETACHED) {
      return;
    }
    this.browserSignals.disconnect();
    this.clearRetryTimer();
    this.runtime.inFlight = null;
    this.apply({ type: FOREGROUND_RECOVERY_EVENT.DISCONNECTED });
  }

  requestForegroundRecovery({
    activationRoute = "",
    intent = FOREGROUND_RECOVERY_INTENT.RECONCILE,
    trigger = FOREGROUND_RECOVERY_TRIGGER.APP_RECONNECTED,
  }: {
    activationRoute?: string;
    intent?: ForegroundRecoveryIntent;
    trigger?: ForegroundRecoveryTrigger;
  } = {}): Promise<unknown> {
    if (this.state.node.type === FOREGROUND_RECOVERY_NODE.DETACHED) {
      return Promise.resolve(null);
    }
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.OBSERVATION_UPDATED,
      observation: this.browserSignals.observe(),
    });
    const nextRequest = normalizeRecoveryRequest({
      activationRoute,
      intent,
      trigger,
    });
    if (this.state.observation.visibility !== "visible") {
      this.apply({
        type: FOREGROUND_RECOVERY_EVENT.REQUEST_QUEUED,
        request: nextRequest,
      });
      if (this.state.node.type !== FOREGROUND_RECOVERY_NODE.SUSPENDED) {
        this.suspend();
      }
      return this.runtime.inFlight ?? Promise.resolve(null);
    }
    if (this.runtime.inFlight) {
      if (
        nextRequest.activationRoute &&
        nextRequest.activationRoute !==
          this.state.activeRequest?.activationRoute
      ) {
        this.apply({
          type: FOREGROUND_RECOVERY_EVENT.REQUEST_QUEUED,
          request: nextRequest,
        });
      } else {
        this.apply({
          type: FOREGROUND_RECOVERY_EVENT.REQUEST_COALESCED,
          request: nextRequest,
        });
      }
      return this.runtime.inFlight;
    }
    this.clearRetryTimer();
    return this.startRecovery({
      attempt: 0,
      request: mergePendingRequest(this.state.pendingRequest, nextRequest),
    });
  }

  reportOriginReachable() {
    if (this.state.node.type !== FOREGROUND_RECOVERY_NODE.OFFLINE) {
      return Promise.resolve(null);
    }
    return this.requestForegroundRecovery({
      trigger: FOREGROUND_RECOVERY_TRIGGER.ORIGIN_REACHABLE,
    });
  }

  setTargets(targets: unknown) {
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.TARGETS_UPDATED,
      targets,
    });
  }

  snapshot(): ForegroundRecoveryRuntimeSnapshot {
    return Object.freeze({
      generation: this.state.generation,
      lastTrigger: this.state.lastTrigger,
      node: this.state.node,
      observation: this.state.observation,
      targets: this.state.targets,
    });
  }

  private handleBrowserSignal(signal: BrowserSignal) {
    const previous = this.state.observation;
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.OBSERVATION_UPDATED,
      observation: signal.observation,
    });

    if (
      signal.type === FOREGROUND_RECOVERY_BROWSER_SIGNAL.NETWORK_OFFLINE ||
      isDefinitelyOfflineObservation(signal.observation)
    ) {
      this.pauseForOffline();
      return;
    }

    if (signal.type === FOREGROUND_RECOVERY_BROWSER_SIGNAL.WINDOW_BLURRED) {
      if (signal.observation.visibility !== "visible") {
        this.suspend();
      }
      return;
    }

    const trigger = triggerByBrowserSignal[signal.type];
    if (!trigger) {
      return;
    }

    if (signal.observation.visibility !== "visible") {
      if (
        signal.type === FOREGROUND_RECOVERY_BROWSER_SIGNAL.VISIBILITY_CHANGED
      ) {
        this.suspend();
      } else {
        void this.requestForegroundRecovery({
          activationRoute: signal.activationRoute,
          trigger,
        });
      }
      return;
    }

    if (
      signal.type === FOREGROUND_RECOVERY_BROWSER_SIGNAL.WINDOW_FOCUSED &&
      previous.focused !== false
    ) {
      return;
    }

    if (signal.type === FOREGROUND_RECOVERY_BROWSER_SIGNAL.CONNECTION_CHANGED) {
      const previousType = previous.network.connectionType;
      const nextType = signal.observation.network.connectionType;
      const recoveredFromOffline =
        this.state.node.type === FOREGROUND_RECOVERY_NODE.OFFLINE;
      const connectionTypeChanged =
        previousType !== null && nextType !== null && previousType !== nextType;
      if (!recoveredFromOffline && !connectionTypeChanged) {
        return;
      }
    }

    void this.requestForegroundRecovery({
      activationRoute: signal.activationRoute,
      trigger,
    });
  }

  private suspend() {
    if (this.state.node.type === FOREGROUND_RECOVERY_NODE.SUSPENDED) {
      return;
    }
    this.clearRetryTimer();
    this.runtime.inFlight = null;
    this.apply({ type: FOREGROUND_RECOVERY_EVENT.SUSPENDED });
    this.onSuspend();
  }

  private pauseForOffline() {
    const pausedNode =
      this.state.observation.visibility === "visible"
        ? FOREGROUND_RECOVERY_NODE.OFFLINE
        : FOREGROUND_RECOVERY_NODE.SUSPENDED;
    if (this.state.node.type === pausedNode) {
      return;
    }
    this.clearRetryTimer();
    this.runtime.inFlight = null;
    this.apply({ type: FOREGROUND_RECOVERY_EVENT.WENT_OFFLINE });
    this.onSuspend();
  }

  private startRecovery({
    attempt,
    request,
  }: {
    attempt: number;
    request: RecoveryRequest | null;
  }): Promise<unknown> {
    if (
      this.state.node.type === FOREGROUND_RECOVERY_NODE.DETACHED ||
      this.state.observation.visibility !== "visible"
    ) {
      this.apply({
        type: FOREGROUND_RECOVERY_EVENT.REQUEST_QUEUED,
        request,
      });
      return Promise.resolve(null);
    }
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_STARTED,
      attempt,
      request,
    });
    const generation = this.state.generation;
    const recoveryRequest = this.state.activeRequest as RecoveryRequest;
    const promise: Promise<unknown> = Promise.resolve()
      .then(() =>
        this.onRecover({
          activationRoute: recoveryRequest.activationRoute,
          attempt,
          generation,
          intent: recoveryRequest.intent,
          isCurrent: () => this.isCurrent(generation),
          reportStage: (nodeType) => this.reportStage(generation, nodeType),
          trigger: recoveryRequest.trigger,
        }),
      )
      .then((answer) => {
        if (!this.isCurrent(generation)) {
          return null;
        }
        const outcome = answer as { retry?: unknown; error?: unknown } | null;
        if (outcome?.retry === true) {
          if (isNetworkFailure(outcome?.error)) {
            this.handleNetworkFailure(generation);
          } else {
            this.scheduleRetry(generation);
          }
          return outcome;
        }
        this.apply({
          type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_SETTLED,
          generation,
        });
        return outcome;
      })
      .catch((error) => {
        if (this.isCurrent(generation)) {
          if (isNetworkFailure(error)) {
            this.handleNetworkFailure(generation);
          } else {
            this.scheduleRetry(generation);
          }
        }
        return { error, retry: true };
      })
      .finally(() => {
        if (this.runtime.inFlight !== promise) {
          return;
        }
        this.runtime.inFlight = null;
        if (
          this.state.pendingRequest &&
          this.state.node.type === FOREGROUND_RECOVERY_NODE.READY &&
          this.state.observation.visibility === "visible"
        ) {
          void this.startRecovery({
            attempt: 0,
            request: this.state.pendingRequest,
          });
        }
      });
    this.runtime.inFlight = promise;
    return promise;
  }

  private reportStage(generation: number, nodeType: ForegroundRecoveryNode) {
    const previous = this.state;
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.STAGE_ENTERED,
      generation,
      nodeType,
    });
    return this.state !== previous;
  }

  private scheduleRetry(generation: number) {
    if (!this.isCurrent(generation)) {
      return;
    }
    const attempt = this.state.node.attempt;
    const delayMs = this.retryDelaysMs[attempt];
    if (!Number.isFinite(delayMs)) {
      this.apply({
        type: FOREGROUND_RECOVERY_EVENT.RETRY_EXHAUSTED,
        attempt,
        generation,
      });
      return;
    }
    const nextAttempt = attempt + 1;
    const activeRetryRequest = normalizeRecoveryRequest({
      activationRoute: this.state.activeRequest?.activationRoute ?? "",
      intent: FOREGROUND_RECOVERY_INTENT.RECONCILE,
      trigger: this.state.activeRequest?.trigger,
    });
    const retryRequest = mergePendingRequest(
      activeRetryRequest,
      this.state.pendingRequest,
    );
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.BACKOFF_STARTED,
      attempt: nextAttempt,
      generation,
    });
    this.runtime.retryTimer = this.windowTarget.setTimeout(
      () => {
        if (
          this.state.node.type !== FOREGROUND_RECOVERY_NODE.BACKING_OFF ||
          this.state.generation !== generation
        ) {
          return;
        }
        this.runtime.retryTimer = null;
        this.runtime.inFlight = null;
        void this.startRecovery({
          attempt: nextAttempt,
          request: retryRequest,
        });
      },
      Math.max(0, delayMs),
    );
  }

  private handleNetworkFailure(generation: number) {
    if (this.state.coalescedRequest) {
      this.apply({
        type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_SUPERSEDED,
        generation,
      });
      return;
    }
    this.pauseForOffline();
  }

  private clearRetryTimer() {
    if (this.runtime.retryTimer !== null) {
      this.windowTarget.clearTimeout(this.runtime.retryTimer);
      this.runtime.retryTimer = null;
    }
  }

  private isCurrent(generation: number) {
    return (
      this.state.node.type !== FOREGROUND_RECOVERY_NODE.DETACHED &&
      this.state.observation.visibility === "visible" &&
      generation === this.state.generation
    );
  }

  private apply(event: ForegroundRecoveryEvent) {
    const next = transitionForegroundRecovery(this.state, event);
    if (next === this.state) {
      return false;
    }
    this.state = next;
    if (AUTOMATIC_RETRY_RESET_EVENTS.has(event.type)) {
      this.runtime.automaticRetryAttempt = 0;
    }
    this.syncAutomaticRetry();
    this.onStateChange(this.snapshot());
    return true;
  }

  // While visible, recovery that spent its retries tries again on its own,
  // each time after a longer delay up to the last one. So does an offline pause
  // while the browser still reports a network, since no browser signal will end
  // it; a browser that reports itself offline announces its return.
  private syncAutomaticRetry() {
    const { node, observation } = this.state;
    const waiting =
      observation.visibility === "visible" &&
      (node.type === FOREGROUND_RECOVERY_NODE.EXHAUSTED ||
        (node.type === FOREGROUND_RECOVERY_NODE.OFFLINE &&
          !isDefinitelyOfflineObservation(observation)));
    if (!waiting) {
      this.clearAutomaticRetryTimer();
      return;
    }
    if (this.runtime.automaticRetryTimer !== null) {
      return;
    }
    const delays = this.automaticRetryDelaysMs;
    const delayMs =
      delays[Math.min(this.runtime.automaticRetryAttempt, delays.length - 1)];
    if (!Number.isFinite(delayMs)) {
      return;
    }
    this.runtime.automaticRetryAttempt += 1;
    this.runtime.automaticRetryTimer = this.windowTarget.setTimeout(
      () => {
        this.runtime.automaticRetryTimer = null;
        void this.requestForegroundRecovery({
          trigger: FOREGROUND_RECOVERY_TRIGGER.AUTOMATIC_RETRY,
        });
      },
      Math.max(0, delayMs),
    );
  }

  private clearAutomaticRetryTimer() {
    if (this.runtime.automaticRetryTimer !== null) {
      this.windowTarget.clearTimeout(this.runtime.automaticRetryTimer);
      this.runtime.automaticRetryTimer = null;
    }
  }
}
