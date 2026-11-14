import { getClaudeSettings, updateClaudeSettings } from "#app/api.js";

export interface ClaudeSettings {
  /** The config directory new Tasks run under; `null` is Claude's default. */
  configDir: string | null;
  /** Claude's default, which an empty setting runs under. */
  defaultConfigDir: string | null;
}

export interface ClaudeSettingsSnapshot {
  settings: ClaudeSettings | null;
  /** Whether the config directory can be changed now. */
  ready: boolean;
  busy: boolean;
  retry: boolean;
  message: string;
}

const PHASES = Object.freeze({
  INACTIVE: "inactive",
  LOADING: "loading",
  READY: "ready",
  SAVING: "saving",
  UNAVAILABLE: "unavailable",
} as const);
type Phase = (typeof PHASES)[keyof typeof PHASES];
const PHASE_EDGES = new Map<Phase, Set<Phase>>([
  [PHASES.INACTIVE, new Set([PHASES.LOADING])],
  [
    PHASES.LOADING,
    new Set([PHASES.READY, PHASES.UNAVAILABLE, PHASES.INACTIVE]),
  ],
  [PHASES.READY, new Set([PHASES.SAVING, PHASES.INACTIVE])],
  [PHASES.SAVING, new Set([PHASES.READY, PHASES.UNAVAILABLE, PHASES.INACTIVE])],
  [PHASES.UNAVAILABLE, new Set([PHASES.LOADING, PHASES.INACTIVE])],
]);

/**
 * Sequences Settings → Claude's config directory reads and changes. A change
 * is refused while another is in flight, and checking the sign-in can take
 * seconds, so the two never reach the server out of order. The server owns the
 * setting; the page shows only what it answered.
 */
export class ClaudeSettingsLifecycle {
  private readonly requests: {
    load: () => Promise<unknown>;
    update: (configDir: string) => Promise<unknown>;
  };
  private readonly onChange: (snapshot: ClaudeSettingsSnapshot) => void;
  private active = false;
  private operation = 0;
  phase: Phase = PHASES.INACTIVE;
  private settings: ClaudeSettings | null = null;
  private message = "";
  snapshot: ClaudeSettingsSnapshot;

  constructor({
    load = getClaudeSettings,
    update = updateClaudeSettings,
    onChange = () => {},
  }: {
    load?: () => Promise<unknown>;
    update?: (configDir: string) => Promise<unknown>;
    onChange?: (snapshot: ClaudeSettingsSnapshot) => void;
  } = {}) {
    this.requests = { load, update };
    this.onChange = onChange;
    this.snapshot = this.currentSnapshot();
  }

  activate() {
    if (this.active) return;
    this.active = true;
    void this.load();
  }

  deactivate() {
    if (!this.active) return;
    this.active = false;
    this.operation += 1;
    this.transition(PHASES.INACTIVE);
  }

  retry() {
    if (!this.active || this.phase !== PHASES.UNAVAILABLE) return;
    void this.load();
  }

  /** Resolves `true` only when the server saved the directory. */
  async save(configDir: string) {
    if (!this.active || this.phase !== PHASES.READY) return false;
    const operation = ++this.operation;
    this.transition(PHASES.SAVING);
    this.message = "";
    this.publish();
    try {
      const settings = normalizeClaudeSettings(
        await this.requests.update(configDir),
      );
      if (!this.isCurrent(operation)) return false;
      this.settings = settings;
      this.transition(PHASES.READY);
      this.publish();
      return true;
    } catch (error) {
      if (!this.isCurrent(operation)) return false;
      const status = (error as { status?: number } | null)?.status ?? 0;
      this.message =
        (error as Error | null)?.message ||
        "The config directory could not be saved.";
      // Without the server's refusal, whether the folder was saved is unknown,
      // so the page reads the setting again before offering another change.
      this.transition(
        status >= 400 && status < 500 ? PHASES.READY : PHASES.UNAVAILABLE,
      );
      this.publish();
      return false;
    }
  }

  private async load() {
    const operation = ++this.operation;
    this.transition(PHASES.LOADING);
    this.message = "";
    this.publish();
    try {
      const settings = normalizeClaudeSettings(await this.requests.load());
      if (!this.isCurrent(operation)) return;
      this.settings = settings;
      this.transition(PHASES.READY);
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.message =
        (error as Error | null)?.message ||
        "Caffold could not read Claude's config directory.";
      this.transition(PHASES.UNAVAILABLE);
    }
    this.publish();
  }

  private transition(next: Phase) {
    if (next === this.phase) return;
    if (!PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid Claude settings lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  private currentSnapshot(): ClaudeSettingsSnapshot {
    return {
      settings: this.settings,
      ready: this.phase === PHASES.READY,
      busy: this.phase === PHASES.LOADING || this.phase === PHASES.SAVING,
      retry: this.phase === PHASES.UNAVAILABLE,
      message: this.message,
    };
  }

  private publish() {
    this.snapshot = this.currentSnapshot();
    this.onChange(this.snapshot);
  }

  private isCurrent(operation: number) {
    return this.active && operation === this.operation;
  }
}

function normalizeClaudeSettings(payload: unknown): ClaudeSettings {
  const value = payload as Record<string, unknown> | null;
  const text = (field: unknown) => field === null || typeof field === "string";
  if (
    !value ||
    typeof value !== "object" ||
    !text(value.configDir) ||
    !text(value.defaultConfigDir)
  ) {
    throw new Error("Caffold returned invalid Claude settings.");
  }
  return {
    configDir: value.configDir as string | null,
    defaultConfigDir: value.defaultConfigDir as string | null,
  };
}
