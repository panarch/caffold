import { getServerSettings, updateServerSettings } from "#app/api.js";
import {
  applyServerIdentity,
  type ServerIdentity,
} from "#app/server-identity.js";

export interface ServerSettings {
  name: string;
  icon: string;
  icons: { id: string; label: string }[];
}

export interface ServerSettingsSnapshot {
  settings: ServerSettings | null;
  /** Whether the name and icon can be changed now. */
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
 * Sequences Settings → Name & Icon reads and changes. A change is refused
 * while another is in flight, so two never reach the server out of order. The
 * server owns the name and icon, and the document shows every answer it gives,
 * even one that arrives after the page was left.
 */
export class ServerSettingsLifecycle {
  private readonly requests: {
    load: () => Promise<unknown>;
    update: (changes: { name?: string; icon?: string }) => Promise<unknown>;
    show: (identity: ServerIdentity) => void;
  };
  private readonly onChange: (snapshot: ServerSettingsSnapshot) => void;
  private active = false;
  private operation = 0;
  phase: Phase = PHASES.INACTIVE;
  private settings: ServerSettings | null = null;
  private message = "";
  snapshot: ServerSettingsSnapshot;

  constructor({
    load = getServerSettings,
    update = updateServerSettings,
    show = applyServerIdentity,
    onChange = () => {},
  }: {
    load?: () => Promise<unknown>;
    update?: (changes: { name?: string; icon?: string }) => Promise<unknown>;
    show?: (identity: ServerIdentity) => void;
    onChange?: (snapshot: ServerSettingsSnapshot) => void;
  } = {}) {
    this.requests = { load, update, show };
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

  /** Resolves `true` only when the server saved the name. */
  saveName(name: string) {
    return this.save({ name });
  }

  /** Resolves `true` only when the server saved the icon. */
  saveIcon(icon: string) {
    return this.save({ icon });
  }

  private async load() {
    const operation = ++this.operation;
    this.transition(PHASES.LOADING);
    this.message = "";
    this.publish();
    try {
      const settings = this.accept(await this.requests.load());
      if (!this.isCurrent(operation)) return;
      this.settings = settings;
      this.transition(PHASES.READY);
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.message =
        (error as Error | null)?.message ||
        "Caffold could not read its name and icon.";
      this.transition(PHASES.UNAVAILABLE);
    }
    this.publish();
  }

  private async save(changes: { name?: string; icon?: string }) {
    if (!this.active || this.phase !== PHASES.READY) return false;
    const operation = ++this.operation;
    this.transition(PHASES.SAVING);
    this.message = "";
    this.publish();
    try {
      const settings = this.accept(await this.requests.update(changes));
      if (!this.isCurrent(operation)) return false;
      this.settings = settings;
      this.transition(PHASES.READY);
      this.publish();
      return true;
    } catch (error) {
      if (!this.isCurrent(operation)) return false;
      const status = (error as { status?: number } | null)?.status ?? 0;
      this.message =
        (error as Error | null)?.message || "The change could not be saved.";
      // Without the server's refusal, whether the change was saved is unknown,
      // so the page reads the settings again before offering another change.
      this.transition(
        status >= 400 && status < 500 ? PHASES.READY : PHASES.UNAVAILABLE,
      );
      this.publish();
      return false;
    }
  }

  private accept(payload: unknown) {
    const settings = normalizeServerSettings(payload);
    this.requests.show({ name: settings.name, icon: settings.icon });
    return settings;
  }

  private transition(next: Phase) {
    if (next === this.phase) return;
    if (!PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid server settings lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  private currentSnapshot(): ServerSettingsSnapshot {
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

function normalizeServerSettings(payload: unknown): ServerSettings {
  const value = payload as Record<string, unknown> | null;
  const icons = value?.icons;
  const valid =
    value &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    typeof value.icon === "string" &&
    Array.isArray(icons) &&
    icons.every(
      (icon) =>
        icon &&
        typeof icon === "object" &&
        typeof icon.id === "string" &&
        typeof icon.label === "string",
    );
  if (!valid) {
    throw new Error("Caffold returned invalid server settings.");
  }
  return {
    name: value.name as string,
    icon: value.icon as string,
    icons: (icons as { id: string; label: string }[]).map(({ id, label }) => ({
      id,
      label,
    })),
  };
}
