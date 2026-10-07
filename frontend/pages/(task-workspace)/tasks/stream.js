import { TASK_TRANSPORT_STATE } from "./runtime-state.js";
import {
  TASK_STREAM_EVENT,
  TASK_STREAM_NODE,
  presentTaskStream,
  transitionTaskStream,
} from "./stream/machine.js";

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([250, 1_000, 3_000]);

const NODE = TASK_STREAM_NODE;
const EVENT = TASK_STREAM_EVENT;

// One owner's Task stream on the workspace gateway; Task List and Task Detail
// each keep one. Owner calls, gateway reports, readiness, reconciliation, and
// timers all enter one control graph (stream/machine.js). This class runs the
// effects of each accepted transition and publishes the derived transport
// state.
export class TaskStreamLifecycle {
  constructor(options = {}) {
    this.subscribe = options.subscribe ?? null;
    this.onEvent = options.onEvent ?? (() => {});
    this.onReconcile = options.onReconcile ?? (() => Promise.resolve());
    this.onStateChange = options.onStateChange ?? (() => {});
    this.waitUntilReady = options.waitUntilReady ?? null;
    this.onConnectionInvalidated =
      options.onConnectionInvalidated ?? (() => {});
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? null;
    this.retryDelaysMs = [
      ...(options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS),
    ];
    this.node = NODE.INACTIVE;
    this.state = TASK_TRANSPORT_STATE.IDLE;
    this.contextKey = "";
    this.source = null;
    this.generation = 0;
    this.retryAttempt = 0;
    this.hasConnected = false;
    this.needsReconcile = false;
    this.skipReconcile = false;
    this.validating = false;
    this.reconciliation = null;
    this.reconcileToken = 0;
    this.prepareToken = 0;
    this.openTimer = null;
    this.retryTimer = null;
    this.queue = [];
    this.dispatching = false;
  }

  activate(contextKey, { force = false, validating = false } = {}) {
    const nextContextKey = `${contextKey ?? ""}`.trim();
    if (!nextContextKey) {
      this.deactivate();
      return;
    }
    const sameContext = this.contextKey === nextContextKey;
    this.dispatch({
      type: EVENT.ACTIVATE,
      contextKey: nextContextKey,
      sameContext,
      forced: force,
      validating: Boolean(validating && sameContext),
    });
  }

  retry({ reconcile = true } = {}) {
    if (this.contextKey) {
      this.dispatch({ type: EVENT.RETRY, reconcile });
    }
  }

  suspend() {
    if (this.contextKey) {
      this.dispatch({ type: EVENT.SUSPEND });
    }
  }

  // Replaces the subscription and reads canonical state alongside it. The
  // answer is that reading's outcome; a later context, hide, or replacement
  // makes it stale.
  recover(contextKey = this.contextKey) {
    const nextContextKey = `${contextKey ?? ""}`.trim();
    if (!nextContextKey || !isVisible()) {
      return Promise.resolve({ ok: false, stale: true });
    }
    const accepted = this.dispatch({
      type: EVENT.RECOVER,
      contextKey: nextContextKey,
      sameContext: this.contextKey === nextContextKey,
    });
    return accepted && this.reconciliation
      ? this.reconciliation.promise
      : Promise.resolve({ ok: false, stale: true });
  }

  deactivate() {
    this.dispatch({ type: EVENT.DEACTIVATE });
  }

  // Events raised while a transition runs its effects wait for it to finish,
  // so every node change passes through one transition at a time.
  dispatch(event) {
    if (this.dispatching) {
      this.queue.push(event);
      return false;
    }
    this.dispatching = true;
    let accepted = false;
    try {
      accepted = this.apply(event);
      while (this.queue.length) {
        this.apply(this.queue.shift());
      }
    } finally {
      this.dispatching = false;
    }
    return accepted;
  }

  apply(event) {
    const previous = this.node;
    const next = transitionTaskStream(previous, event, {
      visible: isVisible(),
      prepares: Boolean(this.waitUntilReady),
      reconcilePending: this.needsReconcile && !this.skipReconcile,
      retryBudgetLeft: Number.isFinite(this.retryDelaysMs[this.retryAttempt]),
    });
    if (next === null) {
      return false;
    }
    this.node = next;
    this.runEffects(previous, event, next);
    this.publish(event, next);
    return true;
  }

  runEffects(previous, event, next) {
    switch (event.type) {
      case EVENT.ACTIVATE:
      case EVENT.RETRY:
      case EVENT.RECOVER:
      case EVENT.RETRY_DUE:
        this.resubscribe(event, next);
        return;
      case EVENT.SUSPEND:
        this.stopWaiting();
        this.needsReconcile = true;
        this.skipReconcile = false;
        this.validating = false;
        return;
      case EVENT.DEACTIVATE:
        this.release();
        this.stopWaiting();
        this.contextKey = "";
        this.hasConnected = false;
        this.needsReconcile = false;
        this.skipReconcile = false;
        this.validating = false;
        this.retryAttempt = 0;
        return;
      case EVENT.CHANNEL_OPENED:
      case EVENT.PREPARED:
        this.clearOpenTimer();
        this.hasConnected = true;
        this.enterOpened(next);
        return;
      case EVENT.RECONCILED:
        this.needsReconcile = false;
        if (next === NODE.READY) {
          this.settleReady();
        }
        return;
      case EVENT.RECONCILE_FAILED:
        this.validating = false;
        if (next !== previous) {
          this.fail(next);
        }
        return;
      case EVENT.CHANNEL_FAILED:
      case EVENT.OPEN_TIMED_OUT:
      case EVENT.PREPARE_FAILED:
        this.fail(next);
        return;
      case EVENT.GATEWAY_TROUBLE:
      case EVENT.GATEWAY_EXHAUSTED:
        // The gateway keeps the subscription and reopens it on a fresh
        // connection, so it is not released here.
        this.stopWaiting();
        this.needsReconcile = true;
        this.validating = false;
        return;
      default:
    }
  }

  resubscribe(event, next) {
    this.release();
    this.stopWaiting();
    if (event.type === EVENT.RETRY) {
      this.needsReconcile = true;
      this.skipReconcile = !event.reconcile;
      this.validating = false;
      this.retryAttempt = 0;
    } else if (event.type !== EVENT.RETRY_DUE) {
      this.chooseContext(event);
    }
    if (next === NODE.SUBSCRIBING) {
      this.openSubscription();
    }
    if (event.type === EVENT.RECOVER) {
      this.reconcile();
    }
  }

  chooseContext({ type, contextKey, sameContext, forced, validating }) {
    const recovery = type === EVENT.RECOVER;
    if (!sameContext) {
      this.contextKey = contextKey;
      this.hasConnected = false;
      this.needsReconcile = false;
    } else if (recovery || forced || this.hasConnected || this.needsReconcile) {
      this.needsReconcile = true;
    }
    if (recovery) {
      this.skipReconcile = false;
    }
    this.validating = recovery ? sameContext : Boolean(validating);
    this.retryAttempt = 0;
  }

  openSubscription() {
    const generation = this.generation;
    const contextKey = this.contextKey;
    if (!this.subscribe) {
      // Without a gateway nothing can ever open, which is the gateway's own
      // exhaustion rather than a failure worth retrying.
      this.queue.push({ type: EVENT.GATEWAY_EXHAUSTED });
      return;
    }
    let source = null;
    try {
      source = this.subscribe(contextKey, {
        onOpen: () => {
          this.fromGateway(source, generation, EVENT.CHANNEL_OPENED);
        },
        onError: (_error, { exhausted = false, physical = false } = {}) => {
          this.fromGateway(
            source,
            generation,
            !physical
              ? EVENT.CHANNEL_FAILED
              : exhausted
                ? EVENT.GATEWAY_EXHAUSTED
                : EVENT.GATEWAY_TROUBLE,
          );
        },
        onEvent: (type, payload) => {
          if (this.isCurrent(source, generation)) {
            this.onEvent(
              type,
              { data: JSON.stringify(payload ?? null) },
              contextKey,
              { source },
            );
          }
        },
        onInvalidated: () => {
          this.fromGateway(source, generation, EVENT.CHANNEL_FAILED);
        },
      });
      if (!source?.close || !source?.retry) {
        throw new Error("Live subscription did not provide a lifecycle handle.");
      }
    } catch {
      this.queue.push({ type: EVENT.CHANNEL_FAILED });
      return;
    }
    this.source = source;
    this.startOpenTimer(generation);
  }

  enterOpened(next) {
    if (next === NODE.PREPARING) {
      this.prepare();
    } else if (next === NODE.RECONCILING) {
      this.reconcile();
    } else if (next === NODE.READY) {
      this.settleReady();
    }
  }

  prepare() {
    const token = ++this.prepareToken;
    const source = this.source;
    const generation = this.generation;
    const isCurrent = () =>
      this.prepareToken === token && this.isCurrent(source, generation);
    let readiness;
    try {
      readiness = this.waitUntilReady(this.contextKey, isCurrent, {
        recovery: this.needsReconcile,
        source,
      });
    } catch (error) {
      readiness = Promise.reject(error);
    }
    Promise.resolve(readiness).then(
      (ready) => {
        if (isCurrent()) {
          this.dispatch({
            type: ready === false ? EVENT.PREPARE_FAILED : EVENT.PREPARED,
          });
        }
      },
      () => {
        if (isCurrent()) {
          this.dispatch({ type: EVENT.PREPARE_FAILED });
        }
      },
    );
  }

  // One reading of canonical state per subscription: the one recovery starts
  // alongside the subscription is shared with the opened channel.
  reconcile() {
    if (
      this.reconciliation?.generation === this.generation &&
      !this.reconciliation.settled
    ) {
      return;
    }
    const token = ++this.reconcileToken;
    const generation = this.generation;
    const isCurrent = () =>
      this.reconcileToken === token && this.generation === generation;
    let pending;
    try {
      pending = Promise.resolve(
        this.onReconcile(this.contextKey, isCurrent, { recovery: true }),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }
    const reconciliation = { generation, settled: false, promise: null };
    reconciliation.promise = pending
      .then(
        (result) =>
          result === false
            ? { ok: false, error: new Error("Task stream reconciliation failed.") }
            : { ok: true, result },
        (error) => ({ ok: false, error }),
      )
      .then((outcome) => {
        if (!isCurrent()) {
          return { ok: false, stale: true };
        }
        reconciliation.settled = true;
        this.dispatch({
          type: outcome.ok ? EVENT.RECONCILED : EVENT.RECONCILE_FAILED,
        });
        return outcome;
      });
    this.reconciliation = reconciliation;
  }

  settleReady() {
    this.retryAttempt = 0;
    this.needsReconcile = false;
    this.skipReconcile = false;
    this.validating = false;
  }

  fail(next) {
    this.release();
    this.stopWaiting();
    this.needsReconcile = true;
    this.validating = false;
    if (next !== NODE.BACKING_OFF) {
      return;
    }
    const delayMs = this.retryDelaysMs[this.retryAttempt];
    this.retryAttempt += 1;
    const generation = this.generation;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.generation === generation) {
        this.dispatch({ type: EVENT.RETRY_DUE });
      }
    }, Math.max(0, delayMs));
  }

  // Releases the current subscription; anything it still delivers is stale.
  release() {
    const source = this.source;
    this.source = null;
    this.generation += 1;
    if (source) {
      source.close();
      this.onConnectionInvalidated(source);
    }
  }

  // Stops timers and makes in-flight reconciliation and preparation stale.
  stopWaiting() {
    this.clearOpenTimer();
    window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.reconcileToken += 1;
    this.prepareToken += 1;
    this.reconciliation = null;
  }

  startOpenTimer(generation) {
    if (!Number.isFinite(this.connectionTimeoutMs)) {
      return;
    }
    this.openTimer = window.setTimeout(() => {
      this.openTimer = null;
      if (this.generation === generation) {
        this.dispatch({ type: EVENT.OPEN_TIMED_OUT });
      }
    }, Math.max(0, this.connectionTimeoutMs));
  }

  clearOpenTimer() {
    window.clearTimeout(this.openTimer);
    this.openTimer = null;
  }

  fromGateway(source, generation, type) {
    if (this.isCurrent(source, generation)) {
      this.dispatch({ type });
    }
  }

  isCurrent(source, generation) {
    return this.source === source && this.generation === generation;
  }

  // An owner that suspends or deactivates its own stream already knows; the
  // idle state is recorded without telling it again.
  publish(event, next) {
    const state = presentTaskStream(next, {
      validating: this.validating,
      needsReconcile: this.needsReconcile,
    });
    if (state === this.state) {
      return;
    }
    const previousState = this.state;
    this.state = state;
    const ownerIdled =
      state === TASK_TRANSPORT_STATE.IDLE &&
      [EVENT.SUSPEND, EVENT.DEACTIVATE, EVENT.ACTIVATE, EVENT.RETRY].includes(
        event.type,
      );
    if (!ownerIdled) {
      this.onStateChange(state, previousState);
    }
  }
}

function isVisible() {
  return document.visibilityState === "visible";
}
