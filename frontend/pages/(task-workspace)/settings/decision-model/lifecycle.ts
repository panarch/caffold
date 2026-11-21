import {
  getDecisionModelSettings,
  removeDecisionModelKey,
  saveDecisionModelCriteria,
  selectDecisionModelProvider,
  storeDecisionModelKey,
} from "#app/api.js";

export const DECISION_MODEL_PROVIDERS = Object.freeze([
  "jev",
  "openai",
] as const);

export type DecisionModelProvider = (typeof DECISION_MODEL_PROVIDERS)[number];

export interface DecisionModelKeyCheck {
  ok: boolean;
  message: string | null;
}

export interface DecisionModelProviderSettings {
  keyConfigured: boolean;
  lastCheck: DecisionModelKeyCheck | null;
}

export interface DecisionModelSettings {
  selected: DecisionModelProvider;
  criteria: string;
  jev: DecisionModelProviderSettings;
  openai: DecisionModelProviderSettings;
}

export interface DecisionModelSettingsSnapshot {
  settings: DecisionModelSettings | null;
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
 * Sequences Settings → Decision Model reads and changes. The server owns the
 * choice, the keys, the rules, and what the last check of each key said; this
 * owner only decides which request is the current one.
 */
export class DecisionModelSettingsLifecycle {
  private readonly requests: {
    load: () => Promise<unknown>;
    selectProvider: (provider: string) => Promise<unknown>;
    saveCriteria: (criteria: string) => Promise<unknown>;
    storeKey: (provider: string, key: string) => Promise<unknown>;
    removeKey: (provider: string) => Promise<unknown>;
  };
  private readonly onChange: (snapshot: DecisionModelSettingsSnapshot) => void;
  private active = false;
  private operation = 0;
  phase: Phase = PHASES.INACTIVE;
  private settings: DecisionModelSettings | null = null;
  private fresh = false;
  private message = "";
  snapshot: DecisionModelSettingsSnapshot;

  constructor({
    load = getDecisionModelSettings,
    selectProvider = selectDecisionModelProvider,
    saveCriteria = saveDecisionModelCriteria,
    storeKey = storeDecisionModelKey,
    removeKey = removeDecisionModelKey,
    onChange = () => {},
  }: {
    load?: () => Promise<unknown>;
    selectProvider?: (provider: string) => Promise<unknown>;
    saveCriteria?: (criteria: string) => Promise<unknown>;
    storeKey?: (provider: string, key: string) => Promise<unknown>;
    removeKey?: (provider: string) => Promise<unknown>;
    onChange?: (snapshot: DecisionModelSettingsSnapshot) => void;
  } = {}) {
    this.requests = { load, selectProvider, saveCriteria, storeKey, removeKey };
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
      const settings = normalizeDecisionModelSettings(
        await this.requests.load(),
      );
      if (!this.isCurrent(operation, PHASES.LOADING)) return;
      this.accept(settings);
      this.transition(PHASES.IDLE);
      this.publish();
    } catch (error) {
      if (!this.isCurrent(operation, PHASES.LOADING)) return;
      this.fresh = false;
      this.message =
        (error as Error | null)?.message ??
        "Decision model settings could not be loaded.";
      this.transition(PHASES.IDLE);
      this.publish();
    }
  }

  selectProvider(provider: string) {
    if (provider === this.settings?.selected) return Promise.resolve(false);
    return this.mutate(
      () => this.requests.selectProvider(provider),
      "The decision model could not be chosen.",
    );
  }

  saveCriteria(criteria: string) {
    return this.mutate(
      () => this.requests.saveCriteria(criteria),
      "The rules could not be saved.",
    );
  }

  storeKey(provider: string, key: string) {
    return this.mutate(
      () => this.requests.storeKey(provider, key),
      "The API key could not be saved.",
    );
  }

  removeKey(provider: string) {
    return this.mutate(
      () => this.requests.removeKey(provider),
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
      const settings = normalizeDecisionModelSettings(await request());
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

  private accept(settings: DecisionModelSettings) {
    this.settings = settings;
    this.fresh = true;
    this.message = "";
  }

  private transition(next: Phase) {
    if (next === this.phase) return;
    if (!PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid decision model settings lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  private currentSnapshot(): DecisionModelSettingsSnapshot {
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

function normalizeDecisionModelSettings(
  payload: unknown,
): DecisionModelSettings {
  const value = payload as Record<string, unknown> | null;
  const jev = normalizeProviderSettings(value?.jev);
  const openai = normalizeProviderSettings(value?.openai);
  const selected = value?.selected;
  const valid =
    value &&
    typeof value === "object" &&
    DECISION_MODEL_PROVIDERS.includes(selected as DecisionModelProvider) &&
    typeof value.criteria === "string" &&
    jev &&
    openai;
  if (!valid) {
    throw new Error("Caffold returned invalid decision model settings.");
  }
  return {
    selected: selected as DecisionModelProvider,
    criteria: value.criteria as string,
    jev,
    openai,
  };
}

function normalizeProviderSettings(
  payload: unknown,
): DecisionModelProviderSettings | null {
  const value = payload as Record<string, unknown> | null;
  if (!value || typeof value !== "object") return null;
  const check = (value.lastCheck ?? null) as Record<string, unknown> | null;
  const validCheck =
    check === null ||
    (typeof check === "object" &&
      typeof check.ok === "boolean" &&
      (check.message === null ||
        check.message === undefined ||
        typeof check.message === "string"));
  if (typeof value.keyConfigured !== "boolean" || !validCheck) return null;
  return {
    keyConfigured: value.keyConfigured,
    lastCheck: check
      ? {
          ok: check.ok as boolean,
          message: (check.message as string | null | undefined) ?? null,
        }
      : null,
  };
}
