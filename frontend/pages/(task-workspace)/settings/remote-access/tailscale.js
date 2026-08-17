import {
  getTailscaleStatus,
  setTailscaleServe,
} from "../../../../api.js";

const STATES = new Set([
  "notInstalled",
  "disconnected",
  "serveOff",
  "configuring",
  "disabling",
  "ready",
  "unavailable",
  "failed",
]);
const TRANSITION_STATES = new Set(["configuring", "disabling"]);
const POLL_INTERVAL_MS = 750;
const PHASES = Object.freeze({
  INACTIVE: "inactive",
  IDLE: "idle",
  REFRESHING: "refreshing",
  MUTATING: "mutating",
  POLLING: "polling",
});
const PHASE_EDGES = new Map([
  [PHASES.INACTIVE, new Set([PHASES.REFRESHING])],
  [PHASES.IDLE, new Set([PHASES.REFRESHING, PHASES.MUTATING, PHASES.INACTIVE])],
  [PHASES.REFRESHING, new Set([PHASES.IDLE, PHASES.POLLING, PHASES.INACTIVE])],
  [PHASES.MUTATING, new Set([PHASES.IDLE, PHASES.POLLING, PHASES.INACTIVE])],
  [PHASES.POLLING, new Set([PHASES.REFRESHING, PHASES.INACTIVE])],
]);

export class TailscaleLifecycle {
  constructor({
    load = getTailscaleStatus,
    update = setTailscaleServe,
    onChange = () => {},
    schedule = window.setTimeout.bind(window),
    cancel = window.clearTimeout.bind(window),
  } = {}) {
    this.load = load;
    this.update = update;
    this.onChange = onChange;
    this.schedule = schedule;
    this.cancel = cancel;
    this.active = false;
    this.operation = 0;
    this.pollTimer = null;
    this.phase = PHASES.INACTIVE;
    this.status = null;
    this.statusFresh = false;
    this.message = "";
    this.retryIntent = null;
    this.snapshot = this.currentSnapshot();
  }

  activate() {
    if (this.active) return;
    this.active = true;
    void this.refresh();
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.operation += 1;
    this.clearPoll();
    this.transition(PHASES.INACTIVE);
  }

  async refresh() {
    if (
      !this.active ||
      this.phase === PHASES.REFRESHING ||
      this.phase === PHASES.MUTATING
    ) return;
    const operation = ++this.operation;
    this.clearPoll();
    this.transition(PHASES.REFRESHING);
    this.message = "";
    this.retryIntent = null;
    this.publish();
    try {
      const status = normalizeTailscaleStatus(await this.load());
      if (!this.isCurrent(operation, PHASES.REFRESHING)) return;
      this.acceptStatus(status);
      this.finishCanonicalRequest(status);
    } catch (error) {
      if (!this.isCurrent(operation, PHASES.REFRESHING)) return;
      this.statusFresh = false;
      this.message = error?.message ?? "Remote access status could not be loaded.";
      this.retryIntent = "refresh";
      if (TRANSITION_STATES.has(this.status?.state)) {
        this.transition(PHASES.POLLING);
        this.publish();
        this.scheduleCanonicalPoll();
      } else {
        this.transition(PHASES.IDLE);
        this.publish();
      }
    }
  }

  async setEnabled(enabled) {
    const current = this.status;
    if (
      !this.active ||
      this.phase !== PHASES.IDLE ||
      !this.statusFresh ||
      !current?.canManage
    ) return;
    const allowed = enabled
      ? ["serveOff", "failed"].includes(current.state)
      : ["ready", "failed"].includes(current.state);
    if (!allowed) return;

    const operation = ++this.operation;
    this.clearPoll();
    this.transition(PHASES.MUTATING);
    this.message = "";
    this.retryIntent = null;
    this.publish();

    try {
      const update = this.update(enabled);
      this.scheduleMutationPoll(operation);
      const status = normalizeTailscaleStatus(await update);
      if (!this.isCurrent(operation, PHASES.MUTATING)) return;
      this.clearPoll();
      this.acceptStatus(status);
      this.finishCanonicalRequest(status);
    } catch (error) {
      if (!this.isCurrent(operation, PHASES.MUTATING)) return;
      this.clearPoll();
      this.statusFresh = false;
      this.message = error?.message ?? "Tailscale Serve could not be updated.";
      this.retryIntent = enabled ? "enable" : "disable";
      this.transition(PHASES.POLLING);
      this.publish();
      this.scheduleCanonicalPoll();
    }
  }

  retry() {
    if (!this.active || this.phase !== PHASES.IDLE) return;
    if (this.retryIntent === "enable") return this.setEnabled(true);
    if (this.retryIntent === "disable") return this.setEnabled(false);
    if (this.retryIntent === "refresh") return this.refresh();
    const reason = this.status?.reasonCode ?? "";
    const canManage = this.statusFresh && this.status?.canManage === true;
    if (canManage && reason.startsWith("serveEnable")) {
      return this.setEnabled(true);
    }
    if (canManage && reason.startsWith("serveDisable")) {
      return this.setEnabled(false);
    }
    return this.refresh();
  }

  acceptStatus(status) {
    this.status = status;
    this.statusFresh = true;
    this.message = "";
    this.retryIntent = null;
  }

  finishCanonicalRequest(status) {
    if (TRANSITION_STATES.has(status.state)) {
      this.transition(PHASES.POLLING);
      this.publish();
      this.scheduleCanonicalPoll();
      return;
    }
    this.transition(PHASES.IDLE);
    this.publish();
  }

  scheduleCanonicalPoll() {
    if (!this.active || this.phase !== PHASES.POLLING) return;
    this.pollTimer = this.schedule(() => {
      this.pollTimer = null;
      void this.refresh();
    }, POLL_INTERVAL_MS);
  }

  scheduleMutationPoll(operation) {
    if (!this.isCurrent(operation, PHASES.MUTATING)) return;
    this.pollTimer = this.schedule(() => {
      this.pollTimer = null;
      void this.pollMutation(operation);
    }, POLL_INTERVAL_MS);
  }

  async pollMutation(operation) {
    if (!this.isCurrent(operation, PHASES.MUTATING)) return;
    try {
      const status = normalizeTailscaleStatus(await this.load());
      if (!this.isCurrent(operation, PHASES.MUTATING)) return;
      this.acceptStatus(status);
      this.publish();
    } catch {
      if (!this.isCurrent(operation, PHASES.MUTATING)) return;
    }
    this.scheduleMutationPoll(operation);
  }

  clearPoll() {
    if (this.pollTimer !== null) {
      this.cancel(this.pollTimer);
      this.pollTimer = null;
    }
  }

  transition(next) {
    if (next === this.phase) return;
    if (!PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid Tailscale lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  currentSnapshot() {
    return {
      status: this.status,
      statusFresh: this.statusFresh,
      busy: ![PHASES.INACTIVE, PHASES.IDLE].includes(this.phase),
      message: this.message,
      retryIntent: this.retryIntent,
    };
  }

  publish() {
    this.snapshot = this.currentSnapshot();
    this.onChange(this.snapshot);
  }

  isCurrent(operation, phase) {
    return this.active && operation === this.operation && this.phase === phase;
  }
}

export function normalizeTailscaleStatus(payload) {
  if (!payload || typeof payload !== "object" || !STATES.has(payload.state)) {
    throw new Error("Caffold returned an invalid Tailscale status.");
  }
  const tailnetUrl = payload.tailnetUrl === null || payload.tailnetUrl === undefined
    ? null
    : canonicalTailnetUrl(payload.tailnetUrl);
  if (payload.state === "ready" && !tailnetUrl) {
    throw new Error("Caffold returned a ready status without a Tailnet URL.");
  }
  return {
    state: payload.state,
    reasonCode: typeof payload.reasonCode === "string" ? payload.reasonCode : "unknown",
    diagnosticMessage: typeof payload.diagnosticMessage === "string"
      ? payload.diagnosticMessage
      : "Tailscale status is unavailable.",
    tailnetUrl,
    canManage: payload.canManage === true,
  };
}

export function canonicalTailnetUrl(value) {
  if (typeof value !== "string") {
    throw new Error("Caffold returned an invalid Tailnet URL.");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Caffold returned an invalid Tailnet URL.");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !host.endsWith(".ts.net") ||
    host.length <= ".ts.net".length ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.href !== value
  ) {
    throw new Error("Caffold returned an invalid Tailnet URL.");
  }
  return value;
}

export function tailscaleQrCodeUrl(value) {
  const url = canonicalTailnetUrl(value);
  return `/api/tailscale/qr.svg?${new URLSearchParams({ url })}`;
}
