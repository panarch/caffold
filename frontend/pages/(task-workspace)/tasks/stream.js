import { TASK_TRANSPORT_STATE } from "./runtime-state.js";

const DEFAULT_RECONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);

export class TaskStreamLifecycle {
  constructor(options = {}) {
    this.createUrl = options.createUrl ?? (() => "");
    this.eventTypes = [...(options.eventTypes ?? [])];
    this.onEvent = options.onEvent ?? (() => {});
    this.onReconcile = options.onReconcile ?? (() => Promise.resolve());
    this.onStateChange = options.onStateChange ?? (() => {});
    this.reconnectTimeoutMs =
      options.reconnectTimeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS;
    this.retryDelaysMs = [
      ...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS),
    ];
    this.contextKey = "";
    this.source = null;
    this.state = TASK_TRANSPORT_STATE.IDLE;
    this.generation = 0;
    this.reconcileGeneration = 0;
    this.reconciliation = null;
    this.reconnectTimer = null;
    this.retryTimer = null;
    this.retryAttempt = 0;
    this.hasConnected = false;
    this.needsReconcile = false;
    this.visibilityListenerAttached = false;
    this.boundVisibilityChange = () => this.visibilityChanged();
  }

  activate(contextKey, { force = false } = {}) {
    const nextContextKey = `${contextKey ?? ""}`.trim();
    const sameContext = this.contextKey === nextContextKey;
    if (
      !force &&
      sameContext &&
      (this.source ||
        this.retryTimer !== null ||
        document.visibilityState !== "visible")
    ) {
      return;
    }

    const recovering =
      sameContext &&
      Boolean(nextContextKey) &&
      (force || this.hasConnected || this.needsReconcile);
    this.resetConnection();
    this.contextKey = nextContextKey;
    this.retryAttempt = 0;
    if (!sameContext) {
      this.hasConnected = false;
      this.needsReconcile = false;
    } else if (recovering) {
      this.needsReconcile = true;
    }

    if (!nextContextKey) {
      this.detachVisibilityListener();
      return;
    }
    this.attachVisibilityListener();
    if (document.visibilityState === "visible") {
      this.openConnection(nextContextKey, this.generation);
    }
  }

  retry() {
    if (this.contextKey) {
      this.activate(this.contextKey, { force: true });
    }
  }

  deactivate() {
    this.resetConnection();
    this.contextKey = "";
    this.hasConnected = false;
    this.needsReconcile = false;
    this.retryAttempt = 0;
    this.detachVisibilityListener();
  }

  openConnection(contextKey, generation) {
    if (
      this.source ||
      this.retryTimer !== null ||
      document.visibilityState !== "visible" ||
      !this.isCurrentGeneration(contextKey, generation)
    ) {
      return;
    }
    if (!("EventSource" in window)) {
      this.setState(TASK_TRANSPORT_STATE.UNAVAILABLE);
      return;
    }

    let source;
    try {
      source = new EventSource(this.createUrl(contextKey));
    } catch {
      this.needsReconcile = true;
      this.replaceAfterFailure(null, contextKey, generation);
      return;
    }

    this.source = source;
    this.setState(
      this.needsReconcile
        ? TASK_TRANSPORT_STATE.RECONNECTING
        : TASK_TRANSPORT_STATE.CONNECTING,
    );
    source.addEventListener("open", () => {
      void this.opened(source, contextKey, generation);
    });
    source.addEventListener("error", () => {
      this.errored(source, contextKey, generation);
    });
    for (const type of this.eventTypes) {
      source.addEventListener(type, (event) => {
        if (this.isCurrent(source, contextKey, generation)) {
          this.onEvent(type, event, contextKey);
        }
      });
    }
  }

  async opened(source, contextKey, generation) {
    if (!this.isCurrent(source, contextKey, generation)) {
      return;
    }
    this.clearReconnectTimer();
    this.hasConnected = true;
    if (!this.needsReconcile) {
      this.retryAttempt = 0;
      this.setState(TASK_TRANSPORT_STATE.READY);
      return;
    }

    this.setState(TASK_TRANSPORT_STATE.RECONNECTING);
    const reconcileGeneration = this.reconcileGeneration;
    const outcome = await this.requestReconciliation(
      contextKey,
      generation,
      reconcileGeneration,
      { recovery: true },
    );
    if (
      !this.isCurrent(source, contextKey, generation) ||
      reconcileGeneration !== this.reconcileGeneration
    ) {
      return;
    }
    if (!outcome.ok) {
      this.replaceAfterFailure(source, contextKey, generation);
      return;
    }

    this.needsReconcile = false;
    this.retryAttempt = 0;
    this.setState(TASK_TRANSPORT_STATE.READY);
  }

  errored(source, contextKey, generation) {
    if (!this.isCurrent(source, contextKey, generation)) {
      return;
    }
    this.needsReconcile = true;
    this.invalidateReconciliation();
    if (source.readyState === 2) {
      this.replaceAfterFailure(source, contextKey, generation);
      return;
    }

    this.setState(TASK_TRANSPORT_STATE.RECONNECTING);
    if (this.reconnectTimer !== null) {
      return;
    }
    this.reconnectTimer = window.setTimeout(() => {
      if (!this.isCurrent(source, contextKey, generation)) {
        return;
      }
      this.reconnectTimer = null;
      this.replaceAfterFailure(source, contextKey, generation);
    }, this.reconnectTimeoutMs);
  }

  replaceAfterFailure(source, contextKey, generation) {
    if (
      source
        ? !this.isCurrent(source, contextKey, generation)
        : !this.isCurrentGeneration(contextKey, generation)
    ) {
      return;
    }
    this.needsReconcile = true;
    this.invalidateSource();
    this.scheduleRetry(contextKey, this.generation);
  }

  scheduleRetry(contextKey, generation) {
    const delayMs = this.retryDelaysMs[this.retryAttempt];
    if (!Number.isFinite(delayMs)) {
      this.setState(TASK_TRANSPORT_STATE.UNAVAILABLE);
      return;
    }
    this.retryAttempt += 1;
    this.setState(TASK_TRANSPORT_STATE.RECONNECTING);
    this.retryTimer = window.setTimeout(() => {
      if (!this.isCurrentGeneration(contextKey, generation)) {
        return;
      }
      this.retryTimer = null;
      this.openConnection(contextKey, generation);
    }, Math.max(0, delayMs));
  }

  requestReconciliation(
    contextKey = this.contextKey,
    generation = this.generation,
    reconcileGeneration = this.reconcileGeneration,
    { recovery = false } = {},
  ) {
    if (
      !contextKey ||
      !this.isCurrentReconciliation(
        contextKey,
        generation,
        reconcileGeneration,
      )
    ) {
      return Promise.resolve({ ok: false, stale: true });
    }
    if (
      this.reconciliation?.contextKey === contextKey &&
      this.reconciliation?.generation === generation &&
      this.reconciliation?.reconcileGeneration === reconcileGeneration
    ) {
      this.reconciliation.recovery ||= recovery;
      this.reconciliation.dirty = true;
      return this.reconciliation.promise;
    }

    const reconciliation = {
      contextKey,
      generation,
      reconcileGeneration,
      recovery,
      dirty: false,
      promise: null,
    };
    reconciliation.promise = (async () => {
      let result = null;
      do {
        reconciliation.dirty = false;
        try {
          result = await this.onReconcile(
            contextKey,
            () =>
              this.isCurrentReconciliation(
                contextKey,
                generation,
                reconcileGeneration,
              ),
            { recovery: reconciliation.recovery },
          );
          if (result === false) {
            throw new Error("Task stream reconciliation failed.");
          }
        } catch (error) {
          return { ok: false, error };
        }
      } while (
        reconciliation.dirty &&
        this.isCurrentReconciliation(
          contextKey,
          generation,
          reconcileGeneration,
        )
      );
      return { ok: true, result };
    })().finally(() => {
      if (this.reconciliation === reconciliation) {
        this.reconciliation = null;
      }
    });
    this.reconciliation = reconciliation;
    return reconciliation.promise;
  }

  visibilityChanged() {
    if (!this.contextKey) {
      return;
    }
    if (document.visibilityState !== "visible") {
      this.needsReconcile = true;
      this.resetConnection();
      return;
    }

    this.needsReconcile = true;
    this.retryAttempt = 0;
    if (this.source?.readyState === 1) {
      void this.opened(this.source, this.contextKey, this.generation);
      return;
    }
    this.openConnection(this.contextKey, this.generation);
  }

  resetConnection() {
    this.clearReconnectTimer();
    this.clearRetryTimer();
    this.invalidateSource();
    this.state = TASK_TRANSPORT_STATE.IDLE;
  }

  invalidateSource() {
    this.clearReconnectTimer();
    this.source?.close();
    this.source = null;
    this.generation += 1;
    this.invalidateReconciliation();
  }

  invalidateReconciliation() {
    this.reconcileGeneration += 1;
    this.reconciliation = null;
  }

  clearReconnectTimer() {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  clearRetryTimer() {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  isCurrent(source, contextKey, generation) {
    return (
      this.source === source &&
      this.isCurrentGeneration(contextKey, generation)
    );
  }

  isCurrentGeneration(contextKey, generation) {
    return this.contextKey === contextKey && this.generation === generation;
  }

  isCurrentReconciliation(contextKey, generation, reconcileGeneration) {
    return (
      this.isCurrentGeneration(contextKey, generation) &&
      this.reconcileGeneration === reconcileGeneration
    );
  }

  setState(state, { notify = true } = {}) {
    if (this.state === state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    if (notify) {
      this.onStateChange(state, previousState);
    }
  }

  attachVisibilityListener() {
    if (this.visibilityListenerAttached) {
      return;
    }
    this.visibilityListenerAttached = true;
    document.addEventListener("visibilitychange", this.boundVisibilityChange);
  }

  detachVisibilityListener() {
    if (!this.visibilityListenerAttached) {
      return;
    }
    this.visibilityListenerAttached = false;
    document.removeEventListener("visibilitychange", this.boundVisibilityChange);
  }
}
