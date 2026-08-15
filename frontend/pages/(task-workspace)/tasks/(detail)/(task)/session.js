import { getTask, taskStreamUrl } from "../../../../../api.js";
import { TASK_TRANSPORT_STATE } from "../../runtime-state.js";
import { TaskStreamLifecycle } from "../../stream.js";

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 8_000;
const TASK_DETAIL_SESSION_PHASE = Object.freeze({
  INACTIVE: "inactive",
  WAITING_BOOTSTRAP: "waiting-bootstrap",
  WAITING_READABLE: "waiting-readable",
  STREAMING: "streaming",
  REST_FALLBACK: "rest-fallback",
  UNAVAILABLE: "unavailable",
});
const TASK_DETAIL_SESSION_EVENT = Object.freeze({
  ACTIVATE: "activate",
  ACCEPT_LOADING_BOOTSTRAP: "accept-loading-bootstrap",
  ACCEPT_READABLE_BOOTSTRAP: "accept-readable-bootstrap",
  ACCEPT_READABLE_SYNC: "accept-readable-sync",
  START_FALLBACK: "start-fallback",
  FINISH_FALLBACK: "finish-fallback",
  DEACTIVATE: "deactivate",
});
const TASK_DETAIL_SESSION_TRANSITIONS = Object.freeze({
  [TASK_DETAIL_SESSION_PHASE.INACTIVE]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
  }),
  [TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.ACCEPT_LOADING_BOOTSTRAP]:
      TASK_DETAIL_SESSION_PHASE.WAITING_READABLE,
    [TASK_DETAIL_SESSION_EVENT.ACCEPT_READABLE_BOOTSTRAP]:
      TASK_DETAIL_SESSION_PHASE.STREAMING,
    [TASK_DETAIL_SESSION_EVENT.START_FALLBACK]:
      TASK_DETAIL_SESSION_PHASE.REST_FALLBACK,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.WAITING_READABLE]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.ACCEPT_READABLE_SYNC]:
      TASK_DETAIL_SESSION_PHASE.STREAMING,
    [TASK_DETAIL_SESSION_EVENT.START_FALLBACK]:
      TASK_DETAIL_SESSION_PHASE.REST_FALLBACK,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.STREAMING]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.REST_FALLBACK]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.FINISH_FALLBACK]:
      TASK_DETAIL_SESSION_PHASE.UNAVAILABLE,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.UNAVAILABLE]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
});

export class TaskDetailSession {
  constructor(callbacks = {}) {
    this.onTaskSync = callbacks.onTaskSync ?? (() => {});
    this.onTaskEvent = callbacks.onTaskEvent ?? (() => {});
    this.onFallbackDetail = callbacks.onFallbackDetail ?? (() => false);
    this.onStateChange = callbacks.onStateChange ?? (() => {});
    this.loadDetail = callbacks.loadDetail ?? getTask;
    this.bootstrapTimeoutMs =
      callbacks.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    this.phase = TASK_DETAIL_SESSION_PHASE.INACTIVE;
    this.readable = false;
    this.bootstrap = null;
    this.attempt = null;
    this.transport = new TaskStreamLifecycle({
      createUrl: (threadId) => taskStreamUrl(threadId),
      eventTypes: ["task-sync", "task-event"],
      onEvent: (type, event, threadId, metadata) =>
        this.handleEvent(type, event, threadId, metadata),
      waitUntilReady: (threadId, isCurrent, metadata) =>
        this.beginBootstrap(threadId, isCurrent, metadata),
      onConnectionInvalidated: (source) => this.closeBootstrap(source),
      onStateChange: (state, previousState) =>
        this.handleTransportStateChange(state, previousState),
      connectionTimeoutMs:
        callbacks.connectionTimeoutMs ?? this.bootstrapTimeoutMs,
      reconnectTimeoutMs: callbacks.reconnectTimeoutMs,
      retryDelaysMs: callbacks.retryDelaysMs,
    });
  }

  get threadId() {
    return this.transport.contextKey;
  }

  get state() {
    return this.transport.state;
  }

  open(threadId) {
    return this.startAttempt(threadId, { readable: false });
  }

  attach(threadId) {
    const nextThreadId = normalizeThreadId(threadId);
    if (!nextThreadId) {
      this.deactivate();
      return Promise.resolve({ ok: false, stale: true });
    }
    this.readable = true;
    if (
      this.threadId === nextThreadId &&
      this.phase !== TASK_DETAIL_SESSION_PHASE.INACTIVE &&
      this.phase !== TASK_DETAIL_SESSION_PHASE.UNAVAILABLE
    ) {
      if (this.attempt) {
        this.attempt.readable = true;
        return this.attempt.promise;
      }
      return Promise.resolve({ ok: true, skipped: true });
    }
    return this.startAttempt(nextThreadId, { readable: true });
  }

  retry() {
    return this.startAttempt(this.threadId, { readable: this.readable });
  }

  recover() {
    if (!this.threadId || document.visibilityState !== "visible") {
      return Promise.resolve({ ok: false, stale: true });
    }
    return this.startAttempt(this.threadId, {
      readable: this.readable,
      validating: true,
    });
  }

  suspend() {
    this.closeBootstrap();
    this.settleAttempt({ ok: false, stale: true });
    this.transport.suspend();
    this.transition(TASK_DETAIL_SESSION_EVENT.DEACTIVATE);
  }

  deactivate() {
    this.closeBootstrap();
    this.settleAttempt({ ok: false, stale: true });
    this.transport.deactivate();
    this.readable = false;
    this.transition(TASK_DETAIL_SESSION_EVENT.DEACTIVATE);
  }

  startAttempt(threadId, { readable, validating = false } = {}) {
    const nextThreadId = normalizeThreadId(threadId);
    if (!nextThreadId) {
      this.deactivate();
      return Promise.resolve({ ok: false, stale: true });
    }
    const attempt = this.createAttempt(nextThreadId, readable);
    this.transport.activate(nextThreadId, {
      force: true,
      validating,
    });
    return attempt.promise;
  }

  createAttempt(threadId, readable) {
    this.closeBootstrap();
    this.settleAttempt({ ok: false, stale: true });
    let resolveAttempt;
    const promise = new Promise((resolve) => {
      resolveAttempt = resolve;
    });
    const attempt = {
      threadId,
      readable: Boolean(readable),
      promise,
      resolve: resolveAttempt,
    };
    this.attempt = attempt;
    this.readable = attempt.readable;
    this.transition(TASK_DETAIL_SESSION_EVENT.ACTIVATE);
    return attempt;
  }

  beginBootstrap(threadId, isCurrent, { source } = {}) {
    this.closeBootstrap();
    if (!source || !isCurrent()) {
      return Promise.resolve(false);
    }
    if (!this.attempt || this.attempt.threadId !== threadId) {
      this.createAttempt(threadId, this.readable);
    }
    this.transition(TASK_DETAIL_SESSION_EVENT.ACTIVATE);

    let resolveBootstrap;
    let rejectBootstrap;
    const promise = new Promise((resolve, reject) => {
      resolveBootstrap = resolve;
      rejectBootstrap = reject;
    });
    const bootstrap = {
      source,
      threadId,
      isCurrent,
      pendingEvents: [],
      settled: false,
      resolve: resolveBootstrap,
      reject: rejectBootstrap,
      timer: null,
    };
    bootstrap.timer = window.setTimeout(() => {
      if (this.bootstrap !== bootstrap || bootstrap.settled) {
        return;
      }
      bootstrap.settled = true;
      bootstrap.pendingEvents = [];
      bootstrap.reject(new Error("Task detail stream bootstrap timed out."));
    }, this.bootstrapTimeoutMs);
    this.bootstrap = bootstrap;
    return promise;
  }

  closeBootstrap(source = null) {
    const bootstrap = this.bootstrap;
    if (!bootstrap || (source && bootstrap.source !== source)) {
      return;
    }
    this.bootstrap = null;
    window.clearTimeout(bootstrap.timer);
    bootstrap.pendingEvents = [];
    if (!bootstrap.settled) {
      bootstrap.settled = true;
      bootstrap.resolve(false);
    }
  }

  handleEvent(type, event, threadId, { source } = {}) {
    const message = parseJson(event.data);
    const bootstrap = this.bootstrap;
    if (
      message?.threadId !== threadId ||
      !bootstrap ||
      bootstrap.source !== source ||
      bootstrap.threadId !== threadId ||
      !bootstrap.isCurrent()
    ) {
      return;
    }

    if (type === "task-sync") {
      this.handleTaskSync(bootstrap, message);
      return;
    }
    if (this.phase === TASK_DETAIL_SESSION_PHASE.STREAMING) {
      this.onTaskEvent(message);
      return;
    }
    if (
      this.phase === TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP ||
      this.phase === TASK_DETAIL_SESSION_PHASE.WAITING_READABLE
    ) {
      bootstrap.pendingEvents.push(message);
    }
  }

  handleTaskSync(bootstrap, message) {
    if (message.reason === "external-sync-start") {
      return;
    }
    const initial =
      this.phase === TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP;
    if (initial && message.reason !== "stream-bootstrap") {
      return;
    }
    if (!initial && message.reason === "stream-bootstrap") {
      return;
    }
    if (this.onTaskSync(message) === false) {
      return;
    }
    if (!message.detail?.task) {
      if (initial) {
        this.transition(
          TASK_DETAIL_SESSION_EVENT.ACCEPT_LOADING_BOOTSTRAP,
        );
      }
      return;
    }

    const awaitingReadable =
      initial || this.phase === TASK_DETAIL_SESSION_PHASE.WAITING_READABLE;
    if (!awaitingReadable) {
      return;
    }
    this.readable = true;
    this.transition(
      initial
        ? TASK_DETAIL_SESSION_EVENT.ACCEPT_READABLE_BOOTSTRAP
        : TASK_DETAIL_SESSION_EVENT.ACCEPT_READABLE_SYNC,
    );
    const pendingEvents = bootstrap.pendingEvents;
    bootstrap.pendingEvents = [];
    for (const pendingEvent of pendingEvents) {
      this.onTaskEvent(pendingEvent);
    }
    if (!bootstrap.settled) {
      bootstrap.settled = true;
      window.clearTimeout(bootstrap.timer);
      bootstrap.resolve(true);
    }
    this.settleAttempt({
      ok: true,
      detail: message.detail,
      source: "stream",
    });
  }

  handleTransportStateChange(state, previousState) {
    if (
      state === TASK_TRANSPORT_STATE.RECONNECTING &&
      this.phase === TASK_DETAIL_SESSION_PHASE.STREAMING &&
      this.threadId
    ) {
      this.createAttempt(this.threadId, true);
    }
    if (state === TASK_TRANSPORT_STATE.UNAVAILABLE) {
      this.startFallback();
    }
    this.onStateChange(state, previousState);
  }

  startFallback() {
    const attempt = this.attempt;
    if (
      !attempt ||
      (this.phase !== TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP &&
        this.phase !== TASK_DETAIL_SESSION_PHASE.WAITING_READABLE)
    ) {
      return;
    }
    this.closeBootstrap();
    this.transition(TASK_DETAIL_SESSION_EVENT.START_FALLBACK);
    void this.runFallback(attempt);
  }

  async runFallback(attempt) {
    let detail = null;
    let error = null;
    try {
      detail = await this.loadDetail(attempt.threadId);
      if (!detail?.task) {
        error = new Error(
          "Task detail fallback did not return a readable Task.",
        );
      } else if (
        this.isCurrentFallback(attempt) &&
        this.onFallbackDetail(detail, {
          threadId: attempt.threadId,
          recovery: attempt.readable,
        }) === false
      ) {
        error = new Error("Task detail fallback could not be applied.");
      }
    } catch (fallbackError) {
      error = fallbackError;
    }
    if (!this.isCurrentFallback(attempt)) {
      return;
    }
    this.transition(TASK_DETAIL_SESSION_EVENT.FINISH_FALLBACK);
    if (error) {
      this.settleAttempt({ ok: false, error });
      return;
    }
    this.readable = true;
    this.settleAttempt({
      ok: true,
      detail,
      fallback: true,
      source: "rest",
    });
  }

  isCurrentFallback(attempt) {
    return (
      this.attempt === attempt &&
      this.phase === TASK_DETAIL_SESSION_PHASE.REST_FALLBACK &&
      this.threadId === attempt.threadId
    );
  }

  settleAttempt(outcome) {
    const attempt = this.attempt;
    if (!attempt) {
      return;
    }
    this.attempt = null;
    attempt.resolve(outcome);
  }

  transition(event) {
    this.phase =
      TASK_DETAIL_SESSION_TRANSITIONS[this.phase]?.[event] ?? this.phase;
  }
}

function normalizeThreadId(threadId) {
  return `${threadId ?? ""}`.trim();
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
