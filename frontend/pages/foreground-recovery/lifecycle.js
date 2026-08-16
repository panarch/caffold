import {
  FOREGROUND_RECOVERY_BROWSER_SIGNAL,
  ForegroundRecoveryBrowserSignals,
} from "./browser-signals.js";

import {
  FOREGROUND_RECOVERY_EVENT,
  FOREGROUND_RECOVERY_INTENT,
  FOREGROUND_RECOVERY_NODE,
  FOREGROUND_RECOVERY_TRIGGER,
  createForegroundRecoveryState,
  isDefinitelyOfflineObservation,
  isNetworkFailure,
  mergePendingRequest,
  normalizeRecoveryRequest,
  transitionForegroundRecovery,
} from "./machine.js";

export const NOTIFICATION_ACTIVATION_MESSAGE =
  "caffold:notification-activation";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);

// Runtime effects consume the private machine contract and cannot bypass its reducer.
const triggerByBrowserSignal = Object.freeze({
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

export class ForegroundRecoveryRuntime {
  constructor({
    documentTarget = document,
    navigatorTarget = navigator,
    onRecover = () => Promise.resolve(),
    onStateChange = () => {},
    onSuspend = () => {},
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    serviceWorkerTarget = navigatorTarget.serviceWorker,
    windowTarget = window,
  } = {}) {
    this.onRecover = onRecover;
    this.onStateChange = onStateChange;
    this.onSuspend = onSuspend;
    this.retryDelaysMs = [...retryDelaysMs];
    this.windowTarget = windowTarget;
    this.runtime = {
      inFlight: null,
      retryTimer: null,
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
    if ([FOREGROUND_RECOVERY_NODE.SUSPENDED, FOREGROUND_RECOVERY_NODE.OFFLINE].includes(this.state.node.type)) {
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
  } = {}) {
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

  setTargets(targets) {
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.TARGETS_UPDATED,
      targets,
    });
  }

  snapshot() {
    return Object.freeze({
      generation: this.state.generation,
      lastTrigger: this.state.lastTrigger,
      node: this.state.node,
      observation: this.state.observation,
      targets: this.state.targets,
    });
  }

  handleBrowserSignal(signal) {
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
        signal.type ===
        FOREGROUND_RECOVERY_BROWSER_SIGNAL.VISIBILITY_CHANGED
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

    if (
      signal.type === FOREGROUND_RECOVERY_BROWSER_SIGNAL.CONNECTION_CHANGED
    ) {
      const previousType = previous.network.connectionType;
      const nextType = signal.observation.network.connectionType;
      const recoveredFromOffline = this.state.node.type === FOREGROUND_RECOVERY_NODE.OFFLINE;
      const connectionTypeChanged =
        previousType !== null &&
        nextType !== null &&
        previousType !== nextType;
      if (!recoveredFromOffline && !connectionTypeChanged) {
        return;
      }
    }

    void this.requestForegroundRecovery({
      activationRoute: signal.activationRoute,
      trigger,
    });
  }

  suspend() {
    if (this.state.node.type === FOREGROUND_RECOVERY_NODE.SUSPENDED) {
      return;
    }
    this.clearRetryTimer();
    this.runtime.inFlight = null;
    this.apply({ type: FOREGROUND_RECOVERY_EVENT.SUSPENDED });
    this.onSuspend();
  }

  pauseForOffline() {
    const pausedNode = this.state.observation.visibility === "visible"
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

  startRecovery({ attempt, request }) {
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
    const recoveryRequest = this.state.activeRequest;
    const promise = Promise.resolve()
      .then(() => this.onRecover({
        activationRoute: recoveryRequest.activationRoute,
        attempt,
        generation,
        intent: recoveryRequest.intent,
        isCurrent: () => this.isCurrent(generation),
        reportStage: (nodeType) => this.reportStage(generation, nodeType),
        trigger: recoveryRequest.trigger,
      }))
      .then((outcome) => {
        if (!this.isCurrent(generation)) {
          return null;
        }
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
          this.startRecovery({
            attempt: 0,
            request: this.state.pendingRequest,
          });
        }
      });
    this.runtime.inFlight = promise;
    return promise;
  }

  reportStage(generation, nodeType) {
    const previous = this.state;
    this.apply({
      type: FOREGROUND_RECOVERY_EVENT.STAGE_ENTERED,
      generation,
      nodeType,
    });
    return this.state !== previous;
  }

  scheduleRetry(generation) {
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
    this.runtime.retryTimer = this.windowTarget.setTimeout(() => {
      if (
        this.state.node.type !== FOREGROUND_RECOVERY_NODE.BACKING_OFF ||
        this.state.generation !== generation
      ) {
        return;
      }
      this.runtime.retryTimer = null;
      this.runtime.inFlight = null;
      this.startRecovery({
        attempt: nextAttempt,
        request: retryRequest,
      });
    }, Math.max(0, delayMs));
  }

  handleNetworkFailure(generation) {
    if (this.state.coalescedRequest) {
      this.apply({
        type: FOREGROUND_RECOVERY_EVENT.ATTEMPT_SUPERSEDED,
        generation,
      });
      return;
    }
    this.pauseForOffline();
  }

  clearRetryTimer() {
    if (this.runtime.retryTimer !== null) {
      this.windowTarget.clearTimeout(this.runtime.retryTimer);
      this.runtime.retryTimer = null;
    }
  }

  isCurrent(generation) {
    return (
      this.state.node.type !== FOREGROUND_RECOVERY_NODE.DETACHED &&
      this.state.observation.visibility === "visible" &&
      generation === this.state.generation
    );
  }

  apply(event) {
    const next = transitionForegroundRecovery(this.state, event);
    if (next === this.state) {
      return false;
    }
    this.state = next;
    this.onStateChange(this.snapshot());
    return true;
  }
}
