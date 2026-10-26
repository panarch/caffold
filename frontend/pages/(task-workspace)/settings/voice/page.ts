import { html, LitElement } from "lit";
import { live } from "lit/directives/live.js";
import {
  ACTION_HINT_ACTION,
  type ActionHintPull,
  ActionHints,
} from "#app/action-hints.ts";
import { type ScrollSurfacePull, ScrollSurfaces } from "#app/scroll-scope.ts";
import { DrawnRef, DrawnRefs, drawn } from "#components/drawn-refs.ts";
import "../components/detail-list.ts";
import {
  VOICE_KEY_PROVIDERS,
  type VoiceKeyProvider,
  type VoiceSettings,
  VoiceSettingsLifecycle,
  type VoiceSettingsSnapshot,
  voiceReadinessKey,
} from "./lifecycle.ts";

const PROVIDER_CHOICES = Object.freeze([
  {
    id: "whisper",
    label: "Whisper",
    detail: "Transcribes on this Mac after a one-time model download.",
  },
  {
    id: "openai",
    label: "OpenAI",
    detail: "Sends each recording to OpenAI with the API key saved here.",
  },
  {
    id: "gemini",
    label: "Gemini",
    detail:
      "Sends each recording to Google Gemini with the API key saved here.",
  },
  {
    id: "grok",
    label: "Grok",
    detail: "Sends each recording to Grok with the API key saved here.",
  },
]);
const KEY_PROVIDER_NAMES: Readonly<Record<VoiceKeyProvider, string>> =
  Object.freeze({ openai: "OpenAI", gemini: "Gemini", grok: "Grok" });
const PROVIDER_DESCRIPTION =
  "settings-voice-description settings-voice-provider-note";

export class CaffoldSettingsVoicePage extends LitElement {
  static properties = {
    snapshot: { state: true },
  };

  declare private snapshot: VoiceSettingsSnapshot;
  private active = false;
  private announcedReadiness = "";
  private readonly lifecycle = new VoiceSettingsLifecycle({
    onChange: (snapshot) => {
      this.snapshot = snapshot;
      this.announceReadiness(snapshot.settings);
    },
  });
  private readonly hints: ActionHints = new ActionHints(this, {
    clipRoots: () => [this, this.scrollport.value],
  });
  private readonly surfaces = new ScrollSurfaces(this);
  private readonly scrollport = new DrawnRef<HTMLDivElement>(this);
  private readonly choiceLabels = new DrawnRefs<HTMLLabelElement>(this);
  private readonly keyInputs = new DrawnRefs<HTMLInputElement>(this);

  constructor() {
    super();
    this.snapshot = {
      settings: null,
      fresh: false,
      busy: false,
      retry: false,
      message: "",
    };
  }

  createRenderRoot() {
    return this;
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.deactivate();
  }

  activate() {
    if (this.active) return;
    this.active = true;
    this.lifecycle.activate();
  }

  deactivate() {
    this.active = false;
    this.lifecycle.deactivate();
  }

  render() {
    const { settings, fresh, busy, retry, message } = this.snapshot;
    const locked = busy || !fresh || !settings;
    const whisper = settings?.whisper ?? null;
    const whisperRows = [
      { key: "model", label: "Model", value: whisper?.model, kind: "code" },
      {
        key: "revision",
        label: "Revision",
        value: whisper?.revision.slice(0, 7),
        kind: "code",
      },
      { key: "status", label: "Status", value: whisperStatus(whisper) },
    ] as const;
    const downloadShown = Boolean(
      whisper && !whisper.installed && !whisper.downloading,
    );
    const removeShown = Boolean(whisper?.installed && !whisper.downloading);
    return html`
      <div
        ${drawn(this.scrollport)}
        ${this.surfaces.surface({
          id: "scroll",
          clipRoots: () => [this, this.scrollport.value],
        })}
        class="settings-content-scroll"
      >
        <div class="settings-content-section">
          <header>
            <div>
              <p id="settings-voice-description">
                Choose how voice input from the Task composer becomes text.
              </p>
              <p id="settings-voice-provider-note">
                Whisper runs on this Mac. OpenAI, Gemini, and Grok receive each
                recording from this Caffold server.
              </p>
            </div>
            <button
              ${this.hints.button({
                id: "refresh",
                label: "Retry loading voice settings",
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action="refresh"
              ?hidden=${!retry}
              @click=${this.refresh}
            >Retry</button>
          </header>
          <p
            class="settings-voice-message"
            role="alert"
            ?hidden=${!message}
          >${message}</p>
          <fieldset
            class="settings-voice-options"
            aria-describedby=${PROVIDER_DESCRIPTION}
            aria-busy=${String(busy)}
          >
            <legend class="sr-only">Speech-to-text provider</legend>
            ${PROVIDER_CHOICES.map(
              (choice) => html`
                <label ${drawn(this.choiceLabels.of(choice.id))}>
                  <input
                    ${this.hints.radio({
                      id: `provider:${choice.id}`,
                      label: `Use ${choice.label} for voice input`,
                      action: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
                      when: settings?.selected !== choice.id,
                      anchor: () => this.choiceLabels.get(choice.id),
                    })}
                    type="radio"
                    name="voice-provider"
                    value=${choice.id}
                    .checked=${live(settings?.selected === choice.id)}
                    ?disabled=${locked}
                    @change=${this.chooseProvider}
                  >
                  <span class="settings-voice-option-copy">
                    <strong>${choice.label}</strong>
                    <span>${choice.detail}</span>
                  </span>
                </label>
              `,
            )}
          </fieldset>
          <section
            class="settings-voice-provider"
            data-provider="whisper"
            aria-labelledby="settings-voice-whisper-title"
          >
            <h2 id="settings-voice-whisper-title">Whisper</h2>
            <caffold-settings-detail-list
              .rows=${whisperRows}
            ></caffold-settings-detail-list>
            <p
              class="settings-voice-download-error"
              role="status"
              ?hidden=${!whisper?.downloadError}
            >${whisper?.downloadError ?? ""}</p>
            <div class="settings-voice-actions">
              <button
                ${this.hints.button({
                  id: "download-model",
                  label: "Download the Whisper model",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                data-action="download-model"
                ?hidden=${!downloadShown}
                ?disabled=${locked}
                @click=${this.downloadModel}
              >Download</button>
              <button
                ${this.hints.button({
                  id: "cancel-download",
                  label: "Cancel the Whisper download",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                data-action="cancel-download"
                ?hidden=${!whisper?.downloading}
                ?disabled=${locked}
                @click=${this.removeModel}
              >Cancel download</button>
              <button
                ${this.hints.button({
                  id: "remove-model",
                  label: "Delete the Whisper model",
                  action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
                })}
                type="button"
                data-action="remove-model"
                ?hidden=${!removeShown}
                ?disabled=${locked}
                @click=${this.removeModel}
              >Delete model</button>
            </div>
          </section>
          ${VOICE_KEY_PROVIDERS.map((provider) =>
            this.keyProvider(provider, settings, locked),
          )}
        </div>
      </div>
    `;
  }

  actionHintScope({
    scopeId = "settings:voice",
    ...pull
  }: ActionHintPull = {}) {
    return this.hints.scope({ ...pull, scopeId });
  }

  scrollSurfaceScope({
    scopeId = "settings:voice",
    label = "Voice Input settings",
    ...pull
  }: ScrollSurfacePull = {}) {
    return this.surfaces.scope({ ...pull, scopeId, label });
  }

  private keyProvider(
    provider: VoiceKeyProvider,
    settings: VoiceSettings | null,
    locked: boolean,
  ) {
    const cloud = settings?.[provider] ?? null;
    const saved = Boolean(cloud?.keyConfigured);
    const name = KEY_PROVIDER_NAMES[provider];
    const rows = [
      { key: "model", label: "Model", value: cloud?.model, kind: "code" },
      {
        key: "api-key",
        label: "API key",
        value: cloud ? (saved ? "Saved" : "Not saved") : undefined,
      },
    ] as const;
    const placeholder = saved ? "Enter a new key to replace the saved one" : "";
    return html`
      <section
        class="settings-voice-provider"
        data-provider=${provider}
        aria-labelledby=${`settings-voice-${provider}-title`}
      >
        <h2 id=${`settings-voice-${provider}-title`}>${name}</h2>
        <caffold-settings-detail-list
          .rows=${rows}
        ></caffold-settings-detail-list>
        <form
          class="settings-voice-key"
          data-key-provider=${provider}
          @submit=${this.saveKey}
        >
          <label for=${`settings-voice-${provider}-key`}>${
            saved ? "Replace API key" : "API key"
          }</label>
          <div class="settings-voice-key-row">
            <input
              ${drawn(this.keyInputs.of(provider))}
              ${this.hints.textbox({
                id: `key:${provider}`,
                label: `Focus ${name} API key`,
                action: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
              })}
              id=${`settings-voice-${provider}-key`}
              name="key"
              type="password"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder=${placeholder}
              ?disabled=${locked}
            >
            <button
              ${this.hints.button({
                id: `save-key:${provider}`,
                label: `Save the ${name} API key`,
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="submit"
              ?disabled=${locked}
            >Save key</button>
            <button
              ${this.hints.button({
                id: `remove-key:${provider}`,
                label: `Remove the ${name} API key`,
                action: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
              })}
              type="button"
              data-action="remove-key"
              data-provider=${provider}
              ?hidden=${!saved}
              ?disabled=${locked}
              @click=${this.removeKey}
            >Remove key</button>
          </div>
        </form>
      </section>
    `;
  }

  /**
   * Composers stay mounted while Settings is open, so they are told when the
   * values that decide their readiness change and read their own status again.
   */
  private announceReadiness(settings: VoiceSettings | null) {
    if (!settings) return;
    const readiness = voiceReadinessKey(settings);
    if (readiness === this.announcedReadiness) return;
    this.announcedReadiness = readiness;
    window.dispatchEvent(new CustomEvent("caffold:voice-settings-changed"));
  }

  private refresh() {
    void this.lifecycle.refresh();
  }

  private downloadModel() {
    void this.lifecycle.startDownload();
  }

  private removeModel() {
    void this.lifecycle.removeModel();
  }

  private removeKey(event: Event) {
    const provider = (event.currentTarget as HTMLElement).dataset.provider;
    void this.lifecycle.removeKey(provider ?? "");
  }

  // A provider the server refused leaves its radio checked until the next
  // render puts the selected one back.
  private async chooseProvider(event: Event) {
    const choice = event.currentTarget as HTMLInputElement;
    if (!choice.checked) return;
    if (!(await this.lifecycle.selectProvider(choice.value))) {
      this.requestUpdate();
    }
  }

  private async saveKey(event: Event) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const provider = form.dataset.keyProvider ?? "";
    const input = this.keyInputs.get(provider);
    if (!input) return;
    if (await this.lifecycle.storeKey(provider, input.value)) {
      input.value = "";
    }
  }
}

function whisperStatus(whisper: VoiceSettings["whisper"] | null) {
  if (!whisper) return undefined;
  const size = formatBytes(whisper.bytes);
  if (whisper.downloading) return `Downloading (${size})`;
  if (!whisper.installed) return `Not downloaded (${size})`;
  return whisper.loaded ? "Loaded in memory" : "Downloaded";
}

function formatBytes(bytes: number) {
  const gibibyte = 1024 ** 3;
  return bytes >= gibibyte
    ? `${(bytes / gibibyte).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

customElements.define("caffold-settings-voice-page", CaffoldSettingsVoicePage);
