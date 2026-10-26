import {
  getVoiceSettings,
  removeVoiceKey,
  removeVoiceModel,
  selectVoiceProvider,
  startVoiceModelDownload,
  storeVoiceKey,
} from "#app/api.ts";

const VOICE_PROVIDERS = Object.freeze(["whisper", "openai", "gemini", "grok"]);
export const VOICE_KEY_PROVIDERS = Object.freeze([
  "openai",
  "gemini",
  "grok",
] as const);

export type VoiceKeyProvider = (typeof VOICE_KEY_PROVIDERS)[number];

export interface VoiceSettings {
  selected: string;
  whisper: {
    model: string;
    revision: string;
    bytes: number;
    installed: boolean;
    loaded: boolean;
    downloading: boolean;
    downloadError: string | null;
  };
  openai: CloudProvider;
  gemini: CloudProvider;
  grok: CloudProvider;
}

interface CloudProvider {
  model: string;
  keyConfigured: boolean;
}

export interface VoiceSettingsSnapshot {
  settings: VoiceSettings | null;
  fresh: boolean;
  busy: boolean;
  retry: boolean;
  message: string;
}

type Request = () => Promise<unknown>;

const DOWNLOAD_POLL_INTERVAL_MS = 1_000;
const PHASES = Object.freeze({
  INACTIVE: "inactive",
  LOADING: "loading",
  IDLE: "idle",
  MUTATING: "mutating",
  POLLING: "polling",
} as const);
type Phase = (typeof PHASES)[keyof typeof PHASES];
const PHASE_EDGES = new Map<Phase, Set<Phase>>([
  [PHASES.INACTIVE, new Set([PHASES.LOADING])],
  [PHASES.LOADING, new Set([PHASES.IDLE, PHASES.POLLING, PHASES.INACTIVE])],
  [PHASES.IDLE, new Set([PHASES.LOADING, PHASES.MUTATING, PHASES.INACTIVE])],
  [PHASES.MUTATING, new Set([PHASES.IDLE, PHASES.POLLING, PHASES.INACTIVE])],
  [PHASES.POLLING, new Set([PHASES.MUTATING, PHASES.IDLE, PHASES.INACTIVE])],
]);

/**
 * Sequences Settings → Voice Input reads and changes. The server owns the
 * selected provider, the keys, and the Whisper download; while a download runs
 * this owner polls, and the page stays usable for other changes.
 */
export class VoiceSettingsLifecycle {
  private readonly requests: {
    load: Request;
    select: (provider: string) => Promise<unknown>;
    startDownload: Request;
    removeModel: Request;
    storeKey: (provider: string, key: string) => Promise<unknown>;
    removeKey: (provider: string) => Promise<unknown>;
  };
  private readonly onChange: (snapshot: VoiceSettingsSnapshot) => void;
  private readonly schedule: (callback: () => void, delay: number) => number;
  private readonly cancel: (timer: number) => void;
  private active = false;
  private operation = 0;
  private pollTimer: number | null = null;
  phase: Phase = PHASES.INACTIVE;
  private settings: VoiceSettings | null = null;
  private fresh = false;
  private message = "";
  snapshot: VoiceSettingsSnapshot;

  constructor({
    load = getVoiceSettings,
    select = selectVoiceProvider,
    startDownload = startVoiceModelDownload,
    removeModel = removeVoiceModel,
    storeKey = storeVoiceKey,
    removeKey = removeVoiceKey,
    onChange = () => {},
    schedule = window.setTimeout.bind(window),
    cancel = window.clearTimeout.bind(window),
  }: {
    load?: Request;
    select?: (provider: string) => Promise<unknown>;
    startDownload?: Request;
    removeModel?: Request;
    storeKey?: (provider: string, key: string) => Promise<unknown>;
    removeKey?: (provider: string) => Promise<unknown>;
    onChange?: (snapshot: VoiceSettingsSnapshot) => void;
    schedule?: (callback: () => void, delay: number) => number;
    cancel?: (timer: number) => void;
  } = {}) {
    this.requests = {
      load,
      select,
      startDownload,
      removeModel,
      storeKey,
      removeKey,
    };
    this.onChange = onChange;
    this.schedule = schedule;
    this.cancel = cancel;
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
      (this.phase !== PHASES.INACTIVE && this.phase !== PHASES.IDLE)
    )
      return;
    const operation = ++this.operation;
    this.transition(PHASES.LOADING);
    this.message = "";
    this.publish();
    try {
      const settings = normalizeVoiceSettings(await this.requests.load());
      if (!this.isCurrent(operation, PHASES.LOADING)) return;
      this.accept(settings);
      this.settle();
    } catch (error) {
      if (!this.isCurrent(operation, PHASES.LOADING)) return;
      this.fresh = false;
      this.message =
        (error as Error | null)?.message ??
        "Voice settings could not be loaded.";
      this.transition(PHASES.IDLE);
      this.publish();
    }
  }

  selectProvider(provider: string) {
    return this.mutate(
      () => this.requests.select(provider),
      "The voice provider could not be changed.",
    );
  }

  startDownload() {
    return this.mutate(
      () => this.requests.startDownload(),
      "The Whisper download could not be started.",
    );
  }

  removeModel() {
    return this.mutate(
      () => this.requests.removeModel(),
      "The Whisper model could not be removed.",
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
  private async mutate(request: Request, failureMessage: string) {
    if (
      !this.active ||
      !this.fresh ||
      (this.phase !== PHASES.IDLE && this.phase !== PHASES.POLLING)
    )
      return false;
    const operation = ++this.operation;
    this.clearPoll();
    this.transition(PHASES.MUTATING);
    this.message = "";
    this.publish();
    try {
      const settings = normalizeVoiceSettings(await request());
      if (!this.isCurrent(operation, PHASES.MUTATING)) return false;
      this.accept(settings);
      this.settle();
      return true;
    } catch (error) {
      if (!this.isCurrent(operation, PHASES.MUTATING)) return false;
      const status = (error as { status?: number } | null)?.status ?? 0;
      const rejectedByServer = status >= 400 && status < 500;
      if (!rejectedByServer) {
        this.fresh = false;
      }
      this.message = (error as Error | null)?.message ?? failureMessage;
      this.settle();
      return false;
    }
  }

  private accept(settings: VoiceSettings) {
    this.settings = settings;
    this.fresh = true;
    this.message = "";
  }

  /** Leaves a request for the phase the last known settings call for. */
  private settle() {
    if (this.settings?.whisper.downloading) {
      this.transition(PHASES.POLLING);
      this.publish();
      this.schedulePoll(this.operation);
      return;
    }
    this.transition(PHASES.IDLE);
    this.publish();
  }

  private schedulePoll(operation: number) {
    if (!this.isCurrent(operation, PHASES.POLLING)) return;
    this.pollTimer = this.schedule(() => {
      this.pollTimer = null;
      void this.poll(operation);
    }, DOWNLOAD_POLL_INTERVAL_MS);
  }

  private async poll(operation: number) {
    if (!this.isCurrent(operation, PHASES.POLLING)) return;
    try {
      const settings = normalizeVoiceSettings(await this.requests.load());
      if (!this.isCurrent(operation, PHASES.POLLING)) return;
      this.accept(settings);
      if (!settings.whisper.downloading) {
        this.transition(PHASES.IDLE);
        this.publish();
        return;
      }
      this.publish();
    } catch (error) {
      if (!this.isCurrent(operation, PHASES.POLLING)) return;
      this.fresh = false;
      this.message =
        (error as Error | null)?.message ??
        "Voice settings could not be refreshed.";
      this.publish();
    }
    this.schedulePoll(operation);
  }

  private clearPoll() {
    if (this.pollTimer !== null) {
      this.cancel(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private transition(next: Phase) {
    if (next === this.phase) return;
    if (!PHASE_EDGES.get(this.phase)?.has(next)) {
      throw new Error(
        `Invalid voice settings lifecycle transition: ${this.phase} -> ${next}`,
      );
    }
    this.phase = next;
  }

  private currentSnapshot(): VoiceSettingsSnapshot {
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

function normalizeVoiceSettings(payload: unknown): VoiceSettings {
  const value = payload as Record<string, Record<string, unknown>> | null;
  const whisper = value?.whisper;
  const valid =
    value &&
    typeof value === "object" &&
    VOICE_PROVIDERS.includes(`${value.selected}`) &&
    whisper &&
    typeof whisper.model === "string" &&
    typeof whisper.revision === "string" &&
    Number.isFinite(whisper.bytes) &&
    [whisper.installed, whisper.loaded, whisper.downloading].every(
      (field) => typeof field === "boolean",
    ) &&
    (whisper.downloadError === null ||
      typeof whisper.downloadError === "string") &&
    VOICE_KEY_PROVIDERS.every(
      (provider) =>
        typeof value[provider]?.model === "string" &&
        typeof value[provider]?.keyConfigured === "boolean",
    );
  if (!valid) {
    throw new Error("Caffold returned invalid voice settings.");
  }
  const settings = payload as VoiceSettings;
  return {
    selected: settings.selected,
    whisper: {
      model: settings.whisper.model,
      revision: settings.whisper.revision,
      bytes: settings.whisper.bytes,
      installed: settings.whisper.installed,
      loaded: settings.whisper.loaded,
      downloading: settings.whisper.downloading,
      downloadError: settings.whisper.downloadError,
    },
    openai: {
      model: settings.openai.model,
      keyConfigured: settings.openai.keyConfigured,
    },
    gemini: {
      model: settings.gemini.model,
      keyConfigured: settings.gemini.keyConfigured,
    },
    grok: {
      model: settings.grok.model,
      keyConfigured: settings.grok.keyConfigured,
    },
  };
}

/** The settings that decide whether the Composer can transcribe. */
export function voiceReadinessKey(settings: VoiceSettings) {
  return [
    settings.selected,
    settings.whisper.installed,
    settings.openai.keyConfigured,
    settings.gemini.keyConfigured,
    settings.grok.keyConfigured,
  ].join("|");
}
