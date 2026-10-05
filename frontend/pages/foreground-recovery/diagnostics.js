import { FOREGROUND_RECOVERY_NODE } from "./machine.js";

// Diagnostics of each foreground recovery that follows a return to the page,
// timed in this browser as each thing happened and sent to the server log once
// Caffold answers again. Every time is in milliseconds since the page became
// visible again, so a late delivery changes no number.

// Control graph

export const DIAGNOSTICS_NODE = Object.freeze({
  // No record is open; connection reports since the page hid are kept for the
  // next one.
  WAITING: "waiting",
  // A record is open for the current return.
  RECORDING: "recording",
});

export const DIAGNOSTICS_EVENT = Object.freeze({
  // The page became visible after being hidden.
  RETURNED: "returned",
  // Recovery finished and every active Task transport is settled.
  SETTLED: "settled",
  // The page was hidden before the record settled.
  HIDDEN: "hidden",
  // The record did not settle within the time limit.
  LIMIT: "limit",
});

// Complete graph. Any other event leaves the node as it is.
export const DIAGNOSTICS_EDGES = Object.freeze({
  [DIAGNOSTICS_NODE.WAITING]: Object.freeze({
    [DIAGNOSTICS_EVENT.RETURNED]: DIAGNOSTICS_NODE.RECORDING,
  }),
  [DIAGNOSTICS_NODE.RECORDING]: Object.freeze({
    [DIAGNOSTICS_EVENT.SETTLED]: DIAGNOSTICS_NODE.WAITING,
    [DIAGNOSTICS_EVENT.HIDDEN]: DIAGNOSTICS_NODE.WAITING,
    [DIAGNOSTICS_EVENT.LIMIT]: DIAGNOSTICS_NODE.WAITING,
  }),
});

export function transitionDiagnostics(node, event) {
  return DIAGNOSTICS_EDGES[node]?.[event] ?? node;
}

export const DIAGNOSTICS_STORAGE_KEY = "caffold:foreground-recovery-diagnostics";

const RECORDING_LIMIT_MS = 120_000;
const PENDING_LIMIT = 20;
const STEP_LIMIT = 40;
const CONNECTION_LIMIT = 16;
const REQUEST_LIMIT = 60;
const HELD_REPORT_LIMIT = 32;
// The live stream stays open for the whole visit, and the diagnostics route is
// this record's own delivery.
const UNTIMED_PATHS = new Set([
  "/api/live",
  "/api/diagnostics/foreground-recovery",
]);
const ATTEMPT_NODES = new Set([
  FOREGROUND_RECOVERY_NODE.VALIDATING_STATUS,
  FOREGROUND_RECOVERY_NODE.ACTIVATING_ROUTE,
  FOREGROUND_RECOVERY_NODE.VALIDATING_LIST,
  FOREGROUND_RECOVERY_NODE.VALIDATING_DETAIL,
  FOREGROUND_RECOVERY_NODE.VALIDATING_LIST_AND_DETAIL,
]);
const UNSETTLED_TRANSPORTS = new Set([
  "connecting",
  "validating",
  "reconnecting",
  "unavailable",
]);

export class ForegroundRecoveryDiagnostics {
  constructor({
    send = null,
    now = () => globalThis.performance.now(),
    storage = browserStorage(),
    origin = globalThis.window?.location?.origin ?? "",
    observeRequests = observeResourceTimings,
    windowTarget = globalThis.window,
    limitMs = RECORDING_LIMIT_MS,
  } = {}) {
    this.send = send;
    this.now = now;
    this.storage = storage;
    this.origin = origin;
    this.observeRequests = observeRequests;
    this.windowTarget = windowTarget;
    this.limitMs = limitMs;
    this.node = DIAGNOSTICS_NODE.WAITING;
    this.record = null;
    this.hiddenAt = null;
    this.heldReports = [];
    this.previous = null;
    this.limitTimer = null;
    this.requests = null;
    this.pending = readPending(storage);
    this.delivery = null;
  }

  connect() {
    this.requests ??= this.observeRequests?.((entries) =>
      this.acceptRequests(entries)
    ) ?? null;
  }

  disconnect() {
    this.requests?.disconnect();
    this.requests = null;
    this.clearLimitTimer();
    this.record = null;
    this.node = DIAGNOSTICS_NODE.WAITING;
  }

  // One foreground recovery snapshot, with the notice it presents.
  observe(snapshot, presentation) {
    const at = this.now();
    const visible = snapshot.observation?.visibility === "visible";
    const nodeType = snapshot.node?.type ?? "";
    const previous = this.previous;
    this.previous = { visible, nodeType };

    if (previous?.visible && !visible) {
      this.finish(DIAGNOSTICS_EVENT.HIDDEN, at);
      this.hiddenAt = at;
      this.heldReports = [];
    } else if (previous && !previous.visible && visible && this.hiddenAt !== null) {
      this.start(at);
    }

    if (this.node === DIAGNOSTICS_NODE.RECORDING) {
      this.step(at, snapshot, presentation);
      if (
        this.record.attempted &&
        nodeType === FOREGROUND_RECOVERY_NODE.READY &&
        transportsSettled(snapshot.targets)
      ) {
        this.finish(DIAGNOSTICS_EVENT.SETTLED, at);
      }
    }

    // Caffold answered a whole recovery, so the records waiting can go now.
    if (
      ATTEMPT_NODES.has(previous?.nodeType) &&
      nodeType === FOREGROUND_RECOVERY_NODE.READY
    ) {
      this.deliver();
    }
  }

  reportConnection({ kind, id } = {}) {
    const at = this.now();
    if (this.node === DIAGNOSTICS_NODE.RECORDING) {
      this.applyConnection(kind, id, at);
    } else if (
      this.hiddenAt !== null &&
      this.heldReports.length < HELD_REPORT_LIMIT
    ) {
      this.heldReports.push({ kind, id, at });
    }
  }

  start(at) {
    if (!this.transition(DIAGNOSTICS_EVENT.RETURNED)) {
      return;
    }
    this.record = {
      visibleAt: at,
      hiddenAt: this.hiddenAt,
      attempted: false,
      recovery: [],
      notice: [],
      targets: [],
      connections: [],
      requests: [],
    };
    for (const report of this.heldReports) {
      this.applyConnection(report.kind, report.id, report.at);
    }
    this.heldReports = [];
    this.limitTimer = this.windowTarget?.setTimeout(
      () => {
        this.limitTimer = null;
        this.finish(DIAGNOSTICS_EVENT.LIMIT, this.now());
      },
      this.limitMs,
    ) ?? null;
  }

  step(at, snapshot, presentation) {
    const record = this.record;
    const ms = this.offset(at);
    const nodeType = snapshot.node?.type ?? "";
    if (ATTEMPT_NODES.has(nodeType)) {
      record.attempted = true;
    }
    appendChange(record.recovery, { ms, node: nodeType }, "node");
    appendChange(record.notice, { ms, state: presentation }, "state");
    const targets = snapshot.targets ?? {};
    appendChange(
      record.targets,
      {
        ms,
        list: targetTransport(targets.list),
        detail: targetTransport(targets.detail),
      },
      "list",
      "detail",
    );
  }

  finish(event, at) {
    if (this.node !== DIAGNOSTICS_NODE.RECORDING) {
      return;
    }
    // Requests that finished before this moment may still sit undelivered in
    // the observer's queue.
    this.acceptRequests(this.requests?.takeRecords() ?? []);
    const record = this.record;
    this.clearLimitTimer();
    this.transition(event);
    this.record = null;
    this.enqueue({
      hiddenForMs: Math.max(0, Math.round(record.visibleAt - record.hiddenAt)),
      endedMs: this.offset(at, record),
      end: event,
      recovery: record.recovery,
      notice: record.notice,
      targets: record.targets,
      connections: record.connections,
      requests: record.requests,
    });
    // A settled return has just heard from Caffold, even when its transports
    // settled after recovery did.
    if (event === DIAGNOSTICS_EVENT.SETTLED) {
      this.deliver();
    }
  }

  applyConnection(kind, id, at) {
    const connections = this.record.connections;
    const ms = this.offset(at);
    if (kind === "opened") {
      if (connections.length < CONNECTION_LIMIT) {
        connections.push({
          id,
          openedMs: ms,
          answeredMs: null,
          endedMs: null,
          end: null,
        });
      }
      return;
    }
    const connection = connections.find((candidate) => candidate.id === id);
    if (!connection || connection.end) {
      return;
    }
    if (kind === "answered") {
      connection.answeredMs ??= ms;
    } else if (["stalled", "failed", "closed"].includes(kind)) {
      connection.end = kind;
      connection.endedMs = ms;
    }
  }

  acceptRequests(entries) {
    const record = this.record;
    if (this.node !== DIAGNOSTICS_NODE.RECORDING || !record) {
      return;
    }
    for (const entry of entries) {
      if (
        record.requests.length >= REQUEST_LIMIT ||
        entry.startTime < record.hiddenAt
      ) {
        continue;
      }
      const path = apiPath(entry.name, this.origin);
      if (!path) {
        continue;
      }
      const connectionTimed = entry.connectEnd > 0;
      record.requests.push({
        path,
        startMs: this.offset(entry.startTime),
        firstByteMs: entry.responseStart > 0
          ? this.offset(entry.responseStart)
          : null,
        endMs: this.offset(entry.responseEnd),
        newConnection: connectionTimed
          ? entry.connectEnd > entry.connectStart
          : null,
      });
    }
  }

  enqueue(record) {
    this.pending.push(record);
    this.pending.splice(0, Math.max(0, this.pending.length - PENDING_LIMIT));
    this.persist();
  }

  // Sends what is waiting, one delivery at a time. Records that fail stay
  // for the next recovery.
  deliver() {
    if (!this.send || this.delivery || !this.pending.length) {
      return this.delivery;
    }
    const batch = [...this.pending];
    const delivery = Promise.resolve()
      .then(() => this.send(batch))
      .then(
        () => {
          this.pending = this.pending.filter((record) => !batch.includes(record));
          this.persist();
        },
        () => {},
      )
      .finally(() => {
        if (this.delivery === delivery) {
          this.delivery = null;
        }
      });
    this.delivery = delivery;
    return delivery;
  }

  transition(event) {
    const next = transitionDiagnostics(this.node, event);
    if (next === this.node) {
      return false;
    }
    this.node = next;
    return true;
  }

  offset(at, record = this.record) {
    return Math.max(0, Math.round(at - record.visibleAt));
  }

  clearLimitTimer() {
    if (this.limitTimer !== null) {
      this.windowTarget?.clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
  }

  persist() {
    try {
      if (this.pending.length) {
        this.storage?.setItem(
          DIAGNOSTICS_STORAGE_KEY,
          JSON.stringify(this.pending),
        );
      } else {
        this.storage?.removeItem(DIAGNOSTICS_STORAGE_KEY);
      }
    } catch {
      // A browser without room keeps the records only in memory.
    }
  }
}

function observeResourceTimings(onEntries) {
  const Observer = globalThis.window?.PerformanceObserver;
  if (
    typeof Observer !== "function" ||
    !Observer.supportedEntryTypes?.includes("resource")
  ) {
    return null;
  }
  const observer = new Observer((list) => onEntries(list.getEntries()));
  observer.observe({ type: "resource" });
  return {
    takeRecords: () => observer.takeRecords(),
    disconnect: () => observer.disconnect(),
  };
}

function browserStorage() {
  try {
    return globalThis.window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function readPending(storage) {
  try {
    const stored = JSON.parse(
      storage?.getItem(DIAGNOSTICS_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(stored) ? stored.slice(-PENDING_LIMIT) : [];
  } catch {
    return [];
  }
}

function appendChange(steps, step, ...keys) {
  const last = steps.at(-1);
  if (
    steps.length >= STEP_LIMIT ||
    (last && keys.every((key) => last[key] === step[key]))
  ) {
    return;
  }
  steps.push(step);
}

function targetTransport(target) {
  return target?.active ? target.transport : "inactive";
}

function transportsSettled(targets = {}) {
  return [targets.list, targets.detail].every(
    (target) => !target?.active || !UNSETTLED_TRANSPORTS.has(target.transport),
  );
}

function apiPath(name, origin) {
  try {
    const url = new URL(name);
    if (
      url.origin !== origin ||
      !url.pathname.startsWith("/api/") ||
      UNTIMED_PATHS.has(url.pathname)
    ) {
      return null;
    }
    return url.pathname;
  } catch {
    return null;
  }
}
