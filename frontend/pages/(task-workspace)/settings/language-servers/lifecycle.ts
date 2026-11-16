import {
  getLanguageServers,
  getRunningLanguageServers,
  type LanguageServerLanguage,
  type LanguageServerSetting,
  type LanguageServersRunning,
  updateLanguageServerLanguages,
  updateLanguageServerRepository,
} from "#app/api.js";
import { announceLanguageServersChange } from "../../language-servers.js";

// The languages as the server last answered, whether a switch can change now,
// the switch being changed and the way it goes while the server has not
// answered, and why the last request failed.
export interface LanguageSettingsSnapshot {
  languages: LanguageServerSetting[] | null;
  ready: boolean;
  busy: boolean;
  saving: { language: LanguageServerLanguage; enabled: boolean } | null;
  retry: boolean;
  message: string;
}

// The running servers as the server last answered, the repository being
// turned off, and why the last request failed.
export interface RunningServersSnapshot {
  running: LanguageServersRunning | null;
  stopping: string | null;
  message: string;
}

// While the page is shown, the running servers are read again this often.
const READ_RUNNING_AGAIN_MS = 3000;

const LANGUAGE_PHASES = Object.freeze({
  INACTIVE: "inactive",
  LOADING: "loading",
  READY: "ready",
  SAVING: "saving",
  UNAVAILABLE: "unavailable",
} as const);
type LanguagePhase = (typeof LANGUAGE_PHASES)[keyof typeof LANGUAGE_PHASES];
const LANGUAGE_PHASE_EDGES = new Map<LanguagePhase, Set<LanguagePhase>>([
  [LANGUAGE_PHASES.INACTIVE, new Set([LANGUAGE_PHASES.LOADING])],
  [
    LANGUAGE_PHASES.LOADING,
    new Set([
      LANGUAGE_PHASES.READY,
      LANGUAGE_PHASES.UNAVAILABLE,
      LANGUAGE_PHASES.INACTIVE,
    ]),
  ],
  [
    LANGUAGE_PHASES.READY,
    new Set([LANGUAGE_PHASES.SAVING, LANGUAGE_PHASES.INACTIVE]),
  ],
  [
    LANGUAGE_PHASES.SAVING,
    new Set([
      LANGUAGE_PHASES.READY,
      LANGUAGE_PHASES.UNAVAILABLE,
      LANGUAGE_PHASES.INACTIVE,
    ]),
  ],
  [
    LANGUAGE_PHASES.UNAVAILABLE,
    new Set([LANGUAGE_PHASES.LOADING, LANGUAGE_PHASES.INACTIVE]),
  ],
]);

// inactive: the page is not shown. reading: the running servers are being
// read. waiting: the next read is scheduled. stopping: a repository's servers
// are being turned off.
const RUNNING_PHASES = Object.freeze({
  INACTIVE: "inactive",
  READING: "reading",
  WAITING: "waiting",
  STOPPING: "stopping",
} as const);
type RunningPhase = (typeof RUNNING_PHASES)[keyof typeof RUNNING_PHASES];
const RUNNING_PHASE_EDGES = new Map<RunningPhase, Set<RunningPhase>>([
  [RUNNING_PHASES.INACTIVE, new Set([RUNNING_PHASES.READING])],
  [
    RUNNING_PHASES.READING,
    new Set([
      RUNNING_PHASES.WAITING,
      RUNNING_PHASES.STOPPING,
      RUNNING_PHASES.INACTIVE,
    ]),
  ],
  [
    RUNNING_PHASES.WAITING,
    new Set([
      RUNNING_PHASES.READING,
      RUNNING_PHASES.STOPPING,
      RUNNING_PHASES.INACTIVE,
    ]),
  ],
  [
    RUNNING_PHASES.STOPPING,
    new Set([RUNNING_PHASES.READING, RUNNING_PHASES.INACTIVE]),
  ],
]);

/**
 * Sequences Settings → Language Servers' language reads and switches. The
 * languages are read when the page is shown, never on a timer. One switch
 * changes at a time, so the server never receives two sets of languages out of
 * order.
 */
export class LanguageSettingsLifecycle {
  private readonly requests: {
    load: () => Promise<unknown>;
    update: (languages: LanguageServerLanguage[]) => Promise<unknown>;
  };
  private readonly onChange: (snapshot: LanguageSettingsSnapshot) => void;
  private readonly announceChange: () => void;
  private active = false;
  private operation = 0;
  phase: LanguagePhase = LANGUAGE_PHASES.INACTIVE;
  private languages: LanguageServerSetting[] | null = null;
  private saving: LanguageSettingsSnapshot["saving"] = null;
  private message = "";
  snapshot: LanguageSettingsSnapshot;

  constructor({
    load = getLanguageServers,
    update = updateLanguageServerLanguages,
    onChange = () => {},
    announceChange = announceLanguageServersChange,
  }: {
    load?: () => Promise<unknown>;
    update?: (languages: LanguageServerLanguage[]) => Promise<unknown>;
    onChange?: (snapshot: LanguageSettingsSnapshot) => void;
    announceChange?: () => void;
  } = {}) {
    this.requests = { load, update };
    this.onChange = onChange;
    this.announceChange = announceChange;
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
    this.saving = null;
    this.transition(LANGUAGE_PHASES.INACTIVE);
    this.publish();
  }

  retry() {
    if (!this.active || this.phase !== LANGUAGE_PHASES.UNAVAILABLE) return;
    void this.load();
  }

  /** Resolves `true` only when the server saved the change. */
  async setEnabled(language: LanguageServerLanguage, enabled: boolean) {
    const languages = this.languages;
    if (!this.active || this.phase !== LANGUAGE_PHASES.READY || !languages) {
      return false;
    }
    const next = languages
      .filter((setting) =>
        setting.id === language ? enabled : setting.enabled,
      )
      .map((setting) => setting.id);
    const operation = ++this.operation;
    this.saving = { language, enabled };
    this.message = "";
    this.transition(LANGUAGE_PHASES.SAVING);
    this.publish();
    try {
      const answer = normalizeLanguages(await this.requests.update(next));
      // The server changed even when the page has been left since.
      this.announceChange();
      if (!this.isCurrent(operation)) return false;
      this.languages = answer;
      this.saving = null;
      this.transition(LANGUAGE_PHASES.READY);
      this.publish();
      return true;
    } catch (error) {
      if (!this.isCurrent(operation)) return false;
      const status = (error as { status?: number } | null)?.status ?? 0;
      this.saving = null;
      this.message =
        (error as Error | null)?.message ||
        "The language could not be turned on or off.";
      // Without the server's refusal, whether the change was saved is
      // unknown, so the languages are read again before another change.
      this.transition(
        status >= 400 && status < 500
          ? LANGUAGE_PHASES.READY
          : LANGUAGE_PHASES.UNAVAILABLE,
      );
      this.publish();
      return false;
    }
  }

  private async load() {
    const operation = ++this.operation;
    this.transition(LANGUAGE_PHASES.LOADING);
    this.message = "";
    this.publish();
    try {
      const answer = normalizeLanguages(await this.requests.load());
      if (!this.isCurrent(operation)) return;
      this.languages = answer;
      this.transition(LANGUAGE_PHASES.READY);
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.languages = null;
      this.message =
        (error as Error | null)?.message ||
        "Caffold could not read the languages.";
      this.transition(LANGUAGE_PHASES.UNAVAILABLE);
    }
    this.publish();
  }

  private transition(next: LanguagePhase) {
    if (next === this.phase) return;
    if (!LANGUAGE_PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid language settings lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  private currentSnapshot(): LanguageSettingsSnapshot {
    return {
      languages: this.languages,
      ready: this.phase === LANGUAGE_PHASES.READY,
      busy:
        this.phase === LANGUAGE_PHASES.LOADING ||
        this.phase === LANGUAGE_PHASES.SAVING,
      saving: this.saving,
      retry: this.phase === LANGUAGE_PHASES.UNAVAILABLE,
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

/**
 * Reads the running servers every few seconds while Settings → Language
 * Servers is shown, and turns a repository's servers off. A failed read shows
 * nothing in place of the servers until a read succeeds; a failed turn off is
 * shown until the next one.
 */
export class RunningServersLifecycle {
  private readonly requests: {
    load: () => Promise<unknown>;
    stop: (path: string) => Promise<unknown>;
  };
  private readonly onChange: (snapshot: RunningServersSnapshot) => void;
  private readonly announceChange: () => void;
  private readonly schedule: (callback: () => void, delay: number) => number;
  private readonly cancel: (timer: number) => void;
  phase: RunningPhase = RUNNING_PHASES.INACTIVE;
  private operation = 0;
  private timer: number | null = null;
  private running: LanguageServersRunning | null = null;
  private stopping: string | null = null;
  private readError = "";
  private stopError = "";
  snapshot: RunningServersSnapshot;

  constructor({
    load = getRunningLanguageServers,
    stop = (path: string) => updateLanguageServerRepository(path, false),
    onChange = () => {},
    announceChange = announceLanguageServersChange,
    schedule = window.setTimeout.bind(window),
    cancel = window.clearTimeout.bind(window),
  }: {
    load?: () => Promise<unknown>;
    stop?: (path: string) => Promise<unknown>;
    onChange?: (snapshot: RunningServersSnapshot) => void;
    announceChange?: () => void;
    schedule?: (callback: () => void, delay: number) => number;
    cancel?: (timer: number) => void;
  } = {}) {
    this.requests = { load, stop };
    this.onChange = onChange;
    this.announceChange = announceChange;
    this.schedule = schedule;
    this.cancel = cancel;
    this.snapshot = this.currentSnapshot();
  }

  activate() {
    if (this.phase !== RUNNING_PHASES.INACTIVE) return;
    void this.read();
  }

  deactivate() {
    if (this.phase === RUNNING_PHASES.INACTIVE) return;
    this.operation += 1;
    this.clearTimer();
    this.stopping = null;
    this.stopError = "";
    this.transition(RUNNING_PHASES.INACTIVE);
    this.publish();
  }

  /** Reads now, past a read already in flight, as after a language changed. */
  refresh() {
    if (
      this.phase === RUNNING_PHASES.READING ||
      this.phase === RUNNING_PHASES.WAITING
    ) {
      void this.read();
    }
  }

  async turnOff(path: string) {
    if (
      this.phase !== RUNNING_PHASES.READING &&
      this.phase !== RUNNING_PHASES.WAITING
    ) {
      return;
    }
    const operation = ++this.operation;
    this.clearTimer();
    this.stopping = path;
    this.stopError = "";
    this.transition(RUNNING_PHASES.STOPPING);
    this.publish();
    try {
      await this.requests.stop(path);
      this.announceChange();
      if (operation !== this.operation) return;
    } catch (error) {
      if (operation !== this.operation) return;
      this.stopError =
        (error as Error | null)?.message ||
        "The language servers could not be turned off.";
    }
    this.stopping = null;
    void this.read();
  }

  private async read() {
    const operation = ++this.operation;
    this.clearTimer();
    this.transition(RUNNING_PHASES.READING);
    this.publish();
    try {
      const answer = normalizeRunning(await this.requests.load());
      if (operation !== this.operation) return;
      this.running = answer;
      this.readError = "";
    } catch (error) {
      if (operation !== this.operation) return;
      this.running = null;
      this.readError =
        (error as Error | null)?.message ||
        "Caffold could not read the running language servers.";
    }
    this.transition(RUNNING_PHASES.WAITING);
    this.publish();
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.read();
    }, READ_RUNNING_AGAIN_MS);
  }

  private clearTimer() {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  private transition(next: RunningPhase) {
    if (next === this.phase) return;
    if (!RUNNING_PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid running language servers lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  private currentSnapshot(): RunningServersSnapshot {
    return {
      running: this.running,
      stopping: this.stopping,
      message: this.stopError || this.readError,
    };
  }

  private publish() {
    this.snapshot = this.currentSnapshot();
    this.onChange(this.snapshot);
  }
}

function normalizeLanguages(payload: unknown): LanguageServerSetting[] {
  const languages = (payload as { languages?: unknown } | null)?.languages;
  if (
    !Array.isArray(languages) ||
    !languages.every(
      (setting) =>
        typeof setting?.id === "string" &&
        typeof setting.enabled === "boolean" &&
        typeof setting.serverName === "string",
    )
  ) {
    throw new Error("Caffold returned invalid language server settings.");
  }
  return languages as LanguageServerSetting[];
}

function normalizeRunning(payload: unknown): LanguageServersRunning {
  const value = payload as Record<string, unknown> | null;
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(value.servers) ||
    typeof value.totalMemoryBytes !== "number"
  ) {
    throw new Error("Caffold returned invalid running language servers.");
  }
  return value as unknown as LanguageServersRunning;
}
