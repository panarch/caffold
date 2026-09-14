import {
  getVoiceSettings,
  removeVoiceKey,
  removeVoiceModel,
  selectVoiceProvider,
  startVoiceModelDownload,
  storeVoiceKey,
} from "../../../../api.js";

const VOICE_PROVIDERS = Object.freeze(["whisper", "openai", "gemini"]);
export const VOICE_KEY_PROVIDERS = Object.freeze(["openai", "gemini"]);

const DOWNLOAD_POLL_INTERVAL_MS = 1_000;
const PHASES = Object.freeze({
  INACTIVE: "inactive",
  LOADING: "loading",
  IDLE: "idle",
  MUTATING: "mutating",
  POLLING: "polling",
});
const PHASE_EDGES = new Map([
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
  } = {}) {
    this.requests = { load, select, startDownload, removeModel, storeKey, removeKey };
    this.onChange = onChange;
    this.schedule = schedule;
    this.cancel = cancel;
    this.active = false;
    this.operation = 0;
    this.pollTimer = null;
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
    this.clearPoll();
    this.transition(PHASES.INACTIVE);
  }

  async refresh() {
    if (
      !this.active ||
      ![PHASES.INACTIVE, PHASES.IDLE].includes(this.phase)
    ) return;
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
      this.message = error?.message ?? "Voice settings could not be loaded.";
      this.transition(PHASES.IDLE);
      this.publish();
    }
  }

  selectProvider(provider) {
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

  storeKey(provider, key) {
    return this.mutate(
      () => this.requests.storeKey(provider, key),
      "The API key could not be saved.",
    );
  }

  removeKey(provider) {
    return this.mutate(
      () => this.requests.removeKey(provider),
      "The API key could not be removed.",
    );
  }

  /** Resolves `true` only when the server accepted the change. */
  async mutate(request, failureMessage) {
    if (
      !this.active ||
      !this.fresh ||
      ![PHASES.IDLE, PHASES.POLLING].includes(this.phase)
    ) return false;
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
      const rejectedByServer = error?.status >= 400 && error?.status < 500;
      if (!rejectedByServer) {
        this.fresh = false;
      }
      this.message = error?.message ?? failureMessage;
      this.settle();
      return false;
    }
  }

  accept(settings) {
    this.settings = settings;
    this.fresh = true;
    this.message = "";
  }

  /** Leaves a request for the phase the last known settings call for. */
  settle() {
    if (this.settings?.whisper.downloading) {
      this.transition(PHASES.POLLING);
      this.publish();
      this.schedulePoll(this.operation);
      return;
    }
    this.transition(PHASES.IDLE);
    this.publish();
  }

  schedulePoll(operation) {
    if (!this.isCurrent(operation, PHASES.POLLING)) return;
    this.pollTimer = this.schedule(() => {
      this.pollTimer = null;
      void this.poll(operation);
    }, DOWNLOAD_POLL_INTERVAL_MS);
  }

  async poll(operation) {
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
      this.message = error?.message ?? "Voice settings could not be refreshed.";
      this.publish();
    }
    this.schedulePoll(operation);
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
        `Invalid voice settings lifecycle transition: ${this.phase} -> ${next}`,
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

function normalizeVoiceSettings(payload) {
  const whisper = payload?.whisper;
  const valid =
    payload &&
    typeof payload === "object" &&
    VOICE_PROVIDERS.includes(payload.selected) &&
    whisper &&
    typeof whisper.model === "string" &&
    typeof whisper.revision === "string" &&
    Number.isFinite(whisper.bytes) &&
    [whisper.installed, whisper.loaded, whisper.downloading].every(
      (value) => typeof value === "boolean",
    ) &&
    (whisper.downloadError === null || typeof whisper.downloadError === "string") &&
    VOICE_KEY_PROVIDERS.every(
      (provider) =>
        typeof payload[provider]?.model === "string" &&
        typeof payload[provider]?.keyConfigured === "boolean",
    );
  if (!valid) {
    throw new Error("Caffold returned invalid voice settings.");
  }
  return {
    selected: payload.selected,
    whisper: {
      model: whisper.model,
      revision: whisper.revision,
      bytes: whisper.bytes,
      installed: whisper.installed,
      loaded: whisper.loaded,
      downloading: whisper.downloading,
      downloadError: whisper.downloadError,
    },
    openai: {
      model: payload.openai.model,
      keyConfigured: payload.openai.keyConfigured,
    },
    gemini: {
      model: payload.gemini.model,
      keyConfigured: payload.gemini.keyConfigured,
    },
  };
}

/** The settings that decide whether the Composer can transcribe. */
export function voiceReadinessKey(settings) {
  return [
    settings.selected,
    settings.whisper.installed,
    settings.openai.keyConfigured,
    settings.gemini.keyConfigured,
  ].join("|");
}
