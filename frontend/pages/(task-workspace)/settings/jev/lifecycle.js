import {
  getJevSettings,
  removeJevKey,
  saveJevCriteria,
  storeJevKey,
} from "../../../../api.js";

const PHASES = Object.freeze({
  INACTIVE: "inactive",
  LOADING: "loading",
  IDLE: "idle",
  MUTATING: "mutating",
});
const PHASE_EDGES = new Map([
  [PHASES.INACTIVE, new Set([PHASES.LOADING])],
  [PHASES.LOADING, new Set([PHASES.IDLE, PHASES.INACTIVE])],
  [PHASES.IDLE, new Set([PHASES.LOADING, PHASES.MUTATING, PHASES.INACTIVE])],
  [PHASES.MUTATING, new Set([PHASES.IDLE, PHASES.INACTIVE])],
]);

/**
 * Sequences Settings → Jev Permissions reads and changes. The server owns the
 * rules, the key, and what the last check of that key said; this owner only
 * decides which request is the current one.
 */
export class JevSettingsLifecycle {
  constructor({
    load = getJevSettings,
    saveCriteria = saveJevCriteria,
    storeKey = storeJevKey,
    removeKey = removeJevKey,
    onChange = () => {},
  } = {}) {
    this.requests = { load, saveCriteria, storeKey, removeKey };
    this.onChange = onChange;
    this.active = false;
    this.operation = 0;
    this.phase = PHASES.INACTIVE;
    this.settings = null;
    this.fresh = false;
    this.message = "";
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
    this.transition(PHASES.INACTIVE);
  }

  async refresh() {
    if (!this.active || ![PHASES.INACTIVE, PHASES.IDLE].includes(this.phase)) return;
    const operation = ++this.operation;
    this.transition(PHASES.LOADING);
    this.message = "";
    this.publish();
    try {
      const settings = normalizeJevSettings(await this.requests.load());
      if (!this.isCurrent(operation, PHASES.LOADING)) return;
      this.accept(settings);
      this.transition(PHASES.IDLE);
      this.publish();
    } catch (error) {
      if (!this.isCurrent(operation, PHASES.LOADING)) return;
      this.fresh = false;
      this.message = error?.message ?? "Jev settings could not be loaded.";
      this.transition(PHASES.IDLE);
      this.publish();
    }
  }

  saveCriteria(criteria) {
    return this.mutate(
      () => this.requests.saveCriteria(criteria),
      "The rules could not be saved.",
    );
  }

  storeKey(key) {
    return this.mutate(
      () => this.requests.storeKey(key),
      "The API key could not be saved.",
    );
  }

  removeKey() {
    return this.mutate(
      () => this.requests.removeKey(),
      "The API key could not be removed.",
    );
  }

  /** Resolves `true` only when the server accepted the change. */
  async mutate(request, failureMessage) {
    if (!this.active || !this.fresh || this.phase !== PHASES.IDLE) return false;
    const operation = ++this.operation;
    this.transition(PHASES.MUTATING);
    this.message = "";
    this.publish();
    try {
      const settings = normalizeJevSettings(await request());
      if (!this.isCurrent(operation, PHASES.MUTATING)) return false;
      this.accept(settings);
      this.transition(PHASES.IDLE);
      this.publish();
      return true;
    } catch (error) {
      if (!this.isCurrent(operation, PHASES.MUTATING)) return false;
      const rejectedByServer = error?.status >= 400 && error?.status < 500;
      if (!rejectedByServer) {
        this.fresh = false;
      }
      this.message = error?.message ?? failureMessage;
      this.transition(PHASES.IDLE);
      this.publish();
      return false;
    }
  }

  accept(settings) {
    this.settings = settings;
    this.fresh = true;
    this.message = "";
  }

  transition(next) {
    if (next === this.phase) return;
    if (!PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid Jev settings lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  currentSnapshot() {
    return {
      settings: this.settings,
      fresh: this.fresh,
      busy: [PHASES.LOADING, PHASES.MUTATING].includes(this.phase),
      retry: this.phase === PHASES.IDLE && !this.fresh,
      message: this.message,
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

function normalizeJevSettings(payload) {
  const check = payload?.lastCheck ?? null;
  const validCheck =
    check === null ||
    (typeof check === "object" &&
      typeof check.ok === "boolean" &&
      (check.message === null ||
        check.message === undefined ||
        typeof check.message === "string") &&
      (check.model === null ||
        check.model === undefined ||
        typeof check.model === "string"));
  const valid =
    payload &&
    typeof payload === "object" &&
    typeof payload.model === "string" &&
    typeof payload.keyConfigured === "boolean" &&
    typeof payload.criteria === "string" &&
    validCheck;
  if (!valid) {
    throw new Error("Caffold returned invalid Jev settings.");
  }
  return {
    model: payload.model,
    keyConfigured: payload.keyConfigured,
    criteria: payload.criteria,
    lastCheck: check
      ? {
        ok: check.ok,
        message: check.message ?? null,
        model: check.model ?? null,
      }
      : null,
  };
}
