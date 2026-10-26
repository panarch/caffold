import {
  getTask,
  type Task,
  type TaskAbsence,
  type TaskContextUsage,
  type TaskDetail,
  type TaskEvent,
  type TaskFileLink,
  taskAbsence,
  taskResponseError,
} from "#app/api.ts";
import type {
  LiveSubscription,
  LiveSubscriptionListener,
} from "#app/pages/(task-workspace)/live-updates.ts";
import {
  TASK_TRANSPORT_STATE,
  type TaskTransportState,
} from "../../runtime-state.ts";
import { TaskStreamLifecycle } from "../../stream.ts";

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

type TaskDetailSessionPhase =
  (typeof TASK_DETAIL_SESSION_PHASE)[keyof typeof TASK_DETAIL_SESSION_PHASE];

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

type TaskDetailSessionEvent =
  (typeof TASK_DETAIL_SESSION_EVENT)[keyof typeof TASK_DETAIL_SESSION_EVENT];

const PHASE = TASK_DETAIL_SESSION_PHASE;
const EVENT = TASK_DETAIL_SESSION_EVENT;

// The complete transition table; any other pair is rejected.
const TASK_DETAIL_SESSION_TRANSITIONS: Readonly<
  Record<
    TaskDetailSessionPhase,
    Partial<Record<TaskDetailSessionEvent, TaskDetailSessionPhase>>
  >
> = Object.freeze({
  [PHASE.INACTIVE]: Object.freeze({
    [EVENT.ACTIVATE]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.RECOVER]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.SUBJECT_ABSENT]: PHASE.ABSENT,
  }),
  [PHASE.WAITING_BOOTSTRAP]: Object.freeze({
    [EVENT.SOURCE_ERROR]: PHASE.UNAVAILABLE,
    [EVENT.ACTIVATE]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.RECOVER]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.ACCEPT_LOADING_BOOTSTRAP]: PHASE.WAITING_READABLE,
    [EVENT.ACCEPT_READABLE_BOOTSTRAP]: PHASE.STREAMING,
    [EVENT.START_FALLBACK]: PHASE.REST_FALLBACK,
    [EVENT.SUBJECT_ABSENT]: PHASE.ABSENT,
    [EVENT.SUSPEND]: PHASE.INACTIVE,
    [EVENT.DEACTIVATE]: PHASE.INACTIVE,
  }),
  [PHASE.WAITING_READABLE]: Object.freeze({
    [EVENT.SOURCE_ERROR]: PHASE.UNAVAILABLE,
    [EVENT.ACTIVATE]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.RECOVER]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.ACCEPT_READABLE_SYNC]: PHASE.STREAMING,
    [EVENT.START_FALLBACK]: PHASE.REST_FALLBACK,
    [EVENT.SUBJECT_ABSENT]: PHASE.ABSENT,
    [EVENT.SUSPEND]: PHASE.INACTIVE,
    [EVENT.DEACTIVATE]: PHASE.INACTIVE,
  }),
  [PHASE.STREAMING]: Object.freeze({
    [EVENT.SOURCE_ERROR]: PHASE.UNAVAILABLE,
    [EVENT.ACTIVATE]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.RECOVER]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.SUBJECT_ABSENT]: PHASE.ABSENT,
    [EVENT.SUSPEND]: PHASE.INACTIVE,
    [EVENT.DEACTIVATE]: PHASE.INACTIVE,
  }),
  [PHASE.REST_FALLBACK]: Object.freeze({
    [EVENT.SOURCE_ERROR]: PHASE.UNAVAILABLE,
    [EVENT.ACTIVATE]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.RECOVER]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.FINISH_FALLBACK]: PHASE.UNAVAILABLE,
    [EVENT.SUBJECT_ABSENT]: PHASE.ABSENT,
    [EVENT.SUSPEND]: PHASE.INACTIVE,
    [EVENT.DEACTIVATE]: PHASE.INACTIVE,
  }),
  [PHASE.UNAVAILABLE]: Object.freeze({
    [EVENT.SOURCE_ERROR]: PHASE.UNAVAILABLE,
    [EVENT.ACTIVATE]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.RECOVER]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.SUBJECT_ABSENT]: PHASE.ABSENT,
    [EVENT.SUSPEND]: PHASE.INACTIVE,
    [EVENT.DEACTIVATE]: PHASE.INACTIVE,
  }),
  [PHASE.ABSENT]: Object.freeze({
    [EVENT.ACTIVATE]: PHASE.WAITING_BOOTSTRAP,
    [EVENT.SUBJECT_ABSENT]: PHASE.ABSENT,
    [EVENT.DEACTIVATE]: PHASE.INACTIVE,
  }),
});

// The Task's conversation as a whole: its bootstrap, a later readable sync,
// or a source error that says what may still be done with the Task.
export interface TaskSyncMessage {
  threadId: string;
  reason?: string;
  revision?: number;
  detail?: TaskDetail | null;
  error?: { allowedActions?: unknown } | null;
}

// The Task's state beside its conversation.
export interface TaskStateMessage {
  threadId: string;
  revision?: number;
  task?: Task | null;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  fastMode?: boolean;
  permissionMode?: string;
  context?: TaskContextUsage | null;
}

// One conversation item that changed.
export interface TaskEventMessage {
  threadId: string;
  event?: TaskEvent | null;
  fileLinks?: TaskFileLink[];
  eventRevision?: number;
}

// How opening, attaching, or recovering a Task ended. A readable outcome
// carries the detail it read and where from.
export interface TaskDetailOutcome {
  ok: boolean;
  stale?: boolean;
  skipped?: boolean;
  error?: unknown;
  absence?: TaskAbsence;
  detail?: TaskDetail;
  fallback?: boolean;
  source?: "stream" | "rest";
}

interface Attempt {
  threadId: string;
  readable: boolean;
  promise: Promise<TaskDetailOutcome>;
  resolve: (outcome: TaskDetailOutcome) => void;
}

interface Bootstrap {
  source: LiveSubscription;
  threadId: string;
  isCurrent: () => boolean;
  pendingEvents: TaskEventMessage[];
  pendingState: TaskStateMessage | null;
  settled: boolean;
  resolve: (ready: boolean) => void;
  reject: (error: Error) => void;
  timer: number;
}

export class TaskDetailSession {
  phase: TaskDetailSessionPhase = PHASE.INACTIVE;
  // Why the Task is absent, while the phase says it is.
  absence: TaskAbsence | null = null;
  private readonly onTaskSync: (message: TaskSyncMessage) => unknown;
  private readonly onTaskState: (message: TaskStateMessage) => unknown;
  private readonly onTaskEvent: (message: TaskEventMessage) => unknown;
  private readonly onFallbackDetail: (
    detail: TaskDetail,
    context: { threadId: string; recovery: boolean },
  ) => unknown;
  private readonly onStateChange: (
    state: TaskTransportState,
    previousState: TaskTransportState,
  ) => void;
  private readonly onSubjectAbsent: (absence: TaskAbsence) => void;
  private readonly loadDetail: (threadId: string) => Promise<TaskDetail>;
  private readonly bootstrapTimeoutMs: number;
  private readonly transport: TaskStreamLifecycle;
  private readable = false;
  private bootstrap: Bootstrap | null = null;
  private attempt: Attempt | null = null;

  constructor(
    callbacks: {
      subscribe?: (
        threadId: string,
        listener: LiveSubscriptionListener,
      ) => LiveSubscription;
      // False refuses the message.
      onTaskSync?: (message: TaskSyncMessage) => unknown;
      onTaskState?: (message: TaskStateMessage) => unknown;
      onTaskEvent?: (message: TaskEventMessage) => unknown;
      // False refuses the detail.
      onFallbackDetail?: (
        detail: TaskDetail,
        context: { threadId: string; recovery: boolean },
      ) => unknown;
      onStateChange?: (
        state: TaskTransportState,
        previousState: TaskTransportState,
      ) => void;
      onSubjectAbsent?: (absence: TaskAbsence) => void;
      loadDetail?: (threadId: string) => Promise<TaskDetail>;
      bootstrapTimeoutMs?: number;
      retryDelaysMs?: number[];
    } = {},
  ) {
    this.onTaskSync = callbacks.onTaskSync ?? (() => {});
    this.onTaskState = callbacks.onTaskState ?? (() => {});
    this.onTaskEvent = callbacks.onTaskEvent ?? (() => {});
    this.onFallbackDetail = callbacks.onFallbackDetail ?? (() => false);
    this.onStateChange = callbacks.onStateChange ?? (() => {});
    this.onSubjectAbsent = callbacks.onSubjectAbsent ?? (() => {});
    this.loadDetail = callbacks.loadDetail ?? getTask;
    this.bootstrapTimeoutMs =
      callbacks.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
    const subscribe = callbacks.subscribe;
    this.transport = new TaskStreamLifecycle({
      subscribe: subscribe
        ? (threadId, listener) => subscribe(threadId, listener)
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

  open(threadId: string | null | undefined) {
    return this.startAttempt(threadId, { readable: false });
  }

  attach(threadId: string | null | undefined): Promise<TaskDetailOutcome> {
    const nextThreadId = normalizeThreadId(threadId);
    if (!nextThreadId) {
      this.deactivate();
      return Promise.resolve({ ok: false, stale: true });
    }
    this.readable = true;
    if (
      this.threadId === nextThreadId &&
      this.phase !== PHASE.INACTIVE &&
      this.phase !== PHASE.UNAVAILABLE
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

  recover(): Promise<TaskDetailOutcome> {
    if (!this.threadId || document.visibilityState !== "visible") {
      return Promise.resolve({ ok: false, stale: true });
    }
    if (!this.accepts(EVENT.RECOVER)) {
      return Promise.resolve({ ok: true, skipped: true });
    }
    return this.startAttempt(this.threadId, {
      readable: this.readable,
      validating: true,
      event: EVENT.RECOVER,
    });
  }

  suspend() {
    this.closeBootstrap();
    this.settleAttempt({ ok: false, stale: true });
    this.transport.suspend();
    this.transition(EVENT.SUSPEND);
  }

  // Another request about this Task found it archived or missing. The Task
  // stream hears it first, and its end reaches this session as for a refused
  // channel.
  subjectGone(threadId: string | null | undefined, absence: TaskAbsence) {
    if (normalizeThreadId(threadId) === this.threadId) {
      this.transport.subjectGone(absence);
    }
  }

  deactivate() {
    this.closeBootstrap();
    this.settleAttempt({ ok: false, stale: true });
    this.transport.deactivate();
    this.readable = false;
    this.transition(EVENT.DEACTIVATE);
  }

  private startAttempt(
    threadId: string | null | undefined,
    {
      readable,
      validating = false,
      event = EVENT.ACTIVATE,
    }: {
      readable: boolean;
      validating?: boolean;
      event?: TaskDetailSessionEvent;
    },
  ): Promise<TaskDetailOutcome> {
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

  private createAttempt(
    threadId: string,
    readable: boolean,
    event: TaskDetailSessionEvent = EVENT.ACTIVATE,
  ) {
    this.closeBootstrap();
    this.settleAttempt({ ok: false, stale: true });
    let resolveAttempt: Attempt["resolve"] = () => {};
    const promise = new Promise<TaskDetailOutcome>((resolve) => {
      resolveAttempt = resolve;
    });
    const attempt: Attempt = {
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

  private beginBootstrap(
    threadId: string,
    isCurrent: () => boolean,
    { source }: { source?: LiveSubscription } = {},
  ) {
    this.closeBootstrap();
    if (!source || !isCurrent()) {
      return Promise.resolve(false);
    }
    if (!this.attempt || this.attempt.threadId !== threadId) {
      this.createAttempt(threadId, this.readable);
    }
    this.transition(EVENT.ACTIVATE);

    let resolveBootstrap: Bootstrap["resolve"] = () => {};
    let rejectBootstrap: Bootstrap["reject"] = () => {};
    const promise = new Promise<boolean>((resolve, reject) => {
      resolveBootstrap = resolve;
      rejectBootstrap = reject;
    });
    const bootstrap: Bootstrap = {
      source,
      threadId,
      isCurrent,
      pendingEvents: [],
      pendingState: null,
      settled: false,
      resolve: resolveBootstrap,
      reject: rejectBootstrap,
      timer: 0,
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

  private closeBootstrap(source: LiveSubscription | null = null) {
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

  private handleEvent(
    type: string,
    event: { data: string },
    threadId: string,
    { source }: { source?: LiveSubscription } = {},
  ) {
    const message = parseJson(event.data) as { threadId?: unknown } | null;
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
      this.handleTaskSync(bootstrap, message as TaskSyncMessage);
      return;
    }
    if (type === "task-state") {
      this.handleTaskState(bootstrap, message as TaskStateMessage);
      return;
    }
    if (this.phase === PHASE.STREAMING) {
      this.onTaskEvent(message as TaskEventMessage);
      return;
    }
    if (
      this.phase === PHASE.WAITING_BOOTSTRAP ||
      this.phase === PHASE.WAITING_READABLE
    ) {
      bootstrap.pendingEvents.push(message as TaskEventMessage);
    }
  }

  private handleTaskSync(bootstrap: Bootstrap, message: TaskSyncMessage) {
    if (message.reason === "external-sync-start") {
      return;
    }
    const initial = this.phase === PHASE.WAITING_BOOTSTRAP;
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
      this.transition(EVENT.SOURCE_ERROR);
      bootstrap.pendingEvents = [];
      bootstrap.pendingState = null;
      readyBootstrap(bootstrap);
      this.settleAttempt({
        ok: false,
        error: taskResponseError(message.error),
      });
      return;
    }
    if (!message.detail?.task) {
      if (initial) {
        this.transition(EVENT.ACCEPT_LOADING_BOOTSTRAP);
        readyBootstrap(bootstrap);
      }
      return;
    }

    const awaitingReadable = initial || this.phase === PHASE.WAITING_READABLE;
    if (!awaitingReadable) {
      return;
    }
    this.readable = true;
    this.transition(
      initial ? EVENT.ACCEPT_READABLE_BOOTSTRAP : EVENT.ACCEPT_READABLE_SYNC,
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
  private handleTaskState(bootstrap: Bootstrap, message: TaskStateMessage) {
    if (this.phase === PHASE.STREAMING) {
      this.onTaskState(message);
      return;
    }
    if (
      (this.phase === PHASE.WAITING_BOOTSTRAP ||
        this.phase === PHASE.WAITING_READABLE) &&
      !(Number(bootstrap.pendingState?.revision) > Number(message.revision))
    ) {
      bootstrap.pendingState = message;
    }
  }

  private handleSubjectGone(absence: TaskAbsence, threadId: string) {
    if (threadId !== this.threadId) {
      return;
    }
    this.closeBootstrap();
    if (!this.transition(EVENT.SUBJECT_ABSENT)) {
      return;
    }
    this.absence = absence;
    this.settleAttempt({ ok: false, absence });
    this.onSubjectAbsent(absence);
  }

  private handleTransportStateChange(
    state: TaskTransportState,
    previousState: TaskTransportState,
  ) {
    if (
      state === TASK_TRANSPORT_STATE.RECONNECTING &&
      this.phase === PHASE.STREAMING &&
      this.threadId
    ) {
      this.createAttempt(this.threadId, true);
    }
    if (state === TASK_TRANSPORT_STATE.UNAVAILABLE) {
      this.startFallback();
    }
    this.onStateChange(state, previousState);
  }

  private startFallback() {
    const attempt = this.attempt;
    if (
      !attempt ||
      (this.phase !== PHASE.WAITING_BOOTSTRAP &&
        this.phase !== PHASE.WAITING_READABLE)
    ) {
      return;
    }
    this.closeBootstrap();
    this.transition(EVENT.START_FALLBACK);
    void this.runFallback(attempt);
  }

  private async runFallback(attempt: Attempt) {
    let detail: TaskDetail | null = null;
    let error: unknown = null;
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
    this.transition(EVENT.FINISH_FALLBACK);
    if (error || !detail) {
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

  private isCurrentFallback(attempt: Attempt) {
    return (
      this.attempt === attempt &&
      this.phase === PHASE.REST_FALLBACK &&
      this.threadId === attempt.threadId
    );
  }

  private settleAttempt(outcome: TaskDetailOutcome) {
    const attempt = this.attempt;
    if (!attempt) {
      return;
    }
    this.attempt = null;
    attempt.resolve(outcome);
  }

  private accepts(event: TaskDetailSessionEvent) {
    return Boolean(TASK_DETAIL_SESSION_TRANSITIONS[this.phase]?.[event]);
  }

  // The one place the phase changes. False when the table rejects the event.
  private transition(event: TaskDetailSessionEvent) {
    const next = TASK_DETAIL_SESSION_TRANSITIONS[this.phase]?.[event];
    if (!next) {
      return false;
    }
    this.phase = next;
    if (next !== PHASE.ABSENT) {
      this.absence = null;
    }
    return true;
  }
}

// The channel answered, so its Task stream is ready; the bootstrap stays the
// place later messages are matched against.
function readyBootstrap(bootstrap: Bootstrap) {
  if (bootstrap.settled) {
    return;
  }
  bootstrap.settled = true;
  window.clearTimeout(bootstrap.timer);
  bootstrap.resolve(true);
}

function normalizeThreadId(threadId: string | null | undefined) {
  return `${threadId ?? ""}`.trim();
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
