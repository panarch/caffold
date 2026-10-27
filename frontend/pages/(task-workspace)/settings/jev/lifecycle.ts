import {
  getJevSettings,
  removeJevKey,
  saveJevCriteria,
  storeJevKey,
} from "#app/api.js";

export interface JevSettings {
  model: string;
  keyConfigured: boolean;
  criteria: string;
  lastCheck: {
    ok: boolean;
    message: string | null;
    model: string | null;
  } | null;
}

export interface JevSettingsSnapshot {
  settings: JevSettings | null;
  fresh: boolean;
  busy: boolean;
  retry: boolean;
  message: string;
}

const PHASES = Object.freeze({
  INACTIVE: "inactive",
  LOADING: "loading",
  IDLE: "idle",
  MUTATING: "mutating",
} as const);
type Phase = (typeof PHASES)[keyof typeof PHASES];
const PHASE_EDGES = new Map<Phase, Set<Phase>>([
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
  private readonly requests: {
    load: () => Promise<unknown>;
    saveCriteria: (criteria: string) => Promise<unknown>;
    storeKey: (key: string) => Promise<unknown>;
    removeKey: () => Promise<unknown>;
  };
  private readonly onChange: (snapshot: JevSettingsSnapshot) => void;
  private active = false;
  private operation = 0;
  phase: Phase = PHASES.INACTIVE;
  private settings: JevSettings | null = null;
  private fresh = false;
  private message = "";
  snapshot: JevSettingsSnapshot;

  constructor({
    load = getJevSettings,
    saveCriteria = saveJevCriteria,
    storeKey = storeJevKey,
    removeKey = removeJevKey,
    onChange = () => {},
  }: {
    load?: () => Promise<unknown>;
    saveCriteria?: (criteria: string) => Promise<unknown>;
    storeKey?: (key: string) => Promise<unknown>;
    removeKey?: () => Promise<unknown>;
    onChange?: (snapshot: JevSettingsSnapshot) => void;
  } = {}) {
    this.requests = { load, saveCriteria, storeKey, removeKey };
    this.onChange = onChange;
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
    if (
      !this.active ||
      (this.phase !== PHASES.INACTIVE && this.phase !== PHASES.IDLE)
    )
      return;
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
      this.message =
        (error as Error | null)?.message ?? "Jev settings could not be loaded.";
      this.transition(PHASES.IDLE);
      this.publish();
    }
  }

  saveCriteria(criteria: string) {
    return this.mutate(
      () => this.requests.saveCriteria(criteria),
      "The rules could not be saved.",
    );
  }

  storeKey(key: string) {
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
  private async mutate(
    request: () => Promise<unknown>,
    failureMessage: string,
  ) {
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
      const status = (error as { status?: number } | null)?.status ?? 0;
      const rejectedByServer = status >= 400 && status < 500;
      if (!rejectedByServer) {
        this.fresh = false;
      }
      this.message = (error as Error | null)?.message ?? failureMessage;
      this.transition(PHASES.IDLE);
      this.publish();
      return false;
    }
  }

  private accept(settings: JevSettings) {
    this.settings = settings;
    this.fresh = true;
    this.message = "";
  }

  private transition(next: Phase) {
    if (next === this.phase) return;
    if (!PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid Jev settings lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  private currentSnapshot(): JevSettingsSnapshot {
    return {
      settings: this.settings,
      fresh: this.fresh,
      busy: this.phase === PHASES.LOADING || this.phase === PHASES.MUTATING,
      retry: this.phase === PHASES.IDLE && !this.fresh,
      message: this.message,
    };
  }

  private publish() {
    this.snapshot = this.currentSnapshot();
    this.onChange(this.snapshot);
  }

  private isCurrent(operation: number, phase: Phase) {
    return this.active && operation === this.operation && this.phase === phase;
  }
}

function normalizeJevSettings(payload: unknown): JevSettings {
  const value = payload as Record<string, unknown> | null;
  const check = (value?.lastCheck ?? null) as Record<string, unknown> | null;
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
    value &&
    typeof value === "object" &&
    typeof value.model === "string" &&
    typeof value.keyConfigured === "boolean" &&
    typeof value.criteria === "string" &&
    validCheck;
  if (!valid) {
    throw new Error("Caffold returned invalid Jev settings.");
  }
  return {
    model: value.model as string,
    keyConfigured: value.keyConfigured as boolean,
    criteria: value.criteria as string,
    lastCheck: check
      ? {
          ok: check.ok as boolean,
          message: (check.message as string | null | undefined) ?? null,
          model: (check.model as string | null | undefined) ?? null,
        }
      : null,
  };
}
