import { html, LitElement } from "lit";
import { live } from "lit/directives/live.js";
import {
  type ActionHintScope,
  type ActionHintScopeOptions,
  buttonActionHintTarget,
  emptyActionHintScope,
  hasActionHintLayoutBox,
} from "#app/action-hint-scope.js";
import {
  ACTION_HINT_ACTION,
  radioActionHintTarget,
  textboxActionHintTarget,
} from "#app/action-hints.js";
import {
  emptyScrollSurfaceScope,
  hasScrollLayoutBox,
  type ScrollSurfaceScope,
  type ScrollSurfaceScopeOptions,
} from "#app/scroll-scope.js";
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
const ACTION_BUTTONS = Object.freeze([
  {
    id: "refresh",
    selector: 'button[data-action="refresh"]',
    label: "Retry loading voice settings",
  },
  {
    id: "download-model",
    selector: 'button[data-action="download-model"]',
    label: "Download the Whisper model",
  },
  {
    id: "cancel-download",
    selector: 'button[data-action="cancel-download"]',
    label: "Cancel the Whisper download",
  },
  {
    id: "remove-model",
    selector: 'button[data-action="remove-model"]',
    label: "Delete the Whisper model",
  },
  ...VOICE_KEY_PROVIDERS.flatMap((provider) => [
    {
      id: `save-key:${provider}`,
      selector: `form[data-key-provider="${provider}"] button[type="submit"]`,
      label: `Save the ${KEY_PROVIDER_NAMES[provider]} API key`,
    },
    {
      id: `remove-key:${provider}`,
      selector: `button[data-action="remove-key"][data-provider="${provider}"]`,
      label: `Remove the ${KEY_PROVIDER_NAMES[provider]} API key`,
    },
  ]),
]);

const PROVIDER_DESCRIPTION =
  "settings-voice-description settings-voice-provider-note";

interface ScopeContext {
  scopeId: string;
  clipRoots: Element[];
  isCurrent: () => boolean;
}

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
      <div class="settings-content-scroll">
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
                <label>
                  <input
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
                type="button"
                data-action="download-model"
                ?hidden=${!downloadShown}
                ?disabled=${locked}
                @click=${this.downloadModel}
              >Download</button>
              <button
                type="button"
                data-action="cancel-download"
                ?hidden=${!whisper?.downloading}
                ?disabled=${locked}
                @click=${this.removeModel}
              >Cancel download</button>
              <button
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
    clipRoots = [],
    isCurrent = () => true,
  }: ActionHintScopeOptions & {
    isCurrent?: () => boolean;
  } = {}): ActionHintScope {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyActionHintScope();
    }
    const context = {
      scopeId,
      isCurrent,
      clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
    };
    return {
      blocked: false,
      targets: [
        ...PROVIDER_CHOICES.flatMap((choice) =>
          providerChoiceTarget(this, context, choice),
        ),
        ...ACTION_BUTTONS.flatMap((definition) =>
          actionButtonTarget(this, context, definition),
        ),
        ...VOICE_KEY_PROVIDERS.flatMap((provider) =>
          keyInputTarget(this, context, provider),
        ),
      ],
      mutationRoots: [this],
      scrollRoots: [scrollport],
    };
  }

  scrollSurfaceScope({
    scopeId = "settings:voice",
    label = "Voice Input settings",
    clipRoots = [],
    isCurrent = () => true,
  }: ScrollSurfaceScopeOptions = {}): ScrollSurfaceScope {
    const scrollport = this.querySelector(":scope > .settings-content-scroll");
    if (this.hidden || !scrollport) {
      return emptyScrollSurfaceScope();
    }
    return {
      blocked: false,
      surfaces: [
        {
          id: `${scopeId}:scroll`,
          label,
          scrollport,
          clipRoots: [this, scrollport, ...clipRoots].filter(Boolean),
          isEligible: () =>
            this.isConnected &&
            !this.hidden &&
            isCurrent() &&
            this.querySelector(":scope > .settings-content-scroll") ===
              scrollport &&
            hasScrollLayoutBox(this) &&
            hasScrollLayoutBox(scrollport),
        },
      ],
      mutationRoots: [this],
      resizeElements: [this, scrollport],
      scrollRoots: [scrollport],
    };
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
              id=${`settings-voice-${provider}-key`}
              name="key"
              type="password"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              placeholder=${placeholder}
              ?disabled=${locked}
            >
            <button type="submit" ?disabled=${locked}>Save key</button>
            <button
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
    const input = form.querySelector<HTMLInputElement>('input[name="key"]');
    if (!input) return;
    const provider = form.dataset.keyProvider ?? "";
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

function providerChoiceTarget(
  owner: HTMLElement,
  context: ScopeContext,
  choice: (typeof PROVIDER_CHOICES)[number],
) {
  const selector = `input[type="radio"][name="voice-provider"][value="${choice.id}"]`;
  const control = owner.querySelector<HTMLInputElement>(selector);
  if (!control || !controlAvailable(control) || control.checked) {
    return [];
  }
  return [
    radioActionHintTarget({
      invalidationOwner: owner,
      id: `${context.scopeId}:provider:${choice.id}`,
      actionId: ACTION_HINT_ACTION.CONTROL_RADIO_SELECT,
      label: `Use ${choice.label} for voice input`,
      control,
      anchor: control.closest?.("label") ?? control,
      clipRoots: context.clipRoots,
      isActionable: () =>
        ownerIsCurrent(owner, context) &&
        owner.querySelector(selector) === control &&
        controlAvailable(control) &&
        !control.checked,
    }),
  ];
}

function actionButtonTarget(
  owner: HTMLElement,
  context: ScopeContext,
  { id, selector, label }: { id: string; selector: string; label: string },
) {
  const control = owner.querySelector<HTMLButtonElement>(selector);
  if (!control || !controlAvailable(control)) {
    return [];
  }
  return [
    buttonActionHintTarget({
      invalidationOwner: owner,
      id: `${context.scopeId}:${id}`,
      actionId: ACTION_HINT_ACTION.BUTTON_ACTIVATE,
      label,
      control,
      clipRoots: context.clipRoots,
      isActionable: () =>
        ownerIsCurrent(owner, context) &&
        owner.querySelector(selector) === control &&
        controlAvailable(control),
    }),
  ];
}

function keyInputTarget(
  owner: HTMLElement,
  context: ScopeContext,
  provider: VoiceKeyProvider,
) {
  const selector = `form[data-key-provider="${provider}"] input[name="key"]`;
  const control = owner.querySelector<HTMLInputElement>(selector);
  if (!control || !controlAvailable(control)) {
    return [];
  }
  return [
    textboxActionHintTarget({
      invalidationOwner: owner,
      id: `${context.scopeId}:key:${provider}`,
      actionId: ACTION_HINT_ACTION.CONTROL_TEXTBOX_FOCUS,
      label: `Focus ${KEY_PROVIDER_NAMES[provider]} API key`,
      control,
      clipRoots: context.clipRoots,
      isActionable: () =>
        ownerIsCurrent(owner, context) &&
        owner.querySelector(selector) === control &&
        controlAvailable(control),
    }),
  ];
}

function ownerIsCurrent(owner: HTMLElement, { isCurrent }: ScopeContext) {
  return owner.isConnected && !owner.hidden && isCurrent();
}

function controlAvailable(control: HTMLInputElement | HTMLButtonElement) {
  return (
    !control.disabled && !control.hidden && hasActionHintLayoutBox(control)
  );
}

customElements.define("caffold-settings-voice-page", CaffoldSettingsVoicePage);
