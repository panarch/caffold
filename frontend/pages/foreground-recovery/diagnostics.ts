import type { LiveConnectionReport } from "../(task-workspace)/live-updates.ts";
import type { ForegroundRecoveryRuntimeSnapshot } from "./lifecycle.ts";
import {
  FOREGROUND_RECOVERY_NODE,
  type ForegroundRecoveryTarget,
  type ForegroundRecoveryTargets,
} from "./machine.ts";

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

type DiagnosticsNode = (typeof DIAGNOSTICS_NODE)[keyof typeof DIAGNOSTICS_NODE];

type DiagnosticsEvent =
  (typeof DIAGNOSTICS_EVENT)[keyof typeof DIAGNOSTICS_EVENT];

// Complete graph. Any other event leaves the node as it is.
export const DIAGNOSTICS_EDGES: Readonly<
  Record<
    DiagnosticsNode,
    Readonly<Partial<Record<DiagnosticsEvent, DiagnosticsNode>>>
  >
> = Object.freeze({
  [DIAGNOSTICS_NODE.WAITING]: Object.freeze({
    [DIAGNOSTICS_EVENT.RETURNED]: DIAGNOSTICS_NODE.RECORDING,
  }),
  [DIAGNOSTICS_NODE.RECORDING]: Object.freeze({
    [DIAGNOSTICS_EVENT.SETTLED]: DIAGNOSTICS_NODE.WAITING,
    [DIAGNOSTICS_EVENT.HIDDEN]: DIAGNOSTICS_NODE.WAITING,
    [DIAGNOSTICS_EVENT.LIMIT]: DIAGNOSTICS_NODE.WAITING,
  }),
});

export function transitionDiagnostics(
  node: DiagnosticsNode,
  event: DiagnosticsEvent,
) {
  return DIAGNOSTICS_EDGES[node]?.[event] ?? node;
}

export const DIAGNOSTICS_STORAGE_KEY =
  "caffold:foreground-recovery-diagnostics";

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
const ATTEMPT_NODES = new Set<string | undefined>([
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

interface ConnectionRecord {
  id: number | undefined;
  openedMs: number;
  answeredMs: number | null;
  endedMs: number | null;
  end: string | null;
}

interface RequestRecord {
  path: string;
  startMs: number;
  firstByteMs: number | null;
  endMs: number;
  newConnection: boolean | null;
}

interface ReturnRecord {
  visibleAt: number;
  hiddenAt: number;
  attempted: boolean;
  recovery: Array<{ ms: number; node: string }>;
  notice: Array<{ ms: number; state: string }>;
  targets: Array<{ ms: number; list: string; detail: string }>;
  connections: ConnectionRecord[];
  requests: RequestRecord[];
}

// What goes to the server for one return.
type DeliveredRecord = Omit<
  ReturnRecord,
  "visibleAt" | "hiddenAt" | "attempted"
> & {
  hiddenForMs: number;
  endedMs: number;
  end: DiagnosticsEvent;
};

interface RequestObserver {
  takeRecords(): PerformanceResourceTiming[];
  disconnect(): void;
}

export interface ForegroundRecoveryDiagnosticsOptions {
  send?: ((records: DeliveredRecord[]) => Promise<unknown>) | null;
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  origin?: string;
  observeRequests?:
    | ((
        onEntries: (entries: PerformanceResourceTiming[]) => void,
      ) => RequestObserver | null)
    | null;
  windowTarget?: Pick<Window, "setTimeout" | "clearTimeout">;
  limitMs?: number;
}

export class ForegroundRecoveryDiagnostics {
  private readonly send: ForegroundRecoveryDiagnosticsOptions["send"];
  private readonly now: () => number;
  private readonly storage: ForegroundRecoveryDiagnosticsOptions["storage"];
  private readonly origin: string;
  private readonly observeRequests: ForegroundRecoveryDiagnosticsOptions["observeRequests"];
  private readonly windowTarget: ForegroundRecoveryDiagnosticsOptions["windowTarget"];
  private readonly limitMs: number;
  private node: DiagnosticsNode;
  private record: ReturnRecord | null;
  private hiddenAt: number | null;
  private heldReports: Array<Partial<LiveConnectionReport> & { at: number }>;
  private previous: { visible: boolean; nodeType: string } | null;
  private limitTimer: number | null;
  private requests: RequestObserver | null;
  private pending: DeliveredRecord[];
  private delivery: Promise<void> | null;

  constructor({
    send = null,
    now = () => globalThis.performance.now(),
    storage = browserStorage(),
    origin = globalThis.window?.location?.origin ?? "",
    observeRequests = observeResourceTimings,
    windowTarget = globalThis.window,
    limitMs = RECORDING_LIMIT_MS,
  }: ForegroundRecoveryDiagnosticsOptions = {}) {
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
    this.requests ??=
      this.observeRequests?.((entries) => this.acceptRequests(entries)) ?? null;
  }

  disconnect() {
    this.requests?.disconnect();
    this.requests = null;
    this.clearLimitTimer();
    this.record = null;
    this.node = DIAGNOSTICS_NODE.WAITING;
  }

  // One foreground recovery snapshot, with the notice it presents.
  observe(snapshot: ForegroundRecoveryRuntimeSnapshot, presentation: string) {
    const at = this.now();
    const visible = snapshot.observation?.visibility === "visible";
    const nodeType = snapshot.node?.type ?? "";
    const previous = this.previous;
    this.previous = { visible, nodeType };

    if (previous?.visible && !visible) {
      this.finish(DIAGNOSTICS_EVENT.HIDDEN, at);
      this.hiddenAt = at;
      this.heldReports = [];
    } else if (
      previous &&
      !previous.visible &&
      visible &&
      this.hiddenAt !== null
    ) {
      this.start(at);
    }

    if (this.node === DIAGNOSTICS_NODE.RECORDING) {
      this.step(at, snapshot, presentation);
      if (
        (this.record as ReturnRecord).attempted &&
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
      void this.deliver();
    }
  }

  reportConnection({ kind, id }: Partial<LiveConnectionReport> = {}) {
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

  private start(at: number) {
    if (!this.transition(DIAGNOSTICS_EVENT.RETURNED)) {
      return;
    }
    this.record = {
      visibleAt: at,
      hiddenAt: this.hiddenAt as number,
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
    this.limitTimer =
      this.windowTarget?.setTimeout(() => {
        this.limitTimer = null;
        this.finish(DIAGNOSTICS_EVENT.LIMIT, this.now());
      }, this.limitMs) ?? null;
  }

  private step(
    at: number,
    snapshot: ForegroundRecoveryRuntimeSnapshot,
    presentation: string,
  ) {
    const record = this.record as ReturnRecord;
    const ms = this.offset(at);
    const nodeType = snapshot.node?.type ?? "";
    if (ATTEMPT_NODES.has(nodeType)) {
      record.attempted = true;
    }
    appendChange(record.recovery, { ms, node: nodeType }, "node");
    appendChange(record.notice, { ms, state: presentation }, "state");
    const targets: Partial<ForegroundRecoveryTargets> = snapshot.targets ?? {};
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

  private finish(event: DiagnosticsEvent, at: number) {
    if (this.node !== DIAGNOSTICS_NODE.RECORDING) {
      return;
    }
    // Requests that finished before this moment may still sit undelivered in
    // the observer's queue.
    this.acceptRequests(this.requests?.takeRecords() ?? []);
    const record = this.record as ReturnRecord;
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
      void this.deliver();
    }
  }

  private applyConnection(
    kind: LiveConnectionReport["kind"] | undefined,
    id: number | undefined,
    at: number,
  ) {
    const connections = (this.record as ReturnRecord).connections;
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
    } else if ((["stalled", "failed", "closed"] as unknown[]).includes(kind)) {
      connection.end = kind as LiveConnectionReport["kind"];
      connection.endedMs = ms;
    }
  }

  private acceptRequests(entries: PerformanceResourceTiming[]) {
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
        firstByteMs:
          entry.responseStart > 0 ? this.offset(entry.responseStart) : null,
        endMs: this.offset(entry.responseEnd),
        newConnection: connectionTimed
          ? entry.connectEnd > entry.connectStart
          : null,
      });
    }
  }

  private enqueue(record: DeliveredRecord) {
    this.pending.push(record);
    this.pending.splice(0, Math.max(0, this.pending.length - PENDING_LIMIT));
    this.persist();
  }

  // Sends what is waiting, one delivery at a time. Records that fail stay
  // for the next recovery.
  private deliver() {
    const send = this.send;
    if (!send || this.delivery || !this.pending.length) {
      return this.delivery;
    }
    const batch = [...this.pending];
    const delivery: Promise<void> = Promise.resolve()
      .then(() => send(batch))
      .then(
        () => {
          this.pending = this.pending.filter(
            (record) => !batch.includes(record),
          );
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

  private transition(event: DiagnosticsEvent) {
    const next = transitionDiagnostics(this.node, event);
    if (next === this.node) {
      return false;
    }
    this.node = next;
    return true;
  }

  private offset(at: number, record = this.record as ReturnRecord) {
    return Math.max(0, Math.round(at - record.visibleAt));
  }

  private clearLimitTimer() {
    if (this.limitTimer !== null) {
      this.windowTarget?.clearTimeout(this.limitTimer);
      this.limitTimer = null;
    }
  }

  private persist() {
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

function observeResourceTimings(
  onEntries: (entries: PerformanceResourceTiming[]) => void,
): RequestObserver | null {
  const Observer = globalThis.window?.PerformanceObserver;
  if (
    typeof Observer !== "function" ||
    !Observer.supportedEntryTypes?.includes("resource")
  ) {
    return null;
  }
  const observer = new Observer((list) =>
    onEntries(list.getEntries() as PerformanceResourceTiming[]),
  );
  observer.observe({ type: "resource" });
  return {
    takeRecords: () => observer.takeRecords() as PerformanceResourceTiming[],
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

function readPending(
  storage: ForegroundRecoveryDiagnosticsOptions["storage"],
): DeliveredRecord[] {
  try {
    const stored = JSON.parse(
      storage?.getItem(DIAGNOSTICS_STORAGE_KEY) ?? "[]",
    );
    return Array.isArray(stored) ? stored.slice(-PENDING_LIMIT) : [];
  } catch {
    return [];
  }
}

function appendChange<Step extends { ms: number }>(
  steps: Step[],
  step: Step,
  ...keys: Array<keyof Step>
) {
  const last = steps.at(-1);
  if (
    steps.length >= STEP_LIMIT ||
    (last && keys.every((key) => last[key] === step[key]))
  ) {
    return;
  }
  steps.push(step);
}

function targetTransport(target: ForegroundRecoveryTarget | undefined) {
  return target?.active ? target.transport : "inactive";
}

function transportsSettled(targets: Partial<ForegroundRecoveryTargets> = {}) {
  return [targets.list, targets.detail].every(
    (target) => !target?.active || !UNSETTLED_TRANSPORTS.has(target.transport),
  );
}

function apiPath(name: string, origin: string) {
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
