import {
  createTaskStoreStatusSnapshot,
  normalizeTaskStoreReadiness,
  sameTaskStoreStatusSnapshot,
} from "./model.js";

const RECHECK_DELAY_MS = 500;

// Control graph

export const TASK_STORE_STATUS_NODE = Object.freeze({
  // Not connected: no request and no timer.
  DETACHED: "detached",

  // Hidden or paused with the foreground: no request and no timer. The last
  // answer stays.
  SUSPENDED: "suspended",

  // Nothing is running. The last answer is none or ready, or the store was
  // migrating and the check after that could not reach it.
  IDLE: "idle",

  // One status request is in flight.
  CHECKING: "checking",

  // The store answered that it is migrating, and a recheck timer runs.
  WAITING: "waiting",

  // The store answered that its startup failed. A person's retry is awaited.
  FAILED: "failed",

  // The migration retry request is in flight.
  RETRYING: "retrying",
});

export const TASK_STORE_STATUS_EVENT = Object.freeze({
  CONNECT: "connect",
  DISCONNECT: "disconnect",
  SUSPEND: "suspend",
  RESUME: "resume",
  CHECK: "check",
  ANSWERED: "answered",
  CHECK_FAILED: "check-failed",
  RECHECK_DUE: "recheck-due",
  RETRY: "retry",
  RETRY_ACCEPTED: "retry-accepted",
  RETRY_FAILED: "retry-failed",
});

const NODE = TASK_STORE_STATUS_NODE;
const EVENT = TASK_STORE_STATUS_EVENT;

// The node the store's last answer leads to: none or ready is idle,
// migrating is waiting, and failed is failed.
const ANSWER = "answer";

// Where a check that could not reach the store leaves the last answer: a
// failed store keeps its retry, and anything else is idle, so a migrating
// store is not rechecked again until someone asks for a check.
const UNANSWERED = "unanswered";

// The complete edge table. Any other node and event pair is rejected and
// leaves the state unchanged.
export const TASK_STORE_STATUS_TRANSITIONS = Object.freeze({
  [NODE.DETACHED]: Object.freeze({
    [EVENT.CONNECT]: NODE.CHECKING,
  }),
  [NODE.IDLE]: Object.freeze({
    [EVENT.CHECK]: NODE.CHECKING,
    [EVENT.SUSPEND]: NODE.SUSPENDED,
    [EVENT.DISCONNECT]: NODE.DETACHED,
  }),
  [NODE.CHECKING]: Object.freeze({
    [EVENT.CHECK]: NODE.CHECKING,
    [EVENT.ANSWERED]: ANSWER,
    [EVENT.CHECK_FAILED]: UNANSWERED,
    [EVENT.SUSPEND]: NODE.SUSPENDED,
    [EVENT.DISCONNECT]: NODE.DETACHED,
  }),
  [NODE.WAITING]: Object.freeze({
    [EVENT.RECHECK_DUE]: NODE.CHECKING,
    [EVENT.CHECK]: NODE.CHECKING,
    [EVENT.SUSPEND]: NODE.SUSPENDED,
    [EVENT.DISCONNECT]: NODE.DETACHED,
  }),
  [NODE.FAILED]: Object.freeze({
    [EVENT.RETRY]: NODE.RETRYING,
    [EVENT.CHECK]: NODE.CHECKING,
    [EVENT.SUSPEND]: NODE.SUSPENDED,
    [EVENT.DISCONNECT]: NODE.DETACHED,
  }),
  [NODE.RETRYING]: Object.freeze({
    [EVENT.RETRY_ACCEPTED]: NODE.CHECKING,
    [EVENT.RETRY_FAILED]: NODE.FAILED,
    [EVENT.SUSPEND]: NODE.SUSPENDED,
    [EVENT.DISCONNECT]: NODE.DETACHED,
  }),
  [NODE.SUSPENDED]: Object.freeze({
    [EVENT.RESUME]: ANSWER,
    [EVENT.DISCONNECT]: NODE.DETACHED,
  }),
});

export function createTaskStoreStatusState() {
  return Object.freeze({ node: NODE.DETACHED, readiness: null });
}

export function transitionTaskStoreStatus(state, event = {}) {
  const target = TASK_STORE_STATUS_TRANSITIONS[state.node]?.[event.type];
  if (!target) {
    return state;
  }
  const readiness = event.type === EVENT.ANSWERED
    ? normalizeTaskStoreReadiness(event.readiness)
    : state.readiness;
  const node = target === ANSWER
    ? answerNode(readiness)
    : target === UNANSWERED ? unansweredNode(readiness) : target;
  if (node === state.node && readiness === state.readiness) {
    return state;
  }
  return Object.freeze({ node, readiness });
}

function answerNode(readiness) {
  if (readiness?.state === "migrating") {
    return NODE.WAITING;
  }
  if (readiness?.state === "failed") {
    return NODE.FAILED;
  }
  return NODE.IDLE;
}

function unansweredNode(readiness) {
  return readiness?.state === "failed" ? NODE.FAILED : NODE.IDLE;
}

// Runtime effects. Every node change goes through dispatch; effects follow
// from the node a transition leaves and the node it enters.

export class TaskStoreStatusLifecycle {
  constructor({
    loadStatus,
    retryMigration,
    onSnapshotChange = () => {},
    recheckDelayMs = RECHECK_DELAY_MS,
    setTimer = (callback, delay) => setTimeout(callback, delay),
    clearTimer = (timer) => clearTimeout(timer),
  }) {
    this.loadStatus = loadStatus;
    this.retryMigration = retryMigration;
    this.onSnapshotChange = onSnapshotChange;
    this.recheckDelayMs = recheckDelayMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = createTaskStoreStatusState();
    this.generation = 0;
    this.pendingCheck = null;
    this.recheckTimer = null;
    this.snapshotValue = createTaskStoreStatusSnapshot();
  }

  connect() {
    this.dispatch({ type: EVENT.CONNECT });
  }

  disconnect() {
    this.dispatch({ type: EVENT.DISCONNECT });
  }

  suspend() {
    this.dispatch({ type: EVENT.SUSPEND });
  }

  resume() {
    this.dispatch({ type: EVENT.RESUME });
  }

  /**
   * Resolves with the store's next answer, or null when no check can run now,
   * and rejects when the store could not be asked. While a retry is running
   * the last answer stands in.
   */
  check() {
    if (this.state.node === NODE.RETRYING) {
      return Promise.resolve(this.state.readiness);
    }
    this.dispatch({ type: EVENT.CHECK });
    return this.pendingCheck?.promise ?? Promise.resolve(null);
  }

  retry() {
    this.dispatch({ type: EVENT.RETRY });
  }

  snapshot() {
    return this.snapshotValue;
  }

  dispatch(event) {
    const previous = this.state;
    const next = transitionTaskStoreStatus(previous, event);
    if (next === previous) {
      return false;
    }
    this.state = next;
    this.runEffects(previous.node, next.node, event);
    this.publishSnapshot();
    return true;
  }

  runEffects(previousNode, nextNode, event) {
    if (previousNode === NODE.WAITING && nextNode !== NODE.WAITING) {
      this.clearRecheckTimer();
    }
    if (previousNode === NODE.CHECKING && nextNode !== NODE.CHECKING) {
      this.settlePendingCheck(event);
    }
    if (nextNode === NODE.SUSPENDED || nextNode === NODE.DETACHED) {
      this.generation += 1;
    }
    if (nextNode === NODE.CHECKING && previousNode !== NODE.CHECKING) {
      this.startCheck();
    }
    if (nextNode === NODE.WAITING && previousNode !== NODE.WAITING) {
      this.startRecheckTimer();
    }
    if (nextNode === NODE.RETRYING) {
      this.startRetry();
    }
  }

  startCheck() {
    const generation = ++this.generation;
    this.pendingCheck = createDeferred();
    Promise.resolve()
      .then(() => this.loadStatus())
      .then(
        (readiness) => this.receive(generation, {
          type: EVENT.ANSWERED,
          readiness,
        }),
        (error) => this.receive(generation, {
          type: EVENT.CHECK_FAILED,
          error,
        }),
      );
  }

  startRetry() {
    const generation = ++this.generation;
    Promise.resolve()
      .then(() => this.retryMigration())
      .then(
        () => this.receive(generation, { type: EVENT.RETRY_ACCEPTED }),
        () => this.receive(generation, { type: EVENT.RETRY_FAILED }),
      );
  }

  receive(generation, event) {
    if (generation === this.generation) {
      this.dispatch(event);
    }
  }

  settlePendingCheck(event) {
    const pending = this.pendingCheck;
    this.pendingCheck = null;
    if (event.type === EVENT.ANSWERED) {
      pending?.resolve(this.state.readiness);
    } else if (event.type === EVENT.CHECK_FAILED) {
      pending?.reject(event.error);
    } else {
      pending?.resolve(null);
    }
  }

  startRecheckTimer() {
    this.recheckTimer = this.setTimer(() => {
      this.recheckTimer = null;
      this.dispatch({ type: EVENT.RECHECK_DUE });
    }, this.recheckDelayMs);
  }

  clearRecheckTimer() {
    if (this.recheckTimer !== null) {
      this.clearTimer(this.recheckTimer);
      this.recheckTimer = null;
    }
  }

  publishSnapshot() {
    const snapshot = createTaskStoreStatusSnapshot({
      readiness: this.state.readiness,
      retryAvailable: this.state.node === NODE.FAILED,
    });
    if (sameTaskStoreStatusSnapshot(this.snapshotValue, snapshot)) {
      return;
    }
    this.snapshotValue = snapshot;
    this.onSnapshotChange(snapshot);
  }
}

// A check nobody awaits must not surface as an unhandled rejection.
function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
