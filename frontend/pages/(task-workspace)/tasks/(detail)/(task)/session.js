import { getTask, taskAbsence, taskResponseError } from "#app/api.js";
import { TASK_TRANSPORT_STATE } from "../../runtime-state.js";
import { TaskStreamLifecycle } from "../../stream.js";

// From a channel's opening to its first bootstrap, which the server keeps small
// whatever the conversation's size. What follows has no limit here: the server
// ends its own reading, and the live connection judges the link.
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 8_000;
const TASK_DETAIL_SESSION_PHASE = Object.freeze({
  INACTIVE: "inactive",
  WAITING_BOOTSTRAP: "waiting-bootstrap",
  WAITING_READABLE: "waiting-readable",
  STREAMING: "streaming",
  REST_FALLBACK: "rest-fallback",
  UNAVAILABLE: "unavailable",
  // The Task is archived or Caffold cannot find it. It stays so, through
  // hiding and foreground recovery, until the owner opens a Task again.
  ABSENT: "absent",
});
const TASK_DETAIL_SESSION_EVENT = Object.freeze({
  ACTIVATE: "activate",
  RECOVER: "recover",
  ACCEPT_LOADING_BOOTSTRAP: "accept-loading-bootstrap",
  ACCEPT_READABLE_BOOTSTRAP: "accept-readable-bootstrap",
  ACCEPT_READABLE_SYNC: "accept-readable-sync",
  START_FALLBACK: "start-fallback",
  FINISH_FALLBACK: "finish-fallback",
  SUSPEND: "suspend",
  DEACTIVATE: "deactivate",
  SOURCE_ERROR: "source-error",
  SUBJECT_ABSENT: "subject-absent",
});
// The complete transition table; any other pair is rejected.
const TASK_DETAIL_SESSION_TRANSITIONS = Object.freeze({
  [TASK_DETAIL_SESSION_PHASE.INACTIVE]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.RECOVER]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.SUBJECT_ABSENT]: TASK_DETAIL_SESSION_PHASE.ABSENT,
  }),
  [TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.SOURCE_ERROR]: TASK_DETAIL_SESSION_PHASE.UNAVAILABLE,
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.RECOVER]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.ACCEPT_LOADING_BOOTSTRAP]:
      TASK_DETAIL_SESSION_PHASE.WAITING_READABLE,
    [TASK_DETAIL_SESSION_EVENT.ACCEPT_READABLE_BOOTSTRAP]:
      TASK_DETAIL_SESSION_PHASE.STREAMING,
    [TASK_DETAIL_SESSION_EVENT.START_FALLBACK]:
      TASK_DETAIL_SESSION_PHASE.REST_FALLBACK,
    [TASK_DETAIL_SESSION_EVENT.SUBJECT_ABSENT]: TASK_DETAIL_SESSION_PHASE.ABSENT,
    [TASK_DETAIL_SESSION_EVENT.SUSPEND]: TASK_DETAIL_SESSION_PHASE.INACTIVE,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.WAITING_READABLE]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.SOURCE_ERROR]: TASK_DETAIL_SESSION_PHASE.UNAVAILABLE,
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.RECOVER]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.ACCEPT_READABLE_SYNC]:
      TASK_DETAIL_SESSION_PHASE.STREAMING,
    [TASK_DETAIL_SESSION_EVENT.START_FALLBACK]:
      TASK_DETAIL_SESSION_PHASE.REST_FALLBACK,
    [TASK_DETAIL_SESSION_EVENT.SUBJECT_ABSENT]: TASK_DETAIL_SESSION_PHASE.ABSENT,
    [TASK_DETAIL_SESSION_EVENT.SUSPEND]: TASK_DETAIL_SESSION_PHASE.INACTIVE,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.STREAMING]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.SOURCE_ERROR]: TASK_DETAIL_SESSION_PHASE.UNAVAILABLE,
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.RECOVER]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.SUBJECT_ABSENT]: TASK_DETAIL_SESSION_PHASE.ABSENT,
    [TASK_DETAIL_SESSION_EVENT.SUSPEND]: TASK_DETAIL_SESSION_PHASE.INACTIVE,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.REST_FALLBACK]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.SOURCE_ERROR]: TASK_DETAIL_SESSION_PHASE.UNAVAILABLE,
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.RECOVER]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.FINISH_FALLBACK]:
      TASK_DETAIL_SESSION_PHASE.UNAVAILABLE,
    [TASK_DETAIL_SESSION_EVENT.SUBJECT_ABSENT]: TASK_DETAIL_SESSION_PHASE.ABSENT,
    [TASK_DETAIL_SESSION_EVENT.SUSPEND]: TASK_DETAIL_SESSION_PHASE.INACTIVE,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.UNAVAILABLE]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.SOURCE_ERROR]: TASK_DETAIL_SESSION_PHASE.UNAVAILABLE,
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.RECOVER]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.SUBJECT_ABSENT]: TASK_DETAIL_SESSION_PHASE.ABSENT,
    [TASK_DETAIL_SESSION_EVENT.SUSPEND]: TASK_DETAIL_SESSION_PHASE.INACTIVE,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
  [TASK_DETAIL_SESSION_PHASE.ABSENT]: Object.freeze({
    [TASK_DETAIL_SESSION_EVENT.ACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP,
    [TASK_DETAIL_SESSION_EVENT.SUBJECT_ABSENT]: TASK_DETAIL_SESSION_PHASE.ABSENT,
    [TASK_DETAIL_SESSION_EVENT.DEACTIVATE]:
      TASK_DETAIL_SESSION_PHASE.INACTIVE,
  }),
});

export class TaskDetailSession {
  constructor(callbacks = {}) {
    this.onTaskSync = callbacks.onTaskSync ?? (() => {});
    this.onTaskState = callbacks.onTaskState ?? (() => {});
    this.onTaskEvent = callbacks.onTaskEvent ?? (() => {});
    this.onFallbackDetail = callbacks.onFallbackDetail ?? (() => false);
    this.onStateChange = callbacks.onStateChange ?? (() => {});
    this.onSubjectAbsent = callbacks.onSubjectAbsent ?? (() => {});
    this.loadDetail = callbacks.loadDetail ?? getTask;
    this.bootstrapTimeoutMs =
      callbacks.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    this.phase = TASK_DETAIL_SESSION_PHASE.INACTIVE;
    // Why the Task is absent, while the phase says it is.
    this.absence = null;
    this.readable = false;
    this.bootstrap = null;
    this.attempt = null;
    this.transport = new TaskStreamLifecycle({
      subscribe: callbacks.subscribe
        ? (threadId, listener) => callbacks.subscribe(threadId, listener)
        : null,
      onEvent: (type, event, threadId, metadata) =>
        this.handleEvent(type, event, threadId, metadata),
      waitUntilReady: (threadId, isCurrent, metadata) =>
        this.beginBootstrap(threadId, isCurrent, metadata),
      onConnectionInvalidated: (source) => this.closeBootstrap(source),
      onStateChange: (state, previousState) =>
        this.handleTransportStateChange(state, previousState),
      onSubjectGone: (absence, threadId) =>
        this.handleSubjectGone(absence, threadId),
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
    if (!this.accepts(TASK_DETAIL_SESSION_EVENT.RECOVER)) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    return this.startAttempt(this.threadId, {
      readable: this.readable,
      validating: true,
      event: TASK_DETAIL_SESSION_EVENT.RECOVER,
    });
  }

  suspend() {
    this.closeBootstrap();
    this.settleAttempt({ ok: false, stale: true });
    this.transport.suspend();
    this.transition(TASK_DETAIL_SESSION_EVENT.SUSPEND);
  }

  // Another request about this Task found it archived or missing. The Task
  // stream hears it first, and its end reaches this session as for a refused
  // channel.
  subjectGone(threadId, absence) {
    if (normalizeThreadId(threadId) === this.threadId) {
      this.transport.subjectGone(absence);
    }
  }

  deactivate() {
    this.closeBootstrap();
    this.settleAttempt({ ok: false, stale: true });
    this.transport.deactivate();
    this.readable = false;
    this.transition(TASK_DETAIL_SESSION_EVENT.DEACTIVATE);
  }

  startAttempt(
    threadId,
    {
      readable,
      validating = false,
      event = TASK_DETAIL_SESSION_EVENT.ACTIVATE,
    } = {},
  ) {
    const nextThreadId = normalizeThreadId(threadId);
    if (!nextThreadId) {
      this.deactivate();
      return Promise.resolve({ ok: false, stale: true });
    }
    const attempt = this.createAttempt(nextThreadId, readable, event);
    this.transport.activate(nextThreadId, {
      force: true,
      validating,
    });
    return attempt.promise;
  }

  createAttempt(threadId, readable, event = TASK_DETAIL_SESSION_EVENT.ACTIVATE) {
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
    this.transition(event);
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
      pendingState: null,
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
      bootstrap.pendingState = null;
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
    bootstrap.pendingState = null;
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
    if (type === "task-state") {
      this.handleTaskState(bootstrap, message);
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
    if (Array.isArray(message.error?.allowedActions)) {
      this.transition(TASK_DETAIL_SESSION_EVENT.SOURCE_ERROR);
      bootstrap.pendingEvents = [];
      bootstrap.pendingState = null;
      readyBootstrap(bootstrap);
      this.settleAttempt({ ok: false, error: taskResponseError(message.error) });
      return;
    }
    if (!message.detail?.task) {
      if (initial) {
        this.transition(
          TASK_DETAIL_SESSION_EVENT.ACCEPT_LOADING_BOOTSTRAP,
        );
        readyBootstrap(bootstrap);
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
    const pendingState = bootstrap.pendingState;
    bootstrap.pendingEvents = [];
    bootstrap.pendingState = null;
    for (const pendingEvent of pendingEvents) {
      this.onTaskEvent(pendingEvent);
    }
    if (pendingState) {
      this.onTaskState(pendingState);
    }
    readyBootstrap(bootstrap);
    this.settleAttempt({
      ok: true,
      detail: message.detail,
      source: "stream",
    });
  }

  // The Task's state beside its conversation. Until the conversation is
  // readable only the newest is kept, to follow the readable sync.
  handleTaskState(bootstrap, message) {
    if (this.phase === TASK_DETAIL_SESSION_PHASE.STREAMING) {
      this.onTaskState(message);
      return;
    }
    if (
      (this.phase === TASK_DETAIL_SESSION_PHASE.WAITING_BOOTSTRAP ||
        this.phase === TASK_DETAIL_SESSION_PHASE.WAITING_READABLE) &&
      !(Number(bootstrap.pendingState?.revision) > Number(message.revision))
    ) {
      bootstrap.pendingState = message;
    }
  }

  handleSubjectGone(absence, threadId) {
    if (threadId !== this.threadId) {
      return;
    }
    this.closeBootstrap();
    if (!this.transition(TASK_DETAIL_SESSION_EVENT.SUBJECT_ABSENT)) {
      return;
    }
    this.absence = absence;
    this.settleAttempt({ ok: false, absence });
    this.onSubjectAbsent(absence);
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
    const absence = taskAbsence(error);
    if (absence) {
      this.transport.subjectGone(absence);
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

  accepts(event) {
    return Boolean(TASK_DETAIL_SESSION_TRANSITIONS[this.phase]?.[event]);
  }

  // The one place the phase changes. False when the table rejects the event.
  transition(event) {
    const next = TASK_DETAIL_SESSION_TRANSITIONS[this.phase]?.[event];
    if (!next) {
      return false;
    }
    this.phase = next;
    if (next !== TASK_DETAIL_SESSION_PHASE.ABSENT) {
      this.absence = null;
    }
    return true;
  }
}

// The channel answered, so its Task stream is ready; the bootstrap stays the
// place later messages are matched against.
function readyBootstrap(bootstrap) {
  if (bootstrap.settled) {
    return;
  }
  bootstrap.settled = true;
  window.clearTimeout(bootstrap.timer);
  bootstrap.resolve(true);
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
